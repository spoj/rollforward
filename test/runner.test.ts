import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A run's Pi in its real sandbox, with stand-ins for the server's side of the socket: the agent API answers with the token it
// saw, and the model and the browser service are local servers that echo the key they were sent.
const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data'), i = (id: string) => join(root, 'instances', id);
const model = createServer((req, res) => res.end(`model got ${req.url} with ${req.headers.authorization}`));
const browsers = createServer().on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nbrowser service got ${req.url} with ${req.headers.authorization}`));
await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
await new Promise<void>(ok => browsers.listen(0, '127.0.0.1', ok));
Object.assign(process.env, {
  RF_SCRATCH: join(tmp, 'scratch'), RF_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
  OPENROUTER_API_KEY: 'the-real-key', RF_TEST_SECRET: 'server-only',
  RF_BROWSER_URL: `http://127.0.0.1:${(browsers.address() as { port: number }).port}`, RF_BROWSER_KEY: 'the-browser-key',
});
const { pi } = await import('../src/runner.ts');
const { agentRoot } = await import('../src/agent.ts');
const { serveSandboxes } = await import('../src/sandbox.ts');
const { HttpError } = await import('../src/store.ts');
const { openSkills, pushSkill } = await import('../src/skills.ts');
const { initSystem, writeJson } = await import('../src/system.ts');
const { filesOf, standIns } = await import('./push.ts');
initSystem(root);
openSkills(root);
pushSkill('tool', filesOf(join(standIns, 'tool')), 'admin@demo.test');
writeJson('egress.json', ['127.0.0.1.nip.io']);

const TOKEN = 'run-token', egress: [string, boolean][] = [];
// The run's browsers: one on erp, b1, and erp alone ticked.
const lent = (site: string) => {
  if (site !== 'erp') throw new HttpError(403, `web:${site} is not ticked for this instance`);
  return {};
};
const standIn = { lent, browser: async (site: string) => (lent(site), 'b1'), connected() {} } as unknown as import('../src/browsers.ts').Browsers;
// The server's runs: this one, and another going at the same time, OTHER, whose token this one's agent might have read.
const OTHER = 'other-token';
const sockets = serveSandboxes({
  agent: async (req, res) => void res.end(`agent API, as ${req.headers.authorization}`),
  // The server's answer for a connection's host, which here says what it was asked.
  run: token => ([TOKEN, OTHER].includes(token) ? {
    egress: (host, allowed) => void egress.push([host, allowed]), browsers: () => standIn, intercepts: host => host === 'graph.microsoft.com',
    call: async (host, req, res) => void res.end(`${host} ${req.method} ${req.url} ${req.headers.authorization ?? '-'}`),
  } : undefined),
});
// Instances by id: w1 and w2 of the run's series, r1 of a series it may read, p1 of one it may not.
for (const d of [i('w1/working'), i('w2/working'), i('r1/working'), i('p1/working'), join(root, 'series', 'weekly')]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, '.rf', 'session.key'), 'secret');
writeFileSync(i('r1/working/rates.csv'), 'usd,1');
writeFileSync(i('p1/working/payroll.csv'), 'names');
mkdirSync(i('w2/session'));
writeFileSync(i('w2/session/main.jsonl'), `${JSON.stringify({ type: 'session', id: 'main', cwd: '/work/ws/Old name' })}\n`);
const cwd = '/work/ws/Weekly: AR', at = `${cwd}/w2`;
const agent = pi({
  token: TOKEN, id: 'w2', skills: ['tool'],
  view: { cwd, instance: at, dir: i('w2'), pylib: join(root, 'series', 'weekly', '.pylib'), ro: [[i('w1'), `${cwd}/w1`], [i('w2'), at], [i('r1'), '/work/ws/Shared/r1']], env: { DATABRICKS_HOST: 'https://adb-1.test' } },
});
const sh = async (command: string) => (await agent.bash(command)).output.trim();

before(() => agent.start());

after(async () => {
  await agent.stop();
  sockets.close();
  model.close();
  browsers.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('a run offers the agent the skills it is given, and not the others', async () => {
  const offered = (await agent.getCommands()).filter(c => c.source === 'skill').map(c => c.name);
  assert.ok(offered.includes('skill:tool'), `offered: ${offered.join(', ') || 'none'}`);
  assert.ok(!offered.includes('skill:mail-report'), `offered: ${offered.join(', ')}`);
});

test("the agent's scripts reach a skill's files through $RF_SKILLS", async () => {
  const { exitCode, output } = await agent.bash('test -f "$RF_SKILLS/tool/scripts/tool.py"');
  assert.equal(exitCode, 0, `RF_SKILLS does not lead to the skill: ${output}`);
});

test('the sandbox shows its view of the data by name, and nothing else of the data or the host', async () => {
  assert.equal(await sh('pwd'), cwd);
  assert.equal(await sh('cat ../Shared/r1/working/rates.csv'), 'usd,1');
  assert.equal(await sh('ls /work/ws'), 'Shared\nWeekly: AR');
  for (const p of [root, '/root', import.meta.dirname]) assert.match(await sh(`ls ${p} 2>&1`), /No such file/, p);
  assert.equal(JSON.parse(readFileSync(i('w2/session/main.jsonl'), 'utf8').split('\n')[0]).cwd, cwd, 'its session moved to the names of today, so Pi resumes it');
});

test("writes land only in the instance's working/ and session/ and the series' .pylib", async () => {
  assert.equal(await sh('touch w2/working/out.csv .pylib/pkg.py && echo ok'), 'ok');
  assert.ok(existsSync(i('w2/working/out.csv')) && existsSync(join(root, 'series', 'weekly', '.pylib', 'pkg.py')));
  for (const p of ['w1/working/x.csv', 'notes.md', 'w2/workspace.json', '../Shared/r1/working/x.csv', '/work/x'])
    assert.match(await sh(`touch ${p} 2>&1`), /Read-only file system/, p);
});

test('no key or server setting is inside: the model is reached through the socket, which adds the key', async () => {
  const env = await sh('env');
  assert.doesNotMatch(env, /the-real-key|server-only/);
  assert.equal(await sh(`curl -s http://127.0.0.1:7000/model/${TOKEN}/chat`), 'model got /v1/chat with Bearer the-real-key');
  assert.equal(await sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7000/model/wrong/chat'), '404');
  assert.equal(await sh('rf show 2>&1 | head -1'), `agent API, as Bearer ${TOKEN}`);
});

test("the run's socket is its own: another run's token, as one it read in that run's transcript, opens nothing there", async () => {
  assert.equal(await sh(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7000/model/${OTHER}/chat`), '404');
  assert.equal(await sh(`curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${OTHER}" http://127.0.0.1:7000/agent/delivered`), '401');
  assert.equal(await sh(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7000/browsers/${OTHER}/crm/json/version`), '404');
  assert.match(await sh(`curl -s -m 10 -x http://rf:${OTHER}@127.0.0.1:7000 https://graph.microsoft.com/v1.0/me 2>&1; echo " exit $?"`), /exit [1-9]/);
  assert.equal(await sh(`curl -s -m 10 https://graph.microsoft.com/v1.0/me`), 'graph.microsoft.com GET /v1.0/me -', 'its own token still does');
});

test("the network is the server's socket: allowed hosts through its proxy, never other hosts or private addresses", async () => {
  assert.notEqual(await sh('curl -s -m 5 --noproxy "*" -o /dev/null -w "%{http_code}" https://pypi.org/simple/'), '200');
  assert.match(await sh('curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.org/ 2>&1'), /^000|^403/);
  assert.match(await sh('curl -s -m 10 -o /dev/null -w "%{http_code}" https://127.0.0.1.nip.io/ 2>&1'), /^000|^403/);
  assert.equal(await sh('curl -s -m 20 -o /dev/null -w "%{http_code}" https://pypi.org/simple/'), '200');
  assert.deepEqual(egress, [['example.org', false], ['127.0.0.1.nip.io', false], ['pypi.org', true]]);
});

test("a plain pip install lands in the series' .pylib, for the Python runs use, where later commands import it, a colon in its path and all", async () => {
  assert.match(await sh('pip --version'), /^pip [\d.]+ from \/opt\/venv\/lib\/python3\.13\/site-packages\/pip /, "the image's venv's pip");
  assert.match(await sh('pip install -q --no-deps six 2>&1; python -c "import six, os; print(os.path.realpath(six.__file__))"'), /^\/work\/ws\/Weekly: AR\/\.pylib\/six\.py$/);
});

test("a connection's host is the server's to answer, with rollforward's own certificate, which curl, Python and Node trust; its type's environment is set", async () => {
  assert.equal(await sh('curl -s -m 10 -H "Authorization: Bearer rf" https://graph.microsoft.com/v1.0/me'), 'graph.microsoft.com GET /v1.0/me Bearer rf');
  assert.equal(await sh(`python -c "import requests; print(requests.get('https://graph.microsoft.com/v1.0/me?\\$top=1').text)"`), 'graph.microsoft.com GET /v1.0/me?$top=1 -');
  assert.equal(await sh(`python -c "import urllib.request as u; print(u.urlopen('https://graph.microsoft.com/v1.0/drives').read().decode())"`), 'graph.microsoft.com GET /v1.0/drives -');
  assert.equal(await sh(`node -e "fetch('https://graph.microsoft.com/v1.0/sites', { method: 'POST' }).then(r => r.text()).then(console.log)"`), 'graph.microsoft.com POST /v1.0/sites -');
  assert.equal(await sh('echo $DATABRICKS_HOST'), 'https://adb-1.test');
});

test("the run's browser on a website is at $RF_BROWSERS/NAME, through the socket, with the browser service's key added there; no other", async () => {
  const ws = (url: string) => sh(`curl -s -m 5 -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' ${url}`);
  assert.equal(await sh('curl -s $RF_BROWSERS/erp/json/version'), `{"webSocketDebuggerUrl":"ws://127.0.0.1:7000/browsers/${TOKEN}/erp"}`);
  assert.equal(await ws('$RF_BROWSERS/erp'), 'browser service got /sessions/b1/cdp with Bearer the-browser-key');
  assert.equal(await ws('$RF_BROWSERS/crm'), 'web:crm is not ticked for this instance');
  assert.equal(await ws('http://127.0.0.1:7000/browsers/wrong/erp'), '');
});

test("the agent's python is the image's venv, with its packages", async () => {
  const { exitCode, output } = await agent.bash('python -c "import openpyxl, sys; print(sys.prefix)"');
  assert.equal(exitCode, 0, output);
  assert.equal(output.trim(), '/opt/venv');
});

// sample.msg is TxtSampleEmail.msg from MsgReader's tests (github.com/kenjiuno/MSGReader, MIT).
test("the agent's userland is the agent image: its programs, LibreOffice recalculating a workbook and rendering Chinese to PDF, poppler's, and Python's PDF and Outlook readers", async () => {
  const programs = 'timeout grep head cat ls tail sed cp rm mkdir cut unzip zip wc diff cmp which sort sha256sum pwd find xargs git curl jq fd rg file zstd sqlite3 soffice pdftotext pdfinfo pdftoppm tesseract officecli node python pip';
  assert.equal(await sh('cat /etc/debian_version'), readFileSync(join(agentRoot, 'etc', 'debian_version'), 'utf8').trim(), "the image's /etc, on any host");
  assert.equal(await sh(`for p in ${programs}; do command -v $p > /dev/null || echo $p; done`), '', 'none missing');
  assert.match(await sh('tesseract --list-langs'), /chi_sim\nchi_tra\neng/);
  assert.equal(await sh('officecli --version && jq -r .autoUpdate ~/.officecli/config.json && echo $OFFICECLI_NO_AUTO_RESIDENT'), '1.0.160\nfalse\n1', "officecli, which neither updates itself nor stays resident");
  copyFileSync(join(import.meta.dirname, 'sample.msg'), i('w2/working/sample.msg'));
  await sh(`cd "$RF_WORKING" && python -c "
import openpyxl
wb = openpyxl.Workbook()
wb.active['A1'], wb.active['A2'], wb.active['A3'], wb.active['B1'] = 2, 3, '=A1*A2', '應收帳款'
wb.save('book.xlsx')" && soffice --headless --convert-to pdf --outdir out book.xlsx && soffice --headless --convert-to xlsx --outdir out book.xlsx`);
  assert.equal(await sh(`python -c "import openpyxl; print(openpyxl.load_workbook('$RF_WORKING/out/book.xlsx', data_only=True).active['A3'].value)"`), '6', 'recalculated');
  assert.match(await sh('pdftotext "$RF_WORKING/out/book.pdf" -'), /應收帳款/);
  assert.equal(await sh(`python -W ignore -c "import pypdf, fitz, extract_msg; print(len(pypdf.PdfReader('$RF_WORKING/out/book.pdf').pages), fitz.open('$RF_WORKING/out/book.pdf').page_count, extract_msg.openMsg('$RF_WORKING/sample.msg').subject)"`), '1 1 TxtSampleEmail');
});
