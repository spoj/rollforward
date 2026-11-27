import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretVault,
  buildBodyShape,
  isAuthUrl,
  isSensitiveKey,
  parseJsonSafe,
  redactJsonValue,
  sanitizeUrl,
} from '../src/redact.ts';
import {
  buildApiRequestDescriptor,
  classifySqlStatement,
  computeSqlContextDigest,
  computeTargetDigest,
  extractMimeRecipientDomains,
  extractSemantic,
  parseSemanticMethods,
} from '../src/extract.ts';
import {
  ExecPolicyEngine,
  compactDecision,
  evaluateStage1,
  findCurrentEpochApproval,
  replayExecPolicy,
  validateAndNormalizeApprovalScope,
} from '../src/execpolicy.ts';
import type { Entry } from '../src/store.ts';

test('redaction parity: preserves business identifiers, redacts credential keys, scrubs SecretVault, and templates query values', () => {
  for (const ok of ['AuthorizationNumber', 'PrimaryKey', 'TrainingSession', 'PassFail', 'Secretary', 'PostalCode']) {
    assert.equal(isSensitiveKey(ok), false, `${ok} preserved`);
  }
  for (const bad of ['Authorization', 'apiKey', 'FormDigestValue', 'passcode', 'verificationCode', 'smsCode', 'authCode', 'userPass', 'userPin', 'sessionKey', 'signingKey', 'token']) {
    assert.equal(isSensitiveKey(bad), true, `${bad} redacted`);
  }

  const vault = new SecretVault();
  vault.addTrustedDrive('482910'); // 6-digit OTP
  vault.addTrustedHeader('header-secret-xyz');
  const parsed = parseJsonSafe('{"amount": 1.10, "bigId": 12345678901234567890, "verificationCode": "999111", "note": "otp 482910", "a": 1, "a": 2}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dupKeys, true);
  const red = redactJsonValue(parsed.value, vault);
  const out = JSON.stringify(red.value);
  assert.ok(out.includes('1.10'), 'JSON.rawJSON preserves decimal formatting');
  assert.ok(out.includes('12345678901234567890'), 'JSON.rawJSON preserves 20-digit integer');
  assert.ok(!out.includes('999111'), 'verificationCode redacted');
  assert.ok(!out.includes('482910'), 'OTP vault secret scrubbed');
  assert.equal(red.vaultRedactions, 1);

  const shape = buildBodyShape({ 'jane@example.com': { total: 42 }, '550e8400-e29b-41d4-a716-446655440000': 'ok', items: [{ id: 1 }] }, vault);
  assert.deepEqual(shape.shape, { '<key>.total': 'number', '<key>': 'string', 'items[].id': 'number' });

  const san = sanitizeUrl('https://portal.example.com/api/orders?customer=Jane%20Lee&verification_code=123456&page=2', { projection: 'semantic', vault });
  assert.equal(san.url, 'https://portal.example.com/api/orders?customer=<str>&verification_code=[REDACTED]&page=<num>');

  // Matrix parameter bypass check (WebLogic E1 formservice;x=/login stays scoped; /app;v=/login preserves /login)
  assert.equal(isAuthUrl('https://erp.example.com/jderest/v2/formservice;x=%2Flogin'), false);
  assert.equal(isAuthUrl('https://erp.example.com/jderest/v2/formservice;x=/login'), false);
  assert.equal(isAuthUrl('https://erp.example.com/app;v=/login'), true);
  assert.equal(isAuthUrl('https://erp.example.com/jderest/v2/login'), true);
});

test('API-native semantic extractors: Microsoft Graph, Databricks SQL, and custom Service', () => {
  // 1. Graph sendMail: recipient domains & counts ONLY (zero raw addresses / subject / body PII)
  const mailBody = Buffer.from(JSON.stringify({
    message: {
      subject: 'Confidential payroll Q4',
      body: { contentType: 'Text', content: 'Salary for Jane Doe is $250,000' },
      toRecipients: [
        { emailAddress: { address: 'cfo@acme.test' } },
        { emailAddress: { address: 'audit@external.org' } },
      ],
      attachments: [{ name: 'payroll.xlsx' }],
    },
  }));
  const { descriptor: mailDesc } = buildApiRequestDescriptor({
    connection: 'graph',
    connectionType: 'graph',
    seq: 1,
    method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
    headers: { 'content-type': 'application/json' },
    rawBody: mailBody,
    bodyComplete: true,
  });
  assert.equal(mailDesc.safe.surface, 'api');
  assert.deepEqual(mailDesc.safe.target, { connection: 'graph' });
  assert.equal(mailDesc.safe.actions[0].family, 'graph');
  assert.equal(mailDesc.safe.actions[0].op, 'graph:sendMail');
  assert.equal(mailDesc.safe.actions[0].details?.recipientCount, 2);
  assert.deepEqual(mailDesc.safe.actions[0].details?.recipientDomains, ['acme.test', 'external.org']);
  assert.equal(mailDesc.safe.actions[0].details?.recipientsComplete, true);
  assert.equal(mailDesc.safe.actions[0].details?.attachmentCount, 1);
  assert.match(String(mailDesc.safe.actions[0].details?.targetDigest), /^[a-f0-9]{64}$/);
  const serializedSafe = JSON.stringify(mailDesc.safe);
  assert.ok(!serializedSafe.includes('cfo@acme.test'), 'no raw email address');
  assert.ok(!serializedSafe.includes('Jane Doe'), 'no body PII');
  assert.ok(!serializedSafe.includes('Confidential payroll'), 'no subject PII');

  // 2. Graph draft, mail_patch, file_write (with/without If-Match), file_delete, excel_write, teams_message
  const draft = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 2, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/messages'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ subject: 'Draft', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(draft.safe.actions[0].op, 'graph:draft');

  const patch = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 3, method: 'PATCH',
    url: new URL('https://graph.microsoft.com/v1.0/me/messages/m1'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ isRead: true, categories: ['Processed'] })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(patch.safe.actions[0].op, 'graph:mail_patch');
  assert.deepEqual(patch.safe.actions[0].details?.fields, ['isRead', 'categories']);

  const fwNoEtag = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 4, method: 'PUT',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1:/book.xlsx:/content'),
    headers: { 'content-type': 'application/octet-stream' },
    rawBody: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    bodyComplete: true,
  }).descriptor;
  assert.equal(fwNoEtag.safe.actions[0].op, 'graph:file_write');
  assert.equal(fwNoEtag.safe.actions[0].details?.hasIfMatch, false);

  const fwWithEtag = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 5, method: 'PUT',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1:/book.xlsx:/content'),
    headers: { 'content-type': 'application/octet-stream', 'if-match': '"etag-1"' },
    rawBody: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    bodyComplete: true,
  }).descriptor;
  assert.equal(fwWithEtag.safe.actions[0].details?.hasIfMatch, true);

  const fdel = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 6, method: 'DELETE',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1'),
    headers: {}, bodyComplete: true,
  }).descriptor;
  assert.equal(fdel.safe.actions[0].op, 'graph:file_delete');

  const excel = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 7, method: 'PATCH',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1/workbook/worksheets/Sheet1/range(address=\'A1\')'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ values: [[100]] })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(excel.safe.actions[0].op, 'graph:excel_write');

  const teams = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 8, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/chats/c1/messages'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ body: { content: 'hi' } })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(teams.safe.actions[0].op, 'graph:teams_message');

  // 3. Databricks SQL statement classification
  assert.deepEqual(classifySqlStatement('/* comment */ WITH cte AS (SELECT 1) SELECT * FROM fin.gl'), { sqlClass: 'read', statements: ['SELECT'], destructive: false, hasDropOrTruncate: false, hasDelete: false });
  assert.deepEqual(classifySqlStatement('WITH select AS (SELECT 1) DELETE FROM fin.gl'), { sqlClass: 'write', statements: ['DELETE'], destructive: true, hasDropOrTruncate: false, hasDelete: true });
  assert.deepEqual(classifySqlStatement('WITH RECURSIVE a(x) AS (SELECT 1), b AS (SELECT 2) UPDATE fin.gl SET x = 1'), { sqlClass: 'write', statements: ['UPDATE'], destructive: false, hasDropOrTruncate: false, hasDelete: false });
  assert.deepEqual(classifySqlStatement('WITH broken AS (SELECT 1'), { sqlClass: 'unknown', statements: ['UNKNOWN'], destructive: false, hasDropOrTruncate: false, hasDelete: false });
  assert.deepEqual(classifySqlStatement('"SECRET_QUOTED_IDENTIFIER" 123'), { sqlClass: 'unknown', statements: ['UNKNOWN'], destructive: false, hasDropOrTruncate: false, hasDelete: false });
  assert.deepEqual(classifySqlStatement("SELECT 'DROP TABLE x' AS literal"), { sqlClass: 'read', statements: ['SELECT'], destructive: false, hasDropOrTruncate: false, hasDelete: false });
  assert.deepEqual(classifySqlStatement('INSERT INTO fin.gl VALUES (1);'), { sqlClass: 'write', statements: ['INSERT'], destructive: false, hasDropOrTruncate: false, hasDelete: false });
  assert.deepEqual(classifySqlStatement('SELECT 1; DROP TABLE fin.gl'), { sqlClass: 'ddl', statements: ['SELECT', 'DROP'], destructive: true, hasDropOrTruncate: true, hasDelete: false });

  // >16 statements: DROP or DELETE at statement #17 MUST still set full-input flags!
  const seventeenDrop = `${'SELECT 1; '.repeat(16)}DROP TABLE fin.gl`;
  const cls17Drop = classifySqlStatement(seventeenDrop);
  assert.equal(cls17Drop.statements.length, 16);
  assert.equal(cls17Drop.hasDropOrTruncate, true);
  assert.equal(cls17Drop.destructive, true);
  const seventeenDel = `${'SELECT 1; '.repeat(16)}DELETE FROM fin.gl`;
  const cls17Del = classifySqlStatement(seventeenDel);
  assert.equal(cls17Del.statements.length, 16);
  assert.equal(cls17Del.hasDelete, true);
  assert.equal(cls17Del.destructive, true);

  const dbxRead = buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', seq: 9, method: 'POST',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'wh123', catalog: 'fin', schema: 'gl', statement: 'SELECT 1' })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(dbxRead.safe.actions[0].op, 'databricks:sql_read');
  assert.equal(dbxRead.safe.actions[0].details?.warehouseId, 'wh123');
  assert.equal(dbxRead.safe.actions[0].details?.catalog, 'fin');
  assert.equal(dbxRead.safe.actions[0].details?.schema, 'gl');

  // 4. Custom service
  const svc = buildApiRequestDescriptor({
    connection: 'erp-drop', connectionType: 'service', seq: 10, method: 'POST',
    url: new URL('https://erp-drop.rf.internal/AP/batches/42'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ batchId: 42, lines: [{ amount: 12.5 }] })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(svc.safe.actions[0].family, 'service');
  assert.equal(svc.safe.actions[0].op, 'service:POST');
  assert.deepEqual(svc.safe.bodyShape, { batchId: 'number', 'lines[].amount': 'number' });
});

test('Stage-1 execpolicy deterministic rules: method-override escalation/downgrade, destructive writes, and current-epoch approval', () => {
  // Method override downgrade (POST + X-HTTP-Method-Override: GET) -> deny
  const downgrade = buildApiRequestDescriptor({
    connection: 'svc', connectionType: 'service', seq: 1, method: 'POST',
    url: new URL('https://svc.rf.internal/AP/post'),
    headers: { 'x-http-method-override': 'GET' },
    bodyComplete: true,
  }).descriptor;
  assert.equal(downgrade.safe.isWrite, true, 'POST cannot be downgraded to read');
  assert.equal(downgrade.safe.effectiveMethod, 'POST');
  const d1 = evaluateStage1(downgrade.safe, 'enforce', { approved: false, recentApprovedProposals: [] });
  assert.equal(d1.action, 'deny');
  assert.equal(d1.ruleId, 'method_override_downgrade');

  // Method override escalation (GET + X-HTTP-Method: DELETE) -> requireApproval / escalate
  const escalation = buildApiRequestDescriptor({
    connection: 'svc', connectionType: 'service', seq: 2, method: 'GET',
    url: new URL('https://svc.rf.internal/AP/item'),
    headers: { 'x-http-method': 'DELETE' },
    bodyComplete: true,
  }).descriptor;
  assert.equal(escalation.safe.isWrite, true);
  assert.equal(escalation.safe.effectiveMethod, 'DELETE');
  const d2 = evaluateStage1(escalation.safe, 'enforce', { approved: false, recentApprovedProposals: [] });
  assert.equal(d2.action, 'requireApproval');
  assert.equal(d2.ruleId, 'http_delete');

  // Wire DELETE + X-HTTP-Method-Override: POST MUST still require approval (never downgraded out of http_delete / graph:file_delete!)
  const delOverride = buildApiRequestDescriptor({
    connection: 'svc', connectionType: 'service', seq: 20, method: 'DELETE',
    url: new URL('https://svc.rf.internal/AP/item'),
    headers: { 'x-http-method-override': 'POST' },
    bodyComplete: true,
  }).descriptor;
  const dDel = evaluateStage1(delOverride.safe, 'enforce', { approved: false, recentApprovedProposals: [] });
  assert.equal(dDel.action, 'requireApproval');
  assert.equal(dDel.ruleId, 'http_delete');

  const graphDelOverride = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 21, method: 'DELETE',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1'),
    headers: { 'x-http-method-override': 'POST' },
    bodyComplete: true,
  }).descriptor;
  assert.equal(graphDelOverride.safe.actions[0].op, 'graph:file_delete');
  const dGraphDel = evaluateStage1(graphDelOverride.safe, 'enforce', { approved: false, recentApprovedProposals: [] });
  assert.equal(dGraphDel.action, 'requireApproval');
  assert.equal(dGraphDel.ruleId, 'graph_file_delete');

  // Method override conflict -> deny
  const conflict = parseSemanticMethods('POST', { 'x-http-method': 'DELETE', 'x-method-override': 'PATCH' });
  assert.equal(conflict.hdrConflict, true);

  // E1 AIS write (formServiceAction: 'W') -> requireApproval without approval, allow with approval
  const e1Extracted = extractSemantic({
    url: new URL('https://erp.example.com/jderest/v2/formservice'),
    sanitizedPath: '/jderest/v2/formservice',
    method: 'POST',
    effectiveMethod: 'POST',
    kind: 'http',
    rawHeaders: { 'content-type': 'application/json' },
    reqType: 'application/json',
    decodedBuf: Buffer.from(JSON.stringify({ formName: 'P0411_W0411A', formServiceAction: 'W', formActions: [{ command: 'DoAction', controlID: '12' }] })),
    bodyComplete: true,
    transport: 'complete',
    isWrite: true,
    isAuth: false,
    isLive: false,
    projection: 'semantic',
  });
  const e1Safe = {
    descV: 1 as const, redactV: 1 as const, extractorV: 1 as const,
    surface: 'browser' as const, target: { site: 'e1' }, seq: 1, t: new Date().toISOString(),
    kind: 'http' as const, scheme: 'https' as const, authority: 'erp.example.com',
    path: '/jderest/v2/formservice', url: 'https://erp.example.com/jderest/v2/formservice',
    method: 'POST', effectiveMethod: 'POST', methodSource: 'wire' as const, isWrite: true,
    prefixBytes: 100, bodyComplete: true, decodeComplete: true,
    completeness: e1Extracted.completeness, actions: e1Extracted.actions,
  };
  assert.equal(evaluateStage1(e1Safe, 'enforce', { approved: false, recentApprovedProposals: [] }).action, 'requireApproval');
  const e1Approved = evaluateStage1(e1Safe, 'enforce', { approved: true, approvalRef: 'c7', recentApprovedProposals: [] });
  assert.equal(e1Approved.action, 'allow');
  assert.equal(e1Approved.approvalRef, 'c7');

  // Databricks DROP -> always deny even with human signoff, including beyond 16-statement display cap!
  const dropDesc = buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', seq: 3, method: 'POST',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'w1', statement: `${'SELECT 1; '.repeat(16)}DROP TABLE fin.ledger` })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(evaluateStage1(dropDesc.safe, 'enforce', { approved: true, approvalRef: 'c5', recentApprovedProposals: [] }).action, 'deny');

  // Precedence checks: wire DELETE + SQL-read or GraphQL-query MUST NOT bypass http_delete; wire POST + override PUT Databricks DROP MUST still deny; approved write with unread body MUST escalate!
  const postOverrideDrop = buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', seq: 21, method: 'POST',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json', 'x-http-method-override': 'PUT' },
    rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'w1', statement: 'DROP TABLE fin.ledger' })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(evaluateStage1(postOverrideDrop.safe, 'enforce', { approved: true, approvalRef: 'c5', recentApprovedProposals: [] }).action, 'deny');

  const delSqlRead = buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', seq: 22, method: 'DELETE',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json', 'x-http-method-override': 'POST' },
    rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'w1', statement: 'SELECT 1' })),
    bodyComplete: true,
  }).descriptor;
  const dDelSql = evaluateStage1(delSqlRead.safe, 'enforce', { approved: false, recentApprovedProposals: [] });
  assert.equal(dDelSql.action, 'requireApproval');
  assert.equal(dDelSql.ruleId, 'http_delete');

  const unreadApprovedMail = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 23, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
    headers: { 'content-type': 'application/json', 'content-length': '200' },
    rawBody: undefined,
    bodyComplete: false,
    transport: 'not-read',
  }).descriptor;
  const dUnread = evaluateStage1(unreadApprovedMail.safe, 'enforce', { approved: true, approvalRef: 'c9', recentApprovedProposals: [] });
  assert.equal(dUnread.action, 'escalate');
  assert.equal(dUnread.ruleId, 'write_body_not_inspected');

  // Unguarded file overwrite (PUT .../content without If-Match) -> escalate
  const unguarded = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 4, method: 'PUT',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1:/pack.xlsx:/content'),
    headers: { 'content-type': 'application/octet-stream' },
    rawBody: Buffer.from([1, 2, 3]),
    bodyComplete: true,
  }).descriptor;
  const dUnguarded = evaluateStage1(unguarded.safe, 'observe', { approved: false, recentApprovedProposals: [] });
  assert.equal(dUnguarded.action, 'escalate');
  assert.equal(dUnguarded.ruleId, 'unguarded_overwrite_no_if_match');

  // Current-epoch approval check: structured scope, workspace binding, owner/approver authority, and single-use consumption!
  const mailDesc = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 50, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ message: { toRecipients: [{ emailAddress: { address: 'cfo@acme.test' } }] } })),
    bodyComplete: true,
  }).descriptor;
  const competitorMail = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 51, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ message: { toRecipients: [{ emailAddress: { address: 'ceo@competitor.test' } }] } })),
    bodyComplete: true,
  }).descriptor;
  const fileDelDesc = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 52, method: 'DELETE',
    url: new URL('https://graph.microsoft.com/v1.0/drives/b1/items/01ABC'),
    headers: {}, bodyComplete: true,
  }).descriptor;

  // Unrelated prose proposal signed by an arbitrary viewer NEVER unlocks destructive actions!
  const badLog: Entry[] = [
    { seq: 1, at: '2026-11-01T00:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-01T00:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'May I rename the draft summary?', run: 1 },
    { seq: 3, at: '2026-11-01T00:02:00Z', by: 'viewer@x.test', op: 'signoff', on: 2, text: 'Sure' },
  ];
  assert.equal(findCurrentEpochApproval(badLog, { owner: 'alice@demo.test', workspace: 'w', safe: mailDesc.safe }).approved, false, 'unrelated prose + viewer signoff rejected');
  assert.equal(findCurrentEpochApproval(badLog, { owner: 'alice@demo.test', workspace: 'w', safe: fileDelDesc.safe }).approved, false);

  // Scoped proposal: enforced across authority boundary, workspace, owner, target/domain, and single-use count!
  const log: Entry[] = [
    { seq: 1, at: '2026-11-01T00:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-01T00:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Send mail', run: 1, execpolicy: { action: 'graph:sendMail', domains: ['acme.test'], workspace: 'w', maxUses: 1 } },
    { seq: 3, at: '2026-11-01T00:02:00Z', by: 'viewer@x.test', op: 'signoff', on: 2, text: 'Viewer cannot approve' },
    { seq: 4, at: '2026-11-01T00:02:30Z', by: 'alice@demo.test', op: 'signoff', on: 2, text: 'Owner approved' },
    { seq: 5, at: '2026-11-01T00:03:00Z', by: 'server', op: 'authority', owner: 'bob@demo.test', epoch: 2, workspace: 'w' },
  ];
  // Viewer signoff at seq 3 alone does NOT approve:
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 3, owner: 'alice@demo.test', workspace: 'w', safe: mailDesc.safe }).approved, false, 'non-owner viewer signoff rejected');
  // Owner signoff at seq 4 approves matching mail in workspace 'w':
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 4, owner: 'alice@demo.test', workspace: 'w', safe: mailDesc.safe }).approved, true);
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 4, owner: 'alice@demo.test', workspace: 'w', safe: mailDesc.safe }).approvalRef, 'c2');
  // Wrong workspace / wrong recipient domain / wrong action all rejected:
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 4, owner: 'alice@demo.test', workspace: 'other-ws', safe: mailDesc.safe }).approved, false, 'wrong workspace rejected');
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 4, owner: 'alice@demo.test', workspace: 'w', safe: competitorMail.safe }).approved, false, 'unapproved recipient domain rejected');
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 4, owner: 'alice@demo.test', workspace: 'w', safe: fileDelDesc.safe }).approved, false, 'different action rejected');
  // Authority boundary at seq 5 retires earlier approval:
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 5, owner: 'bob@demo.test', workspace: 'w', safe: mailDesc.safe }).approved, false, 'authority boundary retires earlier approval');
  log.push(
    { seq: 6, at: '2026-11-01T00:04:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Send mail in epoch 2', run: 2, execpolicy: { action: 'graph:sendMail', domains: ['acme.test'], workspace: 'w', maxUses: 1 } },
    { seq: 7, at: '2026-11-01T00:05:00Z', by: 'bob@demo.test', op: 'signoff', on: 6, text: 'OK' },
  );
  assert.equal(findCurrentEpochApproval(log, { owner: 'bob@demo.test', workspace: 'w', safe: mailDesc.safe }).approved, true);
  assert.equal(findCurrentEpochApproval(log, { owner: 'bob@demo.test', workspace: 'w', safe: mailDesc.safe }).approvalRef, 'c6');
  // Consuming c6 once exhausts maxUses=1:
  log.push({ seq: 8, at: '2026-11-01T00:05:10Z', by: 'agent', op: 'call', run: 2, name: 'graph', method: 'POST', path: '/v1.0/me/sendMail', status: 202, bytes: 0, policy: { decisionId: 'd', mode: 'enforce', action: 'allow', ruleId: 'graph_send_mail_approved', policyVersion: 'v1', approvalRef: 'c6' } });
  assert.equal(findCurrentEpochApproval(log, { owner: 'bob@demo.test', workspace: 'w', safe: mailDesc.safe }).approved, false, 'consumed single-use approval cannot unlock a 2nd call');
});

test('P1-1 O(N) MIME recipient scanner, P1-2 Spark SQL comment/raw-string lexer fail-closed, P2-7 rule coverage & P2-8 quote-aware SOAP', () => {
  // P1-1: adversarial 60 KiB dotless MIME To header must scan in <50ms (no quadratic regex ReDoS!)
  const evilMime = Buffer.from(`From: alice@demo.test\r\nTo: ${'a'.repeat(23_000)}@${'b'.repeat(23_000)}\r\n\r\nbody`).toString('base64');
  const t0 = performance.now();
  const badRes = extractMimeRecipientDomains(evilMime);
  const dt = performance.now() - t0;
  assert.ok(dt < 50, `extractMimeRecipientDomains must run in <50ms (took ${dt.toFixed(1)}ms)`);
  assert.deepEqual(badRes, { domains: [], count: 0, complete: false });

  const goodMime = Buffer.from('From: alice@demo.test\r\nTo: Jane <jane@acme.test>, cfo@partner.org\r\nCc: audit@acme.test\r\n\r\nhello').toString('base64');
  assert.deepEqual(extractMimeRecipientDomains(goodMime), { domains: ['acme.test', 'partner.org'], count: 3, complete: true });

  // P1-2: Spark SqlBaseLexer comment/CR/nesting/raw-string attacks NEVER classify as read and DENY in enforce mode!
  const sparkAttacks = [
    '/* /* */ SELECT 1 -- */\rDROP TABLE prod.finance.gl',
    '-- a\\\nSELECT 1 -- x\rDROP TABLE t',
    '-- x\rDROP TABLE t',
    "SELECT r'\\' ; DROP TABLE t; --'",
  ];
  for (const sql of sparkAttacks) {
    const cls = classifySqlStatement(sql);
    assert.notEqual(cls.sqlClass, 'read', `attack SQL must never be classified as read: ${sql}`);
    assert.equal(cls.hasDropOrTruncate, true, `attack SQL must flag hasDropOrTruncate: ${sql}`);
    const desc = buildApiRequestDescriptor({
      connection: 'dbx', connectionType: 'databricks', seq: 1, method: 'POST',
      url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'w1', statement: sql })),
      bodyComplete: true,
    }).descriptor;
    const dec = evaluateStage1(desc.safe, 'enforce', { approved: true, approvalRef: 'c1', recentApprovedProposals: [] });
    assert.equal(dec.action, 'deny', `attack SQL must deny unconditionally: ${sql}`);
    assert.equal(dec.ruleId, 'databricks_destructive_ddl');
  }
  // Ambiguous comment without destructive keyword STILL never classifies as read (escalates databricks_sql_unknown):
  const ambig = classifySqlStatement('-- note\rSELECT 1');
  assert.equal(ambig.sqlClass, 'unknown');
  assert.equal(ambig.ambiguous, true);

  // P2-7: Graph permanentDelete, SharePoint recycle(), E1 formActions writes, and Graph excel_write all requireApproval!
  const permDel = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 2, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1/permanentDelete'),
    headers: {}, bodyComplete: true,
  }).descriptor;
  assert.equal(permDel.safe.actions[0].op, 'graph:file_delete');
  assert.equal(evaluateStage1(permDel.safe, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'graph_file_delete');

  const spRecycle = extractSemantic({
    url: new URL('https://tenant.sharepoint.com/sites/fin/_api/web/lists/getbytitle(%27Docs%27)/items(1)/recycle()'),
    sanitizedPath: '/sites/fin/_api/web/lists/getbytitle(%27Docs%27)/items(1)/recycle()',
    method: 'POST', effectiveMethod: 'POST', kind: 'http', rawHeaders: {}, bodyComplete: true,
    transport: 'complete', isWrite: true, isAuth: false, isLive: false, projection: 'semantic',
  });
  assert.equal(spRecycle.actions[0].op, 'sharepoint:delete');
  assert.equal(evaluateStage1({
    descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'sp' }, seq: 3, t: '', kind: 'http',
    scheme: 'https', authority: 'tenant.sharepoint.com', path: '/sites/fin/_api/web/lists/items(1)/recycle()',
    url: 'https://tenant.sharepoint.com/sites/fin/_api/web/lists/items(1)/recycle()',
    method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true, prefixBytes: 0,
    bodyComplete: true, decodeComplete: true, completeness: spRecycle.completeness, actions: spRecycle.actions,
  }, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'sharepoint_destructive_write');

  const e1FormAct = extractSemantic({
    url: new URL('https://erp.example.com/jderest/v2/formservice'),
    sanitizedPath: '/jderest/v2/formservice',
    method: 'POST', effectiveMethod: 'POST', kind: 'http', rawHeaders: { 'content-type': 'application/json' },
    reqType: 'application/json',
    decodedBuf: Buffer.from(JSON.stringify({ formName: 'P0411_W0411A', formActions: [{ command: 'DoAction', controlID: '12' }] })),
    bodyComplete: true, transport: 'complete', isWrite: true, isAuth: false, isLive: false, projection: 'semantic',
  });
  assert.equal(evaluateStage1({
    descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'e1' }, seq: 4, t: '', kind: 'http',
    scheme: 'https', authority: 'erp.example.com', path: '/jderest/v2/formservice',
    url: 'https://erp.example.com/jderest/v2/formservice',
    method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true, prefixBytes: 50,
    bodyComplete: true, decodeComplete: true, completeness: e1FormAct.completeness, actions: e1FormAct.actions,
  }, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'e1_ais_write');

  const xlWrite = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 5, method: 'PATCH',
    url: new URL("https://graph.microsoft.com/v1.0/drives/d1/items/i1/workbook/worksheets/Sheet1/range(address='A1')"),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ values: [[42]] })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(evaluateStage1(xlWrite.safe, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'graph_excel_write');

  // P2-8: SOAP quote-aware tag end scan resists '>' inside attribute values & verifies Envelope->Body depth
  const soap = extractSemantic({
    url: new URL('https://erp.example.com/soap'),
    sanitizedPath: '/soap',
    method: 'POST', effectiveMethod: 'POST', kind: 'http',
    hdr: { soapaction: '"GetBalance"' },
    rawHeaders: { 'content-type': 'text/xml', soapaction: '"GetBalance"' },
    reqType: 'text/xml',
    decodedBuf: Buffer.from('<s:Envelope><s:Body x="><GetBalance/>"><DeleteVendor/></s:Body></s:Envelope>'),
    bodyComplete: true, transport: 'complete', isWrite: true, isAuth: false, isLive: false, projection: 'semantic',
  });
  assert.equal(soap.actions[0].details?.bodyRootQName, 'DeleteVendor');
  assert.equal(soap.actions[0].details?.actionMismatch, true);
});

test('R2 security hardening: HMAC target/SQL digests, complete mail recipients, Spark backticks/MERGE DELETE/INSERT OVERWRITE, mailbox permanentDelete, SharePoint & full-list E1', () => {
  const hmacKey = Buffer.alloc(32, 0x42);

  // 1. Keyed HMAC target digest prevents redacted-path collision between two realistic Graph drive item IDs!
  const fileA = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', hmacKey, seq: 1, method: 'DELETE',
    url: new URL('https://graph.microsoft.com/v1.0/me/drive/items/01BYE5RZ6QN3K4L8M9N2P5Q7'),
    headers: {}, bodyComplete: true,
  }).descriptor;
  const fileB = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', hmacKey, seq: 2, method: 'DELETE',
    url: new URL('https://graph.microsoft.com/v1.0/me/drive/items/01K7QW2M4X9B1C3D5F7H8J2Z9'),
    headers: {}, bodyComplete: true,
  }).descriptor;
  assert.equal(fileA.safe.path, fileB.safe.path, 'sanitized display paths collapse to [REDACTED:seg]');
  const digestA = fileA.safe.actions[0].details?.targetDigest as string;
  const digestB = fileB.safe.actions[0].details?.targetDigest as string;
  assert.match(digestA, /^[a-f0-9]{64}$/);
  assert.notEqual(digestA, digestB, 'keyed HMAC targetDigest is distinct per real item ID');

  const delLog: Entry[] = [
    { seq: 1, at: '2026-11-27T01:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-27T01:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Delete file A', execpolicy: { action: 'graph:file_delete', targetDigest: digestA, workspace: 'w', maxUses: 1 } },
    { seq: 3, at: '2026-11-27T01:02:00Z', by: 'alice@demo.test', op: 'signoff', on: 2, text: 'Approved' },
  ];
  assert.equal(findCurrentEpochApproval(delLog, { owner: 'alice@demo.test', workspace: 'w', safe: fileA.safe }).approved, true, 'file A matches its own HMAC digest');
  assert.equal(findCurrentEpochApproval(delLog, { owner: 'alice@demo.test', workspace: 'w', safe: fileB.safe }).approved, false, 'file A approval NEVER unlocks file B');

  // 2. Keyed HMAC SQL context digest binds parameters, catalog, schema, and warehouse_id (and NEVER emits unsalted sqlHash or param values!)
  const makeSql = (body: Record<string, unknown>) => buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', hmacKey, seq: 3, method: 'POST',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify(body)),
    bodyComplete: true,
  }).descriptor;
  const sqlBase = makeSql({ warehouse_id: 'wh1', catalog: 'prod', schema: 'fin', statement: 'DELETE FROM gl WHERE id = :id', parameters: [{ name: 'id', value: '101', type: 'INT' }] });
  const sqlDiffParam = makeSql({ warehouse_id: 'wh1', catalog: 'prod', schema: 'fin', statement: 'DELETE FROM gl WHERE id = :id', parameters: [{ name: 'id', value: '999', type: 'INT' }] });
  const sqlDiffCat = makeSql({ warehouse_id: 'wh1', catalog: 'staging', schema: 'fin', statement: 'DELETE FROM gl WHERE id = :id', parameters: [{ name: 'id', value: '101', type: 'INT' }] });
  const sqlDiffSch = makeSql({ warehouse_id: 'wh1', catalog: 'prod', schema: 'hr', statement: 'DELETE FROM gl WHERE id = :id', parameters: [{ name: 'id', value: '101', type: 'INT' }] });
  const sqlDiffWh = makeSql({ warehouse_id: 'wh2', catalog: 'prod', schema: 'fin', statement: 'DELETE FROM gl WHERE id = :id', parameters: [{ name: 'id', value: '101', type: 'INT' }] });
  const dBase = sqlBase.safe.actions[0].details?.sqlContextDigest as string;
  assert.match(dBase, /^[a-f0-9]{64}$/);
  assert.equal(sqlBase.safe.actions[0].details?.sqlHash, undefined, 'unsalted sqlHash removed');
  assert.ok(!JSON.stringify(sqlBase.safe).includes('101'), 'parameter value never logged');
  assert.notEqual(dBase, sqlDiffParam.safe.actions[0].details?.sqlContextDigest, 'different parameters change sqlContextDigest');
  assert.notEqual(dBase, sqlDiffCat.safe.actions[0].details?.sqlContextDigest, 'different catalog changes sqlContextDigest');
  assert.notEqual(dBase, sqlDiffSch.safe.actions[0].details?.sqlContextDigest, 'different schema changes sqlContextDigest');
  assert.notEqual(dBase, sqlDiffWh.safe.actions[0].details?.sqlContextDigest, 'different warehouse changes sqlContextDigest');
  const sqlLog: Entry[] = [
    { seq: 1, at: '2026-11-27T01:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-27T01:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Delete row 101', execpolicy: { action: 'databricks:sql', sqlContextDigest: dBase, warehouseId: 'wh1', workspace: 'w', maxUses: 1 } },
    { seq: 3, at: '2026-11-27T01:02:00Z', by: 'alice@demo.test', op: 'signoff', on: 2, text: 'Approved' },
  ];
  assert.equal(findCurrentEpochApproval(sqlLog, { owner: 'alice@demo.test', workspace: 'w', safe: sqlBase.safe }).approved, true);
  assert.equal(findCurrentEpochApproval(sqlLog, { owner: 'alice@demo.test', workspace: 'w', safe: sqlDiffParam.safe }).approved, false);
  assert.equal(findCurrentEpochApproval(sqlLog, { owner: 'alice@demo.test', workspace: 'w', safe: sqlDiffCat.safe }).approved, false);
  assert.equal(findCurrentEpochApproval(sqlLog, { owner: 'alice@demo.test', workspace: 'w', safe: sqlDiffSch.safe }).approved, false);
  assert.equal(findCurrentEpochApproval(sqlLog, { owner: 'alice@demo.test', workspace: 'w', safe: sqlDiffWh.safe }).approved, false);

  // 3. Fail-closed authority (empty actors) & fail-closed missing proposal workspace
  const noOwnerLog: Entry[] = [
    { seq: 1, at: '2026-11-27T01:00:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Delete A', execpolicy: { action: 'graph:file_delete', targetDigest: digestA, maxUses: 1 } },
    { seq: 2, at: '2026-11-27T01:01:00Z', by: 'random-viewer@demo.test', op: 'signoff', on: 1, text: 'Ok' },
  ];
  assert.equal(findCurrentEpochApproval(noOwnerLog, { safe: fileA.safe }).approved, false, 'empty authorizedActors MUST fail closed');
  const missingWsLog: Entry[] = [
    { seq: 1, at: '2026-11-27T01:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-27T01:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Delete A', execpolicy: { action: 'graph:file_delete', targetDigest: digestA, maxUses: 1 } },
    { seq: 3, at: '2026-11-27T01:02:00Z', by: 'alice@demo.test', op: 'signoff', on: 2, text: 'Ok' },
  ];
  assert.equal(findCurrentEpochApproval(missingWsLog, { owner: 'alice@demo.test', workspace: 'w', safe: fileA.safe }).approved, false, 'missing proposal workspace fails closed when expectedWorkspace is known');

  // 4. Server scope validator rejects wildcards, broad prefixes, unknown fields, and out-of-range maxUses
  for (const badScope of [
    { action: 'graph:excel_write', target: '/v1.0' },
    { action: 'graph:file_delete', target: '/v1.0/me/drive/items/[REDACTED:seg]' },
    { action: 'graph:sendMail', domains: ['*.evil.test'] },
    { action: 'databricks:sql', target: 'write', warehouseId: 'wh1' },
    { action: 'graph:sendMail', domains: ['ok.test'], maxUses: 100 },
    { action: 'graph:sendMail', domains: ['ok.test'], workspace: 'other-ws' },
  ]) {
    assert.throws(() => validateAndNormalizeApprovalScope(badScope, { workspace: 'w', hmacKey }), /./, `rejects invalid scope: ${JSON.stringify(badScope)}`);
  }

  // 5. Complete fail-closed mail recipient extraction (all Opus P1-4 + Astra P1-3 repros!)
  const mailApprovalLog: Entry[] = [
    { seq: 1, at: '2026-11-27T01:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-27T01:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Send mail', execpolicy: { action: 'graph:sendMail', domains: ['allowed.test'], workspace: 'w', maxUses: 1 } },
    { seq: 3, at: '2026-11-27T01:02:00Z', by: 'alice@demo.test', op: 'signoff', on: 2, text: 'Ok' },
  ];
  const badMimes = [
    `From: alice@demo.test\r\nTo: a@allowed.test\r\nX-Pad: ${'x'.repeat(9000)}\r\nBcc: spy@evil.test\r\n\r\nbody`,
    'From: alice@demo.test\r\nTo: a@allowed.test, "spy"@evil.test\r\n\r\nbody',
    'From: alice@demo.test\r\nTo: a@allowed.test, spy@[203.0.113.5]\r\n\r\nbody',
    'From: alice@demo.test\r\nTo: a@allowed.test, spy@evil.test.\r\n\r\nbody',
    'From: alice@demo.test\r\nTo: a@allowed.test, spy@evil_corp.test\r\n\r\nbody',
    'From: alice@demo.test\r\nTo: a@allowed.test\r\nResent-To: spy@evil.test\r\n\r\nbody',
    'From: alice@demo.test\r\nTo: a@allowed.test, Alice (spy@evil.test) <b@allowed.test>\r\n\r\nbody',
    'From: alice@demo.test\r\nTo: Undisclosed: a@allowed.test;\r\n\r\nbody',
    `From: alice@demo.test\r\nTo: ${Array.from({ length: 34 }, (_, i) => `u@d${i}.allowed.test`).join(', ')}\r\n\r\nbody`,
  ];
  for (const rawMime of badMimes) {
    const b64 = Buffer.from(rawMime).toString('base64');
    const r = extractMimeRecipientDomains(b64);
    assert.equal(r.complete, false, `MIME must be marked incomplete: ${rawMime.slice(0, 80)}`);
    const desc = buildApiRequestDescriptor({
      connection: 'graph', connectionType: 'graph', seq: 1, method: 'POST',
      url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
      headers: { 'content-type': 'text/plain' }, rawBody: Buffer.from(b64), bodyComplete: true,
    }).descriptor;
    assert.equal(findCurrentEpochApproval(mailApprovalLog, { owner: 'alice@demo.test', workspace: 'w', safe: desc.safe }).approved, false, 'incomplete MIME cannot match domain approval');
  }
  // Lowercase JSON bccrecipients is captured and blocks evil.test!
  const lowerBccDesc = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 1, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ message: { toRecipients: [{ emailAddress: { address: 'a@allowed.test' } }], bccrecipients: [{ emailaddress: { address: 'spy@evil.test' } }] } })),
    bodyComplete: true,
  }).descriptor;
  assert.deepEqual(lowerBccDesc.safe.actions[0].details?.recipientDomains, ['allowed.test', 'evil.test']);
  assert.equal(findCurrentEpochApproval(mailApprovalLog, { owner: 'alice@demo.test', workspace: 'w', safe: lowerBccDesc.safe }).approved, false);
  // reply / replyAll / draft send ALWAYS have recipientsComplete: false and cannot match domain-only approval
  for (const path of ['/v1.0/me/messages/m1/reply', '/v1.0/me/messages/m1/replyAll', '/v1.0/me/messages/m1/send']) {
    const d = buildApiRequestDescriptor({
      connection: 'graph', connectionType: 'graph', seq: 1, method: 'POST',
      url: new URL(`https://graph.microsoft.com${path}`),
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify({ comment: 'ok', message: { toRecipients: [{ emailAddress: { address: 'a@allowed.test' } }] } })),
      bodyComplete: true,
    }).descriptor;
    assert.equal(d.safe.actions[0].details?.recipientsComplete, false, `${path} must set recipientsComplete=false`);
    assert.equal(findCurrentEpochApproval(mailApprovalLog, { owner: 'alice@demo.test', workspace: 'w', safe: d.safe }).approved, false);
  }
  // >32 JSON domains -> recipientsComplete: false
  const manyJson = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 1, method: 'POST',
    url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ message: { toRecipients: Array.from({ length: 34 }, (_, i) => ({ emailAddress: { address: `u@d${i}.test` } })) } })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(manyJson.safe.actions[0].details?.recipientsComplete, false);

  // 6. Spark backtick identifiers + MERGE ... THEN DELETE + INSERT OVERWRITE + REPLACE WHERE
  const backtickAttack = 'SELECT `a\\` ; DROP TABLE x -- `';
  const btCls = classifySqlStatement(backtickAttack);
  assert.equal(btCls.hasDropOrTruncate, true, 'Spark backtick does NOT treat backslash as escape');
  assert.notEqual(btCls.sqlClass, 'read');
  assert.equal(classifySqlStatement('SELECT `col``name` FROM t').sqlClass, 'read', 'Spark doubled backtick is a valid read');

  for (const mergeDel of [
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'WITH a AS (SELECT 1 AS id) MERGE INTO t USING a ON t.id = a.id WHEN MATCHED THEN DELETE',
  ]) {
    const c = classifySqlStatement(mergeDel);
    assert.equal(c.hasDelete, true, `MERGE THEN DELETE flags hasDelete: ${mergeDel}`);
    assert.equal(c.destructive, true);
    const d = makeSql({ warehouse_id: 'wh1', statement: mergeDel });
    assert.equal(evaluateStage1(d.safe, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'databricks_ddl_or_delete');
  }
  for (const overwriteSql of [
    'WITH a AS (SELECT 1) INSERT OVERWRITE t SELECT * FROM a',
    'INSERT OVERWRITE prod.gl SELECT * FROM staging.gl',
    'INSERT INTO prod.gl REPLACE WHERE period = 1 SELECT * FROM staging.gl',
  ]) {
    const c = classifySqlStatement(overwriteSql);
    assert.equal(c.hasDropOrTruncate, true, `overwrite/replace flags hasDropOrTruncate: ${overwriteSql}`);
    const d = makeSql({ warehouse_id: 'wh1', statement: overwriteSql });
    const dec = evaluateStage1(d.safe, 'enforce', { approved: true, approvalRef: 'c1', recentApprovedProposals: [] });
    assert.equal(dec.action, 'deny');
    assert.equal(dec.ruleId, 'databricks_destructive_ddl');
  }

  // 7. Mailbox permanentDelete, SharePoint destructive endpoints, full-list E1 formActions + C/U/D, and If-Match: * rejection
  for (const path of ['/v1.0/me/messages/msg-123/permanentDelete', '/v1.0/users/alice@demo.test/mailFolders/inbox/permanentDelete']) {
    const d = buildApiRequestDescriptor({
      connection: 'graph', connectionType: 'graph', hmacKey, seq: 1, method: 'POST',
      url: new URL(`https://graph.microsoft.com${path}`), headers: {}, bodyComplete: true,
    }).descriptor;
    assert.equal(d.safe.actions[0].op, 'graph:file_delete');
    assert.equal(evaluateStage1(d.safe, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'graph_file_delete');
  }
  for (const spPath of [
    '/sites/fin/_api/web/recyclebin/deleteall()',
    '/sites/fin/_api/site/recyclebin/deleteallsecondstageitems()',
    '/sites/fin/_api/web/lists/items(1)/deletewithparameters',
    '/sites/fin/_api/web/lists/items(1)/recyclewithparameters',
  ]) {
    const sp = extractSemantic({
      url: new URL(`https://tenant.sharepoint.com${spPath}`), sanitizedPath: spPath,
      method: 'POST', effectiveMethod: 'POST', kind: 'http', rawHeaders: {}, bodyComplete: true,
      transport: 'complete', isWrite: true, isAuth: false, isLive: false, projection: 'semantic',
    });
    assert.equal(sp.actions[0].op, 'sharepoint:delete', `SharePoint destructive path classified: ${spPath}`);
  }
  for (const actCode of ['C', 'U', 'D']) {
    const e1 = extractSemantic({
      url: new URL('https://erp.example.com/jderest/v2/formservice'), sanitizedPath: '/jderest/v2/formservice',
      method: 'POST', effectiveMethod: 'POST', kind: 'http', rawHeaders: { 'content-type': 'application/json' },
      reqType: 'application/json', decodedBuf: Buffer.from(JSON.stringify({ formName: 'P0411_W0411A', formServiceAction: actCode })),
      bodyComplete: true, transport: 'complete', isWrite: true, isAuth: false, isLive: false, projection: 'semantic',
    });
    assert.equal(evaluateStage1({
      descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'e1' }, seq: 1, t: '', kind: 'http',
      scheme: 'https', authority: 'erp.example.com', path: '/jderest/v2/formservice', url: 'https://erp.example.com/jderest/v2/formservice',
      method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true, prefixBytes: 50,
      bodyComplete: true, decodeComplete: true, completeness: e1.completeness, actions: e1.actions,
    }, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'e1_ais_write');
  }
  // 35 formActions with mutating DoAction at index 33 (past 32-item display cap) -> MUST STILL gate!
  const longActions = [
    ...Array.from({ length: 33 }, (_, i) => ({ command: 'SetQBEValue', controlID: String(i) })),
    { command: 'DoAction', controlID: '12' },
  ];
  const e1Long = extractSemantic({
    url: new URL('https://erp.example.com/jderest/v2/formservice'), sanitizedPath: '/jderest/v2/formservice',
    method: 'POST', effectiveMethod: 'POST', kind: 'http', rawHeaders: { 'content-type': 'application/json' },
    reqType: 'application/json', decodedBuf: Buffer.from(JSON.stringify({ formName: 'P0411_W0411A', formActions: longActions })),
    bodyComplete: true, transport: 'complete', isWrite: true, isAuth: false, isLive: false, projection: 'semantic',
  });
  assert.equal(e1Long.actions[0].details?.hasMutatingFormAction, true);
  assert.equal(e1Long.actions[0].details?.formActionsTruncated, true);
  assert.equal(evaluateStage1({
    descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'e1' }, seq: 1, t: '', kind: 'http',
    scheme: 'https', authority: 'erp.example.com', path: '/jderest/v2/formservice', url: 'https://erp.example.com/jderest/v2/formservice',
    method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true, prefixBytes: 50,
    bodyComplete: true, decodeComplete: true, completeness: e1Long.completeness, actions: e1Long.actions,
  }, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'e1_ais_write');

  // If-Match: * and W/"etag" are rejected as unguarded overwrites!
  for (const badEtag of ['*', ' * ', 'W/"e1"', 'w/"e1"', '""']) {
    const fw = buildApiRequestDescriptor({
      connection: 'graph', connectionType: 'graph', seq: 1, method: 'PUT',
      url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1/content'),
      headers: { 'content-type': 'application/octet-stream', 'if-match': badEtag },
      rawBody: Buffer.from('abc'), bodyComplete: true,
    }).descriptor;
    assert.equal(fw.safe.actions[0].details?.hasIfMatch, false, `If-Match ${badEtag} must be rejected`);
    assert.equal(evaluateStage1(fw.safe, 'enforce', { approved: false, recentApprovedProposals: [] }).ruleId, 'unguarded_overwrite_no_if_match');
  }
});

test('Stage-2 TriageHook: shadow adds zero latency, enforce fails closed on throw/timeout, and Stage-2 never overrides Stage-1 deny', async () => {
  const unguarded = buildApiRequestDescriptor({
    connection: 'graph', connectionType: 'graph', seq: 1, method: 'PUT',
    url: new URL('https://graph.microsoft.com/v1.0/drives/d1/items/i1:/pack.xlsx:/content'),
    headers: { 'content-type': 'application/octet-stream' },
    rawBody: Buffer.from([1, 2, 3]),
    bodyComplete: true,
  }).descriptor;

  // 1. Shadow mode: slow 150ms hook returns immediately (<50ms) and invokes onShadowDecision asynchronously with ONLY safe view
  let receivedInput: any;
  const shadowDone = Promise.withResolvers<any>();
  const shadowEngine = new ExecPolicyEngine(async input => {
    receivedInput = input;
    await new Promise(r => setTimeout(r, 120));
    return { action: 'allow', ruleId: 'stage2_ok', reason: 'matches intent' };
  });
  const t0 = performance.now();
  const res = await shadowEngine.evaluate(unguarded, {
    mode: 'shadow',
    intent: { run: 1, series: 's1', taskSummary: 'update pack' },
    onShadowDecision: d => shadowDone.resolve(d),
  });
  const elapsed = performance.now() - t0;
  assert.equal(res.action, 'escalate');
  assert.ok(elapsed < 60, `shadow mode must not delay live request (took ${elapsed}ms)`);
  const shadowDec = await shadowDone.promise;
  assert.equal(shadowDec.stage, 2);
  assert.equal(shadowDec.action, 'allow');
  assert.equal(shadowDec.ruleId, 'stage2_allow', 'Stage-2 ruleId mapped strictly to host-owned closed set');
  assert.equal('raw' in receivedInput, false, 'TriageHook receives ONLY safe projection, never raw');

  // 1b. Shadow hook that ignores AbortSignal still releases its worker slot at deadlineMs!
  const stuckShadow = new ExecPolicyEngine(() => new Promise(() => {}));
  await stuckShadow.evaluate(unguarded, { mode: 'shadow', deadlineMs: 30 });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(stuckShadow.shadowPending, 0, 'timed-out shadow hook releases worker slot even when ignoring AbortSignal');

  // 2. Enforce mode: hook throw -> fail-closed deny with ruleId policy_error
  const throwingEngine = new ExecPolicyEngine(() => { throw new Error('model down'); });
  const errDec = await throwingEngine.evaluate(unguarded, { mode: 'enforce' });
  assert.equal(errDec.action, 'deny');
  assert.equal(errDec.ruleId, 'policy_error');

  // 2b. Enforce mode: Stage-2 hook returning custom ruleId text is clamped to host-owned stage2_deny (no reasoning oracle)
  const oracleEngine = new ExecPolicyEngine(() => ({ action: 'deny', ruleId: 'secret prompt leak explanation', reason: 'internal details' }));
  const clamped = await oracleEngine.evaluate(unguarded, { mode: 'enforce' });
  assert.equal(clamped.action, 'deny');
  assert.equal(clamped.ruleId, 'stage2_deny');

  // 2c. Invalid RF_EXECPOLICY_MODE fails closed with policy_config_error instead of downgrading to observe!
  const prevMode = process.env.RF_EXECPOLICY_MODE;
  process.env.RF_EXECPOLICY_MODE = 'enforc-typo';
  try {
    const cfgFail = await shadowEngine.evaluate(unguarded);
    assert.equal(cfgFail.mode, 'enforce');
    assert.equal(cfgFail.action, 'deny');
    assert.equal(cfgFail.ruleId, 'policy_config_error');
  } finally {
    if (prevMode === undefined) delete process.env.RF_EXECPOLICY_MODE;
    else process.env.RF_EXECPOLICY_MODE = prevMode;
  }

  // 3. Enforce mode: hook timeout -> fail-closed deny with ruleId policy_error
  const slowEngine = new ExecPolicyEngine(async (_input, ctx) => {
    await new Promise(r => setTimeout(r, 300));
    return ctx.signal.aborted ? { action: 'deny' } : { action: 'allow' };
  });
  const timeoutDec = await slowEngine.evaluate(unguarded, { mode: 'enforce', deadlineMs: 40 });
  assert.equal(timeoutDec.action, 'deny');
  assert.equal(timeoutDec.ruleId, 'policy_error');

  // 4. Enforce mode: Stage-2 hook is NEVER called on Stage-1 deny (cannot override deny!)
  let called = false;
  const allowAllEngine = new ExecPolicyEngine(() => { called = true; return { action: 'allow' }; });
  const dropDesc = buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', seq: 2, method: 'POST',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'w1', statement: 'DROP TABLE t' })),
    bodyComplete: true,
  }).descriptor;
  const dropDec = await allowAllEngine.evaluate(dropDesc, { mode: 'enforce' });
  assert.equal(dropDec.action, 'deny');
  assert.equal(called, false, 'Stage-2 must never override Stage-1 deny');
});

test('replayExecPolicy deterministically replays saved log.jsonl + browser/*.jsonl and flags insufficient_evidence on capped/legacy writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-replay-'));
  try {
    mkdirSync(join(dir, 'browser'), { recursive: true });
    const mailDesc = buildApiRequestDescriptor({
      connection: 'graph', connectionType: 'graph', seq: 1, method: 'POST',
      url: new URL('https://graph.microsoft.com/v1.0/me/sendMail'),
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify({ message: { toRecipients: [{ emailAddress: { address: 'a@b.test' } }] } })),
      bodyComplete: true,
    }).descriptor;
    const pol1 = compactDecision(evaluateStage1(mailDesc.safe, 'observe', { approved: false, recentApprovedProposals: [] }));
    const logLines = [
      { seq: 1, at: '2026-11-27T01:00:00Z', by: 'alice@demo.test', op: 'create' },
      // send at seq 2, signoff arrives mid-flight at seq 4, call finishes at seq 5 -> replay MUST cut off at sent - 1 (seq 1) so signoff does NOT retroactively approve!
      { seq: 2, at: '2026-11-27T01:01:00Z', by: 'agent', op: 'send', run: 1, name: 'graph', method: 'POST', path: '/v1.0/me/sendMail' },
      { seq: 3, at: '2026-11-27T01:02:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Approve E1 post', run: 1, execpolicy: { action: 'e1_ais_write', target: 'P0411_W0411A', site: 'e1', maxUses: 1 } },
      { seq: 4, at: '2026-11-27T01:03:00Z', by: 'alice@demo.test', op: 'signoff', on: 3, text: 'Approved' },
      { seq: 5, at: '2026-11-27T01:03:05Z', by: 'agent', op: 'call', run: 1, name: 'graph', method: 'POST', path: '/v1.0/me/sendMail', isWrite: true, sent: 2, status: 202, bytes: 0, actions: mailDesc.safe.actions, completeness: mailDesc.safe.completeness, policy: pol1 },
      // Legacy API write without actions -> insufficient_evidence
      { seq: 6, at: '2026-11-27T01:04:00Z', by: 'agent', op: 'call', run: 1, name: 'graph', method: 'POST', path: '/v1.0/me/messages', status: 201, bytes: 10 },
    ];
    writeFileSync(join(dir, 'log.jsonl'), logLines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const browserLines = [
      // E1 write AFTER signoff -> allow with approvalRef c3
      {
        n: 1, descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'e1' }, seq: 1,
        t: '2026-11-27T01:03:30Z', kind: 'http', scheme: 'https', authority: 'erp.example.com',
        path: '/jderest/v2/formservice', url: 'https://erp.example.com/jderest/v2/formservice',
        method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true,
        prefixBytes: 80, bodyComplete: true, decodeComplete: true,
        completeness: { transport: 'complete', decode: 'complete', extract: 'complete' },
        actions: [{ family: 'e1-ais', op: 'formservice:W', resource: 'P0411_W0411A', details: { action: 'W' }, coverage: 'complete' }],
        status: 200, dispatch: 'dispatched',
        policy: { decisionId: 'd-e1', mode: 'observe', action: 'allow', ruleId: 'e1_ais_write_approved', policyVersion: 'v1', approvalRef: 'c3' },
      },
      // Log-capped write -> insufficient_evidence
      {
        n: 2, descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'e1' }, seq: 2,
        t: '2026-11-27T01:03:40Z', kind: 'http', scheme: 'https', authority: 'erp.example.com',
        path: '/api/x', url: 'https://erp.example.com/api/x',
        method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true,
        prefixBytes: 0, bodyComplete: false, decodeComplete: false,
        completeness: { transport: 'not-read', decode: 'none', extract: 'none' },
        actions: [], status: 200, dispatch: 'dispatched', logCapped: true,
      },
    ];
    writeFileSync(join(dir, 'browser', 'run 1 e1.jsonl'), browserLines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const summary = await replayExecPolicy(dir);
    assert.equal(summary.apiCount, 2);
    assert.equal(summary.browserCount, 2);
    assert.equal(summary.agreements, 2);
    assert.equal(summary.disagreements, 0);
    assert.equal(summary.counts.requireApproval, 1);
    assert.equal(summary.counts.allow, 1);
    assert.equal(summary.counts.insufficient_evidence, 2);

    // When host manifests exist, replay MUST verify SHA-256 and reject tampered/unmanifested files as insufficient_evidence!
    const manifestsDir = join(dir, 'manifests');
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(join(manifestsDir, 'sess1.json'), JSON.stringify({
      version: 1, inst: 'inst-replay', file: 'browser/run 1 e1.jsonl',
      artifacts: { 'browser/run 1 e1.jsonl': '0000000000000000000000000000000000000000000000000000000000000000' },
    }));
    const tamperedReplay = await replayExecPolicy(dir, { instId: 'inst-replay', manifestsDir });
    assert.ok(tamperedReplay.results.some(r => r.insufficientReason === 'browser_log_manifest_mismatch'));

    // Malformed non-object (`null`) line in log.jsonl does NOT crash replay and emits insufficient_evidence!
    writeFileSync(join(dir, 'log.jsonl'), `${logLines.map(l => JSON.stringify(l)).join('\n')}\nnull\n`);
    const nullLineReplay = await replayExecPolicy(dir);
    assert.ok(nullLineReplay.results.some(r => r.insufficientReason === 'malformed_instance_log_line'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
