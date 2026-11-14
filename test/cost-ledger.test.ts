import { after, test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
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
