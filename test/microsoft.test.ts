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
// Two servers: one for an app with a client secret that registers /auth/callback, and one for a public client, with no secret, that
// registers the site's root.

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-ms-'));
const SECRETS: Record<string, string | undefined> = { 'rf-test': 'shh', 'rf-public': undefined, 'rf-spa': undefined };
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
    env: { ...process.env, HOME: tmp, RF_OIDC_ISSUER: idpBase, RF_PUBLIC_URL: base, RF_ADMINS: 'alex@acme.test', ...vars }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'],
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

let confidential = '', publicClient = '', spaClient = '';

before(async () => {
  idp = createServer(async (req, res) => {
    const u = new URL(req.url!, idpBase), send = (d: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (u.pathname === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/keys` });
    if (u.pathname === '/keys') return send({ keys: [{ ...signer.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] });
    if (u.pathname === '/authorize') {
      const p = u.searchParams, code = b64(JSON.stringify({ email: p.get('login_hint'), nonce: p.get('nonce'), challenge: p.get('code_challenge'), client: p.get('client_id'), redirect: p.get('redirect_uri') }));
      return void res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }).end();
    }
    let body = '';
    for await (const c of req) body += c;
    const f = new URLSearchParams(body), c = JSON.parse(Buffer.from(f.get('code')!, 'base64url').toString());
    const bad = f.get('client_id') !== c.client || f.get('redirect_uri') !== c.redirect || (f.get('client_secret') ?? undefined) !== SECRETS[c.client]
      || createHash('sha256').update(f.get('code_verifier')!).digest('base64url') !== c.challenge;
    if (bad) return void res.writeHead(400).end('{"error":"invalid_grant","error_description":"AADSTS-like: the code, verifier, redirect or secret does not match"}');
    const claims = { iss: idpBase, aud: c.client, exp: Date.now() / 1000 + 300, nonce: c.nonce, email: c.email, name: 'Alex', sub: `sub-${c.email}` };
    if (c.client === 'rf-spa') {
      // As Microsoft does for a Single-page application: only a cross-origin request, from a browser, may redeem the code.
      if (!req.headers.origin) return void res.writeHead(400).end('{"error":"invalid_request","error_description":"AADSTS9002327: Tokens issued for the \'Single-Page Application\' client-type may only be redeemed via cross-origin requests."}');
      return send({ id_token: signed(claims) });
    }
    send({ id_token: `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.` });
  });
  await new Promise<void>(ok => idp.listen(0, '127.0.0.1', ok));
  idpBase = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  [confidential, publicClient, spaClient] = await Promise.all([
    serve({ RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'shh' }),
    serve({ RF_OIDC_CLIENT_ID: 'rf-public', RF_OIDC_REDIRECT_URI: '{base}' }),
    serve({ RF_OIDC_CLIENT_ID: 'rf-spa', RF_OIDC_REDIRECT_URI: '{base}', RF_OIDC_SPA: '1' }),
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
  assert.deepEqual([me.email, me.sign_in], ['kim@acme.test', 'microsoft']);
});
