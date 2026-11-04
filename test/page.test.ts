import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { idp } from './idp.ts';

// The page in a browser, on a copy of the test fixture: menus, names changed in place, settings that save as they change, and the page's
// own dialogs, never the browser's.
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-page-')), root = join(tmp, 'data');
let proc: ChildProcess, browser: Browser, page: Page, entra: Awaited<ReturnType<typeof idp>>;
const native: string[] = [];

before(async () => {
  cpSync(join(app, 'test', 'fixture'), root, { recursive: true });
  // An open instance of a series of its own, whose agent asks its runner, the admin, for a sign-off.
  const tree = JSON.parse(readFileSync(join(root, '.rf', 'tree.json'), 'utf8')), signed = join(root, 'instances', 'a5c0ff5e1f00');
  tree.series.a5c0ff5e1fee = { name: 'Year-end pack', workspace: '1b3031035ff6' };
  writeFileSync(join(root, '.rf', 'tree.json'), JSON.stringify(tree));
  mkdirSync(join(root, 'series', 'a5c0ff5e1fee'));
  mkdirSync(join(signed, 'working'), { recursive: true });
  writeFileSync(join(signed, 'instance.json'), JSON.stringify({ label: '2026-12', series: 'a5c0ff5e1fee' }));
  writeFileSync(join(signed, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
  writeFileSync(join(signed, 'log.jsonl'), [
    { seq: 1, at: '2026-08-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: [] },
    { seq: 2, at: '2026-08-01T09:05:00.000Z', by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'The pack is ready to send to the bank.', ask: true, signoff: true },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  // A closed instance of the same series, with its review sheet, whose run, asked to, called a connection and added a rule to its
  // process.
  const called = join(root, 'instances', 'a5c0ff5e1f01');
  mkdirSync(join(called, 'working'), { recursive: true });
  writeFileSync(join(called, 'instance.json'), JSON.stringify({ label: '2026-11', series: 'a5c0ff5e1fee' }));
  writeFileSync(join(called, 'screen.json'), JSON.stringify({ rev: 1, status: 'closed', items: [{ id: 'review', name: 'Review sheet', kind: 'output', file: 'working/review.md' }] }));
  writeFileSync(join(called, 'working', 'review.md'), '2 need you: C12, C15\n\nThe ledger is off by 4.00.\n');
  writeFileSync(join(called, 'working', 'process.md'), 'The year-end pack for the bank.\n- Read the ledger; never write to it.\n');
  writeFileSync(join(called, 'working', 'months.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(join(called, 'working', 'ledger.csv'), 'month,total\n');
  writeFileSync(join(called, 'log.jsonl'), [
    { seq: 1, at: '2026-08-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: ['adb:adb-1.azuredatabricks.net/wh1'] },
    { seq: 2, at: '2026-08-01T09:00:30.000Z', by: 'admin@demo.test', op: 'comment', thread: 'c9', item: null, ref: null, text: 'Read the ledger, and only read it.' },
    { seq: 3, at: '2026-08-01T09:01:00.000Z', by: 'server', op: 'run', run: 1, upto: 2, skills: {} },
    { seq: 4, at: '2026-08-01T09:02:00.000Z', by: 'agent', op: 'call', run: 1, name: 'adb', method: 'POST', path: '/api/2.0/sql/statements', status: 200, bytes: 512 },
    { seq: 5, at: '2026-08-01T09:03:00.000Z', by: 'agent', op: 'call', run: 1, name: 'adb', method: 'POST', path: '/api/2.0/sql/statements', status: 403, bytes: 0, refused: 'adb:adb-1.azuredatabricks.net/wh9 is not ticked for this instance; its runner, admin@demo.test, ticks logins when starting or taking it over' },
    { seq: 6, at: '2026-08-01T09:04:00.000Z', by: 'server', op: 'done', run: 1, aborted: false, seen: 5, cost: 0.01, summary: 'Read the ledger.', rules: 1, thread: 'c9' },
    { seq: 7, at: '2026-08-01T09:04:30.000Z', by: 'agent', op: 'comment', thread: 'c10', item: null, ref: null, text: 'The ledger by month.', files: [{ inst: 'a5c0ff5e1f01', path: 'working/months.png' }, { inst: 'a5c0ff5e1f01', path: 'working/ledger.csv' }] },
    { seq: 8, at: '2026-08-01T09:05:00.000Z', by: 'admin@demo.test', op: 'close' },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch') };
  mkdirSync(env.HOME!);
  delete env.OPENROUTER_API_KEY;
  const probe = createServer();
  await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  entra = await idp();
  Object.assign(env, entra.env(`http://127.0.0.1:${port}`), { RF_ADMINS: 'admin@demo.test' });
  proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('dialog', d => { native.push(d.message()); d.dismiss(); });
  entra.who.as = 'admin@demo.test';
  await page.goto(`http://127.0.0.1:${port}/auth/login`);
  await page.waitForSelector('#bar h1 .t'); // once the start's kick of the open instance has passed
});

after(async () => {
  await browser.close();
  if (process.platform === 'win32') proc.kill();
  else process.kill(-proc.pid!, 'SIGTERM');
  await once(proc, 'exit');
  entra.close();
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
  await page.waitForSelector('.row.ser.on .l:text-is("Weekly BB")');
  await page.fill('#sname', 'Weekly borrowing base');
  await page.press('#sname', 'Enter');
  await page.waitForSelector('#pv .saved:text-is("Saved")');
  await page.waitForSelector('.row.ser.on .l:text-is("Weekly borrowing base")');
  const ws = /^Let (.+) wake this series$/.exec((await page.textContent('#pv [data-act=share-arm]'))!)![1];
  await page.click('#pv [data-act=share-arm]');
  assert.deepEqual([await page.textContent('#pv .warn h3'), await page.textContent('#pv [data-act=share-on]'), await page.textContent('#pv .warn .consent')], ['Credentials', `Allow ${ws} to wake this series`,
    `By allowing, people in ${ws} and their agents can wake this series: start or continue its instances, with a short reason, and add notes and files. Those runs act as you, using the selected credentials, and do the series' usual work.`]);
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
  assert.deepEqual(await page.locator('.row.grp ~ a.row.inst .l').allTextContents(), ['Zebra crossing survey', 'Apple orchard audit for 2026']);
  await page.waitForSelector('#bar .state .bad:text("Run 1 failed")');
  await page.click('#bar [data-act=close]');
  await page.fill('#ask input', 'Zebra surveys');
  await page.click('#ask button:text-is("Start series and close")');
  await page.waitForSelector('.row.ser .l:text-is("Zebra surveys")');
  assert.deepEqual(await page.locator('.row.ser .l').allTextContents(), ['Zebra surveys', 'Weekly borrowing base', 'Year-end pack'], 'series too come newest activity first');
  assert.deepEqual(await page.locator('.row.grp ~ a.row.inst .l').allTextContents(), ['Apple orchard audit for 2026']);
});

test("only the runner abandons, from the Close dialog, whose buttons for a task weigh the same, the series' name with the one that makes it", async () => {
  await page.click('.row.ser .l:text-is("Weekly borrowing base")');
  await page.waitForSelector('#bar [data-act=takeover]');
  assert.deepEqual([await page.locator('#bar .btn').allTextContents(), await page.textContent('#bar .state'), await page.locator('#bar .creds').count()], [['Take over'], 'Waiting for files· no wake', 0], 'alex runs it');
  await page.click('#bar .state [data-act=wakes]');
  assert.equal(await page.textContent('#pv .pvh b'), 'Wakes of 2026-09-06 b', 'anyone in its workspace sets its wakes');
  await page.mouse.click(5, 5);
  await page.click('[data-act=takeover]');
  await page.click('[data-act=start-go]');
  await page.click('#bar .creds:text-is("Credentials: none")');
  await page.waitForSelector('#pv .pvh b:text-is("Credentials")');
  await page.mouse.click(5, 5);
  await page.click('#bar [data-act=close]');
  assert.deepEqual(await page.locator('#ask button').allTextContents(), ['Abandon instead', 'Close instance', 'Cancel']);
  await page.click('#ask button:text-is("Cancel")');
  assert.match(await page.textContent('#bar .state') ?? '', /Waiting for files/);
  await page.click('#bar [data-act=close]');
  await page.click('#ask button:text-is("Abandon instead")');
  await page.waitForSelector('#bar .state:text("Abandoned")');
  await page.click('.row.grp ~ a.row.inst .l:text-is("Apple orchard audit for 2026")');
  await page.click('#bar [data-act=close]');
  assert.deepEqual(await page.$$eval('#ask .opt, #ask .abandon', os => os.map(o => [o.querySelector('button')!.className, o.textContent])), [
    ['btn commit', 'Close taskcloses it as a one-off'], ['btn commit', 'Start series and closethis task becomes its first instance, an example for later ones'],
    ['quiet', "Abandon instead: it stays as it is, but isn't an example or a starting point."]]);
  assert.equal(await page.locator('#ask .opts input').inputValue(), 'Apple orchard audit for 2026', "the series' name goes with its button");
  await page.click('#ask button:text-is("Cancel")');
  assert.deepEqual(native, [], "the browser's own dialogs never show");
});

test("the side panel is the instance's conversation, a run a line among its threads, or its audit, by the switch at its top: the log and the agent's steps, a plain line each", async () => {
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#bar h1 .t:text-is("2026-08-30")');
  await page.waitForSelector('#log.open .seg .sel:text-is("Conversation")');
  assert.equal(await page.getAttribute('#bar [data-act=panel]', 'title'), 'Close the conversation', 'one toggle, in the bar, open or closed');
  const run = page.locator('#log details.runl');
  assert.equal(await run.locator('summary').innerText(), 'Run 1 · done · 4m 0s · $0.21');
  assert.match(await run.locator('.post').innerText(), /^Borrowing base for 08-30: excess 180,542\.50/, 'the latest run open to its report');
  assert.equal(await page.locator('#audit').isVisible(), false);
  await page.click('#log .seg [data-act=audit]');
  await page.waitForSelector('#audit .e');
  assert.deepEqual([await page.textContent('#log .seg .sel'), await page.locator('#conv').isVisible()], ['Audit', false], 'in place of the conversation');
  const rows = await page.locator('#audit .e > div').evaluateAll(es => es.map(e => (e as HTMLElement).innerText.split('\n')[0]));
  assert.deepEqual([...rows.slice(0, 4), rows.at(-1)], ['alex opened the instance', 'alex uploaded an input', 'Server showed u2', 'Run 1 started', 'alex closed the instance']);
  assert.ok(rows.includes('Run 1 finished · 4m 0s · $0.21') && rows.includes("alex's agent set up Borrowing base"), 'each entry a line');
  assert.ok(rows.includes("alex's agent said Borrowing base for 08-30: excess 180,542.50, up 6,742.50."), "and the agent's session");
  await page.click('#log .seg [data-act=audit]');
  assert.equal(await page.locator('#audit').isVisible(), false);
  await page.click('#bar [data-act=panel]');
  await page.waitForSelector('#log:not(.open)', { state: 'attached' });
  assert.equal(await page.getAttribute('#bar [data-act=panel]', 'title'), 'Open the conversation');
  await page.click('#bar [data-act=panel]');
  await page.waitForSelector('#log.open .seg .sel:text-is("Conversation")');
});

test("the runner sees the review sheet, its verdict first, and the process, open; a thread whose entry started a run that added a rule says so, opening the process; the run's calls to a connection are in the audit, a refusal with why", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f01'; });
  await page.waitForSelector('#log details[data-key=review][open]');
  assert.equal(await page.locator('#log details[data-key=review] summary').innerText(), 'Review sheet · 2 need you: C12, C15');
  assert.equal(await page.locator('#log details[data-key=review] .post').innerText(), 'The ledger is off by 4.00.');
  assert.equal(await page.locator('#log details[data-key=process]').evaluate(d => (d as HTMLDetailsElement).open), true);
  await page.click('#log details[data-key=process] > summary');
  const shown = page.locator('#log .thread[data-thread=c10] .post .f');
  assert.deepEqual(await shown.evaluateAll(fs => fs.map(f => f.querySelector('img')?.getAttribute('src') ?? f.textContent)), ['/files/a5c0ff5e1f01/working/months.png', 'ledger.csv'], 'an image shows in the thread, any other file as its name');
  await shown.locator('img').click();
  await page.waitForSelector('#pv img');
  await page.keyboard.press('Escape');
  const note = page.locator('#log .thread[data-thread=c9] .pnote');
  assert.equal(await note.innerText(), 'Process: +1 rule in run 1');
  await note.locator('a').click();
  await page.waitForSelector('#log details[data-key=process][open]');
  await page.click('#log [data-act=audit]');
  const calls = page.locator('#audit .e', { hasText: 'called adb' });
  await calls.first().waitFor();
  const [ok, refused] = await calls.locator('> div').allInnerTexts();
  assert.equal(ok, 'Your agent called adb: POST /api/2.0/sql/statements');
  assert.match(refused, /^Your agent called adb: POST \/api\/2\.0\/sql\/statements, refused/);
  assert.equal(await calls.last().locator('.d').innerText(), 'adb:adb-1.azuredatabricks.net/wh9 is not ticked for this instance; its runner, admin@demo.test, ticks logins when starting or taking it over');
  await page.click('#log .seg [data-act=audit]');
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
  assert.deepEqual(await widths(), [256, 352]);
  await drag('side', 100);
  await drag('panel', -150);
  assert.deepEqual(await widths(), [356, 502]);
  await drag('side', 1000);
  assert.deepEqual(await widths(), [384, 502], 'the sidebar takes at most 30% of the window');
  await page.reload();
  await page.waitForSelector('#log.open');
  assert.deepEqual(await widths(), [384, 502]);
  await page.dblclick('.grip[data-pane=side]');
  await page.dblclick('.grip[data-pane=panel]');
  assert.deepEqual(await widths(), [256, 352]);
});

test("what the session names, such as a tool call's name, shows as text in the audit, never as markup", async () => {
  appendFileSync(join(root, 'instances', '3d70f7ca6f20', 'session', 'main.jsonl'), JSON.stringify({ type: 'message', id: 'x1', parentId: 'm2', timestamp: '2026-08-30T23:03:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: '<img src=x onerror="window.pwned=1">', arguments: {} }] } }) + '\n');
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#log.open');
  await page.click('#log [data-act=audit]');
  await page.locator('#audit .e', { hasText: '<img src=x onerror="window.pwned=1">' }).waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
  await page.click('#log .seg [data-act=audit]');
});

test("a sign-off the agent asks for shows louder, above the instance and in its thread, with Approve and Reject for its runner; approving commits the folder, as the thread and the audit say", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#log.open');
  await page.locator('#needs', { hasText: 'The pack is ready to send to the bank.' }).waitFor();
  assert.equal(await page.locator('#needs').innerText(), 'Sign-off\nThe pack is ready to send to the bank.\nReview');
  const thread = page.locator('#log .thread.waits.signoff');
  await thread.waitFor();
  assert.equal(await page.textContent('#bar .ptog .badge'), String(await page.locator('#log .thread.waits').count()), "the panel's toggle counts what waits there");
  assert.match(await thread.locator('.on').innerText(), /waits on your sign-off/);
  assert.deepEqual(await thread.locator('button').allInnerTexts(), ['Approve', 'Reject']);
  await thread.locator('textarea').fill('Looks right.');
  await thread.locator('[data-act=signoff][data-ok]').click();
  const post = page.locator('#log .thread .post', { hasText: 'Signed off: Looks right.' });
  await post.waitFor();
  assert.match(await post.locator('.tm').innerText(), /commit [0-9a-f]{7}/);
  await page.waitForSelector('#needs', { state: 'hidden' });
  await page.click('#log [data-act=audit]');
  await page.locator('#audit .e', { hasText: 'You signed off' }).waitFor();
  await page.click('#log .seg [data-act=audit]');
});

test("people show by name, with their email on hover, and Entra groups by label; adding to a workspace suggests people by name and takes a group's label", async () => {
  const bob = 'bob@demo.test', group = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', url = (path: string) => new URL(path, page.url()).href;
  const signin = await entra.signIn(new URL(page.url()).origin, bob);
  const bobs = signin.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  await page.reload();
  await page.hover('.row.ws');
  await page.click('.row.ws [data-act=workspace-settings]');
  assert.deepEqual(await page.locator('#known option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value)), ['Demo Admin <admin@demo.test>', 'Bob <bob@demo.test>']);
  await page.fill('#wperson', 'Bob <bob@demo.test>');
  await page.click('[data-act=wadd]');
  await page.waitForSelector(`#pv .ut span[title="${bob}"]:text-is("Bob")`);
  await page.fill('#wperson', `Finance HK <${group}>`);
  await page.click('[data-act=wadd]');
  await page.waitForSelector(`#pv .ut span[title="${group}"]:text-is("Finance HK")`);
  await page.mouse.click(5, 5);
  assert.equal((await fetch(url('/api/instances/a5c0ff5e1f00/comment'), { method: 'POST', body: JSON.stringify({ text: 'The bank wants it by Friday.' }), headers: { cookie: bobs } })).status, 200);
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector(`#log .thread .post b.p span[title="${bob}"]:text-is("Bob")`);
  assert.equal(await page.locator('#needs').innerText(), 'Note\nThe bank wants it by Friday.\nReply');
  await page.click('#log [data-act=audit]');
  await page.locator('#audit .e', { hasText: 'Bob left a note for you' }).waitFor();
  await page.click('#log .seg [data-act=audit]');
  const long = `Wide${'_'.repeat(400)}`;
  assert.equal((await fetch(url('/api/instances/a5c0ff5e1f00/comment'), { method: 'POST', body: JSON.stringify({ text: long }), headers: { cookie: bobs } })).status, 200);
  await page.waitForSelector(`#needs span:text-is("${long}")`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#needs, #log')].map(e => e.scrollWidth <= e.clientWidth).concat([...document.querySelectorAll('#needs .btn')].map(b => b.getBoundingClientRect().right <= document.querySelector('#needs')!.getBoundingClientRect().right))), [true, true, true, true], 'a long line ends in an ellipsis, and its Reply shows; the panel keeps its width');
});

test("the conversation reads as a chat: its folds at the top, then oldest first, a run below the comment that started it and a thread where its last post is, and the box to comment at the panel's foot; it opens at the latest and keeps there as posts come, unless the reader has scrolled up", async () => {
  const url = (path: string) => new URL(path, page.url()).href, signin = await entra.signIn(new URL(page.url()).origin, 'bob@demo.test');
  const bobs = signin.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  const note = async (text: string, thread?: string) => {
    assert.equal((await fetch(url('/api/instances/a5c0ff5e1f00/comment'), { method: 'POST', body: JSON.stringify({ text, thread }), headers: { cookie: bobs } })).status, 200);
    await page.locator('#log .thread', { hasText: text }).waitFor();
  };
  const order = () => page.$$eval('#conv > *', es => es.map(e => (e as HTMLElement).dataset.key ?? (e as HTMLElement).dataset.thread ?? e.className));
  const where = () => page.$eval('#log', l => [l.scrollTop + l.clientHeight >= l.scrollHeight - 1 ? 'latest' : l.scrollTop === 0 ? 'top' : 'between',
    Math.round(l.querySelector('.compose')!.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom) + 0]);
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f01'; });
  await page.waitForSelector('#bar h1 .t:text-is("2026-11")');
  await page.waitForSelector('#log details[data-key=review][open]');
  assert.deepEqual(await order(), ['review', 'process', 'c9', 'runl', 'c10', 'compose']);
  assert.deepEqual(await where(), ['latest', 0]);
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#bar h1 .t:text-is("2026-12")');
  await page.waitForSelector('#newcomment');
  await note('First, the ledger.');
  const first = await page.locator('#log .thread', { hasText: 'First, the ledger.' }).getAttribute('data-thread');
  await note('Then the bank.');
  assert.deepEqual(await where(), ['latest', 0], 'kept at the latest as posts come');
  await note('The ledger is in.', first!);
  assert.deepEqual((await order()).slice(-2), [first, 'compose'], 'a reply takes its thread to the foot');
  await page.evaluate(() => new Promise(ok => { const l = document.querySelector('#log')!; l.addEventListener('scroll', ok, { once: true }); l.scrollTop = 0; }));
  await note('Friday at the latest.');
  assert.deepEqual(await where(), ['top', 0], 'scrolled up, the reader stays where they are, the box still at the foot');
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("a name two people share shows with their email, a group among a workspace's people is marked as one, and a person's request to start a series names them", async () => {
  const bob = 'bob@demo.test', users = join(root, '.rf', 'users.json'), group = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  writeFileSync(join(root, '.rf', 'wakes.json'), JSON.stringify({ pending: {}, fired: {}, requests: { r9: { series: 'a5c0ff5e1fee', label: '2027-01', from: bob, at: new Date().toISOString() } } }));
  await page.reload();
  await page.click('[data-act=waiting]');
  await page.waitForSelector(`#pv .wt span[title="${bob}"]:text-is("Bob")`);
  writeFileSync(users, JSON.stringify({ ...JSON.parse(readFileSync(users, 'utf8')), 'bob2@demo.test': { role: 'user', name: 'Bob' } }));
  await page.reload();
  await page.click('[data-act=waiting]');
  await page.waitForSelector(`#pv .wt span[title="${bob}"]:text-is("Bob <${bob}>")`);
  await page.mouse.click(5, 5);
  await page.hover('.row.ws');
  await page.click('.row.ws [data-act=workspace-settings]');
  await page.waitForSelector(`#pv .ut td:has(span[title="${bob}"]:text-is("Bob <${bob}>"))`);
  assert.equal(await page.locator(`#pv .ut td:has(span[title="${group}"])`).innerText(), 'Finance HK · group');
});

test("Logins shows what needs you first, then a line for each kind, Microsoft 365's sources and the websites opening in place; ticks go by kind, Microsoft 365's sources under a tick of their own, an expired login's flagged and off", async () => {
  const rf = join(root, '.rf'), mine = join(rf, 'people', createHash('sha256').update('admin@demo.test').digest('hex').slice(0, 16));
  writeFileSync(join(rf, 'connections.json'), JSON.stringify({ graph: { type: 'graph' }, adb: { type: 'databricks' }, portal: { type: 'website', url: 'https://portal.test/', hosts: [] }, wiki: { type: 'website', url: 'https://wiki.test/', hosts: [] } }));
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'logins.json'), JSON.stringify([
    { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: 'admin@demo.test', since: '2026-11-01T00:00:00Z', offers: [{ id: 'm365:onedrive', name: 'OneDrive' }, { id: 'm365:site:s1', name: 'SharePoint Reports' }] },
    { id: 'adb', kind: 'databricks', name: 'Databricks adb', since: '2026-11-01T00:00:00Z', offers: [{ id: 'adb:adb-1.azuredatabricks.net/wh1', name: 'Warehouse Finance, adb-1.azuredatabricks.net' }], expired: true },
    { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-11-02T00:00:00Z', offers: [{ id: 'web:portal', name: 'portal' }] },
  ]));
  const lines = () => page.$$eval('#pv .lline', ls => ls.map(l => [...l.children].map(c => (c as HTMLElement).innerText.trim()).join(' | ')));
  await page.evaluate(() => openLogins());
  await page.waitForSelector('#pv .lline');
  assert.deepEqual((await page.$$eval('#pv h3', hs => hs.map(h => h.textContent))), ['Needs you', 'All']);
  const all = await lines();
  assert.equal(all[0], 'Databricks adb | expired | Sign in again', 'first, what needs you');
  assert.match(all.slice(1).join('\n'), /^Microsoft 365 \| Demo Admin · since .+ · 2 sources \| Show ▸\nDatabricks adb \| expired · 1 warehouse \| Show ▸\nWebsites \| 1 of 2 signed in \| Show ▸\nModel key \| the server's \| Add mine$/);
  await page.click('#pv [data-act=logins-show][data-id=m365]');
  assert.deepEqual(await page.$$eval('#pv .lsub', rs => rs.map(r => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim())), ['OneDrive Remove', 'SharePoint Reports Remove']);
  await page.click('#pv [data-act=logins-show][data-id=adb]');
  assert.deepEqual((await page.$$eval('#pv .lsub', rs => rs.map(r => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))).slice(2), ['Warehouse Finance, adb-1.azuredatabricks.net Remove'], "Databricks' warehouses, as Microsoft 365's sources");
  await page.click('#pv [data-act=logins-show][data-id=adb]');
  await page.click('#pv [data-act=logins-show][data-id=web]');
  assert.match((await page.$$eval('#pv .lsub', rs => rs.map(r => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))).slice(2).join('\n'), /^portal portal\.test · since .+ Sign in again Sign out\nwiki wiki\.test Sign in$/);
  await page.mouse.click(5, 5);

  await page.evaluate(() => openStart('New instance', 'Start', () => {}, '', ['m365:onedrive', 'adb:adb-1.azuredatabricks.net/wh1']));
  await page.waitForSelector('#pv details.tgroup');
  const ticks = () => page.$$eval('#pv input.tick, #pv input.tickall', ts => ts.map(t => `${(t as HTMLInputElement).value === 'on' ? 'all' : (t as HTMLInputElement).value}:${(t as HTMLInputElement).checked}`));
  assert.deepEqual(await ticks(), ['all:false', 'm365:onedrive:true', 'm365:site:s1:false', 'adb:adb-1.azuredatabricks.net/wh1:false', 'web:portal:false'], 'the expired login unticked');
  assert.equal(await page.$eval('#pv details.tgroup', d => (d as HTMLDetailsElement).open), true, 'open while some of its sources are ticked and some not');
  assert.match(await page.locator('#pv .tkind', { hasText: 'Databricks' }).innerText(), /^Databricks\s+Warehouse Finance, adb-1\.azuredatabricks\.net\s+expired$/);
  await page.click('#pv details.tgroup summary .tickall');
  assert.deepEqual((await ticks()).slice(0, 3), ['all:true', 'm365:onedrive:true', 'm365:site:s1:true'], "the group's tick ticks its sources");
  await page.click('#pv details.tgroup input[value="m365:onedrive"]');
  assert.deepEqual((await ticks()).slice(0, 3), ['all:false', 'm365:onedrive:false', 'm365:site:s1:true'], 'and follows them');
  assert.deepEqual([await page.locator('#pv h3').allTextContents(), await page.textContent('#pv .consent')], [['Label', 'Credentials'], 'By clicking Start, you agree that agents carry these credentials while acting as you.']);
  await page.mouse.click(5, 5);
  rmSync(join(rf, 'connections.json'));
  rmSync(mine, { recursive: true });
});

test("while a run's browser is open it plays in a corner of the instance, to watch: one website at a time, folded as the person last left it, and Stop browser interrupts the run", async () => {
  let browsers = ['portal', 'bank'];
  const stops: string[] = [], at = '**/api/instances/a5c0ff5e1f00';
  await page.route(at, async r => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...await res.json(), run: browsers.length ? { n: 3, cost: 0.1, browsers } : null } });
  });
  await page.route('**/runs/**', r => r.fulfill({ contentType: 'text/html', body: 'watching' }));
  await page.route(`${at}/interrupt`, r => (stops.push(r.request().method()), r.fulfill({ body: 'ok' })));
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f01'; });
  await page.waitForSelector('#player', { state: 'hidden' });
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  const player = page.locator('#player'), src = () => player.locator('iframe').getAttribute('src');
  await player.locator('iframe').waitFor();
  assert.deepEqual([await src(), await player.locator('.seg button').allInnerTexts()], ['/runs/a5c0ff5e1f00/portal/view?watch', ['portal', 'bank']]);
  await player.locator('[data-site=bank]').click();
  assert.equal(await src(), '/runs/a5c0ff5e1f00/bank/view?watch');
  await player.locator('[data-act=player]').click();
  assert.equal(await player.locator('iframe').count(), 0, 'folded');
  await page.reload();
  await player.locator('.plh').waitFor();
  assert.equal(await player.locator('iframe').count(), 0, 'still folded, as this browser remembers');
  await player.locator('[data-act=player]').click();
  await player.locator('iframe').waitFor();
  browsers = [];
  await player.locator('[data-act=interrupt]').click();
  await player.waitFor({ state: 'hidden' });
  assert.deepEqual(stops, ['POST'], 'Stop browser is the Interrupt');
  for (const url of [at, '**/runs/**', `${at}/interrupt`]) await page.unroute(url);
});

test("a picture pasted into a comment, or a reply, goes with it, shown under the box until it's sent, a screenshot named for when it was pasted; pasted text stays text", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#newcomment');
  const paste = (at: string, text = '') => page.evaluate(([at, text]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    if (text) dt.setData('text/plain', text);
    document.querySelector(at)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [at, text]);
  const names = (at: string) => page.evaluate(at => [...(document.querySelector(at) as HTMLInputElement).files!].map(f => f.name), at);
  await paste('#newcomment', 'Cells, as text');
  assert.deepEqual(await names('#newfiles'), [], 'text pastes as text');
  await paste('#newcomment');
  assert.match((await names('#newfiles')).join(), /^screenshot \d\d-\d\d-\d\d\.png$/);
  await page.waitForSelector('#newfiles + .thumbs img');
  const reply = '#log .thread textarea[placeholder=Reply]';
  await paste(reply);
  assert.match((await names(`${reply} + input[type=file]`)).join(), /^screenshot /, "a reply's too");
  await page.evaluate(at => { const i = document.querySelector(at) as HTMLInputElement; i.files = new DataTransfer().files; i.dispatchEvent(new Event('change', { bubbles: true })); }, `${reply} + input[type=file]`);
  await page.fill('#newcomment', 'As on screen.');
  await page.click('[data-act=comment]');
  await page.waitForSelector('#log .thread .post .f img[alt^="screenshot "]');
});

test('a task closed as a one-off starts a series later, by its name alone, as its only instance', async () => {
  await page.hover('.row.ws.on');
  await page.click('.row.ws.on [data-act=new-task]');
  await page.waitForSelector('#bar h1 .t:text-is("Untitled")');
  await page.keyboard.type('Quarterly stock count');
  await page.click('[data-act=comment]');
  await page.waitForSelector('#bar .state .bad:text("Run 1 failed")');
  await page.click('#bar [data-act=close]');
  await page.click('#ask button:text-is("Close task")');
  await page.click('#bar [data-act=start-series]');
  await page.fill('#ask input', 'Stock counts');
  await page.click('#ask button:text-is("Start series")');
  await page.waitForSelector('.row.ser .l:text-is("Stock counts")');
  await page.waitForSelector('#bar [data-act=duplicate]');
  assert.deepEqual(await page.evaluate(() => tree.flatMap(w => w.series).filter(s => s.name === 'Stock counts').map(s => [s.single, s.instances.map(i => i.status)])), [[false, ['closed']]], 'no instance starts');
});

test("a closed instance is read with its corrections: one added on an item's card shows in a strip above it, on the item's tile, in the sidebar and in the audit", async () => {
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#bar h1 .t:text-is("2026-08-30")');
  assert.equal(await page.locator('#corrs').isVisible(), false);
  await page.click('.tile .fn:text-is("AR aging")');
  await page.click('#card [data-act=correct]');
  await page.fill('#cref', 'C12');
  await page.selectOption('#csee', { index: 1 });
  const see = await page.$eval('#csee', s => (s as HTMLSelectElement).selectedOptions[0].textContent);
  await page.fill('#ctext', 'The rate was 5%, not 4%.');
  await page.click('#ask button:text-is("Add correction")');
  await page.waitForSelector('#corrs:not([hidden])');
  assert.deepEqual(await page.locator('#corrs').innerText().then(t => t.split('\n').slice(0, 2)), ['Read with corrections (1)', `AR aging at C12 is wrong: The rate was 5%, not 4%. · see ${see}`]);
  assert.match(await page.locator('.tile:has(.fn:text-is("AR aging")) .ext').innerText(), /Corrected/);
  assert.equal(await page.textContent('.row.inst.on .corr'), 'corrected');
  await page.click('#log .seg [data-act=audit]');
  await page.locator('#audit .e', { hasText: 'marked AR aging at C12 wrong' }).waitFor();
  await page.click('#log .seg [data-act=audit]');
  assert.equal(await page.locator('#conv [data-act=correct]').count(), 1, 'the instance itself takes one from the conversation');
  await page.evaluate(() => api('/api/instances/a5c0ff5e1f01/correct', { method: 'POST', body: JSON.stringify({ kind: 'wrong', text: 'The ledger total was off.' }) }));
  await page.evaluate(() => refresh());
  await page.click('[data-act=waiting]');
  await page.locator('.wt', { hasText: "2026-11: 1 correction says it's wrong" }).waitFor();
});

test("a sheet shows as its workbook does: number formats, bold, colours, column widths and merged cells, without its hidden rows and columns", async () => {
  await page.evaluate(() => location.hash === '#/a5c0ff5e1f00' || new Promise(ok => { addEventListener('hashchange', ok, { once: true }); location.hash = '#/a5c0ff5e1f00'; }));
  await page.waitForSelector('#log.open');
  await page.route('**/preview/**', r => r.fulfill({ json: new URL(r.request().url()).searchParams.get('sheet') === '1' ? { name: 'Notes', truncated: false, rows: [['later']] } : { sheets: [{
    name: 'Summary', at: 0, truncated: false, rows: [['Month', 'Total', 'Hidden', 'Delta'], ['Aug', 1234.5, 1, -1500.5], ['Sep', 2, 3, 4], ['merged']],
    look: { '0,0': { b: true }, '0,1': { bg: '#FFFF00', fg: '#C00000' }, '1,1': { t: '1,234.50' }, '1,3': { t: '(1,500.50)' } }, merged: [[3, 0, 3, 3]], widths: { 0: 20 }, hidden: { rows: [2], cols: [2] },
  }, { name: 'Notes', at: 1, state: 'hidden' }] } }));
  await page.evaluate(() => preview('working/formats.xlsx'));
  const table = page.locator('#pv table.sh');
  await table.waitFor();
  assert.deepEqual(await table.locator('tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent))),
    [['', 'A', 'B', 'D'], ['1', 'Month', 'Total', 'Delta'], ['2', 'Aug', '1,234.50', '(1,500.50)'], ['4', 'merged']]);
  assert.equal(await table.locator('td[colspan="3"]').textContent(), 'merged', 'across the columns that show');
  assert.deepEqual(await table.evaluate(t => [
    getComputedStyle(t.querySelector('[data-ref="Summary!A1"]')!).fontWeight, getComputedStyle(t.querySelector('[data-ref="Summary!B1"]')!).backgroundColor,
    getComputedStyle(t.querySelector('[data-ref="Summary!B1"]')!).color, (t.querySelector('col:nth-child(2)') as HTMLElement).style.width]), ['600', 'rgb(255, 255, 0)', 'rgb(192, 0, 0)', '145px']);
  await page.click('#pv .tabs .btn.dim:text-is("Notes")');
  await page.locator('#pv table.sh td', { hasText: 'later' }).waitFor();
  await page.unroute('**/preview/**');
  await page.keyboard.press('Escape');
});

test('an email previews in a frame that runs and loads nothing, and its attachments open in its place', async () => {
  await page.route('**/preview/**', r => r.fulfill({ json: new URL(r.request().url()).searchParams.get('attachment') === '1'
    ? { sheets: [{ name: 'Book', rows: [['in the attachment']], truncated: false }] }
    : { email: { headers: { Subject: 'Aging' }, html: '<p>Hello</p>', text: 'Hello', attachments: [{ name: 'book.xlsx', k: 1 }] } } }));
  await page.evaluate(() => preview('working/mail.eml'));
  const frame = page.locator('#pv iframe.mail');
  assert.deepEqual(await frame.evaluate(f => [f.getAttribute('sandbox'), f.getAttribute('srcdoc')!.includes("default-src 'none'")]), ['allow-popups allow-popups-to-escape-sandbox', true]);
  assert.equal(await page.frameLocator('#pv iframe.mail').locator('p').textContent(), 'Hello');
  await page.click('#pv [data-act=attachment]');
  await page.locator('#pv table.sh td', { hasText: 'in the attachment' }).waitFor();
  await page.click('#pv [data-act=attachment-back]');
  await frame.waitFor();
  await page.unroute('**/preview/**');
  await page.keyboard.press('Escape');
});

test("a PDF previews as its pages, each fetched as it comes into view", async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', asked: string[] = [];
  await page.route('**/preview/**', r => {
    const at = new URL(r.request().url()).searchParams.get('page');
    if (at) asked.push(at);
    return r.fulfill({ json: at ? { image: png } : { pdf: { pages: 3, shown: { 1: png } } } });
  });
  await page.evaluate(() => preview('working/pack.pdf'));
  await page.waitForSelector('#pv .pages img[data-page="2"][src]');
  assert.equal(await page.locator('#pv .pages img').count(), 3);
  assert.ok(!asked.includes('1'), 'the first came with the preview');
  await page.unroute('**/preview/**');
  await page.keyboard.press('Escape');
});

test('a Word document previews as its headings, paragraphs, lists and tables, and as LibreOffice lays it out on asking', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await page.route('**/preview/**', r => r.fulfill({ json: new URL(r.request().url()).searchParams.get('layout')
    ? { pdf: { pages: 1, shown: { 1: png } } } : { doc: [{ h: 1, text: 'Aging pack' }, { li: 'Over 90 days', level: 0 }, { table: [['Bucket', 'Amount']] }] } }));
  await page.evaluate(() => preview('working/pack.docx'));
  await page.waitForSelector('#pv .doc h1');
  assert.deepEqual(await page.locator('#pv .doc').evaluate(d => [...d.children].map(c => c.tagName + ' ' + c.textContent)), ['H1 Aging pack', 'P Over 90 days', 'TABLE BucketAmount']);
  await page.click('#pv [data-act=layout]');
  await page.waitForSelector('#pv .pages img[data-page="1"][src]');
  await page.unroute('**/preview/**');
  await page.keyboard.press('Escape');
});

test("an item's card shows its file's preview on a desktop, to scroll in place or open in full, with Download and Comment under it and no Upload", async () => {
  await page.evaluate(() => location.hash === '#/c0f4e4f28232' || new Promise(ok => { addEventListener('hashchange', ok, { once: true }); location.hash = '#/c0f4e4f28232'; }));
  await page.waitForSelector('#bar h1 .t:text-is("2026-08-23")');
  await page.click('.tile .fn:text-is("AR aging")');
  await page.waitForSelector('#card.wide .cpv table.sh td');
  assert.equal(await page.locator('#card .cpv table.sh tr').nth(1).locator('td').nth(1).textContent(), 'Customer');
  const acts = await page.locator('#card .acts .btn').allTextContents();
  assert.ok(acts.includes('Download') && !acts.includes('Preview') && !acts.includes('Upload…'), acts.join());
  await page.click('#card .full [data-act=preview]');
  await page.waitForSelector('#pv table.sh td');
  await page.keyboard.press('Escape');
  await page.click('#card [data-act=uncard]');
});

