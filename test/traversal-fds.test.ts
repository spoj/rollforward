import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { pylib } from '../src/runner.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pylib removes every top-level Python startup hook while keeping ordinary modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-pylib-hooks-')), dir = join(root, '.pylib');
  try {
    mkdirSync(dir);
    for (const file of ['sitecustomize.py', 'sitecustomize.pyc', 'usercustomize.py', 'evil.pth', 'useful.py']) writeFileSync(join(dir, file), 'pass');
    mkdirSync(join(dir, 'sitecustomize'));
    writeFileSync(join(dir, 'sitecustomize', '__init__.py'), 'pass');
    pylib(dir, root);
    assert.deepEqual(readdirSync(dir), ['useful.py']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ['pylib', 'wipe']) test(`${operation} walks deep and wide trees with a bounded number of directory descriptors`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-fds-'));
  try {
    execFileSync('bash', ['-c', 'ulimit -n 64; exec "$@"', 'traversal', process.execPath, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs, { closeSync, constants, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pylib } from './src/runner.ts';
      import { wipe } from './src/store.ts';
      const root = ${JSON.stringify(root)}, dir = root + '/tree';
      mkdirSync(dir);
      let fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
      for (let n = 0; n < 128; n++) {
        const at = '/proc/self/fd/' + fd;
        for (let i = 0; i < 4; i++) writeFileSync(at + '/file' + i, 'x');
        mkdirSync(at + '/d');
        const next = openSync(at + '/d', constants.O_RDONLY | constants.O_DIRECTORY);
        closeSync(fd);
        fd = next;
      }
      closeSync(fd);
      const before = readdirSync('/proc/self/fd').length, original = fs.readdirSync;
      let reads = 0;
      fs.readdirSync = (...args) => {
        if (++reads === 10) throw Object.assign(new Error('read failed'), { code: 'EIO' });
        return original(...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => ${operation === 'pylib' ? 'pylib(dir, root)' : 'wipe(Buffer.from(dir))'}, { code: 'EIO' });
      fs.readdirSync = original;
      syncBuiltinESMExports();
      assert.equal(readdirSync('/proc/self/fd').length, before, 'failed traversal closes every descriptor');
      const originalOpen = fs.openSync;
      let opens = 0;
      fs.openSync = (...args) => { opens++; return originalOpen(...args); };
      syncBuiltinESMExports();
      ${operation === 'pylib' ? "pylib(dir, root);" : "wipe(Buffer.from(dir));"}
      assert.ok(opens < 128 * 20, 'directory opens grow linearly with depth, not quadratically: ' + opens);
      assert.equal(readdirSync('/proc/self/fd').length, before);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ['pylib', 'wipe']) test(`${operation} refuses a moved directory's new parent and closes its descriptors`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-fds-move-'));
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pylib } from './src/runner.ts';
      import { wipe } from './src/store.ts';
      const root = ${JSON.stringify(root)}, dir = root + '/tree', outside = root + '/outside';
      fs.mkdirSync(dir + '/z', { recursive: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(dir + '/victim', 'inside');
      fs.writeFileSync(outside + '/victim', 'outside');
      const before = fs.readdirSync('/proc/self/fd').length, original = fs.readdirSync;
      let reads = 0;
      fs.readdirSync = (...args) => {
        if (++reads === 2) fs.renameSync(dir + '/z', outside + '/z');
        return original(...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => ${operation === 'pylib' ? 'pylib(dir, root)' : 'wipe(Buffer.from(dir))'}, /a folder moved/);
      assert.equal(fs.readFileSync(outside + '/victim', 'utf8'), 'outside');
      assert.equal(fs.readdirSync('/proc/self/fd').length, before);
    `], { cwd: join(import.meta.dirname, '..'), timeout: 10_000, stdio: 'pipe' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
