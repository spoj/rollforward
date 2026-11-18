import { test } from 'node:test';
import { migrateFixtureMessages, readFixtureTree, writeLegacyFixtureTree } from './owner-fixture.ts';
import { eventsFile } from '../src/message-store.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keyStatus, resetKeyCache, upstreams } from '../src/connections.ts';
import { idp } from './idp.ts';

test('key polling strips label and secret fields, coalesces requests and bounds stalled bodies while keeping its last safe value', { timeout: 8000 }, async () => {
  const secret = 'sk-or-private-key', label = 'sk-or-prefix...suffix';
  let mode = 'valid', queries = 0;
  const server = createServer((req, res) => {
    queries++;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'stall') return void res.write('{"data":');
    if (mode === 'malformed') return void res.end('{"data":');
    res.end(JSON.stringify({ data: { label, key: secret, usage: 99, usage_daily: 2, limit: 100, limit_remaining: 1, limit_reset: 'monthly' } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, RF_KEY_TTL_MS: process.env.RF_KEY_TTL_MS };
  const upstream = upstreams['openrouter.ai'];
  process.env.OPENROUTER_API_KEY = secret;
  process.env.RF_KEY_TTL_MS = '0';
  upstreams['openrouter.ai'] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetKeyCache();
  try {
    const safe = await keyStatus();
    assert.equal(safe!.usage, 99);
    assert.equal(safe!.low_credit, true);
    assert.doesNotMatch(JSON.stringify(safe), /sk-or-/);
    mode = 'malformed';
    assert.deepEqual(await keyStatus(), safe);
    mode = 'stall';
    const start = Date.now(), before = queries;
    const result = await Promise.all(Array.from({ length: 5 }, () => keyStatus()));
    assert.ok(Date.now() - start < 6500);
    assert.equal(queries - before, 1);
    for (const k of result) assert.deepEqual(k, safe);
  } finally {
    resetKeyCache();
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
    if (upstream === undefined) delete upstreams['openrouter.ai']; else upstreams['openrouter.ai'] = upstream;
    server.close();
    server.closeAllConnections();
  }
});

test('deleting instances preserves daily run key provenance and UTC shared-key OpenRouter reconciliation while marking older attributionless tombstones estimated', { timeout: 25_000 }, async () => {
  const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-cost-del-')), root = join(tmp, 'data'), admin = 'admin@demo.test';
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const at = `${today}T01:00:00Z`;
  cpSync(join(app, 'test/fixture'), root, { recursive: true });
  const t = readFixtureTree(root);
  t.workspaces.r4ws = { name: 'Costs', owners: [admin], members: [] };
  t.series.r4ser = { name: 'Legacy', workspace: 'r4ws' };
  writeLegacyFixtureTree(root, t);
  mkdirSync(join(root, 'series/r4ser'), { recursive: true });
  for (const sid of Object.keys(t.series)) {
    writeFileSync(join(root, 'series', sid, 'series.json'), JSON.stringify({ version: 1, epoch: 0, since: '' }));
  }

  writeFileSync(join(root, 'series/r4ser/series.json'), JSON.stringify({ version: 1, owner: admin, epoch: 1, since: at, consent: { by: admin, at, workspace: 'r4ws', logins: [], autonomous: false } }));

  const writeInst = (id: string, entries: Record<string, unknown>[]) => {
    const dir = join(root, 'instances', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ label: id, series: 'r4ser' }));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status: 'closed', items: [] }));
    writeFileSync(join(dir, 'log.jsonl'), entries.map((e, i) => JSON.stringify({ seq: i + 1, ...e }) + '\n').join(''));
  };

  writeInst('legacytiny', [
    { at: `${yesterday}T23:58:00Z`, by: admin, op: 'create', logins: [] },
    { at: `${yesterday}T23:59:00Z`, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'shared' },
    { at: `${yesterday}T23:59:10Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.0000014 },
    { at: `${yesterday}T23:59:20Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.0000014 },
    { at: `${today}T00:00:10Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.0000014 },
    { at: `${today}T00:00:20Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.0000014 },
    { at: `${today}T00:00:30Z`, by: 'server', op: 'done', run: 1, cost: 0.000006, aborted: false, seen: 1 },
    { at: `${today}T00:00:40Z`, by: admin, op: 'close' },
  ]);
  writeInst('legacyown', [
    { at, by: admin, op: 'create', logins: [] },
    { at, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'own' },
    { at, by: 'agent', op: 'call', run: 1, name: 'openrouter', path: '/api/v1/messages', cost: 0.8 },
    { at, by: 'agent', op: 'call', run: 1, name: 'exa', path: '/search', cost: 0.05 },
    { at, by: 'server', op: 'done', run: 1, cost: 0.85, aborted: false, seen: 1 },
    { at, by: admin, op: 'close' },
  ]);
  writeInst('legacyshared', [
    { at, by: admin, op: 'create', logins: [] },
    { at, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'shared' },
    { at, by: 'agent', op: 'call', run: 1, name: 'openrouter', path: '/api/v1/messages', cost: 0.4 },
    { at, by: 'agent', op: 'call', run: 1, name: 'exa', path: '/search', cost: 0.1 },
    { at, by: 'server', op: 'done', run: 1, cost: 0.5, aborted: false, seen: 1 },
    { at, by: admin, op: 'close' },
  ]);
  writeInst('legacymidnight', [
    { at: `${yesterday}T23:58:00Z`, by: admin, op: 'create', logins: [] },
    { at: `${yesterday}T23:59:00Z`, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'shared' },
    { at: `${yesterday}T23:59:30Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.05 },
    { at: `${today}T00:00:30Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.15 },
    { at: `${today}T00:01:00Z`, by: 'agent', op: 'call', run: 1, name: 'exa', cost: 0.02 },
    { at: `${today}T00:01:30Z`, by: 'server', op: 'done', run: 1, cost: 0.22, aborted: false, seen: 1 },
    { at: `${today}T00:02:00Z`, by: admin, op: 'close' },
  ]);
  writeInst('legacyexaonly', [
    { at, by: admin, op: 'create', logins: [] },
    { at, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'shared' },
    { at, by: 'agent', op: 'call', run: 1, name: 'exa', path: '/search', cost: 0.07 },
    { at, by: 'server', op: 'done', run: 1, cost: 0.07, aborted: false, seen: 1 },
    { at, by: admin, op: 'close' },
  ]);
  writeInst('ledgown', [
    { at, by: admin, op: 'create', logins: [] },
    { at, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'own' },
    { at, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.6 },
    { at, by: 'server', op: 'done', run: 1, cost: 0.6, aborted: false, seen: 1 },
    { at, by: admin, op: 'close' },
  ]);
  writeInst('ledgshared', [
    { at, by: admin, op: 'create', logins: [] },
    { at, by: 'server', op: 'run', run: 1, runner: admin, consent: 1, upto: 1, key: 'shared' },
    { at, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.3 },
    { at, by: 'server', op: 'done', run: 1, cost: 0.3, aborted: false, seen: 1 },
    { at, by: admin, op: 'close' },
  ]);
  writeFileSync(join(root, '.rf/costs.jsonl'), [
    { at, service: 'openrouter', inst: 'ledgown', run: 1, person: admin, cost: 0.6, own: true },
    { at, service: 'openrouter', inst: 'ledgshared', run: 1, person: admin, cost: 0.3 },
  ].map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  migrateFixtureMessages(root);

  const providers = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/key') res.end(JSON.stringify({ data: { usage: 0.850003, usage_daily: 0.850003, limit: 100, limit_remaining: 99.149997 } }));
    else if (req.url === '/sessions') res.end('[]');
    else res.end('{}');
  });
  await new Promise<void>(r => providers.listen(0, '127.0.0.1', r));
  const provUrl = `http://127.0.0.1:${(providers.address() as { port: number }).port}`;
  const entra = await idp();

  const startServer = async () => {
    const probe = createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise(r => probe.close(r));
    const base = `http://127.0.0.1:${port}`;
    const hook = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src/connections.ts')).href)}; upstreams['openrouter.ai'] = ${JSON.stringify(provUrl)};`;
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, join(app, 'src/server.ts'), root, String(port)], {
      env: { ...process.env, ...entra.env(base), RF_MIN_FREE_GB: '0', RF_ADMINS: admin, OPENROUTER_API_KEY: 'mock-only', RF_BROWSER_URL: provUrl, RF_BROWSER_KEY: 'mock-only', RF_SCRATCH: join(tmp, 'scratch') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { out += b; });
    await new Promise<void>((ok, fail) => {
      child.stdout.on('data', b => String(b).includes('rollforward on') && ok());
      child.once('exit', () => fail(new Error(out)));
    });
    const cookie = (await entra.signIn(base, admin)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
    return { child, base, cookie };
  };

  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    srv = await startServer();
    const getCosts = async () => (await fetch(`${srv!.base}/api/costs?tz=UTC`, { headers: { cookie: srv!.cookie } })).json();
    const before = await getCosts();
    // Shared OpenRouter today: 0.000003 (legacytiny: 2 * 0.0000014 summed before rounding) + 0.40 + 0.15 + 0.30 = 0.850003
    assert.equal(before.key.server_total, 0.850003);
    assert.equal(before.key.unattributed, 0);
    assert.equal(before.key.server_estimated, undefined);

    const ids = ['legacytiny', 'legacyown', 'legacyshared', 'legacymidnight', 'legacyexaonly', 'ledgown', 'ledgshared'];
    for (const id of ids) {
      const del = await fetch(`${srv.base}/api/instances/${id}/delete`, { method: 'POST', headers: { cookie: srv.cookie } });
      assert.equal(del.status, 200, id);
    }

    const tinyTombstone = JSON.parse(readFileSync(join(root, 'instances/legacytiny/log.jsonl'), 'utf8'));
    assert.deepEqual(tinyTombstone.runs[0].openrouterByDay, { [yesterday]: { cost: 0.000003 }, [today]: { cost: 0.000003 } });

    const after = await getCosts();
    assert.equal(after.key.server_total, 0.850003, 'deletion preserves exact shared OpenRouter reconciliation');
    assert.equal(after.key.unattributed, 0);
    assert.equal(after.key.server_estimated, undefined);

    // Daily rows preserve key ('own' | 'shared') for both unledgered and ledger-backed runs (R4-DATA-15 / R4-DATA-16).
    const todayRuns = after.days.find((d: any) => d.day === today).runs.filter((r: any) => r.series === 'Costs/Legacy');
    const byPath = Object.fromEntries(todayRuns.map((r: any) => [r.path.split('/').pop(), r]));
    assert.equal(byPath.legacyown.key, 'own');
    assert.equal(byPath.ledgown.key, 'own');
    assert.equal(byPath.legacyshared.key, 'shared');
    assert.equal(byPath.ledgshared.key, 'shared');
    assert.equal(byPath.legacyexaonly.key, 'shared');

    // GET /api/runs keeps public RunRow shape without leaking internal reconciliation fields, and tombstones drop call paths.
    const apiRuns = (await (await fetch(`${srv.base}/api/runs`, { headers: { cookie: srv.cookie } })).json()).filter((r: any) => r.path.startsWith('Costs/Legacy/'));
    assert.equal(apiRuns.length, 7);
    for (const r of apiRuns) {
      assert.equal(r.key, undefined);
      assert.equal(r.exaCost, undefined);
      assert.equal(r.openrouterByDay, undefined);
    }
    for (const id of ids) {
      const raw = readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8');
      assert.doesNotMatch(raw, /\/api\/v1\/messages|\/search/);
    }

    // Restart with an additional pre-existing v0.5.0 lossy tombstone (no key, no openrouterByDay): do not invent shared-key spend; mark server_estimated.
    srv.child.kill('SIGTERM');
    await once(srv.child, 'exit');
    srv = undefined;

    const holeDir = join(root, 'instances/oldhole');
    mkdirSync(holeDir, { recursive: true });
    writeFileSync(join(holeDir, 'instance.json'), JSON.stringify({ label: 'oldhole', series: 'r4ser' }));
    writeFileSync(join(holeDir, 'screen.json'), JSON.stringify({ rev: 2, status: 'deleted', items: [] }));
    const holeEvents = eventsFile(join(root, 'series/r4ser'), 'oldhole');
    mkdirSync(dirname(holeEvents), { recursive: true });
    writeFileSync(holeEvents, JSON.stringify({
      seq: 7, at, by: admin, op: 'delete', cost: 0.5,
      runs: [{ run: 1, at, outcome: 'done', failure: null, seconds: 5, cost: 0.5, runner: admin }],
    }) + '\n');

    srv = await startServer();
    const restarted = await getCosts();
    assert.equal(restarted.key.server_total, 0.850003, 'cold restart reads tombstones cleanly and does not invent shared-key spend from old lossy tombstones');
    assert.equal(restarted.key.server_estimated, true, 'ambiguous legacy tombstone on today UTC marks server_estimated');
  } finally {
    if (srv) { srv.child.kill('SIGTERM'); await once(srv.child, 'exit'); }
    providers.closeAllConnections();
    await new Promise(r => providers.close(r));
    entra.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
