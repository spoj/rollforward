import { existsSync, readdirSync } from 'node:fs';
import { freemem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { agentsFile, createInstance, HttpError, instance, instanceDir, instances, isPerson, labels, newId, readFile, seriesDir, type Entry, type Instance } from './store.ts';
import { startRun, type Run, type View } from './runner.ts';
import { canSee, changes, everyone, readJson, tree, type Tree, writeJson } from './system.ts';
import { users } from './auth.ts';
import type { Browsers } from './browsers.ts';
import { seriesSettings } from './series.ts';
import { pushed, skills } from './skills.ts';
import { runnerOf } from './logins.ts';
import { reachable, types } from './connections.ts';

// What runs when: one run at a time per series, at most RF_MAX_RUNS at once, started by people's acts and by wakes.
const LIMIT_MS = Number(process.env.RF_LIMIT_MIN ?? 120) * 60_000;
const MAX_RUNS = Number(process.env.RF_MAX_RUNS ?? 20);
// Memory binds first: no run starts while less than RF_MIN_FREE_GB is free; waiting ones start as runs end, or at the next tick. Each
// run started in the last minute asks 1 GB more, about what one takes as it loads, which free memory doesn't show yet. 0 checks no
// memory, as for tests on a small machine.
const MIN_FREE = Number(process.env.RF_MIN_FREE_GB ?? 6) * 2 ** 30;
const started: number[] = [];
const full = () => !!draining || active.size >= MAX_RUNS || (MIN_FREE > 0 && freemem() < MIN_FREE + started.filter(t => t > Date.now() - 60_000).length * 2 ** 30);
export const MAX_OPEN = 3;
// An update drains the server: no run starts, and once none is going it calls this, to exit; what waits starts after the restart.
let draining: (() => void) | undefined;
export function drain(exit: () => void) {
  draining = exit;
  if (!active.size) exit();
}
const SPACING_MS = 15 * 60_000;

export type Active = { inst: Instance; n: number; token: string; view: View; run?: Run; sent: number; seen: number; texts: Map<string, number>; interrupted: boolean; done: boolean; cost: number; said: string; failed?: string; hosts: Set<string>; links: Map<string, string>; browsers?: Browsers; timer?: NodeJS.Timeout };
export const active = new Map<string, Active>();
export const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();
const waiting = new Set<Instance>();

function seenBefore(inst: Instance): number {
  return (inst.log.findLast(e => e.op === 'done')?.seen as number | undefined) ?? 0;
}

// Who starts an instance's runs: its runner, and anyone, people or agents, where the runner shares the series, and its own run's wakes
// (fire).
export const starter = (inst: Instance, who: string) => {
  const runner = runnerOf(inst).by;
  return who === runner || seriesSettings(inst.series()).shared?.by === runner;
};
// What a person but the runner adds is a note, shared series or not: the agent reads it as context for its runner to take up, never as
// the runner's word, though it runs on it where it may. A wake that starts nothing is one too. A reply from whom the agent's ask named
// is no note.
export const isNote = (inst: Instance, e: Entry) => !!e.note || (isPerson(e) && ['upload', 'comment'].includes(e.op) && e.by !== runnerOf(inst).by
  && !(e.op === 'comment' && inst.log.findLast(x => x.seq < e.seq && x.op === 'comment' && x.thread === e.thread && x.by === 'agent')?.to === e.by));
export const starts = (inst: Instance, e: Entry) => !isNote(inst, e) || starter(inst, e.by);

export function pending(inst: Instance, seen: number): Entry[] {
  return inst.log.filter(e => e.seq > seen && starts(inst, e) && (e.op === 'wake' || (isPerson(e) && (['upload', 'comment', 'signoff'].includes(e.op) || (e.op === 'create' && e.fetch)))));
}

// Whether an instance has something for a run: what came since its last run, or since an Interrupt, which waits for the next act.
const due = (inst: Instance) => inst.doc.status === 'open' && pending(inst, Math.max(seenBefore(inst), inst.log.findLast(e => e.op === 'interrupt')?.seq ?? 0)).length > 0;

// A message names the runner, on whose behalf the agent acts, and the connections they lend it, where its entries set those: the
// first, a takeover and a runner's new ticks.
export function message(inst: Instance, n: number, entries: Entry[]): string {
  const made = entries.findLast(e => ['create', 'duplicate', 'takeover', 'logins'].includes(e.op)), us = users(), who = (by: string) => `${us[by]?.name || by} <${by}>`;
  return `Instance ${inst.label} (folder ${inst.label}/), run ${n}.`
    + (made ? ` Its runner is ${made.op === 'takeover' ? `now ${who(made.by)}, taking over from ${who(made.from as string)}` : who(made.by)}, who lends you ${reachable(inst).map(c => `${c.name} (${c.type})`).join(', ') || 'no connection'}.` : '')
    + ' New log entries:\n'
    + entries.map(e => JSON.stringify(isNote(inst, e) ? { ...e, note: true } : e)).join('\n');
}

// What a series' agent may read: the other series of its workspace, and those of any workspace that has everyone this one has, by
// the same email or group, so nothing it reads reaches someone who couldn't see it already. A workspace with no one in it reads only
// itself.
export function wider(t: Tree, ws: string): string[] {
  const people = everyone(t.workspaces[ws]);
  return Object.keys(t.workspaces).filter(o => o !== ws && people.length > 0 && people.every(p => everyone(t.workspaces[o]).includes(p)));
}

export function reach(t: Tree, seriesId: string): string[] {
  const ws = t.series[seriesId].workspace, read = [ws, ...wider(t, ws)];
  return Object.keys(t.series).filter(id => id !== seriesId && read.includes(t.series[id].workspace)).sort((a, b) => named(t, a).localeCompare(named(t, b)));
}

export const named = (t: Tree, seriesId: string) => `${t.workspaces[t.series[seriesId].workspace].name}/${t.series[seriesId].name}`;

// The run's view of the data, by name, built when it starts: /work/<workspace>/<series>/<label>/ for every instance in its reach,
// the company's AGENTS.md at /work/AGENTS.md and each workspace's at /work/<workspace>/AGENTS.md, and the environment its
// runner's connections set.
export function view(inst: Instance): View {
  const t = tree(), at = (id: string) => `/work/${named(t, id)}`, series = [inst.seriesId, ...reach(t, inst.seriesId)];
  const ro = series.flatMap(id => labels(id).map(l => [instanceDir(l.id), `${at(id)}/${l.label}`] as [string, string]));
  const agents = [...new Set(series.map(id => t.series[id].workspace))].map(w => [agentsFile(w), `/work/${t.workspaces[w].name}/AGENTS.md`] as [string, string]);
  return {
    cwd: at(inst.seriesId), instance: `${at(inst.seriesId)}/${inst.label}`, dir: inst.dir, pylib: join(inst.series(), '.pylib'), ro: [[agentsFile(), '/work/AGENTS.md'], ...agents, ...ro],
    env: Object.assign({}, ...reachable(inst).map(c => types[c.type].env?.(c))),
  };
}

export function kick(inst: Instance) {
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
  // A kick that starts nothing ends the instance's queued state all the same: pages that showed it should hear.
  if (active.has(series) || !due(inst)) return void changes.emit('change', inst.id);
  if (full()) return void waiting.add(inst);
  started.push(Date.now());
  started.splice(0, started.length - MAX_RUNS);
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && e.by !== 'agent');
  const text = message(inst, n, entries);
  const a: Active = { inst, n, token: randomUUID(), view: view(inst), sent: entries.at(-1)!.seq, seen, texts: new Map([[text, entries.at(-1)!.seq]]), interrupted: false, done: false, cost: 0, said: '', hosts: new Set(), links: new Map() };
  active.set(series, a);
  byToken.set(a.token, a);
  const live = skills();
  inst.append('server', 'run', { run: n, upto: a.sent, skills: Object.fromEntries(live.map(s => [s.id, pushed(s).version])) });
  try {
    a.run = await startRun({
      token: a.token, id: inst.id, view: a.view,
      message: text, skills: live.map(s => s.id),
      onEvent: e => {
        if (e.type === 'message_end' || e.type === 'tool_execution_end') changes.emit('change', inst.id); // the Ops log shows the run as it goes
        if (e.type === 'tool_execution_end') a.browsers?.shoot().catch(err => console.error(`run ${n} of ${inst.id}: no screenshot`, err));
        if (e.type === 'message_end' && e.message.role === 'assistant') {
          a.cost += e.message.usage.cost.total;
          a.failed = e.message.stopReason === 'error' ? e.message.errorMessage ?? 'the model failed' : undefined; // a later success clears it
          const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
          if (text) a.said = text;
        }
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
  a.run.settled.then(aborted => finish(a, aborted, a.failed));
}

function finish(a: Active, aborted: boolean, error?: string) {
  if (a.done) return;
  a.done = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  const series = a.inst.seriesId;
  active.delete(series);
  a.run?.stop().catch(e => console.error(`run ${a.n} of ${a.inst.id} left its scratch folder`, e));
  a.browsers?.end().catch(e => a.inst.append('server', 'browsers', { run: a.n, error: e.message }));
  // The agent's last words in a run are its report to the instance's people; its first line is the run's summary.
  if (a.said && !aborted) a.inst.append('agent', 'report', { run: a.n, text: a.said });
  a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(4), summary: a.said && !aborted ? summaryOf(a.said) : null, ...(error && { error }) });
  if (a.run) { // one that never started, as with a missing API key, waits for the next act or a restart rather than retrying at once
    const next = due(a.inst) ? a.inst : instances(series).find(i => i !== a.inst && due(i));
    if (next) start(next);
  }
  startWaiting();
  if (draining && !active.size) draining();
}

function startWaiting() {
  for (const i of waiting) {
    if (full()) break;
    waiting.delete(i);
    start(i);
  }
}

// Why an instance waits to run, if it does, and since when: the first of what its run would read.
export function queued(inst: Instance): { why: string; since: string } | undefined {
  const a = active.get(inst.seriesId);
  if (a?.inst === inst || inst.doc.status !== 'open' || !(debounce.has(inst.id) || waiting.has(inst) || (a && due(inst)))) return;
  const why = debounce.has(inst.id) ? 'starting' : a ? `its series is running ${a.inst.label}` : draining ? 'the server updates once the runs going end' : active.size >= MAX_RUNS ? `${MAX_RUNS} runs are going, the most RF_MAX_RUNS allows` : 'too little memory is free (RF_MIN_FREE_GB)';
  return { why, since: pending(inst, seenBefore(inst))[0]?.at ?? new Date().toISOString() };
}

// Closing an instance wakes its series' later open instances, which may have used its draft; a note for those the closer doesn't start.
export function closed(inst: Instance, by: string) {
  for (const later of instances(inst.seriesId).filter(i => i.doc.status === 'open' && i.label.localeCompare(inst.label, 'en', { numeric: true }) > 0)) {
    later.append('server', 'wake', { reason: `${inst.label} closed: its final figures may differ from the draft you read`, from: inst.label, ...(!starter(later, by) && { note: true }) });
    kick(later);
  }
}

// Wakes (.rf/wakes.json): at most one pending per target, an instance or a series by id, fired by the clock at least 15 minutes after
// the target's last, and the requests to start an instance that a series no one shares, or with 3 open, got instead.
// A run's wake notes its instance, `inst`, as its name in `from` may change before it fires.
export type Wake = { at: string; from: string; label?: string; inst?: string };
export type Request = { series: string; label: string; from: string; at: string };
type Wakes = { pending: Record<string, Wake>; fired: Record<string, string>; requests: Record<string, Request> };
export const wakes = () => readJson<Wakes>('wakes.json', { pending: {}, fired: {}, requests: {} });
const saveWakes = (w: Wakes) => writeJson('wakes.json', w);

export function setWake(target: string, wake: Wake): Wake {
  const w = wakes(), at = Math.max(Date.parse(wake.at), Date.parse(w.fired[target] ?? '1970-01-01') + SPACING_MS);
  w.pending[target] = { ...wake, at: new Date(at).toISOString() };
  saveWakes(w);
  return w.pending[target];
}

export function cancelWake(target: string) {
  const w = wakes();
  if (!w.pending[target]) return;
  delete w.pending[target];
  saveWakes(w);
}

export function dropRequest(id: string): Request {
  const w = wakes(), r = w.requests[id];
  if (!r) throw new HttpError(404, `no request ${id}`);
  delete w.requests[id];
  saveWakes(w);
  return r;
}

// Starts an instance of a series for a wake or a request, run by `by` with the logins they ticked, the wake its first entry.
export function startWith(seriesId: string, label: string, by: string, logins: string[], wake: { from: string }): Instance {
  if (instances(seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances are open; close one first`);
  const inst = createInstance(seriesId, label, by, logins);
  inst.append('server', 'wake', wake);
  kick(inst);
  return inst;
}

function fire() {
  startWaiting();
  const w = wakes(), now = new Date().toISOString(), t = tree(), due = Object.entries(w.pending).filter(([, k]) => k.at <= now);
  if (!due.length) return;
  for (const [target, wake] of due) {
    delete w.pending[target];
    w.fired[target] = now;
    const s = t.series[t.series[target] ? target : instance(target).seriesId];
    if (s.archived || t.workspaces[s.workspace].archived) continue;
    if (!t.series[target]) {
      const inst = instance(target);
      if (inst.doc.status !== 'open') continue;
      inst.append('server', 'wake', { from: wake.from, ...(wake.inst !== inst.id && !starter(inst, wake.from) && { note: true }) });
      kick(inst);
      continue;
    }
    const shared = seriesSettings(seriesDir(target)).shared, u = shared && users()[shared.by];
    const runs = u && !u.disabled && canSee({ email: shared.by, role: u.role, groups: u.groups ?? [] }, t.workspaces[t.series[target].workspace]);
    try {
      if (!runs) throw new Error('not shared');
      startWith(target, wake.label!, shared.by, shared.logins, { from: wake.from });
    } catch {
      w.requests[newId()] = { series: target, label: wake.label!, from: wake.from, at: now };
    }
  }
  saveWakes(w);
}

// The ops log's line for a run: the report's first line, plain, or its first sentence when that line runs long.
function summaryOf(report: string): string {
  const line = report.split('\n')[0].replace(/\*+|^#+/g, '').trim();
  return (line.length > 200 ? line.split(/(?<=[.!?])\s/)[0] : line).slice(0, 200);
}

// What a run cost until a restart cut it: its agent's replies since it started, in its session, whose last line the cut may have
// left half written.
function costSince(inst: Instance, at: string): number {
  const dir = join(inst.dir, 'session'), lines = existsSync(dir) ? readdirSync(dir).flatMap(f => readFile(inst.dir, `session/${f}`)?.split('\n') ?? []) : [];
  return lines.map(l => { try { return JSON.parse(l); } catch { return {}; } })
    .filter(e => e.type === 'message' && e.message.role === 'assistant' && e.timestamp >= at).reduce((t, e) => t + (e.message.usage?.cost?.total ?? 0), 0);
}

// A run a restart cut ends as aborted, with what it cost so far, and its instance is woken to carry on, so a deploy needn't wait
// for quiet. A run the move from the team's fork cut has its done already, from scripts/migrate-fork.ts, and is woken the same way.
export function recover() {
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => i.doc.status === 'open')) {
    const run = inst.log.findLast(e => e.op === 'run' || e.op === 'done');
    if (run?.op === 'run') {
      inst.append('server', 'done', { run: run.run, aborted: true, seen: seenBefore(inst), cost: +costSince(inst, run.at).toFixed(4), summary: null, error: 'a restart cut the run' });
      inst.append('server', 'wake', { reason: 'A restart cut your last run; carry on', from: 'server' });
    }
    if (run?.error === 'cut by the move to 0.2.0' && !due(inst)) inst.append('server', 'wake', { reason: 'The move to 0.2.0 cut your last run; carry on', from: 'server' });
    kick(inst);
  }
}

// An open instance whose run met its runner's expired login carries on when they sign in to it again.
changes.on('login', (email: string, id: string, name: string) => {
  for (const sid of Object.keys(tree().series)) for (const inst of instances(sid).filter(i => i.doc.status === 'open')) {
    const hit = inst.log.findLast(e => e.op === 'expired' && e.login === id && e.runner === email);
    if (!hit || inst.log.some(e => e.seq > hit.seq && e.op === 'wake' && e.login === id)) continue;
    inst.append('server', 'wake', { reason: `${email} signed in to ${name} again`, from: 'server', login: id });
    kick(inst);
  }
});

export function startWaking() {
  recover();
  fire();
  setInterval(fire, Number(process.env.RF_WAKE_TICK_MS ?? 60_000)).unref();
}

// A folder as a run sees it: an instance, such as its own label or ../<series>/<label>, or a series, such as . or ../<series> or
// ../../<workspace>/<series>; answered by id, if the run can read it.
export function resolveFor(a: Active, folder: string): string {
  const t = tree(), full = posix.normalize(posix.join(a.view.cwd, folder)).split('/'), path = full.slice(2);
  const sid = Object.keys(t.series).find(id => t.series[id].name === path[1] && t.workspaces[t.series[id].workspace].name === path[0]);
  if (full[1] !== 'work' || path.length < 2 || path.length > 3 || !sid || (sid !== a.inst.seriesId && !reach(t, a.inst.seriesId).includes(sid))) throw new HttpError(404, `no series you can read at ${folder}`);
  if (path.length === 2) return sid;
  const id = labels(sid).find(l => l.label === path[2])?.id;
  if (!id) throw new HttpError(404, `no instance ${path[2]} in ${t.series[sid].name}`);
  return id;
}
