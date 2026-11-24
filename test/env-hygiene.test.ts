import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore } from '../src/store.ts';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { startMessageStore } from '../src/message-store.ts';
import { authority, saveLogin } from '../src/logins.ts';
import { Browsers } from '../src/browsers.ts';
import { call, type CallRun } from '../src/connections.ts';
import { commitSubject } from '../src/waker.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rf-env-hygiene-'));
const ALICE = 'alice@demo.test';

initSystem(tmp);
openStore(tmp);
saveTree({ workspaces: { w: { name: 'Acme', owners: [ALICE], members: [] } }, series: {} });
writeJson('users.json', { [ALICE]: { role: 'admin' } });
writeJson('grants.json', {
  [`${ALICE} erp`]: { workspace: 'w', person: ALICE, site: 'erp', reason: 'tests', at: '', state: 'approved' },
});
writeJson('connections.json', {
  m365: { type: 'graph' },
  adb: { type: 'databricks' },
  drop: { type: 'service', url: 'http://127.0.0.1:1', paths: ['AP/'], key: '' },
});
process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
process.env.EXA_API_KEY = 'exa-test-key';

const makeInst = (label: string, logins: string[], n = 1) => {
  const sid = `s-${label}`;
  saveTree({ ...tree(), series: { ...tree().series, [sid]: { name: `Series ${label}`, workspace: 'w' } } });
  const dir = join(tmp, 'series', sid);
  startMessageStore(dir);
  const inst = createInstance(sid, label, ALICE);
  writeFileSync(join(dir, 'series.json'), JSON.stringify({
    version: 1, owner: ALICE, epoch: 1, since: '2026-11-24T00:00:00Z',
    consent: { by: ALICE, at: '2026-11-24T00:00:00Z', workspace: 'w', logins, autonomous: false },
  }));
  inst.append('server', 'run', { run: n, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  return inst;
};

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('E2: screen put treats null optional item fields as omitted without spurious item events while preserving file: null', () => {
  const inst = makeInst('e2', []);
  const put = (items: unknown[]) => inst.put(JSON.stringify({ ...inst.doc, items }), 1);

  put([{ id: 'process', name: 'Process', kind: 'step', file: null }]);
  const before = inst.log.filter(e => e.op === 'item').length;

  // Round-trip with null optional metadata fields (headline, source, destination, from)
  put([{ id: 'process', name: 'Process', kind: 'step', file: null, headline: null, source: null, destination: null, from: null }]);
  assert.equal(inst.log.filter(e => e.op === 'item').length, before, 'unchanged item with null optionals emits no spurious item entry');
  assert.deepEqual(inst.doc.items, [{ id: 'process', name: 'Process', kind: 'step', file: null }]);
  assert.equal('headline' in inst.doc.items[0], false);
  assert.equal('source' in inst.doc.items[0], false);
  assert.equal('destination' in inst.doc.items[0], false);
  assert.equal('from' in inst.doc.items[0], false);

  // Invalid non-null types are still rejected
  assert.throws(() => put([{ id: 'process', name: 'Process', kind: 'step', file: null, headline: 42 }]), /process: headline must be a string/);
  assert.throws(() => put([{ id: 'process', name: 'Process', kind: 'step', file: null, from: 'bad' }]), /process: from must be a list of item ids/);
});

test('E5/P14: browser lent() and expire() dedupe op:expired per (login, generation) per run, logging again after re-sign-in', async () => {
  const { personDir } = await import('../src/logins.ts');
  mkdirSync(personDir(ALICE), { recursive: true });
  writeFileSync(join(personDir(ALICE), 'websites.json'), JSON.stringify({
    erp: { url: 'https://erp.example.com', hosts: [], writeback: true },
  }));

  const gen1 = '2026-11-24T01:00:00Z';
  saveLogin(ALICE, { id: 'web:erp', kind: 'website', name: 'ERP', since: gen1, expired: true, offers: [{ id: 'web:erp', name: 'ERP' }] }, '{}');
  const inst = makeInst('e5-browser', ['web:erp']);
  const browsers = new Browsers(inst, 1);

  // Repeated probes against an already-expired login + explicit rf expired log only once
  await assert.rejects(() => browsers.lent('erp'), { status: 409 });
  await assert.rejects(() => browsers.lent('erp'), { status: 409 });
  await browsers.expire('erp');
  await assert.rejects(() => browsers.lent('erp'), { status: 409 });
  assert.equal(inst.log.filter(e => e.op === 'expired').length, 1);
  assert.deepEqual(
    inst.log.filter(e => e.op === 'expired').map(e => [e.run, e.login, e.name, e.runner]),
    [[1, 'web:erp', 'erp', ALICE]],
  );

  // Re-sign-in bumps login generation (since); a subsequent expiry logs a fresh expired entry
  const gen2 = '2026-11-24T02:00:00Z';
  saveLogin(ALICE, { id: 'web:erp', kind: 'website', name: 'ERP', since: gen2, expired: true, offers: [{ id: 'web:erp', name: 'ERP' }] }, '{}');
  await assert.rejects(() => browsers.lent('erp'), { status: 409 });
  await browsers.expire('erp');
  assert.equal(inst.log.filter(e => e.op === 'expired').length, 2);
});

test('E5/P14 + E9a: connections proxy dedupes op:expired per (login, generation) per run and returns structured JSON errors for JSON APIs', async () => {
  saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: ALICE, since: '2026-11-24T01:00:00Z', expired: true, offers: [{ id: 'm365:mail:alice@demo.test', name: 'Mail' }] }, 'rt1');
  saveLogin(ALICE, { id: 'adb', kind: 'databricks', name: 'Databricks adb', account: ALICE, since: '2026-11-24T01:00:00Z', offers: [{ id: 'adb:adb-1.azuredatabricks.net/wh1', name: 'Warehouse' }] }, 'dbx1');
  saveLogin(ALICE, { id: 'drop', kind: 'service', name: 'drop', since: '2026-11-24T01:00:00Z', offers: [{ id: 'drop:AP/', name: 'AP/' }] });

  const inst = makeInst('e5-e9-conn', ['m365:mail:alice@demo.test', 'adb:adb-1.azuredatabricks.net/wh1', 'drop:AP/']);
  const active: CallRun = { inst, n: 1, runner: ALICE, links: new Map(), cost: 0 };

  const proxy = createServer((req, res) => call(active, String(req.headers['x-test-host']), req, res)).listen(0);
  await once(proxy, 'listening');
  const port = (proxy.address() as { port: number }).port;
  const send = (host: string, path: string, method = 'GET', headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((ok, fail) => {
      const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'x-test-host': host, accept: '*/*', ...headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c)).on('end', () => ok({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      }).on('error', fail);
      r.end();
    });

  try {
    // 1. Expired Entra login (m365): JSON 409 + single expired log entry across repeated requests
    const r1 = await send('graph.microsoft.com', '/v1.0/me/messages');
    const r2 = await send('graph.microsoft.com', '/v1.0/me/messages');
    assert.equal(r1.status, 409, r1.text);
    assert.equal(r1.headers['content-type'], 'application/json; charset=utf-8');
    const body1 = JSON.parse(r1.text);
    assert.equal(body1.error.code, 'rf_proxy');
    assert.match(body1.error.message, /no current Microsoft 365 login/);
    assert.equal(r2.status, 409);
    assert.equal(inst.log.filter(e => e.op === 'expired' && e.login === 'm365').length, 1);

    // Re-sign-in with a new since + expire again logs a second expired entry
    saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: ALICE, since: '2026-11-24T02:00:00Z', expired: true, offers: [{ id: 'm365:mail:alice@demo.test', name: 'Mail' }] }, 'rt2');
    await send('graph.microsoft.com', '/v1.0/me/messages');
    assert.equal(inst.log.filter(e => e.op === 'expired' && e.login === 'm365').length, 2);

    // 2. Expired personal OpenRouter key: JSON 409 + deduped per run
    saveLogin(ALICE, { id: 'openrouter', kind: 'openrouter', name: 'OpenRouter', since: '2026-11-24T01:00:00Z', enabled: true, expired: true, offers: [] }, 'sk-or-mine');
    const or1 = await send('openrouter.ai', '/api/v1/chat/completions', 'POST', { 'content-type': 'application/json' });
    const or2 = await send('openrouter.ai', '/api/v1/chat/completions', 'POST', { 'content-type': 'application/json' });
    assert.equal(or1.status, 409);
    assert.equal(or1.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(JSON.parse(or1.text).error.code, 'rf_proxy');
    assert.equal(or2.status, 409);
    assert.equal(inst.log.filter(e => e.op === 'expired' && e.login === 'openrouter').length, 1);

    // 3. JSON API 403 refusals on Graph, Databricks, and Exa return structured JSON even with Accept: */*
    const graph403 = await send('graph.microsoft.com', '/v1.0/users/other@demo.test/messages');
    assert.equal(graph403.status, 403);
    assert.equal(graph403.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(JSON.parse(graph403.text).error.code, 'rf_proxy');

    const dbx403 = await send('adb-1.azuredatabricks.net', '/api/2.0/clusters/list');
    assert.equal(dbx403.status, 403);
    assert.equal(dbx403.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(JSON.parse(dbx403.text).error.code, 'rf_proxy');

    const exa403 = await send('api.exa.ai', '/search', 'TRACE');
    assert.equal(exa403.status, 403);
    assert.equal(exa403.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(JSON.parse(exa403.text).error.code, 'rf_proxy');

    // 4. Non-JSON service connection and unknown host keep text/plain
    const svc403 = await send('drop.rf.internal', '/AR/file.csv');
    assert.equal(svc403.status, 403);
    assert.equal(svc403.headers['content-type'], 'text/plain; charset=utf-8');

    const unknown403 = await send('unknown.example.test', '/data');
    assert.equal(unknown403.status, 403);
    assert.equal(unknown403.headers['content-type'], 'text/plain; charset=utf-8');
  } finally {
    proxy.close();
  }
});

test('E8: commitSubject preserves normal subjects and sanitizes URLs, tokens, newlines, and length on failed runs', () => {
  assert.equal(commitSubject(1), 'Run 1');
  assert.equal(commitSubject(1, 'a restart cut the run'), 'Run 1: a restart cut the run');
  assert.equal(commitSubject(4, '   \n  '), 'Run 4: failed');

  const raw402 = '402 This request requires more credits, or fewer max_tokens. Visit https://openrouter.ai/settings/keys?token=abc to add credits using Bearer sk-or-v1-1234567890abcdef.\nSecond line stack trace';
  const subj = commitSubject(10, raw402);
  assert.equal(subj.includes('\n'), false);
  assert.equal(subj.includes('https://'), false);
  assert.equal(subj.includes('openrouter.ai'), false);
  assert.equal(subj.includes('sk-or-v1-'), false);
  assert.ok(subj.length <= 120, `expected <= 120 chars, got ${subj.length}: ${subj}`);
  assert.match(subj, /^Run 10: 402 /);

  const secretErr = 'upstream failed with api_key=supersecretvalue and sk-ant-api03-secretvalue123456';
  const cleanSecret = commitSubject(3, secretErr);
  assert.equal(cleanSecret.includes('supersecretvalue'), false);
  assert.equal(cleanSecret.includes('secretvalue123456'), false);
  assert.match(cleanSecret, /\[redacted\]/);
});

test('E3: rf wakes gives a single-line hint instead of dumping full usage', async () => {
  const rfPath = join(import.meta.dirname, '..', 'src', 'rf.ts');
  const runRf = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((ok, fail) => {
    const p = spawn(process.execPath, [rfPath, ...args], { env: { ...process.env, RF_URL: 'http://127.0.0.1:1', RF_TOKEN: 't' } });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    p.on('error', fail).on('close', code => ok({ code: code ?? 1, stdout, stderr }));
  });

  const wakes = await runRf(['wakes']);
  assert.equal(wakes.code, 1);
  assert.equal(wakes.stdout, '');
  assert.equal(wakes.stderr.trimEnd().split('\n').length, 1);
  assert.match(wakes.stderr, /Pending wakes are listed in your first message; use rf wake TARGET AT \.\.\. or rf wake --cancel ID/);

  const helpWakes = await runRf(['help', 'wakes']);
  assert.equal(helpWakes.code, 0);
  assert.equal(helpWakes.stdout, wakes.stderr);
  assert.equal(helpWakes.stderr, '');
});

test('prompt.md states fresh bash CWD, working/ ownership split, background process lifetime, and process.md hygiene', () => {
  const prompt = readFileSync(join(import.meta.dirname, '..', 'prompt.md'), 'utf8');
  assert.match(prompt, /each bash call starts fresh there/);
  assert.match(prompt, /People own the outcomes, outputs and approvals; you own `working\/`/);
  assert.match(prompt, /leaving screen outputs and proposed or signed-off files intact/);
  assert.match(prompt, /background processes end with the run/);
  assert.match(prompt, /keep run logs and scratch notes in separate files under `working\/`/);
  assert.match(prompt, /the logins your series owner delegates to you/);
  assert.doesNotMatch(prompt, /\b(lend\w*|lent)\b/i);
});

test('v0.8.11: user-, agent-, CLI-, and doc-facing text uses delegate/delegated rather than lend/lent', () => {
  const root = join(import.meta.dirname, '..');
  for (const rel of ['prompt.md', 'docs/system.md', 'README.md', 'src/rf-people.ts', 'web/index.html']) {
    assert.doesNotMatch(readFileSync(join(root, rel), 'utf8'), /\b(lend\w*|lent)\b/i, `${rel} must not use lend/lent wording`);
  }
  assert.match(readFileSync(join(root, 'src/browsers.ts'), 'utf8'), /Check a website whose login may be delegated to automated company work\./);
  assert.match(readFileSync(join(root, 'src/waker.ts'), 'utf8'), /who delegates \$\{ticked\.map\(delegated\)\.join\(', '\) \|\| 'no login'\} to you\./);
});
