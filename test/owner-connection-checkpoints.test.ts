import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { createInstance, openStore } from '../src/store.ts';
import { saveSeriesSettings } from '../src/series.ts';

const ALICE = 'alice@synthetic.test', BOB = 'bob@synthetic.test';
const sent: { path: string; auth?: string; refresh?: string }[] = [];
let hold = '', tokenStatus = 'ok', gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
const upstream = createServer(async (req, res) => {
  const path = req.url!, u = new URL(path, 'http://local');
  const raw = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString();
  const send = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  sent.push({ path, auth: req.headers.authorization, ...(u.pathname === '/token' && { refresh: new URLSearchParams(raw).get('refresh_token')! }) });
  if (path === hold.replaceAll('source', `source${sequence}`).replaceAll('links', `links${sequence}`)) { entered.resolve(); await gate.promise; }
  if (u.pathname === '/.well-known/openid-configuration') return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
  if (u.pathname === '/token') {
    if (tokenStatus !== 'ok') {
      const consent = tokenStatus.startsWith('consent');
      if (tokenStatus === 'consent-once') tokenStatus = 'ok';
      return send({ error: 'invalid_grant', suberror: consent ? 'consent_required' : '', error_description: 'synthetic refusal' }, 400);
    }
    return send({ access_token: 'synthetic-alice', refresh_token: 'synthetic-rotated', expires_in: 3600 });
  }
  if (u.pathname === '/v1.0/me/sendMail') return void res.writeHead(202).end();
  if (u.pathname.endsWith('/root:/missing:')) return send({ error: { code: 'notFound' } }, 404);
  if (u.searchParams.get('$select') === 'sharePointIds') return send({ sharePointIds: { siteUrl: 'https://sp.synthetic.test/sites/s', siteId: 's', webId: 'w' } });
  if (u.pathname === `/v1.0/drives/source${sequence}/items/child` && !u.search) return send({ id: 'download', parentReference: { driveId: `links${sequence}`, id: 'parent' }, '@microsoft.graph.downloadUrl': 'https://sp.synthetic.test/download' });
  if (u.pathname.endsWith('/parent')) return send({ id: 'parent', parentReference: { driveId: u.pathname.split('/')[3], id: 'folder' } });
  return send({ id: u.pathname.split('/').at(-1), parentReference: { driveId: u.pathname.split('/')[3], id: 'parent' } });
});
await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
Object.assign(process.env, { RF_OIDC_ISSUER: base, RF_OIDC_CLIENT_ID: 'synthetic', RF_OIDC_CLIENT_SECRET: 'synthetic', RF_PUBLIC_URL: 'https://rf.synthetic.test', RF_M365_SCOPES: 'Mail.Read Mail.Send Files.Read.All Files.ReadWrite.All Sites.Read.All' });
const { authority, logins, saveLogin, unoffer } = await import('../src/logins.ts');
const { call, upstreams } = await import('../src/connections.ts');
const { endpoints } = await import('../src/connections/graph.ts');
endpoints.graph = upstreams['graph.microsoft.com'] = base;
let root: string, run: import('../src/connections.ts').CallRun, sequence = 0;
let ticks: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rf-connection-checkpoints-'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Synthetic', owners: [ALICE], members: [BOB] } }, series: { s: { name: 'Synthetic', workspace: 'w' } } });
  writeJson('users.json', { [ALICE]: { role: 'user' }, [BOB]: { role: 'user' } });
  writeJson('capabilities.json', { 'series-owner': [ALICE, BOB] });
  writeJson('connections.json', { m365: { type: 'graph' } });
  sequence++;
  ticks = [`m365:item:source${sequence}/folder`, `m365:item:links${sequence}/folder`, `m365:mail:${ALICE}`];
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `login-${sequence}`, scopes: ['Mail.Read'], offers: ticks.map(id => ({ id, name: id })) }, 'synthetic-alice-refresh');
  consent();
  const inst = createInstance('s', 'instance', BOB);
  inst.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  run = { inst, n: 1, runner: ALICE, cost: 0, links: new Map() };
  sent.length = 0;
  hold = '';
  tokenStatus = 'ok';
  gate = Promise.withResolvers<void>();
  entered = Promise.withResolvers<void>();
});
afterEach(() => { gate.resolve(); rmSync(root, { recursive: true, force: true }); });
after(() => upstream.close());

function consent(owner = ALICE, epoch = 1, logins = ticks) {
  saveSeriesSettings(join(root, 'series/s'), { version: 1, owner, epoch, since: '', consent: { by: owner, at: '', workspace: 'w', logins, autonomous: false } });
}
function revoke(mode: string) {
  if (mode === 'stop') run.stopped = true;
  if (mode === 'transfer') consent(BOB, 2);
  if (mode === 'consent') consent(ALICE, 2, []);
  if (mode === 'unoffer') unoffer(ALICE, 'm365', ticks[0]);
}
function request(path: string, method = 'GET', body: AsyncIterable<Buffer> = (async function* () {})()) {
  const req = Object.assign(Readable.from(body), { url: path.replaceAll('source', `source${sequence}`).replaceAll('links', `links${sequence}`), method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
  const res = Object.assign(new PassThrough(), { statusCode: 0, writeHead(status: number) { this.statusCode = status; return this; } });
  const chunks: Buffer[] = [];
  res.on('data', b => chunks.push(b));
  const done = call(run, 'graph.microsoft.com', req as IncomingMessage, res as unknown as ServerResponse);
  return { done, res, chunks };
}

test('revocation during OIDC discovery prevents the token request', { timeout: 5000 }, async () => {
  hold = '/.well-known/openid-configuration';
  const pending = request('/v1.0/me/sendMail', 'POST', (async function* () { yield Buffer.from('{"message":{}}'); })());
  await entered.promise;
  revoke('stop');
  const before = sent.length;
  gate.resolve();
  await pending.done;
  assert.equal(sent.length, before);
  assert.equal(run.inst.log.some(e => e.op === 'expired' || e.op === 'send'), false);
});

for (const mode of ['stop', 'transfer', 'consent', 'unoffer']) {
  test(`a body finishing after ${mode} starts no policy or token request`, { timeout: 5000 }, async () => {
    const reading = Promise.withResolvers<void>();
    const pending = request('/v1.0/drives/source/items/child', 'PATCH', (async function* () { yield Buffer.from('{"name":'); reading.resolve(); await gate.promise; yield Buffer.from('"new"}'); })());
    await reading.promise;
    revoke(mode);
    gate.resolve();
    await pending.done;
    assert.deepEqual(sent, []);
    assert.equal(pending.res.statusCode, mode === 'stop' ? 409 : 403);
    assert.equal(run.inst.log.some(e => e.op === 'expired' || e.op === 'send'), false);
  });

  test(`an issued token refusal after ${mode} adds no late expired entry`, { timeout: 5000 }, async () => {
    hold = '/token'; tokenStatus = 'expired';
    const pending = request('/v1.0/me/sendMail', 'POST', (async function* () { yield Buffer.from('{"message":{}}'); })());
    await entered.promise;
    revoke(mode);
    const before = sent.length;
    gate.resolve();
    await pending.done;
    assert.equal(sent.length, before);
    assert.equal(run.inst.log.some(e => e.op === 'expired' || e.op === 'send'), false);
  });
}

for (const path of [
  '/v1.0/drives/source/items/child?$select=id,parentReference',
  '/v1.0/drives/source/items/parent?$select=parentReference',
  '/v1.0/drives/source?$select=sharePointIds',
]) {
  test(`mid-policy transfer after ${path} prevents the next request`, { timeout: 5000 }, async () => {
    hold = path;
    const pending = request('/v1.0/drives/source/items/child', 'PATCH', (async function* () { yield Buffer.from('{"parentReference":{"driveId":"destination","id":"folder"}}'); })());
    await entered.promise;
    revoke('transfer');
    const before = sent.length;
    gate.resolve();
    await pending.done;
    assert.equal(sent.length, before);
    assert.equal(pending.res.statusCode, 403);
    assert.equal(run.inst.log.some(e => e.op === 'expired' || e.op === 'send'), false);
  });
}

test('a missing Graph path cannot retry its parent after authority loss', { timeout: 5000 }, async () => {
  hold = '/v1.0/drives/source/root:/missing:?$select=id,parentReference';
  const pending = request('/v1.0/drives/source/root:/missing:/children');
  await entered.promise;
  revoke('transfer');
  const before = sent.length;
  gate.resolve();
  await pending.done;
  assert.equal(sent.length, before);
  assert.equal(pending.res.statusCode, 403);
});

for (const path of ['/v1.0/me/sendMail', '/v1.0/drives/source/items/child']) {
  test(`successful token renewal after stop starts no request for ${path}`, { timeout: 5000 }, async () => {
    hold = '/token';
    const pending = request(path, path.endsWith('sendMail') ? 'POST' : 'GET', (async function* () { yield Buffer.from('{"message":{}}'); })());
    await entered.promise;
    revoke('stop');
    const before = sent.length;
    gate.resolve();
    await pending.done;
    assert.equal(sent.length, before);
    assert.equal(pending.res.statusCode, 409);
    assert.equal(run.inst.log.some(e => e.op === 'send' || e.op === 'expired'), false);
  });
}

test('consent fallback renewal cannot start after authority loss', { timeout: 5000 }, async () => {
  hold = '/token'; tokenStatus = 'consent';
  const pending = request('/v1.0/me/sendMail', 'POST', (async function* () { yield Buffer.from('{"message":{}}'); })());
  await entered.promise;
  revoke('transfer');
  const before = sent.length;
  gate.resolve();
  await pending.done;
  assert.equal(sent.length, before);
  assert.equal(run.inst.log.some(e => e.op === 'expired'), false);
});

for (const stage of ['response', 'links']) {
  test(`transfer during issued Graph ${stage} preserves response and call without follow-up metadata`, { timeout: 5000 }, async () => {
    hold = stage === 'response' ? '/v1.0/drives/source/items/child' : '/v1.0/drives/links?$select=sharePointIds';
    const pending = request('/v1.0/drives/source/items/child');
    await entered.promise;
    revoke('transfer');
    const before = sent.length;
    gate.resolve();
    await pending.done;
    assert.equal(sent.length, before);
    assert.equal(pending.res.statusCode, 200);
    assert.equal(JSON.parse(Buffer.concat(pending.chunks).toString()).id, 'download');
    const calls = run.inst.log.filter(e => e.op === 'call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 200);
    assert.equal(calls[0].run, 1);
    assert.equal(calls[0].bytes, Buffer.concat(pending.chunks).length);
    assert.equal(run.links.size, 0);
    assert.equal(run.inst.log.find(e => e.op === 'run')!.runner, ALICE);
  });
}

test('authorized consent-fallback renewal still sends as the captured owner', { timeout: 5000 }, async () => {
  tokenStatus = 'consent-once';
  const pending = request('/v1.0/me/sendMail', 'POST', (async function* () { yield Buffer.from('{"message":{}}'); })());
  await pending.done;
  assert.equal(pending.res.statusCode, 202);
  assert.equal(sent.filter(s => s.path === '/token').length, 2);
  assert.equal(sent.at(-1)!.auth, 'Bearer synthetic-alice');
  assert.deepEqual(run.inst.log.filter(e => e.op === 'send' || e.op === 'call').map(e => [e.op, e.run]), [['send', 1], ['call', 1]]);
});

test('an authorized renewal refusal still records expiry for the captured owner', { timeout: 5000 }, async () => {
  tokenStatus = 'expired';
  const pending = request('/v1.0/me/sendMail', 'POST', (async function* () { yield Buffer.from('{"message":{}}'); })());
  await pending.done;
  assert.equal(pending.res.statusCode, 409);
  const expired = run.inst.log.filter(e => e.op === 'expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].runner, ALICE);
  assert.equal(expired[0].run, 1);
});

test('authorized Graph policy, links and renewal retain the original owner authentication', { timeout: 5000 }, async () => {
  const pending = request('/v1.0/drives/source/items/child');
  await pending.done;
  assert.equal(pending.res.statusCode, 200);
  assert.deepEqual([...run.links], [['https://sp.synthetic.test/download', { name: 'm365', offer: ticks[0] }]]);
  assert.equal(sent.filter(s => s.path === '/token').length, 1);
  assert.equal(sent.find(s => s.path === '/token')!.refresh, 'synthetic-alice-refresh');
  assert.ok(sent.filter(s => s.path.startsWith('/v1.0')).every(s => s.auth === 'Bearer synthetic-alice'));
  assert.equal(run.cost, 0);
  assert.equal(run.inst.log.find(e => e.op === 'call')!.status, 200);
});

for (const selection of ['folder', 'site']) test(`a cancelled ${selection} lookup cannot cache absence for a fresh lease`, { timeout: 5000 }, async () => {
  if (selection === 'site') {
    ticks = ['m365:site:sp.synthetic.test,s,w'];
    saveLogin(ALICE, { ...logins(ALICE).find(l => l.id === 'm365')!, offers: ticks.map(id => ({ id, name: id })) });
    consent();
  }
  run.inst.append('server', 'run', { run: 2, runner: ALICE, initiator: ALICE, authority: authority(run.inst) });
  run = { ...run, n: 2, links: new Map() };
  hold = '/v1.0/drives/source/items/child?$select=id,parentReference';
  const pending = request('/v1.0/drives/source/items/child');
  await entered.promise;
  revoke('transfer');
  gate.resolve();
  await pending.done;
  assert.equal(pending.res.statusCode, 403);
  consent(ALICE, 3);
  run.inst.append('server', 'run', { run: 3, runner: ALICE, initiator: ALICE, authority: authority(run.inst) });
  run = { ...run, n: 3, links: new Map() };
  const fresh = request('/v1.0/drives/source/items/child');
  await fresh.done;
  assert.equal(fresh.res.statusCode, 200, Buffer.concat(fresh.chunks).toString());
});
