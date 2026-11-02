import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { HttpError, type Instance } from './store.ts';
import { Browsing, testLogin, workingFile } from './browser.ts';
import { children, messages, shared } from './graph.ts';
import { day, filesGet, filesList, localDate, mailFind, mailSave, type Args } from './m365.ts';
import { seriesSettings } from './series.ts';
import { loadSignIn, publicSettings, siteOf, skill, skillMissing, type Skill } from './skills.ts';
import { builtIn, system, type System } from './systems.ts';

// The agent's use of its series' skills, behind `rf`: shared by the server, for runs, and by `cli.ts try`, which lets an admin run
// a skill's steps without the model.
//   GET  /agent/skills             the series' skills, and how to use them
//   GET  /agent/settings?skill=ID  a chosen skill's settings, but its secrets, as JSON
//   POST /agent/files {args}       rf files list|get …, if a chosen skill uses M365 OneDrive
//   POST /agent/mail {args}        rf mail find|save …, if a chosen skill uses M365 Mail
//   POST /agent/flow {args}        rf flow SKILL/FLOW [--var NAME=VALUE …], in the skill's website

export type AgentRun = { inst: Instance; browsing?: Browsing };

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

// A shared connection a chosen skill uses, ready.
function connection(seriesDir: string, id: string, what: string): System {
  const name = builtIn(id)!.name;
  if (!chosenSkills(seriesDir).some(s => s.uses.includes(id))) throw new HttpError(403, `no skill in this series' Skill use uses ${name}, so ${what} can't be used`);
  const s = system(id);
  if (!s) throw new HttpError(409, `${name} is not set up yet: an admin sets it up under Systems`);
  return s;
}

export function skillsText(seriesDir: string): string {
  return chosenSkills(seriesDir).map(s => {
    const need = skillMissing(s), how = [
      ...(s.flows.length ? [`rf flow ${s.flows.map(f => `${s.id}/${f}`).join(' | ')}`] : []),
      ...(s.uses.includes('m365-files') ? ['rf files'] : []), ...(s.uses.includes('m365-mail') ? ['rf mail'] : []),
      ...(s.settings.length ? [`rf settings ${s.id}`] : []),
    ];
    return `${s.id}${how.length ? ` (${how.join(', ')})` : ''}${need.length ? `: not set up yet, it needs ${need.join(', ')}` : ''}`;
  }).join('\n') || 'None: this series\' Skill use is empty.';
}

// Skills page Test: each reads something real. A skill with a website signs in to it, code and all; one that reads through the
// Microsoft 365 connections reads each link in its settings, and today's mail with its subject.
export async function testSkill(id: string): Promise<string> {
  const s = skill(id);
  if (!s) throw new HttpError(404, `no skill ${id}`);
  const need = skillMissing(s);
  if (need.length) throw new HttpError(409, `${s.name} still needs ${need.join(', ')}`);
  if (s.site) return testLogin(siteOf(s), await loadSignIn(s));
  const values = publicSettings(s), out: string[] = [];
  if (s.uses.includes('m365-files')) for (const [k, v] of Object.entries(values).filter(([, v]) => /^https?:\/\//.test(v))) {
    const files = system('m365-files')!, it = await shared(files, v);
    out.push(`${s.settings.find(f => f.key === k)?.label ?? k}: ${it.name}${it.folder ? `, a folder of ${(await children(files, it)).length} items` : `, changed ${it.lastModifiedDateTime}`}`);
  }
  if (s.uses.includes('m365-mail')) {
    const mail = system('m365-mail')!, d = process.env.RF_TODAY ?? localDate(), want = values.subject?.toLowerCase() ?? '';
    const found = (await messages(mail, mail.settings!.mailbox, day(d), day(d, 1))).filter(m => (m.subject ?? '').toLowerCase().includes(want));
    out.push(`${mail.settings!.mailbox}: ${found.length} mail${found.length === 1 ? '' : 's'} on ${d}${want ? ' with that subject' : ''}`);
  }
  return out.join('\n') || `${s.name} is set up.`;
}

// The agent API on a port of its own, for one stand-in run: what `cli.ts try` and the tests use in place of the server.
export async function serveAgent(a: AgentRun): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomUUID();
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
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token,
    async close() { await a.browsing?.close(); server.close(); server.closeAllConnections(); },
  };
}

export async function agentCall(a: AgentRun, path: string, method: string, query: URLSearchParams, body: () => Promise<Buffer>): Promise<{ status: number; data: unknown } | null> {
  const seriesDir = a.inst.series(), working = join(a.inst.dir, 'working');
  const json = async () => { try { return JSON.parse((await body()).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); } };
  const words = async () => ((await json()).args ?? []).map(String) as string[];
  if (path === '/agent/skills' && method === 'GET') return { status: 200, data: skillsText(seriesDir) };
  if (path === '/agent/settings' && method === 'GET') {
    const chosen = chosenSkills(seriesDir), id = query.get('skill') ?? '', s = chosen.find(x => x.id === id);
    if (!id) return { status: 200, data: Object.fromEntries(chosen.map(x => [x.id, publicSettings(x)])) };
    if (!s) throw new HttpError(403, `${id} is not in this series' Skill use; it has ${chosen.map(x => x.id).join(', ') || 'none'}`);
    return { status: 200, data: publicSettings(s) };
  }
  if (path === '/agent/files' && method === 'POST') {
    const s = connection(seriesDir, 'm365-files', 'rf files'), { rest } = parseArgs(await words()), [cmd, target, file] = rest;
    mkdirSync(working, { recursive: true });
    if (cmd === 'list' && target) {
      const out = await filesList(s, target);
      a.inst.append('agent', 'files', { action: 'list', target: out.name, items: 'items' in out ? (out.items as unknown[]).length : undefined });
      return { status: 200, data: out };
    }
    if (cmd === 'get' && target && file) {
      const out = await filesGet(s, target, workingFile(a.inst.dir, file));
      a.inst.append('agent', 'files', { action: 'get', name: out.name, modified: out.modified, file: `working/${file.replace(/^working\//, '')}` });
      return { status: 200, data: { ...out, saved: `working/${file.replace(/^working\//, '')}` } };
    }
    throw new HttpError(400, 'rf files list LINK|REF | get LINK|REF FILE');
  }
  if (path === '/agent/mail' && method === 'POST') {
    const s = connection(seriesDir, 'm365-mail', 'rf mail'), { args, rest } = parseArgs(await words());
    if (rest[0] === 'find') {
      const out = await mailFind(s, args);
      a.inst.append('agent', 'mail', { action: 'find', date: out.date, subject: args.subject?.[0], found: out.messages.length });
      return { status: 200, data: out };
    }
    if (rest[0] === 'save' && rest[1]) {
      mkdirSync(working, { recursive: true });
      let name: RegExp | undefined;
      try { name = args.name ? new RegExp(args.name[0], 'i') : undefined; } catch { throw new HttpError(400, '--name is a regular expression'); }
      const saved = await mailSave(s, rest[1], name, working, args.prefix?.[0] ?? '');
      a.inst.append('agent', 'mail', { action: 'save', saved });
      return { status: 200, data: { saved } };
    }
    throw new HttpError(400, 'rf mail find [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | save ID [--name REGEX] [--prefix TEXT]');
  }
  if (path === '/agent/flow' && method === 'POST') {
    const [name = '', ...rest] = await words();
    a.browsing ??= new Browsing(a.inst, seriesSettings(seriesDir).skills);
    return { status: 200, data: await a.browsing.flow(name, rest) };
  }
  return null;
}
