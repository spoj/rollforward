import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string, config: string, server: Server;
let me: { role: string; can: string[] }, meStatus: number;
let calls: { method: string; path: string; body: any; authorization: string | undefined }[];
let capabilities: Record<string, string[]>;
const rows = [
  { name: 'client-one', type: 'fortinet', gateway: 'vpn.client.test:443', connected: true, since: '2026-11-01T12:00:00Z' },
  { name: 'client-two', type: 'fortinet', gateway: 'vpn.other.test:10443', connected: false, error: 'Sign in again' },
];
const description = 'Alice asks that runs in Weekly use their login to portal through client VPN client-one. Runs can do whatever Alice can, including submitting and approving. Their reason is not an enforced limit.';
const card = { id: 'g1', workspace: 'w1', state: 'pending', at: '2026-11-01T12:00:00Z', description, flags: ['Can approve invoices'], adminOnly: false };

beforeEach(async t => {
  home = mkdtempSync(join(tmpdir(), 'rf-vpn-cli-'));
  config = join(home, '.config', 'rollforward.json');
  me = { role: 'admin', can: ['publish', 'create', 'keepalive'] };
  meStatus = 200;
  calls = [];
  capabilities = { publish: [], create: [], keepalive: [], vpn: [] };
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, path = req.url!, method = req.method!;
    calls.push({ method, path, body, authorization: req.headers.authorization });
    const send = (status: number, value: unknown) => {
      res.writeHead(status);
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (path === '/me') return send(meStatus, meStatus === 200 ? me : 'token revoked');
    if (path === '/vpns' || path.startsWith('/vpns/')) {
      if (!me.can.includes('vpn')) return send(404, 'not found');
      if (method === 'GET') return send(200, rows);
      if (me.role !== 'admin') return send(403, 'admins manage VPN definitions');
      if (method === 'POST' && body.type !== 'fortinet') return send(400, 'VPN type must be fortinet');
      return send(200, {});
    }
    if (path === '/logins/sites') return send(200, { portal: { url: 'https://portal.client.test/', hosts: ['portal.client.test'], via: 'client-one', checks: { 'portal.client.test': { verdict: 'pass', why: 'Known website host' } } } });
    if (path.startsWith('/logins/sites/') && method === 'PATCH') return send(me.can.includes('vpn') ? 200 : 403, me.can.includes('vpn') ? {} : 'VPN access required');
    if (path === '/capabilities') {
      if (method === 'PUT') capabilities[body.cap] = body.people;
      return send(200, capabilities);
    }
    if (path === '/api') return send(200, [{ id: 'w1', name: 'Weekly' }]);
    if (path === '/grants') return send(200, [card]);
    if (path === '/grants/g1' && method === 'POST') return send(200, {});
    send(404, 'unexpected route');
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  mkdirSync(join(home, '.config'));
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'rft_test' }));
  t.after(async () => {
    await new Promise<void>((ok, fail) => server.close(e => e ? fail(e) : ok()));
    rmSync(home, { recursive: true, force: true });
  });
});

const rf = (...args: string[]) => new Promise<string>((ok, fail) => {
  const p = spawn(process.execPath, [new URL('../src/rf-people.ts', import.meta.url).pathname, ...args], { env: { ...process.env, HOME: home } });
  let out = '', err = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (err += d));
  p.on('close', code => code ? fail(Object.assign(new Error(err), { code, stdout: out })) : ok(out));
});

const helpArgs = [[], ['help'], ['help', 'site'], ['help', 'vpn'], ['help', 'vpns'], ['help', 'can']];

test('without config, bare rf and every help form stay offline and never mention VPN or --via', async () => {
  rmSync(config);
  for (const args of helpArgs) {
    const out = await rf(...args);
    assert.doesNotMatch(out, /vpn|--via/i);
    assert.match(out, /^(rf |rollforward)/);
  }
  assert.match(await rf('--version'), /^\d+\.\d+\.\d+\n$/);
  assert.deepEqual(calls, []);
  await assert.rejects(rf('vpns'), { code: 1, message: 'rf: sign in first: rf login URL\n', stdout: '' });
});

test('configured help reads live /me and hides VPN from noncap users and admins alike', async () => {
  for (const role of ['user', 'admin']) {
    me.role = role;
    for (const args of helpArgs) assert.doesNotMatch(await rf(...args), /vpn|--via/i);
  }
  assert.equal(calls.length, helpArgs.length * 2);
  assert.ok(calls.every(c => c.method === 'GET' && c.path === '/me' && c.authorization === 'Bearer rft_test'));
});

test('explicit VPN users see list and site routing help, but only opted-in admins see definition management', async () => {
  me = { role: 'user', can: ['vpn'] };
  for (const args of [[], ['help']]) {
    const out = await rf(...args);
    assert.match(out, /rf vpns \[--json\]/);
    assert.match(out, /--via VPN/);
    assert.match(out, /--via '' clears it/);
    assert.doesNotMatch(out, /rf vpn (add|remove)/);
  }
  assert.match(await rf('help', 'site'), /--via VPN/);
  assert.match(await rf('help', 'vpns'), /^rf vpns \[--json\][^\n]+\n$/);
  me.role = 'admin';
  for (const args of [[], ['help'], ['help', 'vpn']]) {
    const out = await rf(...args);
    assert.match(out, /rf vpn add NAME fortinet HOST:PORT/);
    assert.match(out, /rf vpn remove NAME/);
  }
  assert.match(await rf('help', 'can'), /vpn, using client VPNs, needs an explicit grant even for admins/);
  me.can = [];
  assert.doesNotMatch(await rf(), /vpn|--via/i);
});

test('syntax errors use the same contextual help without exposing VPN to noncap admins', async () => {
  await assert.rejects(rf('vpn'), e => e instanceof Error && (e as any).code === 2 && !/vpn|--via/i.test(e.message));
  me.can.push('vpn');
  await assert.rejects(rf('vpn'), e => e instanceof Error && (e as any).code === 2 && /^rf vpn add NAME fortinet HOST:PORT[^\n]+\nrf vpn remove NAME[^\n]+\n$/.test(e.message));
  await assert.rejects(rf('site'), e => e instanceof Error && (e as any).code === 2 && /--via VPN/.test(e.message));
});

test('configured help propagates /me and config errors instead of falling back to offline help', async () => {
  meStatus = 401;
  for (const args of [[], ['help'], ['help', 'site']]) {
    await assert.rejects(rf(...args), { code: 1, message: 'rf: GET /me: 401 token revoked\n', stdout: '' });
  }
  assert.equal(calls.length, 3);
  writeFileSync(config, '{');
  await assert.rejects(rf('help'), e => e instanceof Error && e.message.startsWith('rf: ') && !/vpn|rf login/i.test(e.message));
  assert.equal(calls.length, 3);
});

test('VPN commands use the raw API and preserve capability and admin refusals', async () => {
  for (const role of ['user', 'admin']) {
    me.role = role;
    await assert.rejects(rf('vpns'), { code: 1, message: 'rf: GET /vpns: 404 not found\n' });
    await assert.rejects(rf('vpn', 'add', 'client-one', 'fortinet', 'vpn.client.test:443'), { code: 1, message: 'rf: POST /vpns: 404 not found\n' });
    await assert.rejects(rf('vpn', 'remove', 'client-one'), { code: 1, message: 'rf: DELETE /vpns/client-one: 404 not found\n' });
  }
  me = { role: 'user', can: ['vpn'] };
  const out = await rf('vpns');
  assert.match(out, /^client-one  fortinet  vpn\.client\.test:443  connected since /m);
  assert.match(out, /^client-two  fortinet  vpn\.other\.test:10443  disconnected: Sign in again$/m);
  assert.deepEqual(JSON.parse(await rf('vpns', '--json')), rows);
  await assert.rejects(rf('vpn', 'add', 'client-one', 'fortinet', 'vpn.client.test:443'), { code: 1, message: 'rf: POST /vpns: 403 admins manage VPN definitions\n' });
  await assert.rejects(rf('vpn', 'remove', 'client-one'), { code: 1, message: 'rf: DELETE /vpns/client-one: 403 admins manage VPN definitions\n' });
  me.role = 'admin';
  assert.equal(await rf('vpn', 'add', 'client-one', 'fortinet', 'vpn.client.test:443'), 'added client-one\n');
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/vpns', body: { name: 'client-one', type: 'fortinet', gateway: 'vpn.client.test:443' }, authorization: 'Bearer rft_test' });
  assert.equal(await rf('vpn', 'remove', 'Client west'), 'removed Client west\n');
  assert.deepEqual(calls.at(-1), { method: 'DELETE', path: '/vpns/Client%20west', body: undefined, authorization: 'Bearer rft_test' });
  await assert.rejects(rf('vpn', 'add', 'client-one', 'unsupported', 'vpn.client.test:443'), { code: 1, message: 'rf: POST /vpns: 400 VPN type must be fortinet\n' });
  assert.ok(calls.every(c => c.path !== '/me'), 'execution leaves authorization to the API');
});

test('can vpn uses the generic capabilities endpoint and an empty grant never says admins only', async () => {
  assert.equal(await rf('can', 'vpn'), 'vpn: no one\n');
  assert.equal(await rf('can', 'vpn', 'alice@demo.test, group-id'), 'vpn: alice@demo.test, group-id\n');
  assert.deepEqual(calls.at(-1), { method: 'PUT', path: '/capabilities', body: { cap: 'vpn', people: ['alice@demo.test', 'group-id'] }, authorization: 'Bearer rft_test' });
  assert.deepEqual(JSON.parse(await rf('can', 'vpn', '--json')), capabilities);
  assert.equal(await rf('can', 'vpn', '--clear'), 'vpn: no one\n');
  assert.deepEqual(calls.at(-1)?.body, { cap: 'vpn', people: [] });
  assert.equal(await rf('can', 'publish'), 'publish: admins only\n');
  assert.ok(calls.every(c => c.path === '/capabilities'));
});

test('site set forwards --via and its empty clear; sites show routing only to opted-in people', async () => {
  me.can.push('vpn');
  assert.equal(await rf('site', 'set', 'portal', '--via', 'client-one', '--keepalive', '/home', '--person', 'alice@demo.test'), 'saved\n');
  assert.deepEqual(calls.at(-1), { method: 'PATCH', path: '/logins/sites/portal?person=alice%40demo.test', body: { via: 'client-one', keepalive: '/home' }, authorization: 'Bearer rft_test' });
  assert.equal(await rf('site', 'set', 'portal', '--via', ''), 'saved\n');
  assert.deepEqual(calls.at(-1)?.body, { via: '' });
  me.role = 'user';
  assert.match(await rf('sites'), /^portal  https:\/\/portal\.client\.test\/ via client-one\n  reaches portal\.client\.test: Known website host\n$/);
  assert.equal(JSON.parse(await rf('sites', '--json')).portal.via, 'client-one');
  me = { role: 'admin', can: [] };
  assert.doesNotMatch(await rf('sites'), /via|client-one/i);
  assert.equal('via' in JSON.parse(await rf('sites', '--json')).portal, false);
  await assert.rejects(rf('site', 'set', 'portal', '--via', ''), { code: 1, message: 'rf: PATCH /logins/sites/portal: 403 VPN access required\n' });
});

test('noncap owners still read the full server-provided client VPN grant disclosure', async () => {
  me = { role: 'user', can: [] };
  assert.ok((await rf('grants')).includes(description));
  assert.deepEqual(JSON.parse(await rf('grants', '--json')), [{ ...card, workspace: 'Weekly' }]);
  assert.equal(await rf('grant', 'approve', 'g1'), `${description} Flags: Can approve invoices.\napproved\n`);
});
