import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSystem, saveTree, writeJson } from '../src/system.ts';

const email = 'alice@synthetic.test', me = { email, name: 'Alice', role: 'user' as const, groups: [] };
const profile = { what: 'Vendor portal', category: 'vendor' as const, risk: 'low' as const, flags: [] };
const oldTrace = { requests: { 'old.external.test': { 200: 1 } }, blocked: [], seconds: 1 };
const newTrace = { requests: { 'new.external.test': { 200: 1 } }, blocked: [], seconds: 1 };
let entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), calls = 0;
const service = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://local').pathname;
  const raw = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader('content-type', 'application/json');
  if (path === '/blocked') return void res.end('{}');
  assert.equal(path, '/api/v1/chat/completions');
  if (++calls === 1) { entered.resolve(); await release.promise; }
  const evidence = JSON.parse(JSON.parse(raw).messages[1].content);
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ profile,
    hosts: Object.fromEntries(evidence.unchecked.map((host: string) => [host, { verdict: 'pass', why: 'Required dependency.' }])) }) } }], usage: { cost: 0.001 } }));
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_BROWSER_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' });
delete process.env.EXA_API_KEY;
const { addSite, changeWebsite, checkWebsite, drainWebsiteChecks, websitesOf } = await import('../src/browsers.ts');
const { saveLogin, signOut } = await import('../src/logins.ts');
const { ask } = await import('../src/grants.ts');
const { upstreams } = await import('../src/connections.ts');
upstreams['openrouter.ai'] = base;
after(() => new Promise<void>(ok => service.close(() => ok())));
beforeEach(async t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-check-queue-'));
  initSystem(root);
  saveTree({ workspaces: { w: { name: 'Work', owners: [email], members: [] } }, series: {} });
  writeJson('users.json', { [email]: { role: 'user' } });
  writeJson('connections.json', {});
  writeJson('internal.json', {});
  writeJson('grants.json', {});
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.10', family: 4 }]);
  syncBuiltinESMExports();
  await addSite(email, 'portal', 'https://vendor.review.test/');
  saveLogin(email, { id: 'web:portal', kind: 'website', name: 'portal', since: 'login', offers: [{ id: 'web:portal', name: 'portal' }], trace: newTrace }, JSON.stringify({ cookies: [], origins: [] }));
  entered = Promise.withResolvers<void>(); release = Promise.withResolvers<void>(); calls = 0;
  t.after(async () => { release.resolve(); await drainWebsiteChecks(2000); rmSync(root, { recursive: true, force: true }); });
});

for (const caller of ['grant', 'run']) for (const hadProfile of [false, true]) {
  test(`a queued ${caller} with profile=${hadProfile} keeps its own source after predecessor invalidation`, { timeout: 5000 }, async () => {
    if (hadProfile) changeWebsite(email, 'portal', { profile });
    let valid = true;
    const first = checkWebsite(email, 'portal', oldTrace, () => valid);
    const rejected = assert.rejects(first, { status: 409 });
    await entered.promise;
    const next = caller === 'grant' ? ask(me, 'portal', 'w', 'Read the ledger') : checkWebsite(email, 'portal', newTrace, () => true);
    const outcome = next.then(value => ({ value, error: null }), error => ({ value: null, error }));
    valid = false;
    release.resolve();
    await rejected;
    const result = await outcome;
    assert.equal(result.error, null, 'the queued caller must not inherit its predecessor\'s revocation');
    if (caller === 'grant') assert.equal((result.value as { state: string }).state, 'approved');
    assert.equal(calls, 2);
    assert.equal(websitesOf(email).portal.checks?.['old.external.test'], undefined);
    assert.equal(websitesOf(email).portal.checks?.['new.external.test'].verdict, 'pass');
  });
}

test('website sign-out still rejects both queued sources without new outbound work', { timeout: 5000 }, async () => {
  const first = checkWebsite(email, 'portal', oldTrace, () => true);
  const rejected = assert.rejects(first, { status: 409 });
  await entered.promise;
  const next = checkWebsite(email, 'portal', newTrace, () => true);
  const nextRejected = assert.rejects(next, { status: 409 });
  signOut(email, 'web:portal');
  release.resolve();
  await Promise.all([rejected, nextRejected]);
  assert.equal(calls, 1);
  assert.equal(websitesOf(email).portal.checks?.['old.external.test'], undefined);
  assert.equal(websitesOf(email).portal.checks?.['new.external.test'], undefined);
});
