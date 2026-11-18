import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Preloaded into a server under test (node --import), it counts the server's reads of each of .rf/'s files, by name, and of series'
// series.json, into the file RF_TEST_READS names, which the test reads back: whole, by a rename, as the test may read it while the
// server counts.
const out = process.env.RF_TEST_READS!, read = fs.readFileSync, counts: Record<string, number> = {};
const counted = (path: string) => /[\\/]\.rf[\\/]([^\\/]+)$/.exec(path)?.[1] ?? (/[\\/]series[\\/][^\\/]+[\\/]series\.json$/.test(path) ? 'series.json' : undefined);
fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
  const name = typeof path === 'string' ? counted(path) : undefined;
  if (name) {
    counts[name] = (counts[name] ?? 0) + 1;
    fs.writeFileSync(`${out}.tmp`, JSON.stringify(counts));
    fs.renameSync(`${out}.tmp`, out);
  }
  return read(path, options as never);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
