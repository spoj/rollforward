import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { instances, labels, openStore } from '../src/store.ts';
import type { Tree } from '../src/system.ts';

test("migrate-fork copies the fork's root by id, with its talk as threads, numbered afresh, and starting no run", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), old = join(tmp, 'old'), at = '2026-10-30T00:00:00.000Z';
  const write = (rel: string, data: unknown) => {
    mkdirSync(dirname(join(old, rel)), { recursive: true });
    writeFileSync(join(old, rel), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const log = (rel: string, entries: object[]) => write(rel, entries.map((e, i) => JSON.stringify({ seq: i + 1, at, ...e }) + '\n').join(''));
  write('.rf/users.json', { 'ann@x.com': { role: 'admin', name: 'Ann', created: at, sub: 's1' }, 'bo@x.com': { role: 'user', name: 'Bo', created: at } });
  write('.rf/workspaces.json', { Acme: { owner: 'ann@x.com' } });
  write('.rf/session.key', 'k');
  const q = { id: 'q-fx', text: 'Which rate?', options: ['ECB', 'Carry'], default: 1 }, said = { text: 'Carried EUR' };
  const ar = { id: 'ar', name: 'AR aging', kind: 'input', file: 'upload/ar.csv' };
  write('Acme/AR weekly/w1/workspace.json', { rev: 3, status: 'closed', summary: 'built', items: [{ ...ar, notes: [q] }] });
  write('Acme/AR weekly/w1/upload/ar.csv', 'a\n');
  write('Acme/AR weekly/w1/session/s.jsonl', '{}\n');
  log('Acme/AR weekly/w1/log.jsonl', [
    { by: 'ann@x.com', op: 'create', from: null },
    { by: 'ann@x.com', op: 'upload', file: 'upload/ar.csv', pane: 'inputs', onto: null, sha256: 'x' },
    { by: 'server', op: 'run', run: 1, upto: 2 },
    { by: 'agent', op: 'item', item: 'ar', name: 'AR aging', kind: 'input' },
    { by: 'agent', op: 'note', item: 'ar', note: said },
    { by: 'agent', op: 'note', item: 'ar', note: q },
    { by: 'agent', op: 'note', item: 'tmp', note: { id: 'q-tmp', text: 'Keep it?', options: ['Yes', 'No'] } },
    { by: 'agent', op: 'unnote', item: 'ar', note: said },
    { by: 'agent', op: 'remove', item: 'tmp' },
    { by: 'server', op: 'done', run: 1, aborted: false, seen: 2, cost: 0.1, summary: 'built' },
    { by: 'server', op: 'answer', note: 'q-fx', choice: 1, text: 'Carry', default: true },
    { by: 'ann@x.com', op: 'close' },
  ]);
  write('Acme/AR weekly/w2/workspace.json', { rev: 1, status: 'open', items: [{ ...ar, file: null }] });
  log('Acme/AR weekly/w2/log.jsonl', [
    { by: 'ann@x.com', op: 'create', from: 'w1' },
    { by: 'bo@x.com', op: 'steer', text: 'Use the ECB rate' },
    { by: 'server', op: 'run', run: 1, upto: 2 },
    { by: 'agent', op: 'reply', text: 'Will do' },
    { by: 'agent', op: 'note', item: 'ar', note: q },
    { by: 'bo@x.com', op: 'answer', note: 'q-fx', choice: 0, text: 'ECB' },
    { by: 'server', op: 'done', run: 1, aborted: false, seen: 6, cost: 0.1, summary: 'asked' },
    { by: 'server', op: 'run', run: 2, upto: 6 },
  ]);
  write('Acme/Old/.archived', '');
  write('Acme/Old/series.json', { visible_to: [], tools: ['m365'] });

  const migrate = (to: string) => execFileSync(process.execPath, ['scripts/migrate-fork.ts', old, join(tmp, to)], { encoding: 'utf8', stdio: 'pipe' });
  const out = migrate('new');
  assert.match(out, /left in \S+\.rf: session\.key/);
  assert.match(out, /1 workspaces, 3 series with an Ad hoc in each workspace, 2 instances/);
  const root = join(tmp, 'new'), t: Tree = JSON.parse(readFileSync(join(root, '.rf', 'tree.json'), 'utf8'));
  assert.deepEqual(Object.values(t.workspaces), [{ name: 'Acme', owners: ['ann@x.com'], members: [] }]);
  assert.deepEqual(Object.values(t.series).map(s => [s.name, !!s.adhoc, !!s.archived]).sort(), [['AR weekly', false, false], ['Ad hoc', true, false], ['Old', false, true]]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, '.rf', 'users.json'), 'utf8'))), ['ann@x.com', 'bo@x.com']);

  openStore(root);
  const sid = Object.keys(t.series).find(id => t.series[id].name === 'AR weekly')!, [w1, w2] = instances(sid);
  assert.deepEqual(labels(sid).map(l => l.label), ['w1', 'w2']);
  assert.deepEqual(w1.doc, { rev: 3, status: 'closed', items: [ar] });
  assert.equal(statSync(join(w1.dir, 'workspace.json')).mode & 0o777, 0o444);
  assert.equal(readFileSync(join(w1.dir, 'upload', 'ar.csv'), 'utf8'), 'a\n');
  assert.deepEqual(readdirSync(join(w1.dir, 'session')), ['s.jsonl']);
  const brief = (e: Record<string, unknown>) => [e.seq, e.op, e.thread ?? e.upto ?? e.seen ?? e.accepted ?? e.logins ?? null];
  assert.deepEqual(w1.log.map(brief), [
    [1, 'create', []], [2, 'upload', null], [3, 'run', 2], [4, 'item', null], [5, 'comment', 'c5'], [6, 'comment', 'c6'], [7, 'comment', 'c7'],
    [8, 'resolve', 'c5'], [9, 'remove', null], [10, 'resolve', 'c7'], [11, 'done', 2], [12, 'close', ['c6']],
  ]);
  assert.equal(w1.log[5].text, 'Which rate?\na) ECB\nb) Carry (default)');
  assert.equal(w1.log[5].ask, true);

  assert.deepEqual(w2.log.map(e => [...brief(e), e.by]), [
    [1, 'create', [], 'ann@x.com'], [2, 'comment', 'c2', 'bo@x.com'], [3, 'run', 2, 'server'], [4, 'comment', 'c2', 'agent'], [5, 'comment', 'c5', 'agent'],
    [6, 'comment', 'c5', 'bo@x.com'], [7, 'done', 6, 'server'], [8, 'run', 6, 'server'], [9, 'done', 8, 'server'],
  ]);
  assert.deepEqual(w2.asking(), []);
  assert.equal(w2.append('bo@x.com', 'comment', { thread: 'c10', text: 'Thanks' }).seq, 10);

  migrate('again');
  assert.deepEqual(readdirSync(join(tmp, 'again', 'instances')).sort(), readdirSync(join(root, 'instances')).sort());
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'again', '.rf', 'tree.json'), 'utf8')), t);
  assert.throws(() => migrate('new'), /exists: migrate into a new folder/);
  rmSync(tmp, { recursive: true, force: true });
});
