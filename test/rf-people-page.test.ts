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

const person = 'bob@demo.test';

test('R4-PEOPLE-02: terminal instance states redraw read-only conversation despite drafts and evict deleted conversation DOM and sessionStorage', async () => {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  const state: Record<string, any> = {
    i1: {
      summary: { id: 'i1', label: 'Jan', status: 'open', running: false, owner: person, asks: [{ who: person, seq: 2 }], wakes: [], refused: [], unread: false, active: '2026-11-15T10:01:00Z' },
      detail: {
        doc: { rev: 1, status: 'open', items: [] },
        log: [
          { seq: 1, at: '2026-11-15T10:00:00Z', by: person, op: 'create', logins: [] },
          { seq: 2, at: '2026-11-15T10:01:00Z', by: 'agent', op: 'comment', thread: 'c2', ask: 'proposal', text: 'Send pack now?' },
        ],
        standing: { 2: 'runner' },
        waiting: [{ seq: 2, who: person }],
        owner: { by: person, logins: [], ticked: [], epoch: 1, workspace: 'w1', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false } },
        starts: true, run: null, queued: null, held: [], sums: {},
      },
    },
    i2: {
      summary: { id: 'i2', label: 'Feb', status: 'open', running: false, owner: person, asks: [], wakes: [], refused: [], unread: false, active: '2026-11-15T10:02:00Z' },
      detail: {
        doc: { rev: 1, status: 'open', items: [] },
        log: [
          { seq: 1, at: '2026-11-15T10:00:00Z', by: person, op: 'create', logins: [] },
          { seq: 2, at: '2026-11-15T10:02:00Z', by: 'agent', op: 'comment', thread: 'c2', ask: 'question', text: 'Check Feb?' },
        ],
        standing: { 2: 'runner' },
        waiting: [{ seq: 2, who: person }],
        owner: { by: person, logins: [], ticked: [], epoch: 1, workspace: 'w1', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false } },
        starts: true, run: null, queued: null, held: [], sums: {},
      },
    },
    i3: {
      summary: { id: 'i3', label: 'Mar', status: 'open', running: false, owner: person, asks: [], wakes: [], refused: [], unread: false, active: '2026-11-15T10:03:00Z' },
      detail: {
        doc: { rev: 1, status: 'open', items: [] },
        log: [
          { seq: 1, at: '2026-11-15T10:00:00Z', by: person, op: 'create', logins: [] },
          { seq: 2, at: '2026-11-15T10:03:00Z', by: person, op: 'comment', thread: 'c2', text: 'SECRET_DELETED_CONVERSATION' },
        ],
        standing: { 2: 'runner' },
        waiting: [],
        owner: { by: person, logins: [], ticked: [], epoch: 1, workspace: 'w1', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false } },
        starts: true, run: null, queued: null, held: [], sums: {},
      },
    },
  };

  await page.route('**/*', async r => {
    const url = new URL(r.request().url()), path = url.pathname;
    if (url.origin !== origin) return r.abort();
    if (path === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/me') return r.fulfill({ json: { email: person, name: 'Bob', role: 'user', can: ['series-owner'], browsers: false, brand: {}, names: { [person]: 'Bob' } } });
    if (path === '/logins') return r.fulfill({ json: [] });
    if (path === '/api') return r.fulfill({ json: [{
      id: 'w1', name: 'Finance', manage: true, owners: [person], members: [], archived: false, mine: true,
      grants: [], reads: [], readers: [], moved: [], agents: '',
      series: [{ id: 's1', name: 'Monthly', owner: person, epoch: 1, since: '2026-11-15T10:00:00Z', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false }, single: false, archived: false, requests: [], wakes: [], fired: null, notes: 0, instances: [state.i1.summary, state.i2.summary, state.i3.summary] }],
    }] });
    const m = path.match(/^\/api\/instances\/(i\d)(\/summary)?$/);
    if (m) return r.fulfill({ json: m[2] ? state[m[1]].summary : state[m[1]].detail });
    return r.continue();
  });

  try {
    await page.goto(`${origin}/#/i1`);
    await page.waitForSelector('#conv #newcomment');
    await page.fill('#conv #newcomment', 'Unfinished comment on i1');

    // Control: while still open, incoming comment keeps live draft frozen.
    state.i1.detail.log.push({ seq: 3, at: '2026-11-15T10:04:00Z', by: 'agent', op: 'comment', thread: 'c2', parent: 2, text: 'Agent follow-up' });
    await page.evaluate(() => (window as any).patch(['i1']));
    assert.equal(await page.inputValue('#conv #newcomment'), 'Unfinished comment on i1');
    assert.doesNotMatch(await page.textContent('#conv') ?? '', /Agent follow-up/);

    // Transition i1 -> closed: conversation redraws read-only (no open compose/proposal buttons; shows Add a correction).
    state.i1.summary.status = 'closed';
    state.i1.summary.asks = [];
    state.i1.detail.doc.status = 'closed';
    state.i1.detail.waiting = [];
    state.i1.detail.log.push({ seq: 4, at: '2026-11-15T10:05:00Z', by: person, op: 'close' });
    await page.evaluate(() => (window as any).patch(['i1']));
    assert.equal(await page.locator('#conv #newcomment, #conv [data-act=comment], #conv [data-act=reply]').count(), 0);
    assert.equal(await page.locator('#conv [data-act=correct]').count(), 1);
    assert.match(await page.textContent('#conv') ?? '', /Agent follow-up/);

    // Navigate to i2, open a reply draft, then navigate back to closed i1 -> still read-only.
    await page.goto(`${origin}/#/i2`);
    await page.waitForSelector('#conv .post[data-seq="2"] [data-act=reply]');
    await page.click('#conv .post[data-seq="2"] [data-act=reply]');
    await page.fill('#conv .post[data-seq="2"] .reply textarea', 'Unfinished reply on i2');
    await page.goto(`${origin}/#/i1`);
    await page.waitForSelector('#conv [data-act=correct]');
    assert.equal(await page.locator('#conv #newcomment, #conv [data-act=reply]').count(), 0);

    // Navigate back to i2 and transition i2 -> abandoned: redraws read-only without open controls or correction button.
    await page.goto(`${origin}/#/i2`);
    await page.waitForSelector('#conv .post[data-seq="2"] .reply textarea');
    state.i2.summary.status = 'abandoned';
    state.i2.detail.doc.status = 'abandoned';
    state.i2.detail.waiting = [];
    state.i2.detail.log.push({ seq: 3, at: '2026-11-15T10:06:00Z', by: person, op: 'abandon' });
    await page.evaluate(() => (window as any).patch(['i2']));
    assert.equal(await page.locator('#conv #newcomment, #conv .reply, #conv [data-act=reply], #conv [data-act=correct]').count(), 0);

    // Open i3, create draft and persist to sessionStorage, then transition i3 -> deleted.
    await page.goto(`${origin}/#/i3`);
    await page.waitForSelector('#conv #newcomment');
    assert.match(await page.textContent('#conv') ?? '', /SECRET_DELETED_CONVERSATION/);
    await page.fill('#conv #newcomment', 'Draft before deletion');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.ok(await page.evaluate(() => sessionStorage.getItem('drafts:bob@demo.test:/api/instances/i3')));

    state.i3.summary.status = 'deleted';
    state.i3.summary.deleted = { by: person, at: '2026-11-15T10:07:00Z' };
    state.i3.detail = {
      doc: { rev: 1, status: 'deleted', items: [] },
      log: [{ seq: 1, at: '2026-11-15T10:07:00Z', by: person, op: 'delete' }],
      standing: {}, waiting: [], owner: { by: person, logins: [], ticked: [], epoch: 1, workspace: 'w1', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false } },
      starts: false, run: null, queued: null, held: [], sums: {},
    };
    await page.evaluate(() => (window as any).patch(['i3']));
    assert.doesNotMatch(await page.textContent('#conv') ?? '', /SECRET_DELETED_CONVERSATION/);
    assert.equal(await page.locator('#conv #newcomment, #conv [data-act=comment]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('drafts:bob@demo.test:/api/instances/i3')), null);

    // Navigate away and back to deleted i3, and reload with synthetic sessionStorage draft -> stays empty tombstone.
    await page.goto(`${origin}/#/i1`);
    await page.waitForSelector('#conv [data-act=correct]');
    await page.goto(`${origin}/#/i3`);
    await page.waitForSelector('#ins .empty');
    assert.doesNotMatch(await page.textContent('#conv') ?? '', /SECRET_DELETED_CONVERSATION/);

    await page.evaluate(() => sessionStorage.setItem('drafts:bob@demo.test:/api/instances/i3', JSON.stringify({ boxes: { newcomment: 'Stale draft' } })));
    await page.reload();
    await page.waitForSelector('#ins .empty');
    assert.equal(await page.locator('#conv #newcomment').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('drafts:bob@demo.test:/api/instances/i3')), null);
  } finally {
    await page.close();
  }
});

test('R4-PEOPLE-04: Start series and close validates name first and promotes only after close succeeds', async () => {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const calls: { method: string; path: string; body: unknown }[] = [];
  let promoted = false, closed = false, failClose = true;

  await page.route('**/*', async r => {
    const url = new URL(r.request().url()), path = url.pathname, method = r.request().method();
    if (url.origin !== origin) return r.abort();
    if (method !== 'GET') calls.push({ method, path, body: r.request().postData() && r.request().postDataJSON() });
    if (path === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/me') return r.fulfill({ json: { email: person, name: 'Bob', role: 'user', can: ['series-owner'], browsers: false, brand: {}, names: { [person]: 'Bob' } } });
    if (path === '/logins') return r.fulfill({ json: [] });
    if (path === '/api') return r.fulfill({ json: [{
      id: 'w1', name: 'Finance', manage: true, owners: [person], members: [], archived: false, mine: true,
      grants: [], reads: [], readers: [], moved: [], agents: '',
      series: [
        { id: 'sExisting', name: 'ExistingSeries', single: false, archived: false, requests: [], wakes: [], fired: null, notes: 0, instances: [] },
        { id: 't1', name: promoted ? 'Monthly rec' : 'Oct rec', owner: person, epoch: 1, since: '2026-11-15T10:00:00Z', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false }, single: !promoted, archived: false, requests: [], wakes: [], fired: null, notes: 0,
          instances: [{ id: 'ti1', label: 'Oct rec', status: closed ? 'closed' : 'open', running: false, owner: person, asks: [], wakes: [], refused: [], unread: false, active: '2026-11-15T10:00:00Z' }] },
      ],
    }] });
    if (path === '/api/instances/ti1') return r.fulfill({ json: {
      doc: { rev: 1, status: closed ? 'closed' : 'open', items: [] },
      log: [{ seq: 1, at: '2026-11-15T10:00:00Z', by: person, op: 'create', logins: [] }],
      standing: {}, waiting: [], owner: { by: person, logins: [], ticked: [], epoch: 1, workspace: 'w1', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [], autonomous: false } },
      starts: true, run: null, queued: null, held: [], sums: {},
    } });
    if (path === '/api/series/t1/promote' && method === 'POST') {
      if (promoted) return r.fulfill({ status: 400, body: 'Monthly rec is a series already' });
      promoted = true;
      return r.fulfill({ status: 200, body: 'ok' });
    }
    if (path === '/api/instances/ti1/close' && method === 'POST') {
      if (failClose) return r.fulfill({ status: 409, body: 'u2: no file upload/output.csv' });
      closed = true;
      return r.fulfill({ status: 200, body: 'ok' });
    }
    return r.continue();
  });

  try {
    await page.goto(`${origin}/#/ti1`);
    await page.waitForSelector('#bar [data-act=close]');
    await page.click('#bar [data-act=close]');
    await page.waitForSelector('#ask[open] #aseries');

    // Refused close leaves the task unpromoted so retrying after fixing succeeds cleanly.
    await page.fill('#aseries', 'Monthly rec');
    await page.click('#ask button[value=series]');
    await page.waitForSelector('#ask button[value=series]:not([aria-busy])');
    assert.equal(await page.textContent('#ask .err'), 'u2: no file upload/output.csv');
    assert.equal(promoted, false);
    assert.deepEqual(calls.map(c => c.path), ['/api/instances/ti1/close']);

    // Invalid names and existing series names are rejected before any mutation.
    calls.length = 0;
    await page.fill('#aseries', '.hidden');
    await page.click('#ask button[value=series]');
    await page.waitForSelector('#ask button[value=series]:not([aria-busy])');
    assert.match(await page.textContent('#ask .err') ?? '', /can't start with a dot/);
    assert.equal(calls.length, 0);

    await page.fill('#aseries', 'ExistingSeries');
    await page.click('#ask button[value=series]');
    await page.waitForSelector('#ask button[value=series]:not([aria-busy])');
    assert.equal(await page.textContent('#ask .err'), 'ExistingSeries exists');
    assert.equal(calls.length, 0);

    await page.fill('#aseries', 'Monthly rec');
    failClose = false;
    await page.click('#ask button[value=series]');
    await page.waitForSelector('#ask:not([open])', { state: 'attached' });
    assert.equal(closed, true);
    assert.equal(promoted, true);
    assert.deepEqual(calls, [
      { method: 'POST', path: '/api/instances/ti1/close', body: null },
      { method: 'POST', path: '/api/series/t1/promote', body: { name: 'Monthly rec' } },
    ]);
  } finally {
    await page.close();
  }
});

