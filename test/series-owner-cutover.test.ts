import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySeriesOwners } from '../scripts/series-owner-migrate.ts';
import { snapshotFiles, writeFixtureTree } from './owner-fixture.ts';
import { AUTHORITY_FORMAT, checkAuthorityFormat } from '../src/authority-format.ts';
import { agentRoot } from '../src/agent.ts';
import { idp } from './idp.ts';

const app = join(import.meta.dirname, '..');
const legacyCommit = '9c0a56e59fd657cd81fbe9cdf5cffc3c85cb8d0c';
const env = { PATH: process.env.PATH, HOME: process.env.HOME, RF_MIN_FREE_GB: '0', RF_AGENT_ROOT: agentRoot };

function legacy(root: string) {
  mkdirSync(join(root, '.rf'), { recursive: true });
  mkdirSync(join(root, 'series/s'), { recursive: true });
  writeFileSync(join(root, '.rf/tree.json'), JSON.stringify({ workspaces: { w: { name: 'W', owners: ['a@example.test'], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } }));
  writeFileSync(join(root, 'series/s/series.json'), '{"shared":{"by":"a@example.test","logins":["mail:a"]}}');
  writeFileSync(join(root, '.rf/wakes.json'), '{"pending":{"p":{"target":"s","label":"next","from":"a@example.test","at":"2099-01-01T00:00:00Z"}},"requests":{"r":{"series":"s","label":"requested","from":"b@example.test"}},"fired":{}}');
}

async function boot(server: string, root: string, extra: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [server, root, '0'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise<{ started: boolean; code: number | null; out: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('server startup timed out: ' + out)); }, 10000);
    let started = false;
    child.stdout.on('data', d => { out += d; if (out.includes('rollforward on')) { started = true; child.kill('SIGTERM'); } });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolve({ started, code, out }); });
  });
}

test('actual pre-owner server refuses new-format data, not just a new-reader sidecar check', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-old-reader-')), root = join(dir, 'data'), old = join(dir, 'old');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(old);
  const archive = execFileSync('git', ['archive', legacyCommit, 'src', 'web', 'bin', 'agent', 'prompt.md', 'package.json'], { cwd: app, maxBuffer: 10 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', old], { input: archive });
  symlinkSync(join(app, 'node_modules'), join(old, 'node_modules'));
  legacy(root);
  mkdirSync(join(root, 'instances/i'), { recursive: true });
  writeFileSync(join(root, 'instances/i/instance.json'), '{"series":"s","label":"Past"}');
  writeFileSync(join(root, 'instances/i/screen.json'), '{"status":"closed","rev":1,"items":[]}');
  const history = '{"seq":1,"at":"2026-01-01","op":"create","by":"a@example.test","logins":["mail:a"]}\n';
  writeFileSync(join(root, 'instances/i/log.jsonl'), history);
  writeFileSync(join(root, '.rf/authority-format.json'), '{"version":1,"minReader":1,"state":"complete"}');
  writeFileSync(join(root, 'series/s/series.json'), '{"version":1,"epoch":1,"since":"2026-01-01","owner":"b@example.test"}');
  const entra = await idp();
  t.after(() => entra.close());
  const server = join(old, 'src/server.ts'), config = entra.env('http://localhost:8780');
  const ignoredMarker = await boot(server, root, config);
  assert.equal(ignoredMarker.started, true, 'control: actual old server ignores the f03f581 sidecar');
  const decoded = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { initSystem } from ${JSON.stringify(join(old, 'src/system.ts'))};
    import { openStore, instance } from ${JSON.stringify(join(old, 'src/store.ts'))};
    import { runnerOf } from ${JSON.stringify(join(old, 'src/logins.ts'))};
    initSystem(${JSON.stringify(root)}); openStore(${JSON.stringify(root)});
    console.log(JSON.stringify(runnerOf(instance('i'))));
  `], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(decoded), { by: 'a@example.test', logins: ['mail:a'], consent: 1 }, 'old executable authority still selects A while new settings say owner B');
  writeFixtureTree(root, JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8')));
  const envelope = JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8'));
  for (const state of ['complete', 'incomplete']) {
    writeFileSync(join(root, '.rf/tree.json'), JSON.stringify({ ...envelope, state }));
    const result = await boot(server, root, config);
    assert.equal(result.started, false, result.out);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /Cannot convert undefined or null to object/);
    assert.match(result.out, /recover/);
    assert.equal(readFileSync(join(root, 'instances/i/log.jsonl'), 'utf8'), history);
    assert.equal(readFileSync(join(root, 'series/s/series.json'), 'utf8'), '{"version":1,"epoch":1,"since":"2026-01-01","owner":"b@example.test"}');
  }
});

test('migration refuses absent explicit owner mapping and preserves all queued work', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-unsafe-mapping-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  legacy(root);
  const wakes = readFileSync(join(root, '.rf/wakes.json'), 'utf8');
  const settings = readFileSync(join(root, 'series/s/series.json'), 'utf8');
  assert.throws(() => applySeriesOwners(root), /mapping|coverage|decision/);
  assert.equal(readFileSync(join(root, '.rf/wakes.json'), 'utf8'), wakes);
  assert.equal(readFileSync(join(root, 'series/s/series.json'), 'utf8'), settings);
});

test('new server validates all format prerequisites before any startup mutation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-new-reader-')), entra = await idp();
  t.after(() => { entra.close(); rmSync(dir, { recursive: true, force: true }); });
  const complete = { ...AUTHORITY_FORMAT, tree: { workspaces: { w: { name: 'W', owners: [], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } } };
  const cases = [
    undefined, {}, { ...complete, version: 2 }, { ...complete, minReader: '0.6.0' }, { ...complete, minReader: '0.8.0' },
    { ...complete, state: 'incomplete' }, { ...complete, state: 'migrating' }, { ...complete, tree: undefined },
    { ...complete, series: {} }, { ...complete, tree: { workspaces: {}, series: null } },
    { ...complete, tree: { workspaces: { w: null }, series: {} } },
    { ...complete, tree: { workspaces: {}, series: { s: { name: 'S', workspace: 'missing' } } } }, 'malformed',
    'missing-settings', 'legacy-settings', 'wrong-consent',
  ];
  for (const [i, data] of cases.entries()) {
    const root = join(dir, String(i));
    legacy(root);
    if (data === undefined) rmSync(join(root, '.rf/tree.json'));
    else writeFileSync(join(root, '.rf/tree.json'), data === 'malformed' ? '{' : JSON.stringify(typeof data === 'string' ? complete : data));
    if (data === 'missing-settings') rmSync(join(root, 'series/s/series.json'));
    if (data === 'wrong-consent') writeFileSync(join(root, 'series/s/series.json'), JSON.stringify({ version: 1, epoch: 1, since: '', owner: 'a@example.test', consent: { by: 'b@example.test', at: '', workspace: 'w', logins: [], autonomous: false } }));
    mkdirSync(join(root, '.tmp/keep'), { recursive: true });
    mkdirSync(join(root, 'instances/torn'), { recursive: true });
    writeFileSync(join(root, 'instances/torn/log.jsonl'), '{torn');
    writeFileSync(join(root, '.rf/log.jsonl'), '{torn');
    const before = snapshotFiles(root), result = await boot(join(app, 'src/server.ts'), root, entra.env('http://localhost:8780'));
    assert.equal(result.started, false, result.out);
    assert.equal(result.code, 1, result.out);
    assert.deepEqual(snapshotFiles(root), before, `no startup writes for case ${i}`);
  }
  const root = join(dir, 'complete');
  legacy(root);
  writeFixtureTree(root, complete.tree);
  writeFileSync(join(root, 'series/s/series.json'), '{"version":1,"epoch":1,"since":"2026-01-01","owner":"a@example.test"}');
  const result = await boot(join(app, 'src/server.ts'), root, entra.env('http://localhost:8780'));
  assert.equal(result.started, true, result.out);
});

test('new reader refuses a complete sidecar with absent tree before initialization', t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-missing-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.rf'));
  writeFileSync(join(root, '.rf/authority-format.json'), '{"version":1,"minReader":1,"state":"complete"}');
  assert.throws(() => checkAuthorityFormat(root), /authority format/);
});
