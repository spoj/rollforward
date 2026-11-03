import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';

// A run's browsers, from a stand-in browser service whose page changes only when the test says, and which keeps the states it was
// given and answers a browser's state as `back` says.
let page = Buffer.from('page 1'), back: unknown = { cookies: [] };
const states: unknown[] = [];
const service = createServer(async (req, res) => {
  if (req.method === 'DELETE') return res.writeHead(200).end(JSON.stringify({ state: back, log: [{ method: 'GET' }] }));
  if (req.method === 'POST') {
    states.push(JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()).state);
    return res.writeHead(201).end(JSON.stringify({ id: 'b9' }));
  }
  if (req.url!.startsWith('/sessions/b9/files/')) return res.writeHead(200).end(`file at ${req.url}`);
  res.writeHead(req.url === '/sessions/b1/screenshot' ? 200 : 404).end(page);
}).on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`));
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
Object.assign(process.env, { RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`, RF_BROWSER_IDLE_MS: '300' });
const { Browsers } = await import('../src/browsers.ts');
const { serveAgent } = await import('../src/agent-api.ts');
const { logins, saveLogin, secret } = await import('../src/logins.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-shots-'));
initSystem(tmp);
openStore(tmp);
saveTree({ workspaces: { w: { name: 'Acme', owners: ['alice@demo.test'], members: [] } }, series: { s: { name: 'Portal pull', workspace: 'w' } } });
mkdirSync(join(tmp, 'series', 's'), { recursive: true });
writeJson('users.json', { 'alice@demo.test': { role: 'admin' } });

after(() => {
  service.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("after each tool call, each of the run's browsers is shot unless its page looks the same, kept read-only and logged", async () => {
  const inst = createInstance('s', '2026-11', 'alice@demo.test', []), browsers = new Browsers(inst, 2);
  browsers.bySite.set('erp', { id: 'b1', email: 'alice@demo.test', since: '', writeback: true, conns: 0 });
  await browsers.shoot();
  await browsers.shoot();
  page = Buffer.from('page 2');
  await browsers.shoot();
  const shots = inst.log.filter(e => e.op === 'shot');
  assert.deepEqual(shots.map(e => [e.by, e.run, e.site, e.file]), [['server', 2, 'erp', 'browser/run 2 erp 1.png'], ['server', 2, 'erp', 'browser/run 2 erp 2.png']]);
  assert.equal(readFileSync(join(inst.dir, 'browser/run 2 erp 2.png'), 'utf8'), 'page 2');
  assert.equal(statSync(join(inst.dir, 'browser/run 2 erp 1.png')).mode & 0o222, 0, 'the agent reads it but cannot change it');
});

test("the agent says a website signed it out: its runner's login is marked expired and its browser closes, keeping its request log", async () => {
  const alice = 'alice@demo.test', erp = { id: 'web:erp', kind: 'website' as const, name: 'ERP', since: '', offers: [{ id: 'web:erp', name: 'ERP' }] };
  saveLogin(alice, erp, '{}');
  const inst = createInstance('s', '2026-12', alice, ['web:erp']), browsers = new Browsers(inst, 1);
  browsers.bySite.set('erp', { id: 'b1', email: alice, since: '', writeback: true, conns: 0 });
  await assert.rejects(browsers.expire('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp');
  assert.equal(logins(alice).find(l => l.id === 'web:erp')!.expired, true);
  assert.equal(browsers.bySite.size, 0);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.site, e.requests]), [['erp', 1]]);
  await assert.rejects(browsers.browser('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp', 'no browser opens in it until they sign in again');
});

test('an answer of the browser service that is no JSON, as a proxy in front of it may give, fails that call alone', async () => {
  const inst = createInstance('s', '2027-01', 'alice@demo.test', []), browsers = new Browsers(inst, 3);
  browsers.bySite.set('erp', { id: 'gone', email: 'alice@demo.test', since: '', writeback: true, conns: 0 });
  await assert.rejects(browsers.shoot(), (e: { status: number; message: string }) => e.status === 502 && e.message.startsWith('browser service: 404 page'));
});

test("closing a run's browser hands its login back refreshed, unless its person signed in to it anew since it opened", async () => {
  const alice = 'alice@demo.test', crm = (since: string) => ({ id: 'web:crm', kind: 'website' as const, name: 'CRM', since, offers: [{ id: 'web:crm', name: 'CRM' }] });
  writeJson('connections.json', { crm: { type: 'website', title: 'CRM', url: 'https://crm.example.com', hosts: [], writeback: true, updated_by: alice, updated_at: '' } });
  saveLogin(alice, crm('t1'), '{"cookies":["old"]}');
  const browsers = new Browsers(createInstance('s', '2027-02', alice, ['web:crm']), 1);
  await browsers.browser('crm');
  await browsers.close();
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: [] }, 'refreshed from the browser');
  await browsers.browser('crm');
  saveLogin(alice, crm('t2'), '{"cookies":["fresh"]}');
  await browsers.close();
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: ['fresh'] }, 'the sign-in since the browser opened stays');
});

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
const alice = 'alice@demo.test', website = (id: string, name: string) => ({ id: `web:${id}`, kind: 'website' as const, name, since: 't1', offers: [{ id: `web:${id}`, name }] });

test("a person has one browser at a time on a website that writes its state back: another run waits, logged, and opens from the state handed back; elsewhere runs open at once from the saved login, which stays", async () => {
  writeJson('connections.json', {
    crm: { type: 'website', title: 'CRM', url: 'https://crm.example.com', hosts: [], writeback: true, updated_by: alice, updated_at: '' },
    ledger: { type: 'website', title: 'Ledger', url: 'https://ledger.example.com', hosts: [], writeback: false, updated_by: alice, updated_at: '' },
  });
  saveLogin(alice, website('crm', 'CRM'), '{"cookies":["seed"]}');
  saveLogin(alice, website('ledger', 'Ledger'), '{"cookies":["seed"]}');
  const one = new Browsers(createInstance('s', '2027-03', alice, ['web:crm', 'web:ledger']), 1), two = new Browsers(createInstance('s', '2027-04', alice, ['web:crm', 'web:ledger']), 1);
  states.length = 0;
  back = { cookies: ['handed back'] };
  await one.browser('crm');
  let opened = false;
  const waiting = two.browser('crm').then(() => (opened = true));
  await sleep(50);
  assert.equal(opened, false, 'the second run waits');
  assert.deepEqual(two.inst.log.filter(e => e.action === 'wait').map(e => [e.site, e.login, e.held]), [['crm', alice, 'Portal pull/2027-03']]);
  await one.close();
  await waiting;
  assert.deepEqual(states, [{ cookies: ['seed'] }, { cookies: ['handed back'] }], 'and opens from the state the first handed back');
  await two.close();

  states.length = 0;
  back = { cookies: ['never kept'] };
  await Promise.all([one.browser('ledger'), two.browser('ledger')]);
  await Promise.all([one.close(), two.close()]);
  assert.deepEqual(states, [{ cookies: ['seed'] }, { cookies: ['seed'] }]);
  assert.deepEqual(JSON.parse(secret(alice, 'web:ledger')), { cookies: ['seed'] }, 'nothing comes back');
});

test("a browser that writes its state back is released once no connection has been open for a while, handing its login back, and a waiting connection that goes away stops waiting", async () => {
  const one = new Browsers(createInstance('s', '2027-05', alice, ['web:crm']), 1), two = new Browsers(createInstance('s', '2027-06', alice, ['web:crm']), 1);
  back = { cookies: ['after a while'] };
  await one.browser('crm');
  const conn = new PassThrough();
  one.connected('crm', conn);
  const gone = new PassThrough(), waiting = two.browser('crm', gone);
  gone.destroy();
  assert.equal(await waiting, undefined);
  await sleep(500);
  assert.equal(one.bySite.size, 1, 'held while a connection is open');
  conn.destroy();
  await sleep(500);
  assert.equal(one.bySite.size, 0);
  assert.deepEqual(one.inst.log.filter(e => e.op === 'browser').map(e => e.file), ['browser/run 1 crm.jsonl']);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: ['after a while'] });
  await one.browser('crm');
  await one.close();
  assert.deepEqual(one.inst.log.filter(e => e.op === 'browser').map(e => e.file), ['browser/run 1 crm.jsonl', 'browser/run 1 crm 2.jsonl'], 'a browser opened again keeps its own log');
  assert.equal(two.bySite.size, 0, 'nothing opened for the connection that went');
});

test("$RF_BROWSERS/NAME is the run's browser there: its CDP discovery, its websocket, opening the browser at the first connection, and its machine's files, each fetch logged", async () => {
  const inst = createInstance('s', '2027-07', alice, ['web:crm']), api = await serveAgent(inst), base = `${api.url}/browsers/${api.token}`;
  assert.deepEqual(await (await fetch(`${base}/crm/json/version/`)).json(), { webSocketDebuggerUrl: `${base.replace('http', 'ws')}/crm` });
  assert.match(await (await fetch(`${base}/erp/json/version`)).text(), /web:erp is not ticked/);
  assert.equal((await fetch(`${base}/crm/downloads/tmp/x.csv`)).status, 409, 'no browser before a connection');
  const raw = connect(Number(new URL(api.url).port), '127.0.0.1');
  raw.end(`GET /browsers/${api.token}/crm HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n`);
  assert.match(Buffer.concat(await Array.fromAsync(raw)).toString(), /service got \/sessions\/b9\/cdp$/);
  const got = await fetch(`${base}/crm/downloads/tmp/playwright-artifacts-x/1a2b`);
  assert.equal(await got.text(), 'file at /sessions/b9/files/tmp/playwright-artifacts-x/1a2b');
  assert.match(await (await fetch(`${base}/crm/downloads/tmp%5C..%5C..%5Csessions`)).text(), /a path without \. or \.\. in it/);
  assert.deepEqual(inst.log.filter(e => e.op === 'call').map(e => [e.by, e.run, e.name, e.method, e.path, e.status, e.bytes]), [
    ['agent', 0, 'crm', 'GET', '/downloads/tmp/x.csv', 409, 0], ['agent', 0, 'crm', 'GET', '/downloads/tmp/playwright-artifacts-x/1a2b', 200, 58], ['agent', 0, 'crm', 'GET', '/downloads/tmp\\..\\..\\sessions', 400, 0],
  ]);
  await api.close();
});

test("a browser refused for its runner's expired login is logged as expired, so the instance carries on once they sign in again", async () => {
  writeJson('connections.json', { crm: { type: 'website', title: 'CRM', url: 'https://crm.example.com', hosts: [], writeback: true, updated_by: alice, updated_at: '' } });
  saveLogin(alice, { ...website('crm', 'CRM'), expired: true }, '{}');
  const inst = createInstance('s', '2027-08', alice, ['web:crm']), browsers = new Browsers(inst, 1);
  await assert.rejects(browsers.browser('crm'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:crm');
  assert.deepEqual(inst.log.filter(e => e.op === 'expired').map(e => [e.login, e.name, e.runner]), [['web:crm', 'CRM', alice]]);
  saveLogin(alice, website('crm', 'CRM'), '{}');
});

test("a run that ended while its connection waited for its person's browser opens none, and holds nothing, once the browser is released", async () => {
  const one = new Browsers(createInstance('s', '2027-09', alice, ['web:crm']), 1), two = new Browsers(createInstance('s', '2027-10', alice, ['web:crm']), 1);
  states.length = 0;
  await one.browser('crm');
  const waiting = two.browser('crm', new PassThrough());
  await sleep(50);
  await two.end();
  await one.close();
  assert.equal(await waiting, undefined);
  assert.equal(states.length, 1, 'no browser opened for the run that ended');
  const three = new Browsers(createInstance('s', '2027-11', alice, ['web:crm']), 1);
  assert.equal(await Promise.race([three.browser('crm'), sleep(200).then(() => 'still held')]), 'b9', "the person's browser there is free");
  await three.close();
});
