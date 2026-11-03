import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError, type Instance } from './store.ts';
import { Browsers, serveBrowsers, upgradeBrowser } from './browsers.ts';

// What only a run has, behind `rf`: its runner's browsers. (For its own instance, its screen,
// threads and wakes, `rf` calls the people's API; see server.ts.) Shared by the server, for runs, and by `cli.ts try`, which lets
// an admin run a skill's steps without the model.
//   POST /agent/expired {args}     rf expired SITE: the website signed the run out, so its runner signs in to it again
// A run's browsers are at $RF_BROWSERS/SITE, on its socket (see browsers.ts).
// A run as the agent API sees it: its instance, its number, and its browsers.
export type AgentRun = { inst: Instance; n: number; browsers?: Browsers };

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
export async function serveAgent(inst: Instance): Promise<{ url: string; token: string; browsers(): Browsers; close(): Promise<void> }> {
  const token = randomUUID(), a: AgentRun = { inst, n: 0 }, browsers = () => (a.browsers ??= new Browsers(inst, 0));
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }).end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    try {
      const url = new URL(req.url!, 'http://x'), [, root, t, ...rest] = url.pathname.split('/');
      if (root === 'browsers' && t === token) return await serveBrowsers(browsers(), `/browsers/${token}`, rest, req, res);
      if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'no run for this token');
      const r = await agentCall(a, url.pathname, req.method ?? 'GET', async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); });
      if (!r) throw new HttpError(404, 'not found');
      send(r.status, r.data);
    } catch (e) {
      if (res.headersSent) res.destroy();
      else send((e as HttpError).status ?? 500, (e as Error).message);
    }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const [, root, t, site, ...rest] = URL.parse(req.url!, 'http://x')?.pathname.split('/') ?? [];
    if (root !== 'browsers' || t !== token || !site || rest.length) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    upgradeBrowser(browsers(), site, req, socket, head);
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, browsers,
    async close() { await a.browsers?.end(); server.close(); server.closeAllConnections(); },
  };
}

export async function agentCall(a: AgentRun, path: string, method: string, body: () => Promise<Buffer>): Promise<{ status: number; data: unknown } | null> {
  const json = async () => { try { return JSON.parse((await body()).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); } };
  const words = async () => ((await json()).args ?? []).map(String) as string[];
  if (path === '/agent/expired' && method === 'POST') {
    const [site, ...more] = await words();
    if (!site || more.length) throw new HttpError(400, 'rf expired SITE');
    return (a.browsers ??= new Browsers(a.inst, a.n)).expire(site);
  }
  // The agent's word for an output it delivered; the run's calls, or its browser's request log, bear it out.
  if (path === '/agent/delivered' && method === 'POST') {
    const { args, rest } = parseArgs(await words()), [to, receipt] = [args.to?.[0], args.receipt?.[0]];
    if (rest.length !== 1 || !to || !receipt) throw new HttpError(400, 'rf delivered ITEM --to WHERE --receipt WHAT');
    if (!a.inst.doc.items.some(i => i.id === rest[0] && i.kind === 'output')) throw new HttpError(400, `${rest[0]} is no output on the screen`);
    a.inst.append('agent', 'delivered', { item: rest[0], to, receipt, run: a.n });
    return { status: 200, data: `recorded: ${rest[0]} delivered to ${to}` };
  }
  return null;
}
