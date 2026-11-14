import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { upsertUser, type Me } from '../src/auth.ts';
import { changeWebsite, websitesOf, type Profile } from '../src/browsers.ts';
import { logins, personDir, saveLogin } from '../src/logins.ts';
import { createInstance, openStore } from '../src/store.ts';
import { approved, ask, decide, forgetGrants, forgetWorkspace, grants, lapse, pruneGrants, revoke, unapproved, visible, type Grant } from '../src/grants.ts';

const person: Me = { email: 'bob@demo.test', name: 'Bob Baker', role: 'user', groups: [] };
const owner: Me = { email: 'alice@demo.test', name: 'Alice Owner', role: 'user', groups: [] };
const admin: Me = { email: 'admin@demo.test', name: 'Admin', role: 'admin', groups: [] };
const outsider: Me = { email: 'carol@demo.test', name: 'Carol', role: 'user', groups: [] };
const profile: Profile = { what: 'Acme supplier portal', category: 'vendor', risk: 'medium', flags: ['Can approve invoices'] };
const grant: Grant = { workspace: 'w', person: person.email, site: 'portal', reason: 'Weekly invoice pull', at: '2026-11-02T00:00:00Z', state: 'pending' };

beforeEach(t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-grants-')), key = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
    rmSync(root, { recursive: true, force: true });
  });
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: {
    w: { name: 'Acme', owners: [owner.email], members: [person.email] },
    other: { name: 'Other workspace', owners: [owner.email], members: [person.email] },
  }, series: { s: { name: 'Invoices', workspace: 'w' }, other: { name: 'Other invoices', workspace: 'other' } } });
  for (const who of [person, owner, admin, outsider]) upsertUser(who.email, { name: who.name, role: who.role });
  saveLogin(person.email, { id: 'web:portal', kind: 'website', name: 'portal', since: grant.at, offers: [{ id: 'web:portal', name: 'portal' }],
    trace: { requests: { 'portal.example.com': { 200: 3 } }, blocked: [], seconds: 30 } });
  writeFileSync(join(personDir(person.email), 'websites.json'), JSON.stringify({
    portal: { url: 'https://portal.example.com/', hosts: ['portal.example.com'], writeback: true, added: grant.at, profile,
      checks: { 'portal.example.com': { verdict: 'pass', why: 'Known website host' } } },
  }));
});

test('a request reuses the website profile and gives owners a plain decision card, not hosts or a new grant check', async () => {
  const result = await ask(person, 'portal', 'w', '  Weekly invoice pull  ');
  assert.deepEqual(result.profile, profile);
  assert.equal('check' in result, false);
  assert.equal('check' in grants()[result.id], false);
  assert.equal(grants()[result.id].reason, grant.reason);
  const [card] = visible(owner);
  assert.deepEqual([card.id, card.url, card.personName, card.workspaceName, card.profile, card.flags, card.adminOnly, card.adminWhy, card.use],
    [result.id, 'https://portal.example.com/', person.name, 'Acme', profile, profile.flags, false, '', null]);
  assert.match(card.description, /Bob Baker asks that runs in Acme use their login to portal/);
  assert.match(card.description, /Acme supplier portal \(vendor system, portal\.example\.com\)/);
  assert.match(card.description, /Their reason: Weekly invoice pull/);
  assert.match(card.description, /whatever Bob Baker can, including submitting and approving/);
  assert.match(card.description, /not an enforced limit/);
  assert.equal('hosts' in card, false);
  assert.equal(visible(person)[0].id, result.id);
  assert.equal(visible(admin)[0].id, result.id);
  assert.deepEqual(visible(outsider), []);
  await assert.rejects(ask(person, 'portal', 'w', 'again'), /asked for.*already/);
  assert.throws(() => decide(person, result.id, true, ''), /owners decide/);
  decide(owner, result.id, true, '  Intended use agreed  ');
  assert.equal(grants()[result.id].text, 'Intended use agreed');
  assert.equal(approved('portal', person.email, 'w'), true);
  assert.deepEqual(visible(owner)[0].use, { runs: 0, wrote: 0, last: null });
  assert.deepEqual(websitesOf(person.email).portal.hosts, ['portal.example.com']);
});

test('missing and errored profiles are retried through the backend; a failed check requires an admin, without blocking a request', async () => {
  for (const previous of [undefined, { error: 'Previous failure' }]) {
    changeWebsite(person.email, 'portal', { profile: previous });
    const { id, profile: checked } = await ask(person, 'portal', 'w', grant.reason);
    assert.ok('error' in checked);
    assert.match(checked.error, /OPENROUTER_API_KEY/);
    assert.deepEqual(websitesOf(person.email).portal.profile, checked);
    const card = visible(owner)[0];
    assert.equal(card.adminOnly, true);
    assert.match(card.adminWhy, /could not be checked.*OPENROUTER_API_KEY/);
    assert.ok(card.flags.some(flag => flag.includes('OPENROUTER_API_KEY')));
    assert.throws(() => decide(owner, id, true, ''), { status: 403, message: card.adminWhy });
    assert.equal(grants()[id].state, 'pending');
    decide(admin, id, true, '');
    assert.equal(grants()[id].state, 'approved');
    forgetGrants(person.email, 'portal');
  }
});

test('an errored profile is refreshed using the login trace, without sending the request reason or checking again for another workspace', async t => {
  const requests: any[] = [];
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ profile, hosts: {} }) } }] });
  });
  changeWebsite(person.email, 'portal', { profile: { error: 'Previous failure' } });
  const result = await ask(person, 'portal', 'w', grant.reason);
  assert.deepEqual(result.profile, profile);
  assert.deepEqual(websitesOf(person.email).portal.profile, profile);
  assert.equal(requests.length, 1);
  const evidence = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(evidence.evidence, logins(person.email)[0].trace);
  assert.equal('reason' in evidence, false);
  assert.equal('workspace' in evidence, false);
  assert.equal('check' in grants()[result.id], false);
  assert.equal(visible(owner)[0].adminOnly, false);
  await ask(person, 'portal', 'other', 'Another workspace reason');
  assert.equal(requests.length, 1);
});

test('general-purpose, high-risk, unchecked and legacy high-risk grants need admins; old checks display but never add hosts', () => {
  const old = { risk: 'high' as const, flags: ['Old concern'], summary: 'Legacy summary', hosts: ['extra.example.com'] };
  const cases: { profile: Profile | undefined; check?: Grant['check']; why: RegExp }[] = [
    { profile: { ...profile, category: 'general', risk: 'low' }, why: /general-purpose/ },
    { profile: { ...profile, risk: 'high' }, why: /profile rates portal high risk/ },
    { profile, check: old, why: /old check rates portal high risk/ },
    { profile: undefined, check: old, why: /old check rates portal high risk/ },
    { profile: undefined, why: /profile is missing/ },
    { profile: { error: 'Check failed' }, why: /Check failed/ },
    { profile: { error: 'Check failed' }, check: { ...old, risk: 'low' }, why: /Check failed/ },
  ];
  for (const c of cases) {
    changeWebsite(person.email, 'portal', { profile: c.profile });
    writeJson('grants.json', { g: { ...grant, ...(c.check && { check: c.check }) } });
    const card = visible(owner)[0];
    assert.equal(card.adminOnly, true);
    assert.match(card.adminWhy, c.why);
    assert.throws(() => decide(owner, 'g', true, ''), { status: 403, message: card.adminWhy });
    if (c.check) {
      assert.ok(card.check && 'summary' in card.check);
      assert.equal(card.check.summary, 'Legacy summary');
      assert.ok(card.flags.includes('Old concern'));
    }
    decide(admin, 'g', true, '');
    assert.equal(grants().g.state, 'approved');
    assert.deepEqual(websitesOf(person.email).portal.hosts, ['portal.example.com']);
  }
  for (const category of ['company', 'vendor', 'bank', 'government'] as const) {
    changeWebsite(person.email, 'portal', { profile: { ...profile, category } });
    writeJson('grants.json', { g: { ...grant, check: { ...old, risk: 'low' } } });
    assert.equal(visible(owner)[0].adminOnly, false);
    decide(owner, 'g', true, '');
    assert.deepEqual(websitesOf(person.email).portal.hosts, ['portal.example.com']);
  }
  changeWebsite(person.email, 'portal', { profile: undefined });
  for (const risk of ['low', 'medium'] as const) {
    writeJson('grants.json', { g: { ...grant, check: { ...old, risk } } });
    const card = visible(owner)[0];
    assert.equal(card.profile, null);
    assert.equal(card.adminOnly, false);
    assert.equal(card.adminWhy, '');
    assert.deepEqual(card.flags, ['Old concern']);
    assert.match(card.description, /Legacy summary/);
    decide(owner, 'g', true, '');
    assert.deepEqual(websitesOf(person.email).portal.hosts, ['portal.example.com']);
  }
  changeWebsite(person.email, 'portal', { profile });
  writeJson('grants.json', { g: { ...grant, check: { error: 'Old model was unavailable' } } });
  assert.ok(visible(owner)[0].flags.includes('The old check failed: Old model was unavailable'));
  decide(owner, 'g', true, '');
});

test('whoever may approve their own ask has it approved as they ask, by them, but what the check reserves for admins waits for one; a refused run names the step and whose it is', async () => {
  const group = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', t = tree();
  saveTree({ ...t, groups: { [group]: 'Finance HK' }, workspaces: { ...t.workspaces,
    mine: { name: 'Mine', owners: [person.email], members: [] }, team: { name: 'Team', owners: [group, owner.email], members: [person.email] }, none: { name: 'Nobody', owners: [], members: [] } } });
  const refused = (ws: string, then: string) => `bob@demo.test has no approved grant to use portal in ${ws}, so this run goes on without it: ${then}`;
  assert.equal(unapproved(person.email, 'portal', 'mine'), refused('Mine', "they ask for one on the Logins page, under portal, choosing Mine, and, as they're an owner of Mine, it's approved at once"));
  assert.equal(unapproved(person.email, 'portal', 'team'), refused('Team', "they ask for one on the Logins page, under portal, choosing Team, and it then waits on Team's owners, Finance HK and Alice Owner, to approve it"));
  assert.equal(unapproved(person.email, 'portal', 'none'), refused('Nobody', 'they ask for one on the Logins page, under portal, choosing Nobody, and it then waits on an admin to approve it'));
  assert.equal(unapproved(person.email, 'portal'), 'bob@demo.test has no approved grant to use portal: they ask for one on the Logins page, under portal; this run goes on without it', "a try's instance is in no workspace");

  const own = await ask(person, 'portal', 'mine', grant.reason), at = grants()[own.id];
  assert.deepEqual([own.state, own.said], ['approved', "Approved at once, as you're an owner of Mine."]);
  assert.deepEqual(Object.keys(at), ['workspace', 'person', 'site', 'reason', 'at', 'state', 'by', 'decided'], 'recorded as their approval is, with no text');
  assert.deepEqual([at.state, at.by, Date.parse(at.decided!) >= Date.parse(at.at)], ['approved', person.email, true]);
  assert.equal(approved('portal', person.email, 'mine'), true);
  const asked = await ask(person, 'portal', 'team', grant.reason);
  assert.deepEqual([asked.state, asked.said, grants()[asked.id].state], ['pending', "Asked: it waits on Team's owners, Finance HK and Alice Owner, to approve it.", 'pending']);
  assert.equal(unapproved(person.email, 'portal', 'team'), refused('Team', `they asked for one on ${grants()[asked.id].at.slice(0, 10)}, which waits on Team's owners, Finance HK and Alice Owner, to approve it`));

  forgetGrants(person.email, 'portal');
  changeWebsite(person.email, 'portal', { profile: { ...profile, category: 'general' } });
  assert.equal(unapproved(person.email, 'portal', 'mine'), refused('Mine', 'they ask for one on the Logins page, under portal, choosing Mine, and it then waits on an admin to approve it, as this is a general-purpose website'));
  const reserved = await ask(person, 'portal', 'mine', grant.reason);
  assert.deepEqual([reserved.state, reserved.said], ['pending', 'Asked: it waits on an admin to approve it, as this is a general-purpose website.'], 'an owner asking for what the check reserves for admins waits for one');
  assert.equal(unapproved(person.email, 'portal', 'mine'), refused('Mine', `they asked for one on ${grants()[reserved.id].at.slice(0, 10)}, which waits on an admin to approve it, as this is a general-purpose website`));
  decide(admin, reserved.id, true, '');

  saveTree({ ...tree(), workspaces: { ...tree().workspaces, mine: { name: 'Mine', owners: [], members: [person.email] } } });
  writeJson('grants.json', { old: { ...grant, workspace: 'mine', person: admin.email } });
  saveLogin(admin.email, { id: 'web:portal', kind: 'website', name: 'portal', since: grant.at, offers: [{ id: 'web:portal', name: 'portal' }] });
  writeFileSync(join(personDir(admin.email), 'websites.json'), JSON.stringify({ portal: { ...websitesOf(person.email).portal } }));
  assert.equal(unapproved(admin.email, 'portal', 'mine'), `admin@demo.test has no approved grant to use portal in Mine, so this run goes on without it: they asked for one on 2026-11-02, which waits on them, as an admin, to approve it under Waiting on you`, 'a request from before asking approved at once waits on whoever may decide it');
  const mine = await ask(admin, 'portal', 'team', grant.reason);
  assert.deepEqual([mine.state, mine.said, grants()[mine.id].by], ['approved', "Approved at once, as you're an admin.", admin.email], 'an admin, even of a general-purpose website');
});

test('approved usage counts distinct runs with browser summaries and writes, scoped to workspace, person and site, excluding copied history', () => {
  writeJson('grants.json', { g: { ...grant, state: 'approved' }, pending: { ...grant, workspace: 'other' } });
  const first = createInstance('s', 'First', person.email, ['web:portal']);
  const second = createInstance('s', 'Second', person.email, ['web:portal']);
  const elsewhere = createInstance('other', 'Elsewhere', person.email, ['web:portal']);
  for (const [run, writes, at] of [[1, 0, '2026-11-02T10:00:00Z'], [1, 2, '2026-11-05T10:00:00Z'], [2, 0, '2026-11-03T10:00:00Z']] as const) {
    first.append('server', 'browser', { run, site: 'portal', login: person.email, requests: 5, writes, at });
  }
  for (const action of ['refused', 'wait', 'drive', 'allowed']) first.append('server', 'browser', { run: 9, site: 'portal', login: person.email, action, writes: 10, at: '2026-12-01T00:00:00Z' });
  first.append('server', 'shot', { run: 9, site: 'portal', login: person.email, writes: 10, at: '2026-12-01T00:00:00Z' });
  second.append('server', 'browser', { run: 1, site: 'portal', login: person.email, requests: 5, writes: 1, at: '2026-11-07T10:00:00Z' });
  second.append('server', 'browser', { run: 2, site: 'portal', login: owner.email, requests: 5, writes: 1, at: '2026-12-01T00:00:00Z' });
  second.append('server', 'browser', { run: 3, site: 'another', login: person.email, requests: 5, writes: 1, at: '2026-12-01T00:00:00Z' });
  elsewhere.append('server', 'browser', { run: 1, site: 'portal', login: person.email, requests: 5, writes: 1, at: '2026-12-01T00:00:00Z' });
  // A copy as earlier versions made one: the source's entries, then a duplicate entry.
  const copy = createInstance('s', 'Copy', person.email, ['web:portal']);
  for (const { seq, at, by, op, ...e } of first.log) copy.append(by, op, e);
  copy.append(person.email, 'duplicate', { from: 'First', logins: ['web:portal'] });
  copy.append('server', 'browser', { run: 3, site: 'portal', login: person.email, requests: 0, writes: 0, at: '2026-11-08T10:00:00Z' });
  assert.deepEqual(visible(owner).find(g => g.id === 'g')!.use, { runs: 4, wrote: 2, last: '2026-11-08T10:00:00Z' });
  assert.equal(visible(owner).find(g => g.id === 'pending')!.use, null);
  second.append('server', 'browser', { run: 4, site: 'portal', login: person.email, requests: 1, writes: 1, at: '2026-11-09T10:00:00Z' });
  assert.deepEqual(visible(owner).find(g => g.id === 'g')!.use, { runs: 5, wrote: 3, last: '2026-11-09T10:00:00Z' }, 'a grown log is read again');
});

test('owners may deny restricted requests, and lapse, withdrawal and removal keep their existing login cleanup', async () => {
  changeWebsite(person.email, 'portal', { profile: { ...profile, category: 'general' } });
  const { id } = await ask(person, 'portal', 'w', grant.reason);
  decide(owner, id, false, 'Not needed');
  assert.equal(grants()[id].state, 'denied');
  assert.deepEqual(logins(person.email), []);
  writeJson('grants.json', { pending: grant, approved: { ...grant, state: 'approved', workspace: 'other' } });
  saveLogin(person.email, { id: 'web:portal', kind: 'website', name: 'portal', since: grant.at, offers: [] });
  lapse(Date.parse(grant.at) + 8 * 86_400_000);
  assert.deepEqual([grants().pending.state, grants().approved.state, logins(person.email).length], ['lapsed', 'approved', 1]);
  revoke(person, 'approved');
  assert.deepEqual([grants().approved.state, logins(person.email)], ['revoked', []]);
  writeJson('grants.json', { a: grant, b: { ...grant, workspace: 'other' }, c: { ...grant, person: owner.email } });
  forgetWorkspace('other');
  assert.deepEqual(Object.keys(grants()), ['a', 'c']);
  forgetGrants(person.email, 'portal');
  assert.deepEqual(Object.keys(grants()), ['c']);
  forgetGrants(owner.email);
  assert.deepEqual(Object.keys(grants()), []);
});

test('losing workspace visibility revokes live grants, hides the workspace from grants endpoints, and aborts an in-flight ask', async () => {
  const { id } = await ask(person, 'portal', 'w', grant.reason);
  decide(owner, id, true, '');
  assert.throws(() => decide(outsider, id, true, ''), { status: 404, message: `no request ${id} waits` });
  assert.throws(() => revoke(outsider, id), (e: any) => e.status === 404 && !String(e.message).includes('Acme'));

  // Removing Bob from Acme revokes his grant there, hides Acme from visible(person), and signs him out when unused elsewhere.
  saveTree({ ...tree(), workspaces: { ...tree().workspaces, w: { ...tree().workspaces.w, members: [] } } });
  pruneGrants();
  assert.equal(grants()[id].state, 'revoked');
  assert.equal(approved('portal', person.email, 'w'), false);
  assert.deepEqual(visible(person), []);
  assert.deepEqual(logins(person.email), []);

  // An admin demoted during checkWebsite cannot self-approve or create a grant in a workspace they no longer see.
  saveLogin(admin.email, { id: 'web:portal', kind: 'website', name: 'portal', since: grant.at, offers: [{ id: 'web:portal', name: 'portal' }],
    trace: { requests: { 'portal.example.com': { 200: 1 } }, blocked: [], seconds: 5 } });
  writeFileSync(join(personDir(admin.email), 'websites.json'), JSON.stringify({
    portal: { url: 'https://portal.example.com/', hosts: ['portal.example.com'], writeback: true, added: grant.at,
      checks: { 'portal.example.com': { verdict: 'pass', why: 'Known' } } },
  }));
  upsertUser(admin.email, { role: 'user' });
  await assert.rejects(() => ask(admin, 'portal', 'w', 'Audit check'), { status: 404 });
  assert.equal(Object.values(grants()).some(g => g.person === admin.email), false);
});
