import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit } from '../src/git.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, maxBuffer: 64 << 20 });

test('a commit holds the whole folder, every file whatever its size or name, and links as links; nothing a run leaves bends it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-git-')), big = randomBytes(5 << 20), w = (rel: string, data: string | Buffer) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), data);
  };
  w('log.jsonl', '{"seq":1}\n');
  w('upload/AR aging.csv', 'a,b\n');
  w('working/run.sh', 'echo hi\n');
  chmodSync(join(dir, 'working/run.sh'), 0o755);
  w('working/big.bin', big);
  w('working/.gitignore', '*\n');
  w('working/repo/.git/HEAD', 'ref: refs/heads/main\n');
  w('working/repo/kept.txt', 'kept\n');
  w('working/.GIT/config', 'x\n');
  w('working/git~1', 'x\n');
  w('working/a\\.git', 'x\n');
  w('working/\\.git', 'kept: git takes a backslash first\n');
  symlinkSync('x', join(dir, 'working/.gitmodules'));
  w('working/two\nlines.txt', 'odd\n');
  writeFileSync(Buffer.concat([Buffer.from(join(dir, 'working') + '/'), Buffer.from([0xe9, 0x2e, 0x74, 0x78, 0x74])]), 'latin-1 name\n');
  symlinkSync('/etc/passwd', join(dir, 'working/passwd'));
  execFileSync('mkfifo', [join(dir, 'working/fifo')]);

  const first = await commit(dir, { name: 'Ann <Lee>', email: 'ann@x.com' }, 'Close 2026-09\n\nSigned-off-by: Ann Lee <ann@x.com>');
  assert.match(first, /^[0-9a-f]{40}$/);
  const files = git(dir, 'ls-tree', '-r', '-z', '--full-tree', first).toString().split('\0').filter(Boolean).map(l => [l.split(' ')[0], l.split('\t')[1]]);
  assert.deepEqual(files.map(([, p]) => p).sort(), ['log.jsonl', 'upload/AR aging.csv', 'working/.gitignore', 'working/big.bin', 'working/passwd', 'working/repo/kept.txt', 'working/run.sh', 'working/two\nlines.txt', 'working/\\.git', 'working/\ufffd.txt'].sort(), 'all but what git refuses');
  assert.deepEqual(Object.fromEntries(files.filter(([, p]) => ['working/run.sh', 'working/passwd', 'log.jsonl'].includes(p)).map(([m, p]) => [p, m])), { 'log.jsonl': '100644', 'working/run.sh': '100755', 'working/passwd': '120000' });
  assert.equal(git(dir, 'show', `${first}:working/passwd`).toString(), '/etc/passwd', 'the link, never what it points to');
  assert.ok(git(dir, 'show', `${first}:working/big.bin`).equals(big));
  assert.equal(git(dir, 'log', '-1', '--format=%an|%ae|%B', first).toString().trim(), 'Ann Lee|ann@x.com|Close 2026-09\n\nSigned-off-by: Ann Lee <ann@x.com>');
  assert.equal(git(dir, 'status', '--porcelain', '--', 'upload').toString(), '', 'the index is the commit, for a run to diff against');

  w('working/run.sh', 'echo bye\n');
  const [second, third] = await Promise.all([commit(dir, { name: 'agent', email: 'agent@x' }, 'Run 2'), commit(dir, { name: 'agent', email: 'agent@x' }, 'Run 2, again')]);
  assert.equal(git(dir, 'rev-parse', `${third}^`).toString().trim(), second, 'one at a time');
  assert.equal(git(dir, 'rev-parse', `${second}^`).toString().trim(), first);
  assert.equal(git(dir, 'diff', '--name-only', first, second).toString(), 'working/run.sh\n');
  rmSync(dir, { recursive: true, force: true });
});
