import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { checkAuthorityFormat } from '../src/authority-format.ts';
import { commit } from '../src/git.ts';
import { appendMessage, eventsFile, jsonLines, messagesAt, messagesFile, notesFile, readEntries, storedMessage, visibleInstanceFiles } from '../src/message-store.ts';
import { addNote, conversation, notes } from '../src/messages.ts';
import { saveSeriesSettings } from '../src/series.ts';
import { createInstance, instance, instances, openStore, replaceReadOnly, seriesDir, type Entry } from '../src/store.ts';
import { changes, initSystem, saveTree } from '../src/system.ts';

const by = 'owner@example.test', at = '2026-01-01T00:00:00Z';
function fixture(t: TestContext, task = false) {
  const root = mkdtempSync(join(tmpdir(), 'rf-message-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  initSystem(root);
  openStore(root);
  const dir = seriesDir('s');
  saveSeriesSettings(dir, { version: 1, owner: by, epoch: 0, since: at });
  saveTree({ workspaces: { w: { name: 'Workspace', owners: [by], members: [] } }, series: { s: { name: 'Series', workspace: 'w', ...(task && { single: true }) } } });
  return { root, dir, inst: createInstance('s', 'Period', by) };
}

test('writes route to a single source, keep public projections, and mount/commit no raw files from instance or notes directories', async t => {
  const { root, dir, inst } = fixture(t);
  const msg = inst.append(by, 'comment', { text: 'Check this', thread: 'c2', item: 'pack', ref: 'C3' });
  const done = inst.append(by, 'settle', { text: 'Fixed', on: msg.seq, how: 'taken' });
  const wake = inst.append('server', 'wake', { text: 'scheduled', cause: msg.seq });
  const note = addNote(dir, by, 'note', { text: 'for the series' });
  const request = appendMessage(dir, { instance: inst.id }, { seq: 1, at, by, op: 'request', requestId: 'req', label: inst.label, from: by, text: 'one-off start' });
  const decision = appendMessage(dir, { instance: inst.id }, { seq: 1, at, by, op: 'request-decision', requestId: 'req', request: request.id, how: 'dismissed' });
  assert.deepEqual(readEntries(eventsFile(dir, inst.id)), [inst.log[0], wake]);
  assert.deepEqual(readEntries(notesFile(dir)), [note]);
  assert.deepEqual(readEntries(join(inst.dir, 'log.jsonl')), inst.log);
  assert.deepEqual(messagesAt(dir), [
    { id: 1, anchor: { instance: inst.id, item: 'pack', ref: 'C3' }, kind: 'comment', entry: msg },
    { id: 2, anchor: { instance: inst.id, item: 'pack', ref: 'C3' }, kind: 'settle', entry: done },
    { id: 3, anchor: {}, kind: 'comment', entry: note }, request, decision,
  ]);
  const hash = await commit(inst.dir, { name: 'Owner', email: by }, 'Public projection');
  assert.deepEqual(execFileSync('git', ['ls-tree', '--name-only', hash], { cwd: inst.dir, encoding: 'utf8' }).trim().split('\n'),
    ['instance.json', 'log.jsonl', 'screen.json']);
  assert.deepEqual(readdirSync(join(dir, 'notes')), ['log.jsonl']);
  openStore(root);
  assert.deepEqual(instance(inst.id).log, inst.log);
  assert.equal(notes(dir)[0].seq, 1);
});

test('recovery uses a complete canonical append, not stale, forged or missing projections', t => {
  const { dir, root, inst } = fixture(t);
  const note = addNote(dir, by, 'note', { text: 'original note' });
  const create = inst.log[0], run = { seq: 2, at, by, op: 'run', run: 19 };
  const comment = { seq: 3, at, by, op: 'comment', thread: 'c3', text: 'not projected yet' };
  const settled = { seq: 2, at, by, op: 'taken', on: note.seq, text: 'also not projected' };
  appendFileSync(eventsFile(dir, inst.id), jsonLines([run]));
  appendFileSync(messagesFile(dir), jsonLines([storedMessage(2, { instance: inst.id }, comment), storedMessage(3, {}, settled)]));
  const projection = join(inst.dir, 'log.jsonl');
  writeFileSync(projection, jsonLines([create, { ...comment, seq: 2, text: 'forged comment' }]));
  rmSync(notesFile(dir));
  openStore(root);
  assert.deepEqual(instance(inst.id).log, [create, run, comment]);
  assert.deepEqual(readEntries(projection), [create, run, comment]);
  assert.deepEqual(notes(dir), [{ ...note, settled }]);
  assert.deepEqual(readEntries(notesFile(dir)), [note, settled]);
});

function interruptedCreate(root: string, dir: string) {
  const id = '0123456789ab', stage = join(root, '.tmp', id), dest = join(root, 'instances', id);
  const source = eventsFile(dir, id), create = { seq: 1, at, by, op: 'create' };
  mkdirSync(join(stage, 'upload'), { recursive: true });
  mkdirSync(join(stage, 'working'));
  replaceReadOnly(join(stage, 'instance.json'), JSON.stringify({ label: 'Interrupted', series: 's' }));
  replaceReadOnly(join(stage, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }, null, 1));
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, jsonLines([create]), { flush: true });
  const fd = openSync(dirname(source), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return { id, stage, dest, source, create };
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(d => {
    const path = join(d.parentPath, d.name);
    return [path, d.isFile() ? readFileSync(path) : null];
  });
}

test('startup recovers after the first create event is durable but the instance is not published', t => {
  const { root, dir, inst } = fixture(t);
  const { id, stage, dest, source, create } = interruptedCreate(root, dir);
  assert.equal(existsSync(dest), false);
  const accepted = inst.append(by, 'comment', { text: 'Established conversation' });
  let checked = false;
  openStore(root, () => {
    assert.deepEqual(readEntries(source), [create]);
    checked = true;
  });
  assert.ok(checked);
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(dest), false);
  assert.throws(() => instance(id), /no instance/);
  rmSync(stage, { recursive: true }); // Server startup clears scratch after openStore.
  openStore(root);
  assert.deepEqual(instance(inst.id).log, inst.log);
  assert.deepEqual(readEntries(join(inst.dir, 'log.jsonl')).at(-1), accepted);
  assert.equal(createInstance('s', 'Interrupted', by).label, 'Interrupted');
});

test('an actual create interrupted at the publication rename leaves recoverable staging', t => {
  const { root, dir } = fixture(t);
  const cut = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createInstance, openStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
    const root = ${JSON.stringify(root)}, rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.startsWith(root + '/instances/')) process.exit(75);
      return rename(from, to);
    };
    syncBuiltinESMExports();
    openStore(root);
    createInstance('s', 'Interrupted', ${JSON.stringify(by)});
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(cut.status, 75, cut.stderr);
  const [id] = readdirSync(join(root, '.tmp')), source = eventsFile(dir, id);
  assert.equal(readEntries(source)[0].op, 'create');
  openStore(root);
  assert.equal(existsSync(source), false);
  assert.throws(() => instance(id), /no instance/);
});

for (const problem of ['later event', 'torn canonical tail', 'linked source', 'linked scratch', 'private working tree',
  'git history', 'projected comment', 'anchored message', 'occupied destination', 'unrelated bad history']) {
  test(`startup leaves a staged first create untouched with ${problem}`, t => {
    const { root, dir, inst } = fixture(t);
    const { id, stage, dest, source, create } = interruptedCreate(root, dir);
    if (problem === 'later event') appendFileSync(source, jsonLines([{ seq: 2, at, by, op: 'run' }]));
    if (problem === 'torn canonical tail') appendFileSync(source, '{"seq":2');
    if (problem === 'linked source') {
      rmSync(source);
      symlinkSync(eventsFile(dir, inst.id), source);
    }
    if (problem === 'linked scratch') {
      const scratch = dirname(stage), elsewhere = scratch + '-elsewhere';
      renameSync(scratch, elsewhere);
      symlinkSync(elsewhere, scratch);
    }
    if (problem === 'private working tree') writeFileSync(join(stage, 'working', 'private'), 'keep');
    if (problem === 'git history') mkdirSync(join(stage, '.git'));
    const comment = { seq: 2, at, by, op: 'comment', thread: 'c2', text: 'Do not lose this' };
    if (problem === 'projected comment') writeFileSync(join(stage, 'log.jsonl'), jsonLines([create, comment]));
    if (problem === 'anchored message') appendFileSync(messagesFile(dir), jsonLines([storedMessage(1, { instance: id }, comment)]));
    if (problem === 'occupied destination') mkdirSync(dest);
    if (problem === 'unrelated bad history') {
      const bad = createInstance('z', 'Other book', by);
      appendFileSync(eventsFile(seriesDir('z'), bad.id), jsonLines([{ seq: 3, at, by, op: 'run' }]));
    }
    const before = snapshot(root);
    assert.throws(() => openStore(root, () => assert.fail('backup must wait for validation')),
      /instance\.json|unknown instance|torn last line|invalid instance sequence/);
    assert.deepEqual(snapshot(root), before);
  });
}

test('startup rolls back torn canonical tails and leaves uncommitted creates alone', t => {
  const { dir, root, inst } = fixture(t), source = messagesFile(dir);
  const accepted = inst.append(by, 'comment', { text: 'Accepted' });
  const events = eventsFile(dir, inst.id), was = readFileSync(source), wasEvents = readFileSync(events);
  appendFileSync(source, '{"id":2,"anchor":');
  appendFileSync(events, '{"seq":3');
  const unpublished = seriesDir('unpublished'), staged = eventsFile(dir, 'unpublished') + '.tmp';
  mkdirSync(unpublished);
  mkdirSync(dirname(staged), { recursive: true });
  writeFileSync(staged, '{"seq":1');
  let backedUp = false;
  openStore(root, () => {
    assert.ok(readFileSync(source).length > was.length);
    assert.ok(readFileSync(events).length > wasEvents.length);
    backedUp = true;
  });
  assert.equal(backedUp, true);
  assert.deepEqual(readFileSync(source), was);
  assert.deepEqual(readFileSync(events), wasEvents);
  assert.deepEqual(readdirSync(unpublished), []);
  assert.equal(readFileSync(staged, 'utf8'), '{"seq":1');
  const restored = instance(inst.id);
  assert.deepEqual(restored.log.at(-1), accepted);
  assert.equal(restored.append(by, 'comment', { text: 'Next' }).seq, 3);
  assert.deepEqual(messagesAt(dir).map(m => m.id), [1, 2]);
});

for (const [problem, diagnostic] of [
  ['events', /invalid instance sequence/], ['messages', /invalid JSONL/], ['screen', /screen\.json/], ['decision reference', /invalid request decision reference/],
  ['missing metadata', /instance\.json|unknown instance/], ['orphan event stream', /instance\.json|unknown instance/],
  ['metadata and source both missing', /instance\.json: no instance metadata; folder is not empty/],
] as const) {
  test(`startup refuses ${problem} before disk changes or backup`, t => {
    const { root, dir, inst } = fixture(t);
    addNote(dir, by, 'note', { text: 'Not projected' });
    inst.append(by, 'comment', { text: 'Not projected' });
    const log = join(inst.dir, 'log.jsonl');
    writeFileSync(log, jsonLines([inst.log[0]]));
    rmSync(notesFile(dir));
    const orphan = join(root, 'instances', 'uncreated');
    mkdirSync(join(orphan, 'upload'), { recursive: true });
    const hole = createInstance('s', 'Cut deletion', by);
    const privateComment = hole.append(by, 'comment', { text: 'Not purged yet' });
    writeFileSync(eventsFile(dir, hole.id), jsonLines([{ seq: privateComment.seq + 1, at, by, op: 'delete' }]));
    appendFileSync(messagesFile(dir), '{"id":3');
    appendFileSync(eventsFile(dir, inst.id), '{"seq":3');

    const badDir = seriesDir('z');
    const later = createInstance('z', 'Other book', by);
    if (problem === 'events') appendFileSync(eventsFile(badDir, later.id), jsonLines([{ seq: 3, at, by, op: 'run' }]));
    if (problem === 'messages') appendFileSync(messagesFile(badDir), '{not a canonical row}\n');
    if (problem === 'decision reference') appendFileSync(messagesFile(badDir), jsonLines([
      storedMessage(1, {}, { seq: 1, at, by, op: 'note', text: 'Not a request' }),
      storedMessage(2, {}, { seq: 1, at, by, op: 'request-decision', requestId: 'absent', request: 1, how: 'dismissed' }),
    ]));
    if (problem === 'screen') replaceReadOnly(join(later.dir, 'screen.json'), '{"rev":1,"status":"deleted","items":null}');
    if (problem === 'missing metadata') {
      later.append(by, 'comment', { text: 'Cannot place this message' });
      rmSync(join(later.dir, 'instance.json'));
    }
    if (problem === 'orphan event stream') rmSync(join(later.dir, 'instance.json'));
    if (problem === 'metadata and source both missing') {
      rmSync(join(later.dir, 'instance.json'));
      rmSync(eventsFile(badDir, later.id));
      mkdirSync(join(later.dir, '.git'));
      writeFileSync(join(later.dir, 'working', 'private'), 'keep');
    }
    const before = snapshot(root);
    assert.throws(() => openStore(root, () => assert.fail('backup must wait for validation')), diagnostic);
    assert.deepEqual(snapshot(root), before);
  });
}

test('historical attachment shapes are read-only compatibility, not new upload paths', t => {
  const { dir, inst } = fixture(t);
  for (const file of ['working/report.csv', 'upload/input.csv', 'upload/attachments/subdir/file', { inst: inst.id, path: 'upload/attachments/file' }]) {
    assert.throws(() => inst.append(by, 'comment', { text: 'Bad attachment', files: [file] }), /invalid message attachment/);
  }
  assert.deepEqual(messagesAt(dir), []);
  const files = ['upload/attachments/file'];
  assert.deepEqual(inst.append(by, 'comment', { text: 'Good attachment', files }).files, files);
});

test('private agent files omit inaccessible and orphan pins without changing the public entry', () => {
  const files = ['working/local.csv', { inst: 'within', path: 'upload/doc.csv' },
    { inst: 'removed', path: 'working/removed.csv' }, { inst: 'outside', path: 'working/private.csv' }];
  const e = { seq: 2, at, by, op: 'comment', text: 'Legacy attachment refs', files };
  const before = JSON.stringify(e);
  const reach = new Set(['own/working/local.csv', 'within/upload/doc.csv']);
  assert.deepEqual(visibleInstanceFiles(e, 'own', (id, path) => reach.has(`${id}/${path}`)), files.slice(0, 2));
  assert.equal(JSON.stringify(e), before);
});

test('failed materialization still accepts message and event appends and their read models stay live', t => {
  const { dir, root, inst } = fixture(t), path = join(inst.dir, 'log.jsonl'), notePath = notesFile(dir);
  const first = addNote(dir, by, 'note', { text: 'First note' });
  for (const file of [path, notePath]) {
    renameSync(file, file + '.saved');
    mkdirSync(file);
  }
  const hear = (id: string) => id === 'tree' ? notes(dir) : instance(id).log;
  changes.on('change', hear);
  t.after(() => changes.off('change', hear));
  const reported = t.mock.method(console, 'error', () => {}), text = 'private synthetic body';
  const said = inst.append(by, 'comment', { text });
  const run = inst.append('server', 'run', { run: 1 });
  const second = addNote(dir, by, 'note', { text });
  assert.equal(said.seq, 2);
  assert.equal(run.seq, 3);
  assert.equal(second.seq, 2);
  assert.deepEqual(instance(inst.id).log.slice(1), [said, run]);
  assert.deepEqual(notes(dir).map(n => n.text), [first.text, second.text]);
  assert.deepEqual(readEntries(eventsFile(dir, inst.id)).slice(1), [run]);
  assert.deepEqual(messagesAt(dir).map(m => m.entry), [first, said, second]);
  assert.equal(reported.mock.calls.length, 3);
  for (const { arguments: args } of reported.mock.calls) {
    assert.match(String(args[0]), /projection needs repair/);
    assert.doesNotMatch(JSON.stringify(args), /private synthetic body/);
  }
  assert.throws(() => inst.syncLog(), /EISDIR/);
  for (const file of [path, notePath]) {
    rmSync(file, { recursive: true });
    renameSync(file + '.saved', file);
  }
  inst.syncLog();
  assert.deepEqual(readEntries(path), inst.log);
  assert.equal(inst.append(by, 'comment', { text: 'Next seq' }).seq, 4);
  openStore(root);
  assert.deepEqual(readEntries(notePath), [first, second]);
});

for (const cut of [false, true]) {
  test(`deletion keeps only the series request verdict${cut ? ' after a cut' : ''}`, t => {
    const { dir, inst, root } = fixture(t);
    const note = addNote(dir, by, 'note', { text: 'Keep this series request', request: true });
    const already = addNote(dir, by, 'note', { text: 'Settled separately' });
    const settled = addNote(dir, by, 'taken', { on: already.seq, text: 'Independent settlement' });
    const proposal = inst.append('agent', 'comment', { ask: 'proposal', noteFor: `n${note.seq}`, thread: 'c2', text: 'Private proposal', files: ['upload/attachments/proposal.txt'] });
    const decision = inst.append(by, cut ? 'reject' : 'signoff', {
      on: proposal.seq, thread: proposal.thread, noteFor: proposal.noteFor, noteDecision: true, text: 'Private decision', commit: 'private-instance-commit',
    });
    const id = messagesAt(dir).at(-1)!.id, how = cut ? 'aside' : 'taken';
    const discussion = () => conversation(messagesAt(dir), instances('s'), 0).notes;
    assert.equal(discussion()[0].settled?.op, how);
    if (cut) writeFileSync(eventsFile(dir, inst.id), jsonLines([{ seq: decision.seq + 1, at, by, op: 'delete' }]));
    else {
      inst.markDeleted(by, {});
      inst.clear();
    }
    openStore(root);
    const result = [{ id, anchor: {}, kind: 'settle', entry: { seq: 1, at: decision.at, by, op: 'note-verdict', on: note.seq, how } }];
    assert.deepEqual(messagesAt(dir).filter(m => m.id >= id - 1), result);
    assert.doesNotMatch(readFileSync(messagesFile(dir), 'utf8'), /Private proposal|Private decision|private-instance-commit|proposal\.txt|"thread"/);
    assert.ok(!readFileSync(messagesFile(dir), 'utf8').includes(inst.id));
    assert.deepEqual(readEntries(notesFile(dir)), [note, already, settled]);
    assert.equal(discussion()[0].settled?.op, how);
    assert.deepEqual(discussion()[1].settled, settled);
  });
}

test('recovery purges scheduler request bodies by label or source without touching unrelated requests', t => {
  const { dir, inst, root } = fixture(t), other = seriesDir('other');
  createInstance('other', inst.label, by);
  const slot = appendMessage(dir, {}, { seq: 1, at, by, op: 'request', requestId: 'slot', label: inst.label, from: by, text: 'Deleted slot' });
  const sourced = appendMessage(other, {}, { seq: 1, at, by: 'agent', op: 'request', requestId: 'sourced', label: 'Future', source: inst.id, from: by });
  appendMessage(other, {}, { seq: 1, at, by, op: 'request-decision', requestId: 'sourced', request: sourced.id, how: 'dismissed' });
  const unaffected = appendMessage(other, {}, { seq: 1, at, by, op: 'request', requestId: 'unrelated', label: slot.entry.label, from: by });
  writeFileSync(eventsFile(dir, inst.id), jsonLines([{ seq: 2, at, by, op: 'delete' }]));
  openStore(root);
  assert.deepEqual(messagesAt(dir), []);
  assert.deepEqual(messagesAt(other), [unaffected]);
  openStore(root);
  assert.deepEqual(messagesAt(dir), []);
  assert.deepEqual(messagesAt(other), [unaffected]);
});

for (const task of [false, true]) for (const cut of [false, true]) {
  test(`${task ? 'task' : 'instance'} deletion purges only owned conversation and files${cut ? ' after an interrupted deletion' : ''}`, t => {
    const { root, dir, inst } = fixture(t, task);
    const sibling = task ? undefined : createInstance('s', 'Other period', by);
    const see = { inst: inst.id, label: inst.label, thread: 'c2' };
    sibling?.append('agent', 'comment', { text: 'Separate conversation', see });
    const note = addNote(dir, by, 'note', { text: 'Series note', files: ['files/series.txt'], see });
    const attached = 'upload/attachments/remove.txt';
    for (const file of [join(inst.dir, attached), join(dir, 'notes/files/series.txt')]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'attachment');
    }
    inst.append(by, 'comment', { thread: 'c2', text: 'Private instance text', files: [attached] });
    inst.append(by, 'settle', { on: 2, how: 'aside', text: 'Private instance explanation' });
    const request = appendMessage(dir, { instance: inst.id }, { seq: 1, at, by, op: 'request', requestId: 'req', label: inst.label, from: by, text: 'Private instance request' });
    appendMessage(dir, { instance: inst.id }, { seq: 1, at, by, op: 'request-decision', requestId: 'req', request: request.id, how: 'dismissed' });
    const last = messagesAt(dir).at(-1)!.id, source = eventsFile(dir, inst.id), projection = join(inst.dir, 'log.jsonl');
    const fields = { cost: 0, runs: [] };
    const tombstone: Entry = { seq: inst.log.length + 1, at, by, op: 'delete', ...fields };
    if (cut) {
      // Kill point: the canonical tombstone was committed, but files, old projections and messages are still present.
      writeFileSync(source, jsonLines([tombstone]));
      assert.match(readFileSync(projection, 'utf8'), /Private instance text/);
      assert.match(readFileSync(messagesFile(dir), 'utf8'), /remove\.txt/);
    } else {
      inst.markDeleted(by, fields);
      inst.clear();
      assert.doesNotMatch(readFileSync(messagesFile(dir), 'utf8'), /Private instance|remove\.txt/);
    }
    openStore(root);
    assert.deepEqual(readdirSync(inst.dir).sort(), ['instance.json', 'log.jsonl', 'screen.json']);
    assert.equal(instance(inst.id).doc.status, 'deleted');
    assert.deepEqual(readEntries(projection), readEntries(source));
    assert.deepEqual(readEntries(source).map(e => e.op), ['delete']);
    assert.doesNotMatch(readFileSync(messagesFile(dir), 'utf8'), /Private instance|remove\.txt/);
    assert.equal(messagesAt(dir).some(m => m.anchor.instance === inst.id), false);
    if (task) {
      assert.deepEqual(messagesAt(dir), []);
      assert.equal(existsSync(join(dir, 'notes')), false);
    } else {
      assert.deepEqual(notes(dir), [{ ...note, settled: undefined }]);
      assert.equal(instance(sibling!.id).log[1].text, 'Separate conversation');
      assert.deepEqual(instance(sibling!.id).log[1].see, see);
      assert.ok(existsSync(join(dir, 'notes/files/series.txt')));
      assert.equal(appendMessage(dir, {}, { seq: 1, at, by, op: 'request', requestId: 'new', label: 'Future', from: by }).id, last + 1, 'purged IDs are not recycled');
    }
  });
}
