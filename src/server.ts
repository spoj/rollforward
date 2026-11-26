import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { accessSync, closeSync, constants, cpSync, createReadStream, createWriteStream, existsSync, fstatSync, futimesSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, type Dirent, type ReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsFile, closedBefore, createInstance, keep, renameInstance, replaceReadOnly, HttpError, instance, instanceDir, instances, instancesBySeries, labels, newId, openFile, openStore, readFile, folderName, seriesDir, type Entry, type Instance } from './store.ts';
import { AGENT, commit, committed, refused } from './git.ts';
import { serveSandboxes, userland } from './sandbox.ts';
import { agentRoot, id as agentId } from './agent.ts';
import { checkTheme, stylesheet, themeLogo } from './theme.ts';
import { checkAuthorityFormat } from './authority-format.ts';
import { asPerson, authenticate, CAPS, can, capabilities, checkConfig, cli, connect, myTokens, newToken, recheckRequest, redirectPath, removeUser, revokeToken, ROLES, session, signOutEverywhere, ungranted, upsertUser, users, type Me, type Role, type User } from './auth.ts';
import { act, canManage, canSee, changes, everyone, initSystem, isPeople, readJson, replaceFile, saveTree, see, seen, tree, writeJson, type Tree, type Workspace } from './system.ts';
import { checkTicks, logins, runnerAt, ownerOf, saveLogin, signOut, unoffer } from './logins.ts';
import { agentCall } from './agent-api.ts';
import { checkLogins } from './entra.ts';
import { answered as callsAnswered, byLogin, call, connections, intercepts, keyStatus, openrouterCreditError, refreshKeys, letIn, loginOf, removeConnection, setConnection, setLetIn, upstreams } from './connections.ts';
import { syncCosts } from './costs.ts';
import { addSite, allowHost, Browsers, categories, endSignIn, endSignIns, endUnpermittedSignIns, enrolFlagged, isSignIn, isCheckingWebsite, drainWebsiteChecks, keepAlive, passAllowed, passUpgrade, profiles, reap, removeHost, removeSite, revokeInternalHosts, risks, setSite, startSignIn, unreached, viewPage, websitesOf } from './browsers.ts';
import { addVpn, cancelVpnSignIn, disconnectVpn, dropUnpermittedVpns, isVpnSignIn, reapVpns, removeVpn, saveVpnSignIn, startVpnSignIn, vpns } from './vpns.ts';
import { ask, decide, forgetGrants, forgetWorkspace, lapse, pruneGrants, revoke, visible } from './grants.ts';
import { offer } from './connections/graph.ts';
import { addWarehouse } from './connections/databricks.ts';
import { forget, indexes, prune, startIndexing, track } from './indexes.ts';
import { find, killTree, sample, startOf, type Monitor, type Sandbox } from './monitor.ts';
import { saveSeriesSettings, seriesSettings, type SeriesSettings } from './series.ts';
import { openSkills, pushed, pushSkill, skills, versionFiles, versionsOf } from './skills.ts';
import { commentAt, currentMessage, isPerson, notices, openNotes, post, waitsOn, type ScopedNote } from './messages.ts';
import { appendMessage } from './message-store.ts';
import { active, archived, byToken, cancelPendingOom, cancelWake, cancelWakes, correct, drain, drained, dropRequest, held, interruptRun, kick, named, noted, queued, remove, retireSeries, resolveFor, seriesWakeChecks, setWake, standing, startWaking, startWith, stop, updating, wakes, wakesByTarget, seriesConversation, wakeWith, weekly, wakeCheckStatus, wakeCheckView, reads, CUT, type Active, type Request } from './waker.ts';

const root = resolve(process.argv[2]);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(app, 'web', 'index.html');
checkTheme();
// The release this checkout is at, as git describes it; an image built without .git has none.
const version = existsSync(join(app, '.git')) ? execFileSync('git', ['describe', '--tags', '--always'], { cwd: app, encoding: 'utf8' }).trim() : null;
const exec = promisify(execFile);
const port = Number(process.argv[3] ?? 8780);
const verifyOnly = process.argv[4] === '--verify-only';
if (process.argv[4] !== undefined && (!verifyOnly || process.argv.length !== 5)) throw new Error('usage: node src/server.ts DATA_ROOT PORT [--verify-only]');
const host = verifyOnly ? '127.0.0.1' : process.env.RF_HOST ?? '127.0.0.1';
const tmpDir = join(root, '.tmp'), previews = join(root, '.previews');
if (!existsSync(join(agentRoot, 'usr'))) throw new Error(`no agent image at ${agentRoot}: node scripts/agent.ts unpacks agent-${agentId}, which this checkout runs`);
checkAuthorityFormat(root);
initSystem(root);
openStore(root, verifyOnly ? undefined : () => {
  // Back up .rf/ after canonical validation but before repairs, keeping the newest five without disposable caches.
  const backups = join(root, '.rf-backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  cpSync(join(root, '.rf'), join(backups, new Date().toISOString().replace(/[:.]/g, '-')), { recursive: true, filter: p => !['index', 'runs'].includes(basename(p)) });
  for (const old of readdirSync(backups).sort().slice(0, -5)) rmSync(join(backups, old), { recursive: true });
});
const authorityKey = (epoch: number, workspace: string) => `${epoch}:${workspace}`;
const authorityBoundaries = new Map(Object.entries(tree().series).map(([sid, s]) => [sid, authorityKey(seriesSettings(seriesDir(sid)).epoch, s.workspace)]));
changes.on('change', (id: string, actor?: string) => {
  if (id !== 'tree') return;
  const t = tree();
  for (const [sid, s] of Object.entries(t.series)) {
    const settings = seriesSettings(seriesDir(sid)), next = authorityKey(settings.epoch, s.workspace), previous = authorityBoundaries.get(sid);
    authorityBoundaries.set(sid, next);
    if (previous !== undefined && previous !== next) for (const i of instances(sid)) if (i.doc.status === 'open')
      i.append(actor ?? 'server', 'authority', { owner: settings.owner, epoch: settings.epoch, workspace: s.workspace });
  }
});
// A new data root starts with one connection, Microsoft 365's, graph.
if (!verifyOnly && !existsSync(join(root, '.rf', 'connections.json'))) writeJson('connections.json', { graph: { type: 'graph', updated_by: 'server', updated_at: new Date().toISOString() } });

// A file's sha256, kept by its inode, size and nanosecond change times once a second old, as each view of an instance compares its
// files again; streamed, as a run may leave a file of any size.
const sums = new Map<string, [string, string]>();
async function sha256(dir: string, file: string): Promise<string | undefined> {
  const fd = openFile(dir, file);
  if (fd === undefined) return undefined;
  const st = fstatSync(fd, { bigint: true }), key = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  const fresh = st.ctimeNs > BigInt(Date.now() - 1000) * 1_000_000n, hit = sums.get(join(dir, file));
  if (hit?.[0] === key) {
    closeSync(fd);
    return hit[1];
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream('', { fd })) hash.update(chunk);
  const sum = hash.digest('hex');
  if (!fresh) sums.set(join(dir, file), [key, sum]);
  return sum;
}

// The series' latest closed instance before this one, by label, and whether each of this one's files is new since it, changed or
// the same, by content, as its item of the same id had it.
async function previous(inst: Instance) {
  const prev = closedBefore(inst).at(-1);
  if (!prev) return null;
  return { label: prev.label, changed: Object.fromEntries(await Promise.all(inst.doc.items.filter(i => i.file).map(async i => {
    const was = prev.doc.items.find(p => p.id === i.id)?.file, now = was && await sha256(inst.dir, i.file!);
    return [i.id, !was ? 'new' : now && now === await sha256(prev.dir, was) ? 'same' : 'changed'];
  }))) };
}

// A free name among a workspace's series: the name, else the name 2, 3 and on.
function freeName(t: Tree, ws: string, name: string): string {
  const taken = new Set(Object.values(t.series).filter(s => s.workspace === ws).map(s => s.name));
  const fit = (suffix: string) => {
    let s = '';
    for (const c of name) if (Buffer.byteLength(s + c + suffix) <= 200) s += c; else break;
    return s + suffix;
  };
  let n = fit('');
  for (let k = 2; taken.has(n); k++) n = fit(` ${k}`);
  return n;
}

checkConfig();
if (!verifyOnly) {
  const retirementOps = new Set(['call', 'done', 'commit', 'browser', 'browsers', 'shot', 'egress', 'expired']);
  for (const [sid, s] of Object.entries(tree().series)) {
    const settings = seriesSettings(seriesDir(sid));
    for (const i of instances(sid)) if (i.doc.status === 'open') {
      const last = i.log.findLast(e => e.op === 'authority');
      if (!last || last.epoch !== settings.epoch || last.workspace === s.workspace) continue;
      const priorRuns = new Set(i.log.filter(e => e.seq < last.seq && e.op === 'run').map(e => e.run));
      const tail = i.log.filter(e => e.seq > last.seq);
      const safeTail = tail.every((e, idx) =>
        (e.op === 'move' && idx === tail.length - 1)
        || (retirementOps.has(e.op) && typeof e.run === 'number' && priorRuns.has(e.run))
      );
      if (last.owner === settings.owner && safeTail)
        i.append('server', 'authority', { owner: settings.owner, epoch: settings.epoch, workspace: s.workspace });
      else
        console.error(`skipped authority workspace heal for ${sid}/${i.id}: owner mismatch or later entries after seq ${last.seq}`);
    }
  }
  openSkills(root);
  for (const dir of [tmpDir, previews]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
}

// A request's body, JSON or a screen, of 10 MB at most, refused as it comes past that.
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((size += c.length) > 10 * 2 ** 20) throw new HttpError(413, 'a request body holds 10 MB at most');
    chunks.push(c);
  }
  recheckRequest(req);
  return Buffer.concat(chunks);
}

// An upload, an attachment or a note's file, as it streams to disk, refused as it comes past RF_MAX_UPLOAD_MB.
const maxUpload = Number(process.env.RF_MAX_UPLOAD_MB ?? 2048);
async function* capped(chunks: AsyncIterable<Buffer>) {
  let size = 0;
  for await (const c of chunks) {
    if ((size += c.length) > maxUpload * 2 ** 20) throw new HttpError(413, `an upload holds ${maxUpload} MB at most`);
    yield c;
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
}

async function sendStream(stream: ReadStream, res: ServerResponse) {
  if (res.destroyed) return void stream.destroy();
  try {
    await pipeline(stream, res);
  } catch (e) {
    stream.destroy();
    if (!['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_UNABLE_TO_PIPE', 'ECONNRESET', 'EPIPE'].includes((e as NodeJS.ErrnoException).code!)) throw e;
  }
}

// A run, on its sandbox's socket, by its token: on /api a caller like any person, with the few rights api() gives a run; on /agent
// what only a run has, its series' skills and its runner's logins and browsers.
type Caller = Me & { run?: Active };
// A run by its token, until its stop is asked for: nothing it sends from then on counts, however long it takes to end.
const running = (token: string) => { const a = byToken.get(token); return a?.stopped ? undefined : a; };
async function agent(req: IncomingMessage, res: ServerResponse, url: URL) {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? '', a = running(token);
  if (!a) {
    const check = wakeCheckView(token);
    if (!check) throw new HttpError(401, 'no run for this token');
    if (req.method === 'GET' && ((check.inst && url.pathname === `/api/instances/${check.inst.id}/screen`) || (!check.inst && url.pathname === '/api/check/screen')))
      return send(res, 200, check.inst ? check.inst.doc : { rev: 1, status: 'open', items: [], ...(check.label && { label: check.label }) });
    if (req.method === 'GET' && url.pathname === '/api/resolve') {
      const id = resolveFor(check, url.searchParams.get('path') ?? '');
      if (!tree().series[id]) {
        const targetInst = instance(id);
        if (targetInst.hole) throw new HttpError(404, `${targetInst.label} was deleted`);
      }
      return send(res, 200, { id, kind: tree().series[id] ? 'series' : 'instance' });
    }
    throw new HttpError(403, 'a wake check is read-only');
  }
  if (url.pathname.startsWith('/api/')) return api({ email: 'agent', name: 'Agent', role: 'user', groups: [], run: a }, req, res, url);
  // Browsers and deliveries: rf expired, rf delivered (see agent-api.ts).
  const r = await agentCall(a, url.pathname, req.method ?? 'GET', async () => {
    const bytes = await body(req);
    if (running(a.token) !== a) throw new HttpError(409, 'its run has ended');
    return bytes;
  });
  if (r) return send(res, r.status, r.data);
  throw new HttpError(404, 'not found');
}

function mustSee(me: Me, w: Workspace | undefined): Workspace {
  if (!w || !canSee(me, w)) throw new HttpError(404, 'no such workspace');
  return w;
}

function mustKeepNotes(sid: string, s = tree().series[sid]) {
  if (s.single && instances(sid).some(i => i.doc.status === 'deleted')) throw new HttpError(409, `${s.name} was deleted`);
}

function mustUnarchived(by: string, sid: string, effective: Me, isRun = false) {
  const now = tree(), s = now.series[sid], ws = now.workspaces[s.workspace], shut = [ws, s].find(x => x?.archived);
  const fresh = isRun && effective ? effective : asPerson(by);
  const who = fresh ? (effective && !isRun ? { ...fresh, groups: fresh.groups.filter(g => effective.groups.includes(g)) } : fresh) : null;
  if (!who) throw new HttpError(401, 'sign in');
  if (!isRun) mustSee(who, ws);
  if (shut) throw new HttpError(409, `${shut.name} is archived: nothing in it changes until it's restored`);
  return { ws, who };
}

// What going runs are no longer lent goes: their browsers, and their copies of indexes.
async function closeUnlent() {
  const t = tree(), retiring: Promise<void>[] = [];
  for (const [sid, s] of Object.entries(t.series)) {
    const settings = seriesSettings(seriesDir(sid)), p = settings.owner && asPerson(settings.owner);
    if (!settings.consent) retiring.push(retireSeries(sid));
    else if (!p || !canSee(p, t.workspaces[s.workspace])) {
      const { consent, ...rest } = settings;
      retiring.push(changeAuthority(sid, { ...rest, epoch: settings.epoch + 1, since: new Date().toISOString() }));
    }
  }
  for (const a of active.values()) prune(a.inst, a.n, a.token);
  await Promise.all([...retiring, ...[...active.values()].map(a => a.browsers?.closeUnlent())]);
}

// A run's browser on a website, for whoever sees its instance to watch, if they may use the website: the run's browsers, and its
// session on the browser service.
function watched(me: Me, id: string, site: string): { browsers: Browsers; id: string } {
  const t = tree(), inst = instance(id), a = active.get(inst.seriesId);
  mustSee(me, t.workspaces[t.series[inst.seriesId].workspace]);
  const b = a?.inst === inst ? a.browsers?.watchable().get(site) : undefined;
  if (!b) throw new HttpError(404, `no browser of a run on ${site} for you to watch`);
  return { browsers: a!.browsers!, id: b };
}

function waits(inst: Instance, workspace: string, settings = seriesSettings(inst.series())): { who: string; e: Entry }[] {
  if (inst.doc.status !== 'open') return [];
  const by = settings.owner ?? '', a = active.get(inst.seriesId);
  return waitsOn(inst, by, seen(by).at[inst.id] ?? 0, a?.inst === inst ? a.seen : 0, { epoch: settings.epoch, workspace });
}

function asked(r: Request): string | null {
  return seriesSettings(seriesDir(r.series)).owner ?? null;
}

function hidden(t: Tree, us: Record<string, User>): string[] {
  return Object.entries(t.series).flatMap(([sid, s]) => {
    const by = seriesSettings(seriesDir(sid)).owner, p = by && asPerson(by, us[by]);
    return by && (!p || !canSee(p, t.workspaces[s.workspace])) ? [`${named(t, sid)}, owned by ${us[by]?.name ? `${us[by].name} <${by}>` : by}`] : [];
  });
}


function guard(before: string[], after: string[], force: unknown) {
  const lost = after.filter(x => !before.includes(x));
  if (lost.length && !force) throw new HttpError(409, `this would hide series from their owners, so their runs couldn't use their logins: ${lost.join('; ')}. Transfer their ownership to someone who stays first`);
}

// The cached sidebar projection also depends on series authority, including consent additions that keep the same epoch.
const kept = new WeakMap<Instance, { key: string; active: string; asks: { who: string; kind: string; from?: string; started?: boolean }[]; owner: string; acted: string[]; cost: number; estimated: boolean; corrections: number; wrong: string[];
  refused: { at: string; run: number; site: string; login: string; hosts: string[] }[] }>();
function owner(inst: Instance) {
  const r = ownerOf(inst), offers = logins(r.by).flatMap(l => l.offers);
  return { ...r, name: users()[r.by]?.name ?? r.by, since: seriesSettings(inst.series()).since, ticked: r.logins.map(id => offers.find(o => o.id === id)?.name ?? id) };
}

// Whom the page names: whoever has signed in, by their Entra name, as colleagues see each other in the directory; and the Entra
// groups in the workspaces `me` sees, by the labels their owners write, which may say more about a team than its members would.
function names(me: Me) {
  const t = tree(), seen = Object.values(t.workspaces).filter(w => canSee(me, w));
  return {
    ...Object.fromEntries(Object.entries(t.groups ?? {}).filter(([g]) => seen.some(w => everyone(w).includes(g)))),
    ...Object.fromEntries(Object.entries(users()).filter(([, u]) => u.name).map(([email, u]) => [email, u.name])),
  };
}

// What makes an instance new to a person, when someone else or the agent did it: a run's end, a comment, an approval, a rejection, a
// withdrawal, an upload, an assign, a close, a deletion, or a move to another workspace that someone else accepted.
const NEWS = ['done', 'comment', 'signoff', 'reject', 'withdraw', 'upload', 'takeover', 'assign', 'authority', 'close', 'abandon', 'delete', 'move'];

// What an instance's runs cost, since its latest duplication, a deleted one's as its deletion kept it.
const costOf = (i: Instance) => +i.log.slice(i.log.findLastIndex(e => e.op === 'duplicate') + 1).reduce((t, e) => t + (['done', 'delete'].includes(e.op) ? e.cost as number : 0), 0).toFixed(6);
const estimatedOf = (i: Instance) => i.log.slice(i.log.findLastIndex(e => e.op === 'duplicate') + 1).some(e => ['done', 'delete'].includes(e.op) && e.estimated === true);

// The page lists every instance after each step of a run, so this reads the owner from the series' settings, which a listing reads
// once for all of a series' instances, not ownerOf's whole tree.json.
function summary(i: Instance, me: Me, workspace: string, w8 = wakes(), settings = seriesSettings(i.series()), wakesFor = wakesByTarget(w8)) {
  const email = me.email, by = settings.owner ?? '';
  const key = `${i.log.length}:${i.doc.rev}:${JSON.stringify(settings)}:${workspace}:${seen(by).at[i.id]}:${active.get(i.seriesId)?.seen}`;
  const news = i.log.findLast(e => e.by !== email && e.accepted_by !== email && NEWS.includes(e.op)), s = seen(email);
  let k = kept.get(i);
  if (k?.key !== key) kept.set(i, k = { key, active: i.log.at(-1)!.at, asks: waits(i, workspace, settings).map(({ who, e }) => ({ who, kind: e.ask === true ? 'ask' : (e.ask as string | undefined) ?? 'note', ...(isPerson(e) && { from: e.by, started: e.op === 'create' }) })), owner: by, acted: [...new Set(i.log.filter(isPerson).map(e => e.by))], cost: costOf(i), estimated: estimatedOf(i), corrections: i.log.filter(e => e.op === 'correction').length,
    wrong: i.log.filter(e => e.op === 'correction' && e.kind === 'wrong').map(e => e.at),
    refused: i.log.filter(e => e.op === 'browser' && e.hosts).map(e => ({ at: e.at, run: e.run as number, site: e.site as string, login: e.login as string, hosts: Object.keys(e.hosts as object) })) });
  return {
    id: i.id, label: i.label, status: i.doc.status, rev: i.doc.rev, running: active.get(i.seriesId)?.inst === i, queued: !!queued(i),
    asks: k.asks, wakeCheck: wakeCheckStatus(i), wakes: wakesFor(i.id), fired: w8.fired[i.id] ?? null, owner: k.owner, cost: k.cost, ...(k.estimated && { estimated: true }), active: k.active,
    unread: !!news && news.at > s.since && news.seq > (s.at[i.id] ?? 0), corrections: k.corrections,
    // A deleted instance's hole: who deleted it, and when.
    deleted: i.hole ? { by: i.log[0].by, at: i.log[0].at } : null,
    // Corrections wait on the owner for a week; they are never withdrawn.
    wrong: k.wrong.filter(fresh).length,
    // Only admins decide hosts: those rated high or internal, with why, for a week.
    refused: k.refused.filter(e => fresh(e.at) && e.login && websitesOf(e.login)[e.site]).map(e => {
      const checks = websitesOf(e.login)[e.site].checks ?? {}, hosts = unreached(e.login, e.site, e.hosts).filter(h => me.role === 'admin' && checks[h] && ['high', 'internal'].includes(checks[h].verdict));
      return { ...e, hosts, why: Object.fromEntries(hosts.filter(h => checks[h]).map(h => [h, checks[h].why])) };
    }).filter(e => e.hosts.length),
  };
}

// A proposal lapses, and a series moved out stops showing where it was, a week on.
const fresh = (at: string) => Date.now() - Date.parse(at) < 7 * 86400e3;
// The proposals open, each by the id of the workspace it merges or moves a series out of, into the one it names, while whoever
// proposed it still manages that workspace.
const proposals = (t: Tree) => Object.entries(t.workspaces).filter(([, w]) => {
  const by = w.proposal && fresh(w.proposal.at) && asPerson(w.proposal.by);
  return !!by && canManage(by, w);
}).map(([id, w]) => {
  const p = w.proposal!;
  return { id, into: p.to, kind: p.kind, from: w.name, to: t.workspaces[p.to].name, series: p.series ? t.series[p.series].name : null, by: p.by, at: p.at };
});

function seriesOwnerSchedules(sid: string, seriesName: string, w8 = wakes()) {
  const instById = new Map(labels(sid).map(l => [l.id, l.label]));
  const targets = new Set([sid, ...instById.keys()]);
  const schedules = Object.entries(w8.pending)
    .filter(([, k]) => targets.has(k.target) && k.request === false)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([wid, k]) => ({
      id: wid, target: k.target, targetLabel: instById.get(k.target) ?? seriesName,
      at: k.at, ...(k.deadline && { deadline: k.deadline }), ...(k.label && { label: k.label }),
      ...(k.days && { days: k.days }), from: k.from, ...(k.text && { text: k.text }), ...(k.check && { check: k.check }),
    }));
  const scheduleRevision = createHash('sha256').update(JSON.stringify(schedules)).digest('hex').slice(0, 16);
  return { schedules, scheduleRevision };
}

function listing(me: Me) {
  const t = tree(), w8 = wakes(), wakesFor = wakesByTarget(w8), us = users(), instancesOf = instancesBySeries(), open = proposals(t), granted = visible(me).filter(g => ['pending', 'approved'].includes(g.state)), byName = (a: [string, { name: string }], b: [string, { name: string }]) => a[1].name.localeCompare(b[1].name);
  return Object.entries(t.workspaces).filter(([, w]) => canSee(me, w)).sort(byName).map(([id, w]) => {
    const series = Object.entries(t.series).filter(([, s]) => s.workspace === id).sort(byName).map(([sid, s]) => {
      const settings = seriesSettings(seriesDir(sid)), { owner, consent, epoch, since } = settings, person = owner && asPerson(owner, us[owner]);
      const periods = instancesOf(sid), discussion = seriesConversation(sid, periods, epoch);
      const { scheduleRevision } = seriesOwnerSchedules(sid, s.name, w8);
      return {
        id: sid, name: s.name, archived: !!s.archived, single: !!s.single, owner: owner ?? null, ownerUnavailable: !person || !canSee(person, w), epoch, since, consent: consent ?? null,
        scheduleRevision,
        wakes: wakesFor(sid), fired: w8.fired[sid] ?? null, notes: openNotes(discussion.notes).length,
        noteNotices: s.archived || w.archived ? [] : notices(discussion.notes, discussion.dismissed, me.email, owner, s.name),
        requests: Object.entries(w8.requests).filter(([, r]) => r.series === sid).map(([id, r]) => ({ id, ...r, who: asked(r) })),
        instances: periods.map(i => summary(i, me, id, w8, settings, wakesFor)),
      };
    });

    const mine = w.owners.includes(me.email) || series.some(s => s.owner === me.email || instancesOf(s.id).some(i => kept.get(i)!.acted.includes(me.email)));
    return {
      id, name: w.name, archived: !!w.archived, owners: w.owners, members: w.members, manage: canManage(me, w), agents: text(agentsFile(id)), mine,
      proposal: open.find(p => p.id === id || p.into === id) ?? null, moved: (w.moved ?? []).filter(m => fresh(m.at)),
      // The workspaces its agents read, and those whose agents read it, as each one's managers let them.
      reads: reads(t, id).map(o => ({ id: o, name: t.workspaces[o].name })), readers: (w.readers ?? []).map(o => ({ id: o, name: t.workspaces[o].name })),
      // The grants to use websites here, asked or approved: all of them for its managers, else one's own.
      grants: granted.filter(g => g.workspace === id),
      series,
    };
  });
}

// An instance's runs started since `since`, and since its latest duplication: when, how each ended, its cost, whose it was and what started it. A deleted instance's are
// as its deletion kept them, for the totals: when, how each ended, its cost and whose it was.
type RunRow = { run: number; at: string; outcome: string; failure: string | null; seconds: number; cost: number; estimated?: true; runner: string; initiator?: string; provenance?: unknown; started: { op: string; by: string } | null; error: string | null };
type CachedRun = RunRow & { key?: 'own' | 'shared'; exaCost?: number; openrouterByDay?: Record<string, { cost: number; estimated?: true }> };
const runsKept = new WeakMap<Instance, { log: object; len: number; rows: CachedRun[] }>();

function cachedRunsOf(i: Instance): CachedRun[] {
  const a = active.get(i.seriesId), runningHere = a?.inst === i;
  const hit = !runningHere && runsKept.get(i);
  if (hit && hit.log === i.log && hit.len === i.log.length) return hit.rows;
  let rows: CachedRun[];
  if (i.hole) {
    rows = ((i.log[0].runs ?? []) as CachedRun[]).map(r => ({ ...r, started: null, error: null }));
  } else {
    const slice = i.log.slice(i.log.findLastIndex(e => e.op === 'duplicate') + 1);
    rows = slice.filter(r => r.op === 'run').map(r => {
      const d = slice.find(e => e.op === 'done' && e.run === r.run);
      const cause = slice.find(e => e.seq === (r.provenance as { cause?: number } | undefined)?.cause);
      // A run with no done is going only if it's the one going here; any other ended unlogged, cut, as its last entry tells.
      const going = !d && runningHere && a.n === r.run, end = d ?? (going ? undefined : slice.findLast(e => e.run === r.run) ?? r);
      const error = d?.error as string | undefined, outcome = going ? 'running' : !d ? 'cut' : !error ? (d.aborted ? 'interrupted' : 'done') : Object.values(CUT).includes(error) ? 'cut' : 'failed';
      const estimated = d ? d.estimated === true : going && !!a.estimated;
      const exaCost = +slice.reduce((t, e) => t + (e.op === 'call' && e.run === r.run && e.name === 'exa' ? (e.cost as number | undefined) ?? 0 : 0), 0).toFixed(6);
      const calls = r.key === 'own' ? [] : slice.filter(e => e.op === 'call' && e.run === r.run && e.name === 'openrouter');
      let openrouterByDay: Record<string, { cost: number; estimated?: true }> | undefined;
      if (calls.length) {
        openrouterByDay = Object.create(null);
        for (const e of calls) {
          const day = e.at.slice(0, 10), prev = openrouterByDay![day] ??= { cost: 0 };
          prev.cost += (e.cost as number | undefined) ?? 0;
          if (e.estimated) prev.estimated = true;
        }
        for (const d of Object.values(openrouterByDay!)) d.cost = +d.cost.toFixed(6);
      }
      return {
        run: r.run as number, at: r.at, outcome,
        failure: outcome !== 'failed' ? null : d?.oom ? 'memory' : /\b402\b|credits/i.test(error!) ? 'credits' : /\b403\b|terms of service|usage polic|flagged/i.test(error!) ? 'policy' : error === 'time limit' ? 'time limit' : 'other',
        seconds: Math.round(((end ? Date.parse(end.at) : Date.now()) - Date.parse(r.at)) / 1000),
        cost: d ? d.cost as number : going ? +a.cost.toFixed(6) : 0,
        ...(estimated && { estimated: true as const }),
        runner: (r.runner as string | undefined) ?? runnerAt(i.log, r.seq),
        ...(typeof r.initiator === 'string' && { initiator: r.initiator }),
        ...(r.provenance && { provenance: r.provenance }),
        started: cause ? { op: cause.op, by: cause.op === 'wake' ? cause.from as string : cause.by } : null,
        error: error ?? null,
        ...(r.key && { key: r.key as 'own' | 'shared' }),
        ...(exaCost && { exaCost }),
        ...(openrouterByDay && { openrouterByDay }),
      };
    });
  }
  if (!runningHere) runsKept.set(i, { log: i.log, len: i.log.length, rows });
  return rows;
}

type WakeCheckRow = Omit<RunRow, 'run'> & { run: null; outcome: 'wake-check-stop'; message?: string };

function wakeChecksOf(i: Instance): WakeCheckRow[] {
  if (i.hole) return (i.log[0].wakeChecks ?? []) as WakeCheckRow[];
  return i.log.slice(i.copied).filter(e => e.op === 'wake-check').map(e => ({
    run: null, outcome: 'wake-check-stop', at: e.at, seconds: e.seconds as number, cost: 0, runner: e.runner as string,
    started: { op: 'wake', by: e.from as string }, failure: null, error: null, message: e.message as string, provenance: { schedule: e.schedule },
  }));
}

function runsOf(i: Instance, since = ''): (RunRow | WakeCheckRow)[] {
  return [
    ...cachedRunsOf(i).map(({ key: _k, exaCost: _e, openrouterByDay: _o, ...r }) => r),
    ...wakeChecksOf(i),
  ].filter(r => r.at >= since);
}

// Every run in what `me` sees, started since `since`, by where it ran.
function runs(me: Me, since: string) {
  const t = tree();
  const visible = Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace]));
  const visibleIds = new Set(visible.map(([sid]) => sid));
  const instRuns = visible.flatMap(([sid]) => instances(sid).flatMap(i => runsOf(i, since).map(r => ({ path: `${named(t, sid)}/${i.label}`, ...r }))));
  const seriesChecks = seriesWakeChecks()
    .filter(c => visibleIds.has(c.series) && c.at >= since)
    .map(c => ({
      path: `${named(t, c.series)}/${c.label}`,
      run: null, outcome: 'wake-check-stop' as const, at: c.at, seconds: c.seconds, cost: 0,
      runner: c.runner, started: { op: 'wake', by: c.from }, failure: null, error: null,
      message: c.message, provenance: { schedule: c.schedule },
    }));
  return [...instRuns, ...seriesChecks].sort((x, y) => x.at.localeCompare(y.at));
}

// What people and the agent said, what people uploaded, closed and deleted, and each run's failure, per instance `me` sees, since
// `since`.
function activity(me: Me, since: string) {
  const t = tree();
  return Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace])).flatMap(([sid]) => instances(sid).map(i => ({
    path: `${named(t, sid)}/${i.label}`,
    entries: i.log.filter(e => e.at >= since && ((e.op === 'done' && e.error) || e.op === 'comment' || (isPerson(e) && ['upload', 'close', 'abandon', 'delete'].includes(e.op)))).map(e => ({
      at: e.at, by: e.by, op: e.op, ...(e.op === 'comment' && { text: e.text }), ...(e.op === 'upload' && { file: e.file }), ...(e.op === 'done' && { run: e.run, error: e.error }),
    })),
  })).filter(b => b.entries.length));
}

// What goes on and what is stuck in what `me` sees: runs going and queued, what waits on whom, and open instances whose last run
// failed. Admins see everyone's expired logins, others their own.
async function costs(me: Me, since: string, tz: string) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('sv-SE', { ...(tz && { timeZone: tz }), year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new HttpError(400, `invalid timezone: ${tz}`);
  }
  const dayOf = (iso: string) => fmt.format(new Date(iso));
  const t = tree(), records = syncCosts(), isAdmin = me.role === 'admin';
  type DayRun = { at: string; path: string; workspace: string; series: string; run: number; person: string; outcome: string; failure: string | null; cost: number; estimated?: true; key?: 'own' | 'shared' };
  type ServerItem = { kind: 'website-check' | 'try'; site?: string; person: string; calls: number; cost: number; estimated?: true };
  type DayEntry = {
    day: string; cost: number; runs_count: number; estimated?: true;
    by_workspace: Record<string, { runs: number; cost: number; estimated?: true }>;
    by_person: Record<string, { runs: number; cost: number; estimated?: true }>;
    runs: DayRun[];
    server?: { cost: number; estimated?: true; items: ServerItem[] };
  };
  const byDay = new Map<string, { runs: DayRun[]; server: Map<string, ServerItem> }>();
  const bucket = (d: string) => {
    let b = byDay.get(d);
    if (!b) byDay.set(d, b = { runs: [], server: new Map() });
    return b;
  };
  for (const [sid, s] of Object.entries(t.series)) {
    const w = t.workspaces[s.workspace];
    if (!canSee(me, w)) continue;
    const seriesName = `${w.name}/${s.name}`;
    for (const i of instances(sid)) for (const r of cachedRunsOf(i)) {
      if (r.at < since) continue;
      bucket(dayOf(r.at)).runs.push({
        at: r.at, path: `${seriesName}/${i.label}`, workspace: w.name, series: seriesName,
        run: r.run, person: r.runner, outcome: r.outcome, failure: r.failure, cost: r.cost,
        ...(r.estimated && { estimated: true }), ...(r.key && { key: r.key }),
      });
    }
  }
  if (isAdmin) for (const e of records) {
    if (!('by' in e) || e.at < since) continue;
    const b = bucket(dayOf(e.at)), k = `${e.kind}\0${e.site ?? ''}\0${e.person}`;
    const prev = b.server.get(k) ?? { kind: e.kind, ...(e.site && { site: e.site }), person: e.person, calls: 0, cost: 0 };
    prev.calls++;
    prev.cost = +(prev.cost + e.cost).toFixed(6);
    if (e.estimated) prev.estimated = true;
    b.server.set(k, prev);
  }
  const counted = (r: { outcome: string }) => r.outcome === 'cut' ? 0 : 1;
  const days: DayEntry[] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => {
    b.runs.sort((x, y) => x.at.localeCompare(y.at));
    const byWs: DayEntry['by_workspace'] = Object.create(null), byPerson: DayEntry['by_person'] = Object.create(null);
    let runCost = 0, runCount = 0, est = false;
    for (const r of b.runs) {
      const c = counted(r);
      runCost += r.cost;
      runCount += c;
      if (r.estimated) est = true;
      const w = byWs[r.workspace] ??= { runs: 0, cost: 0 };
      w.runs += c; w.cost = +(w.cost + r.cost).toFixed(6);
      if (r.estimated) w.estimated = true;
      const p = byPerson[r.person] ??= { runs: 0, cost: 0 };
      p.runs += c; p.cost = +(p.cost + r.cost).toFixed(6);
      if (r.estimated) p.estimated = true;
    }
    const items = [...b.server.values()].sort((x, y) => y.cost - x.cost);
    const srvCost = items.reduce((s, x) => s + x.cost, 0), srvEst = items.some(x => x.estimated);
    if (srvEst) est = true;
    return {
      day, cost: +(runCost + (isAdmin ? srvCost : 0)).toFixed(6), runs_count: runCount, ...(est && { estimated: true }),
      by_workspace: byWs, by_person: byPerson, runs: b.runs,
      ...(isAdmin && { server: { cost: +srvCost.toFixed(6), ...(srvEst && { estimated: true }), items } }),
    };
  });
  if (!isAdmin) return { days };
  const k = await keyStatus();
  if (!k) return { days };
  const utcDay = new Date().toISOString().slice(0, 10);
  const trackedRuns = new Set<string>();
  let serverTotal = 0, serverEst = false;
  for (const e of records) {
    if (!('by' in e)) trackedRuns.add(`${e.inst}:${e.run}`);
    if (e.at.slice(0, 10) === utcDay && e.service === 'openrouter' && !e.own) {
      serverTotal += e.cost;
      if (e.estimated) serverEst = true;
    }
  }
  // Include any run on today's UTC day that predates costs.jsonl (e.g. from earlier on deploy day).
  for (const sid of Object.keys(t.series)) for (const i of instances(sid)) for (const r of cachedRunsOf(i)) {
    if (r.key === 'own' || trackedRuns.has(`${i.id}:${r.run}`)) continue;
    if (r.openrouterByDay) {
      const day = Object.hasOwn(r.openrouterByDay, utcDay) ? r.openrouterByDay[utcDay] : undefined;
      if (day) {
        serverTotal += day.cost;
        if (day.estimated) serverEst = true;
      }
    } else if (r.at.slice(0, 10) === utcDay) {
      if (i.hole && !r.key) {
        if (r.cost > 0) serverEst = true;
      } else {
        const orCost = Math.max(0, r.cost - (r.exaCost ?? 0));
        serverTotal += orCost;
        if (r.estimated && (orCost > 0 || !r.exaCost)) serverEst = true;
      }
    }
  }
  return {
    days,
    key: {
      usage: k.usage, usage_daily: k.usage_daily, limit: k.limit, remaining: k.remaining, reset: k.reset,
      fetched_at: k.fetched_at, low_credit: k.low_credit, ...(k.credit_error && { credit_error: k.credit_error }), day: utcDay,
      server_total: +serverTotal.toFixed(6), ...(serverEst && { server_estimated: true }),
      unattributed: (k.usage_daily_all ?? k.usage_daily) !== null ? +((k.usage_daily_all ?? k.usage_daily)! - serverTotal).toFixed(6) : null,
    },
  };
}

async function status(me: Me) {
  const t = tree(), w8 = wakes(), path = (i: Instance) => `${named(t, i.seriesId)}/${i.label}`;
  const seen = Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace]));
  const open = seen.flatMap(([sid]) => instances(sid).filter(i => i.doc.status === 'open'));
  const k = !verifyOnly && me.role === 'admin' ? await keyStatus() : null, listed = listing(me);
  const creditErr = !verifyOnly && me.role === 'admin' ? (k?.credit_error ?? openrouterCreditError()) : null;
  const noteNotices = listed.flatMap(w => w.series.flatMap(s => s.noteNotices.map(n => ({ ...n, path: `${w.name}/${s.name}${n.anchor ? `/${n.anchor.label}` : ''}` }))));
  return {
    ...(k?.low_credit && { low_credit: { remaining: k.remaining!, limit: k.limit, usage: k.usage, reset: k.reset, key: k.key } }),
    ...(creditErr && { credit_error: creditErr }),
    running: seen.flatMap(([sid]) => active.get(sid) ?? []).map(a => ({ path: path(a.inst), run: a.n, owner: ownerOf(a.inst).by, at: a.inst.log.findLast(e => e.op === 'run')!.at, cost: +a.cost.toFixed(6), ...(a.estimated && { estimated: true }) })),
    queued: open.flatMap(i => { const q = queued(i); return q ? [{ path: path(i), owner: ownerOf(i).by, ...q }] : []; }),
    ownership: listed.filter(w => w.manage && !w.archived).flatMap(w => w.series.filter(s => !s.archived && s.ownerUnavailable).map(s => ({ id: s.id, path: `${w.name}/${s.name}`, text: s.owner ? `${users()[s.owner]?.name ?? s.owner} can no longer run ${s.name}` : `${s.name} has no owner` }))),
    noteNotices,
    asks: [
      ...open.flatMap(i => waits(i, t.series[i.seriesId].workspace).map(({ who, e }) => ({ who, path: path(i), since: e.at, text: isPerson(e) ? `${users()[e.by]?.name ?? e.by} ${e.op === 'create' ? 'started' : 'added a note to'} ${t.series[i.seriesId].name} · ${i.label}` : e.text as string, note: e.by !== 'agent' || !e.ask }))),
      // rf 0.19.2 reads only asks; projected notices are not actionable asks.
      ...noteNotices.filter(n => n.kind === 'open').map(n => ({ who: me.email, path: n.path, since: n.at, text: n.text, note: true, legacyNotice: true })),
    ],
    expired: (me.role === 'admin' ? Object.keys(users()) : [me.email]).flatMap(who => logins(who).filter(l => l.expired).map(l => ({
      who, login: l.name,
      holding: open.filter(i => held(i, l.id, who)).map(path),
    }))),
    requests: Object.values(w8.requests).filter(r => seen.some(([sid]) => sid === r.series)).map(r => ({ who: asked(r), path: named(t, r.series), label: r.label, from: r.from, at: r.at, ...(r.target && { target: r.target }) })),
    proposals: proposals(t).filter(p => [p.id, p.into].some(x => canSee(me, t.workspaces[x]))),
    failed: open.filter(i => active.get(i.seriesId)?.inst !== i).flatMap(i => {
      const d = i.log.findLast(e => e.op === 'done');
      return d?.error ? [{ path: path(i), run: d.run as number, at: d.at, error: d.error as string }] : [];
    }),
  };
}

function* jsonlLines(dir: string, name: string): Generator<string> {
  const fd = openFile(dir, name);
  if (fd === undefined) return;
  try {
    const size = fstatSync(fd).size, buf = Buffer.allocUnsafe(65536), head = 4 << 20, tail = 60 << 20, maxLine = 8 << 20;
    let pos = 0, carry: Buffer<ArrayBufferLike> = Buffer.alloc(0), drop = false;
    while (pos < size) {
      if (size > head + tail && pos >= head && pos < size - tail) {
        pos = size - tail;
        carry = Buffer.alloc(0);
        readSync(fd, buf, 0, 1, pos - 1);
        drop = buf[0] !== 10;
      }
      const n = readSync(fd, buf, 0, Math.min(buf.length, size > head + tail && pos < head ? head - pos : size - pos), pos);
      if (!n) break;
      pos += n;
      let from = 0;
      for (let nl; (nl = buf.indexOf(10, from)) !== -1 && nl < n; from = nl + 1) {
        if (!drop && carry.length + (nl - from) <= maxLine) {
          const line = carry.length ? Buffer.concat([carry, buf.subarray(from, nl)]).toString('utf8') : buf.subarray(from, nl).toString('utf8');
          if (line) yield line;
        }
        carry = Buffer.alloc(0);
        drop = false;
      }
      if (from < n && !drop) {
        if (carry.length + (n - from) > maxLine) { carry = Buffer.alloc(0); drop = true; }
        else carry = carry.length ? Buffer.concat([carry, buf.subarray(from, n)]) : Buffer.from(buf.subarray(from, n));
      }
    }
    if (!drop && carry.length && !carry.includes(0)) yield carry.toString('utf8');
  } finally { closeSync(fd); }
}

function trace(inst: Instance) {
  const dir = join(inst.dir, 'session');
  if (inst.doc.status === 'deleted') return [];
  type Line = { kind: string; text: string; at?: string; result?: string; lines?: number; error?: boolean };
  const out: Line[] = [], calls = new Map<string, Line>();
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() : []) {
    // A line a restart cut left half written is skipped, as Pi skips it.
    for (const line of jsonlLines(dir, f)) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== 'message' || !e.message || typeof e.message !== 'object') continue;
      const m = e.message;
      if (m.role === 'user') out.push({ kind: 'user', at: e.timestamp, text: typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: unknown }) => typeof b?.text === 'string' ? b.text : '').join('') : '' });
      if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'say', at: e.timestamp, text: b.text });
        if (b.type === 'toolCall' && typeof b.name === 'string') {
          const args = b.arguments && typeof b.arguments === 'object' ? b.arguments : {};
          out.push({ kind: b.name, at: e.timestamp, text: typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : JSON.stringify(args) });
          if (typeof b.id === 'string') calls.set(b.id, out.at(-1)!);
        }
      }
      if (m.role === 'toolResult') {
        const hit = typeof m.toolCallId === 'string' ? calls.get(m.toolCallId) : undefined;
        if (!hit) continue;
        const text = Array.isArray(m.content) ? m.content.map((b: { text?: unknown }) => typeof b?.text === 'string' ? b.text : '').join('') : '';
        Object.assign(hit, { result: text.slice(0, 4000), lines: text.trimEnd().split('\n').length, error: !!m.isError });
      }
    }
  }
  return out;
}

// Files by hand, never into a link: a run may have made links anywhere in working/. Nothing named as git takes a .git, such as the
// instance's history or a run's .GIT/, which is one on a disk that ignores case, is copied.
function walk(dir: string): string[] {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (['EACCES', 'ENOENT'].includes((e as NodeJS.ErrnoException).code!)) return []; throw e; }
  return entries.filter(d => existsSync(join(dir, d.name))).flatMap(d => refused(d.name, false) ? [] : d.isDirectory() ? walk(join(dir, d.name)) : d.isFile() ? [join(dir, d.name)] : []);
}

// What rf pull copies: every file under `path` that `me` sees, in the layout runs see (workspace/series/label/ and the instance's own
// files), with its size and time; the AGENTS.md files whole, and each instance file at its /files address.
function pullable(me: Me, path: string) {
  const t = tree(), out: { path: string; size: number; mtime: string; url?: string; text?: string }[] = [];
  // A name that isn't UTF-8, as unzipping an old archive leaves, reads back as another name, which no file has: it is left out.
  const add = (at: string, file: string, more: { url?: string; text?: string }) => {
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) return;
    if (more.url) try { accessSync(file, constants.R_OK); } catch { return; }
    out.push({ path: at, size: more.text === undefined ? st.size : Buffer.byteLength(more.text), mtime: st.mtime.toISOString(), ...more });
  };
  const near = (at: string) => !path || at === path || at.startsWith(path + '/') || path.startsWith(at + '/');
  if (existsSync(agentsFile())) add('AGENTS.md', agentsFile(), { text: text(agentsFile()) });
  for (const [wid, w] of Object.entries(t.workspaces).filter(([, w]) => canSee(me, w))) {
    if (existsSync(agentsFile(wid))) add(`${w.name}/AGENTS.md`, agentsFile(wid), { text: text(agentsFile(wid)) });
    for (const [sid, s] of Object.entries(t.series).filter(([, s]) => s.workspace === wid)) for (const l of labels(sid)) {
      const at = `${w.name}/${s.name}/${l.label}`, dir = instanceDir(l.id), inst = instance(l.id);
      if (!near(at)) continue;
      inst.syncLog();
      if (inst.hole) {
        add(`${at}/instance.json`, join(dir, 'instance.json'), { text: text(join(dir, 'instance.json')) });
        add(`${at}/screen.json`, join(dir, 'screen.json'), { text: JSON.stringify(inst.doc) });
        add(`${at}/log.jsonl`, join(dir, 'log.jsonl'), { text: JSON.stringify(inst.log[0]) + '\n' });
      } else for (const f of walk(dir)) add(`${at}/${relative(dir, f).split(sep).join('/')}`, f, { url: `/files/${l.id}/${relative(dir, f).split(sep).map(encodeURIComponent).join('/')}` });
    }
  }
  return out.filter(f => !path || f.path === path || f.path.startsWith(path + '/'));
}

let previewing = 0;
const turns: (() => void)[] = [];

function leafPreviewQuery(name: string, params: URLSearchParams): string {
  const ext = extname(name).toLowerCase();
  const out = new URLSearchParams();
  if (ext === '.xlsx' || ext === '.xlsm') {
    const s = params.get('sheet');
    if (s !== null) out.set('sheet', s);
  } else if (ext === '.pdf') {
    const p = params.get('page');
    if (p !== null && /^\d+$/.test(p)) {
      const n = Number(p);
      if (Number.isSafeInteger(n)) out.set('page', String(n));
    }
  } else if (ext === '.docx') {
    if (params.has('layout')) out.set('layout', '1');
  }
  return out.toString();
}

function mailAttachmentChain(params: URLSearchParams): { attachments: number[]; rest: URLSearchParams } {
  const entries = [...params.entries()];
  const attachments: number[] = [];
  let i = 0;
  while (i < entries.length && entries[i][0] === 'attachment' && /^\d+$/.test(entries[i][1])) {
    const idx = Number(entries[i][1]);
    if (!Number.isSafeInteger(idx)) break;
    attachments.push(idx);
    i++;
  }
  return { attachments, rest: new URLSearchParams(entries.slice(i)) };
}

async function previewCachePath(instId: string, name: string, part: string, fd: number): Promise<string> {
  const sum = createHash('sha256').update(`${name}\n${part}\n`);
  for await (const c of createReadStream('', { fd, start: 0, autoClose: false })) sum.update(c);
  return join(previews, `${instId}-${sum.digest('hex')}`);
}

function openCachedPreview(path: string): number | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY);
    const now = new Date();
    try { futimesSync(fd, now, now); } catch {}
    return fd;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function renderPreview(inst: Instance, fd: number, name: string, part: string): Promise<string> {
  if (previewing < 2) previewing++;
  else await new Promise<void>(go => turns.push(go));
  try {
    if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
    const run = exec('bwrap', [
      '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', ...userland(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', join(app, 'src', 'preview.py'), '/preview.py', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--', '/opt/venv/bin/python', '/preview.py', name, part,
    ], { timeout: 30_000, maxBuffer: 64e6, env: { PATH: process.env.PATH } });
    const content = createHash('sha256').update(`${name}\n${part}\n`);
    // A file preview.py can't read, as a broken or password-protected one, is a plain message.
    const [{ stdout }] = await Promise.all([run, pipeline(createReadStream('', { fd, start: 0, autoClose: false }), async function* (chunks: AsyncIterable<Buffer>) {
      for await (const c of chunks) { content.update(c); yield c; }
    }, run.child.stdin!)]).catch(() => { throw new HttpError(422, `can't preview ${name}: download it`); });
    if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
    const tmp = join(tmpDir, randomUUID()), dest = join(previews, `${inst.id}-${content.digest('hex')}`);
    writeFileSync(tmp, stdout);
    renameSync(tmp, dest);
    prunePreviews(previews, dest);
    return stdout;
  } finally {
    const go = turns.shift();
    if (go) go();
    else previewing--;
  }
}

async function resolveMailPreviewPart(inst: Instance, fd: number, name: string, params: URLSearchParams): Promise<string> {
  const { attachments, rest } = mailAttachmentChain(params);
  if (!attachments.length) return '';
  const baseParams = new URLSearchParams();
  for (const a of attachments) baseParams.append('attachment', String(a));
  if (rest.get('sheet') === null && rest.get('page') === null && !rest.has('layout')) return baseParams.toString();
  // Resolve the target attachment's filename via the sandboxed parent email preview so text/image attachments ignore sheet/page/layout.
  let targetName: string | undefined;
  const prefix = new URLSearchParams();
  for (const idx of attachments) {
    const prefixPart = prefix.toString(), cached = await previewCachePath(inst.id, name, prefixPart, fd);
    let raw: string;
    const hitFd = openCachedPreview(cached);
    if (hitFd !== undefined) {
      try { raw = readFileSync(hitFd, 'utf8'); } finally { closeSync(hitFd); }
    } else {
      raw = await renderPreview(inst, fd, name, prefixPart);
    }
    let parsed: { email?: { attachments?: { name?: string; k?: number }[] } };
    try { parsed = JSON.parse(raw); } catch { break; }
    const found = parsed.email?.attachments?.find(a => a.k === idx);
    targetName = found?.name;
    if (!targetName) break;
    prefix.append('attachment', String(idx));
  }
  if (targetName) {
    const leaf = leafPreviewQuery(targetName, rest);
    if (leaf) for (const [k, v] of new URLSearchParams(leaf)) baseParams.append(k, v);
  }
  return baseParams.toString();
}

function previewCacheBytes(): number {
  const rawBytes = process.env.RF_PREVIEW_CACHE_BYTES;
  if (rawBytes !== undefined && rawBytes.trim()) {
    const n = Number(rawBytes);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const rawMb = process.env.RF_PREVIEW_CACHE_MB;
  if (rawMb !== undefined && rawMb.trim()) {
    const mb = Number(rawMb);
    if (Number.isFinite(mb) && mb >= 0) return Math.floor(mb * 2 ** 20);
  }
  return 256 * 2 ** 20;
}

function prunePreviews(dir: string, keepPath?: string) {
  const budget = previewCacheBytes();
  let entries: { path: string; size: number; mtimeMs: number }[];
  try {
    entries = readdirSync(dir).flatMap(name => {
      const p = join(dir, name);
      try { const st = statSync(p); return st.isFile() ? [{ path: p, size: st.size, mtimeMs: st.mtimeMs }] : []; }
      catch { return []; }
    });
  } catch { return; }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= budget) return;
  // Evict oldest previews first; keep the freshly written entry unless it alone exceeds the budget.
  entries.sort((a, b) => (a.path === keepPath ? 1 : b.path === keepPath ? -1 : a.mtimeMs - b.mtimeMs));
  for (const e of entries) {
    if (total <= budget) break;
    rmSync(e.path, { force: true });
    total -= e.size;
  }
}

async function file(me: Me, res: ServerResponse, url: URL, preview: boolean) {
  const [id, ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const rel = rest.join('/');
  if (posix.normalize(rel) !== rel || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
  const inst = instance(id);
  mustSee(me, tree().workspaces[tree().series[inst.seriesId].workspace]);
  if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
  if (rel === 'log.jsonl') inst.syncLog();
  const pin = url.searchParams.get('sha256');
  if (pin !== null) {
    if (!/^[a-f0-9]{64}$/i.test(pin) || !/^(upload|working)\/.+/.test(rel)) throw new HttpError(400, 'bad attachment pin');
    res.setHeader('cache-control', 'no-store');
    url.searchParams.delete('sha256');
  }
  let fd = openFile(inst.dir, rel);
  if (fd === undefined) throw new HttpError(404, 'no such file');
  if (pin !== null) {
    // Serve the verified bytes, not a second read of a working file that can change after the check.
    const dir = verifyOnly ? (await import('node:os')).tmpdir() : tmpDir;
    const name = randomUUID(), tmp = join(dir, name), sum = createHash('sha256');
    try {
      await pipeline(createReadStream('', { fd }), async function* (chunks: AsyncIterable<Buffer>) {
        for await (const c of chunks) { sum.update(c); yield c; }
      }, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      if (sum.digest('hex') !== pin.toLowerCase() || inst.doc.status === 'deleted') throw new HttpError(404, 'Attachment unavailable');
      fd = openFile(dir, name)!;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (preview) {
    // preview.py runs in the agent's userland, with no network and nothing of the host's, the server's environment included, which
    // bwrap's PID 1 inside would keep: the file, up to 100 MB, streams to its stdin. What it makes is kept, until the server
    // restarts, by the file's name and the content it was given; at most 2 run at once, the rest waiting their turn, so previews
    // never crowd out runs.
    try {
      if (fstatSync(fd).size > 100e6) throw new HttpError(413, `${basename(rel)} is over 100 MB, too big to preview: download it`);
      const name = basename(rel), ext = extname(name).toLowerCase();
      if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
      // A part of the file, as its validated renderer query asks, such as a workbook's sheet or an email's attachment, is a preview of its own.
      const part = ext === '.eml' || ext === '.msg'
        ? await resolveMailPreviewPart(inst, fd, name, url.searchParams)
        : leafPreviewQuery(name, url.searchParams);
      const kept = await previewCachePath(inst.id, name, part, fd);
      if (inst.doc.status === 'deleted') throw new HttpError(404, 'the instance was deleted');
      const hitFd = openCachedPreview(kept);
      if (hitFd !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return sendStream(createReadStream('', { fd: hitFd }), res);
      }
      const stdout = await renderPreview(inst, fd, name, part);
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(stdout);
    } finally {
      closeSync(fd);
    }
  }
  const image = rel.match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
  res.writeHead(200, {
    'content-type': image ? `image/${image}` : 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'content-disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(rel))}`,
  });
  if (res.req.method === 'HEAD') {
    closeSync(fd);
    return void res.end();
  }
  await sendStream(createReadStream('', { fd }), res);
}

// The page's event stream: the id of each instance the person can see as it changes, and "tree" for anything else, at most one a
// second each, so the page refreshes on change instead of polling. A change reads its instance's workspace once, as the first stream
// that needs it asks, for all the streams open.
const streams = new Set<(id: string, workspace: () => Workspace) => void>();
changes.on('change', (id: string) => {
  let w: Workspace | undefined;
  const workspace = () => {
    if (!w) { const t = tree(); w = t.workspaces[t.series[instance(id).seriesId].workspace]; }
    return w;
  };
  for (const on of streams) on(id, workspace);
});

function events(me: Me, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).flushHeaders(); // the page hears it's open at once
  const due = new Map<string, NodeJS.Timeout>(), beat = setInterval(() => res.write(': beat\n\n'), 30_000);
  const on = (id: string, workspace: () => Workspace) => {
    if (due.has(id) || (id !== 'tree' && !canSee(me, workspace()))) return;
    due.set(id, setTimeout(() => { due.delete(id); res.write(`data: ${id}\n\n`); }, 1000));
  };
  streams.add(on);
  req.on('close', () => { streams.delete(on); clearInterval(beat); for (const t of due.values()) clearTimeout(t); });
}

const text = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
// The deployment's brand, the admins': a text and a logo, which top the sidebar and are the page's title and icon.
const brand = () => readJson<{ text?: string; logo?: string; type?: string }>('brand.json', {});
// Each request's JSON body, as read, for the system's log.
const bodies = new WeakMap<IncomingMessage, object>();
const messageWrites = new WeakSet<IncomingMessage>();
const json = async (req: IncomingMessage) => {
  const text = (await body(req)).toString();
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); }
  bodies.set(req, parsed);
  return parsed;
};
const people = (w: { owners?: unknown; members?: unknown }) => {
  const [owners, members] = [w.owners, w.members].map(list => {
    if (!isPeople(list)) throw new HttpError(400, `owners and members are lists of emails and Entra group ids: ${JSON.stringify(list)}`);
    return [...new Set(list.map(p => p.toLowerCase()))];
  });
  return [owners, members.filter(p => !owners.includes(p))];
};

// Workspaces, series and instances, by id. Renaming a workspace or a series edits .rf/tree.json, so it may happen mid-run; a run sees
// the new names from its next start.
// Instance controls order per instance; authority changes and initiation order per series.
const actionQueue = new Map<string, Promise<void>>();
function inOrder<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (actionQueue.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => {}, () => {}).then(() => { if (actionQueue.get(id) === tail) actionQueue.delete(id); });
  actionQueue.set(id, tail);
  return next;
}

function changeAuthority(sid: string, settings: SeriesSettings, actor?: string): Promise<void> {
  saveSeriesSettings(seriesDir(sid), settings, actor);
  return retireSeries(sid);
}

function withdrawOwner(email: string): Promise<void[]> {
  return Promise.all(Object.keys(tree().series).flatMap(sid => {
    const { consent, ...settings } = seriesSettings(seriesDir(sid));
    return settings.owner === email ? [changeAuthority(sid, { ...settings, epoch: settings.epoch + 1, since: new Date().toISOString() })] : [];
  }));
}

async function interrupt(inst: Instance, a: Active | undefined, me: Me) {
  const t = tree();
  if (ownerOf(inst).by !== me.email && !canManage(me, t.workspaces[t.series[inst.seriesId].workspace]))
    throw new HttpError(403, `only its series owner, ${ownerOf(inst).by}, the workspace's owners and admins stop its run`);
  if (!a?.run) throw new HttpError(409, a ? 'its run is starting: try again in a moment' : 'no run going');
  a.stopped = true;
  inst.append(me.email, 'interrupt');
  await interruptRun(a);
}

// The system monitor (monitor.ts), admins' alone, as rf top and rf kill show it: the runs going, by their sandboxes, sampled once
// for all who ask at the same time; and a process of a run killed, logged in its instance first, which its agent hears of once it
// has ended. A run is stopped as Interrupt stops it.
const sandboxes = (): Sandbox[] => {
  const t = tree();
  return [...active.values()].flatMap(a => (a.run?.pid ? [{
    pid: a.run.pid, instance: a.inst.id, path: `${named(t, a.inst.seriesId)}/${a.inst.label}`, run: a.n, runner: a.runner,
    since: a.inst.log.findLast(e => e.op === 'run' && e.run === a.n)?.at ?? '', token: a.token,
  }] : []));
};
let sampling: Promise<Monitor> | undefined;
async function monitor(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (process.platform !== 'linux') throw new HttpError(501, 'the system monitor reads /proc, which only Linux has');
  const at = url.pathname.slice('/monitor'.length);
  if (!at && req.method === 'GET') return send(res, 200, await (sampling ??= sample(sandboxes()).finally(() => { sampling = undefined; })));
  if (at === '/kill' && req.method === 'POST') {
    const { pid, start: given } = await json(req);
    if (!Number.isInteger(pid) || (given !== undefined && !Number.isInteger(given))) throw new HttpError(400, 'pid, and start if given: whole numbers, as rf top shows a process');
    // Without its start, the process the PID names now: it must still be a run's, and not the sandbox's own.
    const start = given ?? startOf(pid), { box, script } = find(pid, start, sandboxes()), inst = instance(box.instance);
    inst.append(me.email, 'kill', { run: box.run, pid, script });
    const killed = await killTree(pid, start, { box });
    if (active.get(inst.seriesId)?.inst === inst) kick(inst);
    return send(res, 200, { ...killed, path: box.path, run: box.run, script });
  }
  throw new HttpError(404, 'not found');
}

async function api(me: Caller, req: IncomingMessage, res: ServerResponse, url: URL) {
  let [kind, id = '', action, other = '', ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  // A run reads and writes its own instance's screen and threads, commits its folder, sets wakes, corrects closed instances and leaves
  // notes in other open ones and on series in its own workspace, and finds what a folder it can read names; nothing else here.
  const run = me.run;
  if (action === 'note-state') throw new HttpError(404, 'not found');
  const unified = url.pathname === '/api/messages' && req.method === 'POST';
  const legacy = kind === 'series' && action === 'notes' || kind === 'instances' && ['comment', 'signoff', 'reject', 'withdraw'].includes(action);
  if (legacy && (rest.length || kind === 'instances' && other || kind === 'series' && other && req.method !== 'POST')) throw new HttpError(404, 'not found');
  if (legacy && !(req.method === 'POST' || kind === 'series' && req.method === 'GET')) throw new HttpError(405, 'POST only');
  const writing = unified || legacy && req.method === 'POST';
  if (run && url.pathname === '/api/messages' && req.method === 'GET' && url.searchParams.get('mine') === '1') {
    const t = tree(), ws = posix.dirname(posix.dirname(run.view.instance));
    const paths = new Map(Object.entries(run.view.names).map(([path, id]) => [id, path]));
    return send(res, 200, Object.entries(run.view.series).filter(([path, id]) => posix.dirname(path) === ws && t.series[id]?.workspace === run.workspace)
      .flatMap(([path, id]) => seriesConversation(id).notes.filter(n => n.by === 'agent' && n.run === run.n && n.runner === run.runner
        && (n.see as { inst?: string } | undefined)?.inst === run.inst.id && (!n.anchor || paths.has(n.anchor.inst)))
        .map(n => ({ ...n, path: (n.anchor ? paths.get(n.anchor.inst)! : path).slice('/work/'.length) }))));
  }
  if (run && !unified && !(kind === 'instances' && id === run.inst.id && ['screen', 'commit', 'withdraw'].includes(action)) && !(kind === 'instances' && ['comment', 'correct'].includes(action)) && !(kind === 'wakes' && ['PUT', 'DELETE'].includes(req.method!)) && !(kind === 'series' && action === 'notes' && ['GET', 'POST'].includes(req.method!)) && kind !== 'resolve')
    throw new HttpError(404, 'not found');
  // The body before the tree: a request held open must not save a tree from before others' changes, such as an owner's removal.
  const payload = ['upload', 'attach', 'screen'].includes(action) ? {} : await json(req);
  if (run && running(run.token) !== run) throw new HttpError(409, 'its run has ended');
  if (writing) {
    recheckRequest(req);
    messageWrites.add(req);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'a message is an object');
  }
  // Installed v0.19.2 clients still use the old public routes. Convert their URL scope to the same message fields.
  if (legacy && writing) {
    if (kind === 'series') {
      payload.series = id;
      delete payload.instance;
      if (other) {
        if (!/^n[1-9]\d*$/.test(other) || !['taken', 'aside'].includes(payload.how)) throw new HttpError(400, 'name a note and how to settle it');
        Object.assign(payload, { id: other, see: payload.thread ?? undefined, thread: undefined });
      }
    } else {
      payload.instance = id;
      delete payload.series;
      if (action !== 'comment') Object.assign(payload, { id: payload.thread, how: action === 'signoff' ? 'approve' : action === 'withdraw' ? 'withdrawn' : 'reject' });
    }
  }
  if (writing) {
    const inst = payload.instance, sid = payload.series;
    if ((inst === undefined) === (sid === undefined) || typeof (inst ?? sid) !== 'string' || !/^[\w-]+$/.test(inst ?? sid))
      throw new HttpError(400, 'name exactly one instance or series id');
    id = inst ?? sid;
    kind = inst === undefined ? 'series' : 'instances';
    const { how, dismiss } = payload;
    if (how !== undefined || dismiss !== undefined) {
      other = payload.id;
      if (typeof other !== 'string' || !/^[cn][1-9]\d*$/.test(other)) throw new HttpError(400, 'name a comment cN or a note nN');
      if (other[0] === 'c' && inst === undefined) throw new HttpError(400, 'cN needs its instance');
      if (dismiss !== undefined ? (how !== undefined || !['open', 'settled'].includes(dismiss)) : !['approve', 'reject', 'taken', 'aside', 'withdrawn'].includes(how))
        throw new HttpError(400, 'invalid message decision');
      if (['approve', 'reject', 'withdrawn'].includes(how)) {
        if (other[0] !== 'c') throw new HttpError(400, 'only a question or proposal can be decided or withdrawn');
        if (how === 'withdrawn' ? run?.inst.id !== inst : !!run) throw new HttpError(403, 'a run withdraws its own asks; people approve or reject');
        action = how === 'approve' ? 'signoff' : how === 'withdrawn' ? 'withdraw' : 'reject';
        payload.thread = other;
      } else action = 'note-state';
    } else {
      if (payload.id !== undefined) throw new HttpError(400, 'a new message has no id yet');
      if (payload.ask !== undefined && !run) throw new HttpError(403, 'only a run asks or proposes');
      if (kind === 'series' && [payload.ask, payload.to, payload.item, payload.ref, payload.thread, payload.for].some(v => v !== undefined))
        throw new HttpError(400, 'a series comment is not an ask, proposal, or reply on an item');
      action = kind === 'series' ? 'notes' : 'comment';
    }
  }
  const t = tree(), by = me.email;
  const about = t.series[kind === 'instances' ? instance(id).seriesId : kind === 'series' ? id : ''];
  if (!run && ((kind === 'instances' && ['assign', 'takeover', 'assignees', 'logins'].includes(action)) || (kind === 'series' && id && !action && req.method === 'PUT' && ('share' in payload || 'logins' in payload)))) {
    mustSee(me, about && t.workspaces[about.workspace]);
    throw new HttpError(410, 'instance assignment, instance credentials and series sharing were removed; use the explicit series owner and credentials endpoints');
  }
  // A run acts on an instance or a series in its own workspace alone, and learns nothing of one elsewhere by trying.
  if (run && (kind === 'instances' || kind === 'series') && about?.workspace !== t.series[run.inst.seriesId].workspace)
    throw new HttpError(403, `that ${kind === 'series' ? 'series' : 'instance'} is in another workspace: you can read it if it lets you, not act there`);
  // Archived, a workspace or a series takes nothing but being restored, a PUT of {"archived": false} alone, and an instance's deletion,
  // as what shouldn't be kept may be in one: nothing else in it changes, and none of its instances runs.
  const within = t.workspaces[kind === 'workspaces' ? id : about ? about.workspace : kind === 'series' ? payload.workspace : ''];
  const shut = [within, about].find(x => x?.archived);
  const restore = req.method === 'PUT' && !action && kind !== 'instances' && Object.keys(payload).join() === 'archived' && payload.archived === false;
  if (shut && req.method !== 'GET' && !restore && !(kind === 'instances' && action === 'delete')) {
    if (!run) mustSee(me, within);
    throw new HttpError(409, `${shut.name} is archived: nothing in it changes until it's restored`);
  }
  if (action === 'note-state') {
    const on = other[0] === 'c' ? instance(id) : undefined, sid = kind === 'series' ? id : instance(id).seriesId;
    const s = t.series[sid];
    if (!s) throw new HttpError(404, 'no such series');
    const w = t.workspaces[s.workspace];
    if (!run) mustSee(me, w);
    if (run && (run.inst.seriesId !== sid || on && run.inst !== on)) throw new HttpError(403, 'a run settles notes on its series or own instance');
    mustKeepNotes(sid, s);
    const dir = seriesDir(sid), settings = seriesSettings(dir), thread = seriesConversation(sid, undefined, settings.epoch);
    const note = thread.notes.find(n => n.id === other && n.anchor?.inst === on?.id);
    if (!note) throw new HttpError(404, `no open or settled note ${other}`);
    const { how, text, see: link, dismiss } = payload;
    if (dismiss !== undefined) {
      if (run || !notices([note], thread.dismissed, by, settings.owner, s.name).some(n => n.kind === dismiss))
        throw new HttpError(404, 'this notice does not wait on you');
      appendMessage(dir, on ? { instance: on.id } : {}, { seq: note.seq, by, at: new Date().toISOString(), op: 'dismiss-note', on: note.seq, notice: dismiss });
      return send(res, 200, 'dismissed');
    }
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'say what changed or why it was set aside');
    if (note.settled) throw new HttpError(409, `${other} is settled already`);
    if (run ? run.runner !== settings.owner : !(settings.owner === by || canManage(me, w)))
      throw new HttpError(403, 'the series owner, its runs and workspace managers settle notes');
    if (note.request || note.proposal) throw new HttpError(409, 'a request settles only when its owner decides its proposal');
    if (link !== undefined && (!run || !commentAt(run.inst.log, link))) throw new HttpError(400, 'see must name a comment in your own run’s instance');
    post({ op: how, book: dir, inst: on, by, text, on: note, thread: link, run });
    return send(res, 200, `${other} ${how === 'taken' ? 'taken' : 'set aside'}`);
  }
  if (kind === 'resolve') {
    if (!run) throw new HttpError(404, 'not found');
    const target = resolveFor(run, url.searchParams.get('path') ?? '');
    if (!t.series[target]) {
      const targetInst = instance(target);
      if (targetInst.hole) throw new HttpError(404, `${targetInst.label} was deleted`);
    }
    return send(res, 200, { id: target, kind: t.series[target] ? 'series' : 'instance' });
  }
  if (kind === 'workspaces' && !id && req.method === 'POST') {
    if (!can(me, 'create')) throw new HttpError(403, 'making a workspace is for admins and those they grant create: ask an admin');
    const name = folderName(String(payload.name ?? ''));
    if (Object.values(t.workspaces).some(w => w.name === name)) throw new HttpError(409, `the name ${name} is taken; choose another`);
    const wid = newId();
    t.workspaces[wid] = { name, owners: [me.email], members: [] };
    saveTree(t);
    return send(res, 200, { id: wid });
  }
  if (kind === 'workspaces' && action === 'people') {
    const w = mustSee(me, t.workspaces[id]);
    if (!canManage(me, w)) throw new HttpError(403, "only the workspace's owners and admins see its people");
    const us = users(), open = Object.keys(t.series).filter(sid => t.series[sid].workspace === id).flatMap(sid => instances(sid).filter(i => i.doc.status === 'open'));
    return send(res, 200, [...w.owners.map(who => ({ who, as: 'owner' })), ...w.members.map(who => ({ who, as: 'member' }))].map(p => ({
      ...p, last_login: us[p.who]?.last_login ?? null, series: Object.entries(t.series).filter(([sid, s]) => s.workspace === id && seriesSettings(seriesDir(sid)).owner === p.who).map(([, s]) => s.name), runs: open.filter(i => ownerOf(i).by === p.who).map(i => `${t.series[i.seriesId].name}/${i.label}`),
    })));
  }
  // A workspace's managers let another workspace they see read it, and its managers or the other's take that off. What its agents
  // read, that one's people see, whoever they are; taking it off takes effect on the next run (an operator can still interrupt a live run).
  if (kind === 'workspaces' && action === 'readers') {
    const w = t.workspaces[id], o = t.workspaces[other];
    if (req.method === 'PUT') {
      if (!canManage(me, mustSee(me, w))) throw new HttpError(403, "only the workspace's owners and admins let another workspace's agents read it");
      mustSee(me, o);
      if (other === id) throw new HttpError(400, "a workspace's agents read it already");
      w.readers = [...new Set([...(w.readers ?? []), other])];
    } else if (req.method === 'DELETE') {
      if (!w || !o || !(canManage(me, w) || canManage(me, o))) throw new HttpError(404, 'no such workspaces you manage');
      w.readers = (w.readers ?? []).filter(x => x !== other);
    } else throw new HttpError(405, 'PUT or DELETE');
    saveTree(t);
    return send(res, 200, 'ok');
  }
  if (kind === 'workspaces' && req.method === 'PUT') {
    const w = mustSee(me, t.workspaces[id]);
    if (!canManage(me, w)) throw new HttpError(403, "only the workspace's owners and admins change it");
    const change = payload;
    if (change.name !== undefined) {
      const name = folderName(String(change.name));
      if (name !== w.name && Object.values(t.workspaces).some(x => x.name === name)) throw new HttpError(409, `the name ${name} is taken; choose another`);
      w.name = name;
    }
    // One person or Entra group added, as an owner or a member, or removed, changes the people as they are now, so it undoes no one
    // else's change; owners and members replace either list whole, as rf people --set does.
    const one = change.add ?? change.remove;
    if (one !== undefined || change.owners !== undefined || change.members !== undefined) {
      const before = hidden(t, users()), p = String(one).toLowerCase(), now = { owners: w.owners.filter(x => x !== p), members: w.members.filter(x => x !== p) };
      if (change.add !== undefined) now[change.as === 'owner' ? 'owners' : 'members'].push(p);
      [w.owners, w.members] = people({ ...(one === undefined ? w : now), ...change });
      guard(before, hidden(t, users()), change.force);
    }
    // Whoever manages a workspace labels its Entra groups, for everyone who sees one of them.
    for (const [g, label] of Object.entries(change.groups ?? {})) {
      if (g.includes('@') || !everyone(w).includes(g) || typeof label !== 'string' || !label.trim() || label.includes('@')) throw new HttpError(400, `a label is some text, without an @, for an Entra group in this workspace: not ${g}: ${JSON.stringify(label)}`);
      (t.groups ??= {})[g] = label.trim();
    }
    // Archived, it does no work: a run going in it ends first, and what waited for one as it was archived runs once it's restored.
    const its = Object.keys(t.series).filter(sid => t.series[sid].workspace === id), going = change.archived && its.map(sid => active.get(sid)).find(a => a);
    if (going) throw new HttpError(409, `${named(t, going.inst.seriesId)}/${going.inst.label} is running: archive ${w.name} once its run ends, or interrupt it first`);
    const closing = change.archived && its.flatMap(instances).find(i => i.closing);
    if (closing) throw new HttpError(409, `${named(t, closing.seriesId)}/${closing.label} is closing: archive ${w.name} once it finishes`);
    if (change.archived !== undefined) w.archived = !!change.archived;
    if (change.archived) {
      cancelWakes(its.flatMap(sid => [sid, ...labels(sid).map(l => l.id)]));
      cancelPendingOom(its.flatMap(instances), by);
    }
    if (change.agents !== undefined) replaceFile(agentsFile(id), String(change.agents));
    saveTree(t);
    pruneGrants();
    await closeUnlent();
    if (change.archived === false) for (const i of its.flatMap(instances)) kick(i);
    return send(res, 200, 'ok');
  }
  // A proposal to merge a workspace into another, or to move one of its series there, is the workspace's, by its id: whoever manages
  // it proposes and withdraws, and whoever manages the other accepts or declines, within a week. Neither may be archived, or in
  // another proposal. What moves, and who joins, is worked out as it's accepted: the series keep their ids, so their instances,
  // wakes and requests go with them, and their names, but for a number on a name the other has; execution consent is withdrawn.
  if (kind === 'proposals') {
    const a = t.workspaces[id], p = proposals(t).find(p => p.id === id);
    if (req.method === 'PUT') {
      const b = mustSee(me, t.workspaces[payload.to]);
      if (!canManage(me, mustSee(me, a))) throw new HttpError(403, "only the workspace's owners and admins propose to merge it or move its series");
      if (!(payload.kind === 'merge' || (payload.kind === 'move' && t.series[payload.series]?.workspace === id)) || b === a) throw new HttpError(400, 'PUT {"kind": "merge", "to"} or {"kind": "move", "series", "to"}: one of its series, into another workspace');
      const shut = [a, b, payload.kind === 'move' ? t.series[payload.series] : undefined].find(x => x?.archived);
      if (shut) throw new HttpError(409, `${shut.name} is archived`);
      const busy = proposals(t).find(p => [p.id, p.into].some(x => x === id || x === payload.to));
      if (busy) throw new HttpError(409, `${busy.from} has a proposal open, into ${busy.to}: until it's accepted, declined or withdrawn, or lapses a week on, neither takes another`);
      a.proposal = { kind: payload.kind, to: payload.to, ...(payload.kind === 'move' ? { series: payload.series } : { had: Object.keys(t.series).filter(sid => t.series[sid].workspace === id) }), by, at: new Date().toISOString() };
      saveTree(t);
      return send(res, 200, 'ok');
    }
    const b = p && t.workspaces[p.into];
    if (!b || !(canManage(me, a) || canManage(me, b))) throw new HttpError(404, 'no proposal open for this workspace');
    if (req.method === 'DELETE') return void (delete a.proposal, saveTree(t), send(res, 200, 'ok'));
    if (!canManage(me, b)) throw new HttpError(403, `the owners of ${b.name} accept it, or decline it`);
    const moving = p.kind === 'merge' ? Object.keys(t.series).filter(sid => t.series[sid].workspace === id) : [a.proposal!.series!];
    const move = (t: Tree) => moving.map(sid => {
      const from = named(t, sid);
      Object.assign(t.series[sid], { name: freeName(t, p.into, t.series[sid].name), workspace: p.into });
      return { id: sid, from, to: named(t, sid) };
    });
    // A move previews the owner even when the series has no open instance.
    const joining = p.kind === 'merge' ? everyone(a).filter(x => !everyone(b).includes(x))
      : moving.flatMap(sid => {
        const owner = seriesSettings(seriesDir(sid)).owner, q = owner && asPerson(owner);
        return owner && (!q || !canSee(q, b)) ? [owner] : [];
      });
    // What the one accepting sees first: for a merge, the series made since it was proposed marked so, and the AGENTS.md it adds.
    if (req.method === 'GET') return send(res, 200, {
      ...p, series: move(structuredClone(t)).map(s => ({ ...s, ...(a.proposal!.had && !a.proposal!.had.includes(s.id) && { since: true }) })), people: joining,
      ...(p.kind === 'merge' && { agents: text(agentsFile(id)) }),
    });
    if (req.method !== 'POST') throw new HttpError(405, 'GET it, POST {"owners", "members"} to accept it, or DELETE to withdraw or decline it');
    const shut = [a, b, p.kind === 'move' ? t.series[a.proposal!.series!] : undefined].find(x => x?.archived);
    if (shut) throw new HttpError(409, `${shut.name} is archived`);
    // Moving withdraws workspace-bound consent before waiting for retirement; the owner must consent again there.
    const [owners, members] = people(payload);
    const retirements = moving.map(sid => {
      const { consent, ...settings } = seriesSettings(seriesDir(sid));
      return changeAuthority(sid, { ...settings, epoch: settings.epoch + 1, since: new Date().toISOString() }, by);
    });
    const moved = move(t);
    b.owners = [...new Set([...b.owners, ...owners])];
    b.members = [...new Set([...b.members, ...members, ...(p.kind === 'merge' ? everyone(a) : [])])].filter(x => !b.owners.includes(x));
    if (p.kind === 'merge') {
      const add = text(agentsFile(id)), keep = text(agentsFile(p.into)).trimEnd();
      if (add) replaceFile(agentsFile(p.into), `${keep && `${keep}\n\n`}## ${a.name}\n\n${add}`);
      rmSync(agentsFile(id), { force: true });
      delete t.workspaces[id];
      forgetWorkspace(id);
      for (const o of Object.values(t.workspaces)) {
        o.readers &&= o.readers.filter(x => x !== id);
        if (o.proposal?.to === id) delete o.proposal;
      }
    } else {
      delete a.proposal;
      a.moved = [...(a.moved ?? []).filter(m => fresh(m.at)), { name: p.series!, to: moved[0].to, at: new Date().toISOString() }];
    }
    saveTree(t, by);
    await Promise.all(retirements);
    for (const m of moved) {
      if (t.series[m.id].single && instances(m.id)[0] && instances(m.id)[0].label !== t.series[m.id].name) renameInstance(instances(m.id)[0], t.series[m.id].name);
      for (const i of instances(m.id)) i.append(by, 'move', { from: m.from, to: m.to });
    }
    return send(res, 200, 'ok');
  }
  if (kind === 'series' && !id && req.method === 'POST') {
    // A series, or a task: a single series named Untitled, until its first prompt or a rename names it, and its one instance.
    const { workspace, name: asked, single, logins, autonomous = false } = payload;
    if (logins !== undefined && typeof payload.autonomous !== 'boolean') throw new HttpError(400, 'series credential selection requires an explicit autonomous boolean; update your client for whole-series consent');
    mustSee(me, t.workspaces[workspace]);
    if (typeof autonomous !== 'boolean' || (autonomous && logins === undefined)) throw new HttpError(400, 'autonomous consent requires an explicit credential selection and a boolean');
    const name = single ? freeName(t, workspace, 'Untitled') : folderName(String(asked ?? ''));
    if (Object.values(t.series).some(s => s.workspace === workspace && s.name === name)) throw new HttpError(409, `${name} exists`);
    const ticks = logins === undefined ? undefined : checkTicks(by, logins, workspace), sid = newId(), at = new Date().toISOString();
    t.series[sid] = { name, workspace, ...(single && { single: true }) };
    mkdirSync(seriesDir(sid));
    saveSeriesSettings(seriesDir(sid), { version: 1, owner: by, epoch: 1, since: at, ...(ticks && { consent: { by, at, workspace, logins: ticks, autonomous } }) });
    saveTree(t);
    try {
      return send(res, 200, { id: sid, ...(single && { instance: createInstance(sid, name, by).id }) });
    } catch (e) {
      delete t.series[sid];
      saveTree(t);
      rmSync(seriesDir(sid), { recursive: true, force: true });
      throw e;
    }
  }
  if (kind === 'series') {
    const s = t.series[id];
    if (!run) mustSee(me, s && t.workspaces[s.workspace]);
    if (action === 'owners' && req.method === 'GET') return send(res, 200, Object.keys(users()).filter(email => {
      const p = asPerson(email);
      return p && canSee(p, t.workspaces[s.workspace]);
    }));
    if (action === 'credentials' && req.method === 'GET') {
      const settings = seriesSettings(seriesDir(id));
      const { schedules, scheduleRevision } = seriesOwnerSchedules(id, s.name);
      return send(res, 200, { owner: settings.owner, epoch: settings.epoch, consent: settings.consent, schedules, scheduleRevision });
    }
    if (['owner', 'credentials'].includes(action) && req.method === 'PUT') return inOrder(id, async () => {
      recheckRequest(req);
      const { ws, who } = mustUnarchived(by, id, me), settings = seriesSettings(seriesDir(id)), at = new Date().toISOString();
      if (action === 'owner') {
        if (settings.owner !== by && !canManage(who, ws)) throw new HttpError(403, 'only the current series owner or a workspace manager transfers ownership');
        if ('logins' in payload || 'autonomous' in payload || 'consent' in payload) throw new HttpError(400, 'a transfer never grants credential consent; the new owner selects credentials separately');
        const to = typeof payload.owner === 'string' ? payload.owner.toLowerCase() : '', p = asPerson(to);
        if (!p || !canSee(p, ws)) throw new HttpError(400, 'the owner must be enabled and see the workspace');
        if (to === settings.owner) throw new HttpError(409, `${to} already owns this series`);
        await changeAuthority(id, { version: 1, owner: to, epoch: settings.epoch + 1, since: at }, by);
        return send(res, 200, 'ok');
      } else {
        if (settings.owner !== by) throw new HttpError(403, 'only the series owner selects credentials');
        if (!Array.isArray(payload.logins) || typeof payload.autonomous !== 'boolean') throw new HttpError(400, 'select logins explicitly, including [], and an autonomous boolean');
        const { schedules, scheduleRevision } = seriesOwnerSchedules(id, tree().series[id].name);
        if (payload.autonomous && schedules.length > 0 && (payload.expectedEpoch !== settings.epoch || payload.expectedSchedules !== scheduleRevision)) {
          return send(res, 409, { error: 'review the current series epoch and pending schedules before enabling autonomous runs', epoch: settings.epoch, schedules, scheduleRevision });
        }
        if (payload.expectedEpoch !== undefined && payload.expectedEpoch !== settings.epoch) {
          return send(res, 409, { error: 'series ownership or settings changed; review updated schedules and save again', epoch: settings.epoch, schedules, scheduleRevision });
        }
        if (payload.autonomous && payload.expectedSchedules !== undefined && payload.expectedSchedules !== scheduleRevision) {
          return send(res, 409, { error: 'pending schedules changed since you reviewed them; review updated schedules and save again', epoch: settings.epoch, schedules, scheduleRevision });
        }
        const ticks = checkTicks(by, payload.logins, tree().series[id].workspace), was = settings.consent;
        const removed = !!was && (was.logins.some(l => !ticks.includes(l)) || (was.autonomous && !payload.autonomous));
        const next = { ...settings, epoch: settings.epoch + (removed ? 1 : 0), since: removed ? at : settings.since, consent: { by, at, workspace: tree().series[id].workspace, logins: ticks, autonomous: payload.autonomous } };
        if (removed) await changeAuthority(id, next, by);
        else saveSeriesSettings(seriesDir(id), next);
        act(by, { op: 'credentials', series: id, epoch: next.epoch, autonomous: payload.autonomous, logins: ticks, ...(payload.autonomous && schedules.length ? { adoptedSchedules: schedules.map(k => k.id), scheduleRevision } : {}) });
        return send(res, 200, { ok: true, epoch: next.epoch, schedules, scheduleRevision });
      }
    });
    if (['owner', 'credentials', 'owners'].includes(action)) throw new HttpError(405, 'GET owners or credentials, or PUT owner or credentials');
    if (action === 'promote') {
      // A task made a series, as it is, under a name of its own, its one instance the series' first.
      if (!s.single) throw new HttpError(400, `${s.name} is a series already`);
      if (instances(id)[0].hole) throw new HttpError(409, `${s.name} was deleted`);
      const name = folderName(String(payload.name ?? ''));
      if (name !== s.name && Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
      delete s.single;
      saveTree(t);
      instances(id)[0].append(by, 'promote', { series: name });
      return send(res, 200, 'ok');
    }
    // A series or task takes comments even if nothing is running. Their attachments stay in the Notes view.
    const book = seriesDir(id);
    if (action === 'files' && req.method === 'GET') {
      const fd = openFile(join(book, 'notes', 'files'), other);
      if (fd === undefined) throw new HttpError(404, 'no such file');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(other)}` });
      return sendStream(createReadStream('', { fd }), res);
    }
    if (action === 'attach' && req.method === 'POST') {
      mustKeepNotes(id, s);
      const tmp = join(tmpDir, randomUUID());
      try {
        await pipeline(req, capped, createWriteStream(tmp));
        recheckRequest(req);
        mustUnarchived(by, id, me, !!run);
        mustKeepNotes(id);
        return send(res, 200, { file: keep(join(book, 'notes'), 'files', url.searchParams.get('name') ?? 'file', tmp) });
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    if (action === 'notes' && req.method === 'GET') return send(res, 200, seriesConversation(id).notes.filter(n => !n.anchor));
    if (action === 'notes' && req.method === 'POST') {
      mustKeepNotes(id, s);
      const { text, files = [], request } = payload;
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a note has text');
      if (!Array.isArray(files)) throw new HttpError(400, 'files is an array');
      if (request !== undefined && typeof request !== 'boolean') throw new HttpError(400, 'request must be true or false');
      for (const f of files) {
        const fd = typeof f === 'string' && /^files\/[^./][^/]*$/.test(f) ? openFile(join(book, 'notes'), f) : undefined;
        if (fd === undefined) throw new HttpError(400, `no attachment ${f}`);
        closeSync(fd);
      }
      const e = post({ op: 'note', book, by, text, files, request, run });
      noted(id);
      return send(res, 200, run ? `noted n${e.seq} on ${named(t, id)}, which its runs read` : { id: `n${e.seq}` });
    }
    if (s.single) throw new HttpError(400, `${s.name} is a task with one instance; promote it before creating more periods`);
    if (req.method === 'POST') return inOrder(id, async () => {
      recheckRequest(req);
      mustUnarchived(by, id, me);
      if ('logins' in payload) throw new HttpError(410, 'instance credentials were removed; only the owner selects the series credentials');
      return send(res, 200, { id: startWith(id, String(payload.label ?? ''), by, payload.quiet || seriesSettings(seriesDir(id)).owner !== by ? [] : [{ from: by }]).id });
    });
    if (req.method !== 'PUT') throw new HttpError(405, 'PUT, or POST a new instance');
    const change = payload;
    if (['owner', 'consent', 'epoch', 'autonomous'].some(k => k in change)) throw new HttpError(400, 'use the explicit series owner and credentials endpoints');
    if (change.name !== undefined && change.name !== s.name) {
      const name = folderName(String(change.name));
      if (Object.values(t.series).some(x => x.workspace === s.workspace && x.name === name)) throw new HttpError(409, `${name} exists`);
      s.name = name;
    }
    if (change.archived && active.has(id)) throw new HttpError(409, `${named(t, id)}/${active.get(id)!.inst.label} is running: archive ${s.name} once its run ends, or interrupt it first`);
    const closing = change.archived && instances(id).find(i => i.closing);
    if (closing) throw new HttpError(409, `${named(t, id)}/${closing.label} is closing: archive ${s.name} once it finishes`);
    if (change.archived !== undefined) s.archived = !!change.archived;
    if (change.archived) {
      cancelWakes([id, ...labels(id).map(l => l.id)]);
      cancelPendingOom(instances(id), by);
    }
    saveTree(t);
    if (change.archived === false) for (const i of instances(id)) kick(i);
    return send(res, 200, 'ok');
  }
  if (kind === 'wakes') {
    // People and runs set wakes, one-off or weekly, each with a short text if they like, and cancel them: PUT names the target, an
    // open instance, which the wake continues, or a series, which it starts LABEL of; DELETE names the wake. A run wakes only in its
    // own workspace: it reads others that let it, never acts there.
    const wake = req.method === 'DELETE' ? wakes().pending[id] : undefined, to = wake?.target ?? id, sid = t.series[to] ? to : instance(to).seriesId;
    if (req.method === 'DELETE' && !wake) throw new HttpError(404, 'no such wake pending');
    if (!run) mustSee(me, t.workspaces[t.series[sid].workspace]);
    else if (t.series[sid].workspace !== t.series[run.inst.seriesId].workspace) {
      const canRead = reads(t, t.series[run.inst.seriesId].workspace).includes(t.series[sid].workspace);
      if (req.method === 'DELETE' && !canRead) throw new HttpError(404, 'no such wake pending');
      throw new HttpError(403, canRead ? `${named(t, sid)} is in another workspace: you can read it, not wake it` : 'that is in another workspace: you can read it if it lets you, not wake it');
    } else if (sid !== run.inst.seriesId) {
      if (req.method === 'DELETE') throw new HttpError(403, 'runs can only cancel wakes in their own series');
      throw new HttpError(403, `${named(t, sid)} is another series: runs can only wake their own series`);
    }
    if (t.series[to]?.single) throw new HttpError(400, `${t.series[to].name} is a task, with one instance: wake that`);
    if (req.method === 'DELETE') {
      const owner = seriesSettings(seriesDir(sid)).owner;
      const mayCancel = run ? run.runner === owner && !!run.authority.autonomous : by === owner || canManage(me, t.workspaces[t.series[sid].workspace]);
      const ownRequest = !!wake!.request && (run ? wake!.inst === run.inst.id : wake!.from === by);
      if (!mayCancel && !ownRequest) throw new HttpError(403, 'only the series owner, a workspace manager, or its authorized autonomous run cancels this schedule');
      // A person's cancellation is theirs in the system's log; a run's is recorded there too, with the wake, its instance and run.
      if (run) act('agent', { method: 'DELETE', path: url.pathname, wake, inst: run.inst.id, run: run.n });
      if (!run && !t.series[to] && by === owner) see(by, to, instance(to).log.at(-1)!.seq);
      return void (cancelWake(id), send(res, 200, 'ok'));
    }
    const { at: when = '', label, days, text, check, deadline, maxStaleMin, backstopHours } = payload, w = String(when);
    const at = w === 'now' ? Date.now() : /^\+\d+[mhd]$/.test(w) ? Date.now() + Number(w.slice(1, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[w.at(-1) as 'm'] : Date.parse(w);
    if (req.method !== 'PUT' || Number.isNaN(at)) throw new HttpError(400, 'PUT {"at", "label" for a series, "days", "text"}, or DELETE; at is now, +<n>m|h|d, or a date and time such as 2026-09-14T07:00+08:00');
    if (text != null && (typeof text !== 'string' || text.length > 500)) throw new HttpError(400, "a wake's text is a short message, 500 characters at most");
    if (check !== undefined && (typeof check !== 'string' || check.length > 500 || !/^working\/[^\\\x00-\x1f\x7f]+\.(py|ts)$/.test(check)
      || check.split('/').some(p => !p || p === '.' || p === '..')))
      throw new HttpError(400, 'check: name one .py or .ts file under working/');
    const until = typeof deadline === 'string' && /^\d{4}-\d{2}-\d{2}T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(deadline) ? Date.parse(deadline) : NaN;
    if (deadline !== undefined && (!check || !Number.isFinite(until) || until <= at))
      throw new HttpError(400, 'deadline: a timestamp with its offset, after the scheduled wake and only with a check');
    const parsedMaxStale = typeof maxStaleMin === 'number' ? maxStaleMin
      : typeof maxStaleMin === 'string' && /^\d+$/.test(maxStaleMin) ? Number(maxStaleMin) : NaN;
    if (maxStaleMin !== undefined && (!check || !Number.isSafeInteger(parsedMaxStale) || parsedMaxStale < 1 || parsedMaxStale > 10_080))
      throw new HttpError(400, 'maxStaleMin: an integer from 1 to 10080 minutes, and only with a check');
    const parsedBackstop = typeof backstopHours === 'number' ? backstopHours
      : typeof backstopHours === 'string' && /^\d+$/.test(backstopHours) ? Number(backstopHours) : NaN;
    if (backstopHours !== undefined && (!check || !Number.isSafeInteger(parsedBackstop) || parsedBackstop < 1 || parsedBackstop > 168))
      throw new HttpError(400, 'backstopHours: an integer from 1 to 168 hours, and only with a check');
    if (archived(t, sid)) throw new HttpError(409, `${named(t, sid)} is archived`);
    if (t.series[to] && !label) throw new HttpError(400, `waking a series starts a new instance: name it with a label${run ? '; to wake your own instance, name its folder: .' : ''}`);
    if (!t.series[to] && instance(to).doc.status !== 'open') throw new HttpError(409, `${instance(to).label} is ${instance(to).doc.status}: to record a correction on a closed instance, use rf correct --superseded (or Correct… on its page)`);
    const first = new Date(at), starts = t.series[to] ? folderName(String(label)) : undefined;
    if (starts && labels(to).some(l => l.label === starts && instance(l.id).hole)) throw new HttpError(409, `${starts} was deleted, and its label stays with it: choose another`);
    if (!run && check && !can(me, 'wake-check'))
      throw new HttpError(403, 'a wake check needs a scheduled wake of your own series, autonomous consent, and the wake-check capability');
    const created = setWake(to, {
      at: first.toISOString(), from: run ? `${named(t, run.inst.seriesId)}/${run.inst.label}` : by, ...(run && { inst: run.inst.id }),
      ...(starts && { label: starts }), ...(days !== undefined && { days: weekly(String(days), first, starts) }), ...(text?.trim() && { text: text.trim() }),
      ...(check && { check }), ...(deadline !== undefined && { deadline: new Date(until).toISOString() }),
      ...(maxStaleMin !== undefined && { maxStaleMin: parsedMaxStale }),
      ...(backstopHours !== undefined && { backstopHours: parsedBackstop }),
    }, run ? undefined : me);
    if (run) act('agent', { method: 'PUT', path: url.pathname, wake: wakes().pending[created.id], inst: run.inst.id, run: run.n });
    if (!run && !t.series[to] && by === seriesSettings(seriesDir(sid)).owner) see(by, to, instance(to).log.at(-1)!.seq);
    return send(res, 200, created);
  }
  // Only the current owner starts a request. Its provenance stays a note beside that owner's explicit act.
  if (kind === 'requests') {
    const r = wakes().requests[id];
    if (!r) throw new HttpError(404, `no request ${id}`);
    mustSee(me, t.workspaces[t.series[r.series].workspace]);
    if (req.method === 'POST') return inOrder(r.series, async () => {
      recheckRequest(req);
      mustUnarchived(by, r.series, me);
      const settings = seriesSettings(seriesDir(r.series));
      if (!wakes().requests[id]) throw new HttpError(404, `no request ${id}`);
      if ('logins' in payload) throw new HttpError(410, 'request credentials were removed; the owner selects the series credentials separately');
      if (settings.owner !== by) throw new HttpError(403, 'only the current series owner starts requests');
      if (!settings.consent || settings.consent.by !== by || settings.consent.workspace !== tree().series[r.series].workspace) throw new HttpError(403, 'the owner must explicitly select series credentials first, including an empty selection');
      const quiet = !!payload.quiet, provenance = { from: r.from, text: r.text, inst: r.inst, note: true, quiet };
      const inst = r.target ? wakeWith(instance(r.target), [provenance, { from: by, quiet }])
        : startWith(r.series, r.label, by, [provenance, { from: by, quiet }]);
      dropRequest(id, by, 'started');
      see(by, inst.id, inst.log.at(-1)!.seq);
      if (r.target) res.setHeader('X-RF-Woke', '1');
      return send(res, 200, { id: inst.id });
    });
    if (req.method !== 'DELETE') throw new HttpError(405, 'POST to start it, or DELETE');
    dropRequest(id, by, 'dismissed');
    return send(res, 200, 'ok');
  }
  if (kind !== 'instances') throw new HttpError(404, 'not found');
  const inst = instance(id);
  if (!run) mustSee(me, t.workspaces[t.series[inst.seriesId].workspace]);
  const a = active.get(inst.seriesId);
  const mine = a?.inst === inst ? a : undefined;
  if (!action && !verifyOnly) see(by, inst.id, inst.log.at(-1)!.seq);
  // Each entry's standing, by its seq, a note's entry saying note too; and whether a comment of yours would start a run now.
  const said = !action && new Map(inst.log.flatMap(e => { const s = standing(inst, e); return s ? [[e.seq, s.word]] : []; }));
  if (said) {
    const s = t.series[inst.seriesId], who = owner(inst), discussion = seriesConversation(inst.seriesId, undefined, who.epoch);
    const on = discussion.notes.filter(n => n.anchor?.inst === inst.id), own = discussion.notes.filter(n => !n.anchor || n.anchor.inst === inst.id);
    return send(res, 200, { doc: inst.doc, wakeCheck: wakeCheckStatus(inst), log: inst.log.map(e => said.get(e.seq) === 'note' ? { ...e, note: true } : e), standing: Object.fromEntries(said),
      starts: inst.doc.status === 'open' && standing(inst, { seq: inst.log.length + 1, at: '', by, op: 'comment' })!.starts,
      run: mine ? { n: mine.n, cost: +mine.cost.toFixed(6), ...(mine.estimated && { estimated: true }), browsers: [...(mine.browsers?.watchable().keys() ?? [])], yours: mine.browsers?.yours(by) ?? [] } : null,
      queued: !!queued(inst), owner: who, previous: await previous(inst), sums: Object.fromEntries(await Promise.all(inst.doc.items.filter(i => i.file).map(async i => [i.id, await sha256(inst.dir, i.file!)]))),
      waiting: waits(inst, s.workspace).filter(({ e }) => e.op === 'comment').map(({ who, e }) => ({ who, seq: e.seq })),
      staleProposals: inst.log.filter(e => e.op === 'comment' && e.by === 'agent' && (e.ask === 'proposal' || e.ask === true)
        && !currentMessage(inst.log, e, who)).map(e => e.seq),
      noteStates: Object.fromEntries(on.map(n => [n.id, { op: n.settled?.op ?? 'open', ...(n.settled && { text: n.settled.text }), ...(n.request && { request: true }), ...(n.proposal && { proposal: n.proposal }) }])),
      noteNotices: inst.doc.status === 'open' && !archived(t, inst.seriesId) ? notices(own, discussion.dismissed, by, who.by, s.name).filter(n => n.kind === 'open') : [],
      held: [...new Set(inst.log.filter(e => e.op === 'expired').map(e => e.login as string))].filter(l => held(inst, l, who.by)) });
  }
  if (action === 'trace') return send(res, 200, trace(inst));
  if (action === 'summary') {
    const settings = seriesSettings(inst.series()), s = t.series[inst.seriesId], discussion = seriesConversation(inst.seriesId, undefined, settings.epoch);
    const instance = summary(inst, me, s.workspace, undefined, settings);
    return send(res, 200, { ...instance, seriesNotes: { notes: openNotes(discussion.notes).length,
      noteNotices: archived(t, inst.seriesId) ? [] : notices(discussion.notes, discussion.dismissed, by, settings.owner, s.name) } });
  }
  // The screen: anyone who sees the instance reads it; only its own run writes it.
  if (action === 'screen' && req.method === 'GET') return send(res, 200, inst.doc);
  if (action === 'screen' && req.method === 'PUT' && run) {
    const text = (await body(req)).toString();
    if (running(run.token) !== run) throw new HttpError(409, 'its run has ended');
    return send(res, 200, `saved, rev ${inst.put(text, run.n)}`);
  }
  if (action === 'screen') throw new HttpError(405, "GET, or PUT by the instance's own run");
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (inst.doc.status === 'deleted') throw new HttpError(409, `${inst.label} was deleted: nothing is left of it but its place in its series`);
  if (action === 'delete') {
    // Whoever manages its workspace deletes an instance, in any status, people only: what's going for it is cut, and all the server
    // holds of it goes, but its id, label and place in its series, and who deleted it and when, with what its runs cost, for the
    // totals (waker.ts remove()); the system's log records it.
    if (!canManage(me, t.workspaces[t.series[inst.seriesId].workspace])) throw new HttpError(403, "only the workspace's owners and admins delete an instance");
    await remove(inst, by, () => {
      const wakeChecks = wakeChecksOf(inst).map(({ message, ...r }) => r);
      return { cost: costOf(inst), ...(estimatedOf(inst) && { estimated: true }), runs: cachedRunsOf(inst).map(({ started, error, ...r }) => r),
        ...(wakeChecks.length && { wakeChecks }) };
    });
    for (const p of readdirSync(previews)) if (p.startsWith(inst.id + '-')) rmSync(join(previews, p));
    for (const k of sums.keys()) if (k.startsWith(inst.dir + sep)) sums.delete(k);
    return send(res, 200, 'ok');
  }
  if (action === 'rename') {
    // In any status, and mid-run: a run keeps the names it started with (view()).
    const from = inst.label, s = t.series[inst.seriesId], to = folderName(url.searchParams.get('as') ?? '');
    // A task's name is its label.
    if (s.single && to !== s.name && Object.values(t.series).some(x => x.workspace === s.workspace && x.name === to)) throw new HttpError(409, `${to} exists`);
    renameInstance(inst, to);
    if (s.single) {
      s.name = to;
      saveTree(t);
    }
    inst.append(by, 'rename', { from });
    return send(res, 200, 'ok');
  }
  if (action === 'correct') {
    // On an item, at a ref if given, or on the instance; a run's links its own instance, a person's the instance and thread they name.
    const { kind: k, item, ref, text, thread } = payload, see = run ? run.inst : payload.see ? instance(String(payload.see)) : undefined;
    if (inst.doc.status !== 'closed') throw new HttpError(409, `${inst.label} is ${inst.doc.status}: only a closed instance takes corrections, as nothing else changes it`);
    if (see && !run) mustSee(me, t.workspaces[t.series[see.seriesId].workspace]);
    if (see?.hole) throw new HttpError(409, `${see.label} was deleted`);
    if (see && !run && (see.seriesId !== inst.seriesId || see === inst)) throw new HttpError(400, `${see.label} is not another instance in ${t.series[inst.seriesId].name}`);
    if (!['wrong', 'superseded'].includes(k) || typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a correction is {"kind": "wrong" or "superseded", "text", "item", "ref", "see", "thread"}');
    if (item != null && !inst.doc.items.some(i => i.id === item)) throw new HttpError(400, `no item ${item}; ${inst.label}'s items: ${inst.doc.items.map(i => i.id).join(', ')}`);
    if (thread != null && !see?.threads().includes(thread)) throw new HttpError(400, `no thread ${thread} in ${see?.label ?? 'the instance it names'}`);
    const e = correct(inst, by, { kind: k, ...(item != null && { item }), ...(ref && { ref: String(ref) }), text: text.trim(), ...(see && { see }), ...(thread != null && { thread }), ...(run && { run: run.n }) });
    return send(res, 200, `${inst.label}${item ? ` ${item}` : ''} is marked ${k}, seq ${e.seq}`);
  }
  if (action === 'react' && !run) {
    // A person's thumbs up or down on a comment, or with no on on the instance, closed or not; null takes it back. It starts nothing:
    // a signal kept for later, which the next run reads with the rest.
    const { on, up } = payload;
    if (![true, false, null].includes(up)) throw new HttpError(400, 'up is true, false or null');
    if (on !== undefined && !inst.log.some(e => e.seq === on && e.op === 'comment')) throw new HttpError(400, `no comment at seq ${on}`);
    inst.append(by, 'react', { ...(on !== undefined && { on }), up });
    return send(res, 200, 'ok');
  }
  if (inst.doc.status !== 'open') throw new HttpError(409, `instance is ${inst.doc.status}`);
  // A quiet act, by quiet in its body or, for an upload, in its query, starts nothing: its entry says so, and its next run reads it.
  const quiet = action === 'upload' ? url.searchParams.has('quiet') : !!payload.quiet;
  if (action === 'attach') {
    // A comment's attachment, kept in upload/attachments/ and named in the comment that follows; it starts nothing by itself.
    const tmp = join(tmpDir, randomUUID());
    try {
      await pipeline(req, capped, createWriteStream(tmp));
      recheckRequest(req);
      mustUnarchived(by, inst.seriesId, me, !!run);
      const file = inst.keep(url.searchParams.get('name') ?? 'file', tmp, 'upload/attachments');
      // No entry of the instance's names it until a comment does: the system's log records it, and it's committed at once in its
      // person's name, unless a run of the instance is going, whose end commits it.
      act(by, { op: 'attach', instance: inst.id, file });
      if (active.get(inst.seriesId)?.inst !== inst) commit(inst.dir, me, `Attach ${file}`).catch(err => inst.append('server', 'commit', { error: err.message }));
      return send(res, 200, { file });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (action === 'upload') {
    const pane = url.searchParams.get('pane') === 'out' ? 'out' : 'in', tmp = join(tmpDir, randomUUID()), hash = createHash('sha256');
    try {
      await pipeline(req, capped, async function* (chunks: AsyncIterable<Buffer>) { for await (const c of chunks) { hash.update(c); yield c; } }, createWriteStream(tmp));
      recheckRequest(req);
      mustUnarchived(by, inst.seriesId, me, !!run);
      const up = inst.upload(by, url.searchParams.get('name') ?? 'file', tmp, hash.digest('hex'), pane, url.searchParams.get('onto'), quiet);
      // What starts no run, quiet or a note, is committed at once in its person's name; a run going commits it as it ends.
      if (!standing(inst, up)!.starts && active.get(inst.seriesId)?.inst !== inst) commit(inst.dir, me, `Upload ${up.file}`).catch(err => inst.append('server', 'commit', { cause: up.seq, error: err.message }));
    } finally {
      rmSync(tmp, { force: true });
    }
  } else if (action === 'comment') {
    // A comment starts a thread, on an item (at a ref, such as a cell, if given) or on the instance, or replies under one of its
    // comments, which `thread` names by its seq, as cN, a thread's own id its first comment's. A person's starts a run, unless quiet.
    // The agent's starts nothing; its questions and proposals wait on their named person or the owner.
    const { thread, item, ref, text, files = [], ask, to, request, for: noteFor } = payload, under = commentAt(inst.log, thread);
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a comment has text');
    if (ask !== undefined && !['question', 'proposal'].includes(ask)) throw new HttpError(400, 'ask is "question" or "proposal"');
    if (thread !== undefined && !under) throw new HttpError(400, `no comment ${thread} to reply under; this instance's threads: ${inst.threads().join(', ') || 'none yet'}`);
    if (thread === undefined && ref != null && typeof ref !== 'string') throw new HttpError(400, 'ref must be a string');
    if (thread === undefined && item != null && !inst.doc.items.some(i => i.id === item)) throw new HttpError(400, `no item ${item}; the screen's items: ${inst.doc.items.map(i => i.id).join(', ')}`);
    if (!Array.isArray(files)) throw new HttpError(400, 'files is an array');
    for (const f of files) {
      const fd = typeof f === 'string' && /^upload\/attachments\/[^/]+$/.test(f) ? openFile(inst.dir, f) : undefined;
      if (fd === undefined) throw new HttpError(400, `no attachment ${f}`);
      closeSync(fd);
    }
    const who = typeof to === 'string' ? to.toLowerCase() : undefined, p = who && asPerson(who);
    if (who && !(p && canSee(p, t.workspaces[t.series[inst.seriesId].workspace])))
      throw new HttpError(400, `${to} can't see this instance; ask its series owner, ${ownerOf(inst).by}, or someone in its workspace`);
    // Another instance's run leaves a non-executing note with immutable execution provenance.
    const away = run && run.inst !== inst;
    if (away && (ask || to)) throw new HttpError(400, 'you ask and propose only in your own instance: rf comment . --ask or --propose');
    const seq = inst.log.length + 1;
    const fields = { ...(under ? { thread: under.thread, parent: under.seq } : { thread: `c${seq}`, item: item ?? null, ref: ref ?? null }),
      text: text.trim(), ...(files.length && { files }), ...(quiet && { quiet: true }) };
    const word = !run && standing(inst, { seq, at: '', by, op: 'comment', ...fields })?.word;
    const informs = Boolean(away || word === 'note');
    if (request !== undefined && (typeof request !== 'boolean' || request && !informs)) throw new HttpError(400, 'only an informing comment can be a request');
    let linked: ScopedNote | undefined;
    if (noteFor !== undefined) {
      if (typeof noteFor !== 'string' || !/^[cn][1-9]\d*$/.test(noteFor) || !run || away || ask !== 'proposal' || (who && who !== run.runner))
        throw new HttpError(400, 'link an open note only to a proposal to your series owner in your own instance');
      linked = seriesConversation(inst.seriesId).notes.find(n => n.id === noteFor && (n.anchor?.inst ?? inst.id) === inst.id);
      if (!linked || linked.settled || linked.proposal) throw new HttpError(409, `${noteFor} is not an open note without a pending proposal`);
    }
    const said = post({ op: 'comment', inst, by, text, under, item, ref, files, quiet, ask, to: who, run, word: word || undefined, request, noteFor: linked?.id });
    if (away) {
      if (!standing(inst, said)!.starts && active.get(inst.seriesId)?.inst !== inst) commit(inst.dir, AGENT, `Note in ${said.thread}`).catch(err => inst.append('server', 'commit', { cause: said.seq, error: err.message }));
      return send(res, 200, `said c${said.seq} in ${named(t, inst.seriesId)}/${inst.label}${under ? `, under ${thread}` : ''}, a note for its series owner`);
    }
    if (run) return send(res, 200, `${{ question: 'asked', proposal: 'proposed' }[ask as string] ?? 'said'} c${said.seq}${under ? `, under ${thread}` : ''}`);
    res.setHeader('X-RF-Comment-Seq', said.seq);
    // Until a task is renamed, its first prompt's opening words name it.
    const s = t.series[inst.seriesId], words = text.trim().split(/\s+/).slice(0, 6).join(' ').replace(/^\.+/, '').slice(0, 60);
    if (s.single && words && words !== 'AGENTS.md' && !inst.log.some(e => e.op === 'rename' || (e.op === 'comment' && e !== said && isPerson(e)))) {
      const from = inst.label;
      s.name = freeName(t, s.workspace, folderName(words));
      saveTree(t);
      renameInstance(inst, s.name);
      inst.append('server', 'rename', { from, cause: said.seq });
    }
    if (!standing(inst, said)!.starts && active.get(inst.seriesId)?.inst !== inst) commit(inst.dir, me, `Comment in ${said.thread}`).catch(err => inst.append('server', 'commit', { cause: said.seq, error: err.message }));
  } else if (action === 'commit' && run) {
    // The agent commits the folder at a moment worth keeping, in its own name.
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) throw new HttpError(400, 'a commit has a message');
    const hash = await commit(inst.dir, AGENT, message);
    inst.append('agent', 'commit', { run: run.n, message, commit: hash });
    return send(res, 200, `committed ${hash}`);
  } else if (['signoff', 'reject', 'withdraw', 'interrupt', 'close', 'abandon'].includes(action)) {
    const out = await inOrder(inst.id, async () => {
      const recheck = () => {
        recheckRequest(req);
        if (run && running(run.token) !== run) throw new HttpError(409, 'its run has ended');
        const { ws, who } = mustUnarchived(by, inst.seriesId, me, !!run);
        if (inst.doc.status !== 'open') throw new HttpError(409, `instance is ${inst.doc.status}`);
        const cur = active.get(inst.seriesId);
        return { ws, who, mine: cur?.inst === inst ? cur : undefined };
      };
      const before = recheck();
      if (['signoff', 'close', 'abandon'].includes(action)) {
        if (before.mine) throw new HttpError(409, 'wait for the run to end');
        if (action !== 'signoff' && ownerOf(inst).by !== by) throw new HttpError(403, `only the series owner, ${ownerOf(inst).by}, ${action === 'close' ? 'closes it, making it the record' : 'abandons it'}`);
      }
      const { thread, text, approved } = payload;
      const target = action === 'signoff' || action === 'reject' ? commentAt(inst.log, thread) : undefined;
      const ask = target?.by === 'agent' && (target.ask === true || target.ask === 'proposal') ? target : undefined;
      const currentProposal = () => {
        if (!ask) return;
        const s = seriesSettings(inst.series()), workspace = tree().series[inst.seriesId].workspace;
        if (!currentMessage(inst.log, ask, { by: s.owner ?? '', epoch: s.epoch, workspace }))
          throw new HttpError(409, 'the proposal is from an earlier series authority');
        if (ask.noteFor) {
          if (by !== s.owner || ask.noteEpoch !== s.epoch) throw new HttpError(403, 'only the current series owner can decide a proposal linked to a note');
          if (!seriesConversation(inst.seriesId).notes.some(n => n.id === ask.noteFor && (n.anchor?.inst ?? inst.id) === inst.id
            && !n.settled && n.proposal?.inst === inst.id && n.proposal.seq === ask.seq)) throw new HttpError(409, `${ask.noteFor} no longer waits for this proposal`);
        }
      };
      if (action === 'signoff' || action === 'reject') {
        // Anyone who sees the instance approves a proposal of the agent's, which `thread` names as cN, or rejects it, with a note, as an
        // ask from before questions and proposals, `ask: true`, which may have been either. Approving is a sign-off, the route's and the
        // entry's name: it commits the folder in their name, as they say yes to it, the proposal and the note its message, with their
        // Signed-off-by. Only an owner's non-quiet decision starts a run. rf 0.12's reject, a sign-off
        // with approved false, is refused.
        if (approved === false) throw new HttpError(400, 'a sign-off approves; to say no, reject it, on the page or with rf reject');
        if (!ask) throw new HttpError(409, `${thread} is no proposal of the agent's`);
        currentProposal();
        if (inst.log.some(e => e.op === 'withdraw' && e.on === ask.seq)) throw new HttpError(409, `the agent withdrew ${thread}`);
        const decided = ask.ask === 'proposal' && inst.log.find(e => e.on === ask.seq && (e.op === 'signoff' || e.op === 'reject'));
        if (decided) throw new HttpError(409, `${thread} was ${decided.op === 'signoff' ? 'approved' : 'rejected'} already, by ${decided.by}`);
        const closed = inst.log.find(e => e.op === 'close' && (e.accepted as string[] | undefined)?.includes(thread));
        if (closed) throw new HttpError(409, `${thread} was accepted as done at the close, by ${closed.by}`);
        if (ask.seq < inst.copied) throw new HttpError(409, `${thread} is from before this instance was copied`);
      }
      if (['signoff', 'close', 'abandon'].includes(action)) {
        if (action !== 'signoff') inst.closing = true;
        try {
          let prior;
          do {
            prior = committed(inst.dir);
            await prior;
          } while (committed(inst.dir) !== prior);
        } finally {
          if (action !== 'signoff') inst.closing = false;
        }
      }
      const { ws, who, mine } = recheck();
      if (ask) {
        currentProposal();
        const note = typeof text === 'string' ? text.trim() : '';
        const decision = { thread: ask.thread, on: ask.seq, ...(note && { text: note }), ...(quiet && { quiet: true }), ...(ask.noteFor && { noteDecision: true, noteFor: ask.noteFor }) };
        if (action === 'reject') inst.append(by, 'reject', decision);
        else {
          if (mine) throw new HttpError(409, 'wait for the run to end');
          const hash = await commit(inst.dir, who, [ask.text, note, `Signed-off-by: ${who.name} <${who.email}>`].filter(Boolean).join('\n\n'));
          if (recheck().mine) throw new HttpError(409, 'wait for the run to end');
          currentProposal();
          if (inst.log.some(e => e.op === 'withdraw' && e.on === ask.seq)) throw new HttpError(409, `the agent withdrew ${thread}`);
          inst.append(by, 'signoff', { ...decision, commit: hash });
        }
        return undefined;
      }
      if (action === 'withdraw' && run) {
        // The agent withdraws a question or proposal of its own still waiting, saying why, and where it was answered, if it was: see, a
        // comment's seq.
        const { thread, text, see } = payload, asks = inst.asking(run.runner), ask = asks.find(e => `c${e.seq}` === thread), at = commentAt(inst.log, see);
        if (!ask) throw new HttpError(409, `${thread} is no question or proposal of yours still waiting; those that are: ${asks.map(e => `c${e.seq}`).join(', ') || 'none'}`);
        if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'a withdrawal says why');
        if (see !== undefined && !at) throw new HttpError(400, `no comment ${see}`);
        post({ op: 'withdraw', inst, by: 'agent', on: ask, text, see: at, run });
        return `withdrew ${thread}`;
      }
      if (action === 'interrupt') {
        await interrupt(inst, mine, who);
        return 'ok';
      }
      if (action === 'close' || action === 'abandon') {
        if (mine) throw new HttpError(409, 'wait for the run to end');
        if (ownerOf(inst).by !== by) throw new HttpError(403, `only the series owner, ${ownerOf(inst).by}, ${action === 'close' ? 'closes it, making it the record' : 'abandons it'}`);
        await (action === 'close' ? inst.close(who, quiet) : inst.abandon(by));
        cancelWakes([inst.id]);
        return 'ok';
      }
      throw new HttpError(404, `no action ${action}`);
    });
    if (out !== undefined) return send(res, 200, out);
  } else throw new HttpError(404, `no action ${action}`);
  if (!quiet) kick(inst);
  send(res, 200, 'ok');
}

async function admin(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (me.role !== 'admin') throw new HttpError(403, 'admins only');
  const email = decodeURIComponent(url.pathname.split('/')[2] ?? '').toLowerCase();
  if (!email) {
    const t = tree(), us = users();
    if (req.method === 'PUT') {
      // Roles by email: a new email becomes a person; no one is removed.
      const { roles, force } = await json(req), after = structuredClone(us);
      for (const [e, role] of Object.entries(roles as Record<string, string>)) {
        if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new HttpError(400, `not an email address: ${e}`);
        if (!ROLES.includes(role as Role)) throw new HttpError(400, `${e}: a role is one of ${ROLES.join(', ')}`);
        if (e.toLowerCase() === me.email && role !== 'admin') throw new HttpError(409, 'you cannot lock yourself out');
        after[e.toLowerCase()] = { ...after[e.toLowerCase()], role: role as Role };
      }
      guard(hidden(t, us), hidden(t, after), force);
      for (const [e, role] of Object.entries(roles as Record<string, Role>)) upsertUser(e, { role });
      pruneGrants();
      await closeUnlent();
      return send(res, 200, 'ok');
    }
    // Include empty owned series in the demotion preview.
    const owned = Object.entries(t.series).map(([sid, s]) => ({ owner: seriesSettings(seriesDir(sid)).owner, w: t.workspaces[s.workspace], path: named(t, sid) }));
    return send(res, 200, Object.entries(us).map(([email, { sub, epoch, groups, ...u }]) => ({
      email, ...u, workspaces: Object.values(t.workspaces).filter(w => everyone(w).includes(email)).map(w => w.name),
      outside: owned.filter(o => o.owner === email && !canSee({ email, role: 'user', groups: groups ?? [] }, o.w)).map(o => o.path),
    })));
  }
  if (!users()[email]) throw new HttpError(404, `no user ${email}`);
  if (req.method === 'DELETE') {
    if (email === me.email) throw new HttpError(409, 'you cannot remove yourself');
    const retired = withdrawOwner(email);
    forget(email);
    forgetGrants(email);
    removeUser(email);
    await endSignIns(email);
    await dropUnpermittedVpns(email);
    await retired;
    await closeUnlent();
  } else if (req.method === 'PUT') {
    const { disabled, signout } = await json(req);
    if (email === me.email && disabled) throw new HttpError(409, 'you cannot lock yourself out');
    const retired = disabled || signout ? withdrawOwner(email) : Promise.resolve();
    if (disabled !== undefined) upsertUser(email, { disabled: !!disabled });
    if (signout) signOutEverywhere(email);
    if (disabled || signout) {
      await endSignIns(email);
      await dropUnpermittedVpns(email);
      await retired;
      await closeUnlent();
    }
  } else throw new HttpError(405, 'PUT or DELETE');
  send(res, 200, 'ok');
}

// Skills: anyone signed in may list and read them; every run loads every live one. Those who may publish push versions, with rf.
async function skillsRoute(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const [id = '', action, n] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  if (!id && req.method === 'GET') return send(res, 200, skills().map(s => ({ id: s.id, name: s.name, description: s.description, pushed: pushed(s) })));
  if (action === 'versions' && n && req.method === 'GET') return send(res, 200, versionFiles(id, Number(n)));
  if (action === 'versions' && req.method === 'GET') return send(res, 200, versionsOf(id));
  if (action === 'versions' && req.method === 'POST') {
    if (!can(me, 'publish')) throw new HttpError(403, 'pushing skills is for admins and those they grant publish: ask an admin');
    const { files, from } = await json(req);
    return send(res, 200, `pushed ${id} version ${pushSkill(id, from === undefined ? files : versionFiles(id, Number(from)), me.email)}, live now`);
  }
  throw new HttpError(405, 'GET, or POST a version');
}

// Connections: anyone signed in may list them, each with its login, to connect or sign in on the Logins page; admins keep them,
// with rf.
async function connectionsRoute(me: Me, req: IncomingMessage, res: ServerResponse, url: URL) {
  const name = decodeURIComponent(url.pathname.slice(13));
  if (!name && req.method === 'GET') return send(res, 200, connections().map(({ key: _key, ...c }) => ({ ...c, login: loginOf(c) })));
  if (me.role !== 'admin') throw new HttpError(403, 'admins keep connections');
  const body = req.method === 'PUT' ? await json(req) : {};
  if (req.method === 'PUT') return send(res, 200, await setConnection(name, body, me.email));
  if (req.method === 'DELETE') return send(res, 200, (removeConnection(name), 'ok'));
  throw new HttpError(405, 'PUT or DELETE');
}

if (!verifyOnly) serveSandboxes({
  agent: async (req, res, url) => {
    try {
      await agent(req, res, url);
    } catch (err) {
      send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
    }
  },
  // The run its token is, checked again as each request comes over a connection already open.
  run: token => running(token) ? {
    egress(host, allowed) {
      const a = running(token);
      if (!a) return;
      const prev = a.hosts.get(host);
      if (prev === true || prev === allowed) return;
      a.hosts.set(host, allowed);
      a.inst.append('server', 'egress', { run: a.n, host, allowed });
    },
    browsers: () => { const a = running(token)!; return (a.browsers ??= new Browsers(a.inst, a.n)); },
    intercepts: host => intercepts(running(token)!, host),
    call: async (host, req, res) => {
      const a = running(token);
      return a ? call(a, host, req, res) : void res.writeHead(409).end('its run has ended');
    },
  } : undefined,
});

const server = createServer({ requestTimeout: 60 * 60_000 }, async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://x');
    if (verifyOnly) {
      const p = url.pathname;
      if (req.method !== 'GET' || p === redirectPath && url.searchParams.has('state') ||
        !(['/', '/me', '/logins', '/brand/logo', '/api', '/api/events', '/api/status', '/api/files', '/api/runs', '/api/activity', '/api/messages'].includes(p)
          || /^\/(?:css\/|files\/|api\/series\/[\w-]+\/files\/)/.test(p)
          || /^\/api\/(?:instances\/[\w-]+(?:\/(?:summary|trace))?|series\/[\w-]+\/notes)$/.test(p)))
        throw new HttpError(503, 'verification only: no work starts and no writes are accepted');
    }
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site && site !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    // What the sign-in pages show, before anyone signs in: the stylesheets, the theme's logo and the brand's.
    const css = req.method === 'GET' ? stylesheet(url.pathname) : undefined;
    if (css !== undefined) {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return void res.end(css);
    }
    if (req.method === 'GET' && url.pathname === '/css/logo' && themeLogo) {
      res.writeHead(200, { 'content-type': themeLogo.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return void res.end(readFileSync(themeLogo.file));
    }
    if (req.method === 'GET' && url.pathname === '/brand/logo') {
      const { logo, type } = brand();
      if (!logo) throw new HttpError(404, 'no logo');
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return void res.end(Buffer.from(logo, 'base64'));
    }
    // Whether an update may stop the server (scripts/update.ts), its answer alone, to anyone: 200 drained, else 503.
    if (req.method === 'GET' && url.pathname === '/drained') return void res.writeHead(drained() ? 200 : 503).end();
    const me = await authenticate(req, res, url, !verifyOnly);
    if (!me) {
      if (!verifyOnly && url.pathname === redirectPath) { const retired = closeUnlent(); pruneGrants(); await endUnpermittedSignIns(); await dropUnpermittedVpns(); await retired; }
      return;
    }
    // Conversations live only in their series store. The global audit never copies text or attachment paths from them.
    if (!['GET', 'HEAD'].includes(req.method!) && !url.pathname.startsWith('/api/instances/'))
      res.on('finish', () => res.statusCode < 400 && !messageWrites.has(req) && act(me.email, { method: req.method, path: url.pathname + url.search, body: bodies.get(req) }));
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/me') {
      const { text, logo } = brand(), k = !verifyOnly && me.role === 'admin' ? await keyStatus() : null;
      const creditErr = !verifyOnly && me.role === 'admin' ? (k?.credit_error ?? openrouterCreditError()) : null;
      send(res, 200, {
        ...me, names: names(me), browsers: !!process.env.RF_BROWSER_URL, brand: { text: text || null, logo: !!logo }, themeLogo: !!themeLogo, can: CAPS.filter(c => can(me, c)), version, draining: updating(), ...(verifyOnly && { verifyOnly: true }),
        ...(k?.low_credit && { low_credit: { remaining: k.remaining!, limit: k.limit, usage: k.usage, reset: k.reset, key: k.key } }),
        ...(creditErr && { credit_error: creditErr }),
      });
    } else if (url.pathname === '/capabilities') {
      if (me.role !== 'admin') throw new HttpError(403, 'admins grant capabilities');
      if (req.method === 'PUT') {
        const payload = await json(req), { cap } = payload;
        if (!CAPS.includes(cap)) throw new HttpError(400, `a capability is one of ${CAPS.filter(c => c !== 'vpn' || can(me, c)).join(', ')}`);
        const edits = ['people', 'add', 'remove'].filter(key => Object.hasOwn(payload, key)), [key] = edits, people = payload[key];
        if (edits.length !== 1 || !isPeople(people) || key !== 'people' && !people.length) throw new HttpError(400, `${cap}: give one non-empty list of emails and Entra group ids for add or remove, or a list in people`);
        const selected = people.map(p => p.toLowerCase()), all = capabilities(), before = all[cap] ?? [];
        all[cap] = key === 'add' ? [...new Set([...before, ...selected])] : key === 'remove' ? before.filter(p => !selected.includes(p)) : selected;
        writeJson('capabilities.json', all);
        if (cap === 'vpn') {
          await endUnpermittedSignIns();
          await dropUnpermittedVpns();
          await closeUnlent();
        }
      }
      send(res, 200, Object.fromEntries(CAPS.filter(c => c !== 'vpn' || can(me, c)).map(c => [c, capabilities()[c] ?? []])));
    } else if (url.pathname === '/profiles') {
      if (me.role !== 'admin') throw new HttpError(403, 'admins keep website profiles');
      if (req.method === 'GET') return send(res, 200, profiles());
      if (req.method !== 'PUT') throw new HttpError(405, 'GET or PUT');
      const { host, what, category, risk, remove } = await json(req) ?? {};
      if (typeof host !== 'string' || host.length > 253 || !host.includes('.') ||
          !host.split('.').every(h => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(h)) || URL.parse(`https://${host}`)?.hostname !== host)
        throw new HttpError(400, 'host: an exact lowercase hostname, such as portal.example.com');
      const all = profiles();
      if (remove === true) delete all[host];
      else {
        if (remove !== undefined || typeof what !== 'string' || !what.trim() || !categories.includes(category) || !risks.includes(risk))
          throw new HttpError(400, `give remove: true, or what (a non-empty description), category (${categories.join(', ')}) and risk (${risks.join(', ')})`);
        all[host] = { what: what.trim(), category, risk, by: me.email, at: new Date().toISOString() };
      }
      writeJson('profiles.json', all);
      send(res, 200, all);
    } else if (url.pathname === '/egress') {
      // The hosts runs may reach beyond the sandbox's own list (sandbox.ts), which admins keep.
      if (req.method === 'PUT') {
        if (me.role !== 'admin') throw new HttpError(403, 'admins keep the hosts runs may reach');
        const { hosts } = await json(req);
        if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h))) throw new HttpError(400, `hosts: names such as pypi.org or *.example.com, not ${JSON.stringify(hosts)}`);
        writeJson('egress.json', hosts.map(h => h.toLowerCase()));
      }
      send(res, 200, readJson<string[]>('egress.json', []));
    } else if (url.pathname === '/internal' || /^\/internal\/[^/]+$/.test(url.pathname)) {
      // The hosts at internal addresses admins let every website reach (connections.ts), with who let each and when: admins see them,
      // and take one out, after which everyone's websites at it wait for an admin again.
      if (me.role !== 'admin') throw new HttpError(403, 'admins see the internal hosts they let websites reach');
      if (req.method === 'DELETE') {
        const host = decodeURIComponent(url.pathname.split('/')[2]).toLowerCase();
        if (!letIn()[host]) throw new HttpError(404, `${host} isn't one admins let websites reach: they are ${Object.keys(letIn()).join(', ') || 'none'}`);
        setLetIn([host], me.email, false);
        await revokeInternalHosts([host]);
        act(me.email, { op: 'internal', hosts: [host], let: false });
        await closeUnlent();
      } else if (req.method !== 'GET') throw new HttpError(405, 'GET lists them, DELETE /internal/HOST takes one out');
      send(res, 200, letIn());
    } else if (url.pathname === '/brand' && req.method === 'PUT') {
      if (me.role !== 'admin') throw new HttpError(403, "the deployment's brand is the admins'");
      const { text, logo, clear } = await json(req), b = { ...(!clear && brand()) };
      if (text !== undefined) b.text = String(text);
      if (logo) {
        const type = String(logo.name).match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
        if (!type) throw new HttpError(400, 'a logo is a .png, .jpg, .gif, .webp or .svg file');
        Object.assign(b, { logo: String(logo.data), type: `image/${type}` });
      }
      writeJson('brand.json', b);
      send(res, 200, 'saved');
    }
    else if (url.pathname === '/api/events') events(me, req, res);
    else if (url.pathname === '/api') send(res, 200, listing(me));
    else if (url.pathname === '/api/files') send(res, 200, pullable(me, url.searchParams.get('path') ?? ''));
    else if (url.pathname === '/api/runs') send(res, 200, runs(me, url.searchParams.get('since') ?? ''));
    else if (url.pathname === '/api/costs') send(res, 200, await costs(me, url.searchParams.get('since') ?? '', url.searchParams.get('tz') ?? ''));
    else if (url.pathname === '/api/activity') send(res, 200, activity(me, url.searchParams.get('since') ?? ''));
    else if (url.pathname === '/api/status') send(res, 200, await status(me));
    else if (req.method === 'GET' && url.pathname === '/api/messages' && url.searchParams.get('mine') === '1') {
      const t = tree(), periods = instancesBySeries();
      send(res, 200, Object.entries(t.series).filter(([, s]) => canSee(me, t.workspaces[s.workspace])).flatMap(([id]) =>
        seriesConversation(id, periods(id)).notes.filter(n => n.by === me.email).map(n => ({ ...n, path: `${named(t, id)}${n.anchor ? `/${n.anchor.label}` : ''}` }))));
    }
    // Each index the person can see, admins all, others those they are indexing.
    else if (url.pathname === '/api/indexes') send(res, 200, indexes().filter(x => me.role === 'admin' || x.people.some(p => p.who === me.email)));
    else if (url.pathname.startsWith('/files/')) await file(me, res, url, false);
    else if (url.pathname.startsWith('/preview/')) await file(me, res, url, true);
    else if (url.pathname.startsWith('/api/')) await api(me, req, res, url);
    // The system monitor is admins' alone: to anyone else it isn't there.
    else if (url.pathname === '/monitor' || url.pathname.startsWith('/monitor/')) {
      if (me.role !== 'admin') throw new HttpError(404, 'not found');
      await monitor(me, req, res, url);
    }
    else if (url.pathname === '/agents' && req.method === 'GET') send(res, 200, { text: text(agentsFile()) });
    else if (url.pathname === '/agents' && req.method === 'PUT') {
      if (me.role !== 'admin') throw new HttpError(403, "the company's AGENTS.md is the admins'");
      replaceFile(agentsFile(), (await body(req)).toString());
      send(res, 200, 'ok');
    } else if (url.pathname === '/cli') await cli(req, res, url);
    else if (url.pathname === '/tokens' && req.method === 'GET') send(res, 200, myTokens(me.email));
    else if ((url.pathname === '/tokens' && req.method === 'POST') || (url.pathname.startsWith('/tokens/') && req.method === 'DELETE')) {
      // Made and revoked on the page only, as the session's own person: a token that could make tokens would outlive its revocation.
      const own = session(req);
      if (!own) throw new HttpError(403, 'tokens are made and revoked on the page');
      if (req.method === 'DELETE') return send(res, 200, (revokeToken(own.email, decodeURIComponent(url.pathname.slice(8))), 'ok'));
      const { name, days } = await json(req);
      if (!session(req)) throw new HttpError(401, 'sign in first');
      send(res, 200, { token: newToken(own.email, String(name ?? '').trim(), Number(days)) });
    } else if (url.pathname === '/logins' && req.method === 'GET') send(res, 200, logins(me.email).map(l => ({ ...l, missing: ungranted(l) })));
    else if (/^\/logins\/[^/]+\/connect$/.test(url.pathname) && req.method === 'POST') {
      const c = byLogin(decodeURIComponent(url.pathname.split('/')[2]));
      if (c?.type !== 'service') throw new HttpError(404, 'no service connection with that login');
      const login = loginOf(c);
      saveLogin(me.email, { ...login, offers: login.offers!, since: new Date().toISOString() });
      send(res, 200, 'ok');
    }
    else if (/^\/logins\/[^/]+\/connect$/.test(url.pathname)) {
      // A link on another site must not start it: Microsoft may sign in again without asking.
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'connect from the Logins page');
      const c = byLogin(decodeURIComponent(url.pathname.split('/')[2])), login = c && loginOf(c);
      if (!login?.scope) throw new HttpError(404, 'no connection signs in to Microsoft with that login');
      await connect(res, me.email, login);
    }
    else if (url.pathname === '/vpns' || url.pathname.startsWith('/vpns/')) {
      if (!can(me, 'vpn')) throw new HttpError(404, 'not found');
      if (url.pathname === '/vpns' && req.method === 'GET') send(res, 200, await vpns(me));
      else if (url.pathname === '/vpns' && req.method === 'POST') {
        const { name, type, gateway, servercert } = await json(req);
        addVpn(me, String(name ?? ''), { type, gateway, servercert });
        send(res, 200, 'saved');
      } else {
        const match = /^\/vpns\/([^/]+)(?:\/(signins|connection))?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, 'not found');
        const name = decodeURIComponent(match[1]);
        if (!match[2] && req.method === 'DELETE') {
          try { await removeVpn(me, name); } finally { await closeUnlent(); }
          send(res, 200, 'ok');
        } else if (match[2] === 'connection' && req.method === 'DELETE') {
          try { await disconnectVpn(me, name); } finally { await closeUnlent(); }
          send(res, 200, 'ok');
        }
        else if (match[2] === 'signins' && req.method === 'POST') {
          const since = Date.now(), id = await startVpnSignIn(me, name);
          send(res, 200, { id, expires: new Date(since + Number(process.env.RF_SIGNIN_S ?? 600) * 1000).toISOString() });
        } else throw new HttpError(404, 'not found');
      }
    }
    // Websites are personal; admins alone allow hosts the server leaves for them.
    else if (url.pathname === '/logins/sites' && req.method === 'GET') {
      const person = url.searchParams.get('person') ?? me.email;
      if (person !== me.email && me.role !== 'admin') throw new HttpError(403, `${person}'s websites are theirs`);
      send(res, 200, Object.fromEntries(Object.entries(websitesOf(person)).map(([site, w]) => [site, { ...w, checking: isCheckingWebsite(person, site) }])));
    }
    else if (url.pathname === '/logins/sites' && req.method === 'POST') {
      const { name, url: start, header } = await json(req);
      send(res, 200, await addSite(me.email, String(name ?? ''), String(start ?? ''), String(header ?? '').trim()));
    }
    else if (/^\/logins\/sites\/[^/]+$/.test(url.pathname) && req.method === 'PATCH') {
      const change = await json(req);
      await setSite(me, decodeURIComponent(url.pathname.split('/')[3]), change, url.searchParams.get('person') ?? me.email, () => recheckRequest(req));
      if (change.via !== undefined || change.internal !== undefined) await closeUnlent();
      send(res, 200, 'ok');
    }
    else if (/^\/logins\/sites\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') send(res, 200, (removeSite(me.email, decodeURIComponent(url.pathname.split('/')[3])), await closeUnlent(), 'ok'));
    // Grants: a person asks to use their login to a website in a workspace, whose owners approve or deny it, and revoke it, as its
    // person may withdraw it; revoked, that person's run browsers there in the workspace close at once.
    else if (url.pathname === '/grants' && req.method === 'GET') send(res, 200, visible(me));
    else if (url.pathname === '/grants' && req.method === 'POST') {
      const { site, workspace, reason } = await json(req);
      send(res, 200, await ask(me, String(site ?? ''), String(workspace ?? ''), String(reason ?? ''), () => recheckRequest(req)));
    }
    else if (/^\/grants\/\w+$/.test(url.pathname) && req.method === 'POST') {
      const { approve, text } = await json(req);
      send(res, 200, (decide(me, url.pathname.slice(8), approve === true, String(text ?? '')), 'ok'));
    }
    else if (/^\/grants\/\w+$/.test(url.pathname) && req.method === 'DELETE') {
      revoke(me, url.pathname.slice(8));
      await closeUnlent();
      send(res, 200, 'ok');
    }
    else if (/^\/logins\/web\/[^/]+\/hosts$/.test(url.pathname) && req.method === 'POST') send(res, 200, (await allowHost(me, decodeURIComponent(url.pathname.split('/')[3]), String((await json(req)).host ?? ''), url.searchParams.get('person') ?? me.email, () => recheckRequest(req)), 'ok'));
    else if (/^\/logins\/web\/[^/]+\/hosts\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') send(res, 200, (await removeHost(me.email, decodeURIComponent(url.pathname.split('/')[3]), decodeURIComponent(url.pathname.split('/')[5])), 'ok'));
    else if (/^\/logins\/web\/[^/]+$/.test(url.pathname) && req.method === 'POST') {
      const site = decodeURIComponent(url.pathname.slice(12)), header = String((await json(req)).header ?? ''), since = Date.now();
      if (websitesOf(me.email)[site]?.via && !can(me, 'vpn')) throw new HttpError(403, 'vpn capability required to open a VPN-routed website sign-in');
      const id = await startSignIn(me.email, site, header, me, () => recheckRequest(req));
      send(res, 200, { id, expires: new Date(since + Number(process.env.RF_SIGNIN_S ?? 600) * 1000).toISOString() });
    }
    // What a person's login offers that they add themselves: Microsoft 365's sources and Databricks' warehouses.
    else if (/^\/logins\/[^/]+\/offers$/.test(url.pathname) && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/')[2]), add = String((await json(req)).add ?? '');
      await (id === 'm365' ? offer(me.email, add) : addWarehouse(me.email, id, add));
      send(res, 200, (track(me.email), 'ok'));
    }
    else if (/^\/logins\/[^/]+\/offers\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
      const [, , id, , o] = url.pathname.split('/').map(decodeURIComponent);
      send(res, 200, (unoffer(me.email, id, o), forget(me.email, o), await closeUnlent(), 'ok'));
    }
    else if (/^\/signins\/\w+\/view$/.test(url.pathname) && req.method === 'GET') {
      const id = url.pathname.split('/')[2];
      if (!isSignIn(me.email, id) && !(can(me, 'vpn') && isVpnSignIn(me.email, id))) throw new HttpError(404, 'no such sign-in');
      const html = await viewPage(id);
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    else if (/^\/runs\/\w+\/[a-z0-9-]+\/view$/.test(url.pathname) && req.method === 'GET') {
      const [, , id, site] = url.pathname.split('/'), html = await viewPage(watched(me, id, site).id);
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    // Saved, a login may be kept alive, by those granted keepalive; or thrown away.
    else if (/^\/signins\/\w+$/.test(url.pathname) && req.method === 'POST') {
      const id = url.pathname.slice(9);
      if (can(me, 'vpn') && isVpnSignIn(me.email, id)) {
        try { await saveVpnSignIn(me, id, () => recheckRequest(req)); } finally { await closeUnlent(); }
        send(res, 200, 'ok');
      } else {
        const { keepalive } = await json(req);
        if (keepalive !== undefined && !can(me, 'keepalive')) throw new HttpError(403, 'keeping a login alive is for admins and those they grant keepalive: ask an admin');
        send(res, 200, (await endSignIn(me.email, id, true, keepalive, () => recheckRequest(req)), 'ok'));
      }
    }
    else if (/^\/signins\/\w+$/.test(url.pathname) && req.method === 'DELETE') {
      const id = url.pathname.slice(9);
      if (can(me, 'vpn') && isVpnSignIn(me.email, id)) {
        await cancelVpnSignIn(me, id);
        await closeUnlent();
      } else await endSignIn(me.email, id, false);
      send(res, 200, 'ok');
    }
    // Your own OpenRouter key, checked with OpenRouter as you save it, and whether your runs use it: a new one, or not using it, ends
    // its running out of credits.
    else if (url.pathname === '/logins/openrouter' && req.method === 'PUT') {
      const { key, enabled } = await json(req), was = logins(me.email).find(l => l.id === 'openrouter'), k = String(key ?? '').trim();
      if (!k && !was) throw new HttpError(400, 'your OpenRouter key: paste it to save it');
      if (k && !(await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/key`, { headers: { authorization: `Bearer ${k}` } })).ok) throw new HttpError(400, 'OpenRouter refused this key');
      recheckRequest(req);
      saveLogin(me.email, { id: 'openrouter', kind: 'key', name: 'OpenRouter', since: k ? new Date().toISOString() : was!.since, offers: [], enabled: !!enabled, ...(!k && enabled && was!.expired && { expired: true }) }, k || undefined);
      send(res, 200, 'saved');
    }
    else if (url.pathname.startsWith('/logins/') && req.method === 'DELETE') send(res, 200, (signOut(me.email, decodeURIComponent(url.pathname.slice(8))), url.pathname === '/logins/m365' && forget(me.email), await closeUnlent(), 'ok'));
    else if (url.pathname === '/users' || url.pathname.startsWith('/users/')) await admin(me, req, res, url);
    else if (url.pathname === '/skills' || url.pathname.startsWith('/skills/')) await skillsRoute(me, req, res, url);
    else if (url.pathname === '/connections' || url.pathname.startsWith('/connections/')) await connectionsRoute(me, req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    if (res.headersSent) res.destroy();
    else send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
});
// A live view's websockets pass through to the browser service: a sign-in's, its own person's, to watch or drive, and a run's
// browser's, to watch (watched), or to drive for the person whose login it's in. Only from the server's own pages: the session
// cookie, SameSite=Lax, goes with a sibling subdomain's requests too.
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  if (verifyOnly) return socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
  const me = req.headers.origin === new URL(process.env.RF_PUBLIC_URL!).origin ? session(req) : null, path = URL.parse(req.url!, 'http://x')?.pathname ?? '';
  const signIn = /^\/signins\/(\w+)\/(view\/(?:watch|drive))$/.exec(path), run = /^\/runs\/(\w+)\/([a-z0-9-]+)\/view\/(watch|drive)$/.exec(path);
  let to;
  if (me && signIn && (isSignIn(me.email, signIn[1]) || can(me, 'vpn') && isVpnSignIn(me.email, signIn[1]))) {
    to = `/sessions/${signIn[1]}/${signIn[2]}`;
    const may = () => { const now = session(req); return !!now && (isSignIn(now.email, signIn[1]) || can(now, 'vpn') && isVpnSignIn(now.email, signIn[1])); };
    const cut = (id: string) => id === 'tree' && !may() && socket.destroy();
    changes.on('change', cut);
    socket.on('close', () => changes.off('change', cut));
  }
  if (me && run) try {
    const w = watched(me, run[1], run[2]);
    to = `/sessions/${run[3] === 'drive' ? w.browsers.drive(run[2], me.email, socket) : w.id}/view/${run[3]}`;
    // It lasts while they may watch: a change to the workspaces or people, such as their removal or disabling, cuts it once they may not.
    const may = () => { const now = session(req); try { return !!now && !!watched(now, run[1], run[2]); } catch { return false; } };
    const cut = (id: string) => id === 'tree' && !may() && socket.destroy();
    changes.on('change', cut);
    socket.on('close', () => changes.off('change', cut));
  } catch {}
  if (!to) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  passUpgrade(req, socket, head, to);
});
// An update drains the server before it stops it (waker.ts drain()), heard before top-level awaits yield, as Node ends on a
// SIGUSR2 it doesn't handle.
process.on('SIGUSR2', () => { if (!verifyOnly) drain(); });
if (!verifyOnly) {
  passAllowed();
  await enrolFlagged();
  if (process.env.RF_BROWSER_URL) await reap().catch(e => console.error('the browser service: browsers a restart left open are still open', e));
  await reapVpns().catch(e => console.error('the tunnel service: tunnels a restart left may still be open, and VPNs fail until it answers', e));
}
// A stop, as an update's, cuts the runs (waker.ts stop()) and exits once what they had sent is answered and logged, within 10 s.
process.on('SIGTERM', async () => {
  if (verifyOnly) process.exit();
  stop();
  await Promise.all([callsAnswered(10_000), drainWebsiteChecks(10_000)]);
  process.exit();
});
server.listen(port, host, () => {
  if (verifyOnly) return console.log(`rollforward on http://${host}:${port}, data in ${root} (verification only)`);
  startIndexing();
  startWaking();
  if (process.env.RF_BROWSER_URL) setInterval(() => {
    lapse();
    keepAlive().catch(e => console.error('keeping logins alive:', e));
  }, 60_000).unref();
  // The server's OpenRouter keys, as soon as it starts, every RF_KEY_TTL_MS, and 30 s after each UTC midnight, when OpenRouter resets
  // daily limits, so calls go back to the first key at once (connections.ts serverKey()).
  if (process.env.OPENROUTER_API_KEY) keyStatus();
  setInterval(() => { if (process.env.OPENROUTER_API_KEY) keyStatus(); }, Number(process.env.RF_KEY_TTL_MS ?? 180_000)).unref();
  const midnight = () => setTimeout(() => { if (process.env.OPENROUTER_API_KEY) refreshKeys(); midnight(); }, 86_400_000 - (Date.now() % 86_400_000) + 30_000).unref();
  midnight();
  checkLogins(connections().map(loginOf).flatMap(l => l.scope ? [l] : []));
  console.log(`rollforward on http://${host}:${port}, data in ${root}${process.env.RF_TODAY ? `, skills take today as ${process.env.RF_TODAY} (RF_TODAY)` : ''}`);
});
