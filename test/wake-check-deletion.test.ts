import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { writeFixtureTree } from './owner-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'rf-wake-check-deletion-'));
const owner = 'owner@demo.test', workspace = 'eb4100000001', series = 'eb4100000002';
const fresh = 'eb4100000003', old = 'eb4100000004', seriesPath = 'Fixture/Checks';
const at = '2026-01-01T00:00:00.000Z', schedule = 'eb4100000005', message = 'Synthetic wake check stop text';
const row = { run: null, outcome: 'wake-check-stop', at, seconds: 2, cost: 0, runner: owner,
  started: { op: 'wake', by: owner }, failure: null, error: null, provenance: { schedule } };
const tombstone = { seq: 3, at, by: owner, op: 'delete', cost: 0, runs: [], wakeChecks: [row] };
const oldLog = { ...tombstone, wakeChecks: [{ ...row, message }] };
let server: Server, token: string;

// Run the production handlers with in-memory HTTP streams, without opening a listener or starting scheduled work.
before(async () => {
  mkdirSync(join(root, '.rf'));
  mkdirSync(join(root, 'usr'));
  writeFixtureTree(root, {
    workspaces: { [workspace]: { name: 'Fixture', owners: [owner], members: [] } },
    series: { [series]: { name: 'Checks', workspace } },
  });
  const settings = join(root, 'series', series);
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, 'series.json'), JSON.stringify({ version: 1, owner, epoch: 1, since: at }));
  for (const [id, label, log] of [[fresh, 'fresh', [
    { seq: 1, at, by: owner, op: 'create' },
    { seq: 2, at, by: 'server', op: 'wake-check', schedule, message, seconds: 2, runner: owner, from: owner, check: 'working/check.py' },
  ]], [old, 'old', [oldLog]]] as const) {
    const dir = join(root, 'instances', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ series, label }));
    writeFileSync(join(dir, 'screen.json'), JSON.stringify({ rev: 1, status: 'open', items: [] }));
    writeFileSync(join(dir, 'log.jsonl'), log.map(e => JSON.stringify(e) + '\n').join(''));
  }
  const session = join(root, 'instances', old, 'session');
  mkdirSync(session);
  writeFileSync(join(session, 'main.jsonl'), JSON.stringify({ type: 'message', timestamp: at, message: { role: 'user', content: message } }) + '\n');
  process.argv[2] = root;
  Object.assign(process.env, { RF_AGENT_ROOT: root, RF_SCRATCH: join(root, 'scratch'),
    RF_OIDC_ISSUER: 'https://issuer.demo.test', RF_OIDC_CLIENT_ID: 'fixture', RF_PUBLIC_URL: 'https://rf.demo.test' });
  delete process.env.RF_BROWSER_URL;
  delete process.env.RF_TUNNEL_URL;
  const listen = mock.method(Server.prototype, 'listen', function (this: Server) { server = this; return this; });
  try { await import('../src/server.ts'); }
  finally { listen.mock.restore(); }
  const { upsertUser, newToken } = await import('../src/auth.ts');
  upsertUser(owner, { role: 'user' });
  token = newToken(owner, 'test', 1);
});

after(() => rmSync(root, { recursive: true, force: true }));

async function request(path: string, method = 'GET', status = 200) {
  const wire = new PassThrough(), req = new IncomingMessage(wire as unknown as Socket);
  Object.assign(req, { method, url: path, headers: { authorization: `Bearer ${token}` }, complete: true });
  req.push(null);
  const res = new ServerResponse(req), chunks: Buffer[] = [];
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(req.socket);
  wire.on('data', chunk => chunks.push(chunk));
  const finished = once(res, 'finish');
  server.emit('request', req, res);
  await finished;
  const raw = Buffer.concat(chunks).toString(), body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  assert.equal(res.statusCode, status, `${method} ${path}: ${body}`);
  return body;
}

test('deleting a wake-check stop keeps its zero-cost row without storing its message', async () => {
  const path = `${seriesPath}/fresh`;
  assert.deepEqual(JSON.parse(await request('/api/runs')).find(r => r.path === path), { path, ...row, message }, 'live rows still report the stop message');
  await request(`/api/instances/${fresh}/delete`, 'POST');
  const stored = JSON.parse(readFileSync(join(root, 'instances', fresh, 'log.jsonl'), 'utf8'));
  assert.deepEqual(stored.wakeChecks, [row], 'the new tombstone never stores the message');
  assert.deepEqual(JSON.parse(await request('/api/runs')).find(r => r.path === path), { path, ...row });
});

test('public reads never serve a legacy tombstone’s stop message', async () => {
  const path = `${seriesPath}/old`, api = `/api/instances/${old}`;
  const [detail, trace, file, preview, pull, runs] = await Promise.all([
    request(api), request(`${api}/trace`), request(`/files/${old}/log.jsonl`, 'GET', 404), request(`/preview/${old}/log.jsonl`, 'GET', 404),
    request(`/api/files?path=${encodeURIComponent(path)}`), request('/api/runs'),
  ]);
  const instance = JSON.parse(detail), files = JSON.parse(pull), pulledLog = files.find(f => f.path === `${path}/log.jsonl`);
  assert.deepEqual(instance.doc, { rev: 1, status: 'deleted', items: [] });
  assert.deepEqual(JSON.parse(trace), [], 'not even a trace left on disk before cleanup');
  assert.equal(file, 'the instance was deleted');
  assert.equal(preview, file);
  assert.deepEqual(files.map(f => f.path).sort(), ['instance.json', 'log.jsonl', 'screen.json'].map(f => `${path}/${f}`));
  assert.equal(pulledLog.url, undefined, 'pull serves inline metadata, not the raw file');
  assert.equal(pulledLog.size, Buffer.byteLength(pulledLog.text));
  assert.deepEqual({ log: instance.log, pulled: JSON.parse(pulledLog.text), run: JSON.parse(runs).find(r => r.path === path) },
    { log: [tombstone], pulled: tombstone, run: { path, ...row } });
});
