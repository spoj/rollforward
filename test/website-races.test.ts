import { after, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, rfDir, saveTree, writeJson } from '../src/system.ts';
import { upsertUser, type Me } from '../src/auth.ts';
import type { Trace } from '../src/logins.ts';

type Pause = { seen: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };
const pauses = new Map<string, Pause>(), sessions = new Map<string, string>(), models: any[] = [];
const email = 'alice@company.test', url = 'https://vendor.review.test/';
const profile = { what: 'A vendor accounting portal', category: 'vendor', risk: 'low', flags: [] };
let serial = 0;
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
  if (u.pathname === '/api/v1/chat/completions') {
    const evidence = JSON.parse(body.messages[1].content);
    const checked = evidence.website.address.startsWith('general.') ? { ...profile, what: 'A public file-sharing service', category: 'general', risk: 'high' } : profile;
    const hosts = Object.fromEntries(evidence.unchecked.map((h: string) => [h, { verdict: 'pass', why: 'Its role was checked.' }]));
    return void res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ profile: checked, hosts }) } }] }));
  }
  if (req.method === 'POST' && u.pathname === '/sessions') {
    const id = `b${++serial}`;
    sessions.set(id, new URL(body.site.start_url).hostname);
    return void res.writeHead(201).end(JSON.stringify({ id }));
  }
  const id = u.pathname.split('/')[2], host = sessions.get(id)!;
  const log = [{ method: 'GET', url: `https://${host}/private?code=not-evidence`, status: 200, live: true }];
  if (req.method === 'DELETE') return void res.end(JSON.stringify({ state: { cookies: [{ name: 'sid', domain: host, value: id }], origins: [] }, log }));
  if (u.pathname.endsWith('/log')) return void res.end(JSON.stringify(log));
  res.end('{}');
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_BROWSER_KEY: 'browser-key', RF_PUBLIC_URL: 'https://rf.company.test', OPENROUTER_API_KEY: 'server-key' });
delete process.env.EXA_API_KEY;
const { addSite, checkWebsite, endSignIn, removeSite, startSignIn, websitesOf } = await import('../src/browsers.ts');
const { upstreams } = await import('../src/connections.ts');
const { logins, personDir, saveLogin, seal, secret, signOut } = await import('../src/logins.ts');
const { ask, decide, visible } = await import('../src/grants.ts');
upstreams['openrouter.ai'] = base;
after(async () => { await new Promise<void>(ok => service.close(() => ok())); });
beforeEach(t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-website-races-'));
  initSystem(root);
  writeJson('connections.json', {});
  writeJson('internal.json', {});
  models.length = 0;
  delete process.env.RF_SIGNIN_S;
  t.after(() => rmSync(root, { recursive: true, force: true }));
});
function pause(t: TestContext, path: string) {
  const pending = { seen: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  pauses.set(path, pending);
  t.after(() => pending.release.resolve());
  return pending;
}
const portal = () => addSite(email, 'portal', url, 'x-bot-token');
const trace: Trace = { requests: { 'auth.vendor.test': { 200: 1 } }, blocked: [], seconds: 20 };
function oldLogin() {
  saveLogin(email, { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-01-01T00:00:00Z', offers: [{ id: 'web:portal', name: 'portal' }] }, JSON.stringify({ cookies: [{ domain: 'vendor.review.test', value: 'original' }], origins: [] }));
  seal(email, 'web:portal.header', 'original-token');
}

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

test('a delayed save cannot overwrite a newer saved login or its sealed header', { timeout: 5000 }, async t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  await portal();
  const first = await startSignIn(email, 'portal', 'first-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  const saving = assert.rejects(endSignIn(email, first, true), { status: 409 });
  await pending.seen.promise;
  const second = await startSignIn(email, 'portal', 'second-token');
  await endSignIn(email, second, true);
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, second);
  assert.equal(secret(email, 'web:portal.header'), 'second-token');
  pending.release.resolve();
  await saving;
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, second);
  assert.equal(secret(email, 'web:portal.header'), 'second-token');
  assert.deepEqual(lines.map(l => JSON.parse(l.slice('sign-in ended '.length))).map(s => [s.id, s.saved]), [[second, true], [first, false]]);
  for (const file of [join(personDir(email), 'websites.json'), join(personDir(email), 'logins.json'), join(rfDir(), 'log.jsonl')]) assert.doesNotMatch(readFileSync(file, 'utf8'), /first-token|second-token|not-evidence/);
});

test('a delayed save cannot resurrect a signed-out login or sealed header', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const id = await startSignIn(email, 'portal', 'replacement-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  const saving = assert.rejects(endSignIn(email, id, true), { status: 409 });
  await pending.seen.promise;
  signOut(email, 'web:portal');
  pending.release.resolve();
  await saving;
  assert.deepEqual(logins(email), []);
  for (const name of ['web:portal.sealed', 'web:portal.header.sealed']) assert.equal(existsSync(join(personDir(email), name)), false);
});

test('starting then canceling a newer sign-in still supersedes an older pending save', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const first = await startSignIn(email, 'portal', 'first-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  const saving = assert.rejects(endSignIn(email, first, true), { status: 409 });
  await pending.seen.promise;
  const second = await startSignIn(email, 'portal', 'second-token');
  await endSignIn(email, second, false);
  pending.release.resolve();
  await saving;
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, 'original');
  assert.equal(secret(email, 'web:portal.header'), 'original-token');
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

test('removing and recreating a website during its model check cannot save its old login', { timeout: 5000 }, async t => {
  await portal();
  oldLogin();
  const id = await startSignIn(email, 'portal', 'old-token'), pending = pause(t, 'POST /api/v1/chat/completions');
  const saving = assert.rejects(endSignIn(email, id, true), { status: 409 });
  await pending.seen.promise;
  removeSite(email, 'portal');
  await portal();
  const replacement = websitesOf(email).portal;
  pending.release.resolve();
  await saving;
  assert.deepEqual(websitesOf(email).portal, replacement);
  assert.deepEqual(logins(email), []);
  assert.equal(existsSync(join(personDir(email), 'web:portal.header.sealed')), false);
});
