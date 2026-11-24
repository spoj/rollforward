import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { parseArgs } from 'node:util';

// The agent's rf calls /api as a run; /agent holds what only a run has.
const HELP: Record<string, string> = {
  show: `rf show
  Prints the screen, {"rev", "status", "items"}.`,
  put: `rf put FILE|-
  Replaces the screen with FILE, which carries the rev you last read. It fails if the screen moved since (people may have
  uploaded): run rf show and merge. It fails, with the reasons, unless every item has a unique id, a name and a kind (input,
  step or output); from names items, never in a circle; file is null or an existing file under upload/ or working/; and status
  is left out or as it is.`,
  comment: `rf comment TARGET [--in cN | --on ITEM[@REF]] [--ask | --propose] [--to EMAIL] [--request] [--for cN|nN] TEXT|-
rf comment SERIES [--json]
rf comment --mine [--json]
  TARGET is . for your own instance, or a relative path such as ../<label> for another instance or .. for your series.
  --in replies under cN. --on starts a thread on an item or a place in its file, such as ar-aging@Sheet1!C22.
  In TEXT, [name](PATH) links a file and ![name](PATH) shows an image. Link a comment with cN, [name](#cN), or
  [name](../<label>#cN) for another instance. - reads TEXT from stdin.
  In your own instance, --ask asks for information and --propose asks for approval to act. Either waits on --to EMAIL,
  else the series owner.
  A collaborator's approval records content approval, not execution authority. Before acting on an approval, use git diff
  against the signoff commit to check that what you use is unchanged. Comments are not proposal decisions.
  --request marks a request to propose, not authority to act. --for links a proposal to the message it addresses.
  Without TEXT, list a series' notes; --mine lists your own notes.`,
  settle: `rf settle ID taken|aside|withdrawn [--see cN] TEXT|-
  ID is cN in your instance or nN in its series. Say where you acted (taken), why you set it aside (aside), or why you
  withdraw a pending question or proposal (withdrawn). --see links a comment in your instance. - reads TEXT from stdin.`,
  commit: `rf commit [-m] MESSAGE|-
  Commits your instance's whole folder as it is now, in your name, to its history: the folder is a repository, which only the
  server commits; read it with git log, show or diff, such as git diff HEAD -- working. Each run's end commits it too, in your
  name, and an approval and closing, in the name of whoever approved or closed.`,
  wake: `rf wake TARGET AT [--label LABEL] [--days DAYS] [--check PATH [--deadline ISO]] [TEXT] | rf wake --cancel ID
  Requests a later run, with who woke it and TEXT. Execution requires the target owner's autonomous consent and a valid
  authority snapshot; otherwise it waits as a request for that owner. TARGET is a folder as you see
  it, by the names your run started with: an open instance, such as . for your own, ../<label> or ../../<series>/<label>, which
  the wake continues; or a series, such as .. or ../../<series>, which it starts a new instance of, labelled LABEL, or continues
  the one it has by that label. AT is now, +<n>m, +<n>h, +<n>d, or a date and time with its offset, such as
  2026-09-14T07:00+08:00. --days, such as mon-fri or mon,wed,fri, repeats it each week on those days at AT's time; a series'
  LABEL then holds the date AT falls on, or that of the day before it that it fires on, and moves on with it. A target has as many wakes as are set, firing at least 15 minutes
  apart; setting a series' wake for a LABEL already pending moves it. Each run's first message lists the wakes pending for
  its instance and series, by ID, which --cancel cancels. A closed instance can't be woken: to correct one, wake its series
  with --label <its label>-r2.
  With the owner's wake-check capability, --check working/FILE.py or working/FILE.ts checks a wake of your own series in the
  read-only sandbox, with rf show and the selected indexes. Print just {"decision":"stop","message":"No new files"} or
  {"decision":"continue","message":"New file found"}. Errors fall through to Pi. --deadline TIME (ISO with offset) makes Pi
  run by that time even if the check would stop.`,
  correct: `rf correct PATH [--on ITEM[@REF]] --wrong|--superseded [--in THREAD] TEXT|-
  Says that a closed instance of your workspace, such as ../<label>, or an item of it, at a place in its file if given, is wrong
  or superseded, and why, as a later entry it keeps; it is never changed. It links your instance, and THREAD of yours, where the
  change is; each run's first message lists the corrections on the instances before it. - reads TEXT from stdin.`,
  delivered: `rf delivered ITEM --to WHERE --receipt WHAT
  Records that you delivered the output ITEM outside: where to, such as "E1, batch 4471" or the mail's recipients, and what
  proves it, such as the document number a website gave, or the Message-ID or the file's id and eTag Microsoft 365 gave.`,
  expired: `rf expired NAME
  Says the website NAME signed your series owner out, as when it shows its sign-in page: its browser closes, your series owner is asked to
  sign in again, and the instance carries on once they do.`,
};
const USAGE = `${Object.values(HELP).map(h => h.split('\n  ')[0]).join('\n')}\nrf help COMMAND`;
const [cmd, ...args] = process.argv.slice(2);
const anchorOptions = '[--in cN | --on ITEM[@REF]]';
const REPLACEMENTS = new Map([
  ['note', cmd === 'note' && args.includes('--taken') ? 'Use rf settle nN taken [--see cN] TEXT'
    : cmd === 'note' && args.includes('--aside') ? 'Use rf settle nN aside TEXT'
    : 'Use rf comment SERIES TEXT; to settle a note, use rf settle nN taken|aside TEXT'],
  ['say', `Use rf comment ${cmd === 'say' && args.includes('--at') ? 'PATH' : '.'} ${anchorOptions} TEXT`],
  ['ask', `Use rf comment . --ask ${anchorOptions} [--to EMAIL] TEXT`],
  ['propose', `Use rf comment . --propose ${anchorOptions} [--to EMAIL] TEXT`],
  ['withdraw', 'Use rf settle cN withdrawn [--see cM] TEXT'],
  ['wakes', 'Pending wakes are listed in your first message; use rf wake TARGET AT ... or rf wake --cancel ID'],
]);
// node:http, not fetch, which gives up on an answer after 5 minutes.
const send = (method: string, path: string, body?: string | Buffer) => new Promise<{ ok: boolean; status: number; text: string }>((ok, fail) => {
  const req = request(`${process.env.RF_URL}/${path}`, { method, headers: { authorization: `Bearer ${process.env.RF_TOKEN}` } }, res => {
    const chunks: Buffer[] = [], status = res.statusCode!;
    res.on('data', c => chunks.push(c)).on('end', () => ok({ ok: status < 300, status, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', fail).end(body);
});
const usage = (c?: string) => ({ ok: false, text: c && HELP[c] ? HELP[c] : USAGE });

const instance = process.env.RF_INSTANCE, own = `api/instances/${instance}`;

async function comment() {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      in: { type: 'string' }, on: { type: 'string' }, ask: { type: 'boolean' }, propose: { type: 'boolean' },
      to: { type: 'string' }, request: { type: 'boolean' }, for: { type: 'string' }, mine: { type: 'boolean' }, json: { type: 'boolean' },
    } });
  } catch (e) { return { ok: false, text: (e as Error).message }; }
  const { values: { mine, json, ...flags }, positionals: [target, ...words] } = parsed;
  const writing = words.length > 0;
  if ((mine && target !== undefined) || (writing ? json : Object.keys(flags).length)) return usage('comment');

  let listed;
  if (mine) {
    listed = await send('GET', 'api/messages?mine=1');
    // A run has no legacy reader to fall back to.
    if (listed.status === 404 || listed.status === 405) return { ok: false, text: 'This server does not support rf comment --mine for runs.' };
  } else {
    if (!target?.trim() || /^(?:[-/]|[a-z][a-z\d+.-]*:)|[\\\x00-\x1f\x7f\x85\u2028\u2029]/i.test(target))
      return { ok: false, text: 'rf comment needs a relative target path (such as . or ..), or --mine' };
    const { in: thread, on, ask, propose, to, request, for: source } = flags;
    const at = on?.indexOf('@') ?? -1, item = at < 0 ? on : on!.slice(0, at), ref = at < 0 ? undefined : on!.slice(at + 1);
    if (thread !== undefined && (on !== undefined || !/^c[1-9]\d*$/.test(thread))) return { ok: false, text: 'Use --in cN or --on ITEM[@REF], not both' };
    if (on !== undefined && (!item?.trim() || (ref !== undefined && !ref.trim()))) return { ok: false, text: 'Use --on ITEM[@REF]' };
    if ((ask && propose) || (to !== undefined && (!(ask || propose) || !/^[^\s@]+@[^\s@]+$/.test(to))))
      return { ok: false, text: 'Use --ask or --propose, with optional --to EMAIL' };
    if (source !== undefined && (!propose || !/^[cn][1-9]\d*$/.test(source))) return { ok: false, text: '--for cN|nN requires --propose' };
    const wordsText = words.join(' '), text = wordsText === '-' ? readFileSync(0, 'utf8') : wordsText;
    if (writing && !text.trim()) return usage('comment');

    let targetAt = { id: instance, kind: 'instance' };
    if (target !== '.' || !instance) {
      const found = await send('GET', `api/resolve?path=${encodeURIComponent(target)}`);
      if (!found.ok) return found;
      targetAt = JSON.parse(found.text);
    }
    const { id, kind } = targetAt;
    if (kind === 'series' && (thread !== undefined || on !== undefined || ask || propose))
      return { ok: false, text: 'Use an instance for --in, --on, --ask or --propose' };
    if (writing) return send('POST', 'api/messages', JSON.stringify({
      ...(kind === 'series' ? { series: id } : { instance: id }), text, thread, item, ref,
      ask: ask ? 'question' : propose ? 'proposal' : undefined, to, request, for: source,
    }));
    if (kind !== 'series') return { ok: false, text: `${target} is an instance: name its series to list notes` };
    listed = await send('GET', `api/series/${id}/notes`);
  }
  if (!listed.ok || json) return listed;
  const messages: {
    id?: string; path?: string; request?: true; seq: number; at: string; by: string; text: string;
    settled?: { how?: string; op?: string; by: string; text: string };
  }[] = JSON.parse(listed.text);
  return { ok: true, text: messages.map(n => {
    const how = n.settled?.how ?? n.settled?.op;
    const state = n.settled ? `${how === 'aside' ? 'set aside' : how} by ${n.settled.by}: ${n.settled.text}` : 'open';
    return `${n.path ? `${n.path}#` : ''}${n.id ?? `n${n.seq}`}  ${n.at}  ${n.by}  ${state}${n.request ? ' (request to propose)' : ''}\n  ${n.text}`;
  }).join('\n') || 'No messages.' };
}

// rf wake TARGET AT [--label LABEL] [--days DAYS] [TEXT]: the folder becomes an id, then the wake is set as a person sets one.
const wake = async () => {
  const o: Record<string, string> = {}, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = /^--(label|days|cancel|check|deadline)$/.exec(args[i])?.[1];
    if (flag) o[flag] = args[++i];
    else rest.push(args[i]);
  }
  if (o.cancel !== undefined && !rest.length) return send('DELETE', `api/wakes/${o.cancel}`);
  const [target, at, ...words] = rest;
  if (!target || !at) return usage('wake');
  const found = await send('GET', `api/resolve?path=${encodeURIComponent(target)}`);
  if (!found.ok) return found;
  const { id, kind } = JSON.parse(found.text), set = await send('PUT', `api/wakes/${id}`, JSON.stringify({ at, label: o.label, days: o.days, check: o.check, deadline: o.deadline, text: words.join(' ') || undefined }));
  if (!set.ok) return set;
  const k = JSON.parse(set.text);
  return { ok: true, text: `set: ${target} ${kind === 'series' ? `starts ${k.label}` : 'wakes'} at ${k.at}${k.days ? `, then each ${k.days.join(', ')}` : ''} (wake ${k.id})${k.check ? `; check ${k.check}${k.deadline ? ` until ${k.deadline}` : ''}` : ''}` };
};

// rf correct PATH …: the folder becomes an id, then the correction goes to that instance.
const correct = async () => {
  const o: Record<string, string> = {}, words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = /^--(on|in|wrong|superseded)$/.exec(args[i])?.[1];
    if (flag === 'wrong' || flag === 'superseded') o.kind = o.kind ? 'both' : flag;
    else if (flag && args[i + 1] !== undefined) o[flag] = args[++i];
    else words.push(args[i]);
  }
  const [path, ...said] = words, text = said.join(' ') === '-' ? readFileSync(0, 'utf8') : said.join(' ');
  if (!path || !text.trim() || !o.kind || o.kind === 'both') return usage('correct');
  const found = await send('GET', `api/resolve?path=${encodeURIComponent(path)}`);
  if (!found.ok) return found;
  const at = o.on?.indexOf('@') ?? -1, item = at >= 0 ? o.on!.slice(0, at) : o.on, ref = at >= 0 ? o.on!.slice(at + 1) : undefined;
  return send('POST', `api/instances/${JSON.parse(found.text).id}/correct`, JSON.stringify({ kind: o.kind, item, ref, text, thread: o.in }));
};

async function settle() {
  const [id, how, ...tail] = args;
  let parsed;
  try { parsed = parseArgs({ args: tail, allowPositionals: true, options: { see: { type: 'string' } } }); }
  catch (e) { return { ok: false, text: (e as Error).message }; }
  const { values: { see }, positionals } = parsed;
  if (!/^[cn][1-9]\d*$/.test(id ?? '') || !['taken', 'aside', 'withdrawn'].includes(how) ||
      (how === 'withdrawn' && !id.startsWith('c')) || (see !== undefined && !/^c[1-9]\d*$/.test(see))) return usage('settle');
  const words = positionals.join(' '), text = words === '-' ? readFileSync(0, 'utf8') : words;
  if (!text.trim()) return usage('settle');
  if (!instance) return { ok: false, text: 'rf settle needs RF_INSTANCE' };
  return send('POST', 'api/messages', JSON.stringify({ instance, id, how, text, see }));
}

let res;
const replacement = REPLACEMENTS.get(cmd);
if (replacement) res = { ok: false, text: replacement };
else if (cmd === 'show') res = await send('GET', `${own}/screen`);
else if (cmd === 'put' && args[0]) res = await send('PUT', `${own}/screen`, readFileSync(args[0] === '-' ? 0 : args[0]));
else if (cmd === 'comment') res = await comment();
else if (cmd === 'settle') res = await settle();
else if (cmd === 'wake') res = await wake();
else if (cmd === 'correct') res = await correct();
else if (cmd === 'commit') {
  const words = args[0] === '-m' ? args.slice(1) : args, message = words.join(' ') === '-' ? readFileSync(0, 'utf8') : words.join(' ');
  res = message.trim() ? await send('POST', `${own}/commit`, JSON.stringify({ message })) : usage('commit');
}
else if (['expired', 'delivered'].includes(cmd) && args.length >= 1) res = await send('POST', `agent/${cmd}`, JSON.stringify({ args }));
else if (cmd === 'help') res = { ok: true, text: REPLACEMENTS.get(args[0]) ?? HELP[args[0]] ?? USAGE };
else res = usage(cmd);
(res.ok ? console.log : console.error)(res.text);
process.exitCode = res.ok ? 0 : 1;
