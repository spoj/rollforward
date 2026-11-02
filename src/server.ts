import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance, duplicateInstance, renameInstance, replaceReadOnly, HttpError, instance, instanceDir, instances, isPerson, labels, newId, openStore, safeName, seriesDir, type Entry, type Instance } from './store.ts';
import { socketDir, startRun, type Run, type View } from './runner.ts';
import { serveSandboxes } from './sandbox.ts';
import { authenticate, checkConfig, mode, removeUser, signOutEverywhere, upsertUser, users, type Me, type Role } from './auth.ts';
import { initSystem, saveTree, tree, type Tree, type Workspace } from './system.ts';
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
openStore(root);
checkConfig(host);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);

type Active = { inst: Instance; n: number; token: string; run?: Run; sent: number; seen: number; texts: Map<string, number>; interrupted: boolean; done: boolean; cost: number; hosts: Set<string>; browsing?: Browsing; timer?: NodeJS.Timeout };
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
  const t = tree(), here = t.series[inst.seriesId].workspace;
  const reads = reach(t, inst.seriesId).map(id => (t.series[id].workspace === here ? `../${t.series[id].name}/` : `../../${named(t, id)}/`)).join(', ');
  const uses = seriesSettings(inst.series()).skills.length ? skillsText(inst.series()).split('\n').join('; ') : '';
  return `Instance ${inst.label} (folder ${inst.label}/), run ${n}.${reads ? ` Series you can read: ${reads}.` : ''}${uses ? ` Skills you can use: ${uses}.` : ''} New log entries:\n`
    + entries.map(e => JSON.stringify(e)).join('\n');
}

// What a series' agent may read: the other series of its workspace, and those of any workspace that has everyone this one has, by
// the same email or group, so nothing it reads reaches someone who couldn't see it already. A workspace with no one in it reads only
// itself.
function reach(t: Tree, seriesId: string): string[] {
  const ws = t.series[seriesId].workspace, people = everyone(t.workspaces[ws]);
  const reads = (o: string) => o === ws || (people.length > 0 && people.every(p => everyone(t.workspaces[o]).includes(p)));
  return Object.keys(t.series).filter(id => id !== seriesId && reads(t.series[id].workspace)).sort((a, b) => named(t, a).localeCompare(named(t, b)));
}

const everyone = (w: Workspace) => [...w.owners, ...w.members];
const named = (t: Tree, seriesId: string) => `${t.workspaces[t.series[seriesId].workspace].name}/${t.series[seriesId].name}`;

// The run's view of the data, by name: /work/<workspace>/<series>/<label>/ for every instance in its reach, built when it starts.
function view(inst: Instance): View {
  const t = tree(), at = (id: string) => `/work/${named(t, id)}`;
  const ro = [inst.seriesId, ...reach(t, inst.seriesId)].flatMap(id => [
    ...labels(id).map(l => [instanceDir(l.id), `${at(id)}/${l.label}`] as [string, string]),
    ...(id === inst.seriesId ? [] : [[join(seriesDir(id), '.pylib'), `${at(id)}/.pylib`] as [string, string]]),
  ]);
  return { cwd: at(inst.seriesId), instance: `${at(inst.seriesId)}/${inst.label}`, dir: inst.dir, pylib: join(inst.series(), '.pylib'), ro };
}

function kick(inst: Instance) {
  const a = active.get(inst.seriesId);
  if (a) return a.inst === inst && a.run && flush(a);
  clearTimeout(debounce.get(inst.id));
  debounce.set(inst.id, setTimeout(() => { debounce.delete(inst.id); start(inst); }, 1500));
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
  const series = inst.seriesId;
  const seen = seenBefore(inst);
  if (active.has(series) || inst.doc.status !== 'open' || !pending(inst, seen).length) return;
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && e.by !== 'agent');
  const text = message(inst, n, entries);
  const a: Active = { inst, n, token: randomUUID(), sent: entries.at(-1)!.seq, seen, texts: new Map([[text, entries.at(-1)!.seq]]), interrupted: false, done: false, cost: 0, hosts: new Set() };
  active.set(series, a);
  byToken.set(a.token, a);
  inst.append('server', 'run', { run: n, upto: a.sent });
  try {
    a.run = await startRun({
      token: a.token, view: view(inst),
      message: text, skills: seriesSettings(inst.series()).skills.filter(id => skill(id)),
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
  const series = a.inst.seriesId;
  active.delete(series);
  a.run?.stop();
  a.browsing?.close();
  a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(4), summary: a.inst.doc.summary ?? null, ...(error && { error }) });
  if (!a.run) return; // it never started, as with a missing API key: wait for the next person action rather than retry at once
  if (!a.interrupted && pending(a.inst, a.seen).length) return void start(a.inst);
  const next = instances(series).find(i => i.doc.status === 'open' && !(a.interrupted && i === a.inst) && pending(i, seenBefore(i)).length);
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

// Owners and members see a workspace and everything in it, by their email or an Entra group they're in; admins see every one. A
// workspace with no one in it, such as the demo's, is the admins'. Owners and admins manage who is in it.
const isIn = (me: Me, people: string[]) => people.some(p => p === me.email || me.groups.includes(p));
const canSee = (me: Me, w: Workspace) => me.role === 'admin' || isIn(me, everyone(w));
const canManage = (me: Me, w: Workspace) => me.role === 'admin' || isIn(me, w.owners);

function mustSee(me: Me, w: Workspace | undefined): Workspace {
  if (!w || !canSee(me, w)) throw new HttpError(404, 'no such workspace');
  return w;
}

function queued(inst: Instance): boolean {
  const a = active.get(inst.seriesId);
  return a?.inst !== inst && inst.doc.status === 'open' && (debounce.has(inst.id) || (!!a && pending(inst, seenBefore(inst)).length > 0));
}

function questions(inst: Instance): number {
  if (inst.doc.status !== 'open') return 0;
  return inst.doc.items.flatMap(i => i.notes ?? []).filter(n => n.id && n.options && !inst.answered(n.id)).length;
}

function listing(me: Me) {
  const t = tree(), byName = (a: [string, { name: string }], b: [string, { name: string }]) => a[1].name.localeCompare(b[1].name);
  return Object.entries(t.workspaces).filter(([, w]) => canSee(me, w)).sort(byName).map(([id, w]) => ({
    id, name: w.name, archived: !!w.archived, owners: w.owners, members: w.members, manage: canManage(me, w),
    series: Object.entries(t.series).filter(([, s]) => s.workspace === id).sort(byName).map(([sid, s]) => ({
      id: sid, name: s.name, archived: !!s.archived, ...seriesSettings(seriesDir(sid)), reads: reach(t, sid).map(r => named(t, r).replace('/', ' / ')),
      instances: instances(sid).map(i => ({
        id: i.id, label: i.label, status: i.doc.status, rev: i.doc.rev, running: active.get(sid)?.inst === i, queued: queued(i), questions: questions(i),
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

async function file(me: Me, res: ServerResponse, url: URL, preview: boolean) {
  const [id, ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const rel = rest.join('/');
  if (posix.normalize(rel) !== rel || !/^(upload|working|calls)\//.test(rel) || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
  const inst = instance(id);
  mustSee(me, tree().workspaces[tree().series[inst.seriesId].workspace]);
  const path = join(inst.dir, rel);
  if (!existsSync(path)) throw new HttpError(404, 'no such file');
  if (!realpathSync(path).startsWith(realpathSync(inst.dir) + sep)) throw new HttpError(400, 'links must stay inside the instance');
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

const json = async (req: IncomingMessage) => JSON.parse((await body(req)).toString() || '{}');
const people = (w: { owners?: unknown; members?: unknown }) => [w.owners, w.members].map(list => {
  const ok = Array.isArray(list) && list.every(p => typeof p === 'string' && /^[^@\s]+@[^@\s]+$|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p));
  if (!ok) throw new HttpError(400, `owners and members are lists of emails and Entra group ids: ${JSON.stringify(list)}`);
  return (list as string[]).map(p => p.toLowerCase());
});

// Workspaces, series and instances, by id. Renaming a workspace or a series edits .rf/tree.json, so it may happen mid-run; a run sees
// the new names from its next start.
async function api(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [kind, id = '', action] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const t = tree(), by = me.email;
  if (kind === 'workspaces' && !id && req.method === 'POST') {
    const name = safeName(String((await json(req)).name ?? ''));
    if (Object.values(t.workspaces).some(w => w.name === name)) throw new HttpError(409, `the name ${name} is taken; choose another`);
    const wid = newId();
    t.workspaces[wid] = { name, owners: [me.email], members: [] };
    saveTree(t);
    return send(res, 200, { id: wid });
  }
  if (kind === 'workspaces' && req.method === 'PUT') {
    const w = mustSee(me, t.workspaces[id]);
    if (!canManage(me, w)) throw new HttpError(403, "only the workspace's owners and admins change it");
    const change = await json(req);
    if (change.name !== undefined) {
      const name = safeName(String(change.name));
      if (name !== w.name && Object.values(t.workspaces).some(x => x.name === name)) throw new HttpError(409, `the name ${name} is taken; choose another`);
      w.name = name;
    }
    if (change.owners !== undefined || change.members !== undefined) [w.owners, w.members] = people({ owners: w.owners, members: w.members, ...change });
    if (change.archived !== undefined) w.archived = !!change.archived;
    saveTree(t);
    return send(res, 200, 'ok');
  }
  if (kind === 'series' && !id && req.method === 'POST') {
    const { workspace, name: asked } = await json(req), name = safeName(String(asked ?? ''));
    mustSee(me, t.workspaces[workspace]);
    if (Object.values(t.series).some(s => s.workspace === workspace && s.name === name)) throw new HttpError(409, `${name} exists`);
    const sid = newId();
    t.series[sid] = { name, workspace };
    mkdirSync(seriesDir(sid));
    saveTree(t);
    return send(res, 200, { id: sid });
  }
  if (kind === 'series') {
    const s = t.series[id];
    mustSee(me, s && t.workspaces[s.workspace]);
    if (req.method === 'POST') {
      const created = createInstance(id, String((await json(req)).label ?? ''), by);
      kick(created);
      return send(res, 200, { id: created.id });
    }
    if (req.method !== 'PUT') throw new HttpError(405, 'PUT, or POST a new instance');
    const change = await json(req);
    if (change.name !== undefined) {
      const name = safeName(String(change.name));
      if (name !== s.name && Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
    }
    if (change.archived !== undefined) s.archived = !!change.archived;
    saveTree(t);
    if (change.skills !== undefined) replaceReadOnly(join(seriesDir(id), 'series.json'), JSON.stringify({ skills: checkChosen(change.skills) }, null, 1));
    return send(res, 200, 'ok');
  }
  if (kind !== 'instances') throw new HttpError(404, 'not found');
  const inst = instance(id);
  mustSee(me, t.workspaces[t.series[inst.seriesId].workspace]);
  const a = active.get(inst.seriesId);
  const mine = a?.inst === inst ? a : undefined;
  if (!action) return send(res, 200, { doc: inst.doc, log: inst.log, run: mine ? { n: mine.n, cost: +mine.cost.toFixed(4) } : null, queued: queued(inst) });
  if (action === 'trace') return send(res, 200, trace(inst));
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (action === 'duplicate') {
    if (inst.doc.status === 'open') throw new HttpError(409, 'only a closed or abandoned instance can be duplicated');
    return send(res, 200, { id: duplicateInstance(inst, url.searchParams.get('as') ?? '', by).id });
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
    if (a || debounce.has(inst.id)) throw new HttpError(409, "wait for the series' run to end");
    const from = inst.label;
    renameInstance(inst, url.searchParams.get('as') ?? '');
    inst.append(by, 'rename', { from });
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
    const all = Object.values(tree().workspaces);
    return send(res, 200, Object.entries(users()).map(([email, { sub, epoch, groups, ...u }]) => ({ email, ...u, workspaces: all.filter(w => everyone(w).includes(email)).map(w => w.name) })));
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

mkdirSync(socketDir, { recursive: true });
serveSandboxes(join(socketDir, 'rf.sock'), {
  agent: async (req, res, url) => {
    try {
      await agent(req, res, url);
    } catch (err) {
      send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
    }
  },
  run: token => {
    const a = byToken.get(token);
    return a && {
      egress(host, allowed) {
        if (a.hosts.has(host)) return;
        a.hosts.add(host);
        a.inst.append('server', 'egress', { run: a.n, host, allowed });
      },
    };
  },
});

createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  try {
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site && site !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    const me = await authenticate(req, res, url);
    if (!me) return;
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/me') send(res, 200, { ...me, sign_in: mode });
    else if (url.pathname === '/api') send(res, 200, listing(me));
    else if (url.pathname.startsWith('/files/')) await file(me, res, url, false);
    else if (url.pathname.startsWith('/preview/')) await file(me, res, url, true);
    else if (url.pathname.startsWith('/api/')) await api(me, req, res, url);
    else if (url.pathname === '/users' || url.pathname.startsWith('/users/')) await admin(me, req, res, url);
    else if (url.pathname === '/systems' || url.pathname.startsWith('/systems/')) await catalog(me, req, res, url);
    else if (url.pathname === '/skills' || url.pathname.startsWith('/skills/')) await skillsRoute(me, req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
}).listen(port, host, () => console.log(`rollforward on http://${host}:${port}, data in ${root}, sign-in ${mode}${process.env.RF_TODAY ? `, skills take today as ${process.env.RF_TODAY} (RF_TODAY)` : ''}`));
