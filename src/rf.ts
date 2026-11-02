import { readFileSync } from 'node:fs';
import { request } from 'node:http';

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

let res;
if (cmd === 'show') res = await send('GET', 'workspace');
else if (cmd === 'put' && arg) res = await send('PUT', 'workspace', readFileSync(arg === '-' ? 0 : arg));
else if (cmd === 'say' && args.length >= 2) res = await send('POST', 'say', JSON.stringify({ args: args[1] === '-' ? [args[0], readFileSync(0, 'utf8')] : args }));
else if (cmd === 'skills') res = await send('GET', 'skills');
else if (cmd === 'settings') res = await send('GET', `settings?skill=${encodeURIComponent(args[0] ?? '')}`);
else if (['files', 'mail', 'browser', 'windows', 'wake'].includes(cmd) && args.length >= 1) res = await send('POST', cmd, JSON.stringify({ args }));
else {
  console.error('usage: rf show | rf put FILE | rf say THREAD TEXT|- | rf skills | rf settings [SKILL] | rf files list LINK|REF | rf files get LINK|REF FILE'
    + ' | rf mail find [--mailbox ADDRESS] [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | rf mail save ID [--mailbox ADDRESS] [--name REGEX] [--prefix TEXT]'
    + ' | rf browser open SITE | rf browser get SITE PATH FILE'
    + ' | rf windows open | rf windows run python|powershell FILE [--timeout SECONDS] | rf windows put FILE [PATH] | rf windows get PATH FILE | rf windows screenshot FILE | rf windows close'
    + ' | rf wake TARGET AT REASON [--label LABEL]');
  process.exit(2);
}
// rf browser open answers a path on the server's socket: the CDP address is that path here.
console.log(res.ok && cmd === 'browser' && args[0] === 'open' ? process.env.RF_URL!.replace(/^http/, 'ws') + res.text : res.text);
process.exitCode = res.ok ? 0 : 1;
