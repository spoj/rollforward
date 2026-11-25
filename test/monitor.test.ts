import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { find, INLINE, killTree, parseStat, redact, sample, scriptOf, signal, signalBatch, startOf, type Sandbox } from '../src/monitor.ts';

// The system monitor on a /proc of the test's own, as Linux writes one: a server, two runs' sandboxes, one busy, and a process of the
// host's own beside them; and kills of real processes, where there are any.
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const MB = 2 ** 20;
type Fake = { pid: number; ppid: number; comm: string; argv: string[]; ticks?: number; start?: number; rssMb?: number; state?: string; nice?: number };
function writeProc(dir: string, procs: Fake[], host: { busy: number; idle: number; uptime: number }) {
  writeFileSync(join(dir, 'stat'), `cpu  ${host.busy} 0 0 ${host.idle} 0 0 0 0 0 0\ncpu0 ${host.busy} 0 0 ${host.idle} 0 0 0 0 0 0\n`);
  writeFileSync(join(dir, 'uptime'), `${host.uptime.toFixed(2)} 0.00\n`);
  for (const p of procs) {
    mkdirSync(join(dir, String(p.pid)), { recursive: true });
    // Fields 3 to 24: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority
    // nice num_threads itrealvalue starttime vsize rss.
    writeFileSync(join(dir, String(p.pid), 'stat'), `${p.pid} (${p.comm}) ${p.state ?? 'S'} ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 0 0 0 0 ${p.ticks ?? 0} 0 0 0 39 ${p.nice ?? 19} 1 0 ${p.start ?? 5000} 1000000 100 18446744073709551615\n`);
    writeFileSync(join(dir, String(p.pid), 'cmdline'), p.argv.map(a => `${a}\0`).join(''));
    writeFileSync(join(dir, String(p.pid), 'status'), `Name:\t${p.comm}\nState:\t${p.state ?? 'S'}\nVmRSS:\t ${(p.rssMb ?? 1) * 1024} kB\n`);
  }
}
const fakeProc = (procs: Fake[], host = { busy: 1000, idle: 1000, uptime: 1000 }) => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-proc-'));
  dirs.push(dir);
  writeProc(dir, procs, host);
  return dir;
};

const A: Sandbox = { pid: 200, instance: 'a1', path: 'Acme/Bank rec/2026-11', run: 3, runner: 'alice@demo.test', since: '2026-11-17T08:00:00.000Z', token: 'the-run-token' };
const B: Sandbox = { pid: 400, instance: 'b1', path: 'Acme/AP/2026-11', run: 1, runner: 'bob@demo.test', since: '2026-11-17T08:30:00.000Z', token: 'b-token' };
// Run A's sandbox: its bwrap, the bwrap that is pid 1 inside, Pi, the socket's bridge, a shell the agent started, running a Python
// script and an OCR, and an OCR a shell left running in the background, which pid 1 adopted; run B's bwrap alone; and a busy
// process of the host's, in no sandbox. Busy, a second on.
const procs = (busy = false): Fake[] => [
  { pid: 1, ppid: 0, comm: 'systemd', argv: ['/sbin/init'], start: 1 },
  { pid: 100, ppid: 1, comm: 'node', argv: ['node', 'src/server.ts', '/data'], ticks: busy ? 30 : 0, start: 100, rssMb: 512 },
  { pid: 200, ppid: 100, comm: 'bwrap', argv: ['bwrap', '--args', '3', '--', '/usr/bin/prlimit'], start: 4000 },
  { pid: 201, ppid: 200, comm: 'bwrap', argv: ['bwrap', '--args', '3', '--', '/usr/bin/prlimit'], start: 4001 },
  { pid: 202, ppid: 201, comm: 'node', argv: ['node', '--disable-sigusr1', '/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', '--mode', 'rpc'], ticks: busy ? 5 : 0, start: 4002, rssMb: 300 },
  { pid: 203, ppid: 202, comm: 'socat', argv: ['socat', 'TCP-LISTEN:7000,bind=127.0.0.1,fork,reuseaddr', 'UNIX-CONNECT:/run/rf/rf.sock'], start: 4003 },
  { pid: 204, ppid: 202, comm: 'bash', argv: ['bash', '-c', 'python3 /work/Acme/Bank rec/2026-11/working/ocr.py & tesseract a.png out; wait'], start: 4500 },
  { pid: 205, ppid: 204, comm: 'python3', argv: ['python3', '/work/Acme/Bank rec/2026-11/working/ocr.py'], ticks: busy ? 90 : 0, start: 4501, rssMb: 200 },
  { pid: 206, ppid: 204, comm: 'tesseract', argv: ['tesseract', 'a.png', 'out'], ticks: busy ? 50 : 0, start: 4502, rssMb: 2048 },
  { pid: 208, ppid: 201, comm: 'tesseract', argv: ['tesseract', 'b.png', 'out'], start: 4600 },
  { pid: 300, ppid: 1, comm: 'python3', argv: ['python3', '/opt/other/batch.py'], ticks: busy ? 100 : 0, start: 3000, rssMb: 4096 },
  { pid: 400, ppid: 100, comm: 'bwrap', argv: ['bwrap', '--args', '3'], start: 6000 },
];
const byNumber = (a: number, b: number) => a - b;

test("a process's stat is read by its fields after its name, which may hold spaces and parentheses", () => {
  assert.deepEqual(parseStat('42 (my (odd) name) R 7 42 42 0 -1 0 0 0 0 0 150 50 0 0 20 5 3 0 12345 0 0\n'),
    { pid: 42, comm: 'my (odd) name', state: 'R', ppid: 7, ticks: 200, nice: 5, start: 12345 });
  assert.equal(parseStat(''), undefined);
});

test('a process is named by the script its interpreter runs, by its full path, by inline for code on its command line, and else by its program', () => {
  const cwd = '/work/Acme/Bank rec/2026-11';
  const cases: [string[], string][] = [
    [['python3', 'working/ocr.py', 'a.png'], `${cwd}/working/ocr.py`],
    [['/opt/venv/bin/python', '-u', '/tmp/x.py'], '/tmp/x.py'],
    [['python3.13', '-W', 'ignore', 'x.py'], `${cwd}/x.py`],
    [['python3', '-Xpycache_prefix=/tmp', 'x.py'], `${cwd}/x.py`],
    [['python3', '-c', 'print(1)'], INLINE],
    [['python3', '-uc', 'print(1)'], INLINE],
    [['python3', '-'], INLINE],
    [['python3'], INLINE],
    [['python3', '-m', 'pip', 'install', 'pandas'], '-m pip'],
    [['bash', '-c', 'for i in 1 2; do tesseract $i.png $i & done; wait'], INLINE],
    [['/bin/bash', '-ec', 'make'], INLINE],
    [['bash', 'run.sh', 'now'], `${cwd}/run.sh`],
    [['sh', '-s'], INLINE],
    [['node', '-e', 'console.log(1)'], INLINE],
    [['node', '--require', 'setup.js', 'main.js'], `${cwd}/main.js`],
    [['perl', '-ne', 'print'], INLINE],
  ];
  for (const [argv, script] of cases) assert.equal(scriptOf(argv, cwd, '/usr/bin/python3.13'), script, argv.join(' '));
  assert.equal(scriptOf(['tesseract', 'a.png', 'out'], cwd, '/usr/bin/tesseract'), '/usr/bin/tesseract', 'a program by the file it runs');
  assert.equal(scriptOf(['tesseract', 'a.png'], cwd, undefined), 'tesseract', "by its name where the server can't read which file");
  assert.equal(scriptOf(['./tool', 'x'], cwd, undefined), `${cwd}/tool`);
  assert.equal(scriptOf(['python3', 'x.py'], undefined, undefined), 'x.py', 'relative where its folder is unknown');
});

test("a command line shows with what looks like a secret masked, the run's token among them, and at most 300 characters", () => {
  assert.equal(redact(['curl', '-H', 'Authorization: Bearer abc123', 'https://user:pw@example.com/x?token=t0k&a=1'], []),
    'curl -H "Authorization: ***" "https://***@example.com/x?token=***&a=1"');
  assert.equal(redact(['env', 'API_KEY=sk-123', 'DB_PASSWORD=x', 'MODE=fast', 'python', 'x.py'], []), 'env API_KEY=*** DB_PASSWORD=*** MODE=fast python x.py');
  assert.equal(redact(['mysql', '--password', 'hunter2', '--user', 'bob'], []), 'mysql --password *** --user bob');
  assert.equal(redact(['tool', '--api-key=abc', '--session-dir', '/work/a/session'], []), 'tool --api-key=*** --session-dir /work/a/session');
  assert.equal(redact(['curl', '-x', 'http://rf:the-run-token@127.0.0.1:7000', 'https://pypi.org'], ['the-run-token']), 'curl -x http://***@127.0.0.1:7000 https://pypi.org');
  assert.equal(redact(['echo', 'its token is the-run-token'], ['the-run-token']), 'echo "its token is ***"');
  const long = redact(['python3', '-c', 'x = 1\n'.repeat(100)], []);
  assert.equal(long.length, 301);
  assert.ok(long.endsWith('…') && !long.includes('\n'), long);
});

test("the monitor counts each run's processes and what they use, lists the busiest of them, and never the host's others", async () => {
  const dir = fakeProc(procs());
  // A second on: the OCR, its script and the host's own process were busy, and a process the shell started meanwhile is there.
  const later = [...procs(true), { pid: 207, ppid: 204, comm: 'sleep', argv: ['sleep', '9'], ticks: 1, start: 100050 }];
  const m = await sample([A, B], { proc: dir, self: 100, wait: async () => writeProc(dir, later, { busy: 1300, idle: 1500, uptime: 1001 }) });
  assert.equal(m.host.cpu, 38, 'the host was busy for 300 of 800 ticks');
  assert.deepEqual(m.host.server, { cpu: 30, rss: 512 * MB });
  assert.equal(m.host.load.length, 3);
  assert.deepEqual(m.runs.map(r => [r.instance, r.run, r.procs, r.cpu, r.rss]), [['a1', 3, 9, 146, (300 + 200 + 2048 + 6) * MB], ['b1', 1, 1, 0, MB]]);
  assert.deepEqual(m.runs[0], { ...m.runs[0], path: A.path, runner: A.runner, since: A.since, pid: 200 });
  assert.deepEqual(m.cpu.map(p => [p.pid, p.cpu]).slice(0, 4), [[205, 90], [206, 50], [202, 5], [207, 1]], 'busiest first, and the newcomer by its own time');
  assert.equal(m.cpu.length, 10, 'ten at most');
  assert.equal(m.memory[0].pid, 206, 'the OCR holds the most memory');
  assert.ok(![...m.cpu, ...m.memory].some(p => p.pid === 300 || p.pid === 100), "the host's own and the server's are no run's");
  const ps = Object.fromEntries(m.cpu.map(p => [p.pid, p]));
  assert.deepEqual([200, 201, 202, 203, 204, 205, 206, 207, 208].map(pid => ps[pid].own), [true, true, true, true, false, false, false, false, false],
    "the sandbox's bwraps, Pi and the socket's bridge are the run's own, and what pid 1 adopted isn't");
  assert.deepEqual([ps[204].script, ps[205].script, ps[206].script], [INLINE, '/work/Acme/Bank rec/2026-11/working/ocr.py', 'tesseract']);
  assert.equal(ps[204].command, 'bash -c "python3 /work/Acme/Bank rec/2026-11/working/ocr.py & tesseract a.png out; wait"');
  assert.deepEqual([ps[205].instance, ps[205].path, ps[205].run, ps[205].start, ps[205].nice, ps[205].rss, ps[205].age], ['a1', A.path, 3, 4501, 19, 200 * MB, 956]);
});

test("a kill names the process it would end, and refuses one that has ended, one whose PID another took, one in no run and a run's own", () => {
  const dir = fakeProc(procs());
  const status = (f: () => unknown) => { try { f(); return 0; } catch (e) { return (e as { status: number }).status; } };
  assert.equal(status(() => find(999, 1, [A, B], dir)), 404, 'ended');
  assert.equal(status(() => find(205, 1234, [A, B], dir)), 409, 'another process now');
  assert.equal(status(() => find(300, 3000, [A, B], dir)), 404, 'in no run');
  for (const pid of [200, 201, 202, 203]) assert.equal(status(() => find(pid, procs().find(p => p.pid === pid)!.start!, [A, B], dir)), 409, `the run's own ${pid}`);
  assert.deepEqual(find(205, 4501, [A, B], dir), { box: A, script: '/work/Acme/Bank rec/2026-11/working/ocr.py' });
  assert.deepEqual(find(208, 4600, [A, B], dir), { box: A, script: 'tesseract' }, 'one pid 1 adopted');
});

test('a kill that gives no start takes the start of the process the PID names now, and refuses one that has ended', () => {
  const dir = fakeProc(procs());
  assert.equal(startOf(205, dir), 4501);
  assert.throws(() => startOf(999, dir), (e: { status: number }) => e.status === 404);
});

// Real processes: a shell and the two it started, which share its handling of SIGTERM.
const linux = { skip: process.platform !== 'linux' && 'kills real processes, as Linux has them' };
const statOf = (pid: number | string) => {
  try { return parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return undefined; }
};
async function family(script: string) {
  const sh = spawn('sh', ['-c', script], { stdio: 'ignore' });
  const kids = () => readdirSync('/proc').filter(p => /^\d+$/.test(p) && statOf(p)?.ppid === sh.pid).map(Number);
  for (let i = 0; kids().length < 2; i++) {
    assert.ok(i < 100, 'the shell started its two');
    await new Promise(ok => setTimeout(ok, 20));
  }
  return { sh, start: statOf(sh.pid!)!.start, all: [sh.pid!, ...kids()].toSorted(byNumber) };
}
const gone = (pid: number) => ['Z', 'X', undefined].includes(statOf(pid)?.state);

test('a kill ends a process and what it started with SIGTERM', linux, async () => {
  const { sh, start, all } = await family('sleep 60 & sleep 60 & wait');
  const exited = once(sh, 'exit'), killed = await killTree(sh.pid!, start, { graceMs: 2000 });
  assert.deepEqual([killed.signal, killed.pids.toSorted(byNumber)], ['SIGTERM', all]);
  await exited;
  for (const pid of all) assert.ok(gone(pid), `${pid} ended`);
});

test('a kill ends what ignores SIGTERM with SIGKILL once its grace is over, and refuses a process that is another now', linux, async () => {
  const { sh, start, all } = await family('trap "" TERM; sleep 60 & sleep 60 & wait');
  await assert.rejects(killTree(sh.pid!, start + 1, { graceMs: 100 }), { status: 409 });
  assert.ok(!gone(sh.pid!), 'a refused kill kills nothing');
  const exited = once(sh, 'exit'), at = Date.now(), killed = await killTree(sh.pid!, start, { graceMs: 300 });
  assert.deepEqual([killed.signal, killed.pids.toSorted(byNumber)], ['SIGKILL', all]);
  assert.ok(Date.now() - at >= 300, 'after its grace');
  await exited;
  for (const pid of all) assert.ok(gone(pid), `${pid} ended`);
});

test('pidfd signaling refuses a mismatched start time without harming the live process, and kills on exact start', linux, async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    const start = statOf(child.pid!)!.start;
    assert.equal(await signal('/proc', child.pid!, start + 1, 'SIGTERM'), false);
    await new Promise(ok => setTimeout(ok, 50));
    assert.ok(!gone(child.pid!), 'mismatched start time must not signal a live process');

    const exited = once(child, 'exit');
    assert.equal(await signal('/proc', child.pid!, start, 'SIGTERM'), true);
    await exited;
    assert.ok(gone(child.pid!), 'matching start time terminates the process via pidfd');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('pidfd SIGSTOP batch rolls back earlier stopped PIDs with SIGCONT when a later item in the same batch fails', linux, async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    const start = statOf(child.pid!)!.start;
    // Entry 1 stops child via pidfd_send_signal(SIGSTOP); entry 2 triggers an exception inside the same Python batch.
    await assert.rejects(signalBatch('/proc', [[child.pid!, start], ['bad' as unknown as number, 0]], 'SIGSTOP'));
    await new Promise(ok => setTimeout(ok, 50));
    const st = statOf(child.pid!);
    assert.ok(st && st.state !== 'T' && st.state !== 't', `earlier PID must be resumed via SIGCONT, not left stopped (state=${st?.state})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('killTree excludes vanished PIDs, refuses cross-cgroup / unplaced / older-start children, and sends SIGCONT on mid-traversal failure', async () => {
  // Fake /proc with:
  // - box bwrap 200 (start 4000) -> pid1 201 (4001) -> pi 202 (4002) -> target 205 (4501, cgroup A)
  // - valid child 206 (ppid 205, start 4502, cgroup A)
  // - vanished child 207 (ppid 205, start 4503, cgroup A) whose SIGSTOP returns empty (vanished)
  // - bogus child 208 (ppid 205, start 4504, DIFFERENT cgroup B)
  // - bogus older child 209 (ppid 205, start 4000 < parentStart 4501, cgroup A)
  // - child of vanished 207: 210 (ppid 207, start 4505, cgroup A) -> MUST NOT be selected because 207 never entered `held`!
  const fake = fakeProc([
    { pid: 200, ppid: 100, comm: 'bwrap', argv: ['bwrap'], start: 4000 },
    { pid: 201, ppid: 200, comm: 'bwrap', argv: ['bwrap'], start: 4001 },
    { pid: 202, ppid: 201, comm: 'node', argv: ['node', 'pi'], start: 4002 },
    { pid: 205, ppid: 202, comm: 'python3', argv: ['python3', 'job.py'], start: 4501 },
    { pid: 206, ppid: 205, comm: 'sleep', argv: ['sleep', '60'], start: 4502 },
    { pid: 207, ppid: 205, comm: 'sleep', argv: ['sleep', '60'], start: 4503 },
    { pid: 208, ppid: 205, comm: 'sleep', argv: ['sleep', '60'], start: 4504 },
    { pid: 209, ppid: 205, comm: 'sleep', argv: ['sleep', '60'], start: 4000 },
    { pid: 210, ppid: 207, comm: 'sleep', argv: ['sleep', '60'], start: 4505 },
  ]);
  for (const pid of [205, 206, 207, 209, 210]) writeFileSync(join(fake, String(pid), 'cgroup'), '0::/rf-run-a\n');
  writeFileSync(join(fake, '208', 'cgroup'), '0::/unrelated-b\n');

  const log: { sig: string; pids: number[] }[] = [];
  const res = await killTree(205, 4501, {
    proc: fake,
    graceMs: 10,
    box: A,
    signal: async (_p, targets, sig) => {
      const pids = targets.map(([p]) => p);
      log.push({ sig, pids });
      if (sig === 'SIGTERM') {
        for (const p of pids) rmSync(join(fake, String(p)), { recursive: true, force: true });
      }
      // Simulate PID 207 vanishing before SIGSTOP lands.
      return new Set(pids.filter(p => p !== 207));
    },
  });
  assert.deepEqual(res.pids.toSorted(byNumber), [205, 206], 'only live target and valid in-cgroup descendant entered held');
  assert.ok(!log.some(l => l.pids.includes(208)), 'cross-cgroup process never signaled');
  assert.ok(!log.some(l => l.pids.includes(209)), 'child with start < parentStart never signaled');
  assert.ok(!log.some(l => l.pids.includes(210)), 'descendant of vanished non-held PID never selected');

  // Mid-traversal error must SIGCONT already-held processes!
  const fake2 = fakeProc([
    { pid: 200, ppid: 100, comm: 'bwrap', argv: ['bwrap'], start: 4000 },
    { pid: 201, ppid: 200, comm: 'bwrap', argv: ['bwrap'], start: 4001 },
    { pid: 202, ppid: 201, comm: 'node', argv: ['node', 'pi'], start: 4002 },
    { pid: 205, ppid: 202, comm: 'python3', argv: ['python3', 'job.py'], start: 4501 },
    { pid: 206, ppid: 205, comm: 'sleep', argv: ['sleep', '60'], start: 4502 },
  ]);
  const log2: { sig: string; pids: number[] }[] = [];
  let stops = 0;
  await assert.rejects(killTree(205, 4501, {
    proc: fake2,
    box: A,
    signal: async (_p, targets, sig) => {
      const pids = targets.map(([p]) => p);
      log2.push({ sig, pids });
      if (sig === 'SIGSTOP' && ++stops === 2) throw new Error('helper crashed mid-traversal');
      return new Set(pids);
    },
  }), /helper crashed mid-traversal/);
  assert.deepEqual(log2.at(-1), { sig: 'SIGCONT', pids: [205] }, 'held processes resumed with SIGCONT on abort');
});
