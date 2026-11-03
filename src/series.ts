import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// series.json: {"shared"?: {"by", "since", "logins"}}, set by people through the server. shared is who lets anyone in the workspace,
// and its agents, start runs of the series as them: a wake starts a new instance run by them with the logins they ticked then, and
// in their instances anyone's comments, uploads and wakes start runs.
export type SeriesSettings = { shared?: { by: string; since: string; logins: string[] } };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}
