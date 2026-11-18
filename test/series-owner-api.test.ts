import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { idp } from './idp.ts';
import { writeFixtureTree } from './owner-fixture.ts';

const admin = 'admin@demo.test', alice = 'alice@demo.test', bob = 'bob@demo.test', colleague = 'colleague@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-owner-api-')), root = join(tmp, 'data');
let proc: ChildProcess, base: string, entra: Awaited<ReturnType<typeof idp>>;
const cookies: Record<string, string> = {};
const request = (method: string, path: string, body?: unknown, who = admin) => fetch(base + path, { method, headers: { cookie: cookies[who] }, ...(body !== undefined && { body: JSON.stringify(body) }) });
async function json(path: string, who = admin) {
  const res = await request('GET', path, undefined, who);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
async function ok(method: string, path: string, body: unknown, who = admin) {
  const res = await request(method, path, body, who);
  assert.equal(res.status, 200, await res.clone().text());
  return res;
}
const settings = (sid: string) => JSON.parse(readFileSync(join(root, 'series', sid, 'series.json'), 'utf8'));
async function series(name: string, who = alice, extra = {}) {
  return (await (await ok('POST', '/api/series', { workspace: 'ws', name, logins: [], autonomous: false, ...extra }, who)).json()).id as string;
}

before(async () => {
  mkdirSync(join(root, '.rf'), { recursive: true });
  writeFixtureTree(root, {
    workspaces: { ws: { name: 'Workspace', owners: [admin], members: [alice, bob, colleague] }, dest: { name: 'Destination', owners: [admin], members: [alice, bob] } },
    series: { history: { name: 'History', workspace: 'ws' }, unowned: { name: 'Unowned', workspace: 'ws' } },
  });
  mkdirSync(join(root, 'series', 'history'), { recursive: true });
  mkdirSync(join(root, 'series', 'unowned'));
  writeFileSync(join(root, 'series', 'unowned', 'series.json'), JSON.stringify({ version: 1, epoch: 0, since: '' }));
  const at = '2026-10-01T00:00:00.000Z';
  writeFileSync(join(root, 'series', 'history', 'series.json'), JSON.stringify({ version: 1, owner: alice, epoch: 1, since: at, consent: { by: alice, at, workspace: 'ws', logins: [], autonomous: false } }));
  const inst = join(root, 'instances', 'historical');
  mkdirSync(join(inst, 'working'), { recursive: true });
  mkdirSync(join(inst, 'upload'));
  writeFileSync(join(inst, 'instance.json'), JSON.stringify({ label: 'Past', series: 'history' }));
  writeFileSync(join(inst, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
  writeFileSync(join(inst, 'log.jsonl'), [
    { by: colleague, op: 'create', logins: [] },
    { by: 'server', op: 'run', run: 1, runner: 'executor@demo.test', initiator: 'initiator@demo.test', upto: 1 },
    { by: 'server', op: 'done', run: 1, seen: 1, cost: 0.25, aborted: false },
    { by: 'agent', op: 'comment', thread: 'c4', text: 'Approve content?', ask: 'proposal', to: colleague, run: 1 },
  ].map((e, i) => JSON.stringify({ seq: i + 1, at, ...e }) + '\n').join(''));
  const caused = join(root, 'instances', 'caused');
  mkdirSync(join(caused, 'working'), { recursive: true });
  mkdirSync(join(caused, 'upload'));
  writeFileSync(join(caused, 'instance.json'), JSON.stringify({ label: 'Cause', series: 'history' }));
  writeFileSync(join(caused, 'screen.json'), JSON.stringify({ rev: 1, status: 'closed', items: [] }));
  writeFileSync(join(caused, 'log.jsonl'), [
    { by: colleague, op: 'create' },
    { by: alice, op: 'comment', text: 'Initiate', authorityOwner: alice, authorityEpoch: 1 },
    { by: 'server', op: 'run', run: 1, runner: alice, initiator: alice, provenance: { cause: 2 }, authority: { version: 1, owner: alice, epoch: 1, workspace: 'ws', logins: [], autonomous: false }, upto: 2 },
    { by: 'server', op: 'done', run: 1, seen: 2, cost: 0.1, aborted: false },
  ].map((e, i) => JSON.stringify({ seq: i + 1, at, ...e }) + '\n').join(''));
  for (const who of [alice, bob]) {
    const dir = join(root, '.rf', 'people', createHash('sha256').update(who).digest('hex').slice(0, 16));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'logins.json'), JSON.stringify([{ id: 'synthetic', kind: 'synthetic', name: 'Synthetic', since: at, offers: [{ id: 'source:x', name: 'X' }, { id: 'source:y', name: 'Y' }, { id: 'web:unapproved', name: 'Unapproved' }] }]));
  }
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  const env = { ...process.env, ...entra.env(base), RF_ADMINS: admin, RF_MAX_RUNS: '0', RF_MIN_FREE_GB: '0', RF_WAKE_TICK_MS: '25', RF_SCRATCH: join(tmp, 'scratch') };
  for (const key of ['OPENROUTER_API_KEY', 'EXA_API_KEY', 'RF_BROWSER_URL', 'RF_TUNNEL_URL']) delete env[key];
  proc = spawn(process.execPath, ['src/server.ts', root, String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  proc.stderr!.on('data', d => { errors += d; });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && resolve());
    proc.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
  });
  for (const who of [admin, alice, bob, colleague]) {
    const res = await entra.signIn(base, who);
    cookies[who] = res.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  }
});

after(async () => {
  if (proc?.exitCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
  entra?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('startup refuses legacy authority before backups, recovery or other data mutation', () => {
  const legacy = join(tmp, 'legacy');
  mkdirSync(join(legacy, '.rf'), { recursive: true });
  const raw = '{"workspaces":{},"series":{}}';
  writeFileSync(join(legacy, '.rf', 'tree.json'), raw);
  const child = spawnSync(process.execPath, ['src/server.ts', legacy, '0'], { env: { ...process.env, ...entra.env(base) }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /legacy data: convert it to series owners first \(docs\/deploy\.md\)/);
  assert.equal(readFileSync(join(legacy, '.rf', 'tree.json'), 'utf8'), raw);
  assert.equal(existsSync(join(legacy, '.rf-backups')), false);
  assert.equal(existsSync(join(legacy, '.rf', 'authority-format.json')), false);
});

test('managers are told about missing and ineligible series owners', async () => {
  const ownership = async (who = admin) => (await json('/api/status', who)).ownership;
  assert.equal((await json('/api')).flatMap(w => w.series).find(s => s.id === 'unowned').ownerUnavailable, true);
  assert.deepEqual((await ownership()).find(s => s.path === 'Workspace/Unowned'), { id: 'unowned', path: 'Workspace/Unowned', text: 'Unowned has no owner' });
  assert.deepEqual(await ownership(colleague), []);
  const sid = await series('Unavailable', bob);
  await ok('PUT', `/users/${bob}`, { disabled: true });
  assert.match((await ownership()).find(s => s.id === sid).text, /can no longer run Unavailable/);
  await ok('PUT', `/users/${bob}`, { disabled: false });
  const signed = await entra.signIn(base, bob);
  cookies[bob] = signed.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  assert.equal((await ownership()).some(s => s.id === sid), false);
  await ok('PUT', '/api/workspaces/ws', { remove: bob, force: true });
  assert.equal((await ownership()).some(s => s.id === sid), true);
  await ok('PUT', '/api/workspaces/ws', { add: bob, as: 'member' });
  await ok('PUT', `/api/series/${sid}`, { archived: true });
  assert.equal((await ownership()).some(s => s.id === sid), false);
});

test('unread collaborator creations, comments and uploads wait until the owner opens or acts', async () => {
  const sid = await series('Inbox');
  const { id } = await (await ok('POST', `/api/series/${sid}`, { label: 'Jan', quiet: true }, colleague)).json();
  const attention = async () => (await json('/api')).flatMap(w => w.series).find(s => s.id === sid).instances.find(i => i.id === id).asks;
  assert.deepEqual((await attention()).map(a => [a.who, a.from, a.started]), [[alice, colleague, true]]);
  assert.deepEqual((await json(`/api/instances/${id}`, colleague)).waiting, [], 'instance waiting remains comment threads, as existing clients expect');
  assert.equal((await attention()).length, 1, 'the creator opening it does not acknowledge for its owner');
  await json(`/api/instances/${id}`, alice);
  assert.deepEqual(await attention(), []);
  await ok('POST', `/api/instances/${id}/comment`, { text: 'Rate changed' }, colleague);
  await ok('POST', `/api/instances/${id}/upload?name=note.txt`, { text: 'New input' }, colleague);
  assert.equal((await attention()).length, 2);
  const detail = await json(`/api/instances/${id}`, colleague);
  assert.ok(detail.waiting.every(w => detail.log[w.seq - 1].op === 'comment'));
  assert.ok((await json('/api/status', alice)).asks.filter(a => a.path === 'Workspace/Inbox/Jan').every(a => a.text === `${colleague} added a note to Inbox · Jan`));
  await ok('POST', `/api/instances/${id}/comment`, { text: 'Thanks', quiet: true }, alice);
  assert.deepEqual(await attention(), []);
  await ok('POST', `/api/instances/${id}/comment`, { text: 'One more thing' }, colleague);
  assert.equal((await attention()).length, 1);
  await json(`/api/instances/${id}`, alice);
  assert.deepEqual(await attention(), []);
  await ok('POST', `/api/instances/${id}/comment`, { text: 'For a scheduled run' }, colleague);
  await ok('PUT', `/api/series/${sid}/credentials`, { logins: [], autonomous: true }, alice);
  assert.equal((await attention()).length, 1, 'series authority events do not acknowledge instance work');
  await ok('PUT', `/api/wakes/${id}`, { at: '2099-01-01' }, alice);
  assert.deepEqual(await attention(), []);
  const historical = (await json('/api')).flatMap(w => w.series).find(s => s.id === 'history').instances.find(i => i.id === 'historical');
  assert.equal(historical.asks.some(a => a.started), false, 'a run has read the historical creation');
  await ok('POST', '/api/instances/historical/react', { on: 4, up: true }, colleague);
  assert.deepEqual((await json('/api/instances/historical', colleague)).waiting, [{ who: colleague, seq: 4 }], 'reacting and opening acknowledge no agent proposal');
});

test('admins author series without a capability grant', async () => {
  assert.equal((await request('POST', '/api/series', { workspace: 'ws', name: 'Admin series' })).status, 200);
});

test('creation establishes sole owner; omitted selection is not empty consent; tasks retain owner on promotion', async () => {
  const sid = await series('Explicit');
  assert.equal(settings(sid).owner, alice);
  assert.deepEqual(settings(sid).consent.logins, []);
  const omitted = await (await ok('POST', '/api/series', { workspace: 'ws', name: 'Omitted' }, alice)).json();
  assert.equal(settings(omitted.id).owner, alice);
  assert.equal(settings(omitted.id).consent, undefined);
  const task = await (await ok('POST', '/api/series', { workspace: 'ws', single: true, logins: [], autonomous: false }, alice)).json();
  assert.equal((await json(`/api/instances/${task.instance}`)).owner.by, alice);
  await ok('PUT', `/api/series/${task.id}/credentials`, { logins: [], autonomous: false }, alice);
  await ok('POST', `/api/series/${task.id}/promote`, { name: 'Promoted' }, colleague);
  assert.equal(settings(task.id).owner, alice);
});

test('legacy creation credentials cannot silently authorize a whole-series ceiling', async () => {
  const res = await request('POST', '/api/series', { workspace: 'ws', name: 'Stale client', logins: [] }, alice);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /series.*autonomous|update.*client/i);
});

test('collaborator and admin instance creation preserves creator and does not initiate owner execution', async () => {
  const sid = await series('Creators');
  for (const who of [colleague, admin]) {
    const { id } = await (await ok('POST', `/api/series/${sid}`, { label: who }, who)).json();
    const detail = await json(`/api/instances/${id}`, who);
    assert.equal(detail.log[0].by, who);
    assert.equal(detail.owner.by, alice);
    assert.equal(detail.runner, undefined);
    assert.equal(detail.starts, false);
    assert.equal(detail.queued, false);
    assert.equal(detail.log.some(e => e.op === 'wake'), false);
  }
  assert.equal((await request('POST', `/api/series/${sid}`, { label: 'Old client', logins: [] }, alice)).status, 410);
});

test('old assignment, credentials and sharing endpoints are explicit 410 failures', async () => {
  for (const action of ['assign', 'takeover', 'logins', 'assignees']) {
    assert.equal((await request(action === 'assignees' ? 'GET' : 'POST', `/api/instances/historical/${action}`, action === 'assignees' ? undefined : {})).status, 410);
  }
  assert.equal((await request('PUT', '/api/series/history', { share: true, logins: [] })).status, 410);
});

test('only owner selects an explicit credential ceiling; additions preserve epoch and reductions invalidate it', async () => {
  const sid = await series('Ceiling');
  const path = `/api/series/${sid}/credentials`, epoch = settings(sid).epoch;
  assert.equal((await request('PUT', path, { logins: ['source:x'], autonomous: false })).status, 403);
  assert.equal((await request('PUT', path, { autonomous: false }, alice)).status, 400);
  assert.equal((await request('PUT', path, { logins: [], autonomous: 'yes' }, alice)).status, 400);
  assert.equal((await request('PUT', path, { logins: ['not-offered'], autonomous: false }, alice)).status, 400);
  await ok('PUT', path, { logins: ['source:x'], autonomous: true }, alice);
  assert.equal(settings(sid).epoch, epoch);
  assert.deepEqual(settings(sid).consent.logins, ['source:x']);
  const saved = settings(sid);
  assert.equal((await request('PUT', path, { logins: ['source:x', 'web:unapproved'], autonomous: true }, alice)).status, 400);
  assert.deepEqual(settings(sid), saved, 'invalid website selection neither succeeds silently nor destroys existing consent');
  await ok('PUT', path, { logins: ['source:x', 'source:y'], autonomous: true }, alice);
  assert.equal(settings(sid).epoch, epoch);
  await ok('PUT', path, { logins: ['source:x'], autonomous: true }, alice);
  assert.equal(settings(sid).epoch, epoch + 1);
  await ok('PUT', path, { logins: [], autonomous: false }, alice);
  assert.equal(settings(sid).epoch, epoch + 2);
  assert.deepEqual(settings(sid).consent.logins, []);
});

test('transfer clears consent, updates all projections and retains immutable execution history', async () => {
  const before = await json('/api/runs'), epoch = settings('history').epoch;
  const closedHistory = readFileSync(join(root, 'instances/caused/log.jsonl'), 'utf8');
  assert.equal(before.find(r => r.path.endsWith('/Past')).runner, 'executor@demo.test');
  assert.equal(before.find(r => r.path.endsWith('/Past')).initiator, 'initiator@demo.test');
  assert.deepEqual(before.find(r => r.path.endsWith('/Cause')).started, { op: 'comment', by: alice });
  const owners = await json('/api/series/history/owners');
  assert.ok(owners.includes(bob));
  assert.equal((await request('PUT', '/api/series/history/owner', { owner: bob }, colleague)).status, 403);
  assert.equal((await request('PUT', '/api/series/history/owner', { owner: 'group-id' })).status, 400);
  await ok('PUT', '/api/series/history/owner', { owner: bob });
  assert.equal(settings('history').owner, bob);
  assert.equal(readFileSync(join(root, 'instances/caused/log.jsonl'), 'utf8'), closedHistory, 'transfer does not append bookkeeping to closed records');
  assert.equal(settings('history').consent, undefined);
  assert.equal(settings('history').epoch, epoch + 1);
  const detail = await json('/api/instances/historical');
  assert.equal(detail.owner.by, bob);
  assert.equal(detail.starts, false);
  assert.equal(detail.log.at(-1).op, 'authority');
  const listed = (await json('/api')).flatMap(w => w.series).find(s => s.id === 'history');
  assert.equal(listed.owner, bob);
  assert.equal(listed.instances[0].owner, bob);
  assert.equal(listed.instances[0].assigned, undefined);
  assert.equal((await json('/api/status')).assigned, undefined);
  assert.deepEqual(await json('/api/runs'), before);
  await ok('PUT', '/api/series/history/credentials', { logins: [], autonomous: false }, bob);
  assert.equal((await json('/api/instances/historical', bob)).starts, true);
  await ok('PUT', '/api/series/history/owner', { owner: alice }, bob);
  assert.equal(settings('history').epoch, epoch + 2);
  assert.equal(settings('history').consent, undefined);
});

test('a named collaborator signoff queues a run under current owner consent', async () => {
  await ok('PUT', '/api/series/history/credentials', { logins: [], autonomous: false }, alice);
  await ok('POST', '/api/instances/historical/signoff', { thread: 'c4' }, colleague);
  await ok('POST', '/api/instances/historical/comment', { thread: 'c4', text: 'A named collaborator reply' }, colleague);
  await ok('POST', '/api/instances/historical/upload?name=note.txt', { text: 'Collaborator input' }, colleague);
  const detail = await json('/api/instances/historical');
  assert.equal(detail.log.find(e => e.op === 'signoff').by, colleague);
  assert.ok(detail.log.some(e => e.op === 'upload' && e.by === colleague));
  assert.equal(detail.standing[detail.log.find(e => e.op === 'signoff').seq], 'answer');
  assert.equal(detail.standing[detail.log.find(e => e.op === 'upload').seq], 'note');
  assert.equal(detail.queued, true);
  assert.equal(detail.log.filter(e => e.op === 'run').length, 1);
  assert.equal((await request('POST', '/api/instances/historical/close', {})).status, 403);
});

test('a collaborator cannot delete the owner\'s authorized schedule', async () => {
  const sid = await series('Protected schedule', alice, { autonomous: true });
  const wake = await (await ok('PUT', `/api/wakes/${sid}`, { at: '2099-01-01', label: 'Next' }, alice)).json();
  assert.equal((await request('DELETE', `/api/wakes/${wake.id}`, undefined, colleague)).status, 403);
  await ok('DELETE', `/api/wakes/${wake.id}`, undefined, alice);
});

test('requests route to current owner and only that owner can Start either target kind', async () => {
  const sid = await series('Requests');
  const { id: existing } = await (await ok('POST', `/api/series/${sid}`, { label: 'Existing', quiet: true }, alice)).json();
  for (const target of [sid, existing]) {
    await ok('PUT', `/api/wakes/${target}`, { at: 'now', ...(target === sid && { label: 'Requested' }), text: 'Collaborator request' }, colleague);
    let pending;
    for (let n = 0; n < 100; n++) {
      pending = (await json('/api')).flatMap(w => w.series).find(s => s.id === sid).requests.find(r => target === sid ? !r.target : r.target === existing);
      if (pending) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pending, 'wake became a non-executing request');
    assert.equal(pending.who, alice);
    for (const who of [admin, colleague]) assert.equal((await request('POST', `/api/requests/${pending.id}`, {}, who)).status, 403);
    assert.equal((await request('POST', `/api/requests/${pending.id}`, { logins: [] }, alice)).status, 410);
    const accepted = await (await ok('POST', `/api/requests/${pending.id}`, {}, alice)).json();
    const detail = await json(`/api/instances/${accepted.id}`);
    assert.equal(detail.owner.by, alice);
    assert.equal(detail.log.filter(e => e.op === 'run').length, 0);
    assert.equal(detail.queued, true);
  }
});

test('unresolved migrated series stay readable without inferring creator, newest runner or admin', async () => {
  const listed = (await json('/api')).flatMap(w => w.series).find(s => s.id === 'unowned');
  assert.equal(listed.owner, null);
  await ok('PUT', '/api/series/unowned/owner', { owner: alice });
  assert.equal(settings('unowned').owner, alice);
  assert.equal(settings('unowned').consent, undefined);
});

test('a workspace manager transfers ownership without lending execution consent', async () => {
  const sid = await series('Manager assignment');
  await ok('PUT', `/api/series/${sid}/owner`, { owner: bob });
  assert.equal(settings(sid).owner, bob);
  assert.equal(settings(sid).consent, undefined);
  assert.equal((await request('PUT', `/api/series/${sid}/credentials`, { logins: [], autonomous: false })).status, 403);
  assert.equal((await request('POST', '/api/series', { workspace: 'ws', name: 'Authoring' })).status, 200);
});

test('an enabled workspace member can receive ownership before their first sign-in', async () => {
  const incoming = 'incoming@demo.test', sid = await series('Incoming');
  await ok('PUT', '/users', { roles: { [incoming]: 'user' } });
  await ok('PUT', '/api/workspaces/ws', { add: incoming });
  assert.ok((await json(`/api/series/${sid}/owners`)).includes(incoming));
  await ok('PUT', `/api/series/${sid}/owner`, { owner: incoming });
  assert.equal(settings(sid).owner, incoming);
  assert.equal(settings(sid).consent, undefined);
});

test('membership safeguard includes empty owned series; force withdraws consent without replacement', async () => {
  const sid = await series('Empty ownership', bob);
  assert.equal((await request('PUT', '/api/workspaces/ws', { remove: bob })).status, 409);
  await ok('PUT', '/api/workspaces/ws', { remove: bob, force: true });
  assert.equal(settings(sid).owner, bob);
  assert.equal(settings(sid).consent, undefined);
  assert.equal(settings(sid).epoch, 2);
  await ok('PUT', '/api/workspaces/ws', { add: bob });
  assert.equal(settings(sid).consent, undefined);
});

test('move preserves owner and clears workspace-bound authority', async () => {
  const sid = await series('Moving');
  const inst = await (await ok('POST', `/api/series/${sid}`, { label: 'Period', quiet: true })).json();
  await json(`/api/instances/${inst.id}`);
  await ok('PUT', '/api/proposals/ws', { kind: 'move', series: sid, to: 'dest' });
  await ok('POST', '/api/proposals/ws', { owners: [], members: [] });
  assert.equal(settings(sid).owner, alice);
  assert.equal(settings(sid).consent, undefined);
  assert.equal(settings(sid).epoch, 2);
  await ok('PUT', `/api/series/${sid}/credentials`, { logins: [], autonomous: false }, alice);
  assert.equal(settings(sid).consent.workspace, 'dest');
  const row = (await json('/api')).flatMap(w => w.series).flatMap(s => s.instances).find(i => i.id === inst.id);
  assert.equal(row.unread, false, 'the accepting manager does not receive unread news of their own authority withdrawal');
});

test('deletion retains the captured executor and initiator, not the current owner or original creator', async () => {
  await ok('POST', '/api/instances/historical/delete', {});
  const row = (await json('/api/runs')).find(r => r.path.endsWith('/Past'));
  assert.equal(row.runner, 'executor@demo.test');
  assert.equal(row.initiator, 'initiator@demo.test');
  assert.equal(row.cost, 0.25);
});

test('signout explicitly withdraws owner authority before later sign-in', async () => {
  const sid = await series('Signout', bob), epoch = settings(sid).epoch;
  await ok('PUT', `/users/${bob}`, { signout: true });
  assert.equal(settings(sid).owner, bob);
  assert.equal(settings(sid).epoch, epoch + 1);
  assert.equal(settings(sid).consent, undefined);
  const res = await entra.signIn(base, bob);
  cookies[bob] = res.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  assert.equal(settings(sid).consent, undefined);
});

test('disable revokes even empty owned series and enabling never restores old consent', async () => {
  const sid = await series('Disable', bob);
  await ok('PUT', `/users/${bob}`, { disabled: true });
  assert.equal(settings(sid).consent, undefined);
  const epoch = settings(sid).epoch;
  await ok('PUT', `/users/${bob}`, { disabled: false });
  const res = await entra.signIn(base, bob);
  cookies[bob] = res.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  assert.equal(settings(sid).consent, undefined);
  assert.equal(settings(sid).epoch, epoch);
  await ok('PUT', `/api/series/${sid}/credentials`, { logins: [], autonomous: false }, bob);
});

test('run-read notes disappear, quiet answers wait, and agent asks and notes keep their reply lifecycle', () => {
  const source = readFileSync('src/server.ts', 'utf8'), messages = readFileSync('src/messages.ts', 'utf8');
  const log = [
    { seq: 1, op: 'create', by: colleague },
    { seq: 2, op: 'comment', by: colleague },
    { seq: 3, op: 'upload', by: colleague },
    { seq: 4, op: 'comment', by: 'agent', ask: 'question' },
    { seq: 5, op: 'comment', by: 'agent', note: true },
    { seq: 6, op: 'done', by: 'server', seen: 3 },
    { seq: 7, op: 'comment', by: colleague },
  ];
  const inst = { id: 'i', seriesId: 's', doc: { status: 'open' }, copied: 0, log };
  const code = messages.slice(messages.indexOf('function waitsOn('), messages.indexOf('\n// notes/:'))
    + '\n' + source.slice(source.indexOf('function waits('), source.indexOf('\nfunction asked('));
  const waits = runInNewContext(stripTypeScriptTypes(code) + '\nwaits', {
    ownerOf: () => ({ by: alice }), seen: () => ({ at: {} }), active: new Map(),
    isPerson: e => e.by.includes('@'), answered: () => false,
  });
  assert.deepEqual(Array.from(waits(inst), x => x.e.seq), [4, 5, 7]);
  log.push({ seq: 8, op: 'authority', by: alice });
  assert.deepEqual(Array.from(waits(inst), x => x.e.seq), [4, 5, 7]);
  log.push({ seq: 9, op: 'wake', by: 'server' });
  assert.deepEqual(Array.from(waits(inst), x => x.e.seq), [4, 5, 7]);
  log.push({ seq: 10, op: 'react', by: alice });
  assert.deepEqual(Array.from(waits(inst), x => x.e.seq), [4, 5]);
});

test('authority mutation persists epoch and revokes tokens synchronously before waiting for physical retirement', async () => {
  const source = readFileSync('src/server.ts', 'utf8'), start = source.indexOf('function changeAuthority('), end = source.indexOf('\nfunction withdrawOwner(', start);
  const events: string[] = [], settings = { version: 1, owner: bob, epoch: 9, since: 'now' };
  let finish!: () => void, token = true;
  const retired = new Promise<void>(resolve => { finish = resolve; });
  const change = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + '\nchangeAuthority', {
    saveSeriesSettings: (_dir, s) => { assert.equal(s.epoch, 9); events.push('saved'); },
    seriesDir: sid => sid,
    retireSeries: () => { token = false; events.push('revoked'); return retired; },
  });
  let done = false;
  const result = change('target', settings, admin, 'transfer').then(() => { done = true; });
  assert.equal(token, false);
  assert.deepEqual(events, ['saved', 'revoked']);
  await Promise.resolve();
  assert.equal(done, false);
  finish();
  await result;
  assert.equal(done, true);
});
