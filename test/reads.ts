import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Preloaded into a server under test (node --import), it counts the server's reads of each of .rf/'s files, by name, into the file
// RF_TEST_READS names, which the test reads back.
const out = process.env.RF_TEST_READS!, read = fs.readFileSync, counts: Record<string, number> = {};
fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
  const name = typeof path === 'string' ? /[\\/]\.rf[\\/]([^\\/]+)$/.exec(path)?.[1] : undefined;
  if (name) {
    counts[name] = (counts[name] ?? 0) + 1;
    fs.writeFileSync(out, JSON.stringify(counts));
  }
  return read(path, options as never);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
