import { HttpError } from './store.ts';
import { password, type System } from './systems.ts';

// Microsoft Graph, as an app registered in Entra ID with its own permissions (client credentials): OneDrive and SharePoint files
// reached by their sharing links, and a mailbox's mail. The client secret stays in the server.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const tokens = new Map<string, { token: string; exp: number; sealed: string }>();
// Tests point these at a stand-in.
export const endpoints = { login: 'https://login.microsoftonline.com', graph: GRAPH };

export async function token(s: System): Promise<string> {
  const t = tokens.get(s.id);
  if (t && t.exp > Date.now() && t.sealed === s.password) return t.token;
  const r = await fetch(`${endpoints.login}/${s.tenant}/oauth2/v2.0/token`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.client_id!, client_secret: password(s), scope: 'https://graph.microsoft.com/.default' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new HttpError(502, `${s.name}: Microsoft did not give the app a token: ${(j.error_description ?? j.error ?? r.status).toString().split('\r\n')[0]}`);
  tokens.set(s.id, { token: j.access_token, exp: Date.now() + (Number(j.expires_in ?? 3600) - 120) * 1000, sealed: s.password! });
  return j.access_token;
}

// One Graph request; an error names what Microsoft said, such as a missing permission. Only ever a GET: tools read OneDrive and
// mail, and nothing here can change or delete a file or a message, whatever the app itself is allowed.
export async function graph(s: System, path: string, accept = 'json'): Promise<any> {
  const r = await fetch(path.startsWith('http') ? path : endpoints.graph + path, { method: 'GET', headers: { authorization: `Bearer ${await token(s)}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const hint = r.status === 403 || r.status === 401 ? ' (the app may lack the permission, or admin consent, for this)' : '';
    throw new HttpError(502, `${s.name}: Microsoft Graph answered ${r.status} ${j.error?.code ?? ''}: ${j.error?.message ?? r.statusText}${hint}`);
  }
  return accept === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
}

export type DriveItem = { id: string; name: string; size?: number; folder?: unknown; file?: { mimeType?: string }; lastModifiedDateTime: string; createdDateTime?: string; parentReference: { driveId: string; id?: string } };

// The file or folder a OneDrive or SharePoint sharing link points at.
export function shared(s: System, link: string): Promise<DriveItem> {
  const encoded = 'u!' + Buffer.from(link.trim()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return graph(s, `/shares/${encoded}/driveItem`);
}

export async function children(s: System, item: { id: string; parentReference: { driveId: string } }): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  for (let next: string | undefined = `/drives/${item.parentReference.driveId}/items/${item.id}/children?$top=200`; next;) {
    const page = await graph(s, next);
    out.push(...page.value.map((i: DriveItem) => ({ ...i, parentReference: { ...i.parentReference, driveId: i.parentReference?.driveId ?? item.parentReference.driveId } })));
    next = page['@odata.nextLink'];
  }
  return out;
}

export async function parent(s: System, item: DriveItem): Promise<DriveItem> {
  return graph(s, `/drives/${item.parentReference.driveId}/items/${item.parentReference.id}`);
}

export function download(s: System, item: DriveItem): Promise<Buffer> {
  return graph(s, `/drives/${item.parentReference.driveId}/items/${item.id}/content`, 'bytes');
}

export type Message = { id: string; subject: string; receivedDateTime: string; hasAttachments: boolean; from?: { emailAddress?: { address?: string; name?: string } }; bodyPreview?: string; body?: { content?: string } };

// A mailbox's messages received in [from, to), newest first.
export async function messages(s: System, mailbox: string, from: Date, to: Date, withBody = false): Promise<Message[]> {
  const filter = `receivedDateTime ge ${from.toISOString()} and receivedDateTime lt ${to.toISOString()}`;
  const select = `id,subject,receivedDateTime,hasAttachments,from,bodyPreview${withBody ? ',body' : ''}`;
  const out: Message[] = [];
  for (let next: string | undefined = `/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc&$select=${select}&$top=100`; next && out.length < 500;) {
    const page = await graph(s, next);
    out.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return out;
}

export async function attachments(s: System, mailbox: string, message: string): Promise<{ name: string; contentType: string; bytes: Buffer }[]> {
  const page = await graph(s, `/users/${encodeURIComponent(mailbox)}/messages/${message}/attachments`);
  return page.value.filter((a: any) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map((a: any) => ({ name: a.name, contentType: a.contentType, bytes: Buffer.from(a.contentBytes ?? '', 'base64') }));
}

// Waits for a sign-in code mailed after `since` by a sender or with a subject matching `match`, checking every few seconds; the
// newest matching message's first run of `digits` digits is the code, skipping codes already `used` (a site that asks twice mails
// twice). Returns null if none comes in time.
export async function waitForCode(s: System, mailbox: string, since: Date, match: RegExp, timeoutMs: number, digits = '4,8', used = new Set<string>()): Promise<string | null> {
  const until = Date.now() + timeoutMs, code = new RegExp(`(?<![\\d])(\\d{${digits}})(?![\\d])`);
  while (Date.now() < until) {
    const found = (await messages(s, mailbox, new Date(since.getTime() - 5000), new Date(Date.now() + 60_000), true))
      .filter(m => match.test(`${m.from?.emailAddress?.address ?? ''} ${m.from?.emailAddress?.name ?? ''} ${m.subject ?? ''}`));
    for (const m of found) {
      const text = `${m.subject ?? ''}\n${(m.body?.content ?? m.bodyPreview ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')}`;
      const c = code.exec(text);
      if (c && !used.has(c[1])) return c[1];
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  return null;
}
