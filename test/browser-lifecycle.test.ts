import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { authority, logins, saveLogin } from '../src/logins.ts';
import { ownSeries } from './owner-fixture.ts';
import type { Browsers as RunBrowsers } from '../src/browsers.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-browser-end-'));
let Browsers: typeof RunBrowsers, addSite: typeof import('../src/browsers.ts').addSite, held: typeof import('../src/waker.ts').held, stopWaker: typeof import('../src/waker.ts').stop;
let opening = Promise.resolve(), closing = Promise.resolve(), screenshot = Promise.resolve(), closeFail = false, sessionSeq = 0;
let opened = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>(), shot = Promise.withResolvers<void>();
const service = createServer(async (req, res) => {
  if (req.url!.startsWith('/blocked?')) {
    const hosts = new URL(req.url!, 'http://browser.test').searchParams.getAll('host');
    return void res.end(JSON.stringify(Object.fromEntries(hosts.map(h => [h, false]))));
  }
  if (req.method === 'POST') {
    opened.resolve();
    await opening;
    return void res.end(JSON.stringify({ id: `s${++sessionSeq}` }));
  }
  if (req.method === 'DELETE') {
    closed.resolve();
    await closing;
    if (closeFail) return void res.writeHead(500).end(JSON.stringify({ error: 'remote close failed' }));
    return void res.end(JSON.stringify({ state: null, log: [] }));
  }
  shot.resolve();
  await screenshot;
  res.end('png');
});

before(async () => {
  await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
  process.env.RF_BROWSER_URL = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  ({ Browsers, addSite } = await import('../src/browsers.ts'));
  ({ held, stop: stopWaker } = await import('../src/waker.ts'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Files', owners: ['ann@demo.test'], members: [] } }, series: { s: { name: 'Print', workspace: 'w' } } });
  writeJson('users.json', { 'ann@demo.test': { name: 'Ann', role: 'user' } });
  ownSeries('s', 'ann@demo.test');
});
after(async () => {
  stopWaker();
  await new Promise<void>(ok => service.close(() => ok()));
  rmSync(root, { recursive: true, force: true });
});

test('ending waits for a browser still opening and for its subsequent close', async () => {
  const gate = Promise.withResolvers<void>(), shut = Promise.withResolvers<void>();
  opening = gate.promise;
  closing = shut.promise;
  const inst = createInstance('s', 'opening', 'ann@demo.test');
  inst.append('server', 'run', { run: 1, runner: 'ann@demo.test', authority: authority(inst) });
  const browsers = new Browsers(inst, 1);
  const browser = browsers.browser('print');
  await opened.promise;
  let done = false;
  const ended = browsers.end().then(() => { done = true; });
  await new Promise(ok => setImmediate(ok));
  assert.equal(done, false);
  gate.resolve();
  await closed.promise;
  assert.equal(done, false);
  shut.resolve();
  await Promise.all([browser, ended]);
  inst.markDeleted('ann@demo.test', { cost: 0, runs: [] });
  inst.clear();
  assert.deepEqual(readdirSync(inst.dir).sort(), ['instance.json', 'log.jsonl', 'screen.json']);
});

test('ending waits for a browser whose idle close is already in progress', async () => {
  opening = Promise.resolve();
  const shut = Promise.withResolvers<void>();
  closing = shut.promise;
  closed = Promise.withResolvers<void>();
  const inst = createInstance('s', 'closing', 'ann@demo.test');
  inst.append('server', 'run', { run: 1, runner: 'ann@demo.test', authority: authority(inst) });
  const browsers = new Browsers(inst, 1);
  await browsers.browser('print');
  browsers.connected('print', new PassThrough());
  const close = browsers.close('print');
  await closed.promise;
  let done = false;
  const ended = browsers.end().then(() => { done = true; });
  await new Promise(ok => setImmediate(ok));
  assert.equal(done, false);
  shut.resolve();
  await Promise.all([close, ended]);
});

test('a screenshot answering after deletion never recreates browser files', async () => {
  closing = Promise.resolve();
  const gate = Promise.withResolvers<void>();
  screenshot = gate.promise;
  const inst = createInstance('s', 'screenshot', 'ann@demo.test');
  inst.append('server', 'run', { run: 1, runner: 'ann@demo.test', authority: authority(inst) });
  const browsers = new Browsers(inst, 1);
  await browsers.browser('print');
  browsers.connected('print', new PassThrough());
  const shooting = browsers.shoot();
  await shot.promise;
  inst.markDeleted('ann@demo.test', { cost: 0, runs: [] });
  await browsers.end();
  inst.clear();
  gate.resolve();
  await shooting;
  assert.deepEqual(readdirSync(inst.dir).sort(), ['instance.json', 'log.jsonl', 'screen.json']);
});

test('expire records instance expiry before slow or rejecting browser close so sign-in recovery is never lost', async () => {
  const email = 'ann@demo.test';
  await addSite(email, 'portal', 'https://portal.test/');
  writeJson('grants.json', { g1: { id: 'g1', state: 'approved', site: 'portal', person: email, workspace: 'w' } });
  saveLogin(email, { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-11-01T00:00:00.000Z', offers: [{ id: 'web:portal', name: 'portal' }] }, JSON.stringify({ cookies: [], origins: [] }));
  ownSeries('s', email, ['web:portal'], false);

  // 1) Slow close racing interactive sign-in recovery.
  opening = Promise.resolve();
  const shut = Promise.withResolvers<void>();
  closing = shut.promise;
  closed = Promise.withResolvers<void>();
  closeFail = false;

  const inst = createInstance('s', 'expire-race', email);
  inst.append('server', 'run', { run: 1, runner: email, initiator: email, authority: authority(inst) });
  const browsers = new Browsers(inst, 1);
  await browsers.browser('portal');
  browsers.connected('portal', new PassThrough());

  const expiring = browsers.expire('portal');
  await closed.promise;
  // Before remote browser close finishes, both login expiry and instance expired event are already recorded.
  assert.equal(logins(email).find(l => l.id === 'web:portal')!.expired, true);
  assert.equal(inst.log.filter(e => e.op === 'expired' && e.login === 'web:portal').length, 1);
  assert.equal(held(inst, 'web:portal', email), true);

  // Person completes sign-in while close is still outstanding -> waker must wake the instance immediately.
  saveLogin(email, { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-11-01T01:00:00.000Z', offers: [{ id: 'web:portal', name: 'portal' }] }, JSON.stringify({ cookies: [{ name: 'sid', domain: 'portal.test', value: 'fresh' }], origins: [] }));
  assert.equal(held(inst, 'web:portal', email), false, 'sign-in recovery cleared held state while close was in flight');
  assert.equal(inst.log.some(e => e.op === 'wake' && e.login === 'web:portal'), true, 'recovery wake appended while close was still pending');

  shut.resolve();
  await expiring;
  assert.equal(inst.log.filter(e => e.op === 'expired' && e.login === 'web:portal').length, 1, 'no duplicate expiry after close settles');
  const expIdx = inst.log.findIndex(e => e.op === 'expired' && e.login === 'web:portal');
  const wakeIdx = inst.log.findIndex(e => e.op === 'wake' && e.login === 'web:portal');
  assert.ok(expIdx >= 0 && wakeIdx > expIdx, 'expired event precedes recovery wake');

  // 2) Rejecting remote browser close does not suppress expiry recording.
  closing = Promise.resolve();
  closed = Promise.withResolvers<void>();
  closeFail = true;
  try {
    const inst2 = createInstance('s', 'expire-reject', email);
    inst2.append('server', 'run', { run: 1, runner: email, initiator: email, authority: authority(inst2) });
    const browsers2 = new Browsers(inst2, 1);
    await browsers2.browser('portal');
    browsers2.connected('portal', new PassThrough());
    await browsers2.expire('portal');
    assert.equal(logins(email).find(l => l.id === 'web:portal')!.expired, true);
    assert.equal(inst2.log.filter(e => e.op === 'expired' && e.login === 'web:portal').length, 1, 'expiry recorded even when remote close rejects');
    assert.equal(held(inst2, 'web:portal', email), true);
    assert.equal(inst2.log.some(e => e.op === 'browsers' && /remote close failed/.test(String(e.error))), true);
  } finally {
    closeFail = false;
    closing = Promise.resolve();
  }
});
