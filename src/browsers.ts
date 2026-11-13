import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, instance, instances, replaceReadOnly, type Instance } from './store.ts';
import { logins, personDir, runnerOf, saveLogin, seal, secret, signOut, use } from './logins.ts';
import { getDomain } from 'tldts';
import { checkHost, covers, letIn, reached, resolvesInternal, setLetIn, upstreams } from './connections.ts';
import { answer, model } from './connections/openrouter.ts';
import { asPerson, can, users, type Me } from './auth.ts';
import { approved, forgetGrants } from './grants.ts';
import { act, changes, readJson, rfDir, tree } from './system.ts';

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
      res.on('error', e => fail(new HttpError(502, `browser service: ${e.message}`)));
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
  (await json('POST', '/sessions', { site: { hosts: [new URL(w.url).hostname, ...w.hosts], start_url: w.url, headers, ...(!internalOf(w) && { public: true }) }, state, ttl_s })).id;
// Whether admins let websites reach one of its exact hosts, its address's or one its person allowed.
const internalOf = (w: Website) => {
  const let_ = letIn();
  return reached(w).some(h => !!let_[h]);
};
const close = (id: string): Promise<{ state: unknown; log: { method: string; url: string; status: number; blocked?: string; error?: string }[] }> => json('DELETE', `/sessions/${id}`);

// A websocket passed through to the service's `path`, with the key added.
export function passUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string) {
  const port = Number(u.port || (tls ? 443 : 80));
  const up = tls ? tlsConnect({ host: u.hostname, port, servername: isIP(u.hostname) ? undefined : u.hostname }) : connect(port, u.hostname);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  const headers: Record<string, unknown> = { ...req.headers, host: u.host, ...key() };
  delete headers.cookie;
  up.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
  up.write(head);
  socket.pipe(up).pipe(socket);
}

// ---- Websites, each person's own, in their folder beside their logins (logins.ts): by a name of theirs, the https address where they
// sign in, the other hosts its pages need, such as single sign-on's, and how its browsers behave. One person may have several at one
// host, such as two sign-in pages or two accounts, and two people may name theirs alike or not: a run's browser on NAME is its
// runner's own NAME, and its first message names each with its address. A run uses it only where its runner's grant in the
// instance's workspace is approved (grants.ts). A browser on one reaches only its hosts; whatever its login may do there, the browser
// may, so keeping to reads is the agent's, and its request log shows what it did. Admins only let websites reach internal addresses,
// a host once for everyone's.

export type Website = { url: string; hosts: string[]; writeback: boolean; header?: string; keepalive?: string; every?: number; checks?: Record<string, { verdict: 'pass' | 'refused' | 'high' | 'internal'; why: string }>; added: string };
const sitesFile = (email: string) => join(personDir(email), 'websites.json');
export const websitesOf = (email: string): Record<string, Website> => existsSync(sitesFile(email)) ? JSON.parse(readFileSync(sitesFile(email), 'utf8')) : {};
function saveWebsites(email: string, all: Record<string, Website>) {
  mkdirSync(personDir(email), { recursive: true, mode: 0o700 });
  writeFileSync(sitesFile(email), JSON.stringify(all, null, 1), { mode: 0o600 });
}
export const changeWebsite = (email: string, name: string, change: Partial<Website>) => saveWebsites(email, { ...websitesOf(email), [name]: { ...website(email, name), ...change } });

function website(email: string, name: string): Website {
  const w = websitesOf(email)[name];
  if (!w) throw new HttpError(404, `${email} has no website ${name}: theirs are ${Object.keys(websitesOf(email)).join(', ') || 'none yet'}, added on the Logins page or with rf site add ${name} URL`);
  return w;
}

// ---- Signing in: a browser on the website's address with nothing saved, shown to the person on the Logins page, for half an hour.
// A website that names a header, such as Retail Link's x-bot-token, which its sign-in needs and its pages never send, has the
// person's token for it on that browser's requests to its address, put there by the browser service, so the browser never holds
// it. It is sealed with their login as they save it, and used again when they sign in again without a new one; never sent for a
// run's browser.

const signIns = new Map<string, { email: string; site: string; name: string; token?: string; since: number }>();

export async function startSignIn(email: string, site: string, given: string): Promise<string> {
  const w = website(email, site), kept = `web:${site}.header`;
  await checkHost(new URL(w.url).hostname, false);
  let token;
  if (w.header) {
    token = given.trim() || (existsSync(join(personDir(email), `${kept}.sealed`)) ? secret(email, kept) : '');
    if (!token) throw new HttpError(400, `${site} needs your ${w.header} to sign in: give it in the box under its name, on the Logins page`);
    if (/[^\x20-\x7e]/.test(token)) throw new HttpError(400, `${w.header}: letters, digits and punctuation`);
  }
  const before = [...signIns].find(([, s]) => s.email === email && s.site === site)?.[0];
  if (before) await endSignIn(email, before, false).catch(e => console.error(`ending the previous sign-in to ${site}:`, e));
  const id = await open(w, 1800, undefined, token && { [w.header!]: token });
  signIns.set(id, { email, site, name: site, token, since: Date.now() });
  return id;
}

export const isSignIn = (email: string, id: string) => signIns.get(id)?.email === email;

// A website of one's own: its name, which runs use, the https address where its sign-in starts, and the header that sign-in needs, if
// any; the other hosts its pages need its person allows as they sign in to it. One at an internal address no browser reaches until an
// admin lets websites reach that host (setSite), once for everyone's, as signing in to it says.
export async function addSite(email: string, name: string, url: string, header = '') {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name === PRINT) throw new HttpError(400, `a website's name is lowercase letters, digits and dashes, and not ${PRINT}, the runs' own print browser`);
  if (!/^https:\/\/[^/]/.test(url) || !URL.canParse(url)) throw new HttpError(400, 'url: an https address, where its sign-in starts');
  if (header && !/^[a-z0-9-]+$/i.test(header)) throw new HttpError(400, 'header: the name of a header its sign-in needs, such as x-bot-token');
  if (websitesOf(email)[name]) throw new HttpError(409, `you have a website ${name} already: name this one otherwise`);
  await checkHost(new URL(url).hostname, true);
  saveWebsites(email, { ...websitesOf(email), [name]: { url, hosts: [], writeback: true, ...(header && { header }), added: new Date().toISOString() } });
  return { site: name };
}

// Its person changes the header its sign-in needs, its keepalive page and how often, and whether runs write its state back; admins
// alone let it reach internal addresses, by exact hosts, as an intranet's need, anyone's: its hosts at internal addresses, its
// address's among them, every person's websites reach from then on, with no admin again, until an admin sets one at them false.
export async function setSite(by: Me, name: string, change: Record<string, unknown>, person = by.email) {
  const keys = ['header', 'keepalive', 'every', 'writeback', 'internal'], other = Object.keys(change).filter(k => !keys.includes(k));
  if (other.length) throw new HttpError(400, `${other.join(', ')}: a website's settings are ${keys.join(', ')}; its hosts are allowed one by one`);
  if (person !== by.email && (by.role !== 'admin' || Object.keys(change).some(k => k !== 'internal'))) throw new HttpError(403, `${person}'s website is theirs to change; admins only let it reach internal addresses`);
  if (change.internal !== undefined && by.role !== 'admin') throw new HttpError(403, 'internal: admins set it');
  const w = website(person, name), x = { ...w, every: w.every && `${w.every}m`, ...change }, every = /^(\d+)([mh])$/.exec(String(x.every ?? ''));
  if (![undefined, true, false, 'true', 'false'].includes(x.writeback as never)) throw new HttpError(400, 'writeback: true or false');
  if (x.header !== undefined && !/^[a-z0-9-]+$/i.test(String(x.header))) throw new HttpError(400, 'header: the name of a header its sign-in needs, such as x-bot-token');
  if (x.keepalive !== undefined && URL.parse(String(x.keepalive), w.url)?.host !== new URL(w.url).host) throw new HttpError(400, 'keepalive: a page of the website, by its address or path, such as https://patriarch.patrina.net/PatriArchMVC/');
  if (x.every !== undefined && !(every && Number(every[1]) > 0)) throw new HttpError(400, 'every: minutes or hours, such as 10m or 1h');
  saveWebsites(person, { ...websitesOf(person), [name]: { url: w.url, hosts: w.hosts, writeback: x.writeback !== false && x.writeback !== 'false', added: w.added,
    ...(x.header !== undefined && { header: String(x.header) }),
    ...(x.keepalive !== undefined && { keepalive: String(x.keepalive) }), ...(every && { every: Number(every[1]) * (every[2] === 'h' ? 60 : 1) }),
    ...(w.checks && { checks: w.checks }) } });
  if (change.internal === undefined) return;
  const let_ = change.internal === true || change.internal === 'true', exact = reached(w).filter(h => !h.startsWith('*.'));
  const hosts = let_ ? (await Promise.all(exact.map(async h => await resolvesInternal(h) && h))).filter(h => h) as string[] : exact.filter(h => letIn()[h]);
  setLetIn(hosts, by.email, let_);
  act(by.email, { op: 'internal', person, site: name, hosts, let: let_ });
}

// A website set --internal true before 0.3.12 carries that as a flag of its own, which grants nothing now. At the server's start
// its exact hosts at internal addresses join those admins let websites reach, as setting it again would, but for one an admin took
// out since, and the flag goes; one none of whose hosts resolves so yet, as before its network is up, keeps it for the next start.
export async function enrolFlagged() {
  const log = join(rfDir(), 'log.jsonl');
  const out = new Set(existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a.op === 'internal' && a.let === false).flatMap(a => a.hosts as string[]) : []);
  for (const email of Object.keys(users())) for (const [name, { internal, ...w }] of Object.entries(websitesOf(email) as Record<string, Website & { internal?: true }>)) {
    if (!internal) continue;
    const hosts = (await Promise.all(reached(w).filter(h => !h.startsWith('*.') && !out.has(h)).map(async h => await resolvesInternal(h) && h))).filter(h => h) as string[];
    if (!hosts.length) continue;
    setLetIn(hosts, 'server', true);
    act('server', { op: 'internal', person: email, site: name, hosts, let: true });
    saveWebsites(email, { ...websitesOf(email), [name]: w });
  }
}

// A website goes with its person's login to it and their grants for it, no one else's.
export function removeSite(email: string, name: string) {
  website(email, name);
  const { [name]: _, ...rest } = websitesOf(email);
  saveWebsites(email, rest);
  forgetGrants(email, name);
  if (logins(email).some(l => l.id === `web:${name}`)) signOut(email, `web:${name}`);
}

// The hosts a person's sign-in to their website was refused and still is, each with its count, and *.D where two or more of them are
// under one registrable domain D.
export async function refusedHosts(email: string, site: string) {
  const w = website(email, site), id = [...signIns].find(([, s]) => s.email === email && s.site === site)?.[0], reach = reached(w);
  if (!id) throw new HttpError(404, `no sign-in of yours to ${site} is open`);
  const n = new Map<string, number>();
  for (const e of await json('GET', `/sessions/${id}/log`) as { url: string; blocked?: string }[]) {
    const host = e.blocked === 'host not on the list' && URL.parse(e.url)!.hostname;
    if (host && !reach.some(p => covers(p, host))) n.set(host, (n.get(host) ?? 0) + 1);
  }
  const under = Map.groupBy(n.keys(), h => getDomain(h, { allowPrivateDomains: true }) ?? h);
  return { hosts: [...[...under].filter(([d, hs]) => hs.length > 1 && hs.some(h => h !== d)).map(([d, hs]) => ({ host: `*.${d}`, count: hs.reduce((t, h) => t + n.get(h)!, 0) })),
    ...[...n].map(([host, count]) => ({ host, count }))].sort((a, b) => b.count - a.count) };
}

// A host a person's website's pages need, allowed by them, or by an admin; their open sign-in to it, if any, reaches it at once. Once
// a grant to it is approved, its person allows only hosts within the registrable domains it reaches already: one elsewhere would widen
// what the grant approved, which is an admin's to approve. One at an internal address is an admin's to allow, once for everyone's
// websites, which lets the website reach internal addresses; after that its person allows it as any other.
export async function allowHost(by: Me, site: string, host: string, email = by.email) {
  if (email !== by.email && by.role !== 'admin') throw new HttpError(403, `${email}'s websites are theirs`);
  const w = website(email, site), h = host.trim().toLowerCase(), domain = (x: string) => getDomain(x.replace(/^\*\./, ''), { allowPrivateDomains: true }) ?? x;
  if (by.role !== 'admin' && approved(site, email) && !reached(w).some(p => domain(p) === domain(h))) throw new HttpError(403, `${h} is outside the domains ${site} reaches, which its approved grants cover: an admin allows it`);
  const inside = await resolvesInternal(h), admin = inside && by.role === 'admin';
  if (inside && !admin && !letIn()[h]) throw new HttpError(403, `${h} is at an internal address: an admin allows it`);
  const verdict = w.checks?.[h]?.verdict;
  if (by.role !== 'admin' && (verdict === 'high' || verdict === 'internal')) throw new HttpError(403, `the check rates ${h} ${verdict}: an admin allows it`);
  await checkHost(h, inside);
  changeWebsite(email, site, { hosts: [...new Set([...website(email, site).hosts, h])] });
  if (admin && !letIn()[h]) {
    setLetIn([h], by.email, true);
    act(by.email, { op: 'internal', person: email, site, hosts: [h], let: true });
  }
  const id = [...signIns].find(([, s]) => s.email === email && s.site === site)?.[0];
  if (!id) return;
  await json('PUT', `/sessions/${id}/hosts`, { hosts: reached(website(email, site)) });
  await json('POST', `/sessions/${id}/reload`);
}

// A host its person no longer lets their website reach: it stays refused from then on, the check passing it no more.
export async function removeHost(email: string, site: string, host: string) {
  const w = website(email, site);
  if (!w.hosts.includes(host)) throw new HttpError(404, `${site} doesn't reach ${host}: beyond its address it reaches ${w.hosts.join(', ') || 'no host'}`);
  changeWebsite(email, site, { hosts: w.hosts.filter(h => h !== host), checks: { ...w.checks, [host]: { verdict: 'refused', why: 'Its person removed it.' } } });
  const id = [...signIns].find(([, s]) => s.email === email && s.site === site)?.[0];
  if (id) await json('PUT', `/sessions/${id}/hosts`, { hosts: reached(website(email, site)) });
}

// The hosts a person's website doesn't reach, of those asked for.
export const unreached = (email: string, site: string, hosts: string[]) => {
  const w = websitesOf(email)[site];
  return !w ? [] : hosts.filter(h => !reached(w).some(p => covers(p, h)));
};

export const viewPage = async (id: string) => (await call('GET', `/sessions/${id}/view`)).toString();

// Ends a sign-in; with `save`, what the browser holds becomes the person's login to the site, replacing any before, kept alive until
// `keepalive` if given, at most 7 days ahead (keepAlive). Signing in takes requests the person makes in control of the browser, so
// with none there is nothing to save yet. What its browser did is one line of the server's output, its addresses as their hosts
// alone, as a path or a query may hold codes or tokens.
export async function endSignIn(email: string, id: string, save: boolean, keepalive?: unknown) {
  if (!isSignIn(email, id)) throw new HttpError(404, 'no such sign-in');
  const until = keepalive === undefined ? undefined : Date.parse(String(keepalive));
  if (until !== undefined && !(until > Date.now() && until <= Date.now() + 7 * 86_400_000)) throw new HttpError(400, 'keepalive: a time within the next 7 days, until which your login is kept alive');
  if (save && !(await json('GET', `/sessions/${id}/log`).catch(e => { signIns.delete(id); throw e; })).some((e: { live?: true }) => e.live)) throw new HttpError(409, 'Take control and sign in first, then Save login.');
  const { site, name, token, since } = signIns.get(id)!;
  signIns.delete(id);
  const { state, log } = await close(id);
  // Removed meanwhile, as from another tab, it saves nothing.
  if (save) website(email, site);
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
type Entry = { method: string; url: string; blocked?: string; dest?: string; from?: string };
function keep(inst: Instance, b: Opened, { state, log }: { state: unknown; log: Entry[] }) {
  const login = b.writeback && logins(b.email).find(l => l.id === `web:${b.site}`);
  if (login && state && !login.expired && login.since === b.since) saveLogin(b.email, login, JSON.stringify(state));
  if (inst.hole) return;
  mkdirSync(join(inst.dir, 'browser'), { recursive: true });
  replaceReadOnly(join(inst.dir, b.file), log.map(e => JSON.stringify(e) + '\n').join(''));
  const writes = log.filter(e => !e.blocked && !['GET', 'HEAD', 'OPTIONS'].includes(e.method)).length, hosts: Record<string, number> = {};
  for (const h of log.filter(e => e.blocked === 'host not on the list').map(e => URL.parse(e.url)!.hostname)) hosts[h] = (hosts[h] ?? 0) + 1;
  inst.append('server', 'browser', { run: b.run, site: b.site, ...(b.email && { login: b.email }), requests: log.length, writes, blocked: log.filter(e => e.blocked).length, file: b.file,
    ...(Object.keys(hosts).length && { hosts }) });
  if (Object.keys(hosts).length && websitesOf(b.email)[b.site]) checkRefused(inst, b.run, b.email, b.site, log).catch(e => console.error(`checking the hosts ${b.site} was refused:`, e));
}

// The hosts a run's browser on a person's website was refused, each checked once, its verdict in the website's `checks`: one at an
// internal address waits on admins, even within the registrable domains the website reaches, unless admins let every website reach
// it, which makes it as any other; one within them is its own, which it
// reaches at once; of the rest, the server's model decides each from what the browser's log and the runs say of it, and a web
// search's top result about it where the server has Exa's key: one its pages need it reaches at once, one they work without, such as
// a tracker's, stays refused, and anything else waits on admins. Each host it reaches is logged in the instance, as `browser` with
// `action: allowed`, and in the system's log. Without the server's key the rest are left, for its person to allow.
const CHECK = `A browser on a company's website, run by an automated job for its finance team, was refused these hosts, which the website doesn't reach. Decide for each whether its browsers may reach it from now on, from this evidence alone: "as", the kinds of request its pages made to it (document, iframe, script, style, image, font, or empty for a page's own fetch), where the browser said; "from", the hosts of the pages that asked; "requests" and "runs", how often so far; "domain", its registrable domain, which isn't one the website reaches; and "search", a web search's top result about it, if any. Answer one JSON object {"hosts": {HOST: {"verdict": "pass" | "refused" | "high", "why": "what it is, in one short sentence"}}}: "pass" for what its pages need, such as the identity provider its sign-in goes through, or where its own scripts, styles, fonts or images come from; "refused" for what they work without, such as analytics, advertising, telemetry or chat widgets; and "high" for anything that could take the company's data elsewhere, such as file sharing, pastes or uploads, and for anything you're unsure of, which an admin decides.`;

async function checkRefused(inst: Instance, run: number, email: string, site: string, log: Entry[]) {
  const w = website(email, site), key = process.env.OPENROUTER_API_KEY, exa = process.env.EXA_API_KEY, domain = (x: string) => getDomain(x.replace(/^\*\./, ''), { allowPrivateDomains: true }) ?? x;
  const asked = log.filter(e => e.blocked === 'host not on the list'), host = (e: Entry) => URL.parse(e.url)!.hostname, instant: NonNullable<Website['checks']> = {};
  const todo = unreached(email, site, [...new Set(asked.map(host))]).filter(h => !w.checks?.[h]);
  for (const h of todo) {
    if (await resolvesInternal(h) && !letIn()[h]) instant[h] = { verdict: 'internal', why: 'It is at an internal address.' };
    else if (reached(w).some(p => domain(p) === domain(h))) instant[h] = { verdict: 'pass', why: `It is within ${domain(h)}, the website's own domain.` };
  }
  // Verdicts kept as they come, those above before the model's, so a model or a search that fails leaves them.
  const settle = async (checks: NonNullable<Website['checks']>) => {
    for (const h of Object.keys(checks).filter(h => checks[h].verdict === 'pass')) {
      const out = await checkHost(h, false).then(() => '', (e: Error) => e.message);
      if (out) checks[h] = { verdict: 'refused', why: out };
    }
    const now = website(email, site);
    checks = Object.fromEntries(Object.entries(checks).filter(([h]) => !now.checks?.[h]));
    if (!Object.keys(checks).length) return;
    const allowed = Object.keys(checks).filter(h => checks[h].verdict === 'pass'), why = Object.fromEntries(allowed.map(h => [h, checks[h].why]));
    changeWebsite(email, site, { hosts: [...new Set([...now.hosts, ...allowed])], checks: { ...now.checks, ...checks } });
    console.log(`hosts checked ${JSON.stringify({ site, email, inst: inst.id, run, checks })}`);
    if (!allowed.length) return;
    inst.append('server', 'browser', { run, site, login: email, action: 'allowed', allowed, why });
    act('server', { op: 'hosts', person: email, site, inst: inst.id, run, allowed: why });
  };
  await settle(instant);
  const rest = todo.filter(h => !instant[h]);
  if (rest.length && key) {
    const runs = Object.keys(tree().series).flatMap(sid => instances(sid)).flatMap(i => i.log.filter(e => e.op === 'browser' && !e.action && e.site === site && e.login === email && e.hosts)) as { hosts: Record<string, number> }[];
    const refused = Object.fromEntries(await Promise.all(rest.map(async h => {
      const its = asked.filter(e => host(e) === h);
      let search;
      if (exa) {
        const res = await fetch(`${upstreams['api.exa.ai'] ?? 'https://api.exa.ai'}/search`, { method: 'POST', headers: { 'x-api-key': exa, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ query: h, numResults: 1, contents: { highlights: true } }) });
        if (!res.ok) throw new Error(`Exa answered ${res.status}`);
        const r = (await res.json()).results[0];
        search = r && { title: r.title, url: r.url, text: r.highlights?.join(' ') };
      }
      return [h, { as: [...new Set(its.flatMap(e => e.dest ?? []))], from: [...new Set(its.flatMap(e => URL.parse(e.from ?? '')?.hostname ?? []))],
        requests: runs.reduce((t, e) => t + (e.hosts[h] ?? 0), 0), runs: runs.filter(e => e.hosts[h]).length, domain: domain(h), ...(search && { search }) }];
    })));
    const res = await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, provider: { data_collection: 'deny' }, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: CHECK }, { role: 'user', content: JSON.stringify({
        website: { name: site, address: new URL(w.url).host, hosts: website(email, site).hosts }, refused,
      }) }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
    const said = answer((await res.json()).choices[0].message.content).hosts ?? {};
    await settle(Object.fromEntries(rest.map(h => [h, { verdict: ['pass', 'refused'].includes(said[h]?.verdict) ? said[h].verdict : 'high', why: String(said[h]?.why ?? 'The check gave no verdict for it.') }])));
  }
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
  private opening = new Map<string, Promise<string | undefined>>();
  private closing = new Set<Promise<unknown>>();
  private opens = new Map<string, number>();
  private refused = new Set<string>();
  private conns = new Map<Duplex, string>();
  private ended = false;
  shots = 0;
  constructor(inst: Instance, run: number) {
    this.inst = inst;
    this.run = run;
  }

  // The login a browser on a website may use now, and the run's browser there if open: checked at every call and new connection,
  // and as its lending changes. One its runner must sign in to again is logged, so the instance carries on once they do.
  lent(site: string) {
    try {
      // A try's stand-in instance (cli.ts) is in no workspace: any approved grant of its runner's does.
      const { email, login } = use(this.inst, this.run, `web:${site}`), had = this.bySite.get(site), t = tree(), ws = t.series[this.inst.seriesId]?.workspace;
      if (!approved(site, email, ws)) throw Object.assign(new HttpError(403, `${email} has no approved grant to use ${site}${ws ? ` in ${t.workspaces[ws].name}` : ''}: they ask its owners for one on the Logins page; this run goes on without it`), { refused: true });
      if (login.expired) throw Object.assign(new HttpError(409, `${email}'s login to ${site} has expired: they sign in to it again on the Logins page, and the instance carries on`), { login: login.id });
      if (had && had.email !== email) throw new HttpError(409, `this run's browser on ${site} is in ${had.email}'s login, and ${email} has taken the instance over: the next run opens one in theirs`);
      return { email, login, had };
    } catch (e) {
      const { login, refused } = e as { login?: string; refused?: true };
      if (login) this.inst.append('server', 'expired', { run: this.run, login, name: site, runner: runnerOf(this.inst).by });
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
      const w = site === PRINT ? undefined : website(email, site), writeback = !!w?.writeback, key = `${email} ${site}`, other = writeback ? held.get(key) : undefined;
      if (other) {
        if (!waited) this.inst.append('server', 'browser', { run: this.run, site, login: email, action: 'wait', held: other.run ? `${tree().series[other.run.inst.seriesId]?.name}/${other.run.inst.label}` : 'keepalive' });
        await Promise.race([other.released, new Promise(ok => conn?.once('close', ok))]);
        if (conn?.destroyed) return undefined;
        continue;
      }
      const state = w ? JSON.parse(secret(email, login!.id)) : undefined;
      if (writeback) {
        let release!: () => void;
        held.set(key, { run: this, released: new Promise<void>(ok => { release = ok; }), release: () => release() });
      }
      const opening = w ? open(w, 7200, state) : printer();
      const ready = opening.then(async id => {
        const n = (this.opens.get(site) ?? 0) + 1, file = `browser/run ${this.run} ${site}${n > 1 ? ` ${n}` : ''}.jsonl`;
        const b = { id, email, since: login?.since ?? '', writeback, file, conns: 0 };
        this.opens.set(site, n);
        this.bySite.set(site, b);
        changes.emit('change', this.inst.id); // for its instance's page to show it
        setJournal({ ...journal(), [id]: { inst: this.inst.id, run: this.run, site, email, since: b.since, writeback, file } });
        if (this.ended) {
          await this.close(site);
          return undefined;
        }
        if (site !== PRINT) try { this.lent(site); } catch (e) {
          await this.close(site);
          throw e;
        }
        this.idle(site, b);
        return id;
      }).catch(e => {
        if (writeback) this.release(key);
        throw e;
      }).finally(() => this.opening.delete(site));
      this.opening.set(site, ready);
      return ready;
    }
  }

  // A connection to the run's browser on `site`, which it holds while any is open.
  connected(site: string, conn: Duplex) {
    const b = this.bySite.get(site)!;
    b.conns++;
    this.conns.set(conn, site);
    clearTimeout(b.idle);
    conn.on('close', () => {
      this.conns.delete(conn);
      if (!--b.conns && this.bySite.get(site) === b) this.idle(site, b);
    });
  }

  // A stop cuts every connection to the run's browsers; the browsers stay open for the next start to close (reap()).
  cut() {
    for (const c of this.conns.keys()) c.destroy();
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

  async closeUnlent() {
    await Promise.all([...this.bySite.keys()].filter(site => site !== PRINT).map(async site => {
      try { this.lent(site); } catch { await this.close(site); }
    }));
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

  // The agent found the website signed out: the runner's login is marked expired, and logged so, for them to sign in again, which
  // wakes the instance, and its browser closes.
  async expire(site: string): Promise<string> {
    const { email, login } = use(this.inst, this.run, `web:${site}`);
    saveLogin(email, { ...login, expired: true });
    await this.close(site);
    this.inst.append('server', 'expired', { run: this.run, login: login.id, name: site, runner: runnerOf(this.inst).by });
    return `recorded: ${site} signed ${email} out; they sign in to it again on the Logins page, and the instance carries on`;
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
    this.close();
    return Promise.all([...this.closing, ...[...this.opening.values()].map(p => p.catch(() => {}))]);
  }

  // A screenshot of each browser's newest tab, unless it looks as it did at the last, logged as shot for the audit.
  async shoot() {
    await Promise.all([...this.bySite].map(async ([site, b]) => {
      const png = await call('GET', `/sessions/${b.id}/screenshot`);
      if (this.ended || this.inst.hole || b.shot?.equals(png)) return;
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
  close(only?: string) {
    const closing = Promise.all([...this.bySite].filter(([site]) => !only || site === only).map(async ([site, { id, email, since, writeback, file, idle }]) => {
      this.bySite.delete(site);
      clearTimeout(idle);
      for (const [conn, on] of this.conns) if (on === site) conn.destroy();
      try {
        const closed = await close(id), all = journal();
        delete all[id];
        setJournal(all);
        keep(this.inst, { inst: this.inst.id, run: this.run, site, email, since, writeback, file }, closed);
      } finally {
        if (writeback) this.release(`${email} ${site}`);
      }
    })).finally(() => this.closing.delete(closing));
    this.closing.add(closing);
    return closing;
  }
}

// ---- Keeping logins alive: those admins grant keepalive may keep their login to a website alive as they sign in to it, until a
// time at most 7 days ahead, so that runs that come while they're away, such as a weekday's at 8:00, find it signed in. Every
// `every` minutes a person's website gives, 10 unless it gives one, such as 8 for PatriArch, which ends sessions left idle after 12,
// the server loads its keepalive page, or else its address, in their login's browser, while they keep a live login there alive and
// may still use the website, unless a run of theirs holds that browser; where the website writes its state back, the turn holds it, so
// a run that connects meanwhile waits. The browser reaches only that page's host, so a sign-in elsewhere, as single sign-on would
// make one, never stretches a session past what the site allows: a page asking for a password, or one elsewhere, means the login
// expired, as rf expired says, and else the browser's state is the login.
const lastTurn = new Map<string, number>();

export async function keepAlive(now = new Date()) {
  const keeping = Object.entries(users()).filter(([email, u]) => { const p = asPerson(email, u); return p && can(p, 'keepalive'); }).map(([email]) => email);
  for (const email of keeping) for (const [site, w] of Object.entries(websitesOf(email))) {
    const key = `${email} ${site}`;
    if (now.getTime() - (lastTurn.get(key) ?? 0) < (w.every ?? 10) * 60_000) continue;
    lastTurn.set(key, now.getTime());
    const login = logins(email).find(l => l.id === `web:${site}`);
    if (!login || login.expired || (login.keepalive ?? '') <= now.toISOString() || !approved(site, email) || held.has(key)) continue;
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

// A run's browsers at $RF_BROWSERS/NAME, its token's path: GET NAME/json/version, CDP's discovery, as Playwright's connect_over_cdp
// asks it; GET NAME/downloads/PATH, a file in that browser's machine; and the CDP websocket at NAME itself, passed to the service.
// $RF_BROWSERS itself says what's there and how it's used: the websites ticked for the run, by its runner's names for them.
const BROWSERS = `Each website ticked for this run is a browser signed in as your runner, at $RF_BROWSERS/NAME for Playwright's connect_over_cdp, NAME
being your runner's name for it; another runner may name the same website otherwise. The run's connections share its browser, and
where a website writes its state back, a run of your runner's that holds it makes another wait. A download is at
$RF_BROWSERS/NAME/downloads/PATH, PATH its path on the browser's machine; a file you upload is at most 50 MB.
$RF_BROWSERS/print reaches nothing, for rendering to PDF with page.pdf(): your connections share it, so give each page a tab of its
own (new_page()).
Ticked for this run:`;
export async function serveBrowsers(b: Browsers, base: string, [site, what, ...path]: string[], req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET' && !site) {
    const { by, logins: ticked } = runnerOf(b.inst), sites = websitesOf(by), mine = ticked.filter(l => l.startsWith('web:') && sites[l.slice(4)]).map(l => l.slice(4));
    return void res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`${BROWSERS}\n${mine.map(s => `  ${s}  ${sites[s].url}`).join('\n') || '  no website'}\n`);
  }
  if (req.method === 'GET' && what === 'json' && path.join('/').replace(/\/$/, '') === 'version') {
    if (site !== PRINT) b.lent(site);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}${base}/${site}` }));
  }
  if (req.method === 'GET' && what === 'downloads') return b.download(site, path.map(decodeURIComponent).join('/'), res);
  throw new HttpError(404, `$RF_BROWSERS/${site} is the CDP address of this run's browser there; curl $RF_BROWSERS says how they're used`);
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
