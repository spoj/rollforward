import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prompt = readFileSync(new URL('../prompt.md', import.meta.url), 'utf8');
const image = readFileSync(new URL('../agent/Containerfile', import.meta.url), 'utf8');

test('agents must use native vision or OpenRouter, not local OCR or heavy host compute', () => {
  assert.match(prompt, /Do not run local OCR, including Tesseract, or install OCR engines/);
  assert.match(prompt, /Read images yourself.*cheaper vision model.*OpenRouter boundary/);
  assert.match(prompt, /Keep heavy compute off the rollforward host.*do not launch unbounded CPU parallelism/);
  assert.match(prompt, /Lightweight PDF text extraction.*small Python or tabular jobs are fine/);
});

test('the image recipe omits Tesseract while retaining PDF text extraction, Office and Chinese fonts', () => {
  assert.doesNotMatch(image, /\btesseract-ocr\b/);
  for (const pkg of ['poppler-utils', 'libreoffice-calc-nogui', 'libreoffice-writer-nogui', 'fonts-noto-cjk']) {
    assert.ok(image.includes(pkg), pkg);
  }
});
