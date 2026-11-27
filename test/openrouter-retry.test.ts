import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRetryAfterMs,
  RETRY_429_DELAYS_MS,
  RETRY_429_MAX_DELAY_MS,
  retryDelayMs,
  sleepAbortable,
} from '../src/connections/openrouter.ts';
import { serverCall, upstreams } from '../src/connections.ts';
import { initSystem } from '../src/system.ts';

test('parseRetryAfterMs handles seconds, HTTP dates, and invalid values without shortening long cooldowns', () => {
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(''), undefined);
  assert.equal(parseRetryAfterMs('not-a-date'), undefined);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs('2.5'), 2500);
  assert.equal(parseRetryAfterMs('-5'), 0);
  assert.equal(parseRetryAfterMs('999'), 999_000);
  const now = Date.parse('2026-11-26T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 26 Nov 2026 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfterMs('Thu, 26 Nov 2026 00:10:00 GMT', now), 600_000);
  assert.equal(parseRetryAfterMs('Thu, 25 Nov 2026 23:59:55 GMT', now), 0);
  // Long Retry-After exceeding maxDelayMs should not be shortened; retryDelayMs returns undefined.
  assert.equal(retryDelayMs(0, '999'), undefined);
  assert.equal(retryDelayMs(0, '60'), RETRY_429_MAX_DELAY_MS);
});

test('retryDelayMs follows exponential schedule, respects Retry-After, and caps attempts', () => {
  for (let i = 0; i < RETRY_429_DELAYS_MS.length; i++) {
    assert.equal(retryDelayMs(i, undefined, { random: () => 0 }), RETRY_429_DELAYS_MS[i]);
  }
  assert.equal(retryDelayMs(0, undefined, { random: () => 0.5, jitterMs: 1000 }), RETRY_429_DELAYS_MS[0] + 500);
  assert.equal(retryDelayMs(0, '4', { random: () => 0.9 }), 4000);
  assert.equal(retryDelayMs(RETRY_429_DELAYS_MS.length), undefined);
  assert.equal(retryDelayMs(-1), undefined);
});

test('sleepAbortable resolves true on timeout and false when aborted', async () => {
  assert.equal(await sleepAbortable(1), true);
  const ac = new AbortController();
  const p = sleepAbortable(60_000, ac.signal);
  ac.abort();
  assert.equal(await p, false);
});

test('serverCall retries OpenRouter 429 responses respecting Retry-After', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-or-429-'));
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevUpstream = upstreams['openrouter.ai'];
  let hits = 0;
  const srv = createServer((req, res) => {
    req.resume();
    hits++;
    if (hits <= 2) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'gen-ok', choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } }));
  });
  await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address() as { port: number };
  try {
    initSystem(root);
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    upstreams['openrouter.ai'] = `http://127.0.0.1:${port}`;
    const r = await serverCall('openrouter', '/api/v1/chat/completions', { model: 'openai/gpt-6.2-sol', messages: [] }, { kind: 'try', person: 'alice@example.com' });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(hits, 3);
  } finally {
    srv.close();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevUpstream === undefined) delete upstreams['openrouter.ai']; else upstreams['openrouter.ai'] = prevUpstream;
    rmSync(root, { recursive: true, force: true });
  }
});

test('openrouter.check clamps max_tokens fields to RF_OPENROUTER_MAX_TOKENS (default 65536, 0 disables)', async () => {
  const { check, DEFAULT_MAX_TOKENS_CAP } = await import('../src/connections/openrouter.ts');
  const prev = process.env.RF_OPENROUTER_MAX_TOKENS;
  const mk = (json: Record<string, unknown>) => ({ method: 'POST', url: new URL('https://openrouter.ai/api/v1/chat/completions'), json, body: Buffer.from(JSON.stringify(json)) });
  try {
    delete process.env.RF_OPENROUTER_MAX_TOKENS;
    const clamped = check(mk({ model: 'anthropic/claude-opus-5.5', max_tokens: 128000, max_completion_tokens: 90000, max_output_tokens: 4096 })) as Record<string, unknown>;
    assert.equal(clamped.max_tokens, DEFAULT_MAX_TOKENS_CAP);
    assert.equal(clamped.max_completion_tokens, DEFAULT_MAX_TOKENS_CAP);
    assert.equal(clamped.max_output_tokens, 4096);
    assert.deepEqual(clamped.provider, { data_collection: 'deny' });

    process.env.RF_OPENROUTER_MAX_TOKENS = '32768';
    const custom = check(mk({ max_tokens: 65536 })) as Record<string, unknown>;
    assert.equal(custom.max_tokens, 32768);

    process.env.RF_OPENROUTER_MAX_TOKENS = '0';
    const off = check(mk({ max_tokens: 128000 })) as Record<string, unknown>;
    assert.equal(off.max_tokens, 128000);

    process.env.RF_OPENROUTER_MAX_TOKENS = '65_536';
    const invalid = check(mk({ max_tokens: 128000 })) as Record<string, unknown>;
    assert.equal(invalid.max_tokens, DEFAULT_MAX_TOKENS_CAP);
  } finally {
    if (prev === undefined) delete process.env.RF_OPENROUTER_MAX_TOKENS; else process.env.RF_OPENROUTER_MAX_TOKENS = prev;
  }
});
