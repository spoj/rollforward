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

const person = 'bob@demo.test', since = '2026-12-02T03:04:00.000Z';
const grant = {
  id: 'g1', workspace: 'w1', workspaceName: 'Finance', person: 'ann@demo.test', personName: 'Ann', site: 'ledger',
  url: 'https://ledger.client.test/start', via: 'client', state: 'pending', reason: 'Fetch the weekly ledger',
  profile: { what: 'The company ledger.', category: 'company', risk: 'low', flags: [] }, flags: [], adminOnly: false, adminWhy: '', use: null,
};
type Vpn = { name: string; type: string; gateway: string; connected: boolean; since?: string; error?: string };

async function open(can = ['vpn', 'keepalive'], role = 'user', grants: object[] = [], hasTouch = false) {
  const page = await browser.newPage({ hasTouch }), requests: { path: string; method: string; body: unknown }[] = [], signinNames = new Map<string, string>();
  const state = {
    vpns: [
      { name: 'client', type: 'fortinet', gateway: 'vpn.client.test:10443', connected: false },
      { name: 'other', type: 'fortinet', gateway: 'vpn.other.test:443', connected: false },
    ] as Vpn[],
    listError: '', startError: '', saveError: '', disconnectError: '', expires: new Date(Date.now() + 600_000).toISOString(), signins: 0,
  };
  const responses: Record<string, unknown> = {
    '/me': { email: person, name: 'Bob', role, can, browsers: true, brand: {}, names: { [person]: 'Bob', 'ann@demo.test': 'Ann' } },
    '/api': [{ id: 'w1', name: 'Finance', manage: true, owners: [person], members: [], archived: false, mine: true,
      series: [], grants, reads: [], readers: [], moved: [], agents: '' }],
    '/connections': [], '/grants': grants, '/tokens': [],
    '/logins': [{ id: 'web:ledger', kind: 'website', name: 'ledger', since, expired: false, offers: [], missing: [] }],
    '/logins/sites': { ledger: { url: 'https://ledger.client.test/start', hosts: [], via: 'client' } },
  };
  await page.route('**/*', async r => {
    const req = r.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    if (url.origin !== origin) return r.abort();
    requests.push({ path: path + url.search, method, body: req.postData() ? req.postDataJSON() : null });
    if (path === '/api/events') return r.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/vpns') return state.listError ? r.fulfill({ status: 502, body: state.listError }) : r.fulfill({ json: state.vpns });
    const start = path.match(/^\/vpns\/([^/]+)\/signins$/);
    if (start) {
      if (state.startError) return r.fulfill({ status: 502, body: state.startError });
      const id = `vpn${++state.signins}`;
      signinNames.set(id, decodeURIComponent(start[1]));
      return r.fulfill({ json: { id, expires: state.expires } });
    }
    const signin = path.match(/^\/signins\/(vpn\d+)$/);
    if (signin) {
      if (method === 'DELETE') return r.fulfill({ json: {} });
      if (state.saveError) return r.fulfill({ status: 502, body: state.saveError });
      const v = state.vpns.find(v => v.name === signinNames.get(signin[1]))!;
      v.connected = true;
      v.since = since;
      return r.fulfill({ json: {} });
    }
    const disconnect = path.match(/^\/vpns\/([^/]+)\/connection$/);
    if (disconnect) {
      if (state.disconnectError) return r.fulfill({ status: 502, body: state.disconnectError });
      const v = state.vpns.find(v => v.name === decodeURIComponent(disconnect[1]))!;
      v.connected = false;
      delete v.since;
      return r.fulfill({ json: {} });
    }
    if (path === '/logins/web/ledger') return r.fulfill({ json: { id: 'web1', expires: state.expires } });
    if (/^\/signins\/[^/]+\/view$/.test(path)) return r.fulfill({ contentType: 'text/html', body: '<main>Gateway SAML sign-in</main>' });
    if (path === '/signins/web1') return r.fulfill({ json: {} });
    if (path in responses) return r.fulfill({ json: responses[path] });
    return r.continue();
  });
  await page.goto(origin + '/#/w1');
  await page.waitForSelector('#sidefoot [data-act=logins]');
  return { page, requests, state, responses };
}

test('website lists use native collapsed disclosures, keep drafts through refresh and actions, and show check errors once', async () => {
  const error = 'The model check failed <try again later>';
  const grants = [
    { ...grant, person, state: 'approved', by: person, decided: since, text: 'For month end.', use: { runs: 4, wrote: 2, last: since } },
    { ...grant, id: 'failed', person, site: 'bank', url: 'https://bank.test/signin?account=finance', profile: { error }, flags: [`the website profile could not be checked: ${error}`, 'Owner concern'], adminOnly: true, adminWhy: `the website profile could not be checked: ${error}: an admin decides` },
  ];
  const { page, responses } = await open(['keepalive'], 'admin', grants, true);
  try {
    responses['/logins/sites'] = {
      ledger: { url: grant.url, hosts: ['cdn.ledger.test'], header: 'x-bot-token', profile: grant.profile },
      bank: { url: grants[1].url, hosts: [], profile: { error } },
      ...Object.fromEntries(['wiki', 'payroll', 'expenses', 'archive'].map(name => [name, { url: `https://${name}.example.test/signin/long-path?account=finance`, hosts: [] }])),
    };
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    const ledger = page.locator('details[data-shown="web:ledger"]'), bank = page.locator('details[data-shown="web:bank"]'), add = page.locator('details[data-shown=site-add]');
    assert.equal(await page.locator('#pv details[open]').count(), 0);
    assert.match(await ledger.locator('summary').innerText(), /ledger ledger\.client\.test · signed in · 1 approved/);
    assert.match(await bank.locator('summary').innerText(), /bank bank\.test · not signed in · 1 pending · check failed/);
    assert.doesNotMatch((await page.locator('#pv').innerText()), /https:\/\/|Sign in yourself|try again later|What runs there use/);
    assert.equal(await page.locator('#site-name').isVisible(), false);
    const info = page.getByRole('button', { name: 'About website logins', exact: true }), explanation = page.locator('#websites-info');
    assert.equal(await explanation.isVisible(), false);
    await info.hover();
    assert.equal(await explanation.isVisible(), true);
    assert.match(await explanation.innerText(), /cookies[\s\S]*submitting and approving[\s\S]*counts its writes[\s\S]*owners approved[\s\S]*signed out a week/);
    await info.focus();
    await page.keyboard.press('Escape');
    assert.equal(await explanation.isVisible(), false, 'Escape dismisses without closing Logins, even while hovered');
    assert.equal(await page.locator('#pv').getAttribute('open'), '');
    await page.mouse.move(0, 0);
    await info.blur();
    await info.focus();
    assert.equal(await explanation.isVisible(), true, 'keyboard focus reveals the description');
    await page.keyboard.press('Tab');
    assert.equal(await explanation.evaluate(el => el === document.activeElement), true, 'keyboard users can focus and scroll the explanation');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('#websites-info')!.scrollTop > 0);
    await page.keyboard.press('Escape');
    assert.equal(await explanation.isVisible(), false);
    await info.click();
    await page.click('#pv .pvh b');
    assert.equal(await explanation.isVisible(), false, 'a click outside dismisses');
    await ledger.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await ledger.getAttribute('open'), '');
    const ax = await page.context().newCDPSession(page);
    const { nodes } = await ax.send('Accessibility.getFullAXTree');
    assert.ok(nodes.some(n => n.role?.value === 'DisclosureTriangle' && n.name?.value.includes('ledger ledger.client.test') && n.properties?.some(p => p.name === 'expanded' && p.value.value === true)));
    await ax.detach();
    assert.equal(await ledger.locator('[data-act=grant-revoke]').innerText(), 'Stop using');
    await page.fill('#hdr-ledger', 'private token');
    await page.evaluate(() => refresh());
    assert.equal(await page.inputValue('#hdr-ledger'), 'private token');
    await bank.locator('summary').click();
    assert.equal((await bank.innerText()).split(error).length - 1, 1, 'not repeated in Flags or admin-only reasons');
    assert.match(await bank.innerText(), /Owner concern/);
    Object.assign(grants[1], { profile: { error: 'timeout' }, flags: ['the website profile could not be checked: timeout', 'Payment may still be submitted after timeout'], adminWhy: 'the website profile could not be checked: timeout: an admin decides' });
    await page.evaluate(() => openLogins());
    assert.match(await bank.innerText(), /Payment may still be submitted after timeout/, 'distinct warnings mentioning the error survive');
    assert.doesNotMatch(await bank.innerText(), /Flags: the website profile could not be checked/);
    await bank.locator('summary').click();
    await page.evaluate(() => renderPv());
    assert.equal(await ledger.getAttribute('open'), '');
    assert.equal(await bank.getAttribute('open'), null);
    const addInfo = page.getByRole('button', { name: 'About adding a website', exact: true });
    await addInfo.click();
    assert.equal(await page.locator('#site-add-info').isVisible(), true);
    assert.equal(await add.getAttribute('open'), null, 'the info button does not toggle Add website');
    await page.locator('#site-add-info').click();
    assert.equal(await add.getAttribute('open'), null, 'reading the explanation does not toggle Add website either');
    await page.keyboard.press('Escape');
    await add.locator('summary').focus();
    await page.keyboard.press('Space');
    await page.fill('#site-name', 'new bank');
    await page.evaluate(() => refresh());
    assert.equal(await page.inputValue('#site-name'), 'new bank');
    for (const width of [930, 390, 320]) {
      await page.setViewportSize({ width, height: 559 });
      assert.equal(await page.locator('#pv .pvb').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${width}px expanded websites and Add website`);
      await info.tap();
      const box = (await explanation.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${width}px info stays on screen`);
      assert.equal(await explanation.evaluate(el => el.scrollHeight > el.clientHeight), true, 'long explanations scroll within the popover');
      await page.click('#pv .pvh b');
    }
    await page.setViewportSize({ width: 930, height: 559 });
    await page.route('**/grants/g1', r => { grants.splice(0, 1); return r.fulfill({ json: {} }); });
    await ledger.locator('[data-act=grant-revoke]').click();
    await ledger.locator('[data-act=grant-revoke]').waitFor({ state: 'detached' });
    assert.equal(await ledger.getAttribute('open'), '', 'Stop using leaves the website open');
    await page.route('**/logins/web%3Aledger', r => { responses['/logins'] = []; return r.fulfill({ json: {} }); });
    const signedOut = page.waitForRequest(r => r.url().endsWith('/logins/web%3Aledger') && r.method() === 'DELETE');
    await ledger.locator('[data-act=signout-login]').click();
    await signedOut;
    await ledger.locator('[data-act=signout-login]').waitFor({ state: 'detached' });
    assert.equal(await ledger.getAttribute('open'), '', 'sign-out refresh leaves the website open');
    await page.click('#pv [data-act=unpv]');
    await page.click('.row.ws [data-act=workspace-settings]');
    const failed = page.locator('details[data-grant=failed]');
    assert.equal(await failed.getAttribute('open'), null);
    await failed.locator('summary').click();
    assert.equal((await failed.innerText()).split('the website profile could not be checked: timeout').length - 1, 1);
    assert.match(await failed.innerText(), /Payment may still be submitted after timeout/);
    assert.equal(await failed.locator('[data-act=grant-approve]').isVisible(), true);
    await page.evaluate(() => { renderPv(); openWorkspaceSettings(); });
    assert.equal(await failed.getAttribute('open'), '');
    await page.click('#pv [data-act=unpv]');
    await page.click('[data-act=waiting]');
    assert.equal(await page.locator('#pv details[data-grant]').count(), 0, 'approval cards stay unfolded');
    assert.equal(await page.locator('#pv [data-grant=failed] [data-act=grant-approve]').isVisible(), true);
  } finally {
    await page.close();
  }
});

test('info popovers fit an empty website list, remain hoverable, and Escape dismisses them without closing Logins', async () => {
  const { page, responses } = await open(['keepalive']);
  try {
    responses['/logins/sites'] = {};
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    for (const width of [930, 320]) {
      await page.setViewportSize({ width, height: 559 });
      await page.getByRole('button', { name: 'Close', exact: true }).focus();
      const icon = page.getByRole('button', { name: 'About adding a website', exact: true }), note = page.locator('#site-add-info');
      await icon.hover();
      const box = (await note.boundingBox())!;
      assert.ok(box.y >= 0 && box.y + box.height <= 559 && box.x >= 0 && box.x + box.width <= width, `${width}px empty-list explanation is not clipped`);
      await note.hover();
      assert.equal(await note.isVisible(), true, 'hover users can reach and scroll the note');
      await page.keyboard.press('Escape');
      assert.equal(await note.isVisible(), false);
      assert.equal(await page.locator('#pv').getAttribute('open'), '');
      await page.mouse.move(0, 0);
    }
  } finally {
    await page.close();
  }
});

test('users and admins without explicit vpn capability neither fetch VPN routes nor see controls or their own via label', async () => {
  for (const role of ['user', 'admin']) {
    const { page, requests } = await open(['create', 'publish', 'keepalive'], role);
    try {
      await page.click('#sidefoot [data-act=logins]');
      await page.waitForSelector('#pv .lline');
      await page.click('[data-act=logins-show][data-id=web]');
      assert.equal(await page.locator('.vpn, [data-act^="vpn-"], .website-via').count(), 0);
      assert.doesNotMatch(await page.innerText('#pv'), /VPN/);
      await page.click('#pv [data-act=tokens]');
      await page.click('#pv [data-act=logins]');
      await page.waitForSelector('#pv .lline');
      assert.equal(requests.some(r => r.path.startsWith('/vpns')), false, role);
    } finally {
      await page.close();
    }
  }
});

test('explicitly opted-in users get the trial box only under Logins and a read-only via label under their website', async () => {
  const { page, requests } = await open();
  try {
    assert.equal(requests.some(r => r.path === '/vpns'), false, 'opening the page does not load VPNs');
    await page.click('#sidefoot [data-act=logins]');
    await page.waitForSelector('.vpn');
    assert.match(await page.innerText('.vpn'), /VPN · Trial[\s\S]*client[\s\S]*vpn\.client\.test:10443[\s\S]*Disconnected/);
    assert.equal(await page.locator('[data-act=vpn-signin]').count(), 2);
    assert.equal(await page.locator('[data-act=vpn-disconnect]').count(), 0);
    assert.equal(await page.locator('.website-via').count(), 0);
    await page.click('[data-act=logins-show][data-id=web]');
    assert.equal(await page.locator('.website-via').isVisible(), false);
    await page.click('#pv details[data-shown="web:ledger"] > summary');
    assert.equal(await page.textContent('.website-via'), 'Via client VPN');
    assert.equal(await page.locator('input[id*=via], select[id*=via], [data-act=vpn-add], [data-act=vpn-remove]').count(), 0);
    await page.click('#pv [data-act=tokens]');
    await page.waitForSelector('#pv [data-act=tokens].sel');
    assert.equal(await page.locator('.vpn, [data-act^="vpn-"]').count(), 0);
    assert.equal(requests.filter(r => r.path === '/vpns').length, 1);
  } finally {
    await page.close();
  }
});

test('VPN sign-in uses the generic private browser and the existing countdown, with Connect but no keepalive', async () => {
  const { page, requests, state } = await open();
  try {
    const now = Date.now();
    await page.clock.install({ time: new Date(now) });
    state.expires = new Date(now + 600_000).toISOString();
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=vpn-signin][data-id=client]');
    assert.equal(await page.textContent('#signin-clock'), '10:00');
    assert.equal(await page.textContent('[data-act=signin-save]'), 'Connect');
    assert.match(await page.innerText('#pv'), /Sign in to client VPN[\s\S]*then Connect/);
    assert.doesNotMatch(await page.innerText('#pv'), /Save login|Keep the login alive/);
    assert.equal(await page.locator('#keep, #keep-until').count(), 0);
    assert.equal(await page.getAttribute('#pv iframe', 'src'), '/signins/vpn1/view?drive');
    await page.locator('#pv iframe').evaluate(el => el.setAttribute('data-still-here', 'yes'));
    await page.clock.fastForward(1000);
    assert.equal(await page.textContent('#signin-clock'), '9:59');
    assert.equal(await page.getAttribute('#pv iframe', 'data-still-here'), 'yes');
    await page.clock.fastForward(599_000);
    await page.waitForSelector('#pv [role=status]');
    assert.equal(await page.textContent('#pv [role=status]'), 'Sign-in expired. Close this and sign in again.');
    assert.equal(await page.isDisabled('[data-act=signin-save]'), true);
    assert.equal(await page.locator('#pv iframe').count(), 0);
    assert.equal(requests.some(r => r.path === '/signins/vpn1' && r.method === 'POST'), false);
    await page.click('#pv [data-act=unpv]');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
    assert.ok(requests.some(r => r.path === '/signins/vpn1' && r.method === 'DELETE'));
    assert.equal(requests.some(r => r.path.includes('/refused')), false);
  } finally {
    await page.close();
  }
});

test('Connect saves through the generic sign-in dispatcher, refreshes connected-since state, and never cancels the saved browser', async () => {
  const { page, requests } = await open();
  try {
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=vpn-signin][data-id=client]');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('.vpn');
    assert.match(await page.locator('[data-vpn=client]').innerText(), /Connected since/);
    assert.doesNotMatch(await page.innerText('.vpn'), /Invalid Date|undefined|NaN/);
    assert.equal(await page.textContent('[data-vpn=client] [data-act=vpn-signin]'), 'Reconnect');
    assert.equal(await page.locator('[data-vpn=client] [data-act=vpn-disconnect]').count(), 1);
    assert.deepEqual(requests.find(r => r.path === '/signins/vpn1' && r.method === 'POST'), {
      path: '/signins/vpn1', method: 'POST', body: null,
    });
    assert.equal(requests.filter(r => r.path === '/vpns').length, 2);
    await page.click('#pv [data-act=unpv]');
    assert.equal(requests.some(r => r.method === 'DELETE'), false);
    assert.equal(requests.some(r => r.path === '/vpns/client/signins/vpn1'), false);
  } finally {
    await page.close();
  }
});

test('Cancel and Escape discard the VPN sign-in through the generic parent dispatcher', async () => {
  const { page, requests } = await open();
  try {
    for (const close of ['Cancel', 'Escape']) {
      await page.click('#sidefoot [data-act=logins]');
      await page.click('[data-act=vpn-signin][data-id=client]');
      await page.waitForSelector('#signin-clock');
      const cancelled = page.waitForResponse(r => r.url().includes('/signins/vpn') && r.request().method() === 'DELETE');
      if (close === 'Cancel') await page.click('#pv [data-act=unpv]');
      else await page.keyboard.press('Escape');
      await cancelled;
      await page.waitForSelector('#pv:not([open])', { state: 'attached' });
    }
    assert.deepEqual(requests.filter(r => r.method === 'DELETE').map(r => r.path), [
      '/signins/vpn1', '/signins/vpn2',
    ]);
    assert.equal(requests.some(r => /^\/vpns\/client\/signins\/vpn\d+$/.test(r.path)), false);
  } finally {
    await page.close();
  }
});

test('browser and tunnel service errors remain visible as text in their dialog', async () => {
  const { page, requests, state } = await open();
  try {
    state.startError = 'Browser service unavailable\nTry again later <not markup>';
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=vpn-signin][data-id=client]');
    await page.waitForFunction(() => document.querySelector('#vpn-error')!.textContent!.includes('Browser service unavailable'));
    assert.equal(await page.textContent('#vpn-error'), state.startError);
    assert.equal(await page.locator('#pv iframe, not-markup').count(), 0);
    state.startError = '';
    state.saveError = 'openconnect exited with code 2: rejected cookie\n--servercert pin-sha256:example';
    await page.click('[data-act=vpn-signin][data-id=client]');
    await page.click('[data-act=signin-save]');
    await page.waitForFunction(() => document.querySelector('#pvn')!.textContent!.includes('rejected cookie'));
    assert.equal(await page.textContent('#pvn'), state.saveError);
    assert.equal(await page.locator('#pv[open] iframe').count(), 1);
    assert.equal(await page.locator('#pvn[role=alert]').count(), 1);
    assert.equal(requests.filter(r => r.path === '/vpns').length, 1, 'a failed Connect does not claim to be connected');
    await page.click('#pv [data-act=unpv]');
  } finally {
    await page.close();
  }
});

test('reconnecting affects only that VPN, and Disconnect refreshes state or shows its service error', async () => {
  const { page, requests, state } = await open();
  try {
    state.vpns[0].connected = true;
    state.vpns[0].since = '2026-11-01T00:00:00.000Z';
    await page.click('#sidefoot [data-act=logins]');
    assert.equal(await page.textContent('[data-vpn=client] [data-act=vpn-signin]'), 'Reconnect');
    await page.click('[data-vpn=client] [data-act=vpn-signin]');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('[data-vpn=client] [data-act=vpn-disconnect]');
    assert.equal(state.vpns[0].since, since);
    await page.click('[data-vpn=other] [data-act=vpn-signin]');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('[data-vpn=other] [data-act=vpn-disconnect]');
    assert.match(await page.locator('[data-vpn=client]').innerText(), /Connected since/);
    assert.equal(await page.locator('[data-act=vpn-disconnect]').count(), 2);
    state.disconnectError = 'Tunnel service is unavailable';
    await page.click('[data-vpn=other] [data-act=vpn-disconnect]');
    await page.waitForFunction(() => document.querySelector('#vpn-error')!.textContent === 'Tunnel service is unavailable');
    assert.equal(await page.locator('[data-vpn=other] [data-act=vpn-disconnect]').count(), 1);
    state.disconnectError = '';
    await page.click('[data-vpn=other] [data-act=vpn-disconnect]');
    await page.waitForSelector('[data-vpn=other] [data-act=vpn-disconnect]', { state: 'detached' });
    assert.equal(await page.locator('[data-vpn=client] [data-act=vpn-disconnect]').count(), 1);
    assert.equal(await page.locator('[data-vpn=other] [data-act=vpn-signin]').innerText(), 'Connect');
    assert.equal(await page.textContent('#vpn-error'), '');
    assert.equal(requests.filter(r => r.method === 'DELETE' && r.path === '/vpns/other/connection').length, 2);
    assert.equal(requests.some(r => r.method === 'DELETE' && r.path === '/vpns/other'), false, 'Disconnect never removes the definition');
  } finally {
    await page.close();
  }
});

test('closing Logins while the VPN browser opens discards its late result instead of reopening a dialog', async () => {
  const { page, requests } = await open();
  try {
    let release!: () => void;
    const pending = new Promise<void>(ok => { release = ok; });
    await page.route('**/vpns/client/signins', async r => {
      await pending;
      await r.fulfill({ json: { id: 'late', expires: new Date(Date.now() + 600_000).toISOString() } });
    });
    await page.click('#sidefoot [data-act=logins]');
    await Promise.all([page.waitForRequest('**/vpns/client/signins'), page.click('[data-vpn=client] [data-act=vpn-signin]')]);
    await page.route('**/signins/late', r => r.fulfill({ json: {} }));
    const discarded = page.waitForResponse(r => r.url().endsWith('/signins/late') && r.request().method() === 'DELETE');
    await page.click('#pv [data-act=unpv]');
    release();
    await discarded;
    await page.waitForSelector('#pv [data-vpn=client] [data-act=vpn-signin]:not([aria-busy])', { state: 'attached' });
    assert.equal(await page.locator('#pv[open]').count(), 0);
    assert.equal(requests.some(r => r.path === '/signins/late/view?drive'), false);
  } finally {
    await page.close();
  }
});

test('late Connect and Disconnect completions never reopen a dialog the person closed', async () => {
  for (const act of ['signin-save', 'vpn-disconnect']) {
    const { page, requests, state } = await open();
    try {
      state.vpns[0].connected = true;
      state.vpns[0].since = since;
      await page.click('#sidefoot [data-act=logins]');
      if (act === 'signin-save') {
        await page.click('[data-vpn=client] [data-act=vpn-signin]');
        await page.waitForSelector('#signin-clock');
      }
      const path = act === 'signin-save' ? '/signins/vpn1' : '/vpns/client/connection', method = act === 'signin-save' ? 'POST' : 'DELETE';
      let release!: () => void;
      const pending = new Promise<void>(ok => { release = ok; });
      await page.route(`**${path}`, async r => {
        if (r.request().method() !== method) return r.fallback();
        await pending;
        await r.fulfill({ json: {} });
      });
      await Promise.all([page.waitForRequest(r => r.url().endsWith(path) && r.method() === method), page.click(`#pv [data-act=${act}]`)]);
      await page.click('#pv [data-act=unpv]');
      release();
      await page.waitForSelector(`#pv [data-act=${act}]:not([aria-busy])`, { state: 'attached' });
      assert.equal(await page.locator('#pv[open]').count(), 0, act);
      assert.equal(requests.filter(r => r.path === '/vpns').length, 1, act);
    } finally {
      await page.close();
    }
  }
});

test('a failed VPN status read shows the service error in Logins instead of an empty or disconnected list', async () => {
  const { page, state } = await open();
  try {
    state.listError = 'Cannot reach the tunnel service\nUpstream returned <502>';
    await page.click('#sidefoot [data-act=logins]');
    await page.waitForSelector('.vpn');
    assert.equal(await page.textContent('#vpn-error'), state.listError);
    assert.equal(await page.locator('.vpn-row, [data-act^="vpn-"]').count(), 0);
    assert.doesNotMatch(await page.innerText('.vpn'), /No VPNs|Disconnected|Connected since/);
    assert.equal(await page.locator('#pv [data-act=logins].sel').count(), 1);
  } finally {
    await page.close();
  }
});

test('down and empty VPN lists are disconnected states, not invented connection times', async () => {
  const { page, state } = await open();
  try {
    state.vpns[0].error = 'VPN client exited';
    await page.click('#sidefoot [data-act=logins]');
    await page.waitForSelector('.vpn');
    assert.match(await page.locator('[data-vpn=client]').innerText(), /Disconnected · VPN client exited/);
    assert.equal(await page.locator('[data-act=vpn-disconnect]').count(), 0);
    assert.doesNotMatch(await page.innerText('.vpn'), /since|undefined|NaN/);
    await page.click('#pv [data-act=unpv]');
    state.vpns = [];
    await page.click('#sidefoot [data-act=logins]');
    await page.waitForSelector('.vpn');
    assert.match(await page.innerText('.vpn'), /No VPNs set up on this server/);
    assert.equal(await page.locator('[data-act^="vpn-"]').count(), 0);
  } finally {
    await page.close();
  }
});

test('workspace owners see client-VPN grant disclosure even without VPN capability and never fetch VPNs', async () => {
  const { page, requests } = await open([], 'user', [grant]);
  try {
    await page.click('[data-act=waiting]');
    const card = page.locator('[data-grant=g1]');
    assert.match(await card.innerText(), /Through client VPN into the client's network/);
    assert.match(await card.innerText(), /including submitting and approving/);
    assert.equal(await card.locator('[data-act=grant-approve]').count(), 1);
    assert.equal(await page.locator('.vpn, [data-act^="vpn-"]').count(), 0);
    await page.click('#pv [data-act=unpv]');
    await page.click('.row.ws [data-act=workspace-settings]');
    await page.click('#pv details[data-grant=g1] > summary');
    assert.match(await page.locator('[data-grant=g1]').innerText(), /Through client VPN into the client's network/);
    assert.equal(requests.some(r => r.path.startsWith('/vpns')), false);
  } finally {
    await page.close();
  }
});

test('VPN controls, website via disclosure, and sign-in fit a narrow phone without horizontal scrolling', async () => {
  const { page, state } = await open();
  try {
    state.vpns[0].gateway = 'very-long-vpn-gateway-name-for-a-client.example.test:10443';
    state.vpns[0].connected = true;
    state.vpns[0].since = since;
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('#pv details[data-shown="web:ledger"] > summary');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.locator('#pv .pvb').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${width}px Logins`);
      assert.equal(await page.locator('.vpn').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${width}px VPN`);
      for (const el of await page.locator('.vpn button, .website-via').all()) {
        const box = (await el.boundingBox())!;
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${width}px control within screen`);
      }
    }
    await page.click('[data-vpn=client] [data-act=vpn-signin]');
    assert.equal(await page.locator('#pv').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('#pv iframe').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
    await page.click('#pv [data-act=unpv]');
  } finally {
    await page.close();
  }
});

test('regular website sign-in keeps Save login, keepalive, countdown and its original save and cancel routes', async () => {
  const { page, requests } = await open(['keepalive']);
  try {
    await page.click('#sidefoot [data-act=logins]');
    await page.click('[data-act=logins-show][data-id=web]');
    await page.click('#pv details[data-shown="web:ledger"] > summary');
    await page.click('[data-act=web-signin]');
    assert.equal(await page.textContent('[data-act=signin-save]'), 'Save login');
    assert.match(await page.textContent('#signin-clock') ?? '', /^9:5\d|10:00$/);
    await page.check('#keep');
    await page.click('[data-act=signin-save]');
    await page.waitForSelector('#pv .lline');
    const saved = requests.find(r => r.path === '/signins/web1' && r.method === 'POST')!.body as { keepalive: string };
    assert.ok(Math.abs(Date.parse(saved.keepalive) - Date.now() - 7 * 86_400_000) < 120_000);
    assert.equal(await page.locator('#pv details[data-shown="web:ledger"]').getAttribute('open'), '');
    await page.click('[data-act=web-signin]');
    await page.click('#pv [data-act=unpv]');
    await page.waitForSelector('#pv:not([open])', { state: 'attached' });
    assert.ok(requests.some(r => r.path === '/signins/web1' && r.method === 'DELETE'));
    assert.equal(requests.some(r => r.path.startsWith('/vpns')), false);
  } finally {
    await page.close();
  }
});
