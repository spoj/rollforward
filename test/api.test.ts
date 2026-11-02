import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const series = 'Weekly borrowing base', monthly = 'Monthly rec', renamed = 'Weekly BB';
const weeks = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 6, 5 + 7 * i)).toISOString().slice(0, 10));

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
  cpSync(join(app, 'demo', 'snapshot'), root, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch'), RF_SKILLS_DIR: join(app, 'test', 'skills') };
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
    ...weeks.map(w => [w, w === '2026-09-06' ? 'open' : 'closed']),
    ['scratch', 'abandoned'],
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

test("only the runner closes, as closing signs it off; taking over makes you the runner with your own logins ticked", async () => {
  const id = await iid(series, '2026-09-06'), offer = 'web:portal';
  const runner = async () => (await json(`/api/instances/${id}`)).runner;
  assert.deepEqual(await runner(), { by: 'alex', logins: [] }, 'whoever made it');
  assert.equal((await call('POST', await at(series, '2026-09-06', 'close'))).status, 403);
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
  for (const action of ['upload', 'steer', 'close', 'abandon'])
    assert.equal((await call('POST', `${await at(series, '2026-09-06', action)}?name=y.csv`, 'x')).status, 409, action);

  assert.equal((await call('POST', await at(series, '2026-09-13', 'abandon'))).status, 200);
  const ab = await json(await at(series, '2026-09-13'));
  assert.equal(ab.doc.status, 'abandoned');
  assert.equal(ab.log.at(-1).op, 'abandon');
});

test("series settings write series.json; a rename edits .rf/tree.json; a series' agent reads the rest of its workspace", async () => {
  const put = async (name: string, body: object) => call('PUT', await at(name), JSON.stringify(body));
  const id = (await shown(series)).id;
  assert.equal((await put(series, { skills: [] })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'series', id, 'series.json'), 'utf8')), { skills: [] });
  assert.deepEqual((await shown(monthly)).reads, ['larkfield / Ad hoc', `larkfield / ${series}`]);

  assert.equal((await put(series, { name: renamed })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(root, '.rf', 'tree.json'), 'utf8')).series[id].name, renamed);
  assert.equal((await shown(renamed)).id, id);
  assert.deepEqual((await shown(monthly)).reads, ['larkfield / Ad hoc', `larkfield / ${renamed}`]);

  assert.equal((await put(renamed, { name: monthly })).status, 409);
  assert.equal((await put(renamed, { name: series })).status, 200);
});

test('a workspace can be made; a workspace or a series is archived and restored, and a renamed series stays archived', async () => {
  const acme = () => named('Acme');
  const { id } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Acme' }))).json();
  const { series: made, ...rest } = await acme();
  assert.deepEqual(rest, { id, name: 'Acme', archived: false, owners: [adminEmail], members: [], manage: true });
  assert.deepEqual(made.map((s: { name: string; adhoc: boolean }) => [s.name, s.adhoc]), [['Ad hoc', true]], 'a workspace starts with its Ad hoc series');
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

test('files: uploads download as attachments; paths outside upload/ and working/ are refused', async () => {
  const id = await iid(series, '2026-08-30'), file = (rel: string) => `/files/${id}/${encodeURIComponent(rel)}`;
  const name = 'Larkfield AR aging 083026.xlsx';
  const r = await call('GET', file(`upload/${name}`));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition')!, /^attachment/);
  assert.ok((Buffer.from(await r.arrayBuffer())).equals(readFileSync(join(root, 'instances', id, 'upload', name))));
  for (const rel of ['upload/../../workspace.json', 'workspace.json', 'log.jsonl'])
    assert.equal((await call('GET', file(rel))).status, 400, rel);
  if (process.platform === 'win32') return;
  symlinkSync('/proc/self/environ', join(root, 'instances', id, 'working', 'env.txt'));
  assert.equal((await call('GET', file('working/env.txt'))).status, 400, 'a link out of the instance is refused');
});

test('a cross-site POST is refused, so another web page cannot steer the agent', async () => {
  const r = await fetch(base + await at(series, '2026-09-06', 'steer'), { method: 'POST', body: '{"text":"x"}', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('without a session the site shows Sign in with Microsoft; in the demo that leads to a picker of the two demo accounts', async () => {
  assert.equal((await fetch(base + '/api')).status, 401);
  assert.match(await (await fetch(base + '/')).text(), /href="\/auth\/login[^"]*">[\s\S]*Sign in with Microsoft/);
  assert.equal((await fetch(base + '/agent/workspace')).status, 401, "the agent API is only on the sandboxes' socket");
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

  const reads = async (ws: string, name: string) => (await named(ws)).series.find((s: { name: string }) => s.name === name).reads;
  assert.ok(!(await reads('larkfield', series)).includes('Acme Payroll / Payroll'), 'larkfield has bob by email, who Payroll has only by group');
  assert.equal((await people('Acme Payroll', { members: [] })).status, 200);
  assert.ok((await reads('Acme Payroll', 'Payroll')).includes(`larkfield / ${series}`), 'everyone in Payroll is in larkfield, so its agent reads larkfield');
  assert.ok(!(await reads('larkfield', series)).includes('Acme Payroll / Payroll'), 'never the reverse');

  assert.equal((await people('larkfield', { owners: [], members: [] })).status, 200);
  assert.equal((await call('GET', await at(series, '2026-08-30'), undefined, b)).status, 404);
  assert.deepEqual(await reads('larkfield', series), ['larkfield / Ad hoc', `larkfield / ${monthly}`], 'a workspace with no one in it reads only itself');
});

test('Skill use: admins set skills up once under Skills; a series only chooses which', async () => {
  const b = sessionOf(await login(bob))!;
  const report = (list: { id: string }[]) => list.find(s => s.id === 'mail-report') as Record<string, unknown>;
  assert.deepEqual(Object.keys(report(await json('/skills', b))).sort(), ['configured', 'description', 'id', 'name', 'uses'], 'anyone signed in sees the skills, not their settings');
  assert.equal((await call('PUT', '/skills/mail-report', JSON.stringify({ subject: 'Open AP report' }), b)).status, 403);
  assert.equal((await call('PUT', '/skills/mail-report', JSON.stringify({ mailbox: 'x' }))).status, 400, 'only the settings the skill declares');
  const set = await (await call('PUT', '/skills/mail-report', JSON.stringify({ subject: 'Open AP report' }))).json();
  assert.deepEqual([set.values, set.configured, set.uses], [{ subject: 'Open AP report' }, true, ["the runner's Microsoft 365 mail"]], "it reads the runner's own mail, so there's nothing more to set up");
  const site = await (await call('PUT', '/skills/portal', JSON.stringify({ url: 'https://portal.test/#/login', username: 'svc', password: 'Portal!pw' }))).json();
  assert.deepEqual([site.values, site.secrets, site.configured], [{ url: 'https://portal.test/#/login', username: 'svc' }, { password: true }, true], 'a password shows only as saved');
  assert.ok(!readFileSync(join(root, '.rf', 'skills.json'), 'utf8').includes('Portal!pw'));

  assert.deepEqual((await shown(series)).skills, []);
  const put = async (body: object) => call('PUT', await at(series), JSON.stringify(body));
  assert.equal((await put({ skills: ['nope'] })).status, 400);
  assert.equal((await put({ skills: ['mail-report', 'onedrive-report'] })).status, 200, 'a skill may be chosen before it is set up');
  assert.deepEqual((await shown(series)).skills, ['mail-report', 'onedrive-report']);
  assert.equal((await put({})).status, 200);
  assert.deepEqual((await shown(series)).skills, ['mail-report', 'onedrive-report'], 'a save without skills leaves Skill use as it was');
  assert.equal((await put({ skills: [] })).status, 200);
  assert.deepEqual((await shown(series)).skills, [], 'none, once a series has chosen');
});

test("people see and move a series' next wake, turn Allow wakes on as themselves, and start or dismiss requests; acts cancel a wake", async () => {
  const s = await shown(series), wakes = join(root, '.rf', 'wakes.json'), sep = await iid(series, '2026-08-30 rework');
  const due = new Date(Date.now() + 86_400_000).toISOString();
  writeFileSync(wakes, JSON.stringify({
    pending: { [s.id]: { at: due, reason: 'next week', from: 'larkfield/x/y', label: '2026-09-20' }, [sep]: { at: due, reason: 'late file', from: 'larkfield/x/y' } },
    fired: {}, requests: { r1: { series: s.id, label: '2026-09-27', reason: 'rec done', from: 'larkfield/Bank rec/2026-09', at: due } },
  }));
  const listed = await shown(series);
  assert.deepEqual([listed.wake.label, listed.requests.map((r: { id: string }) => r.id), listed.allow_wakes], ['2026-09-20', ['r1'], null]);
  assert.equal(listed.instances.find((i: { id: string }) => i.id === sep).wake, due);
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal((await (await call('PUT', `/api/wakes/${s.id}`, JSON.stringify({ at: later }))).json()).at, later);
  assert.equal((await call('POST', `${await at(series, '2026-08-30 rework', 'steer')}`, JSON.stringify({ text: 'go' }))).status, 200);
  assert.equal(JSON.parse(readFileSync(wakes, 'utf8')).pending[sep], undefined, "a person's act starts the run now, so the wake goes");

  assert.equal((await call('PUT', await at(series), JSON.stringify({ allow_wakes: true }))).status, 200);
  assert.equal((await shown(series)).allow_wakes, adminEmail);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'series', s.id, 'series.json'), 'utf8'))), ['skills', 'wakes']);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ skills: [] }))).status, 200);
  assert.equal((await shown(series)).allow_wakes, adminEmail, 'other settings leave Allow wakes as it was');

  const started = await call('POST', '/api/requests/r1');
  assert.equal(started.status, 200);
  const made = await json(`/api/instances/${(await started.json()).id}`);
  assert.deepEqual([made.log[0].by, made.log[1].op, made.log[1].reason], [adminEmail, 'wake', 'rec done']);
  assert.equal((await call('POST', await at(series), JSON.stringify({ label: 'third' }))).status, 200);
  assert.equal((await call('POST', await at(series), JSON.stringify({ label: 'fourth' }))).status, 409, '3 open already');
  assert.equal((await call('DELETE', `/api/wakes/${s.id}`)).status, 200);
  assert.equal((await shown(series)).wake, null);
  assert.equal((await call('PUT', await at(series), JSON.stringify({ allow_wakes: false }))).status, 200);
  for (const label of ['2026-09-27', 'third']) assert.equal((await call('POST', `${await at(series, label, 'abandon')}`)).status, 200);
});

test('each workspace has an Ad hoc series of one-off asks; Make it a series moves one into a series of its own', async () => {
  const { id } = await (await call('POST', '/api/workspaces', JSON.stringify({ name: 'Solo' }))).json();
  const adhoc = (await named('Solo')).series.find((s: { adhoc: boolean }) => s.adhoc);
  assert.equal(adhoc.name, 'Ad hoc');
  assert.equal((await call('PUT', `/api/series/${adhoc.id}`, JSON.stringify({ name: 'Mine' }))).status, 400);
  const ask = (await (await call('POST', `/api/series/${adhoc.id}`, JSON.stringify({ label: 'cash forecast' }))).json()).id;
  assert.equal((await json(`/api/instances/${ask}`)).log[0].from, null);
  await new Promise(r => setTimeout(r, 1700));
  assert.equal((await call('POST', `/api/instances/${ask}/promote`, JSON.stringify({ name: 'Cash forecast' }))).status, 200);
  const moved = (await named('Solo')).series.find((s: { name: string }) => s.name === 'Cash forecast');
  assert.deepEqual(moved.instances.map((i: { id: string }) => i.id), [ask]);
  assert.equal((await json(`/api/instances/${ask}`)).log.at(-1).op, 'promote');
  assert.equal((await call('POST', `/api/instances/${ask}/promote`, JSON.stringify({ name: 'Again' }))).status, 400);
  assert.ok(id);
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
