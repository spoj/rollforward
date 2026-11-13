import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
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
const state = (value: string, domain = '.example.com') => ({ cookies: [{ name: 'sid', value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] });
let page = Buffer.from('page 1'), back: unknown = { cookies: [], origins: [] }, listed: string[] = [], shown = { url: '', password: false };
const plain = [{ method: 'GET', url: 'https://crm.example.com/', status: 200 }];
let requested: object[] = plain;
const states: unknown[] = [], headers: unknown[] = [], deleted: string[] = [], starts: string[] = [], publics: boolean[] = [];
const opened: { site: { hosts: string[]; start_url?: string; public?: boolean; open?: boolean; except?: string[] }; ttl_s: number; state?: unknown }[] = [];
let blocked: Record<string, boolean> = {};
const toldHosts: { path: string; hosts: string[] }[] = [];
let nextId = 'b9', refuseClose = false, dropClose = false, hangClose = false, openGate: Promise<void> | undefined;
const service = createServer(async (req, res) => {
  if (req.method === 'PUT') {
    toldHosts.push({ path: req.url!, ...JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()) });
    return res.end('{}');
  }
  if (req.method === 'DELETE') {
    if (hangClose) return;
    if (dropClose) {
      res.writeHead(500, { 'content-length': 100 });
      res.write('{"error":');
      return setTimeout(() => res.destroy(), 10);
    }
    if (refuseClose) return res.writeHead(404).end('{"error":"session gone"}');
    deleted.push(req.url!.split('/')[2]);
    return res.writeHead(200).end(JSON.stringify({ state: back, log: requested }));
  }
  if (req.method === 'POST' && req.url!.endsWith('/reload')) return res.writeHead(200).end('{}');
  if (req.method === 'POST') {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()), { state, site } = body;
    opened.push(body);
    states.push(state);
    headers.push(site.headers);
    starts.push(`${site.start_url} ${site.hosts.join(',')}`);
    publics.push(!!site.public);
    if (state?.cookies?.[0]?.value === 'refused') return res.writeHead(500).end('{"error":"refused"}');
    await openGate;
    return res.writeHead(201).end(JSON.stringify({ id: nextId }));
  }
  if (req.url!.startsWith('/blocked?')) {
    const hosts = new URL(req.url!, 'http://browser.test').searchParams.getAll('host');
    return res.writeHead(200).end(JSON.stringify(Object.fromEntries(hosts.map(h => [h, blocked[h] ?? false]))));
  }
  if (req.url === '/sessions') return res.writeHead(200).end(JSON.stringify(listed.map(id => ({ id }))));
  if (req.url === '/sessions/b9/page') return res.writeHead(200).end(JSON.stringify(shown));
  if (req.url === '/sessions/b9/log') return res.writeHead(200).end('[{"live":true}]');
  if (req.url!.startsWith('/sessions/b9/files/')) return res.writeHead(200).end(`file at ${req.url}`);
  res.writeHead(req.url === '/sessions/b1/screenshot' ? 200 : 404).end(page);
}).on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`));
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
Object.assign(process.env, { RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`, RF_BROWSER_IDLE_MS: '300', RF_BROWSER_CLOSE_MS: '500' });
const { Browsers, endSignIn, isSignIn, keepAlive, reap, removeSite, startSignIn, websitesOf } = await import('../src/browsers.ts');
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
  assert.equal(await browsers.expire('erp'), `recorded: erp signed ${alice} out; they sign in to it again on the Logins page, and the instance carries on`);
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

test('a dropped error response fails closing a browser and releases its login for the next run', async t => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin('alice@demo.test', { id: 'web:crm', kind: 'website', name: 'CRM', since: '', offers: [{ id: 'web:crm', name: 'CRM' }] }, '{}');
  const first = new Browsers(running('dropped-close', ['web:crm']), 1);
  await first.browser('crm');
  dropClose = true;
  t.after(() => { dropClose = false; });
  const result = await Promise.race([
    first.close().then(() => 'closed', (e: { status: number }) => e.status),
    new Promise(ok => setTimeout(() => ok('still waiting'), 500)),
  ]);
  assert.equal(result, 502);
  dropClose = false;
  const next = new Browsers(running('after-dropped-close', ['web:crm']), 1);
  await next.browser('crm');
  await next.close();
});

test("a run's open browser and connections close as soon as its login is no longer lent", async () => {
  for (const stop of ['untick', 'remove', 'signout', 'revoke']) {
    sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
    writeJson('grants.json', everyone);
    saveLogin('alice@demo.test', { id: 'web:crm', kind: 'website', name: 'CRM', since: '', offers: [{ id: 'web:crm', name: 'CRM' }] }, '{}');
    const inst = running(`unlent-${stop}`, ['web:crm']), browsers = new Browsers(inst, 1), conn = new PassThrough();
    await browsers.browser('crm');
    browsers.connected('crm', conn);
    if (stop === 'untick') inst.append('alice@demo.test', 'logins', { logins: [] });
    if (stop === 'remove') removeSite('alice@demo.test', 'crm');
    if (stop === 'signout') signOut('alice@demo.test', 'web:crm');
    if (stop === 'revoke') revoke(asPerson('alice@demo.test')!, 'alice@demo.test crm');
    try {
      await browsers.closeUnlent();
      assert.equal(browsers.bySite.size, 0, stop);
      assert.equal(conn.destroyed, true, stop);
    } finally {
      conn.destroy();
      await browsers.close();
    }
  }
  writeJson('grants.json', everyone);
});

test("closing a run's browser hands its login back refreshed, unless its person signed in to it anew since it opened", async () => {
  const alice = 'alice@demo.test', crm = (since: string) => ({ id: 'web:crm', kind: 'website' as const, name: 'CRM', since, offers: [{ id: 'web:crm', name: 'CRM' }] });
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, crm('t1'), JSON.stringify(state('old')));
  const browsers = new Browsers(running('2027-02', ['web:crm']), 1);
  await browsers.browser('crm');
  await browsers.close();
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: [], origins: [] }, 'refreshed from the browser');
  await browsers.browser('crm');
  saveLogin(alice, crm('t2'), JSON.stringify(state('fresh')));
  await browsers.close();
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), state('fresh'), 'the sign-in since the browser opened stays');
});

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));
const alice = 'alice@demo.test', website = (id: string, name: string) => ({ id: `web:${id}`, kind: 'website' as const, name, since: 't1', offers: [{ id: `web:${id}`, name }] });

test('starting a sign-in ends the one before, even if the service has ended it, and ending forgets one whose browser is gone', async () => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  const old = await startSignIn(alice, 'crm', '');
  try {
    nextId = 'b10';
    const fresh = await startSignIn(alice, 'crm', '');
    assert.equal(isSignIn(alice, old), false);
    assert.equal(isSignIn(alice, fresh), true);
    refuseClose = true;
    await assert.rejects(endSignIn(alice, fresh, false), /session gone/);
    assert.equal(isSignIn(alice, fresh), false);
    const abandoned = await startSignIn(alice, 'crm', '');
    nextId = 'b11';
    const replacement = await startSignIn(alice, 'crm', '');
    assert.equal(isSignIn(alice, abandoned), false);
    assert.equal(isSignIn(alice, replacement), true);
    refuseClose = false;
    await endSignIn(alice, replacement, false);
  } finally {
    refuseClose = false;
    nextId = 'b9';
  }
});

test('a sign-in past its local deadline returns 410 on Save without replacing the saved login', async t => {
  const before = process.env.RF_SIGNIN_S;
  process.env.RF_SIGNIN_S = '3';
  t.after(() => { if (before === undefined) delete process.env.RF_SIGNIN_S; else process.env.RF_SIGNIN_S = before; });
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, website('crm', 'CRM'), JSON.stringify(state('before expiry')));
  const now = Date.now(), id = await startSignIn(alice, 'crm', '');
  assert.equal(opened.at(-1)!.ttl_s, 3, 'RF_SIGNIN_S configures the browser service deadline too');
  const clock = t.mock.method(Date, 'now', () => now + 4000);
  await assert.rejects(endSignIn(alice, id, true), (e: { status: number; message: string }) => e.status === 410 && /expired/i.test(e.message));
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), state('before expiry'));
  assert.equal(isSignIn(alice, id), false);
  clock.mock.restore();
});

test('a sign-in is short and open, with protected hosts excepted and only approved exact internal hosts, while run browsers remain allowlisted', async t => {
  const { setLetIn } = await import('../src/connections.ts');
  const oldPublic = process.env.RF_PUBLIC_URL;
  process.env.RF_PUBLIC_URL = 'https://rollforward.example.net';
  writeJson('connections.json', { graph: { type: 'graph' } });
  setLetIn(['10.7.8.9'], alice, true);
  t.after(() => {
    if (oldPublic === undefined) delete process.env.RF_PUBLIC_URL; else process.env.RF_PUBLIC_URL = oldPublic;
    writeJson('connections.json', {});
    setLetIn(['10.7.8.9'], alice, false);
  });
  sites({ crm: { url: 'https://crm.example.com/login', hosts: ['*.example.com', 'sso.other.test', '10.7.8.9', '10.7.8.10'], writeback: false } });
  const id = await startSignIn(alice, 'crm', '');
  try {
    const { site, ttl_s, state: saved } = opened.at(-1)!;
    assert.equal(site.open, true);
    assert.equal(ttl_s, Number(process.env.RF_SIGNIN_S ?? 600));
    assert.equal(saved, undefined, 'sign-in does not open with the previous login');
    assert.deepEqual(site.hosts, ['10.7.8.9'], 'only approved exact internal hosts need an exception in an open sign-in');
    assert.ok(!site.hosts.includes('10.7.8.10'));
    assert.ok(!site.hosts.some(h => h.startsWith('*.')), 'internal reach is never granted by a wildcard');
    assert.ok(site.except!.includes('rollforward.example.net'));
    assert.ok(site.except!.includes('127.0.0.1'));
    assert.ok(site.except!.includes('graph.microsoft.com'));
  } finally {
    await endSignIn(alice, id, false);
  }
  saveLogin(alice, website('crm', 'CRM'), JSON.stringify(state('run')));
  const browsers = new Browsers(running('closed-run-hosts', ['web:crm']), 1);
  try {
    await browsers.browser('crm');
    assert.ok(!opened.at(-1)!.site.open, 'open sign-in is not an open run browser');
  } finally {
    await browsers.end();
  }
});

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

test('saving a sign-in profiles and checks hosts once, keeps reduced evidence and only allowed cookies and origins, including when an old trace has no kinds', async t => {
  const profile = { what: 'The company CRM.', category: 'company', risk: 'low', flags: ['Can submit records.'] }, evidence: any[] = [];
  const stand = createServer(async (req, res) => {
    evidence.push(JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()));
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify({ profile, hosts: {
      'sso.idp.test': { verdict: 'pass', why: 'Its sign-on.' }, 'tracker.third.test': { verdict: 'refused', why: 'Analytics.' },
      'blocked.example.com': { verdict: 'pass', why: 'The model cannot override the blocklist.' },
    } }) + '\n```' } }] }));
  });
  await new Promise<void>(ok => stand.listen(0, '127.0.0.1', ok));
  upstreams['openrouter.ai'] = `http://127.0.0.1:${(stand.address() as { port: number }).port}`;
  process.env.OPENROUTER_API_KEY = 'key';
  blocked = { 'blocked.example.com': true };
  t.after(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete upstreams['openrouter.ai'];
    stand.close();
    blocked = {};
    requested = plain;
    back = { cookies: [], origins: [] };
  });
  sites({ crm: { url: 'https://crm.example.com/private-login?token=secret', hosts: [], writeback: false } });
  requested = [
    { method: 'GET', url: 'https://crm.example.com/private-start?code=secret', status: 302, dest: 'document' },
    { method: 'GET', url: 'https://cdn.example.com/private.js?key=secret', status: 200, dest: 'script', from: 'https://crm.example.com/private-page' },
    { method: 'GET', url: 'https://sso.idp.test/private-signin?code=secret', status: 200, dest: 'document', from: 'https://crm.example.com/private-page' },
    { method: 'GET', url: 'https://tracker.third.test/private-pixel', status: 200, dest: 'image', from: 'https://crm.example.com/private-page' },
    { method: 'GET', url: 'https://blocked.example.com/private-malware', status: 403, blocked: 'on a blocklist' },
    { method: 'GET', url: 'https://10.77.88.99/private-api', status: 403, blocked: 'host not on the list' },
  ];
  const hosts = ['crm.example.com', 'cdn.example.com', 'sso.idp.test', 'tracker.third.test', 'blocked.example.com', '10.77.88.99'];
  back = { cookies: hosts.map(h => state('secret-cookie', h).cookies[0]), origins: hosts.map(h => ({ origin: `https://${h}`, localStorage: [{ name: 'token', value: 'secret-storage' }] })) };
  await endSignIn(alice, await startSignIn(alice, 'crm', ''), true);
  const w = websitesOf(alice).crm, kept = JSON.parse(secret(alice, 'web:crm')), trace = logins(alice).find(l => l.id === 'web:crm')!.trace!;
  assert.deepEqual(w.profile, profile);
  assert.equal(w.writeback, false);
  assert.equal(w.checks!['cdn.example.com'].verdict, 'pass');
  assert.equal(w.checks!['blocked.example.com'].verdict, 'refused', 'a blocklist beats the own-domain rule and a model pass');
  assert.equal(w.checks!['10.77.88.99'].verdict, 'internal');
  assert.deepEqual(kept.cookies.map((c: { domain: string }) => c.domain).sort(), ['cdn.example.com', 'crm.example.com', 'sso.idp.test']);
  assert.deepEqual(kept.origins.map((o: { origin: string }) => o.origin).sort(), ['https://cdn.example.com', 'https://crm.example.com', 'https://sso.idp.test']);
  assert.deepEqual(trace.kinds!['sso.idp.test'], { dest: ['document'], from: ['crm.example.com'] });
  assert.doesNotMatch(JSON.stringify(trace), /private-|secret|https:\/\//);
  assert.doesNotMatch(JSON.stringify(evidence), /private-|secret-cookie|secret-storage|token=|code=/);
  assert.equal(evidence.length, 1, 'one shared check describes the website and decides its non-rule hosts');
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  const { checkWebsite } = await import('../src/browsers.ts');
  assert.deepEqual(await checkWebsite(alice, 'crm', { requests: { 'crm.example.com': { 200: 1 } }, blocked: [], seconds: 3 }), profile, 'production traces without kinds still check');
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
    id: 'b9', site: 'pa', email: alice, saved: false, seconds: 0, requests: { 'pa.example.com': { 302: 1, 502: 1 }, 'sso.example.com': { 200: 1, 401: 1, 404: 1 }, 'cdn.example.com': { 403: 2 } },
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
  saveLogin(alice, website('crm', 'CRM'), JSON.stringify(state('seed')));
  saveLogin(alice, website('ledger', 'Ledger'), JSON.stringify(state('seed')));
  const one = new Browsers(running('2027-03', ['web:crm', 'web:ledger']), 1), two = new Browsers(running('2027-04', ['web:crm', 'web:ledger']), 1);
  states.length = 0;
  back = state('handed back');
  await one.browser('crm');
  let opened = false;
  const waiting = two.browser('crm').then(() => (opened = true));
  await sleep(50);
  assert.equal(opened, false, 'the second run waits');
  assert.deepEqual(two.inst.log.filter(e => e.action === 'wait').map(e => [e.site, e.login, e.held]), [['crm', alice, 'Portal pull/2027-03']]);
  await one.close();
  await waiting;
  assert.deepEqual(states, [state('seed'), state('handed back')], 'and opens from the state the first handed back');
  await two.close();

  states.length = 0;
  back = state('never kept');
  await Promise.all([one.browser('ledger'), two.browser('ledger')]);
  await Promise.all([one.close(), two.close()]);
  assert.deepEqual(states, [state('seed'), state('seed')]);
  assert.deepEqual(JSON.parse(secret(alice, 'web:ledger')), state('seed'), 'nothing comes back');
});

test("a close the browser service never answers fails after RF_BROWSER_CLOSE_MS and releases its person's browser for the next run; one a restart left holds it until then, without holding up the start", async t => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, website('crm', 'CRM'), '{}');
  const first = new Browsers(running('hung-close', ['web:crm']), 1), next = new Browsers(running('after-hung-close', ['web:crm']), 1);
  await first.browser('crm');
  hangClose = true;
  t.after(() => { hangClose = false; });
  t.mock.method(console, 'error', () => {});
  const waiting = next.browser('crm');
  await assert.rejects(first.close(), (e: { status: number; message: string }) => e.status === 502 && /nothing in 0.5 s/.test(e.message));
  await waiting;
  hangClose = false;
  await next.close();
  writeJson('browsers.json', { [nextId]: { inst: first.inst.id, run: 1, site: 'crm', email: alice, since: 't1', writeback: true, file: 'browser/run 1 crm.jsonl' } });
  listed = [nextId];
  hangClose = true;
  const { closed } = await reap();
  const after = new Browsers(running('after-hung-reap', ['web:crm']), 1), opening = after.browser('crm');
  await sleep(50);
  assert.equal(after.inst.log.find(e => e.action === 'wait')?.held, 'restart', 'waits for the leftover');
  await closed;
  hangClose = false;
  await opening;
  await after.close();
  listed = [];
});

test('a sealed state that cannot be read does not hold the person\'s browser', async () => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, website('crm', 'CRM'), 'not JSON');
  const first = new Browsers(running('unreadable-state', ['web:crm']), 1);
  await assert.rejects(first.browser('crm'), SyntaxError);
  saveLogin(alice, website('crm', 'CRM'), '{}');
  const next = new Browsers(running('after-unreadable-state', ['web:crm']), 1);
  try {
    assert.equal(await Promise.race([next.browser('crm'), sleep(500).then(() => 'still held')]), 'b9');
  } finally {
    await next.end();
  }
});

test('a browser that finishes opening after its run ends or its grant is revoked closes at once', async t => {
  t.after(() => {
    writeJson('grants.json', everyone);
    sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
    saveLogin(alice, website('crm', 'CRM'), '{}');
  });
  for (const stop of ['end', 'revoke']) for (const writeback of [false, true]) {
    sites({ crm: { url: 'https://crm.example.com/', hosts: [], writeback } });
    writeJson('grants.json', everyone);
    saveLogin(alice, website('crm', 'CRM'), '{}');
    let release!: () => void;
    openGate = new Promise<void>(ok => { release = ok; });
    const browsers = new Browsers(running(`opening-${stop}-${writeback}`, ['web:crm']), 1), before = states.length;
    const first = browsers.browser('crm'), second = browsers.browser('crm');
    const outcomes = Promise.allSettled([first, second]);
    try {
      while (states.length === before) await sleep(5);
      const ending = stop === 'end' ? browsers.end() : undefined;
      if (stop === 'revoke') revoke(asPerson(alice)!, 'alice@demo.test crm');
      const closed = deleted.length;
      release();
      await ending;
      const results = await outcomes;
      assert.equal(deleted.length, closed + 1);
      assert.equal(browsers.bySite.size, 0);
      for (const r of results) assert.ok(r.status === 'rejected' || r.value === undefined);
    } finally {
      release();
      openGate = undefined;
      await outcomes;
      await browsers.close();
    }
  }
  writeJson('grants.json', everyone);
});

test("a browser that writes its state back is released once no connection has been open for a while, handing its login back, and a waiting connection that goes away stops waiting", async () => {
  const one = new Browsers(running('2027-05', ['web:crm']), 1), two = new Browsers(running('2027-06', ['web:crm']), 1);
  back = state('after a while');
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
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), state('after a while'));
  await one.browser('crm');
  await one.close();
  assert.deepEqual(one.inst.log.filter(e => e.op === 'browser').map(e => e.file), ['browser/run 1 crm.jsonl', 'browser/run 1 crm 2.jsonl'], 'a browser opened again keeps its own log');
  assert.equal(two.bySite.size, 0, 'nothing opened for the connection that went');
});

test("$RF_BROWSERS/NAME is the run's browser there: its CDP discovery, its websocket, opening the browser at the first connection, and its machine's files, each fetch logged", async () => {
  const inst = running('2027-07', ['web:crm'], 0), api = await serveAgent(inst), base = `${api.url}/browsers/${api.token}`;
  assert.deepEqual(await (await fetch(`${base}/crm/json/version/`)).json(), { webSocketDebuggerUrl: `${base.replace('http', 'ws')}/crm` });
  assert.match(await (await fetch(`${base}/erp/json/version`)).text(), /web:erp is not ticked/);
  assert.match(await (await fetch(base)).text(), /^Each website ticked for this run is a browser signed in as your runner[^]*\nTicked for this run:\n  crm  https:\/\/crm\.example\.com\n$/, '$RF_BROWSERS itself says what is there, and how it is used');
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
  saveLogin(alice, { ...website('pa', 'PatriArch'), keepalive: until }, JSON.stringify(state('signed in')));
  saveLogin(bob, { ...website('pa', 'PatriArch'), keepalive: until }, JSON.stringify(state('bob, not granted keepalive')));
  saveLogin(carol, website('pa', 'PatriArch'), JSON.stringify(state('carol, not keeping it alive')));
  const turns = () => starts.filter(s => s.startsWith('https://pa.example.com/PatriArchMVC/ ')).length;
  [starts.length, states.length, back, shown] = [0, 0, state('kept alive'), { url: 'https://pa.example.com/PatriArchMVC/Home', password: false }];
  await keepAlive(at(7, 3));
  assert.deepEqual([starts, states], [['https://pa.example.com/PatriArchMVC/ pa.example.com'], [state('signed in')]], "the page's host alone, in alice's browser alone, on a Saturday at 3:00");
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), state('kept alive'));
  await keepAlive(at(7, 3, 7));
  assert.equal(turns(), 1, 'every 8 minutes, as the website says');
  writeJson('capabilities.json', { keepalive: [carol, bob] });
  await keepAlive(at(7, 3, 8));
  assert.deepEqual(states.slice(1), [state('kept alive'), state('bob, not granted keepalive')], 'bob too, once granted keepalive');
  const run = new Browsers(running('k2', ['web:pa']), 1);
  await run.browser('pa');
  await keepAlive(at(7, 3, 16));
  assert.equal(turns(), 4, "bob's alone: a run holds alice's browser there");
  await run.close();
  [shown, back] = [{ url: 'https://pa.example.com/PatriArchMVC/Account/Login', password: true }, state('signed out')];
  await keepAlive(at(7, 3, 24));
  assert.equal(turns(), 6);
  assert.equal(logins(alice).find(l => l.id === 'web:pa')!.expired, true, 'a sign-in page: the login expired');
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), state('kept alive'), 'and its state stays');
  saveLogin(bob, { ...website('pa', 'PatriArch'), keepalive: until }, JSON.stringify(state('bob')));
  await keepAlive(at(9, 0));
  assert.equal(turns(), 6, 'nothing for an expired login, nor once the time its person set has come');
  sites({ crm: { url: 'https://crm.example.com/#/home', hosts: ['cdn.example.com'], writeback: false } });
  saveLogin(bob, { ...website('crm', 'CRM'), keepalive: new Date(2026, 10, 12).toISOString() }, JSON.stringify(state('crm')));
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

test("a sign-in whose website its person removed meanwhile, as from another tab, saves nothing", async t => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  const id = await startSignIn(alice, 'crm', '');
  t.after(async () => { if (isSignIn(alice, id)) await endSignIn(alice, id, false); });
  removeSite(alice, 'crm');
  await assert.rejects(endSignIn(alice, id, true), (e: { status: number; message: string }) => e.status === 409 && /superseded/.test(e.message));
  assert.equal(isSignIn(alice, id), false);
  assert.ok(!logins(alice).some(l => l.id === 'web:crm'));
});

test("a person's keepalive turn that fails leaves the others' to go on, and a person disabled has none", async () => {
  const carol = 'carol@demo.test', until = new Date(2026, 10, 12).toISOString();
  sites({ pa: { url: 'https://pa.example.com/PatriArchMVC/Account/Login', hosts: ['sso.example.com'], writeback: true, keepalive: '/PatriArchMVC/', every: 8 } });
  writeJson('users.json', { [carol]: { role: 'user' }, [alice]: { role: 'admin' } });
  writeJson('capabilities.json', { keepalive: [carol] });
  saveLogin(carol, { ...website('pa', 'PatriArch'), keepalive: until }, JSON.stringify(state('refused')));
  saveLogin(alice, { ...website('pa', 'PatriArch'), keepalive: until }, JSON.stringify(state('signed in again')));
  [states.length, back, shown] = [0, state('kept alive again'), { url: 'https://pa.example.com/PatriArchMVC/Home', password: false }];
  await keepAlive(new Date(2026, 10, 10, 9));
  assert.deepEqual(states, [state('refused'), state('signed in again')], "carol's first, refused");
  assert.deepEqual(JSON.parse(secret(alice, 'web:pa')), state('kept alive again'));
  writeJson('users.json', { [carol]: { role: 'user', disabled: true }, [alice]: { role: 'admin' } });
  states.length = 0;
  await keepAlive(new Date(2026, 10, 10, 9, 10));
  assert.deepEqual(states, [state('kept alive again')], 'nor for carol, disabled');
  writeJson('users.json', { [alice]: { role: 'admin' } });
});

test("a run gets its browser on a website only where its runner's grant to it in the instance's workspace is approved, else goes on without it, logged once; a login is kept alive only while a grant of its person's is approved, and revoked, signed out", async () => {
  const bob = 'bob@demo.test', until = new Date(2026, 10, 9).toISOString();
  writeJson('users.json', { [alice]: { role: 'admin', name: 'Alice Ng' }, [bob]: { role: 'user' } });
  saveTree({ ...tree(), workspaces: { w: { ...tree().workspaces.w, members: [bob] } } });
  sites({ bank: { url: 'https://bank.example.com', hosts: [], writeback: false, keepalive: '/home', every: 10, profile: { what: 'A bank', category: 'bank', risk: 'low', flags: [] } } });
  writeJson('capabilities.json', { keepalive: [bob] });
  writeJson('grants.json', {});
  saveLogin(alice, { ...website('bank', 'Bank'), keepalive: until }, JSON.stringify(state('alice')));
  saveLogin(bob, { ...website('bank', 'Bank'), keepalive: until }, JSON.stringify(state('bob')));
  const his = running('b2', ['web:bank'], 1, bob);
  for (const run of [2, 3, 4]) his.append('server', 'run', { run, runner: bob, consent: 1 });
  const first = new Browsers(his, 1);
  for (const _ of [1, 2]) await assert.rejects(first.browser('bank'), { message: "bob@demo.test has no approved grant to use bank in Acme, so this run goes on without it: they ask for one on the Logins page, under bank, choosing Acme, and it then waits on Acme's owners, Alice Ng, to approve it" });
  assert.deepEqual(his.log.filter(e => e.action === 'refused').map(e => e.run), [1], 'logged once a run');
  const { id } = await ask(asPerson(bob)!, 'bank', 'w', 'daily balances');
  await assert.rejects(new Browsers(his, 2).browser('bank'), { message: `bob@demo.test has no approved grant to use bank in Acme, so this run goes on without it: they asked for one on ${grants()[id].at.slice(0, 10)}, which waits on Acme's owners, Alice Ng, to approve it` }, 'asked is not approved');
  decide(asPerson(alice)!, id, true, '');
  const run = new Browsers(his, 3), heard: string[] = [], hear = (x: string) => heard.push(x);
  changes.on('change', hear);
  assert.equal(await run.browser('bank'), 'b9');
  changes.off('change', hear);
  assert.deepEqual([heard, [...run.watchable()]], [[his.id], [['bank', 'b9']]], "its instance's page hears it opened, for whoever sees the instance to watch");
  await run.close();
  [states.length, shown] = [0, { url: 'https://bank.example.com/home', password: false }];
  await keepAlive(new Date(2026, 10, 2, 9));
  assert.deepEqual(states, [state('bob')], 'kept alive for bob, whose grant is approved, not for alice, who has none');
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

test('the server takes requests once the browser service lists the browsers a restart left, while they close, even if a close never answers, and 10 s after a list that never comes', async t => {
  let list!: () => void, sawList!: () => void, sawClose!: () => void;
  const listing = new Promise<void>(ok => { list = ok; }), listed = new Promise<void>(ok => { sawList = ok; }), closing = new Promise<void>(ok => { sawClose = ok; });
  const start = async (service: RequestListener) => {
    const reaper = createServer(service), probe = createServer();
    await new Promise<void>(ok => reaper.listen(0, '127.0.0.1', ok));
    await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
    const port = (probe.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
    await new Promise<void>(ok => probe.close(() => ok()));
    const proc = spawn(process.execPath, [join(import.meta.dirname, '../src/server.ts'), join(tmp, `startup-${port}`), String(port)], {
      env: { ...process.env, RF_BROWSER_CLOSE_MS: undefined, RF_BROWSER_URL: `http://127.0.0.1:${(reaper.address() as { port: number }).port}`, RF_PUBLIC_URL: base, RF_OIDC_ISSUER: 'https://login.test', RF_OIDC_CLIENT_ID: 'client' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const ready = new Promise<void>((ok, fail) => {
      proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok());
      proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
    });
    t.after(async () => {
      proc.kill();
      await once(proc, 'exit');
      reaper.closeAllConnections();
      reaper.close();
    });
    return { base, ready };
  };
  const { base, ready } = await start(async (req, res) => {
    if (req.method !== 'GET') return sawClose();
    sawList();
    await listing;
    res.end('[{"id":"leftover"}]');
  });
  await listed;
  await assert.rejects(fetch(base), /fetch failed/);
  list();
  await closing;
  await ready;
  assert.equal((await fetch(base)).status, 200, 'takes requests while the close hangs');
  const silent = await start(() => {}), since = Date.now();
  await silent.ready;
  assert.ok(Date.now() - since < 15_000);
  assert.equal((await fetch(silent.base)).status, 200);
});

test("as the server starts, the browsers a restart left open on the service close: a run's keeps its request log and hands its login back, as its run would have, and a sign-in's just goes", async t => {
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: true } });
  saveLogin(alice, website('crm', 'CRM'), JSON.stringify(state('before')));
  const inst = running('2027-12b', ['web:crm'], 4), cut = new Browsers(inst, 4);
  await cut.browser('crm');
  clearTimeout(cut.bySite.get('crm')!.idle);
  // One whose instance is gone closes all the same, and the rest after it.
  writeJson('browsers.json', { ...JSON.parse(readFileSync(join(tmp, '.rf', 'browsers.json'), 'utf8')), lost: { inst: 'gone', run: 1, site: 'crm', email: alice, since: '', writeback: false, file: 'browser/run 1 crm.jsonl' } });
  [listed, back] = [['lost', 'b9', 'signin'], state('as it was cut')];
  deleted.length = 0;
  t.mock.method(console, 'error', () => {});
  await (await reap()).closed;
  assert.deepEqual(deleted, ['lost', 'b9', 'signin']);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.run, e.site, e.requests, e.writes, e.file]), [[4, 'crm', 1, 0, 'browser/run 4 crm.jsonl']]);
  assert.equal(readFileSync(join(inst.dir, 'browser/run 4 crm.jsonl'), 'utf8'), `${JSON.stringify(plain[0])}\n`);
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), state('as it was cut'));
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

test('a refused run uses the shared rules: own-domain hosts pass and are logged, internal hosts wait on admins, and without a model key the rest stay unchecked for retry', async () => {
  sites({ crm: { url: 'https://crm.example.com/', hosts: ['erp.acme.localhost'], writeback: false } });
  saveLogin(alice, website('crm', 'CRM'), '{}');
  requested = refusing('https://cdn.example.com/app.js', 'https://intra.acme.localhost/api', 'https://sso.other.test/login');
  const inst = running('2028-01', ['web:crm']), browsers = new Browsers(inst, 1), own = "It is within example.com, the website's own domain.";
  await browsers.browser('crm');
  await browsers.close();
  requested = plain;
  const w = await checked('crm', ['cdn.example.com', 'intra.acme.localhost']);
  assert.deepEqual([w.hosts, w.checks], [['cdn.example.com'], {
    'crm.example.com': { verdict: 'pass', why: own }, 'cdn.example.com': { verdict: 'pass', why: own },
    'erp.acme.localhost': { verdict: 'internal', why: 'It is at an internal address.' }, 'intra.acme.localhost': { verdict: 'internal', why: 'It is at an internal address.' },
  }]);
  assert.ok(w.profile && 'error' in w.profile);
  assert.match(w.profile.error, /OPENROUTER_API_KEY/);
  assert.equal(w.checks!['sso.other.test'], undefined, 'a failed check is not a human decision or a permanent verdict');
  assert.deepEqual(inst.log.filter(e => e.action === 'allowed').map(e => [e.by, e.run, e.site, e.login, e.allowed, e.why]), [['server', 1, 'crm', alice, ['cdn.example.com'], { 'cdn.example.com': own }]]);
  const act = readFileSync(join(tmp, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).findLast(a => a.op === 'hosts');
  assert.deepEqual([act.by, act.person, act.site, act.inst, act.run, act.allowed], ['server', alice, 'crm', inst.id, 1, { 'cdn.example.com': own }]);
  const { allowHost } = await import('../src/browsers.ts');
  await assert.rejects(allowHost({ email: alice, role: 'user' } as never, 'crm', 'intra.acme.localhost'), (e: { status: number }) => e.status === 403, 'only admins allow any host');
});

test('only admins allow hosts, even for their own website within its existing domain or before any grant is approved', async t => {
  const { allowHost } = await import('../src/browsers.ts');
  t.after(() => writeJson('grants.json', everyone));
  for (const verdict of ['pass', 'refused', 'high', 'internal']) {
    sites({ crm: { url: 'https://crm.example.com/', hosts: [], writeback: false, checks: { 'upload.example.com': { verdict, why: 'Wait for an admin.' } } } });
    await assert.rejects(allowHost({ email: alice, role: 'user' } as never, 'crm', 'upload.example.com'), (e: { status: number }) => e.status === 403);
    assert.deepEqual(websitesOf(alice).crm.hosts, []);
    await allowHost(asPerson(alice)!, 'crm', 'upload.example.com');
    assert.deepEqual(websitesOf(alice).crm.hosts, ['upload.example.com']);
  }
  writeJson('grants.json', {});
  await assert.rejects(allowHost({ email: alice, role: 'user' } as never, 'crm', 'no-grant.example.com'), (e: { status: number }) => e.status === 403, 'not even before any workspace has approved the login');
});

test('removing a host keeps open sign-in restricted to approved exact internal exceptions', async () => {
  const { removeHost } = await import('../src/browsers.ts');
  sites({ crm: { url: 'https://crm.example.com/', hosts: ['cdn.example.com'], writeback: false } });
  const id = await startSignIn(alice, 'crm', ''), before = toldHosts.length;
  try {
    await removeHost(alice, 'crm', 'cdn.example.com');
    assert.deepEqual(toldHosts.slice(before), [{ path: `/sessions/${id}/hosts`, hosts: [] }], 'open sign-in retains no public allowlist or implicit internal exception');
  } finally {
    await endSignIn(alice, id, false);
  }
});

test('two hosts allowed at once both stay on the website', async () => {
  const { allowHost } = await import('../src/browsers.ts');
  sites({ crm: { url: 'https://crm.example.com/', hosts: [], writeback: false } });
  await Promise.all(['one.example.com', 'two.example.com'].map(h => allowHost(asPerson(alice)!, 'crm', h)));
  assert.deepEqual(websitesOf(alice).crm.hosts.sort(), ['one.example.com', 'two.example.com']);
});

test("an admin's internal exception is exact and shared: anyone signs in there, but still only admins allow another host", async () => {
  const { addSite, allowHost, setSite } = await import('../src/browsers.ts'), { letIn } = await import('../src/connections.ts');
  const alice = 'alice@demo.test', bob = 'bob@demo.test', carol = 'carol@demo.test', admin = { email: alice, role: 'admin' } as never, user = (email: string) => ({ email, role: 'user' }) as never;
  sites({});
  for (const p of [alice, bob, carol]) await addSite(p, 'intra', 'https://10.1.2.3/');
  await assert.rejects(startSignIn(bob, 'intra', ''), /^Error: 10\.1\.2\.3 is at an internal address: a website reaches one only where an admin lets it$/);
  await assert.rejects(allowHost(user(bob), 'intra', '10.9.8.7'), (e: { status: number }) => e.status === 403);
  await assert.rejects(setSite(user(bob), 'intra', { internal: 'true' }), /^Error: internal: admins set it$/);

  // The admin lets their own website at it reach internal addresses: everyone's at it does too.
  await setSite(admin, 'intra', { internal: 'true' });
  assert.deepEqual(Object.keys(letIn()), ['10.1.2.3']);
  for (const p of [bob, carol]) {
    await endSignIn(p, await startSignIn(p, 'intra', ''), false);
    assert.equal(opened.at(-1)!.site.open, true);
    assert.ok(opened.at(-1)!.site.hosts.includes('10.1.2.3'), `${p}'s sign-in reaches the approved exact internal host`);
    assert.ok(!opened.at(-1)!.site.hosts.includes('10.9.8.7'), 'not an unapproved internal host');
    assert.ok(!('internal' in websitesOf(p).intra), 'nothing set on their website itself');
  }

  await setSite(admin, 'intra', { internal: 'true' }, bob);

  await allowHost(admin, 'intra', '10.9.8.7');
  await assert.rejects(allowHost(user(bob), 'intra', '10.9.8.7'), (e: { status: number }) => e.status === 403, 'shared internal reach is not permission for a person to allow hosts');
  await allowHost(admin, 'intra', '10.9.8.7', bob);
  assert.deepEqual(websitesOf(bob).intra.hosts, ['10.9.8.7']);
  const acts = readFileSync(join(tmp, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a.op === 'internal');
  assert.deepEqual(acts.map(a => [a.by, a.person, a.site, a.hosts, a.let]), [[alice, alice, 'intra', ['10.1.2.3'], true], [alice, bob, 'intra', ['10.1.2.3'], true], [alice, alice, 'intra', ['10.9.8.7'], true]]);

  // An admin lets it no more: no one's website reaches those hosts until one lets them again.
  await setSite(admin, 'intra', { internal: 'false' });
  assert.deepEqual(Object.keys(letIn()), []);
  for (const p of [alice, bob, carol]) await assert.rejects(startSignIn(p, 'intra', ''), /is at an internal address/);
  sites({});
});

test('old website internal flags do not let browsers reach hosts absent from the shared record', async () => {
  sites({ crm: { url: 'https://crm.example.com/', hosts: ['10.1.2.3'], writeback: false, internal: true } });
  saveLogin(alice, website('crm', 'CRM'), '{}');
  const browsers = new Browsers(running('internal-removed', ['web:crm']), 1);
  try {
    await browsers.browser('crm');
    assert.equal(publics.at(-1), true);
  } finally {
    await browsers.close();
  }
});

test("a website set --internal true before 0.3.12 keeps its reach: at the server's start its hosts at internal addresses join the shared record and its flag goes, but for a host an admin took out since, and one that resolves nowhere yet waits for the next start", async () => {
  const { enrolFlagged } = await import('../src/browsers.ts'), { letIn, setLetIn } = await import('../src/connections.ts');
  // 10.1.2.3 an admin took out above.
  sites({ crm: { url: 'https://crm.example.com/', hosts: ['10.4.5.6', '10.1.2.3'], writeback: false, internal: true }, later: { url: 'https://later.invalid/', hosts: [], writeback: false, internal: true } });
  await enrolFlagged();
  assert.deepEqual(Object.entries(letIn()).map(([h, { by }]) => [h, by]), [['10.4.5.6', 'server']]);
  assert.deepEqual(websitesOf(alice), { crm: { url: 'https://crm.example.com/', hosts: ['10.4.5.6', '10.1.2.3'], writeback: false }, later: { url: 'https://later.invalid/', hosts: [], writeback: false, internal: true } });
  const act = readFileSync(join(tmp, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).findLast(a => a.person === alice);
  assert.deepEqual([act.by, act.op, act.site, act.hosts, act.let], ['server', 'internal', 'crm', ['10.4.5.6'], true]);
  saveLogin(alice, website('crm', 'CRM'), '{}');
  const browsers = new Browsers(running('internal-kept', ['web:crm']), 1);
  try {
    await browsers.browser('crm');
    assert.equal(publics.at(-1), false);
  } finally {
    await browsers.close();
  }
  setLetIn(['10.4.5.6'], alice, false);
  sites({});
});

test('a host that gets a verdict while the model answers keeps it, including one its person removed', async t => {
  const { allowHost, changeWebsite, removeHost } = await import('../src/browsers.ts');
  let answer!: () => void, asked!: () => void;
  const gate = new Promise<void>(ok => { answer = ok; }), seen = new Promise<void>(ok => { asked = ok; });
  const stand = createServer(async (req, res) => {
    await Array.fromAsync(req);
    asked();
    await gate;
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify({ hosts: Object.fromEntries(['cdn.other.test', 'upload.other.test', 'done.other.test'].map(h => [h, { verdict: 'pass', why: 'Its CDN.' }])), profile: { what: 'A company CRM.', category: 'company', risk: 'low', flags: [] } }) + '\n```' } }] }));
  });
  await new Promise<void>(ok => stand.listen(0, '127.0.0.1', ok));
  upstreams['openrouter.ai'] = `http://127.0.0.1:${(stand.address() as { port: number }).port}`;
  process.env.OPENROUTER_API_KEY = 'key';
  t.after(() => {
    answer();
    delete process.env.OPENROUTER_API_KEY;
    delete upstreams['openrouter.ai'];
    stand.close();
    requested = plain;
  });
  sites({ crm: { url: 'https://crm.example.com/', hosts: [], writeback: false } });
  saveLogin(alice, website('crm', 'CRM'), '{}');
  requested = refusing('https://cdn.other.test/a.js', 'https://upload.other.test/x', 'https://done.other.test/a.js');
  const browsers = new Browsers(running('verdict-during-check', ['web:crm']), 1);
  await browsers.browser('crm');
  await browsers.close();
  requested = plain;
  await seen;
  await allowHost(asPerson(alice)!, 'crm', 'cdn.other.test');
  await removeHost(alice, 'crm', 'cdn.other.test');
  const high = { verdict: 'high' as const, why: 'An earlier check.' };
  changeWebsite(alice, 'crm', { checks: { ...websitesOf(alice).crm.checks, 'upload.other.test': high } });
  answer();
  const w = await checked('crm', ['done.other.test']);
  assert.deepEqual(w.hosts, ['done.other.test']);
  assert.deepEqual(w.checks?.['cdn.other.test'], { verdict: 'refused', why: 'Its person removed it.' });
  assert.deepEqual(w.checks?.['upload.other.test'], high);
});

test("the shared website check profiles the site, accepts fenced answers, uses at most five model-chosen Exa searches, and never sends paths or queries", async t => {
  const asked: { url: string; body: any }[] = [], profile = { what: 'A company CRM.', category: 'company', risk: 'low', flags: ['Can submit records.'] };
  let searched = false, count = 5;
  const stand = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    asked.push({ url: req.url!, body });
    if (req.url === '/search') return res.end(JSON.stringify({ results: [{ title: 'CRM provider', url: 'https://about.test/', highlights: ['Company portal.'] }] }));
    if (!searched) {
      searched = true;
      assert.ok(body.tools.length, 'the model chooses its searches through a tool');
      return res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: Array.from({ length: count }, (_, i) => ({
        id: `search-${i}`, type: 'function', function: { name: body.tools[0].function.name, arguments: JSON.stringify({ query: `CRM provider ${i}` }) },
      })) } }] }));
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify({
      hosts: { 'static.cdnhost.test': { verdict: 'pass', why: 'Its CDN.' }, 'www.tracker.test': { verdict: 'refused', why: 'Analytics.' }, 'upload.elsewhere.test': { verdict: 'high', why: 'Data upload destination.' } }, profile,
    }) + '\n```' } }] }));
  });
  await new Promise<void>(ok => stand.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(stand.address() as { port: number }).port}`;
  Object.assign(upstreams, { 'openrouter.ai': base, 'api.exa.ai': base });
  Object.assign(process.env, { OPENROUTER_API_KEY: 'the-key', EXA_API_KEY: 'the-exa-key' });
  t.after(() => {
    for (const k of ['OPENROUTER_API_KEY', 'EXA_API_KEY']) delete process.env[k];
    for (const h of ['openrouter.ai', 'api.exa.ai']) delete upstreams[h];
    stand.close();
    requested = plain;
  });
  sites({ crm: { url: 'https://crm.example.com/private-login?token=secret', hosts: [], writeback: false } });
  saveLogin(alice, website('crm', 'CRM'), JSON.stringify(state('secret-cookie')));
  const inst = running('2028-02', ['web:crm'], 2);
  inst.append('server', 'browser', { run: 1, site: 'crm', login: alice, requests: 3, writes: 0, blocked: 3, file: 'browser/run 1 crm.jsonl', hosts: { 'upload.elsewhere.test': 3 } });
  requested = refusing({ url: 'https://static.cdnhost.test/private-script.js?v=secret', dest: 'script', from: 'https://crm.example.com/private-report?id=secret' },
    { url: 'https://static.cdnhost.test/private-style.css', dest: 'style', from: 'https://crm.example.com/private-report?id=secret' },
    'https://www.tracker.test/private-pixel?key=secret', { url: 'https://upload.elsewhere.test/private-upload', dest: 'empty', from: 'https://crm.example.com/' });
  const browsers = new Browsers(inst, 2);
  await browsers.browser('crm');
  await browsers.close();
  requested = plain;
  const w = await checked('crm', ['static.cdnhost.test', 'www.tracker.test', 'upload.elsewhere.test']);
  const models = asked.filter(a => a.url === '/api/v1/chat/completions'), searches = asked.filter(a => a.url === '/search');
  assert.equal(searches.length, 5, 'five model-chosen searches share one conversation');
  assert.ok(searches.every(a => /^CRM provider \d$/.test(a.body.query)), 'queries came from the model, not one fixed search per host');
  assert.ok(models.every(a => a.body.provider.data_collection === 'deny'));
  const evidence = JSON.parse(models[0].body.messages[1].content), serialized = JSON.stringify(evidence);
  for (const host of ['crm.example.com', 'static.cdnhost.test', 'www.tracker.test', 'upload.elsewhere.test']) assert.ok(serialized.includes(host), host);
  for (const kind of ['script', 'style', 'empty']) assert.ok(serialized.includes(kind), kind);
  assert.doesNotMatch(serialized, /private-|secret|token=|id=|secret-cookie/);
  assert.deepEqual(w.profile, profile, 'the same check stores the website profile');
  assert.deepEqual([w.hosts, w.checks], [['static.cdnhost.test'], {
    'crm.example.com': { verdict: 'pass', why: "It is within example.com, the website's own domain." },
    'static.cdnhost.test': { verdict: 'pass', why: 'Its CDN.' }, 'www.tracker.test': { verdict: 'refused', why: 'Analytics.' }, 'upload.elsewhere.test': { verdict: 'high', why: 'Data upload destination.' },
  }], 'the model passes required assets, refuses analytics and leaves upload exceptions for admins');
  assert.deepEqual(inst.log.filter(e => e.action === 'allowed').map(e => [e.allowed, e.why]), [[['static.cdnhost.test'], { 'static.cdnhost.test': 'Its CDN.' }]]);
  const { checkWebsite } = await import('../src/browsers.ts'), before = asked.length;
  [searched, count] = [false, 7];
  sites({ crm: { url: 'https://crm.example.com', hosts: [], writeback: false } });
  const result = await checkWebsite(alice, 'crm', { requests: { 'needs-check.other.test': { 403: 1 } }, blocked: ['needs-check.other.test'], seconds: 1 });
  assert.ok('error' in result);
  assert.match(result.error, /exceeded|limit|budget/i, 'a model requesting too many searches fails the check, not the login');
  assert.equal(asked.slice(before).filter(a => a.url === '/search').length, 5, 'seven requested searches never exceed the five-search cap');
  assert.equal(websitesOf(alice).crm.checks!['needs-check.other.test'], undefined, 'failed model work remains retryable');
  assert.equal(websitesOf(alice).crm.checks!['crm.example.com'].verdict, 'pass', 'the rules survive a failed search/model check');
  const acts = readFileSync(join(rfDir(), 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)), last = acts.findLast(a => a.op === 'website-check');
  assert.equal(last.queries.length, 5);
  assert.doesNotMatch(JSON.stringify(last), /private-|secret-cookie|token=/);
});
