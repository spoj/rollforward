import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { logins, personDir, saveLogin, secret } from '../src/logins.ts';

const email = 'alice@synthetic.test', me = { email, name: 'Alice', role: 'user' as const, groups: [] };
let gate: { path: string; seen: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined, password = false;
const outbound: string[] = [], sessions = new Map<string, string>();
const service = createServer(async (req, res) => {
  const path = `${req.method} ${req.url}`;
  outbound.push(path);
  const raw = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString(), body = raw ? JSON.parse(raw) : undefined;
  if (gate?.path === path) { gate.seen.resolve(); await gate.release.promise; }
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST') {
    const id = new URL(body.site.start_url).hostname.split('.')[0];
    sessions.set(id, body.site.start_url);
    return void res.end(JSON.stringify({ id }));
  }
  const id = req.url!.split('/')[2];
  if (req.method === 'DELETE') return void res.end(JSON.stringify({ state: { cookies: [{ domain: new URL(sessions.get(id)!).hostname, value: 'refreshed' }], origins: [] }, log: [] }));
  res.end(JSON.stringify({ url: sessions.get(id), password }));
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_BROWSER_KEY: 'fake-browser', RF_TUNNEL_URL: base });
const { addSite, keepAlive, removeSite, setSite, websitesOf } = await import('../src/browsers.ts');
const { revoke } = await import('../src/grants.ts');
after(() => new Promise<void>(ok => service.close(() => ok())));
beforeEach(t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-keepalive-source-'));
  initSystem(root);
  saveTree({ workspaces: { w: { name: 'Work', owners: [email], members: [] }, other: { name: 'Other', owners: [email], members: [] } }, series: {} });
  writeJson('users.json', { [email]: { role: 'user' } });
  writeJson('capabilities.json', { keepalive: [email], vpn: [email] });
  writeJson('vpns.json', { corp: { type: 'fortinet', gateway: 'vpn.synthetic.test:443' } });
  writeJson('connections.json', {});
  outbound.length = 0;
  sessions.clear();
  password = false;
  gate = undefined;
  t.after(() => { gate?.release.resolve(); rmSync(root, { recursive: true, force: true }); });
});
let turn = Date.now();
async function setup(queued = false) {
  const sites = queued ? ['first', 'portal'] : ['portal'];
  for (const site of sites) {
    await addSite(email, site, `https://${site}.review.test/`);
    saveLogin(email, { id: `web:${site}`, kind: 'website', name: site, since: `original-${site}`, keepalive: new Date(Date.now() + 7 * 86_400_000).toISOString(), offers: [{ id: `web:${site}`, name: site }] }, JSON.stringify({ cookies: [{ domain: `${site}.review.test`, value: 'original' }], origins: [] }));
  }
  writeJson('grants.json', Object.fromEntries(sites.flatMap(site => [
    [site, { workspace: 'w', person: email, site, at: '', reason: 'work', state: 'approved' }],
    [`pending-${site}`, { workspace: 'other', person: email, site, at: '', reason: 'work', state: 'pending' }],
  ])));
  turn += 11 * 60_000;
}
const invalidations = ['route', 'route ABA', 'grant', 'capability', 'disabled', 'replacement'] as const;
for (const phase of ['before turn', 'POST /sessions', 'GET /sessions/portal/page', 'DELETE /sessions/portal']) {
  for (const kind of invalidations) test(`${kind} ${phase} prevents stale keepalive traffic and writeback`, { timeout: 5000 }, async t => {
    await setup(phase === 'before turn');
    gate = { path: phase === 'before turn' ? 'GET /sessions/first/page' : phase, seen: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const keeping = keepAlive(new Date(turn));
    t.after(async () => { gate?.release.resolve(); await keeping; });
    await gate.seen.promise;
    switch (kind) {
      case 'route': await setSite(me, 'portal', { via: 'corp' }); break;
      case 'route ABA':
        await setSite(me, 'portal', { via: 'corp' });
        await setSite(me, 'portal', { via: '' });
        break;
      case 'grant': revoke(me, 'portal'); break;
      case 'capability': writeJson('capabilities.json', { vpn: [email] }); break;
      case 'disabled': writeJson('users.json', { [email]: { role: 'user', disabled: true } }); break;
      case 'replacement': removeSite(email, 'portal'); await addSite(email, 'portal', 'https://replacement.review.test/'); break;
    }
    const file = join(personDir(email), 'web:portal.sealed'), sealed = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const before = logins(email).find(l => l.id === 'web:portal'), sites = websitesOf(email), sent = outbound.filter(p => !p.startsWith('DELETE'));
    gate.release.resolve();
    await keeping;
    assert.deepEqual(outbound.filter(p => !p.startsWith('DELETE')), sent, 'only cleanup DELETE may follow invalidation');
    assert.deepEqual(logins(email).find(l => l.id === 'web:portal'), before, 'no stale expiry or login metadata');
    assert.deepEqual(websitesOf(email), sites);
    assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : undefined, sealed, 'sealed state unchanged');
    if (phase === 'before turn') assert.equal(sessions.has('portal'), false);
    else assert.equal(outbound.includes('DELETE /sessions/portal'), true, 'opened browser always closes');
  });
}
for (const expired of [false, true]) test(`valid keepalive ${expired ? 'marks a sign-in page expired' : 'refreshes sealed state'}`, async () => {
  await setup();
  password = expired;
  const file = join(personDir(email), 'web:portal.sealed'), before = readFileSync(file, 'utf8');
  await keepAlive(new Date(turn));
  assert.deepEqual(outbound, ['POST /sessions', 'GET /sessions/portal/page', 'DELETE /sessions/portal']);
  assert.equal(!!logins(email)[0].expired, expired);
  assert.equal(JSON.parse(secret(email, 'web:portal')).cookies[0].value, expired ? 'original' : 'refreshed');
  if (expired) assert.equal(readFileSync(file, 'utf8'), before);
  else assert.notEqual(readFileSync(file, 'utf8'), before);
});
