// One-off: the fork named some people by name, not email, so the instances they made have a runner no one signs in as. This
// renames NAME to EMAIL wherever an instance's log has NAME as who acted. Run it with the server stopped:
//   node scripts/rename-person.ts DATA NAME EMAIL
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, name, email] = process.argv.slice(2);
for (const id of readdirSync(join(root, 'instances'))) {
  const log = join(root, 'instances', id, 'log.jsonl'), entries = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const n = entries.filter(e => e.by === name).length;
  if (!n) continue;
  writeFileSync(log, entries.map(e => JSON.stringify(e.by === name ? { ...e, by: email } : e) + '\n').join(''));
  console.log(`${id}: ${n} entries`);
}
