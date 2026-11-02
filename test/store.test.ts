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
  const ask = (who: string) => put([{ ...ar, notes: [{ id: 'q1', text: 'Which?', options: ['a', 'b'], default: 0, ask: who }] }]);
  assert.throws(() => ask('sam'), /question q1's "ask" is a person's email/);
  ask('sam@example.com');
  assert.equal(inst.doc.items[0].notes![0].ask, 'sam@example.com', 'a question may name who answers it');
  put([ar, { id: 'el', name: 'Eligible AR', kind: 'step', file: 'working/eligible.csv', from: ['ar'] }, { id: 'bb', name: 'Borrowing base', kind: 'output', file: null, from: ['el'] }]);
  inst.close('alex');
  assert.deepEqual(createInstance(series, 'w2', 'alex', []).doc.items.map(i => [i.id, i.kind, i.file, i.from]), [['ar', 'input', null, undefined], ['el', 'step', null, ['ar']], ['bb', 'output', null, ['el']]]);
  rmSync(tmp, { recursive: true, force: true });
});
