import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, readJson, rfDir, saveTree, writeJson } from '../src/system.ts';
import { createInstance, openStore } from '../src/store.ts';
import type { Me } from '../src/auth.ts';

const alice: Me = { email: 'alice@company.test', name: 'Alice', role: 'user', groups: [] };
const bob: Me = { email: 'bob@company.test', name: 'Bob', role: 'user', groups: [] };
const admin: Me = { email: 'admin@company.test', name: 'Admin', role: 'admin', groups: [] };
const owner: Me = { email: 'owner@company.test', name: 'Owner', role: 'user', groups: [] };
const definition = { type: 'fortinet' as const, gateway: 'vpn.gateway.test:10443' };
const home = mkdtempSync(join(tmpdir(), 'rf-vpns-'));
let root = '', serial = 0, browserError = '', tunnelError = '', deleteError = '', listError = '', blocked = new Set<string>();
let back: any = { cookies: [], origins: [] }, listGate: Promise<void> | undefined, onList: (() => void) | undefined;
let openGate: Promise<void> | undefined, closeGate: Promise<void> | undefined, postGate: Promise<void> | undefined;
let onOpen: (() => void) | undefined, onClose: (() => void) | undefined, onPost: (() => void) | undefined;
const browserCalls: any[] = [], tunnelCalls: any[] = [], events: string[] = [], models: any[] = [], lookups: string[] = [], searches: string[] = [];
let toolQueries: string[] = [], modelProfile = { what: 'A client reporting system.', category: 'company', risk: 'medium', flags: [] as string[] };
const sessions = new Map<string, any>(), remote = new Map<string, { id: string; up: boolean }>();

const browser = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://browser');
  const text = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString();
  const body = text ? JSON.parse(text) : undefined;
  browserCalls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
  events.push(`${req.method} browser${url.pathname}`);
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer browser-key') return void res.writeHead(401).end('{"error":"bad browser key"}');
  if (browserError) return void res.writeHead(503).end(JSON.stringify({ error: browserError }));
  if (url.pathname === '/blocked') return void res.end(JSON.stringify(Object.fromEntries(url.searchParams.getAll('host').map(h => [h, blocked.has(h)]))));
  if (url.pathname === '/sessions' && req.method === 'POST') {
    const id = `b${++serial}`;
    sessions.set(id, body);
    const gate = openGate;
    openGate = undefined; onOpen?.(); onOpen = undefined;
    await gate;
    return void res.writeHead(201).end(JSON.stringify({ id }));
  }
  if (url.pathname === '/sessions') return void res.end(JSON.stringify([...sessions.keys()].map(id => ({ id }))));
  const id = url.pathname.split('/')[2], session = sessions.get(id);
  if (!session) return void res.writeHead(404).end('{"error":"no session"}');
  if (req.method === 'DELETE') {
    sessions.delete(id);
    const state = back, gate = closeGate;
    closeGate = undefined; onClose?.(); onClose = undefined;
    await gate;
    return void res.end(JSON.stringify({ state, log: [] }));
  }
  if (url.pathname.endsWith('/page')) return void res.end(JSON.stringify({ url: session.site.start_url, password: false }));
  if (url.pathname.endsWith('/log')) return void res.end(JSON.stringify([{ method: 'GET', url: session.site.start_url, status: 200, live: true }]));
  res.end('{}');
});
const service = createServer(async (req, res) => {
  const text = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString(), body = text ? JSON.parse(text) : undefined;
  tunnelCalls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
  events.push(`${req.method} tunnel${req.url}`);
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer tunnel-key') return void res.writeHead(401).end('{"error":"bad tunnel key"}');
  if (req.method === 'GET') {
    onList?.();
    await listGate;
    if (listError) return void res.writeHead(503).end(JSON.stringify({ error: listError }));
    return void res.end(JSON.stringify([...remote.values()]));
  }
  if (req.method === 'POST') {
    if (tunnelError) return void res.writeHead(502).end(JSON.stringify({ error: tunnelError }));
    const id = `t${++serial}`;
    remote.set(id, { id, up: true });
    const gate = postGate;
    postGate = undefined; onPost?.(); onPost = undefined;
    await gate;
    return void res.writeHead(201).end(JSON.stringify({ id, token: `private-token-${id}` }));
  }
  if (deleteError) return void res.writeHead(502).end(JSON.stringify({ error: deleteError }));
  const id = req.url!.split('/')[2];
  if (!remote.delete(id)) return void res.writeHead(404).end('{"error":"no such tunnel"}');
  res.end('{}');
});
const modelService = createServer(async (req, res) => {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  if (req.url === '/search') {
    searches.push(body.query);
    return void res.end(JSON.stringify({ results: [{ url: 'https://login.identity.test/', highlights: ['Business sign-on.'] }] }));
  }
  models.push(body);
  if (toolQueries.length && body.messages.length === 2) return void res.end(JSON.stringify({ choices: [{ message: { tool_calls: toolQueries.map((query, n) => ({ id: `search${n}`, type: 'function', function: { name: 'search', arguments: JSON.stringify({ query }) } })) } }] }));
  const evidence = JSON.parse(body.messages[1].content);
  const hosts = Object.fromEntries(evidence.unchecked.map((h: string) => [h, { verdict: 'pass', why: 'A necessary public sign-on dependency.' }]));
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ profile: modelProfile, hosts }) } }] }));
});
await Promise.all([browser, service, modelService].map(s => new Promise<void>(ok => s.listen(0, '127.0.0.1', ok))));
const browserUrl = `http://127.0.0.1:${(browser.address() as { port: number }).port}`;
const tunnelUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: browserUrl, RF_BROWSER_KEY: 'browser-key', RF_TUNNEL_URL: tunnelUrl, RF_TUNNEL_KEY: 'tunnel-key', RF_TUNNEL_PROXY: 'https://proxy.company.test:8799', RF_PUBLIC_URL: 'https://rf.company.test' });
const { addVpn, cancelVpnSignIn, disconnectVpn, isVpnSignIn, reapVpns, removeVpn, saveVpnSignIn, startVpnSignIn, vpnHosts, vpns, vpnVia } = await import('../src/vpns.ts');
const { Browsers, addSite, allowHost, changeWebsite, checkWebsite, endSignIn, keepAlive, serveBrowsers, setSite, startSignIn, websitesOf } = await import('../src/browsers.ts');
const { CAPS, can } = await import('../src/auth.ts');
const { logins, personDir, saveLogin, secret } = await import('../src/logins.ts');
const { visible } = await import('../src/grants.ts');
const { checkHost, covers, upstreams } = await import('../src/connections.ts');
upstreams['openrouter.ai'] = upstreams['api.exa.ai'] = `http://127.0.0.1:${(modelService.address() as { port: number }).port}`;
mock.method(dns, 'lookup', async (host: string) => {
  lookups.push(host);
  return [{ address: host.endsWith('.client.test') || host === 'private.other.test' || host.startsWith('10.') ? '10.2.3.4' : '8.8.8.8', family: 4 }];
});
syncBuiltinESMExports();
after(() => { mock.restoreAll(); syncBuiltinESMExports(); browser.close(); service.close(); modelService.close(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  Object.assign(process.env, { RF_TUNNEL_URL: tunnelUrl, RF_TUNNEL_KEY: 'tunnel-key', RF_TUNNEL_PROXY: 'https://proxy.company.test:8799', RF_BROWSER_KEY: 'browser-key', RF_PUBLIC_URL: 'https://rf.company.test' });
  delete process.env.RF_SIGNIN_S;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.EXA_API_KEY;
  toolQueries = [];
  modelProfile = { what: 'A client reporting system.', category: 'company', risk: 'medium', flags: [] };
  browserError = tunnelError = deleteError = listError = '';
  listGate = openGate = closeGate = postGate = undefined;
  onList = onOpen = onClose = onPost = undefined;
  await reapVpns();
  root = mkdtempSync(join(home, 'case-'));
  initSystem(root); openStore(root);
  saveTree({ workspaces: { w: { name: 'Client work', owners: [owner.email], members: [alice.email, bob.email] } }, series: { s: { name: 'Weekly work', workspace: 'w' } } });
  writeJson('users.json', Object.fromEntries([alice, bob, admin, owner].map(p => [p.email, { name: p.name, role: p.role }])));
  writeJson('capabilities.json', { vpn: [alice.email, bob.email, admin.email], keepalive: [alice.email, bob.email] });
  writeJson('connections.json', { m365: { type: 'graph' }, db: { type: 'databricks' } });
  writeJson('internal.json', {});
  addVpn(admin, 'client', definition);
  back = { cookies: [], origins: [] }; blocked = new Set(); sessions.clear();
  browserCalls.length = tunnelCalls.length = events.length = models.length = lookups.length = searches.length = 0;
});
const cookieState = (value = 'vpn-cookie-secret', domain = 'vpn.gateway.test') => ({ cookies: [{ name: 'SVPNCOOKIE', value, domain, path: '/', expires: -1 }], origins: [] });
const connectVpn = async (person = alice, name = 'client') => {
  back = cookieState();
  const id = await startVpnSignIn(person, name);
  await saveVpnSignIn(person, id);
  return tunnelCalls.findLast(c => c.method === 'POST')!;
};
const site = async (person = alice, name = 'portal', url = 'https://erp.client.test/sign-in') => {
  await addSite(person.email, name, url);
  await setSite(person, name, { via: 'client' });
  saveLogin(person.email, { id: `web:${name}`, kind: 'website', name, since: new Date().toISOString(), offers: [{ id: `web:${name}`, name }] }, JSON.stringify({ cookies: [], origins: [] }));
  const all = readJson<Record<string, unknown>>('grants.json', {});
  all[`${person.email} ${name}`] = { workspace: 'w', person: person.email, site: name, reason: 'Client reporting', at: '', state: 'approved' };
  writeJson('grants.json', all);
};
const running = (person = alice, name = 'portal') => {
  const inst = createInstance('s', `case-${++serial}`, person.email, [`web:${name}`]);
  inst.append('server', 'run', { run: 1, runner: person.email, consent: 1 });
  return new Browsers(inst, 1);
};
const disk = () => readdirSync(root, { recursive: true }).map(p => join(root, String(p))).filter(p => statSync(p).isFile()).map(p => readFileSync(p).toString()).join('\n');

test('VPN capability is explicit for every role, supports groups, and needs a configured service without changing ordinary capabilities', () => {
  assert.ok(CAPS.includes('vpn'));
  writeJson('capabilities.json', {});
  assert.equal(can(admin, 'vpn'), false);
  assert.equal(can(alice, 'vpn'), false);
  for (const cap of ['publish', 'create', 'keepalive']) assert.equal(can(admin, cap), true);
  writeJson('capabilities.json', { vpn: ['vpn-group'], create: [alice.email] });
  assert.equal(can({ ...alice, groups: ['vpn-group'] }, 'vpn'), true);
  assert.equal(can(alice, 'create'), true);
  delete process.env.RF_TUNNEL_URL;
  assert.equal(can({ ...admin, groups: ['vpn-group'] }, 'vpn'), false);
  assert.equal(can(admin, 'create'), true);
});

test('all VPN controls require explicit capability; only opted-in admins may define or remove', async () => {
  assert.throws(() => addVpn(alice, 'other', definition), /admins define VPNs/);
  await assert.rejects(removeVpn(alice, 'client'), /admins define VPNs/);
  writeJson('capabilities.json', {});
  assert.throws(() => addVpn(admin, 'other', definition), /explicit vpn capability/);
  for (const action of [() => vpns(admin), () => removeVpn(admin, 'client'), () => startVpnSignIn(admin, 'client'), () => saveVpnSignIn(admin, 'b1'), () => cancelVpnSignIn(admin, 'b1'), () => disconnectVpn(admin, 'client')])
    await assert.rejects(action(), /explicit vpn capability/);
  assert.equal(browserCalls.length, 0);
  assert.equal(tunnelCalls.length, 0);
});

test('definitions validate fortinet gateway host:port and an optional key pin, and persist only the declared fields', async () => {
  for (const gateway of ['vpn.gateway.test', 'https://vpn.gateway.test:443', 'vpn.gateway.test:0', 'vpn.gateway.test:65536', 'vpn.gateway.test:443/path', 'person@vpn.gateway.test:443'])
    assert.throws(() => addVpn(admin, 'invalid', { ...definition, gateway }), /gateway: host:port/);
  assert.throws(() => addVpn(admin, 'invalid', { ...definition, type: 'other' as never }), /type: fortinet/);
  assert.throws(() => addVpn(admin, '../invalid', definition), /VPN's name/);
  addVpn(admin, 'second', { ...definition, cookie: 'not-persisted', token: 'not-persisted' } as never);
  assert.deepEqual(JSON.parse(readFileSync(join(rfDir(), 'vpns.json'), 'utf8')).second, definition);
  assert.equal(disk().includes('not-persisted'), false);
  for (const servercert of ['sha256:abc', 'pin-sha256:short=', `pin-sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=x`]) assert.throws(() => addVpn(admin, 'pinned', { ...definition, servercert }), /servercert: /);
  addVpn(admin, 'pinned', { ...definition, servercert: 'pin-sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  assert.deepEqual((await connectVpn(alice, 'pinned')).body, { ...definition, servercert: 'pin-sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', cookie: 'SVPNCOOKIE=vpn-cookie-secret' }, 'the pin goes to the tunnel service with the cookie');
});

test('VPN sign-in is a short open browser, with protected hosts excluded and no website or sealed login', async () => {
  process.env.RF_SIGNIN_S = '30';
  const id = await startVpnSignIn(alice, 'client'), opened = sessions.get(id);
  assert.equal(opened.ttl_s, 30);
  assert.equal(opened.site.start_url, 'https://vpn.gateway.test:10443/remote/saml/start');
  assert.equal(opened.site.open, true);
  assert.deepEqual(opened.site.hosts, []);
  for (const host of ['rf.company.test', '127.0.0.1', 'proxy.company.test', 'graph.microsoft.com', '*.azuredatabricks.net']) assert.ok(opened.site.except.includes(host), host);
  assert.equal(opened.site.via, undefined);
  assert.equal(isVpnSignIn(alice.email, id), true);
  assert.equal(isVpnSignIn(bob.email, id), false);
  await assert.rejects(saveVpnSignIn(bob, id), { status: 404 });
  assert.equal(existsSync(personDir(alice.email)), false);
  await cancelVpnSignIn(alice, id);
  assert.equal(isVpnSignIn(alice.email, id), false);
  assert.equal(tunnelCalls.length, 0);
});

test('sign-in ownership ends on capability revocation; expired IDs stay recognizable for Save rejection and Cancel cleanup', async () => {
  const first = await startVpnSignIn(alice, 'client');
  writeJson('capabilities.json', { vpn: [admin.email] });
  assert.equal(isVpnSignIn(alice.email, first), false);
  await assert.rejects(saveVpnSignIn(alice, first), { status: 403 });
  writeJson('capabilities.json', { vpn: [alice.email, admin.email] });
  await cancelVpnSignIn(alice, first);
  process.env.RF_SIGNIN_S = '0';
  const expired = await startVpnSignIn(alice, 'client');
  assert.equal(isVpnSignIn(alice.email, expired), true);
  await assert.rejects(saveVpnSignIn(alice, expired), { status: 410 });
  assert.equal(sessions.has(expired), false);
  const canceled = await startVpnSignIn(alice, 'client');
  await cancelVpnSignIn(alice, canceled);
  assert.equal(sessions.has(canceled), false);
  assert.equal(tunnelCalls.length, 0);
});

test('Save closes the browser before posting only the gateway SVPNCOOKIE, never its SSO cookies or state', async () => {
  const id = await startVpnSignIn(alice, 'client');
  back = { cookies: [...cookieState('wrong', 'identity.test').cookies, ...cookieState('correct-cookie', '.gateway.test').cookies], origins: [{ origin: 'https://identity.test', localStorage: [{ name: 'secret', value: 'never-send' }] }] };
  await saveVpnSignIn(alice, id);
  const posted = tunnelCalls.find(c => c.method === 'POST');
  assert.deepEqual(posted.body, { ...definition, cookie: 'SVPNCOOKIE=correct-cookie' });
  assert.equal(events.indexOf(`DELETE browser/sessions/${id}`) < events.indexOf('POST tunnel/tunnels'), true);
  assert.equal(posted.authorization, 'Bearer tunnel-key');
  assert.ok(browserCalls.every(c => c.authorization === 'Bearer browser-key'));
  const rows = await vpns(alice);
  assert.equal(rows[0].connected, true);
  assert.ok(rows[0].since);
  assert.equal(/token|cookie|"id"/.test(JSON.stringify(rows)), false);
  assert.equal(disk().includes('correct-cookie'), false);
  assert.equal(disk().includes('private-token-'), false);
  assert.equal(existsSync(personDir(alice.email)), false);
});

test('unrelated, expired, malformed and absent gateway cookies never create tunnels', async () => {
  for (const state of [cookieState('secret', 'vpn.gateway.test.evil.test'), cookieState('secret', 'gateway.test'), cookieState('secret', '.identity.test'), cookieState('bad;cookie'), cookieState('bad cookie'), { cookies: [{ ...cookieState().cookies[0], expires: 1 }], origins: [] }, { cookies: [], origins: [] }]) {
    const id = await startVpnSignIn(alice, 'client');
    back = state;
    await assert.rejects(saveVpnSignIn(alice, id), /no SVPNCOOKIE/);
    assert.equal(sessions.has(id), false);
  }
  assert.equal(tunnelCalls.length, 0);
});

test('browser and tunnel authentication and service errors retain actionable service text', async () => {
  process.env.RF_BROWSER_KEY = 'wrong';
  await assert.rejects(startVpnSignIn(alice, 'client'), /browser service: bad browser key/);
  process.env.RF_BROWSER_KEY = 'browser-key';
  browserError = 'blocklists not loaded yet';
  await assert.rejects(startVpnSignIn(alice, 'client'), /blocklists not loaded yet/);
  browserError = '';
  process.env.RF_TUNNEL_KEY = 'wrong';
  await assert.rejects(connectVpn(), /tunnel service: bad tunnel key/);
  process.env.RF_TUNNEL_KEY = 'tunnel-key';
  tunnelError = 'openconnect exited with code 2: cookie rejected';
  await assert.rejects(connectVpn(), /openconnect exited with code 2: cookie rejected/);
  assert.equal((await vpns(alice))[0].connected, false);
});

test('reconnect replaces only the same person and VPN, and concurrent saves leave one tunnel for that pair', async () => {
  addVpn(admin, 'second', definition);
  await connectVpn();
  await connectVpn(bob);
  await connectVpn(alice, 'second');
  const original = [...remote.keys()][0];
  await connectVpn();
  assert.equal(remote.has(original), false);
  assert.equal(remote.size, 3);
  assert.equal((await vpns(bob))[0].connected, true);
  assert.ok((await vpns(alice)).every(v => v.connected));
  const concurrent = await Promise.allSettled([connectVpn(), connectVpn()]);
  assert.ok(concurrent.some(r => r.status === 'fulfilled'));
  assert.equal(remote.size, 3);
  await disconnectVpn(alice, 'client');
  assert.equal(remote.size, 2);
  assert.equal((await vpns(bob))[0].connected, true);
  assert.equal((await vpns(alice)).find(v => v.name === 'second')!.connected, true);
});

test('failed reconnect deletes the old tunnel without retaining stale state; failed deletes are surfaced', async () => {
  await connectVpn();
  const old = [...remote.keys()][0];
  deleteError = 'sign-out did not finish';
  await assert.rejects(connectVpn(), /sign-out did not finish/);
  assert.equal(remote.has(old), true);
  deleteError = ''; tunnelError = 'gateway refused the new cookie';
  await assert.rejects(connectVpn(), /gateway refused the new cookie/);
  assert.equal(remote.size, 0);
  assert.equal((await vpns(alice))[0].connected, false);
});

test('remote up false and missing tunnels are disconnected and never returned as a browser proxy', async () => {
  await connectVpn();
  const id = [...remote.keys()][0];
  remote.get(id)!.up = false;
  assert.equal((await vpns(alice))[0].connected, false);
  await assert.rejects(vpnVia(alice.email, { url: 'https://erp.client.test/', via: 'client' }), /is down/);
  remote.delete(id);
  assert.match((await vpns(alice))[0].error!, /ended/);
  await assert.rejects(vpnVia(alice.email, { url: 'https://erp.client.test/', via: 'client' }), /ended/);
  await disconnectVpn(alice, 'client');
  assert.equal((await vpns(alice))[0].since, undefined);
});

test('startup deletes every service tunnel and forgets local connection memory, without persisting runtime secrets', async () => {
  await connectVpn(); await connectVpn(bob);
  remote.set('leftover-other-process', { id: 'leftover-other-process', up: false });
  const runtimeIds = [...remote.keys()];
  await reapVpns();
  assert.equal(remote.size, 0);
  for (const id of runtimeIds) {
    assert.ok(tunnelCalls.some(c => c.method === 'DELETE' && c.path === `/tunnels/${id}`));
    assert.equal(disk().includes(id), false);
  }
  assert.equal((await vpns(alice))[0].connected, false);
  assert.equal(disk().includes('vpn-cookie-secret'), false);
  assert.equal(disk().includes('private-token-'), false);
  delete process.env.RF_TUNNEL_URL;
  const calls = tunnelCalls.length;
  await reapVpns();
  assert.equal(tunnelCalls.length, calls);
});

test('removing a definition deletes every person\'s tunnel for it, leaving other VPN definitions and tunnels', async () => {
  addVpn(admin, 'second', definition);
  await connectVpn(); await connectVpn(bob); await connectVpn(alice, 'second');
  await removeVpn(admin, 'client');
  assert.equal(remote.size, 1);
  assert.deepEqual((await vpns(alice)).map(v => [v.name, v.connected]), [['second', true]]);
  assert.equal(Object.hasOwn(readJson('vpns.json', {}), 'client'), false);
});

test('website via is explicitly gated, validated, preserved by other settings, and cleared with an empty value', async () => {
  await site();
  writeJson('capabilities.json', { vpn: [alice.email] });
  await assert.rejects(setSite(admin, 'portal', { via: '' }, alice.email), { status: 403 });
  await assert.rejects(setSite(bob, 'missing', { via: '' }), /explicit vpn capability/);
  await assert.rejects(setSite(alice, 'portal', { via: 'unknown' }), { status: 404 });
  await assert.rejects(setSite(alice, 'portal', { via: false }), /a VPN name/);
  await setSite(alice, 'portal', { every: '9m', writeback: false });
  assert.equal(websitesOf(alice.email).portal.via, 'client');
  await setSite(alice, 'portal', { via: '' });
  assert.equal(Object.hasOwn(websitesOf(alice.email).portal, 'via'), false);
});

test('website sign-in needs its own person\'s VPN and routes only its registrable domain, keeping SSO/CDNs direct', async () => {
  await site();
  await assert.rejects(startSignIn(alice.email, 'portal', ''), /connect VPN client first/);
  await connectVpn(bob);
  await assert.rejects(startSignIn(alice.email, 'portal', ''), /connect VPN client first/);
  await connectVpn();
  const id = await startSignIn(alice.email, 'portal', ''), opened = sessions.get(id);
  assert.equal(opened.site.open, true);
  assert.deepEqual(opened.site.via.hosts, ['client.test', '*.client.test']);
  assert.equal(opened.site.via.url, process.env.RF_TUNNEL_PROXY);
  assert.ok(opened.site.via.token.startsWith('private-token-'));
  assert.ok(opened.site.via.hosts.every((p: string) => !covers(p, 'login.identity.test') && !covers(p, 'cdn.vendor.test')));
  for (const host of ['127.0.0.1', 'proxy.company.test']) assert.ok(opened.site.except.includes(host), `the tunnel's ${host} is excepted`);
  await assert.rejects(checkHost('proxy.company.test', true), /rollforward's own/);
  assert.equal(lookups.includes('erp.client.test'), false);
  await endSignIn(alice.email, id, false);
  assert.deepEqual(vpnHosts('https://erp.tenant.github.io/'), ['tenant.github.io', '*.tenant.github.io']);
  assert.deepEqual(vpnHosts('https://10.2.3.4/'), ['10.2.3.4']);
});

test('VPN own-domain rules skip local DNS and admin internal permission but keep blocklists and forbidden host rules', async () => {
  await site();
  process.env.RF_PUBLIC_URL = 'https://rf.client.test';
  blocked.add('malware.client.test');
  process.env.OPENROUTER_API_KEY = 'model-key';
  const hosts = ['erp.client.test', 'assets.client.test', 'malware.client.test', 'rf.client.test', 'graph.microsoft.com', 'private.other.test', 'login.identity.test', 'cdn.vendor.test'];
  const profile = await checkWebsite(alice.email, 'portal', { requests: Object.fromEntries(hosts.map(h => [h, { 200: 1 }])), blocked: [], seconds: 1 });
  assert.ok('category' in profile && profile.category === 'company');
  const w = websitesOf(alice.email).portal;
  assert.equal(w.checks!['erp.client.test'].verdict, 'pass');
  assert.equal(w.checks!['assets.client.test'].verdict, 'pass');
  assert.equal(w.checks!['malware.client.test'].verdict, 'refused');
  assert.equal(w.checks!['rf.client.test'].verdict, 'refused');
  assert.equal(w.checks!['graph.microsoft.com'].verdict, 'refused');
  assert.equal(w.checks!['private.other.test'].verdict, 'internal');
  assert.equal(w.checks!['login.identity.test'].verdict, 'pass');
  assert.equal(w.checks!['cdn.vendor.test'].verdict, 'pass');
  assert.ok(lookups.includes('private.other.test'));
  assert.ok(lookups.includes('login.identity.test'));
  assert.ok(lookups.every(h => !h.endsWith('.client.test')));
  assert.equal(models.length, 1);
  assert.deepEqual(JSON.parse(models[0].messages[1].content).unchecked.sort(), ['cdn.vendor.test', 'login.identity.test']);
  await allowHost(admin, 'portal', 'more.client.test', alice.email);
  assert.equal(lookups.includes('more.client.test'), false);
  assert.deepEqual(Object.keys(readJson('internal.json', {})), []);
});

test('VPN own-host rules do not invent a safe website profile when the shared model check fails, and direct access restores internal checks', async () => {
  await addSite(alice.email, 'portal', 'https://erp.client.test/');
  changeWebsite(alice.email, 'portal', { checks: { 'erp.client.test': { verdict: 'internal', why: 'Locally private.' }, 'removed.client.test': { verdict: 'refused', why: 'Its person removed it.' } } });
  await setSite(alice, 'portal', { via: 'client' });
  assert.match((await checkWebsite(alice.email, 'portal') as { error: string }).error, /OPENROUTER_API_KEY/);
  assert.equal(websitesOf(alice.email).portal.checks!['erp.client.test'].verdict, 'pass');
  assert.equal(models.length, 0);
  assert.equal(lookups.length, 0);
  const dependencies = await checkWebsite(alice.email, 'portal', { requests: { 'login.identity.test': { 200: 1 } }, blocked: [], seconds: 1 });
  assert.match((dependencies as { error: string }).error, /OPENROUTER_API_KEY/);
  assert.equal(websitesOf(alice.email).portal.checks!['login.identity.test'], undefined);
  assert.equal(websitesOf(alice.email).portal.checks!['removed.client.test'].verdict, 'refused');
  await setSite(alice, 'portal', { via: '' });
  await checkWebsite(alice.email, 'portal');
  assert.equal(websitesOf(alice.email).portal.checks!['erp.client.test'].verdict, 'internal');
  assert.ok(lookups.includes('erp.client.test'));
});

test('selecting or clearing a VPN preserves known general-purpose and high-risk classifications', async () => {
  await site();
  const profile = { what: 'A general-purpose file service.', category: 'general' as const, risk: 'high' as const, flags: ['Can share company files publicly.'] };
  changeWebsite(alice.email, 'portal', { profile });
  await setSite(alice, 'portal', { via: '' });
  assert.deepEqual(websitesOf(alice.email).portal.profile, profile);
  await setSite(alice, 'portal', { via: 'client' });
  assert.deepEqual(await checkWebsite(alice.email, 'portal'), profile);
  assert.equal(models.length, 0);
  assert.equal(visible(owner)[0].adminOnly, true);
});

test('one shared VPN website check classifies the actual system but refuses public searches of its own DNS names', async () => {
  await site();
  process.env.OPENROUTER_API_KEY = 'model-key';
  process.env.EXA_API_KEY = 'search-key';
  modelProfile = { what: 'A general-purpose file service.', category: 'general', risk: 'high', flags: ['Can share company files publicly.'] };
  toolQueries = ['ERP.CLIENT.TEST operator', 'login.identity.test business sign-on'];
  const profile = await checkWebsite(alice.email, 'portal', { requests: { 'erp.client.test': { 200: 3 }, 'login.identity.test': { 200: 1 } }, blocked: [], seconds: 1 });
  assert.deepEqual(profile, modelProfile);
  assert.equal(models.length, 2, 'one conversation, before and after its tools');
  assert.deepEqual(searches, ['login.identity.test business sign-on'], 'the private query never reached Exa');
  assert.equal(JSON.parse(models[0].messages[1].content).website.via, 'client');
  assert.match(models[1].messages.find((m: any) => m.tool_call_id === 'search0').content, /not public search targets/);
  assert.equal(websitesOf(alice.email).portal.checks!['erp.client.test'].verdict, 'pass');
  assert.equal(websitesOf(alice.email).portal.checks!['login.identity.test'].verdict, 'pass');
  assert.equal(visible(owner)[0].adminOnly, true);
  assert.ok(lookups.every(h => !h.endsWith('.client.test')));
});

test('a missing VPN refuses discovery and connections before the first session, once per run, without expiring the website login', async t => {
  await site();
  const b = running(); t.after(() => b.end());
  await assert.rejects(serveBrowsers(b, '/browsers/run', ['portal', 'json', 'version'], { method: 'GET' } as never, {} as never), /connect VPN client first/);
  await assert.rejects(b.browser('portal'), /connect VPN client first/);
  await assert.rejects(b.browser('portal'), /connect VPN client first/);
  assert.equal(b.inst.log.filter(e => e.op === 'browser' && e.action === 'refused').length, 1);
  assert.equal(b.inst.log.filter(e => e.op === 'expired').length, 0);
  assert.equal(browserCalls.some(c => c.method === 'POST'), false);
  assert.equal(logins(alice.email)[0].expired, undefined);
});

test('an unavailable tunnel service or missing proxy refuses a run once and preserves the service reason', async t => {
  await site(); await connectVpn();
  const b = running(); t.after(() => b.end());
  listError = 'tunnel control is restarting';
  await assert.rejects(b.browser('portal'), /tunnel service: tunnel control is restarting/);
  await assert.rejects(b.browser('portal'), /tunnel service: tunnel control is restarting/);
  assert.equal(b.inst.log.filter(e => e.op === 'browser' && e.action === 'refused').length, 1);
  listError = '';
  delete process.env.RF_TUNNEL_PROXY;
  await assert.rejects(b.browser('portal'), /RF_TUNNEL_PROXY/);
  assert.equal(b.inst.log.filter(e => e.op === 'browser' && e.action === 'refused').length, 1);
  assert.equal(b.bySite.size, 0);
});

test('run browsers use the same person\'s live proxy, reopen after reconnect, and close once their tunnel is down', async t => {
  await site(); await connectVpn();
  const b = running(); t.after(() => b.end());
  const first = await b.browser('portal'), firstVia = sessions.get(first!).site.via;
  assert.deepEqual(firstVia.hosts, ['client.test', '*.client.test']);
  assert.equal(sessions.get(first!).site.public, true);
  assert.equal((await b.browser('portal')), first);
  await connectVpn();
  const second = await b.browser('portal');
  assert.notEqual(second, first);
  assert.equal(sessions.has(first!), false);
  assert.notEqual(sessions.get(second!).site.via.token, firstVia.token);
  remote.get([...remote.keys()][0])!.up = false;
  await assert.rejects(b.lent('portal'), /is down/);
  await b.closeUnlent();
  assert.equal(sessions.has(second!), false);
  assert.equal(b.inst.log.filter(e => e.op === 'browser' && e.action === 'refused').length, 1);
  assert.equal(disk().includes(firstVia.token), false);
});

test('the asynchronous VPN availability check rechecks ticks and grants before opening or lending a browser', async t => {
  await site(); await connectVpn();
  for (const revoke of ['tick', 'move', 'grant']) {
    const b = running(); t.after(() => b.end());
    let release!: () => void;
    listGate = new Promise<void>(ok => { release = ok; });
    const seen = new Promise<void>(ok => { onList = ok; });
    const opening = b.browser('portal');
    const refused = assert.rejects(opening, revoke === 'tick' ? /not ticked/ : /grant.*revoked/);
    await seen;
    if (revoke === 'tick') b.inst.append(alice.email, 'logins', { logins: [] });
    else if (revoke === 'move') {
      saveTree({ workspaces: { w: { name: 'Client work', owners: [owner.email], members: [alice.email] }, other: { name: 'Other work', owners: [owner.email], members: [alice.email] } }, series: { s: { name: 'Weekly work', workspace: 'other' } } });
    } else writeJson('grants.json', {});
    release(); await refused;
    listGate = undefined; onList = undefined;
    assert.equal(b.bySite.size, 0);
    saveTree({ workspaces: { w: { name: 'Client work', owners: [owner.email], members: [alice.email] } }, series: { s: { name: 'Weekly work', workspace: 'w' } } });
  }
});

test('keepalive uses only the website person\'s VPN, and leaves the saved login intact without that connection', async () => {
  await site(alice, 'keepalive'); await site(bob, 'keepalive');
  const now = new Date();
  for (const person of [alice, bob]) {
    const login = logins(person.email)[0];
    saveLogin(person.email, { ...login, keepalive: new Date(now.getTime() + 60_000).toISOString() });
  }
  await connectVpn();
  const saved = secret(bob.email, 'web:keepalive');
  const errors: string[] = [];
  const error = mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  await keepAlive(now);
  error.mock.restore();
  const turns = browserCalls.filter(c => c.method === 'POST' && c.body.ttl_s === 300);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].body.site.via.hosts, ['client.test', '*.client.test']);
  assert.equal(turns[0].body.site.via.url, process.env.RF_TUNNEL_PROXY);
  assert.ok(errors.some(e => e.includes(bob.email) && e.includes('connect VPN client first')));
  assert.equal(secret(bob.email, 'web:keepalive'), saved);
});

test('disconnect or cancel while Save is closing the browser invalidates the pending connection', async t => {
  for (const action of ['disconnect', 'cancel']) {
    const id = await startVpnSignIn(alice, 'client');
    back = cookieState();
    let release!: () => void;
    closeGate = new Promise<void>(ok => { release = ok; });
    t.after(() => release());
    const seen = new Promise<void>(ok => { onClose = ok; });
    const saving = assert.rejects(saveVpnSignIn(alice, id), /superseded/);
    await seen;
    if (action === 'disconnect') await disconnectVpn(alice, 'client');
    else await cancelVpnSignIn(alice, id);
    release(); await saving;
    assert.equal(remote.size, 0);
    assert.equal(tunnelCalls.some(c => c.method === 'POST'), false);
  }
});

test('a late older browser opening is collected and cannot replace a newer VPN sign-in', async t => {
  let release!: () => void;
  openGate = new Promise<void>(ok => { release = ok; });
  t.after(() => release());
  const seen = new Promise<void>(ok => { onOpen = ok; });
  const first = assert.rejects(startVpnSignIn(alice, 'client'), /superseded/);
  await seen;
  const old = [...sessions.keys()][0], newer = await startVpnSignIn(alice, 'client');
  release(); await first;
  assert.equal(sessions.has(old), false);
  assert.equal(isVpnSignIn(alice.email, newer), true);
  assert.equal(sessions.size, 1);
  await cancelVpnSignIn(alice, newer);
});

test('a delayed older Save cannot overwrite a newer successful VPN connection', async t => {
  const id = await startVpnSignIn(alice, 'client');
  back = cookieState('old-cookie');
  let release!: () => void;
  closeGate = new Promise<void>(ok => { release = ok; });
  t.after(() => release());
  const seen = new Promise<void>(ok => { onClose = ok; });
  const saving = assert.rejects(saveVpnSignIn(alice, id), /superseded/);
  await seen;
  const newer = await startVpnSignIn(alice, 'client');
  back = cookieState('new-cookie');
  await saveVpnSignIn(alice, newer);
  const connected = [...remote.keys()][0];
  release(); await saving;
  assert.deepEqual([...remote.keys()], [connected]);
  assert.deepEqual(tunnelCalls.filter(c => c.method === 'POST').map(c => c.body.cookie), ['SVPNCOOKIE=new-cookie']);
});

test('removing and readding the identical definition invalidates a pending Save by incarnation', async t => {
  const id = await startVpnSignIn(alice, 'client');
  back = cookieState();
  let release!: () => void;
  closeGate = new Promise<void>(ok => { release = ok; });
  t.after(() => release());
  const seen = new Promise<void>(ok => { onClose = ok; });
  const saving = assert.rejects(saveVpnSignIn(alice, id), /superseded/);
  await seen;
  await removeVpn(admin, 'client');
  addVpn(admin, 'client', definition);
  release(); await saving;
  assert.equal(remote.size, 0);
  assert.equal(tunnelCalls.some(c => c.method === 'POST'), false);
});

test('disconnect or Cancel during a pending tunnel POST collects the stale result instead of publishing it', async t => {
  for (const action of ['disconnect', 'cancel']) {
    const id = await startVpnSignIn(alice, 'client');
    back = cookieState();
    let release!: () => void;
    postGate = new Promise<void>(ok => { release = ok; });
    t.after(() => release());
    const seen = new Promise<void>(ok => { onPost = ok; });
    const saving = assert.rejects(saveVpnSignIn(alice, id), /superseded/);
    await seen;
    const canceling = action === 'disconnect' ? disconnectVpn(alice, 'client') : cancelVpnSignIn(alice, id);
    release(); await saving; await canceling;
    assert.equal(remote.size, 0);
    assert.equal((await vpns(alice))[0].connected, false);
    assert.ok(tunnelCalls.some(c => c.method === 'DELETE'));
  }
});

test('capability revocation or disabling the person during tunnel creation collects the returned tunnel', async t => {
  for (const action of ['capability', 'disabled']) {
    writeJson('capabilities.json', { vpn: [alice.email, admin.email] });
    writeJson('users.json', { [alice.email]: { role: 'user' }, [admin.email]: { role: 'admin' } });
    const id = await startVpnSignIn(alice, 'client');
    back = cookieState();
    let release!: () => void;
    postGate = new Promise<void>(ok => { release = ok; });
    t.after(() => release());
    const seen = new Promise<void>(ok => { onPost = ok; });
    const saving = assert.rejects(saveVpnSignIn(alice, id), { status: 403 });
    await seen;
    if (action === 'capability') writeJson('capabilities.json', { vpn: [admin.email] });
    else writeJson('users.json', { [alice.email]: { role: 'user', disabled: true }, [admin.email]: { role: 'admin' } });
    release(); await saving;
    assert.equal(remote.size, 0);
  }
});

test('a run stopped during the asynchronous availability check opens no untracked browser', async t => {
  await site(); await connectVpn();
  const b = running(); t.after(() => b.end());
  let release!: () => void;
  listGate = new Promise<void>(ok => { release = ok; });
  t.after(() => release());
  const seen = new Promise<void>(ok => { onList = ok; });
  const opening = b.browser('portal');
  await seen;
  await b.end();
  release();
  assert.equal(await opening, undefined);
  assert.equal(browserCalls.some(c => c.method === 'POST' && c.body.ttl_s === 7200), false);
});

test('grant descriptions and the explicit via field disclose the client VPN even to noncap workspace owners', async () => {
  await site(); await checkWebsite(alice.email, 'portal');
  assert.equal(can(owner, 'vpn'), false);
  const card = visible(owner)[0];
  assert.equal(card.via, 'client');
  assert.match(card.description, /through client VPN client/);
  assert.match(card.description, /including submitting and approving/);
});
