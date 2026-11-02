import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// series.json: {"skills": [skill ids], "wakes"?: {"by", "since", "logins"}}, set by people through the server. wakes is Allow
// wakes: who turned it on, and runs every instance a wake starts with the logins they ticked then.
export type SeriesSettings = { skills: string[]; wakes?: { by: string; since: string; logins: string[] } };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { skills: [] };
}
