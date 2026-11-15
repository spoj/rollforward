import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idp } from './idp.ts';
import { readFixtureTree, writeFixtureTree } from './owner-fixture.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rf-admitted-auth-')), root = join(tmp, 'data');
const ADMIN = 'admin@demo.test', ACTOR = 'delayed@demo.test';
let proc: ChildProcess, base: string, admin: string, entra: Awaited<ReturnType<typeof idp>>;
const call = async (method: string, path: string, body?: object, cookie = admin) => {
  const log = join(root, '.rf', 'log.jsonl');
  const before = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
  const res = await fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.ok && !['GET', 'HEAD'].includes(method) && !path.startsWith('/api/instances/') && path !== '/auth/cli') {
    for (let n = 0; !existsSync(log) || !readFileSync(log, 'utf8').trim().split('\n').slice(before).some(line => {
      const e = JSON.parse(line);
      return e.method === method && e.path === path && e.by === (cookie === admin ? ADMIN : ACTOR);
    }); n++) {
      assert.ok(n < 200, 'the control request is audited before capturing files');
      await new Promise(ok => setTimeout(ok, 10));
    }
  }
  return res;
};
const login = async () => (await entra.signIn(base, ACTOR)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
const skillBody = JSON.stringify({ files: { 'SKILL.md': Buffer.from('---\nname: late\ndescription: late\n---\n').toString('base64') } });

before(async () => {
  cpSync(join(import.meta.dirname, 'fixture'), root, { recursive: true });
  writeFixtureTree(root, readFixtureTree(root));
  writeFileSync(join(root, '.rf', 'capabilities.json'), JSON.stringify({ 'series-owner': [ADMIN, ACTOR] }));
  const probe = createServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(ok => probe.close(() => ok()));
  base = `http://127.0.0.1:${port}`;
  entra = await idp();
  const env = { ...process.env, ...entra.env(base), RF_ADMINS: ADMIN, RF_HOST: '127.0.0.1', RF_MAX_RUNS: '0', RF_SCRATCH: join(tmp, 'scratch') };
  delete env.OPENROUTER_API_KEY;
  delete env.EXA_API_KEY;
  delete env.RF_BROWSER_URL;
  delete env.RF_TUNNEL_URL;
  proc = spawn(process.execPath, ['src/server.ts', root, String(port)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok());
    proc.on('exit', code => fail(new Error(`server exited: ${code}`)));
  });
  admin = (await entra.signIn(base, ADMIN)).headers.getSetCookie().find(c => c.startsWith('rf_session='))!.split(';')[0];
  await call('PUT', '/capabilities', { cap: 'create', people: [ACTOR] });
});

after(async () => {
  proc.kill('SIGTERM');
  await once(proc, 'exit');
  entra.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function delayed(method: string, path: string, headers: Record<string, string>, body: string) {
  const req = request(base + path, { method, headers, agent: false });
  const result = new Promise<number>((ok, fail) => {
    req.on('error', fail);
    req.on('response', async res => {
      for await (const _ of res) {}
      ok(res.statusCode!);
    });
  });
  req.write(body.slice(0, 1));
  await new Promise(ok => setTimeout(ok, 80));
  return async () => { req.end(body.slice(1)); return result; };
}

function files() {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(f => f.isFile() && !join(f.parentPath, f.name).startsWith(join(root, '.tmp') + '/'))
    .map(f => [join(f.parentPath, f.name), readFileSync(join(f.parentPath, f.name)).toString('base64')]));
}

for (const credential of ['session', 'token']) {
  for (const change of ['disable', 'disable-enable', 'signout', 'remove-recreate', ...(credential === 'token' ? ['revoke', 'expire'] : [])]) {
    test(`${credential}: delayed mutation is refused after ${change}, without changing files or logs`, async () => {
      assert.equal((await call('PUT', '/users', { roles: { [ACTOR]: 'user' } })).status, 200);
      assert.equal((await call('PUT', `/users/${ACTOR}`, { disabled: false })).status, 200);
      const cookie = await login();
      let headers = { cookie } as Record<string, string>, tokenId = '';
      if (credential === 'token') {
        const { token } = await (await call('POST', '/tokens', { name: 'delayed', days: 1 }, cookie)).json();
        headers = { authorization: `Bearer ${token}` };
        tokenId = (await (await call('GET', '/tokens', undefined, cookie)).json()).at(-1).id;
      }
      const finish = await delayed('POST', '/api/workspaces', headers, '{"name":"must-not-exist"}');
      if (change === 'disable' || change === 'disable-enable') await call('PUT', `/users/${ACTOR}`, { disabled: true });
      if (change === 'disable-enable') await call('PUT', `/users/${ACTOR}`, { disabled: false });
      if (change === 'signout') await call('PUT', `/users/${ACTOR}`, { signout: true });
      if (change === 'remove-recreate') {
        await call('DELETE', `/users/${ACTOR}`);
        await call('PUT', '/users', { roles: { [ACTOR]: 'user' } });
      }
      if (change === 'revoke') await call('DELETE', `/tokens/${tokenId}`, undefined, cookie);
      if (change === 'expire') {
        const path = join(root, '.rf', 'tokens.json'), tokens: Record<string, { id: string; expires: string }> = JSON.parse(readFileSync(path, 'utf8'));
        Object.values(tokens).find(t => t.id === tokenId)!.expires = new Date(0).toISOString();
        writeFileSync(path, JSON.stringify(tokens));
      }
      const before = files();
      assert.equal(await finish(), 401);
      assert.deepEqual(files(), before);
    });
  }
}

for (const credential of ['session', 'token']) for (const [method, path, body] of [
  ['PUT', '/brand', '{"text":"must-not-change"}'],
  ['PUT', '/agents', 'must-not-change'],
  ['PUT', '/users', '{"roles":{"injected@demo.test":"admin"}}'],
  ['PUT', '/connections/late', '{"type":"graph"}'],
  ['PUT', '/capabilities', '{"cap":"publish","people":["delayed@demo.test"]}'],
  ['PUT', '/egress', '{"hosts":["late.example.test"]}'],
  ['POST', '/skills/late/versions', skillBody],
]) {
  test(`${credential}: demotion invalidates pre-body permission: ${method} ${path}`, async () => {
    await call('PUT', '/users', { roles: { [ACTOR]: 'admin' } });
    const cookie = await login();
    let headers: Record<string, string> = { cookie };
    if (credential === 'token') {
      const { token } = await (await call('POST', '/tokens', { name: 'prechecked', days: 1 }, cookie)).json();
      headers = { authorization: `Bearer ${token}` };
    }
    const finish = await delayed(method, path, headers, body);
    await call('PUT', '/users', { roles: { [ACTOR]: 'user' } });
    const before = files();
    assert.equal(await finish(), 403);
    assert.deepEqual(files(), before);
  });
}

test('capability removal invalidates pre-body publish permission without a role or group change', async () => {
  await call('PUT', '/capabilities', { cap: 'publish', people: [ACTOR] });
  const cookie = await login();
  const finish = await delayed('POST', '/skills/late/versions', { cookie }, skillBody);
  await call('PUT', '/capabilities', { cap: 'publish', people: [] });
  const before = files();
  assert.equal(await finish(), 403);
  assert.deepEqual(files(), before);
});

test('group renewal invalidates pre-body publish permission', async () => {
  const group = '11111111-2222-3333-4444-555555555555';
  entra.who.groups[ACTOR] = [group];
  assert.equal((await call('PUT', '/capabilities', { cap: 'publish', people: [group] })).status, 200);
  const cookie = await login();
  const finish = await delayed('POST', '/skills/late/versions', { cookie }, skillBody);
  entra.who.groups[ACTOR] = [];
  await login();
  const before = files();
  assert.equal(await finish(), 403);
  assert.deepEqual(files(), before);
});

for (const mixed of [false, true]) for (const path of ['/tokens', '/cli']) {
  test(`session signout during ${path} body cannot mint a token${mixed ? ' with another valid bearer' : ''}`, async () => {
    const cookie = await login();
    const headers: Record<string, string> = { cookie };
    if (mixed) {
      const { token } = await (await call('POST', '/tokens', { name: 'admin bearer', days: 1 })).json();
      headers.authorization = `Bearer ${token}`;
    }
    const asked = await (await call('POST', '/auth/cli', { name: 'late-cli' })).json();
    const body = path === '/tokens' ? '{"name":"late","days":1}' : `code=${asked.code}&allow=yes`;
    const finish = await delayed('POST', path, headers, body);
    await call('PUT', `/users/${ACTOR}`, { signout: true });
    const before = files();
    assert.equal(await finish(), 401);
    assert.deepEqual(files(), before);
  });
}

for (const credential of ['session', 'token']) test(`${credential}: streaming uploads and both attachments revalidate credentials before keeping any file`, async () => {
  const cookie = await login();
  let headers: Record<string, string> = { cookie }, tokenId = '';
  if (credential === 'token') {
    const { token } = await (await call('POST', '/tokens', { name: 'streaming', days: 1 }, cookie)).json();
    headers = { authorization: `Bearer ${token}` };
    tokenId = (await (await call('GET', '/tokens', undefined, cookie)).json()).at(-1).id;
  }
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: `stream-auth-${credential}` })).json();
  await call('PUT', `/api/workspaces/${ws}`, { owners: [ACTOR], members: [] });
  const { id: sid } = await (await call('POST', '/api/series', { workspace: ws, name: 'S' }, cookie)).json();
  const { id: iid } = await (await call('POST', `/api/series/${sid}`, { label: 'one', quiet: true }, cookie)).json();
  const finishes = [];
  for (const path of [`/api/instances/${iid}/upload?name=late&quiet`, `/api/instances/${iid}/attach?name=late`, `/api/series/${sid}/attach?name=late`]) {
    finishes.push(await delayed('POST', path, headers, 'first-last'));
  }
  assert.equal(readdirSync(join(root, '.tmp')).length, 3, 'uploads stream to temporary files before completing');
  assert.ok(readdirSync(join(root, '.tmp')).every(f => readFileSync(join(root, '.tmp', f)).length > 0));
  if (credential === 'token') await call('DELETE', `/tokens/${tokenId}`, undefined, cookie);
  else await call('PUT', `/users/${ACTOR}`, { signout: true });
  const before = files();
  assert.deepEqual(await Promise.all(finishes.map(f => f())), [401, 401, 401]);
  assert.deepEqual(files(), before);
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
  assert.equal(existsSync(join(root, 'instances', iid, 'upload', 'late')), false);
});

test('unchanged authority still admits delayed JSON and raw bodies, logging a bearer only once', async () => {
  const cookie = await login();
  const { token } = await (await call('POST', '/tokens', { name: 'valid', days: 1 }, cookie)).json();
  const audit = join(root, '.rf', 'token-uses.jsonl'), before = readFileSync(audit, 'utf8').trim().split('\n').length;
  const finish = await delayed('POST', '/api/workspaces', { authorization: `Bearer ${token}` }, '{"name":"valid-delayed"}');
  assert.equal(await finish(), 200);
  assert.equal(readFileSync(audit, 'utf8').trim().split('\n').length, before + 1);
  const raw = await delayed('PUT', '/agents', { cookie: admin }, 'valid delayed instructions');
  assert.equal(await raw(), 200);
});

for (const action of ['reject', 'owner', 'credentials']) test(`a ${action} request queued after its body was read cannot act after token revocation`, () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { cpSync } from 'node:fs';
    import { createServer } from 'node:http';
    import { join } from 'node:path';
    import { idp } from './test/idp.ts';
    import { readFixtureTree, writeFixtureTree } from './test/owner-fixture.ts';
    const root = ${JSON.stringify(join(tmp, 'queued-data'))} + '-${action}';
    const action = '${action}';
    cpSync('./test/fixture', root, { recursive: true });
    writeFixtureTree(root, readFixtureTree(root));
    const probe = createServer();
    await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
    const port = probe.address().port, base = 'http://127.0.0.1:' + port;
    await new Promise(ok => probe.close(ok));
    const entra = await idp();
    Object.assign(process.env, entra.env(base), { RF_ADMINS: '${ADMIN}', RF_HOST: '127.0.0.1', RF_MAX_RUNS: '0', RF_SCRATCH: ${JSON.stringify(join(tmp, 'queued-scratch'))} });
    for (const name of ['RF_BROWSER_URL', 'RF_TUNNEL_URL', 'OPENROUTER_API_KEY', 'EXA_API_KEY']) delete process.env[name];
    process.argv[2] = root; process.argv[3] = String(port);
    const { mock } = await import('node:test');
    const git = await import('./src/git.ts'), entered = Promise.withResolvers();
    let armed = false;
    mock.module('./src/git.ts', { namedExports: { ...git, committed: dir => { if (armed) entered.resolve(); return git.committed(dir); } } });
    await import('./src/server.ts');
    const store = await import('./src/store.ts'), auth = await import('./src/auth.ts');
    const { writeJson } = await import('./src/system.ts');
    writeJson('capabilities.json', { 'series-owner': ['${ADMIN}'] });
    const cookie = (await entra.signIn(base, '${ADMIN}')).headers.getSetCookie().find(c => c.startsWith('rf_session=')).split(';')[0];
    const call = (path, body, headers = { cookie }) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const { id: ws } = await (await call('/api/workspaces', { name: 'Queue' })).json();
    const { id: sid } = await (await call('/api/series', { workspace: ws, name: 'S' })).json();
    const { id } = await (await call('/api/series/' + sid, { label: 'one', quiet: true })).json();
    const inst = store.instance(id), path = '/api/instances/' + id;
    inst.append('agent', 'comment', { text: 'Approve?', thread: 'c2', ask: 'proposal', run: 1 });
    inst.append('agent', 'comment', { text: 'Other proposal?', thread: 'c3', ask: 'proposal', run: 1 });
    const hold = Promise.withResolvers(), prior = git.commit(inst.dir, { name: 'Admin', email: '${ADMIN}' }, 'prior', hold.promise);
    armed = true;
    const first = call(path + '/signoff', { thread: 'c2', quiet: true });
    await entered.promise;
    const token = auth.newToken('${ADMIN}', 'queued', 1), tokenId = auth.myTokens('${ADMIN}').at(-1).id;
    const before = JSON.stringify((await import('./src/series.ts')).seriesSettings(inst.series()));
    const second = action === 'reject'
      ? call(path + '/reject', { thread: 'c3', text: 'must not be logged', quiet: true }, { authorization: 'Bearer ' + token })
      : fetch(base + '/api/series/' + sid + '/' + action, { method: 'PUT', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(action === 'owner' ? { owner: '${ACTOR}' } : { logins: [], autonomous: false }) });
    await new Promise(ok => setTimeout(ok, 80));
    auth.revokeToken('${ADMIN}', tokenId);
    hold.resolve();
    await prior;
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 401);
    assert.equal(inst.log.some(e => e.op === 'reject'), false);
    assert.equal(JSON.stringify((await import('./src/series.ts')).seriesSettings(inst.series())), before);
    entra.close(); process.exit(0);
  `], { cwd: join(import.meta.dirname, '..'), timeout: 15_000, stdio: 'pipe' });
});

test('valid note attachments remain streaming and may exceed the JSON body limit', async () => {
  const { id: ws } = await (await call('POST', '/api/workspaces', { name: 'large-attachment' })).json();
  const { id: sid } = await (await call('POST', '/api/series', { workspace: ws, name: 'S' })).json();
  const data = 'x'.repeat(11 * 2 ** 20);
  const finish = await delayed('POST', `/api/series/${sid}/attach?name=large.txt`, { cookie: admin }, data);
  assert.equal(readdirSync(join(root, '.tmp')).length, 1);
  assert.equal(await finish(), 200);
  assert.equal(readFileSync(join(root, 'series', sid, 'notes', 'files', 'large.txt'), 'utf8'), data);
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
});
