import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem } from '../src/system.ts';
import { keyOut, keyStatus, openrouterCreditError, resetKeyCache, serverCall, serverKey, upstreams } from '../src/connections.ts';
import { call as proxyCall, type CallRun } from '../src/connections.ts';
import { saveTree, writeJson } from '../src/system.ts';
import { saveSeriesSettings } from '../src/series.ts';
import { createInstance, instance, openStore, type Instance } from '../src/store.ts';
import { logins, saveLogin } from '../src/logins.ts';

// The server's two OpenRouter keys, a daily one and a monthly one, at a stand-in for OpenRouter: /api/v1/key says what each has left,
// and a chat completion answers with `answer` + `answerBody`, saying which key it was sent with.
const root = mkdtempSync(join(tmpdir(), 'rf-keys-'));
initSystem(root);
const DAY = 'sk-or-day-key', MONTH = 'sk-or-month-key';
const left: Record<string, number> = {}, sent: string[] = [];
let answer = 200;
let answerBody: Record<string, unknown> | undefined;
let chatGate: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
const server = createServer(async (req, res) => {
  const k = String(req.headers.authorization).replace('Bearer ', '');
  if (req.url === '/api/v1/key') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ data: { usage: 1, usage_daily: 1, limit: k === DAY ? 500 : 1000, limit_remaining: left[k], limit_reset: k === DAY ? 'daily' : 'monthly' } }));
  }
  sent.push(k);
  if (chatGate) {
    const g = chatGate;
    chatGate = undefined;
    g.entered.resolve();
    await g.release.promise;
  }
  res.writeHead(answer, { 'content-type': 'application/json' });
  res.end(JSON.stringify(answer === 200 ? { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } } : (answerBody ?? { error: { message: 'Key limit exceeded', code: answer } })));
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
  answerBody = undefined;
});
const logActs = (op: string) => (existsSync(join(root, '.rf', 'log.jsonl')) ? readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === op) : []);
const switches = () => logActs('openrouter key');
const creditActs = () => logActs('openrouter credit');

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

test('a daily key that answers 403 openrouter_key_limit gives way at once, until a check finds its credit back', async () => {
  await keyStatus();
  keyOut(DAY, 403, { error: { code: 403, message: 'Key limit exceeded', metadata: { limit_source: 'openrouter_key_limit' } } });
  assert.equal(serverKey(), MONTH);
  left[DAY] = 10;
  await keyStatus();
  assert.equal(serverKey(), MONTH);
  left[DAY] = 500;
  await keyStatus();
  assert.equal(serverKey(), DAY);
});

test('403 openrouter_key_limit switches keys on serverCall, while policy 403 and 402 credits never switch keys', async () => {
  await keyStatus();
  const call = () => serverCall('openrouter', '/api/v1/chat/completions', { model: 'm', messages: [] }, { kind: 'try', person: 'a@demo.test' });
  const beforeCredit = creditActs().length;

  // Policy/moderation 403 without openrouter_key_limit must NOT switch keys or latch credit_error.
  answer = 403;
  answerBody = { error: { code: 403, message: 'Moderation refusal', metadata: { limit_source: 'moderation' } } };
  await call();
  assert.equal(serverKey(), DAY, 'moderation 403 keeps primary key');
  assert.equal(openrouterCreditError(), null);

  // Account-wide 402 (openrouter_credits) must NOT switch keys; latches credit_error once and redacts key strings.
  answer = 402;
  answerBody = { error: { code: 402, message: `Insufficient credits for ${DAY}\nplease top up`, metadata: { limit_source: 'openrouter_credits' } } };
  await call();
  await call(); // repeated 402 during same outage must NOT duplicate audit log
  assert.equal(serverKey(), DAY, '402 never flips to fallback key');
  const st = (await keyStatus())!;
  assert.equal(st.key, 'primary');
  assert.equal(st.low_credit, false);
  assert.ok(st.credit_error?.at);
  assert.equal(st.credit_error?.message, 'Insufficient credits for [redacted] please top up');
  assert.doesNotMatch(JSON.stringify([st, creditActs()]), /sk-or-/);
  assert.equal(creditActs().length - beforeCredit, 1, '402 logged once per outage');

  // Non-billable GET 200 must NOT clear credit_error.
  keyOut(DAY, 200, {}, 'GET');
  assert.ok(openrouterCreditError(), 'GET 200 does not clear credit_error');

  // Billable POST 200 clears credit_error and logs recovery.
  answer = 200;
  answerBody = undefined;
  await call();
  assert.equal(openrouterCreditError(), null);
  assert.equal((await keyStatus())!.credit_error, undefined);
  assert.equal(creditActs().at(-1)?.recovered, true);

  // Per-key 403 openrouter_key_limit DOES switch to fallback key immediately.
  answer = 403;
  answerBody = { error: { code: 403, message: 'Key daily limit reached', metadata: { limit_source: 'openrouter_key_limit' } } };
  await call();
  answer = 200;
  answerBody = undefined;
  await call();
  assert.deepEqual(sent.slice(-2), [DAY, MONTH]);
});

test('proxy call() path matches serverCall(): 402 latches credit_error without switching, GET 200 keeps latch, POST 200 clears, 403 key limit switches', async () => {
  openStore(root);
  writeJson('users.json', { 'a@demo.test': { role: 'user' } });
  saveTree({ workspaces: { w: { name: 'W', owners: ['a@demo.test'], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  const serDir = join(root, 'series', 's');
  saveSeriesSettings(serDir, { version: 1, owner: 'a@demo.test', epoch: 1, since: '', consent: { by: 'a@demo.test', at: '', workspace: 'w', logins: [], autonomous: false } });
  const inst = {
    id: 'i1', seriesId: 's', series: () => serDir,
    log: [{ seq: 1, at: '', by: 'a@demo.test', op: 'create' }, { seq: 2, at: '', by: 'server', op: 'run', run: 1, runner: 'a@demo.test', initiator: 'a@demo.test', authority: { version: 1, owner: 'a@demo.test', epoch: 1, workspace: 'w', logins: [] } }],
    append: () => ({ seq: 3 }),
  } as unknown as Instance;
  const run: CallRun = { inst, n: 1, runner: 'a@demo.test', cost: 0, estimated: false, links: new Map() };
  const proxy = createServer((req, res) => proxyCall(run, 'openrouter.ai', req, res)).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    await keyStatus();
    answer = 402;
    answerBody = { error: { code: 402, message: 'Out of account credits', metadata: { limit_source: 'openrouter_credits' } } };
    const r402 = await fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(r402.status, 402);
    assert.equal(serverKey(), DAY, 'proxy 402 never switches keys');
    assert.equal(openrouterCreditError()?.message, 'Out of account credits');

    // Non-billable GET /api/v1/models 200 does not clear the 402 latch.
    answer = 200;
    answerBody = undefined;
    const rGet = await fetch(`${proxyBase}/api/v1/models`, { method: 'GET' });
    assert.equal(rGet.status, 200);
    assert.ok(openrouterCreditError(), 'proxy GET 200 keeps credit_error latched');

    // Billable POST 200 clears the latch.
    const rPost = await fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(rPost.status, 200);
    assert.equal(openrouterCreditError(), null);

    // Policy 403 does not switch keys; openrouter_key_limit 403 switches immediately.
    answer = 403;
    answerBody = { error: { code: 403, message: 'Policy blocked' } };
    await fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(serverKey(), DAY);

    answerBody = { error: { code: 403, message: 'Key daily limit reached', metadata: { limit_source: 'openrouter_key_limit' } } };
    await fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(serverKey(), MONTH);
  } finally {
    proxy.close();
    proxy.closeAllConnections();
  }
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

test('a late personal-key 402 does not re-enable a disabled personal OpenRouter key, and marks the current record expired when still enabled', async () => {
  openStore(root);
  const runner = 'personal@demo.test', PERSONAL = 'sk-or-personal-key', since = '2026-11-01T00:00:00.000Z';
  writeJson('users.json', { [runner]: { role: 'user' } });
  saveTree({ workspaces: { w: { name: 'W', owners: [runner], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  const serDir = join(root, 'series', 's');
  saveSeriesSettings(serDir, { version: 1, owner: runner, epoch: 1, since: '', consent: { by: runner, at: '', workspace: 'w', logins: [], autonomous: false } });
  const appended: { by: string; op: string; fields: Record<string, unknown> }[] = [];
  const inst = {
    id: 'i-personal', seriesId: 's', series: () => serDir,
    log: [{ seq: 1, at: '', by: runner, op: 'create' }, { seq: 2, at: '', by: 'server', op: 'run', run: 1, runner, initiator: runner, authority: { version: 1, owner: runner, epoch: 1, workspace: 'w', logins: [] } }],
    append: (by: string, op: string, fields: Record<string, unknown> = {}) => { appended.push({ by, op, fields }); return { seq: appended.length + 2 }; },
  } as unknown as Instance;
  const run: CallRun = { inst, n: 1, runner, cost: 0, estimated: false, links: new Map() };
  const proxy = createServer((req, res) => proxyCall(run, 'openrouter.ai', req, res)).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    saveLogin(runner, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since, offers: [], enabled: true }, PERSONAL);
    answer = 402;
    answerBody = { error: { code: 402, message: 'Personal key out of credits' } };
    const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    chatGate = gate;
    const inflight = fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    await gate.entered.promise;

    // Disable the personal key while preserving `since` (matching PUT /logins/openrouter).
    saveLogin(runner, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since, offers: [], enabled: false });
    gate.release.resolve();
    const res402 = await inflight;
    assert.equal(res402.status, 402);

    const afterDisable = logins(runner).find(l => l.id === 'openrouter')!;
    assert.equal(afterDisable.enabled, false, 'disabled personal key must stay disabled after late 402');
    assert.equal(afterDisable.expired, undefined, 'disabled personal key must not be marked expired');
    assert.equal(appended.some(e => e.op === 'expired'), false, 'late 402 for disabled key must not log expired');

    // Follow-up request now uses the deployment key cleanly.
    answer = 200;
    answerBody = undefined;
    const okRes = await fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(okRes.status, 200);
    assert.equal(sent.at(-1), DAY);

    // When still enabled with matching `since`, a 402 marks the current record expired and logs expired.
    saveLogin(runner, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since, offers: [], enabled: true });
    answer = 402;
    answerBody = { error: { code: 402, message: 'Personal key out of credits' } };
    const stillEnabled = await fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(stillEnabled.status, 402);
    const afterExpire = logins(runner).find(l => l.id === 'openrouter')!;
    assert.equal(afterExpire.enabled, true);
    assert.equal(afterExpire.expired, true);
    assert.equal(appended.filter(e => e.op === 'expired').length, 1);
  } finally {
    chatGate?.release.resolve();
    chatGate = undefined;
    proxy.close();
    proxy.closeAllConnections();
  }
});

test('numeric unsafe-integer model is never persisted to canonical events and openStore restarts cleanly; enabling BYOK during body intake blocks shared key charge', async () => {
  const isoRoot = mkdtempSync(join(tmpdir(), 'rf-or-r2-'));
  initSystem(isoRoot);
  openStore(isoRoot);
  const runner = 'r2@demo.test';
  writeJson('users.json', { [runner]: { role: 'user' } });
  saveTree({ workspaces: { w: { name: 'W', owners: [runner], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  const serDir = join(isoRoot, 'series', 's');
  saveSeriesSettings(serDir, { version: 1, owner: runner, epoch: 1, since: '', consent: { by: runner, at: '', workspace: 'w', logins: [], autonomous: false } });
  const inst = createInstance('s', 'i1', runner);
  inst.append('server', 'run', { run: 1, runner, initiator: runner, authority: { version: 1, owner: runner, epoch: 1, workspace: 'w', logins: [] } });
  const run: CallRun = { inst, n: 1, runner, cost: 0, estimated: false, links: new Map() };
  const proxy = createServer((req, res) => proxyCall(run, 'openrouter.ai', req, res)).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    // 1) Unsafe integer model in provider request must not persist a numeric model and must keep startup clean.
    answer = 400;
    answerBody = { error: { code: 400, message: 'Bad model' } };
    const rBad = await fetch(`${proxyBase}/api/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"model": 90071992547409930000000000, "messages": []}',
    });
    assert.equal(rBad.status, 400);
    const logged = inst.log.findLast(e => e.op === 'call')!;
    assert.equal(logged.model, undefined, 'non-string model must not be persisted');
    openStore(isoRoot);
    assert.equal(instance(inst.id).log.some(e => e.op === 'call'), true, 'openStore restarts cleanly after numeric model request');

    // 2) Switching from shared key to enabled personal key during request body intake returns 409 and never charges shared key.
    answer = 200;
    answerBody = undefined;
    const sentBefore = sent.length;
    const { request: httpReq } = await import('node:http');
    const midStream = new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = httpReq(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c)).on('end', () => ok({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', fail);
      req.write('{"model":"m",');
      setTimeout(() => {
        saveLogin(runner, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since: new Date().toISOString(), offers: [], enabled: true }, 'sk-or-byok-late');
        req.end('"messages":[]}');
      }, 40);
    });
    const switched = await midStream;
    assert.equal(switched.status, 409, `expected 409 when BYOK enabled mid-body, got ${switched.status}: ${switched.body}`);
    assert.equal(sent.length, sentBefore, 'shared server key was never dispatched after runner enabled BYOK');
  } finally {
    proxy.close();
    proxy.closeAllConnections();
    initSystem(root);
    rmSync(isoRoot, { recursive: true, force: true });
  }
});
