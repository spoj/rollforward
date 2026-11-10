import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './store.ts';
import { forgetPerson, isIn, key, readJson, rfDir, writeJson } from './system.ts';
import { forgetLogins, logins, saveLogin, type Offer } from './logins.ts';
import { keepSignIn } from './entra.ts';

// Sign-in with a Microsoft account. People press "Sign in with Microsoft" and type nothing: the button goes to Microsoft Entra ID
// (OpenID Connect, code flow with PKCE), at RF_OIDC_ISSUER, for the app RF_OIDC_CLIENT_ID, which the server needs to start. The server
// redeems the code, with the app's secret if it has one.

// Admins manage people and skills, from rf, and grant users capabilities.
export type Role = 'admin' | 'user';
export const ROLES: Role[] = ['admin', 'user'];
export type User = { name?: string; role: Role; disabled?: boolean; sub?: string; oid?: string; groups?: string[]; epoch?: number; created?: string; last_login?: string };
export type Me = { email: string; name: string; role: Role; groups: string[] };
// Capabilities beyond what every user has, each granted by admins to people and Entra groups: publish, pushing skills, which every
// run loads; create, making workspaces; and keepalive, keeping one's website logins alive (browsers.ts), which loads the website
// every few minutes. Admins have them all.
export const CAPS = ['publish', 'create', 'keepalive'], capabilities = () => readJson<Record<string, string[]>>('capabilities.json', {});
export const can = (me: Me, cap: string) => me.role === 'admin' || isIn(me, capabilities()[cap] ?? []);

const env = process.env;
const oidc = {
  issuer: env.RF_OIDC_ISSUER?.replace(/\/$/, ''), clientId: env.RF_OIDC_CLIENT_ID ?? '', clientSecret: env.RF_OIDC_CLIENT_SECRET ?? '',
  scopes: env.RF_OIDC_SCOPES ?? 'openid profile email', publicUrl: (env.RF_PUBLIC_URL ?? '').replace(/\/$/, ''),
  // Where Microsoft sends people back, exactly as the app registers it. Without a client secret the app is a public client, and the
  // code is redeemed with its PKCE verifier alone.
  redirect: '',
};
oidc.redirect = env.RF_OIDC_REDIRECT_URI ?? `${oidc.publicUrl}/auth/callback`;
const redirectPath = URL.canParse(oidc.redirect) ? new URL(oidc.redirect).pathname : '/auth/callback';
// A person's Microsoft 365 login asks the same app for delegated Graph access: RF_M365_SCOPES, by default reading mail, shared
// mailboxes, files and sites. The server keeps its refresh token.
export const graphScopes = (env.RF_M365_SCOPES ?? 'Mail.Read Mail.Read.Shared Files.Read.All Sites.Read.All').split(/[\s,]+/).filter(Boolean);
// Whether logins ask for a Read permission, or the ReadWrite one that holds it, as a tenant may have granted only that.
const grants = (scope: string) => graphScopes.includes(scope) || graphScopes.includes(scope.replace('.Read', '.ReadWrite'));
// Refuses a request that needs a permission this server's logins don't ask for, saying which.
export function needs(scope: string, what: string) {
  if (!grants(scope)) throw new HttpError(409, `this server's Microsoft 365 logins don't ${what}: RF_M365_SCOPES has no ${scope}`);
}
// The Graph permissions a token answer says Microsoft granted, and those this server asks for that a login's last answer lacked,
// which its person reconnects to grant.
const granted = (scope: string | undefined) => scope?.split(' ').map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '')).filter(s => s && !['openid', 'profile', 'email', 'offline_access'].includes(s.toLowerCase()));
export const ungranted = (login: { scopes?: string[] }) => graphScopes.filter(s => login.scopes && !login.scopes.some(g => g.toLowerCase() === s.toLowerCase()));
// What an Entra login asks for: OpenID's own scopes and its connection's, such as Graph's permissions.
const entraScope = (scope: string[]) => ['openid', 'email', 'offline_access', ...scope].join(' ');
// A connection's Entra login, as connections.ts describes it: its id, kind and name, its scope, and the offers it makes, unless
// they are its person's to add, as Microsoft 365's are.
export type EntraLogin = { id: string; kind: string; name: string; scope: string[]; offers?: Offer[] };
const admins = new Set((env.RF_ADMINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const domains = (env.RF_ALLOWED_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_MS = Number(env.RF_SESSION_HOURS ?? 12) * 3_600_000;
const secure = oidc.publicUrl.startsWith('https:');

export function users(): Record<string, User> {
  return readJson<Record<string, User>>('users.json', {});
}

export function upsertUser(email: string, change: Partial<User>): User {
  const all = users(), id = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(id)) throw new HttpError(400, `not an email address: ${email}`);
  // A new person's epoch is the time, so a cookie from someone of that address removed before is not theirs.
  all[id] = { role: 'user', created: new Date().toISOString(), ...(!all[id] && { epoch: Date.now() }), ...all[id], ...change };
  // Disabling: a new epoch makes every cookie signed for the old one stop working.
  if (change.disabled) all[id].epoch = (all[id].epoch ?? 0) + 1;
  writeJson('users.json', all);
  return all[id];
}

export function removeUser(email: string) {
  const all = users();
  if (!all[email]) throw new HttpError(404, `no user ${email}`);
  delete all[email];
  writeJson('users.json', all);
  forgetPerson(email);
  forgetLogins(email);
  for (const t of myTokens(email)) revokeToken(email, t.id);
}

// Personal tokens, for power users' rf: each acts as its person until it expires, is revoked, or its person is disabled or signed
// out everywhere. .rf/tokens.json keeps only their hashes; .rf/token-uses.jsonl logs every use.
type Token = { id: string; email: string; name: string; created: string; expires: string; epoch: number };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const tokens = () => readJson<Record<string, Token>>('tokens.json', {});

export function newToken(email: string, name: string, days: number): string {
  if (!name || !(days >= 1 && days <= 90)) throw new HttpError(400, 'a token has a name and lasts 1 to 90 days');
  const token = `rft_${randomBytes(24).toString('base64url')}`, all = tokens(), now = Date.now();
  all[digest(token)] = { id: randomBytes(6).toString('hex'), email, name, created: new Date(now).toISOString(), expires: new Date(now + days * 86_400_000).toISOString(), epoch: users()[email].epoch ?? 0 };
  writeJson('tokens.json', all);
  return token;
}

export const myTokens = (email: string) => Object.values(tokens()).filter(t => t.email === email).map(({ id, name, created, expires }) => ({ id, name, created, expires }));

export function revokeToken(email: string, id: string) {
  writeJson('tokens.json', Object.fromEntries(Object.entries(tokens()).filter(([, t]) => t.email !== email || t.id !== id)));
}

// A person as the server knows them now, an admin where RF_ADMINS says so; no one once removed or disabled.
export function asPerson(email: string, u = users()[email]): Me | null {
  return u && !u.disabled ? { email, name: u.name ?? email, role: admins.has(email) ? 'admin' : u.role, groups: u.groups ?? [] } : null;
}

function bearer(req: IncomingMessage, url: URL): Me | null {
  const token = /^Bearer (rft_\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return null;
  const t = tokens()[digest(token)], u = t && users()[t.email];
  if (!u || u.disabled || (u.epoch ?? 0) !== t.epoch || t.expires < new Date().toISOString()) throw new HttpError(401, 'this token has expired or was revoked');
  appendFileSync(join(rfDir(), 'token-uses.jsonl'), JSON.stringify({ at: new Date().toISOString(), token: t.id, email: t.email, method: req.method, path: url.pathname }) + '\n');
  return asPerson(t.email, u);
}

export function signOutEverywhere(email: string) {
  const all = users();
  if (!all[email]) throw new HttpError(404, `no user ${email}`);
  all[email].epoch = (all[email].epoch ?? 0) + 1;
  writeJson('users.json', all);
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString();
const mac = (data: string) => createHmac('sha256', key('session.key')).update(data).digest('base64url');
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
}

function cookie(name: string, value: string, maxAge: number, path = '/') {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function session(req: IncomingMessage): Me | null {
  const [email = '', exp = '', sig = ''] = (cookies(req).rf_session ?? '').split('.');
  const id = unb64(email), u = users()[id];
  if (!u || !(Number(exp) > Date.now()) || !same(sig, mac(`${id} ${exp} ${u.epoch ?? 0}`))) return null;
  return asPerson(id, u);
}

// Lets someone in whom Microsoft has vouched for: records them, with the Entra groups their token names (once the
// app is set to send them), then sets the session cookie. Entra's sub differs for each app, but its tenant and object ids (oid, kept as
// tid/oid) name the person whatever the app, so a record from before them, made through an app since replaced, takes them at its
// next sign-in; another issuer's sub must match.
function admit(res: ServerResponse, email: string, name: string | undefined, who: { sub?: string; oid?: string }, groups: string[], next: string, extra: string[], refresh?: string) {
  const known = users()[email];
  if (!known && env.RF_AUTO_PROVISION === '0' && !admins.has(email)) return page(res, 403, `${email} has no access yet. Ask an admin to add you.`);
  if (known?.disabled) return page(res, 403, `${email} is disabled. Ask an admin.`);
  if (who.oid ? known?.oid && known.oid !== who.oid : known?.sub && who.sub && known.sub !== who.sub) return page(res, 403, `${email} belongs to another Microsoft account.`);
  const u = upsertUser(email, { name: name ?? known?.name, ...(who.sub && { sub: who.sub }), ...(who.oid && { oid: who.oid }), groups, last_login: new Date().toISOString(), ...(admins.has(email) && { role: 'admin' as Role }) });
  if (refresh) keepSignIn(email, refresh);
  const exp = String(Date.now() + SESSION_MS);
  res.writeHead(302, { location: next, 'set-cookie': [cookie('rf_session', `${b64(email)}.${exp}.${mac(`${email} ${exp} ${u.epoch ?? 0}`)}`, SESSION_MS / 1000), ...extra] });
  res.end();
}

const LOGO = '<svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';
const STYLE = `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px; font: 15px/1.5 "IBM Plex Sans", system-ui, sans-serif; color: #15181d; background: #f6f7f8; }
.box { width: min(400px, 100%); padding: 32px 28px; background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; box-shadow: 0 2px 8px rgba(21,24,29,.04); }
.box p { overflow-wrap: anywhere; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; } p { margin: 0 0 22px; color: #474e5b; font-size: 14px; } .bad { color: #b42318; }
.ms { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 11px 12px; font: 600 15px "Segoe UI", "IBM Plex Sans", sans-serif;
  color: #5e5e5e; background: #fff; border: 1px solid #8c8c8c; border-radius: 2px; text-decoration: none; cursor: pointer; }
.ms:hover { background: #f3f3f3; }
</style>`;

function page(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>rollforward</title>${STYLE}
<div class="box"><h1>rollforward</h1><p class="bad">${esc(text)}</p><a class="ms" href="/auth/login">${LOGO}Sign in with Microsoft</a></div>
<script>history.replaceState(null, '', '/')</script>`);
}

function signInPage(res: ServerResponse, next: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in · rollforward</title>${STYLE}
<div class="box"><h1>rollforward</h1><p>Recurring tasks, files in and files out. Sign in with your work account.</p>
<a class="ms" href="/auth/login?next=${encodeURIComponent(next)}">${LOGO}Sign in with Microsoft</a></div>`);
}

// rf login URL, without a token, signs in through the browser, as gh auth login --web does: rf asks for a request, whose code the
// person types on the page (/cli) and allows within 10 minutes, and rf collects the token that makes. Only rf holds the request's
// id, which collects it, and only its terminal shows the code, never a link, so a link someone sends allows nothing.
type Asked = { name: string; code: string; at: number; from: string; token?: string; denied?: boolean };
const asked = new Map<string, Asked>();
const pending = (match: (id: string, a: Asked) => boolean) => [...asked].find(([id, a]) => Date.now() - a.at < 600_000 && match(id, a));

// A body before its sender is known, of 64 KB at most.
async function small(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((size += c.length) > 65_536) throw new HttpError(413, 'over 64 KB');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

// Up to 1,000 requests wait at once, each for 10 minutes.
async function ask(req: IncomingMessage, res: ServerResponse) {
  const { name } = JSON.parse(await small(req) || '{}');
  for (const [id, a] of asked) if (Date.now() - a.at >= 600_000) asked.delete(id);
  if (asked.size >= 1000) throw new HttpError(429, 'too many sign-in requests wait: try again in a few minutes');
  const id = randomBytes(24).toString('base64url'), letters = [...randomBytes(8)].map(b => 'BCDFGHJKLMNPQRSTVWXZ'[b % 20]).join('');
  const from = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').at(-1)!.trim();
  asked.set(id, { name: String(name || 'rf').slice(0, 80), code: `${letters.slice(0, 4)}-${letters.slice(4)}`, at: Date.now(), from });
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, code: asked.get(id)!.code }));
}

async function collect(req: IncomingMessage, res: ServerResponse) {
  const { id } = JSON.parse(await small(req) || '{}'), a = pending(i => i === id)?.[1];
  const [status, text] = !a ? [410, 'the sign-in request expired: run rf login URL again'] : a.denied ? [403, 'denied on the page'] : !a.token ? [202, 'waiting'] : [200, JSON.stringify({ token: a.token })];
  if (status !== 202) asked.delete(id);
  res.writeHead(status, { 'content-type': status === 200 ? 'application/json' : 'text/plain' }).end(text);
}

// The page that allows a request, as the session's own person: a token could make no tokens.
export async function cli(req: IncomingMessage, res: ServerResponse, url: URL) {
  const own = session(req);
  if (!own) throw new HttpError(403, 'tokens are made on the page');
  const form = req.method === 'POST' ? new URLSearchParams(await small(req)) : new URLSearchParams();
  const typed = (form.get('code') ?? '').toUpperCase().replace(/[^A-Z]/g, ''), a = typed && pending((_, a) => a.code.replace('-', '') === typed)?.[1];
  const show = (body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>rf login · rollforward</title>${STYLE}<div class="box"><h1>rollforward</h1>${body}</div>`);
  if (!typed) return show(`<form method="post" action="/cli"><p>Type the code rf shows you.</p><input name="code" required autofocus autocomplete="off" placeholder="ABCD-EFGH" style="width:100%;margin:0 0 14px;padding:10px;font:600 18px monospace;letter-spacing:2px;text-transform:uppercase"><button class="ms">Next</button></form>
<p class="bad" style="margin:16px 0 0">Type only a code rf showed on your own computer. Anyone who asks you to type theirs is asking for your access.</p>`);
  if (!a) return show('<p class="bad">No sign-in request has that code: it expired, was answered, or was mistyped. Run rf login URL again.</p>');
  if (form.get('allow') === 'yes') a.token = newToken(own.email, a.name, 30);
  else if (form.get('allow')) a.denied = true;
  if (form.get('allow')) return show(`<p>${a.token ? `${esc(a.name)} is signed in as you. You can close this tab; the token is under Tokens, where you can revoke it.` : 'Denied. rf is not signed in.'}</p>`);
  show(`<p><b>${esc(a.name)}</b>, asking from ${esc(a.from)} ${Math.round((Date.now() - a.at) / 60_000) || 'under a'} min ago, asks to act as you, ${esc(own.email)}, for 30 days: what you do on this site, from a shell or a desktop agent. Its name is what it says of itself.</p>
<form method="post" action="/cli"><input type="hidden" name="code" value="${esc(a.code)}"><button class="ms" name="allow" value="yes">Allow</button><p></p><button class="ms" name="allow" value="no">Deny</button></form>`);
}

let discovered: { issuer: string; authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string } | undefined;

async function discovery() {
  if (discovered) return discovered;
  const r = await fetch(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new HttpError(502, `Microsoft's sign-in configuration did not load (${r.status})`);
  const d = await r.json();
  // The token comes straight from the token endpoint, so TLS vouches for it (OpenID Connect Core 3.1.3.7); only a local test provider may skip TLS.
  if (!/^https:/.test(d.token_endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(d.token_endpoint)) throw new HttpError(502, 'the token endpoint must use https');
  return (discovered = d);
}

// Each sign-in keeps its state in a cookie of its own, named by the state, so sign-ins started in several tabs don't overwrite each other.
const pendingCookie = (state: string) => `rf_oidc_${state}`;

// Sends the browser to Microsoft to sign in, or, with `connect`, for that signed-in person to give a login of theirs.
async function microsoft(res: ServerResponse, next: string, connect?: { login: EntraLogin; email: string }) {
  const d = await discovery();
  const state = randomBytes(16).toString('base64url'), nonce = randomBytes(16).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const pending = b64(JSON.stringify({ state, nonce, verifier, next, exp: Date.now() + 600_000, ...connect }));
  const to = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: oidc.clientId, redirect_uri: oidc.redirect, scope: connect ? entraScope(connect.login.scope) : `${oidc.scopes} offline_access`, state, nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(connect ? { login_hint: connect.email } : { prompt: 'select_account' }),
  })) to.searchParams.set(k, v);
  res.writeHead(302, { location: to.href, 'set-cookie': cookie(pendingCookie(state), `${pending}.${mac(pending)}`, 600) });
  res.end();
}

type Pending = { state: string; nonce: string; verifier: string; next: string; exp: number; login?: EntraLogin; email?: string };

// The sign-in this browser started under `state`, if it is still good.
function pendingOf(req: IncomingMessage, state: string): Pending | undefined {
  const [pending = '', sig = ''] = (/^[\w-]+$/.test(state) ? cookies(req)[pendingCookie(state)] ?? '' : '').split('.');
  const p = pending && same(sig, mac(pending)) ? JSON.parse(unb64(pending)) : undefined;
  return p && p.exp > Date.now() && p.state === state ? p : undefined;
}

function expired(req: IncomingMessage, res: ServerResponse) {
  // Already signed in, as after going back to this address or finishing in another tab: carry on rather than complain.
  if (session(req)) return void res.writeHead(302, { location: '/' }).end();
  page(res, 400, 'The sign-in took too long or came from another browser. Try again.');
}

// Checks an ID token's claims against this sign-in, then lets its person in, keeping the sign-in itself, which each of their runs
// renews first (entra.ts).
async function finishSignIn(res: ServerResponse, claims: any, p: Pending, refresh?: string) {
  const d = await discovery(), aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== d.issuer || !aud.includes(oidc.clientId) || !(claims.exp * 1000 > Date.now()) || claims.nonce !== p.nonce) return page(res, 401, 'The sign-in token did not check out.');
  const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').toLowerCase();
  if (!email.includes('@')) return page(res, 403, 'Your account has no email address.');
  if (domains.length && !domains.includes(email.split('@')[1])) return page(res, 403, `${email} is not in an allowed domain.`);
  admit(res, email, claims.name, { sub: claims.sub, ...(claims.oid && { oid: `${claims.tid}/${claims.oid}` }) }, Array.isArray(claims.groups) ? claims.groups.map(String) : [], p.next, [cookie(pendingCookie(p.state), '', 0)], refresh);
}

async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const p = pendingOf(req, url.searchParams.get('state') ?? '');
  if (!p) return expired(req, res);
  if (url.searchParams.get('error')) return page(res, 401, `Microsoft refused: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`);
  const d = await discovery();
  const r = await fetch(d.token_endpoint, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: oidc.redirect, client_id: oidc.clientId, code_verifier: p.verifier,
      ...(oidc.clientSecret && { client_secret: oidc.clientSecret }),
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.id_token) return page(res, 401, `Microsoft did not sign you in: ${t.error_description ?? t.error ?? r.status}`);
  // Straight from the token endpoint over TLS, so the token's signature needn't be checked (OpenID Connect Core 3.1.3.7).
  const claims = JSON.parse(unb64(t.id_token.split('.')[1]));
  if (p.login) return finishLogin(req, res, claims, t, p);
  await finishSignIn(res, claims, p, t.refresh_token);
}

export async function connect(res: ServerResponse, email: string, login: EntraLogin) {
  await microsoft(res, '/#logins', { login, email });
}

// Keeps the login of the person who asked for it, with the offers its connection makes, or, for Microsoft 365, nothing until they
// add it, and on signing in again what they had added.
async function finishLogin(req: IncomingMessage, res: ServerResponse, claims: any, t: { refresh_token?: string; scope?: string }, p: Pending) {
  const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').toLowerCase(), { id, kind, name, offers } = p.login!;
  if (session(req)?.email !== p.email) return page(res, 401, `Sign in to rollforward first, then connect ${name}.`);
  if (email !== p.email) return page(res, 403, `That was ${email}'s Microsoft account; connect your own, ${p.email}.`);
  if (!t.refresh_token) return page(res, 502, 'Microsoft gave no refresh token, so the login could not be kept: the app needs offline_access.');
  const scopes = id === 'm365' && granted(t.scope);
  saveLogin(email, { id, kind, name, account: email, since: new Date().toISOString(), offers: offers ?? logins(email).find(l => l.id === id)?.offers ?? [], ...(scopes && { scopes }) }, t.refresh_token);
  res.writeHead(302, { location: p.next, 'set-cookie': cookie(pendingCookie(p.state), '', 0) }).end();
}

// Fresh access and ID tokens for a person's login, and the refresh token that replaces theirs. Microsoft refusing the login answers 401,
// as for one expired, revoked or made through another app, for its person to sign in again. A refusal that names this server's own
// app, as when its secret expired, is the server's to mend, and answers 502, as other failures do; one that wants the person's
// consent to permissions the server asks for anew carries `consent`.
export async function renew(refreshToken: string, scope: string[]): Promise<{ access: string; idToken: string; refresh: string; expires: number; scopes?: string[] }> {
  const d = await discovery();
  const r = await fetch(d.token_endpoint, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: oidc.clientId, scope: entraScope(scope), ...(oidc.clientSecret && { client_secret: oidc.clientSecret }) }),
  });
  const t = await r.json().catch(() => ({}));
  const refused = ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(t.error) && !String(t.error_description).includes(`'${oidc.clientId}'`);
  if (!r.ok || !t.access_token) throw Object.assign(new HttpError(refused ? 401 : 502, `Microsoft did not renew the login: ${(t.error_description ?? t.error ?? r.status).toString().split('\r\n')[0]}`), { consent: t.suberror === 'consent_required' });
  return { access: t.access_token, idToken: t.id_token, refresh: t.refresh_token ?? refreshToken, expires: Date.now() + (Number(t.expires_in ?? 3600) - 120) * 1000, scopes: granted(t.scope) };
}

// Where a sign-in goes once done: a path on this site, as a browser reads it, which takes \ for / and drops tabs and line breaks.
const nextOf = (url: URL | URLSearchParams) => {
  const n = (url instanceof URL ? url.searchParams : url).get('next') ?? '/';
  return n.startsWith('/') && new URL(n, 'http://x').host === 'x' ? n : '/';
};

// Who is asking. Answers the sign-in routes itself, and shows the sign-in page to anyone not signed in, then returns null.
export async function authenticate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<Me | null> {
  if (url.pathname === '/auth/login') await microsoft(res, nextOf(url));
  else if (url.pathname === redirectPath && url.searchParams.has('state') && (url.searchParams.has('code') || url.searchParams.has('error'))) {
    // Microsoft's return, which may be the site's own root if that is what the app registers.
    await callback(req, res, url);
  } else if (url.pathname === '/auth/cli' && req.method === 'POST') await ask(req, res);
  else if (url.pathname === '/auth/cli/poll' && req.method === 'POST') await collect(req, res);
  else if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const end = (await discovery().catch(() => undefined))?.end_session_endpoint;
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie('rf_session', '', 0) });
    res.end(JSON.stringify({ next: end ? `${end}?post_logout_redirect_uri=${encodeURIComponent(oidc.publicUrl + '/')}` : '/' }));
  } else {
    const me = bearer(req, url) ?? session(req);
    if (me) return me;
    if (!['/', '/cli'].includes(url.pathname) || req.method !== 'GET') throw new HttpError(401, 'sign in first');
    signInPage(res, url.pathname + url.search);
  }
  return null;
}

export function checkConfig() {
  if (![undefined, '0', '1'].includes(env.RF_AUTO_PROVISION)) throw new Error(`RF_AUTO_PROVISION is 0 or 1, not ${JSON.stringify(env.RF_AUTO_PROVISION)}`);
  if (!oidc.issuer || !oidc.clientId || !oidc.publicUrl || !URL.canParse(oidc.redirect)) throw new Error('sign-in needs an app registered in Microsoft Entra ID: RF_OIDC_ISSUER, RF_OIDC_CLIENT_ID and RF_PUBLIC_URL (and RF_OIDC_CLIENT_SECRET unless the app is a public client)');
}
