import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as nap } from 'node:timers/promises';
import { idp } from './idp.ts';
import { writeFixtureTree } from './owner-fixture.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rf-wake-check-')), root = join(tmp, 'data');
const admin = 'admin@demo.test', bob = 'bob@demo.test';
const mailbox = { id: `m365:mail:${admin}`, name: 'Mailbox' }, revokeIndex = '/screen?revoke-index';
const cookies: Record<string, string> = {}, prompts: string[] = [];
let proc: ChildProcess, base: string, workspace: string, entra: Awaited<ReturnType<typeof idp>>;
let nextConfirmation: (() => Promise<void>) | undefined;
const model = createServer(async (req, res) => {
  if (req.method !== 'POST') return void res.end(JSON.stringify({ data: {} }));
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
  prompts.push(JSON.stringify(body.messages));
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Handled.' } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5, cost: 0.01 } });
  send('message_stop', {});
  res.end();
});

const call = (method: string, path: string, body?: unknown, who = admin) => fetch(base + path, { method, headers: { cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
let port = 0, preload = '';
async function startServer() {
  proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/server.ts', root, String(port)], {
    env: { ...process.env, ...entra.env(base), RF_ADMINS: admin, RF_MIN_FREE_GB: '0', RF_WAKE_TICK_MS: '100', RF_SCRATCH: join(tmp, 'scratch'), OPENROUTER_API_KEY: 'synthetic' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && resolve());
    proc.once('exit', code => reject(new Error(`server exited ${code}`)));
  });
}
async function json(path: string, method = 'GET', body?: unknown) {
  const res = await call(method, path, body);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const info = (iid: string) => json(`/api/instances/${iid}`);
async function until<T>(what: string, f: () => Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  do {
    const result = await f();
    if (result) return result;
    await nap(50);
  } while (Date.now() < end);
  throw new Error(`never saw ${what}`);
}

before(async () => {
  mkdirSync(join(root, '.rf'), { recursive: true });
  writeFixtureTree(root, { workspaces: {}, series: {} });
  await new Promise<void>(r => model.listen(0, '127.0.0.1', r));
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  entra = await idp(async () => {
    const wait = nextConfirmation;
    nextConfirmation = undefined;
    await wait?.();
  });
  preload = `
    import { subscribe } from 'node:diagnostics_channel';
    import { upstreams } from ${JSON.stringify(new URL('../src/connections.ts', import.meta.url).href)};
    import { changes } from ${JSON.stringify(new URL('../src/system.ts', import.meta.url).href)};
    upstreams['openrouter.ai'] = 'http://127.0.0.1:${(model.address() as { port: number }).port}';
    subscribe('http.server.response.finish', ({ request, response }) => {
      if (request.url.endsWith(${JSON.stringify(revokeIndex)}) && response.statusCode === 200)
        changes.emit('index-removed', ${JSON.stringify(admin)}, ${JSON.stringify(mailbox.id)});
    });
  `;
  await startServer();
  for (const who of [admin, bob]) cookies[who] = (await entra.signIn(base, who)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  workspace = (await json('/api/workspaces', 'POST', { name: 'Test' })).id;
  await call('PUT', `/api/workspaces/${workspace}`, { members: [bob] });
});

after(async () => {
  if (proc?.exitCode === null && proc.signalCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
  entra?.close();
  model.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function fixture(name: string, script: string, ext = 'py', label = '2026-11') {
  const { id: sid } = await json('/api/series', 'POST', { workspace, name, logins: [], autonomous: true });
  const { id: iid } = await json(`/api/series/${sid}`, 'POST', { label, quiet: true });
  const dir = join(root, 'instances', iid, 'working'), check = `working/check.${ext}`;
  writeFileSync(join(root, 'instances', iid, check), script);
  return { sid, iid, dir, check };
}

test('checks need an explicit grant and owner consent, cannot write, and dedupe identical stops', async () => {
  const { sid, iid, dir, check } = await fixture('Quiet', `
import errno, json, os, subprocess
from pathlib import Path
screen = json.loads(subprocess.check_output(['rf', 'show']))
assert screen['status'] == 'open'
for cmd in (['rf', 'comment', '.', 'should not get posted'], ['rf', 'wake', '.', 'now']):
    denied = subprocess.run(cmd, capture_output=True, text=True)
    assert denied.returncode != 0 and 'read-only' in denied.stderr
try:
    (Path(os.environ['RF_WORKING']) / 'should-not-exist').write_text('no')
except OSError as e:
    assert e.errno == errno.EROFS
else:
    raise AssertionError('working/ was writable')
print(json.dumps({'decision': 'stop', 'message': 'No invoices arrived'}))
`);
  const path = `/api/wakes/${iid}`;
  assert.equal((await call('PUT', path, { at: iso(1200), check })).status, 403, 'admin needs the grant too');
  await json('/capabilities', 'PUT', { cap: 'wake-check', people: [admin, bob] });
  assert.equal((await call('PUT', path, { at: iso(1200), check }, bob)).status, 403, 'a collaborator cannot attach executable work');
  assert.equal((await call('PUT', path, { at: 'now', check })).status, 403, 'the owner’s direct wake is not a scheduled wake');
  assert.equal((await call('PUT', path, { at: iso(1200), check: 'working/../bad.py' })).status, 400);
  assert.equal((await call('PUT', path, { at: iso(1200), check, deadline: iso(1000) })).status, 400);
  await json(path, 'PUT', { at: iso(1200), check });
  const first = await until('stop status', async () => (await info(iid)).wakeCheck);
  assert.equal(first.message, 'No invoices arrived');
  assert.equal(existsSync(join(dir, 'should-not-exist')), false);
  const prior = await info(iid);
  assert.deepEqual(prior.log.map(e => e.op), ['create', 'wake-check']);
  assert.deepEqual(prompts, []);
  // The series-target schedule names the very same instance but has its own spacing clock.
  await json(`/api/wakes/${sid}`, 'PUT', { at: iso(1200), label: '2026-11', check });
  await until('the repeat wake to finish', async () => (await json('/api'))[0].series.find(s => s.id === sid).wakes.length === 0);
  assert.deepEqual((await info(iid)).log, prior.log);
  const stopped = (await json('/api/runs')).filter(r => r.path === 'Test/Quiet/2026-11');
  assert.deepEqual(stopped.map(r => [r.run, r.outcome, r.cost, r.message]), [[null, 'wake-check-stop', 0, 'No invoices arrived']]);
});

test('one stopped one-off arms its deadline and continues without a second check', async () => {
  const { iid, check } = await fixture('Deadline', `print('{"decision":"stop","message":"Still waiting"}')\n`);
  const deadline = iso(6500);
  const { id } = await json(`/api/wakes/${iid}`, 'PUT', { at: iso(1200), check, deadline, text: 'Deadline escalation' });
  await until('stop before the deadline', async () => (await info(iid)).wakeCheck);
  const summary = await json(`/api/instances/${iid}/summary`);
  assert.deepEqual(summary.wakes.map(w => [w.id, w.at]), [[id, deadline]]);
  assert.equal(summary.wakeCheck.message, 'Still waiting');
  const done = await until('model run at deadline', async () => { const d = await info(iid); return d.log.some(e => e.op === 'done') && d; });
  assert.equal(done.wakeCheck, undefined);
  assert.equal(done.log.filter(e => e.op === 'wake-check').length, 1);
  assert.ok(prompts.some(p => p.includes('Deadline escalation')));
});

test('a stalled check confirmation cannot postpone the deadline', { timeout: 15_000 }, async () => {
  const { iid, check } = await fixture('Stalled', `print('{"decision":"stop","message":"Should not run"}')\n`);
  const started = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  nextConfirmation = () => { started.resolve(); return held.promise; };
  try {
    const deadline = iso(6500);
    await json(`/api/wakes/${iid}`, 'PUT', { at: iso(1200), check, deadline, text: 'Deadline with stalled confirmation' });
    await started.promise;
    const data = await until('fallback while confirmation is still held', async () => {
      const d = await info(iid);
      return d.log.some(e => e.op === 'done') && d;
    }, 8000);
    const e = data.log.find(e => e.op === 'wake');
    assert.ok(Date.now() >= Date.parse(deadline));
    assert.equal(e.text, 'Deadline with stalled confirmation');
    assert.ok(!e.note);
    assert.equal(data.wakeCheck, undefined);
  } finally {
    nextConfirmation = undefined;
    held.resolve();
  }
});

test('a weekly wake checks the new period using the prior closed script and keeps its weekly time after the backstop', async () => {
  const { iid, sid, check } = await fixture('Weekly', `print('{"decision":"stop","message":"Nothing this period"}')\n`, 'py', '2000-01-01');
  const close = await call('POST', `/api/instances/${iid}/close`, { quiet: true });
  assert.equal(close.status, 200, await close.text());
  const at = new Date(iso(1200)), deadline = iso(6500);
  const label = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][at.getDay()];
  await json(`/api/wakes/${sid}`, 'PUT', { at: at.toISOString(), days, check, deadline, label });
  const listing = async () => (await json('/api'))[0].series.find(s => s.id === sid);
  const target = await until('the new period to stop', async () => (await listing()).instances.find(i => i.label === label && i.wakeCheck));
  assert.equal(target.wakeCheck.message, 'Nothing this period');
  const next = new Date(at);
  next.setDate(at.getDate() + 7);
  assert.equal((await listing()).wakes[0].at, next.toISOString());
  await until('a run in the stopped period at the deadline', async () => (await info(target.id)).log.some(e => e.op === 'done'));
  assert.equal((await listing()).wakes[0].at, next.toISOString());
  assert.equal((await listing()).instances.length, 2);
});

test('M365 index revocation aborts a running check and opens Pi under the same wake authority', async () => {
  await json('/capabilities', 'PUT', { cap: 'wake-check', add: [admin] });
  const person = join(root, '.rf', 'people', createHash('sha256').update(admin).digest('hex').slice(0, 16));
  const cache = createHash('sha256').update(mailbox.id).digest('hex').slice(0, 16);
  const login = { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: iso(0), offers: [mailbox] };
  mkdirSync(join(person, 'index'), { recursive: true });
  writeFileSync(join(person, 'logins.json'), JSON.stringify([login]));
  const delta = 'synthetic-delta';
  writeFileSync(join(person, 'index', `${cache}.json`), JSON.stringify({
    person: admin, source: mailbox.id, name: mailbox.name, gen: 1, length: 0, lines: 0, base: 0,
    wakeGrant: JSON.stringify([login.since, null]),
    parts: { '': { link: delta, delta, as_of: login.since, due: Date.now() + 3_600_000, pages: 1, tries: 0, error: null } },
  }));
  // The notification leaves the cache valid, so a final snapshot recheck alone cannot pass this test.
  const { sid, iid, check } = await fixture('Revoked mailbox index', `
import json, os, time, urllib.request
from pathlib import Path
assert json.loads(Path(os.environ['RF_INDEX'], ${JSON.stringify(`${mailbox.name}.json`)}).read_text())['source'] == ${JSON.stringify(mailbox.id)}
print('{"decision":"stop","message":"Stale mailbox result"}', flush=True)
url = os.environ['RF_URL'] + '/api/instances/' + os.environ['RF_INSTANCE'] + ${JSON.stringify(revokeIndex)}
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['RF_TOKEN']})
urllib.request.urlopen(req).close()
time.sleep(30)  # The test waits only 15 seconds for Pi: the check must be interrupted.
`);
  const consent = await call('PUT', `/api/series/${sid}/credentials`, { logins: [mailbox.id], autonomous: true });
  assert.equal(consent.status, 200, await consent.text());
  const { authority } = await json(`/api/wakes/${iid}`, 'PUT', { at: iso(1200), check });
  const data = await until('Pi run after index revocation', async () => {
    const d = await info(iid);
    return (d.wakeCheck || d.log.some(e => e.op === 'done')) && d;
  });
  const failure = 'wake check failed: index snapshot changed';
  assert.ok(!data.log.some(e => e.op === 'wake-check'), 'the stale stop was not recorded');
  assert.equal(data.log.find(e => e.op === 'wake')?.text, failure);
  assert.deepEqual(data.log.find(e => e.op === 'run')?.authority, authority);
  assert.equal(data.log.find(e => e.op === 'done')?.aborted, false);
  assert.ok(prompts.some(p => p.includes(failure)));
});

test('continue, crash, malformed JSON and timeout all send their wake text to Pi', { timeout: 100_000 }, async () => {
  const cases = [
    ['Continue', 'console.log(JSON.stringify({decision: "continue", message: "New invoices found"}));', 'ts', 'New invoices found'],
    ['Crash', 'raise RuntimeError("private diagnostic must not be echoed")', 'py', 'wake check failed:'],
    ['BadJSON', 'print("{not JSON}")', 'py', 'wake check failed:'],
    ['Timeout', 'import time; time.sleep(120)', 'py', 'wake check failed: timed out'],
  ];
  await Promise.all(cases.map(async ([name, script, ext, expected]) => {
    const { iid, check } = await fixture(name, script + '\n', ext);
    await json(`/api/wakes/${iid}`, 'PUT', { at: iso(1200), check, text: 'Replaced wake text' });
    const data = await until(`${name} to fall through to Pi`, async () => { const d = await info(iid); return d.log.some(e => e.op === 'done') && d; }, 90_000);
    const e = data.log.find(e => e.op === 'wake');
    assert.ok(e?.text.startsWith(expected), JSON.stringify(data.log));
    assert.equal(data.standing[e.seq], 'note', 'only the wake’s authority starts the run; check text is context');
    assert.equal(data.log.find(e => e.op === 'done').aborted, false);
    assert.ok(prompts.some(p => p.includes(e.text) && !p.includes('Replaced wake text')));
    assert.ok(!e.text.includes('private diagnostic'));
  }));
});

test('stale M365 index forces Pi wake by default (150m), while --max-stale allows override, and flags are validated', async () => {
  await json('/capabilities', 'PUT', { cap: 'wake-check', add: [admin] });
  const person = join(root, '.rf', 'people', createHash('sha256').update(admin).digest('hex').slice(0, 16));
  const cache = createHash('sha256').update(mailbox.id).digest('hex').slice(0, 16);
  const login = { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: iso(0), offers: [mailbox] };
  mkdirSync(join(person, 'index'), { recursive: true });
  writeFileSync(join(person, 'logins.json'), JSON.stringify([login]));
  const delta = 'synthetic-delta', staleAsOf = new Date(Date.now() - 200 * 60_000).toISOString();
  writeFileSync(join(person, 'index', `${cache}.json`), JSON.stringify({
    person: admin, source: mailbox.id, name: mailbox.name, gen: 1, length: 0, lines: 0, base: 0,
    wakeGrant: JSON.stringify([login.since, null]),
    parts: { '': { link: delta, delta, as_of: staleAsOf, due: Date.now() + 3_600_000, pages: 1, tries: 0, error: null } },
  }));

  const { sid, iid, check } = await fixture('StaleIndex', `print('{"decision":"stop","message":"Should skip if fresh"}')\n`);
  assert.equal((await call('PUT', `/api/series/${sid}/credentials`, { logins: [mailbox.id], autonomous: true })).status, 200);

  // Validate maxStaleMin and backstopHours bounds & check requirement.
  assert.equal((await call('PUT', `/api/wakes/${iid}`, { at: iso(1200), maxStaleMin: 60 })).status, 400);
  assert.equal((await call('PUT', `/api/wakes/${iid}`, { at: iso(1200), check, maxStaleMin: 0 })).status, 400);
  assert.equal((await call('PUT', `/api/wakes/${iid}`, { at: iso(1200), check, maxStaleMin: 10_081 })).status, 400);
  assert.equal((await call('PUT', `/api/wakes/${iid}`, { at: iso(1200), backstopHours: 12 })).status, 400);
  assert.equal((await call('PUT', `/api/wakes/${iid}`, { at: iso(1200), check, backstopHours: 0 })).status, 400);
  assert.equal((await call('PUT', `/api/wakes/${iid}`, { at: iso(1200), check, backstopHours: 169 })).status, 400);

  // With maxStaleMin=240 override, the 200-minute-old cache is accepted and the check stops cleanly.
  const overridden = await json(`/api/wakes/${iid}`, 'PUT', { at: iso(1200), check, maxStaleMin: 240 });
  assert.equal(overridden.maxStaleMin, 240);
  const stopped = await until('stop with maxStaleMin=240', async () => (await info(iid)).wakeCheck);
  assert.equal(stopped.message, 'Should skip if fresh');
  assert.equal((await info(iid)).log.some((e: any) => e.op === 'done'), false);

  // Without override (default 150m), the 200-minute-old cache is stale and falls through to Pi.
  // Use the series-target schedule naming the same instance so it has its own spacing clock.
  const beforePrompts = prompts.length;
  await json(`/api/wakes/${sid}`, 'PUT', { at: iso(1200), label: '2026-11', check });
  const done = await until('Pi run on stale index', async () => {
    const d = await info(iid);
    return d.log.some((e: any) => e.op === 'done') && d;
  });
  const wake = done.log.find((e: any) => e.op === 'wake');
  assert.equal(wake.text, 'wake check failed: index cache is stale');
  const recentPrompt = prompts.slice(beforePrompts).join('\n');
  assert.ok(recentPrompt.includes('index cache is stale'), 'prompt carries stale failure reason');
  assert.ok(recentPrompt.includes('Should skip if fresh'), 'wake-check stop entry included in Pi prompt via told');
});

test('recurring wake tracks skip streak across restarts, enforces backstopHours without spamming log, and surfaces skip history in Pi prompt', { timeout: 30_000 }, async () => {
  const { iid, check } = await fixture('RecurringBackstop', `print('{"decision":"stop","message":"Still quiet"}')\n`);
  const at = new Date(iso(1200));
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][at.getDay()];
  const created = await json(`/api/wakes/${iid}`, 'PUT', { at: at.toISOString(), days, check, backstopHours: 2, text: 'Daily check' });
  assert.equal(created.backstopHours, 2);

  // Skip #1: records wake-check once and persists skipCount=1 in wakes.json.
  const wakesFile = join(root, '.rf', 'wakes.json');
  await until('first recurring skip', async () => {
    const w = JSON.parse(readFileSync(wakesFile, 'utf8'));
    return w.pending[created.id]?.skipCount === 1;
  });
  let d = await info(iid);
  assert.equal(d.log.filter((e: any) => e.op === 'wake-check').length, 1);
  assert.equal(d.log.some((e: any) => e.op === 'run'), false);

  // Trigger Skip #2 (same stop message): increments skipCount to 2 without adding a duplicate wake-check log row.
  const w1 = JSON.parse(readFileSync(wakesFile, 'utf8'));
  w1.pending[created.id].at = new Date(Date.now() - 1000).toISOString();
  delete w1.fired[iid];
  writeFileSync(wakesFile, JSON.stringify(w1, null, 1));
  await until('second recurring skip', async () => {
    const w = JSON.parse(readFileSync(wakesFile, 'utf8'));
    return w.pending[created.id]?.skipCount === 2;
  });
  d = await info(iid);
  assert.equal(d.log.filter((e: any) => e.op === 'wake-check').length, 1, 'identical stop does not spam log.jsonl');
  assert.equal(d.log.some((e: any) => e.op === 'run'), false);

  // Restart server and age skipSince past backstopHours (2h): persisted streak must survive restart and force a full Pi run.
  proc.kill('SIGTERM');
  await once(proc, 'exit');
  const w2 = JSON.parse(readFileSync(wakesFile, 'utf8'));
  assert.equal(w2.pending[created.id].skipCount, 2, 'skip streak persisted on disk before restart');
  w2.pending[created.id].skipSince = new Date(Date.now() - 3 * 3_600_000).toISOString();
  w2.pending[created.id].at = new Date(Date.now() - 1000).toISOString();
  delete w2.fired[iid];
  writeFileSync(wakesFile, JSON.stringify(w2, null, 1));

  const beforePrompts = prompts.length;
  await startServer();
  const done = await until('recurring backstop Pi run after restart', async () => {
    const cur = await info(iid);
    return cur.log.some((e: any) => e.op === 'done') && cur;
  });

  const wake = done.log.find((e: any) => e.op === 'wake');
  assert.match(wake.text, /^recurring wake-check backstop reached after 2h \/ 2 skipped checks: Daily check$/);
  assert.equal(wake.skippedChecks?.count, 2);
  assert.equal(wake.skippedChecks?.lastMessage, 'Still quiet');
  assert.ok(!wake.note, 'backstop wake carries owner wake standing');

  // Skip streak cleared on pending wake after Pi run.
  const wAfter = JSON.parse(readFileSync(wakesFile, 'utf8'));
  assert.equal(wAfter.pending[created.id].skipCount, undefined, 'skip streak cleared after backstop run');
  assert.equal(wAfter.pending[created.id].skipSince, undefined);

  // Prompt sent to Pi surfaces both the wake-check log entry and the concise skip-streak summary.
  const piPrompt = prompts.slice(beforePrompts).join('\n');
  assert.ok(piPrompt.includes('Skipped wake checks before this run: 2'), 'prompt shows skip-streak summary');
  assert.ok(piPrompt.includes('Still quiet'), 'prompt shows last skipped check message');
  assert.ok(piPrompt.includes('recurring wake-check backstop reached after 2h / 2 skipped checks'), 'prompt shows backstop reason');
  assert.ok(piPrompt.includes('backstop 2h'), 'Pending wakes prompt line shows backstop 2h');
});
