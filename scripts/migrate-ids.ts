// One-off: moves a data root from folders by name (<workspace>/<series>/<label>/, .rf/workspaces.json with one owner each,
// .archived files, series.json with visible_to) to folders by id (.rf/tree.json, series/<id>/, instances/<id>/), giving each
// workspace its Ad hoc series. Run it with the server stopped: node scripts/migrate-ids.ts DATA_ROOT
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../src/store.ts';
import type { Tree } from '../src/system.ts';

const root = process.argv[2];
const rf = join(root, '.rf'), owners: Record<string, { owner: string | null }> = existsSync(join(rf, 'workspaces.json')) ? JSON.parse(readFileSync(join(rf, 'workspaces.json'), 'utf8')) : {};
const folders = (dir: string) => readdirSync(dir).filter(n => !n.startsWith('.') && statSync(join(dir, n)).isDirectory()).sort();
const t: Tree = { workspaces: {}, series: {} };
if (existsSync(join(rf, 'tree.json')) || existsSync(join(root, 'instances'))) throw new Error(`${root} is already by id`);
const workspaces = folders(root);
mkdirSync(join(root, 'series'));
mkdirSync(join(root, 'instances'));

for (const name of workspaces) {
  const wid = newId(), wsDir = join(root, name), owner = owners[name]?.owner;
  t.workspaces[wid] = { name, owners: owner ? [owner] : [], members: [], ...(existsSync(join(wsDir, '.archived')) && { archived: true }) };
  const adhoc = newId();
  t.series[adhoc] = { name: 'Ad hoc', workspace: wid, adhoc: true };
  mkdirSync(join(root, 'series', adhoc));
  for (const series of folders(wsDir)) {
    const sid = newId(), dir = join(root, 'series', sid);
    renameSync(join(wsDir, series), dir);
    t.series[sid] = { name: series, workspace: wid, ...(existsSync(join(dir, '.archived')) && { archived: true }) };
    const old = existsSync(join(dir, 'series.json')) ? JSON.parse(readFileSync(join(dir, 'series.json'), 'utf8')) : {};
    if (old.visible_to?.length) console.log(`${name}/${series} was visible to ${old.visible_to.join(', ')}; its workspace's series now read it`);
    rmSync(join(dir, 'series.json'), { force: true });
    writeFileSync(join(dir, 'series.json'), JSON.stringify({ skills: Array.isArray(old.skills) ? old.skills : Object.keys(old.skills ?? {}) }, null, 1), { mode: 0o444 });
    rmSync(join(dir, '.archived'), { force: true });
    for (const label of folders(dir).filter(l => existsSync(join(dir, l, 'workspace.json')))) {
      const iid = newId();
      renameSync(join(dir, label), join(root, 'instances', iid));
      writeFileSync(join(root, 'instances', iid, 'instance.json'), JSON.stringify({ label, series: sid }), { mode: 0o444 });
    }
    const left = readdirSync(dir).filter(f => f !== 'series.json' && f !== '.pylib');
    if (left.length) console.log(`left in series/${sid} (${name}/${series}): ${left.join(', ')}`);
  }
  rmSync(join(wsDir, '.archived'), { force: true });
  if (readdirSync(wsDir).length) console.log(`left in ${name}/: ${readdirSync(wsDir).join(', ')}`);
  else rmSync(wsDir, { recursive: true });
}
mkdirSync(rf, { recursive: true, mode: 0o700 });
writeFileSync(join(rf, 'tree.json'), JSON.stringify(t, null, 1), { mode: 0o600 });
rmSync(join(rf, 'workspaces.json'), { force: true });
console.log(`${Object.keys(t.workspaces).length} workspaces, ${Object.keys(t.series).length} series, ${readdirSync(join(root, 'instances')).length} instances`);
