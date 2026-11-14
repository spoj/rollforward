import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idp } from './idp.ts';

for (const callback of ['/signin/return', '/']) test(`sign-in at a custom OIDC callback revokes grants only after workspace visibility is lost: ${callback}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-callback-')), entra = await idp();
  const email = 'bob@demo.test', group = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
  mkdirSync(join(root, '.rf'));
  writeFileSync(join(root, '.rf', 'tree.json'), JSON.stringify({ workspaces: { w: { name: 'Workspace', owners: [group], members: [other] } }, series: {} }));
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  await new Promise<void>(ok => probe.close(() => ok()));
  const env = { ...process.env, ...entra.env(base), HOME: root, RF_SCRATCH: join(root, 'scratch'), RF_OIDC_REDIRECT_URI: base + callback };
  delete env.OPENROUTER_API_KEY;
  delete env.RF_BROWSER_URL;
  const proc = spawn(process.execPath, [new URL('../src/server.ts', import.meta.url).pathname, root, String(port)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((ok, fail) => {
      proc.stdout.on('data', d => String(d).includes('rollforward on') && ok());
      proc.once('exit', code => fail(new Error(`server exited with ${code}`)));
    });
    entra.who.groups[email] = [group, other];
    assert.equal((await entra.signIn(base, email)).status, 302);
    const path = join(root, '.rf', 'grants.json');
    writeFileSync(path, JSON.stringify({ g: { workspace: 'w', person: email, site: 'portal', reason: 'Read invoices', at: new Date().toISOString(), state: 'approved' } }));
    entra.who.groups[email] = [other];
    assert.equal((await entra.signIn(base, email)).status, 302);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).g.state, 'approved');
    entra.who.groups[email] = [];
    assert.equal((await entra.signIn(base, email)).status, 302);
    for (let i = 0; i < 50 && JSON.parse(readFileSync(path, 'utf8')).g.state === 'approved'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).g.state, 'revoked');
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    entra.close();
    rmSync(root, { recursive: true, force: true });
  }
});
