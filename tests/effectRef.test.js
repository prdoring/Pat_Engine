import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingCtx } from './helpers/mocks.js';

import { drawUnifiedArt, setEffectResolver } from '/engine/render/ArtInterpreter.js';
import { drawPhasedEffect } from '/engine/render/VFXInterpreter.js';

const persistent = {
  type: 'phased', lifecycle: 'persistent',
  phases: [{ layers: [{ primitive: 'filledCircle', color: '#fff', radius: 1, alpha: 1 }] }],
};

test('effectRef invokes the injected resolver and embeds the effect', () => {
  const ctx = createRecordingCtx();
  let asked = null;
  setEffectResolver((id) => { asked = id; return id === 'glowAura' ? persistent : null; });
  const art = { shapes: [{ type: 'effectRef', effect: 'glowAura', cx: 0, cy: 0, scale: 1 }] };
  drawUnifiedArt(ctx, 30, '#abc', art, null, 1000);
  assert.equal(asked, 'glowAura');
  assert.ok(ctx._draws > 0, 'embedded effect emitted draws');
  setEffectResolver(null);
});

test('effectRef with a missing effect draws nothing and does not throw', () => {
  const ctx = createRecordingCtx();
  setEffectResolver(() => null);
  const art = { shapes: [{ type: 'effectRef', effect: 'nope', cx: 0, cy: 0 }] };
  assert.doesNotThrow(() => drawUnifiedArt(ctx, 30, '#abc', art, null, 1000));
  assert.equal(ctx._draws, 0);
  setEffectResolver(null);
});

test('effectRef is a no-op when no resolver is set', () => {
  setEffectResolver(null);
  const ctx = createRecordingCtx();
  const art = { shapes: [{ type: 'effectRef', effect: 'anything', cx: 0, cy: 0 }] };
  assert.doesNotThrow(() => drawUnifiedArt(ctx, 30, '#abc', art, null, 1000));
  assert.equal(ctx._draws, 0);
});

test('scatter primitives render through drawPhasedEffect', () => {
  for (const primitive of ['scatterDots', 'scatterLines', 'scatterStrips']) {
    const ctx = createRecordingCtx();
    const def = { type: 'phased', lifecycle: 'persistent', phases: [{ layers: [{ primitive, count: 5 }] }] };
    drawPhasedEffect(ctx, 0, 0, def, null, 26, 1000, {});
    assert.ok(ctx._draws > 0, `${primitive} emitted draws`);
  }
});
