import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree } from '../src/system.ts';

const USER = 'alice@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-def-browsers-'));

let closeLog: object[] = [];
let closeState: unknown = { cookies: [], origins: [] };
let nextSessionId = 'bs1';
const openedBodies: any[] = [];
let putHostsGate: PromiseWithResolvers<void> | undefined;
let putHostsEntered: PromiseWithResolvers<void> | undefined;

const browserSvc = createServer(async (req, res) => {
  if (req.method === 'PUT' && req.url?.endsWith('/hosts')) {
    putHostsEntered?.resolve();
    await putHostsGate?.promise;
    return res.writeHead(200).end('{}');
  }
  if (req.method === 'POST' && req.url === '/sessions') {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    openedBodies.push(body);
    return res.writeHead(201).end(JSON.stringify({ id: nextSessionId }));
  }
  if (req.url?.startsWith('/sessions/') && req.url.endsWith('/log')) {
    return res.writeHead(200).end(JSON.stringify([{ method: 'GET', url: 'https://portal.vendor.com/login', status: 200, live: true }]));
  }
  if (req.url?.startsWith('/blocked?')) {
    const hosts = new URL(req.url, 'http://b.test').searchParams.getAll('host');
    return res.writeHead(200).end(JSON.stringify(Object.fromEntries(hosts.map(h => [h, false]))));
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    return res.writeHead(200).end(JSON.stringify({ state: closeState, log: closeLog }));
  }
  if (req.method === 'GET' && req.url === '/sessions') {
    return res.writeHead(200).end('[]');
  }
  res.writeHead(404).end('{}');
});
await new Promise<void>(ok => browserSvc.listen(0, '127.0.0.1', () => ok()));

Object.assign(process.env, {
  RF_BROWSER_URL: `http://127.0.0.1:${(browserSvc.address() as { port: number }).port}`,
  RF_BROWSER_KEY: 'bkey',
  RF_PUBLIC_URL: 'https://rf.demo.test',
  RF_BROWSER_IDLE_MS: '500',
  RF_BROWSER_CLOSE_MS: '1000',
});
delete process.env.OPENROUTER_API_KEY;

initSystem(tmp);
openStore(tmp);
saveTree({ workspaces: { w: { name: 'W', owners: [USER], members: [] } }, series: { s: { name: 'S', workspace: 'w' } } });

const { upsertUser } = await import('../src/auth.ts');
upsertUser(USER, { role: 'admin' });
const { personDir, saveLogin, secret } = await import('../src/logins.ts');
const { setConnection, setLetIn } = await import('../src/connections.ts');
const { ask, decide } = await import('../src/grants.ts');
const { Browsers, changeWebsite, endSignIn, revokeInternalHosts, startSignIn, websitesOf } = await import('../src/browsers.ts');

after(() => {
  browserSvc.close();
  rmSync(tmp, { recursive: true, force: true });
});

function writeSites(email: string, all: Record<string, object>) {
  mkdirSync(personDir(email), { recursive: true });
  writeFileSync(join(personDir(email), 'websites.json'), JSON.stringify(all, null, 1));
}

test('endSignIn and checkRefused handle unparseable request URLs in browser proxy logs without throwing', async () => {
  writeSites(USER, {
    portal: {
      url: 'https://portal.vendor.com/',
      hosts: [],
      writeback: true,
      added: '2026-11-15T00:00:00Z',
      profile: { what: 'Vendor portal.', category: 'vendor', risk: 'low', flags: [] },
      checks: { 'portal.vendor.com': { verdict: 'pass', why: 'Own domain.' } },
    },
  });
  nextSessionId = 'bs-malformed';
  const id = await startSignIn(USER, 'portal', '');
  closeState = { cookies: [{ name: 'sid', value: 'v1', domain: 'portal.vendor.com' }], origins: [] };
  closeLog = [
    { method: 'GET', url: 'https://portal.vendor.com/', status: 200, live: true },
    { method: 'OPTIONS', url: '*', status: 403, blocked: 'malformed request' },
  ];
  await endSignIn(USER, id, true);
  assert.ok(secret(USER, 'web:portal').includes('"v1"'));

  const g = await ask({ email: USER, role: 'admin', caps: [] }, 'portal', 'w', 'check');
  if (g.state === 'pending') decide({ email: USER, role: 'admin', caps: [] }, g.id, true);
  const inst = createInstance('s', 'malformed-refused', USER, ['web:portal']);
  inst.append('server', 'run', { run: 1, runner: USER, consent: 1 });
  const br = new Browsers(inst, 1, 'tok-malformed');
  nextSessionId = 'bs-malformed-run';
  closeLog = [
    { method: 'GET', url: 'https://cdn.vendor.com/app.js', status: 403, blocked: 'host not on the list' },
    { method: 'OPTIONS', url: '*', status: 403, blocked: 'malformed request' },
  ];
  await (br as any).browser('portal');
  await br.close();
  for (let i = 0; i < 40 && !websitesOf(USER).portal.hosts.includes('cdn.vendor.com'); i++) {
    await new Promise(ok => setTimeout(ok, 25));
  }
  assert.ok(websitesOf(USER).portal.hosts.includes('cdn.vendor.com'));
});

test('revokeInternalHosts strips revoked internal hosts from websites.json folders of unlogged-in bootstrap admins', async () => {
  const bootstrapAdmin = 'bootstrap-admin@demo.test';
  setLetIn(['sso.internal.test'], USER, true);
  writeSites(bootstrapAdmin, {
    erp: {
      url: 'https://erp.vendor.com/',
      hosts: ['sso.internal.test'],
      writeback: true,
      added: '2026-11-15T00:00:00Z',
      checks: { 'sso.internal.test': { verdict: 'pass', why: 'An admin allowed this internal host.' } },
    },
  });
  setLetIn(['sso.internal.test'], USER, false);
  await revokeInternalHosts(['sso.internal.test']);
  const afterSite = websitesOf(bootstrapAdmin).erp;
  assert.deepEqual(afterSite.hosts, []);
  assert.equal(afterSite.checks?.['sso.internal.test']?.verdict, 'internal');

  // Concurrent website change while PUT /sessions/:id/hosts is in flight must not be overwritten by stale websites.json snapshot
  setLetIn(['intra.internal.test'], USER, true);
  writeSites(USER, {
    intranet: {
      url: 'https://intranet.vendor.com/',
      hosts: ['intra.internal.test'],
      writeback: true,
      added: '2026-11-15T00:00:00Z',
      checks: { 'intra.internal.test': { verdict: 'pass', why: 'An admin allowed this internal host.' } },
    },
    sibling: {
      url: 'https://sibling.vendor.com/',
      hosts: [],
      writeback: true,
      added: '2026-11-15T00:00:00Z',
    },
  });
  nextSessionId = 'bs-concurrent-revoke';
  const openId = await startSignIn(USER, 'intranet', '');
  putHostsGate = Promise.withResolvers();
  putHostsEntered = Promise.withResolvers();
  setLetIn(['intra.internal.test'], USER, false);
  const revoking = revokeInternalHosts(['intra.internal.test']);
  await putHostsEntered.promise;
  changeWebsite(USER, 'sibling', { writeback: false, hosts: ['extra.vendor.com'] });
  putHostsGate.resolve();
  await revoking;
  putHostsGate = undefined;
  putHostsEntered = undefined;
  closeLog = [];
  await endSignIn(USER, openId, false);

  const userSites = websitesOf(USER);
  assert.deepEqual(userSites.intranet.hosts, []);
  assert.equal(userSites.intranet.checks?.['intra.internal.test']?.verdict, 'internal');
  assert.equal(userSites.sibling.writeback, false);
  assert.deepEqual(userSites.sibling.hosts, ['extra.vendor.com']);
});

test('run browser writeback excludes cookies scoped to bare private PSL suffixes like .github.io', async () => {
  writeSites(USER, {
    pages: {
      url: 'https://app.github.io/',
      hosts: [],
      writeback: true,
      added: '2026-11-15T00:00:00Z',
      profile: { what: 'Docs site.', category: 'vendor', risk: 'low', flags: [] },
      checks: { 'app.github.io': { verdict: 'pass', why: 'Own domain.' } },
    },
  });
  const since = '2026-11-15T01:00:00Z';
  saveLogin(USER, { id: 'web:pages', kind: 'website', name: 'pages', since, offers: [{ id: 'web:pages', name: 'pages' }] }, JSON.stringify({ cookies: [], origins: [] }));
  const g = await ask({ email: USER, role: 'admin', caps: [] }, 'pages', 'w', 'read docs');
  if (g.state === 'pending') decide({ email: USER, role: 'admin', caps: [] }, g.id, true);

  const inst = createInstance('s', 'psl-check', USER, ['web:pages']);
  inst.append('server', 'run', { run: 1, runner: USER, consent: 1 });
  const br = new Browsers(inst, 1, 'tok-psl');
  nextSessionId = 'bs-psl';
  closeState = {
    cookies: [
      { name: 'ok', value: '1', domain: 'app.github.io' },
      { name: 'shared', value: '2', domain: '.github.io' },
    ],
    origins: [],
  };
  closeLog = [{ method: 'GET', url: 'https://app.github.io/', status: 200 }];
  await (br as any).browser('pages');
  await br.close();
  const saved = JSON.parse(secret(USER, 'web:pages'));
  assert.deepEqual(saved.cookies.map((c: any) => c.domain), ['app.github.io']);
});

test('run browser open and writeback exclude hosts covered by connections added after site vetting', async () => {
  writeSites(USER, {
    mixed: {
      url: 'https://portal.vendor.com/',
      hosts: ['adb-99.azuredatabricks.net'],
      writeback: true,
      added: '2026-11-15T00:00:00Z',
      profile: { what: 'Vendor portal.', category: 'vendor', risk: 'low', flags: [] },
      checks: {
        'portal.vendor.com': { verdict: 'pass', why: 'Own domain.' },
        'adb-99.azuredatabricks.net': { verdict: 'pass', why: 'Added before databricks connection.' },
      },
    },
  });
  await setConnection('adb', { type: 'databricks' }, USER);
  const since = '2026-11-15T02:00:00Z';
  saveLogin(USER, { id: 'web:mixed', kind: 'website', name: 'mixed', since, offers: [{ id: 'web:mixed', name: 'mixed' }] }, JSON.stringify({ cookies: [], origins: [] }));
  const g = await ask({ email: USER, role: 'admin', caps: [] }, 'mixed', 'w', 'check');
  if (g.state === 'pending') decide({ email: USER, role: 'admin', caps: [] }, g.id, true);

  const inst = createInstance('s', 'except-check', USER, ['web:mixed']);
  inst.append('server', 'run', { run: 1, runner: USER, consent: 1 });
  const br = new Browsers(inst, 1, 'tok-except');
  openedBodies.length = 0;
  nextSessionId = 'bs-except';
  closeState = {
    cookies: [
      { name: 'ok', value: '1', domain: 'portal.vendor.com' },
      { name: 'dbx', value: '2', domain: 'adb-99.azuredatabricks.net' },
    ],
    origins: [],
  };
  closeLog = [{ method: 'GET', url: 'https://portal.vendor.com/', status: 200 }];
  try {
    await (br as any).browser('mixed');
    assert.deepEqual(openedBodies.at(-1).site.hosts, ['portal.vendor.com']);
  } finally {
    await br.close();
  }
  const saved = JSON.parse(secret(USER, 'web:mixed'));
  assert.deepEqual(saved.cookies.map((c: any) => c.domain), ['portal.vendor.com']);
});
