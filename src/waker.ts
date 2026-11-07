import { freemem } from 'node:os';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { agentsFile, closedBefore, createInstance, HttpError, instance, instanceDir, instances, isPerson, labels, newId, readFile, seriesDir, type Entry, type Instance } from './store.ts';
import { startRun, type Run, type View } from './runner.ts';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { prepare, sources } from './indexes.ts';
import { canSee, changes, everyone, readJson, rfDir, tree, type Tree, writeJson } from './system.ts';
import { asPerson, users } from './auth.ts';
import type { Browsers } from './browsers.ts';
import { seriesSettings } from './series.ts';
import { pushed, skills } from './skills.ts';
import { AGENT, commit, committed } from './git.ts';
import { logins, runnerOf } from './logins.ts';
import { confirm } from './entra.ts';
import { reachable, types } from './connections.ts';

// What runs when: one run at a time per series, at most RF_MAX_RUNS at once, started by people's acts and by wakes.
const LIMIT_MS = Number(process.env.RF_LIMIT_MIN ?? 120) * 60_000;
const MAX_RUNS = Number(process.env.RF_MAX_RUNS ?? 20);
// Memory binds first: no run starts while less than RF_MIN_FREE_GB is free; waiting ones start as runs end, or at the next tick. Each
// run started in the last minute asks 1 GB more, about what one takes as it loads, which free memory doesn't show yet. 0 checks no
// memory, as for tests on a small machine.
const MIN_FREE = Number(process.env.RF_MIN_FREE_GB ?? 6) * 2 ** 30;
const started: number[] = [];
const full = () => active.size >= MAX_RUNS || (MIN_FREE > 0 && freemem() < MIN_FREE + started.filter(t => t > Date.now() - 60_000).length * 2 ** 30);
export const MAX_OPEN = 3;
const SPACING_MS = 15 * 60_000, MAX_WAKES = 20;

export type Active = { inst: Instance; n: number; session: number; token: string; view: View; skills: Record<string, number>; shape: string; run?: Run; sent: number; seen: number; texts: Map<string, number>; interrupted: boolean; done: boolean; cost: number; failed?: string; hosts: Set<string>; links: Map<string, string>; browsers?: Browsers; timer?: NodeJS.Timeout; process: string; thread?: string };
export const active = new Map<string, Active>();
export const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();
const waiting = new Set<Instance>();

// A run's Pi, idle once the run ends cleanly, which its instance's next run within RF_IDLE_MIN carries on, as a new turn of the same
// session whose message is the new log entries; at most RF_MAX_IDLE are idle, the longest ended first, and none holds its series'
// slot. Anything the run would start from otherwise ends it: a takeover, new ticks, a view of the data changed, as by a rename, its
// instance closed or abandoned, its runner no longer seeing it. So does a run that failed or was cut short, as by a refusal, whose
// session is no place to carry on, and one that left a job running in its sandbox, which no run would watch.
const IDLE_MS = Number(process.env.RF_IDLE_MIN ?? 60) * 60_000, MAX_IDLE = Number(process.env.RF_MAX_IDLE ?? 8);
type Idle = { inst: Instance; run: Run; token: string; view: View; skills: Record<string, number>; session: number; shape: string; seq: number; since: number };
const idle = new Map<string, Idle>();
// What a run's Pi starts from, which a run carrying its session on must still: its view of the data, the AGENTS.md files there, the
// live skills' versions, and the caches it has copies of at $RF_INDEX, a first one for a source so starting a session that has them.
function startsFrom(inst: Instance): string {
  const v = view(inst);
  return JSON.stringify([v.instance, v.names, v.series, v.env, v.ro.filter(([, at]) => at.endsWith('/AGENTS.md')).map(([p]) => existsSync(p) && readFileSync(p, 'utf8')),
    skills().map(s => [s.id, pushed(s).version]), sources(inst).map(({ o }) => o.id)]);
}
function stale(i: Idle): boolean {
  const t = tree(), runner = asPerson(runnerOf(i.inst).by);
  return Date.now() - i.since > IDLE_MS || i.inst.doc.status !== 'open' || !(runner && canSee(runner, t.workspaces[t.series[i.inst.seriesId].workspace]))
    || i.inst.log.some(e => e.seq > i.seq && ['takeover', 'logins'].includes(e.op)) || startsFrom(i.inst) !== i.shape;
}
// A run's Pi stopped, and its copies of indexes gone.
const end = (token: string, run: Run) => run.stop().catch(e => console.error('a run left its scratch folder', e))
  .finally(() => rmSync(join(rfDir(), 'runs', token), { recursive: true, force: true }));
function drop(id: string) {
  const i = idle.get(id)!;
  idle.delete(id);
  end(i.token, i.run);
}

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
// the runner's word, though it runs on it where it may. A wake that starts nothing is one too. A reply or a sign-off from whom the
// agent's ask it answers named is no note: from before replies named what they answer, the thread's last ask.
export const isNote = (inst: Instance, e: Entry) => !!e.note || (isPerson(e) && ['upload', 'comment', 'signoff'].includes(e.op) && e.by !== runnerOf(inst).by
  && !(e.op !== 'upload' && (e.parent ?? e.on ? inst.log[(e.parent ?? e.on) as number - 1] : inst.log.findLast(x => x.seq < e.seq && x.op === 'comment' && x.thread === e.thread && x.by === 'agent'))?.to === e.by));
// A quiet entry, such as rf's without --wake, starts nothing, and its act kicks nothing that waits: the next run reads it with the rest.
export const starts = (inst: Instance, e: Entry) => !e.quiet && (!isNote(inst, e) || starter(inst, e.by));

export function pending(inst: Instance, seen: number): Entry[] {
  return inst.log.filter(e => e.seq > seen && starts(inst, e) && (e.op === 'wake' || (isPerson(e) && ['upload', 'comment', 'signoff'].includes(e.op))));
}

// Whether an instance has something for a run: what came since its last run, or since an Interrupt, which waits for the next act.
const due = (inst: Instance) => inst.doc.status === 'open' && pending(inst, Math.max(seenBefore(inst), inst.log.findLast(e => e.op === 'interrupt')?.seq ?? 0)).length > 0;

// A run's first message names the runner, on whose behalf the agent acts, and what they lend it, each tick as logged, as does a
// later one whose entries change those: a takeover and a runner's new ticks.
export function message(inst: Instance, n: number, entries: Entry[], first = false): string {
  const made = entries.findLast(e => ['takeover', 'logins'].includes(e.op)), us = users(), who = (by: string) => `${us[by]?.name || by} <${by}>`;
  const set = [...wakesOf(inst.id), ...wakesOf(inst.seriesId)];
  // The corrections on the instances before it, so an error isn't rolled forward.
  const fixed = !first ? [] : closedBefore(inst).flatMap(i => i.log.filter(e => e.op === 'correction').map(e => {
    const see = e.see as { label: string; thread?: string } | undefined;
    return `${i.label}${e.item ? ` ${e.item}${e.ref ? `@${e.ref}` : ''}` : ''} is ${e.kind}, ${JSON.stringify(e.text)}${see ? `, see ${see.label}${see.thread ? ` ${see.thread}` : ''}` : ''}`;
  }));
  return `Instance ${inst.label}, run ${n}.`
    + (first || made ? ` Its runner is ${made?.op === 'takeover' ? `now ${who(made.by)}, taking over from ${who(made.from as string)}` : who(runnerOf(inst).by)}, who lends you ${runnerOf(inst).logins.join(', ') || 'no login'}.` : '')
    + (first && set.length ? ` Pending wakes: ${set.map(k => `${k.id}, ${k.target === inst.id ? 'waking this instance' : `starting ${k.label}`} at ${k.at}${k.days ? `, then each ${k.days.join(', ')}` : ''}`).join('; ')}.` : '')
    + (fixed.length ? ` Corrections on earlier instances: ${fixed.join('; ')}.` : '')
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
  const names = Object.fromEntries(series.flatMap(id => labels(id).map(l => [`${at(id)}/${l.label}`, l.id])));
  const agents = [...new Set(series.map(id => t.series[id].workspace))].map(w => [agentsFile(w), `/work/${t.workspaces[w].name}/AGENTS.md`] as [string, string]);
  return {
    instance: `${at(inst.seriesId)}/${inst.label}`, dir: inst.dir, pylib: join(inst.series(), '.pylib'),
    ro: [[agentsFile(), '/work/AGENTS.md'], ...agents, ...Object.entries(names).map(([path, id]) => [instanceDir(id), path] as [string, string])],
    names, series: Object.fromEntries(series.map(id => [at(id), id])), env: Object.assign({}, ...reachable(inst).map(c => types[c.type].env?.(c, runnerOf(inst).logins))),
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
  // A run starts from its instance's folder as the last run's commit left it.
  await committed(inst.dir);
  const series = inst.seriesId;
  const seen = seenBefore(inst);
  // A kick that starts nothing ends the instance's queued state all the same: pages that showed it should hear.
  if (active.has(series) || !due(inst)) return void changes.emit('change', inst.id);
  if (full()) return void waiting.add(inst);
  // A run starts only for a runner Microsoft still signs in (entra.ts): one it no longer does waits for them to sign in again, and
  // one who has left, for someone to take the instance over. Microsoft unreachable, it tries again in a minute.
  const runner = runnerOf(inst).by, hit = inst.log.findLast(e => e.op === 'expired' && e.login === 'entra' && e.runner === runner);
  if (hit && !inst.log.some(e => e.seq > hit.seq && e.op === 'wake' && e.login === 'entra')) return void changes.emit('change', inst.id);
  try {
    await confirm(runner);
  } catch (e) {
    if ((e as HttpError).status !== 401) {
      console.error(`a run of ${inst.id} waits a minute: Microsoft didn't confirm ${runner}'s sign-in`, e);
      return void setTimeout(() => kick(inst), 60_000).unref();
    }
    inst.append('server', 'expired', { login: 'entra', name: 'rollforward', runner, error: (e as Error).message, ...((e as { left?: boolean }).left && { left: true }) });
    return void changes.emit('change', inst.id);
  }
  if (active.has(series) || !due(inst)) return void changes.emit('change', inst.id);
  if (full()) return void waiting.add(inst);
  let kept = idle.get(inst.id);
  idle.delete(inst.id);
  if (kept && stale(kept)) {
    end(kept.token, kept.run);
    kept = undefined;
  }
  if (!kept) {
    started.push(Date.now());
    started.splice(0, started.length - MAX_RUNS);
  }
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && e.by !== 'agent');
  const text = message(inst, n, entries, !kept);
  // The versions live as its Pi starts, which it uses to its end.
  const live = kept ? [] : skills().map(s => ({ ...s, dir: realpathSync(s.dir) }));
  const a: Active = {
    inst, n, session: kept?.session ?? n, token: kept?.token ?? randomUUID(), view: kept?.view ?? view(inst), skills: kept?.skills ?? Object.fromEntries(live.map(s => [s.id, pushed(s).version])), shape: kept?.shape ?? startsFrom(inst),
    sent: entries.at(-1)!.seq, seen, texts: new Map([[text, entries.at(-1)!.seq]]), interrupted: false, done: false, cost: 0, hosts: new Set(), links: new Map(),
    process: processOf(inst), thread: pending(inst, seen)[0]?.thread as string | undefined,
  };
  active.set(series, a);
  byToken.set(a.token, a);
  // Whose OpenRouter key it starts with, its runner's own or the server's (connections.ts), never the key.
  const key = logins(runnerOf(inst).by).some(l => l.id === 'openrouter' && l.enabled) ? 'own' : 'shared';
  inst.append('server', 'run', { run: n, upto: a.sent, skills: a.skills, key, ...(kept && { continues: kept.session }) });
  let settled: Promise<boolean>;
  try {
    // A continued run's index copies are made again, in the folder its Pi reads them from, so it reads what's indexed since, and
    // nothing of a source no longer ticked.
    if (kept) {
      a.run = kept.run;
      const index = join(rfDir(), 'runs', a.token);
      if (a.view.env.RF_INDEX) {
        for (const f of readdirSync(index)) rmSync(join(index, f), { recursive: true });
        prepare(inst, index);
      }
    } else {
      // Copies of the indexes of what its runner ticked, on the indexes' own disk, read-only at $RF_INDEX.
      const index = join(rfDir(), 'runs', a.token);
      if (prepare(inst, index)) {
        a.view.ro.push([index, '/index']);
        a.view.env.RF_INDEX = '/index';
      }
      a.run = await startRun({ token: a.token, id: inst.id, n, view: a.view, skills: live, onEvent: e => byToken.has(a.token) && heard(byToken.get(a.token)!, e) });
    }
    ({ settled } = await a.run.turn(text));
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
  settled.then(aborted => finish(a, aborted, a.failed));
}

// What its Pi says as a run goes, the run now its token's.
function heard(a: Active, e: JsonAgentSessionEvent) {
  if (e.type === 'message_end' || e.type === 'tool_execution_end') changes.emit('change', a.inst.id); // the audit shows the run as it goes
  if (e.type === 'tool_execution_end') a.browsers?.shoot().catch(err => console.error(`run ${a.n} of ${a.inst.id}: no screenshot`, err));
  if (e.type === 'message_end' && e.message.role === 'assistant') {
    a.failed = e.message.stopReason === 'error' ? e.message.errorMessage ?? 'the model failed' : undefined; // a later success clears it
  }
  if (e.type !== 'message_start' || e.message.role !== 'user') return;
  const c = e.message.content;
  const seq = a.texts.get(typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join(''));
  if (seq) a.seen = Math.max(a.seen, seq);
}

// The process a run starts from: its instance's working/process.md, or, until it has one, that of the series' latest closed instance
// before it by label, as the page redlines it. A rule is one of its list items.
function processOf(inst: Instance): string {
  const prev = instances(inst.seriesId).filter(i => i.doc.status === 'closed' && i.label < inst.label).at(-1);
  return readFile(inst.dir, 'working/process.md') ?? (prev && readFile(prev.dir, 'working/process.md')) ?? '';
}
const rules = (was: string, now: string) => {
  const old = new Set(was.split('\n').map(l => l.trim()));
  return now.split('\n').filter(l => /^\s*([-*+]|\d+[.)])\s/.test(l) && !old.has(l.trim())).length;
};

function finish(a: Active, aborted: boolean, error?: string) {
  if (a.done) return;
  a.done = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  const series = a.inst.seriesId;
  active.delete(series);
  a.browsers?.end().catch(e => a.inst.append('server', 'browsers', { run: a.n, error: e.message }));
  // The rules it added to the process, or reworded, for the thread whose entry started it, where they were likely agreed.
  const added = rules(a.process, readFile(a.inst.dir, 'working/process.md') ?? a.process);
  a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(4), ...(error && { error }), ...(added && { rules: added, thread: a.thread }) });
  // Its Pi idles for the instance's next run, or stops, the longest idle too past RF_MAX_IDLE.
  const keep = !aborted && !error && !!a.run && a.inst.doc.status === 'open' && a.run.alone();
  if (keep) {
    idle.set(a.inst.id, { inst: a.inst, run: a.run!, token: a.token, view: a.view, skills: a.skills, session: a.session, shape: a.shape, seq: a.inst.log.at(-1)!.seq, since: Date.now() });
    if (idle.size > MAX_IDLE) drop(idle.keys().next().value!);
  }
  // The run's changes are one commit, with the names.tsv they were written under, which the instance's next run and its other
  // commits wait for: once its sandbox has stopped, or, idle, as it is, nothing running in it.
  if (!a.run) rmSync(join(rfDir(), 'runs', a.token), { recursive: true, force: true });
  const stopped = keep || !a.run ? undefined : end(a.token, a.run);
  commit(a.inst.dir, AGENT, [`Run ${a.n}`, error].filter(Boolean).join(': '), stopped).catch(e => a.inst.append('server', 'commit', { run: a.n, error: e.message }));
  if (a.run) { // one that never started, as with a missing API key, waits for the next act or a restart rather than retrying at once
    const next = due(a.inst) ? a.inst : instances(series).find(i => i !== a.inst && due(i));
    if (next) start(next);
  }
  startWaiting();
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
  const why = debounce.has(inst.id) ? 'starting' : a ? `its series is running ${a.inst.label}` : active.size >= MAX_RUNS ? `${MAX_RUNS} runs are going, the most RF_MAX_RUNS allows` : 'too little memory is free (RF_MIN_FREE_GB)';
  return { why, since: pending(inst, seenBefore(inst))[0]?.at ?? new Date().toISOString() };
}

// Closing an instance wakes its series' later open instances, which may have used its draft; a note for those the closer doesn't start,
// and a quiet close's wake is quiet. A <label>-r2 closing supersedes <label>, as a <label>-r3 does <label>-r2.
export function closed(inst: Instance, by: string, quiet?: boolean) {
  for (const later of instances(inst.seriesId).filter(i => i.doc.status === 'open' && i.label.localeCompare(inst.label, 'en', { numeric: true }) > 0)) {
    later.append('server', 'wake', { reason: `${inst.label} closed: its final figures may differ from the draft you read`, from: `${named(tree(), inst.seriesId)}/${inst.label}`, ...(!starter(later, by) && { note: true }), ...(quiet && { quiet: true }) });
    if (!quiet) kick(later);
  }
  const [, base, r] = /^(.+)-r(\d+)$/.exec(inst.label) ?? [], was = base && instances(inst.seriesId).find(i => i.label === (r === '2' ? base : `${base}-r${Number(r) - 1}`) && i.doc.status === 'closed');
  if (was) correct(was, 'server', { kind: 'superseded', text: `${inst.label} supersedes it`, see: inst });
}

// A correction: a closed instance is never changed, but takes later entries saying that one of its items, or itself, is wrong or
// superseded, and where the change is, `see`, an instance, by its id and its label then, and its thread, which notes it too. Each is
// a commit of each closed instance it lands in; an open one's next run commits it.
export function correct(inst: Instance, by: string, c: { kind: string; item?: string; ref?: string; text: string; see?: Instance; thread?: string }) {
  const e = inst.append(by, 'correction', { kind: c.kind, ...(c.item && { item: c.item }), ...(c.ref && { ref: c.ref }), text: c.text, ...(c.see && { see: { inst: c.see.id, label: c.see.label, ...(c.thread && { thread: c.thread }) } }) });
  c.see?.append(by, 'corrected', { inst: inst.id, label: inst.label, seq: e.seq, kind: c.kind, ...(c.item && { item: c.item }) });
  const who = by === 'agent' ? AGENT : by === 'server' ? { name: 'rollforward', email: 'server@rollforward' } : { name: users()[by]?.name ?? by, email: by };
  for (const [i, m] of [[inst, `Correction: ${c.item ?? inst.label} is ${c.kind}${c.see ? `, see ${c.see.label}` : ''}`], [c.see, `Corrected: ${inst.label}${c.item ? ` ${c.item}` : ''} is ${c.kind}`]] as const)
    if (i?.doc.status === 'closed') commit(i.dir, who, m).catch(err => i.append('server', 'commit', { error: err.message }));
  return e;
}

// Wakes (.rf/wakes.json): the pending ones by id, each for a target, an instance or a series by id, and the requests to start an
// instance that a series no one shares, or with 3 open, got instead. A target fires at most once in 15 minutes: a wake due sooner
// waits. A run's wake notes its instance, `inst`, as its name in `from` may change before it fires. One with `days` recurs each week
// on them at its time of day, in the server's time zone; a series' moves the date in its label on with it, keeping it the day it
// fires or the one before that it fires on, as it was set.
export type Wake = { target: string; at: string; from: string; label?: string; inst?: string; days?: string[] };
export type Request = { series: string; label: string; from: string; at: string };
type Wakes = { pending: Record<string, Wake>; fired: Record<string, string>; requests: Record<string, Request> };
export const wakes = () => readJson<Wakes>('wakes.json', { pending: {}, fired: {}, requests: {} });
const saveWakes = (w: Wakes) => writeJson('wakes.json', w);
export const wakesOf = (target: string, w = wakes()) => Object.entries(w.pending).filter(([, k]) => k.target === target)
  .map(([id, k]) => ({ id, ...k })).sort((a, b) => a.at.localeCompare(b.at));

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], dayOf = (d: Date) => WEEK[(d.getDay() + 6) % 7];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateIn = (label?: string) => label?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
// The next of `days` after d, or by -1 the one before it, at d's time of day.
function step(d: Date, days: string[], by: 1 | -1): Date {
  const n = new Date(d);
  do n.setDate(n.getDate() + by); while (!days.includes(dayOf(n)));
  return n;
}

// The days a wake first due `at` recurs on, from mon-fri or mon,wed,fri, or none from '', with a series' label's date checked.
export function weekly(text: string, at: Date, label?: string): string[] | undefined {
  const on = new Set<string>();
  for (const part of text.toLowerCase().split(',').map(p => p.trim()).filter(Boolean)) {
    const [a, b = a] = part.split('-').map(d => WEEK.indexOf(d));
    if (a < 0 || b < 0) throw new HttpError(400, `days: such as mon-fri or mon,wed,fri, not ${text}`);
    for (let d = a; on.add(WEEK[d]), d !== b; d = (d + 1) % 7);
  }
  const days = WEEK.filter(d => on.has(d)), date = dateIn(label);
  if (!days.length) return undefined;
  if (!days.includes(dayOf(at))) throw new HttpError(400, `${ymd(at)} is a ${dayOf(at)}, not one of the days it recurs on`);
  if (label !== undefined && date !== ymd(at) && date !== ymd(step(at, days, -1)))
    throw new HttpError(400, `a weekly wake's label holds the date it first fires, ${ymd(at)}, or the one before it that it fires on, ${ymd(step(at, days, -1))}`);
  return days;
}

// A series' one-off wake for a label pending already moves it, or is one a weekly wake starting that label has made; any other adds
// up, unless the same is pending, to 20 a target.
export function setWake(target: string, wake: Omit<Wake, 'target'>): Wake & { id: string } {
  const w = wakes(), k: Wake = { ...wake, target }, labelled = k.label !== undefined && !k.days;
  // A weekly one keeps its time of day; fire() spaces it.
  if (!k.days) k.at = new Date(Math.max(Date.parse(k.at), Date.parse(w.fired[target] ?? '1970-01-01') + SPACING_MS)).toISOString();
  const [id = newId(), was] = Object.entries(w.pending).find(([, p]) => p.target === target && p.label === k.label
    && (labelled || (p.at === k.at && String(p.days) === String(k.days)))) ?? [];
  if (!was && Object.values(w.pending).filter(p => p.target === target).length >= MAX_WAKES) throw new HttpError(409, `${MAX_WAKES} wakes are pending for it: cancel one first`);
  if (!(labelled && was?.days)) w.pending[id] = k;
  saveWakes(w);
  return { id, ...w.pending[id] };
}

export function cancelWake(id: string) {
  const w = wakes();
  delete w.pending[id];
  saveWakes(w);
}

// Every wake and request for these series and instances, as they close or are archived.
export function cancelWakes(targets: string[]) {
  const w = wakes();
  for (const [id, k] of Object.entries(w.pending)) if (targets.includes(k.target)) delete w.pending[id];
  for (const [id, r] of Object.entries(w.requests)) if (targets.includes(r.series)) delete w.requests[id];
  saveWakes(w);
}

export function dropRequest(id: string): Request {
  const w = wakes(), r = w.requests[id];
  if (!r) throw new HttpError(404, `no request ${id}`);
  delete w.requests[id];
  saveWakes(w);
  return r;
}

// Makes an instance of a series, run by `by` with the logins they ticked, and starts it with a wake after its create, for a wake, a
// request or a person; without one, as a person makes it quietly, it waits for its first act.
export function startWith(seriesId: string, label: string, by: string, logins: string[], wake?: { from: string }): Instance {
  if (instances(seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances are open; close one first`);
  const inst = createInstance(seriesId, label, by, logins);
  if (wake) {
    inst.append('server', 'wake', wake);
    kick(inst);
  }
  return inst;
}

function fire() {
  for (const [id, i] of idle) if (stale(i)) drop(id);
  startWaiting();
  const w = wakes(), now = new Date().toISOString(), t = tree();
  const due = Object.entries(w.pending).filter(([, k]) => k.at <= now).sort(([, a], [, b]) => a.at.localeCompare(b.at));
  if (!due.length) return;
  for (const [id, wake] of due) {
    const { target, days, label } = wake;
    if (Date.parse(w.fired[target] ?? '1970-01-01') + SPACING_MS > Date.parse(now)) continue;
    // One a person set goes only while they may see its workspace: once they can't, as when they've left, it's gone.
    const setter = asPerson(wake.from), ws = t.workspaces[t.series[t.series[target] ? target : instance(target).seriesId].workspace];
    if (!wake.inst && wake.from.includes('@') && !(setter && canSee(setter, ws))) {
      delete w.pending[id];
      console.log(`a wake ${wake.from} set went unfired, as they can no longer see ${ws.name}`);
      continue;
    }
    w.fired[target] = now;
    delete w.pending[id];
    if (days) {
      const was = new Date(wake.at), next = step(was, days, 1), date = dateIn(label);
      w.pending[id] = { ...wake, at: next.toISOString(), ...(date && { label: label!.replace(date, ymd(date === ymd(was) ? next : was)) }) };
    }
    // Where the run that set it is now, though it was renamed or moved since.
    const from = wake.inst ? `${named(t, instance(wake.inst).seriesId)}/${instance(wake.inst).label}` : wake.from;
    // A series' wake for a label it has already wakes that instance.
    const known = t.series[target] && labels(target).find(l => l.label === label)?.id;
    if (!t.series[target] || known) {
      const inst = instance(known || target);
      if (inst.doc.status !== 'open') {
        console.log(`a wake found ${named(t, inst.seriesId)}/${inst.label} ${inst.doc.status}, so it woke nothing`);
        continue;
      }
      inst.append('server', 'wake', { from, ...(wake.inst !== inst.id && !starter(inst, wake.from) && { note: true }) });
      kick(inst);
      continue;
    }
    const shared = seriesSettings(seriesDir(target)).shared, sharer = shared && asPerson(shared.by);
    const runs = sharer && canSee(sharer, t.workspaces[t.series[target].workspace]);
    try {
      if (!runs) throw new Error('not shared');
      startWith(target, label!, shared.by, shared.logins, { from });
    } catch {
      w.requests[newId()] = { series: target, label: label!, from, at: now };
    }
  }
  saveWakes(w);
}

// A run a restart cut: its done's error, which `rf runs` tells from a failure.
export const CUT = 'a restart cut the run';

// A run a restart cut ends as aborted, with what its calls cost so far, its changes committed as at any run's end, and its instance
// is woken to carry on, so a deploy needn't wait for quiet. A commit the restart cut leaves git's locks, which would refuse the
// instance's next; no git runs as it starts.
export function recover() {
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => i.doc.status === 'open')) {
    for (const f of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'refs/heads/main.lock']) rmSync(join(inst.dir, '.git', f), { force: true });
    const run = inst.log.findLast(e => e.op === 'run' || e.op === 'done');
    if (run?.op === 'run') {
      const cost = inst.log.reduce((t, e) => t + (e.op === 'call' && e.run === run.run ? (e.cost as number | undefined) ?? 0 : 0), 0);
      inst.append('server', 'done', { run: run.run, aborted: true, seen: seenBefore(inst), cost: +cost.toFixed(4), error: CUT });
      inst.append('server', 'wake', { reason: `A restart cut run ${run.run}; carry on`, from: 'server' });
      commit(inst.dir, AGENT, `Run ${run.run}: ${CUT}`).catch(e => inst.append('server', 'commit', { run: run.run, error: e.message }));
    }
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

// A folder as a run sees it from its instance's, by the names it started with: an instance, such as . for its own, ../<label> or
// ../../<series>/<label>, or a series, such as .., ../../<series> or ../../../<workspace>/<series>; answered by id.
export function resolveFor(a: Active, folder: string): string {
  const path = posix.normalize(posix.join(a.view.instance, folder)), id = a.view.series[path] ?? a.view.names[path];
  if (id) return id;
  if (a.view.series[posix.dirname(path)]) throw new HttpError(404, `no instance ${posix.basename(path)} in ${posix.basename(posix.dirname(path))}`);
  throw new HttpError(404, `no series you can read at ${folder}`);
}

// A file a run pins in a comment, under upload/ or working/ of its instance, or of another of its series as ../<label>/...: its
// instance's id, by the names the run started with, and its path there.
export function pinFor(a: Active, f: unknown): { inst: string; path: string } | undefined {
  const m = typeof f === 'string' && posix.normalize(f) === f ? f.match(/^(?:\.\.\/([^/]+)\/)?((?:upload|working)\/.+)$/) : null;
  const inst = m && (m[1] === undefined ? a.inst.id : a.view.names[posix.join(posix.dirname(a.view.instance), m[1])]);
  return inst && !m[2].split('/').includes('..') && existsSync(join(instanceDir(inst), m[2])) ? { inst, path: m[2] } : undefined;
}
