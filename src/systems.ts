import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { key } from './system.ts';

// A website as the browser takes it (browser.ts): a skill's site (skills.ts siteOf), its account and sealed password from the
// skill's settings. The server types the password itself, so it never reaches the agent, and `writes` says which requests count as
// writes ("POST */save*", or a bare URL pattern for any method; with none, every request but GET, HEAD and OPTIONS does).

// `secret`: sealed when saved, and never shown again, only whether one is saved.
export type Field = { key: string; label: string; hint?: string; optional?: boolean; secret?: boolean };
export type System = {
  id: string; name: string; url?: string; username?: string; password?: string; settings?: Record<string, string>;
  login?: { user?: string; pass?: string; submit?: string }; writes: string[]; extra_origins: string[];
  updated_by?: string; updated_at?: string;
};

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

export const password = (s: System): string => unseal(s.password);

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
