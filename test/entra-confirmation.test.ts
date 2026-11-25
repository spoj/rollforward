import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changes, initSystem, writeJson } from '../src/system.ts';
import { HttpError } from '../src/store.ts';
import type { Active } from '../src/waker.ts';

const ALICE = 'alice@synthetic.test', original = 'original-refresh', rotated = 'rotated-refresh';
const idToken = (claims: object) => `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
const renewed = { status: 200, body: { access_token: 'synthetic', id_token: idToken({ groups: ['renewed'] }), refresh_token: rotated } };
const departed = { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS50057: The account is disabled.' } };
const expiredGrant = { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' } };
const renewalRequests: (string | null)[] = [];
let issuer: string, root: string, signInRefresh: string | undefined, refreshAnswer: { status: number; body: unknown };
const discoveryPath = '/.well-known/openid-configuration', tokenPath = '/token';
const holds = new Map<string, ReturnType<typeof hold>>();
function hold(path: string) {
  const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), closed: Promise.withResolvers<void>() };
  holds.set(path, gate);
  return gate;
}

const idp = createServer(async (req, res) => {
  const url = new URL(req.url!, issuer), path = url.pathname;
  if (path.startsWith('/auth/')) { await authenticate(req, res, url); return; }
  let gate = holds.get(path), answer: typeof refreshAnswer;
  if (path === discoveryPath) answer = { status: 200, body: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: issuer + tokenPath } };
  else if (path === tokenPath) {
    const form = new URLSearchParams(Buffer.concat(await Array.fromAsync(req)).toString());
    if (form.get('grant_type') === 'authorization_code') {
      gate = undefined;
      answer = { status: 200, body: { refresh_token: signInRefresh,
        id_token: idToken({ iss: issuer, aud: 'rf-test', exp: Date.now() / 1000 + 300, email: ALICE, nonce: form.get('code'), groups: ['interactive'] }) } };
    } else {
      renewalRequests.push(form.get('refresh_token'));
      answer = refreshAnswer;
    }
  } else return void res.writeHead(404).end();
  res.writeHead(answer.status, { 'content-type': 'application/json' });
  if (gate) {
    res.once('close', gate.closed.resolve);
    res.flushHeaders();
    gate.entered.resolve();
    await gate.release.promise;
  }
  if (!res.destroyed) res.end(JSON.stringify(answer.body));
});
await new Promise<void>(resolve => idp.listen(0, '127.0.0.1', resolve));
issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
Object.assign(process.env, { RF_OIDC_ISSUER: issuer, RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'synthetic', RF_PUBLIC_URL: issuer, RF_OIDC_REDIRECT_URI: `${issuer}/auth/callback` });
const { authenticate, users } = await import('../src/auth.ts');
const { confirm, keepSignIn } = await import('../src/entra.ts');
const { secret } = await import('../src/logins.ts');
const { active } = await import('../src/waker.ts');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rf-entra-confirmation-'));
  initSystem(root);
  writeJson('users.json', { [ALICE]: { role: 'user', groups: ['original'], epoch: 1 } });
  keepSignIn(ALICE, original);
  renewalRequests.length = 0;
  signInRefresh = original;
  refreshAnswer = renewed;
});
afterEach(() => {
  for (const gate of holds.values()) gate.release.resolve();
  holds.clear();
  active.clear();
  rmSync(root, { recursive: true, force: true });
});
after(() => idp.close());

async function signIn() {
  const start = await fetch(`${issuer}/auth/login`, { redirect: 'manual' }), to = new URL(start.headers.get('location')!);
  const callback = new URLSearchParams({ state: to.searchParams.get('state')!, code: to.searchParams.get('nonce')! });
  const admit = await fetch(`${issuer}/auth/callback?${callback}`, { redirect: 'manual', headers: { cookie: start.headers.getSetCookie()[0].split(';')[0] } });
  assert.equal(admit.status, 302);
}

const ended = new HttpError(409, 'wake check is no longer current');
function assertIdentity(groups: string[]) {
  assert.equal(secret(ALICE, 'entra'), original);
  assert.deepEqual(users()[ALICE].groups, groups);
  assert.equal(users()[ALICE].disabled, undefined);
  assert.equal(users()[ALICE].epoch, 1);
}

test('a checkpoint lost during discovery prevents dispatching a refresh', { timeout: 5000 }, async () => {
  const gate = hold(discoveryPath);
  let current = true;
  const pending = confirm(ALICE, () => { if (!current) throw ended; });
  await gate.entered.promise;
  current = false;
  gate.release.resolve();
  await assert.rejects(pending, e => e === ended);
  assert.deepEqual(renewalRequests, []);
  assertIdentity(['original']);
});

for (const [result, answer] of [['rotation', renewed], ['departure', departed]] as const) {
  test(`a wake check that loses its checkpoint cannot apply a late ${result}`, { timeout: 5000 }, async () => {
    refreshAnswer = answer;
    const gate = hold(tokenPath);
    let current = true;
    const pending = confirm(ALICE, () => { if (!current) throw ended; });
    await gate.entered.promise;
    current = false;
    gate.release.resolve();
    await assert.rejects(pending, e => e === ended);
    assertIdentity(['original']);
  });
}

for (const [result, refresh, answer] of [
  ['rotation with the same sign-in token', original, renewed],
  ['departure with the same sign-in token', original, departed],
  ['rotation after sign-in without a new token', undefined, renewed],
] as const) {
  test(`a newer interactive sign-in fences a late ${result}`, { timeout: 5000 }, async () => {
    refreshAnswer = answer;
    signInRefresh = refresh;
    const gate = hold(tokenPath);
    const pending = confirm(ALICE, () => {});
    await gate.entered.promise;
    await signIn();
    assertIdentity(['interactive']);
    gate.release.resolve();
    await assert.rejects(pending, { status: 409 });
    assertIdentity(['interactive']);
  });
}

test('aborting confirmation closes the active provider refresh without waiting for its reply', { timeout: 5000 }, async () => {
  const gate = hold(tokenPath), cancel = new AbortController();
  const pending = confirm(ALICE, undefined, cancel.signal);
  await gate.entered.promise;
  cancel.abort(ended);
  await Promise.all([assert.rejects(pending, e => e === ended), gate.closed.promise]);
  assertIdentity(['original']);
});

test('cancellation during committed cleanup does not hold a replacement confirmation', { timeout: 5000 }, async () => {
  const cleanup = hold('cleanup'), cancel = new AbortController();
  // Add an active browser after the user write, so only the late browser cleanup waits.
  const addBrowser = () => active.set('old', { browsers: { closeUnlent: async () => { cleanup.entered.resolve(); await cleanup.release.promise; } } } as unknown as Active);
  changes.once('change', addBrowser);
  const pending = confirm(ALICE, () => {}, cancel.signal);
  try {
    await cleanup.entered.promise;
    assert.equal(secret(ALICE, 'entra'), rotated);
    assert.deepEqual(users()[ALICE].groups, ['renewed']);
    cancel.abort(ended);
    active.delete('old');
    await confirm(ALICE);
    assert.deepEqual(renewalRequests, [original, rotated]);
  } finally {
    changes.off('change', addBrowser);
    cleanup.release.resolve();
  }
  await assert.rejects(pending, e => e === ended);
});

for (const [label, refresh, answer] of [
  ['rotation', 'interactive-refresh', renewed],
  ['departure', 'interactive-refresh', departed],
  ['expired 401', 'interactive-refresh', expiredGrant],
  ['rotation without new token', undefined, renewed],
] as const) {
  test(`ordinary confirm(email) without checkpoint/signal fences a late ${label} against an interactive sign-in`, { timeout: 5000 }, async () => {
    refreshAnswer = answer;
    signInRefresh = refresh;
    const gate = hold(tokenPath);
    const pending = confirm(ALICE);
    await gate.entered.promise;
    await signIn();
    const expectedRefresh = refresh ?? original;
    assert.equal(secret(ALICE, 'entra'), expectedRefresh);
    assert.deepEqual(users()[ALICE].groups, ['interactive']);
    gate.release.resolve();
    await assert.rejects(pending, (e: unknown) => (e as HttpError).status === 409 && (e as { superseded?: boolean }).superseded === true);
    assert.equal(secret(ALICE, 'entra'), expectedRefresh);
    assert.deepEqual(users()[ALICE].groups, ['interactive']);
    assert.equal(users()[ALICE].disabled, undefined);
  });
}

test('ordinary Pi start retries superseded confirm(runner) on racing keepSignIn() without appending expired', { timeout: 15_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-entra-waker-'));
  try {
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { createServer } from 'node:http';
      const root = ${JSON.stringify(dir)}, ALICE = 'alice@synthetic.test';
      const idToken = c => 'test.' + Buffer.from(JSON.stringify(c)).toString('base64url') + '.';
      const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const seenTokens = [];
      const idp = createServer(async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/.well-known/openid-configuration') {
          const base = 'http://127.0.0.1:' + idp.address().port;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token' }));
          return;
        }
        if (u.pathname === '/token') {
          const form = new URLSearchParams(Buffer.concat(await Array.fromAsync(req)).toString());
          const rt = form.get('refresh_token');
          seenTokens.push(rt);
          if (rt === 'stale-refresh') {
            gate.entered.resolve();
            await gate.release.promise;
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS700082: expired' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'ok', id_token: idToken({ groups: ['fresh-group'] }), refresh_token: 'rotated-fresh' }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise(ok => idp.listen(0, '127.0.0.1', ok));
      const base = 'http://127.0.0.1:' + idp.address().port;
      Object.assign(process.env, { RF_OIDC_ISSUER: base, RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'synthetic', RF_PUBLIC_URL: base, RF_OIDC_REDIRECT_URI: base + '/auth/callback', RF_MIN_FREE_GB: '0' });
      const runner = await import('./src/runner.ts');
      const started = Promise.withResolvers();
      mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async () => ({
        turn: async () => { started.resolve(); return { settled: new Promise(() => {}) }; },
        steer: async () => {}, interrupt: async () => {}, stop: async () => {},
      }) } });
      const { initSystem, saveTree, writeJson } = await import('./src/system.ts');
      const { openStore, createInstance } = await import('./src/store.ts');
      const { ownSeries } = await import('./test/owner-fixture.ts');
      const { keepSignIn } = await import('./src/entra.ts');
      const { secret } = await import('./src/logins.ts');
      const { users } = await import('./src/auth.ts');
      const { kick, active, stop } = await import('./src/waker.ts');
      initSystem(root); openStore(root);
      saveTree({ workspaces: { w: { name: 'W', owners: [ALICE], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
      writeJson('users.json', { [ALICE]: { role: 'user', groups: ['old-group'], epoch: 1 } });
      ownSeries('s', ALICE);
      keepSignIn(ALICE, 'stale-refresh');
      const inst = createInstance('s', 'i1', ALICE);
      inst.append(ALICE, 'comment', { text: 'Start run', thread: 'c2' });
      try {
        kick(inst);
        await gate.entered.promise;
        keepSignIn(ALICE, 'fresh-refresh');
        gate.release.resolve();
        await started.promise;
        assert.deepEqual(seenTokens, ['stale-refresh', 'fresh-refresh']);
        assert.equal(inst.log.some(e => e.op === 'expired'), false, 'superseded 401 must not append expired');
        assert.equal(inst.log.some(e => e.op === 'run'), true, 'run started after retrying with fresh sign-in');
        assert.equal(secret(ALICE, 'entra'), 'rotated-fresh');
        assert.deepEqual(users()[ALICE].groups, ['fresh-group']);
      } finally {
        clearTimeout(active.get('s')?.timer);
        stop();
        idp.close();
        idp.closeAllConnections();
      }
    `], { cwd: join(import.meta.dirname, '..'), timeout: 15_000, stdio: 'pipe' });
  } catch (e) {
    assert.fail((e as { stderr?: Buffer }).stderr?.toString() || String(e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
