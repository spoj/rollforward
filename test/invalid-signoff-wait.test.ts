import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('invalid signoffs reject every semantic failure before waiting for existing Git work', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-invalid-signoff-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { execFileSync } from 'node:child_process';
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { idp } from './test/idp.ts';
      const root = ${JSON.stringify(root)}, admin = 'admin@demo.test', actor = 'actor@demo.test';
      const entra = await idp(), probe = createServer();
      await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
      const port = probe.address().port, base = 'http://127.0.0.1:' + port;
      await new Promise(ok => probe.close(ok));
      Object.assign(process.env, entra.env(base), { RF_ADMINS: admin, RF_HOST: '127.0.0.1', RF_MAX_RUNS: '0' });
      for (const name of ['RF_BROWSER_URL', 'RF_TUNNEL_URL', 'OPENROUTER_API_KEY', 'EXA_API_KEY']) delete process.env[name];
      const git = await import('./src/git.ts');
      let entered, target;
      mock.module('./src/git.ts', { namedExports: { ...git, committed: dir => {
        if (dir === target) entered.resolve();
        return git.committed(dir);
      } } });
      const { initSystem, saveTree, writeJson } = await import('./src/system.ts');
      const { createInstance, openStore } = await import('./src/store.ts');
      const { ownSeries } = await import('./test/owner-fixture.ts');
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [admin], members: [actor] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [admin]: { role: 'admin' }, [actor]: { role: 'user' } });
      mkdirSync(root + '/series/s', { recursive: true });
      ownSeries('s', admin);
      process.argv = [process.execPath, 'src/server.ts', root, String(port)];
      const ready = Promise.withResolvers();
      mock.method(console, 'log', line => { if (String(line).startsWith('rollforward on')) ready.resolve(); });
      await import('./src/server.ts');
      await ready.promise;
      const cookie = (await entra.signIn(base, actor)).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
      const inst = createInstance('s', 'Invalid', admin), path = '/api/instances/' + inst.id;
      const proposal = () => inst.append('agent', 'comment', { text: 'Approve the local result?', ask: 'proposal', run: 1 });
      const old = proposal();
      inst.append(actor, 'duplicate', { from: 'earlier' });
      const human = inst.append(actor, 'comment', { text: 'Not a proposal' });
      const question = inst.append('agent', 'comment', { text: 'Which result?', ask: 'question', run: 1 });
      const withdrawn = proposal();
      inst.append('agent', 'withdraw', { thread: withdrawn.thread, on: withdrawn.seq, text: 'Superseded', run: 1 });
      const approved = proposal();
      inst.append(admin, 'signoff', { thread: approved.thread, on: approved.seq, commit: 'earlier' });
      const rejected = proposal();
      inst.append(admin, 'reject', { thread: rejected.thread, on: rejected.seq });
      const accepted = proposal();
      inst.append(admin, 'close', { accepted: ['c' + accepted.seq], commit: 'earlier' });
      const valid = proposal();
      writeFileSync(inst.dir + '/working/result.txt', 'Local result to approve');
      const hold = Promise.withResolvers();
      const prior = git.commit(inst.dir, git.AGENT, 'prior', hold.promise);
      target = inst.dir;
      const before = ['screen.json', 'log.jsonl'].map(file => readFileSync(inst.dir + '/' + file, 'utf8'));
      const cases = [
        [{ thread: 'c999' }, 409, "c999 is no proposal of the agent's"],
        [{ thread: 'c' + human.seq }, 409, 'c' + human.seq + " is no proposal of the agent's"],
        [{ thread: 'c' + question.seq }, 409, 'c' + question.seq + " is no proposal of the agent's"],
        [{ thread: 'c' + withdrawn.seq }, 409, 'the agent withdrew c' + withdrawn.seq],
        [{ thread: 'c' + approved.seq }, 409, 'c' + approved.seq + ' was approved already, by ' + admin],
        [{ thread: 'c' + rejected.seq }, 409, 'c' + rejected.seq + ' was rejected already, by ' + admin],
        [{ thread: 'c' + accepted.seq }, 409, 'c' + accepted.seq + ' was accepted as done at the close, by ' + admin],
        [{ thread: 'c' + old.seq }, 409, 'c' + old.seq + ' is from before this instance was copied'],
        [{ thread: 'c' + valid.seq, approved: false }, 400, 'a sign-off approves; to say no, reject it, on the page or with rf reject'],
      ];
      for (const [body, status, message] of cases) {
        entered = Promise.withResolvers();
        const response = fetch(base + path + '/signoff', { method: 'POST', headers: { cookie }, body: JSON.stringify({ quiet: true, ...body }) });
        const result = await Promise.race([response, entered.promise.then(() => { throw new Error(message + ': invalid signoff entered the Git wait'); })]);
        assert.equal(result.status, status);
        assert.equal(await result.text(), message);
        assert.equal(inst.closing, false);
        assert.deepEqual(['screen.json', 'log.jsonl'].map(file => readFileSync(inst.dir + '/' + file, 'utf8')), before);
      }
      entered = Promise.withResolvers();
      const signing = fetch(base + path + '/signoff', { method: 'POST', headers: { cookie }, body: JSON.stringify({ thread: 'c' + valid.seq, text: 'Approved locally.', quiet: true }) });
      await Promise.race([entered.promise, signing.then(r => { throw new Error('valid signoff did not wait: ' + r.status); })]);
      hold.resolve();
      await prior;
      assert.equal((await signing).status, 200);
      const signed = inst.log.at(-1);
      assert.equal(signed.op, 'signoff');
      assert.equal(signed.by, actor);
      assert.equal(signed.on, valid.seq);
      const show = format => execFileSync('git', ['show', '-s', '--format=' + format, signed.commit], { cwd: inst.dir, encoding: 'utf8' });
      assert.equal(show('%ae').trim(), actor);
      assert.ok(show('%B').includes(valid.text + '\\n\\nApproved locally.\\n\\nSigned-off-by: '));
      assert.ok(show('%B').includes('<' + actor + '>'));
      assert.equal(execFileSync('git', ['show', signed.commit + ':working/result.txt'], { cwd: inst.dir, encoding: 'utf8' }), 'Local result to approve');
      process.exit(0);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 15_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid signoff cannot delay Interrupt revocation when confirmation starts a run during unrelated Git work', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-invalid-signoff-interrupt-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { mkdirSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { request } from 'node:http';
      import { idp } from './test/idp.ts';
      const root = ${JSON.stringify(root)}, admin = 'admin@demo.test', actor = 'actor@demo.test';
      const entra = await idp(), probe = createServer();
      await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
      const port = probe.address().port, base = 'http://127.0.0.1:' + port;
      await new Promise(ok => probe.close(ok));
      Object.assign(process.env, entra.env(base), { RF_ADMINS: admin, RF_HOST: '127.0.0.1', RF_MAX_RUNS: '2', RF_MIN_FREE_GB: '0', RF_SCRATCH: root + '/scratch' });
      for (const name of ['RF_BROWSER_URL', 'RF_TUNNEL_URL', 'OPENROUTER_API_KEY', 'EXA_API_KEY']) delete process.env[name];
      const sandbox = await import('./src/sandbox.ts'), runner = await import('./src/runner.ts'), authEntra = await import('./src/entra.ts');
      const confirming = Promise.withResolvers(), confirmation = Promise.withResolvers(), turned = Promise.withResolvers(), interrupted = Promise.withResolvers();
      mock.module('./src/entra.ts', { namedExports: { ...authEntra, confirm: async () => { confirming.resolve(); await confirmation.promise; } } });
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async ({ token }) => {
        sandbox.listenRun(root + '/run.sock', token);
        return { turn: async () => { turned.resolve(); return { settled: new Promise(() => {}) }; }, steer: async () => {}, interrupt: async () => { interrupted.resolve(); }, stop: async () => {} };
      } } });
      const git = await import('./src/git.ts'), entered = Promise.withResolvers();
      let armed = false;
      mock.module('./src/git.ts', { namedExports: { ...git, committed: dir => { if (armed) entered.resolve(); return git.committed(dir); } } });
      const { initSystem, saveTree, writeJson } = await import('./src/system.ts');
      const { openStore } = await import('./src/store.ts');
      const { ownSeries } = await import('./test/owner-fixture.ts');
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [admin], members: [actor] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [admin]: { role: 'admin' }, [actor]: { role: 'user' } });
      mkdirSync(root + '/series/s', { recursive: true });
      ownSeries('s', admin);
      process.argv = [process.execPath, 'src/server.ts', root, String(port)];
      const ready = Promise.withResolvers();
      mock.method(console, 'log', line => { if (String(line).startsWith('rollforward on')) ready.resolve(); });
      await import('./src/server.ts');
      await ready.promise;
      const [ac, bc] = await Promise.all([admin, actor].map(async email => {
        const r = await entra.signIn(base, email);
        return r.headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
      }));
      const { createInstance } = await import('./src/store.ts'), { kick, active, byToken } = await import('./src/waker.ts');
      const inst = createInstance('s', 'Race', admin), path = '/api/instances/' + inst.id;
      inst.append(admin, 'comment', { text: 'Go.' });
      kick(inst);
      await confirming.promise;
      const hold = Promise.withResolvers();
      let gitFinished = false;
      const prior = git.commit(inst.dir, git.AGENT, 'prior', hold.promise).then(hash => { gitFinished = true; return hash; });
      armed = true;
      const invalid = fetch(base + path + '/signoff', { method: 'POST', headers: { cookie: bc }, body: JSON.stringify({ thread: 'c999', quiet: true }) });
      await Promise.race([invalid, entered.promise]);
      confirmation.resolve();
      await turned.promise;
      const a = active.get('s');
      assert.ok(byToken.has(a.token));
      const interrupting = fetch(base + path + '/interrupt', { method: 'POST', headers: { cookie: ac }, body: '{}' });
      await Promise.race([interrupted.promise, new Promise((_, fail) => setTimeout(() => fail(new Error('Interrupt did not revoke before unrelated Git finished')), 2000))]);
      assert.equal(gitFinished, false);
      assert.equal(byToken.has(a.token), false);
      assert.equal(a.stopped, true);
      assert.equal(inst.log.filter(e => e.op === 'interrupt' && e.by === admin).length, 1);
      const lateStatus = await new Promise((ok, fail) => {
        const req = request({ socketPath: root + '/run.sock', path: path + '/comment', method: 'POST', headers: { authorization: 'Bearer ' + a.token } }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
        req.on('error', fail);
        req.end(JSON.stringify({ text: 'New local mutation after Interrupt was admitted.' }));
      });
      assert.equal(lateStatus, 401);
      assert.equal(inst.log.some(e => e.text === 'New local mutation after Interrupt was admitted.'), false);
      assert.equal((await invalid).status, 409);
      hold.resolve();
      await prior;
      assert.equal((await interrupting).status, 200);
      process.exit(0);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 15_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
