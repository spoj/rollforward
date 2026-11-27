import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInstance, openStore } from '../src/store.ts';
import { startMessageStore } from '../src/message-store.ts';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { authority, logins, personDir, saveLogin, secret } from '../src/logins.ts';

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
const alice = 'alice@demo.test';
const cookieState = (value: string) => ({
  cookies: [{ name: 'sid', value, domain: 'crm.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [],
});

let seq = 0;
let backState: unknown = cookieState('initial');
let openGate: PromiseWithResolvers<void> | undefined;
let closeGate: PromiseWithResolvers<void> | undefined;
let openSeen: PromiseWithResolvers<void> | undefined;
let closeSeen: PromiseWithResolvers<void> | undefined;
const openedStates: unknown[] = [];
const closedIds: string[] = [];
const pagesVisited: string[] = [];

const service = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/sessions') {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    openedStates.push(body.state);
    openSeen?.resolve();
    await openGate?.promise;
    const id = `s${++seq}`;
    return void res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    const id = req.url.split('/')[2];
    closedIds.push(id);
    closeSeen?.resolve();
    await closeGate?.promise;
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: backState, log: [] }));
  }
  if (req.method === 'GET' && req.url?.endsWith('/page')) {
    const id = req.url.split('/')[2];
    pagesVisited.push(id);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url: 'https://crm.example.com/app', password: false }));
  }
  res.writeHead(404).end('{}');
}).on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n'));

await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const IDLE_MS = 2000;
const FAST_BOUND_MS = IDLE_MS / 2;
Object.assign(process.env, {
  RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`,
  RF_BROWSER_KEY: 'handoff-test',
  RF_BROWSER_IDLE_MS: String(IDLE_MS),
});

const { Browsers, keepAlive, upgradeBrowser } = await import('../src/browsers.ts');

let root = '';
let runCounter = 0;
let keepAliveClock = new Date(2027, 5, 1, 9, 0).getTime();
const activeRuns: InstanceType<typeof Browsers>[] = [];
const extraReleases: (() => void)[] = [];

function track<T extends InstanceType<typeof Browsers>>(b: T): T {
  activeRuns.push(b);
  return b;
}

function running(label: string, loginIds = ['web:crm']) {
  const seriesId = `s-${++runCounter}-${label}`;
  saveTree({ ...tree(), series: { ...tree().series, [seriesId]: { name: 'Handoff', workspace: 'w' } } });
  const dir = join(root, 'series', seriesId);
  startMessageStore(dir);
  const inst = createInstance(seriesId, label, alice);
  writeFileSync(join(dir, 'series.json'), JSON.stringify({
    version: 1,
    owner: alice,
    epoch: 1,
    since: '',
    consent: { by: alice, at: '', workspace: 'w', logins: loginIds, autonomous: false },
  }));
  inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: authority(inst) });
  return inst;
}

function setWebsite(extra: Record<string, unknown> = {}) {
  mkdirSync(personDir(alice), { recursive: true });
  writeFileSync(join(personDir(alice), 'websites.json'), JSON.stringify({
    crm: { url: 'https://crm.example.com/app', hosts: [], writeback: true, added: '2026-01-01T00:00:00.000Z', ...extra },
  }));
}

function setLogin(value: string, keepalive?: string) {
  saveLogin(
    alice,
    { id: 'web:crm', kind: 'website', name: 'CRM', since: '2027-01-01T00:00:00.000Z', offers: [{ id: 'web:crm', name: 'CRM' }], ...(keepalive && { keepalive }) },
    JSON.stringify(cookieState(value)),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rf-browser-handoff-'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: {} });
  writeJson('users.json', { [alice]: { role: 'admin' } });
  writeJson('capabilities.json', { keepalive: [alice] });
  writeJson('grants.json', { g1: { workspace: 'w', person: alice, site: 'crm', reason: 'test', at: '', state: 'approved' } });
  setWebsite();
  setLogin('seed');
  seq = 0;
  backState = cookieState('from-a');
  openGate = undefined;
  closeGate = undefined;
  openSeen = undefined;
  closeSeen = undefined;
  openedStates.length = 0;
  closedIds.length = 0;
  pagesVisited.length = 0;
});

function releaseGates() {
  openGate?.resolve();
  closeGate?.resolve();
  for (const fn of extraReleases.splice(0)) fn();
  openGate = undefined;
  closeGate = undefined;
  openSeen = undefined;
  closeSeen = undefined;
}

const cleanup = (...runs: InstanceType<typeof Browsers>[]) => {
  activeRuns.push(...runs);
  return () => {};
};

afterEach(async () => {
  releaseGates();
  const runs = activeRuns.splice(0);
  await Promise.all(runs.map(r => r.end().catch(() => {})));
  await Promise.all(runs.map(r => r.close().catch(() => {})));
  rmSync(root, { recursive: true, force: true });
});

after(() => new Promise<void>(ok => service.close(() => ok())));

test('idle writeback browser hands off immediately when another run arrives', async t => {
  const runA = new Browsers(running('run-a'), 1);
  const runB = new Browsers(running('run-b'), 1);
  t.after(cleanup(runA, runB));

  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(30);
  assert.equal(runA.bySite.size, 1, 'Run A stays warm while no one waits');

  const t0 = Date.now();
  const idB = await runB.browser('crm');
  const elapsed = Date.now() - t0;

  assert.ok(idA && idB && idA !== idB);
  assert.ok(elapsed < FAST_BOUND_MS, `expected immediate handoff, took ${elapsed}ms (IDLE_MS=${IDLE_MS})`);
  assert.equal(runA.bySite.size, 0, 'Run A closed and released');
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a')], 'Run B opens from Run A writeback');
  assert.deepEqual(closedIds, [idA]);
});

test('active writeback browser is not cut when Run B arrives, but hands off immediately once Run A disconnects', async t => {
  const runA = new Browsers(running('active-a'), 1);
  const runB = new Browsers(running('waiting-b'), 1);
  t.after(cleanup(runA, runB));

  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  let bOpened = false;
  const connB = new PassThrough();
  const waitingB = runB.browser('crm', connB).then(id => { bOpened = true; return id; });

  await sleep(150);
  assert.equal(bOpened, false, 'Run B waits while Run A has an open connection');
  assert.equal(runA.bySite.size, 1, 'Run A is not interrupted while active');
  assert.equal(closedIds.length, 0);

  const t0 = Date.now();
  connA.destroy();
  const idB = await waitingB;
  const elapsed = Date.now() - t0;

  assert.ok(idA && idB && idA !== idB);
  assert.ok(elapsed < FAST_BOUND_MS, `expected immediate handoff after disconnect, took ${elapsed}ms`);
  assert.equal(runA.bySite.size, 0);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a')]);
});

test('zero waiters preserves the full IDLE_MS warm cache', async t => {
  const runA = new Browsers(running('warm-a'), 1);
  t.after(cleanup(runA));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  closeSeen = Promise.withResolvers<void>();
  const t0 = Date.now();
  connA.destroy();

  await sleep(300);
  assert.equal(runA.bySite.size, 1, 'browser remains warm well past immediate-handoff latency');
  assert.equal(closedIds.length, 0);

  await closeSeen.promise;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= IDLE_MS - 150, `expected browser to wait IDLE_MS (${IDLE_MS}ms), closed in ${elapsed}ms`);
  await sleep(30);
  assert.equal(runA.bySite.size, 0, 'browser closes after IDLE_MS elapses');
  assert.equal(closedIds.length, 1);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), cookieState('from-a'));
});

test('waiter disconnecting while holder is active decrements waiters so holder keeps its IDLE_MS warm cache', async t => {
  const runA = new Browsers(running('keep-warm-a'), 1);
  const runB = new Browsers(running('cancel-b'), 1);
  t.after(cleanup(runA, runB));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  const connB = new PassThrough();
  const waitingB = runB.browser('crm', connB);
  await sleep(30);
  connB.destroy();
  assert.equal(await waitingB, undefined, 'cancelled waiter returns undefined');

  connA.destroy();
  await sleep(350);
  assert.equal(runA.bySite.size, 1, 'Run A keeps its IDLE_MS warm cache after waiter cancelled');
  assert.equal(closedIds.length, 0);
});

test('ending a waiting run wakes its wait immediately, responds 409 on open upgrade socket, and lets active holder stay warm', async t => {
  const runA = new Browsers(running('warm-after-end-a'), 1);
  const runB = new Browsers(running('ended-waiter-b'), 1);
  t.after(cleanup(runA, runB));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  const sockB = new PassThrough();
  const chunks: Buffer[] = [];
  sockB.on('data', c => chunks.push(c));
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  let upgradeDone = false;
  const upgradingB = upgradeBrowser(runB, 'crm', req, sockB, Buffer.alloc(0)).then(() => { upgradeDone = true; });

  await sleep(40);
  assert.equal(upgradeDone, false, 'Run B upgrade is waiting on Run A');

  // Ending Run B must wake upgradeBrowser immediately even while Run A stays connected.
  const t0 = Date.now();
  await runB.end();
  await upgradingB;
  assert.ok(Date.now() - t0 < FAST_BOUND_MS, 'ended waiting run woke immediately');
  assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 409 Conflict\r\n[^]*\r\n\r\nrun stopped\n$/);

  // Now Run A disconnects with zero remaining waiters -> must keep its IDLE_MS warm cache.
  connA.destroy();
  await sleep(350);
  assert.equal(runA.bySite.size, 1, 'Run A stayed warm because ended Run B decremented waiters');
  assert.equal(closedIds.length, 0);
});

test('cut() suppresses idle closes and waiter nudges so browser stays open for reap()', async t => {
  const runA = track(new Browsers(running('cut-a'), 1));
  const runB = track(new Browsers(running('cut-waiter-b'), 1));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  const connB = new PassThrough();
  const waitingB = runB.browser('crm', connB);
  await sleep(30);

  // Simulate SIGTERM cut() on active holder with a queued waiter.
  runA.cut();
  await sleep(150);
  assert.equal(closedIds.length, 0, 'cut() must not fire a zero-delay DELETE while shutting down');
  assert.equal(runA.bySite.size, 1, 'browser remains recorded for reap()');

  // Even a new waiter arriving after cut() must not trigger a DELETE.
  const runC = new Browsers(running('cut-waiter-c'), 1);
  const connC = new PassThrough();
  const waitingC = runC.browser('crm', connC);
  await sleep(100);
  assert.equal(closedIds.length, 0, 'nudge() after cut() must not trigger DELETE');

  connB.destroy();
  connC.destroy();
  assert.equal(await waitingB, undefined);
  assert.equal(await waitingC, undefined);
  await runC.end();
});

test('concurrent waiters nudging an idle holder trigger only one close and serialize cleanly', async t => {
  const runA = new Browsers(running('multi-a'), 1);
  const runB = new Browsers(running('multi-b'), 1);
  const runC = new Browsers(running('multi-c'), 1);
  t.after(cleanup(runA, runB, runC));

  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(20);

  closeGate = Promise.withResolvers<void>();
  closeSeen = Promise.withResolvers<void>();

  const pB = runB.browser('crm', new PassThrough());
  const pC = runC.browser('crm', new PassThrough());
  await closeSeen.promise;
  await sleep(30);
  assert.deepEqual(closedIds, [idA], 'only one DELETE sent for Run A despite concurrent nudges');

  const gate = closeGate;
  closeGate = undefined;
  gate.resolve();

  const first = await Promise.race([
    pB.then(id => ({ winner: 'B' as const, id, run: runB, other: pC, otherRun: runC })),
    pC.then(id => ({ winner: 'C' as const, id, run: runC, other: pB, otherRun: runB })),
  ]);
  assert.ok(first.id);
  const connFirst = new PassThrough();
  first.run.connected('crm', connFirst);
  backState = cookieState('from-first');
  const t0 = Date.now();
  connFirst.destroy();
  const secondId = await first.other;
  const elapsed = Date.now() - t0;

  assert.ok(secondId && secondId !== first.id);
  assert.ok(elapsed < FAST_BOUND_MS, `second waiter received immediate handoff in ${elapsed}ms`);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a'), cookieState('from-first')]);
});

test('waiter arriving while holder is still opening does not cut holder before connect, then gets immediate handoff', async t => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();

  const runA = new Browsers(running('opening-a'), 1);
  const runB = new Browsers(running('opening-b'), 1);
  t.after(cleanup(runA, runB));

  const pA = runA.browser('crm');
  await openSeen.promise;

  let bOpened = false;
  const pB = runB.browser('crm').then(id => { bOpened = true; return id; });
  await sleep(30);

  const gate = openGate;
  openGate = undefined;
  gate.resolve();

  const idA = await pA;
  assert.ok(idA);
  const connA = new PassThrough();
  runA.connected('crm', connA);
  await sleep(100);
  assert.equal(bOpened, false, 'Run A is not cut while opening or connected');
  assert.equal(runA.bySite.size, 1);

  const t0 = Date.now();
  connA.destroy();
  const idB = await pB;
  const elapsed = Date.now() - t0;
  assert.ok(idB && idB !== idA);
  assert.ok(elapsed < FAST_BOUND_MS, `immediate handoff once opening holder finishes, took ${elapsed}ms`);
});

test('opening continuation completing while a driver is attached does not evict the live driver even if original upgrade was abandoned', async t => {
  const runA = track(new Browsers(running('driver-a'), 1));
  const runB = track(new Browsers(running('driver-waiter-b'), 1));
  const lentGate = Promise.withResolvers<void>();
  const lentGateSeen = Promise.withResolvers<void>();
  extraReleases.push(() => lentGate.resolve());

  // Gate the second lent() call (the post-open revalidation inside ready after bySite.set).
  const origLent = runA.lent.bind(runA);
  let lentCalls = 0;
  runA.lent = async (site: string, quiet?: boolean) => {
    if (++lentCalls === 2) {
      lentGateSeen.resolve();
      await lentGate.promise;
    }
    return origLent(site, quiet);
  };

  const sockA = new PassThrough();
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  const upgrading = upgradeBrowser(runA, 'crm', req, sockA, Buffer.alloc(0));
  await lentGateSeen.promise;

  // Browser is in bySite while final route validation is suspended: attach a live driver, abandon original upgrade, and queue Run B.
  const driverConn = new PassThrough();
  runA.drive('crm', alice, driverConn);
  sockA.destroy();
  let bOpened = false;
  const pB = runB.browser('crm').then(id => { bOpened = true; return id; });
  await sleep(30);

  // Release final route validation: ready() calls idle() and upgradeBrowser calls abandoned(). Neither may evict the live driver.
  lentGate.resolve();
  await upgrading;
  await sleep(150);
  assert.equal(runA.bySite.size, 1, 'live driver must not be evicted by opening continuation or abandoned upgrade');
  assert.equal(closedIds.length, 0);
  assert.equal(bOpened, false, 'Run B still waits while driver is connected');

  // Once the driver disconnects, Run B gets immediate handoff.
  const t0 = Date.now();
  driverConn.destroy();
  const idB = await pB;
  assert.ok(idB);
  assert.ok(Date.now() - t0 < FAST_BOUND_MS, 'immediate handoff once driver disconnects');
});

test('upgradeBrowser socket destroyed during open hands off immediately to waiting run', async t => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();

  const runA = new Browsers(running('abandoned-a'), 1);
  const runB = new Browsers(running('abandoned-b'), 1);
  t.after(cleanup(runA, runB));

  const sockA = new PassThrough();
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  const upgrading = upgradeBrowser(runA, 'crm', req, sockA, Buffer.alloc(0));
  await openSeen.promise;

  sockA.destroy();
  const pB = runB.browser('crm');
  await sleep(20);

  const t0 = Date.now();
  const gate = openGate;
  openGate = undefined;
  gate.resolve();
  await upgrading;

  const idB = await pB;
  const elapsed = Date.now() - t0;
  assert.ok(idB);
  assert.ok(elapsed < FAST_BOUND_MS, `abandoned open handed off in ${elapsed}ms`);
  assert.equal(runA.bySite.size, 0);
});

test('abandoned print browser upgrade closes immediately without leaking a session', async t => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();
  closeSeen = Promise.withResolvers<void>();

  const runA = new Browsers(running('abandoned-print', []), 1);
  t.after(cleanup(runA));

  const sock = new PassThrough();
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  const upgrading = upgradeBrowser(runA, 'print', req, sock, Buffer.alloc(0));
  await openSeen.promise;

  sock.destroy();
  const t0 = Date.now();
  const gate = openGate;
  openGate = undefined;
  gate.resolve();
  await upgrading;
  await closeSeen.promise;

  assert.ok(Date.now() - t0 < FAST_BOUND_MS, 'abandoned print browser closed immediately');
  assert.equal(closedIds.length, 1);
  await sleep(20);
  assert.equal(runA.bySite.size, 0);
});

test('writeback: false runs open concurrently without waiting, nudging, or writing state back', async t => {
  setWebsite({ writeback: false });
  const runA = new Browsers(running('nowb-a'), 1);
  const runB = new Browsers(running('nowb-b'), 1);
  t.after(cleanup(runA, runB));

  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(20);

  const t0 = Date.now();
  const idB = await runB.browser('crm');
  assert.ok(idA && idB && idA !== idB);
  assert.ok(Date.now() - t0 < FAST_BOUND_MS);
  assert.equal(runA.bySite.size, 1, 'Run B did not nudge writeback:false Run A');
  assert.equal(closedIds.length, 0);

  backState = cookieState('never-written');
  await Promise.all([runA.close(), runB.close()]);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('seed')]);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), cookieState('seed'));
});

test('keepAlive nudges an idle run browser for immediate handoff, skips active runs, and ignores non-keepalive logins', async t => {
  const future = new Date(keepAliveClock + 86_400_000).toISOString();
  setWebsite({ keepalive: '/app', every: 5 });

  // 1) Idle run with keepalive disabled on login: keepAlive must NOT evict the warm browser.
  setLogin('no-ka');
  const runIdleNoKa = track(new Browsers(running('ka-no'), 1));
  await runIdleNoKa.browser('crm');
  const c0 = new PassThrough();
  runIdleNoKa.connected('crm', c0);
  c0.destroy();
  await sleep(20);
  keepAliveClock += 10 * 60_000;
  await keepAlive(new Date(keepAliveClock));
  assert.equal(runIdleNoKa.bySite.size, 1, 'keepAlive does not nudge warm browser when login has no keepalive');
  assert.equal(pagesVisited.length, 0);
  await runIdleNoKa.close();

  // 2) Active run with keepalive enabled: keepAlive skips without blocking or interrupting.
  setLogin('active-ka', future);
  const runActive = track(new Browsers(running('ka-active'), 1));
  await runActive.browser('crm');
  const c1 = new PassThrough();
  runActive.connected('crm', c1);
  keepAliveClock += 10 * 60_000;
  const tActive = Date.now();
  await keepAlive(new Date(keepAliveClock));
  assert.ok(Date.now() - tActive < FAST_BOUND_MS, 'keepAlive does not block on an active run');
  assert.equal(runActive.bySite.size, 1, 'active run is not interrupted by keepAlive');
  assert.equal(pagesVisited.length, 0);

  // 3) Run disconnects and sits idle: next keepAlive turn nudges it for immediate handoff and uses fresh writeback state.
  backState = cookieState('from-active-run');
  c1.destroy();
  await sleep(20);
  assert.equal(runActive.bySite.size, 1);

  openedStates.length = 0;
  keepAliveClock += 10 * 60_000;
  const tIdle = Date.now();
  await keepAlive(new Date(keepAliveClock));
  const elapsed = Date.now() - tIdle;

  assert.ok(elapsed < FAST_BOUND_MS, `keepAlive nudged idle run in ${elapsed}ms`);
  assert.equal(runActive.bySite.size, 0, 'idle run closed for keepAlive');
  assert.equal(pagesVisited.length, 1, 'keepAlive ran its page check');
  assert.deepEqual(openedStates, [cookieState('from-active-run')], 'keepAlive opened from the idle run writeback state');
  assert.equal(logins(alice).find(l => l.id === 'web:crm')?.expired, undefined);
});

test('keepAlive re-checks fresh expiry after handoff wait and skips POST if authorization expired during close', async t => {
  setWebsite({ keepalive: '/app', every: 5 });
  keepAliveClock += 10 * 60_000;
  let fakeNow = keepAliveClock;
  const origDateNow = Date.now;
  t.mock.method(Date, 'now', () => fakeNow);

  // Login keepalive expires 5 seconds after sweep start.
  setLogin('expiring-soon', new Date(fakeNow + 5_000).toISOString());

  const runA = new Browsers(running('ka-exp-a'), 1);
  t.after(cleanup(runA));
  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(20);

  closeGate = Promise.withResolvers<void>();
  closeSeen = Promise.withResolvers<void>();
  openedStates.length = 0;

  const keeping = keepAlive(new Date(fakeNow));
  await closeSeen.promise;

  // Advance clock 10 seconds (past keepalive expiry) while idle holder close is in flight.
  fakeNow += 10_000;
  const gate = closeGate;
  closeGate = undefined;
  gate.resolve();
  await keeping;

  assert.equal(openedStates.length, 0, 'keepAlive must not POST /sessions after keepalive expired during handoff');
  assert.equal(pagesVisited.length, 0);
  assert.equal(runA.bySite.size, 0, 'idle holder still finished its close cleanly');
  assert.equal(typeof origDateNow, 'function');
});
