import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['body', 'queue', 'screen']) test(`an admitted agent request cannot act after run revocation while waiting on its ${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-queued-run-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { EventEmitter } from 'node:events';
      import { PassThrough } from 'node:stream';
      import { createServer } from 'node:net';
      import { mkdirSync } from 'node:fs';
      import { idp } from './test/idp.ts';
      import { initSystem, saveTree, writeJson } from './src/system.ts';
      import { createInstance } from './src/store.ts';
      const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}, alice = 'alice@demo.test';
      const probe = createServer();
      await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
      const port = probe.address().port;
      await new Promise(ok => probe.close(ok));
      const base = 'http://127.0.0.1:' + port, entra = await idp();
      Object.assign(process.env, entra.env(base), { RF_ADMINS: alice });
      const { active, byToken, interruptRun, view } = await import('./src/waker.ts'), sandbox = await import('./src/sandbox.ts');
      initSystem(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [alice]: { role: 'admin' } });
      mkdirSync(root + '/series/s', { recursive: true });
      let agent;
      mock.module('./src/sandbox.ts', { namedExports: { ...sandbox, serveSandboxes: o => { agent = o.agent; } } });
      process.argv = [process.execPath, 'src/server.ts', root, String(port)];
      const ready = Promise.withResolvers();
      mock.method(console, 'log', line => { if (String(line).startsWith('rollforward on')) ready.resolve(); });
      await import('./src/server.ts');
      await ready.promise;
      const cookie = (await entra.signIn(base, alice)).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
      const inst = createInstance('s', 'Queued', alice, []), rpc = Promise.withResolvers(), entered = Promise.withResolvers();
      const a = {
        inst, n: 1, runner: alice, token: 'queued-run', view: view(inst), workspace: 'w', cost: 0, estimated: false,
        seen: 1, delivered: 1, done: false, process: '', texts: new Map(),
        run: { interrupt: () => { if (mode !== 'queue') { entered.resolve(); return rpc.promise; } }, stop: async () => {}, alone: () => false },
        ...(mode === 'queue' && { browsers: { closeUnlent: () => { entered.resolve(); return rpc.promise; }, end: async () => {} } }),
      };
      inst.append('server', 'run', { run: 1, runner: alice, consent: 1 });
      const ask = inst.append('agent', 'comment', { thread: 'c3', text: 'Which account?', ask: 'question', run: 1 });
      mkdirSync(root + '/.rf/runs/' + a.token, { recursive: true });
      active.set('s', a);
      byToken.set(a.token, a);
      const req = Object.assign(new PassThrough(), { method: mode === 'screen' ? 'PUT' : 'POST', headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' } });
      const res = Object.assign(new EventEmitter(), {
        headersSent: false, statusCode: 0,
        writeHead(status) { this.headersSent = true; this.statusCode = status; return this; }, end() {},
      });
      const withdrawing = agent(req, res, new URL('/api/instances/' + inst.id + (mode === 'screen' ? '/screen' : '/withdraw'), base));
      const interrupting = fetch(base + '/api/instances/' + inst.id + (mode !== 'queue' ? '/interrupt' : '/logins'), { method: 'POST', headers: { cookie } });
      await Promise.race([entered.promise, interrupting.then(async r => { throw new Error('blocking action returned ' + r.status + ': ' + await r.text()); })]);
      req.end(JSON.stringify(mode === 'screen' ? { rev: inst.doc.rev, items: [{ id: 'late', name: 'Late', kind: 'output', file: null }] } : { thread: 'c' + ask.seq, text: 'No longer needed.' }));
      await new Promise(ok => setImmediate(ok));
      if (mode === 'queue') await interruptRun(a);
      rpc.resolve();
      assert.equal((await interrupting).status, 200);
      await withdrawing;
      assert.equal(res.statusCode, 409);
      assert.equal(inst.log.some(e => e.op === (mode === 'screen' ? 'screen' : 'withdraw')), false);
      assert.equal(inst.doc.items.length, 0);
      process.exit(0);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 15_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
