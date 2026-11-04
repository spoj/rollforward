import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Instance } from '../src/store.ts';

// A stand-in for Microsoft's sign-in and Graph: a library whose ticked folder has a subfolder shared with Bob, who sees only what is
// under it; a bigger library for a crawl cut by a restart; Dan's OneDrive; and a shared mailbox. Each person's access token is their refresh token,
// which is their address. Delta pages hold three items, or two messages; a cursor's token says where it is.
const ALICE = 'alice@demo.test', BOB = 'bob@demo.test', CAROL = 'carol@demo.test', DAN = 'dan@demo.test', BOX = 'team@demo.test';
const FOLDER = 'm365:item:b!d/top', PUB = 'm365:item:b!d/pub', BIG = 'm365:item:b!big/bigtop', MAIL = `m365:mail:${BOX}`, SITE = 'm365:site:host,s1,w1', ONEDRIVE = 'm365:onedrive';
const tmp = mkdtempSync(join(tmpdir(), 'rf-index-'));
let graph: Server, base = '', ix: typeof import('../src/indexes.ts'), logins: typeof import('../src/logins.ts');

type Item = Record<string, any>;
const state: Record<string, Map<string, Item>> = {}, changed: { at: string; seq: number; id: string; where: string }[] = [];
let seq = 0;
const put = (at: string, item: Item, where = '') => { (state[at] ??= new Map()).set(item.id, item); changed.push({ at, seq: ++seq, id: item.id, where }); };
const file = (d: string, id: string, name: string, parent: string, more = {}) => ({ id, name, file: {}, parentReference: { driveId: d, id: parent }, ...more });
const folder = (d: string, id: string, name: string, parent: string, more = {}) => ({ id, name, folder: {}, parentReference: { driveId: d, id: parent }, ...more });
const parentOf = (d: string, id: string) => state[d].get(id)?.parentReference?.id;
const under = (d: string, id: string, top: string) => { for (let x: string | undefined = id; x; x = parentOf(d, x)) if (x === top) return true; return false; };
const locked = new Set<string>(), closed = new Set<string>();
const sees = (who: string, d: string, id: string) => !locked.has(who) && (who !== BOB || under(d, id, 'pub'));

// What each person asked: each request inside a $batch, with its Prefer, and each $batch's size. `hold` keeps a page unanswered,
// for a crawl to be cut; `once` answers a person's next delta request with a status instead.
const asked: { who: string; url: string; prefer?: string }[] = [], batches: number[] = [];
let hold: { token: string; reached: () => void } | undefined;
const once = new Map<string, number>();

function delta(who: string, d: string, scope: string | undefined, token: string | null): { status: number; headers?: Record<string, string>; body: any } {
  const link = (t: string) => `${base}/v1.0/drives/${d}/${scope ? `items/${scope}` : 'root'}/delta?token=${t}`;
  if (token === 'gone') return { status: 410, body: { error: { code: 'resyncRequired' } } };
  if ((scope && !sees(who, d, scope)) || closed.has(`${who} ${d}`)) return { status: 403, body: { error: { code: 'accessDenied' } } };
  const trick = once.get(who);
  if (trick) return once.delete(who), { status: trick, headers: { 'Retry-After': '120' }, body: { error: { code: 'activityLimitReached' } } };
  const inScope = (id: string) => !scope || under(d, id, scope);
  if (token?.startsWith('s')) {
    const ids = [...new Set(changed.filter(c => c.at === d && c.seq > Number(token.slice(1))).map(c => c.id))];
    return { status: 200, body: { value: ids.map(id => state[d].get(id)!).filter(it => it.deleted || (inScope(it.id) && sees(who, d, it.id))), '@odata.deltaLink': link(`s${seq}`) } };
  }
  const [at, from] = token ? token.slice(1).split('.').map(Number) : [0, seq];
  const all = [...state[d].values()].filter(it => !it.deleted && inScope(it.id) && sees(who, d, it.id)), page = all.slice(at, at + 3);
  return { status: 200, body: { value: page, ...(at + 3 < all.length ? { '@odata.nextLink': link(`c${at + 3}.${from}`) } : { '@odata.deltaLink': link(`s${from}`) }) } };
}

// The shared mailbox: its folders, then each folder's messages; a folder that's gone answers 404.
function mail(fid: string | undefined, token: string | null): { status: number; body: any } {
  if (fid && state.mail.get(fid)?.['@removed']) return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
  const where = fid ?? '', link = (t: string) => `${base}/v1.0/users/${encodeURIComponent(BOX)}/mailFolders/${fid ? `${fid}/messages/` : ''}delta?$deltatoken=${t}`;
  if (token?.startsWith('s')) {
    const ids = [...new Set(changed.filter(c => c.at === 'mail' && c.where === where && c.seq > Number(token.slice(1))).map(c => c.id))];
    return { status: 200, body: { value: ids.map(id => state.mail.get(id)), '@odata.deltaLink': link(`s${seq}`) } };
  }
  const [at, from] = token ? token.slice(1).split('.').map(Number) : [0, seq];
  const all = [...state.mail.values()].filter(it => !it['@removed'] && (fid ? it.parentFolderId === fid && it.subject : it.displayName)), page = all.slice(at, at + 2);
  return { status: 200, body: { value: page, ...(at + 2 < all.length ? { '@odata.nextLink': link(`c${at + 2}.${from}`) } : { '@odata.deltaLink': link(`s${from}`) }) } };
}

function answer(who: string, url: string, prefer?: string): { status: number; headers?: Record<string, string>; body: any } {
  asked.push({ who, url, prefer });
  const u = new URL(url, 'http://x'), path = decodeURIComponent(u.pathname).replace(/^\/v1\.0/, ''), token = u.searchParams.get('token') ?? u.searchParams.get('$deltatoken');
  let m;
  if ((m = /^\/drives\/([^/]+)\/(?:items\/([^/]+)|root)\/delta$/.exec(path))) return delta(who, m[1], m[2], token);
  if (path === '/me/drive/root/delta' && who === DAN) return delta(who, 'b!own', undefined, token);
  if ((m = /^\/users\/[^/]+\/mailFolders\/(?:([^/]+)\/messages\/)?delta$/.exec(path))) return mail(m[1], token);
  if (path === '/sites/host,s1,w1/drives') return { status: 200, body: { value: [{ id: 'b!d' }, { id: 'b!big' }] } };
  return { status: 404, body: { error: { code: 'itemNotFound', message: path } } };
}

before(async () => {
  graph = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      const send = (status: number, b: unknown, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(b));
      const path = new URL(req.url!, 'http://x').pathname, who = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (path === '/.well-known/openid-configuration') return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
      if (path === '/token') {
        const r = new URLSearchParams(body).get('refresh_token');
        return r === 'expired' ? send(400, { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }) : send(200, { access_token: r, expires_in: 3600 });
      }
      if (path === '/v1.0/$batch') {
        const requests = JSON.parse(body).requests as { id: string; url: string; headers?: { prefer?: string } }[];
        batches.push(requests.length);
        const responses = requests.map(r => ({ id: r.id, ...answer(who, r.url, r.headers?.prefer) }));
        if (hold && requests.some(r => r.url.includes(`token=${hold!.token}`))) return hold.reached();
        return send(200, { responses });
      }
      const a = answer(who, req.url!);
      send(a.status, a.body, a.headers);
    });
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
  Object.assign(process.env, { RF_OIDC_ISSUER: base, RF_OIDC_CLIENT_ID: 'app', RF_PUBLIC_URL: 'http://127.0.0.1:1', RF_M365_SCOPES: 'Mail.Read Mail.Read.Shared Files.Read.All Sites.Read.All' });
  const { initSystem, saveTree } = await import('../src/system.ts');
  const { upsertUser } = await import('../src/auth.ts');
  initSystem(tmp);
  saveTree({ workspaces: { w: { name: 'W', owners: [ALICE], members: [BOB, CAROL, DAN] } }, series: { weekly: { name: 'Weekly', workspace: 'w' } } });
  for (const p of [ALICE, BOB, CAROL, DAN]) upsertUser(p, { role: 'user' });
  (await import('../src/connections/graph.ts')).endpoints.graph = base;
  logins = await import('../src/logins.ts');
  ix = await import('../src/indexes.ts');
  put('b!d', { id: 'droot', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!d' } });
  put('b!d', folder('b!d', 'top', 'LFM', 'droot'));
  put('b!d', file('b!d', 'f1', 'aging.xlsx', 'top'));
  put('b!d', folder('b!d', 'sub', '2026', 'top'));
  put('b!d', file('b!d', 'f2', 'march.xlsx', 'sub'));
  put('b!d', folder('b!d', 'pub', 'Shared with Bob', 'top', { shared: { scope: 'users' } }));
  put('b!d', file('b!d', 'f3', 'bob.xlsx', 'pub'));
  put('b!d', file('b!d', 'out', 'elsewhere.xlsx', 'droot'));
  put('b!big', { id: 'bigroot', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!big' } });
  put('b!big', folder('b!big', 'bigtop', 'Big', 'bigroot'));
  for (let i = 1; i <= 8; i++) put('b!big', file('b!big', `b${i}`, `${i}.xlsx`, 'bigtop'));
  put('b!own', { id: 'oroot', name: 'root', root: {}, folder: {}, parentReference: { driveId: 'b!own' } });
  put('b!own', file('b!own', 'o1', 'notes.docx', 'oroot'));
  put('mail', { id: 'fin', displayName: 'Inbox', parentFolderId: 'mroot' }, '');
  put('mail', { id: 'fsub', displayName: 'Clients', parentFolderId: 'fin' }, '');
  put('mail', { id: 'farc', displayName: 'Archive', parentFolderId: 'mroot' }, '');
  for (const [id, f] of [['m1', 'fin'], ['m2', 'fin'], ['m3', 'fin'], ['m4', 'fsub'], ['m5', 'farc']]) put('mail', { id, subject: `Re: ${id}`, parentFolderId: f, body: { contentType: 'text', content: `about ${id}` } }, f);
});
after(async () => { await ix.stopIndexing(); graph.close(); rmSync(tmp, { recursive: true, force: true }); });

const offer = (who: string, offers: { id: string; name: string }[], since = '2026-11-01T00:00:00Z', secret = who) =>
  logins.saveLogin(who, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: who, since, offers }, secret);
const at = (who: string, offerId: string) => join(logins.personDir(who), 'index', createHash('sha256').update(offerId).digest('hex').slice(0, 16));
const cache = (who: string, offerId: string) => JSON.parse(readFileSync(`${at(who, offerId)}.json`, 'utf8'));
const feedOf = (who: string, offerId: string) => `${at(who, offerId)}.${cache(who, offerId).gen}.ndjson.zst`;
const lines = (f: string) => (existsSync(f) ? zstdDecompressSync(readFileSync(f)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
// What a feed says now: a later line for an id replaces an earlier one, and a deleted or @removed one removes it, a folder's with
// everything under it.
function now(feed: Item[]) {
  const m = new Map<string, Item>(), gone = new Set<string>(), up = (l: Item) => l.parentFolderId ?? l.parentReference?.id ?? l.parentReference?.driveId;
  for (const l of feed) l.deleted || l['@removed'] ? (m.delete(l.id), gone.add(l.id)) : (m.set(l.id, l), gone.delete(l.id));
  const dead = (id: string | undefined): boolean => id !== undefined && (gone.has(id) || (m.has(id) && dead(up(m.get(id)!))));
  return [...m.keys()].filter(id => !dead(up(m.get(id)!))).sort();
}
const until = async (done: () => boolean) => { for (let i = 0; !done(); i++) { assert.ok(i < 3000, 'it never happened'); await new Promise(ok => setTimeout(ok, 20)); } };
// The worker runs until `done`, then stops, so that what a test writes next doesn't race it.
async function work(done: () => boolean) {
  ix.startIndexing();
  await until(done);
  await ix.stopIndexing();
}
// Whether the worker is done with these caches: none is due, nor wants a tidy-up.
const settled = (who: string, ...offerIds: string[]) => () => offerIds.every(o => {
  if (!existsSync(`${at(who, o)}.json`)) return false;
  const c = cache(who, o), ps = Object.values(c.parts) as { due: number | null; delta: string | null }[];
  return ps.every(p => p.due === null || p.due > Date.now()) && !(ps.every(p => p.delta) && c.length > c.base * 1.25);
});
// The worker catches a person's caches up now, as it would within the hour.
async function due(who: string, ...offerIds: string[]) {
  for (const o of offerIds) {
    const c = cache(who, o);
    for (const p of Object.values(c.parts) as { due: number | null }[]) p.due = Date.now();
    writeFileSync(`${at(who, o)}.json`, JSON.stringify(c));
  }
  await work(settled(who, ...offerIds));
}

// A run of `who`'s with these offers ticked, and what it reads at $RF_INDEX: it never waits.
const instance = (who: string, ticked: string[]) => ({ seriesId: 'weekly', log: [{ seq: 1, at: '', by: who, op: 'create', logins: ticked }] }) as unknown as Instance;
function run(who: string, ticked: string[]) {
  const to = join(tmp, '.rf', 'runs', `run-${Math.random()}`);
  ix.prepare(instance(who, ticked), to);
  return (name: string) => ({ lines: lines(join(to, `${name}.ndjson.zst`)), meta: existsSync(join(to, `${name}.json`)) ? JSON.parse(readFileSync(join(to, `${name}.json`), 'utf8')) : null, file: join(to, `${name}.ndjson.zst`) });
}

test('a crawl cut by a restart goes on at the page it was on, and meanwhile a run starts at once with what is committed', async () => {
  offer(DAN, [{ id: BIG, name: 'Big' }]);
  const env = { ...process.env, ROOT: tmp, GRAPH: base, SRC: new URL('../src/', import.meta.url).href };
  const script = `const { initSystem } = await import(process.env.SRC + 'system.ts'); initSystem(process.env.ROOT);
    (await import(process.env.SRC + 'connections/graph.ts')).endpoints.graph = process.env.GRAPH;
    (await import(process.env.SRC + 'indexes.ts')).startIndexing(); setInterval(() => {}, 1000);`;
  const child = () => spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: 'inherit' });
  const reached = new Promise<void>(ok => { hold = { token: 'c6', reached: ok }; });
  const first = child();
  await reached;
  first.kill('SIGKILL');
  await new Promise(ok => first.on('exit', ok));
  hold = undefined;
  assert.match(cache(DAN, BIG).parts[''].link, /token=c6\./, 'the cursor is at the third page');
  // What a write cut short leaves past the committed length isn't the run's.
  appendFileSync(feedOf(DAN, BIG), zstdCompressSync(`${JSON.stringify({ id: 'b9', name: 'half-written.xlsx' })}\n`));
  const asking = asked.length, d = run(DAN, [BIG])('Big');
  assert.equal(asked.length, asking, 'the run asked Graph nothing');
  assert.equal(d.lines.length, 6, 'two pages were committed');
  assert.equal(d.meta.as_of, null, 'still being built');
  const from = asked.length, second = child();
  await until(() => !!cache(DAN, BIG).parts[''].delta);
  second.kill('SIGKILL');
  await new Promise(ok => second.on('exit', ok));
  assert.match(asked.filter((a, i) => i >= from && a.who === DAN)[0].url, /token=c6\./, 'the restart asked for the third page first');
  assert.deepEqual(now(lines(feedOf(DAN, BIG))), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'bigtop']);
});

test('stopping indexing drops the $batch in flight at once, and the cursor stays where it was', async () => {
  const c = cache(DAN, BIG), token = new URL(c.parts[''].link).searchParams.get('token')!;
  c.parts[''].due = Date.now();
  writeFileSync(`${at(DAN, BIG)}.json`, JSON.stringify(c));
  const reached = new Promise<void>(ok => { hold = { token, reached: ok }; });
  ix.startIndexing();
  await reached;
  const t = Date.now();
  await ix.stopIndexing();
  hold = undefined;
  assert.ok(Date.now() - t < 5_000, `the drain took ${Date.now() - t} ms, where the batch would wait 120 s`);
  assert.deepEqual(cache(DAN, BIG), c, 'nothing of the batch committed, nor counted as a failure');
});

test("each person's cache is their own delta feed, and a run gets a copy of it", async () => {
  offer(ALICE, [{ id: FOLDER, name: 'Folder LFM, Reports' }]);
  await work(settled(ALICE, FOLDER));
  const a = run(ALICE, [FOLDER])('Folder LFM, Reports');
  assert.deepEqual(now(a.lines), ['f1', 'f2', 'f3', 'pub', 'sub', 'top']);
  assert.deepEqual(a.lines.find(l => l.id === 'pub'), state['b!d'].get('pub'), "Graph's own JSON, verbatim");
  assert.deepEqual(a.meta, { source: FOLDER, as_of: cache(ALICE, FOLDER).parts[''].as_of, deltaLinks: [`${base}/v1.0/drives/b!d/items/top/delta?token=s${seq}`] });
  assert.notEqual(statSync(a.file).ino, statSync(feedOf(ALICE, FOLDER)).ino, 'a copy, not the cache itself');
  assert.ok(asked.filter(q => q.who === ALICE).every(q => q.prefer === 'deltashowremovedasdeleted'));
  // Bob can't open the folder, so he has no cache of it; the folder shared with him he has, as his token sees it.
  offer(BOB, [{ id: FOLDER, name: 'Folder LFM, Reports' }, { id: PUB, name: 'Folder Shared with Bob, Reports' }]);
  await work(settled(BOB, FOLDER, PUB));
  const b = run(BOB, [FOLDER, PUB]);
  assert.deepEqual(b('Folder LFM, Reports').lines, []);
  assert.equal(b('Folder LFM, Reports').meta.as_of, null);
  assert.match(cache(BOB, FOLDER).parts[''].error, /403/);
  assert.deepEqual(now(b('Folder Shared with Bob, Reports').lines), ['f3', 'pub']);
  // Someone with no cache yet gets nothing of it.
  offer(CAROL, [{ id: FOLDER, name: 'Folder LFM, Reports' }]);
  assert.equal(run(CAROL, [FOLDER])('Folder LFM, Reports').meta, null);
});

test('changes are appended, a later line winning', async () => {
  put('b!d', { ...state['b!d'].get('f1')!, name: 'aging v2.xlsx' });
  put('b!d', { id: 'f3', deleted: {} });
  await due(ALICE, FOLDER);
  const a = run(ALICE, [FOLDER])('Folder LFM, Reports');
  assert.deepEqual(now(a.lines), ['f1', 'f2', 'pub', 'sub', 'top']);
  assert.equal(a.lines.findLast(l => l.id === 'f1').name, 'aging v2.xlsx');
});

test('a crash after a batch is appended but before its .json is replaced replays the batch and nothing else', async () => {
  appendFileSync(feedOf(ALICE, FOLDER), zstdCompressSync(`${JSON.stringify({ id: 'f9', name: 'half-written.xlsx' })}\n`));
  put('b!d', file('b!d', 'f4', 'april.xlsx', 'top'));
  await due(ALICE, FOLDER);
  const feed = lines(feedOf(ALICE, FOLDER));
  assert.ok(!feed.some(l => l.id === 'f9'));
  assert.deepEqual(feed.filter(l => l.id === 'f4'), [state['b!d'].get('f4')]);
  assert.equal(statSync(feedOf(ALICE, FOLDER)).size, cache(ALICE, FOLDER).length);
});

test('a 410 crawls again, appending', async () => {
  const c = cache(ALICE, FOLDER);
  c.parts[''].link = `${base}/v1.0/drives/b!d/items/top/delta?token=gone`;
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
  const from = asked.length;
  await due(ALICE, FOLDER);
  assert.deepEqual(asked.slice(from).filter(q => q.who === ALICE).map(q => new URL(q.url, base).search).slice(0, 2), ['?token=gone', '']);
  assert.deepEqual(now(lines(feedOf(ALICE, FOLDER))), ['f1', 'f2', 'f4', 'pub', 'sub', 'top']);
  assert.ok(cache(ALICE, FOLDER).parts[''].delta);
});

test('the tidy-up writes a new feed without what later lines replaced or removed, a deleted folder with everything under it, and a run copying it meanwhile gets the old feed or the new', async () => {
  // As Graph's delta does, the folder's deletion comes alone.
  put('b!d', { id: 'sub', deleted: {} });
  state['b!d'].set('f2', { id: 'f2', deleted: {} });
  await due(ALICE, FOLDER);
  // Many lines to fold, so the tidy-up takes a while.
  const c = cache(ALICE, FOLDER), f = feedOf(ALICE, FOLDER), next = `${at(ALICE, FOLDER)}.${c.gen + 1}.ndjson.zst`;
  appendFileSync(f, zstdCompressSync(Array.from({ length: 20_000 }, () => `${JSON.stringify(state['b!d'].get('f1'))}\n`).join('')));
  Object.assign(c, { length: statSync(f).size, lines: c.lines + 20_000 });
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
  const old = readFileSync(f), copies: { racing: boolean; bytes: Buffer }[] = [];
  const copy = () => {
    const racing = existsSync(next), to = join(tmp, '.rf', 'runs', `race-${copies.length}`);
    ix.prepare(instance(ALICE, [FOLDER]), to);
    copies.push({ racing, bytes: readFileSync(join(to, 'Folder LFM, Reports.ndjson.zst')) });
  };
  let done = false;
  const copying = (async () => { while (!done) copy(), await new Promise(setImmediate); })();
  await due(ALICE, FOLDER);
  done = true;
  await copying;
  copy();
  const tidied = readFileSync(feedOf(ALICE, FOLDER));
  assert.ok(copies.every(x => x.bytes.equals(old) || x.bytes.equals(tidied)), 'each copy was the old feed or the new');
  assert.ok(copies.some(x => x.racing && x.bytes.equals(old)), 'some while the new feed was being written');
  assert.ok(copies.at(-1)!.bytes.equals(tidied));
  assert.equal(existsSync(f), false, 'the old feed is gone');
  const feed = lines(feedOf(ALICE, FOLDER));
  assert.deepEqual(feed.map(l => l.id).sort(), ['f1', 'f4', 'pub', 'top']);
  assert.equal(feed.find(l => l.id === 'f1').name, 'aging v2.xlsx');
});

test('a 429 waits as Retry-After says, at the same page', async () => {
  const link = cache(ALICE, FOLDER).parts[''].link;
  once.set(ALICE, 429);
  await due(ALICE, FOLDER);
  const p = cache(ALICE, FOLDER).parts[''];
  assert.equal(p.link, link);
  assert.match(p.error, /429/);
  assert.ok(Math.abs(p.due - (Date.now() + 120_000)) < 10_000);
  assert.deepEqual(now(run(ALICE, [FOLDER])('Folder LFM, Reports').lines), ['f1', 'f4', 'pub', 'top']);
});

test('an expired login pauses its cache until its person signs in again, then it goes on at the same page', async () => {
  const link = cache(ALICE, FOLDER).parts[''].link;
  offer(ALICE, [{ id: FOLDER, name: 'Folder LFM, Reports' }], '2026-11-04T00:00:00Z', 'expired');
  await due(ALICE, FOLDER);
  assert.equal(cache(ALICE, FOLDER).parts[''].due, null);
  assert.match(cache(ALICE, FOLDER).parts[''].error, /login/);
  assert.equal(run(ALICE, [FOLDER])('Folder LFM, Reports').lines.length, 4, 'a run gets what there is');
  const from = asked.length;
  offer(ALICE, [{ id: FOLDER, name: 'Folder LFM, Reports' }], '2026-11-04T01:00:00Z');
  await work(() => cache(ALICE, FOLDER).parts[''].error === null && settled(ALICE, FOLDER)());
  assert.equal(asked.slice(from).find(q => q.who === ALICE)!.url, link.slice(`${base}/v1.0`.length));
});

test('losing the source deletes the cache', async () => {
  const f = feedOf(ALICE, FOLDER);
  locked.add(ALICE);
  await due(ALICE, FOLDER);
  locked.delete(ALICE);
  assert.equal(existsSync(f), false);
  assert.equal(cache(ALICE, FOLDER).length, 0);
  assert.match(cache(ALICE, FOLDER).parts[''].error, /403/);
  const a = run(ALICE, [FOLDER])('Folder LFM, Reports');
  assert.deepEqual(a.lines, []);
  assert.equal(a.meta.as_of, null);
});

test("a mailbox: its folder list, then every folder's messages, 20 folders to a $batch, and what goes", async () => {
  offer(CAROL, [{ id: MAIL, name: `Mailbox ${BOX}` }]);
  const from = batches.length;
  await work(settled(CAROL, MAIL));
  const c = run(CAROL, [MAIL])(`Mailbox ${BOX}`);
  assert.deepEqual(now(c.lines), ['farc', 'fin', 'fsub', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.ok(batches.slice(from).includes(3), "the folder list's second page and two folders' first pages went in one $batch");
  assert.ok(asked.filter(q => q.who === CAROL && q.url.includes('/mailFolders/')).every(q => q.prefer?.includes('outlook.body-content-type="text"')));
  assert.equal(c.meta.deltaLinks.length, 4);
  put('mail', { id: 'm1', '@removed': { reason: 'deleted' } }, 'fin');
  put('mail', { id: 'fsub', '@removed': { reason: 'deleted' } }, '');
  await due(CAROL, MAIL);
  assert.deepEqual(now(lines(feedOf(CAROL, MAIL))), ['farc', 'fin', 'm2', 'm3', 'm5']);
  assert.equal(cache(CAROL, MAIL).parts.fsub, undefined);
  // A folder its person can no longer read goes, with its messages.
  state.mail.set('farc', { ...state.mail.get('farc'), '@removed': { reason: 'deleted' } });
  await due(CAROL, MAIL);
  assert.equal(cache(CAROL, MAIL).parts.farc, undefined);
  assert.deepEqual(lines(feedOf(CAROL, MAIL)).map(l => l.id).sort(), ['fin', 'm2', 'm3'], 'tidied');
});

test("a site: each library's root delta, and a library closed to its person goes, with what is under it", async () => {
  offer(CAROL, [{ id: MAIL, name: `Mailbox ${BOX}` }, { id: SITE, name: 'Site Reports' }]);
  await work(settled(CAROL, SITE));
  const big = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'bigroot', 'bigtop'];
  assert.deepEqual(now(run(CAROL, [SITE])('Site Reports').lines), [...big, 'droot', 'f1', 'f4', 'out', 'pub', 'top'].sort());
  assert.equal(cache(CAROL, SITE).parts['b!d'].link.split('?')[0], `${base}/v1.0/drives/b!d/root/delta`);
  closed.add(`${CAROL} b!big`);
  await due(CAROL, SITE);
  closed.delete(`${CAROL} b!big`);
  assert.equal(cache(CAROL, SITE).parts['b!big'], undefined);
  assert.ok(cache(CAROL, SITE).parts['b!d'].delta, 'the other library goes on');
  assert.deepEqual(lines(feedOf(CAROL, SITE)).map(l => l.id).sort(), ['droot', 'f1', 'f4', 'out', 'pub', 'top'], 'tidied');
});

test("a whole OneDrive: its person's own drive's root delta", async () => {
  offer(DAN, [{ id: BIG, name: 'Big' }, { id: ONEDRIVE, name: 'OneDrive' }]);
  await work(settled(DAN, ONEDRIVE));
  assert.deepEqual(now(run(DAN, [ONEDRIVE])('OneDrive').lines), ['o1', 'oroot']);
  assert.deepEqual(asked.filter(q => q.who === DAN && q.url.startsWith('/me/')).map(q => [q.url, q.prefer]), [['/me/drive/root/delta', 'deltashowremovedasdeleted']]);
});

test('rf indexes: each cache, its lines and bytes, and how it goes', () => {
  const site = ix.indexes().find(x => x.source === SITE && x.people[0].who === CAROL)!;
  assert.equal(site.kind, 'site');
  assert.equal(site.items, cache(CAROL, SITE).lines);
  assert.equal(site.bytes, cache(CAROL, SITE).length);
  assert.deepEqual(site.people.map(p => [p.who, p.phase]), [[CAROL, 'follow']]);
  assert.equal(ix.indexes().find(x => x.source === FOLDER && x.people[0].who === BOB)!.people[0].phase, 'crawl');
  assert.equal(ix.indexes().find(x => x.source === ONEDRIVE)!.kind, 'OneDrive');
});

test('removing an offer deletes its cache', async () => {
  const f = feedOf(CAROL, SITE);
  ix.forget(CAROL, SITE);
  await until(() => !existsSync(`${at(CAROL, SITE)}.json`));
  assert.equal(existsSync(f), false);
  assert.ok(existsSync(`${at(CAROL, MAIL)}.json`));
});
