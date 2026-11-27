import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInstance, openStore } from '../src/store.ts';
import { startMessageStore } from '../src/message-store.ts';
import { initSystem, readJson, saveTree, tree, writeJson } from '../src/system.ts';
import { authority, logins, personDir, saveLogin, secret } from '../src/logins.ts';

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
async function waitWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const TEST_OPTS = { timeout: 15_000 };
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
const openSessions = new Set<string>();
const openedStates: unknown[] = [];
const closedIds: string[] = [];
const pagesVisited: string[] = [];

const service = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/sessions') {
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([...openSessions].map(id => ({ id }))));
  }
  if (req.method === 'POST' && req.url === '/sessions') {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    openedStates.push(body.state);
    openSeen?.resolve();
    await openGate?.promise;
    const id = `s${++seq}`;
    openSessions.add(id);
    return void res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    const id = req.url.split('/')[2];
    openSessions.delete(id);
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

const { Browsers, keepAlive, reap, removeHost, upgradeBrowser } = await import('../src/browsers.ts');

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
  openSessions.clear();
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

afterEach(async () => {
  releaseGates();
  const runs = activeRuns.splice(0);
  await Promise.all(runs.map(r => r.end().catch(() => {})));
  await Promise.all(runs.map(r => r.close().catch(() => {})));
  rmSync(root, { recursive: true, force: true });
});

after(() => new Promise<void>(ok => service.close(() => ok())));

test('idle writeback browser hands off immediately when another run arrives', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('run-a'), 1));
  const runB = track(new Browsers(running('run-b'), 1));

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

test('active writeback browser is not cut when Run B arrives, but hands off immediately once Run A disconnects', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('active-a'), 1));
  const runB = track(new Browsers(running('waiting-b'), 1));

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
  const idB = await waitWithTimeout(waitingB, 5_000, 'Run B handoff');
  const elapsed = Date.now() - t0;

  assert.ok(idA && idB && idA !== idB);
  assert.ok(elapsed < FAST_BOUND_MS, `expected immediate handoff after disconnect, took ${elapsed}ms`);
  assert.equal(runA.bySite.size, 0);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a')]);
});

test('zero waiters preserves the full IDLE_MS warm cache', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('warm-a'), 1));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  closeSeen = Promise.withResolvers<void>();
  const t0 = Date.now();
  connA.destroy();

  await sleep(300);
  assert.equal(runA.bySite.size, 1, 'browser remains warm well past immediate-handoff latency');
  assert.equal(closedIds.length, 0);

  await waitWithTimeout(closeSeen.promise, IDLE_MS + 3_000, 'idle close');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= IDLE_MS - 150, `expected browser to wait IDLE_MS (${IDLE_MS}ms), closed in ${elapsed}ms`);
  await sleep(30);
  assert.equal(runA.bySite.size, 0, 'browser closes after IDLE_MS elapses');
  assert.equal(closedIds.length, 1);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), cookieState('from-a'));
});

test('waiter disconnecting while holder is active decrements waiters so holder keeps its IDLE_MS warm cache', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('keep-warm-a'), 1));
  const runB = track(new Browsers(running('cancel-b'), 1));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  const connB = new PassThrough();
  const waitingB = runB.browser('crm', connB);
  await sleep(30);
  connB.destroy();
  assert.equal(await waitWithTimeout(waitingB, 5_000, 'cancelled waiter'), undefined, 'cancelled waiter returns undefined');

  connA.destroy();
  await sleep(350);
  assert.equal(runA.bySite.size, 1, 'Run A keeps its IDLE_MS warm cache after waiter cancelled');
  assert.equal(closedIds.length, 0);
});

test('repeated abandoned waits leave endListeners and holder onRelease empty while both runs remain alive', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('listeners-a'), 1));
  const runB = track(new Browsers(running('listeners-b'), 1));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  const holderHold = (runA as unknown as { holds: Map<string, { onRelease: Set<() => void>; waiters: number }> }).holds.get('crm')!;
  assert.ok(holderHold);

  for (let i = 0; i < 10; i++) {
    const connB = new PassThrough();
    const p = runB.browser('crm', connB);
    await sleep(5);
    assert.equal(holderHold.onRelease.size, 1, `attempt ${i}: waiter registered on holder onRelease`);
    connB.destroy();
    assert.equal(await waitWithTimeout(p, 5_000, `abandoned wait ${i}`), undefined);
    assert.equal((runB as unknown as { endListeners: Set<() => void> }).endListeners.size, 0, `attempt ${i}: endListeners cleaned up`);
    assert.equal(holderHold.onRelease.size, 0, `attempt ${i}: holder onRelease cleaned up`);
    assert.equal(holderHold.waiters, 0, `attempt ${i}: waiters back to 0`);
  }
  assert.equal(runA.bySite.size, 1, 'holder remains connected and alive');
});

test('ending a waiting run wakes its wait immediately, responds 409 on open upgrade socket, and lets active holder stay warm', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('warm-after-end-a'), 1));
  const runB = track(new Browsers(running('ended-waiter-b'), 1));

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

  const t0 = Date.now();
  await runB.end();
  await waitWithTimeout(upgradingB, 5_000, 'upgradeBrowser wake on end()');
  assert.ok(Date.now() - t0 < FAST_BOUND_MS, 'ended waiting run woke immediately');
  assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 409 Conflict\r\n[^]*\r\n\r\nrun stopped\n$/);
  assert.equal((runB as unknown as { endListeners: Set<() => void> }).endListeners.size, 0);

  connA.destroy();
  await sleep(350);
  assert.equal(runA.bySite.size, 1, 'Run A stayed warm because ended Run B decremented waiters');
  assert.equal(closedIds.length, 0);
});

test('cut() suppresses idle closes and waiter nudges so browser stays open for reap()', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('cut-a'), 1));
  const runB = track(new Browsers(running('cut-waiter-b'), 1));
  const runC = track(new Browsers(running('cut-waiter-c'), 1));

  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  const connB = new PassThrough();
  const waitingB = runB.browser('crm', connB);
  await sleep(30);

  runA.cut();
  await sleep(150);
  assert.equal(closedIds.length, 0, 'cut() must not fire a zero-delay DELETE while shutting down');
  assert.equal(runA.bySite.size, 1, 'browser remains recorded for reap()');

  const connC = new PassThrough();
  const waitingC = runC.browser('crm', connC);
  await sleep(100);
  assert.equal(closedIds.length, 0, 'nudge() after cut() must not trigger DELETE');

  connB.destroy();
  connC.destroy();
  assert.equal(await waitWithTimeout(waitingB, 5_000, 'waitingB cancel'), undefined);
  assert.equal(await waitWithTimeout(waitingC, 5_000, 'waitingC cancel'), undefined);
});

test('cut() during opening journals the session without sending DELETE until reap() recovers it', TEST_OPTS, async () => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();

  const runA = track(new Browsers(running('cut-opening-a'), 1));
  const pA = runA.browser('crm');
  await waitWithTimeout(openSeen.promise, 5_000, 'POST /sessions');

  // Cut the run BEFORE POST /sessions resolves.
  runA.cut();
  const gate = openGate;
  openGate = undefined;
  gate.resolve();

  assert.equal(await waitWithTimeout(pA, 5_000, 'cut opening continuation'), undefined);
  await sleep(80);
  assert.equal(closedIds.length, 0, 'cut() during opening must not send DELETE before reap()');
  const journaled = Object.keys(readJson<Record<string, unknown>>('browsers.json', {}));
  assert.equal(journaled.length, 1, 'opened session was still journaled for reap()');

  // Startup reap() closes the journaled session and writes back its state.
  backState = cookieState('reaped-after-cut');
  const { closed } = await reap();
  await waitWithTimeout(closed, 5_000, 'reap() close');
  assert.deepEqual(closedIds, journaled, 'reap() closed the journaled session');
  assert.deepEqual(Object.keys(readJson<Record<string, unknown>>('browsers.json', {})), []);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), cookieState('reaped-after-cut'));
  // Remove already-reaped session from runA.bySite so afterEach does not send a second DELETE.
  runA.bySite.clear();
});

test('concurrent waiters nudging an idle holder trigger only one close and serialize cleanly', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('multi-a'), 1));
  const runB = track(new Browsers(running('multi-b'), 1));
  const runC = track(new Browsers(running('multi-c'), 1));

  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(20);

  closeGate = Promise.withResolvers<void>();
  closeSeen = Promise.withResolvers<void>();

  const pB = runB.browser('crm', new PassThrough());
  const pC = runC.browser('crm', new PassThrough());
  await waitWithTimeout(closeSeen.promise, 5_000, 'Run A DELETE');
  await sleep(30);
  assert.deepEqual(closedIds, [idA], 'only one DELETE sent for Run A despite concurrent nudges');

  const gate = closeGate;
  closeGate = undefined;
  gate.resolve();

  const first = await waitWithTimeout(Promise.race([
    pB.then(id => ({ winner: 'B' as const, id, run: runB, other: pC, otherRun: runC })),
    pC.then(id => ({ winner: 'C' as const, id, run: runC, other: pB, otherRun: runB })),
  ]), 5_000, 'first waiter open');
  assert.ok(first.id);
  const connFirst = new PassThrough();
  first.run.connected('crm', connFirst);
  backState = cookieState('from-first');
  const t0 = Date.now();
  connFirst.destroy();
  const secondId = await waitWithTimeout(first.other, 5_000, 'second waiter handoff');
  const elapsed = Date.now() - t0;

  assert.ok(secondId && secondId !== first.id);
  assert.ok(elapsed < FAST_BOUND_MS, `second waiter received immediate handoff in ${elapsed}ms`);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a'), cookieState('from-first')]);
});

test('waiter arriving while holder is still opening does not cut holder before connect, then gets immediate handoff', TEST_OPTS, async () => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();

  const runA = track(new Browsers(running('opening-a'), 1));
  const runB = track(new Browsers(running('opening-b'), 1));

  const pA = runA.browser('crm');
  await waitWithTimeout(openSeen.promise, 5_000, 'Run A POST');

  let bOpened = false;
  const pB = runB.browser('crm').then(id => { bOpened = true; return id; });
  await sleep(30);

  const gate = openGate;
  openGate = undefined;
  gate.resolve();

  const idA = await waitWithTimeout(pA, 5_000, 'Run A open');
  assert.ok(idA);
  const connA = new PassThrough();
  runA.connected('crm', connA);
  await sleep(100);
  assert.equal(bOpened, false, 'Run A is not cut while opening or connected');
  assert.equal(runA.bySite.size, 1);

  const t0 = Date.now();
  connA.destroy();
  const idB = await waitWithTimeout(pB, 5_000, 'Run B handoff');
  const elapsed = Date.now() - t0;
  assert.ok(idB && idB !== idA);
  assert.ok(elapsed < FAST_BOUND_MS, `immediate handoff once opening holder finishes, took ${elapsed}ms`);
});

test('opening continuation completing while a driver is attached does not evict the live driver even if original upgrade was abandoned', TEST_OPTS, async () => {
  const runA = track(new Browsers(running('driver-a'), 1));
  const runB = track(new Browsers(running('driver-waiter-b'), 1));
  const lentGate = Promise.withResolvers<void>();
  const lentGateSeen = Promise.withResolvers<void>();
  extraReleases.push(() => lentGate.resolve());

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
  await waitWithTimeout(lentGateSeen.promise, 5_000, 'post-open lent() gate');

  const driverConn = new PassThrough();
  runA.drive('crm', alice, driverConn);
  sockA.destroy();
  let bOpened = false;
  const pB = runB.browser('crm').then(id => { bOpened = true; return id; });
  await sleep(30);

  lentGate.resolve();
  await waitWithTimeout(upgrading, 5_000, 'upgradeBrowser finish');
  await sleep(150);
  assert.equal(runA.bySite.size, 1, 'live driver must not be evicted by opening continuation or abandoned upgrade');
  assert.equal(closedIds.length, 0);
  assert.equal(bOpened, false, 'Run B still waits while driver is connected');

  const t0 = Date.now();
  driverConn.destroy();
  const idB = await waitWithTimeout(pB, 5_000, 'Run B handoff after driver disconnect');
  assert.ok(idB);
  assert.ok(Date.now() - t0 < FAST_BOUND_MS, 'immediate handoff once driver disconnects');
});

test('upgradeBrowser socket destroyed during open hands off immediately to waiting run', TEST_OPTS, async () => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();

  const runA = track(new Browsers(running('abandoned-a'), 1));
  const runB = track(new Browsers(running('abandoned-b'), 1));

  const sockA = new PassThrough();
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  const upgrading = upgradeBrowser(runA, 'crm', req, sockA, Buffer.alloc(0));
  await waitWithTimeout(openSeen.promise, 5_000, 'POST /sessions');

  sockA.destroy();
  const pB = runB.browser('crm');
  await sleep(20);

  const t0 = Date.now();
  const gate = openGate;
  openGate = undefined;
  gate.resolve();
  await waitWithTimeout(upgrading, 5_000, 'abandoned upgrade');

  const idB = await waitWithTimeout(pB, 5_000, 'Run B handoff');
  const elapsed = Date.now() - t0;
  assert.ok(idB);
  assert.ok(elapsed < FAST_BOUND_MS, `abandoned open handed off in ${elapsed}ms`);
  assert.equal(runA.bySite.size, 0);
});

test('abandoned print browser upgrade closes immediately without leaking a session', TEST_OPTS, async () => {
  openGate = Promise.withResolvers<void>();
  openSeen = Promise.withResolvers<void>();
  closeSeen = Promise.withResolvers<void>();

  const runA = track(new Browsers(running('abandoned-print', []), 1));

  const sock = new PassThrough();
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  const upgrading = upgradeBrowser(runA, 'print', req, sock, Buffer.alloc(0));
  await waitWithTimeout(openSeen.promise, 5_000, 'print POST /sessions');

  sock.destroy();
  const t0 = Date.now();
  const gate = openGate;
  openGate = undefined;
  gate.resolve();
  await waitWithTimeout(upgrading, 5_000, 'abandoned print upgrade');
  await waitWithTimeout(closeSeen.promise, 5_000, 'abandoned print DELETE');

  assert.ok(Date.now() - t0 < FAST_BOUND_MS, 'abandoned print browser closed immediately');
  assert.equal(closedIds.length, 1);
  await sleep(20);
  assert.equal(runA.bySite.size, 0);
});

test('writeback: false runs open concurrently without waiting, nudging, or writing state back', TEST_OPTS, async () => {
  setWebsite({ writeback: false });
  const runA = track(new Browsers(running('nowb-a'), 1));
  const runB = track(new Browsers(running('nowb-b'), 1));

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

test('keepAlive nudges an idle run browser for immediate handoff, skips active runs, and ignores non-keepalive logins', TEST_OPTS, async () => {
  const future = new Date(keepAliveClock + 86_400_000).toISOString();
  setWebsite({ keepalive: '/app', every: 5 });

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

test('keepAlive re-checks fresh expiry after handoff wait and skips POST if authorization expired during close', TEST_OPTS, async t => {
  setWebsite({ keepalive: '/app', every: 5 });
  keepAliveClock += 10 * 60_000;
  let fakeNow = keepAliveClock;
  t.mock.method(Date, 'now', () => fakeNow);

  setLogin('expiring-soon', new Date(fakeNow + 5_000).toISOString());

  const runA = track(new Browsers(running('ka-exp-a'), 1));
  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(20);

  closeGate = Promise.withResolvers<void>();
  closeSeen = Promise.withResolvers<void>();
  openedStates.length = 0;

  const keeping = keepAlive(new Date(fakeNow));
  await waitWithTimeout(closeSeen.promise, 5_000, 'keepAlive handoff DELETE');

  fakeNow += 10_000;
  const gate = closeGate;
  closeGate = undefined;
  gate.resolve();
  await waitWithTimeout(keeping, 5_000, 'keepAlive completion');

  assert.equal(openedStates.length, 0, 'keepAlive must not POST /sessions after keepalive expired during handoff');
  assert.equal(pagesVisited.length, 0);
  assert.equal(runA.bySite.size, 0, 'idle holder still finished its close cleanly');
});

test('removeHost invalidates open run browsers and destroys active CDP connections via closeUnlent', TEST_OPTS, async () => {
  setWebsite({ hosts: ['extra.crm.example.com'], checks: { 'extra.crm.example.com': { verdict: 'pass', why: 'Allowed.' } } });
  const run = track(new Browsers(running('remove-host'), 1));
  const id = await run.browser('crm');
  assert.ok(id);
  const conn = new PassThrough();
  run.connected('crm', conn);

  await removeHost(alice, 'crm', 'extra.crm.example.com');
  await run.closeUnlent();

  assert.equal(conn.destroyed, true, 'active CDP connection is cut when an allowed host is removed');
  assert.equal(run.bySite.size, 0, 'open run browser session is closed when allowed hosts shrink');
  assert.ok(closedIds.includes(id), 'browser service session was closed');
});
