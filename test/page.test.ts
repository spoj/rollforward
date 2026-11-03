import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

// The page in a browser, on a copy of the test fixture: menus, names changed in place, settings that save as they change, and the page's
// own dialogs, never the browser's.
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-page-')), root = join(tmp, 'data');
let proc: ChildProcess, browser: Browser, page: Page;
const native: string[] = [];

before(async () => {
  cpSync(join(app, 'test', 'fixture'), root, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch') };
  mkdirSync(env.HOME!);
  delete env.OPENROUTER_API_KEY;
  const probe = createServer();
  await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('dialog', d => { native.push(d.message()); d.dismiss(); });
  await page.request.post(`http://127.0.0.1:${port}/auth/demo`, { form: { email: 'admin@demo.test', next: '/' }, maxRedirects: 0 });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#bar h1 .t'); // once the start's kick of the open instance has passed
});

after(async () => {
  await browser.close();
  if (process.platform === 'win32') proc.kill();
  else process.kill(-proc.pid!, 'SIGTERM');
  await once(proc, 'exit');
});

test("an instance's label changes in place: Enter saves, Escape keeps the old one", async () => {
  await page.click('#bar h1 .t');
  await page.keyboard.type('nope');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#bar h1 .t:text-is("2026-09-06")');
  await page.click('#bar h1 .t');
  await page.keyboard.type('2026-09-06 b');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#bar h1 .t:text-is("2026-09-06 b")');
});

test("a series' gear opens its settings, which save as they change; a click beside the dialog closes it", async () => {
  await page.hover('.row.ser.on');
  await page.click('.row.ser.on [data-act=settings]');
  await page.fill('#sname', 'Weekly BB');
  await page.press('#sname', 'Enter');
  await page.waitForSelector('#pv .saved:text-is("Saved")');
  await page.waitForSelector('.row.ser.on .nm:text-is("Weekly BB")');
  await page.fill('#sname', 'Weekly borrowing base');
  await page.press('#sname', 'Enter');
  await page.waitForSelector('#pv .saved:text-is("Saved")');
  await page.waitForSelector('.row.ser.on .nm:text-is("Weekly borrowing base")');
  await page.mouse.click(5, 5);
  await page.waitForSelector('#pv:not([open])', { state: 'attached' });
});

test("the workspace's + starts a task at once, which its first prompt names, newest first under Ungrouped; closing makes it a series if asked", async () => {
  for (const prompt of ['Apple orchard audit for 2026', 'Zebra crossing survey']) {
    await page.hover('.row.ws.on');
    await page.click('.row.ws.on [data-act=new-task]');
    await page.waitForSelector('#bar h1 .t:text-is("Untitled")');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'newcomment', 'its conversation waits for the prompt');
    await page.keyboard.type(prompt);
    await page.click('[data-act=comment]');
    await page.waitForSelector(`#bar h1 .t:text-is("${prompt}")`);
  }
  assert.equal(await page.textContent('#bar .crumb'), 'larkfield · Ungrouped');
  assert.deepEqual(await page.locator('.row.grp ~ a.row.inst .nm').allTextContents(), ['Zebra crossing survey', 'Apple orchard audit for 2026']);
  await page.waitForSelector('#bar .state .bad:text("Run 1 failed")');
  await page.click('#bar [data-act=close]');
  await page.fill('#ask input', 'Zebra surveys');
  await page.click('#ask button:text-is("Make it a series and close")');
  await page.waitForSelector('.row.ser .nm:text-is("Zebra surveys")');
  assert.deepEqual(await page.locator('.row.ser .nm').allTextContents(), ['Zebra surveys', 'Weekly borrowing base'], 'series too come newest activity first');
  assert.deepEqual(await page.locator('.row.grp ~ a.row.inst .nm').allTextContents(), ['Apple orchard audit for 2026']);
});

test('only the runner abandons, and abandoning asks first, in the page', async () => {
  await page.click('.row.ser .nm:text-is("Weekly borrowing base")');
  await page.click('[data-act=menu-instance]');
  assert.equal(await page.locator('#pop [data-act=abandon]').count(), 0, 'alex runs it');
  await page.keyboard.press('Escape');
  await page.click('[data-act=takeover]');
  await page.click('[data-act=start-go]');
  await page.waitForSelector('#bar [data-act=close]');
  await page.click('[data-act=menu-instance]');
  await page.click('#pop [data-act=abandon]');
  await page.click('#ask button:text-is("Cancel")');
  assert.match(await page.textContent('#bar .state') ?? '', /Waiting for files/);
  await page.click('[data-act=menu-instance]');
  await page.click('#pop [data-act=abandon]');
  await page.click('#ask button:text-is("Abandon")');
  await page.waitForSelector('#bar .state:text("Abandoned")');
  assert.deepEqual(native, [], "the browser's own dialogs never show");
});

test("the side panel opens on Conversation beside the instance; the Ops log folds the agent's work between a run's start and its report", async () => {
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#log.open .tab.sel:text-is("Conversation")');
  assert.equal(await page.locator('#bar [data-act=show-panel]').count(), 0, 'the bar offers the panel only while it is closed');
  await page.click('#log [data-tab=log]');
  const work = page.locator('#log .e > div > details', { hasText: 'Agent showed 3 files, set up 3 items, removed 1 item' });
  await work.waitFor();
  assert.deepEqual(await page.locator('#log .e > div').evaluateAll(es => es.map(e => (e as HTMLElement).innerText.split('\n')[0])), [
    'alex opened the instance', 'alex uploaded an input', 'Server showed u2', 'Run 1 started',
    'Agent showed 3 files, set up 3 items, removed 1 item', 'Agent reported on run 1', 'Run 1 finished · 4m 0s · $0.21', 'alex closed the instance',
  ]);
  await work.locator('summary').first().click();
  await page.waitForSelector('#log .ln:text("set up Borrowing base")');
  await page.click('#log [data-act=hide-panel]');
  await page.click('#bar [data-act=show-panel]');
  await page.waitForSelector('#log.open .tab.sel:text-is("Conversation")');
});

test("a row's chevron folds and opens it, selected or not, and selects nothing", async () => {
  const title = await page.textContent('#bar h1');
  await page.click('.row.ws.on .chev');
  assert.equal(await page.locator('.row.ser').count(), 0, 'the selected workspace folds, and stays folded');
  assert.equal(await page.textContent('#bar h1'), title);
  await page.click('.row.ws.on .chev');
  await page.waitForSelector('.row.ser');
});

test('keys: c goes to the comment box, Ctrl+Enter sends it, Esc leaves it, and j moves through the sidebar', async () => {
  await page.click('a.row.inst.open >> nth=0');
  await page.waitForSelector('#bar [data-act=close], #bar [data-act=takeover]');
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'newcomment');
  await page.keyboard.type('Sent with keys');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => $('#log').textContent!.includes('Sent with keys') && !($('#newcomment') as HTMLTextAreaElement).value);
  await page.keyboard.press('Escape');
  await page.keyboard.press('j');
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#tree')), 'a row has the focus');
});

test("the deployment's brand tops the sidebar and titles the page, its logo the page's icon; unset, there is none", async () => {
  const brand = (data: object) => page.request.put(new URL('/brand', page.url()).href, { data });
  assert.equal(await page.locator('#brand').isVisible(), false);
  await brand({ text: 'Larkfield Finance', logo: { name: 'logo.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } });
  await page.reload();
  await page.waitForSelector('#brand span:text-is("Larkfield Finance")');
  assert.equal(await page.getAttribute('#brand img', 'src'), '/brand/logo');
  assert.match(await page.title(), / Larkfield Finance$/);
  assert.equal(await page.getAttribute('link[rel=icon]', 'href'), '/brand/logo');
  await brand({ clear: true });
  await page.reload();
  await page.waitForSelector('#tree .row.ws');
  assert.equal(await page.locator('#brand').isVisible(), false);
  assert.equal(await page.locator('link[rel=icon]').count(), 0);
  assert.match(await page.title(), / rollforward$/);
});

test("the sidebar's and the side panel's inner edges drag their widths, within bounds, kept in this browser; a double-click resets them", async () => {
  const widths = () => page.evaluate(() => [$('#side')!.offsetWidth, ($('#log') as HTMLElement).offsetWidth]);
  const drag = async (pane: string, dx: number) => {
    const b = (await page.locator(`.grip[data-pane=${pane}]`).boundingBox())!, x = b.x + b.width / 2;
    await page.mouse.move(x, 300);
    await page.mouse.down();
    await page.mouse.move(x + dx, 300, { steps: 4 });
    await page.mouse.up();
  };
  await page.waitForSelector('#log.open');
  assert.deepEqual(await widths(), [236, 352]);
  await drag('side', 100);
  await drag('panel', -150);
  assert.deepEqual(await widths(), [336, 502]);
  await drag('side', 1000);
  assert.deepEqual(await widths(), [384, 502], 'the sidebar takes at most 30% of the window');
  await page.reload();
  await page.waitForSelector('#log.open');
  assert.deepEqual(await widths(), [384, 502]);
  await page.dblclick('.grip[data-pane=side]');
  await page.dblclick('.grip[data-pane=panel]');
  assert.deepEqual(await widths(), [236, 352]);
});

test("what the session names, such as a tool call's name, shows as text in the Ops log, never as markup", async () => {
  appendFileSync(join(root, 'instances', '3d70f7ca6f20', 'session', 'main.jsonl'), JSON.stringify({ type: 'message', id: 'x1', parentId: 'm2', timestamp: '2026-08-30T23:03:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: '<img src=x onerror="window.pwned=1">', arguments: {} }] } }) + '\n');
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#log.open');
  await page.click('#log [data-tab=log]');
  await page.locator('#log .e > div > details', { hasText: '<img src=x onerror="window.pwned=1"> 1 call' }).waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
});
