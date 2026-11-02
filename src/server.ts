import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance, duplicateInstance, guidanceFile, moveInstance, renameInstance, replaceReadOnly, HttpError, instance, instances, newId, openStore, safeName, seriesDir, type Instance } from './store.ts';
import { socketDir } from './runner.ts';
import { serveSandboxes } from './sandbox.ts';
import { authenticate, checkConfig, connectM365, m365Ready, mode, myTokens, newToken, removeUser, revokeToken, ROLES, session, signOutEverywhere, upsertUser, users, type Me, type Role } from './auth.ts';
import { canManage, canSee, changes, everyone, initSystem, saveTree, tree, type Workspace } from './system.ts';
import { checkTicks, logins, runnerOf, signOut } from './logins.ts';
import { agentCall, testSkill } from './agent-api.ts';
import { endSignIn, isSignIn, passUpgrade, startSignIn, viewPage } from './machines.ts';
import { offer, unoffer } from './m365.ts';
import { seriesSettings } from './series.ts';
import { checkChosen, openSkills, pushSkill, saveSkillConfig, skill, skills, skillView, versionFiles, versionsOf } from './skills.ts';
import { active, byToken, cancelWake, closed, dropRequest, kick, MAX_OPEN, named, queued, reach, setWake, startWaking, startWith, wakeFrom, wakes } from './waker.ts';

const root = resolve(process.argv[2]);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(app, 'web', 'index.html');
const python = join(app, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const exec = promisify(execFile);
const port = Number(process.argv[3] ?? 8780);
const host = process.env.RF_HOST ?? '127.0.0.1';
const tmpDir = join(root, '.tmp');
initSystem(root);
openStore(root);
openSkills(root);
checkConfig(host);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);

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
  if (url.pathname === '/agent/say' && req.method === 'POST') {
    const [thread = '', ...words] = ((await json(req)).args ?? []).map(String), text = words.join(' ').trim();
    if (!threads(a.inst).includes(thread) || !text) throw new HttpError(400, `rf say THREAD TEXT, THREAD one of this instance's threads: ${threads(a.inst).join(', ') || 'none yet'}`);
    return send(res, 200, `said, seq ${a.inst.append('agent', 'say', { thread, text }).seq}`);
  }
  if (url.pathname === '/agent/wake' && req.method === 'POST') return send(res, 200, wakeFrom(a, ((await json(req)).args ?? []).map(String)));
  // Skills and machines: rf skills, rf settings, rf files, rf mail, rf browser, rf windows (see agent-api.ts).
  const r = await agentCall(a, url.pathname, req.method ?? 'GET', url.searchParams, () => body(req));
  if (r) return send(res, r.status, r.data);
  throw new HttpError(404, 'not found');
}

function mustSee(me: Me, w: Workspace | undefined): Workspace {
  if (!w || !canSee(me, w)) throw new HttpError(404, 'no such workspace');
  return w;
}

function questions(inst: Instance): number {
  if (inst.doc.status !== 'open') return 0;
  return inst.doc.items.flatMap(i => i.notes ?? []).filter(n => n.id && n.options && !inst.answered(n.id)).length;
}

function listing(me: Me) {
  const t = tree(), w8 = wakes(), byName = (a: [string, { name: string }], b: [string, { name: string }]) => a[1].name.localeCompare(b[1].name);
  return Object.entries(t.workspaces).filter(([, w]) => canSee(me, w)).sort(byName).map(([id, w]) => ({
    id, name: w.name, archived: !!w.archived, owners: w.owners, members: w.members, manage: canManage(me, w), guidance: text(guidanceFile(id)),
    series: Object.entries(t.series).filter(([, s]) => s.workspace === id).sort(byName).map(([sid, s]) => ({
      id: sid, name: s.name, archived: !!s.archived, adhoc: !!s.adhoc, skills: seriesSettings(seriesDir(sid)).skills, allow_wakes: seriesSettings(seriesDir(sid)).wakes?.by ?? null,
      reads: reach(t, sid).map(r => named(t, r).replace('/', ' / ')), wake: w8.pending[sid] ?? null,
      requests: Object.entries(w8.requests).filter(([, r]) => r.series === sid).map(([id, r]) => ({ id, ...r })),
      instances: instances(sid).map(i => ({
        id: i.id, label: i.label, status: i.doc.status, rev: i.doc.rev, running: active.get(sid)?.inst === i, queued: queued(i), questions: questions(i), wake: w8.pending[i.id]?.at ?? null, runner: runnerOf(i).by,
        cost: +i.log.reduce((t, e) => t + ((e.cost as number | undefined) ?? 0), 0).toFixed(4),
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
  if (posix.normalize(rel) !== rel || !/^(upload|working|calls|browser)\//.test(rel) || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
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

// The page's event stream: the id of each instance the person can see as it changes, and "tree" for anything else, at most one a
// second each, so the page refreshes on change instead of polling.
function events(me: Me, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const due = new Map<string, NodeJS.Timeout>(), beat = setInterval(() => res.write(': beat\n\n'), 30_000);
  const on = (id: string) => {
    if (due.has(id) || (id !== 'tree' && !canSee(me, tree().workspaces[tree().series[instance(id).seriesId].workspace]))) return;
    due.set(id, setTimeout(() => { due.delete(id); res.write(`data: ${id}\n\n`); }, 1000));
  };
  changes.on('change', on);
  req.on('close', () => { changes.off('change', on); clearInterval(beat); for (const t of due.values()) clearTimeout(t); });
}

const threads = (inst: Instance) => [...new Set(inst.log.filter(e => e.op === 'comment').map(e => e.thread as string))];
const text = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
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
    const wid = newId(), adhoc = newId();
    t.workspaces[wid] = { name, owners: [me.email], members: [] };
    t.series[adhoc] = { name: 'Ad hoc', workspace: wid, adhoc: true };
    mkdirSync(seriesDir(adhoc));
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
    if (change.guidance !== undefined) writeFileSync(guidanceFile(id), String(change.guidance));
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
      if (instances(id).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances are open; close one first`);
      const { label, logins: ticks } = await json(req);
      const created = createInstance(id, String(label ?? ''), by, checkTicks(by, ticks ?? []));
      kick(created);
      return send(res, 200, { id: created.id });
    }
    if (req.method !== 'PUT') throw new HttpError(405, 'PUT, or POST a new instance');
    const change = await json(req);
    if (change.name !== undefined && change.name !== s.name) {
      const name = safeName(String(change.name));
      if (s.adhoc) throw new HttpError(400, 'the Ad hoc series keeps its name');
      if (Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
    }
    if (change.archived !== undefined) s.archived = !!change.archived;
    saveTree(t);
    const { wakes: allowed, ...settings } = seriesSettings(seriesDir(id));
    const wakesBy = change.allow_wakes === undefined ? allowed : change.allow_wakes ? { by, since: new Date().toISOString(), logins: checkTicks(by, change.logins ?? []) } : undefined;
    replaceReadOnly(join(seriesDir(id), 'series.json'), JSON.stringify({ ...settings, ...(change.skills !== undefined && { skills: checkChosen(change.skills) }), ...(wakesBy && { wakes: wakesBy }) }, null, 1));
    return send(res, 200, 'ok');
  }
  // A pending wake, which people may move or cancel, and a request to start an instance, which they start or dismiss.
  if (kind === 'wakes') {
    // A person moves or cancels a pending wake, or sets one, as an agent's rf wake does: an open instance continues, a series starts LABEL.
    const target = t.series[id] ? id : instance(id).seriesId, wake = wakes().pending[id];
    mustSee(me, t.workspaces[t.series[target].workspace]);
    if (req.method === 'DELETE' && !wake) throw new HttpError(404, 'no wake pending');
    if (req.method === 'DELETE') return void (cancelWake(id), send(res, 200, 'ok'));
    const { at: when, reason, label } = await json(req), at = Date.parse(String(when));
    if (req.method !== 'PUT' || Number.isNaN(at)) throw new HttpError(400, 'PUT {"at": a date and time, "reason", "label" for a series}, or DELETE');
    if (!wake && !reason) throw new HttpError(400, 'a new wake has a reason');
    if (!wake && t.series[id] && !label) throw new HttpError(400, 'waking a series starts a new instance: name it with a label');
    if (!t.series[id] && instance(id).doc.status !== 'open') throw new HttpError(409, `${instance(id).label} is ${instance(id).doc.status}: to correct it, wake its series`);
    return send(res, 200, setWake(id, { ...wake, at: new Date(at).toISOString(), from: by, ...(reason && { reason }), ...(label && { label }) }));
  }
  if (kind === 'requests') {
    const r = wakes().requests[id];
    if (!r) throw new HttpError(404, `no request ${id}`);
    mustSee(me, t.workspaces[t.series[r.series].workspace]);
    if (req.method === 'POST') {
      const inst = startWith(r.series, r.label, by, checkTicks(by, (await json(req)).logins ?? []), { reason: r.reason, from: r.from });
      dropRequest(id);
      return send(res, 200, { id: inst.id });
    }
    if (req.method !== 'DELETE') throw new HttpError(405, 'POST to start it, or DELETE');
    dropRequest(id);
    return send(res, 200, 'ok');
  }
  if (kind !== 'instances') throw new HttpError(404, 'not found');
  const inst = instance(id);
  mustSee(me, t.workspaces[t.series[inst.seriesId].workspace]);
  const a = active.get(inst.seriesId);
  const mine = a?.inst === inst ? a : undefined;
  if (!action) return send(res, 200, { doc: inst.doc, log: inst.log, run: mine ? { n: mine.n, cost: +mine.cost.toFixed(4) } : null, queued: queued(inst), runner: runnerOf(inst) });
  if (action === 'trace') return send(res, 200, trace(inst));
  if (action === 'files') return send(res, 200, ['upload', 'working', 'calls'].filter(top => existsSync(join(inst.dir, top))).flatMap(top =>
    readdirSync(join(inst.dir, top), { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => {
      const st = statSync(join(d.parentPath, d.name));
      return { path: relative(inst.dir, join(d.parentPath, d.name)), size: st.size, mtime: st.mtime.toISOString() };
    })));
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (action === 'duplicate') {
    if (inst.doc.status === 'open') throw new HttpError(409, 'only a closed or abandoned instance can be duplicated');
    if (instances(inst.seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances are open; close one first`);
    return send(res, 200, { id: duplicateInstance(inst, url.searchParams.get('as') ?? '', by, checkTicks(by, (await json(req)).logins ?? [])).id });
  }
  if (action === 'promote') {
    // Make it a series: a one-off ask of Ad hoc becomes the first instance of a new series, which later instances roll forward from.
    if (!t.series[inst.seriesId].adhoc) throw new HttpError(400, 'only an Ad hoc instance can be made a series');
    if (a || queued(inst)) throw new HttpError(409, "wait for the series' run to end");
    const ws = t.series[inst.seriesId].workspace, name = safeName(String((await json(req)).name ?? ''));
    if (Object.values(t.series).some(x => x.workspace === ws && x.name === name)) throw new HttpError(409, `${name} exists`);
    const sid = newId();
    t.series[sid] = { name, workspace: ws };
    mkdirSync(seriesDir(sid));
    saveTree(t);
    moveInstance(inst, sid);
    inst.append(by, 'promote', { from: 'Ad hoc', series: name });
    return send(res, 200, { id: sid });
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
  } else if (action === 'comment') {
    // A comment starts a thread, on an item (at a ref, such as a cell, if given) or on the instance, or replies in one.
    const { thread, item, ref, text } = await json(req);
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a comment has text');
    if (thread !== undefined && !threads(inst).includes(thread)) throw new HttpError(400, `no thread ${thread}`);
    if (item !== undefined && !inst.doc.items.some(i => i.id === item)) throw new HttpError(400, `no item ${item}`);
    inst.append(by, 'comment', { thread: thread ?? `c${inst.log.length + 1}`, ...(thread === undefined && { item: item ?? null, ref: ref ?? null }), text: text.trim() });
  } else if (action === 'resolve') {
    const { thread } = await json(req);
    if (!threads(inst).includes(thread)) throw new HttpError(400, `no thread ${thread}`);
    inst.append(by, 'resolve', { thread });
    return send(res, 200, 'ok');
  } else if (action === 'interrupt') {
    if (!mine?.run) throw new HttpError(409, 'no run going');
    inst.append(by, 'interrupt');
    mine.interrupted = true;
    await mine.run.interrupt();
    return send(res, 200, 'ok');
  } else if (action === 'rename') {
    if (a || queued(inst)) throw new HttpError(409, "wait for the series' run to end");
    const from = inst.label;
    renameInstance(inst, url.searchParams.get('as') ?? '');
    inst.append(by, 'rename', { from });
    return send(res, 200, 'ok');
  } else if (action === 'takeover') {
    // Taking over makes you the runner from now on, with your own logins ticked; whoever closes answers for the whole instance.
    inst.append(by, 'takeover', { from: runnerOf(inst).by, logins: checkTicks(by, (await json(req)).logins ?? []) });
    return send(res, 200, 'ok');
  } else if (action === 'close' || action === 'abandon') {
    if (mine) throw new HttpError(409, 'wait for the run to end');
    if (action === 'close' && runnerOf(inst).by !== by) throw new HttpError(403, `only the runner, ${runnerOf(inst).by}, closes it, as closing signs it off; take it over first`);
    inst[action](by);
    cancelWake(inst.id);
    if (action === 'close') closed(inst);
    return send(res, 200, 'ok');
  } else throw new HttpError(404, `no action ${action}`);
  cancelWake(inst.id);
  kick(inst);
  send(res, 200, 'ok');
}

async function admin(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  const email = decodeURIComponent(url.pathname.split('/')[2] ?? '').toLowerCase();
  if (!email) {
    if (req.method === 'POST') {
      const { email, role } = JSON.parse((await body(req)).toString());
      upsertUser(String(email ?? ''), { role: ROLES.includes(role) ? role : 'user' });
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
    if (email === me.email && (disabled || (role !== undefined && role !== 'admin'))) throw new HttpError(409, 'you cannot lock yourself out');
    if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, `role is one of ${ROLES.join(', ')}`);
    upsertUser(email, { ...(role && { role: role as Role }), ...(disabled !== undefined && { disabled: !!disabled }) });
    if (signout) signOutEverywhere(email);
  } else throw new HttpError(405, 'PUT or DELETE');
  send(res, 200, 'ok');
}

// Skills: anyone signed in may list them with whether each is set up, to choose a series' Skill use. Publishers and admins push
// versions; only admins see their settings (never a secret, only whether one is saved), change them and test them, all with rf.
async function skillsRoute(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [id = '', action] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  if (!id && req.method === 'GET') return send(res, 200, skills().map(s => skillView(s, me.role === 'admin')));
  if (action === 'versions' && req.method === 'GET') return send(res, 200, versionsOf(id));
  if (action === 'versions' && req.method === 'POST') {
    if (me.role !== 'admin' && me.role !== 'publisher') throw new HttpError(403, 'publishers and admins push skills');
    const { files, from } = await json(req);
    return send(res, 200, `pushed ${id} version ${pushSkill(id, from === undefined ? files : versionFiles(id, Number(from)), me.email)}, live now`);
  }
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  const s = skill(id);
  if (!s) throw new HttpError(404, `no skill ${id}`);
  if (req.method === 'PUT') {
    saveSkillConfig(id, JSON.parse((await body(req)).toString()), me.email);
    return send(res, 200, skillView(s, true));
  }
  if (action === 'test' && req.method === 'POST') {
    try {
      return send(res, 200, await testSkill(id, me.email));
    } catch (e) {
      throw new HttpError((e as HttpError).status === 409 ? 409 : 502, (e as Error).message.split('\n').slice(0, 5).join('\n'));
    }
  }
  throw new HttpError(405, 'PUT, or POST test');
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
      owns: id => !!a.machines?.owns(id),
    };
  },
});

const server = createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  try {
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site && site !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    const me = await authenticate(req, res, url);
    if (!me) return;
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/me') send(res, 200, { ...me, sign_in: mode, m365: m365Ready() });
    else if (url.pathname === '/api/events') events(me, req, res);
    else if (url.pathname === '/api') send(res, 200, listing(me));
    else if (url.pathname.startsWith('/files/')) await file(me, res, url, false);
    else if (url.pathname.startsWith('/preview/')) await file(me, res, url, true);
    else if (url.pathname.startsWith('/api/')) await api(me, req, res, url);
    else if (url.pathname === '/guidance' && req.method === 'GET') send(res, 200, { text: text(guidanceFile()) });
    else if (url.pathname === '/guidance' && req.method === 'PUT') {
      if (me.role !== 'admin') throw new HttpError(403, "the company's guidance is the admins'");
      writeFileSync(guidanceFile(), (await body(req)).toString());
      send(res, 200, 'ok');
    } else if (url.pathname === '/tokens' && req.method === 'GET') send(res, 200, myTokens(me.email));
    else if (url.pathname === '/tokens' && req.method === 'POST') {
      const { name, days } = await json(req);
      send(res, 200, { token: newToken(me.email, String(name ?? '').trim(), Number(days)) });
    } else if (url.pathname.startsWith('/tokens/') && req.method === 'DELETE') send(res, 200, (revokeToken(me.email, decodeURIComponent(url.pathname.slice(8))), 'ok'));
    else if (url.pathname === '/rf.ts') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename=rf.ts' });
      res.end(readFileSync(join(app, 'src', 'rf-people.ts')));
    } else if (url.pathname === '/logins' && req.method === 'GET') send(res, 200, logins(me.email));
    else if (url.pathname === '/logins/m365/connect') await connectM365(res, me.email);
    else if (url.pathname === '/logins/m365/offers' && req.method === 'POST') send(res, 200, (await offer(me.email, await json(req)), 'ok'));
    else if (url.pathname.startsWith('/logins/m365/offers/') && req.method === 'DELETE') send(res, 200, (unoffer(me.email, decodeURIComponent(url.pathname.slice(20))), 'ok'));
    else if (url.pathname.startsWith('/logins/web/') && req.method === 'POST') send(res, 200, { id: await startSignIn(me.email, decodeURIComponent(url.pathname.slice(12))) });
    else if (/^\/signins\/\w+\/view$/.test(url.pathname) && req.method === 'GET') {
      const html = await viewPage(me.email, url.pathname.split('/')[2]);
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    else if (/^\/signins\/\w+$/.test(url.pathname) && (req.method === 'POST' || req.method === 'DELETE')) send(res, 200, (await endSignIn(me.email, url.pathname.slice(9), req.method === 'POST'), 'ok'));
    else if (url.pathname.startsWith('/logins/') && req.method === 'DELETE') send(res, 200, (signOut(me.email, decodeURIComponent(url.pathname.slice(8))), 'ok'));
    else if (url.pathname === '/users' || url.pathname.startsWith('/users/')) await admin(me, req, res, url);
    else if (url.pathname === '/skills' || url.pathname.startsWith('/skills/')) await skillsRoute(me, req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
});
// A sign-in's live view, the person's own: its websockets pass through to the machines service.
server.on('upgrade', (req, socket, head) => {
  const me = session(req), m = /^\/signins\/(\w+)\/(view\/(?:watch|drive))$/.exec(new URL(req.url!, 'http://x').pathname);
  if (!me || !m || !isSignIn(me.email, m[1])) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  passUpgrade(req, socket, head, `/sessions/${m[1]}/${m[2]}`);
});
server.listen(port, host, () => {
  startWaking();
  console.log(`rollforward on http://${host}:${port}, data in ${root}, sign-in ${mode}${process.env.RF_TODAY ? `, skills take today as ${process.env.RF_TODAY} (RF_TODAY)` : ''}`);
});
