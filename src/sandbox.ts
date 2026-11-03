import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { existsSync, rmSync } from 'node:fs';
import { readJson } from './system.ts';
import { passUpgrade } from './browsers.ts';

// Each run is a bubblewrap sandbox with no network of its own (bin/sandbox/node starts Pi in it, with sandboxArgs). Its one way
// out is the socket served here, which socat inside offers at 127.0.0.1:PORT:
// - /agent/…: the agent API, as the run (rf);
// - /model/<token>/…: the model, with the key added here, so no key is ever inside;
// - /browser/<token>/<id>: the CDP websocket of a browser the run opened (rf browser open), passed to the browser service;
// - CONNECT: an HTTPS proxy that lets through only the hosts allowed below or in .rf/egress.json, never to a private address,
//   and logs each host a run asks for.

export const PORT = 7000;

const ALLOWED = [
  'pypi.org', 'files.pythonhosted.org', 'astral.sh', '*.astral.sh', 'registry.npmjs.org',
  'github.com', '*.github.com', '*.githubusercontent.com',
  'docs.python.org', '*.readthedocs.io', 'pandas.pydata.org', 'nodejs.org', 'developer.mozilla.org', 'learn.microsoft.com',
];
const MODEL_URL = process.env.RF_MODEL_URL ?? 'https://openrouter.ai/api';

const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');
const isPrivate = (a: { address: string; family: number }) => {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a.address)?.[1];
  return v4 ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4');
};

export const allowed = (host: string) =>
  [...ALLOWED, ...readJson<string[]>('egress.json', [])].some(p => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));

// What the server knows of a run, by its token.
export type SandboxRun = { egress(host: string, allowed: boolean): void; owns(browser: string): boolean };

export function serveSandboxes(path: string, o: { agent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>; run(token: string): SandboxRun | undefined }) {
  if (existsSync(path)) rmSync(path);
  // What comes in here is the agent's to shape, so a request the server can't parse is refused, never thrown.
  const server = createServer(async (req, res) => {
    const url = URL.parse(req.url!, 'http://sandbox');
    if (!url) return void res.writeHead(400).end();
    if (url.pathname.startsWith('/agent/') || url.pathname.startsWith('/api/')) return o.agent(req, res, url);
    const [, root, token, ...rest] = url.pathname.split('/');
    if (root !== 'model' || !o.run(token)) return void res.writeHead(404).end();
    const target = new URL(`${MODEL_URL}/${rest.join('/')}${url.search}`);
    const up = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host, authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, ...(req.headers['x-api-key'] && { 'x-api-key': process.env.OPENROUTER_API_KEY }) },
    }, r => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    up.on('error', e => res.headersSent ? res.destroy() : res.writeHead(502).end(e.message));
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const [, root, token, id] = URL.parse(req.url!, 'http://sandbox')?.pathname.split('/') ?? [];
    try {
      if (root !== 'browser' || !o.run(token)?.owns(id)) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    } catch (e) {
      return socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${(e as Error).message}\n`);
    }
    passUpgrade(req, socket, head, `/sessions/${id}/cdp`);
  });
  server.on('connect', async (req: IncomingMessage, client, head: Buffer) => {
    let up: ReturnType<typeof connect> | undefined;
    client.on('error', () => up?.destroy());
    const token = Buffer.from(String(req.headers['proxy-authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString().split(':')[1];
    const run = o.run(token ?? ''), [host, port] = req.url!.split(':');
    const refuse = (why: string) => client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${why}\n`);
    if (!run) return refuse('no run for this token');
    const listed = allowed(host) && port === '443';
    const addresses = listed ? await lookup(host, { all: true }).catch(() => []) : [];
    const open = addresses.length > 0 && !addresses.some(isPrivate);
    run.egress(host, open);
    if (!open) return refuse(listed ? `${host} resolves to no public address` : `${host} is not on the sandbox's allowlist; an admin adds hosts in .rf/egress.json`);
    up = connect(443, addresses[0].address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up!.write(head);
      up!.pipe(client);
      client.pipe(up!);
    });
    up.on('error', () => client.destroy());
  });
  server.listen(path);
  return server;
}

// bubblewrap's arguments for a run: the system read-only, `ro` read-only and `rw` writable at their own paths, HOME and /tmp on
// the run's scratch, the socket's folder at /run/rf, and `env` as its whole environment. Nothing else of the host is there.
// The run's data is a tree of its own under /work, read-only but for the binds in rw, each [host path, path inside].
export function sandboxArgs(o: { cwd: string; socketDir: string; home: string; tmp: string; ro: string[]; work: { ro: [string, string][]; rw: [string, string][] }; env: Record<string, string> }): string[] {
  const bind = (flag: string, paths: string[]) => paths.flatMap(p => [flag, p, p]);
  return [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/bin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    ...bind('--ro-bind', ['/etc/ssl', '/etc/ca-certificates', '/etc/fonts', '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/mime.types'].filter(existsSync)),
    '--proc', '/proc', '--dev', '/dev', '--bind', o.tmp, '/tmp', '--bind', o.home, o.home, '--ro-bind', o.socketDir, '/run/rf',
    ...bind('--ro-bind', o.ro),
    '--tmpfs', '/work', ...o.work.ro.flatMap(([src, dst]) => ['--ro-bind', src, dst]), ...o.work.rw.flatMap(([src, dst]) => ['--bind', src, dst]), '--remount-ro', '/work',
    ...Object.entries({ ...o.env, HOME: o.home, TMPDIR: '/tmp' }).flatMap(([k, v]) => ['--setenv', k, v]),
    '--chdir', o.cwd,
  ];
}
