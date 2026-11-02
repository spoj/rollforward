import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// series.json: {"skills": [skill ids]}, set by people through the server. One saved with each skill's settings keeps its choice,
// the settings now being the admins' (skills.ts). Tool use, the connections a series once chose, is gone: its skills say what they
// use.
export type SeriesSettings = { skills: string[]; [k: string]: unknown };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json'), { tools: _, ...s } = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const chosen = Array.isArray(s.skills) ? s.skills : s.skills ? Object.keys(s.skills) : [];
  return { ...s, skills: chosen };
}
