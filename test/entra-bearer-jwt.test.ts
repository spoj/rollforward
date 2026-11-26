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

    const nowSec = Math.floor(Date.now() / 1000);
    const validApiAud = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, preferred_username: 'admin@demo.test', name: 'Admin User', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    const res1 = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${validApiAud}` } });
    assert.equal(res1.status, 200);
    const me1 = await res1.json() as { email: string; role: string };
    assert.equal(me1.email, 'admin@demo.test');
    assert.equal(me1.role, 'admin');

    // Second request with raw clientId aud and upn claim should reuse cached JWKS.
    const validClientAud = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'rf-test-app', exp: nowSec + 3600, upn: 'bob@demo.test', name: 'Bob', tid: 't1', oid: 'oid-bob' },
      privateKey,
    );
    const res2 = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${validClientAud}` } });
    assert.equal(res2.status, 200);
    const me2 = await res2.json() as { email: string; role: string };
    assert.equal(me2.email, 'bob@demo.test');
    assert.equal(me2.role, 'user');
    assert.equal(jwksHits, 1, 'JWKS should be cached across requests');

    // Expired token -> 401
    const expired = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec - 60, email: 'admin@demo.test' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${expired}` } })).status, 401);

    // Wrong audience -> 401
    const wrongAud = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://other-app', exp: nowSec + 3600, email: 'admin@demo.test' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${wrongAud}` } })).status, 401);

    // Wrong issuer -> 401
    const wrongIss = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: 'https://evil.example.com', aud: 'api://rf-test-app', exp: nowSec + 3600, email: 'admin@demo.test' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${wrongIss}` } })).status, 401);

    // Wrong signing key -> 401
    const badSig = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, email: 'admin@demo.test' },
      otherKey.privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${badSig}` } })).status, 401);

    // alg: none -> 401
    const algNone = `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, email: 'admin@demo.test' }))}.`;
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${algNone}` } })).status, 401);

    // CLI: rf login URL --az with mock az binary, zero static secret written to disk
    const mockAz = join(home, 'mock-az.sh');
    writeFileSync(mockAz, `#!/usr/bin/env bash
if [[ "$*" != *"--resource api://rf-test-app"* ]]; then
  echo "unexpected args: $*" >&2
  exit 1
fi
printf '%s\\n' '${validApiAud}'
`);
    chmodSync(mockAz, 0o755);

    const rfPath = new URL('../src/rf-people.ts', import.meta.url).pathname;
    const cliEnv = { ...process.env, HOME: home, RF_AZ_BIN: mockAz };
    const loginOut = execFileSync(process.execPath, [rfPath, 'login', base, '--az'], { env: cliEnv, encoding: 'utf8' });
    assert.match(loginOut, /signed in as admin@demo\.test \(az\)/);

    const savedCfg = JSON.parse(readFileSync(join(home, '.config', 'rollforward.json'), 'utf8'));
    assert.deepEqual(savedCfg, { url: base, auth: 'az', resource: 'api://rf-test-app' });
    assert.equal('token' in savedCfg, false, 'no static token should be written to disk');

    // Subsequent rf command uses az on demand
    const lsOut = execFileSync(process.execPath, [rfPath, 'ls', '--json'], { env: cliEnv, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(lsOut), []);
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    oidcServer.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
