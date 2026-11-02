import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
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

const at = (...parts: string[]) => `/api/larkfield/${parts.map(encodeURIComponent).join('/')}`;
const json = async (path: string, cookie = admin) => (await fetch(base + path, { headers: { cookie } })).json();
const call = (method: string, path: string, body?: BodyInit, cookie = admin) => fetch(base + path, { method, body, headers: { cookie } });
const authCli = (...args: string[]) => execFileSync(process.execPath, [join(app, 'src', 'auth.ts'), root, ...args], { encoding: 'utf8' });
const sessionOf = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0];
// Signs in the way the demo does: Sign in with Microsoft, then a click on a demo account in the picker.
const login = (email: string) => fetch(`${base}/auth/demo`, { method: 'POST', body: new URLSearchParams({ email, next: '/' }), redirect: 'manual' });
const workspaces = (cookie = admin) => json('/api', cookie);
const seriesList = async () => (await workspaces()).find((w: { workspace: string }) => w.workspace === 'larkfield').series;
const shown = async (name: string) => (await seriesList()).find((s: { series: string }) => s.series === name);

before(async () => {
  cpSync(join(app, 'demo', 'snapshot'), root, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SKILLS_DIR: join(app, 'test', 'skills') };
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
  const s = (await seriesList()).find((x: { series: string }) => x.series === series);
  assert.deepEqual(s.instances.map((i: { label: string; status: string }) => [i.label, i.status]), [
    ...weeks.map(w => [w, w === '2026-09-06' ? 'open' : 'closed']),
    ['scratch', 'abandoned'],
  ]);
});

test('a new instance starts from the last closed one; a new series can be made', async () => {
  assert.equal((await call('POST', at(series, '2026-09-13'))).status, 200);
  const { doc, log } = await json(at(series, '2026-09-13'));
  const last = (await json(at(series, '2026-08-30'))).doc;
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items.map((i: { id: string }) => i.id), last.items.map((i: { id: string }) => i.id));
  assert.ok(doc.items.every((i: { file: unknown }) => i.file === null));
  assert.equal(log[0].op, 'create');
  assert.equal(log[0].from, '2026-08-30');
  assert.equal(log[0].fetch, true, '08-30 fetched inputs, so the new instance starts a run at once');
  let done;
  for (let i = 0; !done && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    done = (await json(at(series, '2026-09-13'))).log.find((e: { op: string }) => e.op === 'done');
  }
  assert.ok(done, 'the fetch run ended');

  assert.equal((await call('POST', at(monthly))).status, 200);
  assert.ok(await shown(monthly));
});

test('an upload lands read-only, becomes an item, and starts one run that ends with an error; a drop onto an item is only a hint', async () => {
  const bytes = 'a,b\n1,2\n', label = '2026-09-13';
  assert.equal((await call('POST', at(monthly, label))).status, 200);
  assert.equal((await call('POST', `${at(monthly, label, 'upload')}?by=t&pane=in&name=x.csv`, bytes)).status, 200);
  const file = join(root, 'larkfield', monthly, label, 'upload', 'x.csv');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mode & 0o222, 0);
  const first = await json(at(monthly, label));
  assert.deepEqual(first.log.slice(-2).map((e: { op: string }) => e.op), ['upload', 'point']);
  assert.equal(first.log.at(-2).sha256, createHash('sha256').update(bytes).digest('hex'));
  const x = first.doc.items.find((i: { file: string; kind: string }) => i.file === 'upload/x.csv' && i.kind === 'input');
  assert.ok(x);
  assert.equal((await call('POST', `${at(monthly, label, 'upload')}?by=t&pane=in&name=x.csv&onto=${x.id}`, 'a,b\n1,3\n')).status, 200);
  const second = await json(at(monthly, label));
  assert.equal(second.log.at(-2).onto, x.id);
  assert.equal(second.doc.items.find((i: { id: string }) => i.id === x.id).file, 'upload/x.csv', 'the agent decides what a drop replaces');
  assert.ok(second.doc.items.some((i: { file: string }) => i.file === 'upload/x_2.csv'));

  let done;
  for (let i = 0; !done && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    done = (await json(at(monthly, label))).log.find((e: { op: string }) => e.op === 'done');
  }
  assert.ok(done, 'run ended');
  assert.ok(done.error, 'no model reachable, so the run carries an error');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await json(at(monthly, label))).log.filter((e: { op: string }) => e.op === 'run').length, 1, 'a run that never started is not retried');
});

test('an upload streams to disk as it arrives, and is refused if its instance closes meanwhile', async () => {
  const label = '2026-09-20';
  assert.equal((await call('POST', at(monthly, label))).status, 200);
  let release!: () => void, sent = false;
  const held = new Promise<void>(ok => { release = ok; });
  const body = new ReadableStream({ async pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(1 << 20)); } else { await held; c.close(); } } });
  const upload = fetch(`${base}${at(monthly, label, 'upload')}?pane=in&name=big.bin`, { method: 'POST', body, duplex: 'half', headers: { cookie: admin } } as RequestInit);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(readdirSync(join(root, '.tmp')).length, 1, 'the body is being written before it has all arrived');
  assert.equal((await call('POST', at(monthly, label, 'close'))).status, 200);
  release();
  assert.equal((await upload).status, 409);
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
  assert.ok(!existsSync(join(root, 'larkfield', monthly, label, 'upload', 'big.bin')));
});

test('duplicate copies a closed instance into an open one, once', async () => {
  assert.equal((await call('POST', `${at(series, '2026-09-06', 'duplicate')}?as=x`)).status, 409);
  const copyPath = at(series, '2026-08-30 copy');
  const dup = `${at(series, '2026-08-30', 'duplicate')}?as=${encodeURIComponent('2026-08-30 copy')}`;
  assert.equal((await call('POST', dup)).status, 200);
  const { doc, log } = await json(copyPath);
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items, (await json(at(series, '2026-08-30'))).doc.items);
  assert.equal(existsSync(join(root, 'larkfield', series, '2026-08-30 copy', 'session')), false);
  assert.equal(log.at(-1).op, 'duplicate');
  assert.equal(log.at(-1).from, '2026-08-30');
  assert.equal((await call('POST', dup)).status, 409);
});

test('rename moves an open instance and logs it; an existing label is refused', async () => {
  const rename = (label: string, to: string) => call('POST', `${at(series, label, 'rename')}?as=${encodeURIComponent(to)}`);
  assert.equal((await rename('2026-08-30 copy', '2026-08-30 rework')).status, 200);
  assert.equal(existsSync(join(root, 'larkfield', series, '2026-08-30 copy')), false);
  assert.deepEqual((await json(at(series, '2026-08-30 rework'))).log.at(-1).from, '2026-08-30 copy');
  assert.equal((await rename('2026-08-30 rework', '2026-09-06')).status, 409);
});

test('close and abandon end an open instance; a closed one takes no actions', async () => {
  assert.equal((await call('POST', at(series, '2026-09-06', 'close'))).status, 200);
  const closed = await json(at(series, '2026-09-06'));
  assert.equal(closed.doc.status, 'closed');
  assert.equal(closed.log.at(-1).op, 'close');
  for (const action of ['upload', 'steer', 'close', 'abandon'])
    assert.equal((await call('POST', `${at(series, '2026-09-06', action)}?name=y.csv`, 'x')).status, 409, action);

  assert.equal((await call('POST', at(series, '2026-09-13', 'abandon'))).status, 200);
  const ab = await json(at(series, '2026-09-13'));
  assert.equal(ab.doc.status, 'abandoned');
  assert.equal(ab.log.at(-1).op, 'abandon');
});

test('series settings write series.json; a rename moves the folder and rewrites readers', async () => {
  const put = (name: string, body: object) => call('PUT', at(name), JSON.stringify(body));
  assert.equal((await put(monthly, { name: monthly, visible_to: [series] })).status, 200);
  assert.equal((await put(series, { name: series, visible_to: [monthly] })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'larkfield', series, 'series.json'), 'utf8')), { visible_to: [monthly], skills: [] });
  assert.deepEqual((await shown(series)).visible_to, [monthly]);
  assert.deepEqual((await shown(monthly)).reads, [series]);

  assert.equal((await put(series, { name: renamed, visible_to: [monthly] })).status, 200);
  assert.ok(existsSync(join(root, 'larkfield', renamed, '2026-08-30')));
  assert.ok(!existsSync(join(root, 'larkfield', series)));
  const sessions = globSync('*/session/*.jsonl', { cwd: join(root, 'larkfield', renamed) });
  assert.ok(sessions.length);
  for (const f of sessions) assert.equal(JSON.parse(readFileSync(join(root, 'larkfield', renamed, f), 'utf8').split('\n')[0]).cwd, join(root, 'larkfield', renamed), 'Pi finds a session only under the folder it recorded');
  assert.deepEqual((await shown(monthly)).visible_to, [renamed]);
  assert.deepEqual((await shown(monthly)).reads, [renamed]);

  assert.equal((await put(renamed, { name: monthly, visible_to: [] })).status, 409);
  assert.equal((await put(renamed, { name: series, visible_to: [monthly] })).status, 200);
});

test('a workspace can be made; a workspace or a series is archived and restored, and a renamed series stays archived', async () => {
  const acme = async () => (await workspaces()).find((w: { workspace: string }) => w.workspace === 'Acme');
  assert.equal((await call('POST', '/api/Acme')).status, 200);
  assert.deepEqual(await acme(), { workspace: 'Acme', archived: false, owner: adminEmail, series: [] });
  assert.equal((await call('PUT', '/api/Acme', JSON.stringify({ archived: true }))).status, 200);
  assert.equal((await acme()).archived, true);
  assert.equal((await call('PUT', '/api/Acme', JSON.stringify({ archived: false }))).status, 200);
  assert.equal((await acme()).archived, false);

  const put = (name: string, to: string, archived: boolean) => call('PUT', at(name), JSON.stringify({ name: to, visible_to: [monthly], archived }));
  assert.equal((await put(series, renamed, true)).status, 200);
  assert.equal((await shown(renamed)).archived, true);
  assert.equal((await put(renamed, series, false)).status, 200);
  assert.equal((await shown(series)).archived, false);
});

test('files: uploads download as attachments; paths outside upload/ and working/ are refused', async () => {
  const file = (rel: string) => `/files/larkfield/${encodeURIComponent(series)}/2026-08-30/${encodeURIComponent(rel)}`;
  const name = 'Larkfield AR aging 083026.xlsx';
  const r = await call('GET', file(`upload/${name}`));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition')!, /^attachment/);
  assert.ok((Buffer.from(await r.arrayBuffer())).equals(readFileSync(join(root, 'larkfield', series, '2026-08-30', 'upload', name))));
  for (const rel of ['upload/../../workspace.json', 'workspace.json', 'log.jsonl'])
    assert.equal((await call('GET', file(rel))).status, 400, rel);
  if (process.platform === 'win32') return;
  symlinkSync('/proc/self/environ', join(root, 'larkfield', series, '2026-08-30', 'working', 'env.txt'));
  assert.equal((await call('GET', file('working/env.txt'))).status, 400, 'a link out of the instance is refused');
});

test('a cross-site POST is refused, so another web page cannot steer the agent', async () => {
  const r = await fetch(base + at(series, '2026-09-06', 'steer'), { method: 'POST', body: '{"text":"x"}', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('without a session the site shows Sign in with Microsoft; in the demo that leads to a picker of the two demo accounts', async () => {
  assert.equal((await fetch(base + '/api')).status, 401);
  assert.match(await (await fetch(base + '/')).text(), /href="\/auth\/login[^"]*">[\s\S]*Sign in with Microsoft/);
  assert.equal(await (await fetch(base + '/agent/workspace')).text(), 'no run for this token', 'the agent API takes its run token instead');
  assert.equal((await fetch(base + '/auth/login', { redirect: 'manual' })).headers.get('location'), '/auth/demo?next=%2F');
  const picker = await (await fetch(base + '/auth/demo')).text();
  assert.ok(picker.includes(adminEmail) && picker.includes(bob));
  assert.equal((await login('someone@else.test')).status, 400, 'only the demo accounts');
  assert.equal((await fetch(base + '/api', { headers: { cookie: admin.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) } })).status, 401, 'a tampered cookie is refused');
  const me = await json('/me');
  assert.deepEqual([me.email, me.role, me.sign_in], [adminEmail, 'admin', 'demo']);
  assert.equal((await fetch(base + '/auth/login', { redirect: 'manual', headers: { cookie: admin } })).headers.get('location'), '/', 'signed in already');
});

test('each person sees only the workspaces they own; an admin sees all and can give one to someone', async () => {
  const b = sessionOf(await login(bob))!;
  assert.equal((await json('/me', b)).role, 'user');
  assert.deepEqual(await workspaces(b), []);
  assert.equal((await call('POST', '/api/BobCo', undefined, b)).status, 200);
  assert.deepEqual((await workspaces(b)).map((w: { workspace: string }) => w.workspace), ['BobCo']);
  for (const path of [at(series, '2026-08-30'), at(series), `/files/larkfield/${encodeURIComponent(series)}/2026-08-30/upload/x`])
    assert.equal((await call('GET', path, undefined, b)).status, 404, path);
  assert.equal((await call('POST', at(series, '2026-12-31'), undefined, b)).status, 404);
  assert.equal((await call('POST', '/api/larkfield', undefined, b)).status, 409, 'a name in use elsewhere is taken');
  assert.equal((await call('PUT', '/api/BobCo', JSON.stringify({ owner: bob }), b)).status, 403, 'only an admin gives workspaces away');
  assert.equal((await call('GET', '/users', undefined, b)).status, 403);
  assert.ok((await workspaces()).some((w: { workspace: string; owner: string }) => w.workspace === 'BobCo' && w.owner === bob), 'an admin sees every workspace');

  assert.equal((await call('PUT', '/api/larkfield', JSON.stringify({ owner: bob }))).status, 200);
  assert.equal((await call('GET', at(series, '2026-08-30'), undefined, b)).status, 200);
  assert.equal((await call('PUT', '/api/larkfield', JSON.stringify({ owner: null }))).status, 200);
  assert.equal((await call('GET', at(series, '2026-08-30'), undefined, b)).status, 404);
});

test('Systems holds the two Microsoft 365 connections, for admins: saved in part, the secret sealed', async () => {
  const b = sessionOf(await login(bob))!;
  assert.equal((await call('GET', '/systems', undefined, b)).status, 403, 'series do not choose connections, so only admins see them');
  assert.deepEqual((await json('/systems')).map((s: { id: string; configured: boolean }) => [s.id, s.configured]), [['m365-mail', false], ['m365-files', false]]);
  const app = { tenant: '00000000-0000-0000-0000-000000000001', client_id: '00000000-0000-0000-0000-000000000002', settings: { mailbox: 'ap@demo.test' } };
  assert.equal((await call('PUT', '/systems/m365-mail', JSON.stringify(app), b)).status, 403);
  assert.equal((await call('PUT', '/systems/m365-mail', JSON.stringify({ ...app, tenant: 'not-a-guid' }))).status, 400);
  assert.equal((await call('PUT', '/systems/m365-mail', JSON.stringify(app))).status, 200, 'saved part done, without its secret');
  assert.equal((await json('/systems'))[0].configured, false);
  const made = await (await call('PUT', '/systems/m365-mail', JSON.stringify({ ...app, password: 'S3cret!' }))).json();
  assert.deepEqual([made.id, made.has_password, 'password' in made], ['m365-mail', true, false]);
  assert.equal((await json('/systems'))[0].configured, true);
  assert.ok(!readFileSync(join(root, '.rf', 'systems.json'), 'utf8').includes('S3cret!'));
  assert.notEqual((await call('PUT', '/systems/portal', JSON.stringify({ url: 'http://127.0.0.1:9/' }))).status, 200, 'websites are skills now, not connections');
  assert.equal((await call('DELETE', '/systems/m365-mail')).status, 200);
  assert.equal((await json('/systems'))[0].configured, false, 'clearing it leaves it on the list, not set up');
});

test('Skill use: admins set skills up once under Skills; a series only chooses which; one saved before Skill use has none', async () => {
  const b = sessionOf(await login(bob))!;
  const report = (list: { id: string }[]) => list.find(s => s.id === 'mail-report') as Record<string, unknown>;
  assert.deepEqual(Object.keys(report(await json('/skills', b))).sort(), ['configured', 'description', 'id', 'name', 'uses'], 'anyone signed in sees the skills, not their settings');
  assert.equal((await call('PUT', '/skills/mail-report', JSON.stringify({ subject: 'Open AP report' }), b)).status, 403);
  assert.equal((await call('PUT', '/skills/mail-report', JSON.stringify({ mailbox: 'x' }))).status, 400, 'only the settings the skill declares');
  const set = await (await call('PUT', '/skills/mail-report', JSON.stringify({ subject: 'Open AP report' }))).json();
  assert.deepEqual([set.values, set.configured, set.missing], [{ subject: 'Open AP report' }, false, ['M365 Mail set up under Systems']], 'it reads through M365 Mail, which is not set up');
  assert.equal((await call('POST', '/skills/mail-report/test')).status, 409);
  const site = await (await call('PUT', '/skills/portal', JSON.stringify({ url: 'https://portal.test/#/login', username: 'svc', password: 'Portal!pw' }))).json();
  assert.deepEqual([site.values, site.secrets, site.configured], [{ url: 'https://portal.test/#/login', username: 'svc' }, { password: true }, true], 'a password shows only as saved');
  assert.ok(!readFileSync(join(root, '.rf', 'skills.json'), 'utf8').includes('Portal!pw'));

  assert.deepEqual((await shown(series)).skills, [], 'as a series saved before Skill use has it');
  const put = (body: object) => call('PUT', at(series), JSON.stringify({ name: series, visible_to: [], ...body }));
  assert.equal((await put({ skills: ['nope'] })).status, 400);
  assert.equal((await put({ skills: ['mail-report', 'onedrive-report'] })).status, 200, 'a skill may be chosen before it is set up');
  assert.deepEqual((await shown(series)).skills, ['mail-report', 'onedrive-report']);
  assert.equal((await put({ visible_to: ['*'] })).status, 200);
  assert.deepEqual((await shown(series)).skills, ['mail-report', 'onedrive-report'], 'Visibility alone leaves Skill use as it was');
  assert.equal((await put({ skills: [] })).status, 200);
  assert.deepEqual((await shown(series)).skills, [], 'none, once a series has chosen');
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
