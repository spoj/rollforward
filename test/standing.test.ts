import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, openStore, seriesDir, type Entry, type Instance } from '../src/store.ts';
import { initSystem, saveTree, writeJson } from '../src/system.ts';
import { idp } from './idp.ts';

// docs/system.md's table of standing, Runner, a test a cell: who said it, in a series no one shares and in one its runner shares,
// its standing, and whether a run starts, seen as a run's entry; a run ends at once here, for want of a model key.
delete process.env.OPENROUTER_API_KEY;
process.env.RF_WAKE_TICK_MS = '50';
const entra = await idp();
Object.assign(process.env, entra.env('http://127.0.0.1:1'));
const { assigned, message, setWake, standing, startWaking, startWith, kick, wakes } = await import('../src/waker.ts');
const { addNote, notes } = await import('../src/series.ts');
const { keepSignIn } = await import('../src/entra.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-standing-')), alice = 'alice@demo.test', bob = 'bob@demo.test', carol = 'carol@demo.test';
initSystem(tmp);
openStore(tmp);
const series: Record<string, { name: string; workspace: string }> = {};
let n = 0;
// A series of its own for each cell, as one run goes at a time per series; shared, alice lets the workspace wake it as her.
function seriesOf(shared: boolean): string {
  const id = `s${++n}`;
  series[id] = { name: `Series ${n}`, workspace: 'w' };
  saveTree({ workspaces: { w: { name: 'Acme', owners: [alice], members: [bob, carol] } }, series });
  mkdirSync(seriesDir(id), { recursive: true });
  if (shared) writeFileSync(join(seriesDir(id), 'series.json'), JSON.stringify({ shared: { by: alice, since: new Date().toISOString(), logins: [] } }));
  return id;
}
writeJson('users.json', { [alice]: { role: 'user' }, [bob]: { role: 'user' }, [carol]: { role: 'user' } });
for (const p of [alice, bob, carol]) keepSignIn(p, entra.refresh(p));
startWaking();
after(() => (entra.close(), rmSync(tmp, { recursive: true, force: true })));

const make = (shared: boolean, by = alice) => createInstance(seriesOf(shared), `i${n + 1}`, by, []);
const runs = (i: Instance) => i.log.filter(e => e.op === 'run').length;
// Whether a run started on what was kicked, or a wake fired.
async function started(i: Instance, kicked = true) {
  const was = runs(i);
  if (kicked) kick(i);
  for (let k = 0; k < 60 && runs(i) === was; k++) await new Promise(r => setTimeout(r, 50));
  return runs(i) > was;
}
const word = (i: Instance, e: Entry) => standing(i, e)!.word;
const fired = async (i: Instance) => {
  for (let k = 0; k < 60 && !i.log.some(e => e.op === 'wake'); k++) await new Promise(r => setTimeout(r, 50));
  return i.log.findLast(e => e.op === 'wake')!;
};
const COLUMNS = [['unshared', false], ['shared', true]] as const;

describe('standing', { concurrency: true }, () => {
  for (const [column, shared] of COLUMNS) {
    test(`the runner, ${column}: their comment, upload, approval or rejection is their word, which starts a run`, async () => {
      const i = make(shared), ask = i.append('agent', 'comment', { thread: 'c2', text: 'Send it?', ask: 'proposal' });
      for (const e of [i.append(alice, 'upload', { file: 'upload/a.csv', pane: 'in', onto: null, quiet: true }), i.append(alice, 'reject', { thread: 'c2', on: ask.seq, quiet: true }), i.append(alice, 'signoff', { thread: 'c2', on: ask.seq, commit: 'x', quiet: true })])
        assert.deepEqual(standing(i, e), { word: 'runner', starts: false }, 'quiet, it starts nothing');
      const go = i.append(alice, 'comment', { thread: 'c5', text: 'Go.' });
      assert.deepEqual(standing(i, go), { word: 'runner', starts: true });
      assert.ok(await started(i));
    });

    test(`a wake the runner, or a run of an instance of theirs in the series, set, ${column}: their word, which starts a run`, async () => {
      const i = make(shared), sibling = createInstance(i.seriesId, 'sibling', alice, []);
      setWake(i.id, { at: new Date().toISOString(), from: `Acme/Series/${sibling.label}`, inst: sibling.id, text: 'the file is due' });
      const e = await fired(i);
      assert.equal(word(i, e), 'runner');
      assert.ok(await started(i, false));
      const own = make(shared);
      setWake(own.id, { at: new Date().toISOString(), from: alice });
      assert.equal(word(own, await fired(own)), 'runner');
      assert.ok(await started(own, false));
    });

    test(`whom the agent's ask named, answering it, ${column}: an answer, which starts a run`, async () => {
      const i = make(shared), ask = i.append('agent', 'comment', { thread: 'c2', text: 'Which rate?', ask: 'question', to: bob });
      const proposal = i.append('agent', 'comment', { thread: 'c3', text: 'Send it?', ask: 'proposal', to: bob });
      assert.equal(word(i, i.append(bob, 'signoff', { thread: 'c3', on: proposal.seq, commit: 'x', quiet: true })), 'answer');
      const reply = i.append(bob, 'comment', { thread: 'c2', parent: ask.seq, text: 'The new one.' });
      assert.deepEqual(standing(i, reply), { word: 'answer', starts: true });
      assert.ok(await started(i));
    });

    test(`a colleague, ${column}: their comment, upload, approval or rejection is a note, which starts a run only where the series is shared`, async () => {
      const i = make(shared), ask = i.append('agent', 'comment', { thread: 'c2', text: 'Send it?', ask: 'proposal' });
      for (const e of [i.append(bob, 'upload', { file: 'upload/a.csv', pane: 'in', onto: null, quiet: true }), i.append(bob, 'signoff', { thread: 'c2', on: ask.seq, commit: 'x', quiet: true })]) assert.equal(word(i, e), 'note');
      const said = i.append(bob, 'comment', { thread: 'c5', text: 'Use the new rate.' });
      assert.deepEqual(standing(i, said), { word: 'note', starts: shared });
      assert.equal(await started(i), shared);
    });

    test(`another instance's agent, ${column}: its comment is a note, which starts a run only where the series is shared`, async () => {
      const i = make(shared), other = createInstance(i.seriesId, 'other', bob, []);
      const said = i.append('agent', 'comment', { thread: 'c2', text: 'The pack went out.', run: 1, runner: bob, see: { inst: other.id, label: other.label }, note: true });
      assert.deepEqual(standing(i, said), { word: 'note', starts: shared });
      assert.equal(await started(i), shared);
    });

    test(`a note on the series, ${column}: no entry of the instance's, it starts no run, and the run's first message lists it as a note`, async () => {
      const i = make(shared);
      addNote(i.series(), bob, 'note', { text: 'From October the rate is 5%' });
      assert.match(message(i, 1, i.log, true, notes(i.series())), new RegExp(`Open notes on the series: n1, from ${bob} <${bob}> at [^,]+, "From October the rate is 5%"`));
      assert.equal(await started(i), false);
    });

    test(`a wake someone else set, ${column}: a note, which starts a run only where the series is shared`, async () => {
      const i = make(shared);
      setWake(i.id, { at: new Date().toISOString(), from: bob });
      const e = await fired(i);
      assert.deepEqual([e.note, word(i, e)], [true, 'note']);
      assert.equal(await started(i, false), shared);
    });

    test(`the person pressing Start on a request, ${column}: they run the instance it makes, their wake their word, which starts a run, and the request's own a note`, async () => {
      const i = startWith(seriesOf(shared), 'asked', carol, [], [{ from: bob, text: 'please start' }, { from: carol }]), [theirs, mine] = i.log.filter(e => e.op === 'wake');
      assert.deepEqual([word(i, theirs), word(i, mine)], ['note', 'runner']);
      assert.ok(await started(i, false));
    });

    test(`anything from before the last assign, ${column}: what a run had read history, with no standing, and what none had a note, whoever said it, the previous runner too, neither starting anything; an answer to an ask from before it that named someone still theirs; a wake pending from before it fires as a note, a request to the new runner where the series isn't shared`, async () => {
      const i = make(shared, bob), read = i.append(bob, 'comment', { thread: 'c2', text: 'Use the HSBC statement.', quiet: true });
      i.append('server', 'run', { run: 1, runner: bob, consent: 1 });
      i.append('server', 'done', { run: 1, seen: read.seq, cost: 0 });
      const before = i.append(bob, 'comment', { thread: 'c5', text: 'Cut off at the 25th.', quiet: true }), colleague = i.append(carol, 'comment', { thread: 'c6', text: 'The rate moved.', quiet: true });
      const asked = i.append('agent', 'comment', { thread: 'c7', text: 'Which statement?', ask: 'question', to: carol });
      setWake(i.id, { at: new Date(Date.now() + 1500).toISOString(), from: bob });
      i.append(bob, 'assign', { to: alice, from: bob, logins: [] });
      assigned(i);
      assert.equal(standing(i, { ...read, quiet: undefined }), undefined, 'read, it is history');
      for (const e of [before, colleague]) assert.deepEqual(standing(i, { ...e, quiet: undefined }), { word: 'note', starts: false });
      assert.equal(word(i, i.append(carol, 'comment', { thread: 'c7', parent: asked.seq, text: 'HSBC.', quiet: true })), 'answer', 'an answer to an ask from before it is theirs');
      assert.match(message(i, 1, i.log, true), new RegExp(`Its runner is now ${alice} <${alice}>, assigned by ${bob} <${bob}> from ${bob} <${bob}>, who lends you no login\\.[^]*"text":"Cut off at the 25th\\.","quiet":true,"note":true`));
      for (let k = 0; k < 80 && (shared ? !i.log.some(e => e.op === 'wake') : !Object.values(wakes().requests).some(r => r.target === i.id)); k++) await new Promise(r => setTimeout(r, 50));
      if (shared) assert.equal(word(i, i.log.findLast(e => e.op === 'wake')!), 'note');
      else assert.deepEqual(Object.values(wakes().requests).filter(r => r.target === i.id).map(r => [r.from, r.label]), [[bob, i.label]]);
      assert.equal(await started(i), shared, "only the wake, in a series its new runner shares, as anyone's there");
      // An earlier version's takeover is an assign to oneself.
      const old = make(shared, bob), was = old.append(bob, 'comment', { thread: 'c2', text: 'Go.', quiet: true });
      old.append(alice, 'takeover', { from: bob, logins: [] });
      assert.deepEqual(standing(old, { ...was, quiet: undefined }), { word: 'note', starts: false });
    });
  }
});

test("a wake pending as its instance was assigned stays no one's word, though the instance comes back to whoever set it", () => {
  const i = make(false);
  setWake(i.id, { at: new Date(Date.now() + 3600e3).toISOString(), from: alice });
  i.append(alice, 'assign', { to: carol, from: alice, logins: [] });
  assigned(i);
  i.append(carol, 'assign', { to: alice, from: carol, logins: [] });
  assert.match(message(i, 1, [], true), /from alice@demo\.test, a note/);
});

test("a colleague's reply to a withdrawn, already-answered, plain or pre-copy comment is a note, not an answer", () => {
  const i = make(false);
  const withdrawn = i.append('agent', 'comment', { thread: 'c2', text: 'Which rate?', ask: 'question', to: bob });
  i.append('agent', 'withdraw', { thread: 'c2', on: withdrawn.seq, text: 'Found it.' });
  const afterWithdraw = i.append(bob, 'comment', { thread: 'c2', parent: withdrawn.seq, text: 'Use 9%.' });
  assert.deepEqual(standing(i, afterWithdraw), { word: 'note', starts: false });
  assert.match(message(i, 2, [afterWithdraw]), /"note":true/);

  const asked = i.append('agent', 'comment', { thread: 'c3', text: 'Which bank?', ask: 'question', to: bob });
  const first = i.append(bob, 'comment', { thread: 'c3', parent: asked.seq, text: 'HSBC.' });
  const second = i.append(bob, 'comment', { thread: 'c3', parent: asked.seq, text: 'Actually Citi.' });
  assert.deepEqual(standing(i, first), { word: 'answer', starts: true });
  assert.deepEqual(standing(i, second), { word: 'note', starts: false });

  const plain = i.append('agent', 'comment', { thread: 'c4', text: 'FYI.', to: bob });
  assert.deepEqual(standing(i, i.append(bob, 'comment', { thread: 'c4', parent: plain.seq, text: 'Noted.' })), { word: 'note', starts: false });

  const copy = make(false);
  const oldAsk = copy.append('agent', 'comment', { thread: 'c2', text: 'Confirm?', ask: 'question', to: bob });
  copy.append(alice, 'close', { accepted: [`c${oldAsk.seq}`], commit: '0'.repeat(40) });
  copy.append(alice, 'duplicate', { from: 'old', logins: [] });
  assert.deepEqual(standing(copy, copy.append(bob, 'comment', { thread: 'c2', parent: oldAsk.seq, text: 'Change it.' })), { word: 'note', starts: false });
});

