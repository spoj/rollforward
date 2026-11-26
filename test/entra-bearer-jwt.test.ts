import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureTree } from './owner-fixture.ts';

const b64u = (v: string | Buffer) => (typeof v === 'string' ? Buffer.from(v) : v).toString('base64url');

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const head = b64u(JSON.stringify(header));
  const body = b64u(JSON.stringify(payload));
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(ok => s.close(() => ok()));
  return port;
}

test('Entra ID Bearer JWT auth (server JWKS verification + rf login --az)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-entra-jwt-'));
  const home = mkdtempSync(join(tmpdir(), 'rf-entra-jwt-home-'));
  mkdirSync(join(root, '.rf'));
  writeFixtureTree(root, { workspaces: {}, series: {} });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

  let jwksHits = 0;
  let issuer = '';
  const oidcServer = createHttpServer((req, res) => {
    const u = new URL(req.url!, issuer);
    if (u.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }));
      return;
    }
    if (u.pathname === '/jwks') {
      jwksHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(ok => oidcServer.listen(0, '127.0.0.1', ok));
  issuer = `http://127.0.0.1:${(oidcServer.address() as { port: number }).port}`;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HOME: root,
    RF_SCRATCH: join(root, 'scratch'),
    RF_OIDC_ISSUER: issuer,
    RF_OIDC_CLIENT_ID: 'rf-test-app',
    RF_OIDC_CLIENT_SECRET: 'shh',
    RF_PUBLIC_URL: base,
    RF_ADMINS: 'admin@demo.test',
  };
  delete env.OPENROUTER_API_KEY;
  delete env.RF_BROWSER_URL;

  const proc = spawn(process.execPath, [new URL('../src/server.ts', import.meta.url).pathname, root, String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  try {
    await new Promise<void>((ok, fail) => {
      proc.stdout.on('data', d => String(d).includes('rollforward on') && ok());
      proc.once('exit', code => fail(new Error(`server exited with ${code}`)));
    });

    // Pre-enroll admin with oid and a group (RF_ADMINS cannot be claimed on first use via Bearer JWT).
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify({
      'admin@demo.test': { role: 'admin', name: 'Admin User', oid: 't1/oid-admin', groups: ['g-finance'], epoch: 1 },
      'unlinked@demo.test': { role: 'user', name: 'Unlinked', epoch: 1 },
    }));

    const nowSec = Math.floor(Date.now() / 1000);
    const validApiAud = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'admin@demo.test', name: 'Admin User', tid: 't1', oid: 'oid-admin', groups: ['g-finance', 'g-stale'] },
      privateKey,
    );
    const res1 = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${validApiAud}` } });
    assert.equal(res1.status, 200);
    const me1 = await res1.json() as { email: string; role: string; groups: string[] };
    assert.equal(me1.email, 'admin@demo.test');
    assert.equal(me1.role, 'admin');
    // P1 #5: stale group in JWT cannot restore revoked group; only intersection with stored groups is active.
    assert.deepEqual(me1.groups, ['g-finance']);

    // P1 #5: missing groups claim fails closed to [] without mutating users.json.
    const noGroupsToken = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    const resNoGroups = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${noGroupsToken}` } });
    assert.equal(resNoGroups.status, 200);
    assert.deepEqual(((await resNoGroups.json()) as { groups: string[] }).groups, []);
    const storedUsers = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    assert.deepEqual(storedUsers['admin@demo.test'].groups, ['g-finance']);

    // Second request with raw clientId aud, delegated scope, and upn claim should reuse cached JWKS.
    const validClientAud = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', upn: 'bob@demo.test', name: 'Bob', tid: 't1', oid: 'oid-bob' },
      privateKey,
    );
    const res2 = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${validClientAud}` } });
    assert.equal(res2.status, 200);
    const me2 = await res2.json() as { email: string; role: string };
    assert.equal(me2.email, 'bob@demo.test');
    assert.equal(me2.role, 'user');
    assert.equal(jwksHits, 1, 'JWKS should be cached across requests');

    // P1 #2: ID token (no scp) -> 401; app-only token -> 401; wrong scp -> 401
    const idTokenNoScope = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'rf-test-app', exp: nowSec + 3600, iat: nowSec, preferred_username: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${idTokenNoScope}` } })).status, 401);

    const appOnlyToken = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, idtyp: 'app', scp: 'access_as_user', preferred_username: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${appOnlyToken}` } })).status, 401);

    // P1 #3: missing tid/oid -> 403; pre-provisioned unlinked account -> 403
    const noOid = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'admin@demo.test' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${noOid}` } })).status, 403);

    const unlinked = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'unlinked@demo.test', tid: 't1', oid: 'oid-unlinked' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${unlinked}` } })).status, 403);

    // Expired token -> 401
    const expired = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec - 60, iat: nowSec - 120, scp: 'access_as_user', email: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${expired}` } })).status, 401);

    // Wrong audience -> 401
    const wrongAud = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://other-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', email: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${wrongAud}` } })).status, 401);

    // Wrong issuer -> 401
    const wrongIss = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: 'https://evil.example.com', aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', email: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${wrongIss}` } })).status, 401);

    // Wrong signing key -> 401
    const badSig = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', email: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      otherKey.privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${badSig}` } })).status, 401);

    // alg: none -> 401
    const algNone = `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', email: 'admin@demo.test', tid: 't1', oid: 'oid-admin' }))}.`;
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${algNone}` } })).status, 401);

    // P1 #1 + P1 #6: built cli/rf.mjs rejects missing --resource and HTTP off loopback, succeeds with explicit --resource
    const mockAz = join(home, 'mock-az.sh');
    writeFileSync(mockAz, `#!/usr/bin/env bash
if [[ "$*" != *"--resource api://rf-test-app"* ]]; then
  echo "unexpected args: $*" >&2
  exit 1
fi
printf '%s\\n' '${validApiAud}'
`);
    chmodSync(mockAz, 0o755);

    const rfBuiltPath = new URL('../cli/rf.mjs', import.meta.url).pathname;
    const cliEnv = { ...process.env, HOME: home, RF_AZ_BIN: mockAz };
    assert.throws(() => execFileSync(process.execPath, [rfBuiltPath, 'login', base, '--az'], { env: cliEnv, stdio: 'pipe' }), /--resource/);
    assert.throws(() => execFileSync(process.execPath, [rfBuiltPath, 'login', 'http://example.com', '--az', '--resource', 'api://rf-test-app'], { env: cliEnv, stdio: 'pipe' }), /https:\/\//);

    const loginOut = execFileSync(process.execPath, [rfBuiltPath, 'login', base, '--az', '--resource', 'api://rf-test-app'], { env: cliEnv, encoding: 'utf8' });
    assert.match(loginOut, /signed in as admin@demo\.test \(az\)/);

    const savedCfg = JSON.parse(readFileSync(join(home, '.config', 'rollforward.json'), 'utf8'));
    assert.deepEqual(savedCfg, { url: base, auth: 'az', resource: 'api://rf-test-app' });
    assert.equal('token' in savedCfg, false, 'no static token should be written to disk');

    // Subsequent rf command uses az on demand
    const lsOut = execFileSync(process.execPath, [rfBuiltPath, 'ls', '--json'], { env: cliEnv, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(lsOut), []);

    // P1 #4: local sign-out revokes previously issued JWT
    const uAfter = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    uAfter['admin@demo.test'].epoch = (uAfter['admin@demo.test'].epoch ?? 0) + 1;
    uAfter['admin@demo.test'].revoked_before = (nowSec + 5) * 1000;
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(uAfter));
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${validApiAud}` } })).status, 401);
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    oidcServer.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
