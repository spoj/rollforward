import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateMessageCopy } from '../scripts/migrate-messages.ts';
import { AUTHORITY_FORMAT, authorityTree } from '../src/authority-format.ts';
import { seriesDir } from '../src/store.ts';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';
import { replaceFile, tree, type Tree } from '../src/system.ts';
import type { Wake } from '../src/waker.ts';

export function readFixtureTree(root: string): Tree {
  const data = JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8'));
  return authorityTree(data.minReader === '0.7.0' ? { ...data, minReader: AUTHORITY_FORMAT.minReader } : data);
}
export const writeFixtureTree = (root: string, tree: Tree) => writeFileSync(join(root, '.rf/tree.json'), JSON.stringify({ ...AUTHORITY_FORMAT, tree }));
export const writeLegacyFixtureTree = (root: string, tree: Tree) => writeFileSync(join(root, '.rf/tree.json'), JSON.stringify({ ...AUTHORITY_FORMAT, minReader: '0.7.0', tree }));
export const migrateFixtureMessages = (root: string) => migrateMessageCopy(realpathSync(root), true);

// Fire these unconsented wakes in the live server so it writes request messages and their scheduler refs together.
export async function fireFixtureRequests(root: string, wakes: Record<string, Pick<Wake, 'target' | 'from' | 'label' | 'inst' | 'text'>>) {
  const path = join(root, '.rf', 'wakes.json'), at = new Date().toISOString();
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { pending: {}, fired: {}, requests: {} };
  for (const [id, wake] of Object.entries(wakes)) state.pending[id] = { ...wake, at, request: true };
  replaceFile(path, JSON.stringify(state));
  for (let i = 0; i < 200; i++) {
    const { requests } = JSON.parse(readFileSync(path, 'utf8'));
    if (Object.keys(wakes).every(id => Number.isSafeInteger(requests[id]?.message))) return;
    await new Promise(ok => setTimeout(ok, 25));
  }
  throw new Error(`fixture requests did not fire: ${Object.keys(wakes).join(', ')}`);
}

export const snapshotFiles = (root: string) => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .map(e => [join(e.parentPath, e.name).slice(root.length + 1), e.isFile() ? readFileSync(join(e.parentPath, e.name)).toString('base64') : 'directory']).sort());

export function ownSeries(series: string, owner: string, logins: string[] = [], autonomous = false) {
  const dir = seriesDir(series), at = new Date().toISOString();
  saveSeriesSettings(dir, {
    version: 1, owner, epoch: seriesSettings(dir).epoch + 1, since: at,
    consent: { by: owner, at, workspace: tree().series[series].workspace, logins, autonomous },
  });
}
