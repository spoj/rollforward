import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkAuthorityFormat, AUTHORITY_FORMAT } from '../src/authority-format.ts';
import { CAPS, upsertUser } from '../src/auth.ts';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { snapshotFiles, writeFixtureTree } from './owner-fixture.ts';

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
  assert.throws(() => tree(), { message: 'legacy data: convert it to series owners first (docs/deploy.md)' });
});

test('nonempty legacy and sidecar-only roots refuse without writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-format-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'));
  writeFileSync(join(root, '.rf/tree.json'), '{"workspaces":{},"series":{}}');
  const before = snapshotFiles(root);
  assert.throws(() => checkAuthorityFormat(root), { message: 'legacy data: convert it to series owners first (docs/deploy.md)' });
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
  assert.throws(() => checkAuthorityFormat(root), /missing canonical message log/);
  writeFileSync(join(root, 'series/s/messages.jsonl'), '');
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

test('admin try requires explicit identity and selected offers before starting a shell', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-try-')), email = 'admin@example.test';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  initSystem(root);
  upsertUser(email, { role: 'admin' });
  let result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--as', email, '--', 'true'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--logins JSON_ARRAY is required/);
  result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--as', email, '--logins', '["someone-elses:offer"]', '--', 'true'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /offers of your own logins/);
  result = spawnSync(process.execPath, ['src/cli.ts', root, 'try', '--logins', '[]', '--', 'true', '--as', email], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--as EMAIL/);
});

test('unknown capabilities do not affect startup or become advertised capabilities', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-owner-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkAuthorityFormat(root);
  initSystem(root);
  writeJson('capabilities.json', { 'series-owner': ['admin@example.test'] });
  checkAuthorityFormat(root);
  assert.equal(CAPS.includes('series-owner'), false);
});
