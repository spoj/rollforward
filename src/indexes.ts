import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createZstdCompress, createZstdDecompress, zstdCompress } from 'node:zlib';
import type { Instance } from './store.ts';
import { changes, rfDir } from './system.ts';
import { users } from './auth.ts';
import { token } from './entra.ts';
import { lender, logins, personDir, type Offer } from './logins.ts';
import { endpoints, scope } from './connections/graph.ts';

// Indexes of outside sources (README: Indexes). A person's Microsoft 365 login keeps a cache of each offer it makes, but a file: the
// delta feed Graph gave their own token, its crawl then its changes, Graph's own JSON, one item per line, in
// .rf/people/<p>/index/<sha256(offer)[:16]>.<gen>.ndjson.zst, a zstd frame per batch of pages. A later line for an id replaces an
// earlier one, and a deleted facet or an @removed removes it. The .json beside it, <sha256(offer)[:16]>.json, holds the cursors, one
// per part of the source, and which feed is the cache and how much of it they account for. A batch is appended and synced first,
// and only then is the .json replaced; each write starts by cutting the feed back to that length, so a crash in between replays the
// batch and nothing else. What the .json accounts for never changes under a feed's name: a tidy-up, or a source lost, starts a new
// one, so a run copies a cache as it is, without waiting.
const SLICE_MS = 5_000, REFRESH_MS = 60 * 60_000, TRIES = 5;

type Part = { link: string; delta: string | null; as_of: string | null; pages: number; due: number | null; error: string | null; tries: number };
type Cache = { person: string; source: string; name: string; gen: number; length: number; lines: number; base: number; parts: Record<string, Part> };

const kind = (offer: string) => /^m365:(\w+):(.*)$/.exec(offer)!.slice(1) as [string, string];
const m365 = (email: string) => logins(email).find(l => l.id === 'm365');
const indexed = (o: Offer) => /^m365:(item|site|mail):/.test(o.id) && !o.name.startsWith('File ');
// A cache is kept up while its person's login offers its source and hasn't expired.
const offered = (person: string, offer: string) => !!m365(person)?.offers.some(o => o.id === offer) && !m365(person)!.expired;
const at = (person: string, offer: string) => join(personDir(person), 'index', createHash('sha256').update(offer).digest('hex').slice(0, 16));
const feed = (c: Cache) => `${at(c.person, c.source)}.${c.gen}.ndjson.zst`;
const load = (person: string, offer: string): Cache | undefined => (existsSync(`${at(person, offer)}.json`) ? JSON.parse(readFileSync(`${at(person, offer)}.json`, 'utf8')) : undefined);
function save(c: Cache) {
  const f = `${at(c.person, c.source)}.json`;
  writeFileSync(`${f}.tmp`, JSON.stringify(c));
  renameSync(`${f}.tmp`, f);
}
function caches(): Cache[] {
  const people = join(rfDir(), 'people');
  return (existsSync(people) ? readdirSync(people) : []).flatMap(p => {
    const d = join(people, p, 'index');
    return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(d, f), 'utf8')) as Cache) : [];
  });
}

// One writer per cache: its writes, its tidy-up and a run's copy of it wait for what came before.
const queues = new Map<string, Promise<unknown>>();
function queue<T>(key: string, f: () => Promise<T>): Promise<T> {
  const p = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(f);
  queues.set(key, p);
  return p;
}

// The server calls Graph itself, as the person, as logins.ts does, not through a run's proxy; a list of requests goes as a $batch.
// Stopping indexing drops the request in flight.
const G = () => `${endpoints.graph}/v1.0`;
let halt = new AbortController();
async function call(email: string, path: string, requests?: object[]): Promise<any> {
  const r = await fetch(`${G()}${path}`, {
    method: requests ? 'POST' : 'GET', body: requests && JSON.stringify({ requests }),
    headers: { authorization: `Bearer ${await token(email, 'm365', scope())}`, ...(requests && { 'content-type': 'application/json' }) },
    signal: AbortSignal.any([halt.signal, AbortSignal.timeout(120_000)]),
  });
  if (r.ok) return r.json();
  throw Object.assign(new Error(`Microsoft Graph answered ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status, after: Number(r.headers.get('retry-after')) || 60 });
}

// Where a part of a source starts: a ticked folder's delta, the whole folder or library; each library of a site, its root's; a
// mailbox's folder list ('') and each folder's messages, as text. A drive's shows what its person can no longer see as deleted.
function start(offer: string, part: string): string {
  const [k, id] = kind(offer);
  if (k === 'item') return `${G()}/drives/${id.replace('/', '/items/')}/delta`;
  if (k === 'site') return `${G()}/drives/${part}/root/delta`;
  return `${G()}/users/${encodeURIComponent(id)}/mailFolders/${part ? `${encodeURIComponent(part)}/messages/` : ''}delta`;
}
const prefer = (offer: string) => (offer.startsWith('m365:mail:') ? 'outlook.body-content-type="text", odata.maxpagesize=50' : 'deltashowremovedasdeleted');
const fresh = (link: string): Part => ({ link, delta: null, as_of: null, pages: 0, due: Date.now(), error: null, tries: 0 });

// A failure keeps the page: throttling waits as Graph asks, an expired login waits for its person to sign in again, an expired
// delta token (410) crawls again, appending, for the tidy-up to fold, and anything else backs off, 1, 2, 4 and 8 minutes, then stops.
function failed(p: Part, e: any, link: string) {
  p.error = e.message;
  if (e.login) p.due = null;
  else if (e.status === 429 || e.status === 503) p.due = Date.now() + e.after * 1000;
  else if (e.status === 410) Object.assign(p, fresh(link), { error: e.message });
  else p.due = ++p.tries < TRIES ? Date.now() + 60_000 * 2 ** (p.tries - 1) : null;
}

// A person's due parts of a cache, 20 to a $batch, a page each, until none is due or `until` passes: a part is due again at once
// while its round has a next page, and an hour after it reaches its deltaLink. A mailbox's folder list adds and drops its folders'
// parts. A 403 or 404 means they can no longer read it: a mail folder or a site's library is removed, with what is under it at the
// tidy-up; for the source itself, the cache goes. A batch dropped as indexing stops leaves the cache as it was.
async function slice(person: string, offer: string, until: number): Promise<void> {
  const mail = offer.startsWith('m365:mail:');
  for (;;) {
    const c = load(person, offer);
    const due = c ? Object.entries(c.parts).filter(([, p]) => p.due !== null && p.due <= Date.now()).sort(([, a], [, b]) => a.due! - b.due!).slice(0, 20) : [];
    if (!c || !due.length) return;
    let answers: { id: string; status: number; headers?: Record<string, string>; body: any }[];
    try {
      answers = (await call(person, '/$batch', due.map(([, p], k) => ({ id: String(k), method: 'GET', url: p.link.slice(G().length), headers: { prefer: prefer(offer) } })))).responses;
    } catch (e) {
      if (halt.signal.aborted) return;
      for (const [part, p] of due) failed(p, e, start(offer, part));
      return save(c);
    }
    const lines: string[] = [];
    let lost: [string, Part, Error] | undefined;
    for (const a of answers) {
      const [part, p] = due[Number(a.id)];
      if (a.status !== 200) {
        const why = offer.startsWith('m365:item:') && !p.pages && (a.status === 400 || a.status === 501) ? '; Graph keeps no delta for this folder, so offer its library instead' : '';
        const e = Object.assign(new Error(`Microsoft Graph answered ${a.status}: ${JSON.stringify(a.body).slice(0, 300)}${why}`), { status: a.status, after: Number(a.headers?.['Retry-After']) || 60 });
        if ((a.status === 403 || a.status === 404) && part) {
          delete c.parts[part];
          lines.push(`${JSON.stringify({ id: part, '@removed': { reason: 'deleted' } })}\n`);
          c.base = 0;
        } else if (a.status === 403 || a.status === 404) lost = [part, p, e];
        else failed(p, e, start(offer, part));
        continue;
      }
      for (const it of a.body.value) {
        lines.push(`${JSON.stringify(it)}\n`);
        if (mail && !part) {
          if (it['@removed']) delete c.parts[it.id];
          else c.parts[it.id] ??= fresh(start(offer, it.id));
        }
      }
      const next = a.body['@odata.nextLink'], end = a.body['@odata.deltaLink'];
      Object.assign(p, { link: next ?? end, pages: p.pages + 1, due: next ? Date.now() : Date.now() + REFRESH_MS, error: null, tries: 0 }, end && { delta: end, as_of: new Date().toISOString() });
    }
    if (lost) {
      const [part, p, e] = lost, was = feed(c);
      Object.assign(c, { gen: c.gen + 1, length: 0, lines: 0, base: 0, parts: { [part]: { ...fresh(start(offer, part)), tries: p.tries } } });
      failed(c.parts[part], e, start(offer, part));
      save(c);
      return rmSync(was, { force: true });
    }
    if (lines.length) {
      const frame = await promisify(zstdCompress)(lines.join('')), fd = openSync(feed(c), 'a');
      ftruncateSync(fd, c.length);
      writeSync(fd, frame);
      fsyncSync(fd);
      closeSync(fd);
      c.length += frame.length;
      c.lines += lines.length;
    }
    save(c);
    if (Date.now() > until) return;
  }
}

// Once what later lines replaced or removed reaches a quarter of the feed, it's rewritten without them, and without what is under a
// removed folder or library, as delta sends only the folder, as a new feed that the .json then names. A library's root item has its
// drive as parent. Indexing stopping leaves it for next time.
async function tidy(c: Cache) {
  const file = feed(c), next = feed({ ...c, gen: c.gen + 1 });
  const read = () => createInterface({ input: createReadStream(file, { end: c.length - 1 }).pipe(createZstdDecompress()), crlfDelay: Infinity });
  const ids: string[] = [], last = new Map<string, number>(), gone = new Set<string>(), parent = new Map<string, string>();
  for await (const line of read()) {
    if (halt.signal.aborted) return;
    const it = JSON.parse(line);
    last.set(it.id, ids.push(it.id) - 1);
    if (it.deleted || it['@removed']) gone.add(it.id);
    else gone.delete(it.id);
    parent.set(it.id, it.parentFolderId ?? it.parentReference?.id ?? it.parentReference?.driveId);
  }
  const dead = new Map<string, boolean>();
  const under = (id: string | undefined): boolean => {
    if (id === undefined) return false;
    if (!dead.has(id)) {
      dead.set(id, false);
      dead.set(id, gone.has(id) || under(parent.get(id)));
    }
    return dead.get(id)!;
  };
  let i = 0, kept = 0;
  await pipeline(async function* () {
    for await (const line of read()) {
      if (halt.signal.aborted) return;
      const id = ids[i];
      if (last.get(id) === i++ && !under(id)) {
        kept++;
        yield `${line}\n`;
      }
    }
  }, createZstdCompress(), createWriteStream(next));
  if (halt.signal.aborted) return;
  Object.assign(c, { gen: c.gen + 1, length: statSync(next).size, base: statSync(next).size, lines: kept });
  save(c);
  rmSync(file);
}

// A cache starts with its source's first part, or for a site, a part per library, which are listed again each time.
async function begin(o: Offer, person: string) {
  const [k, id] = kind(o.id), c = load(person, o.id) ?? { person, source: o.id, name: o.name, gen: 0, length: 0, lines: 0, base: 0, parts: k === 'site' ? {} : { '': fresh(start(o.id, '')) } };
  c.name = o.name;
  if (k === 'site') for (const d of (await call(person, `/sites/${id}/drives?$select=id`)).value) c.parts[d.id] ??= fresh(start(o.id, d.id));
  mkdirSync(dirname(at(person, o.id)), { recursive: true, mode: 0o700 });
  save(c);
}

// A person's caches start, or a site's libraries are listed again, in the background: when they add an offer or sign in, and at the
// server's start.
export function track(email: string) {
  const l = m365(email);
  for (const o of l && !l.expired ? l.offers.filter(indexed) : []) queue(at(email, o.id), () => begin(o, email)).then(() => poke(), e => console.error(`index of ${o.id} for ${email}: no start`, e));
}

// A person's cache goes when they remove its offer, or every one when they sign out of Microsoft 365, after any write going on.
export function forget(email: string, offer?: string) {
  for (const c of caches().filter(c => c.person === email && (!offer || c.source === offer)))
    queue(at(email, c.source), async () => {
      const now = load(email, c.source);
      for (const f of now ? [feed(now), `${at(email, c.source)}.json`] : []) rmSync(f, { force: true });
    });
}

// Before a run starts, for each source its runner ticked that has a cache, without waiting for it: into `to`, on the same disk, a
// copy of the feed as its .json accounts for it, by reflink where the disk does that, as <name>.ndjson.zst, and <name>.json: the
// source, their own deltaLinks, to follow for what changed since, and as_of, when the oldest of them was reached, null while the
// cache is still being built. All of it runs at once, so no tidy-up starts a new feed in between. Whether there was any.
export function prepare(inst: Instance, to: string): boolean {
  let by: string, ticked: string[];
  try {
    ({ by, logins: ticked } = lender(inst));
  } catch {
    return false;
  }
  const names = new Set<string>();
  for (const o of (m365(by)?.offers ?? []).filter(o => ticked.includes(o.id) && indexed(o))) {
    const c = load(by, o.id), base = o.name.replace(/[/\0]/g, '-'), ps = Object.values(c?.parts ?? {});
    if (!c) continue;
    let name = base;
    for (let k = 2; names.has(name); k++) name = `${base} ${k}`;
    names.add(name);
    mkdirSync(to, { recursive: true });
    if (c.length) {
      copyFileSync(feed(c), join(to, `${name}.ndjson.zst`), constants.COPYFILE_FICLONE);
      truncateSync(join(to, `${name}.ndjson.zst`), c.length);
    }
    writeFileSync(join(to, `${name}.json`), JSON.stringify({ source: o.id, as_of: ps.length && ps.every(p => p.as_of) ? ps.map(p => p.as_of!).sort()[0] : null, deltaLinks: ps.flatMap(p => p.delta ?? []) }, null, 1));
  }
  return names.size > 0;
}

// In the background, the most overdue cache gets a slice, again and again, one at a time: each crawl goes on to its end, and each
// cache catches up hourly while its person's login offers its source. Nothing is kept in memory, so a restart goes on from the
// .json files, and a drain waits for none of it.
let worker: Promise<void> | undefined, poke = () => {};
const rest = (ms: number) => new Promise<void>(ok => { poke = ok; setTimeout(ok, Math.max(0, Math.min(ms, 60_000))).unref(); });
export function startIndexing() {
  halt = new AbortController();
  // Copies of runs cut short.
  rmSync(join(rfDir(), 'runs'), { recursive: true, force: true });
  for (const email of Object.keys(users())) track(email);
  worker = (async () => {
    while (!halt.signal.aborted) {
      const next = caches().filter(c => offered(c.person, c.source)).flatMap(c => Object.values(c.parts).flatMap(p => (p.due === null ? [] : [{ c, due: p.due }]))).sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > Date.now()) await rest((next?.due ?? Infinity) - Date.now());
      else await queue(at(next.c.person, next.c.source), async () => {
        await slice(next.c.person, next.c.source, Date.now() + SLICE_MS);
        const c = load(next.c.person, next.c.source);
        if (c && Object.values(c.parts).every(p => p.delta) && c.length > c.base * 1.25) await tidy(c);
      }).catch(e => (console.error('indexing', e), rest(60_000)));
    }
  })();
}
export function stopIndexing(): Promise<void> {
  halt.abort();
  poke();
  return worker ?? Promise.resolve();
}

// Signing in to Microsoft 365 again resumes a person's paused or stopped parts, at the page where they stopped.
changes.on('login', (email: string, id: string) => {
  if (id !== 'm365') return;
  for (const { source } of caches().filter(c => c.person === email))
    queue(at(email, source), async () => {
      const c = load(email, source);
      if (!c) return;
      for (const p of Object.values(c.parts)) if (p.due === null) Object.assign(p, { due: Date.now(), tries: 0 });
      save(c);
    }).then(() => poke());
  track(email);
});

// Each cache, for rf indexes and rf status: its source, its lines and bytes, and how its person's indexing goes, in crawl until
// each part first reached its deltaLink and in follow after, caught up when the oldest of them last did.
export function indexes() {
  return caches().map(c => {
    const ps = Object.values(c.parts), err = ps.find(p => p.error);
    return {
      name: c.name, source: c.source, kind: ({ item: 'folder', site: 'site', mail: 'mailbox' } as Record<string, string>)[kind(c.source)[0]], items: c.lines, bytes: c.length,
      people: [{
        who: c.person, phase: ps.every(p => p.delta) ? 'follow' : 'crawl', pages: ps.reduce((n, p) => n + p.pages, 0),
        caught_up: ps.length && ps.every(p => p.as_of) ? ps.map(p => p.as_of!).sort()[0] : null, error: err?.error ?? null, retry_at: err?.due ? new Date(err.due).toISOString() : null,
      }],
    };
  });
}
