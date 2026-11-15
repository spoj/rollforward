import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHORITY_FORMAT, authorityTree } from '../src/authority-format.ts';
import { seriesDir } from '../src/store.ts';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';
import { readJson, tree, writeJson, type Tree } from '../src/system.ts';

export const readFixtureTree = (root: string) => authorityTree(JSON.parse(readFileSync(join(root, '.rf/tree.json'), 'utf8')));
export const writeFixtureTree = (root: string, tree: Tree) => writeFileSync(join(root, '.rf/tree.json'), JSON.stringify({ ...AUTHORITY_FORMAT, tree }));

export const snapshotFiles = (root: string) => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .map(e => [join(e.parentPath, e.name).slice(root.length + 1), e.isFile() ? readFileSync(join(e.parentPath, e.name)).toString('base64') : 'directory']).sort());

export function ownSeries(series: string, owner: string, logins: string[] = [], autonomous = false) {
  const capabilities = readJson<Record<string, string[]>>('capabilities.json', {});
  writeJson('capabilities.json', { ...capabilities, 'series-owner': [...new Set([...(capabilities['series-owner'] ?? []), owner])] });
  const dir = seriesDir(series), at = new Date().toISOString();
  saveSeriesSettings(dir, {
    version: 1, owner, epoch: seriesSettings(dir).epoch + 1, since: at,
    consent: { by: owner, at, workspace: tree().series[series].workspace, logins, autonomous },
  });
}
