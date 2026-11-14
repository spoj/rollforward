import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { idp } from './idp.ts';

const execFileAsync = promisify(execFile);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-costs-')), root = join(tmp, 'data');
const adminEmail = 'admin@demo.test', bobEmail = 'bob@demo.test', secretKey = 'sk-or-server-secret-999', exaSecret = 'exa-server-secret-888';
const today = new Date().toISOString().slice(0, 10);

let entra: Awaited<ReturnType<typeof idp>>, proc: ChildProcess, browser: Browser, base = '';
let adminCookie = '', bobCookie = '', adminHome = '', bobHome = '';
let keyQueries = 0;
let keyPayload: Record<string, unknown> = {
  label: 'sk-or-v1-leaked...999',
  usage: 140.25,
  usage_daily: 0.95,
  limit: 200,
  limit_remaining: 59.75,
  limit_reset: 'monthly',
};

const providers = createHttpServer(async (req, res) => {
  const url = new URL(req.url!, 'http://providers');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/v1/key') {
    keyQueries++;
    if (req.headers.authorization !== `Bearer ${secretKey}`) return void res.writeHead(401).end('{}');
    return void res.end(JSON.stringify({ data: keyPayload }));
  }
  if (url.pathname === '/blocked') {
    return void res.end(JSON.stringify(Object.fromEntries(url.searchParams.getAll('host').map(h => [h, false]))));
  }
  if (req.method === 'GET' && url.pathname === '/sessions') {
    return void res.end('[]');
  }
  if (req.method === 'POST' && url.pathname === '/sessions') {
    return void res.writeHead(201).end(JSON.stringify({ id: 's1' }));
  }
  if (url.pathname === '/sessions/s1/page') {
    return void res.end(JSON.stringify({ url: 'https://portal.example.com/home', password: false }));
  }
  if (url.pathname.endsWith('/log')) {
    return void res.end(JSON.stringify([{ method: 'GET', url: 'https://auth.other-example.com/login', status: 200, dest: 'document', from: 'https://portal.example.com/', live: true }]));
  }
  if (req.method === 'DELETE' && url.pathname === '/sessions/s1') {
    return void res.end(JSON.stringify({
      state: { cookies: [], origins: [] },
      log: [{ method: 'GET', url: 'https://auth.other-example.com/login', status: 200, dest: 'document', from: 'https://portal.example.com/', live: true }],
    }));
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/sessions')) {
    return void res.end('{}');
  }
  if (url.pathname === '/search') {
    return void res.end(JSON.stringify({ results: [{ title: 'Portal', url: 'https://portal.example.com', highlights: ['Vendor portal'] }], costDollars: { total: 0.005 } }));
  }
  if (url.pathname === '/api/v1/chat/completions') {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    const hasTool = body.messages.some((m: any) => m.role === 'tool');
    if (!hasTool) {
      return void res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"query":"auth.other-example.com"}' } }] } }],
        usage: { cost: 0.02 },
      }));
    }
    return void res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ profile: { what: 'Vendor portal.', category: 'vendor', risk: 'low', flags: [] }, hosts: { 'auth.other-example.com': { verdict: 'pass', why: 'SSO host.' } } }) } }],
      usage: { cost: 0.03 },
    }));
  }
  res.writeHead(404).end('{}');
});

async function rfAs(home: string, ...args: string[]) {
  const { stdout } = await execFileAsync(process.execPath, [join(app, 'cli', 'rf.mjs'), ...args], {
    env: { ...process.env, HOME: home, TZ: 'UTC' },
  });
  return stdout;
}

const apiJson = async (path: string, cookie = adminCookie) => (await fetch(base + path, { headers: { cookie } })).json();

before(async () => {
  cpSync(join(app, 'test', 'fixture'), root, { recursive: true });

  // Seed an instance in a workspace shared with bob with today's runs:
  // - run 0: pre-change old done entry (estimated undefined) on an earlier day
  // - run 1: exact shared-key OpenRouter ($0.40) + Exa ($0.05) = $0.45 today
  // - run 2: partly-estimated shared-key OpenRouter ($0.25, estimated: true) today
  // - run 3: runner's own OpenRouter key ($0.80, key: 'own', estimated: false) today
  const treePath = join(root, '.rf', 'tree.json');
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));
  tree.workspaces.ops001 = { name: 'Ops', owners: [adminEmail], members: [bobEmail] };
  tree.series.ser001 = { name: 'Daily', workspace: 'ops001' };
  writeFileSync(treePath, JSON.stringify(tree, null, 1));
  mkdirSync(join(root, 'series', 'ser001'), { recursive: true });

  const instId = 'c05750000001', instDir = join(root, 'instances', instId);
  mkdirSync(join(instDir, 'upload'), { recursive: true });
  mkdirSync(join(instDir, 'working'), { recursive: true });
  writeFileSync(join(instDir, 'instance.json'), JSON.stringify({ label: today, series: 'ser001' }));
  writeFileSync(join(instDir, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));

  const t1 = `${today}T01:00:00.000Z`, t2 = `${today}T01:02:00.000Z`, t3 = `${today}T01:10:00.000Z`, t4 = `${today}T01:12:00.000Z`, t5 = `${today}T01:20:00.000Z`, t6 = `${today}T01:22:00.000Z`;
  const logEntries = [
    { seq: 1, at: '2026-08-20T10:00:00.000Z', by: adminEmail, op: 'create', logins: [] },
    { seq: 2, at: '2026-08-20T10:01:00.000Z', by: 'server', op: 'run', run: 0, runner: adminEmail, consent: 1, upto: 1, key: 'shared' },
    { seq: 3, at: '2026-08-20T10:03:00.000Z', by: 'server', op: 'done', run: 0, aborted: false, seen: 1, cost: 0.15 }, // old entry: no `estimated`
    { seq: 4, at: t1, by: 'server', op: 'run', run: 1, runner: adminEmail, consent: 1, upto: 1, key: 'shared' },
    { seq: 5, at: t1, by: 'agent', op: 'call', run: 1, name: 'openrouter', method: 'POST', path: '/api/v1/messages', status: 200, bytes: 100, model: 'anthropic/claude-opus-5.5', cost: 0.40 },
    { seq: 6, at: t1, by: 'agent', op: 'call', run: 1, name: 'exa', method: 'POST', path: '/search', status: 200, bytes: 80, cost: 0.05 },
    { seq: 7, at: t2, by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 0.45, estimated: false },
    { seq: 8, at: t3, by: adminEmail, op: 'assign', from: adminEmail, to: bobEmail },
    { seq: 9, at: t3, by: 'server', op: 'run', run: 2, runner: bobEmail, consent: 8, upto: 8, key: 'shared' },
    { seq: 10, at: t3, by: 'agent', op: 'call', run: 2, name: 'openrouter', method: 'POST', path: '/api/v1/messages', status: 200, bytes: 90, model: 'anthropic/claude-opus-5.5', cost: 0.25, estimated: true },
    { seq: 11, at: t4, by: 'server', op: 'done', run: 2, aborted: false, seen: 8, cost: 0.25, estimated: true },
    { seq: 12, at: t5, by: 'server', op: 'run', run: 3, runner: bobEmail, consent: 8, upto: 8, key: 'own' },
    { seq: 13, at: t6, by: 'server', op: 'done', run: 3, aborted: false, seen: 8, cost: 0.80, estimated: false },
  ];
  writeFileSync(join(instDir, 'log.jsonl'), logEntries.map(e => JSON.stringify(e) + '\n').join(''));

  const legacyDir = join(root, 'instances', 'c05750000002');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'instance.json'), JSON.stringify({ label: 'legacy-midnight', series: 'ser001' }));
  writeFileSync(join(legacyDir, 'screen.json'), JSON.stringify({ rev: 1, status: 'closed', items: [] }));
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const legacy = [
    { at: `${yesterday}T23:58:00Z`, by: adminEmail, op: 'create', logins: [] },
    { at: `${yesterday}T23:59:00Z`, by: 'server', op: 'run', run: 1, runner: adminEmail, consent: 1, upto: 1, key: 'shared' },
    { at: `${yesterday}T23:59:30Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.05 },
    { at: `${today}T00:00:30Z`, by: 'agent', op: 'call', run: 1, name: 'openrouter', cost: 0.15 },
    { at: `${today}T00:01:00Z`, by: 'agent', op: 'call', run: 1, name: 'exa', cost: 0.02 },
    { at: `${today}T00:01:30Z`, by: 'server', op: 'done', run: 1, cost: 0.22, aborted: false, seen: 1 },
  ];
  writeFileSync(join(legacyDir, 'log.jsonl'), legacy.map((e, i) => JSON.stringify({ seq: i + 1, ...e }) + '\n').join(''));

  const costRecords = [
    { at: t1, service: 'openrouter', inst: instId, run: 1, person: adminEmail, cost: 0.40 },
    { at: t1, service: 'exa', inst: instId, run: 1, person: adminEmail, cost: 0.05 },
    { at: t3, service: 'openrouter', inst: instId, run: 2, person: bobEmail, cost: 0.25, estimated: true },
    { at: t5, service: 'openrouter', inst: instId, run: 3, person: bobEmail, cost: 0.80, own: true },
  ];
  writeFileSync(join(root, '.rf', 'costs.jsonl'), costRecords.map(r => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });

  await new Promise<void>(ok => providers.listen(0, '127.0.0.1', ok));
  const provUrl = `http://127.0.0.1:${(providers.address() as { port: number }).port}`;
  const probe = createNetServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  base = `http://127.0.0.1:${port}`;
  entra = await idp();

  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = upstreams['api.exa.ai'] = ${JSON.stringify(provUrl)};`;
  proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(upstream)}`, join(app, 'src', 'server.ts'), root, String(port)], {
    env: {
      ...process.env,
      TZ: 'UTC',
      RF_MIN_FREE_GB: '0',
      RF_KEY_TTL_MS: '1200',
      RF_LOW_CREDIT_USD: '50',
      OPENROUTER_API_KEY: secretKey,
      EXA_API_KEY: exaSecret,
      RF_BROWSER_URL: provUrl,
      RF_BROWSER_KEY: 'browser-secret',
      ...entra.env(base),
      RF_ADMINS: adminEmail,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', c => fail(new Error(`server exited ${c}`)));
  });

  const signIn = async (email: string) => (await entra.signIn(base, email)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  adminCookie = await signIn(adminEmail);
  bobCookie = await signIn(bobEmail);

  adminHome = join(tmp, 'home-admin');
  bobHome = join(tmp, 'home-bob');
  for (const [home, cookie] of [[adminHome, adminCookie], [bobHome, bobCookie]] as const) {
    mkdirSync(join(home, '.config'), { recursive: true });
    const { token } = await (await fetch(`${base}/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'cli', days: 7 }) })).json();
    writeFileSync(join(home, '.config', 'rollforward.json'), JSON.stringify({ url: base, token }));
  }

  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  proc?.kill('SIGTERM');
  providers.close();
  entra?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('isLowCredit triggers below RF_LOW_CREDIT_USD or below 10% of limit, and ignores unlimited keys', async () => {
  const { isLowCredit } = await import('../src/connections.ts');
  const prev = process.env.RF_LOW_CREDIT_USD;
  delete process.env.RF_LOW_CREDIT_USD;
  try {
    assert.equal(isLowCredit(null, null), false, 'unlimited key is not low');
    assert.equal(isLowCredit(50, 200), false, 'at $50 and 25% is healthy');
    assert.equal(isLowCredit(49.99, 200), true, 'below default $50 is low');
    assert.equal(isLowCredit(95, 1000), true, 'below 10% of $1000 ($100) is low even above $50');
    assert.equal(isLowCredit(100, 1000), false, 'at 10% and >= $50 is healthy');
    process.env.RF_LOW_CREDIT_USD = '10';
    assert.equal(isLowCredit(15, 100), false, 'above custom $10 and above 10%');
    assert.equal(isLowCredit(9.5, 100), true, 'below custom $10 / 10%');
  } finally {
    if (prev === undefined) delete process.env.RF_LOW_CREDIT_USD; else process.env.RF_LOW_CREDIT_USD = prev;
  }
});

test('daily totals, live website-check attribution, cached /api/v1/key view, unattributed difference, estimated runs, and low-credit alerts', async () => {
  // 1. Trigger a real live website check as bob: 2 OpenRouter turns ($0.02 + $0.03 = $0.05) + 1 Exa search ($0.005) = $0.055.
  assert.equal((await fetch(`${base}/logins/sites`, {
    method: 'POST', headers: { cookie: bobCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'vendor-erp', url: 'https://portal.example.com/' }),
  })).status, 200);
  const { id: signinId } = await (await fetch(`${base}/logins/web/vendor-erp`, {
    method: 'POST', headers: { cookie: bobCookie, 'content-type': 'application/json' }, body: '{}',
  })).json();
  assert.equal((await fetch(`${base}/signins/${signinId}`, { method: 'POST', headers: { cookie: bobCookie, 'content-type': 'application/json' }, body: '{}' })).status, 200);

  // 2. Verify /api/v1/key caching: multiple admin requests within TTL make only one upstream key call.
  const q0 = keyQueries;
  const [me1, st1, adminCosts, st2] = await Promise.all([
    apiJson('/me'),
    apiJson('/api/status'),
    apiJson('/api/costs?tz=UTC'),
    apiJson('/api/status'),
  ]);
  assert.ok(keyQueries - q0 <= 1, 'cached /api/v1/key fetched at most once within TTL');
  assert.equal(me1.low_credit, undefined, '59.75 remaining of 200 is healthy');
  assert.equal(st1.low_credit, undefined);
  assert.equal(st2.low_credit, undefined);

  // 3. Verify today's daily total for admin: runs ($0.45 + $0.25 + $0.80 = $1.50) + server website-check ($0.055) = $1.555, marked estimated!
  const todayRow = adminCosts.days.find((d: any) => d.day === today)!;
  assert.ok(todayRow);
  assert.equal(todayRow.cost, 1.555);
  assert.equal(todayRow.runs_count, 3);
  assert.equal(todayRow.estimated, true);
  assert.deepEqual(todayRow.by_workspace.Ops, { runs: 3, cost: 1.5, estimated: true });
  assert.deepEqual(todayRow.by_person[adminEmail], { runs: 1, cost: 0.45 });
  assert.deepEqual(todayRow.by_person[bobEmail], { runs: 2, cost: 1.05, estimated: true });
  assert.deepEqual(todayRow.server, {
    cost: 0.055,
    items: [{ kind: 'website-check', site: 'vendor-erp', person: bobEmail, calls: 3, cost: 0.055 }],
  });

  // 4. Verify OpenRouter key comparison on today's UTC day:
  // Shared-key OpenRouter calls today include the legacy run's $0.15 after midnight, not its $0.05 yesterday or Exa.
  // $0.40 + $0.25 estimated + $0.05 website-check + $0.15 legacy = $0.85; own-key calls are excluded.
  assert.deepEqual(adminCosts.key, {
    usage: 140.25,
    usage_daily: 0.95,
    limit: 200,
    remaining: 59.75,
    reset: 'monthly',
    fetched_at: adminCosts.key.fetched_at,
    low_credit: false,
    day: today,
    server_total: 0.85,
    server_estimated: true,
    unattributed: 0.1,
  });

  // 5. Verify non-admin (bob) isolation: sees Ops runs, sees NO larkfield runs, NO server costs, and NO OpenRouter key data!
  const bobCosts = await apiJson('/api/costs?tz=UTC', bobCookie);
  assert.equal(bobCosts.key, undefined, 'non-admin never receives OpenRouter key view');
  assert.ok(bobCosts.days.every((d: any) => d.server === undefined && d.runs.every((r: any) => r.workspace === 'Ops')));
  const bobToday = bobCosts.days.find((d: any) => d.day === today)!;
  assert.equal(bobToday.cost, 1.5);

  // 6. Verify rf CLI outputs (rf costs, rf costs --daily, rf runs, rf show, rf status):
  const adminCliCosts = await rfAs(adminHome, 'costs', '--since', today);
  assert.match(adminCliCosts, /~\$1\.50\s+3 runs\s+~\$0\.50 a run\s+Ops\/Daily \(est\.\)/);
  assert.match(adminCliCosts, /\$0\.06\s+0 runs\s+- a run\s+server\/website-check\/vendor-erp/);
  assert.match(adminCliCosts, /OpenRouter key \(\d{4}-\d{2}-\d{2} UTC\): \$0\.95 today vs ~\$0\.85 \(est\.\) recorded \(\+\$0\.10 unattributed\) · \$140\.25 used · \$59\.75 of \$200\.00 remaining \(monthly\)/);

  const adminDaily = await rfAs(adminHome, 'costs', '--daily', '--since', today);
  assert.match(adminDaily, /server\s+\$0\.06\s+website-check: vendor-erp \(bob@demo\.test\)\s+3 calls/);

  const opsRuns = await rfAs(adminHome, 'runs', `Ops/Daily/${today}`);
  assert.match(opsRuns, /run 0\s+done\s+\d+[sm]\s+\$0\.15\s/); // old done entry
  assert.match(opsRuns, /run 1\s+done\s+\d+[sm]\s+\$0\.45\s/); // new exact done entry
  assert.match(opsRuns, /run 2\s+done\s+\d+[sm]\s+~\$0\.25 \(est\.\)\s/); // new estimated done entry

  const bobCliCosts = await rfAs(bobHome, 'costs', '--since', today);
  assert.doesNotMatch(bobCliCosts, /OpenRouter key|website-check|larkfield/);

  // 7. Transition to LOW CREDIT (10% rule: limit 1000, remaining 85 -> above $50 but below 10% = $100!) after TTL expires.
  keyPayload = {
    label: 'sk-or-v1-leaked...999',
    usage: 915,
    usage_daily: 0.95,
    limit: 1000,
    limit_remaining: 85,
    limit_reset: 'weekly',
  };
  await new Promise(ok => setTimeout(ok, 1350));

  const adminStatusText = await rfAs(adminHome, 'status');
  assert.match(adminStatusText, /^Low OpenRouter credit: \$85\.00 remaining of \$1000\.00 limit \(resets weekly\)/);
  const adminStatusJson = JSON.parse(await rfAs(adminHome, 'status', '--json'));
  assert.deepEqual(adminStatusJson.low_credit, { remaining: 85, limit: 1000, usage: 915, reset: 'weekly' });

  const bobStatusText = await rfAs(bobHome, 'status');
  assert.doesNotMatch(bobStatusText, /Low OpenRouter credit/);
  assert.equal(JSON.parse(await rfAs(bobHome, 'status', '--json')).low_credit, undefined);

  // 8. Verify web page for admin vs non-admin: low-credit line at top, Costs dialog, estimated run display, and zero key leaks!
  const adminCtx = await browser.newContext();
  const [cName, cVal] = adminCookie.split('=');
  await adminCtx.addCookies([{ name: cName, value: cVal, url: base }]);
  const adminPage = await adminCtx.newPage();
  await adminPage.goto(`${base}/#/c05750000001`);
  await adminPage.waitForSelector('#masthead #low-credit');
  assert.equal(await adminPage.textContent('#masthead #low-credit'), 'Low OpenRouter credit: $85.00 remaining of $1000.00 limit (resets weekly)');
  assert.equal(await adminPage.locator('#sidefoot [data-act=costs]').count(), 1);

  // Conversation shows exact vs estimated run costs clearly.
  const runLines = await adminPage.locator('#log .runl').allInnerTexts();
  assert.ok(runLines.some(t => t.includes('Run 1 · done') && t.includes('$0.45') && !t.includes('est.')));
  assert.ok(runLines.some(t => t.includes('Run 2 · done') && t.includes('~$0.25 (est.)')));

  // Clicking the low-credit banner opens the Admin Costs view with OpenRouter key, unattributed diff, and server website-check!
  await adminPage.click('#masthead #low-credit');
  await adminPage.waitForSelector('#pv[open]');
  const pvText = await adminPage.locator('#pv').innerText();
  assert.match(pvText, /OpenRouter key/);
  assert.match(pvText, /\$85\.00 remaining of \$1000\.00 limit \(resets weekly\)/);
  assert.match(pvText, /OpenRouter key: \$0\.95 · Server recorded on key: ~\$0\.85 \(est\.\) · Unattributed: \+\$0\.10/);
  assert.match(pvText, /Server · website-check: vendor-erp/);

  const pageHtml = await adminPage.content();
  for (const secret of [secretKey, exaSecret, 'sk-or-v1-leaked']) {
    assert.ok(!pageHtml.includes(secret), `page never exposes ${secret}`);
    assert.ok(!JSON.stringify({ adminCosts, adminStatusJson }).includes(secret), `API never exposes ${secret}`);
  }
  await adminCtx.close();

  const bobCtx = await browser.newContext();
  const [bName, bVal] = bobCookie.split('=');
  await bobCtx.addCookies([{ name: bName, value: bVal, url: base }]);
  const bobPage = await bobCtx.newPage();
  await bobPage.goto(`${base}/#/c05750000001`);
  await bobPage.waitForSelector('#sidefoot [data-act=logins]');
  assert.equal(await bobPage.locator('#masthead #low-credit').count(), 0, 'non-admin sees no low-credit banner');
  assert.equal(await bobPage.locator('#sidefoot [data-act=costs]').count(), 0, 'non-admin sees no admin Costs button');
  await bobCtx.close();
});

test('UTC key reconciliation includes only today’s legacy calls even when the run started yesterday', async () => {
  const report = await apiJson('/api/costs?tz=UTC');
  const records = readFileSync(join(root, '.rf', 'costs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const recorded = records.filter(e => e.at.startsWith(today) && e.service === 'openrouter' && !e.own).reduce((n, e) => n + e.cost, 0);
  assert.equal(report.key.server_total, +(recorded + 0.15).toFixed(6));
  assert.equal(report.key.unattributed, +(report.key.usage_daily - recorded - 0.15).toFixed(6));
});

test('cost totals support workspace names that collide with Object.prototype', async () => {
  const rename = (name: string) => fetch(`${base}/api/workspaces/ops001`, {
    method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  try {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      assert.equal((await rename(name)).status, 200);
      const report = await apiJson('/api/costs?tz=UTC');
      const d = report.days.find((d: any) => d.day === today);
      assert.deepEqual(d.by_workspace[name], { runs: 3, cost: 1.5, estimated: true });
      assert.deepEqual(d.by_person[adminEmail], { runs: 1, cost: 0.45 });
    }
  } finally {
    await rename('Ops');
  }
});
