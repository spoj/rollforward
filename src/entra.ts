import { HttpError } from './store.ts';
import { renew, users } from './auth.ts';
import { logins, saveLogin, secret } from './logins.ts';

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

// At the start, each Entra login is renewed once, so one this server's app can no longer renew, as after the app changed, shows as
// expired, for its person to sign in again, before a run needs it.
export async function checkLogins(entra: { id: string; scope: string[] }[]) {
  for (const email of Object.keys(users())) for (const { id, scope } of entra) if (current(email, id) && !current(email, id)!.expired) await token(email, id, scope).catch(() => {});
}
