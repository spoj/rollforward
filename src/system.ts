import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The data root's .rf/ holds what only the server uses: the people who can sign in, the sessions' key, and tree.json, the
// workspaces and series by id.

// A workspace's people are each an email or an Entra group's id. Owners manage who is in it; owners and members see and work in all
// of it. A workspace with neither is the admins'.
export type Workspace = { name: string; owners: string[]; members: string[]; archived?: boolean };
export type Series = { name: string; workspace: string; archived?: boolean; adhoc?: boolean };
export type Tree = { workspaces: Record<string, Workspace>; series: Record<string, Series> };

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

export const rfDir = () => dir;

// A 32-byte key. Where systemd runs the server, it's the credential of that name (LoadCredentialEncrypted=, sealed to the machine's
// TPM), so a copy of the data holds only ciphertext; elsewhere, as in the container image, it's made once and kept in .rf/.
export function key(name: string): Buffer {
  if (process.env.CREDENTIALS_DIRECTORY) return readFileSync(join(process.env.CREDENTIALS_DIRECTORY, name));
  const p = join(dir, name);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32), { mode: 0o600, flag: 'wx' });
  return readFileSync(p);
}

export const everyone = (w: Workspace) => [...w.owners, ...w.members];

// Owners and members see a workspace and everything in it, by their email or an Entra group they're in; admins see every one. A
// workspace with no one in it, such as the demo's, is the admins'. Owners and admins manage who is in it.
type Who = { email: string; role: string; groups: string[] };
const isIn = (who: Who, people: string[]) => people.some(p => p === who.email || who.groups.includes(p));
export const canSee = (who: Who, w: Workspace) => who.role === 'admin' || isIn(who, everyone(w));
export const canManage = (who: Who, w: Workspace) => who.role === 'admin' || isIn(who, w.owners);

export function tree(): Tree {
  return readJson<Tree>('tree.json', { workspaces: {}, series: {} });
}

export function saveTree(t: Tree) {
  writeJson('tree.json', t);
}

export function forgetPerson(email: string) {
  const t = tree();
  for (const w of Object.values(t.workspaces)) {
    w.owners = w.owners.filter(p => p !== email);
    w.members = w.members.filter(p => p !== email);
  }
  saveTree(t);
}
