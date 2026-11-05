import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, instances, newId, seriesDir } from './store.ts';
import { canManage, canSee, readJson, rfDir, tree, writeJson } from './system.ts';
import { users, type Me } from './auth.ts';
import { logins, runnerOf, signOut, type Trace } from './logins.ts';
import { seriesSettings } from './series.ts';
import { changeConnection, checkHost, connections, upstreams } from './connections.ts';
import { model } from './connections/openrouter.ts';
import { websites } from './browsers.ts';

// Grants, in .rf/grants.json: a person's use of their login to a website in one workspace, (workspace, person, site). The person
// asks, with a reason, once they've signed in to it; one of the workspace's owners, or an admin, approves or denies it, and may
// revoke it at any time, as the person may withdraw it. A run's browser on a website opens only from its runner's login, and only
// where their grant in the instance's workspace is approved (browsers.ts). A request lapses a week after it was asked; a login to a
// website no approved grant uses is signed out a week after its sign-in; and once a person has nothing pending or approved for a
// website, as after a denial or a revocation, they're signed out of it. Each request carries the server's check of the website.
export type Check = { risk: 'low' | 'medium' | 'high'; flags: string[]; summary: string; title: string; hosts: string[]; same: string | null } | { error: string };
export type Grant = { workspace: string; person: string; site: string; reason: string; at: string; state: 'pending' | 'approved' | 'denied' | 'revoked' | 'lapsed'; by?: string; decided?: string; text?: string; check?: Check };
export const grants = () => readJson<Record<string, Grant>>('grants.json', {});
const save = (all: Record<string, Grant>) => writeJson('grants.json', all);
const WEEK = 7 * 86_400_000;
const live = (g: Grant) => g.state === 'pending' || g.state === 'approved';

// Whether a website's use is approved: for a person in a workspace, for a person anywhere, or for anyone.
export const approved = (site: string, person?: string, workspace?: string) => Object.values(grants())
  .some(g => g.state === 'approved' && g.site === site && (!person || g.person === person) && (!workspace || g.workspace === workspace));

// The grants `me` sees: their own, and those of the workspaces they manage, all for admins.
export const visible = (me: Me) => Object.entries(grants()).filter(([, g]) => g.person === me.email || canManage(me, tree().workspaces[g.workspace]))
  .map(([id, g]) => ({ id, ...g }));

export async function ask(me: Me, site: string, workspace: string, reason: string): Promise<{ id: string; check: Check }> {
  const w = tree().workspaces[workspace], login = logins(me.email).find(l => l.id === `web:${site}`);
  if (!w || !canSee(me, w)) throw new HttpError(404, `no workspace ${workspace} of yours`);
  if (!login) throw new HttpError(409, `sign in to ${site} first, on the Logins page: you ask to use your login to it`);
  if (!reason.trim()) throw new HttpError(400, "a reason: what you'll use it for, for the workspace's owners");
  const had = () => Object.values(grants()).find(g => live(g) && g.workspace === workspace && g.person === me.email && g.site === site);
  const asked = (g: Grant) => new HttpError(409, `you've ${g.state === 'approved' ? 'been granted' : 'asked for'} ${site} in ${w.name} already`);
  if (had()) throw asked(had()!);
  const check = await checkSite(site, login.trace, reason.trim(), w.name), again = had();
  if (again) throw asked(again);
  const all = grants(), id = newId();
  all[id] = { workspace, person: me.email, site, reason: reason.trim().slice(0, 500), at: new Date().toISOString(), state: 'pending', check };
  save(all);
  return { id, check };
}

// The server's check of a website a person asks to use, by its model, from what it may reach, and what their sign-in to it reached,
// by host and status, and was refused: never a path, a query, a body or a cookie. It answers how risky it looks and why, in two
// sentences for the approver, the website's plain name, the hosts its pages need, as many as pass what any website may reach
// (connections.ts), and whether it's a website here already. Approving it lets the website reach those hosts, and gives it that name
// if it has none; one it rates high only an admin approves. Without the server's key, or if the model fails, it's not checked.
const CHECK = `You check a website for a company's finance team, before a workspace's owners let a colleague's login to it be used by automated runs. You see its address, the hosts it may reach, the hosts the colleague's own sign-in to it reached, with HTTP status counts, and was refused, what they'll use it for, and the websites already here. Answer with one JSON object:
{"risk": "low" | "medium" | "high", "flags": [each concern, a short phrase], "summary": "at most two sentences for the approver: what the website is, and whether its sign-in looks right", "title": "the website's plain name, such as its company's and product's", "hosts": ["*.D" for each registrable domain D of the website's own, and exact names of the others its pages need, such as its sign-on's and its CDN's; never analytics, advertising or trackers"], "same": "the name of a website already here that is this same website", or null}
High risk means no one but an admin should approve it: a sign-in on a domain that imitates another, credentials going to an unrelated domain, or a personal file-sharing, paste or webmail service.`;

async function checkSite(site: string, trace: Trace | undefined, reason: string, workspace: string): Promise<Check> {
  const key = process.env.OPENROUTER_API_KEY, w = websites()[site], at = new URL(w.url);
  if (!key) return { error: 'the server has no OPENROUTER_API_KEY' };
  try {
    const res = await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, provider: { data_collection: 'deny' }, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: CHECK }, { role: 'user', content: JSON.stringify({
        website: { name: site, title: w.name, address: at.origin + at.pathname, hosts: w.hosts }, signIn: trace ?? null, reason, workspace,
        others: Object.entries(websites()).filter(([n]) => n !== site).map(([n, x]) => ({ name: n, title: x.name, address: new URL(x.url).host })),
      }) }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
    const a = JSON.parse((await res.json()).choices[0].message.content), hosts: string[] = [];
    for (const h of new Set((a.hosts ?? []).map((h: unknown) => String(h).toLowerCase()) as string[])) if (await checkHost(site, h, !!w.internal).then(() => true, () => false)) hosts.push(h);
    return { risk: ['low', 'medium'].includes(a.risk) ? a.risk : 'high', flags: (a.flags ?? []).map(String), summary: String(a.summary ?? ''), title: String(a.title ?? ''), hosts,
      same: a.same !== site && websites()[a.same] ? a.same : null };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function decide(me: Me, id: string, approve: boolean, text: string) {
  const all = grants(), g = all[id];
  if (g?.state !== 'pending') throw new HttpError(404, `no request ${id} waits`);
  if (!canManage(me, tree().workspaces[g.workspace])) throw new HttpError(403, `${tree().workspaces[g.workspace].name}'s owners decide it`);
  if (approve && g.check && 'risk' in g.check && g.check.risk === 'high' && me.role !== 'admin') throw new HttpError(403, `the check rates ${g.site} high risk: an admin decides`);
  all[id] = { ...g, state: approve ? 'approved' : 'denied', by: me.email, decided: new Date().toISOString(), ...(text.trim() && { text: text.trim() }) };
  save(all);
  if (!approve) return unused(g.person, g.site);
  if (g.check && 'hosts' in g.check) {
    const c = connections().find(c => c.name === g.site)!;
    changeConnection(g.site, { hosts: [...new Set([...c.hosts, ...g.check.hosts])], ...(!c.title && g.check.title && { title: g.check.title }) }, me.email);
  }
}

// Revoked by the workspace's owners or an admin, or withdrawn by its person, pending or approved.
export function revoke(me: Me, id: string): Grant {
  const all = grants(), g = all[id];
  if (!g || !live(g)) throw new HttpError(404, `no grant ${id} pending or approved`);
  if (g.person !== me.email && !canManage(me, tree().workspaces[g.workspace])) throw new HttpError(403, `${tree().workspaces[g.workspace].name}'s owners revoke it, or ${g.person}`);
  all[id] = { ...g, state: 'revoked', by: me.email, decided: new Date().toISOString() };
  save(all);
  unused(g.person, g.site);
  return g;
}

// A website removed takes its grants with it.
export function forget(site: string) {
  save(Object.fromEntries(Object.entries(grants()).filter(([, g]) => g.site !== site)));
}

// Signed out of a website once nothing of theirs for it is pending or approved.
function unused(person: string, site: string) {
  if (!Object.values(grants()).some(g => live(g) && g.person === person && g.site === site) && logins(person).some(l => l.id === `web:${site}`)) signOut(person, `web:${site}`);
}

// Requests a week old lapse, and logins no approved grant uses are signed out a week after their sign-in.
export function lapse(now = Date.now()) {
  const all = grants(), old = Object.entries(all).filter(([, g]) => g.state === 'pending' && now - Date.parse(g.at) > WEEK);
  for (const [id, g] of old) all[id] = { ...g, state: 'lapsed', decided: new Date(now).toISOString() };
  if (old.length) save(all);
  for (const [, g] of old) unused(g.person, g.site);
  for (const email of Object.keys(users())) for (const l of logins(email).filter(l => l.kind === 'website' && now - Date.parse(l.since) > WEEK && !approved(l.id.slice(4), email))) signOut(email, l.id);
}

// Once, as the server starts with no grants.json: every website becomes one people add, each its adder's, or for one admins kept,
// the admin who last set it, still reaching internal addresses as it could, with no list of people; each use of one so far, a tick
// of an instance's runner or of a shared series' sharer, an approved grant where it is; and no one is granted sites any more, as
// everyone adds websites.
export function migrate() {
  if (existsSync(join(rfDir(), 'grants.json'))) return;
  const cs = readJson<Record<string, Record<string, unknown>>>('connections.json', {}), at = new Date().toISOString(), out: Record<string, Grant> = {};
  for (const [name, { people, ...c }] of Object.entries(cs).filter(([, c]) => c.type === 'website'))
    cs[name] = c.owner ? c : { ...c, ...(String(c.updated_by).includes('@') && { owner: c.updated_by }), internal: true };
  writeJson('connections.json', cs);
  const use = (workspace: string, person: string, ticks: string[]) => {
    for (const site of ticks.filter(t => t.startsWith('web:')).map(t => t.slice(4)))
      if (!Object.values(out).some(g => g.workspace === workspace && g.person === person && g.site === site))
        out[newId()] = { workspace, person, site, reason: 'in use as grants began', at, state: 'approved', by: 'server', decided: at };
  };
  for (const [sid, s] of Object.entries(tree().series)) {
    for (const i of instances(sid)) use(s.workspace, runnerOf(i).by, runnerOf(i).logins);
    const { shared } = seriesSettings(seriesDir(sid));
    if (shared) use(s.workspace, shared.by, shared.logins);
  }
  save(out);
  const { sites, ...caps } = readJson<Record<string, string[]>>('capabilities.json', {});
  if (sites) writeJson('capabilities.json', caps);
}
