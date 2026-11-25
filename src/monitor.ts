import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { HttpError } from './store.ts';

const runFile = promisify(execFile);

// The system monitor, admins' alone, which rf top and rf kill show (docs/system.md, Watching over it): the runs going, each with the processes its sandbox holds and what
// they use, the busiest of all of them by CPU and by memory, and the host's load, as /proc tells, which only Linux has; and an
// admin's kill of a process there, never one of the sandbox's own.

// Linux counts a process's CPU time in USER_HZ, a hundredth of a second on every architecture it runs on.
const HZ = 100;
// CPU use is what a second's sample saw; each list holds the ten busiest; a kill gives SIGTERM five seconds, then SIGKILL.
const SAMPLE_MS = 1000, TOP = 10, GRACE_MS = 5000, KILLED_MS = 1000, POLL_MS = 100;
// A command line shows at most this many characters.
const SHOWN = 300;
const MASK = '***';
export const INLINE = '(inline)';
// The bridge to the server's socket that bin/sandbox/node starts beside Pi, the sandbox's own as Pi is.
const BRIDGE = 'UNIX-CONNECT:/run/rf/rf.sock';
const PROC = '/proc';

// A run going, by its sandbox's bwrap, from which every process of the run descends, as a pid namespace keeps them.
export type Sandbox = { pid: number; instance: string; path: string; run: number; runner: string; since: string; token: string };
// A process by its stat: its CPU time so far in USER_HZ, and its start, in USER_HZ since the host booted, which tells it from a
// process that takes its PID after it.
type Stat = { pid: number; ppid: number; state: string; nice: number; ticks: number; start: number; comm: string };
// A process of a run as the monitor shows it: its CPU over the sample, in % of a core, its resident memory in bytes, and its age in
// seconds; what it runs and its command line, masked; and whether it's the run's own, which only stopping the run ends.
export type Proc = { pid: number; start: number; nice: number; cpu: number; rss: number; age: number; script: string; command: string; own: boolean; instance: string; path: string; run: number };
export type RunUse = { instance: string; path: string; run: number; runner: string; since: string; pid: number; procs: number; cpu: number; rss: number };
export type Monitor = {
  at: string;
  host: { cpus: number; cpu: number; load: number[]; memory: { total: number; free: number }; server: { cpu: number; rss: number } };
  runs: RunUse[]; cpu: Proc[]; memory: Proc[];
};

// What /proc no longer has, of a process that ended as it was read, or keeps from the server, as a link it may not follow.
const unread = (e: unknown) => ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '');
function read(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch (e) { if (unread(e)) return undefined; throw e; }
}
function link(path: string): string | undefined {
  try { return readlinkSync(path); } catch (e) { if (unread(e)) return undefined; throw e; }
}

// A process's /proc/PID/stat. Its name, in parentheses, may hold spaces and parentheses, so the fields are counted from the last.
export function parseStat(text: string): Stat | undefined {
  const open = text.indexOf(' ('), close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  // From field 3, its state: its parent (4), its user and system time (14, 15), its nice (19) and its start (22).
  const f = text.slice(close + 2).trim().split(/\s+/);
  return { pid: Number(text.slice(0, open)), comm: text.slice(open + 2, close), state: f[0], ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), nice: Number(f[16]), start: Number(f[19]) };
}

function stats(proc: string): Map<number, Stat> {
  const all = new Map<number, Stat>();
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const s = parseStat(read(`${proc}/${name}/stat`) ?? '');
    if (s) all.set(s.pid, s);
  }
  return all;
}
const live = (s: Stat | undefined): s is Stat => !!s && s.state !== 'Z' && s.state !== 'X';

// The host's CPU time, busy and in all, from /proc/stat's first line, and its uptime, which times a sample.
function host(proc: string) {
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = (read(`${proc}/stat`) ?? '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, total, uptime: Number((read(`${proc}/uptime`) ?? '0').split(' ')[0]) };
}

// Each process under a sandbox, with the sandbox and whether it's the sandbox's own: its bwrap, the server's child (runner.ts), the
// bwrap that is pid 1 inside, and Pi, that one's first child. What pid 1 adopted later, a process the agent left running as its
// shell exited, is the run's like any other.
function placed(all: Map<number, Stat>, boxes: Sandbox[]): Map<number, { box: Sandbox; own: boolean }> {
  const kids = new Map<number, number[]>();
  for (const s of all.values()) {
    const k = kids.get(s.ppid);
    if (k) k.push(s.pid);
    else kids.set(s.ppid, [s.pid]);
  }
  const at = new Map<number, { box: Sandbox; own: boolean }>();
  for (const box of boxes) {
    if (!all.has(box.pid)) continue;
    const pi = (kids.get(box.pid) ?? []).flatMap(p => kids.get(p) ?? []).map(p => all.get(p)!).sort((a, b) => a.start - b.start || a.pid - b.pid)[0]?.pid;
    for (const stack: [number, number][] = [[box.pid, 0]]; stack.length;) {
      const [pid, depth] = stack.pop()!;
      if (at.has(pid)) continue;
      at.set(pid, { box, own: depth <= 1 || pid === pi });
      for (const k of kids.get(pid) ?? []) stack.push([k, depth + 1]);
    }
  }
  return at;
}

function argvOf(proc: string, s: Stat): string[] {
  const argv = (read(`${proc}/${s.pid}/cmdline`) ?? '').split('\0');
  if (argv.at(-1) === '') argv.pop();
  return argv.length ? argv : [s.comm];
}
const own = (at: { own: boolean }, argv: string[]) => at.own || argv.includes(BRIDGE);
const rss = (proc: string, pid: number) => Number(/^VmRSS:\s+(\d+) kB$/m.exec(read(`${proc}/${pid}/status`) ?? '')?.[1] ?? 0) * 1024;
const scriptAt = (proc: string, pid: number, argv: string[]) => scriptOf(argv, link(`${proc}/${pid}/cwd`), link(`${proc}/${pid}/exe`));

// The interpreters a script names itself to: the options that put code on the command line or read it from stdin, the options
// that take the next word as their value, and those that take it attached, as -Wignore.
const LANGS: Record<string, { inline: RegExp; valued: RegExp; attached?: RegExp }> = {
  python: { inline: /^-$|^-[A-Za-z]*c/, valued: /^-[WXQ]$/, attached: /^-[WXQ]./ },
  shell: { inline: /^-[A-Za-z]*[cs][A-Za-z]*$/, valued: /^[-+][oO]$|^--(rcfile|init-file)$/ },
  node: { inline: /^-$|^-(e|p|pe|ep)$|^--(eval|print)(=|$)/, valued: /^-[rC]$|^--(require|import|loader|experimental-loader|input-type|conditions)$/ },
  perl: { inline: /^-$|^-[A-Za-z]*[eE]/, valued: /^-[IMm]$/ },
};
const langOf = (name: string) => (/^python[\d.]*$/.test(name) ? 'python' : /^(ba|da|z)?sh$/.test(name) ? 'shell' : /^(node|nodejs)$/.test(name) ? 'node' : name === 'perl' ? 'perl' : undefined);

// What a process runs, as a person names it: the script an interpreter runs, by its full path; -m and the module, for one Python
// runs; INLINE for code on its command line or from its stdin, as python -c or a heredoc gives it; else the program, by the file
// it runs, `exe`. Paths are the sandbox's, as its run sees them.
export function scriptOf(argv: string[], cwd?: string, exe?: string): string {
  const full = (p: string) => (posix.isAbsolute(p) || !cwd ? p : posix.join(cwd, p));
  const lang = langOf(posix.basename(argv[0] ?? ''));
  if (!lang) return exe ?? (argv[0]?.includes('/') ? full(argv[0]) : argv[0] ?? '');
  const { inline, valued, attached } = LANGS[lang];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (valued.test(a)) i++;
    else if (attached?.test(a)) continue;
    else if (lang === 'python' && a.startsWith('-m') && !a.startsWith('--')) return `-m ${a.length > 2 ? a.slice(2) : argv[i + 1] ?? ''}`.trimEnd();
    else if (inline.test(a)) return INLINE;
    else if (!a.startsWith('-') && !(lang === 'shell' && a.startsWith('+'))) return full(a);
  }
  return INLINE;
}

// A command line as admins see it, at most SHOWN characters: `secrets`, such as the run's token, masked wherever they are, and what
// looks like one, a password, token or key given as a word's value, the next word or a header's, and the user in an address.
const SECRET = /pass(word|wd)?(?![a-z])|secret|token|api[-_]?key|authorization|bearer|cookie|credential|private[-_]?key/i;
export function redact(argv: string[], secrets: string[]): string {
  const words = argv.map((a, i) => {
    if (i > 0 && /^--?[\w-]+$/.test(argv[i - 1]) && SECRET.test(argv[i - 1])) return MASK;
    let s = a;
    for (const k of secrets) if (k) s = s.split(k).join(MASK);
    return s.replace(/:\/\/[^/\s@]+@/g, `://${MASK}@`)
      .replace(/^([\w-]*(authorization|cookie|key|token|secret)[\w-]*)\s*:\s*\S.*$/is, `$1: ${MASK}`)
      .replace(/([\w.-]+)=([^&\s;]*)/g, (m, k: string, v: string) => (v && SECRET.test(k) ? `${k}=${MASK}` : m));
  });
  const line = words.map(w => (!w || /[\s"'\\$`&;|<>]/.test(w) ? JSON.stringify(w) : w)).join(' ');
  return line.length > SHOWN ? `${line.slice(0, SHOWN)}…` : line;
}

// A sample of the runs `boxes` names, over a second, `wait` in tests, as /proc tells it: `self` is the server's own process.
export async function sample(boxes: Sandbox[], o: { proc?: string; self?: number; wait?: () => Promise<unknown> } = {}): Promise<Monitor> {
  const proc = o.proc ?? PROC, self = o.self ?? process.pid;
  const h0 = host(proc), before = stats(proc);
  await (o.wait ?? (() => sleep(SAMPLE_MS)))();
  const h1 = host(proc), now = stats(proc), secs = Math.max(h1.uptime - h0.uptime, 1 / HZ);
  // A process the sample saw start counts all its time.
  const cpu = (s: Stat) => {
    const was = before.get(s.pid);
    return Math.round(((s.ticks - (was?.start === s.start ? was.ticks : 0)) / HZ / secs) * 100);
  };
  const procs: Proc[] = [...placed(now, boxes)].map(([pid, at]) => {
    const s = now.get(pid)!, argv = argvOf(proc, s), { box } = at;
    return {
      pid, start: s.start, nice: s.nice, cpu: cpu(s), rss: rss(proc, pid), age: Math.max(0, Math.round(h1.uptime - s.start / HZ)),
      script: scriptAt(proc, pid, argv), command: redact(argv, [box.token]), own: own(at, argv), instance: box.instance, path: box.path, run: box.run,
    };
  });
  const sum = (ps: Proc[], k: 'cpu' | 'rss') => ps.reduce((t, p) => t + p[k], 0);
  const top = (k: 'cpu' | 'rss') => procs.toSorted((a, b) => b[k] - a[k] || a.pid - b.pid).slice(0, TOP);
  const server = now.get(self);
  return {
    at: new Date().toISOString(),
    host: {
      cpus: cpus().length, cpu: Math.round(((h1.busy - h0.busy) / Math.max(h1.total - h0.total, 1)) * 100), load: loadavg(),
      memory: { total: totalmem(), free: freemem() }, server: { cpu: server ? cpu(server) : 0, rss: rss(proc, self) },
    },
    runs: boxes.map(b => {
      const ps = procs.filter(p => p.instance === b.instance && p.run === b.run);
      return { instance: b.instance, path: b.path, run: b.run, runner: b.runner, since: b.since, pid: b.pid, procs: ps.length, cpu: sum(ps, 'cpu'), rss: sum(ps, 'rss') };
    }),
    cpu: top('cpu'), memory: top('rss'),
  };
}

// The start of the process a PID names now, for a kill that gives no start: it tells that process from one that takes its PID
// later, as the kill goes on.
export function startOf(pid: number, proc = PROC): number {
  const s = parseStat(read(`${proc}/${pid}/stat`) ?? '');
  if (!live(s)) throw new HttpError(404, `process ${pid} has ended`);
  return s.start;
}

// The process an admin would kill, as rf top showed it, by its PID and start: one of a run going, never the sandbox's own.
export function find(pid: number, start: number, boxes: Sandbox[], proc = PROC): { box: Sandbox; script: string } {
  const all = stats(proc), s = all.get(pid);
  if (!live(s)) throw new HttpError(404, `process ${pid} has ended`);
  if (s.start !== start) throw new HttpError(409, `process ${pid} is another process now: run rf top again`);
  const at = placed(all, boxes).get(pid);
  if (!at) throw new HttpError(404, `process ${pid} is in no run going`);
  const argv = argvOf(proc, s);
  if (own(at, argv)) throw new HttpError(409, `process ${pid} is run ${at.box.run}'s own, its sandbox, Pi or its socket: stop the run instead`);
  return { box: at.box, script: scriptAt(proc, pid, argv) };
}

const alive = (proc: string, pid: number, start: number) => {
  const s = parseStat(read(`${proc}/${pid}/stat`) ?? '');
  return live(s) && s.start === start;
};
// Pin each kernel process instance via pidfd, re-verify its start time (and cgroup / pid namespace when present) while holding the fd,
// and deliver the signal via pidfd_send_signal so a recycled PID can never receive a signal meant for an exited process.
const PIDFD_SIGNAL_BATCH = `
import json, os, signal, sys
proc, sig_name, exp_cg, exp_ns, raw_targets = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
sig = getattr(signal, sig_name)
signaled = []
for pid, expected in json.loads(raw_targets):
    try:
        fd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        continue
    try:
        with open(f"{proc}/{pid}/stat", "r", encoding="latin-1") as f:
            s = f.read()
        i = s.rfind(")")
        if i < 0:
            continue
        rest = s[i + 2:].split(" ")
        if len(rest) <= 19 or rest[0] in ("Z", "X", "x") or int(rest[19]) != expected:
            continue
        if exp_ns:
            try:
                if os.readlink(f"{proc}/{pid}/ns/pid") != exp_ns:
                    continue
            except OSError:
                continue
        if exp_cg:
            try:
                with open(f"{proc}/{pid}/cgroup", "r", encoding="latin-1") as cf:
                    if cf.read() != exp_cg:
                        continue
            except OSError:
                continue
        try:
            signal.pidfd_send_signal(fd, sig)
            signaled.append(pid)
        except ProcessLookupError:
            pass
    except FileNotFoundError:
        pass
    finally:
        os.close(fd)
sys.stdout.write(json.dumps(signaled))
`;
export type SignalScope = { cgroup?: string; pidNs?: string };
async function signalBatch(proc: string, targets: [number, number][], sig: NodeJS.Signals, scope: SignalScope = {}): Promise<Set<number>> {
  if (!targets.length) return new Set();
  if (process.platform === 'linux' && proc === PROC) {
    const { stdout } = await runFile('python3', ['-c', PIDFD_SIGNAL_BATCH, proc, sig, scope.cgroup ?? '', scope.pidNs ?? '', JSON.stringify(targets)]);
    return new Set<number>(JSON.parse(stdout || '[]'));
  }
  const ok = new Set<number>();
  for (const [pid, start] of targets) {
    if (!alive(proc, pid, start)) continue;
    if (scope.pidNs && link(`${proc}/${pid}/ns/pid`) !== scope.pidNs) continue;
    if (scope.cgroup && read(`${proc}/${pid}/cgroup`) !== scope.cgroup) continue;
    try { process.kill(pid, sig); ok.add(pid); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  return ok;
}
export async function signal(proc: string, pid: number, start: number, sig: NodeJS.Signals, scope?: SignalScope): Promise<boolean> {
  return (await signalBatch(proc, [[pid, start]], sig, scope)).has(pid);
}

// A process and all it started end: each held with SIGSTOP as it's found, from the top down, so nothing they start meanwhile gets
// away; then each is asked to end with SIGTERM, and what's left after the grace gets SIGKILL.
export async function killTree(pid: number, start: number, o: { proc?: string; graceMs?: number; box?: Sandbox; signal?: typeof signalBatch } = {}): Promise<{ pids: number[]; signal: 'SIGTERM' | 'SIGKILL' }> {
  const proc = o.proc ?? PROC, send = o.signal ?? signalBatch;
  if (!alive(proc, pid, start)) throw new HttpError(409, `process ${pid} has ended, or is another process now: run rf top again`);
  const scope: SignalScope = {
    cgroup: read(`${proc}/${pid}/cgroup`),
    pidNs: link(`${proc}/${pid}/ns/pid`),
  };
  const boxStart = o.box ? parseStat(read(`${proc}/${o.box.pid}/stat`) ?? '')?.start : undefined;
  const stoppedRoot = await send(proc, [[pid, start]], 'SIGSTOP', scope);
  if (!stoppedRoot.has(pid)) throw new HttpError(409, `process ${pid} has ended, or is another process now: run rf top again`);
  const held = new Map<number, number>([[pid, start]]);
  let terminated = false;
  try {
    for (let found = true; found;) {
      found = false;
      const all = stats(proc);
      const placement = o.box && boxStart !== undefined && all.get(o.box.pid)?.start === boxStart
        ? placed(all, [o.box])
        : undefined;
      const batch: [number, number][] = [];
      for (const s of all.values()) {
        if (!held.has(s.ppid) || held.has(s.pid) || !live(s)) continue;
        const parentStart = held.get(s.ppid)!;
        // Verify parent has not been recycled and child did not start before its parent.
        if (all.get(s.ppid)?.start !== parentStart || s.start < parentStart) continue;
        if (o.box) {
          const at = placement?.get(s.pid);
          if (!at || own(at, argvOf(proc, s))) continue;
        }
        if (scope.pidNs && link(`${proc}/${s.pid}/ns/pid`) !== scope.pidNs) continue;
        if (scope.cgroup && read(`${proc}/${s.pid}/cgroup`) !== scope.cgroup) continue;
        batch.push([s.pid, s.start]);
      }
      if (batch.length) {
        const ok = await send(proc, batch, 'SIGSTOP', scope);
        for (const [p, st] of batch) {
          if (ok.has(p)) {
            held.set(p, st);
            found = true;
          }
        }
      }
    }
    await send(proc, [...held], 'SIGTERM', scope);
    await send(proc, [...held], 'SIGCONT', scope);
    terminated = true;
    const left = () => [...held].filter(([p, st]) => alive(proc, p, st));
    for (const until = Date.now() + (o.graceMs ?? GRACE_MS); left().length && Date.now() < until;) await sleep(POLL_MS);
    const rest = left();
    if (rest.length) await send(proc, rest, 'SIGKILL', scope);
    // SIGKILL takes a moment to land: it's done once they've gone.
    for (const until = Date.now() + KILLED_MS; left().length && Date.now() < until;) await sleep(POLL_MS);
    return { pids: [...held.keys()], signal: rest.length ? 'SIGKILL' : 'SIGTERM' };
  } finally {
    if (!terminated && held.size) await send(proc, [...held], 'SIGCONT', scope).catch(() => {});
  }
}
