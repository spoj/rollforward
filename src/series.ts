import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './store.ts';
import { appendLine, changes, readLines } from './system.ts';

// series.json: {"shared"?: {"by", "since", "logins"}}, set by people through the server. shared is who lets anyone in the workspace,
// and its agents, start runs of the series as them: a wake starts a new instance run by them with the logins they ticked then, and
// in their instances anyone's comments, uploads and wakes start runs.
export type SeriesSettings = { shared?: { by: string; since: string; logins: string[] } };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

// notes/: a series' notes thread, log.jsonl, append-only, by seq, and files/, their attachments, which its runs read at
// <series>/.notes/. A `note`, n and its seq, is open until a `taken` or an `aside` entry settles it, `on` its seq.
export type Note = Entry & { settled?: Entry };
const log = (seriesDir: string) => readLines<Entry>(join(seriesDir, 'notes', 'log.jsonl'));

export function notes(seriesDir: string): Note[] {
  const all = log(seriesDir);
  return all.filter(e => e.op === 'note').map(n => ({ ...n, settled: all.find(e => e.on === n.seq) }));
}

export function addNote(seriesDir: string, by: string, op: 'note' | 'taken' | 'aside', fields: Record<string, unknown>): Entry {
  mkdirSync(join(seriesDir, 'notes'), { recursive: true });
  const e = { seq: log(seriesDir).length + 1, at: new Date().toISOString(), by, op, ...fields };
  appendLine(join(seriesDir, 'notes', 'log.jsonl'), JSON.stringify(e));
  changes.emit('change', 'tree');
  return e;
}
