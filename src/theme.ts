import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The look of the page and the sign-in pages (docs/design.md): their layouts, under web/css, and a theme: the default's tokens,
// web/css/theme-default.css, or a deployment's own, which RF_THEME names by the absolute path of its stylesheet, kept outside the
// checkout. A theme of one's own draws on the default's tokens and gives those it changes; its logo is a .svg or .png of the same
// name beside it, if it has one. They are served before sign-in, as the sign-in pages wear them.
const sheets = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'css');
const own = process.env.RF_THEME && process.env.RF_THEME !== 'default' ? process.env.RF_THEME : '';
const files: Record<string, string> = { '/css/layout.css': 'layout.css', '/css/signin.css': 'signin.css', '/css/theme-default.css': 'theme-default.css' };

// A stylesheet by its address, else undefined; /css/theme.css is the default's, or the deployment's own on it.
export function stylesheet(path: string): string | undefined {
  if (path === '/css/theme.css') return own ? `@import url("/css/theme-default.css");\n${readFileSync(own, 'utf8')}` : stylesheet('/css/theme-default.css');
  return files[path] && readFileSync(join(sheets, files[path]), 'utf8');
}

export const themeLogo = own ? [['svg', 'image/svg+xml'], ['png', 'image/png']].map(([ext, type]) => ({ file: own.replace(/\.css$/, `.${ext}`), type })).find(l => existsSync(l.file)) : undefined;

// As the server starts: a theme that isn't there stops it.
export function checkTheme() {
  if (own && !(isAbsolute(own) && own.endsWith('.css') && existsSync(own) && statSync(own).isFile()))
    throw new Error(`RF_THEME is default, or the absolute path of a theme's .css file, not ${JSON.stringify(own)}`);
}
