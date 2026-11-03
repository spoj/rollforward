import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
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

test('names change in place: Enter saves, Escape keeps the old one', async () => {
  await page.click('[data-act=menu-series]');
  await page.click('#pop [data-act=rename-series]');
  await page.keyboard.type('Weekly BB');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.row.ser.on .nm:text-is("Weekly BB")');
  await page.click('#bar h1 .t');
  await page.keyboard.type('nope');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#bar h1 .t:text-is("2026-09-06")');
  await page.click('#bar h1 .t');
  await page.keyboard.type('2026-09-06 b');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#bar h1 .t:text-is("2026-09-06 b")');
});

test('settings save as they change, and a click beside the dialog closes it', async () => {
  await page.click('[data-act=menu-series]');
  await page.click('#pop [data-act=settings]');
  await page.fill('#sname', 'Weekly borrowing base');
  await page.press('#sname', 'Enter');
  await page.waitForSelector('#pv .saved:text-is("Saved")');
  await page.waitForSelector('.row.ser.on .nm:text-is("Weekly borrowing base")');
  await page.mouse.click(5, 5);
  await page.waitForSelector('#pv:not([open])', { state: 'attached' });
});

test('a new series asks for its name, and says in the dialog why one is refused', async () => {
  await page.click('[data-act=new-series]');
  await page.keyboard.type('Weekly borrowing base');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ask .err:text("exists")');
  await page.fill('#ask input', 'Bank rec');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.row.ser.on .nm:text-is("Bank rec")');
});

test('abandoning asks first, in the page', async () => {
  await page.click('.row.ser .nm:text-is("Weekly borrowing base")');
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
