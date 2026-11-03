import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, constants, createReadStream, existsSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

// Each sign-off, each Close and each rf commit commits the whole instance folder to its own repository, .git in the folder, which
// only the server writes and runs read. The server reads every file itself and streams them to git fast-import, so nothing a run
// leaves in the folder, such as a .gitignore, a repository of its own or a file swapped for a link, changes what a commit holds:
// every regular file, whatever its size or type, and links as links. Only what git can't hold is left out: a name it refuses, such
// as a .git, and what is neither a file nor a link, such as a FIFO. One instance's commits go one at a time.
export type Who = { name: string; email: string };

// The server's git, with none of the settings of whoever runs it.
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = async (dir: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd: dir, env })).stdout.trim();
const queue = new Map<string, Promise<unknown>>();

export function commit(dir: string, who: Who, message: string): Promise<string> {
  const next = (queue.get(dir) ?? Promise.resolve()).then(() => snapshot(dir, who, message));
  queue.set(dir, next.catch(() => {}));
  return next;
}

// The names git refuses, as its verify_path() does with core.protectNTFS, its default: .git in any case, or its short name git~1,
// with trailing dots or spaces or an NTFS stream, also after any backslash but a leading one; and a link named .gitmodules, or a
// short name of it.
const DOTGIT = /^(\.git|git~1)[. ]*([:\\]|$)/i;
const MODULES = /^(\.gitmodules|gitmod~[1-4]|gi7eba~[1-9]|gi7eb~[1-9]\d|gi7e~[1-9]\d{2}|gi7~[1-9]\d{3}|gi~[1-9]\d{4}|g~[1-9]\d{5}|~[1-9]\d{6})[. ]*(:|$)/i;
const refused = (name: string, link: boolean) => [name, ...Array.from(name.slice(1).matchAll(/\\/g), m => name.slice(m.index + 2))]
  .some(t => DOTGIT.test(t) || (link && MODULES.test(t)));

const ident = (w: Who) => `${w.name.replace(/[<>\n]/g, '')} <${w.email.replace(/[<>\n]/g, '')}>`;
// A path as fast-import reads one: as it is, or in C-style quotes when it holds a newline or starts with a quote.
const quote = (b: Buffer) => (!b.includes(10) && b[0] !== 34 ? b
  : Buffer.concat([Buffer.from('"'), Buffer.from([...b].flatMap(c => (c === 10 ? [92, 110] : c === 34 || c === 92 ? [92, c] : [c]))), Buffer.from('"')]));
const SLASH = Buffer.from('/');
// What can't be read, such as a file a run made unreadable, fails the commit, by its path in the folder.
const read = <T>(path: Buffer, f: () => T): T => {
  try { return f(); } catch (e) { throw new Error(`${path} can't be read: ${(e as NodeJS.ErrnoException).code}`); }
};

// What the last commit read of each file, by its path: its inode, size, modification and change times and mode, and its blob. A file
// whose are the same is that blob, unread, as git's index does it: a run can set a file's modification time, never its change time.
// One changed in the second before it was read isn't kept, as the clock may not have moved for a change after.
type Seen = Map<string, [string, string]>;

// The folder's files and links as fast-import's file commands. Each name is reached through its folder's open descriptor, and
// opened without following a link, so a folder swapped for a link meanwhile leads nowhere outside. Names are bytes, as git keeps
// them, which needn't be UTF-8.
async function* files(dfd: number, rel: Buffer, seen: Seen, now: Seen): AsyncGenerator<Buffer> {
  const at = (name: Buffer) => Buffer.concat([Buffer.from(`/proc/self/fd/${dfd}/`), name]);
  for (const d of readdirSync(`/proc/self/fd/${dfd}`, { withFileTypes: true, encoding: 'buffer' })) {
    const name = d.name as unknown as Buffer, path = rel.length ? Buffer.concat([rel, SLASH, name]) : name;
    if (refused(name.toString('latin1'), d.isSymbolicLink())) continue;
    if (d.isDirectory()) {
      const sub = read(path, () => openSync(at(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      try { yield* files(sub, path, seen, now); } finally { closeSync(sub); }
    } else if (d.isSymbolicLink()) {
      const to = read(path, () => readlinkSync(at(name), { encoding: 'buffer' }));
      yield Buffer.concat([Buffer.from('M 120000 inline '), quote(path), Buffer.from(`\ndata ${to.length}\n`), to, Buffer.from('\n')]);
    } else if (d.isFile()) {
      const fd = read(path, () => openSync(at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)), st = fstatSync(fd, { bigint: true });
      const mode = st.mode & 0o111n ? '100755' : '100644', key = path.toString('latin1'), stat = `${st.ino} ${st.size} ${st.mtimeNs} ${st.ctimeNs} ${mode}`;
      const was = seen.get(key), size = Number(st.size), fresh = st.ctimeNs > BigInt(Date.now() - 1000) * 1_000_000n;
      if (!st.isFile() || !size || was?.[0] === stat) closeSync(fd);
      if (!st.isFile()) throw new Error(`${path} changed as it was committed`);
      if (was?.[0] === stat) {
        now.set(key, was);
        yield Buffer.concat([Buffer.from(`M ${mode} ${was[1]} `), quote(path), Buffer.from('\n')]);
        continue;
      }
      yield Buffer.concat([Buffer.from(`M ${mode} inline `), quote(path), Buffer.from(`\ndata ${size}\n`)]);
      const blob = createHash('sha1').update(`blob ${size}\0`);
      let sent = 0;
      if (size) for await (const c of createReadStream('', { fd, end: size - 1 })) { sent += c.length; blob.update(c); yield c; }
      if (sent !== size) throw new Error(`${path} changed as it was committed`);
      if (!fresh) now.set(key, [stat, blob.digest('hex')]);
      yield Buffer.from('\n');
    }
  }
}

async function* stream(dir: string, who: Who, message: string, parent: string, seen: Seen, now: Seen) {
  const at = Math.floor(Date.now() / 1000), text = Buffer.from(`${message.trim()}\n`);
  yield Buffer.from(`commit refs/heads/main\nauthor ${ident(who)} ${at} +0000\ncommitter rollforward <server@rollforward> ${at} +0000\ndata ${text.length}\n`);
  yield text;
  yield Buffer.from(`${parent ? `from ${parent}\n` : ''}deleteall\n`);
  const top = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { yield* files(top, Buffer.alloc(0), seen, now); } finally { closeSync(top); }
  yield Buffer.from('done\n');
}

async function snapshot(dir: string, who: Who, message: string): Promise<string> {
  if (!existsSync(join(dir, '.git'))) {
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'core.bigFileThreshold', '64m');
    await git(dir, 'config', 'gc.auto', '0');
  }
  const parent = await git(dir, 'rev-parse', '-q', '--verify', 'refs/heads/main').catch(() => '');
  const cache = join(dir, '.git', 'rf-seen.json'), now: Seen = new Map();
  const seen: Seen = new Map(parent && existsSync(cache) ? Object.entries(JSON.parse(readFileSync(cache, 'latin1'))) : []);
  const p = spawn('git', ['fast-import', '--quiet', '--done'], { cwd: dir, env, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', c => (err += c));
  const exit = once(p, 'close');
  const fed = await pipeline(stream(dir, who, message, parent, seen, now), p.stdin).then(() => undefined, (e: NodeJS.ErrnoException) => e);
  const [code] = await exit;
  // A broken pipe means git stopped reading, and says why.
  if (fed && fed.code !== 'EPIPE') throw fed;
  if (code) throw new Error(`git fast-import failed: ${err.trim()}`);
  const hash = await git(dir, 'rev-parse', 'refs/heads/main');
  writeFileSync(cache, JSON.stringify(Object.fromEntries(now)), 'latin1');
  // An index of the commit, so a run's git diff and git status show what changed since.
  await git(dir, 'read-tree', hash);
  return hash;
}
