import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { View } from '../src/runner.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-wake-'));
const scratch = join(root, 'scratch'), today = join(root, 'today'), prior = join(root, 'prior'), index = join(root, 'index'), pylib = join(root, '.pylib');
const series = '/work/Demo/Weekly: AR', instance = `${series}/Today`, previous = `${series}/Prior`, token = 'check-token';
Object.assign(process.env, { RF_SCRATCH: scratch, OPENROUTER_API_KEY: 'server-key', RF_BROWSER_KEY: 'browser-key' });
const { runWakeCheck } = await import('../src/wake-check.ts');
const { TASKS, FILE_GB } = await import('../src/runner.ts');
const { serveSandboxes } = await import('../src/sandbox.ts');
const view: View = {
  instance, dir: today, pylib, ro: [[today, instance], [prior, previous], [index, '/index']],
  names: { [instance]: 'today', [previous]: 'prior' }, series: { [series]: 'weekly' }, env: { RF_INDEX: '/index', DATABRICKS_HOST: 'trusted-host' },
};
for (const dir of [join(today, 'working'), join(today, 'session'), join(prior, 'working'), index, pylib]) mkdirSync(dir, { recursive: true });
writeFileSync(join(pylib, 'sample_lib.py'), 'VALUE = 3\n');
writeFileSync(join(pylib, 'sitecustomize.py'), "MARKER = 'loaded'\n");
writeFileSync(join(prior, 'working', 'helper.py'), 'VALUE = 4\n');
writeFileSync(join(index, 'items'), 'index data');
writeFileSync(join(root, 'secret'), 'host only');
const opened = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
const server = serveSandboxes({
  run: () => undefined,
  agent: async (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/instances/today/screen') return void res.writeHead(403).end();
    if (url.searchParams.has('hold')) {
      req.socket.once('close', disconnected.resolve);
      opened.resolve();
    } else res.end(JSON.stringify({ rev: 3 }));
  },
});
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
const cleaned = () => assert.deepEqual(readdirSync(join(scratch, 'runs')), []);

function check(file: string, text: string, signal = AbortSignal.timeout(5_000), checkpoint?: () => void) {
  writeFileSync(join(prior, 'working', file), text);
  return runWakeCheck({ token, id: 'today', view, script: `${previous}/working/${file}`, signal, checkpoint });
}

test('Python checks can read the view and script library but cannot write files or see server settings', async () => {
  const result = await check('check.py', `
import errno, json, os, resource, sys, urllib.request
from pathlib import Path
from sample_lib import VALUE
from helper import VALUE as HELPER
import requests
assert VALUE == 3 and HELPER == 4 and sys.dont_write_bytecode
assert '/opt/venv/' in requests.__file__
assert sys.flags.isolated and sys.flags.no_site
assert 'sitecustomize' not in sys.modules
assert resource.getrlimit(resource.RLIMIT_NPROC) == (${TASKS}, ${TASKS})
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (${FILE_GB * 2 ** 30}, ${FILE_GB * 2 ** 30})
assert os.getcwd() == ${JSON.stringify(instance)}
assert os.environ['RF_WORKING'] == ${JSON.stringify(`${instance}/working`)}
assert Path(os.environ['RF_INDEX'], 'items').read_text() == 'index data'
assert not Path(${JSON.stringify(join(root, 'secret'))}).exists()
assert not (set(os.environ) & {'DATABRICKS_HOST', 'OPENROUTER_API_KEY', 'RF_BROWSER_KEY', 'RF_BROWSERS', 'HTTP_PROXY', 'HTTPS_PROXY'})
for at in (os.environ['RF_WORKING'], '../Prior/working', 'session', '/index', '/pylib', os.environ['HOME'], os.environ['TMPDIR']):
    try:
        Path(at, 'new').write_text('no')
    except OSError as e:
        assert e.errno == errno.EROFS
    else:
        raise AssertionError('persistent write')
url = os.environ['RF_URL'] + '/api/instances/' + os.environ['RF_INSTANCE'] + '/screen'
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['RF_TOKEN']})
assert json.load(urllib.request.urlopen(req, timeout=2))['rev'] == 3
print('not part of the result', file=sys.stderr)
print(json.dumps({'decision': 'stop', 'message': 'No new rows.'}))
`);
  assert.deepEqual(result, { decision: 'stop', message: 'No new rows.' });
  assert.deepEqual(readdirSync(index), ['items'], 'the caller still owns its index');
  assert.deepEqual(readdirSync(pylib).sort(), ['sample_lib.py', 'sitecustomize.py']);
  cleaned();
});

test('refusing the launch checkpoint prevents the sandbox from running', async () => {
  const stop = `print('{"decision":"stop","message":"Unexpected launch"}')`;
  await assert.rejects(check('checkpoint.py', stop, AbortSignal.timeout(5_000), () => { throw new Error('stale snapshot'); }), { message: 'could not start sandbox' });
  cleaned();
});

test('Node strips types and blocks its inspector; rf show reads with the check’s token', async () => {
  const result = await check('check.ts', `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import inspector from 'node:inspector';
assert.throws(() => inspector.open(), { code: 'ERR_ACCESS_DENIED' });
const url = process.env.RF_URL + '/api/instances/' + process.env.RF_INSTANCE + '/screen';
assert.equal((await fetch(url, { headers: { Authorization: 'Bearer different-token' } })).status, 401);
const { rev }: { rev: number } = JSON.parse(execFileSync('rf', ['show'], { encoding: 'utf8' }));
console.log(JSON.stringify({ message: 'Revision ' + rev, decision: 'continue' }));
`);
  assert.deepEqual(result, { decision: 'continue', message: 'Revision 3' });
});

test('a message can have 500 Unicode characters even when JSON-escaped', async () => {
  const result = await check('unicode.py', `import json; print(json.dumps({'decision':'continue','message':'🙂' * 500}))`);
  assert.equal(result.message, '🙂'.repeat(500));
});

for (const [name, script, message] of [
  ['malformed JSON', 'print("private data")', 'invalid check result'],
  ['malformed UTF-8', 'import sys; sys.stdout.buffer.write(b\'{"decision":"stop","message":"\\xff"}\')', 'invalid check result'],
  ['multiple objects', `print('{"decision":"stop","message":"one"}' * 2)`, 'invalid check result'],
  ['an extra key', `print('{"decision":"stop","message":"one","extra":"private data"}')`, 'invalid check result'],
  ['a duplicate key', `print('{"decision":"stop","decision":"continue","message":"one"}')`, 'invalid check result'],
  ['an empty message', `print('{"decision":"stop","message":""}')`, 'invalid check result'],
  ['an overlong message', `import json; print(json.dumps({'decision':'stop','message':'x' * 501}))`, 'invalid check result'],
  ['oversized stdout', `print('x' * 8193)`, 'stdout exceeds 8 KiB'],
  ['a nonzero exit', `import sys; print('{"decision":"stop","message":"one"}'); sys.exit('private error')`, 'script did not exit successfully'],
]) test(`rejects ${name} without quoting output`, async () => {
  await assert.rejects(check('bad.py', script), { message });
  cleaned();
});

test('abort ends the check and a child using its bridge, then removes scratch', { timeout: 10_000 }, async () => {
  const cancel = new AbortController();
  const result = check('hold.py', `
import os, subprocess
subprocess.run(['curl', '-sS', '-H', 'Authorization: Bearer ' + os.environ['RF_TOKEN'],
    os.environ['RF_URL'] + '/api/instances/today/screen?hold'])
`, AbortSignal.any([cancel.signal, AbortSignal.timeout(5_000)]));
  await Promise.race([result, opened.promise]);
  cancel.abort(new Error('private reason'));
  await assert.rejects(result, { name: 'AbortError', message: 'interrupted' });
  await disconnected.promise;
  cleaned();
});

test('a deadline uses the caller’s signal and reports a safe timeout', async () => {
  await assert.rejects(check('sleep.py', 'import time; time.sleep(30)', AbortSignal.timeout(200)), { name: 'TimeoutError', message: 'timed out' });
  cleaned();
});
