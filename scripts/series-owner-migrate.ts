import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTHORITY_FORMAT, checkAuthorityFormat } from '../src/authority-format.ts';
import { replaceFile, type Tree } from '../src/system.ts';

export function migrateSeriesOwners(root: string): void {
  const rf = join(root, '.rf'), marker = join(rf, 'authority-format.json');
  if (existsSync(marker)) throw new Error('data already has an authority format; an incomplete conversion requires restoring the complete offline backup');
  const tree: Tree = JSON.parse(readFileSync(join(rf, 'tree.json'), 'utf8'));
  const series = join(root, 'series');
  const ids = new Set([...Object.keys(tree.series), ...(existsSync(series) ? readdirSync(series) : [])]);
  if ([...ids].some(id => !/^[\w-]+$/.test(id))) throw new Error('invalid series id in offline snapshot');
  writeFileSync(marker, JSON.stringify({ ...AUTHORITY_FORMAT, state: 'migrating' }), { flag: 'wx', mode: 0o600 });
  const evidence = join(rf, 'authority-migration');
  mkdirSync(join(evidence, 'series'), { recursive: true, mode: 0o700 });
  const since = new Date().toISOString();
  for (const id of ids) {
    const dir = join(series, id), settings = join(dir, 'series.json');
    if (existsSync(settings)) {
      const raw = readFileSync(settings);
      writeFileSync(join(evidence, 'series', `${id}.json`), raw, { flag: 'wx', mode: 0o600 });
      const legacy = JSON.parse(raw.toString());
      if (legacy.version !== undefined || legacy.owner !== undefined || legacy.consent !== undefined)
        throw new Error(`series ${id} already contains authority fields; restore and review the offline snapshot`);
    }
    mkdirSync(dir, { recursive: true });
    replaceFile(settings, JSON.stringify({ version: 1, epoch: 1, since }));
  }
  const wakes = join(rf, 'wakes.json');
  if (existsSync(wakes)) {
    const raw = readFileSync(wakes);
    writeFileSync(join(evidence, 'wakes.json'), raw, { flag: 'wx', mode: 0o600 });
    const old = JSON.parse(raw.toString());
    replaceFile(wakes, JSON.stringify({ ...old, pending: {}, requests: {} }));
  }
  replaceFile(marker, JSON.stringify(AUTHORITY_FORMAT));
  checkAuthorityFormat(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, offline, ...extra] = process.argv.slice(2);
  if (!root || offline !== '--offline' || extra.length) {
    console.error('usage: node scripts/series-owner-migrate.ts DATA_ROOT --offline (stopped server and updater; complete backup required)');
    process.exitCode = 2;
  } else {
    migrateSeriesOwners(resolve(root));
    console.log('Converted offline: all series unowned, no consent; old wakes and requests invalidated, evidence preserved.');
  }
}
