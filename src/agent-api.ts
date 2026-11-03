import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError, type Instance } from './store.ts';
import { Browsers, passUpgrade } from './browsers.ts';
import { graphCall } from './m365.ts';

// What only a run has, behind `rf`: its runner's logins and browsers. (For its own instance, its screen,
// threads and wakes, `rf` calls the people's API; see server.ts.) Shared by the server, for runs, and by `cli.ts try`, which lets
// an admin run a skill's steps without the model.
//   POST /agent/graph {args, body?} rf graph [METHOD] PATH …: a request to Microsoft Graph through the runner's Microsoft 365 login,
//                                  as far as the instance's ticks reach, answered as Graph answers it; body is --body FILE's bytes
//   POST /agent/browser {args}     rf browser open SITE | get SITE PATH FILE | expired SITE: a browser on a website, in the runner's login
// The server never reads or writes the run's files: rf does, in the sandbox. A file coming back travels as `data`, base64, in the
// answer, with `saved`, the FILE rf saves it as; one going out, as `body`, base64, in the request.

// A run as the agent API sees it: its instance, its number and token, and its browsers.
export type AgentRun = { inst: Instance; n: number; token: string; browsers?: Browsers };

// A file's name under working/, as the screen names it.
const rel = (file: string) => `working/${file.replace(/^working\//, '')}`;

export type Args = Record<string, string[]>;

// Parses `--name value` pairs, where a name may repeat, and a bare `--flag` (followed by another --name or nothing) as "true".
export function parseArgs(words: string[]): { args: Args; rest: string[] } {
  const args: Args = {}, rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/s.exec(words[i]);
    if (!m) { rest.push(words[i]); continue; }
    const v = m[2] ?? (words[i + 1] === undefined || words[i + 1].startsWith('--') ? 'true' : words[++i]);
    (args[m[1]] ??= []).push(v);
  }
  return { args, rest };
}

// The agent API on a port of its own, for one stand-in run: what `cli.ts try` and the tests use in place of the server.
export async function serveAgent(inst: Instance): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomUUID(), a: AgentRun = { inst, n: 0, token };
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }).end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    try {
      const url = new URL(req.url!, 'http://x');
      if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'no run for this token');
      const r = await agentCall(a, url.pathname, req.method ?? 'GET', async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); });
      if (!r) throw new HttpError(404, 'not found');
      send(r.status, r.data);
    } catch (e) {
      send((e as HttpError).status ?? 500, (e as Error).message);
    }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const [, root, t, id] = URL.parse(req.url!, 'http://x')?.pathname.split('/') ?? [];
    try {
      if (root !== 'browser' || t !== token || !a.browsers?.owns(id)) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    } catch (e) {
      return socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${(e as Error).message}\n`);
    }
    passUpgrade(req, socket, head, `/sessions/${id}/cdp`);
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token,
    async close() { await a.browsers?.close(); server.close(); server.closeAllConnections(); },
  };
}

export async function agentCall(a: AgentRun, path: string, method: string, body: () => Promise<Buffer>): Promise<{ status: number; data: unknown } | null> {
  const json = async () => { try { return JSON.parse((await body()).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); } };
  const words = async () => ((await json()).args ?? []).map(String) as string[];
  const data = (bytes: Buffer) => bytes.toString('base64');
  if (path === '/agent/graph' && method === 'POST') {
    const j = await json(), { args, rest } = parseArgs((j.args ?? []).map(String)), [out, file, item] = [args.out?.[0], args.body?.[0], args.for?.[0]];
    const [verb, target] = rest.length === 2 ? rest : ['GET', rest[0]], sent = j.body === undefined ? undefined : Buffer.from(j.body, 'base64');
    if (!target || rest.length > 2 || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(verb) || (verb === 'GET' && (sent || item))) throw new HttpError(400, "rf graph [POST|PATCH|PUT|DELETE] PATH [--body FILE] [--for ITEM] [--out FILE] [--header 'NAME: VALUE']...");
    const headers = Object.fromEntries((args.header ?? []).map(h => [h.slice(0, h.indexOf(':')).trim().toLowerCase(), h.slice(h.indexOf(':') + 1).trim()]));
    // Headers that shape the request and its answer, never what it does: a Prefer that redeems a sharing link grants the runner access.
    const bad = Object.entries(headers).find(([k, v]) => !['accept', 'consistencylevel', 'content-type', 'if-match', 'prefer', 'range'].includes(k) || (k === 'prefer' && /redeemsharinglink/i.test(v)));
    if (bad) throw new HttpError(400, `rf graph takes the headers Accept, ConsistencyLevel, Content-Type, If-Match, Prefer and Range, and no Prefer that redeems a sharing link: not ${bad[0]}: ${bad[1]}`);
    if (sent) headers['content-type'] ??= file?.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    if (item && !a.inst.doc.items.some(i => i.id === item && i.kind === 'output')) throw new HttpError(400, `${item} is no output on the screen`);
    const r = await graphCall(a.inst, verb, target, headers, sent), saved = out && r.status < 300 ? rel(out) : undefined;
    a.inst.append('agent', 'graph', {
      ...(verb !== 'GET' && { method: verb }), path: r.path, status: r.status, bytes: r.bytes.length, ...(saved && { file: saved }),
      ...(sent && { body: file && rel(file), sha256: createHash('sha256').update(sent).digest('hex') }), ...(verb !== 'GET' && { to: r.to, id: r.id, etag: r.etag }),
    });
    // A write for an output delivers it, with Graph's word for what it made: an item's id and version, or a message's Message-ID.
    const receipt = [r.id && `id ${r.id}`, r.etag && `eTag ${r.etag}`, r.mid && `Message-ID ${r.mid}`].filter(Boolean).join(', ') || `Graph answered ${r.status}`;
    if (item && r.status < 300) a.inst.append('agent', 'delivered', { item, to: r.to, receipt, via: 'graph', run: a.n });
    if (saved) return { status: 200, data: { saved, data: data(r.bytes) } };
    if (!r.bytes.length) return { status: r.status, data: `Graph answered ${r.status}${item && r.status < 300 ? `: ${item} delivered to ${r.to}` : ''}` };
    if (!r.type.includes('json')) throw new HttpError(r.status < 300 ? 400 : r.status, r.status < 300 ? `Graph answered ${r.type || 'bytes'}, ${r.bytes.length} of them: save them with --out FILE` : r.bytes.toString());
    return { status: r.status, data: JSON.parse(r.bytes.toString()) };
  }
  // `open` answers the CDP address's path; rf makes it an address the sandbox reaches (see sandbox.ts).
  if (path === '/agent/browser' && method === 'POST') {
    const [cmd, site, from, to] = await words();
    a.browsers ??= new Browsers(a.inst, a.n);
    if (cmd === 'open' && site) return { status: 200, data: `/browser/${a.token}/${await a.browsers.browser(site)}` };
    if (cmd === 'get' && site && from && to) {
      const bytes = await a.browsers.browserFile(site, from);
      a.inst.append('agent', 'browser', { action: 'get', site, from, file: rel(to) });
      return { status: 200, data: { saved: rel(to), data: data(bytes) } };
    }
    if (cmd === 'expired' && site) return a.browsers.expire(site);
    throw new HttpError(400, 'rf browser open SITE | rf browser get SITE PATH FILE | rf browser expired SITE');
  }
  // The agent's word for an output it delivered through a website; the browser's request log bears it out.
  if (path === '/agent/delivered' && method === 'POST') {
    const { args, rest } = parseArgs(await words()), [to, receipt] = [args.to?.[0], args.receipt?.[0]];
    if (rest.length !== 1 || !to || !receipt) throw new HttpError(400, 'rf delivered ITEM --to WHERE --receipt WHAT');
    if (!a.inst.doc.items.some(i => i.id === rest[0] && i.kind === 'output')) throw new HttpError(400, `${rest[0]} is no output on the screen`);
    a.inst.append('agent', 'delivered', { item: rest[0], to, receipt, via: 'website', run: a.n });
    return { status: 200, data: `recorded: ${rest[0]} delivered to ${to}` };
  }
  return null;
}
