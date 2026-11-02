import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, rfDir, saveTree } from '../src/system.ts';
import { upsertUser } from '../src/auth.ts';
import { forgetLogins, logins, saveLogin, secret, use } from '../src/logins.ts';
import type { Instance } from '../src/store.ts';

test("a login's secret is sealed to its person and id, so a copy into another's folder won't open; a run uses only what's ticked", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-logins-')), alice = 'alice@demo.test', bob = 'bob@demo.test';
  initSystem(tmp);
  const login = { id: 'm365', kind: 'm365' as const, name: 'Microsoft 365', since: '2026-11-02T00:00:00Z', offers: [{ id: 'm365:mail:alice@demo.test', name: 'Mailbox' }] };
  saveLogin(alice, login, 'refresh-token-1');
  saveLogin(bob, { ...login, offers: [] }, 'bob-token');
  assert.equal(secret(alice, 'm365'), 'refresh-token-1');
  const people = join(rfDir(), 'people'), [a, b] = [alice, bob].map(p => readdirSync(people).find(d => readFileSync(join(people, d, 'logins.json'), 'utf8').includes(p === alice ? 'alice@demo.test' : '"offers": []'))!);
  assert.ok(!readFileSync(join(people, a, 'm365.sealed')).includes('refresh-token-1'));
  cpSync(join(people, a, 'm365.sealed'), join(people, b, 'm365.sealed'));
  assert.throws(() => secret(bob, 'm365'), /authenticate/);

  const inst = (logins: string[]) => ({ seriesId: 's', log: [{ op: 'create', by: alice, logins }] }) as unknown as Instance;
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  upsertUser(alice, { role: 'user' });
  assert.equal(use(inst(['m365:mail:alice@demo.test']), 'm365:mail:alice@demo.test').login.id, 'm365');
  assert.throws(() => use(inst([]), 'm365:mail:alice@demo.test'), /not ticked for this instance/);
  upsertUser(alice, { disabled: true });
  assert.throws(() => use(inst(['m365:mail:alice@demo.test']), 'm365:mail:alice@demo.test'), /alice@demo.test can no longer run this instance/, 'nor once disabled');
  upsertUser(alice, { disabled: false });
  saveTree({ workspaces: { w: { name: 'W', owners: [bob], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  assert.throws(() => use(inst(['m365:mail:alice@demo.test']), 'm365:mail:alice@demo.test'), /can no longer run this instance/, 'nor out of the workspace');
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  forgetLogins(alice);
  assert.deepEqual(logins(alice), []);
  assert.throws(() => use(inst(['m365:mail:alice@demo.test']), 'm365:mail:alice@demo.test'), /no longer has a login/);
  rmSync(tmp, { recursive: true, force: true });
});
