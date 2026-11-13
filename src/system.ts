import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { BlockList } from 'node:net';
import { join } from 'node:path';

// The data root's .rf/ holds what only the server uses: the people who can sign in, the sessions' key, and tree.json, the
// workspaces and series by id.

// A workspace's people are each an email or an Entra group's id. Owners manage who is in it; owners and members see and work in all
// of it. A workspace with neither is the admins'. Its proposal, a manager's, merges it into another workspace, or moves one of its
// series there, once a manager of that one accepts (server.ts); moved lists the series it moved out, which its people see go.
// A merge's `had` is the series the workspace had as it was proposed. Its readers are the workspaces whose agents its managers let
// read it.
export type Proposal = { kind: 'merge' | 'move'; to: string; series?: string; had?: string[]; by: string; at: string };
export type Workspace = { name: string; owners: string[]; members: string[]; archived?: boolean; proposal?: Proposal; moved?: { name: string; to: string; at: string }[]; readers?: string[] };
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

// Writes a file whole, by renaming a temporary file into place, so a write cut short leaves the old one.
export function replaceFile(path: string, data: string | Buffer) {
  writeFileSync(path + '.tmp', data, { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function writeJson(name: string, data: unknown) {
  replaceFile(join(dir, name), JSON.stringify(data, null, 1));
  changes.emit('change', 'tree');
}

// The append-only logs of JSON lines: an instance's, a series' notes and the system's. An append a write error cut short, as on a
// full disk, is taken back; a last line a kill or a power cut left unended is dropped as the log is next read, and the server says so.
export function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const all = readFileSync(path), end = all.lastIndexOf(10) + 1;
  if (end < all.length) {
    console.error(`${path}: dropped a torn last line, ${all.length - end} bytes: ${all.subarray(end, end + 200).toString()}`);
    truncateSync(path, end);
  }
  return all.subarray(0, end).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function appendLine(path: string, line: string, mode?: number) {
  const fd = openSync(path, 'a', mode), size = fstatSync(fd).size;
  try {
    appendFileSync(fd, line + '\n');
  } catch (e) {
    ftruncateSync(fd, size);
    throw e;
  } finally {
    closeSync(fd);
  }
}

export const rfDir = () => dir;

// The system's log, .rf/log.jsonl: what people did beyond an instance, one act a line, by seq, each by who did it; an instance's acts
// are in its own log. A secret, or a file's content, is never written: such a field goes, however deep.
const UNLOGGED = ['key', 'header', 'token', 'secret', 'password', 'data', 'files'];
let acts = 0;
export function act(by: string, fields: Record<string, unknown>) {
  const p = join(dir, 'log.jsonl');
  acts ||= readLines(p).length;
  appendLine(p, JSON.stringify({ ...fields, seq: acts + 1, at: new Date().toISOString(), by }, (k, v) => UNLOGGED.includes(k) ? undefined : v), 0o600);
  acts++;
}

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
  replaceFile(join(dir, 'seen', `${email}.json`), JSON.stringify(s));
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

// The addresses no run's own request, nor a person's own website, reaches: private, loopback, link-local and Azure's WireServer.
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['168.63.129.16', 32], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');
export const isPrivate = (a: { address: string; family: number }) => {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a.address)?.[1];
  return v4 ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4');
};
