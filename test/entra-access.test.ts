import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idp } from './idp.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-entra-access-'));
const ADMIN = 'admin@demo.test', GROUP = '00000000-0000-0000-0000-000000000001', OTHER = '00000000-0000-0000-0000-000000000002';
const sessions = new Map<string, any>(), tunnels = new Map<string, any>();
let serial = 0, base: string, admin: string, proc: ChildProcess, entra: Awaited<ReturnType<typeof idp>>;
const body = async (req: IncomingMessage) => JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString() || '{}');
const browser = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://browser.test').pathname, id = path.split('/')[2];
  const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (path === '/sessions' && req.method === 'GET') return void send([...sessions.keys()].map(id => ({ id })));
  if (path === '/sessions' && req.method === 'POST') {
    const id = `b${++serial}`;
    sessions.set(id, await body(req));
    return void send({ id, view: `/sessions/${id}/view`, cdp: `/sessions/${id}/cdp` });
  }
  if (req.method === 'DELETE') {
    sessions.delete(id);
    return void send({ state: { cookies: [{ name: 'SVPNCOOKIE', value: 'cookie', domain: 'vpn.customer.test', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }], origins: [] }, log: [] });
  }
  send({});
});
const tunnel = createServer(async (req, res) => {
  const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (req.url === '/tunnels' && req.method === 'GET') return void send([...tunnels.values()]);
  if (req.url === '/tunnels' && req.method === 'POST') {
    const id = `t${++serial}`, data = { ...await body(req), id, token: `token-${id}`, up: true };
    tunnels.set(id, data);
    return void send(data);
  }
  const id = req.url!.split('/')[2];
  if (req.method === 'DELETE') tunnels.delete(id);
  send(tunnels.get(id) ?? {});
});
const login = async (email: string) => {
  const res = await entra.signIn(base, email);
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
};
async function call(method: string, path: string, data?: unknown, session = admin) {
  const res = await fetch(base + path, { method, headers: { cookie: session }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.equal(res.status, 200, `${method} ${path}: ${await res.clone().text()}`);
  return res;
}
async function access(session: string) {
  const first = await (await call('POST', '/vpns/client/signins', {}, session)).json();
  await call('POST', `/signins/${first.id}`, {}, session);
  const tunnel = [...tunnels.keys()].at(-1)!;
  const { id } = await (await call('POST', '/vpns/client/signins', {}, session)).json();
  return { tunnel, signin: id as string };
}
async function confirm(email: string) {
  const result = once(proc, 'message');
  proc.send!(email);
  return (await result)[0] as { error?: string; left?: boolean };
}

before(async () => {
  entra = await idp();
  await Promise.all([browser, tunnel].map(server => new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))));
  const address = (server: ReturnType<typeof createServer>) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  base = address(probe);
  await new Promise<void>(ok => probe.close(() => ok()));
  const env = { ...process.env, ...entra.env(base), HOME: root, RF_SCRATCH: join(root, 'scratch'), RF_ADMINS: ADMIN, RF_BROWSER_URL: address(browser), RF_BROWSER_KEY: 'browser-key', RF_TUNNEL_URL: address(tunnel), RF_TUNNEL_KEY: 'tunnel-key', RF_TUNNEL_PROXY: 'http://proxy.test:8799', RF_OIDC_REDIRECT_URI: base + '/signin/return', OPENROUTER_API_KEY: '', EXA_API_KEY: '' };
  const script = `
    await import(${JSON.stringify(new URL('../src/server.ts', import.meta.url).href)});
    const { confirm } = await import(${JSON.stringify(new URL('../src/entra.ts', import.meta.url).href)});
    process.on('message', async email => {
      try { await confirm(email); process.send({}); }
      catch (e) { process.send({ error: e.message, left: e.left }); }
    });
  `;
  proc = spawn(process.execPath, ['--input-type=module', '-e', script, 'server', root, new URL(base).port], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  proc.stderr!.on('data', d => { output += d; });
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on('data', d => { output += d; if (String(d).includes('rollforward on')) ok(); });
    proc.once('exit', code => fail(new Error(`server exited ${code}: ${output}`)));
  });
  admin = await login(ADMIN);
  await call('PUT', '/capabilities', { cap: 'vpn', people: [ADMIN, GROUP, OTHER] });
  await call('POST', '/vpns', { name: 'client', type: 'fortinet', gateway: 'vpn.customer.test:10443' });
});
after(async () => {
  proc.kill();
  await once(proc, 'exit');
  await Promise.all([browser, tunnel].map(server => new Promise<void>(ok => server.close(() => ok()))));
  entra.close();
  rmSync(root, { recursive: true, force: true });
});

test('run-start renewal collects VPN sign-ins and tunnels only when fresh groups remove the capability', { timeout: 10000 }, async () => {
  const email = 'renewal@demo.test';
  entra.who.groups[email] = [GROUP, OTHER];
  const session = await login(email), own = await access(session), unrelated = await access(admin);
  entra.who.groups[email] = [OTHER];
  assert.deepEqual(await confirm(email), {});
  assert.ok(sessions.has(own.signin), 'another granted group retains the sign-in');
  assert.ok(tunnels.has(own.tunnel), 'another granted group retains the tunnel');
  delete entra.who.groups[email];
  assert.deepEqual(await confirm(email), {});
  assert.equal(sessions.has(own.signin), false, 'losing the last granted group deletes the remote sign-in browser');
  assert.equal(tunnels.has(own.tunnel), false, 'losing the last granted group deletes the remote tunnel');
  assert.ok(sessions.has(unrelated.signin), 'another person retains their browser');
  assert.ok(tunnels.has(unrelated.tunnel), 'another person retains their tunnel');
  assert.deepEqual(await confirm(ADMIN), {});
  assert.ok(sessions.has(unrelated.signin), 'an email grant survives renewal without groups');
  assert.ok(tunnels.has(unrelated.tunnel), 'an email grant retains its tunnel');
});

test('OIDC callbacks collect VPN resources after group-derived capability loss', { timeout: 10000 }, async () => {
  const email = 'callback@demo.test';
  entra.who.groups[email] = [GROUP, OTHER];
  const own = await access(await login(email));
  entra.who.groups[email] = [OTHER];
  await login(email);
  assert.ok(sessions.has(own.signin), 'another granted group retains the browser');
  assert.ok(tunnels.has(own.tunnel), 'another granted group retains the tunnel');
  delete entra.who.groups[email];
  await login(email);
  for (let i = 0; i < 50 && (sessions.has(own.signin) || tunnels.has(own.tunnel)); i++) await new Promise(ok => setTimeout(ok, 10));
  assert.equal(sessions.has(own.signin), false, 'the configured callback deletes the revoked VPN browser');
  assert.equal(tunnels.has(own.tunnel), false, 'the configured callback deletes the revoked VPN tunnel');
  const before = [...tunnels.keys()];
  await login(ADMIN);
  assert.deepEqual([...tunnels.keys()], before, 'an email grant survives signing in without groups');
});

test('an automatic Entra disable ends website and VPN sign-ins and tunnels, unlike an expired sign-in', { timeout: 10000 }, async () => {
  const email = 'leaver@demo.test';
  entra.who.groups[email] = [GROUP];
  const session = await login(email), own = await access(session);
  await call('POST', '/logins/sites', { name: 'portal', url: 'https://portal.customer.test/' }, session);
  await call('PATCH', '/logins/sites/portal', { via: 'client' }, session);
  const website = await (await call('POST', '/logins/web/portal', {}, session)).json();
  const unrelatedBrowsers = [...sessions.keys()].filter(id => id !== own.signin && id !== website.id);
  const unrelatedTunnels = [...tunnels.keys()].filter(id => id !== own.tunnel);
  entra.who.stale.add(email);
  const expired = await confirm(email);
  assert.match(expired.error!, /AADSTS700082/);
  assert.equal(expired.left, undefined);
  assert.ok(sessions.has(website.id), 'an expired rollforward sign-in is not a disable');
  assert.ok(sessions.has(own.signin));
  assert.ok(tunnels.has(own.tunnel));
  entra.who.stale.delete(email);
  entra.who.gone.add(email);
  const disabled = await confirm(email);
  assert.match(disabled.error!, /AADSTS50057/);
  assert.equal(disabled.left, true);
  assert.equal((await fetch(base + '/me', { headers: { cookie: session } })).status, 401);
  assert.equal(sessions.has(website.id), false, 'automatic disable deletes the website sign-in browser');
  assert.equal(sessions.has(own.signin), false, 'automatic disable deletes the VPN sign-in browser');
  assert.equal(tunnels.has(own.tunnel), false, 'automatic disable deletes the VPN tunnel');
  assert.ok(unrelatedBrowsers.every(id => sessions.has(id)), 'other people retain their browsers');
  assert.ok(unrelatedTunnels.every(id => tunnels.has(id)), 'other people retain their tunnels');
});
