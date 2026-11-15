import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { createInstance, openStore, seriesDir } from '../src/store.ts';
import { authority, lender, ownerOf, runnerAt, saveLogin, unoffer, use } from '../src/logins.ts';
import { saveSeriesSettings, seriesSettings, type Authority } from '../src/series.ts';
import { fire, held, pending, retireSeries, setWake, standing, wakes } from '../src/waker.ts';

const alice = 'alice@example.test', bob = 'bob@example.test', admin = 'admin@example.test';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-core-'));
  t.after(async () => {
    await retireSeries('s');
    await retireSeries('empty');
    rmSync(root, { recursive: true, force: true });
  });
  initSystem(root);
  openStore(root);
  writeJson('users.json', { [alice]: { role: 'user' }, [bob]: { role: 'user' }, [admin]: { role: 'admin' } });
  writeJson('capabilities.json', { 'series-owner': [alice, bob] });
  saveTree({ workspaces: { w: { name: 'W', owners: [admin], members: [alice, bob] } }, series: { s: { name: 'S', workspace: 'w' }, empty: { name: 'Empty', workspace: 'w' } } });
  for (const sid of ['s', 'empty']) saveSeriesSettings(seriesDir(sid), { version: 1, owner: alice, epoch: 1, since: '' });
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft', since: 'now', offers: [{ id: 'm365:x', name: 'X' }, { id: 'm365:y', name: 'Y' }] });
  return createInstance('s', 'First', bob);
}

function consent(logins: string[] = [], autonomous = false, sid = 's') {
  const s = seriesSettings(seriesDir(sid));
  saveSeriesSettings(seriesDir(sid), { ...s, consent: { by: s.owner!, at: 'now', workspace: 'w', logins, autonomous } });
}

test('one canonical series owner: creator is an actor, absent consent differs from []', t => {
  const inst = fixture(t);
  assert.equal(inst.log[0].by, bob);
  assert.equal(ownerOf(inst).by, alice);
  assert.throws(() => authority(inst), /explicitly select/);
  consent();
  assert.deepEqual(authority(inst).logins, []);
  inst.append(bob, 'assign', { to: bob, logins: ['m365:y'] });
  inst.append(bob, 'logins', { logins: ['m365:y'] });
  assert.equal(ownerOf(inst).by, alice);
  assert.deepEqual(ownerOf(inst).logins, []);
});

test('consent never retroactively authorizes an earlier nonexecuting owner act', t => {
  const inst = fixture(t);
  const early = inst.append(alice, 'comment', { text: 'Before consent' });
  assert.equal(standing(inst, early)?.starts, false);
  consent(['m365:x']);
  assert.equal(standing(inst, early)?.starts, false);
  assert.equal(pending(inst, 0).length, 0);
  const fresh = inst.append(alice, 'comment', { text: 'After explicit consent' });
  assert.equal(standing(inst, fresh)?.starts, true);
});

test('collaborators, admins, named answers and signoffs never initiate or queue owner execution', t => {
  const inst = fixture(t);
  consent();
  const ask = inst.append('agent', 'comment', { ask: 'proposal', to: bob, thread: 'c2', text: 'Approve?' });
  for (const by of [bob, admin]) for (const op of ['comment', 'upload', 'signoff', 'reject']) {
    const e = inst.append(by, op, { thread: 'c2', on: ask.seq, text: 'Do it' });
    assert.equal(standing(inst, e)?.starts, false, `${by} ${op}`);
  }
  assert.equal(pending(inst, 0).length, 0);
  const e = inst.append(alice, 'comment', { text: 'Continue' });
  assert.equal(standing(inst, e)?.starts, true);
});

test('read history stays history while unread old-authority acts become notes', t => {
  const inst = fixture(t);
  consent();
  const read = inst.append(alice, 'comment', { text: 'Already read' });
  inst.append('server', 'done', { run: 1, seen: read.seq, cost: 0 });
  const unread = inst.append(alice, 'comment', { text: 'Not yet read' });
  saveSeriesSettings(inst.series(), { version: 1, owner: bob, epoch: 2, since: 'later' });
  consent();
  assert.equal(standing(inst, read), undefined);
  assert.deepEqual(standing(inst, unread), { word: 'note', starts: false });
});

test('run snapshots narrow additions, withdrawal/regrant and owner ABA cannot revive leases', t => {
  const inst = fixture(t);
  consent(['m365:x']);
  const lease = authority(inst);
  const run = inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: lease });
  consent(['m365:x', 'm365:y']);
  assert.deepEqual(lender(inst, 1).logins, ['m365:x']);
  assert.throws(() => use(inst, 1, 'm365:y'), /outside this run/);
  unoffer(alice, 'm365', 'm365:x');
  const withdrawn = seriesSettings(inst.series());
  assert.equal(withdrawn.epoch, 2);
  assert.equal(withdrawn.consent, undefined);
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft', since: 'later', offers: [{ id: 'm365:x', name: 'X' }] });
  consent(['m365:x']);
  assert.throws(() => lender(inst, 1), /authority has ended/);
  for (const [owner, epoch] of [[bob, 3], [alice, 4]] as const) {
    saveSeriesSettings(inst.series(), { version: 1, owner, epoch, since: 'later' });
    consent(['m365:x'].filter(() => owner === alice));
  }
  assert.throws(() => lender(inst, 1), /authority has ended/);
  assert.equal(run.runner, alice);
  assert.equal(run.initiator, alice);
  assert.deepEqual(run.authority, lease);
  assert.equal(runnerAt(inst.log, run.seq), bob, 'legacy historical decoder is not current authority');
});

test('a collaborator schedule request cannot overwrite an owner-authorized schedule', t => {
  fixture(t);
  consent([], true, 'empty');
  const owner = setWake('empty', { at: '2099-01-01', from: alice, label: 'Next' });
  const request = setWake('empty', { at: '2099-02-01', from: bob, label: 'Next' });
  assert.notEqual(request.id, owner.id);
  assert.deepEqual({ ...wakes().pending[owner.id].authority }, owner.authority);
  assert.equal(wakes().pending[owner.id].at, owner.at);
});

test('a revoked weekly schedule cannot swallow the incoming owner\'s new one-off consent', t => {
  fixture(t);
  consent([], true, 'empty');
  const old = setWake('empty', { at: '2099-01-01', from: alice, label: 'Next', days: ['mon'] });
  saveSeriesSettings(seriesDir('empty'), { version: 1, owner: bob, epoch: 2, since: 'later' });
  consent([], true, 'empty');
  const next = setWake('empty', { at: '2099-01-02', from: bob, label: 'Next' });
  assert.notEqual(next.id, old.id);
  assert.equal(next.authority?.owner, bob);
  assert.equal(next.authority?.epoch, 2);
  assert.equal(next.days, undefined);
});

test('schedules snapshot credentials for both existing and new periods; stale epochs become requests', t => {
  const inst = fixture(t);
  consent(['m365:x'], true);
  consent(['m365:x'], true, 'empty');
  const existing = setWake(inst.id, { at: '2000-01-01', from: alice });
  const next = setWake('empty', { at: '2000-01-01', from: alice, label: 'Next' });
  assert.deepEqual(next.authority?.logins, ['m365:x']);
  consent(['m365:x', 'm365:y'], true);
  consent(['m365:x', 'm365:y'], true, 'empty');
  fire();
  const entry = inst.log.findLast(e => e.op === 'wake')!;
  assert.deepEqual((entry.authority as Authority).logins, ['m365:x']);
  assert.equal(entry.initiator, alice);
  assert.equal(entry.schedule, existing.id);
  const later = setWake(inst.id, { at: '2000-01-01', from: alice });
  const s = seriesSettings(inst.series());
  saveSeriesSettings(inst.series(), { ...s, epoch: 2, consent: undefined });
  const w = wakes();
  delete w.fired[inst.id];
  w.pending[later.id].at = '2000-01-01';
  writeJson('wakes.json', w);
  fire();
  assert.equal(wakes().pending[later.id], undefined);
  assert.equal(wakes().requests[later.id].target, inst.id);
});

test('confirm ABA cannot authorize a delayed start, and retirement blocks replacement writers', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, writeJson } from './src/system.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { saveSeriesSettings } from './src/series.ts';
    import { saveLogin } from './src/logins.ts';
    const root = mkdtempSync(join(tmpdir(), 'rf-owner-retire-')), alice = 'alice@example.test', bob = 'bob@example.test';
    initSystem(root); openStore(root);
    writeJson('users.json', { [alice]: { role: 'user' }, [bob]: { role: 'user' } });
    writeJson('capabilities.json', { 'series-owner': [alice, bob] });
    saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [bob] } }, series: { s: { name: 'S', workspace: 'w' } } });
    const inst = createInstance('s', 'First', alice);
    const set = (owner, epoch) => saveSeriesSettings(inst.series(), { version: 1, owner, epoch, since: '', consent: { by: owner, at: '', workspace: 'w', logins: [], autonomous: true } });
    saveLogin(alice, { id: 'm365', kind: 'm365', name: 'M365', since: '', offers: [{ id: 'm365:x', name: 'X' }] });
    set(alice, 1);
    const confirming = Promise.withResolvers(), confirmed = Promise.withResolvers(), stopping = Promise.withResolvers(), stopped = Promise.withResolvers();
    let starts = 0, stops = 0, firstConfirm = true;
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => { if (firstConfirm) { firstConfirm = false; confirming.resolve(); await confirmed.promise; } } } });
    mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async () => { starts++; return { turn: async () => ({ settled: new Promise(() => {}) }), steer: async () => {}, stop: async () => { stops++; if (stops === 1) { stopping.resolve(); await stopped.promise; } } }; } } });
    const { active, byToken, kick, retireSeries, setWake } = await import('./src/waker.ts');
    inst.append(alice, 'comment', { text: 'Old act' }); kick(inst);
    await confirming.promise;
    set(bob, 2); set(alice, 3); confirmed.resolve();
    await new Promise(ok => setTimeout(ok, 50));
    assert.equal(starts, 0, 'email ABA does not bless old confirmation or old initiating act');
    inst.append(alice, 'comment', { text: 'New act' }); kick(inst);
    await new Promise(ok => setTimeout(ok, 1700));
    assert.equal(starts, 1);
    const old = active.get('s'), record = inst.log.find(e => e.op === 'run');
    saveSeriesSettings(inst.series(), { version: 1, owner: alice, epoch: 3, since: '', consent: { by: alice, at: '', workspace: 'w', logins: ['m365:x'], autonomous: true } });
    const continuation = setWake(inst.id, { at: '2099-01-01', from: 'W/S/First', inst: inst.id });
    assert.deepEqual(continuation.authority.logins, [], 'a narrow run cannot self-broaden by minting a fresh same-series schedule');
    let browsersCut = 0;
    old.browsers = { cut: () => { browsersCut++; }, end: async () => {} };
    set(bob, 4);
    assert.equal(byToken.has(old.token), false, 'token revoked synchronously before retirement');
    assert.ok(browsersCut > 0, 'live CDP sockets are cut before any provider drain or process retirement wait');
    const retiring = retireSeries('s');
    await stopping.promise;
    inst.append(bob, 'comment', { text: 'B starts' }); kick(inst);
    await new Promise(ok => setTimeout(ok, 1700));
    assert.equal(starts, 1, 'B cannot write while A sandbox has not exited');
    stopped.resolve(); await retiring;
    await new Promise(ok => setTimeout(ok, 100));
    assert.equal(starts, 2);
    assert.equal(record.runner, alice); assert.equal(record.initiator, alice); assert.equal(record.authority.epoch, 3);
    const current = inst.log.findLast(e => e.op === 'run');
    assert.equal(current.runner, bob); assert.equal(current.initiator, bob);
    await retireSeries('s'); rmSync(root, { recursive: true, force: true });
  `], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, RF_MIN_FREE_GB: '0' }, timeout: 12_000, stdio: 'pipe' });
});

test('recovery needs autonomy captured by the original run, not a later consent expansion', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import * as runner from './src/runner.ts';
    import * as entra from './src/entra.ts';
    import { initSystem, saveTree, writeJson } from './src/system.ts';
    import { createInstance, openStore } from './src/store.ts';
    import { authority } from './src/logins.ts';
    import { saveSeriesSettings } from './src/series.ts';
    const root = mkdtempSync(join(tmpdir(), 'rf-owner-recovery-')), alice = 'alice@example.test';
    initSystem(root); openStore(root);
    writeJson('users.json', { [alice]: { role: 'user' } });
    writeJson('capabilities.json', { 'series-owner': [alice] });
    saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
    const inst = createInstance('s', 'First', alice);
    const set = autonomous => saveSeriesSettings(inst.series(), { version: 1, owner: alice, epoch: 1, since: '', consent: { by: alice, at: '', workspace: 'w', logins: [], autonomous } });
    set(false);
    let starts = 0;
    mock.module('./src/entra.ts', { namedExports: { ...entra, confirm: async () => {} } });
    mock.module('./src/runner.ts', { namedExports: { ...runner, startRun: async () => { starts++; return { turn: async () => ({ settled: new Promise(() => {}) }), steer: async () => {}, stop: async () => {} }; } } });
    const { recover, retireSeries, kick } = await import('./src/waker.ts');
    inst.append(alice, 'comment', { text: 'Manual run' });
    inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: authority(inst), upto: 2 });
    set(true);
    recover(); await new Promise(ok => setTimeout(ok, 1700));
    assert.equal(starts, 0, 'later autonomous consent cannot revive a manually authorized old run');
    inst.append(alice, 'comment', { text: 'Fresh owner act' }); kick(inst);
    await new Promise(ok => setTimeout(ok, 1700)); assert.equal(starts, 1);
    await retireSeries('s'); rmSync(root, { recursive: true, force: true });
  `], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, RF_MIN_FREE_GB: '0' }, timeout: 8_000, stdio: 'pipe' });
});

test('manual-only reauthentication clears the expiry notice without authorizing execution', t => {
  const inst = fixture(t);
  consent(['m365:x']);
  inst.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: authority(inst) });
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft', since: 'expired', offers: [{ id: 'm365:x', name: 'X' }], expired: true });
  inst.append('server', 'expired', { run: 1, runner: alice, login: 'm365' });
  assert.equal(held(inst, 'm365', alice), true);
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft', since: 'renewed', offers: [{ id: 'm365:x', name: 'X' }], expired: false });
  assert.equal(held(inst, 'm365', alice), false);
  const renewed = inst.log.findLast(e => e.op === 'wake')!;
  assert.equal(renewed.quiet, true);
  assert.equal(standing(inst, renewed)?.starts, false);
});

test('membership and capability withdrawal clear consent even for an empty owned series', t => {
  fixture(t);
  consent([], true, 'empty');
  const t0 = tree();
  t0.workspaces.w.members = [bob];
  saveTree(t0);
  assert.equal(seriesSettings(seriesDir('empty')).consent, undefined);
  assert.equal(seriesSettings(seriesDir('empty')).owner, alice);
  assert.equal(seriesSettings(seriesDir('empty')).epoch, 2);
});
