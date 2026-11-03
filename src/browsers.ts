import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { HttpError, replaceReadOnly, type Instance } from './store.ts';
import { logins, saveLogin, secret, use } from './logins.ts';
import { connections } from './connections.ts';

// Browsers from the browser service (spoj/rollforward-browser, a repo of its own), whose one client is this server, with its key: a
// throwaway container per session, driven over CDP, whose proxy keeps to a website's hosts and logs every request. A website login is
// the browser state a session hands back when it closes: people sign in themselves, in the live view shown on the Logins page, and a
// run's browser starts from its runner's login and hands it back refreshed. The service may be on a host of its own, at an https
// address (or over a private link): runs and people reach it only through this server.

const base = process.env.RF_BROWSER_URL ?? 'http://127.0.0.1:8797', u = new URL(base), tls = u.protocol === 'https:';
const key = () => ({ authorization: `Bearer ${process.env.RF_BROWSER_KEY}` });

function call(method: string, path: string, body?: unknown): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const req = (tls ? httpsRequest : httpRequest)(base + path, { method, headers: key() }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c)).on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode! < 300) return ok(data);
        // The service answers {error}; a proxy in front of it, such as one that ends TLS, may answer anything, and a throw here would
        // be outside the promise, ending the server.
        let why;
        try { why = JSON.parse(data.toString()).error; } catch { why = `${res.statusCode} ${data.toString().slice(0, 200)}`; }
        fail(new HttpError(502, `browser service: ${why}`));
      });
    });
    req.on('error', e => fail(new HttpError(502, `the browser service at ${base} does not answer: ${e.message}`)));
    req.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}
const json = async (method: string, path: string, body?: unknown) => JSON.parse((await call(method, path, body)).toString());
// A file in a session's browser, its parts encoded and none . or .., which would lead out of the session to the service's other calls.
export function files(id: string, path: string) {
  const parts = path.replace(/\\/g, '/').replace(/^\//, '').split('/');
  if (parts.some(p => p === '.' || p === '..')) throw new HttpError(400, `${path}: a path without . or .. in it`);
  return `/sessions/${id}/files/${parts.map(encodeURIComponent).join('/')}`;
}

const open = async (w: Website, ttl_s: number, state?: unknown): Promise<string> =>
  (await json('POST', '/sessions', { site: { hosts: [new URL(w.url).hostname, ...w.hosts], start_url: w.url }, state, ttl_s })).id;
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

// ---- Websites, which admins keep as connections of type website (connections.ts): each a name, the address where people sign
// in, and the other hosts its pages need, such as single sign-on's. A browser on one reaches only those hosts; whatever its login
// may do there, the browser may, so keeping to reads is the agent's, and its request log shows what it did.

export type Website = { name: string; url: string; hosts: string[]; writeback: boolean };
export const websites = (): Record<string, Website> =>
  Object.fromEntries(connections().filter(c => c.type === 'website').map(c => [c.name, { name: c.title ?? c.name, url: c.url, hosts: c.hosts, writeback: c.writeback }]));

function website(id: string): Website {
  const w = websites()[id];
  if (!w) throw new HttpError(404, `no website ${id}; there are ${Object.keys(websites()).join(', ') || 'none'}: an admin adds one with rf connection set ${id} website`);
  return w;
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

// ---- A run's browsers, which close when it ends: one per website, from its runner's login if ticked for the instance. Closing one
// seals its login again, refreshed, unless its person signed out or signed in to it anew meanwhile, and keeps its request log in the
// instance's browser/,
// which the agent can read but not change, beside the screenshots taken after each of the agent's tool calls.
export class Browsers {
  inst: Instance;
  run: number;
  bySite = new Map<string, { id: string; email: string; since: string; shot?: Buffer }>();
  shots = 0;
  constructor(inst: Instance, run: number) {
    this.inst = inst;
    this.run = run;
  }

  // The login a browser on a website may use now, and the run's browser there if open: checked at every call and every new
  // connection, so a login its runner can no longer lend stops at the next one; a connection already open lasts until the run ends.
  private lent(site: string) {
    const { email, login } = use(this.inst, `web:${site}`), had = this.bySite.get(site);
    if (login.expired) throw Object.assign(new HttpError(409, `${email}'s login to ${login.name} has expired: they sign in to it again on the Logins page, and the instance carries on`), { login: login.id });
    if (had && had.email !== email) throw new HttpError(409, `this run's browser on ${site} is in ${had.email}'s login, and ${email} has taken the instance over: the next run opens one in theirs`);
    return { email, login, had };
  }

  async browser(site: string): Promise<string> {
    const { email, login, had } = this.lent(site);
    if (had) return had.id;
    const id = await open(website(site), 7200, JSON.parse(secret(email, login.id)));
    this.bySite.set(site, { id, email, since: login.since });
    return id;
  }

  // Whether `id` is one of this run's browsers; a 403 or 409 if its login may no longer be used.
  owns(id: string): boolean {
    const site = [...this.bySite].find(([, b]) => b.id === id)?.[0];
    if (site) this.lent(site);
    return !!site;
  }

  // The agent found the website signed out: the runner's login is marked expired, for them to sign in again, which wakes the instance,
  // and its browser closes.
  async expire(site: string): Promise<never> {
    const { email, login } = use(this.inst, `web:${site}`);
    saveLogin(email, { ...login, expired: true });
    await this.close(site);
    throw Object.assign(new HttpError(409, `${email}'s login to ${login.name} has expired: they sign in to it again on the Logins page, and the instance carries on`), { login: login.id });
  }

  async browserFile(site: string, path: string): Promise<Buffer> {
    if (!this.bySite.has(site)) throw new HttpError(409, `no browser on ${site} in this run: rf browser open ${site} first`);
    return call('GET', files(await this.browser(site), path));
  }

  // A screenshot of each browser's newest tab, unless it looks as it did at the last, logged as shot for the Ops log.
  async shoot() {
    await Promise.all([...this.bySite].map(async ([site, b]) => {
      const png = await call('GET', `/sessions/${b.id}/screenshot`);
      if (b.shot?.equals(png)) return;
      b.shot = png;
      const file = `browser/run ${this.run} ${site} ${++this.shots}.png`;
      mkdirSync(join(this.inst.dir, 'browser'), { recursive: true });
      replaceReadOnly(join(this.inst.dir, file), png);
      this.inst.append('server', 'shot', { run: this.run, site, file });
    }));
  }

  // The run's browsers, or the one on `only`, close: each hands its login back refreshed, unless it expired or its person signed in to
  // it anew since the browser opened, which a stale state would overwrite, and leaves its request log.
  async close(only?: string) {
    await Promise.all([...this.bySite].filter(([site]) => !only || site === only).map(async ([site, { id, email, since }]) => {
      this.bySite.delete(site);
      const { state, log } = await close(id), login = logins(email).find(l => l.id === `web:${site}`), file = `browser/run ${this.run} ${site}.jsonl`;
      if (state && login && !login.expired && login.since === since) saveLogin(email, login, JSON.stringify(state));
      mkdirSync(join(this.inst.dir, 'browser'), { recursive: true });
      replaceReadOnly(join(this.inst.dir, file), log.map(e => JSON.stringify(e) + '\n').join(''));
      const writes = log.filter(e => !e.blocked && !['GET', 'HEAD', 'OPTIONS'].includes(e.method)).length;
      this.inst.append('server', 'browser', { run: this.run, site, login: email, requests: log.length, writes, blocked: log.filter(e => e.blocked).length, file });
    }));
  }
}
