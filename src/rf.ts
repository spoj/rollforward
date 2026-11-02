import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const arg = args.join(' ');
// node:http, not fetch, which gives up on an answer after 5 minutes: rf windows run waits as long as its script runs.
const send = (method: string, path: string, body?: string | Buffer) => new Promise<{ ok: boolean; text: string }>((ok, fail) => {
  const req = request(`${process.env.RF_URL}/agent/${path}`, { method, headers: { authorization: `Bearer ${process.env.RF_TOKEN}` } }, res => {
    const chunks: Buffer[] = [];
    res.on('data', c => chunks.push(c)).on('end', () => ok({ ok: res.statusCode! < 300, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', fail).end(body);
});

// FILE is a path under working/. rf reads and writes the files itself; they cross to the server as base64 (see agent-api.ts).
const local = (f: string) => join(process.env.RF_WORKING!, f.replace(/^working\//, ''));
const shown = (f: string) => `working/${f.replace(/^working\//, '')}`;
function save(f: string, data: string): string {
  mkdirSync(dirname(local(f)), { recursive: true });
  writeFileSync(local(f), Buffer.from(data, 'base64'));
  return shown(f);
}
// An attachment's name as a file name, with " (2)" and on if one is there already.
function free(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'download', dot = clean.lastIndexOf('.');
  let f = clean;
  for (let k = 2; existsSync(local(f)); k++) f = dot > 0 ? `${clean.slice(0, dot)} (${k})${clean.slice(dot)}` : `${clean} (${k})`;
  return f;
}
// The words that are neither --flags nor their values, as the server parses them.
const words = args.filter((w, i) => !w.startsWith('--') && !/^--[\w-]+$/.test(args[i - 1] ?? ''));
const upload = cmd === 'windows' ? ({ put: words[1], run: words[2] } as Record<string, string | undefined>)[words[0]] : undefined;
if (upload !== undefined && !existsSync(local(upload))) {
  console.log(`no ${shown(upload)}`);
  process.exit(1);
}

let res;
if (cmd === 'show') res = await send('GET', 'workspace');
else if (cmd === 'put' && arg) res = await send('PUT', 'workspace', readFileSync(arg === '-' ? 0 : arg));
else if (cmd === 'say' && args.length >= 2) res = await send('POST', 'say', JSON.stringify({ args: args[1] === '-' ? [args[0], readFileSync(0, 'utf8')] : args }));
else if (cmd === 'skills') res = await send('GET', 'skills');
else if (cmd === 'settings') res = await send('GET', `settings?skill=${encodeURIComponent(args[0] ?? '')}`);
else if (['files', 'mail', 'browser', 'windows', 'wake'].includes(cmd) && args.length >= 1) res = await send('POST', cmd, JSON.stringify({ args, ...(upload && { data: readFileSync(local(upload)).toString('base64') }) }));
else {
  console.error('usage: rf show | rf put FILE | rf say THREAD TEXT|- | rf skills | rf settings [SKILL] | rf files list LINK|REF | rf files get LINK|REF FILE'
    + ' | rf mail find [--mailbox ADDRESS] [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | rf mail save ID [--mailbox ADDRESS] [--name REGEX] [--prefix TEXT]'
    + ' | rf browser open SITE | rf browser get SITE PATH FILE'
    + ' | rf windows open | rf windows run python|powershell FILE [--timeout SECONDS] | rf windows put FILE [PATH] | rf windows get PATH FILE | rf windows screenshot FILE | rf windows close'
    + ' | rf wake TARGET AT REASON [--label LABEL]');
  process.exit(2);
}
let text = res.text;
// rf browser open answers a path on the server's socket: the CDP address is that path here.
if (res.ok && cmd === 'browser' && args[0] === 'open') text = process.env.RF_URL!.replace(/^http/, 'ws') + text;
else if (res.ok && text.startsWith('{')) {
  const { data, attachments, ...out } = JSON.parse(text);
  if (attachments) text = JSON.stringify({ saved: attachments.map((a: { name: string; data: string }) => save(free(a.name), a.data)) });
  else if (data !== undefined) text = Object.keys(out).length === 1 ? `saved ${save(out.saved, data)}` : JSON.stringify({ ...out, saved: save(out.saved, data) });
}
console.log(text);
process.exitCode = res.ok ? 0 : 1;
