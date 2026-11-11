import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { filesOf, standIns } from './push.ts';
import { idp } from './idp.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const series = 'Weekly borrowing base', monthly = 'Monthly rec', renamed = 'Weekly BB';

const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data');
let proc: ChildProcess, base: string, admin = '', entra: Awaited<ReturnType<typeof idp>>;
const adminEmail = 'admin@demo.test', bob = 'bob@demo.test';

const json = async (path: string, cookie = admin) => (await fetch(base + path, { headers: { cookie } })).json();
const call = (method: string, path: string, body?: BodyInit, cookie = admin) => fetch(base + path, { method, body, headers: { cookie } });
const sessionOf = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0];
// Signs in as a browser does: Sign in with Microsoft, at a stand-in for Microsoft that signs in whoever it's told.
const login = (email: string) => entra.signIn(base, email);
const workspaces = (cookie = admin) => json('/api', cookie);
const named = async (name: string) => (await workspaces()).find((w: { name: string }) => w.name === name);
const seriesList = async () => (await named('larkfield')).series;
const shown = async (name: string) => (await seriesList()).find((s: { name: string }) => s.name === name);
// Paths by id, found by name in larkfield: a series, or an instance and an action on it.
const iid = async (name: string, label: string) => (await shown(name)).instances.find((i: { label: string }) => i.label === label).id;
const at = async (name: string, label?: string, action?: string) => (label ? `/api/instances/${await iid(name, label)}${action ? `/${action}` : ''}` : `/api/series/${(await shown(name)).id}`);
const dir = async (name: string, label: string) => join(root, 'instances', await iid(name, label));
const create = async (name: string, label: string, cookie = admin) => call('POST', await at(name), JSON.stringify({ label }), cookie);
// An instance's log, by its path, once its nth run has ended.
async function ran(path: string, n = 1) {
  let log: { op: string; [k: string]: any }[] = [];
  for (let i = 0; log.filter(e => e.op === 'done').length < n && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    ({ log } = await json(path));
  }
  assert.ok(log.filter(e => e.op === 'done').length >= n, `run ${n} ended`);
  return log;
}
// Once no run goes or waits, in all an admin sees.
async function quiet() {
  for (let i = 0; i < 240; i++) {
    const { running, queued } = await json('/api/status');
    if (!running.length && !queued.length) return;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.fail('the runs never settled');
}

before(async () => {
  cpSync(join(app, 'test', 'fixture'), root, { recursive: true });
  // What the tests save themselves, such as logins, goes to the server's data root, whichever tests run.
  (await import('../src/system.ts')).initSystem(root);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch') };
  mkdirSync(env.HOME);
  const bin = join(tmp, 'bin'), bwrap = execFileSync('which', ['bwrap'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  writeFileSync(join(bin, 'bwrap'), `#!/bin/sh
case "$*" in
  *race-hold-*) touch "${tmp}/holding-$$"; while [ ! -f "${tmp}/release-previews" ]; do sleep 0.05; done; cat >/dev/null; echo '{}'; exit;;
esac
exec "${bwrap}" "$@"
`, { mode: 0o755 });
  env.PATH = `${bin}:${env.PATH}`;
  delete env.OPENROUTER_API_KEY;
  const probe = createServer();
  await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  Object.assign(env, entra.env(base), { RF_ADMINS: adminEmail });
  proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  admin = sessionOf(await login(adminEmail))!;
  for (const id of readdirSync(standIns)) assert.equal((await call('POST', `/skills/${id}/versions`, JSON.stringify({ files: filesOf(join(standIns, id)) }))).status, 200);
});

after(async () => {
  if (process.platform === 'win32') proc.kill();
  else process.kill(-proc.pid!, 'SIGTERM');
  await once(proc, 'exit');
  entra.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('GET /api lists the series and its instances with statuses', async () => {
  const s = await shown(series);
  assert.deepEqual(s.instances.map((i: { label: string; status: string }) => [i.label, i.status]), [
    ['2026-08-23', 'closed'], ['2026-08-30', 'closed'], ['2026-09-06', 'open'], ['scratch', 'abandoned'],
  ]);
});

test('a new instance of a series starts empty and runs at once; a new series can be made', async () => {
  assert.equal((await create(series, '2026-09-13')).status, 200);
  const { doc, log } = await json(await at(series, '2026-09-13'));
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items, []);
  assert.deepEqual(log.slice(0, 2).map((e: { seq: number; at: string }) => ({ ...e, at: undefined })), [
    { seq: 1, at: undefined, by: adminEmail, op: 'create', logins: [] },
    { seq: 2, at: undefined, by: 'server', op: 'wake', from: adminEmail },
  ]);
  await ran(await at(series, '2026-09-13'));

  const made = await call('POST', '/api/series', JSON.stringify({ workspace: (await named('larkfield')).id, name: monthly }));
  assert.equal(made.status, 200);
  assert.equal((await shown(monthly)).id, (await made.json()).id);
  assert.ok(existsSync(join(root, 'series', (await shown(monthly)).id)));
});

test('an upload lands read-only, becomes an item, and starts one run that ends with an error; a drop onto an item is only a hint', async () => {
  const bytes = 'a,b\n1,2\n', label = '2026-09-13';
  assert.equal((await create(monthly, label)).status, 200);
  await ran(await at(monthly, label));
  assert.equal((await call('POST', `${await at(monthly, label, 'upload')}?by=t&pane=in&name=x.csv`, bytes)).status, 200);
  const file = join(await dir(monthly, label), 'upload', 'x.csv');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mode & 0o222, 0);
  const first = await json(await at(monthly, label));
  assert.deepEqual(first.log.slice(-2).map((e: { op: string }) => e.op), ['upload', 'point']);
  assert.equal(first.log.at(-2).sha256, createHash('sha256').update(bytes).digest('hex'));
  const x = first.doc.items.find((i: { file: string; kind: string }) => i.file === 'upload/x.csv' && i.kind === 'input');
  assert.ok(x);
  assert.equal((await call('POST', `${await at(monthly, label, 'upload')}?by=t&pane=in&name=x.csv&onto=${x.id}`, 'a,b\n1,3\n')).status, 200);
  const second = await json(await at(monthly, label));
  assert.equal(second.log.at(-2).onto, x.id);
  assert.equal(second.doc.items.find((i: { id: string }) => i.id === x.id).file, 'upload/x.csv', 'the agent decides what a drop replaces');
  assert.ok(second.doc.items.some((i: { file: string }) => i.file === 'upload/x_2.csv'));

  assert.ok((await ran(await at(monthly, label), 2)).findLast(e => e.op === 'done')!.error, 'no model reachable, so the run carries an error');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await json(await at(monthly, label))).log.filter((e: { op: string }) => e.op === 'run').length, 2, "the making's and the uploads': a run that never started is not retried");
});

test('an upload streams to disk as it arrives, and is refused if its instance closes meanwhile', async () => {
  const label = '2026-09-20';
  assert.equal((await create(monthly, label)).status, 200);
  await ran(await at(monthly, label));
  let release!: () => void, sent = false;
  const held = new Promise<void>(ok => { release = ok; });
  const body = new ReadableStream({ async pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(1 << 20)); } else { await held; c.close(); } } });
  const upload = fetch(`${base}${await at(monthly, label, 'upload')}?pane=in&name=big.bin`, { method: 'POST', body, duplex: 'half', headers: { cookie: admin } } as RequestInit);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(readdirSync(join(root, '.tmp')).length, 1, 'the body is being written before it has all arrived');
  assert.equal((await call('POST', await at(monthly, label, 'close'))).status, 200);
  release();
  assert.equal((await upload).status, 409);
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
  assert.ok(!existsSync(join(await dir(monthly, label), 'upload', 'big.bin')));
});

test('uploads and comment attachments are refused if their person loses workspace access while the body streams', async t => {
  const b = sessionOf(await login(bob))!;
  const ws = (await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Streaming' }))).json()).id;
  const sid = (await (await call('POST', '/api/series', JSON.stringify({ workspace: ws, name: 'Files' }))).json()).id;
  for (const action of ['upload', 'attach']) await t.test(action, async () => {
    const id = (await (await call('POST', `/api/series/${sid}`, JSON.stringify({ label: action, quiet: true }))).json()).id;
    assert.equal((await call('PUT', `/api/workspaces/${ws}`, JSON.stringify({ members: [bob] }))).status, 200);
    let release!: () => void, sent = false;
    const held = new Promise<void>(ok => { release = ok; });
    const body = new ReadableStream({ async pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(1 << 20)); } else { await held; c.close(); } } });
    const request = fetch(`${base}/api/instances/${id}/${action}?name=${action}.bin&quiet`, { method: 'POST', body, duplex: 'half', headers: { cookie: b } } as RequestInit);
    try {
      for (let n = 0; !readdirSync(join(root, '.tmp')).some(f => statSync(join(root, '.tmp', f)).size === 1 << 20) && n < 200; n++) await new Promise(r => setTimeout(r, 25));
      assert.equal(readdirSync(join(root, '.tmp')).length, 1);
      assert.equal((await call('PUT', `/api/workspaces/${ws}`, JSON.stringify({ members: [] }))).status, 200);
    } finally { release(); }
    assert.equal((await request).status, 404, action);
    assert.deepEqual(readdirSync(join(root, '.tmp')), []);
    assert.deepEqual(readdirSync(join(root, 'instances', id, 'upload')), []);
    assert.deepEqual((await json(`/api/instances/${id}`)).log.map((e: { op: string }) => e.op), ['create']);
  });
});

test('duplicate copies a closed instance into an open one, once', async () => {
  assert.equal((await call('POST', `${await at(series, '2026-09-06', 'duplicate')}?as=x`)).status, 409);
  const dup = `${await at(series, '2026-08-30', 'duplicate')}?as=${encodeURIComponent('2026-08-30 copy')}`;
  const made = await call('POST', dup);
  assert.equal(made.status, 200);
  assert.equal((await made.json()).id, await iid(series, '2026-08-30 copy'));
  const { doc, log } = await json(await at(series, '2026-08-30 copy'));
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items, (await json(await at(series, '2026-08-30'))).doc.items);
  assert.equal(existsSync(join(await dir(series, '2026-08-30 copy'), 'session')), false);
  assert.equal(log.at(-1).op, 'duplicate');
  assert.equal(log.at(-1).from, '2026-08-30');
  assert.equal((await call('POST', dup)).status, 409);
});

test("a duplicate keeps its conversation but counts only runs and cost since its latest duplication", async () => {
  const source = await at(series, '2026-08-30');
  const before = (await json('/api/runs')).filter((r: { path: string }) => !r.path.endsWith('/2026-08-30 copy'));
  assert.ok((await json(`${source}/summary`)).cost > 0);
  const path = await at(series, '2026-08-30 copy'), sum = await json(`${path}/summary`);
  assert.ok(readFileSync(join(root, 'instances', sum.id, 'log.jsonl'), 'utf8').startsWith(readFileSync(join(root, 'instances', source.split('/').pop()!, 'log.jsonl'), 'utf8')));
  assert.deepEqual([sum.cost, await json('/api/runs')], [0, before]);
  const listed = (await shown(series)).instances.find((i: { id: string }) => i.id === sum.id);
  assert.equal(listed.cost, 0);
  const inherited = (await json(path)).log.filter((e: { op: string }) => e.op === 'done').length;
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'Run the copy.' }))).status, 200);
  const log = await ran(path, inherited + 1), run = log.findLast(e => e.op === 'run')!, done = log.findLast(e => e.op === 'done')!;
  const own = (await json('/api/runs')).filter((r: { path: string }) => r.path.endsWith('/2026-08-30 copy'));
  assert.deepEqual(own.map((r: { run: number; cost: number }) => [r.run, r.cost]), [[run.run, done.cost]]);
  assert.equal((await json(`${path}/summary`)).cost, done.cost);
});

test("an instance says which of its files are new since the series' latest closed instance before it, changed or the same, by content", async () => {
  const path = await at(series, '2026-08-30 copy');
  assert.deepEqual((await json(path)).previous, { label: '2026-08-30', changed: { 'ar-aging': 'same', inventory: 'same', 'borrowing-base': 'same' } });
  writeFileSync(join(await dir(series, '2026-08-30 copy'), 'working', 'Borrowing base 08.30.2026.csv'), 'revised\n');
  assert.equal((await json(path)).previous.changed['borrowing-base'], 'changed');
  assert.equal((await json(await at(series, '2026-08-23'))).previous, null);
});

test('rename relabels an instance in any status in its instance.json and logs it; an existing label is refused, a former one free', async () => {
  const rename = async (label: string, to: string) => call('POST', `${await at(series, label, 'rename')}?as=${encodeURIComponent(to)}`);
  const id = await iid(series, '2026-08-30 copy');
  assert.equal((await rename('2026-08-30 copy', '2026-08-30 rework')).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'instances', id, 'instance.json'), 'utf8')), { label: '2026-08-30 rework', series: (await shown(series)).id });
  assert.deepEqual((await json(await at(series, '2026-08-30 rework'))).log.at(-1).from, '2026-08-30 copy');
  assert.equal((await rename('2026-08-30 rework', '2026-09-06')).status, 409);
  assert.equal((await rename('scratch', 'scratch 2')).status, 200, 'abandoned, or closed');
  assert.deepEqual((await json(await at(series, 'scratch 2'))).log.at(-1).from, 'scratch');
  assert.equal((await rename('2026-08-30 rework', 'scratch')).status, 200);
  assert.equal((await rename('scratch', '2026-08-30 rework')).status, 200);
  assert.equal((await rename('scratch 2', 'scratch')).status, 200);
});

test("only the runner closes or abandons; taking over makes you the runner with your own logins ticked", async () => {
  const id = await iid(series, '2026-09-06'), offer = 'web:portal';
  const runner = async () => (await json(`/api/instances/${id}`)).runner;
  assert.deepEqual(await runner(), { by: 'alex', logins: [], consent: 1, ticked: [] }, 'whoever made it, with the logins they ticked making it');
  assert.equal((await call('POST', await at(series, '2026-09-06', 'close'))).status, 403);
  assert.equal((await call('POST', await at(series, '2026-09-06', 'abandon'))).status, 403, 'nor abandons');
  assert.equal((await call('POST', await at(series, '2026-09-06', 'takeover'), JSON.stringify({ logins: [offer] }))).status, 400, 'not a login of yours');
  const { saveLogin } = await import('../src/logins.ts');
  saveLogin(adminEmail, { id: 'web', kind: 'website', name: 'Portal', since: new Date().toISOString(), offers: [{ id: offer, name: 'Portal' }] }, 'state');
  assert.deepEqual((await json('/logins')).map((l: { id: string }) => l.id), ['web']);
  assert.equal((await call('POST', await at(series, '2026-09-06', 'takeover'), JSON.stringify({ logins: [offer] }))).status, 200);
  const took = (await json(`/api/instances/${id}`)).log.findLast((e: { op: string }) => e.op === 'takeover').seq;
  assert.deepEqual(await runner(), { by: adminEmail, logins: [offer], consent: took, ticked: ['Portal'] }, 'their logins by name, as taking over ticked them');
  assert.equal((await json(`/api/instances/${id}`)).log.at(-1).from, 'alex');
  assert.equal((await call('DELETE', '/logins/web')).status, 200);
  assert.deepEqual(await json('/logins'), [], 'signing out deletes the record');
});

test('close and abandon end an open instance; a closed one takes no actions', async () => {
  assert.equal((await call('POST', await at(series, '2026-09-06', 'close'))).status, 200);
  const closed = await json(await at(series, '2026-09-06'));
  assert.equal(closed.doc.status, 'closed');
  assert.equal(closed.log.at(-1).op, 'close');
  for (const action of ['upload', 'comment', 'close', 'abandon'])
    assert.equal((await call('POST', `${await at(series, '2026-09-06', action)}?name=y.csv`, action === 'upload' ? 'x' : '{}')).status, 409, action);

  assert.equal((await call('POST', await at(series, '2026-09-13', 'abandon'))).status, 200);
  const ab = await json(await at(series, '2026-09-13'));
  assert.equal(ab.doc.status, 'abandoned');
  assert.equal(ab.log.at(-1).op, 'abandon');
});

test('a closed instance takes corrections, later entries, each its own commit, saying it or an item of it is wrong or superseded, and where the change is', async () => {
  const fix = async (label: string, body: object) => call('POST', await at(series, label, 'correct'), JSON.stringify(body)), see = await iid(series, '2026-09-13');
  const r = await fix('2026-09-06', { kind: 'wrong', text: ' The rate was a day stale. ', see });
  assert.match(await r.text(), /^2026-09-06 is marked wrong, seq \d+$/);
  const { log } = await json(await at(series, '2026-09-06')), e = log.at(-1);
  assert.deepEqual([e.by, e.op, e.kind, e.text, e.see], [adminEmail, 'correction', 'wrong', 'The rate was a day stale.', { inst: see, label: '2026-09-13' }]);
  const back = (await json(await at(series, '2026-09-13'))).log.at(-1), head = async () => execFileSync('git', ['log', '-1', '--format=%an %s'], { cwd: await dir(series, '2026-09-06'), encoding: 'utf8' });
  assert.deepEqual([back.op, back.inst, back.seq, back.kind], ['corrected', await iid(series, '2026-09-06'), e.seq, 'wrong'], 'the instance it names points back');
  for (let i = 0; i < 50 && !(await head()).includes('Correction'); i++) await new Promise(ok => setTimeout(ok, 100));
  assert.equal(await head(), 'Demo Admin Correction: 2026-09-06 is wrong, see 2026-09-13\n');
  const row = (await shown(series)).instances.find((i: { label: string }) => i.label === '2026-09-06');
  assert.deepEqual([row.corrections, row.wrong], [1, 1], 'the series list counts them, and the wrong ones of the week for its runner');
  for (const [body, why] of [[{ kind: 'fine', text: 'x' }, /a correction is \{"kind": "wrong" or "superseded"/], [{ kind: 'wrong', text: 'x', item: 'nope' }, /no item nope; 2026-09-06's items: /], [{ kind: 'wrong', text: 'x', see, thread: 'c99' }, /no thread c99 in 2026-09-13/]] as [object, RegExp][])
    assert.match(await (await fix('2026-09-06', body)).text(), why);
  assert.equal((await fix('2026-09-13', { kind: 'wrong', text: 'x' })).status, 409, 'only a closed instance');
});

test("series settings write series.json; a rename edits .rf/tree.json", async () => {
  const put = async (name: string, body: object) => call('PUT', await at(name), JSON.stringify(body));
  const id = (await shown(series)).id;
  assert.equal((await put(series, { share: true })).status, 200);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'series', id, 'series.json'), 'utf8'))), ['shared']);
  assert.equal((await put(series, { share: false })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'series', id, 'series.json'), 'utf8')), {});

  assert.equal((await put(series, { name: renamed })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(root, '.rf', 'tree.json'), 'utf8')).series[id].name, renamed);
  assert.equal((await shown(renamed)).id, id);

  assert.equal((await put(renamed, { name: monthly })).status, 409);
  assert.equal((await put(renamed, { name: series })).status, 200);
});

test('a workspace can be made; a workspace or a series is archived and restored, taking nothing meanwhile but being restored, and a renamed series stays archived', async () => {
  const acme = () => named('Acme');
  const { id } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Acme' }))).json();
  const { series: made, ...rest } = await acme();
  assert.deepEqual(rest, { id, name: 'Acme', archived: false, owners: [adminEmail], members: [], manage: true, agents: '', mine: true, proposal: null, moved: [], reads: [], readers: [], grants: [] });
  assert.deepEqual(made, [], 'a workspace starts empty');
  assert.equal((await call('POST', '/api/workspaces', JSON.stringify({ name: 'Acme' }))).status, 409);
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ archived: true }))).status, 200);
  assert.equal((await acme()).archived, true);
  // Archived, nothing in it changes: every act in it is refused but restoring it, and it is read as it is.
  const refused = async (method: string, path: string, body = '{}') => { const r = await call(method, path, body); return [r.status, await r.text()]; };
  const shut = (name: string) => [409, `${name} is archived: nothing in it changes until it's restored`];
  assert.deepEqual(await refused('POST', '/api/series', JSON.stringify({ workspace: id, name: 'Payroll' })), shut('Acme'));
  assert.deepEqual(await refused('PUT', `/api/workspaces/${id}`, JSON.stringify({ name: 'Acme 2', members: [bob] })), shut('Acme'));
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ archived: false }))).status, 200);
  assert.equal((await acme()).archived, false);

  const put = async (name: string, to: string, archived: boolean) => call('PUT', await at(name), JSON.stringify({ name: to, archived }));
  assert.equal((await put(series, renamed, true)).status, 200);
  assert.equal((await shown(renamed)).archived, true);
  assert.deepEqual(await refused('POST', await at(renamed, '2026-09-06', 'comment'), '{"text":"x"}'), shut(renamed));
  assert.deepEqual(await refused('POST', `${await at(renamed, '2026-09-06', 'upload')}?name=a.txt`, 'a'), shut(renamed));
  assert.deepEqual(await refused('POST', `${await at(renamed, '2026-09-06', 'rename')}?as=x`), shut(renamed));
  assert.deepEqual(await refused('POST', await at(renamed), '{"label":"2026-09-13"}'), shut(renamed));
  assert.deepEqual(await refused('PUT', await at(renamed), '{"name":"x"}'), shut(renamed));
  assert.equal((await call('GET', await at(renamed, '2026-09-06'))).status, 200);
  assert.equal((await put(renamed, series, false)).status, 200);
  assert.equal((await shown(series)).archived, false);
});

test("files: an instance's own download as attachments, as rf pull fetches them; paths out of it are refused", async () => {
  const id = await iid(series, '2026-08-30'), file = (rel: string) => `/files/${id}/${encodeURIComponent(rel)}`;
  const name = 'Larkfield AR aging 083026.csv';
  const r = await call('GET', file(`upload/${name}`));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition')!, /^attachment/);
  assert.ok((Buffer.from(await r.arrayBuffer())).equals(readFileSync(join(root, 'instances', id, 'upload', name))));
  assert.equal((await call('GET', file('log.jsonl'))).status, 200);
  for (const rel of ['upload/../../screen.json', '../x/log.jsonl', './log.jsonl'])
    assert.equal((await call('GET', file(rel))).status, 400, rel);
});

test("a run's links, FIFOs and folders in working/ and session/ are never followed or read", async () => {
  const id = await iid(series, '2026-08-30'), d = join(root, 'instances', id), file = (rel: string) => `/files/${id}/${encodeURIComponent(rel)}`;
  writeFileSync(join(d, 'working', 'real.txt'), 'mine');
  symlinkSync('/proc/self/environ', join(d, 'working', 'env.txt'));
  symlinkSync('real.txt', join(d, 'working', 'inside.txt'));
  symlinkSync('../..', join(d, 'working', 'up'));
  symlinkSync('../..', join(d, 'working', 'up2'));
  execFileSync('mkfifo', [join(d, 'working', 'pipe.txt'), join(d, 'session', 'zz.jsonl')]);
  const latin1 = Buffer.concat([Buffer.from(join(d, 'working', 'r')), Buffer.from([0xe9]), Buffer.from('sum\u00e9.txt')]);
  writeFileSync(latin1, 'not UTF-8');
  for (const rel of ['working/env.txt', 'working/inside.txt', 'working/pipe.txt', `working/up/instances/${id}/working/real.txt`])
    assert.equal((await call('GET', file(rel))).status, 404, rel);
  assert.equal(await (await call('GET', file('working/real.txt'))).text(), 'mine');
  const listed = (await json(`/api/files?path=${encodeURIComponent(`larkfield/${series}/2026-08-30/working`)}`)).map((f: { path: string }) => f.path);
  assert.deepEqual(listed.filter((p: string) => /\/working\/(env|inside|pipe|up|real)/.test(p)), [`larkfield/${series}/2026-08-30/working/real.txt`], 'only regular files, and never into a link');
  assert.equal((await call('GET', await at(series, '2026-08-30', 'trace'))).status, 200, 'a FIFO among the session files is skipped');
  writeFileSync(join(d, 'session', 'zy.jsonl'), '{"type":"message","message":{"role":"user","content":"cut"}}\n{"type":"message","mess\n');
  assert.equal((await json(await at(series, '2026-08-30', 'trace'))).filter((l: { text: string }) => l.text === 'cut').length, 1, 'a line a restart cut half written is skipped');
  assert.equal((await call('POST', `${await at(series, '2026-08-30', 'duplicate')}?as=links`)).status, 200);
  assert.deepEqual(readdirSync(join(await dir(series, 'links'), 'working')).filter(f => /env|inside|pipe|up|real/.test(f)), ['real.txt'], 'a copy leaves them out');
  for (const f of ['real.txt', 'env.txt', 'inside.txt', 'up', 'up2', 'pipe.txt']) rmSync(join(d, 'working', f));
  rmSync(latin1);
  rmSync(join(d, 'session', 'zz.jsonl'));
  rmSync(join(d, 'session', 'zy.jsonl'));
  assert.equal((await call('POST', `${await at(series, 'links', 'abandon')}`)).status, 200);
});

test('a cross-site POST is refused, so another web page cannot talk to the agent', async () => {
  const r = await fetch(base + await at(series, '2026-09-06', 'comment'), { method: 'POST', body: '{"text":"x"}', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('without a session the site shows Continue with Microsoft, which goes to Microsoft', async () => {
  assert.equal((await fetch(base + '/api')).status, 401);
  assert.match(await (await fetch(base + '/')).text(), /href="\/auth\/login[^"]*">[\s\S]*Continue with Microsoft/);
  assert.equal((await fetch(base + '/agent/delivered', { method: 'POST' })).status, 401, "the agent API is only on the sandboxes' socket");
  assert.match((await fetch(base + '/auth/login', { redirect: 'manual' })).headers.get('location')!, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
  assert.equal((await fetch(base + '/api', { headers: { cookie: admin.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) } })).status, 401, 'a tampered cookie is refused');
  const me = await json('/me');
  assert.deepEqual([me.email, me.role], [adminEmail, 'admin']);
  assert.match(me.version, /^(v\d+\.\d+\.\d+|[0-9a-f]{7,}$)/, 'the release the checkout is at, as git describes it, or its commit where it has no tags, as CI\'s; the page shows it at the sidebar\'s foot');
  for (const next of ['/#/abc', '//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com'])
    assert.equal((await entra.signIn(base, adminEmail, `/auth/login?next=${encodeURIComponent(next)}`)).headers.get('location'), next === '/#/abc' ? next : '/', `a sign-in goes on only to this site: ${JSON.stringify(next)}`);
  assert.match((await fetch(base + '/auth/login', { redirect: 'manual', headers: { cookie: admin } })).headers.get('location')!, /\/authorize\?.*scope=openid\+profile\+email\+offline_access&/, 'signed in already, it signs in again, as Sign in again asks, keeping the sign-in');
  await login(adminEmail);
});

test('a websocket upgrade with a non-ASCII session signature is refused without stopping the server', async () => {
  const url = new URL(base), email = Buffer.from(adminEmail).toString('base64url');
  const socket = connect(Number(url.port), url.hostname);
  await once(socket, 'connect');
  socket.write(Buffer.from(`GET /signins/x/view/watch HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${url.origin}\r\nCookie: rf_session=${email}.9999999999999.${'a'.repeat(42)}é\r\n\r\n`, 'latin1'));
  const answer = Buffer.concat(await Array.fromAsync(socket)).toString();
  assert.match(answer, /^HTTP\/1\.1 404 Not Found/);
  assert.equal((await call('GET', '/me')).status, 200);
});

test('an id that every object has a property by, such as __proto__, names nothing, for admins too', async () => {
  for (const [method, path, body] of [['PUT', '/api/workspaces/__proto__', { name: 'Polluted' }], ['POST', '/api/series', { workspace: '__proto__', name: 'Polluted' }], ['POST', '/api/requests/__proto__', {}], ['PUT', '/api/workspaces/constructor', { name: 'Polluted' }]] as const)
    assert.equal((await call(method, path, JSON.stringify(body))).status, 404, `${method} ${path}`);
});

test("each person sees the workspaces they're in, by email or Entra group; owners and admins manage who is in", async () => {
  const b = sessionOf(await login(bob))!;
  const people = async (ws: string, body: object, cookie = admin) => call('PUT', `/api/workspaces/${(await named(ws)).id}`, JSON.stringify(body), cookie);
  const make = (name: string, cookie = admin) => call('POST', '/api/workspaces', JSON.stringify({ name }), cookie);
  assert.equal((await json('/me', b)).role, 'user');
  assert.deepEqual(await workspaces(b), []);
  const grant = (cap: string, people: unknown, cookie = admin) => call('PUT', '/capabilities', JSON.stringify({ cap, people }), cookie);
  assert.deepEqual([(await json('/me', b)).can, (await json('/me')).can], [[], ['publish', 'create', 'keepalive']], 'admins have every capability');
  const refused = await make('BobCo', b);
  assert.deepEqual([refused.status, await refused.text()], [403, 'making a workspace is for admins and those they grant create: ask an admin']);
  assert.equal((await grant('create', [bob], b)).status, 403, 'admins grant capabilities');
  assert.equal((await grant('create', ['Treasury'])).status, 400);
  assert.equal((await grant('delete', [bob])).status, 400);
  assert.deepEqual(await (await grant('create', ['Bob@demo.test'])).json(), { publish: [], create: [bob], keepalive: [] });
  assert.equal((await make('BobCo', b)).status, 200, 'and those granted create');
  assert.deepEqual((await workspaces(b)).map((w: { name: string; owners: string[] }) => [w.name, w.owners]), [['BobCo', [bob]]]);
  for (const path of [await at(series, '2026-08-30'), `/files/${await iid(series, '2026-08-30')}/upload/x`])
    assert.equal((await call('GET', path, undefined, b)).status, 404, path);
  assert.equal((await create(series, '2026-12-31', b)).status, 404);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ name: 'x' }), b)).status, 404);
  assert.equal((await call('POST', '/api/series', JSON.stringify({ workspace: (await named('larkfield')).id, name: 'x' }), b)).status, 404);
  assert.equal((await make('larkfield', b)).status, 409, 'a name in use elsewhere is taken');
  assert.equal((await call('GET', '/users', undefined, b)).status, 403);
  assert.ok(await named('BobCo'), 'an admin sees every workspace');

  assert.equal((await people('larkfield', { owners: [adminEmail], members: ['Bob@demo.test'] })).status, 200);
  assert.deepEqual((await workspaces(b)).map((w: { name: string; manage: boolean }) => [w.name, w.manage]), [['BobCo', true], ['larkfield', false]]);
  assert.equal((await call('GET', await at(series, '2026-08-30'), undefined, b)).status, 200);
  assert.equal((await people('larkfield', { members: [] }, b)).status, 403, 'a member does not manage who is in');
  assert.equal((await people('larkfield', { members: ['not an email'] })).status, 400);

  const group = '0b8e5c8a-6d3e-4c21-9f2a-1d2e3f4a5b6c';
  entra.who.groups[bob] = [group];
  await login(bob);
  await grant('create', [group.toUpperCase()]);
  assert.deepEqual((await json('/me', b)).can, ['create'], 'by an Entra group too');
  await grant('create', []);
  assert.equal((await make('Acme Payroll')).status, 200);
  assert.equal((await call('POST', '/api/series', JSON.stringify({ workspace: (await named('Acme Payroll')).id, name: 'Payroll' }))).status, 200);
  assert.ok(!(await workspaces(b)).some((w: { name: string }) => w.name === 'Acme Payroll'));
  assert.equal((await people('Acme Payroll', { members: [group] })).status, 200);
  assert.ok((await workspaces(b)).some((w: { name: string }) => w.name === 'Acme Payroll'), 'through the Entra group');
  delete entra.who.groups[bob];

  // What a workspace's agents read beyond it is what other workspaces' owners let them, whoever is in either.
  const links = async (ws: string) => { const w = await named(ws); return [w.reads, w.readers].map(l => l.map((r: { name: string }) => r.name)); };
  const link = (source: string, reader: string, method: string, cookie = admin) => call(method, `/api/workspaces/${source}/readers/${reader}`, undefined, cookie);
  assert.equal((await people('Acme Payroll', { members: [] })).status, 200);
  const [lark, payroll, bobco] = await Promise.all(['larkfield', 'Acme Payroll', 'BobCo'].map(async n => (await named(n)).id));
  assert.deepEqual(await links('Acme Payroll'), [[], []], 'everyone in Payroll is in larkfield, yet its agents read only Payroll');
  assert.equal((await link(lark, payroll, 'PUT')).status, 200);
  assert.deepEqual([await links('Acme Payroll'), await links('larkfield')], [[['larkfield'], []], [[], ['Acme Payroll']]], 'larkfield lets Payroll read it, never the reverse');
  assert.equal((await link(lark, bobco, 'PUT', b)).status, 403, 'a member lets no one in');
  assert.equal((await link(bobco, payroll, 'PUT', b)).status, 404, 'an owner lets in only a workspace they see');
  assert.equal((await link(bobco, bobco, 'PUT', b)).status, 400);
  assert.equal((await link(lark, bobco, 'PUT')).status, 200);
  assert.equal((await link(lark, bobco, 'DELETE', b)).status, 200, "the reader's owners take its link off too");
  assert.equal((await link(lark, payroll, 'DELETE', b)).status, 404, 'and no one else');
  assert.deepEqual(await links('larkfield'), [[], ['Acme Payroll']]);
  assert.equal((await people('Acme Payroll', { members: ['dana@demo.test'] })).status, 200);
  assert.deepEqual(await links('Acme Payroll'), [['larkfield'], []], 'whoever joins either changes nothing of it');

  assert.equal((await people('larkfield', { owners: [], members: [] })).status, 200);
  assert.equal((await call('GET', await at(series, '2026-08-30'), undefined, b)).status, 404);
  assert.deepEqual(await links('Acme Payroll'), [['larkfield'], []]);
});

test('each sign-in replaces the groups, and a token without groups removes their workspaces and capabilities', async () => {
  const email = 'groups@demo.test', group = 'a3ec3016-372f-4fbb-804d-3267627d819f';
  const { id } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Group access' }))).json();
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ members: [group] }))).status, 200);
  assert.equal((await call('PUT', '/capabilities', JSON.stringify({ cap: 'create', people: [group] }))).status, 200);
  entra.who.groups[email] = [group];
  const cookie = sessionOf(await login(email))!;
  assert.deepEqual([(await json('/me', cookie)).groups, (await json('/me', cookie)).can], [[group], ['create']]);
  assert.deepEqual((await workspaces(cookie)).map((w: { id: string }) => w.id), [id]);
  delete entra.who.groups[email];
  assert.ok(sessionOf(await login(email)));
  assert.deepEqual([(await json('/me', cookie)).groups, (await json('/me', cookie)).can], [[], []]);
  assert.deepEqual(await workspaces(cookie), []);
  await call('PUT', '/capabilities', JSON.stringify({ cap: 'create', people: [] }));
});

test("each run renews its runner's groups from Microsoft, including a renewal with no groups, without another browser sign-in", async () => {
  const email = 'runner-groups@demo.test', first = '8d7e332d-b4c7-4ff5-aac3-10a87909a40b', second = '0e3dcbbb-bb2e-4fb3-b21d-a87f9b5aa624';
  entra.who.groups[email] = [first];
  const cookie = sessionOf(await login(email))!;
  const { token } = await (await call('POST', '/tokens', JSON.stringify({ name: 'runs', days: 90 }), cookie)).json();
  const { id: workspace } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Runner groups' }))).json();
  assert.equal((await call('PUT', `/api/workspaces/${workspace}`, JSON.stringify({ members: [email] }))).status, 200);
  const { id: series } = await (await call('POST', '/api/series', JSON.stringify({ workspace, name: 'Renew groups' }))).json();
  entra.who.groups[email] = [second];
  const made = await fetch(`${base}/api/series/${series}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ label: 'one' }) });
  assert.equal(made.status, 200);
  const { id } = await made.json(), path = `/api/instances/${id}`;
  await ran(path);
  assert.deepEqual((await json('/me', cookie)).groups, [second]);
  delete entra.who.groups[email];
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'Run again' }), cookie)).status, 200);
  await ran(path, 2);
  assert.deepEqual((await json('/me', cookie)).groups, []);
});

test("the page names everyone who has signed in, and the Entra groups in the workspaces you see by the labels their owners give", async () => {
  const b = sessionOf(await login(bob))!, dana = 'dana@demo.test', group = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', other = '7a2e3d4c-5b6f-4a71-9b8c-0d1e2f3a4b5c';
  const users = join(root, '.rf', 'users.json'), names = async (cookie = admin) => (await json('/me', cookie)).names;
  const people = async (ws: string, body: object, cookie = admin) => call('PUT', `/api/workspaces/${(await named(ws)).id}`, JSON.stringify(body), cookie);
  writeFileSync(users, JSON.stringify({ ...JSON.parse(readFileSync(users, 'utf8')), [dana]: { name: 'Dana Tan', role: 'user' } }));
  assert.equal((await names(b))[dana], 'Dana Tan', "bob sees the name of someone he shares no workspace with");
  assert.equal((await people('BobCo', { members: [dana, group], groups: { [group]: ' Finance HK' } }, b)).status, 200);
  assert.deepEqual(await names(b), { [group]: 'Finance HK', [adminEmail]: 'Demo Admin', [bob]: 'Bob', [dana]: 'Dana Tan' });
  for (const groups of [{ [dana]: 'Dana' }, { [other]: 'Payroll' }, { [group]: ' ' }, { [group]: 'dana@x.test' }])
    assert.equal((await people('BobCo', { groups }, b)).status, 400, `${JSON.stringify(groups)}: only a group in the workspace, with some text and no @, which would pass for a person's email`);
  assert.equal((await people('Acme Payroll', { members: [other], groups: { [other]: 'Payroll team' } })).status, 200);
  assert.equal((await names())[other], 'Payroll team');
  assert.ok(!(other in await names(b)), "a group in a workspace bob doesn't see goes unnamed for him");
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.rf', 'tree.json'), 'utf8')).groups, { [group]: 'Finance HK', [other]: 'Payroll team' });
});

test("everyone sees the skills, which every run loads; admins keep the connections, and each person their own websites, admins seeing anyone's and only letting one reach internal addresses", async () => {
  const b = sessionOf(await login(bob))!;
  const report = (list: { id: string }[]) => list.find(s => s.id === 'mail-report') as Record<string, unknown>;
  assert.deepEqual(Object.keys(report(await json('/skills', b))).sort(), ['description', 'id', 'name', 'pushed'], 'anyone signed in sees the skills');
  assert.equal((await call('PUT', '/connections/portal', JSON.stringify({ type: 'website', url: 'https://portal.test/#/login' }))).status, 400, 'a website is no connection');
  assert.equal((await call('POST', '/logins/sites', JSON.stringify({ name: 'portal', url: 'http://portal.test/' }), b)).status, 400, 'https only');
  assert.deepEqual(await (await call('POST', '/logins/sites', JSON.stringify({ name: 'portal', url: 'https://portal.test/#/login', header: 'x-bot-token' }), b)).json(), { site: 'portal' }, 'anyone adds one');
  assert.equal((await call('POST', '/logins/sites', JSON.stringify({ name: 'portal', url: 'https://portal.test/other' }), b)).status, 409, 'by a name of theirs once');
  assert.deepEqual(await (await call('POST', '/logins/sites', JSON.stringify({ name: 'portal', url: 'https://portal.test/other' }))).json(), { site: 'portal' }, "another's may have that name too");
  assert.equal((await call('PATCH', '/logins/sites/portal', JSON.stringify({ every: '5m' }), b)).status, 200, "its settings are its person's");
  assert.equal((await call('PATCH', '/logins/sites/portal', JSON.stringify({ internal: true }), b)).status, 403, "letting it reach internal addresses is admins'");
  assert.equal((await call('PATCH', '/logins/sites/portal', JSON.stringify({ hosts: 'evil.test' }), b)).status, 400, 'its hosts are allowed one by one');
  assert.equal((await call('PATCH', `/logins/sites/portal?person=${bob}`, JSON.stringify({ every: '1h' }))).status, 403, "admins change no one else's settings");
  assert.equal((await call('PATCH', `/logins/sites/portal?person=${bob}`, JSON.stringify({ internal: true }))).status, 200, 'but let it reach internal addresses');
  const { added, ...site } = (await json('/logins/sites', b)).portal;
  assert.deepEqual(site, { url: 'https://portal.test/#/login', hosts: [], writeback: true, header: 'x-bot-token', every: 5 });
  assert.equal((await call('GET', `/logins/sites?person=${adminEmail}`, undefined, b)).status, 403, 'a person sees their own');
  assert.deepEqual(Object.keys(await json(`/logins/sites?person=${bob}`)), ['portal'], "admins see anyone's");
  assert.equal((await call('DELETE', '/logins/sites/portal')).status, 200, 'admins remove their own');
  assert.deepEqual([Object.keys(await json('/logins/sites')), Object.keys(await json('/logins/sites', b))], [[], ['portal']], "and no one else's");
  assert.equal((await call('DELETE', '/logins/sites/portal', undefined, b)).status, 200);
  assert.deepEqual((await json('/connections', b)).map((c: { name: string }) => c.name), ['graph']);
});

test("people see, set, move and cancel wakes, one-off or weekly, share a series as themselves, and start or dismiss requests; a wake stays pending whatever runs before it", async () => {
  const s = await shown(series), wakes = join(root, '.rf', 'wakes.json'), sep = await iid(series, '2026-08-30 rework');
  const due = new Date(Date.now() + 86_400_000).toISOString();
  writeFileSync(wakes, JSON.stringify({
    pending: { k1: { target: s.id, at: due, from: 'larkfield/x/y', label: '2026-09-20' }, k2: { target: sep, at: due, from: 'larkfield/x/y' } },
    fired: {}, requests: { r1: { series: s.id, label: '2026-09-27', from: 'larkfield/Bank rec/2026-09', at: due } },
  }));
  const listed = await shown(series);
  assert.deepEqual([listed.wakes.map((k: { id: string; label: string }) => [k.id, k.label]), listed.requests.map((r: { id: string }) => r.id), listed.shared_by], [[['k1', '2026-09-20']], ['r1'], null]);
  assert.deepEqual(listed.instances.find((i: { id: string }) => i.id === sep).wakes.map((k: { at: string }) => k.at), [due]);
  assert.equal(listed.requests[0].who, listed.instances.at(-1).runner, "a request waits on the runner of the series' newest instance");
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString(), set = (target: string, body: object) => call('PUT', `/api/wakes/${target}`, JSON.stringify(body));
  assert.deepEqual(await (await set(s.id, { at: later, label: '2026-09-20' })).json(), { id: 'k1', target: s.id, at: later, from: adminEmail, label: '2026-09-20' }, 'the same label moves it');
  assert.equal((await set(s.id, { at: '2030-01-07T08:00', label: '2030-01-05', days: 'mon-fri' })).status, 400, "a weekly wake's label holds the day it fires or the one before that it fires on");
  assert.equal((await set(s.id, { at: '2030-01-07T08:00', label: '2030-01-04', days: 'sat' })).status, 400, 'it fires on one of its days');
  const weekly = await (await set(s.id, { at: '2030-01-07T08:00', label: '2030-01-04', days: 'mon-fri' })).json();
  assert.deepEqual([weekly.label, weekly.days], ['2030-01-04', ['mon', 'tue', 'wed', 'thu', 'fri']], "Monday's is Friday's");
  assert.equal((await (await set(s.id, { at: later, label: '2030-01-04' })).json()).id, weekly.id, 'a one-off for a label a weekly one starts is that one');
  assert.equal((await shown(series)).wakes.length, 2);
  const ws = `/api/workspaces/${(await named('larkfield')).id}`, b = sessionOf(await login(bob))!;
  assert.equal((await call('PUT', ws, JSON.stringify({ owners: [adminEmail], members: [bob] }))).status, 200);
  assert.equal((await call('POST', `${await at(series, '2026-08-30 rework', 'comment')}`, JSON.stringify({ text: 'fyi' }), b)).status, 200);
  assert.equal(JSON.parse(readFileSync(wakes, 'utf8')).pending.k2?.at, due, "bob's note for the runner starts nothing, so the wake stays");
  const asks = async () => (await shown(series)).instances.find((i: { id: string }) => i.id === sep).asks;
  assert.deepEqual(await asks(), [adminEmail], "bob's note waits on the runner");
  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: true }))).status, 200);
  assert.deepEqual(await asks(), [adminEmail], 'where the runner shares the series it is still a note for them');
  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: false }))).status, 200);
  assert.equal((await call('POST', `${await at(series, '2026-08-30 rework', 'comment')}`, JSON.stringify({ text: 'go' }))).status, 200);
  assert.equal(JSON.parse(readFileSync(wakes, 'utf8')).pending.k2?.at, due, "the runner's act starts a run now, and the wake still comes when it's due");

  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: true }))).status, 200);
  assert.equal((await shown(series)).shared_by, adminEmail);
  assert.deepEqual((await json('/api/status')).requests.map((r: { who: string; label: string }) => [r.who, r.label]), [[adminEmail, '2026-09-27']], 'or on whoever shares it');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'series', s.id, 'series.json'), 'utf8'))), ['shared']);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ name: s.name }))).status, 200);
  assert.equal((await shown(series)).shared_by, adminEmail, 'other settings leave sharing as it was');
  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: false }), b)).status, 403, "a member doesn't stop another's sharing");
  assert.equal((await shown(series)).shared_by, adminEmail);
  assert.equal((await call('PUT', ws, JSON.stringify({ owners: [], members: [] }))).status, 200);

  const started = await call('POST', '/api/requests/r1');
  assert.equal(started.status, 200);
  const made = await json(`/api/instances/${(await started.json()).id}`);
  assert.deepEqual([made.log[0].by, made.log[1].op, made.log[1].from], [adminEmail, 'wake', 'larkfield/Bank rec/2026-09']);
  assert.equal((await call('POST', await at(series), JSON.stringify({ label: 'third' }))).status, 200);
  assert.equal((await call('POST', await at(series), JSON.stringify({ label: 'fourth' }))).status, 409, '3 open already');
  assert.equal((await call('DELETE', '/api/wakes/k1')).status, 200);
  assert.equal((await call('DELETE', '/api/wakes/k1')).status, 404);
  assert.deepEqual((await shown(series)).wakes.map((k: { id: string }) => k.id), [weekly.id]);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: false }))).status, 200);
  const third = await iid(series, 'third');
  await set(third, { at: later });
  for (const label of ['2026-09-27', 'third']) assert.equal((await call('POST', `${await at(series, label, 'abandon')}`)).status, 200);
  assert.deepEqual(Object.values(JSON.parse(readFileSync(wakes, 'utf8')).pending).filter((k: { target: string }) => k.target === third), [], "abandoning an instance cancels its wakes");
  await set(sep, { at: later });
  assert.equal((await call('PUT', await at(series), JSON.stringify({ archived: true }))).status, 200);
  assert.deepEqual(Object.values(JSON.parse(readFileSync(wakes, 'utf8')).pending), [], "archiving a series cancels its wakes and its instances'");
  assert.equal((await set(sep, { at: later })).status, 409, 'and none is set while it is archived');
  assert.equal((await call('PUT', await at(series), JSON.stringify({ archived: false }))).status, 200);
});

test("AGENTS.md: the company's is the admins', a workspace's its owners', and both are files every agent in scope reads", async () => {
  const b = sessionOf(await login(bob))!;
  assert.equal((await call('PUT', '/agents', 'Fiscal months end on the last Saturday.', b)).status, 403);
  assert.equal((await call('PUT', '/agents', 'Fiscal months end on the last Saturday.')).status, 200);
  assert.deepEqual(await json('/agents', b), { text: 'Fiscal months end on the last Saturday.' });
  const ws = await named('larkfield');
  assert.equal((await call('PUT', `/api/workspaces/${ws.id}`, JSON.stringify({ agents: 'Larkfield Ltd is now Larkfield Holdings.' }))).status, 200);
  assert.equal((await named('larkfield')).agents, 'Larkfield Ltd is now Larkfield Holdings.');
  assert.equal(readFileSync(join(root, 'agents', `${ws.id}.md`), 'utf8'), 'Larkfield Ltd is now Larkfield Holdings.');
});

test('a task is a series of one instance, Untitled until its first prompt or a rename names it; made a series, it keeps its id, files and log', async () => {
  const { id } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Solo' }))).json();
  const task = async () => (await (await call('POST', '/api/series', JSON.stringify({ workspace: id, single: true }))).json());
  const solo = async () => (await named('Solo')).series.map((s: { id: string; name: string; single: boolean; instances: { label: string }[] }) => [s.id, s.name, s.single, s.instances.map(i => i.label)]);
  const one = await task(), two = await task();
  assert.deepEqual(await solo(), [[one.id, 'Untitled', true, ['Untitled']], [two.id, 'Untitled 2', true, ['Untitled 2']]]);
  assert.equal((await call('POST', `/api/series/${one.id}`, JSON.stringify({ label: 'more' }))).status, 400, 'one instance');
  assert.equal((await call('PUT', `/api/series/${one.id}`, JSON.stringify({ name: 'Mine' }))).status, 400, 'no settings');
  await call('POST', `/api/instances/${one.instance}/comment`, JSON.stringify({ text: 'Forecast cash for the next 13 weeks from the bank exports' }));
  await call('POST', `/api/instances/${one.instance}/comment`, JSON.stringify({ text: 'And by currency' }));
  assert.deepEqual((await solo())[0], [one.id, 'Forecast cash for the next 13', true, ['Forecast cash for the next 13']], 'its first prompt names it, the next one nothing');
  await new Promise(r => setTimeout(r, 2500));
  assert.equal((await call('POST', `/api/instances/${one.instance}/rename?as=${encodeURIComponent('Untitled 2')}`)).status, 409, 'a task is named as a series is');
  assert.equal((await call('POST', `/api/instances/${one.instance}/rename?as=${encodeURIComponent('Cash forecast')}`)).status, 200);
  assert.equal((await call('POST', `/api/instances/${one.instance}/close`)).status, 200);
  assert.equal((await call('POST', `/api/series/${one.id}/promote`, JSON.stringify({ name: 'Cash forecasts' }))).status, 200);
  assert.deepEqual((await solo())[0], [one.id, 'Cash forecasts', false, ['Cash forecast']]);
  assert.equal((await json(`/api/instances/${one.instance}`)).log.at(-1).op, 'promote');
  const next = (await (await call('POST', `/api/series/${one.id}`, JSON.stringify({ label: 'week 2' }))).json()).id;
  assert.deepEqual((await ran(`/api/instances/${next}`)).map(e => e.op).slice(0, 3), ['create', 'wake', 'run'], 'the next instance is a plain one, which runs at once');
  assert.equal((await call('POST', `/api/series/${one.id}/promote`, JSON.stringify({ name: 'Again' }))).status, 400);
});

test('an admin can disable someone, which ends their sessions and stops their sign-in, and sign them out everywhere', async () => {
  const b = sessionOf(await login(bob))!;
  assert.deepEqual((await json('/users')).find((u: { email: string }) => u.email === bob).workspaces, ['BobCo']);
  assert.equal((await call('PUT', `/users/${encodeURIComponent(adminEmail)}`, JSON.stringify({ disabled: true }))).status, 409, 'an admin cannot lock themselves out');
  assert.equal((await call('PUT', `/users/${encodeURIComponent(bob)}`, JSON.stringify({ disabled: true }))).status, 200);
  assert.equal((await call('GET', '/api', undefined, b)).status, 401);
  assert.equal((await login(bob)).status, 403);
  assert.equal((await call('PUT', `/users/${encodeURIComponent(bob)}`, JSON.stringify({ disabled: false }))).status, 200);
  const again = sessionOf(await login(bob))!;
  assert.equal((await call('GET', '/api', undefined, again)).status, 200);
  assert.equal((await call('PUT', `/users/${encodeURIComponent(bob)}`, JSON.stringify({ signout: true }))).status, 200);
  assert.equal((await call('GET', '/api', undefined, again)).status, 401);
});

test('talking is in threads: a comment starts one on an item or the instance, and a reply goes under one of its comments, by its seq; resolving is gone', async () => {
  assert.equal((await call('POST', `${await at(series, '2026-08-30', 'duplicate')}?as=talk`)).status, 200);
  const path = await at(series, 'talk');
  const inst = await json(path), item = inst.doc.items[0].id;
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ item, ref: 'B4', text: 'Why is this up?' }))).status, 200);
  const started = (await json(path)).log.at(-1);
  assert.deepEqual([started.op, started.item, started.ref, started.text], ['comment', item, 'B4', 'Why is this up?']);
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: started.thread, text: 'And B5?' }))).status, 200);
  const reply = (await json(path)).log.at(-1);
  assert.deepEqual([reply.thread, reply.parent, reply.item], [started.thread, started.seq, undefined], 'a reply keeps its thread and names its parent, not an item');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: `c${reply.seq}`, text: 'B6 too.' }))).status, 200);
  assert.deepEqual([(await json(path)).log.at(-1).thread, (await json(path)).log.at(-1).parent], [started.thread, reply.seq], 'a reply under a reply is in the same thread');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: 'nope', text: 'x' }))).status, 400);
  const { file } = await (await call('POST', `${path}/attach?name=list.csv`, 'a,b')).json();
  assert.equal(file, 'upload/attachments/list.csv');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: started.thread, text: 'The list', files: [file] }))).status, 200);
  assert.deepEqual((await json(path)).log.at(-1).files, [file], 'a comment names its attachments');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'x', files: ['upload/../x'] }))).status, 400);
  assert.equal((await call('POST', `${path}/resolve`, JSON.stringify({ thread: started.thread }))).status, 404);
});

test("a quiet act starts no run, which the next run reads: an instance made quietly waits for its first act, and an upload or comment that starts no run is committed at once, in its person's name", async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Hush' }))).json();
  const { id: sid } = await (await call('POST', '/api/series', JSON.stringify({ workspace: ws, name: 'Oracle' }))).json();
  const { id } = await (await call('POST', `/api/series/${sid}`, JSON.stringify({ label: 'kb', quiet: true }))).json(), path = `/api/instances/${id}`;
  assert.equal((await call('POST', `${path}/upload?name=memo.txt&quiet`, 'Rates reset in March.')).status, 200);
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'For the record.', quiet: true }))).status, 200);
  await new Promise(r => setTimeout(r, 2500));
  const { log } = await json(path), said = log.at(-1);
  assert.deepEqual(log.map((e: { op: string; quiet?: true }) => [e.op, e.quiet]), [['create', undefined], ['upload', true], ['point', undefined], ['comment', true]], 'no wake, and no run');
  const git = (...a: string[]) => execFileSync('git', ['-C', join(root, 'instances', id), ...a], { encoding: 'utf8' }).trim();
  assert.deepEqual(git('log', '--format=%ae %s').split('\n'), [`${adminEmail} Comment in ${said.thread}`, `${adminEmail} Upload upload/memo.txt`]);
  assert.match(git('show', 'HEAD:log.jsonl'), /"For the record\."/);
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'Index what came in.' }))).status, 200);
  const after = await ran(path);
  assert.equal(after.find(e => e.op === 'run')!.upto, after.findLast(e => e.op === 'comment')!.seq, 'the next act starts a run, which reads all before it');
});

test('skills are pushed by admins and those granted publish, each push a version live at once, and rolled back by pushing an earlier one', async () => {
  const b = sessionOf(await login(bob))!, push = (files: object, cookie = admin) => call('POST', '/skills/tool/versions', JSON.stringify(files), cookie);
  assert.equal((await push({ files: filesOf(join(standIns, 'tool')) }, b)).status, 403, 'a user may not push');
  const grant = (people: string[]) => call('PUT', '/capabilities', JSON.stringify({ cap: 'publish', people }));
  await grant([bob]);
  const changed = { ...filesOf(join(standIns, 'tool')), 'SKILL.md': Buffer.from('---\nname: tool\ndescription: the second\n---\n').toString('base64') };
  assert.equal(await (await push({ files: changed }, b)).text(), 'pushed tool version 2, live now');
  const live = async () => (await json('/skills')).find((x: { id: string }) => x.id === 'tool');
  assert.deepEqual([(await live()).description, (await live()).pushed.version, (await live()).pushed.by], ['the second', 2, bob]);
  assert.equal(await (await push({ from: 1 })).text(), 'pushed tool version 3, live now');
  assert.notEqual((await live()).description, 'the second', 'version 3 is version 1 again');
  assert.deepEqual((await json('/skills/tool/versions')).map((v: { version: number }) => v.version), [1, 2, 3]);
  assert.equal((await push({ files: { '../x': 'eA==', 'SKILL.md': 'eA==' } })).status, 400);
  await grant([]);
  assert.match(await (await push({ from: 1 }, b)).text(), /pushing skills is for admins and those they grant publish/);
  assert.deepEqual(await json('/skills/tool/versions/2', b), changed, 'anyone signed in reads a version');
  assert.equal((await call('GET', '/skills/tool/versions/9', undefined, b)).status, 404);
});

test("personal tokens act as their person for rf, every use logged, until revoked", async () => {
  const b = sessionOf(await login(bob))!;
  assert.equal((await call('POST', '/tokens', JSON.stringify({ name: 'laptop', days: 0 }), b)).status, 400);
  const { token } = await (await call('POST', '/tokens', JSON.stringify({ name: 'laptop', days: 30 }), b)).json();
  const as = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await (await as('/me')).json()).email, bob);
  assert.equal((await as('/users')).status, 403, 'a token is its person, no more');
  assert.match(readFileSync(join(root, '.rf', 'token-uses.jsonl'), 'utf8'), /"path":"\/me"/);
  assert.ok(!readFileSync(join(root, '.rf', 'tokens.json'), 'utf8').includes(token), 'only its hash is kept');
  const [t] = await json('/tokens', b);
  assert.equal((await call('DELETE', `/tokens/${t.id}`, undefined, b)).status, 200);
  assert.equal((await as('/me')).status, 401);
});

// rf as a person runs it, signed in once in its own home: what it printed, or a failure with its exit code.
const home = join(tmp, 'cli-home');
const rf = (...args: string[]) => new Promise<string>((ok, fail) => {
  const p = spawn(process.execPath, [join(app, 'src', 'rf-people.ts'), ...args], { env: { ...process.env, HOME: home } });
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  p.on('exit', code => (code ? fail(Object.assign(new Error(out), { code })) : ok(out)));
});
const fails = (code: number, out: RegExp) => (e: { code: number; message: string }) => e.code === code && out.test(e.message);

test('rf for people: ls, comment, pull as rsync does, runs, costs and status, and admins manage people and the brand from it', async () => {
  const { token } = await (await call('POST', '/tokens', JSON.stringify({ name: 'cli', days: 1 }))).json();
  mkdirSync(home);
  assert.equal((await rf('login', base, token)).trim(), `signed in as ${adminEmail}`);
  const asToken = (method: string, path: string, body?: string) => fetch(base + path, { method, body, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await asToken('POST', '/tokens', JSON.stringify({ name: 'more', days: 90 }))).status, 403, 'a token makes no tokens');
  assert.equal((await asToken('DELETE', '/tokens/x')).status, 403);
  assert.equal((await call('POST', '/tokens', JSON.stringify({ name: 'long', days: 365 }))).status, 400, 'at most 90 days');
  assert.match(await rf('ls'), /^larkfield\/Weekly borrowing base\/2026-08-30  closed/m);
  await rf('comment', `larkfield/${series}/talk`, 'From the shell');
  // A run writing meanwhile would change what the second pull finds.
  await quiet();
  const pulled = join(tmp, 'pulled'), week = `larkfield/${series}/2026-08-30`;
  assert.match(await rf('pull', '/', pulled), /^new  larkfield\/AGENTS\.md$/m);
  assert.deepEqual(['', 'larkfield'].map(d => readFileSync(join(pulled, d, 'AGENTS.md'), 'utf8')), ['Fiscal months end on the last Saturday.', 'Larkfield Ltd is now Larkfield Holdings.']);
  assert.ok(['screen.json', 'log.jsonl', 'session/main.jsonl', 'upload/Larkfield AR aging 083026.csv'].every(f => existsSync(join(pulled, week, f))), 'the folders as runs see them');
  assert.match(await rf('pull', '/', pulled), /^fetched 0, \d+ up to date/m, 'a file keeps the time the server gave it, so the next pull compares against it');
  await rf('pull', week, join(tmp, 'one'));
  assert.ok(existsSync(join(tmp, 'one', '2026-08-30', 'log.jsonl')), 'PATH makes DIR/<its name>');
  const two = join(tmp, 'two');
  assert.match(await rf('pull', `${week}/`, two, '-n'), /^would fetch \d+, 0 up to date/m);
  assert.ok(!existsSync(two), 'a dry run changes nothing');
  await rf('pull', `${week}/`, two, '--exclude', 'session');
  assert.ok(existsSync(join(two, 'log.jsonl')) && !existsSync(join(two, 'session')), 'PATH/ fills DIR; --exclude leaves a folder out');
  writeFileSync(join(two, 'mine.txt'), 'local');
  await rf('pull', `${week}/`, two, '--exclude', 'session');
  assert.ok(existsSync(join(two, 'mine.txt')), 'nothing goes without --delete');
  assert.match(await rf('pull', `${week}/`, two, '--exclude', 'session', '--delete'), /^deleted  mine\.txt$/m);
  assert.ok(!existsSync(join(two, 'mine.txt')));
  assert.match(await rf('help'), /What rf pull copies/);
  const tool = join(tmp, 'skill', 'tool');
  assert.match(await rf('skill', 'pull', 'tool', tool), /^pulled tool version 3 into /);
  assert.match(await rf('skill', 'push', tool), /^pushed tool version 4, live now/);
  assert.deepEqual(await json('/skills/tool/versions/4'), await json('/skills/tool/versions/3'), 'pulled as push reads it');
  await assert.rejects(rf('skill', 'pull', 'tool', tool), /isn't empty/);
  await rf('skill', 'pull', 'tool', join(tmp, 'second'), '--version', '2');
  assert.match(readFileSync(join(tmp, 'second', 'SKILL.md'), 'utf8'), /description: the second/);
  await assert.rejects(rf('pull', `${week}/`, join(tmp, 'three'), '--exclude'), /--exclude takes a value/);
  assert.match(await rf('pull', `${week}/`, join(tmp, 'four'), '--max-size', '1'), /^skipped  .+: \d+ bytes, over --max-size$[\s\S]*^fetched \d+, 0 up to date, \d+ over 1, in /m);
  await assert.rejects(rf('pull', `${week}/`, join(tmp, 'four'), '--max-size', '5X'), /--max-size: a size such as 500K, 50M or 2G, not 5X/);
  assert.equal((await json(await at(series, 'talk'))).log.findLast((e: { op: string }) => e.op === 'comment').text, 'From the shell');
  const runs = JSON.parse(await rf('runs', `larkfield/${series}`, '--json'));
  assert.ok(runs.every((r: { path: string }) => r.path.startsWith(`larkfield/${series}/`)));
  assert.deepEqual(runs[0], { path: `larkfield/${series}/2026-08-23`, run: 1, at: '2026-08-23T23:01:00.000Z', outcome: 'done', seconds: 240, cost: 0.21, runner: 'alex', started: { op: 'upload', by: 'alex' }, error: null, failure: null });
  assert.match(await rf('runs', '--failed'), /  run \d+  failed \(other\)  \d+[sm]  \$0\.00  (upload|comment|create|wake) by \S+  /, 'without a model key, the runs the tests start fail');
  const scratch = `larkfield/${series}/scratch`;
  assert.deepEqual(JSON.parse(await rf('runs', scratch, '--json')).map((r: { outcome: string; failure: string }) => [r.outcome, r.failure]), [['cut', null], ['failed', 'credits']]);
  assert.deepEqual(JSON.parse(await rf('costs', scratch, '--by', 'outcome', '--json')), [{ outcome: 'cut', runs: 0, cost: 0.05, per_run: null }, { outcome: 'failed, credits', runs: 1, cost: 0.01, per_run: 0.01 }]);
  assert.match(await rf('costs', scratch, '--by', 'outcome'), /^ +\$0\.05 +0 runs +- a run  cut\n.*\n +\$0\.06 +1 runs  in all$/m, 'a run a restart cut is carried on by the next, so it counts no run');
  const stamp = '[\\d-]+ [\\d:]+';
  const woken = (await rf('wake', `larkfield/${series}`, '+1d', '--label', 'next')).match(/^wake (\w+) /)![1];
  assert.match(await rf('wakes', `larkfield/${series}`), new RegExp(`^larkfield/${series}  last woken (never|${stamp})\n  wake ${woken} ${stamp} starts next, set by ${adminEmail}\n`));
  assert.equal((await rf('wake', '--cancel', woken)).trim(), 'cancelled');
  assert.match(await rf('wakes', `larkfield/${series}`), /, none pending\n/);
  assert.match(await rf('activity', `larkfield/${series}/2026-08-23`), new RegExp(`^larkfield/${series}/2026-08-23\n  ${stamp}  alex  uploads upload/Larkfield AR aging 082326\\.csv\n  ${stamp}  alex  closes it\n$`));
  assert.match(await rf('costs', '--by', 'person'), /^ +\$\d+\.\d\d +\d+ runs +\$\d+\.\d\d a run  alex$/m);
  assert.deepEqual(Object.keys(JSON.parse(await rf('status', '--json'))), ['running', 'queued', 'asks', 'expired', 'requests', 'proposals', 'failed', 'indexes']);
  assert.equal(await rf('indexes'), 'No indexes.\n');
  assert.match(await rf('status'), /^Last run failed \(\d+\)\n  larkfield\//m);

  await assert.rejects(rf('user', 'add', 'carol@demo.test', 'publisher'), /a role is one of admin, user/);
  await rf('user', 'add', 'carol@demo.test', 'admin');
  assert.match(await rf('people'), /^admin +carol@demo\.test +# never in; in none$/m);
  const carols = sessionOf(await login('carol@demo.test'))!;
  await rf('user', 'remove', 'carol@demo.test');
  assert.doesNotMatch(await rf('people'), /carol/);
  await rf('user', 'add', 'carol@demo.test');
  assert.equal((await fetch(`${base}/me`, { headers: { cookie: carols } })).status, 401, "a cookie from before she was removed isn't the new carol's");
  await rf('user', 'remove', 'carol@demo.test');

  const logo = join(tmp, 'logo.png'), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(logo, png);
  assert.equal((await rf('brand')).trim(), 'no brand: the plain look');
  await rf('brand', '--text', 'Larkfield Finance', '--logo', logo);
  assert.deepEqual((await json('/me')).brand, { text: 'Larkfield Finance', logo: true });
  const served = await call('GET', '/brand/logo');
  assert.deepEqual([served.headers.get('content-type'), Buffer.from(await served.arrayBuffer())], ['image/png', png]);
  await rf('brand', '--text', 'Larkfield');
  assert.equal((await rf('brand')).trim(), 'Larkfield, with a logo', 'a new text keeps the logo');
  await assert.rejects(rf('brand', '--logo', join(app, 'README.md')), /a logo is a \.png/);
  assert.equal((await call('PUT', '/brand', JSON.stringify({ clear: true }), sessionOf(await login(bob))!)).status, 403, "the brand is the admins'");
  await rf('brand', '--clear');
  assert.deepEqual((await json('/me')).brand, { text: null, logo: false });
  assert.equal((await call('GET', '/brand/logo')).status, 404);
  assert.equal((await rf('can', 'create', `${bob}, 0B8E5C8A-6D3E-4C21-9F2A-1D2E3F4A5B6C`)).trim(), `create: ${bob}, 0b8e5c8a-6d3e-4c21-9f2a-1d2e3f4a5b6c`);
  assert.equal((await rf('can')).trim(), `publish: admins only\ncreate: ${bob}, 0b8e5c8a-6d3e-4c21-9f2a-1d2e3f4a5b6c\nkeepalive: admins only`);
  assert.equal((await rf('can', 'create', '--clear')).trim(), 'create: admins only');

  // Bob runs an instance in a workspace, so taking him out of it, or his admin role when he isn't in it, is refused unless forced.
  await call('POST', '/api/workspaces', JSON.stringify({ name: 'Guarded' }));
  const file = join(tmp, 'people.txt'), b = sessionOf(await login(bob))!;
  writeFileSync(file, `owner ${adminEmail}\nmember ${bob}  # he runs one\n`);
  assert.match(await rf('people', 'Guarded', '--set', file), /^\+ member bob@demo\.test\nsaved$/m);
  const { id: weekly } = await (await call('POST', '/api/series', JSON.stringify({ workspace: (await named('Guarded')).id, name: 'Weekly' }))).json();
  await ran(`/api/instances/${(await (await call('POST', `/api/series/${weekly}`, JSON.stringify({ label: 'one' }), b)).json()).id}`);
  assert.match(await rf('people', 'Guarded'), /^member +bob@demo\.test +# last in [\d-]+ [\d:]+; runs Weekly\/one$/m);
  writeFileSync(file, `owner ${adminEmail}\n`);
  assert.match(await rf('people', 'Guarded', '--set', file, '-n'), /^- member bob@demo\.test$/m);
  await assert.rejects(rf('people', 'Guarded', '--set', file), /hide open instances from the people who run them.*Guarded\/Weekly\/one, run by Bob <bob@demo\.test>/);
  assert.equal((await named('Guarded')).members.length, 1, 'refused, it changed nothing');
  assert.match(await rf('people', 'Guarded', '--set', file, '--force'), /saved/);
  assert.match(await rf('people'), /^user +bob@demo\.test +# last in .*; runs outside them: Guarded\/Weekly\/one$/m);
  await rf('user', 'role', bob, 'admin');
  writeFileSync(file, `user ${bob}\n`);
  await assert.rejects(rf('people', '--set', file), /Guarded\/Weekly\/one, run by Bob <bob@demo\.test>/);
  assert.match(await rf('people', '--set', file, '--force'), /^bob@demo\.test: admin -> user\nsaved$/m);
});

test("rf pull refuses a link where a folder goes, dangling ones too, but follows its destination's and replaces a file's own", async () => {
  const { id: workspace } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Pulling' }))).json();
  const { instance } = await (await call('POST', '/api/series', JSON.stringify({ workspace, single: true }))).json();
  mkdirSync(join(root, 'instances', instance, 'working', 'nested'));
  writeFileSync(join(root, 'instances', instance, 'working', 'nested', 'victim.txt'), 'from the server');
  const outside = join(tmp, 'pull-outside'), missing = join(tmp, 'pull-missing'), path = 'Pulling/Untitled/Untitled/';
  mkdirSync(outside);
  writeFileSync(join(outside, 'victim.txt'), 'local');
  let n = 0;
  for (const [from, folder, target] of [
    [path, 'working/nested', outside], ['Pulling', 'Pulling', outside],
    [path, 'working', missing], [path, 'working', join(outside, 'victim.txt')],
  ]) {
    const dest = join(tmp, `pull-link-${n++}`), link = join(dest, folder);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    for (const flags of [[], ['--delete'], ['-n']]) {
      await assert.rejects(rf('pull', from, dest, ...flags), fails(1, /is a symlink: remove it or pull into another directory\n$/));
      assert.deepEqual(readdirSync(outside), ['victim.txt']);
      assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'local');
      assert.ok(!existsSync(missing));
    }
  }
  const dest = join(tmp, 'pull-file-link'), file = join(dest, 'working', 'nested', 'victim.txt');
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(join(outside, 'victim.txt'), file);
  await rf('pull', path, dest);
  assert.equal(readFileSync(file, 'utf8'), 'from the server');
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'local');
  symlinkSync(dest, join(tmp, 'pull-linked'));
  assert.match(await rf('pull', path, join(tmp, 'pull-linked')), /fetched 0, \d+ up to date/);
});

test("rf alone lists its commands and rf help COMMAND gives one's usage; every read takes --json; a failure is one line, with exit code 1, and a command used wrongly prints its usage, with exit code 2", async () => {
  assert.match(await rf(), /^rf login URL \[TOKEN\] .*\nrf ls \[--json\] /);
  assert.equal(await rf('--version'), `${JSON.parse(readFileSync(join(app, 'cli', 'package.json'), 'utf8')).version}\n`);
  assert.match(await rf('help', 'wake'), /^rf wake PATH AT \[--label LABEL\] \[--days DAYS\] \| rf wake --cancel ID\n +AT now, [^\n]+\n +mon-fri, [^\n]+\n$/);
  await assert.rejects(rf('wake'), fails(2, /^rf wake PATH AT [^\n]+\n +AT now/));
  await assert.rejects(rf('comment', 'nowhere/at/all', 'Hello'), fails(1, /^rf: nothing you can see at nowhere\/at\/all\n$/));
  await assert.rejects(rf('wake', '--cancel', 'nosuch'), fails(1, /^rf: DELETE \/api\/wakes\/nosuch: 404 [^\n]+\n$/));
  await assert.rejects(rf('costs', '--by', 'colour'), fails(1, /^rf: --by: workspace, series, person, day or outcome\n$/));
  const rows = JSON.parse(await rf('ls', '--json')), week = rows.find((r: { path: string }) => r.path === `larkfield/${series}/2026-08-30`);
  assert.deepEqual([week.id, week.status, rows.find((r: { path: string }) => r.path === `larkfield/${series}`).id], [await iid(series, '2026-08-30'), 'closed', (await shown(series)).id]);
  assert.ok(JSON.parse(await rf('skills', '--json')).some((s: { id: string }) => s.id === 'tool'));
  assert.deepEqual(Object.keys(JSON.parse(await rf('can', '--json'))), ['publish', 'create', 'keepalive']);
  assert.deepEqual(JSON.parse(await rf('brand', '--json')), { text: null, logo: false });
  assert.ok(JSON.parse(await rf('people', '--json')).some((u: { email: string; role: string }) => u.email === adminEmail && u.role === 'admin'));
  assert.ok(JSON.parse(await rf('connections', '--json')).every((c: { name: string; type: string }) => c.name && c.type));
  assert.deepEqual(JSON.parse(await rf('skill', 'versions', 'tool', '--json')).map((v: { version: number }) => v.version), [1, 2, 3, 4]);
});

test('rf comment reports its own seq and note when the first comment renames a task, and --wait on a note returns without a run', async () => {
  const { id: workspace } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Commenting' }))).json();
  await call('PUT', `/api/workspaces/${workspace}`, JSON.stringify({ members: [bob] }));
  const { instance } = await (await call('POST', '/api/series', JSON.stringify({ workspace, single: true }))).json();
  assert.equal(await rf('comment', 'Commenting/Untitled/Untitled', '  From the shell  '), 'commented, seq 2\n');
  const { log } = await json(`/api/instances/${instance}`);
  assert.deepEqual(log.map((e: { op: string }) => e.op), ['create', 'comment', 'rename']);
  const { instance: his } = await (await call('POST', '/api/series', JSON.stringify({ workspace, single: true }), sessionOf(await login(bob))!)).json();
  assert.equal(await rf('comment', 'Commenting/Untitled/Untitled', 'A note for Bob', '--wait'), `a note for the runner, ${bob}, seq 2: it starts no run until they act\n`);
  const note = (await json(`/api/instances/${his}`)).log;
  assert.deepEqual(note.map((e: { op: string; note?: true }) => [e.op, e.note]), [['create', undefined], ['comment', true], ['rename', undefined]]);
});

test('rf reads without a pull: waiting, what waits on you; show, an instance, the threads that wait by id and its last run; log, its entries, or those after a seq; and cat, one file', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Reads' }))).json();
  assert.equal((await call('PUT', `/api/workspaces/${ws}`, JSON.stringify({ members: [bob] }))).status, 200);
  const { id: sid } = await (await call('POST', '/api/series', JSON.stringify({ workspace: ws, name: 'Notes' }))).json();
  const { id } = await (await call('POST', `/api/series/${sid}`, JSON.stringify({ label: 'a1' }))).json(), path = 'Reads/Notes/a1';
  await ran(`/api/instances/${id}`);
  await quiet();
  assert.equal((await call('POST', `/api/instances/${id}/comment`, JSON.stringify({ text: 'Bob notes the rate moved.\nMore below.' }), sessionOf(await login(bob))!)).status, 200);
  await quiet();
  const { log } = await json(`/api/instances/${id}`), note = log.findLast((e: { op: string }) => e.op === 'comment');
  assert.match(await rf('waiting'), new RegExp(`^note  ${path} since [\\d-]+ [\\d:]+: Bob notes the rate moved\\.$`, 'm'));
  assert.deepEqual(JSON.parse(await rf('waiting', '--json')).find((r: { path: string }) => r.path === path), { kind: 'note', path, since: note.at, text: note.text });
  const shown = JSON.parse(await rf('show', path, '--json'));
  assert.deepEqual([shown.id, shown.status, shown.runner, shown.waiting], [id, 'open', adminEmail, [{ comment: note.thread, thread: note.thread, kind: 'note', for: adminEmail, by: bob, item: null, ref: null, text: note.text }]]);
  assert.match(await rf('show', path), new RegExp(`^${path}  open, runner ${adminEmail}\\n${note.thread}  note for ${adminEmail}: Bob notes the rate moved\\.\\nlast run \\d+  \\$0\\.00(  .+)?\\n$`));
  const lines = (await rf('log', path)).trim().split('\n');
  assert.equal(lines.length, log.length);
  assert.match(lines.find(l => l.startsWith(`${note.seq}  `))!, new RegExp(`^${note.seq}  [\\d-]+ [\\d:]+  ${bob}  comment  \\{.*"thread":"${note.thread}".*\\}  Bob notes the rate moved\\.$`));
  assert.deepEqual((await rf('log', path, '--since', String(note.seq - 1), '--json')).trim().split('\n').map(l => JSON.parse(l).seq), log.filter((e: { seq: number }) => e.seq >= note.seq).map((e: { seq: number }) => e.seq));
  assert.equal(await rf('cat', 'AGENTS.md'), 'Fiscal months end on the last Saturday.');
  await assert.rejects(rf('cat', path), fails(1, /^rf: Reads\/Notes\/a1 is a folder: rf pull it\n$/));
  await assert.rejects(rf('show', 'Reads/Notes'), fails(1, /^rf: Reads\/Notes is a series: name one of its instances, as rf ls lists them\n$/));
});

test('rf close --as-series closes before promoting: a refused close leaves the task named and single, ready to retry', async () => {
  const { id: workspace } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Closing' }))).json();
  await call('PUT', `/api/workspaces/${workspace}`, JSON.stringify({ members: [bob] }));
  const { id, instance } = await (await call('POST', '/api/series', JSON.stringify({ workspace, single: true }), sessionOf(await login(bob))!)).json();
  const path = 'Closing/Untitled/Untitled';
  await assert.rejects(rf('close', path, '--as-series', 'Monthly'), fails(1, /: 403 only the runner, bob@demo\.test, closes it/));
  const task = (await named('Closing')).series.find((s: { id: string }) => s.id === id);
  assert.deepEqual([task.name, task.single, task.instances[0].status], ['Untitled', true, 'open']);
  assert.deepEqual((await json(`/api/instances/${instance}`)).log.map((e: { op: string }) => e.op), ['create']);
  await rf('takeover', path);
  assert.equal(await rf('close', path, '--as-series', 'Monthly'), `closed ${path}\n`);
  assert.deepEqual((await json(`/api/instances/${instance}`)).log.map((e: { op: string }) => e.op), ['create', 'takeover', 'close', 'promote']);
});

test('rf acts on an instance as the page does: react, creds, rename, takeover, interrupt, signoff, close, as a series for a task, abandon and correct', async () => {
  const b = sessionOf(await login(bob))!, rows = async () => JSON.parse(await rf('ls', '--json')) as { path: string; id: string; status?: string; runner?: string }[];
  const shown = JSON.parse(await rf('show', 'Reads/Notes/a1', '--json')), on = shown.waiting[0].comment;
  assert.equal(await rf('react', 'Reads/Notes/a1', on, 'up'), `up on ${on}\n`);
  assert.equal(await rf('react', 'Reads/Notes/a1', 'down'), 'down on Reads/Notes/a1\n');
  assert.deepEqual((await json(`/api/instances/${shown.id}`)).log.filter((e: { op: string }) => e.op === 'react').map((e: { on?: number; up: boolean }) => [e.on, e.up]), [[+on.slice(1), true], [undefined, false]]);
  assert.equal(JSON.parse(await rf('show', 'Reads/Notes/a1', '--json')).waiting.length, 1, 'a reaction answers nothing');
  for (const [body, why] of [[{ up: 'yes' }, 'up is true, false or null'], [{ on: 1, up: true }, 'no comment at seq 1']] as const) {
    const r = await call('POST', `/api/instances/${shown.id}/react`, JSON.stringify(body));
    assert.deepEqual([r.status, await r.text()], [400, why]);
  }
  assert.match(await rf('creds', 'Reads/Notes/a1'), new RegExp(`^${adminEmail} ticks:\\n(  .+\\n)*yours:\\n`));
  await assert.rejects(rf('creds', 'Reads/Notes/a1', '--set', 'web:nosuch'), fails(1, /^rf: POST \/api\/instances\/\w+\/logins: 400 logins must be offers of your own logins: \["web:nosuch"\]\n$/));
  assert.equal(await rf('creds', 'Reads/Notes/a1', '--clear'), 'saved, with no logins ticked\n');
  assert.equal(await rf('rename', 'Reads/Notes/a1', 'a2'), 'renamed Reads/Notes/a1 a2\n');
  assert.equal(await rf('rename', 'Reads/Notes', 'Jots'), 'renamed Reads/Notes Jots\n');
  assert.equal(await rf('rename', 'Reads', 'Readings'), 'renamed Reads Readings\n');
  assert.deepEqual((await rows()).filter(r => r.path.startsWith('Readings/')).map(r => r.path), ['Readings/Jots', 'Readings/Jots/a2']);
  const { id: sid } = (await rows()).find(r => r.path === 'Readings/Jots')!, { id: his } = await (await call('POST', `/api/series/${sid}`, JSON.stringify({ label: 'b1' }), b)).json();
  await ran(`/api/instances/${his}`);
  await quiet();
  assert.equal(await rf('takeover', 'Readings/Jots/b1'), 'you run Readings/Jots/b1 now, with no logins ticked\n');
  assert.equal((await json(`/api/instances/${his}`)).runner.by, adminEmail);
  await assert.rejects(rf('interrupt', 'Readings/Jots/b1'), fails(1, /^rf: POST \/api\/instances\/\w+\/interrupt: 409 no run going\n$/));
  const stop = await call('POST', `/api/instances/${his}/interrupt`, undefined, b);
  assert.deepEqual([stop.status, await stop.text()], [403, `only its runner, ${adminEmail}, the workspace's owners and admins stop its run`], 'bob sees it, but neither runs it now nor owns its workspace');
  await assert.rejects(rf('signoff', 'Readings/Jots/b1', 'c1'), fails(1, /: 409 c1 is no ask of the agent's\n$/));
  await assert.rejects(rf('signoff', 'Readings/Jots/b1', 'c1', 'Fine.', 'more'), fails(2, /^rf signoff PATH cN \[TEXT\]/));
  const reject = await call('POST', `/api/instances/${his}/signoff`, JSON.stringify({ thread: 'c1', approved: false }));
  assert.deepEqual([reject.status, await reject.text()], [400, 'a sign-off approves; to say no, reply in the thread'], "rf 0.12's reject, still in use");
  assert.equal(await rf('close', 'Readings/Jots/a2'), 'closed Readings/Jots/a2\n');
  assert.equal(await rf('react', 'Readings/Jots/a2', 'none'), 'none on Readings/Jots/a2\n', 'a closed instance takes reactions');
  assert.match(await rf('correct', 'Readings/Jots/a2', 'The rate was a day stale.', '--see', 'b1'), /^a2 is marked wrong, seq \d+\n$/);
  await assert.rejects(rf('correct', 'Readings/Jots/a2', 'x', '--see', 'zz'), fails(1, /^rf: no instance zz in its series\n$/));
  assert.equal(await rf('abandon', 'Readings/Jots/b1'), 'abandoned Readings/Jots/b1\n');
  const { instance } = await (await call('POST', '/api/series', JSON.stringify({ workspace: (await named('Readings')).id, single: true }))).json();
  assert.equal(await rf('close', 'Readings/Untitled/Untitled', '--as-series', 'Monthly jots'), 'closed Readings/Untitled/Untitled\n');
  const made = (await named('Readings')).series.find((x: { name: string }) => x.name === 'Monthly jots');
  assert.deepEqual([made.single, made.instances.map((i: { id: string; status: string }) => [i.id, i.status])], [false, [[instance, 'closed']]], 'the task became the first instance of the series');
  assert.deepEqual((await rows()).filter(r => r.path.startsWith('Readings/Jots/')).map(r => [r.path, r.status]), [['Readings/Jots/a2', 'closed'], ['Readings/Jots/b1', 'abandoned']]);
});

test('rf new task refuses an existing task or series name before making anything', async () => {
  const { id: workspace } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Naming' }))).json();
  await call('POST', '/api/series', JSON.stringify({ workspace, name: 'Taken_name' }));
  await rf('new', 'task', 'Naming', 'Taken');
  const before = await named('Naming');
  for (const name of ['Taken', 'Taken_name']) {
    await assert.rejects(rf('new', 'task', 'Naming', name), fails(1, /Taken(_name)? exists\n$/));
    assert.deepEqual(await named('Naming'), before);
  }
  assert.equal(await rf('new', 'task', 'Naming'), 'made Naming/Untitled/Untitled, with no logins ticked\n');
});

test('rf makes what the page makes: a workspace, a task, named or by its first comment, a series from a task, its next instance, and a copy of a closed one', async () => {
  const status = async (path: string) => JSON.parse(await rf('ls', '--json')).find((r: { path: string }) => r.path === path)?.status;
  assert.equal(await rf('new', 'workspace', 'Making'), 'made Making\n');
  await assert.rejects(rf('new', 'workspace', 'Making'), fails(1, /: 409 the name Making is taken; choose another\n$/));
  assert.equal(await rf('new', 'task', 'Making', '--comment', 'Reconcile the bank for October'), 'made Making/Reconcile the bank for October/Reconcile the bank for October, with no logins ticked\n');
  assert.equal(await rf('new', 'task', 'Making', 'Lunch'), 'made Making/Lunch/Lunch, with no logins ticked\n');
  assert.equal(await status('Making/Lunch/Lunch'), 'open');
  assert.equal(await rf('new', 'series', 'Making/Lunch', 'Lunches'), 'made the series Making/Lunches\n');
  await assert.rejects(rf('new', 'instance', 'Making/Lunches/Lunch', '2026-11'), fails(1, /^rf: Making\/Lunches\/Lunch is an instance: name its series\n$/));
  await assert.rejects(rf('new', 'instance', 'Making/Lunches', '2026-11', '--creds', 'web:nosuch'), fails(1, /: 400 logins must be offers of your own logins: \["web:nosuch"\]\n$/));
  assert.equal(await rf('new', 'instance', 'Making/Lunches', '2026-11'), 'made Making/Lunches/2026-11, with no logins ticked\n');
  await assert.rejects(rf('copy', 'Making/Lunches/Lunch', 'again'), fails(1, /: 409 only a closed or abandoned instance can be duplicated\n$/));
  await quiet();
  await rf('close', 'Making/Lunches/Lunch');
  assert.equal(await rf('copy', 'Making/Lunches/Lunch', 'again'), 'made Making/Lunches/again, with no logins ticked\n');
  assert.deepEqual([await status('Making/Lunches/Lunch'), await status('Making/Lunches/again')], ['closed', 'open']);
});

test("rf's acts start no run unless --wake: a new instance waits for its first act, and a task's first comment, a comment and an upload are quiet", async () => {
  const path = 'Making/Lunches/2026-11', log = async (p: string) => (await rf('log', p, '--json')).trim().split('\n').map(l => JSON.parse(l));
  const task = await log('Making/Reconcile the bank for October/Reconcile the bank for October');
  assert.deepEqual([task.find(e => e.op === 'comment').quiet, task.some(e => e.op === 'run')], [true, false]);
  assert.deepEqual((await log(path)).map(e => e.op), ['create'], 'no wake');
  await rf('comment', path, 'For the record.');
  const file = join(tmp, 'menu.txt');
  writeFileSync(file, 'soup');
  assert.equal(await rf('upload', path, file), 'uploaded\n');
  await new Promise(r => setTimeout(r, 2500));
  assert.deepEqual((await log(path)).map(e => [e.op, e.quiet]), [['create', undefined], ['comment', true], ['upload', true], ['point', undefined]], 'no run');
  await rf('comment', path, 'Plan the week.', '--wake');
  const { id } = JSON.parse(await rf('ls', '--json')).find((r: { path: string }) => r.path === path);
  assert.equal((await ran(`/api/instances/${id}`)).findLast(e => e.op === 'comment')!.quiet, undefined);
  assert.equal(await rf('new', 'instance', 'Making/Lunches', '2026-12', '--wake'), 'made Making/Lunches/2026-12, with no logins ticked\n');
  assert.deepEqual((await log('Making/Lunches/2026-12')).slice(0, 2).map(e => [e.op, e.from]), [['create', undefined], ['wake', adminEmail]]);
  await quiet();
});

test('rf shares and archives series and workspaces, starts or drops a request, lists your logins, takes offers off them and signs out of them, adds, sets and removes websites, and asks for, approves and revokes grants', async () => {
  const { saveLogin } = await import('../src/logins.ts'), week = new Date(Date.now() + 86_400_000).toISOString(), since = new Date().toISOString();
  saveLogin(adminEmail, { id: 'web:crm', kind: 'website', name: 'CRM', since, offers: [{ id: 'web:crm', name: 'CRM' }], keepalive: week }, 'state');
  saveLogin(adminEmail, { id: 'web:erp', kind: 'website', name: 'ERP', since, offers: [{ id: 'web:erp', name: 'ERP' }], expired: true }, 'state');
  saveLogin(adminEmail, { id: 'wh', kind: 'databricks', name: 'Databricks wh', since, offers: [{ id: 'wh:adb-1.azuredatabricks.net/w1', name: 'Warehouse Finance' }] }, 'token');
  const lunches = async () => (await named('Making')).series.find((x: { name: string }) => x.name === 'Lunches');
  assert.equal(await rf('share', 'Making/Lunches', 'on', '--creds', 'web:crm'), 'shared Making/Lunches, ticking web:crm: you agree that agents carry these credentials while acting as you\n');
  assert.deepEqual([(await lunches()).shared_by, (await lunches()).shared_logins], [adminEmail, ['web:crm']]);
  assert.equal(await rf('share', 'Making/Lunches', 'off'), 'stopped sharing Making/Lunches\n');
  await assert.rejects(rf('share', 'Making/Lunches/again', 'on'), fails(1, /^rf: Making\/Lunches\/again is an instance: name its series\n$/));
  assert.equal(await rf('archive', 'Making/Lunches'), 'archived Making/Lunches\n');
  assert.equal((await lunches()).archived, true);
  assert.equal(await rf('archive', 'Making/Lunches', '--undo'), 'brought back Making/Lunches\n');
  assert.equal(await rf('archive', 'Making'), 'archived Making\n');
  assert.equal((await named('Making')).archived, true);
  await rf('archive', 'Making', '--undo');
  await assert.rejects(rf('request', 'drop', 'nosuch'), fails(1, /: 404 no request nosuch\n$/));
  await assert.rejects(rf('request', 'start', 'nosuch'), fails(1, /: 404 no request nosuch\n$/));
  const listed = await rf('logins');
  assert.match(listed, /^web:crm  CRM  signed in since [\d-]+ [\d:]+, kept alive until [\d-]+ [\d:]+$/m, 'a website offers itself alone, which goes unsaid');
  assert.match(listed, new RegExp(`^web:erp  ERP  expired: sign in again at ${base}/#logins\n`, 'm'));
  assert.match(listed, /^wh  Databricks wh  signed in since [\d-]+ [\d:]+\n  offers wh:adb-1\.azuredatabricks\.net\/w1  Warehouse Finance$/m);
  assert.equal(await rf('logins', 'unoffer', 'web:crm', 'web:crm'), 'web:crm no longer offers web:crm\n');
  assert.deepEqual(JSON.parse(await rf('logins', '--json')).find((l: { id: string }) => l.id === 'web:crm').offers, []);
  await assert.rejects(rf('logins', 'allow', 'nosuch', 'cdn.example.com'), fails(1, /: 404 admin@demo\.test has no website nosuch/));
  assert.equal(await rf('site', 'add', 'gg', 'https://gg.example.com/'), `added gg: sign in to it at ${base}/#logins, then rf site ask gg WORKSPACE REASON\n`);
  assert.equal(await rf('site', 'add', 'gg-sso', 'https://gg.example.com/sso', '--header', 'x-bot-token'), `added gg-sso: sign in to it at ${base}/#logins, then rf site ask gg-sso WORKSPACE REASON\n`, 'two at one host');
  await assert.rejects(rf('site', 'add', 'gg', 'https://other.example.com/'), fails(1, /: 409 you have a website gg already: name this one otherwise\n$/));
  assert.equal(await rf('site', 'set', 'gg', '--every', '5m'), 'saved\n');
  assert.deepEqual([(await json('/logins/sites')).gg.every, (await json('/logins/sites'))['gg-sso'].header], [5, 'x-bot-token']);
  assert.equal(await rf('logins', 'allow', 'gg', 'cdn.gg-assets.example.net'), 'gg reaches cdn.gg-assets.example.net\n');
  await assert.rejects(rf('site', 'ask', 'gg', 'Making', 'month-end pulls'), fails(1, /: 409 sign in to gg first/));
  saveLogin(adminEmail, { id: 'web:gg', kind: 'website', name: 'GG', since, offers: [{ id: 'web:gg', name: 'GG' }] }, 'state');
  const asked = /^asked, as grant (\w+): one of Making's owners approves or denies it\nnot checked: the server has no OPENROUTER_API_KEY\n$/.exec(await rf('site', 'ask', 'gg', 'Making', 'month-end pulls'))![1];
  await assert.rejects(rf('site', 'ask', 'gg', 'Making', 'again'), fails(1, /: 409 you've asked for gg in Making already/));
  assert.match(await rf('waiting'), new RegExp(`^grant  Making since .+, grant ${asked}: ${adminEmail} asks to use gg, at https://gg\\.example\\.com/, here: month-end pulls \\(not checked\\)$`, 'm'));
  assert.equal(await rf('grant', 'approve', asked, 'fine'), 'approved\n');
  assert.match(await rf('grants', 'Making'), new RegExp(`^${asked}  approved  gg at https://gg\\.example\\.com/ in Making for ${adminEmail}, since .+: month-end pulls; approved by ${adminEmail}: fine \\(not checked\\)$`, 'm'));
  assert.equal(await rf('grant', 'revoke', asked), 'revoked\n');
  assert.ok(!JSON.parse(await rf('logins', '--json')).some((l: { id: string }) => l.id === 'web:gg'), 'with no grant left, the login is signed out');
  assert.equal(await rf('site', 'remove', 'gg'), 'removed gg\n');
  await assert.rejects(rf('site', 'remove', 'gg'), fails(1, /: 404 admin@demo\.test has no website gg: theirs are gg-sso/));
  await assert.rejects(rf('site', 'add', 'gg'), fails(2, /^rf site add NAME URL /));
  for (const id of ['web:crm', 'web:erp', 'wh']) assert.equal(await rf('logins', 'signout', id), `signed out of ${id}\n`);
  await assert.rejects(rf('logins', 'signout', 'web:crm'), fails(1, /: 404 you have no login web:crm\n$/));
});

test('the page hears of changes from an event stream, only of instances it can see', async () => {
  const listen = async (cookie: string) => {
    const r = await fetch(base + '/api/events', { headers: { cookie } }), reader = r.body!.getReader(), got: string[] = [];
    (async () => { for (let c; !(c = await reader.read()).done;) got.push(new TextDecoder().decode(c.value)); })().catch(() => {});
    return { got, stop: () => reader.cancel() };
  };
  const b = sessionOf(await login(bob))!, mine = await listen(admin), bobs = await listen(b), path = await at(series, 'talk'), id = path.split('/').pop()!;
  await call('POST', `${path}/comment`, JSON.stringify({ text: 'heard?' }));
  for (let waited = 0; !mine.got.join('').includes(`data: ${id}\n\n`) && waited < 10_000; waited += 100) await new Promise(r => setTimeout(r, 100));
  assert.ok(mine.got.join('').includes(`data: ${id}\n\n`));
  assert.ok(!bobs.got.join('').includes(id), "bob isn't in larkfield");
  const row = (await shown(series)).instances.find((i: { id: string }) => i.id === id);
  const sum = await json(`${path}/summary`);
  assert.deepEqual([Object.keys(sum), sum.id, sum.label, sum.runner], [Object.keys(row), row.id, row.label, row.runner], "the instance's row, as the listing has it");
  assert.equal((await call('GET', `${path}/summary`, undefined, b)).status, 404);
  mine.stop();
  bobs.stop();
});

test('a preview queued while a working file changes is kept under the content the preview read', async () => {
  const id = await iid(series, '2026-08-30'), folder = join(root, 'instances', id, 'working');
  const preview = (name: string) => call('GET', `/preview/${id}/working/${name}`);
  for (const name of ['race-hold-1.csv', 'race-hold-2.csv']) writeFileSync(join(folder, name), name);
  const holds = [preview('race-hold-1.csv'), preview('race-hold-2.csv')];
  let queued: Promise<Response>;
  const path = join(folder, 'race-content.csv'), old = 'value\nold\n', fresh = 'value\nnew\n';
  try {
    for (let n = 0; readdirSync(tmp).filter(f => f.startsWith('holding-')).length < 2 && n < 200; n++) await new Promise(r => setTimeout(r, 25));
    assert.equal(readdirSync(tmp).filter(f => f.startsWith('holding-')).length, 2);
    writeFileSync(path, old);
    queued = preview('race-content.csv');
    let hashed = false;
    for (let n = 0; !hashed && n < 200; n++) {
      await new Promise(r => setTimeout(r, 25));
      hashed = readdirSync(`/proc/${proc.pid}/fd`).some(fd => {
        try {
          return readlinkSync(`/proc/${proc.pid}/fd/${fd}`) === path;
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return false; }
      });
    }
    assert.ok(hashed, 'the queued preview has opened the old bytes');
    await new Promise(r => setTimeout(r, 100));
    writeFileSync(path, fresh);
  } finally {
    writeFileSync(join(tmp, 'release-previews'), '');
    await Promise.all(holds);
  }
  assert.deepEqual((await (await queued!).json()).sheets[0].rows, [['value'], ['new']]);
  mkdirSync(join(root, 'instances', id, 'upload'), { recursive: true });
  writeFileSync(join(root, 'instances', id, 'upload', 'race-content.csv'), old);
  const upload = await call('GET', `/preview/${id}/upload/race-content.csv`);
  assert.deepEqual((await upload.json()).sheets[0].rows, [['value'], ['old']]);
  for (const f of readdirSync(join(root, '.previews'))) rmSync(join(root, '.previews', f));
});

test('the second audit: a bad request line, a bad workbook and a slow body hurt nothing; a token makes tokens for no one', async () => {
  const { connect } = await import('node:net'), { request } = await import('node:http');
  const raw = connect(Number(new URL(base).port), '127.0.0.1');
  raw.end('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
  await Promise.race([once(raw, 'data'), once(raw, 'close')]);
  raw.destroy();
  const bad = join(await dir(series, '2026-08-30'), 'working', 'bad.xlsx');
  writeFileSync(bad, 'not a workbook');
  const preview = async (name: string) => call('GET', `/preview/${await iid(series, '2026-08-30')}/working/${name}`);
  assert.equal((await preview('bad.xlsx')).status, 500);
  writeFileSync(bad.replace('bad.xlsx', 'fine.csv'), 'month,total\n2026-08,5\n');
  assert.deepEqual((await (await preview('fine.csv')).json()).sheets[0].rows, [['month', 'total'], ['2026-08', '5']]);
  const kept = readdirSync(join(root, '.previews'));
  assert.equal(kept.length, 1, 'a preview is kept, one that failed not');
  writeFileSync(join(root, '.previews', kept[0]), '{"sheets":[{"name":"kept","rows":[],"truncated":false}]}');
  assert.equal((await (await preview('fine.csv')).json()).sheets[0].name, 'kept', 'and the same file previews from it');
  cpSync(join(app, 'test', 'formats.xlsx'), bad.replace('bad.xlsx', 'formats.xlsx'));
  const book = (await (await preview('formats.xlsx')).json()).sheets.map((s: { name: string; at: number; state?: string; rows?: unknown[] }) => [s.name, s.at, s.state, !!s.rows]);
  assert.deepEqual(book, [['Summary', 0, undefined, false], ['Other', 2, undefined, true], ['Hidden', 1, 'hidden', false]], 'its sheets, the hidden after the others, and the one it opens on read');
  const summary = await (await preview('formats.xlsx?sheet=0')).json(), shown = (...at: string[]) => at.map(k => summary.look[k].t);
  assert.deepEqual(shown('1,1', '1,2', '1,3', '1,4', '2,1', '2,3', '2,4'), ['1,234,567.89', '25.6%', '(1,500.50)', '30-Aug-26 2:05 PM', ' - ', '3K', '2026-09-30'], 'as its number formats show it');
  assert.deepEqual([summary.look['0,0'], summary.look['0,1'], summary.look['0,2'], summary.look['1,4'].r], [{ b: true }, { bg: '#FFFF00' }, { bg: '#B9CDE5' }, true], 'bold, fills, a theme colour tinted, and dates to the right');
  assert.deepEqual([summary.rows[3], summary.merged, summary.hidden, summary.widths['0']], [[{ f: '=SUM(B2:B3)' }], [[4, 0, 4, 2]], { rows: [2], cols: [3] }, 20]);
  rmSync(bad.replace('bad.xlsx', 'formats.xlsx'));
  cpSync(join(app, 'test', 'mail.eml'), bad.replace('bad.xlsx', 'mail.eml'));
  const mail = (await (await preview('mail.eml')).json()).email;
  assert.deepEqual([mail.headers.Subject, mail.attachments], ['Aging', [{ name: 'book.xlsx', k: 1 }, { name: 'message.eml', k: 2 }]], 'its attachments, not the image it shows');
  assert.match(mail.html, /<img src="data:image\/png;base64,[^"]+"\/><img\/>/, 'its own image inline, a remote one gone');
  assert.doesNotMatch(mail.html, /script|onload|javascript:|evil\.test|<form|<input/i);
  assert.equal((await (await preview('mail.eml?attachment=1&sheet=1')).json()).name, 'Hidden', "an attachment's own sheet");
  assert.equal((await (await preview('mail.eml?attachment=2')).json()).email.text, 'inner body\n', 'and a message within');
  rmSync(bad.replace('bad.xlsx', 'mail.eml'));
  cpSync(join(app, 'test', 'pack.pdf'), bad.replace('bad.xlsx', 'pack.pdf'));
  const pack = (await (await preview('pack.pdf')).json()).pdf;
  assert.deepEqual([pack.pages, Object.keys(pack.shown)], [3, ['1']], 'its pages, the first shown');
  assert.match((await (await preview('pack.pdf?page=3')).json()).image, /^data:image\/png;base64,/, 'and another as asked');
  rmSync(bad.replace('bad.xlsx', 'pack.pdf'));
  cpSync(join(app, 'test', 'pack.docx'), bad.replace('bad.xlsx', 'pack.docx'));
  assert.deepEqual((await (await preview('pack.docx')).json()).doc, [{ h: 1, text: 'Aging pack' }, { p: 'The aging as of August.' }, { li: 'Receivables over 90 days', level: 0 },
    { li: 'Disputed items', level: 0 }, { h: 2, text: 'Totals' }, { table: [['Bucket', 'Amount'], ['90+', '1,234']] }], 'a document, as headings, paragraphs, list items and tables');
  const layout = (await (await preview('pack.docx?layout=1')).json()).pdf;
  assert.deepEqual([layout.pages, Object.keys(layout.shown)], [1, ['1']], 'and as LibreOffice lays it out');
  rmSync(bad.replace('bad.xlsx', 'pack.docx'));
  writeFileSync(bad.replace('bad.xlsx', 'gb.csv'), Buffer.from('d4c2b7dd3bbacfbcc60a323032362d30383b350a', 'hex'));
  assert.deepEqual((await (await preview('gb.csv')).json()).sheets[0].rows, [['月份', '合计'], ['2026-08', '5']], 'a CSV in GB18030, by semicolons');
  rmSync(bad.replace('bad.xlsx', 'gb.csv'));
  truncateSync(bad, 100e6 + 1);
  const big = await preview('bad.xlsx');
  assert.deepEqual([big.status, await big.text()], [413, 'bad.xlsx is over 100 MB, too big to preview: download it']);
  rmSync(bad);
  rmSync(bad.replace('bad.xlsx', 'fine.csv'));
  assert.equal((await call('GET', '/me')).status, 200, 'the server is still up');

  const b = sessionOf(await login(bob))!, { token } = await (await call('POST', '/tokens', JSON.stringify({ name: 'mine', days: 7 }))).json();
  const r = await fetch(base + '/tokens', { method: 'POST', headers: { cookie: b, authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'mixed', days: 7 }) });
  assert.equal(r.status, 200);
  assert.ok((await json('/tokens', b)).some((x: { name: string }) => x.name === 'mixed'), "made as the session's person");
  assert.ok(!(await json('/tokens')).some((x: { name: string }) => x.name === 'mixed'));

  const [lark, other] = [await named('larkfield'), (await workspaces()).find((w: { name: string; manage: boolean }) => w.name !== 'larkfield' && w.manage)];
  const slow = request(`${base}/api/workspaces/${lark.id}`, { method: 'PUT', headers: { cookie: admin }, agent: false }), done = once(slow, 'response');
  slow.write('{"agents": ');
  await new Promise(ok => setTimeout(ok, 200));
  assert.equal((await call('PUT', `/api/workspaces/${other.id}`, JSON.stringify({ archived: true }))).status, 200);
  slow.end('"held open"}');
  const [answered] = await done;
  answered.resume();
  assert.equal(answered.statusCode, 200);
  assert.ok((await workspaces()).find((w: { id: string }) => w.id === other.id).archived, 'the change made meanwhile stays');
  assert.equal((await named('larkfield')).agents, 'held open');
  await call('PUT', `/api/workspaces/${other.id}`, JSON.stringify({ archived: false }));
  await call('PUT', `/api/workspaces/${lark.id}`, JSON.stringify({ agents: lark.agents }));
});

test("an instance is new to a person while it has others' or the agent's news they haven't viewed; their own acts aren't news", async () => {
  const { id } = await named('larkfield'), b = sessionOf(await login(bob))!;
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ owners: [adminEmail], members: [bob], force: true }))).status, 200);
  const path = `/api/instances/${(await (await call('POST', '/api/series', JSON.stringify({ workspace: id, single: true }), b)).json()).instance}`;
  const unread = async (cookie = admin) => (await json(`${path}/summary`, cookie)).unread;
  await json(path, b);
  assert.equal(await unread(b), false);
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'have a look' }))).status, 200);
  assert.deepEqual([await unread(b), await unread()], [true, false], "the admin's comment is news to bob, not to the admin");
  await json(path, b);
  assert.equal(await unread(b), false, 'viewing it marks it seen');
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ owners: [], members: [], force: true }))).status, 200);
});

test("rf login without a token signs in through the browser: the person allows rf's request on the page, matching its code, and rf collects a 30-day token", async () => {
  const home = join(tmp, 'browser-login-home');
  mkdirSync(home);
  // No opener on PATH, so the test opens no browser; rf prints the link all the same.
  const p = spawn(process.execPath, [join(app, 'src', 'rf-people.ts'), 'login', base], { env: { HOME: home, PATH: dirname(process.execPath) } });
  let out = '';
  p.stdout.on('data', d => (out += d));
  while (!/code ([A-Z]{4}-[A-Z]{4})/.test(out)) await new Promise(r => setTimeout(r, 50));
  const code = /code ([A-Z]{4}-[A-Z]{4})/.exec(out)![1];
  assert.match(out, new RegExp(`Open ${base}/cli\nand type the code ${code} there`), 'the link carries no code');
  assert.equal((await fetch(`${base}/cli`)).status, 200, 'not signed in, the page offers to sign in');
  assert.match(await (await call('GET', `/cli?code=${code}`)).text(), /Type the code rf shows you.+Anyone who asks you to type theirs/s, "a code in a link is no code typed");
  const typed = await fetch(`${base}/cli`, { method: 'POST', body: new URLSearchParams({ code: code.toLowerCase().replace('-', ' ') }), headers: { cookie: admin, 'sec-fetch-site': 'same-origin' } });
  assert.match(await typed.text(), new RegExp(`rf on .+, asking from [0-9a-f.:]+ under a min ago, asks to act as you, ${adminEmail}, for 30 days`, 's'), 'typed, in any case and spacing, it says where the request came from');
  const allow = await fetch(`${base}/cli`, { method: 'POST', body: new URLSearchParams({ code, allow: 'yes' }), headers: { cookie: admin, 'sec-fetch-site': 'same-origin' } });
  assert.match(await allow.text(), /is signed in as you/);
  await once(p, 'exit');
  assert.match(out, new RegExp(`signed in as ${adminEmail}`));
  assert.ok((await json('/tokens')).some((t: { name: string }) => t.name.startsWith('rf on ')), 'the token shows under Tokens');
  const { id } = await (await fetch(`${base}/auth/cli`, { method: 'POST', body: '{}' })).json();
  assert.equal((await fetch(`${base}/auth/cli/poll`, { method: 'POST', body: JSON.stringify({ id }) })).status, 202);
  assert.equal((await fetch(`${base}/auth/cli/poll`, { method: 'POST', body: JSON.stringify({ id: 'made-up' }) })).status, 410);
  for (const path of ['/auth/cli', '/auth/cli/poll']) assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: ' '.repeat(65_537) })).status, 413, `${path} takes 64 KB at most`);
});

test('merging a workspace deletes proposals into it, including one whose proposer no longer manages its workspace', async () => {
  const b = sessionOf(await login(bob))!;
  const make = async (name: string) => (await (await call('POST', '/api/workspaces', JSON.stringify({ name }))).json()).id;
  const from = await make('Lapsed source'), target = await make('Lapsed target'), into = await make('Lapsed survivor');
  const owners = (owners: string[]) => call('PUT', `/api/workspaces/${from}`, JSON.stringify({ owners }));
  assert.equal((await owners([bob])).status, 200);
  assert.equal((await call('PUT', `/api/workspaces/${target}`, JSON.stringify({ members: [bob] }))).status, 200);
  assert.equal((await call('PUT', `/api/proposals/${from}`, JSON.stringify({ kind: 'merge', to: target }), b)).status, 200);
  assert.equal((await owners([])).status, 200);
  assert.equal((await call('PUT', `/api/proposals/${target}`, JSON.stringify({ kind: 'merge', to: into }))).status, 200);
  assert.equal((await call('POST', `/api/proposals/${target}`, JSON.stringify({ owners: [], members: [] }))).status, 200);
  assert.equal((await owners([bob])).status, 200);
  assert.equal((await call('GET', '/api')).status, 200);
  assert.equal((await call('GET', '/api/status')).status, 200);
  assert.equal((await named('Lapsed source')).proposal, null);
  assert.equal(JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8')).workspaces[from].proposal, undefined);
});

test("a workspace's owners propose to merge it into another or move a series there, whose owners accept or decline within a week; what moves keeps its ids, and both sides hear of it", async () => {
  const b = sessionOf(await login(bob))!;
  const make = async (name: string) => (await (await call('POST', '/api/workspaces', JSON.stringify({ name }))).json()).id as string;
  const put = (ws: string, body: object) => call('PUT', `/api/workspaces/${ws}`, JSON.stringify(body));
  const add = async (ws: string, name: string) => (await (await call('POST', '/api/series', JSON.stringify({ workspace: ws, name }))).json()).id as string;
  const propose = (body: object, cookie = admin) => call('PUT', `/api/proposals/${from}`, JSON.stringify(body), cookie);
  const accept = (body: object, cookie = admin) => call('POST', `/api/proposals/${from}`, JSON.stringify(body), cookie);
  const listed = async (ws: string, cookie = admin) => (await workspaces(cookie)).find((w: { id: string }) => w.id === ws);
  const from = await make('Moves A'), into = await make('Moves B');
  await put(from, { owners: [bob], members: [], agents: 'Fiscal months end on Saturdays.\n' });
  await put(into, { agents: 'Amounts in HKD.\n' });
  const rec = await add(from, 'Rec'), aging = await add(from, 'Aging');
  await add(into, 'Rec');
  const { id: inst } = await (await call('POST', `/api/series/${rec}`, JSON.stringify({ label: 'w1' }), b)).json();
  const { id: other } = await (await call('POST', `/api/series/${aging}`, JSON.stringify({ label: 'w1' }), b)).json();
  await call('PUT', `/api/series/${rec}`, JSON.stringify({ share: true, logins: [] }), b);
  const { id: wake } = await (await call('PUT', `/api/wakes/${rec}`, JSON.stringify({ at: '+1d', label: 'w2' }))).json();
  await quiet();

  assert.equal((await propose({ kind: 'move', series: rec, to: into }, b)).status, 404, 'into a workspace its proposer sees');
  await put(into, { members: [bob] });
  assert.equal((await propose({ kind: 'move', series: 'nope', to: into }, b)).status, 400);
  assert.equal((await propose({ kind: 'move', series: rec, to: into }, b)).status, 200);
  const twice = await propose({ kind: 'merge', to: into }, b);
  assert.deepEqual([twice.status, await twice.text()], [409, "Moves A has a proposal open, into Moves B: until it's accepted, declined or withdrawn, or lapses a week on, neither takes another"]);
  assert.equal((await accept({ owners: [], members: [] }, b)).status, 403, "the other workspace's managers accept it");
  assert.deepEqual({ ...(await listed(into)).proposal, at: undefined }, { id: from, into, kind: 'move', from: 'Moves A', to: 'Moves B', series: 'Rec', by: bob, at: undefined });
  const treeFile = join(root, '.rf', 'tree.json'), t = JSON.parse(readFileSync(treeFile, 'utf8'));
  t.workspaces[from].proposal.at = new Date(Date.now() - 8 * 86400e3).toISOString();
  writeFileSync(treeFile, JSON.stringify(t));
  assert.deepEqual([(await listed(from)).proposal, (await call('DELETE', `/api/proposals/${from}`)).status], [null, 404], 'a week on, it lapses');

  await put(into, { members: [], archived: true });
  assert.equal((await propose({ kind: 'move', series: rec, to: into })).status, 409, 'none into an archived workspace');
  await put(into, { archived: false });
  assert.equal((await propose({ kind: 'move', series: rec, to: into })).status, 200);
  const shown = await json(`/api/proposals/${from}`);
  assert.deepEqual([shown.series, shown.people], [[{ id: rec, from: 'Moves A/Rec', to: 'Moves B/Rec 2' }], [bob]], 'renamed where the name is taken; who runs it but is not in B');
  assert.equal((await call('DELETE', `/api/proposals/${from}`)).status, 200, 'declined');
  await propose({ kind: 'move', series: rec, to: into });
  assert.equal((await accept({ owners: [], members: [] })).status, 200);
  const moved = (await listed(into)).series.find((s: { id: string }) => s.id === rec);
  assert.deepEqual([moved.name, moved.shared_by, moved.wakes.map((k: { id: string }) => k.id)], ['Rec 2', null, [wake]], 'no longer shared; its wakes go with it');
  const { log } = await json(`/api/instances/${inst}`);
  assert.deepEqual({ ...log.at(-1), seq: 0, at: '' }, { seq: 0, at: '', by: adminEmail, op: 'move', from: 'Moves A/Rec', to: 'Moves B/Rec 2' });
  assert.equal((await call('GET', `/api/instances/${inst}`, undefined, b)).status, 404, 'left out, bob no longer sees it');
  assert.deepEqual((await listed(from, b)).moved.map((m: { name: string; to: string }) => `${m.name} moved to ${m.to}`), ['Rec moved to Moves B/Rec 2']);

  assert.equal((await propose({ kind: 'merge', to: into })).status, 200);
  assert.equal((await call('DELETE', `/api/proposals/${from}`, undefined, b)).status, 200, "withdrawn by the merged workspace's owner");
  await put(into, { members: [bob] });
  assert.equal((await propose({ kind: 'merge', to: into }, b)).status, 200);
  await put(from, { owners: [], members: [bob] });
  assert.deepEqual([(await listed(into)).proposal, (await accept({ owners: [], members: [] })).status], [null, 404], 'open only while its proposer manages the workspace');
  assert.equal((await propose({ kind: 'merge', to: into })).status, 200);
  const late = await add(from, 'Late'), merging = await json(`/api/proposals/${from}`);
  assert.deepEqual([merging.series.filter((s: { since?: true }) => s.since).map((s: { id: string }) => s.id), merging.agents], [[late], 'Fiscal months end on Saturdays.\n'], 'a series made since it was proposed, and the AGENTS.md it adds, shown to the one accepting');
  assert.deepEqual((await json('/api/status')).proposals.map((p: { kind: string; from: string; to: string; by: string }) => [p.kind, p.from, p.to, p.by]), [['merge', 'Moves A', 'Moves B', adminEmail]]);
  await json(`/api/instances/${other}`);
  await json(`/api/instances/${other}`, b);
  const grantsFile = join(root, '.rf', 'grants.json'), had = existsSync(grantsFile) ? JSON.parse(readFileSync(grantsFile, 'utf8')) : {};
  writeFileSync(grantsFile, JSON.stringify({ ...had, gm: { workspace: from, person: bob, site: 'gone', reason: 'r', at: '', state: 'denied' } }));
  assert.equal((await accept({ owners: [bob], members: [] })).status, 200);
  assert.deepEqual([(await call('GET', '/api', undefined, b)).status, 'gm' in JSON.parse(readFileSync(grantsFile, 'utf8'))], [200, false], "its grants go with it, so no one's listing meets a workspace that's gone");
  const merged = await listed(into, b);
  assert.deepEqual([merged.owners, merged.members, merged.series.map((s: { name: string }) => s.name), merged.agents],
    [[adminEmail, bob], [], ['Aging', 'Late', 'Rec', 'Rec 2'], 'Amounts in HKD.\n\n## Moves A\n\nFiscal months end on Saturdays.\n']);
  assert.deepEqual([await listed(from), existsSync(join(root, 'agents', `${from}.md`))], [undefined, false], 'the merged workspace is gone, its AGENTS.md with it');
  const unread = async (cookie: string) => (await listed(into, cookie)).series.find((s: { id: string }) => s.id === aging).instances[0].unread;
  assert.deepEqual([await unread(b), await unread(admin)], [true, false], 'new to everyone but who accepted');
  const empty = await make('Moves C'), reader = await make('Moves D');
  for (const [source, to] of [[empty, reader], [reader, empty]]) assert.equal((await call('PUT', `/api/workspaces/${source}/readers/${to}`)).status, 200);
  assert.equal((await call('PUT', `/api/proposals/${empty}`, JSON.stringify({ kind: 'merge', to: into }))).status, 200);
  assert.equal((await call('POST', `/api/proposals/${empty}`, JSON.stringify({ owners: [], members: [] }))).status, 200, 'a workspace with no series merges too');
  assert.deepEqual([(await listed(reader)).reads, (await listed(reader)).readers, (await listed(into)).reads], [[], [], []], "the merged workspace's links go, both ways");
});

test("a skill push's files stay out of the system's log", async () => {
  const files = { 'SKILL.md': Buffer.from('---\nname: audit\ndescription: Audit\n---\nPrivate instructions\n').toString('base64'), 'scripts/read.py': Buffer.from('print("private script")\n').toString('base64') };
  assert.equal((await call('POST', '/skills/audit/versions', JSON.stringify({ files }))).status, 200);
  // The act is logged as the response finishes, so it may land a moment after the response arrives.
  let logged = '', act;
  for (let i = 0; !act; i++) {
    if (i) await new Promise(r => setTimeout(r, 50));
    assert.ok(i < 100, 'the skill push was never logged');
    logged = readFileSync(join(root, '.rf/log.jsonl'), 'utf8');
    act = logged.trim().split('\n').map(l => JSON.parse(l)).findLast(a => a.path === '/skills/audit/versions');
  }
  assert.deepEqual(act.body, {});
  for (const data of Object.values(files)) assert.ok(!logged.includes(data));
  assert.deepEqual(await json('/skills/audit/versions/1'), files);
});

test("what a person changes beyond an instance is an act of theirs in the system's log, once it's done, its secrets and files' contents left out", async () => {
  const acts = () => readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const before = acts().length;
  assert.equal((await call('POST', '/api/workspaces', JSON.stringify({ name: 'Logged' }))).status, 200);
  assert.equal((await call('POST', '/api/workspaces', JSON.stringify({ name: '' }))).status, 400);
  assert.equal((await call('PUT', '/brand', JSON.stringify({ text: 'Logged', logo: { name: 'l.png', data: 'iVBORw0KGgo=' } }))).status, 200);
  assert.equal((await call('PUT', '/brand', JSON.stringify({ clear: true }))).status, 200);
  assert.deepEqual(acts().slice(before).map(a => [a.seq, a.by, a.method, a.path, a.body]), [
    [before + 1, adminEmail, 'POST', '/api/workspaces', { name: 'Logged' }],
    [before + 2, adminEmail, 'PUT', '/brand', { text: 'Logged', logo: { name: 'l.png' } }],
    [before + 3, adminEmail, 'PUT', '/brand', { clear: true }],
  ], 'one refused is no act');
});

test('admins keep the hosts runs may reach beyond the sandbox\'s own list, with rf egress', async () => {
  assert.equal(await rf('egress', 'add', 'api.example.com'), 'api.example.com\n');
  assert.equal(await rf('egress', 'add', '*.example.org'), 'api.example.com\n*.example.org\n');
  assert.equal(await rf('egress', 'remove', 'api.example.com'), '*.example.org\n');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.rf', 'egress.json'), 'utf8')), ['*.example.org']);
  const bad = await call('PUT', '/egress', JSON.stringify({ hosts: ['bad host'] }));
  assert.deepEqual([bad.status, await bad.text()], [400, 'hosts: names such as pypi.org or *.example.com, not ["bad host"]']);
  assert.equal((await call('PUT', '/egress', JSON.stringify({ hosts: [] }), sessionOf(await login(bob))!)).status, 403, 'admins alone');
  assert.equal(await rf('egress', 'remove', '*.example.org'), '\n');
});

test("admins see the hosts at internal addresses they let every website reach, with who let each and when, and take one out, with rf internal", async () => {
  assert.equal(await rf('internal'), 'none: an admin lets websites reach one with rf site set NAME --internal true\n');
  writeFileSync(join(root, '.rf', 'internal.json'), JSON.stringify({ 'erp.corp.test': { by: adminEmail, at: '2026-11-09T10:00:00.000Z' }, '10.1.2.3': { by: adminEmail, at: '2026-11-09T11:00:00.000Z' } }));
  const lines = (await rf('internal')).trim().split('\n');
  assert.deepEqual(lines.map(l => l.split(/\s+/)[0]), ['erp.corp.test', '10.1.2.3']);
  assert.ok(lines.every(l => l.trim().endsWith(adminEmail)), lines.join('\n'));
  assert.deepEqual(Object.keys(JSON.parse(await rf('internal', '--json'))), ['erp.corp.test', '10.1.2.3']);
  assert.equal((await call('GET', '/internal', undefined, sessionOf(await login(bob))!)).status, 403, 'admins alone');
  await assert.rejects(rf('internal', 'remove', 'other.corp.test'), fails(1, /other\.corp\.test isn't one admins let websites reach: they are erp\.corp\.test, 10\.1\.2\.3/));
  assert.match(await rf('internal', 'remove', 'erp.corp.test'), /^10\.1\.2\.3 /);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, '.rf', 'internal.json'), 'utf8'))), ['10.1.2.3']);
  const act = readFileSync(join(root, '.rf', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).findLast(a => a.op === 'internal');
  assert.deepEqual([act.by, act.hosts, act.let], [adminEmail, ['erp.corp.test'], false]);
  await rf('internal', 'remove', '10.1.2.3');
});
