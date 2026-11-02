import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HttpError } from './store.ts';
import { readJson, writeJson } from './system.ts';
import { readFlow, type Flow } from './flow.ts';
import { seal, type Field, type System } from './systems.ts';
import type { Adapter } from './signin.ts';

// Skills: what to fetch or do, and how, each whole in a folder <id>/ under RF_SKILLS_DIR, a deployment's own (none ship here):
// - SKILL.md, in Pi's format: a front matter with `name` and `description`, then instructions the agent reads when it needs them;
// - skill.json, rollforward's: {"uses": [what of the runner's Microsoft 365 login it reads: "m365-mail", "m365-files"], "settings": [fields, a
//   password among them marked "secret"], "site": {"hosts": [...]}} for a skill with a website of its own;
// - what it runs: scripts the agent runs in its sandbox, which reach the server through rf; flows (*.flow.json) the server runs in
//   the skill's website; and, for a site whose sign-in is more than a name and a password, signin.ts (see signin.ts).
// Admins set each skill's settings once, under Skills (.rf/skills.json, secrets sealed); a series only chooses which skills it uses.

// Tests point this at stand-in skills.
let root = process.env.RF_SKILLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
export const useSkillsDir = (dir: string) => { root = dir; };
export const skillsDir = () => root;

export type Skill = {
  id: string; name: string; description: string; dir: string; uses: string[]; settings: Field[];
  site?: { hosts: string[] }; flows: string[]; signin: boolean;
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
      ...(meta.site && { site: { hosts: meta.site.hosts ?? [] } }),
      flows: readdirSync(dir).filter(f => f.endsWith('.flow.json')).map(f => f.replace(/\.flow\.json$/, '')),
      signin: existsSync(join(dir, 'signin.ts')),
    };
  });
}

export const skill = (id: string) => skills().find(s => s.id === id);

// ---- Settings, kept by admins for every series.

type Saved = Record<string, string>;
const all = () => readJson<Record<string, Saved>>('skills.json', {});

// A skill's settings as saved, secrets still sealed.
export const skillConfig = (id: string): Saved => all()[id] ?? {};

// What the agent may read of a skill's settings: all but its secrets.
export function publicSettings(s: Skill): Record<string, string> {
  const c = skillConfig(s.id), out: Record<string, string> = {};
  for (const f of s.settings) if (!f.secret && c[f.key]) out[f.key] = c[f.key];
  return out;
}

// What a skill still needs before a run can use it: its settings.
export function skillMissing(s: Skill): string[] {
  const c = skillConfig(s.id);
  return s.settings.filter(f => !f.optional && !c[f.key]).map(f => f.label.toLowerCase());
}

const USES: Record<string, string> = { 'm365-mail': "the runner's Microsoft 365 mail", 'm365-files': "the runner's Microsoft 365 files" };

// What the Skills page shows: never a secret, only whether one is saved.
export function skillView(s: Skill, admin: boolean) {
  const need = skillMissing(s), base = { id: s.id, name: s.name, description: s.description, uses: s.uses.map(u => USES[u] ?? u), configured: !need.length };
  if (!admin) return base;
  const c = skillConfig(s.id);
  return {
    ...base, missing: need, settings: s.settings, flows: s.flows, site: !!s.site, values: publicSettings(s),
    secrets: Object.fromEntries(s.settings.filter(f => f.secret).map(f => [f.key, !!c[f.key]])), updated_by: c.updated_by, updated_at: c.updated_at,
  };
}

// Saves a skill's settings. A secret left empty keeps the one saved; any other setting left empty is cleared.
export function saveSkillConfig(id: string, input: Record<string, unknown>, by: string): Saved {
  const s = skill(id);
  if (!s) throw new HttpError(404, `no skill ${id}`);
  const old = skillConfig(id), out: Saved = {};
  for (const f of s.settings) {
    const v = typeof input[f.key] === 'string' ? (input[f.key] as string) : '';
    if (v.length > 2000) throw new HttpError(400, `${f.label}: up to 2000 characters`);
    if (f.secret) { if (v) out[f.key] = seal(v); else if (old[f.key]) out[f.key] = old[f.key]; continue; }
    if (v.trim()) out[f.key] = v.trim();
  }
  for (const k of Object.keys(input)) if (!s.settings.some(f => f.key === k)) throw new HttpError(400, `${id} has no setting ${k}`);
  if (s.site && out.url && !/^https?:\/\/[^/]/.test(out.url)) throw new HttpError(400, 'address: an http(s) address');
  const list = all();
  list[id] = { ...out, updated_by: by, updated_at: new Date().toISOString() };
  writeJson('skills.json', list);
  return list[id];
}

// A skill's website as the browser takes it: its address and account from the skill's settings, its hosts from skill.json.
export function siteOf(s: Skill): System {
  if (!s.site) throw new HttpError(400, `${s.id} has no website`);
  const c = skillConfig(s.id);
  return {
    id: s.id, name: s.name, kind: 'web', url: c.url, username: c.username, password: c.password,
    settings: { ...(c.otp_mail && { otp_mail: c.otp_mail }) }, writes: [], extra_origins: s.site.hosts,
  };
}

// The skill's own sign-in, if it has one.
export async function loadSignIn(s: Skill): Promise<Adapter | undefined> {
  if (!s.signin) return undefined;
  return (await import(pathToFileURL(join(s.dir, 'signin.ts')).href)).default as Adapter;
}

// ---- A series' choice.

// The skill ids a series may save: ones that exist.
export function checkChosen(input: unknown): string[] {
  if (!Array.isArray(input) || !input.every(x => typeof x === 'string')) throw new HttpError(400, 'skills is a list of skill ids');
  for (const id of input) if (!skill(id)) throw new HttpError(400, `no skill ${id}; there are ${skills().map(x => x.id).join(', ')}`);
  return [...new Set(input as string[])];
}

// A flow of one of the chosen skills, by "skill/flow", with the skill's settings as its variables.
export function findFlow(chosen: string[], name: string): { skill: Skill; flow: Flow; vars: Record<string, string> } {
  const [id, flow] = name.split('/');
  const s = chosen.includes(id) ? skill(id) : undefined;
  if (!s) throw new HttpError(403, `${id} is not in this series' Skill use`);
  if (!flow || !s.flows.includes(flow)) throw new HttpError(404, `${id} has no flow ${flow ?? ''}; it has ${s.flows.join(', ') || 'none'}`);
  return { skill: s, flow: readFlow(join(s.dir, `${flow}.flow.json`)), vars: publicSettings(s) };
}
