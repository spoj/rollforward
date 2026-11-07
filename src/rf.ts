import { readFileSync } from 'node:fs';
import { request } from 'node:http';

// The agent's rf. For its own instance it calls the people's API (/api), as a run; /agent holds what only a run has.
const HELP: Record<string, string> = {
  show: `rf show
  Prints the screen, {"rev", "status", "items"}.`,
  put: `rf put FILE|-
  Replaces the screen with FILE, which carries the rev you last read. It fails if the screen moved since (people may have
  uploaded): run rf show and merge. It fails, with the reasons, unless every item has a unique id, a name and a kind (input,
  step or output); from names items, never in a circle; file is null or an existing file under upload/ or working/; and status
  is left out or as it is.`,
  say: `rf say [--in cN | --on ITEM[@REF]] [--pin PATH]... TEXT|-
  Tells people something that needs no reply. --in replies under comment cN, its seq N, a thread's id its first comment's, so
  a reply under your own ask withdraws it; --on starts a thread on an item, at a place in its file
  such as ar-aging@Sheet1!C22, or a markdown file's line by its opening words; neither starts one on the instance. --pin shows
  a file the comment rests on, under upload/ or working/ of this instance or of another of its series, as
  ../<label>/working/x.csv, as it is now: its sha256 is kept, and this instance's is made read-only, so write a changed one
  under a new name. An image (png, jpg, gif, webp, svg) shows in the thread. - reads TEXT from stdin.`,
  ask: `rf ask [--in cN | --on ITEM[@REF]] [--to EMAIL] [--pin PATH]... TEXT|-
  Asks for a reply: it waits on EMAIL, else the instance's runner, until someone replies under it, which starts a run. An ask
  that pins files can be signed off, as they are, by anyone who sees the instance: it commits its folder
  in their name (rf help commit) and starts a run, and the log's signoff entry names the ask, as on, with the commit. Whose
  sign-off counts, and for what, is the series' instructions' call. The rest as rf say.`,
  commit: `rf commit MESSAGE|-
  Commits your instance's whole folder as it is now, in your name, to its history: the folder is a repository, which only the
  server commits; read it with git log, show or diff, such as git diff HEAD -- working. Each run's end commits it too, in your
  name, and a sign-off and closing, in the name of whoever signed.`,
  wake: `rf wake TARGET AT [--label LABEL] [--days DAYS] | rf wake --cancel ID
  Starts a run later, which sees who woke it. TARGET is a folder as you see it, by the names your run started with: an open
  instance, such as . for your own, ../<label> or ../../<series>/<label>, which the wake continues; or a series, such as .. or
  ../../<series>, which it starts a new instance of, labelled LABEL, or continues the one it has by that label. AT is now,
  +<n>m, +<n>h, +<n>d, or a date and time with its offset, such as 2026-09-14T07:00+08:00. --days, such as mon-fri or
  mon,wed,fri, repeats it each week on those days at AT's time; a series' LABEL then holds the date AT falls on, or that of
  the day before it that it fires on, and moves on with it. A target has as many wakes as are set, firing at least 15 minutes
  apart; setting a series' wake for a LABEL already pending moves it. Each run's first message lists the wakes pending for
  its instance and series, by ID, which --cancel cancels. A closed instance can't be woken: to correct one, wake its series
  with --label <its label>-r2.`,
  correct: `rf correct PATH [--on ITEM[@REF]] --wrong|--superseded [--in THREAD] TEXT|-
  Says that a closed instance of your workspace, such as ../<label>, or an item of it, at a place in its file if given, is wrong
  or superseded, and why, as a later entry it keeps; it is never changed. It links your instance, and THREAD of yours, where the
  change is; each run's first message lists the corrections on the instances before it. - reads TEXT from stdin.`,
  delivered: `rf delivered ITEM --to WHERE --receipt WHAT
  Records that you delivered the output ITEM outside: where to, such as "E1, batch 4471" or the mail's recipients, and what
  proves it, such as the document number a website gave, or the Message-ID or the file's id and eTag Microsoft 365 gave.`,
  expired: `rf expired SITE
  Says the website SITE signed your runner's login out, as when it shows its sign-in page: its browser closes, and your runner
  is asked to sign in again, after which the instance carries on.`,
};
const USAGE = `${Object.values(HELP).map(h => h.split('\n  ')[0]).join('\n')}\nrf help COMMAND`;

const [cmd, ...args] = process.argv.slice(2);
// node:http, not fetch, which gives up on an answer after 5 minutes.
const send = (method: string, path: string, body?: string | Buffer) => new Promise<{ ok: boolean; text: string }>((ok, fail) => {
  const req = request(`${process.env.RF_URL}/${path}`, { method, headers: { authorization: `Bearer ${process.env.RF_TOKEN}` } }, res => {
    const chunks: Buffer[] = [];
    res.on('data', c => chunks.push(c)).on('end', () => ok({ ok: res.statusCode! < 300, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', fail).end(body);
});
const usage = (c?: string) => ({ ok: false, text: c && HELP[c] ? HELP[c] : USAGE });

const own = `api/instances/${process.env.RF_INSTANCE}`;

// rf say and rf ask: a comment in a thread, or starting one on an item or the instance.
function comment() {
  const o: { in?: string; on?: string; to?: string; pin: string[]; words: string[] } = { pin: [], words: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = /^--(in|on|to|pin)$/.exec(args[i])?.[1] as 'in' | 'on' | 'to' | 'pin' | undefined;
    if (!flag || args[i + 1] === undefined) o.words.push(args[i]);
    else if (flag === 'pin') o.pin.push(args[++i]);
    else o[flag] = args[++i];
  }
  const text = o.words.join(' ') === '-' ? readFileSync(0, 'utf8') : o.words.join(' ');
  if (!text.trim() || (o.in && o.on) || (o.to && cmd === 'say')) return usage(cmd);
  const at = o.on?.indexOf('@') ?? -1, item = at >= 0 ? o.on!.slice(0, at) : o.on, ref = at >= 0 ? o.on!.slice(at + 1) : undefined;
  return send('POST', `${own}/comment`, JSON.stringify({ thread: o.in, item, ref, text, files: o.pin, ask: cmd === 'ask', to: o.to }));
}

// rf wake TARGET AT [--label LABEL] [--days DAYS]: the folder becomes an id, then the wake is set as a person sets one.
const wake = async () => {
  const o: Record<string, string> = {}, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = /^--(label|days|cancel)$/.exec(args[i])?.[1];
    if (flag) o[flag] = args[++i];
    else rest.push(args[i]);
  }
  if (o.cancel !== undefined && !rest.length) return send('DELETE', `api/wakes/${o.cancel}`);
  const [target, at, ...more] = rest;
  if (!target || !at || more.length) return usage('wake');
  const found = await send('GET', `api/resolve?path=${encodeURIComponent(target)}`);
  if (!found.ok) return found;
  const { id, kind } = JSON.parse(found.text), set = await send('PUT', `api/wakes/${id}`, JSON.stringify({ at, label: o.label, days: o.days }));
  if (!set.ok) return set;
  const k = JSON.parse(set.text);
  return { ok: true, text: `set: ${target} ${kind === 'series' ? `starts ${k.label}` : 'wakes'} at ${k.at}${k.days ? `, then each ${k.days.join(', ')}` : ''} (wake ${k.id})` };
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

let res;
if (cmd === 'show') res = await send('GET', `${own}/screen`);
else if (cmd === 'put' && args[0]) res = await send('PUT', `${own}/screen`, readFileSync(args[0] === '-' ? 0 : args[0]));
else if (cmd === 'say' || cmd === 'ask') res = await comment();
else if (cmd === 'wake') res = await wake();
else if (cmd === 'correct') res = await correct();
else if (cmd === 'commit' && args.length) res = await send('POST', `${own}/commit`, JSON.stringify({ message: args.join(' ') === '-' ? readFileSync(0, 'utf8') : args.join(' ') }));
else if (['expired', 'delivered'].includes(cmd) && args.length >= 1) res = await send('POST', `agent/${cmd}`, JSON.stringify({ args }));
else if (cmd === 'help') res = { ok: true, text: HELP[args[0]] ?? USAGE };
else res = usage(cmd);
(res.ok ? console.log : console.error)(res.text);
process.exitCode = res.ok ? 0 : 1;
