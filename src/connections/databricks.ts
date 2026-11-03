import { HttpError } from '../store.ts';
import type { Connection, Request, Type } from '../connections.ts';

// A Databricks workspace, `host`, whose SQL warehouse, `warehouse`, runs statements as the runner, with their own Unity Catalog
// grants. Statements go to /api/2.0/sql/statements, on that warehouse, and only read for now: a statement's first word, past
// comments, is one of READS. The catalogue is read with GET /api/2.1/unity-catalog/…. Its person's login is the connection's
// own, by its name, for the Azure Databricks resource.
const READS = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES'];
const STATEMENTS = '/api/2.0/sql/statements';

function check(c: Connection, { method, url, json }: Request): { offer: string; json?: unknown } {
  const p = url.pathname.replace(/\/$/, '');
  if (method === 'POST' && p === STATEMENTS) {
    const first = String(json?.statement ?? '').replace(/^(\s+|--[^\n]*|\/\*[\s\S]*?\*\/)*/, '').match(/^\w*/)![0].toUpperCase();
    if (!READS.includes(first)) throw new HttpError(403, `${c.name} only reads: a statement starts with ${READS.join(', ')}, not ${first || 'nothing'}`);
    if (json.warehouse_id && json.warehouse_id !== c.warehouse) throw new HttpError(403, `${c.name} runs statements on its warehouse, ${c.warehouse}`);
    return { offer: c.name, json: { ...json, warehouse_id: c.warehouse } };
  }
  if ((method === 'GET' && new RegExp(`^${STATEMENTS}/[\\w-]+(/result/chunks/\\d+)?$`).test(p)) || (method === 'POST' && new RegExp(`^${STATEMENTS}/[\\w-]+/cancel$`).test(p))
    || (method === 'GET' && p.startsWith('/api/2.1/unity-catalog/'))) return { offer: c.name };
  throw new HttpError(403, `${method} ${p}: ${c.name} takes statements, ${STATEMENTS}, and reads of the catalogue, GET /api/2.1/unity-catalog/…`);
}

// A result's external links, chunks the run then fetches as they are, with no credential.
const links = (j: unknown): string[] => !j || typeof j !== 'object' ? [] : Object.entries(j).flatMap(([k, v]) => k === 'external_link' && typeof v === 'string' ? [v] : links(v));

export default {
  settings(input) {
    if (typeof input.host !== 'string' || !/^[a-z0-9.-]+$/i.test(input.host)) throw new HttpError(400, 'host: the workspace\'s host, such as adb-123.4.azuredatabricks.net');
    if (typeof input.warehouse !== 'string' || !/^[\w-]+$/.test(input.warehouse)) throw new HttpError(400, 'warehouse: its SQL warehouse\'s id, such as 221d2e6bf7c7eebe');
    return { host: input.host.toLowerCase(), warehouse: input.warehouse };
  },
  login: c => ({ id: c.name, kind: 'databricks', name: `Databricks ${c.name}`, scope: ['2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/user_impersonation'], offers: [{ id: c.name, name: `Databricks ${c.name}, warehouse ${c.warehouse}` }] }),
  host: c => c.host,
  check: async (c, _runner, _ticks, r) => check(c, r),
  links,
  env: c => ({ DATABRICKS_HOST: `https://${c.host}`, DATABRICKS_TOKEN: 'rf' }),
} satisfies Type;
