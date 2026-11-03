// rf for people: what the page does, from a shell or a desktop agent, as you, with a personal token made on the page (Tokens).
// Published to npm as @rfany/rf, from cli/. PATH is workspace/series/label, as `rf ls` prints it.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const USAGE = `rf login URL TOKEN
rf ls
rf pull PATH DIR [--delete] [-n|--dry-run] [--exclude PATTERN]...
                                  PATH's files into DIR as rsync copies them, whole, if their size or time differ: PATH/ fills DIR,
                                  PATH makes DIR/<its name>, / is all you see; --delete removes what the server no longer has
rf help                           how rollforward works and how to use rf, for an agent
rf comment PATH TEXT [--item ID] [--ref REF] [--thread T] [--wait]   a new thread, or a reply in T, as to an agent's ask
rf upload PATH FILE [--onto ITEM] [--output]
rf wake PATH AT REASON [--label LABEL]   AT now, +<n>m|h|d or a date; PATH an open instance, or a series with LABEL
rf agents [WORKSPACE] [--set FILE|-]     the company's AGENTS.md, or a workspace's; setting the company's is for admins
rf skills
rf websites

Publishers and admins:
rf skill push DIR                 DIR/SKILL.md and the rest become the newest version of the skill named DIR's name, live at once
rf skill versions ID
rf skill rollback ID N            pushes version N again, as the newest

Admins:
rf users
rf user add EMAIL [admin|publisher] | role EMAIL admin|publisher|user | disable EMAIL | enable EMAIL | signout EMAIL | remove EMAIL
rf website set ID URL [--name NAME] [--hosts HOST,...]   a website people sign in to at URL, and the other hosts its pages need,
                                  such as sso.example.com or *.example.com; a run's browser on it reaches only those
rf website remove ID`;

const GUIDE = `rollforward runs a team's recurring work, such as a weekly borrowing base or a month-end reconciliation, with an agent
that does each period's work and people who check it. rf does what its page does, as you.

What there is
- A workspace holds series, and its people. A series is one recurring job; an instance is one period of it, labelled such as
  2026-08-23. PATH is workspace/series/label, as rf ls prints it; for rf pull it may go deeper, into an instance's files.
- An instance's screen is its items: inputs, steps and outputs, each pointing at a file, with what it's made from. People upload
  files and comment; each comment or upload starts a run of the agent, which reads it and carries on. The runner is the person whose
  logins the runs use, and who closes the instance once they stand by it.
- A comment starts a thread, on the instance or on an item, at a cell such as Base!C25, and others reply in it. An ask is the
  agent's comment that waits on someone, the one it names or else the runner, until they reply or resolve it. rf ls says how many
  asks wait in each instance.

What rf pull copies, the folders as the agent sees them
  AGENTS.md                  the company's conventions; <workspace>/AGENTS.md the workspace's
  <workspace>/<series>/<label>/
    workspace.json           the screen: {rev, status, items: [{id, name, kind, file, from, headline, source}]}
    log.jsonl                every event, by seq: by is a person's email, "server" or "agent"; op is upload, comment (thread, item,
                             ref, text, ask, to), resolve, point and item (the screen changing), run, report (the agent's account of
                             a run), done (its cost, summary or error), close, and the rest
    upload/                  what people uploaded, their comments' attachments in upload/attachments/
    working/                 what the agent made, its scripts, and process.md, how it does this series
    session/                 the agent's own session: every message and tool call of every run
    browser/                 each run's browser requests, and its screenshots
The copy is read-only, and only rf changes what's on the server: comment, upload and wake.

Usual work
- What waits on me: rf ls, then the asks in that instance's log.jsonl, ask true, whose thread has nothing after them.
- Answer an ask: rf comment PATH TEXT --thread T --wait, which prints what the agent says back.
- Give an input or a corrected output: rf upload PATH FILE [--onto ITEM] [--output].
- Start an instance: rf wake SERIES now REASON --label LABEL; take one up later: rf wake PATH +2h REASON.
- Read what a run did: rf pull PATH/ DIR, then its report and done entries in log.jsonl, the files in working/, and session/ for
  every step.`;

const config = join(homedir(), '.config', 'rollforward.json');
const [cmd, ...argv] = process.argv.slice(2);
const flags: Record<string, string | true> = {}, excludes: string[] = [], args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] === '-n' ? 'dry-run' : argv[i].match(/^--(.+)$/)?.[1];
  if (!flag) args.push(argv[i]);
  else if (flag === 'exclude') excludes.push(argv[++i]);
  else flags[flag] = ['wait', 'output', 'delete', 'dry-run'].includes(flag) ? true : argv[++i];
}
if (cmd === 'help') {
  console.log(GUIDE);
  process.exit();
}
if (cmd !== 'login' && !existsSync(config)) {
  console.error(`Sign in first, with a token made on the page under Tokens: rf login URL TOKEN\n\n${USAGE}`);
  process.exit(2);
}
const { url, token } = cmd === 'login' ? { url: args[0], token: args[1] } : JSON.parse(readFileSync(config, 'utf8'));

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

function write(path: string, data: string | Uint8Array, mtime: string) {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, data);
  utimesSync(path, new Date(mtime), new Date(mtime));
  chmodSync(path, 0o444);
}

// A path the server named, under `base`, or undefined: on Windows a file's name may hold \ and lead out of it.
const under = (base: string, rel: string) => resolve(base, rel).startsWith(resolve(base) + sep) ? resolve(base, rel) : undefined;

// rsync's --exclude, simply: a pattern without / matches any one name on the path, one with / the path from the pull's top; * and ?
// stop at /, ** doesn't. A folder it matches takes what's in it along.
const globs = excludes.map(p => [p.replace(/^\/|\/$/g, '').includes('/'), new RegExp(`^${p.replace(/^\/|\/$/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`)] as const);
const excluded = (rel: string) => globs.some(([whole, re]) => rel.split('/').some((name, k, all) => re.test(whole ? all.slice(0, k + 1).join('/') : name)));

// Copies PATH's files into DIR as rsync does, from the server only and whole: a file whose size or time differ from the server's is
// fetched, and given the server's time, so the next pull compares against it. Nothing is kept besides the files.
async function pull(path: string, dir: string) {
  const at = path.replace(/^\/+/, ''), from = at.replace(/\/+$/, ''), dry = !!flags['dry-run'];
  const list: { path: string; size: number; mtime: string; url?: string; text?: string }[] = await get(`/api/files?path=${encodeURIComponent(from)}`);
  if (!list.length) throw new Error(`nothing you can see at ${path}`);
  const into = !from || at.endsWith('/') ? resolve(dir) : join(resolve(dir), basename(from)), rel = (f: { path: string }) => f.path.slice(from ? from.length + 1 : 0);
  let fetched = 0, same = 0, deleted = 0, failed = 0;
  for (const f of list.filter(f => !excluded(rel(f)))) {
    const local = rel(f) ? under(into, rel(f)) : into, st = local && existsSync(local) ? statSync(local) : undefined;
    if (!local) {
      console.error(`skipped ${f.path}: it leads out of ${into}`);
      continue;
    }
    if (st && st.size === f.size && Math.floor(st.mtimeMs / 1000) === Math.floor(Date.parse(f.mtime) / 1000)) {
      same++;
      continue;
    }
    console.log(`${st ? 'changed' : 'new'}  ${f.path}`);
    try {
      if (!dry) write(local, f.text ?? new Uint8Array(await (await api(f.url!)).arrayBuffer()), f.mtime);
      fetched++;
    } catch (e) {
      failed++;
      console.error(`${f.path}: ${(e as Error).message}`);
    }
  }
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
  console.log(`${dry ? 'would fetch' : 'fetched'} ${fetched}, ${same} up to date${flags.delete ? `, ${dry ? 'would delete' : 'deleted'} ${deleted}` : ''}${failed ? `, ${failed} failed` : ''}, in ${into}`);
  if (failed) process.exitCode = 1;
}

if (cmd === 'login' && url && token) {
  const me = await get('/me');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ url, token }), { mode: 0o600 });
  console.log(`signed in as ${me.email}`);
} else if (cmd === 'ls') {
  for (const w of await get('/api')) for (const s of w.series) {
    console.log(`${w.name}/${s.name}${s.wake ? `  wakes ${s.wake.at} to start ${s.wake.label}: ${s.wake.reason}` : ''}${s.requests.length ? `  ${s.requests.length} asking to start` : ''}`);
    for (const i of s.instances) console.log(`${w.name}/${s.name}/${i.label}  ${i.status}${i.running ? ', running' : ''}${i.asks.length ? `, ${i.asks.length} asks waiting` : ''}${i.wake ? `, wakes ${i.wake}` : ''}, runner ${i.runner}`);
  }
} else if (cmd === 'pull' && args.length === 2) await pull(args[0], args[1]);
else if (cmd === 'comment' && args.length === 2) {
  const { at } = await find(args[0]);
  await post(`${at}/comment`, { text: args[1], item: flags.item, ref: flags.ref, thread: flags.thread });
  const seq = (await get(at)).log.at(-1).seq;
  if (!flags.wait) console.log(`commented, seq ${seq}`);
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
} else if (cmd === 'wake' && args.length >= 3) {
  const { series, inst } = await find(args[0]);
  const at = args[1] === 'now' ? Date.now() : args[1].startsWith('+') ? Date.now() + Number(args[1].slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[args[1].at(-1)!]! : Date.parse(args[1]);
  const w = await (await post(`/api/wakes/${inst?.id ?? series.id}`, { at: new Date(at).toISOString(), reason: args.slice(2).join(' '), label: flags.label }, 'PUT')).json();
  console.log(`wakes at ${w.at}`);
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
} else if (cmd === 'skill' && args[0] === 'versions' && args[1]) {
  for (const v of await get(`/skills/${encodeURIComponent(args[1])}/versions`)) console.log(`${v.version}  ${v.at}  ${v.by}`);
} else if (cmd === 'skill' && args[0] === 'rollback' && args.length === 3) {
  console.log(await (await post(`/skills/${encodeURIComponent(args[1])}/versions`, { from: Number(args[2]) })).text());
} else if (cmd === 'skills') {
  for (const s of await get('/skills')) console.log(`${s.id}  v${s.pushed.version} by ${s.pushed.by} ${s.pushed.at}  ${s.description}`);
} else if (cmd === 'websites') {
  for (const w of await get('/websites')) console.log(`${w.id}  ${w.url}  ${w.hosts.join(' ') || '-'}  ${w.name}`);
} else if (cmd === 'website' && args[0] === 'set' && args.length === 3) {
  await post(`/websites/${encodeURIComponent(args[1])}`, { url: args[2], name: flags.name, hosts: typeof flags.hosts === 'string' ? flags.hosts.split(',') : [] }, 'PUT');
  console.log('saved');
} else if (cmd === 'website' && args[0] === 'remove' && args[1]) {
  await api(`/websites/${encodeURIComponent(args[1])}`, { method: 'DELETE' });
  console.log('removed');
} else if (cmd === 'users') {
  for (const u of await get('/users')) console.log([u.email, u.role, u.disabled ? 'disabled' : '', u.last_login ? `last in ${u.last_login}` : 'never in', u.workspaces.join(', ')].filter(Boolean).join('\t'));
} else if (cmd === 'user' && args.length >= 2) {
  const [what, email, role] = args, at = `/users/${encodeURIComponent(email)}`;
  if (what === 'add') await post('/users', { email, role: role ?? 'user' });
  else if (what === 'role' && role) await post(at, { role }, 'PUT');
  else if (what === 'disable' || what === 'enable') await post(at, { disabled: what === 'disable' }, 'PUT');
  else if (what === 'signout') await post(at, { signout: true }, 'PUT');
  else if (what === 'remove') await api(at, { method: 'DELETE' });
  else throw new Error(USAGE);
  console.log('done');
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
