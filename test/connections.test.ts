import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Instance } from '../src/store.ts';
import type { AgentRun } from '../src/agent-api.ts';

// A stand-in for Microsoft's sign-in and Graph: a SharePoint library with a folder of years of reports, the runner's OneDrive,
// someone else's OneDrive, and two mailboxes. rf graph is called as a run's agent calls it, through its runner's Microsoft 365 login.
const ALICE = 'alice@demo.test', AP = 'ap@demo.test';
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-conn-')), seriesDir = join(tmp, 'series', 'weekly'), instDir = join(tmp, 'instances', 'w1');
const methods: string[] = [], log: { op: string; data: any }[] = [];
let graph: Server, refreshes = 0;

const item = (id: string, name: string, modified: string, folder = false, where = { driveId: 'b!d1', driveType: 'documentLibrary', siteId: 'host,site1,web1' }) =>
  ({ id, name, lastModifiedDateTime: modified, parentReference: { ...where, id: 'top' }, ...(folder ? { folder: {} } : { file: {} }) });
const shares: Record<string, ReturnType<typeof item>> = {
  'https://share.test/reports': item('y2026', '2026', '2026-01-02T00:00:00Z', true),
  'https://share.test/mine': item('mine', 'mine.csv', '2026-10-20T00:00:00Z', false, { driveId: 'b!own', driveType: 'business', siteId: 'host,personal,alice' }),
  'https://share.test/bobs': item('bobs', 'bobs.csv', '2026-10-20T00:00:00Z', false, { driveId: 'b!bob', driveType: 'business', siteId: 'host,personal,bob' }),
};
const folders: Record<string, ReturnType<typeof item>[]> = {
  top: [item('y2026', '2026', '2026-01-02T00:00:00Z', true), item('y2025', '2025', '2025-01-02T00:00:00Z', true)],
  y2026: [item('a', 'AGING_A_1.csv', '2026-10-20T12:00:00Z'), item('b', 'AGING_B_2.csv', '2026-10-20T12:30:00Z'), item('c', 'AGING_A_0.csv', '2026-10-19T12:00:00Z')],
};
const content: Record<string, string> = { a: 'As-Of Date,10/20/2026\nCustomer,Open\nAcme,10\n' };
const drives: Record<string, { siteUrl: string; siteId: string; webId: string }> = {
  'b!d1': { siteUrl: 'https://host/sites/reports', siteId: 'site1', webId: 'web1' }, 'b!bob': { siteUrl: 'https://host/personal/bob', siteId: 'personal', webId: 'bob' },
};
const mail = [
  { id: 'm1', subject: 'FW: Request successfully processed for DEMO SUPPLIER LLC', body: { contentType: 'text', content: 'The payment run is attached.' } },
  { id: 'm2', subject: 'Something else', body: { contentType: 'text', content: 'Lunch?' } },
];
const MIME = 'Subject: FW: Request successfully processed\r\n\r\nThe payment run is attached.\r\n';
const ticks = ['m365:mail:alice@demo.test', 'm365:site:host,site1,web1'];
const inst = { dir: instDir, seriesId: 'weekly', log: [{ op: 'create', by: ALICE, logins: ticks }], series: () => seriesDir, append: (_by: string, op: string, data: any) => { log.push({ op, data }); return { seq: log.length }; } } as unknown as Instance;
const run: AgentRun = { inst, n: 1, token: 'run' };
let call: (path: string, body?: unknown) => Promise<{ status: number; data: unknown } | null>;
let logins: typeof import('../src/logins.ts');

before(async () => {
  mkdirSync(join(instDir, 'working'), { recursive: true });
  mkdirSync(seriesDir, { recursive: true });
  graph = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'), path = decodeURIComponent(u.pathname), send = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
    if (path === '/.well-known/openid-configuration') return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
    if (path === '/token') {
      let body = '';
      req.on('data', c => (body += c)).on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') !== 'refresh_token' || f.get('refresh_token') !== `r${refreshes}`) return send({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }, 400);
        refreshes++;
        send({ access_token: 'tok', refresh_token: `r${refreshes}`, expires_in: 3600 });
      });
      return;
    }
    methods.push(req.method!);
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    let m;
    if (path === '/me/drive') return send({ id: 'b!own' });
    if ((m = /^\/shares\/u!([\w-]+)\/driveItem$/.exec(path))) return send(shares[Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()]);
    if ((m = /^\/drives\/b!d1\/items\/(\w+)\/children$/.exec(path))) return send({ value: folders[m[1]] ?? [] });
    if ((m = /^\/drives\/b!d1\/items\/(\w+)\/content$/.exec(path))) return void res.writeHead(200).end(content[m[1]]);
    if ((m = /^\/drives\/b!d1\/items\/(\w+)$/.exec(path))) return send(m[1] === 'top' ? item('top', 'LFM', '2026-01-01T00:00:00Z', true) : [...Object.values(folders).flat()].find(i => i.id === m![1]));
    if ((m = /^\/drives\/(b!\w+)$/.exec(path)) && drives[m[1]]) return send({ id: m[1], sharePointIds: drives[m[1]] });
    if (path === '/me/messages') return send({ value: mail });
    if (path === '/me/messages/m1/$value') return void res.writeHead(200, { 'content-type': 'message/rfc822' }).end(MIME);
    if (path === `/users/${AP}/mailFolders/inbox`) return send({ id: 'inbox' });
    if (path === '/sites/demo.sharepoint.com:/sites/Finance') return send({ id: 'host,site2,web2', displayName: 'Finance' });
    send({ error: { code: 'itemNotFound', message: 'not here' } }, 404);
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  Object.assign(process.env, { RF_OIDC_ISSUER: `http://127.0.0.1:${(graph.address() as { port: number }).port}`, RF_OIDC_CLIENT_ID: 'app', RF_PUBLIC_URL: 'http://127.0.0.1:1' });
  const { initSystem, saveTree } = await import('../src/system.ts');
  const { upsertUser } = await import('../src/auth.ts');
  const { openSkills, pushSkill } = await import('../src/skills.ts');
  const { filesOf, standIns } = await import('./push.ts');
  const { agentCall } = await import('../src/agent-api.ts');
  const { endpoints } = await import('../src/graph.ts');
  logins = await import('../src/logins.ts');
  initSystem(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [ALICE], members: [] } }, series: { weekly: { name: 'Weekly', workspace: 'w' } } });
  upsertUser(ALICE, { role: 'user' });
  openSkills(tmp);
  for (const id of ['mail-report', 'onedrive-report', 'portal', 'tool']) pushSkill(id, filesOf(join(standIns, id)), ALICE);
  endpoints.graph = process.env.RF_OIDC_ISSUER!;
  logins.saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: ALICE, since: '2026-11-02T00:00:00Z', offers: [
    { id: `m365:mail:${ALICE}`, name: 'Mailbox' }, { id: 'm365:onedrive', name: 'OneDrive' }, { id: 'm365:site:host,site1,web1', name: 'SharePoint Reports' },
  ] }, 'r0');
  call = (path, body) => agentCall(run, path, body === undefined ? 'GET' : 'POST', async () => Buffer.from(JSON.stringify(body ?? {})));
});

after(() => {
  graph.close();
  graph.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('rf graph reads a ticked SharePoint library as Graph answers: a sharing link, a folder, a file saved with --out; Graph is only read', async () => {
  const graph = async (...args: string[]) => (await call('/agent/graph', { args }))!.data as any;
  const folder = await graph(`/shares/u!${Buffer.from('https://share.test/reports').toString('base64url')}/driveItem`);
  assert.deepEqual([folder.name, folder.parentReference.driveId], ['2026', 'b!d1']);
  assert.deepEqual((await graph('/drives/b!d1/items/y2026/children')).value.map((i: any) => i.name), ['AGING_A_1.csv', 'AGING_B_2.csv', 'AGING_A_0.csv']);
  const got = await graph('/drives/b!d1/items/a/content', '--out', 'aging.csv');
  assert.deepEqual([got.saved, Buffer.from(got.data, 'base64').toString()], ['working/aging.csv', content.a], 'the bytes come back for rf to save');
  await assert.rejects(graph('/drives/b!d1/items/a/content'), /save them with --out FILE/);
  assert.ok(methods.length && methods.every(m => m === 'GET'));
  assert.equal(logins.secret(ALICE, 'm365'), 'r1', 'the refresh token turned over and was sealed again');
});

test("rf graph reaches only what's ticked: not the runner's OneDrive unticked, anyone else's, an unticked mailbox, a path climbing out, or the rest of Graph", async () => {
  const graph = (path: string) => call('/agent/graph', { args: [path] });
  await assert.rejects(graph('/me/drive/root/children'), /m365:onedrive is not ticked for this instance/);
  await assert.rejects(graph(`/shares/u!${Buffer.from('https://share.test/bobs').toString('base64url')}/driveItem/content`), /m365:site:host,personal,bob is not ticked/);
  await assert.rejects(graph(`/users/${AP}/messages`), /m365:mail:ap@demo.test is not ticked/);
  await assert.rejects(graph(`/me/messages/../../users/${AP}/messages`), /m365:mail:ap@demo.test is not ticked/);
  await assert.rejects(graph('/users'), /rf graph reads mailboxes, OneDrive and SharePoint sites ticked for this instance, not \/users/);
  await assert.rejects(graph('https://elsewhere.test/v1.0/me/messages'), /a Graph path/);
});

test("rf graph reads a ticked mailbox whole: messages with their bodies, and a message's MIME, which rf saves", async () => {
  const { serveAgent } = await import('../src/agent-api.ts'), api = await serveAgent(inst);
  const rf = async (...args: string[]) => (await promisify(execFile)(process.execPath, [join(app, 'src', 'rf.ts'), ...args], { env: { ...process.env, RF_URL: api.url, RF_TOKEN: api.token, RF_WORKING: join(instDir, 'working') } })).stdout;
  assert.deepEqual(JSON.parse(await rf('graph', '/me/messages?$select=subject,body')).value.map((m: any) => m.body.content), ['The payment run is attached.', 'Lunch?']);
  assert.equal((await rf('graph', '/me/messages/m1/$value', '--out', 'm1.eml')).trim(), 'saved working/m1.eml');
  await api.close();
  assert.equal(readFileSync(join(instDir, 'working', 'm1.eml'), 'utf8'), MIME);
  assert.deepEqual(log.filter(e => e.op === 'graph').slice(-2).map(e => [e.data.path, e.data.status, e.data.file]), [['/me/messages?$select=subject,body', 200, undefined], ['/me/messages/m1/$value', 200, 'working/m1.eml']]);
});

test('a person adds a shared mailbox they can read, and a SharePoint site by its link', async () => {
  const { offer } = await import('../src/m365.ts');
  await offer(ALICE, { mailbox: 'AP@demo.test' });
  await offer(ALICE, { site: 'https://demo.sharepoint.com/sites/Finance/Shared%20Documents/Forms/AllItems.aspx' });
  await assert.rejects(offer(ALICE, { mailbox: 'ceo@demo.test' }), /404/);
  await assert.rejects(offer(ALICE, { site: 'https://demo.sharepoint.com/personal/bob' }), /a SharePoint site link/);
  assert.deepEqual(logins.logins(ALICE)[0].offers.slice(3), [{ id: `m365:mail:${AP}`, name: `Mailbox ${AP}` }, { id: 'm365:site:host,site2,web2', name: 'SharePoint Finance' }]);
});

test('a login Microsoft no longer renews is marked expired, and the run is told its runner signs in again', async () => {
  logins.saveLogin(ALICE, logins.logins(ALICE)[0], 'stale');
  const fresh = await import(`../src/graph.ts?again=${Date.now()}`);
  await assert.rejects(fresh.token(ALICE), /alice@demo.test's Microsoft 365 login has expired/);
  assert.equal(logins.logins(ALICE)[0].expired, true);
});

test('a push takes an id of letters, digits and dashes, and a SKILL.md; a push cut short leaves nothing behind', async () => {
  const { pushSkill, skills, versionsOf } = await import('../src/skills.ts');
  const files = { 'SKILL.md': Buffer.from('---\nname: x\n---\n').toString('base64') };
  assert.throws(() => pushSkill('Half', files, ALICE), /a skill id is/);
  assert.throws(() => pushSkill('half', {}, ALICE), /a skill has a SKILL.md/);
  assert.throws(() => versionsOf('../../instances'), /a skill id is/);
  mkdirSync(join(tmp, 'skills', 'versions', 'half', '1'), { recursive: true });
  symlinkSync(join('..', 'versions', 'half', '1'), join(tmp, 'skills', 'live', 'half.new'));
  assert.equal(pushSkill('half', files, ALICE), 2, 'after a version cut short, and its leftover link');
  assert.deepEqual(versionsOf('half').map(v => v.version), [2]);
  assert.ok(!skills().some(s => s.id.includes('.')));
});

test('admins keep websites, each an address and the other hosts its pages need; a series picks skills that exist', async () => {
  const { checkChosen, skills } = await import('../src/skills.ts');
  const { removeWebsite, setWebsite, websites } = await import('../src/browsers.ts');
  assert.deepEqual(checkChosen(['mail-report', 'mail-report']), ['mail-report']);
  assert.throws(() => checkChosen(['nope']), /no skill nope/);
  const ids = skills().map(s => s.id);
  for (const id of ['onedrive-report', 'mail-report', 'portal', 'tool']) assert.ok(ids.includes(id), id);
  assert.throws(() => setWebsite('Portal', { url: 'https://portal.test' }, 'admin'), /a website id is/);
  assert.throws(() => setWebsite('portal', { url: 'portal.test' }, 'admin'), /an http\(s\) address/);
  assert.throws(() => setWebsite('portal', { url: 'https://portal.test', hosts: ['cdn.portal.test/x'] }, 'admin'), /hosts: names/);
  setWebsite('portal', { url: 'https://portal.test/#/login', hosts: ['cdn.portal.test', '*.sso.test'] }, 'admin');
  const w = websites().portal;
  assert.deepEqual([w.name, w.url, w.hosts, w.updated_by], ['portal', 'https://portal.test/#/login', ['cdn.portal.test', '*.sso.test'], 'admin']);
  removeWebsite('portal');
  assert.throws(() => removeWebsite('portal'), /no website portal/);
});
