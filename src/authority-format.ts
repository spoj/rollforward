import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { messagesFile } from './message-store.ts';
import { replaceFile, type Tree } from './system.ts';

export const AUTHORITY_FORMAT = { format: 'rollforward-series-owner', version: 1, minReader: '0.8.0', state: 'complete' } as const;

export function authorityTree(data: any): Tree {
  if (data?.format === AUTHORITY_FORMAT.format && data.version === AUTHORITY_FORMAT.version) {
    if (data.state !== 'complete') throw new Error('incomplete data conversion: restore the original and convert a fresh stopped copy');
    if (data.minReader !== AUTHORITY_FORMAT.minReader) throw new Error('incompatible message format: convert a stopped v0.7.9 copy with scripts/migrate-messages.ts');
  }
  if (data?.format !== AUTHORITY_FORMAT.format || data.version !== AUTHORITY_FORMAT.version || data.minReader !== AUTHORITY_FORMAT.minReader || data.state !== 'complete'
    || 'workspaces' in data || 'series' in data || !data.tree || typeof data.tree !== 'object' || Array.isArray(data.tree)
    || !data.tree.workspaces || typeof data.tree.workspaces !== 'object' || Array.isArray(data.tree.workspaces)
    || !data.tree.series || typeof data.tree.series !== 'object' || Array.isArray(data.tree.series))
    throw new Error('legacy data: convert it to series owners first (docs/deploy.md)');
  for (const [id, w] of Object.entries(data.tree.workspaces) as [string, any][]) {
    if (!/^[\w-]+$/.test(id) || !w || typeof w.name !== 'string' || !Array.isArray(w.owners) || !w.owners.every((p: unknown) => typeof p === 'string')
      || !Array.isArray(w.members) || !w.members.every((p: unknown) => typeof p === 'string'))
      throw new Error(`unsupported or incomplete workspace format for ${id}`);
  }
  for (const [id, s] of Object.entries(data.tree.series) as [string, any][]) {
    if (!/^[\w-]+$/.test(id) || !s || typeof s.name !== 'string' || typeof s.workspace !== 'string' || !Object.hasOwn(data.tree.workspaces, s.workspace))
      throw new Error(`unsupported or incomplete series authority for ${id}`);
  }
  return data.tree;
}

export function checkAuthorityFormat(root: string): void {
  const path = join(root, '.rf', 'tree.json');
  if (!existsSync(path)) {
    if (existsSync(root) && readdirSync(root).length) throw new Error('legacy data: convert it to series owners first (docs/deploy.md)');
    mkdirSync(join(root, '.rf'), { recursive: true, mode: 0o700 });
    const tree = { workspaces: {}, series: {} };
    replaceFile(path, JSON.stringify({ ...AUTHORITY_FORMAT, state: 'incomplete', tree }));
    replaceFile(path, JSON.stringify({ ...AUTHORITY_FORMAT, tree }));
    return;
  }
  const tree = authorityTree(JSON.parse(readFileSync(path, 'utf8')));
  checkSeriesAuthority(root, tree);
  for (const id of Object.keys(tree.series)) {
    if (!lstatSync(messagesFile(join(root, 'series', id)), { throwIfNoEntry: false })?.isFile())
      throw new Error(`missing canonical message log for ${id}`);
  }
}

export function checkSeriesAuthority(root: string, tree: Tree) {
  for (const [id, series] of Object.entries(tree.series)) {
    const settings = join(root, 'series', id, 'series.json');
    if (!existsSync(settings)) throw new Error(`incomplete series authority for ${id}`);
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    const c = s?.consent;
    if (s?.version !== 1 || !Number.isSafeInteger(s.epoch) || s.epoch < 0 || typeof s.since !== 'string' || 'shared' in s
      || (s.owner !== undefined && (typeof s.owner !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(s.owner)))
      || (c !== undefined && (!s.owner || c?.by !== s.owner || typeof c.at !== 'string' || c.workspace !== series.workspace
        || !Array.isArray(c.logins) || !c.logins.every((l: unknown) => typeof l === 'string') || typeof c.autonomous !== 'boolean')))
      throw new Error(`unsupported or incomplete series authority for ${id}`);
  }
}
