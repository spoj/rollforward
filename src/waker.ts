import { freemem } from 'node:os';
import { closeSync, existsSync, mkdirSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { agentsFile, closedBefore, createInstance, HttpError, instance, instanceDir, instances, isPerson, labels, newId, openFile, seriesDir, type Entry, type Instance } from './store.ts';
import { pylib, startRun, type Run, type TurnEnd, type View } from './runner.ts';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { prepare } from './indexes.ts';
import { act, canSee, changes, readJson, rfDir, tree, type Tree, writeJson } from './system.ts';
import { asPerson, users } from './auth.ts';
import { websitesOf, type Browsers } from './browsers.ts';
import { notes, seriesSettings, type Note } from './series.ts';
import { pushed, skills } from './skills.ts';
import { AGENT, commit, committed, forget } from './git.ts';
import { lastAssign, logins, runnerAt, runnerOf } from './logins.ts';
import { confirm } from './entra.ts';
import { abortCalls, drainCalls, hasCalls, reachable, types } from './connections.ts';

// What runs when: one run at a time per series, at most RF_MAX_RUNS at once, started by people's acts and by wakes.
const LIMIT_MS = Number(process.env.RF_LIMIT_MIN ?? 120) * 60_000;
const MAX_RUNS = Number(process.env.RF_MAX_RUNS ?? 20);
// Memory binds first: no run starts while less than RF_MIN_FREE_GB is free; waiting ones start as runs end, or at the next tick. Each
// run started in the last minute asks 1 GB more, about what one takes as it loads, which free memory doesn't show yet. 0 checks no
// memory, as for tests on a small machine.
const MIN_FREE = Number(process.env.RF_MIN_FREE_GB ?? 6) * 2 ** 30;
const started: number[] = [];
// An update's drain (scripts/update.ts): from SIGUSR2 until RF_DRAIN_MIN after the latest, no run starts, as though every slot
// were taken. What would start waits, as for a slot, and starts if the drain lapses or, as an update means, after the restart
// (recover()).
const DRAIN_MS = Number(process.env.RF_DRAIN_MIN ?? 15) * 60_000;
if (!Number.isFinite(DRAIN_MS) || DRAIN_MS < 0 || DRAIN_MS > 2_147_483_647) throw new Error('RF_DRAIN_MIN must be between 0 and 35791 minutes');
let draining: NodeJS.Timeout | undefined;
const full = () => !!draining || active.size >= MAX_RUNS || (MIN_FREE > 0 && freemem() < MIN_FREE + started.filter(t => t > Date.now() - 60_000).length * 2 ** 30);
export const MAX_OPEN = 3;
const SPACING_MS = 15 * 60_000, MAX_WAKES = 20;

export type Active = { inst: Instance; n: number; runner: string; token: string; view: View; workspace: string; run?: Run; sent: number; noted: number; seen: number; delivered: number; texts: Map<string, number>; done: boolean; cost: number; estimated: boolean; failed?: string; hosts: Set<string>; links: Map<string, { name: string; offer: string }>; browsers?: Browsers; timer?: NodeJS.Timeout; process: string; thread?: string;
  // Its Pi as it starts, and once its Pi, sandbox and browsers have stopped, after it ends; whether its stop was asked for, from when
  // its token opens nothing (server.ts running()).
  ready?: Promise<Run>; ended?: Promise<unknown>; stopped?: boolean; interrupted?: boolean };
export const active = new Map<string, Active>();
export const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();
const waiting = new Set<Instance>();
const retiring = new Set<Active>();

// Whether an instance's runner can still see its workspace, as each run of theirs needs.
function sees(i: Instance, t = tree()) {
  const runner = asPerson(runnerOf(i).by);
  return !!runner && canSee(runner, t.workspaces[t.series[i.seriesId].workspace]);
}
// A run's Pi stopped, and its copies of indexes gone.
function end(token: string, run: Run | Promise<Run>) {
  return Promise.resolve(run).then(r => r.stop().catch(e => console.error('a run left its scratch folder', e)), () => {})
    .finally(() => rmSync(join(rfDir(), 'runs', token), { recursive: true, force: true }));
}

function seenBefore(inst: Instance): number {
  return Math.max((inst.log.findLast(e => e.op === 'done')?.seen as number | undefined) ?? 0, inst.copied);
}

// An entry's standing, the one place it's decided (docs/system.md, Runner): the runner's word, an answer from whom the agent's ask
// named, or a note, which the agent reads as context for its runner to take up; and whether it starts a run. People's comments,
// uploads, approvals and rejections have one, as do wakes and another instance's agent's comments; nothing else directs a run.
// - The last assign draws a line, a takeover being an assign to oneself: before it, what a run had read by then is history, with no
//   standing, and what none had is a note, whoever said it; neither starts anything.
// - After it, a person's act is the runner's word if they ran it as it was said, an answer if it answers an ask that named them,
//   from before the line too (from before replies named what they answer, the thread's last ask), and else a note.
// - A wake is judged as it fires and logged so, a note unless the runner set it, or a run of an instance of theirs in the series did,
//   this one's own among them; one pending as its instance was assigned is no one's word. Another instance's agent's comment is a note.
// - A note starts a run only where the runner shares the series; a quiet entry, such as rf's without --wake, none, and its act kicks
//   nothing that waits: the next run reads it with the rest. Nothing from before an earlier version's copy starts one.
// `upto` judges it as the log stood then, as history shows what started a run.
export type Standing = { word: 'runner' | 'answer' | 'note'; starts: boolean };
export function standing(inst: Instance, e: Entry, upto = inst.log.length): Standing | undefined {
  if (e.op !== 'wake' && !(['upload', 'comment', 'signoff', 'reject'].includes(e.op) && (isPerson(e) || e.note))) return undefined;
  const line = lastAssign(inst.log, upto)?.seq ?? 0, runner = runnerAt(inst.log, e.seq);
  if (e.seq < line && e.seq <= readAt(inst, line)) return undefined;
  const rawAsk = e.op === 'upload' || !e.thread ? undefined : e.parent ?? e.on ? inst.log[(e.parent ?? e.on) as number - 1] : inst.log.findLast(x => x.seq < e.seq && x.op === 'comment' && x.thread === e.thread && x.by === 'agent');
  const ask = rawAsk?.op === 'comment' && rawAsk.by === 'agent' && !!rawAsk.ask && rawAsk.seq > inst.copied && rawAsk.seq < e.seq && rawAsk.thread === e.thread && (rawAsk.ask !== 'proposal' || e.op !== 'comment') && !inst.answered(rawAsk, e.seq - 1) ? rawAsk : undefined;
  const word = e.seq < line || e.note ? 'note'
    : e.op !== 'wake' ? (e.by === runner ? 'runner' : ask?.to === e.by ? 'answer' : 'note')
    : e.seq <= inst.log.length || (!e.assigned && (e.from === runner || (!!e.inst && instance(e.inst as string).seriesId === inst.seriesId && runnerOf(instance(e.inst as string)).by === runner))) ? 'runner' : 'note';
  return { word, starts: !e.quiet && e.seq > Math.max(line, inst.copied) && (word !== 'note' || seriesSettings(inst.series()).shared?.by === runnerAt(inst.log, upto + 1)) };
}
// What the runs started before an assign, at seq `line`, had read, the run it stopped included, though its end is logged after it.
function readAt(inst: Instance, line: number): number {
  const runs = inst.log.filter(e => e.seq < line && e.op === 'run').length;
  return Math.max(inst.copied, ...inst.log.filter(e => e.op === 'done' && (e.run as number) <= runs).map(e => (e.seen as number | undefined) ?? 0));
}
// A wake as it fires: its standing, which its entry keeps.
const woken = (inst: Instance, wake: { from: string; inst?: string; assigned?: boolean }) => standing(inst, { seq: inst.log.length + 1, at: '', by: 'server', op: 'wake', ...wake })!;

export function pending(inst: Instance, seen: number, upto = inst.log.length): Entry[] {
  return inst.log.filter(e => e.seq > seen && e.seq <= upto && standing(inst, e, upto)?.starts);
}

// Whether an instance has something for a run: what came since its last run, or since an Interrupt or a failed or cut run, which
// waits for the next act; nothing while its series or its workspace is archived, which does no work until it's restored.
const stopped = (inst: Instance) => inst.log.findLast(e => e.op === 'interrupt' || (e.op === 'done' && (e.aborted || e.error)))?.seq ?? 0;
const due = (inst: Instance) => inst.doc.status === 'open' && pending(inst, Math.max(seenBefore(inst), stopped(inst))).length > 0
  && !archived(tree(), inst.seriesId);

// What a run is told of: people's acts, other instances' agents' notes, and the server's wakes, expired logins, uploads made items,
// renames and a run cut or failed; not the server's bookkeeping, such as a run's start, its hosts and screenshots, which the log keeps.
const told = (e: Entry) => isPerson(e) || !!e.note || ['wake', 'expired', 'point', 'rename'].includes(e.op) || (e.op === 'done' && (!!e.aborted || !!e.error));

// A run's first message names the runner, on whose behalf the agent acts, and what they lend it, each tick as logged with what it
// is, a website's at its address, as does a later one whose entries change those: an assign and a runner's new ticks. It lists
// the series' open notes, and a later one those left since.
export function message(inst: Instance, n: number, entries: Entry[], first = false, open: Note[] = []): string {
  const made = entries.findLast(e => ['takeover', 'assign', 'logins'].includes(e.op)), to = (made?.to ?? made?.by) as string, us = users(), who = (by: string) => `${us[by]?.name || by} <${by}>`;
  const { by, logins: ticked } = runnerOf(inst), set = [...wakesOf(inst.id), ...wakesOf(inst.seriesId)], sites = websitesOf(by);
  const offers = new Map(logins(by).flatMap(l => l.offers.map(o => [o.id, o.name])));
  const lent = (l: string) => l.startsWith('web:') && sites[l.slice(4)] ? `${l} at ${sites[l.slice(4)].url}` : offers.has(l) ? `${l} (${offers.get(l)})` : l;
  // The corrections on the instances before it, so an error isn't rolled forward.
  const fixed = !first ? [] : closedBefore(inst).flatMap(i => i.log.filter(e => e.op === 'correction').map(e => {
    const see = e.see as { label: string; thread?: string } | undefined;
    return `${i.label}${e.item ? ` ${e.item}${e.ref ? `@${e.ref}` : ''}` : ''} is ${e.kind}, ${JSON.stringify(e.text)}${see ? `, see ${see.label}${see.thread ? ` ${see.thread}` : ''}` : ''}`;
  }));
  const from = (e: Note) => e.by !== 'agent' ? who(e.by) : `the agent of ${named(tree(), instance((e.see as { inst: string }).inst).seriesId)}/${instance((e.see as { inst: string }).inst).label}, run ${e.run}, for ${who(e.runner as string)}`;
  return `Instance ${inst.label}, run ${n}.`
    + (first || made ? ` Its runner is ${made && made.op !== 'logins' ? `now ${who(to)}, ${to === made.by ? 'taking over' : `assigned by ${who(made.by)}`} from ${who(made.from as string)}` : who(by)}, who lends you ${ticked.map(lent).join(', ') || 'no login'}.` : '')
    + (first && set.length ? ` Pending wakes: ${set.map(k => `${k.id}, ${k.target === inst.id ? 'waking this instance' : `starting ${k.label}`} at ${k.at}${k.days ? `, then each ${k.days.join(', ')}` : ''}, from ${k.from}${woken(inst, k).word === 'runner' ? '' : ', a note'}${k.text ? `, saying ${JSON.stringify(k.text)}` : ''}`).join('; ')}.` : '')
    + (fixed.length ? ` Corrections on earlier instances: ${fixed.join('; ')}.` : '')
    + (open.length ? ` Open notes on the series: ${open.map(e => `n${e.seq}, from ${from(e)} at ${e.at}, ${JSON.stringify(e.text)}${(e.files as string[] | undefined)?.map(f => `, ../.notes/${f}`).join('') ?? ''}`).join('; ')}.` : '')
    + ' New log entries:\n'
    + entries.filter(told).map(e => JSON.stringify(standing(inst, e)?.word === 'note' ? { ...e, note: true } : e)).join('\n');
}

// What a series' agent may read: the other series of its workspace, and those of each workspace whose managers let its workspace's
// agents read it, its readers.
export const reads = (t: Tree, ws: string) => Object.keys(t.workspaces).filter(o => t.workspaces[o].readers?.includes(ws));

export function reach(t: Tree, seriesId: string): string[] {
  const ws = t.series[seriesId].workspace, read = [ws, ...reads(t, ws)];
  return Object.keys(t.series).filter(id => id !== seriesId && read.includes(t.series[id].workspace)).sort((a, b) => named(t, a).localeCompare(named(t, b)));
}

export const named = (t: Tree, seriesId: string) => `${t.workspaces[t.series[seriesId].workspace].name}/${t.series[seriesId].name}`;
export const archived = (t: Tree, seriesId: string) => !!(t.series[seriesId].archived || t.workspaces[t.series[seriesId].workspace].archived);

// The run's view of the data, by name, built when it starts: /work/<workspace>/<series>/<label>/ for every instance in its reach but
// an abandoned one, neither an example nor a starting point, and a deleted one, of which nothing is left, and each series' notes at
// /work/<workspace>/<series>/.notes/; the company's AGENTS.md at /work/AGENTS.md and each workspace's at
// /work/<workspace>/AGENTS.md; and the environment its runner's connections set.
export function view(inst: Instance): View {
  const t = tree(), at = (id: string) => `/work/${named(t, id)}`, series = [inst.seriesId, ...reach(t, inst.seriesId)];
  const names = Object.fromEntries(series.flatMap(id => labels(id).filter(l => !['abandoned', 'deleted'].includes(instance(l.id).doc.status)).map(l => [`${at(id)}/${l.label}`, l.id])));
  const agents = [...new Set(series.map(id => t.series[id].workspace))].map(w => [agentsFile(w), `/work/${t.workspaces[w].name}/AGENTS.md`] as [string, string]);
  const noting = series.filter(id => !t.series[id].single).map(id => [join(seriesDir(id), 'notes'), `${at(id)}/.notes`] as [string, string]);
  return {
    instance: `${at(inst.seriesId)}/${inst.label}`, dir: inst.dir, pylib: join(inst.series(), '.pylib'),
    ro: [[agentsFile(), '/work/AGENTS.md'], ...agents, ...noting, ...Object.entries(names).map(([path, id]) => [instanceDir(id), path] as [string, string])],
    names, series: Object.fromEntries(series.map(id => [at(id), id])), env: Object.assign({}, ...reachable(inst).map(c => types[c.type].env?.(c, runnerOf(inst).logins))),
  };
}

// A note on a series reaches a run of it going at once.
export function noted(seriesId: string) {
  const a = active.get(seriesId);
  if (a?.run) flush(a);
}

export function kick(inst: Instance) {
  const a = active.get(inst.seriesId);
  if (a) return a.inst === inst && a.run && flush(a);
  clearTimeout(debounce.get(inst.id));
  debounce.set(inst.id, setTimeout(() => { debounce.delete(inst.id); start(inst); }, 1500));
}

function flush(a: Active) {
  if (a.stopped) return;
  const entries = a.inst.log.filter(e => e.seq > a.sent && (e.by !== 'agent' || e.note)), fresh = notes(a.inst.series()).filter(e => e.seq > a.noted && !e.settled);
  // What it is told of reaches it at once, notes too.
  if (!entries.some(told) && !fresh.length) return;
  const text = message(a.inst, a.n, entries, false, fresh);
  a.sent = entries.at(-1)?.seq ?? a.sent;
  a.noted = fresh.at(-1)?.seq ?? a.noted;
  a.texts.set(text, a.sent);
  a.run!.steer(text).catch(err => finishRun(a, true, String(err)));
}

// What a timer starts, as a kick's, logs what fails rather than ending the server.
const start = (inst: Instance, tried = new Set<Instance>()) => begin(inst, tried).catch(e => console.error(`a run of ${inst.id} failed to start`, e));

const runnable = (i: Instance) => due(i) && sees(i) && !held(i, 'entra', runnerOf(i).by);
function bail(inst: Instance, tried: Set<Instance>) {
  changes.emit('change', inst.id);
  if (stopping || active.has(inst.seriesId)) return;
  const next = instances(inst.seriesId).find(i => !tried.has(i) && runnable(i));
  if (next) start(next, tried);
}

async function begin(inst: Instance, tried: Set<Instance>) {
  tried.add(inst);
  // A run starts from its instance's folder as the last run's commit left it.
  await committed(inst.dir);
  const series = inst.seriesId;
  const seen = seenBefore(inst);
  // A kick that starts nothing ends the instance's queued state all the same: pages that showed it should hear.
  if (active.has(series) || !due(inst)) return bail(inst, tried);
  if (full()) return void waiting.add(inst);
  // A run starts only for a runner Microsoft still signs in (entra.ts): one it no longer does waits for them to sign in again, and
  // one who has left, for someone to take the instance over. Microsoft unreachable, it tries again in a minute.
  const runner = runnerOf(inst).by;
  if (held(inst, 'entra', runner)) return bail(inst, tried);
  try {
    await confirm(runner);
  } catch (e) {
    if (runnerOf(inst).by !== runner) return void kick(inst);
    if ((e as HttpError).status !== 401) {
      console.error(`a run of ${inst.id} waits a minute: Microsoft didn't confirm ${runner}'s sign-in`, e);
      return void setTimeout(() => kick(inst), 60_000).unref();
    }
    inst.append('server', 'expired', { cause: pending(inst, seen)[0].seq, login: 'entra', name: 'rollforward', runner, error: (e as Error).message, ...((e as { left?: boolean }).left && { left: true }) });
    return bail(inst, tried);
  }
  if (stopping || active.has(series) || !due(inst)) return bail(inst, tried);
  if (runnerOf(inst).by !== runner) return void kick(inst);
  if (full()) return void waiting.add(inst);
  // One who can no longer see its workspace, as after being removed from it, waits for someone to take the instance over.
  if (!sees(inst)) return bail(inst, tried);
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && (e.by !== 'agent' || e.note)), left = notes(inst.series());
  const text = message(inst, n, entries, true, left.filter(e => !e.settled));
  // A run is a lease: one runner for the whole of it, the act whose ticks it may use (logins.ts lender()), and the AGENTS.md
  // files it reads, by their sha256, as its series' .pylib's listing is (runner.ts pylib()).
  const lease = runnerOf(inst);
  // The versions live as its Pi starts, which it uses to its end.
  const live = skills().map(s => ({ ...s, dir: realpathSync(s.dir) }));
  const a: Active = {
    inst, n, runner: lease.by, token: randomUUID(), view: view(inst), workspace: tree().series[series].workspace,
    sent: entries.at(-1)!.seq, noted: left.at(-1)?.seq ?? 0, seen, delivered: seen, texts: new Map([[text, entries.at(-1)!.seq]]), done: false, cost: 0, estimated: false, hosts: new Set(), links: new Map(),
    process: processOf(inst), thread: pending(inst, seen)[0]?.thread as string | undefined,
  };
  active.set(series, a);
  byToken.set(a.token, a);
  let settled: Promise<TurnEnd>, loggedRun = false;
  try {
    // Whose OpenRouter key it starts with, its runner's own or the server's (connections.ts), never the key.
    const key = logins(lease.by).some(l => l.id === 'openrouter' && l.enabled) ? 'own' : 'shared';
    const agents = Object.fromEntries(a.view.ro.filter(([p, at]) => at.endsWith('/AGENTS.md') && existsSync(p)).map(([p, at]) => [at, createHash('sha256').update(readFileSync(p)).digest('hex')]));
    inst.append('server', 'run', { run: n, runner: lease.by, consent: lease.consent, agents, pylib: pylib(a.view.pylib, inst.dir), upto: a.sent, skills: Object.fromEntries(live.map(s => [s.id, pushed(s).version])), key });
    loggedRun = true;
    // Copies of the indexes of what its runner ticked, on the indexes' own disk, read-only at $RF_INDEX.
    const index = join(rfDir(), 'runs', a.token);
    mkdirSync(index, { recursive: true });
    if (prepare(inst, index)) {
      a.view.ro.push([index, '/index']);
      a.view.env.RF_INDEX = '/index';
    }
    started.push(Date.now());
    started.splice(0, started.length - MAX_RUNS);
    a.ready = startRun({ token: a.token, id: inst.id, n, view: a.view, skills: live, onEvent: e => byToken.has(a.token) && heard(byToken.get(a.token)!, e) });
    a.run = await a.ready;
    // Cut as it started (leases(), remove(), stop()).
    if (a.stopped) return;
    ({ settled } = await a.run.turn(text));
    if (a.stopped) return;
  } catch (err) {
    if (loggedRun) await finishRun(a, true, String(err));
    else { active.delete(series); byToken.delete(a.token); bail(inst, tried); throw err; }
    return;
  }
  flush(a);
  a.timer = setTimeout(() => { finishRun(a, true, 'time limit').catch(e => console.error(`run ${n} of ${inst.id} failed to end`, e)); }, LIMIT_MS);
  settled.then(({ aborted, error }) => finishRun(a, aborted, error ?? a.failed)).catch(e => console.error(`run ${n} of ${inst.id} failed to end`, e));
}

// What its Pi says as a run goes, the run now its token's.
function heard(a: Active, e: JsonAgentSessionEvent) {
  if (e.type === 'message_end' || e.type === 'tool_execution_end') changes.emit('change', a.inst.id); // the audit shows the run as it goes
  if (e.type === 'tool_execution_end') a.browsers?.shoot().catch(err => console.error(`run ${a.n} of ${a.inst.id}: no screenshot`, err));
  if (e.type === 'message_end' && e.message.role === 'assistant') {
    a.failed = e.message.stopReason === 'error' ? e.message.errorMessage ?? 'the model failed' : undefined; // a later success clears it
    if (!['error', 'aborted'].includes(e.message.stopReason ?? '')) a.seen = Math.max(a.seen, a.delivered);
  }
  if (e.type !== 'message_start' || e.message.role !== 'user') return;
  const c = e.message.content;
  const text = typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join('');
  const seq = a.texts.get(text);
  a.texts.delete(text);
  if (seq) a.delivered = Math.max(a.delivered, seq);
}

// The process a run starts from: its instance's working/process.md, or, until it has one, that of the series' latest closed instance
// before it by label. A rule is one of its list items. One over 1 MB is none, as a run may leave a file of any size.
function processOf(inst: Instance): string {
  const prev = closedBefore(inst).at(-1);
  return processMd(inst.dir) ?? (prev && processMd(prev.dir)) ?? '';
}
function processMd(dir: string): string | undefined {
  const fd = openFile(dir, 'working/process.md');
  if (fd === undefined) return undefined;
  try {
    const b = Buffer.alloc(2 ** 20 + 1), n = readSync(fd, b, 0, b.length, 0);
    return n < b.length ? b.toString('utf8', 0, n) : undefined;
  } finally {
    closeSync(fd);
  }
}
const rules = (was: string, now: string) => {
  const old = new Set(was.split('\n').map(l => l.trim()));
  return now.split('\n').filter(l => /^\s*([-*+]|\d+[.)])\s/.test(l) && !old.has(l.trim())).length;
};

async function finishRun(a: Active, aborted: boolean, error?: string) {
  if (a.done || stopping) return;
  a.stopped = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  abortCalls(a);
  if (hasCalls(a)) await drainCalls(a);
  finish(a, aborted, error);
}

function finish(a: Active, aborted: boolean, error?: string): Entry | undefined {
  if (a.done || stopping) return;
  aborted ||= !!a.interrupted;
  a.done = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  abortCalls(a);
  const series = a.inst.seriesId;
  active.delete(series);
  const closing = a.browsers?.end().catch(e => a.inst.append('server', 'browsers', { run: a.n, error: e.message }));
  // The rules it added to the process, or reworded, for the thread whose entry started it, where they were likely agreed.
  const added = rules(a.process, processMd(a.inst.dir) ?? a.process);
  const done = a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(6), estimated: a.estimated, ...(error && { error }), ...(added && { rules: added, thread: a.thread }) });
  // The run's changes are one commit, with the names.tsv they were written under, which the instance's next run and its other
  // commits wait for, once its browsers and sandbox have stopped.
  if (!a.run && !a.ready) rmSync(join(rfDir(), 'runs', a.token), { recursive: true, force: true });
  const stopped = !a.run && !a.ready ? undefined : end(a.token, a.run ?? a.ready!);
  const closed = Promise.all([closing, stopped]);
  const committed = commit(a.inst.dir, AGENT, [`Run ${a.n}`, error].filter(Boolean).join(': '), closed).catch(e => a.inst.append('server', 'commit', { run: a.n, error: e.message }));
  retiring.add(a);
  a.ended = Promise.all([closed, committed]).finally(() => {
    retiring.delete(a);
    if (draining) changes.emit('change', 'tree'); // the page counts the runs an update waits for
  });
  // One that never started, as with a missing API key, waits for the next act rather than retrying itself at once; another open
  // instance of the series that waited for the slot still starts.
  const next = a.run && due(a.inst) ? a.inst : instances(series).find(i => i !== a.inst && runnable(i));
  if (next) start(next);
  startWaiting();
  return done;
}

// A run is a lease on its view too: a workspace it reads taking it off its readers, or a series it reads moving out of reach, its own
// series moving, or its runner no longer seeing its workspace cuts it at once, its token first, so nothing more goes out, and its
// instance carries on in a run of the new view. Anything else, such as a rename or a series made in reach, waits for the next run.
function leases() {
  const t = tree();
  for (const a of active.values()) {
    const ws = t.series[a.inst.seriesId].workspace, reads = [a.inst.seriesId, ...reach(t, a.inst.seriesId)];
    const why = ws !== a.workspace ? CUT.moved : !sees(a.inst, t) ? CUT.runner
      : Object.values(a.view.series).some(id => !reads.includes(id)) ? CUT.reach : undefined;
    if (why) cut(a, why);
  }
}

// A run cut, its token first, so nothing more goes out, then its browsers and its sandbox; its instance carries on in a new run.
export async function interruptRun(a: Active) {
  a.interrupted = true;
  a.stopped = true;
  byToken.delete(a.token);
  abortCalls(a);
  await Promise.race([a.run!.interrupt(), new Promise(r => setTimeout(r, 1500))]);
  await finishRun(a, true);
  await a.ended;
}

function cut(a: Active, why: string) {
  if (a.done || stopping) return;
  a.stopped = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  abortCalls(a);
  const after = () => {
    const done = finish(a, true, why);
    if (!done) return;
    a.inst.append('server', 'wake', { reason: `Run ${a.n} was cut: ${why}; carry on`, from: 'server', cause: done.seq });
    kick(a.inst);
  };
  if (!hasCalls(a)) return after();
  const draining = drainCalls(a).then(after);
  retiring.add(a);
  a.ended = draining.then(() => a.ended).finally(() => retiring.delete(a));
}

// Deleting an instance (store.ts markDeleted()) cuts a run going or queued for it, as a lease is cut, and any run whose view
// holds it, which carries on in a run of a view without it; its wakes go, and its series' one-off wakes and requests for its
// label, or all of a task's. Once nothing runs in its folder, its last commit is done and its runs' browsers have logged what
// they did, it becomes a hole. `fields` says what it cost, as its runs ended.
export async function remove(inst: Instance, by: string, fields: () => Record<string, unknown>): Promise<Entry> {
  const t = tree(), task = !!t.series[inst.seriesId].single;
  inst.doc.status = 'deleted';
  clearTimeout(debounce.get(inst.id));
  debounce.delete(inst.id);
  waiting.delete(inst);
  const runs = [...active.values()].filter(a => a.inst === inst || Object.values(a.view.names).includes(inst.id));
  for (const a of runs) {
    a.stopped = true;
    clearTimeout(a.timer);
    byToken.delete(a.token);
    abortCalls(a);
  }
  for (const a of runs) if (a.inst === inst && hasCalls(a)) await drainCalls(a);
  for (const a of runs) a.inst === inst ? finish(a, true, CUT.deleted) : cut(a, CUT.gone);
  const w = wakes();
  for (const [id, k] of Object.entries(w.pending)) if (k.target === inst.id || (k.target === inst.seriesId && (task || (k.label === inst.label && !k.days)))) delete w.pending[id];
  for (const [id, r] of Object.entries(w.requests)) if (r.target === inst.id || (r.series === inst.seriesId && (task || r.label === inst.label))) delete w.requests[id];
  delete w.fired[inst.id];
  saveWakes(w);
  const commits = forget(inst.dir), deleted = inst.markDeleted(by, fields());
  act(by, { method: 'POST', path: `/api/instances/${inst.id}/delete`, deleted: `${named(t, inst.seriesId)}/${inst.label}` });
  await Promise.all([...[...retiring].filter(a => a.inst === inst || Object.values(a.view.names).includes(inst.id)).map(a => a.ended), commits]);
  inst.clear();
  return deleted;
}
changes.on('change', (id: string) => id === 'tree' && setImmediate(leases));

// A stop, as a restart's, cuts every run, its token first, so nothing more goes out, then its connections to its browsers, and
// starts none; each Pi goes on, for what it had sent to be answered, until the server is gone. No run ends meanwhile: the next
// start ends them as a restart cut them (recover()), and closes their browsers (browsers.ts reap()).
let stopping = false;
export function stop() {
  stopping = true;
  clearTimeout(draining);
  byToken.clear();
  for (const a of active.values()) {
    a.stopped = true;
    abortCalls(a);
    a.browsers?.cut();
  }
  active.clear();
}

// A second signal only renews its deadline. Drained, no run goes.
export function drain() {
  if (!DRAIN_MS) return;
  const was = draining;
  clearTimeout(draining);
  draining = setTimeout(() => { draining = undefined; changes.emit('change', 'tree'); startWaiting(); }, DRAIN_MS).unref();
  if (!was) changes.emit('change', 'tree');
}
export const drained = () => !!draining && !active.size && !retiring.size;
// The runs a drain waits for, or null with none.
export const updating = () => (draining ? new Set([...active.values(), ...retiring]).size : null);

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
  const why = debounce.has(inst.id) ? 'starting' : a ? `its series is running ${a.inst.label}` : draining ? 'an update waits for the runs going to finish' : active.size >= MAX_RUNS ? `${MAX_RUNS} runs are going, the most RF_MAX_RUNS allows` : 'too little memory is free (RF_MIN_FREE_GB)';
  return { why, since: pending(inst, seenBefore(inst))[0]?.at ?? new Date().toISOString() };
}

// Closing an instance wakes its series' later open instances, which may have used its draft; a note for those the closer doesn't run,
// which starts them only where the series is shared, and a quiet close's wake is quiet. A <label>-r2 closing supersedes <label>, as a
// <label>-r3 does <label>-r2.
export function closed(inst: Instance, by: string, quiet?: boolean) {
  for (const later of instances(inst.seriesId).filter(i => i.doc.status === 'open' && i.label.localeCompare(inst.label, 'en', { numeric: true }) > 0)) {
    later.append('server', 'wake', { reason: `${inst.label} closed: its final figures may differ from the draft you read`, from: `${named(tree(), inst.seriesId)}/${inst.label}`, ...(woken(later, { from: by }).word === 'note' && { note: true }), ...(quiet && { quiet: true }) });
    if (!quiet) kick(later);
  }
  const [, base, r] = /^(.+)-r(\d+)$/.exec(inst.label) ?? [], was = base && instances(inst.seriesId).find(i => i.label === (r === '2' ? base : `${base}-r${Number(r) - 1}`) && i.doc.status === 'closed');
  if (was) correct(was, by, { kind: 'superseded', text: `${inst.label} supersedes it`, see: inst });
}

// A correction: a closed instance is never changed, but takes later entries saying that one of its items, or itself, is wrong or
// superseded, and where the change is, `see`, an instance, by its id and its label then, and its thread, which notes it too. Each is
// a commit of each closed instance it lands in; an open one's next run commits it.
export function correct(inst: Instance, by: string, c: { kind: string; item?: string; ref?: string; text: string; see?: Instance; thread?: string; run?: number }) {
  const run = c.run && { run: c.run };
  const e = inst.append(by, 'correction', { ...run, kind: c.kind, ...(c.item && { item: c.item }), ...(c.ref && { ref: c.ref }), text: c.text, ...(c.see && { see: { inst: c.see.id, label: c.see.label, ...(c.thread && { thread: c.thread }) } }) });
  const f = c.see?.append(by, 'corrected', { ...run, inst: inst.id, label: inst.label, seq: e.seq, kind: c.kind, ...(c.item && { item: c.item }) });
  const who = by === 'agent' ? AGENT : { name: users()[by]?.name ?? by, email: by };
  for (const [i, m, x] of [[inst, `Correction: ${c.item ?? inst.label} is ${c.kind}${c.see ? `, see ${c.see.label}` : ''}`, e], [c.see, `Corrected: ${inst.label}${c.item ? ` ${c.item}` : ''} is ${c.kind}`, f]] as const)
    if (i?.doc.status === 'closed') commit(i.dir, who, m).catch(err => i.append('server', 'commit', { cause: x!.seq, error: err.message }));
  return e;
}

// Wakes (.rf/wakes.json): the pending ones by id, each for a target, an instance or a series by id, and the requests to start an
// instance that a series no one shares, or with 3 open, got instead, or to wake an instance, `target`, that one pending as it was
// assigned, `assigned`, got where its runner doesn't share the series. A target fires at most once in 15 minutes: a wake due sooner
// waits. A run's wake notes its instance, `inst`, as its name in `from` may change before it fires, and any wake its `text`, which
// the run it starts reads in its wake entry. One with `days` recurs each week on them at its time of day, in the server's time zone;
// a series' moves the date in its label on with it, keeping it the day it fires or the one before that it fires on, as it was set.
export type Wake = { target: string; at: string; from: string; label?: string; inst?: string; days?: string[]; text?: string; assigned?: boolean };
export type Request = { series: string; label: string; from: string; at: string; inst?: string; text?: string; target?: string };
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
  for (const [id, r] of Object.entries(w.requests)) if ([r.series, r.target].some(x => targets.includes(x!))) delete w.requests[id];
  saveWakes(w);
}

// An assign makes its instance's pending wakes no one's word: each fires as a note, a request to its runner where they don't share
// the series (fire()).
export function assigned(inst: Instance) {
  const w = wakes();
  for (const k of Object.values(w.pending)) if (k.target === inst.id) k.assigned = true;
  saveWakes(w);
}

export function dropRequest(id: string): Request {
  const w = wakes(), r = w.requests[id];
  if (!r) throw new HttpError(404, `no request ${id}`);
  delete w.requests[id];
  saveWakes(w);
  return r;
}

// Makes an instance of a series, run by `by` with the logins they ticked, and starts it with wakes after its create: a wake's, a
// person's, or a request's and the person who starts it; without one, as a person makes it quietly, it waits for its first act.
export function startWith(seriesId: string, label: string, by: string, logins: string[], wakes: Woken[]): Instance {
  if (instances(seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances of ${tree().series[seriesId].name} are open: a new one waits until one closes`);
  return wakeWith(createInstance(seriesId, label, by, logins), wakes);
}

// Wakes an instance, each wake logged with who set it and its text, a note unless it's the runner's word (standing()).
type Woken = { from: string; text?: string; inst?: string; assigned?: boolean; quiet?: boolean };
export function wakeWith(inst: Instance, wakes: Woken[]): Instance {
  for (const wake of wakes) inst.append('server', 'wake', { from: wake.from, ...(wake.text && { text: wake.text }), ...(woken(inst, wake).word === 'note' && { note: true }), ...(wake.quiet && { quiet: true }) });
  if (wakes.some(w => !w.quiet)) kick(inst);
  return inst;
}

function fire() {
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
      const was = { from, text: wake.text, inst: wake.inst, assigned: wake.assigned };
      if (wake.assigned && !woken(inst, was).starts) w.requests[newId()] = { series: inst.seriesId, label: inst.label, target: inst.id, from, at: now, ...(wake.inst && { inst: wake.inst }), ...(wake.text && { text: wake.text }) };
      else wakeWith(inst, [was]);
      continue;
    }
    const shared = seriesSettings(seriesDir(target)).shared, sharer = shared && asPerson(shared.by);
    const runs = sharer && canSee(sharer, t.workspaces[t.series[target].workspace]);
    try {
      if (!runs) throw new Error('not shared');
      startWith(target, label!, shared.by, shared.logins, [{ from, text: wake.text, inst: wake.inst }]);
    } catch {
      w.requests[newId()] = { series: target, label: label!, from, at: now, ...(wake.inst && { inst: wake.inst }), ...(wake.text && { text: wake.text }) };
    }
  }
  saveWakes(w);
}

// Why a run was cut, its done's error, which `rf runs` tells from a failure: a restart, or a change that broke its lease (leases()).
// Either way its instance is woken to carry on.
export const CUT = { restart: 'a restart cut the run', moved: 'its series moved', runner: 'its runner can no longer see it', reach: 'its reach narrowed', deleted: 'its instance was deleted', gone: 'an instance in its reach was deleted' };

// A run a restart cut ends as aborted, with what its calls cost so far, its changes committed as at any run's end, and its instance
// is woken to carry on, so a deploy needn't wait for quiet, unless it was assigned as the run stopped: what came before is history. A commit the restart cut leaves git's locks, which would refuse the
// instance's next; no git runs as it starts.
export function recover() {
  // A deletion a restart cut is done: what's left of its folder goes.
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => i.hole)) inst.clear();
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => i.doc.status === 'open')) {
    for (const f of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'refs/heads/main.lock']) rmSync(join(inst.dir, '.git', f), { force: true });
    const run = inst.log.findLast(e => e.op === 'run' || e.op === 'done');
    if (run?.op === 'run') {
      const calls = inst.log.filter(e => e.op === 'call' && e.run === run.run);
      const cost = calls.reduce((t, e) => t + ((e.cost as number | undefined) ?? 0), 0);
      const estimated = calls.some(e => e.estimated === true);
      const done = inst.append('server', 'done', { run: run.run, aborted: true, seen: seenBefore(inst), cost: +cost.toFixed(6), estimated, error: CUT.restart });
      const held = Math.max(lastAssign(inst.log)?.seq ?? 0, inst.log.findLast(e => e.op === 'interrupt')?.seq ?? 0);
      if (held < run.seq || pending(inst, held).length) inst.append('server', 'wake', { reason: `A restart cut run ${run.run}; carry on`, from: 'server', cause: done.seq });
      commit(inst.dir, AGENT, `Run ${run.run}: ${CUT.restart}`).catch(e => inst.append('server', 'commit', { run: run.run, error: e.message }));
    }
    kick(inst);
  }
}

// Whether a login of `who`'s that expired holds an instance's runs: the instance is open and theirs, a run of theirs met it since
// the last assign, they haven't unticked or stopped using it since, and no sign-in woke it since.
export function held(inst: Instance, login: string, who: string, ticked = true): boolean {
  const r = runnerOf(inst);
  if (inst.doc.status !== 'open' || r.by !== who) return false;
  if (ticked && !['entra', 'openrouter'].includes(login) && !r.logins.some(t => t === login || t.startsWith(`${login}:`))) return false;
  if (ticked && login === 'openrouter' && !logins(who).find(l => l.id === 'openrouter')?.enabled) return false;
  const hit = inst.log.findLast(e => e.op === 'expired' && !e.left && e.login === login && e.runner === who);
  return !!hit && hit.seq > (lastAssign(inst.log)?.seq ?? 0) && !inst.log.some(e => e.seq > hit.seq && e.op === 'wake' && e.login === login);
}

// An open instance whose run met its runner's expired login carries on when they sign in to it again, or stop using an expired key.
changes.on('login', (email: string, id: string, name: string) => {
  for (const sid of Object.keys(tree().series)) for (const inst of instances(sid).filter(i => i.doc.status === 'open' && runnerOf(i).by === email)) {
    if (!held(inst, id, email, id !== 'openrouter')) continue;
    inst.append('server', 'wake', { reason: id === 'openrouter' && !logins(email).find(l => l.id === 'openrouter')?.enabled ? `${email} stopped using their OpenRouter key` : `${email} signed in to ${name} again`, from: email, login: id });
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
