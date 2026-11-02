import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { HttpError, replaceReadOnly, type Instance } from './store.ts';
import { logins, saveLogin, secret, use } from './logins.ts';
import { readJson, writeJson } from './system.ts';

// Machines from the machines service (a repo of its own), whose one client is this server, with its key:
// - browsers: a throwaway container per session, driven over CDP, whose proxy keeps to a website's hosts and logs every request.
//   A website login is the browser state a session hands back when it closes: people sign in themselves, in the live view shown on
//   the Logins page, and a run's browser starts from its runner's login and hands it back refreshed;
// - Windows: a virtual machine with no network, cloned from a clean, signed-in state, that runs scripts and takes files.
// Calls use node:http(s), as fetch gives up on an answer after 5 minutes and a Windows script may run longer. The service may be on
// a host of its own, at an https address (or over a private link): runs and people reach it only through this server.

const base = process.env.RF_MACHINES_URL ?? 'http://127.0.0.1:8797', u = new URL(base), tls = u.protocol === 'https:';
const key = () => ({ authorization: `Bearer ${process.env.RF_MACHINES_KEY}` });

function call(method: string, path: string, body?: unknown): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const req = (tls ? httpsRequest : httpRequest)(base + path, { method, headers: key() }, res => {
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
// A file on a session's machine, its parts encoded and none . or .., which would lead out of the session to the service's other calls.
function files(id: string, path: string) {
  const parts = path.replace(/\\/g, '/').replace(/^\//, '').split('/');
  if (parts.some(p => p === '.' || p === '..')) throw new HttpError(400, `${path}: a path without . or .. in it`);
  return `/sessions/${id}/files/${parts.map(encodeURIComponent).join('/')}`;
}

const open = async (w: Website, ttl_s: number, state?: unknown): Promise<string> =>
  (await json('POST', '/sessions', { kind: 'browser', site: { hosts: [new URL(w.url).hostname, ...w.hosts], start_url: w.url }, state, ttl_s })).id;
const close = (id: string): Promise<{ state: unknown; log: { method: string; blocked?: string }[] }> => json('DELETE', `/sessions/${id}`);

// A websocket passed through to the service's `path`, with the key added.
export function passUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string) {
  const port = Number(u.port || (tls ? 443 : 80));
  const up = tls ? tlsConnect({ host: u.hostname, port, servername: isIP(u.hostname) ? undefined : u.hostname }) : connect(port, u.hostname);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  const headers: Record<string, unknown> = { ...req.headers, host: u.host, ...key() };
  delete headers.cookie;
  up.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
  up.write(head);
  socket.pipe(up).pipe(socket);
}

// ---- Websites, which admins keep with rf website set: each a name, the address where people sign in, and the other hosts its pages
// need, such as single sign-on's. A browser on one reaches only those hosts; whatever its login may do there, the browser may, so
// keeping to reads is the agent's, and its request log shows what it did.

export type Website = { name: string; url: string; hosts: string[]; updated_by: string; updated_at: string };
export const websites = () => readJson<Record<string, Website>>('websites.json', {});

function website(id: string): Website {
  const w = websites()[id];
  if (!w) throw new HttpError(404, `no website ${id}; there are ${Object.keys(websites()).join(', ') || 'none'}: an admin adds one with rf website set`);
  return w;
}

export function setWebsite(id: string, input: { name?: unknown; url?: unknown; hosts?: unknown }, by: string): Website {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new HttpError(400, 'a website id is lowercase letters, digits and dashes');
  if (typeof input.url !== 'string' || !/^https?:\/\/[^/]/.test(input.url)) throw new HttpError(400, 'url: an http(s) address, where sign-in starts');
  const hosts = input.hosts ?? [];
  if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(h))) throw new HttpError(400, 'hosts: names such as sso.example.com, or *.example.com for any under it');
  const all = websites();
  all[id] = { name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id, url: input.url, hosts, updated_by: by, updated_at: new Date().toISOString() };
  writeJson('websites.json', all);
  return all[id];
}

// People's logins to a website removed stay theirs to sign out of; no run can use them.
export function removeWebsite(id: string) {
  const all = websites();
  if (!all[id]) throw new HttpError(404, `no website ${id}`);
  delete all[id];
  writeJson('websites.json', all);
}

// ---- Signing in: a browser on the website's address with nothing saved, shown to the person on the Logins page, for half an hour.

const signIns = new Map<string, { email: string; site: string; name: string }>();

export async function startSignIn(email: string, site: string): Promise<string> {
  const w = website(site), id = await open(w, 1800);
  signIns.set(id, { email, site, name: w.name });
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
  const { site, name } = signIns.get(id)!, { state } = await close(id);
  signIns.delete(id);
  if (save) saveLogin(email, { id: `web:${site}`, kind: 'website', name, since: new Date().toISOString(), offers: [{ id: `web:${site}`, name }] }, JSON.stringify(state));
}

// ---- A run's machines, which close when it ends.
// Browsers: one per website, from its runner's login if ticked for the instance. Closing one seals its login again, refreshed, unless
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

  // Checked at every call, so a login its runner can no longer lend stops at the next one; a connection already open lasts until
  // the run ends.
  async browser(site: string): Promise<string> {
    const { email, login } = use(this.inst, `web:${site}`), had = this.browsers.get(site);
    if (had && had.email !== email) throw new HttpError(409, `this run's browser on ${site} is in ${had.email}'s login, and ${email} has taken the instance over: the next run opens one in theirs`);
    if (had) return had.id;
    const id = await open(website(site), 7200, JSON.parse(secret(email, login.id)));
    this.browsers.set(site, { id, email });
    return id;
  }

  owns = (id: string) => [...this.browsers.values()].some(s => s.id === id);

  async browserFile(site: string, path: string): Promise<Buffer> {
    if (!this.browsers.has(site)) throw new HttpError(409, `no browser on ${site} in this run: rf browser open ${site} first`);
    return call('GET', files(await this.browser(site), path));
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
      const writes = log.filter(e => !e.blocked && !['GET', 'HEAD', 'OPTIONS'].includes(e.method)).length;
      this.inst.append('server', 'browser', { run: this.run, site, login: email, requests: log.length, writes, blocked: log.filter(e => e.blocked).length, file });
    })]);
    this.browsers.clear();
  }
}
