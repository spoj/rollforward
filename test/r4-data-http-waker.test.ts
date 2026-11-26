import { after, before, test } from 'node:test';
import { fireFixtureRequests, migrateFixtureMessages, readFixtureTree } from './owner-fixture.ts';
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
  const t = readFixtureTree(root);
  for (const id of Object.keys(t.series)) {
    mkdirSync(join(root, 'series', id), { recursive: true });
    writeFileSync(join(root, 'series', id, 'series.json'), JSON.stringify({ version: 1, epoch: 0, since: '' }));
  }
  migrateFixtureMessages(root);

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

test('Start keeps another instance request text a note', async () => {
  const name = 'request-provenance';
  const ws = await (await call('POST', '/api/workspaces', JSON.stringify({ name }))).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws.id}`, JSON.stringify({ members: [BOB] }))).status, 200);
  const ser = await (await call('POST', '/api/series', JSON.stringify({ workspace: ws.id, name: 'S', logins: [], autonomous: false }))).json();
  const source = await (await call('POST', `/api/series/${ser.id}`, JSON.stringify({ label: 'source', quiet: true }), bobCookie)).json();
  const wakesFile = join(root, '.rf', 'wakes.json'), id = 'source-request';
  await fireFixtureRequests(root, { [id]: { target: ser.id, label: 'next', from: `${name}/S/source`, inst: source.id, text: 'Original source instruction.' } });
  const started = await call('POST', `/api/requests/${id}`, '{}');
  assert.equal(started.status, 200);
  const { id: next } = await started.json();
  const log = (await json(`/api/instances/${next}`)).log;
  assert.deepEqual(log.filter((e: any) => e.op === 'wake').map((e: any) => [e.from, e.text, e.note]), [
    [`${name}/S/source`, 'Original source instruction.', true],
    [ADMIN, undefined, undefined],
  ]);
  assert.equal(JSON.parse(readFileSync(wakesFile, 'utf8')).requests[id], undefined);
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
    const src = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsA.id, name: 'Feeder', logins: [], autonomous: true }), bobCookie)).json();
    const target = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsA.id, name: 'Target', logins: [], autonomous: true }), bobCookie)).json();
    const inst = await (await call('POST', `/api/series/${src.id}`, JSON.stringify({ label: 'one', quiet: true }), bobCookie)).json();
    return { wsA, wsB, src, target, inst };
  };

  // 1) Target moved to another workspace after run-created weekly wake was set (including after source deletion)
  const moved = await setupPair('moved');
  const movedDeleted = await setupPair('moved-del');
  // 2) Same-workspace cross-series legacy persisted wake (must be dropped cleanly without starting anything)
  const sameWsCross = await setupPair('same-ws-cross');
  // 3) Closed source in the SAME series (cadence must keep firing & re-arming)
  const closedLocal = await setupPair('closed');
  const closedOwnInst = await (await call('POST', `/api/series/${closedLocal.target.id}`, JSON.stringify({ label: 'one', quiet: true }), bobCookie)).json();
  assert.equal((await call('POST', `/api/instances/${closedOwnInst.id}/close`, JSON.stringify({ quiet: true }), bobCookie)).status, 200);
  assert.equal((await call('PUT', `/api/series/${closedLocal.target.id}/credentials`, JSON.stringify({ autonomous: true, logins: [] }), bobCookie)).status, 200);

  const wakesFile = join(root, '.rf', 'wakes.json');
  const dueSoon = new Date(Date.now() + 700).toISOString();
  const w = existsSync(wakesFile) ? JSON.parse(readFileSync(wakesFile, 'utf8')) : { pending: {}, fired: {}, requests: {} };
  const snapshot = (p: typeof moved) => {
    const s = JSON.parse(readFileSync(join(root, 'series', p.target.id, 'series.json'), 'utf8'));
    return { request: false, initiator: BOB, authority: { version: 1, owner: BOB, epoch: s.epoch, workspace: p.wsA.id, logins: [], autonomous: true } };
  };
  w.pending['wk_moved'] = { target: moved.target.id, at: dueSoon, from: 'Source-moved/Feeder/one', inst: moved.inst.id, label: '2026-11-15', days, text: 'from moved', ...snapshot(moved) };
  w.pending['wk_moved_del'] = { target: movedDeleted.target.id, at: dueSoon, from: 'Source-moved-del/Feeder/one', inst: movedDeleted.inst.id, label: '2026-11-15', days, text: 'from moved deleted', ...snapshot(movedDeleted) };
  w.pending['wk_same_ws_cross'] = { target: sameWsCross.target.id, at: dueSoon, from: 'Source-same-ws-cross/Feeder/one', inst: sameWsCross.inst.id, label: '2026-11-15', days, text: 'from same ws other series', ...snapshot(sameWsCross) };
  w.pending['wk_closed'] = { target: closedLocal.target.id, at: dueSoon, from: 'Source-closed/Target/one', inst: closedOwnInst.id, label: '2026-11-15', days, text: 'from closed', ...snapshot(closedLocal) };
  writeFileSync(wakesFile, JSON.stringify(w, null, 1));

  assert.equal((await call('POST', `/api/instances/${movedDeleted.inst.id}/delete`, '{}', bobCookie)).status, 200);

  // Move both targets, transfer ownership, and consent afresh without reviving the old schedules.
  for (const p of [moved, movedDeleted]) {
    assert.equal((await call('PUT', `/api/proposals/${p.wsA.id}`, JSON.stringify({ kind: 'move', series: p.target.id, to: p.wsB.id }))).status, 200);
    assert.equal((await call('POST', `/api/proposals/${p.wsA.id}`, JSON.stringify({ owners: [], members: [] }), carolCookie)).status, 200);
    assert.equal((await call('PUT', `/api/series/${p.target.id}/owner`, JSON.stringify({ owner: CAROL }))).status, 200);
    assert.equal((await call('PUT', `/api/series/${p.target.id}/credentials`, JSON.stringify({ autonomous: true, logins: [] }), carolCookie)).status, 200);
    assert.equal((await call('PUT', `/api/workspaces/${p.wsA.id}`, JSON.stringify({ name: 'SECRET-PRIVATE-' + p.wsA.id }), bobCookie)).status, 200);
  }

  await nap(1000);

  const carolAll = (await json('/api', carolCookie)).flatMap((x: any) => x.series);
  const bobAll = (await json('/api', bobCookie)).flatMap((x: any) => x.series);
  const carolSer = carolAll.find((s: any) => s.id === moved.target.id);
  const carolDelSer = carolAll.find((s: any) => s.id === movedDeleted.target.id);
  const bobSameWsCrossSer = bobAll.find((s: any) => s.id === sameWsCross.target.id);
  const bobClosedSer = bobAll.find((s: any) => s.id === closedLocal.target.id);
  const finalWakes = JSON.parse(readFileSync(wakesFile, 'utf8'));

  assert.equal(carolSer.instances.length, 0, 'cross-workspace run wake must not start an instance');
  assert.equal(carolSer.requests.length, 0, 'cross-workspace run wake must not record a request');
  assert.equal(finalWakes.pending['wk_moved'], undefined, 'cross-workspace weekly run wake must not re-arm');
  assert.equal(carolDelSer.instances.length, 0, 'deleted cross-workspace run wake must not start an instance');
  assert.equal(finalWakes.pending['wk_moved_del'], undefined, 'deleted cross-workspace weekly run wake must not re-arm');
  assert.equal(bobSameWsCrossSer.instances.length, 0, 'same-workspace cross-series persisted wake must not start an instance');
  assert.equal(finalWakes.pending['wk_same_ws_cross'], undefined, 'same-workspace cross-series persisted wake was dropped');
  assert.equal(bobClosedSer.instances.length, 2, 'closed same-series source cadence still fires and creates next period');
  assert.ok(finalWakes.pending['wk_closed'], 'closed same-series weekly cadence still re-arms');
});

test('R4-DATA-04: streaming upload/attach recheck archive, proposals refuse moving archived series, and archive refuses in-flight close/abandon', async () => {
  const streamPost = (urlPath: string) => {
    const req = httpRequest(`${base}${urlPath}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'transfer-encoding': 'chunked' },
    });
    req.write('first-chunk-');
    return () => new Promise<number>((resolve, reject) => {
      req.on('error', reject);
      req.on('response', async res => {
        for await (const _ of res) {}
        resolve(res.statusCode!);
      });
      req.end('last-chunk');
    });
  };

  // 1) Mid-stream series archive & workspace archive refuse upload, instance attach, and series attach (and clean .tmp)
  for (const scope of ['series', 'workspaces'] as const) {
    const ws = await (await call('POST', '/api/workspaces', JSON.stringify({ name: `arch-stream-${scope}` }))).json();
    const ser = await (await call('POST', '/api/series', JSON.stringify({ workspace: ws.id, name: 'S' }))).json();
    const inst = await (await call('POST', `/api/series/${ser.id}`, JSON.stringify({ label: 'one', quiet: true }))).json();
    const finishes = [
      streamPost(`/api/instances/${inst.id}/upload?name=late.bin&quiet=1`),
      streamPost(`/api/instances/${inst.id}/attach?name=late.bin`),
      streamPost(`/api/series/${ser.id}/attach?name=late.bin`),
    ];
    await nap(80);
    assert.equal((await call('PUT', `/api/${scope}/${scope === 'series' ? ser.id : ws.id}`, JSON.stringify({ archived: true }))).status, 200);
    const statuses = await Promise.all(finishes.map(f => f()));
    assert.deepEqual(statuses, [409, 409, 409], `mid-stream ${scope} archive must refuse all three`);
    assert.equal((await json(`/api/instances/${inst.id}`)).doc.items.length, 0);
    assert.equal(existsSync(join(root, 'instances', inst.id, 'upload', 'late.bin')), false);
    assert.equal(existsSync(join(root, 'instances', inst.id, 'upload', 'attachments', 'late.bin')), false);
    assert.equal(existsSync(join(root, 'series', ser.id, 'notes', 'files', 'late.bin')), false);
    assert.deepEqual(readdirSync(join(root, '.tmp')), []);
  }

  // 2) Proposing or accepting a move of an archived series returns 409
  const wsA = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'arch-move-src' }))).json();
  const wsB = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'arch-move-dst' }))).json();
  const ser1 = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsA.id, name: 'ArchivedBeforePropose' }))).json();
  assert.equal((await call('PUT', `/api/series/${ser1.id}`, JSON.stringify({ archived: true }))).status, 200);
  assert.equal((await call('PUT', `/api/proposals/${wsA.id}`, JSON.stringify({ kind: 'move', series: ser1.id, to: wsB.id }))).status, 409);

  const ser2 = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsA.id, name: 'ArchivedBeforeAccept' }))).json();
  assert.equal((await call('PUT', `/api/proposals/${wsA.id}`, JSON.stringify({ kind: 'move', series: ser2.id, to: wsB.id }))).status, 200);
  assert.equal((await call('PUT', `/api/series/${ser2.id}`, JSON.stringify({ archived: true }))).status, 200);
  assert.equal((await call('POST', `/api/proposals/${wsA.id}`, JSON.stringify({ owners: [], members: [] }))).status, 409);

  // 3) Archive coordinated with in-flight close / abandon finalization (tested deterministically in-process with held prior commit)
  const subTmp = mkdtempSync(join(tmpdir(), 'r4-data-04-fin-'));
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { join } from 'node:path';
      import { idp } from './test/idp.ts';
      import { migrateFixtureMessages, readFixtureTree } from './test/owner-fixture.ts';
      const subTmp = ${JSON.stringify(subTmp)}, root = join(subTmp, 'data');
      cpSync('./test/fixture', root, { recursive: true });
      const t = readFixtureTree(root);
      for (const id of Object.keys(t.series)) {
        mkdirSync(join(root, 'series', id), { recursive: true });
        writeFileSync(join(root, 'series', id, 'series.json'), JSON.stringify({ version: 1, epoch: 0, since: '' }));
      }
      migrateFixtureMessages(root);

      const probe = createServer();
      await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
      const port = probe.address().port;
      await new Promise(ok => probe.close(ok));
      const base = 'http://127.0.0.1:' + port, admin = 'admin@demo.test', entra = await idp();
      Object.assign(process.env, entra.env(base), { RF_ADMINS: admin, RF_MIN_FREE_GB: '0', RF_MAX_RUNS: '0', RF_WAKE_TICK_MS: '60000', HOME: join(subTmp, 'home'), RF_SCRATCH: join(subTmp, 'scratch') });
      mkdirSync(process.env.HOME, { recursive: true });
      const git = await import('./src/git.ts');
      process.argv[2] = root; process.argv[3] = String(port);
      await import('./src/server.ts');
      const store = await import('./src/store.ts'), waker = await import('./src/waker.ts');
      await new Promise(r => setTimeout(r, 50));
      const cookie = (await entra.signIn(base, admin)).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
      const call = (method, path, body) => fetch(base + path, { method, headers: { cookie }, ...(body && { body: JSON.stringify(body) }) });

      const results = [];
      for (const action of ['close', 'abandon']) for (const scope of ['series', 'workspaces']) {
        const ws = await (await call('POST', '/api/workspaces', { name: action + '-' + scope })).json();
        const ser = await (await call('POST', '/api/series', { workspace: ws.id, name: 'S' })).json();
        const obj = await (await call('POST', '/api/series/' + ser.id, { label: 'one', quiet: true })).json();
        const inst = store.instance(obj.id);
        const hold = Promise.withResolvers();
        const prior = git.commit(inst.dir, { name: 'Admin', email: admin }, 'prior', hold.promise);
        const fin = call('POST', '/api/instances/' + inst.id + '/' + action, { quiet: true });
        await new Promise(r => setTimeout(r, 40));
        const arch = await call('PUT', '/api/' + scope + '/' + (scope === 'series' ? ser.id : ws.id), { archived: true });
        hold.resolve();
        await prior;
        const finRes = await fin;
        results.push({ action, scope, archStatus: arch.status, finStatus: finRes.status });
      }
      console.log(JSON.stringify(results));
      waker.stop(); entra.close(); process.exit(0);
    `], { cwd: repoDir, encoding: 'utf8', timeout: 15_000 });
    const results = JSON.parse(out.trim().split('\n').at(-1)!);
    for (const r of results) {
      assert.equal(r.archStatus, 409, `expected archive 409 while ${r.action} finalizing on ${r.scope}, got ${JSON.stringify(r)}`);
      assert.equal(r.finStatus, 200);
    }
  } finally {
    rmSync(subTmp, { recursive: true, force: true });
  }
});

test('R4-DATA-10 (BURST1-07): move/merge updates colliding single task label (not on GET preview) and bounds freeName to <=200 UTF-8 bytes', async () => {
  const n200 = '中'.repeat(66) + 'ab'; // 198 + 2 = 200 bytes
  const emoji200 = '😀'.repeat(50); // 50 * 4 = 200 bytes

  for (const kind of ['move', 'merge'] as const) {
    const wsSrc = await (await call('POST', '/api/workspaces', JSON.stringify({ name: `names-src-${kind}` }))).json();
    const wsDst = await (await call('POST', '/api/workspaces', JSON.stringify({ name: `names-dst-${kind}` }))).json();

    const srcTask = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsSrc.id, single: true }))).json();
    const dstTask = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsDst.id, single: true }))).json();
    const srcLong = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsSrc.id, name: n200 }))).json();
    await call('POST', '/api/series', JSON.stringify({ workspace: wsDst.id, name: n200 }));
    if (kind === 'merge') {
      const srcEmojiTask = await (await call('POST', '/api/series', JSON.stringify({ workspace: wsSrc.id, single: true }))).json();
      assert.equal((await call('POST', `/api/instances/${srcEmojiTask.instance}/rename?as=${encodeURIComponent(emoji200)}`)).status, 200);
      await call('POST', '/api/series', JSON.stringify({ workspace: wsDst.id, name: emoji200 }));
    }

    assert.equal((await call('PUT', `/api/proposals/${wsSrc.id}`, JSON.stringify({ kind, ...(kind === 'move' && { series: srcTask.id }), to: wsDst.id }))).status, 200);

    // GET preview must NOT mutate source task's instance.json label
    const preview = await json(`/api/proposals/${wsSrc.id}`);
    assert.ok(preview.series.some((s: any) => s.id === srcTask.id && s.to.endsWith('/Untitled 2')));
    assert.equal(JSON.parse(readFileSync(join(root, 'instances', srcTask.instance, 'instance.json'), 'utf8')).label, 'Untitled', 'GET preview must not mutate instance label');

    assert.equal((await call('POST', `/api/proposals/${wsSrc.id}`, JSON.stringify({ owners: [], members: [] }))).status, 200);

    if (kind === 'move') {
      assert.equal((await call('PUT', `/api/proposals/${wsSrc.id}`, JSON.stringify({ kind: 'move', series: srcLong.id, to: wsDst.id }))).status, 200);
      assert.equal((await call('POST', `/api/proposals/${wsSrc.id}`, JSON.stringify({ owners: [], members: [] }))).status, 200);
    }

    const dst = (await json('/api')).find((w: any) => w.id === wsDst.id);
    const movedTask = dst.series.find((s: any) => s.id === srcTask.id);
    const diskLabel = JSON.parse(readFileSync(join(root, 'instances', srcTask.instance, 'instance.json'), 'utf8')).label;
    assert.equal(movedTask.name, 'Untitled 2');
    assert.equal(movedTask.instances[0].label, 'Untitled 2');
    assert.equal(diskLabel, 'Untitled 2');
    assert.equal(JSON.parse(readFileSync(join(root, 'instances', dstTask.instance, 'instance.json'), 'utf8')).label, 'Untitled');

    const seenNames = new Set<string>();
    for (const s of dst.series) {
      assert.ok(Buffer.byteLength(s.name) <= 200, `series name ${s.name} exceeded 200 bytes (${Buffer.byteLength(s.name)})`);
      assert.equal( s.name.includes('\uFFFD'), false, 'must not split multi-byte UTF-8');
      assert.equal( seenNames.has(s.name), false, `duplicate series name ${s.name}`);
      seenNames.add(s.name);
      if (s.single) assert.equal(s.instances[0].label, s.name, 'single task label must match series.name');
    }
  }
});
