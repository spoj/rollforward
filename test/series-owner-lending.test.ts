import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createInstance, openStore, type Instance } from '../src/store.ts';
import { initSystem, readLines, saveTree, writeJson } from '../src/system.ts';
import { authority, lender, logins, personDir, saveLogin, secret, unoffer } from '../src/logins.ts';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';

const ALICE = 'alice@synthetic.test', BOB = 'bob@synthetic.test';
const state = (value: string) => ({ cookies: [{ name: 'sid', value, domain: 'portal.example.com' }], origins: [] });
let openGate: Promise<void> | undefined, closeGate: Promise<void> | undefined, providerGate: Promise<void> | undefined;
let opened = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>(), sent = Promise.withResolvers<void>();
let returned = state('refreshed'), session = 0, providerStatus = 200;
const sessions = new Set<string>();
const closed: string[] = [], received: { auth: string | undefined; runner: string | undefined; path: string }[] = [];
const service = createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString();
  if (req.method === 'GET' && req.url === '/sessions') return res.end(JSON.stringify([...sessions].map(id => ({ id }))));
  if (req.method === 'POST' && req.url === '/sessions') {
    const id = `synthetic-${++session}`;
    sessions.add(id);
    opened.resolve();
    await openGate;
    return res.end(JSON.stringify({ id }));
  }
  if (req.method === 'DELETE' && req.url!.startsWith('/sessions/')) {
    closed.push(req.url!);
    sessions.delete(req.url!.split('/')[2]);
    closing.resolve();
    await closeGate;
    return res.end(JSON.stringify({ state: returned, log: [{ method: 'GET', url: 'https://portal.example.com/', status: 200 }] }));
  }
  received.push({ auth: req.headers.authorization, runner: req.headers['x-rf-runner'] as string | undefined, path: req.url! });
  sent.resolve();
  await providerGate;
  res.writeHead(providerStatus, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/api/v1/chat/completions' ? { usage: { cost: 0.37 }, echo: JSON.parse(body) } : { ok: true }));
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_BROWSER_KEY: 'synthetic-only', RF_BROWSER_IDLE_MS: '60000', RF_SERVICE_KEY_SVC: 'synthetic-service', OPENROUTER_API_KEY: 'synthetic-shared' });
const { Browsers, serveBrowsers, reap, removeSite, setSite } = await import('../src/browsers.ts');
const { agentCall } = await import('../src/agent-api.ts');
const { call, reachable, types, upstreams, hasCalls, drainCalls } = await import('../src/connections.ts');
const { sources, prepare, prune } = await import('../src/indexes.ts');
upstreams['openrouter.ai'] = base;
let active: import('../src/connections.ts').CallRun;
const proxy = createServer((req, res) => call(active, req.headers['x-test-host'] as string, req, res));
await new Promise<void>(ok => proxy.listen(0, '127.0.0.1', ok));
const proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
let root: string;
const browsers: InstanceType<typeof Browsers>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rf-owner-lending-'));
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'Synthetic', owners: [ALICE], members: [BOB] } }, series: { s: { name: 'Synthetic', workspace: 'w' } } });
  writeJson('users.json', { [ALICE]: { role: 'user' }, [BOB]: { role: 'user' } });
  writeJson('connections.json', { svc: { type: 'service', url: base, paths: ['a/', 'b/'] }, db: { type: 'databricks' }, later: { type: 'databricks' } });
  writeJson('grants.json', Object.fromEntries([ALICE, BOB].flatMap(person => ['portal', 'extra'].map(site => [`${person} ${site}`, { workspace: 'w', person, site, at: '', state: 'approved' }]))));
  for (const email of [ALICE, BOB]) {
    mkdirSync(personDir(email), { recursive: true });
    writeFileSync(join(personDir(email), 'websites.json'), JSON.stringify({ portal: { url: 'https://portal.example.com/', hosts: [], writeback: true, added: 'original' }, extra: { url: 'https://extra.example.com/', hosts: [], writeback: true, added: 'original' } }));
    saveLogin(email, { id: 'web:portal', name: 'Portal', kind: 'website', since: 'original', offers: [{ id: 'web:portal', name: 'Portal' }] }, JSON.stringify(state(email)));
    saveLogin(email, { id: 'svc', name: 'Service', kind: 'service', since: 'original', offers: [] });
    saveLogin(email, { id: 'db', name: 'DB', kind: 'databricks', since: '', offers: [{ id: 'db:adb-a.azuredatabricks.net/old', name: 'Old' }] });
    saveLogin(email, { id: 'later', name: 'Later', kind: 'databricks', since: '', offers: [{ id: 'later:adb-b.azuredatabricks.net/new', name: 'New' }] });
    saveLogin(email, { id: 'custom', kind: 'synthetic', name: 'Custom', since: '', offers: [{ id: 'custom:offer', name: 'Offer' }] });
    saveLogin(email, { id: 'web:extra', kind: 'website', name: 'Extra', since: '', offers: [{ id: 'web:extra', name: 'Extra' }] }, '{}');
    const file = join(personDir(email), 'logins.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify([...saved, { id: 'm365', kind: 'm365', name: 'Synthetic', since: '', offers: [{ id: 'm365:item:drive/one', name: 'One' }, { id: 'm365:item:drive/two', name: 'Two' }] }]));
  }
  opened = Promise.withResolvers<void>();
  closing = Promise.withResolvers<void>();
  sent = Promise.withResolvers<void>();
  openGate = closeGate = providerGate = undefined;
  returned = state('refreshed');
  providerStatus = 200;
  closed.length = received.length = 0;
  sessions.clear();
});
afterEach(async () => {
  await Promise.all(browsers.splice(0).map(b => b.end()));
  rmSync(root, { recursive: true, force: true });
});
after(() => { proxy.close(); service.close(); });

function consent(ticks: string[], owner = ALICE, epoch = 1) {
  saveSeriesSettings(join(root, 'series/s'), { version: 1, owner, epoch, since: '', consent: { by: owner, at: '', workspace: 'w', logins: ticks, autonomous: false } });
}
function running(ticks = ['web:portal']) {
  consent(ticks);
  const inst = createInstance('s', `instance-${session}-${Math.random()}`, BOB);
  inst.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  active = { inst, n: 1, runner: ALICE, links: new Map(), cost: 0 };
  return inst;
}
function browser(inst: Instance) {
  const b = new Browsers(inst, 1);
  browsers.push(b);
  return b;
}

test('reachable and environment use the run ceiling, not the creator or later additions', () => {
  const tick = 'db:adb-a.azuredatabricks.net/old', inst = running([tick]);
  consent([tick, 'later:adb-b.azuredatabricks.net/new']);
  assert.deepEqual(reachable(inst, 1).map(c => c.name), ['db']);
  assert.deepEqual(reachable(inst).map(c => c.name), ['db', 'later']);
  assert.deepEqual(types.databricks.env!(reachable(inst, 1)[0], lender(inst, 1).logins), { DATABRICKS_TOKEN: 'rf', DATABRICKS_HOST: 'https://adb-a.azuredatabricks.net', DATABRICKS_WAREHOUSE_ID: 'old' });
  assert.equal(inst.log[0].by, BOB);
});

test('connection policy never acquires a newly selected prefix and sends the captured executor', async () => {
  const inst = running(['svc:a/']);
  consent(['svc:a/', 'svc:b/']);
  const refused = await fetch(`${proxyBase}/b/value`, { headers: { 'x-test-host': 'svc.rf.internal' } });
  assert.equal(refused.status, 403);
  assert.equal(received.length, 0);
  const allowed = await fetch(`${proxyBase}/a/value`, { headers: { 'x-test-host': 'svc.rf.internal', 'x-rf-runner': BOB } });
  assert.equal(allowed.status, 200);
  assert.equal(received[0].runner, ALICE);
});

test('a delayed policy cannot forward after owner epoch changes', async t => {
  const inst = running(['svc:a/']), gate = Promise.withResolvers<void>(), checked = Promise.withResolvers<void>(), original = types.service.check!;
  types.service.check = async (...args) => { checked.resolve(); await gate.promise; return original(...args); };
  t.after(() => { types.service.check = original; });
  const pending = fetch(`${proxyBase}/a/value`, { headers: { 'x-test-host': 'svc.rf.internal' } });
  await checked.promise;
  consent(['svc:a/'], ALICE, 3);
  gate.resolve();
  assert.equal((await pending).status, 403);
  assert.equal(received.length, 0);
  assert.equal(inst.log.some(e => e.op === 'send'), false);
});

test('a pending provider body never acquires a replacement key that was saved disabled', async () => {
  running([]);
  saveLogin(ALICE, { id: 'openrouter', kind: 'key', name: 'Model', since: 'old', offers: [], enabled: true }, 'old-enabled');
  const reading = Promise.withResolvers<void>(), body = Promise.withResolvers<void>();
  const req = Object.assign(Readable.from((async function* () { reading.resolve(); await body.promise; yield Buffer.from('{"model":"synthetic"}'); })()), { url: '/api/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } });
  const res = Object.assign(new PassThrough(), { statusCode: 0, writeHead(status: number) { this.statusCode = status; return this; } });
  res.resume();
  const response = call(active, 'openrouter.ai', req as IncomingMessage, res as unknown as ServerResponse);
  await reading.promise;
  saveLogin(ALICE, { id: 'openrouter', kind: 'key', name: 'Model', since: 'new', offers: [], enabled: false }, 'new-disabled');
  body.resolve();
  await response;
  assert.equal(res.statusCode, 409);
  assert.equal(received.length, 0);
});

test('already-sent ordinary service writes participate in the run retirement drain', async () => {
  running(['svc:a/']);
  const gate = Promise.withResolvers<void>();
  providerGate = gate.promise;
  const pending = fetch(`${proxyBase}/a/value`, { method: 'POST', headers: { 'x-test-host': 'svc.rf.internal' }, body: 'synthetic' });
  await sent.promise;
  let drained = false, draining: Promise<void> | undefined;
  try {
    assert.equal(hasCalls(active), true);
    draining = drainCalls(active).then(() => { drained = true; });
    await new Promise(ok => setTimeout(ok, 20));
    assert.equal(drained, false);
  } finally {
    gate.resolve();
    assert.equal((await pending).status, 200);
    await draining;
  }
  assert.equal(active.inst.log.some(e => e.op === 'call' && e.status === 200), true);
  assert.equal(hasCalls(active), false);
});

test('a sent provider answer costs the captured owner after transfer', async () => {
  const inst = running([]), gate = Promise.withResolvers<void>();
  providerGate = gate.promise;
  saveLogin(ALICE, { id: 'openrouter', kind: 'key', name: 'Model', since: 'key-a', offers: [], enabled: true }, 'synthetic-alice');
  saveLogin(BOB, { id: 'openrouter', kind: 'key', name: 'Model', since: 'key-b', offers: [], enabled: true }, 'synthetic-bob');
  const pending = fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'x-test-host': 'openrouter.ai', 'content-type': 'application/json' }, body: '{"model":"synthetic"}' });
  await sent.promise;
  consent([], BOB, 2);
  gate.resolve();
  assert.equal((await pending).status, 200);
  assert.equal(received[0].auth, 'Bearer synthetic-alice');
  assert.equal(active.cost, 0.37);
  const costs = readLines<{ person: string; own: boolean }>(join(root, '.rf/costs.jsonl'));
  assert.equal(costs[0].person, ALICE);
  assert.equal(costs[0].own, true);
  assert.equal(inst.log.find(e => e.op === 'run')!.runner, ALICE);
});

test('late own-key expiry never mutates the incoming owner or revives an expired lease', async () => {
  const inst = running([]), gate = Promise.withResolvers<void>();
  providerGate = gate.promise;
  providerStatus = 402;
  for (const email of [ALICE, BOB]) saveLogin(email, { id: 'openrouter', kind: 'key', name: 'Model', since: email, offers: [], enabled: true }, 'synthetic-key');
  const pending = fetch(`${proxyBase}/api/v1/chat/completions`, { method: 'POST', headers: { 'x-test-host': 'openrouter.ai', 'content-type': 'application/json' }, body: '{"model":"synthetic"}' });
  await sent.promise;
  consent([], BOB, 2);
  gate.resolve();
  assert.equal((await pending).status, 402);
  assert.equal(logins(ALICE).find(l => l.id === 'openrouter')!.expired, undefined);
  assert.equal(logins(BOB).find(l => l.id === 'openrouter')!.expired, undefined);
  assert.equal(inst.log.some(e => e.op === 'expired'), false);
});

test('browser expiry stays attributed to the captured person during retirement', async () => {
  const inst = running(), b = browser(inst), gate = Promise.withResolvers<void>();
  await b.browser('portal');
  closeGate = gate.promise;
  const pending = b.expire('portal');
  await closing.promise;
  consent(['web:portal'], BOB, 2);
  gate.resolve();
  await pending;
  assert.equal(inst.log.find(e => e.op === 'expired')!.runner, ALICE);
  assert.equal(logins(BOB).find(l => l.id === 'web:portal')!.expired, undefined);
});

test('index copies select only leased sources and prune after transfer', async () => {
  const one = 'm365:item:drive/one', two = 'm365:item:drive/two', inst = running([one]);
  mkdirSync(join(personDir(ALICE), 'index'), { recursive: true });
  for (const [id, name] of [[one, 'One'], [two, 'Two']]) {
    const file = join(personDir(ALICE), 'index', createHash('sha256').update(id).digest('hex').slice(0, 16));
    writeFileSync(`${file}.json`, JSON.stringify({ person: ALICE, source: id, name, gen: 0, length: 0, lines: 0, base: 0, parts: { first: { due: null, tries: 5 } } }));
  }
  const captured = authority(inst);
  consent([one, two]);
  assert.deepEqual(sources(inst, 1).map(s => s.o.id), [one]);
  assert.deepEqual(sources(inst, captured).map(s => s.o.id), [one], 'a wake check takes the captured ceiling too');
  const dir = join(root, '.rf/runs/token'), meta = join(personDir(ALICE), 'index', `${createHash('sha256').update(one).digest('hex').slice(0, 16)}.json`);
  const before = readFileSync(meta, 'utf8');
  assert.equal(await prepare(inst, join(root, '.rf/runs/check'), captured), true);
  assert.equal(readFileSync(meta, 'utf8'), before, 'a snapshot does not resume a stopped feed');
  assert.equal(prepare(inst, dir, 1), true);
  assert.equal(readFileSync(join(dir, 'One.json'), 'utf8').includes(one), true);
  consent([], BOB, 2);
  prune(inst, 1, 'token');
  assert.deepEqual(sources(inst, 1), []);
  assert.deepEqual(sources(inst, captured), []);
  assert.throws(() => readFileSync(join(dir, 'One.json')), { code: 'ENOENT' });
});

test('browser listing remains the run snapshot after the series ceiling grows', async () => {
  const inst = running(), b = browser(inst);
  consent(['web:portal', 'web:extra']);
  let listing = '';
  const res = { writeHead() { return this; }, end(s: string) { listing = s; } };
  await serveBrowsers(b, '/browsers/token', [], { method: 'GET' } as any, res as any);
  assert.match(listing, /portal  https:\/\/portal.example.com\//);
  assert.doesNotMatch(listing, /extra.example.com/);
});

test('an opening browser rejects A→B→A and discards late state', async () => {
  const inst = running(), b = browser(inst), gate = Promise.withResolvers<void>();
  openGate = gate.promise;
  const pending = b.browser('portal');
  await opened.promise;
  consent(['web:portal'], BOB, 2);
  consent(['web:portal'], ALICE, 3);
  gate.resolve();
  await assert.rejects(pending, /authority has ended/);
  assert.equal(closed.length, 1);
  assert.equal(b.bySite.size, 0);
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
  assert.equal(JSON.parse(secret(BOB, 'web:portal')).cookies[0].value, BOB);
});

test('a connected browser refuses new CDP and writeback after transfer', async () => {
  const inst = running(), b = browser(inst), conn = new PassThrough();
  await b.browser('portal');
  b.connected('portal', conn);
  consent(['web:portal'], BOB, 2);
  assert.throws(() => b.connected('portal', new PassThrough()), /authority has ended/);
  await b.closeUnlent();
  assert.equal(conn.destroyed, true);
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
  assert.equal(inst.log.filter(e => e.op === 'browser').length, 1);
});

test('late close state is discarded if the epoch changes while closing', async () => {
  const inst = running(), b = browser(inst), gate = Promise.withResolvers<void>();
  await b.browser('portal');
  closeGate = gate.promise;
  const pending = b.close();
  await closing.promise;
  consent(['web:portal'], ALICE, 2);
  gate.resolve();
  await pending;
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
});

test('valid browser closure still refreshes the personal state', async () => {
  const b = browser(running());
  await b.browser('portal');
  await b.close();
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, 'refreshed');
});

test('website removal and personal unoffer cannot revive a lease after regrant', async () => {
  const inst = running(['web:portal', 'custom:offer']), b = browser(inst);
  saveLogin(ALICE, { id: 'custom', kind: 'synthetic', name: 'Custom', since: '', offers: [{ id: 'custom:offer', name: 'Offer' }] });
  await b.browser('portal');
  removeSite(ALICE, 'portal');
  assert.deepEqual(seriesSettings(inst.series()).consent?.logins, ['custom:offer']);
  saveLogin(ALICE, { id: 'web:portal', kind: 'website', name: 'Portal', since: 'replacement', offers: [{ id: 'web:portal', name: 'Portal' }] }, JSON.stringify(state('replacement')));
  await assert.rejects(b.browser('portal'), /authority has ended/);
  assert.ok(seriesSettings(inst.series()).epoch > 1);
  consent(['custom:offer'], ALICE, 4);
  inst.append('server', 'run', { run: 2, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  unoffer(ALICE, 'custom', 'custom:offer');
  saveLogin(ALICE, { id: 'custom', kind: 'synthetic', name: 'Custom', since: '', offers: [{ id: 'custom:offer', name: 'Offer' }] });
  assert.throws(() => lender(inst, 2), /authority has ended/);
});

test('revoking one workspace grant cannot revive a lease while another grant preserves the login', async () => {
  const inst = running(['web:portal', 'custom:offer']), b = browser(inst);
  await b.browser('portal');
  writeJson('grants.json', { here: { workspace: 'w', person: ALICE, site: 'portal', at: '', state: 'revoked' }, elsewhere: { workspace: 'another', person: ALICE, site: 'portal', at: '', state: 'approved' } });
  assert.deepEqual(seriesSettings(inst.series()).consent?.logins, ['custom:offer']);
  assert.equal(seriesSettings(inst.series()).epoch, 2);
  writeJson('grants.json', { here: { workspace: 'w', person: ALICE, site: 'portal', at: '', state: 'approved' }, elsewhere: { workspace: 'another', person: ALICE, site: 'portal', at: '', state: 'approved' } });
  await assert.rejects(b.browser('portal'), /authority has ended/);
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
});

test('a waiting writer cannot open after its owner epoch ends', async () => {
  const first = browser(running()), secondInst = running(), second = browser(secondInst);
  await first.browser('portal');
  const pending = second.browser('portal');
  await new Promise<void>(ok => setImmediate(ok));
  assert.equal(secondInst.log.some(e => e.op === 'browser' && e.action === 'wait'), true);
  consent(['web:portal'], BOB, 2);
  await first.close();
  await assert.rejects(pending, /authority has ended/);
  assert.equal(second.bySite.size, 0);
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
});

test('restart browser writeback is checked against the original run epoch', async () => {
  const inst = running();
  sessions.add('restart-synthetic');
  writeJson('browsers.json', { 'restart-synthetic': { inst: inst.id, run: 1, site: 'portal', email: ALICE, since: 'original', writeback: true, generation: 0, file: 'browser/restart.jsonl' } });
  consent(['web:portal'], BOB, 2);
  await (await reap()).closed;
  assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
  assert.equal(inst.log.filter(e => e.op === 'browser').length, 1);
});

test('restart cannot write back a browser predating a website route ABA', async () => {
  const inst = running(['web:portal']), b = browser(inst);
  await b.browser('portal');
  const was = process.env.RF_TUNNEL_URL;
  process.env.RF_TUNNEL_URL = base;
  writeJson('capabilities.json', { vpn: [ALICE] });
  writeJson('vpns.json', { synthetic: { type: 'fortinet', gateway: 'vpn.example.test:443' } });
  const me = { email: ALICE, name: 'Alice', role: 'user' as const, groups: [] };
  try {
    await setSite(me, 'portal', { via: 'synthetic' });
    await setSite(me, 'portal', { via: '' });
    const restarted = await import(`../src/browsers.ts?restart=${Date.now()}`);
    await (await restarted.reap()).closed;
    assert.equal(JSON.parse(secret(ALICE, 'web:portal')).cookies[0].value, ALICE);
  } finally {
    if (was === undefined) delete process.env.RF_TUNNEL_URL;
    else process.env.RF_TUNNEL_URL = was;
  }
});

test('print browsers also reject a delayed open after authority changes', async () => {
  const inst = running([]), b = browser(inst), gate = Promise.withResolvers<void>();
  openGate = gate.promise;
  const pending = b.browser('print');
  await opened.promise;
  consent([], BOB, 2);
  gate.resolve();
  await assert.rejects(pending, /authority has ended/);
  assert.equal(closed.length, 1);
});

test('an already admitted agent body cannot write after an interrupt without an epoch change', async () => {
  const inst = running([]), gate = Promise.withResolvers<Buffer>(), a = { inst, n: 1, stopped: false };
  inst.doc.items.push({ id: 'result', name: 'Result', kind: 'output', file: null });
  const pending = agentCall(a, '/agent/delivered', 'POST', () => gate.promise);
  a.stopped = true;
  gate.resolve(Buffer.from('{"args":["result","--to","synthetic","--receipt","synthetic"]}'));
  await assert.rejects(pending, /run stopped/);
  assert.equal(inst.log.some(e => e.op === 'delivered'), false);
});

test('agent body reads cannot append delivered output after a transfer', async () => {
  const inst = running([]), gate = Promise.withResolvers<Buffer>();
  inst.doc.items.push({ id: 'result', name: 'Result', kind: 'output', file: null });
  const pending = agentCall({ inst, n: 1 }, '/agent/delivered', 'POST', () => gate.promise);
  consent([], BOB, 2);
  gate.resolve(Buffer.from('{"args":["result","--to","synthetic","--receipt","synthetic"]}'));
  await assert.rejects(pending, /authority has ended/);
  assert.equal(inst.log.some(e => e.op === 'delivered'), false);
});
