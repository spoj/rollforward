import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, instance, labels, openStore, seriesDir } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';

process.env.RF_MAX_RUNS = '0';
process.env.RF_MIN_FREE_GB = '0';
delete process.env.OPENROUTER_API_KEY;
const { assigned, message, setWake, standing, startWaking, startWith, wakes } = await import('../src/waker.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-wake-assignment-')), alice = 'alice@demo.test', bob = 'bob@demo.test';
initSystem(tmp);
openStore(tmp);
writeJson('users.json', { [alice]: { role: 'user' }, [bob]: { role: 'user' } });
const series: Record<string, { name: string; workspace: string }> = {};
let n = 0;
function seriesOf(shared: boolean) {
  const id = `s${++n}`;
  series[id] = { name: id, workspace: 'w' };
  saveTree({ workspaces: { w: { name: 'Acme', owners: [alice], members: [bob] } }, series });
  mkdirSync(seriesDir(id), { recursive: true });
  if (shared) writeFileSync(join(seriesDir(id), 'series.json'), JSON.stringify({ shared: { by: alice, since: '', logins: [] } }));
  return id;
}
const today = new Date(2026, 10, 16, 8), tomorrow = new Date(2026, 10, 17, 8), later = new Date(2026, 10, 18, 8);
function scheduler(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: today });
  let tick: () => void;
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return { unref() { return this; } }; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden in this fixture'); });
  return () => tick();
}
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a shared auto-next-instance wake keeps its source-assigned text a note', t => {
  scheduler(t);
  const sid = seriesOf(true), source = createInstance(sid, 'source', bob, []);
  setWake(sid, { at: today.toISOString(), label: 'next', from: `Acme/${sid}/source`, inst: source.id, text: 'Original source instruction.' });
  source.append(bob, 'assign', { from: bob, to: alice, logins: [] });
  assigned(source);
  startWaking();
  const next = instance(labels(sid).find(l => l.label === 'next')!.id), e = next.log.find(e => e.op === 'wake')!;
  assert.equal(e.text, 'Original source instruction.');
  assert.equal(e.note, true);
  assert.deepEqual(standing(next, e), { word: 'note', starts: true });
});

for (const queuedFirst of [false, true]) for (const shared of [false, true]) {
  test(`a new-label request preserves source assignment through Start, queuedFirst=${queuedFirst}, shared=${shared}`, t => {
    scheduler(t);
    const sid = seriesOf(shared), source = createInstance(sid, 'source', bob, []);
    if (shared) for (const label of ['other', 'third']) createInstance(sid, label, alice, []);
    setWake(sid, { at: today.toISOString(), label: 'next', from: `Acme/${sid}/source`, inst: source.id, text: 'Original source instruction.' });
    if (queuedFirst) startWaking();
    source.append(bob, 'assign', { from: bob, to: alice, logins: [] });
    assigned(source);
    if (!queuedFirst) startWaking();
    const r = Object.values(wakes().requests).find(r => r.series === sid)!;
    assert.equal(r.assigned, true);
    if (shared) source.doc.status = 'closed';
    const next = startWith(r.series, r.label, alice, [], [{ from: r.from, text: r.text, inst: r.inst, assigned: r.assigned }, { from: alice }]);
    const [original, starter] = next.log.filter(e => e.op === 'wake');
    assert.equal(original.text, 'Original source instruction.');
    assert.equal(original.note, true);
    assert.deepEqual(standing(next, original), { word: 'note', starts: shared });
    assert.deepEqual(standing(next, starter), { word: 'runner', starts: true });
  });
}

for (const shared of [false, true]) for (const agent of [false, true]) {
  test(`target assignment invalidates only its recurring occurrence, shared=${shared}, agent=${agent}`, t => {
    const tick = scheduler(t), sid = seriesOf(shared), current = createInstance(sid, 'BB 2026-11-16', alice, []);
    const source = agent ? createInstance(sid, 'source', alice, []) : undefined;
    const { id } = setWake(sid, { at: today.toISOString(), label: current.label, days: ['mon', 'tue', 'wed'], from: source ? `Acme/${sid}/source` : alice, inst: source?.id });
    current.append(alice, 'assign', { from: alice, to: bob, logins: [] });
    assigned(current);
    current.append(bob, 'assign', { from: bob, to: alice, logins: [] });
    assigned(current);
    assert.match(message(current, 1, [], true), /, a note/);
    startWaking();
    if (shared) assert.deepEqual(standing(current, current.log.find(e => e.op === 'wake')!), { word: 'note', starts: true });
    else assert.equal(Object.values(wakes().requests).filter(r => r.target === current.id).length, 1);
    for (const date of [tomorrow, later]) {
      const pending = wakes().pending[id], next = createInstance(sid, pending.label!, alice, []);
      assert.equal(pending.assigned, undefined);
      assert.equal(setWake(sid, { at: date.toISOString(), label: next.label, from: alice }).id, id, 'one-off does not replace the recurrence');
      assert.doesNotMatch(message(next, 1, [], true), /, a note/);
      t.mock.timers.setTime(date.getTime());
      tick();
      assert.deepEqual(standing(next, next.log.find(e => e.op === 'wake')!), { word: 'runner', starts: true });
      assert.equal(Object.values(wakes().requests).filter(r => r.target === next.id).length, 0);
    }
  });
}

test('a target assignment leaves an unrelated one-off label and unknown stored fields unchanged', t => {
  const tick = scheduler(t), sid = seriesOf(false), current = createInstance(sid, 'current', alice, []);
  const next = createInstance(sid, 'next', alice, []);
  const matching = setWake(sid, { at: today.toISOString(), label: current.label, from: alice });
  const future = setWake(sid, { at: tomorrow.toISOString(), label: next.label, from: alice, text: 'Unrelated future word.' });
  const w = wakes(), record = { ...w.pending[future.id], unknownField: { kept: true } };
  w.pending[future.id] = record;
  writeJson('wakes.json', w);
  const stored = wakes().pending[future.id];
  current.append(alice, 'assign', { from: alice, to: bob, logins: [] });
  assigned(current);
  current.append(bob, 'assign', { from: bob, to: alice, logins: [] });
  assigned(current);
  assert.deepEqual(wakes().pending[future.id], stored);
  startWaking();
  assert.equal(wakes().pending[matching.id], undefined);
  assert.equal(Object.values(wakes().requests).filter(r => r.target === current.id).length, 1);
  assert.doesNotMatch(message(next, 1, [], true), /, a note/);
  t.mock.timers.setTime(tomorrow.getTime());
  tick();
  assert.deepEqual(standing(next, next.log.find(e => e.op === 'wake')!), { word: 'runner', starts: true });
});

test('source assignment still invalidates all future occurrences of its recurring wake', t => {
  const tick = scheduler(t), sid = seriesOf(false), source = createInstance(sid, 'source', bob, []);
  const current = createInstance(sid, 'BB 2026-11-16', alice, []);
  const { id } = setWake(sid, { at: today.toISOString(), label: current.label, days: ['mon', 'tue', 'wed'], from: `Acme/${sid}/source`, inst: source.id });
  source.append(bob, 'assign', { from: bob, to: alice, logins: [] });
  assigned(source);
  startWaking();
  for (const date of [tomorrow, later]) {
    const next = createInstance(sid, wakes().pending[id].label!, alice, []);
    assert.equal(wakes().pending[id].assigned, true);
    assert.match(message(next, 1, [], true), /, a note/);
    t.mock.timers.setTime(date.getTime());
    tick();
    assert.equal(next.log.some(e => e.op === 'wake'), false);
    assert.equal(Object.values(wakes().requests).filter(r => r.target === next.id).length, 1);
  }
});
