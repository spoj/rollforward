import { connect } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { request, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HttpError, replaceReadOnly, type Instance } from './store.ts';
import { logins, saveLogin, secret, use } from './logins.ts';
import { siteOf, skill } from './skills.ts';

// Machines from the machines service (a repo of its own), whose one client is this server, with its key:
// - browsers: a throwaway container per session, driven over CDP, whose proxy keeps to the site's hosts, blocks writes but while a
//   person drives its live view, and logs every request. A website login is the browser state a session hands back when it closes:
//   people sign in themselves, in the live view shown on the Logins page, and a run's browser starts from its runner's login and
//   hands it back refreshed;
// - Windows: a virtual machine with no network, cloned from a clean, signed-in state, that runs scripts and takes files.
// Calls use node:http, as fetch gives up on an answer after 5 minutes and a Windows script may run longer.

const base = process.env.RF_MACHINES_URL ?? 'http://127.0.0.1:8797';
const key = () => ({ authorization: `Bearer ${process.env.RF_MACHINES_KEY}` });

function call(method: string, path: string, body?: unknown): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const req = request(base + path, { method, headers: key() }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c)).on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode! < 300) ok(data);
        else fail(new HttpError(502, `machines: ${JSON.parse(data.toString()).error}`));
      });
    });
    req.on('error', e => fail(new HttpError(502, `the machines service at ${base} does not answer: ${e.message}`)));
    req.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}
const json = async (method: string, path: string, body?: unknown) => JSON.parse((await call(method, path, body)).toString());
const files = (id: string, path: string) => `/sessions/${id}/files/${path.replace(/\\/g, '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/')}`;

const open = async (site: string, ttl_s: number, state?: unknown): Promise<string> => (await json('POST', '/sessions', { kind: 'browser', site: siteOf(site), state, ttl_s })).id;
const close = (id: string): Promise<{ state: unknown; log: { blocked?: string }[] }> => json('DELETE', `/sessions/${id}`);

// A websocket passed through to the service's `path`, with the key added.
export function passUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string) {
  const u = new URL(base), up = connect(Number(u.port), u.hostname);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  const headers: Record<string, unknown> = { ...req.headers, host: u.host, ...key() };
  delete headers.cookie;
  up.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
  up.write(head);
  socket.pipe(up).pipe(socket);
}

// ---- Signing in: a browser on the site's address with nothing saved, shown to the person on the Logins page, for half an hour.

const signIns = new Map<string, { email: string; site: string }>();

export async function startSignIn(email: string, site: string): Promise<string> {
  const id = await open(site, 1800);
  signIns.set(id, { email, site });
  return id;
}

export const isSignIn = (email: string, id: string) => signIns.get(id)?.email === email;

export async function viewPage(email: string, id: string): Promise<string> {
  if (!isSignIn(email, id)) throw new HttpError(404, 'no such sign-in');
  return (await call('GET', `/sessions/${id}/view`)).toString();
}

// Ends a sign-in; with `save`, what the browser holds becomes the person's login to the site, replacing any before. Signing in
// takes requests the person makes in control of the browser, so with none there is nothing to save yet.
export async function endSignIn(email: string, id: string, save: boolean) {
  if (!isSignIn(email, id)) throw new HttpError(404, 'no such sign-in');
  if (save && !(await json('GET', `/sessions/${id}/log`)).some((e: { live?: true }) => e.live)) throw new HttpError(409, 'Take control and sign in first, then Save login.');
  const { site } = signIns.get(id)!, { state } = await close(id), name = skill(site)!.name;
  signIns.delete(id);
  if (save) saveLogin(email, { id: `web:${site}`, kind: 'website', name, since: new Date().toISOString(), offers: [{ id: `web:${site}`, name }] }, JSON.stringify(state));
}

// ---- A run's machines, which close when it ends.
// Browsers: one per site, from its runner's login if ticked for the instance. Closing one seals its login again, refreshed, unless
// its person signed out meanwhile, and keeps its request log in the instance's browser/, which the agent can read but not change.
// Windows: one machine, opened by the run's first rf windows; closing it puts it back to its clean state.
export class Machines {
  inst: Instance;
  run: number;
  browsers = new Map<string, { id: string; email: string }>();
  windows?: string;
  constructor(inst: Instance, run: number) {
    this.inst = inst;
    this.run = run;
  }

  async browser(site: string): Promise<string> {
    if (this.browsers.has(site)) return this.browsers.get(site)!.id;
    const { email, login } = use(this.inst, `web:${site}`);
    const id = await open(site, 7200, JSON.parse(secret(email, login.id)));
    this.browsers.set(site, { id, email });
    return id;
  }

  owns = (id: string) => [...this.browsers.values()].some(s => s.id === id);

  browserFile(site: string, path: string): Promise<Buffer> {
    if (!this.browsers.has(site)) throw new HttpError(409, `no browser on ${site} in this run: rf browser open ${site} first`);
    return call('GET', files(this.browsers.get(site)!.id, path));
  }

  async windowsId(): Promise<string> {
    this.windows ??= (await json('POST', '/sessions', { kind: 'windows', ttl_s: 7200 })).id;
    return this.windows!;
  }

  async windowsRun(lang: string, script: string, timeout_s: number): Promise<{ exit: number | null; stdout: string; stderr: string; timed_out?: true }> {
    return json('POST', `/sessions/${await this.windowsId()}/run`, { lang, script, timeout_s });
  }

  windowsPut = async (path: string, data: Buffer) => void await call('PUT', files(await this.windowsId(), path), data);
  windowsGet = async (path: string) => call('GET', files(await this.windowsId(), path));
  windowsScreenshot = async () => call('GET', `/sessions/${await this.windowsId()}/screenshot`);

  async closeWindows() {
    if (this.windows) await call('DELETE', `/sessions/${this.windows}`);
    this.windows = undefined;
  }

  async close() {
    const windows = this.windows && this.closeWindows().then(() => void this.inst.append('server', 'windows', { run: this.run, action: 'close' }));
    await Promise.all([windows, ...[...this.browsers].map(async ([site, { id, email }]) => {
      const { state, log } = await close(id), login = logins(email).find(l => l.id === `web:${site}`), file = `browser/run ${this.run} ${site}.jsonl`;
      if (state && login) saveLogin(email, login, JSON.stringify(state));
      mkdirSync(join(this.inst.dir, 'browser'), { recursive: true });
      replaceReadOnly(join(this.inst.dir, file), log.map(e => JSON.stringify(e) + '\n').join(''));
      this.inst.append('server', 'browser', { run: this.run, site, login: email, requests: log.length, blocked: log.filter(e => e.blocked).length, file });
    })]);
    this.browsers.clear();
  }
}
