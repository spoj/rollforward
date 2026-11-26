import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
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

    // Pre-enroll admin and bob with oid (Bearer JWTs never auto-provision or bind new OIDs).
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify({
      'admin@demo.test': { role: 'admin', name: 'Admin User', oid: 't1/oid-admin', groups: ['g-finance'], epoch: 1, revoked_epoch: 1 },
      'bob@demo.test': { role: 'user', name: 'Bob', oid: 't1/oid-bob', groups: [], epoch: 1, revoked_epoch: 1 },
      'unlinked@demo.test': { role: 'user', name: 'Unlinked', epoch: 1, revoked_epoch: 1 },
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

    // P1 #1 + P1 #6 + P1-D: pack @rfany/rf in isolated temp dir (clean-CI safe) and execute extracted rf.mjs
    const mockAz = join(home, 'mock-az.sh');
    writeFileSync(mockAz, `#!/usr/bin/env bash
if [[ "$*" != *"--resource api://rf-test-app"* ]]; then
  echo "unexpected args: $*" >&2
  exit 1
fi
printf '%s\\n' '${validApiAud}'
`);
    chmodSync(mockAz, 0o755);

    const packDir = mkdtempSync(join(tmpdir(), 'rf-cli-pack-'));
    const cliDir = new URL('../cli', import.meta.url).pathname;
    const tgzName = execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], { cwd: cliDir, encoding: 'utf8' }).trim().split('\n').at(-1)!;
    execFileSync('tar', ['-xzf', join(packDir, tgzName), '-C', packDir]);
    const rfBuiltPath = join(packDir, 'package', 'rf.mjs');
    const cliEnv = { ...process.env, HOME: home, RF_AZ_BIN: mockAz };
    try {
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
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }

    // P1-C: member with stored manager group omitted from JWT cannot transfer series ownership
    writeFixtureTree(root, {
      workspaces: { w1: { name: 'Team', owners: ['g-mgr'], members: ['carol@demo.test', 'dave@demo.test'] } },
      series: { s1: { name: 'Monthly', workspace: 'w1' } },
    });
    mkdirSync(join(root, 's1'), { recursive: true });
    writeFileSync(join(root, 's1', 'settings.json'), JSON.stringify({ version: 1, owner: 'dave@demo.test', epoch: 1, since: new Date().toISOString() }));
    const uMgr = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    uMgr['carol@demo.test'] = { role: 'user', name: 'Carol', oid: 't1/oid-carol', groups: ['g-mgr'], epoch: 1, revoked_epoch: 1 };
    uMgr['dave@demo.test'] = { role: 'user', name: 'Dave', oid: 't1/oid-dave', groups: [], epoch: 1, revoked_epoch: 1 };
    // P1-A: pre-granted email in workspace without user row cannot auto-provision via JWT
    writeFixtureTree(root, {
      workspaces: { w1: { name: 'Team', owners: ['g-mgr', 'pregranted@demo.test'], members: ['carol@demo.test', 'dave@demo.test'] } },
      series: { s1: { name: 'Monthly', workspace: 'w1' } },
    });
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(uMgr));

    const carolNoGroupJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'carol@demo.test', tid: 't1', oid: 'oid-carol' },
      privateKey,
    );
    const transferRes = await fetch(`${base}/api/series/s1/owner`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${carolNoGroupJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'carol@demo.test' }),
    });
    assert.equal(transferRes.status, 403, 'JWT without manager group must not transfer ownership using stored group');

    const preGrantedJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'pregranted@demo.test', tid: 't1', oid: 'oid-pregranted' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${preGrantedJwt}` } })).status, 403);

    // P1-2: brand-new email (even with no grants and auto-provision enabled) cannot auto-provision or bind OID via Bearer JWT
    const newbieJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'newbie@demo.test', tid: 't1', oid: 'oid-newbie' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${newbieJwt}` } })).status, 403);
    assert.equal('newbie@demo.test' in JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8')), false);

    // P1-4: wake-check and VPN-routed sign-in must enforce admitted JWT capabilities, not stored groups
    const uCap = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    uCap['carol@demo.test'] = { role: 'user', name: 'Carol', oid: 't1/oid-carol', groups: ['g-mgr', 'g-wc', 'g-vpn'], epoch: 1, revoked_epoch: 1 };
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(uCap));
    writeFileSync(join(root, '.rf', 'capabilities.json'), JSON.stringify({ 'wake-check': ['g-wc'], vpn: ['g-vpn'] }));
    mkdirSync(join(root, 's_wc'), { recursive: true });
    const nowIso = new Date().toISOString();
    writeFileSync(join(root, 's_wc', 'settings.json'), JSON.stringify({ version: 1, owner: 'carol@demo.test', epoch: 1, since: nowIso, consent: { by: 'carol@demo.test', at: nowIso, workspace: 'w1', logins: [], autonomous: true } }));
    writeFixtureTree(root, {
      workspaces: { w1: { name: 'Team', owners: ['g-mgr'], members: ['carol@demo.test', 'dave@demo.test'] } },
      series: { s1: { name: 'Monthly', workspace: 'w1' }, s_wc: { name: 'Checked', workspace: 'w1' } },
    });
    const wcRes = await fetch(`${base}/api/wakes/s_wc`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${carolNoGroupJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ at: new Date(Date.now() + 3_600_000).toISOString(), label: '2026-12', check: 'working/check.py' }),
    });
    assert.equal(wcRes.status, 403, 'JWT without wake-check group must not schedule a wake-check');

    const carolDir = join(root, '.rf', 'people', createHash('sha256').update('carol@demo.test').digest('hex').slice(0, 16));
    mkdirSync(carolDir, { recursive: true });
    writeFileSync(join(carolDir, 'websites.json'), JSON.stringify({ corp: { url: 'https://corp.example.com/', via: 'corp-vpn', added: nowIso } }));
    const vpnSignInRes = await fetch(`${base}/logins/web/corp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${carolNoGroupJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(vpnSignInRes.status, 403, 'JWT without vpn group must not open a VPN-routed website sign-in');

    // P1-3: streamed upload must recheck effective JWT workspace visibility at commit, not stored groups
    const newInstRes = await fetch(`${base}/api/series/s1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${validApiAud}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: '2026-11', quiet: true }),
    });
    assert.equal(newInstRes.status, 200);
    const { id: instId } = await newInstRes.json() as { id: string };
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>(ok => { releaseBody = ok; });
    const slowBody = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '));
        await bodyGate;
        controller.enqueue(new TextEncoder().encode('world'));
        controller.close();
      },
    });
    const uploadPromise = fetch(`${base}/api/instances/${instId}/upload?name=test.txt&quiet=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${carolNoGroupJwt}` },
      body: slowBody,
      // @ts-expect-error duplex required by undici for ReadableStream request body
      duplex: 'half',
    });
    // Withdraw carol's direct membership while upload is in flight (she still has stored g-mgr in users.json, omitted from JWT)
    await new Promise(r => setTimeout(r, 50));
    writeFixtureTree(root, {
      workspaces: { w1: { name: 'Team', owners: ['g-mgr'], members: ['dave@demo.test'] } },
      series: { s1: { name: 'Monthly', workspace: 'w1' }, s_wc: { name: 'Checked', workspace: 'w1' } },
    });
    releaseBody();
    const uploadRes = await uploadPromise;
    assert.equal(uploadRes.status, 404, 'streamed upload must fail closed when direct membership is removed mid-flight');

    // P1-A: duplicate OID rows rejected explicitly
    const uDup = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    uDup['dup1@demo.test'] = { role: 'user', name: 'Dup1', oid: 't1/oid-dup', groups: [], epoch: 1 };
    uDup['dup2@demo.test'] = { role: 'user', name: 'Dup2', oid: 't1/oid-dup', groups: [], epoch: 1 };
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(uDup));
    const dupJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec, scp: 'access_as_user', preferred_username: 'dup2@demo.test', tid: 't1', oid: 'oid-dup' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${dupJwt}` } })).status, 403);

    // P1-B: removing a user via admin API persists revocation across deletion & re-enrollment
    const bobOldJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec - 10, scp: 'access_as_user', upn: 'bob@demo.test', tid: 't1', oid: 'oid-bob' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${bobOldJwt}` } })).status, 200);
    const rmRes = await fetch(`${base}/users/${encodeURIComponent('bob@demo.test')}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${validApiAud}` },
    });
    assert.equal(rmRes.status, 200);
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${bobOldJwt}` } })).status, 401, 'old JWT must not auto-provision after user removal');

    // P1 #4: local sign-out revokes previously issued JWT
    const uAfter = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    uAfter['admin@demo.test'].epoch = (uAfter['admin@demo.test'].epoch ?? 0) + 1;
    uAfter['admin@demo.test'].revoked_before = (nowSec + 5) * 1000;
    uAfter['admin@demo.test'].revoked_epoch = uAfter['admin@demo.test'].epoch;
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(uAfter));
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${validApiAud}` } })).status, 401);

    // P1-6: rollback sign-out (epoch bumped without revoked_before/revoked_epoch) fences pre-existing JWTs on reactivation
    const uRollback = JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'));
    uRollback['admin@demo.test'].epoch = (uRollback['admin@demo.test'].epoch ?? 0) + 1;
    delete uRollback['admin@demo.test'].revoked_before;
    writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(uRollback));
    const preRollbackJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: nowSec - 60, scp: 'access_as_user', preferred_username: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${preRollbackJwt}` } })).status, 401);
    const postFenceJwt = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: 'k1' },
      { iss: issuer, aud: 'api://rf-test-app', exp: nowSec + 3600, iat: Math.floor(Date.now() / 1000) + 2, scp: 'access_as_user', preferred_username: 'admin@demo.test', tid: 't1', oid: 'oid-admin' },
      privateKey,
    );
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${postFenceJwt}` } })).status, 200);
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    oidcServer.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
