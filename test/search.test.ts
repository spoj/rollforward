import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instanceDir, openStore } from '../src/store.ts';
import { search } from '../src/search.ts';

const root = join(mkdtempSync(join(tmpdir(), 'rf-search-')), 'data'), cwd = '/work/larkfield/Weekly borrowing base';
cpSync(join(import.meta.dirname, '..', 'demo', 'snapshot'), root, { recursive: true });
openStore(root);
const ro = readdirSync(join(root, 'instances')).map(id => [instanceDir(id), `${cwd}/${JSON.parse(readFileSync(join(instanceDir(id), 'instance.json'), 'utf8')).label}`] as [string, string]);
const view = { cwd, instance: `${cwd}/2026-09-06`, dir: '', pylib: '', ro, catalogue: '' };

test('rf search finds lines in every file in reach, inside workbooks by their cells, and folders narrow it', async () => {
  const hits = (await search(view, ['maison verte'])).split('\n');
  assert.ok(hits.includes('2026-08-23/upload/Larkfield AR aging 082326.xlsx: Aging!26: A26=Maison Verte SARL | B26=EUR | C26=519011.85 | D26=186199.83 | E26=75393.11 | F26=32054.6 | G26=28519.42 | H26=7359.57 | I26=848538.38'));
  assert.ok(hits.some(h => /^2026-08-23\/working\/process\.md:\d+: /.test(h)), 'a text file by its line');
  assert.ok(readdirSync(join(root, 'derived')).length > 10, "workbooks' text is kept by hash");
  assert.ok((await search(view, ['waiver', '2026-08-30'])).split('\n').every(h => h.startsWith('2026-08-30/')));
  assert.equal(await search(view, ['no such words anywhere']), 'no match');
  await assert.rejects(search(view, []), /rf search PATTERN/);
});
