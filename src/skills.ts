import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { HttpError } from './store.ts';
import { readJson, writeJson } from './system.ts';

// Skills: what to fetch or do, and how, each whole in a folder, which publishers push with rf skill push (none ship here):
// - SKILL.md, in Pi's format: a front matter with `name` and `description`, then instructions the agent reads when it needs them;
// - skill.json, rollforward's: {"uses": [what of the runner's Microsoft 365 login it reads: "m365-mail", "m365-files"], "settings":
//   [fields], "site": {"hosts": [...], "reads_that_post": [...]}} for a skill with a website, which people sign in to themselves;
// - scripts the agent runs in its sandbox, which reach the server through rf, and drive the website through `rf browser open`.
// Admins set each skill's settings once (rf skill set, into .rf/skills.json); a series only chooses which skills it uses. No setting
// is a secret: every login is a person's own (logins.ts).

export type Field = { key: string; label: string; hint?: string; optional?: boolean };

// Skills are data: each push is a version, DATA/skills/versions/<id>/<n>/, with who pushed it and when in its .pushed.json, and
// DATA/skills/live/<id> links to the version runs use, so a push is live at once. Rolling back is pushing an earlier one again.
let root = '';
export function openSkills(dataRoot: string) {
  root = join(dataRoot, 'skills', 'live');
  mkdirSync(root, { recursive: true });
}
export const skillsDir = () => root;
export const pushed = (s: Skill): { version: number; by: string; at: string } => JSON.parse(readFileSync(join(s.dir, '.pushed.json'), 'utf8'));

export function pushSkill(id: string, files: Record<string, string>, by: string): number {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new HttpError(400, 'a skill id is lowercase letters, digits and dashes');
  if (!files['SKILL.md']) throw new HttpError(400, 'a skill has a SKILL.md at its top');
  for (const rel of Object.keys(files)) if (posix.normalize(rel) !== rel || rel.startsWith('../') || posix.isAbsolute(rel)) throw new HttpError(400, `bad path ${rel}`);
  const versions = join(root, '..', 'versions', id), n = Math.max(0, ...(existsSync(versions) ? readdirSync(versions).map(Number) : [])) + 1, dir = join(versions, String(n));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), Buffer.from(data, 'base64'));
  }
  writeFileSync(join(dir, '.pushed.json'), JSON.stringify({ version: n, by, at: new Date().toISOString() }));
  symlinkSync(join('..', 'versions', id, String(n)), `${join(root, id)}.new`);
  renameSync(`${join(root, id)}.new`, join(root, id));
  return n;
}

// A version's files, to push again as the newest: the rollback.
export function versionFiles(id: string, n: number): Record<string, string> {
  const dir = join(root, '..', 'versions', id, String(n));
  if (!existsSync(dir)) throw new HttpError(404, `${id} has no version ${n}`);
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name !== '.pushed.json')
    .map(d => [posix.relative(dir, join(d.parentPath, d.name)), readFileSync(join(d.parentPath, d.name)).toString('base64')]));
}

export const versionsOf = (id: string) => {
  const dir = join(root, '..', 'versions', id);
  return existsSync(dir) ? readdirSync(dir).map(n => JSON.parse(readFileSync(join(dir, n, '.pushed.json'), 'utf8'))).sort((a, b) => a.version - b.version) : [];
};

export type Skill = {
  id: string; name: string; description: string; dir: string; uses: string[]; settings: Field[];
  site?: { hosts: string[]; reads_that_post: string[] };
};

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
  return readdirSync(root).filter(id => existsSync(join(root, id, 'SKILL.md'))).sort().map(id => {
    const dir = join(root, id), fm = frontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
    const meta = existsSync(join(dir, 'skill.json')) ? JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf8')) : {};
    return {
      id, name: fm.name ?? id, description: fm.description ?? '', dir, uses: meta.uses ?? [], settings: meta.settings ?? [],
      ...(meta.site && { site: { hosts: meta.site.hosts ?? [], reads_that_post: meta.site.reads_that_post ?? [] } }),
    };
  });
}

export const skill = (id: string) => skills().find(s => s.id === id);

// ---- Settings, kept by admins for every series.

type Saved = Record<string, string>;
const all = () => readJson<Record<string, Saved>>('skills.json', {});

export const skillConfig = (id: string): Saved => all()[id] ?? {};

// A skill's settings, as the agent reads them.
export function settingsOf(s: Skill): Record<string, string> {
  const c = skillConfig(s.id), out: Record<string, string> = {};
  for (const f of s.settings) if (c[f.key]) out[f.key] = c[f.key];
  return out;
}

// What a skill still needs before a run can use it: its settings.
export function skillMissing(s: Skill): string[] {
  const c = skillConfig(s.id);
  return s.settings.filter(f => !f.optional && !c[f.key]).map(f => f.label.toLowerCase());
}

const USES: Record<string, string> = { 'm365-mail': "the runner's Microsoft 365 mail", 'm365-files': "the runner's Microsoft 365 files" };

export function skillView(s: Skill, admin: boolean) {
  const need = skillMissing(s), base = { id: s.id, name: s.name, description: s.description, uses: s.uses.map(u => USES[u] ?? u), site: !!s.site, configured: !need.length, pushed: pushed(s) };
  if (!admin) return base;
  const c = skillConfig(s.id);
  return {
    ...base, missing: need, settings: s.settings, values: settingsOf(s), updated_by: c.updated_by, updated_at: c.updated_at,
  };
}

// Saves a skill's settings; one left empty is cleared.
export function saveSkillConfig(id: string, input: Record<string, unknown>, by: string): Saved {
  const s = skill(id);
  if (!s) throw new HttpError(404, `no skill ${id}`);
  const out: Saved = {};
  for (const f of s.settings) {
    const v = typeof input[f.key] === 'string' ? (input[f.key] as string) : '';
    if (v.length > 2000) throw new HttpError(400, `${f.label}: up to 2000 characters`);
    if (v.trim()) out[f.key] = v.trim();
  }
  for (const k of Object.keys(input)) if (!s.settings.some(f => f.key === k)) throw new HttpError(400, `${id} has no setting ${k}`);
  if (s.site && out.url && !/^https?:\/\/[^/]/.test(out.url)) throw new HttpError(400, 'address: an http(s) address');
  const list = all();
  list[id] = { ...out, updated_by: by, updated_at: new Date().toISOString() };
  writeJson('skills.json', list);
  return list[id];
}

// A skill's website as the machines service takes it: where the sign-in starts (its address setting), the hosts the browser may
// reach (that address's and skill.json's), and the requests that post but only read.
export function siteOf(id: string): { hosts: string[]; start_url: string; reads_that_post: string[] } {
  const s = skill(id);
  if (!s?.site) throw new HttpError(404, `no website ${id}; the skills with one are ${skills().filter(x => x.site).map(x => x.id).join(', ') || 'none'}`);
  const url = skillConfig(id).url;
  if (!url) throw new HttpError(409, `${s.name} has no address yet: an admin sets it under Skills`);
  return { hosts: [new URL(url).hostname, ...s.site.hosts], start_url: url, reads_that_post: s.site.reads_that_post };
}

// ---- A series' choice.

// The skill ids a series may save: ones that exist.
export function checkChosen(input: unknown): string[] {
  if (!Array.isArray(input) || !input.every(x => typeof x === 'string')) throw new HttpError(400, 'skills is a list of skill ids');
  for (const id of input) if (!skill(id)) throw new HttpError(400, `no skill ${id}; there are ${skills().map(x => x.id).join(', ')}`);
  return [...new Set(input as string[])];
}
