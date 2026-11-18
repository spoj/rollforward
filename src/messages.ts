import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry, Instance } from './store.ts';
import { appendLine, changes, readLines } from './system.ts';

export function isPerson(e: Entry): boolean {
  return e.by !== 'server' && e.by !== 'agent';
}

export function commentAt(log: Entry[], id: unknown): Entry | undefined {
  return log.find(e => e.op === 'comment' && `c${e.seq}` === id);
}

// The parent or on seq disambiguates replies in new logs. A reply does not decide a proposal, an agent cannot answer its own
// question, and close accepts unfinished work without approving it. Legacy `ask: true` takes any of these, including its own
// agent's reply as a withdrawal. Replies in older logs named only the root thread.
export function answered(log: Entry[], c: Entry, upto = log.length): boolean {
  return log.some(e => e.seq > c.seq && e.seq <= upto && (e.op === 'close' && (e.accepted as string[] | undefined)?.includes(`c${c.seq}`) || e.thread === c.thread && (e.on === c.seq ? ['signoff', 'reject', 'withdraw'].includes(e.op)
    : e.parent === c.seq ? e.op === 'comment' && c.ask !== 'proposal' && !(c.ask === 'question' && e.by === 'agent')
    : e.parent === undefined && e.on === undefined && ['comment', 'signoff', 'resolve'].includes(e.op))));
}

// Standing binds to the ask still open immediately before the reply. Legacy replies named only the thread.
export function binds(inst: Instance, e: Entry): Entry | undefined {
  if (e.op === 'upload' || !e.thread) return undefined;
  const on = e.parent ?? e.on;
  const ask = on ? inst.log[(on as number) - 1] : inst.log.findLast(x => x.seq < e.seq && x.op === 'comment' && x.thread === e.thread && x.by === 'agent');
  return ask?.op === 'comment' && ask.by === 'agent' && !!ask.ask && ask.seq > inst.copied && ask.seq < e.seq && ask.thread === e.thread
    && (ask.ask !== 'proposal' || e.op !== 'comment') && !answered(inst.log, ask, e.seq - 1) ? ask : undefined;
}

// In an open instance, unanswered asks wait on their named person or the owner; colleagues' unread notes wait on the owner.
export function waitsOn(inst: Instance, owner: string, opened: number, runSeen: number): { who: string; e: Entry }[] {
  const read = Math.max(inst.copied, opened, runSeen,
    ...inst.log.filter(e => e.op === 'done').map(e => (e.seen as number | undefined) ?? 0),
    inst.log.findLast(e => e.by === owner && ['create', 'comment', 'upload', 'attach', 'signoff', 'reject', 'react', 'rename', 'interrupt', 'promote'].includes(e.op))?.seq ?? 0);
  return inst.log.filter(e => e.seq > inst.copied && (e.by === 'agent'
    ? e.op === 'comment' && (e.ask || e.note) && !answered(inst.log, e)
    : e.seq > read && e.by !== owner && isPerson(e) && ['create', 'comment', 'upload'].includes(e.op)))
    .map(e => ({ who: e.by === 'agent' ? (e.to as string | undefined) ?? owner : owner, e })).filter(({ who }) => !!who);
}

// notes/: a series' notes thread, log.jsonl, append-only, by seq, and files/, their attachments, which its runs read at
// <series>/.notes/. A `note`, n and its seq, is open until a `taken` or an `aside` entry settles it, `on` its seq.
export type Note = Entry & { settled?: Entry };
const noteLog = (seriesDir: string) => readLines<Entry>(join(seriesDir, 'notes', 'log.jsonl'));

export function notes(seriesDir: string): Note[] {
  const all = noteLog(seriesDir);
  return all.filter(e => e.op === 'note').map(n => ({ ...n, settled: all.find(e => e.on === n.seq) }));
}

export function openNotes(entries: Note[]): Note[] {
  return entries.filter(n => !n.settled);
}

export function addNote(seriesDir: string, by: string, op: 'note' | 'taken' | 'aside', fields: Record<string, unknown>): Entry {
  mkdirSync(join(seriesDir, 'notes'), { recursive: true });
  const e = { seq: noteLog(seriesDir).length + 1, at: new Date().toISOString(), by, op, ...fields };
  appendLine(join(seriesDir, 'notes', 'log.jsonl'), JSON.stringify(e));
  changes.emit('change', 'tree');
  return e;
}

type FromRun = { inst: Instance; n: number; runner: string; thread?: string };
type Post = { by: string; text: string } & (
  | { op: 'comment'; inst: Instance; under?: Entry; item?: string | null; ref?: string | null; files: string[]; ask?: 'question' | 'proposal'; to?: string; quiet: boolean; run?: FromRun }
  | { op: 'withdraw'; inst: Instance; on: Entry; see?: Entry; run: FromRun }
  | { op: 'note'; book: string; files: string[]; run?: FromRun }
  | { op: 'taken' | 'aside'; book: string; on: Entry; thread?: string | null; run?: FromRun }
);

export function post(p: Post): Entry {
  const by = p.by, text = p.text.trim();
  if (p.op === 'withdraw') return p.inst.append(by, p.op, { thread: p.on.thread, on: p.on.seq, text, ...(p.see && { see: p.see.seq }), run: p.run.n });

  const run = p.run, away = p.op === 'comment' && run && run.inst !== p.inst;
  const thread = p.op === 'taken' || p.op === 'aside' ? p.thread ?? undefined : run?.thread || undefined;
  const from = run && (p.op !== 'comment' || away) && {
    runner: run.runner,
    see: { inst: run.inst.id, label: run.inst.label, ...(thread !== undefined && { thread }) },
  };
  if (p.op === 'comment') {
    const { inst, under, item, ref, files, ask, to, quiet } = p;
    const said = inst.append(by, 'comment', {
      ...(under ? { thread: under.thread, parent: under.seq } : { thread: `c${inst.log.length + 1}`, item: item ?? null, ref: ref ?? null }),
      text, ...(files.length && { files }),
      ...(run && { run: run.n, ...(ask && { ask, ...(to && { to }) }) }), ...(quiet && { quiet: true }),
      ...(away && { ...from, note: true }),
    });
    if (away) run.inst.append('agent', 'said', { run: run.n, inst: inst.id, label: inst.label, seq: said.seq, thread: said.thread });
    return said;
  }
  return addNote(p.book, by, p.op, {
    ...(p.op !== 'note' && { on: p.on.seq }), text, ...(p.op === 'note' && p.files.length && { files: p.files }),
    ...(run && { run: run.n, ...from }),
  });
}
