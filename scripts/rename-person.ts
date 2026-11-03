// One-off: the fork named some people by name, not email, so the instances they made have a runner no one signs in as. This
// renames NAME to EMAIL wherever an instance's log names NAME as a person: who acted, whom a takeover was from, and who set a wake.
// Each log is written whole beside the old one, then moved over it. Run it with the server stopped:
//   node scripts/rename-person.ts DATA NAME EMAIL
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, name, email] = process.argv.slice(2);
const renamed = (e: Record<string, unknown>) => ({ ...e, ...(e.by === name && { by: email }), ...(['takeover', 'wake'].includes(e.op as string) && e.from === name && { from: email }) });
for (const id of readdirSync(join(root, 'instances'))) {
  const log = join(root, 'instances', id, 'log.jsonl'), entries = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const n = entries.filter(e => JSON.stringify(renamed(e)) !== JSON.stringify(e)).length;
  if (!n) continue;
  writeFileSync(`${log}.tmp`, entries.map(e => JSON.stringify(renamed(e)) + '\n').join(''));
  renameSync(`${log}.tmp`, log);
  console.log(`${id}: ${n} entries`);
}
