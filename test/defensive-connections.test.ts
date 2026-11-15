import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Instance } from '../src/store.ts';

const USER = 'alice@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-def-conn-')), instDir = join(tmp, 'instances', 'i1'), seriesDir = join(tmp, 'series', 's1');
const calls: { op: string; data: any }[] = [];
const upstreamPaths: string[] = [];

let upstream: Server, proxy: Server;
let sock = '', ca = '';
let loginsMod: typeof import('../src/logins.ts');
let connMod: typeof import('../src/connections.ts');
const runs = new Map<string, Instance>(), callRuns = new Map<string, import('../src/connections.ts').CallRun>();

const started = (ticks: string[]) => [
  { seq: 1, op: 'create', by: USER, logins: ticks },
  { seq: 2, op: 'run', run: 1, runner: USER, consent: 1 },
];

function makeInst(ticks: string[]): Instance {
  return {
    id: 'i1',
    dir: instDir,
    seriesId: 's1',
    log: started(ticks),
    doc: { items: [] },
    series: () => seriesDir,
    append: (_by: string, op: string, data: any) => {
      calls.push({ op, data });
      return { seq: calls.length };
    },
  } as unknown as Instance;
}

async function viaProxy(method: string, url: string, o: { token?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const u = new URL(url), token = o.token ?? 't1';
  const socket = await new Promise<Socket>((ok, fail) =>
    request({
      socketPath: sock,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { 'proxy-authorization': `Basic ${Buffer.from(`rf:${token}`).toString('base64')}` },
    })
      .on('connect', (r, s) => (r.statusCode === 200 ? ok(s) : fail(new Error(`CONNECT ${r.statusCode}`))))
      .on('error', fail)
      .end(),
  );
  const tls = tlsConnect({ socket, servername: u.hostname, ca, ALPNProtocols: ['http/1.1'] });
  return new Promise((ok, fail) => {
    const r = httpsRequest(
      { host: u.hostname, path: o.path ?? u.pathname + u.search, method, headers: { authorization: 'Bearer rf', ...o.headers }, createConnection: () => tls },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', b => chunks.push(b)).on('end', () => ok({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
      },
    );
    r.on('error', fail);
    r.end(o.body);
  });
}

const shareToken = Buffer.from('https://share.test/folderA').toString('base64url');

before(async () => {
  mkdirSync(join(instDir, 'working'), { recursive: true });
  mkdirSync(seriesDir, { recursive: true });

  upstream = createServer((req, res) => {
    upstreamPaths.push(req.url!);
    const u = new URL(req.url!, 'http://x');
    const send = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    if (u.pathname === '/.well-known/openid-configuration') {
      return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
    }
    if (u.pathname === '/token') {
      return send({ access_token: 'atok', refresh_token: 'rtok', expires_in: 3600 });
    }

    // Graph mock using exact canonical paths
    if (u.pathname === '/v1.0/drives/b!d1' && u.searchParams.get('$select') === 'sharePointIds') {
      return send({ driveType: 'documentLibrary', sharePointIds: { siteUrl: 'https://sp.demo.test/sites/fin', siteId: 's1', webId: 'w1' } });
    }
    if (u.pathname === `/v1.0/shares/u!${shareToken}/driveItem`) {
      return send({ id: 'folderA', name: 'FolderA', folder: {}, parentReference: { driveId: 'b!d1', id: 'root1' } });
    }
    if (u.pathname === `/v1.0/shares/u!${shareToken}/items/child1`) {
      return send({ id: 'child1', name: 'child1.csv', file: {}, parentReference: { driveId: 'b!d1', id: 'folderA' } });
    }
    if (u.pathname === `/v1.0/shares/u!${shareToken}/items/outside1`) {
      return send({ id: 'outside1', name: 'outside1.csv', file: {}, parentReference: { driveId: 'b!d1', id: 'otherFolder' } });
    }
    if (u.pathname === '/v1.0/drives/b!d1/items/otherFolder') {
      return send({ id: 'otherFolder', name: 'Other', folder: {}, parentReference: { driveId: 'b!d1', id: 'root1' } });
    }
    if (u.pathname === '/v1.0/drives/b!d1/items/root1') {
      return send({ id: 'root1', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!d1' } });
    }
    if (u.pathname === '/v1.0/drives/b!d1/items/folderA') {
      return send({ id: 'folderA', name: 'FolderA', folder: {}, parentReference: { driveId: 'b!d1', id: 'root1' } });
    }
    if (u.pathname === '/v1.0/drives/b!d1/root:/FolderA/report%20%231.xlsx:') {
      return send({ id: 'rep1', name: 'report #1.xlsx', file: {}, parentReference: { driveId: 'b!d1', id: 'folderA' } });
    }
    if (u.pathname === '/v1.0/drives/b!d1/root:/FolderA/report%20%231.xlsx:/content') {
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end('report-bytes');
    }
    if (u.pathname === '/v1.0/me/drive/items/child1' || u.pathname === `/v1.0/users/${USER}/drive/items/child1`) {
      return send({ id: 'child1', name: 'child1.csv', file: {}, parentReference: { driveId: 'b!d1', id: 'folderA' } });
    }
    if (u.pathname === '/v1.0/drives/b!d1/items/child1') {
      if (u.searchParams.get('$select') === 'id,name') {
        return send({ id: 'child1', name: 'child1.csv', '@microsoft.graph.downloadUrl': 'https://sp.demo.test/dl/child1' });
      }
      return send({ id: 'child1', name: 'child1.csv', file: {}, parentReference: { driveId: 'b!d1', id: 'folderA' } });
    }
    if (u.pathname === '/api/2.0/sql/statements' && req.method === 'POST') {
      return send({ statement_id: 's1', status: { state: 'SUCCEEDED' } });
    }
    if (u.pathname === '/api/2.0/sql/statements/s1/result/chunks/0' && req.method === 'GET') {
      return send({ chunk_index: 0 });
    }
    if (u.pathname === '/api/2.0/sql/statements/s1/cancel' && req.method === 'POST') {
      return send({});
    }
    if (u.pathname.startsWith('/api/2.1/unity-catalog/')) {
      return send({ path: u.pathname });
    }
    return send({ error: { code: 'invalidRequest', message: `unexpected ${u.pathname}${u.search}` } }, 400);
  });
  await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  process.env.RF_OIDC_ISSUER = base;
  process.env.RF_OIDC_CLIENT_ID = 'app';
  process.env.RF_OIDC_CLIENT_SECRET = 'secret';
  process.env.RF_PUBLIC_URL = 'https://rf.demo.test';

  const { initSystem, saveTree } = await import('../src/system.ts');
  initSystem(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [USER], members: [] } }, series: { s1: { name: 'S1', workspace: 'w' } } });
  const auth = await import('../src/auth.ts');
  auth.upsertUser(USER, { role: 'user' });

  const graphMod = await import('../src/connections/graph.ts');
  graphMod.endpoints.graph = base;

  loginsMod = await import('../src/logins.ts');
  loginsMod.saveLogin(USER, {
    id: 'm365',
    kind: 'm365',
    name: 'Microsoft 365',
    account: USER,
    since: '2026-11-15T00:00:00Z',
    offers: [{ id: 'm365:item:b!d1/folderA', name: 'FolderA' }],
  }, 'rtok');

  connMod = await import('../src/connections.ts');
  await connMod.setConnection('m365', { type: 'graph' }, USER);
  await connMod.setConnection('adb', { type: 'databricks' }, USER);
  connMod.upstreams['graph.microsoft.com'] = base;
  connMod.upstreams['adb-1.azuredatabricks.net'] = base;
  loginsMod.saveLogin(USER, {
    id: 'adb',
    kind: 'databricks',
    name: 'Databricks adb',
    account: USER,
    since: '2026-11-15T00:00:00Z',
    offers: [{ id: 'adb:adb-1.azuredatabricks.net/wh1', name: 'Warehouse 1' }],
  }, 'rtok');

  const { bundle } = await import('../src/ca.ts');
  const { serveSandboxes } = await import('../src/sandbox.ts');
  ca = bundle();
  sock = join(tmp, 'rf.sock');
  proxy = serveSandboxes({
    agent: async (_q, s) => void s.writeHead(404).end(),
    run: token => {
      if (!runs.has(token)) return undefined;
      if (!callRuns.has(token)) callRuns.set(token, { inst: runs.get(token)!, n: 1, links: new Map(), cost: 0 });
      const r = callRuns.get(token)!;
      return { egress() {}, browsers: () => { throw new Error('no browsers'); }, intercepts: h => connMod.intercepts(r, h), call: (h, q, s) => connMod.call(r, h, q, s) };
    },
  }).listen(sock);
  await once(proxy, 'listening');
});

after(async () => {
  proxy?.close();
  upstream?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('Graph canonicalizes percent-encoded resource segments and colon paths consistently across lookup and forwarding', async () => {
  const inst = makeInst(['m365:item:b!d1/folderA']);
  runs.set('g1', inst);
  callRuns.set('g1', { inst, n: 1, links: new Map(), cost: 0 });
  calls.length = 0;
  upstreamPaths.length = 0;

  // 1. Valid %3A-encoded colon path with encoded filename characters resolves and forwards canonically
  const colonRes = await viaProxy('GET', 'https://graph.microsoft.com/v1.0/drives/b!d1/root%3A/FolderA/report%20%231.xlsx%3A/content', { token: 'g1' });
  assert.equal(colonRes.status, 200);
  assert.equal(colonRes.text, 'report-bytes');
  assert.ok(upstreamPaths.includes('/v1.0/drives/b!d1/root:/FolderA/report%20%231.xlsx:/content'));

  // 2. Percent-encoded /me and /items segments address the same canonical item as decoded segments
  const meRes = await viaProxy('GET', 'https://graph.microsoft.com/v1.0/%6de/drive/%69tems/child1', { token: 'g1' });
  assert.equal(meRes.status, 200);
  assert.equal(JSON.parse(meRes.text).id, 'child1');

  // 3. Share sub-item outside ticked folder is refused 403 even when /items is percent-encoded
  const outRes = await viaProxy('GET', `https://graph.microsoft.com/v1.0/shares/u!${shareToken}/%69tems/outside1`, { token: 'g1' });
  assert.equal(outRes.status, 403);

  // 4. Malformed percent-encoding is refused 403, not 502
  const badEnc = await viaProxy('GET', 'https://graph.microsoft.com/v1.0/drives/b!d1/items/x', {
    token: 'g1',
    path: '/v1.0/drives/b!d1/items/%E0%A4%A',
  });
  assert.equal(badEnc.status, 403);

  // 5. Partial $select response with downloadUrl but no parentReference logs 200 without /drives/undefined failure
  calls.length = 0;
  const selectRes = await viaProxy('GET', 'https://graph.microsoft.com/v1.0/drives/b!d1/items/child1?$select=id,name', { token: 'g1' });
  assert.equal(selectRes.status, 200);
  assert.equal(calls.at(-1)?.data.status, 200);
  assert.equal(upstreamPaths.some(p => p.includes('/drives/undefined')), false);
});

test('Databricks rejects malformed or ambiguous path segments while allowing valid SQL and Unity Catalog paths', async () => {
  const inst = makeInst(['adb:adb-1.azuredatabricks.net/wh1']);
  runs.set('d1', inst);
  callRuns.set('d1', { inst, n: 1, links: new Map(), cost: 0 });
  upstreamPaths.length = 0;

  const D = 'https://adb-1.azuredatabricks.net';
  for (const [method, path, body] of [
    ['POST', '/api/2.0/sql/statements', JSON.stringify({ statement: 'SELECT 1', warehouse_id: 'wh1' })],
    ['GET', '/api/2.0/sql/statements/s1/result/chunks/0', undefined],
    ['POST', '/api/2.0/sql/statements/s1/cancel', '{}'],
    ['GET', '/api/2.1/unity-catalog/tables/main.finance.gl_2026', undefined],
    ['GET', '/api/2.1/unity-catalog/catalogs/', undefined],
  ] as const) {
    const r = await viaProxy(method, `${D}${path}`, {
      token: 'd1',
      ...(body !== undefined && { body, headers: { 'content-type': 'application/json' } }),
    });
    assert.equal(r.status, 200, `expected 200 for ${method} ${path}, got ${r.status}: ${r.text}`);
  }

  const beforeBad = upstreamPaths.length;
  for (const badPath of [
    '/api/2.1/unity-catalog//catalogs',
    '/api/2.1/unity-catalog/./catalogs',
    '/api/2.1/unity-catalog/../2.1/unity-catalog/catalogs',
    '/api/2.1/unity-catalog/.;v=1/catalogs',
    '/api/2.1/unity-catalog/..;v=1/catalogs',
    '/api/2.1/unity-catalog/catalogs%2fextra',
    '/api/2.1/unity-catalog/catalogs%5cextra',
    '/api/2.1/unity-catalog/catalogs%00',
    '/api/2.1/unity-catalog/%252e/catalogs',
    '/api/2.1/unity-catalog/%E0%A4%A',
  ]) {
    const r = await viaProxy('GET', `${D}/api/2.1/unity-catalog/catalogs`, { token: 'd1', path: badPath });
    assert.equal(r.status, 403, `expected 403 for ${badPath}, got ${r.status}: ${r.text}`);
  }
  assert.equal(upstreamPaths.length, beforeBad, 'rejected paths must not be forwarded upstream');
});
