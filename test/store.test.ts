import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, instance, openStore, safeName } from '../src/store.ts';

const alex = { email: 'alex', name: 'Alex' };

test("a name is a folder's and a line's: slashes, control characters and line breaks become _, and AGENTS.md, where the view binds instructions, is refused", () => {
  assert.equal(safeName('Bank/rec\\Q1\nlines\u2028\u2029\x85\x7f'), 'Bank_rec_Q1_lines____');
  assert.throws(() => safeName('AGENTS.md'), /AGENTS\.md is the name of the agents' instructions/);
});

test("an instance's screen kept as workspace.json, as before v0.2.44, is screen.json from the start", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), inst = (openStore(tmp), createInstance('weekly', 'w1', 'alex', []));
  renameSync(join(inst.dir, 'screen.json'), join(inst.dir, 'workspace.json'));
  openStore(tmp);
  assert.deepEqual([existsSync(join(inst.dir, 'workspace.json')), instance(inst.id).doc], [false, inst.doc]);
  rmSync(tmp, { recursive: true, force: true });
});

test('a screen starts empty; a put takes steps and from, which must name items and not go round in a circle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), series = 'weekly';
  openStore(tmp);
  const inst = createInstance(series, 'w1', 'alex', []);
  assert.deepEqual(inst.doc.items, []);
  writeFileSync(join(inst.dir, 'working', 'eligible.csv'), 'a\n');
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }));
  const ar = { id: 'ar', name: 'AR aging', kind: 'input', file: null };
  put([ar, { id: 'el', name: 'Eligible AR', kind: 'step', file: 'working/eligible.csv', from: ['ar'] }, { id: 'bb', name: 'Borrowing base', kind: 'output', file: null, from: ['el'] }]);
  assert.deepEqual(inst.log.filter(e => e.op === 'item').map(e => e.from), [undefined, ['ar'], ['el']]);
  assert.throws(() => put([ar, { id: 'bb', name: 'BB', kind: 'output', file: null, from: ['nope'] }]), /bb: from names no item "nope"/);
  assert.throws(() => put([{ ...ar, from: ['bb'] }, { id: 'bb', name: 'BB', kind: 'output', file: null, from: ['ar'] }]), /circle among ar, bb/);
  rmSync(tmp, { recursive: true, force: true });
});

test("an output's destination and an item's as-of date are free text, logged as they change", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), series = 'monthly';
  openStore(tmp);
  const inst = createInstance(series, 'm1', 'alex', []);
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }));
  assert.throws(() => put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 3 }]), /pack: destination must be a string/);
  put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 'Mail to ap@demo.test' }]);
  assert.equal(inst.log.findLast(e => e.op === 'item')!.destination, 'Mail to ap@demo.test');
  assert.throws(() => put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, as_of: 20260930 }]), /pack: as_of must be a string/);
  put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 'Mail to ap@demo.test', as_of: '2026-09-30' }]);
  assert.equal(inst.log.findLast(e => e.op === 'item')!.as_of, '2026-09-30');
  rmSync(tmp, { recursive: true, force: true });
});

test("an ask waits on people until someone replies or resolves it, and closing accepts the ones still waiting", async () => {
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
  await inst.close(alex);
  assert.deepEqual(inst.log.at(-1)!.accepted, ['c1']);
  rmSync(tmp, { recursive: true, force: true });
});

test("a file the screen shows is frozen as it's first shown, logged with its sha256, and closing checks it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex', []), page = join(inst.dir, 'working', 'a1.md');
  writeFileSync(page, 'a1 is right\n');
  inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items: [{ id: 'a1', name: 'A1', kind: 'step', file: 'working/a1.md' }] }));
  assert.deepEqual(inst.log.filter(e => e.op === 'point').map(e => [e.item, e.file, e.sha256]), [['a1', 'working/a1.md', createHash('sha256').update('a1 is right\n').digest('hex')]]);
  assert.equal(statSync(page).mode & 0o222, 0, 'frozen');
  chmodSync(page, 0o644);
  writeFileSync(page, 'changed\n');
  await assert.rejects(inst.close(alex), /working\/a1.md changed after it was shown/);
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
