import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idp } from './idp.ts';

const repoDir = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'r4-data-http-waker-')), root = join(tmp, 'data');
let proc: ChildProcess, port = 0, base = '', entra: Awaited<ReturnType<typeof idp>>;
let adminCookie = '', bobCookie = '', carolCookie = '';
const ADMIN = 'admin@demo.test', BOB = 'bob@demo.test', CAROL = 'carol@demo.test';

const sessionOf = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0]!;
const call = (method: string, path: string, body?: BodyInit, cookie = adminCookie) =>
  fetch(base + path, { method, body, headers: { cookie } });
const json = async (path: string, cookie = adminCookie) => (await call('GET', path, undefined, cookie)).json();
const nap = (ms: number) => new Promise(r => setTimeout(r, ms));

async function startServer() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, 'home'),
    RF_SCRATCH: join(tmp, 'scratch'),
    RF_ADMINS: ADMIN,
    RF_MIN_FREE_GB: '0',
    RF_WAKE_TICK_MS: '100',
    RF_MAX_RUNS: '0',
    ...entra.env(base),
  };
  delete env.OPENROUTER_API_KEY;
  delete env.RF_BROWSER_URL;
  mkdirSync(env.HOME!, { recursive: true });

  proc = spawn(process.execPath, [join(repoDir, 'src', 'server.ts'), root, String(port)], {
    cwd: repoDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr!.on('data', d => process.stderr.write(d));
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok());
    proc.on('exit', (code, sig) => fail(new Error(`server exited with ${code ?? sig}`)));
  });
}

async function stopServer() {
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await once(proc, 'exit').catch(() => {});
  }
}

before(async () => {
  cpSync(join(repoDir, 'test', 'fixture'), root, { recursive: true });
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  port = (probe.address() as { port: number }).port;
  await new Promise<void>(ok => probe.close(() => ok()));
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  await startServer();
  adminCookie = sessionOf(await entra.signIn(base, ADMIN));
  bobCookie = sessionOf(await entra.signIn(base, BOB));
  carolCookie = sessionOf(await entra.signIn(base, CAROL));
});

after(async () => {
  await stopServer();
  entra?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('R4-DATA-01: aborted /files/, cached /preview/, and series /files/ transfers close their file descriptors and do not pin deleted files', async () => {
  const ws = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'fd-ws' }))).json();
  const ser = await (await call('POST', '/api/series', JSON.stringify({ workspace: ws.id, name: 'fd-ser' }))).json();
  const inst = await (await call('POST', `/api/series/${ser.id}`, JSON.stringify({ label: '2026-11', quiet: true }))).json();

  const big = Buffer.alloc(4 * 1024 * 1024, 0x41);
  assert.equal((await call('POST', `/api/instances/${inst.id}/upload?name=secret.bin&quiet=1`, big)).status, 200);
  assert.equal((await call('POST', `/api/instances/${inst.id}/upload?name=notes.txt&quiet=1`, Buffer.alloc(512 * 1024, 0x42))).status, 200);
  assert.equal((await call('GET', `/preview/${inst.id}/upload/notes.txt`)).status, 200);
  assert.equal((await call('POST', `/api/series/${ser.id}/attach?name=series-big.bin`, big)).status, 200);

  const serverFds = () => readdirSync(`/proc/${proc.pid}/fd`).map(fd => {
    try { return readlinkSync(`/proc/${proc.pid}/fd/${fd}`); } catch { return ''; }
  });
  const countOpen = (sub: string) => serverFds().filter(t => t.includes(sub)).length;

  const abortGet = (urlPath: string) => new Promise<void>(done => {
    const s = connect(port, '127.0.0.1', () => {
      s.write(`GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${adminCookie}\r\n\r\n`);
    });
    s.once('data', () => {
      s.destroy();
      setTimeout(done, 15);
    });
  });

  for (let i = 0; i < 10; i++) await abortGet(`/files/${inst.id}/upload/secret.bin`);
  for (let i = 0; i < 5; i++) await abortGet(`/preview/${inst.id}/upload/notes.txt`);
  for (let i = 0; i < 5; i++) await abortGet(`/api/series/${ser.id}/files/series-big.bin`);
  await nap(150);

  const leakedSecret = countOpen('upload/secret.bin');
  const leakedPreview = countOpen('.previews/');
  const leakedSeries = countOpen('notes/files/series-big.bin');

  // Completed downloads still work and close fds cleanly
  for (const path of [`/files/${inst.id}/upload/secret.bin`, `/preview/${inst.id}/upload/notes.txt`, `/api/series/${ser.id}/files/series-big.bin`]) {
    const r = await call('GET', path);
    assert.equal(r.status, 200);
    assert.ok((await r.arrayBuffer()).byteLength > 0);
  }

  assert.equal((await call('POST', `/api/instances/${inst.id}/delete`, '{}')).status, 200);
  const pinnedAfterDelete = serverFds().filter(t => t.includes('upload/secret.bin')).length;

  assert.deepEqual(
    { leakedSecret, leakedPreview, leakedSeries, pinnedAfterDelete },
    { leakedSecret: 0, leakedPreview: 0, leakedSeries: 0, pinnedAfterDelete: 0 },
  );
});

test('R4-DATA-03 (BURST1-05): run-created wakes drop across workspaces while same-workspace cadence stays intact', async () => {
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const setupPair = async (tag: string) => {
    const wsA = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Source-' + tag }))).json();
    const wsB = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Dest-' + tag }))).json();
    await call('PUT', `/api/workspaces/${wsA.id}`, JSON.stringify({ owners: [BOB], members: [] }));
    await call('PUT', `/api/workspaces/${wsB.id}`, JSON.stringify({ owners: [CAROL], members: [] }));
    const src = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsA.id, name: 'Feeder' }), bobCookie)).json();
    const target = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsA.id, name: 'Target' }), bobCookie)).json();
    const inst = await (await call('POST', `/api/series/${src.id}`, JSON.stringify({ label: 'one', quiet: true }), bobCookie)).json();
    return { wsA, wsB, src, target, inst };
  };

  // 1) Target moved to another workspace after run-created weekly wake was set (including after source deletion)
  const moved = await setupPair('moved');
  const movedDeleted = await setupPair('moved-del');
  // 2) Source closed in the same workspace (cadence must keep firing & re-arming)
  const closedLocal = await setupPair('closed');
  assert.equal((await call('POST', `/api/instances/${closedLocal.inst.id}/close`, JSON.stringify({ quiet: true }), bobCookie)).status, 200);
  assert.equal((await call('PUT', `/api/series/${closedLocal.target.id}`, JSON.stringify({ share: true, logins: [] }), bobCookie)).status, 200);

  const wakesFile = join(root, '.rf', 'wakes.json');
  const dueSoon = new Date(Date.now() + 700).toISOString();
  const w = existsSync(wakesFile) ? JSON.parse(readFileSync(wakesFile, 'utf8')) : { pending: {}, fired: {}, requests: {} };
  w.pending['wk_moved'] = { target: moved.target.id, at: dueSoon, from: 'Source-moved/Feeder/one', inst: moved.inst.id, label: '2026-11-15', days, text: 'from moved' };
  w.pending['wk_moved_del'] = { target: movedDeleted.target.id, at: dueSoon, from: 'Source-moved-del/Feeder/one', inst: movedDeleted.inst.id, label: '2026-11-15', days, text: 'from moved deleted' };
  w.pending['wk_closed'] = { target: closedLocal.target.id, at: dueSoon, from: 'Source-closed/Feeder/one', inst: closedLocal.inst.id, label: '2026-11-15', days, text: 'from closed' };
  writeFileSync(wakesFile, JSON.stringify(w, null, 1));

  assert.equal((await call('POST', `/api/instances/${movedDeleted.inst.id}/delete`, '{}', bobCookie)).status, 200);

  // Move both `moved.target` and `movedDeleted.target` into Carol's workspace B, share them there, and rename Bob's private workspaces
  for (const p of [moved, movedDeleted]) {
    assert.equal((await call('PUT', `/api/proposals/${p.wsA.id}`, JSON.stringify({ kind: 'move', series: p.target.id, to: p.wsB.id }))).status, 200);
    assert.equal((await call('POST', `/api/proposals/${p.wsA.id}`, JSON.stringify({ owners: [], members: [] }), carolCookie)).status, 200);
    assert.equal((await call('PUT', `/api/series/${p.target.id}`, JSON.stringify({ share: true, logins: [] }), carolCookie)).status, 200);
    assert.equal((await call('PUT', `/api/workspaces/${p.wsA.id}`, JSON.stringify({ name: 'SECRET-PRIVATE-' + p.wsA.id }), bobCookie)).status, 200);
  }

  await nap(1000);

  const carolAll = (await json('/api', carolCookie)).flatMap((x: any) => x.series);
  const carolSer = carolAll.find((s: any) => s.id === moved.target.id);
  const carolDelSer = carolAll.find((s: any) => s.id === movedDeleted.target.id);
  const bobClosedSer = (await json('/api', bobCookie)).flatMap((x: any) => x.series).find((s: any) => s.id === closedLocal.target.id);
  const finalWakes = JSON.parse(readFileSync(wakesFile, 'utf8'));

  assert.equal(carolSer.instances.length, 0, 'cross-workspace run wake must not start an instance');
  assert.equal(carolSer.requests.length, 0, 'cross-workspace run wake must not record a request');
  assert.equal(finalWakes.pending['wk_moved'], undefined, 'cross-workspace weekly run wake must not re-arm');
  assert.equal(carolDelSer.instances.length, 0, 'deleted cross-workspace run wake must not start an instance');
  assert.equal(finalWakes.pending['wk_moved_del'], undefined, 'deleted cross-workspace weekly run wake must not re-arm');
  assert.equal(bobClosedSer.instances.length, 1, 'closed same-workspace source cadence still fires');
  assert.ok(finalWakes.pending['wk_closed'], 'closed same-workspace weekly cadence still re-arms');
});
