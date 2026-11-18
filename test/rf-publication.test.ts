import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const job = workflow.split(/^  (?=\S)/m).find(job => job.startsWith('rf:\n'));
const run = job?.match(/^      - working-directory: cli\n        run: \|\n((?: {10}[^\n]*\n)+)/m)?.[1];
assert.ok(run, 'expected the rf job’s cli run block');
const script = run.replace(/^ {10}/gm, '');

for (const { name, notes, existing, publish } of [
  { name: 'Manual release publishes to next', notes: 'Release notes\n\nManual: activate after verification', existing: false, publish: 'publish --provenance --tag next' },
  { name: 'ordinary release publishes to latest', notes: 'Release notes\nNo Manual: marker here', existing: false, publish: 'publish --provenance --tag latest' },
  { name: 'existing version is left alone', notes: 'Manual: activate after verification', existing: true, publish: '' },
]) {
  test(name, t => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-publication-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // The workflow can reach only these tools, never the real npm or git.
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync('/usr/bin/grep', join(bin, 'grep'));
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
if [[ "$*" == 'publish --provenance' ]]; then
  printf '%s\n' 'publish --provenance --tag latest' >> npm-calls
else
  printf '%s\n' "$*" >> npm-calls
fi
case "$1" in
  view) [[ "$EXISTING" == true ]] && printf '%s\n' '1.2.3' ;;
  publish) ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, 'git'), `#!/bin/bash
ref="refs/tags/$GITHUB_REF_NAME"
case "$1" in
  fetch) [[ "\${@: -2}" == "origin $ref:$ref" ]] && : > fetched ;;
  tag) [[ -f fetched && "$*" == "tag -l --format=%(contents) $GITHUB_REF_NAME" ]] && printf '%s\n' "$NOTES" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    execFileSync('/bin/bash', ['-e', '-c', script], {
      cwd: dir, env: { PATH: bin, GITHUB_REF_NAME: 'v9.8.7', NOTES: notes, EXISTING: String(existing) },
    });
    assert.deepEqual(readFileSync(join(dir, 'npm-calls'), 'utf8').trim().split('\n'),
      ['view @rfany/rf@1.2.3 version', ...(publish ? [publish] : [])]);
  });
}
