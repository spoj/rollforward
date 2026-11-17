import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from './store.ts';

// The system monitor, admins' alone (docs/system.md, The page): the runs going, each with the processes its sandbox holds and what
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

// The process an admin would kill, as the monitor showed it, by its PID and start: one of a run going, never the sandbox's own.
export function find(pid: number, start: number, boxes: Sandbox[], proc = PROC): { box: Sandbox; script: string } {
  const all = stats(proc), s = all.get(pid);
  if (!live(s)) throw new HttpError(404, `process ${pid} has ended`);
  if (s.start !== start) throw new HttpError(409, `process ${pid} is another process now: refresh the monitor`);
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
// A signal to the process it was, by its start; one that ended meanwhile takes none.
function signal(proc: string, pid: number, start: number, sig: NodeJS.Signals) {
  if (!alive(proc, pid, start)) return;
  try { process.kill(pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}

// A process and all it started end: each held with SIGSTOP as it's found, from the top down, so nothing they start meanwhile gets
// away; then each is asked to end with SIGTERM, and what's left after the grace gets SIGKILL.
export async function killTree(pid: number, start: number, o: { proc?: string; graceMs?: number } = {}): Promise<{ pids: number[]; signal: 'SIGTERM' | 'SIGKILL' }> {
  const proc = o.proc ?? PROC;
  if (!alive(proc, pid, start)) throw new HttpError(409, `process ${pid} has ended, or is another process now: refresh the monitor`);
  const held = new Map([[pid, start]]);
  signal(proc, pid, start, 'SIGSTOP');
  for (let found = true; found;) {
    found = false;
    for (const s of stats(proc).values()) {
      if (!held.has(s.ppid) || held.has(s.pid) || !live(s)) continue;
      held.set(s.pid, s.start);
      signal(proc, s.pid, s.start, 'SIGSTOP');
      found = true;
    }
  }
  for (const [p, st] of held) signal(proc, p, st, 'SIGTERM');
  for (const [p, st] of held) signal(proc, p, st, 'SIGCONT');
  const left = () => [...held].filter(([p, st]) => alive(proc, p, st));
  for (const until = Date.now() + (o.graceMs ?? GRACE_MS); left().length && Date.now() < until;) await sleep(POLL_MS);
  const rest = left();
  for (const [p, st] of rest) signal(proc, p, st, 'SIGKILL');
  // SIGKILL takes a moment to land: it's done once they've gone.
  for (const until = Date.now() + KILLED_MS; left().length && Date.now() < until;) await sleep(POLL_MS);
  return { pids: [...held.keys()], signal: rest.length ? 'SIGKILL' : 'SIGTERM' };
}

// What a sandbox holds, each process by its start; and what of it is still there once its run has stopped, killed. Nothing is, as
// a sandbox ends with its bwrap, but a run's stop is sure of it.
export function holdings(box: Sandbox, proc = PROC): [number, number][] {
  const all = stats(proc);
  return [...placed(all, [box]).keys()].map(p => [p, all.get(p)!.start]);
}
export function killLeft(held: [number, number][], proc = PROC): number {
  const left = held.filter(([p, st]) => alive(proc, p, st));
  for (const [p, st] of left) signal(proc, p, st, 'SIGKILL');
  return left.length;
}
