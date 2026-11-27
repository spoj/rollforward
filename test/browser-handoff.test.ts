import { after, beforeEach, test } from 'node:test';
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
let openGate: Promise<void> | undefined;
let closeGate: Promise<void> | undefined;
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
    await openGate;
    const id = `s${++seq}`;
    return void res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    const id = req.url.split('/')[2];
    closedIds.push(id);
    closeSeen?.resolve();
    await closeGate;
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
const IDLE_MS = 1000;
Object.assign(process.env, {
  RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`,
  RF_BROWSER_KEY: 'handoff-test',
  RF_BROWSER_IDLE_MS: String(IDLE_MS),
});

const { Browsers, keepAlive, upgradeBrowser } = await import('../src/browsers.ts');

let root = '';
let runCounter = 0;
let keepAliveClock = new Date(2027, 5, 1, 9, 0).getTime();

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

beforeEach(t => {
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
});

after(() => new Promise<void>(ok => service.close(() => ok())));

test('idle writeback browser hands off immediately when another run arrives', async () => {
  const runA = new Browsers(running('run-a'), 1);
  const runB = new Browsers(running('run-b'), 1);
  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  // Run A is now idle on its IDLE_MS warm-cache timer.
  await sleep(30);
  assert.equal(runA.bySite.size, 1, 'Run A stays warm while no one waits');

  const t0 = Date.now();
  const idB = await runB.browser('crm');
  const elapsed = Date.now() - t0;

  assert.ok(idA && idB && idA !== idB);
  assert.ok(elapsed < IDLE_MS / 2, `expected immediate handoff, took ${elapsed}ms (IDLE_MS=${IDLE_MS})`);
  assert.equal(runA.bySite.size, 0, 'Run A closed and released');
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a')], 'Run B opens from Run A writeback');
  assert.deepEqual(closedIds, [idA]);
  await runB.close();
});

test('active writeback browser is not cut when Run B arrives, but hands off immediately once Run A disconnects', async () => {
  const runA = new Browsers(running('active-a'), 1);
  const runB = new Browsers(running('waiting-b'), 1);
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
  assert.ok(elapsed < IDLE_MS / 2, `expected immediate handoff after disconnect, took ${elapsed}ms`);
  assert.equal(runA.bySite.size, 0);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a')]);
  await runB.close();
});

test('zero waiters preserves the full IDLE_MS warm cache', async () => {
  const runA = new Browsers(running('warm-a'), 1);
  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();

  await sleep(IDLE_MS * 0.4);
  assert.equal(runA.bySite.size, 1, 'browser remains warm before IDLE_MS elapses');
  assert.equal(closedIds.length, 0);

  await sleep(IDLE_MS * 0.85);
  assert.equal(runA.bySite.size, 0, 'browser closes after IDLE_MS elapses');
  assert.equal(closedIds.length, 1);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), cookieState('from-a'));
});

test('waiter disconnecting while holder is active decrements waiters so holder keeps its IDLE_MS warm cache', async () => {
  const runA = new Browsers(running('keep-warm-a'), 1);
  const runB = new Browsers(running('cancel-b'), 1);
  await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);

  const connB = new PassThrough();
  const waitingB = runB.browser('crm', connB);
  await sleep(30);
  connB.destroy();
  assert.equal(await waitingB, undefined, 'cancelled waiter returns undefined');

  connA.destroy();
  await sleep(IDLE_MS * 0.4);
  assert.equal(runA.bySite.size, 1, 'Run A keeps its IDLE_MS warm cache after waiter cancelled');
  assert.equal(closedIds.length, 0);

  await runA.close();
});

test('concurrent waiters nudging an idle holder trigger only one close and serialize cleanly', async () => {
  const runA = new Browsers(running('multi-a'), 1);
  const runB = new Browsers(running('multi-b'), 1);
  const runC = new Browsers(running('multi-c'), 1);

  const idA = await runA.browser('crm');
  const connA = new PassThrough();
  runA.connected('crm', connA);
  connA.destroy();
  await sleep(20);

  const shut = Promise.withResolvers<void>();
  closeGate = shut.promise;
  closeSeen = Promise.withResolvers<void>();

  const pB = runB.browser('crm', new PassThrough());
  const pC = runC.browser('crm', new PassThrough());
  await closeSeen.promise;
  await sleep(20);
  assert.deepEqual(closedIds, [idA], 'only one DELETE sent for Run A despite concurrent nudges');

  closeGate = undefined;
  shut.resolve();

  // Whichever run wins first gets a session; connecting and disconnecting hands off to the second.
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
  assert.ok(elapsed < IDLE_MS / 2, `second waiter received immediate handoff in ${elapsed}ms`);
  assert.deepEqual(openedStates, [cookieState('seed'), cookieState('from-a'), cookieState('from-first')]);
  await first.otherRun.close();
});

test('waiter arriving while holder is still opening does not cut holder before connect, then gets immediate handoff', async () => {
  const gate = Promise.withResolvers<void>();
  openGate = gate.promise;
  openSeen = Promise.withResolvers<void>();

  const runA = new Browsers(running('opening-a'), 1);
  const runB = new Browsers(running('opening-b'), 1);

  const pA = runA.browser('crm');
  await openSeen.promise;

  // Run B arrives while Run A is still in this.opening (not yet in bySite).
  let bOpened = false;
  const pB = runB.browser('crm').then(id => { bOpened = true; return id; });
  await sleep(30);

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
  assert.ok(elapsed < IDLE_MS / 2, `immediate handoff once opening holder finishes, took ${elapsed}ms`);
  await runB.close();
});

test('upgradeBrowser socket destroyed during open hands off immediately to waiting run', async () => {
  const gate = Promise.withResolvers<void>();
  openGate = gate.promise;
  openSeen = Promise.withResolvers<void>();

  const runA = new Browsers(running('abandoned-a'), 1);
  const runB = new Browsers(running('abandoned-b'), 1);

  const sockA = new PassThrough();
  const req = { headers: { host: '127.0.0.1' } } as IncomingMessage;
  const upgrading = upgradeBrowser(runA, 'crm', req, sockA, Buffer.alloc(0));
  await openSeen.promise;

  sockA.destroy();
  const pB = runB.browser('crm');
  await sleep(20);

  const t0 = Date.now();
  openGate = undefined;
  gate.resolve();
  await upgrading;

  const idB = await pB;
  const elapsed = Date.now() - t0;
  assert.ok(idB);
  assert.ok(elapsed < IDLE_MS / 2, `abandoned open handed off in ${elapsed}ms`);
  assert.equal(runA.bySite.size, 0);
  await runB.close();
});

test('keepAlive nudges an idle run browser for immediate handoff, skips active runs, and ignores non-keepalive logins', async () => {
  const future = new Date(keepAliveClock + 86_400_000).toISOString();
  setWebsite({ keepalive: '/app', every: 5 });

  // 1) Idle run with keepalive disabled on login: keepAlive must NOT evict the warm browser.
  setLogin('no-ka');
  const runIdleNoKa = new Browsers(running('ka-no'), 1);
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
  const runActive = new Browsers(running('ka-active'), 1);
  await runActive.browser('crm');
  const c1 = new PassThrough();
  runActive.connected('crm', c1);
  keepAliveClock += 10 * 60_000;
  const tActive = Date.now();
  await keepAlive(new Date(keepAliveClock));
  assert.ok(Date.now() - tActive < 200, 'keepAlive does not block on an active run');
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
  // Once runActive closes, backState becomes what keepAlive itself writes back.
  const keepAlivePromise = keepAlive(new Date(keepAliveClock));
  await keepAlivePromise;
  const elapsed = Date.now() - tIdle;

  assert.ok(elapsed < IDLE_MS / 2, `keepAlive nudged idle run in ${elapsed}ms`);
  assert.equal(runActive.bySite.size, 0, 'idle run closed for keepAlive');
  assert.equal(pagesVisited.length, 1, 'keepAlive ran its page check');
  assert.deepEqual(openedStates, [cookieState('from-active-run')], 'keepAlive opened from the idle run writeback state');
  assert.equal(logins(alice).find(l => l.id === 'web:crm')?.expired, undefined);
});
