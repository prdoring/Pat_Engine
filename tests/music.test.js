import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MusicDirector } from '/engine/audio/MusicDirector.js';

// Mock SoundManager recording the loop calls the director makes.
class MockSound {
  constructor() {
    this.ctx = { currentTime: 10 };
    this.started = []; this.fades = []; this.stops = [];
    this._h = 0;
  }
  resume() {}
  startUILoop(sound, opts) { const h = ++this._h; this.started.push({ sound, opts, h }); return h; }
  fadeLoop(h, target, secs) { this.fades.push({ h, target, secs }); }
  stopLoop(h, opts) { this.stops.push({ h, opts }); }
}

const SONG = {
  stems: [
    { name: 'a', sound: 'sndA', gain: 1.0 },
    { name: 'b', sound: 'sndB', gain: 0.8 },
    { name: 'c', sound: 'sndC', gain: 0.5 },
  ],
  intensity: { chill: { a: 1 }, full: { a: 1, b: 0.8, c: 0.25 } }, // absolute per-stem gains
  fadeSeconds: 2,
  masterLevel: 1, // unit tests assert the raw mix math (no headroom scaling)
};

test('startSong launches every stem silent on ONE shared downbeat', () => {
  const sm = new MockSound();
  const md = new MusicDirector(sm);
  assert.equal(md.startSong(SONG), true);

  assert.equal(sm.started.length, 3);
  for (const s of sm.started) assert.equal(s.opts.volume, 0, `${s.sound} starts silent`);
  const starts = new Set(sm.started.map(s => s.opts.startAt));
  assert.equal(starts.size, 1, 'all stems share one startAt');
  assert.equal([...starts][0], 10.06, 'startAt = now + lead-in');
  assert.ok(md.isPlaying());
});

test('startSong with no intensity fades all stems to full gain', () => {
  const sm = new MockSound();
  new MusicDirector(sm).startSong(SONG, { fadeSeconds: 3 });
  const target = name => sm.fades.find(f => f.h === sm.started.find(s => s.sound === name).h).target;
  assert.equal(target('sndA'), 1.0);
  assert.equal(target('sndB'), 0.8);
  assert.equal(target('sndC'), 0.5);
  assert.ok(sm.fades.every(f => f.secs === 3));
});

test('setIntensity crossfades stems to the absolute tier gains', () => {
  const sm = new MockSound();
  const md = new MusicDirector(sm);
  md.startSong(SONG);
  const hOf = name => sm.started.find(s => s.sound === name).h;
  sm.fades.length = 0; // ignore the start-fade

  md.setIntensity('chill');
  const chill = Object.fromEntries(sm.fades.map(f => [f.h, f.target]));
  assert.equal(chill[hOf('sndA')], 1.0);   // chill.a
  assert.equal(chill[hOf('sndB')], 0);     // absent → 0
  assert.equal(chill[hOf('sndC')], 0);
  assert.ok(sm.fades.every(f => f.secs === 2), 'uses song fadeSeconds');

  sm.fades.length = 0;
  md.setIntensity('full');
  const full = Object.fromEntries(sm.fades.map(f => [f.h, f.target]));
  assert.equal(full[hOf('sndA')], 1.0);    // full.a
  assert.equal(full[hOf('sndB')], 0.8);    // full.b
  assert.equal(full[hOf('sndC')], 0.25);   // full.c
  assert.equal(md.getIntensity(), 'full');
});

test('fadeStem targets one stem; stop tears down all', () => {
  const sm = new MockSound();
  const md = new MusicDirector(sm);
  md.startSong(SONG);
  const hB = sm.started.find(s => s.sound === 'sndB').h;
  sm.fades.length = 0;

  md.fadeStem('b', 0.3, 0.5);
  assert.deepEqual(sm.fades, [{ h: hB, target: 0.3, secs: 0.5 }]);

  md.stop({ fadeOut: 0.4 });
  assert.equal(sm.stops.length, 3);
  assert.ok(sm.stops.every(s => s.opts.fadeOut === 0.4));
  assert.equal(md.isPlaying(), false);
});

test('startSong replaces a playing song (idempotent)', () => {
  const sm = new MockSound();
  const md = new MusicDirector(sm);
  md.startSong(SONG);
  md.startSong(SONG);
  assert.equal(sm.stops.length, 3, 'prior song stopped before restart');
  assert.equal(sm.started.length, 6, 'second song started its 3 stems');
});
