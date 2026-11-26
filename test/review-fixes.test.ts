import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { CUT } from '../src/waker.ts';
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
  assert.ok(Object.values(CUT).includes('its reach narrowed'));
  assert.ok(Object.values(CUT).includes('an instance in its reach was deleted'));

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
    const res = await fetch(`${base}/api/runs?limit=50`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : body.runs ?? body.rows;
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.outcome, 'cut');
  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => proc.once('exit', r));
    entra.close();
  }
});
