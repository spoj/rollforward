import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './store.ts';
import { key, readJson, writeJson } from './system.ts';

// The shared connections, kept by admins under Systems: the Microsoft 365 apps registered in Entra ID, whose client secrets let the
// server read OneDrive files or a mailbox through Microsoft Graph (see m365.ts). Series don't choose them: the skills a series
// chooses say which they use (skills.ts). A skill with a website of its own keeps that site's account in its own settings, and
// siteOf (skills.ts) turns them into a System of kind web for the browser: the server types the password itself, so it never
// reaches the agent, and `writes` says which requests count as writes ("POST */save*", or a bare URL pattern for any method;
// with none, every request but GET, HEAD and OPTIONS does).
// Company values (ids, mailboxes) live in the data root's .rf/systems.json, set from the Systems page, never in this code.

export type Kind = 'web' | 'm365';
// `secret`: sealed when saved, and never shown again, only whether one is saved.
export type Field = { key: string; label: string; hint?: string; optional?: boolean; secret?: boolean };
export type System = {
  id: string; name: string; kind?: Kind; url?: string; username?: string; password?: string;
  tenant?: string; client_id?: string; settings?: Record<string, string>;
  login?: { user?: string; pass?: string; submit?: string }; writes: string[]; extra_origins: string[];
  updated_by?: string; updated_at?: string;
};
type BuiltIn = { id: string; name: string; kind: Kind; fields?: Field[] };

export const BUILT_IN: BuiltIn[] = [
  { id: 'm365-mail', name: 'M365 Mail', kind: 'm365', fields: [{ key: 'mailbox', label: 'Mailbox', hint: 'The one mailbox this app reads, such as a shared inbox or a person\'s' }] },
  { id: 'm365-files', name: 'M365 OneDrive', kind: 'm365', fields: [{ key: 'test_link', label: 'Test link', hint: 'A OneDrive or SharePoint folder link that Test reads', optional: true }] },
];

export const builtIn = (id: string) => BUILT_IN.find(b => b.id === id);
export const kindOf = (s: { id: string; kind?: Kind }): Kind => s.kind ?? builtIn(s.id)?.kind ?? 'web';

// The connections saved, set up or not.
export function systems(): System[] {
  return readJson<System[]>('systems.json', []).filter(s => builtIn(s.id));
}

// A connection as saved, ready or not.
export function savedSystem(id: string): System | undefined {
  const k = id.toLowerCase();
  return systems().find(s => s.id === k || s.name.toLowerCase() === k);
}

// What a connection (or a skill's site) still needs before it can be used; empty when it's ready.
export function missing(s: System | undefined, id = s?.id ?? ''): string[] {
  const b = builtIn(id), kind = s ? kindOf(s) : b?.kind ?? 'web', need: string[] = [];
  if (!s) return ['not set up'];
  if (kind === 'web') {
    if (!s.url) need.push('address');
    if (!s.username) need.push('account');
    if (!s.password) need.push('password');
  }
  if (kind === 'm365') {
    if (!s.tenant) need.push('tenant id');
    if (!s.client_id) need.push('client id');
    if (!s.password) need.push('client secret');
  }
  for (const f of b?.fields ?? []) if (!f.optional && !s.settings?.[f.key]) need.push(f.label.toLowerCase());
  return need;
}

// A connection ready to use, or undefined.
export function system(id: string): System | undefined {
  const s = savedSystem(id);
  return s && !missing(s).length ? s : undefined;
}

// What the Systems page shows: each connection with its fields and what it still needs; never a secret.
export function catalog() {
  const set = systems();
  return BUILT_IN.map(b => ({ b, s: set.find(s => s.id === b.id) }))
    .map(({ b, s }) => ({ ...(s ? view(s) : {}), id: b.id, name: b.name, kind: b.kind, built_in: true, fields: b.fields ?? [], saved: !!s, configured: !missing(s, b.id).length, missing: missing(s, b.id) }));
}

export function view(s: System) {
  const { password, ...rest } = s;
  return { ...rest, has_password: !!password };
}

export function seal(text: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key('systems.key'), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}

export function unseal(sealed: string | undefined): string {
  if (!sealed) return '';
  const [iv, tag, data] = sealed.split('.').map(p => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key('systems.key'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// The password, or for an m365 connection the client secret.
export const password = (s: System): string => unseal(s.password);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Saves a connection. It can be saved in part, such as its ids before its secret, and is ready once nothing is missing.
export function saveSystem(id: string, input: Record<string, any>, by: string): System {
  const b = builtIn(id);
  if (!b) throw new HttpError(404, `no connection ${id}`);
  const list = systems(), old = list.find(s => s.id === id), errors: string[] = [];
  const tenant = String(input.tenant ?? '').trim(), client_id = String(input.client_id ?? '').trim();
  if (tenant && !GUID.test(tenant)) errors.push('tenant id: the directory (tenant) id, a GUID');
  if (client_id && !GUID.test(client_id)) errors.push('client id: the application (client) id, a GUID');
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  const settings: Record<string, string> = {};
  for (const f of b.fields ?? []) {
    const v = String(input.settings?.[f.key] ?? '').trim();
    if (v) settings[f.key] = v;
  }
  const s: System = {
    id, name: b.name, ...(tenant && { tenant }), ...(client_id && { client_id }),
    password: input.password ? seal(String(input.password)) : old?.password, ...(Object.keys(settings).length && { settings }),
    writes: [], extra_origins: [], updated_by: by, updated_at: new Date().toISOString(),
  };
  writeJson('systems.json', old ? list.map(x => (x.id === id ? s : x)) : [...list, s]);
  return s;
}

export function removeSystem(id: string) {
  const list = systems();
  if (!list.some(s => s.id === id)) throw new HttpError(404, `no connection ${id}`);
  writeJson('systems.json', list.filter(s => s.id !== id));
}

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

// Whether a request matches one of `patterns`: "POST */save*", or a bare URL pattern for any method.
export function matches(patterns: string[], method: string, url: string): boolean {
  return patterns.some(w => {
    const [m, p] = /^[A-Z]+\s+\S/.test(w) ? w.split(/\s+/, 2) : ['*', w];
    return (m === '*' || m === method) && glob(p).test(url);
  });
}

export function isWrite(s: System, method: string, url: string): boolean {
  if (!s.writes.length) return !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return matches(s.writes, method, url);
}
