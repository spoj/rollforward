import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answered, answers, binds, conversation, messageAuthority, notices, openNotes, waitsOn } from '../src/messages.ts';
import type { Entry } from '../src/store.ts';

const at = '2026-10-01T00:00:00Z';
const owner = 'owner@example.test', named = 'named@example.test', other = 'other@example.test';
const current = { by: owner, epoch: 8, workspace: 'workspace' };
const stamp = { authorityOwner: owner, authorityEpoch: current.epoch };
const entry = (seq: number, by: string, op: string, fields: object = {}): Entry => ({ seq, at, by, op, ...fields });
const person = (seq: number, by: string, fields: object = {}) => entry(seq, by, 'comment', { thread: 'c2', ...stamp, ...fields });
const instance = (log: Entry[]) => ({ id: 'period', label: 'October', log, copied: 0, hole: false, doc: { status: 'open' as const } });
const authority = (seq: number, epoch: number) => entry(seq, 'server', 'authority', { owner, epoch, workspace: current.workspace });

for (const explicit of [true, false]) test(`only the named reply consumes a named question (${explicit ? 'parent' : 'legacy thread'})`, () => {
  const ask = entry(2, 'agent', 'comment', { thread: 'c2', ask: 'question', to: named, ...stamp });
  const link = explicit ? { parent: ask.seq } : {};
  const wrong = person(3, other, { ...link, ...(explicit && { informs: true }) });
  const inst = instance([authority(1, 8), ask, wrong]);
  const waiting = () => waitsOn(inst, owner, 0, 0, current).map(({ who, e }) => [who, e.seq]);
  assert.equal(answered(inst.log, ask), false);
  assert.equal(answers(inst, wrong, current), undefined);
  assert.equal(binds(inst, wrong, owner, current), 'note');
  assert.deepEqual(waiting(), [[named, ask.seq]]);
  const correct = person(4, named, { ...link, quiet: true });
  inst.log.push(correct);
  assert.equal(answered(inst.log, ask), true);
  assert.equal(answers(inst, correct, current), ask);
  assert.equal(binds(inst, correct, owner, current), 'answer');
  assert.deepEqual(waiting(), [[owner, correct.seq]], 'the quiet named answer remains unread for the owner');
});

test('an unstamped, unaddressed question waits for the owner recorded at reply time', () => {
  const ask = entry(2, 'agent', 'comment', { thread: 'c2', ask: 'question' });
  const wrong = person(3, other, { parent: ask.seq });
  const correct = person(4, owner, { parent: ask.seq });
  const inst = instance([authority(1, 8), ask, wrong, correct]);
  assert.equal(answered(inst.log, ask, wrong.seq), false);
  assert.equal(answers(inst, wrong), undefined);
  assert.equal(answered(inst.log, ask), true);
  assert.equal(answers(inst, correct), ask);
  assert.equal(binds(inst, correct, owner, current), 'runner');
  inst.log.push(entry(5, 'server', 'authority', { owner: other, epoch: 9, workspace: 'destination' }));
  assert.equal(answered(inst.log, ask), true, 'a later transfer does not erase a valid earlier answer');
});

for (const source of ['run', 'boundary', 'run conflicting with stamp', 'run without a later boundary']) test(`stale migrated proposal cannot bind or wait: ${source}`, () => {
  const run = entry(1, 'server', 'run', { run: 1, runner: owner,
    authority: { version: 1, owner, epoch: 7, workspace: current.workspace, logins: [] } });
  const ask = entry(2, 'agent', 'comment', { thread: 'c2', ask: 'proposal', to: named,
    ...(source !== 'boundary' && { run: 1 }), ...(source === 'run conflicting with stamp' && stamp) });
  const inst = instance([source === 'boundary' ? authority(1, 7) : run, ask]);
  if (source !== 'run without a later boundary') inst.log.push(authority(3, 8));
  const decision = entry(inst.log.length + 1, named, 'signoff', { thread: 'c2', on: ask.seq, ...stamp });
  const proof = messageAuthority(inst.log, ask);
  assert.equal(proof.stale, source !== 'run without a later boundary');
  if (!proof.stale) assert.equal(proof.epoch, 7);
  assert.deepEqual(waitsOn(inst, owner, 0, 0, current), []);
  assert.equal(answers(inst, decision, current), undefined);
  assert.equal(binds(inst, decision, owner, current), 'note');
  assert.equal(binds(inst, { ...decision, by: owner }, owner, current), 'note');
});

for (const askKind of ['proposal', true] as const) test(`legacy ${askKind === true ? 'undifferentiated ask' : 'proposal'} without authority cannot authorize work across a transfer`, () => {
  const run = entry(1, 'server', 'run', { run: 1, runner: other });
  const ask = entry(2, 'agent', 'comment', { thread: 'c2', ask: askKind, to: named, run: 1 });
  const decision = entry(4, named, 'signoff', { thread: 'c2', on: ask.seq, ...stamp });
  const inst = instance([run, ask, authority(3, 8)]);
  assert.deepEqual(waitsOn(inst, owner, 0, 0, current), [], 'history is not an active approval');
  inst.log.push(decision);
  assert.equal(answers(inst, decision, current), undefined);
  assert.equal(binds(inst, decision, owner, current), 'note');
});

test('advanced series authority retires unstamped approvals even without an instance boundary', () => {
  const ask = entry(2, 'agent', 'comment', { thread: 'c2', ask: 'proposal', to: named });
  const decision = entry(3, named, 'signoff', { thread: 'c2', on: 2, ...stamp });
  const inst = instance([entry(1, owner, 'create'), ask]);
  assert.deepEqual(waitsOn(inst, owner, 0, 0, current), []);
  inst.log.push(decision);
  assert.equal(binds(inst, decision, owner, current), 'note');
});

test('a legacy named question with no series authority proof can still be answered after transfer', () => {
  const run = entry(1, 'server', 'run', { run: 1, runner: other });
  const ask = entry(2, 'agent', 'comment', { thread: 'c2', ask: 'question', to: named, run: 1 });
  const reply = person(4, named, { parent: ask.seq });
  const inst = instance([run, ask, authority(3, 8), reply]);
  assert.deepEqual(messageAuthority(inst.log, ask), { stale: false });
  assert.equal(answered(inst.log, ask), true);
  assert.equal(answers(inst, reply, current), ask);
  assert.equal(binds(inst, reply, owner, current), 'answer');
});

test('ordinary proposals can still be decided by a colleague, without giving an unnamed colleague execution standing', () => {
  const ask = entry(2, 'agent', 'comment', { ask: 'proposal', thread: 'c2', ...stamp });
  const reply = person(3, other, { parent: ask.seq });
  const decision = entry(4, other, 'reject', { thread: 'c2', on: ask.seq, ...stamp });
  const inst = instance([authority(1, 8), ask, reply, decision]);
  assert.equal(answered(inst.log, ask, reply.seq), false);
  assert.equal(answered(inst.log, ask), true);
  assert.equal(binds(inst, decision, owner, current), 'note');
});

for (const how of ['taken', 'aside']) test(`an unlinked note-verdict preserves a ${how} request after its deciding instance is gone`, () => {
  const note = entry(1, named, 'note', { text: 'A request', request: true });
  const sibling = entry(2, named, 'note', { text: 'Sibling advice' });
  const verdict = entry(1, owner, 'note-verdict', { on: 1, how });
  const rows = [{ anchor: {}, entry: note }, { anchor: {}, entry: sibling }, { anchor: {}, entry: verdict }];
  const { notes, dismissed } = conversation(rows, [], 9);
  const text = how === 'taken' ? 'The owner approved the proposal.' : 'The owner rejected the proposal.';
  assert.deepEqual(openNotes(notes).map(n => n.id), ['n2']);
  assert.deepEqual(notes[0].settled, { seq: 1, at, by: owner, op: how, text });
  assert.deepEqual(notices(notes, dismissed, named, owner, 'Series').map(({ id, kind, text }) => [id, kind, text]), [['n1', 'settled', text]]);
});
