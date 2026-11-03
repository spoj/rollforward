import { HttpError, type Instance } from './store.ts';
import { endpoints, get, graph } from './graph.ts';
import { needs } from './auth.ts';
import { logins, runnerOf, saveLogin, use, type Offer } from './logins.ts';

// rf graph: a GET to Microsoft Graph as the instance's runner, answered as Graph answers it, as far as the instance's ticks reach:
// /me/… or /users/ADDRESS/… for a mailbox's messages and folders; /drives/ID/…, /shares/ID/…, /me/drive/… or /users/ADDRESS/drive/…
// for files, within a ticked folder, a ticked file, a ticked site's libraries or, as before, the runner's ticked OneDrive; and
// /sites/ID/… for a ticked site. PATH may be a whole @odata.nextLink, and is read as Graph reads it, dot segments resolved.
export async function graphGet(inst: Instance, target: string, headers: Record<string, string>) {
  const base = new URL(endpoints.graph), root = base.pathname.replace(/\/$/, ''), runner = runnerOf(inst).by;
  const u = new URL(target.startsWith('/') ? endpoints.graph + target : target);
  if (u.origin !== base.origin || !u.pathname.startsWith(`${root}/`)) throw new HttpError(400, `a Graph path, such as /me/messages, or a link Graph gave: not ${target}`);
  const path = u.pathname.slice(root.length) + u.search, segments = path.split('?')[0].split('/').slice(1).map(s => decodeURIComponent(s));
  // /me is the runner, and mailFolders('inbox') is mailFolders.
  const [top, id = '', part = ''] = (segments[0] === 'me' ? ['users', runner, ...segments.slice(1)] : segments).map(s => s.replace(/\(.*$/, ''));
  let offer: string | undefined;
  if (top === 'users' && (part === 'messages' || part === 'mailFolders')) {
    needs('Mail.Read', 'mail');
    if (id.toLowerCase() !== runner) needs('Mail.Read.Shared', 'shared mailboxes');
    offer = `m365:mail:${id.toLowerCase()}`;
  } else if (top === 'drives' || top === 'shares' || (top === 'users' && part === 'drive')) {
    needs('Files.Read.All', 'OneDrive or SharePoint files');
    const item = await graph(runner, `${addressed(path.split('?')[0].replace(/^\/me\//, `/users/${runner}/`))}?$select=id,parentReference`);
    offer = await covering(runner, runnerOf(inst).logins, item.parentReference.driveId, item.id, item.parentReference.id);
    if (!offer) throw new HttpError(403, `${path.split('?')[0]} is in no folder, file or SharePoint site ticked for this instance`);
  } else if (top === 'sites') {
    needs('Sites.Read.All', 'SharePoint sites');
    offer = `m365:site:${id}`;
  } else throw new HttpError(403, `rf graph reads mailboxes, and folders, files and SharePoint sites ticked for this instance, not ${path}`);
  return get(use(inst, offer).email, path, headers);
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
    if (box === email) needs('Mail.Read', 'mail');
    else needs('Mail.Read.Shared', 'shared mailboxes');
    await graph(email, `/users/${encodeURIComponent(box)}/mailFolders/inbox`);
    o = { id: `m365:mail:${box}`, name: `Mailbox ${box}` };
  } else {
    if (!URL.canParse(v)) throw new HttpError(400, 'a mailbox address, or a link to a SharePoint site, or to a folder or file in SharePoint or OneDrive');
    // A library's or a OneDrive's view names its folder in ?id=, and a Copy link (/:f:/r/…) keeps the path: each reads as that path.
    const u = new URL(v), id = u.searchParams.get('id');
    const link = id ? u.origin + encodeURI(id) : /^\/:\w:\/r\//.test(u.pathname) ? u.origin + u.pathname.replace(/^\/:\w:\/r/, '') : v;
    const path = new URL(link).pathname.replace(/\/$/, '');
    if (/^\/(sites|teams)\/[^/]+$/.test(path)) {
      needs('Sites.Read.All', 'SharePoint sites');
      const site = await graph(email, `/sites/${u.hostname}:${path}`);
      o = { id: `m365:site:${site.id}`, name: `Site ${site.displayName ?? path}` };
    } else {
      needs('Files.Read.All', 'OneDrive or SharePoint files');
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
