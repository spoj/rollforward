import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Entry } from './store.ts';
import { appendLine, changes, replaceFile } from './system.ts';

export type MessageAnchor = { instance?: string; item?: string; ref?: string };
export type StoredMessage = { id: number; anchor: MessageAnchor; kind: string; entry: Entry; legacyOpen?: true };

export const instanceMessage = (e: Entry) => ['comment', 'signoff', 'reject', 'withdraw', 'wake-check', 'settle'].includes(e.op) || e.op === 'wake' && typeof e.check === 'string';
export const seriesNote = (op: string) => ['note', 'taken', 'aside'].includes(op);
export const unprojectedMessage = (op: string) => ['request', 'request-decision', 'dismiss-note', 'note-verdict'].includes(op);
export const eventsFile = (dir: string, instance: string) => join(dir, 'events', instance, 'events.jsonl');
export const messagesFile = (dir: string) => join(dir, 'messages.jsonl');
export const notesFile = (dir: string) => join(dir, 'notes', 'log.jsonl');
export const messageFloor = (dir: string) => join(dir, 'messages.floor');
export const jsonLines = (entries: readonly unknown[]) => entries.map(e => safeEntryJson(e) + '\n').join('');
export function safeEntryJson(value: unknown): string {
  const check = (_k: string, v: unknown) => {
    if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))))
      throw new Error('unrepresentable number in canonical log entry');
    return v;
  };
  const raw = JSON.stringify(value, check);
  JSON.parse(raw, check);
  return raw;
}
const object = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o);
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

function kindOf(e: Entry) {
  if (e.op === 'comment') return e.ask === 'proposal' ? 'propose' : e.ask ? 'ask' : 'comment';
  if (e.op === 'signoff') return e.approved === false ? 'reject' : 'approve';
  if (e.op === 'wake-check' || e.op === 'wake' && e.check) return 'check';
  if (e.op === 'note') return 'comment';
  if (seriesNote(e.op) || e.op === 'note-verdict') return 'settle';
  return e.op;
}

export const storedMessage = (id: number, anchor: MessageAnchor, entry: Entry, legacyOpen?: true): StoredMessage =>
  ({ id, anchor, kind: kindOf(entry), entry, ...(legacyOpen && { legacyOpen }) });

// Decisions and nested replies inherit the tile/cell without changing the old entry or what its numeric links mean.
export function instanceAnchor(instance: string, e: Entry, previous: readonly Entry[]): MessageAnchor {
  let target = e;
  while (target.item === undefined && target.ref === undefined) {
    const parent = target.parent ?? target.on;
    const next = typeof parent === 'number' ? previous[parent - 1]
      : target.thread ? previous.find(p => p.op === 'comment' && p.thread === target.thread) : undefined;
    if (!next || next.op !== 'comment' || next.seq >= target.seq) break;
    target = next;
  }
  return { instance, ...(typeof target.item === 'string' && { item: target.item }), ...(typeof target.ref === 'string' && { ref: target.ref }) };
}

export type TornTails = Map<string, { end: number; dropped: number }>;

function rows(path: string, tails?: TornTails): unknown[] {
  if (!lstatSync(path).isFile()) throw new Error(`${path}: not a regular log`);
  const bytes = readFileSync(path), end = bytes.lastIndexOf(10) + 1;
  if (end !== bytes.length) {
    if (!tails) throw new Error(`${path}: torn last line`);
    tails.set(path, { end, dropped: bytes.length - end });
  }
  return parseLines(path, bytes.subarray(0, end));
}

function parseLines(path: string, bytes: Buffer): unknown[] {
  if (bytes.length && bytes.at(-1) !== 10) throw new Error(`${path}: torn last line`);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line, (_k, value) => {
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
        throw new Error('unrepresentable number');
      return value;
    })) : [];
  } catch {
    throw new Error(`${path}: invalid JSONL`);
  }
}

function entry(o: unknown, where: string): asserts o is Entry {
  if (!object(o) || !positive(o.seq) || typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at))
    || typeof o.by !== 'string' || !o.by || typeof o.op !== 'string' || !o.op)
    throw new Error(`${where}: invalid log entry`);
}

export function readEntries(path: string, tails?: TornTails): Entry[] {
  return rows(path, tails).map((e, i) => {
    entry(e, `${path}:${i + 1}`);
    return e;
  });
}

const pathIsSafe = (p: unknown): p is string => typeof p === 'string' && posix.normalize(p) === p
  && !p.startsWith('/') && !p.endsWith('/') && !p.split('/').includes('..') && !/[\0\\]/.test(p);
const instancePath = (p: unknown): p is string => pathIsSafe(p) && /^(upload|working)\/.+/.test(p);
const legacySiblingPath = (p: unknown): p is string => {
  if (typeof p !== 'string' || !p.startsWith('../') || posix.normalize(p) !== p) return false;
  const rest = p.slice(3), slash = rest.indexOf('/');
  return slash > 0 && rest.slice(0, slash) !== '.' && pathIsSafe(rest.slice(0, slash)) && instancePath(rest.slice(slash + 1));
};
type InstanceFile = string | { inst: string; path: string; sha256?: string };

function instanceFile(f: unknown): f is InstanceFile {
  return instancePath(f) || object(f) && Object.keys(f).every(k => ['inst', 'path', 'sha256'].includes(k))
    && typeof f.inst === 'string' && /^[\w-]+$/.test(f.inst) && instancePath(f.path)
    && (f.sha256 === undefined || typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(f.sha256));
}

// A legacy pin can survive its source's removal or loss of reach. Keep it in history, not in a private prompt.
export function visibleInstanceFiles(e: Entry, instance: string, canRead: (id: string, path: string) => boolean): InstanceFile[] {
  return Array.isArray(e.files) ? e.files.filter(f => instanceFile(f) &&
    (typeof f === 'string' ? canRead(instance, f) : canRead(f.inst, f.path))) : [];
}

export function validateMessage(m: unknown, where: string, live = false): asserts m is StoredMessage {
  if (!object(m) || Object.keys(m).some(k => !['id', 'anchor', 'kind', 'entry', 'legacyOpen'].includes(k)) || !positive(m.id) || !object(m.anchor)
    || Object.keys(m.anchor).some(k => !['instance', 'item', 'ref'].includes(k))
    || (m.anchor.instance !== undefined && (typeof m.anchor.instance !== 'string' || !/^[\w-]+$/.test(m.anchor.instance)))
    || (m.anchor.item !== undefined && (typeof m.anchor.item !== 'string' || !m.anchor.item || !m.anchor.instance))
    || (m.anchor.ref !== undefined && (typeof m.anchor.ref !== 'string' || !m.anchor.instance)))
    throw new Error(`${where}: invalid message envelope or anchor`);
  entry(m.entry, where);
  const e = m.entry, local = instanceMessage(e), note = seriesNote(e.op);
  if (m.kind !== kindOf(e) || (!local && !note && !unprojectedMessage(e.op)) || (local && !m.anchor.instance) || (note && m.anchor.instance))
    throw new Error(`${where}: invalid message kind or scope`);
  if (Object.hasOwn(m, 'legacyOpen') && (m.legacyOpen !== true || e.op !== 'comment' || e.ask))
    throw new Error(`${where}: invalid legacy open note`);
  if (e.op === 'note-verdict' && (m.anchor.instance || e.seq !== 1 || !positive(e.on) || !['taken', 'aside'].includes(e.how as string)
    || Object.keys(e).some(k => !['seq', 'at', 'by', 'op', 'on', 'how'].includes(k))))
    throw new Error(`${where}: invalid series note verdict`);
  if ((e.op === 'request' || e.op === 'request-decision') && (e.seq !== 1 || typeof e.requestId !== 'string' || !/^[\w-]+$/.test(e.requestId)
    || (e.op === 'request' ? typeof e.from !== 'string' || !e.from || typeof e.label !== 'string' || !e.label
      || (e.source !== undefined && (typeof e.source !== 'string' || !/^[\w-]+$/.test(e.source)))
      : !positive(e.request) || !['started', 'dismissed'].includes(e.how as string))))
    throw new Error(`${where}: invalid request entry`);
  if ((e.text !== undefined && typeof e.text !== 'string') || ((e.op === 'comment' || note) && typeof e.text !== 'string')
    || (e.op === 'wake-check' && typeof e.message !== 'string'))
    throw new Error(`${where}: invalid message text`);
  if (e.files !== undefined && (!Array.isArray(e.files) || e.files.some(f => !(
    note ? pathIsSafe(f) && /^files\/[^/]+$/.test(f)
    : local && (live ? pathIsSafe(f) && /^upload\/attachments\/[^/]+$/.test(f) : instanceFile(f) || legacySiblingPath(f))))))
    throw new Error(`${where}: invalid message attachment`);
}

export function readMessages(dir: string, tails?: TornTails): StoredMessage[] {
  const path = messagesFile(dir);
  let id = 0;
  const byId = new Map<number, StoredMessage>();
  return rows(path, tails).map((m, i) => {
    validateMessage(m, `${path}:${i + 1}`);
    if (m.id <= id) throw new Error(`${path}:${i + 1}: message IDs out of order`);
    id = m.id;
    if (m.entry.op === 'request-decision') {
      // A decision can outlive its body, but cannot claim another message or a future ID.
      const on = m.entry.request as number, r = byId.get(on);
      if (on >= id || (r && (r.entry.op !== 'request' || r.entry.requestId !== m.entry.requestId || r.anchor.instance !== m.anchor.instance)))
        throw new Error(`${path}:${i + 1}: invalid request decision reference`);
    }
    byId.set(id, m);
    return m;
  });
}

export function deletedEntry(e: Entry): Entry {
  if (!Array.isArray(e.wakeChecks) || !e.wakeChecks.some(row => row && Object.hasOwn(row, 'message'))) return e;
  return { ...e, wakeChecks: e.wakeChecks.map(row => {
    const { message: _, ...audit } = row;
    return audit;
  }) };
}

export function validateInstanceLog(where: string, log: readonly Entry[]) {
  if (log[0]?.op === 'delete' && log.length === 1) return;
  if (log[0]?.op !== 'create') throw new Error(`${where}: missing create or tombstone`);
  // These two old audit ops used seq for a cross-instance link, not their own position.
  for (const [i, e] of log.entries()) if (e.op === 'delete' || (e.seq !== i + 1 && e.op !== 'said' && e.op !== 'corrected'))
    throw new Error(`${where}:${i + 1}: invalid instance sequence`);
}

export function projectInstance(where: string, events: readonly Entry[], messages: readonly StoredMessage[]): Entry[] {
  if (events.some(e => instanceMessage(e) || seriesNote(e.op) || unprojectedMessage(e.op))) throw new Error(`${where}: message in instance events`);
  if (events[0]?.op === 'delete') {
    validateInstanceLog(where, events);
    return [deletedEntry(events[0])];
  }
  const local = messages.filter(m => instanceMessage(m.entry)), log = Array<Entry>(events.length + local.length);
  let seq = 0;
  for (const { entry: e } of local) {
    if (e.seq > log.length || e.seq <= seq) throw new Error(`${where}: invalid message seq ${e.seq}`);
    log[(seq = e.seq) - 1] = e;
  }
  for (let i = 0, j = 0; i < log.length; i++) if (!log[i]) log[i] = events[j++];
  validateInstanceLog(where, log);
  return log;
}

function verdictTarget(e: Entry): number | undefined {
  if (e.op === 'note-verdict') return e.on as number;
  if (e.noteDecision === true && (e.op === 'signoff' || e.op === 'reject') && typeof e.noteFor === 'string' && /^n[1-9]\d*$/.test(e.noteFor))
    return Number(e.noteFor.slice(1));
}

export function projectNotes(where: string, messages: readonly StoredMessage[]): Entry[] {
  const notes: Entry[] = [];
  for (const { id, entry: e } of messages) {
    const on = verdictTarget(e);
    if (on !== undefined && notes[on - 1]?.op !== 'note') throw new Error(`${where}: invalid series note verdict on message ${id}`);
    if (!seriesNote(e.op)) continue;
    if (e.seq !== notes.length + 1 || (e.op !== 'note' && (!positive(e.on) || notes[e.on - 1]?.op !== 'note')))
      throw new Error(`${where}: invalid series note sequence or settlement at n${e.seq}`);
    notes.push(e);
  }
  return notes;
}

// Only the materialization may fail after a source write. Keep the accepted entry in memory and rebuild the projection on its next use.
export class Projection {
  private dirty = true;
  readonly path: string;
  entries: Entry[];
  constructor(path: string, entries: Entry[]) {
    this.path = path;
    this.entries = entries;
  }

  sync() {
    if (!this.dirty) return;
    const st = lstatSync(this.path, { throwIfNoEntry: false });
    if (this.entries.length || st) {
      const text = jsonLines(this.entries);
      const current = st?.isFile() && readFileSync(this.path);
      let matches = current && current.equals(Buffer.from(text));
      // The old log may have different JSON spacing; a matching projection shouldn't change what Git sees.
      if (current && !matches) {
        try { matches = jsonLines(parseLines(this.path, current)) === text; } catch { /* a broken projection is rebuilt */ }
      }
      if (!matches) {
        mkdirSync(dirname(this.path), { recursive: true });
        replaceFile(this.path, text);
      }
    }
    this.dirty = false;
  }

  update(update: Entry | Entry[]) {
    const incremental = !this.dirty && !Array.isArray(update);
    if (Array.isArray(update)) this.entries = update;
    else this.entries.push(update);
    this.dirty = true;
    try {
      if (incremental) {
        mkdirSync(dirname(this.path), { recursive: true });
        appendLine(this.path, JSON.stringify(update), 0o600);
        this.dirty = false;
      } else this.sync();
    } catch (e) {
      console.error(`${this.path}: projection needs repair (${(e as NodeJS.ErrnoException).code ?? 'write failed'})`);
    }
  }
}

export type Book = {
  messages: StoredMessage[];
  floor: number;
  byInstance: Map<string, StoredMessage[]>;
  requests: StoredMessage[];
  notes: Projection;
  live: Map<string, Projection>;
};
let books = new Map<string, Book>();
export function installMessageBooks(loaded: Map<string, Book>) { books = loaded; }

function indexMessage(b: Book, m: StoredMessage) {
  if (m.entry.op === 'request') b.requests.push(m);
  if (m.anchor.instance) {
    const ms = b.byInstance.get(m.anchor.instance);
    if (ms) ms.push(m); else b.byInstance.set(m.anchor.instance, [m]);
  }
}

export function startMessageStore(dir: string) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(messagesFile(dir))) writeFileSync(messagesFile(dir), '', { mode: 0o600, flag: 'wx' });
}

export function readBook(dir: string, messages: StoredMessage[]): Book {
  const path = messageFloor(dir), st = lstatSync(path, { throwIfNoEntry: false });
  const floor = st?.isFile() ? Number(readFileSync(path, 'utf8')) : 0;
  if (st && !positive(floor)) throw new Error(`${path}: invalid message ID floor`);
  const b: Book = { messages, floor, byInstance: new Map(), requests: [], notes: new Projection(notesFile(dir), projectNotes(dir, messages)), live: new Map() };
  for (const m of messages) indexMessage(b, m);
  return b;
}

function book(dir: string): Book {
  let b = books.get(dir);
  if (!b) books.set(dir, b = readBook(dir, existsSync(dir) ? readMessages(dir) : []));
  return b;
}

export const messagesAt = (dir: string): readonly StoredMessage[] => book(dir).messages;
export const noteEntries = (dir: string): readonly Entry[] => book(dir).notes.entries;
export const syncNotes = (dir: string) => book(dir).notes.sync();

export function instanceProjection(dir: string, instance: string, path: string, log?: Entry[]) {
  const b = book(dir), source = eventsFile(dir, instance);
  const p = new Projection(path, log ?? projectInstance(source, readEntries(source), b.byInstance.get(instance) ?? []));
  b.live.set(instance, p);
  return p;
}

export function appendMessage(dir: string, anchor: MessageAnchor, entry: Entry): StoredMessage {
  const b = book(dir), m = storedMessage(Math.max(b.floor, b.messages.at(-1)?.id ?? 0) + 1, anchor, entry);
  validateMessage(m, messagesFile(dir), true);
  const target = anchor.instance ? b.live.get(anchor.instance) : undefined;
  if (anchor.instance && (!target || target.entries[0]?.op === 'delete')) throw new Error(`${dir}: no live instance ${anchor.instance}`);
  const p = instanceMessage(entry) ? target : seriesNote(entry.op) ? b.notes : undefined;
  if (p && entry.seq !== p.entries.length + 1) throw new Error(`${p.path}: unexpected append seq ${entry.seq}`);
  if (p === b.notes && entry.op !== 'note' && (!positive(entry.on) || p.entries[entry.on - 1]?.op !== 'note'))
    throw new Error(`${p.path}: settlement names no series note`);
  const on = verdictTarget(entry);
  if (on !== undefined && b.notes.entries[on - 1]?.op !== 'note') throw new Error(`${dir}: verdict names no series note`);
  mkdirSync(dir, { recursive: true });
  appendLine(messagesFile(dir), safeEntryJson(m), 0o600);
  b.messages.push(m);
  indexMessage(b, m);
  p?.update(entry);
  changes.emit('change', instanceMessage(entry) ? anchor.instance : 'tree');
  return m;
}

export function purgeMessages(dir: string, instance: string, label: string, task: boolean) {
  for (const [path, b] of books) {
    if (!b.messages.length) continue;
    const own = path === dir, all = own && task;
    const requests = new Set(b.requests.filter(m => m.entry.source === instance || own &&
      (m.anchor.instance === instance || !m.anchor.instance && m.entry.label === label)).map(m => m.id));
    if (!all && !(own && b.byInstance.has(instance)) && !requests.size) continue;
    const remaining = all ? [] : b.messages.flatMap(m => {
      const e = m.entry;
      if (requests.has(m.id) || e.op === 'request-decision' && requests.has(e.request as number)) return [];
      if (!own || m.anchor.instance !== instance) return [m];
      const on = verdictTarget(e);
      return on === undefined ? [] : [storedMessage(m.id, {}, { seq: 1, at: e.at, by: e.by, op: 'note-verdict', on, how: e.op === 'signoff' ? 'taken' : 'aside' })];
    });
    // Never recycle an id, not even when deletion removed the last record.
    const floor = b.messages.at(-1)!.id;
    if (floor > b.floor && floor > (remaining.at(-1)?.id ?? 0)) {
      replaceFile(messageFloor(path), String(floor), true);
      b.floor = floor;
    }
    replaceFile(messagesFile(path), jsonLines(remaining), true);
    b.messages = remaining;
    b.byInstance.clear();
    b.requests.length = 0;
    for (const m of remaining) indexMessage(b, m);
    if (all) b.notes.update([]);
  }
}
