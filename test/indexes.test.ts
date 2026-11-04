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
// under it; a bigger library for a crawl cut by a restart; and a shared mailbox. Each person's access token is their refresh token,
// which is their address. Delta pages hold three items, or two messages; a cursor's token says where it is.
const ALICE = 'alice@demo.test', BOB = 'bob@demo.test', CAROL = 'carol@demo.test', DAN = 'dan@demo.test', BOX = 'team@demo.test';
const FOLDER = 'm365:item:b!d/top', PUB = 'm365:item:b!d/pub', BIG = 'm365:item:b!big/bigtop', MAIL = `m365:mail:${BOX}`, SITE = 'm365:site:host,s1,w1';
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
      if (path === '/token') return send(200, { access_token: new URLSearchParams(body).get('refresh_token'), expires_in: 3600 });
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
  put('mail', { id: 'fin', displayName: 'Inbox', parentFolderId: 'mroot' }, '');
  put('mail', { id: 'fsub', displayName: 'Clients', parentFolderId: 'fin' }, '');
  put('mail', { id: 'farc', displayName: 'Archive', parentFolderId: 'mroot' }, '');
  for (const [id, f] of [['m1', 'fin'], ['m2', 'fin'], ['m3', 'fin'], ['m4', 'fsub'], ['m5', 'farc']]) put('mail', { id, subject: `Re: ${id}`, parentFolderId: f, body: { contentType: 'text', content: `about ${id}` } }, f);
});
after(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

const offer = (who: string, offers: { id: string; name: string }[], since = '2026-11-01T00:00:00Z') =>
  logins.saveLogin(who, { id: 'm365', kind: 'm365', name: 'Microsoft 365', account: who, since, offers }, who);
const at = (who: string, offerId: string) => join(logins.personDir(who), 'index', createHash('sha256').update(offerId).digest('hex').slice(0, 16));
const cache = (who: string, offerId: string) => JSON.parse(readFileSync(`${at(who, offerId)}.json`, 'utf8'));
const feed = (f: string) => (existsSync(f) ? zstdDecompressSync(readFileSync(f)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
// What a feed says now: a later line for an id replaces an earlier one, and a deleted or @removed one removes it.
const now = (lines: Item[]) => { const m = new Map<string, Item>(); for (const l of lines) l.deleted || l['@removed'] ? m.delete(l.id) : m.set(l.id, l); return [...m.keys()].sort(); };
const settle = () => new Promise(ok => setTimeout(ok, 50));

// A run of `who`'s with these offers ticked, and what it reads at $RF_INDEX.
async function run(who: string, ticked: string[]) {
  const to = join(tmp, '.rf', 'runs', `run-${Math.random()}`), inst = { seriesId: 'weekly', log: [{ seq: 1, at: '', by: who, op: 'create', logins: ticked }] } as unknown as Instance;
  assert.equal(await ix.prepare(inst, to), true);
  return (name: string) => ({ lines: feed(join(to, `${name}.ndjson.zst`)), meta: JSON.parse(readFileSync(join(to, `${name}.json`), 'utf8')), file: join(to, `${name}.ndjson.zst`) });
}

test('a crawl cut by a restart goes on at the page it was on, with nothing else in memory', async () => {
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
  assert.equal(feed(`${at(DAN, BIG)}.ndjson.zst`).length, 6, 'two pages were written');
  const from = asked.length, second = child();
  for (let i = 0; i < 100 && !cache(DAN, BIG).parts[''].delta; i++) await new Promise(ok => setTimeout(ok, 100));
  second.kill('SIGKILL');
  assert.match(asked.filter((a, i) => i >= from && a.who === DAN)[0].url, /token=c6\./, 'the restart asked for the third page first');
  assert.equal(feed(`${at(DAN, BIG)}.ndjson.zst`).length, 9);
});

test("each person's cache is their own delta feed, and a run gets a copy of it", async () => {
  offer(ALICE, [{ id: FOLDER, name: 'Folder LFM, Reports' }]);
  const a = (await run(ALICE, [FOLDER]))('Folder LFM, Reports');
  assert.deepEqual(a.lines.map(i => i.id), ['top', 'f1', 'sub', 'f2', 'pub', 'f3']);
  assert.deepEqual(a.lines[4], state['b!d'].get('pub'), "Graph's own JSON, verbatim");
  assert.deepEqual(a.meta, { source: FOLDER, as_of: cache(ALICE, FOLDER).parts[''].as_of, deltaLinks: [`${base}/v1.0/drives/b!d/items/top/delta?token=s${seq}`] });
  assert.notEqual(statSync(a.file).ino, statSync(`${at(ALICE, FOLDER)}.ndjson.zst`).ino, 'a copy, not the cache itself');
  assert.ok(asked.filter(q => q.who === ALICE).every(q => q.prefer === 'deltashowremovedasdeleted'));
  // Bob can't open the folder, so he has no cache of it; the folder shared with him he has, as his token sees it.
  offer(BOB, [{ id: FOLDER, name: 'Folder LFM, Reports' }, { id: PUB, name: 'Folder Shared with Bob, Reports' }]);
  const b = await run(BOB, [FOLDER, PUB]);
  assert.deepEqual(b('Folder LFM, Reports').lines, []);
  assert.equal(b('Folder LFM, Reports').meta.as_of, null);
  assert.match(cache(BOB, FOLDER).parts[''].error, /403/);
  assert.deepEqual(b('Folder Shared with Bob, Reports').lines.map(i => i.id), ['pub', 'f3']);
});

test('changes are appended, a later line winning, and a run starting catches up first', async () => {
  put('b!d', { ...state['b!d'].get('f1')!, name: 'aging v2.xlsx' });
  put('b!d', { id: 'f3', deleted: {} });
  const a = (await run(ALICE, [FOLDER]))('Folder LFM, Reports');
  assert.deepEqual(a.lines.slice(6), [state['b!d'].get('f1'), { id: 'f3', deleted: {} }]);
  assert.deepEqual(now(a.lines), ['f1', 'f2', 'pub', 'sub', 'top']);
});

test('a crash after a batch is appended but before its .json is replaced replays the batch and nothing else', async () => {
  const c = cache(ALICE, FOLDER), f = `${at(ALICE, FOLDER)}.ndjson.zst`;
  appendFileSync(f, zstdCompressSync(`${JSON.stringify({ id: 'f4', name: 'half-written.xlsx' })}\n`));
  put('b!d', file('b!d', 'f4', 'april.xlsx', 'top'));
  await run(ALICE, [FOLDER]);
  const lines = feed(f);
  assert.equal(lines.length, c.lines + 1);
  assert.deepEqual(lines.at(-1), state['b!d'].get('f4'));
  assert.equal(statSync(f).size, cache(ALICE, FOLDER).length);
});

test('a 410 crawls again, appending', async () => {
  const c = cache(ALICE, FOLDER);
  c.parts[''].link = `${base}/v1.0/drives/b!d/items/top/delta?token=gone`;
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
  const a = (await run(ALICE, [FOLDER]))('Folder LFM, Reports');
  assert.equal(a.lines.length, c.lines + 6);
  assert.deepEqual(now(a.lines), ['f1', 'f2', 'f4', 'pub', 'sub', 'top']);
  assert.ok(cache(ALICE, FOLDER).parts[''].delta);
});

test('the tidy-up rewrites a feed without what later lines replaced or removed, a deleted folder with everything under it', async () => {
  // As Graph's delta does, the folder's deletion comes alone.
  put('b!d', { id: 'sub', deleted: {} });
  state['b!d'].set('f2', { id: 'f2', deleted: {} });
  const c = cache(ALICE, FOLDER);
  c.parts[''].due = Date.now();
  writeFileSync(`${at(ALICE, FOLDER)}.json`, JSON.stringify(c));
  const worker = await import(`../src/indexes.ts?worker=${Date.now()}`);
  worker.startIndexing();
  for (let i = 0; i < 100 && !cache(ALICE, FOLDER).base; i++) await settle();
  await worker.stopIndexing();
  const lines = feed(`${at(ALICE, FOLDER)}.ndjson.zst`);
  assert.deepEqual(lines.map(l => l.id).sort(), ['f1', 'f4', 'pub', 'top']);
  assert.equal(lines.find(l => l.id === 'f1').name, 'aging v2.xlsx');
  assert.equal(cache(ALICE, FOLDER).lines, 4);
});

test('a 429 waits as Retry-After says, at the same page, and the run still gets its copy', async () => {
  const link = cache(ALICE, FOLDER).parts[''].link;
  once.set(ALICE, 429);
  const a = (await run(ALICE, [FOLDER]))('Folder LFM, Reports');
  assert.equal(a.lines.length, 4);
  const p = cache(ALICE, FOLDER).parts[''];
  assert.equal(p.link, link);
  assert.match(p.error, /429/);
  assert.ok(Math.abs(p.due - (Date.now() + 120_000)) < 10_000);
});

test('an expired login pauses its cache until its person signs in again, then it goes on at the same page', async () => {
  const l = logins.logins(ALICE).find(l => l.id === 'm365')!, link = cache(ALICE, FOLDER).parts[''].link;
  logins.saveLogin(ALICE, { ...l, since: '2026-11-04T00:00:00Z', expired: true });
  const a = (await run(ALICE, [FOLDER]))('Folder LFM, Reports');
  assert.equal(a.lines.length, 4, 'the run gets the copy there is');
  assert.equal(cache(ALICE, FOLDER).parts[''].due, null);
  assert.match(cache(ALICE, FOLDER).parts[''].error, /login/);
  logins.saveLogin(ALICE, { ...l, since: '2026-11-04T01:00:00Z', expired: false }, ALICE);
  await settle();
  assert.ok(cache(ALICE, FOLDER).parts[''].due <= Date.now());
  assert.equal(cache(ALICE, FOLDER).parts[''].link, link);
});

test('losing the source deletes the cache', async () => {
  locked.add(ALICE);
  const a = (await run(ALICE, [FOLDER]))('Folder LFM, Reports');
  locked.delete(ALICE);
  assert.deepEqual(a.lines, []);
  assert.equal(existsSync(`${at(ALICE, FOLDER)}.ndjson.zst`), false);
  assert.equal(cache(ALICE, FOLDER).length, 0);
  assert.match(cache(ALICE, FOLDER).parts[''].error, /403/);
});

test("a mailbox: its folder list, then every folder's messages, 20 folders to a $batch, and what goes", async () => {
  offer(CAROL, [{ id: MAIL, name: `Mailbox ${BOX}` }]);
  const from = batches.length, c = (await run(CAROL, [MAIL]))(`Mailbox ${BOX}`);
  assert.deepEqual(now(c.lines), ['farc', 'fin', 'fsub', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.ok(batches.slice(from).includes(3), "the folder list's second page and two folders' first pages went in one $batch");
  assert.ok(asked.filter(q => q.who === CAROL).every(q => q.prefer?.includes('outlook.body-content-type="text"')));
  assert.equal(c.meta.deltaLinks.length, 4);
  put('mail', { id: 'm1', '@removed': { reason: 'deleted' } }, 'fin');
  put('mail', { id: 'fsub', '@removed': { reason: 'deleted' } }, '');
  const again = (await run(CAROL, [MAIL]))(`Mailbox ${BOX}`);
  assert.deepEqual(now(again.lines), ['farc', 'fin', 'm2', 'm3', 'm4', 'm5'], "a removed folder's messages go at the tidy-up");
  assert.equal(cache(CAROL, MAIL).parts.fsub, undefined);
  // A folder its person can no longer read goes, with its messages, at the tidy-up.
  state.mail.set('farc', { ...state.mail.get('farc'), '@removed': { reason: 'deleted' } });
  const last = (await run(CAROL, [MAIL]))(`Mailbox ${BOX}`);
  assert.deepEqual(now(last.lines), ['fin', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(cache(CAROL, MAIL).parts.farc, undefined);
  const due = cache(CAROL, MAIL);
  due.parts[''].due = Date.now();
  writeFileSync(`${at(CAROL, MAIL)}.json`, JSON.stringify(due));
  const worker = await import(`../src/indexes.ts?mail=${Date.now()}`);
  worker.startIndexing();
  for (let i = 0; i < 100 && !cache(CAROL, MAIL).base; i++) await settle();
  await worker.stopIndexing();
  assert.deepEqual(feed(`${at(CAROL, MAIL)}.ndjson.zst`).map(l => l.id).sort(), ['fin', 'm2', 'm3']);
});

test("a site: each library's root delta, and a library closed to its person goes, with what is under it", async () => {
  offer(CAROL, [{ id: MAIL, name: `Mailbox ${BOX}` }, { id: SITE, name: 'Site Reports' }]);
  const c = (await run(CAROL, [SITE]))('Site Reports');
  const big = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'bigroot', 'bigtop'];
  assert.deepEqual(now(c.lines), [...big, 'droot', 'f1', 'f4', 'out', 'pub', 'top'].sort());
  assert.equal(cache(CAROL, SITE).parts['b!d'].link.split('?')[0], `${base}/v1.0/drives/b!d/root/delta`);
  closed.add(`${CAROL} b!big`);
  await run(CAROL, [SITE]);
  closed.delete(`${CAROL} b!big`);
  assert.equal(cache(CAROL, SITE).parts['b!big'], undefined);
  assert.ok(cache(CAROL, SITE).parts['b!d'].delta, 'the other library goes on');
  const due = cache(CAROL, SITE);
  due.parts['b!d'].due = Date.now();
  writeFileSync(`${at(CAROL, SITE)}.json`, JSON.stringify(due));
  const worker = await import(`../src/indexes.ts?site=${Date.now()}`);
  worker.startIndexing();
  for (let i = 0; i < 100 && !cache(CAROL, SITE).base; i++) await settle();
  await worker.stopIndexing();
  assert.deepEqual(feed(`${at(CAROL, SITE)}.ndjson.zst`).map(l => l.id).sort(), ['droot', 'f1', 'f4', 'out', 'pub', 'top']);
});

test('rf indexes: each cache, its lines and bytes, and how it goes', () => {
  const site = ix.indexes().find(x => x.source === SITE && x.people[0].who === CAROL)!;
  assert.equal(site.kind, 'site');
  assert.equal(site.items, 6);
  assert.equal(site.bytes, statSync(`${at(CAROL, SITE)}.ndjson.zst`).size);
  assert.deepEqual(site.people.map(p => [p.who, p.phase]), [[CAROL, 'follow']]);
  assert.equal(ix.indexes().find(x => x.source === FOLDER && x.people[0].who === BOB)!.people[0].phase, 'crawl');
});

test('removing an offer deletes its cache', async () => {
  ix.forget(CAROL, SITE);
  await settle();
  assert.equal(existsSync(`${at(CAROL, SITE)}.json`), false);
  assert.equal(existsSync(`${at(CAROL, SITE)}.ndjson.zst`), false);
  assert.ok(existsSync(`${at(CAROL, MAIL)}.json`));
});
