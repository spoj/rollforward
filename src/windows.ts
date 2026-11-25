import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { asPerson, can, windowsConfigured } from './auth.ts';
import { lender, ownerOf, sameAuthority } from './logins.ts';
import type { Authority } from './series.ts';
import { HttpError, instance, openFile, type Instance } from './store.ts';
import { replaceFile, rfDir } from './system.ts';

// Windows workers: Windows machines that reach nothing but this server, at RF_WINDOWS_LISTEN over TLS with a key of their own each
// (RF_WINDOWS_KEYS, name:key pairs), and run a run's commands in a signed-in desktop session, so desktop Office and whatever else
// is installed there works as it does for a person, COM and macros included. A run submits a job at $RF_WINDOWS/jobs: a PowerShell
// command line and a snapshot of files from its working/, taken as it submits; a worker leases the oldest queued job, runs it in a
// fresh folder, streams its output back and hands back what it left in $env:RF_OUT. A job may wake its instance as it ends, under
// the authority its run captured, which then needs autonomous consent (standing() in waker.ts). Jobs are kept in .rf/windows/jobs,
// so a restart loses none, and go 14 days after they end. A job is any command, so none is retried: what was lost is the agent's to
// judge. The machine is the boundary: it holds no credentials and reaches nothing else, so what a command does there stays there.

// Windows' own limit on a path is 260 characters, of which a worker's folder for the job takes some.
const MAX_COMMAND = 32 * 1024, MAX_LABEL = 200, MAX_PATH = 200, MAX_FILES = 1000;
const MAX_IN_BYTES = 2 ** 30, MAX_OUT_BYTES = 2 * 2 ** 30, MAX_LOG_BYTES = 16 * 2 ** 20, LOG_SLICE = 2 ** 20, MAX_BODY = 2 ** 20;
const DEFAULT_TIMEOUT_S = 3600, MAX_TIMEOUT_S = 86_400, MAX_WAIT_S = 300, MAX_LEASE_WAIT_S = 30;
const LOST_MS = 120_000, GRACE_MS = 120_000, KEEP_MS = 14 * 86_400_000, SEEN_MS = 90_000, SWEEP_MS = 15_000, MAX_OPEN_JOBS = 16, MAX_KEPT_JOBS = 100;
const ENDS = ['done', 'failed', 'timeout', 'canceled', 'lost'] as const;
// Names Windows takes for devices, whatever their extension.
const DEVICES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

type FileRec = { path: string; sha256: string; size: number };
type State = 'queued' | 'running' | (typeof ENDS)[number];
// started is when a worker took it, ran when its command started, from which its timeout counts.
export type Job = {
  id: string; inst: string; run: number; authority: Authority; command: string; files: FileRec[]; timeout: number; wake: boolean; label?: string;
  state: State; submitted: string; started?: string; ran?: string; ended?: string; exit?: number; error?: string; worker?: string; cancel?: boolean;
  out: FileRec[]; logBytes: number; logTruncated?: boolean;
};
// What the server knows of a run that asks: its instance, its number, its runner and captured lease, its working/, and whether its
// token still counts.
export type WindowsRun = { inst: Instance; n: number; runner: string; authority: Authority; working: string; live(): boolean };
export type JobWake = { from: 'server'; job: string; text: string; authority: Authority; initiator: string };
type Worker = { inventory: unknown; seen: number };
type Parked = { key: Key; give(job: Job | undefined): void };
// A worker's key, by its digest, and the workspaces whose jobs it takes, or all.
type Key = { name: string; key: Buffer; workspaces: string[] | '*' };

const table = new Map<string, Job>(), beats = new Map<string, number>(), workers = new Map<string, Worker>(), parked = new Set<Parked>();
const ends = new EventEmitter().setMaxListeners(0), reserved = new Map<string, number>();
let keys: Key[] = [], server: Server | undefined, timer: NodeJS.Timeout | undefined, wake: (inst: Instance, w: JobWake) => void = () => {};

export const windowsEnabled = windowsConfigured;
export const listJobs = () => [...table.values()];
const isEnded = (s: State) => (ENDS as readonly string[]).includes(s);
const jobsDir = () => join(rfDir(), 'windows', 'jobs');
const save = (job: Job) => replaceFile(join(jobsDir(), job.id, 'job.json'), JSON.stringify(job));
const digest = (s: string) => createHash('sha256').update(s).digest();
const serves = (k: Key | undefined, workspace: string) => !!k && (k.workspaces === '*' || k.workspaces.includes(workspace));

// name:key:workspaces triples, names of a-z, 0-9 and -, each name and key once, and the workspaces' ids, comma-separated, or *
// for all: a job's command can read its worker's key, so a worker shared by workspaces lets each's jobs reach the others'.
function parseKeys(text: string): Key[] {
  const triples = text.trim().split(/\s+/).map(t => t.split(':'));
  if (!triples.length || triples.some(t => t.length !== 3 || !/^[a-z0-9-]+$/.test(t[0]) || !t[1] || !/^(\*|[^,\s*]+(,[^,\s*]+)*)$/.test(t[2]))
    || new Set(triples.map(t => t[0])).size < triples.length || new Set(triples.map(t => t[1])).size < triples.length)
    throw new Error('RF_WINDOWS_KEYS: whitespace-separated name:key:workspaces, names of a-z, 0-9 and -, each name and key once, workspaces their ids, comma-separated, or * for all');
  return triples.map(([name, key, ws]) => ({ name, key: digest(key), workspaces: ws === '*' ? '*' : ws.split(',') }));
}
// The worker a bearer key is, compared in constant time with every key.
function workerOf(authorization: string | undefined): Key | undefined {
  const given = digest(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  let found: Key | undefined;
  for (const k of keys) if (timingSafeEqual(given, k.key)) found = k;
  return found;
}

export async function startWindows(o: { wake(inst: Instance, w: JobWake): void }): Promise<Server | undefined> {
  if (!windowsConfigured()) return undefined;
  const env = process.env, at = env.RF_WINDOWS_LISTEN!.lastIndexOf(':'), host = env.RF_WINDOWS_LISTEN!.slice(0, at), port = Number(env.RF_WINDOWS_LISTEN!.slice(at + 1));
  if (at < 1 || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('RF_WINDOWS_LISTEN: HOST:PORT, such as 10.0.0.5:8781');
  keys = parseKeys(env.RF_WINDOWS_KEYS!);
  wake = o.wake;
  loadJobs();
  stopWindows();
  const s = server = createServer({ cert: readFileSync(env.RF_WINDOWS_TLS_CERT!), key: readFileSync(env.RF_WINDOWS_TLS_KEY!), requestTimeout: 0 }, (req, res) =>
    void serveWorker(req, res).catch(e => fail(res, e)));
  await new Promise<void>((ok, bad) => s.once('error', bad).listen(port, host, () => { s.off('error', bad); ok(); }));
  timer = setInterval(() => sweep(), SWEEP_MS).unref();
  return s;
}

export function stopWindows() {
  clearInterval(timer);
  for (const p of parked) p.give(undefined);
  server?.closeAllConnections();
  server?.close();
  server = undefined;
}

// From disk, as the server starts: a running job's worker has LOST_MS from now to beat again, as across a restart it couldn't. A
// job's file the server can't read, as one a crash cut short, is reported and left, never stopping the start.
export function loadJobs() {
  table.clear();
  beats.clear();
  if (!existsSync(jobsDir())) return;
  for (const id of readdirSync(jobsDir())) {
    const file = join(jobsDir(), id, 'job.json');
    if (!existsSync(file)) { rmSync(join(jobsDir(), id), { recursive: true, force: true }); continue; }
    let job: Job;
    try { job = JSON.parse(readFileSync(file, 'utf8')) as Job; } catch (e) { console.error(`windows: skipping ${file}: ${(e as Error).message}`); continue; }
    table.set(job.id, job);
    if (job.state === 'running') beats.set(job.id, Date.now());
  }
}

// Each tick, each job by itself, so one the server can't handle holds up no other: a running job past its timeout, with grace for
// its worker to say so, times out; one whose worker stopped beating is lost; one whose instance was deleted, or whose run's
// authority or owner's capability ended, is canceled, its worker killing it at its next beat; an ended one goes, files and all,
// past its keeping, or at once when its instance was deleted.
export function sweep(now = Date.now()) {
  for (const job of [...table.values()]) {
    try {
      const why = isEnded(job.state) ? undefined : unfit(job);
      if (job.state === 'running' && job.ran && Date.parse(job.ran) + job.timeout * 1000 + GRACE_MS < now) finish(job, 'timeout', { error: 'its worker did not end it within its timeout' });
      else if (job.state === 'running' && (beats.get(job.id) ?? 0) + LOST_MS < now) finish(job, 'lost', { error: 'its worker stopped answering' });
      else if (job.state === 'queued' && why) finish(job, 'canceled', { error: why });
      else if (job.state === 'running' && why && !job.cancel) {
        Object.assign(job, { cancel: true, error: why });
        save(job);
        appendEntry(job, { action: 'cancel', why });
      } else if (job.ended && (Date.parse(job.ended) + KEEP_MS < now || gone(job))) {
        table.delete(job.id);
        rmSync(join(jobsDir(), job.id), { recursive: true, force: true });
      }
    } catch (e) { console.error(`windows: sweeping ${job.id}: ${(e as Error).message}`); }
  }
}
const gone = (job: Job) => { try { return instance(job.inst).hole; } catch { return true; } };

// A path as both sides take it: relative, normal, of plain parts, with nothing Windows reads otherwise, such as a drive, a stream,
// a device's name or a part ending in a dot or space, which it drops.
function validPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && posix.normalize(p) === p && !p.startsWith('/') && !p.endsWith('/')
    && !/[\\:*?"<>|\x00-\x1f\x7f]/.test(p) && p.split('/').every(s => s !== '.' && s !== '..' && !/[. ]$/.test(s) && !DEVICES.test(s));
}
const pathOf = (parts: string[]) => { try { return parts.map(decodeURIComponent).join('/'); } catch { return ''; } };

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `a body of at most ${max} bytes`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
async function jsonBody(req: IncomingMessage, max?: number): Promise<Record<string, unknown>> {
  const text = (await readBody(req, max)).toString() || '{}';
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, 'a JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'a JSON object');
  return value as Record<string, unknown>;
}
const send = (res: ServerResponse, status: number, data: unknown) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
function fail(res: ServerResponse, e: unknown) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(e instanceof HttpError ? e.status : 500, { 'content-type': 'text/plain; charset=utf-8' }).end(e instanceof Error ? e.message : String(e));
}
const view = ({ authority: _a, cancel: _c, ...job }: Job) => job;

// ---- A run's side, $RF_WINDOWS.

const HELP = `Windows workers: Windows machines that reach nothing but this server, signed in to a desktop session, so desktop Office
(Excel, Word, PowerPoint, with COM automation and VBA macros) and whatever else is installed there works as it does for a person.
A job is one PowerShell command line, run with powershell.exe in a fresh folder holding a snapshot of the files you name from
your working/, at the same relative paths, taken as you submit; what it leaves in $env:RF_OUT comes back as its outputs, and its
output and errors as its log. Nothing is retried: a lost or failed job is yours to submit again.

GET  $RF_WINDOWS                       this, and the workers seen lately with what each reported it has
POST $RF_WINDOWS/jobs                  {"command": "...", "files": ["fill.ps1", "in/data.xlsx"], "timeout": 3600, "wait": 60,
                                        "wake": true, "label": "..."}: 202 with the job, or 200 with it ended within wait
GET  $RF_WINDOWS/jobs                  this instance's jobs, newest first
GET  $RF_WINDOWS/jobs/ID               a job: state queued, running, done (exit is powershell.exe's: end with exit $LASTEXITCODE to
                                        pass a program's on), failed (the worker's own error), timeout, canceled or lost (its worker
                                        stopped answering)
GET  $RF_WINDOWS/jobs/ID/log?from=N    its log from byte N; x-rf-next is where the next read starts
GET  $RF_WINDOWS/jobs/ID/out/PATH      an output, as listed in the job's out
POST $RF_WINDOWS/jobs/ID/cancel        a queued job ends at once; a running one's worker kills it within a beat

command is at most ${MAX_COMMAND} bytes; files at most ${MAX_FILES}, ${MAX_IN_BYTES / 2 ** 30} GiB in all, relative paths of at most
${MAX_PATH} characters with no link, no . or .. part, no part ending in a dot or space or named as a device (CON, NUL, COM1...),
none of \\ : * ? " < > |, and no two alike but for case; timeout 1-${MAX_TIMEOUT_S} seconds (default ${DEFAULT_TIMEOUT_S}) from the
command's start, after which its processes are killed, Office's that it started with them; wait 0-${MAX_WAIT_S} seconds. wake wakes
this instance as the job ends, as your series owner, when its series has autonomous consent, captured by this run and current, so
you may end this run and carry on then; without it, poll. An instance has at most ${MAX_OPEN_JOBS} jobs queued or running and
${MAX_KEPT_JOBS} kept; outputs are kept ${KEEP_MS / 86_400_000} days after a job ends, so copy what you keep into working/. A worker runs
one job at a time, oldest first; the jobs a worker runs share its machine, so a job may find traces of earlier ones there.`;

function admit(r: WindowsRun) {
  if (!server) throw new HttpError(404, 'no Windows workers are configured');
  if (!r.live()) throw new HttpError(409, 'its run has ended');
  lender(r.inst, r.n);
  const owner = asPerson(r.runner);
  if (!owner || !can(owner, 'windows')) throw new HttpError(403, 'your series owner has no windows capability');
}

export async function serveWindows(r: WindowsRun, rest: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    admit(r);
    const url = new URL(req.url!, 'http://sandbox'), [root, id, what, ...more] = rest.filter((p, i) => p || i < rest.length - 1), method = req.method;
    if (!root && method === 'GET') return void res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`${HELP}\n\n${seenWorkers(r.authority.workspace)}\n`);
    if (root !== 'jobs') throw new HttpError(404, 'not found: curl $RF_WINDOWS');
    if (!id && method === 'POST') return await submit(r, req, res);
    if (!id && method === 'GET') return send(res, 200, [...table.values()].filter(j => j.inst === r.inst.id).sort((a, b) => b.submitted.localeCompare(a.submitted)).map(view));
    const job = table.get(id);
    if (!job || job.inst !== r.inst.id) throw new HttpError(404, `no job ${id} of this instance`);
    if (!what && method === 'GET') return send(res, 200, view(job));
    if (what === 'log' && !more.length && method === 'GET') return readLog(job, url, res);
    if (what === 'out' && method === 'GET') return serveOut(job, pathOf(more), res);
    if (what === 'cancel' && !more.length && method === 'POST') return send(res, 200, view(cancel(job)));
    throw new HttpError(404, 'not found: curl $RF_WINDOWS');
  } catch (e) { fail(res, e); }
}

// The workers that take this workspace's jobs, as they reported themselves lately.
function seenWorkers(workspace: string): string {
  const now = Date.now(), seen = [...workers.entries()].filter(([name, w]) => now - w.seen < SEEN_MS && serves(keys.find(k => k.name === name), workspace));
  return seen.length ? `Workers seen lately:\n${seen.map(([name, w]) => `${name}, ${Math.round((now - w.seen) / 1000)}s ago: ${JSON.stringify(w.inventory)}`).join('\n')}`
    : 'No worker for this workspace has been seen lately: a job waits queued until one asks.';
}

function intIn(v: unknown, name: string, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new HttpError(400, `${name}: a whole number ${min}-${max}`);
  return v as number;
}

async function submit(r: WindowsRun, req: IncomingMessage, res: ServerResponse) {
  const b = await jsonBody(req, MAX_COMMAND + MAX_FILES * (MAX_PATH + 8) + 4096);
  admit(r);
  const { command, files = [], label } = b;
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > MAX_COMMAND) throw new HttpError(400, `command: a PowerShell command line of at most ${MAX_COMMAND} bytes`);
  if (!Array.isArray(files) || files.length > MAX_FILES || !files.every(validPath) || new Set(files.map(f => f.toLowerCase())).size < files.length)
    throw new HttpError(400, `files: at most ${MAX_FILES} relative paths under working/, as curl $RF_WINDOWS says`);
  if (label !== undefined && (typeof label !== 'string' || label.length > MAX_LABEL)) throw new HttpError(400, `label: at most ${MAX_LABEL} characters`);
  const timeout = intIn(b.timeout, 'timeout', 1, MAX_TIMEOUT_S, DEFAULT_TIMEOUT_S), wait = intIn(b.wait, 'wait', 0, MAX_WAIT_S, 0);
  if (b.wake !== undefined && typeof b.wake !== 'boolean') throw new HttpError(400, 'wake: true or false');
  if (b.wake && !(r.authority.autonomous && ownerOf(r.inst).consent?.autonomous))
    throw new HttpError(400, 'wake: needs the series\' autonomous consent, captured by this run and current; poll the job instead');
  const mine = [...table.values()].filter(j => j.inst === r.inst.id), taking = reserved.get(r.inst.id) ?? 0;
  if (mine.filter(j => !isEnded(j.state)).length + taking >= MAX_OPEN_JOBS)
    throw new HttpError(429, `this instance has ${MAX_OPEN_JOBS} jobs queued or running: one must end first`);
  if (mine.length + taking >= MAX_KEPT_JOBS) throw new HttpError(429, `this instance keeps ${MAX_KEPT_JOBS} jobs: older ones go ${KEEP_MS / 86_400_000} days after they end`);
  // Held while its files are copied, so submissions at once count against the limits too.
  reserved.set(r.inst.id, taking + 1);
  const id = `w-${randomBytes(6).toString('hex')}`, dir = join(jobsDir(), id);
  let snapshot: FileRec[];
  try {
    mkdirSync(join(dir, 'in'), { recursive: true, mode: 0o700 });
    snapshot = await snapshotFiles(r.working, files as string[], join(dir, 'in'));
    admit(r);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    const left = (reserved.get(r.inst.id) ?? 1) - 1;
    if (left) reserved.set(r.inst.id, left); else reserved.delete(r.inst.id);
  }
  const job: Job = {
    id, inst: r.inst.id, run: r.n, authority: r.authority, command, files: snapshot, timeout, wake: !!b.wake, ...(label && { label: label as string }),
    state: 'queued', submitted: new Date().toISOString(), out: [], logBytes: 0,
  };
  save(job);
  table.set(id, job);
  r.inst.append('server', 'windows', { run: r.n, job: id, action: 'submit', command, files: snapshot, timeout, wake: job.wake, ...(job.label && { label: job.label }) });
  offer();
  if (wait && !isEnded(job.state)) await ended(id, wait * 1000, res);
  send(res, isEnded(job.state) ? 200 : 202, view(job));
}

// The files as they are now, each a regular file reached with no link (openFile), copied in with their digests.
async function snapshotFiles(working: string, files: string[], into: string): Promise<FileRec[]> {
  const recs: FileRec[] = [];
  let total = 0;
  for (const path of files) {
    const fd = openFile(working, path);
    if (fd === undefined) throw new HttpError(400, `${path}: no regular file there in working/, reached without a link`);
    const hash = createHash('sha256');
    let size = 0;
    mkdirSync(join(into, posix.dirname(path)), { recursive: true });
    await pipeline(createReadStream('', { fd }), async function* (src) {
      for await (const chunk of src as AsyncIterable<Buffer>) {
        size += chunk.length;
        if ((total += chunk.length) > MAX_IN_BYTES) throw new HttpError(413, `files: at most ${MAX_IN_BYTES} bytes in all`);
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(join(into, path), { flags: 'wx', mode: 0o600 }));
    recs.push({ path, sha256: hash.digest('hex'), size });
  }
  return recs;
}

// Until the job ends, `ms` pass or the run's request goes.
function ended(id: string, ms: number, res: ServerResponse): Promise<void> {
  return new Promise(ok => {
    const done = () => { clearTimeout(t); ends.off(id, done); res.off('close', done); ok(); };
    const t = setTimeout(done, ms);
    ends.on(id, done);
    res.on('close', done);
  });
}

function readLog(job: Job, url: URL, res: ServerResponse) {
  const from = Number(url.searchParams.get('from') ?? 0);
  if (!Number.isSafeInteger(from) || from < 0) throw new HttpError(400, 'from: a byte offset');
  const file = join(jobsDir(), job.id, 'log'), size = existsSync(file) ? statSync(file).size : 0, start = Math.min(from, size);
  const buf = Buffer.alloc(Math.min(LOG_SLICE, size - start));
  if (buf.length) {
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-rf-next': String(start + buf.length) }).end(buf);
}

function serveOut(job: Job, path: string, res: ServerResponse) {
  if (!validPath(path)) throw new HttpError(400, 'a relative output path, as the job lists');
  const rec = job.out.find(o => o.path === path);
  if (!rec) throw new HttpError(404, `no output ${path}`);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(rec.size) });
  createReadStream(join(jobsDir(), job.id, 'out', path)).on('error', () => res.destroy()).pipe(res);
}

function cancel(job: Job): Job {
  if (job.state === 'queued') {
    appendEntry(job, { action: 'cancel' });
    finish(job, 'canceled', { error: 'canceled before a worker took it' });
  } else if (job.state === 'running' && !job.cancel) {
    job.cancel = true;
    save(job);
    appendEntry(job, { action: 'cancel' });
  }
  return job;
}

function appendEntry(job: Job, fields: Record<string, unknown>) {
  let inst: Instance;
  try { inst = instance(job.inst); } catch { return undefined; }
  inst.append('server', 'windows', { run: job.run, job: job.id, ...fields });
  return inst;
}

// A job ends once: its entry says how, with its outputs' digests, its files' copy goes, and it wakes its instance if it asked to,
// in the server's words alone, as the wake speaks as the series owner and a worker's error is the machine's to say.
function finish(job: Job, state: (typeof ENDS)[number], o: { exit?: number; error?: string } = {}) {
  if (isEnded(job.state)) return;
  Object.assign(job, { state, ended: new Date().toISOString(), cancel: undefined }, o.exit !== undefined && { exit: o.exit }, o.error && { error: o.error });
  save(job);
  beats.delete(job.id);
  ends.emit(job.id);
  rmSync(join(jobsDir(), job.id, 'in'), { recursive: true, force: true });
  const seconds = job.started ? Math.round((Date.parse(job.ended!) - Date.parse(job.started)) / 1000) : undefined;
  const inst = appendEntry(job, { action: 'end', state, ...(job.exit !== undefined && { exit: job.exit }), ...(job.error && { error: job.error }),
    ...(job.worker && { worker: job.worker }), ...(seconds !== undefined && { seconds }), out: job.out, logBytes: job.logBytes });
  if (!job.wake || !inst || inst.doc.status !== 'open') return;
  const text = `Windows job ${job.id}${job.label ? ` (${JSON.stringify(job.label)})` : ''} ended: ${state}${job.exit !== undefined ? `, exit ${job.exit}` : ''}`
    + `, ${job.out.length} output${job.out.length === 1 ? '' : 's'}; curl $RF_WINDOWS/jobs/${job.id}`;
  try {
    wake(inst, { from: 'server', job: job.id, text, authority: job.authority, initiator: job.authority.owner });
  } catch (e) { console.error(`windows: waking ${inst.id} for ${job.id}: ${(e as Error).message}`); }
}

// ---- The workers' side, RF_WINDOWS_LISTEN.

// Why a job may not run any more: its instance or its run's authority ended, or its owner's capability did.
function unfit(job: Job): string | undefined {
  let inst: Instance;
  try { inst = instance(job.inst); } catch { return 'its instance is gone'; }
  if (inst.doc.status !== 'open') return 'its instance is no longer open';
  if (!sameAuthority(inst, job.authority)) return 'its series authority ended';
  const owner = asPerson(job.authority.owner);
  if (!owner || !can(owner, 'windows')) return 'its series owner no longer has the windows capability';
}

// The oldest queued job of the workspaces the worker takes. One the server can't judge fails, rather than hold up the queue.
function take(k: Key): Job | undefined {
  for (const job of [...table.values()].filter(j => j.state === 'queued' && serves(k, j.authority.workspace)).sort((a, b) => a.submitted.localeCompare(b.submitted))) {
    try {
      const why = unfit(job);
      if (why) { finish(job, 'canceled', { error: why }); continue; }
      Object.assign(job, { state: 'running', worker: k.name, started: new Date().toISOString() });
      beats.set(job.id, Date.now());
      save(job);
      return job;
    } catch (e) {
      console.error(`windows: handing out ${job.id}: ${(e as Error).message}`);
      try { finish(job, 'failed', { error: 'the server could not hand it out' }); } catch { table.delete(job.id); }
    }
  }
}
// Queued jobs to the workers waiting for one, longest waiting first.
function offer() {
  for (const p of parked) {
    const job = take(p.key);
    if (job) p.give(job);
  }
}
const manifest = (job: Job) => ({ id: job.id, command: job.command, timeout: job.timeout, files: job.files });

async function lease(k: Key, url: URL, res: ServerResponse) {
  const waitS = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), MAX_LEASE_WAIT_S);
  const now = take(k);
  if (now || !waitS) return now ? send(res, 200, manifest(now)) : void res.writeHead(204).end();
  const job = await new Promise<Job | undefined>(ok => {
    const p: Parked = { key: k, give: job => { clearTimeout(t); parked.delete(p); res.off('close', gone); ok(job); } };
    const gone = () => p.give(undefined), t = setTimeout(gone, waitS * 1000);
    res.on('close', gone);
    parked.add(p);
  });
  // A job given as its worker's connection broke is lost once it doesn't beat.
  if (job) send(res, 200, manifest(job));
  else if (!res.writableEnded) res.writeHead(204).end();
}

async function serveWorker(req: IncomingMessage, res: ServerResponse) {
  const k = workerOf(req.headers.authorization);
  if (!k) throw new HttpError(401, 'no worker for this key');
  const name = k.name, url = new URL(req.url!, 'https://worker'), [, root, what, id, part, ...more] = url.pathname.split('/'), method = req.method;
  if (root !== 'worker') throw new HttpError(404, 'not found');
  const w = workers.get(name) ?? { inventory: null, seen: 0 };
  workers.set(name, { ...w, seen: Date.now() });
  if (what === 'hello' && method === 'POST') {
    const { inventory = null } = await jsonBody(req, 64 * 1024);
    workers.set(name, { inventory, seen: Date.now() });
    return send(res, 200, { name });
  }
  if (what === 'lease' && method === 'POST') return lease(k, url, res);
  if (what !== 'jobs') throw new HttpError(404, 'not found');
  const job = table.get(id);
  if (!job || job.worker !== name || job.state !== 'running') throw new HttpError(409, `${id} is no running job of ${name}'s`);
  if (part === 'in' && method === 'GET') {
    const path = pathOf(more), rec = job.files.find(f => f.path === path);
    if (!validPath(path) || !rec) throw new HttpError(404, `no input ${path}`);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(rec.size) });
    return void createReadStream(join(jobsDir(), id, 'in', path)).on('error', () => res.destroy()).pipe(res);
  }
  if (part === 'log' && method === 'POST') return appendLog(job, req, res);
  if (part === 'beat' && method === 'POST') {
    beats.set(id, Date.now());
    // Its command starting, from which its timeout counts: what came before was its files' coming.
    if (url.searchParams.has('running') && !job.ran) { job.ran = new Date().toISOString(); save(job); }
    return send(res, 200, { cancel: !!job.cancel });
  }
  if (part === 'out' && method === 'PUT') return await receiveOut(job, pathOf(more), req, res);
  if (part === 'end' && method === 'POST') {
    const b = await jsonBody(req, 64 * 1024);
    if (!['done', 'failed', 'timeout', 'canceled'].includes(b.state as string)) throw new HttpError(400, 'state: done, failed, timeout or canceled');
    if (b.exit !== undefined && !Number.isSafeInteger(b.exit)) throw new HttpError(400, 'exit: a whole number');
    if (b.error !== undefined && (typeof b.error !== 'string' || b.error.length > 2000)) throw new HttpError(400, 'error: at most 2000 characters');
    if (table.get(id) !== job || job.state !== 'running') throw new HttpError(409, `${id} is no running job of ${name}'s`);
    finish(job, b.state as 'done', { exit: b.exit as number | undefined, error: b.error as string | undefined });
    return send(res, 200, view(job));
  }
  throw new HttpError(404, 'not found');
}

// Its output and errors as they come, kept to MAX_LOG_BYTES: past that the rest is dropped and the job says so.
async function appendLog(job: Job, req: IncomingMessage, res: ServerResponse) {
  const chunk = await readBody(req), room = MAX_LOG_BYTES - job.logBytes, kept = chunk.subarray(0, Math.max(0, room));
  if (kept.length) appendFileSync(join(jobsDir(), job.id, 'log'), kept, { mode: 0o600 });
  job.logBytes += kept.length;
  if (kept.length < chunk.length) job.logTruncated = true;
  if (chunk.length) save(job);
  beats.set(job.id, Date.now());
  send(res, 200, { logBytes: job.logBytes });
}

// An output, streamed to a file of its own and renamed into place, so one sent again, as after a broken connection, replaces it.
async function receiveOut(job: Job, path: string, req: IncomingMessage, res: ServerResponse) {
  if (!validPath(path)) throw new HttpError(400, 'a relative output path, with no . or .. part and none of \\ : * ? " < > |');
  const others = job.out.filter(o => o.path !== path), used = others.reduce((n, o) => n + o.size, 0);
  if (others.length >= MAX_FILES) throw new HttpError(413, `at most ${MAX_FILES} outputs`);
  const dir = join(jobsDir(), job.id, 'out'), dest = join(dir, path), part = join(jobsDir(), job.id, `.part-${randomBytes(4).toString('hex')}`);
  try { mkdirSync(posix.dirname(dest), { recursive: true }); } catch { throw new HttpError(400, `${path}: a folder of it is an output already`); }
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (used + size > MAX_OUT_BYTES) throw new HttpError(413, `outputs: at most ${MAX_OUT_BYTES} bytes in all`);
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(part, { mode: 0o600 }));
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw (e as NodeJS.ErrnoException).code === 'EISDIR' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? new HttpError(400, `${path}: a folder there is an output's`) : e;
  }
  if (table.get(job.id) !== job || job.state !== 'running') throw new HttpError(409, `${job.id} ended as it was sent`);
  job.out = [...others, { path, sha256: hash.digest('hex'), size }].sort((a, b) => a.path.localeCompare(b.path));
  save(job);
  beats.set(job.id, Date.now());
  send(res, 200, { path, size });
}
