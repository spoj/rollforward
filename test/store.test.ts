import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';

test('a put takes steps and from, and a new instance carries the graph; from must name items and not go round in a circle', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), series = 'weekly';
  openStore(tmp);
  const inst = createInstance(series, 'w1', 'alex', []);
  writeFileSync(join(inst.dir, 'working', 'eligible.csv'), 'a\n');
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }));
  const ar = { id: 'ar', name: 'AR aging', kind: 'input', file: null };
  put([ar, { id: 'el', name: 'Eligible AR', kind: 'step', file: 'working/eligible.csv', from: ['ar'] }, { id: 'bb', name: 'Borrowing base', kind: 'output', file: null, from: ['el'] }]);
  assert.deepEqual(inst.log.filter(e => e.op === 'item').map(e => e.from), [undefined, ['ar'], ['el']]);
  assert.throws(() => put([ar, { id: 'bb', name: 'BB', kind: 'output', file: null, from: ['nope'] }]), /bb: from names no item "nope"/);
  assert.throws(() => put([{ ...ar, from: ['bb'] }, { id: 'bb', name: 'BB', kind: 'output', file: null, from: ['ar'] }]), /circle among ar, bb/);
  put([ar, { id: 'el', name: 'Eligible AR', kind: 'step', file: 'working/eligible.csv', from: ['ar'] }, { id: 'bb', name: 'Borrowing base', kind: 'output', file: null, from: ['el'] }]);
  inst.close('alex');
  assert.deepEqual(createInstance(series, 'w2', 'alex', []).doc.items.map(i => [i.id, i.kind, i.file, i.from]), [['ar', 'input', null, undefined], ['el', 'step', null, ['ar']], ['bb', 'output', null, ['el']]]);
  rmSync(tmp, { recursive: true, force: true });
});

test("an output's destination is free text, logged as it changes and carried to the next instance", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), series = 'monthly';
  openStore(tmp);
  const inst = createInstance(series, 'm1', 'alex', []);
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }));
  assert.throws(() => put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 3 }]), /pack: destination must be a string/);
  put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 'Mail to ap@demo.test' }]);
  assert.equal(inst.log.findLast(e => e.op === 'item')!.destination, 'Mail to ap@demo.test');
  inst.close('alex');
  assert.equal(createInstance(series, 'm2', 'alex', []).doc.items[0].destination, 'Mail to ap@demo.test');
  rmSync(tmp, { recursive: true, force: true });
});

test("an ask waits on people until someone replies or resolves it, and closing accepts the ones still waiting", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), sam = 'sam@example.com';
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex', []);
  inst.append('agent', 'comment', { thread: 'c1', item: null, ref: null, text: 'The snapshot is a week old; I used it.', ask: true });
  inst.append('agent', 'comment', { thread: 'c2', item: null, ref: null, text: 'Carried the rate from w0.' });
  inst.append('agent', 'comment', { thread: 'c3', item: null, ref: null, text: 'One-off, or from now on?', ask: true, to: sam });
  inst.append(sam, 'comment', { thread: 'c3', text: 'From now on.' });
  inst.append('agent', 'comment', { thread: 'c4', item: null, ref: null, text: 'Which file is right?', ask: true });
  inst.append(sam, 'resolve', { thread: 'c4' });
  assert.deepEqual(inst.asking().map(e => e.thread), ['c1']);
  inst.close('alex');
  assert.deepEqual(inst.log.at(-1)!.accepted, ['c1']);
  rmSync(tmp, { recursive: true, force: true });
});
