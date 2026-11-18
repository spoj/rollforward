// rf for people: what the page does, from a shell or a desktop agent, as you, with a personal token made on the page (Tokens).
// Published to npm as @rfany/rf, from cli/. PATH is workspace/series/label, as `rf ls` prints it.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync, type Stats } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// A failure is one line, rf's own or the server's, never a stack.
process.on('uncaughtException', e => {
  console.error(`rf: ${e.message}${e.cause instanceof Error ? `: ${e.cause.message}` : ''}`);
  process.exit(1);
});

const usage = (c?: string, vpn = false, admin = false) => {
  const all = `rf login URL [TOKEN]                without a TOKEN, through the browser: type rf's code on the page, and allow it
rf ls [--mine] [--json]           every workspace, series and instance you see, with its status, owner, asks waiting and wakes;
                                  --mine, only open instances of series you own
rf waiting [--json]               what waits on you: asks and notes, requests to start or wake an
                                  instance or to use a
                                  website in a workspace you own, proposals and expired logins; only admins see hosts a run's
                                  browser was refused that the server rates high or finds at an internal address
rf show PATH [--json]             an instance: its items, the threads that wait on someone, by id, and its last run
rf log PATH [--since SEQ] [--follow] [--json]   its log, a line an entry, after SEQ; --follow prints more as they come;
                                  --json prints the entries as they are, a line each
rf cat PATH/FILE                  one file, to stdout
rf pull PATH DIR [--delete] [-n|--dry-run] [--exclude PATTERN]... [--max-size SIZE]
                                  PATH's files into DIR as rsync copies them, whole, if their size or time differ: PATH/ fills DIR,
                                  PATH makes DIR/<its name>, / is all you see; --delete removes what the server no longer has;
                                  --max-size skips files bigger than SIZE, such as 50M; on Windows and macOS, of two names
                                  that differ only in case, the second is skipped
rf help [COMMAND]                 how rollforward works and how to use rf, for an agent, or COMMAND's usage
rf --version                      rf's own version, to tell whether it's older than what the guide names
rf comment PATH TEXT [--item ID] [--ref REF] [--thread cN] [--wake|--wait]   a new thread, or a reply under comment cN, as to
                                  an agent's question; --wake or --wait starts a run for the owner or an answer to the agent's named ask,
                                  under current consent; --wait prints what the agent says back
rf upload PATH FILE [--onto ITEM] [--output] [--wake]
rf approve PATH cN [TEXT] [--wake]   records content approval of proposal cN, not permission to run as you; the folder is
                                  committed as it is now, in your name
rf reject PATH cN [TEXT] [--wake]   rejects the agent's proposal cN, with feedback on missing information or changes;
                                  revised work takes a new proposal
rf react PATH [cN] up|down|none   your thumbs up or down on comment cN, or on the instance, or none; quiet, open or closed
rf close PATH [--as-series NAME] [--wake]   the series owner makes it the record and an example,
                                  approving nothing; a task closes as a one-off, or as the first instance of the series NAME it
                                  becomes; --wake starts runs of the series' later open instances, which may have used its draft
rf abandon PATH                   the series owner leaves it as it is, neither an example nor a starting point
rf delete PATH [--yes]            its workspace's owners and admins delete an instance, in any status, once they confirm, or
                                  with --yes: a run for it is cut, and all the server holds of it goes but its label and place,
                                  shown as deleted, by whom and when; it can't be undone, and copies outside the server stay
rf interrupt PATH                 stops its run: its series owner, an owner of its workspace or an admin
rf series owner SERIES [EMAIL] [--json]   the whole series' owner; EMAIL transfers every instance, stopping old runs and
                                  clearing consent; only its current owner or a workspace manager may transfer it
rf series credentials SERIES [--set OFFER,...|--clear] [--autonomous true|false] [--json]
                                  credentials for every instance; only the owner saves consent, explicitly including [] with
                                  --clear; saving requires --autonomous true|false; no credentials or schedules transfer
rf rename PATH NAME               an instance, a series or a workspace, by its path
rf new task WORKSPACE [LABEL] [--creds OFFER,...|--clear] [--autonomous true|false] [--comment TEXT [--wake]]   a one-off task, Untitled until LABEL or its
                                  first comment names it; --wake starts its run on the comment; without --creds or --clear,
                                  no execution consent is granted; --clear explicitly permits work with no credentials
rf new instance SERIES LABEL [--wake]   another instance; anyone in the workspace may create it; only the owner starts it with --wake
rf new series PATH NAME           the task at PATH becomes the series NAME, itself its first instance
rf new workspace NAME             yours to own, for admins and those they grant create
rf archive PATH [--undo]          a workspace or a series leaves the sidebar, and nothing in it changes or runs, until --undo brings it back;
                                  its wakes and requests are cancelled for good
rf request start|drop ID [--wake]   a request to start or wake an instance, by the ID rf waiting and rf
                                  wakes print; only the target's current owner may Start; --wake runs it with existing series consent
rf logins [--json]                your logins, each with its state, keepalive and offers; you sign in to them on the page
rf logins offer|unoffer LOGIN SOURCE|OFFER   what a login offers runs: Microsoft 365's (m365) mailboxes, sites, folders and
                                  files, by address or link, a Databricks login's SQL warehouses, by link; unoffer takes the
                                  OFFER rf logins lists
rf logins allow SITE HOST --person EMAIL   admins alone allow a host the server left refused; one at an internal address
                                  is allowed once for everyone's websites
rf logins disallow SITE HOST      a host your website SITE reaches no more, which stays refused, the server's check letting
                                  it no more
rf logins signout LOGIN${vpn ? '\nrf vpns [--json]                  client VPNs and whether you are connected to each; sign in on the page' : ''}
rf sites [--json]                 your websites, each with its address and the other hosts it reaches, with what the server's
                                  check said of those it let it reach
rf site add NAME URL [--header NAME]   a website of your own, by a NAME you choose, whose sign-in starts at URL, which you
                                  sign in to on the page; --header names a header its sign-in needs that its pages never
                                  send, such as x-bot-token, whose value you give as you sign in
rf site set NAME [--header NAME] [--keepalive PAGE] [--every 10m] [--writeback false]${vpn ? ' [--via VPN]' : ''}
                                  your website NAME: a header its sign-in needs that its pages never send, such as
                                  x-bot-token, or '' to clear, whose value you give as you sign in, the page a login kept alive loads, by
                                  address or path, else its address, and how often, 10m unless given, and whether a run's
                                  browser writes its state back; admins set --internal true|false, with --person EMAIL for
                                  someone's, for its browsers to reach internal hosts, and its hosts at internal addresses
                                  everyone's websites, with no admin again, until one sets it false${vpn ? "\n                                  --via VPN routes this website through your connection to that client VPN; --via '' clears it" : ''}
rf site remove NAME               your website NAME, with your login to it and your grants for it
rf site ask NAME WORKSPACE REASON to use your login to NAME in WORKSPACE's runs, for REASON, which one of its owners approves
                                  or denies, seeing what the system is and what runs may do; an admin decides general platforms,
                                  high risk and failed checks; asked by someone who may approve it, an owner or an admin, it's
                                  approved at once; a login no approved grant uses is signed out a week after sign-in, and once
                                  you have no grant to it pending or approved
rf grants [WORKSPACE] [--json]    the grants to use websites, yours and those of the workspaces you own, with their states
rf grant approve|deny ID [TEXT]   a request to use a website in a workspace you own, with TEXT for its asker
rf grant revoke ID                a grant pending or approved, yours or in a workspace you own; its runs' browsers close
rf correct PATH TEXT [--item ID] [--ref REF] [--superseded] [--see LABEL]   a closed instance, or its item ID at REF, is
                                  wrong, or superseded, as LABEL, another instance of its series, shows; it can't be withdrawn
rf wake PATH AT [TEXT] [--label LABEL] [--days DAYS] [--check PATH [--deadline ISO]] | rf wake --cancel ID
                                  AT now, +<n>m|h|d or a date; PATH an open instance, or a series with LABEL; TEXT a short
                                  message for the run; the owner's now starts under current consent without autonomous opt-in;
                                  later or agent-set wakes need it. Collaborators' wakes are requests. DAYS, such as mon-fri,
                                  repeats weekly at AT's time. With the owner's wake-check capability, --check working/FILE.py (or .ts)
                                  gates a scheduled wake; optional --deadline TIME (ISO with offset) runs Pi even if the check stops.
rf note SERIES [TEXT] [--json]    tells the series something for its runs, about the series rather than one period or while no
                                  instance is open, which starts no run; without TEXT, its notes, open and settled
rf agents [WORKSPACE] [--set FILE|-]     the company's AGENTS.md, or a workspace's; setting the company's is for admins
rf readers WORKSPACE [add|remove OTHER]   the workspaces whose agents read WORKSPACE and those its own read, as each one's
                                  owners let them; its owners let OTHER's agents read it, one they see, and its owners or
                                  OTHER's take that off; OTHER's people see what its agents read
rf skills
rf skill pull ID [DIR] [--version N]   the newest version, or N, into DIR, ./ID by default, new or empty, as push reads it
rf skill versions ID
rf connections
rf status [--long MIN] [--all] [-d SECONDS] [--json]   what goes on and what's stuck: low OpenRouter credit (for admins), runs going, flagged
                                  past MIN minutes (30), and queued, with why; what waits on whom since when, the oldest three
                                  each unless --all; open instances whose last run failed; -d shows it
                                  again every SECONDS, as top does, until Ctrl+C
rf indexes [--json]               each index of a source you index, all for admins: its kind, items and size, and per person
                                  its phase, crawl or follow, pages read, when last caught up, and its error and next try
rf runs [PATH] [--since DATE] [--failed] [--running] [--long MIN] [-d SECONDS] [--json]
                                  a table, a row per run: start, path, run, outcome, time, cost, what started it, and any error;
                                  the outcome is done, interrupted by a person, cut, by a restart or a change that broke its
                                  lease, running, or failed, for credits, policy, time limit or other
rf costs [PATH] [--since DATE] [--by workspace|series|person|day|outcome] [--daily] [--json]   totals, runs and cost per run,
                                  plus server calls and OpenRouter key usage for admins; --daily lists each day by workspace,
                                  person, run and server; runs leave out those that were cut, as the next run carries each on
rf activity [PATH] [--since DATE] [--json]   per instance, what people and the agent said, what people uploaded, closed and
                                  deleted, and each run that failed
rf wakes [PATH] [--json]          each series' pending wakes and requests to start an instance, and when a wake of it last
                                  fired, and each instance's pending wakes
rf people WORKSPACE [--set FILE|-] [-n] [--force]   its owners and admins: its people as lines of owner|member EMAIL-OR-GROUP,
                                  each with a comment; --set replaces them, -n shows the changes, --force hides open instances
                                  from their series owners

Admins, and those they grant publish:
rf skill push DIR                 DIR/SKILL.md and the rest become the newest version of the skill named DIR's name, live at once
rf skill rollback ID N            pushes version N again, as the newest

Admins:
rf people [--set FILE|-] [-n] [--force]   everyone as lines of ROLE EMAIL, each with a comment; --set sets the roles of the people
                                  listed and adds new ones, removing no one
rf top [-d SECONDS] [--json]      the host's CPU, load and memory; each run going, with its processes and what they use; and the
                                  ten processes of runs busiest by CPU and by memory, each by its PID, script and command line
rf kill PID [--start N]           ends a process of a run going, as rf top lists it, and all it started, with SIGTERM, then SIGKILL
                                  after 5 seconds, logged in its instance, whose agent hears of it; N, its start in rf top --json,
                                  makes sure it's that process still; never the sandbox's own: rf interrupt PATH stops its run
rf user add EMAIL [admin] | role EMAIL admin|user [--force] | disable EMAIL | enable EMAIL | signout EMAIL | remove EMAIL
rf egress [add|remove HOST]       the hosts runs may reach beyond package registries, GitHub and documentation sites, such as
                                  api.example.com or *.example.org; admins add and remove them
rf internal [remove HOST] [--json]   the hosts at internal addresses admins let every website reach, each with who let it and
                                  when, as rf site set NAME --internal true or allowing one does; remove takes one out, after
                                  which everyone's websites at it wait for an admin again
rf connection set NAME TYPE       an outside system runs reach as their series owner, by a login each person makes: graph,
                                  Microsoft 365, or databricks, Azure Databricks, as each person adds what their login
                                  offers; service --url http://HOST:PORT --paths 'AP/,GL/2026/' [--key KEY] lends paths
                                  through a deployment's service at https://NAME.rf.internal/; websites are rf site's
rf connection remove NAME
rf brand [--text TEXT] [--logo FILE] [--clear]   the deployment's text and logo, a .png, .jpg, .gif, .webp or .svg, which top
                                  the sidebar and are the page's title and icon; --clear goes back to the plain look, and with
                                  no option it prints them
rf can [CAP [EMAIL|GROUP,...] [--clear]]   what users may do beyond the rest, as admins may: publish, push skills;
                                  create, make workspaces; and keepalive, keep their website logins alive for up to a
                                  week as they sign in; a list grants CAP to those
                                  emails and Entra group ids in place of whom it had, --clear to no one, and with neither it
                                  prints whom each is granted to${vpn ? '\n                                  vpn, using client VPNs, needs an explicit grant even for admins' : ''}${vpn && admin ? '\nrf vpn add NAME fortinet HOST:PORT [--servercert pin-sha256:HASH]   admins with vpn add a client VPN definition, which each\n                                  person signs in to on the page; --servercert pins the gateway key, as a refusal names it\nrf vpn remove NAME               admins with vpn remove a client VPN definition' : ''}`;
  return (c && all.split(/\n(?=\S)/).map(e => e.trimEnd()).filter(e => e.split(/\s/)[1] === c).join('\n')) || all;
};

const GUIDE = `rollforward runs a team's recurring work, such as a weekly borrowing base or a month-end reconciliation, with an agent
that does each period's work and people who check it. rf does what its page does, as you: rf alone lists its commands, rf help
COMMAND gives one's usage, every read takes --json, and a failure is one line on stderr, with exit code 1.

What there is
- A workspace holds series, and its people. A series is one recurring job; an instance is one period of it, labelled such as
  2026-08-23. A task is a one-off: a series of one instance, named by its label, until someone makes it a series. PATH is workspace/series/label, as rf ls prints it; for rf pull it may go deeper, into an instance's files.
- An instance's screen is its items: inputs, outputs and steps, each pointing at a file, with what it's made from. People upload
  files, and review the work in threads with the agent. One series owner is accountable for every instance: only that person
  closes and abandons. Their acts and answers by whom the agent's ask named start runs under current consent. Runs use the
  owner's selected credentials, across every instance. Without consent, nothing runs; selecting none permits work with no
  credentials. Scheduled and autonomous runs need a separate opt-in. Other collaborators' comments, uploads and approvals are notes that start nothing.
  Transferring the whole series stops old runs and clears consent; old unread instructions become notes. Each act keeps
  its author, and every run its executor.
- rf is quiet: a comment, upload, approval, rejection, close, new instance or request it starts begins no run unless --wake, and the agent
  reads it at its next run. The owner's rf wake PATH now starts one under current consent, without autonomous opt-in.
  A quiet upload or comment is committed to the instance's history at once.
- A comment starts a thread, on the instance or on an item, at a cell such as Base!C25 or a line of a markdown file by its
  opening words, and replies go under any comment in it, cN by its seq, a thread's id its first comment's. The agent asks
  questions, which wait on someone, the one it names or else the series owner, until a person replies under it, and proposes what it
  will do for its series owner, such as sending mail, which waits until someone approves or rejects it, or the agent withdraws it; a
  proposal missing information should be rejected with feedback, so the agent can revise and propose again. Generic comments
  are not proposal decisions. rf ls says how many asks wait in each instance. Reactions, thumbs up or down, are
  quiet signals kept for later. Anyone who sees the instance may approve a proposal, which commits the instance's folder to its
  history, .git in it, as it is then, as closing does. Whose approval counts, and for what, is the series' call.

What rf pull copies, the folders as the agent sees them
  AGENTS.md                  the company's conventions; <workspace>/AGENTS.md the workspace's
  <workspace>/<series>/<label>/
    screen.json              the screen: {rev, status, items: [{id, name, kind, file, from, headline, source, destination}]}
    log.jsonl                every event, by seq: by is a person's email, "server" or "agent"; op is upload, comment (thread, item,
                             ref, parent, text, files, ask, question or proposal, to), signoff (an approval of the proposal it names, on,
                             with its commit), reject, withdraw (the agent's, of its question or proposal on), react,
                             commit, point and item (the screen changing), run, done (its cost, or error), close, and the rest
    upload/                  what people uploaded, their comments' attachments in upload/attachments/
    working/                 what the agent made, its scripts, and process.md, how it does this series
    session/                 each run's transcript: every message and tool call
    browser/                 each run's browser requests, and its screenshots
    names.tsv                each instance in the latest run's reach, id<TAB>/work/<workspace>/<series>/<label>: names can
                             change, so where a path in a file doesn't match, look its id up in the names.tsv of the commit
                             that last changed the file (git log -1 -- FILE, then git show H:names.tsv), and its name now in
                             rf ls
    pylib.tsv                the series' .pylib, the Python packages its runs installed, which later runs run, as the latest
                             run started: path<TAB>size<TAB>change time, one file a line
The copy is read-only: only rf's commands change what's on the server.

Usual work
- What waits on me: rf waiting, then rf show PATH, which names each comment that waits by its id.
- Answer a question: rf comment PATH TEXT --thread cN --wait, which prints what the agent says back. Decide a proposal:
  rf approve PATH cN [TEXT] --wake, for the agent to go ahead, or rf reject PATH cN [TEXT] --wake. Close an
  instance once it's the record: rf close PATH.
- Transfer a whole series, as its current owner or workspace manager: rf series owner SERIES EMAIL. The incoming owner
  selects credentials with rf series credentials SERIES --set OFFER,... --autonomous false, or --clear for none.
  Every instance may use that selection: this is not an instance setting. No self-takeover right for collaborators.
- Your logins: rf logins lists them, with what each offers, and an expired one's link to sign in again on the page.
- Give an input or a corrected output: rf upload PATH FILE [--onto ITEM] [--output], with --wake on the last for a run on them
  all.
- Start an instance: rf new instance SERIES LABEL --wake, only as the series owner. Scheduled wakes need that owner's
  autonomous opt-in and keep their authorized credential snapshot; collaborators' wakes become requests for the owner.
  A one-off: rf new task WORKSPACE --clear --comment TEXT --wake. Promotion with rf new series PATH NAME keeps its owner.
- Tell a series something for its runs, such as a rule from now on, or while no instance is open: rf note SERIES TEXT, which
  starts no run; rf note SERIES lists its notes, open, and settled by a run or by hand.
- Read what a run did: rf show PATH for its last run, rf log PATH for every entry, --follow as they come, and rf cat PATH/FILE
  for a file; rf pull PATH/ DIR copies the folder, with session/ for every step.

Watching over it, for admins and power users; each sees what the caller sees
- What's stuck: rf status lists low OpenRouter credit (for admins), runs going, flagging those past --long MIN (30); queued runs, since when and why: their series is
  running, an update's drain, the RF_MAX_RUNS cap, or memory; what waits on whom since when: asks, notes for series owners, expired logins and the instances
  they hold, and requests to start, grouped by whom they wait on, the oldest three each unless --all; open instances whose last run
  failed; and indexes crawling or failing.
- What runs use (admins): rf top shows the host's CPU, load and memory, each run going with its processes, CPU and memory, and the
  ten processes of runs busiest by CPU and by memory. rf kill PID ends one, with all it started; rf interrupt PATH stops a run.
  rf top, rf status and rf runs take -d SECONDS to show again every SECONDS, as top does, until Ctrl+C.
- Indexes: rf indexes shows each index of a big library or mailbox you index, every one for admins: its items and size, and per
  person whether it is crawling or following changes, pages read, when last caught up, and an error, if any, with its next try.
- History: rf runs [PATH] [--since DATE] [--failed] [--running] [--long MIN] prints a table, a row per run: its start, path, run number,
  outcome, time taken, cost, what started it and by whom, and any error. rf costs [PATH] [--since DATE] [--by
  workspace|series|person|day|outcome] [--daily] totals them (by the runner for person, plus server calls and OpenRouter key usage
  for admins). A DATE such as 2026-11-01 starts at its midnight on this machine's clock, the days --by day groups by.
- People: rf people (admins) prints everyone as ROLE EMAIL lines, and rf people WORKSPACE (its owners and admins) its owners and
  members as owner|member lines; a comment after each says when they last signed in and which series they own, and for
  everyone those they own in workspaces they aren't in. Edit the lines, see the changes with --set FILE -n (FILE may be - for
  stdin), then --set FILE. For everyone it sets the roles of the people listed and adds new ones, removing no one (rf user remove
  does); for a workspace it replaces its people. A change that would hide an owned series from its owner is refused,
  naming them, unless --force: explicitly transfer whole series to someone who stays first.`;

const config = join(homedir(), '.config', 'rollforward.json');
const [cmd, ...argv] = process.argv.slice(2);
const flags: Record<string, string | true> = {}, excludes: string[] = [], args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] === '-n' ? 'dry-run' : argv[i] === '-d' ? 'delay' : argv[i].match(/^--(.+)$/)?.[1];
  if (!flag) args.push(argv[i]);
  else if (['wait', 'wake', 'output', 'delete', 'dry-run', 'force', 'json', 'failed', 'running', 'clear', 'follow', 'superseded', 'undo', 'by-amount', 'yes', 'mine', 'daily', 'all'].includes(flag)) flags[flag] = true;
  else if (argv[i + 1] === undefined) throw new Error(`--${flag} takes a value`);
  else if (flag === 'exclude') excludes.push(argv[++i]);
  else flags[flag] = argv[++i];
}
if (cmd === '--version') {
  // Its package's: cli/ in the repo, beside rf.mjs once published.
  console.log(JSON.parse(readFileSync(new URL(import.meta.url.endsWith('.ts') ? '../cli/package.json' : 'package.json', import.meta.url), 'utf8')).version);
  process.exit();
}
if ((!cmd || cmd === 'help') && !existsSync(config)) {
  console.log(!cmd ? usage() : args[0] ? usage(args[0]) : GUIDE);
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

if (!cmd || cmd === 'help') {
  const me = await get('/me'), vpn = me.can.includes('vpn'), admin = me.role === 'admin';
  const guide = GUIDE + (vpn ? `\n\nClient VPNs
${usage('vpns', vpn, admin)}
${admin ? `${usage('vpn', vpn, admin)}\n` : ''}rf site set NAME --via VPN uses your connection to that client VPN for this website; --via '' clears it.
Sign in to a VPN on the page. VPN access needs an explicit grant, even for admins.` : '');
  console.log(!cmd || args[0] ? usage(args[0], vpn, admin) : guide);
  process.exit();
}

async function find(path: string) {
  const [w, s, l, more] = path.replace(/\/+$/, '').split('/');
  const series = s !== undefined && more === undefined ? (await get('/api')).find(x => x.name === w)?.series.find(x => x.name === s) : undefined;
  const inst = l === undefined ? undefined : series?.instances.find(i => i.label === l);
  if (!series || (l !== undefined && !inst)) throw new Error(`nothing you can see at ${path}`);
  return { series, inst, at: inst ? `/api/instances/${inst.id}` : '' };
}
async function instanceAt(path: string) {
  const { series, inst, at } = await find(path);
  if (!inst) throw new Error(`${path} is a series: name one of its instances, as rf ls lists them`);
  return { series, inst, at };
}
async function seriesAt(path: string) {
  const { series, inst } = await find(path);
  if (inst) throw new Error(`${path} is an instance: name its series`);
  return series;
}
async function workspaceNamed(name: string) {
  const ws = (await get('/api')).find(w => w.name === name);
  if (!ws) throw new Error(`no workspace ${name}`);
  return ws;
}
// An instance's path as rf ls prints it, by its id.
const pathOf = async (id: string) => (await get('/api')).flatMap(w => w.series.flatMap(s => s.instances.filter(i => i.id === id).map(i => `${w.name}/${s.name}/${i.label}`)))[0];
// Explicit series-wide offer selection.
const ticks = () => flags.clear ? [] : String(flags.creds ?? flags.set ?? '').split(',').map(o => o.trim()).filter(Boolean);
const consent = (offers: string[]) => `, series-wide ceiling: ${offers.join(', ') || 'no credentials'}; you explicitly consent to agents acting as you`;

// Times as this machine's clock reads them, and lengths of time and costs, for the views.
const when = (iso: string) => new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
const grantText = (g: any) => `${g.description}${g.flags.length ? ` Flags: ${g.flags.join('; ')}.` : ''}${g.adminOnly ? ` ${g.adminWhy}.` : ''}`;
const took = (s: number) => s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
const usd = (n: number, est?: boolean) => `${est ? '~' : ''}${n < 0 ? '-$' + (-n).toFixed(2) : '$' + n.toFixed(2)}`;
const usdNote = (n: number, est?: boolean) => `${usd(n, est)}${est ? ' (est.)' : ''}`;
const signedUsd = (n: number) => `${n >= 0 ? '+$' : '-$'}${Math.abs(n).toFixed(2)}`;
// Text as a terminal lays it out: a CJK character or an emoji takes two columns. A cell is cut to its column's width with …, and a
// table's columns line up under its header; the last one is left as long as it is.
const wide = (c: number) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
  || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
const cols = (t: string) => [...t].reduce((n, ch) => n + (wide(ch.codePointAt(0)!) ? 2 : 1), 0);
function clip(t: string, max: number) {
  if (cols(t) <= max) return t;
  let out = '', n = 0;
  for (const ch of t) {
    const w = wide(ch.codePointAt(0)!) ? 2 : 1;
    if (n + w > max - 1) break;
    out += ch; n += w;
  }
  return `${out}…`;
}
const table = (header: string[], rows: string[][], indent = '  ') => {
  const all = header.length ? [header, ...rows] : rows, widths = (all[0] ?? []).map((_, i) => Math.max(...all.map(r => cols(r[i] ?? ''))));
  return all.map(r => indent + r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i] - cols(c)))).join('  ').trimEnd()).join('\n');
};
// What a person reads of an agent's words in a list: the first line, without markdown's marks, cut to `max` columns.
const gist = (text: string, max: number) => clip((text.split('\n').find(l => l.trim()) ?? '').trim()
  .replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, ''), max);
// An error as one line: an answer's JSON body gives way to its message, as in "402 This request requires more credits".
function brief(error: string, max = 100) {
  const line = error.split('\n')[0], at = line.indexOf('{');
  if (at < 0) return clip(line, max);
  const head = line.slice(0, at).replace(/[\s:]+$/, ''), message = /"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(line.slice(at))?.[1];
  return clip([head, message?.replace(/\\(.)/g, '$1')].filter(Boolean).join(' '), max);
}
// -d SECONDS shows a view again every SECONDS, from the top of the screen, as top does, until Ctrl+C; a failure to fetch it shows in
// its place, and the next refresh tries again.
const MIN_DELAY = 1;
async function watch(view: () => Promise<string>) {
  if (flags.delay === undefined) return console.log(await view());
  const every = Number(flags.delay);
  if (!(every >= MIN_DELAY)) throw new Error(`-d: the seconds between refreshes, ${MIN_DELAY} or more`);
  for (;;) {
    let text: string;
    try { text = await view(); } catch (e) { if (!(e instanceof Error)) throw e; text = `rf: ${e.message}`; }
    process.stdout.write(`\x1b[H\x1b[2J${new Date().toLocaleString('sv-SE')}  every ${every}s, Ctrl+C to stop\n\n${text}\n`);
    await new Promise(r => setTimeout(r, every * 1000));
  }
}
// A view's widest path and text, in columns, and how many of what waits on one person rf status lists before --all.
const PATH_COLS = 60, TEXT_COLS = 70, WAITING = 3;
const mb = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`;
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
// --since DATE from its midnight on this machine's clock, as --by day groups by.
const since = encodeURIComponent(/^\d{4}-\d{2}-\d{2}$/.test(String(flags.since)) ? new Date(`${flags.since}T00:00`).toISOString() : String(flags.since ?? ''));
const runsIn = async (path = '') => (await get(`/api/runs?since=${since}`))
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
// in a dot or a space, which Windows drops. Nor may a name be what git takes for a .git, such as .GIT on a disk that ignores case,
// whose config would run a command as git runs there. A link where one of its folders goes, or `base`, would take the file
// elsewhere too, and is refused.
const under = (base: string, rel: string) => {
  const names = rel.split('/');
  if (names.some(n => !n || n === '.' || n === '..' || basename(n) !== n || /^(\.git|git~1)[. ]*([:\\]|$)/i.test(n)
    || (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]|[. ]$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n))))) return undefined;
  let folder = base;
  for (const name of ['', ...names.slice(0, -1)]) {
    folder = join(folder, name);
    let st: Stats | undefined;
    try { st = lstatSync(folder, { throwIfNoEntry: false }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') break; throw e; }
    if (st?.isSymbolicLink()) throw new Error(`${folder} is a symlink: remove it or pull into another directory`);
  }
  return join(base, ...names);
};

// rsync's --exclude, simply: a pattern without / matches any one name on the path, one with / the path from the pull's top; * and ?
// stop at /, ** doesn't. A folder it matches takes what's in it along.
const globs = excludes.map(p => [p.replace(/^\/|\/$/g, '').includes('/'), new RegExp(`^${p.replace(/^\/|\/$/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`)] as const);
const excluded = (rel: string) => globs.some(([whole, re]) => rel.split('/').some((name, k, all) => re.test(whole ? all.slice(0, k + 1).join('/') : name)));

// Copies PATH's files into DIR as rsync does, from the server only and whole: a file whose size or time differ from the server's is
// fetched, and given the server's time, so the next pull compares against it. Nothing is kept besides the files. DIR may be a link, as the
// person who names it chose; no folder in it may.
async function pull(path: string, dir: string) {
  const at = path.replace(/^\/+/, ''), from = at.replace(/\/+$/, ''), dry = !!flags['dry-run'];
  const size = /^(\d+)([KMG]?)$/i.exec(String(flags['max-size'] ?? '0'));
  if (!size) throw new Error(`--max-size: a size such as 500K, 50M or 2G, not ${flags['max-size']}`);
  const max = flags['max-size'] === undefined ? Infinity : Number(size[1]) * 1024 ** ' KMG'.indexOf(size[2].toUpperCase() || ' ');
  const list: { path: string; size: number; mtime: string; url?: string; text?: string }[] = await get(`/api/files?path=${encodeURIComponent(from)}`);
  if (!list.length) throw new Error(`nothing you can see at ${path}`);
  const to = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  const into = !from || at.endsWith('/') ? to : under(to, from.slice(from.lastIndexOf('/') + 1)), rel = (f: { path: string }) => f.path.slice(from ? from.length + 1 : 0);
  if (!into) throw new Error(`${from} can't be a name here: pull ${from}/ into a folder of your choosing`);
  let fetched = 0, same = 0, deleted = 0, failed = 0, big = 0;
  const fold = (r: string) => ['win32', 'darwin'].includes(process.platform) ? r.toLowerCase() : r;
  const fetches: (() => Promise<void>)[] = [], cased = new Map<string, string>(), keep = new Set<string>();
  for (const f of list.filter(f => !excluded(rel(f)))) {
    const local = rel(f) ? under(into, rel(f)) : into;
    let st: Stats | undefined;
    try { st = local ? statSync(local, { throwIfNoEntry: false }) : undefined; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e; }
    if (!local) {
      console.error(`skipped ${f.path}: it can't be a file's name here`);
      continue;
    }
    // Windows' and macOS's disks take two names that differ only in case for one file or folder: the second is skipped.
    if (['win32', 'darwin'].includes(process.platform)) {
      const parts = f.path.split('/'), prefixes = parts.map((_, k) => parts.slice(0, k + 1).join('/'));
      const hit = prefixes.map(p => cased.get(p.toLowerCase())).find((v, k) => v && (v !== prefixes[k] || k === prefixes.length - 1));
      if (hit) {
        console.error(`skipped ${f.path}: this disk takes it for ${hit}, which differs only in case`);
        continue;
      }
      for (const p of prefixes) cased.set(p.toLowerCase(), p);
    }
    keep.add(fold(rel(f)));
    if (st?.isFile() && st.size === f.size && Math.floor(st.mtimeMs / 1000) === Math.floor(Date.parse(f.mtime) / 1000)) {
      same++;
      continue;
    }
    if (f.size > max) {
      console.log(`skipped  ${f.path}: ${f.size} bytes, over --max-size`);
      big++;
      continue;
    }
    fetches.push(async () => {
      console.log(`${st?.isFile() ? 'changed' : 'new'}  ${f.path}`);
      try {
        if (!dry) write(local, f.text ?? new Uint8Array(await (await api(f.url!)).arrayBuffer()), f.mtime);
        fetched++;
      } catch (e) {
        failed++;
        console.error(`${f.path}: ${(e as Error).message}`);
      }
    });
  }
  if (flags.delete && list.some(f => rel(f) && !excluded(rel(f))) && existsSync(into) && !lstatSync(into).isDirectory()) {
    console.log(`deleted  ${basename(into)}`);
    deleted++;
    if (!dry) rmSync(into);
  }
  if (flags.delete && existsSync(into) && lstatSync(into).isDirectory()) {
    // Windows' and macOS's disks ignore case, as the fetches above did: a file renamed only in case is kept, as fetched.
    const mine = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const full = join(d, e.name), r = relative(into, full).split(sep).join('/');
      return excluded(r) ? [] : e.isDirectory() ? mine(full) : [full];
    });
    for (const p of mine(into)) {
      const r = relative(into, p).split(sep).join('/');
      if (keep.has(fold(r))) continue;
      console.log(`deleted  ${r}`);
      deleted++;
      if (!dry) rmSync(p, { force: true });
    }
    const prune = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name), r = relative(into, full).split(sep).join('/');
        if (e.isDirectory() && !excluded(r)) prune(full);
      }
      if (d !== into && !excluded(relative(into, d).split(sep).join('/')) && !readdirSync(d).length) rmdirSync(d);
    };
    if (!dry) {
      prune(into);
      if (list.some(f => !rel(f) && !excluded('')) && !readdirSync(into).length) rmdirSync(into);
    }
  }
  // Up to 8 files are fetched at once, each started in the list's order.
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let next; (next = fetches.shift());) await next();
  }));
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
  // --mine: open instances of series you own.
  const me = flags.mine && await get('/me'), rows = (await get('/api')).flatMap(w => w.series.flatMap(s => [
    ...me ? [] : [{ path: `${w.name}/${s.name}`, id: s.id, owner: s.owner, requests: s.requests.length, wakes: s.wakes }],
    ...s.instances.filter(i => !me || (i.status === 'open' && i.owner === me.email)).map(i => ({ path: `${w.name}/${s.name}/${i.label}`, id: i.id, status: i.status, running: i.running, asks: i.asks.length, owner: i.owner, wakes: i.wakes, ...(i.wakeCheck && { wakeCheck: i.wakeCheck }), ...(i.deleted && { deleted: i.deleted }) })),
  ]));
  if (flags.json) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) {
    console.log(r.deleted ? `${r.path}  deleted by ${r.deleted.by} ${when(r.deleted.at)}` : r.status ? `${r.path}  ${r.status}${r.running ? ', running' : ''}${r.asks ? `, ${r.asks} asks waiting` : ''}, owner ${r.owner}` : `${r.path}${r.requests ? `  ${r.requests} asking to start` : ''}`);
    if (r.wakeCheck) console.log(`  Wake check stopped: ${clip(r.wakeCheck.message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), TEXT_COLS)}`);
    for (const k of r.wakes) console.log(`  wake ${k.id} ${k.at}${k.label ? ` starts ${k.label}` : ''}${k.days ? `, then each ${k.days.join(', ')}` : ''}${k.text ? `: ${k.text}` : ''}${k.check ? `; check ${k.check}${k.deadline ? ` until ${k.deadline}` : ''}` : ''}`);
  }
} else if (cmd === 'waiting' && !args.length) {
  const [me, s, all] = await Promise.all([get('/me'), get('/api/status'), get('/api')]), mine = (who: string | null) => (who ?? me.email) === me.email;
  const series = all.flatMap(w => w.series.map(x => ({ ...x, path: `${w.name}/${x.name}` })));
  const rows = [
    ...s.ownership.map(s => ({ kind: 'owner', path: s.path, text: s.text })),
    ...s.asks.filter(a => a.who === me.email).map(a => ({ kind: a.note ? 'note' : 'ask', path: a.path, since: a.since, text: a.text })),
    ...series.flatMap(x => x.requests.filter(r => mine(r.who)).map(r => ({ kind: 'request', path: x.path, since: r.at, id: r.id, text: `${r.from} asks to ${r.target ? 'wake' : 'start'} ${r.label}${r.text ? `: ${r.text}` : ''}` }))),
    ...all.filter(w => w.manage && w.proposal?.into === w.id).map(({ proposal: p }) => ({ kind: 'proposal', path: p.to, since: p.at, text: `${p.by} proposes to ${p.kind === 'merge' ? `merge ${p.from} into it` : `move ${p.from}/${p.series} to it`}` })),
    ...s.expired.filter(e => e.who === me.email).map(e => ({ kind: 'expired', login: e.login, holding: e.holding, text: `your ${e.login} login expired` })),
    ...series.flatMap(x => x.instances.flatMap(i => i.refused.map(r => ({ kind: 'refused', path: `${x.path}/${i.label}`, since: r.at, site: r.site, hosts: r.hosts, person: r.login, why: r.why, text: `run ${r.run}'s browser on ${r.login}'s ${r.site} was refused ${r.hosts.map((h: string) => r.why[h] ? `${h} (${r.why[h]})` : h).join(', ')}` })))),
    ...all.filter(w => w.manage).flatMap(w => w.grants.filter(g => g.state === 'pending').map(g => ({ kind: 'grant', path: w.name, since: g.at, id: g.id, text: grantText(g) }))),
  ];
  if (flags.json) console.log(JSON.stringify(rows, null, 1));
  else console.log(rows.map(r => `${r.kind}  ${r.path ?? r.login}${r.since ? ` since ${when(r.since)}` : ''}${r.id ? `, ${r.kind === 'grant' ? 'grant' : 'request'} ${r.id}` : ''}: ${r.kind === 'grant' ? r.text : r.text.split('\n')[0].slice(0, 120)}`).join('\n') || 'Nothing waits on you.');
} else if (cmd === 'show' && args.length === 1) {
  const { inst, at } = await instanceAt(args[0]), { doc, log, run, queued, owner, waiting: w } = await get(at);
  const waiting = w.map(({ who, seq }) => {
    const e = log[seq - 1], first = log.find(x => `c${x.seq}` === e.thread);
    return { comment: `c${seq}`, thread: e.thread, kind: e.ask === true ? 'ask' : e.ask ?? 'note', for: who, by: e.by, item: first.item, ref: first.ref, text: e.text };
  });
  const done = log.findLast(e => e.op === 'done'), last = done ? { run: done.run, cost: done.cost, ...(done.estimated && { estimated: true }), error: done.error ?? null } : null;
  if (flags.json) console.log(JSON.stringify({ path: args[0], id: inst.id, status: doc.status, owner: owner.by, running: run, queued, items: doc.items, waiting, last_run: last, ...(doc.status === 'deleted' && { deleted: { by: log[0].by, at: log[0].at } }) }, null, 1));
  else {
    console.log(doc.status === 'deleted' ? `${args[0]}  deleted by ${log[0].by} ${when(log[0].at)}` : `${args[0]}  ${doc.status}, series owner ${owner.by}${run ? `, run ${run.n} going, ${usdNote(run.cost, run.estimated)}` : queued ? ', queued' : ''}`);
    for (const i of doc.items) console.log(`  ${i.kind.padEnd(6)} ${i.id}  ${i.name}  ${i.file ?? 'no file yet'}${i.from?.length ? `  from ${i.from.join(', ')}` : ''}${i.headline ? `  ${i.headline}` : ''}`);
    for (const w of waiting) console.log(`${w.comment}  ${w.kind} for ${w.for}${w.comment === w.thread ? '' : ` in ${w.thread}`}${w.item ? `, on ${w.item}${w.ref ? ` at ${w.ref}` : ''}` : ''}: ${w.text.split('\n')[0].slice(0, 160)}`);
    if (last) console.log(`last run ${last.run}  ${usdNote(last.cost ?? 0, last.estimated)}${last.error ? `  ${last.error}` : ''}`);
  }
} else if (cmd === 'log' && args.length === 1) {
  const { at } = await instanceAt(args[0]);
  for (let since = Number(flags.since ?? 0); ; await new Promise(ok => setTimeout(ok, 3000))) {
    const fresh = (await get(at)).log.filter(e => e.seq > since);
    for (const e of fresh) {
      const { seq, at, by, op, text, ...rest } = e;
      console.log(flags.json ? JSON.stringify(e) : `${seq}  ${when(at)}  ${by}  ${op}${Object.keys(rest).length ? `  ${JSON.stringify(rest)}` : ''}${text ? `  ${String(text).split('\n')[0].slice(0, 200)}` : ''}`);
    }
    since = fresh.at(-1)?.seq ?? since;
    if (!flags.follow) break;
  }
} else if (cmd === 'cat' && args.length === 1) {
  const path = args[0].replace(/^\/+|\/+$/g, ''), [f, ...more] = await get(`/api/files?path=${encodeURIComponent(path)}`);
  if (!f || f.path !== path || more.length) throw new Error(f ? `${args[0]} is a folder: rf pull it` : `nothing you can see at ${args[0]}`);
  process.stdout.write(f.text ?? Buffer.from(await (await api(f.url)).arrayBuffer()));
} else if (cmd === 'pull' && args.length === 2) await pull(args[0], args[1]);
else if (cmd === 'comment' && args.length === 2) {
  const { at } = await instanceAt(args[0]);
  const posted = await post(`${at}/comment`, { text: args[1], item: flags.item, ref: flags.ref, thread: flags.thread, quiet: !flags.wake && !flags.wait });
  const seq = Number(posted.headers.get('X-RF-Comment-Seq')), { doc, log, owner, starts, standing } = await get(at), note = log.find(e => e.seq === seq)?.note;
  if (!starts && standing?.[seq] !== 'answer') console.log(`recorded for the series owner, ${owner.by}, seq ${seq}: no run starts`);
  else if (!flags.wait) console.log(`${note ? `a note for the series owner, ${owner.by}` : 'commented'}, seq ${seq}`);
  else if (doc.status !== 'open') console.log(`The instance was ${doc.status}.`);
  else for (;;) {
    // The run that saw the comment, and what it said from then on: a run ending as it came may not have.
    await new Promise(r => setTimeout(r, 5000));
    const { doc, log } = await get(at);
    const done = log.find(e => e.op === 'done' && (e.seen >= seq || (e.seq > seq && (e.error || e.aborted) && !log.some(w => w.seq > e.seq && ((w.op === 'wake' && w.cause === e.seq) || w.op === 'run')))));
    if (done) {
      const from = Math.max(seq, log.find(e => e.op === 'run' && e.run === done.run)?.seq ?? 0);
      for (const e of log.filter(e => e.seq > from && e.seq < done.seq && e.op === 'comment' && e.by === 'agent' && !e.see)) console.log(`${e.ask === 'proposal' ? 'Proposes' : e.ask ? 'Asks' : 'Says'} in ${e.thread}:\n${e.text}\n`);
      if (done.error) console.log(`The run failed: ${done.error}`);
      else if (done.aborted && done.seen < seq) console.log('The run was stopped.');
      break;
    }
    if (doc.status !== 'open') {
      console.log(`The instance was ${doc.status}.`);
      break;
    }
  }
} else if (cmd === 'react' && [2, 3].includes(args.length) && ['up', 'down', 'none'].includes(args.at(-1)!)) {
  const on = args.length === 3 ? Number(args[1].replace(/^c/, '')) : undefined, up = { up: true, down: false, none: null }[args.at(-1)!];
  await post(`${(await instanceAt(args[0])).at}/react`, { ...(on !== undefined && { on }), up });
  console.log(`${args.at(-1)} on ${args.length === 3 ? args[1] : args[0]}`);
} else if (['approve', 'reject'].includes(cmd) && [2, 3].includes(args.length)) {
  await post(`${(await instanceAt(args[0])).at}/${cmd === 'approve' ? 'signoff' : 'reject'}`, { thread: args[1], text: args[2], quiet: !flags.wake });
  console.log(`${cmd === 'approve' ? 'approved' : 'rejected'} ${args[1]}`);
} else if (['close', 'abandon', 'interrupt'].includes(cmd) && args.length === 1) {
  const { series, at } = await instanceAt(args[0]);
  await post(`${at}/${cmd}`, { quiet: !flags.wake });
  if (cmd === 'close' && typeof flags['as-series'] === 'string') await post(`/api/series/${series.id}/promote`, { name: flags['as-series'] });
  console.log(`${cmd === 'close' ? 'closed' : `${cmd}ed`} ${args[0]}`);
} else if (cmd === 'delete' && args.length === 1) {
  // One confirm, which says it can't be undone and what stays outside the server.
  const { at } = await instanceAt(args[0]);
  if (!flags.yes) {
    const warning = `Deleting ${args[0]} can't be undone. A run for it is cut, and everything the server holds of it goes: its uploads, the agent's files, its items, threads and log, its runs' transcripts and browser logs, and its history; its label stays in its place, shown as deleted by you. Copies outside the server stay: instances copied from it, files other runs copied, rf pull copies, mail sent.`;
    if (!process.stdin.isTTY) throw new Error(`${warning} Confirm with --yes`);
    const { createInterface } = await import('node:readline/promises'), rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${warning}\nType delete to delete it: `);
    rl.close();
    if (answer.trim() !== 'delete') throw new Error(`kept ${args[0]}`);
  }
  await post(`${at}/delete`, {});
  console.log(`deleted ${args[0]}`);
} else if (cmd === 'series' && args[0] === 'owner' && [2, 3].includes(args.length)) {
  const s = await seriesAt(args[1]);
  if (args.length === 3) {
    if (flags.creds !== undefined || flags.set !== undefined || flags.clear || flags.autonomous !== undefined) throw new Error('a transfer grants no credentials: the incoming owner selects series credentials separately');
    await post(`/api/series/${s.id}/owner`, { owner: args[2] }, 'PUT');
    console.log(`transferred whole series ${args[1]} to ${args[2]}; all instances change owner, old runs stop, consent cleared; starts no run`);
  } else if (flags.json) console.log(JSON.stringify({ owner: s.owner, since: s.since, epoch: s.epoch }, null, 1));
  else console.log(`${args[1]}: series owner ${s.owner ?? 'not selected'}`);
} else if (cmd === 'series' && args[0] === 'credentials' && args.length === 2) {
  const s = await seriesAt(args[1]);
  if (flags.set !== undefined || flags.clear) {
    if (!['true', 'false'].includes(String(flags.autonomous))) throw new Error('saving requires --autonomous true|false');
    await post(`/api/series/${s.id}/credentials`, { logins: ticks(), autonomous: flags.autonomous === 'true' }, 'PUT');
    console.log(`saved ${args[1]}${consent(ticks())}; autonomous ${flags.autonomous}`);
  } else {
    if (flags.autonomous !== undefined) throw new Error('select credentials with --set OFFER,... or --clear');
    const mine = await get('/logins');
    const out = { owner: s.owner, consent: s.consent, yours: mine.flatMap(l => l.offers.map(o => ({ ...o, ...(l.expired && { expired: true }) }))) };
    if (flags.json) console.log(JSON.stringify(out, null, 1));
    else console.log([`Series owner: ${out.owner ?? 'not selected'}`, out.consent ? `Series-wide ceiling: ${out.consent.logins.join(', ') || 'no credentials'}; autonomous ${out.consent.autonomous}` : 'No execution consent', 'your offers:', ...out.yours.map(o => `  ${o.id}  ${o.name}${o.expired ? '  expired' : ''}`)].join('\n'));
  }
} else if (cmd === 'rename' && args.length === 2) {
  const [w, s, l] = args[0].replace(/\/+$/, '').split('/');
  if (l !== undefined) await post(`${(await instanceAt(args[0])).at}/rename?as=${encodeURIComponent(args[1])}`, {});
  else if (s !== undefined) await post(`/api/series/${(await find(args[0])).series.id}`, { name: args[1] }, 'PUT');
  else await post(`/api/workspaces/${(await workspaceNamed(w)).id}`, { name: args[1] }, 'PUT');
  console.log(`renamed ${args[0]} ${args[1]}`);
} else if (cmd === 'new' && args[0] === 'task' && [2, 3].includes(args.length)) {
  const workspace = await workspaceNamed(args[1]), clean = args.length === 3 ? args[2].replace(/[/\\\x00-\x1f\x7f\x85\u2028\u2029]/g, '_') : '';
  if (args.length === 3) {
    if (!clean) throw new Error('a name is needed');
    if (clean.startsWith('.')) throw new Error(`a name can't start with a dot: ${args[2]}`);
    if (clean === 'AGENTS.md') throw new Error("AGENTS.md is the name of the agents' instructions: choose another");
    if (Buffer.byteLength(clean) > 200) throw new Error(`a name is 200 bytes at most, about 66 Chinese characters, not ${Buffer.byteLength(clean)}`);
    if (workspace.series.some((s: any) => s.name === clean)) throw new Error(`${clean} exists`);
  }
  const selected = flags.creds !== undefined || !!flags.clear;
  if (flags.autonomous !== undefined && !['true', 'false'].includes(String(flags.autonomous))) throw new Error('--autonomous is true or false');
  if (flags.autonomous !== undefined && !selected) throw new Error('autonomous consent requires --creds OFFER,... or --clear');
  const { instance } = await (await post('/api/series', { workspace: workspace.id, single: true, ...(selected && { logins: ticks(), autonomous: flags.autonomous === 'true' }) })).json();
  if (clean && (await pathOf(instance)).split('/').at(-1) !== clean) await post(`/api/instances/${instance}/rename?as=${encodeURIComponent(args[2])}`, {});
  if (typeof flags.comment === 'string') await post(`/api/instances/${instance}/comment`, { text: flags.comment, quiet: !flags.wake });
  console.log(`made ${await pathOf(instance)}${selected ? consent(ticks()) : '; no execution consent: select series credentials before running'}`);
} else if (cmd === 'new' && args[0] === 'instance' && args.length === 3) {
  if (flags.creds !== undefined || flags.clear || flags.autonomous !== undefined) throw new Error('instance credentials were removed: use rf series credentials SERIES');
  const series = await seriesAt(args[1]);
  const { id } = await (await post(`/api/series/${series.id}`, { label: args[2], quiet: !flags.wake })).json();
  console.log(`made ${await pathOf(id)}; series owner and ceiling unchanged${series.owner ? `; ${series.owner} starts its runs` : ''}`);
} else if (cmd === 'new' && args[0] === 'series' && args.length === 3) {
  await post(`/api/series/${(await find(args[1])).series.id}/promote`, { name: args[2] });
  console.log(`made the series ${args[1].split('/')[0]}/${args[2]}`);
} else if (cmd === 'new' && args[0] === 'workspace' && args.length === 2) {
  await post('/api/workspaces', { name: args[1] });
  console.log(`made ${args[1]}`);
} else if (cmd === 'archive' && args.length === 1) {
  const [w, s] = args[0].replace(/\/+$/, '').split('/');
  await post(s === undefined ? `/api/workspaces/${(await workspaceNamed(w)).id}` : `/api/series/${(await seriesAt(args[0])).id}`, { archived: !flags.undo }, 'PUT');
  console.log(flags.undo ? `brought back ${args[0]}` : `archived ${args[0]}, its wakes and requests cancelled for good`);
} else if (cmd === 'request' && ['start', 'drop'].includes(args[0]) && args.length === 2) {
  if (args[0] === 'drop') {
    await api(`/api/requests/${args[1]}`, { method: 'DELETE' });
    console.log(`dropped request ${args[1]}`);
  } else {
    if (flags.creds !== undefined || flags.clear) throw new Error('request credentials were removed: use rf series credentials SERIES');
    const r = await post(`/api/requests/${args[1]}`, { quiet: !flags.wake });
    const woke = r.headers.get('X-RF-Woke') === '1', { id } = await r.json();
    console.log(`${woke ? 'woke' : 'made'} ${await pathOf(id)}; series owner and ceiling unchanged`);
  }
} else if (cmd === 'logins' && !args.length) {
  const all = await get('/logins');
  if (flags.json) console.log(JSON.stringify(all, null, 1));
  else for (const l of all) {
    console.log(`${l.id}  ${l.name}  ${l.expired ? `expired: sign in again at ${url}/#logins` : `${l.kind === 'key' ? 'saved' : l.kind === 'service' ? 'connected' : 'signed in'} since ${when(l.since)}`}${l.kind === 'key' ? (l.enabled ? ', in use' : ', not in use') : ''}${l.keepalive > new Date().toISOString() ? `, kept alive until ${when(l.keepalive)}` : ''}${l.missing.length ? `, missing ${l.missing.join(', ')}` : ''}`);
    // A website's login offers itself alone.
    for (const o of l.offers.filter(o => o.id !== l.id)) console.log(`  offers ${o.id}  ${o.name}`);
  }
} else if (cmd === 'logins' && ['offer', 'unoffer', 'allow', 'disallow'].includes(args[0]) && args.length === 3) {
  const [what, login, x] = args, at = `/logins/${encodeURIComponent(login)}`;
  if (what === 'offer') await post(`${at}/offers`, { add: x });
  else if (what === 'unoffer') await api(`${at}/offers/${encodeURIComponent(x)}`, { method: 'DELETE' });
  else if (what === 'disallow') await api(`/logins/web/${encodeURIComponent(login)}/hosts/${encodeURIComponent(x)}`, { method: 'DELETE' });
  else await post(`/logins/web/${encodeURIComponent(login)}/hosts${flags.person ? `?person=${encodeURIComponent(String(flags.person))}` : ''}`, { host: x });
  console.log(`${login} ${{ offer: 'offers', unoffer: 'no longer offers', allow: 'reaches', disallow: 'no longer reaches' }[what]} ${x}`);
} else if (cmd === 'vpns' && !args.length) {
  const all = await get('/vpns');
  if (flags.json) console.log(JSON.stringify(all, null, 1));
  else for (const v of all) console.log(`${v.name}  ${v.type}  ${v.gateway}  ${v.connected ? `connected${v.since ? ` since ${when(v.since)}` : ''}` : 'disconnected'}${v.error ? `: ${v.error}` : ''}`);
} else if (cmd === 'vpn' && args[0] === 'add' && args.length === 4) {
  await post('/vpns', { name: args[1], type: args[2], gateway: args[3], servercert: flags.servercert });
  console.log(`added ${args[1]}`);
} else if (cmd === 'vpn' && args[0] === 'remove' && args.length === 2) {
  await api(`/vpns/${encodeURIComponent(args[1])}`, { method: 'DELETE' });
  console.log(`removed ${args[1]}`);
} else if (cmd === 'sites' && !args.length) {
  const [all, me] = await Promise.all([get('/logins/sites'), get('/me')]);
  if (!me.can.includes('vpn')) for (const w of Object.values<any>(all)) delete w.via;
  if (flags.json) console.log(JSON.stringify(all, null, 1));
  else for (const [name, w] of Object.entries<any>(all)) console.log(`${name}  ${w.url}${w.via ? ` via ${w.via}` : ''}${w.hosts.map((h: string) => `\n  reaches ${h}${w.checks?.[h]?.verdict === 'pass' ? `: ${w.checks[h].why}` : ''}`).join('')}`);
} else if (cmd === 'site' && args[0] === 'add' && args.length === 3) {
  const { site } = await (await post('/logins/sites', { name: args[1], url: args[2], header: flags.header })).json();
  console.log(`added ${site}: sign in to it at ${url}/#logins, then rf site ask ${site} WORKSPACE REASON`);
} else if (cmd === 'site' && args[0] === 'set' && args.length === 2) {
  await post(`/logins/sites/${encodeURIComponent(args[1])}${flags.person ? `?person=${encodeURIComponent(String(flags.person))}` : ''}`, { ...flags, person: undefined }, 'PATCH');
  console.log('saved');
} else if (cmd === 'site' && args[0] === 'remove' && args.length === 2) {
  await api(`/logins/sites/${encodeURIComponent(args[1])}`, { method: 'DELETE' });
  console.log(`removed ${args[1]}`);
} else if (cmd === 'site' && args[0] === 'ask' && args.length === 4) {
  const { id, said } = await (await post('/grants', { site: args[1], workspace: (await workspaceNamed(args[2])).id, reason: args[3] })).json();
  console.log(`${said} Grant ${id}: ${grantText((await get('/grants')).find(g => g.id === id))}`);
} else if (cmd === 'grants' && args.length <= 1) {
  const [all, ws] = await Promise.all([get('/grants'), get('/api')]), name = (id: string) => ws.find(w => w.id === id)?.name ?? id;
  const shown = all.filter(g => !args[0] || name(g.workspace) === args[0]);
  if (flags.json) console.log(JSON.stringify(shown.map(g => ({ ...g, workspace: name(g.workspace) })), null, 1));
  else for (const g of shown) console.log(`${g.id}  ${g.state}  since ${when(g.at)}: ${grantText(g)}${g.by ? `; ${g.state} by ${g.by}${g.text ? `: ${g.text}` : ''}` : ''}${g.use ? ` Used by ${g.use.runs} runs, ${g.use.wrote} wrote; last use ${g.use.last ? when(g.use.last) : 'never'}.` : ''}`);
} else if (cmd === 'grant' && ['approve', 'deny'].includes(args[0]) && [2, 3].includes(args.length)) {
  const g = (await get('/grants')).find(g => g.id === args[1]);
  if (!g) throw new Error(`no request ${args[1]} waits`);
  console.log(grantText(g));
  await post(`/grants/${args[1]}`, { approve: args[0] === 'approve', text: args[2] });
  console.log(args[0] === 'approve' ? 'approved' : 'denied');
} else if (cmd === 'grant' && args[0] === 'revoke' && args.length === 2) {
  await api(`/grants/${args[1]}`, { method: 'DELETE' });
  console.log('revoked');
} else if (cmd === 'logins' && args[0] === 'signout' && args.length === 2) {
  await api(`/logins/${encodeURIComponent(args[1])}`, { method: 'DELETE' });
  console.log(`signed out of ${args[1]}`);
} else if (cmd === 'correct' && args.length === 2) {
  const { series, at } = await instanceAt(args[0]), see = flags.see === undefined ? undefined : series.instances.find(i => i.label === flags.see);
  if (flags.see !== undefined && !see) throw new Error(`no instance ${flags.see} in its series`);
  console.log(await (await post(`${at}/correct`, { kind: flags.superseded ? 'superseded' : 'wrong', text: args[1], item: flags.item, ref: flags.ref, see: see?.id })).text());
} else if (cmd === 'upload' && args.length === 2) {
  const q = new URLSearchParams({ name: basename(args[1]), pane: flags.output ? 'out' : 'in', ...(typeof flags.onto === 'string' && { onto: flags.onto }), ...(!flags.wake && { quiet: '1' }) });
  await api(`${(await instanceAt(args[0])).at}/upload?${q}`, { method: 'POST', body: readFileSync(args[1]) });
  console.log('uploaded');
} else if (cmd === 'wake' && typeof flags.cancel === 'string' && !args.length) {
  await api(`/api/wakes/${flags.cancel}`, { method: 'DELETE' });
  console.log('cancelled');
} else if (cmd === 'wake' && [2, 3].includes(args.length)) {
  const { series, inst } = await find(args[0]);
  const at = args[1] === 'now' ? Date.now() : args[1].startsWith('+') ? Date.now() + Number(args[1].slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[args[1].at(-1)!]! : Date.parse(args[1]);
  const w = await (await post(`/api/wakes/${inst?.id ?? series.id}`, { at: new Date(at).toISOString(), label: flags.label, days: flags.days, text: args[2], check: flags.check, deadline: flags.deadline }, 'PUT')).json();
  console.log(`wake ${w.id} at ${w.at}${w.days ? `, then each ${w.days.join(', ')}` : ''}${w.check ? `; check ${w.check}${w.deadline ? ` until ${w.deadline}` : ''}` : ''}`);
} else if (cmd === 'note' && [1, 2].includes(args.length)) {
  const at = `/api/series/${(await seriesAt(args[0])).id}/notes`;
  if (args[1]) console.log(`noted ${(await (await post(at, { text: args[1] })).json()).id} on ${args[0]}: it starts no run, and its runs read it`);
  else {
    const all = await get(at);
    if (flags.json) console.log(JSON.stringify(all, null, 1));
    else for (const n of all) console.log(`n${n.seq}  ${when(n.at)}  ${n.by === 'agent' ? `agent of ${n.see.label}, for ${n.runner}` : n.by}  ${n.settled ? `${n.settled.op === 'taken' ? 'taken' : 'set aside'} by ${n.settled.by === 'agent' ? 'agent' : n.settled.by}: ${n.settled.text}` : 'open'}\n  ${n.text.split('\n')[0].slice(0, 200)}`);
  }
} else if (cmd === 'agents' && args.length <= 1) {
  const ws = args[0] === undefined ? undefined : await workspaceNamed(args[0]);
  if (typeof flags.set !== 'string') console.log(ws ? ws.agents : (await get('/agents')).text);
  else {
    const text = readFileSync(flags.set === '-' ? 0 : flags.set, 'utf8');
    await (ws ? post(`/api/workspaces/${ws.id}`, { agents: text }, 'PUT') : api('/agents', { method: 'PUT', body: text }));
    console.log('saved');
  }
} else if (cmd === 'readers' && args.length === 1) {
  const ws = await workspaceNamed(args[0]);
  if (flags.json) console.log(JSON.stringify({ readers: ws.readers, reads: ws.reads }, null, 1));
  else console.log([...ws.readers.map(r => `${r.name} reads ${ws.name}`), ...ws.reads.map(r => `${ws.name} reads ${r.name}`)].join('\n') || `${ws.name} reads no other workspace, and none reads it`);
} else if (cmd === 'readers' && args.length === 3 && ['add', 'remove'].includes(args[1])) {
  // A workspace you don't see, whose link with one of yours you take off, is found among what yours read or let read them.
  const all = await get('/api'), linked = args[1] === 'remove' ? all.flatMap(w => [...w.reads, ...w.readers]) : [];
  const [ws, other] = [args[0], args[2]].map(name => all.find(w => w.name === name) ?? linked.find(r => r.name === name));
  if (!ws || !other) throw new Error(`no workspace ${ws ? args[2] : args[0]}`);
  await post(`/api/workspaces/${ws.id}/readers/${other.id}`, {}, args[1] === 'add' ? 'PUT' : 'DELETE');
  console.log(args[1] === 'add' ? `${other.name}'s agents read ${ws.name} from their next run` : `${other.name}'s agents no longer read ${ws.name}`);
} else if (cmd === 'skill' && args[0] === 'push' && args[1]) {
  const dotgit = (n: string) => [n, ...Array.from(n.slice(1).matchAll(/\\/g), m => n.slice(m.index + 2))].some(t => /^(\.git|git~1)[. ]*([:\\]|$)/i.test(t));
  const walk = (at: string): string[] => readdirSync(at, { withFileTypes: true }).filter(d => !dotgit(d.name))
    .flatMap(d => d.isDirectory() ? walk(join(at, d.name)) : d.isFile() ? [join(at, d.name)] : []);
  const files = Object.fromEntries(walk(args[1]).map(p => [relative(args[1], p).split(sep).join('/'), readFileSync(p).toString('base64')]).filter(([rel]) => rel !== '.pushed.json'));
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
} else if (cmd === 'connection' && args[0] === 'remove' && args[1]) {
  await api(`/connections/${encodeURIComponent(args[1])}`, { method: 'DELETE' });
  console.log('removed');
} else if (cmd === 'status' && !args.length) await watch(async () => {
  const [s, ix] = await Promise.all([get('/api/status'), get('/api/indexes')]), long = Number(flags.long ?? 30);
  if (flags.json) return JSON.stringify({ ...s, indexes: ix }, null, 1);
  else {
    const lowLine = s.low_credit ? `Low OpenRouter credit: ${usd(s.low_credit.remaining)} remaining${s.low_credit.limit !== null ? ` of ${usd(s.low_credit.limit)} limit` : ''}${s.low_credit.reset ? ` (resets ${s.low_credit.reset})` : ''}${s.low_credit.key === 'fallback' ? ', on the fallback key, the first being low too' : ''}` : '';
    // What waits, by whom it waits on, oldest first, at most WAITING each unless --all.
    const waiting: { who: string; kind: string; since?: string; path: string; text: string }[] = [
      ...s.ownership.map(o => ({ who: 'workspace managers', kind: 'owner', path: o.path, text: o.text })),
      ...s.asks.map(a => ({ who: a.who, kind: a.note ? 'note' : 'ask', since: a.since, path: a.path, text: a.text })),
      ...s.requests.map(r => ({ who: r.who ?? 'anyone', kind: 'request', since: r.at, path: r.path, text: `${r.from} asks to ${r.target ? 'wake' : 'start'} ${r.label}` })),
      ...s.proposals.map(p => ({ who: `${p.to}'s owners`, kind: 'proposal', since: p.at, path: p.to, text: `${p.by} proposes to ${p.kind === 'merge' ? `merge ${p.from} into it` : `move ${p.from}/${p.series} to it`}` })),
      ...s.expired.map(e => ({ who: e.who, kind: 'login', path: e.holding.join(', '), text: `their ${e.login} login expired` })),
    ];
    const byWho = Map.groupBy(waiting.sort((a, b) => a.who.localeCompare(b.who) || (a.since ?? '').localeCompare(b.since ?? '')), w => w.who);
    // One table, its columns lined up across everyone, with each person's name above their rows.
    const groups = [...byWho].map(([who, ws]) => ({ who, all: ws.length, shown: flags.all ? ws : ws.slice(0, WAITING) }));
    const lines = table([], groups.flatMap(g => g.shown.map(w => [w.kind, w.since ? when(w.since) : '', clip(w.path, PATH_COLS), gist(w.text, TEXT_COLS)])), '    ').split('\n');
    const waits = groups.map(g => [`  ${g.who} (${g.all})`, ...lines.splice(0, g.shown.length),
      ...(g.shown.length < g.all ? [`    … ${g.all - g.shown.length} more: rf status --all`] : [])].join('\n'));
    const failing = ix.flatMap(x => x.people.filter(p => p.phase === 'crawl' || p.error).map(p => [clip(x.name, PATH_COLS), p.who,
      p.error ? `failing${p.retry_at ? `, again ${when(p.retry_at)}` : ''}` : `crawling, ${p.pages} pages`, p.error ? brief(p.error, TEXT_COLS) : '']));
    const sections: [string, number, string][] = [
      ['Running', s.running.length, table(['PATH', 'RUN', 'FOR', 'COST', ''], s.running.map(r => [clip(r.path, PATH_COLS), String(r.run), took((Date.now() - Date.parse(r.at)) / 1000),
        usdNote(r.cost, r.estimated), Date.now() - Date.parse(r.at) > long * 60e3 ? `LONG, past ${long}m` : '']))],
      ['Queued', s.queued.length, table(['PATH', 'SINCE', 'WHY'], s.queued.map(q => [clip(q.path, PATH_COLS), when(q.since), q.why]))],
      [`Waiting on ${byWho.size} ${byWho.size === 1 ? 'person' : 'people'}`, waiting.length, waits.join('\n')],
      ['Last run failed', s.failed.length, table(['PATH', 'RUN', 'AT', 'ERROR'], s.failed.map(f => [clip(f.path, PATH_COLS), String(f.run), when(f.at), brief(f.error, TEXT_COLS)]))],
      ['Indexes crawling or failing', failing.length, table(['INDEX', 'PERSON', 'STATE', 'ERROR'], failing)],
    ].filter(([, n]) => n) as [string, number, string][];
    const body = sections.map(([title, n, rows]) => `${title} (${n})\n${rows}`).join('\n\n');
    return [lowLine, body].filter(Boolean).join('\n\n') || 'Nothing is running, queued, waiting or failed.';
  }
});
else if (cmd === 'indexes' && !args.length) {
  const ix = await get('/api/indexes');
  if (flags.json) console.log(JSON.stringify(ix, null, 1));
  else console.log(ix.map(x => [`${x.name}  ${x.kind}  ${x.items} items  ${(x.bytes / 2 ** 20).toFixed(1)} MB`, ...x.people.map(p =>
    `  ${p.who}  ${p.phase}  ${p.pages} pages  caught up ${p.caught_up ? when(p.caught_up) : 'never'}${p.error ? `  ${p.retry_at ? `again ${when(p.retry_at)}` : 'stopped'}: ${p.error}` : ''}`)].join('\n')).join('\n\n') || 'No indexes.');
} else if (cmd === 'runs' && args.length <= 1) await watch(async () => {
  const rows = (await runsIn(args[0])).filter(r => (!flags.failed || r.outcome === 'failed') && (!flags.running || r.outcome === 'running') && (!flags.long || r.seconds >= Number(flags.long) * 60));
  if (flags.json) return JSON.stringify(rows, null, 1);
  return rows.length ? table(['START', 'PATH', 'RUN', 'OUTCOME', 'TIME', 'COST', 'STARTED BY', 'MESSAGE / ERROR'], rows.map(r => [when(r.at), clip(r.path, PATH_COLS), r.run === null ? '—' : String(r.run),
    `${r.outcome}${r.failure ? ` (${r.failure})` : ''}`, took(r.seconds), usdNote(r.cost, r.estimated), r.started ? `${r.started.op} by ${r.started.by}` : '', r.error ? brief(r.error, TEXT_COLS) : clip((r.message ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), TEXT_COLS)]), '') : 'No runs.';
});
else if (cmd === 'top' && !args.length) await watch(async () => {
  const m = await get('/monitor');
  if (flags.json) return JSON.stringify(m, null, 1);
  else {
    const h = m.host, at = (p: any) => `${clip(p.path, PATH_COLS)} run ${p.run}`;
    const procs = (ps: any[]) => table(['PID', 'CPU', 'MEMORY', 'AGE', 'RUN', 'SCRIPT', 'COMMAND'], ps.map(p => [`${p.pid}${p.own ? '*' : ''}`, `${p.cpu}%`, mb(p.rss), took(p.age), at(p),
      clip(p.script, TEXT_COLS / 2), clip(p.command, TEXT_COLS)]));
    return [
      `Host${h.cpus} CPUs, ${h.cpu}% busy, load ${h.load.map((l: number) => l.toFixed(2)).join(' ')}, ${mb(h.memory.free)} free of ${mb(h.memory.total)}; the server ${h.server.cpu}% CPU, ${mb(h.server.rss)}`,
      m.runs.length ? `Runs going (${m.runs.length})\n${table(['PATH', 'RUN', 'SERIES OWNER', 'FOR', 'PROCESSES', 'CPU', 'MEMORY'], m.runs.map((r: any) => [clip(r.path, PATH_COLS), String(r.run), r.runner,
        took((Date.parse(m.at) - Date.parse(r.since)) / 1000), String(r.procs), `${r.cpu}%`, mb(r.rss)]))}` : 'No run is going.',
      ...(m.runs.length ? [`Top ${m.cpu.length} by CPU\n${procs(m.cpu)}`, `Top ${m.memory.length} by memory\n${procs(m.memory)}`,
        "* the sandbox's own, its bwrap, Pi or its socket: rf interrupt PATH stops the run; rf kill PID ends any other, with all it started"] : []),
    ].join('\n\n');
  }
});
else if (cmd === 'kill' && args.length === 1 && /^\d+$/.test(args[0])) {
  if (flags.start !== undefined && !/^\d+$/.test(String(flags.start))) throw new Error('--start: a whole number, as rf top --json shows a process');
  const k = await (await post('/monitor/kill', { pid: Number(args[0]), ...(flags.start !== undefined && { start: Number(flags.start) }) })).json();
  const more = k.pids.length - 1;
  console.log(`killed ${args[0]} (${k.script})${more ? ` and the ${more} it started` : ''}, of ${k.path} run ${k.run}, with ${k.signal}; its agent hears of it`);
} else if (cmd === 'costs' && args.length <= 1) {
  const keyText = (k: any) => `OpenRouter key (${k.day} UTC): ${k.usage_daily !== null ? `${usd(k.usage_daily)} today vs ${usdNote(k.server_total, k.server_estimated)} recorded (${signedUsd(k.unattributed)} unattributed) · ` : ''}${usd(k.usage)} used${k.limit !== null ? ` · ${usd(k.remaining)} of ${usd(k.limit)} remaining${k.reset ? ` (${k.reset})` : ''}` : ', no limit'}`;
  // A run that was cut is carried on by the next, so it adds its cost, not a run.
  const at = (args[0] ?? '').replace(/\/+$/, ''), counted = (r: { outcome: string }) => r.outcome === 'cut' ? 0 : 1;
  const report = await get(`/api/costs?since=${since}&tz=${encodeURIComponent(localTz)}`);
  if (flags.daily) {
    const scoped = !at ? report : {
      days: report.days.flatMap((d: any) => {
        const runs = at === 'server' ? [] : d.runs.filter((r: any) => r.path === at || r.path.startsWith(at + '/'));
        const server = at === 'server' && d.server?.items.length ? d.server : undefined;
        if (!runs.length && !server) return [];
        const by_workspace: Record<string, { runs: number; cost: number; estimated?: true }> = Object.create(null);
        const by_person: Record<string, { runs: number; cost: number; estimated?: true }> = Object.create(null);
        let runCost = 0, runs_count = 0, est = !!server?.estimated;
        for (const r of runs) {
          const c = counted(r);
          runCost += r.cost; runs_count += c; est ||= !!r.estimated;
          const w = by_workspace[r.workspace] ??= { runs: 0, cost: 0 };
          w.runs += c; w.cost = +(w.cost + r.cost).toFixed(6); if (r.estimated) w.estimated = true;
          const p = by_person[r.person] ??= { runs: 0, cost: 0 };
          p.runs += c; p.cost = +(p.cost + r.cost).toFixed(6); if (r.estimated) p.estimated = true;
        }
        return [{ day: d.day, cost: +(runCost + (server?.cost ?? 0)).toFixed(6), runs_count, ...(est && { estimated: true }), by_workspace, by_person, runs, ...(server && { server }) }];
      }),
    };
    if (flags.json) console.log(JSON.stringify(scoped, null, 1));
    else {
      if (scoped.key) console.log(keyText(scoped.key));
      for (const d of scoped.days) {
        console.log(`${d.day}  ${usdNote(d.cost, d.estimated)}  ${d.runs_count} runs${d.server?.cost ? `  server ${usdNote(d.server.cost, d.server.estimated)}` : ''}`);
        for (const [w, v] of Object.entries<any>(d.by_workspace)) console.log(`  workspace  ${usdNote(v.cost, v.estimated).padStart(10)}  ${v.runs} runs  ${w}`);
        for (const [p, v] of Object.entries<any>(d.by_person)) console.log(`  person     ${usdNote(v.cost, v.estimated).padStart(10)}  ${v.runs} runs  ${p}`);
        for (const r of d.runs) console.log(`  run        ${usdNote(r.cost, r.estimated).padStart(10)}  ${r.path}  run ${r.run}  ${r.person}  ${r.outcome}`);
        for (const s of d.server?.items ?? []) console.log(`  server     ${usdNote(s.cost, s.estimated).padStart(10)}  ${s.kind}${s.site ? `: ${s.site}` : ''} (${s.person})  ${s.calls} calls`);
      }
      if (!scoped.days.length && !scoped.key) console.log('No costs recorded.');
    }
  } else {
    const by = String(flags.by ?? 'series'), key = {
      workspace: (r: any) => r.workspace, series: (r: any) => r.series, person: (r: any) => r.person, day: (r: any) => r.day,
      outcome: (r: any) => r.failure ? `failed, ${r.failure}` : r.outcome,
    }[by];
    if (!key) throw new Error('--by: workspace, series, person, day or outcome');
    const sums = new Map<string, { runs: number; cost: number; estimated: boolean }>();
    const add = (k: string, runs: number, cost: number, est: boolean) => {
      const prev = sums.get(k) ?? { runs: 0, cost: 0, estimated: false };
      sums.set(k, { runs: prev.runs + runs, cost: prev.cost + cost, estimated: prev.estimated || est });
    };
    let totalCost = 0, totalRuns = 0, totalEst = false;
    for (const d of report.days) {
      if (at !== 'server') for (const r of d.runs) {
        if (at && r.path !== at && !r.path.startsWith(at + '/')) continue;
        const c = counted(r);
        add(key({ ...r, day: d.day }), c, r.cost, !!r.estimated);
        totalCost += r.cost; totalRuns += c; totalEst ||= !!r.estimated;
      }
      if ((!at || at === 'server') && d.server) for (const s of d.server.items) {
        const sk = by === 'day' ? d.day : by === 'series' ? (s.site ? `server/${s.kind}/${s.site}` : `server/${s.kind}`) : by === 'person' ? `server (${s.person})` : 'server';
        add(sk, 0, s.cost, !!s.estimated);
        totalCost += s.cost; totalEst ||= !!s.estimated;
      }
    }
    const out = [...sums].map(([k, v]) => ({ [by]: k, runs: v.runs, cost: +v.cost.toFixed(4), per_run: v.runs ? +(v.cost / v.runs).toFixed(4) : null, ...(v.estimated && { estimated: true }) }))
      .sort((a, b) => by === 'day' ? (a as any).day.localeCompare((b as any).day) : b.cost - a.cost);
    if (flags.json) console.log(JSON.stringify(out, null, 1));
    else {
      for (const o of out) console.log(`${usd(o.cost, o.estimated).padStart(10)}  ${String(o.runs).padStart(5)} runs  ${(o.per_run === null ? '-' : usd(o.per_run, o.estimated)).padStart(8)} a run  ${o[by]}${o.estimated ? ' (est.)' : ''}`);
      console.log(`${usd(totalCost, totalEst).padStart(10)}  ${String(totalRuns).padStart(5)} runs  in all${totalEst ? ' (partly estimated)' : ''}`);
      if (!at && report.key) console.log(keyText(report.key));
    }
  }
} else if (cmd === 'wakes' && args.length <= 1) {
  const at = (args[0] ?? '').replace(/\/+$/, ''), rows = (await get('/api')).flatMap(w => w.series.filter(s => !s.archived).flatMap(s => [
    ...(s.single ? [] : [{ path: `${w.name}/${s.name}`, fired: s.fired, wakes: s.wakes, requests: s.requests }]),
    ...s.instances.filter(i => i.wakes.length).map(i => ({ path: `${w.name}/${s.name}/${i.label}`, fired: i.fired, wakes: i.wakes, requests: [] })),
  ])).filter(r => !at || r.path === at || r.path.startsWith(at + '/'));
  if (flags.json) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) {
    console.log(`${r.path}  last woken ${r.fired ? when(r.fired) : 'never'}${r.wakes.length || r.requests.length ? '' : ', none pending'}`);
    for (const k of r.wakes) console.log(`  wake ${k.id} ${when(k.at)}${k.label ? ` starts ${k.label}` : ''}${k.days ? `, then each ${k.days.join(', ')}` : ''}, set by ${k.from}${k.text ? `: ${k.text}` : ''}${k.check ? `; check ${k.check}${k.deadline ? ` until ${k.deadline}` : ''}` : ''}`);
    for (const q of r.requests) console.log(`  request ${q.id} to ${q.target ? 'wake' : 'start'} ${q.label}, from ${q.from} since ${when(q.at)}, waits on ${q.who ?? 'anyone'}${q.text ? `: ${q.text}` : ''}`);
  }
} else if (cmd === 'activity' && args.length <= 1) {
  const at = (args[0] ?? '').replace(/\/+$/, ''), blocks = (await get(`/api/activity?since=${since}`))
    .filter(b => !at || b.path === at || b.path.startsWith(at + '/'));
  if (flags.json) console.log(JSON.stringify(blocks, null, 1));
  else for (const b of blocks) {
    console.log(b.path);
    for (const e of b.entries) console.log(`  ${when(e.at)}  ${e.op === 'done' ? `run ${e.run} failed: ${e.error}`
      : `${e.by}  ${e.op === 'comment' ? `says: ${e.text.split('\n')[0].slice(0, 200)}` : e.op === 'upload' ? `uploads ${e.file}` : `${{ close: 'closes', abandon: 'abandons', delete: 'deletes' }[e.op]} it`}`}`);
  }
} else if (cmd === 'egress' && (!args.length || (args.length === 2 && ['add', 'remove'].includes(args[0])))) {
  let hosts: string[] = await (await api('/egress')).json();
  if (args.length) hosts = await (await post('/egress', { hosts: args[0] === 'add' ? [...new Set([...hosts, args[1]])] : hosts.filter(h => h !== args[1]) }, 'PUT')).json();
  console.log(hosts.join('\n'));
} else if (cmd === 'internal' && (!args.length || (args.length === 2 && args[0] === 'remove'))) {
  const hosts: Record<string, { by: string; at: string }> = args.length ? await (await api(`/internal/${encodeURIComponent(args[1])}`, { method: 'DELETE' })).json() : await get('/internal');
  if (flags.json) console.log(JSON.stringify(hosts, null, 1));
  else {
    const w = Math.max(0, ...Object.keys(hosts).map(h => h.length));
    for (const [h, { by, at }] of Object.entries(hosts)) console.log(`${h.padEnd(w)}  ${when(at)}  ${by}`);
    if (!Object.keys(hosts).length) console.log('none: an admin lets websites reach one with rf site set NAME --internal true');
  }
} else if (cmd === 'people' && args.length <= 1) {
  // People as lines to edit and set: ROLE EMAIL for everyone, owner|member EMAIL-OR-GROUP for a workspace, each with a comment.
  const ws = args[0] === undefined ? undefined : await workspaceNamed(args[0]);
  const kinds = ws ? ['owner', 'member'] : ['admin', 'user'];
  const canon = (rows: [string, string][]) => {
    const m = new Map<string, string>();
    for (const [who, kind] of rows) if (!m.has(who) || kind === kinds[0]) m.set(who, kind);
    return m;
  };
  const last = (iso: string | null) => iso ? `last in ${when(iso)}` : 'never in', listed = await get(ws ? `/api/workspaces/${ws.id}/people` : '/users');
  const raw = ws ? listed.map(p => ({ kind: p.as, who: p.who, note: [p.who.includes('@') ? last(p.last_login) : 'a group', p.runs.length && `runs ${p.runs.join(', ')}`] }))
    : listed.map(u => ({ kind: u.role, who: u.email, note: [u.disabled && 'disabled', last(u.last_login), `in ${u.workspaces.join(', ') || 'none'}`, u.outside.length && `runs outside them: ${u.outside.join(', ')}`] }));
  const had = canon(raw.map(p => [p.who, p.kind])), seen = new Set<string>();
  const now = raw.filter(p => p.kind === had.get(p.who) && !seen.has(p.who) && !!seen.add(p.who));
  if (flags.json && typeof flags.set !== 'string') console.log(JSON.stringify(listed, null, 1));
  else if (typeof flags.set !== 'string') {
    const w = Math.max(0, ...now.map(p => p.who.length));
    for (const p of now) console.log(`${p.kind.padEnd(6)} ${p.who.padEnd(w)}  # ${p.note.filter(Boolean).join('; ')}`);
    if (!now.length) console.log('# no one is in it: only admins see it');
  } else {
    const want = readFileSync(flags.set === '-' ? 0 : flags.set, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => l.split(/\s+/));
    const bad = want.find(([kind, who, more]) => !kinds.includes(kind) || !who || more);
    if (bad) throw new Error(`each line is ${kinds.join('|')} ${ws ? 'EMAIL-OR-GROUP' : 'EMAIL'}, not: ${bad.join(' ')}`);
    const wanted = canon(want.map(([kind, who]) => [who.toLowerCase(), kind]));
    const set = [...wanted].filter(([who, kind]) => had.get(who) !== kind), gone = ws ? [...had].filter(([who]) => !wanted.has(who)) : [];
    const changes = [...set.map(([who, kind]) => had.has(who) ? `${who}: ${had.get(who)} -> ${kind}` : `+ ${kind} ${who}`), ...gone.map(([who, kind]) => `- ${kind} ${who}`)];
    console.log(changes.join('\n') || 'no changes');
    if (changes.length && !flags['dry-run']) {
      const ofKind = (kind: string) => [...wanted].filter(([, k]) => k === kind).map(([who]) => who);
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
  else for (const [c, who] of Object.entries(all)) if (!cap || c === cap) console.log(`${c}: ${who.join(', ') || (c === 'vpn' || c === 'wake-check' ? 'no one' : 'admins only')}`);
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
  const me = await get('/me');
  console.error(usage(cmd, me.can.includes('vpn'), me.role === 'admin'));
  process.exitCode = 2;
}
