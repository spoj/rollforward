import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { createInstance, openStore, type Instance } from '../src/store.ts';
import type { CallRun } from '../src/connections.ts';
import { idp } from './idp.ts';
import { ownSeries } from './owner-fixture.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rf-conn-ep-'));
const entra = await idp();
Object.assign(process.env, entra.env('http://127.0.0.1:1'), {
  RF_M365_SCOPES: 'Mail.Read Mail.ReadWrite Mail.Send Files.Read.All Files.ReadWrite.All Sites.Read.All',
  OPENROUTER_API_KEY: 'sk-or-secret-test',
});

initSystem(tmp);
openStore(tmp);
const ALICE = 'alice@demo.test';
saveTree({
  workspaces: { w: { name: 'Acme', owners: [ALICE], members: [] } },
  series: { s1: { name: 'ExecPolicy Test', workspace: 'w' } },
});
writeJson('users.json', { [ALICE]: { role: 'admin' } });

const logins = await import('../src/logins.ts');
const { call, setConnection, removeConnection, upstreams, loginOf } = await import('../src/connections.ts');
const { endpoints: graphEndpoints } = await import('../src/connections/graph.ts');
const { keepSignIn } = await import('../src/entra.ts');

keepSignIn(ALICE, entra.refresh(ALICE));
logins.saveLogin(ALICE, {
  id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '2026-11-01T00:00:00Z',
  offers: [
    { id: `m365:mail:${ALICE}`, name: `Mailbox ${ALICE}` },
    { id: 'm365:item:d1/i1', name: 'File pack.xlsx' },
  ],
}, entra.refresh(ALICE));
await setConnection('graph', { type: 'graph' }, ALICE);
await setConnection('dbx', { type: 'databricks' }, ALICE);
logins.saveLogin(ALICE, {
  id: 'dbx', kind: 'databricks', name: 'Databricks dbx', since: '2026-11-01T00:00:00Z',
  offers: [{ id: 'dbx:adb-1.azuredatabricks.net/wh1', name: 'WH1' }],
}, entra.refresh(ALICE));

let upstreamHits = 0;
let writeUpstreamHits = 0;
let lastWriteBody = '';
let lastWriteLength = 0;
let writeDelayMs = 0;
const upstream = createServer(async (req, res) => {
  upstreamHits++;
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const rawBuf = Buffer.concat(chunks);
  const rawBody = rawBuf.toString('utf8');
  if (req.method === 'GET' && req.url?.startsWith('/v1.0/drives/d1/items/i1')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ id: 'i1', parentReference: { driveId: 'd1', id: 'root' } }));
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1.0/drives/d1')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ id: 'd1', driveType: 'documentLibrary', sharePointIds: { siteUrl: 'https://contoso.sharepoint.com/sites/fin', siteId: 's1', webId: 'w1' } }));
  }
  if (req.method !== 'GET') {
    if (writeDelayMs > 0) await new Promise(r => setTimeout(r, writeDelayMs));
    writeUpstreamHits++;
    lastWriteBody = rawBody;
    lastWriteLength = rawBuf.length;
  }
  if (req.url?.startsWith('/api/v1/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ id: 'gen-1', usage: { cost: 0.001 } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, method: req.method, path: req.url, bytes: rawBuf.length }));
});
await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', ok));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
upstreams['graph.microsoft.com'] = upstreamBase;
upstreams['contoso.sharepoint.com'] = upstreamBase;
graphEndpoints.graph = upstreamBase;
upstreams['adb-1.azuredatabricks.net'] = upstreamBase;
upstreams['openrouter.ai'] = upstreamBase;

await setConnection('erp', { type: 'service', url: upstreamBase, paths: 'AP/', key: 'svc-secret-key' }, ALICE);
const erpLogin = loginOf({ name: 'erp', type: 'service', url: upstreamBase, paths: ['AP/'] });
logins.saveLogin(ALICE, { ...erpLogin, since: '2026-11-01T00:00:00Z' } as never);

let runSeq = 0;
function makeRun(ticks: string[]) {
  const sid = `s-ep-${++runSeq}`;
  saveTree({ ...tree(), series: { ...tree().series, [sid]: { name: sid, workspace: 'w' } } });
  mkdirSync(join(tmp, 'series', sid), { recursive: true });
  ownSeries(sid, ALICE, ticks, false);
  const inst = createInstance(sid, `run-${runSeq}`, ALICE);
  inst.append('server', 'run', {
    run: 1, runner: ALICE, initiator: ALICE,
    authority: logins.authority(inst),
  });
  const run: CallRun = { inst, n: 1, runner: ALICE, links: new Map(), cost: 0 };
  return { inst, entries: inst.log, run };
}

async function sendViaProxy(run: CallRun, host: string, method: string, path: string, headers: Record<string, string>, body?: string) {
  const proxy = createServer((req, res) => void call(run, host, req, res));
  await new Promise<void>(ok => proxy.listen(0, '127.0.0.1', ok));
  const port = (proxy.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    return { status: r.status, text: await r.text(), headers: r.headers };
  } finally {
    proxy.close();
  }
}

after(async () => {
  delete process.env.RF_EXECPOLICY_MODE;
  removeConnection('erp');
  upstream.close();
  entra.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('observe mode logs semantic actions, bodyShape, and policy on Graph/Databricks/Service calls, and NEVER logs OpenRouter prompt bodies', async () => {
  process.env.RF_EXECPOLICY_MODE = 'observe';
  const { run, entries } = makeRun([`m365:mail:${ALICE}`, 'dbx:adb-1.azuredatabricks.net/wh1', 'erp:AP/']);

  // Graph sendMail
  const mail = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'TOP SECRET SUBJECT', body: { content: 'Private payroll' }, toRecipients: [{ emailAddress: { address: 'bob@vendor.test' } }] },
  }));
  assert.equal(mail.status, 200);
  const mailCall = entries.findLast(e => e.op === 'call')!;
  assert.equal((mailCall.actions as any[])[0].op, 'graph:sendMail');
  assert.deepEqual((mailCall.actions as any[])[0].details.recipientDomains, ['vendor.test']);
  assert.equal((mailCall.actions as any[])[0].details.recipientCount, 1);
  assert.equal((mailCall.actions as any[])[0].details.recipientsComplete, true);
  assert.equal((mailCall.actions as any[])[0].details.attachmentCount, 0);
  assert.match((mailCall.actions as any[])[0].details.targetDigest, /^[a-f0-9]{64}$/);
  assert.equal((mailCall.policy as any).action, 'requireApproval');
  assert.equal((mailCall.policy as any).ruleId, 'graph_send_mail');
  assert.ok(!JSON.stringify(mailCall).includes('TOP SECRET SUBJECT'));
  assert.ok(!JSON.stringify(mailCall).includes('bob@vendor.test'));

  // Databricks SQL DROP (observe mode allows through, flags deny in policy)
  const dbx = await sendViaProxy(run, 'adb-1.azuredatabricks.net', 'POST', '/api/2.0/sql/statements', { 'content-type': 'application/json' }, JSON.stringify({
    warehouse_id: 'wh1', catalog: 'fin', schema: 'ar', statement: 'DROP TABLE fin.ar.old_tmp',
  }));
  assert.equal(dbx.status, 200);
  const dbxCall = entries.findLast(e => e.op === 'call')!;
  assert.equal((dbxCall.actions as any[])[0].op, 'databricks:sql_ddl');
  assert.equal((dbxCall.policy as any).action, 'deny');
  assert.equal((dbxCall.policy as any).ruleId, 'databricks_destructive_ddl');

  // Service method-override escalation (GET + X-HTTP-Method-Override: DELETE -> isWrite = true, logs send! + query values sanitized)
  const beforeSend = entries.filter(e => e.op === 'send').length;
  const esc = await sendViaProxy(run, 'erp.rf.internal', 'GET', '/AP/voucher/99?api_key=RAW_SECRET_KEY&customer=JaneDoe', { 'x-http-method-override': 'DELETE' });
  assert.equal(esc.status, 200);
  assert.equal(entries.filter(e => e.op === 'send').length, beforeSend + 1, 'escalated GET logs pre-flight send');
  const escSend = entries.findLast(e => e.op === 'send')!;
  const escCall = entries.findLast(e => e.op === 'call')!;
  assert.equal(escCall.effectiveMethod, 'DELETE');
  assert.equal(escCall.isWrite, true);
  assert.equal(typeof (escCall.policy as any).atSeq, 'number', 'admission-time atSeq persisted in policy');
  assert.equal((escCall.policy as any).ruleId, 'http_delete');
  assert.equal(escSend.path, '/AP/voucher/99?api_key=[REDACTED]&customer=<str>');
  assert.equal(escCall.path, '/AP/voucher/99?api_key=[REDACTED]&customer=<str>');
  assert.ok(!JSON.stringify(escSend).includes('RAW_SECRET_KEY'));
  assert.ok(!JSON.stringify(escCall).includes('JaneDoe'));

  // OpenRouter LLM call: zero actions/bodyShape/prompt leakage AND bare/keyed query params sanitized
  const or = await sendViaProxy(run, 'openrouter.ai', 'POST', '/api/v1/chat/completions?prompt=QUERY_LEAK_123&token=SECRET_TOK&RAW_BARE_QUERY_SECRET', { 'content-type': 'application/json' }, JSON.stringify({
    model: 'openai/gpt-5-mini',
    messages: [{ role: 'user', content: 'SUPER PRIVATE PROMPT TEXT 998877' }],
  }));
  assert.equal(or.status, 200);
  const orCall = entries.findLast(e => e.op === 'call')!;
  assert.equal(orCall.actions, undefined);
  assert.equal(orCall.bodyShape, undefined);
  assert.equal(orCall.policy, undefined);
  assert.ok(!JSON.stringify(orCall).includes('SUPER PRIVATE PROMPT TEXT'));
  assert.ok(!JSON.stringify(orCall).includes('QUERY_LEAK_123'));
  assert.ok(!JSON.stringify(orCall).includes('SECRET_TOK'));
  assert.ok(!JSON.stringify(orCall).includes('RAW_BARE_QUERY_SECRET'));

  // Malformed OpenRouter JSON must NOT leak prompt text into log.jsonl via SyntaxError.message!
  const badOr = await sendViaProxy(run, 'openrouter.ai', 'POST', '/api/v1/chat/completions', { 'content-type': 'application/json' }, '{"prompt":"TOP_SECRET_MALFORMED_PROMPT_999"');
  assert.equal(badOr.status, 400);
  const badOrCall = entries.findLast(e => e.op === 'call')!;
  assert.equal(badOrCall.refused, 'invalid JSON request body');
  assert.ok(!JSON.stringify(badOrCall).includes('TOP_SECRET_MALFORMED_PROMPT_999'));

  // Graph unsupported-resource refusal must NOT leak raw query values or redacted path segments into call.refused!
  const graphRefused = await sendViaProxy(run, 'graph.microsoft.com', 'GET', '/v1.0/groups/aB3dE5fG7hI9jK1lM3nO5pQ7/members?token=SECRET_GRAPH_Q&filter=JaneDoe', {});
  assert.equal(graphRefused.status, 403);
  const graphRefCall = entries.findLast(e => e.op === 'call')!;
  assert.ok(!String(graphRefCall.refused).includes('SECRET_GRAPH_Q'), 'raw query token scrubbed from call.refused');
  assert.ok(!String(graphRefCall.refused).includes('JaneDoe'), 'raw query value scrubbed from call.refused');
  assert.ok(!String(graphRefCall.refused).includes('aB3dE5fG7hI9jK1lM3nO5pQ7'), 'redacted path segment scrubbed from call.refused');
});

test('enforce mode blocks unapproved sendMail / DROP / method-override downgrade with ruleId+decisionId & Connection:close, runs PrefixReader for streamed writes, and enforces scoped single-use owner approval', async () => {
  process.env.RF_EXECPOLICY_MODE = 'enforce';
  const { inst, run, entries } = makeRun([`m365:mail:${ALICE}`, 'm365:item:d1/i1', 'dbx:adb-1.azuredatabricks.net/wh1', 'erp:AP/']);

  const hits0 = writeUpstreamHits;
  // 1. Unapproved sendMail -> 403 with ruleId + decisionId ONLY (no reasoning text), Connection: close, zero upstream hits, no `send`
  const r1 = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'S', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] },
  }));
  assert.equal(r1.status, 403);
  assert.equal(r1.headers.get('connection'), 'close');
  assert.equal(writeUpstreamHits, hits0, 'zero bytes reach upstream');
  assert.equal(entries.some(e => e.op === 'send'), false, 'no send logged when blocked pre-flight');
  const parsed1 = JSON.parse(r1.text);
  assert.equal(parsed1.error.code, 'rf_policy');
  assert.equal(parsed1.error.ruleId, 'graph_send_mail');
  assert.equal(typeof parsed1.error.decisionId, 'string');
  assert.deepEqual(Object.keys(parsed1.error).sort(), ['code', 'decisionId', 'ruleId'], 'returns ruleId + decisionId ONLY, no reasoning oracle');

  // 2. Databricks DROP -> 403 ruleId + decisionId
  const r2 = await sendViaProxy(run, 'adb-1.azuredatabricks.net', 'POST', '/api/2.0/sql/statements', { 'content-type': 'application/json' }, JSON.stringify({
    warehouse_id: 'wh1', statement: 'DROP TABLE t',
  }));
  assert.equal(r2.status, 403);
  assert.equal(r2.headers.get('connection'), 'close');
  assert.equal(JSON.parse(r2.text).error.ruleId, 'databricks_destructive_ddl');
  assert.equal(writeUpstreamHits, hits0);

  // 3. Method-override downgrade on service -> 403 plain text ruleId + decisionId, Connection: close, 0 upstream hits
  const r3 = await sendViaProxy(run, 'erp.rf.internal', 'POST', '/AP/vouchers', { 'x-http-method-override': 'GET' }, '{"a":1}');
  assert.equal(r3.status, 403);
  assert.equal(r3.headers.get('connection'), 'close');
  assert.match(r3.text.trim(), /^blocked by policy: method_override_downgrade \(decisionId=[0-9a-f-]+\)$/);
  assert.equal(writeUpstreamHits, hits0);

  // 3b. PrefixReader: streamed deployment-service POST (<=64 KiB clean JSON) is inspected and allowed with full body replayed upstream!
  const svcPayload = JSON.stringify({ amount: 500, batch: 'B1' });
  const r3b = await sendViaProxy(run, 'erp.rf.internal', 'POST', '/AP/vouchers', { 'content-type': 'application/json' }, svcPayload);
  assert.equal(r3b.status, 200);
  assert.equal(writeUpstreamHits, hits0 + 1);
  assert.equal(lastWriteBody, svcPayload, 'PrefixReader replayed full body upstream unchanged');

  // 3c. PrefixReader: streamed deployment-service POST with duplicate JSON keys is caught and blocked BEFORE upstream!
  const r3c = await sendViaProxy(run, 'erp.rf.internal', 'POST', '/AP/vouchers', { 'content-type': 'application/json' }, '{"amount":1,"amount":999999}');
  assert.equal(r3c.status, 403);
  assert.equal(r3c.headers.get('connection'), 'close');
  assert.match(r3c.text.trim(), /^blocked by policy: write_duplicate_json_keys \(decisionId=[0-9a-f-]+\)$/);
  assert.equal(writeUpstreamHits, hits0 + 1, 'duplicate-key JSON blocked before upstream dial');

  // 3d. PrefixReader: Graph PUT .../content WITHOUT If-Match -> blocked (unguarded_overwrite_no_if_match), 0 write upstream hits!
  const r3d = await sendViaProxy(run, 'graph.microsoft.com', 'PUT', '/v1.0/drives/d1/items/i1/content', { 'content-type': 'application/octet-stream' }, 'binary-file-payload');
  assert.equal(r3d.status, 403);
  assert.equal(r3d.headers.get('connection'), 'close');
  assert.equal(JSON.parse(r3d.text).error.ruleId, 'unguarded_overwrite_no_if_match');
  assert.equal(writeUpstreamHits, hits0 + 1);

  // 3e. PrefixReader: Graph PUT .../content WITH If-Match -> allowed and full body received upstream!
  const filePayload = 'PK\x03\x04excel-content-bytes-12345';
  const r3e = await sendViaProxy(run, 'graph.microsoft.com', 'PUT', '/v1.0/drives/d1/items/i1/content', { 'content-type': 'application/octet-stream', 'if-match': '"etag-1"' }, filePayload);
  assert.equal(r3e.status, 200);
  assert.equal(writeUpstreamHits, hits0 + 2);
  assert.equal(lastWriteBody, filePayload, 'full binary payload streamed upstream after PrefixReader allow');

  // 4. Unrelated prose proposal signed by viewer does NOT unlock sendMail!
  const proseProp = inst.append('agent', 'comment', { ask: 'proposal', text: 'May I rename the draft summary?', run: 1 });
  inst.append('viewer@demo.test', 'signoff', { on: proseProp.seq, text: 'Sure' });
  const r4Unrel = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'Sneaky', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] },
  }));
  assert.equal(r4Unrel.status, 403);
  assert.equal(writeUpstreamHits, hits0 + 2);

  // 5. Scoped single-use owner signoff unlocks matching sendMail ONCE and denies different domain or 2nd sendMail!
  const prop = inst.append('agent', 'comment', {
    ask: 'proposal', text: 'Send approved report', run: 1,
    execpolicy: { action: 'graph:sendMail', domains: ['b.test'], workspace: 'w', maxUses: 1 },
  });
  inst.append(ALICE, 'signoff', { on: prop.seq, text: 'Approved' });

  // Wrong recipient domain rejected even with approval active:
  const r5WrongDom = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'Wrong domain', toRecipients: [{ emailAddress: { address: 'ceo@evil.test' } }] },
  }));
  assert.equal(r5WrongDom.status, 403);

  // Exact matching domain succeeds once:
  const r5Ok = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'Approved', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] },
  }));
  assert.equal(r5Ok.status, 200);
  assert.equal(writeUpstreamHits, hits0 + 3);
  const okCall = entries.findLast(e => e.op === 'call')!;
  assert.equal((okCall.policy as any).action, 'allow');
  assert.equal((okCall.policy as any).approvalRef, `c${prop.seq}`);

  // 2nd sendMail after single-use consumption is DENIED!
  const r5Replay = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'Second send', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] },
  }));
  assert.equal(r5Replay.status, 403);
  assert.equal(writeUpstreamHits, hits0 + 3, 'consumed approval cannot unlock a 2nd send');
});

test('R2 PrefixReader boundary sizes (65535B, 65536B, 65537B, 300 KiB), If-Match:*, SharePoint uploadSession chunk, and atomic 5-parallel single-use approval', async () => {
  process.env.RF_EXECPOLICY_MODE = 'enforce';
  const { inst, run, entries } = makeRun([`m365:mail:${ALICE}`, 'm365:item:d1/i1', 'erp:AP/']);

  // 1. PUT .../content at 65535 B, 65536 B, 65537 B, and 300 KiB with concrete If-Match -> 200 with exact upstream byte count!
  for (const size of [65_535, 65_536, 65_537, 300 * 1024]) {
    const payload = Buffer.alloc(size, 0x61).toString('latin1');
    const before = writeUpstreamHits;
    const r = await sendViaProxy(
      run,
      'graph.microsoft.com',
      'PUT',
      '/v1.0/drives/d1/items/i1/content',
      { 'content-type': 'application/octet-stream', 'if-match': '"etag-strong-1"' },
      payload,
    );
    assert.equal(r.status, 200, `PUT .../content of ${size} bytes with strong If-Match must succeed`);
    assert.equal(writeUpstreamHits, before + 1);
    assert.equal(lastWriteLength, size, `upstream received exact ${size} bytes`);
    const callEntry = entries.findLast(e => e.op === 'call')!;
    assert.equal((callEntry.policy as any).ruleId, 'allow_governed_file_write');
    if (size <= 65_536) {
      assert.equal((callEntry.completeness as any).transport, 'complete', `${size} B reaches EOF cleanly`);
    } else {
      assert.equal((callEntry.completeness as any).transport, 'truncated', `${size} B is prefix-only truncated`);
    }
  }

  // 2. PUT .../content with If-Match: * -> 403 unguarded_overwrite_no_if_match (zero upstream writes!)
  const beforeStar = writeUpstreamHits;
  const rStar = await sendViaProxy(
    run,
    'graph.microsoft.com',
    'PUT',
    '/v1.0/drives/d1/items/i1/content',
    { 'content-type': 'application/octet-stream', 'if-match': '*' },
    'x'.repeat(1024),
  );
  assert.equal(rStar.status, 403);
  assert.equal(JSON.parse(rStar.text).error.ruleId, 'unguarded_overwrite_no_if_match');
  assert.equal(writeUpstreamHits, beforeStar, 'If-Match: * blocked before upstream');

  // 3. Realistic SharePoint /_api/v2.0/.../uploadSession chunk (320 KiB) under non-"graph" connection name -> 200 allow_upload_session_chunk!
  const uploadUrl = 'https://contoso.sharepoint.com/sites/fin/_api/v2.0/drives/d1/items/i1/uploadSession?guid=abc-123';
  run.links.set(uploadUrl, { name: 'm365-corp', offer: 'm365:item:d1/i1' });
  const chunk320k = Buffer.alloc(320 * 1024, 0x5a).toString('latin1');
  const beforeChunk = writeUpstreamHits;
  const rChunk = await sendViaProxy(
    run,
    'contoso.sharepoint.com',
    'PUT',
    '/sites/fin/_api/v2.0/drives/d1/items/i1/uploadSession?guid=abc-123',
    { 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${chunk320k.length - 1}/${chunk320k.length}` },
    chunk320k,
  );
  assert.equal(rChunk.status, 200, 'SharePoint uploadSession chunk allowed in enforce mode');
  assert.equal(writeUpstreamHits, beforeChunk + 1);
  assert.equal(lastWriteLength, chunk320k.length, 'exact 320 KiB chunk received upstream');
  assert.equal((entries.findLast(e => e.op === 'call')!.policy as any).ruleId, 'allow_upload_session_chunk');

  // 4. Atomic concurrency test: owner-signed maxUses:1 + 5 parallel sendMail (150ms delayed upstream) -> EXACTLY 1 x 200 and 4 x 403!
  const prop = inst.append('agent', 'comment', {
    ask: 'proposal', text: 'Send one approved email', run: 1,
    execpolicy: { action: 'graph:sendMail', domains: ['concurrent.test'], workspace: 'w', maxUses: 1 },
  });
  inst.append(ALICE, 'signoff', { on: prop.seq, text: 'Approved once' });

  const hitsBeforeRace = writeUpstreamHits;
  writeDelayMs = 150;
  try {
    const mailBody = JSON.stringify({
      message: { subject: 'Race test', toRecipients: [{ emailAddress: { address: 'cfo@concurrent.test' } }] },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, mailBody)),
    );
    const okCount = results.filter(r => r.status === 200).length;
    const deniedCount = results.filter(r => r.status === 403).length;
    assert.equal(okCount, 1, `expected exactly 1 allowed out of 5 parallel sends, got ${okCount}`);
    assert.equal(deniedCount, 4, `expected exactly 4 denied out of 5 parallel sends, got ${deniedCount}`);
    assert.equal(writeUpstreamHits, hitsBeforeRace + 1, 'upstream received exactly 1 sendMail');
    const sendEntry = entries.findLast(e => e.op === 'send' && e.approvalRef === `c${prop.seq}`);
    assert.ok(sendEntry, 'pre-flight send durably persisted approvalRef');
    assert.equal(typeof sendEntry!.decisionId, 'string', 'pre-flight send durably persisted decisionId');
  } finally {
    writeDelayMs = 0;
  }
});
