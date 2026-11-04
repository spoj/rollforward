import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, instance, labels, openStore, type Instance } from '../src/store.ts';
import { initSystem, readJson, saveTree, tree, writeJson } from '../src/system.ts';
import type { Active } from '../src/waker.ts';

// Wakes without a model: a run that a wake starts ends at once for want of a key, which is enough to see what started it.
delete process.env.OPENROUTER_API_KEY;
process.env.RF_WAKE_TICK_MS = '50';
const { closed, kick, message, recover, resolveFor, setWake, startWaking, view, wakes } = await import('../src/waker.ts');
const { saveLogin } = await import('../src/logins.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-wake-')), alice = 'alice@demo.test';
initSystem(tmp);
openStore(tmp);
saveTree({
  workspaces: { w: { name: 'Acme', owners: [alice], members: [] }, x: { name: 'Hidden', owners: ['zed@demo.test'], members: [] }, m: { name: 'Main', owners: [alice, 'zed@demo.test'], members: [] } },
  series: {
    s1: { name: 'Bank rec', workspace: 'w' }, s2: { name: 'Borrowing base', workspace: 'w' }, s3: { name: 'Payroll', workspace: 'x' },
    s4: { name: 'Lunch', workspace: 'w', single: true }, s5: { name: 'Close', workspace: 'm' }, s6: { name: 'Queue', workspace: 'w' },
  },
});
writeJson('users.json', { [alice]: { role: 'user' } });
for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) mkdirSync(join(tmp, 'series', s), { recursive: true });
const make = (series: string, label: string) => createInstance(series, label, alice, []);
const aug = make('s1', '2026-08');
await aug.close({ email: alice, name: 'Alice' });
const sep = make('s1', '2026-09'), oct = make('s1', '2026-10');
const run = { inst: sep, view: { cwd: '/work/Acme/Bank rec' } } as unknown as Active;
const ops = (i: Instance) => i.log.map(e => e.op);
const settle = () => new Promise(r => setTimeout(r, 2000));
startWaking();

after(() => rmSync(tmp, { recursive: true, force: true }));

test('a message names the runner and what they lend only where its entries set those', () => {
  assert.match(message(oct, 1, oct.log), new RegExp(`^Instance 2026-10 \\(folder 2026-10/\\), run 1\\. Its runner is .+ <${alice}>, who lends you no connection\\. New log entries:`));
  assert.match(message(oct, 2, []), /^Instance 2026-10 \(folder 2026-10\/\), run 2\. New log entries:/);
  assert.match(message(oct, 3, [{ seq: 99, at: '', by: 'bob@demo.test', op: 'takeover', from: alice }]), new RegExp(`run 3\\. Its runner is now .+ <bob@demo\\.test>, taking over from .+ <${alice}>, who lends you no connection\\.`));
});

test('a run names a series or an instance by its folder, within its reach', () => {
  assert.equal(resolveFor(run, '2026-10'), oct.id);
  assert.equal(resolveFor(run, '.'), 's1');
  assert.equal(resolveFor(run, '../Borrowing base'), 's2');
  assert.equal(resolveFor(run, '../../Main/Close'), 's5', 'a wider workspace is in reach');
  assert.throws(() => resolveFor(run, '../../Hidden/Payroll'), /no series you can read/);
  assert.throws(() => resolveFor(run, '../../../x/Acme/Bank rec'), /no series you can read/);
  assert.throws(() => resolveFor(run, '2026-13'), /no instance 2026-13 in Bank rec/);
});

test('a due wake its own run set continues an open instance, as a reply does, though it was renamed since, and names where that run is now; one more than 15 minutes after its last is moved', async () => {
  setWake(oct.id, { at: new Date().toISOString(), from: 'Acme/Bank rec/October', inst: oct.id });
  await settle();
  assert.deepEqual(oct.log.filter(e => e.op === 'wake').map(e => [e.from, e.note]), [['Acme/Bank rec/2026-10', undefined]]);
  assert.ok(ops(oct).includes('run'), 'it started a run');
  assert.equal(wakes().pending[oct.id], undefined);
  const next = setWake(oct.id, { at: new Date().toISOString(), from: 'x' });
  assert.ok(Date.parse(next.at) - Date.parse(wakes().fired[oct.id]) >= 15 * 60_000);
});

test("a series' wake starts an instance as whoever shares the series; unshared, or with 3 open, it's a request", async () => {
  setWake('s2', { at: new Date().toISOString(), from: 'Acme/Bank rec/2026-09', label: '2026-10' });
  await settle();
  assert.deepEqual(Object.values(wakes().requests).map(r => [r.series, r.label, r.from]), [['s2', '2026-10', 'Acme/Bank rec/2026-09']]);
  assert.equal(labels('s2').length, 0);

  writeFileSync(join(tmp, 'series', 's2', 'series.json'), JSON.stringify({ shared: { by: alice, since: new Date().toISOString(), logins: [] } }));
  writeJson('wakes.json', { ...readJson('wakes.json', {}), fired: {} });
  setWake('s2', { at: new Date().toISOString(), from: 'Acme/Bank rec/2026-09', label: '2026-11' });
  await settle();
  const made = instance(labels('s2').find(l => l.label === '2026-11')!.id);
  assert.deepEqual([made.log[0].op, made.log[0].by, made.log[1].op, made.log[1].from], ['create', alice, 'wake', 'Acme/Bank rec/2026-09']);

  make('s2', '2026-12');
  make('s2', '2027-01');
  writeJson('wakes.json', { ...readJson('wakes.json', {}), fired: {} });
  setWake('s2', { at: new Date().toISOString(), from: 'x', label: '2027-02' });
  await settle();
  assert.ok(Object.values(wakes().requests).some(r => r.label === '2027-02'), '3 open already');
});

test("closing an instance wakes the later open ones of its series, not the earlier; a note for those the closer doesn't start", async () => {
  const before = make('s1', '2026-07');
  await sep.close({ email: alice, name: 'Alice' });
  closed(sep, alice);
  await settle();
  assert.deepEqual([oct.log.findLast(e => e.op === 'wake')!.reason, oct.log.findLast(e => e.op === 'wake')!.note], [`2026-09 closed: its final figures may differ from the draft you read`, undefined]);
  assert.ok(!ops(before).includes('wake'));
  closed(sep, 'bob@demo.test');
  assert.equal(oct.log.findLast(e => e.op === 'wake')!.note, true);
});

test("a commit a restart cut leaves git's locks, which the next start clears for the instance's next commit", async () => {
  const cut = make('s3', 'locked'), { commit } = await import('../src/git.ts'), who = { name: 'Alice', email: alice };
  await commit(cut.dir, who, 'first');
  for (const f of ['index.lock', 'refs/heads/main.lock']) writeFileSync(join(cut.dir, '.git', f), '');
  await assert.rejects(commit(cut.dir, who, 'refused'), /lock/);
  recover();
  assert.match(await commit(cut.dir, who, 'second'), /^[0-9a-f]{40}$/);
});

test('a run a restart cut ends as aborted, with what its calls cost so far, and its instance is woken to carry on', async () => {
  const cut = make('s3', 'cut');
  cut.append('server', 'run', { run: 1, upto: 1 });
  cut.append('agent', 'call', { run: 1, name: 'openrouter', cost: 5 });
  cut.append('server', 'done', { run: 1, aborted: false, seen: 1, cost: 5, summary: null });
  cut.append('server', 'run', { run: 2, upto: 1 });
  for (const c of [{ name: 'openrouter', cost: 0.25 }, { name: 'graph' }, { name: 'exa', cost: 0.5 }]) cut.append('agent', 'call', { run: 2, ...c });
  recover();
  assert.deepEqual(cut.log.slice(-2).map(e => [e.op, e.error ?? e.reason, e.cost]), [['done', 'a restart cut the run', 0.75], ['wake', 'A restart cut your last run; carry on', undefined]]);
  await settle();
  assert.equal(cut.log.filter(e => e.op === 'run').length, 3, 'started again');
});

test("an instance whose run met its runner's expired login carries on when they sign in again, once", async () => {
  const waits = make('s2', 'waits');
  waits.append('server', 'expired', { login: 'm365', runner: alice });
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '', offers: [], expired: true });
  assert.ok(!waits.log.some(e => e.op === 'wake'), 'an expired login wakes nothing');
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '', offers: [] }, 'refresh');
  assert.deepEqual(waits.log.filter(e => e.op === 'wake').map(e => e.reason), [`${alice} signed in to Microsoft 365 again`]);
  saveLogin(alice, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '', offers: [] }, 'turned over');
  assert.equal(waits.log.filter(e => e.op === 'wake').length, 1, 'a refresh token turning over wakes nothing');
  await settle();
  assert.ok(waits.log.some(e => e.op === 'run'), 'the wake started a run');
});

test('after a restart every open instance with something for a run starts; an Interrupt holds until the next act', async () => {
  const queued = make('s6', 'queued'), held = make('s6', 'held');
  queued.append(alice, 'comment', { thread: 't1', text: 'please redo' });
  held.append(alice, 'comment', { thread: 't2', text: 'stop that' });
  held.append(alice, 'interrupt');
  recover();
  await settle();
  assert.ok(ops(queued).includes('run'), 'its comment came just before the restart');
  assert.ok(!ops(held).includes('run'), 'interrupted, it waits for the next act');
});

test("a task's run sees its own instance alone in its series' folder, and the series in reach, not their packages; a wake in an archived workspace is dropped", async () => {
  const v = view(make('s4', 'Lunch'));
  assert.equal(v.cwd, '/work/Acme/Lunch');
  assert.deepEqual(v.ro.map(([, at]) => at).filter(at => at.startsWith('/work/Acme/Lunch/')), ['/work/Acme/Lunch/Lunch']);
  assert.ok(v.ro.some(([, at]) => at.startsWith('/work/Acme/Bank rec/')) && !v.ro.some(([, at]) => at.endsWith('/.pylib')), "another series' .pylib is its own runs' code");
  const t = tree(), cut = instance(labels('s3').find(l => l.label === 'cut')!.id);
  saveTree({ ...t, workspaces: { ...t.workspaces, x: { ...t.workspaces.x, archived: true } } });
  setWake(cut.id, { at: new Date().toISOString(), from: 'x' });
  await settle();
  assert.equal(wakes().pending[cut.id], undefined);
  assert.ok(!cut.log.some(e => e.op === 'wake' && e.from === 'x'));
});

test("others' comments and wakes are notes for an instance's runner, unless the agent asked them, and start runs only where the runner shares the series, where comments stay notes", async () => {
  const bob = 'bob@demo.test', notes = make('s5', 'notes'), runs = (i: Instance) => i.log.filter(e => e.op === 'run').length;
  notes.append(bob, 'comment', { thread: 'n1', text: 'use the new rate' });
  setWake(notes.id, { at: new Date().toISOString(), from: bob });
  kick(notes);
  await settle();
  assert.deepEqual([runs(notes), notes.log.at(-1)!.op, notes.log.at(-1)!.note], [0, 'wake', true], "bob's comment and wake are notes for alice");
  notes.append('agent', 'comment', { thread: 'q1', text: 'Which rate?', ask: true, to: bob });
  notes.append(bob, 'comment', { thread: 'q1', text: 'the new one' });
  kick(notes);
  await settle();
  assert.equal(runs(notes), 1, 'the agent asked bob, so his reply starts a run');
  writeFileSync(join(tmp, 'series', 's5', 'series.json'), JSON.stringify({ shared: { by: alice, since: new Date().toISOString(), logins: [] } }));
  const shared = make('s5', 'shared');
  shared.append(bob, 'comment', { thread: 'n2', text: 'go' });
  kick(shared);
  await settle();
  assert.equal(runs(shared), 1, 'in a series its runner shares, anyone starts runs');
  assert.match(message(shared, 1, shared.log), /"by":"bob@demo\.test","op":"comment".*"note":true/, "and bob's comment still reaches the agent as a note");
});
