import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, type Instance } from './store.ts';
import { canSee, changes, key, rfDir, tree } from './system.ts';
import { users } from './auth.ts';

// Every login is personal: a person's own sign-in to Microsoft 365 or to a website, kept in .rf/people/<id>/. logins.json lists
// them, each with what it offers a run, such as a mailbox or a site; each login's secret (Microsoft's refresh token, a website's
// saved browser state) is sealed in <login id>.sealed with AES-256-GCM, its person and id as authenticated data, so a record
// copied into another person's folder won't open. A run uses only its runner's logins, and only the offers ticked for its instance.
export type Offer = { id: string; name: string };
export type Login = { id: string; kind: 'm365' | 'website'; name: string; account?: string; since: string; offers: Offer[]; expired?: boolean };

const folder = (email: string) => join(rfDir(), 'people', createHash('sha256').update(email).digest('hex').slice(0, 16));
const list = (email: string) => join(folder(email), 'logins.json');

export function logins(email: string): Login[] {
  return existsSync(list(email)) ? JSON.parse(readFileSync(list(email), 'utf8')) : [];
}

// A login that becomes usable, new or signed in again after it expired, wakes the runs that waited for it (waker.ts).
export function saveLogin(email: string, login: Login, secret?: string) {
  const was = logins(email).find(l => l.id === login.id);
  mkdirSync(folder(email), { recursive: true, mode: 0o700 });
  if (secret !== undefined) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key('seal.key'), iv).setAAD(Buffer.from(`${email}\n${login.id}`));
    const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
    writeFileSync(join(folder(email), `${login.id}.sealed`), Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
  }
  writeFileSync(list(email), JSON.stringify([...logins(email).filter(l => l.id !== login.id), login], null, 1), { mode: 0o600 });
  if ((!was || was.expired) && !login.expired) changes.emit('login', email, login.id, login.name);
}

export function secret(email: string, id: string): string {
  const b = readFileSync(join(folder(email), `${id}.sealed`));
  const d = createDecipheriv('aes-256-gcm', key('seal.key'), b.subarray(0, 12)).setAAD(Buffer.from(`${email}\n${id}`));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// Signing out deletes the record.
export function signOut(email: string, id: string) {
  rmSync(join(folder(email), `${id}.sealed`), { force: true });
  writeFileSync(list(email), JSON.stringify(logins(email).filter(l => l.id !== id), null, 1), { mode: 0o600 });
}

export function forgetLogins(email: string) {
  rmSync(folder(email), { recursive: true, force: true });
}

// Ticks name offers of the person's own logins.
export function checkTicks(email: string, ticks: unknown): string[] {
  const mine = new Set(logins(email).flatMap(l => l.offers.map(o => o.id)));
  if (!Array.isArray(ticks) || !ticks.every(t => typeof t === 'string' && mine.has(t))) throw new HttpError(400, `logins must be offers of your own logins: ${JSON.stringify(ticks)}`);
  return ticks;
}

// An instance's runner is whoever made it, copied it or last took it over, with the offers they ticked for it then.
export function runnerOf(inst: Instance): { by: string; logins: string[] } {
  const e = inst.log.findLast(e => e.op === 'create' || e.op === 'duplicate' || e.op === 'takeover')!;
  return { by: e.by, logins: (e.logins as string[] | undefined) ?? [] };
}

// The login a run may use for an offer: its runner's, if ticked for the instance and still offered, while the runner may still sign
// in and see the instance's workspace.
export function use(inst: Instance, offer: string): { email: string; login: Login } {
  const { by, logins: ticked } = runnerOf(inst), u = users()[by], t = tree();
  if (!u || u.disabled || !canSee({ email: by, role: u.role, groups: u.groups ?? [] }, t.workspaces[t.series[inst.seriesId].workspace]))
    throw new HttpError(403, `${by} can no longer run this instance, so their logins aren't used: someone in its workspace takes it over`);
  if (!ticked.includes(offer)) throw new HttpError(403, `${offer} is not ticked for this instance; its runner, ${by}, ticks logins when starting or taking it over`);
  const login = logins(by).find(l => l.offers.some(o => o.id === offer));
  if (!login) throw new HttpError(403, `${by} no longer has a login offering ${offer}; they sign in again on the Logins page`);
  return { email: by, login };
}
