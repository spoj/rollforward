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
const grant = {
  id: 'g1', workspace: 'w1', workspaceName: 'Finance', person, personName: 'Bob', site: 'portal', url: 'https://portal.test/start',
  state: 'pending', reason: 'Fetch the weekly ledger', profile: { what: 'The company ledger.', category: 'company', risk: 'low', flags: [] },
  description: "Runs in Finance can use Bob's login to portal and do whatever Bob can there, including submitting and approving. The reason is not an enforced limit.",
  flags: [], adminOnly: false, adminWhy: '', use: null,
};

async function open(role: string, grants: object[] = []) {
  const page = await browser.newPage(), requests: { path: string; method: string; body: unknown }[] = [];
  const workspace = { id: 'w1', name: 'Finance', manage: true, owners: [person], members: [], archived: false, mine: true,
    series: [] as object[], grants, reads: [], readers: [], moved: [], agents: '' };
  const responses: Record<string, unknown> = {
    '/me': { email: person, name: 'Bob', role, can: ['keepalive'], browsers: true, brand: {}, names: { [person]: 'Bob' } },
    '/api': [workspace], '/connections': [], '/grants': grants,
    '/logins': [{ id: 'web:portal', kind: 'website', name: 'portal', since: '2026-11-01T00:00:00Z', expired: false, offers: [], missing: [] }],
    '/logins/sites': { portal: { url: 'https://portal.test/start', hosts: ['cdn.portal.test'], checks: { 'cdn.portal.test': { verdict: 'pass', why: 'Its CDN.' } } } },
  };
  await page.route('**/*', async r => {
    const url = new URL(r.request().url()), path = url.pathname;
    if (url.origin !== origin) return r.abort();
    requests.push({ path: path + url.search, method: r.request().method(), body: r.request().postData() && r.request().postDataJSON() });
    if (path === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path.startsWith('/signins/')) return r.fulfill({ contentType: 'text/html', body: 'sign-in browser' });
    if (path === '/logins/web/portal' && r.request().method() === 'POST') return r.fulfill({ json: { id: 's1', expires: new Date(Date.now() + 600_000).toISOString() } });
    if (path.startsWith('/logins/web/portal/hosts')) return r.fulfill({ body: 'ok' });
    if (path in responses) return r.fulfill({ json: responses[path] });
    return r.continue();
  });
  await page.goto(origin + '/#/w1');
  await page.waitForSelector('#sidefoot [data-act=logins]');
  return { page, requests, workspace };
}

test('a sign-in counts down from the server expiry, never asks to allow hosts, and expires without saving', async () => {
  const { page, requests } = await open('user');
  try {
    const now = Date.now();
    await page.clock.install({ time: new Date(now) });
    await page.route('**/logins/web/portal', r => r.fulfill({ json: { id: 's1', expires: new Date(now + 600_000).toISOString() } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    assert.equal(await page.locator('[data-act=host-remove]').count(), 1);
    assert.equal(await page.locator('[data-act=allow-host]').count(), 0);
    await page.click('[data-act=web-signin]');
    assert.equal(await page.textContent('#signin-clock'), '10:00');
    await page.check('#keep');
    await page.clock.fastForward(1000);
    assert.equal(await page.textContent('#signin-clock'), '9:59');
    assert.equal(await page.isChecked('#keep'), true, 'a tick of the clock does not rebuild the browser or its form');
    assert.equal(await page.locator('#pv iframe').count(), 1);
    assert.equal(await page.locator('#refused, [data-act=allow-host]').count(), 0);
    await page.clock.fastForward(599_000);
    await page.waitForSelector('#pv [role=status]');
    assert.equal(await page.textContent('#pv [role=status]'), 'Sign-in expired. Close this and sign in again.');
    assert.equal(await page.locator('#pv iframe, #keep').count(), 0);
    assert.equal(await page.isDisabled('[data-act=signin-save]'), true);
    assert.equal(requests.some(r => r.path.includes('/refused')), false);
    assert.equal(requests.some(r => r.path === '/signins/s1' && r.method === 'POST'), false);
    await page.click('#pv [data-act=unpv]');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
  } finally {
    await page.close();
  }
});

test('saving a live sign-in preserves the keepalive choice', async () => {
  const { page, requests } = await open('user');
  try {
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('[data-act=web-signin]');
    await page.check('#keep');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('#pv .lline');
    const saved = requests.find(r => r.path === '/signins/s1' && r.method === 'POST')!.body as { keepalive: string };
    assert.ok(Math.abs(Date.parse(saved.keepalive) - Date.now() - 7 * 86_400_000) < 120_000);
  } finally {
    await page.close();
  }
});

test('grant cards disclose scope, profile, flags, admin decisions, usage and legacy checks in each settings view', async () => {
  const grants = [grant,
    { ...grant, id: 'general', profile: { ...grant.profile, category: 'general' }, adminOnly: true, adminWhy: 'This is a general-purpose website: an admin decides', flags: ['Files may be shared outside the company'] },
    { ...grant, id: 'high', profile: { ...grant.profile, risk: 'high' }, adminOnly: true, adminWhy: 'The website is high risk: an admin decides', flags: ['Can approve payments'] },
    { ...grant, id: 'approved', state: 'approved', by: person, decided: '2026-11-02T10:00:00Z', use: { runs: 7, wrote: 2, last: '2026-11-03T10:00:00Z' } },
    { id: 'legacy', workspace: 'w1', person, site: 'portal', url: 'https://portal.test/start', state: 'pending', reason: 'An older request',
      check: { summary: 'An earlier ledger check.', risk: 'medium', flags: ['Earlier concern'], hosts: ['sso.portal.test'] } },
  ];
  const { page } = await open('user', grants);
  try {
    await page.click('[data-act=waiting]');
    const card = page.locator('[data-grant=g1]');
    assert.match(await card.innerText(), /Bob asks for runs in Finance to use their portal login to portal\.test/);
    assert.match(await card.innerText(), /Company system/);
    assert.doesNotMatch(await card.innerText(), /low risk/);
    assert.match(await card.innerText(), /The company ledger\./);
    assert.match(await card.innerText(), /including submitting and approving/);
    assert.match(await card.innerText(), /Reason: Fetch the weekly ledger/);
    assert.equal(await card.locator('[data-act=grant-approve], [data-act=grant-deny]').count(), 2);
    for (const id of ['general', 'high']) {
      const gated = page.locator(`[data-grant=${id}]`);
      assert.equal(await gated.locator('[data-act=grant-approve]').count(), 0);
      assert.equal(await gated.locator('[data-act=grant-deny]').count(), 1);
      assert.match(await gated.innerText(), /Only an admin can approve/);
      assert.match(await gated.innerText(), /Flags:/);
      assert.match(await gated.innerText(), id === 'general' ? /general-purpose website/ : /website is high risk/);
    }
    assert.match(await page.locator('[data-grant=legacy]').innerText(), /medium risk[\s\S]*An earlier ledger check\.[\s\S]*Earlier concern[\s\S]*sso\.portal\.test/);
    assert.equal(await page.locator('[data-grant=approved]').count(), 0);
    await page.click('#pv [data-act=unpv]');
    await page.click('.row.ws [data-act=workspace-settings]');
    const used = page.locator('[data-grant=approved]');
    assert.match(await used.innerText(), /Opened in 7 runs · 2 runs wrote · last used/);
    assert.equal(await used.locator('[data-act=grant-revoke]').count(), 1);
    assert.doesNotMatch(await page.locator('[data-grant=legacy]').innerText(), /undefined|NaN|Opened in/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#pv .pvb').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.click('#pv [data-act=unpv]');
    await page.click('#bar [data-act=menu]');
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    assert.match(await page.locator('[data-grant=approved]').innerText(), /Opened in 7 runs · 2 runs wrote · last used/);
    assert.equal(await page.locator('[data-act=allow-host]').count(), 0);
  } finally {
    await page.close();
  }
});

test('only admins see the server-filtered high and internal host decisions in Waiting', async () => {
  for (const role of ['user', 'admin']) {
    const { page, requests } = await open(role, [{ ...grant, adminOnly: true, adminWhy: 'A general-purpose website', profile: { ...grant.profile, category: 'general' } }]);
    try {
      await page.evaluate(() => {
        tree[0].series = [{ id: 's1', name: 'Ledger', single: false, archived: false, requests: [], instances: [{ id: 'i1', label: 'November', asks: [], refused: [
          { run: 1, login: 'bob@demo.test', site: 'portal', hosts: ['files.other.test', 'internal.test'], why: { 'files.other.test': 'High risk: can share files.', 'internal.test': 'An internal address.' } },
        ] }] }];
      });
      await page.click('[data-act=waiting]');
      assert.equal(await page.locator('[data-act=allow-host]').count(), role === 'admin' ? 2 : 0);
      assert.equal(await page.locator('[data-act=grant-approve]').count(), role === 'admin' ? 1 : 0);
      if (role === 'admin') {
        assert.match(await page.textContent('#pv') ?? '', /High risk: can share files\.[\s\S]*An internal address\./);
        await page.click('[data-act=allow-host][data-host="files.other.test"]');
        await page.waitForSelector('[data-act=allow-host]', { state: 'detached' });
        assert.deepEqual(requests.find(r => r.path.startsWith('/logins/web/portal/hosts?')), {
          path: '/logins/web/portal/hosts?person=bob%40demo.test', method: 'POST', body: { host: 'files.other.test' },
        });
      } else assert.doesNotMatch(await page.textContent('#pv') ?? '', /was refused|files\.other\.test|internal\.test/);
    } finally {
      await page.close();
    }
  }
});
