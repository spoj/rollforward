import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';

// An instance as its run n started, with the logins `by` ticked making it.
const running = (label: string, logins: string[], n = 1, by = 'alice@demo.test') => {
  const inst = createInstance('s', label, by, logins);
  inst.append('server', 'run', { run: n, runner: by, consent: 1 });
  return inst;
};
import { changes, initSystem, rfDir, saveTree, tree, writeJson } from '../src/system.ts';

// A run's browsers, from a stand-in browser service whose page changes only when the test says, and which keeps the states and
// headers it was given and the sessions it closed, lists those in `listed`, and answers a browser's state as `back` says and its
// tab as `shown` does, and its request log as `requested`.
let page = Buffer.from('page 1'), back: unknown = { cookies: [] }, listed: string[] = [], shown = { url: '', password: false };
const plain = [{ method: 'GET', url: 'https://crm.example.com/', status: 200 }];
let requested: object[] = plain;
const states: unknown[] = [], headers: unknown[] = [], deleted: string[] = [], starts: string[] = [];
const service = createServer(async (req, res) => {
  if (req.method === 'DELETE') {
    deleted.push(req.url!.split('/')[2]);
    return res.writeHead(200).end(JSON.stringify({ state: back, log: requested }));
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
const { Browsers, endSignIn, keepAlive, reap, removeSite, startSignIn, websitesOf } = await import('../src/browsers.ts');
const { upstreams } = await import('../src/connections.ts');
const { ask, decide, grants, lapse, revoke } = await import('../src/grants.ts');
// The server's model checks no website here.
delete process.env.OPENROUTER_API_KEY;
const { asPerson } = await import('../src/auth.ts');
const { serveAgent } = await import('../src/agent-api.ts');
const { logins, personDir, saveLogin, secret, signOut } = await import('../src/logins.ts');
// The websites of everyone the tests run as, alike, as each would have added them.
const sites = (all: Record<string, object>) => {
  for (const email of ['alice@demo.test', 'bob@demo.test', 'carol@demo.test']) {
    mkdirSync(personDir(email), { recursive: true });
    writeFileSync(join(personDir(email), 'websites.json'), JSON.stringify(all));
  }
};
const tmp = mkdtempSync(join(tmpdir(), 'rf-shots-'));
initSystem(tmp);
openStore(tmp);
saveTree({ workspaces: { w: { name: 'Acme', owners: ['alice@demo.test'], members: [] } }, series: { s: { name: 'Portal pull', workspace: 'w' } } });
mkdirSync(join(tmp, 'series', 's'), { recursive: true });
writeJson('users.json', { 'alice@demo.test': { role: 'admin' } });
// Everyone the tests run as has an approved grant to each website they use, in Acme (grants.ts), but where a test says otherwise.
const everyone = Object.fromEntries(['alice@demo.test', 'bob@demo.test', 'carol@demo.test'].flatMap(p => ['crm', 'ledger', 'rl', 'pa', 'erp'].map(s => [`${p} ${s}`, { workspace: 'w', person: p, site: s, reason: 'tests', at: '', state: 'approved' }])));
writeJson('grants.json', everyone);

after(() => {
  service.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("after each tool call, each of the run's browsers is shot unless its page looks the same, kept read-only and logged", async () => {
  const inst = running('2026-11', [], 2), browsers = new Browsers(inst, 2);
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
  sites({ erp: { url: 'https://erp.example.com', hosts: [], writeback: true } });
  saveLogin(alice, erp, '{}');
  const inst = running('2026-12', ['web:erp']), browsers = new Browsers(inst, 1);
  browsers.bySite.set('erp', { id: 'b1', email: alice, since: '', writeback: true, file: 'browser/run 1 erp.jsonl', conns: 0 });
  await assert.rejects(browsers.expire('erp'), (e: { status: number }) => e.status === 409);
  assert.equal(logins(alice).find(l => l.id === 'web:erp')!.expired, true);
  assert.deepEqual(inst.log.filter(e => e.op === 'expired').map(e => [e.by, e.run, e.login, e.name, e.runner]), [['server', 1, 'web:erp', 'erp', alice]], 'logged, so the instance carries on once they sign in again');
  assert.equal(browsers.bySite.size, 0);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.site, e.requests]), [['erp', 1]]);
  await assert.rejects(browsers.browser('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp', 'no browser opens in it until they sign in again');
});

test('an answer of the browser service that is no JSON, as a proxy in front of it may give, fails that call alone', async () => {
  const inst = running('2027-01', [], 3), browsers = new Browsers(inst, 3);
  browsers.bySite.set('erp', { id: 'gone', email: 'alice@demo.test', since: '', writeback: true, file: 'browser/run 3 erp.jsonl', conns: 0 });
  await assert.rejects(browsers.shoot(), (e: { status: number; message: string }) => e.status === 502 && e.message.startsWith('browser service: 404 page'));
});

test("closing a run's browser hands its login back refreshed, unless its person signed in to it anew since it opened", async () => {
  const alice = 'alice@demo.test', crm = (since: string) => ({ id: 'web:crm', kind: 'website' as const, name: 'CRM', since, offers: [{ id: 'web:crm', name: 'CRM' }] });
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, crm('t1'), '{"cookies":["old"]}');
  const browsers = new Browsers(running('2027-02', ['web:crm']), 1);
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
  sites({ rl: { url: 'https://rl.example.com/login', hosts: [], writeback: true, header: 'x-bot-token' } });
  headers.length = 0;
  await assert.rejects(startSignIn(alice, 'rl', ''), /rl needs your x-bot-token to sign in/);
  await assert.rejects(startSignIn(alice, 'rl', 'jwt\r\nx: 1'), /x-bot-token: letters, digits and punctuation/);
  await endSignIn(alice, await startSignIn(alice, 'rl', 'jwt-1\n'), false);
  await assert.rejects(startSignIn(alice, 'rl', ''), /needs your x-bot-token/, 'kept only with a saved login');
  await endSignIn(alice, await startSignIn(alice, 'rl', 'jwt-1'), true);
  await endSignIn(alice, await startSignIn(alice, 'rl', ''), false);
  const browsers = new Browsers(running('2027-12', ['web:rl']), 1);
  await browsers.browser('rl');
  await browsers.close();
  assert.deepEqual(headers, [{ 'x-bot-token': 'jwt-1' }, { 'x-bot-token': 'jwt-1' }, { 'x-bot-token': 'jwt-1' }, undefined], "the sign-ins', never the run's browser");
  await endSignIn(alice, await startSignIn(alice, 'rl', 'jwt-2'), true);
  assert.equal(secret(alice, 'web:rl.header'), 'jwt-2');
  signOut(alice, 'web:rl');
  assert.ok(!existsSync(join(personDir(alice), 'web:rl.header.sealed')));
});

test("a sign-in that ends, saved or not, leaves a line in the server's output of what its browser did, its addresses as their hosts alone", async t => {
  sites({ pa: { url: 'https://pa.example.com/', hosts: ['sso.example.com'], writeback: true } });
  const said = t.mock.method(console, 'log', () => {});
  requested = [
    { method: 'GET', url: 'https://pa.example.com/?code=secret', status: 302 },
    { method: 'GET', url: 'https://sso.example.com/login?token=secret', status: 200 },
    { method: 'POST', url: 'https://sso.example.com/login', status: 401 },
    { method: 'GET', url: 'https://cdn.example.com/app.js', status: 403, blocked: 'host not on the list' },
    { method: 'GET', url: 'https://cdn.example.com/app.css', status: 403, blocked: 'host not on the list' },
    { method: 'GET', url: 'https://pa.example.com/home?code=secret', status: 502, error: 'socket hang up' },
    { method: 'GET', url: 'https://sso.example.com/magic/secret;jsessionid=secret', status: 404 },
  ];
  await endSignIn(alice, await startSignIn(alice, 'pa', ''), false);
  requested = plain;
  await endSignIn(alice, await startSignIn(alice, 'pa', ''), true);
  const lines = said.mock.calls.map(c => String(c.arguments[0]));
  assert.equal(lines[0], `sign-in ended ${JSON.stringify({
    id: 'b9', site: 'pa', email: alice, saved: false, seconds: 0, requests: { 'pa.example.com': { 302: 1, 502: 1 }, 'sso.example.com': { 200: 1, 401: 1, 404: 1 } },
    blocked: { count: 2, hosts: ['cdn.example.com'] }, failed: ['POST sso.example.com 401', 'GET pa.example.com 502 socket hang up', 'GET sso.example.com 404'],
  })}`);
  assert.match(lines[1], /^sign-in ended \{"id":"b9","site":"pa","email":"alice@demo.test","saved":true,/);
  assert.equal(lines.length, 2);
});

test("a person has one browser at a time on a website that writes its state back: another run waits, logged, and opens from the state handed back; elsewhere runs open at once from the saved login, which stays", async () => {
  sites({
    crm: { url: 'https://crm.example.com', hosts: [], writeback: true },
    ledger: { url: 'https://ledger.example.com', hosts: [], writeback: false },
  });
  saveLogin(alice, website('crm', 'CRM'), '{"cookies":["seed"]}');
  saveLogin(alice, website('ledger', 'Ledger'), '{"cookies":["seed"]}');
  const one = new Browsers(running('2027-03', ['web:crm', 'web:ledger']), 1), two = new Browsers(running('2027-04', ['web:crm', 'web:ledger']), 1);
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
  const one = new Browsers(running('2027-05', ['web:crm']), 1), two = new Browsers(running('2027-06', ['web:crm']), 1);
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
  const inst = running('2027-07', ['web:crm'], 0), api = await serveAgent(inst), base = `${api.url}/browsers/${api.token}`;
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

test("$RF_BROWSERS/print is the run's own print browser, a name no website takes: no login, website, host or state, opened for a connection and closed with its last, logged as the others are", async () => {
  const { addSite } = await import('../src/browsers.ts');
  await assert.rejects(addSite(alice, 'print', 'https://print.example.com'), /not print, the runs' own print browser/);
  const inst = running('print', [], 0), api = await serveAgent(inst), base = `${api.url}/browsers/${api.token}`, opened = starts.length;
  assert.deepEqual(await (await fetch(`${base}/print/json/version`)).json(), { webSocketDebuggerUrl: `${base.replace('http', 'ws')}/print` });
  const raw = connect(Number(new URL(api.url).port), '127.0.0.1');
  raw.end(`GET /browsers/${api.token}/print HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n`);
  assert.match(Buffer.concat(await Array.fromAsync(raw)).toString(), /service got \/sessions\/b9\/cdp$/);
  assert.deepEqual([starts.slice(opened), states.at(-1)], [['undefined '], undefined]);
  for (let i = 0; i < 100 && !inst.log.some(e => e.op === 'browser'); i++) await new Promise(ok => setTimeout(ok, 20));
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.by, e.site, e.login, e.file]), [['server', 'print', undefined, 'browser/run 0 print.jsonl']]);
  await api.close();
});

test("a browser refused for its runner's expired login is logged as expired, so the instance carries on once they sign in again", async () => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, { ...website('crm', 'CRM'), expired: true }, '{}');
  const inst = running('2027-08', ['web:crm']), browsers = new Browsers(inst, 1);
  await assert.rejects(browsers.browser('crm'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:crm');
  assert.deepEqual(inst.log.filter(e => e.op === 'expired').map(e => [e.login, e.name, e.runner]), [['web:crm', 'crm', alice]]);
  saveLogin(alice, website('crm', 'CRM'), '{}');
});

test("a run that ended while its connection waited for its person's browser opens none, and holds nothing, once the browser is released", async () => {
  const one = new Browsers(running('2027-09', ['web:crm']), 1), two = new Browsers(running('2027-10', ['web:crm']), 1);
  states.length = 0;
  await one.browser('crm');
  const waiting = two.browser('crm', new PassThrough());
  await sleep(50);
  await two.end();
  await one.close();
  assert.equal(await waiting, undefined);
  assert.equal(states.length, 1, 'no browser opened for the run that ended');
  const three = new Browsers(running('2027-11', ['web:crm']), 1);
  assert.equal(await Promise.race([three.browser('crm'), sleep(200).then(() => 'still held')]), 'b9', "the person's browser there is free");
  await three.close();
});

test("a person granted keepalive who keeps their login to a website alive, as they saved it, has its keepalive page, or else its address, loaded in its browser every so often, whatever the hour, until the time they set, its state the login again, until a sign-in shows, which marks the login expired", async () => {
  const bob = 'bob@demo.test', carol = 'carol@demo.test', until = new Date(2026, 10, 9).toISOString(), at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
  writeJson('users.json', { [alice]: { role: 'admin' }, [bob]: { role: 'user' }, [carol]: { role: 'user' } });
  writeJson('capabilities.json', { keepalive: [carol] });
  sites({ pa: { url: 'https://pa.example.com/PatriArchMVC/Account/Login', hosts: ['sso.example.com'], writeback: true, keepalive: '/PatriArchMVC/', every: 8 } });
  saveLogin(alice, { ...website('pa', 'PatriArch'), keepalive: until }, '{"cookies":["signed in"]}');
  saveLogin(bob, { ...website('pa', 'PatriArch'), keepalive: until }, '{"cookies":["bob, not granted keepalive"]}');
  saveLogin(carol, website('pa', 'PatriArch'), '{"cookies":["carol, not keeping it alive"]}');
  const turns = () => starts.filter(s => s.startsWith('https://pa.example.com/PatriArchMVC/ ')).length;
  [starts.length, states.length, back, shown] = [0, 0, { cookies: ['kept alive'] }, { url: 'https://pa.example.com/PatriArchMVC/Home', password: false }];
  await keepAlive(at(7, 3));
  assert.deepEqual([starts, states], [['https://pa.example.com/PatriArchMVC/ pa.example.com'], [{ cookies: ['signed in'] }]], "the page's host alone, in alice's browser alone, on a Saturday at 3:00");
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), { cookies: ['kept alive'] });
  await keepAlive(at(7, 3, 7));
  assert.equal(turns(), 1, 'every 8 minutes, as the website says');
  writeJson('capabilities.json', { keepalive: [carol, bob] });
  await keepAlive(at(7, 3, 8));
  assert.deepEqual(states.slice(1), [{ cookies: ['kept alive'] }, { cookies: ['bob, not granted keepalive'] }], 'bob too, once granted keepalive');
  const run = new Browsers(running('k2', ['web:pa']), 1);
  await run.browser('pa');
  await keepAlive(at(7, 3, 16));
  assert.equal(turns(), 4, "bob's alone: a run holds alice's browser there");
  await run.close();
  [shown, back] = [{ url: 'https://pa.example.com/PatriArchMVC/Account/Login', password: true }, { cookies: ['signed out'] }];
  await keepAlive(at(7, 3, 24));
  assert.equal(turns(), 6);
  assert.equal(logins(alice).find(l => l.id === 'web:pa')!.expired, true, 'a sign-in page: the login expired');
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), { cookies: ['kept alive'] }, 'and its state stays');
  saveLogin(bob, { ...website('pa', 'PatriArch'), keepalive: until }, '{"cookies":["bob"]}');
  await keepAlive(at(9, 0));
  assert.equal(turns(), 6, 'nothing for an expired login, nor once the time its person set has come');
  sites({ crm: { url: 'https://crm.example.com/#/home', hosts: ['cdn.example.com'], writeback: false } });
  saveLogin(bob, { ...website('crm', 'CRM'), keepalive: new Date(2026, 10, 12).toISOString() }, '{"cookies":["crm"]}');
  [starts.length, shown] = [0, { url: 'https://crm.example.com/#/home', password: false }];
  for (const m of [0, 9, 10]) await keepAlive(at(10, 12, m));
  assert.deepEqual(starts, ['https://crm.example.com/#/home crm.example.com', 'https://crm.example.com/#/home crm.example.com'], 'its address, every 10 minutes, where the website gives no page or how often');
});

test("saving a sign-in keeps its login alive until a time within the next 7 days, if given, and a sign-in without one no longer", async () => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  const id = await startSignIn(alice, 'crm', ''), week = Date.now() + 7 * 86_400_000;
  for (const t of [new Date(Date.now() - 60_000).toISOString(), new Date(week + 60_000).toISOString(), 'Friday', null])
    await assert.rejects(endSignIn(alice, id, true, t), /keepalive: a time within the next 7 days, until which your login is kept alive/, String(t));
  await endSignIn(alice, id, true, new Date(week - 60_000).toISOString());
  assert.equal(logins(alice).find(l => l.id === 'web:crm')!.keepalive, new Date(week - 60_000).toISOString());
  await endSignIn(alice, await startSignIn(alice, 'crm', ''), true);
  assert.equal(logins(alice).find(l => l.id === 'web:crm')!.keepalive, undefined);
});

test("a sign-in whose website its person removed meanwhile, as from another tab, saves nothing", async () => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  const id = await startSignIn(alice, 'crm', '');
  removeSite(alice, 'crm');
  await assert.rejects(endSignIn(alice, id, true), /alice@demo\.test has no website crm/);
  assert.ok(!logins(alice).some(l => l.id === 'web:crm'));
});

test("a person's keepalive turn that fails leaves the others' to go on, and a person disabled has none", async () => {
  const carol = 'carol@demo.test', until = new Date(2026, 10, 12).toISOString();
  sites({ pa: { url: 'https://pa.example.com/PatriArchMVC/Account/Login', hosts: ['sso.example.com'], writeback: true, keepalive: '/PatriArchMVC/', every: 8 } });
  writeJson('users.json', { [carol]: { role: 'user' }, [alice]: { role: 'admin' } });
  writeJson('capabilities.json', { keepalive: [carol] });
  saveLogin(carol, { ...website('pa', 'PatriArch'), keepalive: until }, '{"cookies":["refused"]}');
  saveLogin(alice, { ...website('pa', 'PatriArch'), keepalive: until }, '{"cookies":["signed in again"]}');
  [states.length, back, shown] = [0, { cookies: ['kept alive again'] }, { url: 'https://pa.example.com/PatriArchMVC/Home', password: false }];
  await keepAlive(new Date(2026, 10, 10, 9));
  assert.deepEqual(states, [{ cookies: ['refused'] }, { cookies: ['signed in again'] }], "carol's first, refused");
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), { cookies: ['kept alive again'] });
  writeJson('users.json', { [carol]: { role: 'user', disabled: true }, [alice]: { role: 'admin' } });
  states.length = 0;
  await keepAlive(new Date(2026, 10, 10, 9, 10));
  assert.deepEqual(states, [{ cookies: ['kept alive again'] }], 'nor for carol, disabled');
  writeJson('users.json', { [alice]: { role: 'admin' } });
});

test("a run gets its browser on a website only where its runner's grant to it in the instance's workspace is approved, else goes on without it, logged once; a login is kept alive only while a grant of its person's is approved, and revoked, signed out", async () => {
  const bob = 'bob@demo.test', until = new Date(2026, 10, 9).toISOString();
  writeJson('users.json', { [alice]: { role: 'admin' }, [bob]: { role: 'user' } });
  saveTree({ ...tree(), workspaces: { w: { ...tree().workspaces.w, members: [bob] } } });
  sites({ bank: { url: 'https://bank.example.com', hosts: [], writeback: false, keepalive: '/home', every: 10 } });
  writeJson('capabilities.json', { keepalive: [bob] });
  writeJson('grants.json', {});
  saveLogin(alice, { ...website('bank', 'Bank'), keepalive: until }, '{"cookies":["alice"]}');
  saveLogin(bob, { ...website('bank', 'Bank'), keepalive: until }, '{"cookies":["bob"]}');
  const his = running('b2', ['web:bank'], 1, bob);
  for (const run of [2, 3, 4]) his.append('server', 'run', { run, runner: bob, consent: 1 });
  const first = new Browsers(his, 1);
  for (const _ of [1, 2]) await assert.rejects(first.browser('bank'), /^Error: bob@demo\.test has no approved grant to use bank in Acme: they ask its owners for one on the Logins page; this run goes on without it$/);
  assert.deepEqual(his.log.filter(e => e.action === 'refused').map(e => e.run), [1], 'logged once a run');
  const { id } = await ask(asPerson(bob)!, 'bank', 'w', 'daily balances');
  await assert.rejects(new Browsers(his, 2).browser('bank'), /no approved grant/, 'asked is not approved');
  decide(asPerson(alice)!, id, true, '');
  const run = new Browsers(his, 3), heard: string[] = [], hear = (x: string) => heard.push(x);
  changes.on('change', hear);
  assert.equal(await run.browser('bank'), 'b9');
  changes.off('change', hear);
  assert.deepEqual([heard, [...run.watchable()]], [[his.id], [['bank', 'b9']]], "its instance's page hears it opened, for whoever sees the instance to watch");
  await run.close();
  [states.length, shown] = [0, { url: 'https://bank.example.com/home', password: false }];
  await keepAlive(new Date(2026, 10, 2, 9));
  assert.deepEqual(states, [{ cookies: ['bob'] }], 'kept alive for bob, whose grant is approved, not for alice, who has none');
  revoke(asPerson(alice)!, id);
  assert.ok(!logins(bob).some(l => l.id === 'web:bank'), 'revoked, with nothing left pending or approved, bob is signed out of it');
  await assert.rejects(new Browsers(his, 4).browser('bank'), /bob@demo\.test no longer has a login offering web:bank/);
  signOut(alice, 'web:bank');
  writeJson('users.json', { [alice]: { role: 'admin' } });
  writeJson('grants.json', everyone);
});

test('a request lapses a week after it was asked, and a login no approved grant uses is signed out a week after its sign-in', async () => {
  const bob = 'bob@demo.test', week = 7 * 86_400_000, since = new Date().toISOString();
  writeJson('users.json', { [alice]: { role: 'admin' }, [bob]: { role: 'user' } });
  sites({ bank: { url: 'https://bank.example.com', hosts: [] }, crm: { url: 'https://crm.example.com', hosts: [] } });
  writeJson('grants.json', {});
  saveLogin(bob, { ...website('bank', 'Bank'), since }, '{}');
  saveLogin(bob, { ...website('crm', 'CRM'), since }, '{}');
  const { id: asked } = await ask(asPerson(bob)!, 'bank', 'w', 'balances'), { id: used } = await ask(asPerson(bob)!, 'crm', 'w', 'invoices');
  decide(asPerson(alice)!, used, true, '');
  lapse(Date.now() + week - 60_000);
  const theirs = () => logins(bob).map(l => l.id).filter(id => ['web:bank', 'web:crm'].includes(id));
  assert.deepEqual([grants()[asked].state, theirs()], ['pending', ['web:bank', 'web:crm']], 'not yet a week');
  lapse(Date.now() + week + 60_000);
  assert.deepEqual([grants()[asked].state, grants()[used].state, theirs()], ['lapsed', 'approved', ['web:crm']], 'the request lapsed, and the login it waited on went with it; the approved one stays');
  const { by, op, grants: lapsed } = JSON.parse(readFileSync(join(rfDir(), 'log.jsonl'), 'utf8').trim().split('\n').at(-1)!);
  assert.deepEqual([by, op, lapsed], ['server', 'lapse', [asked]], "an act of the server's, in the system's log");
  signOut(bob, 'web:crm');
  writeJson('users.json', { [alice]: { role: 'admin' } });
  writeJson('grants.json', everyone);
});

test("as the server starts, the browsers a restart left open on the service close: a run's keeps its request log and hands its login back, as its run would have, and a sign-in's just goes", async t => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, website('crm', 'CRM'), '{"cookies":["before"]}');
  const inst = running('2027-12b', ['web:crm'], 4), cut = new Browsers(inst, 4);
  await cut.browser('crm');
  clearTimeout(cut.bySite.get('crm')!.idle);
  // One whose instance is gone closes all the same, and the rest after it.
  writeJson('browsers.json', { ...JSON.parse(readFileSync(join(tmp, '.rf', 'browsers.json'), 'utf8')), lost: { inst: 'gone', run: 1, site: 'crm', email: alice, since: '', writeback: false, file: 'browser/run 1 crm.jsonl' } });
  [listed, back] = [['lost', 'b9', 'signin'], { cookies: ['as it was cut'] }];
  deleted.length = 0;
  t.mock.method(console, 'error', () => {});
  await reap();
  assert.deepEqual(deleted, ['lost', 'b9', 'signin']);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.run, e.site, e.requests, e.writes, e.file]), [[4, 'crm', 1, 0, 'browser/run 4 crm.jsonl']]);
  assert.equal(readFileSync(join(inst.dir, 'browser/run 4 crm.jsonl'), 'utf8'), `${JSON.stringify(plain[0])}\n`);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: ['as it was cut'] });
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, '.rf', 'browsers.json'), 'utf8')), {}, 'nothing left to reap');
});

// A run's browser's log of hosts its pages asked for and were refused, each with what the browser said of its request, if anything,
// as a browser service from before it did says nothing; and the checks the server keeps of those hosts, once it has them all.
const refusing = (...asked: (string | object)[]) => asked.map(a => ({ method: 'GET', status: 403, blocked: 'host not on the list', ...(typeof a === 'string' ? { url: a } : a) }));
const checked = async (site: string, hosts: string[]) => {
  for (let i = 0; !hosts.every(h => websitesOf(alice)[site].checks?.[h]); i++) {
    assert.ok(i < 200, `${hosts.join(', ')} never checked`);
    await sleep(50);
  }
  return websitesOf(alice)[site];
};

test("the hosts a run's browser was refused: one within the domains its website reaches it reaches at once, logged in the instance and the system's log, but one at an internal address waits on admins, even there; without the server's key the rest are left for its person", async () => {
  sites({ crm: { url: 'https://crm.example.com/', hosts: ['erp.acme.localhost'], writeback: false } });
  saveLogin(alice, website('crm', 'CRM'), '{}');
  requested = refusing('https://cdn.example.com/app.js', 'https://intra.acme.localhost/api', 'https://sso.other.test/login');
  const inst = running('2028-01', ['web:crm']), browsers = new Browsers(inst, 1), own = "It is within example.com, the website's own domain.";
  await browsers.browser('crm');
  await browsers.close();
  requested = plain;
  const w = await checked('crm', ['cdn.example.com', 'intra.acme.localhost']);
  assert.deepEqual([w.hosts, w.checks], [['erp.acme.localhost', 'cdn.example.com'], { 'cdn.example.com': { verdict: 'pass', why: own }, 'intra.acme.localhost': { verdict: 'internal', why: 'It is at an internal address.' } }]);
  assert.deepEqual(inst.log.filter(e => e.action === 'allowed').map(e => [e.by, e.run, e.site, e.login, e.allowed, e.why]), [['server', 1, 'crm', alice, ['cdn.example.com'], { 'cdn.example.com': own }]]);
  const act = readFileSync(join(tmp, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).findLast(a => a.op === 'hosts');
  assert.deepEqual([act.by, act.person, act.site, act.inst, act.run, act.allowed], ['server', alice, 'crm', inst.id, 1, { 'cdn.example.com': own }]);
  const { allowHost } = await import('../src/browsers.ts');
  await assert.rejects(allowHost({ email: alice, role: 'user' } as never, 'crm', 'intra.acme.localhost'), /^Error: intra\.acme\.localhost is at an internal address: an admin allows it$/, 'nor does its person allow it');
});

test("with the server's key its model decides the rest, from what the browser's log, the runs and a web search say of each, never a path or a query: what the pages need the website reaches at once, what they work without stays refused, and anything else waits on admins", async t => {
  const asked: { url: string; body: any }[] = [];
  const stand = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    asked.push({ url: req.url!, body });
    res.end(JSON.stringify(req.url === '/search' ? { results: [{ title: `About ${body.query}`, url: `https://about.test/${body.query}`, highlights: ['One.', 'Two.'] }] }
      : { choices: [{ message: { content: JSON.stringify({ hosts: { 'static.cdnhost.test': { verdict: 'pass', why: 'Its CDN.' }, 'www.tracker.test': { verdict: 'refused', why: 'Analytics.' } } }) } }] }));
  });
  await new Promise<void>(ok => stand.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(stand.address() as { port: number }).port}`;
  Object.assign(upstreams, { 'openrouter.ai': base, 'api.exa.ai': base });
  Object.assign(process.env, { OPENROUTER_API_KEY: 'the-key', EXA_API_KEY: 'the-exa-key' });
  t.after(() => {
    for (const k of ['OPENROUTER_API_KEY', 'EXA_API_KEY']) delete process.env[k];
    for (const h of ['openrouter.ai', 'api.exa.ai']) delete upstreams[h];
    stand.close();
  });
  sites({ crm: { url: 'https://crm.example.com/', hosts: [], writeback: false } });
  saveLogin(alice, website('crm', 'CRM'), '{}');
  const inst = running('2028-02', ['web:crm'], 2);
  // An earlier run's browser was refused the upload host too, before the server checked hosts.
  inst.append('server', 'browser', { run: 1, site: 'crm', login: alice, requests: 3, writes: 0, blocked: 3, file: 'browser/run 1 crm.jsonl', hosts: { 'upload.elsewhere.test': 3 } });
  requested = refusing({ url: 'https://static.cdnhost.test/a.js?v=1', dest: 'script', from: 'https://crm.example.com/report?id=7' }, { url: 'https://static.cdnhost.test/b.css', dest: 'style', from: 'https://crm.example.com/report?id=7' },
    'https://www.tracker.test/c', { url: 'https://upload.elsewhere.test/x', dest: 'empty', from: 'https://crm.example.com/' });
  const browsers = new Browsers(inst, 2);
  await browsers.browser('crm');
  await browsers.close();
  requested = plain;
  const w = await checked('crm', ['static.cdnhost.test', 'www.tracker.test', 'upload.elsewhere.test']);
  const search = (h: string) => ({ title: `About ${h}`, url: `https://about.test/${h}`, text: 'One. Two.' }), model = asked.find(a => a.url === '/api/v1/chat/completions')!.body;
  assert.deepEqual(asked.filter(a => a.url === '/search').map(a => [a.body.query, a.body.numResults]).sort(), [['static.cdnhost.test', 1], ['upload.elsewhere.test', 1], ['www.tracker.test', 1]], 'one result about each');
  assert.deepEqual([model.provider, JSON.parse(model.messages[1].content)], [{ data_collection: 'deny' }, {
    website: { name: 'crm', address: 'crm.example.com', hosts: [] },
    refused: {
      'static.cdnhost.test': { as: ['script', 'style'], from: ['crm.example.com'], requests: 2, runs: 1, domain: 'cdnhost.test', search: search('static.cdnhost.test') },
      'www.tracker.test': { as: [], from: [], requests: 1, runs: 1, domain: 'tracker.test', search: search('www.tracker.test') },
      'upload.elsewhere.test': { as: ['empty'], from: ['crm.example.com'], requests: 4, runs: 2, domain: 'elsewhere.test', search: search('upload.elsewhere.test') },
    },
  }], 'hosts alone, from providers that keep no data');
  assert.deepEqual([w.hosts, w.checks], [['static.cdnhost.test'], {
    'static.cdnhost.test': { verdict: 'pass', why: 'Its CDN.' }, 'www.tracker.test': { verdict: 'refused', why: 'Analytics.' }, 'upload.elsewhere.test': { verdict: 'high', why: 'The check gave no verdict for it.' },
  }], 'one the model leaves out waits on admins');
  assert.deepEqual(inst.log.filter(e => e.action === 'allowed').map(e => [e.allowed, e.why]), [[['static.cdnhost.test'], { 'static.cdnhost.test': 'Its CDN.' }]]);
});
