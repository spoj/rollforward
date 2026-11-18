import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['new-instance', 'request-series', 'request-instance']) for (const change of ['token', 'session', 'unchanged']) {
  test(`${mode} revalidates its queued initiation credential: ${change}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rf-queued-initiation-'));
    try {
      execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { mock } from 'node:test';
        import { readFileSync } from 'node:fs';
        import { createServer } from 'node:net';
        import { idp } from './test/idp.ts';
        const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}, change = ${JSON.stringify(change)};
        const owner = 'alice@demo.test', probe = createServer();
        await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
        const port = probe.address().port, base = 'http://127.0.0.1:' + port;
        await new Promise(ok => probe.close(ok));
        const entra = await idp();
        Object.assign(process.env, entra.env(base), { RF_ADMINS: owner, RF_HOST: '127.0.0.1', RF_MAX_RUNS: '0' });
        for (const name of ['OPENROUTER_API_KEY', 'EXA_API_KEY', 'RF_BROWSER_URL', 'RF_TUNNEL_URL']) delete process.env[name];
        const auth = await import('./src/auth.ts'), admitted = Promise.withResolvers();
        const path = mode === 'new-instance' ? '/api/series/s' : '/api/requests/request1';
        mock.module('./src/auth.ts', { namedExports: { ...auth, recheckRequest: req => {
          auth.recheckRequest(req);
          if (req.url === path) admitted.resolve();
        } } });
        const { initSystem, saveTree, writeJson } = await import('./src/system.ts');
        const { openStore, createInstance, labels, instance, seriesDir } = await import('./src/store.ts');
        const { appendMessage } = await import('./src/message-store.ts');
        const { ownSeries } = await import('./test/owner-fixture.ts');
        initSystem(root); openStore(root);
        writeJson('users.json', { [owner]: { role: 'admin' } });
        saveTree({ workspaces: { w: { name: 'Work', owners: [owner], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
        ownSeries('s', owner, [], true);
        const waker = await import('./src/waker.ts');
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        mock.module('./src/waker.ts', { namedExports: { ...waker, retireSeries: async sid => {
          await waker.retireSeries(sid);
          entered.resolve(); await release.promise;
        } } });
        process.argv = [process.execPath, 'src/server.ts', root, String(port)];
        const ready = Promise.withResolvers();
        mock.method(console, 'log', line => { if (String(line).startsWith('rollforward on')) ready.resolve(); });
        await import('./src/server.ts'); await ready.promise;
        const cookie = (await entra.signIn(base, owner)).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
        const { pending } = await import('./src/waker.ts');
        createInstance('s', 'Z-existing', owner);
        const target = mode === 'request-instance' ? createInstance('s', 'A-existing', owner) : undefined;
        const blocked = fetch(base + '/api/series/s/credentials', { method: 'PUT', headers: { cookie }, body: '{"logins":[],"autonomous":false}' });
        await entered.promise;
        if (mode !== 'new-instance') {
          const label = 'Accepted', from = 'collaborator@demo.test';
          const request = appendMessage(seriesDir('s'), target ? { instance: target.id } : {}, {
            seq: 1, by: from, at: new Date().toISOString(), op: 'request', requestId: 'request1', label, from, text: 'Information only'
          });
          writeJson('wakes.json', { pending: {}, fired: {}, requests: {
            request1: { series: 's', label, ...(target && { target: target.id }), message: request.id }
          } });
        } else writeJson('wakes.json', { pending: {}, fired: {}, requests: {} });
        const token = auth.newToken(owner, 'queued', 1), tokenId = auth.myTokens(owner).find(t => t.name === 'queued').id;
        const headers = change === 'session' ? { cookie } : { authorization: 'Bearer ' + token };
        let responded = false;
        const response = fetch(base + path, { method: 'POST', headers, body: JSON.stringify(mode === 'new-instance' ? { label: 'Accepted' } : {}) }).then(r => { responded = true; return r; });
        await admitted.promise;
        await new Promise(ok => setImmediate(ok));
        assert.equal(responded, false, 'initiation must be queued after its original credential check');
        if (change === 'token') assert.equal((await fetch(base + '/tokens/' + tokenId, { method: 'DELETE', headers: { cookie } })).status, 200);
        if (change === 'session') auth.signOutEverywhere(owner);
        assert.equal((await fetch(base + '/api', { headers })).status, change === 'unchanged' ? 200 : 401);
        const beforeLabels = labels('s');
        const files = [root + '/.rf/wakes.json', ...beforeLabels.flatMap(l => [instance(l.id).dir + '/screen.json', instance(l.id).dir + '/log.jsonl'])];
        const before = files.map(file => readFileSync(file, 'utf8'));
        release.resolve();
        assert.equal((await blocked).status, 200);
        const result = await response, detail = await result.text();
        assert.equal(result.status, change === 'unchanged' ? 200 : 401, detail);
        if (change !== 'unchanged') {
          assert.deepEqual(labels('s'), beforeLabels, 'revoked initiation must not create an instance');
          assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before, 'revoked initiation must not change requests, wakes or existing instance files');
        } else {
          const inst = instance(JSON.parse(detail).id);
          assert.ok(pending(inst, 0).some(e => e.authority?.owner === owner), 'valid queued initiation retains executable owner authority');
        }
        process.exit(0);
      `], { cwd: join(import.meta.dirname, '..'), timeout: 20_000, stdio: 'pipe' });
    } catch (e) {
      assert.fail((e as { stderr: Buffer }).stderr.toString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
