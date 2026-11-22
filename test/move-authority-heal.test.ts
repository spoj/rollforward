import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { idp } from './idp.ts';
import { migrateFixtureMessages, snapshotFiles, writeLegacyFixtureTree } from './owner-fixture.ts';

const owner = 'owner@example.test', other = 'other@example.test', token = 'rft_move-authority-heal', at = '2026-11-20T07:07:00.000Z';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(done => probe.close(() => done()));
  return port;
}

async function boot(root: string, extraEnv: Record<string, string>, verifyOnly = false) {
  const port = await freePort();
  const args = ['src/server.ts', root, String(port), ...(verifyOnly ? ['--verify-only'] : [])];
  const proc = spawn(process.execPath, args, {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...extraEnv, RF_MIN_FREE_GB: '0', RF_WAKE_TICK_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  proc.stderr.on('data', b => { err += b; });
  const base = await new Promise<string>((done, fail) => {
    proc.once('exit', code => fail(new Error(`server exited ${code}: ${err}`)));
    proc.stdout.on('data', b => {
      out += b;
      const m = /^rollforward on (http:\/\/127\.0\.0\.1:\d+),/m.exec(out);
      if (m) done(m[1]);
    });
  });
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await once(proc, 'exit');
    }
  };
  return { base, stop, stderr: () => err };
}

test('startup heals a moved open instance whose authority boundary names the source workspace (including cut pre-move run teardown), skips --verify-only, is idempotent, and admits destination proposals while rejecting old ones', { timeout: 30_000 }, async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-move-heal-')), root = join(tmp, 'data');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const entra = await idp();
  t.after(() => entra.close());
  const rf = (name: string) => join(root, '.rf', name);
  const book = join(root, 'series/s');
  const openDir = join(root, 'instances/open'), retiredDir = join(root, 'instances/retired'), closedDir = join(root, 'instances/closed');
  for (const dir of [rf(''), book, join(openDir, 'working'), join(openDir, 'upload'), join(retiredDir, 'working'), join(retiredDir, 'upload'), join(closedDir, 'working'), join(closedDir, 'upload'), join(root, 'agents')])
    mkdirSync(dir, { recursive: true });
  const put = (p: string, d: unknown) => writeFileSync(p, JSON.stringify(d));
  writeLegacyFixtureTree(root, {
    workspaces: {
      src: { name: 'Source', owners: [owner], members: [] },
      dest: { name: 'Solo', owners: [owner], members: [] },
    },
    series: { s: { name: 'Monitor', workspace: 'dest' } },
  });
  put(join(book, 'series.json'), {
    version: 1, owner, epoch: 2, since: at,
    consent: { by: owner, at, workspace: 'dest', logins: [], autonomous: true },
  });
  put(join(openDir, 'instance.json'), { series: 's', label: 'Open' });
  put(join(openDir, 'screen.json'), { rev: 1, status: 'open', items: [] });
  writeFileSync(join(openDir, 'log.jsonl'), [
    { seq: 1, at, by: owner, op: 'create' },
    { seq: 2, at, by: 'server', op: 'run', run: 1, runner: owner, initiator: owner, authority: { version: 1, owner, epoch: 1, workspace: 'src', logins: [], autonomous: true }, upto: 1 },
    { seq: 3, at, by: 'agent', op: 'comment', thread: 'c3', text: 'Pre-move proposal', ask: 'proposal', run: 1 },
    { seq: 4, at, by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 0 },
    // Reproduces the v0.8.4 move bug: epoch 2 stamped with source workspace right before move.
    { seq: 5, at, by: owner, op: 'authority', owner, epoch: 2, workspace: 'src' },
    { seq: 6, at, by: owner, op: 'move', from: 'Source/Monitor', to: 'Solo/Monitor' },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  // An open instance whose pre-move run finished retiring (done) between stale authority and move is also safe to heal.
  put(join(retiredDir, 'instance.json'), { series: 's', label: 'Retired' });
  put(join(retiredDir, 'screen.json'), { rev: 1, status: 'open', items: [] });
  writeFileSync(join(retiredDir, 'log.jsonl'), [
    { seq: 1, at, by: owner, op: 'create' },
    { seq: 2, at, by: 'server', op: 'run', run: 1, runner: owner, initiator: owner, authority: { version: 1, owner, epoch: 1, workspace: 'src', logins: [], autonomous: true }, upto: 1 },
    { seq: 3, at, by: owner, op: 'authority', owner, epoch: 2, workspace: 'src' },
    { seq: 4, at, by: 'server', op: 'done', run: 1, aborted: true, seen: 1, cost: 0, error: 'its series owner can no longer execute it' },
    { seq: 5, at, by: owner, op: 'move', from: 'Source/Monitor', to: 'Solo/Monitor' },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  put(join(closedDir, 'instance.json'), { series: 's', label: 'Closed' });
  put(join(closedDir, 'screen.json'), { rev: 1, status: 'closed', items: [] });
  writeFileSync(join(closedDir, 'log.jsonl'), [
    { seq: 1, at, by: owner, op: 'create' },
    { seq: 2, at, by: owner, op: 'authority', owner, epoch: 2, workspace: 'src' },
    { seq: 3, at, by: owner, op: 'close' },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  put(rf('users.json'), { [owner]: { role: 'admin', created: at, epoch: 1 } });
  put(rf('tokens.json'), { [createHash('sha256').update(token).digest('hex')]: { id: 'heal', email: owner, name: 'test', created: at, expires: '2099-01-01T00:00:00Z', epoch: 1 } });
  put(rf('connections.json'), {});
  migrateFixtureMessages(root);

  const env = { ...entra.env('http://127.0.0.1:1'), HOME: tmp, RF_SCRATCH: join(tmp, 'scratch'), RF_ADMINS: owner };

  // 1. --verify-only must not mutate disk even when moved open instances need healing.
  const beforeVerify = snapshotFiles(root);
  const v = await boot(root, env, true);
  try {
    const me = await (await fetch(`${v.base}/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(me.verifyOnly, true);
    assert.deepEqual(snapshotFiles(root), beforeVerify, '--verify-only mutates nothing');
  } finally {
    await v.stop();
  }

  // 2. Normal boot appends one corrective destination authority boundary on safe open instances only.
  const s1 = await boot(root, env, false);
  try {
    const req = (method: string, path: string, body?: unknown) => fetch(`${s1.base}${path}`, {
      method, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const openDetail = await (await req('GET', '/api/instances/open')).json();
    const auths = openDetail.log.filter((e: { op: string }) => e.op === 'authority');
    assert.equal(auths.length, 2);
    assert.deepEqual({ by: auths[1].by, owner: auths[1].owner, epoch: auths[1].epoch, workspace: auths[1].workspace },
      { by: 'server', owner, epoch: 2, workspace: 'dest' });
    assert.equal(auths[1].seq, 7);
    const retiredDetail = await (await req('GET', '/api/instances/retired')).json();
    const retiredAuths = retiredDetail.log.filter((e: { op: string }) => e.op === 'authority');
    assert.equal(retiredAuths.length, 2, 'cut pre-move run retirement tail before move is healed');
    assert.equal(retiredAuths[1].workspace, 'dest');
    const closedDetail = await (await req('GET', '/api/instances/closed')).json();
    assert.equal(closedDetail.log.filter((e: { op: string }) => e.op === 'authority').length, 1, 'closed instance untouched');
    // Pre-move proposal c3 remains retired and cannot be approved.
    const oldApprove = await req('POST', '/api/messages', { instance: 'open', id: 'c3', how: 'approve', text: 'Try old', quiet: true });
    assert.equal(oldApprove.status, 409, await oldApprove.clone().text());
    assert.match(await oldApprove.text(), /earlier series authority/);
  } finally {
    await s1.stop();
  }

  // 3. Inject a fresh destination run + proposal at epoch 2, then restart to verify both idempotence and destination approval.
  const eventsPath = join(book, 'events', 'open', 'events.jsonl');
  const messagesPath = join(book, 'messages.jsonl');
  const nextMsgId = Math.max(0, ...readFileSync(messagesPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id)) + 1;
  appendFileSync(eventsPath, [
    { seq: 8, at, by: 'server', op: 'run', run: 2, runner: owner, initiator: owner, authority: { version: 1, owner, epoch: 2, workspace: 'dest', logins: [], autonomous: true }, upto: 7 },
    { seq: 10, at, by: 'server', op: 'done', run: 2, aborted: false, seen: 7, cost: 0 },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  appendFileSync(messagesPath, JSON.stringify({
    id: nextMsgId,
    anchor: { instance: 'open' },
    kind: 'propose',
    entry: { seq: 9, at, by: 'agent', op: 'comment', thread: 'c9', text: 'Destination proposal', ask: 'proposal', run: 2 },
  }) + '\n');

  const s2 = await boot(root, env, false);
  try {
    const req = (method: string, path: string, body?: unknown) => fetch(`${s2.base}${path}`, {
      method, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const openDetail = await (await req('GET', '/api/instances/open')).json();
    const auths = openDetail.log.filter((e: { op: string }) => e.op === 'authority');
    assert.equal(auths.length, 2, 'restart is idempotent and appends no duplicate authority boundary');
    // Old pre-move proposal still rejected; fresh destination proposal at epoch 2 succeeds.
    const stillOld = await req('POST', '/api/messages', { instance: 'open', id: 'c3', how: 'approve', text: 'Still old', quiet: true });
    assert.equal(stillOld.status, 409);
    assert.match(await stillOld.text(), /earlier series authority/);
    const freshApprove = await req('POST', '/api/messages', { instance: 'open', id: 'c9', how: 'approve', text: 'Approved in Solo', quiet: true });
    assert.equal(freshApprove.status, 200, await freshApprove.text());
    const afterApprove = await (await req('GET', '/api/instances/open')).json();
    assert.ok(afterApprove.log.some((e: { op: string; on?: number }) => e.op === 'signoff' && e.on === 9));
  } finally {
    await s2.stop();
  }
});

test('startup skips authority workspace heal and preserves execution state when post-boundary work, wake-check stops, or an owner mismatch exist', { timeout: 30_000 }, async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-move-skip-')), root = join(tmp, 'data');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const entra = await idp();
  t.after(() => entra.close());
  const rf = (name: string) => join(root, '.rf', name);
  const put = (p: string, d: unknown) => writeFileSync(p, JSON.stringify(d));
  for (const dir of [
    rf(''), join(root, 'agents'),
    join(root, 'series/s-comment'), join(root, 'series/s-run'), join(root, 'series/s-check'), join(root, 'series/s-owner'),
    join(root, 'instances/i-comment/working'), join(root, 'instances/i-comment/upload'),
    join(root, 'instances/i-run/working'), join(root, 'instances/i-run/upload'),
    join(root, 'instances/i-check/working'), join(root, 'instances/i-check/upload'),
    join(root, 'instances/i-owner/working'), join(root, 'instances/i-owner/upload'),
  ]) mkdirSync(dir, { recursive: true });
  writeLegacyFixtureTree(root, {
    workspaces: { src: { name: 'Source', owners: [owner, other], members: [] }, dest: { name: 'Dest', owners: [owner, other], members: [] } },
    series: {
      's-comment': { name: 'Comment', workspace: 'dest' },
      's-run': { name: 'Run', workspace: 'dest' },
      's-check': { name: 'Check', workspace: 'dest' },
      's-owner': { name: 'Owner', workspace: 'dest' },
    },
  });
  for (const sid of ['s-comment', 's-run', 's-check', 's-owner']) {
    put(join(root, 'series', sid, 'series.json'), {
      version: 1, owner, epoch: 2, since: at,
      consent: { by: owner, at, workspace: 'dest', logins: [], autonomous: true },
    });
  }
  const writeInst = (id: string, series: string, log: object[]) => {
    const dir = join(root, 'instances', id);
    put(join(dir, 'instance.json'), { series, label: id });
    put(join(dir, 'screen.json'), { rev: 1, status: 'open', items: [] });
    writeFileSync(join(dir, 'log.jsonl'), log.map((e, k) => JSON.stringify({ seq: k + 1, at, ...e }) + '\n').join(''));
  };
  // 1. Unread post-move owner instruction must NOT be downgraded to a note.
  writeInst('i-comment', 's-comment', [
    { by: owner, op: 'create' },
    { by: owner, op: 'authority', owner, epoch: 2, workspace: 'src' },
    { by: owner, op: 'move', from: 'Source/Comment', to: 'Dest/Comment' },
    { by: owner, op: 'comment', thread: 'c4', text: 'Run this after move', authorityOwner: owner, authorityEpoch: 2 },
  ]);
  // 2. Destination run interrupted by restart must NOT lose its recovery wake.
  writeInst('i-run', 's-run', [
    { by: owner, op: 'create' },
    { by: owner, op: 'authority', owner, epoch: 2, workspace: 'src' },
    { by: owner, op: 'move', from: 'Source/Run', to: 'Dest/Run' },
    { by: 'server', op: 'run', run: 1, runner: owner, initiator: owner, authority: { version: 1, owner, epoch: 2, workspace: 'dest', logins: [], autonomous: true }, upto: 3 },
  ]);
  // 3. Server-written wake-check stop after stale boundary must NOT be hidden.
  writeInst('i-check', 's-check', [
    { by: owner, op: 'create' },
    { by: owner, op: 'authority', owner, epoch: 2, workspace: 'src' },
    { by: owner, op: 'move', from: 'Source/Check', to: 'Dest/Check' },
    { by: 'server', op: 'wake-check', message: 'No new invoices' },
  ]);
  // 4. Owner mismatch on stale authority entry must NOT be healed.
  writeInst('i-owner', 's-owner', [
    { by: owner, op: 'create' },
    { by: other, op: 'authority', owner: other, epoch: 2, workspace: 'src' },
    { by: owner, op: 'move', from: 'Source/Owner', to: 'Dest/Owner' },
  ]);
  put(rf('users.json'), { [owner]: { role: 'admin', created: at, epoch: 1 }, [other]: { role: 'user', created: at, epoch: 1 } });
  put(rf('tokens.json'), { [createHash('sha256').update(token).digest('hex')]: { id: 'skip', email: owner, name: 'test', created: at, expires: '2099-01-01T00:00:00Z', epoch: 1 } });
  put(rf('connections.json'), {});
  migrateFixtureMessages(root);

  // RF_MAX_RUNS=0 keeps recover() from executing runs while still running standing/recover bookkeeping cleanly.
  const env = { ...entra.env('http://127.0.0.1:1'), HOME: tmp, RF_SCRATCH: join(tmp, 'scratch'), RF_ADMINS: owner, RF_MAX_RUNS: '0' };
  const s = await boot(root, env, false);
  try {
    const get = (path: string) => fetch(`${s.base}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
    const commentInst = await get('/api/instances/i-comment');
    assert.equal(commentInst.log.filter((e: { op: string }) => e.op === 'authority').length, 1, 'unread owner instruction skipped heal');
    assert.equal(commentInst.standing[4], 'runner', 'post-move owner instruction kept runner standing');
    assert.ok(commentInst.queued, 'post-move owner instruction stayed queued for execution');

    const runInst = await get('/api/instances/i-run');
    assert.equal(runInst.log.filter((e: { op: string }) => e.op === 'authority').length, 1, 'interrupted destination run skipped heal');
    assert.ok(runInst.log.some((e: { op: string; recovery?: { run: number } }) => e.op === 'wake' && e.recovery?.run === 1), 'interrupted destination run kept its recovery wake');

    const checkInst = await get('/api/instances/i-check');
    assert.equal(checkInst.log.filter((e: { op: string }) => e.op === 'authority').length, 1, 'post-boundary wake-check skipped heal');
    assert.equal(checkInst.wakeCheck?.message, 'No new invoices', 'wake-check stop status was not hidden');

    const ownerInst = await get('/api/instances/i-owner');
    assert.equal(ownerInst.log.filter((e: { op: string }) => e.op === 'authority').length, 1, 'owner mismatch skipped heal');

    for (const key of ['s-comment/i-comment', 's-run/i-run', 's-check/i-check', 's-owner/i-owner'])
      assert.match(s.stderr(), new RegExp(`skipped authority workspace heal for ${key}`));
  } finally {
    await s.stop();
  }
});
