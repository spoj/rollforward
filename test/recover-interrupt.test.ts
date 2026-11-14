import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { committed } from '../src/git.ts';
import { recover } from '../src/waker.ts';

for (const after of ['nothing', 'comment', 'quiet']) test(`restart during an interrupt preserves its hold unless a later act starts work: ${after}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = mkdtempSync(join(tmpdir(), 'rf-recover-interrupt-')), alice = 'alice@demo.test';
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Work', owners: [alice], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
  writeJson('users.json', { [alice]: { role: 'user' } });
  mkdirSync(join(root, 'series', 's'), { recursive: true });
  const inst = createInstance('s', 'Interrupted', alice, []);
  t.after(async () => { await committed(inst.dir); rmSync(root, { recursive: true, force: true }); });
  inst.append(alice, 'comment', { text: 'Work.' });
  inst.append('server', 'run', { run: 1, runner: alice, consent: 1 });
  inst.append(alice, 'interrupt');
  if (after !== 'nothing') inst.append(alice, 'comment', { text: 'Next instruction.', ...(after === 'quiet' && { quiet: true }) });
  recover();
  assert.equal(inst.log.filter(e => e.op === 'wake').length, after === 'comment' ? 1 : 0);
  assert.equal(inst.log.findLast(e => e.op === 'done')!.aborted, true);
});
