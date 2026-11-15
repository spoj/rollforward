import { seriesDir } from '../src/store.ts';
import { saveSeriesSettings, seriesSettings } from '../src/series.ts';
import { readJson, tree, writeJson } from '../src/system.ts';

export function ownSeries(series: string, owner: string, logins: string[] = [], autonomous = false) {
  const capabilities = readJson<Record<string, string[]>>('capabilities.json', {});
  writeJson('capabilities.json', { ...capabilities, 'series-owner': [...new Set([...(capabilities['series-owner'] ?? []), owner])] });
  const dir = seriesDir(series), at = new Date().toISOString();
  saveSeriesSettings(dir, {
    version: 1, owner, epoch: seriesSettings(dir).epoch + 1, since: at,
    consent: { by: owner, at, workspace: tree().series[series].workspace, logins, autonomous },
  });
}
