import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The data root's .rf/ holds what only the server uses: the people who can sign in, the sessions' key, and tree.json, the
// workspaces and series by id.

// A workspace's people are each an email or an Entra group's id. Owners manage who is in it; owners and members see and work in all
// of it. A workspace with neither is the admins'. Its proposal, a manager's, merges it into another workspace, or moves one of its
// series there, once a manager of that one accepts (server.ts); moved lists the series it moved out, which its people see go.
// A merge's `had` is the series the workspace had as it was proposed.
export type Proposal = { kind: 'merge' | 'move'; to: string; series?: string; had?: string[]; by: string; at: string };
export type Workspace = { name: string; owners: string[]; members: string[]; archived?: boolean; proposal?: Proposal; moved?: { name: string; to: string; at: string }[] };
// A task is a series marked single, holding one instance, named by its label until it is made a series.
export type Series = { name: string; workspace: string; archived?: boolean; single?: boolean };
// groups labels Entra groups by id, as people see them.
export type Tree = { workspaces: Record<string, Workspace>; series: Record<string, Series>; groups?: Record<string, string> };

let dir = '';

// What changed, for the page's event stream: an instance's id, or "tree" for anything in .rf/ such as names, wakes or logins.
export const changes = new EventEmitter().setMaxListeners(0);

export function initSystem(root: string) {
  dir = join(root, '.rf');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Its objects have no prototype, so a key a request names, such as __proto__ or constructor, finds nothing that isn't there.
export function readJson<T>(name: string, fallback: T): T {
  const p = join(dir, name);
  return JSON.parse(existsSync(p) ? readFileSync(p, 'utf8') : JSON.stringify(fallback), (_, v) => v?.constructor === Object ? Object.setPrototypeOf(v, null) : v);
}

export function writeJson(name: string, data: unknown) {
  const p = join(dir, name);
  writeFileSync(p + '.tmp', JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(p + '.tmp', p);
  changes.emit('change', 'tree');
}

export const rfDir = () => dir;

// What each person has seen of each instance, the last seq of its log they viewed, and since when, before which nothing is new to
// them: .rf/seen/EMAIL.json.
type Seen = { since: string; at: Record<string, number> };
const seenBy = new Map<string, Seen>();
export function seen(email: string): Seen {
  if (!seenBy.has(email)) seenBy.set(email, readJson(`seen/${email}.json`, { since: new Date().toISOString(), at: {} }));
  return seenBy.get(email)!;
}

// Written quietly, as no page shows what another has seen.
export function see(email: string, id: string, seq: number) {
  const s = seen(email);
  if (s.at[id] === seq) return;
  s.at[id] = seq;
  mkdirSync(join(dir, 'seen'), { recursive: true });
  writeFileSync(join(dir, 'seen', `${email}.json`), JSON.stringify(s));
}

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
// workspace with no one in it is the admins'. Owners and admins manage who is in it.
type Who = { email: string; role: string; groups: string[] };
export const isIn = (who: Who, people: string[]) => people.some(p => p === who.email || who.groups.includes(p));
// A list of people as workspaces, websites and capabilities take them: emails and Entra group ids.
export const isPeople = (list: unknown): list is string[] => Array.isArray(list)
  && list.every(p => typeof p === 'string' && /^[^@\s]+@[^@\s]+$|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p));
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
