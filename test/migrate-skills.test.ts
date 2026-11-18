import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { migrateMessageCopy } from '../scripts/migrate-messages.ts';
import { openSkills, pushSkill } from '../src/skills.ts';
import { writeLegacyFixtureTree } from './owner-fixture.ts';

const script = join(import.meta.dirname, '../scripts/migrate-messages.ts');
const check = (root: string) => spawnSync(process.execPath,
  [join(import.meta.dirname, '../scripts/migrate-skills.ts'), '--check', root], { encoding: 'utf8', timeout: 5000 });
const skill = (root: string, part: string) => join(root, 'skills', part);
const doc = '---\nname: report\ndescription: An example\n---\n';
const tree = { workspaces: { w: { name: 'Workspace', owners: [], members: [] } }, series: { book: { name: 'Book', workspace: 'w' } } };

function fixture(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-migrate-skills-')), source = join(tmp, 'original'), copy = join(tmp, 'copy');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(source, '.rf'), { recursive: true });
  mkdirSync(join(source, 'series/book'), { recursive: true });
  mkdirSync(join(source, 'instances/period/working'), { recursive: true });
  writeLegacyFixtureTree(source, tree);
  writeFileSync(join(source, 'series/book/series.json'), '{"version":1,"epoch":0,"since":""}');
  writeFileSync(join(source, 'instances/period/instance.json'), '{"series":"book","label":"Period"}');
  writeFileSync(join(source, 'instances/period/log.jsonl'), '{"seq":1,"at":"2026-01-01T00:00:00Z","op":"create","by":"server"}\n');
  writeFileSync(join(source, 'instances/period/working/process.md'), '```sh\nrf say "Not a published skill"\n```\n');
  openSkills(source);
  const push = (id: string, files: Record<string, string | Buffer>) =>
    pushSkill(id, Object.fromEntries(Object.entries(files).map(([p, raw]) => [p, Buffer.from(raw).toString('base64')])), 'author@example.test');
  const stop = () => cpSync(source, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const cli = (mode: '--dry-run' | '--apply') =>
    spawnSync(process.execPath, [script, '--stopped-copy', copy, '--source', source, mode], { encoding: 'utf8', timeout: 5000 });
  return { source, copy, push, stop, cli };
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(e => {
    const p = join(e.parentPath, e.name);
    return [p.slice(root.length + 1), lstatSync(p).mode, e.isSymbolicLink() ? readlinkSync(p) : e.isFile() ? readFileSync(p).toString('base64') : null];
  }).sort();
}

const prose = 'Our staff may say or ask in reports. Do not replace business prose like rf propose more study.\n';
const originalDoc = doc + prose + 'Use `rf ask --in c8 --to "reviewer@example.test" "All good?"` to check.\n\n' +
  '```bash\nrf propose --on "ledger@Payables!B2" "File it?"\nrf withdraw c12 --see c14 "Now answered"\n```\n\n' +
  '```sh\nrf note ../../"Next month" "A note"\n```\n';
const newDoc = doc + prose + 'Use `rf comment . --ask --in c8 --to "reviewer@example.test" "All good?"` to check.\n\n' +
  '```bash\nrf comment . --propose --on "ledger@Payables!B2" "File it?"\nrf settle c12 withdrawn --see c14 "Now answered"\n```\n\n' +
  '```sh\nrf comment ../../"Next month" "A note"\n```\n';
const oldShell = '#!/bin/sh\n# rf say leave this example in the comment\n' +
  'printf "%s\\n" "business rf say; this isn\'t code" && rf say --at \'../Previous period\' --on \'sheet@A7\' "Keep; this"; rf say --in c4 - < note.md\n' +
  'rf note --taken n2 --see c7 \'See c7\' | tee outcomes\nrf note --aside n3 "Not needed"\n';
const newShell = '#!/bin/sh\n# rf say leave this example in the comment\n' +
  'printf "%s\\n" "business rf say; this isn\'t code" && rf comment \'../Previous period\' --on \'sheet@A7\' "Keep; this"; rf comment . --in c4 - < note.md\n' +
  'rf settle n2 taken --see c7 \'See c7\' | tee outcomes\nrf settle n3 aside "Not needed"\n';

test('offline converter publishes only rewritten live skill versions and leaves read-only inputs alone', t => {
  const { source, copy, push, stop, cli } = fixture(t);
  push('report', { 'SKILL.md': doc + '`rf say "Historical"`\n' });
  push('report', { 'SKILL.md': originalDoc, 'bin/run.sh': oldShell, 'bin/raw.dat': Buffer.from([0x00, 0xff, 0x0d, 0x0a]), 'other.md': prose });
  push('no-change', { 'SKILL.md': doc + prose + '`rf show` and `rf correct ../prior --wrong "Wrong"`.\n' +
    'For people: `rf note "Workspace/Book" "A note"` or `rf note "Workspace/Book" --json`.\n' });
  chmodSync(skill(source, 'versions/report/2/bin'), 0o751);
  chmodSync(skill(source, 'versions/report/2/bin/run.sh'), 0o750);
  chmodSync(skill(source, 'versions/report/2/bin/raw.dat'), 0o640);
  mkdirSync(skill(source, 'versions/report/3')); // A previous push stopped before its marker/pointer.
  stop();
  const before = snapshot(copy), original = snapshot(source);
  const planned = check(source);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stderr, /Skills: 2 live, 1 to rewrite\n.*report: 2 -> 4/);
  const [bytes, entries] = planned.stdout.trimEnd().split(' ').map(Number);
  assert.ok(bytes >= Buffer.byteLength(newDoc + newShell + prose));
  assert.equal(entries, 8, 'six files and directories plus the publication marker and live link');
  assert.deepEqual(snapshot(source), original);
  const dry = cli('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /Skills: 2 live, 1 to rewrite\n.*report: 2 -> 4/);
  assert.deepEqual(JSON.parse(dry.stdout), { status: 'dry run', series: 1, instances: 1, messages: 0, notes: 0, instanceMessages: 0, events: 1, requests: 0 });
  assert.deepEqual(snapshot(copy), before);
  const apply = cli('--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(readlinkSync(skill(copy, 'live/report')), '../versions/report/4');
  assert.deepEqual(snapshot(copy).filter(([p]) => /^skills\/versions\/(?!report\/4(?:\/|$))/.test(p as string)),
    before.filter(([p]) => /^skills\/versions\//.test(p as string)));
  const latest = skill(copy, 'versions/report/4');
  assert.equal(readFileSync(join(latest, 'SKILL.md'), 'utf8'), newDoc);
  assert.equal(readFileSync(join(latest, 'bin/run.sh'), 'utf8'), newShell);
  assert.equal(readFileSync(join(latest, 'other.md'), 'utf8'), prose);
  assert.deepEqual(readFileSync(join(latest, 'bin/raw.dat')), Buffer.from([0x00, 0xff, 0x0d, 0x0a]));
  for (const [p, mode] of [['bin', 0o751], ['bin/run.sh', 0o750], ['bin/raw.dat', 0o640]] as const)
    assert.equal(lstatSync(join(latest, p)).mode & 0o777, mode);
  const marker = JSON.parse(readFileSync(join(latest, '.pushed.json'), 'utf8'));
  assert.deepEqual(marker, { version: 4, by: 'rf v0.8.0 migration', at: new Date(marker.at).toISOString() });
  assert.equal(readlinkSync(skill(copy, 'live/no-change')), '../versions/no-change/1');
  assert.equal(readFileSync(join(copy, 'instances/period/working/process.md'), 'utf8'), '```sh\nrf say "Not a published skill"\n```\n');
  assert.deepEqual(snapshot(source), original);
  const after = snapshot(copy), repeat = cli('--apply');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).status, 'already converted');
  assert.match(repeat.stderr, /Skills: 2 live, 0 to rewrite/);
  assert.deepEqual(snapshot(copy), after);
});

test('checks standalone inline asks, bare prose and untagged fences; only explicit check shows the patch', t => {
  const { source, copy, push, stop, cli } = fixture(t);
  const business = 'In this example, rf propose more study; staff at rf ask about SAMPLE_PLAN.\r\n';
  const old = doc + business + 'Use `rf ask` your runner, or `rf ask --to "runner@example.test" "SAMPLE_QUESTION"`.\r\n' +
    '```\r\nrf ask \\\r\n  "SAMPLE_FENCE"\r\n```\r\n\r\nFinally, `rf ask`.';
  const expected = doc + business + 'Use `rf comment . --ask` your runner, or `rf comment . --ask --to "runner@example.test" "SAMPLE_QUESTION"`.\r\n' +
    '```\r\nrf comment . --ask "SAMPLE_FENCE"\r\n```\r\n\r\nFinally, `rf comment . --ask`.';
  push('report', { 'SKILL.md': old, 'bin/end of file.sh': 'rf ask "SAMPLE_LAST"' });
  stop();
  const before = snapshot(source);
  const preview = check(source);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^\d+ \d+\n$/);
  assert.deepEqual(snapshot(source), before);
  const reported = preview.stderr.split('\n').filter(line => line.startsWith('Occurrence '));
  assert.deepEqual(reported.map(line => line.match(/SKILL\.md:(\d+:\d+) ("rf \w+")/)?.slice(1)), [
    ['5:18', '"rf propose"'], ['5:50', '"rf ask"'], ['6:6', '"rf ask"'], ['6:31', '"rf ask"'], ['8:1', '"rf ask"'], ['12:11', '"rf ask"'], undefined,
  ]);
  assert.match(reported[0], /unchanged.*text/i);
  assert.match(reported[1], /unchanged.*text/i);
  const patch = preview.stderr.slice(preview.stderr.indexOf('--- a/'));
  const checked = spawnSync('git', ['apply', '--unidiff-zero', '--whitespace=nowarn', '-'],
    { cwd: copy, input: patch, encoding: 'utf8', timeout: 5000 });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(readFileSync(skill(copy, 'versions/report/1/SKILL.md'), 'utf8'), expected);
  assert.equal(readFileSync(skill(copy, 'versions/report/1/bin/end of file.sh'), 'utf8'), 'rf comment . --ask "SAMPLE_LAST"');
  writeFileSync(skill(copy, 'versions/report/1/SKILL.md'), old);
  writeFileSync(skill(copy, 'versions/report/1/bin/end of file.sh'), 'rf ask "SAMPLE_LAST"');
  for (const mode of ['--dry-run', '--apply'] as const) {
    const result = cli(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Occurrence|^---|^@@|SAMPLE_|runner@example\.test/m);
  }
  assert.equal(readFileSync(skill(copy, 'versions/report/2/SKILL.md'), 'utf8'), expected);
  assert.deepEqual(snapshot(source), before);
});

test('an author can replace the unsupported approval instruction on v0.7.9 before migration', t => {
  const { source, copy, push, stop, cli } = fixture(t);
  push('report', { 'SKILL.md': doc + 'Before the sample action, `rf ask --sign-off` with the record ID.\n' });
  push('report', { 'SKILL.md': doc + 'Before the sample action, `rf propose` with the record ID.\n' });
  stop();
  const preview = check(source);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stderr, /^\+Before the sample action, `rf comment \. --propose` with the record ID\.$/m);
  const apply = cli('--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(readFileSync(skill(copy, 'versions/report/3/SKILL.md'), 'utf8'), /`rf comment \. --propose`/);
  assert.match(readFileSync(skill(copy, 'versions/report/1/SKILL.md'), 'utf8'), /`rf ask --sign-off`/);
});

test('unknown asks block writes but explicit check still reports all supported edits', t => {
  const { source, copy, push, stop, cli } = fixture(t);
  push('report', {
    'SKILL.md': doc + 'Before the sample action, `rf ask --sign-off` with SAMPLE_APPROVAL.\n' +
      'For its sample ID, `rf ask`.\n\nrf ask --sign-off "SAMPLE_BARE"\n',
    'bin/run.sh': 'rf ask "SAMPLE_OTHER"\n',
    'instructions.txt': 'Before the sample action use rf ask --sign-off in SAMPLE_TASK.\nElse use rf propose --unknown in SAMPLE_TASK.\n',
  });
  stop();
  const before = snapshot(copy);
  const preview = check(source);
  assert.equal(preview.status, 1, preview.stderr);
  assert.equal(preview.stdout, '');
  assert.match(preview.stderr, /SKILL\.md:5:\d+ .*refused.*--sign-off.*rf comment \. --propose TEXT.*--ask/i);
  assert.match(preview.stderr, /SKILL\.md:8:1 .*refused.*--sign-off/i);
  assert.match(preview.stderr, /SKILL\.md:6:\d+ .*rewrite/i);
  assert.match(preview.stderr, /bin\/run\.sh:1:1 .*rewrite/i);
  assert.match(preview.stderr, /instructions\.txt:1:\d+ .*refused.*--sign-off/i);
  assert.match(preview.stderr, /instructions\.txt:2:\d+ .*refused/i);
  assert.match(preview.stderr, /^\+For its sample ID, `rf comment \. --ask`\.$/m);
  assert.match(preview.stderr, /^\+rf comment \. --ask "SAMPLE_OTHER"$/m);
  assert.doesNotMatch(preview.stderr, /^\+.*(?:--sign-off|--propose)/m);
  const patch = preview.stderr.slice(preview.stderr.indexOf('--- a/'));
  const checked = spawnSync('git', ['apply', '--check', '--unidiff-zero', '--whitespace=nowarn', '-'],
    { cwd: copy, input: patch, encoding: 'utf8', timeout: 5000 });
  assert.equal(checked.status, 0, checked.stderr);
  for (const mode of ['--dry-run', '--apply'] as const) {
    const result = cli(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /report SKILL\.md:5\nreport SKILL\.md:8/);
    assert.match(result.stderr, /report instructions\.txt:1\nreport instructions\.txt:2/);
    assert.doesNotMatch(result.stderr, /Occurrence|^---|^@@|SAMPLE_/m);
  }
  assert.deepEqual(snapshot(copy), before);
  assert.deepEqual(snapshot(source), before);
});

for (const definition of ['function rf {', 'rf() {']) {
  test(`refuses a file defining ${definition} without rewriting or running it`, t => {
    const { source, copy, push, stop, cli } = fixture(t);
    const sentinel = join(source, 'should-not-exist');
    push('report', { 'SKILL.md': doc, 'run.sh': `#!/bin/bash\n${definition}\n  touch '${sentinel}'\n}\nrf ask "SAMPLE_LOCAL"\n` });
    stop();
    const before = snapshot(copy);
    const preview = check(source);
    assert.equal(preview.status, 1, preview.stderr);
    assert.equal(preview.stdout, '');
    assert.match(preview.stderr, /run\.sh:2:\d+ .*refused.*shell-local/i);
    assert.match(preview.stderr, /run\.sh:5:1 .*unchanged.*shell-local/i);
    assert.doesNotMatch(preview.stderr, /^---|^@@|SAMPLE_LOCAL|should-not-exist/m);
    const apply = cli('--apply');
    assert.equal(apply.status, 1, apply.stderr);
    assert.deepEqual(snapshot(copy), before);
    assert.deepEqual(snapshot(source), before);
  });
}

test('refuses unresolved run forms before writing anything and reports only their locations outside explicit check', t => {
  const { copy, source, push, stop, cli } = fixture(t);
  push('a-ready', { 'SKILL.md': doc + '`rf say "Safe"`\n' });
  push('z-review', { 'SKILL.md': doc, 'run.sh': '#!/bin/sh\nrf say --at "$SECRET_TARGET" "PRIVATE_PAYLOAD"\n' +
    'command -- rf "$SECRET_VERB" "PRIVATE_PAYLOAD"\n' +
    'node /app/src/rf.ts say "PRIVATE_PAYLOAD"\n' +
    'rf propose --at ../Other "PRIVATE_PAYLOAD"\n' +
    'bash -c \'rf "$SECRET_VERB" "PRIVATE_PAYLOAD"\'\n',
  'call.py': 'import subprocess\nsubprocess.run(["rf", "ask", "PRIVATE_PAYLOAD"])\n' });
  stop();
  const before = snapshot(copy);
  for (const result of [check(source), cli('--dry-run'), cli('--apply')]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.stderr.trimEnd().split('\n').filter(line => line.startsWith('z-review ')), [
      'z-review call.py:2', 'z-review run.sh:2', 'z-review run.sh:3', 'z-review run.sh:4', 'z-review run.sh:5', 'z-review run.sh:6',
    ]);
    assert.doesNotMatch(result.stderr, /SECRET_TARGET|SECRET_VERB|PRIVATE_PAYLOAD/);
    assert.deepEqual(snapshot(copy), before);
    assert.deepEqual(snapshot(source), before);
  }
});

test('commands are rewritten without executing shell syntax or changing compound boundaries', t => {
  const { push, stop, copy, cli } = fixture(t);
  const old = '#!/bin/bash\nif test -f exists; then (rf \'say\' ' + '\\' + '\n  :); else rf ask - < text; fi\n' +
    'rf say - <<\'END\'\n$(rf ask do not interpret data)\nEND\n' +
    'false || RF_TEMP=x command rf withdraw c7 "--literal option text" && echo "rf say unchanged"\n';
  push('script', { 'SKILL.md': doc, run: old });
  stop();
  const result = cli('--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(skill(copy, 'versions/script/2/run'), 'utf8'), '#!/bin/bash\n' +
    'if test -f exists; then (rf comment . :); else rf comment . --ask - < text; fi\n' +
    'rf comment . - <<\'END\'\n$(rf ask do not interpret data)\nEND\n' +
    'false || RF_TEMP=x command rf settle c7 withdrawn -- "--literal option text" && echo "rf say unchanged"\n');
});

test('a converted copy is no longer a skill migration target', t => {
  const { copy, stop, cli } = fixture(t);
  stop();
  assert.equal(cli('--apply').status, 0);
  openSkills(copy);
  pushSkill('report', { 'SKILL.md': Buffer.from(doc + '`rf say "Later push"`\n').toString('base64') }, 'author@example.test');
  const before = snapshot(copy);
  assert.match(cli('--apply').stderr, /still needs skill migration/);
  assert.deepEqual(snapshot(copy), before);
});

test('a stale skill plan cannot reopen a now-complete copy', t => {
  const { copy, push, stop } = fixture(t);
  push('report', { 'SKILL.md': doc + '`rf say "Old wording"`\n' });
  stop();
  let finished: ReturnType<typeof snapshot> | undefined;
  assert.throws(() => migrateMessageCopy(copy, true, line => {
    if (line.startsWith('Apply:')) {
      assert.equal(migrateMessageCopy(copy, true).status, 'converted');
      finished = snapshot(copy);
    }
  }), /stopped copy changed during preflight/);
  assert.deepEqual(snapshot(copy), finished);
  assert.equal(migrateMessageCopy(copy, true).status, 'already converted');
});

test('a conversion lock or incomplete manifest prevents new version publication', t => {
  const { copy, push, stop, cli } = fixture(t);
  push('report', { 'SKILL.md': doc + '`rf say "Safe"`\n' });
  stop();
  const lock = join(copy, '.rf/migrate-messages.lock');
  writeFileSync(lock, '');
  let before = snapshot(copy);
  assert.match(cli('--apply').stderr, /unsafe or partial conversion/);
  assert.deepEqual(snapshot(copy), before);
  rmSync(lock);
  const manifest = join(copy, '.rf/tree.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), state: 'incomplete' }));
  before = snapshot(copy);
  assert.match(cli('--apply').stderr, /incomplete message conversion/);
  assert.deepEqual(snapshot(copy), before);
});
