import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { CUT, LEGACY_CUT } from '../src/waker.ts';
import { idp } from './idp.ts';
import { ownSeries } from './owner-fixture.ts';

const repoDir = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-review-fixes-')), root = join(tmp, 'data');
const admin = 'admin@demo.test';

async function freePort() {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test('persisted done entries with legacy CUT reasons still classify as cut in /api/runs', async () => {
  assert.equal(Object.values(CUT).includes('its reach narrowed'), false);
  assert.equal(Object.values(CUT).includes('an instance in its reach was deleted'), false);
  assert.ok((LEGACY_CUT as readonly string[]).includes('its reach narrowed'));
  assert.ok((LEGACY_CUT as readonly string[]).includes('an instance in its reach was deleted'));

  initSystem(root);
  openStore(root);
  saveTree({
    workspaces: { w: { name: 'Acme', owners: [admin], members: [] } },
    series: { s1: { name: 'Bank rec', workspace: 'w' } },
  });
  writeJson('users.json', { [admin]: { role: 'admin' } });
  mkdirSync(join(root, 'series', 's1'), { recursive: true });
  ownSeries('s1', admin, [], false);
  const inst = createInstance('s1', '2026-01', admin);
  inst.append('server', 'run', { run: 1, runner: admin });
  inst.append('server', 'done', { run: 1, cost: 0, error: 'its reach narrowed' });
  inst.append('server', 'run', { run: 2, runner: admin });
  inst.append('server', 'done', { run: 2, cost: 0, error: 'an instance in its reach was deleted' });

  const entra = await idp();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const proc = spawn(process.execPath, [join(repoDir, 'src', 'server.ts'), root, String(port)], {
    cwd: repoDir,
    env: { ...process.env, HOME: home, RF_SCRATCH: join(tmp, 'scratch'), RF_ADMINS: admin, RF_MIN_FREE_GB: '0', RF_MAX_RUNS: '0', ...entra.env(base) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    const login = await entra.signIn(base, admin);
    const cookie = login.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
    const res = await fetch(`${base}/api/runs`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.outcome, 'cut');
  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => proc.once('exit', r));
    entra.close();
  }
});

test('/api/resolve returns 404 for a deleted instance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-resolve-deleted-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const entra = await idp();
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { mock } from 'node:test';
      import { mkdirSync } from 'node:fs';
      import * as sandbox from './src/sandbox.ts';
      import { createInstance, openStore } from './src/store.ts';
      import { initSystem, saveTree, writeJson } from './src/system.ts';
      import { ownSeries } from './test/owner-fixture.ts';
      let agentHandler;
      mock.module('./src/sandbox.ts', { namedExports: { ...sandbox, serveSandboxes: o => { agentHandler = o.agent; return sandbox.serveSandboxes(o); } } });
      const root = ${JSON.stringify(join(dir, 'data'))}, port = ${port}, base = ${JSON.stringify(base)}, admin = ${JSON.stringify(admin)};
      initSystem(root);
      openStore(root);
      saveTree({ workspaces: { w: { name: 'Acme', owners: [admin], members: [] } }, series: { s1: { name: 'Bank rec', workspace: 'w' } } });
      writeJson('users.json', { [admin]: { role: 'admin' } });
      mkdirSync(root + '/series/s1', { recursive: true });
      ownSeries('s1', admin, [], false);
      const i1 = createInstance('s1', '2026-01', admin);
      const i2 = createInstance('s1', '2026-02', admin);
      process.argv = [process.execPath, './src/server.ts', root, String(port)];
      await import('./src/server.ts');
      const { instance } = await import('./src/store.ts');
      const { active, byToken, remove, view } = await import('./src/waker.ts');
      const { authority } = await import('./src/logins.ts');
      const srv = createServer((req, res) => agentHandler(req, res, new URL(req.url, 'http://sandbox')));
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      const agentBase = 'http://127.0.0.1:' + srv.address().port;
      const cur1 = instance(i1.id), cur2 = instance(i2.id);
      const lease = authority(cur1), token = 'tok-resolve-deleted';
      const a = { inst: cur1, n: 1, runner: lease.owner, authority: lease, token, workspace: lease.workspace, view: view(cur1) };
      active.set(cur1.seriesId, a);
      byToken.set(token, a);
      const before = await fetch(agentBase + '/api/resolve?path=' + encodeURIComponent('../2026-02'), { headers: { authorization: 'Bearer ' + token } });
      assert.equal(before.status, 200);
      assert.equal((await before.json()).id, cur2.id);
      await remove(cur2, admin, () => ({ cost: 0, runs: [] }));
      const after = await fetch(agentBase + '/api/resolve?path=' + encodeURIComponent('../2026-02'), { headers: { authorization: 'Bearer ' + token } });
      assert.equal(after.status, 404);
      process.exit(0);
    `], {
      cwd: repoDir,
      env: { ...process.env, HOME: join(dir, 'home'), RF_SCRATCH: join(dir, 'scratch'), RF_ADMINS: admin, RF_MIN_FREE_GB: '0', RF_MAX_RUNS: '0', ...entra.env(base) },
      stdio: 'inherit',
    });
  } finally {
    entra.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
