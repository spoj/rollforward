import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// With RF_OIDC_* set, the same Sign in with Microsoft button goes to Microsoft Entra ID. A stand-in provider plays Microsoft here:
// it signs in whoever the login hint names, and checks the PKCE verifier, the redirect address and, for an app with one, its secret.
// Four servers: an app with a client secret that registers /auth/callback; a public client, with no secret, that registers the site's
// root; and two Single-page applications that register the site's root, one also with a secret and /auth/m365 as a Web redirect,
// whose logins ask for mail alone.

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-ms-'));
const SECRETS: Record<string, string | undefined> = { 'rf-test': 'shh', 'rf-public': undefined, 'rf-spa': undefined, 'rf-spa-web': 'shh2' };
// The provider signs ID tokens with this key and publishes it; the other key stands in for a forger.
const signer = generateKeyPairSync('rsa', { modulusLength: 2048 }), forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signed = (claims: object, key = signer.privateKey) => {
  const data = `${b64(JSON.stringify({ alg: 'RS256', kid: 'k1' }))}.${b64(JSON.stringify(claims))}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
};
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

let confidential = '', publicClient = '', spaClient = '', spaWeb = '';

before(async () => {
  idp = createServer(async (req, res) => {
    const u = new URL(req.url!, idpBase), send = (d: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (u.pathname === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/keys` });
    if (u.pathname === '/keys') return send({ keys: [{ ...signer.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] });
    if (u.pathname === '/authorize') {
      const p = u.searchParams, code = b64(JSON.stringify({ email: p.get('login_hint'), nonce: p.get('nonce'), challenge: p.get('code_challenge'), client: p.get('client_id'), redirect: p.get('redirect_uri'), scope: p.get('scope') }));
      return void res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }).end();
    }
    let body = '';
    for await (const c of req) body += c;
    const f = new URLSearchParams(body), c = JSON.parse(Buffer.from(f.get('code')!, 'base64url').toString());
    // A code for a Single-page application's redirect is a browser's to redeem, with no secret; one for a Web redirect, the server's.
    const web = !c.client.startsWith('rf-spa') || c.redirect.endsWith('/auth/m365');
    const bad = f.get('client_id') !== c.client || f.get('redirect_uri') !== c.redirect || (f.get('client_secret') ?? undefined) !== (web ? SECRETS[c.client] : undefined)
      || createHash('sha256').update(f.get('code_verifier')!).digest('base64url') !== c.challenge;
    if (bad) return void res.writeHead(400).end('{"error":"invalid_grant","error_description":"AADSTS-like: the code, verifier, redirect or secret does not match"}');
    const claims = { iss: idpBase, aud: c.client, exp: Date.now() / 1000 + 300, nonce: c.nonce, email: c.email, name: 'Alex', sub: `sub-${c.email}` };
    if (!web) {
      // As Microsoft does for a Single-page application: only a cross-origin request, from a browser, may redeem the code.
      if (!req.headers.origin) return void res.writeHead(400).end('{"error":"invalid_request","error_description":"AADSTS9002327: Tokens issued for the \'Single-Page Application\' client-type may only be redeemed via cross-origin requests."}');
      return send({ id_token: signed(claims) });
    }
    // A refresh token only for a sign-in that asked offline_access, as Microsoft gives it.
    send({ id_token: `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.`, ...(c.scope.split(' ').includes('offline_access') && { refresh_token: `refresh-for-${c.email}` }) });
  });
  await new Promise<void>(ok => idp.listen(0, '127.0.0.1', ok));
  idpBase = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  [confidential, publicClient, spaClient, spaWeb] = await Promise.all([
    serve({ RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'shh' }),
    serve({ RF_OIDC_CLIENT_ID: 'rf-public', RF_OIDC_REDIRECT_URI: '{base}' }),
    serve({ RF_OIDC_CLIENT_ID: 'rf-spa', RF_OIDC_REDIRECT_URI: '{base}', RF_OIDC_SPA: '1' }),
    serve({ RF_OIDC_CLIENT_ID: 'rf-spa-web', RF_OIDC_REDIRECT_URI: '{base}', RF_OIDC_SPA: '1', RF_OIDC_CLIENT_SECRET: 'shh2', RF_M365_SCOPES: 'Mail.Read Mail.Read.Shared' }),
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

test('the button goes to Microsoft, and back with a session; the demo picker is gone', async () => {
  const out = await fetch(`${confidential}/auth/login`, { redirect: 'manual' });
  assert.ok(out.headers.get('location')!.startsWith(`${idpBase}/authorize?`));
  assert.equal(new URL(out.headers.get('location')!).searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(out.headers.get('location')!).searchParams.get('redirect_uri'), `${confidential}/auth/callback`);
  assert.equal((await fetch(`${confidential}/auth/demo`, { method: 'POST', body: new URLSearchParams({ email: 'admin@demo.test' }) })).status, 401);
  const a = await start(confidential, 'alex@acme.test');
  const s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  const me = await (await fetch(`${confidential}/me`, { headers: { cookie: s } })).json();
  assert.deepEqual([me.email, me.name, me.role, me.sign_in], ['alex@acme.test', 'Alex', 'admin', 'microsoft']);
});

test("Connect Microsoft 365 asks the same app for read-only mail and files, and keeps the person's own login, sealed", async () => {
  const a = await start(confidential, 'alex@acme.test');
  const s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  assert.equal((await (await fetch(`${confidential}/me`, { headers: { cookie: s } })).json()).m365, true);
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
  assert.deepEqual([login.id, login.account, login.offers.map((o: { id: string }) => o.id)], ['m365', 'alex@acme.test', ['m365:mail:alex@acme.test', 'm365:onedrive']]);
  assert.equal((await (await fetch(`${spaClient}/me`, { headers: { cookie: s } })).status), 401, 'another server, another session');
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
  assert.deepEqual([me.email, me.sign_in], ['sam@acme.test', 'microsoft']);
  assert.equal((await fetch(`${publicClient}/`, { redirect: 'manual' })).status, 200, 'the root without a code is still the sign-in page');
});

test('a Single-page application app: the browser redeems the code, and the server takes only a token Microsoft signed for this sign-in', async () => {
  const a = await start(spaClient, 'kim@acme.test');
  const page = await (await fetch(a.back, { headers: { cookie: a.cookie } })).text();
  // What the page's script does: redeem the code cross-origin, then post the ID token back with the sign-in's state.
  const endpoint = JSON.parse(page.match(/fetch\(("[^"]+")/)![1]), form = JSON.parse(page.match(/new URLSearchParams\((\{.*?\})\)/)![1]);
  const state = page.match(/name="state" value="([^"]+)"/)![1];
  assert.doesNotThrow(() => new Function(page.match(/<script>([\s\S]*)<\/script>/)![1]), 'the page\'s script parses');
  assert.equal(form.redirect_uri, spaClient);
  assert.match((await (await fetch(endpoint, { method: 'POST', body: new URLSearchParams(form) })).text()), /AADSTS9002327/, 'without a browser\'s Origin, as from the server, the provider refuses');
  const { id_token } = await (await fetch(endpoint, { method: 'POST', body: new URLSearchParams(form), headers: { origin: spaClient } })).json();
  const post = (token: string) => fetch(`${spaClient}/auth/token`, { method: 'POST', redirect: 'manual', headers: { cookie: a.cookie }, body: new URLSearchParams({ state, id_token: token }) });

  const [h, p, s] = id_token.split('.'), claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal((await post(`${h}.${b64(JSON.stringify({ ...claims, email: 'boss@acme.test' }))}.${s}`)).status, 401, 'a changed token is refused');
  assert.equal((await post(signed(claims, forger.privateKey))).status, 401, 'a token signed by anyone else is refused');
  assert.equal((await post(`${b64('{"alg":"none"}')}.${p}.`)).status, 401, 'an unsigned token is refused');
  assert.equal((await post(signed({ ...claims, nonce: 'other' }))).status, 401, 'a token for another sign-in is refused');

  const r = await post(id_token);
  assert.equal(r.headers.get('location'), '/');
  const me = await (await fetch(`${spaClient}/me`, { headers: { cookie: sessionOf(r)! } })).json();
  assert.deepEqual([me.email, me.sign_in, me.m365], ['kim@acme.test', 'microsoft', false]);
});

test("a Single-page application with its secret: sign-in stays the browser's, and Microsoft 365 comes back to /auth/m365, asking for mail alone", async () => {
  const a = await start(spaWeb, 'kim@acme.test'), page = await (await fetch(a.back, { headers: { cookie: a.cookie } })).text();
  const endpoint = JSON.parse(page.match(/fetch\(("[^"]+")/)![1]), form = JSON.parse(page.match(/new URLSearchParams\((\{.*?\})\)/)![1]);
  const { id_token } = await (await fetch(endpoint, { method: 'POST', body: new URLSearchParams(form), headers: { origin: spaWeb } })).json();
  const signedIn = await fetch(`${spaWeb}/auth/token`, { method: 'POST', redirect: 'manual', headers: { cookie: a.cookie }, body: new URLSearchParams({ state: page.match(/name="state" value="([^"]+)"/)![1], id_token }) });
  const s = sessionOf(signedIn)!;
  assert.equal((await (await fetch(`${spaWeb}/me`, { headers: { cookie: s } })).json()).m365, true);
  const out = await fetch(`${spaWeb}/logins/m365/connect`, { redirect: 'manual', headers: { cookie: s } });
  const to = new URL(out.headers.get('location')!), pending = out.headers.getSetCookie()[0].split(';')[0];
  assert.equal(to.searchParams.get('redirect_uri'), `${spaWeb}/auth/m365`);
  assert.deepEqual(to.searchParams.get('scope')!.split(' ').sort(), ['email', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Read.Shared', 'offline_access', 'openid']);
  const back = await fetch((await fetch(to, { redirect: 'manual' })).headers.get('location')!, { redirect: 'manual', headers: { cookie: `${s}; ${pending}` } });
  assert.equal(back.headers.get('location'), '/#logins');
  const [login] = await (await fetch(`${spaWeb}/logins`, { headers: { cookie: s } })).json();
  assert.deepEqual([login.id, login.account, login.offers.map((o: { id: string }) => o.id)], ['m365', 'kim@acme.test', ['m365:mail:kim@acme.test']]);
  const site = await fetch(`${spaWeb}/logins/m365/offers`, { method: 'POST', headers: { cookie: s, 'content-type': 'application/json' }, body: JSON.stringify({ site: 'https://acme.sharepoint.com/sites/Finance' }) });
  assert.equal(site.status, 409);
  assert.match(await site.text(), /don't read SharePoint sites: RF_M365_SCOPES has no Sites.Read.All/);
});
