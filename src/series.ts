import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changes, replaceFile } from './system.ts';

export type SeriesConsent = { by: string; at: string; workspace: string; logins: string[]; autonomous: boolean };
export type SeriesSettings = { version: 1; owner?: string; epoch: number; since: string; consent?: SeriesConsent };
export type Authority = { version: 1; owner: string; epoch: number; workspace: string; logins: string[]; autonomous?: boolean };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json');
  if (!existsSync(p)) return { version: 1, epoch: 0, since: '' };
  const settings = JSON.parse(readFileSync(p, 'utf8'));
  if (settings.version !== 1) throw new Error('legacy data: convert it to series owners first (docs/deploy.md)');
  return settings;
}

export function saveSeriesSettings(dir: string, settings: SeriesSettings, actor?: string) {
  mkdirSync(dir, { recursive: true });
  replaceFile(join(dir, 'series.json'), JSON.stringify(settings, null, 1));
  changes.emit('change', 'tree', actor);
}
