import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { copyFile, stat, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createZstdCompress, createZstdDecompress, zstdCompress } from 'node:zlib';
import { wipe, type Instance } from './store.ts';
import { changes, rfDir } from './system.ts';
import { asPerson, can, users } from './auth.ts';
import { token } from './entra.ts';
import { lender, loginGeneration, logins, personDir, sameAuthority, use, type Offer, type Login } from './logins.ts';
import type { Authority } from './series.ts';
import { endpoints, scope } from './connections/graph.ts';
import { scratch } from './runner.ts';

// Indexes of outside sources (docs/system.md: Indexes). A person's Microsoft 365 login keeps a cache of each offer it makes, but a file: the
// delta feed Graph gave their own token, its crawl then its changes, Graph's own JSON, one item per line, in
// .rf/people/<p>/index/<sha256(offer)[:16]>.<gen>.ndjson.zst, a zstd frame per batch of pages. A later line for an id replaces an
// earlier one, and a deleted facet or an @removed removes it. The .json beside it, <sha256(offer)[:16]>.json, holds the cursors, one
// per part of the source, and which feed is the cache and how much of it they account for. A batch is appended and synced first,
// and only then is the .json replaced; each write starts by cutting the feed back to that length, so a crash in between replays the
// batch and nothing else. What the .json accounts for never changes under a feed's name: a tidy-up, a 410, or a source lost, starts a new
// one, so a run copies a cache as it is, without waiting.
const SLICE_MS = 5_000, REFRESH_MS = 60 * 60_000, TRIES = 5;
const WAKE_COPY_BYTES = 64 * 2 ** 20;
const WAKE_MAX_STALE_MIN = 150;
const TRANSIENT_ERROR = /^(?:Microsoft Graph answered (?:500|502|504):|The operation was aborted due to timeout\b)/;
const wakeRebuildAfter = new Map<string, number>();

type Part = { link: string; delta: string | null; as_of: string | null; pages: number; due: number | null; error: string | null; tries: number };
type Compact = { grant: string; state: 'pending-append' | 'appended' };
type Cache = { person: string; source: string; name: string; gen: number; length: number; lines: number; base: number; parts: Record<string, Part>; wakeGrant?: string; compact?: Compact };

const isReflinkUnsupported = (e: unknown) => ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'].includes((e as NodeJS.ErrnoException)?.code ?? '');
function wakeCopyBytes(): number {
  const raw = process.env.RF_WAKE_COPY_MB;
  if (raw === undefined || !raw.trim()) return WAKE_COPY_BYTES;
  const mb = Number(raw);
  return Number.isFinite(mb) && mb >= 0 ? Math.floor(mb * 2 ** 20) : WAKE_COPY_BYTES;
}
function wakeMaxStaleMin(override?: number): number {
  if (override !== undefined) return override;
  const raw = process.env.RF_WAKE_MAX_STALE_MIN;
  if (raw === undefined || !raw.trim()) return WAKE_MAX_STALE_MIN;
  const min = Number(raw);
  return Number.isFinite(min) && min > 0 ? min : WAKE_MAX_STALE_MIN;
}

// A feed line, U+2028 and U+2029 escaped: JSON.stringify leaves them raw, and line readers such as node's readline and Python's
// splitlines() end a line at them.
const ndjson = (json: string) => `${json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`;
const kind = (offer: string) => /^m365:(\w+):?(.*)$/.exec(offer)!.slice(1) as [string, string];
const m365 = (email: string) => logins(email).find(l => l.id === 'm365');
const wakeGrant = (login?: Login) => login && !login.expired ? JSON.stringify([loginGeneration(login), login.scopes?.toSorted()]) : undefined;
const wakeOptedIn = (email: string) => { const p = asPerson(email); return !!p && can(p, 'wake-check'); };
const indexed = (o: Offer) => /^m365:(item:|site:|mail:|onedrive$)/.test(o.id) && !o.name.startsWith('File ');
const hasOffer = (person: string, offer: string) => !!m365(person)?.offers.some(o => o.id === offer);
// A cache is kept up while its person's login offers its source and hasn't expired.
const offered = (person: string, offer: string) => hasOffer(person, offer) && !m365(person)!.expired;
const at = (person: string, offer: string) => join(personDir(person), 'index', createHash('sha256').update(offer).digest('hex').slice(0, 16));
const feed = (c: Cache) => `${at(c.person, c.source)}.${c.gen}.ndjson.zst`;
const load = (person: string, offer: string): Cache | undefined => (existsSync(`${at(person, offer)}.json`) ? JSON.parse(readFileSync(`${at(person, offer)}.json`, 'utf8')) : undefined);
function writeAllSync(fd: number, buf: Buffer) {
  for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
}
function fsyncFile(p: string) {
  const fd = openSync(p, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function fsyncDir(dir: string) {
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch (e) {
    if (!['EINVAL', 'EBADF', 'EISDIR', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '')) throw e;
  } finally {
    closeSync(fd);
  }
}
function save(c: Cache, invalidates = false, sync = false) {
  const f = `${at(c.person, c.source)}.json`;
  const tmp = `${f}.tmp`;
  if (sync) {
    const fd = openSync(tmp, 'w');
    try {
      writeAllSync(fd, Buffer.from(JSON.stringify(c)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, f);
    fsyncDir(dirname(f));
  } else {
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, f);
  }
  if (invalidates) changes.emit('index-removed', c.person, c.source);
}

function reset(c: Cache, parts: Record<string, Part>) {
  const was = feed(c);
  delete c.compact;
  Object.assign(c, { gen: c.gen + 1, length: 0, lines: 0, base: 0, parts });
  save(c, true, true);
  rmSync(was, { force: true });
}

function resetCompact(c: Cache) {
  const oldGrant = c.compact?.grant;
  const [k] = kind(c.source);
  const parts = k === 'site'
    ? Object.fromEntries(Object.keys(c.parts).map(part => [part, fresh(start(c.source, part))]))
    : { '': fresh(start(c.source, '')) };
  if (oldGrant && offered(c.person, c.source) && wakeOptedIn(c.person) && wakeGrant(m365(c.person)) === oldGrant) c.wakeGrant = oldGrant;
  else delete c.wakeGrant;
  reset(c, parts);
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
const G = () => `${endpoints.graph}/v1.0`;
async function call(email: string, path: string, requests?: object[]): Promise<any> {
  const r = await fetch(`${G()}${path}`, {
    method: requests ? 'POST' : 'GET', body: requests && JSON.stringify({ requests }),
    headers: { authorization: `Bearer ${await token(email, 'm365', scope())}`, ...(requests && { 'content-type': 'application/json' }) },
    signal: AbortSignal.timeout(120_000),
  });
  if (r.ok) return r.json();
  throw Object.assign(new Error(`Microsoft Graph answered ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status, after: Number(r.headers.get('retry-after')) || 60 });
}

// Where a part of a source starts: a ticked folder's delta, the whole folder or library; a person's whole OneDrive, its root's; each
// library of a site, its root's; a mailbox's folder list ('') and each folder's messages, as text. A drive's shows what its person
// can no longer see as deleted.
function start(offer: string, part: string): string {
  const [k, id] = kind(offer);
  if (k === 'item') return `${G()}/drives/${id.replace('/', '/items/')}/delta`;
  if (k === 'onedrive') return `${G()}/me/drive/root/delta`;
  if (k === 'site') return `${G()}/drives/${part}/root/delta`;
  return `${G()}/users/${encodeURIComponent(id)}/mailFolders/${part ? `${encodeURIComponent(part)}/messages/` : ''}delta`;
}
const prefer = (offer: string) => (offer.startsWith('m365:mail:') ? 'outlook.body-content-type="text", odata.maxpagesize=50' : 'deltashowremovedasdeleted');
const fresh = (link: string): Part => ({ link, delta: null, as_of: null, pages: 0, due: Date.now(), error: null, tries: 0 });

// A failure keeps the page: throttling waits as Graph asks, an expired login waits for its person to sign in again, an expired
// delta token (410) starts a new feed and crawls again, transient server errors and timeouts back off up to an hour and keep
// trying, and anything else backs off, 1, 2, 4 and 8 minutes, then stops.
function failed(p: Part, e: any, link: string) {
  p.error = e.message;
  if (e.login) p.due = null;
  else if (e.status === 429 || e.status === 503) p.due = Date.now() + e.after * 1000;
  else if (e.status === 410) Object.assign(p, fresh(link), { error: e.message });
  else if (TRANSIENT_ERROR.test(e.message ?? '')) p.due = Date.now() + Math.min(REFRESH_MS, 60_000 * 2 ** Math.min(++p.tries - 1, 6));
  else p.due = ++p.tries < TRIES ? Date.now() + 60_000 * 2 ** (p.tries - 1) : null;
}

// A person's due parts of a cache, 20 to a $batch, a page each, until none is due or `until` passes: a part is due again at once
// while its round has a next page, and an hour after it reaches its deltaLink. A mailbox's folder list adds and drops its folders'
// parts. A 403 or 404 means they can no longer read it: a mail folder or a site's library is removed, with what is under it at the
// tidy-up; for the source itself, the cache goes.
async function slice(person: string, offer: string, until: number): Promise<void> {
  const mail = offer.startsWith('m365:mail:');
  for (;;) {
    const c = load(person, offer);
    if (!c) return;
    if (c.compact) {
      await finishCompact(person, offer);
      return;
    }
    const due = Object.entries(c.parts).filter(([, p]) => p.due !== null && p.due <= Date.now()).sort(([, a], [, b]) => a.due! - b.due!).slice(0, 20);
    if (!due.length) return;
    const login = m365(person), generation = loginGeneration(login);
    if (c.wakeGrant && c.wakeGrant !== wakeGrant(login)) delete c.wakeGrant;
    const current = () => {
      const now = m365(person);
      return !!now && loginGeneration(now) === generation && now.offers.some(o => o.id === offer)
        && (!c.wakeGrant || now.expired || c.wakeGrant === wakeGrant(now));
    };
    let answers: { id: string; status: number; headers?: Record<string, string>; body: any }[];
    try {
      answers = (await call(person, '/$batch', due.map(([, p], k) => ({ id: String(k), method: 'GET', url: p.link.slice(G().length), headers: { prefer: prefer(offer) } })))).responses;
    } catch (e) {
      if (!current()) return;
      if (c.wakeGrant && [403, 404].includes((e as { status?: number }).status!)) {
        const parts = Object.fromEntries(Object.keys(c.parts).map(part => [part, fresh(start(offer, part))]));
        for (const [part, p] of Object.entries(parts)) failed(p, e, start(offer, part));
        return reset(c, parts);
      }
      for (const [part, p] of due) failed(p, e, start(offer, part));
      return save(c);
    }
    if (!current()) return;
    // A 403 or 404 on a wake-capable feed resets immediately before lending older, raw rows again,
    // except a 404 on a mail folder that the folder list ('') itself reported @removed in the same $batch.
    const removedFolders = new Set(mail ? answers.filter(a => a.status === 200 && !due[Number(a.id)][0])
      .flatMap(a => a.body.value.filter((it: any) => it['@removed']).map((it: any) => it.id as string)) : []);
    const isDenial = (a: { id: string; status: number }) => a.status === 403 || (a.status === 404 && !removedFolders.has(due[Number(a.id)][0]));
    if (c.wakeGrant && (c.length || Object.values(c.parts).some(p => p.delta)) && answers.some(isDenial)) {
      const denied = new Map(answers.filter(isDenial).map(a => [due[Number(a.id)][0], a.status]));
      const parts = Object.fromEntries(Object.keys(c.parts).filter(part => !part || !denied.has(part)).map(part => [part, fresh(start(offer, part))]));
      if (denied.has('')) failed(parts[''], { status: denied.get(''), message: `Microsoft Graph answered ${denied.get('')}` }, start(offer, ''));
      return reset(c, parts);
    }
    const savedGrant = c.wakeGrant;
    const pre: Cache | undefined = savedGrant ? { ...c, parts: structuredClone(c.parts), compact: { grant: savedGrant, state: 'pending-append' } } : undefined;
    if (pre) delete pre.wakeGrant;
    let hasDeletion = false;
    const lines: string[] = [];
    let lost: [string, Part, Error & { status: number }] | undefined;
    for (const a of answers) {
      const [part, p] = due[Number(a.id)];
      if (a.status !== 200) {
        const why = offer.startsWith('m365:item:') && !p.pages && (a.status === 400 || a.status === 501) ? '; Graph keeps no delta for this folder, so offer its library instead' : '';
        const e = Object.assign(new Error(`Microsoft Graph answered ${a.status}: ${JSON.stringify(a.body).slice(0, 300)}${why}`), { status: a.status, after: Number(a.headers?.['Retry-After']) || 60 });
        if ((a.status === 403 || a.status === 404) && part) {
          delete c.parts[part];
          lines.push(ndjson(JSON.stringify({ id: part, '@removed': { reason: 'deleted' } })));
          c.base = 0;
          hasDeletion = true;
        } else if (a.status === 410) lost = [part, p, e];
        else if (a.status === 403 || a.status === 404) lost ??= [part, p, e];
        else failed(p, e, start(offer, part));
        continue;
      }
      for (const it of a.body.value) {
        if (it.deleted || it['@removed']) hasDeletion = true;
        lines.push(ndjson(JSON.stringify(it)));
        if (mail && !part) {
          if (it['@removed']) delete c.parts[it.id];
          else c.parts[it.id] ??= fresh(start(offer, it.id));
        }
      }
      const next = a.body['@odata.nextLink'], end = a.body['@odata.deltaLink'];
      Object.assign(p, { link: next ?? end, pages: p.pages + 1, due: next ? Date.now() : Date.now() + REFRESH_MS, error: null, tries: 0 }, end && { delta: end, as_of: new Date().toISOString() });
    }
    if (lost) {
      const [part, p, e] = lost, parts = e.status === 410 ? Object.fromEntries(Object.keys(c.parts).map(part => [part, fresh(start(offer, part))]))
        : { [part]: { ...fresh(start(offer, part)), tries: p.tries } };
      if (parts[part]) failed(parts[part], e, start(offer, part));
      return reset(c, parts);
    }
    if (lines.length) {
      const frame = await promisify(zstdCompress)(lines.join(''));
      if (!current() || m365(person)?.expired) return;
      const needsCompact = !!pre && hasDeletion;
      if (needsCompact) save(pre, true, true);
      const fd = openSync(feed(c), 'a');
      try {
        ftruncateSync(fd, c.length);
        writeAllSync(fd, frame);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (needsCompact) fsyncDir(dirname(feed(c)));
      c.length += frame.length;
      c.lines += lines.length;
      if (needsCompact) {
        delete c.wakeGrant;
        c.compact = { grant: savedGrant!, state: 'appended' };
        save(c, false, true);
        await finishCompact(person, offer);
        if (Date.now() > until) return;
        continue;
      }
    }
    save(c);
    if (Date.now() > until) return;
  }
}

class FeedReadError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}

// Once what later lines replaced or removed reaches a quarter of the feed, or after a deletion on a wake-capable cache, it's
// rewritten without them, and without what is under a removed folder or library, as delta sends only the folder, as a new feed
// that the .json then names. A library's root item has its drive as parent.
async function tidy(c: Cache) {
  const file = feed(c), next = feed({ ...c, gen: c.gen + 1 });
  if (c.length > 0 && (!existsSync(file) || statSync(file).size < c.length))
    throw new FeedReadError(`index feed shorter than ${c.length} bytes`);
  const read = async function* () {
    if (!c.length) return;
    let rest = '';
    const src = createReadStream(file, { end: c.length - 1 }), dec = createZstdDecompress();
    src.on('error', e => dec.destroy(e));
    src.pipe(dec);
    dec.setEncoding('utf8');
    try {
      for await (const chunk of dec) {
        const ls = (rest + chunk).split('\n');
        rest = ls.pop()!;
        yield* ls;
      }
      if (rest) yield rest;
    } catch (e) {
      throw new FeedReadError('index feed could not be read', { cause: e });
    } finally {
      src.destroy();
      dec.destroy();
    }
  };
  const ids: string[] = [], last = new Map<string, number>(), gone = new Set<string>(), parent = new Map<string, string>();
  const parentFields = new Map<string, { parentFolderId: string } | { parentReference: { driveId?: string; id?: string; path?: string } }>(), needsParent = new Set<string>();
  for await (const line of read()) {
    let it: any;
    try {
      it = JSON.parse(line);
    } catch (e) {
      throw new FeedReadError('index feed held invalid JSON', { cause: e });
    }
    last.set(it.id, ids.push(it.id) - 1);
    if (it.deleted || it['@removed']) gone.add(it.id);
    else gone.delete(it.id);
    if (it.parentFolderId !== undefined) {
      parent.set(it.id, it.parentFolderId);
      parentFields.set(it.id, { parentFolderId: it.parentFolderId });
      needsParent.delete(it.id);
    } else if (it.parentReference && typeof it.parentReference === 'object') {
      const prev = parentFields.get(it.id);
      const prevRef = prev && 'parentReference' in prev ? prev.parentReference : undefined;
      const curDrive = it.parentReference.driveId as string | undefined;
      const curId = it.parentReference.id as string | undefined;
      const curPath = it.parentReference.path as string | undefined;
      const sameDrive = !!prevRef && (curDrive === undefined || prevRef.driveId === undefined || curDrive === prevRef.driveId);
      const merged: { driveId?: string; id?: string; path?: string } = {
        ...(sameDrive && prevRef.driveId !== undefined && { driveId: prevRef.driveId }),
        ...(sameDrive && prevRef.id !== undefined && { id: prevRef.id }),
        ...(sameDrive && (curId === undefined || prevRef.id === curId) && prevRef.path !== undefined && { path: prevRef.path }),
        ...(curDrive !== undefined && { driveId: curDrive }),
        ...(curId !== undefined && { id: curId }),
        ...(curPath !== undefined && { path: curPath }),
      };
      const p = merged.id ?? merged.driveId;
      if (p !== undefined) parent.set(it.id, p);
      if (p !== undefined || merged.path !== undefined) {
        parentFields.set(it.id, { parentReference: merged });
        const missing = (merged.id !== undefined && curId === undefined)
          || (merged.driveId !== undefined && curDrive === undefined)
          || (merged.path !== undefined && curPath === undefined);
        if (missing) needsParent.add(it.id);
        else needsParent.delete(it.id);
      } else if (prev) {
        needsParent.add(it.id);
      }
    } else if (parentFields.has(it.id)) {
      needsParent.add(it.id);
    }
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
  try {
    await pipeline(async function* () {
      for await (const line of read()) {
        const id = ids[i];
        if (last.get(id) === i++ && !under(id)) {
          kept++;
          if (needsParent.has(id)) {
            const it = JSON.parse(line), pf = parentFields.get(id)!;
            if ('parentFolderId' in pf) it.parentFolderId = pf.parentFolderId;
            else it.parentReference = { ...(it.parentReference && typeof it.parentReference === 'object' ? it.parentReference : {}), ...pf.parentReference };
            yield ndjson(JSON.stringify(it));
          } else {
            yield ndjson(line);
          }
        }
      }
    }, createZstdCompress(), createWriteStream(next));
    fsyncFile(next);
    fsyncDir(dirname(next));
  } catch (e) {
    rmSync(next, { force: true });
    throw e;
  }
  if (!hasOffer(c.person, c.source)) return rmSync(next, { force: true });
  const size = statSync(next).size;
  if (c.compact) {
    const restore = c.compact.state === 'appended' && offered(c.person, c.source)
      && wakeOptedIn(c.person) && wakeGrant(m365(c.person)) === c.compact.grant;
    if (restore) c.wakeGrant = c.compact.grant;
    else delete c.wakeGrant;
    delete c.compact;
  }
  Object.assign(c, { gen: c.gen + 1, length: size, base: size, lines: kept });
  save(c, true, true);
  rmSync(file, { force: true });
}

async function finishCompact(person: string, offer: string) {
  const c = load(person, offer);
  if (!c?.compact) return;
  if (c.compact.state === 'pending-append') return resetCompact(c);
  try {
    await tidy(c);
  } catch (e) {
    if (e instanceof FeedReadError) return resetCompact(c);
    throw e;
  }
}

const epochs = new Map<string, number>();
const epochOf = (k: string) => epochs.get(k) ?? 0;
const bump = (k: string) => epochs.set(k, epochOf(k) + 1);

// A cache starts with its source's first part, or for a site, a part per library, which are listed again each time.
async function begin(o: Offer, person: string, generation: string, ep: string, forWake = false) {
  const key = at(person, o.id);
  const alive = () => `${epochOf(personDir(person))}:${epochOf(key)}` === ep && loginGeneration(m365(person)) === generation && offered(person, o.id);
  if (!alive() || (forWake && !wakeOptedIn(person))) return;
  const [k, id] = kind(o.id), old = load(person, o.id), grant = wakeGrant(m365(person));
  if (forWake && (old?.wakeGrant === grant || (old?.compact?.state === 'appended' && old.compact.grant === grant))) return;
  const c: Cache = (!forWake && old) || { person, source: o.id, name: o.name, gen: old ? old.gen + 1 : 0, length: 0, lines: 0, base: 0, parts: k === 'site' ? {} : { '': fresh(start(o.id, '')) } };
  c.name = o.name;
  if (k === 'site') {
    let path: string | undefined = `/sites/${id}/drives?$select=id`;
    const listed = new Set<string>();
    try {
      while (path) {
        const page = await call(person, path);
        if (!alive()) return;
        for (const d of page.value) listed.add(d.id);
        path = page['@odata.nextLink']?.slice(G().length);
      }
    } catch (e) {
      if ((old?.wakeGrant || old?.compact) && alive() && [403, 404].includes((e as { status?: number }).status!)) reset(old, {});
      throw e;
    }
    if ((c.wakeGrant || c.compact) && Object.keys(c.parts).some(key => !listed.has(key)))
      return reset(c, Object.fromEntries([...listed].map(part => [part, fresh(start(o.id, part))])));
    for (const part of listed) c.parts[part] ??= fresh(start(o.id, part));
  }
  if (!alive() || (forWake && !wakeOptedIn(person))) return;
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  if (forWake) c.wakeGrant = wakeGrant(m365(person));
  save(c, forWake, forWake);
  if (forWake && old) rmSync(feed(old), { force: true });
}

// A person's caches start, or a site's libraries are listed again, in the background: when they add an offer or sign in, and at the
// server's start.
export function track(email: string) {
  const l = m365(email);
  if (!l || l.expired) return;
  for (const o of l.offers.filter(indexed)) {
    const key = at(email, o.id), ep = `${epochOf(personDir(email))}:${epochOf(key)}`;
    queue(key, () => begin(o, email, loginGeneration(l)!, ep)).then(() => poke(), e => console.error(`index of ${o.id} for ${email}: no start`, e));
  }
}

// A person's cache goes when they remove its offer, or every one when they sign out of Microsoft 365, after any write going on.
export function forget(email: string, offer?: string) {
  bump(offer ? at(email, offer) : personDir(email));
  const prefix = `${join(personDir(email), 'index')}/`;
  const keys = new Set([
    ...(offer ? [at(email, offer)] : [...queues.keys()].filter(k => k.startsWith(prefix))),
    ...caches().filter(c => c.person === email && (!offer || c.source === offer)).map(c => at(email, c.source)),
  ]);
  for (const k of keys) {
    wakeRebuildAfter.delete(k);
    queue(k, async () => {
      if (!existsSync(`${k}.json`)) return;
      const now = JSON.parse(readFileSync(`${k}.json`, 'utf8')) as Cache;
      for (const f of [feed(now), `${k}.json`]) rmSync(f, { force: true });
      changes.emit('index-removed', now.person, now.source);
    });
  }
}

// What a run of the instance reads: the cache of each source its lender ticked that has one so far, without waiting for it.
export function sources(inst: Instance | string, run?: number | Authority): { o: Offer; c: Cache }[] {
  let by: string, ticked: string[];
  try {
    if (typeof run === 'object') {
      if (!sameAuthority(inst, run) || m365(run.owner)?.expired) return [];
      ({ owner: by, logins: ticked } = run);
    } else ({ by, logins: ticked } = lender(inst as Instance, run));
  } catch {
    return [];
  }
  return (m365(by)?.offers ?? []).filter(o => ticked.includes(o.id) && indexed(o)).flatMap(o => {
    const c = load(by, o.id);
    return c ? [{ o, c }] : [];
  });
}

// What a run's $RF_INDEX holds, in its README.md.
const README = `# $RF_INDEX

Your series owner's own caches of the Microsoft 365 sources ticked for this run, two files for each that has one, by its name in
your first message. When \`NAME.json\` has a non-null \`as_of\`, query \`NAME.ndjson.zst\` locally first and follow \`deltaLinks\` only
for changes after \`as_of\` (or skip Graph when \`as_of\` already covers your window); call Graph directly only for attachments or
file bytes, writes, or sources with no cache (\`as_of: null\` or no files):

- NAME.ndjson.zst: its delta feed from Graph, its crawl then its changes, in Graph's own JSON, one item per line (mailbox feeds
  include each message's plain-text \`body\`, so you do not need to re-fetch message bodies over Graph; file items have no paths,
  which parent ids rebuild). A later line for an id replaces an earlier one, and a \`deleted\` facet or an \`@removed\` removes it,
  a folder's with everything under it. Stream it line by line and keep only the fields you need: a compressed feed expands many
  times in memory if loaded whole.
- NAME.json: its \`source\`, the tick; \`as_of\`, when its oldest part last caught up (the server refreshes caches about hourly),
  null while it's still being built; and your series owner's \`deltaLinks\`, to follow as they are for what changed since.

In a wake check there is no network, so do not call Graph or follow \`deltaLinks\`: read these files as they are and compare
\`as_of\` against the business window you need rather than wall-clock age.

A ticked source with neither file has no cache yet.
`;

// Before a run starts, for each of its caches: into `to`, on the same disk, a copy of the feed as its .json accounts for it, by
// reflink where the disk does that, as <name>.ndjson.zst, and <name>.json: the source, their own deltaLinks, to follow for what
// changed since, and as_of, when the oldest of them was reached, null while the cache is still being built; and the README.md that
// says so. Pi's copies are synchronous and resume stopped parts in their cache's queue. A wake check instead takes an async
// snapshot without touching the feeds, so its deadline can still fire during a slow copy.
export type Snapshot = { offers: string[]; valid(): boolean };
export function prepare(inst: Instance, to: string, run?: number): boolean;
export function prepare(inst: Instance | string, to: string, run: Authority, signal: AbortSignal, maxStaleMin?: number): Promise<Snapshot | undefined>;
export function prepare(inst: Instance | string, to: string, run?: number | Authority, signal?: AbortSignal, maxStaleMin?: number): boolean | Promise<Snapshot | undefined> {
  signal?.throwIfAborted();
  const names = new Set<string>(), included = sources(inst, run);
  const lease = typeof run === 'object' ? run : undefined, login = lease && m365(lease.owner), grant = wakeGrant(login);
  const selected = lease && login?.offers.filter(o => lease.logins.includes(o.id) && indexed(o));
  if (selected?.length && (!grant || selected.length !== included.length ||
      included.some(({ c }) => c.wakeGrant !== grant || c.compact || !Object.keys(c.parts).length || Object.values(c.parts).some(p => !p.delta || p.due === null))))
    throw new Error('Microsoft 365 indexes are not ready for a wake check');
  if (selected?.length) {
    const cutoff = Date.now() - wakeMaxStaleMin(maxStaleMin) * 60_000;
    for (const { c } of included) {
      const ps = Object.values(c.parts);
      const asOf = ps.length && ps.every(p => p.as_of) ? ps.map(p => p.as_of!).sort()[0] : null;
      const ts = asOf ? Date.parse(asOf) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff)
        throw new Error('Microsoft 365 indexes are stale for a wake check');
    }
  }
  const planned: { o: Offer; c: Cache; name: string; ps: Part[] }[] = [];
  for (const { o, c } of included) {
    const base = o.name.replace(/[/\0]/g, '-'), ps = Object.values(c.parts);
    const fit = (suffix: string) => {
      let s = '';
      for (const ch of base) if (Buffer.byteLength(s + ch + suffix + '.ndjson.zst') <= 255) s += ch; else break;
      return s + suffix;
    };
    if (!lease && ps.some(p => p.due === null && p.tries >= TRIES)) queue(at(c.person, c.source), async () => {
      const now = load(c.person, c.source);
      if (!now) return;
      for (const p of Object.values(now.parts)) if (p.due === null && p.tries >= TRIES) Object.assign(p, { due: Date.now(), tries: 0 });
      save(now);
    }).then(() => poke());
    let name = fit('');
    for (let k = 2; names.has(name); k++) name = fit(` ${k}`);
    names.add(name);
    planned.push({ o, c, name, ps });
    if (!lease) {
      mkdirSync(to, { recursive: true });
      if (c.length) {
        const file = join(to, `${name}.ndjson.zst`);
        copyFileSync(feed(c), file, constants.COPYFILE_FICLONE);
        truncateSync(file, c.length);
      }
      writeFileSync(join(to, `${name}.json`), JSON.stringify({ source: o.id, as_of: ps.length && ps.every(p => p.as_of) ? ps.map(p => p.as_of!).sort()[0] : null, deltaLinks: ps.flatMap(p => p.delta ?? []) }, null, 1));
    }
  }
  if (!lease) {
    if (names.size) writeFileSync(join(to, 'README.md'), README);
    return names.size > 0;
  }
  return (async () => {
    signal!.throwIfAborted();
    if (!planned.length) return undefined;
    mkdirSync(to, { recursive: true });
    const streamLimit = wakeCopyBytes();
    const created: string[] = [];
    let streamedBytes = 0;
    let remainingBytes = planned.reduce((sum, { c }) => sum + c.length, 0);
    try {
      for (const { o, c, name, ps } of planned) {
        signal!.throwIfAborted();
        if (c.length) {
          const file = join(to, `${name}.ndjson.zst`);
          let reflinked = false;
          try {
            await copyFile(feed(c), file, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
            created.push(file);
            reflinked = true;
          } catch (e) {
            if (!isReflinkUnsupported(e)) throw e;
          }
          if (reflinked) {
            signal!.throwIfAborted();
            const st = await stat(file);
            if (st.size < c.length) throw new Error('index feed changed during the copy');
            if (st.size > c.length) await truncate(file, c.length);
          } else {
            if (streamedBytes + remainingBytes > streamLimit) throw new Error('wake check index copy limit exceeded');
            created.push(file);
            const source = createReadStream(feed(c), { end: c.length - 1 });
            await pipeline(source, createWriteStream(file, { flags: 'wx' }), { signal });
            if (source.bytesRead !== c.length) throw new Error('index feed changed during the copy');
            streamedBytes += c.length;
          }
          const latest = load(lease.owner, o.id);
          if (!latest || latest.wakeGrant !== grant || latest.compact || latest.gen !== c.gen || latest.length < c.length
              || !Object.keys(c.parts).every(part => Object.hasOwn(latest.parts, part)))
            throw new Error('index feed changed during the copy');
        }
        remainingBytes -= c.length;
        const metaFile = join(to, `${name}.json`);
        writeFileSync(metaFile, JSON.stringify({ source: o.id, as_of: ps.length && ps.every(p => p.as_of) ? ps.map(p => p.as_of!).sort()[0] : null, deltaLinks: ps.flatMap(p => p.delta ?? []) }, null, 1));
        created.push(metaFile);
      }
      const readmeFile = join(to, 'README.md');
      writeFileSync(readmeFile, README);
      created.push(readmeFile);
    } catch (e) {
      for (const f of created) rmSync(f, { force: true });
      throw e;
    }
    return { offers: included.map(({ o }) => o.id), valid() {
      const login = m365(lease.owner);
      return !!login && !!grant && wakeGrant(login) === grant && sameAuthority(inst, lease) && included.every(({ o, c }) => {
        if (!login.offers.some(offer => offer.id === o.id)) return false;
        const latest = load(lease.owner, o.id);
        return latest?.wakeGrant === grant && !latest.compact && latest.gen === c.gen && latest.length >= c.length
          && Object.keys(c.parts).every(part => Object.hasOwn(latest.parts, part));
      });
    } };
  })();
}

// A going run's copies, by its token, of sources no longer lent it, as its runner unticked one, took its offer off or signed out,
// go at once.
export function prune(inst: Instance, run: number, token: string) {
  const dir = join(rfDir(), 'runs', token);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      use(inst, run, JSON.parse(readFileSync(join(dir, f), 'utf8')).source);
    } catch {
      for (const g of [f, f.replace(/json$/, 'ndjson.zst')]) rmSync(join(dir, g), { force: true });
    }
  }
}

// In the background, the most overdue cache gets a slice, again and again, one at a time: each crawl goes on to its end, and each
// cache catches up hourly while its person's login offers its source. Nothing is kept in memory, so a restart goes on from the
// .json files.
let stopping = false, worker: Promise<void> | undefined, poke = () => {};
const rest = (ms: number) => new Promise<void>(ok => { poke = ok; setTimeout(ok, Math.max(0, Math.min(ms, 60_000))).unref(); });
export function startIndexing() {
  stopping = false;
  // Scratch and index copies of this data root's runs a restart cut short.
  const runs = join(rfDir(), 'runs');
  for (const token of existsSync(runs) ? readdirSync(runs) : []) wipe(Buffer.from(join(scratch, 'runs', token)));
  rmSync(runs, { recursive: true, force: true });
  // Recover any crash-interrupted compaction and sweep orphan feed/tmp files left by crashes.
  const people = join(rfDir(), 'people');
  for (const p of existsSync(people) ? readdirSync(people) : []) {
    const dir = join(people, p, 'index');
    if (!existsSync(dir)) continue;
    const live = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json.tmp')) { rmSync(join(dir, f), { force: true }); continue; }
      if (!f.endsWith('.json')) continue;
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Cache;
      if (!hasOffer(c.person, c.source)) {
        rmSync(join(dir, f), { force: true });
        continue;
      }
      if (c.compact?.state === 'pending-append') resetCompact(c);
      live.add(`${f.slice(0, -5)}.${c.gen}.ndjson.zst`);
    }
    for (const f of readdirSync(dir))
      if (f.endsWith('.ndjson.zst') && !live.has(f)) rmSync(join(dir, f), { force: true });
  }
  // Parts stopped on transient Graph errors before transient retries were indefinite resume on startup while their offer is live.
  for (const c of caches()) {
    if (!offered(c.person, c.source)) continue;
    let resumed = false;
    for (const p of Object.values(c.parts)) if (p.due === null && p.error && TRANSIENT_ERROR.test(p.error)) {
      Object.assign(p, { due: Date.now(), tries: 0 });
      resumed = true;
    }
    if (resumed) save(c);
  }
  for (const email of Object.keys(users())) track(email);
  worker = (async () => {
    while (!stopping) {
      const compact = caches().find(c => c.compact && hasOffer(c.person, c.source) && (wakeRebuildAfter.get(at(c.person, c.source)) ?? 0) <= Date.now());
      if (compact) {
        const key = at(compact.person, compact.source);
        try {
          await queue(key, () => finishCompact(compact.person, compact.source));
          wakeRebuildAfter.delete(key);
        } catch (e) {
          wakeRebuildAfter.set(key, Date.now() + 60_000);
          console.error('compacting index:', e);
        }
        continue;
      }
      const offeredCaches = caches().filter(c => offered(c.person, c.source));
      // Only opted-in owners rebuild legacy copies or copies from a different login, in the background, never for a check.
      const rebuild = offeredCaches.find(c => !c.compact && (wakeRebuildAfter.get(at(c.person, c.source)) ?? 0) <= Date.now()
        && c.wakeGrant !== wakeGrant(m365(c.person)) && wakeOptedIn(c.person));
      if (rebuild) {
        const { person, source } = rebuild, l = m365(person)!, key = at(person, source);
        const ep = `${epochOf(personDir(person))}:${epochOf(key)}`;
        try {
          await queue(key, () => begin(l.offers.find(o => o.id === source)!, person, loginGeneration(l)!, ep, true));
          wakeRebuildAfter.delete(key);
        } catch (e) {
          wakeRebuildAfter.set(key, Date.now() + 60_000);
          console.error('indexing for wake checks:', e);
        }
        continue;
      }
      const next = offeredCaches.filter(c => !c.compact).flatMap(c => Object.values(c.parts).flatMap(p => (p.due === null ? [] : [{ c, due: p.due }]))).sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > Date.now()) await rest((next?.due ?? Infinity) - Date.now());
      else await queue(at(next.c.person, next.c.source), async () => {
        await slice(next.c.person, next.c.source, Date.now() + SLICE_MS);
        const c = load(next.c.person, next.c.source);
        if (c && !c.compact && Object.values(c.parts).every(p => p.delta) && c.length > c.base * 1.25) await tidy(c);
      }).catch(e => (console.error('indexing', e), rest(60_000)));
    }
  })();
}
// For the tests, which stop the worker between their steps, once what it's doing ends.
export function stopIndexing(): Promise<void> {
  stopping = true;
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
      name: c.name, source: c.source, kind: ({ item: 'folder', onedrive: 'OneDrive', site: 'site', mail: 'mailbox' } as Record<string, string>)[kind(c.source)[0]], items: c.lines, bytes: c.length,
      people: [{
        who: c.person, phase: ps.every(p => p.delta) ? 'follow' : 'crawl', pages: ps.reduce((n, p) => n + p.pages, 0),
        caught_up: ps.length && ps.every(p => p.as_of) ? ps.map(p => p.as_of!).sort()[0] : null, error: err?.error ?? null, retry_at: err?.due ? new Date(err.due).toISOString() : null,
      }],
    };
  });
}
