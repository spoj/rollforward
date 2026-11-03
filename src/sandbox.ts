import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, connect, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { lookup } from 'node:dns/promises';
import { TLSSocket } from 'node:tls';
import { join } from 'node:path';
import { agentRoot } from './agent.ts';
import { readJson } from './system.ts';
import { serveBrowsers, upgradeBrowser, type Browsers } from './browsers.ts';
import { contextFor } from './ca.ts';

// Each run is a bubblewrap sandbox with no network of its own (bin/sandbox/node starts Pi in it, with sandboxArgs). Its one way
// out is a socket of its own served here, which socat inside offers at 127.0.0.1:PORT:
// - /agent/…: the agent API, as the run (rf);
// - /model/<token>/…: the model, with the key added here, so no key is ever inside;
// - /browsers/<token>/<NAME>: the run's browser on the website NAME, $RF_BROWSERS/NAME (see browsers.ts);
// - CONNECT: an HTTPS proxy that lets through only the hosts allowed below or in .rf/egress.json, never to a private address,
//   and logs each host a run asks for; but a connection's host, or a link one's answer gave the run, it ends here, as that host,
//   for the run to forward each request (connections.ts).

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
export type SandboxRun = { egress(host: string, allowed: boolean): void; browsers(): Browsers; intercepts(host: string): boolean; call(host: string, req: IncomingMessage, res: ServerResponse): Promise<void> };

// A run's own socket, which only its sandbox holds: what comes in on it is that run's alone, so its token, which the agent sees and
// may print where another run reads it, opens nothing from elsewhere. The sockets `cli.ts try` and the tests listen on are shared.
const bound = new WeakMap<object, string>(), own = new Map<string, NetServer>();
let sandboxes: ReturnType<typeof createServer>;
export function listenRun(path: string, token: string) {
  own.set(token, createNetServer(s => { bound.set(s, token); sandboxes.emit('connection', s); }).listen(path).unref());
}
export function unlistenRun(token: string) {
  own.get(token)?.close();
  own.delete(token);
}

export function serveSandboxes(o: { agent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>; run(token: string): SandboxRun | undefined }) {
  const runOf = (socket: object, token: string) => ((bound.get(socket) ?? token) === token ? o.run(token) : undefined);
  // What comes in here is the agent's to shape, so a request the server can't parse is refused, never thrown.
  const server = sandboxes = createServer(async (req, res) => {
    const url = URL.parse(req.url!, 'http://sandbox');
    if (!url) return void res.writeHead(400).end();
    if (url.pathname.startsWith('/agent/') || url.pathname.startsWith('/api/')) {
      const token = bound.get(req.socket);
      if (token && req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end('no run for this token');
      return o.agent(req, res, url);
    }
    const [, root, token, ...rest] = url.pathname.split('/'), run = runOf(req.socket, token);
    if (root === 'browsers' && run) return serveBrowsers(run.browsers(), `/browsers/${token}`, rest, req, res).catch(e => res.headersSent ? res.destroy() : res.writeHead(e.status ?? 500).end(e.message));
    if (root !== 'model' || !run) return void res.writeHead(404).end();
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
    const [, root, token, site, ...rest] = URL.parse(req.url!, 'http://sandbox')?.pathname.split('/') ?? [], run = runOf(socket, token);
    if (root !== 'browsers' || !run || !site || rest.length) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    upgradeBrowser(run.browsers(), site, req, socket, head);
  });
  server.on('connect', async (req: IncomingMessage, client, head: Buffer) => {
    let up: ReturnType<typeof connect> | undefined;
    client.on('error', () => up?.destroy());
    const token = Buffer.from(String(req.headers['proxy-authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString().split(':')[1];
    const run = runOf(client, token ?? ''), [host, port] = req.url!.split(':');
    const refuse = (why: string) => client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${why}\n`);
    if (!run) return refuse('no run for this token');
    if (port === '443' && run.intercepts(host)) {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) client.unshift(head);
      const tls = new TLSSocket(client, { isServer: true, secureContext: contextFor(host), ALPNProtocols: ['http/1.1'] });
      tls.on('error', () => client.destroy());
      return void createServer((q, s) => void run.call(host, q, s)).emit('connection', tls);
    }
    const listed = allowed(host) && port === '443';
    const addresses = listed ? await lookup(host, { all: true }).catch(() => []) : [];
    const open = addresses.length > 0 && !addresses.some(isPrivate);
    run.egress(host, open);
    if (!open) return refuse(listed ? `${host} resolves to no public address` : `${host} is not on the sandbox's allowlist; an admin adds hosts in .rf/egress.json`);
    // IPv4 where the host has it, as a machine with no IPv6 route fails an IPv6 connect.
    up = connect(443, (addresses.find(a => a.family === 4) ?? addresses[0]).address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up!.write(head);
      up!.pipe(client);
      client.pipe(up!);
    });
    up.on('error', () => client.destroy());
  });
  return server;
}

// The agent image's userland (agent.ts), read-only, with the host's users, whose uids the sandbox keeps: none of the host's programs.
export const userland = () => [
  ...['usr', 'etc', 'opt', 'var'].flatMap(d => ['--ro-bind', join(agentRoot, d), `/${d}`]),
  '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group',
];

// bubblewrap's arguments for a run: the agent's userland, `ro` read-only and `rw` writable at their own paths, HOME and /tmp on
// the run's scratch, the socket's folder at /run/rf, and `env` as its whole environment. Nothing else of the host is there.
// The run's data is a tree of its own under /work, read-only but for the binds in rw, each [host path, path inside].
export function sandboxArgs(o: { cwd: string; socketDir: string; home: string; tmp: string; ro: string[]; work: { ro: [string, string][]; rw: [string, string][] }; env: Record<string, string> }): string[] {
  const bind = (flag: string, paths: string[]) => paths.flatMap(p => [flag, p, p]);
  return [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    ...userland(),
    '--proc', '/proc', '--dev', '/dev', '--bind', o.tmp, '/tmp', '--bind', o.home, o.home, '--ro-bind', o.socketDir, '/run/rf',
    ...bind('--ro-bind', o.ro),
    '--tmpfs', '/work', ...o.work.ro.flatMap(([src, dst]) => ['--ro-bind', src, dst]), ...o.work.rw.flatMap(([src, dst]) => ['--bind', src, dst]), '--remount-ro', '/work',
    ...Object.entries({ ...o.env, HOME: o.home, TMPDIR: '/tmp' }).flatMap(([k, v]) => ['--setenv', k, v]),
    '--chdir', o.cwd,
  ];
}
