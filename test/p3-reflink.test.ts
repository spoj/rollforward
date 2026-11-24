import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { saveSeriesSettings } from '../src/series.ts';
import { initSystem, saveTree, tree } from '../src/system.ts';
import { openStore, type Instance } from '../src/store.ts';

// Find a directory on a copy-on-write filesystem (Btrfs/XFS) so P3's FICLONE_FORCE path is exercised against the real kernel.
function findReflinkRoot(): string | undefined {
  const candidates = [process.env.RF_TEST_REFLINK_DIR, join(homedir(), '.cache'), dirname(process.cwd()), tmpdir()].filter((x): x is string => !!x);
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      const dir = mkdtempSync(join(base, '.rf-p3-reflink-'));
      const a = join(dir, 'a'), b = join(dir, 'b');
      writeFileSync(a, 'probe');
      try {
        copyFileSync(a, b, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
        rmSync(a, { force: true });
        rmSync(b, { force: true });
        return dir;
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

const root = findReflinkRoot();
const ALICE = 'alice@demo.test';
const OFFER = 'm365:item:b!d/big';
let ix: typeof import('../src/indexes.ts'), logins: typeof import('../src/logins.ts');

before(async () => {
  if (!root) return;
  initSystem(root);
  openStore(root);
  saveTree({ workspaces: { w: { name: 'W', owners: [ALICE], members: [] } }, series: { s1: { name: 'S1', workspace: 'w' } } });
  const { upsertUser } = await import('../src/auth.ts');
  upsertUser(ALICE, { role: 'user' });
  logins = await import('../src/logins.ts');
  ix = await import('../src/indexes.ts');
  logins.saveLogin(ALICE, {
    id: 'm365', kind: 'm365', name: 'Microsoft 365', account: ALICE, since: '2026-11-01T00:00:00Z',
    generation: 'reflink-gen-1', offers: [{ id: OFFER, name: 'Big Archive' }],
  }, ALICE);
});

after(() => {
  delete process.env.RF_WAKE_COPY_MB;
  if (root) rmSync(root, { recursive: true, force: true });
});

function instance(ticked: string[]) {
  const seriesId = 'reflink-s', dir = join(root!, 'series', seriesId);
  saveTree({ ...tree(), series: { ...tree().series, [seriesId]: { name: seriesId, workspace: 'w' } } });
  saveSeriesSettings(dir, { version: 1, owner: ALICE, epoch: 1, since: '', consent: { by: ALICE, at: '', workspace: 'w', logins: ticked, autonomous: false } });
  return {
    seriesId, series: () => dir,
    log: [{ seq: 1, at: '', by: ALICE, op: 'create' }, { seq: 2, at: '', by: 'server', op: 'run', run: 1, runner: ALICE, initiator: ALICE, authority: { version: 1, owner: ALICE, epoch: 1, workspace: 'w', logins: ticked } }],
  } as unknown as Instance;
}

test('P3: >64 MiB wake snapshot uses O(1) COW reflink with isolated inode, exact prefix truncation, and anti-zero-extension guard', async t => {
  if (!root) return t.skip('no reflink-capable filesystem (Btrfs/XFS) available on this host');

  const secretDir = join(logins.personDir(ALICE), 'index');
  const hash = createHash('sha256').update(OFFER).digest('hex').slice(0, 16);
  const at = join(secretDir, hash);
  mkdirSync(secretDir, { recursive: true });

  // 72 MiB committed feed + 1024 uncommitted trailing bytes (simulating crash mid-append).
  const committed = 72 * 2 ** 20;
  const liveFeed = `${at}.0.ndjson.zst`;
  writeFileSync(liveFeed, 'HEAD');
  truncateSync(liveFeed, committed);
  appendFileSync(liveFeed, Buffer.alloc(1024, 0x58));
  assert.equal(statSync(liveFeed).size, committed + 1024);

  const grant = JSON.stringify(['reflink-gen-1', null]);
  const meta = {
    person: ALICE, source: OFFER, name: 'Big Archive', gen: 0, length: committed, lines: 1000, base: committed,
    wakeGrant: grant, parts: { '': { link: 'http://x', delta: 'ok', as_of: '2026-11-24T00:00:00Z', pages: 1, due: Date.now() + 3_600_000, error: null, tries: 0 } },
  };
  writeFileSync(`${at}.json`, JSON.stringify(meta));

  // Set RF_WAKE_COPY_MB=0 to prove reflink path succeeds without touching the stream fallback.
  process.env.RF_WAKE_COPY_MB = '0';
  const inst = instance([OFFER]), lease = logins.authority(inst);
  const outDir = join(root, '.rf/runs/reflink-ok');
  const t0 = Date.now();
  const snap = await ix.prepare(inst, outDir, lease, new AbortController().signal);
  const elapsedMs = Date.now() - t0;

  assert.equal(snap?.valid(), true);
  assert.ok(elapsedMs < 2000, `72 MiB COW reflink should be near-instant, took ${elapsedMs} ms`);

  const snapFile = join(outDir, 'Big Archive.ndjson.zst');
  assert.notEqual(statSync(snapFile).ino, statSync(liveFeed).ino, 'reflink snapshot has its own distinct inode');
  assert.equal(statSync(snapFile).size, committed, 'snapshot truncated to exact committed prefix');
  assert.equal(statSync(liveFeed).size, committed + 1024, 'live feed untouched by snapshot truncation');

  // Mutating the live feed in-place (appending new frames) cannot affect the isolated COW snapshot.
  appendFileSync(liveFeed, Buffer.alloc(4096, 0x59));
  assert.equal(statSync(snapFile).size, committed, 'COW snapshot stays immutable after live feed append');
  assert.equal(readFileSync(snapFile).subarray(0, 4).toString(), 'HEAD');

  // Compact flag or generation bump invalidates the snapshot immediately.
  writeFileSync(`${at}.json`, JSON.stringify({ ...meta, compact: { grant, state: 'pending-append' } }));
  assert.equal(snap?.valid(), false, 'compact flag invalidates snapshot');
  writeFileSync(`${at}.json`, JSON.stringify(meta));
  assert.equal(snap?.valid(), true);

  // Anti-zero-extension guard: if live feed on disk is shorter than c.length, reflink rejects and cleans up.
  truncateSync(liveFeed, committed - 4096);
  const badDir = join(root, '.rf/runs/reflink-short');
  await assert.rejects(async () => ix.prepare(inst, badDir, lease, new AbortController().signal), /index feed changed during the copy/);
  assert.deepEqual(existsSync(badDir) ? readdirSync(badDir) : [], [], 'short feed rejected without zero-extending or leaving stray files');
});
