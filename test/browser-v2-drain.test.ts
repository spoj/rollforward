import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, rfDir, saveTree, tree, writeJson } from '../src/system.ts';
import { createInstance, openStore } from '../src/store.ts';
import { startMessageStore } from '../src/message-store.ts';
import { authority, personDir, saveLogin } from '../src/logins.ts';
import { saveSeriesSettings } from '../src/series.ts';

// Mock rollforward-browser v0.3.0 (switchable to legacy v0.2.2)
let capabilities404 = false;
let malformedCapabilities = false;
let sealCalls = 0;
let sealedDeleteCalls: string[] = [];
let legacyDeleteCalls: string[] = [];
let openBodies: any[] = [];
let activityRequests: string[] = [];
let activity404 = false;
let malformedSeal = false;
let malformedDeleteAck = false;
let includeHttpEndError = false;
let remoteSessions = new Map<string, {
  sealed: boolean;
  state: unknown;
  http: any[];
  cdp: any[];
  shots: any[];
}>();

const mockService = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://127.0.0.1');
  if (u.pathname === '/capabilities' && req.method === 'GET') {
    if (capabilities404) return void res.writeHead(404).end('{"error":"no such route"}');
    if (malformedCapabilities) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '0.3.0' }));
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '0.3.0', auditV2: 2, seal: true, activity: true }));
  }
  if (u.pathname === '/sessions' && req.method === 'GET') {
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([...remoteSessions.keys()].map(id => ({ id }))));
  }
  if (u.pathname === '/sessions' && req.method === 'POST') {
    const raw = Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString();
    const body = JSON.parse(raw);
    openBodies.push(body);
    const id = `v2sess${openBodies.length}`;
    const isV2 = Boolean(!capabilities404 && body.auditV2?.v === 2);
    remoteSessions.set(id, {
      sealed: false,
      state: { cookies: [{ name: 'sid', value: 'refreshed-cookie', domain: 'erp.example.com', path: '/' }], origins: [] },
      http: [
        {
          n: 1, descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'erp' }, seq: 1,
          t: '2026-11-27T10:00:01Z', kind: 'http', scheme: 'https', authority: 'erp.example.com',
          path: '/api/v1/ledger', url: 'https://erp.example.com/api/v1/ledger?page=<num>',
          method: 'GET', effectiveMethod: 'GET', methodSource: 'wire', isWrite: false,
          prefixBytes: 0, bodyComplete: true, decodeComplete: true,
          completeness: { transport: 'not-read', decode: 'none', extract: 'none' }, actions: [],
          status: 200, dispatch: 'dispatched',
        },
        {
          n: 2, descV: 1, redactV: 1, extractorV: 1, surface: 'browser', target: { site: 'erp' }, seq: 2,
          t: '2026-11-27T10:00:02Z', kind: 'http', scheme: 'https', authority: 'erp.example.com',
          path: '/jderest/v2/formservice', url: 'https://erp.example.com/jderest/v2/formservice',
          method: 'POST', effectiveMethod: 'POST', methodSource: 'wire', isWrite: true,
          prefixBytes: 120, bodyComplete: true, decodeComplete: true,
          completeness: { transport: 'complete', decode: 'complete', extract: 'complete' },
          actions: [{ family: 'e1-ais', op: 'formservice:W', resource: 'P0411_W0411A', details: { action: 'W', formName: 'P0411_W0411A' }, coverage: 'complete' }],
          bodyShape: { formName: 'string', formServiceAction: 'string' },
          status: 200, dispatch: 'dispatched',
        },
      ],
      cdp: [
        { n: 1, t: '2026-11-27T10:00:01.500Z', conn: 1, method: 'Page.navigate', summary: { url: 'https://erp.example.com/app' } },
        { n: 2, t: '2026-11-27T10:00:02.500Z', conn: 1, method: 'Runtime.callFunctionOn', severity: 'high', summary: { exprLen: 500, exprHash64: 'abc123' } },
      ],
      shots: [
        { seq: 1, at: '2026-11-27T10:00:01.200Z', url: 'https://erp.example.com/app', trigger: 'nav', httpCursor: 1, cdpCursor: 1, jpeg: Buffer.from('jpeg-shot-1').toString('base64') },
        { seq: 2, at: '2026-11-27T10:00:02.200Z', url: 'https://erp.example.com/form', trigger: 'write', httpCursor: 2, cdpCursor: 2, jpeg: Buffer.from('jpeg-shot-2').toString('base64') },
      ],
    });
    return void res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
      id,
      cdp: `/sessions/${id}/cdp`,
      view: `/sessions/${id}/view`,
      ...(body.audit && { shots: `/sessions/${id}/shots` }),
      ...(isV2 && {
        seal: `/sessions/${id}/seal`,
        logV2: `/sessions/${id}/log`,
        cdpLog: `/sessions/${id}/cdp-log`,
        activity: `/sessions/${id}/view/activity`,
      }),
    }));
  }

  const m = /^\/sessions\/([^/]+)(.*)$/.exec(u.pathname);
  if (!m) return void res.writeHead(404).end('{"error":"not found"}');
  const [, id, rest] = m;
  const sess = remoteSessions.get(id);
  if (!sess) return void res.writeHead(404).end('{"error":"no such session"}');

  if (rest === '/seal' && req.method === 'POST') {
    sealCalls++;
    if (malformedSeal) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    }
    if (!sess.sealed) {
      sess.sealed = true;
      if (includeHttpEndError) {
        const endN = (sess.http.at(-1)?.n ?? 0) + 1;
        sess.http.push({ n: endN, rec: 'http_end', ref: 1, t: '2026-11-27T10:00:04Z', error: 'upstream_reset', incomplete: true });
      }
      // Append _summary & _tap.summary on seal just like rollforward-browser v0.3.0
      const nextLogN = (sess.http.at(-1)?.n ?? 0) + 1;
      sess.http.push({ n: nextLogN, rec: '_summary', t: '2026-11-27T10:00:05Z', collapsedGets: { 'erp.example.com:image': { count: 3, bytes: 900 } }, droppedGets: 0, refusedFullCount: 0, incompleteAtSeal: 0 });
      const nextCdpN = (sess.cdp.at(-1)?.n ?? 0) + 1;
      sess.cdp.push({ n: nextCdpN, rec: '_tap.summary', t: '2026-11-27T10:00:05Z', methodCounts: { 'Page.navigate': 1, 'Runtime.callFunctionOn': 1 }, depthLimited: 0, droppedCdp: 0, droppedHighSeverity: 0, tapDisabledCount: 0 });
    }
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      sealed: true,
      state: sess.state,
      logCursor: sess.http.at(-1)?.n ?? 0,
      cdpCursor: sess.cdp.at(-1)?.n ?? 0,
      shotCursor: sess.shots.at(-1)?.seq ?? 0,
      gaps: { droppedGets: 0, droppedCdp: 0, droppedShots: 0, refusedFull: 0 },
    }));
  }

  if (rest === '/log' && req.method === 'GET') {
    const after = Number(u.searchParams.get('after') ?? '0');
    const items = sess.http.filter(e => e.n > after);
    // Deliberately paginate 1 item per page to prove paginated draining!
    const page = items.slice(0, 1);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      oldestCursor: sess.http[0]?.n ?? 0,
      nextCursor: page.length ? page.at(-1).n : after,
      hasMore: items.length > 1,
      dropped: 0,
      entries: page,
    }));
  }

  if (rest === '/cdp-log' && req.method === 'GET') {
    const after = Number(u.searchParams.get('after') ?? '0');
    const items = sess.cdp.filter(e => e.n > after);
    const page = items.slice(0, 1);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      oldestCursor: sess.cdp[0]?.n ?? 0,
      nextCursor: page.length ? page.at(-1).n : after,
      hasMore: items.length > 1,
      dropped: 0,
      entries: page,
    }));
  }

  if (rest === '/shots' && req.method === 'GET') {
    const after = Number(u.searchParams.get('after') ?? '0');
    const items = sess.shots.filter(s => s.seq > after);
    if (u.searchParams.get('v') === '2') {
      const page = items.slice(0, 1);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        oldestSeq: sess.shots[0]?.seq ?? 0,
        nextSeq: page.length ? page.at(-1).seq : after,
        hasMore: items.length > 1,
        dropped: 0,
        items: page,
      }));
    }
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
  }

  if (rest === '/view/activity' && req.method === 'GET') {
    activityRequests.push(req.url!);
    if (activity404) return void res.writeHead(404).end('{"error":"activity hud not enabled"}');
    const after = Number(u.searchParams.get('after') ?? '0');
    return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
      live: false, oldestCursor: 1, nextCursor: 1, dropped: 0, writeCount: 1, blockedCount: 0,
      events: after < 1 ? [{ n: 1, t: '2026-11-27T10:00:02Z', kind: 'http', method: 'POST', status: 200, isWrite: true, detail: 'erp.example.com/jderest/v2/formservice' }] : [],
    }));
  }

  if (rest === '' && req.method === 'DELETE') {
    if (u.searchParams.get('sealed') === '1') {
      if (malformedDeleteAck) {
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false }));
      }
      remoteSessions.delete(id);
      sealedDeleteCalls.push(id);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ deleted: true }));
    }
    remoteSessions.delete(id);
    legacyDeleteCalls.push(id);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      state: sess.state,
      log: [{ t: '2026-11-27T10:00:01Z', method: 'GET', url: 'https://erp.example.com/', status: 200 }],
    }));
  }

  res.writeHead(404).end('{"error":"unknown"}');
});

let upgradeHeadersSeen: Record<string, string | string[] | undefined> = {};
mockService.on('upgrade', (req, socket) => {
  upgradeHeadersSeen = { ...req.headers };
  socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
});

await new Promise<void>(ok => mockService.listen(0, '127.0.0.1', ok));
const svcPort = (mockService.address() as { port: number }).port;
process.env.RF_BROWSER_URL = `http://127.0.0.1:${svcPort}`;
process.env.RF_BROWSER_KEY = 'test-browser-key';

const tmp = mkdtempSync(join(tmpdir(), 'rf-bv2-'));
initSystem(tmp);
openStore(tmp);
const ALICE = 'alice@demo.test';
saveTree({ workspaces: { w: { name: 'Acme', owners: [ALICE], members: [] } }, series: { s1: { name: 'ERP', workspace: 'w' } } });
saveSeriesSettings(join(tmp, 'series', 's1'), { version: 1, epoch: 1, since: '' });
writeJson('users.json', { [ALICE]: { role: 'admin' } });
writeJson('grants.json', { g1: { workspace: 'w', person: ALICE, site: 'erp', reason: 'test', at: '', state: 'approved' } });
mkdirSync(personDir(ALICE), { recursive: true });
writeFileSync(join(personDir(ALICE), 'websites.json'), JSON.stringify({
  erp: { url: 'https://erp.example.com/app', hosts: [], writeback: true, added: '2026-11-01T00:00:00Z' },
}));
saveLogin(ALICE, { id: 'web:erp', kind: 'website', name: 'erp', since: '2026-11-01T00:00:00Z', offers: [{ id: 'web:erp', name: 'erp' }] }, JSON.stringify({ cookies: [], origins: [] }));

const {
  Browsers,
  listBrowserAudits,
  passUpgrade,
  probeCapabilities,
  readBrowserAudit,
  reap,
  resetCapabilitiesCache,
  setTestBeforeKeepHook,
  viewActivity,
} = await import('../src/browsers.ts');

function makeInst(label: string) {
  const sid = `s-${label}`;
  saveTree({ ...tree(), series: { ...tree().series, [sid]: { name: label, workspace: 'w' } } });
  const dir = join(tmp, 'series', sid);
  startMessageStore(dir);
  const inst = createInstance(sid, label, ALICE);
  writeFileSync(join(dir, 'series.json'), JSON.stringify({
    version: 1, owner: ALICE, epoch: 1, since: '',
    consent: { by: ALICE, at: '', workspace: 'w', logins: ['web:erp'], autonomous: false },
  }));
  inst.append('server', 'run', { run: 1, runner: ALICE, initiator: ALICE, authority: authority(inst) });
  return inst;
}

after(() => {
  setTestBeforeKeepHook(undefined);
  mockService.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('v0.3.0 capabilities probe, auditV2 session open, seal -> paginated drain -> host SHA-256 manifest -> keep -> DELETE ?sealed=1, and manifest tamper detection', async () => {
  resetCapabilitiesCache();
  capabilities404 = false;
  const caps = await probeCapabilities();
  assert.deepEqual(caps, { version: '0.3.0', auditV2: 2, seal: true, activity: true });

  const inst = makeInst('v2full');
  const b = new Browsers(inst, 1);
  const id = await b.browser('erp');
  assert.ok(id);

  // Verify POST /sessions sent BOTH audit: true and auditV2
  const opened = openBodies.at(-1);
  assert.equal(opened.audit, true);
  assert.equal(opened.auditV2.v, 2);
  assert.equal(opened.auditV2.projection, 'semantic');
  assert.equal(opened.auditV2.cdp, true);
  assert.equal(opened.auditV2.hud, true);

  // Live view activity proxy works & handles 404 cleanly
  const actData = await viewActivity(id, 0) as any;
  assert.equal(actData.writeCount, 1);
  assert.equal(actData.events.length, 1);
  activity404 = true;
  await assert.rejects(() => viewActivity(id, 0), (e: any) => e.status === 404);
  activity404 = false;

  // Close triggers seal -> paginated drain -> host manifest -> keep -> DELETE ?sealed=1
  const sealsBefore = sealCalls;
  await b.close('erp');
  assert.equal(sealCalls, sealsBefore + 1);
  assert.ok(sealedDeleteCalls.includes(id), 'DELETE ?sealed=1 acknowledged reclamation');
  assert.equal(existsSync(join(rfDir(), 'browser-spool', id)), false, 'spool cleaned after ack');

  // Verify instance browser audit log entry & files
  const browserEntry = inst.log.find(e => e.op === 'browser' && !e.action)!;
  assert.equal(browserEntry.sessionId, id);
  assert.equal(browserEntry.requests, 2);
  assert.equal(browserEntry.attempts, 2);
  assert.equal(browserEntry.forwarded, 2);
  assert.equal(browserEntry.writes, 1);
  assert.equal(browserEntry.collapsedGets, 3);
  assert.equal(browserEntry.cdp, 2);
  assert.equal(browserEntry.shots, 2);
  assert.equal((browserEntry.policy as any).requireApproval, 1, 'browser E1 write evaluated by execpolicy');
  assert.equal((browserEntry.policy as any).flagged[0].ruleId, 'e1_ais_write');

  // Verify manifest & integrity check
  const manifests = listBrowserAudits(inst.id);
  assert.equal(manifests.length, 1);
  const audit = readBrowserAudit(inst, id);
  assert.equal(audit.integrity.ok, true);
  assert.equal(audit.integrity.checked, 4); // http.jsonl + cdp.jsonl + 2 shots
  assert.equal(audit.http.length, 3); // 2 entries + _summary
  assert.equal(audit.cdp.length, 3); // 2 entries + _tap.summary
  assert.equal(audit.shots.length, 2);
  assert.ok(String((audit.shots[0] as any).dataUrl).startsWith('data:image/jpeg;base64,'), 'verified shot includes dataUrl');

  // Verify shot events use shotSeq (NEVER overwriting instance log seq) and instance reloads cleanly via openStore!
  const shotEvents = inst.log.filter(e => e.op === 'shot');
  assert.equal(shotEvents.length, 2);
  assert.deepEqual(shotEvents.map(e => e.shotSeq), [1, 2]);
  assert.deepEqual(inst.log.map(e => e.seq), inst.log.map((_, idx) => idx + 1), 'instance event log seq remains strictly monotonic 1..N');
  openStore(tmp);

  // Tamper with workspace copy of log AND shot -> integrity check MUST detect mismatch, NOT parse tampered bytes, and omit shot dataUrl!
  const logFile = join(inst.dir, manifests[0].file);
  chmodSync(logFile, 0o644);
  writeFileSync(logFile, '{"tampered":true}\n');
  const shotFile = join(inst.dir, manifests[0].shots[0].file);
  chmodSync(shotFile, 0o644);
  writeFileSync(shotFile, 'tampered-jpeg-bytes');
  const tampered = readBrowserAudit(inst, id);
  assert.equal(tampered.integrity.ok, false);
  assert.deepEqual(tampered.integrity.tampered, [manifests[0].file, manifests[0].shots[0].file]);
  assert.deepEqual(tampered.http, [], 'tampered log bytes are not parsed or served');
  assert.equal(tampered.shots[0].integrity, 'tampered');
  assert.equal((tampered.shots[0] as any).dataUrl, undefined, 'tampered shot never emits dataUrl');
  assert.ok(String((tampered.shots[1] as any).dataUrl).startsWith('data:image/jpeg;base64,'));
});

test('fail-closed spool & protocol checks: malformed /capabilities, corrupt shots.json & http.jsonl, malformed /seal, malformed DELETE ack, and http_end late error counting', async () => {
  // 0. Malformed 200 /capabilities throws 502 and is NOT cached as legacy downgrade
  resetCapabilitiesCache();
  capabilities404 = false;
  malformedCapabilities = true;
  await assert.rejects(() => probeCapabilities(), /malformed \/capabilities/);
  malformedCapabilities = false;
  assert.equal((await probeCapabilities()).auditV2, 2);

  // 1. Corrupt shots.json fails closed and retains journal + remote session
  const inst1 = makeInst('v2corrupt');
  const b1 = new Browsers(inst1, 1);
  const id1 = await b1.browser('erp');
  mkdirSync(join(rfDir(), 'browser-spool', id1), { recursive: true });
  writeFileSync(join(rfDir(), 'browser-spool', id1, 'shots.json'), '{not-valid-json');
  await assert.rejects(() => b1.close('erp'), /corrupt browser shot spool/);
  assert.equal(remoteSessions.has(id1), true, 'remote session preserved on corrupt spool');
  rmSync(join(rfDir(), 'browser-spool', id1, 'shots.json'), { force: true });
  // Also corrupt newline-terminated http.jsonl fails closed!
  writeFileSync(join(rfDir(), 'browser-spool', id1, 'http.jsonl'), '{corrupt-line\n');
  const rCorrupt = await reap();
  await rCorrupt.closed;
  assert.equal(remoteSessions.has(id1), true, 'remote session preserved on corrupt http.jsonl line');
  rmSync(join(rfDir(), 'browser-spool', id1, 'http.jsonl'), { force: true });
  const r1 = await reap();
  await r1.closed;
  assert.equal(remoteSessions.has(id1), false);

  // 2. Malformed /seal response rejects and retains journal + remote session
  const inst2 = makeInst('v2badseal');
  const b2 = new Browsers(inst2, 1);
  const id2 = await b2.browser('erp');
  malformedSeal = true;
  await assert.rejects(() => b2.close('erp'), /malformed \/seal response/);
  malformedSeal = false;
  assert.equal(remoteSessions.has(id2), true);

  // 3. Malformed DELETE ?sealed=1 ack rejects and retains phase='published' in journal, plus http_end error counted
  includeHttpEndError = true;
  malformedDeleteAck = true;
  const r2 = await reap();
  await r2.closed;
  malformedDeleteAck = false;
  includeHttpEndError = false;
  const jMid = JSON.parse(readFileSync(join(rfDir(), 'browsers.json'), 'utf8'));
  assert.equal(jMid[id2]?.phase, 'published', 'published phase retained until DELETE ack returns {deleted:true}');
  assert.equal(remoteSessions.has(id2), true);
  assert.equal(inst2.log.find(e => e.op === 'browser' && !e.action)?.errors, 1, 'late http_end error counted on browser entry');

  // Final reap finishes DELETE ?sealed=1 cleanly
  const r3 = await reap();
  await r3.closed;
  assert.equal(remoteSessions.has(id2), false);

  // 4. Symlinked inst.dir/browser MUST be rejected by contained writeBrowserArtifact (never writes outside inst.dir!)
  const { symlinkSync } = await import('node:fs');
  const instSym = makeInst('v2symlink');
  const outsideDir = mkdtempSync(join(tmpdir(), 'rf-outside-'));
  try {
    symlinkSync(outsideDir, join(instSym.dir, 'browser'));
    const bSym = new Browsers(instSym, 1);
    const idSym = await bSym.browser('erp');
    await assert.rejects(() => bSym.close('erp'), /not a regular directory/);
    assert.equal(existsSync(join(outsideDir, 'run 1 erp.jsonl')), false, 'zero bytes written through symlink outside inst.dir');
    assert.equal(remoteSessions.has(idSym), true, 'remote session preserved when artifact write fails');
    rmSync(join(instSym.dir, 'browser'), { force: true });
    const rSym = await reap();
    await rSym.closed;
    assert.equal(remoteSessions.has(idSym), false);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }

  // 5. Remote gone before seal: host-spooled entries beyond journal logCursor MUST be recovered (not rejected!)
  const instGone = makeInst('v2gone');
  const bGone = new Browsers(instGone, 1);
  const idGone = await bGone.browser('erp');
  const sessGone = remoteSessions.get(idGone)!;
  mkdirSync(join(rfDir(), 'browser-spool', idGone), { recursive: true });
  writeFileSync(join(rfDir(), 'browser-spool', idGone, 'http.jsonl'), sessGone.http.map(e => JSON.stringify(e) + '\n').join(''));
  // Simulate remote session vanishing before seal while journal still has logCursor: 0
  remoteSessions.delete(idGone);
  await bGone.close('erp');
  const goneAudit = readBrowserAudit(instGone, idGone);
  assert.equal(goneAudit.integrity.ok, true);
  assert.equal(goneAudit.manifest.gaps.remoteGone, true);
  assert.equal(goneAudit.manifest.finalCursors.log, 2);
  assert.equal(goneAudit.http.length, 2, 'host-spooled records recovered even when remote vanished before seal');

  // 6. Sealed then remote vanishes BEFORE drain: journal has positive sealCursors while local cursors are 0 -> MUST still publish recovered streams with explicit ackGap!
  const instSealedGone = makeInst('v2sealedgone');
  const bSG = new Browsers(instSealedGone, 1);
  const idSG = await bSG.browser('erp');
  const jSG = JSON.parse(readFileSync(join(rfDir(), 'browsers.json'), 'utf8'));
  jSG[idSG].phase = 'sealed';
  jSG[idSG].sealCursors = { log: 3, cdp: 3, shot: 2 };
  jSG[idSG].sealedAt = new Date().toISOString();
  chmodSync(join(rfDir(), 'browsers.json'), 0o644);
  writeFileSync(join(rfDir(), 'browsers.json'), JSON.stringify(jSG));
  mkdirSync(join(rfDir(), 'browser-spool', idSG), { recursive: true });
  writeFileSync(join(rfDir(), 'browser-spool', idSG, 'http.jsonl'), remoteSessions.get(idSG)!.http.map(e => JSON.stringify(e) + '\n').join(''));
  remoteSessions.delete(idSG);
  await bSG.close('erp');
  const sgAudit = readBrowserAudit(instSealedGone, idSG);
  assert.equal(sgAudit.integrity.ok, true);
  assert.equal(sgAudit.manifest.gaps.remoteGone, true);
  assert.equal(sgAudit.manifest.gaps.ackGap, 'remote_gone_before_drain');
  assert.equal(sgAudit.http.length, 2, 'recovers available HTTP spool even when CDP/shot streams were never drained before remote vanished');

  // 7. Deleted (`hole`) instance before first drain: closes cleanly without wedging journal or leaking remote session!
  const instHole = makeInst('v2hole');
  const bHole = new Browsers(instHole, 1);
  const idHole = await bHole.browser('erp');
  Object.defineProperty(instHole, 'hole', { value: true, configurable: true });
  await bHole.close('erp');
  assert.equal(remoteSessions.has(idHole), false, 'remote session reclaimed on deleted instance');
  const jHole = JSON.parse(readFileSync(join(rfDir(), 'browsers.json'), 'utf8'));
  assert.equal(jHole[idHole], undefined, 'journal entry cleared on deleted instance');
});

test('crash-safe keep() failure retains journal + spool and reap() resumes idempotently to completion', async () => {
  resetCapabilitiesCache();
  capabilities404 = false;
  const inst = makeInst('v2crash');
  const b = new Browsers(inst, 1);
  const id = await b.browser('erp');
  assert.ok(id);

  // Fault-inject throw right before keep() exports to inst.dir
  setTestBeforeKeepHook(openId => {
    if (openId === id) throw new Error('simulated disk full during keep');
  });
  await assert.rejects(() => b.close('erp'), /simulated disk full during keep/);
  setTestBeforeKeepHook(undefined);

  // Verify journal, host spool, AND remote sealed session are ALL retained!
  const j = JSON.parse(readFileSync(join(rfDir(), 'browsers.json'), 'utf8'));
  assert.equal(j[id]?.phase, 'sealed');
  assert.equal(existsSync(join(rfDir(), 'browser-spool', id, 'http.jsonl')), true);
  assert.equal(remoteSessions.has(id), true);

  // Now simulate server restart calling reap() -> resumes cleanly, publishes, and acks DELETE ?sealed=1!
  const reaped = await reap();
  await reaped.closed;

  const jAfter = JSON.parse(readFileSync(join(rfDir(), 'browsers.json'), 'utf8'));
  assert.equal(jAfter[id], undefined, 'journal cleared after reap');
  assert.equal(existsSync(join(rfDir(), 'browser-spool', id)), false, 'spool cleaned after reap');
  assert.equal(remoteSessions.has(id), false, 'remote session reclaimed after reap');
  assert.equal(inst.log.some(e => e.op === 'browser' && e.sessionId === id), true);
  assert.equal(readBrowserAudit(inst, id).integrity.ok, true);
});

test('graceful fallback to legacy v0.2.2 when /capabilities returns 404, and passUpgrade strips x-rf-* headers', async () => {
  resetCapabilitiesCache();
  capabilities404 = true;
  const caps = await probeCapabilities();
  assert.equal(caps.auditV2, 0);
  assert.equal(caps.seal, false);

  const inst = makeInst('legacy');
  const b = new Browsers(inst, 1);
  const id = await b.browser('erp');
  assert.ok(id);
  const opened = openBodies.at(-1);
  assert.equal(opened.audit, true, 'legacy still sends audit: true for screenshots');
  assert.equal(opened.auditV2, undefined, 'legacy omits auditV2');

  await b.close('erp');
  assert.ok(legacyDeleteCalls.includes(id), 'legacy falls back to DELETE /sessions/:id');

  // Verify passUpgrade strips all x-rf-* headers
  const { PassThrough } = await import('node:stream');
  const fakeSock = new PassThrough();
  const fakeReq = {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      cookie: 'rf_session=secret',
      'x-rf-internal': 'spoofed-nonce',
      'X-RF-Custom': 'spoofed',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  } as any;
  passUpgrade(fakeReq, fakeSock, Buffer.alloc(0), '/sessions/test/cdp');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(upgradeHeadersSeen['x-rf-internal'], undefined);
  assert.equal(upgradeHeadersSeen['x-rf-custom'], undefined);
  assert.equal(upgradeHeadersSeen.cookie, undefined);
  assert.ok(String(upgradeHeadersSeen.authorization).startsWith('Bearer '));
});
