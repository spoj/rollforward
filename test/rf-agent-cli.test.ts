import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/rf.ts', import.meta.url));
const instance = 'own-instance';

async function fake(t: TestContext, replies: [number, string | object][] = []) {
  const calls: [string, string, unknown?][] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    calls.push(body ? [req.method!, req.url!, JSON.parse(body)] : [req.method!, req.url!]);
    if (req.headers.authorization !== 'Bearer test-run') return res.writeHead(401).end('bad test token');
    const [status, data] = replies[calls.length - 1] ?? [500, 'unexpected request'];
    res.writeHead(status).end(typeof data === 'string' ? data : JSON.stringify(data));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>(ok => server.close(() => ok())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (args: string[], stdin = '', own = instance) => new Promise<{ code: number; stdout: string; stderr: string }>((ok, fail) => {
    const child = execFile(process.execPath, [script, ...args], {
      env: { RF_URL: url, RF_TOKEN: 'test-run', RF_INSTANCE: own }, timeout: 5000,
    }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') fail(err);
      else ok({ code: err?.code ?? 0, stdout, stderr });
    });
    child.stdin!.end(stdin);
  });
  return { calls, run };
}

test('comment writes plain messages, questions and proposals to the same endpoint', async t => {
  const { calls, run } = await fake(t, [[200, 'said c7'], [200, 'asked c8, under c7'], [200, 'proposed c9']]);
  assert.deepEqual(await run(['comment', '.', 'Updated', 'the inputs.']), { code: 0, stdout: 'said c7\n', stderr: '' });
  const question = 'Use the revised inputs?\n[Inputs](working/inputs.csv)\n';
  assert.deepEqual(await run(['comment', '.', '--in', 'c7', '--ask', '--to', 'owner@example.test', '-'], question),
    { code: 0, stdout: 'asked c8, under c7\n', stderr: '' });
  assert.deepEqual(await run(['comment', '.', '--on', 'pack@Sheet1!C22@name', '--propose', '--for', 'n3', 'Use this value.']),
    { code: 0, stdout: 'proposed c9\n', stderr: '' });
  assert.deepEqual(calls, [
    ['POST', '/api/messages', { instance, text: 'Updated the inputs.' }],
    ['POST', '/api/messages', { instance, text: question, thread: 'c7', ask: 'question', to: 'owner@example.test' }],
    ['POST', '/api/messages', { instance, text: 'Use this value.', item: 'pack', ref: 'Sheet1!C22@name', ask: 'proposal', for: 'n3' }],
  ]);
});

test('comment resolves paths to either anchor and leaves request authority to the server', async t => {
  const { calls, run } = await fake(t, [
    [200, { kind: 'instance', id: 'sibling' }], [200, 'said c12'],
    [200, { kind: 'series', id: 'own-series' }], [200, 'noted n4'],
    [200, { kind: 'instance', id: instance }], [403, 'this run cannot request execution here'],
    [200, { kind: 'series', id: 'own-series' }],
  ]);
  assert.deepEqual(await run(['comment', '../Feb #2', '--on', 'pack', 'Use the new headers.']),
    { code: 0, stdout: 'said c12\n', stderr: '' });
  assert.deepEqual(await run(['comment', '..', '--request', 'For next month.']), { code: 0, stdout: 'noted n4\n', stderr: '' });
  assert.deepEqual(await run(['comment', '.', '--request', 'Refresh the pack.'], '', ''),
    { code: 1, stdout: '', stderr: 'this run cannot request execution here\n' });
  const ask = await run(['comment', '..', '--ask', 'Use the revised inputs?']);
  assert.equal(ask.code, 1);
  assert.match(ask.stderr, /Use an instance/);
  assert.deepEqual(calls, [
    ['GET', '/api/resolve?path=..%2FFeb%20%232'], ['POST', '/api/messages', { instance: 'sibling', item: 'pack', text: 'Use the new headers.' }],
    ['GET', '/api/resolve?path=..'], ['POST', '/api/messages', { series: 'own-series', request: true, text: 'For next month.' }],
    ['GET', '/api/resolve?path=.'], ['POST', '/api/messages', { instance, request: true, text: 'Refresh the pack.' }],
    ['GET', '/api/resolve?path=..'],
  ]);
});

test('settle sends both ID kinds with the run’s instance, not a resolved series', async t => {
  const { calls, run } = await fake(t, [[200, 'n4 taken'], [200, 'c7 set aside'], [200, 'withdrew c8']]);
  assert.deepEqual(await run(['settle', 'n4', 'taken', '--see', 'c10', '-'], 'In process.md.\n'),
    { code: 0, stdout: 'n4 taken\n', stderr: '' });
  assert.deepEqual(await run(['settle', 'c7', 'aside', 'That source changed.']), { code: 0, stdout: 'c7 set aside\n', stderr: '' });
  assert.deepEqual(await run(['settle', 'c8', 'withdrawn', '--see', 'c10', 'No longer needed.']),
    { code: 0, stdout: 'withdrew c8\n', stderr: '' });
  assert.deepEqual(calls, [
    ['POST', '/api/messages', { instance, id: 'n4', how: 'taken', see: 'c10', text: 'In process.md.\n' }],
    ['POST', '/api/messages', { instance, id: 'c7', how: 'aside', text: 'That source changed.' }],
    ['POST', '/api/messages', { instance, id: 'c8', how: 'withdrawn', see: 'c10', text: 'No longer needed.' }],
  ]);
});

test('comment lists series notes or mine as text or JSON', async t => {
  const at = '2026-11-18T09:00:00Z';
  const notes = [
    { seq: 2, at, by: 'owner@example.test', text: 'Use this template.' },
    { seq: 4, at, by: 'owner@example.test', text: 'Use these dates.', settled: { op: 'aside', by: 'agent', text: 'Dates changed.' } },
  ];
  const mine = [{ id: 'c12', path: 'ws/series/Feb', seq: 12, at, by: 'agent', text: 'Found the template.', request: true }];
  const series = { id: 'own-series', kind: 'series' };
  const { calls, run } = await fake(t, [[200, series], [200, notes], [200, series], [200, notes], [200, mine], [200, mine]]);
  const listing = await run(['comment', '..']);
  assert.equal(listing.code, 0);
  assert.match(listing.stdout, /n2.*owner@example\.test.*open\n  Use this template\./);
  assert.match(listing.stdout, /n4.*set aside by agent: Dates changed\.\n  Use these dates\./);
  assert.deepEqual(JSON.parse((await run(['comment', '..', '--json'])).stdout), notes);
  assert.match((await run(['comment', '--mine'])).stdout, /ws\/series\/Feb#c12.*open \(request to propose\)\n  Found the template\./);
  assert.deepEqual(JSON.parse((await run(['comment', '--mine', '--json'])).stdout), mine);
  assert.deepEqual(calls, [
    ['GET', '/api/resolve?path=..'], ['GET', '/api/series/own-series/notes'],
    ['GET', '/api/resolve?path=..'], ['GET', '/api/series/own-series/notes'],
    ['GET', '/api/messages?mine=1'], ['GET', '/api/messages?mine=1'],
  ]);
});

test('a missing mine reader is reported without suppressing auth failures or retrying writes', async t => {
  const { calls, run } = await fake(t, [
    [404, 'not found'], [405, 'method not allowed'], [401, 'no run for this token'], [403, 'not allowed'], [503, 'try later'],
    [404, 'not found'], [404, 'no series you can read'],
  ]);
  const unsupported = { code: 1, stdout: '', stderr: 'This server does not support rf comment --mine for runs.\n' };
  assert.deepEqual(await run(['comment', '--mine']), unsupported);
  assert.deepEqual(await run(['comment', '--mine', '--json']), unsupported);
  assert.deepEqual(await run(['comment', '--mine']), { code: 1, stdout: '', stderr: 'no run for this token\n' });
  assert.deepEqual(await run(['comment', '--mine', '--json']), { code: 1, stdout: '', stderr: 'not allowed\n' });
  assert.deepEqual(await run(['comment', '--mine']), { code: 1, stdout: '', stderr: 'try later\n' });
  assert.deepEqual(await run(['comment', '.', 'No legacy write.']), { code: 1, stdout: '', stderr: 'not found\n' });
  assert.deepEqual(await run(['comment', '../missing', 'No unresolvable write.']), { code: 1, stdout: '', stderr: 'no series you can read\n' });
  assert.deepEqual(calls, [
    ...Array.from({ length: 5 }, () => ['GET', '/api/messages?mine=1']),
    ['POST', '/api/messages', { instance, text: 'No legacy write.' }], ['GET', '/api/resolve?path=..%2Fmissing'],
  ]);
});

test('bad message commands fail locally', async t => {
  const { calls, run } = await fake(t);
  for (const args of [
    ['comment', '/work/series', 'text'], ['comment', 'https://example.test', 'text'], ['comment', ''],
    ['comment', '.', '--at', '../Feb', 'text'],
    ['comment', '.', '--in', 'c1', '--on', 'pack', 'text'], ['comment', '.', '--in', 'n1', 'text'],
    ['comment', '.', '--on', 'pack@', 'text'], ['comment', '.', '--ask', '--propose', 'text'],
    ['comment', '.', '--ask', '--to', '--request', 'text'], ['comment', '.', '--to', 'owner@example.test', 'text'],
    ['comment', '.', '--for', 'c2', 'text'], ['comment', '.', '--propose', '--for', 'q2', 'text'],
    ['comment', '..', '--request'], ['comment', '..', '--mine'], ['comment', '--mine', '--ask'],
    ['comment', '.', '--json', 'text'], ['comment', '.', '--json'], ['comment', '.', '-'],
    ['settle', 'q2', 'taken', 'text'], ['settle', 'c0', 'taken', 'text'], ['settle', 'c2', 'done', 'text'],
    ['settle', 'n2', 'withdrawn', 'text'], ['settle', 'c2', 'taken', '--see'],
    ['settle', 'c2', 'aside', '--see', 'n1', 'text'], ['settle', 'n2', 'aside', '  '],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr);
  }
  assert.deepEqual(calls, []);
});

test('removed run options identify the exact replacement form without replaying the text', async t => {
  const { calls, run } = await fake(t);
  for (const [args, hint] of [
    [['say', '--at', '../Other', '--on', 'balance', 'private text'], 'Use rf comment PATH [--in cN | --on ITEM[@REF]] TEXT'],
    [['note', '--taken', 'n3', '--see', 'c7', 'private text'], 'Use rf settle nN taken [--see cN] TEXT'],
    [['note', '--aside', 'n3', 'private text'], 'Use rf settle nN aside TEXT'],
    [['withdraw', 'c5', '--see', 'c7', 'private text'], 'Use rf settle cN withdrawn [--see cM] TEXT'],
  ] as const) {
    assert.deepEqual(await run([...args]), { code: 1, stdout: '', stderr: `${hint}\n` });
  }
  assert.deepEqual(calls, []);
});

test('old verbs only point to their replacement and help advertises the new commands', async t => {
  const { calls, run } = await fake(t);
  for (const [verb, replacement] of [
    ['note', /rf comment.*rf settle/], ['say', /rf comment \. \[/], ['ask', /rf comment .*--ask/],
    ['propose', /rf comment .*--propose/], ['withdraw', /rf settle .*withdrawn/],
  ] as const) {
    const result = await run([verb, 'text']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trimEnd().split('\n').length, 1);
    assert.match(result.stderr, replacement);
    assert.equal((await run(['help', verb])).stdout, result.stderr);
  }
  const { stdout } = await run(['help']);
  assert.match(stdout, /^rf comment TARGET .*\[--request\] \[--for cN\|nN\]/m);
  assert.match(stdout, /^rf comment SERIES \[--json\]$/m);
  assert.match(stdout, /^rf comment --mine \[--json\]$/m);
  assert.match(stdout, /^rf settle ID taken\|aside\|withdrawn /m);
  assert.doesNotMatch(stdout, /^rf (note|say|ask|propose|withdraw)\b/m);
  assert.deepEqual(calls, []);
});

test('rf commit accepts an optional -m flag and rejects an empty message', async t => {
  const { calls, run } = await fake(t, [[200, 'committed abc1234'], [200, 'committed def5678'], [200, 'committed 9012345']]);
  assert.deepEqual(await run(['commit', 'Draft', 'pack']), { code: 0, stdout: 'committed abc1234\n', stderr: '' });
  assert.deepEqual(await run(['commit', '-m', 'Draft pack built']), { code: 0, stdout: 'committed def5678\n', stderr: '' });
  assert.deepEqual(await run(['commit', '-m', '-'], 'From stdin\n'), { code: 0, stdout: 'committed 9012345\n', stderr: '' });
  for (const bad of [['commit'], ['commit', '-m'], ['commit', '-m', '  ']]) {
    const r = await run(bad);
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.match(r.stderr, /^rf commit \[-m\] MESSAGE\|-/);
  }
  assert.deepEqual(calls, [
    ['POST', `/api/instances/${instance}/commit`, { message: 'Draft pack' }],
    ['POST', `/api/instances/${instance}/commit`, { message: 'Draft pack built' }],
    ['POST', `/api/instances/${instance}/commit`, { message: 'From stdin\n' }],
  ]);
});
