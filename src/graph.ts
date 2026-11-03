import { HttpError } from './store.ts';
import { refreshM365, users } from './auth.ts';
import { logins, saveLogin, secret } from './logins.ts';

// Microsoft Graph as a person, through their delegated Microsoft 365 login (logins.ts): each access token comes from the
// login's sealed refresh token, which turns over as it's used and is sealed again. A login Microsoft no longer renews is marked
// expired, for its person to sign in again on the Logins page.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const tokens = new Map<string, { token: string; exp: number }>();
// Tests point this at a stand-in.
export const endpoints = { graph: GRAPH };

// The login as it is now: its person may change its offers, or sign out, while Microsoft answers.
const current = (email: string) => logins(email).find(l => l.id === 'm365');

export async function token(email: string): Promise<string> {
  const t = tokens.get(email);
  if (t && t.exp > Date.now()) return t.token;
  const login = current(email);
  if (!login || login.expired) throw Object.assign(new HttpError(409, `${email} has no current Microsoft 365 login: they sign in to it on the Logins page`), { login: 'm365' });
  try {
    const r = await refreshM365(secret(email, 'm365')), now = current(email);
    if (now) saveLogin(email, now, r.refresh);
    tokens.set(email, { token: r.access, exp: r.expires });
    return r.access;
  } catch (e) {
    if ((e as HttpError).status !== 401) throw e;
    const now = current(email);
    if (now) saveLogin(email, { ...now, expired: true });
    throw Object.assign(new HttpError(409, `${email}'s Microsoft 365 login has expired: they sign in to it again on the Logins page`), { login: 'm365' });
  }
}

// At the start, each Microsoft 365 login is renewed once, so one this server's app can no longer renew, as after the app or its
// secret changed, shows as expired, for its person to sign in again, before a run needs it.
export async function checkLogins() {
  for (const email of Object.keys(users())) if (current(email) && !current(email)!.expired) await token(email).catch(() => {});
}

// A GET, answered as Graph answers it. Only ever a GET: nothing here can change or delete a file or a message.
export async function get(email: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; bytes: Buffer }> {
  const r = await fetch(endpoints.graph + path, { method: 'GET', headers: { ...headers, authorization: `Bearer ${await token(email)}` }, signal: AbortSignal.timeout(120_000) });
  return { status: r.status, type: r.headers.get('content-type') ?? '', bytes: Buffer.from(await r.arrayBuffer()) };
}

// A GET's JSON; an error names what Microsoft said, such as no access to a mailbox.
export async function graph(email: string, path: string): Promise<any> {
  const r = await get(email, path), j = r.type.includes('json') ? JSON.parse(r.bytes.toString()) : {};
  if (r.status >= 300) throw new HttpError(r.status === 404 || r.status === 403 ? r.status : 502, `Microsoft Graph answered ${r.status} ${j.error?.code ?? ''}: ${j.error?.message ?? ''}`);
  return j;
}
