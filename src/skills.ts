import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.ts';
import { refused } from './git.ts';

// Skills: what to fetch or do, and how, each a Pi skill whole in a folder, which admins and those they let publish push with
// rf skill push (none ship here): a SKILL.md, whose front matter has `name` and `description`, then instructions the agent reads
// when it needs them, the links and addresses they use among them; and the scripts the agent runs in its sandbox, which reach the
// server through rf. Every run loads every live skill. Nothing in a skill is a secret: every login is a person's own (logins.ts).

// Skills are data: each push is a version, DATA/skills/versions/<id>/<n>/, with who pushed it and when in its .pushed.json, and
// DATA/skills/live/<id> links to the version runs use, so a push is live at once. Rolling back is pushing an earlier one again.
const builtinRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
let root = '';
export function openSkills(dataRoot: string) {
  root = join(dataRoot, 'skills', 'live');
  mkdirSync(root, { recursive: true });
}
export const pushed = (s: Skill): { version: number; by: string; at: string } => {
  const file = join(s.dir, '.pushed.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 0, by: 'builtin', at: '' };
};

const ID = /^[a-z0-9][a-z0-9-]*$/;
function checkId(id: string) {
  if (!ID.test(id)) throw new HttpError(400, 'a skill id is lowercase letters, digits and dashes');
}

export function pushSkill(id: string, files: Record<string, string>, by: string): number {
  checkId(id);
  if (!files['SKILL.md']) throw new HttpError(400, 'a skill has a SKILL.md at its top');
  for (const rel of Object.keys(files)) if (posix.normalize(rel) !== rel || rel.startsWith('../') || posix.isAbsolute(rel) || rel === '.pushed.json' || rel === '.pushed.json.tmp' || rel.split('/').some(n => !n || n === '.' || n === '..' || refused(n, false))) throw new HttpError(400, `bad path ${rel}`);
  const versions = join(root, '..', 'versions', id), n = Math.max(0, ...(existsSync(versions) ? readdirSync(versions).map(Number) : [])) + 1, dir = join(versions, String(n));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), Buffer.from(data, 'base64'));
  }
  const marker = join(dir, '.pushed.json');
  try {
    writeFileSync(`${marker}.tmp`, JSON.stringify({ version: n, by, at: new Date().toISOString() }));
    renameSync(`${marker}.tmp`, marker);
  } catch (e) {
    rmSync(`${marker}.tmp`, { force: true });
    throw e;
  }
  rmSync(`${join(root, id)}.new`, { force: true });
  symlinkSync(join('..', 'versions', id, String(n)), `${join(root, id)}.new`);
  renameSync(`${join(root, id)}.new`, join(root, id));
  return n;
}

// A version's files, to push again as the newest: the rollback.
export function versionFiles(id: string, n: number): Record<string, string> {
  checkId(id);
  const dir = join(root, '..', 'versions', id, String(n));
  if (!existsSync(dir)) throw new HttpError(404, `${id} has no version ${n}`);
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name !== '.pushed.json' && d.name !== '.pushed.json.tmp')
    .map(d => [posix.relative(dir, join(d.parentPath, d.name)), d] as const)
    .filter(([rel]) => !rel.split('/').some(n => refused(n, false)))
    .map(([rel, d]) => [rel, readFileSync(join(d.parentPath, d.name)).toString('base64')]));
}

// A version without a complete .pushed.json is a push that failed halfway.
export function versionsOf(id: string) {
  checkId(id);
  const dir = join(root, '..', 'versions', id);
  if (!existsSync(dir)) return [];
  const live = lstatSync(join(root, id), { throwIfNoEntry: false })?.isSymbolicLink() ? posix.basename(readlinkSync(join(root, id))) : '';
  const out: { version: number; by: string; at: string }[] = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n, '.pushed.json');
    if (!existsSync(f)) continue;
    const raw = readFileSync(f, 'utf8');
    try {
      const p = JSON.parse(raw);
      if (p && typeof p.version === 'number' && typeof p.by === 'string' && typeof p.at === 'string') out.push(p);
      else if (n === live) throw new SyntaxError(`corrupt ${f}`);
    } catch (e) {
      if (n === live || !(e instanceof SyntaxError)) throw e;
    }
  }
  return out.sort((a, b) => a.version - b.version);
}

export type Skill = { id: string; name: string; description: string; dir: string };

function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text), out: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function skills(): Skill[] {
  const byId = new Map<string, Skill>();
  const load = (base: string) => {
    if (!base || !existsSync(base)) return;
    for (const id of readdirSync(base)) {
      if (!ID.test(id) || byId.has(id) || !existsSync(join(base, id, 'SKILL.md'))) continue;
      const dir = join(base, id), fm = frontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      byId.set(id, { id, name: fm.name ?? id, description: fm.description ?? '', dir });
    }
  };
  load(root);
  load(builtinRoot);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
