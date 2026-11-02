import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, globSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance, duplicateInstance, forget, renameInstance, replaceReadOnly, HttpError, instance, instances, isPerson, safeName, type Entry, type Instance } from './store.ts';
import { startRun, type Run } from './runner.ts';
import { authenticate, checkConfig, mode, removeUser, signOutEverywhere, upsertUser, users, type Me, type Role } from './auth.ts';
import { initSystem, setOwner, workspace, workspaces } from './system.ts';
import { builtIn, catalog as systemCatalog, missing, removeSystem, savedSystem, saveSystem, view as systemView } from './systems.ts';
import type { Browsing } from './browser.ts';
import { agentCall, skillsText, testSkill } from './agent-api.ts';
import { testM365 } from './m365.ts';
import { seriesSettings } from './series.ts';
import { checkChosen, saveSkillConfig, skill, skills, skillView } from './skills.ts';

const root = resolve(process.argv[2]);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(app, 'web', 'index.html');
const python = join(app, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const exec = promisify(execFile);
const port = Number(process.argv[3] ?? 8780);
const host = process.env.RF_HOST ?? '127.0.0.1';
const LIMIT_MS = Number(process.env.RF_LIMIT_MIN ?? 120) * 60_000;
const tmpDir = join(root, '.tmp');
initSystem(root);
checkConfig(host);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);

type Active = { inst: Instance; n: number; token: string; run?: Run; sent: number; seen: number; texts: Map<string, number>; interrupted: boolean; done: boolean; cost: number; browsing?: Browsing; timer?: NodeJS.Timeout };
const active = new Map<string, Active>();
const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();

function seenBefore(inst: Instance): number {
  return (inst.log.findLast(e => e.op === 'done')?.seen as number | undefined) ?? 0;
}

function pending(inst: Instance, seen: number): Entry[] {
  return inst.log.filter(e => e.seq > seen && isPerson(e) && (['upload', 'answer', 'steer'].includes(e.op) || (e.op === 'create' && e.fetch)));
}

function message(inst: Instance, n: number, entries: Entry[]): string {
  const reads = readable(inst.series()).map(s => `../${s}/`).join(', ');
  const uses = seriesSettings(inst.series()).skills.length ? skillsText(inst.series()).split('\n').join('; ') : '';
  return `Instance ${basename(inst.dir)} (folder ${basename(inst.dir)}/), run ${n}.${reads ? ` Series you can read: ${reads}.` : ''}${uses ? ` Skills you can use: ${uses}.` : ''} New log entries:\n`
    + entries.map(e => JSON.stringify(e)).join('\n');
}

const visibleTo = (seriesDir: string) => seriesSettings(seriesDir).visible_to;

function readable(seriesDir: string): string[] {
  const name = basename(seriesDir), workspaceDir = dirname(seriesDir);
  return dirs(workspaceDir).filter(s => s !== name && visibleTo(join(workspaceDir, s)).some(v => v === '*' || v === name));
}

function kick(inst: Instance) {
  const a = active.get(inst.series());
  if (a) return a.inst === inst && a.run && flush(a);
  clearTimeout(debounce.get(inst.dir));
  debounce.set(inst.dir, setTimeout(() => { debounce.delete(inst.dir); start(inst); }, 1500));
}

function flush(a: Active) {
  const entries = a.inst.log.filter(e => e.seq > a.sent && e.by !== 'agent');
  if (!pending(a.inst, a.sent).length) return;
  const text = message(a.inst, a.n, entries);
  a.sent = entries.at(-1)!.seq;
  a.texts.set(text, a.sent);
  a.run!.steer(text).catch(err => finish(a, true, String(err)));
}

async function start(inst: Instance) {
  const series = inst.series();
  const seen = seenBefore(inst);
  if (active.has(series) || inst.doc.status !== 'open' || !pending(inst, seen).length) return;
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && e.by !== 'agent');
  const text = message(inst, n, entries);
  const a: Active = { inst, n, token: randomUUID(), sent: entries.at(-1)!.seq, seen, texts: new Map([[text, entries.at(-1)!.seq]]), interrupted: false, done: false, cost: 0 };
  active.set(series, a);
  byToken.set(a.token, a);
  inst.append('server', 'run', { run: n, upto: a.sent });
  try {
    a.run = await startRun({
      seriesDir: series, instanceDir: inst.dir, message: text, skills: seriesSettings(series).skills.filter(id => skill(id)),
      env: { RF_URL: `http://127.0.0.1:${port}`, RF_TOKEN: a.token, RF_WORKING: join(inst.dir, 'working') },
      onEvent: e => {
        if (e.type === 'message_end' && e.message.role === 'assistant') a.cost += e.message.usage.cost.total;
        if (e.type !== 'message_start' || e.message.role !== 'user') return;
        const c = e.message.content;
        const seq = a.texts.get(typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join(''));
        if (seq) a.seen = Math.max(a.seen, seq);
      },
    });
  } catch (err) {
    finish(a, true, String(err));
    return;
  }
  flush(a);
  a.timer = setTimeout(async () => {
    a.interrupted = true;
    await a.run!.interrupt().catch(() => {});
    finish(a, true, 'time limit');
  }, LIMIT_MS);
  a.run.settled.then(aborted => finish(a, aborted));
}

function finish(a: Active, aborted: boolean, error?: string) {
  if (a.done) return;
  a.done = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  const series = a.inst.series();
  active.delete(series);
  a.run?.stop();
  a.browsing?.close();
  a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(4), summary: a.inst.doc.summary ?? null, ...(error && { error }) });
  if (!a.run) return; // it never started, as with a missing API key: wait for the next person action rather than retry at once
  if (!a.interrupted && pending(a.inst, a.seen).length) return void start(a.inst);
  const next = instances(series).find(i => i.doc.status === 'open' && !(a.interrupted && i.dir === a.inst.dir) && pending(i, seenBefore(i)).length);
  if (next) start(next);
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
}

async function agent(req: IncomingMessage, res: ServerResponse, url: URL) {
  const a = byToken.get(req.headers.authorization?.replace('Bearer ', '') ?? '');
  if (!a) throw new HttpError(401, 'no run for this token');
  if (url.pathname === '/agent/workspace' && req.method === 'GET') return send(res, 200, a.inst.doc);
  if (url.pathname === '/agent/workspace' && req.method === 'PUT') return send(res, 200, `saved, rev ${a.inst.put((await body(req)).toString())}`);
  if (url.pathname === '/agent/reply' && req.method === 'POST') return send(res, 200, `replied, seq ${a.inst.append('agent', 'reply', { text: (await body(req)).toString() }).seq}`);
  // Skills: rf skills, rf settings, rf files, rf mail, rf flow (see agent-api.ts).
  const r = await agentCall(a, url.pathname, req.method ?? 'GET', url.searchParams, () => body(req));
  if (r) return send(res, r.status, r.data);
  throw new HttpError(404, 'not found');
}

function dirs(path: string): string[] {
  return existsSync(path) ? readdirSync(path).filter(n => !n.startsWith('.') && statSync(join(path, n)).isDirectory()).sort() : [];
}

// Each workspace belongs to one person; admins see them all. A workspace with no owner, such as the demo's, is the admins'.
function canSee(me: Me, ws: string): boolean {
  return me.role === 'admin' || workspace(ws)?.owner === me.email;
}

function mustSee(me: Me, ws: string) {
  if (!canSee(me, ws) || !existsSync(join(root, ws))) throw new HttpError(404, `no workspace ${ws}`);
}

function queued(inst: Instance): boolean {
  const a = active.get(inst.series());
  return a?.inst !== inst && inst.doc.status === 'open' && (debounce.has(inst.dir) || (!!a && pending(inst, seenBefore(inst)).length > 0));
}

function questions(inst: Instance): number {
  if (inst.doc.status !== 'open') return 0;
  return inst.doc.items.flatMap(i => i.notes ?? []).filter(n => n.id && n.options && !inst.answered(n.id)).length;
}

function tree(me: Me) {
  return dirs(root).filter(ws => canSee(me, ws)).map(workspace => ({
    workspace, archived: existsSync(join(root, workspace, '.archived')), owner: workspaceOwner(workspace),
    series: dirs(join(root, workspace)).map(series => ({
      series, archived: existsSync(join(root, workspace, series, '.archived')), ...seriesSettings(join(root, workspace, series)), reads: readable(join(root, workspace, series)),
      instances: instances(join(root, workspace, series)).map(i => ({
        label: basename(i.dir), status: i.doc.status, rev: i.doc.rev, running: active.get(i.series())?.inst === i, queued: queued(i), questions: questions(i),
      })),
    })),
  }));
}

function trace(inst: Instance) {
  const dir = join(inst.dir, 'session');
  type Line = { kind: string; text: string; at?: string; result?: string; lines?: number; error?: boolean };
  const out: Line[] = [], calls = new Map<string, Line>();
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() : []) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.type !== 'message') continue;
      const m = e.message;
      if (m.role === 'user') out.push({ kind: 'user', at: e.timestamp, text: typeof m.content === 'string' ? m.content : m.content.map((b: { text?: string }) => b.text ?? '').join('') });
      if (m.role === 'assistant') for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ kind: 'say', at: e.timestamp, text: b.text });
        if (b.type === 'toolCall') {
          out.push({ kind: b.name, at: e.timestamp, text: b.arguments.command ?? b.arguments.path ?? JSON.stringify(b.arguments) });
          calls.set(b.id, out.at(-1)!);
        }
      }
      if (m.role === 'toolResult') {
        const text = m.content.map((b: { text?: string }) => b.text ?? '').join('');
        Object.assign(calls.get(m.toolCallId)!, { result: text.slice(0, 4000), lines: text.trimEnd().split('\n').length, error: m.isError });
      }
    }
  }
  return out;
}

const workspaceOwner = (ws: string) => workspace(ws)?.owner ?? null;

async function file(me: Me, res: ServerResponse, url: URL, preview: boolean) {
  const [ws, series, label, ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const rel = rest.join('/');
  if (posix.normalize(rel) !== rel || !/^(upload|working|calls)\//.test(rel) || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
  mustSee(me, safeName(ws));
  const dir = join(root, safeName(ws), safeName(series), safeName(label)), path = join(dir, rel);
  if (!existsSync(path)) throw new HttpError(404, 'no such file');
  if (!realpathSync(path).startsWith(realpathSync(dir) + sep)) throw new HttpError(400, 'links must stay inside the instance');
  if (preview) {
    const { stdout } = await exec(python, [join(app, 'src', 'preview.py'), path], { timeout: 30_000, maxBuffer: 64e6 });
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(stdout);
  }
  const image = rel.match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
  res.writeHead(200, {
    'content-type': image ? `image/${image}` : 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'content-disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(rel))}`,
  });
  createReadStream(path).pipe(res);
}

async function people(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [ws, series, label, action] = url.pathname.split('/').slice(2).map(s => safeName(decodeURIComponent(s)));
  const workspaceDir = join(root, ws), by = me.email;
  if (!series) {
    if (req.method === 'POST') {
      if (existsSync(workspaceDir)) {
        if (!canSee(me, ws)) throw new HttpError(409, `the name ${ws} is taken; choose another`);
      } else {
        mkdirSync(workspaceDir);
        setOwner(ws, me.email);
      }
      return send(res, 200, 'ok');
    }
    mustSee(me, ws);
    const { archived, owner } = JSON.parse((await body(req)).toString());
    if (owner !== undefined) {
      if (me.role !== 'admin') throw new HttpError(403, 'only an admin can give a workspace to someone');
      if (owner !== null && !users()[owner]) throw new HttpError(400, `no user ${owner}`);
      setOwner(ws, owner);
    }
    if (archived !== undefined) {
      if (archived) writeFileSync(join(workspaceDir, '.archived'), '');
      else rmSync(join(workspaceDir, '.archived'), { force: true });
    }
    return send(res, 200, 'ok');
  }
  mustSee(me, ws);
  const seriesDir = join(workspaceDir, series);
  if (!label) {
    if (req.method === 'POST') {
      mkdirSync(seriesDir, { recursive: true });
      return send(res, 200, 'ok');
    }
    if (req.method === 'PUT') {
      const { name, visible_to, skills: chosen, archived } = JSON.parse((await body(req)).toString());
      if (!Array.isArray(visible_to) || !visible_to.every(n => typeof n === 'string')) throw new HttpError(400, 'visible_to must be a list of series names');
      const to = safeName(name), updates = new Map([[seriesDir, { ...seriesSettings(seriesDir), visible_to, ...(chosen !== undefined && { skills: checkChosen(chosen) }) }]]);
      if (to !== series) {
        if (existsSync(join(workspaceDir, to))) throw new HttpError(409, `${to} exists`);
        if (active.has(seriesDir) || instances(seriesDir).some(i => debounce.has(i.dir))) throw new HttpError(409, 'wait for the run to end');
        for (const s of dirs(workspaceDir)) {
          const other = seriesSettings(join(workspaceDir, s));
          if (other.visible_to.includes(series)) updates.set(join(workspaceDir, s), { ...other, visible_to: other.visible_to.map(n => (n === series ? to : n)) });
        }
      }
      for (const [dir, settings] of updates) replaceReadOnly(join(dir, 'series.json'), JSON.stringify(settings, null, 1));
      if (archived) writeFileSync(join(seriesDir, '.archived'), '');
      else rmSync(join(seriesDir, '.archived'), { force: true });
      if (to !== series) {
        const dir = resolve(workspaceDir, to);
        renameSync(seriesDir, dir);
        forget(seriesDir);
        for (const f of globSync('*/session/*.jsonl', { cwd: dir })) {
          const text = readFileSync(join(dir, f), 'utf8'), nl = text.indexOf('\n');
          writeFileSync(join(dir, f), JSON.stringify({ ...JSON.parse(text.slice(0, nl)), cwd: dir }) + text.slice(nl));
        }
      }
      return send(res, 200, 'ok');
    }
    return send(res, 200, instances(seriesDir).map(i => ({ label: basename(i.dir), status: i.doc.status, running: active.get(seriesDir)?.inst === i })));
  }
  if (!action && req.method === 'POST') {
    const created = createInstance(seriesDir, label, by);
    kick(created);
    return send(res, 200, created.doc);
  }
  const dir = join(seriesDir, label);
  if (!existsSync(join(dir, 'workspace.json'))) throw new HttpError(404, `no instance ${label}`);
  const inst = instance(dir);
  const a = active.get(seriesDir);
  const mine = a?.inst === inst ? a : undefined;
  if (!action) return send(res, 200, { doc: inst.doc, log: inst.log, run: mine ? { n: mine.n, cost: +mine.cost.toFixed(4) } : null, queued: queued(inst) });
  if (action === 'trace') return send(res, 200, trace(inst));
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (action === 'duplicate') {
    if (inst.doc.status === 'open') throw new HttpError(409, 'only a closed or abandoned instance can be duplicated');
    return send(res, 200, duplicateInstance(inst, url.searchParams.get('as') ?? '', by).doc);
  }
  if (inst.doc.status !== 'open') throw new HttpError(409, `instance is ${inst.doc.status}`);
  if (action === 'upload') {
    const pane = url.searchParams.get('pane') === 'out' ? 'out' : 'in', tmp = join(tmpDir, randomUUID()), hash = createHash('sha256');
    try {
      await pipeline(req, async function* (chunks: AsyncIterable<Buffer>) { for await (const c of chunks) { hash.update(c); yield c; } }, createWriteStream(tmp));
      inst.upload(by, url.searchParams.get('name') ?? 'file', tmp, hash.digest('hex'), pane, url.searchParams.get('onto'));
    } finally {
      rmSync(tmp, { force: true });
    }
  } else if (action === 'answer') {
    const { note, choice } = JSON.parse((await body(req)).toString());
    inst.answer(by, note, choice);
  } else if (action === 'steer') {
    inst.append(by, 'steer', { text: JSON.parse((await body(req)).toString()).text });
  } else if (action === 'interrupt') {
    if (!mine?.run) throw new HttpError(409, 'no run going');
    inst.append(by, 'interrupt');
    mine.interrupted = true;
    await mine.run.interrupt();
    return send(res, 200, 'ok');
  } else if (action === 'rename') {
    if (mine || debounce.has(inst.dir)) throw new HttpError(409, 'wait for the run to end');
    const label = url.searchParams.get('as') ?? '';
    renameInstance(inst, label).append(by, 'rename', { from: basename(inst.dir) });
    return send(res, 200, 'ok');
  } else if (action === 'close' || action === 'abandon') {
    if (mine) throw new HttpError(409, 'wait for the run to end');
    inst[action](by);
    return send(res, 200, 'ok');
  } else throw new HttpError(404, `no action ${action}`);
  kick(inst);
  send(res, 200, 'ok');
}

async function admin(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  const email = decodeURIComponent(url.pathname.split('/')[2] ?? '').toLowerCase();
  if (!email) {
    if (req.method === 'POST') {
      const { email, role } = JSON.parse((await body(req)).toString());
      upsertUser(String(email ?? ''), { role: role === 'admin' ? 'admin' : 'user' });
      return send(res, 200, 'ok');
    }
    const owned = Object.entries(workspaces());
    return send(res, 200, Object.entries(users()).map(([email, { sub, epoch, ...u }]) => ({ email, ...u, workspaces: owned.filter(([, w]) => w.owner === email).map(([n]) => n) })));
  }
  if (!users()[email]) throw new HttpError(404, `no user ${email}`);
  if (req.method === 'DELETE') {
    if (email === me.email) throw new HttpError(409, 'you cannot remove yourself');
    removeUser(email);
  } else if (req.method === 'PUT') {
    const { role, disabled, signout } = JSON.parse((await body(req)).toString());
    if (email === me.email && (disabled || role === 'user')) throw new HttpError(409, 'you cannot lock yourself out');
    if (role !== undefined && role !== 'admin' && role !== 'user') throw new HttpError(400, 'role is admin or user');
    upsertUser(email, { ...(role && { role: role as Role }), ...(disabled !== undefined && { disabled: !!disabled }) });
    if (signout) signOutEverywhere(email);
  } else throw new HttpError(405, 'PUT or DELETE');
  send(res, 200, 'ok');
}

// Skills: anyone signed in may list them with whether each is set up, to choose a series' Skill use; only admins see their
// settings (never a secret, only whether one is saved), change them and test them.
async function skillsRoute(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [id = '', action] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  if (!id && req.method === 'GET') return send(res, 200, skills().map(s => skillView(s, me.role === 'admin')));
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  const s = skill(id);
  if (!s) throw new HttpError(404, `no skill ${id}`);
  if (req.method === 'PUT') {
    saveSkillConfig(id, JSON.parse((await body(req)).toString()), me.email);
    return send(res, 200, skillView(s, true));
  }
  if (action === 'test' && req.method === 'POST') {
    try {
      return send(res, 200, await testSkill(id));
    } catch (e) {
      throw new HttpError((e as HttpError).status === 409 ? 409 : 502, (e as Error).message.split('\n').slice(0, 5).join('\n'));
    }
  }
  throw new HttpError(405, 'PUT, or POST test');
}

// The shared connections: admins only, as series don't choose them.
async function catalog(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [id = '', action] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  if (!id && req.method === 'GET') return send(res, 200, systemCatalog());
  const s = savedSystem(id);
  if (!builtIn(id)) throw new HttpError(404, `no connection ${id}`);
  // A connection may be saved in part, such as its ids before its secret.
  if (req.method === 'PUT') return send(res, 200, systemView(saveSystem(id, JSON.parse((await body(req)).toString()), me.email)));
  if (action === 'test' && req.method === 'POST') {
    const need = missing(s, id);
    if (need.length) throw new HttpError(409, `${builtIn(id)!.name} still needs ${need.join(', ')}`);
    try {
      return send(res, 200, await testM365(s!));
    } catch (e) {
      throw new HttpError(502, (e as Error).message.split('\n').slice(0, 5).join('\n'));
    }
  }
  if (!s) throw new HttpError(404, `${builtIn(id)!.name} is not set up`);
  if (req.method === 'DELETE') return void (removeSystem(s.id), send(res, 200, 'ok'));
  throw new HttpError(405, 'PUT, DELETE, or POST test');
}

createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  try {
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site && site !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    if (url.pathname.startsWith('/agent/')) return await agent(req, res, url);
    const me = await authenticate(req, res, url);
    if (!me) return;
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/me') send(res, 200, { ...me, sign_in: mode });
    else if (url.pathname === '/api') send(res, 200, tree(me));
    else if (url.pathname.startsWith('/files/')) await file(me, res, url, false);
    else if (url.pathname.startsWith('/preview/')) await file(me, res, url, true);
    else if (url.pathname.startsWith('/api/')) await people(me, req, res, url);
    else if (url.pathname === '/users' || url.pathname.startsWith('/users/')) await admin(me, req, res, url);
    else if (url.pathname === '/systems' || url.pathname.startsWith('/systems/')) await catalog(me, req, res, url);
    else if (url.pathname === '/skills' || url.pathname.startsWith('/skills/')) await skillsRoute(me, req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
}).listen(port, host, () => console.log(`rollforward on http://${host}:${port}, data in ${root}, sign-in ${mode}${process.env.RF_TODAY ? `, skills take today as ${process.env.RF_TODAY} (RF_TODAY)` : ''}`));
