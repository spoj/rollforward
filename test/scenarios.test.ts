import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// The server's own checks of websites (grants.ts, browsers.ts): what they asked, and the verdicts the stand-in model answers, in turn.
const checks: { provider: unknown; messages: { content: string }[] }[] = [], verdicts: object[] = [];
const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-scenario-')), root = join(tmp, 'data');
const ADMIN = 'admin@demo.test', BOB = 'bob@demo.test';
let model: ReturnType<typeof createServer>, proc: ChildProcess, base = '', admin = '', bob = '', sessions = 0;
// The browser service, a stand-in: the browsers it opens are b1, b2…, each with a person in control and a live view, and a websocket
// to one answers with the path it reached. Their pages asked for the addresses in `refused`, which they don't reach; what else they
// were told, as hosts allowed, is in `told`.
let refused: string[] = [];
const told: string[] = [];
const service = createServer(async (req, res) => {
  const blocked = refused.map(url => ({ method: 'GET', url, status: 403, blocked: 'host not on the list' }));
  if (req.method === 'POST' && req.url === '/sessions') return void res.writeHead(201).end(JSON.stringify({ id: `b${++sessions}` }));
  if (req.method === 'PUT' || req.method === 'POST') return void res.end((told.push(`${req.method} ${req.url} ${Buffer.concat(await Array.fromAsync(req)).toString()}`), '{}'));
  if (req.method === 'DELETE') return void res.end(JSON.stringify({ state: { cookies: [] }, log: blocked }));
  res.end(req.url === '/sessions' ? '[]' : req.url!.endsWith('/log') ? JSON.stringify([{ live: true }, ...blocked]) : req.url!.endsWith('/view') ? 'the live view' : '');
}).on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`));

const text = (c: unknown): string => typeof c === 'string' ? c : (c as { type: string; text?: string; content?: unknown }[]).map(b => b.text ?? (b.content === undefined ? '' : text(b.content))).join('');
const isResult = (m: { role: string; content: unknown }) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === 'tool_result');

// The Anthropic Messages API, streamed, as Pi reaches OpenRouter's: the next step of the script for the latest prompt, each answer
// costing a cent, unless the key is out of credits; and a chat completion, for a script's own call.
async function answer(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  if (body.response_format) return void (checks.push(body), res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(verdicts.shift()) } }] })));
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

// The server on the data root, as a restart starts it again, with `env` besides. The server sends what runs ask of openrouter.ai,
// Pi's own calls among them, to the stand-in.
async function serve(env: NodeJS.ProcessEnv = {}) {
  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = 'http://127.0.0.1:${(model.address() as { port: number }).port}';`;
  proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(upstream)}`, join(app, 'src', 'server.ts'), root, new URL(base).port], {
    env: { ...process.env, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, RF_HOLD_GIT: join(tmp, 'hold-git'), HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch'), OPENROUTER_API_KEY: 'stand-in-key', RF_WAKE_TICK_MS: '300',
      RF_BROWSER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`, RF_BROWSER_KEY: 'stand-in', ...entra.env(base), RF_ADMINS: ADMIN, ...env },
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
      () => `rf wake . ${new Date(Date.now() + 8000).toISOString()} 2>&1`,
      'rf wake ../../../Wide/Close now --label 2026-11 2>&1',
      'rf wake . soon 2>&1',
      'rf wake .. +1d 2>&1',
      () => `rf say --in ${thread} Walls checked. 2>&1`,
      'rf say --in c99 x 2>&1',
      'rf show 2>&1 | head -c 200',
      'rf ask --to stranger@example.com Which bank? 2>&1',
      'rf ask Is the bank file coming today? 2>&1',
      'rf say --on nope x 2>&1',
      () => `rf say --in ${walls.saw[12].match(/c\d+/)![0]} It came, never mind. 2>&1`,
      `curl -s -m 10 https://openrouter.ai/api/v1/chat/completions -H 'content-type: application/json' -d '{"model": "openai/gpt-5-mini", "messages": [{"role": "user", "content": "Is this right?"}]}'`,
      'curl -s -m 10 https://openrouter.ai/api/v1/credits',
      'echo 1 > working/x.csv && rf say --pin working/x.csv --pin ../2026-11/working/x.csv Cited. 2>&1',
      'curl -s -m 5 -X POST -H "authorization: Bearer $RF_TOKEN" "$RF_URL/api/instances/$RF_INSTANCE/close"; echo',
      'curl -s -m 5 -H "authorization: Bearer $RF_TOKEN" "$RF_URL/api/workspaces"; echo',
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
  assert.match(walls.saw[8], new RegExp(`^said c\\d+, under ${thread}\\s*$`));
  assert.match(walls.saw[9], new RegExp(`no comment c99 to reply under; this instance's threads: ${thread}`));
  assert.match(walls.saw[10], /"rev": \d+,\s+"status": "open"/);
  assert.match(walls.saw[11], /stranger@example.com can't see this instance; ask its runner, admin@demo.test/);
  assert.match(walls.saw[12], /^asked c\d+\s*$/);
  assert.match(walls.saw[13], /no item nope/);
  assert.match(walls.saw[14], new RegExp(`^said c\\d+, under ${walls.saw[12].trim().slice(6)}\\s*$`), 'the agent withdraws its ask by replying under it');
  assert.match(walls.saw[15], /"content":"A second opinion"/, 'any model, through OpenRouter, with the server\'s key');
  assert.match(walls.saw[16], /^\{\}\s*$/, "any request reaches OpenRouter, with the server's key");
  const x = { inst: id, path: 'working/x.csv', sha256: createHash('sha256').update('1\n').digest('hex') };
  assert.deepEqual(log.findLast(e => e.text === 'Cited.')!.files, [x, x], "a pinned file is kept by its instance's id, with its sha256");
  assert.deepEqual([walls.saw[18].trim(), walls.saw[19].trim()], ['not found', 'not found'], "a run's token does only what a run may: not close its instance, nor read what people do"); 
  const asked = log.filter(e => e.op === 'call' && e.name === 'openrouter'), pi = asked.filter(e => (e.path as string).startsWith('/api/v1/messages'));
  assert.deepEqual(asked.filter(e => !pi.includes(e)).map(e => [e.run, e.method, e.path, e.status, e.model, e.cost]), [[2, 'POST', '/api/v1/chat/completions', 200, 'openai/gpt-5-mini', 0.002], [2, 'GET', '/api/v1/credits', 404, undefined, 0]]);
  assert.deepEqual(pi.map(e => [e.run, e.method, e.status, e.model, e.cost]), [[1, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01], ...Array(walls.bash.length + 1).fill([2, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01]), ...Array(2).fill([3, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01])], "Pi's own calls, a step's each and the report's, through the same connection");
  assert.ok(providers.length && providers.every(p => JSON.stringify(p) === '{"data_collection":"deny"}'), 'every call asked only for providers that collect no data');
  assert.deepEqual(log.filter(e => e.op === 'comment' && e.by === 'agent').map(e => [e.text, !!e.ask]), [['Walls checked.', false], ['Is the bank file coming today?', true], ['It came, never mind.', false], ['Cited.', false]], "the agent's words are comments of its own, and an ask is marked");
  assert.match(woken.prompt!, /"op":"wake","from":"[^"]*\/2026-11"/, 'the wake started the next run, saying only who set it');
  assert.match(made.prompt!, /^Instance 2026-11, run 1\. Its runner is Demo Admin <admin@demo\.test>, who lends you /, 'a new Pi hears who the runner is');
  assert.deepEqual([made.first, walls.first], [1, 1], 'a new conversation, of its own prompt alone, as a series made in reach since changed what run 2 sees');
  assert.ok(woken.first! > 1, 'a run within the hour of the last carries its conversation on, as a new turn');
  assert.match(woken.prompt!, /^Instance 2026-11, run 3\. New log entries:/, 'whose message is the new log entries');
  const transcripts = readdirSync(join(root, 'instances', id, 'session'));
  assert.ok(['run-1', 'run-2'].every(r => transcripts.some(f => f.endsWith(`_${r}.jsonl`))) && !transcripts.some(f => f.endsWith('_run-3.jsonl')), `a transcript per session: ${transcripts}`);
  assert.match(woken.saw[0], /m365:mail:admin@demo.test is not ticked/);
  assert.deepEqual(log.filter(e => e.op === 'done').map(e => [e.run, e.aborted, e.cost]), [[1, false, 0.01], [2, false, +(walls.bash.length * 0.01 + 0.01 + 0.002).toFixed(4)], [3, false, 0.02]], "what its calls cost, Pi's and the script's");
  assert.ok(!JSON.stringify(log).includes(walls.report), "a run's closing message reaches no one: it stays in its session");

  assert.equal((await call('POST', `/api/instances/${id}/takeover`, { logins: [] }, bob)).status, 200);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Mine now.' }, bob)).status, 200);
  log = await runs(id, 4);
  assert.match(takenOver.saw[0], /m365:mail:bob@demo.test is not ticked for this instance; its runner, bob@demo.test/);
  assert.equal(log.findLast(e => e.op === 'done')!.aborted, false);
  assert.equal(takenOver.first, 1, 'a takeover ends the idle Pi: a new runner, a new conversation');

  scripts.push({ bash: [], report: '', saw: [], fail: 'the model said no' });
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Once more.' }, bob)).status, 200);
  log = await runs(id, 5);
  assert.match(String(log.findLast(e => e.op === 'done')!.error), /the model said no/, "a model's failure is the run's error");
  assert.deepEqual(log.filter(e => e.op === 'run').map(e => e.continues), [undefined, undefined, 2, undefined, 4], 'which ends its Pi, as a refusal would');
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
  const during: Script = { bash: [rename, 'rf wake . +1d 2>&1; echo 1 > working/x.csv; rf say --pin ../2026-11/working/x.csv Cited. 2>&1'], report: 'Renamed under me.', saw: [] };
  const next: Script = { bash: ['pwd; cat names.tsv'], report: 'New names.', saw: [] };
  scripts.push(during, next);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Go.' })).status, 200);
  await runs(id, 2);
  const [pwd, ...names] = during.saw[0].trim().split('\n');
  assert.deepEqual([pwd, names.filter(l => l.startsWith(id))], ['/work/Named/Before/2026-11', [`${id}\t/work/Named/Before/2026-11`]]);
  assert.match(during.saw[1], /^set: \. wakes at .*\nsaid c\d+\s*$/);
  assert.deepEqual((await (await call('GET', `/api/instances/${id}`)).json()).log.findLast((e: { op: string }) => e.op === 'comment').files, [{ inst: id, path: 'working/x.csv', sha256: createHash('sha256').update('1\n').digest('hex') }]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: join(root, 'instances', id), encoding: 'utf8' });
  await until("run 2's commit", () => git('log', '-1', '--format=%s') === 'Run 2\n');
  assert.ok(git('show', 'HEAD:names.tsv').includes(`${id}\t/work/Named/Before/2026-11\n`), "the run's commit holds the names its changes were written under");
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Again.' })).status, 200);
  await runs(id, 3);
  const [now, ...renamed] = next.saw[0].trim().split('\n');
  assert.deepEqual([now, renamed.filter(l => l.startsWith(id))], ['/work/Renamed/After/November', [`${id}\t/work/Renamed/After/November`]]);
  await until("run 3's commit", () => git('log', '-1', '--format=%s') === 'Run 3\n');
  assert.ok(git('show', 'HEAD:names.tsv').includes(`${id}\t/work/Renamed/After/November\n`));
});

test("sign-offs are git commits: the agent commits a moment worth keeping and pins what it asks about; anyone who sees the instance signs it off in their name, someone else's a note for the runner; closing commits as the runner's", async () => {
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
      'rf ask --pin working/none.csv Send it? 2>&1',
      'rf ask --pin working/pack.csv The pack is ready to send to the bank. 2>&1',
    ],
    report: 'Built the pack; asked for a sign-off.', saw: [],
  };
  const again: Script = { bash: ['echo 250 > working/pack2.csv && rf ask --pin working/pack2.csv The rate is fixed: send it now? 2>&1'], report: 'Fixed the rate; asked again.', saw: [] };
  const approved: Script = { bash: [], report: 'Signed off: sending.', saw: [] };
  scripts.push(ask, again, approved);

  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Build the pack.' })).status, 200);
  let log = await runs(id, 2);
  assert.match(ask.saw[0], /^committed [0-9a-f]{40}\s*$/);
  assert.match(ask.saw[1], /^rollforward agent\|Draft pack built\n[^]* M working\/pack.csv/, 'the run reads its history, and sees what changed since');
  assert.match(ask.saw[2], /Read-only file system|Permission denied|unable to/i, 'and never writes it');
  assert.match(ask.saw[3], /no file working\/none\.csv: pin one under upload\/ or working\//);
  assert.match(ask.saw[4], /^asked c\d+/);
  assert.deepEqual(log.filter(e => e.op === 'commit').map(e => [e.by, e.run, e.message, e.commit]), [['agent', 2, 'Draft pack built', git('rev-parse', ':/^Draft pack built')]]);
  const first = log.findLast(e => e.op === 'comment')!, pack = join(dir, 'working', 'pack.csv'), sum = createHash('sha256').update('200\n').digest('hex');
  const signoff = (body: object, cookie = admin) => call('POST', `/api/instances/${id}/signoff`, { thread: first.thread, ...body }, cookie);
  assert.deepEqual([first.files, statSync(pack).mode & 0o777], [[{ inst: id, path: 'working/pack.csv', sha256: sum }], 0o444], 'its file pinned, frozen');

  assert.equal((await signoff({ text: 'Fine by me.' }, bob)).status, 200, 'anyone who sees it');
  ({ log } = await (await call('GET', `/api/instances/${id}`)).json());
  const bobs = log.findLast(e => e.op === 'signoff')!;
  assert.deepEqual([bobs.by, bobs.on, bobs.note, log.filter(e => e.op === 'run').length], [BOB, first.seq, true, 2], "someone else's is a note for the runner, which starts no run");
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%B', String(bobs.commit)), `Bob <${BOB}>\nThe pack is ready to send to the bank.\n\nPinned: working/pack.csv ${sum}\n\nFine by me.\n\nSigned-off-by: Bob <${BOB}>`);
  chmodSync(pack, 0o644);
  writeFileSync(pack, '300\n');
  assert.match(await (await signoff({})).text(), /working\/pack\.csv changed since the agent asked/);
  writeFileSync(pack, '200\n');
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { thread: first.thread, text: 'Use the new rate.' })).status, 200, 'saying no is a reply');
  log = await runs(id, 3);
  assert.match(again.prompt!, /"op":"signoff".*"note":true[^]*"text":"Use the new rate\."/, 'the run reads the note, then the reply');

  const next = log.findLast(e => e.op === 'comment')!, sum2 = createHash('sha256').update('250\n').digest('hex');
  assert.equal((await signoff({ thread: next.thread, text: 'Go.' })).status, 200);
  log = await runs(id, 4);
  const yes = log.findLast(e => e.op === 'signoff')!;
  assert.equal(yes.on, next.seq, 'the ask it names');
  assert.equal(git('log', '-1', '--format=%an%n%B', String(yes.commit)), `Demo Admin\nThe rate is fixed: send it now?\n\nPinned: working/pack2.csv ${sum2}\n\nGo.\n\nSigned-off-by: Demo Admin <admin@demo.test>`);
  assert.match(git('show', `${yes.commit}:log.jsonl`), /"op":"signoff","thread":"c\d+","on":\d+,"text":"Fine by me\."/, 'the whole folder, its log included');

  assert.equal((await call('POST', `/api/instances/${id}/close`)).status, 200);
  log = (await (await call('GET', `/api/instances/${id}`)).json()).log;
  assert.equal(log.at(-1).commit, git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%an%n%B'), 'Demo Admin\nClose 2026-12');
  assert.deepEqual(git('log', '--reverse', '--format=%an|%s').split('\n'), [
    'rollforward agent|Run 1', 'rollforward agent|Draft pack built', 'rollforward agent|Run 2',
    'Bob|The pack is ready to send to the bank.', 'rollforward agent|Run 3', 'Demo Admin|The rate is fixed: send it now?',
    'rollforward agent|Run 4', 'Demo Admin|Close 2026-12',
  ], "each run's end, the agent's commit, the two sign-offs and the close");
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
  // The run a cut cut short ends as aborted, and the start wakes its instance, whose next run carries on to its end.
  const carriedOn = async (n: number, next: Script) => {
    const log = await runs(id, n + 1);
    assert.deepEqual(entries(), log, 'the log parses, every line of it');
    const done = log.filter(e => e.op === 'done');
    assert.deepEqual([done.at(-2)!.aborted, done.at(-2)!.error, done.at(-1)!.aborted], [true, 'a restart cut the run', false]);
    assert.ok(log.some(e => e.op === 'wake' && e.reason === `A restart cut run ${n}; carry on`), 'naming the run, whose transcript is in session/');
    assert.ok(commits().includes(`Run ${n}: a restart cut the run`), "its changes committed, as at any run's end");
    assert.equal(next.first, 1, 'in a new conversation');
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
  assert.deepEqual([log.findLast(e => e.op === 'run')!.key, [...new Set(keys)]], ['shared', ['stand-in-key']]);
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

test("a later run corrects a closed instance, never changing it, linking the thread of its own that says why; the next instance's run hears of it", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Fixes' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Fixed' })).json();
  scripts.push({ bash: [], report: 'Built.', saw: [] });
  const { id: first } = await (await call('POST', `/api/series/${series}`, { label: 'm1', logins: [] })).json();
  await runs(first, 1);
  assert.equal((await call('POST', `/api/instances/${first}/close`)).status, 200);
  const fixing: Script = {
    bash: ["t=$(rf say m1 used a stale rate. | cut -d' ' -f2); rf correct ../m1 --wrong --in $t The rate was a day stale. 2>&1", 'rf correct ../m1 --wrong 2>&1', 'rf correct . --superseded x 2>&1'],
    report: 'Corrected m1.', saw: [],
  };
  scripts.push(fixing);
  const { id: second } = await (await call('POST', `/api/series/${series}`, { label: 'm2', logins: [] })).json();
  const log = await runs(second, 1), said = log.find(e => e.op === 'comment' && e.by === 'agent')!;
  assert.match(fixing.saw[0], /^m1 is marked wrong, seq \d+\s*$/);
  assert.match(fixing.saw[1], /^rf correct PATH/, 'no text, its usage');
  assert.match(fixing.saw[2], /^m2 is open: only a closed instance takes corrections/);
  const fix = (await (await call('GET', `/api/instances/${first}`)).json()).log.at(-1);
  assert.deepEqual([fix.by, fix.op, fix.kind, fix.text, fix.see], ['agent', 'correction', 'wrong', 'The rate was a day stale.', { inst: second, label: 'm2', thread: said.thread }]);
  assert.deepEqual(log.filter(e => e.op === 'corrected').map(e => [e.inst, e.seq, e.kind]), [[first, fix.seq, 'wrong']]);
  const next: Script = { bash: [], report: 'Rolled forward.', saw: [] };
  scripts.push(next);
  const { id: third } = await (await call('POST', `/api/series/${series}`, { label: 'm3', logins: [] })).json();
  await runs(third, 1);
  assert.match(next.prompt!, new RegExp(`Corrections on earlier instances: m1 is wrong, "The rate was a day stale\\.", see m2 ${said.thread}\\.`));
});

// A websocket's opening, as a page at `origin` asks for it, and all that came back.
const upgrade = (path: string, cookie: string, origin = base) => new Promise<string>(ok => {
  let got = '';
  connect(Number(new URL(base).port), '127.0.0.1').on('data', d => { got += d; }).on('close', () => ok(got))
    .write(`GET ${path} HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\ncookie: ${cookie}\r\norigin: ${origin}\r\n\r\n`);
});

test("whoever sees an instance watches its run's browser live from the page, the person whose login it's in alone taking control of it, and their Stop browser interrupts the run, closing it", async () => {
  const carol = await login('carol@demo.test');
  assert.equal((await call('POST', '/logins/sites', { name: 'portal', url: 'https://portal.example.com/' })).status, 200);
  assert.equal((await call('PATCH', '/logins/sites/portal', { title: 'Portal', writeback: false })).status, 200);
  const { id: signIn } = await (await call('POST', '/logins/web/portal', {})).json();
  assert.match(await upgrade(`/signins/${signIn}/view/drive`, admin), /service got \/sessions\/b1\/view\/drive$/, 'a sign-in is its person\'s to drive');
  assert.match(await upgrade(`/signins/${signIn}/view/drive`, admin, 'https://evil.example.com'), /^HTTP\/1.1 404/, "only from the server's own pages");
  assert.equal((await call('POST', `/signins/${signIn}`)).status, 200);
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Watching' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Portal pull' })).json();
  const { id: grant } = await (await call('POST', '/grants', { site: 'portal', workspace: ws, reason: 'portal pulls' })).json();
  assert.equal((await call('POST', `/grants/${grant}`, { approve: true })).status, 200);
  scripts.push({ bash: ['curl -s -m 5 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/portal"; touch working/opened; sleep 120'], report: 'Never said.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: ['web:portal'] })).json(), view = `/runs/${id}/portal/view`;
  await until('the browser', () => existsSync(join(root, 'instances', id, 'working', 'opened')));
  const shown = async (cookie: string) => (await (await call('GET', `/api/instances/${id}`, undefined, cookie)).json()).run, [his, mine] = [await shown(bob), await shown(admin)];
  assert.deepEqual([his.browsers, his.yours, mine.yours], [['portal'], [], ['portal']], "the page shows it to bob, who sees the instance, and it's the admin's to take control of, in their login");
  assert.equal(await (await call('GET', view, undefined, bob)).text(), 'the live view');
  assert.match(await upgrade(`${view}/watch`, bob), /service got \/sessions\/b2\/view\/watch$/);
  assert.match(await upgrade(`${view}/drive`, admin), /service got \/sessions\/b2\/view\/drive$/, 'the admin takes control of it');
  for (const [path, cookie, origin, why] of [[`${view}/drive`, bob, base, 'no one else drives it'], [`${view}/watch`, bob, 'https://evil.example.com', "only from the server's own pages"], [`${view}/watch`, carol, base, 'nor for anyone who sees no instance']])
    assert.match(await upgrade(path, cookie, origin), /^HTTP\/1.1 404/, why);
  assert.equal((await call('GET', view, undefined, carol)).status, 404);
  assert.equal((await call('POST', `/api/instances/${id}/interrupt`, undefined, bob)).status, 200, 'Stop browser');
  const done = (await runs(id, 1)).find(e => e.op === 'done')!;
  assert.equal(done.aborted, true);
  await until('the browser closed', () => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').includes('"requests":'));
  const { log, run } = await (await call('GET', `/api/instances/${id}`, undefined, bob)).json();
  assert.deepEqual([log.find((e: { op: string }) => e.op === 'interrupt').by, log.filter((e: { op: string }) => e.op === 'browser').map((e: { by: string; site: string; action?: string }) => [e.by, e.site, e.action]), run],
    [BOB, [[ADMIN, 'portal', 'drive'], ['server', 'portal', undefined]], null], "the admin's control logged as theirs, the interrupt as bob's, and the browser gone");
});

test("anyone adds a website, theirs to set: they allow the hosts its pages need as they sign in, a run uses it where its workspace's owners approved its runner's grant, seeing the server's check, the hosts a run's browser was refused are sorted, and what's left waits on its owner and admins, and an admin may switch it off", async () => {
  const carol = await login('carol@demo.test'), add = (body: object) => call('POST', '/logins/sites', { name: 'bobs', url: 'https://bobs.example.com/', ...body }, bob);
  const said = async (res: Response) => [res.status, await res.text()];
  const allow = (host: string, cookie = bob) => call('POST', '/logins/web/bobs/hosts', { host }, cookie);
  const listed = async (cookie: string) => (await (await call('GET', '/connections', undefined, cookie)).json()).find((c: { name: string }) => c.name === 'bobs');
  assert.deepEqual(await said(await add({ url: 'http://bobs.example.com/' })), [400, 'url: an https address, where its sign-in starts']);
  assert.deepEqual(await said(await add({ name: 'graph' })), [409, 'graph is taken: name yours otherwise']);
  assert.deepEqual(await said(await add({ url: 'https://10.1.2.3/' })), [400, '10.1.2.3 is at an internal address: a website reaches one only where an admin lets it']);
  assert.equal((await add({})).status, 200);
  assert.deepEqual([(await listed(bob))?.owner, (await listed(carol))?.owner], [BOB, BOB], 'everyone sees it, to sign in to it too');

  // Signing in, its pages ask for hosts it doesn't reach: its owner allows those its sign-in needs, and the open browser reaches them.
  refused = ['https://sso.idp.test/a', 'https://cdn.idp.test/x.js', 'https://sso.idp.test/b'];
  const { id: signIn } = await (await call('POST', '/logins/web/bobs', {}, bob)).json();
  assert.deepEqual(await (await call('GET', '/logins/web/bobs/refused', undefined, bob)).json(),
    { allows: true, hosts: [{ host: '*.idp.test', count: 3 }, { host: 'sso.idp.test', count: 2 }, { host: 'cdn.idp.test', count: 1 }] });
  assert.deepEqual(await said(await allow('*.co.uk')), [400, '*.co.uk: a wildcard stays within one registrable domain, such as *.example.com']);
  assert.deepEqual(await said(await allow('graph.microsoft.com')), [400, "graph.microsoft.com is graph's: no other website reaches it"]);
  assert.deepEqual(await said(await allow('sso.idp.test', carol)), [403, "bobs's hosts are bob@demo.test's to allow, or an admin's"]);
  assert.equal((await allow('sso.idp.test')).status, 200);
  assert.deepEqual(told.slice(-2), [`PUT /sessions/${signIn}/hosts {"hosts":["bobs.example.com","sso.idp.test"]}`, `POST /sessions/${signIn}/reload `]);
  assert.deepEqual((await (await call('GET', '/logins/web/bobs/refused', undefined, bob)).json()).hosts, [{ host: 'cdn.idp.test', count: 1 }], 'what it reaches now is no longer refused');
  assert.equal((await call('POST', `/signins/${signIn}`, undefined, bob)).status, 200);

  // Bob asks to use it in a workspace; the server's model checks the website from his sign-in's hosts, and its owner approves.
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Own sites' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  assert.deepEqual(await said(await call('POST', '/grants', { site: 'bobs', workspace: ws, reason: '' }, bob)), [400, "a reason: what you'll use it for, for the workspace's owners"]);
  verdicts.push({ risk: 'low', flags: [], summary: "Bob's portal, signing in through idp.test.", title: 'Bobs Portal', hosts: ['*.bobs.example.com', 'sso.idp.test', 'graph.microsoft.com'], same: 'nosuch' });
  const { id: grant, check } = await (await call('POST', '/grants', { site: 'bobs', workspace: ws, reason: 'own pulls' }, bob)).json();
  assert.deepEqual(check, { risk: 'low', flags: [], summary: "Bob's portal, signing in through idp.test.", title: 'Bobs Portal', hosts: ['*.bobs.example.com', 'sso.idp.test'], same: null }, "graph's host never, nor a website that isn't here");
  const asked = JSON.parse(checks.at(-1)!.messages[1].content);
  assert.deepEqual([checks.at(-1)!.provider, asked.website.address, asked.signIn.blocked, asked.reason], [{ data_collection: 'deny' }, 'https://bobs.example.com/', ['sso.idp.test', 'cdn.idp.test'], 'own pulls'], 'hosts alone, from providers that keep no data');
  const pending = async () => (await (await call('GET', '/api')).json()).find((w: { id: string }) => w.id === ws).grants.map((g: { person: string; site: string; state: string; check: { risk: string } }) => [g.person, g.site, g.state, g.check.risk]);
  assert.deepEqual(await pending(), [[BOB, 'bobs', 'pending', 'low']], "under its owners' Waiting on you, with the check");
  assert.equal((await call('POST', `/grants/${grant}`, { approve: true }, bob)).status, 403, "a member doesn't approve");
  assert.equal((await call('POST', `/grants/${grant}`, { approve: true })).status, 200);
  assert.deepEqual([(await listed(bob)).hosts, (await listed(bob)).title], [['sso.idp.test', '*.bobs.example.com'], 'Bobs Portal'], "approving lets it reach what the check found, and names it");
  assert.deepEqual(await said(await allow('cdn.other.test')), [403, 'cdn.other.test is outside the domains Bobs Portal reaches, which its grants approved: an admin allows it']);

  // In a workspace bob owns, a check that rates the website high risk leaves it for an admin to approve.
  const { id: his } = await (await call('POST', '/api/workspaces', { name: "Bob's own" })).json();
  assert.equal((await call('PUT', `/api/workspaces/${his}`, { owners: [BOB] })).status, 200);
  verdicts.push({ risk: 'high', flags: ['looks like a lookalike'], summary: 'Not what it says.', title: '', hosts: [], same: null });
  const { id: risky } = await (await call('POST', '/grants', { site: 'bobs', workspace: his, reason: 'more pulls' }, bob)).json();
  assert.deepEqual(await said(await call('POST', `/grants/${risky}`, { approve: true }, bob)), [403, 'the check rates bobs high risk: an admin decides']);
  assert.equal((await call('POST', `/grants/${risky}`, { approve: true })).status, 200);

  // A run's browser was refused hosts: its own it reaches from then on, a tracker stays refused and unasked, and the rest, its CDN's
  // too, waits on its owner and admins, under Waiting on you, marked as the server's model says, until one of them allows it.
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Own pull' }, bob)).json();
  refused = ['https://cdn.idp.test/x.js', 'https://www.tracker.test/c', 'https://static.cdnhost.test/a.js', 'https://upload.elsewhere.test/x'];
  verdicts.push({ hosts: { 'www.tracker.test': 'tracker', 'static.cdnhost.test': 'cdn', 'upload.elsewhere.test': 'other' } });
  scripts.push({ bash: ['curl -s -m 5 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/bobs"'], report: 'Pulled.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-12', logins: ['web:bobs'] }, bob)).json();
  await runs(id, 1);
  await until('the hosts sorted', () => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').includes('"action":"allowed"'));
  assert.deepEqual(JSON.parse(checks.at(-1)!.messages[1].content).refused, { 'www.tracker.test': 1, 'static.cdnhost.test': 1, 'upload.elsewhere.test': 1 }, 'its own goes unasked');
  const log = readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.find(e => e.action === 'allowed').allowed, ['cdn.idp.test']);
  assert.deepEqual([(await listed(bob)).hosts.slice(2), (await listed(bob)).classes], [['cdn.idp.test'], { 'www.tracker.test': 'tracker', 'static.cdnhost.test': 'cdn', 'upload.elsewhere.test': 'other' }]);
  const waits = async (cookie = bob) => (await (await call('GET', '/api', undefined, cookie)).json()).flatMap((w: any) => w.series.flatMap((s: any) => s.instances)).find((i: { id: string }) => i.id === id).refused.map((r: { hosts: string[] }) => r.hosts);
  assert.deepEqual([await waits(), await waits(admin)], [[['static.cdnhost.test', 'upload.elsewhere.test']], [['static.cdnhost.test', 'upload.elsewhere.test']]], "only a person allows what the website doesn't own");
  assert.equal((await allow('upload.elsewhere.test')).status, 403, 'outside its domains, now its grants are approved');
  for (const host of ['upload.elsewhere.test', 'static.cdnhost.test']) assert.equal((await allow(host, admin)).status, 200);
  assert.deepEqual(await waits(), []);

  // An admin switches it off, for no one to use, and on again; its owner removes it, as no one else has a grant to it.
  assert.deepEqual(await said(await call('PATCH', '/logins/sites/bobs', { off: true }, bob)), [403, 'off: admins set it']);
  assert.equal((await call('PATCH', '/logins/sites/bobs', { off: true })).status, 200);
  assert.deepEqual([(await listed(bob)).off, (await call('POST', '/logins/web/bobs', {}, bob)).status], [true, 403]);
  assert.equal((await call('PATCH', '/logins/sites/bobs', { off: false })).status, 200);
  assert.equal((await listed(bob)).off, undefined);
  assert.equal((await call('DELETE', '/logins/sites/bobs', undefined, carol)).status, 403);
  assert.equal((await call('DELETE', '/logins/sites/bobs', undefined, bob)).status, 200, 'his alone, with only his own grants to it');
  assert.deepEqual([await listed(admin), (await (await call('GET', '/logins', undefined, bob)).json()).some((l: { id: string }) => l.id === 'web:bobs'), await pending()], [undefined, false, []], 'its grants and logins go with it');
  refused = [];
});

test('saving a sign-in keeps its login alive until the time given, for those admins grant keepalive', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString(), save = async () => {
    const { id } = await (await call('POST', '/logins/web/kept', {}, bob)).json(), res = await call('POST', `/signins/${id}`, { keepalive: until }, bob);
    if (res.status !== 200) await call('DELETE', `/signins/${id}`, undefined, bob);
    return [res.status, await res.text()];
  };
  assert.equal((await call('POST', '/logins/sites', { name: 'kept', url: 'https://kept.example.com/' })).status, 200);
  assert.deepEqual(await save(), [403, 'keeping a login alive is for admins and those they grant keepalive: ask an admin']);
  assert.equal((await call('PUT', '/capabilities', { cap: 'keepalive', people: [BOB] })).status, 200);
  assert.deepEqual(await save(), [200, 'ok']);
  assert.equal((await (await call('GET', '/logins', undefined, bob)).json()).find((l: { id: string }) => l.id === 'web:kept').keepalive, until);
  assert.equal((await call('DELETE', '/logins/sites/kept')).status, 200);
  assert.ok(!(await (await call('GET', '/logins', undefined, bob)).json()).some((l: { id: string }) => l.id === 'web:kept'), "removed, it takes everyone's login to it");
});

test("a run's Pi idles only with nothing but Pi running in its sandbox, and ends as more Pis idle than RF_MAX_IDLE, past RF_IDLE_MIN, or as its instance closes or is abandoned", async () => {
  proc.kill();
  await once(proc, 'exit');
  await serve({ RF_IDLE_MIN: '0.1', RF_MAX_IDLE: '1' });
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Idle' })).json();
  // Whether an instance's Pi is there: its sandbox's scratch folder, named for its token, holds the bwrap arguments setting its id.
  const runsDir = join(tmp, 'scratch', 'runs'), pi = (id: string) => readdirSync(runsDir).some(t => readFileSync(join(runsDir, t, 'bwrap.args'), 'utf8').includes(`RF_INSTANCE\0${id}\0`));
  const gone = async (id: string, why: string, tries = 10) => {
    for (let i = 0; pi(id); i++) {
      assert.ok(i < tries, why);
      await new Promise(ok => setTimeout(ok, 200));
    }
  };
  // An instance of a series of its own, as a series holds at most 3 open, its first run done.
  const start = async (name: string, bash: string[] = []) => {
    scripts.push({ bash, report: 'Done.', saw: [] });
    const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name })).json();
    const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
    await runs(id, 1);
    return id as string;
  };
  // The session the instance's next run carries on, if any.
  const again = async (id: string, n: number) => {
    scripts.push({ bash: [], report: 'Again.', saw: [] });
    assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: `Once more, run ${n}.` })).status, 200);
    return (await runs(id, n)).find(e => e.op === 'run' && e.run === n)!.continues;
  };
  const job = await start('job', ['nohup sleep 120 >/dev/null 2>&1 &']);
  await gone(job, 'a run that left a job running stops its Pi, the job with it');
  assert.equal(await again(job, 2), undefined);
  const a = await start('a'), b = await start('b');
  await gone(a, 'the longest idle ends as another idles past RF_MAX_IDLE');
  assert.equal(await again(b, 2), 1, 'the idle one carries its session on');
  const old = await start('old');
  await gone(old, 'past RF_IDLE_MIN its Pi ends', 100);
  assert.equal(await again(old, 2), undefined);
  for (const act of ['close', 'abandon']) {
    const id = await start(act);
    assert.ok(pi(id));
    assert.equal((await call('POST', `/api/instances/${id}/${act}`, {})).status, 200);
    await gone(id, `its instance's ${act} ends its idle Pi`);
  }
  proc.kill();
  await once(proc, 'exit');
  await serve();
});

test("every entry names its source: a person, a run whose entry names its runner and the act whose ticks it uses, or what caused it", () => {
  const logs = new Map(readdirSync(join(root, 'instances')).map(id => [id, readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, any>)]));
  for (const [id, log] of logs) for (const e of log) {
    const run = e.run !== undefined && logs.get(e.see?.inst ?? id)!.find(r => r.op === 'run' && r.run === e.run);
    const cause = typeof e.cause === 'number' && log[e.cause - 1];
    assert.ok(e.by.includes('@') || (run && run.runner && run.consent) || (cause && cause.seq < e.seq) || (e.op === 'wake' && e.from !== 'server'), `${id}: ${JSON.stringify(e)}`);
  }
});
