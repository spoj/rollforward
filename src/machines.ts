import { connect } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HttpError, replaceReadOnly, type Instance } from './store.ts';
import { logins, saveLogin, secret, use } from './logins.ts';
import { siteOf, skill } from './skills.ts';

// Browsers from the machines service (a repo of its own): a throwaway container per session, driven over CDP, whose proxy keeps to
// the site's hosts, blocks writes but while a person drives its live view, and logs every request. This server is its one client,
// with its key. A website login is the browser state a session hands back when it closes: people sign in themselves, in the live
// view shown on the Logins page, and a run's browser starts from its runner's login and hands it back refreshed.

const base = process.env.RF_MACHINES_URL ?? 'http://127.0.0.1:8797';
const key = () => ({ authorization: `Bearer ${process.env.RF_MACHINES_KEY}` });

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(base + path, { method, headers: key(), body: body === undefined ? undefined : JSON.stringify(body) })
    .catch(e => { throw new HttpError(502, `the machines service at ${base} does not answer: ${e.message}`); });
  if (!res.ok) throw new HttpError(502, `machines: ${(await res.json()).error}`);
  return res;
}

const open = async (site: string, ttl_s: number, state?: unknown): Promise<string> =>
  (await (await call('POST', '/sessions', { kind: 'browser', site: siteOf(site), state, ttl_s })).json()).id;
const close = async (id: string): Promise<{ state: unknown; log: { blocked?: string }[] }> => (await call('DELETE', `/sessions/${id}`)).json();

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
  return (await call('GET', `/sessions/${id}/view`)).text();
}

// Ends a sign-in; with `save`, what the browser holds becomes the person's login to the site, replacing any before.
export async function endSignIn(email: string, id: string, save: boolean) {
  if (!isSignIn(email, id)) throw new HttpError(404, 'no such sign-in');
  const { site } = signIns.get(id)!, { state } = await close(id), name = skill(site)!.name;
  signIns.delete(id);
  if (save) saveLogin(email, { id: `web:${site}`, kind: 'website', name, since: new Date().toISOString(), offers: [{ id: `web:${site}`, name }] }, JSON.stringify(state));
}

// ---- A run's browsers: one per site, from its runner's login if ticked for the instance. When the run ends, each closes: its login
// is sealed again, refreshed, unless its person signed out meanwhile, and its request log is kept in the instance's browser/, which
// the agent can read but not change.
export class Browsers {
  inst: Instance;
  run: number;
  open = new Map<string, { id: string; email: string }>();
  constructor(inst: Instance, run: number) {
    this.inst = inst;
    this.run = run;
  }

  async session(site: string): Promise<string> {
    if (this.open.has(site)) return this.open.get(site)!.id;
    const { email, login } = use(this.inst, `web:${site}`);
    const id = await open(site, 7200, JSON.parse(secret(email, login.id)));
    this.open.set(site, { id, email });
    return id;
  }

  owns = (id: string) => [...this.open.values()].some(s => s.id === id);

  async file(site: string, path: string): Promise<Buffer> {
    if (!this.open.has(site)) throw new HttpError(409, `no browser on ${site} in this run: rf browser open ${site} first`);
    return Buffer.from(await (await call('GET', `/sessions/${this.open.get(site)!.id}/files/${path.replace(/^\//, '')}`)).arrayBuffer());
  }

  async close() {
    await Promise.all([...this.open].map(async ([site, { id, email }]) => {
      const { state, log } = await close(id), login = logins(email).find(l => l.id === `web:${site}`), file = `browser/run ${this.run} ${site}.jsonl`;
      if (state && login) saveLogin(email, login, JSON.stringify(state));
      mkdirSync(join(this.inst.dir, 'browser'), { recursive: true });
      replaceReadOnly(join(this.inst.dir, file), log.map(e => JSON.stringify(e) + '\n').join(''));
      this.inst.append('server', 'browser', { run: this.run, site, login: email, requests: log.length, blocked: log.filter(e => e.blocked).length, file });
    }));
    this.open.clear();
  }
}
