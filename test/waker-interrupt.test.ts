import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { call, upstreams } from '../src/connections.ts';
import { active, byToken, interruptRun, stop, view, type Active } from '../src/waker.ts';
import type { Run } from '../src/runner.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-interrupt-')), alice = 'alice@demo.test';
initSystem(root);
openStore(root);
saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
writeJson('users.json', { [alice]: { role: 'user' } });
mkdirSync(join(root, 'series', 's'), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test('concurrent interrupts revoke and abort before RPC settles, drain charges, and wait for sandbox and browsers exactly once', async t => {
  const rpc = Promise.withResolvers<void>(), charge = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>(), lookup = Promise.withResolvers<void>();
  const provider = createServer(async (req, res) => {
    if (req.url!.startsWith('/api/v1/generation?')) {
      lookup.resolve();
      await charge.promise;
      return void res.end(JSON.stringify({ data: { total_cost: 0.017 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-interrupt' });
    res.write('data: {"usage":{"input_tokens":10}}\n\n');
  });
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  await new Promise<void>(ok => provider.listen(0, '127.0.0.1', ok));
  upstreams['openrouter.ai'] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const inst = createInstance('s', 'Interrupt', alice, []);
  let stops = 0, closes = 0;
  const a = {
    inst, n: 1, runner: alice, token: 'interrupt', view: view(inst), workspace: 'w', cost: 0, estimated: false, seen: 1, delivered: 1,
    done: false, process: '', links: new Map(),
    run: { interrupt: () => rpc.promise, stop: () => { stops++; return stopped.promise; }, alone: () => false } as Run,
    browsers: { end: () => { closes++; return closed.promise; } },
  } as Active;
  inst.append('server', 'run', { run: 1 });
  active.set('s', a);
  byToken.set(a.token, a);
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: '/api/v1/messages', headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from('{"model":"test","stream":true}'); },
  });
  const res = Object.assign(new EventEmitter(), {
    closed: false, headersSent: false,
    writeHead() { this.headersSent = true; return this; },
    write() { first.resolve(); return true; },
    end() { this.closed = true; this.emit('close'); },
    destroy() { this.closed = true; this.emit('close'); },
  });
  const called = call(a, 'openrouter.ai', req as any, res as any);
  await Promise.race([first.promise, called.then(() => { throw new Error(JSON.stringify(inst.log)); })]);
  let finished = 0;
  const one = interruptRun(a).then(() => { finished++; }), two = interruptRun(a).then(() => { finished++; });
  try {
    assert.equal(byToken.has(a.token), false, 'revocation does not wait for Pi');
    assert.equal(res.closed, true, 'provider stream abort does not wait for Pi');
    await lookup.promise;
    rpc.resolve();
    await new Promise(ok => setImmediate(ok));
    assert.equal(inst.log.some(e => e.op === 'done'), false, 'done waits for the charge');
    charge.resolve();
    await called;
    await new Promise(ok => setImmediate(ok));
    assert.equal(finished, 0);
    stopped.resolve();
    await new Promise(ok => setImmediate(ok));
    assert.equal(finished, 0, 'browser close is still outstanding');
    closed.resolve();
    await Promise.all([one, two]);
    assert.equal(finished, 2);
    assert.equal(stops, 1);
    assert.equal(closes, 1);
    const dones = inst.log.filter(e => e.op === 'done');
    assert.equal(dones.length, 1);
    assert.deepEqual([dones[0].aborted, dones[0].cost, dones[0].estimated], [true, 0.017, false]);
  } finally {
    rpc.resolve(); charge.resolve(); stopped.resolve(); closed.resolve();
    await Promise.all([called, one, two]);
    delete process.env.OPENROUTER_API_KEY;
    delete upstreams['openrouter.ai'];
    provider.close();
  }
});

for (const mode of ['interrupt', 'shutdown']) test(`${mode} refuses a proxy request still reading its body before it can start a provider call`, async t => {
  let requests = 0;
  const provider = createServer((req, res) => {
    requests++;
    res.end('{"usage":{"cost":0.02}}');
  });
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  await new Promise<void>(ok => provider.listen(0, '127.0.0.1', ok));
  upstreams['openrouter.ai'] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const body = Promise.withResolvers<void>(), reading = Promise.withResolvers<void>();
  const inst = createInstance('s', `Reading-${mode}`, alice, []);
  const a = {
    inst, n: 1, runner: alice, token: 'reading', view: view(inst), workspace: 'w', cost: 0, estimated: false,
    seen: 1, delivered: 1, done: false, process: '', links: new Map(),
    run: { interrupt: async () => {}, stop: async () => {}, alone: () => false } as Run,
  } as Active;
  inst.append('server', 'run', { run: 1 });
  active.set('s', a);
  byToken.set(a.token, a);
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: '/api/v1/chat/completions', headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { reading.resolve(); await body.promise; yield Buffer.from('{"model":"test"}'); },
  });
  const res = Object.assign(new EventEmitter(), {
    closed: false, headersSent: false,
    writeHead() { this.headersSent = true; return this; },
    write() { return true; }, end() { this.closed = true; this.emit('close'); }, destroy() { this.closed = true; this.emit('close'); },
  });
  const called = call(a, 'openrouter.ai', req as any, res as any);
  try {
    await reading.promise;
    if (mode === 'interrupt') await interruptRun(a);
    else stop();
    body.resolve();
    await called;
    assert.equal(requests, 0, 'no request goes upstream after interruption');
    assert.equal(inst.log.find(e => e.op === 'done')?.cost, mode === 'interrupt' ? 0 : undefined);
  } finally {
    body.resolve();
    await called;
    delete process.env.OPENROUTER_API_KEY;
    delete upstreams['openrouter.ai'];
  }
});
