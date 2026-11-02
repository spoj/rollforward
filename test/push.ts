import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The stand-in skills, and a folder's files as rf skill push sends them.
export const standIns = join(import.meta.dirname, 'skills');
export const filesOf = (dir: string) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile())
  .map(d => [relative(dir, join(d.parentPath, d.name)), readFileSync(join(d.parentPath, d.name)).toString('base64')]));
