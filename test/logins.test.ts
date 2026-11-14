import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initSystem, rfDir, saveTree } from '../src/system.ts';
import { upsertUser } from '../src/auth.ts';
import { forgetLogins, logins, saveLogin, secret, signOut, use } from '../src/logins.ts';
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
  assert.throws(() => signOut(bob, `../${a}/m365`), /you have no login/, "nor signs out another's");
  assert.equal(secret(alice, 'm365'), 'refresh-token-1');
  cpSync(join(people, a, 'm365.sealed'), join(people, b, 'm365.sealed'));
  assert.throws(() => secret(bob, 'm365'), /authenticate/);

  const inst = (logins: string[], ...later: object[]) => ({ seriesId: 's', log: [{ seq: 1, op: 'create', by: alice, logins }, { seq: 2, op: 'run', run: 1, runner: alice, consent: 1 }, ...later] }) as unknown as Instance;
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  upsertUser(alice, { role: 'user' });
  assert.equal(use(inst(['m365:mail:alice@demo.test']), 1, 'm365:mail:alice@demo.test').login.id, 'm365');
  assert.throws(() => use(inst([]), 1, 'm365:mail:alice@demo.test'), /not ticked for this instance/);
  assert.throws(() => use(inst([], { seq: 3, op: 'logins', by: alice, logins: ['m365:mail:alice@demo.test'] }), 1, 'm365:mail:alice@demo.test'), /not ticked/, 'a tick added during a run waits for the next');
  assert.throws(() => use(inst(['m365:mail:alice@demo.test'], { seq: 3, op: 'logins', by: alice, logins: [] }), 1, 'm365:mail:alice@demo.test'), /not ticked/, 'one taken away stops it at once');
  upsertUser(bob, { role: 'user' });
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [bob] } }, series: { s: { name: 'S', workspace: 'w' } } });
  assert.throws(() => use(inst(['m365:mail:alice@demo.test'], { seq: 3, op: 'assign', by: alice, to: bob, from: alice, logins: [] }), 1, 'm365:mail:alice@demo.test'), /run 1 was alice@demo\.test's, and bob@demo\.test runs the instance now/, "assigned as it stops, a run lends nothing of the new runner's");
  upsertUser(alice, { disabled: true });
  assert.throws(() => use(inst(['m365:mail:alice@demo.test']), 1, 'm365:mail:alice@demo.test'), /alice@demo.test can no longer run this instance/, 'nor once disabled');
  upsertUser(alice, { disabled: false });
  saveTree({ workspaces: { w: { name: 'W', owners: [bob], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  assert.throws(() => use(inst(['m365:mail:alice@demo.test']), 1, 'm365:mail:alice@demo.test'), /can no longer run this instance/, 'nor out of the workspace');
  upsertUser(alice, { role: 'admin' });
  assert.equal(use({ ...inst(['m365:mail:alice@demo.test']), seriesId: 'tried' } as Instance, 1, 'm365:mail:alice@demo.test').login.id, 'm365', "an admin's, even in no workspace, as a try is");
  upsertUser(alice, { role: 'user' });
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  forgetLogins(alice);
  assert.deepEqual(logins(alice), []);
  assert.throws(() => use(inst(['m365:mail:alice@demo.test']), 1, 'm365:mail:alice@demo.test'), /no longer has a login/);
  rmSync(tmp, { recursive: true, force: true });
});

test("a person's logins are rewritten whole, so a write a full disk cuts short leaves the ones before", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-logins-')), alice = 'alice@demo.test';
  initSystem(tmp);
  const login = { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '2026-11-02T00:00:00Z', offers: [] };
  saveLogin(alice, login, 'refresh-token-1');
  // A file size limit stands in for a full disk.
  const out = execFileSync('bash', ['-c', `trap '' XFSZ; ulimit -f 64; exec "${process.execPath}" --input-type=module -e "$0"`, `
    import { initSystem } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'system.ts')).href)};
    import { saveLogin } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'logins.ts')).href)};
    initSystem(${JSON.stringify(tmp)});
    try { saveLogin(${JSON.stringify(alice)}, { id: 'web:big', kind: 'website', name: 'Big', since: '2026-11-02T00:00:00Z', offers: [], trace: { requests: {}, blocked: Array(20000).fill('host.example.com'), seconds: 1 } }); } catch (e) { console.log(e.code); }`], { encoding: 'utf8' });
  assert.equal(out.trim(), 'EFBIG');
  assert.deepEqual(logins(alice).map(l => l.id), ['m365']);
  rmSync(tmp, { recursive: true, force: true });
});
