import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
let entra: Awaited<ReturnType<typeof idp>>, srv: ChildProcess, base = '';
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

async function runRf(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, ['--preserve-symlinks', rfScript, ...args], {
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
  const treePath = join(root, '.rf', 'tree.json');
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));
  tree.workspaces['1b3031035ff6'].owners = ['carol@demo.test'];
  tree.workspaces['1b3031035ff6'].members = ['bob@demo.test'];
  tree.workspaces['wsbeta000001'] = { name: 'beta-ws', owners: ['admin@demo.test'], members: [] };
  tree.workspaces['wsseeddup001'] = { name: 'seeded-dup', owners: ['carol@demo.test', 'bob@demo.test'], members: ['bob@demo.test'] };
  tree.series['serbank00001'] = { name: 'Bank pack', workspace: '1b3031035ff6' };
  tree.series['serbeta00001'] = { name: 'Beta series', workspace: 'wsbeta000001' };
  writeFileSync(treePath, JSON.stringify(tree, null, 1));
  mkdirSync(join(root, 'series', 'serbank00001'), { recursive: true });
  mkdirSync(join(root, 'series', 'serbeta00001'), { recursive: true });

  seedInst('instjan00001', 'serbank00001', 'January', 'carol@demo.test', [
    { by: 'server', op: 'run', run: 1, runner: 'carol@demo.test', consent: 1, upto: 1, key: 'shared' },
    { by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 0.42, estimated: false },
  ]);
  seedInst('instfeb00001', 'serbank00001', 'February', 'carol@demo.test');
  seedInst('instdel00001', 'serbank00001', 'ToDelete', 'carol@demo.test');
  seedInst('instbet00001', 'serbeta00001', '2026-11', 'admin@demo.test', [
    { by: 'server', op: 'run', run: 1, runner: 'admin@demo.test', consent: 1, upto: 1, key: 'shared' },
    { by: 'server', op: 'done', run: 1, aborted: false, seen: 1, cost: 1.25, estimated: false },
  ]);

  writeFileSync(join(root, '.rf', 'costs.jsonl'), [
    { at: '2026-11-15T08:01:00.000Z', inst: 'instjan00001', run: 1, service: 'openrouter', cost: 0.42 },
    { at: '2026-11-15T08:01:00.000Z', inst: 'instbet00001', run: 1, service: 'openrouter', cost: 1.25 },
    { at: '2026-11-15T08:02:00.000Z', by: 'server', kind: 'website-check', site: 'erp', person: 'admin@demo.test', service: 'openrouter', cost: 0.09 },
  ].map(x => JSON.stringify(x) + '\n').join(''));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  const srvEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tmp, 'srv-home'),
    RF_SCRATCH: join(tmp, 'scratch'),
    RF_MIN_FREE_GB: '0',
    RF_ADMINS: 'admin@demo.test',
    ...entra.env(base),
  };
  mkdirSync(srvEnv.HOME!, { recursive: true });
  delete srvEnv.OPENROUTER_API_KEY;
  delete srvEnv.RF_BROWSER_URL;

  srv = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], {
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
