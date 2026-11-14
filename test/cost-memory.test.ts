import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const mode of ['unterminated line', 'many events', 'JSON response', 'key metadata', 'generation metadata', 'server-call body']) test(`provider accounting uses bounded memory for ${mode}`, { timeout: 30_000 }, async () => {
  const script = `
    import { createServer, request } from 'node:http';
    import { once } from 'node:events';
    import { call, keyStatus, serverCall, upstreams } from ${JSON.stringify(new URL('../src/connections.ts', import.meta.url).href)};
    process.env.OPENROUTER_API_KEY = 'test-key';
    const mode = ${JSON.stringify(mode)};
    const provider = createServer(async (req, res) => {
      req.resume();
      const json = !['unterminated line', 'many events'].includes(mode);
      if (req.url.startsWith('/api/v1/generation') && mode !== 'generation metadata') return void res.end('{"data":{"total_cost":0.123}}');
      if (mode === 'generation metadata' && !req.url.startsWith('/api/v1/generation')) return void res.writeHead(200, { 'content-type': 'application/json', 'x-generation-id': 'gen-memory' }).end('{"usage":{"input_tokens":1}}');
      res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/event-stream', 'x-generation-id': 'gen-memory' });
      if (json) res.write('{"text":"');
      const chunk = mode !== 'many events' ? 'x'.repeat(32768) : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(32768) } }] }) + '\\n\\n';
      for (let i = 0; i < 4096; i++) if (!res.write(chunk)) await once(res, 'drain');
      res.end(json ? '","usage":{"cost":0.123},"data":{"usage":1,"total_cost":0.123}}' : '\\n\\ndata: {"usage":{"cost":0.123}}\\n\\n');
    }).listen(0, '127.0.0.1');
    await once(provider, 'listening');
    upstreams['openrouter.ai'] = 'http://127.0.0.1:' + provider.address().port;
    if (mode === 'key metadata') {
      await keyStatus();
    } else if (mode === 'server-call body') {
      await serverCall('openrouter', '/api/v1/chat/completions', {}, { kind: 'website-check', site: 'test', person: 'a@test' }).catch(e => { if (e.message !== 'provider response exceeds 8 MiB') throw e; });
    } else {
    let cost, finished;
    const done = new Promise(resolve => finished = resolve);
    const inst = { id: 'memory', log: [{ seq: 1, op: 'create', by: 'a@test' }], append: (_by, _op, data) => { cost = data.cost; } };
    const proxy = createServer(async (req, res) => { await call({ inst, n: 1, links: new Map(), cost: 0 }, 'openrouter.ai', req, res); finished(); });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/api/v1/chat/completions', headers: { 'content-type': 'application/json' } }, res => {
        res.resume(); res.on('end', resolve); res.on('error', reject);
      }).on('error', reject).end('{}');
    });
    await done;
    if (mode === 'generation metadata' ? !(cost > 0) : cost !== 0.123) throw new Error('lost terminal cost: ' + cost);
    proxy.close();
    }
    if (process.resourceUsage().maxRSS > 220 * 1024) throw new Error('accounting retained response buffers: ' + process.resourceUsage().maxRSS);
    provider.close();
  `;
  const { stderr } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], { timeout: 25_000 });
  assert.equal(stderr, '');
});
