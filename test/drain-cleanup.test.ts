import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { active, byToken, drain, drained, remove, updating, view, type Active } from '../src/waker.ts';
import type { Run } from '../src/runner.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-drain-cleanup-')), alice = 'alice@demo.test';
initSystem(root);
openStore(root);
saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
writeJson('users.json', { [alice]: { role: 'user' } });
mkdirSync(join(root, 'series', 's'), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test('a failed scratch cleanup cannot leave a stopped run in ending and hold drained false', async () => {
  const inst = createInstance('s', 'Cleanup', alice, []), token = 'cleanup';
  const locked = join(root, '.rf', 'runs', token, 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'file'), 'scratch');
  chmodSync(locked, 0);
  const a = { inst, n: 1, token, view: view(inst), ready: Promise.resolve({ stop: async () => {} } as Run), process: '', cost: 0, seen: 0, done: false } as Active;
  inst.append('server', 'run', { run: 1 });
  active.set(inst.seriesId, a);
  byToken.set(token, a);
  drain();
  try {
    await assert.rejects(remove(inst, alice, () => ({ cost: 0, runs: [] })), /EACCES/);
    assert.equal(updating(), 0, 'retiring was cleared even though cleanup failed');
    assert.equal(drained(), true, 'the sandbox has stopped; a cleanup error is not a live run');
  } finally {
    chmodSync(locked, 0o700);
  }
});
