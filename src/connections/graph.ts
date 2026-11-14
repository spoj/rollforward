import { HttpError } from '../store.ts';
import { graphScopes, needs } from '../auth.ts';
import { token } from '../entra.ts';
import { logins, saveLogin, type Offer } from '../logins.ts';
import type { Request, Type } from '../connections.ts';

// Microsoft Graph, as the runner, as far as the instance's ticks reach: /me/… or /users/ADDRESS/… for a mailbox's messages and
// folders, and its sendMail; /drives/ID/…, /shares/ID/…, /me/drive/… or /users/ADDRESS/drive/… for files, within a ticked folder,
// a ticked file, a ticked site's libraries or the runner's ticked OneDrive; and /sites/ID/… for a ticked site, under v1.0 or beta, as
// Graph reads a path, dot segments resolved. A write, a POST, PATCH, PUT or DELETE, reaches only what a read does: a file it makes,
// moves or copies lands within the ticks, mail goes out as the ticked mailbox it is sent from, and it shares nothing. A write's
// body is a JSON object, which the policy reads, but a file's content and mail as MIME, whose headers it reads. Its person's login is Microsoft 365's, 'm365', whose offers they add one at a time.

// Tests point this at a stand-in.
export const endpoints = { graph: 'https://graph.microsoft.com' };
export const scope = () => graphScopes.map(s => `https://graph.microsoft.com/${s}`);

// A GET's JSON, as a person; an error names what Microsoft said, such as no access to a mailbox.
export async function graph(email: string, path: string): Promise<any> {
  const r = await fetch(`${endpoints.graph}/v1.0${path}`, { headers: { authorization: `Bearer ${await token(email, 'm365', scope())}` }, signal: AbortSignal.timeout(120_000) });
  const j = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : {};
  if (r.status >= 300) throw new HttpError(r.status === 404 || r.status === 403 ? r.status : 502, `Microsoft Graph answered ${r.status} ${j.error?.code ?? ''}: ${j.error?.message ?? ''}`);
  return j;
}

// Mail as MIME, base64 as Graph takes it, goes out as its From, which Exchange reads its own way: so its headers parse cleanly, with
// one From holding one plain address, a display name allowed, which is the mailbox it is sent from, and nothing else names a sender.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+", ADDRESS = `${ATOM}(?:\\.${ATOM})*@${ATOM}(?:\\.${ATOM})*`;
const WORD = '(?:"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"|[A-Za-z0-9!#$%&\'*+/=?^_`{|}~\\x80-\\xff.-]+)';
const FROM = new RegExp(`^(?:(${ADDRESS})|(?:${WORD}(?:[ \\t]+${WORD})*[ \\t]*)?<(${ADDRESS})>)$`);
function mime(body: Buffer | undefined, box: string, bare: string) {
  const refuse = (why: string) => new HttpError(403, `${bare}: ${why}`);
  const b64 = body?.toString('latin1').replace(/[ \t\r\n]/g, '') ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4) throw refuse('mail is a JSON object, or MIME in base64 as text/plain');
  const lines = Buffer.from(b64, 'base64').toString('latin1').split(/\r?\n/), headers: [string, string][] = [];
  for (const line of lines.slice(0, lines.indexOf('') < 0 ? lines.length : lines.indexOf(''))) {
    if (/^[ \t]/.test(line) && headers.length && !/[\r\0]/.test(line)) headers.at(-1)![1] += line;
    else if (/^[!-9;-~]+:[^\r\0]*$/.test(line)) headers.push([line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]);
    else throw refuse(`its MIME header ${JSON.stringify(line.slice(0, 60))} doesn't parse`);
  }
  const named = (n: string) => headers.filter(([k]) => k === n).map(([, v]) => v);
  for (const n of ['Sender', 'Resent-From', 'Resent-Sender']) if (named(n.toLowerCase()).length) throw refuse(`its ${n} header would name another sender`);
  const from = named('from');
  if (from.length !== 1) throw refuse(`a message has one From header, not ${from.length}`);
  const m = FROM.exec(from[0].trim()), address = m?.[1] ?? m?.[2];
  if (!address || address.includes('=?')) throw refuse(`its From is one plain address, with a display name if any: not ${JSON.stringify(from[0])}`);
  if (address.toLowerCase() !== box) throw refuse(`mail from ${box} goes out as ${box}, not ${address}`);
}

// The offer that lets a request through, or why not; and, for files, their drive's own site, where the answer's Location is a
// link, as a file's content redirects to its download address.
async function check(runner: string, ticks: string[], { method, url, headers, json, body: raw }: Request): Promise<{ offer: string; redirect?: string }> {
  if (!/^\/(v1\.0|beta)\//.test(url.pathname)) throw new HttpError(403, `${url.pathname}: Microsoft Graph, under /v1.0/ or /beta/`);
  // Neither another method in a header, nor a Prefer that redeems a sharing link, which grants the runner access.
  if (Object.keys(headers).some(h => /^x-http-method/i.test(h)) || /redeemsharinglink/i.test(String(headers.prefer ?? ''))) throw new HttpError(403, 'no X-HTTP-Method header, and no Prefer that redeems a sharing link');
  const bare = url.pathname.replace(/^\/[^/]+/, ''), path = bare + url.search, segments = bare.split('/').slice(1).map(s => decodeURIComponent(s));
  // Each part a name, as the checks below read it: none empty, as a trailing / makes, and none holding / or \, or . or .., as %2F,
  // %5C and %2E%2E decode to, which Graph may read as more parts.
  if (segments.some(s => !s || /[/\\]/.test(s) || s === '.' || s === '..')) throw new HttpError(403, `${bare}: each part of the path is a name, none empty, with no / or \\ in it, nor . or ..`);
  // /me is the runner, and mailFolders('inbox') is mailFolders.
  const segs = segments[0].toLowerCase() === 'me' ? ['users', runner, ...segments.slice(1)] : segments;
  const [rawTop, id = '', rawPart = ''] = segs.map(s => s.replace(/\(.*$/, '')), top = rawTop.toLowerCase(), part = rawPart.toLowerCase();
  const resources = segs.join('/').split(':', 1)[0].split('/');
  if (resources.some(s => /(^|\.)(me|users|sites|drives|shares|items)\(/i.test(s))) throw new HttpError(403, `${bare}: name resources as /drives/ID or /items/ID, not with (...)`);
  // An action by its last dotted part, as Graph takes it qualified or not: send, graph.send and microsoft.graph.send alike.
  const write = method !== 'GET', actions = segs.map(s => s.replace(/\(.*$/, '').split('.').pop()!.toLowerCase()), action = actions.at(-1);
  // A link, an invitation, a permission, a mailbox's rule, a subscription's webhook or a label's change shares what is ticked, now or
  // as it comes; a OneNote copy puts it where its body says, which no tick covers.
  if (write && actions.some(a => ['createlink', 'invite', 'grant', 'permissions', 'messagerules', 'subscriptions', 'assignsensitivitylabel'].includes(a))) throw new HttpError(403, `${bare} would share it: nothing is shared, past the ticks or within them`);
  if (write && actions.some(a => ['copynotebook', 'copytonotebook', 'copytosection', 'copytosectiongroup'].includes(a))) throw new HttpError(403, `${bare} would copy it where no tick reaches`);
  const mailbox = top === 'users' && (part === 'messages' || part === 'mailfolders' || (write && actions[2] === 'sendmail'));
  const body = headers['transfer-encoding'] !== undefined || Number(headers['content-length'] ?? 0) > 0, object = typeof json === 'object' && json !== null;
  if (write && body && !object && !mailbox && !(method === 'PUT' && action === 'content')) throw new HttpError(403, `${bare}: a write's body is a JSON object, but a file's content, with PUT …/content, or mail as MIME`);
  let offer: string | undefined, mail = false, site: string | undefined;
  if (mailbox) {
    const scope = !write ? 'Mail.Read' : ['sendmail', 'send', 'reply', 'replyall', 'forward', 'unsubscribe'].includes(action!) ? 'Mail.Send' : 'Mail.ReadWrite';
    const what = { 'Mail.Read': ['read mail', 'read shared mailboxes'], 'Mail.Send': ['send mail', 'send from shared mailboxes'], 'Mail.ReadWrite': ['write mail', 'write to shared mailboxes'] }[scope];
    needs(scope, what[0]);
    if (id.toLowerCase() !== runner) needs(`${scope}.Shared`, what[1]);
    offer = `m365:mail:${id.toLowerCase()}`;
    mail = true;
    if (write && body && !object) mime(String(headers['content-type']).toLowerCase().startsWith('text/plain') ? raw : undefined, id.toLowerCase(), bare);
    const said = [json, ...keyed(json, 'message')].flatMap(m => [...keyed(m, 'from'), ...keyed(m, 'sender')]), at = (x: unknown) => keyed(x, 'emailaddress').flatMap(e => keyed(e, 'address'));
    if (said.some(x => !at(x).length || at(x).some(a => String(a).toLowerCase() !== id.toLowerCase()))) throw new HttpError(403, `${bare}: mail from ${id} goes out as ${id}`);
  } else if (top === 'drives' || top === 'shares' || (['users', 'sites'].includes(top) && part === 'drive') || (top === 'sites' && part === 'drives' && segs[3])) {
    needs(write ? 'Files.ReadWrite.All' : 'Files.Read.All', `${write ? 'save' : 'read'} OneDrive or SharePoint files`);
    // A share's site and list are the whole site and library its item is in, past what is ticked.
    // A drive's own search, recent, sharedWithMe and following list other drives' items too; a search under its root stays in it.
    const idx = top === 'sites' && part === 'drives' ? 4 : part === 'drive' ? 3 : 2, of = segs[idx] ?? '';
    if (top !== 'shares' && /(^|\.)(search|recent|sharedwithme|following)(\(|$)/i.test(of)) throw new HttpError(403, `${bare}: a drive's ${of.replace(/\(.*$/, '')} lists other drives' items too; search under its root, as /drives/ID/root/search(q='...')`);
    // An item by its own id, not as a child of a ticked one.
    if (actions.some((a, k) => a === 'children' && k < actions.length - 1) || segs.some(s => /(^|\.)children\(./i.test(s))) throw new HttpError(403, `${bare}: name an item by its own id, as /drives/ID/items/ITEM, not under another's children`);
    if (actions[idx] === 'items' && !segs[idx + 1]) throw new HttpError(403, `${bare}: name an item by its own id, as /drives/ID/items/ITEM`);
    if (top === 'shares' && !['', 'driveitem', 'root', 'items', 'listitem'].includes(part)) throw new HttpError(403, `${bare}: a share is read through its driveItem, root or items, not its ${rawPart}, which reaches past what is ticked`);
    const item = await located(runner, addressed(bare.replace(/^\/me(?=\/|$)/i, `/users/${runner}`)));
    offer = await covering(runner, ticks, item.parentReference.driveId, item.id, item.parentReference.id);
    if (!offer) throw new HttpError(403, `${bare} is in no folder, file or SharePoint site ticked for this instance`);
    site = (await siteOf(runner, item.parentReference.driveId)).split(',')[0];
  } else if (top === 'sites') {
    needs(!write ? 'Sites.Read.All' : part === 'drives' ? 'Files.ReadWrite.All' : 'Sites.ReadWrite.All', `${write ? 'write' : 'read'} SharePoint sites`);
    if (segments.some(s => /(^|\.)getbypath\(/i.test(s))) throw new HttpError(403, `${bare}: getByPath reaches any site by its path; read the ticked one by its id`);
    if (actions[2] === 'sites') throw new HttpError(403, `${bare}: a site's subsites are ticked by themselves`);
    if (actions.slice(3).some(a => a === 'drive' || a === 'drives')) throw new HttpError(403, `${bare}: read a library's files through /drives/ID or /sites/ID/drives/ID`);
    offer = `m365:site:${id}`;
  } else throw new HttpError(403, `the graph connection reaches mailboxes, and folders, files and SharePoint sites ticked for this instance, not ${path}`);
  // A link, an invitation, a permission or a mailbox's rule shares what is ticked, now or as it comes.
  if (write && !mail) {
    // A move, a copy or a restore names its folder in the body, which a tick covers too.
    const tos = keyed(json, 'parentreference');
    if (tos.length > 1 || tos.some(t => keyed(t, 'path').length || keyed(t, 'id').length !== 1 || keyed(t, 'driveid').length > 1)) throw new HttpError(403, `${bare}: name the folder by its parentReference's id, and driveId for another drive, each once`);
    if (tos.length) {
      const [to] = keyed(tos[0], 'id'), drive = keyed(tos[0], 'driveid')[0] ?? (await graph(runner, `${method === 'PATCH' ? bare : bare.replace(/\/[^/]+$/, '')}?$select=parentReference`)).parentReference.driveId;
      const folder = await graph(runner, `/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(to)}?$select=id,parentReference`);
      if (!await covering(runner, ticks, folder.parentReference.driveId, folder.id, folder.parentReference.id)) throw new HttpError(403, `${bare} would put it in a folder no tick covers`);
    }
  }
  return { offer, redirect: site && `https://${site}` };
}

// Links an answer gives, which the run may then use as they are, read from the path as check() reads it: an upload session's, from
// the answer that makes one, at Outlook's host for mail and SharePoint's for files; and a file's download address, on the
// driveItems an answer about files gives that a tick covers, at its drive's own site's host, as is the one its content redirects
// to (check); never what a file's or a message's content holds.
async function links(j: any, path: string, email: string, ticks: string[]): Promise<string[]> {
  const parts = path.replace(/^\/[^/]+/, '').split('/').slice(1).map(s => decodeURIComponent(s).replace(/\(.*$/, '').split('.').pop()!.toLowerCase());
  const [top, , part] = parts[0] === 'me' ? ['users', '', ...parts.slice(1)] : parts, action = parts.at(-1)!, url = (u: unknown): u is string => typeof u === 'string' && URL.canParse(u);
  if (action === 'createuploadsession') return [j?.uploadUrl].filter(u => url(u) && (parts.includes('attachments') ? /^https:\/\/outlook\.office(365)?\.com\//i : /^https:\/\/([\w-]+\.)*(sharepoint\.com|svc\.ms)\//i).test(u));
  if (!['drives', 'shares'].includes(top) && !['drive', 'drives'].includes(part) || ['content', '$value'].includes(action)) return [];
  const items = [j, ...(Array.isArray(j?.value) ? j.value : [])].filter(i => url(i?.['@microsoft.graph.downloadUrl']));
  const at = await Promise.all(items.map(async i => new URL(i['@microsoft.graph.downloadUrl']).origin === `https://${(await siteOf(email, i.parentReference?.driveId)).split(',')[0]}`
    && !!await covering(email, ticks, i.parentReference.driveId, i.id, i.parentReference.id)));
  return items.filter((_, k) => at[k]).map(i => i['@microsoft.graph.downloadUrl']);
}

export default {
  settings: () => ({}),
  login: () => ({ id: 'm365', kind: 'm365', name: 'Microsoft 365', scope: scope() }),
  hosts: () => ['graph.microsoft.com'],
  check: (_, runner, ticks, r) => check(runner, ticks, r),
  links,
} satisfies Type;

// A JSON object's values for a key, in any case, as Graph reads keys: each, where several cases of it are there.
const keyed = (o: unknown, k: string): any[] => o && typeof o === 'object' ? Object.entries(o).filter(([n]) => n.toLowerCase() === k).map(([, v]) => v) : [];

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
  const m = /^(\/(?:drives|shares)\/[^/]+|\/sites\/[^/]+\/drives\/[^/]+|\/(?:users|sites)\/[^/]+\/drive(?=\/|$))(\/(?:root|driveItem|items\/[^/:]+)(?::[^:]*:?)?)?/i.exec(path)!;
  return m[1] + (m[2]?.replace(/(:[^:]*[^:])$/, '$1:') ?? (/^\/shares\//i.test(m[1]) ? '/driveItem' : '/root'));
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

// What Graph says doesn't change often: who an item's parent is, for 5 minutes; whose a drive is, and which site's, for good once
// Graph answers. A parent the person can't read ends the climb, as does a drive whose site they can't see.
const parents = new Map<string, { parent?: string; at: number }>(), sites = new Map<string, string>(), own = new Map<string, string>();
async function parentOf(email: string, driveId: string, id: string): Promise<string | undefined> {
  const k = `${driveId}/${id}`, known = parents.get(k);
  if (known && known.at > Date.now() - 300_000) return known.parent;
  const parent = await graph(email, `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}?$select=parentReference`).then(j => j.parentReference?.id, e => {
    if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return undefined;
    throw e;
  });
  parents.set(k, { parent, at: Date.now() });
  return parent;
}
async function siteOf(email: string, driveId: string): Promise<string> {
  if (!sites.has(driveId)) {
    const d = await graph(email, `/drives/${encodeURIComponent(driveId)}?$select=sharePointIds`).catch(e => {
      if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return undefined;
      throw e;
    }), s = d?.sharePointIds;
    if (!d) return '';
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
  const v = add.trim();
  if (!logins(email).some(l => l.id === 'm365')) throw new HttpError(409, 'connect Microsoft 365 first');
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
    const link = id ? u.origin + (id.startsWith('/') ? '' : '/') + id.split('/').map(encodeURIComponent).join('/') : /^\/:\w:\/r\//.test(u.pathname) ? u.origin + u.pathname.replace(/^\/:\w:\/r/, '') : v;
    const path = new URL(link).pathname.replace(/\/$/, '');
    if (/^\/(sites|teams)\/[^/]+$/.test(path)) {
      needs('Sites.Read.All', 'read SharePoint sites');
      const site = await graph(email, `/sites/${u.hostname}:${path}`);
      o = { id: `m365:site:${site.id}`, name: `Site ${site.displayName ?? path}` };
    } else {
      needs('Files.Read.All', 'read OneDrive or SharePoint files');
      const item = await graph(email, `/shares/u!${Buffer.from(link).toString('base64url')}/driveItem?$select=id,name,root,folder,parentReference`);
      const d = await graph(email, `/drives/${encodeURIComponent(item.parentReference.driveId)}?$select=driveType,owner,sharePointIds`).catch(e => {
        if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return undefined;
        throw e;
      }), s = d?.sharePointIds, driveType = d?.driveType ?? item.parentReference.driveType;
      const siteName = s ? await graph(email, `/sites/${new URL(s.siteUrl).hostname},${s.siteId},${s.webId}?$select=displayName`).then(x => x.displayName as string, e => {
        if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return undefined;
        throw e;
      }) : undefined;
      const where = ['business', 'personal'].includes(driveType) ? `${d?.owner?.user?.displayName ?? 'Someone'}'s OneDrive`
        : siteName ?? (s?.siteUrl ? decodeURIComponent(new URL(s.siteUrl).pathname.split('/').filter(Boolean).pop() ?? '') || new URL(s.siteUrl).hostname : u.hostname);
      o = { id: `m365:item:${item.parentReference.driveId}/${item.id}`, name: item.root ? where : `${item.folder ? 'Folder' : 'File'} ${item.name}, ${where}` };
    }
  }
  const login = logins(email).find(l => l.id === 'm365');
  if (login) saveLogin(email, { ...login, offers: [...login.offers.filter(x => x.id !== o.id), o] });
}
