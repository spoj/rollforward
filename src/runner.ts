import { RpcClient, type JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, sandboxArgs } from './sandbox.ts';
import { skillsDir } from './skills.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const [provider, model] = (process.env.RF_MODEL ?? 'openrouter/anthropic/claude-opus-5.5').split(/\/(.*)/);
// Where runs get their HOME and /tmp, and the folder of the server's socket for sandboxes.
export const scratch = process.env.RF_SCRATCH ?? join(tmpdir(), 'rollforward');
export const socketDir = join(scratch, 'socket');
// Each run's own cgroup, where systemd runs the server; the container image sets this empty.
const SCOPE = 'systemd-run --user --scope --quiet --collect --slice=rollforward-runs -p MemoryHigh=4G -p MemoryMax=8G --';

export type Run = {
  steer(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  settled: Promise<boolean>;
};

// The run's view of the data, which the server builds: its series at cwd, such as /work/<workspace>/<series>, its own instance at
// instance, from the folder dir, its series' .pylib from pylib, and in ro, every instance in its reach and the .pylib of the other
// series there, each [host path, path inside].
export type View = { cwd: string; instance: string; dir: string; pylib: string; ro: [string, string][] };

// Pi for one run, in its sandbox (sandbox.ts): its view read-only but for the instance's working/ and session/ and the series'
// .pylib, the skills the series chose and nothing else of the host's. A session started under other names is moved to these, as Pi
// resumes only a session whose folder it recorded.
export function pi(o: { token: string; view: View; skills?: string[] }): RpcClient {
  const run = join(scratch, 'runs', o.token), home = join(run, 'home'), agentDir = join(home, '.pi', 'agent'), tmp = join(run, 'tmp');
  const { cwd, instance, dir, pylib } = o.view, working = join(dir, 'working'), session = join(dir, 'session');
  for (const d of [agentDir, tmp, pylib, working, session]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(session).filter(f => f.endsWith('.jsonl'))) {
    const text = readFileSync(join(session, f), 'utf8'), nl = text.indexOf('\n'), head = JSON.parse(text.slice(0, nl));
    if (head.cwd !== cwd) writeFileSync(join(session, f), JSON.stringify({ ...head, cwd }) + text.slice(nl));
  }
  const local = `http://127.0.0.1:${PORT}`, proxy = `http://rf:${o.token}@127.0.0.1:${PORT}`;
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: `${local}/model/${o.token}`, apiKey: 'none' } } }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ steeringMode: 'all' }));
  const args = sandboxArgs({
    cwd, home, tmp, socketDir,
    ro: [...['bin', 'src', 'node_modules', '.venv', 'package.json', 'prompt.md'].map(f => join(app, f)), dirname(process.execPath), skillsDir(), ...(process.env.RF_SANDBOX_RO ?? '').split(delimiter)].filter(p => p && existsSync(p)),
    work: { ro: o.view.ro.filter(([src]) => existsSync(src)), rw: [[working, `${instance}/working`], [session, `${instance}/session`], [pylib, `${cwd}/.pylib`]] },
    env: {
      PATH: [join(app, 'bin'), join(app, '.venv', 'bin'), dirname(process.execPath), '/usr/bin'].join(delimiter), LANG: 'C.UTF-8', PYTHONPATH: `${cwd}/.pylib`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
      RF_URL: local, RF_TOKEN: o.token, RF_WORKING: `${instance}/working`, RF_SKILLS: skillsDir(), ...(process.env.RF_TODAY && { RF_TODAY: process.env.RF_TODAY }),
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1',
    },
  });
  writeFileSync(join(run, 'bwrap.args'), `${args.join('\0')}\0`);
  return new RpcClient({
    cliPath, cwd: dir, provider, model,
    env: { PATH: [join(app, 'bin', 'sandbox'), process.env.PATH].join(delimiter), RF_SANDBOX_ARGS: join(run, 'bwrap.args'), RF_SANDBOX_SCOPE: process.env.RF_SANDBOX_SCOPE ?? SCOPE },
    args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', ...(o.skills ?? []).flatMap(id => ['--skill', join(skillsDir(), id)]),
      '--tools', 'read,bash,edit,write', '--append-system-prompt', join(app, 'prompt.md'),
      '--thinking', process.env.RF_THINKING ?? 'high',
      '--session-dir', `${instance}/session`, '--session-id', 'main',
      ...JSON.parse(process.env.RF_PI_ARGS ?? '[]')],
  });
}

export async function startRun(o: Parameters<typeof pi>[0] & { message: string; onEvent: (e: JsonAgentSessionEvent) => void }): Promise<Run> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('no model key: the server has no OPENROUTER_API_KEY');
  const client = pi(o), stop = async () => { await client.stop(); rmSync(join(scratch, 'runs', o.token), { recursive: true, force: true }); };
  const settled = new Promise<boolean>(resolve => client.onEvent(e => e.type === 'agent_settled' && resolve(e.aborted)));
  client.onEvent(o.onEvent);
  await client.start();
  await client.prompt(o.message).catch(async e => { await stop(); throw e; });
  return {
    steer: text => client.steer(text),
    interrupt: async () => { await client.clearQueue(); await client.abort(); },
    stop,
    settled,
  };
}
