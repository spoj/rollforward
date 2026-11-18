import type { Entry, Instance } from './store.ts';
import { appendMessage, noteEntries } from './message-store.ts';

export const isPerson = (e: Entry) => e.by !== 'server' && e.by !== 'agent';

export function commentAt(log: Entry[], id: unknown): Entry | undefined {
  return log.find(e => e.op === 'comment' && `c${e.seq}` === id);
}

type Proof = { owner?: string | null; epoch?: number; workspace?: string };
type Current = { by: string; epoch?: number; workspace?: string };
type History = Pick<Instance, 'log' | 'copied'>;

function conflicts(a: Proof, b: Proof) {
  return (['owner', 'epoch', 'workspace'] as const).some(k => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]);
}

// A later boundary retires every proposal, including those made before authority was stamped. It does not establish their old authority.
export function messageAuthority(log: readonly Entry[], e: Entry, upto = log.length): Proof & { stale: boolean } {
  const run = e.by === 'agent' && e.ask && e.run !== undefined
    ? log.findLast(r => r.seq < e.seq && r.op === 'run' && r.run === e.run) : undefined;
  const lease = (run?.authority ?? {}) as Proof;
  const line = log.findLast(r => r.seq < e.seq && r.op === 'authority');
  const crossed = !!run && !!line && run.seq < line.seq;
  const boundary = (crossed ? log.findLast(r => r.seq < run.seq && r.op === 'authority') : line) as Proof | undefined;
  const after = log.findLast(r => r.seq > e.seq && r.seq <= upto && r.op === 'authority') as Proof | undefined;
  const stamp: Proof = { owner: e.authorityOwner as Proof['owner'], epoch: e.authorityEpoch as Proof['epoch'] };
  const stampedEpoch = stamp.epoch ?? lease.epoch;
  const before = boundary?.epoch !== undefined && stampedEpoch !== undefined && boundary.epoch < stampedEpoch ? undefined : boundary;
  const owner = stamp.owner !== undefined ? stamp.owner : lease.owner ?? before?.owner;
  const epoch = stampedEpoch ?? before?.epoch;
  const workspace = lease.workspace ?? before?.workspace;
  const proof = { ...(owner !== undefined && { owner }), ...(epoch !== undefined && { epoch }), ...(workspace !== undefined && { workspace }) };
  const proposal = e.op === 'comment' && e.by === 'agent' && (e.ask === 'proposal' || e.ask === true);
  return { ...proof, stale: crossed || conflicts(stamp, lease) || !!before && conflicts(proof, before) || !!after && (proposal || conflicts(proof, after)) };
}

export function currentMessage(log: readonly Entry[], e: Entry, current: Current) {
  const proof = messageAuthority(log, e);
  // A transfer may already be saved in series.json when a restart interrupts writing the instance's boundary.
  if ((current.epoch ?? 0) > 1 && proof.epoch === undefined && e.by === 'agent' && (e.ask === 'proposal' || e.ask === true)) return false;
  return !proof.stale && !conflicts(proof, { owner: current.by || null, epoch: current.epoch, workspace: current.workspace });
}

function replyTarget(log: readonly Entry[], e: Entry) {
  const on = e.parent ?? e.on;
  return on !== undefined ? log[(on as number) - 1]
    : log.findLast(x => x.seq < e.seq && x.op === 'comment' && x.thread === e.thread && x.by === 'agent');
}

function responds(log: readonly Entry[], c: Entry, e: Entry, owner?: string): boolean {
  if (e.thread !== c.thread) return false;
  if (e.on === c.seq) return ['signoff', 'reject', 'withdraw'].includes(e.op);
  const legacy = e.parent === undefined && e.on === undefined;
  if (legacy && (e.op === 'signoff' || e.op === 'resolve')) return true;
  if (e.op !== 'comment' || !legacy && e.parent !== c.seq || c.ask === 'proposal') return false;
  if (c.by !== 'agent' || !c.ask || c.ask === true && e.by === 'agent') return true;
  if (!isPerson(e) || e.informs || typeof c.to === 'string' && c.to !== e.by || legacy && replyTarget(log, e)?.seq !== c.seq) return false;
  const asked = messageAuthority(log, c, e.seq), replied = messageAuthority(log, e, e.seq);
  if (asked.stale || replied.stale || conflicts(asked, replied)) return false;
  const to = c.to ?? (replied.owner !== undefined ? replied.owner : asked.owner === undefined ? owner : asked.owner);
  return e.by === to || c.ask === true && c.to === undefined && asked.owner === undefined && asked.epoch === undefined;
}

// A close accepts work without approving it; recorded verdicts and historical replies are read as of their own sequence.
export function answered(log: readonly Entry[], c: Entry, upto = log.length, owner?: string): boolean {
  return log.some(e => e.seq > c.seq && e.seq <= upto &&
    (e.op === 'close' && (e.accepted as string[] | undefined)?.includes(`c${c.seq}`) || responds(log, c, e, owner)));
}

export function answers(inst: History, e: Entry, current?: Current): Entry | undefined {
  if (!isPerson(e) || !e.thread || !['comment', 'signoff', 'reject'].includes(e.op)) return undefined;
  const { log, copied } = inst, ask = replyTarget(log, e);
  if (ask?.op !== 'comment' || ask.by !== 'agent' || !ask.ask || ask.seq <= copied || ask.seq >= e.seq ||
    !responds(log, ask, e, current?.by)) return undefined;
  if (e.op !== 'comment') {
    const asked = messageAuthority(log, ask, e.seq), replied = messageAuthority(log, e, e.seq);
    if (ask.ask === 'question' || asked.stale || replied.stale || conflicts(asked, replied)) return undefined;
  }
  return (!current || currentMessage(log, ask, current) && currentMessage(log, e, current)) &&
    !answered(log, ask, e.seq - 1, current?.by) ? ask : undefined;
}

export function binds(inst: History, e: Entry, owner: string | undefined, current: Current & { epoch: number }): 'runner' | 'answer' | 'note' {
  if (e.informs || e.note) return 'note';
  if (e.by === owner) {
    if (e.op === 'signoff' || e.op === 'reject') {
      const ask = replyTarget(inst.log, e);
      if (ask?.by === 'agent' && ask.ask && (ask.seq <= inst.copied || !currentMessage(inst.log, ask, current))) return 'note';
    }
    return 'runner';
  }
  return answers(inst, e, current)?.to === e.by ? 'answer' : 'note';
}

// The converter omits current authority to also find legacy unread FYIs before it records them as notes.
export function waitsOn(inst: History, owner: string, opened: number, runSeen: number, current?: Omit<Current, 'by'>): { who: string; e: Entry }[] {
  const read = Math.max(inst.copied, opened, runSeen,
    ...inst.log.filter(e => e.op === 'done').map(e => (e.seen as number | undefined) ?? 0),
    inst.log.findLast(e => e.by === owner && ['create', 'comment', 'upload', 'attach', 'signoff', 'reject', 'react', 'rename', 'interrupt', 'promote'].includes(e.op))?.seq ?? 0);
  const now = { ...current, by: owner };
  return inst.log.filter(e => e.seq > inst.copied && (e.by === 'agent'
    ? e.op === 'comment' && (e.ask ? currentMessage(inst.log, e, now) : e.note && !current) && !answered(inst.log, e, inst.log.length, owner)
    : e.seq > read && e.by !== owner && isPerson(e) && ['create', 'comment', 'upload'].includes(e.op) &&
      (e.op !== 'comment' || !e.informs && (!current || answers(inst, e, now)?.to === e.by))))
    .map(e => ({ who: e.by === 'agent' ? (e.to as string | undefined) ?? owner : owner, e })).filter(({ who }) => !!who);
}

export type NoteId = `c${number}` | `n${number}`;
export type NoteAnchor = { inst: string; seq: number; label: string; item?: string; ref?: string };
export type Note = Entry & { id?: NoteId; anchor?: NoteAnchor; request?: true; settled?: Entry; proposal?: NoteAnchor };
export type ScopedNote = Note & { id: NoteId };
export type NoticeKind = 'open' | 'settled';
export type Notice = { id: NoteId; kind: NoticeKind; by: string; at: string; label: string; text: string; anchor?: NoteAnchor };
type MessageRow = { anchor: { instance?: string; item?: string; ref?: string }; entry: Entry; legacyOpen?: boolean };

// cN belongs to an instance, nN to its series. Index both, then apply verdicts and pending proposals in log order.
export function conversation(rows: readonly MessageRow[], instances: readonly Instance[], epoch: number) {
  const byId = new Map(instances.map(i => [i.id, i]));
  const notes = new Map<string, ScopedNote>(), proposals = new Map<string, ScopedNote>(), dismissed = new Set<string>();
  for (const row of rows) {
    const { entry: e, anchor } = row, i = anchor.instance ? byId.get(anchor.instance) : undefined;
    if (anchor.instance && (!i || i.hole || e.seq <= i.copied)) continue;
    const scope = i?.id ?? '';
    if (e.op === 'note' && !i || i && e.op === 'comment' && (e.informs === true || row.legacyOpen)) {
      const id = `${i ? 'c' : 'n'}${e.seq}` as NoteId;
      const at = i && { inst: i.id, seq: e.seq, label: i.label, ...(anchor.item && { item: anchor.item }), ...(anchor.ref && { ref: anchor.ref }) };
      notes.set(`${scope}/${id}`, { ...e, id, ...(at && { anchor: at }) });
    } else if (e.op === 'note-verdict' && !i) {
      const note = notes.get(`/n${e.on}`);
      if (note && !note.settled) {
        note.settled = { seq: e.seq, at: e.at, by: e.by, op: e.how as string,
          text: e.how === 'taken' ? 'The owner approved the proposal.' : 'The owner rejected the proposal.' };
        delete note.proposal;
      }
    } else if (e.op === 'taken' || e.op === 'aside' || e.op === 'settle') {
      const note = notes.get(`${scope}/${i ? 'c' : 'n'}${e.on}`);
      if (note && !note.settled) { note.settled = e.op === 'settle' ? { ...e, op: e.how as string } : e; delete note.proposal; }
    } else if (i && e.op === 'comment' && typeof e.settlesNote === 'number') {
      const note = notes.get(`${scope}/c${e.settlesNote}`);
      if (note && !note.settled && !note.request && !note.proposal) {
        note.settled = { seq: e.seq, at: e.at, by: e.by, op: 'taken', text: 'The owner replied.', see: { inst: i.id, label: i.label, thread: `c${e.seq}` } };
      }
    } else if (e.op === 'dismiss-note') {
      dismissed.add(JSON.stringify([scope, e.on, e.by, e.notice]));
    } else if (i && e.op === 'comment' && e.ask === 'proposal' && typeof e.noteFor === 'string') {
      const note = notes.get(`${e.noteFor.startsWith('c') ? i.id : ''}/${e.noteFor}`);
      if (note && !note.settled) {
        proposals.set(`${scope}/${e.seq}`, note);
        const proof = messageAuthority(i.log, e);
        if (e.noteEpoch === epoch && !proof.stale && (proof.epoch === undefined || proof.epoch === epoch) && i.doc.status === 'open' && !answered(i.log, e))
          note.proposal = { inst: i.id, seq: e.seq, label: i.label };
      }
    } else if (i && (e.op === 'signoff' || e.op === 'reject') && e.noteDecision === true) {
      const note = typeof e.noteFor === 'string' && typeof e.on === 'number' && e.on > i.copied
        ? notes.get(`${e.noteFor.startsWith('c') ? i.id : ''}/${e.noteFor}`) : proposals.get(`${scope}/${e.on}`);
      if (note && !note.settled) {
        note.settled = { seq: e.seq, op: e.op === 'signoff' ? 'taken' : 'aside', at: e.at, by: e.by,
          text: e.op === 'signoff' ? 'The owner approved the proposal.' : 'The owner rejected the proposal.', see: { inst: i.id, label: i.label, thread: `c${e.on}` } };
        delete note.proposal;
      }
    }
  }
  return { notes: [...notes.values()], dismissed };
}

export function openNotes<T extends Note>(notes: readonly T[], instance?: string): T[] {
  return notes.filter(n => !n.settled && (instance === undefined || !n.anchor || n.anchor.inst === instance));
}

export function notes(dir: string): Note[] {
  const all = noteEntries(dir), settled = new Map<number, Entry>();
  for (const e of all) if (typeof e.on === 'number' && e.op !== 'note' && !settled.has(e.on)) settled.set(e.on, e);
  return all.filter(e => e.op === 'note').map(n => ({ ...n, settled: settled.get(n.seq) }));
}

export function addNote(dir: string, by: string, op: 'note' | 'taken' | 'aside', fields: Record<string, unknown>): Entry {
  return appendMessage(dir, {}, { seq: noteEntries(dir).length + 1, at: new Date().toISOString(), by, op, ...fields }).entry;
}

type FromRun = { inst: Instance; n: number; runner: string; thread?: string; authority?: { epoch: number } };
type Post = { by: string; text: string } & (
  | { op: 'comment'; inst: Instance; under?: Entry; item?: string | null; ref?: string | null; files: string[]; ask?: 'question' | 'proposal'; to?: string; quiet: boolean; run?: FromRun; word?: 'runner' | 'answer' | 'note'; request?: boolean; noteFor?: NoteId }
  | { op: 'withdraw'; inst: Instance; on: Entry; see?: Entry; run: FromRun }
  | { op: 'note'; book: string; files: string[]; run?: FromRun; request?: boolean }
  | { op: 'taken' | 'aside'; book: string; inst?: Instance; on: Entry; thread?: string | null; run?: FromRun }
);

export function post(p: Post): Entry {
  const { by, run } = p, text = p.text.trim();
  if (p.op === 'withdraw') return p.inst.append(by, p.op, { thread: p.on.thread, on: p.on.seq, text, ...(p.see && { see: p.see.seq }), run: p.run.n });

  const away = p.op === 'comment' && run && run.inst !== p.inst;
  const thread = p.op === 'taken' || p.op === 'aside' ? p.thread ?? undefined : run?.thread || undefined;
  const from = run && (p.op !== 'comment' || away) && {
    runner: run.runner,
    see: { inst: run.inst.id, label: run.inst.label, ...(thread !== undefined && { thread }) },
  };
  if (p.op === 'comment') {
    const { inst, under, item, ref, files, ask, to, quiet } = p;
    const said = inst.append(by, 'comment', {
      ...(under ? { thread: under.thread, parent: under.seq } : { thread: `c${inst.log.length + 1}`, item: item ?? null, ref: ref ?? null }),
      text, ...(files.length && { files }), ...(quiet && { quiet: true }),
      ...((away || p.word === 'note') && { informs: true }), ...(p.request && { request: true }),
      ...(p.word === 'runner' && under && { settlesNote: under.seq }),
      ...(run && { run: run.n, ...(ask && { ask, ...(to && { to }), ...(run.authority && { authorityOwner: run.runner, authorityEpoch: run.authority.epoch }) }) }),
      ...(p.noteFor && { noteFor: p.noteFor, noteEpoch: run?.authority?.epoch }),
      ...(away && { ...from, note: true }),
    });
    if (away) run.inst.append('agent', 'said', { run: run.n, inst: inst.id, label: inst.label, seq: said.seq, thread: said.thread });
    return said;
  }
  const fields = { ...(p.op !== 'note' && { on: p.on.seq }), text,
    ...(p.op === 'note' && { ...(p.files.length && { files: p.files }), ...(p.request && { request: true }) }), ...(run && { run: run.n, ...from }) };
  return p.op !== 'note' && p.inst ? p.inst.append(by, 'settle', { ...fields, how: p.op }) : addNote(p.book, by, p.op, fields);
}

export function notices(notes: readonly ScopedNote[], dismissed: Set<string>, email: string, owner: string | undefined, series: string): Notice[] {
  return notes.flatMap(n => {
    const kind: NoticeKind = n.settled ? 'settled' : 'open';
    if ((n.settled ? n.by !== email : email !== owner || email === n.by) || dismissed.has(JSON.stringify([n.anchor?.inst ?? '', n.seq, email, kind]))) return [];
    return [{ id: n.id, kind, by: n.by, at: n.settled?.at ?? n.at, label: n.anchor?.label ?? series, text: (n.settled?.text ?? n.text) as string, ...(n.anchor && { anchor: n.anchor }) }];
  });
}
