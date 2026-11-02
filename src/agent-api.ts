import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { HttpError, workingFile, type Instance } from './store.ts';
import { Browsers, passUpgrade } from './machines.ts';
import { children, messages, shared } from './graph.ts';
import { day, filesGet, filesList, localDate, mailFind, mailSave, type Args } from './m365.ts';
import { seriesSettings } from './series.ts';
import { settingsOf, skill, skillMissing, type Skill } from './skills.ts';

// The agent's use of its series' skills, behind `rf`: shared by the server, for runs, and by `cli.ts try`, which lets an admin run
// a skill's steps without the model.
//   GET  /agent/skills             the series' skills, and how to use them
//   GET  /agent/settings?skill=ID  a chosen skill's settings, as JSON
//   POST /agent/files {args}       rf files list|get …, through the runner's Microsoft 365 login, as far as the instance's ticks offer
//   POST /agent/mail {args}        rf mail find|save …, likewise
//   POST /agent/browser {args}     rf browser open SITE | get SITE PATH FILE: a browser on a skill's website, in the runner's login

// A run as the agent API sees it: its instance, its number and token, and its browsers.
export type AgentRun = { inst: Instance; n: number; token: string; browsers?: Browsers };

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

const chosenSkills = (seriesDir: string) => seriesSettings(seriesDir).skills.map(id => skill(id)).filter((s): s is Skill => !!s);

export function skillsText(seriesDir: string): string {
  return chosenSkills(seriesDir).map(s => {
    const need = skillMissing(s), how = [
      ...(s.site ? [`rf browser open ${s.id}`] : []),
      ...(s.uses.includes('m365-files') ? ['rf files'] : []), ...(s.uses.includes('m365-mail') ? ['rf mail'] : []),
      ...(s.settings.length ? [`rf settings ${s.id}`] : []),
    ];
    return `${s.id}${how.length ? ` (${how.join(', ')})` : ''}${need.length ? `: not set up yet, it needs ${need.join(', ')}` : ''}`;
  }).join('\n') || 'None: this series\' Skill use is empty.';
}

// rf skill test: one that reads Microsoft 365 does so as the admin testing it, `email`, through their own login: each link in its
// settings, and today's mail with its subject.
export async function testSkill(id: string, email: string): Promise<string> {
  const s = skill(id);
  if (!s) throw new HttpError(404, `no skill ${id}`);
  const need = skillMissing(s);
  if (need.length) throw new HttpError(409, `${s.name} still needs ${need.join(', ')}`);
  const values = settingsOf(s), out: string[] = [];
  if (s.uses.includes('m365-files')) for (const [k, v] of Object.entries(values).filter(([, v]) => /^https?:\/\//.test(v))) {
    const it = await shared(email, v);
    out.push(`${s.settings.find(f => f.key === k)?.label ?? k}: ${it.name}${it.folder ? `, a folder of ${(await children(email, it)).length} items` : `, changed ${it.lastModifiedDateTime}`}`);
  }
  if (s.uses.includes('m365-mail')) {
    const d = process.env.RF_TODAY ?? localDate(), want = values.subject?.toLowerCase() ?? '';
    const found = (await messages(email, email, day(d), day(d, 1))).filter(m => (m.subject ?? '').toLowerCase().includes(want));
    out.push(`${email}: ${found.length} mail${found.length === 1 ? '' : 's'} on ${d}${want ? ' with that subject' : ''}`);
  }
  return out.join('\n') || `${s.name} is set up.`;
}

// The agent API on a port of its own, for one stand-in run: what `cli.ts try` and the tests use in place of the server.
export async function serveAgent(inst: Instance): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomUUID(), a: AgentRun = { inst, n: 0, token };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x'), send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }).end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    try {
      if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'no run for this token');
      const r = await agentCall(a, url.pathname, req.method ?? 'GET', url.searchParams, async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); });
      if (!r) throw new HttpError(404, 'not found');
      send(r.status, r.data);
    } catch (e) {
      send((e as HttpError).status ?? 500, (e as Error).message);
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const [, root, t, id] = new URL(req.url!, 'http://x').pathname.split('/');
    if (root !== 'browser' || t !== token || !a.browsers?.owns(id)) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    passUpgrade(req, socket, head, `/sessions/${id}/cdp`);
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token,
    async close() { await a.browsers?.close(); server.close(); server.closeAllConnections(); },
  };
}

export async function agentCall(a: AgentRun, path: string, method: string, query: URLSearchParams, body: () => Promise<Buffer>): Promise<{ status: number; data: unknown } | null> {
  const seriesDir = a.inst.series(), working = join(a.inst.dir, 'working');
  const json = async () => { try { return JSON.parse((await body()).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); } };
  const words = async () => ((await json()).args ?? []).map(String) as string[];
  if (path === '/agent/skills' && method === 'GET') return { status: 200, data: skillsText(seriesDir) };
  if (path === '/agent/settings' && method === 'GET') {
    const chosen = chosenSkills(seriesDir), id = query.get('skill') ?? '', s = chosen.find(x => x.id === id);
    if (!id) return { status: 200, data: Object.fromEntries(chosen.map(x => [x.id, settingsOf(x)])) };
    if (!s) throw new HttpError(403, `${id} is not in this series' Skill use; it has ${chosen.map(x => x.id).join(', ') || 'none'}`);
    return { status: 200, data: settingsOf(s) };
  }
  if (path === '/agent/files' && method === 'POST') {
    const { rest } = parseArgs(await words()), [cmd, target, file] = rest;
    mkdirSync(working, { recursive: true });
    if (cmd === 'list' && target) {
      const out = await filesList(a.inst, target);
      a.inst.append('agent', 'files', { action: 'list', target: out.name, items: 'items' in out ? (out.items as unknown[]).length : undefined });
      return { status: 200, data: out };
    }
    if (cmd === 'get' && target && file) {
      const out = await filesGet(a.inst, target, workingFile(a.inst.dir, file));
      a.inst.append('agent', 'files', { action: 'get', name: out.name, modified: out.modified, file: `working/${file.replace(/^working\//, '')}` });
      return { status: 200, data: { ...out, saved: `working/${file.replace(/^working\//, '')}` } };
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
      mkdirSync(working, { recursive: true });
      let name: RegExp | undefined;
      try { name = args.name ? new RegExp(args.name[0], 'i') : undefined; } catch { throw new HttpError(400, '--name is a regular expression'); }
      const saved = await mailSave(a.inst, args, rest[1], name, working, args.prefix?.[0] ?? '');
      a.inst.append('agent', 'mail', { action: 'save', saved });
      return { status: 200, data: { saved } };
    }
    throw new HttpError(400, 'rf mail find [--mailbox ADDRESS] [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | save ID [--mailbox ADDRESS] [--name REGEX] [--prefix TEXT]');
  }
  // `open` answers the CDP address's path; rf makes it an address the sandbox reaches (see sandbox.ts).
  if (path === '/agent/browser' && method === 'POST') {
    const [cmd, site, from, to] = await words();
    if (!chosenSkills(seriesDir).some(s => s.id === site)) throw new HttpError(403, `${site} is not in this series' Skill use`);
    a.browsers ??= new Browsers(a.inst, a.n);
    if (cmd === 'open' && site) return { status: 200, data: `/browser/${a.token}/${await a.browsers.session(site)}` };
    if (cmd === 'get' && site && from && to) {
      writeFileSync(workingFile(a.inst.dir, to), await a.browsers.file(site, from));
      return { status: 200, data: `saved working/${to.replace(/^working\//, '')}` };
    }
    throw new HttpError(400, 'rf browser open SITE | rf browser get SITE PATH FILE');
  }
  return null;
}
