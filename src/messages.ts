import type { Entry } from './store.ts';

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
