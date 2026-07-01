import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Editor↔game sequence PARITY ────────────────────────────────────────────────
//
// The sequences editor preview and the in-game runtime now drive the *same*
// interpreter — engine/fx/FXSequenceRunner. Previously the editor re-implemented
// step execution and had drifted in six ways (positional SFX, the step×opts volume
// multiply, VFX offset angle-rotation, loop-stop by handle, full signal dispatch,
// repeat timing). This test pins that shared contract so neither consumer can drift
// again: what you hear/see in the editor is what the game does.
//
// It exercises the interpreter directly with recording sinks + mock timers, plus a
// structural guard that the editor still delegates (no private step interpreter).

const { FXSequenceRunner } = await import('/engine/fx/FXSequenceRunner.js');
const { VFX_DEFS } = await import('/engine/data/vfx.js');

const A_VFX = Object.keys(VFX_DEFS)[0]; // any real effect id so _spawnVfx doesn't early-return

// Sinks that record every call the runner makes, so we can assert the exact
// SFX / VFX / loop / signal stream a step produces.
function makeSinks() {
  const calls = [];
  let nextLoopId = 1;
  const sound = {
    playUI: (sound, opts) => calls.push({ k: 'playUI', sound, opts }),
    playPositional: (sound, x, y, opts) => calls.push({ k: 'playPositional', sound, x, y, opts }),
    startUILoop: (sound, opts) => { const id = nextLoopId++; calls.push({ k: 'startUILoop', sound, opts, id }); return id; },
    startLoop: (sound, x, y, opts) => { const id = nextLoopId++; calls.push({ k: 'startLoop', sound, x, y, opts, id }); return id; },
    stopLoop: (id, opts) => calls.push({ k: 'stopLoop', id, opts }),
  };
  const effects = {
    addGenericEffect: (vfxDef, x, y, opts) => calls.push({ k: 'vfx', x, y, opts }),
  };
  const signals = [];
  const onSignal = (name, data, opts) => signals.push({ name, data, opts });
  return { calls, signals, sound, effects, onSignal };
}

// ── SFX: positional routing + volume multiply (two former drift points) ──
test('sfx step is positional when x/y given, and multiplies step.volume × opts.volume', () => {
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  runner.playStep({ type: 'sfx', sound: 'chirp', volume: 0.5 }, { x: 10, y: 20, volume: 2 });
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.k, 'playPositional');       // editor used to always call playUI
  assert.deepEqual([c.sound, c.x, c.y], ['chirp', 10, 20]);
  assert.equal(c.opts.volume, 1);            // 0.5 × 2 — editor dropped the multiply
});

test('sfx step is UI (non-positional) when no x/y', () => {
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  runner.playStep({ type: 'sfx', sound: 'click' }, {});
  assert.equal(s.calls[0].k, 'playUI');
  assert.equal(s.calls[0].sound, 'click');
});

// ── SFX repeat with gap schedules on real timers ──
test('sfx repeat fires once immediately then one per repeatDelay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  runner.playStep({ type: 'sfx', sound: 'tick', repeat: 3, repeatDelay: 100 }, {});
  assert.equal(s.calls.length, 1);          // first fires now
  t.mock.timers.tick(100);
  assert.equal(s.calls.length, 2);
  t.mock.timers.tick(100);
  assert.equal(s.calls.length, 3);
});

// ── VFX: offset rotates by opts.angle (the headline former drift point) ──
test('vfx offset is rotated by entity angle', () => {
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  // offset (10,0) rotated by +90° → (0,10) around origin
  runner.playStep({ type: 'vfx', effect: A_VFX, offset: { x: 10, y: 0 } }, { x: 0, y: 0, angle: Math.PI / 2 });
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.k, 'vfx');
  assert.ok(Math.abs(c.x - 0) < 1e-9, `x≈0 got ${c.x}`);
  assert.ok(Math.abs(c.y - 10) < 1e-9, `y≈10 got ${c.y}`);
});

test('vfx offset applies unrotated when no angle', () => {
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  runner.playStep({ type: 'vfx', effect: A_VFX, offset: { x: 7, y: -3 } }, { x: 100, y: 200 });
  const c = s.calls[0];
  assert.deepEqual([c.x, c.y], [107, 197]);
});

// ── Loops stop by NAMED handle, not "all at once" (former drift point) ──
test('loopStop stops only the loop matching its handle', () => {
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  runner.playStep({ type: 'loopStart', sound: 'humA', handle: 'a' }, {});
  runner.playStep({ type: 'loopStart', sound: 'humB', handle: 'b' }, {});
  const idA = s.calls.find(c => c.sound === 'humA').id;
  runner.playStep({ type: 'loopStop', handle: 'a' }, {});
  const stops = s.calls.filter(c => c.k === 'stopLoop');
  assert.equal(stops.length, 1);            // editor stopped BOTH
  assert.equal(stops[0].id, idA);           // and it's the right one
  // 'b' is still live — stoppable independently
  runner.playStep({ type: 'loopStop', handle: 'b' }, {});
  assert.equal(s.calls.filter(c => c.k === 'stopLoop').length, 2);
});

// ── Signals forward verbatim, including ones the editor used to ignore ──
test('signal forwards arbitrary name + data + entity to onSignal', () => {
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  const entity = { id: 'e1' };
  runner.playStep({ type: 'signal', name: 'removeEntity' }, { entity });
  runner.playStep({ type: 'signal', name: 'setState', data: { state: 'happy' } }, { entity });
  assert.equal(s.signals.length, 2);
  assert.equal(s.signals[0].name, 'removeEntity');   // editor ignored this one
  assert.equal(s.signals[0].opts.entity, entity);    // entity rides along
  assert.deepEqual(s.signals[1].data, { state: 'happy' });
});

// ── Integration: a full real sequence schedules over time ──
test('play() runs a real positional sequence, delayed steps fire on schedule', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = makeSinks();
  const runner = new FXSequenceRunner(s.sound, s.effects, s.onSignal);
  const entity = { id: 'critter' };
  // critterPet: signal(setState) + vfx + sfx at delay 0, signal(clearState) at delay 900
  runner.play('critterPet', { x: 5, y: 6, entity });

  // Immediate steps have fired; the delayed clearState has not.
  assert.equal(s.signals[0].name, 'setState');
  assert.ok(s.calls.some(c => c.k === 'playPositional' && c.x === 5 && c.y === 6), 'positional sfx at 5,6');
  assert.ok(!s.signals.some(x => x.name === 'clearState'), 'clearState not yet');

  t.mock.timers.tick(1000);
  assert.ok(s.signals.some(x => x.name === 'clearState'), 'clearState fired after its delay');
});

// ── Structural guard: the editor must delegate, never re-implement stepping ──
test('sequences editor delegates to FXSequenceRunner (no private step interpreter)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../editors/sequences/sequencesEditor.js', import.meta.url)),
    'utf8',
  );
  assert.match(src, /import\s*\{\s*FXSequenceRunner\s*\}/, 'editor must import FXSequenceRunner');
  assert.match(src, /new FXSequenceRunner\(/, 'editor must instantiate the real runner');
  assert.doesNotMatch(src, /function executeStep\b/, 'editor must not define its own step interpreter');
});
