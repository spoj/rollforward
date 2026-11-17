import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem } from '../src/system.ts';
import { keyOut, keyStatus, resetKeyCache, serverCall, serverKey, upstreams } from '../src/connections.ts';

// The server's two OpenRouter keys, a daily one and a monthly one, at a stand-in for OpenRouter: /api/v1/key says what each has left,
// and a chat completion answers with `answer`, saying which key it was sent with.
const root = mkdtempSync(join(tmpdir(), 'rf-keys-'));
initSystem(root);
const DAY = 'sk-or-day-key', MONTH = 'sk-or-month-key';
const left: Record<string, number> = {}, sent: string[] = [];
let answer = 200;
const server = createServer((req, res) => {
  const k = String(req.headers.authorization).replace('Bearer ', '');
  res.writeHead(req.url === '/api/v1/key' ? 200 : answer, { 'content-type': 'application/json' });
  if (req.url === '/api/v1/key') return void res.end(JSON.stringify({ data: { usage: 1, usage_daily: 1, limit: k === DAY ? 500 : 1000, limit_remaining: left[k], limit_reset: k === DAY ? 'daily' : 'monthly' } }));
  sent.push(k);
  res.end(JSON.stringify(answer === 200 ? { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } } : { error: { message: 'Key limit exceeded', code: answer } }));
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const was = { ...process.env }, upstream = upstreams['openrouter.ai'];
Object.assign(process.env, { OPENROUTER_API_KEY: DAY, OPENROUTER_FALLBACK_KEY: MONTH, RF_KEY_TTL_MS: '0' });
upstreams['openrouter.ai'] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  resetKeyCache();
  for (const k of ['OPENROUTER_API_KEY', 'OPENROUTER_FALLBACK_KEY', 'RF_KEY_TTL_MS']) was[k] === undefined ? delete process.env[k] : process.env[k] = was[k];
  if (upstream === undefined) delete upstreams['openrouter.ai']; else upstreams['openrouter.ai'] = upstream;
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  resetKeyCache();
  Object.assign(left, { [DAY]: 400, [MONTH]: 900 });
  answer = 200;
});
const switches = () => (existsSync(join(root, '.rf', 'log.jsonl')) ? readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'openrouter key') : []);

test('the daily key goes while it has $50 or more left, the monthly one once it has less, and the daily one again once its limit resets', async () => {
  const before = switches().length;
  assert.equal(serverKey(), DAY, 'before any check');
  assert.deepEqual([(await keyStatus())!.key, serverKey()], ['primary', DAY]);
  left[DAY] = 49.5;
  const low = (await keyStatus())!;
  assert.deepEqual([low.key, low.remaining, low.low_credit, serverKey()], ['fallback', 900, false, MONTH], 'the monthly key, which has plenty');
  left[DAY] = 500;
  assert.deepEqual([(await keyStatus())!.key, serverKey()], ['primary', DAY], 'its daily limit reset');
  assert.deepEqual(switches().slice(before).map(e => [e.by, e.using]), [['server', 'fallback'], ['server', 'primary']], "each switch is in the system's log");
  assert.doesNotMatch(JSON.stringify([await keyStatus(), switches()]), /sk-or-/, 'never a key');
});

test('a daily key that answers it is out gives way at once, until a check finds its credit back', async () => {
  await keyStatus();
  keyOut(DAY);
  assert.equal(serverKey(), MONTH);
  left[DAY] = 10;
  await keyStatus();
  assert.equal(serverKey(), MONTH);
  left[DAY] = 500;
  await keyStatus();
  assert.equal(serverKey(), DAY);
});

test("the server's own calls go with the key in use, and one OpenRouter refuses as out of credit turns them to the other", async () => {
  await keyStatus();
  const call = () => serverCall('openrouter', '/api/v1/chat/completions', { model: 'm', messages: [] }, { kind: 'try', person: 'a@demo.test' });
  await call();
  answer = 402;
  await call();
  answer = 200;
  await call();
  assert.deepEqual(sent.slice(-3), [DAY, DAY, MONTH]);
});

test('both keys low say so, and one key alone is used whatever it has left', async () => {
  Object.assign(left, { [DAY]: 10, [MONTH]: 20 });
  const both = (await keyStatus())!;
  assert.deepEqual([both.key, both.remaining, both.low_credit], ['fallback', 20, true]);
  delete process.env.OPENROUTER_FALLBACK_KEY;
  try {
    resetKeyCache();
    const one = (await keyStatus())!;
    assert.deepEqual([one.key, one.remaining, one.low_credit, serverKey()], ['primary', 10, true, DAY]);
  } finally {
    process.env.OPENROUTER_FALLBACK_KEY = MONTH;
  }
});
