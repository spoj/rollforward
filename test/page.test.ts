import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
  // An open instance of a series of its own, whose agent asks its runner, the admin, to sign off the file it pins.
  const tree = JSON.parse(readFileSync(join(root, '.rf', 'tree.json'), 'utf8')), signed = join(root, 'instances', 'a5c0ff5e1f00');
  tree.series.a5c0ff5e1fee = { name: 'Year-end pack', workspace: '1b3031035ff6' };
  writeFileSync(join(root, '.rf', 'tree.json'), JSON.stringify(tree));
  mkdirSync(join(root, 'series', 'a5c0ff5e1fee'));
  mkdirSync(join(signed, 'working'), { recursive: true });
  writeFileSync(join(signed, 'instance.json'), JSON.stringify({ label: '2026-12', series: 'a5c0ff5e1fee' }));
  writeFileSync(join(signed, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
  writeFileSync(join(signed, 'working', 'pack.csv'), 'pack\n');
  writeFileSync(join(signed, 'log.jsonl'), [
    { seq: 1, at: '2026-08-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: [] },
    { seq: 2, at: '2026-08-01T09:05:00.000Z', by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'The pack is ready to send to the bank.\n\n[The pack](working/pack.csv)', ask: true },
    { seq: 3, at: '2026-08-01T09:10:00.000Z', by: 'server', op: 'run', run: 2, runner: 'admin@demo.test', upto: 1 },
    { seq: 4, at: '2026-08-01T09:12:00.000Z', by: 'server', op: 'done', run: 2, aborted: false, seen: 1, cost: 0 },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  // A closed instance of the same series whose run, asked to, called a connection, added a rule to its process and posted images.
  const called = join(root, 'instances', 'a5c0ff5e1f01');
  mkdirSync(join(called, 'working'), { recursive: true });
  writeFileSync(join(called, 'instance.json'), JSON.stringify({ label: '2026-11', series: 'a5c0ff5e1fee' }));
  writeFileSync(join(called, 'screen.json'), JSON.stringify({ rev: 1, status: 'closed', items: [] }));
  writeFileSync(join(called, 'working', 'process.md'), 'The year-end pack for the bank.\n- Read the ledger; never write to it.\n');
  writeFileSync(join(called, 'working', 'months.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(join(called, 'working', 'ledger.csv'), 'month,total\n');
  writeFileSync(join(called, 'log.jsonl'), [
    { seq: 1, at: '2026-08-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: ['adb:adb-1.azuredatabricks.net/wh1'] },
    { seq: 2, at: '2026-08-01T09:00:30.000Z', by: 'admin@demo.test', op: 'comment', thread: 'c9', item: null, ref: null, text: 'Read the ledger, and only read it.' },
    { seq: 3, at: '2026-08-01T09:01:00.000Z', by: 'server', op: 'run', run: 1, upto: 2, skills: {} },
    { seq: 4, at: '2026-08-01T09:02:00.000Z', by: 'agent', op: 'call', run: 1, name: 'adb', method: 'POST', path: '/api/2.0/sql/statements', status: 200, bytes: 512 },
    { seq: 5, at: '2026-08-01T09:03:00.000Z', by: 'agent', op: 'call', run: 1, name: 'adb', method: 'POST', path: '/api/2.0/sql/statements', status: 403, bytes: 0, refused: 'adb:adb-1.azuredatabricks.net/wh9 is not ticked for this instance; its runner, admin@demo.test, ticks logins when starting or taking it over' },
    { seq: 6, at: '2026-08-01T09:04:00.000Z', by: 'server', op: 'done', run: 1, aborted: false, seen: 5, cost: 0.01, rules: 1, thread: 'c9' },
    { seq: 7, at: '2026-08-01T09:04:30.000Z', by: 'agent', op: 'comment', thread: 'c10', item: null, ref: null, text: 'The ledger by month.\n\n| ![Ledger](working/months.png) | ![Months](../2026-11/working/months.png) |', files: [{ inst: 'a5c0ff5e1f01', path: 'working/months.png' }, { inst: 'a5c0ff5e1f01', path: 'working/ledger.csv' }] },
    { seq: 8, at: '2026-08-01T09:05:00.000Z', by: 'admin@demo.test', op: 'close' },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  // An open instance of the same series with two steps, notes in markdown and a tie-out.
  const reviewed = join(root, 'instances', 'a5c0ff5e1f02');
  mkdirSync(join(reviewed, 'working'), { recursive: true });
  writeFileSync(join(reviewed, 'instance.json'), JSON.stringify({ label: '2026-10', series: 'a5c0ff5e1fee' }));
  writeFileSync(join(reviewed, 'working', 'notes.md'), '2 checks pass\n\n- The ledger ties to the pack.\n- **Judgment:** the October accrual is carried at the September rate, as agreed with the controller.\n');
  writeFileSync(join(reviewed, 'working', 'tie.csv'), 'ledger,pack\n');
  writeFileSync(join(reviewed, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [
    { id: 'notes', name: 'Notes', kind: 'step', file: 'working/notes.md' }, { id: 'tie', name: 'Tie-out', kind: 'step', file: 'working/tie.csv' }] }));
  writeFileSync(join(reviewed, 'log.jsonl'), [
    { seq: 1, at: '2026-08-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: [] },
    { seq: 2, at: '2026-08-01T09:05:00.000Z', by: 'agent', op: 'comment', thread: 'c2', text: 'Review the October notes.' },
    // A note from the agent of 2026-12, for its runner.
    { seq: 3, at: '2026-08-01T09:06:00.000Z', by: 'agent', op: 'comment', thread: 'c3', item: null, ref: null, text: 'The pack went to the bank.', run: 2, runner: 'admin@demo.test', see: { inst: 'a5c0ff5e1f00', label: '2026-12', thread: 'c2' }, note: true },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  // A series of its own, quiet since July.
  const sampled = join(root, 'instances', 'a5c0ff5e1f05');
  tree.series.a5c0ff5e1fef = { name: 'Invoice checks', workspace: '1b3031035ff6' };
  writeFileSync(join(root, '.rf', 'tree.json'), JSON.stringify(tree));
  mkdirSync(join(root, 'series', 'a5c0ff5e1fef'));
  mkdirSync(join(sampled, 'working'), { recursive: true });
  writeFileSync(join(sampled, 'instance.json'), JSON.stringify({ label: '2026-07', series: 'a5c0ff5e1fef' }));
  writeFileSync(join(sampled, 'working', 'invoices.csv'), 'invoice,customer,amount\nINV-1,Acme,"1,500.00"\nINV-2,Bolt,200.00\nINV-3,Cask,300.00\nINV-4,Dune,(50.00)\nINV-5,Echo,400.00\n');
  writeFileSync(join(sampled, 'working', 'bb.csv'), 'total\n2350\n');
  writeFileSync(join(sampled, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [{ id: 'bb', name: 'Borrowing base', kind: 'output', file: 'working/bb.csv' },
    { id: 'invoices', name: 'Invoices', kind: 'step', file: 'working/invoices.csv' }] }));
  writeFileSync(join(sampled, 'log.jsonl'), JSON.stringify({ seq: 1, at: '2026-07-01T09:00:00.000Z', by: 'admin@demo.test', op: 'create', from: null, logins: [] }) + '\n');
  // A series of its own whose open instance's agent asks a question, proposes to send the pack, citing the closed one's comment, and
  // withdrew a question.
  tree.series.a5c0ff5e1ff0 = { name: 'Bank pack', workspace: '1b3031035ff6' };
  writeFileSync(join(root, '.rf', 'tree.json'), JSON.stringify(tree));
  mkdirSync(join(root, 'series', 'a5c0ff5e1ff0'));
  const october = [
    { by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'I will email the pack to the bank.', ask: 'proposal' },
    { by: 'bob@demo.test', op: 'comment', thread: 'c3', item: null, ref: null, text: 'Use the HSBC statement.' },
    { by: 'agent', op: 'delivered', item: 'pack', to: 'bank@demo.test', receipt: 'sent' },
    { by: 'admin@demo.test', op: 'close', accepted: ['c2'] },
  ];
  for (const [id, label, status, items, log] of [
    ['a5c0ff5e1f08', 'December', 'closed', [], [{ by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'Sent the pack on the 3rd.' }, { by: 'admin@demo.test', op: 'close' }]],
    ['a5c0ff5e1f07', 'January', 'open', [{ id: 'notes', name: 'Notes', kind: 'step', file: 'working/notes.md' }], [
      { by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'The pack is built.' },
      { by: 'agent', op: 'comment', thread: 'c3', item: null, ref: null, text: 'Which account does it go to? See c2.', ask: 'question' },
      { by: 'agent', op: 'comment', thread: 'c4', item: null, ref: null, text: 'I will send [the pack](working/pack.csv) to the bank, as [last month](../December#c2).', ask: 'proposal' },
      { by: 'agent', op: 'comment', thread: 'c5', item: null, ref: null, text: 'Is the rate final?', ask: 'question' },
      { by: 'agent', op: 'withdraw', thread: 'c5', on: 5, text: 'The file says so.', see: 2 },
    ]],
    // Closed with an accepted proposal, a note for its runner and a delivery, which a copy of it takes as history.
    ['a5c0ff5e1f0b', 'October', 'closed', [{ id: 'pack', name: 'Pack', kind: 'output', file: 'working/pack.csv' }], october],
    // Its copy, as earlier versions made one: its log, then a duplicate entry.
    ['a5c0ff5e1f0c', 'October copy', 'open', [{ id: 'pack', name: 'Pack', kind: 'output', file: 'working/pack.csv' }], [...october, { by: 'admin@demo.test', op: 'duplicate', from: 'October', logins: [] }]],
    ['a5c0ff5e1f09', 'November', 'closed', [], [{ by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'Sent it late.' }, { by: 'admin@demo.test', op: 'close' }]],
    ['a5c0ff5e1f0a', 'February', 'open', [], [
      { by: 'agent', op: 'comment', thread: 'c2', item: null, ref: null, text: 'I will send [the pack](working/pack.csv) to the bank, as [last month](../December#c2).', ask: 'proposal' },
      { by: 'agent', op: 'comment', thread: 'c3', item: null, ref: null, text: 'Is the rate final?', ask: 'question' },
      { by: 'agent', op: 'comment', thread: 'c3', parent: 3, text: 'Found it in the file: final.' },
      { by: 'agent', op: 'withdraw', thread: 'c3', on: 3, text: 'The file says so.', see: 4 },
      { by: 'agent', op: 'comment', thread: 'c6', item: null, ref: null, text: 'As [my proposal](#c2) says, and as [in November](../November#c2).' },
      { by: 'agent', op: 'comment', thread: 'c7', item: null, ref: null, text: 'Part 零件编号c2, R&c2, doc=c2, Sheet1!c3:c4, why?c2, a;c2 and https://portal/view?doc=c2, but see c2.' },
    ]],
  ] as const) {
    const dir = join(root, 'instances', id);
    mkdirSync(join(dir, 'working'), { recursive: true });
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ label, series: 'a5c0ff5e1ff0' }));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status, items }));
    writeFileSync(join(dir, 'working', 'pack.csv'), 'pack\n');
    writeFileSync(join(dir, 'working', 'notes.md'), 'As [the summary](#c2) says.\n');
    writeFileSync(join(dir, 'log.jsonl'), [{ by: 'admin@demo.test', op: 'create', from: null, logins: [] }, ...log]
      .map((e, i) => JSON.stringify({ seq: i + 1, at: `2026-07-02T09:0${i}:00.000Z`, ...e }) + '\n').join(''));
  }
  // A step between the fixture's 2026-08-30 input and output.
  const stepped = join(root, 'instances', '3d70f7ca6f20'), doc = JSON.parse(readFileSync(join(stepped, 'screen.json'), 'utf8'));
  writeFileSync(join(stepped, 'working', 'eligible.csv'), 'customer,amount\n');
  doc.items.find((i: { id: string }) => i.id === 'borrowing-base').from = ['eligible', 'inventory'];
  doc.items.push({ id: 'eligible', name: 'Eligible AR', kind: 'step', file: 'working/eligible.csv', from: ['ar-aging'] });
  writeFileSync(join(stepped, 'screen.json'), JSON.stringify(doc));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch') };
  mkdirSync(env.HOME!);
  delete env.OPENROUTER_API_KEY;
  delete env.RF_BROWSER_URL;
  const probe = createServer();
  await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  entra = await idp();
  Object.assign(env, entra.env(`http://127.0.0.1:${port}`), { RF_ADMINS: 'admin@demo.test', RF_DRAIN_MIN: '0.05' });
  proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('dialog', d => { native.push(d.message()); d.dismiss(); });
  // So a test that times out in CI shows what the page threw, such as a request the server refused.
  page.on('pageerror', e => console.error('page error:', e.message));
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

for (const kind of ['series', 'workspace']) test(`an archived ${kind} is read-only, including its settings, until restored`, async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  const target = kind === 'series' ? '/api/series/a5c0ff5e1fee' : '/api/workspaces/1b3031035ff6';
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f00', page.url()).href);
    await tab.waitForSelector('#bar h1 .t:text-is("2026-12")');
    await tab.fill('#newcomment', 'A draft before archiving');
    await tab.click('#conv .pa [data-act=reply]:text-is("Reply")');
    await tab.fill('#conv .reply:not([hidden]) textarea', 'A reply before archiving');
    const row = kind === 'series' ? '.row.ser.on' : '.row.ws.on';
    await tab.hover(row);
    await tab.click(`${row} [data-act=${kind === 'series' ? 'settings' : 'workspace-settings'}]`);
    await tab.click(`#pv [data-act=archive-${kind}]`);
    const confirmation = await tab.textContent('#ask');
    await tab.click('#ask button:text-is("Cancel")');
    assert.equal((await tab.request.put(new URL(target, tab.url()).href, { data: { archived: true } })).ok(), true);
    await tab.waitForSelector(`${row}.archived`);
    assert.equal(await tab.textContent('#bar .state'), 'Archived · read-only');
    assert.match(confirmation!, /Nothing in it changes or runs until it's restored, and its wakes, weekly ones too, and requests to start an instance are cancelled for good: restoring brings none back\./);
    assert.deepEqual(await tab.locator('#pv .pvb button').allTextContents(), [`Restore ${kind}`], 'settings already open become read-only too');
    assert.equal(await tab.locator('#pv .pvb input:enabled, #pv .pvb textarea:enabled, #pv .pvb select:enabled').count(), 0);
    await tab.click('#pv [data-act=unpv]');
    assert.equal(await tab.locator('#bar [data-act=rename], #bar .creds, #bar .btn, #bar [data-act=wakes], #needs [data-act=reply], #conv textarea, #conv input, #conv [data-act=reply], #conv [data-act=react], #panes [data-act=add]').count(), 0);
    assert.equal(await tab.locator(`${row} [data-act=${kind === 'series' ? 'new-instance' : 'new-task'}]`).count(), 0);
    if (kind === 'workspace') assert.equal(await tab.locator('.row.ws.on + .tree [data-act=new-instance]').count(), 0);
    await tab.locator('#ins').evaluate(el => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['no change'], 'archive.txt'));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
    });
    assert.equal(await tab.locator('.drag').count(), 0);
    assert.equal((await (await tab.request.get(new URL('/api/instances/a5c0ff5e1f00', tab.url()).href)).json()).log.some((e: any) => e.file?.endsWith('archive.txt')), false);
    await tab.click('#conv .pb [data-act=preview]:text-is("The pack")');
    await tab.waitForSelector('#pv .sh');
    assert.equal(await (await tab.request.get(new URL((await tab.getAttribute('#pv .pvh a', 'href'))!, tab.url()).href)).text(), 'pack\n');
    await tab.click('#pv [data-act=unpv]');
    await tab.click('#log [data-act=audit]');
    await tab.waitForSelector('#audit .e');
    await tab.click('#log [data-act=audit]');
    await tab.hover(row);
    await tab.click(`${row} [data-act=${kind === 'series' ? 'settings' : 'workspace-settings'}]`);
    await tab.waitForSelector(`#pv [data-act=archive-${kind}]:text-is("Restore ${kind}")`);
    assert.deepEqual(await tab.locator('#pv .pvb button').allTextContents(), [`Restore ${kind}`]);
    assert.equal(await tab.locator('#pv .pvb input:enabled, #pv .pvb textarea:enabled, #pv .pvb select:enabled').count(), 0);
    await tab.click('#pv [data-act=unpv]');
    if (kind === 'workspace') {
      await tab.hover('.row.ser.on');
      await tab.click('.row.ser.on [data-act=settings]');
      await tab.waitForSelector('#pv [data-act=archive-workspace]:text-is("Restore workspace")');
      assert.deepEqual(await tab.locator('#pv .pvb button').allTextContents(), ['Restore workspace']);
      assert.equal(await tab.locator('#pv .pvb input:enabled, #pv .pvb select:enabled').count(), 0);
      await tab.click('#pv [data-act=unpv]');
    }
    for (const [id, label] of [['a5c0ff5e1f02', '2026-10'], ['a5c0ff5e1f01', '2026-11']]) {
      await tab.evaluate(id => { location.hash = '#/' + id; }, id);
      await tab.waitForSelector(`#bar h1 .t:text-is("${label}")`);
      assert.equal(await tab.textContent('#bar .state'), 'Archived · read-only');
      assert.equal(await tab.locator('#bar .btn, #conv [data-act=correct]').count(), 0, 'closed instances cannot be corrected either');
      if (id === 'a5c0ff5e1f02') {
        await tab.click('.tile[data-item=notes]');
        await tab.waitForSelector('#card .say');
        assert.equal(await tab.locator('#card [data-act=comment-on], #card [data-act=add], #card [data-act=correct]').count(), 0);
        assert.equal(await tab.locator('#card a:text-is("Download")').count(), 1);
        await tab.click('#card [data-act=preview]');
        await tab.click('#pv .pt:text("2 checks pass")');
        assert.equal(await tab.locator('#pvn button').count(), 0, 'previewing a point cannot start a comment');
        await tab.click('#pv [data-act=unpv]');
      }
    }
    await tab.hover(row);
    await tab.click(`${row} [data-act=${kind === 'series' ? 'settings' : 'workspace-settings'}]`);
    await tab.click(`#pv [data-act=archive-${kind}]`);
    await tab.waitForSelector('#bar .state:text-is("Closed · read-only")');
    await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
    await tab.waitForSelector('#newcomment');
    assert.equal(await tab.inputValue('#newcomment'), 'A draft before archiving');
    assert.equal(await tab.inputValue('#conv .reply:not([hidden]) textarea'), 'A reply before archiving');
    assert.equal(await tab.locator('#bar .creds, #bar [data-act=close]').count(), 2);
    assert.equal(await tab.locator('#conv .pa [data-act=reply]:text-is("Approve…")').count(), 1);
  } finally {
    await tab.request.put(new URL(target, tab.url()).href, { data: { archived: false } });
    await tab.close();
  }
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
  assert.deepEqual(await page.locator('.row.ser .l').allTextContents(), ['Zebra surveys', 'Weekly borrowing base', 'Year-end pack', 'Bank pack', 'Invoice checks'], 'series too come newest activity first');
  assert.deepEqual(await page.locator('.row.grp ~ a.row.inst .l').allTextContents(), ['Apple orchard audit for 2026']);
});

test("only the runner abandons, from the Close dialog, whose buttons for a task weigh the same, the series' name with the one that makes it", async () => {
  await page.click('.row.ser .l:text-is("Weekly borrowing base")');
  await page.waitForSelector('#bar [data-act=takeover]');
  assert.deepEqual([await page.locator('#bar .btn').allTextContents(), await page.textContent('#bar .state'), await page.locator('#bar .creds').count()], [['No wake', 'Take over', 'Assign\u2026'], 'Waiting for files', 0], 'alex runs it, and the admin may assign it');
  await page.click('#bar [data-act=wakes]');
  assert.equal(await page.textContent('#pv .pvh b'), 'Wakes of 2026-09-06 b', 'anyone in its workspace sets its wakes');
  await page.mouse.click(5, 5);
  await page.click('[data-act=takeover]');
  await page.click('[data-act=start-go]');
  await page.click('#bar .creds:text-is("Credentials: none")');
  await page.waitForSelector('#pv .pvh b:text-is("Credentials")');
  await page.mouse.click(5, 5);
  await page.click('#bar [data-act=close]');
  assert.deepEqual(await page.locator('#ask button').allTextContents(), ['Abandon instead', 'Close', 'Cancel']);
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

test("Back to another instance closes a confirmation dialog without acting on either instance", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f02', page.url()).href);
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
    await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
    await tab.waitForSelector('#bar h1 .t:text-is("2026-12")');
    await tab.click('#bar [data-act=close]');
    await tab.waitForSelector('#ask[open]');
    await tab.goBack();
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
    assert.equal(await tab.locator('#ask').evaluate((e: HTMLDialogElement) => e.open), false);
    for (const id of ['a5c0ff5e1f00', 'a5c0ff5e1f02']) {
      assert.equal((await (await tab.request.get(new URL(`/api/instances/${id}`, tab.url()).href)).json()).doc.status, 'open');
    }
  } finally { await tab.close(); }
});

test("a patch waiting for another instance's summary gives way to navigation", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f00', page.url()).href);
    await tab.waitForSelector('#bar h1 .t:text-is("2026-12")');
    let releaseSummary!: () => void, summaryStarted!: () => void, releaseTree!: () => void, treeStarted!: () => void;
    const summaryHeld = new Promise<void>(ok => { releaseSummary = ok; }), summaryReady = new Promise<void>(ok => { summaryStarted = ok; });
    const treeHeld = new Promise<void>(ok => { releaseTree = ok; }), treeReady = new Promise<void>(ok => { treeStarted = ok; });
    await tab.route('**/api/instances/a5c0ff5e1f02/summary', async r => { summaryStarted(); await summaryHeld; await r.continue(); });
    await tab.evaluate(() => { window.pendingPatch = patch(['a5c0ff5e1f00', 'a5c0ff5e1f02']); });
    await summaryReady;
    await tab.route('**/api', async r => { treeStarted(); await treeHeld; await r.continue(); });
    await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f02'; });
    await treeReady;
    releaseSummary();
    await tab.evaluate(() => window.pendingPatch);
    releaseTree();
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")', { timeout: 5000 });
    assert.equal(await tab.evaluate(() => cur.i.id), 'a5c0ff5e1f02');
    assert.equal(new URL(tab.url()).hash, '#/a5c0ff5e1f02');
  } finally { await tab.close(); }
});

test("the side panel is the instance's conversation, a run a line among its threads, or its audit, by the switch at its top: the log and the agent's steps, a plain line each", async () => {
  await page.evaluate(() => { location.hash = '#/3d70f7ca6f20'; });
  await page.waitForSelector('#bar h1 .t:text-is("2026-08-30")');
  await page.waitForSelector('#log.open .seg .sel:text-is("Conversation")');
  assert.equal(await page.getAttribute('#bar [data-act=panel]', 'title'), 'Close the conversation', 'one toggle, in the bar, open or closed');
  assert.equal(await page.locator('#log .runl').innerText(), 'Run 1 · done · 4m 0s · $0.21');
  assert.equal(await page.locator('#audit').isVisible(), false);
  await page.click('#log .seg [data-act=audit]');
  await page.waitForSelector('#audit .e');
  assert.deepEqual([await page.textContent('#log .seg .sel'), await page.locator('#conv').isVisible()], ['Audit', false], 'in place of the conversation');
  const rows = await page.locator('#audit .e > div').evaluateAll(es => es.map(e => (e as HTMLElement).innerText.split('\n')[0]));
  assert.deepEqual([...rows.slice(0, 4), rows.at(-1)], ['alex opened the instance', 'alex uploaded an input', 'Server showed u2', 'Run 1 started', 'alex closed the instance']);
  assert.ok(rows.includes('Run 1 finished · 4m 0s · $0.21') && rows.includes("alex's agent set up Borrowing base"), 'each entry a line');
  assert.ok(rows.includes("alex's agent said Borrowing base for 08-30: excess 180,542.50, up 6,742.50."), "and the agent's session, whose plain text reaches no one else");
  await page.click('#log .seg [data-act=audit]');
  assert.equal(await page.locator('#audit').isVisible(), false);
  await page.click('#bar [data-act=panel]');
  await page.waitForSelector('#log:not(.open)', { state: 'attached' });
  assert.equal(await page.getAttribute('#bar [data-act=panel]', 'title'), 'Open the conversation');
  await page.click('#bar [data-act=panel]');
  await page.waitForSelector('#log.open .seg .sel:text-is("Conversation")');
});

test("a post's images show side by side, by their paths in the instance; a thread whose entry started a run that added a rule says so, opening the process; the run's calls to a connection are in the audit, a refusal with why", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f01'; });
  const pictured = page.locator('#log .thread[data-thread=c10] .post td img');
  await pictured.first().waitFor();
  assert.deepEqual(await pictured.evaluateAll(is => is.map(i => i.getAttribute('src'))), ['/files/a5c0ff5e1f01/working/months.png', '/files/a5c0ff5e1f01/working/months.png']);
  await pictured.first().click();
  await page.waitForSelector('#pv img');
  await page.keyboard.press('Escape');
  const shown = page.locator('#log .thread[data-thread=c10] .post .f');
  assert.deepEqual(await shown.evaluateAll(fs => fs.map(f => f.querySelector('img')?.getAttribute('src') ?? f.textContent)), ['/files/a5c0ff5e1f01/working/months.png', 'ledger.csv'], 'an image shows in the thread, any other file as its name');
  await shown.locator('img').click();
  await page.waitForSelector('#pv img');
  await page.keyboard.press('Escape');
  const note = page.locator('#log .thread[data-thread=c9] .pnote');
  assert.equal(await note.innerText(), 'Process: +1 rule in run 1');
  await note.locator('a').click();
  await page.waitForSelector('#pv .say:has-text("never write to it")');
  await page.keyboard.press('Escape');
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

test("the sidebar's filter keeps, as you type, the rows whose names match and what holds them, opened; its menu chooses which workspaces show, and the order", async () => {
  assert.equal(await page.locator('#tree .row.head').count(), 0, 'no heading over the tree');
  const series = () => page.locator('#tree .row.ser .l').allTextContents(), before = await series();
  await page.fill('#find', 'year');
  assert.deepEqual(await series(), ['Year-end pack']);
  await page.fill('#find', '2026-08-23');
  assert.deepEqual([await series(), await page.locator('#tree a.row.inst .l').allTextContents()], [['Weekly borrowing base'], ['2026-08-23']], 'a closed instance that matches, in its series, opened');
  await page.fill('#find', 'nothing like this');
  assert.equal(await page.textContent('#tree .empty'), 'Nothing matches.');
  await page.fill('#find', '');
  assert.deepEqual(await series(), before);
  await page.click('#sorter summary');
  assert.deepEqual(await page.locator('#sortpop .opt:not([data-act=toggle-archived])').allTextContents(), ['My workspaces', 'All workspaces', 'Newest activity', 'Name']);
  await page.click('#sortpop [data-act=order][data-id=name]');
  assert.deepEqual([await series(), await page.locator('#sorter.on').count()], [[...before].sort(), 1], 'by name, the button marked');
  await page.click('#sortpop [data-act=order][data-id=activity]');
  assert.deepEqual([await series(), await page.locator('#sorter.on').count()], [before, 0]);
  await page.mouse.click(5, 5);
  assert.equal(await page.locator('#sorter[open]').count(), 0, 'a click beside the menu closes it');
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

test("Ctrl+Enter pressed again while a comment is still sending sends it once", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f00', page.url()).href);
    await tab.waitForSelector('#newcomment');
    await tab.route('**/comment', async r => { await new Promise(ok => setTimeout(ok, 1500)); await r.continue(); });
    await tab.fill('#newcomment', 'Sent once with keys');
    await tab.press('#newcomment', 'Control+Enter');
    await tab.waitForSelector('#log [data-act=comment][aria-busy]', { state: 'attached' });
    await tab.press('#newcomment', 'Control+Enter');
    await tab.waitForSelector('#log [data-act=comment]:not([aria-busy])', { state: 'attached' });
    await tab.waitForTimeout(1600);
    assert.equal(await tab.evaluate(() => api('/api/instances/a5c0ff5e1f00').then(d => d.log.filter((e: { text?: string }) => e.text === 'Sent once with keys').length)), 1);
  } finally { await tab.close(); }
});

test("Ctrl+Enter and Cmd+Enter send from the reply box being edited, including a reply under a reply", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f00', page.url()).href);
    await tab.waitForSelector('#newcomment');
    let seq = await tab.evaluate(async () => {
      await api(`${instPath()}/comment`, { method: 'POST', body: JSON.stringify({ text: 'A thread for keyboard replies.', quiet: true }) });
      await refresh();
      return String(data.log.at(-1).seq);
    });
    for (const key of ['Control+Enter', 'Meta+Enter']) {
      const post = `#conv .post[data-seq="${seq}"]`, text = `Reply sent with ${key}`;
      await tab.click(`${post} > .pa [data-act=reply]`);
      await tab.fill(`${post} > .reply textarea`, text);
      await tab.press(`${post} > .reply textarea`, key);
      const reply = tab.locator(`${post} > .kids > .post > .pb:text-is("${text}")`);
      await reply.waitFor({ timeout: 5000 });
      assert.equal(await tab.locator(`${post} > .reply`).isHidden(), true);
      seq = (await reply.locator('..').getAttribute('data-seq'))!;
    }
  } finally { await tab.close(); }
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

test("Show closed lists the closed instances of its own series alone", async () => {
  for (const id of ['a5c0ff5e1f00', 'cec3e476c710']) {
    await page.evaluate(id => { location.hash = `#/${id}`; }, id);
    await page.waitForSelector(`a.row.inst.on[href="#/${id}"]`);
  }
  const listed = () => page.locator('#tree a.row.inst').evaluateAll(as => as.map(a => a.getAttribute('href')).sort()), before = await listed();
  const toggle = (series: string) => page.locator(`#tree [data-act=toggle-closed][data-id=${series}]`);
  await toggle('d83e3e5c41da').click();
  assert.deepEqual((await listed()).filter(h => !before.includes(h)), ['#/3d70f7ca6f20', '#/4647a9f73aac', '#/c0f4e4f28232'], "the borrowing base's closed and abandoned instances, not the year-end pack's");
  assert.deepEqual([await toggle('d83e3e5c41da').textContent(), await toggle('a5c0ff5e1fee').textContent()].map(t => t!.split(' ')[0]), ['Hide', 'Show']);
  await toggle('d83e3e5c41da').click();
  assert.deepEqual(await listed(), before);
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

test("the top bar names the app, what the page shows and you, whose menu has your role and Sign out; the sidebar's foot has Settings, the version, and « to fold it to a rail, as this browser keeps it", async () => {
  await page.waitForSelector('#bar h1 .t');
  assert.deepEqual(await page.$$eval('#masthead :is(.app-name b, .pagename, .avatar, .mail)', es => es.map(e => e.textContent)), ['RollForward', 'Instance workspace', 'DA', 'admin@demo.test']);
  await page.click('#user summary');
  assert.deepEqual(await page.$$eval('#user .upop > *', es => es.map(e => (e as HTMLElement).innerText)), ['Demo Admin · admin', 'admin@demo.test', 'Sign out']);
  await page.click('#masthead .app-name');
  assert.equal(await page.getAttribute('#user', 'open'), null, 'a click beside it closes it');
  assert.match(await page.textContent('#sidefoot .release') ?? '', /^rollforward (v\d+\.\d+\.\d+|[0-9a-f]{7,})/);
  const rail = () => page.evaluate(() => [$('#side')!.offsetWidth, ($('#tree') as HTMLElement).offsetParent === null, $('[data-act=fold-side]')!.textContent]);
  await page.click('#sidefoot [data-act=fold-side]');
  assert.deepEqual(await rail(), [44, true, '»']);
  await page.reload();
  await page.waitForSelector('#bar h1 .t');
  assert.deepEqual(await rail(), [44, true, '»'], 'kept in this browser');
  await page.click('#sidefoot [data-act=fold-side]');
  assert.deepEqual(await rail(), [256, false, '«']);
  await page.click('#sidefoot [data-act=logins]');
  await page.waitForSelector('#pv[open] [data-act=logins-show]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pv:not([open])', { state: 'attached' });
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

test("an ask from before questions and proposals shows the files it links and the runs since it, and anyone who sees the instance approves it from under it, which commits the folder, as the thread and the audit say", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#log.open');
  await page.locator('#needs', { hasText: 'The pack is ready to send to the bank.' }).waitFor();
  assert.equal(await page.locator('#needs').innerText(), 'Ask\nThe pack is ready to send to the bank.\nReply');
  const thread = page.locator('#log .thread', { hasText: 'The pack is ready to send to the bank.' });
  await thread.waitFor();
  assert.equal(await page.textContent('#bar .ptog .badge'), String(await page.locator('#log .post.waits').count()), "the panel's toggle counts what waits there");
  assert.match(await thread.locator('.on').innerText(), /waits on you/);
  assert.deepEqual(await thread.locator('.post .pb a[data-act=preview]').allInnerTexts(), ['The pack'], 'the file it links');
  // The runs since the ask, as its log has them: the fixture's one, and any an earlier test's act woke since, as the waker's tick allows,
  // which may start one as this reads; the page catches up with the log.
  let since = '', runs = 0;
  for (let i = 0; i < 50; i++) {
    runs = (await (await page.request.get(new URL('/api/instances/a5c0ff5e1f00', page.url()).href)).json()).log.filter((e: { op: string; seq: number }) => e.op === 'run' && e.seq > 2).length;
    since = await thread.locator('.post[data-seq="2"] > .tm').innerText();
    if (since.includes(`waits on you · ${runs} run${runs === 1 ? '' : 's'} since`)) break;
    await page.waitForTimeout(200);
  }
  assert.ok(runs >= 1, 'the fixture has a run since the ask');
  assert.match(since, new RegExp(`waits on you · ${runs} runs? since`), 'what it links may have changed since');
  assert.deepEqual(await thread.locator('.post > .pa button').allInnerTexts(), ['\u{1F44D}', '\u{1F44E}', 'Reply', 'Approve\u2026', 'Reject\u2026'], 'it may have been either');
  await thread.locator('.pa button', { hasText: 'Approve' }).click();
  await thread.locator('.reply:not([hidden]) textarea').fill('Looks right.');
  await thread.locator('[data-act=approve]').click();
  const post = page.locator('#log .thread .post .post', { hasText: 'Approved: Looks right.' });
  await post.waitFor();
  assert.match(await post.locator('.tm').innerText(), /commit [0-9a-f]{7}/);
  await page.waitForSelector('#needs', { state: 'hidden' });
  assert.equal(await thread.locator('button', { hasText: 'Approve' }).count(), 0, 'approved by you, it asks you no more');
  await thread.locator('.post[data-seq="2"] > .pa [data-act=react][data-up=true]').click();
  await page.waitForSelector('#log .post[data-seq="2"] > .pa .react.on:text-is("\u{1F44D} 1")');
  await page.click('#bar .reacts [data-act=react][data-up=false]');
  await page.waitForSelector('#bar .reacts .react.on:text-is("\u{1F44E} 1")');
  await page.click('#bar .reacts [data-act=react][data-up=false]');
  await page.waitForSelector('#bar .reacts .react:not(.on):text-is("\u{1F44E}")');
  await page.click('#log [data-act=audit]');
  await page.locator('#audit .e', { hasText: 'You approved c2' }).waitFor();
  await page.click('#log .seg [data-act=audit]');
});

test("a question asks, with Reply alone; a proposal proposes, apart, with Approve and Reject, and a reply under it approves nothing; a withdrawn ask is a line until opened; cN links a comment, here or in another instance, and each comment's cN copies an address that opens the page at it", async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f07'; });
  await page.waitForSelector('#log.open');
  await page.locator('#needs', { hasText: 'Which account' }).waitFor();
  assert.equal(await page.locator('#needs').innerText(), 'Question\nWhich account does it go to? See c2.\nReply\nProposal\nI will send [the pack](working/pack.csv) to the bank, as [last month](../December#c2).\nApprove\u2026\nReject\u2026');
  const question = page.locator('#conv .post[data-seq="3"]'), proposal = page.locator('#conv .post[data-seq="4"]'), label = (post: typeof question) => post.evaluate(e => {
    const s = getComputedStyle(e.querySelector(':scope > b')!, '::after');
    return [s.content, s.color, getComputedStyle(e).backgroundColor];
  });
  const [asks, proposes] = [await label(question), await label(proposal)];
  assert.deepEqual([asks[0], proposes[0]], ['" asks"', '" proposes"']);
  assert.ok(asks[1] !== proposes[1] && asks[2] !== proposes[2], `a proposal looks apart from a question: ${asks} ${proposes}`);
  assert.deepEqual(await question.locator(':scope > .pa button').allInnerTexts(), ['\u{1F44D}', '\u{1F44E}', 'Reply'], 'a question is answered, never approved');
  assert.deepEqual(await proposal.locator(':scope > .pa button').allInnerTexts(), ['\u{1F44D}', '\u{1F44E}', 'Reply', 'Approve\u2026', 'Reject\u2026']);
  const open = proposal.locator(':scope > .reply:not([hidden])');
  await proposal.locator(':scope > .pa [data-mode=approve]').click();
  assert.deepEqual([await open.count(), await open.locator('.hint').innerText(), await open.locator('.btn').innerText()],
    [1, 'The agent will go ahead with this. Approving commits the instance as it is now, in your name.', 'Approve: go ahead']);
  await proposal.locator(':scope > .pa [data-act=reply]:text-is("Reply")').click();
  assert.deepEqual([await open.count(), await open.locator('.hint').innerText()], [1, 'A reply approves nothing: for the agent to go ahead, approve it.'], 'one box at a time');
  await open.locator('textarea').fill('Go ahead.');
  await open.locator('[data-act=reply-post]').click();
  const reply = proposal.locator('.kids .post', { hasText: 'Go ahead.' });
  await reply.waitFor();
  assert.match(await page.locator('#needs').innerText(), /Proposal/, 'a reply, however worded, approves nothing');
  await proposal.locator(':scope > .pa [data-mode=reject]').click();
  assert.equal(await open.locator('.hint').innerText(), "The agent won't do this, and carries on as your note says.");
  await open.locator('textarea').fill('Wait for the new rate.');
  await open.locator('[data-act=reject]').click();
  await proposal.locator('.kids .post', { hasText: 'Rejected: Wait for the new rate.' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#needs')!.textContent!.includes('Proposal'));
  assert.equal(await proposal.locator(':scope > .pa button', { hasText: 'Approve' }).count(), 0, 'rejected by you, it asks you no more');

  const gone = page.locator('#conv .post[data-seq="5"]');
  assert.deepEqual([await gone.innerText(), await gone.locator('.pb').count()], ['\u25B8withdrawn: The file says so. \u00b7 see c2', 0], 'withdrawn, a line');
  await gone.click({ position: { x: 4, y: 4 } });
  await gone.locator('.pb:text-is("Is the rate final?")').waitFor();
  await gone.locator('.gone').click({ position: { x: 4, y: 4 } });
  await page.waitForSelector('#conv .post.withdrawn.folded[data-seq="5"]');

  const ref = question.locator('.pb a.cref');
  assert.deepEqual([await ref.innerText(), await ref.getAttribute('title')], ['c2', 'Agent: The pack is built.'], 'a bare cN links its comment');
  await ref.click();
  await page.waitForSelector('#conv .post.flash[data-seq="2"]');
  await question.locator(':scope > .tm .cn:text-is("c3")').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), new URL('/#/a5c0ff5e1f07/c3', page.url()).href);
  const seq = await reply.getAttribute('data-seq');
  await proposal.locator(':scope > .fold').click();
  await page.waitForSelector('#conv .post.folded[data-seq="4"]');
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f08'; });
  await page.waitForSelector('#bar h1 .t:text-is("December")');
  await page.evaluate(seq => { location.hash = `#/a5c0ff5e1f07/c${seq}`; }, seq);
  await page.waitForSelector(`#conv .post.flash[data-seq="${seq}"]`);
  assert.equal(await page.evaluate(() => location.hash), '#/a5c0ff5e1f07', 'opened at it, its thread unfolded');

  await page.click('.tile[data-item=notes]');
  await page.click('#card [data-act=preview]');
  await page.click('#pv a.cref:text-is("the summary")');
  await page.waitForSelector('#pv:not([open])', { state: 'attached' });
  await page.waitForSelector('#conv .post.flash[data-seq="2"]');
  const last = proposal.locator('.pb a.cref', { hasText: 'last month' });
  await last.hover();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#conv .post[data-seq="4"] .pb a.cref[data-inst="a5c0ff5e1f08"]')?.title === 'Agent: Sent the pack on the 3rd.');
  await last.click();
  await page.waitForSelector('#bar h1 .t:text-is("December")');
  await page.waitForSelector('#conv .post.flash[data-seq="2"]');
});

test("a copy's history is the copied instance's: its asks and notes wait on no one, its proposals take no approval, and its outputs show no sends", async () => {
  const id = 'a5c0ff5e1f0c';
  assert.deepEqual((await (await page.request.get(new URL(`/api/instances/${id}`, page.url()).href)).json()).waiting, []);
  const refused = await page.request.post(new URL(`/api/instances/${id}/signoff`, page.url()).href, { data: { thread: 'c2' } });
  assert.deepEqual([refused.status(), await refused.text()], [409, 'c2 was accepted as done at the close, by admin@demo.test']);
  await page.evaluate(id => { location.hash = `#/${id}`; }, id);
  await page.waitForSelector('#bar h1 .t:text-is("October copy")');
  if (!await page.locator('#log.open').count()) await page.click('#bar [data-act=panel]');
  await page.locator('#conv .post[data-seq="2"]').waitFor();
  await page.click('.tile[data-item=pack]');
  await page.locator('#card .cp').first().waitFor();
  assert.deepEqual(await Promise.all(['#conv .post[data-seq="2"] [data-mode=approve]', '.tile[data-item=pack] .sent', '#card .sent', '#needs .propose'].map(s => page.locator(s).count())), [0, 0, 0, 0]);
  assert.equal((await page.request.post(new URL(`/api/instances/${id}/abandon`, page.url()).href, { data: {} })).status(), 200);
});

test("text left in a closed Reply box holds nothing still: once approved, the conversation shows it and offers Approve no more", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f0a'; });
  await page.waitForSelector('#bar h1 .t:text-is("February")');
  if (!await page.locator('#log.open').count()) await page.click('#bar [data-act=panel]');
  const post = page.locator('#conv .post[data-seq="2"]');
  await post.locator(':scope > .pa [data-act=reply]:text-is("Reply")').click();
  await post.locator(':scope > .reply[data-mode=reply] textarea').fill('Go ahead.');
  await post.locator(':scope > .pa [data-mode=approve]').click();
  await post.locator('[data-act=approve]').click();
  await post.locator('.kids .post', { hasText: 'Approved' }).waitFor();
  assert.equal(await post.locator(':scope > .pa [data-mode=approve]').count(), 0);
  await post.locator(':scope > .pa [data-act=reply]:text-is("Reply")').click();
  assert.equal(await post.locator(':scope > .reply[data-mode=reply] textarea').inputValue(), '', 'approving clears what its boxes held');
  await post.locator(':scope > .pa [data-act=reply]:text-is("Reply")').click();
});

test("a file link's path may hold an &, spaces and one level of parentheses, and an image's spaces and parentheses, as everyday Windows names do", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f07'; });
  await page.waitForSelector('#bar h1 .t:text-is("January")');
  const files = await page.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = inline(esc('[the P&L](upload/P&L.csv), [the TB](upload/TB (final).csv) (see note), ![chart](working/AR chart (1).png) and [plain](upload/plain.csv)'));
    return [...d.querySelectorAll('[data-file]')].map(e => [e.tagName, (e as HTMLElement).dataset.file, e.nextSibling?.textContent ?? null]);
  });
  assert.deepEqual(files, [['A', 'upload/P&L.csv', ', '], ['A', 'upload/TB (final).csv', ' (see note), '], ['IMG', 'working/AR chart (1).png', ' and '], ['A', 'upload/plain.csv', null]]);
});

test("[text](#cN) to a comment whose first line links a file is a link by that text alone, its title the comment's first words", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f0a'; });
  await page.waitForSelector('#bar h1 .t:text-is("February")');
  const post = page.locator('#conv .post[data-seq="6"] .pb');
  assert.equal(await post.innerText(), 'As my proposal says, and as in November.');
  assert.equal(await post.locator('a.cref').first().getAttribute('title'), 'Agent: I will send [the pack](working/pack.csv) to the bank, as [last month](../Decembe');
});

test("a cN link to a reply under a withdrawn ask opens the ask to show it", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f0a'; });
  await page.waitForSelector('#bar h1 .t:text-is("February")');
  await page.click('#conv .post.withdrawn.folded[data-seq="3"] a.cref');
  await page.waitForSelector('#conv .post.flash[data-seq="4"]');
  await page.locator('#conv .post[data-seq="3"] > .gone').click({ position: { x: 4, y: 4 } });
  await page.waitForSelector('#conv .post.withdrawn.folded[data-seq="3"]');
});

test("hovering a link to a deleted instance's comment says nothing of it, and no error", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f0a'; });
  await page.waitForSelector('#bar h1 .t:text-is("February")');
  await page.waitForSelector('#bar .state .bad:text("Run 1 failed")');
  await page.evaluate(() => api('/api/instances/a5c0ff5e1f09/delete', { method: 'POST' }));
  const toasts = await page.locator('#toasts .toast').count();
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(0, 0);
    await page.hover('#conv .post[data-seq="6"] a.cref[data-inst="a5c0ff5e1f09"]');
    await page.waitForTimeout(500);
  }
  assert.deepEqual([await page.locator('#toasts .toast').count(), await page.locator('#conv a.cref[data-inst="a5c0ff5e1f09"]').getAttribute('title')], [toasts, null]);
});

test("a bare cN after =, &, ;, !, : or ? is no reference, as in an address, a query or a cell's, and links nothing", async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f0a'; });
  await page.waitForSelector('#bar h1 .t:text-is("February")');
  const linked = await page.locator('#conv .post[data-seq="7"] .pb').evaluate(p => [...p.childNodes].map(n => n.nodeName === 'A' ? `[${n.textContent}]` : n.textContent).join(''));
  assert.equal(linked, 'Part 零件编号[c2], R&c2, doc=c2, Sheet1!c3:c4, why?c2, a;c2 and https://portal/view?doc=c2, but see [c2].', 'Chinese right before it may be a reference, as 见c3 is');
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

test("a runner's name without letters shows its first characters in the sidebar", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/3d70f7ca6f20', page.url()).href);
    await tab.waitForSelector('#bar h1 .t:text-is("2026-08-30")');
    for (const [name, short] of [['123', '12'], ['🚀🎯', '🚀🎯']]) {
      await tab.evaluate(name => { me.names[cur.i.runner] = name; renderSide(); }, name);
      assert.equal(await tab.textContent('.row.inst.on .who'), short);
      assert.equal(await tab.getAttribute('.row.inst.on .who', 'title'), `${name} runs it`);
    }
  } finally { await tab.close(); }
});

test("the conversation reads as a chat: oldest first, a run below the comment that started it and a thread where its last post is, and the box to comment at the panel's foot; it opens at the latest and keeps there as posts come, unless the reader has scrolled up", async () => {
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
  await page.waitForSelector('#log .thread[data-thread=c10]');
  assert.deepEqual(await order(), ['c9', 'runl', 'c10', 'compose']);
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

test("a comment's twisty collapses it, with what hangs under it, to its first line, as this browser keeps it until someone adds to it", async () => {
  const url = (path: string) => new URL(path, page.url()).href, signin = await entra.signIn(new URL(page.url()).origin, 'bob@demo.test');
  const bobs = signin.headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  const note = async (text: string, thread?: string) => {
    assert.equal((await fetch(url('/api/instances/a5c0ff5e1f00/comment'), { method: 'POST', body: JSON.stringify({ text, thread }), headers: { cookie: bobs } })).status, 200);
    await page.locator('#log .post', { hasText: text }).last().waitFor();
  };
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#bar h1 .t:text-is("2026-12")');
  await note('The rates, line by line.\nAll twelve months.');
  const thread = page.locator('#log .thread', { hasText: 'The rates, line by line.' }), id = await thread.getAttribute('data-thread');
  await note('September is off.', id!);
  await thread.locator('[data-act=fold]').first().click();
  assert.deepEqual(await thread.locator('.post').evaluateAll(ps => ps.map(p => [p.classList.contains('folded'), p.textContent!.includes('The rates, line by line.'), p.textContent!.includes('All twelve months'), p.textContent!.endsWith('\u00b7 1 more')])), [[true, true, false, true]], 'one line, its first, and a count of the rest');
  await page.reload();
  await page.waitForSelector(`#log .thread[data-thread=${id}] .post.folded`);
  await note('And October.', id!);
  assert.equal(await thread.locator('.post.folded').count(), 0, 'a reply opens it again');
  assert.equal(await thread.locator('.post').count(), 3);
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

test("a workspace's settings say what its agents read and which workspaces' agents read it, which its owners add among the workspaces they see, and the owners of either take off", async () => {
  await page.evaluate(() => fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Readers' }) }));
  await page.reload();
  const settings = async (name: string) => {
    await page.mouse.click(5, 5);
    await page.hover(`.row.ws:has-text("${name}")`);
    await page.click(`.row.ws:has-text("${name}") [data-act=workspace-settings]`);
  };
  await settings('larkfield');
  await page.locator('#pv .sub', { hasText: "No other workspace's agents read this one." }).waitFor();
  await page.selectOption('#reader', { label: 'Readers' });
  await page.click('[data-act=reader-add]');
  await page.waitForSelector('#pv .lsub span:text-is("Readers")');
  await settings('Readers');
  await page.locator('#pv .sub', { hasText: 'and those of the workspaces below, whose owners let them' }).waitFor();
  await page.click('#pv .lsub:has(span:text-is("larkfield")) [data-act=reader-drop]');
  await page.locator('#pv .sub', { hasText: 'Agents here read every series of this workspace. They write only here' }).waitFor();
  await page.mouse.click(5, 5);
});

test("a workspace's settings: five people shown until Show all, each row's two buttons of one width; Merge or move sets what beside where and names what Propose asks; Close is the primary button; no dialog scrolls sideways, on a phone either", async () => {
  const ws = '1b3031035ff6', put = (body: object) => page.evaluate(([id, b]) => fetch(`/api/workspaces/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.status), [ws, body] as const);
  const before = await page.evaluate(id => tree.find(w => w.id === id), ws);
  const people = ['christopher.wellington-smythe@finance-operations.example.com', 'bob@demo.test', 'sharon.huang@accounts-payable.example.com', 'echo.wong@example.com', 'a.very.long.name.indeed@shared-services.example.org', '0b8e5c8a-6d3e-4c21-9f2a-1d2e3f4a5b6c'];
  assert.equal(await put({ owners: ['admin@demo.test', people[0]], members: people.slice(1) }), 200);
  await page.evaluate(id => { location.hash = `#/${id}`; }, ws);
  await page.waitForSelector(`#tree .row.ws.on`);
  await page.evaluate(async () => { await refresh(); openWorkspaceSettings(); });
  await page.waitForSelector('#pv[open] .ut.people');
  // Wider than its box, whether or not it shows a scrollbar for it.
  const sideways = () => page.evaluate(() => [...document.querySelectorAll('#pv[open], #pv[open] .pvb')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
  const rows = () => page.locator('#pv .ut.people tr').evaluateAll(trs => trs.filter(tr => (tr as HTMLElement).offsetParent).map(tr => tr.querySelector('td')!.textContent));
  assert.deepEqual([(await rows()).length, await page.textContent('#pv [data-act=people-all]')], [5, 'Show all7']);
  const widths = await page.locator('#pv .pacts').first().evaluate(p => [...p.querySelectorAll('.btn')].map(b => [(b as HTMLElement).offsetWidth, (b as HTMLElement).offsetTop, getComputedStyle(b).textAlign]));
  assert.deepEqual([widths[0][0] === widths[1][0], widths[0][1] === widths[1][1], widths[1][2]], [true, true, 'center'], `Make member and Remove: ${JSON.stringify(widths)}`);
  assert.equal(await page.getAttribute('#pv [data-act=wremove]', 'class'), 'btn danger');
  await page.click('#pv [data-act=people-all]');
  assert.deepEqual([(await rows()).length, await page.textContent('#pv [data-act=people-all]')], [7, 'Show fewer7']);
  assert.deepEqual(await sideways(), [], 'workspace settings');
  await page.selectOption('#pv #mvto', { label: 'Readers' });
  assert.deepEqual([await page.textContent('#pv #mvgo'), await page.textContent('#pv #mvsay')], ['Propose merge', 'Merges larkfield into Readers: everyone here joins it.']);
  await page.selectOption('#pv #mvwhat', { label: 'Weekly borrowing base' });
  assert.deepEqual([await page.textContent('#pv #mvgo'), await page.textContent('#pv #mvsay')], ['Propose move', "Moves Weekly borrowing base into Readers; whoever isn't in Readers no longer sees it."]);
  const [what, arrow, into] = await page.locator('#pv .mv > *').evaluateAll(es => es.map(e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height)));
  assert.ok(Math.abs(what - into) <= 1 && Math.abs(what - arrow) <= 8, `on one line: ${[what, arrow, into]}`);
  assert.equal(await page.getAttribute('#pv [data-act=unpv]', 'class'), 'btn primary');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await sideways(), [], 'and on a phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pv:not([open])', { state: 'attached' });
  assert.equal(await put({ owners: before.owners, members: before.members }), 200);
  await page.evaluate(() => refresh());
});

test("adding or removing someone in a workspace's settings changes that one alone, undoing no other owner's change made since the dialog opened", async () => {
  const ws = '1b3031035ff6', put = (body: object) => page.evaluate(([id, b]) => fetch(`/api/workspaces/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.status), [ws, body] as const);
  const people = () => page.evaluate(id => fetch(`/api/workspaces/${id}/people`).then(r => r.json()).then(ps => ps.map((p: { who: string; as: string }) => `${p.as} ${p.who}`)), ws);
  const before = await page.evaluate(id => tree.find(w => w.id === id), ws);
  await page.evaluate(id => { location.hash = `#/${id}`; }, ws);
  await page.waitForSelector('#tree .row.ws.on');
  await page.evaluate(async () => { await refresh(); openWorkspaceSettings(); });
  await page.waitForSelector('#pv[open] #wperson');
  assert.equal(await put({ owners: before.owners, members: [...before.members, 'carol@demo.test'] }), 200, 'another owner adds Carol');
  await page.fill('#wperson', 'dave@demo.test');
  await page.click('[data-act=wadd]');
  await page.waitForSelector('#pv [data-act=wremove][data-p="dave@demo.test"]');
  assert.ok((await people()).includes('member carol@demo.test'));
  assert.equal(await put({ owners: before.owners, members: [...before.members, 'dave@demo.test'] }), 200, 'and another takes Carol off');
  await page.click('#pv [data-act=wrole][data-p="dave@demo.test"]');
  await page.waitForSelector('#pv [data-act=wrole][data-p="dave@demo.test"]:text-is("Make member")');
  assert.deepEqual((await people()).filter((p: string) => /carol|dave/.test(p)), ['owner dave@demo.test']);
  await page.click('#pv [data-act=wremove][data-p="dave@demo.test"]');
  await page.waitForSelector('#pv [data-act=wremove][data-p="dave@demo.test"]', { state: 'detached' });
  assert.deepEqual((await people()).filter((p: string) => /carol|dave/.test(p)), []);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pv:not([open])', { state: 'attached' });
  assert.equal(await put({ owners: before.owners, members: before.members }), 200);
});

test("Logins shows what needs you first, then a line for each kind, Microsoft 365's sources and the websites opening in place; ticks go by kind, Microsoft 365's sources under a tick of their own, an expired login's flagged and off", async () => {
  const rf = join(root, '.rf'), mine = join(rf, 'people', createHash('sha256').update('admin@demo.test').digest('hex').slice(0, 16));
  writeFileSync(join(rf, 'connections.json'), JSON.stringify({ graph: { type: 'graph' }, adb: { type: 'databricks' } }));
  mkdirSync(mine, { recursive: true });
  const site = (url: string) => ({ url, hosts: [], writeback: true, added: '2026-11-01T00:00:00Z' });
  writeFileSync(join(mine, 'websites.json'), JSON.stringify({ portal: { ...site('https://portal.test/'), hosts: ['cdn.portal.test', 'sso.idp.test'], checks: { 'cdn.portal.test': { verdict: 'pass', why: 'Its CDN.' } } }, wiki: site('https://wiki.test/start') }));
  writeFileSync(join(mine, 'logins.json'), JSON.stringify([
    { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: 'admin@demo.test', since: '2026-11-01T00:00:00Z', offers: [{ id: 'm365:onedrive', name: 'OneDrive' }, { id: 'm365:site:s1', name: 'SharePoint Reports' }] },
    { id: 'adb', kind: 'databricks', name: 'Databricks adb', since: '2026-11-01T00:00:00Z', offers: [{ id: 'adb:adb-1.azuredatabricks.net/wh1', name: 'Warehouse Finance, adb-1.azuredatabricks.net' }], expired: true },
    { id: 'web:portal', kind: 'website', name: 'portal', since: '2026-11-02T00:00:00Z', offers: [{ id: 'web:portal', name: 'portal' }], keepalive: new Date(Date.now() + 86_400_000).toISOString() },
  ]));
  const lines = () => page.$$eval('#pv .lline', ls => ls.map(l => [...l.children].map(c => (c as HTMLElement).innerText.trim()).join(' | ')));
  await page.evaluate(() => openLogins());
  await page.waitForSelector('#pv .lline');
  assert.deepEqual(await page.$$eval('#pv .pvtabs .tab', ts => ts.map(t => t.textContent)), ['Logins', 'Tokens'], "an admin's too: admins see people with rf people");
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
  assert.match((await page.$$eval('#pv .lsub', rs => rs.map(r => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))).slice(2).join('\n'), /^portal https:\/\/portal\.test\/ · since .+, kept alive until .+ Sign in again Sign out Remove\nReaches cdn\.portal\.test: Its CDN\. Remove\nReaches sso\.idp\.test Remove\nwiki https:\/\/wiki\.test\/start Sign in Remove$/);
  // Signing in, those granted keepalive may tick it, a week ahead unless they set less, and Save login sends it.
  const saved: unknown[] = [], routes = ['**/logins/web/portal', '**/signins/s1/view?drive', '**/signins/s1'];
  await page.route(routes[0], r => r.fulfill({ json: { id: 's1', expires: new Date(Date.now() + 600_000).toISOString() } }));
  await page.route(routes[1], r => r.fulfill({ contentType: 'text/html', body: 'live' }));
  await page.route(routes[2], r => (r.request().method() === 'POST' && saved.push(r.request().postDataJSON()), r.fulfill({ body: 'ok' })));
  await page.click('#pv [data-act=web-signin][data-id=portal]');
  assert.equal(await page.isChecked('#pv #keep'), false, 'off unless ticked');
  await page.check('#pv #keep');
  await page.click('#pv [data-act=signin-save]');
  await page.waitForSelector('#pv .lline');
  assert.ok(Math.abs(Date.parse((saved[0] as { keepalive: string }).keepalive) - Date.now() - 7 * 86_400_000) < 120_000, JSON.stringify(saved));
  for (const url of routes) await page.unroute(url);
  await page.mouse.click(5, 5);
  // A website of your own, by a name you choose, with the header its sign-in needs; removing one takes only your login to it and
  // your grants for it.
  await page.evaluate(() => { me.browsers = true; return openLogins(); });
  await page.click('#pv [data-act=logins-show][data-id=web]');
  await page.route('**/logins/sites', r => r.request().method() === 'POST' ? r.fulfill({ json: { site: 'bank' } }) : r.continue());
  const added = page.waitForRequest(r => r.url().endsWith('/logins/sites') && r.method() === 'POST');
  await page.fill('#pv #site-name', 'bank');
  await page.fill('#pv #site-url', 'https://bank.test/login');
  await page.fill('#pv #site-header', 'x-bot-token');
  await page.click('#pv [data-act=site-add]');
  assert.deepEqual((await added).postDataJSON(), { name: 'bank', url: 'https://bank.test/login', header: 'x-bot-token' });
  await page.unroute('**/logins/sites');
  await page.click('#pv [data-act=site-remove][data-id=wiki]');
  assert.equal(await page.textContent('#ask p'), 'Your login to it and your grants for it go too.');
  await page.click('#ask button:text-is("Remove")');
  await page.waitForSelector('#pv [data-act=site-remove][data-id=wiki]', { state: 'detached' });
  // Each of its other hosts, with what the server's check said of one it let it reach, its person removes, and it stays refused.
  await page.click('#pv [data-act=host-remove][data-host="cdn.portal.test"]');
  assert.equal(await page.textContent('#ask p'), "portal's runs no longer reach it, and the server's check won't let them again. Only an admin can allow it again.");
  await page.click('#ask button:text-is("Remove")');
  await page.waitForSelector('#pv [data-act=host-remove][data-host="cdn.portal.test"]', { state: 'detached' });
  const portal = JSON.parse(readFileSync(join(mine, 'websites.json'), 'utf8')).portal;
  assert.deepEqual([portal.hosts, portal.checks['cdn.portal.test'].verdict], [['sso.idp.test'], 'refused']);
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
  rmSync(join(mine, 'logins.json'));
  rmSync(join(mine, 'websites.json'));
});

test('the sign-in countdown expires locally, removes the live browser, disables Save login and never polls refused hosts', async t => {
  let polls = 0, saves = 0;
  const routes = ['**/logins/web/expiring', '**/logins/web/expiring/refused', '**/signins/short/view?drive', '**/signins/short'];
  t.after(async () => {
    for (const url of routes) await page.unroute(url);
    await page.mouse.click(5, 5);
  });
  await page.route(routes[0], r => r.fulfill({ json: { id: 'short', expires: new Date(Date.now() + 2000).toISOString() } }));
  await page.route(routes[1], r => (polls++, r.fulfill({ json: { hosts: [] } })));
  await page.route(routes[2], r => r.fulfill({ contentType: 'text/html', body: 'live' }));
  await page.route(routes[3], r => (r.request().method() === 'POST' && saves++, r.fulfill({ body: 'ok' })));
  await page.evaluate(() => {
    document.querySelector('#pv').innerHTML = '<button data-act="web-signin" data-id="expiring" data-name="expiring">Sign in</button>';
    document.querySelector('#pv').showModal();
  });
  await page.click('#pv [data-act=web-signin]');
  await page.waitForSelector('#pv iframe');
  assert.match(await page.textContent('#signin-clock'), /^0:0[12]$/);
  assert.equal(await page.isDisabled('#pv [data-act=signin-save]'), false);
  assert.equal(await page.locator('#pv [data-act=allow-host]').count(), 0);
  await page.locator('#pv').getByText('Sign-in expired. Close this and sign in again.', { exact: true }).waitFor();
  assert.equal(await page.locator('#pv iframe').count(), 0);
  assert.equal(await page.isDisabled('#pv [data-act=signin-save]'), true);
  assert.deepEqual([polls, saves], [0, 0]);
});

test('a legacy grant check stays readable without inventing a profile or usage, and approval no longer promises any hosts', async () => {
  const rf = join(root, '.rf'), bob = 'bob@demo.test', his = join(rf, 'people', createHash('sha256').update(bob).digest('hex').slice(0, 16));
  mkdirSync(his, { recursive: true });
  writeFileSync(join(his, 'websites.json'), JSON.stringify({ gg: { url: 'https://gg.test/start', hosts: ['sso.gg.test'], writeback: true, added: '2026-11-01T00:00:00Z' } }));
  writeFileSync(join(rf, 'grants.json'), JSON.stringify({ g1: { workspace: '1b3031035ff6', person: bob, site: 'gg', reason: 'For the weekly pull', at: '2026-11-02T00:00:00Z', state: 'pending',
    check: { risk: 'low', flags: [], summary: 'A ledger.', title: 'GG', hosts: ['sso.gg.test'], same: 'portal' } } }));
  await page.reload();
  await page.click('[data-act=waiting]');
  const asks = await page.locator('#pv [data-grant=g1]').innerText();
  assert.match(asks, /gg[\s\S]*https:\/\/gg\.test\/start[\s\S]*For the weekly pull/);
  assert.match(asks, /low risk[\s\S]*A ledger\.|A ledger\.[\s\S]*low risk/);
  assert.doesNotMatch(asks, /looks like|Approving lets it reach|0 runs/, 'legacy checks are evidence, not a new host approval or invented usage');
  await page.mouse.click(5, 5);
  await page.hover('.row.ws');
  await page.click('.row.ws [data-act=workspace-settings]');
  const detail = await page.locator('#pv .lsub', { hasText: 'For the weekly pull' }).innerText();
  assert.match(detail, /gg[\s\S]*https:\/\/gg\.test\/start[\s\S]*For the weekly pull/);
  assert.match(detail, /A ledger\./, 'the old production check still shows');
  assert.doesNotMatch(detail, /Approving lets it reach|, also sso\.gg\.test/, 'hosts are no longer part of the grant decision');
  await page.mouse.click(5, 5);
  rmSync(join(rf, 'grants.json'));
  rmSync(join(his, 'websites.json'));
});

test('grant decisions say who can do what, why an admin is needed, owner concerns and approved usage, without making hosts part of approval', async t => {
  const workspace = '1b3031035ff6', person = 'bob@demo.test';
  const base = { workspace, workspaceName: 'larkfield', person, personName: 'Bob', site: 'ledger', url: 'https://ledger.example.test/', at: new Date().toISOString(),
    reason: 'For the weekly pull', description: 'Runs may do whatever Bob can there, including submitting and approving. The reason is not an enforced limit.', check: undefined };
  const rows = [
    { ...base, id: 'general', state: 'pending', profile: { what: 'A shared upload service.', category: 'general', risk: 'medium', flags: ['Files can leave the company.'] }, flags: ['Files can leave the company.'], adminOnly: true, adminWhy: 'This is a general-purpose website.', use: null },
    { ...base, id: 'high', state: 'pending', profile: { what: 'A company payment system.', category: 'company', risk: 'high', flags: ['Can approve payments.'] }, flags: ['Can approve payments.'], adminOnly: true, adminWhy: 'The website is high risk.', use: null },
    { ...base, id: 'used', state: 'approved', profile: { what: 'A vendor ledger.', category: 'vendor', risk: 'low', flags: [] }, flags: [], adminOnly: false, adminWhy: '', by: 'admin@demo.test', text: 'For month end.', use: { runs: 4, wrote: 2, last: '2026-11-02T12:00:00Z' } },
  ];
  await page.route('**/api', async r => {
    const res = await r.fetch(), all = await res.json();
    all.find((w: any) => w.id === workspace).grants = rows;
    await r.fulfill({ response: res, json: all });
  });
  t.after(async () => { await page.unroute('**/api'); await page.reload(); });
  await page.reload();
  await page.click('[data-act=waiting]');
  const general = page.locator('#pv [data-grant=general]'), high = page.locator('#pv [data-grant=high]');
  assert.match(await general.innerText(), /Bob[\s\S]*larkfield[\s\S]*ledger[\s\S]*ledger\.example\.test/);
  assert.match(await general.innerText(), /General-purpose website[\s\S]*A shared upload service\.[\s\S]*submitting and approving[\s\S]*Reason: For the weekly pull[\s\S]*Files can leave the company\.[\s\S]*Only an admin can approve/);
  assert.equal(await general.locator('[data-act=grant-approve]').count(), 1, 'an admin can decide a general-purpose request');
  await page.evaluate(() => { me.role = 'user'; renderPv(); });
  for (const row of [general, high]) {
    assert.equal(await row.locator('[data-act=grant-approve]').count(), 0, 'workspace ownership does not authorize general-purpose or high-risk approval');
    assert.equal(await row.locator('[data-act=grant-deny]').count(), 1, 'an owner may still deny it');
  }
  await page.evaluate(() => { me.role = 'admin'; renderPv(); });
  await page.mouse.click(5, 5);
  await page.evaluate(id => { location.hash = `#/${id}`; }, workspace);
  await page.evaluate(async () => { await refresh(); openWorkspaceSettings(); });
  const used = page.locator('#pv [data-grant=used]');
  assert.match(await used.innerText(), /Vendor system[\s\S]*A vendor ledger\.[\s\S]*For month end\.[\s\S]*Opened in 4 runs · 2 runs wrote · last used/);
  assert.equal(await used.locator('[data-act=grant-revoke]').count(), 1);
  assert.doesNotMatch(await used.innerText(), /Approving lets|also |undefined|NaN/);
  await page.mouse.click(5, 5);
});

test('only admins see Allow hosts in Waiting, for high and internal hosts, never in a sign-in', async () => {
  const at = new Date().toISOString(), allowed: [string, { host: string }][] = [];
  const refused = [{ at, run: 1, site: 'gg', login: 'bob@demo.test', hosts: ['files.example.net'], why: { 'files.example.net': 'A file-sharing site.' } },
    { at, run: 2, site: 'portal', login: 'admin@demo.test', hosts: ['sso.other.test'], why: {} }];
  // The server's answer, with an instance's refused hosts as the server would give them, until each is allowed.
  await page.route('**/api', async r => {
    const res = await r.fetch(), all = await res.json();
    all.find((w: any) => !w.archived).series.find((s: any) => !s.archived && s.instances.length).instances[0].refused = refused
      .map(e => ({ ...e, hosts: e.hosts.filter(h => !allowed.some(([, b]) => b.host === h)) })).filter(e => e.hosts.length);
    await r.fulfill({ response: res, json: all });
  });
  await page.route('**/logins/web/*/hosts?*', r => (allowed.push([new URL(r.request().url()).pathname + new URL(r.request().url()).search, r.request().postDataJSON()]), r.fulfill({ body: 'ok' })));
  await page.reload();
  await page.click('[data-act=waiting]');
  const lines = page.locator('#pv .wt', { hasText: 'was refused' });
  await page.evaluate(() => { me.role = 'user'; renderPv(); });
  assert.equal(await page.locator('#pv [data-act=allow-host]').count(), 0, 'a person never gets an Allow action, even if a cached response contains refused hosts');
  await page.evaluate(() => { me.role = 'admin'; renderPv(); });
  assert.match(await lines.nth(0).innerText(), /: run 1's browser on Bob( <bob@demo\.test>)?'s gg was refused files\.example\.net A file-sharing site\. Allow$/);
  assert.match(await lines.nth(1).innerText(), /: run 2's browser on portal was refused sso\.other\.test Allow$/);
  await lines.nth(0).locator('[data-act=allow-host]').click();
  await page.waitForSelector('#pv .creds:has-text("files.example.net")', { state: 'detached' });
  await page.locator('#pv [data-act=allow-host][data-host="sso.other.test"]').click();
  await page.waitForSelector('#pv .creds:has-text("sso.other.test")', { state: 'detached' });
  assert.deepEqual(allowed, [['/logins/web/gg/hosts?person=bob%40demo.test', { host: 'files.example.net' }], ['/logins/web/portal/hosts?person=admin%40demo.test', { host: 'sso.other.test' }]]);
  await page.unroute('**/api');
  await page.unroute('**/logins/web/*/hosts?*');
  await page.mouse.click(5, 5);
});

test("while a run's browser is open it plays in a corner of the instance, to watch: one website at a time, folded as the person last left it, one in their login popped over the page while they take control of it, and Stop browser interrupts the run", async () => {
  let browsers = ['portal', 'bank'];
  const stops: string[] = [], at = '**/api/instances/a5c0ff5e1f00';
  await page.route(at, async r => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...await res.json(), run: browsers.length ? { n: 3, cost: 0.1, browsers, yours: ['bank'] } : null } });
  });
  await page.route('**/runs/**', r => r.fulfill({ contentType: 'text/html', body: 'watching' }));
  await page.route(`${at}/interrupt`, r => (stops.push(r.request().method()), r.fulfill({ body: 'ok' })));
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f01'; });
  await page.waitForSelector('#player', { state: 'hidden' });
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  const player = page.locator('#player'), src = () => player.locator('iframe').getAttribute('src');
  await player.locator('iframe').waitFor();
  assert.deepEqual([await src(), await player.locator('.seg button').allInnerTexts()], ['/runs/a5c0ff5e1f00/portal/view?watch', ['portal', 'bank']]);
  assert.equal(await player.locator('[data-act=drive]').count(), 0, "portal's browser is in another person's login");
  await player.locator('[data-site=bank]').click();
  assert.equal(await src(), '/runs/a5c0ff5e1f00/bank/view?watch');
  await player.locator('[data-act=drive]').click();
  assert.deepEqual([await src(), await player.locator('.plh span').textContent(), await player.locator('.plh button').allTextContents(), await player.evaluate(p => [p.className, getComputedStyle(p).position, getComputedStyle(p).borderColor])],
    ['/runs/a5c0ff5e1f00/bank/view?drive', 'on bank, in your control', ['Give back control'], ['player drive', 'fixed', 'rgb(238, 136, 51)']], 'Take control pops it over the page, bordered orange');
  await player.locator('[data-act=drive]').click();
  assert.deepEqual([await src(), await player.getAttribute('class')], ['/runs/a5c0ff5e1f00/bank/view?watch', 'player'], 'and Give back control puts it back in its corner');
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

test('a thread is a tree: a reply hangs under the comment it answers, three levels deep, past which the rest opens on its own, and a long comment folds', async () => {
  await page.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
  await page.waitForSelector('#newcomment');
  const seqs = await page.evaluate(async () => {
    const out: number[] = [];
    for (const text of ['Tree root.', 'Level one.', 'Level two.', 'Level three.', 'Level four.', Array(20).fill('A long line.').join('\n')]) {
      await fetch('/api/instances/a5c0ff5e1f00/comment', { method: 'POST', body: JSON.stringify({ text, quiet: true, ...(out.length && out.length < 5 && { thread: `c${out.at(-1)}` }) }) });
      out.push((await (await fetch('/api/instances/a5c0ff5e1f00')).json()).log.at(-1).seq);
    }
    return out;
  });
  const [root, one, two, three, four, long] = seqs.map(n => `.post[data-seq="${n}"]`);
  await page.waitForSelector(`#conv ${long}`);
  assert.equal(await page.locator(`#conv ${root} > .kids > ${one} > .kids > ${two} > .kids > ${three}`).count(), 1);
  assert.equal(await page.locator(`#conv ${four}`).count(), 0);
  await page.click(`#conv ${three} > a.more:text-is("Continue this thread \u2192 1 more")`);
  await page.waitForSelector(`#conv ${four}`);
  assert.deepEqual(await page.locator('#conv a.up').allInnerTexts(), ['you: Tree root.', 'you: Level one.', 'you: Level two.']);
  await page.click('#conv > a.more:text-is("\u2190 Back to the conversation")');
  await page.waitForSelector(`#conv ${four}`, { state: 'detached' });
  assert.equal(await page.locator(`#conv ${long} > .pb.long`).count(), 1);
  await page.click(`#conv ${long} > a.more:text-is("More")`);
  await page.waitForSelector(`#conv ${long} > .pb:not(.long)`);
  await page.click(`#conv ${one} > .pa [data-act=reply]`);
  await page.fill(`#conv ${one} > .reply textarea`, 'A branch.');
  await page.click(`#conv ${one} > .reply [data-act=reply-post]`);
  await page.locator(`#conv ${one} > .kids > .post`, { hasText: 'A branch.' }).waitFor();
  assert.equal(await page.locator(`#conv ${one} > .reply:not([hidden])`).count(), 0, 'sent, its box closes');
});

test("conversation drafts and picked files stay with their instance, including an open reply at the same seq", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f00', page.url()).href);
    await tab.waitForSelector('#newcomment');
    await tab.fill('#newcomment', 'A draft for the pack');
    await tab.setInputFiles('#newfiles', { name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') });
    await tab.click('#conv .post[data-seq="2"] > .pa [data-act=reply]');
    await tab.fill('#conv .post[data-seq="2"] > .reply textarea', 'A reply for the pack');
    await tab.setInputFiles('#conv .post[data-seq="2"] > .reply input[type=file]', { name: 'reply.txt', mimeType: 'text/plain', buffer: Buffer.from('reply') });
    await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f02'; });
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
    assert.equal(await tab.inputValue('#newcomment'), '');
    assert.equal(await tab.locator('#conv .post[data-seq="2"] > .reply').isHidden(), true);
    assert.equal(await tab.locator('#conv').textContent().then(s => s!.includes('The pack is ready')), false);
    await tab.fill('#newcomment', 'A draft for October');
    await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f00'; });
    await tab.waitForSelector('#bar h1 .t:text-is("2026-12")');
    assert.equal(await tab.inputValue('#newcomment'), 'A draft for the pack');
    assert.equal(await tab.inputValue('#conv .post[data-seq="2"] > .reply textarea'), 'A reply for the pack');
    assert.equal(await tab.locator('#conv .post[data-seq="2"] > .reply input[type=file]').evaluate((e: HTMLInputElement) => e.files![0].name), 'reply.txt');
    assert.equal(await tab.locator('#newfiles').evaluate((e: HTMLInputElement) => e.files![0].name), 'draft.txt');
    assert.equal(await tab.locator('#conv .post[data-seq="2"] > .reply').isVisible(), true);
    await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f02'; });
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
    assert.equal(await tab.inputValue('#newcomment'), 'A draft for October');
  } finally { await tab.close(); }
});

test("a link opened signed out lands where it points once signed in, and a session lapsing as a comment is sent keeps the comment and reply being written through signing in again", async () => {
  const context = await browser.newContext(), tab = await context.newPage();
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f07/c3', page.url()).href);
    await tab.click('a.ms');
    await tab.waitForSelector('#bar h1 .t:text-is("January")');
    await tab.waitForSelector('#conv .post.flash[data-seq="3"]');
    await tab.fill('#newcomment', 'A long careful comment');
    await tab.click('#conv .post[data-seq="3"] > .pa [data-act=reply]');
    await tab.fill('#conv .post[data-seq="3"] > .reply[data-mode=reply] textarea', 'A careful reply');
    await context.clearCookies();
    await tab.click('#log [data-act=comment]');
    await tab.click('a.ms');
    await tab.waitForSelector('#bar h1 .t:text-is("January")');
    assert.deepEqual(await Promise.all(['#newcomment', '#conv .post[data-seq="3"] > .reply[data-mode=reply] textarea'].map(s => tab.inputValue(s))), ['A long careful comment', 'A careful reply']);
  } finally { await context.close(); }
});

test("a page whose event stream fails, as behind a proxy while the server restarts, waits for the server rather than reloading, then listens again and catches up", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() }), down = (r: { fulfill: (o: object) => Promise<void> }) => r.fulfill({ status: 502, body: '' });
  try {
    await tab.route('**/api/events', down);
    await tab.goto(new URL('/#/a5c0ff5e1f07', page.url()).href);
    await tab.waitForSelector('#bar h1 .t:text-is("January")');
    await tab.route('**/me', down);
    await tab.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; });
    await tab.waitForTimeout(7000);
    await tab.unrouteAll();
    await page.evaluate(() => api('/api/instances/a5c0ff5e1f07/comment', { method: 'POST', body: JSON.stringify({ text: 'Said while it was away.', quiet: true }) }));
    await tab.waitForFunction(() => data.log.some((e: { text?: string }) => e.text === 'Said while it was away.'), null, { timeout: 15_000 });
    assert.equal(await tab.evaluate(() => (window as unknown as { kept?: boolean }).kept), true, 'never reloaded');
  } finally { await tab.close(); }
});

test("a comment or reply uploading attachments posts to its original instance after navigation", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    for (const reply of [false, true]) {
      await tab.goto(new URL('/#/a5c0ff5e1f00', page.url()).href);
      await tab.waitForSelector('#newcomment');
      const box = reply ? '#conv .post[data-seq="2"] > .reply' : '#conv .compose';
      if (reply) await tab.click('#conv .post[data-seq="2"] > .pa [data-act=reply]');
      await tab.fill(`${box} textarea`, `Uploading ${reply ? 'reply' : 'comment'}`);
      await tab.setInputFiles(`${box} input[type=file]`, ['one', 'two'].map(name => ({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(name) })));
      let release!: () => void, started!: () => void;
      const held = new Promise<void>(ok => { release = ok; }), uploading = new Promise<void>(ok => { started = ok; });
      const paths: string[] = [];
      await tab.route('**/attach?*', async r => {
        paths.push(new URL(r.request().url()).pathname);
        if (paths.length === 1) { started(); await held; }
        await r.continue();
      });
      const posted = tab.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/comment'));
      await tab.click(`${box} [data-act=${reply ? 'reply-post' : 'comment'}]`);
      await uploading;
      await tab.evaluate(() => { location.hash = '#/a5c0ff5e1f02'; });
      await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
      await tab.fill('#newcomment', 'Do not clear this draft');
      release();
      const request = await posted;
      assert.equal(new URL(request.url()).pathname, '/api/instances/a5c0ff5e1f00/comment');
      assert.deepEqual(paths, ['/api/instances/a5c0ff5e1f00/attach', '/api/instances/a5c0ff5e1f00/attach']);
      assert.equal(request.postDataJSON().thread, reply ? 'c2' : undefined);
      await tab.waitForResponse(r => r.request() === request);
      assert.equal(await tab.inputValue('#newcomment'), 'Do not clear this draft');
      await tab.unroute('**/attach?*');
    }
  } finally { await tab.close(); }
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
  await page.locator('#log .post:not(.ask) > .pa [data-act=reply]').first().click();
  const reply = '#log .post .reply:not([hidden]) textarea';
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

test("a workbook's full-sheet merge is clipped to the preview's rows and columns", async () => {
  const book = execFileSync('python3', ['-c', `
import io, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as dst:
    for name in src.namelist():
        data = src.read(name)
        if name == 'xl/workbook.xml':
            data = data.replace(b'activeTab="2"', b'activeTab="0"')
        if name == 'xl/worksheets/sheet1.xml':
            data = data.replace(b'ref="A5:C5"', b'ref="A1:XFD1048576"')
        dst.writestr(name, data)
sys.stdout.buffer.write(out.getvalue())
`], { input: readFileSync(join(app, 'test', 'formats.xlsx')) });
  writeFileSync(join(root, 'instances', 'a5c0ff5e1f00', 'working', 'merged.xlsx'), book);
  const response = await page.request.get(new URL('/preview/a5c0ff5e1f00/working/merged.xlsx', page.url()).href);
  assert.equal(response.status(), 200);
  const sheet = (await response.json()).sheets[0];
  assert.deepEqual(sheet.merged, [[0, 0, sheet.rows.length - 1, Math.max(...sheet.rows.map((r: unknown[]) => r.length)) - 1]]);
});

test("the page expands a merge only over the cells the preview shows", async () => {
  const html = await page.evaluate(() => {
    const add = Set.prototype.add;
    let cells = 0;
    Set.prototype.add = function (value) {
      if (typeof value === 'string' && /^\d+,\d+$/.test(value) && ++cells > 6) throw new Error('merge expanded outside the preview');
      return add.call(this, value);
    };
    try {
      return sheetTable({}, { name: 'Sheet', rows: [['merged', null, null], [null, null, null]], merged: [[0, 0, 1048575, 16383]] }, true);
    } finally { Set.prototype.add = add; }
  });
  assert.match(html, /rowspan="2" colspan="3"/);
  assert.equal((html.match(/data-act="cell"/g) ?? []).length, 1);
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
  await page.click('#card .acts [data-act=preview]');
  await page.waitForSelector('#pv table.sh td');
  await page.keyboard.press('Escape');
  await page.click('#card [data-act=uncard]');
});

for (const act of ['comment-on', 'thread', 'comment-cell']) test(`${act} from a card or Preview switches Audit to the conversation and focuses a visible box`, async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f02', page.url()).href);
    await tab.waitForSelector('#newcomment');
    await tab.evaluate(async () => {
      await api(`${instPath()}/comment`, { method: 'POST', body: JSON.stringify({ text: 'Check the tie-out.', item: 'tie', quiet: true }) });
      await refresh();
    });
    await tab.click('#log .seg [data-act=audit]');
    await tab.waitForSelector('#audit:not([hidden])');
    await tab.click('#steps .tile[data-item=tie]');
    await tab.waitForSelector('#card .cpv table.sh');
    if (act === 'comment-cell') {
      await tab.click('#card .acts [data-act=preview]');
      await tab.click('#pv table.sh [data-act=cell]');
      await tab.click('#pvn [data-act=comment-cell]');
    } else await tab.click(`#card [data-act=${act}] >> nth=0`);
    assert.equal(await tab.locator('#conv').isVisible(), true);
    assert.equal(await tab.locator('#audit').isVisible(), false);
    assert.equal(await tab.textContent('#log .seg .sel'), 'Conversation');
    assert.equal(await tab.evaluate(() => document.activeElement?.matches('#conv textarea') && (document.activeElement as HTMLElement).checkVisibility()), true);
  } finally { await tab.close(); }
});

test("an instance is its Inputs, Steps and Outputs, left to right, each heading whole over its tiles; hovering an item marks what it's made from, which its card names; the list view, kept in this browser, shows each slice as a list, one over the other, sorting by a column", async () => {
  await page.evaluate(() => location.hash === '#/3d70f7ca6f20' || new Promise(ok => { addEventListener('hashchange', ok, { once: true }); location.hash = '#/3d70f7ca6f20'; }));
  await page.waitForSelector('#steps .tile .fn:text-is("Eligible AR")');
  await page.setViewportSize({ width: 1280, height: 300 });
  assert.deepEqual(await page.evaluate(() => ['#ins', '#steps', '#outs'].map(p => document.querySelector(p)!.getBoundingClientRect().left).every((x, k, xs) => !k || x > xs[k - 1])), true);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#panes .ph')].map(h => h.scrollHeight <= h.clientHeight)), [true, true, true], 'a slice that scrolls keeps its heading whole');
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.deepEqual(await page.locator('#ins .tile .fn').allTextContents(), ['AR aging', 'Inventory at cost']);
  assert.deepEqual(await page.locator('#outs .tile .fn').allTextContents(), ['Borrowing base']);
  await page.hover('#outs .tile[data-item=borrowing-base]');
  assert.deepEqual(await page.locator('#panes .made').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.item)), ['ar-aging', 'inventory', 'eligible'], 'through the step too');
  assert.deepEqual(await page.locator('#panes .far').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.item)), ['ar-aging'], 'what its sources are made from, fainter');
  await page.click('#view [data-id=list]');
  assert.equal(await page.evaluate(() => localStorage.view), 'list');
  assert.deepEqual(await page.locator('#ins .lst th').allTextContents(), ['Name', 'Source', 'By', 'Changed', 'Threads']);
  assert.deepEqual(await page.locator('#outs .lst th').allTextContents(), ['Name', 'Destination', 'By', 'Headline', 'Changed', 'Threads'], "a headline is an output's");
  assert.deepEqual(await page.locator('#outs .lrow td:nth-child(5)').allTextContents(), ['changed'], 'since 2026-08-23, by content');
  assert.deepEqual(await page.locator('#steps .lrow').evaluateAll(rs => rs.map(r => [r.querySelector('.fn')!.textContent, r.children[1].textContent])), [['Eligible AR', 'AR aging']], 'a step by what it is made from');
  assert.deepEqual(await page.evaluate(() => ['#ins', '#steps', '#outs'].map(p => document.querySelector(p)!.getBoundingClientRect().top).every((y, k, ys) => !k || y > ys[k - 1])), true, 'one over the other');
  await page.click('#ins .lst th:text-is("Name")');
  await page.click('#ins .lst th:text-is("Name")');
  assert.deepEqual(await page.locator('#ins .lrow .fn').allTextContents(), ['Inventory at cost', 'AR aging'], 'a second click reverses it');
  await page.click('#outs .lrow[data-item=borrowing-base]');
  await page.click('#card a:text-is("Eligible AR")');
  await page.waitForSelector('#card .cp:text("Made from AR aging")');
  await page.click('#card [data-act=uncard]');
  await page.click('#view [data-id=tiles]');
  await page.waitForSelector('#ins .tile');
});

test("a line of an item's markdown someone doesn't accept is a comment at it, by its opening words, marked where it stands", async () => {
  await page.evaluate(() => location.hash === '#/a5c0ff5e1f02' || new Promise(ok => { addEventListener('hashchange', ok, { once: true }); location.hash = '#/a5c0ff5e1f02'; }));
  await page.click('#steps .tile[data-item=notes]');
  await page.waitForSelector('#card .say .pt');
  assert.deepEqual(await page.locator('#card .say .pt').allTextContents(), ['2 checks pass', '\u2022 The ledger ties to the pack.', '\u2022 Judgment: the October accrual is carried at the September rate, as agreed with the controller.']);
  await page.click('#card .say .pt:has-text("Judgment")');
  await page.click('#pv .say .pt:has-text("Judgment")');
  await page.click('#pvn [data-act=comment-cell]');
  assert.equal(await page.textContent('.compose h3'), 'Comment on Notes at Judgment: the October accrual is carried at the September\u2026');
  await page.fill('#newcomment', 'Use the October rate.');
  await page.click('[data-act=comment]');
  await page.waitForSelector('#card .say .pt.noted:has-text("Judgment")');
  assert.equal(await page.locator('#card .say .pt.noted').count(), 1, 'the point it names, and no other');
  await page.click('#card [data-act=uncard]');
});

test("a series' + makes an instance that waits for its first upload or comment, which starts its run", async () => {
  const row = '.row.ser:has(.l:text-is("Year-end pack"))';
  await page.hover(row);
  await page.click(`${row} [data-act=new-instance]`);
  await page.fill('#slabel', '2027-01');
  await page.click('[data-act=start-go]:text-is("Make")');
  await page.waitForSelector('#bar h1 .t:text-is("2027-01")');
  await new Promise(r => setTimeout(r, 2000));
  assert.deepEqual(await page.evaluate(() => data.log.map(e => e.op)), ['create'], 'no wake, and no run');
  assert.match(await page.textContent('#bar .state') ?? '', /^Waiting for files/);
  await page.fill('#newcomment', 'Roll it forward.');
  await page.click('[data-act=comment]');
  await page.waitForSelector('#bar .state .bad:text("Run 1 failed")');
});

test("the site's bare address opens the sidebar's first workspace, not the first by name, which is no one's, and then names what it shows", async () => {
  const { id } = await page.evaluate(() => fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Apple' }) }).then(r => r.json()));
  await page.evaluate(id => fetch(`/api/workspaces/${id}`, { method: 'PUT', body: JSON.stringify({ owners: [] }) }), id);
  await page.evaluate(() => history.replaceState(null, '', '/'));
  await page.reload();
  await page.waitForSelector('.row.ws.on');
  assert.equal(await page.textContent('.row.ws.on .l'), 'larkfield');
  assert.equal(await page.evaluate(() => location.hash), await page.getAttribute('a.row.inst.on', 'href'));
});

test('only managers see Delete in an archive, its confirmation warns what stays, and a deleted instance has no change controls', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const origin = new URL(page.url()).origin;
  const { id, sid } = await page.evaluate(async () => {
    const post = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const { id: ws } = await post('/api/workspaces', { name: 'Deleted page', members: ['watcher@demo.test'] });
    await fetch(`/api/workspaces/${ws}`, { method: 'PUT', body: JSON.stringify({ owners: ['admin@demo.test'], members: ['watcher@demo.test'] }) });
    const { id: sid } = await post('/api/series', { workspace: ws, name: 'Records' });
    const { id } = await post(`/api/series/${sid}`, { label: 'Private', quiet: true });
    await fetch(`/api/series/${sid}`, { method: 'PUT', body: JSON.stringify({ archived: true }) });
    return { id, sid };
  });
  entra.who.as = 'watcher@demo.test';
  const watcher = await browser.newPage();
  await watcher.goto(`${origin}/auth/login`);
  await watcher.goto(`${origin}/#/${id}`);
  await watcher.waitForSelector('#bar .state:text-is("Archived · read-only")');
  assert.equal(await watcher.locator('[data-act=delete]').count(), 0);
  await watcher.close();
  entra.who.as = 'admin@demo.test';
  await page.goto(`${origin}/#/${id}`);
  await page.waitForSelector('#bar .state:text-is("Archived · read-only")');
  await page.click('#bar [data-act=delete]');
  assert.match(await page.textContent('#ask') ?? '', /can.t be brought back/);
  assert.match(await page.textContent('#ask') ?? '', /Copies outside the server stay/);
  await page.click('#ask button[value=ok]');
  await page.waitForSelector('#bar .state:text("Deleted by")');
  assert.equal(await page.locator('#bar [data-act=delete], #bar [data-act=rename], #bar [data-act=takeover], #bar [data-act=start-series]').count(), 0);
  assert.match(await page.textContent('#ins') ?? '', /Nothing is left of it here/);
  if (!await page.locator(`a.row.inst.deleted[href="#/${id}"]`).count()) await page.click(`[data-act=toggle-closed][data-id="${sid}"]`);
  assert.equal(await page.locator(`a.row.inst.deleted[href="#/${id}"] .nm`).evaluate(el => getComputedStyle(el).textDecorationLine), 'line-through');
});

test('a service connects with one click and no sign-in, then lends the admin\'s prefixes as ordinary instance ticks', async () => {
  assert.equal(await page.evaluate(() => api('/connections/drop', { method: 'PUT', body: JSON.stringify({ type: 'service', url: 'http://127.0.0.1:9000', paths: 'AP/,GL/2026/', key: 'deployment-secret' }) }).then(() => 200)), 200);
  await page.evaluate(() => openLogins());
  await page.waitForSelector('#pv [data-act=service-connect][data-id=drop]');
  assert.match(await page.locator('#pv .lline', { hasText: 'Service drop' }).innerText(), /https:\/\/drop\.rf\.internal\//);
  await page.click('#pv [data-act=service-connect][data-id=drop]');
  await page.waitForSelector('#pv [data-act=logins-show][data-id=drop]');
  await page.click('#pv [data-act=logins-show][data-id=drop]');
  assert.deepEqual(await page.locator('#pv .lsub').allTextContents(), ['AP/ at https://drop.rf.internal/', 'GL/2026/ at https://drop.rf.internal/']);
  assert.equal(await page.locator('#pv [data-act=unoffer][data-login=drop]').count(), 0);
  await page.mouse.click(5, 5);
  await page.evaluate(() => openStart('New instance', 'Start', () => {}, '', ['drop:AP/']));
  await page.waitForSelector('#pv input.tick[value="drop:AP/"]');
  assert.deepEqual(await page.locator('#pv .tkind', { hasText: 'Services' }).locator('input.tick').evaluateAll(ts => ts.map(t => [(t as HTMLInputElement).value, (t as HTMLInputElement).checked])), [['drop:AP/', true], ['drop:GL/2026/', false]]);
  await page.mouse.click(5, 5);
  await page.evaluate(() => openLogins());
  await page.click('#pv [data-act=logins-show][data-id=drop]');
  await page.click('#pv [data-act=signout-login][data-id=drop]');
  await page.waitForSelector('#pv [data-act=service-connect][data-id=drop]');
  await page.mouse.click(5, 5);
  await page.evaluate(() => api('/connections/drop', { method: 'DELETE' }));
});

test("a website ticked without an approved grant in the instance's workspace says so where it's ticked, with the ask there, whom it waits on, or to sign in first; asked by one who may approve it, it's approved at once, which it says in place above a first prompt being written", async t => {
  const rf = join(root, '.rf'), mine = join(rf, 'people', createHash('sha256').update('admin@demo.test').digest('hex').slice(0, 16)), since = new Date().toISOString();
  const site = (url: string) => ({ url, hosts: [], writeback: true, added: since, profile: { what: 'A company ledger.', category: 'company', risk: 'low', flags: [] } });
  const login = (name: string, expired = false) => ({ id: `web:${name}`, kind: 'website', name, since, offers: [{ id: `web:${name}`, name }], ...(expired && { expired }) });
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'websites.json'), JSON.stringify({ ledger: site('https://ledger.test/'), bank: site('https://bank.test/'), erp: site('https://erp.test/') }));
  writeFileSync(join(mine, 'logins.json'), JSON.stringify([login('ledger'), login('bank'), login('erp', true)]));
  t.after(async () => {
    for (const f of [join(mine, 'logins.json'), join(mine, 'websites.json'), join(rf, 'grants.json')]) rmSync(f, { force: true });
    await page.keyboard.press('Escape');
    await page.evaluate(() => refresh());
  });
  const { id } = await page.evaluate(() => api('/api/series/a5c0ff5e1fef', { method: 'POST', body: JSON.stringify({ label: '2027-02', logins: [], quiet: true }) }));
  await page.evaluate(async id => { location.hash = `#/${id}`; await refresh(); }, id);
  await page.waitForSelector('#bar h1 .t:text-is("2027-02")');
  if (!await page.locator('#log.open').count()) await page.click('#bar [data-act=panel]');
  const needs = (where: string, name: string) => page.locator(`${where} label:has(input.tick[value="web:${name}"]) + .nogrant`), toast = () => page.locator('#toasts .toast').last().textContent();

  // Above the comment box before the first run: said only once ticked, with the ask right there.
  assert.equal(await needs('#log', 'ledger').isVisible(), false, 'unticked, it says nothing');
  await page.check('#log input.tick[value="web:ledger"]');
  await page.waitForFunction(() => data.runner.logins.includes('web:ledger'));
  assert.equal(await needs('#log', 'ledger').locator('> :not(.row2)').count(), 0);
  assert.match(await needs('#log', 'ledger').innerText(), /^Runs in larkfield can't use ledger until it's approved there\. Say what runs here use it for and ask: you manage larkfield, so it's approved at once\.\s+Ask to use$/);
  await needs('#log', 'ledger').locator('input').fill('Month-end ledger pulls');
  await page.fill('#newcomment', 'Pull the ledger.');
  await needs('#log', 'ledger').locator('[data-act=grant-ask]').click();
  await needs('#log', 'ledger').waitFor({ state: 'detached' });
  assert.equal(await page.inputValue('#newcomment'), 'Pull the ledger.', 'a first prompt being written stays as the ask is said to be approved');
  await page.fill('#newcomment', '');
  assert.equal(await toast(), "Approved at once, as you're an admin.", 'larkfield has no owners: it is the admins\'');
  const [granted] = Object.values(JSON.parse(readFileSync(join(rf, 'grants.json'), 'utf8'))) as any[];
  assert.deepEqual([granted.site, granted.workspace, granted.reason, granted.state, granted.by, typeof granted.decided], ['ledger', '1b3031035ff6', 'Month-end ledger pulls', 'approved', 'admin@demo.test', 'string']);

  // With the Credentials chip later: an expired login says to sign in first, with the link; asking keeps the ticks not yet saved.
  await page.click('#bar [data-act=ticks]');
  await page.waitForSelector('#pv input.tick[value="web:bank"]');
  assert.deepEqual([await needs('#pv', 'ledger').count(), await needs('#pv', 'bank').isVisible(), await needs('#pv', 'erp').isVisible()], [0, false, false], 'approved, or unticked, it says nothing');
  await page.check('#pv input.tick[value="web:erp"]');
  assert.equal(await needs('#pv', 'erp').innerText(), "Runs in larkfield can't use erp until it's approved there. Sign in to it again under Logins first, then ask here.");
  assert.equal(await needs('#pv', 'erp').locator('a[data-act=logins]').textContent(), 'Logins');
  await page.check('#pv input.tick[value="web:bank"]');
  await needs('#pv', 'bank').locator('input').fill('Bank statements');
  await needs('#pv', 'bank').locator('[data-act=grant-ask]').click();
  await needs('#pv', 'bank').waitFor({ state: 'detached' });
  assert.equal(await toast(), "Approved at once, as you're an admin.");
  assert.deepEqual(await page.$$eval('#pv input.tick:checked', ts => ts.map(t => (t as HTMLInputElement).value)), ['web:ledger', 'web:bank'], 'the ticks not yet saved stay, an expired login\'s off as ever');

  // For someone who doesn't manage the workspace: who approves, by name, and once asked, whom it waits on.
  const as = (grants: object[]) => page.evaluate(grants => { Object.assign(tree.find(w => w.id === cur.w.id), { manage: false, owners: ['bob@demo.test'], grants }); pv.settings.on = ticked(); renderPv(); }, grants);
  await as([]);
  assert.match(await needs('#pv', 'ledger').innerText(), /^Runs in larkfield can't use ledger until it's approved there\. Say what runs here use it for and ask: larkfield's owners, (Bob|Bob <bob@demo\.test>|bob@demo\.test), approve it, unless only an admin may approve this website\.\s+Ask to use$/);
  const asked = { id: 'p1', workspace: '1b3031035ff6', person: 'admin@demo.test', site: 'ledger', state: 'pending', at: new Date().toISOString(), adminOnly: false };
  await as([asked]);
  assert.match(await needs('#pv', 'ledger').innerText(), /^Runs in larkfield can't use ledger until it's approved there\. You asked .+; it waits on larkfield's owners, (Bob|Bob <bob@demo\.test>|bob@demo\.test)\.$/);
  assert.equal(await needs('#pv', 'ledger').locator('[data-act=grant-ask]').count(), 0);
  await as([{ ...asked, adminOnly: true }]);
  assert.match(await needs('#pv', 'ledger').innerText(), /You asked .+; it waits on an admin\.$/, 'what the check reserves for admins waits on one');
  await page.keyboard.press('Escape');

  // On the Logins page, under the website, choosing the workspace, the page says what came of it.
  await page.evaluate(async () => { await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Ledgers' }) }); await refresh(); await openLogins(); });
  await page.click('#pv [data-act=logins-show][data-id=web]');
  const row = page.locator('#pv .row2:has([data-act=grant-ask][data-id=ledger])');
  await row.locator('select').selectOption({ label: 'Ledgers' });
  await row.locator('input').fill('Ledger pulls there too');
  await row.locator('[data-act=grant-ask]').click();
  await page.locator('#pv .grant', { hasText: 'Ledgers' }).waitFor();
  assert.equal(await toast(), "Approved at once, as you're an owner of Ledgers.");
  assert.equal(Object.values(JSON.parse(readFileSync(join(rf, 'grants.json'), 'utf8'))).filter((g: any) => g.site === 'ledger' && g.state === 'approved').length, 2);
});

test("a wake carries a message; a series' notes thread takes notes from the sidebar, counted on its open instances, which its runners settle, folded with who and why; another instance's agent's note says whose it is", async () => {
  const tab = await browser.newPage({ storageState: await page.context().storageState() });
  try {
    await tab.goto(new URL('/#/a5c0ff5e1f02', page.url()).href);
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
    if (!await tab.locator('#log.open').count()) await tab.click('#bar [data-act=panel]');
    assert.equal(await tab.locator('#conv .post[data-seq="3"] > b').innerText(), 'Agent of Year-end pack \u00b7 2026-12, for Demo Admin');
    assert.equal(await tab.locator('#conv .post[data-seq="3"] > b a').getAttribute('href'), '#/a5c0ff5e1f00');

    await tab.click('#bar [data-act=wakes]');
    const add = tab.locator('#pv .wakerow').last();
    await add.locator('.wat').fill('2031-01-06T09:00');
    await add.locator('.wtext').fill('The bank file should be in');
    await add.locator('[data-act=wake-save]').click();
    await tab.waitForSelector('#pv .wakerow[data-id]:not([data-id=""])');
    assert.equal(await tab.locator('#pv .wakerow[data-id]:not([data-id=""]) .wtext').inputValue(), 'The bank file should be in');
    await tab.locator('#pv .wakerow[data-id]:not([data-id=""]) [data-act=wake-delete]').click();
    await tab.mouse.click(5, 5);

    assert.equal(await tab.locator('#bar .crumb a').count(), 0, 'no open notes, no link');
    await tab.click('.row.ser.on + .tree .row.notes [data-act=notes]');
    await tab.waitForSelector('#pv .pvh b:text-is("Notes on Year-end pack")');
    assert.match(await tab.locator('#pv .pvb').innerText(), /No open notes/);
    await tab.fill('#notetext', 'From January the pack goes to the new bank');
    await tab.click('#pv [data-act=note-post]');
    await tab.waitForSelector('#pv .note .pb:text-is("From January the pack goes to the new bank")');
    await tab.waitForSelector('.row.ser.on + .tree .row.notes .n:text-is("1 open")');
    await tab.mouse.click(5, 5);
    await tab.click('#bar .crumb a:text-is("1 open note")');
    await tab.waitForSelector('#pv .pvh b:text-is("Notes on Year-end pack")');
    await tab.click('#pv [data-act=note-taken]');
    assert.equal(await tab.locator('#pv details.note').count(), 0, 'settling takes a why');
    await tab.fill('#pv .note input', 'In the process now');
    await tab.click('#pv [data-act=note-taken]');
    await tab.waitForSelector('#pv details.note');
    assert.equal(await tab.locator('#pv details.note summary').innerText(), 'From January the pack goes to the new bank \u00b7 Acted on by Demo Admin');
    await tab.click('#pv details.note summary');
    assert.match(await tab.locator('#pv details.note').innerText(), /Acted on by Demo Admin · .+: In the process now/);
    await tab.mouse.click(5, 5);
    await tab.waitForSelector('#bar .crumb a', { state: 'detached' });
    assert.equal(await tab.locator('.row.ser.on + .tree .row.notes .n').innerText(), '');
  } finally {
    await tab.close();
  }
});

test("Assign… on the bar hands an instance to whoever sees its workspace, who sees it under Waiting on you until they open it, and wakes it from a request to wake it as it is; Mine shows only the open instances you run, and the series and workspace shown, as this browser keeps it for you", async () => {
  const origin = new URL(page.url()).origin;
  entra.who.as = 'handed@demo.test';
  const handed = await browser.newPage(), chan = 'chan.taiman.finance-and-accounting@demo.test';
  await handed.goto(`${origin}/auth/login`);
  entra.who.as = chan;
  await (await browser.newPage()).goto(`${origin}/auth/login`);
  entra.who.as = 'admin@demo.test';
  const { mine, theirs, sid, unrun, empty } = await page.evaluate(async () => {
    const post = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const { id: ws } = await post('/api/workspaces', { name: 'Handing' });
    await fetch(`/api/workspaces/${ws}`, { method: 'PUT', body: JSON.stringify({ owners: ['admin@demo.test'], members: ['handed@demo.test', 'chan.taiman.finance-and-accounting@demo.test'] }) });
    const { id: sid } = await post('/api/series', { workspace: ws, name: 'Rec' });
    const { id: unrun } = await post('/api/workspaces', { name: 'Unrun' }), { id: empty } = await post('/api/series', { workspace: unrun, name: 'Empty' });
    return { sid, unrun, empty, theirs: (await post(`/api/series/${sid}`, { label: 'H1', quiet: true })).id, mine: (await post(`/api/series/${sid}`, { label: 'H2', quiet: true })).id };
  });
  await page.goto(`${origin}/#/${theirs}`);
  await page.reload();
  await page.waitForSelector('#bar [data-act=assign]');
  assert.deepEqual(await page.locator('#bar .btn').allTextContents(), ['No wake', 'Close', 'Assign\u2026'], 'its runner closes it or hands it on');
  await page.click('#bar [data-act=assign]');
  await page.waitForSelector('#assignto option', { state: 'attached' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await page.locator('#assignto option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value).sort()), [chan, 'handed@demo.test'], 'whoever sees its workspace but its runner and you');
  assert.match(await page.locator(`#assignto option[value="${chan}"]`).textContent() ?? '', /^陳大文（財務及會計部，香港辦事處） </);
  const [select, dialog] = await Promise.all(['#assignto', '#ask'].map(s => page.locator(s).boundingBox()));
  assert.ok(select!.x + select!.width <= dialog!.x + dialog!.width - 16, 'the picker keeps within the dialog on a phone, a long name and address too');
  assert.doesNotMatch(await page.textContent('#ask') ?? '', /stops it/);
  await page.evaluate('data.run = { n: 7 }');
  await page.selectOption('#assignto', 'handed@demo.test');
  const sent = page.waitForRequest(r => r.url().endsWith(`/api/instances/${theirs}/assign`));
  await page.click('#ask button[value=ok]');
  assert.deepEqual((await sent).postDataJSON(), { to: 'handed@demo.test', stops: null }, 'saying it stops no run, as it said: one started since is refused');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForSelector('#bar [data-act=takeover]');
  await page.click('#bar [data-act=takeover]');
  await page.waitForSelector('#pv [data-act=start-go]');
  await page.evaluate('data.run = { n: 9 }');
  let tookStops: unknown = 'unset';
  await page.route(`**/api/instances/${theirs}/assign`, r => { tookStops = r.request().postDataJSON().stops; return r.fulfill({ status: 200, contentType: 'application/json', body: '"ok"' }); });
  await page.click('#pv [data-act=start-go]');
  await page.waitForSelector('#pv [data-act=start-go]', { state: 'hidden' });
  assert.equal(tookStops, null, 'Take over likewise sends stops: null when opened idle, though a run started since');
  await page.unroute(`**/api/instances/${theirs}/assign`);
  assert.match(await page.textContent('#bar .owner .about') ?? '', /Assigned by you, from you,/);
  await handed.goto(`${origin}/#/${mine}`);
  await handed.click('[data-act=waiting]');
  assert.match(await handed.textContent('#pv') ?? '', /Demo Admin assigned you Handing · Rec · H1/);
  await handed.click(`#pv a[href="#/${theirs}"]`);
  await handed.waitForSelector('#bar .owner:text-is("Yours")');
  assert.equal(await handed.locator('.row.waits').count(), 0, 'opening it, they were told, as it shows');
  // A wake pending as it was assigned, come as a request to wake it.
  const wakes = join(root, '.rf', 'wakes.json'), w = JSON.parse(readFileSync(wakes, 'utf8'));
  writeFileSync(wakes, JSON.stringify({ ...w, requests: { ...w.requests, handing: { series: sid, label: 'H1', target: theirs, from: 'admin@demo.test', at: new Date().toISOString(), text: 'the statement is due' } } }));
  await handed.reload();
  await handed.click('[data-act=waiting]');
  assert.match(await handed.textContent('#pv') ?? '', /^(?!.*assigned you).*asks to wake H1 Wake/s, 'opening it, they were told');
  await handed.click('#pv [data-act=req-start]');
  await handed.waitForSelector('#bar .owner:text-is("Yours")');
  assert.equal(await handed.locator('#pv .slabel, #slabel').count(), 0, 'no credentials to tick: its runner\'s are');
  assert.deepEqual(await handed.evaluate(async id => (await (await fetch(`/api/instances/${id}`)).json()).log.filter(e => e.op === 'wake').map(e => [e.from, e.note ?? false]), theirs), [['admin@demo.test', true], ['handed@demo.test', false]]);
  await handed.reload();
  await handed.waitForSelector('#bar h1 .t');
  assert.equal(await handed.locator('.row.waits').count(), 0, 'waking it, the request went');
  await handed.close();
  await page.goto(`${origin}/#/${mine}`);
  await page.waitForSelector(`a.row.inst[href="#/${theirs}"]`);
  await page.click('.find .mine');
  await page.waitForSelector(`a.row.inst[href="#/${theirs}"]`, { state: 'detached' });
  assert.equal(await page.locator(`a.row.inst[href="#/${mine}"]`).count(), 1);
  assert.ok(await page.locator('a.row.inst').evaluateAll(rows => rows.length > 0));
  assert.equal(await page.evaluate(() => localStorage['mine:admin@demo.test']), 'on');
  for (const at of [empty, unrun]) {
    await page.goto(`${origin}/#/${at}`);
    await page.waitForSelector(`.row.ser.on a[href="#/${empty}"]`);
    assert.equal(await page.locator(`.row.ws.on a[href="#/${unrun}"]`).count(), 1, 'the series and workspace shown stay, though you run nothing there');
  }
  await page.goto(`${origin}/#/${mine}`);
  await page.waitForSelector(`a[href="#/${unrun}"]`, { state: 'detached' });
  assert.equal(await page.locator(`a[href="#/${empty}"]`).count(), 0);
  await page.click('.find .mine');
  await page.waitForSelector(`a.row.inst[href="#/${theirs}"]`);
});

test("an expired login's banner on an instance agrees with held(): gone once closed, assigned away and back, or its OpenRouter key removed", async () => {
  const origin = new URL(page.url()).origin;
  const { id: ws } = await page.evaluate(async () => (await (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Held needs' }) })).json()));
  await page.evaluate(async ws => fetch(`/api/workspaces/${ws}`, { method: 'PUT', body: JSON.stringify({ add: 'bob@demo.test', as: 'member' }) }), ws);
  const { id: sid } = await page.evaluate(async ws => (await (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name: 'Rec' }) })).json()), ws);
  const { id: i1 } = await page.evaluate(async sid => (await (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: '2026-10', quiet: true }) })).json()), sid);
  const { id: i2 } = await page.evaluate(async sid => (await (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: '2026-09', quiet: true }) })).json()), sid);
  entra.who.stale.add('admin@demo.test');
  await page.evaluate(async ([a, b]) => {
    await fetch(`/api/instances/${a}/comment`, { method: 'POST', body: JSON.stringify({ text: 'Go 1' }) });
    await fetch(`/api/instances/${b}/comment`, { method: 'POST', body: JSON.stringify({ text: 'Go 2' }) });
  }, [i1, i2]);
  for (let k = 0; k < 50; k++) {
    const [d1, d2] = await page.evaluate(async ([a, b]) => Promise.all([a, b].map(async x => (await fetch(`/api/instances/${x}`)).json())), [i1, i2]);
    if (d1.log.some((e: any) => e.op === 'expired') && d2.log.some((e: any) => e.op === 'expired')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  entra.who.stale.delete('admin@demo.test');
  await page.goto(`${origin}/#/${i1}`);
  await page.waitForSelector('#needs:not([hidden])');
  assert.match(await page.textContent('#needs') ?? '', /Your rollforward login has expired/);
  await page.evaluate(async ([a, b]) => {
    await fetch(`/api/instances/${b}/close`, { method: 'POST', body: JSON.stringify({ quiet: true }) });
    await fetch(`/api/instances/${a}/assign`, { method: 'POST', body: JSON.stringify({ to: 'bob@demo.test' }) });
  }, [i1, i2]);
  const bob = await browser.newPage();
  entra.who.as = 'bob@demo.test';
  await bob.goto(`${origin}/auth/login`);
  await bob.waitForSelector('#bar h1 .t');
  await bob.evaluate(async a => fetch(`/api/instances/${a}/assign`, { method: 'POST', body: JSON.stringify({ to: 'admin@demo.test' }) }), i1);
  await bob.close();
  entra.who.as = 'admin@demo.test';
  await page.goto(`${origin}/auth/login`);
  await page.waitForSelector('#bar h1 .t');
  await page.goto(`${origin}/#/${i1}`);
  await page.waitForSelector('#bar h1 .t:text-is("2026-10")');
  assert.equal(await page.locator('#needs').isHidden(), true, 'gone after assign and sign-in');
  await page.goto(`${origin}/#/${i2}`);
  await page.waitForSelector('#bar h1 .t:text-is("2026-09")');
  assert.equal(await page.locator('#needs').isHidden(), true, 'gone on closed instance');
});

test("while an update drains the server, the page shows a quiet line above the instance, with the sidebar folded too, until the drain ends", async () => {
  assert.equal(await page.locator('#draining').isVisible(), false);
  proc.kill('SIGUSR2');
  await page.locator('#draining', { hasText: 'An update is waiting for 0 runs to finish; new runs start after it.' }).waitFor();
  assert.match(await page.textContent('#sidefoot .release') ?? '', /^rollforward (v\d+\.\d+\.\d+|[0-9a-f]{7,})/);
  await page.click('#sidefoot [data-act=fold-side]');
  assert.equal(await page.locator('#draining').isVisible(), true, 'still shown when the sidebar is folded');
  await page.click('#sidefoot [data-act=fold-side]');
  await page.waitForSelector('#draining', { state: 'hidden', timeout: 10_000 });
});

test('previewing a missing text file shows the error rather than rendering the 404 body as file contents', async () => {
  await page.evaluate(() => preview('working/missing.md'));
  await page.waitForSelector('#pv .empty');
  assert.equal(await page.locator('#pv .say').count(), 0);
  assert.equal(await page.textContent('#pv .empty'), 'no such file');
  await page.click('#pv [data-act=unpv]');
});

test('browser Back during inline instance rename cancels the edit instead of freezing the header or renaming the previous instance', async () => {
  const origin = new URL(page.url()).origin;
  const { id: ws } = await page.evaluate(async () => (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'NavRename' }) })).json());
  const { id: sid } = await page.evaluate(async ws => (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name: 'S' }) })).json(), ws);
  const { id: i1 } = await page.evaluate(async sid => (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'Period-A', quiet: true }) })).json(), sid);
  const { id: i2 } = await page.evaluate(async sid => (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'Period-B', quiet: true }) })).json(), sid);
  await page.goto(`${origin}/#/${i1}`);
  await page.waitForSelector('#bar h1 .t:text-is("Period-A")');
  await page.goto(`${origin}/#/${i2}`);
  await page.waitForSelector('#bar h1 .t:text-is("Period-B")');
  await page.click('#bar h1 .ren');
  await page.fill('#bar h1 input.inline', 'Period-B-Edited');
  await page.goBack();
  await page.waitForSelector('#bar h1 .t:text-is("Period-A")', { timeout: 2000 });
  assert.equal(await page.locator('#bar h1 input.inline').count(), 0);
  const labels = await page.evaluate(async ws => (await (await fetch('/api')).json()).find((w: any) => w.id === ws).series[0].instances.map((i: any) => i.label), ws);
  assert.deepEqual(labels.sort(), ['Period-A', 'Period-B']);
});

test('clicking Rename again while an inline rename saves does not start a second editor', async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  let release!: () => void;
  const pending = new Promise<void>(ok => { release = ok; });
  try {
    const { id } = await page.evaluate(async () => {
      const { id: ws } = await (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Rename race' }) })).json();
      const { id: sid } = await (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name: 'S' }) })).json();
      return (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'Before', quiet: true }) })).json();
    });
    await tab.goto(`${new URL(page.url()).origin}/#/${id}`);
    await tab.click('#bar h1 .ren');
    await tab.fill('#bar h1 input.inline', 'After');
    await tab.route('**/rename?*', async route => { await pending; await route.continue(); });
    const sending = tab.waitForRequest('**/rename?*');
    await tab.press('#bar h1 input.inline', 'Enter');
    await sending;
    const button = await tab.locator('#bar h1 .ren').boundingBox();
    await tab.mouse.click(button!.x + button!.width / 2, button!.y + button!.height / 2);
    release();
    await tab.waitForSelector('#bar h1 .t:text-is("After")');
    assert.equal(await tab.locator('#bar h1 input.inline').count(), 0);
    assert.deepEqual(await tab.locator('#toasts .toast').allTextContents(), []);
  } finally {
    release();
    await ctx.close();
  }
});

test('drafts in sessionStorage preserve item/cell pins and deep replies, skip cancelled reply boxes, and never leak across sign-out to another user', async () => {
  const origin = new URL(page.url()).origin;
  const { inst, inst2 } = await page.evaluate(async () => {
    const { id: ws } = await (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'DraftSafe' }) })).json();
    await fetch(`/api/workspaces/${ws}`, { method: 'PUT', body: JSON.stringify({ add: 'bob@demo.test', as: 'member' }) });
    const { id: sid } = await (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name: 'S' }) })).json();
    const { id: inst } = await (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'D1', quiet: true }) })).json();
    const { id: inst2 } = await (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'D2', quiet: true }) })).json();
    await fetch(`/api/instances/${inst}/upload?name=ar.csv&pane=in&quiet=1`, { method: 'POST', body: 'a,b\n1,2\n' });
    await fetch(`/api/instances/${inst}/comment`, { method: 'POST', body: JSON.stringify({ text: 'Shallow root', quiet: true }) });
    let parent: number | undefined;
    for (let depth = 0; depth < 6; depth++) {
      const r = await fetch(`/api/instances/${inst2}/comment`, { method: 'POST', body: JSON.stringify({ text: `Depth ${depth}`, ...(parent && { thread: `c${parent}` }), quiet: true }) });
      parent = Number(r.headers.get('X-RF-Comment-Seq'));
    }
    return { inst, inst2 };
  });

  const ctx = await browser.newContext(), tab = await ctx.newPage();
  try {
    entra.who.as = 'admin@demo.test';
    await tab.goto(`${origin}/#/${inst}`);
    await tab.click('a.ms');
    await tab.waitForSelector('#bar h1 .t:text-is("D1")');

    // On D1: open and cancel a shallow reply, and pin a cell comment.
    const shallow = tab.locator('#conv .post').first();
    await shallow.locator(':scope > .pa [data-act=reply]').click();
    await shallow.locator(':scope > .reply textarea').fill('Cancelled shallow reply');
    await shallow.locator(':scope > .pa [data-act=reply]').click();

    await tab.click('.tile');
    await tab.click('#card .acts [data-act=preview]');
    await tab.click('#pv table.sh [data-act=cell] >> nth=0');
    const expectedRef = await tab.locator('#pv table.sh [data-act=cell] >> nth=0').getAttribute('data-ref');
    await tab.click('#pvn [data-act=comment-cell]');
    await tab.fill('#newcomment', 'Pinned cell draft');

    // On D2: open a deep reply via Continue this thread, then lapse session on reply-post.
    await tab.goto(`${origin}/#/${inst2}`);
    await tab.waitForSelector('#bar h1 .t:text-is("D2")');
    await tab.click('a[data-act=alone]');
    const deep = tab.locator('#conv .post').last();
    const deepSeq = await deep.getAttribute('data-seq');
    await deep.locator(':scope > .pa [data-act=reply]').click();
    await deep.locator(':scope > .reply textarea').fill('Kept deep reply');

    await ctx.clearCookies();
    await deep.locator('[data-act=reply-post]').click();
    await tab.click('a.ms');
    await tab.waitForSelector('#bar h1 .t:text-is("D2")');

    await tab.click('a[data-act=alone]');
    assert.equal(await tab.inputValue(`#conv .post[data-seq="${deepSeq}"] > .reply textarea`), 'Kept deep reply');

    await tab.goto(`${origin}/#/${inst}`);
    await tab.waitForSelector('#bar h1 .t:text-is("D1")');
    assert.equal(await tab.inputValue('#newcomment'), 'Pinned cell draft');
    assert.deepEqual(await tab.evaluate(() => [draft.on, draft.ref]), ['u2', expectedRef]);
    assert.equal(await tab.locator('#conv .post').first().locator(':scope > .reply').isHidden(), true, 'cancelled reply stays closed');

    // Sign out and sign in as Bob in the same tab: admin's draft must not appear for Bob.
    await tab.click('#user summary');
    await tab.click('[data-act=signout]');
    await tab.waitForSelector('a.ms');
    entra.who.as = 'bob@demo.test';
    await tab.click('a.ms');
    await tab.waitForSelector('#bar h1 .t');
    await tab.goto(`${origin}/#/${inst}`);
    await tab.waitForSelector('#bar h1 .t:text-is("D1")');
    assert.equal(await tab.inputValue('#newcomment'), '');
  } finally {
    entra.who.as = 'admin@demo.test';
    await ctx.close();
  }
});

test('saving a wake without a date and time shows a clear prompt instead of Invalid time value', async () => {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/#/a5c0ff5e1f00`);
  await page.waitForSelector('#bar [data-act=wakes]');
  await page.click('#bar [data-act=wakes]');
  await page.waitForSelector('#pv .wakerow [data-act=wake-save]');
  await page.fill('#pv .wakerow .wat', '');
  await page.click('#pv .wakerow [data-act=wake-save]');
  await page.waitForSelector('#toasts .toast');
  const msg = await page.textContent('#toasts .toast') ?? '';
  assert.doesNotMatch(msg, /Invalid time value/i);
  assert.match(msg, /date and time/i);
  await page.click('#pv [data-act=unpv]');
});

test('cell comments on sheets whose names contain apostrophes mark the right sheet and cell instead of matching a column prefix on sheet 1', async () => {
  const origin = new URL(page.url()).origin;
  const { inst } = await page.evaluate(async () => {
    const { id: ws } = await (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'SheetQuotes' }) })).json();
    const { id: sid } = await (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name: 'S' }) })).json();
    const { id: inst } = await (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'L1', quiet: true }) })).json();
    const cols = Array.from({ length: 20 }, (_, i) => String.fromCharCode(65 + i)).join(',');
    await fetch(`/api/instances/${inst}/upload?name=${encodeURIComponent("Q3 '26.csv")}&pane=in&quiet=1`, { method: 'POST', body: `${cols}\n${cols}\n${cols}\n` });
    await fetch(`/api/instances/${inst}/comment`, { method: 'POST', body: JSON.stringify({ item: 'u2', ref: "Q3 '26.csv!B2", text: 'Unquoted sheet ref', quiet: true }) });
    await fetch(`/api/instances/${inst}/comment`, { method: 'POST', body: JSON.stringify({ item: 'u2', ref: "'Q3 ''26.csv'!$B$3", text: 'Excel-quoted sheet ref', quiet: true }) });
    return { inst };
  });

  await page.goto(`${origin}/#/${inst}`);
  await page.waitForSelector('.tile');
  await page.click('.tile');
  await page.click('#card .acts [data-act=preview]');
  await page.waitForSelector('#pv table.sh');
  const notedRefs = await page.locator('#pv table.sh td.noted').evaluateAll(tds => tds.map(td => (td as HTMLElement).dataset.ref));
  assert.deepEqual(notedRefs, ["Q3 '26.csv!B2", "Q3 '26.csv!B3"]);
  await page.click('#pv [data-act=unpv]');
});

test('apostrophes and markup in sheet names, cells and notes stay text through comment pinning and reload', async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  const name = `O'Brien"><img src=x onerror="document.documentElement.dataset.sheetXss='yes'">`;
  try {
    await tab.goto(`${new URL(page.url()).origin}/#/a5c0ff5e1f02`);
    await tab.waitForSelector('#bar h1 .t');
    await tab.route('**/preview/**', route => route.fulfill({ json: {
      sheets: [{ name, rows: [[name, 'Marked']], truncated: false }],
      threads: [{ id: 'c2', ref: `'${name.replaceAll("'", "''")}'!$B$1`, posts: [{ by: 'admin@demo.test', text: name }] }],
    } }));
    await tab.click('.tile[data-item=tie]');
    await tab.click('#card .acts [data-act=preview]');
    await tab.waitForSelector('#pv table.sh');
    assert.equal(await tab.locator('#pv td[data-act=cell]').first().textContent(), name);
    assert.deepEqual(await tab.locator('#pv td.noted').evaluateAll(tds => tds.map(td => [(td as HTMLElement).dataset.ref, (td as HTMLElement).dataset.note])), [[`${name}!B1`, `you: ${name}`]]);
    await tab.locator('#pv td[data-act=cell]').first().click();
    assert.equal(await tab.textContent('#pvn button'), `Comment on ${name}!A1`);
    await tab.click('#pvn [data-act=comment-cell]');
    await tab.fill('#newcomment', 'A safe pinned draft');
    await tab.reload();
    await tab.waitForSelector('#newcomment');
    assert.equal(await tab.inputValue('#newcomment'), 'A safe pinned draft');
    assert.deepEqual(await tab.evaluate(() => [draft.on, draft.ref]), ['tie', `${name}!A1`]);
    assert.equal(await tab.locator('#pv img, #conv img, [onerror]').count(), 0);
    assert.equal(await tab.getAttribute('html', 'data-sheet-xss'), null);
  } finally {
    await ctx.close();
  }
});

test('sidebar navigation and reload keep each draft but do not restore a cancelled reply', async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  try {
    await tab.goto(`${new URL(page.url()).origin}/#/a5c0ff5e1f02`);
    await tab.fill('#newcomment', 'October draft');
    const reply = tab.locator('#conv .post[data-seq="2"] > .reply[data-mode=reply]');
    await tab.click('#conv .post[data-seq="2"] > .pa [data-act=reply]');
    await reply.locator('textarea').fill('Cancelled reply');
    await reply.locator('[data-act=reply]').click();
    await tab.click('#tree a[href="#/a5c0ff5e1f00"]');
    await tab.waitForSelector('#bar h1 .t:text-is("2026-12")');
    await tab.fill('#newcomment', 'December draft');
    await tab.click('#tree a[href="#/a5c0ff5e1f02"]');
    await tab.waitForSelector('#bar h1 .t:text-is("2026-10")');
    assert.equal(await tab.inputValue('#newcomment'), 'October draft');
    assert.equal(await reply.isHidden(), true);
    await tab.reload();
    await tab.waitForSelector('#newcomment');
    assert.equal(await tab.inputValue('#newcomment'), 'October draft');
    assert.equal(await reply.isHidden(), true);
    await tab.click('#conv .post[data-seq="2"] > .pa [data-act=reply]');
    assert.equal(await reply.locator('textarea').inputValue(), '');
    await tab.click('#tree a[href="#/a5c0ff5e1f00"]');
    await tab.waitForSelector('#bar h1 .t:text-is("2026-12")');
    assert.equal(await tab.inputValue('#newcomment'), 'December draft');
  } finally {
    await ctx.close();
  }
});

test('Assign dialog when no other signed-in person sees the workspace explains that instead of showing an empty select', async () => {
  const origin = new URL(page.url()).origin;
  const { inst } = await page.evaluate(async () => {
    const { id: ws } = await (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'SoloAssign' }) })).json();
    const { id: sid } = await (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name: 'S' }) })).json();
    const { id: inst } = await (await fetch(`/api/series/${sid}`, { method: 'POST', body: JSON.stringify({ label: 'Solo-1', quiet: true }) })).json();
    return { inst };
  });
  await page.goto(`${origin}/#/${inst}`);
  await page.waitForSelector('#bar [data-act=assign]');
  await page.click('#bar [data-act=assign]');
  await page.waitForSelector('#ask[open]');
  assert.equal(await page.locator('#ask #assignto').count(), 0);
  assert.equal(await page.locator('#ask button[value=ok]').count(), 0);
  assert.match(await page.textContent('#ask p') ?? '', /signed in/i);
  await page.keyboard.press('Escape');
});

test('clicking, resizing or sidebar keys before the initial identity loads cause no page error', async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  const errors: string[] = [], gate = Promise.withResolvers<void>();
  tab.on('pageerror', e => errors.push(e.message));
  await tab.addInitScript(() => { localStorage.side = 'folded'; });
  await tab.route('**/me', async route => { await gate.promise; await route.continue(); });
  try {
    await tab.goto(`${new URL(page.url()).origin}/#/a5c0ff5e1f00`, { waitUntil: 'domcontentloaded' });
    await tab.mouse.click(5, 5);
    await tab.setViewportSize({ width: 600, height: 800 });
    await tab.keyboard.press('j');
    await tab.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(errors, []);
  } finally {
    gate.resolve();
    await tab.unrouteAll({ behavior: 'wait' });
    await ctx.close();
  }
});

test('Enter does not submit a busy confirmation dialog twice', async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  let posts = 0;
  let release!: () => void;
  const pending = new Promise<void>(ok => { release = ok; });
  try {
    await tab.goto(page.url());
    await tab.click('[data-act=new-workspace]');
    await tab.fill('#ask input', 'Only once');
    await tab.route('**/api/workspaces', async route => {
      posts++;
      await pending;
      await route.fulfill({ status: 500, body: 'Test submission held' });
    });
    await tab.press('#ask input', 'Enter');
    await tab.waitForSelector('#ask button[aria-busy]');
    await tab.press('#ask input', 'Enter');
    release();
    await tab.waitForSelector('#ask .err:text-is("Test submission held")');
    assert.equal(posts, 1);
  } finally {
    release();
    await ctx.close();
  }
});

test('a failed sign-out keeps unsent drafts through reload', async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  try {
    await tab.goto(`${new URL(page.url()).origin}/#/a5c0ff5e1f00`);
    await tab.fill('#newcomment', 'Keep this if sign-out fails');
    await tab.route('**/auth/logout', route => route.fulfill({ status: 500, body: 'Sign-out failed' }));
    await tab.click('#user summary');
    await tab.click('[data-act=signout]');
    await tab.waitForSelector('#toasts .toast:text-is("Sign-out failed")');
    await tab.reload();
    await tab.waitForSelector('#newcomment');
    assert.equal(await tab.inputValue('#newcomment'), 'Keep this if sign-out fails');
  } finally {
    await ctx.close();
  }
});

for (const kind of ['workspace', 'series']) test(`a delayed ${kind} rename does not overwrite the next settings dialog`, async () => {
  const ctx = await browser.newContext({ storageState: await page.context().storageState() }), tab = await ctx.newPage();
  let release!: () => void;
  const pending = new Promise<void>(ok => { release = ok; });
  try {
    const ids = await page.evaluate(async kind => {
      const ids = [];
      for (const label of ['First settings', 'Second settings']) {
        const name = `${kind} ${label}`;
        const { id: ws } = await (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).json();
        const { id: sid } = await (await fetch('/api/series', { method: 'POST', body: JSON.stringify({ workspace: ws, name }) })).json();
        ids.push(kind === 'workspace' ? ws : sid);
      }
      return ids;
    }, kind);
    const act = kind === 'workspace' ? 'workspace-settings' : 'settings', input = kind === 'workspace' ? '#wname' : '#sname';
    await tab.goto(`${new URL(page.url()).origin}/#/${ids[0]}`);
    await tab.locator(`[data-act=${act}][data-id="${ids[0]}"]`).evaluate((el: HTMLElement) => el.click());
    await tab.fill(input, 'Renamed first settings');
    const url = `**/api/${kind === 'workspace' ? 'workspaces' : 'series'}/${ids[0]}`;
    await tab.route(url, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      await pending;
      await route.fulfill({ status: 200, body: '{}' });
    });
    const sending = tab.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith(ids[0]));
    await tab.dispatchEvent(input, 'change');
    await sending;
    await tab.click('#pv [data-act=unpv]');
    await tab.goto(`${new URL(page.url()).origin}/#/${ids[1]}`);
    await tab.locator(`[data-act=${act}][data-id="${ids[1]}"]`).evaluate((el: HTMLElement) => el.click());
    await tab.waitForSelector(input);
    const refreshed = tab.waitForResponse(r => r.url().endsWith('/api'));
    release();
    await refreshed;
    await tab.evaluate(() => renderPv());
    assert.equal(await tab.inputValue(input), `${kind} Second settings`);
    assert.equal(await tab.textContent('#pv .saved'), '');
  } finally {
    release();
    await ctx.close();
  }
});

test('Enter respects aria-busy, row settings do not hang when location.hash already matches, and #wname stays synced in settings', async () => {
  // 1. Enter twice in #tname while POST /tokens is in flight submits only once.
  let tokenPosts = 0;
  await page.route('**/tokens', async route => {
    if (route.request().method() === 'POST') {
      tokenPosts++;
      await new Promise(r => setTimeout(r, 250));
    }
    await route.continue();
  });
  await page.click('#sidefoot [data-act=logins]');
  await page.click('#pv [data-act=tokens]');
  await page.waitForSelector('#tname');
  await page.fill('#tname', 'once-only');
  await page.press('#tname', 'Enter');
  await page.press('#tname', 'Enter');
  await page.waitForSelector('#pv input[readonly]');
  await page.unroute('**/tokens');
  assert.equal(tokenPosts, 1, 'second Enter ignored while button is aria-busy');
  await page.click('#pv [data-act=unpv]');

  // 2. Clicking workspace-settings when location.hash already equals #/<ws> before cur catches up does not hang.
  const { id: ws } = await page.evaluate(async () => (await fetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'FastGear' }) })).json());
  await page.evaluate(async () => refresh());
  await page.evaluate(ws => { history.replaceState(null, '', `#/${ws}`); }, ws);
  await page.hover(`.row.ws:has(a[href="#/${ws}"])`);
  await page.click(`.row.ws [data-act=workspace-settings][data-id="${ws}"]`);
  await page.waitForSelector('#pv #wname', { timeout: 2000 });

  // 3. Changing #wname updates pv.settings.name so re-rendering #pv keeps the new name.
  await page.fill('#wname', 'FastGearRenamed');
  await page.dispatchEvent('#wname', 'change');
  await page.waitForFunction(() => tree.some((w: any) => w.name === 'FastGearRenamed'));
  await page.evaluate(() => renderPv());
  assert.equal(await page.inputValue('#wname'), 'FastGearRenamed');
  await page.click('#pv [data-act=unpv]');
});
