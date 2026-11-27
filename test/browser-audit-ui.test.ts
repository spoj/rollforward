import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';

const web = new URL('../web/', import.meta.url);
const server = createServer((req, res) => {
  const path = req.url === '/' ? 'index.html' : req.url === '/css/theme.css' ? 'css/theme-default.css' : req.url!.slice(1);
  res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(readFileSync(new URL(path, web)));
});

let browser: Browser, origin: string;
before(async () => {
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await new Promise<void>(ok => server.close(() => ok()));
});

test('Browser Audit Timeline modal merges shots, HTTP writes, and CDP commands chronologically with All/Writes/Shots/CDP filters and warning pills', async () => {
  const page = await browser.newPage();
  const me = 'alice@demo.test';
  const instId = 'inst1';
  const sessionId = 'sess_v2_abc';
  const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const auditPayload = {
    manifest: {
      version: 1,
      sessionId,
      openId: sessionId,
      inst: instId,
      run: 1,
      site: 'erp',
      openIndex: 1,
      email: me,
      file: 'browser/run 1 erp.jsonl',
      cdpFile: 'browser/run 1 erp.cdp.jsonl',
      policySummary: { mode: 'observe', totalWrites: 1, allow: 0, deny: 0, escalate: 0, requireApproval: 1, flagged: [{ n: 2, op: 'formservice:W', ruleId: 'e1_ais_write', action: 'requireApproval' }] },
    },
    integrity: { ok: true, checked: 3, tampered: [], missing: [] },
    http: [
      {
        n: 1, t: '2026-11-27T10:00:01Z', method: 'GET', effectiveMethod: 'GET', isWrite: false, status: 200,
        url: 'https://erp.example.com/app/home', actions: [],
      },
      {
        n: 2, t: '2026-11-27T10:00:03Z', method: 'POST', effectiveMethod: 'DELETE', isWrite: true, status: 200,
        url: 'https://erp.example.com/jderest/v2/formservice',
        actions: [{ family: 'e1-ais', op: 'formservice:W', resource: 'P0411_W0411A', coverage: 'complete' }],
        bodyShape: { formName: 'string', formServiceAction: 'string' },
        dupKeys: true,
        policy: { decisionId: 'd1', mode: 'observe', action: 'requireApproval', ruleId: 'e1_ais_write', policyVersion: 'v1' },
      },
      {
        n: 3, rec: 'http_end', ref: 1, t: '2026-11-27T10:00:04.500Z', error: 'upstream_reset', incomplete: true,
      },
    ],
    cdp: [
      { n: 1, t: '2026-11-27T10:00:02Z', conn: 1, method: 'Runtime.callFunctionOn', severity: 'high', summary: { exprLen: 256 } },
      { n: 2, rec: '_tap.summary', t: '2026-11-27T10:00:05Z', methodCounts: { 'Runtime.callFunctionOn': 1 } },
    ],
    shots: [
      { seq: 1, at: '2026-11-27T10:00:04Z', url: 'https://erp.example.com/form', trigger: 'write', file: 'browser/run 1 erp s1.jpg', integrity: 'ok', dataUrl: `data:image/jpeg;base64,${tinyJpeg.toString('base64')}` },
      { seq: 2, at: '2026-11-27T10:00:04.200Z', url: 'https://erp.example.com/tampered', trigger: 'nav', file: 'browser/run 1 erp s2.jpg', integrity: 'tampered' },
    ],
  };

  await page.route('**/*', async r => {
    const u = new URL(r.request().url());
    if (u.origin !== origin) return r.abort();
    const p = u.pathname;
    if (p === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (p === '/me') return r.fulfill({ json: { email: me, name: 'Alice', role: 'admin', can: [], browsers: true, brand: {}, names: { [me]: 'Alice' } } });
    if (p === '/connections' || p === '/grants' || p === '/logins') return r.fulfill({ json: [] });
    if (p === '/logins/sites') return r.fulfill({ json: {} });
    if (p === '/api') {
      return r.fulfill({
        json: [{
          id: 'w1', name: 'Finance', manage: true, owners: [me], members: [], archived: false, mine: true,
          grants: [], reads: [], readers: [], moved: [], agents: '',
          series: [{
            id: 's1', name: 'AP Close', single: false, archived: false, owner: me, ownerName: 'Alice',
            requests: [], wakes: [], notes: 0, noteNotices: [],
            instances: [{ id: instId, label: '2026-11', status: 'open', active: false, asks: [], owner: me, acted: [], cost: 0, corrections: 0, wrong: [], refused: [] }],
          }],
        }],
      });
    }
    if (p === `/api/instances/${instId}`) {
      return r.fulfill({
        json: {
          doc: { rev: 1, status: 'open', items: [] },
          log: [
            { seq: 1, at: '2026-11-27T09:59:00Z', by: me, op: 'create' },
            { seq: 2, at: '2026-11-27T10:00:05Z', by: 'server', op: 'browser', run: 1, site: 'erp', login: me, sessionId, requests: 2, writes: 1, blocked: 0, cdp: 1, shots: 1, file: 'browser/run 1 erp.jsonl', cdpFile: 'browser/run 1 erp.cdp.jsonl' },
          ],
          standing: {},
          starts: true,
          run: null,
          queued: false,
          owner: { by: me, name: 'Alice', logins: [], ticked: [], epoch: 1, autonomous: false },
          previous: null,
          sums: {},
          waiting: [],
          staleProposals: [],
          noteStates: {},
          noteNotices: [],
          held: [],
        },
      });
    }
    if (p === `/api/instances/${instId}/trace`) {
      return r.fulfill({ json: [] });
    }
    if (p === `/api/instances/${instId}/browser-audit`) {
      return r.fulfill({ json: auditPayload });
    }
    if (p.startsWith(`/files/${instId}/`)) {
      return r.fulfill({ contentType: 'image/jpeg', body: tinyJpeg });
    }
    return r.continue();
  });

  await page.goto(`${origin}/#/${instId}`);
  const auditBtn = page.locator('#log [data-act="audit"]');
  await auditBtn.waitFor({ state: 'visible' });
  await auditBtn.click();
  const btn = page.locator('button[data-act="browser-audit"]');
  await btn.waitFor({ state: 'visible' });
  await btn.click();

  const dialog = page.locator('#pv');
  await dialog.waitFor({ state: 'visible' });
  await page.locator('.ba-integ.ok').waitFor({ state: 'visible' });
  assert.match(await page.locator('.ba-integ.ok').textContent() ?? '', /Host manifest verified \(3 files\)/);

  // Chronological order: 10:00:01 HTTP GET (merged http_end error) -> 10:00:02 CDP -> 10:00:03 HTTP POST->DELETE -> 10:00:04 Shot 1 -> 10:00:04.2 Shot 2
  const kinds = await page.locator('#ba-list .ba-card').evaluateAll(els => els.map(e => e.getAttribute('data-kind')));
  assert.deepEqual(kinds, ['http', 'cdp', 'http', 'shot', 'shot']);

  // Verified shot uses data: URL (never /files/...) and tampered shot renders ZERO <img> with withheld warning
  const imgSrcs = await page.locator('#ba-list .ba-shot img').evaluateAll(els => els.map(e => e.getAttribute('src')));
  assert.equal(imgSrcs.length, 1);
  assert.ok(imgSrcs[0]?.startsWith('data:image/jpeg;base64,'), 'verified shot uses verified dataUrl');

  // Verify override badge, dupKeys red pill, policy badge, high-severity CDP pill, merged http_end error, and withheld tampered shot
  const listText = await page.locator('#ba-list').textContent() ?? '';
  assert.match(listText, /POST → DELETE/);
  assert.match(listText, /formservice:W/);
  assert.match(listText, /dupKeys/);
  assert.match(listText, /e1_ais_write/);
  assert.match(listText, /high severity/);
  assert.match(listText, /error:upstream_reset/);
  assert.match(listText, /incomplete/);
  assert.match(listText, /Shot tampered — image withheld/);

  // Filter chips: Writes | Blocked / Errors | Key | Shots | CDP | All
  await page.locator('[data-act="ba-filter"][data-filter="writes"]').click();
  assert.equal(await page.locator('#ba-list .ba-card').count(), 1);
  assert.equal(await page.locator('#ba-list .ba-card').first().getAttribute('data-write'), '1');

  await page.locator('[data-act="ba-filter"][data-filter="blocked"]').click();
  assert.equal(await page.locator('#ba-list .ba-card').count(), 1, 'late http_end error matches Blocked / Errors');

  await page.locator('[data-act="ba-filter"][data-filter="key"]').click();
  assert.equal(await page.locator('#ba-list .ba-card').count(), 5, 'Key shows error GET, high-sev CDP, write, and shots');

  await page.locator('[data-act="ba-filter"][data-filter="shots"]').click();
  assert.equal(await page.locator('#ba-list .ba-card').count(), 2);
  assert.equal(await page.locator('#ba-list .ba-card').first().getAttribute('data-kind'), 'shot');

  await page.locator('[data-act="ba-filter"][data-filter="cdp"]').click();
  assert.equal(await page.locator('#ba-list .ba-card').count(), 1);
  assert.equal(await page.locator('#ba-list .ba-card').first().getAttribute('data-kind'), 'cdp');

  await page.locator('[data-act="ba-filter"][data-filter="all"]').click();
  assert.equal(await page.locator('#ba-list .ba-card').count(), 5);

  // Text filter narrows results live
  await page.locator('#ba-q').fill('P0411_W0411A');
  assert.equal(await page.locator('#ba-list .ba-card').count(), 1);

  await page.close();
});
