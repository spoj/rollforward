import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Script, runInNewContext } from 'node:vm';

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
    : req.url === '/me' ? { email: colleague, can: ['series-owner'], role: 'user' }
    : req.url === '/logins' ? []
    : req.url === '/api/instances/i1' && req.method === 'GET' ? { doc: { status: 'open', items: [] }, log: [{ seq: 1, op: 'create', by: colleague }, { seq: 2, op: 'comment', by: colleague }], owner: { by: owner }, waiting: [], starts: false }
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
    s: { ...series, consent, logins: [] }, me: { email, can: ['series-owner'] }, cur: { w: { manage } }, pv: {},
    person: (x: string) => x, ticksHtml: (_: any, selected: string[]) => `SELECTED:${JSON.stringify(selected)}`,
  });
}

test('page script parses and removes live instance assignment, sharing and credential mutations', () => {
  new Script(code);
  assert.doesNotMatch(code, /data\??\.runner|i\.runner|data-act="(?:takeover|assign|share-on|share-off)"|instPath\(\)\}\/logins|\/assignees/);
  assert.match(code, /seriesPath\(cur\)\}\/credentials/);
  assert.match(code, /seriesPath\(cur\)\}\/owner/);
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
  assert.match(collaborator, /never start runs as the owner/);
  const manager = settings(colleague, true);
  assert.match(manager, /Transfer whole series/);
  assert.doesNotMatch(manager, /SELECTED:|data-act="series-credentials"/);
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

test('CLI old instance commands are not reinterpreted as whole-series authority', async () => {
  for (const args of [['takeover', 'Finance/Monthly/Jan'], ['assign', 'Finance/Monthly/Jan', owner], ['creds', 'Finance/Monthly/Jan', '--clear'], ['share', 'Finance/Monthly', 'on']]) {
    const r = await cli(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  }
});
