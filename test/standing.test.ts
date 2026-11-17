import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance, instances, openStore, type Entry, type Instance } from '../src/store.ts';
import { initSystem, saveTree, tree, writeJson } from '../src/system.ts';
import { ownSeries } from './owner-fixture.ts';
import { idp } from './idp.ts';
import { committed } from '../src/git.ts';

delete process.env.OPENROUTER_API_KEY;
process.env.RF_MIN_FREE_GB = '0';
const entra = await idp();
Object.assign(process.env, entra.env('http://127.0.0.1:1'));
const { active, byToken, fire, message, retireSeries, setWake, standing, startWith, kick, view, wakes } = await import('../src/waker.ts');
const { authority } = await import('../src/logins.ts');
const { addNote, notes } = await import('../src/series.ts');
const { keepSignIn } = await import('../src/entra.ts');
const tmp = mkdtempSync(join(tmpdir(), 'rf-standing-')), alice = 'alice@demo.test', bob = 'bob@demo.test', carol = 'carol@demo.test';
initSystem(tmp);
openStore(tmp);
const series: Record<string, { name: string; workspace: string }> = {};
let n = 0;
function seriesOf(autonomous: boolean, owner = alice): string {
  const id = `s${++n}`;
  series[id] = { name: `Series ${n}`, workspace: 'w' };
  saveTree({ workspaces: { ...tree().workspaces, w: { name: 'Acme', owners: [alice], members: [bob, carol] } }, series });
  ownSeries(id, owner, [], autonomous);
  return id;
}
writeJson('users.json', { [alice]: { role: 'user' }, [bob]: { role: 'user' }, [carol]: { role: 'user' } });
for (const p of [alice, bob, carol]) keepSignIn(p, entra.refresh(p));
after(async () => {
  await Promise.all(Object.keys(series).map(retireSeries));
  await Promise.all(Object.keys(series).flatMap(s => instances(s).map(i => committed(i.dir))));
  entra.close();
  rmSync(tmp, { recursive: true, force: true });
});

const make = (autonomous: boolean, owner = alice) => createInstance(seriesOf(autonomous, owner), `i${n}`, carol);
const runs = (i: Instance) => i.log.filter(e => e.op === 'run').length;
async function started(i: Instance) {
  kick(i);
  for (let k = 0; k < 40 && !runs(i); k++) await new Promise(r => setTimeout(r, 50));
  return runs(i) > 0;
}
const word = (i: Instance, e: Entry) => standing(i, e)!.word;

for (const autonomous of [false, true]) describe(`standing with autonomous consent ${autonomous}`, { concurrency: true }, () => {
  test('only owner comments, uploads, approvals and rejections are executable instructions', async () => {
    const i = make(autonomous), ask = i.append('agent', 'comment', { thread: 'c2', text: 'Send it?', ask: 'proposal' });
    for (const e of [i.append(alice, 'upload', { file: 'upload/a.csv', pane: 'in', onto: null, quiet: true }), i.append(alice, 'reject', { thread: 'c2', on: ask.seq, quiet: true }), i.append(alice, 'signoff', { thread: 'c2', on: ask.seq, commit: 'x', quiet: true })])
      assert.deepEqual(standing(i, e), { word: 'runner', starts: false });
    const go = i.append(alice, 'comment', { thread: 'c5', text: 'Go.' });
    assert.deepEqual(standing(i, go), { word: 'runner', starts: true });
    assert.ok(await started(i));
    assert.equal(i.log[0].by, carol, 'the creator is not the execution owner');
    assert.deepEqual(i.log.filter(e => e.op === 'run').map(e => [e.runner, e.initiator]), [[alice, alice]]);
  });

  test('owner and live owner-agent schedules need explicit autonomous consent', async () => {
    const i = make(autonomous), sibling = createInstance(i.seriesId, 'sibling', bob), lease = authority(sibling);
    const a = { inst: sibling, n: 1, runner: alice, authority: lease, token: sibling.id, workspace: 'w', view: view(sibling) } as import('../src/waker.ts').Active;
    active.set(i.seriesId, a); byToken.set(a.token, a);
    setWake(i.id, { at: new Date().toISOString(), from: 'Acme/Series/sibling', inst: sibling.id, text: 'the file is due' });
    active.delete(i.seriesId); byToken.delete(a.token);
    fire();
    if (autonomous) assert.deepEqual(standing(i, i.log.findLast(e => e.op === 'wake')!), { word: 'runner', starts: true });
    else assert.ok(Object.values(wakes().requests).some(r => r.target === i.id));
    assert.equal(await started(i), autonomous);
    const own = make(autonomous);
    setWake(own.id, { at: new Date().toISOString(), from: alice });
    fire();
    assert.equal(await started(own), autonomous);
  });

  test('named replies, approvals and rejections start runs under the owner consent', async () => {
    const i = make(autonomous), ask = i.append('agent', 'comment', { thread: 'c2', text: 'Which rate?', ask: 'question', to: bob });
    const proposal = i.append('agent', 'comment', { thread: 'c3', text: 'Send it?', ask: 'proposal', to: bob });
    assert.deepEqual(standing(i, i.append(bob, 'signoff', { thread: 'c3', on: proposal.seq, commit: 'x' })), { word: 'answer', starts: true });
    const rejected = i.append('agent', 'comment', { thread: 'c5', text: 'Use this?', ask: 'proposal', to: bob });
    assert.deepEqual(standing(i, i.append(bob, 'reject', { thread: 'c5', on: rejected.seq })), { word: 'answer', starts: true });
    const reply = i.append(bob, 'comment', { thread: 'c2', parent: ask.seq, text: 'The new one.' });
    assert.deepEqual(standing(i, reply), { word: 'answer', starts: true });
    assert.ok(await started(i));
    assert.deepEqual(i.log.filter(e => e.op === 'run').map(e => [e.runner, e.initiator]), [[alice, bob]]);
  });

  test('colleague comments, uploads, approvals and rejections are context only', async () => {
    const i = make(autonomous), ask = i.append('agent', 'comment', { thread: 'c2', text: 'Send it?', ask: 'proposal' });
    for (const e of [i.append(bob, 'upload', { file: 'upload/a.csv', pane: 'in', onto: null }), i.append(bob, 'signoff', { thread: 'c2', on: ask.seq, commit: 'x' }), i.append(bob, 'reject', { thread: 'c2', on: ask.seq })]) assert.deepEqual(standing(i, e), { word: 'note', starts: false });
    assert.deepEqual(standing(i, i.append(bob, 'comment', { text: 'Use the new rate.' })), { word: 'note', starts: false });
    assert.equal(await started(i), false);
  });

  test('another instance agent comment never initiates execution', async () => {
    const i = make(autonomous), other = createInstance(i.seriesId, 'other', bob);
    const said = i.append('agent', 'comment', { text: 'The pack went out.', run: 1, runner: alice, see: { inst: other.id, label: other.label }, note: true });
    assert.deepEqual(standing(i, said), { word: 'note', starts: false });
    assert.equal(await started(i), false);
  });

  test('a series note starts nothing and reaches the first message with its author', async () => {
    const i = make(autonomous);
    addNote(i.series(), bob, 'note', { text: 'From October the rate is 5%' });
    assert.match(message(i, 1, i.log, true, notes(i.series())), new RegExp(`Open notes on the series: n1, from ${bob} <${bob}> at [^,]+, "From October the rate is 5%"`));
    assert.equal(await started(i), false);
  });

  test('a collaborator wake becomes a request, never an executable wake', async () => {
    const i = make(autonomous);
    setWake(i.id, { at: new Date().toISOString(), from: bob });
    fire();
    assert.ok(Object.values(wakes().requests).some(r => r.target === i.id && r.from === bob));
    assert.equal(i.log.some(e => e.op === 'wake'), false);
    assert.equal(await started(i), false);
  });

  test('owner Start preserves request provenance and creator without changing authority', async () => {
    const i = startWith(seriesOf(autonomous), 'asked', alice, [{ from: bob, text: 'please start' }, { from: alice }]);
    const [theirs, mine] = i.log.filter(e => e.op === 'wake');
    assert.deepEqual([word(i, theirs), word(i, mine)], ['note', 'runner']);
    assert.equal(theirs.from, bob);
    assert.ok(await started(i));
  });

  test('a transfer makes read context history, unread context notes, and old schedules requests', async () => {
    const i = make(autonomous, bob), read = i.append(bob, 'comment', { text: 'Use HSBC.', quiet: true });
    i.append('server', 'run', { run: 1, runner: bob, initiator: bob, authority: authority(i) });
    i.append('server', 'done', { run: 1, seen: read.seq, cost: 0 });
    const before = i.append(bob, 'comment', { text: 'Cut off at the 25th.', quiet: true });
    const colleague = i.append(carol, 'comment', { text: 'The rate moved.', quiet: true });
    const asked = i.append('agent', 'comment', { thread: 'c7', text: 'Which statement?', ask: 'question', to: carol });
    setWake(i.id, { at: new Date().toISOString(), from: bob });
    ownSeries(i.seriesId, alice, [], autonomous);
    i.append('server', 'authority', { owner: alice, epoch: authority(i).epoch, workspace: 'w', actor: bob });
    assert.equal(standing(i, { ...read, quiet: undefined }), undefined);
    for (const e of [before, colleague]) assert.deepEqual(standing(i, { ...e, quiet: undefined }), { word: 'note', starts: false });
    assert.deepEqual(standing(i, i.append(carol, 'comment', { thread: 'c7', parent: asked.seq, text: 'HSBC.' })), { word: 'answer', starts: true });
    assert.match(message(i, 2, i.log, true), /"text":"Cut off at the 25th\.".*"note":true/);
    fire();
    assert.ok(Object.values(wakes().requests).some(r => r.target === i.id && r.from === bob));
    kick(i);
    for (let k = 0; k < 40 && runs(i) < 2; k++) await new Promise(r => setTimeout(r, 50));
    assert.equal(runs(i), 2);
    assert.equal(i.log.filter(e => e.op === 'run').at(-1)!.runner, alice);
  });
});

for (const status of ['closed', 'abandoned'] as const) for (const hadRun of [false, true]) test(`${status} ${hadRun ? 'post-run' : 'zero-run'} acts are settled history across authority changes`, () => {
  const i = make(true);
  if (hadRun) {
    const read = i.append(alice, 'comment', { text: 'Read before closing.' });
    i.append('server', 'run', { run: 1, runner: alice, initiator: alice, authority: authority(i) });
    i.append('server', 'done', { run: 1, seen: read.seq, cost: 0.25 });
  }
  const acts = [alice, carol].flatMap(by => ['comment', 'upload', 'signoff', 'reject'].map(op => i.append(by, op, { text: 'After the last run.' })));
  acts.push(i.append('server', 'wake', { from: alice, initiator: alice, authority: authority(i) }));
  const note = i.append(carol, 'comment', { text: 'An explicit old note.', note: true });
  i.doc.status = status;
  const bytes = JSON.stringify(i.log), settled = acts.map(() => undefined);
  assert.deepEqual(acts.map(e => standing(i, e)), settled);
  assert.deepEqual(standing(i, note), { word: 'note', starts: false });
  for (const owner of [alice, bob, alice]) {
    ownSeries(i.seriesId, owner, [], false);
    assert.deepEqual(acts.map(e => standing(i, e)), settled);
    assert.deepEqual(standing(i, note), { word: 'note', starts: false });
    assert.equal(JSON.stringify(i.log), bytes);
  }
  series[i.seriesId].workspace = 'destination';
  saveTree({ ...tree(), workspaces: { ...tree().workspaces, destination: { name: 'Destination', owners: [alice], members: [bob, carol] } }, series });
  ownSeries(i.seriesId, bob);
  assert.deepEqual(acts.map(e => standing(i, e)), settled);
  assert.deepEqual(standing(i, note), { word: 'note', starts: false });
  assert.equal(JSON.stringify(i.log), bytes);
});

test('A→B→A never revives an old owner schedule', () => {
  const i = make(true);
  setWake(i.id, { at: new Date(Date.now() + 3600e3).toISOString(), from: alice });
  ownSeries(i.seriesId, carol, [], true);
  ownSeries(i.seriesId, alice, [], true);
  assert.match(message(i, 1, [], true), /from alice@demo\.test, a note/);
});

test('withdrawn, answered, plain and pre-copy asks do not grant answer standing', () => {
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
