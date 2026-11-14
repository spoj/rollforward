import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['queued', 'success', 'failure']) test(`a mid-turn steer is retained until answered, not replayed from an idle queue: ${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-steer-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { mkdirSync } from 'node:fs';
      import * as runner from './src/runner.ts';
      import * as entra from './src/entra.ts';
      import { initSystem, saveTree, writeJson } from './src/system.ts';
      import { createInstance, openStore } from './src/store.ts';
      const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}, alice = 'alice@demo.test';
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [alice]: { role: 'user' } });
      mkdirSync(root + '/series/s', { recursive: true });
      const first = Promise.withResolvers(), second = Promise.withResolvers(), settled = Promise.withResolvers(), nextSettled = Promise.withResolvers();
      let starts = 0, turns = 0, emit;
      const run = {
        turn: async text => {
          emit({ type: 'message_start', message: { role: 'user', content: text } });
          if (++turns === 1) {
            emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
            first.resolve();
            return { settled: settled.promise };
          }
          emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
          second.resolve(text);
          return { settled: nextSettled.promise };
        },
        steer: async text => {
          if (mode !== 'queued') {
            emit({ type: 'message_start', message: { role: 'user', content: text } });
            emit({ type: 'message_end', message: { role: 'assistant', stopReason: mode === 'success' ? 'stop' : 'error', errorMessage: 'model failed' } });
          }
        },
        interrupt: async () => {}, stop: async () => {}, alone: () => turns === 1,
      };
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async o => { starts++; emit = o.onEvent; return run; } } });
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
      const { active, kick } = await import('./src/waker.ts');
      const inst = createInstance('s', 'Steer', alice, []);
      inst.append(alice, 'comment', { text: 'First instruction.' });
      kick(inst);
      await first.promise;
      const a = active.get('s'), steer = inst.append(alice, 'comment', { text: 'Mid-turn instruction.' });
      kick(inst);
      settled.resolve({ aborted: false });
      await new Promise(ok => setImmediate(ok));
      const done = inst.log.find(e => e.op === 'done');
      if (mode === 'success') assert.equal(done.seen, steer.seq);
      else assert.ok(done.seen < steer.seq, 'unanswered steer remains unread');
      await a.ended;
      if (mode === 'failure') {
        assert.equal(turns, 1, 'a failure waits for the next act');
        inst.append(alice, 'comment', { text: 'Try again.' });
        kick(inst);
      }
      if (mode !== 'success') {
        assert.match(await second.promise, /Mid-turn instruction/);
        assert.equal(starts, 2, 'an undelivered or failed steer needs a fresh session, not an idle queue replay');
        const next = active.get('s');
        nextSettled.resolve({ aborted: false });
        await new Promise(ok => setImmediate(ok));
        await next.ended;
      }
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
