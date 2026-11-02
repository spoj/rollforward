import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance } from '../src/store.ts';
import type { AgentRun } from '../src/agent-api.ts';

// A stand-in for Microsoft's sign-in and Graph: a SharePoint folder of years of reports, the runner's OneDrive, someone else's
// OneDrive, and two mailboxes. The reads are called as a run's agent calls them, through its runner's Microsoft 365 login.
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
const mail = [
  { id: 'm1', subject: 'FW: Request successfully processed for DEMO SUPPLIER LLC', receivedDateTime: '2026-10-20T11:00:00Z', hasAttachments: true, from: { emailAddress: { address: 'may@demo.test' } } },
  { id: 'm2', subject: 'Something else', receivedDateTime: '2026-10-20T12:00:00Z', hasAttachments: true, from: { emailAddress: { address: 'x@demo.test' } } },
];
const ticks = ['m365:mail:alice@demo.test', 'm365:site:host,site1,web1'];
const inst = { dir: instDir, log: [{ op: 'create', by: ALICE, logins: ticks }], series: () => seriesDir, append: (_by: string, op: string, data: any) => { log.push({ op, data }); return { seq: log.length }; } } as unknown as Instance;
const run: AgentRun = { inst };
let call: (path: string, body?: unknown, query?: string) => Promise<{ status: number; data: unknown } | null>;
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
    if ((m = /^\/users\/([^/]+)\/messages$/.exec(path)) && [ALICE, AP].includes(m[1])) {
      const [, from, to] = /ge (\S+) and receivedDateTime lt (\S+)/.exec(u.searchParams.get('$filter') ?? '') ?? [];
      return send({ value: (m[1] === ALICE ? mail : []).filter(x => x.receivedDateTime >= from && x.receivedDateTime < to) });
    }
    if (path === `/users/${ALICE}/messages/m1/attachments`) return send({ value: [
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Open to Pay.xlsx', contentType: 'application/vnd.ms-excel', contentBytes: Buffer.from('xlsx bytes').toString('base64') },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png', contentBytes: '' },
    ] });
    if (path === `/users/${AP}/mailFolders/inbox`) return send({ id: 'inbox' });
    if (path === '/sites/demo.sharepoint.com:/sites/Finance') return send({ id: 'host,site2,web2', displayName: 'Finance' });
    send({ error: { code: 'itemNotFound', message: 'not here' } }, 404);
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  Object.assign(process.env, { RF_OIDC_ISSUER: `http://127.0.0.1:${(graph.address() as { port: number }).port}`, RF_OIDC_CLIENT_ID: 'app', RF_PUBLIC_URL: 'http://127.0.0.1:1' });
  const { initSystem } = await import('../src/system.ts');
  const { useSkillsDir } = await import('../src/skills.ts');
  const { agentCall } = await import('../src/agent-api.ts');
  const { endpoints } = await import('../src/graph.ts');
  logins = await import('../src/logins.ts');
  useSkillsDir(join(app, 'test', 'skills'));
  initSystem(tmp);
  endpoints.graph = process.env.RF_OIDC_ISSUER!;
  logins.saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: ALICE, since: '2026-11-02T00:00:00Z', offers: [
    { id: `m365:mail:${ALICE}`, name: 'Mailbox' }, { id: 'm365:onedrive', name: 'OneDrive' }, { id: 'm365:site:host,site1,web1', name: 'SharePoint Reports' },
  ] }, 'r0');
  call = (path, body, query = '') => agentCall(run, path, body === undefined ? 'GET' : 'POST', new URLSearchParams(query), async () => Buffer.from(JSON.stringify(body ?? {})));
});

after(() => {
  graph.close();
  graph.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('rf files reads a ticked SharePoint site as the runner: lists a folder, steps to its parent, saves a file; Graph is only read', async () => {
  const folder = (await call('/agent/files', { args: ['list', 'https://share.test/reports'] }))!.data as any;
  assert.deepEqual([folder.name, folder.folder, folder.parent, folder.items.length], ['2026', true, 'b!d1/top', 3]);
  const up = (await call('/agent/files', { args: ['list', folder.parent] }))!.data as any;
  assert.deepEqual(up.items.map((i: any) => i.name), ['2026', '2025']);
  const got = (await call('/agent/files', { args: ['get', 'b!d1/a', 'aging.csv'] }))!.data as any;
  assert.equal(got.saved, 'working/aging.csv');
  assert.equal(readFileSync(join(instDir, 'working', 'aging.csv'), 'utf8'), content.a);
  await assert.rejects(call('/agent/files', { args: ['get', 'b!d1/a', '../escape.csv'] }), /under your working/);
  assert.ok(methods.length && methods.every(m => m === 'GET'));
  assert.equal(logins.secret(ALICE, 'm365'), 'r1', 'the refresh token turned over and was sealed again');
});

test("rf files refuses the runner's OneDrive unless ticked, and anyone else's OneDrive always", async () => {
  await assert.rejects(call('/agent/files', { args: ['list', 'https://share.test/mine'] }), /m365:onedrive is not ticked for this instance/);
  await assert.rejects(call('/agent/files', { args: ['list', 'https://share.test/bobs'] }), /someone else's OneDrive/);
});

test("rf mail reads a ticked mailbox, the runner's own unless named, and saves attachments without overwriting", async () => {
  const found = (await call('/agent/mail', { args: ['find', '--date', '2026-10-20', '--subject', 'request successfully', '--attachments'] }))!.data as any;
  assert.deepEqual([found.mailbox, found.messages.map((m: any) => m.id)], [ALICE, ['m1']]);
  assert.ok(!('body' in found.messages[0]), "a message's body is never handed out");
  const saved = (await call('/agent/mail', { args: ['save', 'm1', '--name', '\\.xlsx$'] }))!.data as any;
  const again = (await call('/agent/mail', { args: ['save', 'm1', '--name', '\\.xlsx$'] }))!.data as any;
  assert.deepEqual([saved.saved, again.saved], [['working/Open to Pay.xlsx'], ['working/Open to Pay (2).xlsx']]);
  await assert.rejects(call('/agent/mail', { args: ['find', '--mailbox', AP] }), /m365:mail:ap@demo.test is not ticked/);
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

test('admins set each skill up once; a password is sealed, never handed out, and kept when left empty; a series picks skills that exist', async () => {
  const { checkChosen, publicSettings, saveSkillConfig, skill, skills } = await import('../src/skills.ts');
  assert.deepEqual(checkChosen(['mail-report', 'mail-report']), ['mail-report']);
  assert.throws(() => checkChosen(['nope']), /no skill nope/);
  assert.throws(() => saveSkillConfig('mail-report', { mailbox: 'x' }, 'admin'), /mail-report has no setting mailbox/);
  saveSkillConfig('portal', { url: 'https://portal.test/#/login', username: 'svc', password: 'P4ss!word' }, 'admin');
  assert.ok(!readFileSync(join(tmp, '.rf', 'skills.json'), 'utf8').includes('P4ss!word'));
  assert.deepEqual(publicSettings(skill('portal')!), { url: 'https://portal.test/#/login', username: 'svc' });
  saveSkillConfig('portal', { url: 'https://portal.test/#/login', username: 'svc2' }, 'admin');
  assert.ok(JSON.parse(readFileSync(join(tmp, '.rf', 'skills.json'), 'utf8'))['portal'].password, 'an empty password keeps the one saved');
  const ids = skills().map(s => s.id);
  for (const id of ['onedrive-report', 'mail-report', 'portal', 'tool']) assert.ok(ids.includes(id), id);
  writeFileSync(join(seriesDir, 'series.json'), JSON.stringify({ skills: ['mail-report'] }));
  await assert.rejects(call('/agent/settings', undefined, 'skill=onedrive-report'), /not in this series' Skill use/);
});
