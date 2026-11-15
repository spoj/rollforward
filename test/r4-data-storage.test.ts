import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit } from '../src/git.ts';
import { openSkills, pushSkill, skills, versionsOf } from '../src/skills.ts';
import { createInstance, openStore } from '../src/store.ts';

const who = { name: 'Alice', email: 'alice@demo.test' };

test('B-R4-DATA-03a: commit() atomically replaces .git/rf-seen.json and rebuilds a partial cache without hiding fs errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-03a-git-'));
  try {
    openStore(root);
    const inst = createInstance('s', 'I', who.email, []), cache = join(inst.dir, '.git', 'rf-seen.json');
    writeFileSync(join(inst.dir, 'working', 'report.txt'), 'first');
    await commit(inst.dir, who, 'healthy control');

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = ((path, bytes, ...args) => {
      if (String(path).includes('rf-seen.json')) {
        origWrite(path, '{"partial":');
        throw Object.assign(new Error('synthetic EFBIG'), { code: 'EFBIG' });
      }
      return origWrite(path, bytes, ...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(commit(inst.dir, who, 'partial cache write'), /EFBIG/);
    } finally {
      fs.writeFileSync = origWrite;
      syncBuiltinESMExports();
    }

    JSON.parse(readFileSync(cache, 'latin1'));
    writeFileSync(join(inst.dir, 'working', 'report.txt'), 'second');
    await commit(inst.dir, who, 'after failed cache write');

    writeFileSync(cache, '{"working/report.txt":[');
    writeFileSync(join(inst.dir, 'working', 'report.txt'), 'third');
    await inst.close(who);
    assert.equal(inst.doc.status, 'closed');

    const inst2 = createInstance('s', 'I2', who.email, []), cache2 = join(inst2.dir, '.git', 'rf-seen.json');
    writeFileSync(join(inst2.dir, 'working', 'f.txt'), 'x');
    await commit(inst2.dir, who, 'init');
    rmSync(cache2);
    mkdirSync(cache2);
    await assert.rejects(commit(inst2.dir, who, 'eisdir'), /EISDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-R4-DATA-03a: pushSkill() atomically writes .pushed.json and versionsOf() skips partial unpublished metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-03a-skills-'));
  try {
    openSkills(root);
    const files = { 'SKILL.md': Buffer.from('---\nname: demo\ndescription: test\n---\n').toString('base64') };
    pushSkill('demo', files, who.email);
    assert.equal(versionsOf('demo').length, 1);

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = ((path, bytes, ...args) => {
      if (String(path).includes('/2/.pushed.json')) {
        origWrite(path, '{"version":2,"by":');
        throw Object.assign(new Error('synthetic EFBIG'), { code: 'EFBIG' });
      }
      return origWrite(path, bytes, ...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => pushSkill('demo', files, who.email), /EFBIG/);
    } finally {
      fs.writeFileSync = origWrite;
      syncBuiltinESMExports();
    }

    assert.equal(readlinkSync(join(root, 'skills', 'live', 'demo')), '../versions/demo/1');
    assert.deepEqual(skills().map(s => s.id), ['demo']);
    assert.deepEqual(versionsOf('demo').map(v => v.version), [1]);

    mkdirSync(join(root, 'skills', 'versions', 'demo', '3'), { recursive: true });
    writeFileSync(join(root, 'skills', 'versions', 'demo', '3', '.pushed.json'), '{"version":3,"by":');
    assert.deepEqual(versionsOf('demo').map(v => v.version), [1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
