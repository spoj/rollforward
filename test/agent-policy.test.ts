import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const image = readFileSync(new URL('../agent/Containerfile', import.meta.url), 'utf8');

test('the image recipe omits Tesseract while retaining PDF text extraction, Office and Chinese fonts', () => {
  assert.doesNotMatch(image, /\btesseract-ocr\b/);
  for (const pkg of ['poppler-utils', 'libreoffice-calc-nogui', 'libreoffice-writer-nogui', 'fonts-noto-cjk']) {
    assert.ok(image.includes(pkg), pkg);
  }
});
