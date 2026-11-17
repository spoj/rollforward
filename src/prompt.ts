import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.ts';
import { readJson, writeJson } from './system.ts';

// The agent's instructions, its system prompt: prompt.md as released, or the admins' own, which .rf/prompt.json keeps with who saved
// it, when, and the sha256 of the released one it was written over, so a release that changes prompt.md shows as one the saved
// text hasn't taken in. Each run reads the one there as it starts; a run going keeps its own.
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
// Instructions of more than this many characters are refused, as a mistake's.
const MAX_CHARS = 200_000;
type Saved = { text: string; by: string; at: string; base: string };
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const released = () => readFileSync(join(app, 'prompt.md'), 'utf8');
const saved = () => readJson<Saved | null>('prompt.json', null);

// The instructions a run starts with now, and whether they are the admins' own.
export function instructions(): { text: string; own: boolean } {
  const s = saved();
  return s ? { text: s.text, own: true } : { text: released(), own: false };
}

// As admins see them: the instructions runs start with, the released ones beside them, and, for their own, who saved them, when,
// and whether a release changed prompt.md since.
export function promptView() {
  const s = saved(), r = released();
  return { text: s?.text ?? r, released: r, ...(s && { own: { by: s.by, at: s.at, stale: s.base !== sha256(r) } }) };
}

// The admins' own instructions saved, or, with `text` null, gone, so runs start with the released ones again.
export function savePrompt(by: string, text: string | null) {
  if (text === null) return writeJson('prompt.json', null);
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text: the instructions, or {"reset": true} for the released ones');
  if (text.length > MAX_CHARS) throw new HttpError(413, `instructions hold ${MAX_CHARS} characters at most`);
  writeJson('prompt.json', { text, by, at: new Date().toISOString(), base: sha256(released()) });
}
