import { HttpError, newId } from './store.ts';
import { act, canManage, canSee, readJson, tree, writeJson } from './system.ts';
import { users, type Me } from './auth.ts';
import { logins, signOut, type Trace } from './logins.ts';
import { checkHost, resolvesInternal, upstreams } from './connections.ts';
import { model } from './connections/openrouter.ts';
import { changeWebsite, websitesOf } from './browsers.ts';

// Grants, in .rf/grants.json: a person's use of their login to their website in one workspace, (workspace, person, site). The person
// asks, with a reason, once they've signed in to it; one of the workspace's owners, or an admin, approves or denies it, and may
// revoke it at any time, as the person may withdraw it. A run's browser on a website opens only from its runner's login, and only
// where their grant in the instance's workspace is approved (browsers.ts). A request lapses a week after it was asked; a login to a
// website no approved grant uses is signed out a week after its sign-in; and once a person has nothing pending or approved for a
// website, as after a denial or a revocation, they're signed out of it. Each request carries the server's check of the website.
export type Check = { risk: 'low' | 'medium' | 'high'; flags: string[]; summary: string; hosts: string[] } | { error: string };
export type Grant = { workspace: string; person: string; site: string; reason: string; at: string; state: 'pending' | 'approved' | 'denied' | 'revoked' | 'lapsed'; by?: string; decided?: string; text?: string; check?: Check };
export const grants = () => readJson<Record<string, Grant>>('grants.json', {});
const save = (all: Record<string, Grant>) => writeJson('grants.json', all);
const WEEK = 7 * 86_400_000;
const live = (g: Grant) => g.state === 'pending' || g.state === 'approved';

// Whether a website's use is approved: for a person in a workspace, for a person anywhere, or for anyone.
export const approved = (site: string, person?: string, workspace?: string) => Object.values(grants())
  .some(g => g.state === 'approved' && g.site === site && (!person || g.person === person) && (!workspace || g.workspace === workspace));

// The grants `me` sees, each with its website's address and the other hosts it reaches: their own, and those of the workspaces they
// manage, all for admins.
export const visible = (me: Me) => Object.entries(grants()).filter(([, g]) => g.person === me.email || canManage(me, tree().workspaces[g.workspace]))
  .map(([id, g]) => ({ id, ...g, url: websitesOf(g.person)[g.site].url, hosts: websitesOf(g.person)[g.site].hosts }));

export async function ask(me: Me, site: string, workspace: string, reason: string): Promise<{ id: string; check: Check }> {
  const w = tree().workspaces[workspace], login = logins(me.email).find(l => l.id === `web:${site}`);
  if (!w || !canSee(me, w)) throw new HttpError(404, `no workspace ${workspace} of yours`);
  if (!login) throw new HttpError(409, `sign in to ${site} first, on the Logins page: you ask to use your login to it`);
  if (!reason.trim()) throw new HttpError(400, "a reason: what you'll use it for, for the workspace's owners");
  const had = () => Object.values(grants()).find(g => live(g) && g.workspace === workspace && g.person === me.email && g.site === site);
  const asked = (g: Grant) => new HttpError(409, `you've ${g.state === 'approved' ? 'been granted' : 'asked for'} ${site} in ${w.name} already`);
  if (had()) throw asked(had()!);
  const check = await checkSite(me.email, site, login.trace, reason.trim(), w.name), again = had();
  if (again) throw asked(again);
  // Removing the website meanwhile signed them out of it, and took their grants for it.
  if (!logins(me.email).some(l => l.id === login.id)) throw new HttpError(409, `you removed ${site} or signed out of it while it was checked`);
  if (!tree().workspaces[workspace]) throw new HttpError(409, `${w.name} was merged into another while it was checked: ask there`);
  const all = grants(), id = newId();
  all[id] = { workspace, person: me.email, site, reason: reason.trim().slice(0, 500), at: new Date().toISOString(), state: 'pending', check };
  save(all);
  return { id, check };
}

// The server's check of a website a person asks to use, by its model, from what it may reach, and what their sign-in to it reached,
// by host and status, and was refused: never a path, a query, a body or a cookie. It answers how risky it looks and why, in two
// sentences for the approver, and the hosts its pages need, as many as pass what any website may reach (connections.ts). Approving
// it lets the website reach those hosts; one it rates high only an admin approves. Without the server's key, or if the model fails,
// it's not checked.
const CHECK = `You check a website for a company's finance team, before a workspace's owners let a colleague's login to it be used by automated runs. You see its address, the hosts it may reach, the hosts the colleague's own sign-in to it reached, with HTTP status counts, and was refused, and what they'll use it for. Answer with one JSON object:
{"risk": "low" | "medium" | "high", "flags": [each concern, a short phrase], "summary": "at most two sentences for the approver: what the website is, and whether its sign-in looks right", "hosts": ["*.D" for each registrable domain D of the website's own, and exact names of the others its pages need, such as its sign-on's and its CDN's; never analytics, advertising or trackers"]}
High risk means no one but an admin should approve it: a sign-in on a domain that imitates another, credentials going to an unrelated domain, or a personal file-sharing, paste or webmail service.`;

async function checkSite(email: string, site: string, trace: Trace | undefined, reason: string, workspace: string): Promise<Check> {
  const key = process.env.OPENROUTER_API_KEY, w = websitesOf(email)[site], at = new URL(w.url);
  if (!key) return { error: 'the server has no OPENROUTER_API_KEY' };
  try {
    const res = await fetch(`${upstreams['openrouter.ai'] ?? 'https://openrouter.ai'}/api/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, provider: { data_collection: 'deny' }, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: CHECK }, { role: 'user', content: JSON.stringify({
        website: { name: site, address: at.origin + at.pathname, hosts: w.hosts }, signIn: trace ?? null, reason, workspace,
      }) }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
    const a = JSON.parse((await res.json()).choices[0].message.content), hosts: string[] = [];
    for (const h of new Set((a.hosts ?? []).map((h: unknown) => String(h).toLowerCase()) as string[])) if (!await resolvesInternal(h) && await checkHost(h, !!w.internal).then(() => true, () => false)) hosts.push(h);
    return { risk: ['low', 'medium'].includes(a.risk) ? a.risk : 'high', flags: (a.flags ?? []).map(String), summary: String(a.summary ?? ''), hosts };
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
  if (g.check && 'hosts' in g.check) changeWebsite(g.person, g.site, { hosts: [...new Set([...websitesOf(g.person)[g.site].hosts, ...g.check.hosts])] });
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

// A workspace merged into another takes its grants with it: its series' runs are the other's now, whose owners approve anew.
export function forgetWorkspace(workspace: string) {
  save(Object.fromEntries(Object.entries(grants()).filter(([, g]) => g.workspace !== workspace)));
}

// A person's website removed takes their grants for it with it, and a person removed all of theirs.
export function forgetGrants(person: string, site?: string) {
  save(Object.fromEntries(Object.entries(grants()).filter(([, g]) => g.person !== person || (site !== undefined && g.site !== site))));
}

// Signed out of a website once nothing of theirs for it is pending or approved.
function unused(person: string, site: string) {
  if (!Object.values(grants()).some(g => live(g) && g.person === person && g.site === site) && logins(person).some(l => l.id === `web:${site}`)) signOut(person, `web:${site}`);
}

// Requests a week old lapse, and logins no approved grant uses are signed out a week after their sign-in, each an act of the
// server's in the system's log.
export function lapse(now = Date.now()) {
  const all = grants(), old = Object.entries(all).filter(([, g]) => g.state === 'pending' && now - Date.parse(g.at) > WEEK);
  for (const [id, g] of old) all[id] = { ...g, state: 'lapsed', decided: new Date(now).toISOString() };
  if (old.length) save(all);
  for (const [, g] of old) unused(g.person, g.site);
  const out = Object.keys(users()).flatMap(email => logins(email).filter(l => l.kind === 'website' && now - Date.parse(l.since) > WEEK && !approved(l.id.slice(4), email)).map(l => [email, l.id]));
  for (const [email, id] of out) signOut(email, id);
  if (old.length || out.length) act('server', { op: 'lapse', grants: old.map(([id]) => id), signed_out: out });
}
