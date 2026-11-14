import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const value of ['-1', 'NaN', 'Infinity', '40000']) test(`RF_DRAIN_MIN=${value} is rejected by both server and updater before doing work`, () => {
  for (const file of ['src/waker.ts', 'scripts/update.ts']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./${file}');`], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, RF_DRAIN_MIN: value }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /RF_DRAIN_MIN must be between 0 and 35791 minutes/, `${file}: ${result.stdout}${result.stderr}`);
  }
});

test('a drain timer does not keep the process alive', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { drain, updating } from './src/waker.ts';
    import { changes } from './src/system.ts';
    changes.removeAllListeners('change');
    drain(); drain();
    console.log(updating());
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, RF_DRAIN_MIN: '15' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0');
});
