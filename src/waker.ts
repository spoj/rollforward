import { freemem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { createInstance, guidanceFile, HttpError, instance, instanceDir, instances, isPerson, labels, newId, seriesDir, type Entry, type Instance } from './store.ts';
import { startRun, type Run, type View } from './runner.ts';
import { canSee, changes, everyone, readJson, tree, type Tree, writeJson } from './system.ts';
import { users } from './auth.ts';
import type { Machines } from './machines.ts';
import { skillsText } from './agent-api.ts';
import { seriesSettings } from './series.ts';
import { pushed, skill } from './skills.ts';

// What runs when: one run at a time per series, at most RF_MAX_RUNS at once, started by people's acts and by wakes.
const LIMIT_MS = Number(process.env.RF_LIMIT_MIN ?? 120) * 60_000;
const MAX_RUNS = Number(process.env.RF_MAX_RUNS ?? 20);
// Memory binds first: no run starts while less than RF_MIN_FREE_GB is free; waiting ones start as runs end, or at the next tick.
const MIN_FREE = Number(process.env.RF_MIN_FREE_GB ?? 6) * 2 ** 30;
const full = () => active.size >= MAX_RUNS || freemem() < MIN_FREE;
export const MAX_OPEN = 3;
const SPACING_MS = 15 * 60_000;

export type Active = { inst: Instance; n: number; token: string; view: View; run?: Run; sent: number; seen: number; texts: Map<string, number>; interrupted: boolean; done: boolean; cost: number; said: string; hosts: Set<string>; machines?: Machines; timer?: NodeJS.Timeout };
export const active = new Map<string, Active>();
export const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();
const waiting = new Set<Instance>();

function seenBefore(inst: Instance): number {
  return (inst.log.findLast(e => e.op === 'done')?.seen as number | undefined) ?? 0;
}

function pending(inst: Instance, seen: number): Entry[] {
  return inst.log.filter(e => e.seq > seen && (e.op === 'wake' || (isPerson(e) && (['upload', 'answer', 'comment'].includes(e.op) || (e.op === 'create' && e.fetch)))));
}

function message(inst: Instance, n: number, entries: Entry[]): string {
  const t = tree(), here = t.series[inst.seriesId].workspace;
  const reads = reach(t, inst.seriesId).map(id => (t.series[id].workspace === here ? `../${t.series[id].name}/` : `../../${named(t, id)}/`)).join(', ');
  const uses = seriesSettings(inst.series()).skills.length ? skillsText(inst.series()).split('\n').join('; ') : '';
  return `Instance ${inst.label} (folder ${inst.label}/)${t.series[inst.seriesId].adhoc ? ", a one-off ask in the workspace's Ad hoc series" : ''}, run ${n}.${reads ? ` Series you can read: ${reads}.` : ''}${uses ? ` Skills you can use: ${uses}.` : ''} New log entries:\n`
    + entries.map(e => JSON.stringify(e)).join('\n');
}

// What a series' agent may read: the other series of its workspace, and those of any workspace that has everyone this one has, by
// the same email or group, so nothing it reads reaches someone who couldn't see it already. A workspace with no one in it reads only
// itself.
export function reach(t: Tree, seriesId: string): string[] {
  const ws = t.series[seriesId].workspace, people = everyone(t.workspaces[ws]);
  const reads = (o: string) => o === ws || (people.length > 0 && people.every(p => everyone(t.workspaces[o]).includes(p)));
  return Object.keys(t.series).filter(id => id !== seriesId && reads(t.series[id].workspace)).sort((a, b) => named(t, a).localeCompare(named(t, b)));
}

export const named = (t: Tree, seriesId: string) => `${t.workspaces[t.series[seriesId].workspace].name}/${t.series[seriesId].name}`;

// The run's view of the data, by name, built when it starts: /work/<workspace>/<series>/<label>/ for every instance in its reach,
// the company's guidance at /work/GUIDANCE.md and each workspace's at /work/<workspace>/GUIDANCE.md, and the catalogue.
function view(inst: Instance): View {
  const t = tree(), at = (id: string) => `/work/${named(t, id)}`, series = [inst.seriesId, ...reach(t, inst.seriesId)];
  const ro = series.flatMap(id => [
    ...labels(id).map(l => [instanceDir(l.id), `${at(id)}/${l.label}`] as [string, string]),
    ...(id === inst.seriesId ? [] : [[join(seriesDir(id), '.pylib'), `${at(id)}/.pylib`] as [string, string]]),
  ]);
  const guidance = [...new Set(series.map(id => t.series[id].workspace))].map(w => [guidanceFile(w), `/work/${t.workspaces[w].name}/GUIDANCE.md`] as [string, string]);
  const catalogue = `# What you can read\n\nOne line per series, from its latest closed instance: what it delivers (its process.md's first line), its inputs and where they come from, who brings files and who answers, and its open instances, which are drafts.\n\n${series.map(id => line(t, id, at(inst.seriesId))).join('\n')}\n`;
  return { cwd: at(inst.seriesId), instance: `${at(inst.seriesId)}/${inst.label}`, dir: inst.dir, pylib: join(inst.series(), '.pylib'), ro: [[guidanceFile(), '/work/GUIDANCE.md'], ...guidance, ...ro], catalogue };
}

function line(t: Tree, id: string, cwd: string): string {
  const all = instances(id), last = all.filter(i => i.doc.status === 'closed').sort((a, b) => a.closedAt().localeCompare(b.closedAt())).at(-1);
  const process = last && join(last.dir, 'working', 'process.md');
  const purpose = process && existsSync(process) ? readFileSync(process, 'utf8').split('\n').map(l => l.replace(/^[#\s]+/, '').trim()).find(Boolean) : undefined;
  const inputs = last?.doc.items.filter(i => i.kind === 'input').map(i => `${i.name} (${i.source ?? (i.file?.startsWith('upload/') ? 'uploaded' : 'fetched')})`) ?? [];
  const who = (op: string) => [...new Set(last?.log.filter(e => e.op === op && isPerson(e)).map(e => e.by))];
  const open = all.filter(i => i.doc.status === 'open').map(i => i.label);
  return `- ${relative(cwd, `/work/${named(t, id)}`) || '.'}: ${purpose ?? 'no process.md yet'}. `
    + (last ? `Latest closed: ${last.label}. Inputs: ${inputs.join('; ') || 'none'}. Brings files: ${who('upload').join(', ') || 'nobody'}; answers: ${who('answer').join(', ') || 'nobody'}.` : 'Nothing closed yet.')
    + (open.length ? ` Open: ${open.join(', ')}.` : '');
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
  if (active.has(series) || inst.doc.status !== 'open' || !pending(inst, seen).length) return;
  if (full()) return void waiting.add(inst);
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && e.by !== 'agent');
  const text = message(inst, n, entries);
  const a: Active = { inst, n, token: randomUUID(), view: view(inst), sent: entries.at(-1)!.seq, seen, texts: new Map([[text, entries.at(-1)!.seq]]), interrupted: false, done: false, cost: 0, said: '', hosts: new Set() };
  active.set(series, a);
  byToken.set(a.token, a);
  const chosen = seriesSettings(inst.series()).skills.filter(id => skill(id));
  inst.append('server', 'run', { run: n, upto: a.sent, skills: Object.fromEntries(chosen.map(id => [id, pushed(skill(id)!).version])) });
  try {
    a.run = await startRun({
      token: a.token, view: a.view,
      message: text, skills: chosen,
      onEvent: e => {
        if (e.type === 'message_end' || e.type === 'tool_execution_end') changes.emit('change', inst.id); // Advanced shows the run as it goes
        if (e.type === 'message_end' && e.message.role === 'assistant') {
          a.cost += e.message.usage.cost.total;
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
  a.machines?.close().catch(e => a.inst.append('server', 'machines', { run: a.n, error: e.message }));
  // The agent's last words in a run are its report to the instance's people; its first line is the run's summary.
  if (a.said && !aborted) a.inst.append('agent', 'report', { run: a.n, text: a.said });
  a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(4), summary: a.said && !aborted ? summaryOf(a.said) : null, ...(error && { error }) });
  if (a.run) { // one that never started, as with a missing API key, waits for the next act rather than retrying at once
    const next = !a.interrupted && pending(a.inst, a.seen).length ? a.inst
      : instances(series).find(i => i.doc.status === 'open' && !(a.interrupted && i === a.inst) && pending(i, seenBefore(i)).length);
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

export function queued(inst: Instance): boolean {
  const a = active.get(inst.seriesId);
  return a?.inst !== inst && inst.doc.status === 'open' && (debounce.has(inst.id) || waiting.has(inst) || (!!a && pending(inst, seenBefore(inst)).length > 0));
}

// Closing an instance wakes its series' later open instances, which may have used its draft.
export function closed(inst: Instance) {
  for (const later of instances(inst.seriesId).filter(i => i.doc.status === 'open' && i.label.localeCompare(inst.label, 'en', { numeric: true }) > 0)) {
    later.append('server', 'wake', { reason: `${inst.label} closed: its final figures may differ from the draft you read`, from: inst.label });
    kick(later);
  }
}

// Wakes (.rf/wakes.json): at most one pending per target, an instance or a series by id, fired by the clock at least 15 minutes after
// the target's last, and the requests to start an instance that a series without Allow wakes, or with 3 open, got instead.
export type Wake = { at: string; reason: string; from: string; label?: string };
export type Request = { series: string; label: string; reason: string; from: string; at: string };
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

// Starts an instance of a series for a wake or a request, run by `by` with the logins they ticked, the reason its first entry.
export function startWith(seriesId: string, label: string, by: string, logins: string[], wake: { reason: string; from: string }): Instance {
  if (instances(seriesId).filter(i => i.doc.status === 'open').length >= MAX_OPEN) throw new HttpError(409, `${MAX_OPEN} instances are open; close one first`);
  const inst = createInstance(seriesId, label, by, logins);
  inst.append('server', 'wake', wake);
  kick(inst);
  return inst;
}

function fire() {
  startWaiting();
  const w = wakes(), now = new Date().toISOString(), t = tree();
  for (const [target, wake] of Object.entries(w.pending).filter(([, k]) => k.at <= now)) {
    delete w.pending[target];
    w.fired[target] = now;
    if (!t.series[target]) {
      const inst = instance(target);
      if (inst.doc.status !== 'open') continue;
      inst.append('server', 'wake', { reason: wake.reason, from: wake.from });
      kick(inst);
      continue;
    }
    const allow = seriesSettings(seriesDir(target)).wakes, u = allow && users()[allow.by];
    const runs = u && !u.disabled && canSee({ email: allow.by, role: u.role, groups: u.groups ?? [] }, t.workspaces[t.series[target].workspace]);
    try {
      if (!runs) throw new Error('no Allow wakes');
      startWith(target, wake.label!, allow.by, allow.logins, { reason: wake.reason, from: wake.from });
    } catch {
      w.requests[newId()] = { series: target, label: wake.label!, reason: wake.reason, from: wake.from, at: now };
    }
  }
  saveWakes(w);
}

// The ops log's line for a run: the report's first line, plain, or its first sentence when that line runs long.
function summaryOf(report: string): string {
  const line = report.split('\n')[0].replace(/\*+|^#+/g, '').trim();
  return (line.length > 200 ? line.split(/(?<=[.!?])\s/)[0] : line).slice(0, 200);
}

// A run a restart cut ends as aborted, and its instance is woken to carry on, so a deploy needn't wait for quiet.
export function recover() {
  for (const id of Object.keys(tree().series)) for (const inst of instances(id).filter(i => i.doc.status === 'open')) {
    const run = inst.log.findLast(e => e.op === 'run' || e.op === 'done');
    if (run?.op !== 'run') continue;
    inst.append('server', 'done', { run: run.run, aborted: true, seen: seenBefore(inst), cost: 0, summary: null, error: 'a restart cut the run' });
    inst.append('server', 'wake', { reason: 'A restart cut your last run; carry on', from: 'server' });
    kick(inst);
  }
}

export function startWaking() {
  recover();
  fire();
  setInterval(fire, Number(process.env.RF_WAKE_TICK_MS ?? 60_000)).unref();
}

// rf wake TARGET AT REASON [--label LABEL], TARGET being a folder as the run sees it: an instance, such as its own label or
// ../<series>/<label>, which the wake continues; or a series, such as . or ../<series> or ../../<workspace>/<series>, which it starts
// a new instance of, labelled LABEL. It reaches only what the run can read.
export function wakeFrom(a: Active, args: string[]): string {
  const i = args.indexOf('--label'), label = i >= 0 ? args[i + 1] : undefined, [target, at, ...why] = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  const usage = 'rf wake TARGET AT REASON [--label LABEL]: TARGET an instance folder or a series folder, AT now, +<n>m|h|d or a date and time such as 2026-09-14T07:00+08:00';
  if (!target || !at || !why.length) throw new HttpError(400, usage);
  const when = at === 'now' ? Date.now() : at.startsWith('+') ? Date.now() + Number(at.slice(1, -1)) * ({ m: 60e3, h: 3600e3, d: 86400e3 }[at.at(-1)!] ?? NaN) : Date.parse(at);
  if (Number.isNaN(when)) throw new HttpError(400, usage);
  const t = tree(), full = posix.normalize(posix.join(a.view.cwd, target)).split('/'), path = full.slice(2);
  const sid = Object.keys(t.series).find(id => t.series[id].name === path[1] && t.workspaces[t.series[id].workspace].name === path[0]);
  if (full[1] !== 'work' || path.length < 2 || path.length > 3 || !sid || (sid !== a.inst.seriesId && !reach(t, a.inst.seriesId).includes(sid))) throw new HttpError(404, `no series you can read at ${target}`);
  const from = `${named(t, a.inst.seriesId)}/${a.inst.label}`, reason = why.join(' ');
  if (path.length === 2) {
    if (!label) throw new HttpError(400, `waking a series starts a new instance: name it with --label`);
    return `set: ${target} starts ${label} at ${setWake(sid, { at: new Date(when).toISOString(), reason, from, label }).at}`;
  }
  const id = labels(sid).find(l => l.label === path[2])?.id;
  if (!id) throw new HttpError(404, `no instance ${path[2]} in ${t.series[sid].name}`);
  if (instance(id).doc.status !== 'open') throw new HttpError(409, `${path[2]} is ${instance(id).doc.status}: to correct it, wake its series with --label ${path[2]}-r2`);
  return `set: ${target} wakes at ${setWake(id, { at: new Date(when).toISOString(), reason, from }).at}`;
}
