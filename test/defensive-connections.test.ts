import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';
import { writeJson } from '../src/system.ts';
import { ownSeries } from './owner-fixture.ts';
import { openStore } from '../src/store.ts';
import type { Instance } from '../src/store.ts';

const USER = 'alice@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-def-conn-')), instDir = join(tmp, 'instances', 'i1'), seriesDir = join(tmp, 'series', 's1');
const calls: { op: string; data: any }[] = [];
const upstreamPaths: string[] = [];

let tokenCalls = 0;
let tokenGate: PromiseWithResolvers<void> | undefined;
let tokenEntered: PromiseWithResolvers<void> | undefined;
let sendGate: PromiseWithResolvers<void> | undefined;
let sendEntered: PromiseWithResolvers<void> | undefined;
let upstream: Server, proxy: Server;
let sock = '', ca = '';
let loginsMod: typeof import('../src/logins.ts');
let connMod: typeof import('../src/connections.ts');
const runs = new Map<string, Instance>(), callRuns = new Map<string, import('../src/connections.ts').CallRun>();

const started = (ticks: string[]) => [
  { seq: 1, op: 'create', by: USER },
  { seq: 2, op: 'run', run: 1, runner: USER, initiator: USER, authority: { version: 1, owner: USER, epoch: seriesSettings(seriesDir).epoch, workspace: 'w', logins: ticks, autonomous: false } },
];

function makeInst(ticks: string[]): Instance {
  ownSeries('s1', USER, ticks);
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

  upstream = createServer(async (req, res) => {
    upstreamPaths.push(req.url!);
    const u = new URL(req.url!, 'http://x');
    const send = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    if (u.pathname === '/.well-known/openid-configuration') {
      return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
    }
    if (u.pathname === '/token') {
      const bodyChunks: Buffer[] = [];
      req.on('data', c => bodyChunks.push(c)).on('end', async () => {
        tokenCalls++;
        const rt = new URLSearchParams(Buffer.concat(bodyChunks).toString()).get('refresh_token');
        if (rt?.startsWith('hold-')) {
          tokenEntered?.resolve();
          await tokenGate?.promise;
        }
        if (rt === 'hold-401') {
          return send({ error: 'invalid_grant', error_description: 'AADSTS700082: expired' }, 400);
        }
        return send({ access_token: `atok-${rt}`, refresh_token: `next-${rt}`, expires_in: 3600 });
      });
      return;
    }

    if (u.pathname === '/v1.0/me/sendMail') {
      await Array.fromAsync(req);
      sendEntered?.resolve();
      await sendGate?.promise;
      return void res.writeHead(202).end();
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
    if (u.pathname === '/blob/zstd-chunk') {
      return void res.writeHead(200, { 'content-type': 'text/csv' }).end('a,b\n1,2\n');
    }
    if (u.pathname === '/api/2.0/sql/statements/s-zstd' && req.method === 'GET') {
      const payload = zstdCompressSync(Buffer.from(JSON.stringify({
        statement_id: 's-zstd',
        result: { external_links: [{ chunk_index: 0, external_link: 'https://dbstorage1.blob.core.windows.net/blob/zstd-chunk?sig=1' }] },
      })));
      return void res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'zstd' }).end(payload);
    }
    if (u.pathname === '/api/2.0/sql/statements/s-corrupt-zstd' && req.method === 'GET') {
      return void res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'zstd' }).end(Buffer.from('not-valid-zstd'));
    }
    if (u.pathname === '/api/2.0/sql/statements/s-nonjson' && req.method === 'GET') {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end('plain-text-not-json');
    }
    if (u.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c)).on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.mode === 'zstd-sse') {
          const sse = zstdCompressSync(Buffer.from('data: {"id":"gen-z1","usage":{"cost":0.33}}\n\ndata: [DONE]\n\n'));
          return void res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': ' ZSTD ' }).end(sse);
        }
        if (body.mode === 'xgzip-json') {
          const gz = gzipSync(Buffer.from(JSON.stringify({ id: 'gen-g1', usage: { cost: 0.42 } })));
          return void res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'X-GZIP' }).end(gz);
        }
        if (body.mode === 'corrupt-zstd') {
          return void res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'zstd' }).end(Buffer.from('corrupt-zstd-bytes'));
        }
        return send({ usage: { cost: 0.01 } });
      });
      return;
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
  process.env.RF_M365_SCOPES = 'Mail.Read Mail.Send Files.Read.All Sites.Read.All';
  process.env.OPENROUTER_API_KEY = 'sk-or-defensive-test';
  process.env.RF_M365_SCOPES = 'Mail.Read Mail.Send Files.Read.All Sites.Read.All';

  const { initSystem, saveTree } = await import('../src/system.ts');
  initSystem(tmp);
  openStore(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [USER], members: [] } }, series: { s1: { name: 'S1', workspace: 'w' } } });
  const auth = await import('../src/auth.ts');
  auth.upsertUser(USER, { role: 'user' });
  writeJson('capabilities.json', { 'series-owner': [USER] });

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
  connMod.upstreams['dbstorage1.blob.core.windows.net'] = base;
  connMod.upstreams['openrouter.ai'] = base;
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
      if (!callRuns.has(token)) callRuns.set(token, { inst: runs.get(token)!, runner: USER, n: 1, links: new Map(), cost: 0 });
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
  callRuns.set('g1', { inst, runner: USER, n: 1, links: new Map(), cost: 0 });
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
  callRuns.set('d1', { inst, runner: USER, n: 1, links: new Map(), cost: 0 });
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

test('Compressed zstd and x-gzip responses decode metadata and usage while non-JSON metadata preserves HTTP status', async () => {
  const inst = makeInst(['adb:adb-1.azuredatabricks.net/wh1']);
  runs.set('z1', inst);
  callRuns.set('z1', { inst, runner: USER, n: 1, links: new Map(), cost: 0 });
  calls.length = 0;

  // 1. zstd-compressed Databricks statement result extracts external_links cleanly
  const stmt = await viaProxy('GET', 'https://adb-1.azuredatabricks.net/api/2.0/sql/statements/s-zstd', { token: 'z1' });
  assert.equal(stmt.status, 200);
  const chunk = await viaProxy('GET', 'https://dbstorage1.blob.core.windows.net/blob/zstd-chunk?sig=1', { token: 'z1' });
  assert.equal(chunk.status, 200);
  assert.equal(chunk.text, 'a,b\n1,2\n');

  // 2. Non-JSON text with application/json Content-Type logs actual 200 status and byte count instead of 502, with a bounded diagnostic
  calls.length = 0;
  const errs: string[] = [], origError = console.error;
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(' ')); };
  let nonJson: { status: number; text: string };
  try {
    nonJson = await viaProxy('GET', 'https://adb-1.azuredatabricks.net/api/2.0/sql/statements/s-nonjson', { token: 'z1' });
  } finally {
    console.error = origError;
  }
  assert.equal(nonJson.status, 200);
  assert.equal(calls.at(-1)?.data.status, 200);
  assert.equal(calls.at(-1)?.data.bytes, 'plain-text-not-json'.length);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /adb: invalid JSON metadata on GET \/api\/2\.0\/sql\/statements\/s-nonjson \(200, 19 bytes\)/);
  assert.equal(errs[0].includes('plain-text-not-json'), false);

  // 3. Corrupt zstd on a connection JSON response still fails 502
  calls.length = 0;
  const badConnZstd = await viaProxy('GET', 'https://adb-1.azuredatabricks.net/api/2.0/sql/statements/s-corrupt-zstd', { token: 'z1' }).catch(() => ({ status: 502, text: '' }));
  assert.equal(calls.at(-1)?.data.status, 502);
  assert.ok(badConnZstd);

  // 4. OpenRouter zstd SSE and X-GZIP JSON record exact provider cost without falling back to estimated
  calls.length = 0;
  const sseRes = await viaProxy('POST', 'https://openrouter.ai/api/v1/chat/completions', {
    token: 'z1',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-5', mode: 'zstd-sse' }),
  });
  await connMod.drainCalls(callRuns.get('z1')!);
  assert.equal(sseRes.status, 200);
  assert.equal(calls.at(-1)?.data.cost, 0.33);
  assert.equal(calls.at(-1)?.data.estimated, undefined);

  const gzRes = await viaProxy('POST', 'https://openrouter.ai/api/v1/chat/completions', {
    token: 'z1',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-5', mode: 'xgzip-json' }),
  });
  await connMod.drainCalls(callRuns.get('z1')!);
  assert.equal(gzRes.status, 200);
  assert.equal(calls.at(-1)?.data.cost, 0.42);
  assert.equal(calls.at(-1)?.data.estimated, undefined);

  // 5. Corrupt zstd on OpenRouter logs 502 failed and marks estimated cost
  const badOrZstd = await viaProxy('POST', 'https://openrouter.ai/api/v1/chat/completions', {
    token: 'z1',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-5', mode: 'corrupt-zstd' }),
  }).catch(() => ({ status: 502 }));
  await connMod.drainCalls(callRuns.get('z1')!);
  assert.ok(badOrZstd);
  assert.equal(calls.at(-1)?.data.status, 502);
  assert.equal(calls.at(-1)?.data.estimated, true);
  assert.ok(calls.at(-1)?.data.failed);
});

test('Entra token() coalesces concurrent refreshes and ignores stale completions after reconnect', async () => {
  const { token } = await import('../src/entra.ts');
  const scope = ['https://graph.microsoft.com/Files.Read.All'];

  // 1. Concurrent callers share one /token refresh
  loginsMod.saveLogin(USER, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: USER,
    since: '2026-11-15T01:00:00Z', offers: [],
  }, 'coalesce-1');
  tokenCalls = 0;
  const [tA, tB, tC] = await Promise.all([
    token(USER, 'm365', scope),
    token(USER, 'm365', scope),
    token(USER, 'm365', scope),
  ]);
  assert.equal(tokenCalls, 1);
  assert.equal(tA, 'atok-coalesce-1');
  assert.equal(tB, tA);
  assert.equal(tC, tA);

  // 2. Stale 401 refresh completing after user reconnected does not mark the new login expired
  loginsMod.saveLogin(USER, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: USER,
    since: '2026-11-15T02:00:00Z', offers: [],
  }, 'hold-401');
  tokenGate = Promise.withResolvers();
  tokenEntered = Promise.withResolvers();
  const stale401 = token(USER, 'm365', scope);
  await tokenEntered.promise;
  loginsMod.saveLogin(USER, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: USER,
    since: '2026-11-15T02:05:00Z', offers: [],
  }, 'fresh-after-401');
  tokenGate.resolve();
  await assert.rejects(stale401, /expired/);
  assert.equal(loginsMod.logins(USER).find(l => l.id === 'm365')?.expired, undefined);
  assert.equal(loginsMod.secret(USER, 'm365'), 'fresh-after-401');

  // 3. Stale 200 refresh completing after user reconnected does not overwrite the new refresh token
  loginsMod.saveLogin(USER, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: USER,
    since: '2026-11-15T03:00:00Z', offers: [],
  }, 'hold-200');
  tokenGate = Promise.withResolvers();
  tokenEntered = Promise.withResolvers();
  const stale200 = token(USER, 'm365', scope);
  await tokenEntered.promise;
  loginsMod.saveLogin(USER, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: USER,
    since: '2026-11-15T03:05:00Z', offers: [],
  }, 'fresh-after-200');
  tokenGate.resolve();
  assert.equal(await stale200, 'atok-hold-200');
  assert.equal(loginsMod.secret(USER, 'm365'), 'fresh-after-200');
  assert.equal(await token(USER, 'm365', scope), 'atok-fresh-after-200');
  tokenGate = undefined;
  tokenEntered = undefined;

  // 4. Synchronous throw from missing .sealed file cleans up inFlight so a restored secret works immediately
  loginsMod.saveLogin(USER, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: USER,
    since: '2026-11-15T04:00:00Z', offers: [],
  }, 'sync-throw-check');
  const sealedFile = join(loginsMod.personDir(USER), 'm365.sealed');
  rmSync(sealedFile, { force: true });
  await assert.rejects(token(USER, 'm365', scope));
  loginsMod.seal(USER, 'm365', 'restored-after-sync-throw');
  assert.equal(await token(USER, 'm365', scope), 'atok-restored-after-sync-throw');
});

for (const mode of ['untick', 'unoffer', 'signout']) {
  test(`credential withdrawal during token renewal prevents a new send: ${mode}`, { timeout: 5000 }, async () => {
    const offer = `m365:mail:${USER}`;
    loginsMod.saveLogin(USER, {
      id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `renew-${mode}`,
      offers: [{ id: offer, name: 'Mailbox' }],
    }, 'hold-revoke');
    const inst = makeInst([offer]);
    runs.set('revoke', inst);
    callRuns.set('revoke', { inst, runner: USER, n: 1, links: new Map(), cost: 0 });
    calls.length = 0;
    upstreamPaths.length = 0;
    tokenGate = Promise.withResolvers();
    tokenEntered = Promise.withResolvers();
    const pending = viaProxy('POST', 'https://graph.microsoft.com/v1.0/me/sendMail', {
      token: 'revoke', headers: { 'content-type': 'application/json' }, body: '{"message":{"subject":"local fixture"}}',
    });
    try {
      await tokenEntered.promise;
      assert.equal(upstreamPaths.includes('/v1.0/me/sendMail'), false);
      assert.equal(calls.some(c => c.op === 'send'), false);
      if (mode === 'untick') saveSeriesSettings(seriesDir, { ...seriesSettings(seriesDir), epoch: seriesSettings(seriesDir).epoch + 1, consent: { by: USER, at: '', workspace: 'w', logins: [], autonomous: false } });
      if (mode === 'unoffer') loginsMod.unoffer(USER, 'm365', offer);
      if (mode === 'signout') loginsMod.signOut(USER, 'm365');
      assert.throws(() => loginsMod.use(inst, 1, offer));
      loginsMod.saveLogin(USER, { id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `regranted-${mode}`, offers: [{ id: offer, name: 'Mailbox' }] }, 'regranted-refresh');
      ownSeries('s1', USER, [offer]);
      assert.throws(() => loginsMod.use(inst, 1, offer), 'regrant cannot revive the old run');
    } finally {
      tokenGate.resolve();
    }
    const response = await pending;
    tokenGate = undefined;
    tokenEntered = undefined;
    assert.equal(upstreamPaths.includes('/v1.0/me/sendMail'), false, 'withdrawn credentials must not start a new upstream request');
    assert.equal(response.status, 403);
    assert.equal(calls.some(c => c.op === 'send'), false);
    assert.equal(calls.at(-1)?.op, 'call');
    assert.equal(calls.at(-1)?.data.status, response.status);
    assert.ok(calls.at(-1)?.data.refused);
    assert.equal(calls.at(-1)?.data.sent, undefined);
  });

  test(`credential withdrawal preserves an already-sent call: ${mode}`, { timeout: 5000 }, async () => {
    const offer = `m365:mail:${USER}`;
    loginsMod.saveLogin(USER, {
      id: 'm365', kind: 'm365', name: 'Microsoft 365', since: `sent-${mode}`,
      offers: [{ id: offer, name: 'Mailbox' }],
    }, 'sent-refresh');
    const inst = makeInst([offer]);
    runs.set('sent', inst);
    callRuns.set('sent', { inst, runner: USER, n: 1, links: new Map(), cost: 0 });
    calls.length = 0;
    upstreamPaths.length = 0;
    sendGate = Promise.withResolvers();
    sendEntered = Promise.withResolvers();
    const pending = viaProxy('POST', 'https://graph.microsoft.com/v1.0/me/sendMail', {
      token: 'sent', headers: { 'content-type': 'application/json' }, body: '{"message":{"subject":"local fixture"}}',
    });
    try {
      await sendEntered.promise;
      assert.equal(upstreamPaths.filter(p => p === '/v1.0/me/sendMail').length, 1);
      assert.deepEqual(calls.map(c => c.op), ['send']);
      if (mode === 'untick') saveSeriesSettings(seriesDir, { ...seriesSettings(seriesDir), epoch: seriesSettings(seriesDir).epoch + 1, consent: { by: USER, at: '', workspace: 'w', logins: [], autonomous: false } });
      if (mode === 'unoffer') loginsMod.unoffer(USER, 'm365', offer);
      if (mode === 'signout') loginsMod.signOut(USER, 'm365');
      assert.throws(() => loginsMod.use(inst, 1, offer));
    } finally {
      sendGate.resolve();
    }
    const response = await pending;
    sendGate = undefined;
    sendEntered = undefined;
    assert.equal(response.status, 202);
    assert.deepEqual(calls.map(c => c.op), ['send', 'call']);
    assert.equal(calls[1].data.status, 202);
    assert.equal(calls[1].data.sent, 1);
    assert.equal(calls[1].data.refused, undefined);
  });
}
