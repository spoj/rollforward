import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError, type Instance } from './store.ts';
import { Browsers, passUpgrade } from './browsers.ts';
import { filesGet, filesList, mailFind, mailSave, type Args } from './m365.ts';

// What only a run has, behind `rf`: its runner's logins and browsers. (For its own instance, its screen,
// threads and wakes, `rf` calls the people's API; see server.ts.) Shared by the server, for runs, and by `cli.ts try`, which lets
// an admin run a skill's steps without the model.
//   POST /agent/files {args}       rf files list|get …, through the runner's Microsoft 365 login, as far as the instance's ticks offer
//   POST /agent/mail {args}        rf mail find|save …, likewise
//   POST /agent/browser {args}     rf browser open SITE | get SITE PATH FILE: a browser on a website, in the runner's login
// The server never reads or writes the run's files: rf does, in the sandbox. A file coming back travels as `data`, base64, in the
// answer, with `saved`, the FILE rf saves it as.

// A run as the agent API sees it: its instance, its number and token, and its browsers.
export type AgentRun = { inst: Instance; n: number; token: string; browsers?: Browsers };

// A file's name under working/, as the screen names it.
const rel = (file: string) => `working/${file.replace(/^working\//, '')}`;

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
  if (path === '/agent/files' && method === 'POST') {
    const { rest } = parseArgs(await words()), [cmd, target, file] = rest;
    if (cmd === 'list' && target) {
      const out = await filesList(a.inst, target);
      a.inst.append('agent', 'files', { action: 'list', target: out.name, items: 'items' in out ? (out.items as unknown[]).length : undefined });
      return { status: 200, data: out };
    }
    if (cmd === 'get' && target && file) {
      const { bytes, ...out } = await filesGet(a.inst, target);
      a.inst.append('agent', 'files', { action: 'get', name: out.name, modified: out.modified, file: rel(file) });
      return { status: 200, data: { ...out, saved: rel(file), data: data(bytes) } };
    }
    throw new HttpError(400, 'rf files list LINK|REF | get LINK|REF FILE');
  }
  if (path === '/agent/mail' && method === 'POST') {
    const { args, rest } = parseArgs(await words());
    if (rest[0] === 'find') {
      const out = await mailFind(a.inst, args);
      a.inst.append('agent', 'mail', { action: 'find', mailbox: out.mailbox, date: out.date, subject: args.subject?.[0], found: out.messages.length });
      return { status: 200, data: out };
    }
    if (rest[0] === 'save' && rest[1]) {
      let name: RegExp | undefined;
      try { name = args.name ? new RegExp(args.name[0], 'i') : undefined; } catch { throw new HttpError(400, '--name is a regular expression'); }
      const found = await mailSave(a.inst, args, rest[1], name);
      const names = found.map(f => (args.prefix?.[0] ?? '') + f.name);
      a.inst.append('agent', 'mail', { action: 'save', saved: names });
      return { status: 200, data: { attachments: found.map((f, i) => ({ name: names[i], data: data(f.bytes) })) } };
    }
    throw new HttpError(400, 'rf mail find [--mailbox ADDRESS] [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | save ID [--mailbox ADDRESS] [--name REGEX] [--prefix TEXT]');
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
    throw new HttpError(400, 'rf browser open SITE | rf browser get SITE PATH FILE');
  }
  return null;
}
