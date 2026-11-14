import type { Request } from '../connections.ts';

// Exa, web search and pages' contents, one of the server's own connections (connections.ts): any request, with the server's key.
export const name = 'exa', host = 'api.exa.ai', key = 'EXA_API_KEY';
export const check = (_: Request): unknown => undefined;

export const cost = (j: any): number | undefined => {
  const c = j?.costDollars?.total;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
};

export function estimate(path: string, reqJson: any): number {
  if (path.endsWith('/contents')) return +(Math.max(1, reqJson?.urls?.length ?? reqJson?.ids?.length ?? 1) * 0.001).toFixed(6);
  if (path.endsWith('/answer')) return 0.01;
  const results = typeof reqJson?.numResults === 'number' ? Math.min(Math.max(1, reqJson.numResults), 10) : 10;
  return +(0.005 + (reqJson?.contents ? results * 0.001 : 0)).toFixed(6);
}
