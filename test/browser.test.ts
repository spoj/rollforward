import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Instance } from '../src/store.ts';
import { filesOf, standIns } from './push.ts';

// Website logins and a run's browser, through the browser service (RF_BROWSER_URL and RF_BROWSER_KEY, else skipped), on a
// stand-in portal behind a sign-in: a person signs in in the live view the server passes through, and a run's browser starts from
// that login, counts its writes, and hands it back refreshed.
const app = join(import.meta.dirname, '..'), ADMIN = 'admin@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-browser-')), root = join(tmp, 'data');
after(() => rmSync(tmp, { recursive: true, force: true }));
const seen: string[] = [];
let portal: Server, origin = '', proc: ChildProcess, base = '', admin = '', bob = '', visits = 0;

const call = (method: string, path: string, body?: unknown, cookie = admin) => fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const login = async (email: string) => (await fetch(`${base}/auth/demo`, { method: 'POST', body: new URLSearchParams({ email, next: '/' }), redirect: 'manual' }))
  .headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
const text = async (req: IncomingMessage) => Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString();

function standIn(): Server {
  return createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x'), signedIn = /\bsid=s1\b/.test(req.headers.cookie ?? '');
    const page = (title: string, body = '') => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`);
    seen.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = new URLSearchParams(await text(req));
      if (f.get('user') !== 'alice' || f.get('pass') !== 'pw') return page('Wrong');
      return void res.writeHead(302, { location: '/invoices', 'set-cookie': 'sid=s1; Path=/; Max-Age=86400' }).end();
    }
    if (!signedIn) return page('Sign in', '<form method="post" action="/login"><input name="user"><input name="pass" type="password"><button>Sign in</button></form>');
    res.setHeader('set-cookie', `visits=${++visits}; Path=/; Max-Age=86400`);
    if (u.pathname === '/invoices') return page('Invoices', '<a href="/export.csv">Export</a>');
    if (u.pathname === '/export.csv') return void res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="invoices.csv"' }).end('no,amount\n1,10\n');
    page(`${req.method} ${u.pathname}`);
  });
}

test("a path in a session's browser stays inside that session, never reaching the service's other calls", async () => {
  const { files } = await import('../src/browsers.ts');
  for (const path of ['../../../sessions', 'downloads\\..\\..\\s2\\files\\pay.csv', './x']) assert.throws(() => files('s1', path), /a path without \. or \.\. in it/);
  assert.equal(files('s1', 'downloads/%2e%2e/out.txt'), '/sessions/s1/files/downloads/%252e%252e/out.txt');
});

describe('website logins', { skip: !process.env.RF_BROWSER_URL && 'needs the browser service: RF_BROWSER_URL and RF_BROWSER_KEY' }, () => {
  before(async () => {
    portal = standIn();
    await new Promise<void>(ok => portal.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${(portal.address() as { port: number }).port}`;
    const probe = createServer();
    await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
    await new Promise(ok => probe.close(ok));
    mkdirSync(join(tmp, 'home'));
    proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, new URL(base).port], {
      env: { ...process.env, HOME: join(tmp, 'home'), RF_SCRATCH: join(tmp, 'scratch') }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((ok, fail) => {
      proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
      proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
    });
    [admin, bob] = [await login(ADMIN), await login('bob@demo.test')];
    assert.equal((await call('POST', '/skills/portal/versions', { files: filesOf(join(standIns, 'portal')) })).status, 200);
    assert.equal((await call('PUT', '/websites/portal', { name: 'Portal', url: `${origin}/login` })).status, 200);
  });

  after(async () => {
    if (proc.exitCode === null) {
      proc.kill();
      await once(proc, 'exit');
    }
    portal.close();
  });

  test("a person signs in in the live view on the Logins page, and their login is that browser's state", async () => {
    assert.equal((await (await call('GET', '/websites', undefined, bob)).json())[0].name, 'Portal', 'Logins lists the websites');
    const { id } = await (await call('POST', '/logins/web/portal')).json(), ws = `${base.replace('http', 'ws')}/signins/${id}/view`;
    assert.match(await (await call('GET', `/signins/${id}/view`)).text(), /Take control/);
    assert.equal((await call('GET', `/signins/${id}/view`, undefined, bob)).status, 404, "nobody else's sign-in");
    await assert.rejects(chromium.connectOverCDP(`${ws}/drive`, { headers: { cookie: bob } }), /404/);
    assert.equal(await (await call('POST', `/signins/${id}`)).text(), 'Take control and sign in first, then Save login.', 'nothing to save before the person signs in');
    const person = await chromium.connectOverCDP(`${ws}/drive`, { headers: { cookie: admin } });
    const page = person.contexts()[0].pages()[0];
    await page.fill('input[name=user]', 'alice');
    await page.fill('input[name=pass]', 'pw');
    await page.click('button');
    await page.waitForURL('**/invoices');
    await person.close();
    assert.equal((await call('POST', `/signins/${id}`)).status, 200);
    const logins = await (await call('GET', '/logins')).json();
    assert.deepEqual(logins.map((l: { id: string; kind: string; offers: { id: string }[] }) => [l.id, l.kind, l.offers.map(o => o.id)]), [['web:portal', 'website', ['web:portal']]]);
    assert.equal((await call('POST', `/signins/${id}`)).status, 404, 'a sign-in ends once');
  });

  test("a run's browser starts from its runner's login if ticked, counts its writes, and hands the login back refreshed, with its request log", async () => {
    const { initSystem } = await import('../src/system.ts'), { openSkills } = await import('../src/skills.ts');
    const { serveAgent } = await import('../src/agent-api.ts'), { secret } = await import('../src/logins.ts');
    initSystem(root);
    openSkills(root);
    const seriesDir = join(tmp, 'series'), log: Record<string, unknown>[] = [];
    mkdirSync(seriesDir);
    const { id: workspace } = await (await call('POST', '/api/workspaces', { name: 'Portal work' })).json();
    const { id: seriesId } = await (await call('POST', '/api/series', { workspace, name: 'Invoices' })).json();
    const stand = (dir: string, ticks: string[]) => ({ dir, seriesId, log: [{ op: 'create', by: ADMIN, logins: ticks }], series: () => seriesDir, append: (_by: string, op: string, data: object) => (log.push({ op, ...data }), { seq: log.length }) }) as unknown as Instance;
    const rf = async (api: { url: string; token: string }, ...args: string[]) => (await promisify(execFile)(process.execPath, [join(app, 'src', 'rf.ts'), ...args], { env: { ...process.env, RF_URL: api.url, RF_TOKEN: api.token, RF_WORKING: join(tmp, 'w1', 'working') } })
      .catch(e => e)).stdout.trim();

    const unticked = await serveAgent(stand(join(tmp, 'w0'), []));
    assert.match(await rf(unticked, 'browser', 'open', 'portal'), /web:portal is not ticked for this instance/);
    await unticked.close();

    const dir = join(tmp, 'w1'), run = stand(dir, ['web:portal']), api = await serveAgent(run);
    const cdp = await rf(api, 'browser', 'open', 'portal');
    assert.match(cdp, /^ws:\/\/127\.0\.0\.1:\d+\/browser\/[\w-]+\/\w+$/);
    assert.equal(await rf(api, 'browser', 'open', 'portal'), cdp, 'one browser per site and run');
    await assert.rejects(chromium.connectOverCDP(cdp.replace(api.token, 'another-run')), /404/);
    const browser = await chromium.connectOverCDP(cdp), page = browser.contexts()[0].pages()[0];
    await page.goto(`${origin}/invoices`);
    assert.equal(await page.textContent('h1'), 'Invoices', "signed in, as the runner's login");
    assert.equal(await page.evaluate(() => fetch('/save', { method: 'POST' }).then(r => r.status)), 200, "a write isn't stopped, but counted");
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('a')]);
    assert.equal(await rf(api, 'browser', 'get', 'portal', await download.path(), 'invoices.csv'), 'saved working/invoices.csv');
    assert.equal(readFileSync(join(dir, 'working', 'invoices.csv'), 'utf8'), 'no,amount\n1,10\n');
    assert.match(await rf(api, 'browser', 'get', 'portal', '../../../sessions', 'all.json'), /a path without \. or \.\. in it/);
    run.log.push({ op: 'takeover', by: ADMIN, logins: [] });
    assert.match(await rf(api, 'browser', 'open', 'portal'), /web:portal is not ticked/, 'checked again at every call');
    assert.match(await rf(api, 'browser', 'get', 'portal', await download.path(), 'again.csv'), /web:portal is not ticked/);
    await assert.rejects(chromium.connectOverCDP(cdp), /403/, 'nor connects to it again');
    run.log.pop();
    await browser.close();
    await api.close();

    assert.ok(seen.includes('POST /save'));
    assert.deepEqual(log.filter(e => e.op === 'browser' && e.action === 'get').map(e => [e.site, e.file]), [['portal', 'working/invoices.csv']], 'a fetch is logged');
    const entry = log.findLast(e => e.op === 'browser')!;
    assert.deepEqual([entry.run, entry.site, entry.login, entry.writes, entry.file], [0, 'portal', ADMIN, 1, 'browser/run 0 portal.jsonl']);
    const requests = readFileSync(join(dir, 'browser', 'run 0 portal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(requests.length, entry.requests);
    assert.ok(requests.some(r => r.method === 'POST' && r.url === `${origin}/save` && r.status === 200), 'the write is in the log');
    assert.equal(JSON.parse(secret(ADMIN, 'web:portal')).cookies.find((c: { name: string }) => c.name === 'visits').value, String(visits), 'the login came back refreshed');
  });
});
