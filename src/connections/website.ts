import { HttpError } from '../store.ts';
import type { Type } from '../connections.ts';

// A website people sign in to themselves, in a live browser on the page: `url`, where sign-in starts, `hosts`, the others its pages
// need, such as single sign-on's, and `title`, its name as people see it. A run's browser on it reaches only those hosts (browsers.ts).
// `writeback`, true unless set false, says whether a run's browser writes its state back to its person's login.
export default {
  settings(input) {
    if (typeof input.url !== 'string' || !/^https?:\/\/[^/]/.test(input.url)) throw new HttpError(400, 'url: an http(s) address, where sign-in starts');
    const hosts = typeof input.hosts === 'string' ? input.hosts.split(',').map(h => h.trim()).filter(Boolean) : input.hosts ?? [];
    if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(h))) throw new HttpError(400, 'hosts: names such as sso.example.com, or *.example.com for any under it');
    if (![undefined, true, false, 'true', 'false'].includes(input.writeback as never)) throw new HttpError(400, 'writeback: true or false');
    return { url: input.url, hosts, ...(typeof input.title === 'string' && input.title.trim() && { title: input.title.trim() }), writeback: input.writeback !== false && input.writeback !== 'false' };
  },
  login: c => ({ id: `web:${c.name}`, kind: 'website', name: c.title ?? c.name, offers: [{ id: `web:${c.name}`, name: c.title ?? c.name }] }),
  help: c => `the website ${c.url}, in a browser signed in as your runner (rf browser open ${c.name}), reaching ${[new URL(c.url).hostname, ...c.hosts].join(', ')}.`,
} satisfies Type;
