import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idp } from './idp.ts';
import { writeFixtureTree } from './owner-fixture.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rf-r2-hardening-')), root = join(tmp, 'data');
const admin = 'admin@demo.test';
let proc: ChildProcess, base: string, cookie = '', token = '', entra: Awaited<ReturnType<typeof idp>>, iid = '';

before(async () => {
  mkdirSync(join(root, '.rf'), { recursive: true });
  writeFixtureTree(root, { workspaces: {}, series: {} });
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  proc = spawn(process.execPath, ['src/server.ts', root, String(port)], {
    env: { ...process.env, ...entra.env(base), RF_ADMINS: admin, RF_MIN_FREE_GB: '0', RF_PREVIEW_CACHE_BYTES: '600', RF_SCRATCH: join(tmp, 'scratch') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && resolve());
    proc.once('exit', code => reject(new Error(`server exited ${code}`)));
  });
  cookie = (await entra.signIn(base, admin)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ws = (await (await call('POST', '/api/workspaces', { name: 'W' })).json()).id;
  const sid = (await (await call('POST', '/api/series', { workspace: ws, name: 'S', logins: [], autonomous: false })).json()).id;
  iid = (await (await call('POST', `/api/series/${sid}`, { label: '2026-11', quiet: true })).json()).id;
  token = (await (await call('POST', '/tokens', { name: 'pull-test', days: 7 })).json()).token;
});

after(async () => {
  if (proc?.exitCode === null && proc.signalCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
  entra?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('R2 #6: text previews ignore irrelevant query params for cache keys and enforce RF_PREVIEW_CACHE_BYTES budget', async () => {
  const dir = join(root, 'instances', iid, 'working'), previews = join(root, '.previews');
  writeFileSync(join(dir, 'a.txt'), 'A'.repeat(350));
  writeFileSync(join(dir, 'b.txt'), 'B'.repeat(350));
  writeFileSync(join(dir, 'c.txt'), 'C'.repeat(350));

  // Querying a.txt with distinct irrelevant query parameters must reuse ONE cache file.
  for (const q of ['', '?foo=1', '?bar=2&baz=3', '?sheet=Sheet1&page=2']) {
    const r = await fetch(`${base}/preview/${iid}/working/a.txt${q}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text, 'A'.repeat(350));
  }
  const filesAfterA = readdirSync(previews);
  assert.equal(filesAfterA.length, 1, `irrelevant query params must share one preview cache file, got ${filesAfterA.length}`);

  // Previewing b.txt and c.txt under RF_PREVIEW_CACHE_BYTES=600 evicts older previews so total disk usage stays within budget.
  for (const name of ['b.txt', 'c.txt']) {
    const r = await fetch(`${base}/preview/${iid}/working/${name}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text.length, 350);
  }
  const remaining = readdirSync(previews).map(f => statSync(join(previews, f)).size);
  const totalBytes = remaining.reduce((s, n) => s + n, 0);
  assert.ok(totalBytes <= 600, `preview cache total ${totalBytes} bytes exceeded 600-byte budget`);
  assert.equal(remaining.length, 1, 'oldest previews were evicted to stay within budget');
});

test('R2 #7: rf pull writes via temp sibling and preserves the previous local file when replacement write fails', async () => {
  const dir = join(root, 'instances', iid, 'working');
  // Seed a small original file, pull it, then replace it on server with a larger file (> 1024 bytes) that exceeds ulimit -f 1 (512 bytes).
  writeFileSync(join(dir, 'report.txt'), 'original-good-copy\n');
  const home = join(tmp, 'rf-home'), outDir = join(tmp, 'pulled');
  const rfEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const rfScript = join(import.meta.dirname, '..', 'src', 'rf-people.ts');
  execFileSync(process.execPath, [rfScript, 'login', base, token], { env: rfEnv, encoding: 'utf8' });
  execFileSync(process.execPath, [rfScript, 'pull', 'W/S/2026-11/working', outDir], { env: rfEnv, encoding: 'utf8' });
  const target = join(outDir, 'working', 'report.txt');
  assert.equal(readFileSync(target, 'utf8'), 'original-good-copy\n');

  // Update the remote file to 4 KiB and bump mtime so rf pull tries to replace it.
  writeFileSync(join(dir, 'report.txt'), 'X'.repeat(4096));
  const future = new Date(Date.now() + 60_000);
  const { utimesSync } = await import('node:fs');
  utimesSync(join(dir, 'report.txt'), future, future);

  // Run rf pull with ulimit -f 1 (512-byte max file size) so replacement write fails with EFBIG.
  let failed = false;
  try {
    execFileSync('bash', ['-c', `trap '' XFSZ; ulimit -f 1; exec "${process.execPath}" "${rfScript}" pull "W/S/2026-11/working" "${outDir}"`], {
      env: rfEnv, encoding: 'utf8', stdio: 'pipe',
    });
  } catch {
    failed = true;
  }
  assert.equal(failed, true, 'pull failed under EFBIG as expected');
  assert.equal(readFileSync(target, 'utf8'), 'original-good-copy\n', 'previous local copy remained intact after failed replacement');
  assert.ok(!readdirSync(join(outDir, 'working')).some(f => f.startsWith('.rf-pull-')), 'no leftover temp sibling after failure');
  assert.equal(existsSync(target), true);
});
