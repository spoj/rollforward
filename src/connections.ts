import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { HttpError, type Instance } from './store.ts';
import { lookup } from 'node:dns/promises';
import { getDomain } from 'tldts';
import { isPrivate, readJson, rfDir, writeJson } from './system.ts';
import type { EntraLogin } from './auth.ts';
import { token } from './entra.ts';
import { lender, logins, runnerOf, saveLogin, secret, use, type Offer } from './logins.ts';
import graph from './connections/graph.ts';
import databricks from './connections/databricks.ts';
import website from './connections/website.ts';
import * as openrouter from './connections/openrouter.ts';
import * as exa from './connections/exa.ts';

// Connections: the outside systems runs reach, which admins keep with rf connection set NAME TYPE: each a name, a type and the
// type's settings, in .rf/connections.json. A type is a module under connections/, saying how its person signs in and what that
// login offers runs; for a system reached over HTTPS, the hosts it serves, which requests to them may go and the links its answers
// hold.
//
// A run reaches those hosts as they are, with real tools and the vendors' own docs: the sandbox's proxy ends TLS for them, as the
// host, with rollforward's own certificate authority (ca.ts), which runs trust. Each request is checked against the type's policy
// and the instance's ticks, has its Authorization replaced by the runner's token, and goes on; the answer comes back as it is, and
// a `call` entry logs it. A link an answer held, such as an upload session's, goes through for that run, as it is, with no
// credential added. A refusal is a plain 403 with the reason, logged too.
//
// The server's own connections, OpenRouter and Exa, each a module under connections/ too, are every run's while the server has
// its key, which no person lends: a request is checked against its policy and has the key put in for the run's stand-in, and what
// its answer cost adds to the run's.

export type Connection = { name: string; type: string; [setting: string]: any };
export type Request = { method: string; url: URL; headers: Record<string, string | string[] | undefined>; json?: any; body?: Buffer };
export type Mail = { to: string[]; sums: string[] };
export type Type = {
  settings(input: Record<string, unknown>): Record<string, unknown>;
  // Its person's login: an Entra login, with its scope, or a website's, which they sign in to in a live browser.
  login(c: Connection): (EntraLogin | { id: string; kind: string; name: string; scope?: undefined; offers: Offer[] });
  serves?(c: Connection, host: string): boolean;
  // The offer a request needs ticked, and its JSON body as it goes on, if the type rewrote it; or a refusal.
  // A request that sends mail also reads, on asking, what goes, its recipients and its attachments' sha256s, or why that can't be read.
  check?(c: Connection, runner: string, ticks: string[], r: Request): Promise<{ offer: string; json?: unknown; mail?: () => Promise<Mail | string> }>;
  links?(answer: any, path: string, email: string, ticks: string[]): string[] | Promise<string[]>;
  // What a run's environment holds for it, given the instance's ticks.
  env?(c: Connection, ticks: string[]): Record<string, string>;
};
export const types: Record<string, Type> = { graph, databricks, website };

export const connections = (): Connection[] => Object.entries(readJson<Record<string, any>>('connections.json', {})).map(([name, c]) => ({ name, ...c }));

// Whether a host, exact or *.domain for any name under the domain, covers another, which may be either too.
export const covers = (pattern: string, host: string) => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));
export const reached = (w: { url: string; hosts: string[] }) => [new URL(w.url).hostname, ...w.hosts];

// What a website may reach, an admin's or a person's own: never rollforward's own host; never another website's address, or a host
// another connection serves, so that no website goes around another's people or settings, though hosts such as single sign-on's
// they share; a wildcard within one registrable domain, the public suffixes being the Public Suffix List's, its private ones too;
// and for a person's own, never an internal address, which the browser refuses it too.
export async function checkHost(name: string, h: string, own: boolean) {
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new HttpError(400, `${h}: a host, such as sso.example.com, or *.example.com for any name under it`);
  const base = h.replace(/^\*\./, '');
  if (h !== base && !getDomain(base, { allowPrivateDomains: true })) throw new HttpError(400, `${h}: a wildcard stays within one registrable domain, such as *.example.com`);
  if ([process.env.RF_PUBLIC_URL, process.env.RF_BROWSER_URL].some(u => u && covers(h, new URL(u).hostname))) throw new HttpError(400, `${h} is rollforward's own: no website reaches it`);
  const other = connections().find(c => c.name !== name && (types[c.type].serves?.(c, base) || (c.type === 'website' && covers(h, new URL(c.url).hostname))));
  if (other) throw new HttpError(400, `${h} is ${other.name}'s: no other website reaches it`);
  if (own && h === base && (await lookup(h, { all: true }).catch(() => [])).some(isPrivate)) throw new HttpError(400, `${h} is at an internal address: a website of your own reaches none`);
}

export async function setConnection(name: string, input: Record<string, unknown>, by: string): Promise<Connection> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new HttpError(400, 'a connection\'s name is lowercase letters, digits and dashes');
  if (name === 'print') throw new HttpError(409, "print is the runs' own print browser, $RF_BROWSERS/print: name it otherwise");
  const type = types[String(input.type)];
  if (!type) throw new HttpError(400, `type: one of ${Object.keys(types).join(', ')}`);
  const settings = type.settings(input);
  if (type === website) for (const h of reached(settings as { url: string; hosts: string[] })) await checkHost(name, h, !!settings.owner);
  const all = readJson<Record<string, any>>('connections.json', {});
  all[name] = { type: input.type, ...settings, updated_by: by, updated_at: new Date().toISOString() };
  writeJson('connections.json', all);
  return { name, ...all[name] };
}

// A change to a connection's settings past their checks: a host a website's pages needed, allowed as its person signed in (browsers.ts),
// or an admin's switching a website off or on.
export function changeConnection(name: string, change: Record<string, unknown>, by: string) {
  const all = readJson<Record<string, any>>('connections.json', {});
  if (!all[name]) throw new HttpError(404, `no connection ${name}`);
  all[name] = { ...all[name], ...change, updated_by: by, updated_at: new Date().toISOString() };
  writeJson('connections.json', all);
}

// People's logins to a connection removed stay theirs to sign out of; no run can use them.
export function removeConnection(name: string) {
  const all = readJson<Record<string, any>>('connections.json', {});
  if (!all[name]) throw new HttpError(404, `no connection ${name}`);
  delete all[name];
  writeJson('connections.json', all);
}

// Once, at the start: the websites kept before connections become website connections, and Microsoft 365 is the graph connection.
export function convert() {
  if (existsSync(join(rfDir(), 'connections.json'))) return;
  const sites = readJson<Record<string, { name: string; url: string; hosts: string[]; updated_by: string; updated_at: string }>>('websites.json', {});
  writeJson('connections.json', {
    graph: { type: 'graph', updated_by: 'server', updated_at: new Date().toISOString() },
    ...Object.fromEntries(Object.entries(sites).map(([id, w]) => [id, { type: 'website', url: w.url, hosts: w.hosts, ...(w.name !== id && { title: w.name }), writeback: true, updated_by: w.updated_by, updated_at: w.updated_at }])),
  });
  rmSync(join(rfDir(), 'websites.json'), { force: true });
}

export const loginOf = (c: Connection) => types[c.type].login(c);
// The connection a login is for, by the login's id.
export const byLogin = (id: string) => connections().find(c => loginOf(c).id === id);
// The connections an instance's runner ticked a login of.
export const reachable = (inst: Instance) => {
  const ticks = runnerOf(inst).logins;
  return connections().filter(c => ticks.some(t => t === loginOf(c).id || t.startsWith(`${loginOf(c).id}:`)));
};

// What a run, as the proxy knows it, has: its instance, its number, the links its connections' answers held, each the name of
// the connection that gave it, and what its calls have cost.
export type CallRun = { inst: Instance; n: number; links: Map<string, string>; cost: number };

// Tests point a host at a stand-in.
export const upstreams: Record<string, string> = {};

const own = (host: string) => [openrouter, exa].find(s => s.host === host && process.env[s.key]);

export const intercepts = (a: CallRun, host: string) =>
  !!own(host) || connections().some(c => types[c.type].serves?.(c, host)) || [...a.links.keys()].some(u => new URL(u).host === host);

const HOP = ['authorization', 'connection', 'host', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

export async function call(a: CallRun, host: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `https://${host}`), method = req.method!, link = a.links.get(url.href), s = link ? undefined : own(host);
  // The runner's own OpenRouter key, where they use it, in place of the server's, never falling back to it.
  const runner = runnerOf(a.inst).by, mine = s === openrouter ? logins(runner).find(l => l.id === 'openrouter' && l.enabled) : undefined;
  const c = link || s ? undefined : connections().find(c => types[c.type].serves?.(c, host));
  const name = link ?? c?.name ?? s?.name ?? host, path = link ? url.origin + url.pathname : url.pathname + url.search;
  // A request that may write, to anything but the server's own services, is logged as it goes too, so a cut leaves it as sent.
  let sent: number | undefined;
  const log = (status: number, bytes: number, more?: object) => a.inst.append('agent', 'call', { run: a.n, name, method, path, status, bytes, ...(sent && { sent }), ...more });
  try {
    // A target such as //elsewhere/… or https://elsewhere/… would take the request, and the credential put in, to another host, and
    // one such as http://HOST/… to it in the clear.
    if (url.origin !== `https://${host}`) throw new HttpError(403, `${host} takes requests for https://${host}, not ${url.origin}`);
    // A runner's own key only while they may lend to the instance, never the server's in its place.
    if (mine) lender(a.inst);
    if (mine?.expired) throw Object.assign(new HttpError(409, `${runner}'s own OpenRouter key is out of credits: they save another, or stop using it, on the Logins page, and the instance carries on`), { login: 'openrouter' });
    if (!link && !c && !s) throw new HttpError(403, `${url.origin + url.pathname} is no link a connection's answer gave this run`);
    // A POST's or PATCH's body, a JSON one, or any to the server's own services, is read whole, for the policy; a JSON body goes on as the JSON it read, as it rewrote
    // it, never as bytes another parser might read otherwise, such as a key twice. Anything else, such as a file's content, streams.
    const isJson = /json/i.test(String(req.headers['content-type']));
    // A file's content, PUT …/content, streams on as its bytes, a JSON file's too.
    const raw = !link && (s || ['POST', 'PATCH'].includes(method) || (method === 'PUT' && isJson && !/\/content$/i.test(url.pathname))) ? Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)) : undefined;
    const json = isJson && raw?.length ? JSON.parse(raw.toString()) : undefined, r = { method, url, headers: req.headers, json, body: raw };
    let out = json, auth: Record<string, string> = {}, as = '', ticks: string[] = [], signoff: number | undefined;
    if (c) {
      const { by, logins } = lender(a.inst), checked = await types[c.type].check!(c, by, ticks = logins, r), login = loginOf(c) as EntraLogin;
      out = checked.json ?? json;
      if (checked.mail) signoff = await approval(a.inst, checked.mail);
      as = use(a.inst, checked.offer).email;
      auth = { authorization: `Bearer ${await token(as, login.id, login.scope)}` };
    }
    if (s) {
      // The key goes in both headers SDKs send one in: Authorization, and x-api-key, as Anthropic's, Pi's among them, and Exa's do.
      out = s.check(r);
      const k = mine ? secret(runner, 'openrouter') : process.env[s.key]!;
      auth = { authorization: `Bearer ${k}`, 'x-api-key': k };
    }
    const body = out === undefined ? raw : Buffer.from(JSON.stringify(out));
    if (!s && !['GET', 'HEAD'].includes(method)) sent = a.inst.append('agent', 'send', { run: a.n, name, method, path }).seq;
    const answer = await forward(`${upstreams[host] ?? url.origin}${url.pathname}${url.search}`, req, res, { auth, body, keep: !link });
    // An answer's links go through for this run; what a service's answer cost, whole or in the last event of its stream that says,
    // adds to the run's as it comes.
    if (c && answer.type.includes('json')) for (const l of await types[c.type].links?.(JSON.parse(answer.text || 'null'), url.pathname, as, ticks) ?? []) a.links.set(new URL(l).href, c.name);
    const cost = !s ? 0 : (answer.text.trimStart().startsWith('{') ? [answer.text] : answer.text.split('\n').filter(l => l.startsWith('data: {')).map(l => l.slice(6)))
      .map(e => s.cost(JSON.parse(e))).findLast(x => x !== undefined) ?? 0;
    a.cost += cost;
    log(answer.status, answer.bytes, s ? { ...(json?.model && { model: json.model }), cost } : signoff ? { signoff } : undefined);
    if (mine && answer.status === 402) {
      saveLogin(runner, { ...mine, expired: true });
      a.inst.append('server', 'expired', { login: 'openrouter', name: 'OpenRouter', runner });
    }
  } catch (e) {
    // A refusal, or an expired login, is the server's answer; anything else, a failure to reach the host.
    const err = e as Error & { status?: number; login?: string }, status = e instanceof HttpError ? err.status! : 502;
    if (err.login) a.inst.append('server', 'expired', { login: err.login, name: byLogin(err.login) ? loginOf(byLogin(err.login)!).name : err.login, runner: runnerOf(a.inst).by });
    log(status, 0, e instanceof HttpError ? { refused: err.message } : { failed: err.message });
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`${err.message}\n`);
  }
}

// Once a sign-off the agent asks for names a mail's recipients, the instance's mail goes out only as an approval binds it: to exactly
// those recipients, to, cc and bcc alike, with exactly those files' bytes attached, each approval once; the call names the approval.
async function approval(inst: Instance, read: () => Promise<Mail | string>): Promise<number | undefined> {
  const asks = inst.log.filter(e => e.op === 'comment' && e.signoff && e.recipients);
  if (!asks.length) return undefined;
  const mail = await read();
  if (typeof mail === 'string') throw new HttpError(403, `${mail}, as a sign-off binds this instance's mail`);
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const fits = asks.filter(e => same([...new Set(e.recipients as string[])], [...new Set(mail.to)]) && same(((e.attach ?? []) as { sha256: string }[]).map(f => f.sha256), mail.sums));
  const answers = fits.map(e => inst.log.find(s => s.op === 'signoff' && s.thread === e.thread && s.seq > e.seq));
  const ok = answers.find(s => s?.approved && !inst.log.some(c => c.op === 'call' && c.signoff === s.seq && (c.status as number) < 300));
  if (ok) return ok.seq;
  const t = fits.at(-1)?.thread;
  throw new HttpError(403, !fits.length ? `no sign-off binds mail to ${mail.to.join(', ')} with ${mail.sums.length || 'no'} attachment${mail.sums.length === 1 ? '' : 's'} of those bytes: once one names recipients, this instance's mail goes only as an approval binds it, to exactly its recipients with exactly its files`
    : answers.some(s => s?.approved) ? `${t}'s approved mail went out already: ask again for another` : answers.some(Boolean) ? `${t}'s sign-off was rejected` : `${t}'s sign-off waits on its runner`);
}

// The request goes on as it came, but for its credential and the hop's own headers; the answer comes back as it is, and, where
// it's kept and is JSON or a stream of events, as text too, for what it holds.
function forward(target: string, req: IncomingMessage, res: ServerResponse, o: { auth: Record<string, string>; body?: Buffer; keep: boolean }) {
  return new Promise<{ status: number; bytes: number; type: string; text: string }>((ok, fail) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.includes(k)));
    const up = (target.startsWith('https:') ? httpsRequest : httpRequest)(target, {
      method: req.method, headers: { ...headers, ...(o.body && { 'content-length': String(o.body.length) }), ...o.auth },
    }, r => {
      res.writeHead(r.statusCode!, Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.includes(k))));
      const kept: Buffer[] = [], type = String(r.headers['content-type']), keep = o.keep && /json|event-stream/.test(type);
      let bytes = 0;
      r.on('data', (b: Buffer) => { bytes += b.length; if (keep) kept.push(b); });
      r.pipe(res);
      r.on('end', () => {
        const raw = Buffer.concat(kept), enc = r.headers['content-encoding'];
        const text = keep ? (enc === 'gzip' ? gunzipSync(raw) : enc === 'deflate' ? inflateSync(raw) : enc === 'br' ? brotliDecompressSync(raw) : raw).toString() : '';
        ok({ status: r.statusCode!, bytes, type, text });
      });
      r.on('error', fail);
    });
    up.on('error', fail);
    if (o.body) up.end(o.body);
    else req.pipe(up);
  });
}
