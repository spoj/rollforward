import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, extname, join, posix } from 'node:path';
import { tree } from './system.ts';

// Paths in the screen are /-separated on every system.
const normalize = posix.normalize;

// Writes a read-only file whole, by renaming a temporary file into place. Windows refuses to rename over a read-only file, so there
// the old one is made writable first.
export function replaceReadOnly(path: string, text: string) {
  writeFileSync(path + '.tmp', text, { mode: 0o444 });
  if (process.platform === 'win32' && existsSync(path)) chmodSync(path, 0o644);
  renameSync(path + '.tmp', path);
}

export type Note = { id?: string; ref?: string; text: string; files?: string[]; options?: string[]; default?: number };
export type Item = { id: string; name: string; kind: 'input' | 'step' | 'output'; file: string | null; from?: string[]; headline?: string; source?: string; notes?: Note[] };
export type Doc = { rev: number; status: 'open' | 'closed' | 'abandoned'; items: Item[] };
export type Entry = { seq: number; at: string; by: string; op: string; [k: string]: unknown };

// Saves bytes in working/ (`dir`) under `name`, or `name (2)` and on if taken, and answers the path as the screen names it.
export function saveNew(dir: string, name: string, bytes: Buffer): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'download', dot = clean.lastIndexOf('.');
  mkdirSync(dir, { recursive: true });
  let file = clean;
  for (let k = 2; existsSync(join(dir, file)); k++) file = dot > 0 ? `${clean.slice(0, dot)} (${k})${clean.slice(dot)}` : `${clean} (${k})`;
  writeFileSync(join(dir, file), bytes);
  return `working/${file}`;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Besides .rf/ (system.ts), the data root holds series/<id>/, a series' series.json and .pylib, and instances/<id>/, each instance
// flat, with instance.json naming its label and its series. Names live there and in .rf/tree.json, so a rename or a move edits one
// small file, at any time, even mid-run. The index holds every instance's instance.json, read once at start; an instance loads
// when it's first listed or opened.
export type Meta = { label: string; series: string };

let root = '';
const index = new Map<string, Meta>();
const cache = new Map<string, Instance>();

export function openStore(dataRoot: string) {
  root = dataRoot;
  index.clear();
  cache.clear();
  mkdirSync(join(root, 'instances'), { recursive: true });
  mkdirSync(join(root, 'series'), { recursive: true });
  mkdirSync(join(root, 'guidance'), { recursive: true });
  mkdirSync(join(root, 'derived'), { recursive: true });
  for (const id of readdirSync(join(root, 'instances'))) index.set(id, JSON.parse(readFileSync(join(root, 'instances', id, 'instance.json'), 'utf8')));
}

export const newId = () => randomBytes(6).toString('hex');
export const seriesDir = (id: string) => join(root, 'series', id);
export const instanceDir = (id: string) => join(root, 'instances', id);
// Guidance: guidance/company.md, the admins', and guidance/<workspace id>.md, each workspace's owners', read by every agent in scope.
export const guidanceFile = (id = 'company') => join(root, 'guidance', `${id}.md`);
// Text read out of workbooks, mail, PDFs and Word files, by the file's sha256, for rf search.
export const derivedFile = (hash: string) => join(root, 'derived', `${hash}.txt`);

export function instance(id: string): Instance {
  if (!index.has(id)) throw new HttpError(404, `no instance ${id}`);
  if (!cache.has(id)) cache.set(id, new Instance(instanceDir(id)));
  return cache.get(id)!;
}

// A series' instances, by label, from the index.
export function labels(seriesId: string): { id: string; label: string }[] {
  return [...index].filter(([, m]) => m.series === seriesId).map(([id, m]) => ({ id, label: m.label })).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
}

export function instances(seriesId: string): Instance[] {
  return labels(seriesId).map(l => instance(l.id));
}

export function safeName(s: string): string {
  const name = s.replace(/[/\\\x00-\x1f]/g, '_');
  if (!name || name.startsWith('.')) throw new HttpError(400, `bad name: ${s}`);
  return name;
}

export function isPerson(e: Entry): boolean {
  return e.by !== 'server' && e.by !== 'agent';
}

function setMeta(id: string, meta: Meta) {
  replaceReadOnly(join(instanceDir(id), 'instance.json'), JSON.stringify(meta));
  index.set(id, meta);
}

function freeLabel(seriesId: string, label: string): string {
  const name = safeName(label);
  if (labels(seriesId).some(l => l.label === name)) throw new HttpError(409, `${name} exists`);
  return name;
}

// A new instance starts from its series' latest closed one, but in a workspace's Ad hoc series, where each is a one-off ask. `by` is
// its runner, and `logins` the offers of their logins they ticked for it (logins.ts).
export function createInstance(seriesId: string, label: string, by: string, logins: string[]): Instance {
  const name = freeLabel(seriesId, label), id = newId(), dir = instanceDir(id);
  const closed = tree().series[seriesId]?.adhoc ? [] : instances(seriesId).filter(i => i.doc.status === 'closed').sort((a, b) => a.closedAt().localeCompare(b.closedAt()));
  const from = closed.at(-1);
  mkdirSync(join(dir, 'upload'), { recursive: true });
  mkdirSync(join(dir, 'working'));
  setMeta(id, { label: name, series: seriesId });
  const inst = instance(id);
  inst.doc.items = (from?.doc.items ?? []).map(({ id, name, kind, from }) => ({ id, name, kind, file: null, from, notes: [] }));
  inst.save();
  const fetch = from?.doc.items.some(i => i.kind === 'input' && i.file?.startsWith('working/'));
  inst.append(by, 'create', { from: from?.label ?? null, ...(fetch && { fetch }), logins });
  return inst;
}

export function renameInstance(inst: Instance, label: string) {
  setMeta(inst.id, { ...inst.meta, label: freeLabel(inst.seriesId, label) });
}

export function moveInstance(inst: Instance, seriesId: string) {
  setMeta(inst.id, { label: freeLabel(seriesId, inst.label), series: seriesId });
}

export function duplicateInstance(src: Instance, label: string, by: string, logins: string[]): Instance {
  const name = freeLabel(src.seriesId, label), id = newId(), dir = instanceDir(id);
  cpSync(src.dir, dir, { recursive: true, filter: p => p !== join(src.dir, 'session') });
  setMeta(id, { label: name, series: src.seriesId });
  const inst = instance(id);
  inst.doc.status = 'open';
  inst.save();
  inst.append(by, 'duplicate', { from: src.label, logins });
  return inst;
}

export class Instance {
  dir: string;
  id: string;
  doc: Doc;
  log: Entry[];

  constructor(dir: string) {
    this.dir = dir;
    this.id = basename(dir);
    const ws = join(dir, 'workspace.json'), log = join(dir, 'log.jsonl');
    this.doc = existsSync(ws) ? JSON.parse(readFileSync(ws, 'utf8')) : { rev: 0, status: 'open', items: [] };
    this.log = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  }

  append(by: string, op: string, fields: Record<string, unknown> = {}): Entry {
    const e = { seq: this.log.length + 1, at: new Date().toISOString(), by, op, ...fields };
    this.log.push(e);
    appendFileSync(join(this.dir, 'log.jsonl'), JSON.stringify(e) + '\n');
    return e;
  }

  save() {
    this.doc.rev++;
    replaceReadOnly(join(this.dir, 'workspace.json'), JSON.stringify(this.doc, null, 1));
  }

  closedAt(): string {
    return this.log.findLast(e => e.op === 'close')?.at ?? '';
  }

  upload(by: string, name: string, tmp: string, sha256: string, pane: 'in' | 'out', onto: string | null) {
    if (this.doc.status !== 'open') throw new HttpError(409, 'the instance was closed during the upload');
    const clean = safeName(name), ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
    mkdirSync(join(this.dir, 'upload'), { recursive: true });
    let file = `upload/${clean}`;
    for (let n = 2; existsSync(join(this.dir, file)); n++) file = `upload/${stem}_${n}${ext}`;
    renameSync(tmp, join(this.dir, file));
    chmodSync(join(this.dir, file), 0o444);
    const up = this.append(by, 'upload', { file, pane, onto, sha256 });
    let id = `u${up.seq}`;
    for (let n = 2; this.doc.items.some(i => i.id === id); n++) id = `u${up.seq}_${n}`;
    this.doc.items.push({ id, name: stem, kind: pane === 'in' ? 'input' : 'output', file, notes: [] });
    this.append('server', 'point', { item: id, file });
    this.save();
  }

  answer(by: string, noteId: string, choice: number) {
    if (this.answered(noteId)) throw new HttpError(409, `${noteId} is already answered`);
    const note = this.doc.items.flatMap(i => i.notes ?? []).find(n => n.id === noteId && n.options);
    if (!note) throw new HttpError(400, `no question ${noteId}`);
    if (!note.options![choice]) throw new HttpError(400, `no option ${choice}`);
    this.append(by, 'answer', { note: noteId, choice, text: note.options![choice] });
  }

  answered(noteId: string): boolean {
    return this.log.some(e => e.op === 'answer' && e.note === noteId);
  }

  close(by: string) {
    for (const n of this.doc.items.flatMap(i => i.notes ?? []))
      if (n.id && n.options && !this.answered(n.id))
        this.append('server', 'answer', { note: n.id, choice: n.default ?? 0, text: n.options[n.default ?? 0], default: true });
    this.doc.status = 'closed';
    this.save();
    this.append(by, 'close');
  }

  abandon(by: string) {
    this.doc.status = 'abandoned';
    this.save();
    this.append(by, 'abandon');
  }

  put(text: string) {
    let doc: Doc;
    try { doc = JSON.parse(text); } catch (e) { throw new HttpError(400, `not JSON: ${(e as Error).message}`); }
    if (doc.rev !== this.doc.rev) throw new HttpError(409, `stale rev ${doc.rev}: the workspace is now at rev ${this.doc.rev}. Run rf show and merge.`);
    if (doc.status !== this.doc.status) throw new HttpError(400, 'status is set by the server');
    if (!Array.isArray(doc.items)) throw new HttpError(400, 'items must be an array');
    const errors: string[] = [], ids = new Set<string>(), questions = new Set<string>();
    for (const i of doc.items) {
      if (typeof i.id !== 'string' || !i.id || ids.has(i.id)) errors.push(`item id missing or repeated: ${JSON.stringify(i.id)}`);
      ids.add(i.id);
      if (typeof i.name !== 'string' || !i.name) errors.push(`${i.id}: name missing`);
      if (!['input', 'step', 'output'].includes(i.kind)) errors.push(`${i.id}: kind must be "input", "step" or "output"`);
      if (i.from !== undefined && !Array.isArray(i.from)) errors.push(`${i.id}: from must be a list of item ids`);
      for (const k of ['headline', 'source'] as const) if (i[k] !== undefined && typeof i[k] !== 'string') errors.push(`${i.id}: ${k} must be a string`);
      if (i.file !== null) {
        const ok = typeof i.file === 'string' && normalize(i.file) === i.file && /^(upload|working)\/./.test(i.file) && !i.file.split('/').includes('..');
        if (!ok) errors.push(`${i.id}: file must be null or a path under upload/ or working/, relative to the instance folder`);
        else if (!existsSync(join(this.dir, i.file)) || !statSync(join(this.dir, i.file)).isFile()) errors.push(`${i.id}: no file ${i.file}`);
      }
      for (const n of i.notes ?? []) {
        if (typeof n.text !== 'string' || !n.text) errors.push(`${i.id}: a note has no text`);
        for (const f of n.files ?? []) {
          const path = this.cited(f);
          if (!path) errors.push(`${i.id}: cited file ${JSON.stringify(f)} must be under upload/ or working/ of this instance or another of its series, such as ../<label>/working/...`);
          else if (!existsSync(path) || !statSync(path).isFile()) errors.push(`${i.id}: no file ${f}`);
        }
        if (n.options) {
          if (!n.id || questions.has(n.id)) errors.push(`${i.id}: question id missing or repeated: ${JSON.stringify(n.id)}`);
          questions.add(n.id!);
          if (!Array.isArray(n.options) || n.options.length < 2 || !n.options[n.default ?? 0]) errors.push(`${i.id}: question ${n.id} needs 2+ options and a valid default`);
        }
      }
    }
    const from = new Map(doc.items.map(i => [i.id, Array.isArray(i.from) ? i.from : []]));
    for (const [id, fs] of from) for (const f of fs) if (!from.has(f)) errors.push(`${id}: from names no item ${JSON.stringify(f)}`);
    for (let peeled = true; peeled;) {
      peeled = false;
      for (const [id, fs] of from) if (!fs.some(f => from.has(f))) peeled = from.delete(id);
    }
    if (from.size) errors.push(`from goes round in a circle among ${[...from.keys()].join(', ')}`);
    if (errors.length) throw new HttpError(400, errors.join('\n'));

    const shown = new Set(this.log.filter(e => e.op === 'point').map(e => e.file));
    const old = new Map(this.doc.items.map(i => [i.id, i]));
    for (const i of doc.items) {
      const o = old.get(i.id);
      if (i.file !== (o?.file ?? null) && i.file !== null) {
        const path = join(this.dir, i.file);
        const sha256 = shown.has(i.file) ? undefined : createHash('sha256').update(readFileSync(path)).digest('hex');
        if (i.file.startsWith('working/')) chmodSync(path, 0o444);
        this.append('agent', 'point', { item: i.id, file: i.file, was: o?.file ?? null, sha256 });
      } else if (i.file === null && o?.file) this.append('agent', 'point', { item: i.id, file: null, was: o.file });
      if (!o || o.name !== i.name || o.kind !== i.kind || JSON.stringify(o.from) !== JSON.stringify(i.from) || o.headline !== i.headline || o.source !== i.source)
        this.append('agent', 'item', { item: i.id, name: i.name, kind: i.kind, from: i.from, headline: i.headline, source: i.source });
      const before = new Set((o?.notes ?? []).map(n => JSON.stringify(n)));
      const after = new Set((i.notes ?? []).map(n => JSON.stringify(n)));
      for (const n of after) if (!before.has(n)) this.append('agent', 'note', { item: i.id, note: JSON.parse(n) });
      for (const n of before) if (!after.has(n)) this.append('agent', 'unnote', { item: i.id, note: JSON.parse(n) });
    }
    for (const o of this.doc.items) if (!ids.has(o.id)) this.append('agent', 'remove', { item: o.id });
    this.doc = { rev: this.doc.rev, status: this.doc.status, items: doc.items };
    this.save();
    return this.doc.rev;
  }

  // Where a note's cited file is: under upload/ or working/ of this instance, or of another of its series as ../<label>/....
  cited(f: unknown): string | undefined {
    const m = typeof f === 'string' && normalize(f) === f ? f.match(/^(?:\.\.\/([^/]+)\/)?((?:upload|working)\/.+)$/) : null;
    const id = m && (m[1] === undefined ? this.id : labels(this.seriesId).find(l => l.label === m[1])?.id);
    return id && !m[2].split('/').includes('..') ? join(instanceDir(id), m[2]) : undefined;
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
