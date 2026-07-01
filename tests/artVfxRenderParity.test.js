import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOpLogCtx } from './helpers/mocks.js';

import critterArt from '/data/critter-art.json' with { type: 'json' };
import propArt from '/data/prop-art.json' with { type: 'json' };
import { buildArtRegistry } from '/engine/data/art.js';
import { drawUnifiedArt } from '/engine/render/ArtInterpreter.js';
import { drawPhasedEffect } from '/engine/render/VFXInterpreter.js';
import { VFX_DEFS } from '/engine/data/vfx.js';

// ── Golden draw-op parity for the shared render path ────────────────────────────
//
// The art editor preview and the game both draw through drawUnifiedArt; the VFX
// editor and game both draw through the VFXInterpreter. So "editor preview == game"
// reduces to: that one shared entry point is (a) DETERMINISTIC — no hidden global/
// wall-clock state — and (b) RESPONSIVE to its declared inputs (state, time,
// progress). If either breaks, a restructure silently changed what everyone renders.
//
// We snapshot the ordered op stream (geometry + transforms + paint styles) via an
// op-logging canvas rather than committing brittle pixel goldens.

const reg = buildArtRegistry({ critters: critterArt, props: propArt });
const sig = (def, state, now, transition) => {
  const ctx = createOpLogCtx();
  drawUnifiedArt(ctx, 26, '#7cc6a0', def, state, now, transition);
  return ctx._signature();
};

// (a) Determinism — every asset in every state renders identically twice at a fixed
// time. Catches any wall-clock/Math.random/global-state leak in the render path.
test('art render is deterministic for identical inputs (all assets × states)', () => {
  for (const [col, assets] of Object.entries(reg)) {
    for (const [id, def] of Object.entries(assets)) {
      for (const state of [undefined, ...(def.states || [])]) {
        const a = sig(def, state, 4242);
        const b = sig(def, state, 4242);
        assert.equal(a, b, `${col}/${id} state=${state} not deterministic`);
        assert.ok(a.length > 0, `${col}/${id} state=${state} emitted no ops`);
      }
    }
  }
});

// (b1) State responsiveness — the beetle's states must produce different draw
// streams (state overrides + visibleStates + per-state clips flow through the
// shared path). This is exactly what makes an editor state-swap match the game.
test('art render responds to state (beetle idle ≠ happy ≠ scared)', () => {
  const beetle = reg.critters.beetle;
  const idle = sig(beetle, 'idle', 4242);
  const happy = sig(beetle, 'happy', 4242);
  const scared = sig(beetle, 'scared', 4242);
  assert.notEqual(idle, happy, 'idle vs happy identical — state not applied');
  assert.notEqual(idle, scared, 'idle vs scared identical — state not applied');
});

// (b2) Time responsiveness — an asset with an ambient loop clip animates on the
// absolute clock, so two different times give two different streams.
test('art render responds to time for animated assets (ambient clip advances)', () => {
  const beetle = reg.critters.beetle; // has a "*" loop clip
  assert.ok(beetle.animations && beetle.animations['*'], 'beetle should have an ambient clip');
  const t0 = sig(beetle, 'idle', 0);
  const t1 = sig(beetle, 'idle', 400);
  assert.notEqual(t0, t1, 'ambient animation did not advance with time');
});

// (c) VFX: phased effects are deterministic at a fixed progress and responsive to
// progress — the same properties that make a VFX-editor scrub match the game.
test('vfx phased render is deterministic and progress-responsive', () => {
  const phased = Object.entries(VFX_DEFS).find(([, d]) => d.type === 'phased');
  assert.ok(phased, 'expected at least one phased VFX def');
  const [, def] = phased;
  const draw = (progress) => {
    const ctx = createOpLogCtx();
    drawPhasedEffect(ctx, 0, 0, def, progress, def.defaultScale || 26, 4242);
    return ctx._signature();
  };
  assert.equal(draw(0.3), draw(0.3), 'phased effect not deterministic at fixed progress');
  assert.notEqual(draw(0.0), draw(0.6), 'phased effect did not respond to progress');
});

// (d) Structural parity guard — both consumers of each render path must go through
// the shared engine entry point, never a private reimplementation.
test('editor preview + game both draw art through drawUnifiedArt', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  for (const rel of ['../editors/art/preview/preview.js', '../game/GardenRenderer.js']) {
    assert.match(read(rel), /drawUnifiedArt\(/, `${rel} must call drawUnifiedArt`);
  }
});

test('editor VFX preview + game both draw effects through the VFX interpreter/renderer', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  // VFX editor imports the interpreter entry points directly…
  assert.match(read('../editors/vfx/vfxEditor.js'), /VFXInterpreter\.js/, 'vfx editor must use VFXInterpreter');
  // …and the game draws effects via EffectsRenderer (which wraps the same interpreter).
  assert.match(read('../game/GardenRenderer.js'), /effectsRenderer\.|EffectsRenderer/, 'game must use EffectsRenderer');
});
