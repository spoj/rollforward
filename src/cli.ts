import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance } from './store.ts';
import { initSystem } from './system.ts';
import { logins } from './logins.ts';
import { users } from './auth.ts';
import { serveAgent } from './agent-api.ts';
import { openSkills, skillsDir } from './skills.ts';
import { serveSandboxes, userland } from './sandbox.ts';
import { bundle } from './ca.ts';
import { call, intercepts, reachable, types, type CallRun } from './connections.ts';

// An admin's shell into the skills, with what DATA_ROOT has set up, and no model, as the admin EMAIL with all their logins ticked:
//   node --env-file=.env src/cli.ts DATA_ROOT try --as EMAIL [--out DIR] -- COMMAND ...
//       runs COMMAND as a run would: in the agent's userland, with the live skills under $RF_SKILLS, rf, the connections through
//       the run's proxy, and working/ under DIR (default ./try-output); and, unlike a run, this folder read-only and the host's
//       network, where that proxy is.
//       Such as: try --as EMAIL -- python "$RF_SKILLS/aging/scripts/fetch.py"
//                try --as EMAIL -- python portal.py, which connects to $RF_BROWSERS/portal

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const [root, cmd, ...rest] = process.argv.slice(2);
if (!root || !cmd) {
  console.error('usage: node src/cli.ts DATA_ROOT try --as EMAIL [--out DIR] -- COMMAND ...');
  process.exit(2);
}
initSystem(resolve(root));
openSkills(resolve(root));

const as = rest.includes('--as') ? rest[rest.indexOf('--as') + 1] : '';

async function tryIt(args: string[]) {
  const dash = args.indexOf('--');
  if (dash < 0 || dash === args.length - 1) throw new Error('try --as EMAIL [--out DIR] -- COMMAND ...');
  const at = args.indexOf('--out'), out = resolve(at >= 0 && at < dash ? args[at + 1] : 'try-output');
  mkdirSync(join(out, 'working'), { recursive: true });
  // A stand-in series and instance: what the agent API needs of one, its log printed rather than kept.
  const seriesDir = mkdtempSync(join(tmpdir(), 'rf-try-'));
  const inst = { dir: out, log: [{ op: 'create', by: as, logins: logins(as).flatMap(l => l.offers.map(o => o.id)) }], series: () => seriesDir, append: (_by: string, op: string, data: object) => { console.log(`  [log] ${op} ${JSON.stringify(data)}`); return { seq: 0 }; } } as unknown as Instance;
  const api = await serveAgent(inst);
  // The proxy a run has, on a port of its own, for the connections and the hosts runs may reach.
  const token = randomUUID(), run: CallRun = { inst: inst as unknown as Instance, n: 0, links: new Map(), cost: 0 };
  const proxy = serveSandboxes({ agent: async (_q, s) => void s.writeHead(404).end(), run: t => t === token ? { egress: () => {}, browsers: api.browsers, intercepts: h => intercepts(run, h), call: (h, q, s) => call(run, h, q, s) } : undefined }).listen(0);
  await once(proxy, 'listening');
  const via = `http://rf:${token}@127.0.0.1:${(proxy.address() as { port: number }).port}`;
  writeFileSync(join(out, 'ca.pem'), bundle());
  const home = mkdtempSync(join(tmpdir(), 'rf-try-home-')), here = process.cwd();
  mkdirSync(join(home, '.officecli'));
  writeFileSync(join(home, '.officecli', 'config.json'), JSON.stringify({ autoUpdate: false }));
  const env = {
    PATH: [join(app, 'bin'), '/opt/venv/bin', '/usr/local/bin', '/usr/bin'].join(delimiter), LANG: 'C.UTF-8', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, HOME: home, OFFICECLI_NO_AUTO_RESIDENT: '1',
    RF_URL: api.url, RF_TOKEN: api.token, RF_BROWSERS: `${api.url}/browsers/${api.token}`, RF_WORKING: join(out, 'working'), RF_SKILLS: '/skills/live',
    HTTPS_PROXY: via, https_proxy: via, NODE_USE_ENV_PROXY: '1', OPENROUTER_API_KEY: 'rf', EXA_API_KEY: 'rf', ...Object.assign({}, ...reachable(run.inst).map(c => types[c.type].env?.(c))), ...Object.fromEntries(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE'].map(k => [k, join(out, 'ca.pem')])),
  };
  const code = await new Promise<number>(done => spawn('bwrap', [
    '--unshare-all', '--share-net', '--die-with-parent', '--clearenv', ...userland(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', home, home,
    ...['bin', 'src', 'node_modules', 'package.json'].flatMap(f => ['--ro-bind', join(app, f), join(app, f)]), '--ro-bind', dirname(skillsDir()), '/skills',
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
  if (users()[as]?.role !== 'admin') throw new Error('--as EMAIL: an admin, whose logins to use');
  if (cmd === 'try') await tryIt(rest);
  else throw new Error(`no command ${cmd}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
