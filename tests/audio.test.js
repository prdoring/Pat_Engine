import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOUND_CONFIG, SoundId, SoundCategory } from '/engine/data/sounds.js';
import { EntityLoopManager } from '/engine/audio/EntityLoopManager.js';

// SoundManager itself needs a live AudioContext (absent in Node), so we test the
// pure/derivable parts: the data-derived sound registry, the sfx.json content
// regression guard, and the EntityLoopManager lifecycle via a fake soundManager.

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SFX_PATH = path.join(DATA, 'sfx.json');
const sfx = JSON.parse(fs.readFileSync(SFX_PATH, 'utf8'));

// ─── sounds.js (data-derived enums) ────────────────────────────────

test('sounds.js: SOUND_CONFIG loads from sfx.json with known ids', () => {
  assert.equal(typeof SOUND_CONFIG, 'object');
  assert.ok(Object.keys(SOUND_CONFIG).length > 0, 'no sounds loaded');
  assert.ok(SOUND_CONFIG.spawnChirp, 'spawnChirp present');
  assert.ok(SOUND_CONFIG.ambientMusic, 'ambientMusic present');
  assert.ok(SOUND_CONFIG.uiClick, 'uiClick present');
});

test('sounds.js: SoundId is derived id→id from config keys', () => {
  assert.equal(SoundId.spawnChirp, 'spawnChirp');
  assert.equal(SoundId.ambientMusic, 'ambientMusic');
  assert.equal(SoundId.uiClick, 'uiClick');
  // Exactly one SoundId per config key, no extras.
  assert.deepEqual(Object.keys(SoundId).sort(), Object.keys(SOUND_CONFIG).sort());
});

test('sounds.js: SoundCategory derives the project categories', () => {
  // sfx.json declares an explicit categories array — those must all resolve id→id.
  for (const c of ['ambient', 'critter', 'fx', 'ui']) {
    assert.equal(SoundCategory[c], c, `missing category ${c}`);
  }
  // Every sound's category is a known SoundCategory.
  for (const [id, cfg] of Object.entries(SOUND_CONFIG)) {
    assert.ok(SoundCategory[cfg.category], `${id}: category "${cfg.category}" not in SoundCategory`);
  }
});

test('sounds.js: loop flag is carried through from the data', () => {
  // The `loop` field now drives play/loop behavior in SoundManager.
  assert.equal(SOUND_CONFIG.ambientMusic.loop, true);
  assert.equal(SOUND_CONFIG.windLoop.loop, true);
  assert.equal(SOUND_CONFIG.critterHum.loop, true);
  assert.equal(SOUND_CONFIG.spawnChirp.loop, false);
  assert.equal(SOUND_CONFIG.uiClick.loop, false);
});

// ─── sfx.json content regression guard ─────────────────────────────

test('sfx.json: combat range fields are fully removed', () => {
  const banned = ['rangeScale', 'minRange', 'maxRange'];
  for (const [id, cfg] of Object.entries(sfx.sounds)) {
    for (const key of banned) {
      assert.ok(!(key in cfg), `${id} still has "${key}"`);
    }
  }
  // Belt-and-suspenders: the strings must not appear anywhere in the raw text.
  const raw = fs.readFileSync(SFX_PATH, 'utf8');
  for (const key of banned) {
    assert.ok(!raw.includes(key), `sfx.json text still mentions "${key}"`);
  }
});

// ─── EntityLoopManager lifecycle (fake soundManager stub) ──────────

/** Records every call so tests can assert the loop lifecycle. */
function makeFakeSound() {
  const calls = [];
  let nextHandle = 1;
  return {
    calls,
    startLoop(soundId, x, y, opts) {
      const h = nextHandle++;
      calls.push(['startLoop', soundId, x, y, opts, h]);
      return h;
    },
    updateLoop(handle, x, y, opts) { calls.push(['updateLoop', handle, x, y, opts]); },
    stopLoop(handle, opts) { calls.push(['stopLoop', handle, opts]); },
  };
}

const byKind = (sound, kind) => sound.calls.filter(c => c[0] === kind);

test('EntityLoopManager: start → update → stale cleanup', () => {
  const sound = makeFakeSound();
  const mgr = new EntityLoopManager(sound);

  // Frame 1: entity appears → startLoop.
  mgr.beginFrame();
  mgr.updateEntity('e1', 'critterHum', 10, 20, { volume: 1 });
  assert.equal(mgr.size, 1);
  assert.ok(mgr.has('e1'));
  assert.equal(byKind(sound, 'startLoop').length, 1);

  // Frame 2: same entity persists → updateLoop, no second startLoop.
  mgr.beginFrame();
  mgr.updateEntity('e1', 'critterHum', 30, 40, { volume: 0.5 });
  assert.equal(byKind(sound, 'startLoop').length, 1);
  const upd = byKind(sound, 'updateLoop')[0];
  assert.ok(upd, 'updateLoop was called');
  assert.equal(upd[2], 30, 'updateLoop x');
  assert.equal(upd[3], 40, 'updateLoop y');

  // Frame 3: entity not seen → cleanupStale stops it.
  mgr.beginFrame();
  mgr.cleanupStale({ fadeOut: 0.2 });
  assert.equal(mgr.size, 0);
  assert.ok(!mgr.has('e1'));
  const stop = byKind(sound, 'stopLoop')[0];
  assert.ok(stop, 'stopLoop called for stale entity');
  assert.deepEqual(stop[2], { fadeOut: 0.2 }, 'fadeOut opts forwarded');
});

test('EntityLoopManager: a live entity is NOT cleaned up', () => {
  const sound = makeFakeSound();
  const mgr = new EntityLoopManager(sound);
  mgr.beginFrame();
  mgr.updateEntity('e1', 's', 0, 0);
  // Next frame the entity is still seen.
  mgr.beginFrame();
  mgr.updateEntity('e1', 's', 1, 1);
  mgr.cleanupStale();
  assert.equal(mgr.size, 1, 'live entity should survive cleanup');
  assert.equal(byKind(sound, 'stopLoop').length, 0);
});

test('EntityLoopManager: stopEntity stops and forgets one loop', () => {
  const sound = makeFakeSound();
  const mgr = new EntityLoopManager(sound);
  mgr.beginFrame();
  mgr.updateEntity('a', 's', 0, 0);
  mgr.updateEntity('b', 's', 0, 0);
  assert.equal(mgr.size, 2);

  mgr.stopEntity('a', { fadeOut: 0.1 });
  assert.equal(mgr.size, 1);
  assert.ok(!mgr.has('a'));
  assert.ok(mgr.has('b'));
  assert.equal(byKind(sound, 'stopLoop').length, 1);
});

test('EntityLoopManager: stopAll clears everything', () => {
  const sound = makeFakeSound();
  const mgr = new EntityLoopManager(sound);
  mgr.beginFrame();
  mgr.updateEntity('a', 's', 0, 0);
  mgr.updateEntity('b', 's', 0, 0);
  mgr.stopAll();
  assert.equal(mgr.size, 0);
  assert.equal(byKind(sound, 'stopLoop').length, 2);
});

test('EntityLoopManager: a falsy startLoop handle is not tracked', () => {
  const sound = { startLoop: () => null, updateLoop() {}, stopLoop() {} };
  const mgr = new EntityLoopManager(sound);
  mgr.beginFrame();
  mgr.updateEntity('x', 's', 0, 0);
  assert.equal(mgr.size, 0, 'null handle must not be tracked');
});
