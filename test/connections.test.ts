import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Instance } from '../src/store.ts';
import type { AgentRun } from '../src/agent-api.ts';

// A stand-in for Microsoft's sign-in and Graph: a SharePoint library with a folder of years of reports, the runner's OneDrive,
// someone else's OneDrive, and two mailboxes; a Databricks warehouse; and OpenRouter and Exa, the server's own. Each is reached as a
// run reaches it, through the sandbox's proxy, with the host's own address and rollforward's certificate authority, and the
// runner's login, or the server's key, put in on the way. Every item names its parent, up to its drive's root.
const ALICE = 'alice@demo.test', AP = 'ap@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-conn-')), seriesDir = join(tmp, 'series', 'weekly'), instDir = join(tmp, 'instances', 'w1');
const methods: string[] = [], log: { op: string; data: any }[] = [], writes: { method: string; path: string; auth?: string; type?: string; body: Buffer }[] = [];
const statements: { statement: string; warehouse_id: string }[] = [];
let graph: Server, services: Server, refreshes = 0;
const seen: string[] = [];

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
const content: Record<string, string> = { a: 'As-Of Date,10/20/2026\nCustomer,Open\nAcme,10\n', c: '{"@microsoft.graph.downloadUrl":"https://host/download/b?tempauth=t","uploadUrl":"https://outlook.office.com/upload/s9"}' };
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
// An instance's log as its run 1 started, with the logins ticked as it was made.
const started = (logins: string[]) => [{ seq: 1, op: 'create', by: ALICE, logins }, { seq: 2, op: 'run', run: 1, runner: ALICE, consent: 1 }];
const inst = { dir: instDir, seriesId: 'weekly', log: started(ticks), doc: { items: [{ id: 'pack', name: 'Pack', kind: 'output', file: null }] }, series: () => seriesDir, append: (_by: string, op: string, data: any) => { log.push({ op, data }); return { seq: log.length }; } } as unknown as Instance;
const run: AgentRun = { inst, n: 1, token: 'run' };
let call: (path: string, body?: unknown) => Promise<{ status: number; data: unknown } | null>;
let agentCall: typeof import('../src/agent-api.ts').agentCall;
let logins: typeof import('../src/logins.ts');
// The proxy's runs, by token, each the instance the run is for.
const runs = new Map<string, Instance>(), callRuns = new Map<string, import('../src/connections.ts').CallRun>();
// What OpenRouter and Exa were asked; a stream holds after its first event until the test lets it go on.
const asked: { path: string; auth?: string; key?: string | string[]; body: unknown }[] = [];
let held = Promise.resolve();
let sock = '', ca = '', proxy: Server;
const m365 = () => logins.logins(ALICE).find(l => l.id === 'm365')!;

// A request as a run's tool makes it: CONNECT through the proxy with the run's token, then TLS to the host, trusting what the run
// trusts, and HTTP/1.1; `data` sees the answer as it comes, and `cut` hangs up at its first bytes, as a run cut then would.
async function via(method: string, url: string, o: { body?: string | Buffer; headers?: Record<string, string>; token?: string; data?: (b: Buffer) => void; path?: string; cut?: boolean } = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const u = new URL(url), token = o.token ?? 'run';
  const socket = await new Promise<Socket>((ok, fail) => request({ socketPath: sock, method: 'CONNECT', path: `${u.hostname}:443`, headers: { 'proxy-authorization': `Basic ${Buffer.from(`rf:${token}`).toString('base64')}` } })
    .on('connect', (r, s) => r.statusCode === 200 ? ok(s) : fail(new Error(`CONNECT answered ${r.statusCode}`))).on('error', fail).end());
  const tls = tlsConnect({ socket, servername: u.hostname, ca, ALPNProtocols: ['http/1.1'] });
  return new Promise((ok, fail) => {
    const r = httpsRequest({ host: u.hostname, path: o.path ?? u.pathname + u.search, method, headers: { authorization: 'Bearer rf', ...o.headers }, createConnection: () => tls }, res => {
      const chunks: Buffer[] = [];
      res.on('data', b => {
        chunks.push(b);
        o.data?.(b);
        if (o.cut) (tls.destroy(), ok({ status: res.statusCode!, text: '', headers: res.headers }));
      }).on('end', () => ok({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    r.on('error', fail);
    r.end(o.body);
  });
}
const G = 'https://graph.microsoft.com/v1.0', json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  mkdirSync(join(instDir, 'working'), { recursive: true });
  mkdirSync(seriesDir, { recursive: true });
  graph = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'), path = decodeURIComponent(u.pathname).replace(/^\/(v1\.0|beta)/, ''), send = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
    if (path === '/.well-known/openid-configuration') return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
    if (path === '/token') {
      let body = '';
      req.on('data', c => (body += c)).on('end', () => {
        const f = new URLSearchParams(body);
        // A Databricks login renews as Azure Databricks.
        if (f.get('scope')!.includes('2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/user_impersonation'))
          return f.get('refresh_token') === 'dbx' ? send({ access_token: 'dtok', refresh_token: 'dbx', expires_in: 3600 }) : send({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }, 400);
        // A login made before the server asked for Mail.Send renews only with the permissions it was granted.
        if (f.get('refresh_token') === 'unconsented') return f.get('scope')!.includes('Mail.Send')
          ? send({ error: 'invalid_grant', suberror: 'consent_required', error_description: "AADSTS65001: The user or administrator has not consented to use the application with ID 'app'." }, 400)
          : (refreshes++, send({ access_token: 'tok', refresh_token: 'unconsented', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Files.Read.All Sites.Read.All openid email' }));
        if (f.get('refresh_token') === 'old-app') return send({ error: 'invalid_client', error_description: "AADSTS7000215: Invalid client secret provided for a secret added to app 'old'." }, 401);
        if (f.get('refresh_token') === 'our-secret') return send({ error: 'invalid_client', error_description: "AADSTS7000222: The provided client secret keys for app 'app' are expired." }, 401);
        if (f.get('grant_type') !== 'refresh_token' || f.get('refresh_token') !== `r${refreshes}`) return send({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }, 400);
        refreshes++;
        send({ access_token: 'tok', refresh_token: `r${refreshes}`, expires_in: 3600 });
      });
      return;
    }
    // Links an answer gave: an upload session's and a result's chunk, each carrying its own token.
    if (path === '/download/a') return send({ downloaded: true, auth: req.headers.authorization ?? null });
    if (path === '/blob/chunk0') return void res.writeHead(200, { 'content-type': 'text/csv', 'x-auth': String(req.headers.authorization) }).end('customer,open\nAcme,10\n');
    // A Databricks warehouse: a statement's result as external links, and the catalogue.
    if (path.startsWith('/api/')) {
      if (req.headers.authorization !== 'Bearer dtok') return void res.writeHead(401).end();
      const result = { statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'customer' }, { name: 'open' }] } }, result: { external_links: [{ chunk_index: 0, external_link: 'https://dbstorage1.blob.core.windows.net/blob/chunk0?sig=x' }] } };
      if (path === '/api/2.0/sql/statements' && req.method === 'POST') return void req.on('data', b => statements.push(JSON.parse(String(b)))).on('end', () => send(result));
      if (path === '/api/2.0/sql/statements/s1') return send(result);
      if (path === '/api/2.1/unity-catalog/catalogs') return send({ catalogs: [{ name: 'finance' }] });
      if (path === '/api/2.0/sql/warehouses/wh1') return send({ id: 'wh1', name: 'Finance' });
      return send({ error_code: 'NOT_FOUND' }, 404);
    }
    methods.push(req.method!);
    if (req.method !== 'GET') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c)).on('end', () => {
        const w = { method: req.method!, path, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks) };
        writes.push(w);
        if (path === '/upload/s1') return res.writeHead(201).end();
        if (w.auth !== 'Bearer tok') return void res.writeHead(401).end();
        if (path === '/drives/b!d1/items/y2026:/report.xlsx:/content') return send({ id: 'new1', name: 'report.xlsx', eTag: '"{NEW1},1"' }, 201);
        if (path === '/drives/b!d1/items/y2026:/big.xlsx:/content') return send({ id: 'big1', name: 'big.xlsx', description: 'x'.repeat(1 << 22) }, 201);
        if (path === '/drives/b!d1/items/a' && req.method === 'PATCH') return send({ id: 'a', eTag: '"{A},2"' });
        if (path === '/me/messages') return send({ id: 'd1' }, 201);
        if (path === '/me/messages/d1/attachments/createUploadSession') return send({ uploadUrl: 'https://outlook.office.com/upload/s1?tempauth=secret' }, 201);
        if (path === '/me/sendMail' || path === '/me/messages/d1/send') return void res.writeHead(202).end();
        send({ error: { code: 'invalidRequest', message: 'not here' } }, 400);
      });
      return;
    }
    seen.push(String(req.headers.authorization));
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    let m;
    if (path === '/me/drive') return send({ id: 'b!own' });
    if ((m = /^\/shares\/u!([\w-]+)\/driveItem$/.exec(path))) return send(shares[Buffer.from(m[1], 'base64url').toString()] ?? { error: { code: 'itemNotFound' } }, shares[Buffer.from(m[1], 'base64url').toString()] ? 200 : 404);
    if ((m = /^\/drives\/b!d1\/(?:items\/(\w+)|root)\/(?:children|search\(q='\w+'\))$/.exec(path))) return send({ value: folders[m[1] ?? 'root1'] ?? [] });
    // A file's content as Graph gives OneDrive's and SharePoint's: a redirect to its download address, at its drive's own site.
    if (path === '/drives/b!d1/items/b/content') return void res.writeHead(302, { location: 'https://host/download/a?tempauth=r' }).end();
    if ((m = /^\/drives\/b!d1\/items\/(\w+)\/content$/.exec(path))) return void res.writeHead(200, m[1] === 'c' ? { 'content-type': 'application/json' } : {}).end(content[m[1]]);
    if ((m = /^\/drives\/b!d1\/items\/(\w+)$/.exec(path))) return send(m[1] === 'root1' ? roots['b!d1'] : { ...[...Object.values(folders).flat()].find(i => i.id === m![1]), ...(m[1] === 'a' && { '@microsoft.graph.downloadUrl': 'https://host/download/a?tempauth=t' }) });
    if ((m = /^\/(?:drives\/(b!\w+)|users\/alice@demo\.test\/drive)\/root$/.exec(path))) return send(roots[m[1] ?? 'b!own']);
    if ((m = /^\/drives\/(b!\w+)$/.exec(path)) && drives[m[1]]) return send({ id: m[1], ...drives[m[1]] });
    if (path === '/sites/host,site1,web1') return send({ id: 'host,site1,web1', displayName: 'Reports' });
    if (path === '/drives/b!d1/root:/LFM:') return send(item('top', 'LFM', '2026-01-01T00:00:00Z', true, 'root1'));
    if (path === '/me/messages') return send({ value: mail });
    if (path === '/me/messages/m1/$value') return void res.writeHead(200, { 'content-type': 'message/rfc822' }).end(MIME);
    // A draft to the bank, with the pack attached.
    if (path === `/users/${AP}/mailFolders/inbox`) return send({ id: 'inbox' });
    if (path === '/sites/demo.sharepoint.com:/sites/Finance') return send({ id: 'host,site2,web2', displayName: 'Finance' });
    send({ error: { code: 'itemNotFound', message: 'not here' } }, 404);
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  // OpenRouter and Exa, whose answers say what they cost: a chat completion whole, a message and a response streamed, and a search.
  services = createServer(async (req, res) => {
    const chunks = await Array.fromAsync(req as AsyncIterable<Buffer>), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    asked.push({ path: req.url!, auth: req.headers.authorization, key: req.headers['x-api-key'], body });
    const stream = async (first: object, ...events: object[]) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).write(`: OPENROUTER PROCESSING\n\ndata: ${JSON.stringify(first)}\n\n`);
      await held;
      res.end(`${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`);
    };
    if (req.url === '/api/v1/messages') return stream({ type: 'message_start', message: { usage: { input_tokens: 0 } } }, { type: 'message_delta', usage: { output_tokens: 3, cost: 0.002 } }, { type: 'message_stop' });
    if (req.url === '/api/v1/responses') return stream({ type: 'response.created', response: { usage: null } }, { type: 'response.completed', response: { usage: { cost: 0.004 } } });
    const answer = req.url === '/search' ? { results: [], costDollars: { total: 0.005 } } : req.url === '/api/v1/models' ? { data: [] } : { choices: [{ message: { content: 'Hello' } }], usage: { cost: 0.001 } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  await new Promise<void>(ok => services.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
  Object.assign(process.env, { OPENROUTER_API_KEY: 'the-openrouter-key', EXA_API_KEY: 'the-exa-key', RF_OIDC_ISSUER: base, RF_OIDC_CLIENT_ID: 'app', RF_PUBLIC_URL: 'http://127.0.0.1:1', RF_M365_SCOPES: 'Mail.ReadWrite Mail.ReadWrite.Shared Mail.Send Mail.Send.Shared Files.ReadWrite.All Sites.Read.All' });
  const { initSystem, saveTree, writeJson } = await import('../src/system.ts');
  const { upsertUser } = await import('../src/auth.ts');
  const { openSkills, pushSkill } = await import('../src/skills.ts');
  const { filesOf, standIns } = await import('./push.ts');
  const { endpoints } = await import('../src/connections/graph.ts');
  const c = await import('../src/connections.ts'), { serveSandboxes } = await import('../src/sandbox.ts');
  agentCall = (await import('../src/agent-api.ts')).agentCall;
  logins = await import('../src/logins.ts');
  initSystem(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [ALICE], members: [] } }, series: { weekly: { name: 'Weekly', workspace: 'w' } } });
  upsertUser(ALICE, { role: 'user' });
  openSkills(tmp);
  for (const id of ['mail-report', 'onedrive-report', 'portal', 'tool']) pushSkill(id, filesOf(join(standIns, id)), ALICE);
  writeJson('connections.json', {
    graph: { type: 'graph', updated_by: 'admin', updated_at: '2026-10-01T00:00:00Z' },
    portal: { type: 'website', url: 'https://portal.test/#/login', hosts: ['cdn.portal.test'], title: 'The Portal', writeback: true, updated_by: 'admin', updated_at: '2026-10-01T00:00:00Z' },
  });
  await c.setConnection('adb', { type: 'databricks' }, 'admin');
  endpoints.graph = base;
  for (const host of ['graph.microsoft.com', 'adb-1.azuredatabricks.net', 'host', 'outlook.office.com', 'dbstorage1.blob.core.windows.net']) c.upstreams[host] = base;
  for (const host of ['openrouter.ai', 'api.exa.ai']) c.upstreams[host] = `http://127.0.0.1:${(services.address() as { port: number }).port}`;
  logins.saveLogin(ALICE, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: ALICE, since: '2026-11-02T00:00:00Z', offers: [
    { id: `m365:mail:${ALICE}`, name: 'Mailbox' }, { id: 'm365:onedrive', name: 'OneDrive' }, { id: 'm365:site:host,site1,web1', name: 'SharePoint Reports' },
  ] }, 'r0');
  logins.saveLogin(ALICE, { id: 'adb', kind: 'databricks', name: 'Databricks adb', account: ALICE, since: '2026-11-03T00:00:00Z', offers: [{ id: 'adb:adb-1.azuredatabricks.net/wh1', name: 'Warehouse Finance, adb-1.azuredatabricks.net' }] }, 'dbx');
  ca = (await import('../src/ca.ts')).bundle();
  sock = join(tmp, 'rf.sock');
  proxy = serveSandboxes({
    agent: async (_q, s) => void s.writeHead(404).end(),
    run: token => {
      if (!runs.has(token)) return undefined;
      if (!callRuns.has(token)) callRuns.set(token, { inst: runs.get(token)!, n: 1, links: new Map(), cost: 0 });
      const r = callRuns.get(token)!;
      return { egress() {}, browsers: () => { throw new Error('no browsers here'); }, intercepts: h => c.intercepts(r, h), call: (h, q, s) => c.call(r, h, q, s) };
    },
  }).listen(sock);
  runs.set('run', inst);
  call = (path, body) => agentCall(run, path, body === undefined ? 'GET' : 'POST', async () => Buffer.from(JSON.stringify(body ?? {})));
});

after(() => {
  for (const s of [graph, services, proxy]) {
    s.close();
    s.closeAllConnections();
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const share = (link: string) => `/shares/u!${Buffer.from(link).toString('base64url')}`;
const calls = () => log.filter(e => e.op === 'call').map(e => e.data);

test("rollforward's certificates are always DER that parses: a thousand hosts' each load", async () => {
  const { contextFor } = await import('../src/ca.ts');
  for (let i = 0; i < 1000; i++) contextFor(`host${i}.test`);
});

test("a run reads a ticked SharePoint library at Graph's own address, as Graph answers, with its runner's token put in for the run's own", async () => {
  const folder = await via('GET', `${G}${share('https://share.test/reports')}/driveItem`);
  assert.deepEqual([folder.status, JSON.parse(folder.text).name], [200, '2026']);
  assert.deepEqual(JSON.parse((await via('GET', `${G}/drives/b!d1/items/y2026/children`)).text).value.map((i: any) => i.name), ['AGING_A_1.csv', 'AGING_B_2.csv', 'AGING_A_0.csv']);
  assert.equal((await via('GET', `${G}/drives/b!d1/items/a/content`)).text, content.a);
  assert.ok(seen.length && seen.every(a => a === 'Bearer tok'), "Graph saw the runner's token, never the run's stand-in");
  assert.deepEqual(calls().at(-1), { run: 1, name: 'graph', method: 'GET', path: '/v1.0/drives/b!d1/items/a/content', status: 200, bytes: content.a.length });
  assert.ok(methods.length && methods.every(m => m === 'GET'));
  assert.equal(logins.secret(ALICE, 'm365'), 'r1', 'the refresh token turned over and was sealed again');
});

test("the proxy refuses, with a plain 403 and why, what isn't ticked: the runner's OneDrive unticked, anyone else's, an unticked mailbox, a path climbing out, the rest of Graph", async () => {
  const refused = async (path: string, why: RegExp, headers?: Record<string, string>) => {
    const r = await via('GET', path.startsWith('https:') ? path : `${G}${path}`, { headers });
    assert.equal(r.status, 403, path);
    assert.match(r.text, why, path);
  };
  await refused('/me/drive/root/children', /is in no folder, file or SharePoint site ticked for this instance/);
  await refused(`${share('https://share.test/bobs')}/driveItem/content`, /is in no folder, file or SharePoint site ticked/);
  await refused(`/users/${AP}/messages`, /m365:mail:ap@demo.test is not ticked/);
  await refused(`/me/messages/../../users/${AP}/messages`, /m365:mail:ap@demo.test is not ticked/);
  await refused('/users', /the graph connection reaches mailboxes, and folders, files and SharePoint sites ticked for this instance, not \/users/);
  await refused('https://graph.microsoft.com/v2.0/me/messages', /Microsoft Graph, under \/v1.0\/ or \/beta\//);
  for (const out of ["/sites/host,site1,web1/getByPath(path='/sites/HR')/drive/root/children", "/sites/host,site1,web1/microsoft.graph.getByPath(path='/sites/HR')"]) await refused(out, /getByPath reaches any site by its path/);
  for (const out of ['/drives/b!d1/recent()', "/drives/b!d1/search(q='pay')", '/me/drive/sharedWithMe()', '/drives/b!d1/following', '/sites/host,site1,web1/drive/recent()', "/sites/host,site1,web1/drives/b!d1/search(q='pay')"]) await refused(out, /lists other drives' items too/);
  await refused('/sites/host,site1,web1/sites/other', /subsites are ticked by themselves/);
  await via('GET', `${G}/sites/host,site1,web1/drives`);
  assert.deepEqual([calls().at(-1)!.path, calls().at(-1)!.refused], ['/v1.0/sites/host,site1,web1/drives', undefined], "a ticked site's libraries, listed");
  for (const out of ['/drives/b!d1/items/y2026/children/zzz', "/drives/b!d1/items/y2026/children('zzz')", '/drives/b!d1/items/y2026/children(zzz)/content']) await refused(out, /not under another's children/);
  for (const out of ['/drives/b!d1/root:/Reports/y2026%2F..%2F..%2Fx.csv:/content', '/me/messages/', '/me//messages']) await refused(out, /each part of the path is a name/);
  await refused('/me/messages', /no X-HTTP-Method header, and no Prefer that redeems a sharing link/, { prefer: 'redeemSharingLink' });
  await refused('/me/messages', /no X-HTTP-Method header/, { 'x-http-method-override': 'DELETE' });
  assert.deepEqual(calls().at(-1), { run: 1, name: 'graph', method: 'GET', path: '/v1.0/me/messages', status: 403, bytes: 0, refused: 'no X-HTTP-Method header, and no Prefer that redeems a sharing link' });
  assert.equal((await via('GET', `${G}/me/messages`, { headers: { prefer: 'outlook.body-content-type="text"' } })).status, 200);
});

test('a request is for the host it was sent to, over https: a target naming another, such as //elsewhere.test/…, or http://, is refused before anything is put in', async () => {
  const before = seen.length, r = await via('GET', `${G.replace('/v1.0', '')}//elsewhere.test/v1.0/me/messages`);
  assert.deepEqual([r.status, r.text], [403, 'graph.microsoft.com takes requests for https://graph.microsoft.com, not https://elsewhere.test\n']);
  const clear = await via('GET', G, { path: 'http://graph.microsoft.com/v1.0/me/messages' });
  assert.deepEqual([clear.status, clear.text], [403, 'graph.microsoft.com takes requests for https://graph.microsoft.com, not http://graph.microsoft.com\n'], 'its token would go in the clear');
  assert.equal(seen.length, before, 'nothing reached Graph, or went on with its token');
});

test("a run reads a ticked mailbox whole: messages with their bodies, and a message's MIME", async () => {
  assert.deepEqual(JSON.parse((await via('GET', `${G}/me/messages?$select=subject,body`)).text).value.map((m: any) => m.body.content), ['The payment run is attached.', 'Lunch?']);
  const mime = await via('GET', `${G}/me/messages/m1/$value`);
  assert.deepEqual([mime.text, mime.headers['content-type']], [MIME, 'message/rfc822']);
  assert.deepEqual(calls().slice(-2).map(e => e.path), ['/v1.0/me/messages?$select=subject,body', '/v1.0/me/messages/m1/$value']);
  assert.equal((await via('GET', 'https://graph.microsoft.com/beta/me/messages/m1/$value')).text, MIME, 'beta as v1.0');
});

test('a person adds, in one box, a mailbox by its address, a site by its link, and a folder or file by any link to it', async () => {
  const { offer } = await import('../src/connections/graph.ts'), before = m365().offers.length;
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
  assert.deepEqual(m365().offers.slice(before), [
    { id: `m365:mail:${AP}`, name: `Mailbox ${AP}` }, { id: 'm365:site:host,site2,web2', name: 'Site Finance' },
    { id: 'm365:item:b!d1/top', name: 'Folder LFM, Reports' }, { id: 'm365:item:b!d1/y2025', name: 'Folder 2025, Reports' },
    { id: 'm365:item:b!own/root2', name: "Alice Ames's OneDrive" }, { id: 'm365:item:b!d1/y2026', name: 'Folder 2026, Reports' },
  ], 'the same item again replaces its offer');
});

test("a ticked folder reaches what's under it, at any depth, and a search within it; not its parent, a sibling, or a search of the whole drive", async () => {
  runs.set('run2', { ...inst, log: started(['m365:item:b!d1/y2026']) } as unknown as Instance);
  const get = (path: string) => via('GET', `${G}${path}`, { token: 'run2' });
  assert.deepEqual(JSON.parse((await get('/drives/b!d1/items/y2026/children')).text).value.map((i: any) => i.id), ['a', 'b', 'c']);
  assert.equal((await get('/drives/b!d1/items/a/content')).text, content.a, 'a file under it');
  assert.equal((await get("/drives/b!d1/items/y2026/search(q='AGING')")).status, 200);
  for (const out of ['/drives/b!d1/items/top/children', '/drives/b!d1/items/y2025/children', "/drives/b!d1/root/search(q='AGING')", '/drives/b!d1/root:/LFM:/children'])
    assert.match((await get(out)).text, /is in no folder, file or SharePoint site ticked/, out);
  assert.equal(JSON.parse((await get(`${share('https://share.test/reports')}/driveItem`)).text).id, 'y2026', 'the ticked folder, shared');
  for (const out of [`${share('https://share.test/reports')}/site/drive/root/children`, `${share('https://share.test/reports')}/list/items`]) assert.match((await get(out)).text, /reaches past what is ticked/, out);
});

test("links an answer gave go through for that run alone, as they are, with no credential put in, and logged without their token", async () => {
  const item = JSON.parse((await via('GET', `${G}/drives/b!d1/items/a`)).text);
  const download = await via('GET', item['@microsoft.graph.downloadUrl'], { headers: { authorization: '' } });
  assert.deepEqual(JSON.parse(download.text), { downloaded: true, auth: null });
  assert.deepEqual(calls().at(-1), { run: 1, name: 'graph', method: 'GET', path: 'https://host/download/a', status: 200, bytes: download.text.length });
  runs.set('other', inst);
  await assert.rejects(via('GET', item['@microsoft.graph.downloadUrl'], { token: 'other' }), /CONNECT answered 403/, "another run's, whose proxy doesn't end its host");
  assert.equal((await via('GET', `${G}/drives/b!d1/items/c/content`)).status, 200, 'a JSON file of links');
  assert.equal((await via('GET', 'https://host/download/b?tempauth=t')).status, 403, "not a link an answer gave, only a file's content");
});

test("a file's content redirected to its download address, at its drive's own site, goes through for that run alone, as the address on its driveItem does", async () => {
  runs.set('run4', inst);
  const redirect = await via('GET', `${G}/drives/b!d1/items/b/content`, { token: 'run4' });
  assert.deepEqual([redirect.status, redirect.headers.location], [302, 'https://host/download/a?tempauth=r'], "Graph's answer, as it is");
  const download = await via('GET', redirect.headers.location!, { token: 'run4', headers: { authorization: '' } });
  assert.deepEqual(JSON.parse(download.text), { downloaded: true, auth: null });
  assert.deepEqual(calls().slice(-2).map(e => [e.path, e.status]), [['/v1.0/drives/b!d1/items/b/content', 302], ['https://host/download/a', 200]]);
  await assert.rejects(via('GET', redirect.headers.location!, { token: 'other' }), /CONNECT answered 403/, "another run's");
});

test('a login Microsoft no longer renews is marked expired, and the run is told its runner signs in again', async () => {
  logins.saveLogin(ALICE, m365(), 'stale');
  const fresh = await import(`../src/entra.ts?again=${Date.now()}`);
  await assert.rejects(fresh.token(ALICE, 'm365', []), /alice@demo.test's Microsoft 365 login has expired/);
  assert.equal(m365().expired, true);
});

test("a login made through another app shows as expired from the server's start", async () => {
  logins.saveLogin(ALICE, { ...m365(), expired: false }, 'old-app');
  const fresh = await import(`../src/entra.ts?app=${Date.now()}`);
  await fresh.checkLogins([{ id: 'm365', scope: [] }]);
  assert.equal(m365().expired, true);
});

test("a refusal that names the server's own app, as when its secret expired, is the server's to mend: the login stays as it is", async () => {
  logins.saveLogin(ALICE, { ...m365(), expired: false }, 'our-secret');
  const fresh = await import(`../src/entra.ts?ours=${Date.now()}`);
  await assert.rejects(fresh.token(ALICE, 'm365', []), /Microsoft did not renew the login: AADSTS7000222/);
  assert.equal(m365().expired, false);
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

test('admins keep connections, each a name, a type and its settings', async () => {
  const { connections, removeConnection, setConnection } = await import('../src/connections.ts');
  const { websites } = await import('../src/browsers.ts');
  assert.deepEqual(connections().map(c => [c.name, c.type]), [['graph', 'graph'], ['portal', 'website'], ['adb', 'databricks']]);
  assert.deepEqual(websites().portal, { name: 'The Portal', url: 'https://portal.test/#/login', hosts: ['cdn.portal.test'], writeback: true, header: undefined, keepalive: undefined, every: undefined });
  await assert.rejects(setConnection('Portal', { type: 'website', url: 'https://portal.test' }, 'admin'), /a connection's name is/);
  await assert.rejects(setConnection('erp', { type: 'ftp' }, 'admin'), /type: one of graph, databricks, website/);
  await assert.rejects(setConnection('erp', { type: 'website', url: 'portal.test' }, 'admin'), /an http\(s\) address/);
  await assert.rejects(setConnection('erp', { type: 'website', url: 'https://erp.test', hosts: 'cdn.erp.test/x' }, 'admin'), /hosts: names/);
  await assert.rejects(setConnection('erp', { type: 'website', url: 'https://erp.test', header: 'x bot' }, 'admin'), /header: the name of a header/);
  await assert.rejects(setConnection('erp', { type: 'website', url: 'https://erp.test', keepalive: '/app/', every: '10' }, 'admin'), /every: minutes or hours/);
  for (const keepalive of ['https://sso.test/app/', 'C:/Program Files/Git/app/'])
    await assert.rejects(setConnection('erp', { type: 'website', url: 'https://erp.test', keepalive, every: '10m' }, 'admin'), /keepalive: a page of the website, by its address or path/, `${keepalive}: another host's, or a path Git Bash rewrote`);
  // What any website may reach: not another's address, nor what another connection serves, though hosts such as single sign-on's
  // they share; and a wildcard within one registrable domain, the Public Suffix List's private suffixes counting as public.
  for (const [hosts, why] of [['portal.test', /portal\.test is portal's/], ['graph.microsoft.com', /graph\.microsoft\.com is graph's/],
    ['*.co.uk', /\*\.co\.uk: a wildcard stays within one registrable domain/], ['*.github.io', /\*\.github\.io: a wildcard stays/]])
    await assert.rejects(setConnection('erp', { type: 'website', url: 'https://erp.test/', hosts }, 'admin'), why, hosts);
  await setConnection('erp', { type: 'website', url: 'https://erp.test/', hosts: 'cdn.portal.test, *.eu.sso.test' }, 'admin');
  await setConnection('erp', { type: 'website', url: 'https://erp.test/', hosts: 'cdn.erp.test, *.sso.test', writeback: 'false', header: 'x-bot-token', keepalive: '/app/', every: '1h' }, 'admin');
  assert.deepEqual(websites().erp, { name: 'erp', url: 'https://erp.test/', hosts: ['cdn.erp.test', '*.sso.test'], writeback: false, header: 'x-bot-token', keepalive: '/app/', every: 60 });
  await setConnection('erp', { type: 'website', url: 'https://erp.test/', keepalive: 'https://erp.test/app/' }, 'admin');
  assert.deepEqual([websites().erp.keepalive, websites().erp.every], ['https://erp.test/app/', undefined], 'a page by its address, as given, and no every, for the default');
  await setConnection('erp', { type: 'website', url: 'https://erp.test/', every: '8m' }, 'admin');
  assert.deepEqual([websites().erp.keepalive, websites().erp.every], [undefined, 8], 'how often, and no page, for its address');
  removeConnection('erp');
  assert.throws(() => removeConnection('erp'), /no connection erp/);
});

test('the proxy reaches nothing, not even what a tick is checked against, for a runner who can no longer lend their login', async () => {
  const { upsertUser } = await import('../src/auth.ts'), before = methods.length;
  upsertUser(ALICE, { disabled: true });
  assert.match((await via('GET', `${G}/drives/b!d1/items/y2026/children`)).text, /can no longer run this instance/);
  const { saveLogin, signOut } = await import('../src/logins.ts'), n = asked.length;
  saveLogin(ALICE, { id: 'openrouter', kind: 'key', name: 'OpenRouter', account: ALICE, since: '2026-11-04T00:00:00Z', offers: [], enabled: true } as never, 'sk-or-alice');
  assert.match((await via('POST', `${O}/chat/completions`, json({ model: 'x', messages: [] }))).text, /can no longer run this instance/, "nor their own model key, nor the server's in its place");
  signOut(ALICE, 'openrouter');
  upsertUser(ALICE, { disabled: false });
  assert.deepEqual([methods.length, asked.length], [before, n], 'no request reached Graph or OpenRouter');
});

test('rf delivered records an output delivered, with where it went and its receipt', async () => {
  assert.equal((await call('/agent/delivered', { args: ['pack', '--to', 'E1, batch 4471', '--receipt', 'document 81234'] }))!.status, 200);
  assert.deepEqual(log.at(-1), { op: 'delivered', data: { item: 'pack', to: 'E1, batch 4471', receipt: 'document 81234', run: 1 } });
  await assert.rejects(call('/agent/delivered', { args: ['nope', '--to', 'x', '--receipt', 'y'] }), /nope is no output on the screen/);
  await assert.rejects(call('/agent/delivered', { args: ['pack', '--to', 'x'] }), /rf delivered ITEM --to WHERE --receipt WHAT/);
});

test('writes go within the ticks: a file saved into a ticked folder, a message sent from a ticked mailbox, and a large attachment through its upload session', async () => {
  const saved = await via('PUT', `${G}/drives/b!d1/items/y2026:/report.xlsx:/content`, { body: 'PK report', headers: { 'content-type': 'application/octet-stream' } });
  assert.deepEqual([saved.status, JSON.parse(saved.text).id, writes.at(-1)!.body.toString()], [201, 'new1', 'PK report'], 'a new file, by its path under a folder the ticked site holds');
  const file = '{"parentReference": {"id": "y2025"}, "n": 12345678901234567890}';
  assert.deepEqual([(await via('PUT', `${G}/drives/b!d1/items/y2026:/report.xlsx:/content`, { body: file, headers: { 'content-type': 'application/json' } })).status, writes.at(-1)!.body.toString()], [201, file], "a JSON file's content, as its bytes");
  assert.equal((await via('POST', `${G}/me/sendMail`, json({ message: { subject: 'Pack', toRecipients: [{ emailAddress: { address: 'controller@demo.test' } }] } }))).status, 202);
  const [send, answer] = log.slice(-2);
  assert.deepEqual([send.op, send.data, answer.op, answer.data.sent], ['send', { run: answer.data.run, name: answer.data.name, method: 'POST', path: '/v1.0/me/sendMail' }, 'call', log.length - 1], 'a write is logged as it goes too, and its answer names it, so a cut leaves it as sent');
  assert.equal((await via('POST', `${G}/me/messages`, json({ subject: 'Pack' }))).status, 201);
  const session = JSON.parse((await via('POST', `${G}/me/messages/d1/attachments/createUploadSession`, json({ AttachmentItem: { attachmentType: 'file', name: 'pack.xlsx', size: 9 } }))).text);
  assert.equal((await via('PUT', session.uploadUrl, { body: 'PK pack!!', headers: { 'content-range': 'bytes 0-8/9', authorization: '' } })).status, 201);
  assert.deepEqual([writes.at(-1)!.path, writes.at(-1)!.auth], ['/upload/s1', undefined], 'the link as it is, with no token of ours');
  assert.equal(calls().at(-1)!.path, 'https://outlook.office.com/upload/s1', "the link's own token isn't logged");
  assert.equal((await via('POST', `${G}/me/messages/d1/send`)).status, 202);
});

test('a write whose run hangs up before its answer is read, as a run cut does, is logged as answered all the same', async () => {
  const from = log.length;
  assert.equal((await via('PUT', `${G}/drives/b!d1/items/y2026:/big.xlsx:/content`, { body: 'PK big', headers: { 'content-type': 'application/octet-stream' }, cut: true })).status, 201);
  for (let i = 0; !log.slice(from).some(e => e.op === 'call'); i++) {
    assert.ok(i < 100, 'its answer is logged');
    await new Promise(r => setTimeout(r, 50));
  }
  const [send, answer] = log.slice(from);
  assert.deepEqual([send.op, send.data.path, answer.op, answer.data.sent, answer.data.status, answer.data.bytes > 1 << 22], ['send', '/v1.0/drives/b!d1/items/y2026:/big.xlsx:/content', 'call', from + 1, 201, true]);
});

test("writes share nothing, and make, move or copy nothing outside the ticks; mail goes out as the ticked mailbox, in JSON or in MIME whose one From is it", async () => {
  runs.set('run3', { ...inst, log: started(['m365:item:b!d1/y2026', `m365:mail:${ALICE}`]) } as unknown as Instance);
  const write = (method: string, path: string, body: unknown) => via(method, `${G}${path}`, { token: 'run3', ...json(body) }), before = writes.length;
  for (const [method, path, body, why] of [
    ['POST', '/drives/b!d1/items/a/createLink', { type: 'view', scope: 'anonymous' }, /would share it/],
    ['POST', '/drives/b!d1/items/a/invite', { recipients: [] }, /would share it/],
    ['POST', '/drives/b!d1/items/a/graph.createLink', { type: 'view', scope: 'anonymous' }, /would share it/],
    ['POST', '/drives/b!d1/items/y2026/subscriptions', { notificationUrl: 'https://elsewhere.test/hook' }, /would share it/],
    ['POST', '/drives/b!d1/items/a/assignSensitivityLabel', { sensitivityLabelId: 'none' }, /would share it/],
    ['POST', '/sites/host,site1,web1/onenote/notebooks/n1/copyNotebook', { siteId: 'elsewhere' }, /would copy it where no tick reaches/],
    ['PATCH', '/drives/b!d1/items/a', { ParentReference: { id: 'y2025' } }, /would put it in a folder no tick covers/],
    ['PATCH', '/drives/b!d1/items/a', { parentReference: { id: 'y2026', Path: '/drive/root:/x' } }, /name the folder by its parentReference's id/],
    ['POST', '/me/sendMail', { Message: { from: { emailAddress: { address: AP } } } }, /mail from alice@demo.test goes out as alice@demo.test/],
    ['POST', '/me/sendMail/', {}, /each part of the path is a name/],
    ['POST', '/me/mailFolders/inbox/messageRules', { actions: { forwardTo: [] } }, /would share it/],
    ['PATCH', '/drives/b!d1/items/a', { parentReference: { id: 'y2025' } }, /would put it in a folder no tick covers/],
    ['POST', '/drives/b!d1/items/a/copy', { parentReference: { driveId: 'b!d1', id: 'top' } }, /would put it in a folder no tick covers/],
    ['PATCH', '/drives/b!d1/items/a', { parentReference: { path: '/drives/b!own/root:' } }, /name the folder by its parentReference's id/],
    ['POST', `/users/${AP}/sendMail`, {}, /m365:mail:ap@demo.test is not ticked/],
    ['POST', '/me/sendMail', { message: { from: { emailAddress: { address: AP } } } }, /mail from alice@demo.test goes out as alice@demo.test/],
  ] as [string, string, unknown, RegExp][]) {
    const r = await write(method, path, body);
    assert.equal(r.status, 403, path);
    assert.match(r.text, why, path);
  }
  const site = await write('POST', '/sites/host,site1,web1/lists/l1/items', {});
  assert.deepEqual([site.status, site.text], [409, "this server's Microsoft 365 logins don't write SharePoint sites: RF_M365_SCOPES has no Sites.ReadWrite.All\n"], "the server's to change");
  assert.match((await via('PUT', `${G}/drives/b!d1/items/y2025:/x.csv:/content`, { token: 'run3', body: 'x' })).text, /is in no folder, file or SharePoint site ticked/);
  assert.match((await via('PATCH', `${G}/drives/b!d1/items/a`, { token: 'run3', body: JSON.stringify({ parentReference: { id: 'y2025' } }), headers: { 'content-type': 'text/plain' } })).text, /a write's body is a JSON object/);
  assert.equal(writes.length, before, 'none reached Graph');
  // Mail as MIME goes out as its From, so its headers must parse cleanly, with one From, the ticked mailbox it is sent from.
  const mime = (...headers: string[]) => Buffer.from([...headers, 'To: controller@demo.test', 'Subject: Pack', '', 'The pack is attached.'].join('\r\n')).toString('base64');
  const sendMime = (body: string, headers?: Record<string, string>, path = '/me/sendMail') => via('POST', `${G}${path}`, { token: 'run3', body, headers: { 'content-type': 'text/plain', ...headers } });
  for (const [body, why] of [
    [mime(`From: ${ALICE}`, `From: ${AP}`), /a message has one From header, not 2/],
    [mime('From: Alice', ` <${AP}>`), /mail from alice@demo.test goes out as alice@demo.test, not ap@demo.test/],
    [mime(`From: <=?utf-8?Q?alice?=@demo.test>`), /its From is one plain address/],
    [mime(`From: =?utf-8?B?${Buffer.from(ALICE).toString('base64')}?=`), /its From is one plain address/],
    [mime(`From: ${ALICE}`, `Sender: ${AP}`), /its Sender header would name another sender/],
    [mime(`From: ${ALICE}`, `Resent-From: ${AP}`), /its Resent-From header/],
    [mime(`From: ${ALICE}`, `resent-sender: ${AP}`), /its Resent-Sender header/],
    [mime(`From: Finance: ${ALICE};`), /its From is one plain address/],
    [mime(`From: ${ALICE}, ${AP}`), /its From is one plain address/],
    [mime(`From: ${ALICE} (${AP})`), /its From is one plain address/],
    [mime(`From : ${ALICE}`), /its MIME header "From : alice@demo.test" doesn't parse/],
    [mime('To: controller@demo.test'), /a message has one From header, not 0/],
    ['not base64!', /mail is a JSON object, or MIME in base64 as text\/plain/],
  ] as [string, RegExp][]) {
    const r = await sendMime(body);
    assert.equal(r.status, 403, Buffer.from(body, 'base64').toString().split('\r\n')[0]);
    assert.match(r.text, why);
  }
  assert.match((await sendMime(mime(`From: ${ALICE}`), { 'content-type': 'application/octet-stream' })).text, /MIME in base64 as text\/plain/);
  assert.equal(writes.length, before, 'none reached Graph');
  const sent = mime('From: "Ames, Alice"', `\t<${ALICE}> `);
  assert.equal((await sendMime(sent)).status, 202, 'a folded From, with a display name');
  assert.equal(writes.at(-1)!.body.toString(), sent, 'as it came');
  assert.equal((await sendMime(mime(`From: ${ALICE.toUpperCase()}`), { 'transfer-encoding': 'chunked' })).status, 202);
  assert.equal((await sendMime(mime(`From: Alice Ames <${ALICE}>`), {}, '/me/messages')).status, 201, 'a draft, which is sent as it was made');
  // A key twice: Graph gets the JSON the check read, not bytes it might read otherwise.
  const twice = `{"message": {"from": {"emailAddress": {"address": "${AP}"}}, "from": {"emailAddress": {"address": "${ALICE}"}}, "subject": "Pack"}}`;
  assert.equal((await via('POST', `${G}/me/sendMail`, { token: 'run3', body: twice, headers: { 'content-type': 'application/json' } })).status, 202);
  assert.equal(writes.at(-1)!.body.toString(), JSON.stringify({ message: { from: { emailAddress: { address: ALICE } }, subject: 'Pack' } }));
  assert.equal((await write('PATCH', '/drives/b!d1/items/a', { name: 'aging.csv' })).status, 200, 'a rename in place');
});

test("a person adds a SQL warehouse to their Databricks login by its link, checked by reading it as them", async () => {
  const { addWarehouse } = await import('../src/connections/databricks.ts');
  await addWarehouse(ALICE, 'adb', 'https://adb-1.azuredatabricks.net/sql/warehouses/wh1?o=123');
  assert.deepEqual(logins.logins(ALICE).find(l => l.id === 'adb')!.offers, [{ id: 'adb:adb-1.azuredatabricks.net/wh1', name: 'Warehouse Finance, adb-1.azuredatabricks.net' }], 'the same twice is one');
  await assert.rejects(addWarehouse(ALICE, 'adb', 'https://adb-1.azuredatabricks.net/sql/warehouses/nope'), /Databricks answered 404 NOT_FOUND/);
  for (const link of ['https://adb-1.test/sql/warehouses/wh1', 'https://adb-1.azuredatabricks.net/jobs/1'])
    await assert.rejects(addWarehouse(ALICE, 'adb', link), /a link to a SQL warehouse of an Azure Databricks workspace/, link);
});

test("a run queries Databricks at its own address as the runner: statements on a warehouse ticked for its instance, whatever they do, as the runner's own grants allow, their results through the links they give, and the catalogue", async () => {
  runs.set('dbx', { ...inst, log: started(['adb:adb-1.azuredatabricks.net/wh1']) } as unknown as Instance);
  const D = 'https://adb-1.azuredatabricks.net', go = (method: string, path: string, body?: unknown) => via(method, `${D}${path}`, { token: 'dbx', ...(body !== undefined && json(body)) });
  const r = await go('POST', '/api/2.0/sql/statements', { statement: '-- open items\nSELECT customer, open FROM ar', warehouse_id: 'wh1', disposition: 'EXTERNAL_LINKS', format: 'CSV' });
  assert.equal(r.status, 200);
  assert.deepEqual(statements.at(-1), { statement: '-- open items\nSELECT customer, open FROM ar', warehouse_id: 'wh1', disposition: 'EXTERNAL_LINKS', format: 'CSV' }, 'as the run sent it');
  const chunk = await via('GET', JSON.parse(r.text).result.external_links[0].external_link, { token: 'dbx', headers: { authorization: '' } });
  assert.deepEqual([chunk.text, chunk.headers['x-auth']], ['customer,open\nAcme,10\n', 'undefined'], 'the chunk as it is, with no token');
  assert.equal((await go('GET', '/api/2.0/sql/statements/s1')).status, 200);
  assert.deepEqual(JSON.parse((await go('GET', '/api/2.1/unity-catalog/catalogs')).text).catalogs, [{ name: 'finance' }]);
  assert.equal((await go('POST', '/api/2.0/sql/statements', { statement: 'DROP TABLE ar_old', warehouse_id: 'wh1' })).status, 200, 'whatever it does, Unity Catalog deciding');
  const { types } = await import('../src/connections.ts');
  assert.deepEqual(types.databricks.env!({ name: 'adb', type: 'databricks' } as never, ['m365:onedrive', 'adb:adb-1.azuredatabricks.net/wh1']), { DATABRICKS_TOKEN: 'rf', DATABRICKS_HOST: 'https://adb-1.azuredatabricks.net', DATABRICKS_WAREHOUSE_ID: 'wh1' }, "its CLI's and SDK's, the first warehouse ticked");
  const before = statements.length;
  for (const [method, path, body, why] of [
    ['POST', '/api/2.0/sql/statements', { statement: 'SELECT 1', warehouse_id: 'other' }, /adb:adb-1\.azuredatabricks\.net\/other is not ticked for this instance/],
    ['POST', '/api/2.0/sql/statements', { statement: 'SELECT 1' }, /a statement names its warehouse_id, one ticked for the instance: wh1/],
    ['POST', '/api/2.0/jobs/run-now', { job_id: 1 }, /adb takes statements/],
    ['GET', '/api/2.0/clusters/list', undefined, /adb takes statements/],
  ] as [string, string, unknown, RegExp][]) {
    const x = await go(method, path, body);
    assert.equal(x.status, 403, path);
    assert.match(x.text, why, path);
  }
  assert.equal(statements.length, before, 'none reached the warehouse');
  assert.match((await via('GET', `${D}/api/2.1/unity-catalog/catalogs`)).text, /adb:adb-1\.azuredatabricks\.net is not ticked for this instance/, 'a run that ticked no warehouse there');
  const adb = logins.logins(ALICE).find(l => l.id === 'adb')!;
  logins.saveLogin(ALICE, { ...adb, since: new Date().toISOString() }, 'stale');
  const gone = await go('GET', '/api/2.1/unity-catalog/catalogs');
  assert.deepEqual([gone.status, gone.text], [409, "alice@demo.test's Databricks adb login has expired: they sign in to it again on the Logins page\n"]);
  assert.deepEqual(log.filter(e => e.op === 'expired').at(-1)!.data, { run: 1, login: 'adb', name: 'Databricks adb', runner: ALICE }, 'the instance carries on once they sign in again');
  assert.equal(calls().at(-1)!.status, 409);
});

const O = 'https://openrouter.ai/api/v1';

test("OpenRouter is every run's, with the server's key put in for the run's: its inference asks only for providers that don't collect its data, and what each answer cost, whole or streamed, adds to the run's", async () => {
  const before = callRuns.get('run')?.cost ?? 0, ask = { model: 'openai/gpt-5-mini', messages: [{ role: 'user', content: 'Hi' }] };
  const chat = await via('POST', `${O}/chat/completions`, json({ ...ask, provider: { sort: 'price', data_collection: 'allow' } }));
  assert.deepEqual([chat.status, JSON.parse(chat.text).choices[0].message.content], [200, 'Hello']);
  assert.deepEqual(asked.at(-1), { path: '/api/v1/chat/completions', auth: 'Bearer the-openrouter-key', key: 'the-openrouter-key', body: { ...ask, provider: { sort: 'price', data_collection: 'deny' } } });
  assert.deepEqual(calls().at(-1), { run: 1, name: 'openrouter', method: 'POST', path: '/api/v1/chat/completions', status: 200, bytes: chat.text.length, model: 'openai/gpt-5-mini', cost: 0.001 });
  let go!: () => void;
  held = new Promise(ok => (go = ok));
  const message = await via('POST', `${O}/messages`, { body: JSON.stringify({ model: 'anthropic/claude-opus-5.5', max_tokens: 9, messages: [], stream: true }), headers: { 'content-type': 'application/json', authorization: '', 'x-api-key': 'rf' }, data: b => String(b).includes('message_start') && go() });
  assert.match(message.text, /^: OPENROUTER PROCESSING\n\ndata: \{"type":"message_start"[^]*data: \[DONE\]\n\n$/, 'the stream as it came, its first event before the rest was sent');
  assert.deepEqual([asked.at(-1)!.key, (asked.at(-1)!.body as any).provider, calls().at(-1)!.cost], ['the-openrouter-key', { data_collection: 'deny' }, 0.002], "Anthropic's SDKs' x-api-key");
  await via('POST', `${O}/responses`, json({ model: 'openai/gpt-5-mini', input: 'Hi', stream: true }));
  assert.equal(calls().at(-1)!.cost, 0.004, "a response's, in its last event");
  assert.deepEqual([(await via('GET', `${O}/models`)).status, calls().at(-1)!.cost], [200, 0]);
  assert.equal(+(callRuns.get('run')!.cost - before).toFixed(6), 0.007);
});

test("OpenRouter takes any request, with the run's key, and whatever body one carries, by any method to any path, is a JSON object, which goes on asking only for providers that don't collect its data", async () => {
  const before = asked.length;
  await via('GET', `${O}/credits`);
  await via('POST', 'https://openrouter.ai/api/alpha/responses', json({ model: 'x', input: 'Hi' }));
  assert.deepEqual(asked.slice(before).map(a => [a.path, a.key, a.body]), [['/api/v1/credits', 'the-openrouter-key', undefined], ['/api/alpha/responses', 'the-openrouter-key', { model: 'x', input: 'Hi', provider: { data_collection: 'deny' } }]]);
  const body = '{"model":"x","provider":{"data_collection":"allow"}}';
  for (const method of ['POST', 'PUT', 'DELETE']) assert.match((await via(method, `${O}/chat/completions`, { body, headers: { 'content-length': String(body.length) } })).text, /its body is a JSON object, sent as application\/json/, method);
  assert.equal(asked.length, before + 2, 'none of those reached OpenRouter');
});

test("Exa is every run's too, with the server's key: a search, whose cost adds to the run's, or anything else, and nothing once the server has no key", async () => {
  const before = callRuns.get('run')?.cost ?? 0;
  const found = await via('POST', 'https://api.exa.ai/search', { body: JSON.stringify({ query: 'Larkfield refinancing' }), headers: { 'content-type': 'application/json', authorization: '', 'x-api-key': 'rf' } });
  assert.equal(found.status, 200);
  assert.deepEqual(asked.at(-1), { path: '/search', auth: 'Bearer the-exa-key', key: 'the-exa-key', body: { query: 'Larkfield refinancing' } });
  assert.deepEqual(calls().at(-1), { run: 1, name: 'exa', method: 'POST', path: '/search', status: 200, bytes: found.text.length, cost: 0.005 });
  assert.equal(+(callRuns.get('run')!.cost - before).toFixed(6), 0.005);
  const n = asked.length;
  await via('POST', 'https://api.exa.ai/websets/v0/websets', json({}));
  assert.deepEqual([asked.at(-1)!.path, asked.at(-1)!.key], ['/websets/v0/websets', 'the-exa-key'], 'any request');
  delete process.env.EXA_API_KEY;
  await assert.rejects(via('POST', 'https://api.exa.ai/search', json({ query: 'x' })), /CONNECT answered 403/);
  process.env.EXA_API_KEY = 'the-exa-key';
  assert.equal(asked.length, n + 1, 'none once the server has no key');
});

test('a login Microsoft asks to consent to what the server asks for anew renews with what it has, and says what its person reconnects to grant', async () => {
  const { ungranted } = await import('../src/auth.ts'), fresh = await import(`../src/entra.ts?consent=${Date.now()}`), scope = ['https://graph.microsoft.com/Mail.Send'];
  logins.saveLogin(ALICE, { ...m365(), expired: false, scopes: ['Mail.ReadWrite', 'Files.Read.All', 'Sites.Read.All'] }, 'unconsented');
  assert.equal(await fresh.token(ALICE, 'm365', scope), 'tok');
  assert.deepEqual(ungranted(m365()), ['Mail.ReadWrite.Shared', 'Mail.Send', 'Mail.Send.Shared', 'Files.ReadWrite.All']);
  const n = refreshes;
  await fresh.token(ALICE, 'm365', scope);
  logins.saveLogin(ALICE, { ...m365(), since: new Date().toISOString() });
  await fresh.token(ALICE, 'm365', scope);
  assert.equal(refreshes, n + 1, 'a token is kept until its login is signed in to again');
});
