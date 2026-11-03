import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';

// A run's browsers, from a stand-in browser service whose page changes only when the test says.
let page = Buffer.from('page 1');
const service = createServer((req, res) => {
  if (req.method === 'DELETE') return res.writeHead(200).end(JSON.stringify({ state: { cookies: [] }, log: [{ method: 'GET' }] }));
  if (req.method === 'POST') return res.writeHead(201).end(JSON.stringify({ id: 'b9' }));
  res.writeHead(req.url === '/sessions/b1/screenshot' ? 200 : 404).end(page);
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
process.env.RF_BROWSER_URL = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
const { Browsers } = await import('../src/browsers.ts');
const { logins, saveLogin, secret } = await import('../src/logins.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-shots-'));
initSystem(tmp);
openStore(tmp);
saveTree({ workspaces: { w: { name: 'Acme', owners: ['alice@demo.test'], members: [] } }, series: { s: { name: 'Portal pull', workspace: 'w' } } });
mkdirSync(join(tmp, 'series', 's'), { recursive: true });
writeJson('users.json', { 'alice@demo.test': { role: 'admin' } });

after(() => {
  service.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("after each tool call, each of the run's browsers is shot unless its page looks the same, kept read-only and logged", async () => {
  const inst = createInstance('s', '2026-11', 'alice@demo.test', []), browsers = new Browsers(inst, 2);
  browsers.bySite.set('erp', { id: 'b1', email: 'alice@demo.test', since: '' });
  await browsers.shoot();
  await browsers.shoot();
  page = Buffer.from('page 2');
  await browsers.shoot();
  const shots = inst.log.filter(e => e.op === 'shot');
  assert.deepEqual(shots.map(e => [e.by, e.run, e.site, e.file]), [['server', 2, 'erp', 'browser/run 2 erp 1.png'], ['server', 2, 'erp', 'browser/run 2 erp 2.png']]);
  assert.equal(readFileSync(join(inst.dir, 'browser/run 2 erp 2.png'), 'utf8'), 'page 2');
  assert.equal(statSync(join(inst.dir, 'browser/run 2 erp 1.png')).mode & 0o222, 0, 'the agent reads it but cannot change it');
});

test("the agent says a website signed it out: its runner's login is marked expired and its browser closes, keeping its request log", async () => {
  const alice = 'alice@demo.test', erp = { id: 'web:erp', kind: 'website' as const, name: 'ERP', since: '', offers: [{ id: 'web:erp', name: 'ERP' }] };
  saveLogin(alice, erp, '{}');
  const inst = createInstance('s', '2026-12', alice, ['web:erp']), browsers = new Browsers(inst, 1);
  browsers.bySite.set('erp', { id: 'b1', email: alice, since: '' });
  await assert.rejects(browsers.expire('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp');
  assert.equal(logins(alice).find(l => l.id === 'web:erp')!.expired, true);
  assert.equal(browsers.bySite.size, 0);
  assert.deepEqual(inst.log.filter(e => e.op === 'browser').map(e => [e.site, e.requests]), [['erp', 1]]);
  await assert.rejects(browsers.browser('erp'), (e: { status: number; login: string }) => e.status === 409 && e.login === 'web:erp', 'no browser opens in it until they sign in again');
});

test('an answer of the browser service that is no JSON, as a proxy in front of it may give, fails that call alone', async () => {
  const inst = createInstance('s', '2027-01', 'alice@demo.test', []), browsers = new Browsers(inst, 3);
  browsers.bySite.set('erp', { id: 'gone', email: 'alice@demo.test', since: '' });
  await assert.rejects(browsers.shoot(), (e: { status: number; message: string }) => e.status === 502 && e.message.startsWith('browser service: 404 page'));
});

test("closing a run's browser hands its login back refreshed, unless its person signed in to it anew since it opened", async () => {
  const alice = 'alice@demo.test', crm = (since: string) => ({ id: 'web:crm', kind: 'website' as const, name: 'CRM', since, offers: [{ id: 'web:crm', name: 'CRM' }] });
  writeJson('connections.json', { crm: { type: 'website', title: 'CRM', url: 'https://crm.example.com', hosts: [], writeback: true, updated_by: alice, updated_at: '' } });
  saveLogin(alice, crm('t1'), '{"cookies":["old"]}');
  const browsers = new Browsers(createInstance('s', '2027-02', alice, ['web:crm']), 1);
  await browsers.browser('crm');
  await browsers.close();
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: [] }, 'refreshed from the browser');
  await browsers.browser('crm');
  saveLogin(alice, crm('t2'), '{"cookies":["fresh"]}');
  await browsers.close();
  assert.deepEqual(JSON.parse(secret(alice, 'web:crm')), { cookies: ['fresh'] }, 'the sign-in since the browser opened stays');
});
