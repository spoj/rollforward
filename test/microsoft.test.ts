import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// With RF_OIDC_* set, the same Login with Microsoft button goes to Microsoft Entra ID. A stand-in provider plays Microsoft here:
// it signs in whoever the login hint names, and checks the PKCE verifier, the redirect address and, for an app with one, its secret.
// Two servers: an app with a client secret that registers /auth/callback; and a public client, with no secret, that registers the
// site's root, whose logins ask for mail alone, as the ReadWrite permissions a tenant granted.

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-ms-'));
const SECRETS: Record<string, string | undefined> = { 'rf-test': 'shh', 'rf-public': undefined };
let idp: Server, idpBase = '';
const servers: { proc: ChildProcess; base: string }[] = [];
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sessionOf = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0];

async function serve(env: Record<string, string>): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  const base = `http://127.0.0.1:${port}`, root = join(tmp, `data-${port}`);
  mkdirSync(root);
  const vars = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('{base}', base)]));
  const proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], {
    env: { ...process.env, HOME: tmp, RF_SCRATCH: join(tmp, `scratch-${port}`), RF_OIDC_ISSUER: idpBase, RF_PUBLIC_URL: base, RF_ADMINS: 'alex@acme.test', ...vars }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'],
  });
  servers.push({ proc, base });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  return base;
}

// Starts a sign-in as a browser would, and returns its cookie and the address Microsoft sends the browser back to.
async function start(base: string, email: string) {
  const out = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const to = new URL(out.headers.get('location')!);
  to.searchParams.set('login_hint', email);
  return { cookie: out.headers.getSetCookie()[0].split(';')[0], back: (await fetch(to, { redirect: 'manual' })).headers.get('location')! };
}

let confidential = '', publicClient = '';

before(async () => {
  idp = createServer(async (req, res) => {
    const u = new URL(req.url!, idpBase), send = (d: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (u.pathname === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token` });
    if (u.pathname === '/authorize') {
      const p = u.searchParams, code = b64(JSON.stringify({ email: p.get('login_hint'), nonce: p.get('nonce'), challenge: p.get('code_challenge'), client: p.get('client_id'), redirect: p.get('redirect_uri'), scope: p.get('scope') }));
      return void res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }).end();
    }
    let body = '';
    for await (const c of req) body += c;
    const f = new URLSearchParams(body), c = JSON.parse(Buffer.from(f.get('code')!, 'base64url').toString());
    const bad = f.get('client_id') !== c.client || f.get('redirect_uri') !== c.redirect || (f.get('client_secret') ?? undefined) !== SECRETS[c.client]
      || createHash('sha256').update(f.get('code_verifier')!).digest('base64url') !== c.challenge;
    if (bad) return void res.writeHead(400).end('{"error":"invalid_grant","error_description":"AADSTS-like: the code, verifier, redirect or secret does not match"}');
    const claims = { iss: idpBase, aud: c.client, exp: Date.now() / 1000 + 300, nonce: c.nonce, email: c.email, name: 'Alex', sub: `sub-${c.client}-${c.email}`, tid: 't1', oid: `oid-${c.email}` };
    // A refresh token only for a sign-in that asked offline_access, as Microsoft gives it, with what this tenant grants: no sites.
    const scope = c.scope.split(' ').filter((s: string) => s !== 'https://graph.microsoft.com/Sites.Read.All').join(' ');
    send({ id_token: `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.`, scope, ...(c.scope.split(' ').includes('offline_access') && { refresh_token: `refresh-for-${c.email}` }) });
  });
  await new Promise<void>(ok => idp.listen(0, '127.0.0.1', ok));
  idpBase = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  [confidential, publicClient] = await Promise.all([
    serve({ RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'shh' }),
    serve({ RF_OIDC_CLIENT_ID: 'rf-public', RF_OIDC_REDIRECT_URI: '{base}', RF_M365_SCOPES: 'Mail.ReadWrite,Mail.ReadWrite.Shared' }),
  ]);
});

after(async () => {
  for (const { proc } of servers) {
    if (process.platform === 'win32') proc.kill();
    else process.kill(-proc.pid!, 'SIGTERM');
    await once(proc, 'exit');
  }
  idp.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('the button goes to Microsoft, and back with a session; without an app the server does not start', async () => {
  const out = await fetch(`${confidential}/auth/login`, { redirect: 'manual' });
  assert.ok(out.headers.get('location')!.startsWith(`${idpBase}/authorize?`));
  assert.equal(new URL(out.headers.get('location')!).searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(out.headers.get('location')!).searchParams.get('redirect_uri'), `${confidential}/auth/callback`);
  const a = await start(confidential, 'alex@acme.test');
  const s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  const me = await (await fetch(`${confidential}/me`, { headers: { cookie: s } })).json();
  assert.deepEqual([me.email, me.name, me.role], ['alex@acme.test', 'Alex', 'admin']);
  const bare = spawnSync(process.execPath, [join(app, 'src', 'server.ts'), join(tmp, 'bare'), '0'], { env: { ...process.env, HOME: tmp, RF_OIDC_ISSUER: '' }, encoding: 'utf8' });
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /sign-in needs an app registered in Microsoft Entra ID/);
  const loose = spawnSync(process.execPath, [join(app, 'src', 'server.ts'), join(tmp, 'bare'), '0'], { env: { ...process.env, HOME: tmp, RF_OIDC_ISSUER: idpBase, RF_OIDC_CLIENT_ID: 'rf-test', RF_PUBLIC_URL: confidential, RF_AUTO_PROVISION: 'no' }, encoding: 'utf8' });
  assert.match(loose.stderr, /RF_AUTO_PROVISION is 0 or 1, not "no"/, 'nor with a provisioning setting it would read as on');
});

test("Connect Microsoft 365 asks the same app for read-only mail and files, and keeps the person's own login, sealed", async () => {
  const a = await start(confidential, 'alex@acme.test');
  const s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  assert.equal((await fetch(`${confidential}/logins/m365/connect`, { redirect: 'manual', headers: { cookie: s, 'sec-fetch-site': 'cross-site' } })).status, 403, "another site's link doesn't start it");
  const out = await fetch(`${confidential}/logins/m365/connect`, { redirect: 'manual', headers: { cookie: s } });
  const to = new URL(out.headers.get('location')!), pending = out.headers.getSetCookie()[0].split(';')[0];
  assert.deepEqual(to.searchParams.get('scope')!.split(' ').sort(), ['email', 'https://graph.microsoft.com/Files.Read.All', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Read.Shared', 'https://graph.microsoft.com/Sites.Read.All', 'offline_access', 'openid']);
  assert.equal(to.searchParams.get('login_hint'), 'alex@acme.test');
  const other = new URL(to);
  other.searchParams.set('login_hint', 'mallory@acme.test');
  const wrong = await fetch((await fetch(other, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: `${s}; ${pending}` } });
  assert.match(await wrong.text(), /mallory@acme.test's Microsoft account; connect your own/);
  const back = await fetch((await fetch(to, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: `${s}; ${pending}` } });
  assert.equal(back.headers.get('location'), '/#logins');
  const [login] = await (await fetch(`${confidential}/logins`, { headers: { cookie: s } })).json();
  assert.deepEqual([login.id, login.account, login.offers], ['m365', 'alex@acme.test', []], 'it offers nothing until its person adds it');
  assert.deepEqual([login.scopes, login.missing], [['Mail.Read', 'Mail.Read.Shared', 'Files.Read.All'], ['Sites.Read.All']], 'what Microsoft granted, and what its person reconnects to grant');
  assert.equal((await (await fetch(`${publicClient}/me`, { headers: { cookie: s } })).status), 401, 'another server, another session');
});

test("a Databricks connection's Connect asks the same app for Azure Databricks as its person, whose login then offers the warehouses they add by their links", async () => {
  const x = await start(confidential, 'alex@acme.test'), admin = sessionOf(await fetch(x.back, { redirect: 'manual', headers: { cookie: x.cookie } }))!;
  const set = await fetch(`${confidential}/connections/adb`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'databricks' }) });
  assert.equal(set.status, 200);
  const a = await start(confidential, 'lee@acme.test'), s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  const listed = (await (await fetch(`${confidential}/connections`, { headers: { cookie: s } })).json()).find((c: { name: string }) => c.name === 'adb');
  assert.deepEqual([listed.login.id, listed.login.name], ['adb', 'Databricks adb'], 'the Logins page offers it');
  const out = await fetch(`${confidential}/logins/adb/connect`, { redirect: 'manual', headers: { cookie: s } });
  const to = new URL(out.headers.get('location')!), pending = out.headers.getSetCookie()[0].split(';')[0];
  assert.deepEqual(to.searchParams.get('scope')!.split(' ').sort(), ['2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/user_impersonation', 'email', 'offline_access', 'openid']);
  const back = await fetch((await fetch(to, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: `${s}; ${pending}` } });
  assert.equal(back.headers.get('location'), '/#logins');
  const login = (await (await fetch(`${confidential}/logins`, { headers: { cookie: s } })).json()).find((l: { id: string }) => l.id === 'adb');
  assert.deepEqual([login.kind, login.name, login.account, login.offers], ['databricks', 'Databricks adb', 'lee@acme.test', []]);
  const add = await fetch(`${confidential}/logins/adb/offers`, { method: 'POST', headers: { cookie: s, 'content-type': 'application/json' }, body: JSON.stringify({ add: 'https://adb-1.test/sql/warehouses/wh1' }) });
  assert.deepEqual([add.status, await add.text()], [400, 'a link to a SQL warehouse of an Azure Databricks workspace, such as https://adb-123.4.azuredatabricks.net/sql/warehouses/1a2b3c4d5e6f7a8b']);
  assert.equal((await fetch(`${confidential}/logins/adb/offers/${encodeURIComponent('adb:adb-1.azuredatabricks.net/wh1')}`, { method: 'DELETE', headers: { cookie: s } })).status, 200);
  assert.equal((await fetch(`${confidential}/logins/portal/connect`, { redirect: 'manual', headers: { cookie: s } })).status, 404, 'no connection by that login');
});

test("a person signed in through an app since replaced keeps their account, known now by tenant and object id, which another can't take", async () => {
  const file = join(tmp, `data-${new URL(confidential).port}`, '.rf', 'users.json'), all = () => JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...all(), 'lee@acme.test': { role: 'user', sub: 'sub-from-the-old-app' } }));
  const a = await start(confidential, 'lee@acme.test');
  assert.ok(sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } })));
  assert.deepEqual([all()['lee@acme.test'].sub, all()['lee@acme.test'].oid], ['sub-rf-test-lee@acme.test', 't1/oid-lee@acme.test']);
  writeFileSync(file, JSON.stringify({ ...all(), 'lee@acme.test': { ...all()['lee@acme.test'], oid: 't1/someone-else' } }));
  const b = await start(confidential, 'lee@acme.test');
  assert.match(await (await fetch(b.back, { redirect: 'manual', headers: { cookie: b.cookie } })).text(), /lee@acme.test belongs to another Microsoft account/);
});

test('sign-ins started in two tabs both finish, and a forged return is refused', async () => {
  const a = await start(confidential, 'sam@acme.test'), b = await start(confidential, 'sam@acme.test'), jar = `${a.cookie}; ${b.cookie}`;
  assert.ok(sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: jar } })), 'the tab that started first still finishes');
  assert.ok(sessionOf(await fetch(b.back, { redirect: 'manual', headers: { cookie: jar } })));
  const forged = new URL(a.back);
  forged.searchParams.set('state', 'forged');
  assert.equal((await fetch(forged, { redirect: 'manual', headers: { cookie: jar } })).status, 400);
});

test('a public client with no secret, whose app registers the site\'s root, signs in with PKCE alone', async () => {
  const a = await start(publicClient, 'sam@acme.test');
  assert.ok(a.back.startsWith(`${publicClient}?code=`), 'Microsoft sends the browser back to the root');
  const r = await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } });
  assert.equal(r.headers.get('location'), '/');
  const me = await (await fetch(`${publicClient}/me`, { headers: { cookie: sessionOf(r)! } })).json();
  assert.equal(me.email, 'sam@acme.test');
  assert.equal((await fetch(`${publicClient}/`, { redirect: 'manual' })).status, 200, 'the root without a code is still the sign-in page');
});

test("a public client's Microsoft 365 login comes back to its root, asking for mail alone, granted as ReadWrite", async () => {
  const a = await start(publicClient, 'kim@acme.test');
  const s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  const out = await fetch(`${publicClient}/logins/m365/connect`, { redirect: 'manual', headers: { cookie: s } });
  const to = new URL(out.headers.get('location')!), pending = out.headers.getSetCookie()[0].split(';')[0];
  assert.equal(to.searchParams.get('redirect_uri'), publicClient);
  assert.deepEqual(to.searchParams.get('scope')!.split(' ').sort(), ['email', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.ReadWrite.Shared', 'offline_access', 'openid']);
  const back = await fetch((await fetch(to, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: `${s}; ${pending}` } });
  assert.equal(back.headers.get('location'), '/#logins');
  const [login] = await (await fetch(`${publicClient}/logins`, { headers: { cookie: s } })).json();
  assert.deepEqual([login.id, login.account, login.offers], ['m365', 'kim@acme.test', []]);
  const site = await fetch(`${publicClient}/logins/m365/offers`, { method: 'POST', headers: { cookie: s, 'content-type': 'application/json' }, body: JSON.stringify({ add: 'https://acme.sharepoint.com/sites/Finance' }) });
  assert.equal(site.status, 409);
  assert.match(await site.text(), /don't read SharePoint sites: RF_M365_SCOPES has no Sites.Read.All/);
});

test("the sign-in page wears the theme, the default or one RF_THEME names outside the checkout, on the default's tokens, its stylesheets and the logos there before sign-in, the brand's else the theme's; a theme that isn't there stops the server at its start", async () => {
  const css = (f: string) => readFileSync(join(app, 'web', 'css', f), 'utf8');
  const sheet = async (base: string, path: string) => { const r = await fetch(base + path); return [r.status, r.headers.get('content-type'), await r.text()]; };
  assert.match(await (await fetch(confidential)).text(), /<link rel="stylesheet" href="\/css\/signin\.css"><link rel="stylesheet" href="\/css\/theme\.css">\s*<main><div class="box"><h1>Welcome to RollForward<\/h1>[\s\S]*Login with Microsoft<\/a>/, 'a box alone, with no logo to show');
  for (const [path, file] of [['/css/layout.css', 'layout.css'], ['/css/signin.css', 'signin.css'], ['/css/theme-default.css', 'theme-default.css'], ['/css/theme.css', 'theme-default.css']])
    assert.deepEqual(await sheet(confidential, path), [200, 'text/css; charset=utf-8', css(file)], path);
  assert.equal((await fetch(`${confidential}/css/theme-other.css`)).status, 401, 'those alone, by those names');
  assert.equal((await fetch(`${confidential}/brand/logo`)).status, 404);
  assert.equal((await fetch(`${confidential}/css/logo`)).status, 401, 'the default theme has no logo');
  const a = await start(confidential, 'alex@acme.test'), s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const brand = (b: object) => fetch(`${confidential}/brand`, { method: 'PUT', headers: { cookie: s }, body: JSON.stringify(b) });
  assert.equal((await brand({ logo: { name: 'logo.png', data: png } })).status, 200);
  const logo = await fetch(`${confidential}/brand/logo`);
  assert.deepEqual([logo.status, logo.headers.get('content-type'), Buffer.from(await logo.arrayBuffer()).toString('base64')], [200, 'image/png', png]);
  assert.match(await (await fetch(confidential)).text(), /<div class="box"><img class="logo" src="\/brand\/logo" alt=""><h1>/, "the brand's logo atop it");
  assert.equal((await brand({ clear: true })).status, 200);
  // A theme of the deployment's own, outside the checkout, giving the tokens it changes, with its logo beside it; on a server of its
  // own, started last so as to slow none of the tests before it.
  const own = join(tmp, 'themes', 'house.css'), mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#0a7f6a"/></svg>';
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(own, ':root { --primary: #0a7f6a; }\n');
  writeFileSync(join(tmp, 'themes', 'house.svg'), mark);
  const themed = await serve({ RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'shh', RF_THEME: own });
  assert.deepEqual(await sheet(themed, '/css/theme.css'), [200, 'text/css; charset=utf-8', '@import url("/css/theme-default.css");\n:root { --primary: #0a7f6a; }\n'], "on the default's tokens");
  assert.deepEqual(await sheet(themed, '/css/logo'), [200, 'image/svg+xml', mark]);
  assert.match(await (await fetch(themed)).text(), /<main><div class="box"><img class="logo theme" src="\/css\/logo" alt=""><h1>/, "the theme's, where the brand has none");
  const t = await start(themed, 'alex@acme.test'), ts = sessionOf(await fetch(t.back, { redirect: 'manual', headers: { cookie: t.cookie } }))!;
  const me = await (await fetch(`${themed}/me`, { headers: { cookie: ts } })).json();
  assert.deepEqual([me.brand, me.themeLogo], [{ text: null, logo: false }, true], 'and the page shows it, where the brand has none');
  // Not spawnSync, which would hold the event loop while the servers close the connections fetch keeps.
  const none = spawn(process.execPath, [join(app, 'src', 'server.ts'), join(tmp, 'bare'), '0'], { env: { ...process.env, HOME: tmp, RF_THEME: 'nope' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  none.stderr!.on('data', d => { said += d; });
  const [code] = await once(none, 'close');
  assert.notEqual(code, 0);
  assert.match(said, /RF_THEME is default, or the absolute path of a theme's \.css file, not "nope"/);
});
