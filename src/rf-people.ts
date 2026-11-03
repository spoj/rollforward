// rf for people: what the page does, from a shell or a desktop agent, as you, with a personal token made on the page (Tokens).
// Published to npm as @rfany/rf, from cli/. PATH is workspace/series/label, as `rf ls` prints it.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const USAGE = `rf login URL TOKEN
rf ls
rf pull DIR                       a read-only mirror of what you can see, in the layout agents see
rf comment PATH TEXT [--item ID] [--ref REF] [--thread T] [--wait]
rf answer PATH NOTE CHOICE        CHOICE the option's number, from 0
rf upload PATH FILE [--onto ITEM] [--output]
rf wake PATH AT REASON [--label LABEL]   AT now, +<n>m|h|d or a date; PATH an open instance, or a series with LABEL
rf guidance [WORKSPACE] [--set FILE|-]   the company's, or a workspace's; setting the company's is for admins
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

const config = join(homedir(), '.config', 'rollforward.json');
const [cmd, ...argv] = process.argv.slice(2);
const flags: Record<string, string | true> = {}, args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i].match(/^--(.+)$/)?.[1];
  if (!flag) args.push(argv[i]);
  else flags[flag] = flag === 'wait' || flag === 'output' ? true : argv[++i];
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

function write(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, data);
  chmodSync(path, 0o444);
}

// A path the server named, under `base`, or undefined: on Windows a file's name may hold \ and lead out of it.
const under = (base: string, rel: string) => resolve(base, rel).startsWith(resolve(base) + sep) ? resolve(base, rel) : undefined;

// Pulls what changed since the last pull, by each instance's files' sizes and times, and removes what moved or went. A file that fails
// is said and fetched again next time.
async function pull(dir: string) {
  const manifest = join(dir, '.rf-pull.json'), had = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
  const now: Record<string, { path: string; files: Record<string, string> }> = {}, tree = await get('/api');
  write(join(dir, 'GUIDANCE.md'), (await get('/guidance')).text);
  for (const w of tree) {
    write(join(dir, w.name, 'GUIDANCE.md'), w.guidance);
    for (const s of w.series) for (const i of s.instances) now[i.id] = { path: join(w.name, s.name, i.label), files: {} };
  }
  for (const [id, old] of Object.entries<{ path: string }>(had)) if (now[id]?.path !== old.path) rmSync(join(dir, old.path), { recursive: true, force: true });
  let fetched = 0;
  for (const [id, mine] of Object.entries(now)) {
    const at = `/api/instances/${id}`, d = await get(at), was = had[id]?.path === mine.path ? had[id].files : {};
    write(join(dir, mine.path, 'screen.json'), JSON.stringify(d.doc, null, 1));
    write(join(dir, mine.path, 'log.jsonl'), d.log.map(e => JSON.stringify(e)).join('\n') + '\n');
    write(join(dir, mine.path, 'trace.json'), JSON.stringify(await get(`${at}/trace`), null, 1));
    for (const f of await get(`${at}/files`)) {
      const path = under(join(dir, mine.path), f.path);
      if (!path) {
        console.error(`skipped ${mine.path}/${f.path}: it leads out of its folder`);
        continue;
      }
      mine.files[f.path] = `${f.size} ${f.mtime}`;
      if (was[f.path] === mine.files[f.path]) continue;
      try {
        write(path, new Uint8Array(await (await api(`/files/${id}/${f.path.split('/').map(encodeURIComponent).join('/')}`)).arrayBuffer()));
        fetched++;
      } catch (e) {
        mine.files[f.path] = '';
        console.error(`${mine.path}/${f.path}: ${(e as Error).message}`);
      }
    }
    for (const gone of Object.keys(was).filter(p => !(p in mine.files))) {
      const path = under(join(dir, mine.path), gone);
      if (path) rmSync(path, { force: true });
    }
  }
  writeFileSync(manifest, JSON.stringify(now));
  console.log(`${Object.keys(now).length} instances, ${fetched} files fetched, into ${dir}`);
}

if (cmd === 'login' && url && token) {
  const me = await get('/me');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ url, token }), { mode: 0o600 });
  console.log(`signed in as ${me.email}`);
} else if (cmd === 'ls') {
  for (const w of await get('/api')) for (const s of w.series) {
    console.log(`${w.name}/${s.name}${s.wake ? `  wakes ${s.wake.at} to start ${s.wake.label}: ${s.wake.reason}` : ''}${s.requests.length ? `  ${s.requests.length} asking to start` : ''}`);
    for (const i of s.instances) console.log(`${w.name}/${s.name}/${i.label}  ${i.status}${i.running ? ', running' : ''}${i.questions.length ? `, ${i.questions.length} questions` : ''}${i.wake ? `, wakes ${i.wake}` : ''}, runner ${i.runner}`);
  }
} else if (cmd === 'pull' && args[0]) await pull(args[0]);
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
    for (const e of log.filter(e => e.seq > from && e.seq < done.seq && ((e.op === 'comment' && e.by === 'agent') || e.op === 'report'))) console.log(`${e.op === 'comment' ? `In thread ${e.thread}` : 'Report'}:\n${e.text}\n`);
    if (done.error) console.log(`The run failed: ${done.error}`);
    break;
  }
} else if (cmd === 'answer' && args.length === 3) {
  await post(`${(await find(args[0])).at}/answer`, { note: args[1], choice: Number(args[2]) });
  console.log('answered');
} else if (cmd === 'upload' && args.length === 2) {
  const q = new URLSearchParams({ name: basename(args[1]), pane: flags.output ? 'out' : 'in', ...(typeof flags.onto === 'string' && { onto: flags.onto }) });
  await api(`${(await find(args[0])).at}/upload?${q}`, { method: 'POST', body: readFileSync(args[1]) });
  console.log('uploaded');
} else if (cmd === 'wake' && args.length >= 3) {
  const { series, inst } = await find(args[0]);
  const at = args[1] === 'now' ? Date.now() : args[1].startsWith('+') ? Date.now() + Number(args[1].slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[args[1].at(-1)!]! : Date.parse(args[1]);
  const w = await (await post(`/api/wakes/${inst?.id ?? series.id}`, { at: new Date(at).toISOString(), reason: args.slice(2).join(' '), label: flags.label }, 'PUT')).json();
  console.log(`wakes at ${w.at}`);
} else if (cmd === 'guidance' && args.length <= 1) {
  const ws = args[0] === undefined ? undefined : (await get('/api')).find(w => w.name === args[0]);
  if (args[0] !== undefined && !ws) throw new Error(`no workspace ${args[0]}`);
  if (typeof flags.set !== 'string') console.log(ws ? ws.guidance : (await get('/guidance')).text);
  else {
    const text = readFileSync(flags.set === '-' ? 0 : flags.set, 'utf8');
    await (ws ? post(`/api/workspaces/${ws.id}`, { guidance: text }, 'PUT') : api('/guidance', { method: 'PUT', body: text }));
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
