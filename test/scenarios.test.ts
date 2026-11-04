import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idp } from './idp.ts';

// Real runs, from a person's act down to Pi in its sandbox, with a scripted stand-in for OpenRouter: each run's prompt takes the
// next script, bash commands and then the report, and the stand-in keeps what each command answered. So the walls a run meets, a
// wake and a takeover are checked as a run meets them, at no model cost.
type Script = { bash: (string | (() => string | Promise<string>))[]; report: string; prompt?: string; system?: string; first?: number; saw: string[]; fail?: string; hold?: () => void };
const scripts: Script[] = [], byPrompt = new Map<string, Script>(), providers: unknown[] = [], keys: string[] = [];
const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-scenario-')), root = join(tmp, 'data');
const ADMIN = 'admin@demo.test', BOB = 'bob@demo.test';
let model: ReturnType<typeof createServer>, proc: ChildProcess, base = '', admin = '', bob = '', sessions = 0;
// The browser service, a stand-in: the browsers it opens are b1, b2…, each with a person in control and a live view, and a websocket
// to one answers with the path it reached.
const service = createServer((req, res) => {
  if (req.method === 'POST') return void res.writeHead(201).end(JSON.stringify({ id: `b${++sessions}` }));
  if (req.method === 'DELETE') return void res.end('{"state":{"cookies":[]},"log":[]}');
  res.end(req.url === '/sessions' ? '[]' : req.url!.endsWith('/log') ? '[{"live":true}]' : req.url!.endsWith('/view') ? 'the live view' : '');
}).on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`));

const text = (c: unknown): string => typeof c === 'string' ? c : (c as { type: string; text?: string; content?: unknown }[]).map(b => b.text ?? (b.content === undefined ? '' : text(b.content))).join('');
const isResult = (m: { role: string; content: unknown }) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === 'tool_result');

// The Anthropic Messages API, streamed, as Pi reaches OpenRouter's: the next step of the script for the latest prompt, each answer
// costing a cent, unless the key is out of credits; and a chat completion, for a script's own call.
async function answer(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  keys.push(String(req.headers['x-api-key']));
  if (keys.at(-1) === 'sk-or-broke') return void res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }));
  providers.push(body.provider);
  if (req.url!.endsWith('/chat/completions')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A second opinion' } }], usage: { cost: 0.002 } }));
  const msgs: { role: string; content: unknown }[] = body.messages, at = msgs.findLastIndex(m => m.role === 'user' && !isResult(m));
  const key = text(msgs[at].content);
  if (!byPrompt.has(key)) byPrompt.set(key, Object.assign(scripts.shift()!, { prompt: key, system: text(body.system), first: msgs.filter(m => m.role !== 'system').length }));
  const s = byPrompt.get(key)!, results = msgs.slice(at + 1).filter(isResult).flatMap(m => (m.content as { type: string; content: unknown }[]).filter(b => b.type === 'tool_result'));
  s.saw = results.map(r => text(r.content));
  // A held answer never comes, for a cut mid model call.
  if (s.hold) return void s.hold();
  if (s.fail) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: s.fail } }));
  const step = s.bash[results.length], bash = body.tools.find((t: { name: string }) => /bash/i.test(t.name)).name;
  const block = step === undefined ? { type: 'text', text: s.report } : { type: 'tool_use', id: `toolu_${Date.now()}`, name: bash, input: { command: typeof step === 'string' ? step : await step() } };
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
const entra = await idp();
const login = async (email: string) => (await entra.signIn(base, email)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
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
  // OpenRouter's GET /api/v1/key answers for a key it knows, as it checks one being saved.
  model = createServer((req, res) => (req.method === 'POST' && /\/(messages|chat\/completions)$/.test(new URL(req.url!, 'http://x').pathname) ? answer(req, res)
    : res.writeHead(req.url === '/api/v1/key' && String(req.headers.authorization).startsWith('Bearer sk-or-') ? 200 : 404).end('{}')));
  await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
  await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise(ok => probe.close(ok));
  mkdirSync(join(tmp, 'home'));
  // The server's git, but that the read-tree of a commit whose subject the file $RF_HOLD_GIT holds takes the index's lock and holds
  // it, as git does as it writes, until the server is gone: a cut mid commit.
  mkdirSync(join(tmp, 'bin'));
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(tmp, 'bin', 'git'), `#!/bin/sh
if [ "$1" = read-tree ] && [ -e "$RF_HOLD_GIT" ] && [ "$(${git} log -1 --format=%s "$2")" = "$(cat "$RF_HOLD_GIT")" ]; then
  : > .git/index.lock
  : > "$RF_HOLD_GIT.held"
  while kill -0 "$PPID" 2>/dev/null; do sleep 0.05; done
  exit 1
fi
exec ${git} "$@"
`);
  chmodSync(join(tmp, 'bin', 'git'), 0o755);
  await serve();
  [admin, bob] = [await login(ADMIN), await login(BOB)];
});

// The server on the data root, as a restart starts it again. The server sends what runs ask of openrouter.ai, Pi's own calls among
// them, to the stand-in.
async function serve() {
  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = 'http://127.0.0.1:${(model.address() as { port: number }).port}';`;
  proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(upstream)}`, join(app, 'src', 'server.ts'), root, new URL(base).port], {
    env: { ...process.env, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, RF_HOLD_GIT: join(tmp, 'hold-git'), HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch'), OPENROUTER_API_KEY: 'stand-in-key', RF_WAKE_TICK_MS: '300',
      RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`, RF_BROWSER_KEY: 'stand-in', ...entra.env(base), RF_ADMINS: ADMIN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
}
// A cut, as a crash or an update that restarts at once makes: the server killed where it stands, and started again.
async function cut() {
  proc.kill('SIGKILL');
  await once(proc, 'exit');
  await serve();
}
const until = async (what: string, done: () => boolean) => {
  for (let i = 0; !done(); i++) {
    assert.ok(i < 300, `${what} never happened`);
    await new Promise(ok => setTimeout(ok, 200));
  }
};

after(async () => {
  if (proc.exitCode === null) {
    proc.kill();
    await once(proc, 'exit');
  }
  model.close();
  service.close();
  entra.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("a run meets its walls, wakes itself, and after a takeover runs as its new runner, with the new runner's ticks", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Scenarios' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB], agents: 'Scenarios: amounts in USD.' })).status, 200);
  assert.equal((await fetch(`${base}/agents`, { method: 'PUT', headers: { cookie: admin }, body: 'Company: fiscal months end on the last Saturday.' })).status, 200);
  assert.equal((await call('PUT', '/connections/graph', { type: 'graph' })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  const made: Script = { bash: [], report: 'Nothing to roll forward yet.', saw: [] };
  scripts.push(made);
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  // The person's thread is the comment's seq, the first entry after the making's run.
  const thread = `c${(await runs(id, 1)).length + 1}`;
  assert.match(made.prompt!, /"op":"create".*\n.*"op":"wake","from":"admin@demo.test"/, 'making an instance of a series starts a run');
  const { id: wide } = await (await call('POST', '/api/workspaces', { name: 'Wide' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${wide}`, { members: [BOB] })).status, 200);
  assert.equal((await call('POST', '/api/series', { workspace: wide, name: 'Close' })).status, 200);
  const walls: Script = {
    bash: [
      `cat ${join(root, '.rf', 'seal.key')} 2>&1 | head -1`,
      `curl -s -m 5 ${base}/api 2>&1; echo "curl exit $?"`,
      'curl -s -m 5 https://10.1.2.3/ 2>&1; echo "curl exit $?"',
      'curl -s -m 10 https://graph.microsoft.com/v1.0/users/ceo@demo.test/messages 2>&1',
      () => `rf wake . ${new Date(Date.now() + 2500).toISOString()} 2>&1`,
      'rf wake ../../../Wide/Close now --label 2026-11 2>&1',
      'rf wake . soon 2>&1',
      'rf wake .. +1d 2>&1',
      () => `rf say --in ${thread} Walls checked. 2>&1`,
      'rf say --in c99 x 2>&1',
      'rf show 2>&1 | head -c 200',
      'rf ask --to stranger@example.com Which bank? 2>&1',
      'rf ask Is the bank file coming today? 2>&1',
      'rf say --on nope x 2>&1',
      () => `rf resolve ${thread} 2>&1`,
      `curl -s -m 10 https://openrouter.ai/api/v1/chat/completions -H 'content-type: application/json' -d '{"model": "openai/gpt-5-mini", "messages": [{"role": "user", "content": "Is this right?"}]}'`,
      'curl -s -m 10 https://openrouter.ai/api/v1/credits',
      'echo 1 > working/x.csv && rf say --file working/x.csv --file ../2026-11/working/x.csv Cited. 2>&1',
    ],
    report: 'Checked the walls, and woke myself for the bank file.', saw: [],
  };
  const woken: Script = { bash: ['curl -s -m 10 https://graph.microsoft.com/v1.0/me/messages 2>&1'], report: 'Woken; no mail is ticked.', saw: [] };
  const takenOver: Script = { bash: ['curl -s -m 10 https://graph.microsoft.com/v1.0/me/messages 2>&1'], report: 'Run as Bob.', saw: [] };
  scripts.push(walls, woken, takenOver);

  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Check what you can reach.' })).status, 200);
  let log = await runs(id, 3);
  assert.match(walls.prompt!, /Check what you can reach/);
  assert.ok(walls.system!.startsWith(readFileSync(join(app, 'prompt.md'), 'utf8').split('\n')[0]), "prompt.md is the system prompt, not added to Pi's own");
  const order = ['Company: fiscal', 'Scenarios: amounts'].map(t => walls.system!.indexOf(t));
  assert.ok(order[0] > 0 && order[1] > order[0], `the AGENTS.md files from /work down to the workspace: ${walls.system}`);
  assert.match(walls.saw[0], /No such file or directory/, 'the data root is not in the sandbox');
  assert.match(walls.saw[1], /curl exit 7/, "the server's own port is not reachable");
  assert.match(walls.saw[2], /curl exit [1-9]/, 'nor an internal address');
  assert.deepEqual(log.filter(e => e.op === 'egress').map(e => [e.run, e.host, e.allowed]), [[2, '10.1.2.3', false]]);
  assert.match(walls.saw[3], /m365:mail:ceo@demo.test is not ticked for this instance; its runner, admin@demo.test/, "Graph at its own address, through the server, which refuses what isn't ticked");
  assert.deepEqual(log.filter(e => e.op === 'call' && e.name === 'graph').map(e => [e.run, e.name, e.path, e.status]), [[2, 'graph', '/v1.0/users/ceo@demo.test/messages', 403], [3, 'graph', '/v1.0/me/messages', 403]]);
  assert.match(walls.saw[4], /^set: \. wakes at /);
  assert.match(walls.saw[5], /Wide\/Close is in another workspace: you can read it, not wake it/);
  assert.match(walls.saw[6], /at is now, \+<n>m\|h\|d, or a date/);
  assert.match(walls.saw[7], /name it with a label/);
  assert.match(walls.saw[8], new RegExp(`^said in ${thread}, seq \\d+\\s*$`));
  assert.match(walls.saw[9], new RegExp(`no thread c99; this instance's threads: ${thread}`));
  assert.match(walls.saw[10], /"rev": \d+,\s+"status": "open"/);
  assert.match(walls.saw[11], /stranger@example.com can't see this instance; ask its runner, admin@demo.test/);
  assert.match(walls.saw[12], /^asked in c\d+, seq \d+\s*$/);
  assert.match(walls.saw[13], /no item nope/);
  assert.match(walls.saw[14], new RegExp(`admin@demo.test started ${thread}, and resolves it`));
  assert.match(walls.saw[15], /"content":"A second opinion"/, 'any model, through OpenRouter, with the server\'s key');
  assert.match(walls.saw[16], /^\{\}\s*$/, "any request reaches OpenRouter, with the server's key");
  assert.deepEqual(log.findLast(e => e.text === 'Cited.')!.files, [{ inst: id, path: 'working/x.csv' }, { inst: id, path: 'working/x.csv' }], "a cited file is kept by its instance's id");
  const asked = log.filter(e => e.op === 'call' && e.name === 'openrouter'), pi = asked.filter(e => (e.path as string).startsWith('/api/v1/messages'));
  assert.deepEqual(asked.filter(e => !pi.includes(e)).map(e => [e.run, e.method, e.path, e.status, e.model, e.cost]), [[2, 'POST', '/api/v1/chat/completions', 200, 'openai/gpt-5-mini', 0.002], [2, 'GET', '/api/v1/credits', 404, undefined, 0]]);
  assert.deepEqual(pi.map(e => [e.run, e.method, e.status, e.model, e.cost]), [[1, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01], ...Array(walls.bash.length + 1).fill([2, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01]), ...Array(2).fill([3, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01])], "Pi's own calls, a step's each and the report's, through the same connection");
  assert.ok(providers.length && providers.every(p => JSON.stringify(p) === '{"data_collection":"deny"}'), 'every call asked only for providers that collect no data');
  assert.deepEqual(log.filter(e => e.op === 'comment' && e.by === 'agent').map(e => [e.text, !!e.ask]), [['Walls checked.', false], ['Is the bank file coming today?', true], ['Cited.', false]], "the agent's words are comments of its own, and an ask is marked");
  assert.match(woken.prompt!, /"op":"wake","from":"[^"]*\/2026-11"/, 'the wake started the next run, saying only who set it');
  assert.deepEqual([walls.first, woken.first], [1, 1], 'each run a new conversation, of its own prompt alone');
  assert.match(woken.prompt!, /^Instance 2026-11, run 3\. Its runner is Demo Admin <admin@demo\.test>, who lends you /, 'which names the runner');
  const transcripts = readdirSync(join(root, 'instances', id, 'session'));
  assert.ok(['run-2', 'run-3'].every(r => transcripts.some(f => f.endsWith(`_${r}.jsonl`))), `a transcript per run: ${transcripts}`);
  assert.match(woken.saw[0], /m365:mail:admin@demo.test is not ticked/);
  assert.deepEqual(log.filter(e => e.op === 'done').map(e => [e.run, e.aborted, e.cost]), [[1, false, 0.01], [2, false, +(walls.bash.length * 0.01 + 0.01 + 0.002).toFixed(4)], [3, false, 0.02]], "what its calls cost, Pi's and the script's");
  assert.deepEqual(log.filter(e => e.op === 'report').map(e => e.text), [made.report, walls.report, woken.report]);

  assert.equal((await call('POST', `/api/instances/${id}/takeover`, { logins: [] }, bob)).status, 200);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Mine now.' }, bob)).status, 200);
  log = await runs(id, 4);
  assert.match(takenOver.saw[0], /m365:mail:bob@demo.test is not ticked for this instance; its runner, bob@demo.test/);
  assert.equal(log.findLast(e => e.op === 'done')!.aborted, false);

  scripts.push({ bash: [], report: '', saw: [], fail: 'the model said no' });
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Once more.' }, bob)).status, 200);
  log = await runs(id, 5);
  assert.match(String(log.findLast(e => e.op === 'done')!.error), /the model said no/, "a model's failure is the run's error");
});

test('people rename the instance, its series and its workspace mid-run: the run carries on by the names it started with, and the next run has the new ones', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Named' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Before' })).json();
  scripts.push({ bash: [], report: 'Nothing to roll forward yet.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  const rename = async () => {
    for (const [path, body] of [[`/api/instances/${id}/rename?as=November`], [`/api/series/${series}`, { name: 'After' }], [`/api/workspaces/${ws}`, { name: 'Renamed' }]] as const)
      assert.equal((await call(body ? 'PUT' : 'POST', path, body)).status, 200, path);
    return 'pwd; cat names.tsv';
  };
  const during: Script = { bash: [rename, 'rf wake . +1d 2>&1; echo 1 > working/x.csv; rf say --file ../2026-11/working/x.csv Cited. 2>&1'], report: 'Renamed under me.', saw: [] };
  const next: Script = { bash: ['pwd; cat names.tsv'], report: 'New names.', saw: [] };
  scripts.push(during, next);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Go.' })).status, 200);
  await runs(id, 2);
  const [pwd, ...names] = during.saw[0].trim().split('\n');
  assert.deepEqual([pwd, names.filter(l => l.startsWith(id))], ['/work/Named/Before/2026-11', [`${id}\t/work/Named/Before/2026-11`]]);
  assert.match(during.saw[1], /^set: \. wakes at .*\nsaid in c\d+, seq \d+\s*$/);
  assert.deepEqual((await (await call('GET', `/api/instances/${id}`)).json()).log.findLast((e: { op: string }) => e.op === 'comment').files, [{ inst: id, path: 'working/x.csv' }]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: join(root, 'instances', id), encoding: 'utf8' });
  await until("run 2's commit", () => git('log', '-1', '--format=%s').startsWith('Run 2:'));
  assert.ok(git('show', 'HEAD:names.tsv').includes(`${id}\t/work/Named/Before/2026-11\n`), "the run's commit holds the names its changes were written under");
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Again.' })).status, 200);
  await runs(id, 3);
  const [now, ...renamed] = next.saw[0].trim().split('\n');
  assert.deepEqual([now, renamed.filter(l => l.startsWith(id))], ['/work/Renamed/After/November', [`${id}\t/work/Renamed/After/November`]]);
  await until("run 3's commit", () => git('log', '-1', '--format=%s').startsWith('Run 3:'));
  assert.ok(git('show', 'HEAD:names.tsv').includes(`${id}\t/work/Renamed/After/November\n`));
});

test('sign-offs are git commits: the agent commits a moment worth keeping, the runner approves or rejects in their name, and closing commits as theirs', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Signed' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Pack' })).json();
  scripts.push({ bash: [], report: 'Nothing to roll forward yet.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-12', logins: [] })).json();
  await runs(id, 1);
  const dir = join(root, 'instances', id), git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const ask: Script = {
    bash: [
      'echo 100 > working/pack.csv && rf commit Draft pack built 2>&1',
      "git log --format='%an|%s' 2>&1; echo 200 > working/pack.csv; git status --short 2>&1",
      'git commit --allow-empty -qm mine 2>&1 | head -1',
      'rf ask --sign-off --to bob@demo.test Send it? 2>&1',
      'rf ask --sign-off The pack is ready to send to the bank. 2>&1',
    ],
    report: 'Built the pack; asked for a sign-off.', saw: [],
  };
  const again: Script = { bash: ['rf ask --sign-off The rate is fixed: send it now? 2>&1'], report: 'Fixed the rate; asked again.', saw: [] };
  const approved: Script = { bash: [], report: 'Signed off: sending.', saw: [] };
  scripts.push(ask, again, approved);

  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Build the pack.' })).status, 200);
  let log = await runs(id, 2);
  assert.match(ask.saw[0], /^committed [0-9a-f]{40}\s*$/);
  assert.match(ask.saw[1], /^rollforward agent\|Draft pack built\n[^]* M working\/pack.csv/, 'the run reads its history, and sees what changed since');
  assert.match(ask.saw[2], /Read-only file system|Permission denied|unable to/i, 'and never writes it');
  assert.match(ask.saw[3], /a sign-off is the runner's, admin@demo.test: leave out --to/);
  assert.match(ask.saw[4], /^asked in c\d+/);
  assert.deepEqual(log.filter(e => e.op === 'commit').map(e => [e.by, e.run, e.message, e.commit]), [['agent', 2, 'Draft pack built', git('rev-parse', ':/^Draft pack built')]]);
  const thread = log.findLast(e => e.op === 'comment')!.thread as string, signoff = (body: object, cookie = admin) => call('POST', `/api/instances/${id}/signoff`, { thread, ...body }, cookie);
  assert.equal(log.findLast(e => e.op === 'comment')!.signoff, true);

  assert.equal((await signoff({ approved: true }, bob)).status, 403, "only the runner signs");
  assert.equal((await signoff({ approved: false, text: 'Use the new rate.' })).status, 200);
  log = await runs(id, 3);
  const rejected = log.find(e => e.op === 'signoff')!;
  assert.deepEqual([rejected.by, rejected.approved, rejected.text], [ADMIN, false, 'Use the new rate.']);
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%B', String(rejected.commit)), 'Demo Admin <admin@demo.test>\nThe pack is ready to send to the bank.\n\nUse the new rate.', 'a rejection commits too, without a Signed-off-by');
  assert.equal(git('show', `${rejected.commit}:working/pack.csv`), '200', 'the folder as it stood');
  assert.match(again.prompt!, /"op":"signoff".*"approved":false.*"text":"Use the new rate."/, 'the answer starts a run, as a reply does');
  assert.equal((await signoff({ approved: true })).status, 409, 'nothing waits in that thread now');

  const next = log.findLast(e => e.op === 'comment')!.thread;
  assert.equal((await call('POST', `/api/instances/${id}/signoff`, { thread: next, approved: true, text: 'Go.' })).status, 200);
  log = await runs(id, 4);
  const yes = log.findLast(e => e.op === 'signoff')!;
  assert.equal(git('log', '-1', '--format=%an%n%B', String(yes.commit)), 'Demo Admin\nThe rate is fixed: send it now?\n\nGo.\n\nSigned-off-by: Demo Admin <admin@demo.test>');
  assert.match(git('show', `${yes.commit}:log.jsonl`), /"op":"signoff","thread":"c\d+","approved":false/, 'the whole folder, its log included');

  assert.equal((await call('POST', `/api/instances/${id}/close`)).status, 200);
  log = (await (await call('GET', `/api/instances/${id}`)).json()).log;
  assert.equal(log.at(-1).commit, git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%an%n%B'), 'Demo Admin\nClose 2026-12\n\nSigned-off-by: Demo Admin <admin@demo.test>');
  assert.deepEqual(git('log', '--reverse', '--format=%an|%s').split('\n'), [
    'rollforward agent|Run 1: Nothing to roll forward yet.', 'rollforward agent|Draft pack built', 'rollforward agent|Run 2: Built the pack; asked for a sign-off.',
    'Demo Admin|The pack is ready to send to the bank.', 'rollforward agent|Run 3: Fixed the rate; asked again.', 'Demo Admin|The rate is fixed: send it now?',
    'rollforward agent|Run 4: Signed off: sending.', 'Demo Admin|Close 2026-12',
  ], "each run's end, the agent's commit, the two answers and the close");
  const pulled = await (await call('GET', '/api/files?path=Signed/Pack/2026-12')).json();
  assert.ok(pulled.length && !pulled.some((f: { path: string }) => f.path.includes('/.git/')), 'rf pull leaves the history out');
  const { id: copy } = await (await call('POST', `/api/instances/${id}/duplicate?as=copy`, { logins: [] })).json();
  assert.ok(!existsSync(join(root, 'instances', copy, '.git')), 'a duplicate starts afresh');
});

test('a cut anywhere leaves the instance right, its log whole, and the next run carries on: mid model call, mid tool call, mid commit and mid upload', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Cuts' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  scripts.push({ bash: [], report: 'Nothing to roll forward yet.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  const dir = join(root, 'instances', id), entries = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
  const commits = () => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  // The run a cut cut short ends as aborted, and the start wakes its instance, whose next run carries on to its report.
  const carriedOn = async (n: number, next: Script) => {
    const log = await runs(id, n + 1);
    assert.deepEqual(entries(), log, 'the log parses, every line of it');
    const done = log.filter(e => e.op === 'done');
    assert.deepEqual([done.at(-2)!.aborted, done.at(-2)!.error, done.at(-1)!.aborted], [true, 'a restart cut the run', false]);
    assert.ok(log.some(e => e.op === 'wake' && e.reason === `A restart cut run ${n}; carry on`), 'naming the run, whose transcript is in session/');
    assert.ok(commits().includes(`Run ${n}: a restart cut the run`), "its changes committed, as at any run's end");
    assert.equal(next.first, 1, 'in a new conversation');
    assert.equal(log.findLast(e => e.op === 'report')!.text, next.report);
    return log;
  };

  let reached = false;
  scripts.push({ bash: [], report: 'Never said.', saw: [], hold: () => { reached = true; } });
  await call('POST', `/api/instances/${id}/comment`, { text: 'Build it.' });
  await until('the model call', () => reached);
  const afterModel: Script = { bash: [], report: 'Carried on after a cut mid model call.', saw: [] };
  scripts.push(afterModel);
  await cut();
  await carriedOn(2, afterModel);

  scripts.push({ bash: ['touch working/started && sleep 120'], report: 'Never said.', saw: [] });
  await call('POST', `/api/instances/${id}/comment`, { text: 'Go on.' });
  await until('the tool call', () => existsSync(join(dir, 'working', 'started')));
  const afterTool: Script = { bash: ['ls working'], report: 'Carried on after a cut mid tool call.', saw: [] };
  scripts.push(afterTool);
  await cut();
  await carriedOn(4, afterTool);
  assert.match(afterTool.saw[0], /started/, 'with what the cut tool call wrote');

  writeFileSync(join(tmp, 'hold-git'), 'Before the cut');
  scripts.push({ bash: ['rf commit Before the cut 2>&1'], report: 'Never said.', saw: [] });
  await call('POST', `/api/instances/${id}/comment`, { text: 'Commit it.' });
  await until('the commit', () => existsSync(join(tmp, 'hold-git.held')));
  rmSync(join(tmp, 'hold-git'));
  const afterCommit: Script = { bash: ['rf commit After the cut 2>&1'], report: 'Committed after a cut mid commit.', saw: [] };
  scripts.push(afterCommit);
  await cut();
  let log = await carriedOn(6, afterCommit);
  assert.match(afterCommit.saw[0], /^committed [0-9a-f]{40}\s*$/, "the cut commit's lock is gone");
  assert.deepEqual(log.filter(e => e.op === 'commit').map(e => e.message), ['After the cut']);

  // A body that stops after its first MiB, as a slow one does.
  let sent = false;
  const body = new ReadableStream({ pull: c => (sent ? new Promise(() => {}) : void ((sent = true), c.enqueue(new Uint8Array(1 << 20)))) }), stop = new AbortController();
  const upload = fetch(`${base}/api/instances/${id}/upload?pane=in&name=big.bin`, { method: 'POST', body, duplex: 'half', headers: { cookie: admin }, signal: stop.signal } as RequestInit).catch(() => {});
  await until('the upload', () => readdirSync(join(root, '.tmp')).length > 0);
  const before = entries().length;
  await cut();
  stop.abort();
  await upload;
  assert.deepEqual([readdirSync(join(root, '.tmp')), existsSync(join(dir, 'upload', 'big.bin')), entries().length], [[], false, before], 'nothing of it is left, nor logged');
  const afterUpload: Script = { bash: ['ls upload'], report: 'Read the upload.', saw: [] };
  scripts.push(afterUpload);
  assert.equal((await fetch(`${base}/api/instances/${id}/upload?pane=in&name=small.csv`, { method: 'POST', body: 'a\n', headers: { cookie: admin } })).status, 200);
  log = await runs(id, 8);
  assert.match(afterUpload.saw[0], /small\.csv/);
  assert.ok(readdirSync(join(dir, 'session')).every(f => readFileSync(join(dir, 'session', f), 'utf8').trimEnd().split('\n').every(l => JSON.parse(l))), "the agent's session parses too");
});

test("a person's own OpenRouter key, checked as it's saved, goes in for the runs they run instead of the server's, each run logging whose; out of credits, the run fails as credits and the instance waits for them until they stop using it, which wakes it", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Keys' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Mine' })).json();
  assert.equal((await call('PUT', '/logins/openrouter', { key: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/logins/openrouter', { key: 'sk-or-mine' })).status, 200);
  assert.deepEqual((await (await call('GET', '/logins')).json()).find((l: { id: string }) => l.id === 'openrouter').enabled, false, 'until they tick it');
  assert.equal((await call('PUT', '/logins/openrouter', { enabled: true })).status, 200);
  keys.length = 0;
  scripts.push({ bash: [], report: 'On my own key.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: 'k1', logins: [] })).json();
  let log = await runs(id, 1);
  assert.deepEqual([log.find(e => e.op === 'run')!.key, [...new Set(keys)]], ['own', ['sk-or-mine']]);
  assert.equal((await call('PUT', '/logins/openrouter', { key: 'sk-or-broke', enabled: true })).status, 200);
  await call('POST', `/api/instances/${id}/comment`, { text: 'Again.' });
  log = await runs(id, 2);
  assert.ok(log.some(e => e.op === 'expired' && e.login === 'openrouter'), 'the instance waits for them');
  const failed = (await (await call('GET', '/api/runs')).json()).find((r: { path: string; run: number }) => r.path.endsWith('/k1') && r.run === 2);
  assert.deepEqual([failed.outcome, failed.failure], ['failed', 'credits']);
  assert.equal((await (await call('GET', '/logins')).json()).find((l: { id: string }) => l.id === 'openrouter').expired, true);
  keys.length = 0;
  scripts.push({ bash: [], report: 'On the shared key.', saw: [] });
  assert.equal((await call('PUT', '/logins/openrouter', { enabled: false })).status, 200);
  log = await runs(id, 3);
  assert.deepEqual([log.findLast(e => e.op === 'run')!.key, [...new Set(keys)], log.findLast(e => e.op === 'report')!.text], ['shared', ['stand-in-key'], 'On the shared key.']);
});

test("a run that adds rules to the process, or rewords them, says how many in its done entry, with the thread whose comment started it", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Rules' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Ruled' })).json();
  scripts.push({ bash: ["mkdir -p working && printf 'Delivers the pack.\\n- Read the ledger.\\n- Never write to it.\\n' > working/process.md"], report: 'Wrote the process.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: 'r1', logins: [] })).json();
  let log = await runs(id, 1);
  assert.deepEqual([log.find(e => e.op === 'done')!.rules, log.find(e => e.op === 'done')!.thread], [2, undefined], 'a wake started it, no thread');
  scripts.push({ bash: ["sed -i 's/Never write to it/Never write to it, nor delete/' working/process.md && printf -- '- Round to the cent.\\n' >> working/process.md"], report: 'Two rules.', saw: [] });
  await call('POST', `/api/instances/${id}/comment`, { text: 'Round to the cent, and never delete either.' });
  log = await runs(id, 2);
  const asked = log.findLast(e => e.op === 'comment' && e.by !== 'agent')!, done = log.findLast(e => e.op === 'done')!;
  assert.deepEqual([done.rules, done.thread], [2, asked.thread], 'one added, one reworded, in the thread that asked');
  scripts.push({ bash: [], report: 'Nothing new.', saw: [] });
  await call('POST', `/api/instances/${id}/comment`, { text: 'Thanks.' });
  log = await runs(id, 3);
  assert.equal(log.findLast(e => e.op === 'done')!.rules, undefined, 'none, none said');
});

// A websocket's opening, as a page at `origin` asks for it, and all that came back.
const upgrade = (path: string, cookie: string, origin = base) => new Promise<string>(ok => {
  let got = '';
  connect(Number(new URL(base).port), '127.0.0.1').on('data', d => { got += d; }).on('close', () => ok(got))
    .write(`GET ${path} HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\ncookie: ${cookie}\r\norigin: ${origin}\r\n\r\n`);
});

test("whoever sees an instance watches its run's browser live from the page, never driving it, and their Stop browser interrupts the run, closing it", async () => {
  const carol = await login('carol@demo.test');
  assert.equal((await call('PUT', '/connections/portal', { type: 'website', title: 'Portal', url: 'https://portal.example.com/', writeback: false })).status, 200);
  const { id: signIn } = await (await call('POST', '/logins/web/portal', {})).json();
  assert.match(await upgrade(`/signins/${signIn}/view/drive`, admin), /service got \/sessions\/b1\/view\/drive$/, 'a sign-in is its person\'s to drive');
  assert.match(await upgrade(`/signins/${signIn}/view/drive`, admin, 'https://evil.example.com'), /^HTTP\/1.1 404/, "only from the server's own pages");
  assert.equal((await call('POST', `/signins/${signIn}`)).status, 200);
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Watching' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Portal pull' })).json();
  scripts.push({ bash: ['curl -s -m 5 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/portal"; touch working/opened; sleep 120'], report: 'Never said.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: ['web:portal'] })).json(), view = `/runs/${id}/portal/view`;
  await until('the browser', () => existsSync(join(root, 'instances', id, 'working', 'opened')));
  assert.deepEqual((await (await call('GET', `/api/instances/${id}`, undefined, bob)).json()).run.browsers, ['portal'], 'the page shows it to bob, who sees the instance');
  assert.equal(await (await call('GET', view, undefined, bob)).text(), 'the live view');
  assert.match(await upgrade(`${view}/watch`, bob), /service got \/sessions\/b2\/view\/watch$/);
  for (const [path, cookie, origin, why] of [[`${view}/drive`, bob, base, 'never to drive'], [`${view}/watch`, bob, 'https://evil.example.com', "only from the server's own pages"], [`${view}/watch`, carol, base, 'nor for anyone who sees no instance']])
    assert.match(await upgrade(path, cookie, origin), /^HTTP\/1.1 404/, why);
  assert.equal((await call('GET', view, undefined, carol)).status, 404);
  assert.equal((await call('POST', `/api/instances/${id}/interrupt`, undefined, bob)).status, 200, 'Stop browser');
  const done = (await runs(id, 1)).find(e => e.op === 'done')!;
  assert.equal(done.aborted, true);
  await until('the browser closed', () => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').includes('"op":"browser"'));
  const { log, run } = await (await call('GET', `/api/instances/${id}`, undefined, bob)).json();
  assert.deepEqual([log.find((e: { op: string }) => e.op === 'interrupt').by, log.find((e: { op: string }) => e.op === 'browser').site, run], [BOB, 'portal', null], "logged as bob's, and the browser gone");
});
