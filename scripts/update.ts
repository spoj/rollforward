// Moves this checkout to the newest release CI made and restarts the server, once the runs going have ended, or RF_DRAIN_MIN has
// passed: those it cuts carry on after the restart. A systemd timer runs it (docs/deploy.md), and never twice at once. A release is taken once every check on its commit has passed, and never past a prerelease, which a tag with
// a Manual: line makes for a release that needs a person first. What it installs, its packages and its agent image, is fetched
// before the server stops, so a failure there, as without the network, changes nothing, and the next tick tries again. If the
// server doesn't answer HEALTH after the move, the checkout goes back, and that release isn't tried again; if going back fails too,
// the server starts as the checkout is, never left stopped.
//   node scripts/update.ts HEALTH
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentId, download, id, remove, unpack } from '../src/agent.ts';

const repo = 'spoj/rollforward', health = process.argv[2], limit = Number(process.env.RF_DRAIN_MIN ?? 15) * 60_000;
if (!Number.isFinite(limit) || limit < 0 || limit > 2_147_483_647) throw new Error('RF_DRAIN_MIN must be between 0 and 35791 minutes');
const app = join(dirname(fileURLToPath(import.meta.url)), '..'), state = join(homedir(), '.local', 'state', 'rollforward-update.json');
const sh = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
async function github(path: string) {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
  return r.json();
}
const parts = (tag: string) => tag.slice(1).split('.').map(Number);
const later = (a: string, b: string) => { const x = parts(a), y = parts(b), i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] > y[i]; };

let current = '';
try {
  // A release's commit may carry an image's agent-<id> tag too.
  current = sh('git', 'describe', '--tags', '--exact-match', '--match', 'v[0-9]*', 'HEAD');
} catch {
  console.log(`the checkout is at ${sh('git', 'rev-parse', '--short', 'HEAD')}, on no release: updates wait until a person checks one out`);
  process.exit(1);
}
const bad: string[] = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).bad : [];
const releases = (await github('/releases?per_page=100')).filter((r: any) => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name) && later(r.tag_name, current))
  .sort((a: any, b: any) => (later(a.tag_name, b.tag_name) ? 1 : -1));
const stop = releases.findIndex((r: any) => r.prerelease);
if (stop >= 0) console.log(`${releases[stop].tag_name} needs a person first: ${releases[stop].html_url}`);
const target: string | undefined = releases.slice(0, stop < 0 ? undefined : stop).map((r: any) => r.tag_name).filter((t: string) => !bad.includes(t)).at(-1);
if (!target) process.exit(0);
const checks = (await github(`/commits/${target}/check-runs?per_page=100`)).check_runs;
if (!checks.length || checks.some((c: any) => c.status !== 'completed' || !['success', 'skipped'].includes(c.conclusion))) {
  console.log(`${target} waits for its checks to pass`);
  process.exit(0);
}

// The server drained, so the runs going end on the release they started on rather than being cut: on SIGUSR2 it starts no run, for
// RF_DRAIN_MIN from the latest signal, and GET /drained answers 200 once none goes. It's signalled and polled until then, or
// RF_DRAIN_MIN, or its restart meanwhile, and stopped all the same; this dead, its drain ends by itself. One that knows no drain,
// as an older server, answers /drained otherwise, and isn't signalled, which would kill it.
async function drain() {
  if (!limit) return;
  const pid = () => sh('systemctl', '--user', 'show', '--property=MainPID', '--value', 'rollforward'), was = pid();
  const end = Date.now() + limit;
  const drained = () => fetch(new URL('/drained', health), { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, end - Date.now()))) }).then(r => r.status, () => 0);
  if (!Number(was) || ![200, 503].includes(await drained()) || pid() !== was) return;
  for (; pid() === was; ) {
    try { process.kill(Number(was), 'SIGUSR2'); } catch { return; }
    if (await drained() === 200) return;
    if (Date.now() >= end) {
      console.log('the runs still going are cut');
      return;
    }
    await sleep(Math.min(2000, end - Date.now()));
  }
}

// The checkout at `to`, with what changed since `from` installed, and the server started on it. It stops first, so the old process
// never serves the new files; the runs it cuts end as aborted, and their instances are woken to carry on as it starts.
function move(from: string, to: string) {
  sh('systemctl', '--user', 'stop', 'rollforward');
  sh('git', 'checkout', '-q', '--detach', to);
  if (changed(from, to, 'package-lock.json')) sh('npm', 'ci', '--omit=dev', '--no-audit', '--no-fund', '--offline');
  sh('systemctl', '--user', 'start', 'rollforward');
}
const changed = (from: string, to: string, file: string) => !!sh('git', 'diff', '--name-only', from, to, '--', file);
// A start may take a while, as one that moves data does.
async function answers() {
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    if (await fetch(health).then(r => r.ok, () => false)) return true;
  }
  return false;
}

console.log(`${current} -> ${target}`);
sh('git', 'fetch', '-q', '--tags', 'origin');
// What the target installs: its packages into npm's cache, from which the move installs them, and the move back what this one has;
// and its agent image, unpacked beside this one's, which a move back still has.
const tmp = mkdtempSync(join(tmpdir(), 'rollforward-update-'));
const image = agentId(sh('git', 'ls-tree', '--name-only', target, 'agent/').split('\n').map(f => [basename(f), execFileSync('git', ['show', `${target}:${f}`], { cwd: app })]));
try {
  if (changed(current, target, 'package-lock.json')) {
    for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(tmp, f), sh('git', 'show', `${target}:${f}`));
    sh('npm', 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefix', tmp);
  }
  if (!existsSync(join(AGENTS, image))) {
    if (!(await download(image, join(tmp, 'agent.tar.zst')))) throw new Error(`agent-${image}, which ${target} runs, isn't published`);
    await unpack(image, join(tmp, 'agent.tar.zst'));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
// A release on the way with a line starting Urgent: in its tag's message, which CI makes its notes, cuts the runs at once.
const urgent = releases.slice(0, releases.findIndex((r: any) => r.tag_name === target) + 1).find((r: any) => /^Urgent:/m.test(r.body ?? ''));
if (urgent) console.log(`${urgent.tag_name} is urgent: the runs going are cut`);
else await drain();
try {
  move(current, target);
  if (await answers()) {
    // Only this image and the one before, for a person's move back, are kept.
    for (const d of readdirSync(AGENTS)) if (![image, id].includes(d)) remove(join(AGENTS, d));
    console.log(`on ${target}`);
    process.exit(0);
  }
  console.log(`${target} didn't answer ${health}`);
} catch (e) {
  console.log(`${target} failed: ${(e as Error).message}`);
}
// Recorded first, so a way back that fails too doesn't try that release again at the next tick.
mkdirSync(dirname(state), { recursive: true });
writeFileSync(state, JSON.stringify({ bad: [...bad, target] }));
try {
  move(target, current);
  console.log(`back on ${current}; ${target} won't be tried again`);
} catch (e) {
  console.log(`going back to ${current} failed: ${(e as Error).message}; the server starts as the checkout is, and ${target} won't be tried again`);
  sh('systemctl', '--user', 'restart', 'rollforward');
}
process.exitCode = 1;
