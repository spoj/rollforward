import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { HttpError } from './store.ts';

// Skills: what to fetch or do, and how, each a Pi skill whole in a folder, which admins and those they let publish push with
// rf skill push (none ship here): a SKILL.md, whose front matter has `name` and `description`, then instructions the agent reads
// when it needs them, the links and addresses they use among them; and the scripts the agent runs in its sandbox, which reach the
// server through rf. Every run loads every live skill. Nothing in a skill is a secret: every login is a person's own (logins.ts).

// Skills are data: each push is a version, DATA/skills/versions/<id>/<n>/, with who pushed it and when in its .pushed.json, and
// DATA/skills/live/<id> links to the version runs use, so a push is live at once. Rolling back is pushing an earlier one again.
let root = '';
export function openSkills(dataRoot: string) {
  root = join(dataRoot, 'skills', 'live');
  mkdirSync(root, { recursive: true });
}
export const skillsDir = () => root;
export const pushed = (s: Skill): { version: number; by: string; at: string } => JSON.parse(readFileSync(join(s.dir, '.pushed.json'), 'utf8'));

const ID = /^[a-z0-9][a-z0-9-]*$/;
function checkId(id: string) {
  if (!ID.test(id)) throw new HttpError(400, 'a skill id is lowercase letters, digits and dashes');
}

export function pushSkill(id: string, files: Record<string, string>, by: string): number {
  checkId(id);
  if (!files['SKILL.md']) throw new HttpError(400, 'a skill has a SKILL.md at its top');
  for (const rel of Object.keys(files)) if (posix.normalize(rel) !== rel || rel.startsWith('../') || posix.isAbsolute(rel)) throw new HttpError(400, `bad path ${rel}`);
  const versions = join(root, '..', 'versions', id), n = Math.max(0, ...(existsSync(versions) ? readdirSync(versions).map(Number) : [])) + 1, dir = join(versions, String(n));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), Buffer.from(data, 'base64'));
  }
  writeFileSync(join(dir, '.pushed.json'), JSON.stringify({ version: n, by, at: new Date().toISOString() }));
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
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name !== '.pushed.json')
    .map(d => [posix.relative(dir, join(d.parentPath, d.name)), readFileSync(join(d.parentPath, d.name)).toString('base64')]));
}

// A version without its .pushed.json is a push that failed halfway.
export function versionsOf(id: string) {
  checkId(id);
  const dir = join(root, '..', 'versions', id);
  return existsSync(dir) ? readdirSync(dir).filter(n => existsSync(join(dir, n, '.pushed.json'))).map(n => JSON.parse(readFileSync(join(dir, n, '.pushed.json'), 'utf8'))).sort((a, b) => a.version - b.version) : [];
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
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => ID.test(id) && existsSync(join(root, id, 'SKILL.md'))).sort().map(id => {
    const dir = join(root, id), fm = frontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
    return { id, name: fm.name ?? id, description: fm.description ?? '', dir };
  });
}
