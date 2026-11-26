import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { changes, initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { createInstance, openStore, seriesDir } from '../src/store.ts';
import { authority, lender, ownerOf, runnerAt, saveLogin, signOut, unoffer, use } from '../src/logins.ts';
import { saveSeriesSettings, seriesSettings, type Authority } from '../src/series.ts';
import { fire, held, migrateWakes, pending, recover, retireSeries, setWake, standing, wakes } from '../src/waker.ts';

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

test('collaborators and admins start nothing except when answering a named ask', t => {
  const inst = fixture(t);
  consent();
  const ask = inst.append('agent', 'comment', { ask: 'proposal', to: bob, thread: 'c2', text: 'Approve?' });
  for (const by of [bob, admin]) for (const op of ['comment', 'upload', 'signoff', 'reject']) {
    const e = inst.append(by, op, { thread: 'c2', on: ask.seq, text: 'Do it' });
    assert.equal(standing(inst, e)?.starts, by === bob && op === 'signoff', `${by} ${op}`);
  }
  assert.equal(pending(inst, 0).length, 1);
  const e = inst.append(alice, 'comment', { text: 'Continue' });
  assert.equal(standing(inst, e)?.starts, true);
});

test('named answers need current consent and non-quiet acts', t => {
  const inst = fixture(t);
  const ask = inst.append('agent', 'comment', { ask: 'question', to: bob, thread: 'c2', text: 'Which rate?' });
  const answer = inst.append(bob, 'comment', { thread: 'c2', parent: ask.seq, text: '5%' });
  assert.deepEqual(standing(inst, answer), { word: 'note', starts: false });
  consent();
  assert.deepEqual(standing(inst, answer), { word: 'note', starts: false });
  const next = inst.append('agent', 'comment', { ask: 'question', to: bob, thread: 'c4', text: 'Which bank?' });
  const quiet = inst.append(bob, 'comment', { thread: 'c4', parent: next.seq, text: 'HSBC', quiet: true });
  assert.deepEqual(standing(inst, quiet), { word: 'answer', starts: false });
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
  assert.deepEqual(withdrawn.consent?.logins, ['m365:y']);
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

for (const remove of ['unoffer', 'signout'] as const) test(`${remove} narrows every affected series and keeps the remaining consent`, t => {
  const inst = fixture(t);
  saveLogin(alice, { id: 'other', kind: 'synthetic', name: 'Other', since: '', offers: [{ id: 'other:z', name: 'Z' }] });
  for (const sid of ['s', 'empty']) consent(['m365:x', 'other:z'], true, sid);
  const old = authority(inst);
  if (remove === 'unoffer') unoffer(alice, 'm365', 'm365:x');
  else signOut(alice, 'm365');
  for (const sid of ['s', 'empty']) {
    const s = seriesSettings(seriesDir(sid));
    assert.equal(s.epoch, 2);
    assert.deepEqual(s.consent, { by: alice, at: 'now', workspace: 'w', logins: ['other:z'], autonomous: true });
  }
  inst.append('server', 'run', { run: 1, runner: alice, authority: old });
  assert.throws(() => lender(inst, 1), /authority has ended/);
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft', since: 'again', offers: [{ id: 'm365:x', name: 'X' }] });
  assert.deepEqual(authority(inst).logins, ['other:z']);
  unoffer(alice, 'other', 'other:z');
  assert.deepEqual(authority(inst).logins, []);
  assert.equal(seriesSettings(inst.series()).epoch, 3);
});

test('a collaborator schedule request cannot overwrite an owner-side schedule', t => {
  fixture(t);
  consent([], true, 'empty');
  const owner = setWake('empty', { at: '2099-01-01', from: alice, label: 'Next' });
  const request = setWake('empty', { at: '2099-02-01', from: bob, label: 'Next' });
  assert.notEqual(request.id, owner.id);
  assert.equal(wakes().pending[owner.id].request, false);
  assert.equal(wakes().pending[request.id].request, true);
  assert.equal(wakes().pending[owner.id].at, owner.at);
});

test('a weekly schedule is reused by a one-off for the same label, and resolves at fire time under the new owner (D1)', t => {
  fixture(t);
  consent([], true, 'empty');
  const old = setWake('empty', { at: '2099-01-01', from: alice, label: 'Next', days: ['mon'] });
  saveSeriesSettings(seriesDir('empty'), { version: 1, owner: bob, epoch: 2, since: 'later' });
  consent([], true, 'empty');
  const next = setWake('empty', { at: '2099-01-02', from: bob, label: 'Next' });
  assert.equal(next.id, old.id);
  assert.equal(next.request, false);
  assert.deepEqual(next.days, ['mon']);
});

test('schedules resolve credentials at fire time: additions reach schedules, missing consent becomes a request', t => {
  const inst = fixture(t);
  consent(['m365:x'], true);
  consent(['m365:x'], true, 'empty');
  const existing = setWake(inst.id, { at: '2000-01-01', from: alice });
  const next = setWake('empty', { at: '2000-01-01', from: alice, label: 'Next' });
  assert.equal(next.request, false);
  consent(['m365:x', 'm365:y'], true);
  consent(['m365:x', 'm365:y'], true, 'empty');
  fire();
  const entry = inst.log.findLast(e => e.op === 'wake')!;
  assert.deepEqual((entry.authority as Authority).logins, ['m365:x', 'm365:y']);
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
    assert.equal(continuation.request, false, 'same-series live run sets an owner-side schedule resolved at fire time');
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

test('a named-answer run keeps its initiator when a restart continues it', t => {
  const inst = fixture(t);
  consent([], true);
  const lease = authority(inst);
  inst.append('server', 'run', { run: 1, runner: alice, initiator: bob, authority: lease });
  recover();
  const wake = inst.log.findLast(e => e.op === 'wake')!;
  assert.deepEqual(standing(inst, wake), { word: 'runner', starts: true });
  assert.equal(wake.initiator, bob);
});

for (const hadRun of [false, true]) for (const autonomous of [false, true]) test(`named-answer login recovery, hadRun=${hadRun}, autonomous=${autonomous}`, t => {
  const inst = fixture(t);
  consent([], autonomous);
  const lease = authority(inst);
  if (hadRun) inst.append('server', 'run', { run: 1, runner: alice, initiator: bob, authority: lease });
  inst.append('server', 'expired', { login: 'entra', runner: alice, initiator: bob, authority: lease, ...(hadRun && { run: 1 }) });
  assert.equal(held(inst, 'entra', alice), true);
  changes.emit('login', alice, 'entra', 'rollforward');
  const wake = inst.log.findLast(e => e.op === 'wake')!;
  assert.deepEqual(standing(inst, wake), { word: 'runner', starts: autonomous });
  assert.equal(wake.initiator, bob);
  assert.equal(held(inst, 'entra', alice), false);
});

test('only immediate personal owner wakes can execute without autonomy', t => {
  const inst = fixture(t);
  consent();
  const now = new Date().toISOString();
  const immediate = setWake(inst.id, { from: alice, at: now });
  assert.equal(immediate.request, false);
  assert.equal(immediate.immediate, true);
  fire();
  assert.deepEqual(standing(inst, inst.log.findLast(e => e.op === 'wake')!), { word: 'runner', starts: true });
  const future = setWake(inst.id, { from: alice, at: '2000-01-01' });
  const w = wakes();
  delete w.fired[inst.id];
  w.pending[future.id].immediate = undefined;
  writeJson('wakes.json', w);
  fire();
  assert.equal(wakes().requests[future.id].target, inst.id, 'non-immediate owner wake without autonomy becomes a request at fire');
  const agent = setWake(inst.id, { from: 'W/S/First', inst: inst.id, at: now });
  assert.equal(agent.request, true);
  const absent = seriesSettings(inst.series());
  saveSeriesSettings(inst.series(), { ...absent, consent: undefined });
  const noConsent = setWake(inst.id, { from: alice, at: now });
  fire();
  assert.equal(wakes().requests[noConsent.id].target, inst.id, 'immediate owner wake without consent becomes a request at fire');
});

for (const [from, autonomous] of [[bob, true], [alice, false]] as const) for (const series of [false, true]) test(`weekly requests keep recurring: setter ${from}, autonomous ${autonomous}, series ${series}`, t => {
  const inst = fixture(t);
  consent([], autonomous, series ? 'empty' : 's');
  const target = series ? 'empty' : inst.id, days = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const wake = setWake(target, { from, at: '2099-01-01T08:00:00.000Z', days, ...(series && { label: 'BB 2000-01-07' }), text: 'Please check' });
  const w = wakes();
  w.pending[wake.id].at = new Date(2000, 0, 7, 8).toISOString();
  writeJson('wakes.json', w);
  fire();
  assert.equal(wakes().pending[wake.id].at, new Date(2000, 0, 10, 8).toISOString());
  assert.deepEqual(wakes().pending[wake.id].days, days);
  assert.equal(wakes().pending[wake.id].label, series ? 'BB 2000-01-10' : undefined);
  assert.equal(wakes().pending[wake.id].authority, undefined);
  assert.equal(wakes().pending[wake.id].immediate, undefined);
  const [first] = Object.entries(wakes().requests);
  assert.equal(first[1].from, from);
  assert.equal(first[1].label, series ? 'BB 2000-01-07' : inst.label);
  assert.equal(first[1].text, 'Please check');
  assert.equal(first[1].target, series ? undefined : inst.id);
  fire();
  assert.equal(wakes().pending[wake.id].at, new Date(2000, 0, 11, 8).toISOString());
  assert.equal(Object.keys(wakes().requests).length, 2);
  assert.deepEqual(wakes().requests[first[0]], first[1], 'each occurrence retains its own request');
  assert.equal(inst.log.some(e => e.op === 'wake' || e.op === 'run'), false);
});

for (const autonomous of [false, true]) test(`an immediate weekly wake clears immediate and resolves autonomy ${autonomous} at next fire`, t => {
  const inst = fixture(t);
  consent([], autonomous);
  const { id } = setWake(inst.id, { from: alice, at: new Date().toISOString(), days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
  fire();
  assert.equal(inst.log.some(e => e.op === 'wake'), true);
  assert.equal(wakes().pending[id].immediate, undefined);
  assert.equal(wakes().pending[id].request, false);
  const w = wakes();
  delete w.fired[inst.id];
  w.pending[id].at = '2000-01-01T00:00:00.000Z';
  writeJson('wakes.json', w);
  fire();
  assert.equal(inst.log.filter(e => e.op === 'wake').length, autonomous ? 2 : 1);
  assert.equal(Object.keys(wakes().requests).length, autonomous ? 0 : 1);
});

for (const autonomous of [false, true]) test(`an immediate owner wake bypasses schedule spacing with autonomy ${autonomous}`, t => {
  const inst = fixture(t);
  consent([], autonomous);
  const now = new Date().toISOString();
  writeJson('wakes.json', { ...wakes(), fired: { [inst.id]: now } });
  const wake = setWake(inst.id, { from: alice, at: now });
  assert.equal(wake.at, now);
  assert.equal(wake.immediate, true);
  fire();
  assert.deepEqual(standing(inst, inst.log.findLast(e => e.op === 'wake')!), { word: 'runner', starts: true });
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

test('membership withdrawal clears consent even for an empty owned series', t => {
  fixture(t);
  consent([], true, 'empty');
  const t0 = tree();
  t0.workspaces.w.members = [bob];
  saveTree(t0);
  assert.equal(seriesSettings(seriesDir('empty')).consent, undefined);
  assert.equal(seriesSettings(seriesDir('empty')).owner, alice);
  assert.equal(seriesSettings(seriesDir('empty')).epoch, 2);
});

test('D1: after transfer, schedule waits as request until new owner consents with autonomous on, then fires as new owner', t => {
  const inst = fixture(t);
  consent(['m365:x'], true);
  saveLogin(bob, { id: 'm365', kind: 'm365', name: 'M365', since: '2026-01-01', offers: [{ id: 'm365:bob', name: 'Bob' }] });
  const sched = setWake(inst.id, { at: '2099-01-01T08:00:00.000Z', from: alice, days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  // Transfer to bob (clears consent, bumps epoch)
  saveSeriesSettings(inst.series(), { version: 1, owner: bob, epoch: 2, since: '2026-01-02' });
  let w = wakes();
  w.pending[sched.id].at = '2000-01-03T08:00:00.000Z';
  writeJson('wakes.json', w);
  fire();
  assert.equal(Object.keys(wakes().requests).length, 1, 'before new owner consents, occurrence becomes a request');
  assert.equal(inst.log.some(e => e.op === 'wake'), false);
  // Bob saves credentials with autonomous on
  saveSeriesSettings(inst.series(), { version: 1, owner: bob, epoch: 2, since: '2026-01-02', consent: { by: bob, at: '2026-01-02', workspace: 'w', logins: ['m365:bob'], autonomous: true } });
  w = wakes();
  delete w.fired[inst.id];
  w.pending[sched.id].at = '2000-01-04T08:00:00.000Z';
  writeJson('wakes.json', { ...w, requests: {} });
  fire();
  const entry = inst.log.findLast(e => e.op === 'wake')!;
  assert.equal((entry.authority as Authority).owner, bob);
  assert.deepEqual((entry.authority as Authority).logins, ['m365:bob']);
  assert.equal(entry.initiator, bob);
});

test('D2: narrowing credentials does not kill schedules; schedule fires with remaining credentials', t => {
  const inst = fixture(t);
  consent(['m365:x', 'm365:y'], true);
  const sched = setWake(inst.id, { at: '2099-01-01T08:00:00.000Z', from: alice });
  // Narrow credentials (untick m365:y, epoch bumps)
  saveSeriesSettings(inst.series(), { version: 1, owner: alice, epoch: 2, since: '2026-01-02', consent: { by: alice, at: '2026-01-02', workspace: 'w', logins: ['m365:x'], autonomous: true } });
  const w = wakes();
  w.pending[sched.id].at = '2000-01-01T08:00:00.000Z';
  writeJson('wakes.json', w);
  fire();
  const entry = inst.log.findLast(e => e.op === 'wake')!;
  assert.deepEqual((entry.authority as Authority).logins, ['m365:x']);
  assert.equal(Object.keys(wakes().requests).length, 0);
});

test('D3: turning autonomous off pauses schedules as requests; turning it back on resumes them', t => {
  const inst = fixture(t);
  consent(['m365:x'], true);
  const sched = setWake(inst.id, { at: '2099-01-01T08:00:00.000Z', from: alice, days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  // Turn autonomous off
  saveSeriesSettings(inst.series(), { version: 1, owner: alice, epoch: 2, since: '2026-01-02', consent: { by: alice, at: '2026-01-02', workspace: 'w', logins: ['m365:x'], autonomous: false } });
  let w = wakes();
  w.pending[sched.id].at = '2000-01-03T08:00:00.000Z';
  writeJson('wakes.json', w);
  fire();
  assert.equal(Object.keys(wakes().requests).length, 1);
  assert.equal(inst.log.some(e => e.op === 'wake'), false);
  // Turn autonomous back on
  saveSeriesSettings(inst.series(), { version: 1, owner: alice, epoch: 2, since: '2026-01-02', consent: { by: alice, at: '2026-01-03', workspace: 'w', logins: ['m365:x'], autonomous: true } });
  w = wakes();
  delete w.fired[inst.id];
  w.pending[sched.id].at = '2000-01-04T08:00:00.000Z';
  writeJson('wakes.json', { ...w, requests: {} });
  fire();
  assert.equal(inst.log.filter(e => e.op === 'wake').length, 1);
});

test('colleague-set request wake stays a request even after the colleague becomes owner', t => {
  const inst = fixture(t);
  consent([], true);
  const reqWake = setWake(inst.id, { at: '2099-01-01T08:00:00.000Z', from: bob });
  assert.equal(reqWake.request, true);
  saveSeriesSettings(inst.series(), { version: 1, owner: bob, epoch: 2, since: '2026-01-02', consent: { by: bob, at: '2026-01-02', workspace: 'w', logins: [], autonomous: true } });
  const w = wakes();
  w.pending[reqWake.id].at = '2000-01-01T08:00:00.000Z';
  writeJson('wakes.json', w);
  fire();
  assert.equal(wakes().requests[reqWake.id].target, inst.id);
  assert.equal(inst.log.some(e => e.op === 'wake'), false);
});

test('migrateWakes conservatively converts stale snapshots and legacy requests to request:true while keeping current owner wakes', t => {
  const inst = fixture(t);
  consent(['m365:x'], true);
  const currentAuth = authority(inst);
  const staleAuth = { ...currentAuth, owner: bob, epoch: 0 };
  writeJson('wakes.json', {
    pending: {
      current: { target: inst.id, at: '2099-01-01T08:00:00.000Z', from: alice, authority: currentAuth, initiator: alice },
      stale: { target: inst.id, at: '2099-01-02T08:00:00.000Z', from: bob, authority: staleAuth, initiator: bob },
      legacyReq: { target: inst.id, at: '2099-01-03T08:00:00.000Z', from: bob },
    },
    fired: {},
    requests: {},
  });
  migrateWakes();
  const after = wakes();
  assert.equal(after.version, 2);
  assert.equal(after.pending.current.request, false);
  assert.equal('authority' in after.pending.current, false);
  assert.equal('initiator' in after.pending.current, false);
  assert.equal(after.pending.stale.request, true);
  assert.equal('authority' in after.pending.stale, false);
  assert.equal('initiator' in after.pending.stale, false);
  assert.equal(after.pending.legacyReq.request, true);
});

test('migrateWakes fails closed on unmarked v2 rollback wakes (P1-1/F1) and credential-broadening legacy wakes (P1-2)', t => {
  const inst = fixture(t);
  consent(['m365:x', 'm365:y'], true);
  const currentAuth = authority(inst);
  const narrowerAuth = { ...currentAuth, logins: ['m365:x'] };
  writeJson('wakes.json', {
    version: 2,
    pending: {
      rollbackColleague: { target: inst.id, at: '2099-01-01T08:00:00.000Z', from: bob, text: 'colleague wake written on v0.8.13' },
      narrowerLegacy: { target: inst.id, at: '2099-01-02T08:00:00.000Z', from: alice, authority: narrowerAuth, initiator: alice },
      validOwner: { target: inst.id, at: '2099-01-03T08:00:00.000Z', from: alice, request: false },
    },
    fired: {},
    requests: {},
  });
  migrateWakes();
  const after = wakes();
  assert.equal(after.pending.rollbackColleague.request, true);
  assert.equal(after.pending.narrowerLegacy.request, true);
  assert.equal('authority' in after.pending.narrowerLegacy, false);
  assert.equal(after.pending.validOwner.request, false);
});
