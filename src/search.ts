import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { derivedFile, HttpError } from './store.ts';
import type { View } from './runner.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..'), python = join(app, '.venv', 'bin', 'python'), exec = promisify(execFile);
const TEXT = /\.(csv|tsv|txt|md|json|py|sql|log|xml|html?)$/i, EXTRACTED = /\.(xlsx|xlsm|xls|xlsb|ods|eml|pdf|docx)$/i, MAX = 300;

// A file's text: a text file's own, else what extract.py reads of it, kept in derived/ by the file's hash so each is read once.
async function text(path: string): Promise<string> {
  if (TEXT.test(path)) return readFileSync(path, 'utf8');
  const out = derivedFile(createHash('sha256').update(readFileSync(path)).digest('hex'));
  if (!existsSync(out)) writeFileSync(out, (await exec(python, [join(app, 'src', 'extract.py'), path], { timeout: 120_000, maxBuffer: 256e6 })).stdout);
  return readFileSync(out, 'utf8');
}

// rf search PATTERN [FOLDER...]: the lines matching PATTERN, a regular expression in any case, in every file of every instance in
// the run's reach, workbooks, mail, PDFs and Word files by their text; FOLDERs, as the run sees them, narrow it.
export async function search(view: View, args: string[]): Promise<string> {
  const [pattern, ...folders] = args;
  if (!pattern) throw new HttpError(400, 'rf search PATTERN [FOLDER...]: PATTERN a regular expression, in any case; FOLDERs, from your working directory, narrow it, such as 2026-08-30 or ../Other series');
  const re = new RegExp(pattern, 'i'), within = folders.map(f => posix.resolve(view.cwd, f)), out: string[] = [];
  for (const [src, dst] of view.ro.filter(([src]) => existsSync(join(src, 'instance.json')))) {
    for (const d of ['upload', 'working'].filter(top => existsSync(join(src, top))).flatMap(top => readdirSync(join(src, top), { recursive: true, withFileTypes: true }))) {
      const path = join(d.parentPath, d.name), seen = posix.join(dst, relative(src, path)), shown = posix.relative(view.cwd, seen);
      if (!d.isFile() || !(TEXT.test(d.name) || EXTRACTED.test(d.name)) || /\/(\.venv|__pycache__|node_modules)\//.test(seen)) continue;
      if (within.length && !within.some(w => seen === w || seen.startsWith(`${w}/`))) continue;
      const lines = await text(path).then(t => t.split('\n'), (e: Error & { stderr?: string }) => [`(could not be read: ${(e.stderr || e.message).trim().split('\n').at(-1)})`]);
      lines.forEach((l, i) => re.test(l) && out.push(`${shown}${TEXT.test(d.name) ? `:${i + 1}` : ''}: ${l.slice(0, 300)}`));
      if (out.length > MAX) return `${out.slice(0, MAX).join('\n')}\n… more than ${MAX} lines: narrow the pattern or the folders`;
    }
  }
  return out.join('\n') || 'no match';
}
