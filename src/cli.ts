import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance } from './store.ts';
import { act, initSystem } from './system.ts';
import { checkTicks } from './logins.ts';
import { asPerson, can } from './auth.ts';
import { checkAuthorityFormat } from './authority-format.ts';
import type { Authority } from './series.ts';
import { serveAgent } from './agent-api.ts';
import { openSkills, skills } from './skills.ts';
import { serveSandboxes, userland } from './sandbox.ts';
import { bundle } from './ca.ts';
import { call, intercepts, reachable, types, type CallRun } from './connections.ts';

// An admin's shell into the skills, with no model, as EMAIL with only the explicitly selected offers:
//   node --env-file=.env src/cli.ts DATA_ROOT try --as EMAIL --logins '["OFFER"]' [--out DIR] -- COMMAND ...
//       runs COMMAND as a run would: in the agent's userland, with the live skills under $RF_SKILLS, rf, the connections through
//       the run's proxy, and working/ under DIR (default ./try-output); and, unlike a run, this folder read-only and the host's
//       network, where that proxy is.
//       Such as: try --as EMAIL --logins '[]' -- python local.py

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const [root, cmd, ...rest] = process.argv.slice(2);
if (!root || !cmd) {
  console.error('usage: node src/cli.ts DATA_ROOT try --as EMAIL --logins JSON_ARRAY [--out DIR] -- COMMAND ...');
  process.exit(2);
}
checkAuthorityFormat(resolve(root));
initSystem(resolve(root));
openSkills(resolve(root));

const asAt = rest.indexOf('--as'), dash = rest.indexOf('--');
const as = asAt >= 0 && asAt + 1 < dash ? rest[asAt + 1] : '';

async function tryIt(args: string[]) {
  const dash = args.indexOf('--');
  if (dash < 0 || dash === args.length - 1) throw new Error('try --as EMAIL --logins JSON_ARRAY [--out DIR] -- COMMAND ...');
  const selectedAt = args.indexOf('--logins');
  if (selectedAt < 0 || selectedAt + 1 >= dash) throw new Error('--logins JSON_ARRAY is required; use [] for no credentials');
  const selected = checkTicks(as, JSON.parse(args[selectedAt + 1]));
  const lease: Authority = { version: 1, owner: as, epoch: 1, workspace: '', logins: selected };
  const at = args.indexOf('--out'), out = resolve(at >= 0 && at < dash ? args[at + 1] : 'try-output');
  mkdirSync(join(out, 'working'), { recursive: true });
  // A stand-in series and instance: what the agent API needs of one, its log printed rather than kept.
  const seriesDir = mkdtempSync(join(tmpdir(), 'rf-try-'));
  const inst = { id: 'try', seriesId: '', dir: out, log: [{ seq: 1, op: 'create', by: as }, { seq: 2, op: 'run', run: 0, runner: as, initiator: as, authority: lease }], series: () => seriesDir, append: (_by: string, op: string, data: object) => { console.log(`  [log] ${op} ${JSON.stringify(data)}`); return { seq: 0 }; } } as unknown as Instance;
  const api = await serveAgent(inst);
  // The proxy a run has, on a port of its own, for the connections and the hosts runs may reach.
  const token = randomUUID(), run: CallRun = { inst: inst as unknown as Instance, n: 0, runner: as, links: new Map(), cost: 0 };
  const proxy = serveSandboxes({ agent: async (_q, s) => void s.writeHead(404).end(), run: t => t === token ? { egress: () => {}, browsers: api.browsers, intercepts: h => intercepts(run, h), call: (h, q, s) => call(run, h, q, s) } : undefined }).listen(0);
  await once(proxy, 'listening');
  const via = `http://rf:${token}@127.0.0.1:${(proxy.address() as { port: number }).port}`;
  writeFileSync(join(out, 'ca.pem'), bundle());
  const home = mkdtempSync(join(tmpdir(), 'rf-try-home-')), here = process.cwd();
  mkdirSync(join(home, '.officecli'));
  writeFileSync(join(home, '.officecli', 'config.json'), JSON.stringify({ autoUpdate: false }));
  const env = {
    PATH: ['/app/bin', '/opt/venv/bin', '/usr/local/bin', '/usr/bin'].join(delimiter), LANG: 'C.UTF-8', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, HOME: '/home/agent', OFFICECLI_NO_AUTO_RESIDENT: '1', PLAYWRIGHT_MCP_OUTPUT_DIR: '/tmp/playwright-cli',
    RF_URL: api.url, RF_TOKEN: api.token, RF_BROWSERS: `${api.url}/browsers/${api.token}`, RF_WORKING: join(out, 'working'), RF_SKILLS: '/skills', ...(process.env.RF_TODAY && { RF_TODAY: process.env.RF_TODAY }),
    HTTPS_PROXY: via, https_proxy: via, NODE_USE_ENV_PROXY: '1', OPENROUTER_API_KEY: 'rf', ...(process.env.EXA_API_KEY && { EXA_API_KEY: 'rf' }), ...Object.assign({}, ...reachable(run.inst, run.n).map(c => types[c.type].env?.(c, selected))), ...Object.fromEntries(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE'].map(k => [k, join(out, 'ca.pem')])),
  };
  // A try uses an admin's logins outside any run: an act of theirs, from this machine's account, in the system's log.
  act(as, { op: 'try', command: args.slice(dash + 1), shell: userInfo().username });
  const code = await new Promise<number>(done => spawn('bwrap', [
    '--unshare-all', '--share-net', '--die-with-parent', '--clearenv', ...userland(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', home, '/home/agent',
    ...['bin', 'src', 'node_modules', 'package.json'].flatMap(f => ['--ro-bind', join(app, f), `/app/${f}`]), ...skills().flatMap(s => ['--ro-bind', realpathSync(s.dir), `/skills/${s.id}`]),
    '--ro-bind', here, here, '--bind', out, out, ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]), '--chdir', here, '--', ...args.slice(dash + 1),
  ], { stdio: 'inherit' }).on('exit', c => done(c ?? 1)).on('error', e => { console.error(e.message); done(1); }));
  await api.close();
  proxy.close();
  rmSync(seriesDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  console.log(`\nExit ${code}. In ${join(out, 'working')}: ${readdirSync(join(out, 'working')).join(', ') || 'nothing'}`);
  process.exitCode = code;
}

try {
  // A try's instance is in no workspace, and only admins see every one (logins.ts use()).
  const person = asPerson(as);
  if (person?.role !== 'admin' || !can(person, 'series-owner')) throw new Error('--as EMAIL: an enabled admin explicitly granted series-owner, whose selected logins to use');
  if (cmd === 'try') await tryIt(rest);
  else throw new Error(`no command ${cmd}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
