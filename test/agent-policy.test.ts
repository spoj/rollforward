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

test("before a heavy job agents check the host's load and memory, run it niced with two workers at most, and read video by key frames", () => {
  assert.match(prompt, /Before a long or heavy job, such as video.*check the host's load \(`\/proc\/loadavg`\) and free memory \(`free -g`\) first/);
  assert.match(prompt, /if it's busy, wait or do less\. Run it with `nice`, with at most two workers/);
  assert.match(prompt, /for video extract a few key frames with `ffmpeg` for a vision model/);
});

test('the image recipe omits Tesseract while retaining PDF text extraction, Office and Chinese fonts', () => {
  assert.doesNotMatch(image, /\btesseract-ocr\b/);
  for (const pkg of ['poppler-utils', 'libreoffice-calc-nogui', 'libreoffice-writer-nogui', 'fonts-noto-cjk']) {
    assert.ok(image.includes(pkg), pkg);
  }
});
