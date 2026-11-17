import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSystem, rfDir, saveTree, writeJson } from '../src/system.ts';
import { createInstance, openStore, seriesDir } from '../src/store.ts';
import { authority } from '../src/logins.ts';
import { saveSeriesSettings } from '../src/series.ts';

const email = 'alice@synthetic.test', bob = 'bob@synthetic.test';
const me = { email, name: 'Alice', role: 'user' as const, groups: [] };
const profile = { what: 'Vendor portal', category: 'vendor', risk: 'low', flags: [] };
const outbound: string[] = [], lookups: string[] = [];
let gate: { path: string; seen: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
const service = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://localhost');
  const raw = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString(), body = raw ? JSON.parse(raw) : undefined;
  if (['/blocked', '/api/v1/chat/completions', '/search'].includes(u.pathname)) outbound.push(u.pathname);
  if (`${req.method} ${u.pathname}` === gate?.path) {
    gate.seen.resolve();
    await gate.release.promise;
  }
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/sessions' && req.method === 'POST') return void res.end('{"id":"browser"}');
  if (u.pathname === '/sessions' && req.method === 'GET') return void res.end('[{"id":"browser"}]');
  if (req.method === 'DELETE') return void res.end(JSON.stringify({ state: { cookies: [{ domain: 'vendor.review.test', value: 'refreshed' }], origins: [] }, log: [
    { method: 'GET', url: 'https://vendor.review.test/private?token=secret', status: 200 },
    { method: 'GET', url: 'https://cdn.external.test/asset', status: 403, blocked: 'host not on the list' },
  ] }));
  if (u.pathname === '/blocked') return void res.end(JSON.stringify(Object.fromEntries(u.searchParams.getAll('host').map(h => [h, false]))));
  if (u.pathname === '/search') return void res.end(JSON.stringify({ results: [], costDollars: { total: 0.005 } }));
  if (u.pathname === '/api/v1/chat/completions') {
    const content = JSON.parse(body.messages[1].content);
    const message = body.messages.some((m: any) => m.role === 'tool')
      ? { content: JSON.stringify({ profile, hosts: Object.fromEntries(content.unchecked.map((h: string) => [h, { verdict: 'pass', why: 'Required dependency.' }])) }) }
      : { content: null, tool_calls: [{ id: 'search1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'external vendor dependency' }) } }] };
    return void res.end(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
  }
  res.writeHead(404).end('{}');
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_TUNNEL_URL: base, RF_BROWSER_KEY: 'fake-browser', RF_PUBLIC_URL: 'https://rf.synthetic.test', OPENROUTER_API_KEY: 'fake-model', EXA_API_KEY: 'fake-search' });
const { Browsers, addSite, drainWebsiteChecks, isCheckingWebsite, reap, removeSite, setSite, websitesOf } = await import('../src/browsers.ts');
const { saveLogin, secret, signOut } = await import('../src/logins.ts');
const { upstreams } = await import('../src/connections.ts');
const { revoke } = await import('../src/grants.ts');
upstreams['openrouter.ai'] = base;
upstreams['api.exa.ai'] = base;
after(() => new Promise<void>(ok => service.close(() => ok())));
beforeEach(t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-browser-source-'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Work', owners: [email], members: [bob] }, other: { name: 'Other', owners: [email], members: [] } }, series: { s: { name: 'Series', workspace: 'w' } } });
  writeJson('users.json', { [email]: { role: 'user' }, [bob]: { role: 'user' } });
  writeJson('capabilities.json', { vpn: [email], 'series-owner': [email, bob] });
  writeJson('vpns.json', { corp: { type: 'fortinet', gateway: 'vpn.synthetic.test:443' } });
  writeJson('connections.json', {});
  writeJson('internal.json', {});
  mkdirSync(join(root, 'series/s'), { recursive: true });
  outbound.length = lookups.length = 0;
  t.mock.method(dns, 'lookup', async (host: string) => { lookups.push(host); return [{ address: '203.0.113.10', family: 4 }]; });
  syncBuiltinESMExports();
  gate = undefined;
  t.after(async () => {
    gate?.release.resolve();
    await drainWebsiteChecks(2000);
    rmSync(root, { recursive: true, force: true });
  });
});
async function running(writeback = true) {
  await addSite(email, 'portal', 'https://vendor.review.test/');
  await setSite(me, 'portal', { writeback });
  saveLogin(email, { id: 'web:portal', kind: 'website', name: 'portal', since: 'original-login', offers: [{ id: 'web:portal', name: 'portal' }] }, JSON.stringify({ cookies: [], origins: [] }));
  writeJson('grants.json', { approved: { workspace: 'w', person: email, site: 'portal', reason: 'work', at: '', state: 'approved' }, pending: { workspace: 'other', person: email, site: 'portal', reason: 'work', at: '', state: 'pending' } });
  saveSeriesSettings(seriesDir('s'), { version: 1, owner: email, epoch: 1, since: '', consent: { by: email, at: '', workspace: 'w', logins: ['web:portal'], autonomous: false } });
  const inst = createInstance('s', 'instance', email);
  inst.append('server', 'run', { run: 1, runner: email, initiator: email, authority: authority(inst) });
  const browsers = new Browsers(inst, 1);
  await browsers.browser('portal');
  return { inst, browsers };
}
const invalidations = ['signout', 'assignment', 'assignment ABA', 'consent', 'grant', 'route', 'route ABA', 'replacement', 'same-identity replacement'] as const;
async function invalidate(kind: typeof invalidations[number], inst: ReturnType<typeof createInstance>) {
  switch (kind) {
    case 'signout': signOut(email, 'web:portal'); break;
    case 'assignment': saveSeriesSettings(inst.series(), { version: 1, owner: bob, epoch: 2, since: '' }); break;
    case 'assignment ABA':
      saveSeriesSettings(inst.series(), { version: 1, owner: bob, epoch: 2, since: '' });
      saveSeriesSettings(inst.series(), { version: 1, owner: email, epoch: 3, since: '', consent: { by: email, at: '', workspace: 'w', logins: ['web:portal'], autonomous: false } });
      break;
    case 'consent': saveSeriesSettings(inst.series(), { version: 1, owner: email, epoch: 2, since: '' }); break;
    case 'grant': revoke(me, 'approved'); break;
    case 'route': await setSite(me, 'portal', { via: 'corp' }); break;
    case 'route ABA':
      await setSite(me, 'portal', { via: 'corp' });
      await setSite(me, 'portal', { via: '' });
      break;
    case 'replacement':
    case 'same-identity replacement':
      removeSite(email, 'portal');
      await addSite(email, 'portal', kind === 'replacement' ? 'https://general.fileshare.test/' : 'https://vendor.review.test/');
      break;
  }
}
for (const path of ['DELETE /sessions/browser', 'GET /blocked', 'POST /api/v1/chat/completions', 'POST /search']) {
  for (const kind of invalidations) test(`${kind} during ${path} fences browser-close assessment`, { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { inst, browsers } = await running();
    gate = { path, seen: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const closing = browsers.end();
    t.after(async () => { gate?.release.resolve(); await closing; await drainWebsiteChecks(2000); });
    await gate.seen.promise;
    await invalidate(kind, inst);
    const before = websitesOf(email), sent = [...outbound], resolved = [...lookups], checking = isCheckingWebsite(email, 'portal');
    gate.release.resolve();
    await closing;
    await drainWebsiteChecks(2000);
    assert.equal(checking, false);
    assert.deepEqual(outbound, sent, 'no new rule, model or search calls after invalidation');
    assert.deepEqual(lookups, resolved, 'no new DNS disclosures after invalidation');
    assert.deepEqual(websitesOf(email), before, 'no stale profile or verdict publication');
    assert.equal(inst.log.some(e => e.op === 'browser' && e.action === 'allowed'), false);
    assert.equal(inst.log.filter(e => e.op === 'browser' && e.file).length, 1, 'close accounting survives');
    if (path.startsWith('POST ')) {
      const costs = readFileSync(join(rfDir(), 'costs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(costs.length, path === 'POST /search' ? 2 : 1, 'already-issued calls remain accounted');
    }
  });
}
for (const writeback of [true, false]) test(`valid retired browser assesses its profile (writeback=${writeback})`, { timeout: 5000 }, async () => {
  const { inst, browsers } = await running(writeback);
  inst.append('server', 'done', { run: 1, cost: 0 });
  await browsers.end();
  await drainWebsiteChecks(2000);
  assert.deepEqual(websitesOf(email).portal.profile, profile);
  assert.equal(websitesOf(email).portal.checks?.['cdn.external.test'].verdict, 'pass');
  assert.equal(inst.log.some(e => e.op === 'browser' && e.action === 'allowed'), true);
  assert.deepEqual(outbound, ['/blocked', '/api/v1/chat/completions', '/search', '/api/v1/chat/completions']);
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies.length, writeback ? 1 : 0);
});
test('restart records without captured assessment context only keep cleanup and accounting', { timeout: 5000 }, async () => {
  const { inst, browsers } = await running();
  clearTimeout(browsers.bySite.get('portal')!.idle);
  browsers.bySite.clear();
  await (await reap()).closed;
  await drainWebsiteChecks(2000);
  assert.deepEqual(outbound, []);
  assert.equal(inst.log.filter(e => e.op === 'browser' && e.file).length, 1);
  assert.equal(websitesOf(email).portal.profile, undefined);
});
