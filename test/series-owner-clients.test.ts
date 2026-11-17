import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as netServer } from 'node:net';
import { promisify } from 'node:util';
import { Script, runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import { idp } from './idp.ts';
import { writeFixtureTree } from './owner-fixture.ts';

const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const code = page.split('<script>')[1].split('</script>')[0];
const owner = 'owner@example.test', colleague = 'colleague@example.test';
const series = { id: 's1', name: 'Monthly', owner, epoch: 3, since: '2026-11-01', consent: null, requests: [], wakes: [], instances: [{ id: 'i1', label: 'Jan', status: 'open', owner, asks: [], wakes: [], refused: [] }] };
const calls: { path: string; method: string; body: any }[] = [];
const home = mkdtempSync(join(tmpdir(), 'rf-owner-clients-'));
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : undefined;
  calls.push({ path: req.url!, method: req.method!, body });
  res.setHeader('content-type', 'application/json');
  const value = req.url === '/api' ? [{ id: 'w1', name: 'Finance', series: [series] }]
    : req.url === '/me' ? { email: colleague, can: [], role: 'user' }
    : req.url === '/api/status' ? { ownership: [{ id: 's1', path: 'Finance/Monthly', text: 'Monthly has no owner' }], asks: [], requests: [], proposals: [], expired: [], running: [], queued: [], failed: [] }
    : req.url === '/api/indexes' ? []
    : req.url === '/logins' ? []
    : req.url === '/api/instances/i1' && req.method === 'GET' ? { doc: { status: 'open', items: [] }, log: [{ seq: 1, op: 'create', by: colleague }, { seq: 2, op: 'comment', by: colleague }], owner: { by: owner }, waiting: [], starts: false, standing: { 2: calls.some(c => c.path.endsWith('/comment') && c.body.thread === 'c1') ? 'answer' : 'note' } }
    : req.url === '/api/series' ? { instance: 'i1' } : { id: 'i1' };
  if (req.url?.endsWith('/comment')) res.setHeader('X-RF-Comment-Seq', '2');
  res.end(JSON.stringify(value));
});

before(async () => {
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  mkdirSync(join(home, '.config'));
  writeFileSync(join(home, '.config', 'rollforward.json'), JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'synthetic' }));
});
after(async () => {
  await new Promise<void>(ok => server.close(() => ok()));
  rmSync(home, { recursive: true });
});

async function cli(...args: string[]) {
  calls.length = 0;
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((ok, fail) => {
    const child = spawn(process.execPath, [new URL('../src/rf-people.ts', import.meta.url).pathname, ...args], { env: { ...process.env, HOME: home } });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x);
    child.stderr.on('data', x => stderr += x);
    child.on('error', fail).on('exit', status => ok({ status, stdout, stderr }));
  });
}

function settings(email: string, manage: boolean, consent: any = null) {
  const source = code.slice(code.indexOf('function startsHtml('), code.indexOf('// A series\' notes'));
  return runInNewContext(`${source}\nstartsHtml(s)`, {
    s: { ...series, consent, logins: [] }, me: { email, can: [] }, cur: { w: { manage } }, pv: {},
    ownershipHtml: () => '', person: (x: string) => x, ticksHtml: (_: any, selected: string[]) => `SELECTED:${JSON.stringify(selected)}`,
  });
}

test('page script parses and removes live instance assignment, sharing and credential mutations', () => {
  new Script(code);
  assert.doesNotMatch(code, /data\??\.runner|i\.runner|data-act="(?:takeover|assign|share-on|share-off)"|instPath\(\)\}\/logins|\/assignees/);
  assert.match(code, /seriesPath\(cur\)\}\/credentials/);
  assert.match(code, /path\}\/owner/);
  assert.doesNotMatch(code, /localStorage\.ticks/);
});

test('series selection is owner-only, explicit empty, series-wide and autonomous opt-in', () => {
  const html = settings(owner, false);
  assert.match(html, /Every instance may use/);
  assert.match(html, /SELECTED:\[\]/);
  assert.match(html, /Saving an empty selection explicitly/);
  assert.match(html, /data-act="series-credentials"/);
  assert.doesNotMatch(html, /id="autonomous" checked/);
  const selected = settings(owner, false, { logins: ['web:erp'], autonomous: true });
  assert.match(selected, /SELECTED:\["web:erp"\]/);
  assert.match(selected, /id="autonomous" checked/);
  const collaborator = settings(colleague, false);
  assert.doesNotMatch(collaborator, /SELECTED:|data-act="series-owner"|data-act="series-credentials"/);
  assert.match(collaborator, /answers to the agent's named asks start runs/);
  const manager = settings(colleague, true);
  assert.match(manager, /Transfer whole series/);
  assert.doesNotMatch(manager, /SELECTED:|data-act="series-credentials"/);
});

test('missing ownership names managers to viewers and opens transfer for managers', () => {
  const source = code.slice(code.indexOf('function ownershipHtml('), code.indexOf('// What waits on you:'));
  const html = (manage: boolean, owner: string | null = null, archived = false) => runInNewContext(`${source}\nownershipHtml(w, s)`, {
    w: { name: 'Finance', owners: ['Manager'], manage }, s: { id: 's2', name: 'Monthly', owner, ownerUnavailable: true }, archived: () => archived,
    person: (x: string) => x, esc: (x: string) => x,
  });
  assert.match(html(true), /Finance · Monthly has no owner.*data-act="series-owner" data-id="s2"/);
  assert.match(html(false), /Ask Manager to pick an owner/);
  assert.doesNotMatch(html(false), /data-act/);
  assert.match(html(true, owner), /can no longer run Monthly/);
  assert.equal(html(true, null, true), '');
});

test('Waiting transfers the named series rather than the currently open one', async () => {
  const source = code.slice(code.indexOf("  if (act === 'series-owner') {"), code.indexOf("  if (act === 'start-go') {"));
  const calls: string[] = [];
  let refreshed = false;
  await runInNewContext(`(async () => { ${source} })()`, {
    act: 'series-owner', el: { dataset: { id: 'unowned' } }, tree: [{ name: 'Other workspace', series: [{ id: 'unowned', name: 'Unowned' }] }],
    cur: { s: series }, pv: { settings: { kind: 'waiting' } }, me: { names: {} }, nameOf: (x: string) => x, esc: (x: string) => x,
    $: () => ({ value: owner }), refresh: async () => { refreshed = true; },
    api: async (path: string) => { calls.push(path); return [owner]; },
    ask: async (options: any) => { assert.equal(options.title, 'Transfer whole series: Other workspace · Unowned'); await options.act(); return true; },
  });
  assert.deepEqual(calls, ['/api/series/unowned/owners', '/api/series/unowned/owner']);
  assert.equal(refreshed, true);
});

test('CLI waiting and status list ownership work for managers', async () => {
  for (const command of ['waiting', 'status']) {
    const r = await cli(command);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Monthly has no owner/);
  }
});

test('wake editor explains recurring requests without owner autonomous authority', () => {
  const source = code.slice(code.indexOf('const WEEK ='), code.indexOf('// What this workspace\'s agents read'));
  const html = (email: string, autonomous: boolean, list: object[] = []) => runInNewContext(`${source}\nwakesHtml('s1', list, true)`, {
    cur: { s: { owner, consent: { autonomous } }, w: { manage: false } }, me: { email }, list,
    esc: (x: string) => x, localInput: (x: string) => x, when: (x: string) => x,
  });
  assert.match(html(owner, false), /Each occurrence asks the owner to start it/);
  assert.match(html(colleague, true), /Each occurrence asks the owner to start it/);
  assert.doesNotMatch(html(owner, true), /asks the owner/);
  assert.match(html(owner, true, [{ id: 'wake1', from: colleague }]), /Each occurrence asks the owner to start it/);
  assert.doesNotMatch(html(owner, true, [{ id: 'wake1', from: 'agent/path', initiator: owner }]), /asks the owner/);
});

test('website selection retains setup-only grant gating and no implicit grant request', () => {
  const source = code.slice(code.indexOf('function ticksHtml('), code.indexOf('const ticked ='));
  const html = runInNewContext(`${source}\nticksHtml(logins, ['web:erp'], w)`, {
    logins: [{ id: 'web:erp', kind: 'website', expired: false, offers: [{ id: 'web:erp', name: 'ERP' }] }],
    w: { id: 'w1', name: 'Finance', owners: [], grants: [] }, me: { email: owner },
    esc: (x: any) => String(x), nameOf: (x: string) => x,
  });
  assert.match(html, /disabled aria-describedby/);
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /data-act="website-setup" data-id="erp" data-ws="w1"/);
  assert.doesNotMatch(html, /data-act="grant-/);
  assert.match(code, /back\.settings, \{ label:.*on: ticked\(\), autonomous:/);
});

test('historical agent identity follows immutable run.runner, never current owner or creator', () => {
  const source = code.slice(code.indexOf('const called ='), code.indexOf('// An instance by its label now'));
  const html = runInNewContext(`${source}\nactor('agent', '2026-11-03', 1)`, {
    me: { email: owner, names: {} }, esc: (x: string) => x,
    data: { owner: { by: owner }, log: [
      { op: 'create', at: '2026-11-01', by: colleague },
      { op: 'run', at: '2026-11-02', run: 1, runner: 'old-owner@example.test' },
      { op: 'run', at: '2026-11-03', run: 2, runner: owner },
    ] },
  });
  assert.match(html, /old-owner@example.test/);
  assert.doesNotMatch(html, /Your agent|colleague/);
});

test('CLI transfer names the whole series endpoint and supplies no credential consent', async () => {
  const r = await cli('series', 'owner', 'Finance/Monthly', colleague);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.filter(c => c.method !== 'GET'), [{ path: '/api/series/s1/owner', method: 'PUT', body: { owner: colleague } }]);
  assert.match(r.stdout, /all instances change owner.*consent cleared/);
  const refused = await cli('series', 'owner', 'Finance/Monthly', colleague, '--clear');
  assert.equal(refused.status, 1);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
});

test('CLI credentials explicitly send [] and autonomous false, or exact selected offers and true', async () => {
  let r = await cli('series', 'credentials', 'Finance/Monthly', '--clear', '--autonomous', 'false');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.filter(c => c.method !== 'GET'), [{ path: '/api/series/s1/credentials', method: 'PUT', body: { logins: [], autonomous: false } }]);
  r = await cli('series', 'credentials', 'Finance/Monthly', '--set', 'web:erp,m365:mail:owner@example.test', '--autonomous', 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.at(-1)?.body, { logins: ['web:erp', 'm365:mail:owner@example.test'], autonomous: true });
  r = await cli('series', 'credentials', 'Finance/Monthly', '--clear');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--autonomous true\|false/);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
});

test('CLI later instance and request Start never send credentials', async () => {
  let r = await cli('new', 'instance', 'Finance/Monthly', 'Feb');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.find(c => c.method === 'POST')?.body, { label: 'Feb', quiet: true });
  assert.match(r.stdout, /owner@example.test starts its runs/);
  r = await cli('new', 'instance', 'Finance/Monthly', 'Feb', '--creds', 'web:erp');
  assert.equal(r.status, 1);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  r = await cli('request', 'start', 'request1', '--wake');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.find(c => c.method === 'POST'), { path: '/api/requests/request1', method: 'POST', body: { quiet: false } });
});

test('CLI task omission is not consent, explicit --clear is credentialless consent', async () => {
  let r = await cli('new', 'task', 'Finance');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.find(c => c.path === '/api/series')?.body, { workspace: 'w1', single: true });
  assert.match(r.stdout, /no execution consent/);
  r = await cli('new', 'task', 'Finance', '--clear');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls.find(c => c.path === '/api/series')?.body, { workspace: 'w1', single: true, logins: [], autonomous: false });
});

test('CLI live JSON exposes owner, and collaborator --wait does not wait for unauthorized execution', async () => {
  let r = await cli('ls', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[1].owner, owner);
  assert.doesNotMatch(r.stdout, /"runner"/);
  r = await cli('show', 'Finance/Monthly/Jan', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).owner, owner);
  r = await cli('comment', 'Finance/Monthly/Jan', 'Collaborator content', '--wait');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no run starts/);
});

test('CLI recognizes a named answer as a run trigger', async () => {
  const r = await cli('comment', 'Finance/Monthly/Jan', 'The new rate', '--thread', 'c1', '--wake');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /commented, seq 2/);
  assert.doesNotMatch(r.stdout, /no run starts/);
});

test('real owner clients preserve terminal history and task execution settings', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'rf-terminal-clients-')), root = join(tmp, 'data');
  const cases = ['closed-zero', 'closed-post', 'abandoned-zero', 'abandoned-post'];
  const at = '2026-11-01T00:00:00.000Z', bob = 'bob@example.test';
  mkdirSync(join(root, '.rf'), { recursive: true });
  writeFixtureTree(root, { workspaces: { w: { name: 'Finance', owners: [owner], members: [colleague, bob] } }, series: { s: { name: 'History', workspace: 'w' } } });
  mkdirSync(join(root, 'series', 's'), { recursive: true });
  writeFileSync(join(root, 'series', 's', 'series.json'), JSON.stringify({ version: 1, owner, epoch: 1, since: at, consent: { by: owner, at, workspace: 'w', logins: [], autonomous: true } }));
  for (const id of cases) {
    const dir = join(root, 'instances', id);
    mkdirSync(join(dir, 'working'), { recursive: true });
    mkdirSync(join(dir, 'upload'));
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ series: 's', label: id }));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
    const log: object[] = [{ by: colleague, op: 'create' }];
    if (id.endsWith('post')) log.push(
      { by: owner, op: 'comment', thread: 'c2', text: 'Read by the original run.', authorityOwner: owner, authorityEpoch: 1 },
      { by: 'server', op: 'run', run: 1, runner: owner, initiator: owner, upto: 2 },
      { by: 'server', op: 'done', run: 1, seen: 2, cost: 0.25 });
    log.push({ by: colleague, op: 'comment', thread: `c${log.length + 1}`, text: 'Persisted legacy note; recipient unknown.', note: true });
    for (let n = 0; n < 4; n++) log.push({ by: 'agent', op: 'comment', thread: `c${log.length + 1}`, text: `Proposal ${n}`, ask: 'proposal' });
    writeFileSync(join(dir, 'log.jsonl'), log.map((e, n) => JSON.stringify({ seq: n + 1, at, ...e }) + '\n').join(''));
  }
  const probe = netServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(ok => probe.close(() => ok()));
  const base = `http://127.0.0.1:${port}`, entra = await idp();
  const proc = spawn(process.execPath, ['src/server.ts', root, String(port)], {
    env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8', ...entra.env(base), RF_ADMINS: owner, RF_MAX_RUNS: '0', RF_MIN_FREE_GB: '0', RF_SCRATCH: join(tmp, 'scratch') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => errors += d);
  const cookies: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown, who = owner) => {
    const res = await fetch(base + path, { method, headers: { cookie: cookies[who] }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    assert.equal(res.status, 200, await res.clone().text());
    return res;
  };
  const browser = await chromium.launch();
  try {
    await new Promise<void>((ok, fail) => {
      proc.stdout.on('data', d => String(d).includes('rollforward on') && ok());
      proc.once('exit', status => fail(new Error(`server exited ${status}: ${errors}`)));
    });
    for (const who of [owner, colleague, bob]) {
      const res = await entra.signIn(base, who);
      cookies[who] = res.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
    }
    const token = (await (await api('POST', '/tokens', { name: 'history', days: 1 })).json()).token;
    mkdirSync(join(tmp, '.config'));
    writeFileSync(join(tmp, '.config', 'rollforward.json'), JSON.stringify({ url: base, token }));
    for (const id of cases) {
      const detail = await (await api('GET', `/api/instances/${id}`)).json();
      const asks = detail.log.filter(e => e.ask);
      for (const [n, who] of [owner, colleague].entries()) {
        await api('POST', `/api/instances/${id}/comment`, { text: `Post-run information from ${who}`, quiet: true }, who);
        const upload = await fetch(`${base}/api/instances/${id}/upload?quiet&name=${n}.txt`, { method: 'POST', headers: { cookie: cookies[who] }, body: 'fixture' });
        assert.equal(upload.status, 200, await upload.text());
        for (const [k, action] of ['signoff', 'reject'].entries()) await api('POST', `/api/instances/${id}/${action}`, { thread: `c${asks[n * 2 + k].seq}`, quiet: true }, who);
      }
      await api('POST', `/api/instances/${id}/${id.startsWith('closed') ? 'close' : 'abandon'}`, { quiet: true });
    }
    const context = await browser.newContext();
    const [name, value] = cookies[owner].split('=');
    await context.addCookies([{ name, value, url: base }]);
    const page = await context.newPage();
    const snapshot = async () => {
      const result = {};
      for (const id of cases) {
        const detail = await (await api('GET', `/api/instances/${id}`)).json();
        assert.equal(detail.starts, false);
        assert.equal(detail.queued, false);
        assert.equal(detail.run, null);
        const disk = readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8');
        const cli = await promisify(execFile)(process.execPath, ['src/rf-people.ts', 'log', `Finance/History/${id}`, '--json'], { env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8' } });
        await page.goto(`${base}/#/${id}`);
        await page.waitForFunction(id => cur.i?.id === id && data?.doc.status !== 'open', id);
        await page.locator('#lh').getByRole('button', { name: 'Conversation', exact: true }).click();
        await page.waitForSelector('#conv .post');
        const conversation = await page.locator('#conv').innerText();
        await page.click('#lh [data-act=audit]');
        await page.waitForSelector('#audit .e');
        result[id] = { disk, log: detail.log, standing: detail.standing, cli: cli.stdout, conversation, audit: await page.locator('#audit').innerText() };
      }
      return result;
    };
    const before = await snapshot(), snapshots = [];
    await api('PUT', '/api/series/s/credentials', { logins: [], autonomous: false });
    snapshots.push(await snapshot());
    await api('PUT', '/api/series/s/owner', { owner: bob });
    snapshots.push(await snapshot());
    await api('PUT', '/api/series/s/credentials', { logins: [], autonomous: true }, bob);
    await api('PUT', '/api/series/s/credentials', { logins: [], autonomous: false }, bob);
    snapshots.push(await snapshot());
    for (const after of snapshots) assert.deepEqual(after, before);
    for (const record of Object.values(before) as any[]) {
      assert.deepEqual(record.log, record.disk.trim().split('\n').map(JSON.parse));
      assert.deepEqual(record.cli.trim().split('\n').map(JSON.parse), record.log);
      assert.deepEqual(record.standing, Object.fromEntries(record.log.filter(e => e.note).map(e => [e.seq, 'note'])));
      assert.match(record.conversation, /a note/);
      assert.match(record.audit, /left a note/);
      assert.doesNotMatch(record.conversation + record.audit, /a note for/);
    }
    await t.test('one-off task settings and credentials keep canonical owner/consent without series-only controls', async () => {
      const task = await (await api('POST', '/api/series', { workspace: 'w', single: true, logins: [], autonomous: false })).json();
      const stored = () => JSON.parse(readFileSync(join(root, 'series', task.id, 'series.json'), 'utf8'));
      const failures: string[] = [];
      page.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });
      await page.goto(`${base}/#/${task.instance}`);
      await page.waitForFunction(id => cur.i?.id === id, task.instance);
      assert.equal(await page.locator('#bar button[data-act=rename]').count(), 1);
      assert.equal(await page.locator('#bar [data-act=wakes]').count(), 1);
      for (const act of ['settings', 'ticks']) {
        await page.click(`#bar [data-act=${act}]`);
        await page.waitForSelector('#pv [data-act=series-credentials]');
        assert.equal(await page.locator('#pv #sname, #pv .wlabel, #pv [data-act=archive-series], #pv [data-act=wake-save]').count(), 0);
        assert.equal(await page.locator('#pv [data-act=series-owner]').count(), 1);
        assert.match(await page.locator('#pv').innerText(), /Every instance may use the selected credentials/);
        await page.click('#pv [data-act=unpv]');
      }
      await page.click('#bar [data-act=settings]');
      await page.check('#autonomous');
      await page.click('#pv [data-act=series-credentials]');
      await page.waitForSelector('#pv .saved:text-is("Saved")');
      assert.equal(stored().owner, owner);
      assert.deepEqual(stored().consent.logins, []);
      assert.equal(stored().consent.autonomous, true);
      await page.click('#pv [data-act=series-owner]');
      await page.selectOption('#ownerto', bob);
      await page.click('#ask [value=ok]');
      await page.waitForFunction(bob => cur.s.owner === bob && !cur.s.consent, bob);
      assert.equal(stored().owner, bob);
      assert.equal(stored().consent, undefined);
      await context.addCookies([{ name, value: cookies[bob].split('=')[1], url: base }]);
      await page.reload();
      await page.click('#bar [data-act=ticks]');
      await page.waitForSelector('#pv [data-act=series-credentials]');
      assert.equal(await page.locator('#pv #sname, #pv .wlabel, #pv [data-act=archive-series], #pv [data-act=wake-save]').count(), 0);
      assert.equal(await page.isChecked('#autonomous'), false);
      await page.click('#pv [data-act=series-credentials]');
      await page.waitForSelector('#pv .saved:text-is("Saved")');
      assert.equal(stored().consent.by, bob);
      assert.deepEqual(stored().consent.logins, []);
      assert.equal(stored().consent.autonomous, false);
      assert.equal((await (await api('GET', `/api/instances/${task.instance}`)).json()).log.some(e => e.op === 'run'), false);
      assert.deepEqual(failures, []);
    });
    await t.test('collaborator creation names the owner and Waiting clears when the owner opens it', async () => {
      const incoming = await (await api('POST', '/api/series', { workspace: 'w', name: 'Incoming' })).json();
      const { id } = await (await api('POST', `/api/series/${incoming.id}`, { label: 'Feb', quiet: true }, colleague)).json();
      await context.addCookies([{ name, value: cookies[colleague].split('=')[1], url: base }]);
      await page.goto(`${base}/#/${id}`);
      await page.waitForFunction(id => cur.i?.id === id, id);
      assert.match(await page.locator('#needs').innerText(), /owner@example.test starts this series' runs/);
      await context.addCookies([{ name, value: cookies[owner].split('=')[1], url: base }]);
      await page.goto(`${base}/#/${cases[0]}`);
      await page.waitForFunction(() => me.email === 'owner@example.test');
      await page.click('#tree [data-act=waiting]');
      await page.waitForSelector('#pv .wt');
      assert.match(await page.locator('#pv').innerText(), /colleague@example.test started Incoming · Feb/);
      await page.click(`#pv a[href="#/${id}"]`);
      await page.waitForFunction(id => cur.i?.id === id, id);
      assert.equal(await page.locator('#tree [data-act=waiting]').count(), 0);
      await page.goto(`${base}/#/${cases[0]}`);
      await page.waitForFunction(id => cur.i?.id === id, cases[0]);
      const later = await (await api('POST', `/api/series/${incoming.id}`, { label: 'Mar', quiet: true }, colleague)).json();
      await page.waitForSelector('#tree [data-act=waiting]');
      await page.click('#tree [data-act=waiting]');
      await page.waitForSelector(`#pv a[href="#/${later.id}"]`);
      const other = await context.newPage();
      await other.goto(`${base}/#/${later.id}`);
      await other.waitForFunction(id => cur.i?.id === id, later.id);
      await page.waitForSelector(`#pv a[href="#/${later.id}"]`, { state: 'detached' });
      await other.close();
    });
  } finally {
    await browser.close();
    if (proc.exitCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
    entra.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI old instance commands are not reinterpreted as whole-series authority', async () => {
  for (const args of [['takeover', 'Finance/Monthly/Jan'], ['assign', 'Finance/Monthly/Jan', owner], ['creds', 'Finance/Monthly/Jan', '--clear'], ['share', 'Finance/Monthly', 'on']]) {
    const r = await cli(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  }
});
