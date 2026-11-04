import { HttpError } from '../store.ts';
import { token } from '../entra.ts';
import { logins, saveLogin } from '../logins.ts';
import { upstreams, type Connection, type Request, type Type } from '../connections.ts';

// Azure Databricks, as the runner, on the SQL warehouses ticked for the instance: each an offer its person adds by its link,
// `NAME:HOST/ID`, its workspace's host and its id, checked by reading it as them. A statement, POST /api/2.0/sql/statements, runs on
// a ticked warehouse, named as its warehouse_id, whatever it does, as the runner's own Unity Catalog grants allow; its status,
// results and cancel, and the Unity Catalog API, go to a workspace one is ticked on. Its person's login is the connection's own, by
// its name, for the Azure Databricks resource.
const STATEMENTS = '/api/2.0/sql/statements', WORKSPACE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.azuredatabricks\.net$/;
const scope = ['2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/user_impersonation'];

function check(c: Connection, ticks: string[], { method, url, json }: Request): { offer: string } {
  const p = url.pathname.replace(/\/$/, ''), at = `${c.name}:${url.host}`;
  if (method === 'POST' && p === STATEMENTS && !json?.warehouse_id)
    throw new HttpError(403, `a statement names its warehouse_id, one ticked for the instance: ${ticks.filter(t => t.startsWith(`${at}/`)).map(t => t.split('/')[1]).join(', ') || 'none is'}`);
  if (method === 'POST' && p === STATEMENTS) return { offer: `${at}/${json.warehouse_id}` };
  if ((method === 'GET' && new RegExp(`^${STATEMENTS}/[\\w-]+(/result/chunks/\\d+)?$`).test(p)) || (method === 'POST' && new RegExp(`^${STATEMENTS}/[\\w-]+/cancel$`).test(p))
    || p.startsWith('/api/2.1/unity-catalog/')) return { offer: ticks.find(t => t.startsWith(`${at}/`)) ?? at };
  throw new HttpError(403, `${method} ${p}: ${c.name} takes statements, ${STATEMENTS}, and the Unity Catalog API, /api/2.1/unity-catalog/…`);
}

// A statement result's external links, chunks the run then fetches as they are, with no credential: https, to Azure's storage.
const links = (j: any, path: string): string[] => !path.startsWith('/api/2.0/sql/statements') ? [] : [...(j?.result?.external_links ?? []), ...(j?.external_links ?? [])]
  .map(l => l?.external_link).filter(u => typeof u === 'string' && /^https:\/\/[\w-]+\.(blob|dfs)\.core\.windows\.net\//i.test(u));

// A SQL warehouse its person adds to their Databricks login by its link, such as its page's, checked by reading it as them.
export async function addWarehouse(email: string, id: string, add: string) {
  const login = logins(email).find(l => l.id === id && l.kind === 'databricks'), u = URL.parse(add.trim()), warehouse = /\/warehouses\/([\w-]+)/.exec(u?.pathname ?? '')?.[1];
  if (!login) throw new HttpError(409, `connect ${id} first`);
  if (!u || !WORKSPACE.test(u.hostname) || !warehouse) throw new HttpError(400, 'a link to a SQL warehouse of an Azure Databricks workspace, such as https://adb-123.4.azuredatabricks.net/sql/warehouses/1a2b3c4d5e6f7a8b');
  const r = await fetch(`${upstreams[u.hostname] ?? `https://${u.hostname}`}/api/2.0/sql/warehouses/${warehouse}`, { headers: { authorization: `Bearer ${await token(email, id, scope)}` }, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 403 || r.status === 404 ? r.status : 502, `Databricks answered ${r.status} ${j.error_code ?? ''}: ${j.message ?? ''}`);
  const o = { id: `${id}:${u.hostname}/${warehouse}`, name: `Warehouse ${j.name ?? warehouse}, ${u.hostname}` };
  saveLogin(email, { ...login, offers: [...login.offers.filter(x => x.id !== o.id), o] });
}

export default {
  settings: () => ({}),
  login: c => ({ id: c.name, kind: 'databricks', name: `Databricks ${c.name}`, scope }),
  serves: (_, host) => WORKSPACE.test(host),
  check: async (c, _runner, ticks, r) => check(c, ticks, r),
  links,
  // The first warehouse ticked, for its CLI and SDK; the ticks name any others.
  env: (c, ticks) => {
    const [host, warehouse] = ticks.find(t => t.startsWith(`${c.name}:`))?.slice(c.name.length + 1).split('/') ?? [];
    return { DATABRICKS_TOKEN: 'rf', ...(host && { DATABRICKS_HOST: `https://${host}`, DATABRICKS_WAREHOUSE_ID: warehouse }) };
  },
} satisfies Type;
