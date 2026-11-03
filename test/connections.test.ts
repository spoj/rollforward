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
// Every item names its parent, up to its drive's root.
const ALICE = 'alice@demo.test', AP = 'ap@demo.test';
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-conn-')), seriesDir = join(tmp, 'series', 'weekly'), instDir = join(tmp, 'instances', 'w1');
const methods: string[] = [], log: { op: string; data: any }[] = [];
let graph: Server, refreshes = 0;

const lib = { driveId: 'b!d1', driveType: 'documentLibrary', siteId: 'host,site1,web1' }, alices = { driveId: 'b!own', driveType: 'business', siteId: 'host,personal,alice' };
const item = (id: string, name: string, modified: string, folder = false, parent = 'top', where = lib) =>
  ({ id, name, lastModifiedDateTime: modified, parentReference: { ...where, id: parent }, ...(folder ? { folder: {} } : { file: {} }) });
const roots: Record<string, any> = { 'b!d1': { id: 'root1', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!d1' } }, 'b!own': { id: 'root2', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!own' } } };
const shares: Record<string, any> = {
  'https://share.test/reports': item('y2026', '2026', '2026-01-02T00:00:00Z', true),
  'https://host/sites/reports/Shared%20Documents/LFM/2026': item('y2026', '2026', '2026-01-02T00:00:00Z', true),
  'https://host/sites/reports/Shared%20Documents/LFM': item('top', 'LFM', '2026-01-01T00:00:00Z', true, 'root1'),
  'https://host/:f:/s/reports/Tok3n?e=x': item('y2025', '2025', '2025-01-02T00:00:00Z', true),
  'https://host-my/personal/alice/Documents': roots['b!own'],
  'https://share.test/mine': item('mine', 'mine.csv', '2026-10-20T00:00:00Z', false, 'root2', alices),
  'https://share.test/bobs': item('bobs', 'bobs.csv', '2026-10-20T00:00:00Z', false, 'bobroot', { driveId: 'b!bob', driveType: 'business', siteId: 'host,personal,bob' }),
};
const folders: Record<string, ReturnType<typeof item>[]> = {
  root1: [item('top', 'LFM', '2026-01-01T00:00:00Z', true, 'root1')],
  top: [item('y2026', '2026', '2026-01-02T00:00:00Z', true), item('y2025', '2025', '2025-01-02T00:00:00Z', true)],
  y2026: [item('a', 'AGING_A_1.csv', '2026-10-20T12:00:00Z', false, 'y2026'), item('b', 'AGING_B_2.csv', '2026-10-20T12:30:00Z', false, 'y2026'), item('c', 'AGING_A_0.csv', '2026-10-19T12:00:00Z', false, 'y2026')],
};
const content: Record<string, string> = { a: 'As-Of Date,10/20/2026\nCustomer,Open\nAcme,10\n' };
const drives: Record<string, any> = {
  'b!d1': { driveType: 'documentLibrary', sharePointIds: { siteUrl: 'https://host/sites/reports', siteId: 'site1', webId: 'web1' } },
  'b!own': { driveType: 'business', owner: { user: { displayName: 'Alice Ames' } }, sharePointIds: { siteUrl: 'https://host-my/personal/alice', siteId: 'personal', webId: 'alice' } },
  'b!bob': { driveType: 'business', owner: { user: { displayName: 'Bob Bell' } }, sharePointIds: { siteUrl: 'https://host/personal/bob', siteId: 'personal', webId: 'bob' } },
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
let agentCall: typeof import('../src/agent-api.ts').agentCall;
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
        if (f.get('refresh_token') === 'old-app') return send({ error: 'invalid_client', error_description: "AADSTS7000215: Invalid client secret provided for a secret added to app 'old'." }, 401);
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
    if ((m = /^\/shares\/u!([\w-]+)\/driveItem$/.exec(path))) return send(shares[Buffer.from(m[1], 'base64url').toString()] ?? { error: { code: 'itemNotFound' } }, shares[Buffer.from(m[1], 'base64url').toString()] ? 200 : 404);
    if ((m = /^\/drives\/b!d1\/(?:items\/(\w+)|root)\/(?:children|search\(q='\w+'\))$/.exec(path))) return send({ value: folders[m[1] ?? 'root1'] ?? [] });
    if ((m = /^\/drives\/b!d1\/items\/(\w+)\/content$/.exec(path))) return void res.writeHead(200).end(content[m[1]]);
    if ((m = /^\/drives\/b!d1\/items\/(\w+)$/.exec(path))) return send(m[1] === 'root1' ? roots['b!d1'] : [...Object.values(folders).flat()].find(i => i.id === m![1]));
    if ((m = /^\/(?:drives\/(b!\w+)|users\/alice@demo\.test\/drive)\/root$/.exec(path))) return send(roots[m[1] ?? 'b!own']);
    if ((m = /^\/drives\/(b!\w+)$/.exec(path)) && drives[m[1]]) return send({ id: m[1], ...drives[m[1]] });
    if (path === '/sites/host,site1,web1') return send({ id: 'host,site1,web1', displayName: 'Reports' });
    if (path === '/drives/b!d1/root:/LFM:') return send(item('top', 'LFM', '2026-01-01T00:00:00Z', true, 'root1'));
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
  const { endpoints } = await import('../src/graph.ts');
  agentCall = (await import('../src/agent-api.ts')).agentCall;
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
  await assert.rejects(graph('/me/drive/root/children'), /\/me\/drive\/root\/children is in no folder, file or SharePoint site ticked for this instance/);
  await assert.rejects(graph(`/shares/u!${Buffer.from('https://share.test/bobs').toString('base64url')}/driveItem/content`), /is in no folder, file or SharePoint site ticked/);
  await assert.rejects(graph(`/users/${AP}/messages`), /m365:mail:ap@demo.test is not ticked/);
  await assert.rejects(graph(`/me/messages/../../users/${AP}/messages`), /m365:mail:ap@demo.test is not ticked/);
  await assert.rejects(graph('/users'), /rf graph reads mailboxes, and folders, files and SharePoint sites ticked for this instance, not \/users/);
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

test('a person adds, in one box, a mailbox by its address, a site by its link, and a folder or file by any link to it', async () => {
  const { offer } = await import('../src/m365.ts'), before = logins.logins(ALICE)[0].offers.length;
  await offer(ALICE, 'AP@demo.test');
  await offer(ALICE, 'https://demo.sharepoint.com/sites/Finance/');
  await offer(ALICE, 'https://host/:f:/r/sites/reports/Shared%20Documents/LFM/2026?csf=1&web=1&e=abc');
  await offer(ALICE, 'https://host/sites/reports/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2Freports%2FShared%20Documents%2FLFM&viewid=v');
  await offer(ALICE, 'https://host/:f:/s/reports/Tok3n?e=x');
  await offer(ALICE, 'https://host-my/personal/alice/Documents');
  await offer(ALICE, 'https://host/sites/reports/Shared%20Documents/LFM/2026');
  await assert.rejects(offer(ALICE, 'ceo@demo.test'), /404/);
  await assert.rejects(offer(ALICE, 'https://host/sites/reports/nothing/here'), /404/);
  await assert.rejects(offer(ALICE, 'Finance'), /a mailbox address, or a link/);
  assert.deepEqual(logins.logins(ALICE)[0].offers.slice(before), [
    { id: `m365:mail:${AP}`, name: `Mailbox ${AP}` }, { id: 'm365:site:host,site2,web2', name: 'Site Finance' },
    { id: 'm365:item:b!d1/top', name: 'Folder LFM, Reports' }, { id: 'm365:item:b!d1/y2025', name: 'Folder 2025, Reports' },
    { id: 'm365:item:b!own/root2', name: "Alice Ames's OneDrive" }, { id: 'm365:item:b!d1/y2026', name: 'Folder 2026, Reports' },
  ], 'the same item again replaces its offer');
});

test("a ticked folder reaches what's under it, at any depth, and a search within it; not its parent, a sibling, or a search of the whole drive", async () => {
  const folder = { ...inst, log: [{ op: 'create', by: ALICE, logins: ['m365:item:b!d1/y2026'] }] };
  const graph = async (...args: string[]) => (await agentCall({ inst: folder, n: 1, token: 'run2' }, '/agent/graph', 'POST', async () => Buffer.from(JSON.stringify({ args }))))!.data as any;
  assert.deepEqual((await graph('/drives/b!d1/items/y2026/children')).value.map((i: any) => i.id), ['a', 'b', 'c']);
  assert.equal(Buffer.from((await graph('/drives/b!d1/items/a/content', '--out', 'a.csv')).data, 'base64').toString(), content.a, 'a file under it');
  assert.ok((await graph("/drives/b!d1/items/y2026/search(q='AGING')")).value);
  for (const out of ['/drives/b!d1/items/top/children', '/drives/b!d1/items/y2025/children', "/drives/b!d1/root/search(q='AGING')", '/drives/b!d1/root:/LFM:/children'])
    await assert.rejects(graph(out), /is in no folder, file or SharePoint site ticked/, out);
});

test('a login Microsoft no longer renews is marked expired, and the run is told its runner signs in again', async () => {
  logins.saveLogin(ALICE, logins.logins(ALICE)[0], 'stale');
  const fresh = await import(`../src/graph.ts?again=${Date.now()}`);
  await assert.rejects(fresh.token(ALICE), /alice@demo.test's Microsoft 365 login has expired/);
  assert.equal(logins.logins(ALICE)[0].expired, true);
});

test("a login made through another app, or with a secret since replaced, shows as expired from the server's start", async () => {
  logins.saveLogin(ALICE, { ...logins.logins(ALICE)[0], expired: false }, 'old-app');
  const fresh = await import(`../src/graph.ts?app=${Date.now()}`);
  await fresh.checkLogins();
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

test('admins keep websites, each an address and the other hosts its pages need', async () => {
  const { skills } = await import('../src/skills.ts');
  const { removeWebsite, setWebsite, websites } = await import('../src/browsers.ts');
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
