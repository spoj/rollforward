import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The data root's .rf/ holds what only the server uses: the people who can sign in, the sessions' key, and each workspace's people.
// Its name starts with a dot, so no workspace can be called that.

// A workspace's people, each an email or an Entra group's id. Owners manage who is in it; owners and members see and work in all of
// it. A workspace with neither is the admins'.
export type Workspace = { owners: string[]; members: string[] };

let dir = '';

export function initSystem(root: string) {
  dir = join(root, '.rf');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(name: string, fallback: T): T {
  const p = join(dir, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}

export function writeJson(name: string, data: unknown) {
  const p = join(dir, name);
  writeFileSync(p + '.tmp', JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(p + '.tmp', p);
}

// A 32-byte key, made once and kept in .rf/.
export function key(name: string): Buffer {
  const p = join(dir, name);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32), { mode: 0o600, flag: 'wx' });
  return readFileSync(p);
}

export function workspaces(): Record<string, Workspace> {
  return readJson<Record<string, Workspace>>('workspaces.json', {});
}

export function workspace(name: string): Workspace {
  return workspaces()[name] ?? { owners: [], members: [] };
}

export function setWorkspace(name: string, w: Workspace) {
  writeJson('workspaces.json', { ...workspaces(), [name]: w });
}

export function forgetPerson(email: string) {
  const all = workspaces();
  for (const w of Object.values(all)) {
    w.owners = w.owners.filter(p => p !== email);
    w.members = w.members.filter(p => p !== email);
  }
  writeJson('workspaces.json', all);
}
