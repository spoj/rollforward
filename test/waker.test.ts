import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, instance, labels, openStore, renameInstance, type Instance } from '../src/store.ts';
import { initSystem, readJson, saveTree, tree, writeJson } from '../src/system.ts';
import type { Active } from '../src/waker.ts';
import { committed } from '../src/git.ts';
import { idp } from './idp.ts';

// Wakes without a model: a run that a wake starts ends at once for want of a key, which is enough to see what started it.
delete process.env.OPENROUTER_API_KEY;
process.env.RF_WAKE_TICK_MS = '50';
const entra = await idp();
Object.assign(process.env, entra.env('http://127.0.0.1:1'));
const { cancelWakes, citedFor, closed, kick, message, recover, resolveFor, setWake, startWaking, view, wakes, wakesOf, weekly } = await import('../src/waker.ts');
const { saveLogin } = await import('../src/logins.ts');
const { keepSignIn } = await import('../src/entra.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-wake-')), alice = 'alice@demo.test';
initSystem(tmp);
openStore(tmp);
saveTree({
  workspaces: { w: { name: 'Acme', owners: [alice], members: [] }, x: { name: 'Hidden', owners: ['zed@demo.test'], members: [] }, m: { name: 'Main', owners: [alice, 'zed@demo.test'], members: [] }, l: { name: 'Leavers', owners: ['lee@demo.test'], members: [] } },
  series: {
    s1: { name: 'Bank rec', workspace: 'w' }, s2: { name: 'Borrowing base', workspace: 'w' }, s3: { name: 'Payroll', workspace: 'x' },
    s4: { name: 'Lunch', workspace: 'w', single: true }, s5: { name: 'Close', workspace: 'm' }, s6: { name: 'Queue', workspace: 'w' }, s7: { name: 'Leaver', workspace: 'l' },
    s8: { name: 'Locked', workspace: 'w' },
  },
});
writeJson('users.json', { [alice]: { role: 'user' } });
keepSignIn(alice, entra.refresh(alice));
for (const s of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) mkdirSync(join(tmp, 'series', s), { recursive: true });
const make = (series: string, label: string) => createInstance(series, label, alice, []);
const aug = make('s1', '2026-08');
await aug.close({ email: alice, name: 'Alice' });
const sep = make('s1', '2026-09'), oct = make('s1', '2026-10');
const run = { inst: sep, view: view(sep) } as unknown as Active;
const ops = (i: Instance) => i.log.map(e => e.op);
const settle = () => new Promise(r => setTimeout(r, 2000));
startWaking();

after(() => (entra.close(), rmSync(tmp, { recursive: true, force: true })));

test("a run's first message names the runner and what they lend, as does a later one only where its entries change those", () => {
  assert.match(message(oct, 1, oct.log, true), new RegExp(`^Instance 2026-10, run 1\\. Its runner is .+ <${alice}>, who lends you no connection\\. New log entries:`));
  assert.match(message(oct, 2, [{ seq: 98, at: '', by: alice, op: 'comment', text: 'go' }], true), /^Instance 2026-10, run 2\. Its runner is /, 'every run is a new conversation');
  assert.match(message(oct, 2, []), /^Instance 2026-10, run 2\. New log entries:/);
  assert.match(message(oct, 3, [{ seq: 99, at: '', by: 'bob@demo.test', op: 'takeover', from: alice }]), new RegExp(`run 3\\. Its runner is now .+ <bob@demo\\.test>, taking over from .+ <${alice}>, who lends you no connection\\.`));
});

test("a run names a series or an instance by its folder, from its own instance's", () => {
  assert.equal(resolveFor(run, '.'), sep.id);
  assert.equal(resolveFor(run, '../2026-10'), oct.id);
  assert.equal(resolveFor(run, '..'), 's1');
  assert.equal(resolveFor(run, '../../Borrowing base'), 's2');
  assert.equal(resolveFor(run, '../../../Main/Close'), 's5', 'a wider workspace is in reach');
  assert.throws(() => resolveFor(run, '../../../Hidden/Payroll'), /no series you can read/);
  assert.throws(() => resolveFor(run, '../../../../x/Acme/Bank rec'), /no series you can read/);
  assert.throws(() => resolveFor(run, '../2026-13'), /no instance 2026-13 in Bank rec/);
});

test('a run names folders, and cites files, by the names it started with, though people renamed them since', () => {
  const nov = make('s1', '2026-11'), started = { inst: sep, view: view(sep) } as unknown as Active, t = tree();
  writeFileSync(join(nov.dir, 'working', 'x.csv'), '1');
  renameInstance(nov, 'November');
  saveTree({ ...t, series: { ...t.series, s2: { ...t.series.s2, name: 'BB' } } });
  assert.equal(resolveFor(started, '../2026-11'), nov.id);
  assert.equal(resolveFor(started, '../../Borrowing base'), 's2');
  assert.throws(() => resolveFor(started, '../November'), /no instance November in Bank rec/);
  assert.throws(() => resolveFor(started, '../../BB'), /no series you can read/);
  assert.deepEqual(citedFor(started, '../2026-11/working/x.csv'), { inst: nov.id, path: 'working/x.csv' }, "kept by the instance's id");
  assert.deepEqual(citedFor(started, 'upload/../working/x.csv'), undefined);
  assert.deepEqual(citedFor(started, '../2026-11/working/y.csv'), undefined, 'a file that is there');
  assert.deepEqual(citedFor(started, '../../Borrowing base/working/x.csv'), undefined, 'of its own series');
  saveTree(t);
});

test('a due wake its own run set continues an open instance, as a reply does, though it was renamed since, and names where that run is now; one more than 15 minutes after its last is moved', async () => {
  setWake(oct.id, { at: new Date().toISOString(), from: 'Acme/Bank rec/October', inst: oct.id });
  await settle();
  assert.deepEqual(oct.log.filter(e => e.op === 'wake').map(e => [e.from, e.note]), [['Acme/Bank rec/2026-10', undefined]]);
  assert.ok(ops(oct).includes('run'), 'it started a run');
  assert.deepEqual(wakesOf(oct.id), []);
  const next = setWake(oct.id, { at: new Date().toISOString(), from: 'x' });
  assert.ok(Date.parse(next.at) - Date.parse(wakes().fired[oct.id]) >= 15 * 60_000);
});

test("a wake a person set fires only while they may see its workspace, and a target has 20 wakes at most", async t => {
  const lunch = make('s6', 'lunch'), said = t.mock.method(console, 'log', () => {});
  setWake(lunch.id, { at: new Date().toISOString(), from: 'zed@demo.test' });
  await settle();
  assert.deepEqual([ops(lunch).includes('wake'), wakesOf(lunch.id), said.mock.calls.map(c => String(c.arguments[0]))], [false, [], ['a wake zed@demo.test set went unfired, as they can no longer see Acme']]);
  for (let d = 1; d <= 20; d++) setWake(lunch.id, { at: new Date(2031, 0, d).toISOString(), from: alice });
  assert.throws(() => setWake(lunch.id, { at: new Date(2031, 1, 1).toISOString(), from: alice }), /20 wakes are pending for it: cancel one first/);
  assert.equal(setWake(lunch.id, { at: new Date(2031, 0, 1).toISOString(), from: alice }).at, new Date(2031, 0, 1).toISOString(), 'the same again is one');
  cancelWakes([lunch.id]);
});

test('a process.md a run made unreadable is none to the server, so the next run starts all the same, and its commit makes it readable again', async () => {
  const locked = make('s8', 'locked'), md = join(locked.dir, 'working', 'process.md');
  writeFileSync(md, '- a rule\n');
  chmodSync(md, 0);
  locked.append(alice, 'comment', { thread: 'n1', text: 'go' });
  kick(locked);
  while (!locked.log.some(e => e.op === 'done')) await new Promise(r => setTimeout(r, 5));
  await committed(locked.dir);
  assert.equal(statSync(md).mode & 0o777, 0o400);
});

test("a series' wake starts an instance as whoever shares the series; unshared, or with 3 open, it's a request", async () => {
  setWake('s2', { at: new Date().toISOString(), from: 'Acme/Bank rec/2026-09', label: '2026-10' });
  await settle();
  assert.deepEqual(Object.values(wakes().requests).map(r => [r.series, r.label, r.from]), [['s2', '2026-10', 'Acme/Bank rec/2026-09']]);
  assert.equal(labels('s2').length, 0);

  writeFileSync(join(tmp, 'series', 's2', 'series.json'), JSON.stringify({ shared: { by: alice, since: new Date().toISOString(), logins: ['web:bank', 'web:portal'] } }));
  writeJson('connections.json', { bank: { type: 'website', url: 'https://bank.example.com', hosts: [], writeback: false, people: [alice], updated_by: alice, updated_at: '' } });
  writeJson('wakes.json', { ...readJson('wakes.json', {}), fired: {} });
  setWake('s2', { at: new Date().toISOString(), from: 'Acme/Bank rec/2026-09', label: '2026-11' });
  await settle();
  const made = instance(labels('s2').find(l => l.label === '2026-11')!.id);
  assert.deepEqual([made.log[0].op, made.log[0].by, made.log[1].op, made.log[1].from], ['create', alice, 'wake', 'Acme/Bank rec/2026-09']);
  assert.deepEqual(made.log[0].logins, ['web:portal'], 'a website that lists its people, ticked before it did, is never lent through the share');
  writeJson('connections.json', {});

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
  assert.deepEqual(cut.log.slice(-2).map(e => [e.op, e.error ?? e.reason, e.cost]), [['done', 'a restart cut the run', 0.75], ['wake', 'A restart cut run 2; carry on', undefined]]);
  await settle();
  assert.equal(cut.log.filter(e => e.op === 'run').length, 3, 'started again');
});

test("an act just after a run ends, as its folder is committed, starts the next run, though the last never started", async () => {
  const late = make('s2', 'late');
  late.append(alice, 'comment', { thread: 't1', text: 'go' });
  kick(late);
  while (!late.log.some(e => e.op === 'done')) await new Promise(r => setTimeout(r, 5));
  late.append(alice, 'comment', { thread: 't1', text: 'and this' });
  kick(late);
  await settle();
  assert.equal(late.log.filter(e => e.op === 'run').length, 2);
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

test("a task's run sees its own instance alone in its series' folder, and the series in reach, not their packages", () => {
  const v = view(make('s4', 'Lunch'));
  assert.equal(v.instance, '/work/Acme/Lunch/Lunch');
  assert.deepEqual(v.ro.map(([, at]) => at).filter(at => at.startsWith('/work/Acme/Lunch/')), ['/work/Acme/Lunch/Lunch']);
  assert.ok(v.ro.some(([, at]) => at.startsWith('/work/Acme/Bank rec/')) && !v.ro.some(([, at]) => at.endsWith('/.pylib')), "another series' .pylib is its own runs' code");
});

test("others' comments and wakes are notes for an instance's runner, unless the agent asked them, and start runs only where the runner shares the series, where comments stay notes", async () => {
  const bob = 'bob@demo.test', notes = make('s5', 'notes'), runs = (i: Instance) => i.log.filter(e => e.op === 'run').length;
  writeJson('users.json', { ...readJson('users.json', {}), [bob]: { role: 'user' } });
  saveTree({ ...tree(), workspaces: { ...tree().workspaces, m: { ...tree().workspaces.m, members: [bob] } } });
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

test("a run starts only for a runner Microsoft still signs in: one it no longer does waits for them to sign in again, which wakes it, and one disabled or gone is disabled here too; while Microsoft can't be reached, nothing starts", async () => {
  const lee = 'lee@demo.test', inst = createInstance('s7', 'books', lee, []), runs = () => inst.log.filter(e => e.op === 'run').length;
  const go = async () => (inst.append(lee, 'comment', { thread: 'g', text: 'go' }), kick(inst), await settle());
  await go();
  assert.deepEqual([runs(), inst.log.at(-1)!.op, inst.log.at(-1)!.error], [0, 'expired', "lee@demo.test hasn't signed in to rollforward since sign-ins are kept"], 'no sign-in kept, nor a Microsoft 365 login');
  keepSignIn(lee, entra.refresh(lee));
  await settle();
  assert.deepEqual([runs(), entra.who.renewed.at(-1)], [1, lee], 'signing in wakes it, and its run renews the sign-in first');
  entra.who.stale.add(lee);
  await go();
  assert.match(inst.log.at(-1)!.error as string, /AADSTS700082/);
  const asked = entra.who.renewed.length;
  await go();
  assert.deepEqual([runs(), inst.log.filter(e => e.op === 'expired').length, entra.who.renewed.length], [1, 2, asked], 'it waits for them, asking Microsoft no more');
  entra.who.stale.delete(lee);
  entra.who.down = true;
  keepSignIn(lee, entra.refresh(lee));
  await settle();
  assert.deepEqual([runs(), inst.log.at(-1)!.op], [1, 'wake'], "Microsoft unreachable, it doesn't start, and tries again in a minute");
  entra.who.down = false;
  kick(inst);
  await settle();
  assert.equal(runs(), 2);
  entra.who.gone.add(lee);
  await go();
  const { users } = await import('../src/auth.ts');
  assert.deepEqual([runs(), inst.log.at(-1)!.left, users()[lee].disabled], [2, true, true], 'Microsoft says the account is disabled: so is its person here');
});

test("a weekly wake's days are such as mon-fri or mon,wed,fri, and it first fires on one of them; a series' label holds the date it fires or the one before that it fires on", () => {
  const fri = new Date(2020, 0, 3, 8), mon = new Date(2020, 0, 6, 8), weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
  assert.deepEqual(weekly('mon-fri', fri, '2020-01-03'), weekdays, 'the day it fires');
  assert.deepEqual(weekly('Mon-Fri', mon, 'BB 2020-01-03'), weekdays, "Monday's is Friday's");
  assert.throws(() => weekly('mon-fri', mon, '2020-01-05'), /holds the date it first fires, 2020-01-06, or the one before it that it fires on, 2020-01-03/);
  assert.throws(() => weekly('mon-fri', mon, 'January'), /holds the date/);
  assert.throws(() => weekly('sat,sun', mon), /2020-01-06 is a mon, not one of the days/);
  assert.deepEqual(weekly('fri-mon, wed', fri), ['mon', 'wed', 'fri', 'sat', 'sun']);
  assert.equal(weekly('', fri), undefined, 'none: a one-off');
  assert.throws(() => weekly('weekdays', fri), /days: such as mon-fri/);
});

test("a target has as many wakes as are set, the same twice being one, and a series' for a label pending moves it; each run's first message lists its instance's and series' by id", () => {
  const nov = make('s6', 'listed'), at = (d: number, h: number) => new Date(2030, 0, d, h).toISOString();
  const a = setWake(nov.id, { at: at(7, 8), from: 'x' });
  setWake(nov.id, { at: at(8, 8), from: 'x' });
  assert.equal(setWake(nov.id, { at: at(7, 8), from: 'y' }).id, a.id, 'the same twice is one');
  const s = setWake('s6', { at: at(7, 8), from: 'x', label: '2030-01-07' });
  assert.equal(setWake('s6', { at: at(7, 9), from: 'x', label: '2030-01-07' }).id, s.id);
  assert.deepEqual([wakesOf(nov.id).length, wakesOf('s6').map(k => k.at)], [2, [at(7, 9)]], 'moved');
  assert.match(message(nov, 1, nov.log, true), new RegExp(`Pending wakes: ${a.id}, waking this instance at ${at(7, 8)}; \\w+, waking this instance at ${at(8, 8)}; ${s.id}, starting 2030-01-07 at ${at(7, 9)}\\. New log entries`));
  cancelWakes([nov.id, 's6']);
  assert.deepEqual([...wakesOf(nov.id), ...wakesOf('s6')], []);
});

test("a weekly wake fires on its days at its time and moves on, a series' label with it; a target's wakes fire 15 minutes apart; and a series' wake for a label it has continues that instance", async () => {
  const fri = (h: number) => new Date(2020, 0, 3, h).toISOString(), daily = make('s6', 'daily');
  const series = setWake('s6', { at: fri(8), from: 'x', label: 'BB 2020-01-02', days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  const own = setWake(daily.id, { at: fri(17), from: 'x', days: ['fri'] });
  setWake('s1', { at: fri(9), from: 'y', label: '2026-10' });
  await settle();
  const req = Object.values(wakes().requests).find(r => r.series === 's6')!;
  assert.equal(req.label, 'BB 2020-01-02', 'no one shares it, so someone is asked to start it');
  assert.deepEqual(wakesOf('s6').map(k => [k.id, k.at, k.label]), [[series.id, new Date(2020, 0, 6, 8).toISOString(), 'BB 2020-01-03']], "Monday's, Friday's, which waits for the 15 minutes since Friday's");
  assert.deepEqual(wakesOf(daily.id).map(k => [k.id, k.at]), [[own.id, new Date(2020, 0, 10, 17).toISOString()]]);
  assert.ok(daily.log.some(e => e.op === 'wake' && e.from === 'x'));
  assert.ok(oct.log.some(e => e.op === 'wake' && e.from === 'y'), "2026-10 is Bank rec's already");
  cancelWakes(['s6', daily.id]);
});

test("a run's first message lists the corrections on its series' closed instances before it; a <label>-r2 closing supersedes <label>", async () => {
  const { correct } = await import('../src/waker.ts'), q3 = make('s2', 'q3');
  await q3.close({ email: alice, name: 'Alice' });
  const r2 = make('s2', 'q3-r2'), q4 = make('s2', 'q4');
  correct(q3, alice, { kind: 'wrong', text: 'The rate was a day stale.' });
  assert.match(message(q4, 1, q4.log, true), / Corrections on earlier instances: q3 is wrong, "The rate was a day stale\."\. New log entries:/);
  assert.doesNotMatch(message(q4, 2, q4.log), /Corrections/, 'the first message only');
  await r2.close({ email: alice, name: 'Alice' });
  closed(r2, alice);
  assert.deepEqual([q3.log.at(-1)!.by, q3.log.at(-1)!.kind, q3.log.at(-1)!.see, r2.log.at(-1)!.op], ['server', 'superseded', { inst: r2.id, label: 'q3-r2' }, 'corrected']);
  assert.match(message(q4, 1, q4.log, true), /Corrections on earlier instances: q3 is wrong, "The rate was a day stale\."; q3 is superseded, "q3-r2 supersedes it", see q3-r2\. New/);
  await settle();
});

