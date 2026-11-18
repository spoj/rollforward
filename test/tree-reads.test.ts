import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idp } from './idp.ts';
import { writeLegacyFixtureTree } from './owner-fixture.ts';
import { migrateMessageCopy } from '../scripts/migrate-messages.ts';

// Every open page asks for /api again as each run goes, and hears every change on its event stream, so neither reads .rf/tree.json
// or .rf/users.json for each instance, series or stream: on a thousand instances and ninety open pages, that kept the server's one
// thread busy all the time.
const SERIES = 20, EACH = 10, STREAMS = 30, admin = 'admin@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-reads-')), root = join(tmp, 'data'), counted = join(tmp, 'reads.json');
let proc: ChildProcess, base = '', cookie = '', entra: Awaited<ReturnType<typeof idp>>;

const count = (): Record<string, number> => existsSync(counted) ? JSON.parse(readFileSync(counted, 'utf8')) : {};
// The server's reads of tree.json, users.json and the series' series.json while `act` goes, as test/reads.ts counts them.
async function reads(act: () => Promise<void>) {
  const was = count();
  await act();
  const now = count(), grew = (name: string) => (now[name] ?? 0) - (was[name] ?? 0);
  return { tree: grew('tree.json'), users: grew('users.json'), series: grew('series.json'), logs: grew('messages.jsonl') + grew('events.jsonl') + grew('notes/log.jsonl') };
}

before(async () => {
  mkdirSync(join(root, '.rf'), { recursive: true });
  const at = new Date().toISOString(), series: Record<string, { name: string; workspace: string }> = {};
  for (let s = 0; s < SERIES; s++) {
    series[`s${s}`] = { name: `Series ${s}`, workspace: 'w' };
    const book = join(root, 'series', `s${s}`);
    mkdirSync(join(book, 'notes'), { recursive: true });
    writeFileSync(join(book, 'series.json'), JSON.stringify({ version: 1, owner: admin, epoch: 1, since: at }));
    writeFileSync(join(book, 'notes/log.jsonl'), JSON.stringify({ seq: 1, at, by: 'bob@demo.test', op: 'note', text: 'Seasonal FYI' }) + '\n');
    for (let n = 0; n < EACH; n++) {
      const dir = join(root, 'instances', `s${s}i${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'instance.json'), JSON.stringify({ label: `2026-${n + 1}`, series: `s${s}` }));
      writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
      writeFileSync(join(dir, 'log.jsonl'), [
        { seq: 1, at, by: admin, op: 'create', logins: [] },
        { seq: 2, at, by: 'bob@demo.test', thread: 'c2', op: 'comment', note: true, text: 'Period FYI' },
      ].map(e => JSON.stringify(e) + '\n').join(''));
    }
  }
  writeLegacyFixtureTree(root, { workspaces: { w: { name: 'Books', owners: [], members: [] } }, series });
  migrateMessageCopy(root, true);
  entra = await idp();
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(ok => probe.close(() => ok()));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ...entra.env(base), HOME: tmp, RF_SCRATCH: join(tmp, 'scratch'), RF_ADMINS: admin, RF_TEST_READS: counted };
  delete env.OPENROUTER_API_KEY;
  delete env.RF_BROWSER_URL;
  proc = spawn(process.execPath, ['--import', pathToFileURL(join(import.meta.dirname, 'reads.ts')).href, join(import.meta.dirname, '..', 'src', 'server.ts'), root, String(port)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok());
    proc.once('exit', code => fail(new Error(`server exited with ${code}`)));
  });
  cookie = (await entra.signIn(base, admin)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  // A sign-in's checks of every series go on after it answers: the counting starts once they're done.
  for (let was = '', now = ''; (now = JSON.stringify(count())) !== was; was = now) await new Promise(r => setTimeout(r, 250));
});

after(async () => {
  if (proc?.exitCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
  entra?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('a listing reads tree.json and users.json fewer times than it has series, however many instances they hold', async () => {
  const n = await reads(async () => {
    const [w] = await (await fetch(`${base}/api`, { headers: { cookie } })).json();
    assert.equal(w.series.flatMap((s: { instances: unknown[] }) => s.instances).length, SERIES * EACH);
  });
  assert.ok(n.tree < SERIES && n.users < SERIES, `GET /api read tree.json ${n.tree} times and users.json ${n.users} times, for ${SERIES} series of ${EACH} instances`);
});

test("a listing reads each series' settings once, however many instances it holds", async () => {
  const n = await reads(async () => assert.equal((await fetch(`${base}/api`, { headers: { cookie } })).status, 200));
  assert.ok(n.series <= SERIES, `GET /api read series.json ${n.series} times, for ${SERIES} series of ${EACH} instances`);
  assert.equal(n.logs, 0, 'the listing reuses the loaded logs');
});

test('a change reads tree.json once for all the event streams open, not for each', async () => {
  const open = new AbortController();
  try {
    await Promise.all(Array.from({ length: STREAMS }, () => fetch(`${base}/api/events`, { headers: { cookie }, signal: open.signal })));
    // Viewing an instance first marks it seen, a change every stream hears.
    const n = await reads(async () => assert.equal((await fetch(`${base}/api/instances/s0i0`, { headers: { cookie } })).status, 200));
    assert.ok(n.tree < STREAMS, `a change heard by ${STREAMS} event streams read tree.json ${n.tree} times`);
    assert.equal(n.logs, 0, 'detail and SSE reuse the loaded logs');
  } finally {
    open.abort();
  }
});
