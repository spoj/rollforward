import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, instance, instances, isPerson, replaceReadOnly, type Instance } from './store.ts';
import { lender, logins, personDir, runnerOf, saveLogin, seal, secret, use } from './logins.ts';
import { getDomain } from 'tldts';
import { changeConnection, checkHost, connections, covers, reached, setConnection } from './connections.ts';
import { users } from './auth.ts';
import { changes, readJson, rfDir, tree } from './system.ts';

// Browsers from the browser service (spoj/rollforward-browser, a repo of its own), whose one client is this server, with its key: a
// throwaway container per session, driven over CDP, whose proxy keeps to a website's hosts and logs every request. A website login is
// the browser state a session hands back when it closes: people sign in themselves, in the live view shown on the Logins page, and a
// run's browser starts from its runner's login and hands it back refreshed. The service may be on a host of its own, at an https
// address (or over a private link): runs and people reach it only through this server.

const base = process.env.RF_BROWSER_URL ?? 'http://127.0.0.1:8797', u = new URL(base), tls = u.protocol === 'https:';
const key = () => ({ authorization: `Bearer ${process.env.RF_BROWSER_KEY}` });

// The service's answer, as it streams; a refusal is a 502.
function request(method: string, path: string, body?: unknown): Promise<IncomingMessage> {
  return new Promise((ok, fail) => {
    const req = (tls ? httpsRequest : httpRequest)(base + path, { method, headers: key() }, res => {
      if (res.statusCode! < 300) return ok(res);
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c)).on('end', () => {
        const data = Buffer.concat(chunks);
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
const call = async (method: string, path: string, body?: unknown) => Buffer.concat(await Array.fromAsync(await request(method, path, body)));
const json = async (method: string, path: string, body?: unknown) => JSON.parse((await call(method, path, body)).toString());
// A file in a session's browser, its parts encoded and none . or .., which would lead out of the session to the service's other calls.
export function files(id: string, path: string) {
  const parts = path.replace(/\\/g, '/').replace(/^\//, '').split('/');
  if (parts.some(p => p === '.' || p === '..')) throw new HttpError(400, `${path}: a path without . or .. in it`);
  return `/sessions/${id}/files/${parts.map(encodeURIComponent).join('/')}`;
}

const open = async (w: Website, ttl_s: number, state?: unknown, headers?: Record<string, string>): Promise<string> =>
  (await json('POST', '/sessions', { site: { hosts: [new URL(w.url).hostname, ...w.hosts], start_url: w.url, headers, ...(w.owner && { public: true }) }, state, ttl_s })).id;
const close = (id: string): Promise<{ state: unknown; log: { method: string; url: string; status: number; blocked?: string; error?: string }[] }> => json('DELETE', `/sessions/${id}`);

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

export type Website = { name: string; url: string; hosts: string[]; writeback: boolean; header?: string; keepalive?: string; every?: number; hours?: string; people?: string[]; owner?: string; off?: boolean };
export const websites = (): Record<string, Website> => Object.fromEntries(connections().filter(c => c.type === 'website').map(c => [c.name, {
  name: c.title ?? c.name, url: c.url, hosts: c.hosts, writeback: c.writeback, header: c.header, keepalive: c.keepalive, every: c.every, hours: c.hours, people: c.people,
  ...(c.owner && { owner: c.owner }), ...(c.off && { off: true }),
}]));

// A website that lists its people lets only them use it, by email or Entra group, admins no more than anyone: only they see it on
// Logins and sign in to it, and a run gets its browser only if its runner and everyone who took part in its instance, or woke it,
// are among them. Such a website is never lent through a shared series. A website an admin switched off, no one uses.
export const allowed = (w: Website, email: string) => !w.off && (!w.people || w.people.includes(email) || (users()[email]?.groups ?? []).some(g => w.people!.includes(g)));
export const scoped = (offer: string) => offer.startsWith('web:') && !!websites()[offer.slice(4)]?.people;

function website(id: string): Website {
  const w = websites()[id];
  if (!w) throw new HttpError(404, `no website ${id}; there are ${Object.keys(websites()).join(', ') || 'none'}: an admin adds one with rf connection set ${id} website`);
  return w;
}

// ---- Signing in: a browser on the website's address with nothing saved, shown to the person on the Logins page, for half an hour.
// A website that names a header, such as Retail Link's x-bot-token, which its sign-in needs and its pages never send, has the
// person's token for it on that browser's requests to its address, put there by the browser service, so the browser never holds
// it. It is sealed with their login as they save it, and used again when they sign in again without a new one; never sent for a
// run's browser.

const signIns = new Map<string, { email: string; site: string; name: string; token?: string; since: number }>();

export async function startSignIn(email: string, site: string, given: string): Promise<string> {
  const w = website(site), kept = `web:${site}.header`;
  if (!allowed(w, email)) throw new HttpError(403, `${w.name} is only for the people its connection lists`);
  let token;
  if (w.header) {
    token = given.trim() || (existsSync(join(personDir(email), `${kept}.sealed`)) ? secret(email, kept) : '');
    if (!token) throw new HttpError(400, `${w.name} needs your ${w.header} to sign in: give it in the box under its name, on the Logins page`);
    if (/[^\x20-\x7e]/.test(token)) throw new HttpError(400, `${w.header}: letters, digits and punctuation`);
  }
  const id = await open(w, 1800, undefined, token && { [w.header!]: token });
  signIns.set(id, { email, site, name: w.name, token, since: Date.now() });
  return id;
}

export const isSignIn = (email: string, id: string) => signIns.get(id)?.email === email;

// A person's own website, for those granted sites: its name and the https address where its sign-in starts, the other hosts its pages
// need allowed as they sign in to it.
export async function addSite(email: string, name: string, url: string) {
  if (!/^https:\/\/[^/]/.test(url)) throw new HttpError(400, 'url: an https address, where its sign-in starts');
  if (connections().some(c => c.name === name)) throw new HttpError(409, `${name} is taken: name yours otherwise`);
  await setConnection(name, { type: 'website', url, people: [email], owner: email }, email);
}

// A website's hosts are its person's to allow if it's their own, and otherwise admins'.
const allows = (w: Website, by: { email: string; role: string }) => (w.owner ? w.owner === by.email : by.role === 'admin');

// The hosts a person's sign-in to a website was refused and still is, each with its count, and *.D where two or more of them are
// under one registrable domain D; and whether they may allow them.
export async function refusedHosts(by: { email: string; role: string }, site: string) {
  const w = website(site), id = [...signIns].find(([, s]) => s.email === by.email && s.site === site)?.[0], reach = reached(w);
  if (!id) throw new HttpError(404, `no sign-in of yours to ${site} is open`);
  const n = new Map<string, number>();
  for (const e of await json('GET', `/sessions/${id}/log`) as { url: string; blocked?: string }[]) {
    const host = e.blocked === 'host not on the list' && URL.parse(e.url)!.hostname;
    if (host && !reach.some(p => covers(p, host))) n.set(host, (n.get(host) ?? 0) + 1);
  }
  const under = Map.groupBy(n.keys(), h => getDomain(h, { allowPrivateDomains: true }) ?? h);
  return {
    allows: allows(w, by),
    hosts: [...[...under].filter(([d, hs]) => hs.length > 1 && hs.some(h => h !== d)).map(([d, hs]) => ({ host: `*.${d}`, count: hs.reduce((t, h) => t + n.get(h)!, 0) })),
      ...[...n].map(([host, count]) => ({ host, count }))].sort((a, b) => b.count - a.count),
  };
}

// A host a website's pages need, allowed by its person if it's their own and otherwise by an admin; their open sign-in to it, if any,
// reaches it at once.
export async function allowHost(by: { email: string; role: string }, site: string, host: string) {
  const w = website(site), h = host.trim().toLowerCase();
  if (!allows(w, by)) throw new HttpError(403, `${w.name}'s hosts are ${w.owner ? `${w.owner}'s` : "admins'"} to allow`);
  await checkHost(site, h, !!w.owner);
  changeConnection(site, { hosts: [...new Set([...w.hosts, h])] }, by.email);
  const id = [...signIns].find(([, s]) => s.email === by.email && s.site === site)?.[0];
  if (!id) return;
  await json('PUT', `/sessions/${id}/hosts`, { hosts: reached(website(site)) });
  await json('POST', `/sessions/${id}/reload`);
}

// The hosts a run's browser on a website was refused that it still doesn't reach.
export const unreached = (site: string, hosts: string[]) => hosts.filter(h => !reached(websites()[site]).some(p => covers(p, h)));

export const viewPage = async (id: string) => (await call('GET', `/sessions/${id}/view`)).toString();

// Ends a sign-in; with `save`, what the browser holds becomes the person's login to the site, replacing any before. Signing in
// takes requests the person makes in control of the browser, so with none there is nothing to save yet. What its browser did is
// one line of the server's output, its addresses as their hosts alone, as a path or a query may hold codes or tokens.
export async function endSignIn(email: string, id: string, save: boolean) {
  if (!isSignIn(email, id)) throw new HttpError(404, 'no such sign-in');
  if (save && !(await json('GET', `/sessions/${id}/log`)).some((e: { live?: true }) => e.live)) throw new HttpError(409, 'Take control and sign in first, then Save login.');
  const { site, name, token, since } = signIns.get(id)!, { state, log } = await close(id);
  signIns.delete(id);
  const requests: Record<string, Record<number, number>> = {}, blocked = { count: 0, hosts: [] as string[] }, failed: string[] = [];
  for (const e of log) {
    const host = URL.parse(e.url)?.host || 'an address that does not parse';
    if (e.blocked) {
      blocked.count++;
      if (!blocked.hosts.includes(host)) blocked.hosts.push(host);
    } else {
      (requests[host] ??= {})[e.status] = (requests[host][e.status] ?? 0) + 1;
      if (e.status >= 400) failed.push(`${e.method} ${host} ${e.status}${e.error ? ` ${e.error}` : ''}`);
    }
  }
  console.log(`sign-in ended ${JSON.stringify({ id, site, email, saved: save, seconds: Math.round((Date.now() - since) / 1000), requests, blocked, failed })}`);
  if (!save) return;
  saveLogin(email, { id: `web:${site}`, kind: 'website', name, since: new Date().toISOString(), offers: [{ id: `web:${site}`, name }] }, JSON.stringify(state));
  if (token) seal(email, `web:${site}.header`, token);
}

// ---- A run's browsers, at their fixed addresses, $RF_BROWSERS/NAME: one per website, opened from its runner's login, if ticked for
// the instance, at the first connection, and kept for the later ones until the run ends. Closing one keeps its request log in the
// instance's browser/, which the agent can read but not change, beside the screenshots taken after each of the agent's tool calls.
// Where a website writes a browser's state back, its default, a person has one browser there at a time: a run connecting while
// another holds it waits; the browser is released when its run ends, or after five minutes with no connection, and hands its login
// back refreshed, unless its person signed out or signed in to it anew meanwhile. Elsewhere each run's browser starts from the login
// as its person saved it, and nothing comes back.

// The run holding each person's browser on a website that writes its state back, by person and website, or none for a keepalive's
// turn, and its release.
const held = new Map<string, { run?: Browsers; released: Promise<void>; release(): void }>();
const IDLE_MS = Number(process.env.RF_BROWSER_IDLE_MS ?? 5 * 60_000);

// The runs' browsers open on the service, by id, in .rf/browsers.json, so those a restart cut from their runs still leave what
// their runs would have kept (reap).
type Opened = { inst: string; run: number; site: string; email: string; since: string; writeback: boolean; file: string };
const journal = () => readJson<Record<string, Opened>>('browsers.json', {});
const setJournal = (all: Record<string, Opened>) => replaceReadOnly(join(rfDir(), 'browsers.json'), JSON.stringify(all));

// A run's browser closed: its request log kept in its instance's browser/, logged as browser with the hosts its pages were refused, and,
// where its website writes it back, its state its person's login again, unless they signed out or in anew since it opened.
function keep(inst: Instance, b: Opened, { state, log }: { state: unknown; log: { method: string; url: string; blocked?: string }[] }) {
  const login = logins(b.email).find(l => l.id === `web:${b.site}`);
  if (b.writeback && state && login && !login.expired && login.since === b.since) saveLogin(b.email, login, JSON.stringify(state));
  mkdirSync(join(inst.dir, 'browser'), { recursive: true });
  replaceReadOnly(join(inst.dir, b.file), log.map(e => JSON.stringify(e) + '\n').join(''));
  const writes = log.filter(e => !e.blocked && !['GET', 'HEAD', 'OPTIONS'].includes(e.method)).length, hosts: Record<string, number> = {};
  for (const h of log.filter(e => e.blocked === 'host not on the list').map(e => URL.parse(e.url)!.hostname)) hosts[h] = (hosts[h] ?? 0) + 1;
  inst.append('server', 'browser', { run: b.run, site: b.site, login: b.email, requests: log.length, writes, blocked: log.filter(e => e.blocked).length, file: b.file,
    ...(Object.keys(hosts).length && { hosts }) });
}

// As the server starts, before any browser of its own opens: the browsers left open on the service, which this server alone uses,
// close, a run's kept as its run would have kept it, and any other, such as a sign-in's, gone.
export async function reap() {
  const left = journal();
  for (const { id } of await json('GET', '/sessions')) {
    try {
      const closed = await close(id);
      if (left[id]) keep(instance(left[id].inst), left[id], closed);
    } catch (e) {
      console.error(`the browser service: browser ${id}, left open by a restart, did not close cleanly`, e);
    }
  }
  const all = journal();
  for (const id in left) delete all[id];
  setJournal(all);
}

export class Browsers {
  inst: Instance;
  run: number;
  bySite = new Map<string, { id: string; email: string; since: string; writeback: boolean; file: string; conns: number; idle?: NodeJS.Timeout; shot?: Buffer }>();
  private opening = new Map<string, Promise<string>>();
  private opens = new Map<string, number>();
  private refused = new Set<string>();
  private ended = false;
  shots = 0;
  constructor(inst: Instance, run: number) {
    this.inst = inst;
    this.run = run;
  }

  // The login a browser on a website may use now, and the run's browser there if open: checked at every call and every new
  // connection, so a login its runner can no longer lend stops at the next one; a connection already open lasts until the run ends.
  // One its runner must sign in to again is logged, as the agent API logs it, so the instance carries on once they do.
  lent(site: string) {
    try {
      const { email, login } = use(this.inst, `web:${site}`), had = this.bySite.get(site), w = websites()[site];
      const out = w && [email, ...this.inst.log.map(e => isPerson(e) ? e.by : e.op === 'wake' ? String(e.from) : '')].find(p => p.includes('@') && !allowed(w, p));
      if (out) throw Object.assign(new HttpError(403, `${w.name} is only for the people its connection lists, and ${out}, ${out === email ? 'who runs this instance' : 'who took part in this instance'}, is not among them: this run goes on without it`), { refused: true });
      if (login.expired) throw Object.assign(new HttpError(409, `${email}'s login to ${login.name} has expired: they sign in to it again on the Logins page, and the instance carries on`), { login: login.id });
      if (had && had.email !== email) throw new HttpError(409, `this run's browser on ${site} is in ${had.email}'s login, and ${email} has taken the instance over: the next run opens one in theirs`);
      return { email, login, had };
    } catch (e) {
      const { login, refused } = e as { login?: string; refused?: true };
      if (login) this.inst.append('server', 'expired', { login, name: websites()[site]?.name ?? site, runner: runnerOf(this.inst).by });
      if (refused && !this.refused.has(site)) this.inst.append('server', 'browser', { run: this.run, site, action: 'refused', why: (e as Error).message });
      if (refused) this.refused.add(site);
      throw e;
    }
  }

  // The run's browser on a website, for a connection `conn`: undefined if that went away while it waited.
  async browser(site: string, conn?: Duplex): Promise<string | undefined> {
    for (let waited = false; ; waited = true) {
      if (this.ended) return undefined;
      const { email, login, had } = this.lent(site);
      if (had) return had.id;
      if (this.opening.has(site)) return this.opening.get(site);
      const w = website(site), writeback = w.writeback, key = `${email} ${site}`, other = writeback ? held.get(key) : undefined;
      if (other) {
        if (!waited) this.inst.append('server', 'browser', { run: this.run, site, login: email, action: 'wait', held: other.run ? `${tree().series[other.run.inst.seriesId]?.name}/${other.run.inst.label}` : 'keepalive' });
        await Promise.race([other.released, new Promise(ok => conn?.once('close', ok))]);
        if (conn?.destroyed) return undefined;
        continue;
      }
      if (writeback) {
        let release!: () => void;
        held.set(key, { run: this, released: new Promise<void>(ok => { release = ok; }), release: () => release() });
      }
      const opening = open(w, 7200, JSON.parse(secret(email, login.id)));
      this.opening.set(site, opening);
      try {
        const id = await opening, n = (this.opens.get(site) ?? 0) + 1, file = `browser/run ${this.run} ${site}${n > 1 ? ` ${n}` : ''}.jsonl`;
        const b = { id, email, since: login.since, writeback, file, conns: 0 };
        this.opens.set(site, n);
        this.bySite.set(site, b);
        changes.emit('change', this.inst.id); // for its instance's page to show it
        setJournal({ ...journal(), [id]: { inst: this.inst.id, run: this.run, site, email, since: login.since, writeback, file } });
        this.idle(site, b);
        return id;
      } catch (e) {
        if (writeback) this.release(key);
        throw e;
      } finally {
        this.opening.delete(site);
      }
    }
  }

  // A connection to the run's browser on `site`, which it holds while any is open.
  connected(site: string, conn: Duplex) {
    const b = this.bySite.get(site)!;
    b.conns++;
    clearTimeout(b.idle);
    conn.on('close', () => {
      if (!--b.conns && this.bySite.get(site) === b) this.idle(site, b);
    });
  }

  private idle(site: string, b: { writeback: boolean; idle?: NodeJS.Timeout }) {
    if (b.writeback) b.idle = setTimeout(() => this.close(site).catch(e => this.inst.append('server', 'browsers', { run: this.run, error: e.message })), IDLE_MS);
  }

  private release(key: string) {
    const h = held.get(key);
    if (h?.run !== this) return;
    held.delete(key);
    h.release();
  }

  // The run's open browsers that someone who sees its instance may watch, by website, with their sessions: on a website that lists
  // its people, only if they're among them.
  watchable(email: string): Map<string, string> {
    const all = websites();
    return new Map([...this.bySite].filter(([site]) => all[site] && allowed(all[site], email)).map(([site, b]) => [site, b.id]));
  }

  // The agent found the website signed out: the runner's login is marked expired, for them to sign in again, which wakes the instance,
  // and its browser closes.
  async expire(site: string): Promise<never> {
    const { email, login } = use(this.inst, `web:${site}`);
    saveLogin(email, { ...login, expired: true });
    await this.close(site);
    throw Object.assign(new HttpError(409, `${email}'s login to ${login.name} has expired: they sign in to it again on the Logins page, and the instance carries on`), { login: login.id });
  }

  // A file in the machine of the run's browser on `site`, such as a download where Playwright says it is, streamed, and logged as a
  // call to the website, as a refusal is.
  async download(site: string, path: string, res: ServerResponse) {
    let status = 200, bytes = 0, refused: string | undefined;
    try {
      const { had } = this.lent(site);
      if (!had) throw new HttpError(409, `no browser on ${site} in this run: connect to it at $RF_BROWSERS/${site} first`);
      const file = await request('GET', files(had.id, path));
      file.on('data', c => (bytes += c.length));
      res.writeHead(200, { 'content-type': file.headers['content-type'] ?? 'application/octet-stream' });
      await pipeline(file, res);
    } catch (e) {
      status = (e as HttpError).status ?? 500;
      if (status === 403) refused = (e as Error).message;
      throw e;
    } finally {
      this.inst.append('agent', 'call', { run: this.run, name: site, method: 'GET', path: `/downloads/${path}`, status, bytes, ...(refused && { refused }) });
    }
  }

  // The run ended: its browsers close, and a connection still waiting for its person's browser on a website gets none.
  end() {
    this.ended = true;
    return this.close();
  }

  // A screenshot of each browser's newest tab, unless it looks as it did at the last, logged as shot for the audit.
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

  // The run's browsers, or the one on `only`, close: each leaves its request log, and one that writes its state back hands its login
  // back refreshed, unless it expired or its person signed in to it anew since the browser opened, which a stale state would
  // overwrite, and lets the next run have its person's browser there.
  async close(only?: string) {
    await Promise.all([...this.bySite].filter(([site]) => !only || site === only).map(async ([site, { id, email, since, writeback, file, idle }]) => {
      this.bySite.delete(site);
      clearTimeout(idle);
      try {
        const closed = await close(id), all = journal();
        delete all[id];
        setJournal(all);
        keep(this.inst, { inst: this.inst.id, run: this.run, site, email, since, writeback, file }, closed);
      } finally {
        if (writeback) this.release(`${email} ${site}`);
      }
    }));
  }
}

// ---- Keeping logins alive: a website whose sessions end when left idle, as PatriArch's after 12 minutes, may name a page to load
// every so many minutes, in office hours if it names them: on weekdays, in the server's time zone. Each turn loads it in the browser
// of each person whose login there is live, who may use the website, and who runs an open instance with it ticked and may still run
// it, so its runs could use that login, unless a run of theirs holds that browser;
// where the website writes its state back, the turn holds it, so a run that connects meanwhile waits. The browser reaches only that
// page's host, so a sign-in elsewhere, as single sign-on would make one, never stretches a session past what the site allows: a page
// asking for a password, or one elsewhere, means the login expired, as rf expired says, and else the browser's state is the login.
const lastTurn = new Map<string, number>();

export async function keepAlive(now = new Date()) {
  const going = Object.keys(tree().series).flatMap(sid => instances(sid).filter(i => i.doc.status === 'open')).flatMap(i => {
    try {
      return [lender(i)];
    } catch {
      return [];
    }
  });
  for (const [site, w] of Object.entries(websites())) {
    const [from, to] = w.hours?.split('-') ?? [], at = now.toTimeString().slice(0, 5);
    if (!w.keepalive || now.getTime() - (lastTurn.get(site) ?? 0) < w.every! * 60_000 || (w.hours && (now.getDay() % 6 === 0 || at < from || at >= to))) continue;
    lastTurn.set(site, now.getTime());
    for (const email of new Set(going.filter(r => r.logins.includes(`web:${site}`)).map(r => r.by))) {
      const login = logins(email).find(l => l.id === `web:${site}`), key = `${email} ${site}`;
      if (!login || login.expired || !allowed(w, email) || held.has(key)) continue;
      let release!: () => void;
      if (w.writeback) held.set(key, { released: new Promise<void>(ok => { release = ok; }), release: () => release() });
      try {
        const page = new URL(w.keepalive, w.url), id = await open({ ...w, url: page.href, hosts: [] }, 300, JSON.parse(secret(email, login.id)));
        let shown: { url: string; password: boolean }, state: unknown;
        try {
          shown = await json('GET', `/sessions/${id}/page`);
        } finally {
          ({ state } = await close(id));
        }
        // Unless they signed in anew or out meanwhile.
        const after = logins(email).find(l => l.id === login.id);
        if (after?.since !== login.since || after.expired) continue;
        const over = shown.password || new URL(shown.url).origin !== page.origin;
        saveLogin(email, over ? { ...after, expired: true } : after, over ? undefined : JSON.stringify(state));
      } catch (e) {
        console.error(`keeping ${email}'s login to ${site} alive:`, e);
      } finally {
        if (w.writeback) {
          held.delete(key);
          release();
        }
      }
    }
  }
}

// A run's browsers at $RF_BROWSERS/NAME, its token's path: GET NAME/json/version, CDP's discovery, as Playwright's connect_over_cdp
// asks it; GET NAME/downloads/PATH, a file in that browser's machine; and the CDP websocket at NAME itself, passed to the service.
export async function serveBrowsers(b: Browsers, base: string, [site, what, ...path]: string[], req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET' && what === 'json' && path.join('/').replace(/\/$/, '') === 'version') {
    b.lent(site);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}${base}/${site}` }));
  }
  if (req.method === 'GET' && what === 'downloads') return b.download(site, path.map(decodeURIComponent).join('/'), res);
  throw new HttpError(404, `$RF_BROWSERS/${site} is the CDP address of this run's browser there; GET $RF_BROWSERS/${site}/downloads/PATH gives a file from it`);
}

export async function upgradeBrowser(b: Browsers, site: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
  try {
    const id = await b.browser(site, socket);
    if (!id || socket.destroyed) return;
    b.connected(site, socket);
    passUpgrade(req, socket, head, `/sessions/${id}/cdp`);
  } catch (e) {
    const status = (e as HttpError).status ?? 500;
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: text/plain\r\n\r\n${(e as Error).message}\n`);
  }
}
