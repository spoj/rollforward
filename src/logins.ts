import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, type Entry, type Instance } from './store.ts';
import { canSee, changes, key, readJson, replaceFile, rfDir, tree } from './system.ts';
import { asPerson } from './auth.ts';
import service from './connections/service.ts';

// Every login is personal: a person's sign-in to Microsoft 365, Databricks or a website, their opt-in to a deployment's service,
// or their own OpenRouter key, which, `enabled`, their runs use in place of the server's (connections.ts), kept in .rf/people/<id>/. logins.json
// lists them, each with what it offers a run, such as a mailbox, a site or a SQL warehouse; each login's secret (Microsoft's refresh
// token, a website's saved browser state) is sealed in <login id>.sealed with AES-256-GCM, its person and id as authenticated data,
// so a record copied into another person's folder won't open. A run uses only its runner's logins, and only the offers ticked for
// its instance.
export type Offer = { id: string; name: string };
// Sign-in evidence contains hosts, never URLs. Older saved traces have no request kinds.
export type Trace = { requests: Record<string, Record<number, number>>; blocked: string[]; seconds: number; kinds?: Record<string, { dest: string[]; from: string[] }> };
export type Login = { id: string; kind: string; name: string; account?: string; since: string; offers: Offer[]; expired?: boolean; scopes?: string[]; enabled?: boolean; keepalive?: string; trace?: Trace };

export const personDir = (email: string) => join(rfDir(), 'people', createHash('sha256').update(email).digest('hex').slice(0, 16));
const list = (email: string) => join(personDir(email), 'logins.json');

export function logins(email: string): Login[] {
  const all: Login[] = existsSync(list(email)) ? JSON.parse(readFileSync(list(email), 'utf8')) : [];
  return all.map(l => {
    if (l.kind !== 'service') return l;
    const c = readJson<Record<string, any>>('connections.json', {})[l.id];
    return { ...l, offers: c?.type === 'service' ? service.login({ name: l.id, ...c }).offers : [] };
  });
}

// A login that becomes usable, new or signed in again after it expired, wakes the runs that waited for it (waker.ts).
export function saveLogin(email: string, login: Login, secret?: string) {
  const was = logins(email).find(l => l.id === login.id);
  mkdirSync(personDir(email), { recursive: true, mode: 0o700 });
  if (secret !== undefined) seal(email, login.id, secret);
  replaceFile(list(email), JSON.stringify([...logins(email).filter(l => l.id !== login.id), login], null, 1));
  if ((!was || was.expired) && !login.expired) changes.emit('login', email, login.id, login.name);
}

// A secret of a person's, in their folder, which `secret` reads back.
export function seal(email: string, id: string, secret: string) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key('seal.key'), iv).setAAD(Buffer.from(`${email}\n${id}`));
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  replaceFile(join(personDir(email), `${id}.sealed`), Buffer.concat([iv, c.getAuthTag(), body]));
}

export function secret(email: string, id: string): string {
  const b = readFileSync(join(personDir(email), `${id}.sealed`));
  const d = createDecipheriv('aes-256-gcm', key('seal.key'), b.subarray(0, 12)).setAAD(Buffer.from(`${email}\n${id}`));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// Signing out deletes the record, and a website's token with it.
export function signOut(email: string, id: string) {
  if (!logins(email).some(l => l.id === id)) throw new HttpError(404, `you have no login ${id}`);
  for (const s of [id, `${id}.header`]) rmSync(join(personDir(email), `${s}.sealed`), { force: true });
  replaceFile(list(email), JSON.stringify(logins(email).filter(l => l.id !== id), null, 1));
}

export function forgetLogins(email: string) {
  rmSync(personDir(email), { recursive: true, force: true });
}

// An offer its person added, such as a Microsoft 365 source or a Databricks warehouse, taken off their login.
export function unoffer(email: string, id: string, offer: string) {
  const login = logins(email).find(l => l.id === id);
  if (!login) throw new HttpError(404, `you have no login ${id}`);
  if (login.kind === 'service') throw new HttpError(400, 'admins keep a service connection\'s prefixes; untick one for the instance instead');
  saveLogin(email, { ...login, offers: login.offers.filter(o => o.id !== offer) });
}

// Ticks name offers of the person's own logins.
export function checkTicks(email: string, ticks: unknown): string[] {
  const mine = new Set(logins(email).flatMap(l => l.offers.map(o => o.id)));
  if (!Array.isArray(ticks) || !ticks.every(t => typeof t === 'string' && mine.has(t))) throw new HttpError(400, `logins must be offers of your own logins: ${JSON.stringify(ticks)}`);
  return ticks;
}

// What makes someone an instance's runner: making it, an earlier version's copy, or an assign, a takeover being an assign to oneself.
const MADE = ['create', 'duplicate', 'takeover', 'assign'];
const ranBy = (e: Entry) => e.op === 'assign' ? e.to as string : e.by;

// The last assign of an instance, as of an entry, by its seq, or of its log, a takeover being an assign to oneself.
export const lastAssign = (log: Entry[], upto = Infinity) => log.findLast(e => e.seq <= upto && ['takeover', 'assign'].includes(e.op));

// Who ran an instance as an entry, by its seq, was made, as the page shows history and costs count runs.
export const runnerAt = (log: Entry[], seq: number) => ranBy(log.findLast(e => e.seq < seq && MADE.includes(e.op))!);

// An instance's runner is whoever made it, copied it or was last assigned it, with the offers they ticked for it then or since, and
// the seq of the act that ticked them, their consent. An assign to someone else ticks none: they tick their own.
export function runnerOf(inst: Instance): { by: string; logins: string[]; consent: number } {
  // A deleted instance keeps no runner.
  if (inst.hole) return { by: '', logins: [], consent: 0 };
  const e = inst.log.findLast(e => [...MADE, 'logins'].includes(e.op))!;
  return { by: ranBy(e), logins: (e.logins as string[] | undefined) ?? [], consent: e.seq };
}

// An instance's runner, while they may still lend it their logins: they may still sign in and see the instance's workspace. A run
// lends only what was ticked as it started, its lease, and still is: a tick taken away stops it at once, one added waits for the
// next run.
export function lender(inst: Instance, run?: number): { by: string; logins: string[] } {
  const r = runnerOf(inst), p = asPerson(r.by), t = tree();
  // Admins see every workspace; a try's stand-in instance (cli.ts) is in none.
  if (!p || (p.role !== 'admin' && !canSee(p, t.workspaces[t.series[inst.seriesId].workspace])))
    throw new HttpError(403, `${r.by} can no longer run this instance, so their logins aren't used: someone in its workspace takes it over`);
  if (run === undefined) return r;
  const started = inst.log.find(e => e.op === 'run' && e.run === run)!, lease = inst.log[(started.consent as number) - 1].logins as string[];
  // An assign stops the run going first; what it still sends as it stops lends nothing of the new runner's.
  if (started.runner !== r.by) throw new HttpError(403, `run ${run} was ${started.runner}'s, and ${r.by} runs the instance now`);
  return { by: r.by, logins: r.logins.filter(l => lease.includes(l)) };
}

// The login a run may use for an offer: its lender's, if ticked for the run and still offered.
export function use(inst: Instance, run: number, offer: string): { email: string; login: Login } {
  const { by, logins: ticked } = lender(inst, run);
  if (!ticked.includes(offer)) throw new HttpError(403, `${offer} is not ticked for this instance; its runner, ${by}, ticks logins when starting or taking it over`);
  const login = logins(by).find(l => l.offers.some(o => o.id === offer));
  if (!login) throw Object.assign(new HttpError(409, `${by} no longer has a login offering ${offer}: they sign in again on the Logins page, and the instance carries on`), { login: offer.startsWith('web:') ? offer : offer.split(':')[0] });
  return { email: by, login };
}
