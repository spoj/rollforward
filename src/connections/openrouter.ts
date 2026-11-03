import { HttpError } from '../store.ts';
import type { Request } from '../connections.ts';

// OpenRouter, any model, the server's own connection (connections.ts): Pi's own calls to its model go through it too. It
// takes inference, POST /api/v1/chat/completions, completions, responses and messages, and reads of the models and of a
// generation, GET /api/v1/models… and /api/v1/generation: no keys, credits or anything else. A body is a JSON object, which goes
// on asking only for providers that don't collect its data.
export const name = 'openrouter', host = 'openrouter.ai', key = 'OPENROUTER_API_KEY';
const INFERENCE = ['/api/v1/chat/completions', '/api/v1/completions', '/api/v1/responses', '/api/v1/messages'];

export function check({ method, url, json }: Request): unknown {
  const p = url.pathname.replace(/\/$/, '');
  if (method === 'GET' && /^\/api\/v1\/(models(\/.*)?|generation)$/.test(p)) return undefined;
  if (method !== 'POST' || !INFERENCE.includes(p)) throw new HttpError(403, `${method} ${p}: openrouter takes inference, POST ${INFERENCE.join(', ')}, and GET /api/v1/models and /api/v1/generation`);
  if (typeof json !== 'object' || json === null) throw new HttpError(403, `${p}: its body is a JSON object, sent as application/json`);
  return { ...json, provider: { ...json.provider, data_collection: 'deny' } };
}

// Every answer's usage has its cost, as Responses' has it in its response.
export const cost = (j: any): number | undefined => j.usage?.cost ?? j.response?.usage?.cost;
