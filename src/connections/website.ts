import { HttpError } from '../store.ts';
import { isPeople } from '../system.ts';
import type { Type } from '../connections.ts';

// A website people sign in to themselves, in a live browser on the page: `url`, where sign-in starts, `hosts`, the others its pages
// need, such as single sign-on's, and `title`, its name as people see it. A run's browser on it reaches only those hosts (browsers.ts).
// `writeback`, true unless set false, says whether a run's browser writes its state back to its person's login. `header` names a
// header its sign-in needs that its pages never send, such as Retail Link's x-bot-token, whose value each person gives as they sign in.
// `keepalive`, a page of it by address or path, else `url`, is what the logins its people keep alive load, every `every` minutes, 10
// unless given (browsers.ts).
// `people`, emails and Entra group ids, are the only ones who may use it, if given. `owner` is the person whose own site it is, who
// added it under the capability sites; `off`, an admin's, takes it from everyone.
export default {
  settings(input) {
    if (typeof input.url !== 'string' || !/^https?:\/\/[^/]/.test(input.url)) throw new HttpError(400, 'url: an http(s) address, where sign-in starts');
    const hosts = typeof input.hosts === 'string' ? input.hosts.split(',').map(h => h.trim()).filter(Boolean) : input.hosts ?? [];
    if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(h))) throw new HttpError(400, 'hosts: names such as sso.example.com, or *.example.com for any under it');
    if (![undefined, true, false, 'true', 'false'].includes(input.writeback as never)) throw new HttpError(400, 'writeback: true or false');
    if (input.header !== undefined && !/^[a-z0-9-]+$/i.test(String(input.header))) throw new HttpError(400, 'header: the name of a header its sign-in needs, such as x-bot-token');
    const people = typeof input.people === 'string' ? input.people.split(',').map(p => p.trim()).filter(Boolean) : input.people;
    if (people !== undefined && !(isPeople(people) && people.length))
      throw new HttpError(400, 'people: who alone may use it, emails and Entra group ids, such as ann@example.com,<group id>');
    const every = /^(\d+)([mh])$/.exec(String(input.every ?? ''));
    if (input.keepalive !== undefined && URL.parse(String(input.keepalive), input.url)?.host !== new URL(input.url).host) throw new HttpError(400, 'keepalive: a page of the website, by its address or path, such as https://patriarch.patrina.net/PatriArchMVC/');
    if (input.every !== undefined && !(every && Number(every[1]) > 0)) throw new HttpError(400, 'every: minutes or hours, such as 10m or 1h');
    return { url: input.url, hosts, ...(typeof input.title === 'string' && input.title.trim() && { title: input.title.trim() }), writeback: input.writeback !== false && input.writeback !== 'false', ...(input.header !== undefined && { header: String(input.header) }),
      ...(input.keepalive !== undefined && { keepalive: String(input.keepalive) }), ...(every && { every: Number(every[1]) * (every[2] === 'h' ? 60 : 1) }),
      ...(people && { people: people.map(p => p.toLowerCase()) }), ...(typeof input.owner === 'string' && { owner: input.owner.toLowerCase() }),
      ...((input.off === true || input.off === 'true') && { off: true }) };
  },
  login: c => ({ id: `web:${c.name}`, kind: 'website', name: c.title ?? c.name, offers: [{ id: `web:${c.name}`, name: c.title ?? c.name }] }),
} satisfies Type;
