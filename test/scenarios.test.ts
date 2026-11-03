import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real runs, from a person's act down to Pi in its sandbox, with a scripted stand-in for OpenRouter: each run's prompt takes the
// next script, bash commands and then the report, and the stand-in keeps what each command answered. So the walls a run meets, a
// wake and a takeover are checked as a run meets them, at no model cost.
type Script = { bash: (string | (() => string))[]; report: string; prompt?: string; system?: string; saw: string[]; fail?: string };
const scripts: Script[] = [], byPrompt = new Map<string, Script>(), providers: unknown[] = [];
const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-scenario-')), root = join(tmp, 'data');
const ADMIN = 'admin@demo.test', BOB = 'bob@demo.test';
let model: ReturnType<typeof createServer>, proc: ChildProcess, base = '', admin = '', bob = '';

const text = (c: unknown): string => typeof c === 'string' ? c : (c as { type: string; text?: string; content?: unknown }[]).map(b => b.text ?? (b.content === undefined ? '' : text(b.content))).join('');
const isResult = (m: { role: string; content: unknown }) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === 'tool_result');

// The Anthropic Messages API, streamed, as Pi reaches OpenRouter's: the next step of the script for the latest prompt, each answer
// costing a cent; and a chat completion, for a script's own call.
async function answer(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  providers.push(body.provider);
  if (req.url!.endsWith('/chat/completions')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A second opinion' } }], usage: { cost: 0.002 } }));
  const msgs: { role: string; content: unknown }[] = body.messages, at = msgs.findLastIndex(m => m.role === 'user' && !isResult(m));
  const key = text(msgs[at].content);
  if (!byPrompt.has(key)) byPrompt.set(key, Object.assign(scripts.shift()!, { prompt: key, system: text(body.system) }));
  const s = byPrompt.get(key)!, results = msgs.slice(at + 1).filter(isResult).flatMap(m => (m.content as { type: string; content: unknown }[]).filter(b => b.type === 'tool_result'));
  s.saw = results.map(r => text(r.content));
  if (s.fail) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: s.fail } }));
  const step = s.bash[results.length], bash = body.tools.find((t: { name: string }) => /bash/i.test(t.name)).name;
  const block = step === undefined ? { type: 'text', text: s.report } : { type: 'tool_use', id: `toolu_${Date.now()}`, name: bash, input: { command: typeof step === 'string' ? step : step() } };
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send('content_block_start', { index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
  send('content_block_delta', { index: 0, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10, cost: 0.01 } });
  send('message_stop', {});
  res.end();
}

const call = (method: string, path: string, body?: unknown, cookie = admin) => fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const login = async (email: string) => (await fetch(`${base}/auth/demo`, { method: 'POST', body: new URLSearchParams({ email, next: '/' }), redirect: 'manual' }))
  .headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
async function runs(id: string, n: number) {
  let log: { op: string; [k: string]: unknown }[] = [];
  for (let i = 0; i < 300 && log.filter(e => e.op === 'done').length < n; i++) {
    await new Promise(ok => setTimeout(ok, 200));
    ({ log } = await (await call('GET', `/api/instances/${id}`)).json());
  }
  assert.ok(log.filter(e => e.op === 'done').length >= n, `run ${n} never finished: ${JSON.stringify(log)}`);
  return log;
}

before(async () => {
  model = createServer((req, res) => (req.method === 'POST' && /\/(messages|chat\/completions)$/.test(new URL(req.url!, 'http://x').pathname) ? answer(req, res) : res.writeHead(404).end()));
  await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise(ok => probe.close(ok));
  mkdirSync(join(tmp, 'home'));
  // The server sends what runs ask of openrouter.ai, Pi's own calls among them, to the stand-in.
  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = 'http://127.0.0.1:${(model.address() as { port: number }).port}';`;
  proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(upstream)}`, join(app, 'src', 'server.ts'), root, new URL(base).port], {
    env: { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch'), OPENROUTER_API_KEY: 'stand-in-key', RF_WAKE_TICK_MS: '300' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  [admin, bob] = [await login(ADMIN), await login(BOB)];
});

after(async () => {
  if (proc.exitCode === null) {
    proc.kill();
    await once(proc, 'exit');
  }
  model.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("a run meets its walls, wakes itself, and after a takeover runs as its new runner, with the new runner's ticks", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Scenarios' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB], agents: 'Scenarios: amounts in USD.' })).status, 200);
  assert.equal((await fetch(`${base}/agents`, { method: 'PUT', headers: { cookie: admin }, body: 'Company: fiscal months end on the last Saturday.' })).status, 200);
  assert.equal((await call('PUT', '/connections/graph', { type: 'graph' })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  const { id: wide } = await (await call('POST', '/api/workspaces', { name: 'Wide' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${wide}`, { members: [BOB] })).status, 200);
  assert.equal((await call('POST', '/api/series', { workspace: wide, name: 'Close' })).status, 200);
  const walls: Script = {
    bash: [
      `cat ${join(root, '.rf', 'seal.key')} 2>&1 | head -1`,
      `curl -s -m 5 ${base}/api 2>&1; echo "curl exit $?"`,
      'curl -s -m 5 https://10.1.2.3/ 2>&1; echo "curl exit $?"',
      'curl -s -m 10 https://graph.microsoft.com/v1.0/users/ceo@demo.test/messages 2>&1',
      () => `rf wake 2026-11 ${new Date(Date.now() + 2500).toISOString()} 2>&1`,
      'rf wake ../../Wide/Close now --label 2026-11 2>&1',
      'rf wake . soon 2>&1',
      'rf wake . +1d 2>&1',
      'rf say --in c2 Walls checked. 2>&1',
      'rf say --in c9 x 2>&1',
      'rf show 2>&1 | head -c 200',
      'rf ask --to stranger@example.com Which bank? 2>&1',
      'rf ask Is the bank file coming today? 2>&1',
      'rf say --on nope x 2>&1',
      'rf resolve c2 2>&1',
      `curl -s -m 10 https://openrouter.ai/api/v1/chat/completions -H 'content-type: application/json' -d '{"model": "openai/gpt-5-mini", "messages": [{"role": "user", "content": "Is this right?"}]}'`,
      'curl -s -m 10 https://openrouter.ai/api/v1/credits',
    ],
    report: 'Checked the walls, and woke myself for the bank file.', saw: [],
  };
  const woken: Script = { bash: ['curl -s -m 10 https://graph.microsoft.com/v1.0/me/messages 2>&1'], report: 'Woken; no mail is ticked.', saw: [] };
  const takenOver: Script = { bash: ['curl -s -m 10 https://graph.microsoft.com/v1.0/me/messages 2>&1'], report: 'Run as Bob.', saw: [] };
  scripts.push(walls, woken, takenOver);

  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Check what you can reach.' })).status, 200);
  let log = await runs(id, 2);
  assert.match(walls.prompt!, /Check what you can reach/);
  assert.ok(walls.system!.startsWith(readFileSync(join(app, 'prompt.md'), 'utf8').split('\n')[0]), "prompt.md is the system prompt, not added to Pi's own");
  const order = ['Company: fiscal', 'Scenarios: amounts'].map(t => walls.system!.indexOf(t));
  assert.ok(order[0] > 0 && order[1] > order[0], `the AGENTS.md files from /work down to the workspace: ${walls.system}`);
  assert.match(walls.saw[0], /No such file or directory/, 'the data root is not in the sandbox');
  assert.match(walls.saw[1], /curl exit 7/, "the server's own port is not reachable");
  assert.match(walls.saw[2], /curl exit [1-9]/, 'nor an internal address');
  assert.deepEqual(log.filter(e => e.op === 'egress').map(e => [e.run, e.host, e.allowed]), [[1, '10.1.2.3', false]]);
  assert.match(walls.saw[3], /m365:mail:ceo@demo.test is not ticked for this instance; its runner, admin@demo.test/, "Graph at its own address, through the server, which refuses what isn't ticked");
  assert.deepEqual(log.filter(e => e.op === 'call' && e.name === 'graph').map(e => [e.run, e.name, e.path, e.status]), [[1, 'graph', '/v1.0/users/ceo@demo.test/messages', 403], [2, 'graph', '/v1.0/me/messages', 403]]);
  assert.match(walls.saw[4], /^set: 2026-11 wakes at /);
  assert.match(walls.saw[5], /Wide\/Close is in another workspace: you can read it, not wake it/);
  assert.match(walls.saw[6], /at is now, \+<n>m\|h\|d, or a date/);
  assert.match(walls.saw[7], /name it with a label/);
  assert.match(walls.saw[8], /^said in c2, seq \d+\s*$/);
  assert.match(walls.saw[9], /no thread c9; this instance's threads: c2/);
  assert.match(walls.saw[10], /"rev": \d+,\s+"status": "open"/);
  assert.match(walls.saw[11], /stranger@example.com can't see this instance; ask its runner, admin@demo.test/);
  assert.match(walls.saw[12], /^asked in c\d+, seq \d+\s*$/);
  assert.match(walls.saw[13], /no item nope/);
  assert.match(walls.saw[14], /admin@demo.test started c2, and resolves it/);
  assert.match(walls.saw[15], /"content":"A second opinion"/, 'any model, through OpenRouter, with the server\'s key');
  assert.match(walls.saw[16], /^GET \/api\/v1\/credits: openrouter takes inference/);
  const asked = log.filter(e => e.op === 'call' && e.name === 'openrouter'), pi = asked.filter(e => (e.path as string).startsWith('/api/v1/messages'));
  assert.deepEqual(asked.filter(e => !pi.includes(e)).map(e => [e.run, e.method, e.path, e.status, e.model, e.cost]), [[1, 'POST', '/api/v1/chat/completions', 200, 'openai/gpt-5-mini', 0.002], [1, 'GET', '/api/v1/credits', 403, undefined, undefined]]);
  assert.deepEqual(pi.map(e => [e.run, e.method, e.status, e.model, e.cost]), [...Array(walls.bash.length + 1).fill([1, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01]), ...Array(2).fill([2, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01])], "Pi's own calls, a step's each and the report's, through the same connection");
  assert.ok(providers.length && providers.every(p => JSON.stringify(p) === '{"data_collection":"deny"}'), 'every call asked only for providers that collect no data');
  assert.deepEqual(log.filter(e => e.op === 'comment' && e.by === 'agent').map(e => [e.text, !!e.ask]), [['Walls checked.', false], ['Is the bank file coming today?', true]], "the agent's words are comments of its own, and an ask is marked");
  assert.match(woken.prompt!, /"op":"wake","from":"[^"]*\/2026-11"/, 'the wake started the next run, saying only who set it');
  assert.match(woken.saw[0], /m365:mail:admin@demo.test is not ticked/);
  assert.deepEqual(log.filter(e => e.op === 'done').map(e => [e.run, e.aborted, e.cost]), [[1, false, +(walls.bash.length * 0.01 + 0.01 + 0.002).toFixed(4)], [2, false, 0.02]], "what its calls cost, Pi's and the script's");
  assert.deepEqual(log.filter(e => e.op === 'report').map(e => e.text), [walls.report, woken.report]);

  assert.equal((await call('POST', `/api/instances/${id}/takeover`, { logins: [] }, bob)).status, 200);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Mine now.' }, bob)).status, 200);
  log = await runs(id, 3);
  assert.match(takenOver.saw[0], /m365:mail:bob@demo.test is not ticked for this instance; its runner, bob@demo.test/);
  assert.equal(log.findLast(e => e.op === 'done')!.aborted, false);

  scripts.push({ bash: [], report: '', saw: [], fail: 'the model said no' });
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Once more.' }, bob)).status, 200);
  log = await runs(id, 4);
  assert.match(String(log.findLast(e => e.op === 'done')!.error), /the model said no/, "a model's failure is the run's error");
});

test('sign-offs are git commits: the agent commits a moment worth keeping, the runner approves or rejects in their name, and closing commits as theirs', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Signed' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Pack' })).json();
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-12', logins: [] })).json();
  const dir = join(root, 'instances', id), git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const ask: Script = {
    bash: [
      'echo 100 > 2026-12/working/pack.csv && rf commit Draft pack built 2>&1',
      "git -C 2026-12 log --format='%an|%s' 2>&1; echo 200 > 2026-12/working/pack.csv; git -C 2026-12 status --short 2>&1",
      'git -C 2026-12 commit --allow-empty -qm mine 2>&1 | head -1',
      'rf ask --sign-off --to bob@demo.test Send it? 2>&1',
      'rf ask --sign-off The pack is ready to send to the bank. 2>&1',
    ],
    report: 'Built the pack; asked for a sign-off.', saw: [],
  };
  const again: Script = { bash: ['rf ask --sign-off The rate is fixed: send it now? 2>&1'], report: 'Fixed the rate; asked again.', saw: [] };
  const approved: Script = { bash: [], report: 'Signed off: sending.', saw: [] };
  scripts.push(ask, again, approved);

  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Build the pack.' })).status, 200);
  let log = await runs(id, 1);
  assert.match(ask.saw[0], /^committed [0-9a-f]{40}\s*$/);
  assert.match(ask.saw[1], /^rollforward agent\|Draft pack built\n[^]* M working\/pack.csv/, 'the run reads its history, and sees what changed since');
  assert.match(ask.saw[2], /Read-only file system|Permission denied|unable to/i, 'and never writes it');
  assert.match(ask.saw[3], /a sign-off is the runner's, admin@demo.test: leave out --to/);
  assert.match(ask.saw[4], /^asked in c\d+/);
  assert.deepEqual(log.filter(e => e.op === 'commit').map(e => [e.by, e.run, e.message, e.commit]), [['agent', 1, 'Draft pack built', git('rev-parse', 'HEAD~0')]]);
  const thread = log.findLast(e => e.op === 'comment')!.thread as string, signoff = (body: object, cookie = admin) => call('POST', `/api/instances/${id}/signoff`, { thread, ...body }, cookie);
  assert.equal(log.findLast(e => e.op === 'comment')!.signoff, true);

  assert.equal((await signoff({ approved: true }, bob)).status, 403, "only the runner signs");
  assert.equal((await signoff({ approved: false, text: 'Use the new rate.' })).status, 200);
  log = await runs(id, 2);
  const rejected = log.find(e => e.op === 'signoff')!;
  assert.deepEqual([rejected.by, rejected.approved, rejected.text], [ADMIN, false, 'Use the new rate.']);
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%B', String(rejected.commit)), 'Demo Admin <admin@demo.test>\nThe pack is ready to send to the bank.\n\nUse the new rate.', 'a rejection commits too, without a Signed-off-by');
  assert.equal(git('show', `${rejected.commit}:working/pack.csv`), '200', 'the folder as it stood');
  assert.match(again.prompt!, /"op":"signoff".*"approved":false.*"text":"Use the new rate."/, 'the answer starts a run, as a reply does');
  assert.equal((await signoff({ approved: true })).status, 409, 'nothing waits in that thread now');

  const next = log.findLast(e => e.op === 'comment')!.thread;
  assert.equal((await call('POST', `/api/instances/${id}/signoff`, { thread: next, approved: true, text: 'Go.' })).status, 200);
  log = await runs(id, 3);
  const yes = log.findLast(e => e.op === 'signoff')!;
  assert.equal(git('log', '-1', '--format=%an%n%B', String(yes.commit)), 'Demo Admin\nThe rate is fixed: send it now?\n\nGo.\n\nSigned-off-by: Demo Admin <admin@demo.test>');
  assert.match(git('show', `${yes.commit}:log.jsonl`), /"op":"signoff","thread":"c\d+","approved":false/, 'the whole folder, its log included');

  assert.equal((await call('POST', `/api/instances/${id}/close`)).status, 200);
  log = (await (await call('GET', `/api/instances/${id}`)).json()).log;
  assert.equal(log.at(-1).commit, git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%an%n%B'), 'Demo Admin\nClose 2026-12\n\nSigned-off-by: Demo Admin <admin@demo.test>');
  assert.equal(git('rev-list', '--count', 'HEAD'), '4', 'the agent\'s commit, the two answers and the close');
  const pulled = await (await call('GET', '/api/files?path=Signed/Pack/2026-12')).json();
  assert.ok(pulled.length && !pulled.some((f: { path: string }) => f.path.includes('/.git/')), 'rf pull leaves the history out');
  const { id: copy } = await (await call('POST', `/api/instances/${id}/duplicate?as=copy`, { logins: [] })).json();
  assert.ok(!existsSync(join(root, 'instances', copy, '.git')), 'a duplicate starts afresh');
});
