import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree } from '../src/system.ts';
import type { Browsers as RunBrowsers } from '../src/browsers.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-browser-end-'));
let Browsers: typeof RunBrowsers, opening = Promise.resolve(), closing = Promise.resolve(), screenshot = Promise.resolve();
let opened = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>(), shot = Promise.withResolvers<void>();
const service = createServer(async (req, res) => {
  if (req.method === 'POST') {
    opened.resolve();
    await opening;
    return void res.end(JSON.stringify({ id: 'print' }));
  }
  if (req.method === 'DELETE') {
    closed.resolve();
    await closing;
    return void res.end(JSON.stringify({ state: null, log: [] }));
  }
  shot.resolve();
  await screenshot;
  res.end('png');
});

before(async () => {
  await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
  process.env.RF_BROWSER_URL = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  ({ Browsers } = await import('../src/browsers.ts'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Files', owners: ['ann@demo.test'], members: [] } }, series: { s: { name: 'Print', workspace: 'w' } } });
});
after(async () => {
  await new Promise<void>(ok => service.close(() => ok()));
  rmSync(root, { recursive: true, force: true });
});

test('ending waits for a browser still opening and for its subsequent close', async () => {
  const gate = Promise.withResolvers<void>(), shut = Promise.withResolvers<void>();
  opening = gate.promise;
  closing = shut.promise;
  const inst = createInstance('s', 'opening', 'ann@demo.test', []), browsers = new Browsers(inst, 1);
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
  const inst = createInstance('s', 'closing', 'ann@demo.test', []), browsers = new Browsers(inst, 1);
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
  const inst = createInstance('s', 'screenshot', 'ann@demo.test', []), browsers = new Browsers(inst, 1);
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
