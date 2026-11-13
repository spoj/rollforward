import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

// A run's Pi in its real sandbox, with stand-ins for the server's side of the socket: the agent API answers with the token it
// saw, the browser service is a local server that echoes the key it was sent, and the connections' hosts say what they were asked.
const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data'), i = (id: string) => join(root, 'instances', id);
const browsers = createServer().on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nbrowser service got ${req.url} with ${req.headers.authorization}`));
await new Promise<void>(ok => browsers.listen(0, '127.0.0.1', ok));
Object.assign(process.env, {
  RF_SCRATCH: join(tmp, 'scratch'), OPENROUTER_API_KEY: 'the-real-key', EXA_API_KEY: 'the-real-key', RF_TEST_SECRET: 'server-only',
  RF_BROWSER_URL: `http://127.0.0.1:${(browsers.address() as { port: number }).port}`, RF_BROWSER_KEY: 'the-browser-key',
});
const { pi } = await import('../src/runner.ts');
const { agentRoot } = await import('../src/agent.ts');
const { serveSandboxes } = await import('../src/sandbox.ts');
const { HttpError } = await import('../src/store.ts');
const { openSkills, pushSkill, skills } = await import('../src/skills.ts');
const { initSystem, writeJson } = await import('../src/system.ts');
const { filesOf, standIns } = await import('./push.ts');
initSystem(root);
openSkills(root);
pushSkill('tool', filesOf(join(standIns, 'tool')), 'admin@demo.test');
pushSkill('mail-report', filesOf(join(standIns, 'mail-report')), 'admin@demo.test');
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
    egress: (host, allowed) => void egress.push([host, allowed]), browsers: () => standIn, intercepts: host => ['graph.microsoft.com', 'openrouter.ai', 'api.exa.ai'].includes(host),
    call: async (host, req, res) => void res.end(`${host} ${req.method} ${req.url} ${req.headers.authorization ?? '-'}`),
  } : undefined),
});
// Instances by id: w1 and w2 of the run's series, r1 of a series it may read, p1 of one it may not.
for (const d of [i('w1/working'), i('w2/working'), i('r1/working'), i('p1/working'), join(root, 'series', 'weekly')]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, '.rf', 'session.key'), 'secret');
writeFileSync(i('r1/working/rates.csv'), 'usd,1');
// The copy of the skills an earlier version's run kept in the instance.
mkdirSync(i('w2/skills/tool'), { recursive: true });
writeFileSync(i('p1/working/payroll.csv'), 'names');
// A ticked library's cache, a zstd frame per batch, as the server copies it before the run starts.
mkdirSync(join(tmp, 'index'));
writeFileSync(join(tmp, 'index', 'LFM.ndjson.zst'), Buffer.concat([{ id: 'f1', name: 'aging.xlsx', size: 1200 }, { id: 'f2', name: 'march.xlsx', size: 800 }].map(i => zstdCompressSync(`${JSON.stringify(i)}\n`))));
const series = '/work/ws/Weekly: AR', at = `${series}/w2`;
const agent = pi({
  token: TOKEN, id: 'w2', n: 1, skills: skills().filter(s => s.id === 'tool').map(s => ({ ...s, dir: realpathSync(s.dir) })),
  view: {
    instance: at, dir: i('w2'), pylib: join(root, 'series', 'weekly', '.pylib'), ro: [[i('w1'), `${series}/w1`], [i('w2'), at], [i('r1'), '/work/ws/Shared/r1'], [join(tmp, 'index'), '/index']],
    names: { [`${series}/w1`]: 'w1', [at]: 'w2', '/work/ws/Shared/r1': 'r1' }, series: { [series]: 'weekly', '/work/ws/Shared': 'shared' }, env: { DATABRICKS_HOST: 'https://adb-1.test', RF_INDEX: '/index' } },
});
const sh = async (command: string) => (await agent.bash(command)).output.trim();

before(() => agent.start());

after(async () => {
  await agent.stop();
  sockets.close();
  browsers.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('a run offers the agent the skills it is given, and not the others', async () => {
  const offered = (await agent.getCommands()).filter(c => c.source === 'skill').map(c => c.name);
  assert.ok(offered.includes('skill:tool'), `offered: ${offered.join(', ') || 'none'}`);
  assert.ok(!offered.includes('skill:mail-report'), `offered: ${offered.join(', ')}`);
  assert.ok(!existsSync(i('w2/skills')), "the copy an earlier version's run kept in the instance goes, with its next commit");
});

test("the agent's scripts reach a skill's files through $RF_SKILLS", async () => {
  const { exitCode, output } = await agent.bash('test -f "$RF_SKILLS/tool/scripts/tool.py"');
  assert.equal(exitCode, 0, `RF_SKILLS does not lead to the skill: ${output}`);
});

test('the sandbox shows its view of the data by name, and nothing else of the data or the host', async () => {
  assert.equal(await sh('pwd'), at, "its working directory is its own instance's folder");
  assert.equal(await sh('cat ../../Shared/r1/working/rates.csv'), 'usd,1');
  assert.equal(await sh('echo $HOME; ls /app; ls /skills'), '/home/agent\nbin\nnode_modules\npackage.json\nprompt.md\nsrc\ntool', "the app at /app, and only the skills given, at /skills/<id>");
  assert.equal(await sh('ls /work/ws'), 'Shared\nWeekly: AR');
  assert.equal(await sh('cat names.tsv'), `w1\t${series}/w1\nw2\t${at}\nr1\t/work/ws/Shared/r1`, "the instances in reach by id, at their folders by the names the run started with");
  for (const p of [root, '/root', import.meta.dirname]) assert.match(await sh(`ls ${p} 2>&1`), /No such file/, p);
});

test("git finds the instance's repository from working/, across the mount between them", async () => {
  execFileSync('git', ['init', '-q'], { cwd: i('w2') });
  assert.equal(await sh('cd working && git rev-parse --show-toplevel 2>&1'), at);
});

test("writes land only in the instance's working/ and session/ and the series' .pylib", async () => {
  assert.equal(await sh('touch working/out.csv ../.pylib/pkg.py && echo ok'), 'ok');
  assert.ok(existsSync(i('w2/working/out.csv')) && existsSync(join(root, 'series', 'weekly', '.pylib', 'pkg.py')));
  for (const p of ['../w1/working/x.csv', '../notes.md', 'screen.json', 'names.tsv', '../../Shared/r1/working/x.csv', '/work/x', '/app/x', '/skills/tool/x'])
    assert.match(await sh(`touch ${p} 2>&1`), /Read-only file system/, p);
});

test("no key or server setting is inside: OpenRouter and Exa are at their own addresses, through the proxy, with stand-in keys, which their SDKs take", async () => {
  assert.doesNotMatch(await sh('env'), /the-real-key|server-only/);
  assert.doesNotMatch(await sh("for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ; done 2>/dev/null"), /the-real-key|server-only|the-browser-key|RF_TEST_SECRET|RF_BROWSER_KEY|RF_SANDBOX/, "nor in any process's environment there, bwrap's own among them");
  assert.equal(await sh(`python -c "import os, openai; print(openai.OpenAI(base_url='https://openrouter.ai/api/v1', api_key=os.environ['OPENROUTER_API_KEY']).models.with_raw_response.list().text)"`), 'openrouter.ai GET /api/v1/models Bearer rf');
  assert.equal(await sh(`python -c "import exa_py; print(exa_py.Exa().headers['x-api-key'])" && curl -s -m 10 -X POST https://api.exa.ai/search`), 'rf\napi.exa.ai POST /search -');
  assert.equal(await sh('rf show 2>&1 | head -1'), `agent API, as Bearer ${TOKEN}`);
});

test("the run's socket is its own: another run's token, as one it read in that run's transcript, opens nothing there", async () => {
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

test('an index is at $RF_INDEX, read-only, for zstdcat with jq and for duckdb', async () => {
  assert.equal(await sh('zstdcat "$RF_INDEX/LFM.ndjson.zst" | jq -r .name'), 'aging.xlsx\nmarch.xlsx');
  assert.equal(await sh(`python -c "import duckdb; print(duckdb.sql(\\"SELECT sum(size) FROM read_json('$RF_INDEX/LFM.ndjson.zst')\\").fetchall()[0][0])"`), '2000');
  assert.match(await sh('touch "$RF_INDEX/new" 2>&1'), /Read-only/);
});

test("the agent's python is the image's venv, with its packages", async () => {
  const { exitCode, output } = await agent.bash('python -c "import openpyxl, sys; print(sys.prefix)"');
  assert.equal(exitCode, 0, output);
  assert.equal(output.trim(), '/opt/venv');
});

// sample.msg is TxtSampleEmail.msg from MsgReader's tests (github.com/kenjiuno/MSGReader, MIT).
test("the agent's userland is the agent image: its programs, LibreOffice recalculating a workbook and rendering Chinese to PDF, poppler's, and Python's PDF and Outlook readers", async () => {
  const programs = 'timeout grep head cat ls tail sed cp rm mkdir cut unzip zip wc diff cmp which sort sha256sum pwd find xargs git curl jq fd rg file zstd sqlite3 soffice pdftotext pdfinfo pdftoppm tesseract officecli playwright-cli ffmpeg node python pip';
  assert.equal(await sh('cat /etc/debian_version'), readFileSync(join(agentRoot, 'etc', 'debian_version'), 'utf8').trim(), "the image's /etc, on any host");
  assert.equal(await sh(`for p in ${programs}; do command -v $p > /dev/null || echo $p; done`), '', 'none missing');
  assert.match(await sh('tesseract --list-langs'), /chi_sim\nchi_tra\neng/);
  assert.equal(await sh('officecli --version && jq -r .autoUpdate ~/.officecli/config.json && echo $OFFICECLI_NO_AUTO_RESIDENT'), '1.0.160\nfalse\n1', "officecli, which neither updates itself nor stays resident");
  assert.equal(await sh('playwright-cli --version && echo $PLAYWRIGHT_MCP_OUTPUT_DIR'), '0.1.23\n/tmp/playwright-cli', 'its files out of the instance');
  copyFileSync(join(import.meta.dirname, 'sample.msg'), i('w2/working/sample.msg'));
  await sh(`cd "$RF_WORKING" && python -c "
import openpyxl
wb = openpyxl.Workbook()
wb.active['A1'], wb.active['A2'], wb.active['A3'], wb.active['B1'] = 2, 3, '=A1*A2', '應收帳款'
wb.save('book.xlsx')" && soffice --headless --convert-to pdf --outdir out book.xlsx && soffice --headless --convert-to xlsx --outdir out book.xlsx`);
  assert.equal(await sh(`python -c "import openpyxl; print(openpyxl.load_workbook('$RF_WORKING/out/book.xlsx', data_only=True).active['A3'].value)"`), '6', 'recalculated');
  assert.match(await sh('pdftotext "$RF_WORKING/out/book.pdf" -'), /應收帳款/);
  assert.equal(await sh(`python -W ignore -c "import pypdf, fitz, extract_msg; print(len(pypdf.PdfReader('$RF_WORKING/out/book.pdf').pages), fitz.open('$RF_WORKING/out/book.pdf').page_count, extract_msg.openMsg('$RF_WORKING/sample.msg').subject)"`), '1 1 TxtSampleEmail');
  assert.equal(await sh(`python -W ignore -c "import polars, pyarrow, pptx, pyxlsb, pbixray, formulas, scipy, tabulate, markdown, yaml, httpx; print(polars.read_excel('$RF_WORKING/out/book.xlsx', has_header=False).row(2)[0])"`), '6', "Polars reads a workbook, through fastexcel");
});
