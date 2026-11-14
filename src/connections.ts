import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createCipheriv, createDecipheriv, createHash, randomBytes, type Hash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { brotliDecompressSync, createBrotliDecompress, createGunzip, createInflate, gunzipSync, inflateSync } from 'node:zlib';
import { HttpError, type Instance } from './store.ts';
import { lookup } from 'node:dns/promises';
import { getDomain } from 'tldts';
import { isPrivate, key, readJson, tree, writeJson } from './system.ts';
import { recordCost } from './costs.ts';
import type { EntraLogin } from './auth.ts';
import { token } from './entra.ts';
import { lender, logins, runnerOf, saveLogin, secret, use, type Offer } from './logins.ts';
import graph from './connections/graph.ts';
import databricks from './connections/databricks.ts';
import service from './connections/service.ts';
import * as openrouter from './connections/openrouter.ts';
import * as exa from './connections/exa.ts';

// Connections: the outside systems runs reach, which admins keep with rf connection set NAME TYPE: each a name, a type and the
// type's settings, in .rf/connections.json. A type is a module under connections/, saying how its person connects and what that
// login offers runs; for a system reached over HTTPS, the hosts it serves, which requests to them may go and the links its answers
// hold.
//
// A run reaches those hosts as they are, with real tools and the vendors' own docs: the sandbox's proxy ends TLS for them, as the
// host, with rollforward's own certificate authority (ca.ts), which runs trust. Each request is checked against the type's policy
// and the instance's ticks, has its Authorization replaced by the runner's token or the deployment service's key, and goes on; the answer comes back as it is, and
// a `call` entry logs it. A link an answer held, such as an upload session's, or redirected to, goes through for that run, as it
// is, with no credential added, while the offer that allowed the answer may still be used. A refusal is a plain 403 with the reason, logged too.
//
// The server's own connections, OpenRouter and Exa, each a module under connections/ too, are every run's while the server has
// its key, which no person lends: a request is checked against its policy and has the key put in for the run's stand-in, and what
// its answer cost adds to the run's.

export type Connection = { name: string; type: string; [setting: string]: any };
export type Request = { method: string; url: URL; headers: Record<string, string | string[] | undefined>; json?: any; body?: Buffer; target?: string };
export type Type = {
  settings(input: Record<string, unknown>): Record<string, unknown>;
  // Its person's login: Entra with its scope, or a credential-free service with its offers.
  login(c: Connection): (EntraLogin | { id: string; kind: string; name: string; scope?: undefined; offers: Offer[] });
  hosts?(c: Connection): string[];
  // The offer a request needs ticked, its JSON body as it goes on, if the type rewrote it, and the origin where its answer's
  // Location, as a redirect's, is a link; or a refusal.
  // A request that sends mail also reads, on asking, what goes, its recipients and its attachments' sha256s, or why that can't be read.
  check?(c: Connection, runner: string, ticks: string[], r: Request): Promise<{ offer: string; json?: unknown; redirect?: string }>;
  links?(answer: any, path: string, email: string, ticks: string[]): string[] | Promise<string[]>;
  // What a run's environment holds for it, given the instance's ticks.
  env?(c: Connection, ticks: string[]): Record<string, string>;
};
export const types: Record<string, Type> = { graph, databricks, service };

export const connections = (): Connection[] => Object.entries(readJson<Record<string, any>>('connections.json', {})).map(([name, c]) => ({ name, ...c }));

// Whether a host, exact or *.domain for any name under the domain, covers another, which may be either too.
export const covers = (pattern: string, host: string) => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));
export const reached = (w: { url: string; hosts: string[] }) => [new URL(w.url).hostname, ...w.hosts];
// Whether a host is at an internal address, as an intranet's is; one that doesn't resolve isn't.
export const resolvesInternal = async (h: string) => (await lookup(h, { all: true }).catch(() => [])).some(isPrivate);

// The hosts at internal addresses an admin let websites reach, as an intranet's ERP and its sign-on: once each, for everyone's, so any
// person's website at one, or that allows one, reaches it with no admin again; .rf/internal.json, by host, who let it and when.
export const letIn = () => readJson<Record<string, { by: string; at: string }>>('internal.json', {});
export function setLetIn(hosts: string[], by: string, let_: boolean) {
  const all = letIn(), at = new Date().toISOString();
  for (const h of hosts) if (let_) all[h] ??= { by, at }; else delete all[h];
  writeJson('internal.json', all);
}

// rollforward's own hosts, and its browser and tunnel services', which no website reaches, nor an open sign-in, as a connection's
// hosts aren't.
const rollforward = () => [process.env.RF_PUBLIC_URL, process.env.RF_BROWSER_URL ?? 'http://127.0.0.1:8797', process.env.RF_TUNNEL_URL, process.env.RF_TUNNEL_PROXY].flatMap(u => URL.parse(u ?? '')?.hostname || []);
export const except = () => [...rollforward(), ...connections().flatMap(c => types[c.type].hosts?.(c) ?? [])];

// What a website may reach (browsers.ts): never rollforward's own host, or a host a connection serves, so that no website goes around
// its grants or settings; a wildcard within one registrable domain, the public suffixes being the Public Suffix List's, its private ones
// too; and never an internal address, which the browser refuses it too, unless an admin lets the website, or every website, reach it,
// by exact hosts.
export async function checkHost(h: string, internal: boolean) {
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new HttpError(400, `${h}: a host, such as sso.example.com, or *.example.com for any name under it`);
  const base = h.replace(/^\*\./, '');
  if (h !== base && !getDomain(base, { allowPrivateDomains: true })) throw new HttpError(400, `${h}: a wildcard stays within one registrable domain, such as *.example.com`);
  if (rollforward().some(o => covers(h, o))) throw new HttpError(400, `${h} is rollforward's own: no website reaches it`);
  const other = connections().find(c => types[c.type].hosts?.(c).some(host => covers(h, host) || covers(host, h)));
  if (other) throw new HttpError(400, `${h} is ${other.name}'s: no website reaches it`);
  if (!internal && h === base && !letIn()[h] && await resolvesInternal(h)) throw new HttpError(400, `${h} is at an internal address: a website reaches one only where an admin lets it`);
}

export async function setConnection(name: string, input: Record<string, unknown>, by: string): Promise<Connection> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new HttpError(400, 'a connection\'s name is lowercase letters, digits and dashes');
  if (name === 'print') throw new HttpError(409, "print is the runs' own print browser, $RF_BROWSERS/print: name it otherwise");
  const type = types[String(input.type)];
  if (!type) throw new HttpError(400, `type: one of ${Object.keys(types).join(', ')}`);
  const settings = type.settings(input);
  const all = readJson<Record<string, any>>('connections.json', {});
  let sealed = input.type === 'service' ? all[name]?.key : undefined;
  if (input.type === 'service' && input.key !== undefined) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key('seal.key'), iv).setAAD(Buffer.from(`service\n${name}`));
    const body = Buffer.concat([cipher.update(String(input.key), 'utf8'), cipher.final()]);
    sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  all[name] = { type: input.type, ...settings, ...(sealed && { key: sealed }), updated_by: by, updated_at: new Date().toISOString() };
  writeJson('connections.json', all);
  const { key: _key, ...saved } = all[name];
  return { name, ...saved };
}

// People's logins to a connection removed stay theirs to sign out of; no run can use them.
export function removeConnection(name: string) {
  const all = readJson<Record<string, any>>('connections.json', {});
  if (!all[name]) throw new HttpError(404, `no connection ${name}`);
  delete all[name];
  writeJson('connections.json', all);
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
// the connection that gave it and the offer that allowed it, and what its calls have cost.
export type CallRun = { inst: Instance; n: number; links: Map<string, { name: string; offer: string }>; cost: number; estimated?: boolean };

// Tests point a host at a stand-in.
export const upstreams: Record<string, string> = {};

const own = (host: string) => [openrouter, exa].find(s => s.host === host && process.env[s.key]);

export const intercepts = (a: CallRun, host: string) =>
  !!own(host) || connections().some(c => types[c.type].hosts?.(c).some(h => covers(h, host))) || [...a.links.keys()].some(u => new URL(u).host === host);

const HOP = ['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

// The sends going: each logged as sent, its answer not yet, and in-flight OpenRouter/Exa calls recording their cost.
const sending = new Set<IncomingMessage>();
const inFlight = new WeakMap<CallRun, Set<Promise<void>>>();
const abortHooks = new WeakMap<CallRun, Set<() => void>>();

export const hasCalls = (a: CallRun) => (inFlight.get(a)?.size ?? 0) > 0;
export function abortCalls(a: CallRun) {
  for (const fn of abortHooks.get(a) ?? []) fn();
}
export async function drainCalls(a: CallRun, ms = 5000) {
  const set = inFlight.get(a);
  if (!set?.size) return;
  await Promise.race([Promise.allSettled([...set]), new Promise(ok => setTimeout(ok, ms))]);
}

// Once the sends going are answered and logged, or `ms` on, as a stop waits (server.ts).
export async function answered(ms: number) {
  for (const until = Date.now() + ms; sending.size && Date.now() < until;) await new Promise(ok => setTimeout(ok, 100));
}

function parseEvents(text: string): any[] {
  const trimmed = text.trimStart();
  const raw = trimmed.startsWith('{') ? [trimmed]
    : text.split(/\r?\n/).filter(l => /^data:\s*\{/.test(l)).map(l => l.replace(/^data:\s*/, ''));
  const out: any[] = [];
  for (const s of raw) try { out.push(JSON.parse(s)); } catch {}
  return out;
}

const GEN_RETRIES_MS = [150, 400];
async function generationCost(genId: string, apiKey: string): Promise<number | undefined> {
  if (!apiKey) return undefined;
  const base = upstreams['openrouter.ai'] ?? 'https://openrouter.ai';
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}/api/v1/generation?id=${encodeURIComponent(genId)}`, {
        headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(4000),
      });
      if (r.ok) {
        const d = ((await r.json()) as any)?.data;
        const c = d?.total_cost ?? d?.usage;
        return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
      }
      if (r.status !== 404 || i >= GEN_RETRIES_MS.length) return undefined;
    } catch {
      return undefined;
    }
    await new Promise(ok => setTimeout(ok, GEN_RETRIES_MS[i]));
  }
}

async function resolveCost(
  s: typeof openrouter | typeof exa, method: string, path: string, reqJson: any,
  status: number, headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  type: string, events: any[], bytes: number, cut: boolean, apiKey: string,
): Promise<{ cost: number; estimated: boolean }> {
  const nonBillable = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (s === openrouter && nonBillable) return { cost: 0, estimated: false };
  const inline = events.map(s.cost).findLast(x => x !== undefined);
  if (inline !== undefined) return { cost: inline, estimated: false };
  if (nonBillable) return { cost: 0, estimated: false };
  const streamed = type.includes('event-stream');
  if (s === openrouter) {
    const genId = openrouter.generationId(headers, events);
    if (genId && (status < 400 || cut || streamed || !path.endsWith('/images'))) {
      const charged = await generationCost(genId, apiKey);
      if (charged !== undefined) return { cost: charged, estimated: false };
    }
    if (status >= 400 && !cut && !streamed) return { cost: 0, estimated: false };
    return { cost: openrouter.estimate(path, reqJson, events, bytes), estimated: true };
  }
  if (status >= 400 && !cut && !streamed) return { cost: 0, estimated: false };
  return { cost: exa.estimate(path, reqJson), estimated: true };
}

export async function serverCall(
  serviceName: 'openrouter' | 'exa', path: string, json: Record<string, any>,
  cause: { kind: 'website-check' | 'try'; site?: string; person: string }, timeoutMs = 120_000,
): Promise<{ ok: boolean; status: number; data: any; cost: number; estimated: boolean }> {
  const s = serviceName === 'openrouter' ? openrouter : exa;
  const apiKey = process.env[s.key] ?? '';
  const url = new URL(path, `https://${s.host}`), raw = Buffer.from(JSON.stringify(json));
  const out = s.check({ method: 'POST', url, headers: { 'content-type': 'application/json' }, json, body: raw }) ?? json;
  const target = `${upstreams[s.host] ?? `https://${s.host}`}${url.pathname}${url.search}`;
  const redact = (msg: string) => apiKey ? msg.replaceAll(apiKey, '[redacted]') : msg;
  let r: Response, text = '';
  try {
    r = await fetch(target, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(out),
    });
    text = await r.text();
  } catch (e) {
    throw new Error(redact((e as Error).message));
  }
  const type = r.headers.get('content-type') ?? '', events = parseEvents(text);
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const { cost, estimated } = await resolveCost(s, 'POST', url.pathname, json, r.status, headers, type, events, Buffer.byteLength(text), false, apiKey);
  if (r.status < 400 || cost > 0 || estimated) {
    recordCost({
      at: new Date().toISOString(), by: 'server', service: serviceName, kind: cause.kind,
      ...(cause.site && { site: cause.site }), person: cause.person, cost, ...(estimated && { estimated: true }),
    });
  }
  return { ok: r.ok, status: r.status, data: events.at(-1), cost, estimated };
}

export async function call(a: CallRun, host: string, req: IncomingMessage, res: ServerResponse) {
  const method = req.method!;
  let name = host, path = req.url!;
  // A request that may write, to anything but the server's own services, is logged as it goes too, so a cut leaves it as sent,
  // and a stop waits for its answer.
  let sent: number | undefined, digest: { hash: Hash; size: number } | undefined;
  const log = (status: number, bytes: number, more?: object) => {
    a.inst.append('agent', 'call', { run: a.n, name, method, path, status, bytes, ...(sent && { sent }), ...(digest && { sha256: digest.hash.copy().digest('hex'), size: digest.size }), ...more });
    sending.delete(req);
  };
  try {
    const url = URL.parse(req.url!, `https://${host}`);
    if (!url) throw new HttpError(403, `invalid request target: ${req.url}`);
    const link = a.links.get(url.href), s = link ? undefined : own(host);
    // The runner's own OpenRouter key, where they use it, in place of the server's, never falling back to it.
    const { by: runner, logins: ticked } = runnerOf(a.inst), mine = s === openrouter ? logins(runner).find(l => l.id === 'openrouter' && l.enabled) : undefined;
    // Of the connections that take the host, the one a tick names it under, as a Databricks workspace's warehouse does, or the first.
    const serving = link || s ? [] : connections().filter(c => types[c.type].hosts?.(c).some(h => covers(h, host)));
    const c = serving.find(c => ticked.some(t => t.startsWith(`${loginOf(c).id}:${host}/`))) ?? serving[0];
    name = link?.name ?? c?.name ?? s?.name ?? host;
    path = link ? url.origin + url.pathname : url.pathname + url.search;
    // A target such as //elsewhere/… or https://elsewhere/… would take the request, and the credential put in, to another host, and
    // one such as http://HOST/… to it in the clear.
    if (url.origin !== `https://${host}`) throw new HttpError(403, `${host} takes requests for https://${host}, not ${url.origin}`);
    if (method === 'TRACE') throw new HttpError(403, 'a TRACE would echo the credential put in');
    // A runner's own key only while they may lend to the instance, never the server's in its place.
    if (mine) lender(a.inst, a.n);
    if (link) use(a.inst, a.n, link.offer);
    if (mine?.expired) throw Object.assign(new HttpError(409, `${runner}'s own OpenRouter key is out of credits: they save another, or stop using it, on the Logins page, and the instance carries on`), { login: 'openrouter' });
    if (!link && !c && !s) throw new HttpError(403, `${url.origin + url.pathname} is no link a connection's answer gave this run`);
    // A POST's or PATCH's body, a JSON one, or any to the server's own services, is read whole, for the policy; a JSON body goes on as the JSON it read, as it rewrote
    // it, never as bytes another parser might read otherwise, such as a key twice. A deployment's service takes any body as bytes,
    // streamed, as a file's content is.
    const isJson = /json/i.test(String(req.headers['content-type']));
    // A file's content, PUT …/content, streams on as its bytes, a JSON file's too.
    const raw = c?.type !== 'service' && !link && (s || ['POST', 'PATCH'].includes(method) || (method === 'PUT' && isJson && !/\/content$/i.test(url.pathname))) ? Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)) : undefined;
    const json = isJson && raw?.length ? JSON.parse(raw.toString()) : undefined, r = { method, url, headers: req.headers, json, body: raw, target: req.url! };
    let out = json, auth: Record<string, string> = {}, as = '', ticks: string[] = [], redirect: string | undefined, offer = '';
    if (c) {
      const { by, logins } = lender(a.inst, a.n), checked = await types[c.type].check!(c, by, ticks = logins, r), login = loginOf(c) as EntraLogin;
      out = checked.json ?? json;
      redirect = checked.redirect;
      as = use(a.inst, a.n, offer = checked.offer).email;
      if (c.type === 'service') {
        let k = process.env[`RF_SERVICE_KEY_${c.name.toUpperCase().replaceAll('-', '_')}`];
        if (c.key) {
          const b = Buffer.from(c.key, 'base64'), decipher = createDecipheriv('aes-256-gcm', key('seal.key'), b.subarray(0, 12)).setAAD(Buffer.from(`service\n${c.name}`));
          decipher.setAuthTag(b.subarray(12, 28));
          k = Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
        }
        if (!k) throw new HttpError(502, `${c.name}: set --key or RF_SERVICE_KEY_${c.name.toUpperCase().replaceAll('-', '_')}`);
        auth = { authorization: `Bearer ${k}`, 'x-rf-runner': as, 'x-rf-instance': a.inst.id, 'x-rf-run': String(a.n), 'x-rf-series': a.inst.seriesId, 'x-rf-workspace': a.inst.seriesId ? tree().series[a.inst.seriesId].workspace : '' };
      } else auth = { authorization: `Bearer ${await token(as, login.id, login.scope)}` };
    }
    let apiKey = '';
    if (s) {
      // The key goes in both headers SDKs send one in: Authorization, and x-api-key, as Anthropic's, Pi's among them, and Exa's do.
      out = s.check(r);
      apiKey = mine ? secret(runner, 'openrouter') : process.env[s.key]!;
      auth = { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
    }
    const body = out === undefined ? raw : Buffer.from(JSON.stringify(out));
    if (!s && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (c?.type === 'service') digest = { hash: createHash('sha256'), size: 0 };
      sent = a.inst.append('agent', 'send', { run: a.n, name, method, path }).seq;
      sending.add(req);
    } else if (s) sending.add(req);
    const doneWork = Promise.withResolvers<void>();
    if (s) {
      let set = inFlight.get(a);
      if (!set) inFlight.set(a, set = new Set());
      set.add(doneWork.promise);
    }
    const registerAbort = (fn: () => void) => {
      let set = abortHooks.get(a);
      if (!set) abortHooks.set(a, set = new Set());
      set.add(fn);
      return () => set!.delete(fn);
    };
    try {
      // A Location where the check lets one go, as a redirect's, is a link for this run before the run can follow it.
      const answer = await forward(`${c?.type === 'service' ? c.url : upstreams[host] ?? url.origin}${url.pathname}${url.search}`, req, res, {
        auth, body, digest, keep: !link && c?.type !== 'service', service: !!s, registerAbort,
        location: to => { const l = URL.parse(to); if (l && l.origin === redirect) a.links.set(l.href, { name, offer }); },
      });
      // An answer's links go through for this run; what a service's answer cost, whole, in its stream's events, from OpenRouter's
      // generation endpoint, or estimated where none could be learned, adds to the run's as it comes.
      if (c && types[c.type].links && answer.type.includes('json')) for (const l of await types[c.type].links?.(JSON.parse(answer.text || 'null'), url.pathname, as, ticks) ?? []) a.links.set(new URL(l).href, { name, offer });
      const { cost, estimated } = !s ? { cost: 0, estimated: false }
        : await resolveCost(s, method, url.pathname, json, answer.status, answer.headers, answer.type, answer.events, answer.bytes, !!answer.cut, apiKey);
      a.cost += cost;
      if (estimated) a.estimated = true;
      if (s && (cost > 0 || estimated)) {
        const at = new Date().toISOString(), svc = s === openrouter ? 'openrouter' : 'exa';
        if (a.inst.id === 'try' && a.n === 0) {
          recordCost({ at, by: 'server', service: svc, kind: 'try', person: runner, cost, ...(estimated && { estimated: true }), ...(mine && { own: true }) });
        } else if (a.n > 0) {
          recordCost({ at, service: svc, inst: a.inst.id, run: a.n, person: runner, cost, ...(estimated && { estimated: true }), ...(mine && { own: true }) });
        }
      }
      log(answer.status, answer.bytes, s ? { ...(json?.model && { model: json.model }), cost, ...(estimated && { estimated: true }) } : answer.incomplete ? { incomplete: true } : undefined);
      if (mine && answer.status === 402) {
        saveLogin(runner, { ...mine, expired: true });
        a.inst.append('server', 'expired', { run: a.n, login: 'openrouter', name: 'OpenRouter', runner });
      }
    } finally {
      sending.delete(req);
      inFlight.get(a)?.delete(doneWork.promise);
      doneWork.resolve();
    }
  } catch (e) {
    // A refusal, or an expired login, is the server's answer; anything else, a failure to reach the host.
    const err = e as Error & { status?: number; login?: string }, status = e instanceof HttpError ? err.status! : 502;
    const msg = [process.env.OPENROUTER_API_KEY, process.env.EXA_API_KEY].reduce((m, k) => k ? m.replaceAll(k, '[redacted]') : m, err.message);
    if (err.login) a.inst.append('server', 'expired', { run: a.n, login: err.login, name: byLogin(err.login) ? loginOf(byLogin(err.login)!).name : err.login, runner: runnerOf(a.inst).by });
    log(status, 0, e instanceof HttpError ? { refused: msg } : { failed: msg });
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`${msg}\n`);
  }
}

// The request goes on as it came, but for its credential and the hop's own headers; the answer comes back as it is, its Location
// told first, and, where it's kept, JSON as text or an event stream's data events scanned as chunks pass without buffering the
// stream. A run gone before its answer on a non-service write leaves it read to its end; on an OpenRouter or Exa stream, closing
// cancels the upstream stream so its partial cost can be looked up.
function forward(target: string, req: IncomingMessage, res: ServerResponse, o: {
  auth: Record<string, string>; body?: Buffer; digest?: { hash: Hash; size: number }; keep: boolean;
  service?: boolean; registerAbort?: (fn: () => void) => () => void; location(to: string): void;
}) {
  return new Promise<{ status: number; bytes: number; type: string; text: string; events: any[]; headers: IncomingHttpHeaders; cut?: boolean; incomplete?: boolean }>((ok, fail) => {
    // X-RF- headers are the server's, X_RF_ too, which some servers read as the same.
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'authorization' && k !== 'host' && !HOP.includes(k) && !/^x[-_]rf[-_]/.test(k)));
    let settled = false, unregister: (() => void) | undefined;
    const done = (v: { status: number; bytes: number; type: string; text: string; events: any[]; headers: IncomingHttpHeaders; cut?: boolean; incomplete?: boolean }) => {
      if (settled) return;
      settled = true;
      unregister?.();
      ok(v);
    };
    const die = (e: Error) => {
      if (settled) return;
      settled = true;
      unregister?.();
      fail(e);
    };
    const up = (target.startsWith('https:') ? httpsRequest : httpRequest)(target, {
      // A chunked body goes on chunked: Node sends a GET's, DELETE's or OPTIONS' otherwise unframed, as a request of its own.
      method: req.method, headers: { ...headers, ...(o.body ? { 'content-length': String(o.body.length) } : req.headers['transfer-encoding'] && { 'transfer-encoding': 'chunked' }), ...o.auth },
    }, r => {
      if (r.headers.location) o.location(r.headers.location);
      res.writeHead(r.statusCode!, Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.includes(k))));
      const type = String(r.headers['content-type']), isSse = type.includes('event-stream'), isJson = /json/i.test(type);
      const kept: Buffer[] = [], events: any[] = [], enc = r.headers['content-encoding'];
      let bytes = 0, cut = false, carry = '';
      const pushLine = (line: string) => {
        if (!/^data:\s*\{/.test(line)) return;
        try { events.push(JSON.parse(line.replace(/^data:\s*/, ''))); } catch {}
      };
      const feedText = (chunk: string) => {
        const parts = (carry + chunk).split(/\r?\n/);
        carry = parts.pop()!;
        for (const l of parts) pushLine(l);
      };
      const decoder = o.keep && isSse ? new StringDecoder('utf8') : undefined;
      const unzip = decoder && (enc === 'gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : undefined);
      if (unzip) {
        unzip.on('data', (b: Buffer) => feedText(decoder!.write(b)));
        unzip.on('error', () => {});
      }
      r.on('data', (b: Buffer) => {
        bytes += b.length;
        if (decoder) {
          if (unzip) unzip.write(b);
          else feedText(decoder.write(b));
        } else if (o.keep && isJson) kept.push(b);
      });
      const finishAnswer = () => {
        if (decoder) {
          if (!unzip) feedText(decoder.end());
          if (carry) { pushLine(carry); carry = ''; }
        }
        let text = '';
        if (o.keep && isJson && kept.length) {
          const raw = Buffer.concat(kept);
          try {
            text = (enc === 'gzip' ? gunzipSync(raw) : enc === 'deflate' ? inflateSync(raw) : enc === 'br' ? brotliDecompressSync(raw) : raw).toString();
          } catch {
            text = raw.toString();
          }
          const trimmed = text.trimStart();
          if (trimmed.startsWith('{')) try { events.push(JSON.parse(trimmed)); } catch {}
        }
        return { status: r.statusCode!, bytes, type, text, events, headers: r.headers, ...(cut && { cut: true }) };
      };
      const abortStream = () => {
        if (r.readableEnded || settled) return;
        cut = true;
        up.destroy();
        res.destroy();
        done(finishAnswer());
      };
      unregister?.();
      if (o.service && isSse) unregister = o.registerAbort?.(abortStream);
      if (res.closed) {
        if (o.service && isSse) return abortStream();
        r.resume();
      } else {
        r.pipe(res).once('close', () => {
          if (o.service && isSse && !r.readableEnded) abortStream();
          else r.resume();
        });
      }
      r.on('end', () => {
        const answer = finishAnswer();
        if (!o.digest || req.readableEnded) return done(answer);
        const finish = () => {
          req.off('end', finish);
          req.off('error', finish);
          req.socket.off('close', finish);
          const incomplete = !req.readableEnded;
          if (incomplete) up.destroy();
          done({ ...answer, ...(incomplete && { incomplete }) });
        };
        req.once('end', finish);
        req.once('error', finish);
        req.socket.once('close', finish);
        req.resume();
      });
      r.on('error', e => {
        if (o.service) {
          cut = true;
          res.destroy();
          done(finishAnswer());
        } else die(e);
      });
    });
    if (o.service) unregister = o.registerAbort?.(() => up.destroy(new Error('run stopped')));
    up.on('error', e => { if (!settled) die(e); });
    if (o.body) up.end(o.body);
    else {
      if (o.digest) req.on('data', (b: Buffer) => { o.digest!.hash.update(b); o.digest!.size += b.length; });
      req.on('error', e => up.destroy(e));
      if (o.digest) up.once('close', () => req.resume());
      req.pipe(up);
    }
  });
}
