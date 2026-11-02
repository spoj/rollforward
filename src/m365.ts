import { HttpError, type Instance } from './store.ts';
import { attachments, children, download, graph, messages, shared, type DriveItem } from './graph.ts';
import { logins, runnerOf, saveLogin, use } from './logins.ts';

// The agent's reads through its runner's Microsoft 365 login, for skills to build on, each refused unless the instance's ticks
// offer it. They only read, as graph.ts only sends GETs:
//   rf files list LINK|REF            a OneDrive or SharePoint item by its sharing link or a ref from an earlier listing: the item, its
//                                      parent's ref (to step to a sibling, such as another year's folder) and, for a folder, its items;
//                                      in the runner's own OneDrive or a SharePoint site, if ticked
//   rf files get LINK|REF FILE        saves a file under working/
//   rf mail find [--mailbox ADDRESS] [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments]
//                                      a ticked mailbox, the runner's own unless named; never a message's body
//   rf mail save ID [--mailbox ADDRESS] [--name REGEX] [--prefix TEXT]   saves a message's attachments under working/

export type Args = Record<string, string[]>;

export const localDate = (d = new Date()) => d.toLocaleDateString('sv');

// Local midnight of a YYYY-MM-DD day, plus `days`.
export function day(date: string, days = 0): Date {
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new HttpError(400, `a date is YYYY-MM-DD, not ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d + days);
}

// A ref is "driveId/itemId": drive ids hold "!" but never "/".
const refOf = (i: DriveItem) => `${i.parentReference.driveId}/${i.id}`;

const own = new Map<string, string>();
async function ownDrive(email: string): Promise<string> {
  if (!own.has(email)) own.set(email, (await graph(email, '/me/drive')).id);
  return own.get(email)!;
}

// The item a link or ref names, if the instance's ticks offer where it lives: the runner's own OneDrive, or a SharePoint site.
async function item(inst: Instance, linkOrRef: string): Promise<{ email: string; it: DriveItem }> {
  const email = runnerOf(inst).by;
  let it: DriveItem;
  if (/^https?:\/\//i.test(linkOrRef)) it = await shared(email, linkOrRef);
  else {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(linkOrRef);
    if (!m) throw new HttpError(400, 'give a sharing link (https://…) or a ref from rf files list');
    const found: DriveItem = await graph(email, `/drives/${encodeURIComponent(m[1])}/items/${encodeURIComponent(m[2])}`);
    it = { ...found, parentReference: { ...found.parentReference, driveId: found.parentReference?.driveId ?? m[1] } };
  }
  const p = it.parentReference, where = p.driveId === await ownDrive(email) ? 'm365:onedrive' : p.driveType === 'documentLibrary' ? `m365:site:${p.siteId}` : '';
  if (!where) throw new HttpError(403, `${it.name} is in someone else's OneDrive; a run reads only its runner's own OneDrive and the SharePoint sites ticked for it`);
  use(inst, where);
  return { email, it };
}

const describe = (i: DriveItem) => ({ name: i.name, ref: refOf(i), folder: !!i.folder, size: i.size, modified: i.lastModifiedDateTime });

export async function filesList(inst: Instance, target: string) {
  const { email, it } = await item(inst, target);
  const parent = it.parentReference.id ? `${it.parentReference.driveId}/${it.parentReference.id}` : null;
  return { ...describe(it), parent, ...(it.folder && { items: (await children(email, it)).map(describe) }) };
}

export async function filesGet(inst: Instance, target: string): Promise<{ name: string; size: number; modified: string; bytes: Buffer }> {
  const { email, it } = await item(inst, target);
  if (it.folder) throw new HttpError(400, `${it.name} is a folder; rf files list shows what is in it`);
  const bytes = await download(email, it);
  return { name: it.name, size: bytes.length, modified: it.lastModifiedDateTime, bytes };
}

// The mailbox a run reads: the one named, else its runner's own, if ticked.
function mailbox(inst: Instance, args: Args): { email: string; mailbox: string } {
  const mailbox = (args.mailbox?.[0] ?? runnerOf(inst).by).toLowerCase();
  return { email: use(inst, `m365:mail:${mailbox}`).email, mailbox };
}

export async function mailFind(inst: Instance, args: Args) {
  const { email, mailbox: box } = mailbox(inst, args);
  const d = args.date?.[0] ?? localDate(), subject = args.subject?.[0]?.toLowerCase(), from = args.from?.[0]?.toLowerCase();
  const found = (await messages(email, box, day(d), day(d, 1)))
    .filter(m => (!subject || (m.subject ?? '').toLowerCase().includes(subject))
      && (!from || `${m.from?.emailAddress?.address ?? ''} ${m.from?.emailAddress?.name ?? ''}`.toLowerCase().includes(from))
      && (!args.attachments || m.hasAttachments));
  return { mailbox: box, date: d, messages: found.map(m => ({ id: m.id, subject: m.subject, received: m.receivedDateTime, from: m.from?.emailAddress?.address, attachments: m.hasAttachments })) };
}

// The message's attachments whose names match.
export async function mailSave(inst: Instance, args: Args, id: string, name: RegExp | undefined): Promise<{ name: string; bytes: Buffer }[]> {
  const { email, mailbox: box } = mailbox(inst, args);
  return (await attachments(email, box, id)).filter(a => !name || name.test(a.name));
}

// What a person's Microsoft 365 login offers besides their own mailbox and OneDrive: a shared mailbox they can read, or a SharePoint
// site by a link to it, each checked by reading it as them.
export async function offer(email: string, what: { mailbox?: string; site?: string }): Promise<void> {
  const login = logins(email).find(l => l.id === 'm365');
  if (!login) throw new HttpError(409, 'connect Microsoft 365 first');
  let add;
  if (what.mailbox) {
    const box = what.mailbox.trim().toLowerCase();
    if (!/^[^@\s/]+@[^@\s/]+$/.test(box)) throw new HttpError(400, `not a mailbox address: ${box}`);
    await graph(email, `/users/${encodeURIComponent(box)}/mailFolders/inbox`);
    add = { id: `m365:mail:${box}`, name: `Mailbox ${box}` };
  } else {
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
