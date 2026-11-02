import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// series.json: {"skills": [skill ids]}, set by people through the server.
export type SeriesSettings = { skills: string[] };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { skills: [] };
}
