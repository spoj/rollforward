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
const { keepSignIn } = await import('../src/entra.ts');

keepSignIn(ALICE, entra.refresh(ALICE));
logins.saveLogin(ALICE, {
  id: 'm365', kind: 'm365', name: 'Microsoft 365', since: '2026-11-01T00:00:00Z',
  offers: [{ id: `m365:mail:${ALICE}`, name: `Mailbox ${ALICE}` }],
}, entra.refresh(ALICE));
await setConnection('graph', { type: 'graph' }, ALICE);
await setConnection('dbx', { type: 'databricks' }, ALICE);
logins.saveLogin(ALICE, {
  id: 'dbx', kind: 'databricks', name: 'Databricks dbx', since: '2026-11-01T00:00:00Z',
  offers: [{ id: 'dbx:adb-1.azuredatabricks.net/wh1', name: 'WH1' }],
}, entra.refresh(ALICE));

let upstreamHits = 0;
const upstream = createServer(async (req, res) => {
  upstreamHits++;
  for await (const _ of req) {}
  if (req.url?.startsWith('/api/v1/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ id: 'gen-1', usage: { cost: 0.001 } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
});
await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', ok));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
upstreams['graph.microsoft.com'] = upstreamBase;
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
  assert.deepEqual((mailCall.actions as any[])[0].details, { recipientDomains: ['vendor.test'], recipientCount: 1, attachmentCount: 0 });
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

  // Service method-override escalation (GET + X-HTTP-Method-Override: DELETE -> isWrite = true, logs send!)
  const beforeSend = entries.filter(e => e.op === 'send').length;
  const esc = await sendViaProxy(run, 'erp.rf.internal', 'GET', '/AP/voucher/99', { 'x-http-method-override': 'DELETE' });
  assert.equal(esc.status, 200);
  assert.equal(entries.filter(e => e.op === 'send').length, beforeSend + 1, 'escalated GET logs pre-flight send');
  const escCall = entries.findLast(e => e.op === 'call')!;
  assert.equal(escCall.effectiveMethod, 'DELETE');
  assert.equal((escCall.policy as any).ruleId, 'http_delete');

  // OpenRouter LLM call: zero actions/bodyShape/prompt leakage
  const or = await sendViaProxy(run, 'openrouter.ai', 'POST', '/api/v1/chat/completions', { 'content-type': 'application/json' }, JSON.stringify({
    model: 'openai/gpt-5-mini',
    messages: [{ role: 'user', content: 'SUPER PRIVATE PROMPT TEXT 998877' }],
  }));
  assert.equal(or.status, 200);
  const orCall = entries.findLast(e => e.op === 'call')!;
  assert.equal(orCall.actions, undefined);
  assert.equal(orCall.bodyShape, undefined);
  assert.equal(orCall.policy, undefined);
  assert.ok(!JSON.stringify(orCall).includes('SUPER PRIVATE PROMPT TEXT'));
});

test('enforce mode blocks unapproved sendMail / DROP / method-override downgrade with zero upstream hits and ruleId-only 403, and unlocks sendMail after current-epoch signoff', async () => {
  process.env.RF_EXECPOLICY_MODE = 'enforce';
  const { inst, run, entries } = makeRun([`m365:mail:${ALICE}`, 'dbx:adb-1.azuredatabricks.net/wh1', 'erp:AP/']);

  const hits0 = upstreamHits;
  // 1. Unapproved sendMail -> 403 with ONLY ruleId (no reasoning text), zero upstream hits, no `send`
  const r1 = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'S', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] },
  }));
  assert.equal(r1.status, 403);
  assert.equal(upstreamHits, hits0, 'zero bytes reach upstream');
  assert.equal(entries.some(e => e.op === 'send'), false, 'no send logged when blocked pre-flight');
  const parsed1 = JSON.parse(r1.text);
  assert.deepEqual(parsed1, { error: { code: 'rf_policy', ruleId: 'graph_send_mail' } }, 'returns ruleId ONLY, no reasoning oracle');

  // 2. Databricks DROP -> 403 ruleId only
  const r2 = await sendViaProxy(run, 'adb-1.azuredatabricks.net', 'POST', '/api/2.0/sql/statements', { 'content-type': 'application/json' }, JSON.stringify({
    warehouse_id: 'wh1', statement: 'DROP TABLE t',
  }));
  assert.equal(r2.status, 403);
  assert.deepEqual(JSON.parse(r2.text), { error: { code: 'rf_policy', ruleId: 'databricks_destructive_ddl' } });
  assert.equal(upstreamHits, hits0);

  // 3. Method-override downgrade on service -> 403 plain text ruleId only
  const r3 = await sendViaProxy(run, 'erp.rf.internal', 'POST', '/AP/vouchers', { 'x-http-method-override': 'GET' }, '{"a":1}');
  assert.equal(r3.status, 403);
  assert.equal(r3.text.trim(), 'blocked by policy: method_override_downgrade');
  assert.equal(upstreamHits, hits0);

  // 4. Current-epoch human signoff unlocks sendMail in enforce mode!
  const prop = inst.append('agent', 'comment', { ask: 'proposal', text: 'Send approved report', run: 1 });
  inst.append(ALICE, 'signoff', { on: prop.seq, text: 'Approved' });
  const r4 = await sendViaProxy(run, 'graph.microsoft.com', 'POST', '/v1.0/me/sendMail', { 'content-type': 'application/json' }, JSON.stringify({
    message: { subject: 'Approved', toRecipients: [{ emailAddress: { address: 'a@b.test' } }] },
  }));
  assert.equal(r4.status, 200);
  assert.equal(upstreamHits, hits0 + 1);
  const okCall = entries.findLast(e => e.op === 'call')!;
  assert.equal((okCall.policy as any).action, 'allow');
  assert.equal((okCall.policy as any).approvalRef, `c${prop.seq}`);
});
