import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const action of ['signoff', 'close', 'abandon']) for (const change of ['token', 'session', 'access', 'archive', 'status', 'runner', 'run', 'later-commit', 'unchanged']) {
  test(`${action} revalidates at the Git wait boundary: ${change}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rf-deferred-auth-'));
    try {
      execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { mock } from 'node:test';
        import { execFileSync } from 'node:child_process';
        import { mkdirSync, readFileSync } from 'node:fs';
        import { createServer } from 'node:net';
        import { idp } from './test/idp.ts';
        const root = ${JSON.stringify(root)}, action = ${JSON.stringify(action)}, change = ${JSON.stringify(change)};
        const admin = 'admin@demo.test', actor = 'actor@demo.test';
        const probe = createServer();
        await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
        const port = probe.address().port, base = 'http://127.0.0.1:' + port;
        await new Promise(ok => probe.close(ok));
        const entra = await idp();
        Object.assign(process.env, entra.env(base), { RF_ADMINS: admin, RF_HOST: '127.0.0.1', RF_MAX_RUNS: '0' });
        for (const name of ['RF_BROWSER_URL', 'RF_TUNNEL_URL', 'OPENROUTER_API_KEY', 'EXA_API_KEY']) delete process.env[name];
        const git = await import('./src/git.ts'), entered = Promise.withResolvers(), waitingLater = Promise.withResolvers();
        let armed = false, target, laterTail;
        mock.module('./src/git.ts', { namedExports: { ...git,
          committed: dir => {
            const tail = git.committed(dir);
            if (armed && dir === target) {
              entered.resolve();
              if (laterTail && tail === laterTail) waitingLater.resolve();
            }
            return tail;
          },
          commit: (...args) => {
            const result = git.commit(...args);
            if (armed && args[0] === target) entered.resolve();
            return result;
          },
        } });
        const { initSystem, saveTree, writeJson, tree } = await import('./src/system.ts');
        const { createInstance } = await import('./src/store.ts');
        const auth = await import('./src/auth.ts'), { active } = await import('./src/waker.ts');
        initSystem(root);
        saveTree({ workspaces: { w: { name: 'Work', owners: [admin], members: [actor] } }, series: { s: { name: 'Series', workspace: 'w' } } });
        writeJson('users.json', { [admin]: { role: 'admin' }, [actor]: { role: 'user' } });
        mkdirSync(root + '/series/s', { recursive: true });
        process.argv = [process.execPath, 'src/server.ts', root, String(port)];
        const ready = Promise.withResolvers();
        mock.method(console, 'log', line => { if (String(line).startsWith('rollforward on')) ready.resolve(); });
        await import('./src/server.ts');
        await ready.promise;
        const cookie = (await entra.signIn(base, actor)).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
        const token = auth.newToken(actor, 'deferred', 1), tokenId = auth.myTokens(actor).at(-1).id;
        const inst = createInstance('s', 'Deferred', actor, []);
        const ask = inst.append('agent', 'comment', { text: 'Approve the result?', thread: 'c2', ask: 'proposal', run: 1 });
        target = inst.dir;
        const hold = Promise.withResolvers(), prior = git.commit(inst.dir, git.AGENT, 'prior', hold.promise);
        armed = true;
        const response = fetch(base + '/api/instances/' + inst.id + '/' + action, {
          method: 'POST', headers: change === 'session' ? { cookie } : { authorization: 'Bearer ' + token },
          body: JSON.stringify({ thread: 'c' + ask.seq, quiet: true }),
        });
        await Promise.race([entered.promise, response.then(r => { throw new Error('action did not wait: ' + r.status); })]);
        let last = prior, release = hold;
        if (change === 'later-commit') {
          release = Promise.withResolvers();
          last = git.commit(inst.dir, git.AGENT, 'later prior', release.promise);
          laterTail = git.committed(inst.dir);
          hold.resolve();
          await prior;
          await Promise.race([waitingLater.promise, response.then(r => { throw new Error('action skipped the later Git wait: ' + r.status); })]);
        }
        let expected = 401;
        if (change === 'token' || change === 'later-commit') auth.revokeToken(actor, tokenId);
        if (change === 'session') auth.signOutEverywhere(actor);
        if (change === 'access' || change === 'archive') {
          const t = tree();
          if (change === 'access') t.workspaces.w.members = [];
          else t.series.s.archived = true;
          saveTree(t);
          expected = change === 'access' ? 404 : 409;
        }
        if (change === 'status') {
          inst.doc.status = 'abandoned';
          inst.save();
          expected = 409;
        }
        if (change === 'runner') {
          inst.append(admin, 'assign', { to: admin, from: actor, logins: [] });
          expected = action === 'signoff' ? 200 : 403;
        }
        if (change === 'run') {
          active.set('s', { inst });
          expected = 409;
        }
        if (change === 'unchanged') expected = 200;
        const before = ['screen.json', 'log.jsonl'].map(file => readFileSync(inst.dir + '/' + file, 'utf8'));
        release.resolve();
        const hash = await last, result = await response, detail = await result.text();
        assert.equal(inst.closing, false);
        if (expected !== 200) {
          assert.deepEqual(inst.doc, JSON.parse(before[0]), 'refused action must not change in-memory status');
          assert.deepEqual(['screen.json', 'log.jsonl'].map(file => readFileSync(inst.dir + '/' + file, 'utf8')), before, 'refused action must not persist status or log changes');
          assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: inst.dir, encoding: 'utf8' }).trim(), hash, 'refused action must not create a human commit');
        } else {
          assert.equal(inst.log.at(-1).op, action);
          assert.equal(inst.doc.status, action === 'close' ? 'closed' : action === 'abandon' ? 'abandoned' : 'open');
        }
        assert.equal(result.status, expected, detail);
        process.exit(0);
      `], { cwd: join(import.meta.dirname, '..'), timeout: 15_000, stdio: 'pipe' });
    } catch (e) {
      assert.fail((e as { stderr: Buffer }).stderr.toString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
