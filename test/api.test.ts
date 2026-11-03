import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { filesOf, standIns } from './push.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const series = 'Weekly borrowing base', monthly = 'Monthly rec', renamed = 'Weekly BB';

const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data');
let proc: ChildProcess, base: string, admin = '';
const adminEmail = 'admin@demo.test', bob = 'bob@demo.test';

const json = async (path: string, cookie = admin) => (await fetch(base + path, { headers: { cookie } })).json();
const call = (method: string, path: string, body?: BodyInit, cookie = admin) => fetch(base + path, { method, body, headers: { cookie } });
const authCli = (...args: string[]) => execFileSync(process.execPath, [join(app, 'src', 'auth.ts'), root, ...args], { encoding: 'utf8' });
const sessionOf = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0];
// Signs in the way the demo does: Sign in with Microsoft, then a click on a demo account in the picker.
const login = (email: string) => fetch(`${base}/auth/demo`, { method: 'POST', body: new URLSearchParams({ email, next: '/' }), redirect: 'manual' });
const workspaces = (cookie = admin) => json('/api', cookie);
const named = async (name: string) => (await workspaces()).find((w: { name: string }) => w.name === name);
const seriesList = async () => (await named('larkfield')).series;
const shown = async (name: string) => (await seriesList()).find((s: { name: string }) => s.name === name);
// Paths by id, found by name in larkfield: a series, or an instance and an action on it.
const iid = async (name: string, label: string) => (await shown(name)).instances.find((i: { label: string }) => i.label === label).id;
const at = async (name: string, label?: string, action?: string) => (label ? `/api/instances/${await iid(name, label)}${action ? `/${action}` : ''}` : `/api/series/${(await shown(name)).id}`);
const dir = async (name: string, label: string) => join(root, 'instances', await iid(name, label));
const create = async (name: string, label: string, cookie = admin) => call('POST', await at(name), JSON.stringify({ label }), cookie);

before(async () => {
  cpSync(join(app, 'test', 'fixture'), root, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch') };
  mkdirSync(env.HOME);
  delete env.OPENROUTER_API_KEY;
  const probe = createServer();
  await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  base = `http://127.0.0.1:${port}`;
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
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('GET /api lists the series and its instances with statuses', async () => {
  const s = await shown(series);
  assert.deepEqual(s.instances.map((i: { label: string; status: string }) => [i.label, i.status]), [
    ['2026-08-23', 'closed'], ['2026-08-30', 'closed'], ['2026-09-06', 'open'], ['scratch', 'abandoned'],
  ]);
});

test('a new instance starts from the last closed one; a new series can be made', async () => {
  assert.equal((await create(series, '2026-09-13')).status, 200);
  const { doc, log } = await json(await at(series, '2026-09-13'));
  const last = (await json(await at(series, '2026-08-30'))).doc;
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items.map((i: { id: string }) => i.id), last.items.map((i: { id: string }) => i.id));
  assert.ok(doc.items.every((i: { file: unknown }) => i.file === null));
  assert.equal(log[0].op, 'create');
  assert.equal(log[0].from, '2026-08-30');
  assert.equal(log[0].fetch, true, '08-30 fetched inputs, so the new instance starts a run at once');
  let done;
  for (let i = 0; !done && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    done = (await json(await at(series, '2026-09-13'))).log.find((e: { op: string }) => e.op === 'done');
  }
  assert.ok(done, 'the fetch run ended');

  const made = await call('POST', '/api/series', JSON.stringify({ workspace: (await named('larkfield')).id, name: monthly }));
  assert.equal(made.status, 200);
  assert.equal((await shown(monthly)).id, (await made.json()).id);
  assert.ok(existsSync(join(root, 'series', (await shown(monthly)).id)));
});

test('an upload lands read-only, becomes an item, and starts one run that ends with an error; a drop onto an item is only a hint', async () => {
  const bytes = 'a,b\n1,2\n', label = '2026-09-13';
  assert.equal((await create(monthly, label)).status, 200);
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

  let done;
  for (let i = 0; !done && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    done = (await json(await at(monthly, label))).log.find((e: { op: string }) => e.op === 'done');
  }
  assert.ok(done, 'run ended');
  assert.ok(done.error, 'no model reachable, so the run carries an error');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await json(await at(monthly, label))).log.filter((e: { op: string }) => e.op === 'run').length, 1, 'a run that never started is not retried');
});

test('an upload streams to disk as it arrives, and is refused if its instance closes meanwhile', async () => {
  const label = '2026-09-20';
  assert.equal((await create(monthly, label)).status, 200);
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

test('rename relabels an open instance in its instance.json and logs it; an existing label is refused', async () => {
  const rename = async (label: string, to: string) => call('POST', `${await at(series, label, 'rename')}?as=${encodeURIComponent(to)}`);
  const id = await iid(series, '2026-08-30 copy');
  assert.equal((await rename('2026-08-30 copy', '2026-08-30 rework')).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'instances', id, 'instance.json'), 'utf8')), { label: '2026-08-30 rework', series: (await shown(series)).id });
  assert.deepEqual((await json(await at(series, '2026-08-30 rework'))).log.at(-1).from, '2026-08-30 copy');
  assert.equal((await rename('2026-08-30 rework', '2026-09-06')).status, 409);
});

test("only the runner closes or abandons; taking over makes you the runner with your own logins ticked", async () => {
  const id = await iid(series, '2026-09-06'), offer = 'web:portal';
  const runner = async () => (await json(`/api/instances/${id}`)).runner;
  assert.deepEqual(await runner(), { by: 'alex', logins: [] }, 'whoever made it');
  assert.equal((await call('POST', await at(series, '2026-09-06', 'close'))).status, 403);
  assert.equal((await call('POST', await at(series, '2026-09-06', 'abandon'))).status, 403, 'nor abandons');
  assert.equal((await call('POST', await at(series, '2026-09-06', 'takeover'), JSON.stringify({ logins: [offer] }))).status, 400, 'not a login of yours');
  const { saveLogin } = await import('../src/logins.ts');
  const { initSystem } = await import('../src/system.ts');
  initSystem(root);
  saveLogin(adminEmail, { id: 'web', kind: 'website', name: 'Portal', since: new Date().toISOString(), offers: [{ id: offer, name: 'Portal' }] }, 'state');
  assert.deepEqual((await json('/logins')).map((l: { id: string }) => l.id), ['web']);
  assert.equal((await call('POST', await at(series, '2026-09-06', 'takeover'), JSON.stringify({ logins: [offer] }))).status, 200);
  assert.deepEqual(await runner(), { by: adminEmail, logins: [offer] });
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

test('a workspace can be made; a workspace or a series is archived and restored, and a renamed series stays archived', async () => {
  const acme = () => named('Acme');
  const { id } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Acme' }))).json();
  const { series: made, ...rest } = await acme();
  assert.deepEqual(rest, { id, name: 'Acme', archived: false, owners: [adminEmail], members: [], manage: true, agents: '', mine: true, reads: [], read_by: [] });
  assert.deepEqual(made, [], 'a workspace starts empty');
  assert.equal((await call('POST', '/api/workspaces', JSON.stringify({ name: 'Acme' }))).status, 409);
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ archived: true }))).status, 200);
  assert.equal((await acme()).archived, true);
  assert.equal((await call('PUT', `/api/workspaces/${id}`, JSON.stringify({ archived: false }))).status, 200);
  assert.equal((await acme()).archived, false);

  const put = async (name: string, to: string, archived: boolean) => call('PUT', await at(name), JSON.stringify({ name: to, archived }));
  assert.equal((await put(series, renamed, true)).status, 200);
  assert.equal((await shown(renamed)).archived, true);
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
  for (const rel of ['upload/../../workspace.json', '../x/log.jsonl', './log.jsonl'])
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

test('without a session the site shows Sign in with Microsoft; in the demo that leads to a picker of the two demo accounts', async () => {
  assert.equal((await fetch(base + '/api')).status, 401);
  assert.match(await (await fetch(base + '/')).text(), /href="\/auth\/login[^"]*">[\s\S]*Sign in with Microsoft/);
  assert.equal((await fetch(base + '/agent/graph', { method: 'POST' })).status, 401, "the agent API is only on the sandboxes' socket");
  assert.equal((await fetch(base + '/auth/login', { redirect: 'manual' })).headers.get('location'), '/auth/demo?next=%2F');
  const picker = await (await fetch(base + '/auth/demo')).text();
  assert.ok(picker.includes(adminEmail) && picker.includes(bob));
  assert.equal((await login('someone@else.test')).status, 400, 'only the demo accounts');
  assert.equal((await fetch(base + '/api', { headers: { cookie: admin.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) } })).status, 401, 'a tampered cookie is refused');
  const me = await json('/me');
  assert.deepEqual([me.email, me.role, me.sign_in], [adminEmail, 'admin', 'demo']);
  assert.equal((await fetch(base + '/auth/login', { redirect: 'manual', headers: { cookie: admin } })).headers.get('location'), '/', 'signed in already');
});

test("each person sees the workspaces they're in, by email or Entra group; owners and admins manage who is in", async () => {
  const b = sessionOf(await login(bob))!;
  const people = async (ws: string, body: object, cookie = admin) => call('PUT', `/api/workspaces/${(await named(ws)).id}`, JSON.stringify(body), cookie);
  const make = (name: string, cookie = admin) => call('POST', '/api/workspaces', JSON.stringify({ name }), cookie);
  assert.equal((await json('/me', b)).role, 'user');
  assert.deepEqual(await workspaces(b), []);
  assert.equal((await make('BobCo', b)).status, 200);
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

  const group = '0b8e5c8a-6d3e-4c21-9f2a-1d2e3f4a5b6c', users = join(root, '.rf', 'users.json');
  writeFileSync(users, JSON.stringify({ ...JSON.parse(readFileSync(users, 'utf8')), [bob]: { ...JSON.parse(readFileSync(users, 'utf8'))[bob], groups: [group] } }));
  assert.equal((await make('Acme Payroll')).status, 200);
  assert.equal((await call('POST', '/api/series', JSON.stringify({ workspace: (await named('Acme Payroll')).id, name: 'Payroll' }))).status, 200);
  assert.ok(!(await workspaces(b)).some((w: { name: string }) => w.name === 'Acme Payroll'));
  assert.equal((await people('Acme Payroll', { members: [group] })).status, 200);
  assert.ok((await workspaces(b)).some((w: { name: string }) => w.name === 'Acme Payroll'), 'through the Entra group');

  // Reach is the workspace's: its agents read workspaces that have everyone it has.
  const reads = async (ws: string) => (await named(ws)).reads;
  assert.ok(!(await reads('larkfield')).includes('Acme Payroll'), 'larkfield has bob by email, who Payroll has only by group');
  assert.equal((await people('Acme Payroll', { members: [] })).status, 200);
  assert.ok((await reads('Acme Payroll')).includes('larkfield'), 'everyone in Payroll is in larkfield, so its agents read larkfield');
  assert.ok(!(await reads('larkfield')).includes('Acme Payroll'), 'never the reverse');
  assert.ok((await named('larkfield')).read_by.includes('Acme Payroll'), "larkfield's owners see who reads it");

  assert.equal((await people('larkfield', { owners: [], members: [] })).status, 200);
  assert.equal((await call('GET', await at(series, '2026-08-30'), undefined, b)).status, 404);
  assert.deepEqual(await reads('larkfield'), [], 'a workspace with no one in it reads only itself');
});

test('everyone sees the skills, which every run loads; admins keep the websites, which everyone sees', async () => {
  const b = sessionOf(await login(bob))!;
  const report = (list: { id: string }[]) => list.find(s => s.id === 'mail-report') as Record<string, unknown>;
  assert.deepEqual(Object.keys(report(await json('/skills', b))).sort(), ['description', 'id', 'name', 'pushed'], 'anyone signed in sees the skills');
  assert.equal((await call('PUT', '/websites/portal', JSON.stringify({ url: 'https://portal.test/#/login' }), b)).status, 403);
  assert.equal((await call('PUT', '/websites/portal', JSON.stringify({ url: 'https://portal.test/#/login', hosts: 'cdn.portal.test' }))).status, 400, 'hosts are a list');
  const site = await (await call('PUT', '/websites/portal', JSON.stringify({ name: 'Portal', url: 'https://portal.test/#/login', hosts: ['cdn.portal.test'] }))).json();
  assert.deepEqual([site.name, site.url, site.hosts, site.updated_by], ['Portal', 'https://portal.test/#/login', ['cdn.portal.test'], adminEmail]);
  assert.deepEqual((await json('/websites', b)).map((w: { id: string }) => w.id), ['portal']);
  assert.equal((await call('DELETE', '/websites/portal')).status, 200);
  assert.deepEqual(await json('/websites', b), []);
});

test("people see and move a series' next wake, share it as themselves, and start or dismiss requests; acts cancel a wake", async () => {
  const s = await shown(series), wakes = join(root, '.rf', 'wakes.json'), sep = await iid(series, '2026-08-30 rework');
  const due = new Date(Date.now() + 86_400_000).toISOString();
  writeFileSync(wakes, JSON.stringify({
    pending: { [s.id]: { at: due, reason: 'next week', from: 'larkfield/x/y', label: '2026-09-20' }, [sep]: { at: due, reason: 'late file', from: 'larkfield/x/y' } },
    fired: {}, requests: { r1: { series: s.id, label: '2026-09-27', reason: 'rec done', from: 'larkfield/Bank rec/2026-09', at: due } },
  }));
  const listed = await shown(series);
  assert.deepEqual([listed.wake.label, listed.requests.map((r: { id: string }) => r.id), listed.shared_by], ['2026-09-20', ['r1'], null]);
  assert.equal(listed.instances.find((i: { id: string }) => i.id === sep).wake, due);
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal((await (await call('PUT', `/api/wakes/${s.id}`, JSON.stringify({ at: later }))).json()).at, later);
  const ws = `/api/workspaces/${(await named('larkfield')).id}`, b = sessionOf(await login(bob))!;
  assert.equal((await call('PUT', ws, JSON.stringify({ owners: [adminEmail], members: [bob] }))).status, 200);
  assert.equal((await call('POST', `${await at(series, '2026-08-30 rework', 'comment')}`, JSON.stringify({ text: 'fyi' }), b)).status, 200);
  assert.equal(JSON.parse(readFileSync(wakes, 'utf8')).pending[sep]?.at, due, "bob's note for the runner starts nothing, so the wake stays");
  assert.equal((await call('PUT', ws, JSON.stringify({ owners: [], members: [] }))).status, 200);
  assert.equal((await call('POST', `${await at(series, '2026-08-30 rework', 'comment')}`, JSON.stringify({ text: 'go' }))).status, 200);
  assert.equal(JSON.parse(readFileSync(wakes, 'utf8')).pending[sep], undefined, "a person's act starts the run now, so the wake goes");

  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: true }))).status, 200);
  assert.equal((await shown(series)).shared_by, adminEmail);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'series', s.id, 'series.json'), 'utf8'))), ['shared']);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ name: s.name }))).status, 200);
  assert.equal((await shown(series)).shared_by, adminEmail, 'other settings leave sharing as it was');

  const started = await call('POST', '/api/requests/r1');
  assert.equal(started.status, 200);
  const made = await json(`/api/instances/${(await started.json()).id}`);
  assert.deepEqual([made.log[0].by, made.log[1].op, made.log[1].reason], [adminEmail, 'wake', 'rec done']);
  assert.equal((await call('POST', await at(series), JSON.stringify({ label: 'third' }))).status, 200);
  assert.equal((await call('POST', await at(series), JSON.stringify({ label: 'fourth' }))).status, 409, '3 open already');
  assert.equal((await call('DELETE', `/api/wakes/${s.id}`)).status, 200);
  assert.equal((await shown(series)).wake, null);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ share: false }))).status, 200);
  for (const label of ['2026-09-27', 'third']) assert.equal((await call('POST', `${await at(series, label, 'abandon')}`)).status, 200);
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
  assert.equal((await json(`/api/instances/${next}`)).log[0].from, 'Cash forecast', 'the next instance rolls forward from the first');
  assert.equal((await call('POST', `/api/series/${one.id}/promote`, JSON.stringify({ name: 'Again' }))).status, 400);
});

test('an admin can disable someone, which ends their sessions and stops their sign-in; the CLI does the same', async () => {
  const b = sessionOf(await login(bob))!;
  assert.deepEqual((await json('/users')).find((u: { email: string }) => u.email === bob).workspaces, ['BobCo']);
  assert.equal((await call('PUT', `/users/${encodeURIComponent(adminEmail)}`, JSON.stringify({ disabled: true }))).status, 409, 'an admin cannot lock themselves out');
  assert.equal((await call('PUT', `/users/${encodeURIComponent(bob)}`, JSON.stringify({ disabled: true }))).status, 200);
  assert.equal((await call('GET', '/api', undefined, b)).status, 401);
  assert.equal((await login(bob)).status, 403);
  authCli('enable', bob);
  const again = sessionOf(await login(bob))!;
  assert.equal((await call('GET', '/api', undefined, again)).status, 200);
  authCli('signout', bob);
  assert.equal((await call('GET', '/api', undefined, again)).status, 401);
  assert.match(authCli('list'), new RegExp(`^${bob}\\tuser`, 'm'));
});

test('talking is in threads: a comment starts one on an item or the instance, the agent says in it, and a person resolves it', async () => {
  assert.equal((await call('POST', `${await at(series, '2026-08-30', 'duplicate')}?as=talk`)).status, 200);
  const path = await at(series, 'talk');
  const inst = await json(path), item = inst.doc.items[0].id;
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ item, ref: 'B4', text: 'Why is this up?' }))).status, 200);
  const started = (await json(path)).log.at(-1);
  assert.deepEqual([started.op, started.item, started.ref, started.text], ['comment', item, 'B4', 'Why is this up?']);
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: started.thread, text: 'And B5?' }))).status, 200);
  assert.equal((await json(path)).log.at(-1).item, undefined, 'a reply keeps its thread, not an item');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: 'nope', text: 'x' }))).status, 400);
  const { file } = await (await call('POST', `${path}/attach?name=list.csv`, 'a,b')).json();
  assert.equal(file, 'upload/attachments/list.csv');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ thread: started.thread, text: 'The list', files: [file] }))).status, 200);
  assert.deepEqual((await json(path)).log.at(-1).files, [file], 'a comment names its attachments');
  assert.equal((await call('POST', `${path}/comment`, JSON.stringify({ text: 'x', files: ['upload/../x'] }))).status, 400);
  assert.equal((await call('POST', `${path}/resolve`, JSON.stringify({ thread: started.thread }))).status, 200);
  assert.equal((await json(path)).log.at(-1).op, 'resolve');
});

test('skills are pushed by publishers and admins, each push a version live at once, and rolled back by pushing an earlier one', async () => {
  const b = sessionOf(await login(bob))!, push = (files: object, cookie = admin) => call('POST', '/skills/tool/versions', JSON.stringify(files), cookie);
  assert.equal((await push({ files: filesOf(join(standIns, 'tool')) }, b)).status, 403, 'a user may not push');
  authCli('role', bob, 'publisher');
  const changed = { ...filesOf(join(standIns, 'tool')), 'SKILL.md': Buffer.from('---\nname: tool\ndescription: the second\n---\n').toString('base64') };
  assert.equal(await (await push({ files: changed }, b)).text(), 'pushed tool version 2, live now');
  const live = async () => (await json('/skills')).find((x: { id: string }) => x.id === 'tool');
  assert.deepEqual([(await live()).description, (await live()).pushed.version, (await live()).pushed.by], ['the second', 2, bob]);
  assert.equal(await (await push({ from: 1 })).text(), 'pushed tool version 3, live now');
  assert.notEqual((await live()).description, 'the second', 'version 3 is version 1 again');
  assert.deepEqual((await json('/skills/tool/versions')).map((v: { version: number }) => v.version), [1, 2, 3]);
  assert.equal((await push({ files: { '../x': 'eA==', 'SKILL.md': 'eA==' } })).status, 400);
  authCli('role', bob, 'user');
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

test('rf for people: ls, comment, pull as rsync does, runs, costs and status, and admins manage people and the brand from it', async () => {
  const { token } = await (await call('POST', '/tokens', JSON.stringify({ name: 'cli', days: 1 }))).json();
  const home = join(tmp, 'cli-home');
  mkdirSync(home);
  const rf = (...args: string[]) => new Promise<string>((ok, fail) => {
    const p = spawn(process.execPath, [join(app, 'src', 'rf-people.ts'), ...args], { env: { ...process.env, HOME: home } });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('exit', code => (code ? fail(new Error(out)) : ok(out)));
  });
  assert.equal((await rf('login', base, token)).trim(), `signed in as ${adminEmail}`);
  const asToken = (method: string, path: string, body?: string) => fetch(base + path, { method, body, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await asToken('POST', '/tokens', JSON.stringify({ name: 'more', days: 90 }))).status, 403, 'a token makes no tokens');
  assert.equal((await asToken('DELETE', '/tokens/x')).status, 403);
  assert.equal((await call('POST', '/tokens', JSON.stringify({ name: 'long', days: 365 }))).status, 400, 'at most 90 days');
  assert.match(await rf('ls'), /^larkfield\/Weekly borrowing base\/2026-08-30  closed/m);
  await rf('comment', `larkfield/${series}/talk`, 'From the shell');
  const pulled = join(tmp, 'pulled'), week = `larkfield/${series}/2026-08-30`;
  assert.match(await rf('pull', '/', pulled), /^new  larkfield\/AGENTS\.md$/m);
  assert.deepEqual(['', 'larkfield'].map(d => readFileSync(join(pulled, d, 'AGENTS.md'), 'utf8')), ['Fiscal months end on the last Saturday.', 'Larkfield Ltd is now Larkfield Holdings.']);
  assert.ok(['workspace.json', 'log.jsonl', 'session/main.jsonl', 'upload/Larkfield AR aging 083026.csv'].every(f => existsSync(join(pulled, week, f))), 'the folders as runs see them');
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
  assert.equal((await json(await at(series, 'talk'))).log.findLast((e: { op: string }) => e.op === 'comment').text, 'From the shell');
  const runs = JSON.parse(await rf('runs', `larkfield/${series}`, '--json'));
  assert.ok(runs.every((r: { path: string }) => r.path.startsWith(`larkfield/${series}/`)));
  assert.deepEqual(runs[0], { path: `larkfield/${series}/2026-08-23`, run: 1, at: '2026-08-23T23:01:00.000Z', outcome: 'done', seconds: 240, cost: 0.21, runner: 'alex', started: { op: 'upload', by: 'alex' }, summary: 'Borrowing base for 08-23: excess 173,800.', error: null });
  assert.match(await rf('runs', '--failed'), /  run \d+  failed  \d+[sm]  \$0\.00  (upload|comment|create|wake) by \S+  /, 'without a model key, the runs the tests start fail');
  assert.match(await rf('costs', '--by', 'person'), /^ +\$\d+\.\d\d +\d+ runs +\$\d+\.\d\d a run  alex$/m);
  assert.deepEqual(Object.keys(JSON.parse(await rf('status', '--json'))), ['running', 'queued', 'asks', 'expired', 'requests', 'failed']);
  assert.match(await rf('status'), /^Last run failed \(\d+\)\n  larkfield\//m);

  await rf('user', 'add', 'carol@demo.test', 'publisher');
  assert.match(await rf('people'), /^publisher carol@demo\.test +# never in; in none$/m);
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

  // Bob runs an instance in a workspace, so taking him out of it, or his admin role when he isn't in it, is refused unless forced.
  await call('POST', '/api/workspaces', JSON.stringify({ name: 'Guarded' }));
  const file = join(tmp, 'people.txt'), b = sessionOf(await login(bob))!;
  writeFileSync(file, `owner ${adminEmail}\nmember ${bob}  # he runs one\n`);
  assert.match(await rf('people', 'Guarded', '--set', file), /^\+ member bob@demo\.test\nsaved$/m);
  const { id: weekly } = await (await call('POST', '/api/series', JSON.stringify({ workspace: (await named('Guarded')).id, name: 'Weekly' }))).json();
  assert.equal((await call('POST', `/api/series/${weekly}`, JSON.stringify({ label: 'one' }), b)).status, 200);
  assert.match(await rf('people', 'Guarded'), /^member +bob@demo\.test +# last in [\d-]+ [\d:]+; runs Weekly\/one$/m);
  writeFileSync(file, `owner ${adminEmail}\n`);
  assert.match(await rf('people', 'Guarded', '--set', file, '-n'), /^- member bob@demo\.test$/m);
  await assert.rejects(rf('people', 'Guarded', '--set', file), /hide open instances from the people who run them.*Guarded\/Weekly\/one, run by bob@demo\.test/);
  assert.equal((await named('Guarded')).members.length, 1, 'refused, it changed nothing');
  assert.match(await rf('people', 'Guarded', '--set', file, '--force'), /saved/);
  assert.match(await rf('people'), /^user +bob@demo\.test +# last in .*; runs outside them: Guarded\/Weekly\/one$/m);
  await rf('user', 'role', bob, 'admin');
  writeFileSync(file, `user ${bob}\n`);
  await assert.rejects(rf('people', '--set', file), /Guarded\/Weekly\/one, run by bob@demo\.test/);
  assert.match(await rf('people', '--set', file, '--force'), /^bob@demo\.test: admin -> user\nsaved$/m);
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

test('the second audit: a bad request line, a bad workbook and a slow body hurt nothing; a token makes tokens for no one', async () => {
  const { connect } = await import('node:net'), { request } = await import('node:http');
  const raw = connect(Number(new URL(base).port), '127.0.0.1');
  raw.end('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
  await Promise.race([once(raw, 'data'), once(raw, 'close')]);
  raw.destroy();
  const bad = join(await dir(series, '2026-08-30'), 'working', 'bad.xlsx');
  writeFileSync(bad, 'not a workbook');
  assert.equal((await call('GET', `/preview/${await iid(series, '2026-08-30')}/working/bad.xlsx`)).status, 500);
  rmSync(bad);
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

test('closing refuses a shown file the agent replaced after it was shown', async () => {
  assert.equal((await call('POST', `${await at(series, '2026-08-30', 'duplicate')}?as=tamper`)).status, 200);
  const d = await dir(series, 'tamper'), doc = JSON.parse(readFileSync(join(d, 'workspace.json'), 'utf8'));
  const shownFile = doc.items.find((i: { file: string | null }) => i.file?.startsWith('working/')).file, was = readFileSync(join(d, shownFile));
  writeFileSync(join(d, 'working', 'swap.tmp'), 'other bytes');
  renameSync(join(d, 'working', 'swap.tmp'), join(d, shownFile));
  const r = await call('POST', await at(series, 'tamper', 'close'));
  assert.equal(r.status, 409);
  assert.match(await r.text(), /changed after it was shown/);
  writeFileSync(join(d, 'working', 'swap.tmp'), was);
  renameSync(join(d, 'working', 'swap.tmp'), join(d, shownFile));
  assert.equal((await call('POST', await at(series, 'tamper', 'close'))).status, 200);
});

// Last: a drained server starts no more runs.
test('an update drains the server: GET /drained answers 200 once no run is going', async () => {
  assert.equal((await fetch(base + '/drained')).status, 503);
  process.kill(proc.pid!, 'SIGUSR2');
  for (let i = 0; i < 50 && (await fetch(base + '/drained')).status !== 200; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await fetch(base + '/drained')).status, 200);
});
