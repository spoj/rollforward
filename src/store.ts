import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, join, posix, sep } from 'node:path';
import { appendLine, changes, replaceFile, tree } from './system.ts';
import { authorityTree, checkSeriesAuthority } from './authority-format.ts';
import { appendMessage, deletedEntry, eventsFile, installMessageBooks, instanceAnchor, instanceMessage, instanceProjection, jsonLines, messagesAt, projectInstance, purgeMessages, readBook, readEntries, readMessages, startMessageStore, type Book, type Projection, type TornTails } from './message-store.ts';
import { commit, committed, pack, type Who } from './git.ts';
import { seriesSettings } from './series.ts';
import { answered } from './messages.ts';

// Paths in the screen are /-separated on every system.
const normalize = posix.normalize;

// Writes a read-only file whole, by renaming a temporary file into place, the one a write cut short left removed first. Windows
// refuses to rename over a read-only file, so there the old one is made writable first.
export function replaceReadOnly(path: string, data: string | Buffer) {
  rmSync(path + '.tmp', { force: true });
  writeFileSync(path + '.tmp', data, { mode: 0o444 });
  if (process.platform === 'win32' && existsSync(path)) chmodSync(path, 0o644);
  renameSync(path + '.tmp', path);
}

// Opens `rel` under `base` where a run may have put anything: only a regular file reached without a link, else undefined. A `rel`
// that isn't normal or climbs with .. names nothing. The real path of what was opened is checked, so a folder swapped for a link
// meanwhile is refused too; and what a run made unreadable, or changed as it was opened, is none either.
export function openFile(base: string, rel: string): number | undefined {
  if (normalize(rel) !== rel || rel.split('/').includes('..')) return undefined;
  const path = join(base, rel);
  try {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (fstatSync(fd).isFile() && readlinkSync(`/proc/self/fd/${fd}`) === join(realpathSync(base), rel)) return fd;
    closeSync(fd);
  } catch (e) {
    if (!['EACCES', 'ELOOP', 'ENAMETOOLONG', 'ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code!)) throw e;
  }
}

export function readFile(base: string, rel: string): string | undefined {
  const fd = openFile(base, rel);
  if (fd === undefined) return undefined;
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

// What a deleted instance keeps of its folder.
const HOLE = ['instance.json', 'screen.json', 'log.jsonl'];

// Removes what a run may have left anything in, by its name's bytes, as a name needn't be UTF-8, and never through a link: a folder
// it made unreadable or unwritable is the server's own, so is opened up first.
const O_PATH = 0o10000000;
export function wipe(path: Buffer) {
  let p: number;
  try { p = openSync(path, O_PATH | constants.O_NOFOLLOW); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  let dfd = -1;
  try {
    const st = fstatSync(p), self = `/proc/self/fd/${p}`;
    if (st.isDirectory()) {
      if ((st.mode & 0o700) !== 0o700) chmodSync(self, (st.mode | 0o700) & 0o7777);
      dfd = openSync(self, constants.O_RDONLY | constants.O_DIRECTORY);
    }
  } finally { closeSync(p); }
  if (dfd < 0) return unlinkSync(path);
  try {
    const stack = [{ name: Buffer.alloc(0), names: readdirSync(`/proc/self/fd/${dfd}`, { encoding: 'buffer' }), stat: fstatSync(dfd) }];
    while (stack.length) {
      const frame = stack.at(-1)!, name = frame.names.pop();
      if (name) {
        const at = Buffer.concat([Buffer.from(`/proc/self/fd/${dfd}/`), name]);
        const p = openSync(at, O_PATH | constants.O_NOFOLLOW);
        let sub = -1;
        try {
          const st = fstatSync(p), self = `/proc/self/fd/${p}`;
          if (st.isDirectory()) {
            if ((st.mode & 0o700) !== 0o700) chmodSync(self, (st.mode | 0o700) & 0o7777);
            sub = openSync(self, constants.O_RDONLY | constants.O_DIRECTORY);
          }
        } finally { closeSync(p); }
        if (sub < 0) { unlinkSync(at); continue; }
        try {
          stack.push({ name, names: readdirSync(`/proc/self/fd/${sub}`, { encoding: 'buffer' }), stat: fstatSync(sub) });
        } catch (e) { closeSync(sub); throw e; }
        closeSync(dfd);
        dfd = sub;
      } else {
        if (stack.length === 1) break;
        const child = stack.pop()!, parent = openSync(`/proc/self/fd/${dfd}/..`, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          const st = fstatSync(parent), expected = stack.at(-1)!.stat;
          if (st.dev !== expected.dev || st.ino !== expected.ino) throw new Error('a folder moved during deletion');
        } catch (e) { closeSync(parent); throw e; }
        closeSync(dfd);
        dfd = parent;
        rmdirSync(Buffer.concat([Buffer.from(`/proc/self/fd/${dfd}/`), child.name]));
      }
    }
  } finally { closeSync(dfd); }
  rmdirSync(path);
}

export type Item = { id: string; name: string; kind: 'input' | 'step' | 'output'; file: string | null; from?: string[]; headline?: string; source?: string; destination?: string };
export type Doc = { rev: number; status: 'open' | 'closed' | 'abandoned' | 'deleted'; items: Item[] };
export type Entry = { seq: number; at: string; by: string; op: string; [k: string]: unknown };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The instance index comes from instances/<id>/instance.json. The private canonical logs live outside those mounted instance
// folders, under series/<id>/.
export type Meta = { label: string; series: string };

let root = '';
let index = new Map<string, Meta>();
const cache = new Map<string, Instance>();

function readMetadata<T>(path: string): T | undefined {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (!st.isFile()) throw new Error(`${path}: not a regular metadata file`);
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch { throw new Error(`${path}: invalid metadata JSON`); }
}

function startupDirectory(path: string) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) throw new Error(`${path}: not a directory`);
  return readdirSync(path, { withFileTypes: true });
}

function readScreen(dir: string): Doc {
  const path = join(dir, 'screen.json'), doc = readMetadata<Doc>(path);
  if (doc === undefined) return { rev: 0, status: 'open', items: [] };
  if (!doc || !Number.isSafeInteger(doc.rev) || doc.rev < 0 || !['open', 'closed', 'abandoned', 'deleted'].includes(doc.status) || !Array.isArray(doc.items))
    throw new Error(`${path}: invalid screen metadata`);
  return doc;
}

const initialScreen = JSON.stringify({ rev: 1, status: 'open', items: [] }, null, 1);
const createFolders = ['upload', 'working'];

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function openStore(dataRoot: string, beforeRepair?: () => void) {
  const manifest = readMetadata<unknown>(join(dataRoot, '.rf', 'tree.json'));
  const authority = manifest === undefined ? undefined : authorityTree(manifest), series = authority?.series ?? {};
  if (authority) checkSeriesAuthority(dataRoot, authority);
  const folders = join(dataRoot, 'instances'), seriesRoot = join(dataRoot, 'series');
  const metas = new Map<string, Meta>(), uncreated: string[] = [], emptyEventDirs: string[] = [], tails: TornTails = new Map();
  const orphanCandidates: { id: string; sid: string; source: string }[] = [];
  for (const d of startupDirectory(folders)) {
    const dir = join(folders, d.name), path = join(dir, 'instance.json');
    const m = d.isDirectory() ? readMetadata<Meta>(path) : undefined;
    if (m === undefined) {
      uncreated.push(dir);
      continue;
    }
    if (!/^[\w-]+$/.test(d.name) || typeof m?.series !== 'string' || !/^[\w-]+$/.test(m.series) || typeof m.label !== 'string')
      throw new Error(`${path}: invalid instance metadata`);
    metas.set(d.name, m);
  }
  const loaded = new Map<string, Book>(), ids = new Set([...Object.keys(series), ...Array.from(metas.values(), m => m.series)]);
  for (const d of startupDirectory(seriesRoot)) {
    const dir = join(seriesRoot, d.name);
    if (!d.isDirectory() || !/^[\w-]+$/.test(d.name)) throw new Error(`${dir}: invalid series directory`);
    if (!ids.has(d.name) && readdirSync(dir, { withFileTypes: true }).some(e => !(e.name === '.pylib' && e.isDirectory()))) ids.add(d.name);
  }
  for (const sid of ids) {
    const dir = join(seriesRoot, sid), b = readBook(dir, readMessages(dir, tails));
    for (const m of b.messages) {
      if (m.anchor.instance && metas.get(m.anchor.instance)?.series !== sid)
        throw new Error(`${dir}: message ${m.id} anchors to an unknown instance`);
      if (m.entry.op === 'request' && typeof m.entry.source === 'string' && !metas.has(m.entry.source))
        throw new Error(`${dir}: request ${m.id} names an unknown source instance`);
    }
    for (const d of startupDirectory(join(dir, 'events'))) {
      const path = eventsFile(dir, d.name), meta = metas.get(d.name);
      if (d.isDirectory() && meta?.series === sid) continue;
      if (d.isDirectory() && !meta) {
        const files = startupDirectory(dirname(path));
        if (files.every(f => f.name === 'events.jsonl.tmp' && f.isFile())) {
          if (!files.length) emptyEventDirs.push(dirname(path));
          continue;
        }
        if (files.length === 1 && files[0].name === 'events.jsonl' && files[0].isFile()) {
          orphanCandidates.push({ id: d.name, sid, source: path });
          continue;
        }
      }
      throw new Error(`${path}: no matching instance.json metadata`);
    }
    loaded.set(dir, b);
  }
  const replayed = new Map<string, { doc: Doc; log: Entry[] }>(), redacted = new Map<string, Entry>();
  for (const [id, m] of metas) {
    const dir = join(seriesRoot, m.series), path = eventsFile(dir, id), events = readEntries(path, tails);
    const log = projectInstance(path, events, loaded.get(dir)!.byInstance.get(id) ?? []);
    if (log[0].op === 'delete' && log[0] !== events[0]) redacted.set(path, log[0]);
    replayed.set(id, { doc: readScreen(join(folders, id)), log });
  }

  // Publication moves this exact scratch folder away. A lone create row without that evidence is not safe to drop.
  const scratch = join(dataRoot, '.tmp');
  for (const { id, sid, source } of orphanCandidates) {
    const invalid = new Error(`${source}: no matching instance.json metadata or unpublished create`), stage = join(scratch, id);
    if (!/^[a-f0-9]{12}$/.test(id) || lstatSync(join(folders, id), { throwIfNoEntry: false })) throw invalid;
    if (!lstatSync(scratch, { throwIfNoEntry: false })?.isDirectory() || !lstatSync(stage, { throwIfNoEntry: false })?.isDirectory()) throw invalid;
    const names = new Set(readdirSync(stage));
    if (!['instance.json', 'screen.json', ...createFolders].every(name => names.delete(name)) || names.size > 1) throw invalid;
    const [projection] = names;
    if (projection !== undefined && projection !== 'log.jsonl' && projection !== 'log.jsonl.tmp') throw invalid;
    for (const name of createFolders) {
      const path = join(stage, name);
      if (!lstatSync(path).isDirectory() || readdirSync(path).length) throw invalid;
    }
    const m = readMetadata<Meta>(join(stage, 'instance.json')), screen = join(stage, 'screen.json');
    if (m?.series !== sid || typeof m.label !== 'string' || !m.label || Object.keys(m).length !== 2) throw invalid;
    if (!lstatSync(screen).isFile() || readFileSync(screen, 'utf8') !== initialScreen) throw invalid;
    // Even a torn second row could be history; don't pass the tail repair map.
    const events = readEntries(source), [e] = events;
    if (events.length !== 1 || e.seq !== 1 || e.op !== 'create' || Object.keys(e).length !== 4) throw invalid;
    if (projection) {
      const path = join(stage, projection);
      if (!lstatSync(path).isFile()) throw invalid;
      const bytes = readFileSync(path), initialLog = Buffer.from(jsonLines(events));
      if (!(projection.endsWith('.tmp') ? initialLog.subarray(0, bytes.length) : initialLog).equals(bytes)) throw invalid;
    }
  }

  const emptyCreateDirs = uncreated.map(dir => {
    const path = join(dir, 'instance.json');
    if (!lstatSync(dir).isDirectory()) throw new Error(`${path}: no instance metadata`);
    const children = startupDirectory(dir);
    if (children.some(d => !createFolders.includes(d.name) || !d.isDirectory() || readdirSync(join(dir, d.name)).length))
      throw new Error(`${path}: no instance metadata; folder is not empty`);
    return [dir, children.map(d => join(dir, d.name))] as const;
  });

  // A bad stream anywhere must not change even a recoverable stream elsewhere.
  beforeRepair?.();
  for (const dir of [folders, seriesRoot, join(dataRoot, 'agents')]) mkdirSync(dir, { recursive: true });
  for (const [path, { end, dropped }] of tails) {
    truncateSync(path, end);
    console.error(`${path}: dropped a torn last line, ${dropped} bytes`);
  }
  for (const [path, tombstone] of redacted) replaceFile(path, jsonLines([tombstone]), true);
  // The server can clear .tmp only once removal is durable, even after an interrupted repair.
  for (const dir of emptyEventDirs) syncDirectory(dir);
  for (const { source } of orphanCandidates) {
    unlinkSync(source);
    syncDirectory(dirname(source));
    console.error(`${source}: removed an unpublished create event`);
  }
  for (const [dir, children] of emptyCreateDirs) {
    for (const child of children) rmdirSync(child);
    rmdirSync(dir);
    console.error(`${dir}: removed an uncreated instance`);
  }
  root = dataRoot;
  index = metas;
  cache.clear();
  installMessageBooks(loaded);
  for (const [id, state] of replayed) cache.set(id, new Instance(instanceDir(id), state));
  for (const inst of cache.values()) {
    if (inst.hole) inst.clear(Object.hasOwn(series, inst.seriesId) && !!series[inst.seriesId].single);
    else inst.syncLog();
  }
  for (const b of loaded.values()) b.notes.sync();
}

export const newId = () => randomBytes(6).toString('hex');
export const seriesDir = (id: string) => join(root, 'series', id);
export const instanceDir = (id: string) => join(root, 'instances', id);
// AGENTS.md files: agents/company.md, the admins', and agents/<workspace id>.md, each workspace's owners'.
export const agentsFile = (id = 'company') => join(root, 'agents', `${id}.md`);

export function instance(id: string): Instance {
  const inst = cache.get(id);
  if (!inst) throw new HttpError(404, `no instance ${id}`);
  return inst;
}

export function syncInstanceLog(dir: string) {
  const inst = cache.get(basename(dir));
  if (inst?.dir === dir) inst.syncLog();
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'en', { numeric: true });

// A series' instances, by label, from the index.
export function labels(seriesId: string): { id: string; label: string }[] {
  return [...index].filter(([, m]) => m.series === seriesId).map(([id, m]) => ({ id, label: m.label })).sort(byLabel);
}

export function instances(seriesId: string): Instance[] {
  return labels(seriesId).map(l => instance(l.id));
}

// Each series' instances as `instances` gives them, from one pass over the index, for what lists many series at once; a series'
// are sorted only once it's asked for.
export function instancesBySeries(): (seriesId: string) => Instance[] {
  const by = new Map<string, { id: string; label: string }[]>(), sorted = new Set<string>();
  for (const [id, m] of index) {
    const ls = by.get(m.series);
    if (ls) ls.push({ id, label: m.label });
    else by.set(m.series, [{ id, label: m.label }]);
  }
  return seriesId => {
    const ls = by.get(seriesId) ?? [];
    if (!sorted.has(seriesId)) { ls.sort(byLabel); sorted.add(seriesId); }
    return ls.map(l => instance(l.id));
  };
}

// The closed instances of its series before it, by label: the examples it rolls forward from.
export const closedBefore = (inst: Instance) => instances(inst.seriesId).filter(i => i.doc.status === 'closed' && i.label.localeCompare(inst.label, 'en', { numeric: true }) < 0);

// A workspace's, a series' or an instance's name is a folder's in a run's view, which holds 255 bytes: one over 200 is refused, leaving
// room for a number freeName() adds.
export function folderName(s: string): string {
  const name = safeName(s);
  if (Buffer.byteLength(name) > 200) throw new HttpError(400, `a name is 200 bytes at most, about 66 Chinese characters, not ${Buffer.byteLength(name)}`);
  return name;
}

// A name is a folder's in a run's view, a line of names.tsv: no slash, control character or line break, which a reader such as
// Python's splitlines() would split it at; and not AGENTS.md, where the instructions the view binds go.
export function safeName(s: string): string {
  const name = s.replace(/[/\\\x00-\x1f\x7f\x85\u2028\u2029]/g, '_');
  if (!name) throw new HttpError(400, 'a name is needed');
  if (name.startsWith('.')) throw new HttpError(400, `a name can't start with a dot: ${s}`);
  if (name === 'AGENTS.md') throw new HttpError(400, "AGENTS.md is the name of the agents' instructions: choose another");
  return name;
}

// Keeps a person's file in folder/ under dir, read-only, under its own name made unique, its stem cut short where the name would
// pass the 255 bytes a file's name holds; answers its path there.
export function keep(dir: string, folder: string, name: string, tmp: string): string {
  const clean = safeName(name), raw = extname(clean), ext = Buffer.byteLength(raw) <= 20 && raw.length < clean.length ? raw : '', stem = clean.slice(0, clean.length - ext.length);
  const fit = (suffix: string) => {
    let s = '';
    for (const c of stem) if (Buffer.byteLength(s + c + suffix + ext) <= 255) s += c; else break;
    return `${folder}/${s}${suffix}${ext}`;
  };
  mkdirSync(join(dir, folder), { recursive: true });
  let file = fit('');
  for (let n = 2; file === 'upload/attachments' || existsSync(join(dir, file)); n++) file = fit(`_${n}`);
  renameSync(tmp, join(dir, file));
  chmodSync(join(dir, file), 0o444);
  return file;
}

function setMeta(id: string, meta: Meta) {
  replaceReadOnly(join(instanceDir(id), 'instance.json'), JSON.stringify(meta));
  index.set(id, meta);
  changes.emit('change', 'tree');
}

function freeLabel(seriesId: string, label: string): string {
  const name = folderName(label);
  if (labels(seriesId).some(l => l.label === name)) throw new HttpError(409, `${name} exists`);
  return name;
}

// A new instance starts empty. Its creator is recorded separately from its series owner.
export function createInstance(seriesId: string, label: string, by: string): Instance {
  const name = freeLabel(seriesId, label), id = newId(), stage = join(root, '.tmp', id), dir = instanceDir(id), meta = { label: name, series: seriesId };
  const book = seriesDir(seriesId), source = eventsFile(book, id), events = dirname(dirname(source)), scratch = dirname(stage);
  if (!existsSync(book)) startMessageStore(book);
  messagesAt(book);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(stage);
  const create = jsonLines([{ seq: 1, at: new Date().toISOString(), by, op: 'create' }]);
  try {
    for (const name of createFolders) mkdirSync(join(stage, name));
    writeFileSync(join(stage, 'instance.json'), JSON.stringify(meta), { mode: 0o444, flush: true });
    writeFileSync(join(stage, 'screen.json'), initialScreen, { mode: 0o444, flush: true });
    writeFileSync(join(stage, 'log.jsonl'), create, { mode: 0o600, flush: true });
    mkdirSync(events, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(source), { mode: 0o700 });
    // Make the scratch proof and all parent links durable before publishing a canonical event.
    for (const path of [stage, scratch, events, book, dirname(book), realpathSync(root)]) syncDirectory(path);
  } catch (e) {
    wipe(Buffer.from(stage));
    throw e;
  }
  // Once the source rename can have happened, leave its staging proof on failure.
  replaceFile(source, create, true);
  renameSync(stage, dir);
  syncDirectory(dirname(dir));
  syncDirectory(scratch);
  index.set(id, meta);
  const inst = new Instance(dir);
  inst.syncLog();
  cache.set(id, inst);
  changes.emit('change', 'tree');
  changes.emit('change', id);
  return inst;
}

export function renameInstance(inst: Instance, label: string) {
  setMeta(inst.id, { ...inst.meta, label: freeLabel(inst.seriesId, label) });
}

export class Instance {
  dir: string;
  id: string;
  doc: Doc;
  private projection: Projection;
  get log(): Entry[] { return this.projection.entries; }
  // What `copied` answers, kept as the log changes rather than found on each read: the sidebar and the page read it for each entry
  // of a log thousands long.
  private copiedSeq: number;
  closing = false;

  constructor(dir: string, state?: { doc: Doc; log: Entry[] }) {
    this.dir = dir;
    this.id = basename(dir);
    this.doc = state?.doc ?? readScreen(dir);
    this.projection = instanceProjection(this.series(), this.id, join(dir, 'log.jsonl'), state?.log);
    this.copiedSeq = this.log.findLast(e => e.op === 'duplicate')?.seq ?? 0;
    if (this.hole) this.doc = { rev: this.doc.rev, status: 'deleted', items: [] };
  }

  syncLog() { this.projection.sync(); }

  // Deleted: its log is its delete entry alone.
  get hole(): boolean {
    return this.log[0]?.op === 'delete';
  }

  append(by: string, op: string, fields: Record<string, unknown> = {}): Entry {
    // Nothing more is said of a deleted instance, such as by a run its deletion cut, as it ends.
    if (this.hole) return { seq: 0, at: new Date().toISOString(), by, op, ...fields };
    const s = ['upload', 'comment', 'signoff', 'reject'].includes(op) && by.includes('@') ? seriesSettings(this.series()) : undefined;
    const e = { seq: this.log.length + 1, at: new Date().toISOString(), by, op, ...fields, ...(s && { authorityOwner: s.owner ?? null, ...(s.consent && s.consent.by === s.owner && s.consent.workspace === tree().series[this.seriesId].workspace && { authorityEpoch: s.epoch }) }) };
    if (instanceMessage(e)) return appendMessage(this.series(), instanceAnchor(this.id, e, this.log), e).entry;
    appendLine(eventsFile(this.series(), this.id), JSON.stringify(e), 0o600);
    if (e.op === 'duplicate') this.copiedSeq = e.seq;
    this.projection.update(e);
    changes.emit('change', this.id);
    return e;
  }

  save() {
    this.doc.rev++;
    replaceReadOnly(join(this.dir, 'screen.json'), JSON.stringify(this.doc, null, 1));
    changes.emit('change', this.id);
  }

  // Keeps a person's file under folder/ of upload/, read-only, under its own name made unique; answers its path in the instance.
  keep(name: string, tmp: string, folder = 'upload'): string {
    if (this.doc.status !== 'open') throw new HttpError(409, 'the instance was closed during the upload');
    return keep(this.dir, folder, name, tmp);
  }

  upload(by: string, name: string, tmp: string, sha256: string, pane: 'in' | 'out', onto: string | null, quiet: boolean): Entry {
    const file = this.keep(name, tmp), clean = safeName(name), raw = extname(clean), stem = clean.slice(0, clean.length - (Buffer.byteLength(raw) <= 20 && raw.length < clean.length ? raw.length : 0));
    const up = this.append(by, 'upload', { file, pane, onto, sha256, ...(quiet && { quiet: true }) });
    let id = `u${up.seq}`;
    for (let n = 2; this.doc.items.some(i => i.id === id); n++) id = `u${up.seq}_${n}`;
    this.doc.items.push({ id, name: stem, kind: pane === 'in' ? 'input' : 'output', file });
    this.append('server', 'point', { item: id, file, cause: up.seq });
    this.save();
    return up;
  }

  // Its threads' ids. A comment starts a thread, on an item (at a ref) or on the instance, its id c and its seq, and later comments
  // reply under one of its comments, their parent.
  threads(): string[] {
    return [...new Set(this.log.filter(e => e.op === 'comment').map(e => e.thread as string))];
  }

  // The agent's asks still waiting on people: those no one answered.
  asking(owner?: string): Entry[] {
    const from = this.copied;
    return this.log.filter(e => e.seq > from && e.op === 'comment' && e.by === 'agent' && e.ask && !answered(this.log, e, this.log.length, owner));
  }

  // Closing makes the instance the period's record and an example for the next, approving nothing: the asks still waiting are
  // accepted as the agent said it did them. It commits the folder in the series owner's name. The instance is closed meanwhile, so nothing
  // changes it, but saved only once committed and packed: either failing, or a restart, leaves it open.
  async close(by: Who) {
    const accepted = this.asking(by.email).map(e => `c${e.seq}`);
    this.doc.status = 'closed';
    this.closing = true;
    let hash: string;
    try {
      await committed(this.dir);
      for (const i of this.doc.items) if (i.file !== null) {
        const fd = openFile(this.dir, i.file);
        if (fd === undefined) throw new HttpError(409, `${i.id}: no file ${i.file}`);
        closeSync(fd);
      }
      hash = await commit(this.dir, by, `Close ${this.label}`);
      await pack(this.dir);
    } catch (e) {
      if (!this.hole) this.doc.status = 'open';
      throw e;
    } finally {
      this.closing = false;
    }
    if (this.hole) throw new HttpError(409, `${this.label} was deleted during the close`);
    this.save();
    this.append(by.email, 'close', { ...(accepted.length && { accepted }), commit: hash });
  }

  async abandon(by: string) {
    this.closing = true;
    try {
      await committed(this.dir);
    } finally {
      this.closing = false;
    }
    if (this.hole) throw new HttpError(409, `${this.label} was deleted`);
    this.doc.status = 'abandoned';
    this.save();
    this.append(by, 'abandon');
  }

  // The tombstone precedes waiting for runs and commits: a restart finishes clearing the folder.
  markDeleted(by: string, fields: Record<string, unknown>): Entry {
    const e = deletedEntry({ ...fields, seq: this.log.length + 1, at: new Date().toISOString(), by, op: 'delete' });
    replaceFile(eventsFile(this.series(), this.id), jsonLines([e]), true);
    this.copiedSeq = 0;
    this.doc = { rev: this.doc.rev, status: 'deleted', items: [] };
    this.projection.update([e]);
    purgeMessages(this.series(), this.id, this.label, !!tree().series[this.seriesId]?.single);
    return e;
  }

  clear(task = !!tree().series[this.seriesId]?.single) {
    purgeMessages(this.series(), this.id, this.label, task);
    this.syncLog();
    const was = readScreen(this.dir);
    if (was.status !== 'deleted' || was.items.length) {
      this.doc = { rev: this.doc.rev, status: 'deleted', items: [] };
      this.save();
    }
    for (const name of readdirSync(this.dir, { encoding: 'buffer' })) if (!HOLE.includes(name.toString('latin1'))) wipe(Buffer.concat([Buffer.from(this.dir + sep), name]));
    if (task) for (const name of ['.pylib', 'notes']) wipe(Buffer.from(join(this.series(), name)));
  }

  put(text: string, run: number) {
    let doc: Doc;
    try { doc = JSON.parse(text); } catch (e) { throw new HttpError(400, `not JSON: ${(e as Error).message}`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'screen must be an object');
    if (doc.rev == null) throw new HttpError(400, 'missing rev: take it from rf show and merge');
    if (doc.rev !== this.doc.rev) throw new HttpError(409, `stale rev ${doc.rev}: each put and upload moves the screen on: run rf show and merge`);
    if (doc.status !== undefined && doc.status !== this.doc.status) throw new HttpError(400, 'status is set by the server; leave it out or as it is');
    if (!Array.isArray(doc.items)) throw new HttpError(400, 'items must be an array');
    const errors: string[] = [], ids = new Set<string>();
    const old = new Map(this.doc.items.map(i => [i.id, i]));
    for (const i of doc.items) {
      if (!i || typeof i !== 'object' || Array.isArray(i)) { errors.push('each item must be an object'); continue; }
      if (typeof i.id !== 'string' || !i.id || ids.has(i.id)) errors.push(`item id missing or repeated: ${JSON.stringify(i.id)}`);
      ids.add(i.id);
      if (typeof i.name !== 'string' || !i.name) errors.push(`${i.id}: name missing`);
      if (!['input', 'step', 'output'].includes(i.kind)) errors.push(`${i.id}: kind must be "input", "step" or "output"`);
      for (const k of ['headline', 'source', 'destination', 'from'] as const) if ((i as Record<string, unknown>)[k] === null) delete i[k];
      if (i.from !== undefined && !Array.isArray(i.from)) errors.push(`${i.id}: from must be a list of item ids`);
      for (const k of ['headline', 'source', 'destination'] as const) if (i[k] !== undefined && typeof i[k] !== 'string') errors.push(`${i.id}: ${k} must be a string`);
      if (i.file !== null) {
        const ok = typeof i.file === 'string' && normalize(i.file) === i.file && /^(upload|working)\/./.test(i.file) && !i.file.split('/').includes('..');
        if (!ok) errors.push(`${i.id}: file must be null or a path under upload/ or working/, relative to the instance folder`);
        else {
          const fd = openFile(this.dir, i.file);
          if (fd === undefined) errors.push(`${i.id}: no file ${i.file} (links are not followed)`);
          else closeSync(fd);
        }
      }
    }
    const from = new Map(doc.items.filter(i => i && typeof i === 'object' && !Array.isArray(i)).map(i => [i.id, Array.isArray(i.from) ? i.from : []]));
    for (const [id, fs] of from) for (const f of fs) if (!from.has(f)) errors.push(`${id}: from names no item ${JSON.stringify(f)}`);
    for (let peeled = true; peeled;) {
      peeled = false;
      for (const [id, fs] of from) if (!fs.some(f => from.has(f))) peeled = from.delete(id);
    }
    if (from.size) errors.push(`from goes round in a circle among ${[...from.keys()].join(', ')}`);
    if (errors.length) throw new HttpError(400, errors.join('\n'));

    for (const i of doc.items) {
      const o = old.get(i.id);
      if (i.file !== (o?.file ?? null) && i.file !== null) {
        this.append('agent', 'point', { run, item: i.id, file: i.file, was: o?.file ?? null });
      } else if (i.file === null && o?.file) this.append('agent', 'point', { run, item: i.id, file: null, was: o.file });
      if (!o || o.name !== i.name || o.kind !== i.kind || JSON.stringify(o.from) !== JSON.stringify(i.from) || o.headline !== i.headline || o.source !== i.source || o.destination !== i.destination)
        this.append('agent', 'item', { run, item: i.id, name: i.name, kind: i.kind, from: i.from, headline: i.headline, source: i.source, destination: i.destination });
    }
    for (const o of this.doc.items) if (!ids.has(o.id)) this.append('agent', 'remove', { run, item: o.id });
    this.doc = { rev: this.doc.rev, status: this.doc.status, items: doc.items };
    this.save();
    return this.doc.rev;
  }

  // A copy, which earlier versions made, starts its own history at its latest duplicate entry: what came before is the copied
  // instance's, settled, pending nothing.
  get copied(): number {
    return this.copiedSeq;
  }

  get meta(): Meta {
    return index.get(this.id)!;
  }

  get label(): string {
    return this.meta.label;
  }

  get seriesId(): string {
    return this.meta.series;
  }

  series(): string {
    return seriesDir(this.seriesId);
  }
}
