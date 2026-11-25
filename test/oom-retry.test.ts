import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = join(import.meta.dirname, '..');

function runScript(code: string, extraEnv: Record<string, string> = {}, timeout = 20_000) {
  const root = mkdtempSync(join(tmpdir(), 'rf-oom-'));
  try {
    return execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', code.replaceAll('__ROOT__', JSON.stringify(root))], {
      cwd,
      env: { ...process.env, RF_MIN_FREE_GB: '0', ...extraEnv },
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; stdout?: string | Buffer; message: string };
    assert.fail(`script failed:\nSTDOUT:\n${err.stdout ?? ''}\nSTDERR:\n${err.stderr ?? err.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('autonomous series: confirmed OOM wakes 1 fresh run with truthful done.seen and memory hint; 2nd consecutive OOM stops cleanly and resets after success', () => {
  runScript(`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync } from 'node:fs';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, writeJson } from './src/system.ts';
    import { ownSeries } from './test/owner-fixture.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { committed } from './src/git.ts';

    const root = __ROOT__, alice = 'alice@demo.test';
    initSystem(root);
    openStore(root);
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
    writeJson('users.json', { [alice]: { role: 'user' } });
    mkdirSync(root + '/series/s', { recursive: true });
    ownSeries('s', alice, [], true);

    const prompts = [];
    // Run 1: OOM -> auto-retries Run 2
    // Run 2: OOM -> 2nd consecutive OOM, MUST stop (no Run 3)
    // Owner comments -> Run 3: succeeds -> resets consecutive OOM counter
    // Owner comments -> Run 4: OOM -> auto-retries Run 5 -> succeeds
    const outcomes = [
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: false },
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: false },
    ];
    let runs = 0;
    const settled = new Map();
    const waitRun = n => (settled.get(n) ?? (settled.set(n, Promise.withResolvers()), settled.get(n))).promise;
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ onEvent }) => {
          const n = ++runs;
          return {
            turn: async text => {
              prompts.push(text);
              onEvent({ type: 'message_start', message: { role: 'user', content: text } });
              onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
              return { settled: Promise.resolve(outcomes[n - 1]) };
            },
            steer: async () => {},
            interrupt: async () => {},
            stop: async () => { (settled.get(n) ?? (settled.set(n, Promise.withResolvers()), settled.get(n))).resolve(); },
          };
        },
      },
    });
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });

    const { kick } = await import('./src/waker.ts');
    const inst = createInstance('s', 'P1', alice);
    const c1 = inst.append(alice, 'comment', { thread: 'c2', text: 'Process the 200MB workbook.' });
    kick(inst);
    await waitRun(2);
    await new Promise(r => setTimeout(r, 150));
    await committed(inst.dir);

    assert.equal(runs, 2, '1st OOM retried once; 2nd consecutive OOM stopped cleanly');
    const [d1, d2] = inst.log.filter(e => e.op === 'done');
    assert.equal(d1.oom, true);
    assert.equal(d1.seen, c1.seq, 'done.seen truthfully records what killed Run 1 read (never rewound)');
    assert.equal(d2.oom, true);
    assert.ok(d2.seen > d1.seq, 'done 2 truthfully records reading wake 1');
    const wakesAfter2 = inst.log.filter(e => e.op === 'wake');
    assert.equal(wakesAfter2.length, 1, 'only 1 OOM wake emitted across 2 consecutive OOMs');
    assert.equal(wakesAfter2[0].from, 'server');
    assert.equal(wakesAfter2[0].cause, d1.seq);
    assert.deepEqual(wakesAfter2[0].recovery, { run: 1, reason: 'oom' });
    assert.match(wakesAfter2[0].reason, /memory limit.*check working\\/ and logs.*stream or chunk/i);
    assert.match(prompts[1], /memory limit/);

    // Manual owner comment starts Run 3 (succeeds), resetting consecutive OOM state; then Run 4 OOMs and gets 1 fresh retry (Run 5).
    inst.append(alice, 'comment', { thread: 'c2', text: 'Try again cleanly.' });
    kick(inst);
    await waitRun(3);
    inst.append(alice, 'comment', { thread: 'c2', text: 'Run heavy step.' });
    kick(inst);
    await waitRun(5);
    await committed(inst.dir);
    assert.equal(runs, 5, 'consecutive OOM counter reset after a successful run');
    assert.equal(inst.log.filter(e => e.op === 'wake').length, 2);
  `);
});

test('non-autonomous series: confirmed OOM stops cleanly with truthful done.seen and never auto-retries', () => {
  runScript(`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync } from 'node:fs';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, writeJson } from './src/system.ts';
    import { ownSeries } from './test/owner-fixture.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { committed } from './src/git.ts';

    const root = __ROOT__, alice = 'alice@demo.test';
    initSystem(root);
    openStore(root);
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
    writeJson('users.json', { [alice]: { role: 'user' } });
    mkdirSync(root + '/series/s', { recursive: true });
    ownSeries('s', alice, [], false);

    let runs = 0;
    const done1 = Promise.withResolvers();
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ onEvent }) => {
          runs++;
          return {
            turn: async text => {
              onEvent({ type: 'message_start', message: { role: 'user', content: text } });
              onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
              return { settled: Promise.resolve({ aborted: true, error: runner.OOM_ERROR, oom: true }) };
            },
            steer: async () => {},
            interrupt: async () => {},
            stop: async () => { done1.resolve(); },
          };
        },
      },
    });
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });

    const { kick, standing } = await import('./src/waker.ts');
    const inst = createInstance('s', 'P1', alice);
    const c1 = inst.append(alice, 'comment', { thread: 'c2', text: 'Run without autonomous consent.' });
    kick(inst);
    await done1.promise;
    await new Promise(r => setTimeout(r, 150));
    await committed(inst.dir);

    assert.equal(runs, 1, 'non-autonomous series does not auto-retry OOM');
    const [d1] = inst.log.filter(e => e.op === 'done');
    assert.equal(d1.oom, true);
    assert.equal(d1.seen, c1.seq);
    assert.equal(inst.log.filter(e => e.op === 'wake').length, 0);

    // Even a pre-existing OOM recovery wake cannot start a non-autonomous series (no autonomous bypass in standing()).
    const fakeWake = { seq: inst.log.length + 1, at: '', by: 'server', op: 'wake', from: 'server', authority: { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: false }, initiator: alice, recovery: { run: 1, reason: 'oom' } };
    assert.equal(standing(inst, fakeWake).starts, false);
  `);
});

test('interrupted, revoked-consent, archived, or non-OOM runs do not auto-retry OOM', () => {
  runScript(`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync } from 'node:fs';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, tree, writeJson } from './src/system.ts';
    import { ownSeries } from './test/owner-fixture.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { committed } from './src/git.ts';

    const root = __ROOT__, alice = 'alice@demo.test';
    initSystem(root);
    openStore(root);
    saveTree({
      workspaces: { w: { name: 'Work', owners: [alice], members: [] } },
      series: {
        sInt: { name: 'Int', workspace: 'w' },
        sRev: { name: 'Rev', workspace: 'w' },
        sArc: { name: 'Arc', workspace: 'w' },
        sErr: { name: 'Err', workspace: 'w' },
      },
    });
    writeJson('users.json', { [alice]: { role: 'user' } });
    for (const sid of ['sInt', 'sRev', 'sArc', 'sErr']) {
      mkdirSync(root + '/series/' + sid, { recursive: true });
      ownSeries(sid, alice, [], true);
    }

    const runsByInst = new Map();
    const gates = new Map();
    const entered = new Map();
    const stopped = new Map();
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ id, onEvent }) => {
          runsByInst.set(id, (runsByInst.get(id) ?? 0) + 1);
          return {
            turn: async text => {
              onEvent({ type: 'message_start', message: { role: 'user', content: text } });
              onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
              entered.get(id)?.resolve();
              const res = await gates.get(id).promise;
              return { settled: Promise.resolve(res) };
            },
            steer: async () => {},
            interrupt: async () => {},
            stop: async () => { stopped.get(id)?.resolve(); },
          };
        },
      },
    });
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });

    const { active, interruptRun, kick } = await import('./src/waker.ts');

    // 1) Interrupted run that reports OOM at teardown does not auto-retry.
    const iInt = createInstance('sInt', 'P1', alice);
    gates.set(iInt.id, Promise.withResolvers());
    entered.set(iInt.id, Promise.withResolvers());
    stopped.set(iInt.id, Promise.withResolvers());
    iInt.append(alice, 'comment', { thread: 'c2', text: 'Go' });
    kick(iInt);
    await entered.get(iInt.id).promise;
    const interruptDone = interruptRun(active.get('sInt'));
    gates.get(iInt.id).resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
    await interruptDone;
    await new Promise(r => setTimeout(r, 150));
    assert.equal(runsByInst.get(iInt.id), 1);
    assert.equal(iInt.log.filter(e => e.op === 'wake').length, 0);

    // 2) Revoked autonomous consent mid-run blocks OOM auto-retry.
    const iRev = createInstance('sRev', 'P1', alice);
    gates.set(iRev.id, Promise.withResolvers());
    entered.set(iRev.id, Promise.withResolvers());
    stopped.set(iRev.id, Promise.withResolvers());
    iRev.append(alice, 'comment', { thread: 'c2', text: 'Go' });
    kick(iRev);
    await entered.get(iRev.id).promise;
    ownSeries('sRev', alice, [], false);
    gates.get(iRev.id).resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
    await stopped.get(iRev.id).promise;
    await new Promise(r => setTimeout(r, 150));
    assert.equal(runsByInst.get(iRev.id), 1);
    assert.equal(iRev.log.filter(e => e.op === 'wake').length, 0);

    // 3) Archived series mid-run blocks OOM auto-retry.
    const iArc = createInstance('sArc', 'P1', alice);
    gates.set(iArc.id, Promise.withResolvers());
    entered.set(iArc.id, Promise.withResolvers());
    stopped.set(iArc.id, Promise.withResolvers());
    iArc.append(alice, 'comment', { thread: 'c2', text: 'Go' });
    kick(iArc);
    await entered.get(iArc.id).promise;
    const t = tree();
    t.series.sArc.archived = true;
    saveTree(t);
    gates.get(iArc.id).resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
    await stopped.get(iArc.id).promise;
    await new Promise(r => setTimeout(r, 150));
    assert.equal(runsByInst.get(iArc.id), 1);
    assert.equal(iArc.log.filter(e => e.op === 'wake').length, 0);

    // 4) Non-OOM failure (ordinary error) does not auto-retry.
    const iErr = createInstance('sErr', 'P1', alice);
    gates.set(iErr.id, Promise.withResolvers());
    entered.set(iErr.id, Promise.withResolvers());
    stopped.set(iErr.id, Promise.withResolvers());
    iErr.append(alice, 'comment', { thread: 'c2', text: 'Go' });
    kick(iErr);
    await entered.get(iErr.id).promise;
    gates.get(iErr.id).resolve({ aborted: true, error: 'ordinary crash', oom: false });
    await stopped.get(iErr.id).promise;
    await new Promise(r => setTimeout(r, 150));
    assert.equal(runsByInst.get(iErr.id), 1);
    assert.equal(iErr.log.filter(e => e.op === 'wake').length, 0);
    await Promise.all([iInt, iRev, iArc, iErr].map(i => committed(i.dir)));
  `);
});
