import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';

// A run's browsers, from a stand-in browser service whose page changes only when the test says, and which keeps the states and
// headers it was given and the sessions it closed, lists those in `listed`, and answers a browser's state as `back` says and its
// tab as `shown` does.
let page = Buffer.from('page 1'), back: unknown = { cookies: [] }, listed: string[] = [], shown = { url: '', password: false };
const states: unknown[] = [], headers: unknown[] = [], deleted: string[] = [], starts: string[] = [];
const service = createServer(async (req, res) => {
  if (req.method === 'DELETE') {
    deleted.push(req.url!.split('/')[2]);
    return res.writeHead(200).end(JSON.stringify({ state: back, log: [{ method: 'GET' }] }));
  }
  if (req.method === 'POST') {
    const { state, site } = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    states.push(state);
    headers.push(site.headers);
    starts.push(`${site.start_url} ${site.hosts.join(',')}`);
    if (state?.cookies?.[0] === 'refused') return res.writeHead(500).end('{"error":"refused"}');
    return res.writeHead(201).end(JSON.stringify({ id: 'b9' }));
  }
  if (req.url === '/sessions') return res.writeHead(200).end(JSON.stringify(listed.map(id => ({ id }))));
  if (req.url === '/sessions/b9/page') return res.writeHead(200).end(JSON.stringify(shown));
  if (req.url === '/sessions/b9/log') return res.writeHead(200).end('[{"live":true}]');
  if (req.url!.startsWith('/sessions/b9/files/')) return res.writeHead(200).end(`file at ${req.url}`);
  res.writeHead(req.url === '/sessions/b1/screenshot' ? 200 : 404).end(page);
}).on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`));
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
Object.assign(process.env, { RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`, RF_BROWSER_IDLE_MS: '300' });
const { Browsers, endSignIn, keepAlive, reap, scoped, startSignIn } = await import('../src/browsers.ts');
const { serveAgent } = await import('../src/agent-api.ts');
const { logins, personDir, saveLogin, secret, signOut } = await import('../src/logins.ts');
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
  browsers.bySite.set('erp', { id: 'b1', email: 'alice@demo.test', since: '', writeback: true, file: 'browser/run 2 erp.jsonl', conns: 0 });
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
  browsers.bySite.set('erp', { id: 'b1', email: alice, since: '', writeback: true, file: 'browser/run 1 erp.jsonl', conns: 0 });
  await assert.rejects(browsers.expire('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp');
  assert.equal(logins(alice).find(l => l.id === 'web:erp')!.expired, true);
  assert.equal(browsers.bySite.size, 0);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.site, e.requests]), [['erp', 1]]);
  await assert.rejects(browsers.browser('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp', 'no browser opens in it until they sign in again');
});

test('an answer of the browser service that is no JSON, as a proxy in front of it may give, fails that call alone', async () => {
  const inst = createInstance('s', '2027-01', 'alice@demo.test', []), browsers = new Browsers(inst, 3);
  browsers.bySite.set('erp', { id: 'gone', email: 'alice@demo.test', since: '', writeback: true, file: 'browser/run 3 erp.jsonl', conns: 0 });
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

test("a website's header goes, with its person's value, to their sign-in's browser alone: sealed as they save the login, used again when they sign in again with none, replaced by a new one, and gone as they sign out", async () => {
  writeJson('connections.json', { rl: { type: 'website', title: 'Retail Link', url: 'https://rl.example.com/login', hosts: [], writeback: true, header: 'x-bot-token', updated_by: alice, updated_at: '' } });
  headers.length = 0;
  await assert.rejects(startSignIn(alice, 'rl', ''), /Retail Link needs your x-bot-token to sign in/);
  await assert.rejects(startSignIn(alice, 'rl', 'jwt\r\nx: 1'), /x-bot-token: letters, digits and punctuation/);
  await endSignIn(alice, await startSignIn(alice, 'rl', 'jwt-1\n'), false);
  await assert.rejects(startSignIn(alice, 'rl', ''), /needs your x-bot-token/, 'kept only with a saved login');
  await endSignIn(alice, await startSignIn(alice, 'rl', 'jwt-1'), true);
  await endSignIn(alice, await startSignIn(alice, 'rl', ''), false);
  const browsers = new Browsers(createInstance('s', '2027-12', alice, ['web:rl']), 1);
  await browsers.browser('rl');
  await browsers.close();
  assert.deepEqual(headers, [{ 'x-bot-token': 'jwt-1' }, { 'x-bot-token': 'jwt-1' }, { 'x-bot-token': 'jwt-1' }, undefined], "the sign-ins', never the run's browser");
  await endSignIn(alice, await startSignIn(alice, 'rl', 'jwt-2'), true);
  assert.equal(secret(alice, 'web:rl.header'), 'jwt-2');
  signOut(alice, 'web:rl');
  assert.ok(!existsSync(join(personDir(alice), 'web:rl.header.sealed')));
});

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

test("a website's keepalive loads its page every so often in office hours, in the browser of each person running an open instance with it ticked, its state the login again, until a sign-in shows, which marks the login expired", async () => {
  writeJson('connections.json', { pa: { type: 'website', title: 'PatriArch', url: 'https://pa.example.com/PatriArchMVC/Account/Login', hosts: ['sso.example.com'], writeback: true, keepalive: '/PatriArchMVC/', every: 10, hours: '08:00-19:00', updated_by: alice, updated_at: '' } });
  saveLogin(alice, website('pa', 'PatriArch'), '{"cookies":["signed in"]}');
  saveLogin('bob@demo.test', website('pa', 'PatriArch'), '{"cookies":["bob, running nothing"]}');
  createInstance('s', 'k1', alice, ['web:pa']);
  const monday = (h: number, m = 0) => new Date(2026, 10, 2, h, m), turns = () => starts.filter(s => s.startsWith('https://pa.example.com/PatriArchMVC/ ')).length;
  [starts.length, states.length, back, shown] = [0, 0, { cookies: ['kept alive'] }, { url: 'https://pa.example.com/PatriArchMVC/Home', password: false }];
  await keepAlive(monday(7, 59));
  assert.equal(turns(), 0, 'before office hours');
  await keepAlive(monday(8));
  assert.deepEqual([starts, states], [['https://pa.example.com/PatriArchMVC/ pa.example.com'], [{ cookies: ['signed in'] }]], "the page's host alone, in alice's browser, not bob's");
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), { cookies: ['kept alive'] });
  await keepAlive(monday(8, 9));
  await keepAlive(new Date(2026, 10, 7, 10));
  assert.equal(turns(), 1, 'every 10 minutes, on weekdays');
  const run = new Browsers(createInstance('s', 'k2', alice, ['web:pa']), 1);
  await run.browser('pa');
  await keepAlive(monday(8, 10));
  assert.equal(turns(), 1, "a run holds alice's browser there");
  await run.close();
  [shown, back] = [{ url: 'https://pa.example.com/PatriArchMVC/Account/Login', password: true }, { cookies: ['signed out'] }];
  await keepAlive(monday(8, 20));
  assert.equal(turns(), 2);
  assert.equal(logins(alice).find(l => l.id === 'web:pa')!.expired, true, 'a sign-in page: the login expired');
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), { cookies: ['kept alive'] }, 'and its state stays');
  await keepAlive(monday(8, 30));
  assert.equal(turns(), 2, 'nothing for an expired login');
});

test("a person's keepalive turn that fails leaves the others' to go on", async () => {
  writeJson('users.json', { [alice]: { role: 'admin' }, 'carol@demo.test': { role: 'user' } });
  saveTree({ ...tree(), workspaces: { w: { ...tree().workspaces.w, members: ['carol@demo.test'] } } });
  saveLogin('carol@demo.test', website('pa', 'PatriArch'), '{"cookies":["refused"]}');
  createInstance('s', 'k0', 'carol@demo.test', ['web:pa']);
  saveLogin(alice, website('pa', 'PatriArch'), '{"cookies":["signed in again"]}');
  [states.length, back, shown] = [0, { cookies: ['kept alive again'] }, { url: 'https://pa.example.com/PatriArchMVC/Home', password: false }];
  await keepAlive(new Date(2026, 10, 2, 9));
  assert.deepEqual(states, [{ cookies: ['refused'] }, { cookies: ['signed in again'] }], "carol's first, refused");
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), { cookies: ['kept alive again'] });
  writeJson('users.json', { [alice]: { role: 'admin' } });
  states.length = 0;
  await keepAlive(new Date(2026, 10, 2, 9, 10));
  assert.deepEqual(states, [{ cookies: ['kept alive again'] }], 'nor for carol, who can no longer run her instance');
});

test("a website that lists its people lets only them use it, admins no more than anyone: a run gets its browser only if its runner and all who took part in its instance are among them, and else goes on without it, logged once", async () => {
  const bob = 'bob@demo.test', treasury = '0b1c2d3e-0000-4000-8000-000000000001';
  writeJson('users.json', { [alice]: { role: 'admin' }, [bob]: { role: 'user', groups: [treasury] } });
  saveTree({ ...tree(), workspaces: { w: { ...tree().workspaces.w, members: [bob] } } });
  writeJson('connections.json', { bank: { type: 'website', title: 'Bank', url: 'https://bank.example.com', hosts: [], writeback: false, keepalive: '/home', every: 10, people: [treasury], updated_by: alice, updated_at: '' } });
  saveLogin(alice, website('bank', 'Bank'), '{"cookies":["alice"]}');
  saveLogin(bob, website('bank', 'Bank'), '{"cookies":["bob"]}');
  assert.ok(scoped('web:bank') && !scoped('m365:mail:x'), 'never lent through a shared series');
  await assert.rejects(new Browsers(createInstance('s', 'b1', alice, ['web:bank']), 1).browser('bank'), /Bank is only for the people its connection lists, and alice@demo.test, who runs this instance, is not among them/);
  await assert.rejects(startSignIn(alice, 'bank', ''), /Bank is only for the people its connection lists/);
  const his = createInstance('s', 'b2', bob, ['web:bank']), run = new Browsers(his, 1);
  assert.equal(await run.browser('bank'), 'b9', 'bob, by his Entra group');
  await run.close();
  his.append(alice, 'comment', { thread: 't1', text: 'Fetch the balance.' });
  const next = new Browsers(his, 2);
  for (const _ of [1, 2]) await assert.rejects(next.browser('bank'), /alice@demo.test, who took part in this instance, is not among them: this run goes on without it/);
  assert.deepEqual(his.log.filter(e => e.action === 'refused').map(e => e.run), [2], 'logged once');
  const woken = createInstance('s', 'b3', bob, ['web:bank']);
  woken.append('server', 'wake', { from: alice });
  await assert.rejects(new Browsers(woken, 1).browser('bank'), /alice@demo.test, who took part in this instance/, 'nor where she woke it');
  [states.length, shown] = [0, { url: 'https://bank.example.com/home', password: false }];
  await keepAlive(new Date(2026, 10, 2, 9));
  assert.deepEqual(states, [{ cookies: ['bob'] }], "kept alive for bob alone, though alice's instance ticks it too");
  writeJson('users.json', { [alice]: { role: 'admin' } });
});

test("as the server starts, the browsers a restart left open on the service close: a run's keeps its request log and hands its login back, as its run would have, and a sign-in's just goes", async () => {
  writeJson('connections.json', { crm: { type: 'website', title: 'CRM', url: 'https://crm.example.com', hosts: [], writeback: true, updated_by: alice, updated_at: '' } });
  saveLogin(alice, website('crm', 'CRM'), '{"cookies":["before"]}');
  const inst = createInstance('s', '2027-12b', alice, ['web:crm']), cut = new Browsers(inst, 4);
  await cut.browser('crm');
  clearTimeout(cut.bySite.get('crm')!.idle);
  [listed, back] = [['b9', 'signin'], { cookies: ['as it was cut'] }];
  deleted.length = 0;
  await reap();
  assert.deepEqual(deleted, ['b9', 'signin']);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.run, e.site, e.requests, e.writes, e.file]), [[4, 'crm', 1, 0, 'browser/run 4 crm.jsonl']]);
  assert.equal(readFileSync(join(inst.dir, 'browser/run 4 crm.jsonl'), 'utf8'), '{"method":"GET"}\n');
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: ['as it was cut'] });
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, '.rf', 'browsers.json'), 'utf8')), {}, 'nothing left to reap');
});
