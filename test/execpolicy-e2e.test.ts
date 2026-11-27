import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idp } from './idp.ts';
import { writeFixtureTree } from './owner-fixture.ts';

// Full end-to-end production approval producer test:
// Real server.ts (RF_EXECPOLICY_MODE=enforce) + real sandboxed rf comment --propose --scope +
// real POST /api/messages owner signoff + real HTTPS connections.ts proxy!
type Script = { bash: string[]; report: string; saw: string[] };
const scripts: Script[] = [];
const byPrompt = new Map<string, Script>();

const app = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-ep-e2e-'));
const root = join(tmp, 'data');
const ADMIN = 'admin@demo.test';
const ITEM_A = '01BYE5RZ6QN3K4L8M9N2P5Q7';
const ITEM_B = '01K7QW2M4X9B1C3D5F7H8J2Z9';

let modelAndGraph: ReturnType<typeof createServer>;
let proc: ChildProcess;
let base = '';
let adminCookie = '';
const entra = await idp();
const deletedPaths: string[] = [];

const textOf = (c: unknown): string => typeof c === 'string'
  ? c
  : (c as { type: string; text?: string; content?: unknown }[]).map(b => b.text ?? (b.content === undefined ? '' : textOf(b.content))).join('');
const isResult = (m: { role: string; content: unknown }) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === 'tool_result');

async function handleModel(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  const msgs: { role: string; content: unknown }[] = body.messages;
  const at = msgs.findLastIndex(m => m.role === 'user' && !isResult(m));
  const key = textOf(msgs[at].content);
  if (!byPrompt.has(key)) byPrompt.set(key, scripts.shift()!);
  const s = byPrompt.get(key)!;
  const results = msgs.slice(at + 1).filter(isResult).flatMap(m => (m.content as { type: string; content: unknown }[]).filter(b => b.type === 'tool_result'));
  s.saw = results.map(r => textOf(r.content));
  const step = s.bash[results.length];
  const bash = body.tools.find((t: { name: string }) => /bash/i.test(t.name)).name;
  const block = step === undefined
    ? { type: 'text', text: s.report }
    : { type: 'tool_use', id: `toolu_${Date.now()}_${results.length}`, name: bash, input: { command: step } };
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

const api = (method: string, path: string, body?: object, cookie = adminCookie) =>
  fetch(base + path, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body ? JSON.stringify(body) : undefined });

async function waitRun(instId: string, n: number) {
  let log: any[] = [];
  for (let i = 0; i < 200 && log.filter(e => e.op === 'done').length < n; i++) {
    await new Promise(ok => setTimeout(ok, 150));
    ({ log } = await (await api('GET', `/api/instances/${instId}`)).json());
  }
  assert.ok(log.filter(e => e.op === 'done').length >= n, `run ${n} did not finish: ${JSON.stringify(log)}`);
  return log;
}

before(async () => {
  modelAndGraph = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'POST' && /\/(messages|chat\/completions)$/.test(u.pathname)) {
      return void await handleModel(req, res);
    }
    if (u.pathname === '/api/v1/key') {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { label: 'sk-or-test', usage: 0, usage_daily: 0, limit: 100, limit_remaining: 100 } }));
    }
    if (req.method === 'GET' && u.pathname.startsWith(`/v1.0/drives/d1/items/${ITEM_A}`)) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: ITEM_A, parentReference: { driveId: 'd1', id: 'root' } }));
    }
    if (req.method === 'GET' && u.pathname.startsWith(`/v1.0/drives/d1/items/${ITEM_B}`)) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: ITEM_B, parentReference: { driveId: 'd1', id: 'root' } }));
    }
    if (req.method === 'GET' && u.pathname.startsWith('/v1.0/drives/d1')) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'd1', driveType: 'documentLibrary', sharePointIds: { siteUrl: 'https://contoso.sharepoint.com/sites/fin', siteId: 's1', webId: 'w1' } }));
    }
    if (req.method === 'DELETE' && u.pathname.startsWith('/v1.0/drives/d1/items/')) {
      deletedPaths.push(u.pathname);
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(ok => modelAndGraph.listen(0, '127.0.0.1', ok));
  const mockUrl = `http://127.0.0.1:${(modelAndGraph.address() as { port: number }).port}`;

  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise<void>(ok => probe.close(() => ok()));

  mkdirSync(join(tmp, 'home'), { recursive: true });
  mkdirSync(join(root, '.rf'), { recursive: true });
  writeFixtureTree(root, { workspaces: {}, series: {} });

  // Point both OpenRouter and Graph upstreams (including graph.ts metadata lookups) at our local stand-in!
  const preload = [
    `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)};`,
    `import { endpoints } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections/graph.ts')).href)};`,
    `upstreams['openrouter.ai'] = upstreams['graph.microsoft.com'] = endpoints.graph = ${JSON.stringify(mockUrl)};`,
  ].join(' ');

  proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, join(app, 'src', 'server.ts'), root, new URL(base).port], {
    env: {
      ...process.env,
      HOME: join(tmp, 'home'),
      RF_SCRATCH: join(tmp, 'scratch'),
      OPENROUTER_API_KEY: 'stand-in-key',
      RF_EXECPOLICY_MODE: 'enforce',
      RF_M365_SCOPES: 'Mail.Read Mail.ReadWrite Mail.Send Files.Read.All Files.ReadWrite.All Sites.Read.All',
      RF_ADMINS: ADMIN,
      RF_WAKE_TICK_MS: '500',
      ...entra.env(base),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok());
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });

  const signIn = await entra.signIn(base, ADMIN);
  adminCookie = signIn.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];

  // Configure graph connection + m365 login offers directly in the server's data root
  const { initSystem } = await import('../src/system.ts');
  const { saveLogin } = await import('../src/logins.ts');
  const { keepSignIn } = await import('../src/entra.ts');
  initSystem(root);
  keepSignIn(ADMIN, entra.refresh(ADMIN));
  saveLogin(ADMIN, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '2026-11-01T00:00:00Z',
    offers: [
      { id: `m365:item:d1/${ITEM_A}`, name: 'File A' },
      { id: `m365:item:d1/${ITEM_B}`, name: 'File B' },
    ],
  }, entra.refresh(ADMIN));
  assert.equal((await api('PUT', '/connections/graph', { type: 'graph' })).status, 200);
});

after(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
  }
  modelAndGraph?.close();
  entra.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('end-to-end production approval producer: rf comment --propose --scope -> server validation -> owner signoff -> single-use HMAC-bound enforce proxy', async () => {
  // Create workspace, series (ticking BOTH File A and File B), and an open instance
  const ws = await (await api('POST', '/api/workspaces', { name: 'Finance', owners: [ADMIN], members: [] })).json();
  const ser = await (await api('POST', '/api/series', {
    workspace: ws.id,
    name: 'Cleanup',
    logins: [`m365:item:d1/${ITEM_A}`, `m365:item:d1/${ITEM_B}`],
    autonomous: false,
  })).json();

  // Run 1: Agent tries invalid wildcard scope (rejected 400), then submits valid exact-target proposal via `rf comment . --propose --scope`!
  const run1: Script = {
    bash: [
      `rf comment . --propose --scope '{"action":"graph:excel_write","target":"/v1.0"}' "Wildcard attempt" 2>&1; echo "WILDCARD_EXIT=$?"`,
      `rf comment . --propose --scope '{"action":"graph:file_delete","target":"/v1.0/drives/d1/items/${ITEM_A}","maxUses":1}' "Approve deleting File A"`,
    ],
    report: 'Proposed deleting File A.',
    saw: [],
  };
  scripts.push(run1);

  const inst = await (await api('POST', `/api/series/${ser.id}`, { label: '2026-11' })).json();
  assert.equal((await api('POST', '/api/messages', { instance: inst.id, text: 'Propose deleting File A.' })).status, 200);
  const log1 = await waitRun(inst.id, 1);

  assert.match(run1.saw[0] ?? '', /WILDCARD_EXIT=1/, 'server rejected broad wildcard scope');
  assert.match(run1.saw[1] ?? '', /^proposed c\d+/, 'valid scoped proposal accepted via rf CLI');

  const prop = log1.find(e => e.op === 'comment' && e.ask === 'proposal' && e.execpolicy);
  assert.ok(prop, 'proposal persisted with validated execpolicy');
  assert.equal(prop.execpolicy.action, 'graph:file_delete');
  assert.equal(prop.execpolicy.workspace, ws.id);
  assert.equal(prop.execpolicy.maxUses, 1);
  assert.match(prop.execpolicy.targetDigest, /^[a-f0-9]{64}$/, 'server computed keyed HMAC targetDigest');
  assert.equal(prop.execpolicy.target, undefined, 'raw unredacted target not persisted');

  // Run 2 (triggered by owner signoff!):
  // 1. DELETE File B (different real ID, same redacted display path!) -> 403 graph_file_delete!
  // 2. DELETE File A (exact approved HMAC digest!) -> 204!
  // 3. 2nd DELETE File A (single-use already consumed!) -> 403 graph_file_delete!
  const run2: Script = {
    bash: [
      `curl -s -o /tmp/b.out -w "%{http_code}" -X DELETE "https://graph.microsoft.com/v1.0/drives/d1/items/${ITEM_B}"; echo ""; cat /tmp/b.out`,
      `curl -s -o /tmp/a1.out -w "%{http_code}" -X DELETE "https://graph.microsoft.com/v1.0/drives/d1/items/${ITEM_A}"`,
      `curl -s -o /tmp/a2.out -w "%{http_code}" -X DELETE "https://graph.microsoft.com/v1.0/drives/d1/items/${ITEM_A}"; echo ""; cat /tmp/a2.out`,
    ],
    report: 'Done.',
    saw: [],
  };
  scripts.push(run2);

  // Real owner signoff via POST /api/messages (how: 'approve')
  const approveRes = await api('POST', '/api/messages', { instance: inst.id, id: `c${prop.seq}`, how: 'approve', text: 'Approved File A delete' });
  assert.equal(approveRes.status, 200);
  const log2 = await waitRun(inst.id, 2);

  // Verify Git signoff commit attests to the exact ExecPolicy-Scope!
  const signoffEntry = log2.find(e => e.op === 'signoff' && e.on === prop.seq);
  assert.ok(signoffEntry?.commit, 'owner signoff recorded git commit');
  const commitMsg = execFileSync('git', ['show', '-s', '--format=%B', signoffEntry.commit], {
    cwd: join(root, 'instances', inst.id),
    encoding: 'utf8',
  });
  assert.match(commitMsg, /ExecPolicy-Scope: .*"graph:file_delete"/, 'git signoff commit records exact approved scope');

  // Verify enforce-mode proxy verdicts across all 3 real HTTPS requests!
  assert.match(run2.saw[0] ?? '', /^403\b[\s\S]*"ruleId":"graph_file_delete"/, 'File B denied despite identical redacted display path');
  assert.match(run2.saw[1] ?? '', /^204\b/, 'File A allowed once by owner-signed HMAC scope');
  assert.match(run2.saw[2] ?? '', /^403\b[\s\S]*"ruleId":"graph_file_delete"/, '2nd File A delete denied after single-use consumption');
  assert.deepEqual(deletedPaths, [`/v1.0/drives/d1/items/${ITEM_A}`], 'upstream Graph received ONLY the single approved File A DELETE');
});
