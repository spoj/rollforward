import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { keyStatus, resetKeyCache, upstreams } from '../src/connections.ts';

test('key polling strips label and secret fields, coalesces requests and bounds stalled bodies while keeping its last safe value', { timeout: 8000 }, async () => {
  const secret = 'sk-or-private-key', label = 'sk-or-prefix...suffix';
  let mode = 'valid', queries = 0;
  const server = createServer((req, res) => {
    queries++;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'stall') return void res.write('{"data":');
    if (mode === 'malformed') return void res.end('{"data":');
    res.end(JSON.stringify({ data: { label, key: secret, usage: 99, usage_daily: 2, limit: 100, limit_remaining: 1, limit_reset: 'monthly' } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, RF_KEY_TTL_MS: process.env.RF_KEY_TTL_MS };
  const upstream = upstreams['openrouter.ai'];
  process.env.OPENROUTER_API_KEY = secret;
  process.env.RF_KEY_TTL_MS = '0';
  upstreams['openrouter.ai'] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetKeyCache();
  try {
    const safe = await keyStatus();
    assert.equal(safe!.usage, 99);
    assert.equal(safe!.low_credit, true);
    assert.doesNotMatch(JSON.stringify(safe), /sk-or-/);
    mode = 'malformed';
    assert.deepEqual(await keyStatus(), safe);
    mode = 'stall';
    const start = Date.now(), before = queries;
    const result = await Promise.all(Array.from({ length: 5 }, () => keyStatus()));
    assert.ok(Date.now() - start < 6500);
    assert.equal(queries - before, 1);
    for (const k of result) assert.deepEqual(k, safe);
  } finally {
    resetKeyCache();
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
    if (upstream === undefined) delete upstreams['openrouter.ai']; else upstreams['openrouter.ai'] = upstream;
    server.close();
    server.closeAllConnections();
  }
});
