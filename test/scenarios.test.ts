import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { idp } from './idp.ts';

// Real runs, from a person's act down to Pi in its sandbox, with a scripted stand-in for OpenRouter: each run's prompt takes the
// next script, bash commands and then the report, and the stand-in keeps what each command answered. So the walls a run meets, a
// wake and a takeover are checked as a run meets them, at no model cost.
type Script = { bash: (string | (() => string | Promise<string>))[]; report: string; prompt?: string; system?: string; first?: number; saw: string[]; fail?: string; hold?: () => void };
const scripts: Script[] = [], byPrompt = new Map<string, Script>(), providers: unknown[] = [], keys: string[] = [];
// The shared website check, on Save or for new run hosts, consumes queued verdicts; ordinary lifecycle sign-ins get a profile.
const checks: { provider: unknown; messages: { content: string }[] }[] = [], verdicts: (object | string)[] = [];
const profile = { what: 'Example Company operates this business portal.', category: 'company', risk: 'low', flags: [] };
const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-scenario-')), root = join(tmp, 'data');
const ADMIN = 'admin@demo.test', BOB = 'bob@demo.test';
let model: ReturnType<typeof createServer>, proc: ChildProcess, base = '', admin = '', bob = '', sessions = 0;
// The browser service, a stand-in: the browsers it opens are b1, b2…, each with a person in control and a live view, and a websocket
// to one answers with the path it reached. Their pages asked for the addresses in `refused`, which they don't reach; what else they
// were told, as hosts allowed, is in `told`.
let refused: string[] = [], holdCdp = false, holdView = false, cdpOpened = 0, cdpClosed = 0, closeDelayMs = 0;
let browserLog: { method: string; url: string; status: number; dest?: string; from?: string }[] = [];
let browserState: { cookies: { domain: string; name: string; value: string }[]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] } = { cookies: [], origins: [] };
const told: string[] = [], openings: { site: { hosts: string[]; open?: boolean; public?: boolean; except?: string[]; start_url?: string }; state?: unknown; ttl_s: number }[] = [];
const service = createServer(async (req, res) => {
  const blocked = refused.map(url => ({ method: 'GET', url, status: 403, blocked: 'host not on the list' })), log = [...browserLog, ...blocked];
  if (req.method === 'GET' && new URL(req.url!, 'http://browser').pathname === '/blocked') return void res.end('{}');
  if (req.method === 'POST' && req.url === '/sessions') {
    openings.push(JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()));
    return void res.writeHead(201).end(JSON.stringify({ id: `b${++sessions}` }));
  }
  if (req.method === 'PUT' || req.method === 'POST') return void res.end((told.push(`${req.method} ${req.url} ${Buffer.concat(await Array.fromAsync(req)).toString()}`), '{}'));
  if (req.method === 'DELETE') {
    if (closeDelayMs) await new Promise(r => setTimeout(r, closeDelayMs));
    return void res.end(JSON.stringify({ state: browserState, log }));
  }
  res.end(req.url === '/sessions' ? '[]' : req.url!.endsWith('/log') ? JSON.stringify([{ live: true }, ...log]) : req.url!.endsWith('/view') ? 'the live view' : '');
}).on('upgrade', (req, socket) => {
  if (holdCdp && req.url!.endsWith('/cdp')) {
    cdpOpened++;
    socket.on('end', () => { cdpClosed++; socket.destroy(); });
    socket.resume();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n');
  } else if (holdView && req.url!.includes('/view/')) socket.on('error', () => {}).write('HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n');
  else socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nservice got ${req.url}`);
});

const text = (c: unknown): string => typeof c === 'string' ? c : (c as { type: string; text?: string; content?: unknown }[]).map(b => b.text ?? (b.content === undefined ? '' : text(b.content))).join('');
const isResult = (m: { role: string; content: unknown }) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === 'tool_result');

// The Anthropic Messages API, streamed, as Pi reaches OpenRouter's: the next step of the script for the latest prompt, each answer
// costing a cent, unless the key is out of credits; and a chat completion, for a script's own call.
async function answer(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  if (body.response_format) {
    checks.push(body);
    const verdict = verdicts.length ? verdicts.shift()! : { profile, hosts: {} };
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof verdict === 'string' ? verdict : JSON.stringify(verdict) } }], usage: { cost: 0.003 } }));
  }
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

// A Databricks workspace's warehouse, wh1: its statements answer once `statement` lets them go, each counted as it comes.
let statement = Promise.resolve(), statements = 0;
async function warehouse(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'POST') {
    statements++;
    await statement;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.method === 'POST' ? { statement_id: 's1', status: { state: 'SUCCEEDED' } } : { id: 'wh1', name: 'Finance' }));
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
  model = createServer((req, res) => (req.url!.startsWith('/api/2.0/sql/') ? warehouse(req, res) : req.method === 'POST' && /\/(messages|chat\/completions)$/.test(new URL(req.url!, 'http://x').pathname) ? answer(req, res)
    : req.url === '/api/v1/key' && /^Bearer (sk-or-|stand-in-key$)/.test(String(req.headers.authorization))
      ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { label: 'sk-or-v1-stand...in', usage: 10, usage_daily: 0.5, limit: 500, limit_remaining: 490, limit_reset: 'monthly' } }))
      : res.writeHead(404).end('{}')));
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
// Pi's own calls among them, and of the Databricks workspace adb-1, to the stand-ins.
async function serve(env: NodeJS.ProcessEnv = {}) {
  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = upstreams['adb-1.azuredatabricks.net'] = 'http://127.0.0.1:${(model.address() as { port: number }).port}';`;
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

test('a Pi killed mid-turn fails its run at once, frees its series, and starts a new session on the next act, which no earlier run could have written', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Crash' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  // The session the next run would start as its own, were its id run-2.
  const plant = `printf '%s\\n' '{"type":"session","version":3,"id":"run-2","timestamp":"2020-01-01T00:00:00.000Z","cwd":"'"$PWD"'"}' \\
    '{"type":"message","id":"a1","parentId":null,"timestamp":"2020-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"PLANTED"}],"timestamp":1577836801000}}' > session/2020-01-01T00-00-00-000Z_run-2.jsonl`;
  scripts.push({ bash: [plant, 'kill -9 2'], report: 'unreached', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  const done = (await runs(id, 1)).find(e => e.op === 'done')!;
  assert.equal(done.aborted, true);
  assert.match(done.error as string, /Pi exited.*(code|signal)/);
  assert.equal((await call('POST', `/api/instances/${id}/interrupt`)).status, 409, 'no run remains to interrupt');
  const fresh: Script = { bash: [], report: 'A new session.', saw: [] };
  scripts.push(fresh);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Carry on.' })).status, 200);
  const log = await runs(id, 2);
  assert.equal(log.findLast(e => e.op === 'run')!.continues, undefined);
  assert.equal(fresh.first, 1, 'a conversation of its own prompt alone, never one run 1 left for it');
  assert.equal(log.findLast(e => e.op === 'done')!.aborted, false);
});

test("a series' .pylib runs nothing unasked in a later run, and each run entry hashes its listing, which the instance's pylib.tsv holds and its commit keeps", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Pylib' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  const hooks = 'cd ../.pylib && mkdir -p pkg usercustomize/deep && echo X=1 > pkg/__init__.py && echo "print(\'HOOK\')" | tee sitecustomize.py usercustomize/__init__.py > evil.pth && chmod 0 usercustomize/deep && echo ok';
  scripts.push({ bash: [hooks], report: 'Installed.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  const next: Script = { bash: ['python -c "import pkg; print(pkg.X)"; ls -A ../.pylib; cat pylib.tsv'], report: 'Ran.', saw: [] };
  scripts.push(next);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Again.' })).status, 200);
  const log = await runs(id, 2), [one, two] = log.filter(e => e.op === 'run');
  assert.match(next.saw[0], /^1\npkg\npkg\/__init__\.py\t4\t\d{4}-\d\d-\d\dT[\d:.]+Z\n?$/, 'what pip would install runs; sitecustomize, usercustomize and .pth files are gone before it, and pylib.tsv lists the rest');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: join(root, 'instances', id), encoding: 'utf8' });
  await until("run 2's commit", () => git('log', '-1', '--format=%s') === 'Run 2\n');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex'), listed = git('show', 'HEAD:pylib.tsv');
  assert.ok(next.saw[0].endsWith(`\n${listed}`), "run 2's commit keeps the listing it started with");
  assert.deepEqual([one.pylib, two.pylib], [sha(''), sha(listed)], 'each run entry hashes it');
});

test('the time limit fails a run with its reason, rather than recording an ordinary interrupt', async () => {
  proc.kill('SIGKILL');
  await once(proc, 'exit');
  await serve({ RF_LIMIT_MIN: '0.02' });
  try {
    const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Limit' })).json();
    const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
    scripts.push({ bash: ['sleep 30'], report: 'unreached', saw: [] });
    const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
    const done = (await runs(id, 1)).find(e => e.op === 'done')!;
    assert.deepEqual([done.aborted, done.error], [true, 'time limit']);
    const history = await (await call('GET', '/api/runs')).json();
    const failed = history.find((r: { path: string }) => r.path === 'Limit/Rec/2026-11');
    assert.deepEqual([failed.outcome, failed.failure], ['failed', 'time limit']);
  } finally {
    await cut();
  }
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
  assert.equal((await call('PUT', `/api/workspaces/${wide}/readers/${ws}`)).status, 200);
  assert.equal((await call('POST', '/api/series', { workspace: wide, name: 'Close' })).status, 200);
  const walls: Script = {
    bash: [
      `cat ${join(root, '.rf', 'seal.key')} 2>&1 | head -1`,
      `curl -s -m 5 ${base}/api 2>&1; echo "curl exit $?"`,
      'curl -s -m 5 https://10.1.2.3/ 2>&1; echo "curl exit $?"',
      'curl -s -m 10 https://graph.microsoft.com/v1.0/users/ceo@demo.test/messages 2>&1',
      () => `rf wake . ${new Date(Date.now() + 8000).toISOString()} the bank file is due 2>&1`,
      'rf wake ../../../Wide/Close now --label 2026-11 2>&1',
      'rf wake . soon 2>&1',
      'rf wake .. +1d 2>&1',
      () => `rf say --in ${thread} Walls checked. 2>&1`,
      'rf say --in c99 x 2>&1',
      'rf show 2>&1 | head -c 200',
      'rf ask --to stranger@example.com Which bank? 2>&1',
      'rf ask Is the bank file coming today? 2>&1',
      'rf say --on nope x 2>&1',
      () => `rf say --in ${walls.saw[12].match(/c\d+/)![0]} It came, never mind. 2>&1; rf withdraw ${walls.saw[12].match(/c\d+/)![0]} It came. 2>&1`,
      `curl -s -m 10 https://openrouter.ai/api/v1/chat/completions -H 'content-type: application/json' -d '{"model": "openai/gpt-5-mini", "messages": [{"role": "user", "content": "Is this right?"}]}'`,
      'curl -s -m 10 https://openrouter.ai/api/v1/credits',
      'echo 1 > working/x.csv && rf say "Cited [x](working/x.csv), as [last time](../2026-11/working/x.csv)." 2>&1',
      'curl -s -m 5 -X POST -H "authorization: Bearer $RF_TOKEN" "$RF_URL/api/instances/$RF_INSTANCE/close"; echo',
      'curl -s -m 5 -H "authorization: Bearer $RF_TOKEN" "$RF_URL/api/workspaces"; echo',
      'rf ask --sign-off Sure. 2>&1',
      'curl -s -m 5 -w "\\n%{http_code}" -X POST -H "authorization: Bearer $RF_TOKEN" "$RF_URL/api/instances/$RF_INSTANCE/delete"',
      'for a in assign takeover; do curl -s -m 5 -w " %{http_code};" -X POST -H "authorization: Bearer $RF_TOKEN" -d \'{"to": "bob@demo.test"}\' "$RF_URL/api/instances/$RF_INSTANCE/$a"; done',
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
  assert.match(walls.saw[14], new RegExp(`^said c\\d+, under ${walls.saw[12].trim().slice(6)}\\nwithdrew ${walls.saw[12].trim().slice(6)}\\s*$`), 'a reply under its own question withdraws nothing, rf withdraw does');
  assert.match(walls.saw[15], /"content":"A second opinion"/, 'any model, through OpenRouter, with the server\'s key');
  assert.match(walls.saw[16], /^\{\}\s*$/, "any request reaches OpenRouter, with the server's key");
  assert.match(walls.saw[17], /^said c\d+\s*$/, 'a post links files in its text');
  assert.deepEqual([walls.saw[18].trim(), walls.saw[19].trim()], ['not found', 'not found'], "a run's token does only what a run may: not close its instance, nor read what people do"); 
  assert.match(walls.saw[20], /^rf ask has no --sign-off\nrf ask \[--in cN/, 'an option it has not is no part of the text');
  assert.equal(walls.saw[21].trim(), 'not found\n404', 'even a workspace manager\'s run cannot delete');
  assert.equal(walls.saw[22].trim(), 'not found 404;not found 404;', 'nor assign, nor take over');
  const asked = log.filter(e => e.op === 'call' && e.name === 'openrouter'), pi = asked.filter(e => (e.path as string).startsWith('/api/v1/messages'));
  assert.deepEqual(asked.filter(e => !pi.includes(e)).map(e => [e.run, e.method, e.path, e.status, e.model, e.cost]), [[2, 'POST', '/api/v1/chat/completions', 200, 'openai/gpt-5-mini', 0.002], [2, 'GET', '/api/v1/credits', 404, undefined, 0]]);
  assert.deepEqual(pi.map(e => [e.run, e.method, e.status, e.model, e.cost]), [[1, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01], ...Array(walls.bash.length + 1).fill([2, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01]), ...Array(2).fill([3, 'POST', 200, 'anthropic/claude-opus-5.5', 0.01])], "Pi's own calls, a step's each and the report's, through the same connection");
  assert.ok(providers.length && providers.every(p => JSON.stringify(p) === '{"data_collection":"deny"}'), 'every call asked only for providers that collect no data');
  assert.deepEqual(log.filter(e => e.op === 'comment' && e.by === 'agent').map(e => [e.text, !!e.ask]), [['Walls checked.', false], ['Is the bank file coming today?', true], ['It came, never mind.', false], ['Cited [x](working/x.csv), as [last time](../2026-11/working/x.csv).', false]], "the agent's words are comments of its own, and an ask is marked");
  assert.match(woken.prompt!, /"op":"wake","from":"[^"]*\/2026-11","text":"the bank file is due"/, 'the wake started the next run, saying who set it and what it said');
  assert.match(made.prompt!, /^Instance 2026-11, run 1\. Its runner is Demo Admin <admin@demo\.test>, who lends you /, 'a new Pi hears who the runner is');
  assert.deepEqual([made.first, walls.first], [1, 1], 'a new conversation, of its own prompt alone, as a series made in reach since changed what run 2 sees');
  assert.ok(woken.first! > 1, 'a run within the hour of the last carries its conversation on, as a new turn');
  assert.match(woken.prompt!, /^Instance 2026-11, run 3\. New log entries:/, 'whose message is the new log entries');
  const transcripts = readdirSync(join(root, 'instances', id, 'session'));
  assert.ok(['run-1', 'run-2'].every(r => transcripts.some(f => new RegExp(`_${r}-[0-9a-f]{16}\\.jsonl$`).test(f))) && !transcripts.some(f => f.includes('_run-3-')), `a transcript per session: ${transcripts}`);
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

test("assigning mid-run stops the run first, as Interrupt does, saying why; the next run, a new session, waits for the new runner's act and brings what came before as notes, and an ask from before that named no one waits on the new runner", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Handover' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  let going!: () => void;
  const sleeping = new Promise<void>(ok => { going = ok; });
  scripts.push({ bash: [`rf ask 'Which account?'`, () => (going(), 'sleep 60')], report: 'unreached', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json(), path = `/api/instances/${id}`;
  await sleeping;
  assert.equal((await call('POST', `${path}/comment`, { text: 'Cut off at the 25th.', quiet: true })).status, 200);
  const refused = await call('POST', `${path}/assign`, {}, bob);
  assert.deepEqual([refused.status, await refused.text()], [409, `run 1 is going: take it over once it ends, or ask its runner, ${ADMIN}, the workspace's owners or admins, who may stop it`]);
  const unwarned = await call('POST', `${path}/assign`, { to: BOB, stops: null });
  assert.deepEqual([unwarned.status, await unwarned.text()], [409, 'run 1 started since you looked: assigning it now stops it'], "the page, which said no run would be stopped, stops none");
  assert.equal((await call('POST', `${path}/assign`, { to: BOB })).status, 200, 'rf stops it, as its help says');
  let log = await runs(id, 1);
  const stopped = log.find(e => e.op === 'interrupt')!, made = log.find(e => e.op === 'assign')!;
  assert.deepEqual([stopped.by, stopped.why, made.to, made.seq > stopped.seq], [ADMIN, `to assign it to ${BOB}`, BOB, true], 'stopped, saying who and why, then assigned');
  assert.equal(log.find(e => e.op === 'done')!.aborted, true);
  await new Promise(ok => setTimeout(ok, 2500));
  const { log: still, waiting } = await (await call('GET', path, undefined, bob)).json();
  assert.equal(still.filter((e: { op: string }) => e.op === 'run').length, 1, 'the assign starts no run');
  assert.deepEqual(waiting.map((w: { who: string; seq: number }) => [w.who, still[w.seq - 1].by]), [[BOB, 'agent'], [BOB, ADMIN]], "the agent's ask, which named no one, and the previous runner's comment, which no run read, a note now, wait on the new one");

  const carol = await login('carol@demo.test'), dana = await login('dana@demo.test');
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB, 'carol@demo.test', 'dana@demo.test'] })).status, 200);
  let going2!: () => void;
  const sleeping2 = new Promise<void>(ok => { going2 = ok; });
  scripts.push({ bash: [() => (going2(), 'sleep 60')], report: 'unreached', saw: [] });
  const { id: id2 } = await (await call('POST', `/api/series/${series}`, { label: '2026-12', logins: [] }, bob)).json();
  await sleeping2;
  const [a1, a2] = await Promise.all([
    call('POST', `/api/instances/${id2}/assign`, { to: 'carol@demo.test' }, bob),
    call('POST', `/api/instances/${id2}/assign`, { to: 'dana@demo.test' }, bob),
  ]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 403], 'only the first assign by non-owner Bob succeeds while interrupt stops the run');
  await runs(id2, 1);
  void [carol, dana];
  const next: Script = { bash: [], report: 'Taken up.', saw: [] };
  scripts.push(next);
  assert.equal((await call('POST', `${path}/comment`, { text: 'Mine now.' }, bob)).status, 200);
  log = await runs(id, 2);
  assert.equal(next.first, 1, 'a new session');
  assert.match(next.prompt!, new RegExp(`Its runner is now .+ <${BOB}>, assigned by .+ <${ADMIN}> from .+ <${ADMIN}>, who lends you no login\\.`));
  assert.match(next.prompt!, /"text":"Cut off at the 25th\.","quiet":true,"note":true/, 'what came before, a note');
  assert.match(next.prompt!, /"by":"bob@demo\.test","op":"comment","thread":"c\d+","item":null,"ref":null,"text":"Mine now\."\}/, "the new runner's word");
});

test("from Interrupt on, a run's token opens nothing: what the run still sends as it stops, as a comment or a wake, is refused, however long Pi takes to settle", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Stopping' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  // Out of the tool's process group, so the abort leaves it, it keeps writing to the tool's output, which keeps Pi from settling,
  // until what it sends once the interrupt is logged is answered.
  const late = `setsid sh -c 'touch working/waiting; until grep -q op.:.interrupt log.jsonl; do echo .; sleep 0.05; done
    (rf say Late. > working/late 2>&1; rf wake . +1d >> working/late 2>&1; touch working/sent) &
    until [ -e working/sent ]; do echo .; sleep 0.05; done' & sleep 60`;
  scripts.push({ bash: [late], report: 'unreached', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json(), dir = join(root, 'instances', id);
  await until('the run waiting', () => existsSync(join(dir, 'working', 'waiting')));
  assert.equal((await call('POST', `/api/instances/${id}/interrupt`)).status, 200);
  const log = await runs(id, 1);
  assert.equal(readFileSync(join(dir, 'working', 'late'), 'utf8'), 'no run for this token\n'.repeat(2), 'rf say, then rf wake, sent once the interrupt is logged');
  assert.deepEqual(log.filter(e => e.op === 'comment'), [], 'nothing it said');
  const wakes = join(root, '.rf', 'wakes.json');
  assert.ok(!existsSync(wakes) || !readFileSync(wakes, 'utf8').includes(id), 'nor a wake set');
  assert.equal(log.find(e => e.op === 'done')!.aborted, true);
});

test('Interrupt and Assign terminate a run whose in-sandbox Pi is frozen with SIGSTOP rather than failing on RPC', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'FrozenPi' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  scripts.push({ bash: ['touch working/frozen && kill -STOP 2 && sleep 60'], report: 'unreached', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json(), dir = join(root, 'instances', id);
  await until('Pi frozen', () => existsSync(join(dir, 'working', 'frozen')));
  await new Promise(ok => setTimeout(ok, 200));
  const r = await call('POST', `/api/instances/${id}/assign`, { to: BOB, stops: 1 });
  assert.equal(r.status, 200, await r.clone().text());
  const log = await runs(id, 1);
  assert.equal(log.find(e => e.op === 'done')!.aborted, true);
  assert.equal(log.find(e => e.op === 'assign')!.to, BOB);
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
  const during: Script = { bash: [rename, 'rf wake . +1d 2>&1; rf say Cited. 2>&1'], report: 'Renamed under me.', saw: [] };
  const next: Script = { bash: ['pwd; cat names.tsv'], report: 'New names.', saw: [] };
  scripts.push(during, next);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Go.' })).status, 200);
  await runs(id, 2);
  const [pwd, ...names] = during.saw[0].trim().split('\n');
  assert.deepEqual([pwd, names.filter(l => l.startsWith(id))], ['/work/Named/Before/2026-11', [`${id}\t/work/Named/Before/2026-11`]]);
  assert.match(during.saw[1], /^set: \. wakes at .*\nsaid c\d+\s*$/);
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

test('an archived series or workspace does no work: one with a run going is archived once the run ends, and what waited for a run as it was archived runs once it is restored', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Shelf' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  let mid: unknown[] = [];
  const archive = async () => {
    const r = await call('PUT', `/api/series/${series}`, { archived: true });
    mid = [r.status, await r.text()];
    return 'true';
  };
  scripts.push({ bash: [archive], report: 'Made.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  assert.deepEqual(mid, [409, 'Shelf/Rec/2026-11 is running: archive Rec once its run ends, or interrupt it first']);
  // A comment, and its workspace archived before the comment's run starts.
  const waited: Script = { bash: [], report: 'Carried on.', saw: [] };
  scripts.push(waited);
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Go on.' })).status, 200);
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { archived: true })).status, 200);
  await new Promise(ok => setTimeout(ok, 3000));
  assert.equal((await runs(id, 1)).filter(e => e.op === 'run').length, 1, 'no run starts while it is archived');
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'And?' })).status, 409);
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { archived: false })).status, 200);
  await runs(id, 2);
  assert.match(waited.prompt!, /Go on\./, 'restored, the run that waited starts');
});

test("a run reads what its workspace's links let it as it started: someone joining changes nothing, while a link taken off, or its series moving, cuts it at once, and its instance carries on in a run of the new view", async () => {
  const workspace = async (name: string) => (await (await call('POST', '/api/workspaces', { name })).json()).id as string;
  const source = await workspace('Lease source'), reader = await workspace('Lease reader'), elsewhere = await workspace('Lease elsewhere');
  const { id: ledger } = await (await call('POST', '/api/series', { workspace: source, name: 'Ledger' })).json();
  assert.equal((await call('POST', `/api/series/${ledger}`, { label: '2026-11', logins: [], quiet: true })).status, 200);
  assert.equal((await call('PUT', `/api/workspaces/${source}/readers/${reader}`)).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: reader, name: 'Report' })).json();
  const linked: Script = { bash: ['ls /work', async () => {
    assert.equal((await call('PUT', `/api/workspaces/${reader}`, { members: ['carol@demo.test'] })).status, 200);
    return 'ls /work';
  }, async () => {
    assert.equal((await call('DELETE', `/api/workspaces/${source}/readers/${reader}`)).status, 200);
    return 'sleep 60';
  }], report: 'Never said.', saw: [] };
  const moved: Script = { bash: ['ls /work', async () => {
    assert.equal((await call('PUT', `/api/proposals/${reader}`, { kind: 'move', series, to: elsewhere })).status, 200);
    assert.equal((await call('POST', `/api/proposals/${reader}`, { owners: [], members: [] })).status, 200, 'accepted though a run of what moves is going');
    return 'sleep 60';
  }], report: 'Never said.', saw: [] };
  const after: Script = { bash: ['pwd'], report: 'Carried on.', saw: [] };
  scripts.push(linked, moved, after);
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  const log = await runs(id, 3), done = log.filter(e => e.op === 'done'), leases = (ls: string) => ls.split('\n').filter(l => l.startsWith('Lease'));
  assert.deepEqual(leases(linked.saw[0]), ['Lease reader', 'Lease source'], 'its workspace is a reader of the other');
  assert.deepEqual(leases(linked.saw[1]), ['Lease reader', 'Lease source'], 'Carol joining changes nothing it reads');
  assert.deepEqual(leases(moved.saw[0]), ['Lease reader'], 'the link taken off, it no longer reads the other');
  assert.equal(after.saw[0].trim(), '/work/Lease elsewhere/Report/2026-11');
  assert.deepEqual(done.map(e => [e.aborted, e.error]), [[true, 'its reach narrowed'], [true, 'its series moved'], [false, undefined]]);
  assert.deepEqual(log.filter(e => e.op === 'wake' && e.from === 'server').map(e => [e.reason, log[(e.cause as number) - 1].op]),
    [['Run 1 was cut: its reach narrowed; carry on', 'done'], ['Run 2 was cut: its series moved; carry on', 'done']]);
  assert.ok(log.findIndex(e => e.op === 'move') < log.indexOf(done[1]), 'the cut follows the change');
  const ran = (await (await call('GET', '/api/runs')).json()).filter((r: { path: string }) => r.path === 'Lease elsewhere/Report/2026-11');
  assert.deepEqual(ran.map((r: { outcome: string }) => r.outcome), ['cut', 'cut', 'done'], 'each carried on by the next, as after a restart');
});

test("approvals are git commits: the agent commits a moment worth keeping and proposes what it will do; anyone who sees the instance approves it in their name, someone else's a note for the runner, or rejects it, once; a reply under it approves nothing, a question takes no approval, and the agent withdraws what it no longer needs; closing commits as the runner's", async () => {
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
      'rf propose "The pack is ready to send to the bank: [pack](working/pack.csv)" 2>&1',
      'rf ask "Which bank account does it go to?" 2>&1',
      'rf propose "Send a copy to the auditors too?" 2>&1',
    ],
    report: 'Built the pack; proposed sending it.', saw: [],
  };
  const question = () => ask.saw[4].match(/c\d+/)![0];
  const again: Script = {
    bash: [
      'echo 250 > working/pack.csv && rf propose "The rate is fixed: send it now?" 2>&1',
      () => `rf withdraw ${question()} --see ${ask.saw[3].match(/c\d+/)![0]} The file names the account. 2>&1`,
      () => `rf withdraw ${question()} Again. 2>&1`,
      'rf withdraw c1 2>&1',
    ],
    report: 'Fixed the rate in place; proposed again.', saw: [],
  };
  const approved: Script = { bash: [], report: 'Approved: sending.', saw: [] };
  scripts.push(ask, again, approved);

  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Build the pack.' })).status, 200);
  let log = await runs(id, 2);
  assert.match(ask.saw[0], /^committed [0-9a-f]{40}\s*$/);
  assert.match(ask.saw[1], /^rollforward agent\|Draft pack built\n[^]* M working\/pack.csv/, 'the run reads its history, and sees what changed since');
  assert.match(ask.saw[2], /Read-only file system|Permission denied|unable to/i, 'and never writes it');
  assert.match(ask.saw[3], /^proposed c\d+/);
  assert.match(ask.saw[4], /^asked c\d+/);
  assert.deepEqual(log.filter(e => e.op === 'commit').map(e => [e.by, e.run, e.message, e.commit]), [['agent', 2, 'Draft pack built', git('rev-parse', ':/^Draft pack built')]]);
  const first = log.find(e => e.op === 'comment' && e.ask === 'proposal')!, auditors = log.findLast(e => e.op === 'comment' && e.ask === 'proposal')!, pack = join(dir, 'working', 'pack.csv');
  const decide = (how: string, body: object, cookie = admin) => call('POST', `/api/instances/${id}/${how}`, { thread: first.thread, ...body }, cookie);
  assert.deepEqual([first.files, statSync(pack).mode & 0o222 && 'writable'], [undefined, 'writable'], 'what it links stays the agent\'s');
  const refused = await decide('signoff', { thread: question() });
  assert.deepEqual([refused.status, await refused.text()], [409, `${question()} is no proposal of the agent's`], 'a question takes no approval');

  assert.equal((await decide('signoff', { text: 'Fine by me.' }, bob)).status, 200, 'anyone who sees it');
  ({ log } = await (await call('GET', `/api/instances/${id}`)).json());
  const bobs = log.findLast(e => e.op === 'signoff')!;
  assert.deepEqual([bobs.by, bobs.on, bobs.note, log.filter(e => e.op === 'run').length], [BOB, first.seq, true, 2], "someone else's is a note for the runner, which starts no run");
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%B', String(bobs.commit)), `Bob <${BOB}>\nThe pack is ready to send to the bank: [pack](working/pack.csv)\n\nFine by me.\n\nSigned-off-by: Bob <${BOB}>`);
  assert.equal(git('show', `${bobs.commit}:working/pack.csv`), '200', 'the folder as they said yes');
  for (const how of ['signoff', 'reject']) {
    const again = await decide(how, { text: 'Use the new rate.' });
    assert.deepEqual([again.status, await again.text()], [409, `${first.thread} was approved already, by ${BOB}`], 'a proposal is approved or rejected once');
  }
  assert.equal((await decide('reject', { thread: auditors.thread, text: 'Use the new rate.' })).status, 200, 'the runner says no');
  log = await runs(id, 3);
  const no = log.findLast(e => e.op === 'reject')!;
  assert.deepEqual([no.by, no.thread, no.on, no.text, no.commit], [ADMIN, auditors.thread, auditors.seq, 'Use the new rate.', undefined], 'a rejection commits nothing');
  const twice = await decide('signoff', { thread: auditors.thread });
  assert.deepEqual([twice.status, await twice.text()], [409, `${auditors.thread} was rejected already, by ${ADMIN}`]);
  assert.match(again.prompt!, /"op":"signoff".*"note":true[^]*"op":"reject".*"text":"Use the new rate\."/, 'the run reads the note, then the rejection');
  assert.match(again.saw[1], new RegExp(`^withdrew ${question()}\\s*$`));
  assert.match(again.saw[2], new RegExp(`${question()} is no question or proposal of yours still waiting; those that are: c\\d+`), 'once');
  assert.match(again.saw[3], /^rf withdraw cN \[--see cM\] REASON/, 'a withdrawal says why');
  const withdrawn = log.find(e => e.op === 'withdraw')!;
  assert.deepEqual([withdrawn.by, withdrawn.run, `c${withdrawn.on}`, withdrawn.text, withdrawn.see], ['agent', 3, question(), 'The file names the account.', first.seq]);

  const next = log.findLast(e => e.op === 'comment' && e.ask === 'proposal')!, waiting = async () => (await (await call('GET', `/api/instances/${id}`)).json()).waiting.map((w: { seq: number }) => w.seq);
  assert.deepEqual(await waiting(), [next.seq], 'a rejected proposal and a withdrawn question wait no more');
  assert.equal((await decide('comment', { thread: next.thread, text: 'Go ahead.', quiet: true })).status, 200);
  assert.deepEqual(await waiting(), [next.seq], 'a reply, however worded, approves nothing');
  assert.equal((await decide('signoff', { thread: next.thread, text: 'Go.' })).status, 200);
  log = await runs(id, 4);
  const yes = log.findLast(e => e.op === 'signoff')!;
  assert.equal(yes.on, next.seq, 'the proposal it names');
  assert.deepEqual(await waiting(), []);
  assert.equal(git('log', '-1', '--format=%an%n%B', String(yes.commit)), 'Demo Admin\nThe rate is fixed: send it now?\n\nGo.\n\nSigned-off-by: Demo Admin <admin@demo.test>');
  assert.equal(git('diff', String(bobs.commit), String(yes.commit), '--', 'working/pack.csv').split('\n').filter(l => /^[-+]\d/.test(l)).join(' '), '-200 +250', 'git diff between sign-offs shows what changed');
  assert.match(git('show', `${yes.commit}:log.jsonl`), /"op":"signoff","thread":"c\d+","on":\d+,"text":"Fine by me\."/, 'the whole folder, its log included');

  assert.equal((await call('POST', `/api/instances/${id}/close`)).status, 200);
  log = (await (await call('GET', `/api/instances/${id}`)).json()).log;
  assert.equal(log.at(-1).commit, git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%an%n%B'), 'Demo Admin\nClose 2026-12');
  assert.deepEqual(git('log', '--reverse', '--format=%an|%s').split('\n'), [
    'rollforward agent|Run 1', 'rollforward agent|Draft pack built', 'rollforward agent|Run 2',
    'Bob|The pack is ready to send to the bank: [pack](working/pack.csv)', 'rollforward agent|Run 3', `Demo Admin|Comment in ${next.thread}`, 'Demo Admin|The rate is fixed: send it now?',
    'rollforward agent|Run 4', 'Demo Admin|Close 2026-12',
  ], "each run's end, the agent's commit, the two approvals, the quiet reply and the close");
  const pulled = await (await call('GET', '/api/files?path=Signed/Pack/2026-12')).json();
  assert.ok(pulled.length && !pulled.some((f: { path: string }) => f.path.includes('/.git/')), 'rf pull leaves the history out');
});

test("a start removes its data root's abandoned scratch, for active and idle Pis without indexes, and leaves another root's scratch alone", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Scratch' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Idle' })).json();
  const { id: busy } = await (await call('POST', '/api/series', { workspace: ws, name: 'Busy' })).json();
  const { id: running } = await (await call('POST', `/api/series/${busy}`, { label: '2026-11', logins: [], quiet: true })).json();
  scripts.push({ bash: [], report: 'Idle.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  let reached = false;
  scripts.push({ bash: [], report: 'Never said.', saw: [], hold: () => { reached = true; } });
  await call('POST', `/api/instances/${running}/comment`, { text: 'Start.' });
  await until('the held run', () => reached);
  const scratch = join(tmp, 'scratch', 'runs'), tokens = readdirSync(scratch);
  assert.ok(tokens.length >= 2);
  const foreign = 'another-data-root';
  mkdirSync(join(tmp, 'other-data', '.rf', 'runs', foreign), { recursive: true });
  mkdirSync(join(scratch, foreign, 'home'), { recursive: true });
  writeFileSync(join(scratch, foreign, 'home', 'kept'), 'the other server');
  symlinkSync(join(scratch, foreign), join(scratch, tokens[0], 'link'));
  const locked = join(scratch, tokens[0], 'home', 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'file'), 'unreadable');
  chmodSync(locked, 0);
  // A folder an unzip named in GBK, which reads back as another name.
  const gbk = Buffer.concat([Buffer.from(join(scratch, tokens[1], 'tmp') + '/'), Buffer.from([0xb7, 0xa2])]);
  mkdirSync(Buffer.concat([gbk, Buffer.from('/x')]), { recursive: true });
  chmodSync(gbk, 0o500);
  scripts.push({ bash: [], report: 'Carried on.', saw: [] });
  await cut();
  for (const token of tokens) assert.ok(!existsSync(join(scratch, token)), `old scratch ${token} remains`);
  assert.equal(readFileSync(join(scratch, foreign, 'home', 'kept'), 'utf8'), 'the other server');
  rmSync(join(scratch, foreign), { recursive: true });
  await runs(running, 2);
  const records = readdirSync(join(root, '.rf', 'runs'));
  assert.ok(records.length, 'a run without index sources still has an ownership folder');
});

test("a run learns nothing of an instance in another workspace by acting on it, its runner, threads, items or label: each act is refused first", async () => {
  const carol = await login('carol@demo.test');
  const { id: secret } = await (await call('POST', '/api/workspaces', { name: 'Secret' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${secret}`, { members: ['carol@demo.test'] })).status, 200);
  const { id: payroll } = await (await call('POST', '/api/series', { workspace: secret, name: 'Payroll' })).json();
  const { id: open } = await (await call('POST', `/api/series/${payroll}`, { label: '2026-11 layoffs', quiet: true }, carol)).json();
  assert.equal((await call('POST', `/api/instances/${open}/comment`, { text: 'List of names', quiet: true }, carol)).status, 200);
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Probing' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Probe' })).json();
  const probe = (action: string, body: object) => `curl -s -m 5 -X POST -H "authorization: Bearer $RF_TOKEN" "$RF_URL/api/instances/${open}/${action}" -d '${JSON.stringify(body)}'; echo`;
  const s: Script = { bash: [probe('comment', { text: 'x', to: 'nobody@demo.test' }), probe('comment', { text: 'x', thread: 'c99' }), probe('comment', { text: 'x', item: 'zzz' }), probe('correct', {})], report: 'Probed.', saw: [] };
  scripts.push(s);
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  assert.deepEqual(s.saw.map(x => x.trim()), Array(4).fill('that instance is in another workspace: you can read it if it lets you, not act there'));
});

test("a run's cancelling a person's wake is recorded in the system's log, with the wake, the run's instance and its number", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Cancelling' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Payroll' })).json();
  const text = 'Payroll cut-off: collect the timesheets', at = new Date(Date.now() + 30 * 86400e3).toISOString();
  assert.equal((await call('PUT', `/api/wakes/${series}`, { at, label: '2026-12', text })).status, 200);
  const s: Script = { bash: [() => `rf wake --cancel ${/Pending wakes: (\w+)/.exec(s.prompt!)![1]} 2>&1`], report: 'Cancelled.', saw: [] };
  scripts.push(s);
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  const wake = /Pending wakes: (\w+)/.exec(s.prompt!)![1];
  const acts = readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(acts.filter(a => a.path === `/api/wakes/${wake}`).map(a => [a.by, a.method, a.wake.text, a.wake.from, a.inst, a.run]), [['agent', 'DELETE', text, ADMIN, id, 1]]);
});

test("a proposal still waiting as its instance closes is accepted, so it waits on no one", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Accepted' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Pack' })).json();
  scripts.push({ bash: ['rf propose "Send the pack to the bank." 2>&1'], report: 'Proposed.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  const thread = (await runs(id, 1)).find(e => e.ask === 'proposal')!.thread;
  assert.equal((await call('POST', `/api/instances/${id}/close`)).status, 200);
  const { waiting, log } = await (await call('GET', `/api/instances/${id}`)).json();
  assert.deepEqual([waiting, log.find((e: { op: string }) => e.op === 'close').accepted], [[], [thread]]);
  assert.ok(!(await (await call('GET', '/api/status')).json()).asks.some((a: { path: string }) => a.path.startsWith('Accepted/')));
});

test("a run's end removes its scratch, though it left a folder there named in bytes that aren't UTF-8 and can't be written", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Unzipped' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Archive' })).json();
  const scratch = join(tmp, 'scratch', 'runs');
  mkdirSync(scratch, { recursive: true });
  const before = readdirSync(scratch), s: Script = { bash: [() => { s.fail = 'The model refused.'; return "mkdir -p \"/tmp/$(printf '\\267\\242')/x\" && chmod 500 \"/tmp/$(printf '\\267\\242')\" && ls /tmp"; }], report: 'Never said.', saw: [] };
  scripts.push(s);
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  await runs(id, 1);
  assert.match(s.saw[0], /\?\?|\ufffd/, 'the folder was made');
  await until('the scratch removed', () => readdirSync(scratch).every(t => before.includes(t)));
});

test("a start drops the torn last line a kill left in an instance's log or the system's, saying so, and starts", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Torn' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Logs' })).json();
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [], quiet: true })).json();
  const log = join(root, 'instances', id, 'log.jsonl'), system = join(root, '.rf', 'log.jsonl'), was = readFileSync(log, 'utf8');
  appendFileSync(log, '{"seq":99,"by":"ser');
  appendFileSync(system, '{"seq":99,"by":"ser');
  await cut();
  assert.equal(readFileSync(log, 'utf8'), was);
  assert.equal((await call('GET', `/api/instances/${id}`)).status, 200);
  assert.ok(readFileSync(system, 'utf8').split('\n').filter(Boolean).every(l => JSON.parse(l)));
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

test('a stop, as an update makes, lets nothing more go out, and exits once what the runs had sent is answered and logged; the run it cut carries on after the start', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Stops' })).json();
  assert.equal((await call('PUT', '/connections/adb', { type: 'databricks' })).status, 200);
  // Databricks connected, as the Logins page does, and its warehouse added.
  const go = await fetch(`${base}/logins/adb/connect`, { headers: { cookie: admin }, redirect: 'manual' }), to = new URL(go.headers.get('location')!);
  to.searchParams.set('login_hint', ADMIN);
  const back = (await fetch(to, { redirect: 'manual' })).headers.get('location')!;
  await fetch(back, { headers: { cookie: `${admin}; ${go.headers.getSetCookie()[0].split(';')[0]}` }, redirect: 'manual' });
  assert.equal((await call('POST', '/logins/adb/offers', { add: 'https://adb-1.azuredatabricks.net/sql/warehouses/wh1' })).status, 200);
  let answer!: () => void;
  statement = new Promise(ok => (answer = ok));
  scripts.push({ bash: [`curl -s -m 60 https://adb-1.azuredatabricks.net/api/2.0/sql/statements -H 'content-type: application/json' -d '{"statement": "SELECT 1", "warehouse_id": "wh1"}'`], report: 'Never said.', saw: [] });
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Warehouse' })).json();
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: ['adb:adb-1.azuredatabricks.net/wh1'] })).json();
  await until('the statement', () => statements > 0);
  const runsDir = join(tmp, 'scratch', 'runs'), token = readdirSync(runsDir).find(t => readFileSync(join(runsDir, t, 'bwrap.args'), 'utf8').includes(`RF_INSTANCE\0${id}\0`))!;
  proc.kill('SIGTERM');
  await new Promise(ok => setTimeout(ok, 500));
  // The run asks its proxy for the warehouse again, with its own token, on its own socket.
  const again = await new Promise<string>(ok => {
    const s = connect(join(runsDir, token, 'socket', 'rf.sock'), () => s.write(`CONNECT adb-1.azuredatabricks.net:443 HTTP/1.1\r\nproxy-authorization: Basic ${Buffer.from(`rf:${token}`).toString('base64')}\r\n\r\n`));
    s.once('data', d => (ok(String(d)), s.destroy()));
  });
  assert.match(again, /^HTTP\/1\.1 403 [^]*no run for this token/, 'nothing more goes out');
  assert.equal(proc.exitCode, null, 'the server waits for the statement it sent');
  answer();
  await once(proc, 'exit');
  const log = readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)), sent = log.find(e => e.op === 'send');
  assert.deepEqual(log.filter(e => e.op === 'call' && e.sent === sent.seq).map(e => e.status), [200], 'its answer, logged before the server went');
  scripts.push({ bash: [], report: 'Carried on after the stop.', saw: [] });
  await serve();
  assert.deepEqual((await runs(id, 2)).filter(e => e.op === 'done').map(e => [e.aborted, e.error]), [[true, 'a restart cut the run'], [false, undefined]]);
});

// An update's drain (waker.ts drain()): what /drained answers, and a series with its first run done, waiting on an ask, or held mid-turn until `go`.
const drainedNow = async () => (await fetch(`${base}/drained`)).status;
const draining = async () => (await (await call('GET', '/me')).json()).draining;
async function drainSeries(name: string, mode: boolean | 'ask' = false) {
  let reached = false, go!: () => void;
  const gate = new Promise<void>(ok => (go = ok));
  scripts.push({ bash: mode === true ? [async () => { reached = true; await gate; return 'echo ok'; }] : mode === 'ask' ? ["rf ask 'Which rate?'"] : [], report: 'Done.', saw: [] });
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: `Drain-${name}` })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name })).json();
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  if (mode === true) await until(`${name}'s run`, () => reached);
  else await runs(id, 1);
  return { id: id as string, go };
}
const entries = (id: string) => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const started = (id: string) => entries(id).filter(e => e.op === 'run').length;

test("an update's drain starts no run, though acts and due wakes are logged, counts runs going and not an ask waiting on a person, stops the idle Pis and idles none, shows the count on the page, and answers drained once no run goes; what waited starts after the restart", async t => {
  const runsDir = join(tmp, 'scratch', 'runs'), pi = (id: string) => readdirSync(runsDir).some(t => readFileSync(join(runsDir, t, 'bwrap.args'), 'utf8').includes(`RF_INSTANCE\0${id}\0`));
  const asked = await drainSeries('Asked', 'ask'), woken = await drainSeries('Woken'), busy1 = await drainSeries('Busy1', true), busy2 = await drainSeries('Busy2', true);
  t.after(() => { busy1.go(); busy2.go(); });
  assert.ok(pi(asked.id) && pi(woken.id));
  assert.ok((await (await call('GET', '/api/status')).json()).asks.some((a: { path: string }) => a.path === 'Drain-Asked/Asked/2026-11'));
  assert.deepEqual([await drainedNow(), await draining()], [503, null], 'no drain asked');
  const browser = await chromium.launch(), ctx = await browser.newContext();
  const [name, value] = admin.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/#/${asked.id}`);
    await page.waitForSelector('#bar h1 .t');
    assert.equal(await page.locator('#draining').isVisible(), false);
    proc.kill('SIGUSR2');
    await until('the idle Pis stopped', () => !pi(asked.id) && !pi(woken.id));
    assert.deepEqual([await drainedNow(), await draining()], [503, 2], 'the two mid-turn runs go; the ask waiting on a person does not');
    await page.locator('#draining', { hasText: 'An update is waiting for 2 runs to finish; new runs start after it.' }).waitFor();
    assert.equal((await call('POST', `/api/instances/${asked.id}/comment`, { text: 'Use 5%.' })).status, 200);
    assert.equal((await call('PUT', `/api/wakes/${woken.id}`, { at: 'now', text: 'due in drain' })).status, 200);
    await until('the due wake fired into the log', () => entries(woken.id).some(e => e.op === 'wake' && e.text === 'due in drain'));
    await new Promise(ok => setTimeout(ok, 2200));
    assert.deepEqual([started(asked.id), started(woken.id)], [1, 1], 'neither the comment nor the wake starts a run');
    const queued = (await (await call('GET', '/api/status')).json()).queued;
    for (const path of ['Drain-Asked/Asked/2026-11', 'Drain-Woken/Woken/2026-11'])
      assert.equal(queued.find((q: { path: string }) => q.path === path)?.why, 'an update waits for the runs going to finish', path);
    busy1.go();
    await runs(busy1.id, 1);
    await page.locator('#draining', { hasText: 'An update is waiting for 1 run to finish; new runs start after it.' }).waitFor();
    assert.equal(await drainedNow(), 503);
    busy2.go();
    await runs(busy2.id, 1);
    for (let i = 0; await drainedNow() !== 200; i++) {
      assert.ok(i < 100, 'never drained');
      await new Promise(ok => setTimeout(ok, 200));
    }
    assert.equal(await draining(), 0);
    await page.locator('#draining', { hasText: 'An update is waiting for 0 runs to finish; new runs start after it.' }).waitFor();
    assert.ok(!pi(busy1.id) && !pi(busy2.id), 'runs ending in a drain idle no Pi');
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: join(root, 'instances', busy2.id), encoding: 'utf8' }).trim(), 'Run 1', 'settled commit finished before /drained answered 200');
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    scripts.push({ bash: [], report: 'After the update.', saw: [] }, { bash: [], report: 'Woken after the update.', saw: [] });
    await serve();
    await Promise.all([runs(asked.id, 2), runs(woken.id, 2)]);
    assert.deepEqual([await drainedNow(), await draining()], [503, null], 'the new server drains only when signalled');
    await page.waitForSelector('#draining', { state: 'hidden', timeout: 10_000 });
  } finally {
    await browser.close();
  }
});

test('a drain lasts RF_DRAIN_MIN from its latest signal, a second only renewing its deadline, and then lapses by itself if nothing stops the server: what waited starts', async () => {
  proc.kill('SIGKILL');
  await once(proc, 'exit');
  await serve({ RF_DRAIN_MIN: '0.05' });
  try {
    const { id } = await drainSeries('LapseRec');
    proc.kill('SIGUSR2');
    assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Again.' })).status, 200);
    await new Promise(ok => setTimeout(ok, 1800));
    proc.kill('SIGUSR2');
    await new Promise(ok => setTimeout(ok, 1800));
    assert.equal(started(id), 1, "no run starts past the first signal's deadline");
    assert.deepEqual([await drainedNow(), await draining()], [200, 0]);
    scripts.push({ bash: [], report: 'After the drain.', saw: [] });
    await runs(id, 2);
    assert.deepEqual([await drainedNow(), await draining()], [503, null]);
  } finally {
    await cut();
  }
});

test('a restart during a drain ends it: the run it cut carries on, and what waited starts', async () => {
  const waited = await drainSeries('RestartWaited'), busy = await drainSeries('RestartBusy', true);
  proc.kill('SIGUSR2');
  assert.equal((await call('POST', `/api/instances/${waited.id}/comment`, { text: 'Again.' })).status, 200);
  await new Promise(ok => setTimeout(ok, 2500));
  assert.equal(started(waited.id), 1);
  scripts.push({ bash: [], report: 'Carried on.', saw: [] }, { bash: [], report: 'Carried on.', saw: [] });
  await cut();
  assert.deepEqual([await drainedNow(), await draining()], [503, null]);
  assert.deepEqual((await runs(busy.id, 2)).filter(e => e.op === 'done').map(e => e.error), ['a restart cut the run', undefined]);
  await runs(waited.id, 2);
  busy.go();
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
  const run3: Script = { bash: [], report: 'On the shared key.', saw: [] };
  scripts.push(run3);
  assert.equal((await call('PUT', '/logins/openrouter', { enabled: false })).status, 200);
  log = await runs(id, 3);
  assert.deepEqual([log.findLast(e => e.op === 'run')!.key, [...new Set(keys)]], ['shared', ['stand-in-key']]);
  assert.match(run3.prompt!, /Again\./, "the next session carries on from before the failed run, keeping the runner's unread comment");
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

test('the process for Week 10 starts from closed Week 9, so carried rules are not new', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Weekly rules' })).json();
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Weeks' })).json();
  scripts.push({ bash: ["printf -- '- Read the ledger.\\n- Never write to it.\\n' > working/process.md"], report: 'Two rules.', saw: [] });
  const { id: before } = await (await call('POST', `/api/series/${series}`, { label: 'Week 9', logins: [] })).json();
  await runs(before, 1);
  assert.equal((await call('POST', `/api/instances/${before}/close`)).status, 200);
  scripts.push({ bash: ["cp '../Week 9/working/process.md' working/process.md; printf -- '- Round to the cent.\\n' >> working/process.md"], report: 'One new rule.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: 'Week 10', logins: [] })).json();
  assert.equal((await runs(id, 1)).find(e => e.op === 'done')!.rules, 1);
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

test("a run leaves notes elsewhere in its workspace, in another instance and on a series, which start nothing unshared, and settles its own series' open notes, which its first message lists; it asks only in its own instance", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Notes' })).json();
  const { id: rec } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
  const { id: feed } = await (await call('POST', '/api/series', { workspace: ws, name: 'Feed' })).json();
  const { id: fed } = await (await call('POST', `/api/series/${feed}`, { label: 'f1', logins: [], quiet: true })).json();
  const { id: n } = await (await call('POST', `/api/series/${rec}/notes`, { text: 'Use the new bank from now on.' })).json();
  const noting: Script = {
    bash: [
      'rf say --at ../../Feed/f1 The rec is done: 1,200 matched. 2>&1',
      'rf ask --at ../../Feed/f1 Shall I? 2>&1',
      'rf say --at ../../Feed Rates. 2>&1',
      'rf note ../../Feed The feed should carry the rates. 2>&1',
      `rf note --taken ${n} Using the new bank, in the process. 2>&1`,
      `rf note --aside ${n} again 2>&1`,
      'wc -l < ../.notes/log.jsonl',
    ],
    report: 'Noted.', saw: [],
  };
  scripts.push(noting);
  const { id } = await (await call('POST', `/api/series/${rec}`, { label: 'r1', logins: [] })).json();
  const log = await runs(id, 1);
  assert.match(noting.prompt!, new RegExp(`Open notes on the series: ${n}, from Demo Admin <admin@demo\\.test> at [^,]+, "Use the new bank from now on\\."\\. New log entries:`));
  assert.match(noting.saw[0], /^said c\d+ in Notes\/Feed\/f1, a note for its runner\s*$/);
  assert.match(noting.saw[1], /you ask and propose only to your own runner/);
  assert.match(noting.saw[2], /Feed is a series: say it in one of its open instances, or rf note it/);
  assert.match(noting.saw[3], /^noted n1 on Notes\/Feed, which its runs read\s*$/);
  assert.match(noting.saw[4], new RegExp(`^${n} taken\\s*$`));
  assert.match(noting.saw[5], new RegExp(`${n} is settled already, taken by agent`));
  assert.equal(noting.saw[6].trim(), '2', "its series' notes, as the run started, read where it reads its series");
  const there = (await (await call('GET', `/api/instances/${fed}`)).json()).log, note = there.find((e: { op: string }) => e.op === 'comment');
  assert.deepEqual([note.by, note.note, note.run, note.runner, note.see.inst, note.see.label], ['agent', true, 1, ADMIN, id, 'r1']);
  assert.ok(!there.some((e: { op: string }) => e.op === 'run'), 'unshared, it starts nothing there');
  assert.deepEqual(log.filter(e => e.op === 'said').map(e => [e.inst, e.seq]), [[fed, note.seq]], 'its own log points to it');
  const [taken] = await (await call('GET', `/api/series/${rec}/notes`)).json();
  assert.deepEqual([taken.settled.op, taken.settled.by, taken.settled.runner, taken.settled.see.inst], ['taken', 'agent', ADMIN, id]);
  const [left] = await (await call('GET', `/api/series/${feed}/notes`)).json();
  assert.deepEqual([left.by, left.text, left.run, left.see.inst], ['agent', 'The feed should carry the rates.', 1, id]);
});

// A websocket's opening, as a page at `origin` asks for it, and all that came back.
const upgrade = (path: string, cookie: string, origin = base) => new Promise<string>(ok => {
  let got = '';
  connect(Number(new URL(base).port), '127.0.0.1').on('data', d => { got += d; }).on('close', () => ok(got))
    .write(`GET ${path} HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\ncookie: ${cookie}\r\norigin: ${origin}\r\n\r\n`);
});

test("whoever sees an instance watches its run's browser live from the page, the person whose login it's in alone taking control of it, and its runner's Stop browser interrupts the run, closing it, which a member who only sees it may not", async () => {
  const carol = await login('carol@demo.test');
  assert.equal((await call('POST', '/logins/sites', { name: 'portal', url: 'https://portal.example.com/' })).status, 200);
  assert.equal((await call('PATCH', '/logins/sites/portal', { writeback: false })).status, 200);
  const { id: signIn } = await (await call('POST', '/logins/web/portal', {})).json();
  assert.match(await upgrade(`/signins/${signIn}/view/drive`, admin), /service got \/sessions\/b1\/view\/drive$/, 'a sign-in is its person\'s to drive');
  assert.match(await upgrade(`/signins/${signIn}/view/drive`, admin, 'https://evil.example.com'), /^HTTP\/1.1 404/, "only from the server's own pages");
  assert.equal((await call('POST', `/signins/${signIn}`)).status, 200);
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Watching' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Portal pull' })).json();
  assert.equal((await (await call('POST', '/grants', { site: 'portal', workspace: ws, reason: 'portal pulls' })).json()).state, 'approved', 'asked by its owner, approved at once');
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
  const refused = await call('POST', `/api/instances/${id}/interrupt`, undefined, bob);
  assert.deepEqual([refused.status, await refused.text()], [403, `only its runner, ${ADMIN}, the workspace's owners and admins stop its run`], 'bob sees it, but neither runs it nor owns its workspace');
  assert.equal((await call('POST', `/api/instances/${id}/interrupt`)).status, 200, 'Stop browser');
  const done = (await runs(id, 1)).find(e => e.op === 'done')!;
  assert.equal(done.aborted, true);
  await until('the browser closed', () => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').includes('"requests":'));
  const { log, run } = await (await call('GET', `/api/instances/${id}`, undefined, bob)).json();
  assert.deepEqual([log.find((e: { op: string }) => e.op === 'interrupt').by, log.filter((e: { op: string }) => e.op === 'browser').map((e: { by: string; site: string; action?: string }) => [e.by, e.site, e.action]), run],
    [ADMIN, [[ADMIN, 'portal', 'drive'], ['server', 'portal', undefined]], null], "the admin's control and interrupt logged as theirs, and the browser gone");
});

test("someone watching a run's browser live is cut off once they may no longer see its instance", async t => {
  holdView = true;
  t.after(() => { holdView = false; });
  assert.equal((await call('POST', '/logins/sites', { name: 'watched', url: 'https://portal.example.com/' })).status, 200);
  const { id: signIn } = await (await call('POST', '/logins/web/watched', {})).json();
  assert.equal((await call('POST', `/signins/${signIn}`)).status, 200);
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Watched' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Portal' })).json();
  assert.equal((await (await call('POST', '/grants', { site: 'watched', workspace: ws, reason: 'watching' })).json()).state, 'approved');
  scripts.push({ bash: ['curl -s -m 5 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/watched"; touch working/opened; sleep 120'], report: 'Never said.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: ['web:watched'] })).json();
  try {
    await until('the browser', () => existsSync(join(root, 'instances', id, 'working', 'opened')));
    let got = '', closed = false;
    connect(Number(new URL(base).port), '127.0.0.1').on('data', d => { got += d; }).on('close', () => { closed = true; })
      .write(`GET /runs/${id}/watched/view/watch HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\ncookie: ${bob}\r\norigin: ${base}\r\n\r\n`);
    await until('the live view', () => got.startsWith('HTTP/1.1 101'));
    await new Promise(r => setTimeout(r, 500));
    assert.equal(closed, false, 'it lasts while bob may watch');
    assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [] })).status, 200);
    await until('the live view cut', () => closed);
  } finally {
    await call('POST', `/api/instances/${id}/interrupt`);
    await runs(id, 1);
  }
});

test('unticking, removing, signing out or revoking a website closes a going run\'s browser and its open CDP pipe', async t => {
  holdCdp = true;
  t.after(() => { holdCdp = false; });
  const { id: workspace } = await (await call('POST', '/api/workspaces', { name: 'Browser lending' })).json();
  for (const stop of ['untick', 'remove', 'signout', 'revoke']) await t.test(stop, async () => {
    const site = `lent-${stop}`;
    assert.equal((await call('POST', '/logins/sites', { name: site, url: 'https://portal.example.com/' })).status, 200);
    const { id: signIn } = await (await call('POST', `/logins/web/${site}`, {})).json();
    assert.equal((await call('POST', `/signins/${signIn}`)).status, 200);
    const { id: grant, state } = await (await call('POST', '/grants', { site, workspace, reason: 'portal pulls' })).json();
    assert.equal(state, 'approved', 'asked by its owner, approved at once');
    const { id: series } = await (await call('POST', '/api/series', { workspace, name: site })).json();
    scripts.push({ bash: [`curl -s -m 120 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/${site}"; touch working/disconnected; sleep 120`], report: 'Never said.', saw: [] });
    const opened = cdpOpened, closed = cdpClosed;
    const { id } = await (await call('POST', `/api/series/${series}`, { label: '1', logins: [`web:${site}`] })).json();
    try {
      await until('the CDP pipe open', () => cdpOpened > opened);
      const response = stop === 'untick' ? await call('POST', `/api/instances/${id}/logins`, { logins: [] })
        : await call('DELETE', stop === 'remove' ? `/logins/sites/${site}` : stop === 'signout' ? `/logins/web:${site}` : `/grants/${grant}`);
      assert.equal(response.status, 200);
      const { run } = await (await call('GET', `/api/instances/${id}`)).json();
      assert.deepEqual(run.browsers, [], stop);
      await until('the CDP pipe closed', () => cdpClosed > closed);
      await until('the agent disconnected', () => existsSync(join(root, 'instances', id, 'working/disconnected')));
    } finally {
      await call('POST', `/api/instances/${id}/interrupt`);
      await runs(id, 1);
    }
  });
});

test("personal websites are checked on Save, grants reuse the profile without widening hosts, run hosts wait only on admins for high/internal verdicts, and people remove their own hosts and sites", async t => {
  t.after(() => { refused = []; browserLog = []; browserState = { cookies: [], origins: [] }; });
  const carol = await login('carol@demo.test'), add = (body: object, cookie = bob) => call('POST', '/logins/sites', { name: 'bobs', url: 'https://bobs.example.com/', ...body }, cookie);
  const said = async (res: Response) => [res.status, await res.text()];
  const allow = (host: string, cookie = bob, whose = '') => call('POST', `/logins/web/bobs/hosts${whose}`, { host }, cookie);
  const listed = async (cookie: string) => (await (await call('GET', '/logins/sites', undefined, cookie)).json()).bobs;
  assert.deepEqual(await said(await add({ url: 'http://bobs.example.com/' })), [400, 'url: an https address, where its sign-in starts']);
  assert.equal((await add({})).status, 200);
  assert.deepEqual(await said(await add({ url: 'https://bobs.example.com/other' })), [409, 'you have a website bobs already: name this one otherwise']);
  assert.equal((await add({ url: 'https://carols.example.com/' }, carol)).status, 200, 'a name is each person\'s own');
  assert.deepEqual([(await listed(bob)).url, (await listed(carol)).url], ['https://bobs.example.com/', 'https://carols.example.com/']);
  assert.equal((await add({ name: 'intranet', url: 'https://10.1.2.3/' })).status, 200);
  assert.deepEqual(await said(await call('POST', '/logins/web/intranet', {}, bob)), [400, '10.1.2.3 is at an internal address: a website reaches one only where an admin lets it']);
  assert.equal((await call('DELETE', '/logins/sites/intranet', undefined, bob)).status, 200);

  refused = ['https://sso.idp.test/a', 'https://cdn.idp.test/x.js', 'https://sso.idp.test/b'];
  browserLog = [
    { method: 'GET', url: 'https://bobs.example.com/private?code=secret', status: 302, dest: 'document' },
    { method: 'POST', url: 'https://sso.idp.test/login?token=secret', status: 200, dest: 'document', from: 'https://bobs.example.com/private?code=secret' },
  ];
  browserState = {
    cookies: ['bobs.example.com', '.example.com', 'sso.idp.test', 'cdn.idp.test', 'unused.bobs.example.com'].map(domain => ({ domain, name: 'session', value: 'secret-cookie' })),
    origins: ['bobs.example.com', 'sso.idp.test', 'cdn.idp.test', 'unused.bobs.example.com'].map(host => ({ origin: `https://${host}`, localStorage: [{ name: 'access', value: 'secret-storage' }] })),
  };
  const keptState = { cookies: browserState.cookies.slice(0, 3), origins: browserState.origins.slice(0, 2) }, since = Date.now();
  const { id: signIn, expires } = await (await call('POST', '/logins/web/bobs', {}, bob)).json();
  assert.ok(Date.parse(expires) >= since + 600_000 && Date.parse(expires) <= Date.now() + 600_000);
  assert.equal(expires, new Date(expires).toISOString());
  assert.deepEqual([openings.at(-1)!.site.open, openings.at(-1)!.site.hosts, openings.at(-1)!.site.public, openings.at(-1)!.ttl_s], [true, [], undefined, 600]);
  for (const host of ['127.0.0.1', 'graph.microsoft.com', '*.azuredatabricks.net']) assert.ok(openings.at(-1)!.site.except!.includes(host), host);
  assert.equal((await call('GET', '/logins/web/bobs/refused', undefined, bob)).status, 404, 'there is no sign-in host polling route');
  for (const host of ['*.co.uk', 'graph.microsoft.com', 'sso.idp.test', 'assets.bobs.example.com'])
    assert.deepEqual(await said(await allow(host)), [403, 'admins allow website hosts']);
  assert.deepEqual(await said(await allow('sso.idp.test', carol, `?person=${BOB}`)), [403, 'admins allow website hosts']);
  assert.deepEqual(await said(await allow('*.co.uk', admin, `?person=${BOB}`)), [400, '*.co.uk: a wildcard stays within one registrable domain, such as *.example.com']);
  assert.deepEqual(await said(await allow('graph.microsoft.com', admin, `?person=${BOB}`)), [400, "graph.microsoft.com is graph's: no website reaches it"]);
  assert.equal((await allow('assets.bobs.example.com', admin, `?person=${BOB}`)).status, 200);
  assert.deepEqual(told.slice(-2), [`PUT /sessions/${signIn}/hosts {"hosts":[]}`, `POST /sessions/${signIn}/reload `], 'public allowances never enter the open sign-in internal list');

  const portalProfile = { what: 'Bobco operates a business portal for its suppliers.', category: 'company', risk: 'low', flags: [] };
  const beforeSave = checks.length;
  verdicts.push({ profile: portalProfile, hosts: { 'sso.idp.test': { verdict: 'pass', why: 'Its sign-on provider.' }, 'cdn.idp.test': { verdict: 'refused', why: 'Optional telemetry.' } } });
  assert.equal((await call('POST', `/signins/${signIn}`, undefined, bob)).status, 200);
  assert.equal(checks.length, beforeSave + 1, 'Save checks before there is any grant request');
  assert.deepEqual([(await listed(bob)).profile, (await listed(bob)).hosts], [portalProfile, ['assets.bobs.example.com', 'sso.idp.test']]);
  const asked = JSON.parse(checks.at(-1)!.messages[1].content), trace = (await (await call('GET', '/logins', undefined, bob)).json()).find((l: { id: string }) => l.id === 'web:bobs').trace;
  assert.deepEqual([checks.at(-1)!.provider, asked.website.address, asked.evidence, asked.unchecked], [{ data_collection: 'deny' }, 'bobs.example.com', trace, ['sso.idp.test', 'cdn.idp.test']]);
  assert.deepEqual(trace.requests, { 'bobs.example.com': { 302: 1 }, 'sso.idp.test': { 200: 1, 403: 2 }, 'cdn.idp.test': { 403: 1 } });
  assert.deepEqual([trace.blocked, trace.kinds], [['sso.idp.test', 'cdn.idp.test'], { 'bobs.example.com': { dest: ['document'], from: [] }, 'sso.idp.test': { dest: ['document'], from: ['bobs.example.com'] }, 'cdn.idp.test': { dest: [], from: [] } }]);
  assert.equal(typeof trace.seconds, 'number');
  assert.equal(asked.reason, undefined, 'the check is of the website, not a requester\'s intended use');
  assert.doesNotMatch(JSON.stringify(asked), /https:\/\/|private|secret/);
  browserLog = []; browserState = { cookies: [], origins: [] }; refused = [];

  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Own sites' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, { members: [BOB] })).status, 200);
  assert.deepEqual(await said(await call('POST', '/grants', { site: 'bobs', workspace: ws, reason: '' }, bob)), [400, "a reason: what you'll use it for, for the workspace's owners"]);
  const requested = await (await call('POST', '/grants', { site: 'bobs', workspace: ws, reason: 'own pulls' }, bob)).json(), grant = requested.id;
  assert.deepEqual(requested, { id: grant, profile: portalProfile, state: 'pending', said: "Asked: it waits on Own sites's owners, Demo Admin, to approve it." });
  assert.equal(checks.length, beforeSave + 1, 'asking reuses the successful saved profile');
  const stored = JSON.parse(readFileSync(join(root, '.rf', 'grants.json'), 'utf8'))[grant];
  assert.deepEqual(['check', 'hosts'].filter(k => k in stored), []);
  const pending = async () => (await (await call('GET', '/api')).json()).find((w: { id: string }) => w.id === ws).grants;
  const [card] = await pending();
  assert.deepEqual([card.person, card.site, card.url, card.state, card.profile, card.adminOnly, card.use], [BOB, 'bobs', 'https://bobs.example.com/', 'pending', portalProfile, false, null]);
  assert.deepEqual(['check', 'hosts'].filter(k => k in card), []);
  assert.match(card.description, /Bob.*Own sites.*Bobco.*company system, bobs\.example\.com/);
  assert.match(card.description, /including submitting and approving.*own pulls.*reason is not an enforced limit/);
  assert.equal((await call('POST', `/grants/${grant}`, { approve: true }, bob)).status, 403, "a member doesn't approve");
  const hostsBefore = (await listed(bob)).hosts;
  assert.equal((await call('POST', `/grants/${grant}`, { approve: true })).status, 200);
  assert.deepEqual((await listed(bob)).hosts, hostsBefore, 'approving grants no new host');
  for (const host of ['cdn.other.test', 'cdn.bobs.example.com', 'sso.idp.test']) assert.deepEqual(await said(await allow(host)), [403, 'admins allow website hosts']);

  const { id: his } = await (await call('POST', '/api/workspaces', { name: "Bob's own" })).json();
  assert.equal((await call('PUT', `/api/workspaces/${his}`, { owners: [BOB] })).status, 200);
  const own = await (await call('POST', '/grants', { site: 'bobs', workspace: his, reason: 'more pulls' }, bob)).json();
  assert.deepEqual([own.state, own.said], ['approved', "Approved at once, as you're an owner of Bob's own."], 'an owner asking for a company profile has it approved at once');
  assert.equal(JSON.parse(readFileSync(join(root, '.rf', 'grants.json'), 'utf8'))[own.id].by, BOB);
  assert.equal(checks.length, beforeSave + 1, 'a second workspace still reuses the profile');
  assert.equal((await add({ name: 'risky', url: 'https://lookalike.vendor.test/' })).status, 200);
  const { id: riskySignIn } = await (await call('POST', '/logins/web/risky', {}, bob)).json();
  const riskyProfile = { what: 'Imposter Ltd operates a portal imitating Bobco.', category: 'company', risk: 'high', flags: ['looks like a lookalike'] };
  verdicts.push('```json\n' + JSON.stringify({ profile: riskyProfile, hosts: {} }) + '\n```');
  assert.equal((await call('POST', `/signins/${riskySignIn}`, undefined, bob)).status, 200);
  const { id: risky, profile: checkedRisk, said: riskySaid } = await (await call('POST', '/grants', { site: 'risky', workspace: his, reason: 'risky pulls' }, bob)).json();
  assert.deepEqual(checkedRisk, riskyProfile, 'a fenced model answer saved a usable profile');
  assert.equal(riskySaid, 'Asked: it waits on an admin to approve it, as the website profile rates risky high risk.', 'its owner asking for what the check reserves for admins waits for one');
  assert.deepEqual(await said(await call('POST', `/grants/${risky}`, { approve: true }, bob)), [403, 'the website profile rates risky high risk: an admin decides']);
  assert.equal((await call('POST', `/grants/${risky}`, { approve: true })).status, 200);
  assert.equal((await call('DELETE', '/logins/sites/risky', undefined, bob)).status, 200);

  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Own pull' }, bob)).json();
  refused = ['https://cdn.idp.test/x.js', 'https://cdn.bobs.example.com/a.js', 'https://www.tracker.test/c', 'https://static.cdnhost.test/a.js', 'https://upload.elsewhere.test/x', 'https://10.9.8.7/app'];
  verdicts.push({ profile: portalProfile, hosts: { 'www.tracker.test': { verdict: 'refused', why: 'Analytics.' }, 'static.cdnhost.test': { verdict: 'pass', why: 'Its CDN.' }, 'upload.elsewhere.test': { verdict: 'high', why: 'File sharing.' } } });
  scripts.push({ bash: ['curl -s -m 5 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/bobs"'], report: 'Pulled.', saw: [] });
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-12', logins: ['web:bobs'] }, bob)).json();
  await runs(id, 1);
  await until('the hosts checked', () => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').includes('"action":"allowed"'));
  assert.deepEqual(openings.at(-1)!.state, keptState, 'the run receives only requested allowed cookies and origins, including a parent-domain cookie');
  const sent = JSON.parse(checks.at(-1)!.messages[1].content), hosts = refused.map(url => new URL(url).hostname);
  assert.deepEqual([sent.website.address, sent.website.profile, sent.unchecked], ['bobs.example.com', portalProfile, ['www.tracker.test', 'static.cdnhost.test', 'upload.elsewhere.test']]);
  assert.deepEqual(sent.evidence, { requests: Object.fromEntries(hosts.map(h => [h, { 403: 1 }])), kinds: Object.fromEntries(hosts.map(h => [h, { dest: [], from: [] }])), blocked: hosts, seconds: 0 });
  assert.doesNotMatch(JSON.stringify(sent), /https:\/\/|secret/);
  const log = readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const allowed = ['cdn.bobs.example.com', 'static.cdnhost.test'], why = { 'cdn.bobs.example.com': "It is within example.com, the website's own domain.", 'static.cdnhost.test': 'Its CDN.' };
  assert.deepEqual(log.filter(e => e.action === 'allowed').map(e => [e.by, e.login, e.allowed, e.why]), [['server', BOB, allowed, why]]);
  const acts = () => readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(acts().filter(a => a.op === 'hosts').map(a => [a.by, a.person, a.site, a.inst, a.run, a.allowed]), [['server', BOB, 'bobs', id, 1, why]]);
  const checked = acts().findLast(a => a.op === 'website-check' && a.site === 'bobs');
  assert.deepEqual([checked.by, checked.person, checked.evidence, checked.queries, checked.profile], ['server', BOB, sent.evidence, [], portalProfile]);
  assert.deepEqual([(await listed(bob)).hosts, Object.fromEntries(Object.entries((await listed(bob)).checks).map(([h, c]: [string, any]) => [h, c.verdict]))],
    [[...hostsBefore, ...allowed], { 'assets.bobs.example.com': 'pass', 'bobs.example.com': 'pass', 'sso.idp.test': 'pass', 'cdn.idp.test': 'refused', 'cdn.bobs.example.com': 'pass', '10.9.8.7': 'internal', 'www.tracker.test': 'refused', 'static.cdnhost.test': 'pass', 'upload.elsewhere.test': 'high' }]);
  const waits = async (cookie = bob) => (await (await call('GET', '/api', undefined, cookie)).json()).flatMap((w: any) => w.series.flatMap((s: any) => s.instances)).find((i: { id: string }) => i.id === id).refused.map((r: { login: string; hosts: string[]; why: object }) => [r.login, r.hosts, r.why]);
  assert.deepEqual([await waits(), await waits(admin)], [[], [[BOB, ['upload.elsewhere.test', '10.9.8.7'], { 'upload.elsewhere.test': 'File sharing.', '10.9.8.7': 'It is at an internal address.' }]]], 'only high and internal hosts wait, on admins alone');
  assert.deepEqual(await said(await allow('upload.elsewhere.test')), [403, 'admins allow website hosts']);
  for (const host of ['upload.elsewhere.test', '10.9.8.7']) assert.equal((await allow(host, admin, `?person=${BOB}`)).status, 200);
  assert.deepEqual([await waits(admin), Object.keys(JSON.parse(readFileSync(join(root, '.rf', 'internal.json'), 'utf8')))], [[], ['10.9.8.7']], 'an internal host allowed is kept for every website');
  const remove = (host: string) => call('DELETE', `/logins/web/bobs/hosts/${host}`, undefined, bob);
  assert.equal((await remove('static.cdnhost.test')).status, 200);
  assert.deepEqual(await said(await remove('static.cdnhost.test')), [404, "bobs doesn't reach static.cdnhost.test: beyond its address it reaches assets.bobs.example.com, sso.idp.test, cdn.bobs.example.com, upload.elsewhere.test, 10.9.8.7"]);
  assert.deepEqual([(await listed(bob)).hosts.includes('static.cdnhost.test'), (await listed(bob)).checks['static.cdnhost.test']], [false, { verdict: 'refused', why: 'Its person removed it.' }], 'it stays refused');
  assert.deepEqual(acts().filter(a => a.method === 'DELETE' && a.path.includes('/hosts/')).map(a => [a.by, a.path]), [[BOB, '/logins/web/bobs/hosts/static.cdnhost.test']]);
  refused = [];
  const { id: again } = await (await call('POST', '/logins/web/bobs', {}, bob)).json();
  assert.deepEqual([openings.at(-1)!.site.open, openings.at(-1)!.site.hosts], [true, ['10.9.8.7']], 'only an admin-approved exact internal host enters the open sign-in');
  assert.equal((await call('DELETE', `/signins/${again}`, undefined, bob)).status, 200);

  refused = ['https://unreviewed.host.test/private?code=secret', 'https://static.cdnhost.test/a.js'];
  verdicts.push('not JSON');
  scripts.push({ bash: ['curl -s -m 5 -H "connection: upgrade" -H "upgrade: websocket" "$RF_BROWSERS/bobs"'], report: 'Unchecked host refused.', saw: [] });
  assert.equal((await call('POST', `/api/instances/${id}/comment`, { text: 'Try the new page.' }, bob)).status, 200);
  const retried = await runs(id, 2);
  await until('the failed host check', () => acts().some(a => a.op === 'website-check' && a.site === 'bobs' && a.error));
  const failed = await listed(bob);
  assert.deepEqual(failed.profile, portalProfile, 'a failed check keeps the good profile');
  assert.deepEqual([failed.checks['unreviewed.host.test'], failed.checks['static.cdnhost.test']], [undefined, { verdict: 'refused', why: 'Its person removed it.' }]);
  assert.deepEqual([await waits(), await waits(admin)], [[], []], 'unchecked and personally removed hosts never wait on anyone');
  assert.deepEqual((await pending())[0].use, { runs: 2, wrote: 0, last: retried.findLast(e => e.op === 'browser' && !e.action)!.at });

  const { id: third } = await (await call('POST', '/api/workspaces', { name: 'Intranet pulls' })).json();
  assert.equal((await call('PUT', `/api/workspaces/${third}`, { owners: [BOB] })).status, 200);
  const beforeAsk = checks.length, beforeApproval = (await listed(bob)).hosts;
  const { profile: thirdProfile, state: thirdState } = await (await call('POST', '/grants', { site: 'bobs', workspace: third, reason: 'intranet pulls' }, bob)).json();
  assert.deepEqual(thirdProfile, portalProfile);
  assert.equal(thirdState, 'approved', 'its owner asking, approved at once');
  assert.deepEqual([(await listed(bob)).hosts, checks.length], [beforeApproval, beforeAsk], 'even a website allowed internal access gains no hosts from a grant, which takes its good profile unchecked');

  assert.equal((await call('DELETE', '/logins/sites/bobs', undefined, bob)).status, 200);
  assert.deepEqual([await listed(bob), (await (await call('GET', '/logins', undefined, bob)).json()).some((l: { id: string }) => l.id === 'web:bobs'), await pending(), (await listed(carol)).url],
    [undefined, false, [], 'https://carols.example.com/'], 'his grants and login go with it');
  assert.equal((await call('DELETE', '/logins/sites/bobs', undefined, carol)).status, 200);
});

test('saving a sign-in keeps its login alive until the time given, for those admins grant keepalive', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString(), save = async () => {
    const { id } = await (await call('POST', '/logins/web/kept', {}, bob)).json(), res = await call('POST', `/signins/${id}`, { keepalive: until }, bob);
    if (res.status !== 200) await call('DELETE', `/signins/${id}`, undefined, bob);
    return [res.status, await res.text()];
  };
  assert.equal((await call('POST', '/logins/sites', { name: 'kept', url: 'https://kept.example.com/' }, bob)).status, 200);
  assert.deepEqual(await save(), [403, 'keeping a login alive is for admins and those they grant keepalive: ask an admin']);
  assert.equal((await call('PUT', '/capabilities', { cap: 'keepalive', people: [BOB] })).status, 200);
  assert.deepEqual(await save(), [200, 'ok']);
  assert.equal((await (await call('GET', '/logins', undefined, bob)).json()).find((l: { id: string }) => l.id === 'web:kept').keepalive, until);
  assert.equal((await call('DELETE', '/logins/sites/kept', undefined, bob)).status, 200);
  assert.ok(!(await (await call('GET', '/logins', undefined, bob)).json()).some((l: { id: string }) => l.id === 'web:kept'), 'removed, it takes its login with it');
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
  const named = await start('named', ['cp /usr/bin/sleep /tmp/socat && (setsid /tmp/socat 120 </dev/null >/dev/null 2>&1 &)']);
  await gone(named, "a job named as the sandbox's socat is a job all the same");
  const nested = await start('nested', [`python3 -c 'import os, time
r, w = os.pipe()
if os.fork() == 0:
  os.close(r); os.setsid(); os.unshare(0x10000000 | 0x20000000)
  if os.fork() == 0:
    os.write(w, b"1"); os.close(w); time.sleep(120)
  os._exit(0)
os.close(w); os.read(r, 1)' </dev/null >/dev/null 2>&1`]);
  await gone(nested, 'a job hidden in a nested PID namespace stops its Pi all the same');
  assert.equal(await again(nested, 2), undefined);
  const noInspector: Script = { bash: ['kill -USR1 2 && sleep 0.2 && (curl -s -m 1 -x "" http://127.0.0.1:9229/json/version || echo closed)'], report: 'Checked.', saw: [] };
  scripts.push(noInspector);
  const { id: inspSeries } = await (await call('POST', '/api/series', { workspace: ws, name: 'insp' })).json();
  const { id: insp } = await (await call('POST', `/api/series/${inspSeries}`, { label: '2026-11', logins: [] })).json();
  await runs(insp, 1);
  assert.equal(noInspector.saw[0].trim(), 'closed', 'SIGUSR1 opens no V8 inspector on PID 2');
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

test("deleting an instance cuts a run whose view holds it, which carries on without it, and a run going for it, whose sandbox stops before its folder goes", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Purge' })).json();
  const { id: payroll } = await (await call('POST', '/api/series', { workspace: ws, name: 'Payroll' })).json();
  const { id: report } = await (await call('POST', '/api/series', { workspace: ws, name: 'Report' })).json();
  const { id: old } = await (await call('POST', `/api/series/${payroll}`, { label: '2026-10', logins: [], quiet: true })).json();
  const reader: Script = { bash: ['ls /work/Purge/Payroll', async () => {
    assert.equal((await call('POST', `/api/instances/${old}/delete`)).status, 200, 'deleted while a run in reach goes');
    return 'sleep 60';
  }], report: 'Never said.', saw: [] };
  const after: Script = { bash: ['ls /work/Purge/Payroll 2>/dev/null; echo end'], report: 'Carried on.', saw: [] };
  scripts.push(reader, after);
  const { id } = await (await call('POST', `/api/series/${report}`, { label: '2026-11', logins: [] })).json();
  const log = await runs(id, 2);
  assert.equal(reader.saw[0].trim(), '2026-10');
  assert.equal(after.saw[0].trim(), 'end', 'its next run sees nothing of it');
  assert.deepEqual(log.filter(e => e.op === 'done').map(e => [e.aborted, e.error]), [[true, 'an instance in its reach was deleted'], [false, undefined]]);

  // A run of its own, going as it's deleted: cut, its sandbox stopped, and nothing it wrote left behind.
  const runsDir = join(tmp, 'scratch', 'runs'), pi = (i: string) => existsSync(runsDir) && readdirSync(runsDir).some(t => existsSync(join(runsDir, t, 'bwrap.args')) && readFileSync(join(runsDir, t, 'bwrap.args'), 'utf8').includes(`RF_INSTANCE\0${i}\0`));
  scripts.push({ bash: ['echo draft > draft.txt; sleep 60'], report: 'Never said.', saw: [] });
  const { id: going } = await (await call('POST', `/api/series/${payroll}`, { label: '2026-11', logins: [] })).json();
  await until('its run going in its sandbox', () => pi(going));
  await new Promise(ok => setTimeout(ok, 1500));
  assert.equal((await call('POST', `/api/instances/${going}/delete`)).status, 200);
  assert.ok(!pi(going), 'its sandbox stopped before the deletion answered');
  assert.deepEqual(readdirSync(join(root, 'instances', going)).sort(), ['instance.json', 'log.jsonl', 'screen.json']);
  const { log: hole } = await (await call('GET', `/api/instances/${going}`)).json();
  assert.deepEqual(hole.map((e: { op: string }) => e.op), ['delete']);
  assert.deepEqual(hole[0].runs.map((r: { outcome: string }) => r.outcome), ['cut'], 'its run, cut, still counts');
  await new Promise(ok => setTimeout(ok, 1500));
  assert.deepEqual(readdirSync(join(root, 'instances', going)).sort(), ['instance.json', 'log.jsonl', 'screen.json'], 'nothing commits or writes there after');
  const path = 'Purge/Report/2026-11', before = (await (await call('GET', '/api/runs')).json()).filter(r => r.path === path);
  assert.ok(before.reduce((n, r) => n + r.cost, 0) > 0);
  const cost = (await (await call('GET', `/api/instances/${id}/summary`)).json()).cost;
  assert.equal((await call('POST', `/api/instances/${id}/delete`)).status, 200);
  const retained = (await (await call('GET', '/api/runs')).json()).filter(r => r.path === path);
  assert.deepEqual(retained, before.map(r => ({ ...r, started: null, error: null })));
  assert.equal((await (await call('GET', `/api/instances/${id}/summary`)).json()).cost, cost);
});

test('closing a run browser writes its log before the run commits, and closing the instance leaves nothing uncommitted or logged after close', async () => {
  closeDelayMs = 800;
  try {
    const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'BrowserClose' })).json();
    const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name: 'Rec' })).json();
    const openPrint = `node -e "const http=require('http');const u=new URL(process.env.RF_BROWSERS+'/print');const r=http.request({hostname:u.hostname,port:u.port,path:u.pathname,headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13'}});r.on('upgrade',(res,s)=>{s.destroy();process.exit(0)});r.end();"`;
    scripts.push({ bash: [openPrint], report: 'Used print browser.', saw: [] });
    const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
    await runs(id, 1);

    assert.equal((await call('POST', `/api/instances/${id}/close`, {})).status, 200);
    await new Promise(r => setTimeout(r, 1100));

    const { log } = await (await call('GET', `/api/instances/${id}`)).json();
    const closeIdx = log.findIndex((e: { op: string }) => e.op === 'close');
    assert.ok(log.slice(0, closeIdx).some((e: { op: string; file?: string }) => e.op === 'browser' && e.file === 'browser/run 1 print.jsonl'));
    assert.deepEqual(log.slice(closeIdx + 1), []);
    assert.ok(execFileSync('git', ['ls-tree', '-r', 'HEAD~1', '--name-only'], { cwd: join(root, 'instances', id), encoding: 'utf8' }).split('\n').includes('browser/run 1 print.jsonl'));
    assert.equal(execFileSync('git', ['status', '--porcelain', 'browser'], { cwd: join(root, 'instances', id), encoding: 'utf8' }), '');
  } finally {
    closeDelayMs = 0;
  }
});

test('a run waking its own workspace is logged in .rf/log.jsonl, and cross-workspace /api/wakes calls never leak unreadable workspace or series names', async () => {
  const { id: secretWs } = await (await call('POST', '/api/workspaces', { name: 'TopSecretMna' })).json();
  const { id: secretSeries } = await (await call('POST', '/api/series', { workspace: secretWs, name: 'DealAlpha' })).json();
  const { id: secretWake } = await (await call('PUT', `/api/wakes/${secretSeries}`, { at: '+4h', label: '2026-12' })).json();

  const { id: ownWs } = await (await call('POST', '/api/workspaces', { name: 'WakeAuditOwn' })).json();
  const { id: ownSeries } = await (await call('POST', '/api/series', { workspace: ownWs, name: 'Ops' })).json();
  const probe: Script = {
    bash: [
      `node -e "const http=require('http'),u=new URL(process.env.RF_URL+'/api/wakes/${secretSeries}');const r=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'PUT',headers:{authorization:'Bearer '+process.env.RF_TOKEN,'content-type':'application/json'}},s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>console.log(s.statusCode+' '+d))});r.end(JSON.stringify({at:'+2h',label:'x'}));"`,
      `node -e "const http=require('http'),u=new URL(process.env.RF_URL+'/api/wakes/${secretWake}');const r=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'DELETE',headers:{authorization:'Bearer '+process.env.RF_TOKEN}},s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>console.log(s.statusCode+' '+d))});r.end();"`,
      'rf wake . +2h --text "Follow up"',
    ],
    report: 'Checked wakes.', saw: [],
  };
  scripts.push(probe);
  const { id: ownInst } = await (await call('POST', `/api/series/${ownSeries}`, { label: '2026-11', logins: [] })).json();
  await runs(ownInst, 1);

  assert.doesNotMatch(probe.saw[0], /TopSecretMna|DealAlpha/);
  assert.match(probe.saw[0], /^403 /);
  assert.doesNotMatch(probe.saw[1], /TopSecretMna|DealAlpha/);
  assert.match(probe.saw[1], /^404 /);

  const rfActs = readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const putAct = rfActs.findLast((a: any) => a.by === 'agent' && a.method === 'PUT' && a.inst === ownInst);
  assert.ok(putAct, 'agent PUT /api/wakes recorded in .rf/log.jsonl');
  assert.equal(putAct.run, 1);
  assert.equal(putAct.wake.target, ownInst);
});

test("every entry names its source: a person, a run whose entry names its runner and the act whose ticks it uses, or what caused it", () => {
  const logs = new Map(readdirSync(join(root, 'instances')).map(id => [id, readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, any>)]));
  for (const [id, log] of logs) for (const e of log) {
    const run = e.run !== undefined && logs.get(e.see?.inst ?? id)!.find(r => r.op === 'run' && r.run === e.run);
    const cause = typeof e.cause === 'number' && log[e.cause - 1];
    assert.ok(e.by.includes('@') || (run && run.runner && run.consent) || (cause && cause.seq < e.seq) || (e.op === 'wake' && e.from !== 'server'), `${id}: ${JSON.stringify(e)}`);
  }
});
