import { HttpError } from '../store.ts';
import type { Type } from '../connections.ts';

export default {
  settings: input => {
    const url = URL.parse(String(input.url)), paths = String(input.paths ?? '').split(',').map(p => p.trim());
    if (!url || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'url: an http address, with no credentials, query or fragment');
    if (paths.some(p => !p.endsWith('/') || p.startsWith('/') || /[%\\?#\x00-\x1f\x7f]/.test(p) || p.slice(0, -1).split('/').some(s => !s || s === '.' || s === '..')))
      throw new HttpError(400, 'paths: comma-separated relative prefixes ending in /, such as AP/,GL/2026/, with no empty, . or .. part or encoding');
    if (input.key !== undefined && (typeof input.key !== 'string' || !input.key || /[^\x21-\x7e]/.test(input.key))) throw new HttpError(400, 'key: a nonempty bearer key with no whitespace');
    return { url: url.href.replace(/\/$/, ''), paths: [...new Set(paths)] };
  },
  login: c => ({ id: c.name, kind: 'service', name: `Service ${c.name}`, offers: c.paths.map((p: string) => ({ id: `${c.name}:${p}`, name: `${p} at https://${c.name}.rf.internal/` })) }),
  hosts: c => [`${c.name}.rf.internal`],
  check: async (c, _runner, ticks, r) => {
    const prefixes = c.paths.filter((p: string) => ticks.includes(`${c.name}:${p}`)), target = r.target!.split('?')[0];
    const refuse = (why: string) => new HttpError(403, `${why}; ${c.name}'s ticked prefixes: ${prefixes.join(', ') || 'none'}`);
    let path: string;
    try { path = decodeURIComponent(target); } catch { throw refuse('invalid path encoding'); }
    if (!target.startsWith('/') || target.startsWith('//') || /[%\\?#\x00-\x1f\x7f]/.test(path) || path.slice(1).split('/').some((s, i, parts) => /^[. ]+(;|$)/.test(s) || (!s && i < parts.length - 1)) || /%2f/i.test(target))
      throw refuse('a path has no empty part, no part of dots and spaces alone or before ;, as .. or ..;, no encoded separator, backslash or nested encoding');
    const prefix = prefixes.find((p: string) => path.startsWith(`/${p}`));
    if (!prefix) throw refuse(`${path} is under no prefix ticked for this instance`);
    return { offer: `${c.name}:${prefix}` };
  },
} satisfies Type;
