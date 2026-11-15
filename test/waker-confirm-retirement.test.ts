import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const [target, timing] of [['same', 'retiring'], ['same', 'retired'], ['sibling', 'retiring'], ['sibling', 'retired'], ['same', 'held']]) test(`pending confirmation recaptures work after physical retirement: ${target}, ${timing}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-confirm-retirement-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      import { setTimeout as pause } from 'node:timers/promises';
      import * as runner from './src/runner.ts';
      import * as entra from './src/entra.ts';
      import * as git from './src/git.ts';
      import { initSystem, saveTree, writeJson } from './src/system.ts';
      import { createInstance, openStore } from './src/store.ts';
      const root = ${JSON.stringify(root)}, target = ${JSON.stringify(target)}, timing = ${JSON.stringify(timing)}, owner = 'owner@synthetic.test';
      const confirmations = [Promise.withResolvers(), Promise.withResolvers()], confirming = confirmations.map(() => Promise.withResolvers());
      const turns = [Promise.withResolvers(), Promise.withResolvers()], children = [], prompts = [];
      const processStop = Promise.withResolvers(), stopping = Promise.withResolvers(), browserStop = Promise.withResolvers(), closing = Promise.withResolvers(), gitStop = Promise.withResolvers(), committing = Promise.withResolvers();
      let confirms = 0, starts = 0, stops = 0;
      mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {
        const n = confirms++;
        if (n < 2) { confirming[n].resolve(); await confirmations[n].promise; }
      } } });
      mock.module('./src/git.ts', { namedExports: { ...git, commit: (dir, who, message, after) => git.commit(dir, who, message,
        message === 'Run 1' ? Promise.resolve(after).then(() => { committing.resolve(); return gitStop.promise; }) : after) } });
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async ({ onEvent }) => {
        const n = starts++;
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        children.push(child);
        await once(child, 'spawn');
        return {
          turn: async text => {
            prompts[n] = text;
            onEvent({ type: 'message_start', message: { role: 'user', content: text } });
            onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
            turns[n].resolve();
            return { settled: new Promise(() => {}) };
          },
          steer: async () => {}, interrupt: async () => {},
          stop: async () => {
            stops++;
            if (n === 0) { stopping.resolve(); await processStop.promise; }
            const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
          },
        };
      } } });
      initSystem(root); openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [owner], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [owner]: { role: 'user' } });
      const { kick, active, byToken, interruptRun, stop } = await import('./src/waker.ts');
      const first = createInstance('s', 'First', owner, []), second = target === 'same' ? first : createInstance('s', 'Second', owner, []);
      const original = first.append(owner, 'comment', { text: 'Already processed instruction', thread: 'old' });
      if (second !== first) second.append(owner, 'comment', { text: 'Sibling instruction', thread: 'sibling' });
      let ending;
      try {
        kick(first); await confirming[0].promise;
        kick(second); await confirming[1].promise;
        confirmations[0].resolve(); await turns[0].promise;
        const old = active.get('s');
        assert.equal(old.seen, original.seq);
        old.browsers = { cut: () => {}, end: async () => { closing.resolve(); await browserStop.promise; } };
        first.append(owner, 'interrupt', {});
        ending = interruptRun(old);
        await stopping.promise; await closing.promise;
        assert.equal(byToken.has(old.token), false, 'the old token is already revoked');
        assert.equal(children[0].exitCode, null);
        assert.equal(children[0].signalCode, null, 'the physical writer is still alive');
        let fresh = timing === 'held' ? undefined : second.append(owner, 'comment', { text: 'Fresh replacement instruction', thread: 'fresh' });
        if (timing !== 'retired') {
          confirmations[1].resolve();
          await pause(100);
          assert.equal(starts, 1, 'pending confirmation must not bypass a live old process');
        }
        processStop.resolve();
        await once(children[0], 'exit');
        await pause(100);
        assert.equal(starts, 1, 'process exit alone cannot bypass browser retirement');
        browserStop.resolve(); await committing.promise;
        await pause(100);
        assert.equal(starts, 1, 'process and browser exit cannot bypass the final Git commit');
        gitStop.resolve(); await ending;
        if (timing === 'retired') confirmations[1].resolve();
        if (timing === 'held') {
          await pause(100);
          assert.equal(starts, 1, 'Interrupt stays held without a fresh owner act');
          fresh = second.append(owner, 'comment', { text: 'Fresh replacement instruction', thread: 'fresh' });
          kick(second);
        }
        await turns[1].promise;
        await pause(100);
        assert.equal(starts, 2, 'fresh work continues exactly once after every retirement barrier');
        assert.equal(stops, 1);
        const replacement = active.get('s'), run = second.log.findLast(e => e.op === 'run');
        assert.equal(replacement.inst, second);
        assert.equal(run.consent, second.log.findLast(e => e.op === 'create').seq);
        assert.equal(run.upto, fresh.seq);
        assert.equal(replacement.delivered, fresh.seq);
        if (target === 'same') {
          assert.equal(replacement.thread, 'fresh');
          assert.equal(second.log.find(e => e.op === 'done').seen, original.seq);
          assert.ok(!prompts[1].includes('Already processed instruction'), 'a completed old read is not presented as new work');
          assert.ok(prompts[1].includes('Fresh replacement instruction'));
        }
      } finally {
        clearTimeout(active.get('s')?.timer);
        stop();
        for (const c of confirmations) c.resolve();
        processStop.resolve(); browserStop.resolve(); gitStop.resolve();
        await ending;
        for (const child of children) if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
        }
      }
    `], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, RF_MIN_FREE_GB: '0' }, timeout: 15_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
