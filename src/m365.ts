import { HttpError, type Instance } from './store.ts';
import { endpoints, get, graph } from './graph.ts';
import { needs } from './auth.ts';
import { logins, runnerOf, saveLogin, use } from './logins.ts';

// rf graph: a GET to Microsoft Graph as the instance's runner, answered as Graph answers it, as far as the instance's ticks reach:
// /me/… or /users/ADDRESS/… for a mailbox's messages and folders, /me/drive/… for the runner's OneDrive, /drives/ID/… for it or a
// site's library, /sites/ID/… for a site, and /shares/ID/… for what a sharing link points at, where that lives. PATH may be a whole
// @odata.nextLink, and is read as Graph reads it, dot segments resolved.
export async function graphGet(inst: Instance, target: string, headers: Record<string, string>) {
  const base = new URL(endpoints.graph), root = base.pathname.replace(/\/$/, ''), runner = runnerOf(inst).by;
  const u = new URL(target.startsWith('/') ? endpoints.graph + target : target);
  if (u.origin !== base.origin || !u.pathname.startsWith(`${root}/`)) throw new HttpError(400, `a Graph path, such as /me/messages, or a link Graph gave: not ${target}`);
  const path = u.pathname.slice(root.length) + u.search, segments = path.split('?')[0].split('/').slice(1).map(s => decodeURIComponent(s));
  // /me is the runner, and mailFolders('inbox') is mailFolders.
  const [top, id = '', part = ''] = (segments[0] === 'me' ? ['users', runner, ...segments.slice(1)] : segments).map(s => s.replace(/\(.*$/, ''));
  let offer: string;
  if (top === 'users' && (part === 'messages' || part === 'mailFolders')) {
    needs('Mail.Read', 'mail');
    if (id.toLowerCase() !== runner) needs('Mail.Read.Shared', 'shared mailboxes');
    offer = `m365:mail:${id.toLowerCase()}`;
  } else if (top === 'users' && part === 'drive' && id.toLowerCase() === runner) {
    needs('Files.Read.All', 'OneDrive');
    offer = 'm365:onedrive';
  } else if (top === 'drives' || top === 'shares') {
    needs('Files.Read.All', 'OneDrive or SharePoint files');
    offer = await driveOffer(runner, top === 'drives' ? id : (await graph(runner, `/shares/${encodeURIComponent(id)}/driveItem?$select=parentReference`)).parentReference.driveId);
  } else if (top === 'sites') {
    needs('Sites.Read.All', 'SharePoint sites');
    offer = `m365:site:${id}`;
  } else throw new HttpError(403, `rf graph reads mailboxes, OneDrive and SharePoint sites ticked for this instance, not ${path}`);
  return get(use(inst, offer).email, path, headers);
}

const own = new Map<string, string>();
// The tick a drive needs: the runner's own OneDrive, or the site whose library it is.
async function driveOffer(email: string, id: string): Promise<string> {
  if (!own.has(email)) own.set(email, (await graph(email, '/me/drive?$select=id')).id);
  if (id === own.get(email)) return 'm365:onedrive';
  const s = (await graph(email, `/drives/${encodeURIComponent(id)}?$select=sharePointIds`)).sharePointIds;
  return `m365:site:${new URL(s.siteUrl).hostname},${s.siteId},${s.webId}`;
}

// What a person's Microsoft 365 login offers besides their own mailbox and OneDrive: a shared mailbox they can read, or a SharePoint
// site by a link to it, each checked by reading it as them.
export async function offer(email: string, what: { mailbox?: string; site?: string }): Promise<void> {
  const login = logins(email).find(l => l.id === 'm365');
  if (!login) throw new HttpError(409, 'connect Microsoft 365 first');
  let add;
  if (what.mailbox) {
    needs('Mail.Read.Shared', 'shared mailboxes');
    const box = what.mailbox.trim().toLowerCase();
    if (!/^[^@\s/]+@[^@\s/]+$/.test(box)) throw new HttpError(400, `not a mailbox address: ${box}`);
    await graph(email, `/users/${encodeURIComponent(box)}/mailFolders/inbox`);
    add = { id: `m365:mail:${box}`, name: `Mailbox ${box}` };
  } else {
    needs('Sites.Read.All', 'SharePoint sites');
    const u = URL.canParse(what.site ?? '') ? new URL(what.site!) : undefined;
    const path = u?.pathname.match(/^\/(sites|teams)\/[^/]+/)?.[0];
    if (!u || !path) throw new HttpError(400, 'a SharePoint site link, such as https://contoso.sharepoint.com/sites/Finance');
    const site = await graph(email, `/sites/${u.hostname}:${path}`);
    add = { id: `m365:site:${site.id}`, name: `SharePoint ${site.displayName ?? path}` };
  }
  saveLogin(email, { ...login, offers: [...login.offers.filter(o => o.id !== add.id), add] });
}

export function unoffer(email: string, id: string) {
  const login = logins(email).find(l => l.id === 'm365');
  if (!login) throw new HttpError(404, 'no Microsoft 365 login');
  saveLogin(email, { ...login, offers: login.offers.filter(o => o.id !== id) });
}
