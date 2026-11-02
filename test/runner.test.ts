import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A run's Pi in its real sandbox, with stand-ins for the server's side of the socket: the agent API answers with the token it
// saw, and the model is a local server that echoes the key it was sent.
const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data'), series = join(root, 'ws', 'Weekly'), inst = join(series, 'w2');
const model = createServer((req, res) => res.end(`model got ${req.url} with ${req.headers.authorization}`));
await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
Object.assign(process.env, {
  RF_SCRATCH: join(tmp, 'scratch'), RF_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
  OPENROUTER_API_KEY: 'the-real-key', RF_TEST_SECRET: 'server-only',
});
const { pi, socketDir } = await import('../src/runner.ts');
const { serveSandboxes } = await import('../src/sandbox.ts');
const { useSkillsDir } = await import('../src/skills.ts');
const { initSystem, writeJson } = await import('../src/system.ts');
useSkillsDir(join(import.meta.dirname, 'skills'));
initSystem(root);
writeJson('egress.json', ['127.0.0.1.nip.io']);

const TOKEN = 'run-token', egress: [string, boolean][] = [];
mkdirSync(socketDir, { recursive: true });
const sockets = serveSandboxes(join(socketDir, 'rf.sock'), {
  agent: async (req, res) => void res.end(`agent API, as ${req.headers.authorization}`),
  run: token => (token === TOKEN ? { egress: (host, allowed) => void egress.push([host, allowed]) } : undefined),
});
for (const d of [join(series, 'w1', 'working'), join(inst, 'working'), join(root, 'ws', 'Shared'), join(root, 'ws', 'Other')]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, '.rf', 'session.key'), 'secret');
writeFileSync(join(root, 'ws', 'Shared', 'rates.csv'), 'usd,1');
writeFileSync(join(root, 'ws', 'Other', 'payroll.csv'), 'names');
const agent = pi({ seriesDir: series, instanceDir: inst, token: TOKEN, read: [join(root, 'ws', 'Shared')], skills: ['tool'] });
const sh = async (command: string) => (await agent.bash(command)).output.trim();

before(() => agent.start());

after(async () => {
  await agent.stop();
  sockets.close();
  model.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('a run offers the agent the skills its series chose, and not the others', async () => {
  const offered = (await agent.getCommands()).filter(c => c.source === 'skill').map(c => c.name);
  assert.ok(offered.includes('skill:tool'), `offered: ${offered.join(', ') || 'none'}`);
  assert.ok(!offered.includes('skill:mail-report'), `offered: ${offered.join(', ')}`);
});

test("the agent's scripts reach a skill's files through $RF_SKILLS", async () => {
  const { exitCode, output } = await agent.bash('test -f "$RF_SKILLS/tool/scripts/tool.py"');
  assert.equal(exitCode, 0, `RF_SKILLS does not lead to the skill: ${output}`);
});

test('the sandbox shows its series and the series it may read, and nothing else of the data or the host', async () => {
  assert.equal(await sh(`cat ${join(root, 'ws', 'Shared', 'rates.csv')}`), 'usd,1');
  assert.match(await sh(`cat ${join(root, '.rf', 'session.key')} 2>&1`), /No such file/);
  assert.match(await sh(`ls ${join(root, 'ws', 'Other')} 2>&1`), /No such file/);
  assert.match(await sh('ls /home /root /var 2>&1'), /No such file/);
});

test("writes land only in the instance's working/ and session/ and the series' .pylib", async () => {
  assert.equal(await sh(`touch ${join(inst, 'working', 'out.csv')} ${join(series, '.pylib', 'pkg.py')} && echo ok`), 'ok');
  for (const p of [join(series, 'w1', 'working', 'x.csv'), join(series, 'notes.md'), join(inst, 'workspace.json')])
    assert.match(await sh(`touch ${p} 2>&1`), /Read-only file system/, p);
});

test('no key or server setting is inside: the model is reached through the socket, which adds the key', async () => {
  const env = await sh('env');
  assert.doesNotMatch(env, /the-real-key|server-only/);
  assert.equal(await sh(`curl -s http://127.0.0.1:7000/model/${TOKEN}/chat`), 'model got /v1/chat with Bearer the-real-key');
  assert.equal(await sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7000/model/wrong/chat'), '404');
  assert.equal(await sh('rf show 2>&1 | head -1'), `agent API, as Bearer ${TOKEN}`);
});

test("the network is the server's socket: allowed hosts through its proxy, never other hosts or private addresses", async () => {
  assert.notEqual(await sh('curl -s -m 5 --noproxy "*" -o /dev/null -w "%{http_code}" https://pypi.org/simple/'), '200');
  assert.match(await sh('curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.org/ 2>&1'), /^000|^403/);
  assert.match(await sh('curl -s -m 10 -o /dev/null -w "%{http_code}" https://127.0.0.1.nip.io/ 2>&1'), /^000|^403/);
  assert.equal(await sh('curl -s -m 20 -o /dev/null -w "%{http_code}" https://pypi.org/simple/'), '200');
  assert.deepEqual(egress, [['example.org', false], ['127.0.0.1.nip.io', false], ['pypi.org', true]]);
});
