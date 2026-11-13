import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore, safeName } from '../src/store.ts';
import { commit, forget } from '../src/git.ts';

const alex = { email: 'alex', name: 'Alex' };

test('deleting during a close never restores the instance or writes a close over its tombstone', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'deleted', 'alex', []), gate = Promise.withResolvers<void>();
  const last = commit(inst.dir, alex, 'Last run', gate.promise), closing = inst.close(alex);
  const forgotten = forget(inst.dir);
  inst.markDeleted(alex.email, { cost: 0, runs: [] });
  const refused = assert.rejects(closing, /deleted/);
  gate.resolve();
  await Promise.all([last, forgotten, refused]);
  assert.equal(inst.doc.status, 'deleted');
  assert.deepEqual(inst.log.map(e => e.op), ['delete']);
  rmSync(tmp, { recursive: true, force: true });
});

test("a name is a folder's and a line's: slashes, control characters and line breaks become _, and AGENTS.md, where the view binds instructions, is refused", () => {
  assert.equal(safeName('Bank/rec\\Q1\nlines\u2028\u2029\x85\x7f'), 'Bank_rec_Q1_lines____');
  assert.throws(() => safeName('AGENTS.md'), /AGENTS\.md is the name of the agents' instructions/);
});

test('an upload named attachments takes the next free name, leaving the folder for comment attachments', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex', []), incoming = join(tmp, 'incoming');
  writeFileSync(incoming, 'first');
  const up = inst.upload('alex', 'attachments', incoming, 'hash', 'in', null, true);
  assert.equal(up.file, 'upload/attachments_2');
  assert.equal(inst.doc.items[0].file, up.file);
  assert.equal(readFileSync(join(inst.dir, up.file as string), 'utf8'), 'first');
  assert.equal(statSync(join(inst.dir, up.file as string)).mode & 0o222, 0);
  writeFileSync(incoming, 'comment');
  assert.equal(inst.keep('note.txt', incoming, 'upload/attachments'), 'upload/attachments/note.txt');
  writeFileSync(incoming, 'second');
  assert.equal(inst.upload('alex', 'attachments', incoming, 'hash', 'out', null, true).file, 'upload/attachments_3');
  assert.equal(readFileSync(join(inst.dir, 'upload/attachments/note.txt'), 'utf8'), 'comment');
  rmSync(tmp, { recursive: true, force: true });
});

test('a screen starts empty; a put takes steps and from, which must name items and not go round in a circle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), series = 'weekly';
  openStore(tmp);
  const inst = createInstance(series, 'w1', 'alex', []);
  assert.deepEqual(inst.doc.items, []);
  writeFileSync(join(inst.dir, 'working', 'eligible.csv'), 'a\n');
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }), 1);
  const ar = { id: 'ar', name: 'AR aging', kind: 'input', file: null };
  put([ar, { id: 'el', name: 'Eligible AR', kind: 'step', file: 'working/eligible.csv', from: ['ar'] }, { id: 'bb', name: 'Borrowing base', kind: 'output', file: null, from: ['el'] }]);
  assert.deepEqual(inst.log.filter(e => e.op === 'item').map(e => e.from), [undefined, ['ar'], ['el']]);
  assert.throws(() => put([ar, { id: 'bb', name: 'BB', kind: 'output', file: null, from: ['nope'] }]), /bb: from names no item "nope"/);
  assert.throws(() => put([{ ...ar, from: ['bb'] }, { id: 'bb', name: 'BB', kind: 'output', file: null, from: ['ar'] }]), /circle among ar, bb/);
  rmSync(tmp, { recursive: true, force: true });
});

test("an output's destination is free text, logged as it changes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), series = 'monthly';
  openStore(tmp);
  const inst = createInstance(series, 'm1', 'alex', []);
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }), 1);
  assert.throws(() => put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 3 }]), /pack: destination must be a string/);
  put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 'Mail to ap@demo.test' }]);
  assert.equal(inst.log.findLast(e => e.op === 'item')!.destination, 'Mail to ap@demo.test');
  rmSync(tmp, { recursive: true, force: true });
});

test("an ask from before questions and proposals waits on people until someone replies under it, the agent too, or approves or rejects it, as one from before replies named their parent did until any later word in its thread; closing accepts the ones still waiting", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), sam = 'sam@example.com';
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex', []);
  const ask = (thread: string, more: object = {}) => inst.append('agent', 'comment', { thread, text: 'Which?', ask: true, ...more });
  ask('c2', { item: null, ref: null });
  ask('c3', { item: null, ref: null });
  inst.append(sam, 'comment', { thread: 'c3', parent: 3, text: 'Why?' });
  const deeper = ask('c3', { parent: 4 });
  inst.append(sam, 'comment', { thread: 'c3', parent: 3, text: 'Also this.' });
  ask('c7', { item: null, ref: null });
  inst.append(sam, 'signoff', { thread: 'c7', on: 7, commit: 'x' });
  ask('c9', { item: null, ref: null });
  inst.append('agent', 'comment', { thread: 'c9', parent: 9, text: 'Found it.' });
  inst.append('agent', 'comment', { thread: 'c11', item: null, ref: null, text: 'One-off, or from now on?', ask: true });
  inst.append(sam, 'comment', { thread: 'c11', text: 'From now on.' });
  inst.append('agent', 'comment', { thread: 'c13', item: null, ref: null, text: 'Which file?', ask: true });
  inst.append(sam, 'resolve', { thread: 'c13' });
  ask('c15', { item: null, ref: null });
  inst.append(sam, 'reject', { thread: 'c15', on: 15 });
  assert.deepEqual(inst.asking().map(e => e.seq), [2, deeper.seq], "a reply elsewhere in its thread answers no ask, a reply under it, an approval or a rejection of it, the agent's own word under it and, from before, any later word do");
  await inst.close(alex);
  assert.deepEqual(inst.log.at(-1)!.accepted, ['c2', `c${deeper.seq}`]);
  rmSync(tmp, { recursive: true, force: true });
});
test("a question waits until a person replies under it, a proposal until someone approves or rejects it, and either until the agent withdraws it", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), sam = 'sam@example.com';
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex', []);
  const ask = (kind: string) => inst.append('agent', 'comment', { thread: `c${inst.log.length + 1}`, item: null, ref: null, text: 'Which?', ask: kind });
  const q1 = ask('question'), q2 = ask('question'), q3 = ask('question'), p1 = ask('proposal'), p2 = ask('proposal'), p3 = ask('proposal'), p4 = ask('proposal');
  inst.append('agent', 'comment', { thread: q1.thread, parent: q1.seq, text: 'Never mind.' });
  inst.append(sam, 'comment', { thread: q2.thread, parent: q2.seq, text: 'This one.' });
  inst.append('agent', 'withdraw', { thread: q3.thread, on: q3.seq, text: 'Found it.' });
  inst.append(sam, 'comment', { thread: p1.thread, parent: p1.seq, text: 'Go ahead.' });
  inst.append(sam, 'signoff', { thread: p2.thread, on: p2.seq, commit: 'x' });
  inst.append(sam, 'reject', { thread: p3.thread, on: p3.seq, text: 'Not yet.' });
  inst.append('agent', 'withdraw', { thread: p4.thread, on: p4.seq, text: 'Sent by hand.', see: p1.seq });
  assert.deepEqual(inst.asking().map(e => e.seq), [q1.seq, p1.seq], "the agent's own word under a question, and a reply under a proposal, however worded, answer neither");
  rmSync(tmp, { recursive: true, force: true });
});
test("a file the screen shows stays the agent's to change, and closing takes it as it is", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex', []), page = join(inst.dir, 'working', 'a1.md');
  writeFileSync(page, 'a1 is right\n');
  inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items: [{ id: 'a1', name: 'A1', kind: 'step', file: 'working/a1.md' }] }), 1);
  assert.deepEqual(inst.log.filter(e => e.op === 'point').map(e => [e.item, e.file, e.was]), [['a1', 'working/a1.md', null]]);
  writeFileSync(page, 'changed\n');
  await inst.close(alex);
  assert.equal(inst.doc.status, 'closed');
  rmSync(tmp, { recursive: true, force: true });
});

test('a close whose commit succeeds but packing fails leaves the instance open, with no close entry, and can be retried', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'pack-fails', 'alex', []);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inst.dir });
  const lock = join(inst.dir, '.git', 'gc.pid');
  writeFileSync(lock, `${process.pid} ${hostname()}`);
  await assert.rejects(inst.close(alex), /gc is already running/);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: inst.dir, encoding: 'utf8' }).trim(), 'Close pack-fails', 'the commit succeeded');
  assert.deepEqual([inst.doc.status, JSON.parse(readFileSync(join(inst.dir, 'screen.json'), 'utf8')).status, inst.log.at(-1)!.op], ['open', 'open', 'create']);
  rmSync(lock);
  await inst.close(alex);
  assert.deepEqual([inst.doc.status, JSON.parse(readFileSync(join(inst.dir, 'screen.json'), 'utf8')).status, inst.log.at(-1)!.op], ['closed', 'closed', 'close']);
  rmSync(tmp, { recursive: true, force: true });
});

test("closing commits the folder in the runner's name, files and folders a run made unreadable made readable again; a commit that fails leaves it open", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'm1', 'alex', []), locked = join(inst.dir, 'working', 'locked.csv'), shut = join(inst.dir, 'working', 'shut');
  writeFileSync(locked, 'x\n');
  mkdirSync(shut);
  writeFileSync(join(shut, 'in.csv'), 'y\n');
  chmodSync(locked, 0);
  chmodSync(shut, 0o200);
  writeFileSync(join(inst.dir, '.git'), 'not a repository\n');
  await assert.rejects(inst.close(alex), /git fast-import failed/);
  assert.deepEqual([inst.doc.status, JSON.parse(readFileSync(join(inst.dir, 'screen.json'), 'utf8')).status, inst.log.at(-1)!.op], ['open', 'open', 'create']);
  rmSync(join(inst.dir, '.git'));
  await inst.close(alex);
  assert.deepEqual([statSync(locked).mode & 0o777, statSync(shut).mode & 0o777], [0o400, 0o700]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: inst.dir, encoding: 'utf8' }).trim();
  assert.equal(inst.log.at(-1)!.commit, git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%B'), 'Alex <alex>\nClose m1');
  assert.deepEqual([git('show', 'HEAD:working/locked.csv'), git('show', 'HEAD:working/shut/in.csv')], ['x', 'y']);
  assert.match(git('count-objects', '-v'), /^count: 0\n[^]*^packs: 1$/m, 'closed, its history is one pack');
  rmSync(tmp, { recursive: true, force: true });
});
