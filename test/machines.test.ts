import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Instance } from '../src/store.ts';

test("a run's paths on its Windows machine stay inside that machine's session, never reaching the service's other calls", async () => {
  const seen: string[] = [];
  const service = createServer((req, res) => (seen.push(`${req.method} ${req.url}`), res.end(req.url === '/sessions' ? '{"id": "s1"}' : 'bytes')));
  await new Promise<void>(ok => service.listen(0, '127.0.0.1', ok));
  process.env.RF_MACHINES_URL = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const { Machines } = await import('../src/machines.ts');
  const m = new Machines({} as Instance, 0);
  for (const path of ['../../../sessions', 'C:\\work\\..\\..\\..\\s2\\files\\C:\\pay.csv', './x'])
    await assert.rejects(m.windowsGet(path), /a path without \. or \.\. in it/);
  await assert.rejects(m.windowsPut('../../s2/files/x', Buffer.from('x')), /a path without \. or \.\. in it/);
  assert.equal((await m.windowsGet('C:\\work\\%2e%2e\\out.txt')).toString(), 'bytes');
  assert.deepEqual(seen, ['POST /sessions', 'GET /sessions/s1/files/C%3A/work/%252e%252e/out.txt']);
  service.close();
});
