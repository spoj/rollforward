import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkAuthorityFormat, AUTHORITY_FORMAT } from '../src/authority-format.ts';
import { migrateSeriesOwners } from '../scripts/series-owner-migrate.ts';
import { CAPS, can, upsertUser, type Me } from '../src/auth.ts';
import { initSystem, writeJson } from '../src/system.ts';

test('only an absent or empty data root initializes the authority marker', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [root, join(root, 'absent')]) {
    checkAuthorityFormat(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.rf/authority-format.json'), 'utf8')), AUTHORITY_FORMAT);
    checkAuthorityFormat(dir);
  }
});

test('a nonempty legacy root is refused without startup mutation, even an empty legacy tree', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'));
  const before = '{"workspaces":{},"series":{}}';
  writeFileSync(join(root, '.rf/tree.json'), before);
  assert.throws(() => checkAuthorityFormat(root), /manual offline migration required/);
  assert.equal(readFileSync(join(root, '.rf/tree.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(root, '.rf')), ['tree.json']);
});

test('unsupported, malformed and interrupted authority formats fail closed', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  const path = join(root, '.rf/authority-format.json');
  for (const marker of [
    { ...AUTHORITY_FORMAT, version: 2 }, { ...AUTHORITY_FORMAT, minReader: 2 },
    { ...AUTHORITY_FORMAT, minReader: 0 }, { version: 1 },
    { ...AUTHORITY_FORMAT, state: 'migrating' }, { ...AUTHORITY_FORMAT, state: 'unknown' },
  ]) {
    const raw = JSON.stringify(marker);
    writeFileSync(path, raw);
    assert.throws(() => checkAuthorityFormat(root), /authority format/);
    assert.equal(readFileSync(path, 'utf8'), raw);
  }
  writeFileSync(path, '{');
  assert.throws(() => checkAuthorityFormat(root));
});

test('a complete marker cannot hide absent, legacy or mismatched series authority', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  mkdirSync(join(root, 'series/s'), { recursive: true });
  writeFileSync(join(root, '.rf/tree.json'), JSON.stringify({ workspaces: {}, series: { s: { workspace: 'w' } } }));
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
    assert.throws(() => checkAuthorityFormat(root), /series authority/);
  }
  writeFileSync(join(root, 'series/s/series.json'), JSON.stringify({ version: 1, epoch: 1, since: '' }));
  checkAuthorityFormat(root);
  writeFileSync(join(root, 'series/s/series.json'), JSON.stringify({ version: 1, epoch: 1, since: '', owner: 'alice@example.test', consent: { by: 'alice@example.test', at: '', workspace: 'w', logins: [], autonomous: false } }));
  checkAuthorityFormat(root);
});

test('an interrupted new-series creation leaves only an inert orphan, not a startup brick', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-orphan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  writeFileSync(join(root, '.rf/tree.json'), '{"workspaces":{},"series":{}}');
  mkdirSync(join(root, 'series/orphan'), { recursive: true });
  checkAuthorityFormat(root);
  assert.deepEqual(readdirSync(join(root, 'series/orphan')), []);
});

test('offline conversion preserves history and evidence without guessing owners or consent', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-migrate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'));
  const tree = { workspaces: { w: { owners: ['manager@example.test'], members: [] } }, series: { mixed: { workspace: 'w' }, empty: { workspace: 'w' }, task: { workspace: 'w', single: true } } };
  const legacy = '{"shared":{"by":"sharer@example.test","since":"then","logins":["mail:sharer"]}}\n';
  const wakes = '{"pending":{"old":{"target":"mixed","from":"sharer@example.test","at":"2026-12-01","days":["mon"]}},"fired":{"old":"2026-11-01"},"requests":{"r":{"series":"mixed","label":"next","from":"bob@example.test"}}}\n';
  writeFileSync(join(root, '.rf/tree.json'), JSON.stringify(tree));
  writeFileSync(join(root, '.rf/wakes.json'), wakes);
  mkdirSync(join(root, 'series/mixed'), { recursive: true });
  writeFileSync(join(root, 'series/mixed/series.json'), legacy);
  const histories = {
    'instances/a/log.jsonl': '{"op":"create","by":"alice@example.test","logins":["mail:a"]}\n{"op":"assign","to":"bob@example.test"}\n{"op":"run","runner":"bob@example.test","consent":2}\n',
    'instances/deleted/log.jsonl': '{"op":"delete","runs":[{"runner":"past@example.test","cost":1}]}\n',
    'instances/a/working/output.txt': 'historical output',
    '.rf/costs.jsonl': '{"person":"past@example.test","cost":1}\n',
  };
  for (const [path, content] of Object.entries(histories)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  migrateSeriesOwners(root);
  checkAuthorityFormat(root);
  for (const id of Object.keys(tree.series)) {
    const settings = JSON.parse(readFileSync(join(root, 'series', id, 'series.json'), 'utf8'));
    assert.equal(settings.version, 1);
    assert.equal(settings.epoch, 1);
    assert.ok(settings.since);
    assert.equal(settings.owner, undefined);
    assert.equal(settings.consent, undefined);
    assert.equal(settings.shared, undefined);
  }
  assert.equal(readFileSync(join(root, '.rf/authority-migration/series/mixed.json'), 'utf8'), legacy);
  assert.equal(readFileSync(join(root, '.rf/authority-migration/wakes.json'), 'utf8'), wakes);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.rf/wakes.json'), 'utf8')), { pending: {}, fired: { old: '2026-11-01' }, requests: {} });
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8')), tree);
  for (const [path, content] of Object.entries(histories)) assert.equal(readFileSync(join(root, path), 'utf8'), content);
  assert.throws(() => migrateSeriesOwners(root), /already has an authority format/);
});

test('a conversion failure is marked incomplete and requires restoring the offline backup', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-migrate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'));
  mkdirSync(join(root, 'series/s'), { recursive: true });
  writeFileSync(join(root, '.rf/tree.json'), '{"series":{"a":{"workspace":"w"},"s":{"workspace":"w"}}}');
  writeFileSync(join(root, 'series/s/series.json'), '{');
  assert.throws(() => migrateSeriesOwners(root));
  assert.equal(JSON.parse(readFileSync(join(root, '.rf/authority-format.json'), 'utf8')).state, 'migrating');
  assert.equal(JSON.parse(readFileSync(join(root, 'series/a/series.json'), 'utf8')).version, 1);
  assert.throws(() => checkAuthorityFormat(root), /authority format/);
  assert.throws(() => migrateSeriesOwners(root), /already has an authority format/);
});

test('rollback restores an entire compatible snapshot, keeping converted work separate', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-owner-restore-')), root = join(dir, 'data'), backup = join(dir, 'backup');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'), { recursive: true });
  mkdirSync(join(root, 'series/s'), { recursive: true });
  writeFileSync(join(root, '.rf/tree.json'), '{"series":{"s":{"workspace":"w"}}}');
  const original = '{"shared":{"by":"legacy@example.test","logins":["legacy:offer"]}}';
  writeFileSync(join(root, 'series/s/series.json'), original);
  writeFileSync(join(root, '.rf/seal.key'), 'synthetic-key');
  cpSync(root, backup, { recursive: true });
  migrateSeriesOwners(root);
  writeFileSync(join(root, 'post-cutover-signoff.json'), '{"by":"new@example.test"}');
  cpSync(root, join(dir, 'converted-evidence'), { recursive: true });
  rmSync(root, { recursive: true });
  cpSync(backup, root, { recursive: true });
  assert.equal(readFileSync(join(root, 'series/s/series.json'), 'utf8'), original);
  assert.equal(readFileSync(join(root, '.rf/seal.key'), 'utf8'), 'synthetic-key');
  assert.deepEqual(readdirSync(join(root, '.rf')), ['seal.key', 'tree.json']);
  assert.equal(readFileSync(join(dir, 'converted-evidence/post-cutover-signoff.json'), 'utf8'), '{"by":"new@example.test"}');
  assert.throws(() => checkAuthorityFormat(root), /manual offline migration required/);
});

test('documented complete-data archive excludes live and startup-backup key copies', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-key-archive-')), backup = mkdtempSync(join(tmpdir(), 'rf-owner-key-backup-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); });
  for (const dir of ['.rf', '.rf-backups/startup', 'instances/i/working']) mkdirSync(join(root, dir), { recursive: true });
  for (const dir of ['.rf', '.rf-backups/startup']) for (const name of ['seal.key', 'session.key']) writeFileSync(join(root, dir, name), 'synthetic secret');
  writeFileSync(join(root, 'instances/i/working/seal.key'), 'ordinary instance output');
  const docs = readFileSync(join(import.meta.dirname, '..', 'docs/deploy.md'), 'utf8');
  const recipe = docs.split('\n').find(line => line.trim().startsWith('tar --acls'))!;
  const made = spawnSync('bash', ['-c', recipe], { env: { ...process.env, DATA_ROOT: root, BACKUP_DIR: backup }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const listed = spawnSync('tar', ['-tf', join(backup, 'data-before-owner.tar')], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /\.\/(?:\.rf|\.rf-backups\/startup)\/(?:seal|session)\.key/);
  assert.match(listed.stdout, /instances\/i\/working\/seal\.key/);
});

test('migration CLI requires explicit offline acknowledgement', () => {
  const result = spawnSync(process.execPath, ['scripts/series-owner-migrate.ts'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--offline/);
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
