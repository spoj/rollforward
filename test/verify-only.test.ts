import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateFixtureMessages, snapshotFiles, writeLegacyFixtureTree } from './owner-fixture.ts';

const email = 'owner@example.test', token = 'rft_verify-only-fixture', at = '2026-01-01T00:00:00.000Z';
const consent = { by: email, at, workspace: 'w', logins: [], autonomous: true };
const lease = { version: 1, owner: email, epoch: 1, workspace: 'w', logins: [], autonomous: true };

test('verification boots on loopback without recovering work, firing due wakes, or using live integrations', { timeout: 10000 }, async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-verify-')), root = join(tmp, 'data');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const rf = (name: string) => join(root, '.rf', name), book = join(root, 'series/s'), period = join(root, 'instances/i');
  for (const dir of [rf(''), book, period, join(root, 'agents')]) mkdirSync(dir, { recursive: true });
  const put = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
  writeLegacyFixtureTree(root, { workspaces: { w: { name: 'Work', owners: [email], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
  put(join(book, 'series.json'), { version: 1, owner: email, epoch: 1, since: at, consent });
  put(join(period, 'instance.json'), { series: 's', label: 'Open' });
  put(join(period, 'screen.json'), { rev: 1, status: 'open', items: [] });
  writeFileSync(join(period, 'log.jsonl'), [
    { seq: 1, at, by: email, op: 'create' },
    { seq: 2, at, by: 'server', op: 'run', run: 1, authority: lease, initiator: email, runner: email },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  put(rf('users.json'), { [email]: { role: 'admin', created: at, epoch: 1 } });
  put(rf('tokens.json'), { [createHash('sha256').update(token).digest('hex')]: { id: 'verify', email, name: 'local test', created: at, expires: '2099-01-01T00:00:00Z', epoch: 1 } });
  put(rf('wakes.json'), { pending: { due: { at, target: 'i', from: email, authority: lease, initiator: email } }, fired: {}, requests: {} });
  put(rf('connections.json'), {});
  migrateFixtureMessages(root);
  const before = snapshotFiles(root);

  let calls = 0;
  const trap = createServer((_q, r) => { calls++; r.writeHead(418).end(); });
  await new Promise<void>(done => trap.listen(0, '127.0.0.1', done));
  t.after(() => trap.close());
  const caught = `http://127.0.0.1:${(trap.address() as { port: number }).port}`;
  const upstream = `import { upstreams } from ${JSON.stringify(new URL('../src/connections.ts', import.meta.url).href)}; upstreams['openrouter.ai'] = ${JSON.stringify(caught)};`;
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(done => probe.close(() => done()));
  const app = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(upstream), 'src/server.ts', root, String(port), '--verify-only'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: tmp, RF_SCRATCH: join(tmp, 'scratch'), RF_HOST: '0.0.0.0', RF_OIDC_ISSUER: caught,
      RF_OIDC_CLIENT_ID: 'local', RF_PUBLIC_URL: 'http://127.0.0.1', RF_OIDC_REDIRECT_URI: 'http://127.0.0.1/auth/callback', RF_WAKE_TICK_MS: '10',
      RF_BROWSER_URL: caught, RF_TUNNEL_URL: caught, RF_KEY_TTL_MS: '10', RF_MIN_FREE_GB: '0', OPENROUTER_API_KEY: 'stand-in' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (app.exitCode === null) { app.kill('SIGTERM'); await once(app, 'exit'); } });
  let info = '', errors = '';
  app.stderr.on('data', b => { errors += b; });
  const base = await new Promise<string>((done, fail) => {
    app.once('exit', n => fail(new Error(`verification exited ${n}: ${errors}`)));
    app.stdout.on('data', b => {
      info += b;
      const url = /^rollforward on (http:\/\/127\.0\.0\.1:\d+), .*\(verification only\)/m.exec(info)?.[1];
      if (url) done(url);
    });
  });
  const get = (path: string, method = 'GET', authenticated = true) => fetch(base + path, { method, headers: authenticated ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await get('/me', 'GET', false)).status, 401);
  const me = await (await get('/me')).json();
  assert.equal(me.email, email);
  assert.equal(me.verifyOnly, true);
  const status = await (await get('/api/status')).json();
  assert.deepEqual(status.running, []);
  assert.equal((await get('/api')).status, 200);
  assert.equal((await get('/api/instances/i')).status, 200);
  assert.equal((await get('/files/i/log.jsonl')).status, 200);
  assert.equal((await get('/api/messages', 'POST')).status, 503);
  assert.equal((await get('/api/wakes/i', 'PUT')).status, 503);
  assert.equal((await get('/auth/login')).status, 503);
  assert.equal((await get('/auth/callback?state=x&code=y')).status, 503);
  assert.equal((await get('/logins/web/site', 'POST')).status, 503);
  assert.deepEqual(snapshotFiles(root), before, 'no recovery, settings, bearer audit or read markers changed');
  assert.equal(calls, 0, 'nothing contacted the model, IdP, browsers or tunnel service');
});
