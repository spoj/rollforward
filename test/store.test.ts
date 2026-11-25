import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstance, instance, keep, openFile, openStore, safeName } from '../src/store.ts';
import { commit, forget } from '../src/git.ts';
import { addNote, notes } from '../src/messages.ts';
import { messagesFile } from '../src/message-store.ts';
import { act, initSystem } from '../src/system.ts';

const alex = { email: 'alex', name: 'Alex' };

test('deleting during a close never restores the instance or writes a close over its tombstone', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'deleted', 'alex'), gate = Promise.withResolvers<void>();
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

test('Close checks item files after the preceding run finishes stopping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-close-files-'));
  openStore(root);
  const inst = createInstance('monthly', 'closing', 'alex'), gate = Promise.withResolvers<void>();
  const file = join(inst.dir, 'working', 'pack.csv');
  writeFileSync(file, 'approved output');
  inst.put(JSON.stringify({ ...inst.doc, items: [{ id: 'pack', name: 'Pack', kind: 'output', file: 'working/pack.csv' }] }), 1);
  const last = commit(inst.dir, alex, 'Last run', gate.promise), closing = inst.close(alex);
  const refused = assert.rejects(closing, { status: 409, message: 'pack: no file working/pack.csv' });
  rmSync(file);
  gate.resolve();
  try {
    await Promise.all([last, refused]);
    assert.equal(inst.doc.status, 'open');
    assert.equal(inst.log.some(e => e.op === 'close'), false);
    assert.equal(instance(inst.id).doc.status, 'open');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a name is a folder's and a line's: slashes, control characters and line breaks become _, and AGENTS.md, where the view binds instructions, is refused, as is a folder's name over 200 bytes", () => {
  assert.equal(safeName('Bank/rec\\Q1\nlines\u2028\u2029\x85\x7f'), 'Bank_rec_Q1_lines____');
  assert.throws(() => safeName('AGENTS.md'), /AGENTS\.md is the name of the agents' instructions/);
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  assert.throws(() => createInstance('s', '供应商对账单'.repeat(15), 'alex'), /a name is 200 bytes at most/, "a label is a folder's in a run's view, which holds 255 bytes");
  rmSync(tmp, { recursive: true, force: true });
});

test('openFile opens only what is under its base: a path that climbs with .., or is not normal, names nothing, though the file it would reach is there', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), base = join(tmp, 'a', 'b');
  mkdirSync(base, { recursive: true });
  writeFileSync(join(tmp, 'secret'), 'x');
  writeFileSync(join(base, 'mine'), 'y');
  for (const rel of ['../../secret', 'mine/../../../secret', './mine', 'c//../mine', 'a'.repeat(260)]) assert.equal(openFile(base, rel), undefined, rel);
  assert.equal(typeof openFile(base, 'mine'), 'number');
  rmSync(tmp, { recursive: true, force: true });
});

test('an upload named attachments takes the next free name, leaving the folder for comment attachments', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex'), incoming = join(tmp, 'incoming');
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
  const inst = createInstance(series, 'w1', 'alex');
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
  const inst = createInstance(series, 'm1', 'alex');
  const put = (items: object[]) => inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items }), 1);
  assert.throws(() => put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 3 }]), /pack: destination must be a string/);
  put([{ id: 'pack', name: 'Pack', kind: 'output', file: null, destination: 'Mail to ap@demo.test' }]);
  assert.equal(inst.log.findLast(e => e.op === 'item')!.destination, 'Mail to ap@demo.test');
  rmSync(tmp, { recursive: true, force: true });
});

test("an ask from before questions and proposals waits on people until someone replies under it, the agent too, or approves or rejects it, as one from before replies named their parent did until any later word in its thread; closing accepts the ones still waiting", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), sam = 'sam@example.com';
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex');
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
test("a question waits until its recipient replies, a proposal until someone decides it, and either until the agent withdraws it", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), sam = 'sam@example.com';
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex');
  const ask = (kind: string) => inst.append('agent', 'comment', { thread: `c${inst.log.length + 1}`, item: null, ref: null, text: 'Which?', ask: kind, to: sam });
  const q1 = ask('question'), q2 = ask('question'), q3 = ask('question'), p1 = ask('proposal'), p2 = ask('proposal'), p3 = ask('proposal'), p4 = ask('proposal');
  inst.append('agent', 'comment', { thread: q1.thread, parent: q1.seq, text: 'Never mind.' });
  inst.append('other@example.com', 'comment', { thread: q1.thread, parent: q1.seq, text: 'An opinion, not the answer.' });
  inst.append(sam, 'comment', { thread: q2.thread, parent: q2.seq, text: 'This one.' });
  inst.append('agent', 'withdraw', { thread: q3.thread, on: q3.seq, text: 'Found it.' });
  inst.append(sam, 'comment', { thread: p1.thread, parent: p1.seq, text: 'Go ahead.' });
  inst.append(sam, 'signoff', { thread: p2.thread, on: p2.seq, commit: 'x' });
  inst.append(sam, 'reject', { thread: p3.thread, on: p3.seq, text: 'Not yet.' });
  inst.append('agent', 'withdraw', { thread: p4.thread, on: p4.seq, text: 'Sent by hand.', see: p1.seq });
  assert.deepEqual(inst.asking().map(e => e.seq), [q1.seq, p1.seq], "the agent's own word under a question, and a reply under a proposal, however worded, answer neither");
  rmSync(tmp, { recursive: true, force: true });
});
test("a copy an earlier version made starts its own history at its latest duplicate entry, as it comes and as the log is read again; a deletion's hole has none", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'copy', 'alex', []);
  const ask = inst.append('agent', 'comment', { thread: 'c2', text: 'Which?', ask: 'question' });
  assert.equal(inst.copied, 0);
  assert.deepEqual(inst.asking().map(e => e.seq), [ask.seq]);
  const first = inst.append('alex', 'duplicate', { from: 'earlier', logins: [] });
  assert.equal(inst.copied, first.seq, 'a duplicate entry counts as it comes');
  const last = inst.append('alex', 'duplicate', { from: 'earlier still', logins: [] });
  inst.append('alex', 'comment', { thread: 'c5', text: 'Go.' });
  assert.equal(inst.copied, last.seq, 'the latest counts');
  assert.deepEqual(inst.asking(), [], 'what came before it waits on no one');
  openStore(tmp);
  assert.equal(instance(inst.id).copied, last.seq, 'as the log is read again');
  instance(inst.id).markDeleted('alex', { cost: 0, runs: [] });
  assert.equal(instance(inst.id).copied, 0, 'its log is its delete entry alone');
  openStore(tmp);
  assert.equal(instance(inst.id).copied, 0, 'as a restart reads it');
  rmSync(tmp, { recursive: true, force: true });
});
test("a file the screen shows stays the agent's to change, and closing takes it as it is", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('weekly', 'w1', 'alex'), page = join(inst.dir, 'working', 'a1.md');
  writeFileSync(page, 'a1 is right\n');
  inst.put(JSON.stringify({ rev: inst.doc.rev, status: 'open', items: [{ id: 'a1', name: 'A1', kind: 'step', file: 'working/a1.md' }] }), 1);
  assert.deepEqual(inst.log.filter(e => e.op === 'point').map(e => [e.item, e.file, e.was]), [['a1', 'working/a1.md', null]]);
  writeFileSync(page, 'changed\n');
  rmSync(page);
  await assert.rejects(inst.close(alex), { status: 409, message: 'a1: no file working/a1.md' });
  assert.equal(inst.doc.status, 'open');
  writeFileSync(page, 'changed\n');
  await inst.close(alex);
  assert.equal(inst.doc.status, 'closed');
  rmSync(tmp, { recursive: true, force: true });
});

test('a close whose commit succeeds but packing fails leaves the instance open, with no close entry, and can be retried', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'pack-fails', 'alex');
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
  const inst = createInstance('monthly', 'm1', 'alex'), locked = join(inst.dir, 'working', 'locked.csv'), shut = join(inst.dir, 'working', 'shut');
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

// A file size limit stands in for a full disk: writes past it fail part-way, as with ENOSPC.
const cutShort = (script: string) => execFileSync('bash', ['-c', `trap '' XFSZ; ulimit -f 64; exec "${process.execPath}" --input-type=module -e "$0"`, script], { encoding: 'utf8' });

test('a partial append rolls back, and a torn canonical line is dropped on restart without using the projection', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const id = createInstance('monthly', 'torn', 'alex').id, log = join(tmp, 'instances', id, 'log.jsonl');
  const [kept, code] = cutShort(`
    import { instance, openStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'store.ts')).href)};
    openStore(${JSON.stringify(tmp)});
    const inst = instance(${JSON.stringify(id)});
    try { for (;;) inst.append('agent', 'comment', { text: 'x'.repeat(3000) }); } catch (e) { console.log(inst.log.length, e.code); }`).trim().split(' ');
  assert.equal(code, 'EFBIG');
  openStore(tmp);
  assert.equal(instance(id).log.length, Number(kept), 'what memory holds is what the log holds');
  assert.ok(readFileSync(log, 'utf8').endsWith('\n'));
  const raw = messagesFile(join(tmp, 'series', 'monthly'));
  appendFileSync(raw, '{"id":99,"anchor":');
  writeFileSync(log, 'damaged projection\n');
  const said = t.mock.method(console, 'error', () => {});
  openStore(tmp);
  assert.equal(instance(id).log.length, Number(kept));
  assert.match(said.mock.calls[0].arguments[0], /messages\.jsonl: dropped a torn last line/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, Number(kept));
  assert.equal(instance(id).append('alex', 'comment', { text: 'After.' }).seq, Number(kept) + 1);
  openStore(tmp);
  assert.equal(instance(id).log.at(-1)!.text, 'After.');
  rmSync(tmp, { recursive: true, force: true });
});

test("a series' canonical notes and the system's log drop a torn last line and go on by seq", t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-')), book = join(tmp, 'series', 's1'), system = join(tmp, '.rf', 'log.jsonl');
  initSystem(tmp);
  t.mock.method(console, 'error', () => {});
  addNote(book, 'alex', 'note', { text: 'First.' });
  appendFileSync(messagesFile(book), '{"id":2,"anch');
  openStore(tmp);
  assert.deepEqual(notes(book).map(n => n.seq), [1]);
  assert.equal(addNote(book, 'alex', 'note', { text: 'Second.' }).seq, 2);
  assert.deepEqual(notes(book).map(n => n.text), ['First.', 'Second.']);
  writeFileSync(system, `${JSON.stringify({ seq: 1, by: 'alex', op: 'x' })}\n{"seq":2,"by`);
  act('alex', { op: 'y' });
  assert.deepEqual(readFileSync(system, 'utf8').trim().split('\n').map(l => JSON.parse(l).seq), [1, 2]);
  rmSync(tmp, { recursive: true, force: true });
});

test('a read-only temporary file a write cut short left stops no later save', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'left', 'alex');
  writeFileSync(join(inst.dir, 'screen.json.tmp'), '{"rev"', { mode: 0o444 });
  inst.save();
  assert.equal(JSON.parse(readFileSync(join(inst.dir, 'screen.json'), 'utf8')).rev, inst.doc.rev);
  rmSync(tmp, { recursive: true, force: true });
});

test("a file whose name passes the 255 bytes a name holds, as an Outlook mail saved under a long subject, is kept under its stem cut short", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const inst = createInstance('monthly', 'long', 'alex'), incoming = join(tmp, 'incoming'), name = `${'发票'.repeat(45)}.xlsx`;
  for (const n of [1, 2]) {
    writeFileSync(incoming, `copy ${n}`);
    const { file } = inst.upload('alex', name, incoming, 'hash', 'in', null, true), base = (file as string).slice('upload/'.length);
    assert.ok(Buffer.byteLength(base) <= 255 && name.startsWith(base.slice(0, 80)) && base.endsWith(n === 1 ? '.xlsx' : '_2.xlsx'), base);
    assert.equal(readFileSync(join(inst.dir, file as string), 'utf8'), `copy ${n}`);
  }
  assert.equal(inst.doc.items[0].name, name.slice(0, -5), 'the item keeps the whole name');
  for (const odd of [`2026.11 ${'供应商月末应收账款及银行余额调节核对明细表'.repeat(5)}`, `年.${'中'.repeat(84)}`]) {
    for (const n of [1, 2]) {
      writeFileSync(incoming, `odd ${n}`);
      const saved = keep(tmp, 'files', odd, incoming), base = saved.slice('files/'.length);
      assert.ok(Buffer.byteLength(base) <= 255 && !base.startsWith('.'), saved);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('a createInstance cut short leaves no instance behind, and openStore removes an uncreated instance folder while keeping a deleted hole', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-'));
  openStore(tmp);
  const out = execFileSync('bash', ['-c', `trap '' XFSZ; ulimit -f 1; exec "${process.execPath}" --input-type=module -e "$0"`, `
    import { createInstance, labels, openStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'store.ts')).href)};
    import { readdirSync } from 'node:fs';
    import { join } from 'node:path';
    openStore(${JSON.stringify(tmp)});
    let code = '';
    try { createInstance('monthly', 'cut', 'alex'.repeat(300)); } catch (e) { code = e.code; }
    console.log(JSON.stringify({ code, dirs: readdirSync(join(${JSON.stringify(tmp)}, 'instances')), indexed: labels('monthly') }));
  `], { encoding: 'utf8' }).trim();
  assert.deepEqual(JSON.parse(out), { code: 'EFBIG', dirs: [], indexed: [] });

  const hole = createInstance('monthly', 'hole', 'alex');
  hole.markDeleted('alex', { cost: 0, runs: [] });
  mkdirSync(join(tmp, 'instances', 'deadbeef0001', 'upload'), { recursive: true });
  const torn = join(tmp, 'instances', 'deadbeef0002');
  mkdirSync(torn, { recursive: true });
  writeFileSync(join(torn, 'instance.json'), JSON.stringify({ label: 'torn', series: 'monthly' }));
  writeFileSync(join(torn, 'log.jsonl'), '{"seq":1,"by":"al');
  const said = t.mock.method(console, 'error', () => {});
  assert.throws(() => openStore(tmp), /ENOENT.*events\.jsonl/, 'published instances cannot fall back to old projections');
  assert.equal(readFileSync(join(torn, 'log.jsonl'), 'utf8'), '{"seq":1,"by":"al');
  rmSync(torn, { recursive: true });
  openStore(tmp);
  assert.equal(instance(hole.id).hole, true);
  assert.throws(() => instance('deadbeef0001'), /no instance/);
  assert.ok(said.mock.calls.some(c => String(c.arguments[0]).includes('removed an uncreated instance')));
  rmSync(tmp, { recursive: true, force: true });
});

test('screen put distinguishes a missing rev from a stale rev without leaking the current rev', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-rev-'));
  openStore(tmp);
  try {
    const inst = createInstance('weekly', 'w1', 'alex');
    for (const body of [{ items: [] }, { rev: null, items: [] }]) {
      assert.throws(() => inst.put(JSON.stringify(body), 1), { status: 400, message: 'missing rev: take it from rf show and merge' });
    }
    assert.throws(() => inst.put(JSON.stringify({ rev: 99, items: [] }), 1), { status: 409, message: 'stale rev 99: each put and upload moves the screen on: run rf show and merge' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('close and abandon persist their terminal audit event before screen.json, reconcile on startup, and replay post-close wakes idempotently', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-terminal-'));
  const { saveTree, writeJson } = await import('../src/system.ts');
  const { authority } = await import('../src/logins.ts');
  const { ownSeries } = await import('./owner-fixture.ts');
  const { ackTerminalFollowup, pendingTerminalFollowups } = await import('../src/store.ts');
  const { closed, recover, setWake, wakesOf, stop: stopWaker } = await import('../src/waker.ts');
  const owner = 'alex@demo.test', who = { name: 'Alex', email: owner };
  try {
    initSystem(tmp);
    openStore(tmp);
    saveTree({ workspaces: { w: { name: 'W', owners: [owner], members: [] } }, series: { monthly: { name: 'Monthly', workspace: 'w' } } });
    writeJson('users.json', { [owner]: { name: 'Alex', role: 'user' } });
    ownSeries('monthly', owner, [], false);

    // 1) Close fails if append fails: never leaves terminal screen.json or stale pending follow-up, and retries cleanly.
    const failClose = createInstance('monthly', '2026-01', owner);
    const origAppend = failClose.append.bind(failClose);
    failClose.append = ((by: string, op: string, fields?: Record<string, unknown>) => {
      if (op === 'close') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return origAppend(by, op, fields);
    }) as typeof failClose.append;
    await assert.rejects(failClose.close(who, { authority: authority(failClose) }), /ENOSPC/);
    assert.equal(failClose.doc.status, 'open');
    assert.equal(JSON.parse(readFileSync(join(failClose.dir, 'screen.json'), 'utf8')).status, 'open');
    assert.equal(failClose.log.some(e => e.op === 'close'), false);
    assert.deepEqual(pendingTerminalFollowups(), [], 'failed append cleans up pending follow-up');
    failClose.append = origAppend;
    const f1 = await failClose.close(who, { authority: authority(failClose) });
    ackTerminalFollowup(f1.key);
    assert.equal(failClose.doc.status, 'closed');
    assert.equal(JSON.parse(readFileSync(join(failClose.dir, 'screen.json'), 'utf8')).status, 'closed');

    // 2) Abandon fails if append fails: never leaves terminal screen.json without audit event.
    const failAbandon = createInstance('monthly', '2026-02', owner);
    const origAbandonAppend = failAbandon.append.bind(failAbandon);
    failAbandon.append = ((by: string, op: string, fields?: Record<string, unknown>) => {
      if (op === 'abandon') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return origAbandonAppend(by, op, fields);
    }) as typeof failAbandon.append;
    await assert.rejects(failAbandon.abandon(owner), /ENOSPC/);
    assert.equal(failAbandon.doc.status, 'open');
    assert.equal(JSON.parse(readFileSync(join(failAbandon.dir, 'screen.json'), 'utf8')).status, 'open');
    assert.equal(failAbandon.log.some(e => e.op === 'abandon'), false);

    // 3) Simulated crash between durable close/abandon event append and screen.json replacement,
    // PLUS a new draft opened AFTER close (must NOT receive recovered close wake).
    const cutClose = createInstance('monthly', '2026-03', owner);
    const cutAbandon = createInstance('monthly', '2026-04', owner);
    const later = createInstance('monthly', '2026-05', owner);
    setWake(cutClose.id, { at: new Date(Date.now() + 3600_000).toISOString(), from: owner, text: 'pending' });
    setWake(cutAbandon.id, { at: new Date(Date.now() + 3600_000).toISOString(), from: owner, text: 'pending' });

    const closeAuth = authority(cutClose);
    cutClose.save = () => {
      assert.equal(JSON.parse(readFileSync(join(cutClose.dir, 'screen.json'), 'utf8')).status, 'open');
      assert.equal(cutClose.log.at(-1)!.op, 'close');
      throw new Error('simulated crash before screen save');
    };
    await assert.rejects(cutClose.close(who, { quiet: true, authority: closeAuth }), /simulated crash before screen save/);
    assert.equal(JSON.parse(readFileSync(join(cutClose.dir, 'screen.json'), 'utf8')).status, 'open');

    // Open a brand-new draft AFTER cutClose closed: must NOT receive cutClose's recovered close notification.
    const openedAfterClose = createInstance('monthly', '2026-06', owner);

    cutAbandon.save = () => {
      assert.equal(JSON.parse(readFileSync(join(cutAbandon.dir, 'screen.json'), 'utf8')).status, 'open');
      assert.equal(cutAbandon.log.at(-1)!.op, 'abandon');
      throw new Error('simulated crash before screen save');
    };
    await assert.rejects(cutAbandon.abandon(owner), /simulated crash before screen save/);
    assert.equal(JSON.parse(readFileSync(join(cutAbandon.dir, 'screen.json'), 'utf8')).status, 'open');

    // Simulate a second crash AFTER openStore repairs screen.json, BEFORE recover() runs!
    openStore(tmp);
    assert.equal(instance(cutClose.id).doc.status, 'closed');
    assert.equal(JSON.parse(readFileSync(join(cutClose.dir, 'screen.json'), 'utf8')).status, 'closed');
    assert.equal(instance(cutAbandon.id).doc.status, 'abandoned');
    assert.equal(JSON.parse(readFileSync(join(cutAbandon.dir, 'screen.json'), 'utf8')).status, 'abandoned');
    // Restart AGAIN with screen.json ALREADY terminal: durable pending follow-ups must STILL survive and run!
    openStore(tmp);
    assert.equal(pendingTerminalFollowups().length, 2, 'pending follow-ups survive restart even after screen.json is already terminal');

    recover();
    assert.deepEqual(pendingTerminalFollowups(), [], 'pending follow-ups acknowledged only after recover() completes');
    assert.deepEqual(wakesOf(cutClose.id), [], 'reconciled close cancels pending wakes');
    assert.deepEqual(wakesOf(cutAbandon.id), [], 'reconciled abandon cancels pending wakes');
    const wakesAfterRecover = instance(later.id).log.filter(e => e.op === 'wake');
    assert.equal(wakesAfterRecover.length, 1, 'reconciled close notifies close-time later open instance');
    assert.equal(wakesAfterRecover[0].quiet, true, 'reconciled close preserves quiet flag');
    assert.deepEqual(wakesAfterRecover[0].authority, closeAuth, 'reconciled close uses captured close-time authority');
    assert.match(String(wakesAfterRecover[0].text), /2026-03 closed/);
    assert.equal(instance(openedAfterClose.id).log.filter(e => e.op === 'wake').length, 0, 'draft opened after close is NOT woken on replay');

    // Replaying closed() again for the same close event is idempotent.
    closed(instance(cutClose.id), owner, true);
    assert.equal(instance(later.id).log.filter(e => e.op === 'wake').length, 1, 'closed() replay is idempotent by close-event identity');

    // 4) Crash AFTER screen.json is closed + consent change before replay -> MUST fail closed (no new lease minted!).
    const afterScreen = createInstance('monthly', '2026-07', owner);
    const recipient = createInstance('monthly', '2026-08', owner);
    setWake(afterScreen.id, { at: new Date(Date.now() + 3600_000).toISOString(), from: owner, text: 'still pending' });
    const oldAuth = authority(afterScreen);
    // Complete close() (both append AND screen.json save succeed), but crash BEFORE cancelWakes/closed/ack!
    await afterScreen.close(who, { quiet: true, authority: oldAuth });
    assert.equal(JSON.parse(readFileSync(join(afterScreen.dir, 'screen.json'), 'utf8')).status, 'closed');
    assert.equal(pendingTerminalFollowups().length, 1, 'follow-up remains pending after screen save until acknowledged');

    // Owner's consent changes (new epoch / new login) before recovery runs.
    ownSeries('monthly', owner, ['m365:onedrive'], true);
    openStore(tmp);
    recover();
    assert.deepEqual(wakesOf(afterScreen.id), [], 'pending wakes still cancelled on recovery');
    assert.equal(instance(recipient.id).log.filter(e => e.op === 'wake').length, 0, 'recovered close fails closed and does NOT mint a new lease under changed consent');
    assert.deepEqual(pendingTerminalFollowups(), []);
  } finally {
    stopWaker();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Instance.append rejects unsafe integers and non-finite numbers before writing canonical events so startup never bricks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-safe-num-'));
  try {
    openStore(tmp);
    const inst = createInstance('monthly', 'safe', 'alex');
    for (const bad of [1e25, Number.MAX_SAFE_INTEGER + 10, Infinity, -Infinity, NaN]) {
      assert.throws(() => inst.append('agent', 'call', { run: 1, bad }), /unrepresentable number/);
    }
    assert.equal(inst.log.length, 1, 'rejected entries never enter memory or disk');
    openStore(tmp);
    assert.equal(instance(inst.id).log.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('terminal recovery matches close by op+seq (not shadowed by corrected), replays half-recorded supersession idempotently, and rolls back status on pending write failure', async () => {
  const { execFileSync } = await import('node:child_process');
  const { initSystem, saveTree } = await import('../src/system.ts');
  const { upsertUser } = await import('../src/auth.ts');
  const { authority } = await import('../src/logins.ts');
  const { ownSeries } = await import('./owner-fixture.ts');
  const { pendingTerminalFollowups } = await import('../src/store.ts');
  const { recover, setWake, wakesOf, stop: stopWaker } = await import('../src/waker.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'rf-store-reverify-'));
  try {
    initSystem(tmp);
    openStore(tmp);
    const owner = 'alex@demo.test', who = { name: 'Alex', email: owner };
    upsertUser(owner, { name: 'Alex', role: 'user' });
    saveTree({ workspaces: { w: { name: 'W', owners: [owner], members: [] } }, series: { monthly: { name: 'Monthly', workspace: 'w' } } });
    ownSeries('monthly', owner, [], true);

    // 1) An earlier `corrected` event whose `seq` field equals the subsequent `close` event's seq must NOT shadow `close`.
    const base = createInstance('monthly', '2026-09', owner);
    const next = createInstance('monthly', '2026-10', owner);
    await base.close(who, { quiet: true, authority: authority(base) });
    await recover();

    const r2 = createInstance('monthly', '2026-09-r2', owner);
    // Append a `corrected` entry whose `seq` field collides with the upcoming close event's seq (r2.log.length + 2 = 3).
    r2.append(owner, 'corrected', { inst: base.id, label: base.label, seq: 3, kind: 'wrong' });
    assert.equal(r2.log.length, 2);
    setWake(r2.id, { at: new Date(Date.now() + 3600_000).toISOString(), from: owner, text: 'cancel on close' });
    const r2Auth = authority(r2);
    const followup = await r2.close(who, { quiet: true, authority: r2Auth });
    assert.equal(followup.seq, 3, 'close event seq collides with earlier corrected.seq');
    assert.equal(followup.supersedes, base.id);

    // Simulate a crash partway through supersession: `correction` landed on `base`, but `corrected` (superseded) did NOT land on `r2`,
    // and neither repo was committed for the supersession yet.
    const corr = base.append(owner, 'correction', { kind: 'superseded', text: `${r2.label} supersedes it`, see: { inst: r2.id, label: r2.label } }, true);

    openStore(tmp);
    assert.equal(pendingTerminalFollowups().length, 1, 'openStore must NOT prune close follow-up shadowed by earlier corrected.seq');
    await recover();

    assert.deepEqual(pendingTerminalFollowups(), [], 'pending follow-up cleared after supersession commits complete');
    assert.deepEqual(wakesOf(r2.id), [], 'close cancelled r2 pending wakes');
    assert.equal(instance(next.id).log.filter(e => e.op === 'wake' && (e.closed as any)?.inst === r2.id).length, 1, 'r2 close woke close-time recipient');
    assert.equal(instance(base.id).log.filter(e => e.op === 'correction' && e.kind === 'superseded').length, 1, 'correction not duplicated on replay');
    const echoed = instance(r2.id).log.filter(e => e.op === 'corrected' && e.kind === 'superseded' && e.inst === base.id && e.seq === corr.seq);
    assert.equal(echoed.length, 1, 'missing corrected side completed on replay');
    assert.match(execFileSync('git', ['log', '-n', '1', '--pretty=%s'], { cwd: instance(base.id).dir, encoding: 'utf8' }), /Correction: 2026-09 is superseded/);
    assert.match(execFileSync('git', ['log', '-n', '1', '--pretty=%s'], { cwd: instance(r2.id).dir, encoding: 'utf8' }), /Corrected: 2026-09 is superseded/);

    // 2) Failure writing `.rf/terminal-pending.json` rolls back in-memory doc.status to `open`.
    const blocked = createInstance('monthly', '2026-11', owner);
    const blocker = join(tmp, '.rf', 'terminal-pending.json.tmp');
    mkdirSync(blocker, { recursive: true });
    try {
      await assert.rejects(blocked.close(who, { quiet: true, authority: authority(blocked) }));
      assert.equal(blocked.doc.status, 'open', 'in-memory status rolled back to open on pending write failure');
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  } finally {
    stopWaker();
    rmSync(tmp, { recursive: true, force: true });
  }
});

