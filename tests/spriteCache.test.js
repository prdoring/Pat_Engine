// SpriteCache (engine/render/SpriteCache.js): a miss runs the draw callback and
// creates one backing canvas; a hit reuses the tile (no new canvas, no redraw); the
// cache is LRU-bounded (touch keeps an entry alive, overflow evicts the oldest); the
// DPR is folded into the backing store + the key; and an environment with no canvas
// reports not-capable and returns null so the caller can draw directly.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SpriteCache } from '/engine/render/SpriteCache.js';
import { createMockCtx } from './helpers/mocks.js';

// Shim a DOM so capable === true and tiles can be rasterized headlessly. Counts the
// canvases created (to prove a hit allocates nothing) and remembers the last ctx (to
// inspect the DPR pre-scale).
function shimDom(dpr = 2) {
  let created = 0;
  let lastCtx = null;
  globalThis.window = { devicePixelRatio: dpr };
  globalThis.document = {
    createElement() {
      created++;
      const ctx = createMockCtx();
      ctx._scaleArgs = null;
      ctx.scale = (sx, sy) => { ctx._scaleArgs = [sx, sy]; };
      lastCtx = ctx;
      return { width: 0, height: 0, getContext: () => ctx };
    },
  };
  return { count: () => created, lastCtx: () => lastCtx };
}

afterEach(() => { delete globalThis.window; delete globalThis.document; });

test('miss draws once + makes one canvas; identical key hits with no new work', () => {
  const dom = shimDom();
  const cache = new SpriteCache();
  let draws = 0;
  const draw = () => { draws++; };

  const a = cache.get('hero|red|24', 50, 50, draw);
  assert.ok(a && a.canvas, 'miss returns a tile with a canvas');
  assert.equal(draws, 1, 'draw callback ran once on the miss');
  assert.equal(cache.size, 1, 'one tile cached');
  const afterMiss = dom.count(); // probe canvas (capable) + the tile canvas

  const b = cache.get('hero|red|24', 50, 50, draw);
  assert.strictEqual(b, a, 'identical key returns the same tile');
  assert.equal(draws, 1, 'cache hit does not redraw');
  assert.equal(dom.count(), afterMiss, 'cache hit allocates no new canvas');
});

test('backing store is scaled by the (capped) DPR and the ctx is pre-scaled', () => {
  const dom = shimDom(2);
  const cache = new SpriteCache();
  const tile = cache.get('k', 40, 30, () => {});
  assert.equal(tile.canvas.width, 80, 'width = 40 logical × dpr 2');
  assert.equal(tile.canvas.height, 60, 'height = 30 logical × dpr 2');
  assert.equal(tile.dpr, 2, 'tile records the dpr it was rasterized at');
  assert.deepEqual(dom.lastCtx()._scaleArgs, [2, 2], 'ctx pre-scaled by dpr before draw');
});

test('DPR is capped by dprCap so backing stores stay bounded', () => {
  shimDom(4);
  const cache = new SpriteCache({ dprCap: 3 });
  const tile = cache.get('k', 10, 10, () => {});
  assert.equal(tile.dpr, 3, 'dpr 4 clamped to the cap of 3');
  assert.equal(tile.canvas.width, 30, '10 logical × capped dpr 3');
});

test('DPR is part of the key: same logical key re-rasterizes at a new DPR', () => {
  shimDom(1);
  const cache = new SpriteCache();
  let draws = 0;
  cache.get('same', 10, 10, () => { draws++; });
  assert.equal(draws, 1);
  // Simulate moving to a hi-dpi display: same logical key, different DPR → a miss.
  globalThis.window.devicePixelRatio = 2;
  cache.get('same', 10, 10, () => { draws++; });
  assert.equal(draws, 2, 'a DPR change invalidates the tile');
  assert.equal(cache.size, 2, 'both DPR variants are cached');
});

test('LRU: touch keeps an entry alive; overflow evicts the oldest', () => {
  shimDom();
  const cache = new SpriteCache({ max: 3 });
  const draws = {};
  const draw = (k) => cache.get(k, 8, 8, () => { draws[k] = (draws[k] || 0) + 1; });

  draw('A'); draw('B'); draw('C');           // fill to cap (3)
  draw('A');                                  // touch A → now most-recently used
  draw('D');                                  // overflow → evicts the oldest (B, not A)
  assert.equal(cache.size, 3, 'still bounded at max');

  draw('A');                                  // A survived the eviction → still a hit
  assert.equal(draws['A'], 1, 'A was not redrawn (kept alive by the touch)');
  draw('B');                                  // B was evicted → redraw
  assert.equal(draws['B'], 2, 'B was evicted and recomputed');
});

test('clear() drops every tile', () => {
  shimDom();
  const cache = new SpriteCache();
  cache.get('a', 8, 8, () => {});
  cache.get('b', 8, 8, () => {});
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0, 'all tiles dropped');
});

test('not capable (no document) → capable is false and get() returns null', () => {
  // No shimDom() here: Node has no document.
  const cache = new SpriteCache();
  assert.equal(cache.capable, false, 'no canvas environment → not capable');
  let draws = 0;
  const tile = cache.get('x', 10, 10, () => { draws++; });
  assert.equal(tile, null, 'returns null so the caller draws straight to the target');
  assert.equal(draws, 0, 'no draw attempted when not capable');
});
