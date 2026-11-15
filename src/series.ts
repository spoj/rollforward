import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './store.ts';
import { appendLine, changes, readLines, replaceFile } from './system.ts';

export type SeriesConsent = { by: string; at: string; workspace: string; logins: string[]; autonomous: boolean };
export type SeriesSettings = { version: 1; owner?: string; epoch: number; since: string; consent?: SeriesConsent };
export type Authority = { version: 1; owner: string; epoch: number; workspace: string; logins: string[]; autonomous?: boolean };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json');
  if (!existsSync(p)) return { version: 1, epoch: 0, since: '' };
  const settings = JSON.parse(readFileSync(p, 'utf8'));
  if (settings.version !== 1) throw new Error('legacy series settings require the offline series-owner migration');
  return settings;
}

export function saveSeriesSettings(dir: string, settings: SeriesSettings) {
  mkdirSync(dir, { recursive: true });
  replaceFile(join(dir, 'series.json'), JSON.stringify(settings, null, 1));
  changes.emit('change', 'tree');
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
