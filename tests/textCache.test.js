// fitParagraph memoization (engine/ui/TextCache.js): the fit is recomputed only on a
// cache miss, the cached object is reused on a hit, sub-pixel w/h jitter still hits,
// and the capped cache evicts the oldest entry without corrupting results.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitParagraph, wrapLines } from '/engine/ui/TextCache.js';

// A ctx stand-in that counts measureText calls so we can prove the cache skips work.
function countingCtx() {
  const ctx = {
    font: '',
    _calls: 0,
    measureText(s) { ctx._calls++; return { width: String(s).length * 8 }; },
  };
  return ctx;
}

test('wrapLines breaks on width and never returns an empty array', () => {
  const ctx = countingCtx();
  const lines = wrapLines(ctx, 'alpha bravo charlie delta', 16 * 8); // ~2 words/line at 8px/char
  assert.ok(lines.length > 1, 'wraps long text into multiple lines');
  assert.deepEqual(wrapLines(ctx, '', 100), [''], 'empty text yields a single empty line');
});

test('fitParagraph: identical args hit the cache (no new measureText, same object)', () => {
  const ctx = countingCtx();
  const box = { w: 200, h: 80, max: 30, min: 12, weight: 700, family: 'TestFont' };
  const text = 'memo-alpha bravo charlie delta echo foxtrot';
  const first = fitParagraph(ctx, text, box);
  const afterFirst = ctx._calls;
  assert.ok(afterFirst > 0, 'first fit measures text');
  const second = fitParagraph(ctx, text, box);
  assert.equal(ctx._calls, afterFirst, 'cache hit makes no new measureText calls');
  assert.strictEqual(second, first, 'cache hit returns the same object');
});

test('fitParagraph: sub-pixel w/h jitter still hits the same cache entry', () => {
  const ctx = countingCtx();
  const text = 'round-jitter one two three four';
  const a = fitParagraph(ctx, text, { w: 180, h: 50, max: 22, min: 12, family: 'JitterFont' });
  const calls = ctx._calls;
  const b = fitParagraph(ctx, text, { w: 180.3, h: 49.8, max: 22, min: 12, family: 'JitterFont' });
  assert.strictEqual(b, a, 'fractional w/h within rounding hit the same entry');
  assert.equal(ctx._calls, calls, 'no recompute for sub-pixel jitter');
});

test('fitParagraph: capped cache evicts oldest, recompute is deterministic', () => {
  const ctx = countingCtx();
  const box = { w: 150, h: 60, max: 24, min: 12, weight: 700, family: 'CapFont' };
  const original = fitParagraph(ctx, 'cap-oldest-entry', box);
  // Overflow the cache (cap is 200) with distinct keys → 'cap-oldest-entry' is evicted.
  for (let i = 0; i < 210; i++) fitParagraph(ctx, `cap-filler-${i}`, box);
  const before = ctx._calls;
  const recomputed = fitParagraph(ctx, 'cap-oldest-entry', box);
  assert.ok(ctx._calls > before, 'evicted entry is recomputed (measureText runs again)');
  assert.deepEqual(recomputed, original, 'recomputed fit equals the original (deterministic)');
});
