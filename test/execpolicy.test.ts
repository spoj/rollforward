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
  extractSemantic,
  parseSemanticMethods,
} from '../src/extract.ts';
import {
  ExecPolicyEngine,
  compactDecision,
  evaluateStage1,
  findCurrentEpochApproval,
  replayExecPolicy,
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

  // Matrix parameter bypass check (%2F inside matrix param stays in-segment; real /login segment still caught)
  assert.equal(isAuthUrl('https://erp.example.com/jderest/v2/formservice;x=%2Flogin'), false);
  assert.equal(isAuthUrl('https://erp.example.com/jderest/v2/formservice;x=/login'), true);
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
  assert.deepEqual(mailDesc.safe.actions[0].details, {
    recipientDomains: ['acme.test', 'external.org'],
    recipientCount: 2,
    attachmentCount: 1,
  });
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
  assert.deepEqual(classifySqlStatement('/* comment */ WITH cte AS (SELECT 1) SELECT * FROM fin.gl'), { sqlClass: 'read', statements: ['SELECT'], destructive: false });
  assert.deepEqual(classifySqlStatement("SELECT 'DROP TABLE x' AS literal"), { sqlClass: 'read', statements: ['SELECT'], destructive: false });
  assert.deepEqual(classifySqlStatement('INSERT INTO fin.gl VALUES (1);'), { sqlClass: 'write', statements: ['INSERT'], destructive: false });
  assert.deepEqual(classifySqlStatement('SELECT 1; DROP TABLE fin.gl'), { sqlClass: 'ddl', statements: ['SELECT', 'DROP'], destructive: true });

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

  // Databricks DROP -> always deny even with human signoff!
  const dropDesc = buildApiRequestDescriptor({
    connection: 'dbx', connectionType: 'databricks', seq: 3, method: 'POST',
    url: new URL('https://adb-1.azuredatabricks.net/api/2.0/sql/statements'),
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify({ warehouse_id: 'w1', statement: 'DROP TABLE fin.ledger' })),
    bodyComplete: true,
  }).descriptor;
  assert.equal(evaluateStage1(dropDesc.safe, 'enforce', { approved: true, approvalRef: 'c5', recentApprovedProposals: [] }).action, 'deny');

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

  // Current-epoch approval check: prior-epoch signoff is IGNORED after an authority boundary!
  const log: Entry[] = [
    { seq: 1, at: '2026-11-01T00:00:00Z', by: 'alice@demo.test', op: 'create' },
    { seq: 2, at: '2026-11-01T00:01:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Send mail', run: 1 },
    { seq: 3, at: '2026-11-01T00:02:00Z', by: 'alice@demo.test', op: 'signoff', on: 2, text: 'Approved' },
    { seq: 4, at: '2026-11-01T00:03:00Z', by: 'server', op: 'authority', owner: 'bob@demo.test', epoch: 2 },
  ];
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 3 }).approved, true);
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 3 }).approvalRef, 'c2');
  assert.equal(findCurrentEpochApproval(log, { uptoSeq: 4 }).approved, false, 'authority boundary retires earlier approval');
  log.push(
    { seq: 5, at: '2026-11-01T00:04:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Send mail in epoch 2', run: 2 },
    { seq: 6, at: '2026-11-01T00:05:00Z', by: 'bob@demo.test', op: 'signoff', on: 5, text: 'OK' },
  );
  assert.equal(findCurrentEpochApproval(log).approved, true);
  assert.equal(findCurrentEpochApproval(log).approvalRef, 'c5');
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
      { seq: 2, at: '2026-11-27T01:01:00Z', by: 'agent', op: 'call', run: 1, name: 'graph', method: 'POST', path: '/v1.0/me/sendMail', status: 202, bytes: 0, actions: mailDesc.safe.actions, completeness: mailDesc.safe.completeness, policy: pol1 },
      { seq: 3, at: '2026-11-27T01:02:00Z', by: 'agent', op: 'comment', ask: 'proposal', text: 'Approve E1 post', run: 1 },
      { seq: 4, at: '2026-11-27T01:03:00Z', by: 'alice@demo.test', op: 'signoff', on: 3, text: 'Approved' },
      // Legacy API write without actions -> insufficient_evidence
      { seq: 5, at: '2026-11-27T01:04:00Z', by: 'agent', op: 'call', run: 1, name: 'graph', method: 'POST', path: '/v1.0/me/messages', status: 201, bytes: 10 },
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
