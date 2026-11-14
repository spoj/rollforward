import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { id as imageId } from '../src/agent.ts';
import { idp } from './idp.ts';

// scripts/update.ts end-to-end against a real git remote, checkout and server: pre-staging before draining, waiting for going runs
// up to RF_DRAIN_MIN, Urgent: tags skipping the drain, older servers without /drained or SIGUSR2, older updaters without drain, and
// a server restarting mid-drain.
type Release = { tag_name: string; draft?: boolean; prerelease?: boolean; body?: string; html_url: string };
type Script = { bash: (() => string | Promise<string>)[]; report: string };

const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-update-'));
const remote = join(tmp, 'remote.git'), work = join(tmp, 'work'), oldApp = join(tmp, 'old'), root = join(tmp, 'data'), home = join(tmp, 'home');
const ADMIN = 'admin@demo.test';
const releases: Release[] = [], scripts: Script[] = [], byPrompt = new Map<string, Script>();
const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
let drainedProbes = 0;
let entra: Awaited<ReturnType<typeof idp>>, hub: ReturnType<typeof createServer>, proc: ChildProcess | null = null;
let base = '', hubBase = '', cookie = '', serveDir = work;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@demo.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@demo.test' } }).trim();
const text = (c: unknown): string => typeof c === 'string' ? c : (c as { text?: string; content?: unknown }[]).map(b => b.text ?? (b.content === undefined ? '' : text(b.content))).join('');
const isResult = (m: { content: unknown }) => Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === 'tool_result');

async function model(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
  const msgs: { role: string; content: unknown }[] = body.messages, at = msgs.findLastIndex(m => m.role === 'user' && !isResult(m));
  const key = text(msgs[at].content);
  if (!byPrompt.has(key)) byPrompt.set(key, scripts.shift() ?? { bash: [], report: 'Done.' });
  const s = byPrompt.get(key)!, results = msgs.slice(at + 1).filter(isResult).flatMap(m => (m.content as { type: string }[]).filter(b => b.type === 'tool_result'));
  const step = s.bash[results.length], bash = body.tools.find((t: { name: string }) => /bash/i.test(t.name)).name;
  const block = step === undefined ? { type: 'text', text: s.report } : { type: 'tool_use', id: `toolu_${Date.now()}`, name: bash, input: { command: await step() } };
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

async function startServer(dir = serveDir) {
  serveDir = dir;
  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(dir, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = ${JSON.stringify(hubBase)};`;
  const child = spawn(process.execPath, ['--preserve-symlinks', '--import', `data:text/javascript,${encodeURIComponent(upstream)}`, join(dir, 'src', 'server.ts'), root, new URL(base).port], {
    env: { ...process.env, HOME: home, RF_SCRATCH: join(tmp, 'scratch'), OPENROUTER_API_KEY: 'stand-in-key', RF_WAKE_TICK_MS: '300', ...entra.env(base), RF_ADMINS: ADMIN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  proc = child;
  child.once('exit', (code, signal) => {
    exits.push({ code, signal });
    if (proc === child) proc = null;
  });
  await new Promise((ok, fail) => {
    child.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    child.once('exit', (code, signal) => fail(new Error(`server exited (${code ?? signal})`)));
  });
}

async function stopServer() {
  const child = proc;
  if (!child) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const entries = (id: string) => readFileSync(join(root, 'instances', id, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
async function until(what: string, ok: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function doneRuns(id: string, n: number) {
  await until(`run ${n} of ${id}`, () => entries(id).filter(e => e.op === 'done').length >= n);
  return entries(id);
}

// Publishes a release tag on `remote` without disturbing `work`'s current HEAD, and registers it on the stand-in GitHub API.
const stage = join(tmp, 'stage');
function publish(tag: string, o: { body?: string; prerelease?: boolean; extraAgentFile?: string } = {}) {
  for (const p of ['agent', 'bin', 'src', 'scripts', 'web', 'prompt.md', 'package.json', 'package-lock.json', '.gitignore'])
    cpSync(join(app, p), join(stage, p), { recursive: true });
  rmSync(join(stage, 'agent', 'extra'), { force: true });
  if (o.extraAgentFile) writeFileSync(join(stage, 'agent', 'extra'), o.extraAgentFile);
  writeFileSync(join(stage, 'RELEASE'), `${tag}\n`);
  git(stage, 'add', '-A');
  git(stage, 'commit', '-q', '-m', tag);
  git(stage, 'tag', '-a', tag, '-m', o.body ?? tag);
  git(stage, 'push', '-q', 'origin', `refs/tags/${tag}`);
  releases.push({ tag_name: tag, body: o.body ?? tag, prerelease: o.prerelease ?? false, html_url: `${hubBase}/release/${tag}` });
}

function spawnUpdater(dir = work, env: NodeJS.ProcessEnv = {}) {
  const hook = `const f = globalThis.fetch; globalThis.fetch = (u, i) => { const s = String(u); return s.startsWith('https://api.github.com/') || s.startsWith('https://github.com/') ? f(s.replace(/^https:\\/\\/(api\\.)?github\\.com/, ${JSON.stringify(hubBase)}), i) : s.endsWith('/drained') ? (f(${JSON.stringify(`${hubBase}/probe`)}).catch(() => {}), f(u, i)) : f(u, i); };`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, join(dir, 'scripts', 'update.ts'), `${base}/`], {
    cwd: dir,
    env: { ...process.env, HOME: home, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', d => { out += d; });
  child.stderr!.on('data', d => { out += d; });
  return { child, done: once(child, 'exit').then(([code]) => ({ code, out })) };
}

before(async () => {
  mkdirSync(home, { recursive: true });
  entra = await idp();
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
  await new Promise(ok => probe.close(ok));

  hub = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://hub');
    if (req.method === 'POST' && url.pathname.endsWith('/messages')) return model(req, res);
    if (url.pathname === '/probe') { drainedProbes++; return void res.end('ok'); }
    if (url.pathname === '/ctl/pid') return void res.end(String(proc?.pid ?? 0));
    if (url.pathname === '/ctl/stop') { await stopServer(); return void res.end('ok'); }
    if (url.pathname === '/ctl/start') { serveDir = work; await startServer(work); return void res.end('ok'); }
    if (url.pathname === '/ctl/restart') { await stopServer(); serveDir = work; await startServer(work); return void res.end('ok'); }
    if (url.pathname === '/repos/spoj/rollforward/releases') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(releases));
    if (url.pathname.startsWith('/repos/spoj/rollforward/commits/'))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }] }));
    res.writeHead(404).end('not found');
  });
  await new Promise<void>(ok => hub.listen(0, '127.0.0.1', ok));
  hubBase = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;

  // Stand-in systemctl for scripts/update.ts: reports MainPID and stops/starts the server in `work`.
  mkdirSync(join(tmp, 'bin'));
  const ctl = join(tmp, 'bin', 'systemctl');
  writeFileSync(ctl, `#!/bin/sh
case "$*" in
  *MainPID*) curl -fsS ${hubBase}/ctl/pid;;
  *"stop rollforward") curl -fsS -X POST ${hubBase}/ctl/stop >/dev/null;;
  *"start rollforward") curl -fsS -X POST ${hubBase}/ctl/start >/dev/null;;
  *"restart rollforward") curl -fsS -X POST ${hubBase}/ctl/restart >/dev/null;;
  *) exit 1;;
esac
`);
  chmodSync(ctl, 0o755);

  // Build remote with v0.5.0: an older server and updater that know neither /drained nor SIGUSR2.
  git(tmp, 'init', '--bare', '-q', remote);
  git(tmp, 'clone', '-q', remote, stage);
  for (const p of ['agent', 'bin', 'src', 'scripts', 'web', 'prompt.md', 'package.json', 'package-lock.json', '.gitignore'])
    cpSync(join(app, p), join(stage, p), { recursive: true });
  const srv = readFileSync(join(stage, 'src', 'server.ts'), 'utf8');
  const olderServer = srv
    .replace("    if (req.method === 'GET' && url.pathname === '/drained') return void res.writeHead(drained() ? 200 : 503).end();\n", '')
    .replace("process.on('SIGUSR2', drain);\n", '')
    .replace(', draining: updating()', '');
  assert.notEqual(olderServer, srv);
  assert.ok(!olderServer.includes("url.pathname === '/drained'") && !olderServer.includes("process.on('SIGUSR2'"));
  writeFileSync(join(stage, 'src', 'server.ts'), olderServer);

  const upd = readFileSync(join(stage, 'scripts', 'update.ts'), 'utf8');
  const olderUpdater = upd.replace(/const urgent = [\s\S]*?else await drain\(\);\n/, '');
  assert.notEqual(olderUpdater, upd);
  writeFileSync(join(stage, 'scripts', 'update.ts'), olderUpdater);

  git(stage, 'add', '-A');
  git(stage, 'commit', '-q', '-m', 'v0.5.0');
  git(stage, 'tag', '-a', 'v0.5.0', '-m', 'v0.5.0');
  git(stage, 'push', '-q', 'origin', 'HEAD', 'refs/tags/v0.5.0');
  releases.push({ tag_name: 'v0.5.0', body: 'v0.5.0', html_url: `${hubBase}/release/v0.5.0` });

  // Keep a standalone copy of v0.5.0 too, and clone `work` checked out on v0.5.0 as a host's checkout is.
  git(tmp, 'clone', '-q', remote, oldApp);
  git(oldApp, 'checkout', '-q', '--detach', 'v0.5.0');
  git(tmp, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '--detach', 'v0.5.0');
  for (const d of [oldApp, work]) {
    symlinkSync(join(app, 'node_modules'), join(d, 'node_modules'));
    mkdirSync(join(d, '.agent'), { recursive: true });
    symlinkSync(join(app, '.agent', imageId), join(d, '.agent', imageId));
  }

  await startServer(work);
  cookie = (await entra.signIn(base, ADMIN)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
});

after(async () => {
  await stopServer();
  await new Promise(ok => hub.close(ok));
  entra.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function makeSeries(ws: string, name: string, hold = false) {
  let reached = false, go!: () => void;
  const gate = new Promise<void>(ok => (go = ok));
  scripts.push({ bash: hold ? [async () => { reached = true; await gate; return 'echo ok'; }] : [], report: 'Done.' });
  const { id: series } = await (await call('POST', '/api/series', { workspace: ws, name })).json();
  const { id } = await (await call('POST', `/api/series/${series}`, { label: '2026-11', logins: [] })).json();
  if (hold) await until(`${name} mid-turn`, () => reached);
  else await doneRuns(id, 1);
  return { id: id as string, go };
}

test('an older checkout updates to the new server without draining, and an older updater stops the new server cleanly too', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Updates' })).json();
  assert.equal((await fetch(`${base}/drained`)).status, 401, 'v0.5.0 knows no /drained');
  const busy = await makeSeries(ws, 'FromOld', true);
  scripts.push({ bash: [], report: 'Woken on v0.5.1.' });
  publish('v0.5.1');
  // `work` is at v0.5.0, so `work/scripts/update.ts` is the older updater.
  const first = await spawnUpdater(work).done;
  busy.go();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /v0\.5\.0 -> v0\.5\.1[\s\S]*on v0\.5\.1/);
  assert.equal(git(work, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.5.1');
  assert.equal((await fetch(`${base}/drained`)).status, 503, 'the new server answers /drained');
  assert.deepEqual((await doneRuns(busy.id, 2)).filter(e => e.op === 'done').map(e => e.aborted), [true, false]);

  // Now the new server (v0.5.1) is running; run the older updater against it (as when an older script drives a stop/start).
  publish('v0.5.2');
  git(oldApp, 'checkout', '-q', '--detach', 'v0.5.0');
  const probesBefore = drainedProbes;
  const second = await spawnUpdater(oldApp).done;
  assert.equal(second.code, 0, second.out);
  assert.equal(drainedProbes, probesBefore, 'the older updater never called /drained');
  git(work, 'fetch', '-q', '--tags', 'origin');
  git(work, 'checkout', '-q', '--detach', 'v0.5.2');
  await stopServer();
  await startServer(work);
});

test('the new updater against an older server that knows no drain does not send SIGUSR2, which would kill it, and stops it cleanly', async () => {
  // Run the older v0.5.0 server while `work` has the new updater at v0.5.2.
  await stopServer();
  git(oldApp, 'checkout', '-q', '--detach', 'v0.5.0');
  await startServer(oldApp);
  assert.equal((await fetch(`${base}/drained`)).status, 401);
  exits.length = 0;
  publish('v0.5.3');
  const res = await spawnUpdater(work).done;
  assert.equal(res.code, 0, res.out);
  assert.equal(exits[0]?.signal === 'SIGUSR2', false, 'never killed with SIGUSR2');
  assert.equal(git(work, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.5.3');
  assert.equal((await fetch(`${base}/drained`)).status, 503);
});

test('a pre-stage failure before the stop never signals a drain, leaving the server running and undrained', async () => {
  publish('v0.5.4', { extraAgentFile: 'unpublished-image\n' });
  const probesBefore = drainedProbes;
  const res = await spawnUpdater(work).done;
  assert.notEqual(res.code, 0);
  assert.equal(drainedProbes, probesBefore, 'failed before drain() was reached');
  assert.equal((await (await call('GET', '/me')).json()).draining, null);
  assert.equal(git(work, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.5.3');
  releases.pop();
});

test('update.ts drains going runs so they finish un-cut before the stop, and cuts what still runs past RF_DRAIN_MIN', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'Drained' })).json();
  const going = await makeSeries(ws, 'Finishes', true), waited = await makeSeries(ws, 'Waits');
  publish('v0.5.5');
  const u1 = spawnUpdater(work);
  await until('server draining', async () => (await (await call('GET', '/me')).json()).draining === 1);
  assert.equal((await call('POST', `/api/instances/${waited.id}/comment`, { text: 'After.' })).status, 200);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(entries(waited.id).filter(e => e.op === 'run').length, 1, 'held back during drain');
  going.go();
  scripts.push({ bash: [], report: 'Started after restart.' });
  const r1 = await u1.done;
  assert.equal(r1.code, 0, r1.out);
  assert.doesNotMatch(r1.out, /the runs still going are cut/);
  assert.deepEqual(entries(going.id).filter(e => e.op === 'done').map(e => e.aborted), [false], 'finished cleanly before stop');
  await doneRuns(waited.id, 2);

  // Now a run that never ends before RF_DRAIN_MIN: cut at the limit, while queued runs still wait until after the restart.
  const stuck = await makeSeries(ws, 'NeverEnds', true);
  publish('v0.5.6');
  const u2 = spawnUpdater(work, { RF_DRAIN_MIN: '0.04' });
  await until('server draining again', async () => (await (await call('GET', '/me')).json()).draining === 1);
  assert.equal((await call('POST', `/api/instances/${waited.id}/comment`, { text: 'Third.' })).status, 200);
  scripts.push({ bash: [], report: 'Stuck carried on.' }, { bash: [], report: 'Waited third.' });
  const r2 = await u2.done;
  stuck.go();
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /the runs still going are cut/);
  assert.equal(entries(waited.id).filter(e => e.op === 'done' && e.aborted).length, 0, 'queued run did not start right before stop');
  assert.deepEqual((await doneRuns(stuck.id, 2)).filter(e => e.op === 'done').map(e => e.error), ['a restart cut the run', undefined]);
  await doneRuns(waited.id, 3);
});

test('a release on the way with an Urgent: line skips the drain, and a server restart mid-drain lets the update finish', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'UrgentAndRestart' })).json();
  const urgentRun = await makeSeries(ws, 'Urgent', true);
  // v0.5.7 carries Urgent: in its notes, and v0.5.8 follows it without: moving v0.5.6 -> v0.5.8 crosses v0.5.7 so skips the drain.
  publish('v0.5.7', { body: 'Plug leak\n\nUrgent: cut going runs at once' });
  publish('v0.5.8', { body: 'Follow-up note' });
  scripts.push({ bash: [], report: 'Carried on after urgent.' });
  const probesBefore = drainedProbes, t0 = Date.now();
  const r1 = await spawnUpdater(work).done; // default RF_DRAIN_MIN is 15 minutes
  urgentRun.go();
  assert.equal(r1.code, 0, r1.out);
  assert.ok(Date.now() - t0 < 30_000, 'did not wait RF_DRAIN_MIN');
  assert.match(r1.out, /v0\.5\.7 is urgent: the runs going are cut/);
  assert.equal(drainedProbes, probesBefore, 'skipped drain() altogether');
  assert.equal(git(work, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.5.8');
  await doneRuns(urgentRun.id, 2);

  // Mid-drain server restart: MainPID changes while update.ts polls /drained, so drain() returns and move() completes.
  const mid = await makeSeries(ws, 'MidRestart', true);
  publish('v0.5.9');
  scripts.push({ bash: [], report: 'After mid-drain restart.' }, { bash: [], report: 'After update.' });
  const u2 = spawnUpdater(work);
  await until('draining before mid-drain restart', async () => (await (await call('GET', '/me')).json()).draining === 1);
  await fetch(`${hubBase}/ctl/restart`, { method: 'POST' });
  mid.go();
  const r2 = await u2.done;
  assert.equal(r2.code, 0, r2.out);
  assert.doesNotMatch(r2.out, /the runs still going are cut/);
  assert.equal(git(work, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.5.9');
});

test('RF_DRAIN_MIN=0 updates without probing or signalling a drain', async () => {
  publish('v0.5.10');
  const before = drainedProbes;
  const result = await spawnUpdater(work, { RF_DRAIN_MIN: '0' }).done;
  assert.equal(result.code, 0, result.out);
  assert.equal(drainedProbes, before);
});
