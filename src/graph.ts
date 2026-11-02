import { HttpError } from './store.ts';
import { refreshM365 } from './auth.ts';
import { logins, saveLogin, secret } from './logins.ts';

// Microsoft Graph as a person, through their delegated, read-only Microsoft 365 login (logins.ts): each access token comes from the
// login's sealed refresh token, which turns over as it's used and is sealed again. A login Microsoft no longer renews is marked
// expired, for its person to sign in again on the Logins page.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const tokens = new Map<string, { token: string; exp: number }>();
// Tests point this at a stand-in.
export const endpoints = { graph: GRAPH };

export async function token(email: string): Promise<string> {
  const t = tokens.get(email);
  if (t && t.exp > Date.now()) return t.token;
  const login = logins(email).find(l => l.id === 'm365');
  if (!login || login.expired) throw new HttpError(409, `${email} has no current Microsoft 365 login: they sign in to it on the Logins page`);
  try {
    const r = await refreshM365(secret(email, 'm365'));
    saveLogin(email, login, r.refresh);
    tokens.set(email, { token: r.access, exp: r.expires });
    return r.access;
  } catch (e) {
    if ((e as HttpError).status !== 401) throw e;
    saveLogin(email, { ...login, expired: true });
    throw new HttpError(409, `${email}'s Microsoft 365 login has expired: they sign in to it again on the Logins page`);
  }
}

// One Graph request; an error names what Microsoft said, such as no access to a mailbox. Only ever a GET: nothing here can change
// or delete a file or a message.
export async function graph(email: string, path: string, accept = 'json'): Promise<any> {
  const r = await fetch(path.startsWith('http') ? path : endpoints.graph + path, { method: 'GET', headers: { authorization: `Bearer ${await token(email)}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new HttpError(r.status === 404 || r.status === 403 ? r.status : 502, `Microsoft Graph answered ${r.status} ${j.error?.code ?? ''}: ${j.error?.message ?? r.statusText}`);
  }
  return accept === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
}

export type DriveItem = { id: string; name: string; size?: number; folder?: unknown; file?: { mimeType?: string }; lastModifiedDateTime: string; createdDateTime?: string; parentReference: { driveId: string; id?: string; driveType?: string; siteId?: string } };

// The file or folder a OneDrive or SharePoint sharing link points at.
export function shared(email: string, link: string): Promise<DriveItem> {
  const encoded = 'u!' + Buffer.from(link.trim()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return graph(email, `/shares/${encoded}/driveItem`);
}

export async function children(email: string, item: { id: string; parentReference: { driveId: string } }): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  for (let next: string | undefined = `/drives/${item.parentReference.driveId}/items/${item.id}/children?$top=200`; next;) {
    const page = await graph(email, next);
    out.push(...page.value.map((i: DriveItem) => ({ ...i, parentReference: { ...i.parentReference, driveId: i.parentReference?.driveId ?? item.parentReference.driveId } })));
    next = page['@odata.nextLink'];
  }
  return out;
}

export async function parent(email: string, item: DriveItem): Promise<DriveItem> {
  return graph(email, `/drives/${item.parentReference.driveId}/items/${item.parentReference.id}`);
}

export function download(email: string, item: DriveItem): Promise<Buffer> {
  return graph(email, `/drives/${item.parentReference.driveId}/items/${item.id}/content`, 'bytes');
}

export type Message = { id: string; subject: string; receivedDateTime: string; hasAttachments: boolean; from?: { emailAddress?: { address?: string; name?: string } }; bodyPreview?: string; body?: { content?: string } };

// A mailbox's messages received in [from, to), newest first.
export async function messages(email: string, mailbox: string, from: Date, to: Date, withBody = false): Promise<Message[]> {
  const filter = `receivedDateTime ge ${from.toISOString()} and receivedDateTime lt ${to.toISOString()}`;
  const select = `id,subject,receivedDateTime,hasAttachments,from,bodyPreview${withBody ? ',body' : ''}`;
  const out: Message[] = [];
  for (let next: string | undefined = `/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc&$select=${select}&$top=100`; next && out.length < 500;) {
    const page = await graph(email, next);
    out.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return out;
}

export async function attachments(email: string, mailbox: string, message: string): Promise<{ name: string; contentType: string; bytes: Buffer }[]> {
  const page = await graph(email, `/users/${encodeURIComponent(mailbox)}/messages/${message}/attachments`);
  return page.value.filter((a: any) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map((a: any) => ({ name: a.name, contentType: a.contentType, bytes: Buffer.from(a.contentBytes ?? '', 'base64') }));
}
