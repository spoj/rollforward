import { HttpError } from '../store.ts';
import type { Type } from '../connections.ts';

// A website people sign in to themselves, in a live browser on the page: `url`, where sign-in starts, `hosts`, the others its pages
// need, such as single sign-on's, and `title`, its name as people see it. A run's browser on it reaches only those hosts (browsers.ts).
// `writeback`, true unless set false, says whether a run's browser writes its state back to its person's login. `header` names a
// header its sign-in needs that its pages never send, such as Retail Link's x-bot-token, whose value each person gives as they sign in.
// `keepalive`, a page of it, and `every`, in minutes, keep idle logins alive (browsers.ts), in `hours` on weekdays if given.
export default {
  settings(input) {
    if (typeof input.url !== 'string' || !/^https?:\/\/[^/]/.test(input.url)) throw new HttpError(400, 'url: an http(s) address, where sign-in starts');
    const hosts = typeof input.hosts === 'string' ? input.hosts.split(',').map(h => h.trim()).filter(Boolean) : input.hosts ?? [];
    if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(h))) throw new HttpError(400, 'hosts: names such as sso.example.com, or *.example.com for any under it');
    if (![undefined, true, false, 'true', 'false'].includes(input.writeback as never)) throw new HttpError(400, 'writeback: true or false');
    if (input.header !== undefined && !/^[a-z0-9-]+$/i.test(String(input.header))) throw new HttpError(400, 'header: the name of a header its sign-in needs, such as x-bot-token');
    const every = /^(\d+)([mh])$/.exec(String(input.every ?? ''));
    if ((input.keepalive === undefined) !== (input.every === undefined) || (input.hours !== undefined && input.keepalive === undefined)) throw new HttpError(400, 'keepalive and every go together, and hours with them: a page of the website to load, such as /app/, how often, such as 10m, and office hours, such as 08:00-19:00');
    if (input.keepalive !== undefined && !/^\/\S*$/.test(String(input.keepalive))) throw new HttpError(400, 'keepalive: a page of the website, by its path, such as /app/');
    if (input.every !== undefined && !(every && Number(every[1]) > 0)) throw new HttpError(400, 'every: minutes or hours, such as 10m or 1h');
    if (input.hours !== undefined && !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(String(input.hours))) throw new HttpError(400, "hours: from and to, such as 08:00-19:00, on weekdays in the server's time zone");
    return { url: input.url, hosts, ...(typeof input.title === 'string' && input.title.trim() && { title: input.title.trim() }), writeback: input.writeback !== false && input.writeback !== 'false', ...(input.header !== undefined && { header: String(input.header) }),
      ...(every && { keepalive: String(input.keepalive), every: Number(every[1]) * (every[2] === 'h' ? 60 : 1) }), ...(input.hours !== undefined && { hours: String(input.hours) }) };
  },
  login: c => ({ id: `web:${c.name}`, kind: 'website', name: c.title ?? c.name, offers: [{ id: `web:${c.name}`, name: c.title ?? c.name }] }),
} satisfies Type;
