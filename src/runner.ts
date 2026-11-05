import { RpcClient, type JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenRun, PORT, sandboxArgs, unlistenRun } from './sandbox.ts';
import { bundle } from './ca.ts';
import { model, provider } from './connections/openrouter.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside, the app is at /app, read-only.
const cliPath = `/app/${relative(app, join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js'))}`;
// Where runs get their HOME and /tmp, and the folder of the server's socket for sandboxes.
export const scratch = process.env.RF_SCRATCH ?? join(tmpdir(), 'rollforward');
// The server's user alone reaches its runs, whose folders are named by their tokens.
mkdirSync(scratch, { recursive: true });
chmodSync(scratch, 0o700);
// Each run's own cgroup, where systemd runs the server; the container image sets this empty.
const SCOPE = 'systemd-run --user --scope --quiet --collect --slice=rollforward-runs -p MemoryHigh=4G -p MemoryMax=8G --';

// A run's Pi, which takes turns: each a prompt the agent takes, and steers it may get, until it settles, aborted or not.
export type Run = {
  turn(text: string): Promise<{ settled: Promise<boolean> }>;
  steer(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  // Whether its sandbox runs nothing but Pi: no job the agent left running, with & or nohup.
  alone(): boolean;
};

// The run's view of the data, which the server builds: its own instance at instance, such as /work/<workspace>/<series>/<label>,
// its working folder, from the folder dir, its series' .pylib from pylib, in ro, every instance in its reach and the AGENTS.md of
// the company and of each workspace there, each [host path, path inside]; and its environment. Another series' .pylib isn't
// there: what its runs installed is theirs to run, never a run of another series, with its runner's logins. names and series are
// the ids of the folders of the instances and series in reach, by the names the run starts with, which stay its names to the end:
// what it hands the server is read by them, and its instance's names.tsv lists the instances', for whoever reads its files.
export type View = { instance: string; dir: string; pylib: string; ro: [string, string][]; names: Record<string, string>; series: Record<string, string>; env: Record<string, string> };

// Pi for one run, in its sandbox (sandbox.ts): its view read-only but for the instance's working/ and session/ and the series'
// .pylib, the live skills and nothing else of the host's. prompt.md is its system prompt, to which Pi adds the AGENTS.md
// files from / down to the instance. A run that starts Pi, `n`, starts a session, which later runs may continue (waker.ts), its
// transcript in the instance's session/ beside the earlier sessions'. The skills are the versions live as it starts, read-only at
// /skills/<id>, so a push applies from the next run.
export function pi(o: { token: string; id: string; n: number; view: View; skills: { id: string; dir: string }[] }): RpcClient {
  const run = join(scratch, 'runs', o.token), home = join(run, 'home'), agentDir = join(home, '.pi', 'agent'), tmp = join(run, 'tmp');
  const { instance, dir, pylib } = o.view, working = join(dir, 'working'), session = join(dir, 'session'), lib = `${posix.dirname(instance)}/.pylib`;
  const socketDir = join(run, 'socket');
  for (const d of [agentDir, tmp, pylib, working, session, socketDir]) mkdirSync(d, { recursive: true });
  // The copy of the skills that earlier versions' runs kept in an open instance goes, with its next commit.
  rmSync(join(dir, 'skills'), { recursive: true, force: true });
  writeFileSync(join(dir, 'names.tsv'), Object.entries(o.view.names).map(([at, id]) => `${id}\t${at}\n`).join(''));
  // PYTHONPATH reaches the series' .pylib through a link in HOME, as a colon in its path, such as in a task named by its first
  // prompt, would split it.
  symlinkSync(lib, join(home, 'pylib'));
  listenRun(join(socketDir, 'rf.sock'), o.token);
  const local = `http://127.0.0.1:${PORT}`, proxy = `http://rf:${o.token}@127.0.0.1:${PORT}`;
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ steeringMode: 'all' }));
  mkdirSync(join(home, '.officecli'));
  writeFileSync(join(home, '.officecli', 'config.json'), JSON.stringify({ autoUpdate: false }));
  // The authorities a run trusts, the system's and ours, whose certificates the proxy shows for connections' hosts.
  writeFileSync(join(home, 'ca.pem'), bundle());
  const args = sandboxArgs({
    cwd: instance, home, tmp, socketDir,
    ro: [
      ...['bin', 'src', 'node_modules', 'package.json', 'prompt.md'].map(f => [join(app, f), `/app/${f}`] as [string, string]), ...o.skills.map(s => [s.dir, `/skills/${s.id}`] as [string, string]),
      ...(process.env.RF_SANDBOX_RO ?? '').split(delimiter).map(p => [p, p] as [string, string]),
    ].filter(([p]) => p && existsSync(p)),
    work: { ro: o.view.ro.filter(([src]) => existsSync(src)), rw: [[working, `${instance}/working`], [session, `${instance}/session`], [pylib, lib]] },
    env: {
      // The image's node, its venv's python and pip, and its programs; the host's time zone.
      PATH: ['/app/bin', '/opt/venv/bin', '/usr/local/bin', '/usr/bin'].join(delimiter), LANG: 'C.UTF-8', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, PYTHONPATH: '/home/agent/pylib',
      // A plain pip install, the venv's, lands in the series' .pylib, built for the Python runs use.
      PIP_TARGET: lib, PI_CODING_AGENT_DIR: '/home/agent/.pi/agent', PI_OFFLINE: '1', PI_TELEMETRY: '0', OFFICECLI_NO_AUTO_RESIDENT: '1',
      // playwright-cli's snapshots and screenshots, out of the instance, whose own folder is read-only.
      PLAYWRIGHT_MCP_OUTPUT_DIR: '/tmp/playwright-cli',
      // git reads the instance's repository from working/, across the mount between them.
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      RF_URL: local, RF_TOKEN: o.token, RF_BROWSERS: `${local}/browsers/${o.token}`, RF_INSTANCE: o.id, RF_WORKING: `${instance}/working`, RF_SKILLS: '/skills', ...(process.env.RF_TODAY && { RF_TODAY: process.env.RF_TODAY }),
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1',
      // Stand-ins for the keys of the server's own connections, which its proxy puts in: Pi's own calls to OpenRouter take this one.
      OPENROUTER_API_KEY: 'rf', ...(process.env.EXA_API_KEY && { EXA_API_KEY: 'rf' }),
      ...Object.fromEntries(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE'].map(k => [k, '/home/agent/ca.pem'])), ...o.view.env,
    },
  });
  writeFileSync(join(run, 'bwrap.args'), `${args.join('\0')}\0`);
  return new RpcClient({
    cliPath, cwd: dir, provider, model,
    env: { PATH: [join(app, 'bin', 'sandbox'), process.env.PATH].join(delimiter), RF_SANDBOX_ARGS: join(run, 'bwrap.args'), RF_SANDBOX_SCOPE: process.env.RF_SANDBOX_SCOPE ?? SCOPE },
    args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-prompt-templates', ...o.skills.flatMap(s => ['--skill', `/skills/${s.id}`]),
      '--tools', 'read,bash,edit,write', '--system-prompt', '/app/prompt.md',
      '--thinking', process.env.RF_THINKING ?? 'high',
      '--session-dir', `${instance}/session`, '--session-id', `run-${o.n}`,
      ...JSON.parse(process.env.RF_PI_ARGS ?? '[]')],
  });
}

// Pi answers commands only once it has loaded, and RpcClient waits 30 s for an answer. A cold or busy machine, such as one starting
// many runs after a restart, has been seen to take 40 s, so ask for its state again on each timeout before sending the prompt.
async function ready(client: RpcClient, tries = 4): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return void (await client.getState());
    } catch (e) {
      if (i === tries || !(e as Error).message.startsWith('Timeout waiting for response')) throw e;
    }
  }
}

export async function startRun(o: Parameters<typeof pi>[0] & { onEvent: (e: JsonAgentSessionEvent) => void }): Promise<Run> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('no model key: the server has no OPENROUTER_API_KEY');
  const client = pi(o), run = join(scratch, 'runs', o.token);
  // A run may leave folders it can't write in its home; they're made writable first, never through a link.
  const writable = (d: string) => { chmodSync(d, 0o700); for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) writable(join(d, e.name)); };
  const stop = async () => { await client.stop(); unlistenRun(o.token); writable(run); rmSync(run, { recursive: true, force: true }); };
  let settle = (_: boolean) => {}, settled = Promise.resolve(false);
  client.onEvent(e => e.type === 'agent_settled' && settle(e.aborted));
  client.onEvent(o.onEvent);
  await client.start();
  await ready(client).catch(async e => { await stop(); throw e; });
  return {
    turn: async text => {
      settled = new Promise<boolean>(resolve => { settle = resolve; });
      await client.prompt(text);
      return { settled };
    },
    steer: text => client.steer(text),
    // Done once the turn settles: Pi says so before it answers the abort, and the run's end may stop it first.
    interrupt: async () => { await Promise.race([client.clearQueue().then(() => client.abort()), settled]); },
    stop,
    // The sandbox by the process Pi's client started, which is its outer bwrap (bin/sandbox/node).
    alone: () => alone((client as unknown as { process: ChildProcess }).process.pid!),
  };
}

// Whether a sandbox, by its outer bwrap, still runs and runs nothing but its PID namespace's init, Pi, which is the second process
// there, and the socat offering the server's socket, with a process of its own per connection; one that has exited counts for nothing.
function alone(bwrap: number): boolean {
  const read = (p: string, f: (p: string) => string) => { try { return f(p); } catch { return ''; } }; // a process of another user's, or gone
  const ns = read(`/proc/${read(`/proc/${bwrap}/task/${bwrap}/children`, p => readFileSync(p, 'utf8')).split(' ')[0]}/ns/pid`, readlinkSync);
  return !!ns && readdirSync('/proc').filter(p => /^\d+$/.test(p) && read(`/proc/${p}/ns/pid`, readlinkSync) === ns).every(p => {
    const status = read(`/proc/${p}/status`, p => readFileSync(p, 'utf8'));
    return !status || Number(/^NSpid:.*\s(\d+)$/m.exec(status)![1]) <= 2 || /^Name:\tsocat$/m.test(status) || /^State:\tZ/m.test(status);
  });
}
