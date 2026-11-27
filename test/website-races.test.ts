import { after, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changes, initSystem, rfDir, saveTree, writeJson } from '../src/system.ts';
import { upsertUser, type Me } from '../src/auth.ts';
import type { Trace } from '../src/logins.ts';

type Pause = { seen: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };
const pauses = new Map<string, Pause>(), pendingPauses = new Set<Pause>(), sessions = new Map<string, string>(), models: any[] = [];
const email = 'alice@company.test', url = 'https://vendor.review.test/';
const profile = { what: 'A vendor accounting portal', category: 'vendor', risk: 'low', flags: [] };
let serial = 0, extraHosts: string[] = [], modelProfile = profile, search = false, exaCalls = 0;
const service = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://service');
  const body = req.method === 'POST' ? JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()) : undefined;
  if (u.pathname === '/api/v1/chat/completions') models.push(body);
  const pending = pauses.get(`${req.method} ${u.pathname}`);
  if (pending) {
    pauses.delete(`${req.method} ${u.pathname}`);
    pending.seen.resolve();
    await pending.release.promise;
  }
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/blocked') return void res.end(JSON.stringify(Object.fromEntries(u.searchParams.getAll('host').map(h => [h, false]))));
  if (u.pathname === '/search') { exaCalls++; return void res.end(JSON.stringify({ results: [], costDollars: { total: 0.005 } })); }
  if (u.pathname === '/api/v1/chat/completions') {
    if (search && !body.messages.some((m: any) => m.role === 'tool')) return void res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'search1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'vendor.review.test operator' }) } }] } }] }));
    const evidence = JSON.parse(body.messages[1].content);
    const checked = evidence.website.address.startsWith('general.') ? { ...profile, what: 'A public file-sharing service', category: 'general', risk: 'high' } : modelProfile;
    const hosts = Object.fromEntries(evidence.unchecked.map((h: string) => [h, { verdict: 'pass', why: 'Its role was checked.' }]));
    return void res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ profile: checked, hosts }) } }] }));
  }
  if (req.method === 'POST' && u.pathname === '/sessions') {
    const id = `b${++serial}`;
    sessions.set(id, new URL(body.site.start_url).hostname);
    return void res.writeHead(201).end(JSON.stringify({ id }));
  }
  const id = u.pathname.split('/')[2], host = sessions.get(id)!;
  const log = [{ method: 'GET', url: `https://${host}/private?code=not-evidence`, status: 200, live: true }, ...extraHosts.map(h => ({ method: 'GET', url: `https://${h}/`, status: 200 }))];
  if (req.method === 'DELETE') return void res.end(JSON.stringify({ state: { cookies: [{ name: 'sid', domain: host, value: id }], origins: [] }, log }));
  if (u.pathname.endsWith('/log')) return void res.end(JSON.stringify(log));
  res.end('{}');
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_BROWSER_KEY: 'browser-key', RF_PUBLIC_URL: 'https://rf.company.test', OPENROUTER_API_KEY: 'server-key' });
delete process.env.EXA_API_KEY;
const { addSite, allowHost, changeWebsite, checkWebsite, drainWebsiteChecks, endSignIn, isCheckingWebsite, refuseHost, removeHost, removeSite, revokeInternalHosts, setSite, siteRevision, startSignIn, websitesOf } = await import('../src/browsers.ts');
const { letIn, setLetIn, upstreams } = await import('../src/connections.ts');
const { logins, personDir, saveLogin, seal, secret, signOut } = await import('../src/logins.ts');
const { ask, decide, visible } = await import('../src/grants.ts');
upstreams['openrouter.ai'] = base;
upstreams['api.exa.ai'] = base;
after(async () => { await new Promise<void>(ok => service.close(() => ok())); });
beforeEach(t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-website-races-'));
  initSystem(root);
  writeJson('connections.json', {});
  writeJson('internal.json', {});
  models.length = 0;
  extraHosts = [];
  modelProfile = profile;
  search = false;
  exaCalls = 0;
  delete process.env.EXA_API_KEY;
  delete process.env.RF_SIGNIN_S;
  t.after(async () => {
    for (const p of pendingPauses) p.release.resolve();
    await drainWebsiteChecks(1000);
    pendingPauses.clear();
    rmSync(root, { recursive: true, force: true });
  });
});
function pause(t: TestContext, path: string) {
  const pending = { seen: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  pauses.set(path, pending);
  pendingPauses.add(pending);
  t.after(() => pending.release.resolve());
  return pending;
}
const portal = () => addSite(email, 'portal', url, 'x-bot-token');
const trace: Trace = { requests: { 'auth.vendor.test': { 200: 1 } }, blocked: [], seconds: 20 };
function oldLogin() {
  saveLogin(email, { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-01-01T00:00:00Z', offers: [{ id: 'web:portal', name: 'portal' }] }, JSON.stringify({ cookies: [{ domain: 'vendor.review.test', value: 'original' }], origins: [] }));
  seal(email, 'web:portal.header', 'original-token');
}

for (const saving of [false, true]) test(`clearing a header prevents an open sign-in from restoring its token${saving ? ' during Save' : ''}`, async t => {
  await portal();
  oldLogin();
  const id = await startSignIn(email, 'portal', '');
  const pending = saving ? pause(t, `DELETE /sessions/${id}`) : undefined;
  const saved = pending ? assert.rejects(endSignIn(email, id, true), { status: 409 }) : undefined;
  if (pending) await pending.seen.promise;
  await setSite({ email, name: 'Alice', role: 'user', groups: [] }, 'portal', { header: '' });
  assert.equal(existsSync(join(personDir(email), 'web:portal.header.sealed')), false);
  pending?.release.resolve();
  if (saved) await saved;
  else await assert.rejects(endSignIn(email, id, true), { status: 409 });
  assert.equal(existsSync(join(personDir(email), 'web:portal.header.sealed')), false);
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, 'original');
});

for (const path of ['/api/v1/chat/completions', '/search']) test(`sign-out during ${path} prevents further assessment disclosures`, { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  process.env.EXA_API_KEY = 'exa-key';
  search = true;
  const pending = pause(t, `POST ${path}`), checking = assert.rejects(checkWebsite(email, 'portal', trace), { status: 409 });
  await pending.seen.promise;
  signOut(email, 'web:portal');
  pending.release.resolve();
  await checking;
  assert.equal(exaCalls, path === '/search' ? 1 : 0);
  assert.equal(models.length, 1);
});

test('a delayed model answer cannot give a replacement website an owner-approvable profile', { timeout: 5000 }, async t => {
  await portal();
  const pending = pause(t, 'POST /api/v1/chat/completions');
  const checking = assert.rejects(checkWebsite(email, 'portal', trace), { status: 409 });
  await pending.seen.promise;
  removeSite(email, 'portal');
  await addSite(email, 'portal', 'https://general.review.test/');
  const replacement = websitesOf(email).portal;
  pending.release.resolve();
  await checking;
  assert.deepEqual(websitesOf(email).portal, replacement);
  assert.equal((await checkWebsite(email, 'portal') as typeof profile).category, 'general');
  assert.equal(models.length, 2);

  const person: Me = { email, name: 'Alice', role: 'user', groups: [] }, owner: Me = { email: 'owner@company.test', name: 'Owner', role: 'user', groups: [] };
  for (const who of [person, owner]) upsertUser(who.email, { name: who.name, role: who.role });
  saveTree({ workspaces: { w: { name: 'Invoices', owners: [owner.email], members: [email] } }, series: {} });
  oldLogin();
  const { id } = await ask(person, 'portal', 'w', 'Collect invoices');
  assert.equal(visible(owner)[0].adminOnly, true);
  assert.throws(() => decide(owner, id, true, ''), { status: 403 });
});

test('removal invalidates a pending model check even when URL and added timestamp are reused', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await portal();
  const original = websitesOf(email).portal, pending = pause(t, 'POST /api/v1/chat/completions');
  const checking = assert.rejects(checkWebsite(email, 'portal', trace), { status: 409 });
  await pending.seen.promise;
  removeSite(email, 'portal');
  await portal();
  assert.equal(websitesOf(email).portal.added, original.added);
  const replacement = websitesOf(email).portal;
  pending.release.resolve();
  await checking;
  assert.deepEqual(websitesOf(email).portal, replacement);
});

test('a pending rule request cannot add old host decisions to a recreated website at the same URL', { timeout: 5000 }, async t => {
  await portal();
  const pending = pause(t, 'GET /blocked');
  const checking = assert.rejects(checkWebsite(email, 'portal', trace), { status: 409 });
  await pending.seen.promise;
  removeSite(email, 'portal');
  await portal();
  const replacement = websitesOf(email).portal;
  pending.release.resolve();
  await checking;
  assert.deepEqual(websitesOf(email).portal, replacement);
  assert.equal(models.length, 0);
});

test('a delayed assessment cannot overwrite a newer saved login or its sealed header', { timeout: 5000 }, async t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  await portal();
  const first = await startSignIn(email, 'portal', 'first-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, first, true);
  await pending.seen.promise;
  const checking = assert.rejects(checkWebsite(email, 'portal'), { status: 409 });
  const second = await startSignIn(email, 'portal', 'second-token');
  await endSignIn(email, second, true);
  await checkWebsite(email, 'portal');
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, second);
  assert.equal(secret(email, 'web:portal.header'), 'second-token');
  pending.release.resolve();
  await checking;
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, second);
  assert.equal(secret(email, 'web:portal.header'), 'second-token');
  assert.deepEqual(lines.map(l => JSON.parse(l.slice('sign-in ended '.length))).map(s => [s.id, s.saved]), [[first, true], [second, true]]);
  for (const file of [join(personDir(email), 'websites.json'), join(personDir(email), 'logins.json'), join(rfDir(), 'log.jsonl')]) assert.doesNotMatch(readFileSync(file, 'utf8'), /first-token|second-token|not-evidence/);
});

test('a delayed assessment cannot resurrect a signed-out login or sealed header', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const id = await startSignIn(email, 'portal', 'replacement-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, id, true);
  await pending.seen.promise;
  const checking = assert.rejects(checkWebsite(email, 'portal'), { status: 409 });
  signOut(email, 'web:portal');
  assert.equal(isCheckingWebsite(email, 'portal'), false);
  pending.release.resolve();
  await checking;
  assert.deepEqual(logins(email), []);
  for (const name of ['web:portal.sealed', 'web:portal.header.sealed']) assert.equal(existsSync(join(personDir(email), name)), false);
});

test('starting then canceling a newer sign-in invalidates the older background assessment', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const first = await startSignIn(email, 'portal', 'first-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, first, true);
  await pending.seen.promise;
  const checking = assert.rejects(checkWebsite(email, 'portal'), { status: 409 });
  const second = await startSignIn(email, 'portal', 'second-token');
  await endSignIn(email, second, false);
  pending.release.resolve();
  await checking;
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, first);
  assert.equal(secret(email, 'web:portal.header'), 'first-token');
});

for (const hadProfile of [false, true]) test(`two grant asks join the saved login assessment with ${hadProfile ? 'an older good' : 'no'} profile`, { timeout: 5000 }, async t => {
  await portal();
  if (hadProfile) {
    changeWebsite(email, 'portal', { profile });
    extraHosts = ['new.vendor.test'];
    modelProfile = { ...profile, risk: 'high' };
  }
  const me: Me = { email, name: 'Alice', role: 'user', groups: [] };
  upsertUser(email, { name: me.name, role: me.role });
  saveTree({ workspaces: { one: { name: 'One', owners: [email], members: [] }, two: { name: 'Two', owners: [email], members: [] } }, series: {} });
  const pending = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, await startSignIn(email, 'portal', 'fake-token'), true);
  await pending.seen.promise;
  const one = ask(me, 'portal', 'one', 'Read invoices'), two = ask(me, 'portal', 'two', 'Read invoices');
  assert.equal(visible(me).length, 0);
  assert.equal(models.length, 1);
  pending.release.resolve();
  assert.deepEqual((await Promise.all([one, two])).map(r => r.state), hadProfile ? ['pending', 'pending'] : ['approved', 'approved']);
  if (hadProfile) assert.equal(visible(me).every(g => g.adminOnly), true);
  assert.equal(models.length, 1);
});

test('a superseded assessment finalizer cannot clear the newer Checking status', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await portal();
  const first = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, await startSignIn(email, 'portal', 'first-token'), true);
  await first.seen.promise;
  const stale = assert.rejects(checkWebsite(email, 'portal'), { status: 409 });
  const next = await startSignIn(email, 'portal', 'second-token'), second = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, next, true);
  await second.seen.promise;
  assert.equal(isCheckingWebsite(email, 'portal'), true);
  first.release.resolve();
  await stale;
  assert.equal(isCheckingWebsite(email, 'portal'), true);
  const current = checkWebsite(email, 'portal');
  second.release.resolve();
  await current;
  assert.equal(isCheckingWebsite(email, 'portal'), false);
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, next);
});

test('different evidence waits for the active assessment then checks its own undecided dependencies', { timeout: 5000 }, async t => {
  await portal();
  const pending = pause(t, 'POST /api/v1/chat/completions'), first = checkWebsite(email, 'portal', trace);
  await pending.seen.promise;
  const second = checkWebsite(email, 'portal', { ...trace, requests: { 'other.vendor.test': { 200: 1 } } });
  let drained = false;
  const draining = drainWebsiteChecks(2000).then(() => { drained = true; }), next = pause(t, 'POST /api/v1/chat/completions');
  pending.release.resolve();
  await next.seen.promise;
  await new Promise(ok => setImmediate(ok));
  assert.equal(drained, false, 'shutdown still tracks queued evidence after the first assessment finishes');
  next.release.resolve();
  await Promise.all([first, second, draining]);
  assert.equal(models.length, 2);
  assert.equal(websitesOf(email).portal.checks!['other.vendor.test'].verdict, 'pass');
});

test('queued evidence cannot start a fresh assessment after sign-out invalidates its generation', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const pending = pause(t, 'POST /api/v1/chat/completions'), first = checkWebsite(email, 'portal', trace);
  await pending.seen.promise;
  const second = assert.rejects(checkWebsite(email, 'portal', { ...trace, requests: { 'later.vendor.test': { 200: 1 } } }), { status: 409 });
  const signout = () => signOut(email, 'web:portal');
  changes.once('change', signout);
  t.after(() => changes.off('change', signout));
  pending.release.resolve();
  await Promise.all([first, second]);
  assert.equal(models.length, 1);
  assert.equal(websitesOf(email).portal.checks!['later.vendor.test'], undefined);
});

test('Checking is memory-only and shutdown drains assessments only within its deadline', { timeout: 5000 }, async t => {
  await portal();
  const pending = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, await startSignIn(email, 'portal', 'fake-token'), true);
  await pending.seen.promise;
  assert.equal(isCheckingWebsite(email, 'portal'), true);
  assert.doesNotMatch(readFileSync(join(personDir(email), 'websites.json'), 'utf8'), /checking/);
  const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { initSystem } from './src/system.ts';
    import { isCheckingWebsite, websitesOf } from './src/browsers.ts';
    initSystem(${JSON.stringify(join(rfDir(), '..'))});
    console.log(JSON.stringify({ checking: isCheckingWebsite(${JSON.stringify(email)}, 'portal'), profile: websitesOf(${JSON.stringify(email)}).portal.profile ?? null }));
  `], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 3000 });
  assert.deepEqual(JSON.parse(restarted), { checking: false, profile: null });
  await drainWebsiteChecks(0);
  assert.equal(isCheckingWebsite(email, 'portal'), true);
  let drained = false;
  const draining = drainWebsiteChecks(1000).then(() => { drained = true; });
  await new Promise(ok => setImmediate(ok));
  assert.equal(drained, false);
  pending.release.resolve();
  await draining;
  assert.equal(isCheckingWebsite(email, 'portal'), false);
});

test('canceling while the live log is pending prevents the same sign-in from saving', { timeout: 5000 }, async t => {
  await portal();
  const id = await startSignIn(email, 'portal', 'canceled-token'), pending = pause(t, `GET /sessions/${id}/log`);
  const saving = assert.rejects(endSignIn(email, id, true), { status: 409 });
  await pending.seen.promise;
  await endSignIn(email, id, false);
  pending.release.resolve();
  await saving;
  assert.deepEqual(logins(email), []);
  assert.equal(existsSync(join(personDir(email), 'web:portal.header.sealed')), false);
  assert.equal(models.length, 0);
});

test('a newer sign-in cancels a pending live-log save without invalidating itself', { timeout: 5000 }, async t => {
  await portal();
  const first = await startSignIn(email, 'portal', 'first-token'), pending = pause(t, `GET /sessions/${first}/log`);
  const saving = assert.rejects(endSignIn(email, first, true), { status: 409 });
  await pending.seen.promise;
  const second = await startSignIn(email, 'portal', 'second-token');
  await endSignIn(email, second, true);
  pending.release.resolve();
  await saving;
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, second);
  assert.equal(secret(email, 'web:portal.header'), 'second-token');
});

test('an older browser opening cannot become current after a newer sign-in saves', { timeout: 5000 }, async t => {
  await portal();
  const pending = pause(t, 'POST /sessions');
  const opening = assert.rejects(startSignIn(email, 'portal', 'first-token'), { status: 409 });
  await pending.seen.promise;
  const second = await startSignIn(email, 'portal', 'second-token');
  await endSignIn(email, second, true);
  pending.release.resolve();
  await opening;
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, second);
  assert.equal(secret(email, 'web:portal.header'), 'second-token');
});

test('replacing a website during close prevents its old sign-in evidence from checking the replacement', { timeout: 5000 }, async t => {
  await portal();
  const id = await startSignIn(email, 'portal', 'old-token'), pending = pause(t, `DELETE /sessions/${id}`);
  const saving = assert.rejects(endSignIn(email, id, true), { status: 409 });
  await pending.seen.promise;
  removeSite(email, 'portal');
  await addSite(email, 'portal', 'https://general.review.test/');
  const replacement = websitesOf(email).portal;
  pending.release.resolve();
  await saving;
  assert.deepEqual(websitesOf(email).portal, replacement);
  assert.deepEqual(logins(email), []);
  assert.equal(existsSync(join(personDir(email), 'web:portal.header.sealed')), false);
  assert.equal(models.length, 0);
});

test('removing and recreating a website during its background check discards the old assessment', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const id = await startSignIn(email, 'portal', 'old-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  await endSignIn(email, id, true);
  await pending.seen.promise;
  const checking = assert.rejects(checkWebsite(email, 'portal'), { status: 409 });
  removeSite(email, 'portal');
  await portal();
  const replacement = websitesOf(email).portal;
  pending.release.resolve();
  await checking;
  assert.deepEqual(websitesOf(email).portal, replacement);
  assert.deepEqual(logins(email), []);
  assert.equal(existsSync(join(personDir(email), 'web:portal.header.sealed')), false);
});

test('concurrent Keep blocked during setSite internal approval is not overwritten and keeps refused hosts blocked', async () => {
  await portal();
  const admin: Me = { email: 'admin@company.test', name: 'Admin', role: 'admin', groups: [] };
  changeWebsite(email, 'portal', { checks: {
    'files.example.net': { verdict: 'high', why: 'File sharing.' },
    '10.9.8.7': { verdict: 'internal', why: 'It is at an internal address.' },
    '10.9.8.8': { verdict: 'internal', why: 'It is at an internal address.' },
  } });
  // Simulate another admin clicking Keep blocked on a high-risk host and one internal host while setSite finishes DNS checks.
  const refs: Promise<void>[] = [];
  await setSite(admin, 'portal', { internal: true }, email, () => {
    refs.push(refuseHost(admin, 'portal', 'files.example.net', email));
    refs.push(refuseHost(admin, 'portal', '10.9.8.8', email));
  });
  await Promise.all(refs);
  const after = websitesOf(email).portal;
  assert.deepEqual(after.checks?.['files.example.net'], { verdict: 'refused', why: 'An admin kept it blocked.' }, 'high-risk refusal survives concurrent internal approval');
  assert.deepEqual(after.checks?.['10.9.8.8'], { verdict: 'refused', why: 'An admin kept it blocked.' }, 'concurrently refused internal host stays refused');
  assert.equal(after.checks?.['10.9.8.7']?.verdict, 'pass', 'uncontested internal host is still approved');
  assert.equal(Boolean(letIn()['10.9.8.7']), true);
  assert.equal(Boolean(letIn()['10.9.8.8']), false, 'concurrently refused internal host is not enrolled in internal.json');
});

test('concurrent route change or website replacement rejects pending internal, allow, and keep-blocked updates', async t => {
  const admin: Me = { email: 'admin@company.test', name: 'Admin', role: 'admin', groups: [] };
  const owner: Me = { email, name: 'Alice', role: 'user', groups: [] };
  const prevTunnel = process.env.RF_TUNNEL_URL;
  process.env.RF_TUNNEL_URL = base;
  t.after(() => { if (prevTunnel === undefined) delete process.env.RF_TUNNEL_URL; else process.env.RF_TUNNEL_URL = prevTunnel; });
  writeJson('vpns.json', { corp: { type: 'fortinet', gateway: 'vpn.company.test:443' } });
  writeJson('capabilities.json', { vpn: [email] });
  await addSite(email, 'intra', 'https://10.9.8.7/');
  // Route switches to VPN during setSite internal approval: must fail 409 and never enroll 10.9.8.7 in global internal.json
  const reroutes: Promise<void>[] = [];
  await assert.rejects(setSite(admin, 'intra', { internal: true }, email, () => {
    reroutes.push(setSite(owner, 'intra', { via: 'corp' }, email));
  }), { status: 409 });
  await Promise.all(reroutes);
  assert.equal(Boolean(letIn()['10.9.8.7']), false, 'switched-to-VPN website must not enroll its host in global internal.json');

  const replaceSite = (newUrl: string) => {
    removeSite(email, 'portal');
    writeFileSync(join(personDir(email), 'websites.json'), JSON.stringify({ portal: { url: newUrl, hosts: [], writeback: true, added: new Date(Date.now() + 1000).toISOString() } }));
  };
  // Website removed and recreated during allowHost and refuseHost: replacement must not inherit decisions meant for the original
  await portal();
  await assert.rejects(allowHost(admin, 'portal', 'files.example.net', email, () => replaceSite('https://other.review.test/')), { status: 409 });
  assert.deepEqual(websitesOf(email).portal.hosts, []);
  assert.equal(websitesOf(email).portal.checks?.['files.example.net'], undefined);

  await assert.rejects(refuseHost(admin, 'portal', 'files.example.net', email, () => replaceSite('https://third.review.test/')), { status: 409 });
  assert.equal(websitesOf(email).portal.checks?.['files.example.net'], undefined);

  // Stale siteRev captured before a site replacement rejects Allow (even for internal host) and Keep blocked with 409
  const staleRev = siteRevision(email, 'portal', websitesOf(email).portal, '10.9.8.9');
  replaceSite('https://fourth.review.test/');
  await assert.rejects(allowHost(admin, 'portal', '10.9.8.9', email, undefined, staleRev), { status: 409 });
  assert.equal(Boolean(letIn()['10.9.8.9']), false, 'stale Allow must not enroll internal host in global internal.json');
  await assert.rejects(refuseHost(admin, 'portal', 'files.example.net', email, undefined, staleRev), { status: 409 });
  assert.equal(websitesOf(email).portal.checks?.['files.example.net'], undefined);

  // Two admins race on the same Waiting item: Keep blocked wins, stale Waiting Allow with same siteRev fails 409
  changeWebsite(email, 'portal', { checks: { '10.9.8.10': { verdict: 'internal', why: 'It is at an internal address.' } } });
  const waitingRev = siteRevision(email, 'portal', websitesOf(email).portal, '10.9.8.10');
  await assert.rejects(allowHost(admin, 'portal', '10.9.8.10', email, () => {
    void refuseHost(admin, 'portal', '10.9.8.10', email, undefined, waitingRev);
  }, waitingRev), { status: 409 });
  assert.deepEqual(websitesOf(email).portal.checks?.['10.9.8.10'], { verdict: 'refused', why: 'An admin kept it blocked.' });
  assert.equal(Boolean(letIn()['10.9.8.10']), false, 'stale Waiting Allow must not undo Keep blocked or enroll internal host');

  // If a host becomes covered by a wildcard while Waiting is open, a stale Waiting Allow must fail 409 without global enrollment
  changeWebsite(email, 'portal', { checks: { ...websitesOf(email).portal.checks, 'sub.internal.test': { verdict: 'internal', why: 'It is at an internal address.' } } });
  const wildRev = siteRevision(email, 'portal', websitesOf(email).portal, 'sub.internal.test');
  changeWebsite(email, 'portal', { hosts: [...websitesOf(email).portal.hosts, '*.internal.test'] });
  await assert.rejects(allowHost(admin, 'portal', 'sub.internal.test', email, undefined, wildRev), { status: 409 });
  assert.equal(Boolean(letIn()['sub.internal.test']), false, 'stale Waiting Allow for a wildcard-covered host must not enroll it');

  // ABA: Allow -> Revoke internal host increments per-host rev on all sites with that internal or high check so no stale Waiting Allow can restore global access
  await addSite(email, 'portal2', 'https://other.review.test/');
  await addSite(email, 'portal3', 'https://third-site.review.test/');
  changeWebsite(email, 'portal', { checks: { ...websitesOf(email).portal.checks, '10.9.8.12': { verdict: 'internal', why: 'It is at an internal address.' } } });
  changeWebsite(email, 'portal2', { checks: { '10.9.8.12': { verdict: 'internal', why: 'It is at an internal address.' } } });
  changeWebsite(email, 'portal3', { checks: { '10.9.8.12': { verdict: 'high', why: 'Previously rated high.' } } });
  const abaRev = siteRevision(email, 'portal', websitesOf(email).portal, '10.9.8.12');
  const abaRev2 = siteRevision(email, 'portal2', websitesOf(email).portal2, '10.9.8.12');
  const abaRev3 = siteRevision(email, 'portal3', websitesOf(email).portal3, '10.9.8.12');
  await allowHost(admin, 'portal', '10.9.8.12', email, undefined, abaRev);
  assert.equal(Boolean(letIn()['10.9.8.12']), true);
  setLetIn(['10.9.8.12'], admin.email, false);
  await revokeInternalHosts(['10.9.8.12']);
  assert.equal(websitesOf(email).portal.checks?.['10.9.8.12']?.verdict, 'internal');
  await assert.rejects(allowHost(admin, 'portal', '10.9.8.12', email, undefined, abaRev), { status: 409 });
  await assert.rejects(allowHost(admin, 'portal2', '10.9.8.12', email, undefined, abaRev2), { status: 409 });
  await assert.rejects(allowHost(admin, 'portal3', '10.9.8.12', email, undefined, abaRev3), { status: 409 });
  assert.equal(Boolean(letIn()['10.9.8.12']), false, 'stale Waiting Allow on a second website (internal or high) after global revocation must not restore internal access');

  // In-flight setSite --internal true cannot undo a concurrent global revocation of one of its hosts
  await allowHost(admin, 'portal', '10.9.8.15', email);
  assert.equal(Boolean(letIn()['10.9.8.15']), true);
  const revokes: Promise<void>[] = [];
  await setSite(admin, 'portal', { internal: true }, email, () => {
    setLetIn(['10.9.8.15'], admin.email, false);
    revokes.push(revokeInternalHosts(['10.9.8.15']));
  });
  await Promise.all(revokes);
  assert.equal(Boolean(letIn()['10.9.8.15']), false, 'in-flight setSite internal approval must not re-enroll a host revoked during DNS lookup');
  assert.equal(websitesOf(email).portal.checks?.['10.9.8.15']?.verdict, 'internal');

  // Internal revocation during in-flight startSignIn POST /sessions closes the session and rejects sign-in
  await addSite(email, 'intrasign', 'https://10.9.8.13/');
  setLetIn(['10.9.8.13'], admin.email, true);
  const opening = pause(t, 'POST /sessions');
  const starting = assert.rejects(startSignIn(email, 'intrasign', ''), { status: 409 });
  await opening.seen.promise;
  setLetIn(['10.9.8.13'], admin.email, false);
  await revokeInternalHosts(['10.9.8.13']);
  opening.release.resolve();
  await starting;

  // Concurrent addSite for the same name must not let the second overwrite the first
  const [r1, r2] = await Promise.allSettled([addSite(email, 'dup', 'https://first.review.test/'), addSite(email, 'dup', 'https://second.review.test/')]);
  assert.deepEqual([r1.status, r2.status].sort(), ['fulfilled', 'rejected']);
  assert.equal((r1.status === 'rejected' ? r1.reason : (r2 as PromiseRejectedResult).reason).status, 409);
  assert.equal(websitesOf(email).dup.url, 'https://first.review.test/');
});
