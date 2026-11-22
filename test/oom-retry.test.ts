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

for (const autonomous of [false, true]) {
  test(`confirmed OOM triggers 1-shot fresh retry with rewound seen, preserved initiator, and lower-memory hint (autonomous=${autonomous})`, () => {
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

      const root = __ROOT__, alice = 'alice@demo.test', bob = 'bob@demo.test';
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [bob] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [alice]: { role: 'user' }, [bob]: { role: 'user' } });
      mkdirSync(root + '/series/s', { recursive: true });
      ownSeries('s', alice, [], ${autonomous});

      const prompts = [];
      let runs = 0;
      const done2 = Promise.withResolvers();
      mock.module('./src/runner.ts', {
        namedExports: {
          ...runner,
          startRun: async ({ onEvent }) => {
            const n = ++runs;
            return {
              turn: async text => {
                prompts.push(text);
                // Simulate Pi delivering the prompt and emitting toolUse message_end (advances a.seen) before bash OOMs.
                onEvent({ type: 'message_start', message: { role: 'user', content: text } });
                onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
                if (n === 1) return { settled: Promise.resolve({ aborted: true, error: runner.OOM_ERROR, oom: true }) };
                return { settled: Promise.resolve({ aborted: false }) };
              },
              steer: async () => {},
              interrupt: async () => {},
              stop: async () => { if (n === 2) done2.resolve(); },
            };
          },
        },
      });
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });

      const { kick, standing, CUT } = await import('./src/waker.ts');
      const inst = createInstance('s', 'P1', alice);
      const ask = inst.append('agent', 'comment', { thread: 'c2', text: 'Which workbook?', ask: 'question', to: bob });
      const reply = inst.append(bob, 'comment', { thread: 'c2', parent: ask.seq, text: 'Use the 200MB workbook.' });
      kick(inst);
      await done2.promise;
      await committed(inst.dir);

      assert.equal(runs, 2);
      const runEntries = inst.log.filter(e => e.op === 'run');
      assert.deepEqual(runEntries.map(e => [e.run, e.runner, e.initiator]), [[1, alice, bob], [2, alice, bob]]);
      const [d1, d2] = inst.log.filter(e => e.op === 'done');
      assert.equal(d1.oom, true);
      assert.equal(d1.error, runner.OOM_ERROR);
      assert.equal(d1.seen, 0, 'done 1 rewinds seen to priorSeen when issuing the OOM retry');
      assert.equal(d2.aborted, false);
      assert.equal(d2.error, undefined);
      assert.ok(d2.seen >= reply.seq);

      const wake = inst.log.find(e => e.op === 'wake');
      assert.equal(wake.from, 'server');
      assert.equal(wake.cause, d1.seq);
      assert.equal(wake.initiator, bob);
      assert.deepEqual(wake.recovery, { run: 1, reason: 'oom' });
      assert.match(wake.reason, /memory limit.*stream or chunk/i);
      assert.match(prompts[1], /Use the 200MB workbook\\./);
      assert.match(prompts[1], /memory limit/);

      // Non-OOM recovery wakes still strictly require autonomous consent.
      const cutWake = { seq: inst.log.length + 1, at: '', by: 'server', op: 'wake', from: 'server', authority: wake.authority, initiator: alice, recovery: { run: 2, reason: CUT.restart } };
      assert.equal(standing(inst, cutWake).starts, ${autonomous});
    `);
  });
}

test('1-shot cap blocks second OOM retry in same chain, resets after success, and blocks after Entra 401 login wake or superseding comment', () => {
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
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s1: { name: 'Cap', workspace: 'w' }, s2: { name: 'Supersede', workspace: 'w' }, s3: { name: 'Entra', workspace: 'w' } } });
    writeJson('users.json', { [alice]: { role: 'user' } });
    for (const sid of ['s1', 's2', 's3']) {
      mkdirSync(root + '/series/' + sid, { recursive: true });
      ownSeries(sid, alice, [], true);
    }

    const plan = new Map();
    const prompts = new Map();
    const wait = async (cond, label) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 30));
      assert.ok(cond(), 'timed out waiting for ' + label);
    };
    let confirmGate = null;
    let confirmErr = null;
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ id, onEvent }) => ({
          turn: async text => {
            (prompts.get(id) ?? prompts.set(id, []).get(id)).push(text);
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            const outcome = plan.get(id).shift();
            return { settled: Promise.resolve(outcome) };
          },
          steer: async () => {},
          interrupt: async () => {},
          stop: async () => {},
        }),
      },
    });
    mock.module('./src/entra.ts', {
      namedExports: {
        ...entra,
        confirm: async () => {
          if (confirmGate) await confirmGate.promise;
          if (confirmErr) { const e = confirmErr; confirmErr = null; throw e; }
        },
      },
    });

    const { kick } = await import('./src/waker.ts');
    const { changes } = await import('./src/system.ts');

    // 1. Two consecutive OOMs stop after 1 retry (done 2 keeps seen); then a succeeding run resets budget for a later OOM.
    const i1 = createInstance('s1', 'P1', alice);
    plan.set(i1.id, [
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: false },
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: false },
    ]);
    const c1 = i1.append(alice, 'comment', { text: 'Heavy job 1.' });
    kick(i1);
    await wait(() => i1.log.filter(e => e.op === 'done').length === 2, 'two OOM runs');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(i1.log.filter(e => e.op === 'run').length, 2, 'stops at 1 retry');
    const [d1, d2] = i1.log.filter(e => e.op === 'done');
    assert.equal(d1.seen, 0);
    assert.ok(d2.seen >= c1.seq, 'blocked retry keeps truthful done.seen');

    // Owner acts -> Run 3 succeeds -> Owner acts -> Run 4 OOMs -> gets fresh 1-shot retry Run 5.
    i1.append(alice, 'comment', { text: 'Smaller step.' });
    kick(i1);
    await wait(() => i1.log.filter(e => e.op === 'done').length === 3, 'run 3 success');
    i1.append(alice, 'comment', { text: 'Heavy job 2.' });
    kick(i1);
    await wait(() => i1.log.filter(e => e.op === 'done').length === 5, 'run 4 OOM + run 5 retry');
    assert.equal(i1.log.filter(e => e.op === 'wake' && e.recovery?.reason === 'oom').length, 2);

    // 2. Entra 401 on retry admission -> login wake -> Run 2 OOM still spends the same 1-shot budget.
    const i3 = createInstance('s3', 'P1', alice);
    plan.set(i3.id, [
      { aborted: true, error: runner.OOM_ERROR, oom: true },
      { aborted: true, error: runner.OOM_ERROR, oom: true },
    ]);
    confirmErr = null;
    i3.append(alice, 'comment', { text: 'Start s3.' });
    kick(i3);
    await wait(() => i3.log.some(e => e.op === 'run'), 's3 run 1 start');
    confirmErr = Object.assign(new Error('expired'), { status: 401 });
    await wait(() => i3.log.some(e => e.op === 'expired'), 's3 admission expired');
    // Owner signs back in -> login wake resumes -> Run 2 OOMs -> budget is ALREADY spent so NO 2nd OOM wake!
    changes.emit('login', alice, 'entra', 'rollforward');
    await wait(() => i3.log.filter(e => e.op === 'done').length === 2, 's3 run 2 OOM');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(i3.log.filter(e => e.op === 'run').length, 2, 'Entra 401 + login wake does not grant a second OOM retry');
    assert.equal(i3.log.filter(e => e.op === 'wake' && e.recovery?.reason === 'oom').length, 1);

    await Promise.all([i1, i3].map(i => committed(i.dir)));
  `);
});

test('superseding comment before OOM retry runs once coherently and still consumes the 1-shot budget', () => {
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

    let confirms = 0;
    const atSecondConfirm = Promise.withResolvers(), releaseSecond = Promise.withResolvers();
    const prompts = [];
    mock.module('./src/entra.ts', {
      namedExports: {
        ...entra,
        confirm: async () => {
          if (++confirms === 2) { atSecondConfirm.resolve(); await releaseSecond.promise; }
        },
      },
    });
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ onEvent }) => ({
          turn: async text => {
            prompts.push(text);
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            return { settled: Promise.resolve({ aborted: true, error: runner.OOM_ERROR, oom: true }) };
          },
          steer: async () => {},
          interrupt: async () => {},
          stop: async () => {},
        }),
      },
    });

    const { kick } = await import('./src/waker.ts');
    const inst = createInstance('s', 'P1', alice);
    inst.append(alice, 'comment', { text: 'Original heavy task.' });
    kick(inst);
    await atSecondConfirm.promise;
    inst.append(alice, 'comment', { text: 'Use streaming instead.' });
    releaseSecond.resolve();
    for (let i = 0; i < 100 && inst.log.filter(e => e.op === 'done').length < 2; i++) await new Promise(r => setTimeout(r, 30));
    await new Promise(r => setTimeout(r, 200));
    await committed(inst.dir);

    assert.equal(inst.log.filter(e => e.op === 'run').length, 2, 'one coherent retry run, no third run');
    assert.match(prompts[1], /Original heavy task\\./);
    assert.match(prompts[1], /Use streaming instead\\./);
    assert.match(prompts[1], /memory limit/);
    assert.equal(inst.log.filter(e => e.op === 'wake' && e.recovery?.reason === 'oom').length, 1);
  `);
});

test('replay-window and side-effect guards block unsafe retries and allow safe ones', () => {
  runScript(`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync } from 'node:fs';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, tree, writeJson } from './src/system.ts';
    import { ownSeries } from './test/owner-fixture.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { post } from './src/messages.ts';
    import { committed } from './src/git.ts';

    const root = __ROOT__, alice = 'alice@demo.test';
    initSystem(root);
    openStore(root);
    writeJson('users.json', { [alice]: { role: 'user' } });
    writeJson('egress.json', ['api.partner.example']);
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { other: { name: 'Other', workspace: 'w' } } });
    mkdirSync(root + '/series/other', { recursive: true });
    ownSeries('other', alice, [], false);
    const otherInst = createInstance('other', 'Target', alice);

    const hooks = new Map();
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ id, n, onEvent }) => ({
          turn: async text => {
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            const hook = hooks.get(id);
            const res = hook ? await hook(n) : { aborted: true, error: runner.OOM_ERROR, oom: true };
            return { settled: Promise.resolve(res) };
          },
          steer: async () => {},
          interrupt: async () => {},
          stop: async () => {},
        }),
      },
    });

    const { active, kick, CUT } = await import('./src/waker.ts');
    const wait = async (cond, label) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 25));
      assert.ok(cond(), 'timed out: ' + label);
    };

    let idx = 0;
    const makeSeries = (autonomous = false) => {
      const sid = 's' + (++idx), t = tree();
      t.series[sid] = { name: 'S' + idx, workspace: 'w' };
      saveTree(t);
      mkdirSync(root + '/series/' + sid, { recursive: true });
      ownSeries(sid, alice, [], autonomous);
      return createInstance(sid, 'P1', alice);
    };

    const runCase = async (name, setup, expectRetry, autonomous = false) => {
      const inst = makeSeries(autonomous);
      hooks.set(inst.id, async n => {
        if (n === 1) {
          await setup(inst, active.get(inst.seriesId));
          return { aborted: true, error: runner.OOM_ERROR, oom: true };
        }
        return { aborted: false };
      });
      inst.append(alice, 'comment', { text: 'Go.' });
      kick(inst);
      await wait(() => inst.log.filter(e => e.op === 'done').length >= (expectRetry ? 2 : 1), name);
      if (!expectRetry) await new Promise(r => setTimeout(r, 150));
      const wakes = inst.log.filter(e => e.op === 'wake' && e.recovery?.reason === 'oom').length;
      assert.equal(wakes, expectRetry ? 1 : 0, name + ': expected retry=' + expectRetry);
      await committed(inst.dir);
    };

    // Run all independent series cases in parallel so debounce waits overlap (~2s total instead of ~25s).
    await Promise.all([
      // Blocked cases:
      runCase('send', i => i.append('agent', 'send', { run: 1, name: 'graph', method: 'POST', path: '/sendMail' }), false),
      runCase('send then steer then OOM', i => {
        i.append('agent', 'send', { run: 1, name: 'graph', method: 'POST', path: '/sendMail' });
        i.append(alice, 'comment', { text: 'Also check B.' });
        kick(i);
      }, false),
      runCase('delivered', i => i.append('agent', 'delivered', { run: 1, item: 'out', to: 'bob', receipt: 'r1' }), false),
      runCase('cross-instance said with foreign seq=1', i => {
        for (let k = 0; k < 5; k++) i.append('server', 'screen', { rev: k + 1 });
        i.append('agent', 'said', { run: 1, inst: otherInst.id, label: otherInst.label, seq: 1, thread: 'c1' });
      }, false),
      runCase('cross-instance corrected with foreign seq=1', i => {
        for (let k = 0; k < 5; k++) i.append('server', 'screen', { rev: k + 1 });
        i.append('agent', 'corrected', { run: 1, inst: otherInst.id, label: otherInst.label, seq: 1, kind: 'wrong' });
      }, false),
      runCase('series note on another series in same workspace', (i, a) => {
        post({ op: 'note', book: root + '/series/other', by: 'agent', text: 'Heads up.', files: [], run: { inst: i, n: 1, runner: a.runner } });
      }, false),
      runCase('series note on recipient series later moved to another workspace', (i, a) => {
        const t = tree();
        t.workspaces.w2 = { name: 'OtherWS', owners: [alice], members: [] };
        t.series.moved = { name: 'Moved', workspace: 'w' };
        saveTree(t);
        mkdirSync(root + '/series/moved', { recursive: true });
        ownSeries('moved', alice, [], false);
        post({ op: 'note', book: root + '/series/moved', by: 'agent', text: 'Moved note.', files: [], run: { inst: i, n: 1, runner: a.runner } });
        const t2 = tree();
        t2.series.moved.workspace = 'w2';
        saveTree(t2);
      }, false),
      runCase('series note taken settlement by agent', (i, a) => {
        const n1 = post({ op: 'note', book: root + '/series/' + i.seriesId, by: alice, text: 'Use 5%.', files: [] });
        post({ op: 'taken', book: root + '/series/' + i.seriesId, by: 'agent', on: n1, text: 'Applied.', run: { inst: i, n: 1, runner: a.runner } });
      }, false),
      runCase('refused then allowed egress to admin-added host', i => {
        i.append('server', 'egress', { run: 1, host: 'api.partner.example', allowed: false });
        i.append('server', 'egress', { run: 1, host: 'api.partner.example', allowed: true });
      }, false),
      runCase('non-print browser log entry', i => i.append('server', 'browser', { run: 1, site: 'erp', requests: 1, writes: 0 }), false),
      runCase('browsers error entry', i => i.append('server', 'browsers', { run: 1, error: 'close failed' }), false),
      runCase('live website browser in a.browsers.websites()', (_i, a) => {
        a.browsers = { websites: () => true, cut() {}, end: async () => {} };
      }, false),
      runCase('admin-added egress host', i => i.append('server', 'egress', { run: 1, host: 'api.partner.example', allowed: true }), false),
      runCase('login expired in run', i => i.append('server', 'expired', { run: 1, login: 'm365', name: 'M365', runner: alice }), false),
      // Allowed cases (Matthew rules 2A + 3A):
      runCase('own-instance plain report, ask, and proposal', i => {
        i.append('agent', 'comment', { run: 1, thread: 'c3', text: 'Part 1 done.' });
        i.append('agent', 'comment', { run: 1, thread: 'c4', text: 'Confirm?', ask: 'proposal' });
      }, true),
      runCase('built-in egress host and refused egress', i => {
        i.append('server', 'egress', { run: 1, host: 'pypi.org', allowed: true });
        i.append('server', 'egress', { run: 1, host: 'blocked.example', allowed: false });
      }, true),
      runCase('print browser only', (i, a) => {
        i.append('server', 'browser', { run: 1, site: 'print', requests: 1, writes: 0 });
        a.browsers = { websites: () => false, cut() {}, end: async () => {} };
      }, true),
      // Regression: send -> restart cut (seen rewound) -> queued c7 -> Run 2 OOM MUST block (autonomous AND non-autonomous).
      ...[true, false].map(async auto => {
        const i = makeSeries(auto);
        const c2 = i.append(alice, 'comment', { text: 'Send report.' });
        const r1 = i.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: auto }, upto: c2.seq });
        i.append('agent', 'send', { run: 1, name: 'graph', method: 'POST', path: '/sendMail' });
        const d1 = i.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0, error: CUT.restart });
        if (auto) i.append('server', 'wake', { from: 'server', cause: d1.seq, initiator: alice, authority: r1.authority, recovery: { run: 1, reason: CUT.restart }, reason: 'restart' });
        i.append(alice, 'comment', { text: 'Also check Q3.' });
        hooks.set(i.id, async () => ({ aborted: true, error: runner.OOM_ERROR, oom: true }));
        kick(i);
        await wait(() => i.log.filter(e => e.op === 'done').length === 2, 'restart-cut send auto=' + auto);
        await new Promise(r => setTimeout(r, 150));
        assert.equal(i.log.filter(e => e.op === 'wake' && e.recovery?.reason === 'oom').length, 0, 'blocks replay of Run 1 send after restart cut (auto=' + auto + ')');
        await committed(i.dir);
      }),
      // Regression: earlier SUCCEEDED Run 1 with send does NOT falsely poison a clean Run 2 OOM retry.
      (async () => {
        const i = makeSeries(false);
        const c2 = i.append(alice, 'comment', { text: 'Send Part 1.' });
        i.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: false }, upto: c2.seq });
        i.append('agent', 'send', { run: 1, name: 'graph', method: 'POST', path: '/sendMail' });
        i.append('server', 'done', { run: 1, aborted: false, seen: c2.seq, cost: 0 });
        i.append(alice, 'comment', { text: 'Now process big Part 2 locally.' });
        hooks.set(i.id, async n => n === 2 ? { aborted: true, error: runner.OOM_ERROR, oom: true } : { aborted: false });
        kick(i);
        await wait(() => i.log.filter(e => e.op === 'done').length === 3, 'clean Run 2 after succeeded Run 1 send');
        assert.equal(i.log.filter(e => e.op === 'wake' && e.recovery?.reason === 'oom').length, 1, 'earlier succeeded Run 1 send does not block Run 2 retry');
        await committed(i.dir);
      })(),
    ]);
  `);
});

test('interrupt during cost drain and late steer rejection never trigger or overwrite OOM verdicts; archive cancels pending OOM retry permanently', () => {
  runScript(`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync } from 'node:fs';
    import * as runner from './src/runner.ts';
    import * as connections from './src/connections.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, tree, writeJson } from './src/system.ts';
    import { ownSeries } from './test/owner-fixture.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { committed } from './src/git.ts';

    const root = __ROOT__, alice = 'alice@demo.test';
    initSystem(root);
    openStore(root);
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s1: { name: 'Int', workspace: 'w' }, s2: { name: 'Steer', workspace: 'w' }, s3: { name: 'Arch', workspace: 'w' } } });
    writeJson('users.json', { [alice]: { role: 'user' } });
    for (const sid of ['s1', 's2', 's3']) {
      mkdirSync(root + '/series/' + sid, { recursive: true });
      ownSeries(sid, alice, [], false);
    }

    let drainEnabled = false, draining = null, charge = null, steerReject = null, settledMap = new Map(), turnedMap = new Map();
    mock.module('./src/connections.ts', {
      namedExports: {
        ...connections,
        hasCalls: () => drainEnabled,
        abortCalls: () => {},
        drainCalls: () => { draining?.resolve(); return charge.promise; },
      },
    });
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ id, n, onEvent }) => ({
          turn: async text => {
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            const s = Promise.withResolvers();
            settledMap.set(id + ':' + n, s);
            turnedMap.get(id + ':' + n)?.resolve();
            return { settled: s.promise };
          },
          steer: () => steerReject ? steerReject.promise : Promise.resolve(),
          interrupt: async () => {},
          stop: async () => {},
        }),
      },
    });

    const { active, cancelPendingOom, interruptRun, kick } = await import('./src/waker.ts');

    // 1. Interrupt during drainCalls after OOM suppresses OOM retry.
    const i1 = createInstance('s1', 'P1', alice);
    turnedMap.set(i1.id + ':1', Promise.withResolvers());
    drainEnabled = true;
    draining = Promise.withResolvers();
    charge = Promise.withResolvers();
    i1.append(alice, 'comment', { text: 'Go.' });
    kick(i1);
    await turnedMap.get(i1.id + ':1').promise;
    await new Promise(r => setImmediate(r));
    const a1 = active.get('s1');
    settledMap.get(i1.id + ':1').resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
    await draining.promise;
    const interrupted = interruptRun(a1);
    charge.resolve();
    await interrupted;
    assert.equal(i1.log.filter(e => e.op === 'wake').length, 0, 'interrupt during cost drain suppresses OOM retry');

    // 2. Late rejected steer during drainCalls cannot overwrite OOM verdict.
    const i2 = createInstance('s2', 'P1', alice);
    turnedMap.set(i2.id + ':1', Promise.withResolvers());
    turnedMap.set(i2.id + ':2', Promise.withResolvers());
    draining = Promise.withResolvers();
    charge = Promise.withResolvers();
    steerReject = Promise.withResolvers();
    i2.append(alice, 'comment', { text: 'Go.' });
    kick(i2);
    await turnedMap.get(i2.id + ':1').promise;
    await new Promise(r => setImmediate(r));
    i2.append(alice, 'comment', { text: 'Mid-run steer.' });
    kick(i2);
    settledMap.get(i2.id + ':1').resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
    await draining.promise;
    steerReject.reject(new Error('steer after exit'));
    await new Promise(r => setImmediate(r));
    drainEnabled = false;
    steerReject = null;
    charge.resolve();
    await turnedMap.get(i2.id + ':2').promise;
    await new Promise(r => setImmediate(r));
    settledMap.get(i2.id + ':2').resolve({ aborted: false });
    for (let k = 0; k < 50 && i2.log.filter(e => e.op === 'done').length < 2; k++) await new Promise(r => setTimeout(r, 25));
    const [d21] = i2.log.filter(e => e.op === 'done');
    assert.equal(d21.oom, true);
    assert.equal(d21.error, runner.OOM_ERROR);

    // 3. Archive cancels pending OOM retry with quiet interrupt so restoring never revives it (verified past 1.5s debounce),
    //    and a new owner act after restore gets a fresh 1-shot retry budget.
    const i3 = createInstance('s3', 'P1', alice);
    const lease = { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: false };
    i3.append(alice, 'comment', { text: 'Go.' });
    i3.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease, upto: 2 });
    const d3 = i3.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0, error: runner.OOM_ERROR, oom: true });
    i3.append('server', 'wake', { from: 'server', cause: d3.seq, initiator: alice, authority: lease, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });
    const t = tree();
    t.series.s3.archived = true;
    saveTree(t);
    cancelPendingOom([i3], alice);
    assert.ok(i3.log.some(e => e.op === 'interrupt' && e.quiet === true && e.why === 'archived'));
    t.series.s3.archived = false;
    saveTree(t);
    kick(i3);
    await new Promise(r => setTimeout(r, 1800));
    assert.equal(i3.log.filter(e => e.op === 'run').length, 1, 'restoring after archive does not revive cancelled OOM retry even past debounce');

    // New owner comment after restore runs and gets a fresh OOM retry.
    turnedMap.set(i3.id + ':2', Promise.withResolvers());
    turnedMap.set(i3.id + ':3', Promise.withResolvers());
    i3.append(alice, 'comment', { text: 'Fresh instruction after restore.' });
    kick(i3);
    await turnedMap.get(i3.id + ':2').promise;
    await new Promise(r => setImmediate(r));
    settledMap.get(i3.id + ':2').resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
    await turnedMap.get(i3.id + ':3').promise;
    await new Promise(r => setImmediate(r));
    settledMap.get(i3.id + ':3').resolve({ aborted: false });
    for (let k = 0; k < 50 && i3.log.filter(e => e.op === 'done').length < 3; k++) await new Promise(r => setTimeout(r, 25));
    assert.equal(i3.log.filter(e => e.op === 'run').length, 3);

    await Promise.all([i1, i2, i3].map(i => committed(i.dir)));
  `);
});

for (const autonomous of [false, true]) {
  test(`CUT.reach and remove() CUT.gone during drainCalls record factual done.oom with neither OOM wake nor cut wake (autonomous=${autonomous})`, () => {
    runScript(`
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { mkdirSync } from 'node:fs';
      import * as runner from './src/runner.ts';
      import * as connections from './src/connections.ts';
      import * as entra from './src/entra.ts';
      import { initSystem, saveTree, tree, writeJson } from './src/system.ts';
      import { ownSeries } from './test/owner-fixture.ts';
      import { createInstance, openStore } from './src/store.ts';
      import { committed } from './src/git.ts';

      const root = __ROOT__, alice = 'alice@demo.test';
      initSystem(root);
      openStore(root);
      saveTree({
        workspaces: {
          w: { name: 'Work', owners: [alice], members: [] },
          ext: { name: 'Ext', owners: [alice], members: [], readers: ['w'] },
        },
        series: {
          sReach: { name: 'SReach', workspace: 'w' },
          sGone: { name: 'SGone', workspace: 'w' },
          sExt: { name: 'SExt', workspace: 'ext' },
        },
      });
      writeJson('users.json', { [alice]: { role: 'admin' } });
      for (const sid of ['sReach', 'sGone', 'sExt']) {
        mkdirSync(root + '/series/' + sid, { recursive: true });
        ownSeries(sid, alice, [], ${autonomous});
      }
      const extInst = createInstance('sExt', 'Ref', alice);

      let draining = null, charge = null, settledMap = new Map(), turnedMap = new Map();
      mock.module('./src/connections.ts', {
        namedExports: {
          ...connections,
          hasCalls: () => true,
          abortCalls: () => {},
          drainCalls: () => { draining?.resolve(); return charge.promise; },
        },
      });
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
      mock.module('./src/runner.ts', {
        namedExports: {
          ...runner,
          startRun: async ({ id, n, onEvent }) => ({
            turn: async text => {
              onEvent({ type: 'message_start', message: { role: 'user', content: text } });
              onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
              const s = Promise.withResolvers();
              settledMap.set(id + ':' + n, s);
              turnedMap.get(id + ':' + n)?.resolve();
              return { settled: s.promise };
            },
            steer: async () => {},
            interrupt: async () => {},
            stop: async () => {},
          }),
        },
      });

      const { kick, remove } = await import('./src/waker.ts');

      // 1. CUT.reach arriving while OOM run is draining calls.
      const iReach = createInstance('sReach', 'P1', alice);
      turnedMap.set(iReach.id + ':1', Promise.withResolvers());
      draining = Promise.withResolvers();
      charge = Promise.withResolvers();
      iReach.append(alice, 'comment', { text: 'Go.' });
      kick(iReach);
      await turnedMap.get(iReach.id + ':1').promise;
      await new Promise(r => setImmediate(r));
      settledMap.get(iReach.id + ':1').resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
      await draining.promise;
      // Narrow reach -> triggers leases() -> cut(a, CUT.reach).
      const t1 = tree();
      t1.workspaces.ext.readers = [];
      saveTree(t1);
      charge.resolve();
      for (let k = 0; k < 50 && !iReach.log.some(e => e.op === 'done'); k++) await new Promise(r => setTimeout(r, 25));
      await new Promise(r => setTimeout(r, 200));
      assert.equal(iReach.log.filter(e => e.op === 'done').length, 1);
      assert.equal(iReach.log.find(e => e.op === 'done').oom, true);
      assert.equal(iReach.log.filter(e => e.op === 'wake').length, 0, 'CUT.reach during drain emits neither OOM wake nor cut wake');

      // Restore reader link for remove() CUT.gone test.
      const t2 = tree();
      t2.workspaces.ext.readers = ['w'];
      saveTree(t2);

      // 2. remove() CUT.gone arriving while OOM run reading extInst is draining calls.
      const iGone = createInstance('sGone', 'P1', alice);
      turnedMap.set(iGone.id + ':1', Promise.withResolvers());
      draining = Promise.withResolvers();
      charge = Promise.withResolvers();
      iGone.append(alice, 'comment', { text: 'Go.' });
      kick(iGone);
      await turnedMap.get(iGone.id + ':1').promise;
      await new Promise(r => setImmediate(r));
      settledMap.get(iGone.id + ':1').resolve({ aborted: true, error: runner.OOM_ERROR, oom: true });
      await draining.promise;
      const deleting = remove(extInst, alice, () => ({ cost: 0, runs: [] }));
      charge.resolve();
      await deleting;
      await new Promise(r => setTimeout(r, 200));
      assert.equal(iGone.log.filter(e => e.op === 'done').length, 1);
      assert.equal(iGone.log.find(e => e.op === 'done').oom, true);
      assert.equal(iGone.log.filter(e => e.op === 'wake').length, 0, 'remove() CUT.gone during drain emits neither OOM wake nor cut wake');

      await Promise.all([iReach, iGone].map(i => committed(i.dir)));
    `);
  });
}

test('mixed-queue archive cancels OOM wake while preserving later owner comment across reload, and post-confirm reselects newer cause', () => {
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
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Mixed', workspace: 'w' } } });
    writeJson('users.json', { [alice]: { role: 'user' } });
    mkdirSync(root + '/series/s', { recursive: true });
    ownSeries('s', alice, [], false);

    let confirms = 0;
    const atConfirm = Promise.withResolvers(), releaseConfirm = Promise.withResolvers();
    mock.module('./src/entra.ts', {
      namedExports: {
        ...entra,
        confirm: async () => {
          if (++confirms === 1) { atConfirm.resolve(); await releaseConfirm.promise; }
        },
      },
    });
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ onEvent }) => ({
          turn: async text => {
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            return { settled: Promise.resolve({ aborted: false }) };
          },
          steer: async () => {},
          interrupt: async () => {},
          stop: async () => {},
        }),
      },
    });

    const { cancelPendingOom, kick } = await import('./src/waker.ts');
    const inst = createInstance('s', 'P1', alice);
    const lease = { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: false };
    inst.append(alice, 'comment', { text: 'Initial.' });
    inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease, upto: 2 });
    const d1 = inst.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0, error: runner.OOM_ERROR, oom: true });
    inst.append('server', 'wake', { from: 'server', cause: d1.seq, initiator: alice, authority: lease, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });
    // Begin admission for OOM wake, then while confirm() is pending, owner posts a comment, series archives and restores.
    kick(inst);
    await atConfirm.promise;
    const c6 = inst.append(alice, 'comment', { text: 'Do the light path instead.' });
    const t = tree();
    t.series.s.archived = true;
    saveTree(t);
    cancelPendingOom([inst], alice);
    assert.ok(inst.log.some(e => e.op === 'interrupt' && e.quiet === true && e.why === 'archived'), 'mixed queue still records quiet archive interrupt');
    t.series.s.archived = false;
    saveTree(t);
    releaseConfirm.resolve();
    for (let k = 0; k < 100 && inst.log.filter(e => e.op === 'done').length < 2; k++) await new Promise(r => setTimeout(r, 30));
    await committed(inst.dir);

    const run2 = inst.log.find(e => e.op === 'run' && e.run === 2);
    assert.equal(run2.provenance.cause, c6.seq, 'post-confirm recheck credits the newer owner comment as cause');
    assert.equal(run2.provenance.recovery, undefined, 'cancelled OOM wake does not stamp recovery on the comment run');
  `);
});

test('mixed-queue archive during 401 confirm rechecks cause before writing expired, then lets preserved comment run after sign-in', () => {
  runScript(`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync } from 'node:fs';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { changes, initSystem, saveTree, tree, writeJson } from './src/system.ts';
    import { ownSeries } from './test/owner-fixture.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { committed } from './src/git.ts';

    const root = __ROOT__, alice = 'alice@demo.test';
    initSystem(root);
    openStore(root);
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Mixed401', workspace: 'w' } } });
    writeJson('users.json', { [alice]: { role: 'user' } });
    mkdirSync(root + '/series/s', { recursive: true });
    ownSeries('s', alice, [], false);

    let confirms = 0;
    const atFirstConfirm = Promise.withResolvers(), releaseFirst = Promise.withResolvers();
    mock.module('./src/entra.ts', {
      namedExports: {
        ...entra,
        confirm: async () => {
          confirms++;
          if (confirms === 1) {
            atFirstConfirm.resolve();
            await releaseFirst.promise;
            throw Object.assign(new Error('expired'), { status: 401 });
          }
          if (confirms === 2) throw Object.assign(new Error('expired'), { status: 401 });
        },
      },
    });
    mock.module('./src/runner.ts', {
      namedExports: {
        ...runner,
        startRun: async ({ onEvent }) => ({
          turn: async text => {
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            return { settled: Promise.resolve({ aborted: false }) };
          },
          steer: async () => {},
          interrupt: async () => {},
          stop: async () => {},
        }),
      },
    });

    const { cancelPendingOom, kick } = await import('./src/waker.ts');
    const inst = createInstance('s', 'P1', alice);
    const lease = { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: false };
    inst.append(alice, 'comment', { text: 'Initial.' });
    inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease, upto: 2 });
    const d1 = inst.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0, error: runner.OOM_ERROR, oom: true });
    const w1 = inst.append('server', 'wake', { from: 'server', cause: d1.seq, initiator: alice, authority: lease, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });
    kick(inst);
    await atFirstConfirm.promise;
    const c6 = inst.append(alice, 'comment', { text: 'Preserved owner comment.' });
    const t = tree();
    t.series.s.archived = true;
    saveTree(t);
    cancelPendingOom([inst], alice);
    t.series.s.archived = false;
    saveTree(t);
    releaseFirst.resolve();
    for (let k = 0; k < 100 && !inst.log.some(e => e.op === 'expired'); k++) await new Promise(r => setTimeout(r, 25));
    const exp = inst.log.find(e => e.op === 'expired');
    assert.ok(exp, 'second confirm writes expired');
    assert.equal(exp.cause, c6.seq, 'expired is recorded against preserved comment c6, never stale cancelled OOM wake');
    assert.notEqual(exp.cause, w1.seq);
    assert.equal(exp.initiator, alice);

    // Owner signs back in -> preserved comment c6 runs cleanly (note non-autonomous login wake is quiet, so owner re-kicking or autonomous login runs c6; here enable autonomous or verify next kick runs c6).
    changes.emit('login', alice, 'entra', 'rollforward');
    inst.append(alice, 'comment', { text: 'Signed back in.' });
    kick(inst);
    for (let k = 0; k < 100 && inst.log.filter(e => e.op === 'done').length < 2; k++) await new Promise(r => setTimeout(r, 30));
    await committed(inst.dir);
    assert.equal(inst.log.filter(e => e.op === 'run').length, 2);
  `);
});

test('rf comment --wait terminates identically on cancelled OOM retry before or after a later run or authority transfer', async () => {
  const { createServer } = await import('node:http');
  const { OOM_ERROR } = await import('../src/runner.ts');
  const root = mkdtempSync(join(tmpdir(), 'rf-wait-'));
  let log: any[] = [];
  const srv = createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (url === '/api') {
      return void res.end(JSON.stringify([{ id: 'w', name: 'W', series: [{ id: 's', name: 'S', instances: [{ id: 'i1', label: 'P1', status: 'open' }] }] }]));
    }
    if (url === '/api/messages' && req.method === 'POST') {
      res.setHeader('X-RF-Comment-Seq', '2');
      return void res.end(JSON.stringify({ seq: 2 }));
    }
    if (url === '/api/instances/i1') {
      return void res.end(JSON.stringify({ doc: { status: 'open' }, owner: { by: 'alice@demo.test' }, starts: true, standing: { 2: 'runner' }, log }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as { port: number }).port;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const execFileAsync = promisify(execFile);
    mkdirSync(join(root, '.config'), { recursive: true });
    writeFileSync(join(root, '.config', 'rollforward.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'rft_wait' }));
    const runWait = async () => (await execFileAsync(process.execPath, ['src/rf-people.ts', 'comment', 'W/S/P1', '--wait', 'Go.'], {
      cwd,
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
      timeout: 20_000,
    })).stdout;
    const base = [
      { seq: 1, by: 'alice@demo.test', op: 'create' },
      { seq: 2, by: 'alice@demo.test', op: 'comment', thread: 'c2', text: 'Go.' },
      { seq: 3, by: 'server', op: 'run', run: 1 },
      { seq: 4, by: 'server', op: 'done', run: 1, aborted: true, seen: 0, error: OOM_ERROR, oom: true },
      { seq: 5, by: 'server', op: 'wake', from: 'server', cause: 4, recovery: { run: 1, reason: 'oom' } },
    ];
    // 1. Archive interrupt BEFORE any later run.
    log = [...base, { seq: 6, by: 'alice@demo.test', op: 'interrupt', quiet: true, why: 'archived' }];
    assert.match(await runWait(), new RegExp(`The run failed: ${OOM_ERROR.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
    // 2. Archive interrupt AFTER a later restored run finished — poll timing must NOT change the verdict.
    log = [
      ...base,
      { seq: 6, by: 'alice@demo.test', op: 'interrupt', quiet: true, why: 'archived' },
      { seq: 7, by: 'alice@demo.test', op: 'comment', thread: 'c7', text: 'Later.' },
      { seq: 8, by: 'server', op: 'run', run: 2 },
      { seq: 9, by: 'agent', op: 'comment', thread: 'c7', text: 'Unrelated later reply.' },
      { seq: 10, by: 'server', op: 'done', run: 2, aborted: false, seen: 7 },
    ];
    const outAfter = await runWait();
    assert.match(outAfter, /The run failed: out of memory/);
    assert.doesNotMatch(outAfter, /Unrelated later reply/);
    // 3. Authority transfer followed by new owner's run — Alice's waiter must NOT report Bob's run.
    log = [
      ...base,
      { seq: 6, by: 'server', op: 'authority', owner: 'bob@demo.test', epoch: 2, workspace: 'w' },
      { seq: 7, by: 'bob@demo.test', op: 'comment', thread: 'c7', text: 'Bob work.' },
      { seq: 8, by: 'server', op: 'run', run: 2 },
      { seq: 9, by: 'agent', op: 'comment', thread: 'c7', text: 'Bob secret output.' },
      { seq: 10, by: 'server', op: 'done', run: 2, aborted: false, seen: 7 },
    ];
    const outTransfer = await runWait();
    assert.match(outTransfer, /The run failed: out of memory/);
    assert.doesNotMatch(outTransfer, /Bob secret output/);
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('server API reports OOM runs as failed (memory), counts both runs and costs, and cancels pending OOM wakes on series/workspace archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-oom-api-'));
  let proc: import('node:child_process').ChildProcess | undefined;
  let entra: Awaited<ReturnType<typeof import('./idp.ts').idp>> | undefined;
  try {
    const { spawn } = await import('node:child_process');
    const { createServer } = await import('node:http');
    const { idp } = await import('./idp.ts');
    entra = await idp();
    const { initSystem, saveTree, writeJson } = await import('../src/system.ts');
    const { createInstance, openStore } = await import('../src/store.ts');
    const { ownSeries } = await import('./owner-fixture.ts');
    const { OOM_ERROR } = await import('../src/runner.ts');
    const { keepSignIn } = await import('../src/entra.ts');
    const { createHash } = await import('node:crypto');
    const { mkdirSync } = await import('node:fs');
    const alice = 'alice@demo.test', token = 'rft_test_oom_api_token', at = new Date().toISOString();
    initSystem(root);
    openStore(root);
    writeJson('users.json', { [alice]: { role: 'admin', name: 'Alice', created: at, epoch: 1 } });
    writeJson('tokens.json', { [createHash('sha256').update(token).digest('hex')]: { id: 'oom-api', email: alice, name: 'test', created: at, expires: '2099-01-01T00:00:00Z', epoch: 1 } });
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] }, w2: { name: 'Work2', owners: [alice], members: [] } }, series: { s: { name: 'Rec', workspace: 'w' }, s2: { name: 'Rec2', workspace: 'w2' } } });
    mkdirSync(join(root, 'series', 's'), { recursive: true });
    mkdirSync(join(root, 'series', 's2'), { recursive: true });
    ownSeries('s', alice, [], false);
    ownSeries('s2', alice, [], false);
    keepSignIn(alice, entra.refresh(alice));
    const inst = createInstance('s', '2026-11', alice);
    const lease = { version: 1, owner: alice, epoch: 1, workspace: 'w', logins: [], autonomous: false };
    const c2 = inst.append(alice, 'comment', { text: 'Run it.' });
    inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease, provenance: { cause: c2.seq }, upto: c2.seq });
    const d1 = inst.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0.12, estimated: false, error: OOM_ERROR, oom: true });
    const w1 = inst.append('server', 'wake', { from: 'server', cause: d1.seq, initiator: alice, authority: lease, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });
    inst.append('server', 'run', { run: 2, runner: alice, initiator: alice, authority: lease, provenance: { cause: w1.seq, from: 'server', recovery: { run: 1, reason: 'oom' } }, upto: w1.seq });
    inst.append('server', 'done', { run: 2, aborted: false, seen: w1.seq, cost: 0.18, estimated: false });

    // Second open instance in s with a pending OOM wake (tested via series archive).
    const inst2 = createInstance('s', '2026-12', alice);
    const c2b = inst2.append(alice, 'comment', { text: 'Run 2.' });
    inst2.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease, provenance: { cause: c2b.seq }, upto: c2b.seq });
    const d1b = inst2.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0.05, estimated: false, error: OOM_ERROR, oom: true });
    inst2.append('server', 'wake', { from: 'server', cause: d1b.seq, initiator: alice, authority: lease, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });

    // Open instance in w2/s2 with a pending OOM wake (tested via workspace archive).
    const inst3 = createInstance('s2', '2026-12', alice);
    const lease2 = { version: 1, owner: alice, epoch: 1, workspace: 'w2', logins: [], autonomous: false };
    const c2c = inst3.append(alice, 'comment', { text: 'Run 3.' });
    inst3.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease2, provenance: { cause: c2c.seq }, upto: c2c.seq });
    const d1c = inst3.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0.05, estimated: false, error: OOM_ERROR, oom: true });
    inst3.append('server', 'wake', { from: 'server', cause: d1c.seq, initiator: alice, authority: lease2, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });

    const port = await new Promise<number>(ok => {
      const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
    });
    proc = spawn(process.execPath, ['src/server.ts', root, String(port)], {
      cwd,
      env: { ...process.env, RF_MAX_RUNS: '0', RF_MIN_FREE_GB: '0', RF_SANDBOX_SCOPE: '', RF_WAKE_TICK_MS: '60000', ...entra.env(`http://127.0.0.1:${port}`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '', stdout = '';
    proc.stderr!.on('data', d => (stderr += d));
    await new Promise<void>((ok, fail) => {
      proc!.once('exit', code => fail(new Error(`server exited ${code}: ${stderr}`)));
      proc!.stdout!.on('data', d => {
        stdout += d;
        if (/^rollforward on http:\/\/127\.0\.0\.1:\d+,/m.test(stdout)) ok();
      });
    });
    const api = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    const runsResp = await (await api('GET', '/api/runs')).json() as any[];
    const p1Runs = runsResp.filter(r => r.path === 'Work/Rec/2026-11');
    assert.equal(p1Runs.length, 2, stderr);
    assert.equal(p1Runs[0].outcome, 'failed');
    assert.equal(p1Runs[0].failure, 'memory');
    assert.equal(p1Runs[0].cost, 0.12);
    assert.equal(p1Runs[1].outcome, 'done');
    assert.equal(p1Runs[1].failure, null);
    assert.equal(p1Runs[1].cost, 0.18);
    assert.deepEqual(p1Runs[1].started, { op: 'wake', by: 'server' });

    // Archive series -> cancels inst2's pending OOM wake with quiet interrupt.
    assert.equal((await api('PUT', '/api/series/s', { archived: true })).status, 200);
    const detail = await (await api('GET', `/api/instances/${inst2.id}`)).json() as { log: any[] };
    assert.ok(detail.log.some(e => e.op === 'interrupt' && e.quiet === true && e.why === 'archived'), 'series archive appends quiet interrupt to pending OOM retry');

    // Archive workspace -> cancels inst3's pending OOM wake with quiet interrupt.
    assert.equal((await api('PUT', '/api/workspaces/w2', { archived: true })).status, 200);
    const detail3 = await (await api('GET', `/api/instances/${inst3.id}`)).json() as { log: any[] };
    assert.ok(detail3.log.some(e => e.op === 'interrupt' && e.quiet === true && e.why === 'archived'), 'workspace archive appends quiet interrupt to pending OOM retry');

    // Mixed-queue archive across server restart/reload: pending [oomWake, ownerComment] cancels wake and preserves comment on restore.
    const inst4 = createInstance('s2', '2026-13', alice);
    // Unarchive w2 first via API so we can test archiving s2 with a mixed queue, then reload server.
    assert.equal((await api('PUT', '/api/workspaces/w2', { archived: false })).status, 200);
    const c2d = inst4.append(alice, 'comment', { text: 'Initial mixed.' });
    inst4.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease2, provenance: { cause: c2d.seq }, upto: c2d.seq });
    const d1d = inst4.append('server', 'done', { run: 1, aborted: true, seen: 0, cost: 0.05, estimated: false, error: OOM_ERROR, oom: true });
    inst4.append('server', 'wake', { from: 'server', cause: d1d.seq, initiator: alice, authority: lease2, recovery: { run: 1, reason: 'oom' }, reason: 'retry' });
    const cAfter = inst4.append(alice, 'comment', { text: 'Preserved owner instruction.' });
    // Reboot server so it loads inst4 from disk, archive s2, verify quiet interrupt, reboot again and verify restore keeps cAfter runnable.
    proc.kill();
    await new Promise(ok => proc!.once('exit', ok));
    proc = spawn(process.execPath, ['src/server.ts', root, String(port)], {
      cwd,
      env: { ...process.env, RF_MAX_RUNS: '0', RF_MIN_FREE_GB: '0', RF_SANDBOX_SCOPE: '', RF_WAKE_TICK_MS: '60000', ...entra.env(`http://127.0.0.1:${port}`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stdout = '';
    stderr = '';
    proc.stderr!.on('data', d => (stderr += d));
    await new Promise<void>((ok, fail) => {
      proc!.once('exit', code => fail(new Error(`server reboot exited ${code}: ${stderr}`)));
      proc!.stdout!.on('data', d => {
        stdout += d;
        if (/^rollforward on http:\/\/127\.0\.0\.1:\d+,/m.test(stdout)) ok();
      });
    });
    assert.equal((await api('PUT', '/api/series/s2', { archived: true })).status, 200);
    const detail4 = await (await api('GET', `/api/instances/${inst4.id}`)).json() as { log: any[] };
    assert.ok(detail4.log.some(e => e.op === 'interrupt' && e.quiet === true && e.why === 'archived'), 'mixed-queue archive records quiet interrupt');
    // Restore after reload: inst4 should be queued (due) for cAfter, not skipped.
    assert.equal((await api('PUT', '/api/series/s2', { archived: false })).status, 200);
    const detail4After = await (await api('GET', `/api/instances/${inst4.id}`)).json() as { log: any[] };
    assert.equal(detail4After.log.find(e => e.seq === cAfter.seq).text, 'Preserved owner instruction.');
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill();
      await new Promise(ok => proc!.once('exit', ok));
    }
    entra?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real server.ts CONNECT egress dedup logs allowed:true after refused attempt (offline local upstream) and HTTP archive during live run returns 409 with no interrupt', async () => {
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const { createServer: createNetServer } = await import('node:net');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { idp } = await import('./idp.ts');
  const { initSystem, saveTree, writeJson } = await import('../src/system.ts');
  const { createInstance, openStore } = await import('../src/store.ts');
  const { ownSeries } = await import('./owner-fixture.ts');
  const { keepSignIn } = await import('../src/entra.ts');
  const root = mkdtempSync(join(tmpdir(), 'rf-egress-real-'));
  let proc: import('node:child_process').ChildProcess | undefined;
  let entra: Awaited<ReturnType<typeof idp>> | undefined;
  let upstream: ReturnType<typeof createNetServer> | undefined;
  try {
    entra = await idp();
    upstream = createNetServer(sock => sock.end('OK'));
    await new Promise<void>(ok => upstream!.listen(0, '127.0.0.1', ok));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const serverPort = await new Promise<number>(ok => {
      const s = createNetServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
    });

    const alice = 'alice@demo.test', token = 'rft_real_egress_409', at = new Date().toISOString();
    initSystem(root);
    openStore(root);
    writeJson('users.json', { [alice]: { role: 'admin', name: 'Alice', created: at, epoch: 1 } });
    writeJson('tokens.json', { [createHash('sha256').update(token).digest('hex')]: { id: 'egress-409', email: alice, name: 'test', created: at, expires: '2099-01-01T00:00:00Z', epoch: 1 } });
    writeJson('egress.json', ['api.partner.example']);
    saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Rec', workspace: 'w' } } });
    mkdirSync(join(root, 'series', 's'), { recursive: true });
    ownSeries('s', alice, [], false);
    keepSignIn(alice, entra.refresh(alice));
    const inst = createInstance('s', 'P1', alice);

    // Preload redirects DNS for api.partner.example -> 93.184.216.34 and TCP 93.184.216.34:443 -> local upstream (100% offline deterministic).
    const preload = join(root, 'net-preload.mjs');
    writeFileSync(preload, `
      import dnsPromises from 'node:dns/promises';
      import net from 'node:net';
      import { syncBuiltinESMExports } from 'node:module';
      const origLookup = dnsPromises.lookup;
      dnsPromises.lookup = async (host, opts) => {
        if (host === 'api.partner.example') return opts?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
        return origLookup(host, opts);
      };
      const origConnect = net.connect;
      net.connect = function (...args) {
        if (args[0] === 443 && args[1] === '93.184.216.34') return origConnect(${upstreamPort}, '127.0.0.1', args[2]);
        return origConnect.apply(this, args);
      };
      syncBuiltinESMExports();
    `);

    // Fake Pi speaks JSON-RPC, pauses until told to continue via steer, and exercises real CONNECT over the run's Unix socket.
    const fakePi = join(root, 'fake-pi-egress.mjs');
    writeFileSync(fakePi, `#!${process.execPath}
      import { createConnection } from 'node:net';
      import { basename, dirname, join } from 'node:path';
      const runDir = dirname(process.env.RF_SANDBOX_ARGS), tok = basename(runDir), sock = join(runDir, 'socket', 'rf.sock');
      const auth = Buffer.from('rf:' + tok).toString('base64');
      const tryConnect = target => new Promise((ok, fail) => {
        const s = createConnection(sock, () => {
          s.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\nProxy-Authorization: Basic ' + auth + '\\r\\n\\r\\n');
        });
        let settled = false;
        const done = val => { if (!settled) { settled = true; s.destroy(); ok(val); } };
        s.once('data', d => done(d.toString().split('\\r\\n')[0]));
        s.once('end', () => done(''));
        s.once('close', () => done(''));
        s.once('error', e => { if (!settled) { settled = true; fail(e); } });
      });
      let buf = '';
      process.stdin.on('data', async d => {
        buf += d;
        let k;
        while ((k = buf.indexOf('\\n')) >= 0) {
          const cmd = JSON.parse(buf.slice(0, k));
          buf = buf.slice(k + 1);
          if (cmd.type === 'get_state') process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: {} }) + '\\n');
          if (cmd.type === 'prompt') {
            process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: {} }) + '\\n');
            await tryConnect('api.partner.example:8080');
            await tryConnect('api.partner.example:8080');
            await tryConnect('api.partner.example:443');
          }
          if (cmd.type === 'steer') {
            process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'steer', success: true, data: {} }) + '\\n');
            process.stdout.write(JSON.stringify({ type: 'agent_settled', aborted: false }) + '\\n');
          }
        }
      });
    `, { mode: 0o755 });

    proc = spawn(process.execPath, ['--import', preload, 'src/server.ts', root, String(serverPort)], {
      cwd,
      env: {
        ...process.env,
        RF_SCRATCH: join(root, 'scratch'),
        OPENROUTER_API_KEY: 'test-key',
        RF_MIN_FREE_GB: '0',
        RF_WAKE_TICK_MS: '60000',
        RF_SANDBOX_SCOPE: `${fakePi} --`,
        ...entra.env(`http://127.0.0.1:${serverPort}`),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stderr!.on('data', d => (stderr += d));
    await new Promise<void>((ok, fail) => {
      proc!.once('exit', code => fail(new Error(`server exited ${code}: ${stderr}`)));
      proc!.stdout!.on('data', d => {
        stdout += d;
        if (/^rollforward on http:\/\/127\.0\.0\.1:\d+,/m.test(stdout)) ok();
      });
    });

    const api = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${serverPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    // Trigger live run via comment.
    assert.equal((await api('POST', `/api/instances/${inst.id}/comment`, { text: 'Start live run.' })).status, 200);
    // Wait until both egress entries (refused then allowed) are logged while run is still live.
    let detail: { log: any[] } = { log: [] };
    for (let i = 0; i < 80; i++) {
      detail = await (await api('GET', `/api/instances/${inst.id}`)).json() as { log: any[] };
      if (detail.log.filter(e => e.op === 'egress').length >= 2) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const egressEntries = detail.log.filter(e => e.op === 'egress').map(e => [e.host, e.allowed]);
    assert.deepEqual(egressEntries, [['api.partner.example', false], ['api.partner.example', true]], 'real server.ts dedup logs allowed:true after prior refused attempt');

    // Archiving series or workspace while run is live must return 409 and write ZERO interrupt entries.
    assert.equal((await api('PUT', '/api/series/s', { archived: true })).status, 409);
    assert.equal((await api('PUT', '/api/workspaces/w', { archived: true })).status, 409);
    const duringRun = await (await api('GET', `/api/instances/${inst.id}`)).json() as { log: any[] };
    assert.equal(duringRun.log.filter(e => e.op === 'interrupt').length, 0, '409 archive refusal logs no interrupt');

    // Release fake Pi via a steer comment so the run settles cleanly.
    assert.equal((await api('POST', `/api/instances/${inst.id}/comment`, { text: 'Finish.' })).status, 200);
    for (let i = 0; i < 60; i++) {
      const done = (await (await api('GET', `/api/instances/${inst.id}`)).json() as { log: any[] }).log.some(e => e.op === 'done');
      if (done) break;
      await new Promise(r => setTimeout(r, 100));
    }
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill();
      await new Promise(ok => proc!.once('exit', ok));
    }
    upstream?.close();
    entra?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const hasSystemdScope = (() => {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=160M', '-p', 'MemorySwapMax=0', '--', 'true'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
})();

test('real Linux systemd-run --scope detects child cgroup OOM kills, survives 1 MiB paused-stdin steer EPIPE and prompt-exit race, and distinguishes kill -9 without OOM', { skip: !hasSystemdScope }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-real-oom-'));
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { initSystem } from './src/system.ts';
      import { serveSandboxes } from './src/sandbox.ts';
      import { OOM_ERROR, startRun } from './src/runner.ts';

      const root = ${JSON.stringify(root)};
      initSystem(root);
      const sock = serveSandboxes({ agent: async () => {}, run: () => undefined });
      const instDir = join(root, 'instances', 'i1'), pylibDir = join(root, 'series', 's1', '.pylib');
      mkdirSync(join(instDir, 'working'), { recursive: true });
      mkdirSync(pylibDir, { recursive: true });
      const fakePi = join(root, 'fake-pi.mjs');
      writeFileSync(fakePi, \`#!\${process.execPath}
        import { spawn } from 'node:child_process';
        let buf = '';
        process.stdin.on('data', d => {
          buf += d;
          let k;
          while ((k = buf.indexOf('\\\\n')) >= 0) {
            const cmd = JSON.parse(buf.slice(0, k));
            buf = buf.slice(k + 1);
            if (cmd.type === 'get_state') process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: {} }) + '\\\\n');
            if (cmd.type === 'prompt') {
              if (cmd.message !== 'oom-before-ack') {
                process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: {} }) + '\\\\n');
              }
              if (cmd.message === 'oom-epipe') {
                process.stdin.pause();
                spawn('python3', ['-c', 'x = bytearray(220 * 1024 * 1024); x[:] = b"a" * len(x)'], { stdio: 'ignore' });
              }
              if (cmd.message === 'oom' || cmd.message === 'oom-before-ack') {
                spawn('python3', ['-c', 'x = bytearray(220 * 1024 * 1024); x[:] = b"a" * len(x)'], { stdio: 'ignore' });
              }
              if (cmd.message === 'kill') process.kill(process.pid, 'SIGKILL');
            }
          }
        });
      \`, { mode: 0o755 });
      const view = { instance: '/work/ws/s/i1', dir: instDir, pylib: pylibDir, ro: [], names: {}, series: {}, env: {} };
      process.env.RF_SANDBOX_SCOPE = 'systemd-run --user --scope --quiet --collect --slice=rollforward-runs -p MemoryMax=160M -p MemorySwapMax=0 -- ' + fakePi + ' --';

      const r1 = await startRun({ token: 'oom-1', id: 'i1', n: 1, view, skills: [], onEvent() {} });
      const t1 = await (await r1.turn('oom')).settled;
      await r1.stop();
      assert.equal(t1.aborted, true);
      assert.equal(t1.oom, true);
      assert.equal(t1.error, OOM_ERROR);

      const r2 = await startRun({ token: 'oom-2', id: 'i1', n: 2, view, skills: [], onEvent() {} });
      const t2 = await (await r2.turn('oom-before-ack')).settled;
      await r2.stop();
      assert.equal(t2.aborted, true);
      assert.equal(t2.oom, true);
      assert.equal(t2.error, OOM_ERROR);

      // Paused-stdin 1 MiB steer hitting EPIPE on OOM must resolve cleanly and let exit deliver oom: true.
      const r2b = await startRun({ token: 'oom-epipe', id: 'i1', n: 3, view, skills: [], onEvent() {} });
      const { settled: s2b } = await r2b.turn('oom-epipe');
      await r2b.steer('x'.repeat(1024 * 1024));
      const t2b = await s2b;
      await r2b.stop();
      assert.equal(t2b.aborted, true);
      assert.equal(t2b.oom, true);
      assert.equal(t2b.error, OOM_ERROR);

      const r3 = await startRun({ token: 'kill-3', id: 'i1', n: 4, view, skills: [], onEvent() {} });
      const t3 = await (await r3.turn('kill')).settled;
      await r3.stop();
      assert.equal(t3.aborted, true);
      assert.equal(t3.oom, undefined);
      assert.match(t3.error ?? '', /^Pi exited with signal SIGKILL:/);

      sock.close();
      console.log('ok');
      process.exit(0);
    `], { cwd, env: { ...process.env, RF_SCRATCH: join(root, 'scratch'), OPENROUTER_API_KEY: 'test-key' }, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(out.trim(), 'ok');
  } catch (e) {
    const err = e as { stderr?: string | Buffer; stdout?: string | Buffer; message: string };
    assert.fail(`real systemd OOM test failed:\nSTDOUT:\n${err.stdout ?? ''}\nSTDERR:\n${err.stderr ?? err.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
