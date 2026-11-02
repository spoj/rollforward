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
const { closed, recover, setWake, startWaking, wakeFrom, wakes } = await import('../src/waker.ts');
const { saveLogin } = await import('../src/logins.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-wake-')), alice = 'alice@demo.test';
initSystem(tmp);
openStore(tmp);
saveTree({
  workspaces: { w: { name: 'Acme', owners: [alice], members: [] }, x: { name: 'Hidden', owners: ['zed@demo.test'], members: [] }, m: { name: 'Main', owners: [alice, 'zed@demo.test'], members: [] } },
  series: {
    s1: { name: 'Bank rec', workspace: 'w' }, s2: { name: 'Borrowing base', workspace: 'w' }, s3: { name: 'Payroll', workspace: 'x' },
    s4: { name: 'Ad hoc', workspace: 'w', adhoc: true }, s5: { name: 'Close', workspace: 'm' }, s6: { name: 'Queue', workspace: 'w' },
  },
});
writeJson('users.json', { [alice]: { role: 'user' } });
for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) mkdirSync(join(tmp, 'series', s), { recursive: true });
const make = (series: string, label: string, status?: 'close') => {
  const i = createInstance(series, label, alice, []);
  if (status) i.close(alice);
  return i;
};
const aug = make('s1', '2026-08', 'close'), sep = make('s1', '2026-09'), oct = make('s1', '2026-10');
const run = { inst: sep, view: { cwd: '/work/Acme/Bank rec' } } as unknown as Active;
const ops = (i: Instance) => i.log.map(e => e.op);
const settle = () => new Promise(r => setTimeout(r, 2000));
startWaking();

after(() => rmSync(tmp, { recursive: true, force: true }));

test('rf wake names its target as the run sees it, within its reach, and refuses what it cannot wake', () => {
  assert.throws(() => wakeFrom(run, ['now']), /rf wake TARGET AT REASON/);
  assert.throws(() => wakeFrom(run, ['2026-09', 'soon', 'why']), /AT now/);
  assert.throws(() => wakeFrom(run, ['2026-08', 'now', 'redo']), /2026-08 is closed: to correct it, wake its series with --label 2026-08-r2/);
  assert.throws(() => wakeFrom(run, ['.', 'now', 'next month']), /name it with --label/);
  assert.throws(() => wakeFrom(run, ['../../Hidden/Payroll', 'now', 'x', '--label', 'y']), /no series you can read/);
  assert.throws(() => wakeFrom(run, ['../../../x/Acme/Bank rec', 'now', 'x', '--label', 'y']), /no series you can read/);
  assert.match(wakeFrom(run, ['2026-10', '+2h', 'the', 'bank', 'file', 'is', 'late']), /2026-10 wakes at/);
  assert.equal(wakes().pending[oct.id].reason, 'the bank file is late');
  assert.equal(wakes().pending[oct.id].from, 'Acme/Bank rec/2026-09');
  assert.match(wakeFrom(run, ['../Borrowing base', '2026-11-02T07:00+08:00', 'rec done', '--label', '2026-10']), /starts 2026-10 at 2026-11-01T23:00:00.000Z/);
  assert.throws(() => wakeFrom(run, ['../../Main/Close', 'now', 'x', '--label', 'y']), /in another workspace: you can read it, not wake it/);
});

test('a due wake continues an open instance, as a reply does; one more than 15 minutes after its last is moved', async () => {
  setWake(oct.id, { at: new Date().toISOString(), reason: 'statement arrived', from: 'Acme/Bank rec/2026-09' });
  await settle();
  assert.deepEqual(oct.log.filter(e => e.op === 'wake').map(e => [e.reason, e.from]), [['statement arrived', 'Acme/Bank rec/2026-09']]);
  assert.ok(ops(oct).includes('run'), 'it started a run');
  assert.equal(wakes().pending[oct.id], undefined);
  const next = setWake(oct.id, { at: new Date().toISOString(), reason: 'again', from: 'x' });
  assert.ok(Date.parse(next.at) - Date.parse(wakes().fired[oct.id]) >= 15 * 60_000);
});

test("a series' wake starts an instance as whoever allowed wakes; without Allow wakes, or with 3 open, it's a request", async () => {
  setWake('s2', { at: new Date().toISOString(), reason: 'rec done', from: 'Acme/Bank rec/2026-09', label: '2026-10' });
  await settle();
  assert.deepEqual(Object.values(wakes().requests).map(r => [r.series, r.label, r.reason]), [['s2', '2026-10', 'rec done']]);
  assert.equal(labels('s2').length, 0);

  writeFileSync(join(tmp, 'series', 's2', 'series.json'), JSON.stringify({ skills: [], wakes: { by: alice, since: new Date().toISOString(), logins: [] } }));
  writeJson('wakes.json', { ...readJson('wakes.json', {}), fired: {} });
  setWake('s2', { at: new Date().toISOString(), reason: 'rec done', from: 'Acme/Bank rec/2026-09', label: '2026-11' });
  await settle();
  const made = instance(labels('s2').find(l => l.label === '2026-11')!.id);
  assert.deepEqual([made.log[0].op, made.log[0].by, made.log[1].op, made.log[1].reason], ['create', alice, 'wake', 'rec done']);

  make('s2', '2026-12');
  make('s2', '2027-01');
  writeJson('wakes.json', { ...readJson('wakes.json', {}), fired: {} });
  setWake('s2', { at: new Date().toISOString(), reason: 'next', from: 'x', label: '2027-02' });
  await settle();
  assert.ok(Object.values(wakes().requests).some(r => r.label === '2027-02'), '3 open already');
});

test('closing an instance wakes the later open ones of its series, not the earlier', async () => {
  const before = make('s1', '2026-07');
  sep.close(alice);
  closed(sep);
  await settle();
  assert.match(oct.log.findLast(e => e.op === 'wake')!.reason as string, /^2026-09 closed/);
  assert.ok(!ops(before).includes('wake'));
});

test('a run a restart cut ends as aborted, and its instance is woken to carry on', async () => {
  const cut = make('s3', 'cut');
  cut.append('server', 'run', { run: 1, upto: 1 });
  recover();
  assert.deepEqual(cut.log.slice(-2).map(e => [e.op, e.error ?? e.reason]), [['done', 'a restart cut the run'], ['wake', 'A restart cut your last run; carry on']]);
  await settle();
  assert.equal(cut.log.filter(e => e.op === 'run').length, 2, 'started again');
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

test('closing an Ad hoc instance wakes no other; a wake in an archived workspace is dropped', async () => {
  const first = make('s4', 'ask 1'), second = make('s4', 'ask 2');
  first.close(alice);
  closed(first);
  assert.ok(!ops(second).includes('wake'));
  const t = tree(), cut = instance(labels('s3').find(l => l.label === 'cut')!.id);
  saveTree({ ...t, workspaces: { ...t.workspaces, x: { ...t.workspaces.x, archived: true } } });
  setWake(cut.id, { at: new Date().toISOString(), reason: 'archived', from: 'x' });
  await settle();
  assert.equal(wakes().pending[cut.id], undefined);
  assert.ok(!cut.log.some(e => e.reason === 'archived'));
});
