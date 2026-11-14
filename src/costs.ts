import { closeSync, existsSync, openSync, readSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, rfDir } from './system.ts';

export type CostRecord =
  | { at: string; service: 'openrouter' | 'exa'; inst: string; run: number; person: string; cost: number; estimated?: true; own?: true }
  | { at: string; by: 'server'; service: 'openrouter' | 'exa'; kind: 'website-check' | 'try'; site?: string; person: string; cost: number; estimated?: true; own?: true };

let cachedRoot = '', cachedOffset = 0, cachedInode = 0, cached: CostRecord[] = [];

const file = () => join(rfDir(), 'costs.jsonl');

export function recordCost(entry: CostRecord) {
  const root = rfDir();
  if (!root) return;
  syncCosts();
  if (existsSync(file()) && statSync(file()).size > cachedOffset) truncateSync(file(), cachedOffset);
  const line = JSON.stringify(entry);
  appendLine(file(), line, 0o600);
  syncCosts();
}

// Incremental tail read: costs.jsonl is append-only (including from `cli.ts try` in another process), so after the first read
// only newly appended bytes are read.
export function syncCosts(): CostRecord[] {
  const root = rfDir();
  if (!root) return [];
  if (root !== cachedRoot) {
    cachedRoot = root;
    cachedOffset = 0;
    cached = [];
  }
  const p = file();
  if (!existsSync(p)) {
    cachedOffset = 0;
    cached = [];
    return cached;
  }
  const { size, ino } = statSync(p);
  if (ino !== cachedInode || size < cachedOffset) {
    cachedOffset = 0;
    cached = [];
  }
  cachedInode = ino;
  if (size === cachedOffset) return cached;
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(size - cachedOffset);
    const n = readSync(fd, buf, 0, buf.length, cachedOffset);
    const end = buf.subarray(0, n).lastIndexOf(10) + 1;
    if (end > 0) {
      for (const l of buf.subarray(0, end).toString('utf8').split('\n')) if (l) cached.push(JSON.parse(l));
      cachedOffset += end;
    }
  } finally {
    closeSync(fd);
  }
  return cached;
}
