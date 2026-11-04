import type { Request } from '../connections.ts';

// Exa, web search and pages' contents, one of the server's own connections (connections.ts): any request, with the server's key.
export const name = 'exa', host = 'api.exa.ai', key = 'EXA_API_KEY';
export const check = (_: Request): unknown => undefined;

export const cost = (j: any): number | undefined => j.costDollars?.total;
