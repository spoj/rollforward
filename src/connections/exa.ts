import { HttpError } from '../store.ts';
import type { Request } from '../connections.ts';

// Exa, web search and pages' contents, one of the server's own connections (connections.ts). It takes POST /search, /contents,
// /findSimilar and /answer, each with a JSON object, and nothing else.
export const name = 'exa', host = 'api.exa.ai', key = 'EXA_API_KEY';
const PATHS = ['/search', '/contents', '/findSimilar', '/answer'];

export function check({ method, url, json }: Request): unknown {
  const p = url.pathname.replace(/\/$/, '');
  if (method !== 'POST' || !PATHS.includes(p)) throw new HttpError(403, `${method} ${p}: exa takes POST ${PATHS.join(', ')}`);
  if (typeof json !== 'object' || json === null) throw new HttpError(403, `${p}: its body is a JSON object, sent as application/json`);
  return json;
}

export const cost = (j: any): number | undefined => j.costDollars?.total;
