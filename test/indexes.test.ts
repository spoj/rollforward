import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import type { Instance } from '../src/store.ts';

// A stand-in for Microsoft's sign-in and Graph: a library whose ticked folder has a subfolder shared with Bob, who sees only what is
// under it; a bigger library for a crawl cut by a restart; and a shared mailbox. Each person's access token is their refresh token,
// which is their address. Delta pages hold three items, or two messages; a cursor's token says where it is.
const ALICE = 'alice@demo.test', BOB = 'bob@demo.test', CAROL = 'carol@demo.test', DAN = 'dan@demo.test', BOX = 'team@demo.test';
const FOLDER = 'm365:item:b!d/top', BIG = 'm365:item:b!big/bigtop', MAIL = `m365:mail:${BOX}`, SITE = 'm365:site:host,s1,w1';
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
const sees = (who: string, d: string, id: string) => who !== BOB || under(d, id, 'pub');

// What each person asked: each request inside a $batch, with its Prefer, and each $batch's size. `hold` keeps a page unanswered,
// for a crawl to be cut; `once` answers a person's next delta request with a status or a poisoned page instead.
const asked: { who: string; url: string; prefer?: string }[] = [], batches: number[] = [];
let hold: { token: string; reached: () => void } | undefined;
const once = new Map<string, number | 'poison'>();

function delta(who: string, d: string, scope: string | undefined, token: string | null): { status: number; headers?: Record<string, string>; body: any } {
  const link = (t: string) => `${base}/v1.0/drives/${d}/${scope ? `items/${scope}` : 'root'}/delta?token=${t}`, trick = once.get(who);
  if (token === 'gone') return { status: 410, body: { error: { code: 'resyncRequired' } } };
  if (scope && !sees(who, d, scope)) return { status: 403, body: { error: { code: 'accessDenied' } } };
  if (typeof trick === 'number') return once.delete(who), { status: trick, headers: { 'Retry-After': '120' }, body: { error: { code: 'activityLimitReached' } } };
  const inScope = (id: string) => !scope || under(d, id, scope);
  if (token === 'latest') return { status: 200, body: { value: [], '@odata.deltaLink': link(`s${seq}`) } };
  if (token?.startsWith('s')) {
    const ids = [...new Set(changed.filter(c => c.at === d && c.seq > Number(token.slice(1))).map(c => c.id))];
    const value: any[] = ids.map(id => state[d].get(id)!).filter(it => it.deleted || (inScope(it.id) && sees(who, d, it.id)));
    if (trick === 'poison') once.delete(who), value.push(null);
    return { status: 200, body: { value, '@odata.deltaLink': link(`s${seq}`) } };
  }
  const [at, from] = token ? token.slice(1).split('.').map(Number) : [0, seq];
  const all = [...state[d].values()].filter(it => !it.deleted && inScope(it.id) && sees(who, d, it.id)), page = all.slice(at, at + 3);
  return { status: 200, body: { value: page, ...(at + 3 < all.length ? { '@odata.nextLink': link(`c${at + 3}.${from}`) } : { '@odata.deltaLink': link(`s${from}`) }) } };
}

// The shared mailbox: its folders, then each folder's messages; Carol isn't a member.
function mail(who: string, fid: string | undefined, token: string | null): { status: number; body: any } {
  if (who === CAROL) return { status: 403, body: { error: { code: 'ErrorAccessDenied' } } };
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
  if ((m = /^\/drives\/([^/]+)\/items\/([^/]+)$/.exec(path))) return !state[m[1]]?.has(m[2]) ? { status: 404, body: {} } : sees(who, m[1], m[2]) ? { status: 200, body: { id: m[2] } } : { status: 403, body: {} };
  if ((m = /^\/users\/[^/]+\/mailFolders\/(?:([^/]+)\/messages\/)?delta$/.exec(path))) return mail(who, m[1], token);
  if (/^\/users\/[^/]+\/mailFolders\/msgfolderroot$/.test(path)) return who === CAROL ? { status: 403, body: {} } : { status: 200, body: { id: 'root' } };
  if (path === '/sites/host,s1,w1/drives') return { status: 200, body: { value: [{ id: 'b!d' }] } };
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
        const r = new URLSearchParams(body).get('refresh_token')!;
        return r === 'expired' ? send(400, { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }) : send(200, { access_token: r, refresh_token: r, expires_in: 3600 });
      }
      if (path === '/v1.0/$batch') {
        const requests = JSON.parse(body).requests as { id: string; url: string; headers?: { prefer?: string } }[];
        batches.push(requests.length);
        const responses = requests.map(r => ({ id: r.id, ...answer(who, r.url, r.headers?.prefer) }));
        const held = hold && requests.find(r => r.url.includes(`token=${hold!.token}`));
        if (held) return hold!.reached();
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
const source = (offerId: string) => new DatabaseSync(join(tmp, '.rf', 'index', `${createHash('sha256').update(offerId).digest('hex').slice(0, 16)}.sqlite`));
const cursor = (offerId: string, who: string, part = '') => source(offerId).prepare('SELECT * FROM cursors WHERE person = ? AND part = ?').get(who, part) as any;
const ids = (offerId: string) => (source(offerId).prepare('SELECT id FROM items ORDER BY id').all() as { id: string }[]).map(r => r.id);

// A run of `who`'s with these offers ticked, and what it reads at $RF_INDEX.
async function run(who: string, ticked: string[]) {
  const to = mkdtempSync(join(tmp, 'run-')), inst = { seriesId: 'weekly', log: [{ seq: 1, at: '', by: who, op: 'create', logins: ticked }] } as unknown as Instance;
  assert.equal(await ix.prepare(inst, to), true);
  const read = (name: string) => ({
    items: zstdDecompressSync(readFileSync(join(to, `${name}.ndjson.zst`))).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    meta: JSON.parse(readFileSync(join(to, `${name}.json`), 'utf8')),
  });
  return { to, read };
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
  assert.match(cursor(BIG, DAN).link, /token=c6\./, 'the cursor is at the third page');
  assert.equal(ids(BIG).length, 6, 'two pages were written');
  const from = asked.length, second = child();
  for (let i = 0; i < 100 && !cursor(BIG, DAN).delta; i++) await new Promise(ok => setTimeout(ok, 100));
  second.kill('SIGKILL');
  const again = asked.filter((a, i) => i >= from && a.who === DAN && a.url.includes('/delta'));
  assert.match(again[0].url, /token=c6\./, 'the restart asked for the third page first');
  assert.equal(ids(BIG).length, 9);
  assert.ok(cursor(BIG, DAN).as_of);
});

test("each person's copy holds only what is under the roots their own token opens", async () => {
  offer(ALICE, [{ id: FOLDER, name: 'Folder LFM, Reports' }]);
  offer(BOB, [{ id: FOLDER, name: 'Folder LFM, Reports' }]);
  const a = (await run(ALICE, [FOLDER])).read('Folder LFM, Reports');
  assert.deepEqual(a.items.map(i => i.id).sort(), ['f1', 'f2', 'f3', 'pub', 'sub', 'top']);
  assert.deepEqual(a.items.find(i => i.id === 'pub'), state['b!d'].get('pub'), "Graph's own JSON, verbatim");
  assert.equal(a.meta.source, FOLDER);
  assert.ok(a.meta.as_of);
  assert.deepEqual(a.meta.deltaLinks, [`${base}/v1.0/drives/b!d/items/top/delta?token=s${seq}`]);
  assert.ok(asked.filter(q => q.who === ALICE && q.url.includes('/delta')).every(q => q.prefer === 'hierarchicalsharing'));
  // Bob can't open the folder, so its delta refuses him: he follows the drive's, and sees only what's under the folder shared with him.
  const b = (await run(BOB, [FOLDER])).read('Folder LFM, Reports');
  assert.deepEqual(b.items.map(i => i.id).sort(), ['f3', 'pub']);
  assert.match(cursor(FOLDER, BOB).link, /\/drives\/b!d\/root\/delta\?token=s/);
  assert.deepEqual(ids(FOLDER), ['f1', 'f2', 'f3', 'pub', 'sub', 'top'], 'the union, nothing outside the folder kept in a copy');
});

test('someone whose roots match a finished crawl starts at token=latest', async () => {
  offer(CAROL, [{ id: FOLDER, name: 'Folder LFM, Reports' }]);
  const c = (await run(CAROL, [FOLDER])).read('Folder LFM, Reports');
  assert.deepEqual(c.items.map(i => i.id).sort(), ['f1', 'f2', 'f3', 'pub', 'sub', 'top']);
  assert.deepEqual(asked.filter(q => q.who === CAROL && q.url.includes('/delta')).map(q => new URL(q.url, base).search), ['?token=latest']);
});

test('changes follow: an edit, a deletion, and a folder moved under a shared one, whose subtree goes with it', async () => {
  put('b!d', { ...state['b!d'].get('f1')!, name: 'aging v2.xlsx' });
  put('b!d', { id: 'f3', deleted: {} });
  put('b!d', { ...state['b!d'].get('sub')!, parentReference: { driveId: 'b!d', id: 'pub' } });
  const a = (await run(ALICE, [FOLDER])).read('Folder LFM, Reports');
  assert.equal(a.items.find(i => i.id === 'f1').name, 'aging v2.xlsx');
  assert.ok(!a.items.some(i => i.id === 'f3'));
  // Alice's delta sent the moved folder alone; march.xlsx under it is now under the shared folder, for Bob too.
  assert.equal((source(FOLDER).prepare(`SELECT root FROM items WHERE id = 'f2'`).get() as { root: string }).root, 'pub');
  const b = (await run(BOB, [FOLDER])).read('Folder LFM, Reports');
  assert.deepEqual(b.items.map(i => i.id).sort(), ['f2', 'pub', 'sub']);
});

test('a page that breaks midway leaves nothing and moves no cursor, and a replayed page changes nothing', async () => {
  put('b!d', file('b!d', 'f4', 'april.xlsx', 'top'));
  const link = cursor(FOLDER, ALICE).link;
  once.set(ALICE, 'poison');
  await run(ALICE, [FOLDER]);
  assert.ok(!ids(FOLDER).includes('f4'), "the page's first item was rolled back");
  assert.equal(cursor(FOLDER, ALICE).link, link);
  assert.equal(cursor(FOLDER, ALICE).tries, 1);
  assert.ok(cursor(FOLDER, ALICE).error);
  await run(ALICE, [FOLDER]);
  assert.ok(ids(FOLDER).includes('f4'));
  assert.equal(cursor(FOLDER, ALICE).error, null);
  const rows = () => JSON.stringify(source(FOLDER).prepare('SELECT * FROM items ORDER BY id').all());
  const was = rows();
  source(FOLDER).prepare(`UPDATE cursors SET link = ? WHERE person = ?`).run(`${base}/v1.0/drives/b!d/items/top/delta?token=s0`, ALICE);
  await run(ALICE, [FOLDER]);
  assert.equal(rows(), was);
});

test('a 410 crawls again with the rows kept', async () => {
  source(FOLDER).prepare('UPDATE cursors SET link = ? WHERE person = ?').run(`${base}/v1.0/drives/b!d/items/top/delta?token=gone`, ALICE);
  const from = asked.length, a = (await run(ALICE, [FOLDER])).read('Folder LFM, Reports');
  assert.deepEqual(asked.slice(from).filter(q => q.who === ALICE && q.url.includes('/delta')).map(q => new URL(q.url, base).search).slice(0, 2), ['?token=gone', '']);
  assert.equal(a.items.length, 6);
  assert.ok(cursor(FOLDER, ALICE).delta);
});

test('a 429 waits as Retry-After says, at the same page, and the run still gets its copy', async () => {
  const link = cursor(FOLDER, ALICE).link;
  once.set(ALICE, 429);
  const a = (await run(ALICE, [FOLDER])).read('Folder LFM, Reports');
  assert.equal(a.items.length, 6);
  const c = cursor(FOLDER, ALICE);
  assert.equal(c.link, link);
  assert.match(c.error, /429/);
  assert.ok(Math.abs(c.due - (Date.now() + 120_000)) < 10_000);
});

test('an expired login pauses its cursors until its person signs in again, then they go on at the same page', async () => {
  const l = logins.logins(ALICE).find(l => l.id === 'm365')!, link = cursor(FOLDER, ALICE).link;
  logins.saveLogin(ALICE, { ...l, since: '2026-11-04T00:00:00Z', expired: true });
  const a = (await run(ALICE, [FOLDER])).read('Folder LFM, Reports');
  assert.equal(a.items.length, 6, 'the run gets the copy there is');
  assert.equal(cursor(FOLDER, ALICE).due, null);
  assert.match(cursor(FOLDER, ALICE).error, /login/);
  logins.saveLogin(ALICE, { ...l, since: '2026-11-04T01:00:00Z', expired: false }, ALICE);
  assert.ok(cursor(FOLDER, ALICE).due <= Date.now());
  assert.equal(cursor(FOLDER, ALICE).link, link);
});

test("a mailbox: its folder list, then every folder's messages, 20 folders to a $batch, and removals", async () => {
  offer(ALICE, [{ id: FOLDER, name: 'Folder LFM, Reports' }, { id: MAIL, name: `Mailbox ${BOX}` }]);
  const from = batches.length, a = (await run(ALICE, [MAIL])).read(`Mailbox ${BOX}`);
  assert.deepEqual(a.items.map(i => i.id).sort(), ['farc', 'fin', 'fsub', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.ok(batches.slice(from).includes(3), "the folder list's second page and two folders' first pages went in one $batch");
  assert.ok(asked.filter(q => q.who === ALICE && q.url.includes('/messages/delta')).every(q => q.prefer?.includes('outlook.body-content-type="text"')));
  assert.equal(a.meta.deltaLinks.length, 4);
  put('mail', { id: 'm1', '@removed': { reason: 'deleted' } }, 'fin');
  put('mail', { id: 'farc', '@removed': { reason: 'deleted' } }, '');
  const again = (await run(ALICE, [MAIL])).read(`Mailbox ${BOX}`);
  assert.deepEqual(again.items.map(i => i.id).sort(), ['fin', 'fsub', 'm2', 'm3', 'm4']);
  assert.equal(cursor(MAIL, ALICE, 'farc'), undefined);
  // Messages have no token=latest, so another member crawls it too.
  offer(BOB, [{ id: FOLDER, name: 'Folder LFM, Reports' }, { id: MAIL, name: `Mailbox ${BOX}` }]);
  const b = (await run(BOB, [MAIL])).read(`Mailbox ${BOX}`);
  assert.equal(b.items.length, 5);
  assert.ok(!asked.some(q => q.who === BOB && q.url.includes('latest')));
});

test("a site: each library's root delta, its root the library's", async () => {
  offer(CAROL, [{ id: FOLDER, name: 'Folder LFM, Reports' }, { id: SITE, name: 'Site Reports' }]);
  const c = (await run(CAROL, [SITE])).read('Site Reports');
  assert.deepEqual(c.items.map(i => i.id).sort(), ['droot', 'f1', 'f2', 'f4', 'out', 'pub', 'sub', 'top']);
  assert.equal(cursor(SITE, CAROL, 'b!d').link.split('?')[0], `${base}/v1.0/drives/b!d/root/delta`);
});

test('rf indexes: each source, its items and size, and how each person goes', () => {
  const folderIx = ix.indexes().find(x => x.source === FOLDER)!;
  assert.equal(folderIx.kind, 'folder');
  assert.equal(folderIx.items, 6);
  assert.ok(folderIx.bytes > 0);
  assert.deepEqual(folderIx.people.map(p => [p.who, p.phase]).sort(), [[ALICE, 'follow'], [BOB, 'follow'], [CAROL, 'follow']]);
  assert.ok(folderIx.people.find(p => p.who === BOB)!.pages >= 1);
});

test("a file that fails its integrity check moves aside for a fresh one, whose people's sources start again", async () => {
  const f = join(tmp, '.rf', 'index', `${createHash('sha256').update(BIG).digest('hex').slice(0, 16)}.sqlite`);
  for (const s of ['-wal', '-shm']) rmSync(f + s, { force: true });
  writeFileSync(f, 'not a database');
  const fresh = await import(`../src/indexes.ts?fresh=${Date.now()}`);
  fresh.track(DAN);
  assert.ok(existsSync(`${f}.aside`));
  for (let i = 0; i < 100 && !cursor(BIG, DAN); i++) await new Promise(ok => setTimeout(ok, 50));
  assert.ok(cursor(BIG, DAN), 'its person starts again');
  assert.equal(ids(BIG).length, 0);
});
