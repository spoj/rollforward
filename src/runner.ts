import { RpcClient, type JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsDir } from './skills.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const [provider, model] = (process.env.RF_MODEL ?? 'openrouter/anthropic/claude-opus-5.5').split(/\/(.*)/);

export type Run = {
  steer(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  settled: Promise<boolean>;
};

// `skills`: the skills the series chose under Skill use; the run loads only those.
export function pi(o: { seriesDir: string; instanceDir: string; env: Record<string, string>; skills?: string[] }): RpcClient {
  return new RpcClient({
    cliPath, cwd: o.seriesDir, provider, model,
    // Pi gets the server's environment; blank the sign-in secret so the agent never sees it.
    env: { ...o.env, PATH: [join(app, 'bin'), join(app, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), process.env.PATH].join(delimiter), PYTHONPATH: join(o.seriesDir, '.pylib'), RF_SKILLS: skillsDir(), RF_OIDC_CLIENT_SECRET: '' },
    args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', ...(o.skills ?? []).flatMap(id => ['--skill', join(skillsDir(), id)]),
      '--tools', 'read,bash,edit,write', '--append-system-prompt', join(app, 'prompt.md'),
      '--thinking', process.env.RF_THINKING ?? 'high',
      '--session-dir', join(o.instanceDir, 'session'), '--session-id', 'main',
      ...JSON.parse(process.env.RF_PI_ARGS ?? '[]')],
  });
}

export async function startRun(o: { seriesDir: string; instanceDir: string; env: Record<string, string>; skills?: string[]; message: string; onEvent: (e: JsonAgentSessionEvent) => void }): Promise<Run> {
  const client = pi(o);
  const settled = new Promise<boolean>(resolve => client.onEvent(e => e.type === 'agent_settled' && resolve(e.aborted)));
  client.onEvent(o.onEvent);
  await client.start();
  await client.prompt(o.message).catch(async e => { await client.stop(); throw e; });
  return {
    steer: text => client.steer(text),
    interrupt: async () => { await client.clearQueue(); await client.abort(); },
    stop: () => client.stop(),
    settled,
  };
}
