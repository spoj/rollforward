import { writeFileSync } from 'node:fs';
import { HttpError } from './store.ts';
import { saveNew } from './flow.ts';
import { attachments, children, download, graph, messages, shared, token, type DriveItem } from './graph.ts';
import type { System } from './systems.ts';

// The agent's reads through the Microsoft 365 connections, for skills to build on. They only read, as graph.ts only sends GETs:
//   rf files list LINK|REF            a OneDrive or SharePoint item by its sharing link or a ref from an earlier listing: the item, its
//                                      parent's ref (to step to a sibling, such as another year's folder) and, for a folder, its items
//   rf files get LINK|REF FILE        saves a file under working/
//   rf mail find [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments]
//                                      the connection's one mailbox; the agent can't name another, and never reads a message's body
//   rf mail save ID [--name REGEX] [--prefix TEXT]   saves a message's attachments under working/

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

async function item(s: System, linkOrRef: string): Promise<DriveItem> {
  if (/^https?:\/\//i.test(linkOrRef)) return shared(s, linkOrRef);
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(linkOrRef);
  if (!m) throw new HttpError(400, 'give a sharing link (https://…) or a ref from rf files list');
  const found: DriveItem = await graph(s, `/drives/${encodeURIComponent(m[1])}/items/${encodeURIComponent(m[2])}`);
  return { ...found, parentReference: { ...found.parentReference, driveId: found.parentReference?.driveId ?? m[1] } };
}

const describe = (i: DriveItem) => ({ name: i.name, ref: refOf(i), folder: !!i.folder, size: i.size, modified: i.lastModifiedDateTime });

export async function filesList(s: System, target: string) {
  const it = await item(s, target);
  const parent = it.parentReference.id ? `${it.parentReference.driveId}/${it.parentReference.id}` : null;
  return { ...describe(it), parent, ...(it.folder && { items: (await children(s, it)).map(describe) }) };
}

export async function filesGet(s: System, target: string, path: string): Promise<{ name: string; size: number; modified: string }> {
  const it = await item(s, target);
  if (it.folder) throw new HttpError(400, `${it.name} is a folder; rf files list shows what is in it`);
  const bytes = await download(s, it);
  writeFileSync(path, bytes);
  return { name: it.name, size: bytes.length, modified: it.lastModifiedDateTime };
}

export async function mailFind(s: System, args: Args) {
  const mailbox = s.settings?.mailbox;
  if (!mailbox) throw new HttpError(409, `${s.name} has no mailbox set`);
  const d = args.date?.[0] ?? localDate(), subject = args.subject?.[0]?.toLowerCase(), from = args.from?.[0]?.toLowerCase();
  const found = (await messages(s, mailbox, day(d), day(d, 1)))
    .filter(m => (!subject || (m.subject ?? '').toLowerCase().includes(subject))
      && (!from || `${m.from?.emailAddress?.address ?? ''} ${m.from?.emailAddress?.name ?? ''}`.toLowerCase().includes(from))
      && (!args.attachments || m.hasAttachments));
  return { mailbox, date: d, messages: found.map(m => ({ id: m.id, subject: m.subject, received: m.receivedDateTime, from: m.from?.emailAddress?.address, attachments: m.hasAttachments })) };
}

// Saves the attachments whose names match into working/ (`dir`), each named `prefix` + its own name, never over a file already there.
export async function mailSave(s: System, id: string, name: RegExp | undefined, dir: string, prefix = ''): Promise<string[]> {
  const mailbox = s.settings?.mailbox;
  if (!mailbox) throw new HttpError(409, `${s.name} has no mailbox set`);
  return (await attachments(s, mailbox, id)).filter(a => !name || name.test(a.name)).map(a => saveNew(dir, prefix + a.name, a.bytes));
}

// Systems page Test: each reads something real, so a missing permission shows up as Microsoft's own error.
export async function testM365(s: System): Promise<string> {
  if (s.id === 'm365-mail' || s.settings?.mailbox) {
    const d = process.env.RF_TODAY ?? localDate(), found = await messages(s, s.settings!.mailbox, day(d), day(d, 1));
    return `Read ${s.settings!.mailbox}: ${found.length} message${found.length === 1 ? '' : 's'} on ${d}.`;
  }
  const link = s.settings?.test_link;
  if (!link) {
    await token(s);
    return 'Microsoft gave the app a token. Set a test link to check it can read a folder.';
  }
  const it = await shared(s, link);
  return `Read ${it.name} on OneDrive${it.folder ? `, a folder of ${(await children(s, it)).length} items` : ''}.`;
}
