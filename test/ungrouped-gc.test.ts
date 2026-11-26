import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { createInstance, instance, openStore, seriesDir } from '../src/store.ts';
import { saveSeriesSettings } from '../src/series.ts';
import { sweepIdleUngrouped, UNGROUPED_IDLE_MS } from '../src/waker.ts';
import { openSkills, pushed, skills } from '../src/skills.ts';
import { serverCall, upstreams } from '../src/connections.ts';
import { createServer } from 'node:http';

test('sweepIdleUngrouped abandons single:true open instances idle >= 24h and leaves recent or recurring ones open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-ungrouped-gc-'));
  try {
    initSystem(root);
    openStore(root);
    writeJson('users.json', {
      'alice@example.com': { role: 'user', name: 'Alice', epoch: 1 },
      'bob@example.com': { role: 'user', name: 'Bob', epoch: 1 },
    });
    const t = tree();
    t.workspaces.w1 = { name: 'Main', owners: ['alice@example.com'], members: ['alice@example.com'] };
    t.series.s_old = { name: 'Old Task', workspace: 'w1', single: true };
    t.series.s_new = { name: 'New Task', workspace: 'w1', single: true };
    t.series.s_rec = { name: 'Monthly Close', workspace: 'w1' };
    saveTree(t);

    const oldInst = createInstance('s_old', 'Old Task', 'alice@example.com');
    const newInst = createInstance('s_new', 'New Task', 'alice@example.com');
    const recInst = createInstance('s_rec', '2026-11', 'alice@example.com');

    // Backdate oldInst and recInst last log timestamps by 25h; keep newInst fresh.
    const now = Date.now();
    const oldAt = new Date(now - UNGROUPED_IDLE_MS - 3_600_000).toISOString();
    oldInst.log.at(-1)!.at = oldAt;
    recInst.log.at(-1)!.at = oldAt;

    const abandoned = await sweepIdleUngrouped(now);
    assert.deepEqual(abandoned, [oldInst.id]);
    assert.equal(instance(oldInst.id).doc.status, 'abandoned');
    assert.equal(instance(oldInst.id).log.at(-1)?.op, 'abandon');
    assert.equal(instance(oldInst.id).log.at(-1)?.by, 'server');
    assert.equal(instance(newInst.id).doc.status, 'open');
    assert.equal(instance(recInst.id).doc.status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sweepIdleUngrouped skips single:true open instances that have a pending wake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-ungrouped-gc-wake-'));
  try {
    initSystem(root);
    openStore(root);
    writeJson('users.json', {
      'alice@example.com': { role: 'user', name: 'Alice', epoch: 1 },
      'bob@example.com': { role: 'user', name: 'Bob', epoch: 1 },
    });
    const t = tree();
    t.workspaces.w1 = { name: 'Main', owners: ['alice@example.com'], members: ['alice@example.com'] };
    t.series.s_waked = { name: 'Scheduled Task', workspace: 'w1', single: true };
    t.series.s_idle = { name: 'Idle Task', workspace: 'w1', single: true };
    saveTree(t);

    const wakedInst = createInstance('s_waked', 'Scheduled Task', 'alice@example.com');
    const idleInst = createInstance('s_idle', 'Idle Task', 'alice@example.com');

    const now = Date.now();
    const oldAt = new Date(now - UNGROUPED_IDLE_MS - 3_600_000).toISOString();
    wakedInst.log.at(-1)!.at = oldAt;
    idleInst.log.at(-1)!.at = oldAt;

    writeJson('wakes.json', {
      pending: {
        w1: { target: wakedInst.id, at: new Date(now + 3_600_000).toISOString(), from: 'alice@example.com', text: 'check later' },
      },
      requests: {},
      fired: {},
      checks: [],
    });

    const abandoned = await sweepIdleUngrouped(now);
    assert.deepEqual(abandoned, [idleInst.id]);
    assert.equal(instance(wakedInst.id).doc.status, 'open');
    assert.equal(instance(idleInst.id).doc.status, 'abandoned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sweepIdleUngrouped skips archived series/workspaces and respects abandon guard (P1 #7, #8)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-ungrouped-gc-arch-'));
  try {
    initSystem(root);
    openStore(root);
    writeJson('users.json', {
      'alice@example.com': { role: 'user', name: 'Alice', epoch: 1 },
      'bob@example.com': { role: 'user', name: 'Bob', epoch: 1 },
    });
    const t = tree();
    t.workspaces.w1 = { name: 'Main', owners: ['alice@example.com'], members: ['alice@example.com'] };
    t.workspaces.w_arch = { name: 'Archived', owners: ['alice@example.com'], members: ['alice@example.com'], archived: '2026-11-01T00:00:00Z' };
    t.series.s_arch = { name: 'Archived Task', workspace: 'w1', single: true, archived: '2026-11-01T00:00:00Z' };
    t.series.s_warch = { name: 'In Archived WS', workspace: 'w_arch', single: true };
    t.series.s_guard = { name: 'Guarded Task', workspace: 'w1', single: true };
    saveTree(t);

    const archInst = createInstance('s_arch', 'Archived Task', 'alice@example.com');
    const warchInst = createInstance('s_warch', 'In Archived WS', 'alice@example.com');
    const guardInst = createInstance('s_guard', 'Guarded Task', 'alice@example.com');

    const now = Date.now();
    const oldAt = new Date(now - UNGROUPED_IDLE_MS - 3_600_000).toISOString();
    archInst.log.at(-1)!.at = oldAt;
    warchInst.log.at(-1)!.at = oldAt;
    guardInst.log.at(-1)!.at = oldAt;

    // P1 #7: abandon guard returning false aborts abandonment
    assert.equal(await guardInst.abandon('server', () => false), false);
    assert.equal(instance(guardInst.id).doc.status, 'open');

    // P1 #8: archived series and archived workspaces are skipped
    const abandoned = await sweepIdleUngrouped(now);
    assert.deepEqual(abandoned, [guardInst.id]);
    assert.equal(instance(archInst.id).doc.status, 'open');
    assert.equal(instance(warchInst.id).doc.status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run_subagent.sh enforces RF policy flags and scopes --resume to current run authority (P1 #11)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-subagent-policy-'));
  try {
    const fakeBin = join(root, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const argsFile = join(root, 'pi-args.txt');
    const fakePi = join(fakeBin, 'pi');
    writeFileSync(fakePi, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`);
    chmodSync(fakePi, 0o755);
    const fakePrompt = join(root, 'prompt.md');
    writeFileSync(fakePrompt, '# RF Policy\n');

    const script = join(process.cwd(), 'skills', 'subagent', 'run_subagent.sh');
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RF_INSTANCE: 'inst-1',
      RF_TOKEN: 'run-token-A',
      RF_SYSTEM_PROMPT: fakePrompt,
      RF_WORK_DIR: root,
    };
    const out = execFileSync('bash', [script, '--prompt', 'hello'], { cwd: tmpdir(), env, encoding: 'utf8' });
    assert.match(out, /status: completed/);
    const sessionLine = out.split('\n').find(l => l.startsWith('session: '))!;
    const sessionPath = sessionLine.replace('session: ', '').trim();
    writeFileSync(join(root, sessionPath), '{}\n');

    const passedArgs = execFileSync('cat', [argsFile], { encoding: 'utf8' });
    assert.match(passedArgs, /--no-extensions/);
    assert.match(passedArgs, /--no-skills/);
    assert.match(passedArgs, /--no-mcp/);
    assert.match(passedArgs, /--system-prompt/);
    assert.match(passedArgs, /drafting-only subagent/);

    // Missing RF policy prompt fails closed (P1-H)
    assert.throws(
      () => execFileSync('bash', [script, '--prompt', 'hello'], {
        cwd: root,
        env: { ...env, RF_SYSTEM_PROMPT: join(root, 'nonexistent-prompt.md') },
        stdio: 'pipe',
      }),
      /required RF policy prompt not found/,
    );

    // Same run authority can resume
    execFileSync('bash', [script, '--resume', sessionPath, '--prompt', 'continue'], { cwd: root, env, encoding: 'utf8' });

    // Different run authority (e.g. after owner transfer / new run) cannot resume
    assert.throws(
      () => execFileSync('bash', [script, '--resume', sessionPath, '--prompt', 'hijack'], {
        cwd: root,
        env: { ...env, RF_TOKEN: 'run-token-B' },
        stdio: 'pipe',
      }),
      /outside this run's authority scope/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('built-in subagent skill is loaded and bin/pi is executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-builtin-skill-'));
  try {
    openSkills(root);
    const sub = skills().find(s => s.id === 'subagent');
    assert.ok(sub, 'subagent built-in skill should be discovered');
    assert.equal(sub.name, 'subagent');
    assert.deepEqual(pushed(sub), { version: 0, by: 'builtin', at: '' });
    accessSync(join(sub.dir, 'run_subagent.sh'), constants.X_OK);
    accessSync(join(process.cwd(), 'bin', 'pi'), constants.X_OK);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sweepIdleUngrouped respects RF_UNGROUPED_GC_OWNERS allowlist, rejects empty list, and skips due work (P1-E, P1-F)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-ungrouped-gc-pilot-'));
  const prevOwners = process.env.RF_UNGROUPED_GC_OWNERS;
  try {
    initSystem(root);
    openStore(root);
    writeJson('users.json', {
      'alice@example.com': { role: 'user', name: 'Alice', epoch: 1 },
      'bob@example.com': { role: 'user', name: 'Bob', epoch: 1 },
    });
    const t = tree();
    t.workspaces.w1 = { name: 'Main', owners: ['alice@example.com', 'bob@example.com'], members: [] };
    t.series.s_alice = { name: 'Alice Idle', workspace: 'w1', single: true };
    t.series.s_bob = { name: 'Bob Idle', workspace: 'w1', single: true };
    t.series.s_due = { name: 'Alice Due', workspace: 'w1', single: true };
    saveTree(t);

    const aliceInst = createInstance('s_alice', 'Alice Idle', 'alice@example.com');
    const bobInst = createInstance('s_bob', 'Bob Idle', 'bob@example.com');
    const dueInst = createInstance('s_due', 'Alice Due', 'alice@example.com');
    dueInst.append('alice@example.com', 'comment', { text: 'please run this', authorityEpoch: 1, authorityOwner: 'alice@example.com' });

    const writeSettings = (sid: string, owner: string) => {
      const at = new Date().toISOString();
      saveSeriesSettings(seriesDir(sid), { version: 1, owner, epoch: 1, since: at, consent: { by: owner, at, workspace: 'w1', logins: [], autonomous: true } });
    };
    writeSettings('s_alice', 'alice@example.com');
    writeSettings('s_bob', 'bob@example.com');
    writeSettings('s_due', 'alice@example.com');

    const now = Date.now();
    const oldAt = new Date(now - UNGROUPED_IDLE_MS - 3_600_000).toISOString();
    aliceInst.log.at(-1)!.at = oldAt;
    bobInst.log.at(-1)!.at = oldAt;
    dueInst.log.at(-1)!.at = oldAt;

    // Empty/whitespace-only RF_UNGROUPED_GC_OWNERS must disable GC, never select everyone
    process.env.RF_UNGROUPED_GC_OWNERS = ' ,  ';
    assert.deepEqual(await sweepIdleUngrouped(now), []);
    assert.equal(instance(aliceInst.id).doc.status, 'open');
    assert.equal(instance(bobInst.id).doc.status, 'open');

    // Named pilot owner selects only alice's idle task, skipping bob's and alice's due task
    process.env.RF_UNGROUPED_GC_OWNERS = 'alice@example.com';
    const abandoned = await sweepIdleUngrouped(now);
    assert.deepEqual(abandoned, [aliceInst.id]);
    assert.equal(instance(aliceInst.id).doc.status, 'abandoned');
    assert.equal(instance(bobInst.id).doc.status, 'open');
    assert.equal(instance(dueInst.id).doc.status, 'open');
  } finally {
    if (prevOwners === undefined) delete process.env.RF_UNGROUPED_GC_OWNERS;
    else process.env.RF_UNGROUPED_GC_OWNERS = prevOwners;
    rmSync(root, { recursive: true, force: true });
  }
});

test('serverCall honors checkpoint before 429 resend (P1-G)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-servercall-checkpoint-'));
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  await new Promise<void>(ok => upstream.listen(0, '127.0.0.1', ok));
  const port = (upstream.address() as { port: number }).port;
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    initSystem(root);
    upstreams['openrouter.ai'] = `http://127.0.0.1:${port}`;
    let checks = 0;
    await assert.rejects(
      () => serverCall(
        'openrouter',
        '/api/v1/chat/completions',
        { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { kind: 'website-check', site: 'example.com', person: 'alice@example.com' },
        5_000,
        () => {
          checks++;
          if (checks >= 2) throw Object.assign(new Error('revoked during backoff'), { status: 409 });
        },
      ),
      /revoked during backoff/,
    );
    assert.equal(hits, 1, 'must not send a second upstream request after checkpoint fails during 429 backoff');
  } finally {
    delete upstreams['openrouter.ai'];
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
