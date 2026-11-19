import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { migrateMessageCopy } from '../scripts/migrate-messages.ts';
import { checkAuthorityFormat } from '../src/authority-format.ts';
import { eventsFile, jsonLines, messagesAt, messagesFile, notesFile, readEntries, storedMessage } from '../src/message-store.ts';
import { notes, openNotes } from '../src/messages.ts';
import { instance, openStore, type Entry } from '../src/store.ts';
import { initSystem } from '../src/system.ts';
import { message, seriesConversation, view } from '../src/waker.ts';
import { idp } from './idp.ts';
import { snapshotFiles, writeLegacyFixtureTree } from './owner-fixture.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const entry = (seq: number, minute: number, op: string, fields: object = {}): Entry =>
  ({ seq, at: at(minute), by: 'redacted@example.test', op, ...fields });
const treeFile = (root: string) => join(root, '.rf/tree.json');
const script = join(import.meta.dirname, '../scripts/migrate-messages.ts');
const book = (root: string) => join(root, 'series/book');

function fixture(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-migrate-messages-')), source = join(tmp, 'original'), copy = join(tmp, 'copy');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(source, '.rf'), { recursive: true });
  mkdirSync(join(source, 'agents'));
  writeLegacyFixtureTree(source, { workspaces: { w: { name: 'Workspace', owners: [], members: [] } }, series: { book: { name: 'Book', workspace: 'w' } } });
  const a = [
    entry(1, 0, 'create'),
    entry(2, 1, 'comment', { thread: 'c2', item: 'pack', ref: 'C4', text: 'FYI', files: ['upload/attachments/figure.csv'], note: true }),
    entry(3, 1, 'run', { run: 1, cause: 2 }),
    entry(2, 2, 'said', { run: 1, inst: 'b', thread: 'c2' }), // historical cross-instance seq, not line 4
    entry(5, 2, 'comment', { thread: 'c5', item: 'pack', ref: 'C4', ask: 'proposal', text: 'Use this?', run: 1 }),
    entry(6, 3, 'signoff', { thread: 'c5', on: 5, commit: 'a'.repeat(40) }),
    entry(7, 4, 'reject', { thread: 'c5', on: 5, text: 'Try again.' }),
    entry(8, 5, 'withdraw', { thread: 'c5', on: 5, see: 2, run: 1 }),
    entry(9, 6, 'wake', { cause: 8, reason: 'Scheduler entry is an event', schedule: 'my-schedule' }),
    entry(10, 7, 'wake-check', { by: 'server', message: 'No change', schedule: 'my-schedule', seconds: 2 }),
    entry(11, 8, 'settle', { on: 2, how: 'taken', text: 'Fixed in c5.' }),
    entry(12, 9, 'done', { run: 1, seen: 11, cost: 0.015 }),
  ];
  const b = [
    entry(1, 0, 'create'),
    entry(2, 1, 'comment', { thread: 'c2', item: null, ref: null, text: 'Another conversation.' }),
    entry(3, 0, 'comment', { thread: 'c2', parent: 2, text: 'Backwards clock.' }),
  ];
  const noteLog = [
    entry(1, 1, 'note', { text: 'Series note', files: ['files/source.txt'], see: { inst: 'a', label: 'A', thread: 'c2' } }),
    entry(2, 4, 'aside', { on: 1, text: 'Not needed.' }),
  ];
  for (const [id, entries] of [['a', a], ['b', b]] as const) {
    const dir = join(source, 'instances', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ series: 'book', label: id.toUpperCase() }));
    writeFileSync(join(dir, 'screen.json'), '{"rev":1,"status":"open","items":[]}');
    // Use old log spacing; even that projection should stay the same after opening the converted copy.
    writeFileSync(join(dir, 'log.jsonl'), entries.map(e => JSON.stringify(e).replace('{"seq":', '{ "seq": ')).join('\n') + '\n');
  }
  for (const [file, content] of Object.entries({
    '.rf/people/private/key': 'unrelated',
    'series/book/series.json': '{"version":1,"epoch":0,"since":""}',
    'series/book/notes/log.jsonl': jsonLines(noteLog),
    'series/book/notes/files/source.txt': 'note attachment',
    'instances/a/upload/attachments/figure.csv': 'a,b\n',
    'instances/a/working/process.md': 'working',
    'instances/a/session/main.jsonl': 'session',
    'instances/a/.git/HEAD': 'ref: refs/heads/main\n',
  })) {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  cpSync(source, copy, { recursive: true });
  const cli = (root: string, mode: '--dry-run' | '--apply') =>
    spawnSync(process.execPath, [script, '--stopped-copy', root, '--source', source, mode], { encoding: 'utf8', timeout: 5000 });
  return { tmp, source, copy, a, b, noteLog, cli };
}

// Exact envelope check at old v0.7.x startup; all later validation is behind it.
function oldStartup(root: string) {
  const data = JSON.parse(readFileSync(treeFile(root), 'utf8'));
  if (data?.format !== 'rollforward-series-owner' || data.version !== 1 || data.minReader !== '0.7.0' || data.state !== 'complete')
    throw new Error('old reader refuses this envelope');
}

test('dry run, conversion, deterministic order and byte parity of public logs', t => {
  const { source, copy, cli, a, b, noteLog } = fixture(t);
  const original = snapshotFiles(source), counts = { series: 1, instances: 2, messages: 11, notes: 2, instanceMessages: 9, events: 6, requests: 0 };
  oldStartup(source);
  assert.throws(() => checkAuthorityFormat(copy), /incompatible message format/);
  const dry = cli(copy, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { status: 'dry run', ...counts });
  assert.match(dry.stderr, /Preflight: validated 1 series, 2 instances/);
  assert.deepEqual(snapshotFiles(copy), original);
  const apply = cli(copy, '--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(JSON.parse(apply.stdout), { status: 'converted', ...counts });
  assert.match(apply.stderr, /Apply: writing canonical streams to the stopped copy/);
  assert.throws(() => oldStartup(copy), /old reader refuses/);
  checkAuthorityFormat(copy);
  openStore(copy);
  assert.deepEqual(instance('a').log, a);
  assert.deepEqual(instance('b').log, b);
  assert.deepEqual(notes(book(copy)), [{ ...noteLog[0], settled: noteLog[1] }]);
  assert.deepEqual(readEntries(notesFile(book(copy))), noteLog);
  assert.deepEqual(readEntries(eventsFile(book(copy), 'a')), [a[0], a[2], a[3], a[8], a[11]]);
  const records = messagesAt(book(copy));
  assert.deepEqual(records.map(m => [m.id, m.anchor.instance, m.entry.seq, m.kind]), [
    [1, undefined, 1, 'comment'], [2, 'a', 2, 'comment'], [3, 'b', 2, 'comment'], [4, 'b', 3, 'comment'],
    [5, 'a', 5, 'propose'], [6, 'a', 6, 'approve'], [7, undefined, 2, 'settle'], [8, 'a', 7, 'reject'],
    [9, 'a', 8, 'withdraw'], [10, 'a', 10, 'check'], [11, 'a', 11, 'settle'],
  ]);
  assert.deepEqual(records.at(-1)?.anchor, { instance: 'a', item: 'pack', ref: 'C4' });
  assert.deepEqual(records[5].entry, a[5]);
  const done = snapshotFiles(copy);
  for (const [path, data] of Object.entries(original)) if (path !== '.rf/tree.json') assert.equal(done[path], data, path);
  assert.deepEqual(snapshotFiles(source), original);
  assert.deepEqual(migrateMessageCopy(copy, true), { status: 'already converted', ...counts });
  assert.deepEqual(snapshotFiles(copy), done);

  const same = join(dirname(copy), 'second-copy');
  cpSync(source, same, { recursive: true });
  migrateMessageCopy(same, true);
  assert.deepEqual(snapshotFiles(same), done);
});

test('only historically open instance notes get the envelope flag', t => {
  const { copy } = fixture(t);
  const owner = 'owner@example.test', other = 'colleague@example.test';
  writeFileSync(join(book(copy), 'series.json'), JSON.stringify({ version: 1, owner, epoch: 8, since: at(0) }));
  const put = (id: string, log: Entry[], status = 'open') => {
    const dir = join(copy, 'instances', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ series: 'book', label: id }));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status, items: [] }));
    writeFileSync(join(dir, 'log.jsonl'), jsonLines(log));
  };
  const say = (seq: number, fields: object = {}) => entry(seq, seq, 'comment', { by: other, text: 'Test comment', thread: `c${seq}`, ...fields });
  const create = entry(1, 0, 'create', { by: owner });
  const lease = { authorityOwner: owner, authorityEpoch: 8 };
  const replyHistory = [
    create, ...Array.from({ length: 843 }, (_, i) => entry(i + 2, 1, 'item')),
    say(845), say(846, { by: owner, thread: 'c845', parent: 845, ...lease }), say(847),
  ];
  put('reply', replyHistory);
  put('seen', [create, say(2), say(3)]);
  const noMarker = [
    create, say(2, { by: 'agent', note: true }), entry(3, 3, 'duplicate'),
    say(4, { by: owner, ...lease }),
    say(5), entry(6, 6, 'done', { seen: 5 }),
    say(7, { authorityOwner: other, authorityEpoch: 7 }),
    say(8, { by: 'agent', ask: 'question', to: other, ...lease }),
    say(9, { parent: 8, thread: 'c8', ...lease }),
    say(10, { by: 'agent', ask: 'question', to: other, ...lease, authorityEpoch: 7 }),
    say(11, { parent: 10, thread: 'c10', ...lease }),
    say(12), entry(13, 13, 'settle', { on: 12, how: 'aside', text: 'Settled' }),
    say(14, { by: 'agent', note: true, see: { inst: 'reply', label: 'reply' }, runner: owner }),
    say(15, { by: 'agent' }),
    say(16, { by: 'agent', note: true }), entry(17, 17, 'resolve', { by: 'server', thread: 'c16' }),
    say(18, { by: 'agent', ask: 'proposal' }),
  ];
  put('unknown', noMarker);
  put('closed', [create, say(2), say(3, { by: 'agent', note: true })], 'closed');
  put('abandoned', [create, say(2)], 'abandoned');
  const markers = join(copy, '.rf', 'seen');
  mkdirSync(markers);
  writeFileSync(join(markers, `${owner}.json`), JSON.stringify({ since: at(2000), at: { a: 12, b: 3, seen: 2 } }));
  // Another person's marker, and the owner's since date, do not tell us that the owner opened "unknown".
  writeFileSync(join(markers, `${other}.json`), JSON.stringify({ since: at(0), at: { unknown: 18 } }));
  migrateMessageCopy(copy, true);
  openStore(copy);
  const rows = messagesAt(book(copy));
  assert.deepEqual(rows.filter(m => m.legacyOpen).map(m => [m.anchor.instance, m.entry.seq]).sort(), [
    ['reply', 847], ['seen', 3], ['unknown', 11], ['unknown', 14],
  ]);
  for (const [id, log] of [['reply', replyHistory], ['unknown', noMarker]] as const) {
    assert.equal(readFileSync(join(copy, 'instances', id, 'log.jsonl'), 'utf8'), jsonLines(log));
    for (const m of rows.filter(m => m.anchor.instance === id)) assert.equal(JSON.stringify(m.entry), JSON.stringify(log[m.entry.seq - 1]));
  }
});

test('a missing owner read-marker file does not mark a colleague’s note read', t => {
  const { copy } = fixture(t);
  writeFileSync(join(book(copy), 'series.json'), JSON.stringify({ version: 1, owner: 'owner@example.test', epoch: 1, since: at(0) }));
  const log = join(copy, 'instances/b/log.jsonl');
  writeFileSync(log, jsonLines([entry(1, 0, 'create', { by: 'owner@example.test' }), entry(2, 1, 'comment', { text: 'Unseen', thread: 'c2' })]));
  migrateMessageCopy(copy, true);
  openStore(copy);
  assert.equal(messagesAt(book(copy)).find(m => m.anchor.instance === 'b')?.legacyOpen, true);
});

test('nN note IDs and both legacy verdicts survive serialization', t => {
  const { copy } = fixture(t);
  const file = notesFile(book(copy));
  const log = [
    entry(1, 2, 'note', { text: 'First' }), entry(2, 1, 'note', { text: 'Second' }),
    entry(3, 3, 'taken', { on: 1, text: 'Done' }), entry(4, 4, 'aside', { on: 2, text: 'No change' }),
  ];
  writeFileSync(file, jsonLines(log));
  migrateMessageCopy(copy, true);
  openStore(copy);
  assert.deepEqual(notes(book(copy)), [{ ...log[0], settled: log[2] }, { ...log[1], settled: log[3] }]);
  assert.equal(readFileSync(file, 'utf8'), jsonLines(log));
  assert.equal(jsonLines(messagesAt(book(copy)).filter(m => !m.anchor.instance).map(m => m.entry)), jsonLines(log));
});

test('legacy scheduler requests keep their IDs, order, and canonical provenance', t => {
  const { copy, tmp } = fixture(t);
  const file = join(copy, '.rf', 'wakes.json');
  const pending = { weekly: { target: 'book', at: at(12), deadline: at(20), deadlineTarget: 'a', days: ['thu'], text: 'A wake' } };
  const fired = { a: at(2) };
  const wakes = { pending, fired, requests: {
    slot: { series: 'book', label: 'Next', from: 'requester@example.test', at: at(3) },
    targeted: { series: 'book', label: 'A', target: 'a', inst: 'b', from: 'runner@example.test', at: at(3), text: 'Request body' },
    earlier: { series: 'book', label: 'Later', from: 'requester@example.test', at: at(2) },
  } };
  writeFileSync(file, JSON.stringify(wakes));
  const before = snapshotFiles(copy), second = join(tmp, 'independent-copy');
  cpSync(copy, second, { recursive: true });
  const counts = { series: 1, instances: 2, messages: 14, notes: 2, instanceMessages: 9, events: 6, requests: 3 };
  assert.deepEqual(migrateMessageCopy(copy), { status: 'dry run', ...counts });
  assert.deepEqual(snapshotFiles(copy), before);
  assert.deepEqual(migrateMessageCopy(copy, true), { status: 'converted', ...counts });
  assert.deepEqual(migrateMessageCopy(second, true), { status: 'converted', ...counts });
  assert.deepEqual(snapshotFiles(second), snapshotFiles(copy));
  openStore(copy);
  const requests = messagesAt(book(copy)).filter(m => m.entry.op === 'request');
  assert.deepEqual(requests.map(({ anchor, entry }) => ({ anchor, entry })), [
    { anchor: {}, entry: { seq: 1, at: at(3), op: 'request', requestId: 'slot', label: 'Next', from: wakes.requests.slot.from, by: wakes.requests.slot.from } },
    { anchor: { instance: 'a' }, entry: { seq: 1, at: at(3), op: 'request', requestId: 'targeted', label: 'A', source: 'b', from: wakes.requests.targeted.from, by: 'agent', text: wakes.requests.targeted.text } },
    { anchor: {}, entry: { seq: 1, at: at(2), op: 'request', requestId: 'earlier', label: 'Later', from: wakes.requests.earlier.from, by: wakes.requests.earlier.from } },
  ]);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(state.requests), Object.keys(wakes.requests));
  assert.deepEqual(state, { pending, fired, requests: {
    slot: { series: 'book', label: 'Next', message: requests[0].id },
    targeted: { series: 'book', label: 'A', inst: 'b', target: 'a', message: requests[1].id },
    earlier: { series: 'book', label: 'Later', message: requests[2].id },
  } });
  const after = snapshotFiles(copy);
  assert.deepEqual(migrateMessageCopy(copy, true), { status: 'already converted', ...counts });
  assert.deepEqual(snapshotFiles(copy), after);

  for (const patch of [{ message: requests[0].id }, { message: requests[2].id + 100 }, { inst: 'a' }, { label: 'Different' }]) {
    writeFileSync(file, JSON.stringify({ ...state, requests: { ...state.requests, targeted: { ...state.requests.targeted, ...patch } } }));
    const mismatch = snapshotFiles(copy);
    assert.throws(() => migrateMessageCopy(copy, true), /invalid request reference/);
    assert.deepEqual(snapshotFiles(copy), mismatch);
  }
  const rows = messagesAt(book(copy)), decided = requests[1];
  const decision = storedMessage(rows.at(-1)!.id + 1, decided.anchor,
    entry(1, 12, 'request-decision', { requestId: 'targeted', request: decided.id, how: 'dismissed' }));
  writeFileSync(messagesFile(book(copy)), jsonLines([...rows.filter(m => m.id !== decided.id), decision]));
  writeFileSync(file, JSON.stringify(state));
  const stale = snapshotFiles(copy);
  assert.deepEqual(migrateMessageCopy(copy, true), { status: 'already converted', ...counts, requests: 2 });
  assert.deepEqual(snapshotFiles(copy), stale);
});

test('legacy requests for or from a tombstone drop their bodies, but corrupt scheduler state refuses conversion', t => {
  const { copy } = fixture(t), file = join(copy, '.rf', 'wakes.json');
  writeFileSync(join(copy, 'instances/b/log.jsonl'), jsonLines([entry(5, 4, 'delete')]));
  const keep = { series: 'book', label: 'Next', from: 'person@example.test', at: at(3) };
  const pending = {}, fired = {}, requests = {
    keep, oldTarget: { ...keep, label: 'B', target: 'b', text: 'Removed target' },
    oldSlot: { ...keep, label: 'B', text: 'Removed slot' },
    oldSource: { ...keep, inst: 'b', text: 'Removed source' },
  };
  for (const [broken, error] of [
    ['{"requests":{"request":{"text":"Private fixture text" broken}}}', /invalid scheduler state/],
    [JSON.stringify({ pending, fired, requests: { ...requests, unknown: { ...keep, inst: 'missing' } } }), /invalid scheduler request/],
  ] as const) {
    writeFileSync(file, broken);
    const before = snapshotFiles(copy);
    assert.throws(() => migrateMessageCopy(copy, true), e => e instanceof Error && error.test(e.message) && !e.message.includes('Private fixture text'));
    assert.deepEqual(snapshotFiles(copy), before);
  }
  writeFileSync(file, JSON.stringify({ pending, fired, requests }));
  assert.equal(migrateMessageCopy(copy, true).requests, 1);
  const converted = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(converted.requests), ['keep']);
  assert.doesNotMatch(readFileSync(messagesFile(book(copy)), 'utf8'), /Removed (target|slot|source)/);
  converted.requests.oldSlot = { series: 'book', label: 'B', message: 100 };
  writeFileSync(file, JSON.stringify(converted));
  const stale = snapshotFiles(copy);
  assert.equal(migrateMessageCopy(copy, true).requests, 1, 'a matching tombstone explains a missing row');
  assert.deepEqual(snapshotFiles(copy), stale);
});

test('legacy pinned objects and local or sibling upload/working paths preserve entry bytes', t => {
  const { copy, b } = fixture(t);
  const path = join(copy, 'instances/b/log.jsonl');
  const e = { ...b[1], files: [
    { inst: 'a', path: 'working/report.csv', sha256: 'a'.repeat(64) }, { inst: 'gone', path: 'upload/old.csv' },
    'upload/input.csv', 'working/local.csv',
    '../w1/upload/data process 2026-10-20.mp4', '../Candy update/working/2604 对税.xlsx',
  ] };
  for (const invalid of ['working/../secret', 'upload/dir/', 'working/bad\\name', '/working/file',
    '../../other/upload/a.csv', '.././upload/a.csv', '../a/session/run', '../a/upload/../secret', '../upload/a.csv', '../a/upload/',
    { inst: '../a', path: 'upload/a' }, { inst: 'a', path: 'working/a', sha256: 'broken' }, { inst: 'a', path: '../a' }, { inst: 'a', path: 'session/run' }]) {
    writeFileSync(path, jsonLines([b[0], { ...e, files: [invalid] }]));
    const before = snapshotFiles(copy);
    assert.throws(() => migrateMessageCopy(copy, true), /invalid message attachment/);
    assert.deepEqual(snapshotFiles(copy), before);
  }
  writeFileSync(path, jsonLines([b[0], e, b[2]]));
  migrateMessageCopy(copy, true);
  openStore(copy);
  assert.equal(JSON.stringify(instance('b').log[1]), JSON.stringify(e));
  assert.equal(JSON.stringify(messagesAt(book(copy)).find(m => m.anchor.instance === 'b')?.entry), JSON.stringify(e));
  assert.equal(readFileSync(path, 'utf8'), jsonLines([b[0], e, b[2]]));
});

test('run prompts only present migrated pins whose bytes still match in the captured view', t => {
  const { copy, b } = fixture(t), owner = b[0].by;
  writeFileSync(join(book(copy), 'series.json'), JSON.stringify({ version: 1, owner, epoch: 1, since: at(0) }));
  const bytes = Buffer.alloc(64 * 1024 + 1, 0xff);
  const pin = { inst: 'a', path: 'working/report.csv', sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase() };
  const report = join(copy, 'instances/a', pin.path);
  writeFileSync(report, bytes);
  const legacy = { inst: 'a', path: 'working/process.md' }, local = 'upload/input.csv';
  mkdirSync(join(copy, 'instances/b/upload'));
  writeFileSync(join(copy, 'instances/b', local), 'input');
  const files = [pin, legacy, local, '../A/upload/legacy.csv', { ...pin, path: 'working/missing.csv' }, { ...pin, inst: 'gone' }];
  writeFileSync(join(copy, 'instances/b/log.jsonl'), jsonLines([
    b[0], { ...b[1], by: 'agent', note: true, run: 1, runner: owner, text: 'Historical advice', files },
    { ...b[2], thread: 'c3', parent: undefined, files },
  ]));
  migrateMessageCopy(copy, true);
  openStore(copy);
  initSystem(copy);
  const lease = { version: 1 as const, owner, epoch: 1, workspace: 'w', logins: [], autonomous: false };
  const i = instance('b'), { names } = view(i, lease), atA = '/work/Workspace/Book/A';
  assert.equal(names[atA], 'a');
  const open = openNotes(seriesConversation(i.seriesId).notes, i.id);
  assert.deepEqual(open.map(n => n.id), ['c2']);
  const show = (captured = names) => {
    const [intro, log] = message(i, 1, [i.log[2]], false, open, lease, captured).split(' New log entries:\n');
    return { advice: intro.split('"Historical advice"')[1], files: JSON.parse(log).files };
  };
  assert.deepEqual(show(), { advice: `, ${atA}/${pin.path}, ${atA}/${legacy.path}, ${local}.`, files: [pin, legacy, local] });
  bytes[bytes.length - 1] = 0xfe; // Same path and size, different bytes.
  writeFileSync(report, bytes);
  assert.deepEqual(show(), { advice: `, ${atA}/${legacy.path}, ${local}.`, files: [legacy, local] }, 'changed bytes are not the pin');
  rmSync(report);
  assert.deepEqual(show(), { advice: `, ${atA}/${legacy.path}, ${local}.`, files: [legacy, local] });
  bytes[bytes.length - 1] = 0xff;
  writeFileSync(report, bytes);
  assert.deepEqual(show({ '/work/Workspace/Book/B': 'b' }), { advice: `, ${local}.`, files: [local] }, 'current reach does not expand the captured view');
  assert.deepEqual(i.log[1].files, files, 'prompt presentation does not rewrite history');
  assert.deepEqual(i.log[2].files, files);
});

test('live HTTP only admits paths from the attachment upload directory after conversion', { timeout: 10_000 }, async t => {
  const { copy, tmp } = fixture(t);
  migrateMessageCopy(copy, true);
  const dir = join(copy, 'instances/b');
  mkdirSync(join(dir, 'working'), { recursive: true });
  writeFileSync(join(dir, 'working/report.csv'), 'report');
  mkdirSync(join(tmp, 'agent/usr'), { recursive: true });
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port, base = `http://127.0.0.1:${port}`, admin = 'admin@example.test';
  await new Promise<void>(ok => probe.close(() => ok()));
  const entra = await idp();
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/server.ts'), copy, String(port)], {
    env: { PATH: process.env.PATH, HOME: tmp, RF_AGENT_ROOT: join(tmp, 'agent'), RF_SCRATCH: join(tmp, 'scratch'),
      RF_ADMINS: admin, RF_MAX_RUNS: '0', ...entra.env(base) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    entra.close();
  });
  let errors = '';
  child.stderr.on('data', d => { errors += d; });
  await new Promise<void>((ok, fail) => {
    child.stdout.on('data', d => { if (String(d).includes('rollforward on')) ok(); });
    child.once('exit', code => fail(new Error(`server exited ${code}: ${errors}`)));
    child.once('error', fail);
  });

  const signedIn = await entra.signIn(base, admin);
  const cookie = signedIn.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0];
  assert.ok(cookie);
  const post = (route: string, body: string) => fetch(base + route, { method: 'POST', body, headers: { cookie } });
  const uploaded = await post('/api/instances/b/attach?name=added.csv', 'new');
  assert.equal(uploaded.status, 200);
  const { file } = await uploaded.json();
  assert.equal(file, 'upload/attachments/added.csv');
  for (const files of [['working/report.csv'], [{ inst: 'b', path: file }], ['upload/attachments/missing.csv'], ['upload/attachments/../added.csv']]) {
    const r = await post('/api/messages', JSON.stringify({ instance: 'b', text: 'New comment', files, quiet: true }));
    assert.equal(r.status, 400);
    assert.match(await r.text(), /no attachment/);
  }
  assert.equal((await post('/api/messages', JSON.stringify({ instance: 'b', text: 'New comment', files: [file], quiet: true }))).status, 200);
  assert.deepEqual(readEntries(join(dir, 'log.jsonl')).filter(e => e.op === 'comment').at(-1)?.files, [file]);
});

test('a legacy tombstone retains wake-check audit, not bodies, and startup completes deletion', t => {
  const { copy } = fixture(t);
  const dir = join(copy, 'instances/a'), log = join(dir, 'log.jsonl');
  const audit = { seq: 10, by: 'server', at: at(7), schedule: 'weekly' };
  const cut = entry(13, 10, 'delete', { cost: 0, runs: [], wakeChecks: [{ ...audit, message: 'Do not retain this' }] });
  writeFileSync(log, jsonLines([cut]));
  migrateMessageCopy(copy, true);
  assert.deepEqual(readEntries(eventsFile(book(copy), 'a')), [{ ...cut, wakeChecks: [audit] }]);
  assert.deepEqual(readEntries(log), readEntries(eventsFile(book(copy), 'a')));
  openStore(copy);
  assert.equal(messagesAt(book(copy)).some(m => m.anchor.instance === 'a'), false);
  assert.equal(instance('a').doc.status, 'deleted');
  assert.deepEqual(readdirSync(dir).sort(), ['instance.json', 'log.jsonl', 'screen.json']);
});

test('invalid, linked and partially converted inputs refuse without any writes', t => {
  const { source, copy, cli } = fixture(t);
  const log = join(copy, 'instances/a/log.jsonl'), intact = readFileSync(log);
  assert.match(cli(source, '--apply').stderr, /COPY must be separate/);
  for (const [rows, error] of [
    [Buffer.concat([intact, Buffer.from('{"seq":')]), /torn last line/],
    [Buffer.concat([intact, Buffer.from('{bad}\n')]), /invalid JSONL/],
    [Buffer.from(jsonLines([...readEntries(log), entry(4, 10, 'comment', { text: 'Duplicate seq' })])), /invalid instance sequence/],
    [Buffer.from(jsonLines(readEntries(log).filter(e => e.op !== 'comment' || e.seq !== 5))), /invalid instance sequence/],
  ] as const) {
    writeFileSync(log, rows);
    const before = snapshotFiles(copy);
    assert.throws(() => migrateMessageCopy(copy, true), error);
    assert.deepEqual(snapshotFiles(copy), before);
    writeFileSync(log, intact);
  }
  const notes = notesFile(book(copy)), notesIntact = readFileSync(notes);
  writeFileSync(notes, jsonLines(readEntries(notes).map(e => e.seq === 2 ? { ...e, seq: 3 } : e)));
  const noteGap = snapshotFiles(copy);
  assert.throws(() => migrateMessageCopy(copy, true), /invalid series note sequence/);
  assert.deepEqual(snapshotFiles(copy), noteGap);
  writeFileSync(notes, notesIntact);
  rmSync(log);
  linkSync(join(source, 'instances/a/log.jsonl'), log);
  assert.throws(() => migrateMessageCopy(copy, true), /no links/);
  rmSync(log);
  symlinkSync(join(source, 'instances/a/log.jsonl'), log);
  assert.throws(() => migrateMessageCopy(copy, true), /no links/);
  rmSync(log);
  writeFileSync(log, intact);
  writeFileSync(messagesFile(book(copy)), '');
  const partial = snapshotFiles(copy);
  assert.throws(() => migrateMessageCopy(copy, true), /unsafe or partial conversion/);
  assert.deepEqual(snapshotFiles(copy), partial);
});

test('a failure after the incomplete fence blocks both startup gates and repeat conversion', t => {
  const { tmp, source, copy } = fixture(t);
  mkdirSync(join(tmp, 'agent/usr'), { recursive: true });
  const gate = () => spawnSync(process.execPath, [join(import.meta.dirname, '../src/server.ts'), copy, '0'], {
    env: { PATH: process.env.PATH, HOME: tmp, RF_AGENT_ROOT: join(tmp, 'agent'), RF_SCRATCH: join(tmp, 'scratch') },
    encoding: 'utf8', timeout: 5000,
  });
  const log = notesFile(book(copy));
  writeFileSync(log, jsonLines([entry(1, 1, 'note', { text: 'x'.repeat(4096) })]));
  const legacy = snapshotFiles(copy), newReader = gate();
  assert.equal(newReader.status, 1, newReader.stderr);
  assert.match(newReader.stderr, /incompatible message format/);
  assert.deepEqual(snapshotFiles(copy), legacy);
  const interrupted = spawnSync('bash', ['-c', 'trap "" XFSZ; ulimit -f 1; exec "$@"', 'limited',
    process.execPath, script, '--stopped-copy', copy, '--source', source, '--apply'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.match(interrupted.stderr, /file too large|EFBIG/i);
  const manifest = JSON.parse(readFileSync(treeFile(copy), 'utf8'));
  assert.equal(manifest.minReader, '0.8.0');
  assert.equal(manifest.state, 'incomplete');
  const partial = snapshotFiles(copy);
  assert.throws(() => oldStartup(copy), /old reader refuses/);
  assert.throws(() => checkAuthorityFormat(copy), /incomplete data conversion/);
  assert.throws(() => migrateMessageCopy(copy, true), /incomplete message conversion/);
  const blocked = gate();
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /incomplete data conversion/);
  assert.deepEqual(snapshotFiles(copy), partial);
});

test('interruption while replacing scheduler state leaves only a blocked copy', t => {
  const { source, copy } = fixture(t);
  const file = join(copy, '.rf', 'wakes.json');
  const old = JSON.stringify({ pending: { weekly: { target: 'book', at: at(10), deadline: at(20), text: 'x'.repeat(8_192) } },
    fired: {}, requests: { one: { series: 'book', label: 'Next', from: 'person@example.test', at: at(2), text: 'Request' } } });
  writeFileSync(file, old);
  const interrupted = spawnSync('bash', ['-c', 'trap "" XFSZ; ulimit -f 4; exec "$@"', 'limited',
    process.execPath, script, '--stopped-copy', copy, '--source', source, '--apply'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.match(interrupted.stderr, /file too large|EFBIG/i);
  assert.equal(JSON.parse(readFileSync(treeFile(copy), 'utf8')).state, 'incomplete');
  assert.ok(messagesAt(book(copy)).some(m => m.entry.op === 'request' && m.entry.requestId === 'one'));
  assert.equal(readFileSync(file, 'utf8'), old);
  assert.throws(() => oldStartup(copy), /old reader refuses/);
  assert.throws(() => checkAuthorityFormat(copy), /incomplete data conversion/);
  const before = snapshotFiles(copy);
  assert.throws(() => migrateMessageCopy(copy, true), /incomplete message conversion/);
  assert.deepEqual(snapshotFiles(copy), before);
});
