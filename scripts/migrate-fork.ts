// One-off: copies a data root of the team's fork (its main at a1fa8db) into a new data root, reading the old one only.
// <workspace>/<series>/<label>/ become series/<id>/ and instances/<id>/ named in .rf/tree.json, people keep
// their roles and workspaces their owners, talk becomes threads, and no skill comes across. Ids come from
// the old paths, so a rerun into a fresh NEW gives the same links. Run it with the old server stopped:
//   node scripts/migrate-fork.ts OLD NEW
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Entry } from '../src/store.ts';
import type { Tree } from '../src/system.ts';

type Note = { id?: string; ref?: string; text: string; files?: string[]; options?: string[]; default?: number };

const [old, root] = process.argv.slice(2);
if (existsSync(root)) throw new Error(`${root} exists: migrate into a new folder`);
const id = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 12);
const folders = (dir: string) => readdirSync(dir).filter(n => !n.startsWith('.') && statSync(join(dir, n)).isDirectory()).sort();
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const copy = (from: string, to: string) => existsSync(from) && cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
const left = (dir: string, known: string[]) => {
  const rest = readdirSync(dir).filter(n => !known.includes(n));
  if (rest.length) console.log(`left in ${dir}: ${rest.join(', ')}`);
};

// The fork's log as this version's entries. Notes are the agent's comments, questions its asks with their options in the text,
// answers and steers people's replies, and the agent's replies its comments in the latest steer's thread. Removing an item
// resolves its threads, as its notes went with it, and the questions closing defaulted are what the close accepted. Entries
// are numbered afresh, as append takes the next seq from the log's length. A run left cut gets its done, with every entry
// seen, so the new server sends none of the old log again; it wakes the instance to carry on (waker.ts, recover).
function convert(log: Entry[]): Entry[] {
  const out: Entry[] = [], seqOf = new Map<unknown, number>(), byNote = new Map<string, string>(), byId = new Map<string, string>();
  const onItem = new Map<string, Set<string>>(), accepted: string[] = [];
  let steer: string | undefined;
  const next = () => `c${out.length + 1}`;
  const push = (e: Entry, op: string, fields: Record<string, unknown>) => out.push({ seq: out.length + 1, at: e.at, by: e.by, op, ...fields });
  for (const e of log) {
    const { seq, at, by, op, ...fields } = e, item = e.item as string, note = e.note as Note;
    if (op === 'note') {
      const thread = next(), options = note.options?.map((o, i) => `${String.fromCharCode(97 + i)}) ${o}${i === note.default ? ' (default)' : ''}`);
      push(e, 'comment', { thread, item, ...(note.ref && { ref: note.ref }), text: options ? `${note.text}\n${options.join('\n')}` : note.text, ...(note.files?.length && { files: note.files }), ...(options && { ask: true }) });
      byNote.set(`${item} ${JSON.stringify(note)}`, thread);
      if (note.id) byId.set(note.id, thread);
      onItem.set(item, (onItem.get(item) ?? new Set()).add(thread));
    } else if (op === 'unnote') {
      const thread = byNote.get(`${item} ${JSON.stringify(note)}`);
      if (thread && onItem.get(item)?.delete(thread)) push(e, 'resolve', { thread });
    } else if (op === 'remove') {
      push(e, op, fields);
      for (const thread of onItem.get(item) ?? []) push(e, 'resolve', { thread });
      onItem.delete(item);
    } else if (op === 'answer') {
      const thread = byId.get(e.note as string);
      if (thread && e.default) accepted.push(thread);
      else if (thread) push(e, 'comment', { thread, text: e.text });
    } else if (op === 'steer') push(e, 'comment', { thread: steer = next(), text: e.text });
    else if (op === 'reply') push(e, 'comment', { thread: steer ?? next(), text: e.text });
    else if (op === 'close') push(e, op, accepted.length ? { accepted: accepted.splice(0) } : {});
    else if (op === 'create' || op === 'duplicate') push(e, op, { ...fields, logins: [] });
    else if (op === 'run') push(e, op, { ...fields, upto: seqOf.get(e.upto) ?? 0 });
    else if (op === 'done') push(e, op, { ...fields, seen: seqOf.get(e.seen) ?? 0 });
    else push(e, op, fields);
    seqOf.set(seq, out.length);
  }
  const last = out.findLast(e => e.op === 'run' || e.op === 'done');
  if (last?.op === 'run') out.push({ seq: out.length + 1, at: new Date().toISOString(), by: 'server', op: 'done', run: last.run, aborted: true, seen: out.length, cost: 0, summary: null, error: 'cut by the move to 0.2.0' });
  return out;
}

mkdirSync(join(root, '.rf'), { recursive: true, mode: 0o700 });
mkdirSync(join(root, 'series'));
mkdirSync(join(root, 'instances'));
copy(join(old, '.rf', 'users.json'), join(root, '.rf', 'users.json'));
left(join(old, '.rf'), ['users.json', 'workspaces.json']);
left(old, ['.rf', '.tmp', ...folders(old)]);
const owners: Record<string, { owner?: string }> = json(join(old, '.rf', 'workspaces.json'));
const t: Tree = { workspaces: {}, series: {} };
let instances = 0;
for (const ws of folders(old)) {
  const wid = id(ws), wsDir = join(old, ws), owner = owners[ws]?.owner;
  t.workspaces[wid] = { name: ws, owners: owner ? [owner] : [], members: [], ...(existsSync(join(wsDir, '.archived')) && { archived: true }) };
  left(wsDir, ['.archived', ...folders(wsDir)]);
  for (const series of folders(wsDir)) {
    const sid = id(`${ws}/${series}`), sDir = join(wsDir, series), labels = folders(sDir).filter(l => existsSync(join(sDir, l, 'workspace.json')));
    t.series[sid] = { name: series, workspace: wid, ...(existsSync(join(sDir, '.archived')) && { archived: true }) };
    mkdirSync(join(root, 'series', sid));
    copy(join(sDir, '.pylib'), join(root, 'series', sid, '.pylib'));
    left(sDir, ['.archived', '.pylib', 'series.json', ...labels]);
    for (const label of labels) {
      const from = join(sDir, label), to = join(root, 'instances', id(`${ws}/${series}/${label}`));
      mkdirSync(to);
      for (const d of ['upload', 'working', 'session']) copy(join(from, d), join(to, d));
      const { rev, status, items } = json(join(from, 'workspace.json'));
      writeFileSync(join(to, 'workspace.json'), JSON.stringify({ rev, status, items: items.map(({ notes: _, ...i }: { notes?: Note[] }) => i) }, null, 1), { mode: 0o444 });
      writeFileSync(join(to, 'instance.json'), JSON.stringify({ label, series: sid }), { mode: 0o444 });
      const log = readFileSync(join(from, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry);
      writeFileSync(join(to, 'log.jsonl'), convert(log).map(e => JSON.stringify(e) + '\n').join(''));
      left(from, ['upload', 'working', 'session', 'workspace.json', 'log.jsonl']);
      instances++;
    }
  }
}
writeFileSync(join(root, '.rf', 'tree.json'), JSON.stringify(t, null, 1), { mode: 0o600 });
console.log(`${Object.keys(t.workspaces).length} workspaces, ${Object.keys(t.series).length} series, ${instances} instances`);
