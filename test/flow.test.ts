import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initSystem } from '../src/system.ts';
import { createInstance, type Instance } from '../src/store.ts';
import { Browsing, closeBrowser } from '../src/browser.ts';
import { findFlow, saveSkillConfig, skills, useSkillsDir } from '../src/skills.ts';
import { testSkill } from '../src/agent-api.ts';

// A stand-in site behind a sign-in, and two stand-in skills for it: `demo`, signed in by filling the form, and `portal`, by a
// signin.ts of its own. The site has a report page whose period is chosen by a button and which exports a csv, a search that posts,
// a form whose post is a write, and a link to another host.
const PASS = 'S3rvice!pw';
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-flow-')), skillsDir = join(tmp, 'skills');
let site: Server, other: Server, url = '', otherUrl = '', inst: Instance, b: Browsing;
const posted: string[] = [], via: string[] = [];

async function form(req: IncomingMessage) {
  let s = '';
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

function standIn(): Server {
  const sessions = new Set<string>();
  return createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x'), sid = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const html = (title: string, body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`);
    if (req.method === 'POST') posted.push(u.pathname);
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = await form(req);
      if (f.get('username') !== 'svc' || f.get('password') !== PASS) return html('Sign in', '<p>Wrong.</p><form method="post" action="/login"><input name="username"><input name="password" type="password"></form>');
      if (f.get('via')) via.push(f.get('via')!);
      const id = String(Math.random()).slice(2);
      sessions.add(id);
      return void res.writeHead(302, { location: '/home', 'set-cookie': `sid=${id}; Path=/` }).end();
    }
    if (!sid || !sessions.has(sid)) {
      if (u.pathname !== '/login') return void res.writeHead(302, { location: '/login' }).end();
      return html('Sign in', '<form method="post" action="/login"><input name="username"><input name="password" type="password"><input type="hidden" name="via"><button>Sign in</button></form>');
    }
    const q = u.searchParams.get('q') ?? '';
    if (u.pathname === '/home') return html('Home', `<a href="/reports">Reports</a> <a href="${otherUrl}/elsewhere">Elsewhere</a>`);
    if (u.pathname === '/reports') {
      if (q === 'none') return html('Reports', '<p>No results</p>');
      return html('Reports', `<div id="busy">Loading…</div><div id="out" hidden><p>Results for ${q}</p>
        <label>Period <input id="period" value="Last 90 Days"></label> <button onclick="period.value='Last 12 Months'">Last 12 Months</button>
        <input id="note"> <span hidden>Export CSV</span> <a href="/export.csv?q=${encodeURIComponent(q)}" onclick="this.href += '&period=' + encodeURIComponent(period.value) + '&note=' + encodeURIComponent(note.value)">Export CSV</a></div>
        <script>setTimeout(() => { busy.remove(); out.hidden = false; }, 300)</script>`);
    }
    if (u.pathname === '/export.csv') return void res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' })
      .end(`q,period,note\n${q},${u.searchParams.get('period')},${u.searchParams.get('note')}\n`);
    if (u.pathname === '/search' && req.method === 'GET') return html('Search', '<form method="post" action="/search"><input name="q" value="x"><button>Search</button></form>');
    if (u.pathname === '/search' && req.method === 'POST') return html('Search', '<p>Found 2</p>');
    if (u.pathname === '/save' && req.method === 'GET') return html('Save', '<form method="post" action="/save"><button>Save</button></form>');
    if (u.pathname === '/save' && req.method === 'POST') return html('Saved', '<p>Saved.</p>');
    if (u.pathname === '/elsewhere') return html('Elsewhere', '<p>Another host.</p>');
    res.writeHead(404).end();
  });
}

const flows: Record<string, object> = {
  report: { vars: ['q'], steps: [
    { goto: '/reports?q={q}' },
    { wait: { gone: '#busy' } },
    { wait: { text: '/^Results for/' } },
    { click: { role: 'button', name: 'Last 12 Months' } },
    { expect: { css: '#period' }, value: 'Last 12 Months' },
    { fill: { css: '#note' }, value: '{note}' },
    { download: { text: 'Export CSV' }, save: 'Report {q} {today}.csv' },
  ] },
  none: { steps: [{ goto: '/reports?q=none' }, { stop_if: { text: '/No results/i' }, message: 'nothing for none' }] },
  search: { steps: [{ goto: '/search' }, { click: { role: 'button', name: 'Search' } }, { wait: { text: 'Found 2' }, timeout: 3000 }] },
  'search-allowed': { reads_that_post: ['POST */search'], steps: [{ goto: '/search' }, { click: { role: 'button', name: 'Search' } }, { wait: { text: 'Found 2' } }] },
  save: { reads_that_post: ['POST */search'], steps: [{ goto: '/save' }, { click: { role: 'button', name: 'Save' } }, { wait: { text: 'Saved.' }, timeout: 3000 }] },
  elsewhere: { steps: [{ goto: '/home' }, { click: { text: 'Elsewhere' } }, { wait: { text: 'Another host.' }, timeout: 3000 }] },
};

function makeSkill(id: string, signin?: string) {
  const dir = join(skillsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: A stand-in. Use when testing.\n---\n`);
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({ uses: [], site: { hosts: [] }, settings: [
    { key: 'url', label: 'Address' }, { key: 'username', label: 'Account' }, { key: 'password', label: 'Password', secret: true }, { key: 'note', label: 'Note', optional: true }] }));
  for (const [name, flow] of Object.entries(flows)) writeFileSync(join(dir, `${name}.flow.json`), JSON.stringify(flow));
  if (signin) writeFileSync(join(dir, 'signin.ts'), signin);
}

const run = (name: string, ...vars: string[]) => b.flow(name, vars.flatMap(v => ['--var', v]));

before(async () => {
  initSystem(tmp);
  useSkillsDir(skillsDir);
  for (const [s, set] of [[site = standIn(), (u: string) => { url = u; }], [other = standIn(), (u: string) => { otherUrl = u; }]] as const) {
    await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok));
    set(`http://127.0.0.1:${(s.address() as { port: number }).port}`);
  }
  makeSkill('demo');
  // A sign-in of the skill's own: fills the form, and says so in a field the site records.
  makeSkill('portal', `import { password } from ${JSON.stringify(pathToFileURL(join(app, 'src', 'systems.ts')).href)};
export default { async signIn(page, sys) {
  await page.goto(sys.url);
  await page.locator('input[name=username]').fill(sys.username);
  await page.locator('input[name=password]').fill(password(sys));
  await page.locator('input[name=via]').evaluate(e => { e.value = 'portal signin.ts'; });
  await page.locator('input[name=password]').press('Enter');
  await page.waitForURL(/\\/home/);
} };
`);
  saveSkillConfig('demo', { url: `${url}/login`, username: 'svc', password: PASS, note: 'from settings' }, 'admin');
  saveSkillConfig('portal', { url: `${url}/login`, username: 'svc', password: PASS }, 'admin');
  const seriesDir = join(tmp, 'demo-ws', 'Weekly');
  mkdirSync(seriesDir, { recursive: true });
  inst = createInstance(seriesDir, 'w1', 'admin@demo.test');
  b = new Browsing(inst, ['demo', 'portal']);
});

after(async () => {
  await b.close();
  await closeBrowser();
  for (const s of [site, other]) { s.close(); s.closeAllConnections(); }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('a flow signs in, waits, clicks, checks, fills and downloads into working/, with --var and the skill\'s settings', async () => {
  const text = await run('demo/report', 'q=acme');
  const today = new Date().toLocaleDateString('sv');
  assert.match(text, new RegExp(`Ran demo/report: 7 steps\\. Saved: working/Report acme ${today}\\.csv\\.`));
  assert.equal(readFileSync(join(inst.dir, 'working', `Report acme ${today}.csv`), 'utf8'), 'q,period,note\nacme,Last 12 Months,from settings\n');
  const again = await run('demo/report', 'q=acme', 'note=asked');
  assert.match(again, /Report acme .* \(2\)\.csv/, 'a second download never overwrites the first');
  const entry = inst.log.findLast(e => e.op === 'flow')!;
  assert.deepEqual([entry.skill, entry.flow, entry.vars, entry.steps], ['demo', 'demo/report', { q: 'acme', note: 'asked' }, 7]);
  assert.ok(!JSON.stringify(inst.log).includes(PASS), 'the password is never in the log');
});

test('a skill with a sign-in of its own signs in with it', async () => {
  assert.match(await run('portal/report', 'q=x', 'note=n'), /Ran portal\/report/);
  assert.deepEqual(via, ['portal signin.ts']);
  assert.match(await testSkill('portal'), /Signed in to portal as svc/);
});

test('a flow says what it is missing, stops where the page says so, and leaves a screenshot when it fails', async () => {
  await assert.rejects(run('demo/report'), /the flow needs --var q=…/);
  await assert.rejects(run('demo/none'), (e: any) => e.status === 404 && /step 2 \(stop_if, message\): nothing for none/.test(e.message));
  assert.ok(readdirSync(join(inst.dir, 'working')).some(f => f.startsWith('demo none stopped')), 'a screenshot of where it stopped');
});

test('a flow makes no write: a post is stopped unless the flow names it as a read, and only while that flow runs', async () => {
  posted.length = 0;
  await assert.rejects(run('demo/search'), /Stopped POST \/search: it is a write to demo, and the flow does not name it as a read/);
  assert.ok(!posted.includes('/search'), 'nothing reached the site');
  assert.match(await run('demo/search-allowed'), /Ran demo\/search-allowed/);
  assert.ok(posted.includes('/search'));
  await assert.rejects(run('demo/save'), /Stopped POST \/save/);
  assert.ok(!posted.includes('/save'));
  await assert.rejects(run('demo/search'), /Stopped POST \/search/, 'what one flow named does not carry over to the next');
});

test("a flow stays on the site's own hosts", async () => {
  await assert.rejects(run('demo/elsewhere'), new RegExp(`Stopped a request to ${otherUrl.replace(/[.]/g, '\\.')}`));
});

test('only the flows of the skills a series chose can run, and only once the skill is set up', async () => {
  assert.throws(() => findFlow(['demo'], 'portal/report'), /portal is not in this series' Skill use/);
  assert.throws(() => findFlow(['demo'], 'demo/nope'), /demo has no flow nope; it has elsewhere, none, report, save, search-allowed, search/);
  assert.deepEqual(findFlow(['demo'], 'demo/report').vars, { url: `${url}/login`, username: 'svc', note: 'from settings' }, 'its settings, but not its password');
  saveSkillConfig('portal', { url: `${url}/login` }, 'admin');
  await assert.rejects(new Browsing(inst, ['portal']).flow('portal/report', ['--var', 'q=x']), /portal is not set up yet: it needs account\. /, 'a password left empty keeps the one saved');
  assert.deepEqual(skills().map(s => s.id), ['demo', 'portal']);
});
