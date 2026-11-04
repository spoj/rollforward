import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import type { Instance } from './store.ts';
import { changes, rfDir } from './system.ts';
import { users } from './auth.ts';
import { token } from './entra.ts';
import { lender, logins, type Offer } from './logins.ts';
import { endpoints, scope } from './connections/graph.ts';

// Indexes of outside sources (README: Indexes). Each offer a Microsoft 365 login makes, but a file, is a source with one SQLite
// file, .rf/index/<sha256(offer)[:16]>.sqlite, holding the latest JSON of each item exactly as Graph's delta gave it, keyed by its
// id: the union of what each person's own token returned. Our only reading of an item is its permission root, which a person's
// copy is filtered by. Each person has their own cursor per part of a source, a page its unit: one transaction writes a page's items
// and moves the cursor, so a crash replays at most a page, which changes nothing, and a restart goes on where the cursors are.
const VERSION = 1, SLICE_MS = 5_000, RUN_MS = 15_000, REFRESH_MS = 60 * 60_000, DAY = 86_400_000, TRIES = 5;
const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE items (id TEXT PRIMARY KEY, parent TEXT, root TEXT, json TEXT NOT NULL);
  CREATE INDEX items_parent ON items (parent);
  CREATE INDEX items_root ON items (root);
  CREATE TABLE cursors (person TEXT, part TEXT, link TEXT NOT NULL, delta TEXT, as_of TEXT, pages INTEGER NOT NULL DEFAULT 0, due INTEGER, error TEXT,
    tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (person, part));
  CREATE TABLE access (person TEXT, root TEXT, ok INTEGER NOT NULL, checked INTEGER NOT NULL, PRIMARY KEY (person, root));
  PRAGMA user_version = ${VERSION};`;
// A folder's subtree goes with it: out when it is deleted, and to its new root when it moves or its sharing changes, as delta sends
// only the folder. An item that was a root stays one, which only narrows who sees what is under it.
const REMOVE = 'WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT i.id FROM items i JOIN d ON i.parent = d.id) DELETE FROM items WHERE id IN (SELECT id FROM d)';
const CASCADE = `WITH RECURSIVE d(id, root) AS (SELECT ?1, ?2 UNION
    SELECT i.id, CASE WHEN d.root IS NOT NULL AND (i.root = i.id OR i.json->'$.shared' IS NOT NULL) THEN i.id ELSE d.root END FROM items i JOIN d ON i.parent = d.id)
  UPDATE items SET root = d.root FROM d WHERE items.id = d.id AND items.root IS NOT d.root`;

type Cursor = { person: string; part: string; link: string; tries: number };

const dir = () => join(rfDir(), 'index');
const sources = () => (existsSync(dir()) ? readdirSync(dir()).filter(f => f.endsWith('.sqlite')).map(f => f.slice(0, -7)) : []);
const kind = (offer: string) => /^m365:(\w+):(.*)$/.exec(offer)!.slice(1) as [string, string];
const source = (db: DatabaseSync) => (db.prepare(`SELECT value FROM meta WHERE key = 'source'`).get() as { value: string }).value;
const m365 = (email: string) => logins(email).find(l => l.id === 'm365');
const indexed = (o: Offer) => /^m365:(item|site|mail):/.test(o.id) && !o.name.startsWith('File ');
// A person's source is indexed with their login while it offers the source and hasn't expired.
const offered = (person: string, offer: string) => !!m365(person)?.offers.some(o => o.id === offer) && !m365(person)!.expired;

// A file that fails its integrity check, or has another schema, moves aside for a fresh one.
const dbs = new Map<string, DatabaseSync>();
function open(id: string): DatabaseSync {
  if (dbs.has(id)) return dbs.get(id)!;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const file = join(dir(), `${id}.sqlite`);
  let db: DatabaseSync | undefined;
  if (existsSync(file)) {
    db = new DatabaseSync(file);
    let sound = false;
    try { sound = db.prepare('PRAGMA user_version').get()!.user_version === VERSION && db.prepare('PRAGMA integrity_check').get()!.integrity_check === 'ok'; } catch {}
    if (!sound) {
      db.close();
      db = undefined;
      for (const s of ['', '-wal', '-shm']) if (existsSync(file + s)) renameSync(file + s, `${file}.aside${s}`);
    }
  }
  if (!db) (db = new DatabaseSync(file)).exec(SCHEMA);
  db.exec('PRAGMA journal_mode = WAL');
  dbs.set(id, db);
  return db;
}

function write(db: DatabaseSync, f: () => void) {
  db.exec('BEGIN IMMEDIATE');
  try {
    f();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// One writer per file: everything that writes a source waits for what came before it.
const queues = new Map<string, Promise<unknown>>();
function queue<T>(id: string, f: () => Promise<T>): Promise<T> {
  const p = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(f);
  queues.set(id, p);
  return p;
}

// The server calls Graph itself, as the person, as logins.ts does, not through a run's proxy; most calls are a $batch of up to 20.
const G = () => `${endpoints.graph}/v1.0`;
async function call(email: string, path: string, requests?: object[]): Promise<any> {
  const r = await fetch(`${G()}${path}`, {
    method: requests ? 'POST' : 'GET', body: requests && JSON.stringify({ requests }),
    headers: { authorization: `Bearer ${await token(email, 'm365', scope())}`, ...(requests && { 'content-type': 'application/json' }) }, signal: AbortSignal.timeout(120_000),
  });
  if (r.ok) return r.json();
  throw Object.assign(new Error(`Microsoft Graph answered ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status, after: Number(r.headers.get('retry-after')) || 60 });
}

// Where a part of a source starts: a ticked folder's delta, the whole folder or library; each library of a site, its root's; a
// mailbox's folder list ('') and each folder's messages. A drive's may start where Graph is now, at token=latest; messages can't.
function start(offer: string, part: string, latest = false): string {
  const [k, id] = kind(offer), now = latest ? '?token=latest' : '';
  if (k === 'item') return `${G()}/drives/${id.replace('/', '/items/')}/delta${now}`;
  if (k === 'site') return `${G()}/drives/${part}/root/delta${now}`;
  return `${G()}/users/${encodeURIComponent(id)}/mailFolders/${part ? `${encodeURIComponent(part)}/messages/` : ''}delta`;
}
const prefer = (offer: string) => (offer.startsWith('m365:mail:') ? 'outlook.body-content-type="text", odata.maxpagesize=50' : 'hierarchicalsharing');

// A source's permission roots, each with the GET that tells whether a person's token opens it: a mailbox is one; in a drive, each
// item whose shared facet hierarchicalsharing shows, and the ticked folder or each library's root.
function roots(db: DatabaseSync, offer: string): { root: string; url: string }[] {
  const [k, id] = kind(offer);
  if (k === 'mail') return [{ root: id, url: `/users/${encodeURIComponent(id)}/mailFolders/msgfolderroot?$select=id` }];
  const rows = db.prepare(`SELECT id, json->>'$.parentReference.driveId' AS drive FROM items WHERE id IN (SELECT root FROM items)`).all() as { id: string; drive: string }[];
  if (k === 'item') rows.push({ id: id.split('/')[1], drive: id.split('/')[0] });
  return [...new Map(rows.map(r => [r.id, { root: r.id, url: `/drives/${r.drive}/items/${r.id}?$select=id` }])).values()];
}

// A page's items, in order, the last of an item winning: a deleted facet, or a message's or folder's @removed, removes it. An item's
// root is itself if it's the ticked folder or a library's root, or if it has a shared facet; its parent's otherwise, and none if
// that isn't known yet or is outside the folder, which keeps it out of every copy until a parent puts it in.
function apply(db: DatabaseSync, offer: string, person: string, part: string, value: any[]) {
  const [k, id] = kind(offer), top = k === 'item' ? id.split('/')[1] : undefined;
  const rootOf = db.prepare('SELECT root FROM items WHERE id = ?'), add = db.prepare('INSERT OR IGNORE INTO cursors (person, part, link, due) VALUES (?, ?, ?, ?)');
  const put = db.prepare('INSERT INTO items VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET parent = excluded.parent, root = excluded.root, json = excluded.json');
  for (const it of value) {
    if (it.deleted || it['@removed']) {
      db.prepare(REMOVE).run(it.id);
      continue;
    }
    const was = rootOf.get(it.id)?.root as string | null | undefined, parent = it.parentReference?.id ?? it.parentFolderId ?? null;
    let root: string | null = id;
    if (k !== 'mail') {
      const up = parent === top ? top : (rootOf.get(parent)?.root as string | null | undefined);
      root = it.id === top || (k === 'site' && it.root) ? it.id : up == null ? null : it.shared || was === it.id ? it.id : up;
    }
    put.run(it.id, parent, root, JSON.stringify(it));
    if (k === 'mail' && !part) add.run(person, it.id, start(offer, it.id), Date.now());
    if (k !== 'mail' && it.folder && (was ?? null) !== root) db.prepare(CASCADE).run(it.id, root);
  }
  if (k === 'mail') db.prepare(`DELETE FROM cursors WHERE part <> '' AND part NOT IN (SELECT id FROM items)`).run();
}

// A failure keeps the page: throttling waits as Graph asks, an expired login waits for its person to sign in again, an expired
// delta token (410) crawls again with the rows kept, and a ticked folder whose delta Graph refuses follows its drive's instead.
// Anything else backs off, 1, 2, 4 and 8 minutes, then is failed.
function failed(db: DatabaseSync, offer: string, c: Cursor, e: any) {
  const set = (cols: string, ...values: (string | number | null)[]) => db.prepare(`UPDATE cursors SET ${cols}, error = ? WHERE person = ? AND part = ?`).run(...values, e.message, c.person, c.part);
  if (e.login) set('due = NULL');
  else if (e.status === 429 || e.status === 503) set('due = ?', Date.now() + e.after * 1000);
  else if (e.status === 410) set('link = ?, delta = NULL, as_of = NULL, pages = 0, due = ?', start(offer, c.part), Date.now());
  else if (e.status < 500 && /\/items\/[^/]+\/delta(\?token=latest)?$/.test(c.link)) set('link = ?, due = ?', c.link.replace(/\/items\/[^/]+\/delta/, '/root/delta'), Date.now());
  else set('tries = tries + 1, due = ?', c.tries + 1 < TRIES ? Date.now() + 60_000 * 2 ** c.tries : null);
}

// A person's due cursors in a source, 20 to a $batch, a page each, until none is due or `until` passes: a cursor is due again at
// once while its round has a next page, and an hour after it reaches its deltaLink.
async function slice(id: string, person: string, until: number): Promise<void> {
  const db = open(id), offer = source(db);
  for (;;) {
    const cs = db.prepare('SELECT * FROM cursors WHERE person = ? AND due <= ? ORDER BY due LIMIT 20').all(person, Date.now()) as Cursor[];
    if (!cs.length) return;
    let answers: { id: string; status: number; headers?: Record<string, string>; body: any }[];
    try {
      answers = (await call(person, '/$batch', cs.map((c, k) => ({ id: String(k), method: 'GET', url: c.link.slice(G().length), headers: { prefer: prefer(offer) } })))).responses;
    } catch (e) {
      for (const c of cs) failed(db, offer, c, e);
      return;
    }
    for (const a of answers) {
      const c = cs[Number(a.id)], next = a.body?.['@odata.nextLink'], end = a.body?.['@odata.deltaLink'];
      try {
        if (a.status !== 200) throw Object.assign(new Error(`Microsoft Graph answered ${a.status}: ${JSON.stringify(a.body).slice(0, 300)}`), { status: a.status, after: Number(a.headers?.['Retry-After']) || 60 });
        write(db, () => {
          apply(db, offer, person, c.part, a.body.value);
          db.prepare('UPDATE cursors SET link = ?, delta = coalesce(?, delta), as_of = coalesce(?, as_of), pages = pages + 1, due = ?, error = NULL, tries = 0 WHERE person = ? AND part = ?')
            .run(next ?? end, end ?? null, end ? new Date().toISOString() : null, next ? Date.now() : Date.now() + REFRESH_MS, person, c.part);
        });
      } catch (e) {
        failed(db, offer, c, e);
      }
    }
    if (Date.now() > until) return;
  }
}

// Which roots a person's token opens, for those not asked since `since`.
async function check(db: DatabaseSync, offer: string, person: string, since: number) {
  const asked = db.prepare('SELECT checked FROM access WHERE person = ? AND root = ?');
  const todo = roots(db, offer).filter(r => !(((asked.get(person, r.root)?.checked as number | undefined) ?? 0) > since));
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20), r = await call(person, '/$batch', batch.map((b, k) => ({ id: String(k), method: 'GET', url: b.url })));
    write(db, () => {
      for (const a of r.responses) if ([200, 403, 404].includes(a.status)) db.prepare('INSERT OR REPLACE INTO access VALUES (?, ?, ?, ?)').run(person, batch[Number(a.id)].root, Number(a.status === 200), Date.now());
    });
  }
}

// A person's first use of a source: if the roots their token opens are those of someone who finished a crawl and still indexes it,
// their cursors start where Graph is now, as the rows hold what they may see already; otherwise they crawl. A site's libraries are
// listed again each time, for new ones.
async function begin(id: string, o: Offer, person: string) {
  const db = open(id), [k, sourceId] = kind(o.id), add = db.prepare('INSERT OR IGNORE INTO cursors (person, part, link, due) VALUES (?, ?, ?, ?)');
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?), (?, ?)').run('source', o.id, 'name', o.name);
  if (!db.prepare('SELECT 1 FROM cursors WHERE person = ?').get(person)) {
    await check(db, o.id, person, Date.now() - DAY);
    const opens = (p: string) => (db.prepare('SELECT group_concat(root) AS r FROM (SELECT root FROM access WHERE person = ? AND ok ORDER BY root)').get(p) as { r: string | null }).r;
    const done = k === 'mail' ? [] : (db.prepare('SELECT person FROM cursors WHERE person <> ? GROUP BY person HAVING count(delta) = count(*)').all(person) as { person: string }[]);
    const peer = done.find(p => offered(p.person, o.id) && opens(p.person) === opens(person))?.person;
    const parts = peer ? (db.prepare('SELECT part FROM cursors WHERE person = ?').all(peer) as { part: string }[]).map(c => c.part) : k === 'site' ? [] : [''];
    write(db, () => { for (const part of parts) add.run(person, part, start(o.id, part, !!peer), Date.now()); });
  }
  if (k === 'site') for (const d of (await call(person, `/sites/${sourceId}/drives?$select=id`)).value) add.run(person, d.id, start(o.id, d.id), Date.now());
}

// A person's sources that have no cursor of theirs start, in the background: when they add an offer, sign in, or the server starts.
export function track(email: string) {
  const l = m365(email);
  for (const o of l && !l.expired ? l.offers.filter(indexed) : []) {
    const id = createHash('sha256').update(o.id).digest('hex').slice(0, 16);
    if (!open(id).prepare('SELECT 1 FROM cursors WHERE person = ?').get(email)) queue(id, () => begin(id, o, email)).then(() => poke(), e => console.error(`index of ${o.id} for ${email}: no start`, e));
  }
}

// Before a run starts, for each source its runner ticked: up to about 15 s catching up with their cursors, as the latest items
// matter most, their access to roots unchecked for a day, then a copy in `to` of the items under the roots they open, as Graph gave
// them, one per line, zstd-compressed, in <name>.ndjson.zst, and <name>.json: the source, their own deltaLinks, to follow for what
// changed since, and as_of, when the oldest of them was reached, or null while their crawl goes on. On any failure the run still
// gets the best copy there is.
export async function prepare(inst: Instance, to: string): Promise<boolean> {
  let by: string, ticked: string[];
  try {
    ({ by, logins: ticked } = lender(inst));
  } catch {
    return false;
  }
  const offers = (m365(by)?.offers ?? []).filter(o => ticked.includes(o.id) && indexed(o)), names = new Set<string>();
  if (!offers.length) return false;
  mkdirSync(to, { recursive: true });
  await Promise.all(offers.map(async o => {
    const id = createHash('sha256').update(o.id).digest('hex').slice(0, 16), base = o.name.replace(/[/\0]/g, '-');
    let name = base;
    for (let k = 2; names.has(name); k++) name = `${base} ${k}`;
    names.add(name);
    try {
      const db = open(id);
      await queue(id, async () => {
        await begin(id, o, by);
        db.prepare('UPDATE cursors SET due = ? WHERE person = ?').run(Date.now(), by);
        await slice(id, by, Date.now() + RUN_MS);
        await check(db, o.id, by, Date.now() - DAY);
      }).catch(e => console.error(`index of ${o.id} for ${by}: no refresh`, e));
      // 1,000 rows at a time, each read on the server's one thread: a big mailbox's are 15 MB, about 100 ms.
      const rows = db.prepare('SELECT rowid, json FROM items WHERE rowid > ? AND root IN (SELECT root FROM access WHERE person = ? AND ok) ORDER BY rowid LIMIT 1000');
      await pipeline(async function* () {
        for (let last = 0, page: { rowid: number; json: string }[]; (page = rows.all(last, by) as typeof page).length; last = page.at(-1)!.rowid) yield page.map(r => `${r.json}\n`).join('');
      }, createZstdCompress(), createWriteStream(join(to, `${name}.ndjson.zst`)));
      const mine = db.prepare('SELECT delta, as_of FROM cursors WHERE person = ?').all(by) as { delta: string | null; as_of: string | null }[];
      const asOf = mine.length && mine.every(c => c.as_of) ? mine.map(c => c.as_of!).sort()[0] : null;
      writeFileSync(join(to, `${name}.json`), JSON.stringify({ source: o.id, as_of: asOf, deltaLinks: mine.flatMap(c => c.delta ?? []) }, null, 1));
    } catch (e) {
      console.error(`index of ${o.id} for ${by}: no copy`, e);
    }
  }));
  return true;
}

// In the background, the person most overdue across sources gets a slice, again and again: each crawl goes on to its end, and each
// source is caught up hourly while its person's login offers it. Nothing is kept in memory, so a restart goes on from the cursors,
// and a drain waits for at most one slice.
let stopping = false, worker: Promise<void> | undefined, poke = () => {};
const rest = (ms: number) => new Promise<void>(ok => { poke = ok; setTimeout(ok, Math.max(0, Math.min(ms, 60_000))).unref(); });
export function startIndexing() {
  for (const email of Object.keys(users())) track(email);
  worker = (async () => {
    while (!stopping) {
      const next = sources().flatMap(id => {
        const db = open(id), c = (db.prepare('SELECT person, min(due) AS due FROM cursors WHERE due IS NOT NULL GROUP BY person ORDER BY 2').all() as { person: string; due: number }[]).find(c => offered(c.person, source(db)));
        return c ? [{ id, ...c }] : [];
      }).sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > Date.now()) await rest((next?.due ?? Infinity) - Date.now());
      else await queue(next.id, () => slice(next.id, next.person, Date.now() + SLICE_MS)).catch(e => (console.error('indexing', e), rest(60_000)));
    }
  })();
}
export function stopIndexing(): Promise<void> {
  stopping = true;
  poke();
  return worker ?? Promise.resolve();
}

// Signing in to Microsoft 365 again resumes a person's paused or failed cursors, at the page where they stopped.
changes.on('login', (email: string, id: string) => {
  if (id !== 'm365') return;
  for (const s of sources()) open(s).prepare('UPDATE cursors SET due = ?, tries = 0 WHERE person = ? AND due IS NULL').run(Date.now(), email);
  track(email);
  poke();
});

// Each index, for rf indexes and rf status: its source, how many items and bytes it holds, and how each person's indexing goes,
// in crawl until each of their cursors first reached its deltaLink and in follow after, caught up when the oldest of them last did.
export function indexes() {
  return sources().flatMap(id => {
    const db = open(id), meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
    if (!meta.source) return [];
    const people = db.prepare(`SELECT person AS who, CASE WHEN count(delta) = count(*) THEN 'follow' ELSE 'crawl' END AS phase, sum(pages) AS pages,
      CASE WHEN count(as_of) = count(*) THEN min(as_of) END AS caught_up, max(error) AS error, min(CASE WHEN error IS NOT NULL THEN due END) AS retry FROM cursors GROUP BY person`).all() as { who: string; phase: string; pages: number; caught_up: string | null; error: string | null; retry: number | null }[];
    return [{
      name: meta.name, source: meta.source, kind: ({ item: 'folder', site: 'site', mail: 'mailbox' } as Record<string, string>)[kind(meta.source)[0]],
      items: (db.prepare('SELECT count(*) AS n FROM items').get() as { n: number }).n, bytes: statSync(join(dir(), `${id}.sqlite`)).size,
      people: people.map(({ retry, ...p }) => ({ ...p, retry_at: retry && new Date(retry).toISOString() })),
    }];
  });
}
