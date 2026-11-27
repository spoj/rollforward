import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { idp } from './idp.ts';

const ALICE = 'alice@synthetic.test', BOB = 'bob@synthetic.test';
const GROUP = '00000000-0000-0000-0000-000000000001', OTHER = '00000000-0000-0000-0000-000000000002';
const sessions = new Map<string, unknown>(), tunnels = new Map<string, unknown>();
let serial = 0;
const browserService = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://browser.test').pathname, id = path.split('/')[2];
  res.setHeader('content-type', 'application/json');
  if (path === '/capabilities') return res.writeHead(404).end('{"error":"no such route"}');
  if (path === '/sessions' && req.method === 'POST') {
    const id = `b${++serial}`;
    sessions.set(id, JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()));
    return res.end(JSON.stringify({ id }));
  }
  if (req.method === 'DELETE') {
    sessions.delete(id);
    return res.end(JSON.stringify({ state: { cookies: [{ name: 'SVPNCOOKIE', value: 'synthetic', domain: 'vpn.customer.test', path: '/', expires: -1 }], origins: [] }, log: [] }));
  }
  res.end('{}');
});
const tunnelService = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/tunnels' && req.method === 'GET') return res.end(JSON.stringify([...tunnels.values()]));
  if (req.url === '/tunnels' && req.method === 'POST') {
    const id = `t${++serial}`, data = { ...JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), id, token: `token-${id}`, up: true };
    tunnels.set(id, data);
    return res.end(JSON.stringify(data));
  }
  if (req.method === 'DELETE') tunnels.delete(req.url!.split('/')[2]);
  res.end('{}');
});
await Promise.all([browserService, tunnelService].map(s => new Promise<void>(ok => s.listen(0, '127.0.0.1', ok))));
const entra = await idp();
Object.assign(process.env, entra.env('https://rf.synthetic.test'), {
  RF_BROWSER_URL: `http://127.0.0.1:${(browserService.address() as { port: number }).port}`, RF_BROWSER_KEY: 'synthetic', RF_BROWSER_IDLE_MS: '60000',
  RF_TUNNEL_URL: `http://127.0.0.1:${(tunnelService.address() as { port: number }).port}`, RF_TUNNEL_KEY: 'synthetic', RF_TUNNEL_PROXY: 'http://proxy.synthetic.test:8799',
});
const { initSystem, saveTree, writeJson } = await import('../src/system.ts');
const { createInstance, openStore } = await import('../src/store.ts');
const { asPerson, can, users } = await import('../src/auth.ts');
const { confirm, keepSignIn } = await import('../src/entra.ts');
const { authority, lender, personDir, saveLogin } = await import('../src/logins.ts');
const { saveSeriesSettings, seriesSettings } = await import('../src/series.ts');
const { Browsers } = await import('../src/browsers.ts');
const { dropUnpermittedVpns, saveVpnSignIn, startVpnSignIn } = await import('../src/vpns.ts');
let root: string;
const browsers: InstanceType<typeof Browsers>[] = [];
const runs: import('../src/waker.ts').Active[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rf-entra-run-browser-'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Synthetic', owners: [ALICE, BOB], members: [] } }, series: { s: { name: 'Alice', workspace: 'w' }, other: { name: 'Bob', workspace: 'w' } } });
  writeJson('users.json', { [ALICE]: { role: 'user', groups: [GROUP, OTHER] }, [BOB]: { role: 'user' } });
  writeJson('capabilities.json', { vpn: [GROUP, OTHER, BOB] });
  writeJson('vpns.json', { corp: { type: 'fortinet', gateway: 'vpn.customer.test:10443' } });
  writeJson('internal.json', { 'vpn.customer.test': { by: ALICE, at: '' } });
  writeJson('grants.json', Object.fromEntries([ALICE, BOB].flatMap(person => ['portal', 'public'].map(site => [`${person} ${site}`, { workspace: 'w', person, site, at: '', state: 'approved' }]))));
  entra.who.groups[ALICE] = [GROUP, OTHER];
  for (const [series, email] of [['s', ALICE], ['other', BOB]]) {
    mkdirSync(join(root, 'series', series), { recursive: true });
    keepSignIn(email, entra.refresh(email));
    writeFileSync(join(personDir(email), 'websites.json'), JSON.stringify({ portal: { url: 'https://portal.customer.test/', hosts: [], via: 'corp', writeback: false, added: '' }, public: { url: 'https://public.example.com/', hosts: [], writeback: false, added: '' } }));
    for (const site of ['portal', 'public']) saveLogin(email, { id: `web:${site}`, kind: 'website', name: site, since: 'original', offers: [{ id: `web:${site}`, name: site }] }, JSON.stringify({ cookies: [], origins: [] }));
    saveSeriesSettings(join(root, 'series', series), { version: 1, owner: email, epoch: 1, since: '', consent: { by: email, at: '', workspace: 'w', logins: ['web:portal', 'web:public'], autonomous: false } });
  }
});
afterEach(async () => {
  const { active } = await import('../src/waker.ts');
  active.clear();
  await Promise.all(browsers.splice(0).map(b => b.end()));
  await Promise.all(runs.splice(0).map(a => a.ended));
  await dropUnpermittedVpns(ALICE);
  await dropUnpermittedVpns(BOB);
  entra.who.stale.clear();
  entra.who.gone.clear();
  rmSync(root, { recursive: true, force: true });
});
after(async () => {
  entra.close();
  await Promise.all([browserService, tunnelService].map(s => new Promise<void>(ok => s.close(() => ok()))));
});

async function openRun(email: string, series: string) {
  const { active, view } = await import('../src/waker.ts');
  await saveVpnSignIn(asPerson(email)!, await startVpnSignIn(asPerson(email)!, 'corp'));
  const inst = createInstance(series, 'period', email), lease = authority(inst);
  inst.append('server', 'run', { run: 1, runner: email, initiator: email, authority: lease });
  const b = new Browsers(inst, 1), opened = new Map<string, { id: string; cdp: PassThrough }>();
  browsers.push(b);
  for (const site of ['portal', 'public']) {
    const id = await b.browser(site), cdp = new PassThrough();
    assert.ok(id);
    b.connected(site, cdp);
    opened.set(site, { id, cdp });
  }
  const run: import('../src/waker.ts').Active = { inst, n: 1, runner: email, authority: lease, token: series, workspace: 'w', view: view(inst), browsers: b, sent: 0, noted: 0, seen: 0, delivered: 0, texts: new Map(), done: false, cost: 0, estimated: false, hosts: new Set(), links: new Map(), process: '' };
  active.set(series, run);
  runs.push(run);
  return { inst, opened, run };
}

test('confirm loads the run registry without recovering or starting runs', { timeout: 10000 }, async () => {
  const inst = createInstance('s', 'unrecovered', ALICE);
  inst.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  const log = [...inst.log];
  await confirm(ALICE);
  const { active, byToken } = await import('../src/waker.ts');
  assert.equal(active.size, 0);
  assert.equal(byToken.size, 0);
  assert.deepEqual(inst.log, log);
});

test('confirm closes active VPN run browsers and CDP on last-group loss, not other granted browsers', { timeout: 10000 }, async () => {
  const own = await openRun(ALICE, 's'), unrelated = await openRun(BOB, 'other');
  const vpn = own.opened.get('portal')!, direct = own.opened.get('public')!;
  const settings = seriesSettings(join(root, 'series/s'));
  entra.who.groups[ALICE] = [OTHER];
  await confirm(ALICE);
  assert.ok(sessions.has(vpn.id), 'another granted group retains the run browser');
  assert.equal(vpn.cdp.destroyed, false);
  assert.equal(tunnels.size, 2);
  delete entra.who.groups[ALICE];
  await confirm(ALICE);
  assert.equal(tunnels.size, 1, 'only the unrelated tunnel remains');
  assert.deepEqual({ remoteBrowserOpen: sessions.has(vpn.id), cdpDestroyed: vpn.cdp.destroyed }, { remoteBrowserOpen: false, cdpDestroyed: true }, 'the remote run browser and existing CDP connection close before confirm returns');
  assert.ok(sessions.has(direct.id), 'the same owner retains their direct browser');
  assert.equal(direct.cdp.destroyed, false);
  assert.equal(users()[ALICE].disabled, undefined, 'VPN group loss is not a departure');
  assert.equal(lender(own.inst, 1).by, ALICE);
  assert.deepEqual(seriesSettings(join(root, 'series/s')), settings, 'owner and consent are unchanged');
  await confirm(BOB);
  for (const { id, cdp } of unrelated.opened.values()) {
    assert.ok(sessions.has(id), 'an unrelated email-granted owner retains their browser');
    assert.equal(cdp.destroyed, false);
  }
  assert.equal(tunnels.size, 1, 'an email grant survives renewal without groups');
});

test('confirm preserves run browsers on ordinary expiry but closes them on an actual Entra disable', { timeout: 10000 }, async () => {
  const own = await openRun(ALICE, 's'), unrelated = await openRun(BOB, 'other');
  const settings = seriesSettings(join(root, 'series/s'));
  entra.who.stale.add(ALICE);
  await assert.rejects(confirm(ALICE), e => {
    assert.match((e as Error).message, /AADSTS700082/);
    assert.equal((e as { left?: boolean }).left, undefined);
    return true;
  });
  for (const { id, cdp } of own.opened.values()) {
    assert.ok(sessions.has(id), 'ordinary expiry retains VPN and direct run browsers');
    assert.equal(cdp.destroyed, false);
  }
  assert.equal(tunnels.size, 2);
  assert.equal(users()[ALICE].disabled, undefined);
  assert.deepEqual(seriesSettings(join(root, 'series/s')), settings);
  entra.who.stale.delete(ALICE);
  entra.who.gone.add(ALICE);
  await assert.rejects(confirm(ALICE), e => {
    assert.match((e as Error).message, /AADSTS50057/);
    assert.equal((e as { left?: boolean }).left, true);
    return true;
  });
  assert.equal(users()[ALICE].disabled, true);
  await own.run.ended;
  for (const { id, cdp } of own.opened.values()) {
    assert.equal(sessions.has(id), false, 'disable retires both VPN and direct run browsers');
    assert.equal(cdp.destroyed, true);
  }
  assert.equal(tunnels.size, 1);
  for (const { id, cdp } of unrelated.opened.values()) {
    assert.ok(sessions.has(id));
    assert.equal(cdp.destroyed, false);
  }
});
