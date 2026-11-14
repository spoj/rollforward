import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const phase of ['before-listen', 'after-listen', 'client-start', 'ready']) test(`failed run startup cleans its scratch and listener: ${phase}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-runner-startup-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { existsSync, mkdirSync } from 'node:fs';
      import { RpcClient } from '@earendil-works/pi-coding-agent';
      const root = ${JSON.stringify(root)}, phase = ${JSON.stringify(phase)};
      Object.assign(process.env, { RF_SCRATCH: root + '/scratch', RF_SANDBOX_SCOPE: '', OPENROUTER_API_KEY: 'test' });
      (await import('./src/system.ts')).initSystem(root);
      const sandbox = await import('./src/sandbox.ts');
      let listening = false, child;
      mock.module('./src/sandbox.ts', { namedExports: { ...sandbox,
        listenRun: (path, token) => { sandbox.listenRun(path, token); listening = true; },
        unlistenRun: token => { sandbox.unlistenRun(token); listening = false; },
      } });
      const { startRun } = await import('./src/runner.ts');
      const dir = root + '/instance';
      mkdirSync(dir);
      if (phase === 'before-listen') mkdirSync(dir + '/names.tsv');
      if (phase === 'after-listen') process.env.RF_PI_ARGS = '[';
      if (phase === 'client-start') process.env.RF_SANDBOX_SCOPE = 'false';
      if (phase === 'ready') mock.method(RpcClient.prototype, 'getState', async function () {
        child = this.process;
        throw new Error('state refused');
      });
      const view = { instance: '/work/W/S/I', dir, pylib: root + '/lib', ro: [], names: {}, series: {}, env: {} };
      await assert.rejects(startRun({ token: 'failed', id: 'i', n: 1, view, skills: [], onEvent() {} }));
      assert.equal(existsSync(root + '/scratch/runs/failed'), false, 'a rejected startRun leaves no scratch for an unreachable token');
      assert.equal(listening, false, 'a rejected startRun closes its per-run server socket');
      if (child) assert.ok(child.exitCode !== null || child.signalCode !== null, 'startup cleanup waits for the sandbox to exit');
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
