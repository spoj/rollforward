import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, instance, replaceReadOnly, type Instance } from './store.ts';
import { logins, personDir, runnerOf, saveLogin, seal, secret, signOut, use } from './logins.ts';
import { getDomain } from 'tldts';
import { changeConnection, checkHost, connections, covers, reached, removeConnection, setConnection, upstreams } from './connections.ts';
import { model } from './connections/openrouter.ts';
import { asPerson, can, users, type Me } from './auth.ts';
import { approved, forget, grants } from './grants.ts';
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

// The runs' own print browser, at $RF_BROWSERS/print: no website, login or host, for a run to render what it has, such as a mail as
// HTML, and print it with page.pdf(); it reaches nothing, and closes with its last connection, for half an hour at most.
export const PRINT = 'print';
const printer = async () => (await json('POST', '/sessions', { site: { hosts: [], public: true }, ttl_s: 1800 })).id as string;

const open = async (w: Website, ttl_s: number, state?: unknown, headers?: Record<string, string>): Promise<string> =>
  (await json('POST', '/sessions', { site: { hosts: [new URL(w.url).hostname, ...w.hosts], start_url: w.url, headers, ...(!w.internal && { public: true }) }, state, ttl_s })).id;
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

// ---- Websites, connections of type website (connections.ts), which anyone adds: each a name, the address where people sign in,
// and the other hosts its pages need, such as single sign-on's. Everyone signs in to it in their own login, and a run uses that
// login only where its runner's grant in the instance's workspace is approved (grants.ts). A browser on one reaches only those
// hosts; whatever its login may do there, the browser may, so keeping to reads is the agent's, and its request log shows what it
// did. A website an admin switched off, no one uses.

export type Website = { name: string; url: string; hosts: string[]; writeback: boolean; header?: string; keepalive?: string; every?: number; owner?: string; internal?: boolean; off?: boolean; classes?: Record<string, 'tracker' | 'other'> };
export const websites = (): Record<string, Website> => Object.fromEntries(connections().filter(c => c.type === 'website').map(c => [c.name, {
  name: c.title ?? c.name, url: c.url, hosts: c.hosts, writeback: c.writeback, header: c.header, keepalive: c.keepalive, every: c.every,
  ...(c.owner && { owner: c.owner }), ...(c.internal && { internal: true }), ...(c.off && { off: true }), ...(c.classes && { classes: c.classes }),
}]));

function website(id: string): Website {
  const w = websites()[id];
  if (!w) throw new HttpError(404, `no website ${id}; there are ${Object.keys(websites()).join(', ') || 'none'}: anyone adds one with rf site add ${id} URL`);
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
  if (w.off) throw new HttpError(403, `${w.name} is switched off: an admin switches it on`);
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

// A website anyone adds: its name and the https address where its sign-in starts, the other hosts its pages need allowed as its
// owner, who added it, signs in to it. An address a website has already is that website, which they sign in to instead.
export async function addSite(email: string, name: string, url: string): Promise<{ site: string; existing?: true }> {
  if (!/^https:\/\/[^/]/.test(url)) throw new HttpError(400, 'url: an https address, where its sign-in starts');
  const same = Object.entries(websites()).find(([, w]) => new URL(w.url).hostname === new URL(url).hostname);
  if (same) return { site: same[0], existing: true };
  if (connections().some(c => c.name === name)) throw new HttpError(409, `${name} is taken: name yours otherwise`);
  await setConnection(name, { type: 'website', url, owner: email }, email);
  return { site: name };
}

// A website's settings and hosts are its owner's, and admins'.
const allows = (w: Website, by: { email: string; role: string }) => by.role === 'admin' || w.owner === by.email;

// Its owner or an admin changes its title, the header its sign-in needs, its keepalive page and how often, and whether runs write
// its state back; admins alone switch it off, or let it reach internal addresses.
export async function setSite(by: Me, name: string, change: Record<string, unknown>) {
  const w = website(name), c = connections().find(c => c.name === name)!, theirs = ['off', 'internal'].filter(k => change[k] !== undefined);
  const keys = ['title', 'header', 'keepalive', 'every', 'writeback', 'off', 'internal'], other = Object.keys(change).filter(k => !keys.includes(k));
  if (other.length) throw new HttpError(400, `${other.join(', ')}: a website's settings are ${keys.join(', ')}; its hosts are allowed one by one`);
  if (!allows(w, by)) throw new HttpError(403, `${w.name} is ${w.owner}'s to change, or an admin's`);
  if (theirs.length && by.role !== 'admin') throw new HttpError(403, `${theirs.join(' and ')}: admins set it`);
  await setConnection(name, { type: 'website', url: c.url, hosts: c.hosts, title: c.title, writeback: c.writeback, header: c.header, keepalive: c.keepalive,
    every: c.every && `${c.every}m`, owner: c.owner, off: c.off, internal: c.internal, classes: c.classes, ...change }, by.email);
}

// A website goes with its grants, and everyone's login to it: its owner's to remove while no one else has a grant to it pending or
// approved, and else an admin's.
export function removeSite(by: Me, name: string) {
  const w = website(name), others = Object.values(grants()).some(g => g.site === name && g.person !== by.email && ['pending', 'approved'].includes(g.state));
  if (by.role !== 'admin' && (w.owner !== by.email || others)) throw new HttpError(403, w.owner === by.email ? `others use ${w.name}: an admin removes it` : `${w.name} is ${w.owner}'s to remove, or an admin's`);
  removeConnection(name);
  forget(name);
  for (const email of Object.keys(users())) if (logins(email).some(l => l.id === `web:${name}`)) signOut(email, `web:${name}`);
}

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

// A host a website's pages need, allowed by its owner or an admin; their open sign-in to it, if any, reaches it at once. Once a grant
// to it is approved, its owner allows only hosts within the registrable domains it reaches already: one elsewhere would widen what
// the grant approved, which is admins' to do.
export async function allowHost(by: { email: string; role: string }, site: string, host: string) {
  const w = website(site), h = host.trim().toLowerCase(), domain = (x: string) => getDomain(x.replace(/^\*\./, ''), { allowPrivateDomains: true }) ?? x;
  if (!allows(w, by)) throw new HttpError(403, `${w.name}'s hosts are ${w.owner}'s to allow, or an admin's`);
  if (by.role !== 'admin' && approved(site) && !reached(w).some(p => domain(p) === domain(h))) throw new HttpError(403, `${h} is outside the domains ${w.name} reaches, which its grants approved: an admin allows it`);
  await checkHost(site, h, !!w.internal);
  changeConnection(site, { hosts: [...new Set([...w.hosts, h])] }, by.email);
  const id = [...signIns].find(([, s]) => s.email === by.email && s.site === site)?.[0];
  if (!id) return;
  await json('PUT', `/sessions/${id}/hosts`, { hosts: reached(website(site)) });
  await json('POST', `/sessions/${id}/reload`);
}

// The hosts a run's browser on a website was refused that it still doesn't reach.
// The hosts a website doesn't reach, of those asked for, but trackers the server sorted out (classify), which no one is asked to allow.
export const unreached = (site: string, hosts: string[]) => hosts.filter(h => !reached(websites()[site]).some(p => covers(p, h)) && websites()[site].classes?.[h] !== 'tracker');

export const viewPage = async (id: string) => (await call('GET', `/sessions/${id}/view`)).toString();

// Ends a sign-in; with `save`, what the browser holds becomes the person's login to the site, replacing any before, kept alive until
// `keepalive` if given, at most 7 days ahead (keepAlive). Signing in takes requests the person makes in control of the browser, so
// with none there is nothing to save yet. What its browser did is one line of the server's output, its addresses as their hosts
// alone, as a path or a query may hold codes or tokens.
export async function endSignIn(email: string, id: string, save: boolean, keepalive?: unknown) {
  if (!isSignIn(email, id)) throw new HttpError(404, 'no such sign-in');
  const until = keepalive === undefined ? undefined : Date.parse(String(keepalive));
  if (until !== undefined && !(until > Date.now() && until <= Date.now() + 7 * 86_400_000)) throw new HttpError(400, 'keepalive: a time within the next 7 days, until which your login is kept alive');
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
  const seconds = Math.round((Date.now() - since) / 1000);
  console.log(`sign-in ended ${JSON.stringify({ id, site, email, saved: save, seconds, requests, blocked, failed })}`);
  if (!save) return;
  saveLogin(email, { id: `web:${site}`, kind: 'website', name, since: new Date().toISOString(), offers: [{ id: `web:${site}`, name }], ...(until && { keepalive: new Date(until).toISOString() }),
    trace: { requests, blocked: blocked.hosts, seconds } }, JSON.stringify(state));
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
  const login = b.writeback && logins(b.email).find(l => l.id === `web:${b.site}`);
  if (login && state && !login.expired && login.since === b.since) saveLogin(b.email, login, JSON.stringify(state));
  mkdirSync(join(inst.dir, 'browser'), { recursive: true });
  replaceReadOnly(join(inst.dir, b.file), log.map(e => JSON.stringify(e) + '\n').join(''));
  const writes = log.filter(e => !e.blocked && !['GET', 'HEAD', 'OPTIONS'].includes(e.method)).length, hosts: Record<string, number> = {};
  for (const h of log.filter(e => e.blocked === 'host not on the list').map(e => URL.parse(e.url)!.hostname)) hosts[h] = (hosts[h] ?? 0) + 1;
  inst.append('server', 'browser', { run: b.run, site: b.site, ...(b.email && { login: b.email }), requests: log.length, writes, blocked: log.filter(e => e.blocked).length, file: b.file,
    ...(Object.keys(hosts).length && { hosts }) });
  if (Object.keys(hosts).length && websites()[b.site]) classify(inst, b.run, b.site, hosts).catch(e => console.error(`sorting the hosts ${b.site} was refused:`, e));
}

// The hosts a run's browser on a website was refused, sorted once each: one within the registrable domains the website reaches is
// its own, and the website reaches it from then on, logged in the instance as `browser` with `allowed`; of the rest, the server's
// model says which are its sign-on's or its pages' CDN, and which are trackers, which stay refused and wait on no one. The others
// wait on its owner and admins under Waiting on you, marked as the model says: only a person allows a host the website doesn't own.
// Without the server's key only its own are sorted.
const CLASSIFY = `A browser on a company's website, run by an automated job, was refused these hosts, which the website may not reach. Say what each is to the website, as one JSON object {"hosts": {HOST: "sign-on" | "cdn" | "tracker" | "other"}}: "sign-on" for the identity provider its sign-in goes through, "cdn" for where its own pages' scripts, styles, fonts or images come from, "tracker" for analytics, advertising, telemetry or chat widgets, and "other" for anything else or anything you're unsure of.`;

async function classify(inst: Instance, run: number, site: string, refused: Record<string, number>) {
  const w = websites()[site], key = process.env.OPENROUTER_API_KEY, domain = (x: string) => getDomain(x.replace(/^\*\./, ''), { allowPrivateDomains: true }) ?? x;
  const todo = unreached(site, Object.keys(refused)).filter(h => !w.classes?.[h]), own = todo.filter(h => reached(w).some(p => domain(p) === domain(h)));
  const rest = todo.filter(h => !own.includes(h));
  let sorted: Record<string, string> = {};
  if (rest.length && key) {
    const res = await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, provider: { data_collection: 'deny' }, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: CLASSIFY }, { role: 'user', content: JSON.stringify({
        website: { name: site, title: w.name, address: new URL(w.url).host, hosts: w.hosts }, refused: Object.fromEntries(rest.map(h => [h, refused[h]])),
      }) }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
    sorted = JSON.parse((await res.json()).choices[0].message.content).hosts ?? {};
  }
  const allowed: string[] = [];
  for (const h of own) if (await checkHost(site, h, !!w.internal).then(() => true, () => false)) allowed.push(h);
  const classes = Object.fromEntries(rest.filter(h => sorted[h]).map(h => [h, ['sign-on', 'cdn', 'tracker'].includes(sorted[h]) ? sorted[h] : 'other']));
  if (!allowed.length && !Object.keys(classes).length) return;
  changeConnection(site, { hosts: [...new Set([...w.hosts, ...allowed])], classes: { ...w.classes, ...classes } }, 'server');
  console.log(`hosts sorted ${JSON.stringify({ site, inst: inst.id, run, allowed, classes })}`);
  if (allowed.length) inst.append('server', 'browser', { run, site, action: 'allowed', allowed });
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
  // connection, so a login its runner can no longer lend, or whose grant in the instance's workspace was revoked, stops at the next
  // one. One its runner must sign in to again is logged, as the agent API logs it, so the instance carries on once they do.
  lent(site: string) {
    try {
      // A try's stand-in instance (cli.ts) is in no workspace: any approved grant of its runner's does.
      const { email, login } = use(this.inst, this.run, `web:${site}`), had = this.bySite.get(site), w = websites()[site], t = tree(), ws = t.series[this.inst.seriesId]?.workspace;
      const out = !w ? undefined : w.off ? `${w.name} is switched off` : !approved(site, email, ws)
        ? `${email} has no approved grant to use ${w.name}${ws ? ` in ${t.workspaces[ws].name}` : ''}: they ask its owners for one on the Logins page` : undefined;
      if (out) throw Object.assign(new HttpError(403, `${out}; this run goes on without it`), { refused: true });
      if (login.expired) throw Object.assign(new HttpError(409, `${email}'s login to ${login.name} has expired: they sign in to it again on the Logins page, and the instance carries on`), { login: login.id });
      if (had && had.email !== email) throw new HttpError(409, `this run's browser on ${site} is in ${had.email}'s login, and ${email} has taken the instance over: the next run opens one in theirs`);
      return { email, login, had };
    } catch (e) {
      const { login, refused } = e as { login?: string; refused?: true };
      if (login) this.inst.append('server', 'expired', { run: this.run, login, name: websites()[site]?.name ?? site, runner: runnerOf(this.inst).by });
      if (refused && !this.refused.has(site)) this.inst.append('server', 'browser', { run: this.run, site, action: 'refused', why: (e as Error).message });
      if (refused) this.refused.add(site);
      throw e;
    }
  }

  // The run's browser on a website, for a connection `conn`: undefined if that went away while it waited.
  async browser(site: string, conn?: Duplex): Promise<string | undefined> {
    for (let waited = false; ; waited = true) {
      if (this.ended) return undefined;
      const { email, login, had } = site === PRINT ? { email: '', login: undefined, had: this.bySite.get(site) } : this.lent(site);
      if (had) return had.id;
      if (this.opening.has(site)) return this.opening.get(site);
      const w = site === PRINT ? undefined : website(site), writeback = !!w?.writeback, key = `${email} ${site}`, other = writeback ? held.get(key) : undefined;
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
      const opening = w ? open(w, 7200, JSON.parse(secret(email, login!.id))) : printer();
      this.opening.set(site, opening);
      try {
        const id = await opening, n = (this.opens.get(site) ?? 0) + 1, file = `browser/run ${this.run} ${site}${n > 1 ? ` ${n}` : ''}.jsonl`;
        const b = { id, email, since: login?.since ?? '', writeback, file, conns: 0 };
        this.opens.set(site, n);
        this.bySite.set(site, b);
        changes.emit('change', this.inst.id); // for its instance's page to show it
        setJournal({ ...journal(), [id]: { inst: this.inst.id, run: this.run, site, email, since: b.since, writeback, file } });
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
    if (b.writeback || site === PRINT) b.idle = setTimeout(() => this.close(site).catch(e => this.inst.append('server', 'browsers', { run: this.run, error: e.message })), site === PRINT ? 0 : IDLE_MS);
  }

  private release(key: string) {
    const h = held.get(key);
    if (h?.run !== this) return;
    held.delete(key);
    h.release();
  }

  // The run's open browsers on websites, which whoever sees its instance may watch, by website, with their sessions.
  watchable(): Map<string, string> {
    return new Map([...this.bySite].filter(([site]) => site !== PRINT).map(([site, b]) => [site, b.id]));
  }

  // Those of them in `email`'s login, which they may take control of from the page.
  yours(email: string): string[] {
    return [...this.bySite].filter(([, b]) => b.email === email).map(([site]) => site);
  }

  // Its person taking control of the run's browser on `site` over `conn`, which holds it open as the agent's connections do: logged
  // as theirs.
  drive(site: string, email: string, conn: Duplex): string {
    if (!this.yours(email).includes(site)) throw new HttpError(404, `no browser of this run on ${site} in your login`);
    this.connected(site, conn);
    this.inst.append(email, 'browser', { run: this.run, site, action: 'drive' });
    return this.bySite.get(site)!.id;
  }

  // The agent found the website signed out: the runner's login is marked expired, for them to sign in again, which wakes the instance,
  // and its browser closes.
  async expire(site: string): Promise<never> {
    const { email, login } = use(this.inst, this.run, `web:${site}`);
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

// ---- Keeping logins alive: those admins grant keepalive may keep their login to a website alive as they sign in to it, until a
// time at most 7 days ahead, so that runs that come while they're away, such as a weekday's at 8:00, find it signed in. Every
// `every` minutes the website gives, 10 unless it gives one, such as 8 for PatriArch, which ends sessions left idle after 12, the
// server loads its keepalive page, or else its address, in the browser of each person keeping a live login there alive who may
// still use the website, unless a run of theirs holds that browser; where the website writes its state back, the turn holds it, so
// a run that connects meanwhile waits. The browser reaches only that page's host, so a sign-in elsewhere, as single sign-on would
// make one, never stretches a session past what the site allows: a page asking for a password, or one elsewhere, means the login
// expired, as rf expired says, and else the browser's state is the login.
const lastTurn = new Map<string, number>();

export async function keepAlive(now = new Date()) {
  const keeping = Object.entries(users()).filter(([email, u]) => { const p = asPerson(email, u); return p && can(p, 'keepalive'); }).map(([email]) => email);
  for (const [site, w] of Object.entries(websites())) {
    if (now.getTime() - (lastTurn.get(site) ?? 0) < (w.every ?? 10) * 60_000) continue;
    lastTurn.set(site, now.getTime());
    for (const email of keeping) {
      const login = logins(email).find(l => l.id === `web:${site}`), key = `${email} ${site}`;
      if (!login || login.expired || (login.keepalive ?? '') <= now.toISOString() || w.off || !approved(site, email) || held.has(key)) continue;
      let release!: () => void;
      if (w.writeback) held.set(key, { released: new Promise<void>(ok => { release = ok; }), release: () => release() });
      try {
        const page = new URL(w.keepalive ?? w.url, w.url), id = await open({ ...w, url: page.href, hosts: [] }, 300, JSON.parse(secret(email, login.id)));
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
    if (site !== PRINT) b.lent(site);
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
