import { addAbortListener } from 'node:events';
import { freemem } from 'node:os';
import { closeSync, existsSync, fstatSync, mkdirSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { agentsFile, closedBefore, createInstance, HttpError, instance, instanceDir, instances, labels, newId, openFile, seriesDir, type Entry, type Instance } from './store.ts';
import { pylib, startRun, type Run, type TurnEnd, type View } from './runner.ts';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { prepare, type Snapshot } from './indexes.ts';
import { act, canSee, changes, readJson, rfDir, tree, type Tree, writeJson } from './system.ts';
import { asPerson, can, users } from './auth.ts';
import { PRINT, websitesOf, type Browsers } from './browsers.ts';
import { builtInAllowed } from './sandbox.ts';
import { saveSeriesSettings, seriesSettings, type Authority } from './series.ts';
import { pushed, skills } from './skills.ts';
import { AGENT, commit, committed, forget } from './git.ts';
import { authority, logins, ownerOf, runnerAt, sameAuthority } from './logins.ts';
import { confirm } from './entra.ts';
import { pruneGrants } from './grants.ts';
import { abortCalls, connections, drainCalls, hasCalls, loginOf, types } from './connections.ts';
import { runWakeCheck } from './wake-check.ts';
import { binds, conversation, currentMessage, isPerson, openNotes, type Note } from './messages.ts';
import { appendMessage, messagesAt, noteEntries, syncNotes, visibleInstanceFiles } from './message-store.ts';

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
const full = () => !!draining || active.size + checking.size >= MAX_RUNS || (MIN_FREE > 0 && freemem() < MIN_FREE + started.filter(t => t > Date.now() - 60_000).length * 2 ** 30);
export const MAX_OPEN = 3;
const SPACING_MS = 15 * 60_000, MAX_WAKES = 20;

export type Active = { inst: Instance; n: number; runner: string; authority: Authority; token: string; view: View; workspace: string; run?: Run; sent: number; noted: number; seen: number; delivered: number; texts: Map<string, number>; done: boolean; cost: number; estimated: boolean; failed?: string; hosts: Map<string, boolean>; links: Map<string, { name: string; offer: string }>; browsers?: Browsers; timer?: NodeJS.Timeout; process: string; thread?: string;
  // Its Pi as it starts, and once its Pi, sandbox and browsers have stopped, after it ends; whether its stop was asked for, from when
  // its token opens nothing (server.ts running()).
  ready?: Promise<Run>; ended?: Promise<unknown>; stopped?: boolean; interrupted?: boolean; cut?: string };
export const active = new Map<string, Active>();
export const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();
const waiting = new Set<Instance>();
const retiring = new Set<Active>();

type Check = { id: string; wake: Wake; inst: Instance; authority: Authority; token: string; cancel: AbortController; signal?: AbortSignal; view?: View; indexes?: Snapshot; indexCut?: AbortController; ended?: Promise<void> };
const checking = new Map<string, Check>();
const busy = (series: string) => active.has(series) || checking.has(series);

function sees(i: Instance, t = tree()) {
  const r = ownerOf(i), owner = asPerson(r.by);
  return !!owner && !!r.consent && r.consent.by === r.by && r.consent.workspace === r.workspace && canSee(owner, t.workspaces[t.series[i.seriesId].workspace]);
}
// A run's Pi stopped, and its copies of indexes gone.
function end(token: string, run: Run | Promise<Run>) {
  return Promise.resolve(run).then(r => r.stop().catch(e => console.error('a run left its scratch folder', e)), () => {})
    .finally(() => rmSync(join(rfDir(), 'runs', token), { recursive: true, force: true }));
}

function seenBefore(inst: Instance): number {
  return Math.max((inst.log.findLast(e => e.op === 'done')?.seen as number | undefined) ?? 0, inst.copied);
}

const isOomRecovery = (e: Entry) => e.op === 'wake' && (e.recovery as { reason?: string } | undefined)?.reason === 'oom';

// Human acts carry the owner/epoch at append time; autonomous entries carry an immutable lease.
export type Standing = { word: 'runner' | 'answer' | 'note'; starts: boolean };
export function standing(inst: Instance, e: Entry, upto = inst.log.length): Standing | undefined {
  if (e.op !== 'wake' && !(['upload', 'comment', 'signoff', 'reject'].includes(e.op) && (isPerson(e) || e.note))) return undefined;
  if (inst.doc.status !== 'open') return e.note ? { word: 'note', starts: false } : undefined;
  const r = ownerOf(inst), line = inst.log.findLast(e => e.seq <= upto && e.op === 'authority')?.seq ?? 0;
  const epoch = e.authorityEpoch ?? (e.seq > inst.log.length ? r.epoch : undefined);
  const owner = (e.authorityOwner ?? (e.seq > inst.log.length ? r.by : runnerAt(inst.log, e.seq))) as string | undefined;
  const lease = e.authority as Authority | undefined;
  const stale = e.op === 'wake' ? !lease || !sameAuthority(inst, lease) : epoch !== r.epoch;
  if ((e.seq < line && e.seq <= readAt(inst, line)) || (stale && e.seq <= seenBefore(inst))) return undefined;
  const word = e.seq < line || e.note || e.informs || stale ? 'note'
    : e.op !== 'wake' ? binds(inst, e, owner, r)
    : lease && (e.recovery || e.initiator === lease.owner) && (!e.inst || instance(e.inst as string).seriesId === inst.seriesId) ? 'runner' : 'note';
  const valid = e.op === 'wake' ? !stale && (!(e.recovery || (e.schedule && !e.immediate)) || isOomRecovery(e) || (!!lease?.autonomous && !!r.consent?.autonomous))
    : epoch === r.epoch && owner === r.by;
  return { word, starts: !!r.by && !!r.consent && valid && !e.quiet && e.seq > Math.max(line, inst.copied) && (word !== 'note' || (e.op === 'wake' && !!e.schedule)) };
}
// Read history stays history across an authority boundary; unread instructions become notes.
function readAt(inst: Instance, line: number): number {
  const runs = inst.log.filter(e => e.seq < line && e.op === 'run').length;
  return Math.max(inst.copied, ...inst.log.filter(e => e.op === 'done' && (e.run as number) <= runs).map(e => (e.seen as number | undefined) ?? 0));
}
// A wake as it fires: its standing, which its entry keeps.
const woken = (inst: Instance, wake: Woken) => standing(inst, { seq: inst.log.length + 1, at: '', by: 'server', op: 'wake', ...wake })!;

export function pending(inst: Instance, seen: number, upto = inst.log.length): Entry[] {
  return inst.log.filter(e => e.seq > seen && e.seq <= upto && standing(inst, e, upto)?.starts);
}

// Whether an instance has something for a run: what came since its last run, or since an Interrupt or a failed or cut run, which
// waits for the next act; nothing while its series or its workspace is archived, which does no work until it's restored.
// A quiet archive interrupt cancels only the pending OOM wake before it, preserving any later owner comment across restore.
function stopped(inst: Instance): number {
  let cut = 0;
  for (let i = 0; i < inst.log.length; i++) {
    const e = inst.log[i];
    if (e.op === 'interrupt' && e.why === 'archived') {
      const w = inst.log.slice(0, i).findLast(isOomRecovery);
      if (w) cut = Math.max(cut, w.seq);
    } else if (e.op === 'interrupt' || (e.op === 'expired' && !e.run) || (e.op === 'done' && (e.aborted || e.error))) {
      cut = Math.max(cut, e.seq);
    }
  }
  return cut;
}
const due = (inst: Instance) => inst.doc.status === 'open' && pending(inst, Math.max(seenBefore(inst), stopped(inst))).length > 0
  && !archived(tree(), inst.seriesId);

// What a run is told of: people's acts, other instances' agents' notes, and the server's wakes, expired logins, uploads made items,
// renames and a run cut or failed; not the server's bookkeeping, such as a run's start, its hosts and screenshots, which the log keeps.
const told = (e: Entry) => isPerson(e) || !!e.note || ['wake', 'expired', 'point', 'rename'].includes(e.op) || (e.op === 'done' && (!!e.aborted || !!e.error));

export function seriesConversation(id: string, periods = instances(id), epoch = seriesSettings(seriesDir(id)).epoch) {
  return conversation(messagesAt(seriesDir(id)), periods, epoch);
}

// Messages describe the captured lease, never a later-expanded series ceiling.
export function message(inst: Instance, n: number, entries: Entry[], first = false, open: readonly Note[] = [], lease = (inst.log.find(e => e.op === 'run' && e.run === n)?.authority as Authority | undefined) ?? authority(inst), names: View['names'] = {}): string {
  const us = users(), who = (by: string) => `${us[by]?.name || by} <${by}>`;
  const by = lease.owner, ticked = lease.logins, set = [...wakesOf(inst.id), ...wakesOf(inst.seriesId)], sites = websitesOf(by);
  const offers = new Map(logins(by).flatMap(l => l.offers.map(o => [o.id, o.name])));
  const lent = (l: string) => l.startsWith('web:') && sites[l.slice(4)] ? `${l} at ${sites[l.slice(4)].url}` : offers.has(l) ? `${l} (${offers.get(l)})` : l;
  // The corrections on the instances before it, so an error isn't rolled forward.
  const fixed = !first ? [] : closedBefore(inst).flatMap(i => i.log.filter(e => e.op === 'correction').map(e => {
    const see = e.see as { inst: string; label: string; thread?: string } | undefined;
    const seeLabel = see && (() => {
      try {
        const s = instance(see.inst);
        if (s.hole) return see.label;
        return s.seriesId === inst.seriesId ? s.label : `${tree().series[s.seriesId]?.name ?? ''}/${s.label}`.replace(/^\//, '');
      } catch { return see.label; }
    })();
    return `${i.label}${e.item ? ` ${e.item}${e.ref ? `@${e.ref}` : ''}` : ''} is ${e.kind}, ${JSON.stringify(e.text)}${see ? `, see ${seeLabel}${see.thread ? ` ${see.thread}` : ''}` : ''}`;
  }));
  const from = (e: Note) => {
    if (e.by !== 'agent') return who(e.by);
    const see = e.see as { inst: string; label: string } | undefined;
    let label = see?.label ?? inst.label;
    if (see) {
      // Older notes can point at a deleted origin or a series since moved outside the recipient's reach.
      let origin: Instance | undefined;
      try { origin = instance(see.inst); } catch (err) { if (!(err instanceof HttpError) || err.status !== 404) throw err; }
      const t = tree();
      if (origin && !origin.hole && t.series[origin.seriesId]?.workspace === t.series[inst.seriesId].workspace) label = `${named(t, origin.seriesId)}/${origin.label}`;
    }
    return `the agent of ${label}, run ${e.run}, for ${who(e.runner as string)}`;
  };
  const paths = new Map(Object.entries(names).map(([path, id]) => [id, path]));
  // Bound synchronous I/O per prompt, including files that grow while being read. Filter the prompt, not the mounted log.
  let remaining = 64 * 1024 * 1024, chunk: Buffer | undefined;
  const files = (e: Entry) => visibleInstanceFiles(e, inst.id, id => id === inst.id || paths.has(id)).filter(f => {
    const { inst: id, path, sha256 } = typeof f === 'string' ? { inst: inst.id, path: f, sha256: undefined } : f;
    const fd = openFile(instanceDir(id), path);
    if (fd === undefined) return false;
    try {
      if (sha256 === undefined) return true;
      if (fstatSync(fd).size > remaining) return false;
      const hash = createHash('sha256'), buf = chunk ??= Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, remaining + 1), null);
        if (!n) return hash.digest('hex') === sha256.toLowerCase();
        remaining -= n;
        if (remaining < 0) return false;
        hash.update(buf.subarray(0, n));
      }
    } catch {
      return false;
    } finally { closeSync(fd); }
  });
  const asks = first ? inst.asking(by).filter(e => currentMessage(inst.log, e, { by, epoch: lease.epoch, workspace: lease.workspace })) : [];
  const series = open.filter(e => !e.anchor), here = open.filter(e => e.anchor);
  const owner = first ? asPerson(by) : null;
  return `Instance ${inst.label}, run ${n}.`
    + (first ? ` Its series owner and captured execution person is ${who(by)}, who lends you ${ticked.map(lent).join(', ') || 'no login'}. Approvals from an earlier authority epoch are history, not authorization for this owner.${lease.autonomous && owner && can(owner, 'wake-check') ? ' Your series owner has the wake-check capability.' : ''}` : '')
    + (first && set.length ? ` Pending wakes: ${set.map(k => `${k.id}, ${k.target === inst.id ? 'waking this instance' : `starting ${k.label}`} at ${k.at}${k.days ? `, then each ${k.days.join(', ')}` : ''}, from ${k.from}${woken(inst, k).word === 'runner' ? '' : ', a note'}${k.text ? `, saying ${JSON.stringify(k.text)}` : ''}${k.check ? `, check ${k.check}${k.deadline ? ` with deadline ${k.deadline}` : ''}` : ''}`).join('; ')}.` : '')
    + (fixed.length ? ` Corrections on earlier instances: ${fixed.join('; ')}.` : '')
    + (asks.length ? ` Pending ${asks.length === 1 ? 'reply' : 'replies'}: ${asks.map(e => `c${e.seq}, ${e.ask === 'proposal' ? 'proposal' : 'question'} for ${who((e.to as string | undefined) ?? by)}, ${JSON.stringify(e.text)}`).join('; ')}.` : '')
    + (series.length ? ` Open notes on the series: ${series.map(e => `n${e.seq}, from ${from(e)} at ${e.at}, ${JSON.stringify(e.text)}${(e.files as string[] | undefined)?.map(f => `, ../.notes/${f}`).join('') ?? ''}${e.request ? ' [request]' : ''}${e.proposal ? ' [proposal pending]' : ''}`).join('; ')}.` : '')
    + (here.length ? ` Open notes on this instance: ${here.map(e => `${e.id}, on ${e.anchor!.label}${e.anchor!.item ? ` ${e.anchor!.item}` : ''}${e.anchor!.ref ? `@${e.anchor!.ref}` : ''}, from ${from(e)} at ${e.at}, ${JSON.stringify(e.text)}${files(e).map(f => `, ${typeof f === 'string' ? f : f.inst === inst.id ? f.path : `${paths.get(f.inst)}/${f.path}`}`).join('')}${e.request ? ' [request]' : ''}${e.proposal ? ' [proposal pending]' : ''}`).join('; ')}.` : '')
    + ' New log entries:\n'
    + entries.filter(told).map(e => JSON.stringify({ ...e, ...(standing(inst, e)?.word === 'note' && { note: true }),
      ...(e.files && { files: files(e) }) })).join('\n');
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
export function view(inst: Instance, lease = authority(inst)): View {
  const t = tree(), at = (id: string) => `/work/${named(t, id)}`, series = [inst.seriesId, ...reach(t, inst.seriesId)];
  const names = Object.fromEntries(series.flatMap(id => instances(id).filter(i => !['abandoned', 'deleted'].includes(i.doc.status)).map(i => {
    i.syncLog();
    return [`${at(id)}/${i.label}`, i.id];
  })));
  const agents = [...new Set(series.map(id => t.series[id].workspace))].map(w => [agentsFile(w), `/work/${t.workspaces[w].name}/AGENTS.md`] as [string, string]);
  const noting = series.filter(id => !t.series[id].single || existsSync(join(seriesDir(id), 'notes'))).map(id => {
    const dir = seriesDir(id);
    syncNotes(dir);
    return [join(dir, 'notes'), `${at(id)}/.notes`] as [string, string];
  });
  return {
    instance: `${at(inst.seriesId)}/${inst.label}`, dir: inst.dir, pylib: join(inst.series(), '.pylib'),
    ro: [[agentsFile(), '/work/AGENTS.md'], ...agents, ...noting, ...Object.entries(names).map(([path, id]) => [instanceDir(id), path] as [string, string])],
    names, series: Object.fromEntries(series.map(id => [at(id), id])), env: Object.assign({}, ...connections().filter(c => lease.logins.some(o => o === loginOf(c).id || o.startsWith(`${loginOf(c).id}:`))).map(c => types[c.type].env?.(c, lease.logins))),
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
  const all = seriesConversation(a.inst.seriesId).notes, local = new Set(all.filter(e => e.anchor?.inst === a.inst.id).map(e => e.seq));
  const entries = a.inst.log.filter(e => e.seq > a.sent && (e.by !== 'agent' || e.note)), fresh = openNotes(all, a.inst.id).filter(e => e.seq > (e.anchor ? a.sent : a.noted));
  // What it is told of reaches it at once, notes too.
  if (!entries.some(told) && !fresh.length) return;
  const text = message(a.inst, a.n, entries.filter(e => !local.has(e.seq)), false, fresh, a.authority, a.view.names);
  a.sent = entries.at(-1)?.seq ?? a.sent;
  a.noted = fresh.findLast(e => !e.anchor)?.seq ?? a.noted;
  a.texts.set(text, a.sent);
  a.run!.steer(text).catch(err => !a.stopped && finishRun(a, true, String(err)));
}

// What a timer starts, as a kick's, logs what fails rather than ending the server.
const start = (inst: Instance, tried = new Set<Instance>()) => begin(inst, tried).catch(e => console.error(`a run of ${inst.id} failed to start`, e));

const runnable = (i: Instance) => due(i) && sees(i) && !held(i, 'entra', ownerOf(i).by);
function bail(inst: Instance, tried: Set<Instance>) {
  changes.emit('change', inst.id);
  if (stopping || busy(inst.seriesId)) return;
  const next = instances(inst.seriesId).find(i => !tried.has(i) && runnable(i));
  if (next) start(next, tried);
}

async function begin(inst: Instance, tried: Set<Instance>) {
  tried.add(inst);
  // No replacement writer starts until every old process and browser of this series has retired.
  await Promise.all([...retiring].filter(a => a.inst.seriesId === inst.seriesId).map(a => a.ended));
  await committed(inst.dir);
  const series = inst.seriesId;
  if ([...retiring].some(a => a.inst.seriesId === series)) return begin(inst, tried);
  const lastRun = inst.log.findLast(e => e.op === 'run');
  const seen = seenBefore(inst);
  // A kick that starts nothing ends the instance's queued state all the same: pages that showed it should hear.
  if (stopping || busy(series) || !due(inst)) return bail(inst, tried);
  if (full()) return void waiting.add(inst);
  // Confirmation may wait across transfers: recheck the captured epoch, not email equality.
  if (!sees(inst)) return bail(inst, tried);
  const cause = pending(inst, Math.max(seen, stopped(inst))).at(-1)!, lease = (cause.authority as Authority | undefined) ?? authority(inst);
  if (!sameAuthority(inst, lease)) return bail(inst, tried);
  const runner = lease.owner, initiator = cause.op === 'wake' ? cause.initiator : cause.by;
  if (held(inst, 'entra', runner)) return bail(inst, tried);
  try {
    await confirm(runner);
    pruneGrants();
  } catch (e) {
    const left = !!(e as { left?: boolean }).left && ownerOf(inst).by === runner;
    if (stopping || inst.doc.status !== 'open' || (!left && !due(inst))) return bail(inst, tried);
    if (!left && !sameAuthority(inst, lease)) return bail(inst, tried);
    if (!left && ([...retiring].some(a => a.inst.seriesId === series) || inst.log.findLast(e => e.op === 'run') !== lastRun || pending(inst, Math.max(seen, stopped(inst))).at(-1) !== cause)) return begin(inst, tried);
    if ((e as HttpError).status !== 401) {
      console.error(`a run of ${inst.id} waits a minute: Microsoft didn't confirm ${runner}'s sign-in`, e);
      return void setTimeout(() => kick(inst), 60_000).unref();
    }
    inst.append('server', 'expired', { cause: cause.seq, login: 'entra', name: 'rollforward', runner, authority: lease, initiator, error: (e as Error).message, ...((e as { left?: boolean }).left && { left: true }) });
    return bail(inst, tried);
  }
  if (stopping || busy(series) || !due(inst)) return bail(inst, tried);
  if (!sameAuthority(inst, lease)) return bail(inst, tried);
  if ([...retiring].some(a => a.inst.seriesId === series) || inst.log.findLast(e => e.op === 'run') !== lastRun || pending(inst, Math.max(seen, stopped(inst))).at(-1) !== cause) return begin(inst, tried);
  if (full()) return void waiting.add(inst);
  // Losing workspace visibility never chooses a replacement owner.
  if (!sees(inst)) return bail(inst, tried);
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && (e.by !== 'agent' || e.note)), left = seriesConversation(series).notes;
  const local = new Set(left.filter(e => e.anchor?.inst === inst.id).map(e => e.seq));
  const work = view(inst, lease);
  const text = message(inst, n, entries.filter(e => !local.has(e.seq)), true, openNotes(left, inst.id), lease, work.names);
  // Authority and carried code are captured before the process starts.
  // The versions live as its Pi starts, which it uses to its end.
  const live = skills().map(s => ({ ...s, dir: realpathSync(s.dir) }));
  const a: Active = {
    inst, n, runner: lease.owner, authority: lease, token: randomUUID(), view: work, workspace: lease.workspace,
    sent: entries.at(-1)!.seq, noted: left.findLast(e => !e.anchor)?.seq ?? 0, seen, delivered: seen, texts: new Map([[text, entries.at(-1)!.seq]]), done: false, cost: 0, estimated: false, hosts: new Map(), links: new Map(),
    process: processOf(inst), thread: pending(inst, seen)[0]?.thread as string | undefined,
  };
  active.set(series, a);
  byToken.set(a.token, a);
  let settled: Promise<TurnEnd>, loggedRun = false;
  try {
    // Whose OpenRouter key it starts with, its runner's own or the server's (connections.ts), never the key.
    const key = logins(lease.owner).some(l => l.id === 'openrouter' && l.enabled) ? 'own' : 'shared';
    const agents = Object.fromEntries(a.view.ro.filter(([p, at]) => at.endsWith('/AGENTS.md') && existsSync(p)).map(([p, at]) => [at, createHash('sha256').update(readFileSync(p)).digest('hex')]));
    inst.append('server', 'run', { run: n, runner: lease.owner, initiator, authority: lease, provenance: { cause: cause.seq, ...(cause.op === 'wake' && { from: cause.from, schedule: cause.schedule, inst: cause.inst, run: cause.sourceRun, recovery: cause.recovery }) }, agents, pylib: pylib(a.view.pylib, inst.dir), upto: a.sent, skills: Object.fromEntries(live.map(s => [s.id, pushed(s).version])), key });
    loggedRun = true;
    // Copies of the indexes of what its runner ticked, on the indexes' own disk, read-only at $RF_INDEX.
    const index = join(rfDir(), 'runs', a.token);
    mkdirSync(index, { recursive: true });
    if (prepare(inst, index, n)) {
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
  settled.then(({ aborted, error, oom }) => finishRun(a, aborted, error ?? a.failed, oom)).catch(e => console.error(`run ${n} of ${inst.id} failed to end`, e));
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

function revokeRun(a: Active) {
  a.stopped = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  a.browsers?.cut();
  abortCalls(a);
}

function canRetryOom(a: Active, priorSeen: number): boolean {
  if (!a.run || a.interrupted || a.cut || a.inst.doc.status !== 'open' || a.inst.closing) return false;
  const t = tree();
  if (archived(t, a.inst.seriesId) || !sees(a.inst, t) || !sameAuthority(a.inst, a.authority)) return false;
  if (a.browsers?.websites()) return false;
  const log = a.inst.log, runIdx = log.findLastIndex(e => e.op === 'run' && e.run === a.n);
  if (runIdx < 0) return false;
  if (log.slice(runIdx + 1).some(e => e.op === 'interrupt' || e.op === 'authority')) return false;
  if (held(a.inst, 'entra', a.runner) || log.some(e => e.op === 'expired' && typeof e.login === 'string' && held(a.inst, e.login, a.runner, e.login !== 'openrouter'))) return false;
  const authSeq = log.slice(0, runIdx).findLast(e => e.op === 'authority')?.seq ?? 0;
  const startFloor = Math.max(a.inst.copied, authSeq);
  const runInfo: { run: number; seq: number; idx: number; upto: number; done?: Entry; doneIdx: number }[] = [];
  const byRun = new Map<number, (typeof runInfo)[number]>();
  for (let i = startFloor; i < runIdx; i++) {
    const e = log[i];
    if (e.op === 'run') {
      const info = { run: e.run as number, seq: e.seq, idx: i, upto: typeof e.upto === 'number' ? e.upto : e.seq, done: undefined as Entry | undefined, doneIdx: -1 };
      runInfo.push(info);
      byRun.set(info.run, info);
    } else if (e.op === 'done') {
      const info = byRun.get(e.run as number);
      if (info && !info.done) { info.done = e; info.doneIdx = i; }
    }
  }
  let chainStart = startFloor;
  for (let k = runInfo.length - 1; k >= 0; k--) {
    const { done: d, doneIdx } = runInfo[k];
    if (!d) continue;
    if (!d.aborted && !d.error) { chainStart = d.seq; break; }
    const nextRunIdx = k + 1 < runInfo.length ? runInfo[k + 1].idx : runIdx;
    const between = log.slice(doneIdx + 1, nextRunIdx);
    const interrupted = between.findLast(e => e.op === 'interrupt');
    if (interrupted) { chainStart = interrupted.seq; break; }
    if (!between.some(w => w.op === 'wake' && !!w.recovery && !w.quiet)) { chainStart = d.seq; break; }
  }
  if (log.slice(chainStart).some(isOomRecovery)) return false;
  const chainRuns = new Set<number>([a.n]);
  for (const info of runInfo) {
    if (info.seq > chainStart) { chainRuns.add(info.run); continue; }
    if (info.done && !info.done.aborted && !info.done.error) continue;
    const endIdx = info.doneIdx >= 0 ? info.doneIdx : runIdx;
    if (info.upto > priorSeen || log.slice(info.idx + 1, endIdx).some(e => e.seq > priorSeen && (e.by !== 'agent' || !!e.note) && told(e))) chainRuns.add(info.run);
  }
  // Effects match by run number rather than seq because cross-instance said/corrected carry the target's seq.
  if (log.some(e => (e.op === 'expired' && e.run === a.n) || (chainRuns.has(e.run as number) && (
    ['send', 'delivered', 'said', 'corrected', 'browsers'].includes(e.op)
    || (e.op === 'browser' && e.site !== PRINT)
    || (e.op === 'egress' && e.allowed === true && !builtInAllowed(e.host as string))
  )))) return false;
  if (Object.keys(t.series).some(sid => noteEntries(seriesDir(sid)).some(e =>
    e.by === 'agent' && (e.see as { inst?: string } | undefined)?.inst === a.inst.id && chainRuns.has(e.run as number)))) return false;
  return true;
}

async function finishRun(a: Active, aborted: boolean, error?: string, oom = false) {
  if (a.done || stopping) return;
  const mayRetry = oom && !a.stopped && !a.interrupted && !a.cut;
  revokeRun(a);
  if (hasCalls(a)) await drainCalls(a);
  finish(a, aborted, error, oom, mayRetry);
}

export function commitSubject(n: number, error?: string): string {
  if (!error) return `Run ${n}`;
  const clean = error
    .replace(/\r?\n[\s\S]*/, '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return `Run ${n}: failed`;
  const prefix = `Run ${n}: `, max = 120 - prefix.length;
  return prefix + (clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean);
}

function finish(a: Active, aborted: boolean, error?: string, oom = false, allowOomRetry = oom): Entry | undefined {
  if (a.done || stopping) return;
  aborted ||= !!a.interrupted;
  a.done = true;
  revokeRun(a);
  const series = a.inst.seriesId;
  active.delete(series);
  const priorSeen = seenBefore(a.inst);
  const retryOom = allowOomRetry && canRetryOom(a, priorSeen);
  const closing = a.browsers?.end().catch(e => a.inst.append('server', 'browsers', { run: a.n, error: e.message }));
  // The rules it added to the process, or reworded, for the thread whose entry started it, where they were likely agreed.
  const added = rules(a.process, processMd(a.inst.dir) ?? a.process);
  const done = a.inst.append('server', 'done', {
    run: a.n, aborted, seen: retryOom ? priorSeen : a.seen, cost: +a.cost.toFixed(6), estimated: a.estimated,
    ...(error && { error }), ...(oom && { oom: true }), ...(added && { rules: added, thread: a.thread }),
  });
  if (retryOom) {
    const runEntry = a.inst.log.findLast(e => e.op === 'run' && e.run === a.n);
    a.inst.append('server', 'wake', {
      reason: `Run ${a.n} hit the memory limit and was killed by the kernel; retry with lower peak memory (stream or chunk large files/sheets instead of loading them whole).`,
      from: 'server', cause: done.seq, initiator: (runEntry?.initiator as string | undefined) ?? a.runner,
      authority: a.authority, recovery: { run: a.n, reason: 'oom' },
    });
  }
  // The run's changes are one commit, with the names.tsv they were written under, which the instance's next run and its other
  // commits wait for, once its browsers and sandbox have stopped.
  if (!a.run && !a.ready) rmSync(join(rfDir(), 'runs', a.token), { recursive: true, force: true });
  const stopped = !a.run && !a.ready ? undefined : end(a.token, a.run ?? a.ready!);
  const closed = Promise.all([closing, stopped]);
  const committed = commit(a.inst.dir, AGENT, commitSubject(a.n, error), closed).catch(e => a.inst.append('server', 'commit', { run: a.n, error: e.message }));
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
      : !sameAuthority(a.inst, a.authority) ? CUT.authority
      : Object.values(a.view.series).some(id => !reads.includes(id)) ? CUT.reach : undefined;
    if (why) cut(a, why);
  }
  if (checking.size) {
    const w = wakes();
    for (const c of checking.values()) {
      if (!currentCheck(c, w, t)) c.cancel.abort();
      else if (c.indexes && !c.indexes.valid()) c.indexCut?.abort();
    }
  }
}

// A run cut, its token first, so nothing more goes out, then its browsers and its sandbox; its instance carries on in a new run.
export async function interruptRun(a: Active) {
  a.interrupted = true;
  revokeRun(a);
  if (a.run) await Promise.race([a.run.interrupt(), new Promise(r => setTimeout(r, 1500))]);
  await finishRun(a, true);
  await a.ended;
}

export async function retireSeries(seriesId: string) {
  const runs = [...active.values()].filter(a => a.inst.seriesId === seriesId), check = checking.get(seriesId);
  check?.cancel.abort();
  for (const inst of instances(seriesId)) {
    clearTimeout(debounce.get(inst.id));
    debounce.delete(inst.id);
    waiting.delete(inst);
  }
  for (const a of runs) {
    a.interrupted = true;
    revokeRun(a);
  }
  await Promise.all([...runs.map(a => finishRun(a, true, CUT.authority)), check?.ended]);
  await Promise.all([...retiring].filter(a => a.inst.seriesId === seriesId).map(a => a.ended));
  await Promise.all(instances(seriesId).filter(i => !i.hole).map(i => committed(i.dir)));
}

function cut(a: Active, why: string) {
  if (a.done || stopping) return;
  a.cut ??= why;
  revokeRun(a);
  const after = () => {
    const done = finish(a, true, why);
    if (!done) return;
    if (a.authority.autonomous && ownerOf(a.inst).consent?.autonomous && sameAuthority(a.inst, a.authority)) {
      a.inst.append('server', 'wake', { reason: `Run ${a.n} was cut: ${why}; carry on`, from: 'server', cause: done.seq, initiator: a.runner, authority: a.authority, recovery: { run: a.n, reason: why } });
      kick(a.inst);
    }
  };
  if (!hasCalls(a)) return after();
  const draining = drainCalls(a).then(after);
  retiring.add(a);
  a.ended = draining.then(() => a.ended).finally(() => retiring.delete(a));
}

// Deleting an instance (store.ts markDeleted()) cuts a run going or queued for it, as a lease is cut, and any run whose view
// holds it, which carries on in a run of a view without it; its wakes go, and its series' one-off wakes for its label, or all of a
// task's. Requests to or from it go too. Once nothing runs in its folder, its last commit is done and its runs' browsers have logged what
// they did, it becomes a hole. `fields` says what it cost, as its runs ended.
export async function remove(inst: Instance, by: string, fields: () => Record<string, unknown>): Promise<Entry> {
  const t = tree(), task = !!t.series[inst.seriesId].single;
  inst.doc.status = 'deleted';
  clearTimeout(debounce.get(inst.id));
  debounce.delete(inst.id);
  waiting.delete(inst);
  const runs = [...active.values()].filter(a => a.inst === inst || Object.values(a.view.names).includes(inst.id));
  const checks = [...checking.values()].filter(c => c.inst === inst || c.view && Object.values(c.view.names).includes(inst.id));
  for (const c of checks) c.cancel.abort();
  for (const a of runs) {
    if (a.inst !== inst) a.cut ??= CUT.gone;
    revokeRun(a);
  }
  for (const a of runs) if (a.inst === inst && hasCalls(a)) await drainCalls(a);
  for (const a of runs) a.inst === inst ? finish(a, true, CUT.deleted) : cut(a, CUT.gone);
  const w = wakes();
  for (const [id, k] of Object.entries(w.pending)) if (k.target === inst.id || (k.target === inst.seriesId && (task || (k.label === inst.label && !k.days)))) delete w.pending[id];
  for (const [id, r] of Object.entries(w.requests)) if (r.inst === inst.id || r.target === inst.id
    || (r.series === inst.seriesId && (task || !r.target && r.label === inst.label))) delete w.requests[id];
  delete w.fired[inst.id];
  saveWakes(w);
  const commits = forget(inst.dir), deleted = inst.markDeleted(by, fields());
  act(by, { method: 'POST', path: `/api/instances/${inst.id}/delete`, deleted: `${named(t, inst.seriesId)}/${inst.label}` });
  await Promise.all([...[...retiring].filter(a => a.inst === inst || Object.values(a.view.names).includes(inst.id)).map(a => a.ended), ...checks.map(c => c.ended), commits]);
  inst.clear();
  return deleted;
}
changes.on('change', (id: string) => id === 'tree' && leases());
changes.on('index-removed', (owner: string, offer: string) => {
  for (const c of checking.values()) if (c.authority.owner === owner && c.indexes?.offers.includes(offer)) c.indexCut?.abort();
});

// A stop, as a restart's, cuts every run, its token first, so nothing more goes out, then its connections to its browsers, and
// starts none; each Pi goes on, for what it had sent to be answered, until the server is gone. No run ends meanwhile: the next
// start ends them as a restart cut them (recover()), and closes their browsers (browsers.ts reap()).
let stopping = false;
export function stop() {
  stopping = true;
  clearTimeout(draining);
  byToken.clear();
  for (const a of active.values()) revokeRun(a);
  active.clear();
  for (const c of checking.values()) c.cancel.abort();
}

// A second signal only renews its deadline. Drained, no run goes.
export function drain() {
  if (!DRAIN_MS) return;
  const was = draining;
  clearTimeout(draining);
  draining = setTimeout(() => { draining = undefined; changes.emit('change', 'tree'); startWaiting(); }, DRAIN_MS).unref();
  if (!was) changes.emit('change', 'tree');
}
export const drained = () => !!draining && !active.size && !retiring.size && !checking.size;
// The runs a drain waits for, or null with none.
export const updating = () => (draining ? new Set([...active.values(), ...retiring]).size + checking.size : null);

function startWaiting() {
  for (const i of waiting) {
    if (full()) break;
    waiting.delete(i);
    start(i);
  }
}

// Why an instance waits to run, if it does, and since when: the first of what its run would read.
export function queued(inst: Instance): { why: string; since: string } | undefined {
  const a = active.get(inst.seriesId), check = checking.get(inst.seriesId);
  if (a?.inst === inst || inst.doc.status !== 'open' || !(debounce.has(inst.id) || waiting.has(inst) || ((a || check) && due(inst)))) return;
  const why = check ? `its series is checking a scheduled wake for ${check.inst.label}` : debounce.has(inst.id) ? 'starting' : a ? `its series is running ${a.inst.label}` : draining ? 'an update waits for the runs going to finish' : active.size + checking.size >= MAX_RUNS ? `${MAX_RUNS} runs are going, the most RF_MAX_RUNS allows` : 'too little memory is free (RF_MIN_FREE_GB)';
  return { why, since: pending(inst, seenBefore(inst))[0]?.at ?? new Date().toISOString() };
}

// The owner's close continues later drafts. A <label>-r2 closing supersedes <label>, and <label>-r3 supersedes <label>-r2.
export function closed(inst: Instance, by: string, quiet?: boolean) {
  for (const later of instances(inst.seriesId).filter(i => i.doc.status === 'open' && i.label.localeCompare(inst.label, 'en', { numeric: true }) > 0)) {
    wakeWith(later, [{ from: by, text: `${inst.label} closed: its final figures may differ from the draft you read`, quiet }]);
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

// Schedules retain target authority and independent setter/source-run provenance.
// Unconsented or revoked schedules become requests, never execution as their clicker.
export type Wake = { target: string; at: string; from: string; immediate?: boolean; label?: string; inst?: string; sourceRun?: number; days?: string[]; text?: string; authority?: Authority; initiator?: string; check?: string; deadline?: string; deadlineTarget?: string };
export type Request = { series: string; label: string; from: string; at: string; inst?: string; text?: string; target?: string; message?: number };
type Wakes = { pending: Record<string, Wake>; fired: Record<string, string>; requests: Record<string, Request> };

// Keep the request scope in its pointer too: a tombstone can explain a missing row even after the canonical body has been purged.
export function wakes(): Wakes {
  const stored = readJson<Wakes>('wakes.json', { pending: {}, fired: {}, requests: {} });
  if (!stored?.requests || typeof stored.requests !== 'object' || Array.isArray(stored.requests)) throw new Error('invalid scheduler requests');
  let t: Tree | undefined;
  for (const [id, r] of Object.entries(stored.requests)) {
    if (!r || !/^[\w-]+$/.test(id) || Object.keys(r).some(k => !['series', 'label', 'target', 'inst', 'message'].includes(k)))
      throw new Error('invalid wake request reference');
    const { series, label, target, inst: source, message } = r;
    if (typeof series !== 'string' || !/^[\w-]+$/.test(series) || typeof label !== 'string' || !label
      || (target !== undefined && (typeof target !== 'string' || !/^[\w-]+$/.test(target)))
      || (source !== undefined && (typeof source !== 'string' || !/^[\w-]+$/.test(source)))
      || typeof message !== 'number' || !Number.isSafeInteger(message) || message <= 0) throw new Error(`invalid wake request reference ${id}`);
    const rows = messagesAt(seriesDir(series)), row = rows.find(m => m.id === message);
    if (row && (row.entry.op !== 'request' || row.entry.requestId !== id || row.anchor.instance !== target
      || row.entry.label !== label || row.entry.source !== source)) throw new Error(`invalid wake request reference ${id}`);
    if (rows.some(m => m.id > message && m.anchor.instance === target && m.entry.op === 'request-decision'
      && m.entry.requestId === id && m.entry.request === message)) {
      delete stored.requests[id];
    } else if (row) {
      const { from, at, text } = row.entry;
      Object.assign(r, { from, at, ...(text !== undefined && { text }) });
    } else {
      const book = (t ??= tree()).series[series];
      if (book) try {
        const to = target ? instance(target) : undefined, from = source ? instance(source) : undefined;
        if ((!to || to.seriesId === series) && (to?.hole || from?.hole
          || ((!to || book.single) && labels(series).some(l => (book.single || l.label === label) && instance(l.id).hole)))) {
          delete stored.requests[id];
          continue;
        }
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
      }
      throw new Error(`invalid wake request reference ${id}`);
    }
  }
  return stored;
}

function saveWakes(w: Wakes) {
  const requests = Object.create(null);
  for (const [id, r] of Object.entries(w.requests)) {
    const { from, at, text, series, target, label, inst: source } = r;
    let message = r.message;
    if (message === undefined) {
      // A recurring wake can outlive the instance that set it or a deleted slot. Do not recreate its request body.
      if ((source && instance(source).hole) || (target ? instance(target).hole : labels(series).some(l => l.label === label && instance(l.id).hole))) continue;
      const dir = seriesDir(series), recorded = messagesAt(dir).findLast(m => m.entry.op === 'request' && m.entry.requestId === id
        && m.entry.at === at && m.anchor.instance === target && m.entry.label === label && m.entry.source === source
        && m.entry.from === from && m.entry.text === text);
      message = recorded?.id ?? appendMessage(dir, target ? { instance: target } : {},
        { seq: 1, by: source ? 'agent' : from, op: 'request', requestId: id, at, from, label, ...(source && { source }), ...(text !== undefined && { text }) }).id;
    }
    requests[id] = { series, label, ...(source && { inst: source }), ...(target && { target }), message };
  }
  writeJson('wakes.json', { ...w, requests });
}
const byAt = (a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at);
export const wakesOf = (target: string, w = wakes()) => Object.entries(w.pending).filter(([, k]) => k.target === target)
  .map(([id, k]) => ({ id, ...k })).sort(byAt);
// Each target's pending wakes as wakesOf gives them, from one pass, for what lists many targets at once; a target's are sorted only
// once it's asked for, as with wakesOf, so a bad one fails only what asks for its target.
export function wakesByTarget(w = wakes()): (target: string) => (Wake & { id: string })[] {
  const by = new Map<string, (Wake & { id: string })[]>(), sorted = new Set<string>();
  for (const [id, k] of Object.entries(w.pending)) {
    const ks = by.get(k.target);
    if (ks) ks.push({ id, ...k });
    else by.set(k.target, [{ id, ...k }]);
  }
  return target => {
    const ks = by.get(target) ?? [];
    if (!sorted.has(target)) { ks.sort(byAt); sorted.add(target); }
    return [...ks];
  };
}

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
  const w = wakes(), t = tree(), sid = t.series[target] ? target : instance(target).seriesId, s = seriesSettings(seriesDir(sid));
  const p = s.owner && asPerson(s.owner), source = wake.inst ? active.get(instance(wake.inst).seriesId) : undefined;
  const immediate = !wake.inst && wake.from === s.owner && wake.at <= new Date().toISOString();
  const authorized = s.consent && (immediate || s.consent.autonomous) && s.consent.by === s.owner && s.consent.workspace === t.series[sid].workspace
    && p && canSee(p, t.workspaces[t.series[sid].workspace])
    && (wake.inst ? source?.inst.id === wake.inst && byToken.has(source.token) && source.runner === s.owner && source.authority.autonomous && sameAuthority(source.inst, source.authority) && ownerOf(source.inst).consent?.autonomous : wake.from === s.owner);
  if (wake.check && (!authorized || !s.consent?.autonomous || immediate || !can(p, 'wake-check') || (source && source.inst.seriesId !== sid)))
    throw new HttpError(403, 'a wake check needs a scheduled wake of your own series, autonomous consent, and the wake-check capability');
  const k: Wake = { ...wake, target, immediate: immediate || undefined, authority: authorized ? { version: 1, owner: s.owner!, epoch: s.epoch, workspace: t.series[sid].workspace, logins: s.consent!.logins.filter(o => !source || source.inst.seriesId !== sid || source.authority.logins.includes(o)), autonomous: s.consent!.autonomous } : undefined, initiator: authorized ? s.owner : undefined, ...(source && { sourceRun: source.n }) }, labelled = k.label !== undefined && !k.days;
  // A weekly one keeps its time of day; fire() spaces it.
  if (!k.days && !k.immediate) k.at = new Date(Math.min(k.deadline ? Date.parse(k.deadline) : Infinity, Math.max(Date.parse(k.at), Date.parse(w.fired[target] ?? '1970-01-01') + SPACING_MS))).toISOString();
  const [id = newId(), was] = Object.entries(w.pending).find(([, p]) => p.target === target && p.label === k.label
    && !!p.immediate === !!k.immediate && !!p.authority === !!k.authority && (k.authority ? p.authority!.owner === k.authority.owner && p.authority!.epoch === k.authority.epoch && p.authority!.workspace === k.authority.workspace && p.authority!.autonomous === k.authority.autonomous : p.from === k.from && p.inst === k.inst)
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

// Cancel pending OOM retries when archiving so restoring does not revive them, while leaving later owner comments intact.
export function cancelPendingOom(insts: Instance[], by: string) {
  for (const inst of insts) {
    if (inst.hole || inst.doc.status !== 'open') continue;
    const p = pending(inst, Math.max(seenBefore(inst), stopped(inst)));
    if (p.some(isOomRecovery)) {
      clearTimeout(debounce.get(inst.id));
      debounce.delete(inst.id);
      waiting.delete(inst);
      inst.append(by, 'interrupt', { quiet: true, why: 'archived' });
    }
  }
}

export function dropRequest(id: string, by: string, how: 'started' | 'dismissed'): Request {
  const w = wakes(), r = w.requests[id];
  if (!r) throw new HttpError(404, `no request ${id}`);
  appendMessage(seriesDir(r.series), r.target ? { instance: r.target } : {},
    { seq: 1, at: new Date().toISOString(), by, op: 'request-decision', requestId: id, request: r.message, how });
  delete w.requests[id];
  saveWakes(w);
  return r;
}

// Creation records its real actor; only an authorized wake can initiate execution.
export function startWith(seriesId: string, label: string, by: string, wakes: Woken[]): Instance {
  if (instances(seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances of ${tree().series[seriesId].name} are open: a new one waits until one closes`);
  return wakeWith(createInstance(seriesId, label, by), wakes);
}

// Wakes an instance, each wake logged with who set it and its text, a note unless it's the owner's word (standing()).
type Woken = { from: string; immediate?: boolean; text?: string; inst?: string; sourceRun?: number; quiet?: boolean; note?: boolean; authority?: Authority; initiator?: string; schedule?: string; check?: string };
export function wakeWith(inst: Instance, wakes: Woken[]): Instance {
  for (const wake of wakes) {
    const r = ownerOf(inst);
    const lease = wake.authority ?? (!wake.inst && wake.from === r.by && r.consent ? authority(inst) : undefined);
    const fields = { ...wake, authority: lease, initiator: lease?.owner };
    inst.append('server', 'wake', { ...fields, ...(woken(inst, fields).word === 'note' && { note: true }) });
  }
  if (wakes.some(w => !w.quiet)) kick(inst);
  return inst;
}

function advanceWake(w: Wakes, id: string, wake: Wake) {
  const { deadlineTarget, ...k } = wake;
  // A backstop never edits the weekly schedule's time or label, including if an older server reads it.
  if (deadlineTarget) { w.pending[id] = k; return; }
  delete w.pending[id];
  if (!k.days) return;
  const was = new Date(k.at), next = step(was, k.days, 1), date = dateIn(k.label);
  w.pending[id] = { ...k, immediate: undefined, ...(!k.authority?.autonomous && { authority: undefined, initiator: undefined }),
    at: next.toISOString(), ...(date && { label: k.label!.replace(date, ymd(date === ymd(was) ? next : was)) }) };
}

function scheduled(wake: Wake, id: string, from: string, text = wake.text): Woken {
  return { from, immediate: wake.immediate, text, inst: wake.inst, sourceRun: wake.sourceRun, authority: wake.authority, initiator: wake.initiator, schedule: id };
}

export function wakeCheckStatus(inst: Instance): { at: string; message: string } | undefined {
  const e = inst.log.findLast(e => ['wake-check', 'run', 'authority', 'duplicate'].includes(e.op));
  if (inst.doc.status === 'open' && e?.op === 'wake-check') return { at: e.at, message: e.message as string };
}

function currentCheck(c: Check, w = wakes(), t = tree()) {
  const { inst, authority: lease } = c, owner = asPerson(lease.owner);
  if (stopping || c.cancel.signal.aborted || inst.doc.status !== 'open' || inst.closing || !owner || !can(owner, 'wake-check')
    || !sameAuthority(inst, lease) || !ownerOf(inst).consent?.autonomous || archived(t, inst.seriesId)
    || JSON.stringify(w.pending[c.id]) !== JSON.stringify(c.wake) || (t.series[c.wake.target] && inst.label !== c.wake.label)) return false;
  const reachable = [inst.seriesId, ...reach(t, inst.seriesId)];
  return !c.view || Object.values(c.view.series).every(id => reachable.includes(id));
}

// Unlike a run's token, this opens only the two read-only routes in server.ts, never the proxy or a browser.
export function wakeCheckView(token: string) {
  const c = [...checking.values()].find(c => c.token === token);
  if (c?.view && !c.signal?.aborted && currentCheck(c) && (!c.indexes || c.indexes.valid())) return { inst: c.inst, view: c.view };
}

async function checkWake(c: Check, from: string) {
  const { inst, wake, id, token, authority: lease } = c, started = Date.now(), index = join(rfDir(), 'runs', token);
  const deadline = wake.deadline ? Date.parse(wake.deadline) : Infinity, expires = Math.min(deadline, started + 60_000);
  const indexCut = c.indexCut = new AbortController();
  const budget = AbortSignal.timeout(Math.max(1, expires - started)), signal = c.signal = AbortSignal.any([budget, c.cancel.signal, indexCut.signal]);
  const checkpoint = () => {
    signal.throwIfAborted();
    if (Date.now() >= expires || !currentCheck(c) || (c.indexes && !c.indexes.valid())) throw new HttpError(409, 'the check can no longer run');
  };
  let result: Awaited<ReturnType<typeof runWakeCheck>> | undefined, failure = '';
  try {
    // The wake stays pending until decided, including across a restart. A slow confirmation or cache copy cannot hold its budget.
    const aborted = Promise.withResolvers<never>(), listen = addAbortListener(signal, () => aborted.reject(signal.reason));
    let script: string | undefined;
    try {
      script = await Promise.race([(async () => {
        checkpoint();
        await confirm(lease.owner, checkpoint, signal);
        checkpoint();
        const v = c.view = view(inst, lease);
        const author = wake.inst && instance(wake.inst), before = closedBefore(inst).at(-1);
        let script: string | undefined;
        for (const i of [inst, author, before]) {
          if (!i || i.seriesId !== inst.seriesId) continue;
          const path = Object.keys(v.names).find(p => v.names[p] === i.id);
          if (!path) continue;
          const fd = openFile(i.dir, wake.check!);
          if (fd === undefined) continue;
          closeSync(fd);
          script = `${path}/${wake.check}`;
          break;
        }
        if (!script) { failure = 'script not found in working/'; return; }
        mkdirSync(index, { recursive: true });
        const indexes = await prepare(inst, index, lease, signal);
        checkpoint();
        if (indexes) {
          c.indexes = indexes;
          checkpoint();
          v.ro.push([index, '/index']);
          v.env.RF_INDEX = '/index';
        }
        return script;
      })(), aborted.promise]);
    } catch {
      failure = 'could not prepare the read-only check';
    } finally {
      listen[Symbol.dispose]();
    }
    if (script) {
      // Wait for the sandbox's exit, not merely for the abort, before allowing a normal run of this series.
      try { result = await runWakeCheck({ token, id: inst.id, view: c.view!, script, signal, checkpoint }); }
      catch (e) { failure = (e as Error).message; }
    }
    const w = wakes(), at = Date.now(), now = new Date(at).toISOString();
    if (!currentCheck(c, w)) return;
    const forced = at >= deadline || (budget.aborted && expires === deadline);
    if (budget.aborted || at >= expires) { result = undefined; failure = 'timed out'; }
    else if (indexCut.signal.aborted || (c.indexes && !c.indexes.valid())) { result = undefined; failure = 'index snapshot changed'; }
    advanceWake(w, id, wake);
    w.fired[wake.target] = now;
    if (!forced && result?.decision === 'stop') {
      if (wakeCheckStatus(inst)?.message !== result.message) inst.append('server', 'wake-check', {
        message: result.message, seconds: Math.round((Date.now() - started) / 1000), runner: lease.owner, from, schedule: id, check: wake.check,
      });
      const next = w.pending[id];
      if (wake.deadline) {
        if (!next) w.pending[id] = { ...wake, at: wake.deadline };
        else if (next.at > wake.deadline) next.deadlineTarget = inst.id;
      }
    } else {
      const text = forced ? wake.text : failure ? `wake check failed: ${failure}` : result?.message;
      wakeWith(inst, [{ ...scheduled(wake, id, from, text), ...(!forced && { check: wake.check, note: true }) }]);
    }
    saveWakes(w);
  } finally {
    checking.delete(inst.seriesId);
    rmSync(index, { recursive: true, force: true });
    if (!stopping) {
      bail(inst, new Set());
      startWaiting();
      if (draining) changes.emit('change', 'tree');
    }
  }
}

export function fire() {
  if (stopping) return;
  startWaiting();
  const w = wakes(), now = new Date().toISOString(), t = tree();
  const ready = Object.entries(w.pending).map(([id, wake]) => ({ id, wake, at: wake.deadlineTarget ? wake.deadline! : wake.at }))
    .filter(k => k.at <= now).sort((a, b) => a.at.localeCompare(b.at));
  let changed = false;
  for (const { id, wake } of ready) {
    const { days } = wake, target = wake.deadlineTarget ?? wake.target, label = wake.deadlineTarget ? undefined : wake.label;
    const deadline = !!wake.deadline && wake.deadline <= now, backstop = deadline && (wake.deadlineTarget || wake.at <= wake.deadline!);
    if (!wake.immediate && !backstop && Date.parse(w.fired[target] ?? '1970-01-01') + SPACING_MS > Date.parse(now)) continue;
    // One a person set goes only while they may see its workspace, and a run's while its instance lives in the same workspace.
    const targetSeries = t.series[target] ? target : instance(target).seriesId, wsId = t.series[targetSeries].workspace, ws = t.workspaces[wsId];
    if (checking.get(targetSeries)?.id === id) continue;
    if (wake.inst) {
      let src: Instance | undefined;
      try { src = instance(wake.inst); } catch {}
      if (!src || t.series[src.seriesId]?.workspace !== wsId) {
        delete w.pending[id];
        changed = true;
        console.log(`a wake for ${named(t, targetSeries)} went unfired, as the instance that set it is in another workspace`);
        continue;
      }
    }
    const setter = asPerson(wake.from);
    if (!wake.inst && wake.from.includes('@') && !(setter && canSee(setter, ws))) {
      delete w.pending[id];
      changed = true;
      console.log(`a wake ${wake.from} set went unfired, as they can no longer see ${ws.name}`);
      continue;
    }
    const s = seriesSettings(seriesDir(targetSeries)), lease = wake.authority, owner = s.owner && asPerson(s.owner);
    const authorized = !!lease && (lease.autonomous ? !!s.consent?.autonomous : wake.immediate && !wake.inst && wake.from === s.owner) && wake.initiator === lease.owner && s.owner === lease.owner && s.epoch === lease.epoch && wsId === lease.workspace
      && !!s.consent && s.consent.by === s.owner && s.consent.workspace === wsId && lease.logins.every(o => s.consent!.logins.includes(o))
      && !!owner && canSee(owner, ws);
    if (!authorized) {
      advanceWake(w, id, wake);
      changed = true;
      w.requests[days ? newId() : id] = { series: targetSeries, label: label ?? instance(target).label, ...(!t.series[target] && { target }), from: wake.from, at: now, ...(wake.inst && { inst: wake.inst }), ...(wake.text && { text: wake.text }) };
      continue;
    }
    // Where the run that set it is now, though it was renamed or moved since.
    const from = wake.inst ? `${named(t, instance(wake.inst).seriesId)}/${instance(wake.inst).label}` : wake.from;
    const known = t.series[target] ? labels(target).find(l => l.label === label)?.id : target, inst = known ? instance(known) : undefined;
    const canStart = inst ? inst.doc.status === 'open' : instances(target).filter(i => i.doc.status === 'open').length < MAX_OPEN;
    if (canStart && wake.check && !deadline && !wake.immediate && can(owner, 'wake-check') && (!inst || active.get(targetSeries)?.inst !== inst && !due(inst))) {
      if (busy(targetSeries) || full() || [...retiring].some(a => a.inst.seriesId === targetSeries) || inst?.closing) continue;
      const to = inst ?? createInstance(target, label!, wake.inst ? 'agent' : wake.from);
      const c: Check = { id, wake, inst: to, authority: lease, token: randomUUID(), cancel: new AbortController() };
      checking.set(targetSeries, c);
      c.ended = checkWake(c, from).catch(e => console.error(`a wake check for ${to.id} failed to settle`, e));
      continue;
    }
    advanceWake(w, id, wake);
    changed = true;
    w.fired[target] = now;
    if (!canStart) {
      if (inst) console.log(`a wake found ${named(t, inst.seriesId)}/${inst.label} ${inst.doc.status}, so it woke nothing`);
      else w.requests[newId()] = { series: target, label: label!, from, at: now, ...(wake.inst && { inst: wake.inst }), ...(wake.text && { text: wake.text }) };
    } else if (inst) wakeWith(inst, [scheduled(wake, id, from)]);
    else startWith(target, label!, wake.inst ? 'agent' : wake.from, [scheduled(wake, id, from)]);
  }
  if (changed) saveWakes(w);
}

// Why a run was cut, its done's error, which `rf runs` tells from a failure: a restart, or a change that broke its lease (leases()).
// Either way its instance is woken to carry on.
export const CUT = { restart: 'a restart cut the run', authority: 'its series authority ended', moved: 'its series moved', runner: 'its series owner can no longer execute it', reach: 'its reach narrowed', deleted: 'its instance was deleted', gone: 'an instance in its reach was deleted' };

// Recovery accounts for the captured executor and resumes only a still-valid captured authority.
// No git runs at startup, so interrupted commit locks can be removed.
export function recover() {
  // A deletion a restart cut is done: what's left of its folder goes.
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => i.hole)) inst.clear();
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => !i.hole)) {
    for (const f of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'packed-refs.new', 'gc.pid', 'refs/heads/main.lock']) rmSync(join(inst.dir, '.git', f), { force: true });
    if (inst.doc.status !== 'open') continue;
    const run = inst.log.findLast(e => e.op === 'run' || e.op === 'done');
    if (run?.op === 'run') {
      const calls = inst.log.filter(e => e.op === 'call' && e.run === run.run);
      const cost = calls.reduce((t, e) => t + ((e.cost as number | undefined) ?? 0), 0);
      const estimated = calls.some(e => e.estimated === true);
      const done = inst.append('server', 'done', { run: run.run, aborted: true, seen: seenBefore(inst), cost: +cost.toFixed(6), estimated, error: CUT.restart });
      const held = Math.max(inst.log.findLast(e => e.op === 'authority')?.seq ?? 0, inst.log.findLast(e => e.op === 'interrupt')?.seq ?? 0);
      const lease = run.authority as Authority | undefined;
      if (lease?.autonomous && ownerOf(inst).consent?.autonomous && sameAuthority(inst, lease) && (held < run.seq || pending(inst, held).length)) inst.append('server', 'wake', { reason: `A restart cut run ${run.run}; carry on`, from: 'server', cause: done.seq, initiator: run.initiator, authority: lease, recovery: { run: run.run, reason: CUT.restart } });
      commit(inst.dir, AGENT, `Run ${run.run}: ${CUT.restart}`).catch(e => inst.append('server', 'commit', { run: run.run, error: e.message }));
    }
    kick(inst);
  }
}

// Whether a login of `who`'s that expired holds an instance's runs: the instance is open and theirs, a run of theirs met it since
// the last assign, they haven't unticked or stopped using it since, and no sign-in woke it since.
export function held(inst: Instance, login: string, who: string, ticked = true): boolean {
  const r = ownerOf(inst);
  if (inst.doc.status !== 'open' || r.by !== who) return false;
  if (ticked && !['entra', 'openrouter'].includes(login) && !r.logins.some(t => t === login || t.startsWith(`${login}:`))) return false;
  if (ticked && login === 'openrouter' && !logins(who).find(l => l.id === 'openrouter')?.enabled) return false;
  const hit = inst.log.findLast(e => e.op === 'expired' && !e.left && e.login === login && e.runner === who);
  const run = hit?.run && inst.log.find(e => e.op === 'run' && e.run === hit.run), lease = (hit?.authority ?? (run && run.authority)) as Authority | undefined;
  return !!hit && !!lease && sameAuthority(inst, lease) && !inst.log.some(e => e.seq > hit.seq && ((e.op === 'wake' && e.login === login) || standing(inst, e)?.starts));
}

// An open instance whose run met its runner's expired login carries on when they sign in to it again, or stop using an expired key.
changes.on('login', (email: string, id: string, name: string) => {
  for (const sid of Object.keys(tree().series)) for (const inst of instances(sid).filter(i => i.doc.status === 'open' && ownerOf(i).by === email)) {
    if (!held(inst, id, email, id !== 'openrouter')) continue;
    const hit = inst.log.findLast(e => e.op === 'expired' && !e.left && e.login === id && e.runner === email)!, run = inst.log.find(e => e.op === 'run' && e.run === hit.run);
    const lease = (hit.authority ?? run?.authority) as Authority;
    const autonomous = !!lease.autonomous && !!ownerOf(inst).consent?.autonomous;
    inst.append('server', 'wake', { ...(!autonomous && { quiet: true }), reason: id === 'openrouter' && !logins(email).find(l => l.id === 'openrouter')?.enabled ? `${email} stopped using their OpenRouter key` : `${email} signed in to ${name} again`, from: email, login: id, authority: hit.authority ?? run!.authority, initiator: hit.initiator ?? run!.initiator, recovery: { run: run?.run, login: id } });
    if (autonomous) kick(inst);
  }
});

export function startWaking() {
  recover();
  fire();
  setInterval(fire, Number(process.env.RF_WAKE_TICK_MS ?? 60_000)).unref();
}

// A folder as a run sees it from its instance's, by the names it started with: an instance, such as . for its own, ../<label> or
// ../../<series>/<label>, or a series, such as .., ../../<series> or ../../../<workspace>/<series>; answered by id.
export function resolveFor(a: { view: View }, folder: string): string {
  const path = posix.normalize(posix.join(a.view.instance, folder)), id = a.view.series[path] ?? a.view.names[path];
  if (id) return id;
  if (a.view.series[posix.dirname(path)]) throw new HttpError(404, `no instance ${posix.basename(path)} in ${posix.basename(posix.dirname(path))}`);
  throw new HttpError(404, `no series you can read at ${folder}`);
}
