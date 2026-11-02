import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance } from './store.ts';
import { initSystem } from './system.ts';
import { logins } from './logins.ts';
import { serveAgent, skillsText, testSkill } from './agent-api.ts';
import { checkChosen, openSkills, skillsDir } from './skills.ts';

// An admin's shell into the skills, with what DATA_ROOT has set up, and no model, as the person EMAIL with all their logins ticked:
//   node --env-file=.env src/cli.ts DATA_ROOT test SKILL --as EMAIL
//       what Test does on the Skills page
//   node --env-file=.env src/cli.ts DATA_ROOT try SKILL[,SKILL...] --as EMAIL [--out DIR] -- COMMAND ...
//       runs COMMAND as a run of a series with those skills would: rf reaching them, and working/ under DIR (default ./try-output).
//       Such as: try aging -- python "$RF_SKILLS/aging/scripts/fetch.py"
//                try portal -- rf browser open portal

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const [root, cmd, ...rest] = process.argv.slice(2);
if (!root || !cmd) {
  console.error('usage: node src/cli.ts DATA_ROOT test SKILL --as EMAIL | try SKILL[,SKILL...] --as EMAIL [--out DIR] -- COMMAND ...');
  process.exit(2);
}
initSystem(resolve(root));
openSkills(resolve(root));

const as = rest.includes('--as') ? rest[rest.indexOf('--as') + 1] : '';

async function tryIt(chosen: string, args: string[]) {
  const dash = args.indexOf('--');
  if (!chosen || dash < 0 || dash === args.length - 1) throw new Error('try SKILL[,SKILL...] [--out DIR] -- COMMAND ...');
  const at = args.indexOf('--out'), out = resolve(at >= 0 && at < dash ? args[at + 1] : 'try-output');
  mkdirSync(join(out, 'working'), { recursive: true });
  // A stand-in series with those skills, and a stand-in instance: what the agent API needs of one, its log printed rather than kept.
  const seriesDir = mkdtempSync(join(tmpdir(), 'rf-try-'));
  writeFileSync(join(seriesDir, 'series.json'), JSON.stringify({ skills: checkChosen(chosen.split(',')) }));
  const inst = { dir: out, log: [{ op: 'create', by: as, logins: logins(as).flatMap(l => l.offers.map(o => o.id)) }], series: () => seriesDir, append: (_by: string, op: string, data: object) => { console.log(`  [log] ${op} ${JSON.stringify(data)}`); return { seq: 0 }; } } as unknown as Instance;
  const api = await serveAgent(inst);
  console.log(`Skills:\n${skillsText(seriesDir)}\n`);
  let words = args.slice(dash + 1);
  const venv = join(app, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  if (words[0] === 'rf') words = [process.execPath, join(app, 'src', 'rf.ts'), ...words.slice(1)];
  if (words[0] === 'python') words = [join(venv, process.platform === 'win32' ? 'python.exe' : 'python'), ...words.slice(1)];
  const code = await new Promise<number>(done => spawn(words[0], words.slice(1), {
    stdio: 'inherit', cwd: app,
    env: { ...process.env, RF_URL: api.url, RF_TOKEN: api.token, RF_WORKING: join(out, 'working'), RF_SKILLS: skillsDir(), PATH: [join(app, 'bin'), venv, process.env.PATH].join(delimiter) },
  }).on('exit', c => done(c ?? 1)).on('error', e => { console.error(e.message); done(1); }));
  await api.close();
  rmSync(seriesDir, { recursive: true, force: true });
  console.log(`\nExit ${code}. In ${join(out, 'working')}: ${readdirSync(join(out, 'working')).join(', ') || 'nothing'}`);
  process.exitCode = code;
}

try {
  if (!as) throw new Error('--as EMAIL: whose logins to use');
  if (cmd === 'test') console.log(await testSkill(rest[0] ?? '', as));
  else if (cmd === 'try') await tryIt(rest[0], rest.slice(1));
  else throw new Error(`no command ${cmd}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
