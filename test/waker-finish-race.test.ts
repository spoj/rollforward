import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an interrupt during natural turn cost draining stops the sandbox rather than keeping it idle', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-finish-race-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { mkdirSync } from 'node:fs';
      import * as runner from './src/runner.ts';
      import * as connections from './src/connections.ts';
      import * as entra from './src/entra.ts';
      import { initSystem, saveTree, writeJson } from './src/system.ts';
      import { createInstance, openStore } from './src/store.ts';
      const root = ${JSON.stringify(root)}, alice = 'alice@demo.test';
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [alice]: { role: 'user' } });
      mkdirSync(root + '/series/s', { recursive: true });
      const turned = Promise.withResolvers(), settled = Promise.withResolvers(), draining = Promise.withResolvers(), charge = Promise.withResolvers(), rpc = Promise.withResolvers();
      let stops = 0;
      const run = {
        turn: async () => { turned.resolve(); return { settled: settled.promise }; },
        steer: async () => {}, interrupt: () => rpc.promise,
        stop: async () => { stops++; }, alone: () => true,
      };
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async () => run } });
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
      mock.module('./src/connections.ts', { namedExports: { ...connections,
        hasCalls: () => true, abortCalls: () => {}, drainCalls: () => { draining.resolve(); return charge.promise; },
      } });
      const { active, interruptRun, kick } = await import('./src/waker.ts');
      const inst = createInstance('s', 'Race', alice, []);
      inst.append(alice, 'comment', { text: 'Work.' });
      kick(inst);
      await turned.promise;
      const a = active.get('s');
      settled.resolve({ aborted: false });
      await draining.promise;
      const interrupted = interruptRun(a);
      charge.resolve();
      await new Promise(ok => setImmediate(ok));
      rpc.resolve();
      await interrupted;
      assert.equal(stops, 1, 'interrupt must not leave the naturally settled sandbox idle');
      const dones = inst.log.filter(e => e.op === 'done');
      assert.equal(dones.length, 1);
      assert.equal(dones[0].aborted, true);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
