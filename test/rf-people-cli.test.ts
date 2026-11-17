import { after, before, test } from 'node:test';
import { readFixtureTree, writeFixtureTree } from './owner-fixture.ts';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { idp } from './idp.ts';

const execFileP = promisify(execFile);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const rfScript = join(app, 'src', 'rf-people.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-people-cli-')), root = join(tmp, 'data');

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(ok => s.close(() => ok()));
  return port;
}

type Actor = { cookie: string; home: string; token: string };
let entra: Awaited<ReturnType<typeof idp>>, srv: ChildProcess, orMock: ReturnType<typeof createHttpServer>, base = '';
let admin: Actor, carol: Actor, bob: Actor;

function seedInst(id: string, series: string, label: string, runner: string, extraLog: object[] = []) {
  const dir = join(root, 'instances', id);
  mkdirSync(join(dir, 'upload'), { recursive: true });
  mkdirSync(join(dir, 'working'), { recursive: true });
  writeFileSync(join(dir, 'instance.json'), JSON.stringify({ label, series }));
  writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [{ id: 'u1', name: 'wrong', kind: 'input', file: 'upload/wrong.csv' }] }));
  writeFileSync(join(dir, 'upload', 'wrong.csv'), 'a,b\n1,2\n');
  writeFileSync(join(dir, 'working', 'good.csv'), 'x,y\n9,9\n');
  const log = [{ by: runner, op: 'create', logins: [] }, ...extraLog].map((e, k) =>
    JSON.stringify({ seq: k + 1, at: `2026-11-15T08:${String(k).padStart(2, '0')}:00.000Z`, ...e }) + '\n'
  ).join('');
  writeFileSync(join(dir, 'log.jsonl'), log);
}

async function runRf(home: string, args: string[], extraEnv: Record<string, string> = {}, nodeFlags: string[] = [], stdin?: string) {
  if (stdin !== undefined) {
    return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
      const p = spawn(process.execPath, ['--preserve-symlinks', ...nodeFlags, rfScript, ...args], {
        env: { ...process.env, HOME: home, NODE_OPTIONS: '--preserve-symlinks', ...extraEnv },
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => stdout += d);
      p.stderr.on('data', d => stderr += d);
      p.on('close', code => done({ code: code ?? 1, stdout, stderr }));
      p.stdin.end(stdin);
    });
  }
  try {
    const { stdout, stderr } = await execFileP(process.execPath, ['--preserve-symlinks', ...nodeFlags, rfScript, ...args], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: '--preserve-symlinks', ...extraEnv },
      timeout: 8000,
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

before(async () => {
  cpSync(join(app, 'test', 'fixture'), root, { recursive: true });

  const tree = readFixtureTree(root);
  tree.workspaces['1b3031035ff6'].owners = ['carol@demo.test'];
  tree.workspaces['1b3031035ff6'].members = ['bob@demo.test'];
  tree.workspaces['wsbeta000001'] = { name: 'beta-ws', owners: ['admin@demo.test'], members: [] };
  tree.workspaces['wsseeddup001'] = { name: 'seeded-dup', owners: ['carol@demo.test', 'bob@demo.test'], members: ['bob@demo.test'] };
  tree.series['serbank00001'] = { name: 'Bank pack', workspace: '1b3031035ff6' };
  tree.series['serbeta00001'] = { name: 'Beta series', workspace: 'wsbeta000001' };
  writeFixtureTree(root, tree);
  mkdirSync(join(root, 'series', 'serbank00001'), { recursive: true });
  mkdirSync(join(root, 'series', 'serbeta00001'), { recursive: true });
  writeFileSync(join(root, '.rf', 'users.json'), JSON.stringify(Object.fromEntries(['admin', 'carol', 'bob'].map(name => [`${name}@demo.test`, { role: name === 'admin' ? 'admin' : 'user', name, created: '2026-11-15T08:00:00.000Z' }]))));

  for (const [id, series] of Object.entries(tree.series) as [string, { workspace: string }][]) {
    const owner = series.workspace === 'wsbeta000001' ? 'admin@demo.test' : 'carol@demo.test', at = '2026-11-15T08:00:00.000Z';
    mkdirSync(join(root, 'series', id), { recursive: true });
    writeFileSync(join(root, 'series', id, 'series.json'), JSON.stringify({ version: 1, owner, epoch: 1, since: at, consent: { by: owner, at, workspace: series.workspace, logins: [], autonomous: false } }));
  }

  seedInst('instjan00001', 'serbank00001', 'January', 'carol@demo.test', [
    { by: 'server', op: 'run', run: 1, runner: 'carol@demo.test', consent: 1, upto: 1, key: 'shared' },
    { by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 0.42, estimated: false },
  ]);
  seedInst('instfeb00001', 'serbank00001', 'February', 'bob@demo.test', [
    { by: 'server', op: 'run', run: 1, runner: 'bob@demo.test', consent: 1, upto: 1, key: 'shared' },
    { by: 'server', op: 'done', run: 1, aborted: true, seen: 0, cost: 0.10, estimated: false, error: 'a restart cut the run' },
    { by: 'server', op: 'run', run: 2, runner: 'bob@demo.test', consent: 1, upto: 1, key: 'shared' },
    { by: 'server', op: 'done', run: 2, aborted: false, seen: 1, cost: 0.20, estimated: true },
  ]);
  seedInst('instdel00001', 'serbank00001', 'ToDelete', 'carol@demo.test');
  seedInst('instbet00001', 'serbeta00001', '2026-11', 'admin@demo.test', [
    { by: 'server', op: 'run', run: 1, runner: 'admin@demo.test', consent: 1, upto: 1, key: 'shared' },
    { by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 1.25, estimated: false },
  ]);
  const bet2Dir = join(root, 'instances', 'instbet00002');
  mkdirSync(join(bet2Dir, 'upload'), { recursive: true });
  mkdirSync(join(bet2Dir, 'working'), { recursive: true });
  writeFileSync(join(bet2Dir, 'instance.json'), JSON.stringify({ label: '2026-12', series: 'serbeta00001' }));
  writeFileSync(join(bet2Dir, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
  writeFileSync(join(bet2Dir, 'log.jsonl'), [
    { seq: 1, at: '2026-11-16T08:00:00.000Z', by: 'admin@demo.test', op: 'create', logins: [] },
    { seq: 2, at: '2026-11-16T08:01:00.000Z', by: 'server', op: 'run', run: 1, runner: 'admin@demo.test', consent: 1, upto: 1, key: 'shared' },
    { seq: 3, at: '2026-11-16T08:02:00.000Z', by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 0.50, estimated: false },
  ].map(e => JSON.stringify(e) + '\n').join(''));

  writeFileSync(join(root, '.rf', 'costs.jsonl'), [
    { at: '2026-11-15T08:01:00.000Z', inst: 'instjan00001', run: 1, service: 'openrouter', cost: 0.42 },
    { at: '2026-11-15T08:01:00.000Z', inst: 'instfeb00001', run: 1, service: 'openrouter', cost: 0.10 },
    { at: '2026-11-15T08:02:00.000Z', inst: 'instfeb00001', run: 2, service: 'openrouter', cost: 0.20, estimated: true },
    { at: '2026-11-15T08:01:00.000Z', inst: 'instbet00001', run: 1, service: 'openrouter', cost: 1.25 },
    { at: '2026-11-15T08:02:00.000Z', by: 'server', kind: 'website-check', site: 'erp', person: 'admin@demo.test', service: 'openrouter', cost: 0.09 },
    { at: '2026-11-16T08:01:00.000Z', inst: 'instbet00002', run: 1, service: 'openrouter', cost: 0.50 },
  ].map(x => JSON.stringify(x) + '\n').join(''));

  orMock = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: { usage: 10, usage_daily: 2.56, limit: 200, limit_remaining: 190, limit_reset: 'monthly' },
    }));
  });
  await new Promise<void>(ok => orMock.listen(0, '127.0.0.1', ok));
  const orUrl = `http://127.0.0.1:${(orMock.address() as { port: number }).port}`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  const srvEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TZ: 'UTC',
    HOME: join(tmp, 'srv-home'),
    RF_SCRATCH: join(tmp, 'scratch'),
    RF_MIN_FREE_GB: '0',
    RF_ADMINS: 'admin@demo.test',
    OPENROUTER_API_KEY: 'sk-or-test-key',
    ...entra.env(base),
  };
  mkdirSync(srvEnv.HOME!, { recursive: true });
  delete srvEnv.RF_BROWSER_URL;

  const upstream = `import { upstreams } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'connections.ts')).href)}; upstreams['openrouter.ai'] = ${JSON.stringify(orUrl)};`;
  srv = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(upstream)}`, join(app, 'src', 'server.ts'), root, String(port)], {
    env: srvEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    srv.stdout!.on('data', d => { if (String(d).includes('rollforward on')) resolve(); });
    srv.stderr!.on('data', d => process.stderr.write(d));
    srv.once('exit', code => reject(new Error(`server exited ${code}`)));
  });

  const signIn = async (email: string): Promise<Actor> => {
    const res = await entra.signIn(base, email);
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
    const tokRes = await fetch(`${base}/tokens`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ name: 'test', days: 7 }) });
    const { token } = await tokRes.json() as { token: string };
    const home = join(tmp, `home-${email.split('@')[0]}`);
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(join(home, '.config', 'rollforward.json'), JSON.stringify({ url: base, token }));
    return { cookie, home, token };
  };
  [admin, carol, bob] = await Promise.all(['admin@demo.test', 'carol@demo.test', 'bob@demo.test'].map(signIn));
});

after(async () => {
  srv?.kill('SIGTERM');
  if (srv) await once(srv, 'exit');
  orMock?.close();
  entra?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('R4-PEOPLE-01: find(path) rejects excess file segments and trims trailing slashes', async () => {
  const delPrompt = await runRf(carol.home, ['delete', 'larkfield/Bank pack/January/upload/wrong.csv']);
  assert.equal(delPrompt.code, 1);
  assert.doesNotMatch(delPrompt.stderr, /Confirm with --yes/);

  const delYes = await runRf(carol.home, ['delete', 'larkfield/Bank pack/January/upload/wrong.csv', '--yes']);
  assert.equal(delYes.code, 1);
  const janShow = await runRf(carol.home, ['show', 'larkfield/Bank pack/January/', '--json']);
  assert.equal(janShow.code, 0);
  assert.equal(JSON.parse(janShow.stdout).status, 'open');
  assert.equal(JSON.parse(janShow.stdout).owner, 'carol@demo.test');
  assert.equal('runner' in JSON.parse(janShow.stdout), false);
  const febShow = await runRf(carol.home, ['show', 'larkfield/Bank pack/February', '--json']);
  assert.equal(febShow.code, 0);
  assert.equal(JSON.parse(febShow.stdout).owner, 'carol@demo.test', 'a different historical executor is not a second current owner');
  assert.equal(existsSync(join(root, 'instances', 'instjan00001', 'working', 'good.csv')), true);

  const renExtra = await runRf(carol.home, ['rename', 'larkfield/Bank pack/February/upload/wrong.csv', 'wrong2.csv']);
  assert.equal(renExtra.code, 1);
  const ls = await runRf(carol.home, ['ls']);
  assert.match(ls.stdout, /larkfield\/Bank pack\/February/);
  assert.doesNotMatch(ls.stdout, /wrong2\.csv/);

  const archSlash = await runRf(carol.home, ['archive', 'larkfield/Bank pack/']);
  assert.equal(archSlash.code, 0);
  const unarchSlash = await runRf(carol.home, ['archive', 'larkfield/Bank pack/', '--undo']);
  assert.equal(unarchSlash.code, 0);

  const delOk = await runRf(carol.home, ['delete', 'larkfield/Bank pack/ToDelete', '--yes']);
  assert.equal(delOk.code, 0);
  const delShow = await runRf(carol.home, ['show', 'larkfield/Bank pack/ToDelete', '--json']);
  assert.equal(JSON.parse(delShow.stdout).status, 'deleted');
});

test('R4-PEOPLE-03: rf costs [PATH] --daily scopes days, runs and totals to PATH and omits unrelated global items', async () => {
  const unscoped = await runRf(admin.home, ['costs', '--daily'], { TZ: 'UTC' });
  assert.equal(unscoped.code, 0);
  assert.match(unscoped.stdout, /OpenRouter key/);
  assert.match(unscoped.stdout, /beta-ws/);
  assert.match(unscoped.stdout, /website-check/);

  const scopedText = await runRf(admin.home, ['costs', 'larkfield/', '--daily'], { TZ: 'UTC' });
  assert.equal(scopedText.code, 0);
  assert.doesNotMatch(scopedText.stdout, /OpenRouter key|beta-ws|website-check|2026-11-16/);
  assert.match(scopedText.stdout, /^2026-11-15  ~\$0\.72 \(est\.\)  2 runs$/m);
  assert.match(scopedText.stdout, /workspace\s+~\$0\.72 \(est\.\)\s+2 runs\s+larkfield/);

  const scopedJson = JSON.parse((await runRf(admin.home, ['costs', 'larkfield', '--since', '2026-11-15', '--daily', '--json'], { TZ: 'UTC' })).stdout);
  assert.equal(scopedJson.key, undefined);
  assert.equal(scopedJson.days.length, 1);
  assert.equal(scopedJson.days[0].day, '2026-11-15');
  assert.equal(scopedJson.days[0].cost, 0.72);
  assert.equal(scopedJson.days[0].runs_count, 2);
  assert.equal(scopedJson.days[0].estimated, true);
  assert.equal(scopedJson.days[0].server, undefined);
  assert.deepEqual(scopedJson.days[0].by_workspace, { larkfield: { runs: 2, cost: 0.72, estimated: true } });
  assert.deepEqual(scopedJson.days[0].by_person, {
    'carol@demo.test': { runs: 1, cost: 0.42 },
    'bob@demo.test': { runs: 1, cost: 0.3, estimated: true },
  });

  const janJson = JSON.parse((await runRf(admin.home, ['costs', 'larkfield/Bank pack/January', '--daily', '--json'], { TZ: 'UTC' })).stdout);
  assert.equal(janJson.days.length, 1);
  assert.equal(janJson.days[0].cost, 0.42);
  assert.equal(janJson.days[0].runs_count, 1);
  assert.equal(janJson.days[0].estimated, undefined);

  const srvOnly = JSON.parse((await runRf(admin.home, ['costs', 'server', '--daily', '--json'], { TZ: 'UTC' })).stdout);
  assert.equal(srvOnly.key, undefined);
  assert.equal(srvOnly.days.length, 1);
  assert.equal(srvOnly.days[0].cost, 0.09);
  assert.equal(srvOnly.days[0].runs_count, 0);
  assert.equal(srvOnly.days[0].runs.length, 0);
  assert.equal(srvOnly.days[0].server.cost, 0.09);
});

test('R4-PEOPLE-05: rf pull on Windows/macOS skips all files under case-colliding directory prefixes instead of merging them', async () => {
  const sr = await fetch(`${base}/api/series`, {
    method: 'POST', headers: { cookie: carol.cookie }, body: JSON.stringify({ workspace: '1b3031035ff6', name: 'PullCases' }),
  });
  const { id: sid } = await sr.json() as { id: string };
  const mk = async (label: string, file: string) => {
    const r = await fetch(`${base}/api/series/${sid}`, {
      method: 'POST', headers: { cookie: carol.cookie }, body: JSON.stringify({ label, quiet: true }),
    });
    const { id } = await r.json() as { id: string };
    const up = await fetch(`${base}/api/instances/${id}/upload?pane=in&quiet=1&name=${file}`, {
      method: 'POST', headers: { cookie: carol.cookie }, body: file,
    });
    assert.equal(up.status, 200);
  };
  await mk('2026-aug', 'lower.csv');
  await mk('2026-Aug', 'upper.csv');

  for (const platform of ['win32', 'darwin']) {
    const dest = join(tmp, `pull-${platform}`);
    const flag = ['--import', `data:text/javascript,Object.defineProperty(process, 'platform', { value: '${platform}' })`];
    const pulled = await runRf(carol.home, ['pull', 'larkfield/PullCases/', dest], {}, flag);
    assert.equal(pulled.code, 0);
    assert.match(pulled.stderr, /skipped larkfield\/PullCases\/2026-Aug\/upload\/upper\.csv: this disk takes it for larkfield\/PullCases\/2026-aug, which differs only in case/);
    assert.equal(existsSync(join(dest, '2026-aug', 'upload', 'lower.csv')), true);
    assert.equal(existsSync(join(dest, '2026-Aug', 'upload', 'upper.csv')), false);
    assert.equal(existsSync(join(dest, '2026-aug', 'upload', 'upper.csv')), false);

    writeFileSync(join(dest, '2026-aug', 'upload', 'upper.csv'), 'stale');
    const cleaned = await runRf(carol.home, ['pull', 'larkfield/PullCases/', dest, '--delete'], {}, flag);
    assert.equal(cleaned.code, 0);
    assert.equal(existsSync(join(dest, '2026-aug', 'upload', 'upper.csv')), false);
    assert.equal(existsSync(join(dest, '2026-aug', 'upload', 'lower.csv')), true);
  }

  const linuxDest = join(tmp, 'pull-linux-control');
  const linuxFlag = ['--import', "data:text/javascript,Object.defineProperty(process, 'platform', { value: 'linux' })"];
  const linuxPulled = await runRf(carol.home, ['pull', 'larkfield/PullCases/', linuxDest], {}, linuxFlag);
  assert.equal(linuxPulled.code, 0);
  assert.equal(existsSync(join(linuxDest, '2026-aug', 'upload', 'lower.csv')), true);
  assert.equal(existsSync(join(linuxDest, '2026-Aug', 'upload', 'upper.csv')), true);
});

test('R4-PEOPLE-06: rf readers WORKSPACE remove OTHER resolves unseen linked reader workspaces', async () => {
  assert.equal((await runRf(admin.home, ['readers', 'larkfield', 'add', 'beta-ws'])).code, 0);
  const listed = await runRf(carol.home, ['readers', 'larkfield']);
  assert.equal(listed.stdout.trim(), 'beta-ws reads larkfield');

  const addUnseen = await runRf(carol.home, ['readers', 'larkfield', 'add', 'beta-ws']);
  assert.equal(addUnseen.code, 1);
  assert.match(addUnseen.stderr, /no workspace beta-ws/);

  const removed = await runRf(carol.home, ['readers', 'larkfield', 'remove', 'beta-ws']);
  assert.equal(removed.code, 0);
  assert.equal(removed.stdout.trim(), "beta-ws's agents no longer read larkfield");
  assert.equal((await runRf(carol.home, ['readers', 'larkfield'])).stdout.trim(), 'larkfield reads no other workspace, and none reads it');

  assert.equal((await runRf(admin.home, ['readers', 'beta-ws', 'add', 'larkfield'])).code, 0);
  const reverseRemoved = await runRf(carol.home, ['readers', 'beta-ws', 'remove', 'larkfield']);
  assert.equal(reverseRemoved.code, 0);
  assert.equal(reverseRemoved.stdout.trim(), "larkfield's agents no longer read beta-ws");
});

test('R4-PEOPLE-08 + R4-DATA-14: workspace people normalizes owner/member overlap and CLI people --set demotes pre-existing overlapped owners', async () => {
  const putWs = (id: string, body: object, cookie = admin.cookie) =>
    fetch(`${base}/api/workspaces/${id}`, { method: 'PUT', headers: { cookie }, body: JSON.stringify(body) });
  const getPeople = async (id: string) =>
    (await (await fetch(`${base}/api/workspaces/${id}/people`, { headers: { cookie: admin.cookie } })).json()) as { who: string; as: string }[];

  // 1. Pre-existing overlapped data on disk (wsseeddup001 has owners:[carol,bob], members:[bob])
  assert.equal((await putWs('wsseeddup001', { agents: 'bob can manage before demotion' }, bob.cookie)).status, 200);
  const demote = await runRf(admin.home, ['people', 'seeded-dup', '--set', '-'], {}, [], 'owner carol@demo.test\nmember bob@demo.test\n');
  assert.equal(demote.code, 0);
  assert.match(demote.stdout, /bob@demo\.test: owner -> member\nsaved/);
  assert.equal((await putWs('wsseeddup001', { agents: 'bob refused after demotion' }, bob.cookie)).status, 403);
  assert.deepEqual((await getPeople('wsseeddup001')).map(p => [p.who, p.as]), [
    ['carol@demo.test', 'owner'],
    ['bob@demo.test', 'member'],
  ]);

  // 2. Server PUT deduplicates owners and excludes owners from members (including partial PUTs)
  const wRes = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { cookie: admin.cookie }, body: JSON.stringify({ name: 'norm-people' }) });
  const { id: wid } = await wRes.json() as { id: string };
  assert.equal((await putWs(wid, { owners: ['carol@demo.test'], members: ['bob@demo.test'] })).status, 200);
  assert.equal((await putWs(wid, { owners: ['carol@demo.test', 'bob@demo.test', 'bob@demo.test'] })).status, 200);
  assert.deepEqual((await getPeople(wid)).map(p => [p.who, p.as]), [
    ['carol@demo.test', 'owner'],
    ['bob@demo.test', 'owner'],
  ]);
  assert.equal((await putWs(wid, {
    owners: ['carol@demo.test', 'bob@demo.test'],
    members: ['bob@demo.test', 'dana@demo.test', 'dana@demo.test'],
  })).status, 200);
  assert.deepEqual((await getPeople(wid)).map(p => [p.who, p.as]), [
    ['carol@demo.test', 'owner'],
    ['bob@demo.test', 'owner'],
    ['dana@demo.test', 'member'],
  ]);

  // 3. CLI --set with overlapping input uses effective owner precedence without claiming a false demotion, and subsequent demotion works
  const overlapIn = await runRf(admin.home, ['people', 'norm-people', '--set', '-'], {}, [], 'owner carol@demo.test\nowner bob@demo.test\nmember bob@demo.test\n');
  assert.equal(overlapIn.code, 0);
  assert.doesNotMatch(overlapIn.stdout, /owner -> member/);
  const demoteNorm = await runRf(admin.home, ['people', 'norm-people', '--set', '-'], {}, [], 'owner carol@demo.test\nmember bob@demo.test\n');
  assert.equal(demoteNorm.code, 0);
  assert.match(demoteNorm.stdout, /bob@demo\.test: owner -> member\nsaved/);
});

test('R4-PEOPLE-07: rf comment --wait exits on terminal states and steered/stopped failures while preserving cut and recoverable-hold waits', async () => {
  let scenario = '', polls = 0;
  const waitSrv = createHttpServer((req, res) => {
    const send = (val: unknown, code = 200, hdrs: Record<string, string> = {}) =>
      res.writeHead(code, { 'content-type': 'application/json', ...hdrs }).end(JSON.stringify(val));
    if (req.url === '/api') return send([{ id: 'w', name: 'ws', series: [{ id: 's', name: 'ser', instances: [{ id: 'i', label: 'lbl' }] }] }]);
    if (req.url === '/api/instances/i/comment') return send('ok', 200, { 'X-RF-Comment-Seq': '2' });
    if (req.url === '/api/instances/i') {
      polls++;
      const baseLog: any[] = [{ seq: 1, op: 'create' }, { seq: 2, op: 'comment', by: 'alice@demo.test', text: 'Run please' }];
      if (scenario === 'closed' && polls > 1) return send({ doc: { status: 'closed' }, log: [...baseLog, { seq: 3, op: 'close' }], owner: { by: 'alice@demo.test' }, starts: true });
      if (scenario === 'abandoned' && polls > 1) return send({ doc: { status: 'abandoned' }, log: [...baseLog, { seq: 3, op: 'abandon' }], owner: { by: 'alice@demo.test' }, starts: true });
      if (scenario === 'deleted' && polls > 1) return send({ doc: { status: 'deleted' }, log: [{ seq: 1, op: 'delete' }], owner: { by: 'alice@demo.test' }, starts: false });
      if (scenario === 'steer-fail' && polls > 1) return send({
        doc: { status: 'open' },
        log: [{ seq: 1, op: 'run', run: 1, upto: 1 }, baseLog[1], { seq: 3, op: 'done', run: 1, seen: 1, aborted: false, error: 'credits' }],
        owner: { by: 'alice@demo.test' }, starts: true,
      });
      if (scenario === 'stopped' && polls > 1) return send({
        doc: { status: 'open' },
        log: [{ seq: 1, op: 'run', run: 1, upto: 1 }, baseLog[1], { seq: 3, op: 'done', run: 1, seen: 1, aborted: true }],
        owner: { by: 'alice@demo.test' }, starts: true,
      });
      if (scenario === 'init-fail' && polls > 1) return send({
        doc: { status: 'open' },
        log: [...baseLog, { seq: 3, op: 'run', run: 1, upto: 2 }, { seq: 4, op: 'done', run: 1, seen: 1, aborted: false, error: 'credits' }],
        owner: { by: 'alice@demo.test' }, starts: true,
      });
      if (scenario === 'cut-then-done') {
        if (polls === 2) return send({
          doc: { status: 'open' },
          log: [...baseLog, { seq: 3, op: 'run', run: 1, upto: 2 }, { seq: 4, op: 'done', run: 1, seen: 1, aborted: true, error: 'its series moved' }, { seq: 5, op: 'wake', cause: 4 }],
          owner: { by: 'alice@demo.test' }, starts: true,
        });
        if (polls >= 3) return send({
          doc: { status: 'open' },
          log: [...baseLog, { seq: 3, op: 'run', run: 1, upto: 2 }, { seq: 4, op: 'done', run: 1, seen: 1, aborted: true, error: 'its series moved' }, { seq: 5, op: 'wake', cause: 4 },
            { seq: 6, op: 'run', run: 2, upto: 5 }, { seq: 7, op: 'comment', by: 'agent', thread: 'c2', text: 'Finished after cut' }, { seq: 8, op: 'done', run: 2, seen: 5, aborted: false }],
          owner: { by: 'alice@demo.test' }, starts: true,
        });
      }
      if (scenario === 'hold-then-done') {
        if (polls <= 4) return send({
          doc: { status: 'open' }, held: ['entra'],
          log: [...baseLog, { seq: 3, op: 'expired', login: 'entra' }],
          owner: { by: 'alice@demo.test' }, starts: true,
        });
        return send({
          doc: { status: 'open' }, held: [],
          log: [...baseLog, { seq: 3, op: 'expired', login: 'entra' }, { seq: 4, op: 'run', run: 1, upto: 3 },
            { seq: 5, op: 'comment', by: 'agent', thread: 'c2', text: 'Resumed after login' }, { seq: 6, op: 'done', run: 1, seen: 3, aborted: false }],
          owner: { by: 'alice@demo.test' }, starts: true,
        });
      }
      return send({ doc: { status: 'open' }, log: baseLog, owner: { by: 'alice@demo.test' }, starts: true });
    }
    send('ok');
  });
  await new Promise<void>(ok => waitSrv.listen(0, '127.0.0.1', ok));
  const waitHome = join(tmp, 'home-wait');
  mkdirSync(join(waitHome, '.config'), { recursive: true });
  writeFileSync(join(waitHome, '.config', 'rollforward.json'), JSON.stringify({
    url: `http://127.0.0.1:${(waitSrv.address() as { port: number }).port}`, token: 'tok',
  }));
  const fastPoll = ['--import', 'data:text/javascript,const _st=global.setTimeout;global.setTimeout=(f,n,...a)=>_st(f,n===5000?15:n,...a);'];

  const runWait = async (sc: string) => {
    scenario = sc; polls = 0;
    try {
      const { stdout, stderr } = await execFileP(process.execPath, ['--preserve-symlinks', ...fastPoll, rfScript, 'comment', 'ws/ser/lbl', 'Run please', '--wait'], {
        env: { ...process.env, HOME: waitHome, NODE_OPTIONS: '--preserve-symlinks' },
        timeout: 400,
      });
      return { code: 0, stdout, stderr, timedOut: false };
    } catch (e: any) {
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', timedOut: !!e.killed };
    }
  };

  try {
    const closedRes = await runWait('closed');
    assert.equal(closedRes.timedOut, false);
    assert.equal(closedRes.stdout, 'The instance was closed.\n');

    const abandonedRes = await runWait('abandoned');
    assert.equal(abandonedRes.timedOut, false);
    assert.equal(abandonedRes.stdout, 'The instance was abandoned.\n');

    const deletedRes = await runWait('deleted');
    assert.equal(deletedRes.timedOut, false);
    assert.equal(deletedRes.stdout, 'The instance was deleted.\n');

    const steerFail = await runWait('steer-fail');
    assert.equal(steerFail.timedOut, false);
    assert.equal(steerFail.stdout, 'The run failed: credits\n');

    const stoppedRes = await runWait('stopped');
    assert.equal(stoppedRes.timedOut, false);
    assert.equal(stoppedRes.stdout, 'The run was stopped.\n');

    const initFail = await runWait('init-fail');
    assert.equal(initFail.timedOut, false);
    assert.equal(initFail.stdout, 'The run failed: credits\n');

    const cutDone = await runWait('cut-then-done');
    assert.equal(cutDone.timedOut, false);
    assert.match(cutDone.stdout, /Says in c2:\nFinished after cut/);

    const holdDone = await runWait('hold-then-done');
    assert.equal(holdDone.timedOut, false);
    assert.match(holdDone.stdout, /Says in c2:\nResumed after login/);
  } finally {
    waitSrv.close();
  }
});

test('A-R4-PEOPLE-07: rf new task rejects deterministic invalid or colliding labels before creating Untitled tasks', async () => {
  const wRes = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { cookie: admin.cookie }, body: JSON.stringify({ name: 'task-labels' }) });
  const { id: wid } = await wRes.json() as { id: string };
  await fetch(`${base}/api/workspaces/${wid}`, { method: 'PUT', headers: { cookie: admin.cookie }, body: JSON.stringify({ owners: ['carol@demo.test'] }) });
  await fetch(`${base}/api/series`, { method: 'POST', headers: { cookie: carol.cookie }, body: JSON.stringify({ workspace: wid, name: 'Bank_pack' }) });

  for (const [label, pattern] of [
    ['.hidden', /can't start with a dot/],
    ['AGENTS.md', /AGENTS\.md is the name/],
    ['', /a name is needed/],
    ['x'.repeat(201), /200 bytes at most/],
    ['Bank/pack', /Bank_pack exists/],
  ] as const) {
    const r = await runRf(carol.home, ['new', 'task', 'task-labels', label]);
    assert.equal(r.code, 1, `expected failure for label ${JSON.stringify(label)}`);
    assert.match(r.stderr, pattern);
  }

  const lsAfterBad = await runRf(carol.home, ['ls']);
  assert.doesNotMatch(lsAfterBad.stdout, /task-labels\/Untitled/);

  const good = await runRf(carol.home, ['new', 'task', 'task-labels', 'Q4 Audit']);
  assert.equal(good.code, 0);
  assert.match(good.stdout, /made task-labels\/Q4 Audit\/Q4 Audit/);

  const explicitUntitled = await runRf(carol.home, ['new', 'task', 'task-labels', 'Untitled']);
  assert.equal(explicitUntitled.code, 0);
  assert.match(explicitUntitled.stdout, /made task-labels\/Untitled\/Untitled/);

  // Concurrent Untitled creation between initial GET /api and POST /api/series must still fail 409, not silently succeed as Untitled 2
  let getCount = 0;
  const raceHome = join(tmp, 'home-race');
  mkdirSync(join(raceHome, '.config'), { recursive: true });
  const raceSrv = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api') {
      getCount++;
      res.end(JSON.stringify([{
        id: 'w1', name: 'W', owners: ['carol@demo.test'], members: [], readers: [], reads: [],
        series: getCount === 1 ? [] : [
          { id: 's1', name: 'Untitled', single: true, instances: [{ id: 'i1', label: 'Untitled' }] },
          { id: 's2', name: 'Untitled 2', single: true, instances: [{ id: 'i2', label: 'Untitled 2' }] },
        ],
      }]));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/series') {
      res.end(JSON.stringify({ id: 's2', instance: 'i2' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/instances/i2/rename?as=Untitled') {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'Untitled exists' }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
  });
  await new Promise<void>(ok => raceSrv.listen(0, '127.0.0.1', ok));
  try {
    const racePort = (raceSrv.address() as { port: number }).port;
    writeFileSync(join(raceHome, '.config', 'rollforward.json'), JSON.stringify({ url: `http://127.0.0.1:${racePort}`, token: 't' }));
    const raced = await runRf(raceHome, ['new', 'task', 'W', 'Untitled']);
    assert.equal(raced.code, 1);
    assert.match(raced.stderr, /Untitled exists/);
  } finally {
    raceSrv.close();
  }

  const badComment = await runRf(carol.home, ['new', 'task', 'task-labels', '--comment', '']);
  assert.equal(badComment.code, 1);
  const lsAfterCommentErr = await runRf(carol.home, ['ls']);
  assert.match(lsAfterCommentErr.stdout, /task-labels\/Untitled 2\/Untitled 2/);
});






