import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './store.ts';
import { changes } from './system.ts';
import { renew, upsertUser, users } from './auth.ts';
import { logins, personDir, saveLogin, seal, secret } from './logins.ts';
import { dropUnpermittedVpns } from './vpns.ts';
import { endSignIns, endUnpermittedSignIns } from './browsers.ts';

// A person's Entra logins, each a connection's (connections.ts), such as Microsoft 365's: each access token comes from the login's
// sealed refresh token, which turns over as it's used and is sealed again. A login Microsoft no longer renews is marked expired,
// for its person to sign in again on the Logins page.

const tokens = new Map<string, { token: string; exp: number; since: string }>();

// The login as it is now: its person may change its offers, or sign out, while Microsoft answers.
const current = (email: string, id: string) => logins(email).find(l => l.id === id);

// A token for `scope`, kept until it expires, or its login is signed in to again, as to grant more, or signed out of.
export async function token(email: string, id: string, scope: string[]): Promise<string> {
  const t = tokens.get(`${id} ${email}`), login = current(email, id);
  if (t && t.exp > Date.now() && t.since === login?.since) return t.token;
  if (!login || login.expired) throw Object.assign(new HttpError(409, `${email} has no current ${login?.name ?? id} login: they sign in to it on the Logins page`), { login: id });
  try {
    // Until its person consents to what the server asks for anew, a Microsoft 365 login renews with what Microsoft last granted it.
    const sealed = secret(email, id), r = await renew(sealed, scope).catch(e => e.consent && login.scopes ? renew(sealed, login.scopes.map(s => `https://graph.microsoft.com/${s}`)) : Promise.reject(e));
    const now = current(email, id);
    if (now) saveLogin(email, { ...now, ...(id === 'm365' && r.scopes && { scopes: r.scopes }) }, r.refresh);
    tokens.set(`${id} ${email}`, { token: r.access, exp: r.expires, since: login.since });
    return r.access;
  } catch (e) {
    if ((e as HttpError).status !== 401) throw e;
    const now = current(email, id);
    if (now) saveLogin(email, { ...now, expired: true });
    throw Object.assign(new HttpError(409, `${email}'s ${login.name} login has expired: they sign in to it again on the Logins page`), { login: id });
  }
}

// A person's sign-in to rollforward, kept as its refresh token, which signing in again replaces, waking what waited for it (waker.ts).
export function keepSignIn(email: string, refresh: string) {
  mkdirSync(personDir(email), { recursive: true, mode: 0o700 });
  seal(email, 'entra', refresh);
  changes.emit('login', email, 'entra', 'rollforward');
}

// Whether Microsoft still signs the person in, as each run of theirs asks before it starts: their sign-in renews, its refresh token
// turning over as it does, and their groups replaced by those its ID token names. Without one kept, or Microsoft refusing it, it answers 401, as for one expired or revoked, for its person to sign in again; one disabled here, or that Microsoft says is disabled or gone
// (AADSTS50057, AADSTS50034), carries `left`, and is disabled here too. Other failures, as when Microsoft can't be reached, throw
// as they come.
export async function confirm(email: string) {
  if (users()[email]?.disabled) throw Object.assign(new HttpError(401, `${email} is disabled here`), { left: true });
  if (!existsSync(join(personDir(email), 'entra.sealed'))) throw new HttpError(401, `${email} hasn't signed in to rollforward since sign-ins are kept`);
  try {
    const r = await renew(secret(email, 'entra'), []), claims = JSON.parse(Buffer.from(r.idToken.split('.')[1], 'base64url').toString());
    seal(email, 'entra', r.refresh);
    upsertUser(email, { groups: Array.isArray(claims.groups) ? claims.groups.map(String) : [] });
    await endUnpermittedSignIns();
    await dropUnpermittedVpns();
  } catch (e) {
    if (!/AADSTS(50057|50034)\b/.test((e as Error).message)) throw e;
    upsertUser(email, { disabled: true });
    await endSignIns(email);
    await dropUnpermittedVpns(email);
    throw Object.assign(e as Error, { left: true });
  }
}

// At the start, each Entra login is renewed once, so one this server's app can no longer renew, as after the app changed, shows as
// expired, for its person to sign in again, before a run needs it.
export async function checkLogins(entra: { id: string; scope: string[] }[]) {
  for (const email of Object.keys(users())) for (const { id, scope } of entra) if (current(email, id) && !current(email, id)!.expired) await token(email, id, scope).catch(() => {});
}
