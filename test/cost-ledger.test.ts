import { after, test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, rfDir } from '../src/system.ts';
import { recordCost, syncCosts, type CostRecord } from '../src/costs.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rf-ledger-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const entry: CostRecord = { at: '2026-10-20T12:00:00Z', service: 'openrouter', inst: 'i', run: 1, person: 'a@test', cost: 0.01 };

test('ledger starts absent, tails complete UTF-8 lines, and recovers a torn tail before recording', () => {
  initSystem(join(tmp, 'torn'));
  const path = join(rfDir(), 'costs.jsonl');
  assert.deepEqual(syncCosts(), []);
  const line = JSON.stringify({ ...entry, person: 'é@test' }) + '\n';
  const bytes = Buffer.from(line), split = bytes.indexOf(Buffer.from('é')) + 1;
  writeFileSync(path, bytes.subarray(0, split));
  assert.deepEqual(syncCosts(), []);
  appendFileSync(path, bytes.subarray(split));
  assert.deepEqual(syncCosts(), [{ ...entry, person: 'é@test' }]);
  appendFileSync(path, '{"at":"torn');
  assert.equal(syncCosts().length, 1);
  recordCost(entry);
  assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l)), [{ ...entry, person: 'é@test' }, entry]);
  assert.equal(syncCosts().length, 2);
});

test('a separate process appending between sync and the local append cannot corrupt the cursor', () => {
  initSystem(join(tmp, 'concurrent'));
  recordCost(entry);
  syncCosts();
  const external = { ...entry, person: 'another-process@test', cost: 0.02 };
  const append = fs.appendFileSync;
  fs.appendFileSync = ((path, data, options) => {
    append(path, JSON.stringify(external) + '\n');
    append(path, data, options);
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  try { recordCost(entry); } finally {
    fs.appendFileSync = append;
    syncBuiltinESMExports();
  }
  assert.deepEqual(syncCosts(), [entry, external, entry]);
});

test('an append after the tail snapshot is not mistaken for a torn line and truncated', () => {
  initSystem(join(tmp, 'tail-snapshot'));
  recordCost(entry);
  syncCosts();
  const external = { ...entry, person: 'snapshot-process@test' };
  const stat = fs.statSync;
  let injected = false;
  fs.statSync = ((path, options) => {
    const result = stat(path, options);
    if (!injected && path === join(rfDir(), 'costs.jsonl')) {
      injected = true;
      appendFileSync(path, JSON.stringify(external) + '\n');
    }
    return result;
  }) as typeof fs.statSync;
  syncBuiltinESMExports();
  try { recordCost(entry); } finally {
    fs.statSync = stat;
    syncBuiltinESMExports();
  }
  assert.deepEqual(syncCosts(), [entry, external, entry]);
});

for (const torn of [false, true]) test(`concurrent writers preserve completed records with torn tail: ${torn}`, async () => {
  const root = join(tmp, `writers-${torn}`);
  initSystem(root);
  const path = join(rfDir(), 'costs.jsonl'), ready = join(root, 'ready');
  recordCost(entry);
  if (torn) appendFileSync(path, '{"at":"torn');
  const external = { ...entry, person: 'other-writer@test', cost: 0.7 };
  const stat = fs.statSync;
  let child: ReturnType<typeof spawn>;
  let injected = false;
  fs.statSync = ((p, options) => {
    const result = stat(p, options);
    if (!injected && p === path) {
      injected = true;
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        import cp from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { initSystem } from './src/system.ts';
        import { recordCost } from './src/costs.ts';
        const exec = cp.execFileSync;
        cp.execFileSync = (cmd, ...args) => {
          if (cmd === 'flock') writeFileSync(${JSON.stringify(ready)}, 'waiting');
          return exec(cmd, ...args);
        };
        syncBuiltinESMExports();
        initSystem(${JSON.stringify(root)});
        recordCost(${JSON.stringify(external)});
        writeFileSync(${JSON.stringify(ready)}, 'done');
      `], { cwd: join(import.meta.dirname, '..'), stdio: 'inherit' });
      const end = Date.now() + 10_000;
      while (!fs.existsSync(ready) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      assert.ok(fs.existsSync(ready), 'second writer reached its lock or completed its append');
    }
    return result;
  }) as typeof fs.statSync;
  syncBuiltinESMExports();
  try { recordCost({ ...entry, person: 'local-writer@test', cost: 0.2 }); } finally {
    fs.statSync = stat;
    syncBuiltinESMExports();
  }
  const [code] = await once(child!, 'exit');
  assert.equal(code, 0);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(e => e.person).sort(), ['a@test', 'local-writer@test', 'other-writer@test']);
  assert.equal(+syncCosts().reduce((n, e) => n + e.cost, 0).toFixed(6), 0.91);
});

test('a killed writer releases its lock and leaves its torn tail repairable', async () => {
  const root = join(tmp, 'killed-writer');
  initSystem(root);
  const path = join(rfDir(), 'costs.jsonl');
  recordCost(entry);
  appendFileSync(path, '{"at":"torn');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { initSystem } from './src/system.ts';
    import { recordCost } from './src/costs.ts';
    const stat = fs.statSync;
    fs.statSync = (...args) => {
      if (args[0] === ${JSON.stringify(path)}) {
        fs.writeSync(1, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return stat(...args);
    };
    syncBuiltinESMExports();
    initSystem(${JSON.stringify(root)});
    recordCost(${JSON.stringify(entry)});
  `], { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout!, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
  recordCost(entry);
  assert.deepEqual(syncCosts(), [entry, entry]);
});

test('an append error releases the writer lock', () => {
  initSystem(join(tmp, 'append-error'));
  const append = fs.appendFileSync;
  fs.appendFileSync = (() => { throw new Error('append failed'); }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  try { assert.throws(() => recordCost(entry), /append failed/); } finally {
    fs.appendFileSync = append;
    syncBuiltinESMExports();
  }
  recordCost(entry);
  assert.deepEqual(syncCosts(), [entry]);
});

test('ledger invalidates its cursor after rotation, truncation, and removal', () => {
  initSystem(join(tmp, 'rotate'));
  const path = join(rfDir(), 'costs.jsonl');
  recordCost(entry);
  renameSync(path, path + '.old');
  const replacement = { ...entry, cost: 0.02 };
  writeFileSync(path, JSON.stringify(replacement) + '\n');
  assert.deepEqual(syncCosts(), [replacement], 'same-size replacement is not the cached ledger');
  writeFileSync(path, '');
  assert.deepEqual(syncCosts(), []);
  recordCost(entry);
  assert.deepEqual(syncCosts(), [entry]);
  rmSync(path);
  assert.deepEqual(syncCosts(), []);
});
