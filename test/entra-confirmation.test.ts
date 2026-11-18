import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
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
