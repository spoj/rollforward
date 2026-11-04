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
    { seq: 1, at: '2026-08-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: ['adb'] },
    { seq: 2, at: '2026-08-01T09:00:30.000Z', by: 'admin@demo.test', op: 'comment', thread: 'c9', item: null, ref: null, text: 'Read the ledger, and only read it.' },
    { seq: 3, at: '2026-08-01T09:01:00.000Z', by: 'server', op: 'run', run: 1, upto: 2, skills: {} },
    { seq: 4, at: '2026-08-01T09:02:00.000Z', by: 'agent', op: 'call', run: 1, name: 'adb', method: 'POST', path: '/api/2.0/sql/statements', status: 200, bytes: 512 },
    { seq: 5, at: '2026-08-01T09:03:00.000Z', by: 'agent', op: 'call', run: 1, name: 'adb', method: 'POST', path: '/api/2.0/sql/statements', status: 403, bytes: 0, refused: 'adb only reads: a statement starts with SELECT, not DROP' },
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
  await page.click('#ask button:text-is("Make it a series and close")');
  await page.waitForSelector('.row.ser .l:text-is("Zebra surveys")');
  assert.deepEqual(await page.locator('.row.ser .l').allTextContents(), ['Zebra surveys', 'Weekly borrowing base', 'Year-end pack'], 'series too come newest activity first');
  assert.deepEqual(await page.locator('.row.grp ~ a.row.inst .l').allTextContents(), ['Apple orchard audit for 2026']);
});

test('only the runner abandons, and abandoning asks first, in the page', async () => {
  await page.click('.row.ser .l:text-is("Weekly borrowing base")');
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

test("the side panel is the instance's conversation, a run a line among its threads; the audit, a drawer closed until asked for, has the log and the agent's steps, a plain line each", async () => {
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#log.open .lh b:text-is("Conversation")');
  assert.equal(await page.locator('#bar [data-act=show-panel]').count(), 0, 'the bar offers the panel only while it is closed');
  const run = page.locator('#log details.runl');
  assert.equal(await run.locator('summary').innerText(), 'Run 1 · done · 4m 0s · $0.21');
  assert.match(await run.locator('.post').innerText(), /^Borrowing base for 08-30: excess 180,542\.50/, 'the latest run open to its report');
  assert.equal(await page.locator('#audit').isVisible(), false);
  await page.click('#log [data-act=audit]');
  await page.waitForSelector('#audit .e');
  const rows = await page.locator('#audit .e > div').evaluateAll(es => es.map(e => (e as HTMLElement).innerText.split('\n')[0]));
  assert.deepEqual([...rows.slice(0, 4), rows.at(-1)], ['alex opened the instance', 'alex uploaded an input', 'Server showed u2', 'Run 1 started', 'alex closed the instance']);
  assert.ok(rows.includes('Run 1 finished · 4m 0s · $0.21') && rows.includes("alex's agent set up Borrowing base"), 'each entry a line');
  assert.ok(rows.includes("alex's agent said Borrowing base for 08-30: excess 180,542.50, up 6,742.50."), "and the agent's session");
  await page.click('#audit [data-act=audit]');
  assert.equal(await page.locator('#audit').isVisible(), false);
  await page.click('#log [data-act=hide-panel]');
  await page.click('#bar [data-act=show-panel]');
  await page.waitForSelector('#log.open .lh b:text-is("Conversation")');
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
  assert.equal(await calls.last().locator('.d').innerText(), 'adb only reads: a statement starts with SELECT, not DROP');
  await page.click('#audit [data-act=audit]');
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
  await page.click('#audit [data-act=audit]');
});

test("a sign-off the agent asks for shows louder, above the instance and in its thread, with Approve and Reject for its runner; approving commits the folder, as the thread and the audit say", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#log.open');
  assert.equal(await page.locator('#needs').innerText(), 'Sign-off\nThe pack is ready to send to the bank.\nReview');
  const thread = page.locator('#log .thread.waits.signoff');
  await thread.waitFor();
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
  await page.click('#audit [data-act=audit]');
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
  await page.click('#audit [data-act=audit]');
  const long = `Wide${'_'.repeat(400)}`;
  assert.equal((await fetch(url('/api/instances/a5c0ff5e1f00/comment'), { method: 'POST', body: JSON.stringify({ text: long }), headers: { cookie: bobs } })).status, 200);
  await page.waitForSelector(`#needs span:text-is("${long}")`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#needs, #log')].map(e => e.scrollWidth <= e.clientWidth).concat([...document.querySelectorAll('#needs .btn')].map(b => b.getBoundingClientRect().right <= document.querySelector('#needs')!.getBoundingClientRect().right))), [true, true, true, true], 'a long line ends in an ellipsis, and its Reply shows; the panel keeps its width');
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
  writeFileSync(join(rf, 'connections.json'), JSON.stringify({ graph: { type: 'graph' }, adb: { type: 'databricks', host: 'adb-1.test', warehouse: 'wh1' }, portal: { type: 'website', url: 'https://portal.test/', hosts: [] }, wiki: { type: 'website', url: 'https://wiki.test/', hosts: [] } }));
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'logins.json'), JSON.stringify([
    { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: 'admin@demo.test', since: '2026-11-01T00:00:00Z', offers: [{ id: 'm365:onedrive', name: 'OneDrive' }, { id: 'm365:site:s1', name: 'SharePoint Reports' }] },
    { id: 'adb', kind: 'databricks', name: 'Databricks adb', since: '2026-11-01T00:00:00Z', offers: [{ id: 'adb', name: 'Databricks adb, warehouse wh1' }], expired: true },
    { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-11-02T00:00:00Z', offers: [{ id: 'web:portal', name: 'portal' }] },
  ]));
  const lines = () => page.$$eval('#pv .lline', ls => ls.map(l => [...l.children].map(c => (c as HTMLElement).innerText.trim()).join(' | ')));
  await page.evaluate(() => openLogins());
  await page.waitForSelector('#pv .lline');
  assert.deepEqual((await page.$$eval('#pv h3', hs => hs.map(h => h.textContent))), ['Needs you', 'All']);
  const all = await lines();
  assert.equal(all[0], 'Databricks adb | expired | Sign in again', 'first, what needs you');
  assert.match(all.slice(1).join('\n'), /^Microsoft 365 \| Demo Admin · since .+ · 2 sources \| Show ▸\nDatabricks adb \| expired \| Sign out\nWebsites \| 1 of 2 signed in \| Show ▸\nModel key \| the server's \| Add mine$/);
  await page.click('#pv [data-act=logins-show][data-id=m365]');
  assert.deepEqual(await page.$$eval('#pv .lsub', rs => rs.map(r => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim())), ['OneDrive Remove', 'SharePoint Reports Remove']);
  await page.click('#pv [data-act=logins-show][data-id=web]');
  assert.match((await page.$$eval('#pv .lsub', rs => rs.map(r => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))).slice(2).join('\n'), /^portal portal\.test · since .+ Sign in again Sign out\nwiki wiki\.test Sign in$/);
  await page.mouse.click(5, 5);

  await page.evaluate(() => openStart('New instance', 'Start', () => {}, '', undefined, ['m365:onedrive', 'adb']));
  await page.waitForSelector('#pv details.tgroup');
  const ticks = () => page.$$eval('#pv input.tick, #pv input.tickall', ts => ts.map(t => `${(t as HTMLInputElement).value === 'on' ? 'all' : (t as HTMLInputElement).value}:${(t as HTMLInputElement).checked}`));
  assert.deepEqual(await ticks(), ['all:false', 'm365:onedrive:true', 'm365:site:s1:false', 'adb:false', 'web:portal:false'], 'the expired login unticked');
  assert.equal(await page.$eval('#pv details.tgroup', d => (d as HTMLDetailsElement).open), true, 'open while some of its sources are ticked and some not');
  assert.match(await page.locator('#pv .tkind', { hasText: 'Databricks' }).innerText(), /^Databricks\s+Databricks adb, warehouse wh1\s+expired$/);
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

