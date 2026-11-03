// Unpacks the agent image this checkout runs (src/agent.ts) where the server looks for it: from FILE if it exists, else CI's
// published tarball, else one built here with podman, or docker where there's no podman. FILE keeps the tarball, as CI does for
// its release; without it, a temporary one is used.
//   node scripts/agent.ts [FILE]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, download, id, unpack } from '../src/agent.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..'), out = process.argv[2];
const file = out ?? join(mkdtempSync(join(tmpdir(), 'rf-agent-')), `agent-${id}.tar.zst`);
if (!existsSync(file) && (out || !existsSync(join(AGENTS, id))) && !(await download(id, file))) {
  const tool = spawnSync('podman', ['--version']).status === 0 ? 'podman' : 'docker', tag = `rollforward-agent:${id}`;
  console.log(`agent-${id} isn't published: building it with ${tool}`);
  execFileSync(tool, ['build', '-q', '-t', tag, join(app, 'agent')], { stdio: 'inherit' });
  const ctr = execFileSync(tool, ['create', tag], { encoding: 'utf8' }).trim();
  try {
    execFileSync('sh', ['-c', '"$0" export "$1" | zstd -q -T0 -19 -o "$2"', tool, ctr, file], { stdio: 'inherit' });
  } finally {
    execFileSync(tool, ['rm', ctr], { stdio: 'ignore' });
  }
}
if (!existsSync(join(AGENTS, id))) await unpack(id, file);
if (!out) rmSync(dirname(file), { recursive: true, force: true });
console.log(join(AGENTS, id));
