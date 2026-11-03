// Moves this checkout to the newest release CI made, then restarts the server once the runs going end: a systemd timer runs it
// (docs/deploy.md), and never twice at once. A release is taken once every check on its commit has passed, and never past a prerelease, which a tag with
// a Manual: line makes for a release that needs a person first. If the server doesn't answer HEALTH after the move, the checkout
// goes back, and that release isn't tried again.
//   node scripts/update.ts HEALTH
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = 'spoj/rollforward', health = process.argv[2];
const app = join(dirname(fileURLToPath(import.meta.url)), '..'), state = join(homedir(), '.local', 'state', 'rollforward-update.json');
const sh = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
async function github(path: string) {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
  return r.json();
}
const parts = (tag: string) => tag.slice(1).split('.').map(Number);
const later = (a: string, b: string) => { const x = parts(a), y = parts(b), i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] > y[i]; };

const current = sh('git', 'describe', '--tags', '--exact-match', 'HEAD');
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

// The checkout at `to`, with what changed since `from` installed, and the server restarted. It drains first, on SIGUSR2: no run
// starts, and it exits once those going end, or after 30 minutes, for systemd to start it again; a stopped one is started.
async function move(from: string, to: string) {
  sh('git', 'checkout', '-q', '--detach', to);
  if (sh('git', 'diff', '--name-only', from, to, '--', 'package-lock.json')) sh('npm', 'ci', '--omit=dev', '--no-audit', '--no-fund');
  if (sh('git', 'diff', '--name-only', from, to, '--', 'requirements.txt')) sh('uv', 'pip', 'install', '--python', '.venv/bin/python', '-r', 'requirements.txt');
  const pid = () => sh('systemctl', '--user', 'show', '--property=MainPID', '--value', 'rollforward'), was = pid();
  if (was === '0') return void sh('systemctl', '--user', 'restart', 'rollforward');
  sh('systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR2', 'rollforward');
  while (pid() === was) await sleep(5000);
}
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
try {
  await move(current, target);
  if (await answers()) {
    console.log(`on ${target}`);
    process.exit(0);
  }
  console.log(`${target} didn't answer ${health}`);
} catch (e) {
  console.log(`${target} failed: ${(e as Error).message}`);
}
await move(target, current);
mkdirSync(dirname(state), { recursive: true });
writeFileSync(state, JSON.stringify({ bad: [...bad, target] }));
console.log(`back on ${current}; ${target} won't be tried again`);
process.exitCode = 1;
