import { HttpError, instances, newId } from './store.ts';
import { act, canManage, canSee, readJson, tree, writeJson } from './system.ts';
import { users, type Me } from './auth.ts';
import { logins, signOut } from './logins.ts';
import { checkWebsite, websitesOf, type Profile } from './browsers.ts';

// Grants, in .rf/grants.json: a person's use of their login to their website in one workspace, (workspace, person, site). The person
// asks, with a reason, once they've signed in to it; one of the workspace's owners, or an admin, approves or denies it, and may
// revoke it at any time, as the person may withdraw it. A run's browser on a website opens only from its runner's login, and only
// where their grant in the instance's workspace is approved (browsers.ts). A request lapses a week after it was asked; a login to a
// website no approved grant uses is signed out a week after its sign-in; and once a person has nothing pending or approved for a
// website, as after a denial or a revocation, they're signed out of it. Owners see the website's profile; old grants keep their check.
export type Check = { risk: 'low' | 'medium' | 'high'; flags: string[]; summary: string; hosts: string[] } | { error: string };
export type Grant = { workspace: string; person: string; site: string; reason: string; at: string; state: 'pending' | 'approved' | 'denied' | 'revoked' | 'lapsed'; by?: string; decided?: string; text?: string; check?: Check };
export const grants = () => readJson<Record<string, Grant>>('grants.json', {});
const save = (all: Record<string, Grant>) => writeJson('grants.json', all);
const WEEK = 7 * 86_400_000;
const live = (g: Grant) => g.state === 'pending' || g.state === 'approved';

// Whether a website's use is approved: for a person in a workspace, for a person anywhere, or for anyone.
export const approved = (site: string, person?: string, workspace?: string) => Object.values(grants())
  .some(g => g.state === 'approved' && g.site === site && (!person || g.person === person) && (!workspace || g.workspace === workspace));

export function visible(me: Me) {
  const t = tree(), people = users();
  return Object.entries(grants()).filter(([, g]) => g.person === me.email || canManage(me, t.workspaces[g.workspace])).map(([id, g]) => {
    const website = websitesOf(g.person)[g.site], profile = website.profile ?? null;
    const personName = people[g.person]?.name ?? g.person, workspaceName = t.workspaces[g.workspace].name;
    const why: string[] = [], flags: string[] = [];
    if (!profile) {
      if (!g.check || 'error' in g.check) why.push('the website profile is missing');
    } else if ('error' in profile) why.push(`the website profile could not be checked: ${profile.error}`);
    else {
      flags.push(...profile.flags);
      if (profile.category === 'general') why.push('this is a general-purpose website');
      if (profile.risk === 'high') why.push(`the website profile rates ${g.site} high risk`);
    }
    if (g.check && 'risk' in g.check) {
      flags.push(...g.check.flags);
      if (g.check.risk === 'high') why.push(`the old check rates ${g.site} high risk`);
    } else if (g.check) flags.push(`The old check failed: ${g.check.error}`);
    const use = g.state === 'approved' ? { runs: 0, wrote: 0, last: null as string | null } : null;
    if (use) {
      const runs = new Set<string>(), wrote = new Set<string>();
      for (const [sid] of Object.entries(t.series).filter(([, s]) => s.workspace === g.workspace)) {
        for (const inst of instances(sid)) for (const e of inst.log.slice(inst.log.findLastIndex(e => e.op === 'duplicate') + 1)) {
          if (e.op !== 'browser' || e.action || e.site !== g.site || e.login !== g.person) continue;
          const run = `${inst.id}:${e.run}`;
          runs.add(run);
          if ((e.writes as number) > 0) wrote.add(run);
          if (use.last === null || Date.parse(e.at) > Date.parse(use.last)) use.last = e.at;
        }
      }
      use.runs = runs.size;
      use.wrote = wrote.size;
    }
    const host = new URL(website.url).hostname;
    const what = profile && 'what' in profile ? `${profile.what} (${profile.category} system, ${host})`
      : g.check && 'summary' in g.check ? `${g.check.summary} (${g.check.risk} risk, ${host})` : website.url;
    return { id, ...g, url: website.url, profile, personName, workspaceName,
      description: `${personName} asks that runs in ${workspaceName} use their login to ${g.site} — ${what}. Runs there can do whatever ${personName} can, including submitting and approving. Their reason: ${g.reason}. The reason is not an enforced limit.`,
      flags: [...new Set([...flags, ...why])], adminOnly: why.length > 0, adminWhy: why.length ? `${why.join('; ')}: an admin decides` : '', use };
  });
}

export async function ask(me: Me, site: string, workspace: string, reason: string): Promise<{ id: string; profile: Profile }> {
  const w = tree().workspaces[workspace], login = logins(me.email).find(l => l.id === `web:${site}`);
  if (!w || !canSee(me, w)) throw new HttpError(404, `no workspace ${workspace} of yours`);
  if (!login) throw new HttpError(409, `sign in to ${site} first, on the Logins page: you ask to use your login to it`);
  if (!reason.trim()) throw new HttpError(400, "a reason: what you'll use it for, for the workspace's owners");
  const had = () => Object.values(grants()).find(g => live(g) && g.workspace === workspace && g.person === me.email && g.site === site);
  const asked = (g: Grant) => new HttpError(409, `you've ${g.state === 'approved' ? 'been granted' : 'asked for'} ${site} in ${w.name} already`);
  if (had()) throw asked(had()!);
  const existing = websitesOf(me.email)[site].profile;
  const profile = !existing || 'error' in existing ? await checkWebsite(me.email, site, login.trace) : existing, again = had();
  if (again) throw asked(again);
  // Removing the website meanwhile signed them out of it, and took their grants for it.
  if (!logins(me.email).some(l => l.id === login.id)) throw new HttpError(409, `you removed ${site} or signed out of it while it was checked`);
  if (!tree().workspaces[workspace]) throw new HttpError(409, `${w.name} was merged into another while it was checked: ask there`);
  const all = grants(), id = newId();
  all[id] = { workspace, person: me.email, site, reason: reason.trim().slice(0, 500), at: new Date().toISOString(), state: 'pending' };
  save(all);
  return { id, profile };
}

export function decide(me: Me, id: string, approve: boolean, text: string) {
  const all = grants(), g = all[id];
  if (g?.state !== 'pending') throw new HttpError(404, `no request ${id} waits`);
  if (!canManage(me, tree().workspaces[g.workspace])) throw new HttpError(403, `${tree().workspaces[g.workspace].name}'s owners decide it`);
  if (approve && me.role !== 'admin') {
    const card = visible(me).find(row => row.id === id)!;
    if (card.adminOnly) throw new HttpError(403, card.adminWhy);
  }
  all[id] = { ...g, state: approve ? 'approved' : 'denied', by: me.email, decided: new Date().toISOString(), ...(text.trim() && { text: text.trim() }) };
  save(all);
  if (!approve) unused(g.person, g.site);
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
