import { readFileSync } from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
const arg = args.join(' ');
const headers = { authorization: `Bearer ${process.env.RF_TOKEN}` };
const url = `${process.env.RF_URL}/agent`;
const post = (path: string) => fetch(`${url}/${path}`, { method: 'POST', headers, body: JSON.stringify({ args }) });

let res: Response;
if (cmd === 'show') res = await fetch(`${url}/workspace`, { headers });
else if (cmd === 'put' && arg) res = await fetch(`${url}/workspace`, { method: 'PUT', headers, body: readFileSync(arg === '-' ? 0 : arg) });
else if (cmd === 'say' && args.length >= 2) res = await fetch(`${url}/say`, { method: 'POST', headers, body: JSON.stringify({ args: args[1] === '-' ? [args[0], readFileSync(0, 'utf8')] : args }) });
else if (cmd === 'skills') res = await fetch(`${url}/skills`, { headers });
else if (cmd === 'settings') res = await fetch(`${url}/settings?skill=${encodeURIComponent(args[0] ?? '')}`, { headers });
else if ((cmd === 'files' || cmd === 'mail' || cmd === 'flow' || cmd === 'wake') && args.length >= 1) res = await post(cmd);
else {
  console.error('usage: rf show | rf put FILE | rf say THREAD TEXT|- | rf skills | rf settings [SKILL] | rf files list LINK|REF | rf files get LINK|REF FILE'
    + ' | rf mail find [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | rf mail save ID [--name REGEX] [--prefix TEXT]'
    + ' | rf flow SKILL/FLOW [--var NAME=VALUE ...] | rf wake TARGET AT REASON [--label LABEL]');
  process.exit(2);
}
console.log(await res.text());
process.exitCode = res.ok ? 0 : 1;
