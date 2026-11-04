import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeSync, constants, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsFile, createInstance, duplicateInstance, moveInstance, renameInstance, replaceReadOnly, HttpError, instance, instanceDir, instances, isPerson, labels, newId, openFile, openStore, readFile, safeName, seriesDir, type Entry, type Instance } from './store.ts';
import { AGENT, commit } from './git.ts';
import { serveSandboxes, userland } from './sandbox.ts';
import { agentRoot, id as agentId } from './agent.ts';
import { authenticate, checkConfig, cli, connect, m365Ready, mode, myTokens, newToken, removeUser, revokeToken, ROLES, session, signOutEverywhere, ungranted, upsertUser, users, type Me, type Role, type User } from './auth.ts';
import { canManage, canSee, changes, everyone, initSystem, isIn, isPeople, readJson, saveTree, see, seen, tree, writeJson, type Tree, type Workspace } from './system.ts';
import { checkTicks, logins, runnerOf, saveLogin, signOut } from './logins.ts';
import { agentCall } from './agent-api.ts';
import { checkLogins } from './entra.ts';
import { byLogin, call, connections, convert, intercepts, loginOf, removeConnection, setConnection, upstreams } from './connections.ts';
import { allowed, Browsers, endSignIn, isSignIn, keepAlive, passUpgrade, reap, scoped, startSignIn, viewPage, websites } from './browsers.ts';
import { offer, unoffer } from './connections/graph.ts';
import { forget, indexes, startIndexing, track } from './indexes.ts';
import { seriesSettings } from './series.ts';
import { openSkills, pushed, pushSkill, skills, versionFiles, versionsOf } from './skills.ts';
import { active, byToken, cancelWake, cancelWakes, citedFor, closed, dropRequest, isNote, kick, MAX_OPEN, named, pending, queued, resolveFor, setWake, startWaking, startWith, wakes, wakesOf, weekly, wider, CUT, type Active, type Request } from './waker.ts';

const root = resolve(process.argv[2]);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(app, 'web', 'index.html');
const exec = promisify(execFile);
const port = Number(process.argv[3] ?? 8780);
const host = process.env.RF_HOST ?? '127.0.0.1';
const tmpDir = join(root, '.tmp');
if (!existsSync(join(agentRoot, 'usr'))) throw new Error(`no agent image at ${agentRoot}: node scripts/agent.ts unpacks agent-${agentId}, which this checkout runs`);
initSystem(root);
openStore(root);
convert();

// A free name among a workspace's series: the name, else the name 2, 3 and on.
function freeName(t: Tree, ws: string, name: string): string {
  const taken = new Set(Object.values(t.series).filter(s => s.workspace === ws).map(s => s.name));
  let n = name;
  for (let k = 2; taken.has(n); k++) n = `${name} ${k}`;
  return n;
}

// wakes.json once kept one pending wake per target, by the target's id; each wake now has an id of its own.
{
  const w8 = wakes();
  for (const [target, k] of Object.entries(w8.pending)) if (!k.target) {
    delete w8.pending[target];
    w8.pending[newId()] = { ...k, target };
  }
  writeJson('wakes.json', w8);
}

// Before v0.2.17 each workspace had an Ad hoc series of one-offs. Each of its instances becomes a task, a single series of its own,
// saved before the instance moves into it, so a stop midway loses nothing; an open one gets a copy of the Ad hoc .pylib. A wake or
// a request to start an Ad hoc instance is dropped.
for (const [aid, a] of Object.entries(tree().series).filter(([, s]) => (s as { adhoc?: boolean }).adhoc)) {
  const moved = labels(aid);
  for (const l of moved) {
    const t = tree(), sid = newId();
    t.series[sid] = { name: freeName(t, a.workspace, l.label), workspace: a.workspace, single: true, ...(a.archived && { archived: true }) };
    mkdirSync(seriesDir(sid));
    saveTree(t);
    if (instance(l.id).doc.status === 'open' && existsSync(join(seriesDir(aid), '.pylib'))) cpSync(join(seriesDir(aid), '.pylib'), join(seriesDir(sid), '.pylib'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    moveInstance(instance(l.id), sid);
  }
  const t = tree(), w8 = wakes();
  console.log(`${t.workspaces[a.workspace].name}/Ad hoc: its ${moved.length} instances are tasks now`);
  delete t.series[aid];
  for (const [id, k] of Object.entries(w8.pending)) if (k.target === aid) delete w8.pending[id];
  for (const [rid, r] of Object.entries(w8.requests)) if (r.series === aid) delete w8.requests[rid];
  saveTree(t);
  writeJson('wakes.json', w8);
}
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

// A run, on its sandbox's socket, by its token: on /api a caller like any person, with the few rights api() gives a run; on /agent
// what only a run has, its series' skills and its runner's logins and browsers.
type Caller = Me & { run?: Active };
async function agent(req: IncomingMessage, res: ServerResponse, url: URL) {
  const a = byToken.get(req.headers.authorization?.replace('Bearer ', '') ?? '');
  if (!a) throw new HttpError(401, 'no run for this token');
  if (url.pathname.startsWith('/api/')) return api({ email: 'agent', name: 'Agent', role: 'user', groups: [], run: a }, req, res, url);
  // Browsers and deliveries: rf expired, rf delivered (see agent-api.ts).
  // A login the run's runner must sign in to again is logged, so the instance carries on once they do.
  const r = await agentCall(a, url.pathname, req.method ?? 'GET', () => body(req)).catch((e: HttpError & { login?: string }) => {
    if (e.login) a.inst.append('server', 'expired', { login: e.login, name: byLogin(e.login) ? loginOf(byLogin(e.login)!).name : e.login, runner: runnerOf(a.inst).by });
    throw e;
  });
  if (r) return send(res, r.status, r.data);
  throw new HttpError(404, 'not found');
}

function mustSee(me: Me, w: Workspace | undefined): Workspace {
  if (!w || !canSee(me, w)) throw new HttpError(404, 'no such workspace');
  return w;
}

// Whom an open instance waits on, and with what: each ask on the person it names, else the runner, and each thread a note ends on
// the runner.
function waits(inst: Instance): { who: string; e: Entry }[] {
  if (inst.doc.status !== 'open') return [];
  const runner = runnerOf(inst).by, notes = [...inst.threads().values()].map(t => t.at(-1)!).filter(e => isNote(inst, e));
  return [...inst.asking().map(e => ({ who: (e.to as string | undefined) ?? runner, e })), ...notes.map(e => ({ who: runner, e }))];
}

// Whom a request to start an instance of a series waits on: whoever shares it, else the runner of its newest instance, else the
// person who asked, if a person did; no one in particular, who anyone in its workspace may answer, else.
function asked(r: Request): string | null {
  const newest = instances(r.series).at(-1);
  return seriesSettings(seriesDir(r.series)).shared?.by ?? (newest ? runnerOf(newest).by : r.from.includes('@') ? r.from : null);
}

// The open instances whose runner couldn't see them with this tree and these people: their runs can't use the runner's logins.
function hidden(t: Tree, us: Record<string, User>): string[] {
  return Object.entries(t.series).flatMap(([sid, s]) => instances(sid).filter(i => {
    const by = runnerOf(i).by, u = us[by];
    return i.doc.status === 'open' && (!u || !canSee({ email: by, role: u.role, groups: u.groups ?? [] }, t.workspaces[s.workspace]));
  }).map(i => {
    const by = runnerOf(i).by;
    return `${named(t, sid)}/${i.label}, run by ${us[by]?.name ? `${us[by].name} <${by}>` : by}`;
  }));
}

// A change of who is where or of roles may hide no more open instances from their runners, unless forced.
function guard(before: string[], after: string[], force: unknown) {
  const lost = after.filter(x => !before.includes(x));
  if (lost.length && !force) throw new HttpError(409, `this would hide open instances from the people who run them, so their runs couldn't use their logins: ${lost.join('; ')}. Have someone who stays take them over first`);
}

// An instance as the sidebar shows it. What comes from its log and screen is kept until either moves on, or its series' sharing,
// which says whose entries are notes, changes, so a listing reads each instance's log once, not on every refresh.
const kept = new WeakMap<Instance, { key: string; active: string; asks: string[]; runner: string; acted: string[]; cost: number }>();
// Who runs an instance, and the logins they ticked for it, by name while they still offer them.
function runner(inst: Instance) {
  const r = runnerOf(inst), offers = logins(r.by).flatMap(l => l.offers);
  return { ...r, ticked: r.logins.map(id => offers.find(o => o.id === id)?.name ?? id) };
}

// Whom the page names: whoever has signed in, by their Entra name, as colleagues see each other in the directory; and the Entra
// groups in the workspaces `me` sees, by the labels their owners write, which may say more about a team than its members would.
function names(me: Me) {
  const t = tree(), seen = Object.values(t.workspaces).filter(w => canSee(me, w));
  return {
    ...Object.fromEntries(Object.entries(t.groups ?? {}).filter(([g]) => seen.some(w => everyone(w).includes(g)))),
    ...Object.fromEntries(Object.entries(users()).filter(([, u]) => u.name).map(([email, u]) => [email, u.name])),
  };
}

// What makes an instance new to a person, when someone else or the agent did it: a run's end, a report, a comment, a sign-off, an
// upload, a takeover, a close, or a move to another workspace that someone else accepted.
const NEWS = ['done', 'report', 'comment', 'signoff', 'upload', 'takeover', 'close', 'abandon', 'move'];

function summary(i: Instance, email: string, w8 = wakes()) {
  const key = `${i.log.length}:${i.doc.rev}:${seriesSettings(i.series()).shared?.by ?? ''}`;
  const news = i.log.findLast(e => e.by !== email && e.accepted_by !== email && NEWS.includes(e.op)), s = seen(email);
  let k = kept.get(i);
  if (k?.key !== key) kept.set(i, k = { key, active: i.log.at(-1)!.at, asks: waits(i).map(w => w.who), runner: runnerOf(i).by, acted: [...new Set(i.log.filter(isPerson).map(e => e.by))], cost: +i.log.reduce((t, e) => t + (e.op === 'done' ? e.cost as number : 0), 0).toFixed(4) });
  return {
    id: i.id, label: i.label, status: i.doc.status, rev: i.doc.rev, running: active.get(i.seriesId)?.inst === i, queued: !!queued(i),
    asks: k.asks, wakes: wakesOf(i.id, w8), fired: w8.fired[i.id] ?? null, runner: k.runner, cost: k.cost, active: k.active,
    unread: !!news && news.at > s.since && news.seq > (s.at[i.id] ?? 0),
  };
}

// A proposal lapses, and a series moved out stops showing where it was, a week on.
const fresh = (at: string) => Date.now() - Date.parse(at) < 7 * 86400e3;
// The proposals open, each by the id of the workspace it merges or moves a series out of, into the one it names.
const proposals = (t: Tree) => Object.entries(t.workspaces).filter(([, w]) => w.proposal && fresh(w.proposal.at)).map(([id, w]) => {
  const p = w.proposal!;
  return { id, into: p.to, kind: p.kind, from: w.name, to: t.workspaces[p.to].name, series: p.series ? t.series[p.series].name : null, by: p.by, at: p.at };
});

function listing(me: Me) {
  const t = tree(), w8 = wakes(), open = proposals(t), byName = (a: [string, { name: string }], b: [string, { name: string }]) => a[1].name.localeCompare(b[1].name);
  return Object.entries(t.workspaces).filter(([, w]) => canSee(me, w)).sort(byName).map(([id, w]) => {
    const series = Object.entries(t.series).filter(([, s]) => s.workspace === id).sort(byName).map(([sid, s]) => {
      const { shared } = seriesSettings(seriesDir(sid));
      return {
        id: sid, name: s.name, archived: !!s.archived, single: !!s.single, shared_by: shared?.by ?? null, shared_logins: shared?.by === me.email ? shared.logins : [],
        wakes: wakesOf(sid, w8), fired: w8.fired[sid] ?? null,
        requests: Object.entries(w8.requests).filter(([, r]) => r.series === sid).map(([id, r]) => ({ id, ...r, who: asked(r) })),
        instances: instances(sid).map(i => summary(i, me.email, w8)),
      };
    });
    // Mine: a workspace you own, or one where you ran an instance, commented or uploaded; membership alone isn't.
    const mine = w.owners.includes(me.email) || series.some(s => instances(s.id).some(i => kept.get(i)!.acted.includes(me.email)));
    return {
      id, name: w.name, archived: !!w.archived, owners: w.owners, members: w.members, manage: canManage(me, w), agents: text(agentsFile(id)), mine,
      proposal: open.find(p => p.id === id || p.into === id) ?? null, moved: (w.moved ?? []).filter(m => fresh(m.at)),
      reads: wider(t, id).map(o => t.workspaces[o].name).sort(), read_by: Object.keys(t.workspaces).filter(o => wider(t, o).includes(id)).map(o => t.workspaces[o].name).sort(),
      series,
    };
  });
}

// Every run in what `me` sees, started since `since`: where and when, how it ended, its cost, whose it was and what started it.
function runs(me: Me, since: string) {
  const t = tree();
  return Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace])).flatMap(([sid]) => instances(sid).flatMap(i => {
    const a = active.get(sid);
    return i.log.filter(r => r.op === 'run' && r.at >= since).map(r => {
      const d = i.log.find(e => e.op === 'done' && e.run === r.run), seen = (i.log.findLast(e => e.op === 'done' && e.seq < r.seq)?.seen as number | undefined) ?? 0;
      const cause = pending(i, seen).find(e => e.seq <= (r.upto as number));
      const error = d?.error as string | undefined, outcome = !d ? 'running' : error === CUT ? 'cut' : error ? 'failed' : d.aborted ? 'interrupted' : 'done';
      return {
        path: `${named(t, sid)}/${i.label}`, run: r.run as number, at: r.at, outcome,
        // Why a failed run failed: out of OpenRouter credits, a provider's policy refusing it, the time limit, or anything else.
        failure: outcome !== 'failed' ? null : /\b402\b|credits/i.test(error!) ? 'credits' : /\b403\b|terms of service|usage polic|flagged/i.test(error!) ? 'policy' : error === 'time limit' ? 'time limit' : 'other',
        seconds: Math.round(((d ? Date.parse(d.at) : Date.now()) - Date.parse(r.at)) / 1000), cost: d ? d.cost as number : a?.inst === i ? +a.cost.toFixed(4) : 0,
        runner: i.log.findLast(e => e.seq < r.seq && ['create', 'duplicate', 'takeover'].includes(e.op))!.by,
        started: cause ? { op: cause.op, by: cause.op === 'wake' ? cause.from as string : cause.by } : null,
        summary: d?.summary ?? null, error: d?.error ?? null,
      };
    });
  })).sort((x, y) => x.at.localeCompare(y.at));
}

// What people said, uploaded and closed, and each run's report or error, per instance `me` sees, since `since`.
function activity(me: Me, since: string) {
  const t = tree();
  return Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace])).flatMap(([sid]) => instances(sid).map(i => ({
    path: `${named(t, sid)}/${i.label}`,
    entries: i.log.filter(e => e.at >= since && (e.op === 'done' || (isPerson(e) && ['comment', 'upload', 'close', 'abandon'].includes(e.op)))).map(e => ({
      at: e.at, by: e.by, op: e.op, ...(e.op === 'comment' && { text: e.text }), ...(e.op === 'upload' && { file: e.file }), ...(e.op === 'done' && { run: e.run, summary: e.summary, error: e.error }),
    })),
  })).filter(b => b.entries.length));
}

// What goes on and what is stuck in what `me` sees: runs going and queued, what waits on whom, and open instances whose last run
// failed. Admins see everyone's expired logins, others their own.
function status(me: Me) {
  const t = tree(), w8 = wakes(), path = (i: Instance) => `${named(t, i.seriesId)}/${i.label}`;
  const seen = Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace]));
  const open = seen.flatMap(([sid]) => instances(sid).filter(i => i.doc.status === 'open'));
  return {
    running: seen.flatMap(([sid]) => active.get(sid) ?? []).map(a => ({ path: path(a.inst), run: a.n, at: a.inst.log.findLast(e => e.op === 'run')!.at, cost: +a.cost.toFixed(4) })),
    queued: open.flatMap(i => { const q = queued(i); return q ? [{ path: path(i), ...q }] : []; }),
    asks: open.flatMap(i => waits(i).map(({ who, e }) => ({ who, path: path(i), since: e.at, text: e.text as string, note: isNote(i, e), signoff: !!e.signoff }))),
    expired: (me.role === 'admin' ? Object.keys(users()) : [me.email]).flatMap(who => logins(who).filter(l => l.expired).map(l => ({
      who, login: l.name,
      holding: open.filter(i => {
        const hit = i.log.findLast(e => e.op === 'expired' && e.login === l.id && e.runner === who);
        return hit && !i.log.some(e => e.seq > hit.seq && e.op === 'wake' && e.login === l.id);
      }).map(path),
    }))),
    requests: Object.values(w8.requests).filter(r => seen.some(([sid]) => sid === r.series)).map(r => ({ who: asked(r), path: named(t, r.series), label: r.label, from: r.from, at: r.at })),
    proposals: proposals(t).filter(p => [p.id, p.into].some(x => canSee(me, t.workspaces[x]))),
    failed: open.filter(i => active.get(i.seriesId)?.inst !== i).flatMap(i => {
      const d = i.log.findLast(e => e.op === 'done');
      return d?.error ? [{ path: path(i), run: d.run as number, at: d.at, error: d.error as string }] : [];
    }),
  };
}

function trace(inst: Instance) {
  const dir = join(inst.dir, 'session');
  type Line = { kind: string; text: string; at?: string; result?: string; lines?: number; error?: boolean };
  const out: Line[] = [], calls = new Map<string, Line>();
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() : []) {
    // A line a restart cut left half written is skipped, as Pi skips it.
    for (const line of (readFile(dir, f) ?? '').split('\n').filter(Boolean)) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
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

// Files by hand, never into a link: a run may have made links anywhere in working/. A .git, such as the instance's history, isn't
// copied.
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? (d.name === '.git' ? [] : walk(join(dir, d.name))) : d.isFile() ? [join(dir, d.name)] : []);

// What rf pull copies: every file under `path` that `me` sees, in the layout runs see (workspace/series/label/ and the instance's own
// files), with its size and time; the AGENTS.md files whole, and each instance file at its /files address.
function pullable(me: Me, path: string) {
  const t = tree(), out: { path: string; size: number; mtime: string; url?: string; text?: string }[] = [];
  // A name that isn't UTF-8, as unzipping an old archive leaves, reads back as another name, which no file has: it is left out.
  const add = (at: string, file: string, more: { url?: string; text?: string }) => {
    const st = statSync(file, { throwIfNoEntry: false });
    if (st) out.push({ path: at, size: st.size, mtime: st.mtime.toISOString(), ...more });
  };
  const near = (at: string) => !path || at === path || at.startsWith(path + '/') || path.startsWith(at + '/');
  if (existsSync(agentsFile())) add('AGENTS.md', agentsFile(), { text: text(agentsFile()) });
  for (const [wid, w] of Object.entries(t.workspaces).filter(([, w]) => canSee(me, w))) {
    if (existsSync(agentsFile(wid))) add(`${w.name}/AGENTS.md`, agentsFile(wid), { text: text(agentsFile(wid)) });
    for (const [sid, s] of Object.entries(t.series).filter(([, s]) => s.workspace === wid)) for (const l of labels(sid)) {
      const at = `${w.name}/${s.name}/${l.label}`, dir = instanceDir(l.id);
      if (near(at)) for (const f of walk(dir)) add(`${at}/${relative(dir, f).split(sep).join('/')}`, f, { url: `/files/${l.id}/${relative(dir, f).split(sep).map(encodeURIComponent).join('/')}` });
    }
  }
  return out.filter(f => !path || f.path === path || f.path.startsWith(path + '/'));
}

async function file(me: Me, res: ServerResponse, url: URL, preview: boolean) {
  const [id, ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const rel = rest.join('/');
  if (posix.normalize(rel) !== rel || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
  const inst = instance(id);
  mustSee(me, tree().workspaces[tree().series[inst.seriesId].workspace]);
  const fd = openFile(inst.dir, rel);
  if (fd === undefined) throw new HttpError(404, 'no such file');
  if (preview) {
    // preview.py runs in the agent's userland, with no network and nothing of the host's: the file comes on its stdin.
    const bytes = readFileSync(fd), run = exec('bwrap', [
      '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', ...userland(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', join(app, 'src', 'preview.py'), '/preview.py', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--', '/opt/venv/bin/python', '/preview.py', basename(rel),
    ], { timeout: 30_000, maxBuffer: 64e6 });
    closeSync(fd);
    run.child.stdin!.end(bytes);
    const { stdout } = await run;
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(stdout);
  }
  const image = rel.match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
  res.writeHead(200, {
    'content-type': image ? `image/${image}` : 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'content-disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(rel))}`,
  });
  createReadStream('', { fd }).pipe(res);
}

// The page's event stream: the id of each instance the person can see as it changes, and "tree" for anything else, at most one a
// second each, so the page refreshes on change instead of polling.
function events(me: Me, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).flushHeaders(); // the page hears it's open at once
  const due = new Map<string, NodeJS.Timeout>(), beat = setInterval(() => res.write(': beat\n\n'), 30_000);
  const on = (id: string) => {
    if (due.has(id) || (id !== 'tree' && !canSee(me, tree().workspaces[tree().series[instance(id).seriesId].workspace]))) return;
    due.set(id, setTimeout(() => { due.delete(id); res.write(`data: ${id}\n\n`); }, 1000));
  };
  changes.on('change', on);
  req.on('close', () => { changes.off('change', on); clearInterval(beat); for (const t of due.values()) clearTimeout(t); });
}

const text = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
// The deployment's brand, the admins': a text and a logo, which top the sidebar and are the page's title and icon.
const brand = () => readJson<{ text?: string; logo?: string; type?: string }>('brand.json', {});
// Capabilities beyond what every user has, each granted by admins to people and Entra groups: publish, pushing skills, which every
// run loads, and create, making workspaces. Admins have them all.
const CAPS = ['publish', 'create'], granted = () => readJson<Record<string, string[]>>('capabilities.json', {});
const can = (me: Me, cap: string) => me.role === 'admin' || isIn(me, granted()[cap] ?? []);
const json = async (req: IncomingMessage) => {
  try { return JSON.parse((await body(req)).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); }
};
const people = (w: { owners?: unknown; members?: unknown }) => [w.owners, w.members].map(list => {
  if (!isPeople(list)) throw new HttpError(400, `owners and members are lists of emails and Entra group ids: ${JSON.stringify(list)}`);
  return list.map(p => p.toLowerCase());
});

// Workspaces, series and instances, by id. Renaming a workspace or a series edits .rf/tree.json, so it may happen mid-run; a run sees
// the new names from its next start.
async function api(me: Caller, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [kind, id = '', action] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  // A run reads and writes its own instance's screen and threads, commits its folder, sets wakes in its own workspace, and finds
  // what a folder it can read names; nothing else here.
  const run = me.run;
  if (run && !(kind === 'instances' && id === run.inst.id && ['screen', 'comment', 'resolve', 'commit'].includes(action)) && !(kind === 'wakes' && ['PUT', 'DELETE'].includes(req.method!)) && kind !== 'resolve')
    throw new HttpError(404, 'not found');
  // The body before the tree: a request held open must not save a tree from before others' changes, such as an owner's removal.
  const payload = ['upload', 'attach', 'screen'].includes(action) ? {} : await json(req);
  const t = tree(), by = me.email;
  if (kind === 'resolve') {
    if (!run) throw new HttpError(404, 'not found');
    const target = resolveFor(run, url.searchParams.get('path') ?? '');
    return send(res, 200, { id: target, kind: t.series[target] ? 'series' : 'instance' });
  }
  if (kind === 'workspaces' && !id && req.method === 'POST') {
    if (!can(me, 'create')) throw new HttpError(403, 'making a workspace is for admins and those they grant create: ask an admin');
    const name = safeName(String(payload.name ?? ''));
    if (Object.values(t.workspaces).some(w => w.name === name)) throw new HttpError(409, `the name ${name} is taken; choose another`);
    const wid = newId();
    t.workspaces[wid] = { name, owners: [me.email], members: [] };
    saveTree(t);
    return send(res, 200, { id: wid });
  }
  if (kind === 'workspaces' && action === 'people') {
    const w = mustSee(me, t.workspaces[id]);
    if (!canManage(me, w)) throw new HttpError(403, "only the workspace's owners and admins see its people");
    const us = users(), open = Object.keys(t.series).filter(sid => t.series[sid].workspace === id).flatMap(sid => instances(sid).filter(i => i.doc.status === 'open'));
    return send(res, 200, [...w.owners.map(who => ({ who, as: 'owner' })), ...w.members.map(who => ({ who, as: 'member' }))].map(p => ({
      ...p, last_login: us[p.who]?.last_login ?? null, runs: open.filter(i => runnerOf(i).by === p.who).map(i => `${t.series[i.seriesId].name}/${i.label}`),
    })));
  }
  if (kind === 'workspaces' && req.method === 'PUT') {
    const w = mustSee(me, t.workspaces[id]);
    if (!canManage(me, w)) throw new HttpError(403, "only the workspace's owners and admins change it");
    const change = payload;
    if (change.name !== undefined) {
      const name = safeName(String(change.name));
      if (name !== w.name && Object.values(t.workspaces).some(x => x.name === name)) throw new HttpError(409, `the name ${name} is taken; choose another`);
      w.name = name;
    }
    if (change.owners !== undefined || change.members !== undefined) {
      const before = hidden(t, users());
      [w.owners, w.members] = people({ owners: w.owners, members: w.members, ...change });
      guard(before, hidden(t, users()), change.force);
    }
    // Whoever manages a workspace labels its Entra groups, for everyone who sees one of them.
    for (const [g, label] of Object.entries(change.groups ?? {})) {
      if (g.includes('@') || !everyone(w).includes(g) || typeof label !== 'string' || !label.trim() || label.includes('@')) throw new HttpError(400, `a label is some text, without an @, for an Entra group in this workspace: not ${g}: ${JSON.stringify(label)}`);
      (t.groups ??= {})[g] = label.trim();
    }
    if (change.archived !== undefined) w.archived = !!change.archived;
    if (change.archived) cancelWakes(Object.keys(t.series).filter(sid => t.series[sid].workspace === id).flatMap(sid => [sid, ...labels(sid).map(l => l.id)]));
    if (change.agents !== undefined) writeFileSync(agentsFile(id), String(change.agents));
    saveTree(t);
    return send(res, 200, 'ok');
  }
  // A proposal to merge a workspace into another, or to move one of its series there, is the workspace's, by its id: whoever manages
  // it proposes and withdraws, and whoever manages the other accepts or declines, within a week. Neither may be archived, or in
  // another proposal. What moves, and who joins, is worked out as it's accepted: the series keep their ids, so their instances,
  // wakes and requests go with them, and their names, but for a number on a name the other has; none stays shared.
  if (kind === 'proposals') {
    const a = t.workspaces[id], p = proposals(t).find(p => p.id === id);
    if (req.method === 'PUT') {
      const b = mustSee(me, t.workspaces[payload.to]);
      if (!canManage(me, mustSee(me, a))) throw new HttpError(403, "only the workspace's owners and admins propose to merge it or move its series");
      if (!(payload.kind === 'merge' || (payload.kind === 'move' && t.series[payload.series]?.workspace === id)) || b === a) throw new HttpError(400, 'PUT {"kind": "merge", "to"} or {"kind": "move", "series", "to"}: one of its series, into another workspace');
      if (a.archived || b.archived) throw new HttpError(409, `${a.archived ? a.name : b.name} is archived`);
      const busy = proposals(t).find(p => [p.id, p.into].some(x => x === id || x === payload.to));
      if (busy) throw new HttpError(409, `${busy.from} has a proposal open, into ${busy.to}: until it's accepted, declined or withdrawn, or lapses a week on, neither takes another`);
      a.proposal = { kind: payload.kind, to: payload.to, ...(payload.kind === 'move' && { series: payload.series }), by, at: new Date().toISOString() };
      saveTree(t);
      return send(res, 200, 'ok');
    }
    const b = p && t.workspaces[p.into];
    if (!b || !(canManage(me, a) || canManage(me, b))) throw new HttpError(404, 'no proposal open for this workspace');
    if (req.method === 'DELETE') return void (delete a.proposal, saveTree(t), send(res, 200, 'ok'));
    if (!canManage(me, b)) throw new HttpError(403, `the owners of ${b.name} accept it, or decline it`);
    const moving = p.kind === 'merge' ? Object.keys(t.series).filter(sid => t.series[sid].workspace === id) : [a.proposal!.series!];
    const move = (t: Tree) => moving.map(sid => {
      const from = named(t, sid);
      Object.assign(t.series[sid], { name: freeName(t, p.into, t.series[sid].name), workspace: p.into });
      return { id: sid, from, to: named(t, sid) };
    });
    // Who joins: everyone in a workspace merged, as members; for a series moved, whoever runs its open instances but can't see the
    // other, whom its managers may add.
    const us = users(), joining = p.kind === 'merge' ? everyone(a).filter(x => !everyone(b).includes(x))
      : [...new Set(instances(moving[0]).filter(i => i.doc.status === 'open').map(i => runnerOf(i).by))].filter(x => !us[x] || !canSee({ email: x, role: us[x].role, groups: us[x].groups ?? [] }, b));
    if (req.method === 'GET') return send(res, 200, { ...p, series: move(structuredClone(t)), people: joining });
    if (req.method !== 'POST') throw new HttpError(405, 'GET it, POST {"owners", "members"} to accept it, or DELETE to withdraw or decline it');
    if (a.archived || b.archived) throw new HttpError(409, `${a.archived ? a.name : b.name} is archived`);
    // A run going in a series that moves has read what its workspace reaches, which it could copy where the other's people see it.
    const going = moving.filter(sid => active.has(sid));
    if (going.length) throw new HttpError(409, `wait for its runs to end: ${going.map(sid => named(t, sid)).join(', ')}`);
    const [owners, members] = people(payload), moved = move(t);
    b.owners = [...new Set([...b.owners, ...owners])];
    b.members = [...new Set([...b.members, ...members, ...(p.kind === 'merge' ? everyone(a) : [])])].filter(x => !b.owners.includes(x));
    for (const sid of moving) replaceReadOnly(join(seriesDir(sid), 'series.json'), '{}');
    if (p.kind === 'merge') {
      const add = text(agentsFile(id)), keep = text(agentsFile(p.into)).trimEnd();
      if (add) writeFileSync(agentsFile(p.into), `${keep && `${keep}\n\n`}## ${a.name}\n\n${add}`);
      rmSync(agentsFile(id), { force: true });
      delete t.workspaces[id];
    } else {
      delete a.proposal;
      a.moved = [...(a.moved ?? []).filter(m => fresh(m.at)), { name: p.series!, to: moved[0].to, at: new Date().toISOString() }];
    }
    saveTree(t);
    for (const m of moved) for (const i of instances(m.id)) i.append('server', 'move', { from: m.from, to: m.to, accepted_by: by });
    return send(res, 200, 'ok');
  }
  if (kind === 'series' && !id && req.method === 'POST') {
    // A series, or a task: a single series named Untitled, until its first prompt or a rename names it, and its one instance.
    const { workspace, name: asked, single, logins } = payload;
    mustSee(me, t.workspaces[workspace]);
    const name = single ? freeName(t, workspace, 'Untitled') : safeName(String(asked ?? ''));
    if (Object.values(t.series).some(s => s.workspace === workspace && s.name === name)) throw new HttpError(409, `${name} exists`);
    const ticks = checkTicks(by, logins ?? []), sid = newId();
    t.series[sid] = { name, workspace, ...(single && { single: true }) };
    mkdirSync(seriesDir(sid));
    saveTree(t);
    return send(res, 200, { id: sid, ...(single && { instance: createInstance(sid, name, by, ticks).id }) });
  }
  if (kind === 'series') {
    const s = t.series[id];
    mustSee(me, s && t.workspaces[s.workspace]);
    if (action === 'promote') {
      // A task made a series, as it is, under a name of its own, its one instance the series' first.
      if (!s.single) throw new HttpError(400, `${s.name} is a series already`);
      const name = safeName(String(payload.name ?? ''));
      if (name !== s.name && Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
      delete s.single;
      saveTree(t);
      instances(id)[0].append(by, 'promote', { series: name });
      return send(res, 200, 'ok');
    }
    if (s.single) throw new HttpError(400, `${s.name} is a task, with one instance and no settings: Start another based on this makes it a series`);
    if (req.method === 'POST') return send(res, 200, { id: startWith(id, String(payload.label ?? ''), by, checkTicks(by, payload.logins ?? []), { from: by }).id });
    if (req.method !== 'PUT') throw new HttpError(405, 'PUT, or POST a new instance');
    const change = payload;
    if (change.name !== undefined && change.name !== s.name) {
      const name = safeName(String(change.name));
      if (Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
    }
    if (change.archived !== undefined) s.archived = !!change.archived;
    if (change.archived) cancelWakes([id, ...labels(id).map(l => l.id)]);
    // Anyone may share it as themselves in place of whoever does; only they, or whoever manages the workspace, stop sharing it.
    const was = seriesSettings(seriesDir(id)).shared;
    if (change.share !== undefined && !change.share && was && was.by !== by && !canManage(me, t.workspaces[s.workspace]))
      throw new HttpError(403, `${was.by} shares it: they, or the workspace's owners, stop sharing it`);
    const shared = change.share === undefined ? was : change.share ? { by, since: new Date().toISOString(), logins: checkTicks(by, change.logins ?? []) } : undefined;
    if (change.share && shared!.logins.some(scoped)) throw new HttpError(400, 'a website that lists its people is never lent through a shared series: untick it');
    saveTree(t);
    replaceReadOnly(join(seriesDir(id), 'series.json'), JSON.stringify({ ...(shared && { shared }) }, null, 1));
    return send(res, 200, 'ok');
  }
  if (kind === 'wakes') {
    // People and runs set wakes, one-off or weekly, and cancel them: PUT names the target, an open instance, which the wake continues,
    // or a series, which it starts LABEL of; DELETE names the wake. A run wakes only in its own workspace: it reads wider ones, never
    // acts there.
    const wake = req.method === 'DELETE' ? wakes().pending[id] : undefined, to = wake?.target ?? id, sid = t.series[to] ? to : instance(to).seriesId;
    if (req.method === 'DELETE' && !wake) throw new HttpError(404, 'no such wake pending');
    if (t.series[to]?.single) throw new HttpError(400, `${t.series[to].name} is a task, with one instance: wake that`);
    if (!run) mustSee(me, t.workspaces[t.series[sid].workspace]);
    else if (t.series[sid].workspace !== t.series[run.inst.seriesId].workspace) throw new HttpError(403, `${named(t, sid)} is in another workspace: you can read it, not wake it`);
    if (req.method === 'DELETE') return void (cancelWake(id), send(res, 200, 'ok'));
    const { at: when = '', label, days } = payload, w = String(when);
    const at = w === 'now' ? Date.now() : /^\+\d+[mhd]$/.test(w) ? Date.now() + Number(w.slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[w.at(-1) as 'm'] : Date.parse(w);
    if (req.method !== 'PUT' || Number.isNaN(at)) throw new HttpError(400, 'PUT {"at", "label" for a series, "days"}, or DELETE; at is now, +<n>m|h|d, or a date and time such as 2026-09-14T07:00+08:00');
    if (t.series[sid].archived || t.workspaces[t.series[sid].workspace].archived) throw new HttpError(409, `${named(t, sid)} is archived`);
    if (t.series[to] && !label) throw new HttpError(400, `waking a series starts a new instance: name it with a label${run ? '; to wake your own instance, name its folder: .' : ''}`);
    if (!t.series[to] && instance(to).doc.status !== 'open') throw new HttpError(409, `${instance(to).label} is ${instance(to).doc.status}: to correct it, wake its series with the label ${instance(to).label}-r2`);
    const first = new Date(at), starts = t.series[to] ? safeName(String(label)) : undefined;
    return send(res, 200, setWake(to, {
      at: first.toISOString(), from: run ? `${named(t, run.inst.seriesId)}/${run.inst.label}` : by, ...(run && { inst: run.inst.id }),
      ...(starts && { label: starts }), ...(days !== undefined && { days: weekly(String(days), first, starts) }),
    }));
  }
  // A request to start an instance, which people start or dismiss.
  if (kind === 'requests') {
    const r = wakes().requests[id];
    if (!r) throw new HttpError(404, `no request ${id}`);
    mustSee(me, t.workspaces[t.series[r.series].workspace]);
    if (req.method === 'POST') {
      const inst = startWith(r.series, r.label, by, checkTicks(by, payload.logins ?? []), { from: r.from });
      dropRequest(id);
      return send(res, 200, { id: inst.id });
    }
    if (req.method !== 'DELETE') throw new HttpError(405, 'POST to start it, or DELETE');
    dropRequest(id);
    return send(res, 200, 'ok');
  }
  if (kind !== 'instances') throw new HttpError(404, 'not found');
  const inst = instance(id);
  if (!run) mustSee(me, t.workspaces[t.series[inst.seriesId].workspace]);
  const a = active.get(inst.seriesId);
  const mine = a?.inst === inst ? a : undefined;
  if (!action) see(by, inst.id, inst.log.at(-1)!.seq);
  if (!action) return send(res, 200, { doc: inst.doc, log: inst.log.map(e => isNote(inst, e) ? { ...e, note: true } : e), run: mine ? { n: mine.n, cost: +mine.cost.toFixed(4) } : null, queued: !!queued(inst), runner: runner(inst) });
  if (action === 'trace') return send(res, 200, trace(inst));
  if (action === 'summary') return send(res, 200, summary(inst, by));
  // The screen: anyone who sees the instance reads it; only its own run writes it.
  if (action === 'screen' && req.method === 'GET') return send(res, 200, inst.doc);
  if (action === 'screen' && req.method === 'PUT' && run) return send(res, 200, `saved, rev ${inst.put((await body(req)).toString())}`);
  if (action === 'screen') throw new HttpError(405, "GET, or PUT by the instance's own run");
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (action === 'duplicate') {
    if (t.series[inst.seriesId].single) throw new HttpError(400, 'a task has one instance: Start another based on this makes it a series');
    if (inst.doc.status === 'open') throw new HttpError(409, 'only a closed or abandoned instance can be duplicated');
    if (instances(inst.seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances are open; close one first`);
    return send(res, 200, { id: duplicateInstance(inst, url.searchParams.get('as') ?? '', by, checkTicks(by, payload.logins ?? [])).id });
  }
  if (action === 'rename') {
    // In any status, and mid-run: a run keeps the names it started with (view()).
    const from = inst.label, s = t.series[inst.seriesId], to = safeName(url.searchParams.get('as') ?? '');
    // A task's name is its label.
    if (s.single && to !== s.name && Object.values(t.series).some(x => x.workspace === s.workspace && x.name === to)) throw new HttpError(409, `${to} exists`);
    renameInstance(inst, to);
    if (s.single) {
      s.name = to;
      saveTree(t);
    }
    inst.append(by, 'rename', { from });
    return send(res, 200, 'ok');
  }
  if (inst.doc.status !== 'open') throw new HttpError(409, `instance is ${inst.doc.status}`);
  if (action === 'attach') {
    // A comment's attachment, kept in upload/attachments/ and named in the comment that follows; it starts nothing by itself.
    const tmp = join(tmpDir, randomUUID());
    try {
      await pipeline(req, createWriteStream(tmp));
      return send(res, 200, { file: inst.keep(url.searchParams.get('name') ?? 'file', tmp, 'upload/attachments') });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (action === 'upload') {
    const pane = url.searchParams.get('pane') === 'out' ? 'out' : 'in', tmp = join(tmpDir, randomUUID()), hash = createHash('sha256');
    try {
      await pipeline(req, async function* (chunks: AsyncIterable<Buffer>) { for await (const c of chunks) { hash.update(c); yield c; } }, createWriteStream(tmp));
      inst.upload(by, url.searchParams.get('name') ?? 'file', tmp, hash.digest('hex'), pane, url.searchParams.get('onto'));
    } finally {
      rmSync(tmp, { force: true });
    }
  } else if (action === 'comment') {
    // A comment starts a thread, on an item (at a ref, such as a cell, if given) or on the instance, or replies in one. A person's
    // starts a run. The agent's starts nothing: it says something, or asks, and then the thread waits on a person's reply, from the
    // one it names or else the runner. A sign-off it asks for is the runner's.
    const { thread, item, ref, text, files = [], ask, to, signoff } = payload, threads = inst.threads();
    if (signoff && to) throw new HttpError(400, `a sign-off is the runner's, ${runnerOf(inst).by}: leave out --to`);
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a comment has text');
    if (thread !== undefined && !threads.has(thread)) throw new HttpError(400, `no thread ${thread}; this instance's threads: ${[...threads.keys()].join(', ') || 'none yet'}`);
    if (thread === undefined && item != null && !inst.doc.items.some(i => i.id === item)) throw new HttpError(400, `no item ${item}; the screen's items: ${inst.doc.items.map(i => i.id).join(', ')}`);
    // A run's citation keeps its instance's id, so a rename of that instance leaves it found.
    const kept = files.map((f: unknown) => {
      const ok = run ? citedFor(run, f) : typeof f === 'string' && f.startsWith('upload/attachments/') && !f.includes('..') && existsSync(join(inst.dir, f)) && f;
      if (!ok) throw new HttpError(400, run ? `no file ${f}: cite one under upload/ or working/ of this instance, or of another of its series as ../<label>/...` : `no attachment ${f}`);
      return ok;
    });
    const who = typeof to === 'string' ? to.toLowerCase() : undefined, u = who && users()[who];
    if (who && !(u && canSee({ email: who, role: u.role, groups: u.groups ?? [] }, t.workspaces[t.series[inst.seriesId].workspace])))
      throw new HttpError(400, `${to} can't see this instance; ask its runner, ${runnerOf(inst).by}, or someone in its workspace`);
    const said = inst.append(by, 'comment', {
      thread: thread ?? `c${inst.log.length + 1}`, ...(thread === undefined && { item: item ?? null, ref: ref ?? null }), text: text.trim(), ...(kept.length && { files: kept }),
      ...(run && ask && { ask: true, ...(who && { to: who }), ...(signoff && { signoff: true }) }),
    });
    if (run) return send(res, 200, `${ask ? 'asked' : 'said'} in ${said.thread}, seq ${said.seq}`);
    // Until a task is renamed, its first prompt's opening words name it.
    const s = t.series[inst.seriesId], words = text.trim().split(/\s+/).slice(0, 6).join(' ').replace(/^\.+/, '').slice(0, 60);
    if (s.single && words && !inst.log.some(e => e.op === 'rename' || (e.op === 'comment' && e !== said && isPerson(e)))) {
      const from = inst.label;
      s.name = freeName(t, s.workspace, safeName(words));
      saveTree(t);
      renameInstance(inst, s.name);
      inst.append('server', 'rename', { from });
    }
  } else if (action === 'resolve') {
    // Anyone resolves a thread, and nothing wakes; the agent only one it started, once it no longer applies.
    const { thread, text } = payload, posts = inst.threads().get(thread);
    if (!posts) throw new HttpError(400, `no thread ${thread}`);
    if (run && posts[0].by !== 'agent') throw new HttpError(403, `${posts[0].by} started ${thread}, and resolves it; reply in it with rf say --in ${thread}`);
    inst.append(by, 'resolve', { thread, ...(typeof text === 'string' && text.trim() && { text: text.trim() }) });
    return send(res, 200, `resolved ${thread}`);
  } else if (action === 'signoff') {
    // The runner approves what the agent asked them to sign off, or rejects it, with a note. Either commits the folder in their name,
    // with the ask and the note as its message and, for an approval, their Signed-off-by; and starts a run, as a reply does.
    const { thread, approved, text } = payload, ask = inst.threads().get(thread)?.at(-1), signer = runnerOf(inst).by;
    if (!ask?.signoff) throw new HttpError(409, `no sign-off waits in ${thread}`);
    if (signer !== by) throw new HttpError(403, `only the runner, ${signer}, signs it off; take it over first`);
    if (mine) throw new HttpError(409, 'wait for the run to end');
    const note = typeof text === 'string' ? text.trim() : '';
    const hash = await commit(inst.dir, me, [ask.text, note, approved && `Signed-off-by: ${me.name} <${me.email}>`].filter(Boolean).join('\n\n'));
    if (inst.threads().get(thread)!.at(-1) !== ask) throw new HttpError(409, `${thread} was answered meanwhile`);
    inst.append(by, 'signoff', { thread, approved: !!approved, ...(note && { text: note }), commit: hash });
  } else if (action === 'commit' && run) {
    // The agent commits the folder at a moment worth keeping, in its own name.
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) throw new HttpError(400, 'a commit has a message');
    const hash = await commit(inst.dir, AGENT, message);
    inst.append('agent', 'commit', { run: run.n, message, commit: hash });
    return send(res, 200, `committed ${hash}`);
  } else if (action === 'interrupt') {
    if (!mine?.run) throw new HttpError(409, 'no run going');
    inst.append(by, 'interrupt');
    mine.interrupted = true;
    await mine.run.interrupt();
    return send(res, 200, 'ok');
  } else if (action === 'logins') {
    // The runner ticks the instance's logins anew, as before its first prompt.
    if (runnerOf(inst).by !== by) throw new HttpError(403, `${runnerOf(inst).by} runs it, and ticks its logins`);
    inst.append(by, 'logins', { logins: checkTicks(by, payload.logins ?? []) });
    return send(res, 200, 'ok');
  } else if (action === 'takeover') {
    // Taking over makes you the runner from now on, with your own logins ticked; whoever closes answers for the whole instance.
    if (mine) throw new HttpError(409, 'wait for the run to end');
    inst.append(by, 'takeover', { from: runnerOf(inst).by, logins: checkTicks(by, payload.logins ?? []) });
    return send(res, 200, 'ok');
  } else if (action === 'close' || action === 'abandon') {
    if (mine) throw new HttpError(409, 'wait for the run to end');
    if (runnerOf(inst).by !== by) throw new HttpError(403, `only the runner, ${runnerOf(inst).by}, ${action === 'close' ? 'closes it, as closing signs it off' : 'abandons it'}; take it over first`);
    await (action === 'close' ? inst.close(me) : inst.abandon(by));
    cancelWakes([inst.id]);
    if (action === 'close') closed(inst, by);
    return send(res, 200, 'ok');
  } else throw new HttpError(404, `no action ${action}`);
  kick(inst);
  send(res, 200, 'ok');
}

async function admin(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  const email = decodeURIComponent(url.pathname.split('/')[2] ?? '').toLowerCase();
  if (!email) {
    const t = tree(), us = users();
    if (req.method === 'PUT') {
      // Roles by email: a new email becomes a person; no one is removed.
      const { roles, force } = await json(req), after = structuredClone(us);
      for (const [e, role] of Object.entries(roles as Record<string, string>)) {
        if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new HttpError(400, `not an email address: ${e}`);
        if (!ROLES.includes(role as Role)) throw new HttpError(400, `${e}: a role is one of ${ROLES.join(', ')}`);
        if (e.toLowerCase() === me.email && role !== 'admin') throw new HttpError(409, 'you cannot lock yourself out');
        after[e.toLowerCase()] = { ...after[e.toLowerCase()], role: role as Role };
      }
      guard(hidden(t, us), hidden(t, after), force);
      for (const [e, role] of Object.entries(roles as Record<string, Role>)) upsertUser(e, { role });
      return send(res, 200, 'ok');
    }
    // Besides where each person is: the open instances they run in workspaces they aren't in, which they'd lose sight of as users.
    const open = Object.entries(t.series).flatMap(([sid, s]) => instances(sid).filter(i => i.doc.status === 'open').map(i => ({ i, w: t.workspaces[s.workspace], path: `${named(t, sid)}/${i.label}` })));
    return send(res, 200, Object.entries(us).map(([email, { sub, epoch, groups, ...u }]) => ({
      email, ...u, workspaces: Object.values(t.workspaces).filter(w => everyone(w).includes(email)).map(w => w.name),
      outside: open.filter(o => runnerOf(o.i).by === email && !canSee({ email, role: 'user', groups: groups ?? [] }, o.w)).map(o => o.path),
    })));
  }
  if (!users()[email]) throw new HttpError(404, `no user ${email}`);
  if (req.method === 'DELETE') {
    if (email === me.email) throw new HttpError(409, 'you cannot remove yourself');
    removeUser(email);
  } else if (req.method === 'PUT') {
    const { disabled, signout } = await json(req);
    if (email === me.email && disabled) throw new HttpError(409, 'you cannot lock yourself out');
    if (disabled !== undefined) upsertUser(email, { disabled: !!disabled });
    if (signout) signOutEverywhere(email);
  } else throw new HttpError(405, 'PUT or DELETE');
  send(res, 200, 'ok');
}

// Skills: anyone signed in may list and read them; every run loads every live one. Those who may publish push versions, with rf.
async function skillsRoute(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [id = '', action, n] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  if (!id && req.method === 'GET') return send(res, 200, skills().map(s => ({ id: s.id, name: s.name, description: s.description, pushed: pushed(s) })));
  if (action === 'versions' && n && req.method === 'GET') return send(res, 200, versionFiles(id, Number(n)));
  if (action === 'versions' && req.method === 'GET') return send(res, 200, versionsOf(id));
  if (action === 'versions' && req.method === 'POST') {
    if (!can(me, 'publish')) throw new HttpError(403, 'pushing skills is for admins and those they grant publish: ask an admin');
    const { files, from } = await json(req);
    return send(res, 200, `pushed ${id} version ${pushSkill(id, from === undefined ? files : versionFiles(id, Number(from)), me.email)}, live now`);
  }
  throw new HttpError(405, 'GET, or POST a version');
}

// Connections: anyone signed in may list them, each with its login, to connect or sign in on the Logins page; admins keep them,
// with rf.
async function connectionsRoute(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const name = decodeURIComponent(url.pathname.slice(13));
  if (!name && req.method === 'GET') return send(res, 200, connections().map(c => ({ ...c, login: loginOf(c), ...(c.type === 'website' && { allowed: allowed(websites()[c.name], me.email) }) })));
  if (me.role !== 'admin') throw new HttpError(403, 'admins keep connections');
  if (req.method === 'PUT') return send(res, 200, setConnection(name, await json(req), me.email));
  if (req.method === 'DELETE') return send(res, 200, (removeConnection(name), 'ok'));
  throw new HttpError(405, 'PUT or DELETE');
}

serveSandboxes({
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
      browsers: () => (a.browsers ??= new Browsers(a.inst, a.n)),
      intercepts: host => intercepts(a, host),
      call: (host, req, res) => call(a, host, req, res),
    };
  },
});

const server = createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://x');
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site && site !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    const me = await authenticate(req, res, url);
    if (!me) return;
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/me') {
      const { text, logo } = brand();
      send(res, 200, { ...me, names: names(me), sign_in: mode, m365: m365Ready(), browsers: !!process.env.RF_BROWSER_URL, brand: { text: text || null, logo: !!logo }, can: CAPS.filter(c => can(me, c)) });
    } else if (url.pathname === '/capabilities') {
      if (me.role !== 'admin') throw new HttpError(403, 'admins grant capabilities');
      if (req.method === 'PUT') {
        const { cap, people } = await json(req);
        if (!CAPS.includes(cap)) throw new HttpError(400, `a capability is one of ${CAPS.join(', ')}`);
        if (!isPeople(people)) throw new HttpError(400, `${cap}: a list of emails and Entra group ids: ${JSON.stringify(people)}`);
        writeJson('capabilities.json', { ...granted(), [cap]: people.map(p => p.toLowerCase()) });
      }
      send(res, 200, Object.fromEntries(CAPS.map(c => [c, granted()[c] ?? []])));
    } else if (url.pathname === '/brand' && req.method === 'PUT') {
      if (me.role !== 'admin') throw new HttpError(403, "the deployment's brand is the admins'");
      const { text, logo, clear } = await json(req), b = { ...(!clear && brand()) };
      if (text !== undefined) b.text = String(text);
      if (logo) {
        const type = String(logo.name).match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
        if (!type) throw new HttpError(400, 'a logo is a .png, .jpg, .gif, .webp or .svg file');
        Object.assign(b, { logo: String(logo.data), type: `image/${type}` });
      }
      writeJson('brand.json', b);
      send(res, 200, 'saved');
    } else if (url.pathname === '/brand/logo') {
      const { logo, type } = brand();
      if (!logo) throw new HttpError(404, 'no logo');
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      res.end(Buffer.from(logo, 'base64'));
    }
    else if (url.pathname === '/api/events') events(me, req, res);
    else if (url.pathname === '/api') send(res, 200, listing(me));
    else if (url.pathname === '/api/files') send(res, 200, pullable(me, url.searchParams.get('path') ?? ''));
    else if (url.pathname === '/api/runs') send(res, 200, runs(me, url.searchParams.get('since') ?? ''));
    else if (url.pathname === '/api/activity') send(res, 200, activity(me, url.searchParams.get('since') ?? ''));
    else if (url.pathname === '/api/status') send(res, 200, status(me));
    // Each index the person can see, admins all, others those they are indexing.
    else if (url.pathname === '/api/indexes') send(res, 200, indexes().filter(x => me.role === 'admin' || x.people.some(p => p.who === me.email)));
    else if (url.pathname.startsWith('/files/')) await file(me, res, url, false);
    else if (url.pathname.startsWith('/preview/')) await file(me, res, url, true);
    else if (url.pathname.startsWith('/api/')) await api(me, req, res, url);
    else if (url.pathname === '/agents' && req.method === 'GET') send(res, 200, { text: text(agentsFile()) });
    else if (url.pathname === '/agents' && req.method === 'PUT') {
      if (me.role !== 'admin') throw new HttpError(403, "the company's AGENTS.md is the admins'");
      writeFileSync(agentsFile(), (await body(req)).toString());
      send(res, 200, 'ok');
    } else if (url.pathname === '/cli') await cli(req, res, url);
    else if (url.pathname === '/tokens' && req.method === 'GET') send(res, 200, myTokens(me.email));
    else if ((url.pathname === '/tokens' && req.method === 'POST') || (url.pathname.startsWith('/tokens/') && req.method === 'DELETE')) {
      // Made and revoked on the page only, as the session's own person: a token that could make tokens would outlive its revocation.
      const own = session(req);
      if (!own) throw new HttpError(403, 'tokens are made and revoked on the page');
      if (req.method === 'DELETE') return send(res, 200, (revokeToken(own.email, decodeURIComponent(url.pathname.slice(8))), 'ok'));
      const { name, days } = await json(req);
      send(res, 200, { token: newToken(own.email, String(name ?? '').trim(), Number(days)) });
    } else if (url.pathname === '/logins' && req.method === 'GET') send(res, 200, logins(me.email).map(l => ({ ...l, missing: ungranted(l) })));
    else if (/^\/logins\/[^/]+\/connect$/.test(url.pathname)) {
      // A link on another site must not start it: Microsoft may sign in again without asking.
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'connect from the Logins page');
      const c = byLogin(decodeURIComponent(url.pathname.split('/')[2])), login = c && loginOf(c);
      if (!login?.scope) throw new HttpError(404, 'no connection signs in to Microsoft with that login');
      await connect(res, me.email, login);
    }
    else if (url.pathname === '/logins/m365/offers' && req.method === 'POST') send(res, 200, (await offer(me.email, String((await json(req)).add ?? '')), track(me.email), 'ok'));
    else if (url.pathname.startsWith('/logins/m365/offers/') && req.method === 'DELETE') send(res, 200, (unoffer(me.email, decodeURIComponent(url.pathname.slice(20))), forget(me.email, decodeURIComponent(url.pathname.slice(20))), 'ok'));
    else if (url.pathname.startsWith('/logins/web/') && req.method === 'POST') send(res, 200, { id: await startSignIn(me.email, decodeURIComponent(url.pathname.slice(12)), String((await json(req)).header ?? '')) });
    else if (/^\/signins\/\w+\/view$/.test(url.pathname) && req.method === 'GET') {
      const html = await viewPage(me.email, url.pathname.split('/')[2]);
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    else if (/^\/signins\/\w+$/.test(url.pathname) && (req.method === 'POST' || req.method === 'DELETE')) send(res, 200, (await endSignIn(me.email, url.pathname.slice(9), req.method === 'POST'), 'ok'));
    // Your own OpenRouter key, checked with OpenRouter as you save it, and whether your runs use it: a new one, or not using it, ends
    // its running out of credits.
    else if (url.pathname === '/logins/openrouter' && req.method === 'PUT') {
      const { key, enabled } = await json(req), was = logins(me.email).find(l => l.id === 'openrouter'), k = String(key ?? '').trim();
      if (!k && !was) throw new HttpError(400, 'your OpenRouter key: paste it to save it');
      if (k && !(await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/key`, { headers: { authorization: `Bearer ${k}` } })).ok) throw new HttpError(400, 'OpenRouter refused this key');
      saveLogin(me.email, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since: k ? new Date().toISOString() : was!.since, offers: [], enabled: !!enabled, ...(!k && enabled && was!.expired && { expired: true }) }, k || undefined);
      send(res, 200, 'saved');
    }
    else if (url.pathname.startsWith('/logins/') && req.method === 'DELETE') send(res, 200, (signOut(me.email, decodeURIComponent(url.pathname.slice(8))), url.pathname === '/logins/m365' && forget(me.email), 'ok'));
    else if (url.pathname === '/users' || url.pathname.startsWith('/users/')) await admin(me, req, res, url);
    else if (url.pathname === '/skills' || url.pathname.startsWith('/skills/')) await skillsRoute(me, req, res, url);
    else if (url.pathname === '/connections' || url.pathname.startsWith('/connections/')) await connectionsRoute(me, req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    if (res.headersSent) res.destroy();
    else send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
});
// A sign-in's live view, the person's own: its websockets pass through to the browser service.
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const me = session(req), m = /^\/signins\/(\w+)\/(view\/(?:watch|drive))$/.exec(URL.parse(req.url!, 'http://x')?.pathname ?? '');
  if (!me || !m || !isSignIn(me.email, m[1])) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  passUpgrade(req, socket, head, `/sessions/${m[1]}/${m[2]}`);
});
if (process.env.RF_BROWSER_URL) reap().catch(e => console.error('the browser service: browsers a restart left open are still open', e));
server.listen(port, host, () => {
  startIndexing();
  startWaking();
  if (process.env.RF_BROWSER_URL) setInterval(() => keepAlive().catch(e => console.error('keeping logins alive:', e)), 60_000).unref();
  if (m365Ready()) checkLogins(connections().map(loginOf).flatMap(l => l.scope ? [l] : []));
  console.log(`rollforward on http://${host}:${port}, data in ${root}, sign-in ${mode}${process.env.RF_TODAY ? `, skills take today as ${process.env.RF_TODAY} (RF_TODAY)` : ''}`);
});
