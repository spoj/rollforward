import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFile, type Tree } from './system.ts';

export const AUTHORITY_FORMAT = { version: 1, minReader: 1, state: 'complete' } as const;

export function checkAuthorityFormat(root: string): void {
  const marker = join(root, '.rf', 'authority-format.json');
  if (!existsSync(marker)) {
    if (existsSync(root) && readdirSync(root).length) throw new Error('series owner authority format: manual offline migration required; see docs/deploy.md');
    mkdirSync(join(root, '.rf'), { recursive: true, mode: 0o700 });
    replaceFile(marker, JSON.stringify(AUTHORITY_FORMAT));
    return;
  }
  const format = JSON.parse(readFileSync(marker, 'utf8'));
  if (format?.version !== 1 || format.minReader !== 1 || format.state !== 'complete')
    throw new Error('unsupported or incomplete series owner authority format; restore a complete compatible backup, never downgrade code over this data');
  const treePath = join(root, '.rf', 'tree.json');
  const tree: Tree = existsSync(treePath) ? JSON.parse(readFileSync(treePath, 'utf8')) : { workspaces: {}, series: {} };
  const seriesDir = join(root, 'series');
  for (const id of Object.keys(tree.series)) {
    const path = join(seriesDir, id, 'series.json');
    if (!/^[\w-]+$/.test(id) || !existsSync(path)) throw new Error(`incomplete series authority for ${id}`);
    const s = JSON.parse(readFileSync(path, 'utf8'));
    const c = s?.consent;
    if (s?.version !== 1 || !Number.isSafeInteger(s.epoch) || s.epoch < 0 || typeof s.since !== 'string' || 'shared' in s
      || (s.owner !== undefined && (typeof s.owner !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(s.owner)))
      || (c !== undefined && (!s.owner || c?.by !== s.owner || typeof c.at !== 'string' || typeof c.workspace !== 'string' || c.workspace !== tree.series[id]?.workspace
        || !Array.isArray(c.logins) || !c.logins.every((l: unknown) => typeof l === 'string') || typeof c.autonomous !== 'boolean')))
      throw new Error(`unsupported or incomplete series authority for ${id}`);
  }
}
