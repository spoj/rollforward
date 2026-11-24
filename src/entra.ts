import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './store.ts';
import { changes } from './system.ts';
import { renew, upsertUser, users } from './auth.ts';
import { loginGeneration, logins, personDir, saveLogin, seal, secret } from './logins.ts';

// A person's Entra logins, each a connection's (connections.ts), such as Microsoft 365's: each access token comes from the login's
// sealed refresh token, which turns over as it's used and is sealed again. A login Microsoft no longer renews is marked expired,
// for its person to sign in again on the Logins page.

const tokens = new Map<string, { token: string; exp: number; generation: string }>();
const inFlight = new Map<string, { run: Promise<string>; waiters: Set<{ checkpoint?: () => void }> }>();

// The login as it is now: its person may change its offers, or sign out, while Microsoft answers.
const current = (email: string, id: string) => logins(email).find(l => l.id === id);

// A token for `scope`, kept until it expires, or its login is signed in to again, as to grant more, or signed out of.
export function token(email: string, id: string, scope: string[], checkpoint?: () => void): Promise<string> {
  checkpoint?.();
  const key = `${id} ${email}`, t = tokens.get(key), login = current(email, id);
  if (!login || login.expired) return Promise.reject(Object.assign(new HttpError(409, `${email} has no current ${login?.name ?? id} login: they sign in to it on the Logins page`), { login: id, since: loginGeneration(login) ?? '' }));
  const generation = loginGeneration(login)!;
  if (t && t.exp > Date.now() && t.generation === generation) return Promise.resolve(t.token);
  const inflightKey = `${key}\0${generation}\0${scope.join(' ')}`;
  let pending = inFlight.get(inflightKey);
  const waiter = { checkpoint }, waiters = pending?.waiters ?? new Set<{ checkpoint?: () => void }>();
  waiters.add(waiter);
  if (!pending) {
    const authorized = () => {
      for (const w of waiters) {
        try { w.checkpoint?.(); return; }
        catch (e) { if (!(e instanceof HttpError)) throw e; }
      }
      // Never pass a caller's 401 into the shared provider-expiry handling.
      throw new HttpError(409, 'no authorized caller waiting for login renewal');
    };
    const run = (async () => {
      try {
        // Until its person consents to what the server asks for anew, a Microsoft 365 login renews with what Microsoft last granted it.
        const sealed = secret(email, id), r = await renew(sealed, scope, authorized).catch(e => e.consent && login.scopes ? renew(sealed, login.scopes.map(s => `https://graph.microsoft.com/${s}`), authorized) : Promise.reject(e));
        const now = current(email, id);
        if (now && loginGeneration(now) === generation) {
          saveLogin(email, { ...now, ...(id === 'm365' && r.scopes && { scopes: r.scopes }) }, r.refresh);
          tokens.set(key, { token: r.access, exp: r.expires, generation });
        }
        return r.access;
      } catch (e) {
        if ((e as HttpError).status !== 401) throw e;
        const now = current(email, id);
        if (now && loginGeneration(now) === generation) {
          tokens.delete(key);
          saveLogin(email, { ...now, expired: true });
        }
        throw Object.assign(new HttpError(409, `${email}'s ${login.name} login has expired: they sign in to it again on the Logins page`), { login: id, since: loginGeneration(now) ?? generation ?? '' });
      }
    })().finally(() => inFlight.delete(inflightKey));
    inFlight.set(inflightKey, pending = { run, waiters });
  }
  return pending.run.finally(() => { waiters.delete(waiter); checkpoint?.(); });
}

// A person's sign-in to rollforward, kept as its refresh token, which signing in again replaces, waking what waited for it (waker.ts).
// Count interactive sign-ins even when Microsoft gives the same refresh token, or no new one.
const signInGenerations = new Map<string, number>();
export function keepSignIn(email: string, refresh?: string) {
  signInGenerations.set(email, (signInGenerations.get(email) ?? 0) + 1);
  if (!refresh) return;
  mkdirSync(personDir(email), { recursive: true, mode: 0o700 });
  seal(email, 'entra', refresh);
  changes.emit('login', email, 'entra', 'rollforward');
}

// Whether Microsoft still signs the person in, as each run of theirs asks before it starts: their sign-in renews, its refresh token
// turning over as it does, and their groups replaced by those its ID token names. Without one kept, or Microsoft refusing it, it answers 401, as for one expired or revoked, for its person to sign in again; one disabled here, or that Microsoft says is disabled or gone
// (AADSTS50057, AADSTS50034), carries `left`, and is disabled here too. Other failures, as when Microsoft can't be reached, throw
// as they come.
export async function confirm(email: string, checkpoint?: () => void, signal?: AbortSignal) {
  const fenced = !!(checkpoint || signal), generation = signInGenerations.get(email);
  const check = () => {
    signal?.throwIfAborted();
    checkpoint?.();
    if (fenced && signInGenerations.get(email) !== generation) throw new HttpError(409, `${email} signed in again while Microsoft confirmed their sign-in`);
  };
  check();
  if (users()[email]?.disabled) throw Object.assign(new HttpError(401, `${email} is disabled here`), { left: true });
  if (!existsSync(join(personDir(email), 'entra.sealed'))) throw new HttpError(401, `${email} hasn't signed in to rollforward since sign-ins are kept`);
  const { dropUnpermittedVpns } = await import('./vpns.ts');
  check();
  const { endSignIns, endUnpermittedSignIns } = await import('./browsers.ts');
  check();
  let applied = false;
  try {
    const r = await renew(secret(email, 'entra'), [], fenced ? check : undefined, signal).catch((error: unknown) => ({ error }));
    check();
    const departed = 'error' in r;
    if (departed) {
      if (!(r.error instanceof HttpError) || !/AADSTS(50057|50034)\b/.test(r.error.message)) throw r.error;
      upsertUser(email, { disabled: true });
    } else {
      const claims = JSON.parse(Buffer.from(r.idToken.split('.')[1], 'base64url').toString());
      seal(email, 'entra', r.refresh);
      upsertUser(email, { groups: Array.isArray(claims.groups) ? claims.groups.map(String) : [] });
    }
    applied = true;
    // The write can itself invalidate the check. Reconcile live permissions, not the wake's old authority.
    const only = departed && !fenced ? email : undefined;
    if (only) await endSignIns(only);
    else await endUnpermittedSignIns();
    await dropUnpermittedVpns(only);
    if (departed) throw Object.assign(r.error, { left: true });
  } finally {
    if (applied || !fenced) {
      try {
        const { active } = await import('./waker.ts');
        await Promise.all([...active.values()].map(a => a.browsers?.closeUnlent()));
      } finally {
        check();
      }
    }
  }
}

// At the start, each Entra login is renewed once, so one this server's app can no longer renew, as after the app changed, shows as
// expired, for its person to sign in again, before a run needs it.
export async function checkLogins(entra: { id: string; scope: string[] }[]) {
  for (const email of Object.keys(users())) for (const { id, scope } of entra) if (current(email, id) && !current(email, id)!.expired) await token(email, id, scope).catch(() => {});
}
