// rf for people: what the page does, from a shell or a desktop agent, as you, with a personal token made on the page (Tokens).
// Published to npm as @rfany/rf, from cli/. PATH is workspace/series/label, as `rf ls` prints it.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// A failure is one line, rf's own or the server's, never a stack.
process.on('uncaughtException', e => {
  console.error(`rf: ${e.message}${e.cause instanceof Error ? `: ${e.cause.message}` : ''}`);
  process.exit(1);
});

const USAGE = `rf login URL [TOKEN]                without a TOKEN, through the browser: type rf's code on the page, and allow it
rf ls
rf pull PATH DIR [--delete] [-n|--dry-run] [--exclude PATTERN]... [--max-size SIZE]
                                  PATH's files into DIR as rsync copies them, whole, if their size or time differ: PATH/ fills DIR,
                                  PATH makes DIR/<its name>, / is all you see; --delete removes what the server no longer has;
                                  --max-size skips files bigger than SIZE, such as 50M
rf help [COMMAND]                 how rollforward works and how to use rf, for an agent, or COMMAND's usage
rf comment PATH TEXT [--item ID] [--ref REF] [--thread T] [--wait]   a new thread, or a reply in T, as to an agent's ask
rf upload PATH FILE [--onto ITEM] [--output]
rf wake PATH AT [--label LABEL] [--days DAYS] | rf wake --cancel ID
                                  AT now, +<n>m|h|d or a date; PATH an open instance, or a series with LABEL; DAYS, such as
                                  mon-fri, repeats it weekly at AT's time; rf ls shows each wake's ID
rf agents [WORKSPACE] [--set FILE|-]     the company's AGENTS.md, or a workspace's; setting the company's is for admins
rf skills
rf skill pull ID [DIR] [--version N]   the newest version, or N, into DIR, ./ID by default, new or empty, as push reads it
rf skill versions ID
rf connections
rf status [--long MIN] [--json]   what goes on and what's stuck: runs going, flagged past MIN minutes (30), and queued, with why;
                                  what waits on whom since when; open instances whose last run failed
rf indexes [--json]               each index of a source you index, all for admins: its kind, items and size, and per person
                                  its phase, crawl or follow, pages read, when last caught up, and its error and next try
rf runs [PATH] [--since DATE] [--failed] [--running] [--long MIN] [--json]
                                  a line per run: start, path, run, outcome, time, cost, what started it, summary or error;
                                  the outcome is done, interrupted by a person, cut by a restart, running, or failed, for
                                  credits, policy, time limit or other
rf costs [PATH] [--since DATE] [--by workspace|series|person|day|outcome] [--json]   totals, runs and cost per run; person
                                  is the runner; runs leave out those a restart cut, as the next run carries each on
rf activity [PATH] [--since DATE] [--json]   per instance, what people said, uploaded and closed, and each run's report
rf wakes [PATH] [--json]          each series' pending wakes and requests to start an instance, and when a wake of it last
                                  fired, and each instance's pending wakes
rf people WORKSPACE [--set FILE|-] [-n] [--force]   its owners and admins: its people as lines of owner|member EMAIL-OR-GROUP,
                                  each with a comment; --set replaces them, -n shows the changes, --force hides open instances
                                  from their runners

Admins, and those they grant publish:
rf skill push DIR                 DIR/SKILL.md and the rest become the newest version of the skill named DIR's name, live at once
rf skill rollback ID N            pushes version N again, as the newest

Admins:
rf people [--set FILE|-] [-n] [--force]   everyone as lines of ROLE EMAIL, each with a comment; --set sets the roles of the people
                                  listed and adds new ones, removing no one
rf user add EMAIL [admin] | role EMAIL admin|user [--force] | disable EMAIL | enable EMAIL | signout EMAIL | remove EMAIL
rf connection set NAME TYPE [--SETTING VALUE]...   an outside system runs reach as their runner, by a login each person makes:
                                  graph, Microsoft 365, and databricks, Azure Databricks, each with no settings, as each
                                  person adds what their login offers; website, --url URL [--hosts HOST,...] [--title TITLE]
                                  [--writeback false] [--header NAME] [--keepalive PAGE] [--every 10m]
                                  [--people EMAIL|GROUP,...], where people sign in, the other hosts its pages need, such as
                                  *.example.com, whether a run's browser writes its state back, a header its sign-in needs
                                  that its pages never send, such as x-bot-token, whose value each person gives, the page a
                                  login kept alive loads, by its address or path, such as
                                  https://patriarch.patrina.net/PatriArchMVC/, else the address, and how often, 10m unless
                                  given, and who alone may use it, by email or Entra group id
rf connection remove NAME
rf connection off|on NAME         a website switched off, for no one to use, such as a person's own, or on again
rf brand [--text TEXT] [--logo FILE] [--clear]   the deployment's text and logo, a .png, .jpg, .gif, .webp or .svg, which top
                                  the sidebar and are the page's title and icon; --clear goes back to the plain look, and with
                                  no option it prints them
rf can [CAP [EMAIL|GROUP,...] [--clear]]   what users may do beyond the rest, as admins may: publish, push skills;
                                  create, make workspaces; sites, add websites of their own; and keepalive, keep their
                                  website logins alive for up to a week as they sign in; a list grants CAP to those
                                  emails and Entra group ids in place of whom it had, --clear to no one, and with neither it
                                  prints whom each is granted to`;

const GUIDE = `rollforward runs a team's recurring work, such as a weekly borrowing base or a month-end reconciliation, with an agent
that does each period's work and people who check it. rf does what its page does, as you: rf alone lists its commands, rf help
COMMAND gives one's usage, every read takes --json, and a failure is one line on stderr, with exit code 1.

What there is
- A workspace holds series, and its people. A series is one recurring job; an instance is one period of it, labelled such as
  2026-08-23. A task is a one-off: a series of one instance, named by its label, until someone makes it a series. PATH is workspace/series/label, as rf ls prints it; for rf pull it may go deeper, into an instance's files.
- An instance's screen is its items: inputs, steps and outputs, each pointing at a file, with what it's made from. People upload
  files and comment. The runner is the person whose logins the runs use, and who closes the instance once they stand by it. Their
  comments and uploads start a run of the agent, which reads them and carries on, as do everyone's where the runner shares the
  series, and a reply from whom an ask names; anyone else's is a note, which the agent takes up once the runner does.
- A comment starts a thread, on the instance or on an item, at a cell such as Base!C25, and others reply in it. An ask is the
  agent's comment that waits on someone, the one it names or else the runner, until they reply or resolve it. rf ls says how many
  asks wait in each instance. A sign-off, an ask with signoff true, waits on the runner, who approves or rejects it on the page:
  either commits the instance's folder to its history, .git in it, as closing does.

What rf pull copies, the folders as the agent sees them
  AGENTS.md                  the company's conventions; <workspace>/AGENTS.md the workspace's
  <workspace>/<series>/<label>/
    screen.json              the screen: {rev, status, items: [{id, name, kind, file, from, headline, source}]}
    log.jsonl                every event, by seq: by is a person's email, "server" or "agent"; op is upload, comment (thread, item,
                             ref, text, ask, to, signoff), resolve, signoff (the runner's answer, with its commit), commit, point and
                             item (the screen changing), run, report (the agent's account of a run), done (its cost, summary or
                             error), close, and the rest
    upload/                  what people uploaded, their comments' attachments in upload/attachments/
    working/                 what the agent made, its scripts, and process.md, how it does this series
    session/                 each session's transcript, which may carry several runs: every message and tool call
    browser/                 each run's browser requests, and its screenshots
    names.tsv                each instance in the latest run's reach, id<TAB>/work/<workspace>/<series>/<label>: names can
                             change, so where a path in a file doesn't match, look its id up in the names.tsv of the commit
                             that last changed the file (git log -1 -- FILE, then git show H:names.tsv), and its name now in
                             rf ls
The copy is read-only, and only rf changes what's on the server: comment, upload and wake.

Usual work
- What waits on me: rf ls, then the asks in that instance's log.jsonl, ask true, whose thread has nothing after them.
- Answer an ask: rf comment PATH TEXT --thread T --wait, which prints what the agent says back.
- Give an input or a corrected output: rf upload PATH FILE [--onto ITEM] [--output].
- Start an instance: rf wake SERIES now --label LABEL, which starts it as whoever shares the series, else asks on the page for
  someone to start it; take one you run up later: rf wake PATH +2h.
- Read what a run did: rf pull PATH/ DIR, then its report and done entries in log.jsonl, the files in working/, and session/ for
  every step.

Watching over it, for admins and power users; each sees what the caller sees
- What's stuck: rf status lists runs going, flagging those past --long MIN (30); queued runs, since when and why: their series is
  running, the RF_MAX_RUNS cap, or memory; what waits on whom since when: asks, notes for runners, expired logins and the instances
  they hold, and requests to start; open instances whose last run failed; and indexes crawling or failing.
- Indexes: rf indexes shows each index of a big library or mailbox you index, every one for admins: its items and size, and per
  person whether it is crawling or following changes, pages read, when last caught up, and an error, if any, with its next try.
- History: rf runs [PATH] [--since DATE] [--failed] [--running] [--long MIN] prints a line per run: its start, path, run number,
  outcome, time taken, cost, what started it and by whom, and its summary or error. rf costs [PATH] [--since DATE] [--by
  workspace|series|person|day] totals them, by the runner for person.
- People: rf people (admins) prints everyone as ROLE EMAIL lines, and rf people WORKSPACE (its owners and admins) its owners and
  members as owner|member lines; a comment after each says when they last signed in and which open instances they run, and for
  everyone those they run in workspaces they aren't in. Edit the lines, see the changes with --set FILE -n (FILE may be - for
  stdin), then --set FILE. For everyone it sets the roles of the people listed and adds new ones, removing no one (rf user remove
  does); for a workspace it replaces its people. A change that would hide an open instance from the person who runs it is refused,
  naming them, unless --force: have someone who stays take those over first.`;

// A command's usage, as USAGE gives it; with none known, every command's.
const usage = (c?: string) => (c && USAGE.split(/\n(?=\S)/).map(e => e.trimEnd()).filter(e => e.split(/\s/)[1] === c).join('\n')) || USAGE;

const config = join(homedir(), '.config', 'rollforward.json');
const [cmd, ...argv] = process.argv.slice(2);
const flags: Record<string, string | true> = {}, excludes: string[] = [], args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] === '-n' ? 'dry-run' : argv[i].match(/^--(.+)$/)?.[1];
  if (!flag) args.push(argv[i]);
  else if (['wait', 'output', 'delete', 'dry-run', 'force', 'json', 'failed', 'running', 'clear'].includes(flag)) flags[flag] = true;
  else if (argv[i + 1] === undefined) throw new Error(`--${flag} takes a value`);
  else if (flag === 'exclude') excludes.push(argv[++i]);
  else flags[flag] = argv[++i];
}
if (!cmd || cmd === 'help') {
  console.log(!cmd ? USAGE : args[0] ? usage(args[0]) : GUIDE);
  process.exit();
}
if (cmd !== 'login' && !existsSync(config)) throw new Error('sign in first: rf login URL');
let { url, token } = cmd === 'login' ? { url: args[0]?.replace(/\/$/, ''), token: args[1] } : JSON.parse(readFileSync(config, 'utf8'));

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(url + path, { ...init, headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${await r.text()}`);
  return r;
}
const get = async (path: string) => (await api(path)).json();
const post = (path: string, body: unknown, method = 'POST') => api(path, { method, body: JSON.stringify(body) });

async function find(path: string) {
  const [w, s, l] = path.split('/'), series = (await get('/api')).find(x => x.name === w)?.series.find(x => x.name === s);
  const inst = l === undefined ? undefined : series?.instances.find(i => i.label === l);
  if (!series || (l !== undefined && !inst)) throw new Error(`nothing you can see at ${path}`);
  return { series, inst, at: inst ? `/api/instances/${inst.id}` : '' };
}

// Times as this machine's clock reads them, and lengths of time and costs, for the views.
const when = (iso: string) => new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
const took = (s: number) => s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const runsIn = async (path = '') => (await get(`/api/runs?since=${encodeURIComponent(String(flags.since ?? ''))}`))
  .filter(r => !path || r.path === path.replace(/\/+$/, '') || r.path.startsWith(path.replace(/\/+$/, '') + '/'));

function write(path: string, data: string | Uint8Array, mtime: string) {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, data);
  utimesSync(path, new Date(mtime), new Date(mtime));
  chmodSync(path, 0o444);
}

// A path the server named, under `base`, or undefined where a name in it can't be one here: on Windows a name may hold \ or :, which
// would put the file elsewhere, even in another workspace's folder, or another file's stream; or name a device, such as CON; or end
// in a dot or a space, which Windows drops.
const under = (base: string, rel: string) => {
  const names = rel.split('/');
  if (names.some(n => !n || n === '.' || n === '..' || basename(n) !== n
    || (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]|[. ]$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n))))) return undefined;
  return join(base, ...names);
};

// rsync's --exclude, simply: a pattern without / matches any one name on the path, one with / the path from the pull's top; * and ?
// stop at /, ** doesn't. A folder it matches takes what's in it along.
const globs = excludes.map(p => [p.replace(/^\/|\/$/g, '').includes('/'), new RegExp(`^${p.replace(/^\/|\/$/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`)] as const);
const excluded = (rel: string) => globs.some(([whole, re]) => rel.split('/').some((name, k, all) => re.test(whole ? all.slice(0, k + 1).join('/') : name)));

// Copies PATH's files into DIR as rsync does, from the server only and whole: a file whose size or time differ from the server's is
// fetched, and given the server's time, so the next pull compares against it. Nothing is kept besides the files.
async function pull(path: string, dir: string) {
  const at = path.replace(/^\/+/, ''), from = at.replace(/\/+$/, ''), dry = !!flags['dry-run'];
  const size = /^(\d+)([KMG]?)$/i.exec(String(flags['max-size'] ?? '0'));
  if (!size) throw new Error(`--max-size: a size such as 500K, 50M or 2G, not ${flags['max-size']}`);
  const max = flags['max-size'] === undefined ? Infinity : Number(size[1]) * 1024 ** ' KMG'.indexOf(size[2].toUpperCase() || ' ');
  const list: { path: string; size: number; mtime: string; url?: string; text?: string }[] = await get(`/api/files?path=${encodeURIComponent(from)}`);
  if (!list.length) throw new Error(`nothing you can see at ${path}`);
  const into = !from || at.endsWith('/') ? resolve(dir) : under(resolve(dir), from.slice(from.lastIndexOf('/') + 1)), rel = (f: { path: string }) => f.path.slice(from ? from.length + 1 : 0);
  if (!into) throw new Error(`${from} can't be a name here: pull ${from}/ into a folder of your choosing`);
  let fetched = 0, same = 0, deleted = 0, failed = 0, big = 0;
  const fetches: (() => Promise<void>)[] = [];
  for (const f of list.filter(f => !excluded(rel(f)))) {
    const local = rel(f) ? under(into, rel(f)) : into, st = local && existsSync(local) ? statSync(local) : undefined;
    if (!local) {
      console.error(`skipped ${f.path}: it can't be a file's name here`);
      continue;
    }
    if (st && st.size === f.size && Math.floor(st.mtimeMs / 1000) === Math.floor(Date.parse(f.mtime) / 1000)) {
      same++;
      continue;
    }
    if (f.size > max) {
      console.log(`skipped  ${f.path}: ${f.size} bytes, over --max-size`);
      big++;
      continue;
    }
    fetches.push(async () => {
      console.log(`${st ? 'changed' : 'new'}  ${f.path}`);
      try {
        if (!dry) write(local, f.text ?? new Uint8Array(await (await api(f.url!)).arrayBuffer()), f.mtime);
        fetched++;
      } catch (e) {
        failed++;
        console.error(`${f.path}: ${(e as Error).message}`);
      }
    });
  }
  // Up to 8 files are fetched at once, each started in the list's order.
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let next; (next = fetches.shift());) await next();
  }));
  if (flags.delete && list.some(rel) && existsSync(into)) {
    const keep = new Set(list.map(rel)), mine = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? mine(join(d, e.name)) : [join(d, e.name)]);
    for (const p of mine(into)) {
      const r = relative(into, p).split(sep).join('/');
      if (keep.has(r) || excluded(r)) continue;
      console.log(`deleted  ${r}`);
      deleted++;
      if (!dry) rmSync(p, { force: true });
    }
    const prune = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(join(d, e.name)); if (d !== into && !readdirSync(d).length) rmdirSync(d); };
    if (!dry) prune(into);
  }
  console.log(`${dry ? 'would fetch' : 'fetched'} ${fetched}, ${same} up to date${big ? `, ${big} over ${flags['max-size']}` : ''}${flags.delete ? `, ${dry ? 'would delete' : 'deleted'} ${deleted}` : ''}${failed ? `, ${failed} failed` : ''}, in ${into}`);
  if (failed) process.exitCode = 1;
}

// The browser's sign-in: the server makes a request, the person allows it on the page, which shows its code, and rf collects the token.
async function browserToken(): Promise<string> {
  const { id, code } = await (await fetch(`${url}/auth/cli`, { method: 'POST', body: JSON.stringify({ name: `rf on ${hostname()}` }) })).json();
  const link = `${url}/cli`;
  console.log(`Open ${link}\nand type the code ${code} there.`);
  spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  for (;;) {
    await new Promise(ok => setTimeout(ok, 2000));
    const r = await fetch(`${url}/auth/cli/poll`, { method: 'POST', body: JSON.stringify({ id }) });
    if (r.status === 200) return (await r.json()).token;
    if (r.status !== 202) throw new Error(await r.text());
  }
}

if (cmd === 'login' && url) {
  token ??= await browserToken();
  const me = await get('/me');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ url, token }), { mode: 0o600 });
  console.log(`signed in as ${me.email}`);
} else if (cmd === 'ls' && !args.length) {
  const rows = (await get('/api')).flatMap(w => w.series.flatMap(s => [
    { path: `${w.name}/${s.name}`, id: s.id, requests: s.requests.length, wakes: s.wakes },
    ...s.instances.map(i => ({ path: `${w.name}/${s.name}/${i.label}`, id: i.id, status: i.status, running: i.running, asks: i.asks.length, runner: i.runner, wakes: i.wakes })),
  ]));
  if (flags.json) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) {
    console.log(r.status ? `${r.path}  ${r.status}${r.running ? ', running' : ''}${r.asks ? `, ${r.asks} asks waiting` : ''}, runner ${r.runner}` : `${r.path}${r.requests ? `  ${r.requests} asking to start` : ''}`);
    for (const k of r.wakes) console.log(`  wake ${k.id} ${k.at}${k.label ? ` starts ${k.label}` : ''}${k.days ? `, then each ${k.days.join(', ')}` : ''}`);
  }
} else if (cmd === 'pull' && args.length === 2) await pull(args[0], args[1]);
else if (cmd === 'comment' && args.length === 2) {
  const { at } = await find(args[0]);
  await post(`${at}/comment`, { text: args[1], item: flags.item, ref: flags.ref, thread: flags.thread });
  const { log, runner } = await get(at), { seq, note } = log.at(-1);
  if (note) console.log(`a note for the runner, ${runner.by}, seq ${seq}: it starts no run until they act`);
  else if (!flags.wait) console.log(`commented, seq ${seq}`);
  else for (;;) {
    // The run that saw the comment, and what it said from then on: a run ending as it came may not have.
    await new Promise(r => setTimeout(r, 5000));
    const log = (await get(at)).log, done = log.find(e => e.op === 'done' && e.seen >= seq);
    if (!done) continue;
    const from = Math.max(seq, log.find(e => e.op === 'run' && e.run === done.run).seq);
    for (const e of log.filter(e => e.seq > from && e.seq < done.seq && ((e.op === 'comment' && e.by === 'agent') || e.op === 'report'))) console.log(`${e.op === 'report' ? 'Report' : `${e.ask ? 'Asks' : 'Says'} in ${e.thread}`}:\n${e.text}\n`);
    if (done.error) console.log(`The run failed: ${done.error}`);
    break;
  }
} else if (cmd === 'upload' && args.length === 2) {
  const q = new URLSearchParams({ name: basename(args[1]), pane: flags.output ? 'out' : 'in', ...(typeof flags.onto === 'string' && { onto: flags.onto }) });
  await api(`${(await find(args[0])).at}/upload?${q}`, { method: 'POST', body: readFileSync(args[1]) });
  console.log('uploaded');
} else if (cmd === 'wake' && typeof flags.cancel === 'string' && !args.length) {
  await api(`/api/wakes/${flags.cancel}`, { method: 'DELETE' });
  console.log('cancelled');
} else if (cmd === 'wake' && args.length === 2) {
  const { series, inst } = await find(args[0]);
  const at = args[1] === 'now' ? Date.now() : args[1].startsWith('+') ? Date.now() + Number(args[1].slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[args[1].at(-1)!]! : Date.parse(args[1]);
  const w = await (await post(`/api/wakes/${inst?.id ?? series.id}`, { at: new Date(at).toISOString(), label: flags.label, days: flags.days }, 'PUT')).json();
  console.log(`wake ${w.id} at ${w.at}${w.days ? `, then each ${w.days.join(', ')}` : ''}`);
} else if (cmd === 'agents' && args.length <= 1) {
  const ws = args[0] === undefined ? undefined : (await get('/api')).find(w => w.name === args[0]);
  if (args[0] !== undefined && !ws) throw new Error(`no workspace ${args[0]}`);
  if (typeof flags.set !== 'string') console.log(ws ? ws.agents : (await get('/agents')).text);
  else {
    const text = readFileSync(flags.set === '-' ? 0 : flags.set, 'utf8');
    await (ws ? post(`/api/workspaces/${ws.id}`, { agents: text }, 'PUT') : api('/agents', { method: 'PUT', body: text }));
    console.log('saved');
  }
} else if (cmd === 'skill' && args[0] === 'push' && args[1]) {
  const files = Object.fromEntries(readdirSync(args[1], { recursive: true, withFileTypes: true }).filter(d => d.isFile())
    .map(d => [relative(args[1], join(d.parentPath, d.name)).split(sep).join('/'), readFileSync(join(d.parentPath, d.name)).toString('base64')]));
  console.log(await (await post(`/skills/${encodeURIComponent(basename(resolve(args[1])))}/versions`, { files })).text());
} else if (cmd === 'skill' && args[0] === 'pull' && args[1] && args.length <= 3) {
  const id = encodeURIComponent(args[1]), dir = resolve(args[2] ?? args[1]), n = flags.version ?? (await get(`/skills/${id}/versions`)).at(-1)?.version;
  if (n === undefined) throw new Error(`no skill ${args[1]}`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} isn't empty: pull into a new folder, so nothing stale goes along when you push it`);
  for (const [rel, data] of Object.entries<string>(await get(`/skills/${id}/versions/${n}`))) {
    const path = under(dir, rel);
    if (!path) throw new Error(`${rel} can't be a file's name here`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
  console.log(`pulled ${args[1]} version ${n} into ${dir}`);
} else if (cmd === 'skill' && args[0] === 'versions' && args[1]) {
  const versions = await get(`/skills/${encodeURIComponent(args[1])}/versions`);
  if (flags.json) console.log(JSON.stringify(versions, null, 1));
  else for (const v of versions) console.log(`${v.version}  ${v.at}  ${v.by}`);
} else if (cmd === 'skill' && args[0] === 'rollback' && args.length === 3) {
  console.log(await (await post(`/skills/${encodeURIComponent(args[1])}/versions`, { from: Number(args[2]) })).text());
} else if (cmd === 'skills') {
  const skills = await get('/skills');
  if (flags.json) console.log(JSON.stringify(skills, null, 1));
  else for (const s of skills) console.log(`${s.id}  v${s.pushed.version} by ${s.pushed.by} ${s.pushed.at}  ${s.description}`);
} else if (cmd === 'connections') {
  const all = await get('/connections');
  if (flags.json) console.log(JSON.stringify(all, null, 1));
  else for (const { name, type, login, updated_by, updated_at, ...settings } of all) console.log(`${name}  ${type}  ${JSON.stringify(settings)}`);
} else if (cmd === 'connection' && args[0] === 'set' && args.length === 3) {
  await post(`/connections/${encodeURIComponent(args[1])}`, { type: args[2], ...flags }, 'PUT');
  console.log('saved');
} else if (cmd === 'connection' && ['off', 'on'].includes(args[0]) && args[1]) {
  await post(`/connections/${encodeURIComponent(args[1])}`, { off: args[0] === 'off' }, 'PATCH');
  console.log(args[0]);
} else if (cmd === 'connection' && args[0] === 'remove' && args[1]) {
  await api(`/connections/${encodeURIComponent(args[1])}`, { method: 'DELETE' });
  console.log('removed');
} else if (cmd === 'status' && !args.length) {
  const [s, ix] = await Promise.all([get('/api/status'), get('/api/indexes')]), long = Number(flags.long ?? 30);
  if (flags.json) console.log(JSON.stringify({ ...s, indexes: ix }, null, 1));
  else {
    const sections = [
      [`Running`, s.running.map(r => `${r.path}  run ${r.run}  for ${took((Date.now() - Date.parse(r.at)) / 1000)}  ${usd(r.cost)}${Date.now() - Date.parse(r.at) > long * 60e3 ? `  LONG, past ${long}m` : ''}`)],
      [`Queued`, s.queued.map(q => `${q.path}  since ${when(q.since)}: ${q.why}`)],
      [`Waiting`, [
        ...[...s.asks, ...s.requests.map(r => ({ ...r, who: r.who ?? 'anyone', since: r.at, text: `${r.from} asks to start ${r.label}`, request: true })),
          ...s.proposals.map(p => ({ who: `${p.to}'s owners`, path: p.to, since: p.at, text: `${p.by} proposes to ${p.kind === 'merge' ? `merge ${p.from} into it` : `move ${p.from}/${p.series} to it`}`, proposal: true }))]
          .sort((a, b) => a.who.localeCompare(b.who) || a.since.localeCompare(b.since)).map(a => `${a.who}  ${a.proposal ? 'a proposal' : a.request ? 'a request' : a.signoff ? 'a sign-off' : a.note ? 'a note' : 'an ask'} in ${a.path} since ${when(a.since)}: ${a.text.split('\n')[0].slice(0, 80)}`),
        ...s.expired.map(e => `${e.who}  their ${e.login} login expired${e.holding.length ? `, holding ${e.holding.join(', ')}` : ''}`),
      ]],
      [`Last run failed`, s.failed.map(f => `${f.path}  run ${f.run} at ${when(f.at)}: ${f.error}`)],
      [`Indexes crawling or failing`, ix.filter(x => x.people.some(p => p.phase === 'crawl' || p.error)).map(x => `${x.name}  ${x.people.filter(p => p.phase === 'crawl' || p.error)
        .map(p => `${p.who} ${p.error ? `failing${p.retry_at ? `, again ${when(p.retry_at)}` : ''}: ${p.error.split('\n')[0].slice(0, 80)}` : `crawling, ${p.pages} pages`}`).join('; ')}`)],
    ].filter(([, rows]) => rows.length);
    console.log(sections.map(([title, rows]) => `${title} (${rows.length})\n${rows.map(r => `  ${r}`).join('\n')}`).join('\n\n') || 'Nothing is running, queued, waiting or failed.');
  }
} else if (cmd === 'indexes' && !args.length) {
  const ix = await get('/api/indexes');
  if (flags.json) console.log(JSON.stringify(ix, null, 1));
  else console.log(ix.map(x => [`${x.name}  ${x.kind}  ${x.items} items  ${(x.bytes / 2 ** 20).toFixed(1)} MB`, ...x.people.map(p =>
    `  ${p.who}  ${p.phase}  ${p.pages} pages  caught up ${p.caught_up ? when(p.caught_up) : 'never'}${p.error ? `  ${p.retry_at ? `again ${when(p.retry_at)}` : 'stopped'}: ${p.error}` : ''}`)].join('\n')).join('\n\n') || 'No indexes.');
} else if (cmd === 'runs' && args.length <= 1) {
  const rows = (await runsIn(args[0])).filter(r => (!flags.failed || r.outcome === 'failed') && (!flags.running || r.outcome === 'running') && (!flags.long || r.seconds >= Number(flags.long) * 60));
  if (flags.json) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${when(r.at)}  ${r.path}  run ${r.run}  ${r.outcome}${r.failure ? ` (${r.failure})` : ''}  ${took(r.seconds)}  ${usd(r.cost)}  ${r.started ? `${r.started.op} by ${r.started.by}` : '-'}  ${r.error ?? r.summary ?? ''}`);
} else if (cmd === 'costs' && args.length <= 1) {
  const by = String(flags.by ?? 'series'), key = {
    workspace: r => r.path.split('/')[0], series: r => r.path.split('/').slice(0, 2).join('/'), person: r => r.runner, day: r => when(r.at).slice(0, 10),
    outcome: r => r.failure ? `failed, ${r.failure}` : r.outcome,
  }[by];
  if (!key) throw new Error('--by: workspace, series, person, day or outcome');
  // A run a restart cut is carried on by the next, so it adds its cost, not a run.
  const sums = new Map<string, { runs: number; cost: number }>(), rows = await runsIn(args[0]), counted = (r: { outcome: string }) => r.outcome === 'cut' ? 0 : 1;
  for (const r of rows) sums.set(key(r), { runs: (sums.get(key(r))?.runs ?? 0) + counted(r), cost: (sums.get(key(r))?.cost ?? 0) + r.cost });
  const out = [...sums].map(([k, v]) => ({ [by]: k, runs: v.runs, cost: +v.cost.toFixed(4), per_run: v.runs ? +(v.cost / v.runs).toFixed(4) : null }))
    .sort((a, b) => by === 'day' ? a.day.localeCompare(b.day) : b.cost - a.cost);
  if (flags.json) console.log(JSON.stringify(out, null, 1));
  else {
    for (const o of out) console.log(`${usd(o.cost).padStart(10)}  ${String(o.runs).padStart(5)} runs  ${(o.per_run === null ? '-' : usd(o.per_run)).padStart(8)} a run  ${o[by]}`);
    console.log(`${usd(rows.reduce((t, r) => t + r.cost, 0)).padStart(10)}  ${String(rows.reduce((n, r) => n + counted(r), 0)).padStart(5)} runs  in all`);
  }
} else if (cmd === 'wakes' && args.length <= 1) {
  const at = (args[0] ?? '').replace(/\/+$/, ''), rows = (await get('/api')).flatMap(w => w.series.filter(s => !s.archived).flatMap(s => [
    ...(s.single ? [] : [{ path: `${w.name}/${s.name}`, fired: s.fired, wakes: s.wakes, requests: s.requests }]),
    ...s.instances.filter(i => i.wakes.length).map(i => ({ path: `${w.name}/${s.name}/${i.label}`, fired: i.fired, wakes: i.wakes, requests: [] })),
  ])).filter(r => !at || r.path === at || r.path.startsWith(at + '/'));
  if (flags.json) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) {
    console.log(`${r.path}  last woken ${r.fired ? when(r.fired) : 'never'}${r.wakes.length || r.requests.length ? '' : ', none pending'}`);
    for (const k of r.wakes) console.log(`  wake ${k.id} ${when(k.at)}${k.label ? ` starts ${k.label}` : ''}${k.days ? `, then each ${k.days.join(', ')}` : ''}, set by ${k.from}`);
    for (const q of r.requests) console.log(`  request ${q.id} to start ${q.label}, from ${q.from} since ${when(q.at)}, waits on ${q.who ?? 'anyone'}`);
  }
} else if (cmd === 'activity' && args.length <= 1) {
  const at = (args[0] ?? '').replace(/\/+$/, ''), blocks = (await get(`/api/activity?since=${encodeURIComponent(String(flags.since ?? ''))}`))
    .filter(b => !at || b.path === at || b.path.startsWith(at + '/'));
  if (flags.json) console.log(JSON.stringify(blocks, null, 1));
  else for (const b of blocks) {
    console.log(b.path);
    for (const e of b.entries) console.log(`  ${when(e.at)}  ${e.op === 'done' ? `run ${e.run}  ${e.error ?? e.summary ?? 'no report'}`
      : `${e.by}  ${e.op === 'comment' ? `says: ${e.text.split('\n')[0].slice(0, 200)}` : e.op === 'upload' ? `uploads ${e.file}` : `${e.op === 'close' ? 'closes' : 'abandons'} it`}`}`);
  }
} else if (cmd === 'people' && args.length <= 1) {
  // People as lines to edit and set: ROLE EMAIL for everyone, owner|member EMAIL-OR-GROUP for a workspace, each with a comment.
  const ws = args[0] === undefined ? undefined : (await get('/api')).find(w => w.name === args[0]);
  if (args[0] !== undefined && !ws) throw new Error(`no workspace ${args[0]}`);
  const last = (iso: string | null) => iso ? `last in ${when(iso)}` : 'never in', listed = await get(ws ? `/api/workspaces/${ws.id}/people` : '/users');
  const now = ws ? listed.map(p => ({ kind: p.as, who: p.who, note: [p.who.includes('@') ? last(p.last_login) : 'a group', p.runs.length && `runs ${p.runs.join(', ')}`] }))
    : listed.map(u => ({ kind: u.role, who: u.email, note: [u.disabled && 'disabled', last(u.last_login), `in ${u.workspaces.join(', ') || 'none'}`, u.outside.length && `runs outside them: ${u.outside.join(', ')}`] }));
  if (flags.json && typeof flags.set !== 'string') console.log(JSON.stringify(listed, null, 1));
  else if (typeof flags.set !== 'string') {
    const w = Math.max(0, ...now.map(p => p.who.length));
    for (const p of now) console.log(`${p.kind.padEnd(6)} ${p.who.padEnd(w)}  # ${p.note.filter(Boolean).join('; ')}`);
    if (!now.length) console.log('# no one is in it: only admins see it');
  } else {
    const kinds = ws ? ['owner', 'member'] : ['admin', 'user'];
    const want = readFileSync(flags.set === '-' ? 0 : flags.set, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => l.split(/\s+/));
    const bad = want.find(([kind, who, more]) => !kinds.includes(kind) || !who || more);
    if (bad) throw new Error(`each line is ${kinds.join('|')} ${ws ? 'EMAIL-OR-GROUP' : 'EMAIL'}, not: ${bad.join(' ')}`);
    const had = new Map(now.map(p => [p.who, p.kind])), wanted = new Map(want.map(([kind, who]) => [who.toLowerCase(), kind]));
    const set = [...wanted].filter(([who, kind]) => had.get(who) !== kind), gone = ws ? [...had].filter(([who]) => !wanted.has(who)) : [];
    const changes = [...set.map(([who, kind]) => had.has(who) ? `${who}: ${had.get(who)} -> ${kind}` : `+ ${kind} ${who}`), ...gone.map(([who, kind]) => `- ${kind} ${who}`)];
    console.log(changes.join('\n') || 'no changes');
    if (changes.length && !flags['dry-run']) {
      const ofKind = (kind: string) => want.filter(([k]) => k === kind).map(([, who]) => who);
      await (ws ? post(`/api/workspaces/${ws.id}`, { owners: ofKind('owner'), members: ofKind('member'), force: !!flags.force }, 'PUT')
        : post('/users', { roles: Object.fromEntries(set), force: !!flags.force }, 'PUT'));
      console.log('saved');
    }
  }
} else if (cmd === 'brand' && !args.length) {
  if (flags.clear || flags.text !== undefined || flags.logo !== undefined) {
    const logo = typeof flags.logo === 'string' ? { name: basename(flags.logo), data: readFileSync(flags.logo).toString('base64') } : undefined;
    await post('/brand', { clear: flags.clear, text: flags.text, logo }, 'PUT');
    console.log('saved');
  } else {
    const { brand } = await get('/me'), { text, logo } = brand;
    console.log(flags.json ? JSON.stringify(brand) : text || logo ? `${text ?? 'no text'}, ${logo ? 'with a logo' : 'no logo'}` : 'no brand: the plain look');
  }
} else if (cmd === 'can' && args.length <= 2) {
  const [cap, list] = args, people = flags.clear ? [] : list?.split(',').map(p => p.trim()).filter(Boolean);
  const all: Record<string, string[]> = await (await (people ? post('/capabilities', { cap, people }, 'PUT') : api('/capabilities'))).json();
  if (flags.json) console.log(JSON.stringify(all, null, 1));
  else for (const [c, who] of Object.entries(all)) if (!cap || c === cap) console.log(`${c}: ${who.join(', ') || 'admins only'}`);
} else if (cmd === 'user' && args.length >= 2) {
  const [what, email, role] = args, at = `/users/${encodeURIComponent(email)}`;
  if (what === 'add') await post('/users', { roles: { [email]: role ?? 'user' } }, 'PUT');
  else if (what === 'role' && role) await post('/users', { roles: { [email]: role }, force: !!flags.force }, 'PUT');
  else if (what === 'disable' || what === 'enable') await post(at, { disabled: what === 'disable' }, 'PUT');
  else if (what === 'signout') await post(at, { signout: true }, 'PUT');
  else if (what === 'remove') await api(at, { method: 'DELETE' });
  else {
    console.error(usage(cmd));
    process.exit(2);
  }
  console.log('done');
} else {
  console.error(usage(cmd));
  process.exitCode = 2;
}
