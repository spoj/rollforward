import type { IncomingHttpHeaders } from 'node:http';
import { calculateCost } from '@earendil-works/pi-ai/models';
import { OPENROUTER_CLASSIFIER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { HttpError } from '../store.ts';
import type { Request } from '../connections.ts';

// OpenRouter, any model and any request, with the server's key or its runner's own, one of the server's own connections
// (connections.ts): Pi's own calls to its model go through it too. Whatever body a request carries, by any method to any path, is
// a JSON object, which goes on asking only for providers that don't collect its data.
export const name = 'openrouter', host = 'openrouter.ai', key = 'OPENROUTER_API_KEY';
// The model runs and the shared website check use, RF_MODEL.
export const [provider, model] = (process.env.RF_MODEL ?? 'openrouter/anthropic/claude-opus-5.5').split(/\/(.*)/);

// The JSON object a check's answer holds: some models fence it in ```json despite response_format, which JSON.parse refuses.
export function answer(content: string) {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'));
}

export function check({ method, url, json, body }: Request): unknown {
  if (!body?.length) return undefined;
  if (typeof json !== 'object' || json === null) throw new HttpError(403, `${method} ${url.pathname}: its body is a JSON object, sent as application/json, which goes on asking only for providers that don't collect its data`);
  return { ...json, provider: { ...json.provider, data_collection: 'deny' } };
}

// Every answer's usage has its cost, as Responses' has it in its response.
export const cost = (j: any): number | undefined => {
  const c = j?.usage?.cost ?? j?.response?.usage?.cost;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
};

export function generationId(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, events: any[]): string | undefined {
  const h = headers['x-generation-id'];
  return [typeof h === 'string' ? h : h?.[0], ...events.map(e => e?.id ?? e?.response?.id ?? e?.request_id)]
    .find((id): id is string => typeof id === 'string' && /^gen-[\w-]+$/.test(id));
}

// Fallback when neither the answer's usage nor /api/v1/generation yielded a charged cost.
export function estimate(path: string, reqJson: any, events: any[], bytes: number): number {
  const slug = typeof reqJson?.model === 'string' ? reqJson.model : model;
  if (path.endsWith('/embeddings')) {
    const u = events.findLast(e => e?.usage)?.usage;
    const tokens = typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : typeof u?.total_tokens === 'number' ? u.total_tokens
      : Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(reqJson?.input ?? '')) / 4));
    return +(tokens * 0.1 / 1_000_000).toFixed(6);
  }
  if (path.endsWith('/audio/speech')) {
    const chars = typeof reqJson?.input === 'string' ? reqJson.input.length : bytes;
    return +(Math.max(1, chars) * 0.015 / 1000).toFixed(6);
  }
  let hasInput = false, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, outChars = 0;
  for (const e of events) {
    const u = e?.usage ?? e?.response?.usage ?? e?.message?.usage;
    if (u && typeof u === 'object') {
      const cr = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens;
      const cw = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_write_tokens ?? u.input_tokens_details?.cache_write_tokens;
      const cw1 = u.cache_creation?.ephemeral_1h_input_tokens;
      if (typeof cr === 'number') cacheRead = Math.max(cacheRead, cr);
      if (typeof cw === 'number') cacheWrite = Math.max(cacheWrite, cw);
      if (typeof cw1 === 'number') cacheWrite1h = Math.max(cacheWrite1h, cw1);
      if (typeof u.prompt_tokens === 'number') {
        hasInput = true;
        input = Math.max(0, u.prompt_tokens - (u.prompt_tokens_details?.cached_tokens ?? 0) - (u.prompt_tokens_details?.cache_write_tokens ?? 0));
      } else if (typeof u.input_tokens === 'number') {
        if (u.input_tokens > 0 || cacheRead > 0 || cacheWrite > 0) hasInput = true;
        input = u.input_tokens_details
          ? Math.max(0, u.input_tokens - (u.input_tokens_details.cached_tokens ?? 0) - (u.input_tokens_details.cache_write_tokens ?? 0))
          : Math.max(input, u.input_tokens);
      }
      const out = u.output_tokens ?? u.completion_tokens;
      if (typeof out === 'number') output = Math.max(output, out);
    }
    const delta = e?.delta?.text ?? e?.delta?.partial_json ?? e?.choices?.[0]?.delta?.content ?? e?.delta;
    if (typeof delta === 'string') outChars += delta.length;
  }
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  if (path.endsWith('/images')) {
    const img = OPENROUTER_IMAGE_MODELS[slug as keyof typeof OPENROUTER_IMAGE_MODELS];
    if (img && (hasInput || output > 0)) return +calculateCost(img as any, { input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: { ...zero } }).total.toFixed(6);
    const count = typeof reqJson?.n === 'number' && reqJson.n > 0 ? reqJson.n : 1;
    return +(0.04 * count).toFixed(6);
  }
  if (!hasInput) input = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(reqJson ?? {})) / 4));
  if (!output && (outChars || bytes)) output = Math.max(1, Math.ceil((outChars || bytes) / 4));
  const m = OPENROUTER_MODELS[slug as keyof typeof OPENROUTER_MODELS]
    ?? OPENROUTER_CLASSIFIER_MODELS[slug as keyof typeof OPENROUTER_CLASSIFIER_MODELS]
    ?? OPENROUTER_MODELS[model as keyof typeof OPENROUTER_MODELS]
    ?? { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };
  return +calculateCost(m as any, { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, ...(cacheWrite1h && { cacheWrite1h }), cost: { ...zero } }).total.toFixed(6);
}
