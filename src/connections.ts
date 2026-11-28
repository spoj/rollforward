import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, type Hash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { brotliDecompressSync, createBrotliDecompress, createGunzip, createInflate, createZstdDecompress, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { HttpError, type Instance } from './store.ts';
import { lookup } from 'node:dns/promises';
import { getDomain } from 'tldts';
import { act, changes, isPrivate, key, readJson, tree, writeJson } from './system.ts';
import { recordCost } from './costs.ts';
import { buildApiRequestDescriptor, MAX_PREFIX_BYTES, parseSemanticMethods, type SemanticAction } from './extract.ts';
import { compactDecision, defaultExecPolicy, loadExecPolicyConfig, POLICY_VERSION, type CompactPolicyDecision } from './execpolicy.ts';
import { sanitizeUrl, scrubText } from './redact.ts';
import type { EntraLogin } from './auth.ts';
import { token } from './entra.ts';
import { lender, loginGeneration, logins, saveLogin, secret, use, type Offer } from './logins.ts';
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
// is, with no credential added, while the offer that allowed the answer may still be used. A refusal is a 403 with the reason (JSON for JSON APIs, plain text otherwise), logged too.
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
  // Location is a link (true accepts any Location, still granting only its exact URL); or a refusal.
  // A request that sends mail also reads, on asking, what goes, its recipients and its attachments' sha256s, or why that can't be read.
  // Async policy and link work checkpoints before each new outbound request, including after awaiting credentials.
  check?(c: Connection, runner: string, ticks: string[], r: Request, checkpoint: () => void): Promise<{ offer: string; json?: unknown; redirect?: string | true; pathname?: string }> | { offer: string; json?: unknown; redirect?: string | true; pathname?: string };
  links?(answer: any, path: string, email: string, ticks: string[], checkpoint: () => void): Array<string | { url: string; kind: 'upload_session' | 'download' | 'redirect' }> | Promise<Array<string | { url: string; kind: 'upload_session' | 'download' | 'redirect' }>>;
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
// The connections allowed by the current consent, or the narrower run lease.
export const reachable = (inst: Instance, run?: number) => {
  const ticks = lender(inst, run).logins;
  return connections().filter(c => ticks.some(t => t === loginOf(c).id || t.startsWith(`${loginOf(c).id}:`)));
};

// What a run, as the proxy knows it, has: its instance, its number, the links its connections' answers held, each the name of
// the connection that gave it and the offer that allowed it, and what its calls have cost.
export type CallRun = { inst: Instance; n: number; runner: string; links: Map<string, { name: string; offer: string }>; cost: number; estimated?: boolean; stopped?: boolean };
const linkProvenanceByRun = new WeakMap<CallRun, Map<string, { sourceType?: string; linkKind?: 'upload_session' | 'download' | 'redirect' }>>();
function recordLinkProvenance(a: CallRun, href: string, prov: { sourceType?: string; linkKind?: 'upload_session' | 'download' | 'redirect' }) {
  let map = linkProvenanceByRun.get(a);
  if (!map) linkProvenanceByRun.set(a, map = new Map());
  map.set(href, prov);
}

// Tests point a host at a stand-in.
export const upstreams: Record<string, string> = {};

const own = (host: string) => [openrouter, exa].find(s => s.host === host && process.env[s.key]);

export const intercepts = (a: CallRun, host: string): 'intercept' | 'deny' | 'passthrough' => {
  if (own(host) || [...a.links.keys()].some(u => new URL(u).host === host)) return 'intercept';
  const conns = connections();
  if (conns.some(c => (types[c.type].hosts?.(c) ?? []).some(h => !h.startsWith('*.') && h === host))) return 'intercept';
  const wildcardMatches = conns.filter(c => (types[c.type].hosts?.(c) ?? []).some(h => h.startsWith('*.') && covers(h, host)));
  if (!wildcardMatches.length) return 'passthrough';
  let ticks: string[] = [];
  try { ticks = lender(a.inst, a.n).logins; } catch {}
  return wildcardMatches.some(c => ticks.some(t => t.startsWith(`${loginOf(c).id}:${host}/`))) ? 'intercept' : 'deny';
};

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

async function providerText(r: Response): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const b of r.body ?? []) {
    if ((bytes += b.length) > 8 * 1024 * 1024) throw new Error('provider response exceeds 8 MiB');
    chunks.push(Buffer.from(b));
  }
  return Buffer.concat(chunks).toString();
}

const GEN_RETRIES_MS = [150, 400];
async function generationCost(genId: string, apiKey: string): Promise<number | undefined> {
  if (!apiKey) return undefined;
  const base = upstreams['openrouter.ai'] ?? 'https://openrouter.ai', signal = AbortSignal.timeout(4000);
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}/api/v1/generation?id=${encodeURIComponent(genId)}`, {
        headers: { authorization: `Bearer ${apiKey}` }, signal,
      });
      if (r.ok) {
        const d = JSON.parse(await providerText(r))?.data;
        const c = d?.total_cost ?? d?.usage;
        return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
      }
      await r.body?.cancel();
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
  cause: { kind: 'website-check' | 'try'; site?: string; person: string }, timeoutMs = 120_000, checkpoint?: () => void,
): Promise<{ ok: boolean; status: number; data: any; cost: number; estimated: boolean }> {
  const s = serviceName === 'openrouter' ? openrouter : exa;
  const apiKey = s === openrouter ? serverKey() : process.env[s.key] ?? '';
  const url = new URL(path, `https://${s.host}`), raw = Buffer.from(JSON.stringify(json));
  const out = s.check({ method: 'POST', url, headers: { 'content-type': 'application/json' }, json, body: raw }) ?? json;
  const target = `${upstreams[s.host] ?? `https://${s.host}`}${url.pathname}${url.search}`;
  const redact = (msg: string) => apiKey ? msg.replaceAll(apiKey, '[redacted]') : msg;
  let r: Response | undefined, text = '', failed: Error | undefined, abortedBetweenAttempts = false;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let attempt = 0; ; attempt++) {
      checkpoint?.();
      r = await fetch(target, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(out),
      });
      if (s === openrouter && r.status === 429) {
        const delay = openrouter.retryDelayMs(attempt, r.headers.get('retry-after'));
        if (delay !== undefined) {
          await r.body?.cancel().catch(() => {});
          if (await openrouter.sleepAbortable(delay, signal)) {
            checkpoint?.();
            continue;
          }
          abortedBetweenAttempts = true;
          signal.throwIfAborted();
        }
      }
      break;
    }
    text = await providerText(r);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    failed = new Error(redact((e as Error).message));
  }
  const type = r?.headers.get('content-type') ?? '', events = parseEvents(text);
  const headers: Record<string, string> = {};
  r?.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  if (s === openrouter && r && !failed) keyOut(apiKey, r.status, events.at(-1), 'POST');
  const { cost, estimated } = abortedBetweenAttempts
    ? { cost: 0, estimated: false }
    : await resolveCost(s, 'POST', url.pathname, json, r?.status ?? 502, headers, type, events, Buffer.byteLength(text), !!failed, apiKey);
  if ((!failed && r!.status < 400) || cost > 0 || estimated) {
    recordCost({
      at: new Date().toISOString(), by: 'server', service: serviceName, kind: cause.kind,
      ...(cause.site && { site: cause.site }), person: cause.person, cost, ...(estimated && { estimated: true }),
    });
  }
  if (failed) throw Object.assign(failed, { cost, estimated });
  return { ok: r!.ok, status: r!.status, data: events.at(-1), cost, estimated };
}

export type CreditError = { at: string; message: string };
export type KeyInfo = {
  usage: number;
  usage_daily: number | null;
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  fetched_at: string;
  low_credit: boolean;
  // Which of the server's keys calls use: OPENROUTER_API_KEY, or OPENROUTER_FALLBACK_KEY.
  key?: 'primary' | 'fallback';
  // What all the server's keys spent today, if OpenRouter said for each.
  usage_daily_all?: number | null;
  // Account-wide 402 credit exhaustion latched from a shared-key call, cleared on the next billable 2xx.
  credit_error?: CreditError;
};

// The server's OpenRouter keys: OPENROUTER_API_KEY, such as one with a daily limit, and OPENROUTER_FALLBACK_KEY, such as a monthly
// one, which calls use while the first has under RF_KEY_SWITCH_USD (50) left, or has answered 403 openrouter_key_limit, until a
// check finds its credit back, as once its limit resets. Account-wide 402 credit exhaustion never switches keys; instead it latches
// credit_error for admins until a shared-key billable call succeeds. Each key's state is OpenRouter's, fetched at most every
// RF_KEY_TTL_MS (3m), and just after each UTC midnight, when its daily limits reset (refreshKeys()).
type KeyState = { info: KeyInfo | null; at: number; inFlight: Promise<KeyInfo | null> | null };
const keyStates = new Map<string, KeyState>(), spent = new Set<string>();
let using: 'primary' | 'fallback' = 'primary', creditError: CreditError | null = null;
const switchUsd = () => Number(process.env.RF_KEY_SWITCH_USD ?? 50);
export const serverKeys = () => [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_FALLBACK_KEY].filter((k): k is string => !!k);
export const openrouterCreditError = (): CreditError | null => creditError;

// Every key checked again now, as just after OpenRouter's daily limits reset at UTC midnight.
export function refreshKeys() {
  for (const st of keyStates.values()) st.at = 0;
  return keyStatus();
}

export function resetKeyCache() {
  keyStates.clear();
  spent.clear();
  using = 'primary';
  creditError = null;
}

// The key the server's calls to OpenRouter go with now; a switch is logged.
export function serverKey(): string {
  const primary = process.env.OPENROUTER_API_KEY ?? '', fallback = process.env.OPENROUTER_FALLBACK_KEY ?? '';
  const left = keyStates.get(primary)?.info?.remaining ?? null;
  const now = fallback && (spent.has(primary) || (left !== null && left < switchUsd())) ? 'fallback' : 'primary';
  if (now !== using) {
    using = now;
    act('server', { op: 'openrouter key', using: now, ...(left !== null && { primary_remaining: left }) });
    console.log(`OpenRouter calls now use the ${now} key${left !== null ? `, the primary having $${left.toFixed(2)} left` : ''}`);
    changes.emit('change', 'tree');
  }
  return now === 'fallback' ? fallback : primary;
}

// Track OpenRouter shared-key outcomes: switch to the fallback key ONLY on 403 openrouter_key_limit (never on 402 account-wide
// credits or policy/moderation 403s); latch 402 credit_error once per outage and clear it on the next billable 2xx.
export function keyOut(key: string, status = 403, body?: any, method = 'POST') {
  if (key !== process.env.OPENROUTER_API_KEY && key !== process.env.OPENROUTER_FALLBACK_KEY) return;
  if (status >= 200 && status < 300) {
    if (creditError && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      creditError = null;
      act('server', { op: 'openrouter credit', recovered: true });
      changes.emit('change', 'tree');
    }
    return;
  }
  if (status === 402) {
    if (!creditError) {
      const raw = typeof body?.error?.message === 'string' ? body.error.message.replace(/\s+/g, ' ').trim() : '';
      const cleaned = serverKeys().reduce((m, k) => m.replaceAll(k, '[redacted]'), raw).slice(0, 200);
      const message = cleaned || 'OpenRouter account credits exhausted (402)';
      creditError = { at: new Date().toISOString(), message };
      const which = key === process.env.OPENROUTER_FALLBACK_KEY ? 'fallback' : 'primary';
      act('server', { op: 'openrouter credit', status: 402, key: which, message });
      console.error(`OpenRouter shared ${which} key answered 402: ${message}`);
      changes.emit('change', 'tree');
    }
    return;
  }
  if (status !== 403 || body?.error?.metadata?.limit_source !== 'openrouter_key_limit') return;
  if (key !== process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_FALLBACK_KEY) return;
  spent.add(key);
  serverKey();
}

export function isLowCredit(remaining: number | null, limit: number | null): boolean {
  if (remaining === null) return false;
  const lowUsd = Number(process.env.RF_LOW_CREDIT_USD ?? 50);
  return remaining < lowUsd || (limit !== null && limit > 0 && remaining < limit * 0.1);
}

// OpenRouter's view of the key calls use now, each of the server's keys checked again once its last check is RF_KEY_TTL_MS old, with
// label and key omitted.
export async function keyStatus(): Promise<KeyInfo | null> {
  const keys = serverKeys();
  if (!keys.length) {
    resetKeyCache();
    return null;
  }
  const prevLow = keyStates.get(serverKey())?.info?.low_credit ?? false;
  await Promise.all(keys.map(keyInfo));
  const k = serverKey(), info = keyStates.get(k)?.info;
  if (!info) return null;
  const low = isLowCredit(info.remaining, info.limit);
  if (low !== prevLow) changes.emit('change', 'tree');
  const daily = keys.map(k => keyStates.get(k)?.info?.usage_daily ?? null);
  return {
    ...info, low_credit: low, key: using,
    usage_daily_all: daily.includes(null) ? null : (daily as number[]).reduce((t, d) => t + d, 0),
    ...(creditError && { credit_error: creditError }),
  };
}

async function keyInfo(apiKey: string): Promise<KeyInfo | null> {
  const st = keyStates.get(apiKey) ?? { info: null, at: 0, inFlight: null };
  keyStates.set(apiKey, st);
  if (st.inFlight) return st.inFlight;
  if (st.at && Date.now() - st.at < Number(process.env.RF_KEY_TTL_MS ?? 180_000)) return st.info;
  st.inFlight = (async () => {
    try {
      const base = upstreams['openrouter.ai'] ?? 'https://openrouter.ai';
      const r = await fetch(`${base}/api/v1/key`, {
        headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const d = JSON.parse(await providerText(r))?.data;
        if (d && typeof d.usage === 'number' && Number.isFinite(d.usage)) {
          const limit = typeof d.limit === 'number' && Number.isFinite(d.limit) ? d.limit : null;
          const remaining = typeof d.limit_remaining === 'number' && Number.isFinite(d.limit_remaining) ? d.limit_remaining : null;
          st.info = {
            usage: d.usage,
            usage_daily: typeof d.usage_daily === 'number' && Number.isFinite(d.usage_daily) ? d.usage_daily : null,
            limit,
            remaining,
            reset: typeof d.limit_reset === 'string' ? d.limit_reset : null,
            fetched_at: new Date().toISOString(),
            low_credit: isLowCredit(remaining, limit),
          };
          if (remaining === null || remaining >= switchUsd()) spent.delete(apiKey);
        }
      }
    } catch {
      // Keep last cached value until next TTL window; never expose the key or upstream error.
    } finally {
      st.at = Date.now();
      st.inFlight = null;
    }
    return st.info;
  })();
  return st.inFlight;
}

const expiredLogged = new WeakMap<CallRun, Set<string>>();
function logExpired(a: CallRun, login: string, since: string, name: string, runner: string) {
  let set = expiredLogged.get(a);
  if (!set) expiredLogged.set(a, set = new Set());
  const key = `${login}:${since}`;
  if (set.has(key)) return;
  set.add(key);
  a.inst.append('server', 'expired', { run: a.n, login, name, runner });
}

// Spec §2.5 PrefixReader: pauses a streamed write after reading <=64 KiB (distinguishing exact 64 KiB EOF from >64 KiB
// truncation) or 10s timeout so enforce-mode execpolicy inspects the body BEFORE dialing upstream, then replays buffered
// chunks + remaining live stream on allow with backpressure.
async function readStreamPrefix(
  req: IncomingMessage,
  maxBytes = MAX_PREFIX_BYTES,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<{ prefix: Buffer; replayChunks: Buffer[]; eof: boolean; timedOut: boolean; aborted: boolean }> {
  return new Promise(resolve => {
    const prefixChunks: Buffer[] = [];
    const overflowChunks: Buffer[] = [];
    let prefixLen = 0;
    let total = 0;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (eof: boolean, timedOut: boolean, aborted: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (!eof && !aborted) req.pause();
      const prefix = prefixChunks.length === 1
        ? prefixChunks[0]
        : prefixChunks.length
          ? Buffer.concat(prefixChunks, prefixLen)
          : Buffer.alloc(0);
      const replayChunks = overflowChunks.length ? [...prefixChunks, ...overflowChunks] : prefixChunks;
      resolve({ prefix, replayChunks, eof, timedOut, aborted });
    };
    const onData = (b: Buffer) => {
      if (!b.length) return;
      total += b.length;
      if (prefixLen < maxBytes) {
        const need = maxBytes - prefixLen;
        if (b.length <= need) {
          prefixChunks.push(b);
          prefixLen += b.length;
        } else {
          prefixChunks.push(b.subarray(0, need));
          prefixLen = maxBytes;
          overflowChunks.push(b.subarray(need));
        }
      } else {
        overflowChunks.push(b);
      }
      // Strictly distinguish exact 64 KiB EOF (wait for 'end') from >64 KiB (> maxBytes -> pause immediately).
      if (total > maxBytes) finish(false, false, false);
    };
    const onEnd = () => finish(true, false, false);
    const onAbort = () => finish(false, false, true);
    const onClose = () => { if (!req.readableEnded) finish(false, false, true); };
    if (signal?.aborted) return finish(false, false, true);
    if (req.readableEnded) return finish(true, false, false);
    timer = setTimeout(() => finish(false, true, false), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onAbort);
    req.once('close', onClose);
    req.resume();
  });
}

function sanitizeLoggedTarget(rawTarget: string, host: string, includeOrigin = false): string {
  const u = URL.parse(rawTarget, `https://${host}`);
  if (u) {
    const san = sanitizeUrl(u, { projection: 'semantic' });
    const qIdx = san.url.indexOf('?');
    const sanSearch = qIdx >= 0 ? san.url.slice(qIdx) : '';
    return includeOrigin ? `${u.origin}${san.path}` : `${san.path}${sanSearch}`;
  }
  return sanitizeUrl(rawTarget, { projection: 'semantic' }).url;
}

export async function call(a: CallRun, host: string, req: IncomingMessage, res: ServerResponse) {
  const method = req.method!;
  let name = host, path = sanitizeLoggedTarget(req.url!, host), offer = '';
  const checkpoint = () => {
    if (a.stopped) throw new HttpError(409, 'run stopped');
    const lent = lender(a.inst, a.n);
    if (offer) use(a.inst, a.n, offer);
    return lent;
  };
  const current = () => {
    try { checkpoint(); return true; }
    catch (e) { if (!(e instanceof HttpError)) throw e; return false; }
  };
  // A request that may write, to anything but the server's own services, is logged as it goes too, so a cut leaves it as sent,
  // and a stop waits for its answer.
  let sent: number | undefined, digest: { hash: Hash; size: number } | undefined;
  let auditMeta: {
    effectiveMethod?: string;
    isWrite?: boolean;
    hdr?: Record<string, string>;
    hdrConflict?: true;
    actions?: SemanticAction[];
    bodyShape?: Record<string, string>;
    completeness?: { transport: string; decode: string; extract: string; reasons?: string[] };
    dupKeys?: true;
    graphqlOp?: string;
    policy?: CompactPolicyDecision;
  } | undefined;
  const log = (status: number, bytes: number, more?: object) => {
    a.inst.append('agent', 'call', {
      run: a.n, name, method, path, status, bytes,
      ...(sent && { sent }),
      ...(digest && { sha256: digest.hash.copy().digest('hex'), size: digest.size }),
      ...(auditMeta && {
        ...(auditMeta.effectiveMethod && { effectiveMethod: auditMeta.effectiveMethod }),
        ...(auditMeta.isWrite !== undefined && { isWrite: auditMeta.isWrite }),
        ...(auditMeta.hdr && { hdr: auditMeta.hdr }),
        ...(auditMeta.hdrConflict && { hdrConflict: true as const }),
        ...(auditMeta.actions?.length && { actions: auditMeta.actions }),
        ...(auditMeta.bodyShape && { bodyShape: auditMeta.bodyShape }),
        ...(auditMeta.completeness && { completeness: auditMeta.completeness }),
        ...(auditMeta.dupKeys && { dupKeys: true as const }),
        ...(auditMeta.graphqlOp && { graphqlOp: auditMeta.graphqlOp }),
        ...(auditMeta.policy && { policy: auditMeta.policy }),
      }),
      ...more,
    });
    sending.delete(req);
  };
  let jsonApi = false;
  let parsedUrl: URL | null = null;
  let sanPathname: string | undefined;
  let sanSearch: string | undefined;
  try {
    const url = parsedUrl = URL.parse(req.url!, `https://${host}`);
    if (!url) throw new HttpError(403, `invalid request target: ${path}`);
    const sanParsed = sanitizeUrl(url, { projection: 'semantic' });
    sanPathname = sanParsed.path;
    const qIdx = sanParsed.url.indexOf('?');
    sanSearch = qIdx >= 0 ? sanParsed.url.slice(qIdx) : '';
    const link = a.links.get(url.href), s = link ? undefined : own(host);
    if (link) { name = link.name; path = sanitizeLoggedTarget(url.href, host, true); }
    // Of the connections that take the host, the one a tick names it under, as a Databricks workspace's warehouse does, or the first.
    const serving = link || s ? [] : connections().filter(c => types[c.type].hosts?.(c).some(h => covers(h, host)));
    jsonApi = !!s || serving.some(c => c.type === 'graph' || c.type === 'databricks');
    // The runner's own OpenRouter key, where they use it, in place of the server's, never falling back to it.
    const runner = a.runner, { logins: ticked } = lender(a.inst, a.n), mine = s === openrouter ? logins(runner).find(l => l.id === 'openrouter' && l.enabled) : undefined;
    const c = serving.find(c => ticked.some(t => t.startsWith(`${loginOf(c).id}:${host}/`))) ?? serving[0];
    jsonApi = !!s || c?.type === 'graph' || c?.type === 'databricks';
    name = link?.name ?? c?.name ?? s?.name ?? host;
    // Sanitize logged path with semantic query-value templating so credentials/PII/prompts in query strings never land in log.jsonl.
    path = sanitizeLoggedTarget(url.href, host, Boolean(link));
    // A target such as //elsewhere/… or https://elsewhere/… would take the request, and the credential put in, to another host, and
    // one such as http://HOST/… to it in the clear.
    if (url.origin !== `https://${host}`) throw new HttpError(403, `${host} takes requests for https://${host}, not ${url.origin}`);
    if (method === 'TRACE') throw new HttpError(403, 'a TRACE would echo the credential put in');
    if (link) use(a.inst, a.n, link.offer);
    if (mine?.expired) throw Object.assign(new HttpError(409, `${runner}'s own OpenRouter key is out of credits: they save another, or stop using it, on the Logins page, and the instance carries on`), { login: 'openrouter', since: loginGeneration(mine) ?? '' });
    if (!link && !c && !s) throw new HttpError(403, `${url.origin + sanPathname} is no link a connection's answer gave this run`);
    // A POST's or PATCH's body, a JSON one, or any to the server's own services, is read whole, for the policy, up to 32 MB, the
    // most any of their hosts takes; a JSON body goes on as the JSON it read, as it rewrote
    // it, never as bytes another parser might read otherwise, such as a key twice. A deployment's service takes any body as bytes,
    // streamed, as a file's content is.
    const parsedMethods = parseSemanticMethods(method, req.headers);
    const isJson = /json/i.test(String(req.headers['content-type']));
    // A file's content, PUT …/content, streams on as its bytes, a JSON file's too.
    let raw: Buffer | undefined, lastSeg = '';
    try { lastSeg = decodeURIComponent(url.pathname.split('/').pop() ?? '').toLowerCase(); } catch {}
    if (c?.type !== 'service' && !link && (s || ['POST', 'PATCH'].includes(method) || ['POST', 'PATCH'].includes(parsedMethods.effectiveMethod) || (method === 'PUT' && isJson && lastSeg !== 'content'))) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const b of req as AsyncIterable<Buffer>) {
        if ((size += b.length) > 32 * 2 ** 20) throw new HttpError(413, `a request's body to ${host} holds 32 MB at most, but for a file's content, which streams`);
        chunks.push(b);
      }
      raw = Buffer.concat(chunks);
    }
    let json: any;
    if (isJson && raw?.length) {
      try {
        json = JSON.parse(raw.toString());
      } catch {
        // Fixed diagnostic so malformed OpenRouter/Exa/API JSON never leaks prompt or body fragments into log.jsonl.
        throw new HttpError(400, 'invalid JSON request body');
      }
    }
    const r = { method, url, headers: req.headers, json, body: raw, target: req.url! };
    let out = json, auth: Record<string, string> = {}, as = '', ticks: string[] = [], redirect: string | true | undefined, targetPath = url.pathname;
    const lent = checkpoint();
    if (c) {
      const { by, logins } = lent, checked = await types[c.type].check!(c, by, ticks = logins, r, checkpoint), login = loginOf(c) as EntraLogin;
      out = checked.json ?? json;
      redirect = checked.redirect;
      targetPath = checked.pathname ?? url.pathname;
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
      } else auth = { authorization: `Bearer ${await token(as, login.id, login.scope, checkpoint)}` };
    }
    let apiKey = '';
    if (s) {
      // The key goes in both headers SDKs send one in: Authorization, and x-api-key, as Anthropic's, Pi's among them, and Exa's do.
      out = s.check(r);
      if (s === openrouter) {
        const now = logins(runner).find(l => l.id === 'openrouter');
        const nowEnabled = !!now?.enabled;
        if (mine ? (!nowEnabled || now!.since !== mine.since || now!.expired) : nowEnabled)
          throw new HttpError(409, 'the selected model key changed before sending; retry under current consent');
      }
      apiKey = mine ? secret(runner, 'openrouter') : s === openrouter ? serverKey() : process.env[s.key]!;
      auth = { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey };
    }
    const body = out === undefined ? raw : Buffer.from(JSON.stringify(out));
    if (a.stopped) throw new HttpError(409, 'run stopped');
    lender(a.inst, a.n);
    if (offer) use(a.inst, a.n, offer);
    if (link) use(a.inst, a.n, link.offer);

    // Unified RequestDescriptor + semantic extraction + execpolicy admission for non-LLM API connections (never logging OpenRouter/Exa prompt bodies).
    const connectionType = link ? 'link' as const : (c?.type as 'graph' | 'databricks' | 'service' | undefined);
    const savedProv = link ? linkProvenanceByRun.get(a)?.get(url.href) : undefined;
    const linkProvenance = link
      ? {
          sourceType: savedProv?.sourceType ?? connections().find(x => x.name === link.name)?.type,
          linkKind: savedProv?.linkKind,
        }
      : undefined;
    let isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    let prefixTee: { chunks: Buffer[]; bytes: number; truncated: boolean } | undefined;
    let prefixChunks: Buffer[] | undefined;
    let prefixEof = false;
    let reservedApproval: { key: string; decisionId: string } | undefined;
    if (!s) {
      const descUrl = new URL(`${url.origin}${targetPath}${url.search}`);
      const bodyExpected = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
      const cfg = loadExecPolicyConfig();
      const enforceActive = cfg.mode === 'enforce' || Boolean(cfg.configError);
      const preliminaryWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method) || !['GET', 'HEAD', 'OPTIONS'].includes(parsedMethods.effectiveMethod);
      const ac = new AbortController();
      const onResClose = () => ac.abort();
      res.once('close', onResClose);

      let effectiveRaw: Buffer | undefined = body !== undefined ? body : (!bodyExpected ? Buffer.alloc(0) : undefined);
      let bodyComplete = effectiveRaw !== undefined;
      let transport: 'complete' | 'truncated' | 'not-read' = effectiveRaw !== undefined
        ? (effectiveRaw.length <= MAX_PREFIX_BYTES ? 'complete' : 'truncated')
        : 'not-read';
      let transportReasons: string[] | undefined;

      // Spec §2.5 PrefixReader: in enforce mode, read <=64 KiB (distinguishing exact 64 KiB EOF from >64 KiB) or 10s timeout BEFORE dialing upstream!
      if (enforceActive && body === undefined && preliminaryWrite && bodyExpected) {
        const pr = await readStreamPrefix(req, MAX_PREFIX_BYTES, 10_000, ac.signal);
        if (pr.timedOut || pr.aborted) {
          res.off('close', onResClose);
          const decId = randomUUID();
          const ruleId = pr.timedOut ? 'policy_prefix_timeout' : 'policy_error';
          const atSeq = Array.isArray(a.inst.log) ? (a.inst.log.at(-1)?.seq ?? 0) : 0;
          auditMeta = {
            isWrite: true,
            policy: {
              decisionId: decId,
              mode: cfg.mode,
              action: 'deny',
              ruleId,
              policyVersion: POLICY_VERSION,
              atSeq,
            },
          };
          log(403, 0, { refused: `blocked by policy: ${ruleId}` });
          if (res.headersSent) return void res.destroy();
          if (jsonApi) res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', connection: 'close' }).end(`${JSON.stringify({ error: { code: 'rf_policy', ruleId, decisionId: decId } })}\n`);
          else res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`blocked by policy: ${ruleId} (decisionId=${decId})\n`);
          return;
        }
        prefixChunks = pr.replayChunks;
        prefixEof = pr.eof;
        effectiveRaw = pr.prefix;
        bodyComplete = pr.eof;
        transport = pr.eof ? 'complete' : 'truncated';
        if (!pr.eof) transportReasons = ['prefix-only'];
      }

      const { descriptor, methods } = buildApiRequestDescriptor({
        connection: name,
        connectionType,
        ...(linkProvenance && { linkProvenance }),
        seq: (a.inst.log?.length ?? 0) + 1,
        method,
        url: descUrl,
        headers: req.headers,
        rawBody: effectiveRaw,
        bodyComplete,
        transport,
        ...(transportReasons && { transportReasons }),
      });
      isWrite = descriptor.safe.isWrite;
      const runEntry = Array.isArray(a.inst.log) ? a.inst.log.findLast(e => e.op === 'run' && e.run === a.n) : undefined;
      const runAuth = runEntry?.authority as { epoch?: number; owner?: string; workspace?: string } | undefined;
      const instWorkspace = runAuth?.workspace ?? (a.inst.seriesId ? tree().series[a.inst.seriesId]?.workspace : undefined);
      const instOwner = runAuth?.owner ?? a.runner;
      const admissionAtSeq = Array.isArray(a.inst.log) ? (a.inst.log.at(-1)?.seq ?? 0) : 0;
      let decision;
      try {
        decision = await defaultExecPolicy.evaluate(descriptor, {
          log: Array.isArray(a.inst.log) ? a.inst.log : undefined,
          uptoSeq: admissionAtSeq,
          epoch: runAuth?.epoch,
          owner: instOwner,
          workspace: instWorkspace,
          instKey: a.inst.dir,
          intent: { run: a.n, series: a.inst.seriesId },
          signal: ac.signal,
        });
      } finally {
        res.off('close', onResClose);
      }
      if (decision.reservationKey) {
        reservedApproval = { key: decision.reservationKey, decisionId: decision.decisionId };
      }
      const compact = { ...compactDecision(decision), atSeq: admissionAtSeq };
      auditMeta = {
        ...(methods.effectiveMethod !== method && { effectiveMethod: methods.effectiveMethod }),
        isWrite: descriptor.safe.isWrite,
        ...(methods.hdr && { hdr: methods.hdr }),
        ...(methods.hdrConflict && { hdrConflict: true as const }),
        ...(descriptor.safe.actions.length && { actions: descriptor.safe.actions }),
        ...(descriptor.safe.bodyShape && { bodyShape: descriptor.safe.bodyShape }),
        completeness: descriptor.safe.completeness,
        ...(descriptor.safe.dupKeys && { dupKeys: true as const }),
        ...(descriptor.safe.graphqlOp && { graphqlOp: descriptor.safe.graphqlOp }),
        policy: compact,
      };
      if (decision.mode === 'enforce' && decision.action !== 'allow') {
        if (reservedApproval) {
          defaultExecPolicy.releaseApprovalReservation(reservedApproval.key, reservedApproval.decisionId);
          reservedApproval = undefined;
        }
        log(403, 0, { refused: `blocked by policy: ${decision.ruleId}` });
        if (res.headersSent) return void res.destroy();
        // Enforce-mode refusal returns ruleId + decisionId only (never reasoning oracle text) and closes connection cleanly.
        if (jsonApi) res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', connection: 'close' }).end(`${JSON.stringify({ error: { code: 'rf_policy', ruleId: decision.ruleId, decisionId: decision.decisionId } })}\n`);
        else res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`blocked by policy: ${decision.ruleId} (decisionId=${decision.decisionId})\n`);
        return;
      }
      // Recheck authority after any async execpolicy wait before emitting send or opening upstream.
      try {
        if (a.stopped) throw new HttpError(409, 'run stopped');
        lender(a.inst, a.n);
        if (offer) use(a.inst, a.n, offer);
        if (link) use(a.inst, a.n, link.offer);
      } catch (e) {
        if (reservedApproval) {
          defaultExecPolicy.releaseApprovalReservation(reservedApproval.key, reservedApproval.decisionId);
          reservedApproval = undefined;
        }
        throw e;
      }
      if (body === undefined && !prefixChunks && isWrite) {
        prefixTee = { chunks: [], bytes: 0, truncated: false };
      }
    }

    if (!s && isWrite) {
      if (c?.type === 'service') digest = { hash: createHash('sha256'), size: 0 };
      const hasApproval = Boolean(auditMeta?.policy?.approvalRef);
      // Durably fsync approval-bearing `send` records BEFORE dialing upstream so host crashes cannot restore spent uses;
      // if persistence fails, upstream is never dialed and the in-memory reservation is cleanly released.
      try {
        sent = a.inst.append('agent', 'send', {
          run: a.n, name, method, path,
          ...(auditMeta?.effectiveMethod && { effectiveMethod: auditMeta.effectiveMethod }),
          ...(hasApproval && {
            approvalRef: auditMeta!.policy!.approvalRef,
            decisionId: auditMeta!.policy!.decisionId,
          }),
        }, hasApproval ? { sync: true } : undefined).seq;
      } finally {
        if (reservedApproval) {
          defaultExecPolicy.releaseApprovalReservation(reservedApproval.key, reservedApproval.decisionId);
          reservedApproval = undefined;
        }
      }
      sending.add(req);
    } else {
      if (reservedApproval) {
        defaultExecPolicy.releaseApprovalReservation(reservedApproval.key, reservedApproval.decisionId);
        reservedApproval = undefined;
      }
      if (s) sending.add(req);
    }
    const doneWork = Promise.withResolvers<void>();
    if (s || sent !== undefined) {
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
    const verifyModelKey = () => {
      if (a.stopped || !current()) throw new HttpError(409, 'run stopped');
      if (s === openrouter) {
        const now = logins(runner).find(l => l.id === 'openrouter');
        const nowEnabled = !!now?.enabled;
        if (mine ? (!nowEnabled || now!.since !== mine.since || loginGeneration(now) !== loginGeneration(mine) || now!.expired) : nowEnabled)
          throw new HttpError(409, 'the selected model key changed before retrying; retry under current consent');
      }
    };
    try {
      // A Location where the check lets one go, as a redirect's, is a link for this run before the run can follow it.
      const answer = await forward(`${c?.type === 'service' ? c.url : upstreams[host] ?? url.origin}${targetPath}${url.search}`, req, res, {
        auth, body, digest, prefixTee, prefixChunks, prefixEof, keep: !link && c?.type !== 'service', service: !!s, retry429: s === openrouter, registerAbort,
        beforeRetry: s === openrouter ? verifyModelKey : undefined,
        location: to => { const l = URL.parse(to); if (l && (redirect === true || l.origin === redirect)) { a.links.set(l.href, { name, offer }); recordLinkProvenance(a, l.href, { sourceType: c?.type, linkKind: 'redirect' }); } },
      });
      // For streamed non-LLM writes (e.g. service or PUT .../content), extract bodyShape/actions from the <=64KiB tee prefix.
      if (!s && prefixTee && prefixTee.bytes > 0) {
        const descUrl = new URL(`${url.origin}${targetPath}${url.search}`);
        const streamedPrefix = Buffer.concat(prefixTee.chunks);
        const { descriptor } = buildApiRequestDescriptor({
          connection: name,
          connectionType,
          ...(linkProvenance && { linkProvenance }),
          seq: (a.inst.log?.length ?? 0) + 1,
          method,
          url: descUrl,
          headers: req.headers,
          rawBody: streamedPrefix,
          bodyComplete: !prefixTee.truncated && !answer.incomplete,
          transport: prefixTee.truncated || answer.incomplete ? 'truncated' : 'complete',
        });
        auditMeta = {
          ...auditMeta,
          ...(descriptor.safe.actions.length && { actions: descriptor.safe.actions }),
          ...(descriptor.safe.bodyShape && { bodyShape: descriptor.safe.bodyShape }),
        };
      }
      // An answer's links go through for this run; what a service's answer cost, whole, in its stream's events, from OpenRouter's
      // generation endpoint, or estimated where none could be learned, adds to the run's as it comes.
      if (c && types[c.type].links && /json/i.test(answer.type)) {
        if (answer.invalidJson) console.error(`${name}: invalid JSON metadata on ${method} ${targetPath} (${answer.status}, ${answer.bytes} bytes)`);
        if (answer.parsed !== undefined && current()) {
          try {
            const links = await types[c.type].links!(answer.parsed, targetPath, as, ticks, checkpoint);
            checkpoint();
            for (const entry of links) {
              const rawUrl = typeof entry === 'string' ? entry : entry.url;
              const linkKind: 'upload_session' | 'download' | 'redirect' = typeof entry === 'string' ? 'download' : entry.kind;
              const href = new URL(rawUrl).href;
              a.links.set(href, { name, offer });
              recordLinkProvenance(a, href, { sourceType: c.type, linkKind });
            }
          } catch (e) { if (current()) throw e; }
        }
      }
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
      const failed = answer.failed && [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_FALLBACK_KEY, process.env.EXA_API_KEY, apiKey].reduce((m, k) => k ? m.replaceAll(k, '[redacted]') : m, answer.failed);
      log(failed ? 502 : answer.status, failed ? 0 : answer.bytes, s ? { ...(typeof json?.model === 'string' && json.model && { model: json.model }), cost, ...(estimated && { estimated: true }), ...(failed && { failed }) } : answer.incomplete ? { incomplete: true } : undefined);
      if (s === openrouter && !mine && !answer.failed) keyOut(apiKey, answer.status, answer.events.at(-1), method);
      if (mine && answer.status === 402) {
        // A revoked lease, a disabled key, or a replacement key must not receive a late expiry.
        if (!current()) return;
        const now = logins(runner).find(l => l.id === mine.id);
        if (!now?.enabled || now.since !== mine.since || loginGeneration(now) !== loginGeneration(mine)) return;
        saveLogin(runner, { ...now, expired: true });
        logExpired(a, 'openrouter', loginGeneration(now) ?? '', 'OpenRouter', runner);
      }
    } finally {
      sending.delete(req);
      inFlight.get(a)?.delete(doneWork.promise);
      doneWork.resolve();
    }
  } catch (e) {
    // A refusal, or an expired login, is the server's answer; anything else, a failure to reach the host.
    const err = e as Error & { status?: number; login?: string; since?: string }, status = e instanceof HttpError ? err.status! : 502;
    let msg = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_FALLBACK_KEY, process.env.EXA_API_KEY].reduce((m, k) => k ? m.replaceAll(k, '[redacted]') : m, err.message);
    if (parsedUrl) {
      if (parsedUrl.search && sanSearch !== undefined && parsedUrl.search !== sanSearch) {
        msg = msg.replaceAll(parsedUrl.search, sanSearch);
      }
      if (sanPathname && sanPathname !== parsedUrl.pathname) {
        msg = msg.replaceAll(parsedUrl.pathname, sanPathname);
        // Also replace versionless Graph bare path (e.g. /v1.0/foo -> /foo) and individually redacted segments.
        const bareRaw = parsedUrl.pathname.replace(/^\/(?:v1\.0|beta)(?=\/|$)/i, '');
        const bareSan = sanPathname.replace(/^\/(?:v1\.0|beta)(?=\/|$)/i, '');
        if (bareRaw && bareSan && bareRaw !== bareSan) {
          msg = msg.replaceAll(bareRaw, bareSan);
          try {
            const bareDec = decodeURIComponent(bareRaw);
            if (bareDec && bareDec !== bareSan) msg = msg.replaceAll(bareDec, bareSan);
          } catch {}
        }
        try {
          const dec = decodeURIComponent(parsedUrl.pathname);
          if (dec && dec !== sanPathname) msg = msg.replaceAll(dec, sanPathname);
          const decNoSlash = dec.replace(/\/$/, '');
          if (decNoSlash && decNoSlash !== sanPathname) msg = msg.replaceAll(decNoSlash, sanPathname.replace(/\/$/, ''));
        } catch {}
        const rawSegs = parsedUrl.pathname.split('/');
        const sanSegs = sanPathname.split('/');
        for (let i = 0; i < Math.min(rawSegs.length, sanSegs.length); i++) {
          if (rawSegs[i] && sanSegs[i] && rawSegs[i] !== sanSegs[i]) {
            msg = msg.replaceAll(rawSegs[i], sanSegs[i]);
            try {
              const decSeg = decodeURIComponent(rawSegs[i]);
              if (decSeg && decSeg !== sanSegs[i]) msg = msg.replaceAll(decSeg, sanSegs[i]);
            } catch {}
          }
        }
      }
    }
    const rawTargetPath = (req.url ?? '').replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
    if (sanPathname && rawTargetPath && rawTargetPath !== sanPathname) {
      msg = msg.replaceAll(rawTargetPath, sanPathname);
    }
    msg = scrubText(msg).text;
    if (err.login && current()) logExpired(a, err.login, err.since ?? '', byLogin(err.login) ? loginOf(byLogin(err.login)!).name : err.login, a.runner);
    log(status, 0, e instanceof HttpError ? { refused: msg } : { failed: msg });
    if (res.headersSent) return void res.destroy();
    if (jsonApi) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(`${JSON.stringify({ error: { code: 'rf_proxy', message: msg } })}\n`);
    else res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`${msg}\n`);
  }
}

// The request goes on as it came, but for its credential and the hop's own headers; the answer comes back as it is, its Location
// told first, and, where it's kept, JSON as text or an event stream's data events scanned as chunks pass without buffering the
// stream. A run gone before its answer on a non-service write leaves it read to its end; on an OpenRouter or Exa stream, closing
// cancels the upstream stream so its partial cost can be looked up.
function maxKeepBytes(): number {
  const raw = process.env.RF_PROXY_META_BYTES;
  if (raw === undefined || !raw.trim()) return 8 * 1024 * 1024;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8 * 1024 * 1024;
}

function forward(target: string, req: IncomingMessage, res: ServerResponse, o: {
  auth: Record<string, string>; body?: Buffer; digest?: { hash: Hash; size: number };
  prefixTee?: { chunks: Buffer[]; bytes: number; truncated: boolean };
  prefixChunks?: Buffer[];
  prefixEof?: boolean;
  keep: boolean;
  service?: boolean; retry429?: boolean; beforeRetry?: () => void; registerAbort?: (fn: () => void) => () => void; location(to: string): void;
}) {
  return new Promise<{ status: number; bytes: number; type: string; text: string; parsed?: unknown; invalidJson?: boolean; events: any[]; headers: IncomingHttpHeaders; cut?: boolean; incomplete?: boolean; failed?: string }>((ok, fail) => {
    // X-RF- headers are the server's, X_RF_ too, which some servers read as the same.
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'authorization' && k !== 'host' && !HOP.includes(k) && !/^x[-_]rf[-_]/.test(k)));
    let settled = false, unregister: (() => void) | undefined, retryTimer: NodeJS.Timeout | undefined;
    const clearRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; } };
    const done = (v: { status: number; bytes: number; type: string; text: string; parsed?: unknown; invalidJson?: boolean; events: any[]; headers: IncomingHttpHeaders; cut?: boolean; incomplete?: boolean; failed?: string }) => {
      if (settled) return;
      settled = true;
      clearRetry();
      unregister?.();
      ok(v);
    };
    const die = (e: Error) => {
      if (settled) return;
      settled = true;
      clearRetry();
      unregister?.();
      fail(e);
    };
    const canRetry429 = !!o.retry429 && (o.body !== undefined || ['GET', 'HEAD', 'OPTIONS'].includes(req.method!));
    const sendAttempt = (attempt: number) => {
      if (settled) return;
      unregister?.();
      unregister = undefined;
      if (attempt > 0 && o.beforeRetry) {
        try {
          o.beforeRetry();
        } catch (e) {
          return die(e as Error);
        }
      }
      const up = (target.startsWith('https:') ? httpsRequest : httpRequest)(target, {
        // A chunked body goes on chunked: Node sends a GET's, DELETE's or OPTIONS' otherwise unframed, as a request of its own.
        method: req.method, headers: { ...headers, ...(o.body ? { 'content-length': String(o.body.length) } : req.headers['transfer-encoding'] && { 'transfer-encoding': 'chunked' }), ...o.auth },
      }, r => {
        if (canRetry429 && r.statusCode === 429 && !res.destroyed && !res.closed) {
          const delay = openrouter.retryDelayMs(attempt, r.headers['retry-after']);
          if (delay !== undefined) {
            r.resume();
            unregister?.();
            unregister = undefined;
            const cancelWait = () => {
              clearRetry();
              if (settled) return;
              res.destroy();
              done({ status: 429, bytes: 0, type: '', text: '', events: [], headers: r.headers });
            };
            if (o.service) unregister = o.registerAbort?.(cancelWait);
            res.once('close', cancelWait);
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              res.off('close', cancelWait);
              unregister?.();
              unregister = undefined;
              sendAttempt(attempt + 1);
            }, delay);
            return;
          }
        }
        if (r.headers.location) o.location(r.headers.location);
      // A status Node won't send on, such as 099, fails the request, as an unreadable answer does below.
      try {
        res.writeHead(r.statusCode!, Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.includes(k))));
      } catch (e) {
        up.destroy();
        return die(e as Error);
      }
      const type = String(r.headers['content-type']), isSse = type.includes('event-stream'), isJson = /json/i.test(type);
      const kept: Buffer[] = [], events: any[] = [], enc = String(r.headers['content-encoding'] ?? '').trim().toLowerCase(), isGzip = enc === 'gzip' || enc === 'x-gzip';
      let bytes = 0, cut = false, carry = '', oversized = false;
      const pushLine = (line: string) => {
        if (!/^data:\s*\{/.test(line)) return;
        let e: any;
        try { e = JSON.parse(line.replace(/^data:\s*/, '')); } catch { return; }
        const summary = events[0] ??= { usage: {}, output_chars: 0 };
        summary.id ??= openrouter.generationId({}, [e]);
        const u = e?.usage ?? e?.response?.usage ?? e?.message?.usage;
        for (const field of ['prompt_tokens', 'input_tokens', 'output_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
          if (typeof u?.[field] === 'number') summary.usage[field] = Math.max(summary.usage[field] ?? 0, u[field]);
        }
        for (const field of ['prompt_tokens_details', 'input_tokens_details', 'cache_creation']) {
          for (const token of ['cached_tokens', 'cache_write_tokens', 'ephemeral_1h_input_tokens']) {
            if (typeof u?.[field]?.[token] === 'number') {
              const details = summary.usage[field] ??= {};
              details[token] = Math.max(details[token] ?? 0, u[field][token]);
            }
          }
        }
        const charged = openrouter.cost(e);
        if (charged !== undefined) summary.usage.cost = charged;
        const exaCost = exa.cost(e);
        if (exaCost !== undefined) summary.costDollars = { total: exaCost };
        const delta = e?.delta?.text ?? e?.delta?.partial_json ?? e?.choices?.[0]?.delta?.content ?? e?.delta;
        if (typeof delta === 'string') summary.output_chars += delta.length;
      };
      const feedText = (chunk: string) => {
        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (!oversized) {
            if (carry.length + parts[i].length > 1024 * 1024) { carry = ''; oversized = true; }
            else carry += parts[i];
          }
          if (i < parts.length - 1) {
            if (!oversized) pushLine(carry);
            carry = '';
            oversized = false;
          }
        }
      };
      const decoder = o.keep && o.service && isSse ? new StringDecoder('utf8') : undefined;
      const unzip = decoder && (isGzip ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : enc === 'zstd' ? createZstdDecompress() : undefined);
      const decoded = unzip && new Promise<void>(resolve => {
        unzip.on('data', (b: Buffer) => feedText(decoder!.write(b)));
        unzip.once('end', resolve);
        unzip.once('close', resolve);
        unzip.once('error', () => { cut = true; resolve(); });
      });
      const maxKeep = maxKeepBytes();
      let tooBig = false;
      r.on('data', (b: Buffer) => {
        bytes += b.length;
        if (decoder) {
          if (unzip) unzip.write(b);
          else feedText(decoder.write(b));
        } else if (o.keep && isJson) {
          if (bytes > maxKeep) { kept.length = 0; tooBig = true; }
          else if (!tooBig) kept.push(b);
        }
      });
      const finishAnswer = () => {
        if (decoder) {
          feedText(decoder.end());
          if (carry) { pushLine(carry); carry = ''; }
        }
        let text = '', parsed: unknown, invalidJson = false, failed: string | undefined;
        if (o.keep && isJson && kept.length && !tooBig) {
          const raw = Buffer.concat(kept);
          try {
            const options = { maxOutputLength: maxKeep };
            text = (isGzip ? gunzipSync(raw, options) : enc === 'deflate' ? inflateSync(raw, options) : enc === 'br' ? brotliDecompressSync(raw, options) : enc === 'zstd' ? zstdDecompressSync(raw, options) : raw).toString();
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') {
              res.destroy();
              if (!o.service) { die(e as Error); return { status: r.statusCode!, bytes, type, text, events, headers: r.headers }; }
              cut = true;
              failed = (e as Error).message;
            }
          }
          if (text) {
            try {
              parsed = JSON.parse(text);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
            } catch {
              invalidJson = true;
            }
          }
        }
        return { status: r.statusCode!, bytes, type, text, parsed, ...(invalidJson && { invalidJson: true }), events, headers: r.headers, ...(cut && { cut: true }), ...(failed && { failed }) };
      };
      const abortStream = () => {
        if (r.readableEnded || settled) return;
        cut = true;
        unzip?.destroy();
        up.destroy();
        res.destroy();
        done(finishAnswer());
      };
      unregister?.();
      if (o.service) unregister = o.registerAbort?.(abortStream);
      const holdEnd = o.keep && isJson && (isGzip || enc === 'deflate' || enc === 'br' || enc === 'zstd');
      if (res.closed) {
        if (o.service && isSse) return abortStream();
        r.resume();
      } else {
        r.pipe(res, { end: !holdEnd }).once('close', () => {
          if (o.service && isSse && !r.readableEnded) abortStream();
          else r.resume();
        });
      }
      r.on('end', async () => {
        if (unzip) {
          unzip.end();
          await decoded;
        }
        const answer = finishAnswer();
        if (settled) return;
        if (holdEnd && !answer.failed && !res.closed) res.end();
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
          unzip?.destroy();
          res.destroy();
          done(finishAnswer());
        } else die(e);
      });
    });
      if (o.service) unregister = o.registerAbort?.(() => up.destroy(new Error('run stopped')));
      up.on('error', e => {
        if (settled) return;
        if (!o.service) return die(e);
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('provider request failed\n');
        done({ status: 502, bytes: 0, type: '', text: '', events: [], headers: {}, cut: true });
      });
      if (o.body) up.end(o.body);
      else {
        const recordChunk = (b: Buffer) => {
          if (o.digest) { o.digest.hash.update(b); o.digest.size += b.length; }
          if (o.prefixTee && !o.prefixTee.truncated) {
            const need = MAX_PREFIX_BYTES - o.prefixTee.bytes;
            if (b.length <= need) {
              o.prefixTee.chunks.push(Buffer.from(b));
              o.prefixTee.bytes += b.length;
            } else {
              if (need > 0) {
                o.prefixTee.chunks.push(Buffer.from(b.subarray(0, need)));
                o.prefixTee.bytes = MAX_PREFIX_BYTES;
              }
              o.prefixTee.truncated = true;
            }
          }
        };
        const finishStreamBody = () => {
          if (up.destroyed || settled) return;
          if (o.prefixEof) {
            up.end();
          } else {
            if (o.digest || o.prefixTee) req.on('data', recordChunk);
            if (o.digest) up.once('close', () => req.resume());
            req.pipe(up);
          }
        };
        if (!o.prefixEof) req.on('error', e => up.destroy(e));
        if (o.prefixChunks?.length) {
          // Replay buffered prefix chunks sequentially honoring up.write() backpressure ('drain') before piping live remainder.
          let idx = 0;
          const writeNext = () => {
            while (idx < o.prefixChunks!.length) {
              if (up.destroyed || settled) return;
              const ch = o.prefixChunks![idx++];
              recordChunk(ch);
              const ok = up.write(ch);
              if (!ok) {
                up.once('drain', writeNext);
                return;
              }
            }
            finishStreamBody();
          };
          writeNext();
        } else {
          finishStreamBody();
        }
      }
    };
    sendAttempt(0);
  });
}
