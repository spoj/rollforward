import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkAuthorityFormat, AUTHORITY_FORMAT } from '../src/authority-format.ts';
import { applySeriesOwners, planSeriesOwners } from '../scripts/series-owner-migrate.ts';
import { CAPS, can, upsertUser, type Me } from '../src/auth.ts';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { readFixtureTree, snapshotFiles, writeFixtureTree } from './owner-fixture.ts';

test('only an absent or empty data root initializes a complete tree envelope', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [root, join(root, 'absent')]) {
    checkAuthorityFormat(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.rf/tree.json'), 'utf8')), { ...AUTHORITY_FORMAT, tree: { workspaces: {}, series: {} } });
    assert.deepEqual(readdirSync(join(dir, '.rf')), ['tree.json']);
    checkAuthorityFormat(dir);
  }
});

test('tree readers and writers use only the versioned shape', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  initSystem(root);
  const value = { workspaces: { w: { name: 'W', owners: [], members: [] } }, series: {} };
  saveTree(value);
  assert.deepEqual(JSON.parse(JSON.stringify(tree())), value);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8')), { ...AUTHORITY_FORMAT, tree: value });
  writeFileSync(join(root, '.rf/tree.json'), JSON.stringify(value));
  assert.throws(() => tree(), /authority format/);
});

test('nonempty legacy and sidecar-only roots refuse without writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'));
  writeFileSync(join(root, '.rf/tree.json'), '{"workspaces":{},"series":{}}');
  const before = snapshotFiles(root);
  assert.throws(() => checkAuthorityFormat(root), /manual offline migration required/);
  assert.deepEqual(snapshotFiles(root), before);
});

test('a complete envelope cannot hide absent, legacy or mismatched series authority', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  mkdirSync(join(root, 'series/s'), { recursive: true });
  writeFixtureTree(root, { workspaces: { w: { name: 'W', owners: [], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  assert.throws(() => checkAuthorityFormat(root), /series authority/);
  for (const settings of [
    { shared: { by: 'alice@example.test', logins: [] } },
    { version: 1, epoch: 0, since: '', shared: {} },
    { version: 1, epoch: -1, since: '' },
    { version: 1, epoch: 1, since: '', consent: { by: 'alice@example.test', at: '', workspace: 'w', logins: [], autonomous: false } },
    { version: 1, epoch: 1, since: '', owner: 'alice@example.test', consent: { by: 'bob@example.test', at: '', workspace: 'w', logins: [], autonomous: false } },
    { version: 1, epoch: 1, since: '', owner: 'alice@example.test', consent: { by: 'alice@example.test', at: '', workspace: 'elsewhere', logins: [], autonomous: false } },
  ]) {
    writeFileSync(join(root, 'series/s/series.json'), JSON.stringify(settings));
    const before = snapshotFiles(root);
    assert.throws(() => checkAuthorityFormat(root), /series authority/);
    assert.deepEqual(snapshotFiles(root), before);
  }
  writeFileSync(join(root, 'series/s/series.json'), JSON.stringify({ version: 1, epoch: 1, since: '' }));
  checkAuthorityFormat(root);
  writeFileSync(join(root, 'series/s/series.json'), JSON.stringify({ version: 1, epoch: 1, since: '', owner: 'alice@example.test', consent: { by: 'alice@example.test', at: '', workspace: 'w', logins: [], autonomous: false } }));
  checkAuthorityFormat(root);
});

test('an interrupted new-series creation leaves only an inert orphan', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-orphan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  mkdirSync(join(root, 'series/orphan'), { recursive: true });
  checkAuthorityFormat(root);
  assert.deepEqual(readdirSync(join(root, 'series/orphan')), []);
});

test('readonly planning inventories every series and all work without choosing an owner or unioning ticks', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    '.rf/tree.json': JSON.stringify({ workspaces: { w: { name: 'W', owners: [], members: [] } }, series: { mixed: { workspace: 'w' }, unique: { workspace: 'w' }, empty: { workspace: 'w' } } }),
    '.rf/wakes.json': JSON.stringify({ pending: { p: { target: 'mixed', days: ['mon'], from: 'a@example.test' } }, requests: { r: { series: 'unique', from: 'b@example.test' } }, fired: { p: '2026-01-01' } }),
    'series/mixed/series.json': '{"shared":{"by":"sharer@example.test","logins":["mail:s"]}}',
    'instances/a/instance.json': '{"series":"mixed","label":"A"}',
    'instances/a/screen.json': '{"status":"open"}',
    'instances/a/log.jsonl': '{"seq":1,"op":"create","by":"a@example.test","logins":["mail:a"]}\n{"seq":2,"op":"assign","by":"manager@example.test","to":"b@example.test","logins":[]}\n',
    'instances/b/instance.json': '{"series":"mixed","label":"B"}',
    'instances/b/screen.json': '{"status":"closed"}',
    'instances/b/log.jsonl': '{"seq":1,"op":"create","by":"a@example.test","logins":["mail:b"]}\n',
    'instances/c/instance.json': '{"series":"unique","label":"C"}',
    'instances/c/screen.json': '{"status":"closed"}',
    'instances/c/log.jsonl': '{"seq":1,"op":"create","by":"c@example.test","logins":["mail:c"]}\n',
    'instances/deleted/instance.json': '{"series":"unique","label":"Deleted"}',
    'instances/deleted/log.jsonl': '{"op":"delete","runs":[{"runner":"past@example.test","cost":1}]}\n',
    '.rf/costs.jsonl': '{"person":"past@example.test","cost":1}\n',
    '.rf/seal.key': 'synthetic key',
    'instances/a/working/output.txt': 'historical output',
    'skills/versions/s/1/SKILL.md': 'fixture skill',
    'agents/company.md': 'fixture instructions',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const before = snapshotFiles(root), plan = planSeriesOwners(root);
  assert.deepEqual(snapshotFiles(root), before);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.series.map(s => [s.id, s.classification]), [['mixed', 'mixed-candidates'], ['unique', 'unique-candidate-not-owner'], ['empty', 'no-current-candidate']]);
  const mixed = plan.series[0];
  assert.deepEqual(mixed.candidates.map(c => [c.person, c.kind, c.seq]), [
    ['sharer@example.test', 'legacy-sharer', undefined], ['b@example.test', 'legacy-current-runner-candidate', 2], ['a@example.test', 'legacy-current-runner-candidate', 1],
  ]);
  assert.ok(mixed.candidates.every(c => /^[a-f0-9]{64}$/.test(c.sha256)));
  assert.ok(plan.series[1].candidates.some(c => c.kind === 'historical-tombstone-executor'));
  assert.ok(plan.files.some(f => f.path === '.rf/seal.key'));
  assert.deepEqual(plan.work.map(w => w.id), ['instance:a', 'pending:p', 'requests:r']);
  assert.equal('owner' in mixed, false);
  assert.equal('consent' in mixed, false);
  assert.throws(() => applySeriesOwners(root), error => {
    const report = JSON.parse((error as Error).message.split('\n').slice(1).join('\n'));
    assert.deepEqual(report.missingOwners, ['mixed', 'unique', 'empty']);
    assert.deepEqual(report.missingConsentEvidence, ['mixed', 'unique', 'empty']);
    assert.deepEqual(report.missingEligibilityEvidence, ['mixed', 'unique', 'empty']);
    assert.deepEqual(report.missingWorkDecisions, ['instance:a', 'pending:p', 'requests:r']);
    assert.deepEqual(report.missingAcknowledgements, ['stopped', 'updaterIdle', 'fullBackupVerified']);
    return true;
  });
  const submitted = {
    series: Object.fromEntries(plan.series.map(s => [s.id, { owner: 'incoming@example.test', consentEvidence: { by: 'incoming@example.test', logins: [], autonomous: true }, eligibilityEvidence: 'synthetic evidence, not authenticated' }])),
    work: Object.fromEntries(plan.work.map(w => [w.id, { decision: 'explicit fixture decision, not an approved transition' }])),
    acknowledgements: { stopped: true, updaterIdle: true, fullBackupVerified: true },
  };
  assert.throws(() => applySeriesOwners(root, submitted), /Apply unavailable/);
  const result = spawnSync(process.execPath, ['scripts/series-owner-migrate.ts', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'readonly-plan');
  const decisionFile = join(root, 'decisions.json');
  writeFileSync(decisionFile, JSON.stringify(submitted));
  const submittedBefore = snapshotFiles(root);
  const refused = spawnSync(process.execPath, ['scripts/series-owner-migrate.ts', root, 'apply', decisionFile], { encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /Apply unavailable/);
  assert.deepEqual(snapshotFiles(root), submittedBefore);
  rmSync(decisionFile);
  assert.deepEqual(snapshotFiles(root), before);
  assert.throws(() => applySeriesOwners(root, { series: { other: { owner: 'manager@example.test' } }, work: { other: true } }), /"extraSeries": \[\s*"other"/);
  assert.deepEqual(snapshotFiles(root), before);
});

test('rollback restores the entire snapshot into an empty root without erasing post-cutover evidence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-owner-restore-')), root = join(dir, 'data'), backup = join(dir, 'backup'), restored = join(dir, 'restored');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({
    '.rf/tree.json': '{"workspaces":{},"series":{}}',
    '.rf/wakes.json': '{"pending":{"p":{}},"requests":{"r":{}}}',
    '.rf/costs.jsonl': '{"person":"past@example.test"}\n',
    'series/s/series.json': '{"shared":{"by":"legacy@example.test","logins":["legacy:offer"]}}',
    'instances/i/log.jsonl': '{"op":"create","by":"past@example.test"}\n',
    'instances/deleted/log.jsonl': '{"op":"delete","runs":[{"runner":"past@example.test"}]}\n',
    'instances/i/working/output': 'historical output', 'instances/i/session/run.jsonl': 'session',
    'instances/i/.git/evidence': 'git fixture', 'instances/i/browser/evidence': 'browser fixture',
    'agents/company.md': 'instructions', 'skills/versions/s/1/SKILL.md': 'skill',
  })) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  cpSync(root, backup, { recursive: true });
  const before = snapshotFiles(root);
  // A synthetic post-cutover snapshot, not execution of a migration tool.
  writeFixtureTree(root, { workspaces: {}, series: {} });
  writeFileSync(join(root, 'post-cutover-signoff.json'), '{"by":"new@example.test"}');
  const after = snapshotFiles(root);
  cpSync(root, join(dir, 'converted-evidence'), { recursive: true });
  cpSync(backup, restored, { recursive: true });
  assert.deepEqual(snapshotFiles(restored), before);
  assert.deepEqual(snapshotFiles(root), after);
  assert.deepEqual(snapshotFiles(join(dir, 'converted-evidence')), after);
  assert.throws(() => checkAuthorityFormat(restored), /manual offline migration required/);
});

test('documented complete-data archive excludes live and startup-backup key copies', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-key-archive-')), backup = mkdtempSync(join(tmpdir(), 'rf-owner-key-backup-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); });
  for (const dir of ['.rf', '.rf-backups/startup', 'instances/i/working']) mkdirSync(join(root, dir), { recursive: true });
  for (const dir of ['.rf', '.rf-backups/startup']) for (const name of ['seal.key', 'session.key']) writeFileSync(join(root, dir, name), 'synthetic secret');
  writeFileSync(join(root, 'instances/i/working/seal.key'), 'ordinary instance output');
  const evidence = {
    '.rf/tree.json': 'tree', '.rf/wakes.json': 'pending wakes and requests', '.rf/users.json': 'users',
    '.rf/grants.json': 'grants', '.rf/costs.jsonl': 'actual person and key attribution', '.rf/browsers.json': 'browser journal',
    'series/s/series.json': 'series settings', 'series/s/notes/log.jsonl': 'notes', 'series/s/.pylib/p.py': 'packages',
    'instances/i/log.jsonl': 'immutable history', 'instances/deleted/log.jsonl': 'tombstone',
    'instances/i/.git/history': 'git', 'instances/i/session/run.jsonl': 'session', 'instances/i/browser/trace': 'browser',
    'agents/company.md': 'instructions', 'skills/versions/s/1/SKILL.md': 'skill',
  };
  for (const [path, content] of Object.entries(evidence)) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
  }
  const docs = readFileSync(join(import.meta.dirname, '..', 'docs/deploy.md'), 'utf8');
  const recipe = docs.split('\n').find(line => line.trim().startsWith('tar --acls'))!;
  const made = spawnSync('bash', ['-c', recipe], { env: { ...process.env, DATA_ROOT: root, BACKUP_DIR: backup }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const listed = spawnSync('tar', ['-tf', join(backup, 'data-before-owner.tar')], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /\.\/(?:\.rf|\.rf-backups\/startup)\/(?:seal|session)\.key/);
  assert.match(listed.stdout, /instances\/i\/working\/seal\.key/);
  const restored = join(backup, 'empty-restored-root');
  mkdirSync(restored);
  const unpacked = spawnSync('tar', ['--acls', '--xattrs', '-xpf', join(backup, 'data-before-owner.tar'), '-C', restored], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  for (const [path, content] of Object.entries(evidence)) assert.equal(readFileSync(join(restored, path), 'utf8'), content);
  assert.equal(readFileSync(join(restored, 'instances/i/working/seal.key'), 'utf8'), 'ordinary instance output');
  assert.deepEqual(readdirSync(join(restored, '.rf-backups/startup')), []);
  const protectedKeys = join(backup, 'protected-keys');
  mkdirSync(protectedKeys);
  for (const key of ['seal.key', 'session.key']) {
    cpSync(join(root, '.rf', key), join(protectedKeys, key));
    cpSync(join(protectedKeys, key), join(restored, '.rf', key));
    assert.equal(readFileSync(join(restored, '.rf', key), 'utf8'), 'synthetic secret');
  }
});

test('migration CLI documents readonly planning and blocked apply', () => {
  const result = spawnSync(process.execPath, ['scripts/series-owner-migrate.ts'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /read-only by default; apply is policy-blocked/);
});

test('admin try requires explicit pilot identity and selected offers before starting a shell', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-try-')), email = 'admin@example.test';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  initSystem(root);
  upsertUser(email, { role: 'admin' });
  let result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--as', email, '--', 'true'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicitly granted series-owner/);
  writeJson('capabilities.json', { 'series-owner': [email] });
  result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--as', email, '--', 'true'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--logins JSON_ARRAY is required/);
  result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--as', email, '--logins', '["someone-elses:offer"]', '--', 'true'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /offers of your own logins/);
  result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--logins', '[]', '--', 'true', '--as', email], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--as EMAIL/);
});

test('series-owner is a named opt-in, including for admins; email and group grants work', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initSystem(root);
  const admin: Me = { email: 'admin@example.test', name: 'Admin', role: 'admin', groups: [] };
  const person: Me = { email: 'alice@example.test', name: 'Alice', role: 'user', groups: ['pilot-group'] };
  assert.ok(CAPS.includes('series-owner'));
  assert.equal(can(admin, 'series-owner'), false);
  assert.equal(can(person, 'series-owner'), false);
  assert.equal(can(admin, 'publish'), true);
  writeJson('capabilities.json', { 'series-owner': [admin.email, 'pilot-group'] });
  assert.equal(can(admin, 'series-owner'), true);
  assert.equal(can(person, 'series-owner'), true);
  writeJson('capabilities.json', { 'series-owner': [] });
  assert.equal(can(admin, 'series-owner'), false);
});
