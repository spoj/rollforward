import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const mode of ['unterminated line', 'many events']) test(`SSE accounting uses bounded memory for ${mode}`, { timeout: 30_000 }, async () => {
  const script = `
    import { createServer, request } from 'node:http';
    import { once } from 'node:events';
    import { call, upstreams } from ${JSON.stringify(new URL('../src/connections.ts', import.meta.url).href)};
    process.env.OPENROUTER_API_KEY = 'test-key';
    const provider = createServer(async (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = ${JSON.stringify(mode)} === 'unterminated line' ? 'x'.repeat(32768) : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(32768) } }] }) + '\\n\\n';
      for (let i = 0; i < 4096; i++) if (!res.write(chunk)) await once(res, 'drain');
      res.end('\\n\\ndata: {"usage":{"cost":0.123}}\\n\\n');
    }).listen(0, '127.0.0.1');
    await once(provider, 'listening');
    upstreams['openrouter.ai'] = 'http://127.0.0.1:' + provider.address().port;
    let cost;
    const inst = { id: 'memory', log: [{ seq: 1, op: 'create', by: 'a@test' }], append: (_by, _op, data) => { cost = data.cost; } };
    const proxy = createServer(async (req, res) => { await call({ inst, n: 1, links: new Map(), cost: 0 }, 'openrouter.ai', req, res); });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/api/v1/chat/completions', headers: { 'content-type': 'application/json' } }, res => {
        res.resume(); res.on('end', resolve); res.on('error', reject);
      }).on('error', reject).end('{}');
    });
    if (cost !== 0.123) throw new Error('lost terminal cost: ' + cost);
    proxy.close(); provider.close();
  `;
  const { stderr } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], { timeout: 25_000 });
  assert.equal(stderr, '');
});
