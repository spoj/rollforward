import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initSystem, rfDir, saveTree } from '../src/system.ts';
import { upsertUser } from '../src/auth.ts';
import { authority, forgetLogins, logins, saveLogin, secret, signOut, use } from '../src/logins.ts';
import { createInstance, openStore, seriesDir, type Instance } from '../src/store.ts';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';
import { ownSeries } from './owner-fixture.ts';

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

  openStore(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [bob] } }, series: { s: { name: 'S', workspace: 'w' } } });
  upsertUser(alice, { role: 'user' });
  upsertUser(bob, { role: 'user' });
  let n = 0;
  const inst = (logins: string[]) => {
    ownSeries('s', alice, logins);
    const i = createInstance('s', `Run ${++n}`, bob);
    i.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: authority(i) });
    return i;
  };
  const offer = 'm365:mail:alice@demo.test';
  assert.equal(use(inst([offer]), 1, offer).login.id, 'm365');
  const narrow = inst([]), settings = seriesSettings(seriesDir('s'));
  assert.throws(() => use(narrow, 1, offer), /outside this run's selected series credentials/);
  saveSeriesSettings(seriesDir('s'), { ...settings, consent: { ...settings.consent!, logins: [offer] } });
  assert.throws(() => use(narrow, 1, offer), /outside this run's selected series credentials/, 'an addition waits for the next run');
  const removed = inst([offer]);
  ownSeries('s', alice, []);
  assert.throws(() => use(removed, 1, offer), /series authority has ended/, 'removal revokes the old epoch at once');
  const transferred = inst([offer]);
  ownSeries('s', bob);
  assert.throws(() => use(transferred, 1, offer), /series authority has ended/, 'transfer cannot lend the incoming owner credentials');
  const disabled = inst([offer]);
  upsertUser(alice, { disabled: true });
  assert.throws(() => use(disabled, 1, offer), /series authority has ended/, 'nor once disabled');
  upsertUser(alice, { disabled: false });
  const outside = inst([offer]);
  saveTree({ workspaces: { w: { name: 'W', owners: [bob], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  assert.throws(() => use(outside, 1, offer), /series authority has ended/, 'nor out of the workspace');
  upsertUser(alice, { role: 'admin' });
  assert.equal(use({ id: 'try', log: [{ op: 'run', run: 1, runner: alice, authority: { version: 1, owner: alice, epoch: 0, workspace: '', logins: [offer] } }] } as Instance, 1, offer).login.id, 'm365', 'try captures its explicit admin authority');
  upsertUser(alice, { role: 'user' });
  saveTree({ workspaces: { w: { name: 'W', owners: [alice], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });
  const forgotten = inst([offer]);
  forgetLogins(alice);
  assert.deepEqual(logins(alice), []);
  assert.throws(() => use(forgotten, 1, offer), /no longer has a login/);
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
