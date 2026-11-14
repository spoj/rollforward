import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const action of ['remove', 'remove-view', 'lease', 'lease-calls']) for (const result of ['resolve', 'reject']) test(`a starting run retires fully before deletion or drain completes: ${action}, ${result}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-starting-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import * as runner from './src/runner.ts';
      import * as entra from './src/entra.ts';
      import * as connections from './src/connections.ts';
      import { initSystem, saveTree, tree, changes, writeJson } from './src/system.ts';
      import { createInstance, openStore } from './src/store.ts';
      const root = ${JSON.stringify(root)}, action = ${JSON.stringify(action)}, result = ${JSON.stringify(result)}, alice = 'alice@demo.test';
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] }, w2: { name: 'Elsewhere', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' }, other: { name: 'Other', workspace: 'w' } } });
      writeJson('users.json', { [alice]: { role: 'user' } });
      for (const id of ['s', 'other']) mkdirSync(root + '/series/' + id, { recursive: true });
      const starting = Promise.withResolvers(), startup = Promise.withResolvers(), stopping = Promise.withResolvers(), stopped = Promise.withResolvers(), charged = Promise.withResolvers();
      let turns = 0, steers = 0, stops = 0, calls = action === 'lease-calls';
      const run = { turn: async () => { turns++; }, steer: async () => { steers++; }, stop: async () => { stops++; stopping.resolve(); await stopped.promise; } };
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async () => { starting.resolve(); return startup.promise; } } });
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
      mock.module('./src/connections.ts', { namedExports: { ...connections, hasCalls: () => calls, abortCalls: () => {}, drainCalls: () => charged.promise } });
      const { active, byToken, drain, drained, kick, remove, updating } = await import('./src/waker.ts');
      const inst = createInstance('s', 'Starting', alice, []), target = action === 'remove-view' ? createInstance('other', 'Viewed', alice, []) : inst;
      mkdirSync(target.dir + '/working', { recursive: true });
      const marker = target.dir + '/working/kept';
      writeFileSync(marker, 'kept until every sandbox stops');
      inst.append(alice, 'comment', { text: 'Work.' });
      kick(inst);
      await starting.promise;
      const a = active.get('s'), index = root + '/.rf/runs/' + a.token;
      assert.equal(a.run, undefined);
      assert.ok(a.ready && existsSync(index));
      drain();
      let deleted = false;
      const deletion = action.startsWith('remove') ? remove(target, alice, () => ({ cost: 0, runs: [] })).then(() => { deleted = true; }) : undefined;
      if (action.startsWith('lease')) {
        const t = tree();
        t.series.s.workspace = 'w2';
        saveTree(t);
        changes.emit('change', 'tree');
      }
      await new Promise(ok => setImmediate(ok));
      assert.equal(byToken.has(a.token), false, 'a cut revokes its token even before Pi is ready');
      assert.equal(updating(), 1, 'one run is counted once even while it is both active and retiring');
      assert.equal(drained(), false);
      assert.equal(deleted, false);
      const ending = a.ended;
      assert.ok(ending, 'a cut with calls is already tracked as retiring');
      if (action === 'lease-calls') {
        result === 'resolve' ? startup.resolve(run) : startup.reject(new Error('startup failed'));
        await new Promise(ok => setImmediate(ok));
        assert.equal(turns, 0, 'a revoked starting run cannot prompt while its calls drain');
        assert.equal(a.timer, undefined, 'a revoked starting run cannot arm a time limit');
        inst.append(alice, 'comment', { text: 'A late instruction.' });
        kick(inst);
        assert.equal(steers, 0, 'a revoked run cannot be steered while its calls drain');
      }
      calls = false;
      charged.resolve();
      await new Promise(ok => setImmediate(ok));
      assert.equal(drained(), false, 'draining calls alone cannot retire a starting sandbox');
      if (result === 'resolve') {
        startup.resolve(run);
        await stopping.promise;
        assert.equal(drained(), false, 'finish cannot remove retiring while stop is pending');
        assert.equal(existsSync(index), true);
        assert.equal(deleted, false);
        assert.equal(existsSync(marker), true, 'remove waits for the sandbox before inst.clear');
        stopped.resolve();
      } else startup.reject(new Error('startup failed'));
      await ending;
      await deletion;
      assert.equal(drained(), true);
      assert.equal(existsSync(index), false);
      assert.equal(turns, 0, 'a cut during startup never sends an initial prompt');
      assert.equal(stops, result === 'resolve' ? 1 : 0);
      assert.equal(a.done, true);
      if (action !== 'remove') assert.equal(inst.log.filter(e => e.op === 'done').length, 1);
      if (deletion) assert.equal(existsSync(marker), false);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const phase of ['startup', 'prompt']) test(`shutdown sends no new work after a pending ${phase} completes, leaving the run for recovery`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-stopping-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { existsSync, mkdirSync } from 'node:fs';
      import * as runner from './src/runner.ts';
      import * as entra from './src/entra.ts';
      import { initSystem, saveTree, writeJson } from './src/system.ts';
      import { createInstance, openStore } from './src/store.ts';
      import { committed } from './src/git.ts';
      const root = ${JSON.stringify(root)}, phase = ${JSON.stringify(phase)}, alice = 'alice@demo.test';
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [alice]: { role: 'user' } });
      mkdirSync(root + '/series/s', { recursive: true });
      const starting = Promise.withResolvers(), startup = Promise.withResolvers(), turning = Promise.withResolvers(), prompt = Promise.withResolvers();
      let turns = 0, steers = 0;
      const run = { turn: async () => { turns++; turning.resolve(); await prompt.promise; return { settled: new Promise(() => {}) }; }, steer: async () => { steers++; }, stop: async () => {} };
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async () => { starting.resolve(); return startup.promise; } } });
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
      const { active, byToken, kick, recover, stop } = await import('./src/waker.ts');
      const inst = createInstance('s', 'Stopping', alice, []);
      inst.append(alice, 'comment', { text: 'Work.' });
      kick(inst);
      await starting.promise;
      const a = active.get('s'), index = root + '/.rf/runs/' + a.token;
      if (phase === 'prompt') { startup.resolve(run); await turning.promise; }
      stop();
      inst.append(alice, 'comment', { text: 'A late instruction.' });
      startup.resolve(run);
      prompt.resolve();
      await new Promise(ok => setImmediate(ok));
      assert.equal(turns, phase === 'startup' ? 0 : 1, 'shutdown cannot send an initial prompt after startup completes');
      assert.equal(steers, 0, 'shutdown cannot flush instructions after prompt acknowledgement');
      assert.equal(a.timer, undefined, 'shutdown cannot arm a new time limit');
      assert.equal(active.size, 0);
      assert.equal(byToken.size, 0);
      assert.equal(a.done, false, 'shutdown leaves the run unfinished for recovery');
      assert.equal(existsSync(index), true, 'restart still has the token needed to remove scratch');
      recover();
      assert.equal(inst.log.findLast(e => e.op === 'done').error, 'a restart cut the run');
      assert.ok(inst.log.findLast(e => e.op === 'wake'));
      await committed(inst.dir);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
