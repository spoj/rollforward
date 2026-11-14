import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idp } from './idp.ts';

const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-vpn-api-')), root = join(tmp, 'data');
const ADMIN = 'admin@demo.test', BOB = 'bob@demo.test', OWNER = 'owner@demo.test', SECOND = 'second-admin@demo.test';
const GROUP = 'c070ffb5-7f2c-43d6-9597-645bf9a15438', gateway = 'vpn.customer.test:10443';
const COOKIE = 'gateway-cookie-never-written', TOKEN = 'tunnel-token-never-written';
type Cookie = { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; sameSite: string };
type Tunnel = { id: string; token: string; type: string; gateway: string; since: string; up: boolean; idle_s: number; last_used: string };
const cookie = (domain = '.customer.test', name = 'SVPNCOOKIE', value = COOKIE): Cookie => ({ name, value, domain, path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' });
const sessions = new Map<string, { body: any; cookies: Cookie[]; expires: number }>(), tunnels = new Map<string, Tunnel>();
const opened: any[] = [], created: any[] = [], deleted: string[] = [], browserDeleted: string[] = [], serviceAuth: string[] = [];
let nextCookies = [cookie()], browserSerial = 0, tunnelSerial = 0, tunnelError = '', browserError = '';
let base = '', browserBase = '', tunnelBase = '', proc: ChildProcess, output = '', admin = '', bob = '', owner = '', second = '';
let entra: Awaited<ReturnType<typeof idp>>;
const body = async (req: IncomingMessage) => JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString() || '{}');
const browser = createServer(async (req, res) => {
  serviceAuth.push(`browser ${req.headers.authorization}`);
  const u = new URL(req.url!, 'http://browser.test'), parts = u.pathname.split('/'), id = parts[2];
  const send = (data: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (u.pathname === '/blocked') return void send(Object.fromEntries(u.searchParams.getAll('host').map(h => [h, false])));
  if (u.pathname === '/sessions' && req.method === 'GET') return void send([...sessions.keys()].map(id => ({ id })));
  if (u.pathname === '/sessions' && req.method === 'POST') {
    const data = await body(req);
    opened.push(data);
    if (browserError) return void send({ error: browserError }, 503);
    const id = `b${++browserSerial}`;
    sessions.set(id, { body: data, cookies: structuredClone(nextCookies), expires: Date.now() + (data.ttl_s ?? 3600) * 1000 });
    return void send({ id, view: `/sessions/${id}/view`, cdp: `/sessions/${id}/cdp` }, 201);
  }
  const session = sessions.get(id);
  if (!session) return void send({ error: 'no such session' }, 404);
  const log = [{ method: 'GET', url: session.body.site.start_url, status: 200, live: true }];
  if (req.method === 'DELETE') {
    browserDeleted.push(id);
    sessions.delete(id);
    return void send({ state: { cookies: session.cookies, origins: [] }, log });
  }
  if (parts[3] === 'log') return void send(log);
  if (parts[3] === 'view') {
    if (Date.now() >= session.expires) return void send({ error: 'session closed' }, 410);
    return void res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Take control</title>');
  }
  if (parts[3] === 'page') return void send({ url: session.body.site.start_url, password: false });
  send({});
}).on('upgrade', (req, socket) => {
  const session = sessions.get(req.url!.split('/')[2]);
  if (session && Date.now() < session.expires && req.headers['x-hold'] === '1') {
    socket.on('end', () => socket.destroy());
    return void socket.write(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`);
  }
  socket.end(session && Date.now() < session.expires ? `HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}` : 'HTTP/1.1 404 Not Found\r\n\r\n');
});
const tunnel = createServer(async (req, res) => {
  serviceAuth.push(`tunnel ${req.headers.authorization}`);
  const send = (data: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (req.url === '/tunnels' && req.method === 'GET') return void send([...tunnels.values()].map(({ token, ...t }) => t));
  if (req.url === '/tunnels' && req.method === 'POST') {
    const data = await body(req);
    if (tunnelError) return void send({ error: tunnelError }, 502);
    const id = `remote-vpn-${++tunnelSerial}`, since = new Date().toISOString(), token = `${TOKEN}-${tunnelSerial}`;
    const t = { id, token, type: data.type, gateway: data.gateway, since, up: true, idle_s: 1800, last_used: since };
    tunnels.set(id, t);
    created.push({ ...data, id, token });
    return void send({ id, token }, 201);
  }
  const id = req.url!.split('/')[2], t = tunnels.get(id);
  if (!t) return void send({ error: 'no such tunnel' }, 404);
  if (req.method === 'DELETE') {
    deleted.push(id);
    tunnels.delete(id);
    return void send({});
  }
  const { token, ...metadata } = t;
  send({ ...metadata, log: ['connected'] });
});

const call = (method: string, path: string, data?: unknown, session = admin) => fetch(base + path, { method, headers: { cookie: session }, body: method === 'GET' || data === undefined ? undefined : JSON.stringify(data) });
const json = async (path: string, session = admin) => {
  const r = await call('GET', path, undefined, session);
  assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
  return r.json();
};
const login = async (email: string) => (await entra.signIn(base, email)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
const grant = async (people = [ADMIN, BOB, GROUP]) => {
  const r = await call('PUT', '/capabilities', { cap: 'vpn', people });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
};
async function startServer(enabled = true, seconds = '600', tunnelUrl = tunnelBase) {
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise<void>(ok => probe.close(() => ok()));
  const env = { ...process.env, ...entra.env(base), HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch'), RF_ADMINS: `${ADMIN},${SECOND}`, RF_BROWSER_URL: browserBase, RF_BROWSER_KEY: 'browser-key', RF_SIGNIN_S: seconds, RF_TUNNEL_KEY: 'tunnel-key', RF_TUNNEL_PROXY: 'http://proxy.test:8799', OPENROUTER_API_KEY: '', EXA_API_KEY: '' };
  delete env.RF_TUNNEL_URL;
  if (enabled) env.RF_TUNNEL_URL = tunnelUrl;
  proc = spawn(process.execPath, [join(app, 'src/server.ts'), root, new URL(base).port], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr!.on('data', d => { output += d; });
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on('data', d => { output += d; if (String(d).includes('rollforward on')) ok(); });
    proc.once('exit', code => fail(new Error(`server exited ${code}: ${output}`)));
  });
  [admin, bob, owner, second] = await Promise.all([ADMIN, BOB, OWNER, SECOND].map(login));
}
async function stopServer() {
  proc.kill();
  await once(proc, 'exit');
}
async function openVpn(name = 'client', session = admin) {
  const r = await call('POST', `/vpns/${name}/signins`, {}, session);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<{ id: string; expires: string }>;
}
async function connectVpn(name = 'client', session = admin) {
  const { id } = await openVpn(name, session), r = await call('POST', `/signins/${id}`, undefined, session);
  assert.equal(r.status, 200, await r.text());
  return created.at(-1)!;
}
async function upgrade(path: string, session: string, origin = base) {
  const socket = connect(Number(new URL(base).port), '127.0.0.1');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${new URL(base).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${session}\r\nOrigin: ${origin}\r\n\r\n`);
  return Buffer.concat(await Array.fromAsync(socket)).toString();
}

before(async () => {
  mkdirSync(join(tmp, 'home'));
  entra = await idp();
  await Promise.all([new Promise<void>(ok => browser.listen(0, '127.0.0.1', ok)), new Promise<void>(ok => tunnel.listen(0, '127.0.0.1', ok))]);
  browserBase = `http://127.0.0.1:${(browser.address() as { port: number }).port}`;
  tunnelBase = `http://127.0.0.1:${(tunnel.address() as { port: number }).port}`;
  await startServer();
});
after(async () => {
  await stopServer();
  await Promise.all([new Promise<void>(ok => browser.close(() => ok())), new Promise<void>(ok => tunnel.close(() => ok()))]);
  entra.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('the trial is an explicit capability, never implied by admin, with person and Entra group grants', async () => {
  assert.equal((await fetch(base + '/vpns')).status, 401);
  assert.equal((await json('/me')).can.includes('vpn'), false);
  assert.equal('vpn' in await json('/capabilities'), false);
  const invalid = await call('PUT', '/capabilities', { cap: 'unknown', people: [] });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /\bvpn\b/);
  for (const session of [admin, bob, second]) for (const [method, path] of [
    ['GET', '/vpns'], ['POST', '/vpns'], ['DELETE', '/vpns/client'], ['POST', '/vpns/client/signins'], ['DELETE', '/vpns/client/connection'],
  ]) assert.equal((await call(method, path, {}, session)).status, 404, `${method} ${path}`);
  assert.equal((await call('PUT', '/capabilities', { cap: 'vpn', people: [BOB] }, bob)).status, 403);
  await grant([ADMIN, BOB.toUpperCase(), GROUP.toUpperCase()]);
  assert.deepEqual((await json('/capabilities')).vpn, [ADMIN, BOB, GROUP]);
  assert.equal((await json('/me')).can.includes('vpn'), true);
  assert.equal((await json('/me', second)).can.includes('vpn'), false);
  assert.equal((await call('GET', '/vpns', undefined, second)).status, 404);
  entra.who.groups['group@demo.test'] = [GROUP];
  const grouped = await login('group@demo.test');
  assert.equal((await json('/me', grouped)).can.includes('vpn'), true);
  assert.deepEqual(await json('/vpns', grouped), []);
  delete entra.who.groups['group@demo.test'];
  await login('group@demo.test');
  assert.equal((await call('GET', '/vpns', undefined, grouped)).status, 404, 'fresh claims revoke group-derived VPN access');
});

test('only opted-in admins define fortinet VPNs; definitions contain no connection credentials', async () => {
  assert.equal((await call('POST', '/vpns', { name: 'client', type: 'fortinet', gateway }, bob)).status, 403);
  for (const data of [
    { name: 'Bad Name', type: 'fortinet', gateway }, { name: 'test', type: 'test', gateway },
    { name: 'unknown', type: 'unknown', gateway }, { name: 'bad', type: 'fortinet', gateway: 'https://vpn.customer.test:443/' },
    { name: 'bad', type: 'fortinet', gateway: 'vpn.customer.test' }, { name: 'bad', type: 'fortinet', gateway: 'vpn.customer.test:0' },
  ]) assert.equal((await call('POST', '/vpns', data)).status, 400, JSON.stringify(data));
  assert.equal((await call('POST', '/vpns', { name: 'client', type: 'fortinet', gateway })).status, 200);
  assert.equal((await call('POST', '/vpns', { name: 'other', type: 'fortinet', gateway: 'other.customer.test:443' })).status, 200);
  assert.equal((await call('POST', '/vpns', { name: 'client', type: 'fortinet', gateway })).status, 409);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.rf/vpns.json'), 'utf8')), { client: { type: 'fortinet', gateway }, other: { type: 'fortinet', gateway: 'other.customer.test:443' } });
  assert.deepEqual((await json('/vpns')).map((v: any) => [v.name, v.connected]), [['client', false], ['other', false]]);
  assert.equal((await call('DELETE', '/vpns/other', undefined, bob)).status, 403);
});

test('VPN sign-ins are short, personal browser sessions, protected on HTTP and websocket views and on capability revocation', async () => {
  const at = Date.now(), { id, expires } = await openVpn(), session = sessions.get(id)!;
  assert.ok(Date.parse(expires) >= at + 599_000 && Date.parse(expires) <= Date.now() + 600_000);
  assert.equal(session.body.ttl_s, 600);
  assert.equal(session.body.site.open, true);
  assert.equal(new URL(session.body.site.start_url).host, gateway);
  assert.equal(session.body.state, undefined);
  assert.equal(session.body.site.via, undefined, 'the gateway signs in directly, never through a VPN');
  assert.equal(session.body.site.headers, undefined, 'neither a cookie nor a proxy token is injected into sign-in requests');
  assert.match(await (await call('GET', `/signins/${id}/view`)).text(), /Take control/);
  assert.equal((await call('GET', `/signins/${id}/view`, undefined, bob)).status, 404);
  assert.equal((await call('POST', `/signins/${id}`, {}, bob)).status, 404);
  assert.equal((await call('DELETE', `/signins/${id}`, undefined, bob)).status, 404);
  assert.match(await upgrade(`/signins/${id}/view/watch`, admin), /101 Switching Protocols[^]*service got/);
  assert.match(await upgrade(`/signins/${id}/view/drive`, bob), /404/);
  assert.match(await upgrade(`/signins/${id}/view/drive`, admin, 'https://unrelated.test'), /404/);
  await grant([BOB, GROUP]);
  assert.equal(sessions.has(id), false, 'revocation deletes the browser, not just its live-view permission');
  assert.equal((await call('GET', `/signins/${id}/view`)).status, 404);
  assert.match(await upgrade(`/signins/${id}/view/drive`, admin), /404/);
  assert.equal((await call('POST', `/signins/${id}`, {})).status, 404);
  await grant();
  const count = created.length;
  assert.equal((await call('POST', `/signins/${id}`, {})).status, 404, 'restoring access cannot resurrect the revoked sign-in');
  const { id: cancel } = await openVpn();
  assert.equal((await call('DELETE', `/signins/${cancel}`)).status, 200);
  assert.ok(browserDeleted.includes(cancel));
  assert.equal(created.length, count, 'cancel never connects');
  assert.equal((await call('GET', `/signins/${cancel}/view`)).status, 404);
  assert.equal((await call('POST', `/signins/${cancel}`, {})).status, 404);
});

test('save extracts only the gateway cookie server-side and reconnect replaces only that person and named VPN', async () => {
  nextCookies = [cookie('unrelated.test', 'SVPNCOOKIE', 'unrelated-cookie'), cookie('.customer.test'), cookie('vpn.customer.test', 'sid', 'irrelevant-cookie')];
  const first = await connectVpn();
  assert.deepEqual({ type: first.type, gateway: first.gateway, cookie: first.cookie }, { type: 'fortinet', gateway, cookie: `SVPNCOOKIE=${COOKIE}` });
  assert.equal(sessions.size, 0, 'the temporary browser closes before the tunnel opens');
  assert.deepEqual(await json('/logins'), [], 'VPN credentials are not website logins');
  const own = (await json('/vpns')).find((v: any) => v.name === 'client');
  assert.equal(own.connected, true);
  assert.ok(Date.parse(own.since));
  assert.deepEqual(Object.keys(own).sort(), ['name', 'type', 'gateway', 'connected', 'since'].sort());
  assert.doesNotMatch(JSON.stringify(await json('/vpns')), /gateway-cookie-never-written|tunnel-token-never-written|remote-vpn-/);
  assert.equal((await json('/vpns', bob)).find((v: any) => v.name === 'client').connected, false);
  const bobs = await connectVpn('client', bob), other = await connectVpn('other');
  const fresh = await connectVpn();
  assert.ok(deleted.includes(first.id));
  assert.equal(tunnels.has(first.id), false);
  assert.equal(tunnels.has(bobs.id), true, 'another person remains connected');
  assert.equal(tunnels.has(other.id), true, 'another VPN remains connected');
  assert.equal(tunnels.has(fresh.id), true);
  assert.equal((await call('DELETE', '/vpns/client/connection')).status, 200);
  assert.equal(tunnels.has(fresh.id), false);
  assert.equal((await json('/vpns')).find((v: any) => v.name === 'client').connected, false);
  assert.equal((await json('/vpns', bob)).find((v: any) => v.name === 'client').connected, true);
  nextCookies = [cookie()];
});

test('missing or unrelated SVPNCOOKIE cannot connect, and service refusals remain actionable plain text', async () => {
  for (const cookies of [[], [cookie('attacker.test')], [cookie('vpn.customer.test', 'sid')], [cookie('.customer.test', 'SVPNCOOKIE', 'bad;value')], [cookie('.customer.test', 'SVPNCOOKIE', 'white space')], [{ ...cookie(), expires: 1 }]]) {
    nextCookies = cookies;
    const count = created.length, { id } = await openVpn(), response = await call('POST', `/signins/${id}`, {});
    assert.equal(response.status, 409);
    assert.match(await response.text(), /SVPNCOOKIE|sign in/i);
    assert.equal(created.length, count);
    assert.equal(sessions.has(id), false);
  }
  nextCookies = [cookie()];
  tunnelError = 'VPN client exited (code 2)\nThe gateway rejected the sign-in; sign in again.';
  const { id } = await openVpn(), response = await call('POST', `/signins/${id}`, {});
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /VPN client exited \(code 2\)/);
  assert.match(text, /gateway rejected/);
  assert.doesNotMatch(text, /\{"error"|gateway-cookie-never-written|tunnel-token-never-written/);
  tunnelError = '';
  browserError = 'blocklists not loaded yet';
  const refused = await call('POST', '/vpns/client/signins', {});
  assert.equal(refused.status, 502);
  assert.match(await refused.text(), /blocklists not loaded yet/);
  browserError = '';
});

test('a down or idle-deleted remote tunnel is not connected and never advertised as a live login', async () => {
  const down = await connectVpn();
  tunnels.get(down.id)!.up = false;
  assert.equal((await json('/vpns')).find((v: any) => v.name === 'client').connected, false);
  const idle = await connectVpn();
  tunnels.delete(idle.id);
  assert.equal((await json('/vpns')).find((v: any) => v.name === 'client').connected, false);
});

test('website via settings require explicit capability to set, not to clear, which admins do for others too, survive other changes, and are disclosed to noncap grant owners', async () => {
  await connectVpn('client', bob);
  assert.equal((await call('POST', '/logins/sites', { name: 'portal', url: 'https://accounts.client.example.org/login' }, bob)).status, 200);
  assert.equal((await call('POST', '/logins/sites', { name: 'portal', url: 'https://accounts.client.example.org/login' }, second)).status, 200);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'client' }, second)).status, 403, 'admin without opt-in cannot select a VPN');
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'not-defined' }, bob)).status, 404);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 3 }, bob)).status, 400);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'client' }, bob)).status, 200);
  assert.equal((await call('PATCH', '/logins/sites/portal', { every: '5m', writeback: false }, bob)).status, 200);
  assert.equal((await json('/logins/sites', bob)).portal.via, 'client');
  const { id } = await (await call('POST', '/logins/web/portal', {}, bob)).json();
  const via = opened.at(-1)!.site.via;
  assert.deepEqual(via.hosts, ['example.org', '*.example.org']);
  assert.equal(via.url, 'http://proxy.test:8799');
  assert.match(via.token, new RegExp(`^${TOKEN}`));
  assert.equal(via.hosts.includes('sso.other.test'), false, 'an open sign-in does not widen proxy routing to SSO');
  assert.equal((await call('POST', `/signins/${id}`, {}, bob)).status, 200);
  const { id: workspace } = await (await call('POST', '/api/workspaces', { name: 'VPN invoices' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${workspace}`, { owners: [OWNER], members: [BOB] })).status, 200);
  const asked = await call('POST', '/grants', { workspace, site: 'portal', reason: 'Collect invoices' }, bob);
  assert.equal(asked.status, 200, await asked.clone().text());
  const card = (await json('/grants', owner))[0];
  assert.equal((await json('/me', owner)).can.includes('vpn'), false);
  assert.equal(card.via, 'client');
  assert.match(card.description, /VPN/);
  assert.match(card.description, /client/);
  await grant([ADMIN, GROUP]);
  assert.equal((await json('/me', bob)).can.includes('vpn'), false);
  assert.equal((await call('PATCH', '/logins/sites/portal', { every: '10m' }, bob)).status, 200, 'ordinary settings still work without VPN permission');
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'client' }, bob)).status, 403);
  await grant();
  assert.equal((await json('/logins/sites', bob)).portal.via, 'client', 'unrelated changes did not clear the stored VPN');
  await grant([ADMIN, GROUP]);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: '' }, bob)).status, 200, 'without the capability, a website left with a VPN is taken off it');
  await grant();
  assert.equal('via' in (await json('/logins/sites', bob)).portal, false);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'client' }, bob)).status, 200);
  assert.equal((await call('PATCH', `/logins/sites/portal?person=${BOB}`, { via: 'client' }, second)).status, 403, "an admin doesn't set someone's VPN");
  assert.equal((await call('PATCH', `/logins/sites/portal?person=${BOB}`, { via: '' }, second)).status, 200, 'but takes it off');
  assert.equal('via' in (await json('/logins/sites', bob)).portal, false);
});

test('VPN definition removal disconnects its people without removing another named VPN', async () => {
  const other = await connectVpn('other'), a = await connectVpn(), b = await connectVpn('client', bob);
  assert.equal((await call('DELETE', '/vpns/client')).status, 200);
  assert.equal(tunnels.has(a.id), false);
  assert.equal(tunnels.has(b.id), false);
  assert.equal(tunnels.has(other.id), true);
  assert.equal((await call('POST', '/vpns/client/signins', {})).status, 404);
  assert.deepEqual((await json('/vpns')).map((v: any) => v.name), ['other']);
});

test('restarting removes every service-side leftover and persists only VPN definitions, not cookies, tokens or remote ids', async () => {
  const connected = await connectVpn('other');
  tunnels.set('leftover-from-an-earlier-process', { ...tunnels.get(connected.id)!, id: 'leftover-from-an-earlier-process' });
  await stopServer();
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile());
  for (const file of files) {
    const contents = readFileSync(join(file.parentPath, file.name));
    for (const secret of [COOKIE, TOKEN, connected.id]) assert.equal(contents.includes(Buffer.from(secret)), false, `${file.name} must not contain ${secret}`);
    assert.doesNotMatch(file.name, /vpn.*sealed|vpn.*cookie|vpn.*token/);
  }
  assert.doesNotMatch(output, /gateway-cookie-never-written|tunnel-token-never-written|unrelated-cookie/);
  assert.ok(serviceAuth.filter(a => a.startsWith('tunnel ')).every(a => a === 'tunnel Bearer tunnel-key'));
  assert.ok(serviceAuth.filter(a => a.startsWith('browser ')).every(a => a === 'browser Bearer browser-key'));
  await startServer(true, '0.1');
  assert.equal(tunnels.size, 0, 'startup deletes even tunnels whose id was not in this process');
  assert.deepEqual((await json('/vpns')).map((v: any) => [v.name, v.connected]), [['other', false]]);
  const { id } = await openVpn('other');
  await new Promise(ok => setTimeout(ok, 150));
  assert.equal((await call('GET', `/signins/${id}/view`)).status, 502, 'the boundary reports the browser service\'s expired view');
  assert.match(await upgrade(`/signins/${id}/view/drive`, admin), /404/);
  assert.equal((await call('POST', `/signins/${id}`, {})).status, 410);
  assert.ok(browserDeleted.includes(id), 'an expired Save collects its browser result');
  const { id: discard } = await openVpn('other');
  await new Promise(ok => setTimeout(ok, 150));
  assert.equal((await call('DELETE', `/signins/${discard}`)).status, 200);
  assert.ok(browserDeleted.includes(discard), 'Close also collects an expired browser result');
  assert.equal(created.at(-1)!.id, connected.id, 'an expired browser cannot create a tunnel');
});

test('a tunnel service down at startup is logged, and the server starts with each VPN action failing until it answers', async () => {
  await stopServer();
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const down = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise<void>(ok => probe.close(() => ok()));
  output = '';
  await startServer(true, '600', down);
  assert.match(output, /the tunnel service: tunnels a restart left may still be open/);
  const { id } = await openVpn('other');
  const r = await call('POST', `/signins/${id}`, undefined);
  assert.equal(r.status, 502);
  assert.match(await r.text(), /the tunnel service at .* does not answer/);
  await stopServer();
  await startServer();
});

test('without a tunnel service, explicit stored grants expose no VPN API, capability, or website selector', async () => {
  await stopServer();
  await startServer(false);
  assert.equal((await json('/me')).can.includes('vpn'), false);
  assert.equal('vpn' in await json('/capabilities'), false);
  for (const [method, path] of [['GET', '/vpns'], ['POST', '/vpns'], ['DELETE', '/vpns/other'], ['POST', '/vpns/other/signins'], ['DELETE', '/vpns/other/connection']])
    assert.equal((await call(method, path, {})).status, 404, `${method} ${path}`);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'other' }, bob)).status, 403);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: '' }, bob)).status, 200, 'a website left with a VPN is taken off it');
  assert.equal((await call('PATCH', '/logins/sites/portal', { every: '15m' }, bob)).status, 200);
  assert.equal((await call('PUT', '/capabilities', { cap: 'vpn', people: [ADMIN] })).status, 200, 'admins can still bootstrap a grant before deployment');
});

test('disabling a user or revoking vpn closes open sign-in browsers, disconnects live VPN tunnels, and cuts open sign-in websockets', async () => {
  await stopServer();
  await startServer(true);
  await grant([ADMIN, BOB]);
  assert.equal((await call('POST', '/vpns', { name: 'corp', type: 'fortinet', gateway })).status, 200);

  // 1. Revoking vpn capability disconnects Bob's live tunnel and cuts his open VPN sign-in websocket.
  const bTun = await connectVpn('corp', bob);
  const { id: bVpnSign } = await openVpn('corp', bob);
  const vpnWs = connect(Number(new URL(base).port), '127.0.0.1');
  vpnWs.write(`GET /signins/${bVpnSign}/view/drive HTTP/1.1\r\nHost: ${new URL(base).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Hold: 1\r\nCookie: ${bob}\r\nOrigin: ${base}\r\n\r\n`);
  await once(vpnWs, 'data');
  const closedVpnWs = once(vpnWs, 'close');
  assert.equal(tunnels.has(bTun.id), true);
  await grant([ADMIN]);
  await Promise.race([closedVpnWs, new Promise((_, rej) => setTimeout(() => rej(new Error('VPN sign-in websocket stayed open')), 2000))]);
  vpnWs.destroy();
  assert.equal(tunnels.has(bTun.id), false, 'revoking vpn capability deleted live tunnel on tunnel service');

  // 2. Disabling Bob closes his open website and VPN sign-in browsers, disconnects his live VPN tunnel, and cuts his open sign-in websocket.
  await grant([ADMIN, BOB]);
  const bTun2 = await connectVpn('corp', bob);
  const webSignRes = await call('POST', '/logins/web/portal', {}, bob);
  assert.equal(webSignRes.status, 200);
  const { id: bWebSign } = await webSignRes.json();

  const ws = connect(Number(new URL(base).port), '127.0.0.1');
  ws.write(`GET /signins/${bWebSign}/view/drive HTTP/1.1\r\nHost: ${new URL(base).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Hold: 1\r\nCookie: ${bob}\r\nOrigin: ${base}\r\n\r\n`);
  await once(ws, 'data');
  const closedWs = once(ws, 'close');

  assert.equal((await call('PUT', `/users/${encodeURIComponent(BOB)}`, { disabled: true })).status, 200);
  await Promise.race([closedWs, new Promise((_, rej) => setTimeout(() => rej(new Error('sign-in websocket stayed open')), 2000))]);
  ws.destroy();
  assert.equal(sessions.has(bWebSign), false, 'disabling user deleted open website sign-in browser');
  assert.equal(sessions.has(bVpnSign), false, 'disabling user deleted open VPN sign-in browser');
  assert.equal(tunnels.has(bTun2.id), false, 'disabling user deleted live VPN tunnel');
  assert.equal((await call('PUT', `/users/${encodeURIComponent(BOB)}`, { disabled: false })).status, 200);
});
