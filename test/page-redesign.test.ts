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
    '/me': { email: person, name: 'Bob', role, can: ['keepalive', 'series-owner'], browsers: true, brand: {}, names: { [person]: 'Bob' } },
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
  return { page, requests, workspace, responses };
}

async function openWebsiteTicks() {
  const rows = ['pending', 'denied', 'revoked', 'lapsed', 'approved', 'expired'].map(site => ({ ...grant, id: site, site,
    state: site === 'expired' ? 'approved' : site, at: new Date().toISOString(), profile: { error: 'Check unavailable' } }));
  rows.push({ ...rows[0], id: 'someone-else', site: 'missing', state: 'approved', person: 'alice@demo.test' });
  const state = await open('user', rows), { page, workspace, responses } = state;
  const sites = ['missing', 'pending', 'denied', 'revoked', 'lapsed', 'approved', 'expired'];
  const logins = sites.map(site => ({ id: `web:${site}`, name: site, kind: 'website', since: new Date().toISOString(), expired: site === 'expired', missing: [], offers: [{ id: `web:${site}`, name: site }] }));
  logins.push({ id: 'm365', name: 'Microsoft 365', kind: 'm365', since: '', expired: false, missing: [], offers: [{ id: 'm365:mail', name: 'Mail' }, { id: 'm365:files', name: 'Files' }] },
    { id: 'drop', name: 'Service', kind: 'service', since: '', expired: false, missing: [], offers: [{ id: 'drop:AP/', name: 'AP/' }] });
  responses['/logins'] = logins;
  responses['/logins/sites'] = Object.fromEntries(sites.map(site => [site, { url: `https://${site}.test/`, hosts: [], profile: { error: 'Check unavailable' } }]));
  const series = { id: 's1', name: 'Ledger', instances: [], wakes: [], requests: [], owner: person, epoch: 1, since: '2026-11-15T10:00:00Z', consent: { by: person, at: '2026-11-15T10:00:00Z', workspace: 'w1', logins: [] as string[], autonomous: false }, archived: false };
  workspace.series.push(series);
  responses['/api'] = [{ ...workspace, id: 'w2', name: 'Other workspace', series: [], grants: [{ ...grant, site: 'missing', workspace: 'w2', state: 'approved' }] }, workspace];
  responses['/api/series/s1'] = {};
  responses['/api/series/s1/credentials'] = 'ok';
  responses['/api/series'] = { instance: 's1' };
  await page.evaluate(async () => { await refresh(); location.hash = '#/s1'; });
  await page.waitForFunction(() => cur.s?.id === 's1');
  return { ...state, series, sites };
}

test('saving a website sign-in keeps its expanded setup row', async () => {
  const { page } = await open('user');
  try {
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('#pv .lline');
    assert.equal(await page.locator('details[data-shown="web:portal"]').count(), 1);
    assert.equal(await page.locator('details[data-shown="web:portal"]').getAttribute('open'), '');
    assert.equal(await page.locator('details[data-shown="web:portal"] [data-act=web-signin]').isVisible(), true);
  } finally { await page.close(); }
});

test('collapsed website rows warn about legacy grant concerns despite a low-risk current profile', async () => {
  const warning = 'Can approve payments', { page } = await open('user', [{ ...grant, flags: [warning], adminOnly: true,
    adminWhy: 'The old check rates portal high risk: an admin decides', check: { risk: 'high', flags: [warning], summary: 'An earlier check.', hosts: [] } }]);
  try {
    await page.route('**/logins/sites', r => r.fulfill({ json: { portal: { url: grant.url, hosts: [], profile: grant.profile } } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    const row = page.locator('details[data-shown="web:portal"]');
    assert.match(await row.locator('summary').innerText(), /warning/);
    await row.locator('summary').click();
    assert.match(await row.innerText(), /Can approve payments/);
    assert.match(await row.innerText(), /Only an admin can approve/);
  } finally { await page.close(); }
});

test('one website check error is shared by its workspace grants without hiding other warnings', async () => {
  const error = 'The website classifier timed out', why = `the website profile could not be checked: ${error}`;
  const { page } = await open('user', [{ ...grant, id: 'approved-error', state: 'approved', profile: { error }, flags: [why], adminOnly: true },
    { ...grant, id: 'pending-error', profile: { error }, flags: [why, 'Can approve payments'], adminOnly: true, adminWhy: `${why}: an admin decides` }]);
  try {
    await page.route('**/logins/sites', r => r.fulfill({ json: { portal: { url: grant.url, hosts: [], profile: { error } } } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    const row = page.locator('details[data-shown="web:portal"]');
    await row.locator('summary').click();
    assert.equal((await row.innerText()).split(error).length - 1, 1);
    assert.match(await row.innerText(), /Can approve payments/);
    assert.match(await row.innerText(), /Only an admin can approve/);
  } finally { await page.close(); }
});

test('a sign-in counts down from the server expiry, never asks to allow hosts, and expires without saving', async () => {
  const { page, requests } = await open('user');
  try {
    const now = Date.now();
    await page.clock.install({ time: new Date(now) });
    await page.route('**/logins/web/portal', r => r.fulfill({ json: { id: 's1', expires: new Date(now + 600_000).toISOString() } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
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
    await page.click('details[data-shown="web:portal"] > summary');
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

for (const attempt of ['Cancel', 'Escape', 'backdrop', 'navigation', 'duplicate Save', 'overlapping Logins', 'overlapping Tokens']) test(`a slow website Save blocks ${attempt} until the saved login is shown`, async () => {
  const { page } = await open('user'), gate = Promise.withResolvers<void>(), seen = Promise.withResolvers<void>();
  let saves = 0, cancels = 0, saved = false;
  page.setDefaultTimeout(3000);
  try {
    const now = Date.now();
    await page.clock.install({ time: new Date(now) });
    await page.route('**/logins', r => r.fulfill({ json: saved ? [{ id: 'web:portal', kind: 'website', name: 'portal', since: new Date(now).toISOString(), offers: [], missing: [] }] : [] }));
    await page.route('**/signins/s1', async r => {
      if (r.request().method() === 'DELETE') {
        cancels++;
        return r.fulfill({ status: 404, body: 'no such sign-in' });
      }
      saves++;
      seen.resolve();
      await gate.promise;
      saved = true;
      await r.fulfill({ json: {} });
    });
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    const oldLogins = Promise.withResolvers<void>(), oldSeen = Promise.withResolvers<void>();
    if (attempt.startsWith('overlapping')) {
      await page.route(attempt === 'overlapping Logins' ? '**/connections' : '**/tokens', async r => {
        oldSeen.resolve();
        await oldLogins.promise;
        await r.fulfill({ json: [] });
      }, { times: 1 });
      await page.evaluate(attempt => { window.oldLogins = attempt === 'overlapping Logins' ? openLogins() : openTokens(); }, attempt);
      await oldSeen.promise;
    }
    await page.click('[data-act=signin-save]');
    await seen.promise;
    if (attempt.startsWith('overlapping')) {
      oldLogins.resolve();
      await page.evaluate(() => window.oldLogins);
    }
    if (attempt === 'Cancel') await page.locator('[data-act=unpv]').dispatchEvent('click');
    if (attempt === 'Escape') await page.keyboard.press('Escape');
    if (attempt === 'backdrop') await page.mouse.click(5, 5);
    if (attempt === 'navigation') {
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForFunction(() => location.hash === '#/');
    }
    if (attempt === 'duplicate Save') {
      await page.evaluate(() => renderPv());
      await page.locator('[data-act=signin-save]').dispatchEvent('click');
    }
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(cancels, 0, 'Save has consumed the sign-in; closing must not DELETE it');
    assert.equal(saves, 1, 'a redraw must not allow a duplicate POST');
    assert.equal(await page.locator('#pv[open]').count(), 1);
    assert.equal(await page.isDisabled('[data-act=signin-save]'), true);
    assert.equal(await page.isDisabled('[data-act=unpv]'), true);
    assert.equal(await page.textContent('[data-act=signin-save]'), 'Saving…');
    assert.equal(await page.textContent('#pv [role=status]'), 'Saving login…');
    await page.clock.fastForward(601_000);
    await page.evaluate(() => renderPv());
    assert.equal(await page.textContent('#pv [role=status]'), 'Saving login…', 'expiry must not relabel an active Save');
    gate.resolve();
    await page.waitForSelector('#pv .lline');
    assert.equal(await page.textContent('#pv .pvh b'), 'Logins');
    assert.match(await page.innerText('#pv'), /1 of 1 signed in/);
    assert.equal(await page.locator('[data-act=signout-login][data-id="web:portal"]').count(), 1);
    assert.deepEqual([saves, cancels], [1, 0]);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
    assert.equal(cancels, 0, 'a late close must not cancel the saved sign-in');
  } finally {
    gate.resolve();
    await page.close();
  }
});

for (const fails of [false, true]) test(`a saved login stays usable while background checking ${fails ? 'fails' : 'succeeds'}`, async () => {
  const { page, requests } = await open('user');
  let assessment: object = { checking: true };
  try {
    await page.route('**/logins/sites', r => r.fulfill({ json: { portal: { url: 'https://portal.test/start', hosts: [], ...assessment } } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('#pv .lline');
    await page.getByText('Login saved', { exact: true }).waitFor();
    await page.getByText('Checking website…', { exact: true }).waitFor();
    assert.match(await page.innerText('#pv'), /1 of 1 signed in/);
    assert.equal(await page.locator('[data-act=signin-save]').count(), 0);
    assert.equal(await page.isDisabled('[data-act=unpv]'), false);
    assessment = { checking: false, profile: fails ? { error: 'OpenRouter answered 500' } : grant.profile };
    await page.evaluate(() => refresh());
    assert.equal(await page.getByText('Checking website…', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Website check failed: OpenRouter answered 500', { exact: true }).count(), fails ? 1 : 0);
    assert.equal(await page.locator('[data-act=signout-login][data-id="web:portal"]').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
    assert.equal(requests.filter(r => r.path === '/signins/s1' && r.method === 'DELETE').length, 0);
  } finally {
    await page.close();
  }
});

test('assessment refreshes preserve Logins drafts and cannot restore an older Checking response', async () => {
  const { page } = await open('user'), gate = Promise.withResolvers<void>(), seen = Promise.withResolvers<void>();
  const portal = { url: 'https://portal.test/start', hosts: [], header: 'x-bot-token' };
  try {
    await page.route('**/logins/sites', r => r.fulfill({ json: { portal: { ...portal, checking: true } } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.fill('#hdr-portal', 'fake-token-draft');
    await page.click('details[data-shown="site-add"] > summary');
    await page.fill('#site-name', 'draft-site');
    await page.fill('input[placeholder="What runs there use it for"]', 'draft-reason');
    let reads = 0;
    await page.route('**/logins/sites', async r => {
      if (++reads === 1) {
        seen.resolve();
        await gate.promise;
        return r.fulfill({ json: { portal: { ...portal, checking: true } } });
      }
      return r.fulfill({ json: { portal: { ...portal, checking: false, profile: grant.profile } } });
    });
    await page.evaluate(() => { window.oldRefresh = refresh(); });
    await seen.promise;
    await page.evaluate(() => refresh());
    gate.resolve();
    await page.evaluate(() => window.oldRefresh);
    assert.equal(await page.getByText('Checking website…', { exact: true }).count(), 0);
    assert.equal(await page.inputValue('#hdr-portal'), 'fake-token-draft');
    assert.equal(await page.inputValue('#site-name'), 'draft-site');
    assert.equal(await page.inputValue('input[placeholder="What runs there use it for"]'), 'draft-reason');
  } finally {
    gate.resolve();
    await page.close();
  }
});

test('a saved login with a failed model profile shows a website-check warning, not an authentication failure', async () => {
  const { page } = await open('user');
  try {
    await page.route('**/logins/sites', r => r.fulfill({ json: { portal: { url: 'https://portal.test/start', hosts: [], profile: { error: 'OpenRouter answered 500' } } } }));
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('#pv .lline');
    assert.match(await page.innerText('#pv'), /1 of 1 signed in/);
    assert.equal(await page.locator('[data-act=signout-login][data-id="web:portal"]').count(), 1);
    await page.getByText('Website check failed: OpenRouter answered 500', { exact: true }).waitFor({ timeout: 1000 });
  } finally {
    await page.close();
  }
});

test('a rejected website Save reports the error and restores Save and Cancel', async () => {
  const { page } = await open('user'), gate = Promise.withResolvers<void>(), seen = Promise.withResolvers<void>(), bodies: unknown[] = [];
  try {
    await page.route('**/signins/s1', async r => {
      if (r.request().method() === 'DELETE') return r.fulfill({ json: {} });
      bodies.push(r.request().postDataJSON());
      seen.resolve();
      await gate.promise;
      await r.fulfill(bodies.length === 1 ? { status: 409, body: 'Take control and sign in first, then Save login.' } : { json: {} });
    });
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    await page.check('#keep');
    const until = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    await page.fill('#keep-until', until);
    await page.click('[data-act=signin-save]');
    await seen.promise;
    assert.equal(await page.isDisabled('[data-act=unpv]'), true);
    gate.resolve();
    await page.getByText('Take control and sign in first, then Save login.', { exact: true }).waitFor();
    assert.equal(await page.isDisabled('[data-act=signin-save]'), false);
    assert.equal(await page.isDisabled('[data-act=unpv]'), false);
    assert.equal(await page.textContent('[data-act=signin-save]'), 'Save login');
    assert.equal(await page.isChecked('#keep'), true);
    assert.equal(await page.inputValue('#keep-until'), until);
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('#pv .lline');
    assert.deepEqual(bodies, [{ keepalive: new Date(until).toISOString() }, { keepalive: new Date(until).toISOString() }]);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
  } finally {
    gate.resolve();
    await page.close();
  }
});

test('Save stays protected while its successful POST waits for Logins to load', async () => {
  const { page, requests } = await open('user'), gate = Promise.withResolvers<void>(), seen = Promise.withResolvers<void>();
  try {
    await page.clock.install();
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    await page.route('**/connections', async r => {
      seen.resolve();
      await gate.promise;
      await r.fulfill({ json: [] });
    });
    await page.click('[data-act=signin-save]');
    await seen.promise;
    await page.keyboard.press('Escape');
    await page.locator('[data-act=unpv]').dispatchEvent('click');
    await page.evaluate(() => { location.hash = '#/'; });
    await page.clock.fastForward(601_000);
    await page.evaluate(() => renderPv());
    assert.equal(await page.locator('#pv[open]').count(), 1);
    assert.equal(await page.isDisabled('[data-act=unpv]'), true);
    assert.equal(await page.textContent('#pv [role=status]'), 'Saving login…');
    assert.equal(requests.filter(r => r.path === '/signins/s1' && r.method === 'DELETE').length, 0);
    gate.resolve();
    await page.waitForSelector('#pv .lline');
    assert.equal(await page.textContent('#pv .pvh b'), 'Logins');
  } finally {
    gate.resolve();
    await page.close();
  }
});

test('a Logins refresh error after Save does not offer to save or cancel a consumed sign-in', async () => {
  const { page } = await open('user');
  let cancels = 0;
  try {
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
    await page.click('[data-act=web-signin]');
    await page.route('**/signins/s1', r => {
      if (r.request().method() === 'DELETE') cancels++;
      return r.fulfill({ json: {} });
    });
    await page.route('**/logins', r => r.fulfill({ status: 502, body: 'Cannot load Logins' }));
    await page.click('[data-act=signin-save]');
    await page.getByText('Cannot load Logins', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-act=signin-save]').count(), 0);
    assert.equal(await page.textContent('#pv [role=status]'), 'Login saved. Close this and open Logins again.');
    assert.equal(await page.textContent('#pv [data-act=unpv]'), 'Close');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
    assert.equal(cancels, 0);
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
    await used.locator('summary').click();
    await page.locator('[data-grant=legacy] > summary').click();
    assert.match(await used.innerText(), /Opened in 7 runs · 2 runs wrote · last used/);
    assert.equal(await used.locator('[data-act=grant-revoke]').count(), 1);
    assert.doesNotMatch(await page.locator('[data-grant=legacy]').innerText(), /undefined|NaN|Opened in/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#pv .pvb').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.click('#pv [data-act=unpv]');
    await page.click('#bar [data-act=menu]');
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('details[data-shown="web:portal"] > summary');
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

test('website ticks require this person’s approved workspace grant, never a successful profile, and omit stale ticks from explicit task consent', async () => {
  const { page, requests, sites } = await openWebsiteTicks();
  try {
    await page.evaluate(() => onAct('new-task', document.createElement('button')));
    await page.evaluate(sites => { pv.settings.on = sites.map(s => `web:${s}`); renderPv(); }, sites);
    assert.equal(await page.isChecked('#autonomous'), false);
    for (const site of sites) {
      const tick = page.locator(`#pv input.tick[value="web:${site}"]`);
      assert.equal(await tick.isDisabled(), site !== 'approved', site);
      assert.equal(await tick.isChecked(), site === 'approved', 'stale selection: ' + site);
      if (site !== 'approved') assert.match(await tick.locator('xpath=../..').innerText(), new RegExp(site === 'expired' ? 'expired' : 'grant ' + (site === 'missing' ? 'required' : site)));
    }
    assert.equal(await page.locator('#pv [data-act=grant-ask], #pv input[placeholder*="use it for"]').count(), 0);
    assert.match(await page.locator('#pv .tickrow:has(input[value="web:pending"]) .about').textContent(), /You asked .+; it waits on Finance's owners, you/);
    await page.click('#pv .tgroup > summary .sub');
    await page.check('#pv input.tick[value="m365:mail"]');
    await page.check('#pv input.tick[value="drop:AP/"]');
    await page.evaluate(() => { document.querySelector('#pv input.tick[value="web:revoked"]').checked = true; });
    await page.click('#pv [data-act=start-go]');
    await page.waitForFunction(() => !pv);
    assert.deepEqual(requests.find(r => r.path === '/api/series' && r.method === 'POST')!.body,
      { workspace: 'w1', single: true, logins: ['m365:mail', 'drop:AP/', 'web:approved'], autonomous: false });
  } finally { await page.close(); }
});

test('website info works by hover, focus and tap, linking to the existing site/workspace form and returning to a task consent draft', async () => {
  const { page, requests, responses } = await openWebsiteTicks();
  try {
    await page.evaluate(() => onAct('new-task', document.createElement('button')));
    await page.check('#autonomous');
    await page.check('#pv input.tick[value="drop:AP/"]');
    const row = page.locator('#pv .tickrow:has(input[value="web:missing"])'), info = row.locator('[data-act=info]'), about = row.locator('.about');
    await page.mouse.move(0, 0);
    assert.equal(await about.isVisible(), false);
    await info.hover();
    assert.equal(await about.isVisible(), true);
    await page.mouse.move(0, 0);
    await info.focus();
    assert.equal(await about.isVisible(), true);
    assert.equal(await info.getAttribute('aria-describedby'), await about.getAttribute('id'));
    assert.match(await about.innerText(), /need an approved grant/);
    assert.match(await about.innerText(), /Approval: Finance's owners, you/);
    await page.keyboard.press('Escape');
    assert.equal(await about.isVisible(), false);
    assert.equal(await page.locator('#pv').isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await info.click();
    assert.equal(await about.isVisible(), true);
    await row.locator('[data-act=website-setup]').click();
    await page.waitForSelector('#pv details[data-shown="web:missing"][open]');
    const form = page.locator('#pv .row2:has([data-act=grant-ask][data-id=missing])');
    assert.equal(await form.locator('select').inputValue(), 'w1', 'target workspace is not the first workspace');
    assert.equal(await page.locator('#pv details[data-shown="web:approved"]').getAttribute('open'), null, 'other native details stay collapsed');
    assert.equal(requests.filter(r => r.path === '/grants' && r.method === 'POST').length, 0);
    assert.equal(new URL(page.url()).hash, '#/s1');
    await page.screenshot({ path: '/tmp/rf-setup-website-form-phone.png' });
    await page.click('#pv [data-act=unpv]');
    assert.equal(await page.isChecked('#autonomous'), true, 'autonomous consent draft survives setup');
    assert.equal(await page.isChecked('#pv input.tick[value="drop:AP/"]'), true);
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.screenshot({ path: '/tmp/rf-setup-website-ticks.png' });
    const expired = page.locator('#pv .tickrow:has(input[value="web:expired"])');
    await expired.locator('[data-act=info]').click();
    await expired.locator('[data-act=website-setup]').click();
    await page.waitForSelector('#pv details[data-shown="web:expired"][open]');
    await page.route('**/logins/web/expired', r => r.fulfill({ json: { id: 'again', expires: new Date(Date.now() + 600_000).toISOString() } }));
    await page.route('**/signins/again', r => {
      (responses['/logins'] as { id: string; expired: boolean }[]).find(l => l.id === 'web:expired')!.expired = false;
      return r.fulfill({ body: 'ok' });
    });
    await page.click('#pv details[data-shown="web:expired"] [data-act=web-signin]');
    await page.click('#pv [data-act=signin-save]');
    await page.waitForSelector('#pv details[data-shown="web:expired"][open]');
    await page.click('#pv [data-act=unpv]');
    assert.equal(await expired.locator('input').isEnabled(), true, 'a renewed login is usable on return to the draft');
    assert.equal(await page.isChecked('#autonomous'), true, 'autonomous consent draft survives setup');
    await info.click();
    await row.locator('[data-act=website-setup]').click();
    await page.waitForSelector('#pv details[data-shown="web:missing"][open]');
    await page.evaluate(() => { location.hash = '#/w2'; });
    await page.waitForFunction(() => cur.w.id === 'w2' && pv === null);
    assert.equal(await page.locator('#pv').isVisible(), false, 'navigation discards the old context rather than restoring its draft');
  } finally { await page.close(); }
});

test('canceling a draft while website setup loads cannot restore or overwrite its dialog', async () => {
  const { page, responses } = await openWebsiteTicks();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    await page.evaluate(() => onAct('new-task', document.createElement('button')));
    await page.route('**/logins/sites', async route => {
      started.resolve();
      await release.promise;
      await route.fulfill({ json: responses['/logins/sites'] });
    });
    const opening = page.evaluate(() => onAct('website-setup', document.querySelector('#pv [data-act=website-setup][data-id=missing]')));
    await started.promise;
    await page.evaluate(() => closePv(true));
    release.resolve();
    await opening;
    assert.equal(await page.locator('#pv').isVisible(), false);
    assert.equal(await page.evaluate(() => pv), null);
  } finally { release.resolve(); await page.close(); }
});

test('series credential drafts use the series workspace and filter disabled values from explicit whole-series consent', async () => {
  const { page, requests, series } = await openWebsiteTicks();
  try {
    await page.evaluate(() => openSeriesSettings());
    assert.match(await page.textContent('#pv') ?? '', /Every instance may use the selected credentials/);
    assert.equal(await page.isChecked('#autonomous'), false);
    assert.equal(await page.isDisabled('#pv input.tick[value="web:missing"]'), true, 'approval in another workspace is not enough');
    assert.equal(await page.isEnabled('#pv input.tick[value="web:approved"]'), true, 'profile failure is not grant failure');
    await page.check('#pv input.tick[value="web:approved"]');
    await page.check('#pv input.tick[value="drop:AP/"]');
    await page.check('#autonomous');
    const missing = page.locator('#pv .tickrow:has(input[value="web:missing"])');
    await missing.locator('[data-act=info]').click();
    await missing.locator('[data-act=website-setup]').click();
    await page.waitForSelector('#pv details[data-shown="web:missing"][open]');
    await page.click('#pv [data-act=unpv]');
    assert.equal(await page.isChecked('#pv input.tick[value="drop:AP/"]'), true);
    assert.equal(await page.isChecked('#pv input.tick[value="web:approved"]'), true, 'credential consent draft survives setup too');
    assert.equal(await page.isChecked('#autonomous'), true);
    await page.evaluate(() => { document.querySelector('#pv input.tick[value="web:denied"]').checked = true; });
    await page.click('#pv [data-act=series-credentials]');
    await page.waitForSelector('#pv .saved:text-is("Saved")');
    assert.deepEqual(requests.find(r => r.path === '/api/series/s1/credentials' && r.method === 'PUT')!.body,
      { logins: ['drop:AP/', 'web:approved'], autonomous: true });
    Object.assign(series, { consent: { ...series.consent, logins: ['web:missing', 'web:pending', 'web:denied', 'web:revoked', 'web:approved', 'web:expired'], autonomous: true } });
    await page.evaluate(async () => { await refresh(); await openSeriesSettings(); });
    for (const site of ['missing', 'pending', 'denied', 'revoked', 'expired']) {
      assert.equal(await page.isDisabled(`#pv input.tick[value="web:${site}"]`), true);
      assert.equal(await page.isChecked(`#pv input.tick[value="web:${site}"]`), false);
    }
    await page.click('#pv .tgroup > summary .sub');
    await page.check('#pv input.tick[value="m365:mail"]');
    await page.click('#pv [data-act=series-credentials]');
    await page.waitForSelector('#pv .saved:text-is("Saved")');
    const saves = requests.filter(r => r.path === '/api/series/s1/credentials' && r.method === 'PUT');
    assert.deepEqual(saves.at(-1)!.body, { logins: ['m365:mail', 'web:approved'], autonomous: true });
    Object.assign(series, { consent: { ...series.consent, logins: ['m365:mail', 'web:approved'], autonomous: true } });
    await page.evaluate(async () => { await refresh(); await openSeriesSettings(); });
    await missing.locator('[data-act=info]').click();
    await missing.locator('[data-act=website-setup]').click();
    await page.waitForSelector('#pv details[data-shown="web:missing"][open]');
    await page.click('#pv [data-act=unpv]');
    assert.equal(await page.isChecked('#pv input.tick[value="m365:mail"]'), true, 'saved selections are not reset on return from setup');
  } finally { await page.close(); }
});

test('recurring series settings retain series name, wake and archive controls', async () => {
  const { page } = await openWebsiteTicks();
  try {
    await page.evaluate(() => openSeriesSettings());
    assert.equal(await page.locator('#pv #sname').count(), 1);
    assert.equal(await page.locator('#pv .wlabel').count(), 1);
    assert.equal(await page.locator('#pv [data-act=wake-save]').count(), 1);
    assert.equal(await page.locator('#pv [data-act=archive-series]').count(), 1);
    assert.equal(await page.locator('#pv [data-act=series-credentials]').count(), 1);
  } finally { await page.close(); }
});

test('a new task ignores remembered ticks and explicitly consents to an empty selection with autonomous off', async () => {
  const { page, requests, sites } = await openWebsiteTicks();
  try {
    await page.evaluate(sites => { localStorage.ticks = JSON.stringify([...sites.map(s => `web:${s}`), 'm365:mail', 'drop:AP/']); }, sites);
    await page.evaluate(() => onAct('new-task', document.createElement('button')));
    assert.equal(await page.locator('#pv input.tick:checked').count(), 0);
    assert.equal(await page.isChecked('#autonomous'), false);
    assert.equal(requests.some(r => r.path === '/api/series' && r.method === 'POST'), false, 'creation waits for explicit consent');
    await page.click('#pv [data-act=start-go]');
    assert.deepEqual(requests.find(r => r.path === '/api/series' && r.method === 'POST')!.body,
      { workspace: 'w1', single: true, logins: [], autonomous: false });
  } finally { await page.close(); }
});

test('a request from Waiting is owner-only and starts without changing target series credentials from another workspace', async () => {
  const { page, requests, series, responses } = await openWebsiteTicks();
  try {
    series.requests.push({ id: 'r1', label: 'Next period', who: person, from: 'alice@demo.test' });
    responses['/api/requests/r1'] = {};
    await page.evaluate(() => { location.hash = '#/w2'; });
    await page.waitForFunction(() => cur.w.id === 'w2');
    await page.evaluate(() => onAct('waiting', document.createElement('button')));
    await page.waitForSelector('#pv [data-act=req-start]');
    await page.click('#pv [data-act=req-start]');
    assert.deepEqual(requests.find(r => r.path === '/api/requests/r1' && r.method === 'POST')!.body, {});
    assert.equal(await page.locator('#pv input.tick').count(), 0, 'request Start never selects credentials');
    series.owner = 'alice@demo.test';
    await page.evaluate(async () => { await refresh(); await onAct('waiting', document.createElement('button')); });
    assert.equal(await page.locator('[data-act=req-start]').count(), 0, 'workspace manager cannot start another owner’s request');
  } finally { await page.close(); }
});
