import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { FILE_GB, SCOPE, scratch, TASKS, type View } from './runner.ts';
import { listenRun, PORT, sandboxArgs, unlistenRun } from './sandbox.ts';

const app = join(import.meta.dirname, '..');
const OUTPUT_BYTES = 8192;
// The host grants this token only read-only API access. Wait for the loopback bridge before starting the script.
const bridge = `
  socat TCP-LISTEN:${PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/rf/rf.sock >/dev/null &
  bridge=$!
  until (: </dev/tcp/127.0.0.1/${PORT}) 2>/dev/null; do
    kill -0 "$bridge" || exit 1
    sleep .01
  done
  exec "$@"
`;

// -I -S starts without workspace imports or site hooks. Restore import paths only after that, without processing .pth files.
const python = `
import sys, sysconfig
sys.argv = sys.argv[1:]
__file__ = sys.argv[0]
paths = sysconfig.get_paths('venv', vars={'base': '/opt/venv', 'platbase': '/opt/venv'})
sys.path[:0] = [__file__.rsplit('/', 1)[0], '/pylib']
sys.path.extend(dict.fromkeys((paths['purelib'], paths['platlib'])))
with open(__file__, 'rb') as f:
    code = compile(f.read(), __file__, 'exec')
exec(code)
`;

export async function runWakeCheck(o: { token: string; id: string; view: View; skills?: { id: string; dir: string }[]; script: string; signal: AbortSignal; checkpoint?: () => void }): Promise<{ decision: 'continue' | 'stop'; message: string }> {
  const { token, id, view, script, signal } = o, ext = posix.extname(script);
  if (ext !== '.py' && ext !== '.ts') throw new Error('unsupported script type');
  const run = join(scratch, 'runs', token), dir = join(run, 'socket');
  let listening = false, overflow = false;
  const chunks: Buffer[] = [];
  try {
    let code: number | null;
    try {
      signal.throwIfAborted();
      mkdirSync(dir, { recursive: true });
      const lib = lstatSync(view.pylib, { throwIfNoEntry: false })?.isDirectory();
      const mountedSkills = (o.skills ?? [])
        .filter(s => /^[a-z0-9][a-z0-9-]*$/.test(s.id) && existsSync(s.dir))
        .map(s => [realpathSync(s.dir), `/skills/${s.id}`] as [string, string]);
      const mounts = sandboxArgs({
        cwd: view.instance, socketDir: dir,
        ro: [[join(app, 'bin/rf'), '/app/bin/rf'], [join(app, 'src/rf.ts'), '/app/src/rf.ts'], ...(lib ? [[view.pylib, '/pylib'] as [string, string]] : [])],
        skills: mountedSkills,
        work: { ro: view.ro.filter(([src]) => existsSync(src)), rw: [] },
        env: {
          PATH: '/app/bin:/opt/venv/bin:/usr/local/bin:/usr/bin', LANG: 'C.UTF-8', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
          RF_URL: `http://127.0.0.1:${PORT}`, RF_TOKEN: token, RF_INSTANCE: id, RF_WORKING: `${view.instance}/working`, RF_SKILLS: '/skills',
          ...(view.env.RF_INDEX && { RF_INDEX: view.env.RF_INDEX }),
          PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      const input = Buffer.from(`${mounts.join('\0')}\0`);
      const server = listenRun(join(dir, 'rf.sock'), token);
      listening = true;
      await once(server, 'listening');
      const scope = (process.env.RF_SANDBOX_SCOPE ?? SCOPE).match(/\S+/g) ?? [];
      const [cmd, ...args] = [
        ...scope, 'env', '-i', 'bwrap', '--args', '3', '--',
        '/usr/bin/prlimit', `--nproc=${TASKS}`, `--fsize=${FILE_GB * 2 ** 30}`, '/bin/bash', '-c', bridge, 'wake-check',
        // --disable-sigusr1 alone still allows the script to open Node's inspector.
        ...(ext === '.py' ? ['/opt/venv/bin/python', '-I', '-S', '-B', '-c', python, script]
          : ['/usr/local/bin/node', '--disable-sigusr1', '--permission', '--allow-fs-read=*', '--allow-fs-write=*', '--allow-net', '--allow-child-process', '--', script]),
      ];
      signal.throwIfAborted();
      o.checkpoint?.();
      const child = spawn(cmd, args, {
        env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
        stdio: ['ignore', 'pipe', 'ignore', 'pipe'], signal, killSignal: 'SIGKILL',
      });
      // bwrap's PID namespace and --die-with-parent also end the bridge and the script's descendants.
      const closed = new Promise<number | null>(ok => child.once('close', ok));
      let failed = false, bytes = 0;
      child.on('error', () => { failed = true; });
      child.stdout!.on('data', (d: Buffer) => {
        bytes += d.length;
        if (bytes > OUTPUT_BYTES) { overflow = true; child.kill('SIGKILL'); }
        else chunks.push(d);
      });
      const fail = () => { failed = true; child.kill('SIGKILL'); };
      child.stdout!.on('error', fail);
      child.stdio[3]!.on('error', fail).end(input);
      code = await closed;
      signal.throwIfAborted();
      if (failed && !overflow) throw new Error('sandbox launch failed');
    } catch {
      if (signal.aborted) {
        const timeout = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
        throw new DOMException(timeout ? 'timed out' : 'interrupted', timeout ? 'TimeoutError' : 'AbortError');
      }
      throw new Error('could not start sandbox');
    }
    if (overflow) throw new Error('stdout exceeds 8 KiB');
    if (code !== 0) throw new Error('script did not exit successfully');
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const { decision, message } = JSON.parse(json);
      // One comma outside strings: JSON.parse alone would silently accept duplicate keys.
      if ((decision === 'continue' || decision === 'stop') && typeof message === 'string' && message.trim() && [...message].length <= 500
          && json.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""').split(',').length === 2) return { decision, message };
    } catch { /* Invalid UTF-8 or JSON. */ }
    throw new Error('invalid check result');
  } finally {
    try {
      if (listening) unlistenRun(token);
      rmSync(run, { recursive: true, force: true });
    } catch {
      throw new Error('could not clean up sandbox');
    }
  }
}
