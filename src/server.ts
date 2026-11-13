import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeSync, cpSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsFile, closedBefore, createInstance, duplicateInstance, renameInstance, replaceReadOnly, HttpError, instance, instanceDir, instances, isPerson, labels, newId, openFile, openStore, readFile, safeName, seriesDir, type Entry, type Instance } from './store.ts';
import { AGENT, commit } from './git.ts';
import { serveSandboxes, userland } from './sandbox.ts';
import { agentRoot, id as agentId } from './agent.ts';
import { checkTheme, stylesheet, themeLogo } from './theme.ts';
import { asPerson, authenticate, CAPS, can, capabilities, checkConfig, cli, connect, myTokens, newToken, removeUser, revokeToken, ROLES, session, signOutEverywhere, ungranted, upsertUser, users, type Me, type Role, type User } from './auth.ts';
import { act, canManage, canSee, changes, everyone, initSystem, isPeople, readJson, saveTree, see, seen, tree, writeJson, type Tree, type Workspace } from './system.ts';
import { checkTicks, logins, runnerOf, saveLogin, signOut, unoffer } from './logins.ts';
import { agentCall } from './agent-api.ts';
import { checkLogins } from './entra.ts';
import { answered, byLogin, call, connections, intercepts, letIn, loginOf, removeConnection, setConnection, setLetIn, upstreams } from './connections.ts';
import { addSite, allowHost, Browsers, endSignIn, enrolFlagged, isSignIn, keepAlive, passUpgrade, reap, removeHost, removeSite, setSite, startSignIn, unreached, viewPage, websitesOf } from './browsers.ts';
import { addVpn, cancelVpnSignIn, disconnectVpn, isVpnSignIn, reapVpns, removeVpn, saveVpnSignIn, startVpnSignIn, vpns } from './vpns.ts';
import { ask, decide, forgetGrants, forgetWorkspace, lapse, revoke, visible } from './grants.ts';
import { offer } from './connections/graph.ts';
import { addWarehouse } from './connections/databricks.ts';
import { forget, indexes, startIndexing, track } from './indexes.ts';
import { seriesSettings } from './series.ts';
import { openSkills, pushed, pushSkill, skills, versionFiles, versionsOf } from './skills.ts';
import { active, archived, byToken, cancelWake, cancelWakes, closed, correct, dropRequest, isNote, kick, MAX_OPEN, named, pending, queued, remove, resolveFor, setWake, startWaking, starts, startWith, stop, wakes, wakesOf, weekly, reads, CUT, type Active, type Request } from './waker.ts';

const root = resolve(process.argv[2]);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(app, 'web', 'index.html');
checkTheme();
// The release this checkout is at, as git describes it; an image built without .git has none.
const version = existsSync(join(app, '.git')) ? execFileSync('git', ['describe', '--tags', '--always'], { cwd: app, encoding: 'utf8' }).trim() : null;
const exec = promisify(execFile);
const port = Number(process.argv[3] ?? 8780);
const host = process.env.RF_HOST ?? '127.0.0.1';
const tmpDir = join(root, '.tmp'), previews = join(root, '.previews');
if (!existsSync(join(agentRoot, 'usr'))) throw new Error(`no agent image at ${agentRoot}: node scripts/agent.ts unpacks agent-${agentId}, which this checkout runs`);
initSystem(root);
// As it starts, before anything changes .rf/, the server copies it to .rf-backups/<time>/, keeping the newest five, but the indexes'
// caches and the runs' copies of them, which Graph gives again: what a mistake or a release's migration changed is there to put back.
const backups = join(root, '.rf-backups');
mkdirSync(backups, { recursive: true, mode: 0o700 });
cpSync(join(root, '.rf'), join(backups, new Date().toISOString().replace(/[:.]/g, '-')), { recursive: true, filter: p => !['index', 'runs'].includes(basename(p)) });
for (const old of readdirSync(backups).sort().slice(0, -5)) rmSync(join(backups, old), { recursive: true });
openStore(root);
// A new data root starts with one connection, Microsoft 365's, graph.
if (!existsSync(join(root, '.rf', 'connections.json'))) writeJson('connections.json', { graph: { type: 'graph', updated_by: 'server', updated_at: new Date().toISOString() } });

// A file's sha256, kept by its path, size and change time, as each view of an instance compares its files again.
const sums = new Map<string, [string, string]>();
function sha256(dir: string, file: string): string | undefined {
  const fd = openFile(dir, file);
  if (fd === undefined) return undefined;
  try {
    const st = fstatSync(fd), key = `${st.size}:${st.mtimeMs}`, hit = sums.get(join(dir, file));
    if (hit?.[0] === key) return hit[1];
    const sum = createHash('sha256').update(readFileSync(fd)).digest('hex');
    sums.set(join(dir, file), [key, sum]);
    return sum;
  } finally {
    closeSync(fd);
  }
}

// The series' latest closed instance before this one, by label, and whether each of this one's files is new since it, changed or
// the same, by content, as its item of the same id had it.
function previous(inst: Instance) {
  const prev = closedBefore(inst).at(-1);
  if (!prev) return null;
  return { label: prev.label, changed: Object.fromEntries(inst.doc.items.filter(i => i.file).map(i => {
    const was = prev.doc.items.find(p => p.id === i.id)?.file, now = was && sha256(inst.dir, i.file!);
    return [i.id, !was ? 'new' : now && now === sha256(prev.dir, was) ? 'same' : 'changed'];
  })) };
}

// A free name among a workspace's series: the name, else the name 2, 3 and on.
function freeName(t: Tree, ws: string, name: string): string {
  const taken = new Set(Object.values(t.series).filter(s => s.workspace === ws).map(s => s.name));
  let n = name;
  for (let k = 2; taken.has(n); k++) n = `${name} ${k}`;
  return n;
}

openSkills(root);
checkConfig();
for (const dir of [tmpDir, previews]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
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

// A run, on its sandbox's socket, by its token: on /api a caller like any person, with the few rights api() gives a run; on /agent
// what only a run has, its series' skills and its runner's logins and browsers.
type Caller = Me & { run?: Active };
async function agent(req: IncomingMessage, res: ServerResponse, url: URL) {
  const a = byToken.get(req.headers.authorization?.replace('Bearer ', '') ?? '');
  if (!a) throw new HttpError(401, 'no run for this token');
  if (url.pathname.startsWith('/api/')) return api({ email: 'agent', name: 'Agent', role: 'user', groups: [], run: a }, req, res, url);
  // Browsers and deliveries: rf expired, rf delivered (see agent-api.ts).
  const r = await agentCall(a, url.pathname, req.method ?? 'GET', () => body(req));
  if (r) return send(res, r.status, r.data);
  throw new HttpError(404, 'not found');
}

function mustSee(me: Me, w: Workspace | undefined): Workspace {
  if (!w || !canSee(me, w)) throw new HttpError(404, 'no such workspace');
  return w;
}

async function closeUnlent() {
  await Promise.all([...active.values()].map(a => a.browsers?.closeUnlent()));
}

// A run's browser on a website, for whoever sees its instance to watch, if they may use the website: the run's browsers, and its
// session on the browser service.
function watched(me: Me, id: string, site: string): { browsers: Browsers; id: string } {
  const t = tree(), inst = instance(id), a = active.get(inst.seriesId);
  mustSee(me, t.workspaces[t.series[inst.seriesId].workspace]);
  const b = a?.inst === inst ? a.browsers?.watchable().get(site) : undefined;
  if (!b) throw new HttpError(404, `no browser of a run on ${site} for you to watch`);
  return { browsers: a!.browsers!, id: b };
}

// Whom an open instance waits on, and with what: each ask no one answered on the person it names, else the runner, and each such
// note on the runner.
function waits(inst: Instance): { who: string; e: Entry }[] {
  if (inst.doc.status !== 'open') return [];
  const runner = runnerOf(inst).by;
  return inst.log.filter(e => e.op === 'comment' && ((e.by === 'agent' && e.ask) || isNote(inst, e)) && !inst.answered(e)).map(e => ({ who: (e.to as string | undefined) ?? runner, e }));
}

// Whom a request to start an instance of a series waits on: whoever shares it, else the runner of its newest instance, else the
// person who asked, if a person did; no one in particular, who anyone in its workspace may answer, else.
function asked(r: Request): string | null {
  const newest = instances(r.series).filter(i => !i.hole).at(-1);
  return seriesSettings(seriesDir(r.series)).shared?.by ?? (newest ? runnerOf(newest).by : r.from.includes('@') ? r.from : null);
}

// The open instances whose runner couldn't see them with this tree and these people: their runs can't use the runner's logins.
function hidden(t: Tree, us: Record<string, User>): string[] {
  return Object.entries(t.series).flatMap(([sid, s]) => instances(sid).filter(i => {
    const by = runnerOf(i).by, p = asPerson(by, us[by]);
    return i.doc.status === 'open' && (!p || !canSee(p, t.workspaces[s.workspace]));
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
const kept = new WeakMap<Instance, { key: string; active: string; asks: string[]; runner: string; acted: string[]; cost: number; corrections: number; wrong: string[];
  refused: { at: string; run: number; site: string; login: string; hosts: string[] }[] }>();
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

// What makes an instance new to a person, when someone else or the agent did it: a run's end, a comment, a sign-off, an upload, a
// takeover, a close, a deletion, or a move to another workspace that someone else accepted.
const NEWS = ['done', 'comment', 'signoff', 'upload', 'takeover', 'close', 'abandon', 'delete', 'move'];

// What an instance's runs cost, since its latest duplication, a deleted one's as its deletion kept it.
const costOf = (i: Instance) => +i.log.slice(i.log.findLastIndex(e => e.op === 'duplicate') + 1).reduce((t, e) => t + (['done', 'delete'].includes(e.op) ? e.cost as number : 0), 0).toFixed(4);

function summary(i: Instance, me: Me, w8 = wakes()) {
  const email = me.email;
  const key = `${i.log.length}:${i.doc.rev}:${seriesSettings(i.series()).shared?.by ?? ''}`;
  const news = i.log.findLast(e => e.by !== email && e.accepted_by !== email && NEWS.includes(e.op)), s = seen(email);
  let k = kept.get(i);
  if (k?.key !== key) kept.set(i, k = { key, active: i.log.at(-1)!.at, asks: waits(i).map(w => w.who), runner: runnerOf(i).by, acted: [...new Set(i.log.filter(isPerson).map(e => e.by))], cost: costOf(i), corrections: i.log.filter(e => e.op === 'correction').length,
    wrong: i.log.filter(e => e.op === 'correction' && e.kind === 'wrong').map(e => e.at),
    refused: i.log.filter(e => e.op === 'browser' && e.hosts).map(e => ({ at: e.at, run: e.run as number, site: e.site as string, login: e.login as string, hosts: Object.keys(e.hosts as object) })) });
  return {
    id: i.id, label: i.label, status: i.doc.status, rev: i.doc.rev, running: active.get(i.seriesId)?.inst === i, queued: !!queued(i),
    asks: k.asks, wakes: wakesOf(i.id, w8), fired: w8.fired[i.id] ?? null, runner: k.runner, cost: k.cost, active: k.active,
    unread: !!news && news.at > s.since && news.seq > (s.at[i.id] ?? 0), corrections: k.corrections,
    // A deleted instance's hole: who deleted it, and when.
    deleted: i.hole ? { by: i.log[0].by, at: i.log[0].at } : null,
    // What says it was wrong, for its runner under Waiting on you, for a week, as a correction is never withdrawn.
    wrong: k.wrong.filter(fresh).length,
    // Only admins decide hosts: those rated high or internal, with why, for a week.
    refused: k.refused.filter(e => fresh(e.at) && e.login && websitesOf(e.login)[e.site]).map(e => {
      const checks = websitesOf(e.login)[e.site].checks ?? {}, hosts = unreached(e.login, e.site, e.hosts).filter(h => me.role === 'admin' && checks[h] && ['high', 'internal'].includes(checks[h].verdict));
      return { ...e, hosts, why: Object.fromEntries(hosts.filter(h => checks[h]).map(h => [h, checks[h].why])) };
    }).filter(e => e.hosts.length),
  };
}

// A proposal lapses, and a series moved out stops showing where it was, a week on.
const fresh = (at: string) => Date.now() - Date.parse(at) < 7 * 86400e3;
// The proposals open, each by the id of the workspace it merges or moves a series out of, into the one it names, while whoever
// proposed it still manages that workspace.
const proposals = (t: Tree) => Object.entries(t.workspaces).filter(([, w]) => {
  const by = w.proposal && fresh(w.proposal.at) && asPerson(w.proposal.by);
  return !!by && canManage(by, w);
}).map(([id, w]) => {
  const p = w.proposal!;
  return { id, into: p.to, kind: p.kind, from: w.name, to: t.workspaces[p.to].name, series: p.series ? t.series[p.series].name : null, by: p.by, at: p.at };
});

function listing(me: Me) {
  const t = tree(), w8 = wakes(), open = proposals(t), granted = visible(me).filter(g => ['pending', 'approved'].includes(g.state)), byName = (a: [string, { name: string }], b: [string, { name: string }]) => a[1].name.localeCompare(b[1].name);
  return Object.entries(t.workspaces).filter(([, w]) => canSee(me, w)).sort(byName).map(([id, w]) => {
    const series = Object.entries(t.series).filter(([, s]) => s.workspace === id).sort(byName).map(([sid, s]) => {
      const { shared } = seriesSettings(seriesDir(sid));
      return {
        id: sid, name: s.name, archived: !!s.archived, single: !!s.single, shared_by: shared?.by ?? null, shared_logins: shared?.by === me.email ? shared.logins : [],
        wakes: wakesOf(sid, w8), fired: w8.fired[sid] ?? null,
        requests: Object.entries(w8.requests).filter(([, r]) => r.series === sid).map(([id, r]) => ({ id, ...r, who: asked(r) })),
        instances: instances(sid).map(i => summary(i, me, w8)),
      };
    });
    // Mine: a workspace you own, or one where you ran an instance, commented or uploaded; membership alone isn't.
    const mine = w.owners.includes(me.email) || series.some(s => instances(s.id).some(i => kept.get(i)!.acted.includes(me.email)));
    return {
      id, name: w.name, archived: !!w.archived, owners: w.owners, members: w.members, manage: canManage(me, w), agents: text(agentsFile(id)), mine,
      proposal: open.find(p => p.id === id || p.into === id) ?? null, moved: (w.moved ?? []).filter(m => fresh(m.at)),
      // The workspaces its agents read, and those whose agents read it, as each one's managers let them.
      reads: reads(t, id).map(o => ({ id: o, name: t.workspaces[o].name })), readers: (w.readers ?? []).map(o => ({ id: o, name: t.workspaces[o].name })),
      // The grants to use websites here, asked or approved: all of them for its managers, else one's own.
      grants: granted.filter(g => g.workspace === id),
      series,
    };
  });
}

// An instance's runs started since `since`, and since its latest duplication: when, how each ended, its cost, whose it was and what started it. A deleted instance's are
// as its deletion kept them, for the totals: when, how each ended, its cost and whose it was.
type RunRow = { run: number; at: string; outcome: string; failure: string | null; seconds: number; cost: number; runner: string; started: { op: string; by: string } | null; error: string | null };
function runsOf(i: Instance, since = ''): RunRow[] {
  if (i.hole) return ((i.log[0].runs ?? []) as RunRow[]).filter(r => r.at >= since).map(r => ({ ...r, started: null, error: null }));
  const a = active.get(i.seriesId);
  return i.log.slice(i.log.findLastIndex(e => e.op === 'duplicate') + 1).filter(r => r.op === 'run' && r.at >= since).map(r => {
    const d = i.log.find(e => e.op === 'done' && e.run === r.run), seen = (i.log.findLast(e => e.op === 'done' && e.seq < r.seq)?.seen as number | undefined) ?? 0;
    const cause = pending(i, seen).find(e => e.seq <= (r.upto as number));
    const error = d?.error as string | undefined, outcome = !d ? 'running' : !error ? (d.aborted ? 'interrupted' : 'done') : Object.values(CUT).includes(error) ? 'cut' : 'failed';
    return {
      run: r.run as number, at: r.at, outcome,
      // Why a failed run failed: out of OpenRouter credits, a provider's policy refusing it, the time limit, or anything else.
      failure: outcome !== 'failed' ? null : /\b402\b|credits/i.test(error!) ? 'credits' : /\b403\b|terms of service|usage polic|flagged/i.test(error!) ? 'policy' : error === 'time limit' ? 'time limit' : 'other',
      seconds: Math.round(((d ? Date.parse(d.at) : Date.now()) - Date.parse(r.at)) / 1000), cost: d ? d.cost as number : a?.inst === i ? +a.cost.toFixed(4) : 0,
      runner: i.log.findLast(e => e.seq < r.seq && ['create', 'duplicate', 'takeover'].includes(e.op))!.by,
      started: cause ? { op: cause.op, by: cause.op === 'wake' ? cause.from as string : cause.by } : null,
      error: error ?? null,
    };
  });
}

// Every run in what `me` sees, started since `since`, by where it ran.
function runs(me: Me, since: string) {
  const t = tree();
  return Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace])).flatMap(([sid]) => instances(sid).flatMap(i => runsOf(i, since).map(r => ({ path: `${named(t, sid)}/${i.label}`, ...r }))))
    .sort((x, y) => x.at.localeCompare(y.at));
}

// What people and the agent said, what people uploaded, closed and deleted, and each run's failure, per instance `me` sees, since
// `since`.
function activity(me: Me, since: string) {
  const t = tree();
  return Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace])).flatMap(([sid]) => instances(sid).map(i => ({
    path: `${named(t, sid)}/${i.label}`,
    entries: i.log.filter(e => e.at >= since && ((e.op === 'done' && e.error) || e.op === 'comment' || (isPerson(e) && ['upload', 'close', 'abandon', 'delete'].includes(e.op)))).map(e => ({
      at: e.at, by: e.by, op: e.op, ...(e.op === 'comment' && { text: e.text }), ...(e.op === 'upload' && { file: e.file }), ...(e.op === 'done' && { run: e.run, error: e.error }),
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
    asks: open.flatMap(i => waits(i).map(({ who, e }) => ({ who, path: path(i), since: e.at, text: e.text as string, note: isNote(i, e) }))),
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
  if (inst.doc.status === 'deleted') return [];
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
    if (st) out.push({ path: at, size: more.text === undefined ? st.size : Buffer.byteLength(more.text), mtime: st.mtime.toISOString(), ...more });
  };
  const near = (at: string) => !path || at === path || at.startsWith(path + '/') || path.startsWith(at + '/');
  if (existsSync(agentsFile())) add('AGENTS.md', agentsFile(), { text: text(agentsFile()) });
  for (const [wid, w] of Object.entries(t.workspaces).filter(([, w]) => canSee(me, w))) {
    if (existsSync(agentsFile(wid))) add(`${w.name}/AGENTS.md`, agentsFile(wid), { text: text(agentsFile(wid)) });
    for (const [sid, s] of Object.entries(t.series).filter(([, s]) => s.workspace === wid)) for (const l of labels(sid)) {
      const at = `${w.name}/${s.name}/${l.label}`, dir = instanceDir(l.id), inst = instance(l.id);
      if (!near(at)) continue;
      if (inst.hole) {
        add(`${at}/instance.json`, join(dir, 'instance.json'), { text: text(join(dir, 'instance.json')) });
        add(`${at}/screen.json`, join(dir, 'screen.json'), { text: JSON.stringify(inst.doc) });
        add(`${at}/log.jsonl`, join(dir, 'log.jsonl'), { text: JSON.stringify(inst.log[0]) + '\n' });
      } else for (const f of walk(dir)) add(`${at}/${relative(dir, f).split(sep).join('/')}`, f, { url: `/files/${l.id}/${relative(dir, f).split(sep).map(encodeURIComponent).join('/')}` });
    }
  }
  return out.filter(f => !path || f.path === path || f.path.startsWith(path + '/'));
}

let previewing = 0;
const turns: (() => void)[] = [];

async function file(me: Me, res: ServerResponse, url: URL, preview: boolean) {
  const [id, ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const rel = rest.join('/');
  if (posix.normalize(rel) !== rel || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
  const inst = instance(id);
  mustSee(me, tree().workspaces[tree().series[inst.seriesId].workspace]);
  if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
  const fd = openFile(inst.dir, rel);
  if (fd === undefined) throw new HttpError(404, 'no such file');
  if (preview) {
    // preview.py runs in the agent's userland, with no network and nothing of the host's: the file, up to 100 MB, streams to its
    // stdin. What it makes is kept, until the server restarts, by the file's name and the content it was given; at most 2 run at
    // once, the rest waiting their turn, so previews never crowd out runs.
    if (fstatSync(fd).size > 100e6) {
      closeSync(fd);
      throw new HttpError(413, `${basename(rel)} is over 100 MB, too big to preview: download it`);
    }
    // A part of the file, as its query asks, such as a workbook's sheet or an email's attachment, is a preview of its own.
    const part = url.search.slice(1), sum = createHash('sha256').update(`${basename(rel)}\n${part}\n`);
    for await (const c of createReadStream('', { fd, start: 0, autoClose: false })) sum.update(c);
    const kept = join(previews, `${inst.id}-${sum.digest('hex')}`);
    if (inst.doc.status === 'deleted') {
      closeSync(fd);
      throw new HttpError(404, 'the instance was deleted');
    }
    if (existsSync(kept)) {
      closeSync(fd);
      res.writeHead(200, { 'content-type': 'application/json' });
      return void createReadStream(kept).pipe(res);
    }
    if (previewing < 2) previewing++;
    else await new Promise<void>(go => turns.push(go));
    try {
      if (inst.doc.status === 'deleted') {
        closeSync(fd);
        throw new HttpError(404, 'the instance was deleted');
      }
      const run = exec('bwrap', [
        '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', ...userland(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--ro-bind', join(app, 'src', 'preview.py'), '/preview.py', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--', '/opt/venv/bin/python', '/preview.py', basename(rel), part,
      ], { timeout: 30_000, maxBuffer: 64e6 });
      const content = createHash('sha256').update(`${basename(rel)}\n${part}\n`);
      const [{ stdout }] = await Promise.all([run, pipeline(createReadStream('', { fd, start: 0 }), async function* (chunks: AsyncIterable<Buffer>) {
        for await (const c of chunks) { content.update(c); yield c; }
      }, run.child.stdin!)]);
      if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
      const tmp = join(tmpDir, randomUUID());
      writeFileSync(tmp, stdout);
      renameSync(tmp, join(previews, `${inst.id}-${content.digest('hex')}`));
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(stdout);
    } finally {
      const go = turns.shift();
      if (go) go();
      else previewing--;
    }
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
// Each request's JSON body, as read, for the system's log.
const bodies = new WeakMap<IncomingMessage, object>();
const json = async (req: IncomingMessage) => {
  let parsed;
  try { parsed = JSON.parse((await body(req)).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); }
  bodies.set(req, parsed);
  return parsed;
};
const people = (w: { owners?: unknown; members?: unknown }) => [w.owners, w.members].map(list => {
  if (!isPeople(list)) throw new HttpError(400, `owners and members are lists of emails and Entra group ids: ${JSON.stringify(list)}`);
  return list.map(p => p.toLowerCase());
});

// Workspaces, series and instances, by id. Renaming a workspace or a series edits .rf/tree.json, so it may happen mid-run; a run sees
// the new names from its next start.
async function api(me: Caller, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [kind, id = '', action, other = ''] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  // A run reads and writes its own instance's screen and threads, commits its folder, sets wakes and corrects closed instances in its
  // own workspace, and finds what a folder it can read names; nothing else here.
  const run = me.run;
  if (run && !(kind === 'instances' && id === run.inst.id && ['screen', 'comment', 'commit'].includes(action)) && !(kind === 'instances' && action === 'correct') && !(kind === 'wakes' && ['PUT', 'DELETE'].includes(req.method!)) && kind !== 'resolve')
    throw new HttpError(404, 'not found');
  // The body before the tree: a request held open must not save a tree from before others' changes, such as an owner's removal.
  const payload = ['upload', 'attach', 'screen'].includes(action) ? {} : await json(req);
  const t = tree(), by = me.email;
  // Archived, a workspace or a series takes nothing but being restored, and an instance's deletion, as what shouldn't be kept may be
  // in one: nothing else in it changes, and none of its instances runs.
  const about = t.series[kind === 'instances' ? instance(id).seriesId : kind === 'series' ? id : ''];
  const within = t.workspaces[kind === 'workspaces' ? id : about ? about.workspace : kind === 'series' ? payload.workspace : ''];
  const shut = [within, about].find(x => x?.archived);
  if (shut && req.method !== 'GET' && !(payload.archived === false && !action && kind !== 'instances') && !(kind === 'instances' && action === 'delete')) {
    if (!run) mustSee(me, within);
    throw new HttpError(409, `${shut.name} is archived: nothing in it changes until it's restored`);
  }
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
  // A workspace's managers let another workspace they see read it, and its managers or the other's take that off. What its agents
  // read, that one's people see, whoever they are; a run reading it as it's taken off is cut (waker.ts leases()).
  if (kind === 'workspaces' && action === 'readers') {
    const w = t.workspaces[id], o = t.workspaces[other];
    if (req.method === 'PUT') {
      if (!canManage(me, mustSee(me, w))) throw new HttpError(403, "only the workspace's owners and admins let another workspace's agents read it");
      mustSee(me, o);
      if (other === id) throw new HttpError(400, "a workspace's agents read it already");
      w.readers = [...new Set([...(w.readers ?? []), other])];
    } else if (req.method === 'DELETE') {
      if (!w || !o || !(canManage(me, w) || canManage(me, o))) throw new HttpError(404, 'no such workspaces you manage');
      w.readers = (w.readers ?? []).filter(x => x !== other);
    } else throw new HttpError(405, 'PUT or DELETE');
    saveTree(t);
    return send(res, 200, 'ok');
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
    // Archived, it does no work: a run going in it ends first, and what waited for one as it was archived runs once it's restored.
    const its = Object.keys(t.series).filter(sid => t.series[sid].workspace === id), going = change.archived && its.map(sid => active.get(sid)).find(a => a);
    if (going) throw new HttpError(409, `${named(t, going.inst.seriesId)}/${going.inst.label} is running: archive ${w.name} once its run ends, or interrupt it first`);
    if (change.archived !== undefined) w.archived = !!change.archived;
    if (change.archived) cancelWakes(its.flatMap(sid => [sid, ...labels(sid).map(l => l.id)]));
    if (change.agents !== undefined) writeFileSync(agentsFile(id), String(change.agents));
    saveTree(t);
    if (change.archived === false) for (const i of its.flatMap(instances)) kick(i);
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
      a.proposal = { kind: payload.kind, to: payload.to, ...(payload.kind === 'move' ? { series: payload.series } : { had: Object.keys(t.series).filter(sid => t.series[sid].workspace === id) }), by, at: new Date().toISOString() };
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
    const joining = p.kind === 'merge' ? everyone(a).filter(x => !everyone(b).includes(x))
      : [...new Set(instances(moving[0]).filter(i => i.doc.status === 'open').map(i => runnerOf(i).by))].filter(x => { const q = asPerson(x); return !q || !canSee(q, b); });
    // What the one accepting sees first: for a merge, the series made since it was proposed marked so, and the AGENTS.md it adds.
    if (req.method === 'GET') return send(res, 200, {
      ...p, series: move(structuredClone(t)).map(s => ({ ...s, ...(a.proposal!.had && !a.proposal!.had.includes(s.id) && { since: true }) })), people: joining,
      ...(p.kind === 'merge' && { agents: text(agentsFile(id)) }),
    });
    if (req.method !== 'POST') throw new HttpError(405, 'GET it, POST {"owners", "members"} to accept it, or DELETE to withdraw or decline it');
    if (a.archived || b.archived) throw new HttpError(409, `${a.archived ? a.name : b.name} is archived`);
    // The runs going in what moves, and any whose reach it narrows, are cut, and carry on there (waker.ts leases()).
    const [owners, members] = people(payload), moved = move(t);
    b.owners = [...new Set([...b.owners, ...owners])];
    b.members = [...new Set([...b.members, ...members, ...(p.kind === 'merge' ? everyone(a) : [])])].filter(x => !b.owners.includes(x));
    for (const sid of moving) replaceReadOnly(join(seriesDir(sid), 'series.json'), '{}');
    if (p.kind === 'merge') {
      const add = text(agentsFile(id)), keep = text(agentsFile(p.into)).trimEnd();
      if (add) writeFileSync(agentsFile(p.into), `${keep && `${keep}\n\n`}## ${a.name}\n\n${add}`);
      rmSync(agentsFile(id), { force: true });
      delete t.workspaces[id];
      forgetWorkspace(id);
      for (const o of Object.values(t.workspaces)) {
        o.readers &&= o.readers.filter(x => x !== id);
        if (o.proposal?.to === id) delete o.proposal;
      }
    } else {
      delete a.proposal;
      a.moved = [...(a.moved ?? []).filter(m => fresh(m.at)), { name: p.series!, to: moved[0].to, at: new Date().toISOString() }];
    }
    saveTree(t);
    for (const m of moved) for (const i of instances(m.id)) i.append(by, 'move', { from: m.from, to: m.to });
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
      if (instances(id)[0].hole) throw new HttpError(409, `${s.name} was deleted`);
      const name = safeName(String(payload.name ?? ''));
      if (name !== s.name && Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
      delete s.single;
      saveTree(t);
      instances(id)[0].append(by, 'promote', { series: name });
      return send(res, 200, 'ok');
    }
    if (s.single) throw new HttpError(400, `${s.name} is a task, with one instance and no settings: Start another based on this makes it a series`);
    if (req.method === 'POST') return send(res, 200, { id: startWith(id, String(payload.label ?? ''), by, checkTicks(by, payload.logins ?? []), payload.quiet ? undefined : { from: by }).id });
    if (req.method !== 'PUT') throw new HttpError(405, 'PUT, or POST a new instance');
    const change = payload;
    if (change.name !== undefined && change.name !== s.name) {
      const name = safeName(String(change.name));
      if (Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
    }
    if (change.archived && active.has(id)) throw new HttpError(409, `${named(t, id)}/${active.get(id)!.inst.label} is running: archive ${s.name} once its run ends, or interrupt it first`);
    if (change.archived !== undefined) s.archived = !!change.archived;
    if (change.archived) cancelWakes([id, ...labels(id).map(l => l.id)]);
    // Anyone may share it as themselves in place of whoever does; only they, or whoever manages the workspace, stop sharing it.
    const was = seriesSettings(seriesDir(id)).shared;
    if (change.share !== undefined && !change.share && was && was.by !== by && !canManage(me, t.workspaces[s.workspace]))
      throw new HttpError(403, `${was.by} shares it: they, or the workspace's owners, stop sharing it`);
    const shared = change.share === undefined ? was : change.share ? { by, since: new Date().toISOString(), logins: checkTicks(by, change.logins ?? []) } : undefined;
    saveTree(t);
    replaceReadOnly(join(seriesDir(id), 'series.json'), JSON.stringify({ ...(shared && { shared }) }, null, 1));
    if (change.archived === false) for (const i of instances(id)) kick(i);
    return send(res, 200, 'ok');
  }
  if (kind === 'wakes') {
    // People and runs set wakes, one-off or weekly, and cancel them: PUT names the target, an open instance, which the wake continues,
    // or a series, which it starts LABEL of; DELETE names the wake. A run wakes only in its own workspace: it reads others that let it,
    // never acts there.
    const wake = req.method === 'DELETE' ? wakes().pending[id] : undefined, to = wake?.target ?? id, sid = t.series[to] ? to : instance(to).seriesId;
    if (req.method === 'DELETE' && !wake) throw new HttpError(404, 'no such wake pending');
    if (t.series[to]?.single) throw new HttpError(400, `${t.series[to].name} is a task, with one instance: wake that`);
    if (!run) mustSee(me, t.workspaces[t.series[sid].workspace]);
    else if (t.series[sid].workspace !== t.series[run.inst.seriesId].workspace) throw new HttpError(403, `${named(t, sid)} is in another workspace: you can read it, not wake it`);
    if (req.method === 'DELETE') return void (cancelWake(id), send(res, 200, 'ok'));
    const { at: when = '', label, days } = payload, w = String(when);
    const at = w === 'now' ? Date.now() : /^\+\d+[mhd]$/.test(w) ? Date.now() + Number(w.slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[w.at(-1) as 'm'] : Date.parse(w);
    if (req.method !== 'PUT' || Number.isNaN(at)) throw new HttpError(400, 'PUT {"at", "label" for a series, "days"}, or DELETE; at is now, +<n>m|h|d, or a date and time such as 2026-09-14T07:00+08:00');
    if (archived(t, sid)) throw new HttpError(409, `${named(t, sid)} is archived`);
    if (t.series[to] && !label) throw new HttpError(400, `waking a series starts a new instance: name it with a label${run ? '; to wake your own instance, name its folder: .' : ''}`);
    if (!t.series[to] && instance(to).doc.status !== 'open') throw new HttpError(409, `${instance(to).label} is ${instance(to).doc.status}: to correct it, wake its series with the label ${instance(to).label}-r2`);
    const first = new Date(at), starts = t.series[to] ? safeName(String(label)) : undefined;
    if (starts && labels(to).some(l => l.label === starts && instance(l.id).hole)) throw new HttpError(409, `${starts} was deleted, and its label stays with it: choose another`);
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
      const inst = startWith(r.series, r.label, by, checkTicks(by, payload.logins ?? []), payload.quiet ? undefined : { from: r.from });
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
  if (!action) return send(res, 200, { doc: inst.doc, log: inst.log.map(e => isNote(inst, e) ? { ...e, note: true } : e), run: mine ? { n: mine.n, cost: +mine.cost.toFixed(4), browsers: [...(mine.browsers?.watchable().keys() ?? [])], yours: mine.browsers?.yours(by) ?? [] } : null, queued: !!queued(inst), runner: runner(inst), previous: previous(inst), sums: Object.fromEntries(inst.doc.items.filter(i => i.file).map(i => [i.id, sha256(inst.dir, i.file!)])), waiting: waits(inst).map(({ who, e }) => ({ who, seq: e.seq })) });
  if (action === 'trace') return send(res, 200, trace(inst));
  if (action === 'summary') return send(res, 200, summary(inst, me));
  // The screen: anyone who sees the instance reads it; only its own run writes it.
  if (action === 'screen' && req.method === 'GET') return send(res, 200, inst.doc);
  if (action === 'screen' && req.method === 'PUT' && run) return send(res, 200, `saved, rev ${inst.put((await body(req)).toString(), run.n)}`);
  if (action === 'screen') throw new HttpError(405, "GET, or PUT by the instance's own run");
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (inst.doc.status === 'deleted') throw new HttpError(409, `${inst.label} was deleted: nothing is left of it but its place in its series`);
  if (action === 'delete') {
    // Whoever manages its workspace deletes an instance, in any status, people only: what's going for it is cut, and all the server
    // holds of it goes, but its id, label and place in its series, and who deleted it and when, with what its runs cost, for the
    // totals (waker.ts remove()); the system's log records it.
    if (!canManage(me, t.workspaces[t.series[inst.seriesId].workspace])) throw new HttpError(403, "only the workspace's owners and admins delete an instance");
    await remove(inst, by, () => ({ cost: costOf(inst), runs: runsOf(inst).map(({ started, error, ...r }) => r) }));
    for (const p of readdirSync(previews)) if (p.startsWith(inst.id + '-')) rmSync(join(previews, p));
    for (const k of sums.keys()) if (k.startsWith(inst.dir + sep)) sums.delete(k);
    return send(res, 200, 'ok');
  }
  if (action === 'duplicate') {
    if (t.series[inst.seriesId].single) throw new HttpError(400, 'a task has one instance: Start another based on this makes it a series');
    if (inst.doc.status === 'open') throw new HttpError(409, 'only a closed or abandoned instance can be duplicated');
    if (instances(inst.seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances of ${t.series[inst.seriesId].name} are open: a new one waits until one closes`);
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
  if (action === 'correct') {
    // On an item, at a ref if given, or on the instance; a run's links its own instance, a person's the instance and thread they name.
    const { kind: k, item, ref, text, thread } = payload, see = run ? run.inst : payload.see ? instance(String(payload.see)) : undefined;
    if (inst.doc.status !== 'closed') throw new HttpError(409, `${inst.label} is ${inst.doc.status}: only a closed instance takes corrections, as nothing else changes it`);
    if (run && t.series[inst.seriesId].workspace !== t.series[run.inst.seriesId].workspace) throw new HttpError(403, `${named(t, inst.seriesId)} is in another workspace: you can read it, not correct it`);
    if (see && !run) mustSee(me, t.workspaces[t.series[see.seriesId].workspace]);
    if (see?.hole) throw new HttpError(409, `${see.label} was deleted`);
    if (!['wrong', 'superseded'].includes(k) || typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a correction is {"kind": "wrong" or "superseded", "text", "item", "ref", "see", "thread"}');
    if (item != null && !inst.doc.items.some(i => i.id === item)) throw new HttpError(400, `no item ${item}; ${inst.label}'s items: ${inst.doc.items.map(i => i.id).join(', ')}`);
    if (thread != null && !see?.threads().includes(thread)) throw new HttpError(400, `no thread ${thread} in ${see?.label ?? 'the instance it names'}`);
    const e = correct(inst, by, { kind: k, ...(item != null && { item }), ...(ref && { ref: String(ref) }), text: text.trim(), ...(see && { see }), ...(thread != null && { thread }), ...(run && { run: run.n }) });
    return send(res, 200, `${inst.label}${item ? ` ${item}` : ''} is marked ${k}, seq ${e.seq}`);
  }
  if (action === 'react' && !run) {
    // A person's thumbs up or down on a comment, or with no on on the instance, closed or not; null takes it back. It starts nothing:
    // a signal kept for later, which the next run reads with the rest.
    const { on, up } = payload;
    if (![true, false, null].includes(up)) throw new HttpError(400, 'up is true, false or null');
    if (on !== undefined && !inst.log.some(e => e.seq === on && e.op === 'comment')) throw new HttpError(400, `no comment at seq ${on}`);
    inst.append(by, 'react', { ...(on !== undefined && { on }), up });
    return send(res, 200, 'ok');
  }
  if (inst.doc.status !== 'open') throw new HttpError(409, `instance is ${inst.doc.status}`);
  // A quiet act, by quiet in its body or, for an upload, in its query, starts nothing: its entry says so, and its next run reads it.
  const quiet = action === 'upload' ? url.searchParams.has('quiet') : !!payload.quiet;
  if (action === 'attach') {
    // A comment's attachment, kept in upload/attachments/ and named in the comment that follows; it starts nothing by itself.
    const tmp = join(tmpDir, randomUUID());
    try {
      await pipeline(req, createWriteStream(tmp));
      const now = tree(), who = asPerson(by);
      if (!who) throw new HttpError(401, 'sign in');
      mustSee(who, now.workspaces[now.series[inst.seriesId].workspace]);
      return send(res, 200, { file: inst.keep(url.searchParams.get('name') ?? 'file', tmp, 'upload/attachments') });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (action === 'upload') {
    const pane = url.searchParams.get('pane') === 'out' ? 'out' : 'in', tmp = join(tmpDir, randomUUID()), hash = createHash('sha256');
    try {
      await pipeline(req, async function* (chunks: AsyncIterable<Buffer>) { for await (const c of chunks) { hash.update(c); yield c; } }, createWriteStream(tmp));
      const now = tree(), who = asPerson(by);
      if (!who) throw new HttpError(401, 'sign in');
      mustSee(who, now.workspaces[now.series[inst.seriesId].workspace]);
      const up = inst.upload(by, url.searchParams.get('name') ?? 'file', tmp, hash.digest('hex'), pane, url.searchParams.get('onto'), quiet);
      // What starts no run, quiet or a note, is committed at once in its person's name; a run going commits it as it ends.
      if (!starts(inst, up) && active.get(inst.seriesId)?.inst !== inst) commit(inst.dir, me, `Upload ${up.file}`).catch(err => inst.append('server', 'commit', { cause: up.seq, error: err.message }));
    } finally {
      rmSync(tmp, { force: true });
    }
  } else if (action === 'comment') {
    // A comment starts a thread, on an item (at a ref, such as a cell, if given) or on the instance, or replies under one of its
    // comments, which `thread` names by its seq, as cN, a thread's own id its first comment's. A person's starts a run, unless quiet.
    // The agent's starts nothing: it says something, or asks, and then the ask waits on a reply under it, from the one it names or else
    // the runner. A person's may attach files, uploaded to upload/attachments/ first.
    const { thread, item, ref, text, files = [], ask, to } = payload, under = thread === undefined ? undefined : inst.log.find(e => e.op === 'comment' && `c${e.seq}` === thread);
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a comment has text');
    if (thread !== undefined && !under) throw new HttpError(400, `no comment ${thread} to reply under; this instance's threads: ${inst.threads().join(', ') || 'none yet'}`);
    if (thread === undefined && item != null && !inst.doc.items.some(i => i.id === item)) throw new HttpError(400, `no item ${item}; the screen's items: ${inst.doc.items.map(i => i.id).join(', ')}`);
    for (const f of files) if (!(typeof f === 'string' && f.startsWith('upload/attachments/') && !f.includes('..') && existsSync(join(inst.dir, f)))) throw new HttpError(400, `no attachment ${f}`);
    const who = typeof to === 'string' ? to.toLowerCase() : undefined, p = who && asPerson(who);
    if (who && !(p && canSee(p, t.workspaces[t.series[inst.seriesId].workspace])))
      throw new HttpError(400, `${to} can't see this instance; ask its runner, ${runnerOf(inst).by}, or someone in its workspace`);
    const said = inst.append(by, 'comment', {
      ...(under ? { thread: under.thread, parent: under.seq } : { thread: `c${inst.log.length + 1}`, item: item ?? null, ref: ref ?? null }), text: text.trim(), ...(files.length && { files }),
      ...(run && { run: run.n, ...(ask && { ask: true, ...(who && { to: who }) }) }), ...(quiet && { quiet: true }),
    });
    if (run) return send(res, 200, `${ask ? 'asked' : 'said'} c${said.seq}${under ? `, under ${thread}` : ''}`);
    res.setHeader('X-RF-Comment-Seq', said.seq);
    // Until a task is renamed, its first prompt's opening words name it.
    const s = t.series[inst.seriesId], words = text.trim().split(/\s+/).slice(0, 6).join(' ').replace(/^\.+/, '').slice(0, 60);
    if (s.single && words && !inst.log.some(e => e.op === 'rename' || (e.op === 'comment' && e !== said && isPerson(e)))) {
      const from = inst.label;
      s.name = freeName(t, s.workspace, safeName(words));
      saveTree(t);
      renameInstance(inst, s.name);
      inst.append('server', 'rename', { from, cause: said.seq });
    }
    if (!starts(inst, said) && active.get(inst.seriesId)?.inst !== inst) commit(inst.dir, me, `Comment in ${said.thread}`).catch(err => inst.append('server', 'commit', { cause: said.seq, error: err.message }));
  } else if (action === 'signoff') {
    // Anyone who sees the instance signs off an ask of the agent's, which `thread` names as cN, with a note: it commits the folder in
    // their name, as they say yes to it, the ask and the note its message, with their Signed-off-by, and starts a run, as a reply
    // does, unless quiet. To say no is to reply, as rf 0.12's reject, still in use, is told.
    const { thread, text, approved } = payload, ask = inst.log.find(e => `c${e.seq}` === thread && e.op === 'comment' && e.by === 'agent' && e.ask);
    if (approved === false) throw new HttpError(400, 'a sign-off approves; to say no, reply in the thread');
    if (!ask) throw new HttpError(409, `${thread} is no ask of the agent's`);
    if (mine) throw new HttpError(409, 'wait for the run to end');
    const note = typeof text === 'string' ? text.trim() : '';
    const hash = await commit(inst.dir, me, [ask.text, note, `Signed-off-by: ${me.name} <${me.email}>`].filter(Boolean).join('\n\n'));
    inst.append(by, 'signoff', { thread: ask.thread, on: ask.seq, ...(note && { text: note }), commit: hash, ...(quiet && { quiet: true }) });
  } else if (action === 'commit' && run) {
    // The agent commits the folder at a moment worth keeping, in its own name.
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) throw new HttpError(400, 'a commit has a message');
    const hash = await commit(inst.dir, AGENT, message);
    inst.append('agent', 'commit', { run: run.n, message, commit: hash });
    return send(res, 200, `committed ${hash}`);
  } else if (action === 'interrupt') {
    // Whoever sees the instance watches its run; its runner, the workspace's owners and admins alone stop it.
    if (!run && runnerOf(inst).by !== by && !canManage(me, t.workspaces[t.series[inst.seriesId].workspace]))
      throw new HttpError(403, `only its runner, ${runnerOf(inst).by}, the workspace's owners and admins stop its run`);
    if (!mine?.run) throw new HttpError(409, 'no run going');
    inst.append(by, 'interrupt');
    await mine.run.interrupt();
    return send(res, 200, 'ok');
  } else if (action === 'logins') {
    // The runner ticks the instance's logins anew, as before its first prompt.
    if (runnerOf(inst).by !== by) throw new HttpError(403, `${runnerOf(inst).by} runs it, and ticks its logins`);
    inst.append(by, 'logins', { logins: checkTicks(by, payload.logins ?? []) });
    await closeUnlent();
    return send(res, 200, 'ok');
  } else if (action === 'takeover') {
    // Taking over makes you the runner from now on, with your own logins ticked; whoever closes answers for the whole instance.
    if (mine) throw new HttpError(409, 'wait for the run to end');
    inst.append(by, 'takeover', { from: runnerOf(inst).by, logins: checkTicks(by, payload.logins ?? []) });
    return send(res, 200, 'ok');
  } else if (action === 'close' || action === 'abandon') {
    if (mine) throw new HttpError(409, 'wait for the run to end');
    if (runnerOf(inst).by !== by) throw new HttpError(403, `only the runner, ${runnerOf(inst).by}, ${action === 'close' ? 'closes it, making it the record' : 'abandons it'}; take it over first`);
    await (action === 'close' ? inst.close(me) : inst.abandon(by));
    cancelWakes([inst.id]);
    if (action === 'close') closed(inst, by, quiet);
    return send(res, 200, 'ok');
  } else throw new HttpError(404, `no action ${action}`);
  if (!quiet) kick(inst);
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
    forgetGrants(email);
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
  if (!name && req.method === 'GET') return send(res, 200, connections().map(({ key: _key, ...c }) => ({ ...c, login: loginOf(c) })));
  if (me.role !== 'admin') throw new HttpError(403, 'admins keep connections');
  const body = req.method === 'PUT' ? await json(req) : {};
  if (req.method === 'PUT') return send(res, 200, await setConnection(name, body, me.email));
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
  // The run its token is as each request comes, which a later turn of the same Pi makes another run, over a connection kept open
  // across them; none while the Pi is idle.
  run: token => byToken.has(token) ? {
    egress(host, allowed) {
      const a = byToken.get(token);
      if (!a || a.hosts.has(host)) return;
      a.hosts.add(host);
      a.inst.append('server', 'egress', { run: a.n, host, allowed });
    },
    browsers: () => { const a = byToken.get(token)!; return (a.browsers ??= new Browsers(a.inst, a.n)); },
    intercepts: host => intercepts(byToken.get(token)!, host),
    call: async (host, req, res) => {
      const a = byToken.get(token);
      return a ? call(a, host, req, res) : void res.writeHead(409).end('its run has ended');
    },
  } : undefined,
});

const server = createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://x');
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site && site !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    // What the sign-in pages show, before anyone signs in: the stylesheets, the theme's logo and the brand's.
    const css = req.method === 'GET' ? stylesheet(url.pathname) : undefined;
    if (css !== undefined) {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return void res.end(css);
    }
    if (req.method === 'GET' && url.pathname === '/css/logo' && themeLogo) {
      res.writeHead(200, { 'content-type': themeLogo.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return void res.end(readFileSync(themeLogo.file));
    }
    if (req.method === 'GET' && url.pathname === '/brand/logo') {
      const { logo, type } = brand();
      if (!logo) throw new HttpError(404, 'no logo');
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return void res.end(Buffer.from(logo, 'base64'));
    }
    const me = await authenticate(req, res, url);
    if (!me) return;
    // What a person changes beyond an instance is an act of theirs in the system's log, once it's done.
    if (!['GET', 'HEAD'].includes(req.method!) && !url.pathname.startsWith('/api/instances/'))
      res.on('finish', () => res.statusCode < 400 && act(me.email, { method: req.method, path: url.pathname + url.search, body: bodies.get(req) }));
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/me') {
      const { text, logo } = brand();
      send(res, 200, { ...me, names: names(me), browsers: !!process.env.RF_BROWSER_URL, brand: { text: text || null, logo: !!logo }, themeLogo: !!themeLogo, can: CAPS.filter(c => can(me, c)), version });
    } else if (url.pathname === '/capabilities') {
      if (me.role !== 'admin') throw new HttpError(403, 'admins grant capabilities');
      if (req.method === 'PUT') {
        const { cap, people } = await json(req);
        if (!CAPS.includes(cap)) throw new HttpError(400, `a capability is one of ${CAPS.filter(c => c !== 'vpn' || can(me, c)).join(', ')}`);
        if (!isPeople(people)) throw new HttpError(400, `${cap}: a list of emails and Entra group ids: ${JSON.stringify(people)}`);
        writeJson('capabilities.json', { ...capabilities(), [cap]: people.map(p => p.toLowerCase()) });
        if (cap === 'vpn') await closeUnlent();
      }
      send(res, 200, Object.fromEntries(CAPS.filter(c => c !== 'vpn' || can(me, c)).map(c => [c, capabilities()[c] ?? []])));
    } else if (url.pathname === '/egress') {
      // The hosts runs may reach beyond the sandbox's own list (sandbox.ts), which admins keep.
      if (req.method === 'PUT') {
        if (me.role !== 'admin') throw new HttpError(403, 'admins keep the hosts runs may reach');
        const { hosts } = await json(req);
        if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h))) throw new HttpError(400, `hosts: names such as pypi.org or *.example.com, not ${JSON.stringify(hosts)}`);
        writeJson('egress.json', hosts.map(h => h.toLowerCase()));
      }
      send(res, 200, readJson<string[]>('egress.json', []));
    } else if (url.pathname === '/internal' || /^\/internal\/[^/]+$/.test(url.pathname)) {
      // The hosts at internal addresses admins let every website reach (connections.ts), with who let each and when: admins see them,
      // and take one out, after which everyone's websites at it wait for an admin again.
      if (me.role !== 'admin') throw new HttpError(403, 'admins see the internal hosts they let websites reach');
      if (req.method === 'DELETE') {
        const host = decodeURIComponent(url.pathname.split('/')[2]).toLowerCase();
        if (!letIn()[host]) throw new HttpError(404, `${host} isn't one admins let websites reach: they are ${Object.keys(letIn()).join(', ') || 'none'}`);
        setLetIn([host], me.email, false);
        act(me.email, { op: 'internal', hosts: [host], let: false });
      } else if (req.method !== 'GET') throw new HttpError(405, 'GET lists them, DELETE /internal/HOST takes one out');
      send(res, 200, letIn());
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
    else if (/^\/logins\/[^/]+\/connect$/.test(url.pathname) && req.method === 'POST') {
      const c = byLogin(decodeURIComponent(url.pathname.split('/')[2]));
      if (c?.type !== 'service') throw new HttpError(404, 'no service connection with that login');
      const login = loginOf(c);
      saveLogin(me.email, { ...login, offers: login.offers!, since: new Date().toISOString() });
      send(res, 200, 'ok');
    }
    else if (/^\/logins\/[^/]+\/connect$/.test(url.pathname)) {
      // A link on another site must not start it: Microsoft may sign in again without asking.
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'connect from the Logins page');
      const c = byLogin(decodeURIComponent(url.pathname.split('/')[2])), login = c && loginOf(c);
      if (!login?.scope) throw new HttpError(404, 'no connection signs in to Microsoft with that login');
      await connect(res, me.email, login);
    }
    else if (url.pathname === '/vpns' || url.pathname.startsWith('/vpns/')) {
      if (!can(me, 'vpn')) throw new HttpError(404, 'not found');
      if (url.pathname === '/vpns' && req.method === 'GET') send(res, 200, await vpns(me));
      else if (url.pathname === '/vpns' && req.method === 'POST') {
        const { name, type, gateway, servercert } = await json(req);
        addVpn(me, String(name ?? ''), { type, gateway, servercert });
        send(res, 200, 'saved');
      } else {
        const match = /^\/vpns\/([^/]+)(?:\/(signins|connection))?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, 'not found');
        const name = decodeURIComponent(match[1]);
        if (!match[2] && req.method === 'DELETE') {
          try { await removeVpn(me, name); } finally { await closeUnlent(); }
          send(res, 200, 'ok');
        } else if (match[2] === 'connection' && req.method === 'DELETE') {
          try { await disconnectVpn(me, name); } finally { await closeUnlent(); }
          send(res, 200, 'ok');
        }
        else if (match[2] === 'signins' && req.method === 'POST') {
          const since = Date.now(), id = await startVpnSignIn(me, name);
          send(res, 200, { id, expires: new Date(since + Number(process.env.RF_SIGNIN_S ?? 600) * 1000).toISOString() });
        } else throw new HttpError(404, 'not found');
      }
    }
    // Websites are personal; admins alone allow hosts the server leaves for them.
    else if (url.pathname === '/logins/sites' && req.method === 'GET') {
      const person = url.searchParams.get('person') ?? me.email;
      if (person !== me.email && me.role !== 'admin') throw new HttpError(403, `${person}'s websites are theirs`);
      send(res, 200, websitesOf(person));
    }
    else if (url.pathname === '/logins/sites' && req.method === 'POST') {
      const { name, url: start, header } = await json(req);
      send(res, 200, await addSite(me.email, String(name ?? ''), String(start ?? ''), String(header ?? '').trim()));
    }
    else if (/^\/logins\/sites\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
      const change = await json(req);
      await setSite(me, decodeURIComponent(url.pathname.split('/')[3]), change, url.searchParams.get('person') ?? me.email);
      if (change.via !== undefined) await closeUnlent();
      send(res, 200, 'ok');
    }
    else if (/^\/logins\/sites\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') send(res, 200, (removeSite(me.email, decodeURIComponent(url.pathname.split('/')[3])), await closeUnlent(), 'ok'));
    // Grants: a person asks to use their login to a website in a workspace, whose owners approve or deny it, and revoke it, as its
    // person may withdraw it; revoked, that person's run browsers there in the workspace close at once.
    else if (url.pathname === '/grants' && req.method === 'GET') send(res, 200, visible(me));
    else if (url.pathname === '/grants' && req.method === 'POST') {
      const { site, workspace, reason } = await json(req);
      send(res, 200, await ask(me, String(site ?? ''), String(workspace ?? ''), String(reason ?? '')));
    }
    else if (/^\/grants\/\w+$/.test(url.pathname) && req.method === 'POST') {
      const { approve, text } = await json(req);
      send(res, 200, (decide(me, url.pathname.slice(8), approve === true, String(text ?? '')), 'ok'));
    }
    else if (/^\/grants\/\w+$/.test(url.pathname) && req.method === 'DELETE') {
      revoke(me, url.pathname.slice(8));
      await closeUnlent();
      send(res, 200, 'ok');
    }
    else if (/^\/logins\/web\/[^/]+\/hosts$/.test(url.pathname) && req.method === 'POST') send(res, 200, (await allowHost(me, decodeURIComponent(url.pathname.split('/')[3]), String((await json(req)).host ?? ''), url.searchParams.get('person') ?? me.email), 'ok'));
    else if (/^\/logins\/web\/[^/]+\/hosts\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') send(res, 200, (await removeHost(me.email, decodeURIComponent(url.pathname.split('/')[3]), decodeURIComponent(url.pathname.split('/')[5])), 'ok'));
    else if (/^\/logins\/web\/[^/]+$/.test(url.pathname) && req.method === 'POST') {
      const header = String((await json(req)).header ?? ''), since = Date.now();
      const id = await startSignIn(me.email, decodeURIComponent(url.pathname.slice(12)), header);
      send(res, 200, { id, expires: new Date(since + Number(process.env.RF_SIGNIN_S ?? 600) * 1000).toISOString() });
    }
    // What a person's login offers that they add themselves: Microsoft 365's sources and Databricks' warehouses.
    else if (/^\/logins\/[^/]+\/offers$/.test(url.pathname) && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/')[2]), add = String((await json(req)).add ?? '');
      await (id === 'm365' ? offer(me.email, add) : addWarehouse(me.email, id, add));
      send(res, 200, (track(me.email), 'ok'));
    }
    else if (/^\/logins\/[^/]+\/offers\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
      const [, , id, , o] = url.pathname.split('/').map(decodeURIComponent);
      send(res, 200, (unoffer(me.email, id, o), forget(me.email, o), 'ok'));
    }
    else if (/^\/signins\/\w+\/view$/.test(url.pathname) && req.method === 'GET') {
      const id = url.pathname.split('/')[2];
      if (!isSignIn(me.email, id) && !(can(me, 'vpn') && isVpnSignIn(me.email, id))) throw new HttpError(404, 'no such sign-in');
      const html = await viewPage(id);
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    else if (/^\/runs\/\w+\/[a-z0-9-]+\/view$/.test(url.pathname) && req.method === 'GET') {
      const [, , id, site] = url.pathname.split('/'), html = await viewPage(watched(me, id, site).id);
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    // Saved, a login may be kept alive, by those granted keepalive; or thrown away.
    else if (/^\/signins\/\w+$/.test(url.pathname) && req.method === 'POST') {
      const id = url.pathname.slice(9);
      if (can(me, 'vpn') && isVpnSignIn(me.email, id)) {
        try { await saveVpnSignIn(me, id); } finally { await closeUnlent(); }
        send(res, 200, 'ok');
      } else {
        const { keepalive } = await json(req);
        if (keepalive !== undefined && !can(me, 'keepalive')) throw new HttpError(403, 'keeping a login alive is for admins and those they grant keepalive: ask an admin');
        send(res, 200, (await endSignIn(me.email, id, true, keepalive), 'ok'));
      }
    }
    else if (/^\/signins\/\w+$/.test(url.pathname) && req.method === 'DELETE') {
      const id = url.pathname.slice(9);
      if (can(me, 'vpn') && isVpnSignIn(me.email, id)) {
        await cancelVpnSignIn(me, id);
        await closeUnlent();
      } else await endSignIn(me.email, id, false);
      send(res, 200, 'ok');
    }
    // Your own OpenRouter key, checked with OpenRouter as you save it, and whether your runs use it: a new one, or not using it, ends
    // its running out of credits.
    else if (url.pathname === '/logins/openrouter' && req.method === 'PUT') {
      const { key, enabled } = await json(req), was = logins(me.email).find(l => l.id === 'openrouter'), k = String(key ?? '').trim();
      if (!k && !was) throw new HttpError(400, 'your OpenRouter key: paste it to save it');
      if (k && !(await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/key`, { headers: { authorization: `Bearer ${k}` } })).ok) throw new HttpError(400, 'OpenRouter refused this key');
      saveLogin(me.email, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since: k ? new Date().toISOString() : was!.since, offers: [], enabled: !!enabled, ...(!k && enabled && was!.expired && { expired: true }) }, k || undefined);
      send(res, 200, 'saved');
    }
    else if (url.pathname.startsWith('/logins/') && req.method === 'DELETE') send(res, 200, (signOut(me.email, decodeURIComponent(url.pathname.slice(8))), url.pathname === '/logins/m365' && forget(me.email), await closeUnlent(), 'ok'));
    else if (url.pathname === '/users' || url.pathname.startsWith('/users/')) await admin(me, req, res, url);
    else if (url.pathname === '/skills' || url.pathname.startsWith('/skills/')) await skillsRoute(me, req, res, url);
    else if (url.pathname === '/connections' || url.pathname.startsWith('/connections/')) await connectionsRoute(me, req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    if (res.headersSent) res.destroy();
    else send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
});
// A live view's websockets pass through to the browser service: a sign-in's, its own person's, to watch or drive, and a run's
// browser's, to watch (watched), or to drive for the person whose login it's in. Only from the server's own pages: the session
// cookie, SameSite=Lax, goes with a sibling subdomain's requests too.
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const me = req.headers.origin === new URL(process.env.RF_PUBLIC_URL!).origin ? session(req) : null, path = URL.parse(req.url!, 'http://x')?.pathname ?? '';
  const signIn = /^\/signins\/(\w+)\/(view\/(?:watch|drive))$/.exec(path), run = /^\/runs\/(\w+)\/([a-z0-9-]+)\/view\/(watch|drive)$/.exec(path);
  let to;
  if (me && signIn && (isSignIn(me.email, signIn[1]) || can(me, 'vpn') && isVpnSignIn(me.email, signIn[1]))) to = `/sessions/${signIn[1]}/${signIn[2]}`;
  if (me && run) try {
    const w = watched(me, run[1], run[2]);
    to = `/sessions/${run[3] === 'drive' ? w.browsers.drive(run[2], me.email, socket) : w.id}/view/${run[3]}`;
  } catch {}
  if (!to) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  passUpgrade(req, socket, head, to);
});
await enrolFlagged();
if (process.env.RF_BROWSER_URL) await reap().catch(e => console.error('the browser service: browsers a restart left open are still open', e));
await reapVpns().catch(e => console.error('the tunnel service: tunnels a restart left may still be open, and VPNs fail until it answers', e));
// A stop, as an update's, cuts the runs (waker.ts stop()) and exits once what they had sent is answered and logged, within 10 s.
process.on('SIGTERM', async () => {
  stop();
  await answered(10_000);
  process.exit();
});
server.listen(port, host, () => {
  startIndexing();
  startWaking();
  if (process.env.RF_BROWSER_URL) setInterval(() => {
    lapse();
    keepAlive().catch(e => console.error('keeping logins alive:', e));
  }, 60_000).unref();
  checkLogins(connections().map(loginOf).flatMap(l => l.scope ? [l] : []));
  console.log(`rollforward on http://${host}:${port}, data in ${root}${process.env.RF_TODAY ? `, skills take today as ${process.env.RF_TODAY} (RF_TODAY)` : ''}`);
});
