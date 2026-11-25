import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { eventsFile, jsonLines, messagesAt, messagesFile } from '../src/message-store.ts';
import { saveSeriesSettings } from '../src/series.ts';
import { createInstance, openStore, renameInstance, seriesDir } from '../src/store.ts';
import { initSystem, readJson, saveTree, writeJson } from '../src/system.ts';
import { dropRequest, fire, remove, setWake, wakes, type Wake } from '../src/waker.ts';

const by = 'person@example.test', at = '2026-01-01T00:00:00.000Z';
const schedule = { at, from: 'Origin/Author', text: 'Synthetic request text' };
type State = { pending: Record<string, Wake>; fired: Record<string, string>; requests: Record<string, { series: string; label: string; inst?: string; target?: string; message: number }> };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rf-wake-requests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Workspace', owners: [], members: [] } },
    series: { origin: { name: 'Origin', workspace: 'w' }, target: { name: 'Target', workspace: 'w' } } });
  for (const id of ['origin', 'target']) saveSeriesSettings(seriesDir(id), { version: 1, epoch: 0, since: '' });
  return root;
}

const state = () => readJson<State>('wakes.json', { pending: {}, fired: {}, requests: {} });

test('request provenance is canonical and survives a restart, while cross-series wakes are rejected', t => {
  const root = fixture(t), other = createInstance('origin', 'Author', by), source = createInstance('target', 'Author', by), target = createInstance('target', 'Existing', by);
  assert.throws(() => setWake(target.id, { ...schedule, inst: other.id }), /another series: runs can only wake their own series/);
  assert.throws(() => setWake('target', { ...schedule, inst: other.id, label: 'Next' }), /another series: runs can only wake their own series/);
  const targeted = setWake(target.id, { ...schedule, inst: source.id }).id;
  const floating = setWake('target', { ...schedule, inst: source.id, label: 'Next' }).id;
  fire();
  const saved = state(), book = seriesDir('target');
  assert.deepEqual(Object.keys(saved.requests).sort(), [targeted, floating].sort());
  assert.doesNotMatch(readFileSync(join(root, '.rf/wakes.json'), 'utf8'), /Synthetic request text|Origin\/Author/);
  openStore(root);
  for (const [id, label, to] of [[targeted, 'Existing', target.id], [floating, 'Next', undefined]] as const) {
    const row = messagesAt(book).find(m => m.id === saved.requests[id].message)!;
    assert.deepEqual(row.anchor, to ? { instance: to } : {});
    assert.equal(row.entry.requestId, id);
    assert.equal(row.entry.source, source.id);
    assert.equal(row.entry.label, label);
    assert.deepEqual({ ...wakes().requests[id] }, { ...saved.requests[id], from: schedule.from, at: row.entry.at, text: schedule.text });
  }
});

test('only the exact saved decision excuses a missing request row after restart', t => {
  const root = fixture(t), book = seriesDir('target');
  const { id } = setWake('target', { ...schedule, label: 'Next' });
  fire();
  const saved = state(), ref = saved.requests[id];
  dropRequest(id, by, 'dismissed');
  const decision = messagesAt(book).find(m => m.entry.op === 'request-decision')!;
  assert.equal(decision.entry.request, ref.message);
  writeFileSync(messagesFile(book), jsonLines([decision]));
  writeJson('wakes.json', saved);
  openStore(root);
  assert.deepEqual(Object.keys(wakes().requests), []);
  assert.equal(state().requests[id].message, ref.message, 'reads do not rewrite scheduler state');
  for (const bad of [{ ...ref, message: decision.id + 1 }, { series: ref.series, label: ref.label, from: by, at }]) {
    writeJson('wakes.json', { ...saved, requests: { [id]: bad } });
    assert.throws(wakes, /invalid wake request reference/);
  }
});

test('deleting a source clears its request bodies with or without scheduler references', async t => {
  const root = fixture(t), source = createInstance('target', 'Author', by), dest = createInstance('target', 'Existing', by);
  const decided = setWake(dest.id, { ...schedule, inst: source.id }).id;
  const waiting = setWake('target', { ...schedule, inst: source.id, label: 'Next' }).id;
  const unrelated = setWake('target', { at, from: 'person', label: 'Next' }).id;
  fire();
  dropRequest(decided, by, 'dismissed');
  const stale = state(), later = setWake('target', { ...schedule, inst: source.id, label: 'Not fired yet' }).id;
  await remove(source, by, () => ({}));
  assert.deepEqual(Object.keys(state().requests), [unrelated]);
  assert.ok(state().pending[later], 'source deletion does not change a pending wake timer');
  fire();
  assert.deepEqual(Object.keys(state().requests), [unrelated]);
  assert.deepEqual(messagesAt(seriesDir('target')).map(m => m.entry.requestId), [unrelated], 'no request bodies survive or get recreated');
  writeJson('wakes.json', stale);
  openStore(root);
  assert.deepEqual(Object.keys(wakes().requests), [unrelated]);
});

test('restart finishes purging the target ID and label, not an unrelated explicit target with that old label', t => {
  const root = fixture(t), book = seriesDir('target'), old = createInstance('target', 'Period', by);
  const explicitOld = setWake(old.id, schedule).id;
  const floating = setWake('target', { ...schedule, label: 'Period' }).id;
  fire();
  renameInstance(old, 'Revised');
  const target = createInstance('target', 'Period', by), explicitTarget = setWake(target.id, schedule).id;
  fire();
  const saved = state(), slot = saved.requests[floating];
  assert.ok(saved.requests[explicitTarget]);
  delete saved.requests[floating];
  writeJson('wakes.json', saved);
  writeFileSync(eventsFile(book, target.id), jsonLines([{ seq: 2, at, by, op: 'delete' }]));
  openStore(root);
  assert.deepEqual(messagesAt(book).map(m => m.entry.requestId), [explicitOld]);
  assert.deepEqual(Object.keys(wakes().requests), [explicitOld]);
  writeJson('wakes.json', { ...saved, requests: { ...saved.requests, [floating]: slot } });
  assert.deepEqual(Object.keys(wakes().requests), [explicitOld]);
  writeJson('wakes.json', { ...saved, requests: { [explicitOld]: { ...saved.requests[explicitOld], label: 'Wrong' } } });
  assert.throws(wakes, /invalid wake request reference/);
});
