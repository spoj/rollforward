import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const legacy = new Set(['say', 'ask', 'propose', 'withdraw', 'note']);
const runRf = new Set(['rf', '/app/bin/rf']);
const id = /^[a-z0-9][a-z0-9-]*$/;
const comment = /^c[1-9]\d*$/, note = /^n[1-9]\d*$/;
const label = '(?!\\.{1,2}(?:/|$))[^/\\\\\\x00-\\x1f\\x7f\\x85\\u2028\\u2029]+';
const instancePath = new RegExp(`^(?:\\.|\\.\\./${label}|\\.\\./\\.\\./${label}/${label})$`);
const seriesPath = new RegExp(`^(?:\\.\\.|\\.\\./\\.\\./${label})$`);

type Word = { start: number; end: number; value: string; dynamic: boolean };
type Edit = { start: number; end: number; replacement: string };

// Arguments under the old argv parsers (4f5bec0:src/rf.ts), not the people's CLI. Preserve the spelling of
// retained shell words; in particular, quotes aren't part of their argv and don't hide an rf option.
function rewrite(verb: string, args: Word[], raw: (word: Word) => string): string | undefined {
  if (args.some(w => w.dynamic)) return;
  const options = new Map<string, Word>(), words: Word[] = [];
  const allowed = verb === 'note' ? ['--taken', '--aside', '--see'] : verb === 'withdraw' ? ['--see'] : ['--at', '--in', '--on', '--to'];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const flag = verb === 'withdraw' ? i === 1 && w.value === '--see' : allowed.includes(w.value);
    if (flag) {
      const v = args[++i];
      if (!v || !v.value.trim() || options.has(w.value)) return;
      options.set(w.value, v);
    } else {
      if (verb !== 'withdraw' && verb !== 'note' && /^--\w/.test(w.value)) return;
      words.push(w);
    }
  }
  const get = (flag: string) => options.get(flag)?.value;
  const see = get('--see');
  if (see && !comment.test(see)) return;
  const flags = (...names: string[]) => [...options].filter(([k]) => names.includes(k)).flatMap(([k, v]) => [k, raw(v)]);
  let head: string[];
  if (verb === 'withdraw') {
    const thread = words.shift();
    if (!thread || !comment.test(thread.value)) return;
    head = ['settle', raw(thread), 'withdrawn', ...flags('--see')];
  } else if (verb === 'note') {
    const taken = options.get('--taken'), aside = options.get('--aside');
    if (taken && aside || see && !taken) return;
    const target = taken ?? aside ?? words.shift();
    if (!target || (taken || aside ? !note.test(target.value) : !seriesPath.test(target.value))) return;
    head = taken || aside ? ['settle', raw(target), taken ? 'taken' : 'aside', ...flags('--see')] : ['comment', raw(target)];
  } else {
    const at = options.get('--at'), thread = get('--in'), on = get('--on'), to = get('--to');
    if (at && (verb === 'say' ? !instancePath.test(at.value) : at.value !== '.') ||
        thread && (on || !comment.test(thread)) || on && on.split(/@(.*)/s, 2).some(s => !s.trim()) ||
        to && (verb === 'say' || !/^[^\s@-][^\s@]*@[^\s@]+$/.test(to)) || on?.startsWith('-')) return;
    head = ['comment', at ? raw(at) : '.', ...(verb === 'say' ? [] : [`--${verb}`]), ...flags('--in', '--on', '--to')];
  }
  if (!words.map(w => w.value).join(' ').trim()) return;
  // parseArgs in the new CLI would otherwise interpret these old literal text words as options.
  if (words.some(w => w.value !== '-' && w.value.startsWith('-'))) head.push('--');
  return [...head, ...words.map(raw)].join(' ');
}

const shellExtension = new Set(['.sh', '.bash', '.zsh', '.ksh']);
const shellFence = /^(?:sh|bash|shell|zsh|ksh)$/i;
const dispatch = /^(?:sh|bash|zsh|ksh|dash|fish|env|sudo|xargs|eval|timeout|nice|nohup|source|time|node|busybox|parallel|find|ssh|su|runuser|setsid|trap|alias|\.)$/;
const rfPath = /(?:^|\/)rf(?:\.ts)?$/;
const removedInText = /(?:^|[^\w./-])(?:[\w./-]*\/)?rf(?:\.ts)?["'`]?[\t ,]+["'`]?(?:say|ask|propose|withdraw|note)(?![\w-])/m;
const indirectInText = /(?:^|[^\w./-])(?:[\w./-]*\/)?rf(?:\.ts)?["'`]?[\t ]+["']?\$(?!\s|$)/m;
const mention = (value: string) => removedInText.exec(value) ?? indirectInText.exec(value);

// Lex a deliberately small shell subset; no shell, interpreter, expansion or skill code is run.
function shell(source: string, offset: number, edits: Edit[], refuse: (at: number) => void) {
  let i = 0, words: Word[] = [], incomplete = false, redirection = false, complex = false, spacedAfterRedirect = false;
  const raw = (w: Word) => source.slice(w.start, w.end);
  const pendingHere: { word: Word; stripTabs: boolean }[] = [];
  let redirectTo: string | undefined;
  let depth = 0, caseDepth = 0, inTest = false;
  function finish(end: number, separator: string) {
    const rest = words;
    let p = 0;
    while (['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', '}'].includes(rest[p]?.value) && raw(rest[p]) === rest[p].value) p++;
    while (rest[p] && /^[a-zA-Z_]\w*=/.test(raw(rest[p]))) p++;
    if (['exec', 'command'].includes(rest[p]?.value)) {
      if (!rest[p + 1]?.value.startsWith('-')) p++;
      else if (rest[p + 1]?.value === '--') p += 2;
    }
    const exe = rest[p], verb = rest[p + 1];
    const args = rest.slice(p + 2);
    const from = exe?.start ?? end;
    if (exe?.value === 'case' && raw(exe) === exe.value) caseDepth++;
    if (exe?.value === 'esac' && raw(exe) === exe.value) caseDepth--;
    if (runRf.has(exe?.value)) {
      if (verb?.dynamic || !verb && separator === '(' || incomplete) refuse(offset + from);
      else if (verb && legacy.has(verb.value)) {
        // The people CLI takes WORKSPACE/SERIES; a run resolves the path relative to its own instance.
        const peopleNote = exe.value === 'rf' && verb.value === 'note' && args.length && args.every(w => !w.dynamic) &&
          /^[^./\s-][^/]*\/[^./][^/]*$/.test(args[0].value) && !args.some(w => /^--(?:taken|aside|see)$/.test(w.value));
        if (!peopleNote) {
          const replacement = complex || spacedAfterRedirect || inTest || caseDepth || redirectTo ? undefined : rewrite(verb.value, args, raw);
          if (replacement === undefined) refuse(offset + from);
          else edits.push({ start: offset + verb.start, end: offset + rest.at(-1)!.end, replacement });
        }
      }
    } else if (exe && (exe.dynamic && legacy.has(verb?.value) ||
        rfPath.test(exe.value) && (legacy.has(verb?.value) || verb?.dynamic) ||
        (complex || incomplete || inTest || exe.value === '$' || dispatch.test(basename(exe.value)) || exe.value === 'command' && verb?.value !== '-v' && verb?.value !== '-V') &&
        (mention(source.slice(from, end)) || rest.slice(p + 1).some((w, j, tail) => rfPath.test(w.value) && (tail[j + 1]?.dynamic || legacy.has(tail[j + 1]?.value)))))) {
      refuse(offset + from);
    }
    words = [];
    incomplete = redirection = complex = spacedAfterRedirect = false;
    redirectTo = undefined;
  }

  while (i < source.length) {
    if (source[i] === '\\' && /^\r?\n/.test(source.slice(i + 1, i + 3))) { i += source[i + 1] === '\r' ? 3 : 2; continue; }
    if (/[ \t\r]/.test(source[i])) { i++; continue; }
    if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    const redir = /^(?:[0-9]+)?(<<<|<<-|<<|>>|<&|>&|<>|>\||[<>])/.exec(source.slice(i, i + 20));
    if (redir) {
      if (redirectTo || !words.length || (redir[1] === '<' || redir[1] === '>') && source[i + redir[0].length] === '(') complex = true;
      i += redir[0].length;
      redirection = true;
      redirectTo = redir[1];
      continue;
    }
    const ch = source[i];
    if (/[;|&()\n]/.test(ch)) {
      // Reject rather than interpreting array literals and case patterns as executable commands.
      if (ch === '(' && words.some(w => /^[a-zA-Z_]\w*=/.test(w.value))) inTest = true;
      finish(i, ch);
      if (ch === '(') depth++;
      if (ch === ')' && --depth <= 0) { depth = 0; inTest = false; }
      i++;
      if (ch === '\n') for (const { word, stripTabs } of pendingHere.splice(0)) {
        const start = i;
        while (i < source.length) {
          const nl = source.indexOf('\n', i), next = nl < 0 ? source.length : nl + 1;
          const text = source.slice(i, nl < 0 ? next : nl).replace(/\r$/, '');
          i = next;
          if ((stripTabs ? text.replace(/^\t+/, '') : text) === word.value) break;
        }
        // An unquoted heredoc expands commands, so don't silently miss an rf buried in one.
        const found = raw(word) === word.value && mention(source.slice(start, i));
        if (found) refuse(offset + start + found.index);
      }
      continue;
    }

    const start = i;
    let value = '', quote = '', dynamic = false, hidden = false;
    while (i < source.length) {
      const c = source[i];
      if (!quote && /[ \t\r\n;|&()<>]/.test(c)) break;
      if (quote && c === quote) { quote = ''; i++; continue; }
      if (!quote && (c === '"' || c === "'")) { quote = c; i++; continue; }
      if (c === '\\' && quote !== "'") {
        const next = source[i + 1];
        if (next === '\n' || next === '\r' && source[i + 2] === '\n') { i += next === '\n' ? 2 : 3; continue; }
        if (next && (!quote || /["`$\\]/.test(next))) { value += next; i += 2; continue; }
      }
      if (quote !== "'" && (c === '$' || c === '`')) {
        dynamic = true;
        if (c === '`' || source[i + 1] === '(' || source[i + 1] === '{' || !quote && /["']/.test(source[i + 1] ?? '')) {
          // These can contain nested quoting or more commands; do not try to find a simple command inside them.
          hidden = true;
          i++;
          const stop = c === '`' ? '`' : source[i] === '(' ? ')' : source[i] === '{' ? '}' : source[i];
          if (c !== '`') i++;
          let nested = 1;
          for (; i < source.length; i++) {
            if (source[i] === '\\') { i++; continue; }
            if (stop === ')' && source[i] === '(') nested++;
            else if (source[i] === stop && !--nested) { i++; break; }
          }
          continue;
        }
      }
      if (!quote && /[*?\[\]{}~]/.test(c) && !(c === '{' && i === start && /\s/.test(source[i + 1] ?? '') || c === '}' && i === start)) dynamic = true;
      value += c;
      i++;
    }
    const word: Word = { start, end: i, value, dynamic };
    const found = hidden && mention(raw(word));
    if (found) refuse(offset + start + found.index);
    incomplete ||= !!quote;
    if (redirectTo) {
      if (redirectTo === '<<' || redirectTo === '<<-') pendingHere.push({ word, stripTabs: redirectTo === '<<-' });
      redirectTo = undefined;
    } else {
      spacedAfterRedirect ||= redirection;
      words.push(word);
    }
  }
  finish(i, '');
}

function convertFile(path: string, bytes: Buffer, refuse: (line: number) => void) {
  if (bytes.includes(0)) return bytes;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return bytes; }
  const edits: Edit[] = [];
  const at = (n: number) => refuse(text.slice(0, n).split('\n').length);
  const type = extname(path).toLowerCase();
  if (shellExtension.has(type) || /^#![^\n]*\b(?:sh|bash|dash|zsh|ksh)(?:\s|$)/.test(text)) shell(text, 0, edits, at);
  else if (type === '.md' || type === '.markdown') {
    // Only code spans and fenced examples, not prose, links or the YAML description.
    const front = /^---\r?\n[\s\S]*?^---[ \t]*\r?\n/m.exec(text);
    let start = front?.index === 0 ? front[0].length : 0;
    const inline = (end: number) => {
      for (const span of text.slice(start, end).matchAll(/(?<![\\`])(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g))
        shell(span[2], start + span.index + span[1].length, edits, at);
    };
    const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
    fence.lastIndex = start;
    for (let open; (open = fence.exec(text));) {
      inline(open.index);
      const body = fence.lastIndex + 1, tag = open[2].trim().split(/\s+/, 1)[0];
      let close;
      while ((close = fence.exec(text)) && !(close[1][0] === open[1][0] && close[1].length >= open[1].length && !close[2].trim())) { /* skip inner markers */ }
      const end = close?.index ?? text.length, code = text.slice(body, end);
      if (!tag || shellFence.test(tag)) shell(code, body, edits, at);
      else for (const line of code.matchAll(/^.*$/gm)) if (mention(line[0])) at(body + line.index);
      start = close ? fence.lastIndex + 1 : text.length;
      if (!close) break;
    }
    inline(text.length);
  } else if (/^(?:\.(?:py|js|ts|jsx|tsx|mjs|cjs|mts|cts|rb|pl|fish|lua|ps1|go|rs))$/.test(type) || text.startsWith('#!')) {
    for (const line of text.matchAll(/^.*$/gm)) if (mention(line[0])) at(line.index);
  }
  if (!edits.length) return bytes;
  let out = '', last = 0;
  for (const { start, end, replacement } of edits) { out += text.slice(last, start) + replacement; last = end; }
  return Buffer.from(out + text.slice(last));
}

type Item = { path: string; mode: number; bytes?: Buffer };
type Version = { pointer: string; previous: string; dir: string; target: string; version: number; items: Item[] };

export function planSkillMigration(root: string, progress?: (line: string) => void) {
  const { dev } = lstatSync(root);
  function pathIs(path: string, kind: 'file' | 'directory', optional = false) {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st && optional) return false;
    if (!st || st.dev !== dev || (kind === 'file' ? !st.isFile() || st.nlink !== 1 : !st.isDirectory()))
      throw new Error(`${path}: expected a private regular ${kind} (no links or other filesystems)`);
    return true;
  }
  const skills = join(root, 'skills'), live = join(skills, 'live'), versions = join(skills, 'versions');
  const ids = pathIs(skills, 'directory', true) && pathIs(live, 'directory', true) ? readdirSync(live).sort() : [];
  const plan: Version[] = [], problems = new Set<string>();
  let count = 0;
  for (const name of ids) {
    if (!id.test(name)) {
      if (name.endsWith('.new') && id.test(name.slice(0, -4))) throw new Error(`${name}: a skill publication is incomplete`);
      continue;
    }
    const pointer = join(live, name), st = lstatSync(pointer), directory = join(versions, name);
    const bad = () => { throw new Error(`${name}: invalid published skill`); };
    if (!st.isSymbolicLink() || !pathIs(versions, 'directory') || !pathIs(directory, 'directory') || st.dev !== lstatSync(live).dev) bad();
    const previous = readlinkSync(pointer), prior = Number(basename(previous));
    if (!Number.isSafeInteger(prior) || prior <= 0 || previous !== `../versions/${name}/${prior}`) bad();
    const current = join(directory, String(prior)), marker = join(current, '.pushed.json');
    pathIs(current, 'directory');
    pathIs(join(current, 'SKILL.md'), 'file');
    pathIs(marker, 'file');
    let pushed;
    try { pushed = JSON.parse(readFileSync(marker, 'utf8')); } catch { bad(); }
    if (pushed?.version !== prior || typeof pushed.by !== 'string' || typeof pushed.at !== 'string' || !Number.isFinite(Date.parse(pushed.at))) bad();
    count++;
    const items: Item[] = [];
    let changed = false;
    function scan(path: string) {
      const dir = join(current, path);
      const mode = lstatSync(dir).mode & 0o7777;
      if (mode & 0o6000) bad(); // Do not publish new setuid or setgid files/directories under a different owner.
      items.push({ path, mode });
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const rel = join(path, entry.name), file = join(current, rel);
        if (rel === '.pushed.json') continue;
        if (rel === '.pushed.json.tmp' || /[\x00-\x1f\x7f\x85\u2028\u2029]/.test(rel)) bad();
        if (entry.isDirectory()) { pathIs(file, 'directory'); scan(rel); continue; }
        pathIs(file, 'file');
        const mode = lstatSync(file).mode & 0o7777;
        if (mode & 0o6000) bad();
        const original = readFileSync(file), bytes = convertFile(rel, original, line => problems.add(`${name} ${rel}:${line}`));
        changed ||= bytes !== original;
        items.push({ path: rel, bytes, mode });
      }
    }
    scan('');
    if (!changed) continue;
    let highest = prior;
    for (const n of readdirSync(directory)) {
      const version = Number(n);
      if (!Number.isSafeInteger(version) || version <= 0 || String(version) !== n) bad();
      highest = Math.max(highest, version);
    }
    const version = highest + 1;
    if (!Number.isSafeInteger(version)) bad();
    plan.push({ pointer, previous, dir: join(directory, String(version)), version, target: `../versions/${name}/${version}`, items });
  }
  if (problems.size) throw new Error([...problems].join('\n'));
  progress?.(`Skills: ${count} live, ${plan.length} to rewrite`);
  for (const v of plan) progress?.(`  ${basename(v.pointer)}: ${basename(v.previous)} -> ${v.version}`);
  return plan;
}

export function publishSkillMigration(plan: Version[]) {
  const syncDir = (dir: string) => { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
  for (const v of plan) {
    for (const { path, mode, bytes } of v.items) {
      const file = join(v.dir, path);
      if (!bytes) mkdirSync(file, { mode: 0o700 });
      else {
        const fd = openSync(file, 'wx', 0o600);
        try { writeFileSync(fd, bytes); chmodSync(file, mode); fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    writeFileSync(join(v.dir, '.pushed.json'), JSON.stringify({ version: v.version, by: 'rf v0.8.0 migration', at: new Date().toISOString() }),
      { mode: 0o600, flag: 'wx', flush: true });
    for (const item of v.items.slice().reverse()) if (!item.bytes) {
      const dir = join(v.dir, item.path), fd = openSync(dir, 'r');
      try { chmodSync(dir, item.mode); fsyncSync(fd); } finally { closeSync(fd); }
    }
    syncDir(join(v.dir, '..'));
  }
  for (const v of plan) {
    symlinkSync(v.target, `${v.pointer}.new`);
    renameSync(`${v.pointer}.new`, v.pointer);
  }
  if (plan.length) syncDir(join(plan[0].pointer, '..'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [flag, data, ...rest] = process.argv.slice(2);
    if (flag !== '--check' || !data || rest.length) throw new Error('usage: node scripts/migrate-skills.ts --check DATA_ROOT');
    const root = resolve(data);
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('expected a real data directory');
    const plan = planSkillMigration(root, console.error);
    let bytes = 0, entries = 0;
    for (const v of plan) {
      bytes += v.items.reduce((n, item) => n + (item.bytes?.length ?? 0), 0);
      entries += v.items.length + 2; // .pushed.json and the new live link
    }
    console.log(bytes, entries);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
