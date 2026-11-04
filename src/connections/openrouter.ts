import { HttpError } from '../store.ts';
import type { Request } from '../connections.ts';

// OpenRouter, any model and any request, with the server's key or its runner's own, one of the server's own connections
// (connections.ts): Pi's own calls to its model go through it too. Whatever body a request carries, by any method to any path, is
// a JSON object, which goes on asking only for providers that don't collect its data.
export const name = 'openrouter', host = 'openrouter.ai', key = 'OPENROUTER_API_KEY';

export function check({ method, url, json, body }: Request): unknown {
  if (!body?.length) return undefined;
  if (typeof json !== 'object' || json === null) throw new HttpError(403, `${method} ${url.pathname}: its body is a JSON object, sent as application/json, which goes on asking only for providers that don't collect its data`);
  return { ...json, provider: { ...json.provider, data_collection: 'deny' } };
}

// Every answer's usage has its cost, as Responses' has it in its response.
export const cost = (j: any): number | undefined => j.usage?.cost ?? j.response?.usage?.cost;
