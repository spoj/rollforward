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
  say: `rf say [--in THREAD | --on ITEM[@REF]] [--file PATH]... TEXT|-
  Tells people something that needs no reply. --in replies in a thread; --on starts one on an item, at a place in its file
  such as ar-aging@Sheet1!C22; neither starts one on the instance. --file cites a file the comment relies on, under upload/
  or working/ of this instance or of another of its series, as ../<label>/working/x.csv. - reads TEXT from stdin.`,
  ask: `rf ask [--in THREAD | --on ITEM[@REF]] [--to EMAIL | --sign-off] [--file PATH]... TEXT|-
  Asks for a reply: the thread waits on EMAIL, else the instance's runner, until someone replies (which starts a run) or
  resolves it. --sign-off asks the runner to approve the instance as it stands, or reject it with a note: either commits its
  folder in their name (rf help commit) and starts a run, and the log's signoff entry says which, with the commit. The rest as
  rf say.`,
  commit: `rf commit MESSAGE|-
  Commits your instance's whole folder as it is now, in your name, to its history: the repository .git in the folder, which you
  read with git, such as git -C <label> log, or diff to see what changed since. A sign-off and closing commit it too, in the
  name of whoever signed.`,
  resolve: `rf resolve THREAD [TEXT]
  Resolves a thread you started, once it no longer applies, saying why.`,
  wake: `rf wake TARGET AT REASON [--label LABEL]
  Starts a run later. TARGET is a folder as you see it: an open instance, such as your own label or ../<series>/<label>, which
  the wake continues; or a series, such as . or ../<series>, which it starts a new instance of, labelled LABEL. AT is now,
  +<n>m, +<n>h, +<n>d, or a date and time with its offset, such as 2026-09-14T07:00+08:00. A target has one wake pending (a new
  one replaces it), at least 15 minutes after its last. A closed instance can't be woken: to correct one, wake its series
  with --label <its label>-r2.`,
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
  const o: { in?: string; on?: string; to?: string; file: string[]; words: string[]; signoff?: boolean } = { file: [], words: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = /^--(in|on|to|file)$/.exec(args[i])?.[1] as 'in' | 'on' | 'to' | 'file' | undefined;
    if (args[i] === '--sign-off' && cmd === 'ask') o.signoff = true;
    else if (!flag || args[i + 1] === undefined) o.words.push(args[i]);
    else if (flag === 'file') o.file.push(args[++i]);
    else o[flag] = args[++i];
  }
  const text = o.words.join(' ') === '-' ? readFileSync(0, 'utf8') : o.words.join(' ');
  if (!text.trim() || (o.in && o.on) || (o.to && cmd === 'say')) return usage(cmd);
  const at = o.on?.indexOf('@') ?? -1, item = at >= 0 ? o.on!.slice(0, at) : o.on, ref = at >= 0 ? o.on!.slice(at + 1) : undefined;
  return send('POST', `${own}/comment`, JSON.stringify({ thread: o.in, item, ref, text, files: o.file, ask: cmd === 'ask', to: o.to, signoff: o.signoff }));
}

// rf wake TARGET AT REASON [--label LABEL]: the folder becomes an id, then the wake is set as a person sets one.
const wake = async () => {
  const i = args.indexOf('--label'), label = i >= 0 ? args[i + 1] : undefined, [target, at, ...why] = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  if (!target || !at || !why.length) return usage('wake');
  const found = await send('GET', `api/resolve?path=${encodeURIComponent(target)}`);
  if (!found.ok) return found;
  const { id, kind } = JSON.parse(found.text), set = await send('PUT', `api/wakes/${id}`, JSON.stringify({ at, reason: why.join(' '), label }));
  return set.ok ? { ok: true, text: `set: ${target} ${kind === 'series' ? `starts ${label}` : 'wakes'} at ${JSON.parse(set.text).at}` } : set;
};

let res;
if (cmd === 'show') res = await send('GET', `${own}/screen`);
else if (cmd === 'put' && args[0]) res = await send('PUT', `${own}/screen`, readFileSync(args[0] === '-' ? 0 : args[0]));
else if (cmd === 'say' || cmd === 'ask') res = await comment();
else if (cmd === 'resolve' && args[0]) res = await send('POST', `${own}/resolve`, JSON.stringify({ thread: args[0], text: args.slice(1).join(' ') }));
else if (cmd === 'wake') res = await wake();
else if (cmd === 'commit' && args.length) res = await send('POST', `${own}/commit`, JSON.stringify({ message: args.join(' ') === '-' ? readFileSync(0, 'utf8') : args.join(' ') }));
else if (['expired', 'delivered'].includes(cmd) && args.length >= 1) res = await send('POST', `agent/${cmd}`, JSON.stringify({ args }));
else if (cmd === 'help') res = { ok: true, text: HELP[args[0]] ?? USAGE };
else res = usage(cmd);
(res.ok ? console.log : console.error)(res.text);
process.exitCode = res.ok ? 0 : 1;
