import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A run's Pi in its real sandbox, with stand-ins for the server's side of the socket: the agent API answers with the token it
// saw, and the model and the machines service are local servers that echo the key they were sent.
const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data'), i = (id: string) => join(root, 'instances', id);
const model = createServer((req, res) => res.end(`model got ${req.url} with ${req.headers.authorization}`));
const machines = createServer().on('upgrade', (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nmachines got ${req.url} with ${req.headers.authorization}`));
await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
await new Promise<void>(ok => machines.listen(0, '127.0.0.1', ok));
Object.assign(process.env, {
  RF_SCRATCH: join(tmp, 'scratch'), RF_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
  OPENROUTER_API_KEY: 'the-real-key', RF_TEST_SECRET: 'server-only',
  RF_MACHINES_URL: `http://127.0.0.1:${(machines.address() as { port: number }).port}`, RF_MACHINES_KEY: 'the-machines-key',
});
const { pi, socketDir } = await import('../src/runner.ts');
const { serveSandboxes } = await import('../src/sandbox.ts');
const { openSkills, pushSkill } = await import('../src/skills.ts');
const { initSystem, writeJson } = await import('../src/system.ts');
const { filesOf, standIns } = await import('./push.ts');
initSystem(root);
openSkills(root);
pushSkill('tool', filesOf(join(standIns, 'tool')), 'admin@demo.test');
writeJson('egress.json', ['127.0.0.1.nip.io']);

const TOKEN = 'run-token', egress: [string, boolean][] = [];
mkdirSync(socketDir, { recursive: true });
const sockets = serveSandboxes(join(socketDir, 'rf.sock'), {
  agent: async (req, res) => void res.end(`agent API, as ${req.headers.authorization}`),
  run: token => (token === TOKEN ? { egress: (host, allowed) => void egress.push([host, allowed]), owns: id => id === 'b1' } : undefined),
});
// Instances by id: w1 and w2 of the run's series, r1 of a series it may read, p1 of one it may not.
for (const d of [i('w1/working'), i('w2/working'), i('r1/working'), i('p1/working'), join(root, 'series', 'weekly')]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, '.rf', 'session.key'), 'secret');
writeFileSync(i('r1/working/rates.csv'), 'usd,1');
writeFileSync(i('p1/working/payroll.csv'), 'names');
mkdirSync(i('w2/session'));
writeFileSync(i('w2/session/main.jsonl'), `${JSON.stringify({ type: 'session', id: 'main', cwd: '/work/ws/Old name' })}\n`);
const cwd = '/work/ws/Weekly', at = `${cwd}/w2`;
const agent = pi({
  token: TOKEN, skills: ['tool'],
  view: { cwd, instance: at, dir: i('w2'), pylib: join(root, 'series', 'weekly', '.pylib'), ro: [[i('w1'), `${cwd}/w1`], [i('w2'), at], [i('r1'), '/work/ws/Shared/r1']], catalogue: '# What you can read' },
});
const sh = async (command: string) => (await agent.bash(command)).output.trim();

before(() => agent.start());

after(async () => {
  await agent.stop();
  sockets.close();
  model.close();
  machines.close();
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

test('the sandbox shows its view of the data by name, and nothing else of the data or the host', async () => {
  assert.equal(await sh('pwd'), cwd);
  assert.equal(await sh('cat ../Shared/r1/working/rates.csv'), 'usd,1');
  assert.equal(await sh('ls /work/ws'), 'Shared\nWeekly');
  assert.equal(await sh('cat /work/CATALOGUE.md'), '# What you can read');
  for (const p of [root, '/root', '/var', join(import.meta.dirname, '..', 'demo')]) assert.match(await sh(`ls ${p} 2>&1`), /No such file/, p);
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

test("the network is the server's socket: allowed hosts through its proxy, never other hosts or private addresses", async () => {
  assert.notEqual(await sh('curl -s -m 5 --noproxy "*" -o /dev/null -w "%{http_code}" https://pypi.org/simple/'), '200');
  assert.match(await sh('curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.org/ 2>&1'), /^000|^403/);
  assert.match(await sh('curl -s -m 10 -o /dev/null -w "%{http_code}" https://127.0.0.1.nip.io/ 2>&1'), /^000|^403/);
  assert.equal(await sh('curl -s -m 20 -o /dev/null -w "%{http_code}" https://pypi.org/simple/'), '200');
  assert.deepEqual(egress, [['example.org', false], ['127.0.0.1.nip.io', false], ['pypi.org', true]]);
});

test("a browser the run opened is reached through the socket, with the machines service's key added there; no other", async () => {
  const ws = (path: string) => sh(`curl -s -m 5 -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' http://127.0.0.1:7000${path}`);
  assert.equal(await ws(`/browser/${TOKEN}/b1`), 'machines got /sessions/b1/cdp with Bearer the-machines-key');
  assert.equal(await ws(`/browser/${TOKEN}/b2`), '');
  assert.equal(await ws('/browser/wrong/b1'), '');
});
