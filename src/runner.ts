import { RpcClient, type JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { chmodSync, closeSync, constants, existsSync, ftruncateSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenRun, PORT, sandboxArgs, unlistenRun } from './sandbox.ts';
import { skillsDir } from './skills.ts';
import { openFile } from './store.ts';
import { bundle } from './ca.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const [provider, model] = (process.env.RF_MODEL ?? 'openrouter/anthropic/claude-opus-5.5').split(/\/(.*)/);
// Where runs get their HOME and /tmp, and the folder of the server's socket for sandboxes.
export const scratch = process.env.RF_SCRATCH ?? join(tmpdir(), 'rollforward');
// The server's user alone reaches its runs, whose folders are named by their tokens.
mkdirSync(scratch, { recursive: true });
chmodSync(scratch, 0o700);
// Each run's own cgroup, where systemd runs the server; the container image sets this empty.
const SCOPE = 'systemd-run --user --scope --quiet --collect --slice=rollforward-runs -p MemoryHigh=4G -p MemoryMax=8G --';

export type Run = {
  steer(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  settled: Promise<boolean>;
};

// The run's view of the data, which the server builds: its series at cwd, such as /work/<workspace>/<series>, its own instance at
// instance, from the folder dir, its series' .pylib from pylib, in ro, every instance in its reach and the AGENTS.md of the
// company and of each workspace there, each [host path, path inside]; and its environment. Another series' .pylib isn't there:
// what its runs installed is theirs to run, never a run of another series, with its runner's logins.
export type View = { cwd: string; instance: string; dir: string; pylib: string; ro: [string, string][]; env: Record<string, string> };

// Pi for one run, in its sandbox (sandbox.ts): its view read-only but for the instance's working/ and session/ and the series'
// .pylib, the live skills and nothing else of the host's. prompt.md is its system prompt, to which Pi adds the AGENTS.md
// files from / down to cwd. A session started under other names is moved to these, as Pi resumes only a session whose folder it
// recorded.
export function pi(o: { token: string; id: string; view: View; skills?: string[] }): RpcClient {
  const run = join(scratch, 'runs', o.token), home = join(run, 'home'), agentDir = join(home, '.pi', 'agent'), tmp = join(run, 'tmp');
  const { cwd, instance, dir, pylib } = o.view, working = join(dir, 'working'), session = join(dir, 'session');
  const socketDir = join(run, 'socket');
  for (const d of [agentDir, tmp, pylib, working, session, socketDir]) mkdirSync(d, { recursive: true });
  // PYTHONPATH reaches the series' .pylib through a link in HOME, as a colon in its path, such as in a task named by its first
  // prompt, would split it.
  symlinkSync(`${cwd}/.pylib`, join(home, 'pylib'));
  listenRun(join(socketDir, 'rf.sock'), o.token);
  for (const f of readdirSync(session).filter(f => f.endsWith('.jsonl'))) {
    const fd = openFile(session, f, constants.O_RDWR);
    if (fd === undefined) continue;
    try {
      const text = readFileSync(fd, 'utf8'), nl = text.indexOf('\n'), head = JSON.parse(text.slice(0, nl));
      if (head.cwd !== cwd) {
        ftruncateSync(fd);
        writeSync(fd, JSON.stringify({ ...head, cwd }) + text.slice(nl), 0);
      }
    } finally { closeSync(fd); }
  }
  const local = `http://127.0.0.1:${PORT}`, proxy = `http://rf:${o.token}@127.0.0.1:${PORT}`;
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: `${local}/model/${o.token}`, apiKey: 'none' } } }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ steeringMode: 'all' }));
  mkdirSync(join(home, '.officecli'));
  writeFileSync(join(home, '.officecli', 'config.json'), JSON.stringify({ autoUpdate: false }));
  // The authorities a run trusts, the system's and ours, whose certificates the proxy shows for connections' hosts.
  writeFileSync(join(home, 'ca.pem'), bundle());
  const args = sandboxArgs({
    cwd, home, tmp, socketDir,
    ro: [...['bin', 'src', 'node_modules', 'package.json', 'prompt.md'].map(f => join(app, f)), ...(process.env.RF_SANDBOX_RO ?? '').split(delimiter)].filter(p => p && existsSync(p)),
    work: { ro: [[dirname(skillsDir()), '/skills'], ...o.view.ro.filter(([src]) => existsSync(src))], rw: [[working, `${instance}/working`], [session, `${instance}/session`], [pylib, `${cwd}/.pylib`]] },
    env: {
      // The image's node, its venv's python and pip, and its programs; the host's time zone.
      PATH: [join(app, 'bin'), '/opt/venv/bin', '/usr/local/bin', '/usr/bin'].join(delimiter), LANG: 'C.UTF-8', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, PYTHONPATH: join(home, 'pylib'),
      // A plain pip install, the venv's, lands in the series' .pylib, built for the Python runs use.
      PIP_TARGET: `${cwd}/.pylib`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0', OFFICECLI_NO_AUTO_RESIDENT: '1',
      RF_URL: local, RF_TOKEN: o.token, RF_BROWSERS: `${local}/browsers/${o.token}`, RF_INSTANCE: o.id, RF_WORKING: `${instance}/working`, RF_SKILLS: '/skills/live', ...(process.env.RF_TODAY && { RF_TODAY: process.env.RF_TODAY }),
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1',
      ...Object.fromEntries(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE'].map(k => [k, join(home, 'ca.pem')])), ...o.view.env,
    },
  });
  writeFileSync(join(run, 'bwrap.args'), `${args.join('\0')}\0`);
  return new RpcClient({
    cliPath, cwd: dir, provider, model,
    env: { PATH: [join(app, 'bin', 'sandbox'), process.env.PATH].join(delimiter), RF_SANDBOX_ARGS: join(run, 'bwrap.args'), RF_SANDBOX_SCOPE: process.env.RF_SANDBOX_SCOPE ?? SCOPE },
    args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-prompt-templates', ...(o.skills ?? []).flatMap(id => ['--skill', `/skills/live/${id}`]),
      '--tools', 'read,bash,edit,write', '--system-prompt', join(app, 'prompt.md'),
      '--thinking', process.env.RF_THINKING ?? 'high',
      '--session-dir', `${instance}/session`, '--session-id', 'main',
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

export async function startRun(o: Parameters<typeof pi>[0] & { message: string; onEvent: (e: JsonAgentSessionEvent) => void }): Promise<Run> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('no model key: the server has no OPENROUTER_API_KEY');
  const client = pi(o), run = join(scratch, 'runs', o.token);
  // A run may leave folders it can't write in its home; they're made writable first, never through a link.
  const writable = (d: string) => { chmodSync(d, 0o700); for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) writable(join(d, e.name)); };
  const stop = async () => { await client.stop(); unlistenRun(o.token); writable(run); rmSync(run, { recursive: true, force: true }); };
  const settled = new Promise<boolean>(resolve => client.onEvent(e => e.type === 'agent_settled' && resolve(e.aborted)));
  client.onEvent(o.onEvent);
  await client.start();
  await ready(client).then(() => client.prompt(o.message)).catch(async e => { await stop(); throw e; });
  return {
    steer: text => client.steer(text),
    interrupt: async () => { await client.clearQueue(); await client.abort(); },
    stop,
    settled,
  };
}
