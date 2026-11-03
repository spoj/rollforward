import { HttpError } from '../store.ts';
import { graphScopes, needs } from '../auth.ts';
import { token } from '../entra.ts';
import { logins, saveLogin, type Offer } from '../logins.ts';
import type { Request, Type } from '../connections.ts';

// Microsoft Graph, as the runner, as far as the instance's ticks reach: /me/… or /users/ADDRESS/… for a mailbox's messages and
// folders, and its sendMail; /drives/ID/…, /shares/ID/…, /me/drive/… or /users/ADDRESS/drive/… for files, within a ticked folder,
// a ticked file, a ticked site's libraries or the runner's ticked OneDrive; and /sites/ID/… for a ticked site, all under v1.0, as
// Graph reads a path, dot segments resolved. A write, a POST, PATCH, PUT or DELETE, reaches only what a read does: a file it makes,
// moves or copies lands within the ticks, mail goes out as the ticked mailbox it is sent from, written as JSON, and it shares
// nothing. Its person's login is Microsoft 365's, 'm365', whose offers they add one at a time.

// Tests point this at a stand-in.
export const endpoints = { graph: 'https://graph.microsoft.com' };
const scope = () => graphScopes.map(s => `https://graph.microsoft.com/${s}`);

// A GET's JSON, as a person; an error names what Microsoft said, such as no access to a mailbox.
export async function graph(email: string, path: string): Promise<any> {
  const r = await fetch(`${endpoints.graph}/v1.0${path}`, { headers: { authorization: `Bearer ${await token(email, 'm365', scope())}` }, signal: AbortSignal.timeout(120_000) });
  const j = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : {};
  if (r.status >= 300) throw new HttpError(r.status === 404 || r.status === 403 ? r.status : 502, `Microsoft Graph answered ${r.status} ${j.error?.code ?? ''}: ${j.error?.message ?? ''}`);
  return j;
}

// The offer that lets a request through, or why not.
async function check(runner: string, ticks: string[], { method, url, headers, json }: Request): Promise<string> {
  if (!url.pathname.startsWith('/v1.0/')) throw new HttpError(403, `${url.pathname}: Microsoft Graph v1.0, under /v1.0/`);
  // Neither another method in a header, nor a Prefer that redeems a sharing link, which grants the runner access.
  if (Object.keys(headers).some(h => /^x-http-method/i.test(h)) || /redeemsharinglink/i.test(String(headers.prefer ?? ''))) throw new HttpError(403, 'no X-HTTP-Method header, and no Prefer that redeems a sharing link');
  const bare = url.pathname.slice(5), path = bare + url.search, segments = bare.split('/').slice(1).map(s => decodeURIComponent(s));
  // /me is the runner, and mailFolders('inbox') is mailFolders.
  const segs = segments[0] === 'me' ? ['users', runner, ...segments.slice(1)] : segments, [top, id = '', part = ''] = segs.map(s => s.replace(/\(.*$/, ''));
  const write = method !== 'GET', actions = segs.map(s => s.replace(/\(.*$/, '').replace(/^microsoft\.graph\./i, '').toLowerCase()), action = actions.at(-1);
  let offer: string | undefined, mail = false;
  if (top === 'users' && (part === 'messages' || part === 'mailFolders' || (write && actions[2] === 'sendmail'))) {
    const scope = !write ? 'Mail.Read' : ['sendmail', 'send', 'reply', 'replyall', 'forward'].includes(action!) ? 'Mail.Send' : 'Mail.ReadWrite';
    const what = { 'Mail.Read': ['read mail', 'read shared mailboxes'], 'Mail.Send': ['send mail', 'send from shared mailboxes'], 'Mail.ReadWrite': ['write mail', 'write to shared mailboxes'] }[scope];
    needs(scope, what[0]);
    if (id.toLowerCase() !== runner) needs(`${scope}.Shared`, what[1]);
    offer = `m365:mail:${id.toLowerCase()}`;
    mail = true;
    // Mail goes out as the mailbox it is sent from, which only JSON shows.
    if (['POST', 'PATCH', 'PUT'].includes(method) && Number(headers['content-length'] ?? 1) > 0 && !json) throw new HttpError(403, `${bare}: write mail as JSON, such as {"message": {...}}`);
    const as = json?.message ?? json;
    if ([as?.from, as?.sender].some(x => x && x.emailAddress?.address?.toLowerCase() !== id.toLowerCase())) throw new HttpError(403, `${bare}: mail from ${id} goes out as ${id}`);
  } else if (top === 'drives' || top === 'shares' || (top === 'users' && part === 'drive')) {
    needs(write ? 'Files.ReadWrite.All' : 'Files.Read.All', `${write ? 'save' : 'read'} OneDrive or SharePoint files`);
    // A share's site and list are the whole site and library its item is in, past what is ticked.
    // A drive's own search, recent, sharedWithMe and following list other drives' items too; a search under its root stays in it.
    const of = segs[top === 'users' ? 3 : 2] ?? '';
    if (top !== 'shares' && /(^|\.)(search|recent|sharedwithme|following)(\(|$)/i.test(of)) throw new HttpError(403, `${bare}: a drive's ${of.replace(/\(.*$/, '')} lists other drives' items too; search under its root, as /drives/ID/root/search(q='...')`);
    if (top === 'shares' && !['', 'driveitem', 'root', 'items', 'listitem'].includes(part.toLowerCase())) throw new HttpError(403, `${bare}: a share is read through its driveItem, root or items, not its ${part}, which reaches past what is ticked`);
    const item = await located(runner, addressed(bare.replace(/^\/me\//, `/users/${runner}/`)));
    offer = await covering(runner, ticks, item.parentReference.driveId, item.id, item.parentReference.id);
    if (!offer) throw new HttpError(403, `${bare} is in no folder, file or SharePoint site ticked for this instance`);
  } else if (top === 'sites') {
    needs(!write ? 'Sites.Read.All' : segs.some(s => /^drives?$/i.test(s)) ? 'Files.ReadWrite.All' : 'Sites.ReadWrite.All', `${write ? 'write' : 'read'} SharePoint sites`);
    if (segments.some(s => /(^|\.)getbypath\(/i.test(s))) throw new HttpError(403, `${bare}: getByPath reaches any site by its path; read the ticked one by its id`);
    offer = `m365:site:${id}`;
  } else throw new HttpError(403, `the graph connection reaches mailboxes, and folders, files and SharePoint sites ticked for this instance, not ${path}`);
  // A link, an invitation, a permission or a mailbox's rule shares what is ticked, now or as it comes.
  if (write && actions.some(a => ['createlink', 'invite', 'grant', 'permissions', 'messagerules'].includes(a))) throw new HttpError(403, `${bare} would share it: nothing is shared, past the ticks or within them`);
  if (write && !mail) {
    // A move, a copy or a restore names its folder in the body, which a tick covers too.
    const to = json?.parentReference;
    if (to && (to.path || !to.id)) throw new HttpError(403, `${bare}: name the folder by its parentReference's id, and driveId for another drive`);
    if (to) {
      const drive = to.driveId ?? (await graph(runner, `${method === 'PATCH' ? bare : bare.replace(/\/[^/]+$/, '')}?$select=parentReference`)).parentReference.driveId;
      const folder = await graph(runner, `/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(to.id)}?$select=id,parentReference`);
      if (!await covering(runner, ticks, folder.parentReference.driveId, folder.id, folder.parentReference.id)) throw new HttpError(403, `${bare} would put it in a folder no tick covers`);
    }
  }
  return offer;
}

// Links an answer holds, which the run may then use as they are: an upload session's, and a file's download address.
const links = (j: unknown): string[] => !j || typeof j !== 'object' ? [] : Object.entries(j).flatMap(([k, v]) => ['uploadUrl', '@microsoft.graph.downloadUrl'].includes(k) && typeof v === 'string' ? [v] : links(v));

export default {
  settings: () => ({}),
  login: () => ({ id: 'm365', kind: 'm365', name: 'Microsoft 365', scope: scope() }),
  host: () => 'graph.microsoft.com',
  check: async (_, runner, ticks, r) => ({ offer: await check(runner, ticks, r) }),
  links,
} satisfies Type;

// The item a path names or, for one a write is to make, the nearest folder above it.
async function located(email: string, at: string): Promise<any> {
  return graph(email, `${at}?$select=id,parentReference`).catch(e => {
    const m = /^(.*?):(\/.*):$/.exec(at);
    if ((e as HttpError).status !== 404 || !m) throw e;
    const up = m[2].replace(/\/[^/]*$/, '');
    return located(email, up ? `${m[1]}:${up}:` : m[1]);
  });
}

// The item a files path is about: one in a drive, by id or by path, the item a share names, or the root of a drive, for anything
// else about the drive, such as a search across it.
function addressed(path: string): string {
  const m = /^(\/(?:drives|shares)\/[^/]+|\/users\/[^/]+\/drive)(\/(?:root|driveItem|items\/[^/:]+)(?::[^:]*:?)?)?/.exec(path)!;
  return m[1] + (m[2]?.replace(/(:[^:]*[^:])$/, '$1:') ?? (m[1].startsWith('/shares') ? '/driveItem' : '/root'));
}

// The tick that covers a drive's item: a ticked folder above it, read up through its parents, or the ticked file itself; a ticked
// site whose library holds it; or the runner's ticked OneDrive.
async function covering(email: string, ticks: string[], driveId: string, id: string, parent: string | undefined): Promise<string | undefined> {
  for (const t of ticks.filter(t => t.startsWith(`m365:item:${driveId}/`))) {
    const top = t.split('/').pop();
    if (id === top) return t;
    for (let at = parent; at; at = await parentOf(email, driveId, at)) if (at === top) return t;
  }
  if (ticks.includes(`m365:site:${await siteOf(email, driveId)}`)) return `m365:site:${await siteOf(email, driveId)}`;
  if (ticks.includes('m365:onedrive') && driveId === await ownDrive(email)) return 'm365:onedrive';
}

// What Graph says doesn't change often: who an item's parent is, for 5 minutes; whose a drive is, and which site's, for good. A
// parent the person can't read ends the climb, as does a drive whose site they can't see.
const parents = new Map<string, { parent?: string; at: number }>(), sites = new Map<string, string>(), own = new Map<string, string>();
async function parentOf(email: string, driveId: string, id: string): Promise<string | undefined> {
  const k = `${driveId}/${id}`, known = parents.get(k);
  if (known && known.at > Date.now() - 300_000) return known.parent;
  const parent = await graph(email, `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}?$select=parentReference`).then(j => j.parentReference?.id, () => undefined);
  parents.set(k, { parent, at: Date.now() });
  return parent;
}
async function siteOf(email: string, driveId: string): Promise<string> {
  if (!sites.has(driveId)) {
    const s = await graph(email, `/drives/${encodeURIComponent(driveId)}?$select=sharePointIds`).then(d => d.sharePointIds, () => undefined);
    sites.set(driveId, s ? `${new URL(s.siteUrl).hostname},${s.siteId},${s.webId}` : '');
  }
  return sites.get(driveId)!;
}
async function ownDrive(email: string): Promise<string> {
  if (!own.has(email)) own.set(email, (await graph(email, '/me/drive?$select=id')).id);
  return own.get(email)!;
}

// What a person's Microsoft 365 login offers, which they add one at a time, each checked by reading it as them: a mailbox by its
// address, their own or one they may read; a SharePoint site, whole, by its link; or a folder, with all that is under it, or a
// file, in SharePoint or in anyone's OneDrive, by any link to it. A whole OneDrive or library is its top folder's link.
export async function offer(email: string, add: string): Promise<void> {
  const login = logins(email).find(l => l.id === 'm365'), v = add.trim();
  if (!login) throw new HttpError(409, 'connect Microsoft 365 first');
  let o: Offer;
  if (/^[^@\s/]+@[^@\s/]+$/.test(v)) {
    const box = v.toLowerCase();
    if (box === email) needs('Mail.Read', 'read mail');
    else needs('Mail.Read.Shared', 'read shared mailboxes');
    await graph(email, `/users/${encodeURIComponent(box)}/mailFolders/inbox`);
    o = { id: `m365:mail:${box}`, name: `Mailbox ${box}` };
  } else {
    if (!URL.canParse(v)) throw new HttpError(400, 'a mailbox address, or a link to a SharePoint site, or to a folder or file in SharePoint or OneDrive');
    // A library's or a OneDrive's view names its folder in ?id=, and a Copy link (/:f:/r/…) keeps the path: each reads as that path.
    const u = new URL(v), id = u.searchParams.get('id');
    const link = id ? u.origin + encodeURI(id) : /^\/:\w:\/r\//.test(u.pathname) ? u.origin + u.pathname.replace(/^\/:\w:\/r/, '') : v;
    const path = new URL(link).pathname.replace(/\/$/, '');
    if (/^\/(sites|teams)\/[^/]+$/.test(path)) {
      needs('Sites.Read.All', 'read SharePoint sites');
      const site = await graph(email, `/sites/${u.hostname}:${path}`);
      o = { id: `m365:site:${site.id}`, name: `Site ${site.displayName ?? path}` };
    } else {
      needs('Files.Read.All', 'read OneDrive or SharePoint files');
      const item = await graph(email, `/shares/u!${Buffer.from(link).toString('base64url')}/driveItem?$select=id,name,root,folder,parentReference`);
      const d = await graph(email, `/drives/${encodeURIComponent(item.parentReference.driveId)}?$select=driveType,owner,sharePointIds`), s = d.sharePointIds;
      const where = d.driveType === 'business' ? `${d.owner?.user?.displayName ?? 'Someone'}'s OneDrive` : (await graph(email, `/sites/${new URL(s.siteUrl).hostname},${s.siteId},${s.webId}?$select=displayName`)).displayName;
      o = { id: `m365:item:${item.parentReference.driveId}/${item.id}`, name: item.root ? where : `${item.folder ? 'Folder' : 'File'} ${item.name}, ${where}` };
    }
  }
  saveLogin(email, { ...login, offers: [...login.offers.filter(x => x.id !== o.id), o] });
}

export function unoffer(email: string, id: string) {
  const login = logins(email).find(l => l.id === 'm365');
  if (!login) throw new HttpError(404, 'no Microsoft 365 login');
  saveLogin(email, { ...login, offers: login.offers.filter(o => o.id !== id) });
}
