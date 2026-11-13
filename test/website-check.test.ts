import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, rfDir, writeJson } from '../src/system.ts';
import type { Instance } from '../src/store.ts';
import type { Trace } from '../src/logins.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-website-check-')), email = 'alice@company.test';
const profile = { what: 'A business portal.', category: 'vendor', risk: 'low', flags: [] };
let mode = 'normal', blockFailure = false, blocked = new Set<string>(), serial = 0;
let log: Record<string, unknown>[] = [], state: unknown = { cookies: [], origins: [] };
let release: (() => void) | undefined, modelSeen: (() => void) | undefined, gate: Promise<void> | undefined;
const openings: any[] = [], models: any[] = [], searches: any[] = [], blockQueries: string[][] = [], deleted: string[] = [];
const service = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://service');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/blocked') {
    blockQueries.push(url.searchParams.getAll('host'));
    if (blockFailure) return void res.writeHead(503).end('{"error":"blocklists not loaded yet"}');
    return void res.end(JSON.stringify(Object.fromEntries(url.searchParams.getAll('host').map(h => [h, blocked.has(h)]))));
  }
  if (url.pathname === '/search') {
    searches.push({ body: JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()), key: req.headers['x-api-key'] });
    return void res.end(JSON.stringify({ results: [{ title: 'Business sign-on', url: 'https://public.test/info', highlights: ['An identity provider.'] }] }));
  }
  if (url.pathname === '/api/v1/chat/completions') {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    models.push(body);
    modelSeen?.();
    await gate;
    if (mode === 'fail') return void res.writeHead(500).end('{}');
    const toolCount = body.messages.filter((m: any) => m.role === 'tool').length;
    if ((['search', 'internal'].includes(mode) && !toolCount) || (mode === 'five' && toolCount < 5) || mode === 'limit') {
      const queries = mode === 'internal' ? ['ERP.company.test operator', 'auth.vendor.test identity'] : Array.from({ length: mode === 'limit' ? 6 : 1 }, (_, i) => `auth.vendor.test identity ${i}`);
      return void res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: queries.map((query, i) => ({ id: `search-${i}`, type: 'function', function: { name: 'search', arguments: JSON.stringify({ query }) } })) } }] }));
    }
    const evidence = JSON.parse(body.messages[1].content);
    const hosts = Object.fromEntries(evidence.unchecked.filter((h: string) => mode !== 'partial' || !h.startsWith('later.')).map((h: string) => [h, { verdict: h.startsWith('metrics.') ? 'refused' : h.startsWith('upload.') ? 'high' : 'pass', why: 'Its role was checked.' }]));
    return void res.end(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ profile, hosts })}\n\`\`\`` } }] }));
  }
  if (req.method === 'POST' && url.pathname === '/sessions') {
    openings.push(JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString()));
    return void res.writeHead(201).end(JSON.stringify({ id: `b${++serial}` }));
  }
  if (req.method === 'DELETE') {
    deleted.push(url.pathname);
    return void res.end(JSON.stringify({ state, log }));
  }
  if (url.pathname.endsWith('/log')) return void res.end(JSON.stringify(log));
  if (url.pathname.endsWith('/page')) return void res.end(JSON.stringify({ url: 'https://erp.company.test/', password: false }));
  res.end('{}');
});
await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
Object.assign(process.env, { RF_BROWSER_URL: base, RF_BROWSER_KEY: 'browser-key', RF_PUBLIC_URL: 'https://rf.company.test' });
const { Browsers, addSite, allowHost, changeWebsite, checkWebsite, endSignIn, isSignIn, keepAlive, removeHost, setSite, startSignIn, websitesOf } = await import('../src/browsers.ts');
const { checkHost, setLetIn, upstreams } = await import('../src/connections.ts');
const { logins, saveLogin, secret } = await import('../src/logins.ts');
Object.assign(upstreams, { 'openrouter.ai': base, 'api.exa.ai': base });
initSystem(root);
after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => {
  mode = 'normal'; blockFailure = false; blocked = new Set(); gate = undefined; modelSeen = undefined; release = undefined;
  log = []; state = { cookies: [], origins: [] };
  openings.length = models.length = searches.length = blockQueries.length = deleted.length = 0;
  Object.assign(process.env, { OPENROUTER_API_KEY: 'server-key', EXA_API_KEY: 'exa-key' });
  delete process.env.RF_SIGNIN_S;
  writeJson('connections.json', { m365: { type: 'graph' }, db: { type: 'databricks' } });
  writeJson('internal.json', {});
});
const site = async (name: string, change: object = {}) => {
  await addSite(email, name, 'https://erp.company.test/sign-in?code=private');
  changeWebsite(email, name, change);
};
const trace = (...hosts: string[]): Trace => ({ requests: Object.fromEntries(hosts.map(h => [h, { 200: 1 }])), blocked: [], seconds: 20 });

test('open sign-ins are short, exclude own and connection hosts, and list only admin exact internal hosts', async () => {
  await site('open', { hosts: ['10.1.2.3', '*.internal.test'] });
  setLetIn(['10.1.2.3', '10.9.8.7', '*.internal.test'], 'admin@company.test', true);
  const id = await startSignIn(email, 'open', '');
  const opened = openings.at(-1);
  assert.deepEqual(opened.site.hosts, ['10.1.2.3']);
  assert.equal(opened.site.open, true);
  assert.equal(opened.site.public, undefined);
  assert.equal(opened.ttl_s, 600);
  for (const host of ['rf.company.test', '127.0.0.1', 'graph.microsoft.com', '*.azuredatabricks.net']) assert.ok(opened.site.except.includes(host), host);
  assert.equal(opened.site.hosts.includes('erp.company.test'), false);
  await endSignIn(email, id, false);
  process.env.RF_SIGNIN_S = '12';
  const next = await startSignIn(email, 'open', '');
  assert.equal(openings.at(-1).ttl_s, 12);
  await endSignIn(email, next, false);
  for (const h of ['rf.company.test', 'graph.microsoft.com', '*.company.test']) await assert.rejects(checkHost(h, true), /no website reaches it/);
});

test('one shared conversation searches with Exa and persists profile and rule/model host verdicts', async () => {
  await site('rules');
  mode = 'search';
  blocked.add('bad.company.test');
  blocked.add('10.2.3.5');
  const evidence = trace('cdn.company.test', 'bad.company.test', '10.2.3.4', '10.2.3.5', 'auth.vendor.test', 'metrics.vendor.test', 'upload.vendor.test', 'graph.microsoft.com');
  evidence.kinds = { 'auth.vendor.test': { dest: ['document'], from: ['erp.company.test'] } };
  assert.deepEqual(await checkWebsite(email, 'rules', evidence), profile);
  assert.equal(models.length, 2);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].key, 'exa-key');
  assert.equal(models[0].provider.data_collection, 'deny');
  assert.equal(models[1].messages.at(-1).role, 'tool');
  assert.equal(models[1].messages.at(-2).tool_calls[0].id, models[1].messages.at(-1).tool_call_id);
  const w = websitesOf(email).rules;
  assert.deepEqual(w.profile, profile);
  assert.equal(w.checks!['cdn.company.test'].verdict, 'pass');
  assert.equal(w.checks!['bad.company.test'].verdict, 'refused');
  assert.equal(w.checks!['10.2.3.4'].verdict, 'internal');
  assert.equal(w.checks!['10.2.3.5'].verdict, 'refused');
  assert.equal(w.checks!['graph.microsoft.com'].verdict, 'refused');
  assert.equal(w.checks!['metrics.vendor.test'].verdict, 'refused');
  assert.equal(w.checks!['upload.vendor.test'].verdict, 'high');
  assert.deepEqual(w.hosts.sort(), ['auth.vendor.test', 'cdn.company.test']);
  const input = JSON.parse(models[0].messages[1].content);
  assert.deepEqual(input.evidence, evidence);
  assert.equal(JSON.stringify(input).includes('private'), false);
  const acts = readFileSync(join(rfDir(), 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const checked = acts.findLast(a => a.op === 'website-check' && a.site === 'rules');
  assert.deepEqual([checked.by, checked.evidence, checked.queries, checked.profile, checked.checks], ['server', evidence, [searches[0].body.query], profile, w.checks]);
  await checkWebsite(email, 'rules', evidence);
  assert.equal(models.length, 2, 'a successful profile and completed verdicts are cached');
});

test('a search naming an internal host never reaches Exa, and still counts towards the five', async () => {
  await site('intranet');
  setLetIn(['erp.company.test'], 'admin@company.test', true);
  mode = 'internal';
  await checkWebsite(email, 'intranet', trace('erp.company.test', 'auth.vendor.test'));
  assert.deepEqual(searches.map(s => s.body.query), ['auth.vendor.test identity']);
  assert.match(models[1].messages.find((m: any) => m.tool_call_id === 'search-0').content, /not public search targets/);
  const acts = readFileSync(join(rfDir(), 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(acts.findLast(a => a.op === 'website-check' && a.site === 'intranet').queries, ['ERP.company.test operator', 'auth.vendor.test identity']);
});

test('model and blocklist failures store only profile.error; unchecked hosts can be retried', async () => {
  await site('retry');
  mode = 'fail';
  const evidence = trace('cdn.company.test', 'auth.vendor.test');
  assert.deepEqual(await checkWebsite(email, 'retry', evidence), { error: 'OpenRouter answered 500' });
  assert.equal(websitesOf(email).retry.checks!['cdn.company.test'].verdict, 'pass');
  assert.equal(websitesOf(email).retry.checks!['auth.vendor.test'], undefined);
  mode = 'normal';
  assert.deepEqual(await checkWebsite(email, 'retry', evidence), profile);
  assert.equal(websitesOf(email).retry.checks!['auth.vendor.test'].verdict, 'pass');
  await site('lists');
  blockFailure = true;
  assert.match((await checkWebsite(email, 'lists', trace('cdn.company.test')) as { error: string }).error, /blocklists not loaded yet/);
  assert.equal(websitesOf(email).lists.checks?.['cdn.company.test'], undefined);
  blockFailure = false;
  await checkWebsite(email, 'lists', trace('cdn.company.test'));
  assert.equal(websitesOf(email).lists.checks!['cdn.company.test'].verdict, 'pass');
});

test('search is capped at five upstream calls; incomplete model host verdicts remain unchecked', async () => {
  await site('quota');
  mode = 'limit';
  assert.ok('error' in await checkWebsite(email, 'quota', trace('auth.vendor.test')));
  assert.equal(searches.length, 5);
  assert.equal(websitesOf(email).quota.checks!['auth.vendor.test'], undefined);
  await site('budget');
  mode = 'five';
  const before = searches.length;
  assert.deepEqual(await checkWebsite(email, 'budget', trace('auth.vendor.test')), profile);
  assert.equal(searches.length - before, 5);
  assert.equal(models.at(-1).tool_choice, 'none');
  assert.equal(models.at(-1).messages.filter((m: any) => m.role === 'tool').length, 5);
  await site('partial');
  mode = 'partial';
  assert.ok('error' in await checkWebsite(email, 'partial', trace('later.vendor.test')));
  assert.equal(websitesOf(email).partial.checks!['later.vendor.test'], undefined);
  mode = 'normal';
  await checkWebsite(email, 'partial', trace('later.vendor.test'));
  assert.equal(websitesOf(email).partial.checks!['later.vendor.test'].verdict, 'pass');
});

test('a saved sign-in records host-only kinds and trims cookies and origins to reached allowed hosts', async () => {
  await site('saved', { header: 'x-bot-token', keepalive: '/home', every: 8, writeback: false });
  log = [
    { method: 'GET', url: 'https://erp.company.test/private?code=do-not-log', status: 302, live: true, dest: 'document' },
    { method: 'GET', url: 'https://cdn.company.test/app.js?token=do-not-log', status: 200, dest: 'script', from: 'https://erp.company.test/private?code=do-not-log' },
    { method: 'POST', url: 'https://auth.vendor.test/sign-in?code=do-not-log', status: 200, dest: 'document', from: 'https://erp.company.test/private?code=do-not-log' },
    { method: 'GET', url: 'https://metrics.vendor.test/pixel', status: 200, dest: 'image', from: 'https://erp.company.test/private' },
  ];
  const cookies = ['erp.company.test', '.company.test', 'cdn.company.test', 'auth.vendor.test', 'metrics.vendor.test', 'unreached.company.test'].map(domain => ({ name: domain, domain, value: 'private' }));
  const origins = ['erp.company.test', 'cdn.company.test', 'auth.vendor.test', 'metrics.vendor.test', 'unreached.company.test'].map(h => ({ origin: `https://${h}`, localStorage: [{ name: 'secret', value: 'private' }] }));
  state = { cookies, origins };
  const until = new Date(Date.now() + 60_000).toISOString(), id = await startSignIn(email, 'saved', 'header-secret');
  assert.deepEqual(openings.at(-1).site.headers, { 'x-bot-token': 'header-secret' });
  await endSignIn(email, id, true, until);
  const login = logins(email).find(l => l.id === 'web:saved')!;
  assert.equal(login.keepalive, until);
  assert.deepEqual(login.trace!.kinds!['cdn.company.test'], { dest: ['script'], from: ['erp.company.test'] });
  assert.equal(JSON.stringify(login.trace).includes('do-not-log'), false);
  assert.equal(models.at(-1).messages[1].content.includes('do-not-log'), false);
  const saved = JSON.parse(secret(email, 'web:saved'));
  assert.deepEqual(saved.cookies.map((c: any) => c.domain), ['erp.company.test', '.company.test', 'cdn.company.test', 'auth.vendor.test']);
  assert.deepEqual(saved.origins.map((o: any) => o.origin), ['https://erp.company.test', 'https://cdn.company.test', 'https://auth.vendor.test']);
  assert.equal(secret(email, 'web:saved.header'), 'header-secret');
  await setSite({ email, role: 'user' } as never, 'saved', { every: '9m' });
  assert.deepEqual(websitesOf(email).saved.profile, profile);
  assert.deepEqual([websitesOf(email).saved.writeback, websitesOf(email).saved.keepalive, websitesOf(email).saved.every], [false, '/home', 9]);
});

test('expired sign-ins cannot save, and every manual host allowance requires an admin', async () => {
  await site('expired');
  process.env.RF_SIGNIN_S = '0';
  log = [{ method: 'GET', url: 'https://erp.company.test/', status: 200, live: true }];
  const id = await startSignIn(email, 'expired', '');
  await assert.rejects(endSignIn(email, id, true), (e: any) => e.status === 410);
  assert.equal(isSignIn(email, id), false);
  assert.equal(logins(email).some(l => l.id === 'web:expired'), false);
  process.env.RF_SIGNIN_S = '600';
  state = null;
  const gone = await startSignIn(email, 'expired', '');
  await assert.rejects(endSignIn(email, gone, true), (e: any) => e.status === 410);
  assert.equal(logins(email).some(l => l.id === 'web:expired'), false);
  await assert.rejects(allowHost({ email, role: 'user' } as never, 'expired', 'cdn.company.test'), (e: any) => e.status === 403);
  await allowHost({ email: 'admin@company.test', role: 'admin' } as never, 'expired', '10.3.4.5', email);
  assert.equal(websitesOf(email).expired.checks!['10.3.4.5'].verdict, 'pass');
  assert.deepEqual(websitesOf(email).expired.hosts, ['10.3.4.5']);
});

test('a blocklisted starting host is not relisted implicitly for a restricted browser', async () => {
  await site('blocked-start');
  blocked.add('erp.company.test');
  await checkWebsite(email, 'blocked-start');
  assert.equal(websitesOf(email)['blocked-start'].checks!['erp.company.test'].verdict, 'refused');
  writeJson('users.json', { [email]: { role: 'admin', name: 'Alice' } });
  writeJson('grants.json', { approved: { person: email, site: 'blocked-start', workspace: 'workspace', state: 'approved' } });
  saveLogin(email, { id: 'web:blocked-start', kind: 'website', name: 'blocked-start', since: '', keepalive: '2030-01-01T00:00:00Z', offers: [{ id: 'web:blocked-start', name: 'blocked-start' }] }, JSON.stringify(state));
  await keepAlive(new Date('2027-01-01T00:00:00Z'));
  assert.deepEqual(openings.at(-1).site.hosts, []);
  writeJson('users.json', {});
});

test('new refusals narrow legacy wildcard hosts while retaining exact passed hosts', async () => {
  await site('legacy', { hosts: ['*.vendor.test'], checks: { 'auth.vendor.test': { verdict: 'pass', why: 'Its sign-on.' } } });
  await checkWebsite(email, 'legacy', trace('auth.vendor.test', 'metrics.vendor.test', 'static.vendor.test'));
  assert.deepEqual(websitesOf(email).legacy.hosts.sort(), ['auth.vendor.test', 'static.vendor.test']);
  assert.equal(websitesOf(email).legacy.checks!['metrics.vendor.test'].verdict, 'refused');
});

test('a concurrent admin verdict or personal removal wins over an in-flight model answer', async t => {
  await site('race');
  gate = new Promise<void>(ok => { release = ok; });
  const seen = new Promise<void>(ok => { modelSeen = ok; });
  t.after(() => release?.());
  const checking = checkWebsite(email, 'race', trace('auth.vendor.test', 'upload.vendor.test'));
  await seen;
  await allowHost({ email, role: 'admin' } as never, 'race', 'auth.vendor.test');
  await removeHost(email, 'race', 'auth.vendor.test');
  changeWebsite(email, 'race', { checks: { ...websitesOf(email).race.checks, 'upload.vendor.test': { verdict: 'high', why: 'An earlier check.' } } });
  release!();
  await checking;
  assert.deepEqual(websitesOf(email).race.hosts, []);
  assert.equal(websitesOf(email).race.checks!['auth.vendor.test'].verdict, 'refused');
  assert.equal(websitesOf(email).race.checks!['upload.vendor.test'].why, 'An earlier check.');
});

test('refused run checks share the checker and retry unchecked hosts on the following run', async () => {
  await site('run');
  saveLogin(email, { id: 'web:run', kind: 'website', name: 'run', since: '', offers: [{ id: 'web:run', name: 'run' }] }, '{}');
  const events: any[] = [], dir = join(root, 'run');
  mkdirSync(dir);
  const inst = { id: 'inst', dir, append: (by: string, op: string, more: object) => events.push({ by, op, ...more }) } as unknown as Instance;
  log = [{ method: 'GET', url: 'https://auth.vendor.test/private?code=do-not-log', status: 403, blocked: 'host not on the list', dest: 'document', from: 'https://erp.company.test/private' }];
  mode = 'fail';
  const first = new Browsers(inst, 1);
  first.bySite.set('run', { id: 'first', email, since: '', writeback: false, file: 'browser/first.jsonl', conns: 0 });
  await first.close();
  for (let i = 0; !websitesOf(email).run.profile; i++) { assert.ok(i < 100); await new Promise(ok => setTimeout(ok, 10)); }
  assert.ok('error' in websitesOf(email).run.profile!);
  assert.equal(websitesOf(email).run.checks!['auth.vendor.test'], undefined);
  mode = 'normal';
  const second = new Browsers(inst, 2);
  second.bySite.set('run', { id: 'second', email, since: '', writeback: false, file: 'browser/second.jsonl', conns: 0 });
  await second.close();
  for (let i = 0; !events.some(e => e.action === 'allowed'); i++) { assert.ok(i < 100); await new Promise(ok => setTimeout(ok, 10)); }
  assert.deepEqual(events.find(e => e.action === 'allowed').allowed, ['auth.vendor.test']);
  const input = JSON.parse(models.at(-1).messages[1].content);
  assert.deepEqual(input.evidence.kinds['auth.vendor.test'], { dest: ['document'], from: ['erp.company.test'] });
  assert.equal(JSON.stringify(input).includes('do-not-log'), false);
});
