import { RpcClient, type JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenRun, PORT, sandboxArgs, unlistenRun } from './sandbox.ts';
import { bundle } from './ca.ts';
import { model, provider } from './connections/openrouter.ts';
import { wipe } from './store.ts';

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
// A run's processes and threads at most, a fork bomb's end, and its biggest file, which bounds a runaway write and a sparse file.
const TASKS = process.env.RF_RUN_TASKS ?? '2048', FILE_GB = Number(process.env.RF_RUN_FILE_GB ?? 16);

// A run's Pi: a prompt the agent takes, and steers it may get, until it settles, aborted or not.
export type TurnEnd = { aborted: boolean; error?: string };
export type Run = {
  turn(text: string): Promise<{ settled: Promise<TurnEnd> }>;
  steer(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
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
// files from / down to the instance. Each run starts a session of its own, its transcript in the instance's session/ beside the
// earlier runs'. Pi starts from a transcript there with its session's id, so the id is one no earlier run, which could write
// there, knew. The skills are the versions live as it starts, read-only at /skills/<id>, so a push applies from the next run.
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
    env: { PATH: [join(app, 'bin', 'sandbox'), process.env.PATH].join(delimiter), RF_SANDBOX_ARGS: join(run, 'bwrap.args'), RF_SANDBOX_SCOPE: process.env.RF_SANDBOX_SCOPE ?? SCOPE, RF_RUN_TASKS: TASKS, RF_RUN_FILE_BYTES: String(FILE_GB * 2 ** 30) },
    args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-prompt-templates', ...o.skills.flatMap(s => ['--skill', `/skills/${s.id}`]),
      '--tools', 'read,bash,edit,write', '--system-prompt', '/app/prompt.md',
      '--thinking', process.env.RF_THINKING ?? 'high',
      '--session-dir', `${instance}/session`, '--session-id', `run-${o.n}-${randomBytes(8).toString('hex')}`,
      ...JSON.parse(process.env.RF_PI_ARGS ?? '[]')],
  });
}

// A series' .pylib, which every later run of the series runs, whoever its runner, as a run starts: what Python runs there unasked
// goes, sitecustomize and usercustomize in any form, and .pth files, which Python reads only in site-packages, so nothing pip put
// there needs them; and its listing, each file's path, size and change time, which a run can't set, is the instance's pylib.tsv,
// which the run's commit keeps, and its sha256 the run entry's. Its folders are made the server's to read first, never through a
// link, and names are bytes, as a run may leave them.
export function pylib(dir: string, instance: string): string {
  mkdirSync(dir, { recursive: true });
  const lines: Buffer[] = [], slash = Buffer.from('/'), O_PATH = 0o10000000;
  const openDir = (at: Buffer) => {
    const p = openSync(at, O_PATH | constants.O_NOFOLLOW), self = `/proc/self/fd/${p}`;
    try {
      const st = fstatSync(p);
      if ((st.mode & 0o700) !== 0o700) chmodSync(self, (st.mode | 0o700) & 0o7777);
      return openSync(self, constants.O_RDONLY | constants.O_DIRECTORY);
    } finally { closeSync(p); }
  };
  let dfd = openDir(Buffer.from(dir)), rel = Buffer.alloc(0);
  try {
    const stack = [{ name: Buffer.alloc(0), entries: readdirSync(`/proc/self/fd/${dfd}`, { withFileTypes: true, encoding: 'buffer' }), stat: fstatSync(dfd) }];
    while (stack.length) {
      const e = stack.at(-1)!.entries.pop();
      if (e) {
        const name = e.name as unknown as Buffer, path = Buffer.concat([Buffer.from(`/proc/self/fd/${dfd}/`), name]);
        const at = rel.length ? Buffer.concat([rel, slash, name]) : name;
        if (!rel.length && /^(site|user)customize(\.|$)|\.pth$/.test(name.toString('latin1'))) { wipe(path); continue; }
        if (e.isDirectory()) {
          const sub = openDir(path);
          try {
            stack.push({ name, entries: readdirSync(`/proc/self/fd/${sub}`, { withFileTypes: true, encoding: 'buffer' }), stat: fstatSync(sub) });
          } catch (e) { closeSync(sub); throw e; }
          closeSync(dfd);
          dfd = sub;
          rel = at;
        } else {
          const st = lstatSync(path);
          lines.push(Buffer.concat([at, Buffer.from(`\t${st.size}\t${st.ctime.toISOString()}\n`)]));
        }
      } else {
        if (stack.length === 1) break;
        const child = stack.pop()!, parent = openSync(`/proc/self/fd/${dfd}/..`, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          const st = fstatSync(parent), expected = stack.at(-1)!.stat;
          if (st.dev !== expected.dev || st.ino !== expected.ino) throw new Error('a folder moved during the Python package listing');
        } catch (e) { closeSync(parent); throw e; }
        closeSync(dfd);
        dfd = parent;
        rel = rel.subarray(0, rel.length === child.name.length ? 0 : rel.length - child.name.length - 1);
      }
    }
  } finally { closeSync(dfd); }
  const list = Buffer.concat(lines.sort(Buffer.compare));
  writeFileSync(join(instance, 'pylib.tsv'), list);
  return createHash('sha256').update(list).digest('hex');
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
  const run = join(scratch, 'runs', o.token);
  let client: RpcClient | undefined;
  // A run may leave folders it can't write in its home, or named in bytes that aren't UTF-8: wipe() removes them all.
  const stop = async () => {
    const child = (client as unknown as { process: ChildProcess | null } | undefined)?.process;
    const exited = !child?.pid || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
    await client?.stop();
    await exited;
    unlistenRun(o.token);
    wipe(Buffer.from(run));
  };
  try {
    const rpcClient = client = pi(o);
    let settle = (_: TurnEnd) => {}, settled = Promise.resolve<TurnEnd>({ aborted: false });
    rpcClient.onEvent(e => e.type === 'agent_settled' && settle({ aborted: e.aborted }));
    rpcClient.onEvent(o.onEvent);
    await rpcClient.start();
    const rpc = rpcClient as unknown as { process: ChildProcess; stderr: string; stopReadingStdout?: () => void };
    const child = rpc.process;
    let errForwarded = 0, lineBytes = 0;
    child.stderr!.removeAllListeners('data').on('data', (d: Buffer) => {
      if (errForwarded < 65536) { process.stderr.write(d.subarray(0, 65536 - errForwarded)); errForwarded += d.length; }
      rpc.stderr = (rpc.stderr + d.toString()).slice(-65536);
    });
    child.stdout!.prependListener('data', (d: Buffer) => {
      const nl = d.lastIndexOf(10);
      lineBytes = nl < 0 ? lineBytes + d.length : d.length - nl - 1;
      if (lineBytes > 64 * 2 ** 20) {
        rpc.stopReadingStdout?.();
        rpc.stopReadingStdout = undefined;
        child.stdout!.destroy();
        child.kill('SIGKILL');
        settle({ aborted: true, error: 'Pi stdout line exceeded 64 MB' });
      }
    });
    child.once('exit', (code, signal) => settle({ aborted: true, error: `Pi exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${rpcClient.getStderr()}` }));
    await ready(rpcClient);
    return {
      turn: async text => {
        settled = new Promise<TurnEnd>(resolve => { settle = resolve; });
        await rpcClient.prompt(text);
        return { settled };
      },
      steer: text => rpcClient.steer(text),
      // Done once the turn settles: Pi says so before it answers the abort, and the run's end may stop it first.
      interrupt: async () => { void rpcClient.clearQueue().then(() => rpcClient.abort()).catch(() => {}); await settled; },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
