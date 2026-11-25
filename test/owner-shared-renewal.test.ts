import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { CallRun } from '../src/connections.ts';

import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { createInstance, HttpError, openStore } from '../src/store.ts';
import { saveSeriesSettings } from '../src/series.ts';

const ALICE = 'alice@synthetic.test', BOB = 'bob@synthetic.test';
const sent: { path: string; auth?: string; scope?: string }[] = [];
let holdPath = '';
let tokenMode: 'ok' | 'short' | 'consent-once' | 'expired' = 'ok';
let parentStatus = 200;
let gate = Promise.withResolvers<void>();
let entered = Promise.withResolvers<void>();

const upstream = createServer(async (req, res) => {
  const path = req.url!, u = new URL(path, 'http://local');
  const raw = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString();
  const send = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const params = u.pathname === '/token' ? new URLSearchParams(raw) : undefined;
  sent.push({ path, auth: req.headers.authorization, ...(params && { scope: params.get('scope') ?? '' }) });

  if (u.pathname === holdPath || path === holdPath) {
    entered.resolve();
    await gate.promise;
  }
  if (u.pathname === '/.well-known/openid-configuration') {
    return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
  }
  if (u.pathname === '/token') {
    if (tokenMode === 'expired') return send({ error: 'invalid_grant' }, 400);
    if (tokenMode === 'consent-once') {
      tokenMode = 'ok';
      return send({ error: 'invalid_grant', suberror: 'consent_required', error_description: 'AADSTS65001: consent required' }, 400);
    }
    const expires_in = tokenMode === 'short' ? 120 : 3600;
    if (tokenMode === 'short') tokenMode = 'consent-once';
    return send({ access_token: `synthetic-alice-${sent.length}`, refresh_token: `synthetic-rt-${sent.length}`, expires_in });
  }
  if (u.pathname === '/v1.0/me/sendMail') return void res.writeHead(202).end();
  if (u.pathname === `/v1.0/users/${encodeURIComponent(ALICE)}/mailFolders/inbox`) return send({ id: 'inbox', displayName: 'Inbox' });
  if (u.searchParams.get('$select') === 'sharePointIds') {
    return send({ sharePointIds: { siteUrl: 'https://sp.synthetic.test/sites/s', siteId: 's', webId: 'w' } });
  }
  if (u.pathname.endsWith('/parent')) {
    if (parentStatus !== 200) return send({ error: { code: 'synthetic refusal' } }, parentStatus);
    return send({ id: 'parent', parentReference: { driveId: u.pathname.split('/')[3], id: 'folder' } });
  }
  return send({ id: u.pathname.split('/').at(-1), parentReference: { driveId: u.pathname.split('/')[3], id: 'parent' } });
});

await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
Object.assign(process.env, {
  RF_OIDC_ISSUER: base,
  RF_OIDC_CLIENT_ID: 'synthetic',
  RF_OIDC_CLIENT_SECRET: 'synthetic',
  RF_PUBLIC_URL: 'https://rf.synthetic.test',
  RF_M365_SCOPES: 'Mail.Read Mail.Send Files.Read.All Files.ReadWrite.All Sites.Read.All',
});

const { authority, logins, saveLogin, secret } = await import('../src/logins.ts');
const { token } = await import('../src/entra.ts');
const { call, upstreams } = await import('../src/connections.ts');
const { endpoints, offer: addGraphOffer, scope } = await import('../src/connections/graph.ts');
endpoints.graph = upstreams['graph.microsoft.com'] = base;

let root = '';
let seq = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rf-m4-inflight-'));
  initSystem(root);
  openStore(root);
  saveTree({
    workspaces: { w: { name: 'Synthetic', owners: [ALICE], members: [BOB] } },
    series: {
      s1: { name: 'Series 1', workspace: 'w' },
      s2: { name: 'Series 2', workspace: 'w' },
    },
  });
  writeJson('users.json', { [ALICE]: { role: 'user' }, [BOB]: { role: 'user' } });
  writeJson('connections.json', { m365: { type: 'graph' } });
  seq++;
  sent.length = 0;
  holdPath = '';
  tokenMode = 'ok';
  parentStatus = 200;
  gate = Promise.withResolvers<void>();
  entered = Promise.withResolvers<void>();
});

afterEach(() => {
  gate.resolve();
  rmSync(root, { recursive: true, force: true });
});
after(() => upstream.close());

function setConsent(seriesId: string, owner: string, epoch: number, logins: string[]) {
  saveSeriesSettings(join(root, `series/${seriesId}`), {
    version: 1, owner, epoch, since: '',
    consent: { by: owner, at: '', workspace: 'w', logins, autonomous: false },
  });
}

function sendProxy(run: CallRun, path: string, method = 'GET', bodyText?: string) {
  const body = (async function* () { if (bodyText) yield Buffer.from(bodyText); })();
  const req = Object.assign(Readable.from(body), {
    url: path,
    method,
    headers: bodyText ? { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } : {},
  });
  const res = Object.assign(new PassThrough(), {
    statusCode: 0,
    writeHead(status: number) { this.statusCode = status; return this; },
  });
  const chunks: Buffer[] = [];
  res.on('data', b => chunks.push(b));
  const done = call(run, 'graph.microsoft.com', req as IncomingMessage, res as unknown as ServerResponse);
  return { done, res, text: () => Buffer.concat(chunks).toString() };
}

test('stopping the discovery initiator cannot fail its successor or another series', { timeout: 5000 }, async () => {
  const ticks = [`m365:mail:${ALICE}`];
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `disc-${seq}`, scopes: ['Mail.Read', 'Mail.Send'], offers: ticks.map(id => ({ id, name: id })) }, 'rt-disc');
  setConsent('s1', ALICE, 1, ticks);
  setConsent('s2', ALICE, 1, ticks);

  const inst = createInstance('s1', 'instance-1', ALICE);
  inst.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  const run1: CallRun = { inst, n: 1, runner: ALICE, cost: 0, links: new Map() };

  holdPath = '/.well-known/openid-configuration';
  const req1 = sendProxy(run1, '/v1.0/me/sendMail', 'POST', '{"message":{}}');
  await entered.promise;

  run1.stopped = true;
  inst.append('server', 'run', { run: 2, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  const run2: CallRun = { inst, n: 2, runner: ALICE, cost: 0, links: new Map() };
  const req2 = sendProxy(run2, '/v1.0/me/sendMail', 'POST', '{"message":{}}');
  const inst3 = createInstance('s2', 'instance-3', ALICE);
  inst3.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst3) });
  const run3 = { inst: inst3, n: 1, runner: ALICE, cost: 0, links: new Map() };
  const req3 = sendProxy(run3, '/v1.0/me/sendMail', 'POST', '{"message":{}}');
  await new Promise(r => setImmediate(r));

  holdPath = '';
  gate.resolve();
  await Promise.all([req1.done, req2.done, req3.done]);

  assert.equal(req1.res.statusCode, 409);
  assert.equal(req2.res.statusCode, 202, req2.text());
  assert.equal(req3.res.statusCode, 202, req3.text());
  assert.equal(sent.filter(s => s.path === '/.well-known/openid-configuration').length, 1);
  assert.equal(sent.filter(s => s.path === '/token').length, 1);
  assert.equal(sent.filter(s => s.path === '/v1.0/me/sendMail').length, 2);
  assert.ok(sent.filter(s => s.path.startsWith('/v1.0')).every(s => s.auth === `Bearer synthetic-alice-2`));
  assert.equal(secret(ALICE, 'm365'), 'synthetic-rt-2');
});

for (const mode of ['stop', 'transfer']) test(`${mode} of the fallback initiator cannot fail another series or poison its fresh parent policy`, { timeout: 5000 }, async () => {
  const drive = `drv${seq}`;
  const ticks = [`m365:item:${drive}/folder`, `m365:mail:${ALICE}`];
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `cache-${seq}`, scopes: ['Mail.Read', 'Files.Read.All'], offers: ticks.map(id => ({ id, name: id })) }, 'rt-cache');
  setConsent('s1', ALICE, 1, ticks);
  setConsent('s2', ALICE, 1, ticks);

  const inst1 = createInstance('s1', 's1-inst', ALICE);
  inst1.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst1) });
  const run1: CallRun = { inst: inst1, n: 1, runner: ALICE, cost: 0, links: new Map() };

  const inst2 = createInstance('s2', 's2-inst', ALICE);
  inst2.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst2) });
  const run2: CallRun = { inst: inst2, n: 1, runner: ALICE, cost: 0, links: new Map() };

  tokenMode = 'short';
  holdPath = `/v1.0/drives/${drive}/items/child?$select=id,parentReference`;
  const req2 = sendProxy(run2, `/v1.0/drives/${drive}/items/child`);
  await entered.promise;

  const locatedGate = gate;
  gate = Promise.withResolvers<void>();
  entered = Promise.withResolvers<void>();
  holdPath = '/token';
  const req1 = sendProxy(run1, '/v1.0/me/sendMail', 'POST', '{"message":{}}');
  await entered.promise;

  locatedGate.resolve();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  if (mode === 'stop') run1.stopped = true;
  else setConsent('s1', BOB, 2, []);
  holdPath = '';
  gate.resolve();
  await Promise.all([req1.done, req2.done]);

  inst2.append('server', 'run', { run: 2, runner: ALICE, initiator: ALICE, authority: authority(inst2) });
  const freshRun = { ...run2, n: 2, links: new Map() };
  const followUp = sendProxy(freshRun, `/v1.0/drives/${drive}/items/child`);
  await followUp.done;

  assert.equal(sent.filter(s => s.path === '/token').length, 3, 'initial short token, primary refusal and one fallback');
  assert.equal(sent.filter(s => s.path.includes('/items/parent')).length, 2, 'each request verifies current parent ancestry fresh (no cross-request parent cache)');
  assert.equal(sent.some(s => s.path === '/v1.0/me/sendMail'), false);
  assert.equal(sent.find(s => s.path.includes('/items/parent'))!.auth, 'Bearer synthetic-alice-4');
  assert.equal(req1.res.statusCode, mode === 'stop' ? 409 : 403);
  assert.match(req1.text(), mode === 'stop' ? /run stopped/ : /authority has ended/);
  assert.equal(req2.res.statusCode, 200, `expected authorized Series 2 Run 2 to succeed with 200, got ${req2.res.statusCode}: ${req2.text()}`);
  assert.equal(followUp.res.statusCode, 200, `expected subsequent Series 2 request to succeed with 200 (not poisoned in parents cache), got ${followUp.res.statusCode}: ${followUp.text()}`);
});

test('an unscoped personal offer keeps shared fallback authorized after its run initiator stops', { timeout: 5000 }, async () => {
  const ticks = [`m365:mail:${ALICE}`];
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `offer-${seq}`, scopes: ['Mail.Read', 'Mail.Send'], offers: ticks.map(id => ({ id, name: id })) }, 'rt-offer');
  setConsent('s1', ALICE, 1, ticks);

  const inst1 = createInstance('s1', 's1-offer', ALICE);
  inst1.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst1) });
  const run1: CallRun = { inst: inst1, n: 1, runner: ALICE, cost: 0, links: new Map() };

  tokenMode = 'consent-once';
  holdPath = '/token';
  const req1 = sendProxy(run1, '/v1.0/me/sendMail', 'POST', '{"message":{}}');
  await entered.promise;

  const offerErr = addGraphOffer(ALICE, ALICE).then(() => null, e => e as Error);
  await new Promise(r => setImmediate(r));

  run1.stopped = true;
  holdPath = '';
  gate.resolve();

  const [err] = await Promise.all([offerErr, req1.done]);
  assert.equal(req1.res.statusCode, 409);
  assert.equal(sent.filter(s => s.path === '/token').length, 2);
  assert.equal(sent.some(s => s.path === '/v1.0/me/sendMail'), false);
  assert.equal(sent.filter(s => s.path.includes('/mailFolders/inbox')).length, 1);
  assert.equal(sent.find(s => s.path.includes('/mailFolders/inbox'))!.auth, 'Bearer synthetic-alice-2');
  assert.equal(err, null, `expected personal offer() to succeed, got: ${err?.message}`);
  assert.deepEqual(sent.filter(s => s.path === '/token').map(s => s.scope), [
    ['openid', 'email', 'offline_access', ...scope()].join(' '),
    'openid email offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  ]);
});

for (const result of ['ok', 'consent-once', 'expired'] as const) test(`all invalid waiters get their own refusal after an issued ${result} response`, { timeout: 5000 }, async () => {
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `all-${seq}`, scopes: ['Mail.Read'], offers: [] }, 'synthetic-refresh');
  const refusals = [401, 403, 409].map(status => new HttpError(status, `own refusal ${status}`));
  let invalid = false;
  holdPath = '/token';
  tokenMode = result;
  const pending = refusals.map(refusal => token(ALICE, 'm365', scope(), () => { if (invalid) throw refusal; }).then(value => value, e => e));
  await entered.promise;
  invalid = true;
  const before = sent.length;
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), refusals);
  assert.equal(sent.length, before, 'no fallback or Graph step after every waiter is invalid');
  assert.equal(sent.filter(s => s.path === '/token').length, 1);
  assert.equal(logins(ALICE)[0].expired, result === 'expired' ? true : undefined, 'only a real provider refusal expires the login');
  assert.equal(secret(ALICE, 'm365'), result === 'ok' ? `synthetic-rt-${sent.length}` : 'synthetic-refresh');
});

for (const result of ['ok', 'expired'] as const) test(`a later invalid waiter cannot receive a shared ${result} result or fail the valid initiator`, { timeout: 5000 }, async () => {
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `later-${seq}`, scopes: ['Mail.Read'], offers: [] }, 'synthetic-refresh');
  holdPath = '/token';
  tokenMode = result;
  const valid = token(ALICE, 'm365', scope(), () => {}).then(value => value, e => e);
  await entered.promise;
  let invalid = false;
  const refusal = new HttpError(403, 'later caller lost authority');
  const later = token(ALICE, 'm365', scope(), () => { if (invalid) throw refusal; }).then(value => value, e => e);
  invalid = true;
  gate.resolve();
  const [first, second] = await Promise.all([valid, later]);
  assert.equal(second, refusal);
  if (result === 'ok') assert.match(first, /^synthetic-alice-/);
  else assert.equal(first.status, 409);
  assert.equal(sent.filter(s => s.path === '/token').length, 1);
});

for (const status of [403, 404, 503]) test(`a genuine Graph parent ${status} is never cached across requests`, { timeout: 5000 }, async () => {
  const drive = `provider${seq}`, ticks = [`m365:item:${drive}/folder`];
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `provider-${seq}`, offers: ticks.map(id => ({ id, name: id })) }, 'synthetic-refresh');
  setConsent('s1', ALICE, 1, ticks);
  const inst = createInstance('s1', 'provider', ALICE);
  inst.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  const run = { inst, n: 1, runner: ALICE, cost: 0, links: new Map() };
  parentStatus = status;
  const first = sendProxy(run, `/v1.0/drives/${drive}/items/child`);
  await first.done;
  assert.equal(first.res.statusCode, status === 503 ? 502 : 403);
  parentStatus = 200;
  const second = sendProxy(run, `/v1.0/drives/${drive}/items/child`);
  await second.done;
  assert.equal(second.res.statusCode, 200);
  assert.equal(sent.filter(s => s.path.includes('/items/parent')).length, 2);
});

test('an unexpected checkpoint failure is not swallowed by another authorized waiter', { timeout: 5000 }, async () => {
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `unexpected-${seq}`, scopes: ['Mail.Read'], offers: [] }, 'synthetic-refresh');
  tokenMode = 'consent-once';
  holdPath = '/token';
  let broken = false;
  const error = new Error('unexpected checkpoint failure');
  const first = token(ALICE, 'm365', scope(), () => { if (broken) throw error; });
  await entered.promise;
  const second = token(ALICE, 'm365', scope(), () => {});
  const settled = Promise.allSettled([first, second]);
  broken = true;
  holdPath = '';
  gate.resolve();
  const results = await settled;
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason, error);
  assert.equal(sent.filter(s => s.path === '/token').length, 1, 'unexpected failure must not start a fallback renewal');
});
