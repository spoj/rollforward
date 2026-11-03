import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

// The agent's userland is an image of agent/ (its Containerfile), which each run's sandbox has in place of the host's (sandbox.ts).
// Its id hashes that folder's files, by name and content, so a checkout alone says which image it runs: CI publishes the image's
// root once per id, as agent-<id>.tar.zst in the GitHub prerelease agent-<id>, and each checkout unpacks it into .agent/<id>.
// RF_AGENT_ROOT names a root instead, as in the container, which is built on the image.
export const agentId = (files: [string, Buffer][]) => createHash('sha256')
  .update(JSON.stringify(files.toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([name, data]) => [name, createHash('sha256').update(data).digest('hex')])))
  .digest('hex').slice(0, 16);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
export const id = agentId(readdirSync(join(app, 'agent')).map(f => [f, readFileSync(join(app, 'agent', f))]));
export const AGENTS = join(app, '.agent');
export const agentRoot = process.env.RF_AGENT_ROOT ?? join(AGENTS, id);
const release = (id: string) => `https://github.com/spoj/rollforward/releases/download/agent-${id}/agent-${id}.tar.zst`;

// A root's folders may be read-only, as some of an image's are.
export function remove(d: string) {
  if (!existsSync(d)) return;
  const writable = (p: string) => { chmodSync(p, 0o700); for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) writable(join(p, e.name)); };
  writable(d);
  rmSync(d, { recursive: true, force: true });
}

// The published tarball of `id` into `file`, checked against its sha256; false if none is published.
export async function download(id: string, file: string): Promise<boolean> {
  const [tar, sum] = await Promise.all([fetch(release(id)), fetch(`${release(id)}.sha256`)]);
  if (tar.status === 404 || sum.status === 404) return false;
  if (!tar.ok || !sum.ok) throw new Error(`GitHub answered ${tar.status} for ${release(id)}`);
  const hash = createHash('sha256'), want = (await sum.text()).split(/\s/)[0];
  await pipeline(Readable.fromWeb(tar.body!), new Transform({ transform(c, _e, done) { hash.update(c); done(null, c); } }), createWriteStream(`${file}.part`));
  if (hash.digest('hex') !== want) throw new Error(`${release(id)} doesn't match its sha256`);
  renameSync(`${file}.part`, file);
  return true;
}

// Unpacks a tarball of the image `id` into AGENTS/<id>, whole or not at all.
export async function unpack(id: string, file: string) {
  const to = join(AGENTS, id), part = `${to}.part`;
  remove(part);
  mkdirSync(part, { recursive: true });
  const tar = spawn('tar', ['-x', '-f', '-', '-C', part], { stdio: ['pipe', 'inherit', 'inherit'] });
  await Promise.all([pipeline(createReadStream(file), createZstdDecompress(), tar.stdin), once(tar, 'exit').then(([code]) => { if (code) throw new Error(`tar exited ${code} unpacking ${file}`); })]);
  renameSync(part, to);
}
