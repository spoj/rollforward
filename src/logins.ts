import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, type Entry, type Instance } from './store.ts';
import { canSee, changes, key, readJson, replaceFile, rfDir, tree } from './system.ts';
import { asPerson, can } from './auth.ts';
import { saveSeriesSettings, seriesSettings, type Authority, type SeriesConsent } from './series.ts';
import { seriesDir } from './store.ts';
import service from './connections/service.ts';

// Every login is personal: a person's sign-in to Microsoft 365, Databricks or a website, their opt-in to a deployment's service,
// or their own OpenRouter key, which, `enabled`, their runs use in place of the server's (connections.ts), kept in .rf/people/<id>/. logins.json
// lists them, each with what it offers a run, such as a mailbox, a site or a SQL warehouse; each login's secret (Microsoft's refresh
// token, a website's saved browser state) is sealed in <login id>.sealed with AES-256-GCM, its person and id as authenticated data,
// so a record copied into another person's folder won't open. Runs use their captured owner's explicitly selected series ceiling.
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
  changes.emit('offers-withdrawn', email, (was?.offers ?? []).filter(o => !login.offers.some(n => n.id === o.id)).map(o => o.id));
  changes.emit('change', 'tree');
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
  const was = logins(email).find(l => l.id === id);
  if (!was) throw new HttpError(404, `you have no login ${id}`);
  for (const s of [id, `${id}.header`]) rmSync(join(personDir(email), `${s}.sealed`), { force: true });
  replaceFile(list(email), JSON.stringify(logins(email).filter(l => l.id !== id), null, 1));
  changes.emit('offers-withdrawn', email, was.offers.map(o => o.id));
  changes.emit('change', 'tree');
  if (id === 'openrouter' && was.expired && was.enabled) changes.emit('login', email, id, was.name);
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
export function checkTicks(email: string, ticks: unknown, workspace?: string): string[] {
  const mine = new Set(logins(email).flatMap(l => l.offers.map(o => o.id)));
  if (!Array.isArray(ticks) || !ticks.every(t => typeof t === 'string' && mine.has(t))) throw new HttpError(400, `logins must be offers of your own logins: ${JSON.stringify(ticks)}`);
  if (workspace) {
    const grants = Object.values(readJson<Record<string, { state: string; site: string; person: string; workspace: string }>>('grants.json', {}));
    if (ticks.some(o => o.startsWith('web:') && !grants.some(g => g.state === 'approved' && g.site === o.slice(4) && g.person === email && g.workspace === workspace)))
      throw new HttpError(400, 'website credentials require your approved workspace grant; ask under Logins before selecting them');
  }
  return ticks;
}

// What makes someone an instance's runner: making it, an earlier version's copy, or an assign, a takeover being an assign to oneself.
const MADE = ['create', 'duplicate', 'takeover', 'assign'];
const ranBy = (e: Entry) => e.op === 'assign' ? e.to as string : e.by;

// The last assign of an instance, as of an entry, by its seq, or of its log, a takeover being an assign to oneself.
export const lastAssign = (log: Entry[], upto = Infinity) => log.findLast(e => e.seq <= upto && ['takeover', 'assign'].includes(e.op));

// Who ran an instance as an entry, by its seq, was made, as the page shows history and costs count runs.
export const runnerAt = (log: Entry[], seq: number) => ranBy(log.findLast(e => e.seq < seq && MADE.includes(e.op))!);

export function ownerOf(inst: Instance): { by: string; logins: string[]; epoch: number; workspace: string; consent?: SeriesConsent } {
  const s = seriesSettings(inst.series());
  return { by: s.owner ?? '', logins: s.consent?.logins ?? [], epoch: s.epoch, workspace: tree().series[inst.seriesId].workspace, consent: s.consent };
}

export function authority(inst: Instance): Authority {
  const r = ownerOf(inst), p = asPerson(r.by), t = tree();
  if (!p || !can(p, 'series-owner') || !canSee(p, t.workspaces[r.workspace]))
    throw new HttpError(403, 'the series owner must be enabled, opted in and able to see its workspace');
  if (!r.consent || r.consent.by !== r.by || r.consent.workspace !== r.workspace)
    throw new HttpError(403, 'the series owner must explicitly select credentials for ALL instances, including an empty selection');
  return { version: 1, owner: r.by, epoch: r.epoch, workspace: r.workspace, logins: [...r.logins], autonomous: r.consent.autonomous };
}

export function sameAuthority(inst: Instance, lease: Authority): boolean {
  const r = ownerOf(inst), p = asPerson(r.by);
  return !!p && can(p, 'series-owner') && canSee(p, tree().workspaces[r.workspace])
    && lease.version === 1 && lease.owner === r.by && lease.epoch === r.epoch && lease.workspace === r.workspace
    && !!r.consent && r.consent.by === r.by && r.consent.workspace === r.workspace
    && lease.logins.every(l => r.logins.includes(l));
}

// Current consent authorizes a new run; execution uses only its captured, still-valid lease.
export function lender(inst: Instance, run?: number): { by: string; logins: string[] } {
  if (inst.id === 'try') {
    const started = inst.log.find(e => e.op === 'run' && e.run === run)!, lease = started.authority as Authority;
    const p = asPerson(lease.owner);
    if (!p || p.role !== 'admin' || !can(p, 'series-owner')) throw new HttpError(403, 'try requires an enabled, opted-in admin');
    return { by: lease.owner, logins: lease.logins };
  }
  if (run === undefined) {
    const lease = authority(inst);
    return { by: lease.owner, logins: lease.logins };
  }
  const started = inst.log.find(e => e.op === 'run' && e.run === run)!, lease = started.authority as Authority | undefined;
  if (!lease || started.runner !== lease.owner || !sameAuthority(inst, lease))
    throw new HttpError(403, `run ${run}'s series authority has ended`);
  return { by: lease.owner, logins: [...lease.logins] };
}

changes.on('offers-withdrawn', (email: string, offers: string[]) => {
  for (const sid of Object.keys(tree().series)) {
    const s = seriesSettings(seriesDir(sid));
    if (s.owner !== email || !s.consent?.logins.some(o => offers.includes(o))) continue;
    const { consent, ...rest } = s;
    saveSeriesSettings(seriesDir(sid), { ...rest, epoch: s.epoch + 1, since: new Date().toISOString() });
  }
});

let checkingConsent = false;
changes.on('change', (id: string) => {
  if (id !== 'tree' || checkingConsent) return;
  checkingConsent = true;
  try {
    const t = tree(), grants = Object.values(readJson<Record<string, { state: string; site: string; person: string; workspace: string }>>('grants.json', {}));
    for (const [sid, meta] of Object.entries(t.series)) {
      const s = seriesSettings(seriesDir(sid));
      if (!s.consent) continue;
      const p = asPerson(s.owner!), offers = new Set(logins(s.owner!).flatMap(l => l.offers.map(o => o.id)));
      const valid = !!p && can(p, 'series-owner') && canSee(p, t.workspaces[meta.workspace]) && s.consent.workspace === meta.workspace
        && s.consent.logins.every(o => offers.has(o) && (!o.startsWith('web:') || grants.some(g => g.state === 'approved' && g.site === o.slice(4) && g.person === s.owner && g.workspace === meta.workspace)));
      if (valid) continue;
      const { consent, ...rest } = s;
      saveSeriesSettings(seriesDir(sid), { ...rest, epoch: s.epoch + 1, since: new Date().toISOString() });
    }
  } finally { checkingConsent = false; }
});

// The login a run may use for an offer: its lender's, if selected for the run and still offered.
export function use(inst: Instance, run: number, offer: string): { email: string; login: Login } {
  const { by, logins: ticked } = lender(inst, run);
  if (!ticked.includes(offer)) throw new HttpError(403, `${offer} is outside this run's selected series credentials; only its owner, ${by}, changes the ceiling for future runs`);
  const login = logins(by).find(l => l.offers.some(o => o.id === offer));
  if (!login) throw Object.assign(new HttpError(409, `${by} no longer has a login offering ${offer}: they sign in again on the Logins page, and the instance carries on`), { login: offer.startsWith('web:') ? offer : offer.split(':')[0] });
  return { email: by, login };
}
