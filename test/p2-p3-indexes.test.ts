import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import {
  appendFileSync, constants, copyFileSync, existsSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';
import { changes, saveTree, tree, writeJson } from '../src/system.ts';
import { openStore, type Instance } from '../src/store.ts';

const ALICE = 'alice@demo.test', BOB = 'bob@demo.test', BOX = 'team@demo.test';
const FOLDER = 'm365:item:b!d/top', FOLDER2 = 'm365:item:b!d/second', MAIL = `m365:mail:${BOX}`;
const tmp = mkdtempSync(join(tmpdir(), 'rf-p2p3-'));
let graph: Server, base = '', ix: typeof import('../src/indexes.ts'), logins: typeof import('../src/logins.ts');

type Item = Record<string, any>;
const state: Record<string, Map<string, Item>> = {};
const changed: { at: string; seq: number; id: string; where: string; raw?: Item }[] = [];
let seq = 0;
const put = (at: string, item: Item, where = '', raw?: Item) => {
  (state[at] ??= new Map()).set(item.id, item);
  changed.push({ at, seq: ++seq, id: item.id, where, raw });
};
const file = (d: string, id: string, name: string, parent: string, more = {}) => ({ id, name, file: {}, parentReference: { driveId: d, id: parent }, ...more });
const folder = (d: string, id: string, name: string, parent: string, more = {}) => ({ id, name, folder: {}, parentReference: { driveId: d, id: parent }, ...more });
const parentOf = (d: string, id: string) => state[d]?.get(id)?.parentReference?.id;
const under = (d: string, id: string, top: string) => { for (let x: string | undefined = id; x; x = parentOf(d, x)) if (x === top) return true; return false; };

const asked: { who: string; url: string }[] = [];
const locked = new Set<string>();
let reverseBatch = false;

function delta(who: string, d: string, scope: string | undefined, token: string | null) {
  const link = (t: string) => `${base}/v1.0/drives/${d}/${scope ? `items/${scope}` : 'root'}/delta?token=${t}`;
  if (token === 'gone') return { status: 410, body: { error: { code: 'resyncRequired' } } };
  if (locked.has(who)) return { status: 403, body: { error: { code: 'accessDenied' } } };
  const inScope = (id: string) => !scope || under(d, id, scope);
  if (token?.startsWith('s')) {
    const events = changed.filter(c => c.at === d && c.seq > Number(token.slice(1)));
    const items: Item[] = [];
    for (const ev of events) {
      const it = ev.raw ?? state[d].get(ev.id)!;
      if (it.deleted || inScope(it.id)) items.push(it);
    }
    return { status: 200, body: { value: items, '@odata.deltaLink': link(`s${seq}`) } };
  }
  const [at, from] = token ? token.slice(1).split('.').map(Number) : [0, seq];
  const all = [...(state[d]?.values() ?? [])].filter(it => !it.deleted && inScope(it.id));
  const page = all.slice(at, at + 4);
  return { status: 200, body: { value: page, ...(at + 4 < all.length ? { '@odata.nextLink': link(`c${at + 4}.${from}`) } : { '@odata.deltaLink': link(`s${from}`) }) } };
}

function mail(fid: string | undefined, token: string | null) {
  if (token === 'gone') return { status: 410, body: { error: { code: 'resyncRequired' } } };
  if (fid && state.mail.get(fid)?.['@removed']) return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
  const where = fid ?? '', link = (t: string) => `${base}/v1.0/users/${encodeURIComponent(BOX)}/mailFolders/${fid ? `${fid}/messages/` : ''}delta?$deltatoken=${t}`;
  if (token?.startsWith('s')) {
    const events = changed.filter(c => c.at === 'mail' && c.where === where && c.seq > Number(token.slice(1)));
    return { status: 200, body: { value: events.map(ev => ev.raw ?? state.mail.get(ev.id)), '@odata.deltaLink': link(`s${seq}`) } };
  }
  const [at, from] = token ? token.slice(1).split('.').map(Number) : [0, seq];
  const all = [...(state.mail?.values() ?? [])].filter(it => !it['@removed'] && (fid ? it.parentFolderId === fid && it.subject : it.displayName));
  const page = all.slice(at, at + 2);
  return { status: 200, body: { value: page, ...(at + 2 < all.length ? { '@odata.nextLink': link(`c${at + 2}.${from}`) } : { '@odata.deltaLink': link(`s${from}`) }) } };
}

function answer(who: string, url: string) {
  asked.push({ who, url });
  const u = new URL(url, 'http://x'), path = decodeURIComponent(u.pathname).replace(/^\/v1\.0/, ''), token = u.searchParams.get('token') ?? u.searchParams.get('$deltatoken');
  let m;
  if ((m = /^\/drives\/([^/]+)\/(?:items\/([^/]+)|root)\/delta$/.exec(path))) return delta(who, m[1], m[2], token);
  if ((m = /^\/users\/[^/]+\/mailFolders\/(?:([^/]+)\/messages\/)?delta$/.exec(path))) return mail(m[1], token);
  return { status: 404, body: { error: { code: 'itemNotFound', message: path } } };
}

function supportsReflink(dir: string): boolean {
  const a = join(dir, '.probe-src'), b = join(dir, '.probe-dst');
  writeFileSync(a, 'x');
  try {
    copyFileSync(a, b, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}

before(async () => {
  graph = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      const send = (status: number, b: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b));
      const path = new URL(req.url!, 'http://x').pathname, who = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (path === '/.well-known/openid-configuration') return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
      if (path === '/token') {
        const r = new URLSearchParams(body).get('refresh_token');
        return send(200, { access_token: r, expires_in: 3600 });
      }
      if (path === '/v1.0/$batch') {
        const requests = JSON.parse(body).requests as { id: string; url: string }[];
        const responses = requests.map(r => ({ id: r.id, ...answer(who, r.url) }));
        return send(200, { responses: reverseBatch ? responses.toReversed() : responses });
      }
      const a = answer(who, req.url!);
      send(a.status, a.body);
    });
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
  Object.assign(process.env, {
    RF_OIDC_ISSUER: base, RF_OIDC_CLIENT_ID: 'app', RF_PUBLIC_URL: 'http://127.0.0.1:1',
    RF_M365_SCOPES: 'Mail.Read Mail.Read.Shared Files.Read.All Sites.Read.All',
  });
  const { initSystem } = await import('../src/system.ts');
  const { upsertUser } = await import('../src/auth.ts');
  initSystem(tmp);
  openStore(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [ALICE], members: [BOB] } }, series: { s1: { name: 'S1', workspace: 'w' } } });
  for (const p of [ALICE, BOB]) upsertUser(p, { role: 'user' });
  writeJson('capabilities.json', { 'wake-check': [ALICE, BOB] });
  (await import('../src/connections/graph.ts')).endpoints.graph = base;
  logins = await import('../src/logins.ts');
  ix = await import('../src/indexes.ts');

  put('b!d', { id: 'droot', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!d' } });
  put('b!d', folder('b!d', 'top', 'Top', 'droot'));
  put('b!d', file('b!d', 'keep1', 'keep1.xlsx', 'top'));
  put('b!d', file('b!d', 'solo', 'solo.xlsx', 'top'));
  put('b!d', folder('b!d', 'sub', 'Sub', 'top'));
  put('b!d', file('b!d', 'child1', 'child1.xlsx', 'sub'));
  put('b!d', folder('b!d', 'deep', 'Deep', 'sub'));
  put('b!d', file('b!d', 'grandchild', 'grandchild.xlsx', 'deep'));
  put('b!d', folder('b!d', 'sparseFolder', 'Sparse', 'top'));
  put('b!d', file('b!d', 'sparseChild', 'sparse.xlsx', 'sparseFolder'));

  put('b!d', folder('b!d', 'second', 'Second', 'droot'));
  put('b!d', file('b!d', 'only', 'only.xlsx', 'second'));

  put('mail', { id: 'inbox', displayName: 'Inbox', parentFolderId: 'mroot' }, '');
  put('mail', { id: 'submail', displayName: 'SubMail', parentFolderId: 'inbox' }, '');
  put('mail', { id: 'm1', subject: 'Keep', parentFolderId: 'inbox', body: { contentType: 'text', content: 'hi' } }, 'inbox');
  put('mail', { id: 'm2', subject: 'Gone', parentFolderId: 'submail', body: { contentType: 'text', content: 'bye' } }, 'submail');
});

after(async () => {
  delete process.env.RF_WAKE_COPY_MB;
  await ix.stopIndexing();
  graph.close();
  rmSync(tmp, { recursive: true, force: true });
});

const offer = (who: string, offers: { id: string; name: string }[], generation = 'gen-1') =>
  logins.saveLogin(who, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: who, since: '2026-11-01T00:00:00Z', generation, offers }, who);
const at = (who: string, offerId: string) => join(logins.personDir(who), 'index', createHash('sha256').update(offerId).digest('hex').slice(0, 16));
const cache = (who: string, offerId: string) => JSON.parse(readFileSync(`${at(who, offerId)}.json`, 'utf8'));
const feedOf = (who: string, offerId: string) => `${at(who, offerId)}.${cache(who, offerId).gen}.ndjson.zst`;
const lines = (f: string) => (existsSync(f) ? zstdDecompressSync(readFileSync(f)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const until = async (done: () => boolean) => { for (let i = 0; !done(); i++) { assert.ok(i < 3000, 'timed out waiting for condition'); await new Promise(ok => setTimeout(ok, 20)); } };
async function work(done: () => boolean) {
  ix.startIndexing();
  await until(done);
  await ix.stopIndexing();
}
const settled = (who: string, ...offerIds: string[]) => () =>
  offerIds.every(o => existsSync(`${at(who, o)}.json`) && !cache(who, o).compact && Object.values(cache(who, o).parts).every((p: any) => p.due === null || p.due > Date.now()));
async function due(who: string, ...offerIds: string[]) {
  for (const o of offerIds) {
    const c = cache(who, o);
    for (const p of Object.values(c.parts) as { due: number | null }[]) p.due = Date.now();
    writeFileSync(`${at(who, o)}.json`, JSON.stringify(c));
  }
  await work(settled(who, ...offerIds));
}

let serial = 0;
function instance(who: string, ticked: string[]) {
  const seriesId = `p2p3-${++serial}`, dir = join(tmp, 'series', seriesId);
  saveTree({ ...tree(), series: { ...tree().series, [seriesId]: { name: seriesId, workspace: 'w' } } });
  saveSeriesSettings(dir, { version: 1, owner: who, epoch: 1, since: '', consent: { by: who, at: '', workspace: 'w', logins: ticked, autonomous: false } });
  return { seriesId, series: () => dir, log: [{ seq: 1, at: '', by: who, op: 'create' }, { seq: 2, at: '', by: 'server', op: 'run', run: 1, runner: who, initiator: who, authority: { version: 1, owner: who, epoch: 1, workspace: 'w', logins: ticked } }] } as unknown as Instance;
}

test('P2: HTTP 200 deletion compacts locally with zero Graph recrawl, fires index-removed pre-append, prunes descendants, and restores wakeGrant', async () => {
  offer(ALICE, [{ id: FOLDER, name: 'Top' }, { id: MAIL, name: 'Team Mail' }]);
  const grant = JSON.stringify(['gen-1', null]);
  await work(() => existsSync(`${at(ALICE, FOLDER)}.json`) && cache(ALICE, FOLDER).wakeGrant === grant && !!cache(ALICE, FOLDER).parts['']?.delta
    && existsSync(`${at(ALICE, MAIL)}.json`) && cache(ALICE, MAIL).wakeGrant === grant && !!cache(ALICE, MAIL).parts.submail?.delta && settled(ALICE, FOLDER, MAIL)());

  const inst = instance(ALICE, [FOLDER]), lease = logins.authority(inst);
  const snapBefore = await ix.prepare(inst, join(tmp, 'runs', 'p2-before'), lease, new AbortController().signal);
  assert.equal(snapBefore?.valid(), true);

  const beforeGen = cache(ALICE, FOLDER).gen;
  const oldFeed = feedOf(ALICE, FOLDER);
  const oldDelta = cache(ALICE, FOLDER).parts[''].delta;
  const observedStates: { wakeGrant?: string; compact?: any; snapValid: boolean; prepareBlocked: boolean }[] = [];
  const onRemoved = (person: string, source: string) => {
    if (person !== ALICE || source !== FOLDER) return;
    const onDisk = cache(ALICE, FOLDER);
    let prepareBlocked = false;
    try {
      ix.prepare(inst, join(tmp, 'runs', `p2-mid-${observedStates.length}`), lease, new AbortController().signal);
    } catch {
      prepareBlocked = true;
    }
    observedStates.push({ wakeGrant: onDisk.wakeGrant, compact: onDisk.compact, snapValid: snapBefore!.valid(), prepareBlocked });
  };
  changes.on('index-removed', onRemoved);

  // Sparse update to sparseChild omitting parentReference, then delete sparseFolder, sub (with nested deep/grandchild), and solo.
  put('b!d', { ...state['b!d'].get('sparseChild')!, name: 'sparse-renamed.xlsx' }, '', { id: 'sparseChild', name: 'sparse-renamed.xlsx', file: {} });
  put('b!d', { id: 'sparseFolder', deleted: {} });
  put('b!d', { id: 'sub', deleted: {} });
  put('b!d', { id: 'solo', deleted: {} });

  const askedFrom = asked.length;
  try {
    await due(ALICE, FOLDER);
  } finally {
    changes.off('index-removed', onRemoved);
  }

  // Step 1 withdrew wakeGrant synchronously with pending-append before appending, invalidating active snapshot and blocking prepare.
  assert.ok(observedStates.length >= 2, 'index-removed fired both on pre-append withdrawal and post-tidy swap');
  assert.equal(observedStates[0].wakeGrant, undefined, 'Step 1 removes wakeGrant on disk (fail-closed on v0.8.7 rollback)');
  assert.deepEqual(observedStates[0].compact, { grant, state: 'pending-append' });
  assert.equal(observedStates[0].snapValid, false, 'active snapshot invalidated immediately on Step 1');
  assert.equal(observedStates[0].prepareBlocked, true, 'new wake checks blocked immediately on Step 1');

  // Verify ZERO recrawl requests: only the single delta token follow-up request was made.
  const reqs = asked.slice(askedFrom).filter(q => q.who === ALICE && q.url.includes('/drives/b!d/items/top/delta'));
  assert.equal(reqs.length, 1, `expected exactly 1 delta request (no recrawl), got ${reqs.length}: ${JSON.stringify(reqs)}`);
  assert.match(reqs[0].url, /\?token=s\d+$/, 'used existing deltaLink rather than restarting from scratch');

  const afterCache = cache(ALICE, FOLDER);
  assert.equal(afterCache.gen, beforeGen + 1);
  assert.equal(afterCache.compact, undefined);
  assert.equal(afterCache.wakeGrant, grant);
  assert.notEqual(afterCache.parts[''].delta, oldDelta);
  assert.ok(afterCache.parts[''].delta, 'deltaLink preserved');
  assert.equal(existsSync(oldFeed), false, 'old uncompacted feed removed');

  const compactedIds = lines(feedOf(ALICE, FOLDER)).map(l => l.id).sort();
  assert.deepEqual(compactedIds, ['keep1', 'top'], 'deleted item, subfolder descendants, and sparse-updated child under deleted folder all purged');
  assert.ok(lines(feedOf(ALICE, FOLDER)).every(l => !l.deleted && !l['@removed']), 'no raw tombstones remain');

  // Immediate follow-up wake check succeeds cleanly.
  const snapAfter = await ix.prepare(inst, join(tmp, 'runs', 'p2-after'), lease, new AbortController().signal);
  assert.equal(snapAfter?.valid(), true);
  assert.deepEqual(lines(join(tmp, 'runs', 'p2-after', 'Top.ndjson.zst')).map(l => l.id).sort(), ['keep1', 'top']);
  const readme = readFileSync(join(tmp, 'runs', 'p2-after', 'README.md'), 'utf8');
  assert.match(readme, /query `NAME\.ndjson\.zst` locally first/i);
  assert.match(readme, /plain-text `body`/i);
  assert.match(readme, /wake check.*no network/i);

  // Mail folder deletion also compacts locally without recrawling remaining folders.
  const mailAsked = asked.length;
  put('mail', { id: 'submail', '@removed': { reason: 'deleted' } }, '');
  await due(ALICE, MAIL);
  const mailReqs = asked.slice(mailAsked).filter(q => q.who === ALICE && q.url.includes('/mailFolders/'));
  assert.ok(mailReqs.every(q => q.url.includes('$deltatoken=s')), `mail deletion did not recrawl: ${JSON.stringify(mailReqs)}`);
  assert.equal(cache(ALICE, MAIL).parts.submail, undefined);
  assert.equal(cache(ALICE, MAIL).wakeGrant, grant);
  assert.deepEqual(lines(feedOf(ALICE, MAIL)).map(l => l.id).sort(), ['inbox', 'm1'], 'deleted mail folder and its messages purged locally');
});

test('P1: surviving sparse rows preserve parentReference and parentFolderId across a first compaction so a later parent deletion purges descendants', async () => {
  const grant = JSON.stringify(['gen-1', null]);
  // 1) Drive item: create folder + child + unrelated file, sync, then sparse-update child + delete unrelated file (compaction #1),
  // then delete parent folder in a subsequent batch (compaction #2).
  put('b!d', folder('b!d', 'p1Folder', 'P1Folder', 'top'));
  put('b!d', file('b!d', 'p1Child', 'p1child.xlsx', 'p1Folder'));
  put('b!d', file('b!d', 'p1Unrelated', 'unrelated.xlsx', 'top'));
  await due(ALICE, FOLDER);

  const genBefore1 = cache(ALICE, FOLDER).gen;
  put('b!d', { ...state['b!d'].get('p1Child')!, name: 'p1child-sparse.xlsx' }, '', { id: 'p1Child', name: 'p1child-sparse.xlsx', file: {} });
  put('b!d', { id: 'p1Unrelated', deleted: {} });
  await due(ALICE, FOLDER);

  assert.equal(cache(ALICE, FOLDER).gen, genBefore1 + 1, 'compaction #1 completed on unrelated deletion');
  assert.equal(cache(ALICE, FOLDER).wakeGrant, grant);
  const survivedDrive = lines(feedOf(ALICE, FOLDER)).find(l => l.id === 'p1Child');
  assert.ok(survivedDrive, 'sparse child survives compaction #1 while parent is live');
  assert.deepEqual(survivedDrive.parentReference, { driveId: 'b!d', id: 'p1Folder' }, 'parentReference persisted across compaction #1');

  const genBefore2 = cache(ALICE, FOLDER).gen;
  put('b!d', { id: 'p1Folder', deleted: {} });
  await due(ALICE, FOLDER);

  assert.equal(cache(ALICE, FOLDER).gen, genBefore2 + 1, 'compaction #2 completed on parent deletion');
  assert.equal(cache(ALICE, FOLDER).wakeGrant, grant);
  const afterDriveIds = lines(feedOf(ALICE, FOLDER)).map(l => l.id);
  assert.ok(!afterDriveIds.includes('p1Folder') && !afterDriveIds.includes('p1Child'), `deleted parent and sparse descendant purged in second compaction: ${JSON.stringify(afterDriveIds)}`);
  const inst = instance(ALICE, [FOLDER]), lease = logins.authority(inst);
  const snap = await ix.prepare(inst, join(tmp, 'runs', 'p1-drive-after'), lease, new AbortController().signal);
  assert.equal(snap?.valid(), true);
  assert.ok(!lines(join(tmp, 'runs', 'p1-drive-after', 'Top.ndjson.zst')).some(l => l.id === 'p1Child'));

  // 2) Mail item: same two-compaction sequence preserving parentFolderId.
  put('mail', { id: 'p1MailFolder', displayName: 'P1Mail', parentFolderId: 'inbox' }, '');
  await due(ALICE, MAIL);
  put('mail', { id: 'p1Msg', subject: 'P1Msg', parentFolderId: 'p1MailFolder', body: { contentType: 'text', content: 'secret' } }, 'p1MailFolder');
  put('mail', { id: 'p1MailOther', subject: 'Other', parentFolderId: 'inbox', body: { contentType: 'text', content: 'other' } }, 'inbox');
  await due(ALICE, MAIL);

  const mailGen1 = cache(ALICE, MAIL).gen;
  put('mail', { ...state.mail.get('p1Msg')!, subject: 'P1Msg-sparse' }, 'p1MailFolder', { id: 'p1Msg', subject: 'P1Msg-sparse' });
  put('mail', { id: 'p1MailOther', '@removed': { reason: 'deleted' } }, 'inbox');
  await due(ALICE, MAIL);

  assert.equal(cache(ALICE, MAIL).gen, mailGen1 + 1, 'mail compaction #1 completed');
  assert.equal(cache(ALICE, MAIL).wakeGrant, grant);
  const survivedMail = lines(feedOf(ALICE, MAIL)).find(l => l.id === 'p1Msg');
  assert.ok(survivedMail, 'sparse mail message survives compaction #1');
  assert.equal(survivedMail.parentFolderId, 'p1MailFolder', 'parentFolderId persisted across compaction #1');

  const mailGen2 = cache(ALICE, MAIL).gen;
  put('mail', { id: 'p1MailFolder', '@removed': { reason: 'deleted' } }, '');
  await due(ALICE, MAIL);

  assert.equal(cache(ALICE, MAIL).gen, mailGen2 + 1, 'mail compaction #2 completed');
  assert.equal(cache(ALICE, MAIL).wakeGrant, grant);
  const afterMailIds = lines(feedOf(ALICE, MAIL)).map(l => l.id);
  assert.ok(!afterMailIds.includes('p1MailFolder') && !afterMailIds.includes('p1Msg'), `deleted mail folder and sparse message purged: ${JSON.stringify(afterMailIds)}`);

  // 3) Drive item with partial parentReference { driveId } (omitting folder id) must merge rather than lose folder id across compaction.
  put('b!d', folder('b!d', 'p1PartialFolder', 'P1Partial', 'top'));
  put('b!d', file('b!d', 'p1PartialChild', 'partial.xlsx', 'p1PartialFolder', { parentReference: { driveId: 'b!d', id: 'p1PartialFolder', path: '/drives/b!d/root:/P1Partial' } }));
  put('b!d', file('b!d', 'p1PartialOther', 'other.xlsx', 'top'));
  await due(ALICE, FOLDER);

  const partialGen1 = cache(ALICE, FOLDER).gen;
  put('b!d', { ...state['b!d'].get('p1PartialChild')!, name: 'partial-renamed.xlsx' }, '', { id: 'p1PartialChild', name: 'partial-renamed.xlsx', file: {}, parentReference: { driveId: 'b!d' } });
  put('b!d', { id: 'p1PartialOther', deleted: {} });
  await due(ALICE, FOLDER);

  assert.equal(cache(ALICE, FOLDER).gen, partialGen1 + 1, 'compaction #1 completed for partial parentReference test');
  const survivedPartial = lines(feedOf(ALICE, FOLDER)).find(l => l.id === 'p1PartialChild');
  assert.ok(survivedPartial, 'partial-parentReference child survives compaction #1');
  assert.deepEqual(survivedPartial.parentReference, { driveId: 'b!d', id: 'p1PartialFolder', path: '/drives/b!d/root:/P1Partial' }, 'merged folder id and path preserved across compaction #1');

  const partialGen2 = cache(ALICE, FOLDER).gen;
  put('b!d', { id: 'p1PartialFolder', deleted: {} });
  await due(ALICE, FOLDER);

  assert.equal(cache(ALICE, FOLDER).gen, partialGen2 + 1, 'compaction #2 completed on partial folder deletion');
  const afterPartialIds = lines(feedOf(ALICE, FOLDER)).map(l => l.id);
  assert.ok(!afterPartialIds.includes('p1PartialFolder') && !afterPartialIds.includes('p1PartialChild'), `partial-parentReference child purged when folder deleted: ${JSON.stringify(afterPartialIds)}`);
});

test('P2: deleting every item in a wake cache compacts cleanly to an empty zstd feed and stays wake-ready', async () => {
  offer(BOB, [{ id: FOLDER2, name: 'Second' }], 'bob-1');
  const grant = JSON.stringify(['bob-1', null]);
  await work(() => existsSync(`${at(BOB, FOLDER2)}.json`) && cache(BOB, FOLDER2).wakeGrant === grant && !!cache(BOB, FOLDER2).parts['']?.delta && settled(BOB, FOLDER2)());

  put('b!d', { id: 'only', deleted: {} });
  put('b!d', { id: 'second', deleted: {} });
  await due(BOB, FOLDER2);

  const c = cache(BOB, FOLDER2);
  assert.equal(c.lines, 0);
  assert.equal(c.compact, undefined);
  assert.equal(c.wakeGrant, grant);
  assert.deepEqual(lines(feedOf(BOB, FOLDER2)), []);
  const inst = instance(BOB, [FOLDER2]), lease = logins.authority(inst);
  const snap = await ix.prepare(inst, join(tmp, 'runs', 'p2-empty'), lease, new AbortController().signal);
  assert.equal(snap?.valid(), true);
});

test('P2: crash at pending-append forces full reset recrawl on startup and never keeps pre-deletion bytes', async () => {
  const grant = JSON.stringify(['gen-1', null]);
  const c = cache(ALICE, FOLDER), beforeGen = c.gen, oldFeed = feedOf(ALICE, FOLDER);
  // Plant a synthetic pre-deletion secret row in the feed and mark pending-append without wakeGrant.
  appendFileSync(oldFeed, zstdCompressSync(`${JSON.stringify(file('b!d', 'leaked', 'secret.xlsx', 'top'))}\n`));
  const crashed = { ...c, length: statSync(oldFeed).size, lines: c.lines + 1, compact: { grant, state: 'pending-append' } };
  delete crashed.wakeGrant;
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(crashed));

  const inst = instance(ALICE, [FOLDER]), lease = logins.authority(inst);
  await assert.rejects(async () => ix.prepare(inst, join(tmp, 'runs', 'p2-pending-block'), lease, new AbortController().signal), /indexes/);

  const askedFrom = asked.length;
  await work(() => !cache(ALICE, FOLDER).compact && cache(ALICE, FOLDER).wakeGrant === grant && !!cache(ALICE, FOLDER).parts['']?.delta && settled(ALICE, FOLDER)());

  const reqs = asked.slice(askedFrom).filter(q => q.who === ALICE && q.url.includes('/drives/b!d/items/top/delta'));
  assert.ok(reqs.some(q => !q.url.includes('?token=')), 'pending-append forced a fresh crawl from scratch');
  assert.ok(cache(ALICE, FOLDER).gen > beforeGen);
  assert.equal(existsSync(oldFeed), false, 'pre-deletion feed deleted');
  assert.ok(!lines(feedOf(ALICE, FOLDER)).some(l => l.id === 'leaked'), 'pre-deletion row never survived');
});

test('P2: crash at appended resumes local tidy without recrawl, and sweeps orphan feeds on startup', async () => {
  const grant = JSON.stringify(['gen-1', null]);
  put('b!d', file('b!d', 'ephemeral', 'ephemeral.xlsx', 'top'));
  await due(ALICE, FOLDER);
  assert.ok(lines(feedOf(ALICE, FOLDER)).some(l => l.id === 'ephemeral'));

  // Simulate crash right after Step 2 (tombstone frame durably appended, wakeGrant cleared, compact='appended').
  const c = cache(ALICE, FOLDER), beforeGen = c.gen, oldFeed = feedOf(ALICE, FOLDER);
  appendFileSync(oldFeed, zstdCompressSync(`${JSON.stringify({ id: 'ephemeral', deleted: {} })}\n`));
  const crashed = { ...c, length: statSync(oldFeed).size, lines: c.lines + 1, compact: { grant, state: 'appended' } };
  delete crashed.wakeGrant;
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(crashed));

  // Also plant orphan feed & tmp files left by earlier crashes.
  const orphanOld = `${at(ALICE, FOLDER)}.${beforeGen - 1}.ndjson.zst`;
  const orphanNew = `${at(ALICE, FOLDER)}.${beforeGen + 5}.ndjson.zst`;
  const orphanTmp = `${at(ALICE, FOLDER)}.json.tmp`;
  writeFileSync(orphanOld, 'stale');
  writeFileSync(orphanNew, 'partial');
  writeFileSync(orphanTmp, '{broken');

  // While crashed at appended, wake checks fail closed (and v0.8.7 rollback sees no wakeGrant).
  const inst = instance(ALICE, [FOLDER]), lease = logins.authority(inst);
  await assert.rejects(async () => ix.prepare(inst, join(tmp, 'runs', 'p2-appended-block'), lease, new AbortController().signal), /indexes/);

  const askedFrom = asked.length;
  await work(() => !cache(ALICE, FOLDER).compact && cache(ALICE, FOLDER).gen > beforeGen);

  const reqs = asked.slice(askedFrom).filter(q => q.who === ALICE && q.url.includes('/drives/b!d/items/top/delta'));
  assert.equal(reqs.length, 0, 'resumed local tidy made ZERO Graph calls');
  assert.equal(cache(ALICE, FOLDER).wakeGrant, grant, 'wakeGrant restored after resumed tidy');
  assert.ok(!lines(feedOf(ALICE, FOLDER)).some(l => l.id === 'ephemeral'));
  assert.equal(existsSync(oldFeed), false);
  assert.equal(existsSync(orphanOld), false, 'orphan older feed swept');
  assert.equal(existsSync(orphanNew), false, 'orphan newer partial feed swept');
  assert.equal(existsSync(orphanTmp), false, 'orphan .json.tmp swept');

  const snap = await ix.prepare(inst, join(tmp, 'runs', 'p2-appended-ok'), lease, new AbortController().signal);
  assert.equal(snap?.valid(), true);
});

test('P2: crash at appended does not restore wakeGrant when wake-check capability was revoked or login rotated', async () => {
  const grant = JSON.stringify(['gen-1', null]);
  // Revoke Alice's wake-check capability before recovery.
  writeJson('capabilities.json', { 'wake-check': [BOB] });
  try {
    const c = cache(ALICE, FOLDER), beforeGen = c.gen, oldFeed = feedOf(ALICE, FOLDER);
    appendFileSync(oldFeed, zstdCompressSync(`${JSON.stringify({ id: 'keep1', deleted: {} })}\n`));
    const crashed = { ...c, length: statSync(oldFeed).size, lines: c.lines + 1, compact: { grant, state: 'appended' } };
    delete crashed.wakeGrant;
    writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(crashed));

    await work(() => !cache(ALICE, FOLDER).compact && cache(ALICE, FOLDER).gen > beforeGen);
    assert.equal(cache(ALICE, FOLDER).wakeGrant, undefined, 'wakeGrant NOT restored when capability revoked');
    assert.ok(!lines(feedOf(ALICE, FOLDER)).some(l => l.id === 'keep1'), 'deleted item still purged');
  } finally {
    writeJson('capabilities.json', { 'wake-check': [ALICE, BOB] });
  }

  // Rotate Alice's login generation while crashed in state: 'appended' — stale grant must NOT be restored.
  put('b!d', file('b!d', 'keep1', 'keep1.xlsx', 'top'));
  await work(() => cache(ALICE, FOLDER).wakeGrant === grant && !!cache(ALICE, FOLDER).parts['']?.delta && settled(ALICE, FOLDER)());
  {
    const c = cache(ALICE, FOLDER), beforeGen = c.gen, oldFeed = feedOf(ALICE, FOLDER);
    appendFileSync(oldFeed, zstdCompressSync(`${JSON.stringify({ id: 'keep1', deleted: {} })}\n`));
    const crashed = { ...c, length: statSync(oldFeed).size, lines: c.lines + 1, compact: { grant, state: 'appended' } };
    delete crashed.wakeGrant;
    writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(crashed));
    // Rotate login to gen-2 and revoke wake-check briefly so rebuild doesn't immediately overwrite the compacted gen.
    offer(ALICE, [{ id: FOLDER, name: 'Top' }, { id: MAIL, name: 'Team Mail' }], 'gen-2');
    writeJson('capabilities.json', { 'wake-check': [BOB] });
    try {
      await work(() => !cache(ALICE, FOLDER).compact && cache(ALICE, FOLDER).gen > beforeGen);
      assert.equal(cache(ALICE, FOLDER).wakeGrant, undefined, 'stale grant NOT restored after login generation rotated');
      assert.ok(!lines(feedOf(ALICE, FOLDER)).some(l => l.id === 'keep1'));
    } finally {
      writeJson('capabilities.json', { 'wake-check': [ALICE, BOB] });
      offer(ALICE, [{ id: FOLDER, name: 'Top' }, { id: MAIL, name: 'Team Mail' }], 'gen-1');
    }
  }

  // Restore keep1 and verify corrupted appended feed self-heals via resetCompact instead of looping.
  put('b!d', file('b!d', 'keep1', 'keep1.xlsx', 'top'));
  await work(() => cache(ALICE, FOLDER).wakeGrant === grant && !!cache(ALICE, FOLDER).parts['']?.delta && settled(ALICE, FOLDER)());
  const c2 = cache(ALICE, FOLDER), gen2 = c2.gen, feed2 = feedOf(ALICE, FOLDER);
  writeFileSync(feed2, Buffer.from('not-valid-zstd'));
  const broken = { ...c2, length: 9999, compact: { grant, state: 'appended' } };
  delete broken.wakeGrant;
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(broken));

  await work(() => !cache(ALICE, FOLDER).compact && cache(ALICE, FOLDER).gen > gen2 && cache(ALICE, FOLDER).wakeGrant === grant && !!cache(ALICE, FOLDER).parts['']?.delta && settled(ALICE, FOLDER)());
  assert.ok(lines(feedOf(ALICE, FOLDER)).some(l => l.id === 'keep1'), 'corrupt appended feed self-healed via reset recrawl');
});

test('P2: 410 and 403 on wake-capable caches still force full reset', async () => {
  const grant = JSON.stringify(['gen-1', null]);
  const c = cache(ALICE, FOLDER), gen1 = c.gen, oldFeed = feedOf(ALICE, FOLDER);
  c.parts[''].link = `${base}/v1.0/drives/b!d/items/top/delta?token=gone`;
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
  const from410 = asked.length;
  await due(ALICE, FOLDER);
  assert.ok(asked.slice(from410).some(q => q.url === '/drives/b!d/items/top/delta'), '410 recrawled from scratch');
  assert.ok(cache(ALICE, FOLDER).gen > gen1);
  assert.equal(existsSync(oldFeed), false);
  assert.equal(cache(ALICE, FOLDER).wakeGrant, grant);

  const gen2 = cache(ALICE, FOLDER).gen, feed2 = feedOf(ALICE, FOLDER);
  locked.add(ALICE);
  try {
    await due(ALICE, FOLDER);
  } finally {
    locked.delete(ALICE);
  }
  assert.ok(cache(ALICE, FOLDER).gen > gen2);
  assert.equal(cache(ALICE, FOLDER).length, 0);
  assert.equal(existsSync(feed2), false);

  // An unexplained mail folder 404 (NOT reported @removed by the folder list '') still forces full reset.
  await work(() => cache(ALICE, MAIL).wakeGrant === grant && !!cache(ALICE, MAIL).parts.inbox?.delta && settled(ALICE, MAIL)());
  const mailGen = cache(ALICE, MAIL).gen, mailFeed = feedOf(ALICE, MAIL);
  state.mail.set('inbox', { ...state.mail.get('inbox'), '@removed': { reason: 'deleted' } });
  const fromMail404 = asked.length;
  try {
    await due(ALICE, MAIL);
  } finally {
    state.mail.set('inbox', { id: 'inbox', displayName: 'Inbox', parentFolderId: 'mroot' });
  }
  assert.ok(cache(ALICE, MAIL).gen > mailGen);
  assert.equal(existsSync(mailFeed), false, 'unexplained mail folder 404 reset the old feed');
  assert.ok(asked.slice(fromMail404).some(q => q.url === '/users/team%40demo.test/mailFolders/delta'), 'unexplained 404 recrawled from scratch');
});

test('P2: mail folder removal combined with HTTP 410 in the same Graph batch resets cleanly in either response order', async () => {
  const grant = JSON.stringify(['gen-1', null]);
  for (const rev of [false, true]) {
    const fid = rev ? 'f410rev' : 'f410fwd', mid = rev ? 'm410rev' : 'm410fwd';
    put('mail', { id: fid, displayName: fid, parentFolderId: 'inbox' }, '');
    await due(ALICE, MAIL);
    put('mail', { id: mid, subject: 'WillVanish', parentFolderId: fid, body: { contentType: 'text', content: 'x' } }, fid);
    await due(ALICE, MAIL);
    assert.ok(cache(ALICE, MAIL).parts[fid]?.delta, `folder ${fid} crawled`);

    const c = cache(ALICE, MAIL), beforeGen = c.gen, oldFeed = feedOf(ALICE, MAIL);
    c.parts[fid].link = `${base}/v1.0/users/${encodeURIComponent(BOX)}/mailFolders/${fid}/messages/delta?$deltatoken=gone`;
    writeFileSync(`${at(ALICE, MAIL)}.json`, JSON.stringify(c));
    put('mail', { id: fid, '@removed': { reason: 'deleted' } }, '');

    reverseBatch = rev;
    try {
      await due(ALICE, MAIL);
    } finally {
      reverseBatch = false;
    }

    const after = cache(ALICE, MAIL);
    assert.ok(after.gen > beforeGen, `batch reset committed (reverse=${rev})`);
    assert.equal(existsSync(oldFeed), false, `old feed removed (reverse=${rev})`);
    assert.equal(after.parts[fid], undefined, `removed folder dropped from parts (reverse=${rev})`);
    assert.ok(after.parts['']?.delta && after.parts.inbox?.delta, `surviving parts rebuilt and recrawled (reverse=${rev})`);
  assert.equal(after.wakeGrant, grant);
    const ids = lines(feedOf(ALICE, MAIL)).map(l => l.id).sort();
    assert.deepEqual(ids, ['inbox', 'm1'], `surviving rows intact without removed folder/messages (reverse=${rev})`);
  }
});

test('wake-check prepare rejects stale or null as_of past 150m default, honors RF_WAKE_MAX_STALE_MIN and per-wake maxStaleMin override', async () => {
  await due(ALICE, FOLDER);
  const c = cache(ALICE, FOLDER);
  const origAsOf = c.parts[''].as_of;
  const inst = instance(ALICE, [FOLDER]), lease = logins.authority(inst);
  try {
    // 1) Older than 150m default -> rejected as stale.
    c.parts[''].as_of = new Date(Date.now() - 151 * 60_000).toISOString();
    writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
    await assert.rejects(async () => ix.prepare(inst, join(tmp, 'runs', 'stale-default'), lease, new AbortController().signal), /stale/);

    // 2) Per-wake maxStaleMin=200 allows 151m-old cache, while maxStaleMin=120 rejects it.
    const allowed = await ix.prepare(inst, join(tmp, 'runs', 'stale-override-ok'), lease, new AbortController().signal, 200);
    assert.equal(allowed?.valid(), true);
    await assert.rejects(async () => ix.prepare(inst, join(tmp, 'runs', 'stale-override-reject'), lease, new AbortController().signal, 120), /stale/);

    // 3) RF_WAKE_MAX_STALE_MIN overrides default when per-wake override is omitted.
    process.env.RF_WAKE_MAX_STALE_MIN = '180';
    const envOk = await ix.prepare(inst, join(tmp, 'runs', 'stale-env-ok'), lease, new AbortController().signal);
    assert.equal(envOk?.valid(), true);
    process.env.RF_WAKE_MAX_STALE_MIN = '60';
    await assert.rejects(async () => ix.prepare(inst, join(tmp, 'runs', 'stale-env-reject'), lease, new AbortController().signal), /stale/);
    delete process.env.RF_WAKE_MAX_STALE_MIN;

    // 4) Null as_of is always rejected as stale.
    c.parts[''].as_of = null;
    writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
    await assert.rejects(async () => ix.prepare(inst, join(tmp, 'runs', 'stale-null'), lease, new AbortController().signal, 10_080), /stale/);

    // 5) Multi-part cache uses conservative (oldest) part as_of.
    const mc = cache(ALICE, MAIL), origInboxAsOf = mc.parts.inbox.as_of;
    const mailInst = instance(ALICE, [MAIL]), mailLease = logins.authority(mailInst);
    try {
      mc.parts[''].as_of = new Date().toISOString();
      mc.parts.inbox.as_of = new Date(Date.now() - 160 * 60_000).toISOString();
      writeFileSync(`${at(ALICE, MAIL)}.json`, JSON.stringify(mc));
      await assert.rejects(async () => ix.prepare(mailInst, join(tmp, 'runs', 'stale-multipart'), mailLease, new AbortController().signal), /stale/);
      const mpOk = await ix.prepare(mailInst, join(tmp, 'runs', 'stale-multipart-ok'), mailLease, new AbortController().signal, 200);
      assert.equal(mpOk?.valid(), true);
    } finally {
      mc.parts.inbox.as_of = origInboxAsOf;
      writeFileSync(`${at(ALICE, MAIL)}.json`, JSON.stringify(mc));
    }
  } finally {
    delete process.env.RF_WAKE_MAX_STALE_MIN;
    c.parts[''].as_of = origAsOf;
    writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
  }
});

test('P3: non-reflink fallback enforces RF_WAKE_COPY_MB, rejects multi-file overflow upfront with no stray files, and respects override', async t => {
  if (supportsReflink(tmp)) return t.skip('tmpdir supports reflink; non-reflink fallback covered on tmpfs/ext4');

  const o1 = 'm365:item:b!d/top', o2 = 'm365:item:b!d/second';
  offer(BOB, [{ id: o1, name: 'BigOne' }, { id: o2, name: 'BigTwo' }], 'bob-p3');
  const grant = JSON.stringify(['bob-p3', null]);
  const setupCache = (offerId: string, name: string, actualBytes: number, claimedLength: number) => {
    const k = at(BOB, offerId);
    rmSync(`${k}.0.ndjson.zst`, { force: true });
    writeFileSync(`${k}.0.ndjson.zst`, Buffer.alloc(actualBytes, 0x61));
    writeFileSync(`${k}.json`, JSON.stringify({
      person: BOB, source: offerId, name, gen: 0, length: claimedLength, lines: 1, base: claimedLength,
      wakeGrant: grant, parts: { '': { link: `${base}/x`, delta: 'ok', as_of: new Date().toISOString(), pages: 1, due: Date.now() + 3_600_000, error: null, tries: 0 } },
    }));
  };

  // Single >64 MiB feed rejects with zero stray files written.
  setupCache(o1, 'BigOne', 16, 70 * 2 ** 20);
  const inst1 = instance(BOB, [o1]), lease1 = logins.authority(inst1);
  const d1 = join(tmp, 'runs', 'p3-single-over');
  await assert.rejects(async () => ix.prepare(inst1, d1, lease1, new AbortController().signal), /wake check index copy limit/);
  assert.deepEqual(existsSync(d1) ? readdirSync(d1) : [], [], 'no partial files left after copy-limit rejection');

  // Two feeds (40 MiB + 40 MiB = 80 MiB > 64 MiB) reject BEFORE streaming file #1.
  setupCache(o1, 'BigOne', 16, 40 * 2 ** 20);
  setupCache(o2, 'BigTwo', 16, 40 * 2 ** 20);
  const inst2 = instance(BOB, [o1, o2]), lease2 = logins.authority(inst2);
  const d2 = join(tmp, 'runs', 'p3-multi-over');
  await assert.rejects(async () => ix.prepare(inst2, d2, lease2, new AbortController().signal), /wake check index copy limit/);
  assert.deepEqual(existsSync(d2) ? readdirSync(d2) : [], [], 'multi-file overflow rejects upfront with no partial files');

  // RF_WAKE_COPY_MB override: 1 MiB rejects 2 MiB feed; 3 MiB allows 2 MiB feed; 0 rejects any non-empty feed.
  const twoMb = 2 * 2 ** 20;
  setupCache(o1, 'BigOne', twoMb, twoMb);
  try {
    process.env.RF_WAKE_COPY_MB = '1';
    await assert.rejects(async () => ix.prepare(inst1, join(tmp, 'runs', 'p3-env-1mb'), lease1, new AbortController().signal), /wake check index copy limit/);

    process.env.RF_WAKE_COPY_MB = '0';
    await assert.rejects(async () => ix.prepare(inst1, join(tmp, 'runs', 'p3-env-0mb'), lease1, new AbortController().signal), /wake check index copy limit/);

    process.env.RF_WAKE_COPY_MB = '3';
    const dOk = join(tmp, 'runs', 'p3-env-3mb');
    const snap = await ix.prepare(inst1, dOk, lease1, new AbortController().signal);
    assert.equal(snap?.valid(), true);
    assert.equal(statSync(join(dOk, 'BigOne.ndjson.zst')).size, twoMb);

    // Truncated source (< c.length) fails closed and cleans up staged file.
    truncateSync(`${at(BOB, o1)}.0.ndjson.zst`, 1024);
    const dShort = join(tmp, 'runs', 'p3-short');
    await assert.rejects(async () => ix.prepare(inst1, dShort, lease1, new AbortController().signal), /index feed changed during the copy/);
    assert.deepEqual(existsSync(dShort) ? readdirSync(dShort) : [], [], 'truncated copy cleaned up');
  } finally {
    delete process.env.RF_WAKE_COPY_MB;
  }
});

test('R1 #10: path-only parentReference survives sparse updates across compaction', async () => {
  put('b!d', file('b!d', 'pathOnly', 'pathOnly.xlsx', 'top'), '', { id: 'pathOnly', name: 'pathOnly.xlsx', file: {}, parentReference: { path: '/drive/root:/Finance' } });
  put('b!d', file('b!d', 'pathDrop', 'drop.xlsx', 'top'));
  await due(ALICE, FOLDER);

  const genBefore = cache(ALICE, FOLDER).gen;
  put('b!d', file('b!d', 'pathOnly', 'pathOnly-renamed.xlsx', 'top'), '', { id: 'pathOnly', name: 'pathOnly-renamed.xlsx', file: {} });
  put('b!d', { id: 'pathDrop', deleted: {} });
  await due(ALICE, FOLDER);

  assert.equal(cache(ALICE, FOLDER).gen, genBefore + 1, 'compaction ran on deletion');
  const row = lines(feedOf(ALICE, FOLDER)).find(l => l.id === 'pathOnly');
  assert.ok(row, 'path-only item survived compaction');
  assert.deepEqual(row.parentReference, { path: '/drive/root:/Finance' }, 'path-only parentReference preserved after sparse update + compaction');
});
