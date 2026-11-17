import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const action of ['interrupt', 'transfer', 'same-instance']) test(action === 'same-instance'
  ? 'valid same-instance signoff preserves control ordering, content and actor across Git'
  : `${action} revokes the active sibling token before signoff Git finishes; retirement still fences replacement work`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-sibling-control-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { execFileSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { request } from 'node:http';
      import { idp } from './test/idp.ts';
      const root = ${JSON.stringify(root)}, action = ${JSON.stringify(action)};
      const owner = 'owner@demo.test', actor = 'collaborator@demo.test', incoming = 'incoming@demo.test';
      const entra = await idp(), probe = createServer();
      await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
      const port = probe.address().port, base = 'http://127.0.0.1:' + port;
      await new Promise(ok => probe.close(ok));
      Object.assign(process.env, entra.env(base), { RF_HOST: '127.0.0.1', RF_MAX_RUNS: '2', RF_SCRATCH: root + '/scratch' });
      const auth = await import('./src/auth.ts'), admitted = Promise.withResolvers(), consentAdmitted = Promise.withResolvers();
      let controlPath;
      mock.module('./src/auth.ts', { namedExports: { ...auth, recheckRequest: req => {
        auth.recheckRequest(req);
        if (req.url === controlPath) admitted.resolve();
        if (req.url === '/api/series/s/credentials') consentAdmitted.resolve();
      } } });
      const sandbox = await import('./src/sandbox.ts'), runner = await import('./src/runner.ts'), identity = await import('./src/entra.ts');
      const turned = Promise.withResolvers(), stopping = Promise.withResolvers(), stopped = Promise.withResolvers();
      let starts = 0;
      mock.module('./src/entra.ts', { namedExports: { ...identity, confirm: async () => {} } });
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async ({ token }) => {
        starts++;
        if (starts === 1) sandbox.listenRun(root + '/run.sock', token);
        return {
          turn: async () => { turned.resolve(); return { settled: new Promise(() => {}) }; },
          steer: async () => {}, interrupt: async () => {},
          stop: async () => { stopping.resolve(); await stopped.promise; },
        };
      } } });
      const git = await import('./src/git.ts'), entered = Promise.withResolvers();
      let target;
      mock.module('./src/git.ts', { namedExports: { ...git, committed: dir => {
        if (dir === target) entered.resolve();
        return git.committed(dir);
      } } });
      const { initSystem, saveTree, writeJson } = await import('./src/system.ts');
      const { createInstance, openStore, seriesDir } = await import('./src/store.ts');
      const { ownSeries } = await import('./test/owner-fixture.ts');
      const { seriesSettings } = await import('./src/series.ts');
      initSystem(root); openStore(root);
      saveTree({ workspaces: { w: { name: 'Work', owners: [owner], members: [actor, incoming] } }, series: { s: { name: 'Series', workspace: 'w' } } });
      writeJson('users.json', { [owner]: { role: 'user' }, [actor]: { role: 'user' }, [incoming]: { role: 'user' } });
      ownSeries('s', owner);
      writeJson('capabilities.json', { 'series-owner': [owner, incoming] });
      process.argv = [process.execPath, 'src/server.ts', root, String(port)];
      const ready = Promise.withResolvers();
      mock.method(console, 'log', line => { if (String(line).startsWith('rollforward on')) ready.resolve(); });
      await import('./src/server.ts'); await ready.promise;
      const cookies = {};
      for (const email of [owner, actor, incoming]) cookies[email] = (await entra.signIn(base, email)).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
      const call = (method, path, body, by = owner) => fetch(base + path, { method, headers: { cookie: cookies[by] }, body: JSON.stringify(body) });
      const { kick, active, byToken } = await import('./src/waker.ts');
      const first = createInstance('s', 'First', owner), second = createInstance('s', 'Second', owner);
      const proposal = first.append('agent', 'comment', { text: 'Approve the local result?', ask: 'proposal', run: 1 });
      writeFileSync(first.dir + '/working/result.txt', 'Local result to approve');
      second.append(owner, 'comment', { text: 'Start Second' }); kick(second); await turned.promise;
      const old = active.get('s'), oldEpoch = old.authority.epoch;
      assert.equal(old.inst, second);
      const agentComment = () => new Promise((ok, fail) => {
        const req = request({ socketPath: root + '/run.sock', path: '/api/instances/' + second.id + '/comment', method: 'POST', headers: { authorization: 'Bearer ' + old.token } }, res => {
          res.resume(); res.on('end', () => ok(res.statusCode));
        });
        req.on('error', fail); req.end(JSON.stringify({ text: 'Synthetic old-run comment' }));
      });
      assert.equal(await agentComment(), 200);
      const browserGate = Promise.withResolvers(), browserClosing = Promise.withResolvers();
      let cuts = 0;
      old.browsers = { cut: () => { cuts++; }, end: async () => { browserClosing.resolve(); await browserGate.promise; } };
      const gitGate = Promise.withResolvers();
      const finalGit = git.commit(second.dir, git.AGENT, 'old run Git tail', gitGate.promise);
      const hold = Promise.withResolvers(), prior = git.commit(first.dir, git.AGENT, 'prior local Git work', hold.promise);
      target = first.dir;
      let signed = false;
      const signing = call('POST', '/api/instances/' + first.id + '/signoff', { thread: 'c' + proposal.seq, text: 'Approved locally.', quiet: true }, actor).then(r => { signed = true; return r; });
      await entered.promise;
      controlPath = action === 'transfer' ? '/api/series/s/owner' : '/api/instances/' + (action === 'same-instance' ? first.id : second.id) + '/interrupt';
      let controlled = false;
      const controlling = call(action === 'transfer' ? 'PUT' : 'POST', controlPath, action === 'transfer' ? { owner: incoming } : {}).then(r => { controlled = true; return r; });
      await admitted.promise;
      if (action === 'same-instance') {
        await new Promise(ok => setTimeout(ok, 100));
        assert.equal(controlled, false, 'valid same-instance signoff keeps its control ordering across Git');
        assert.equal(byToken.has(old.token), true);
        assert.equal(await agentComment(), 200);
      } else {
        for (let n = 0; n < 100 && byToken.has(old.token); n++) await new Promise(ok => setTimeout(ok, 10));
        assert.equal(await agentComment(), 401, action + ' must refuse the active sibling token BEFORE First Git is released');
        assert.equal(byToken.has(old.token), false);
        await stopping.promise; await browserClosing.promise;
        assert.ok(cuts > 0, 'live browser access is cut before physical retirement');
        assert.equal(signed, false, 'First Git is still held');
        assert.equal(controlled, false, 'control response waits for physical retirement');
        const current = seriesSettings(seriesDir('s'));
        assert.equal(current.owner, action === 'transfer' ? incoming : owner);
        assert.equal(current.epoch, action === 'transfer' ? oldEpoch + 1 : oldEpoch);
        if (action === 'transfer') {
          assert.equal(current.consent, undefined, 'transfer never manufactures consent');
          let consented = false;
          const consent = call('PUT', '/api/series/s/credentials', { logins: [], autonomous: false }, incoming).then(r => { consented = true; return r; });
          await consentAdmitted.promise;
          await new Promise(ok => setImmediate(ok));
          assert.equal(consented, false, 'admitted new owner consent stays behind authority retirement');
          hold.resolve(); await prior;
          assert.equal((await signing).status, 200);
          stopped.resolve(); await new Promise(ok => setTimeout(ok, 50));
          assert.equal(controlled, false, 'browser closure still fences transfer');
          browserGate.resolve(); await new Promise(ok => setTimeout(ok, 50));
          assert.equal(controlled, false, 'old Git still fences transfer');
          gitGate.resolve(); await finalGit;
          assert.equal((await controlling).status, 200);
          assert.equal((await consent).status, 200);
          assert.equal((await call('POST', '/api/instances/' + second.id + '/comment', { text: 'New owner work' }, incoming)).status, 200);
        } else {
          assert.equal((await call('POST', '/api/instances/' + second.id + '/comment', { text: 'Replacement owner work' })).status, 200);
          await new Promise(ok => setTimeout(ok, 1700));
          assert.equal(starts, 1, 'no replacement writer while the old process lives');
          stopped.resolve(); await new Promise(ok => setTimeout(ok, 80));
          assert.equal(starts, 1, 'no replacement writer while the old browser lives');
          browserGate.resolve(); await new Promise(ok => setTimeout(ok, 80));
          assert.equal(starts, 1, 'no replacement writer while old Git is pending');
          gitGate.resolve(); await finalGit;
          assert.equal((await controlling).status, 200);
        }
        for (let n = 0; n < 250 && starts === 1; n++) await new Promise(ok => setTimeout(ok, 10));
        assert.equal(starts, 2);
        assert.equal(active.get('s').runner, action === 'transfer' ? incoming : owner);
        assert.equal(old.runner, owner);
        assert.equal(old.authority.epoch, oldEpoch, 'old executor and captured epoch remain immutable');
      }
      hold.resolve(); await prior;
      assert.equal((await signing).status, 200);
      if (action === 'same-instance') assert.equal((await controlling).status, 409, 'idle First has no run to interrupt');
      const entry = first.log.find(e => e.op === 'signoff');
      assert.equal(entry.by, actor); assert.equal(entry.on, proposal.seq);
      const signedCommit = execFileSync('git', ['show', '-s', '--format=%ae%n%B', entry.commit], { cwd: first.dir, encoding: 'utf8' });
      assert.ok(signedCommit.startsWith(actor + '\\n'));
      assert.ok(signedCommit.includes(proposal.text + '\\n\\nApproved locally.\\n\\nSigned-off-by: '));
      assert.ok(signedCommit.includes('<' + actor + '>'));
      assert.equal(execFileSync('git', ['show', entry.commit + ':working/result.txt'], { cwd: first.dir, encoding: 'utf8' }), 'Local result to approve');
      assert.equal(first.log.some(e => e.op === 'run'), false, 'collaborator approval never initiates execution');
      process.exit(0);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 20_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr: Buffer }).stderr.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
