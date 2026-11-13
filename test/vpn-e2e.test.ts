import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { idp } from './idp.ts';

// Uses an exclusive TUNNEL_TEST=1 service and a real browser service with test-only self-signed TLS enabled.
// The test SOCKS container supplies the far-side network, not Fortinet's protocol or a real FortiGate.
test('rollforward signs in, connects, and routes only its website through the real tunnel and browser services', {
  skip: !process.env.RF_TUNNEL_TEST_URL && 'needs RF_TUNNEL_TEST_URL/KEY/PROXY and RF_BROWSER_TEST_URL/KEY; exclusive real services', timeout: 120_000,
}, async t => {
  const tunnelUrl = process.env.RF_TUNNEL_TEST_URL!, tunnelKey = process.env.RF_TUNNEL_TEST_KEY!, proxy = process.env.RF_TUNNEL_TEST_PROXY!;
  const browserUrl = process.env.RF_BROWSER_TEST_URL!, browserKey = process.env.RF_BROWSER_TEST_KEY!;
  const upstreamProxy = new URL(proxy);
  assert.equal(upstreamProxy.protocol, 'http:', 'the local test tunnel proxy speaks HTTP CONNECT');
  const tmp = mkdtempSync(join(tmpdir(), 'rf-vpn-e2e-')), root = join(tmp, 'data'), app = join(import.meta.dirname, '..');
  const ADMIN = 'admin@demo.test', VPN_COOKIE = 'real-browser-vpn-cookie-memory-only', seen: string[] = [];
  let proc: ChildProcess | undefined, far: ChildProcess | undefined, tunnelId = '', output = '';
  const entra = await idp();
  const service = async (url: string, key: string, method: string, path: string, data?: unknown) => {
    const r = await fetch(url + path, { method, headers: { authorization: `Bearer ${key}` }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.ok(r.ok, `${method} ${url}${path}: ${r.status} ${await r.clone().text()}`);
    return r.json();
  };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=rf-vpn-fixture', '-days', '1', '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')], { stdio: 'ignore' });
  const key = readFileSync(join(tmp, 'key.pem')), cert = readFileSync(join(tmp, 'cert.pem'));
  const gateway = createServer({ key, cert }, async (req, res) => {
    const page = (title: string, html = '') => res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>${html}`);
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/complete' && req.method === 'POST') {
      const form = new URLSearchParams(Buffer.concat(await Array.fromAsync(req)).toString());
      assert.equal(form.get('password'), 'fixture-password');
      return void res.writeHead(302, { location: '/connected', 'set-cookie': `SVPNCOOKIE=${VPN_COOKIE}; Path=/; Secure; HttpOnly` }).end();
    }
    if (req.url === '/connected') return void page('VPN signed in');
    if (req.url === '/sso') return void page('Direct SSO');
    page('VPN gateway', '<form method="post" action="/complete"><input name="password" type="password"><button>Sign in</button></form>');
  });
  const proxyRequests: { target: string; authorization: string }[] = [], proxySockets = new Set<Duplex>();
  const viaProxy = createHttpServer().on('connect', (req, socket, head) => {
    proxyRequests.push({ target: req.url!, authorization: String(req.headers['proxy-authorization']) });
    const up = connect(Number(upstreamProxy.port), upstreamProxy.hostname);
    proxySockets.add(socket).add(up);
    socket.on('error', () => up.destroy()).on('close', () => { proxySockets.delete(socket); up.destroy(); });
    up.on('error', () => socket.destroy()).on('close', () => { proxySockets.delete(up); socket.destroy(); });
    up.on('connect', () => {
      up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${req.headers['proxy-authorization']}\r\n\r\n`);
      up.write(head);
      socket.pipe(up).pipe(socket);
    });
  });
  t.after(async () => {
    if (proc?.exitCode === null) { proc.kill(); await once(proc, 'exit'); }
    if (tunnelId) await fetch(`${tunnelUrl}/tunnels/${tunnelId}`, { method: 'DELETE', headers: { authorization: `Bearer ${tunnelKey}` } });
    if (far?.exitCode === null) { far.kill(); await once(far, 'exit'); }
    gateway.closeAllConnections();
    for (const socket of proxySockets) socket.destroy();
    await new Promise<void>(ok => viaProxy.close(() => ok()));
    await new Promise<void>(ok => gateway.close(() => ok()));
    entra.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const here = Object.values(networkInterfaces()).flat().find(a => a!.family === 'IPv4' && !a!.internal)!.address;
  await new Promise<void>(ok => gateway.listen(0, here, ok));
  await new Promise<void>(ok => viaProxy.listen(0, here, ok));
  const viaProxyUrl = `http://${here}:${(viaProxy.address() as { port: number }).port}`;
  const authority = `${here}:${(gateway.address() as { port: number }).port}`;
  mkdirSync(join(root, '.rf'), { recursive: true });
  mkdirSync(join(tmp, 'home'));
  writeFileSync(join(root, '.rf/vpns.json'), JSON.stringify({ test: { type: 'test', gateway: authority } }));
  writeFileSync(join(root, '.rf/capabilities.json'), JSON.stringify({ vpn: [ADMIN] }));
  writeFileSync(join(root, '.rf/internal.json'), JSON.stringify({ [here]: { by: ADMIN, at: new Date().toISOString() } }));
  const probe = createHttpServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise<void>(ok => probe.close(() => ok()));
  proc = spawn(process.execPath, [join(app, 'src/server.ts'), root, new URL(base).port], {
    env: { ...process.env, ...entra.env(base), HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch'), RF_ADMINS: ADMIN,
      RF_TUNNEL_URL: tunnelUrl, RF_TUNNEL_KEY: tunnelKey, RF_TUNNEL_PROXY: viaProxyUrl, RF_BROWSER_URL: browserUrl, RF_BROWSER_KEY: browserKey,
      OPENROUTER_API_KEY: '', EXA_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr!.on('data', d => { output += d; });
  await new Promise<void>((ok, fail) => {
    proc!.stdout!.on('data', d => { output += d; if (String(d).includes('rollforward on')) ok(); });
    proc!.once('exit', code => fail(new Error(`rollforward exited ${code}: ${output}`)));
  });
  const session = (await entra.signIn(base, ADMIN)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  const call = (method: string, path: string, data?: unknown) => fetch(base + path, { method, headers: { cookie: session }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.equal((await call('POST', '/vpns', { name: 'not-production', type: 'test', gateway: authority })).status, 400, 'test types never enter through the production API');
  const opening = await call('POST', '/vpns/test/signins', {});
  assert.equal(opening.status, 200, await opening.clone().text());
  const { id, expires } = await opening.json();
  assert.ok(Date.parse(expires) > Date.now());
  assert.match(await (await call('GET', `/signins/${id}/view`)).text(), /Take control/);
  // Only this local test gateway needs an exact private-address permission in the browser service.
  await service(browserUrl, browserKey, 'PUT', `/sessions/${id}/hosts`, { hosts: [here] });
  const person = await chromium.connectOverCDP(`${base.replace('http', 'ws')}/signins/${id}/view/drive`, { headers: { cookie: session, origin: base } });
  const page = person.contexts()[0].pages()[0];
  await page.goto(`https://${authority}/remote/saml/start`);
  await page.fill('input[name=password]', 'fixture-password');
  await page.click('button');
  await page.waitForURL('**/connected');
  await person.close();
  const connected = await call('POST', `/signins/${id}`, {});
  assert.equal(connected.status, 200, await connected.text());
  assert.equal((await call('GET', `/signins/${id}/view`)).status, 404);
  const remote = await service(tunnelUrl, tunnelKey, 'GET', '/tunnels');
  assert.equal(remote.length, 1);
  assert.equal(remote[0].type, 'test');
  assert.equal(remote[0].up, true);
  tunnelId = remote[0].id;
  const rows = await (await call('GET', '/vpns')).json();
  assert.deepEqual(rows.map((v: any) => [v.name, v.connected]), [['test', true]]);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${VPN_COOKIE}|${tunnelId}|"token"`));

  const python = `import base64,http.server,ssl\nfrom pathlib import Path\nPath('/tmp/vpn-key.pem').write_bytes(base64.b64decode('${key.toString('base64')}'))\nPath('/tmp/vpn-cert.pem').write_bytes(base64.b64decode('${cert.toString('base64')}'))\nclass Portal(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200)\n  self.send_header('Content-Type','text/html')\n  self.end_headers()\n  self.wfile.write(b'<!doctype html><title>Far-side invoices</title><h1>Far-side invoices</h1><a href="/export">Export</a>')\n def log_message(self,*args): pass\ns=http.server.ThreadingHTTPServer(('127.0.0.1',8443),Portal)\nc=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)\nc.load_cert_chain('/tmp/vpn-cert.pem','/tmp/vpn-key.pem')\ns.socket=c.wrap_socket(s.socket,server_side=True)\nprint('far-side TLS ready',flush=True)\ns.serve_forever()\n`;
  far = spawn('podman', ['exec', '-i', `rollforward-tunnel-${tunnelId}`, 'python3', '-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let farOutput = '';
  far.stderr!.on('data', d => { farOutput += d; });
  const ready = new Promise<void>((ok, fail) => {
    far!.stdout!.on('data', d => { farOutput += d; if (String(d).includes('far-side TLS ready')) ok(); });
    far!.once('exit', code => fail(new Error(`far-side TLS exited ${code}: ${farOutput}`)));
  });
  far.stdin!.end(python);
  await ready;
  const website = 'https://localhost.localdomain:8443/';
  assert.equal((await call('POST', '/logins/sites', { name: 'portal', url: website })).status, 200);
  const direct = await call('POST', '/logins/web/portal', {});
  assert.equal(direct.status, 400);
  assert.match(await direct.text(), /internal address/);
  assert.equal((await call('PATCH', '/logins/sites/portal', { via: 'test' })).status, 200);
  assert.equal((await call('POST', '/logins/web/portal/hosts', { host: here })).status, 200);
  const websiteOpening = await call('POST', '/logins/web/portal', {});
  assert.equal(websiteOpening.status, 200, await websiteOpening.clone().text());
  const { id: websiteId } = await websiteOpening.json();
  const web = await chromium.connectOverCDP(`${base.replace('http', 'ws')}/signins/${websiteId}/view/drive`, { headers: { cookie: session, origin: base } });
  const tab = web.contexts()[0].pages()[0];
  assert.equal(await tab.textContent('h1'), 'Far-side invoices', 'the website exists only on the SOCKS container loopback');
  await tab.goto(`https://${authority}/sso`);
  assert.equal(await tab.textContent('h1'), 'Direct SSO', 'an allowed host outside the website domain stays direct');
  await tab.goto(website);
  assert.equal(await tab.textContent('h1'), 'Far-side invoices');
  const requests = await service(browserUrl, browserKey, 'GET', `/sessions/${websiteId}/log`);
  assert.ok(requests.some((r: any) => r.url === website && r.status === 200));
  assert.ok(requests.some((r: any) => r.url === `https://${authority}/sso` && r.status === 200));
  const details = await service(tunnelUrl, tunnelKey, 'GET', `/tunnels/${tunnelId}`);
  assert.ok(details.log.some((line: string) => line.includes('domain localhost.localdomain:8443')), 'SOCKS received the hostname, not a locally resolved address');
  assert.ok(!details.log.some((line: string) => line.includes(`domain ${authority}`)), 'the outside-domain SSO never used CONNECT');
  assert.ok(proxyRequests.length > 0, 'the via proxy double forwards the real tunnel proxy');
  assert.ok(proxyRequests.every(r => r.target === 'localhost.localdomain:8443'), 'only the own-domain hostname reached the via proxy');
  assert.ok(proxyRequests.every(r => /^Bearer [a-f0-9]{64}$/.test(r.authorization)), 'CONNECT uses the tunnel token, never the service key');
  await web.close();
  assert.equal((await call('POST', `/signins/${websiteId}`, {})).status, 200);
  assert.equal((await call('DELETE', '/vpns/test/connection')).status, 200);
  tunnelId = '';
  assert.deepEqual(await service(tunnelUrl, tunnelKey, 'GET', '/tunnels'), []);
  assert.equal((await (await call('GET', '/vpns')).json())[0].connected, false);
  const unavailable = await call('POST', '/logins/web/portal', {});
  assert.equal(unavailable.status, 409);
  assert.match(await unavailable.text(), /connect.*VPN|VPN.*connect/i);
  for (const file of readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile()))
    assert.equal(readFileSync(join(file.parentPath, file.name)).includes(Buffer.from(VPN_COOKIE)), false, file.name);
  assert.ok(!output.includes(VPN_COOKIE));
  assert.ok(seen.includes('POST /complete'));
  assert.ok(seen.includes('GET /sso'));
});
