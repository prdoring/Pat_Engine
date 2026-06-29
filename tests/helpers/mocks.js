// Game-agnostic test mocks: a no-op Canvas2D context + camera. Enough to drive
// the art/VFX interpreters in Node and assert they don't throw on real assets.

const noop = () => {};
const mockGradient = () => ({ addColorStop: noop });

export function createMockCtx() {
  return {
    save: noop, restore: noop,
    translate: noop, rotate: noop, scale: noop, setTransform: noop, transform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, ellipse: noop, bezierCurveTo: noop, quadraticCurveTo: noop,
    rect: noop, roundRect: noop, clip: noop,
    fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 50 }),
    createRadialGradient: mockGradient, createLinearGradient: mockGradient,
    setLineDash: noop, getLineDash: () => [],
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    globalAlpha: 1, shadowColor: 'transparent', shadowBlur: 0,
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
  };
}

export function createMockCanvas(width = 1024, height = 768) {
  const ctx = createMockCtx();
  return { width, height, getContext: () => ctx, _ctx: ctx };
}

export function createMockCamera() {
  return {
    x: 0, y: 0,
    worldToScreen: (wx, wy) => ({ sx: wx, sy: wy }),
    getZoom: () => 1,
  };
}

// Like createMockCtx but counts drawing operations, so a headless test can assert
// "this render actually emitted draws" without rasterizing pixels. `ctx._draws` is the
// running count. Used by the shot-harness smoke test.
export function createRecordingCtx() {
  const ctx = createMockCtx();
  ctx._draws = 0;
  const count = (name, ret) => { ctx[name] = (...a) => { ctx._draws++; return ret; }; };
  for (const m of ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText',
                   'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'lineTo', 'bezierCurveTo',
                   'quadraticCurveTo']) count(m);
  ctx.drawImage = () => { ctx._draws++; };
  return ctx;
}
