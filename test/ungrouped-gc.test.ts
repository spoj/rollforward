import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, saveTree, tree } from '../src/system.ts';
import { createInstance, instance, openStore } from '../src/store.ts';
import { sweepIdleUngrouped, UNGROUPED_IDLE_MS } from '../src/waker.ts';
import { openSkills, pushed, skills } from '../src/skills.ts';

test('sweepIdleUngrouped abandons single:true open instances idle >= 24h and leaves recent or recurring ones open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-ungrouped-gc-'));
  try {
    initSystem(root);
    openStore(root);
    const t = tree();
    t.workspaces.w1 = { name: 'Main', owners: ['alice@example.com'], members: ['alice@example.com'] };
    t.series.s_old = { name: 'Old Task', workspace: 'w1', single: true };
    t.series.s_new = { name: 'New Task', workspace: 'w1', single: true };
    t.series.s_rec = { name: 'Monthly Close', workspace: 'w1' };
    saveTree(t);

    const oldInst = createInstance('s_old', 'Old Task', 'alice@example.com');
    const newInst = createInstance('s_new', 'New Task', 'alice@example.com');
    const recInst = createInstance('s_rec', '2026-11', 'alice@example.com');

    // Backdate oldInst and recInst last log timestamps by 25h; keep newInst fresh.
    const now = Date.now();
    const oldAt = new Date(now - UNGROUPED_IDLE_MS - 3_600_000).toISOString();
    oldInst.log.at(-1)!.at = oldAt;
    recInst.log.at(-1)!.at = oldAt;

    const abandoned = await sweepIdleUngrouped(now);
    assert.deepEqual(abandoned, [oldInst.id]);
    assert.equal(instance(oldInst.id).doc.status, 'abandoned');
    assert.equal(instance(oldInst.id).log.at(-1)?.op, 'abandon');
    assert.equal(instance(oldInst.id).log.at(-1)?.by, 'server');
    assert.equal(instance(newInst.id).doc.status, 'open');
    assert.equal(instance(recInst.id).doc.status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('built-in subagent skill is loaded and bin/pi is executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-builtin-skill-'));
  try {
    openSkills(root);
    const sub = skills().find(s => s.id === 'subagent');
    assert.ok(sub, 'subagent built-in skill should be discovered');
    assert.equal(sub.name, 'subagent');
    assert.deepEqual(pushed(sub), { version: 0, by: 'builtin', at: '' });
    accessSync(join(sub.dir, 'run_subagent.sh'), constants.X_OK);
    accessSync(join(process.cwd(), 'bin', 'pi'), constants.X_OK);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
