import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commit } from '../src/git.ts';
import { openSkills, pushSkill, skills, versionsOf } from '../src/skills.ts';
import { createInstance, openStore, wipe } from '../src/store.ts';

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

test('B-R4-DATA-03b: commit() bounds open directory descriptors on deep working/ trees and checks parent inodes', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-03b-'));
  try {
    const dir = join(root, 'deep');
    mkdirSync(join(dir, 'working'), { recursive: true });
    let fd = openSync(join(dir, 'working'), constants.O_RDONLY | constants.O_DIRECTORY);
    for (let n = 0; n < 80; n++) {
      mkdirSync(`/proc/self/fd/${fd}/d`);
      const next = openSync(`/proc/self/fd/${fd}/d`, constants.O_RDONLY | constants.O_DIRECTORY);
      closeSync(fd);
      fd = next;
    }
    writeFileSync(`/proc/self/fd/${fd}/leaf.txt`, 'deep\n');
    closeSync(fd);

    const gitHref = pathToFileURL(join(import.meta.dirname, '..', 'src', 'git.ts')).href;
    const script = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { readdirSync } from 'node:fs';
      import { commit } from ${JSON.stringify(gitHref)};
      const before = readdirSync('/proc/self/fd').length;
      const hash = await commit(${JSON.stringify(dir)}, ${JSON.stringify(who)}, 'deep');
      assert.equal(readdirSync('/proc/self/fd').length, before);
      const leaf = 'working/' + 'd/'.repeat(80) + 'leaf.txt';
      assert.equal(execFileSync('git', ['show', hash + ':' + leaf], { cwd: ${JSON.stringify(dir)}, encoding: 'utf8' }), 'deep\\n');
    `;
    execFileSync('bash', ['-c', 'ulimit -n 256; exec "$@"', 'limit', process.execPath, '--input-type=module', '-e', script], { stdio: 'pipe', timeout: 10_000 });
    execFileSync('bash', ['-c', 'ulimit -n 64; exec "$@"', 'limit', process.execPath, '--input-type=module', '-e', script], { stdio: 'pipe', timeout: 10_000 });

    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { commit } from ${JSON.stringify(gitHref)};
      const base = ${JSON.stringify(join(root, 'move'))}, tree = base + '/inst', out = base + '/out';
      fs.mkdirSync(tree + '/working/z', { recursive: true });
      fs.mkdirSync(out + '/working', { recursive: true });
      fs.writeFileSync(out + '/secret.txt', 'outside');
      const before = fs.readdirSync('/proc/self/fd').length, orig = fs.readdirSync;
      let seenZ = false;
      fs.readdirSync = (...args) => {
        const r = orig(...args);
        if (!seenZ && typeof args[0] === 'string' && args[0].startsWith('/proc/self/fd/') && args[1]?.withFileTypes && r.length === 0) {
          seenZ = true;
          fs.renameSync(tree + '/working/z', out + '/working/z');
        }
        return r;
      };
      syncBuiltinESMExports();
      await assert.rejects(commit(tree, { name: 'A', email: 'a@b' }, 'moved'), /a folder moved/);
      fs.readdirSync = orig;
      syncBuiltinESMExports();
      assert.equal(fs.readdirSync('/proc/self/fd').length, before);
    `], { stdio: 'pipe', timeout: 10_000 });
  } finally {
    wipe(Buffer.from(root));
  }
});

