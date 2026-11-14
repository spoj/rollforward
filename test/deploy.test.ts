import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the server and updater units load the same drain configuration', () => {
  const doc = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8');
  const server = doc.split('The unit `~/.config/systemd/user/rollforward.service`')[1].split('\n')[0];
  const updater = doc.split('# ~/.config/systemd/user/rollforward-update.service')[1].split('# ~/.config/systemd/user/')[0];
  assert.match(server, /node --env-file=%h\/\.config\/rollforward\.env/);
  assert.match(updater, /node --env-file=%h\/\.config\/rollforward\.env/);
});

test('the container drain signals the container rather than the systemd monitor PID', () => {
  const doc = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8');
  assert.match(doc, /podman kill --signal=SIGUSR2 rollforward/);
});
