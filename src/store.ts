import { appendFileSync, chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, posix, sep } from 'node:path';
import { changes, tree } from './system.ts';
import { commit, pack, type Who } from './git.ts';

// Paths in the screen are /-separated on every system.
const normalize = posix.normalize;

// Writes a read-only file whole, by renaming a temporary file into place. Windows refuses to rename over a read-only file, so there
// the old one is made writable first.
export function replaceReadOnly(path: string, data: string | Buffer) {
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
    if (!['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code!)) throw e;
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
function wipe(path: Buffer) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (!st.isDirectory()) return rmSync(path, { force: true });
  chmodSync(path, 0o700);
  for (const name of readdirSync(path, { encoding: 'buffer' })) wipe(Buffer.concat([path, Buffer.from(sep), name]));
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
  mkdirSync(join(root, 'agents'), { recursive: true });
  for (const id of readdirSync(join(root, 'instances'))) {
    index.set(id, JSON.parse(readFileSync(join(root, 'instances', id, 'instance.json'), 'utf8')));
  }
}

export const newId = () => randomBytes(6).toString('hex');
export const seriesDir = (id: string) => join(root, 'series', id);
export const instanceDir = (id: string) => join(root, 'instances', id);
// AGENTS.md files: agents/company.md, the admins', and agents/<workspace id>.md, each workspace's owners'.
export const agentsFile = (id = 'company') => join(root, 'agents', `${id}.md`);

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

// The closed instances of its series before it, by label: the examples it rolls forward from.
export const closedBefore = (inst: Instance) => instances(inst.seriesId).filter(i => i.doc.status === 'closed' && i.label.localeCompare(inst.label, 'en', { numeric: true }) < 0);

// A name is a folder's in a run's view, a line of names.tsv: no slash, control character or line break, which a reader such as
// Python's splitlines() would split it at; and not AGENTS.md, where the instructions the view binds go.
export function safeName(s: string): string {
  const name = s.replace(/[/\\\x00-\x1f\x7f\x85\u2028\u2029]/g, '_');
  if (!name) throw new HttpError(400, 'a name is needed');
  if (name.startsWith('.')) throw new HttpError(400, `a name can't start with a dot: ${s}`);
  if (name === 'AGENTS.md') throw new HttpError(400, "AGENTS.md is the name of the agents' instructions: choose another");
  return name;
}

// Keeps a person's file in folder/ under dir, read-only, under its own name made unique; answers its path there.
export function keep(dir: string, folder: string, name: string, tmp: string): string {
  const clean = safeName(name), ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
  mkdirSync(join(dir, folder), { recursive: true });
  let file = `${folder}/${clean}`;
  for (let n = 2; file === 'upload/attachments' || existsSync(join(dir, file)); n++) file = `${folder}/${stem}_${n}${ext}`;
  renameSync(tmp, join(dir, file));
  chmodSync(join(dir, file), 0o444);
  return file;
}

export function isPerson(e: Entry): boolean {
  return e.by !== 'server' && e.by !== 'agent';
}

function setMeta(id: string, meta: Meta) {
  replaceReadOnly(join(instanceDir(id), 'instance.json'), JSON.stringify(meta));
  index.set(id, meta);
  changes.emit('change', 'tree');
}

function freeLabel(seriesId: string, label: string): string {
  const name = safeName(label);
  if (labels(seriesId).some(l => l.label === name)) throw new HttpError(409, `${name} exists`);
  return name;
}

// A new instance starts empty: its agent learns from the series' earlier instances what to roll forward from. `by` is its runner,
// and `logins` the offers of their logins they ticked for it (logins.ts).
export function createInstance(seriesId: string, label: string, by: string, logins: string[]): Instance {
  const name = freeLabel(seriesId, label), id = newId(), dir = instanceDir(id);
  mkdirSync(join(dir, 'upload'), { recursive: true });
  mkdirSync(join(dir, 'working'));
  setMeta(id, { label: name, series: seriesId });
  const inst = instance(id);
  inst.save();
  inst.append(by, 'create', { logins });
  return inst;
}

export function renameInstance(inst: Instance, label: string) {
  setMeta(inst.id, { ...inst.meta, label: freeLabel(inst.seriesId, label) });
}

export function duplicateInstance(src: Instance, label: string, by: string, logins: string[]): Instance {
  const name = freeLabel(src.seriesId, label), id = newId(), meta = { label: name, series: src.seriesId }, tmp = join(root, '.tmp', id);
  // Files and folders only, sharing blocks where the disk can: a run may have left links or FIFOs in working/, or a name that isn't
  // UTF-8, which reads back as another name, which no file has. The copy starts afresh, with no session and no history. It is made
  // in .tmp/ with its own instance.json, then moved into instances/, so one that fails part way leaves nothing a start reads.
  try {
    cpSync(src.dir, tmp, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: p => {
      const st = lstatSync(p, { throwIfNoEntry: false });
      return p !== join(src.dir, 'session') && p !== join(src.dir, '.git') && !!st && (st.isFile() || st.isDirectory());
    } });
    replaceReadOnly(join(tmp, 'instance.json'), JSON.stringify(meta));
    renameSync(tmp, instanceDir(id));
  } finally {
    wipe(Buffer.from(tmp));
  }
  setMeta(id, meta);
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
    const ws = join(dir, 'screen.json'), log = join(dir, 'log.jsonl');
    this.doc = existsSync(ws) ? JSON.parse(readFileSync(ws, 'utf8')) : { rev: 0, status: 'open', items: [] };
    this.log = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    // Its log is written first as it's deleted, so a restart that cut a deletion finds it deleted (waker.ts recover()).
    if (this.hole) this.doc = { rev: this.doc.rev, status: 'deleted', items: [] };
  }

  // Deleted: its log is its delete entry alone.
  get hole(): boolean {
    return this.log[0]?.op === 'delete';
  }

  append(by: string, op: string, fields: Record<string, unknown> = {}): Entry {
    // Nothing more is said of a deleted instance, such as by a run its deletion cut, as it ends.
    if (this.hole) return { seq: 0, at: new Date().toISOString(), by, op, ...fields };
    const e = { seq: this.log.length + 1, at: new Date().toISOString(), by, op, ...fields };
    this.log.push(e);
    appendFileSync(join(this.dir, 'log.jsonl'), JSON.stringify(e) + '\n');
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
    const file = this.keep(name, tmp), clean = safeName(name), stem = clean.slice(0, clean.length - extname(clean).length);
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

  // Whether a comment waits no more: the agent withdrew it; a proposal was approved (signoff) or rejected; a question has a person's
  // reply under it, and any other comment anyone's. An ask from before questions and proposals, `ask: true`, takes any of these, its
  // agent's reply withdrawing it; and from before replies named what they answer, any later word in its thread.
  answered(c: Entry): boolean {
    return this.log.some(e => e.seq > c.seq && e.thread === c.thread && (e.on === c.seq ? ['signoff', 'reject', 'withdraw'].includes(e.op)
      : e.parent === c.seq ? e.op === 'comment' && c.ask !== 'proposal' && !(c.ask === 'question' && e.by === 'agent')
      : e.parent === undefined && e.on === undefined && ['comment', 'signoff', 'resolve'].includes(e.op)));
  }

  // The agent's asks still waiting on people: those no one answered.
  asking(): Entry[] {
    const from = this.copied;
    return this.log.filter(e => e.seq > from && e.op === 'comment' && e.by === 'agent' && e.ask && !this.answered(e));
  }

  // Closing makes the instance the period's record and an example for the next, approving nothing: the asks still waiting are
  // accepted as the agent said it did them. It commits the folder in the runner's name. The instance is closed meanwhile, so nothing
  // changes it, but saved only once committed and packed: either failing, or a restart, leaves it open.
  async close(by: Who) {
    const accepted = this.asking().map(e => `c${e.seq}`);
    this.doc.status = 'closed';
    let hash: string;
    try {
      hash = await commit(this.dir, by, `Close ${this.label}`);
      await pack(this.dir);
    } catch (e) {
      if (!this.hole) this.doc.status = 'open';
      throw e;
    }
    if (this.hole) throw new HttpError(409, `${this.label} was deleted during the close`);
    this.save();
    this.append(by.email, 'close', { ...(accepted.length && { accepted }), commit: hash });
  }

  abandon(by: string) {
    this.doc.status = 'abandoned';
    this.save();
    this.append(by, 'abandon');
  }

  // The tombstone precedes waiting for runs and commits: a restart finishes clearing the folder.
  markDeleted(by: string, fields: Record<string, unknown>): Entry {
    const e = { seq: this.log.length + 1, at: new Date().toISOString(), by, op: 'delete', ...fields };
    writeFileSync(join(this.dir, 'log.jsonl.tmp'), JSON.stringify(e) + '\n');
    renameSync(join(this.dir, 'log.jsonl.tmp'), join(this.dir, 'log.jsonl'));
    this.log = [e];
    this.doc = { rev: this.doc.rev, status: 'deleted', items: [] };
    return e;
  }

  clear() {
    const ws = join(this.dir, 'screen.json'), was: Doc | undefined = existsSync(ws) ? JSON.parse(readFileSync(ws, 'utf8')) : undefined;
    if (was?.status !== 'deleted' || was.items.length) {
      this.doc = { rev: this.doc.rev, status: 'deleted', items: [] };
      this.save();
    }
    for (const name of readdirSync(this.dir, { encoding: 'buffer' })) if (!HOLE.includes(name.toString('latin1'))) wipe(Buffer.concat([Buffer.from(this.dir + sep), name]));
    if (tree().series[this.seriesId].single) wipe(Buffer.from(join(this.series(), '.pylib')));
  }

  put(text: string, run: number) {
    let doc: Doc;
    try { doc = JSON.parse(text); } catch (e) { throw new HttpError(400, `not JSON: ${(e as Error).message}`); }
    if (doc.rev !== this.doc.rev) throw new HttpError(409, `stale rev ${doc.rev}: the screen is at rev ${this.doc.rev} now, as each put and upload moves it on: run rf show and merge`);
    if (doc.status !== undefined && doc.status !== this.doc.status) throw new HttpError(400, 'status is set by the server; leave it out or as it is');
    if (!Array.isArray(doc.items)) throw new HttpError(400, 'items must be an array');
    const errors: string[] = [], ids = new Set<string>();
    const old = new Map(this.doc.items.map(i => [i.id, i]));
    for (const i of doc.items) {
      if (typeof i.id !== 'string' || !i.id || ids.has(i.id)) errors.push(`item id missing or repeated: ${JSON.stringify(i.id)}`);
      ids.add(i.id);
      if (typeof i.name !== 'string' || !i.name) errors.push(`${i.id}: name missing`);
      if (!['input', 'step', 'output'].includes(i.kind)) errors.push(`${i.id}: kind must be "input", "step" or "output"`);
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
    const from = new Map(doc.items.map(i => [i.id, Array.isArray(i.from) ? i.from : []]));
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

  // A copy's own history starts at its latest duplicate entry: what came before is the copied instance's, settled, pending nothing.
  get copied(): number {
    return this.log.findLast(e => e.op === 'duplicate')?.seq ?? 0;
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
