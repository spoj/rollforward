import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Instance } from '../src/store.ts';

// A run's Windows machine, through the machines service (RF_MACHINES_URL and RF_MACHINES_KEY, else skipped), called as a run's
// agent calls it: rf, through the agent API.
const app = join(import.meta.dirname, '..'), tmp = mkdtempSync(join(tmpdir(), 'rf-windows-')), dir = join(tmp, 'w1');

describe("a run's Windows machine", { skip: !process.env.RF_MACHINES_URL && 'needs the machines service: RF_MACHINES_URL and RF_MACHINES_KEY' }, () => {
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('opens on first use, runs scripts, takes files from working/ and gives them back, and closes when the run ends', async () => {
    const { initSystem } = await import('../src/system.ts'), { serveAgent } = await import('../src/agent-api.ts');
    initSystem(join(tmp, 'data'));
    const log: Record<string, unknown>[] = [];
    const inst = { dir, log: [{ op: 'create', by: 'alice@demo.test', logins: [] }], series: () => tmp, append: (_by: string, op: string, data: object) => (log.push({ op, ...data }), { seq: log.length }) } as unknown as Instance;
    const api = await serveAgent(inst);
    const rf = async (...args: string[]) => (await promisify(execFile)(process.execPath, [join(app, 'src', 'rf.ts'), 'windows', ...args], { env: { ...process.env, RF_URL: api.url, RF_TOKEN: api.token, RF_WORKING: join(dir, 'working') } })
      .catch(e => e)).stdout.trim();
    mkdirSync(join(dir, 'working'), { recursive: true });
    writeFileSync(join(dir, 'working', 'in.txt'), 'made in the run');
    writeFileSync(join(dir, 'working', 'upper.py'), 'import pathlib, sys\nprint(pathlib.Path("C:/work/in.txt").read_text().upper())\nsys.exit(3)\n');
    writeFileSync(join(dir, 'working', 'out.ps1'), 'Set-Content -Path C:\\work\\out.txt -Value "made on windows" -NoNewline\n');

    assert.match(await rf('run', 'python', 'nope.py'), /no working\/nope\.py/);
    assert.equal(await rf('put', 'in.txt'), 'put C:/work/in.txt');
    assert.deepEqual(JSON.parse(await rf('run', 'python', 'upper.py')), { exit: 3, stdout: 'MADE IN THE RUN\r\n', stderr: '' });
    assert.equal(JSON.parse(await rf('run', 'powershell', 'out.ps1')).exit, 0);
    assert.equal(await rf('get', 'C:\\work\\out.txt', 'from windows/out.txt'), 'saved working/from windows/out.txt');
    assert.equal(readFileSync(join(dir, 'working', 'from windows', 'out.txt'), 'utf8'), 'made on windows');
    assert.equal(await rf('screenshot', 'screen.png'), 'saved working/screen.png');
    assert.deepEqual([...readFileSync(join(dir, 'working', 'screen.png')).subarray(1, 4)], [...Buffer.from('PNG')]);
    await api.close();

    assert.deepEqual(log.map(e => [e.op, e.action]), [['windows', 'put'], ['windows', 'run'], ['windows', 'run'], ['windows', 'get'], ['windows', 'screenshot'], ['windows', 'close']]);
    assert.deepEqual(log[1], { op: 'windows', action: 'run', lang: 'python', script: 'working/upper.py', exit: 3 });
    const open = await (await fetch(`${process.env.RF_MACHINES_URL}/sessions`, { headers: { authorization: `Bearer ${process.env.RF_MACHINES_KEY}` } })).json();
    assert.deepEqual(open.filter((s: { kind: string }) => s.kind === 'windows'), [], 'the machine is gone with the run');
  });
});
