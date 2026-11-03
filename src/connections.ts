import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { HttpError, type Instance } from './store.ts';
import { readJson, rfDir, writeJson } from './system.ts';
import { m365Ready, type EntraLogin } from './auth.ts';
import { token } from './entra.ts';
import { lender, runnerOf, use, type Offer } from './logins.ts';
import graph from './connections/graph.ts';
import databricks from './connections/databricks.ts';
import website from './connections/website.ts';

// Connections: the outside systems runs reach, which admins keep with rf connection set NAME TYPE: each a name, a type and the
// type's settings, in .rf/connections.json. A type is a module under connections/, saying how its person signs in and what that
// login offers runs; for a system reached over HTTPS, its host, which requests to it may go and the links its answers hold.
//
// A run reaches those hosts as they are, with real tools and the vendors' own docs: the sandbox's proxy ends TLS for them, as the
// host, with rollforward's own certificate authority (ca.ts), which runs trust. Each request is checked against the type's policy
// and the instance's ticks, has its Authorization replaced by the runner's token, and goes on; the answer comes back as it is, and
// a `call` entry logs it. A link an answer held, such as an upload session's, goes through for that run, as it is, with no
// credential added. A refusal is a plain 403 with the reason, logged too.

export type Connection = { name: string; type: string; [setting: string]: any };
export type Request = { method: string; url: URL; headers: Record<string, string | string[] | undefined>; json?: any };
export type Type = {
  settings(input: Record<string, unknown>): Record<string, unknown>;
  // Its person's login: an Entra login, with its scope, or a website's, which they sign in to in a live browser.
  login(c: Connection): (EntraLogin | { id: string; kind: string; name: string; scope?: undefined; offers: Offer[] });
  host?(c: Connection): string;
  // The offer a request needs ticked, and its JSON body as it goes on, if the type rewrote it; or a refusal.
  check?(c: Connection, runner: string, ticks: string[], r: Request): Promise<{ offer: string; json?: unknown }>;
  links?(answer: unknown): string[];
  env?(c: Connection): Record<string, string>;
  help(c: Connection): string;
};
export const types: Record<string, Type> = { graph, databricks, website };

export const connections = (): Connection[] => Object.entries(readJson<Record<string, any>>('connections.json', {})).map(([name, c]) => ({ name, ...c }));

export function setConnection(name: string, input: Record<string, unknown>, by: string): Connection {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new HttpError(400, 'a connection\'s name is lowercase letters, digits and dashes');
  const type = types[String(input.type)];
  if (!type) throw new HttpError(400, `type: one of ${Object.keys(types).join(', ')}`);
  const all = readJson<Record<string, any>>('connections.json', {});
  all[name] = { type: input.type, ...type.settings(input), updated_by: by, updated_at: new Date().toISOString() };
  writeJson('connections.json', all);
  return { name, ...all[name] };
}

// People's logins to a connection removed stay theirs to sign out of; no run can use them.
export function removeConnection(name: string) {
  const all = readJson<Record<string, any>>('connections.json', {});
  if (!all[name]) throw new HttpError(404, `no connection ${name}`);
  delete all[name];
  writeJson('connections.json', all);
}

// Once, at the start: the websites kept before connections become website connections, and where people sign in with Microsoft,
// Microsoft 365 is the graph connection.
export function convert() {
  if (existsSync(join(rfDir(), 'connections.json'))) return;
  const sites = readJson<Record<string, { name: string; url: string; hosts: string[]; updated_by: string; updated_at: string }>>('websites.json', {});
  writeJson('connections.json', {
    ...(m365Ready() && { graph: { type: 'graph', updated_by: 'server', updated_at: new Date().toISOString() } }),
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

// What a run, as the proxy knows it, has: its instance, its number, and the links its connections' answers held, each the name of
// the connection that gave it.
export type CallRun = { inst: Instance; n: number; links: Map<string, string> };

// Tests point a host at a stand-in.
export const upstreams: Record<string, string> = {};

export const intercepts = (a: CallRun, host: string) =>
  connections().some(c => types[c.type].host?.(c) === host) || [...a.links.keys()].some(u => new URL(u).host === host);

const HOP = ['authorization', 'connection', 'host', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

export async function call(a: CallRun, host: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `https://${host}`), method = req.method!, link = a.links.get(url.href);
  const c = link ? undefined : connections().find(c => types[c.type].host?.(c) === host);
  const name = link ?? c?.name ?? host, path = link ? url.origin + url.pathname : url.pathname + url.search;
  const log = (status: number, bytes: number, why?: object) => a.inst.append('agent', 'call', { run: a.n, name, method, path, status, bytes, ...why });
  try {
    if (!link && !c) throw new HttpError(403, `${url.origin + url.pathname} is no link a connection's answer gave this run`);
    let body: Buffer | undefined, auth: string | undefined;
    if (c) {
      const type = types[c.type], { by, logins: ticks } = lender(a.inst);
      // A JSON body is read whole, for the policy; anything else streams.
      const json = ['POST', 'PATCH', 'PUT'].includes(method) && String(req.headers['content-type']).includes('json') ? JSON.parse((body = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>))).toString() || 'null') : undefined;
      const checked = await type.check!(c, by, ticks, { method, url, headers: req.headers, json });
      if (checked.json) body = Buffer.from(JSON.stringify(checked.json));
      const login = loginOf(c) as EntraLogin;
      auth = `Bearer ${await token(use(a.inst, checked.offer).email, login.id, login.scope)}`;
    }
    const { status, bytes } = await forward(`${upstreams[host] ?? url.origin}${url.pathname}${url.search}`, req, res, { auth, body, links: c && types[c.type].links, held: l => a.links.set(new URL(l).href, c!.name) });
    log(status, bytes);
  } catch (e) {
    // A refusal, or an expired login, is the server's answer; anything else, a failure to reach the host.
    const err = e as Error & { status?: number; login?: string }, status = e instanceof HttpError ? err.status! : 502;
    if (err.login) a.inst.append('server', 'expired', { login: err.login, name: byLogin(err.login) ? loginOf(byLogin(err.login)!).name : err.login, runner: runnerOf(a.inst).by });
    log(status, 0, e instanceof HttpError ? { refused: err.message } : { failed: err.message });
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`${err.message}\n`);
  }
}

// The request goes on as it came, but for its Authorization and the hop's own headers; the answer comes back as it is, and the
// links it holds, if JSON, are kept.
function forward(target: string, req: IncomingMessage, res: ServerResponse, o: { auth?: string; body?: Buffer; links?: (j: unknown) => string[]; held: (link: string) => void }) {
  return new Promise<{ status: number; bytes: number }>((ok, fail) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.includes(k)));
    const up = (target.startsWith('https:') ? httpsRequest : httpRequest)(target, {
      method: req.method, headers: { ...headers, ...(o.body && { 'content-length': String(o.body.length) }), ...(o.auth && { authorization: o.auth }) },
    }, r => {
      res.writeHead(r.statusCode!, Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.includes(k))));
      const kept: Buffer[] = [], json = o.links && String(r.headers['content-type']).includes('json');
      let bytes = 0;
      r.on('data', (b: Buffer) => { bytes += b.length; if (json) kept.push(b); });
      r.pipe(res);
      r.on('end', () => {
        if (json) {
          const raw = Buffer.concat(kept), enc = r.headers['content-encoding'];
          const text = (enc === 'gzip' ? gunzipSync(raw) : enc === 'deflate' ? inflateSync(raw) : enc === 'br' ? brotliDecompressSync(raw) : raw).toString();
          for (const l of o.links!(JSON.parse(text || 'null'))) o.held(l);
        }
        ok({ status: r.statusCode!, bytes });
      });
      r.on('error', fail);
    });
    up.on('error', fail);
    if (o.body) up.end(o.body);
    else req.pipe(up);
  });
}
