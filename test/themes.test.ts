import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page's look is a layout and a theme, under web/css: the layouts, the page's and the sign-in pages', name no colour of their
// own, so a theme changes them all, and the default theme gives every token they draw with, as any other theme here would.
const app = join(dirname(fileURLToPath(import.meta.url)), '..'), dir = join(app, 'web', 'css');
const read = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const layouts = ['layout.css', 'signin.css'], themes = readdirSync(dir).filter(f => /^theme-[a-z0-9-]+\.css$/.test(f));
const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const used = (css: string) => new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]));
// The words in what a property that paints is set to, beside its tokens and numbers, that aren't keywords: colours by name.
const PAINTS = /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|text-decoration(-color)?|fill|stroke|accent-color|caret-color)$/;
const PLAIN = new Set(['none', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'solid', 'dashed', 'dotted', 'double', 'inset', 'underline', 'overline', 'line-through', 'wavy', 'important']);
const named = (css: string) => [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].filter(([, prop]) => PAINTS.test(prop))
  .flatMap(([, prop, value]) => (value.replace(/var\([^)]*\)/g, ' ').replace(/-?[\d.]+[a-z%]*/gi, ' ').match(/[a-z][a-z-]*/gi) ?? []).filter(w => !PLAIN.has(w.toLowerCase())).map(w => `${prop}: ${w}`));

test('the layouts name no colour of their own, and the page has no style but the layout and the theme', () => {
  for (const f of layouts) {
    // A mask's colour is only its alpha.
    const colours = read(f).replace(/mask-image:[^;]+;/g, '').match(/#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/gi);
    assert.equal(colours, null, `${f} names ${colours?.join(', ')}`);
    assert.deepEqual(named(read(f)), [], `${f} names colours by name`);
  }
  const head = readFileSync(join(app, 'web', 'index.html'), 'utf8').split('</head>')[0];
  assert.doesNotMatch(head, /<style/);
  assert.match(head, /<link rel="stylesheet" href="\/css\/layout\.css">\s*<link rel="stylesheet" href="\/css\/theme\.css">/);
});

test('every theme gives every token the layouts draw with, every one the default gives, and every one it draws with itself', () => {
  assert.ok(themes.includes('theme-default.css'), `themes: ${themes.join(', ')}`);
  const own = new Set(layouts.flatMap(f => [...defined(read(f))]));
  const needed = new Set([...layouts.flatMap(f => [...used(read(f))]).filter(t => !own.has(t)), ...defined(read('theme-default.css'))]);
  for (const f of themes) {
    const has = defined(read(f));
    assert.deepEqual([...needed].filter(t => !has.has(t)), [], `${f} lacks these`);
    assert.deepEqual([...used(read(f))].filter(t => !has.has(t) && !own.has(t)), [], `${f} draws with these, which nothing gives`);
  }
});
