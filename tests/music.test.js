import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MusicDirector } from '/engine/audio/MusicDirector.js';
import { addStem, renameStem } from '/editors/musicModel.js';

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
  updateMidiLoopNotes(h, notes, loopLen) { this.noteUpdates ??= []; this.noteUpdates.push({ h, notes, loopLen }); return true; }
  seekMidiLoop(h, phase) { this.seeks ??= []; this.seeks.push({ h, phase }); return true; }
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

// ─── Editable JSON note patterns (piano-roll path) ───

const TEMPO_SONG = {
  bpm: 120, beatsPerBar: 4, bars: 2,            // loop = 8 beats = 4s at 120 BPM
  stems: [
    { name: 'bass', sound: 'sndA', gain: 1, notes: [{ beat: 0, len: 1, midi: 36, vel: 0.8 }, { beat: 2, len: 1, midi: 38, vel: 0.7 }] },
    { name: 'lead', sound: 'sndB', gain: 0.8, notes: [{ beat: 1, len: 0.5, midi: 72, vel: 0.9 }] },
  ],
  masterLevel: 1,
};

test('startSong hands each stem its notes (beats→seconds) + the shared loop length', () => {
  const sm = new MockSound();
  const md = new MusicDirector(sm);
  assert.equal(md.startSong(TEMPO_SONG), true);

  const bass = sm.started.find(s => s.sound === 'sndA');
  assert.ok(Array.isArray(bass.opts.notes), 'bass got an inline notes array');
  // beat 2 at 120 BPM = 1.0s; len 1 beat = 0.5s
  assert.equal(bass.opts.notes[1].time, 1.0);
  assert.equal(bass.opts.notes[1].duration, 0.5);
  assert.equal(bass.opts.notes[0].midi, 36);
  assert.equal(bass.opts.loopLen, 4); // 8 beats * 0.5s
  // all stems share one loop length + downbeat
  const lead = sm.started.find(s => s.sound === 'sndB');
  assert.equal(lead.opts.loopLen, 4);
  assert.equal(bass.opts.startAt, lead.opts.startAt);
});

test('updateStemNotes live-updates a playing stem (no restart)', () => {
  const sm = new MockSound();
  const md = new MusicDirector(sm);
  md.startSong(TEMPO_SONG);
  const hBass = sm.started.find(s => s.sound === 'sndA').h;

  const ok = md.updateStemNotes('bass', [{ beat: 0, len: 2, midi: 40, vel: 1 }]);
  assert.equal(ok, true);
  assert.equal(sm.noteUpdates.length, 1);
  assert.equal(sm.noteUpdates[0].h, hBass);
  assert.equal(sm.noteUpdates[0].notes[0].time, 0);
  assert.equal(sm.noteUpdates[0].notes[0].duration, 1.0); // 2 beats * 0.5s
  assert.equal(sm.noteUpdates[0].loopLen, 4);
});

test('swapStemSound swaps one stem in phase without restarting the others', () => {
  const sm = new MockSound(); // ctx.currentTime = 10
  const md = new MusicDirector(sm);
  md.startSong(TEMPO_SONG); // startAt 10.06, loopLen 4
  const oldBass = sm.started.find(s => s.sound === 'sndA').h;
  const leadCount = sm.started.length;
  sm.fades.length = 0;

  assert.equal(md.swapStemSound('bass', 'sndZ', TEMPO_SONG, 0.5), true);
  const swapped = sm.started.find(s => s.sound === 'sndZ');
  assert.ok(swapped, 'started a loop for the new sound');
  assert.ok(swapped.opts.startAt < 10, `joins on a past downbeat (in phase): ${swapped.opts.startAt}`);
  assert.ok(Array.isArray(swapped.opts.notes), 'carries the stem notes');
  assert.equal(swapped.opts.loopLen, 4);
  // only the bass stem's old loop was stopped — the lead keeps playing untouched
  assert.deepEqual(sm.stops.map(s => s.h), [oldBass]);
  assert.equal(sm.started.length, leadCount + 1, 'exactly one new loop (no full restart)');
  assert.equal(md.handles.get('bass'), swapped.h, 'handle now points at the new voice');
  assert.ok(sm.fades.some(f => f.h === swapped.h && f.target === 0.5), 'new voice fades to the target gain');
});

test('seekTo moves the whole song without restarting and getPhase follows', () => {
  const sm = new MockSound(); // ctx.currentTime = 10
  const md = new MusicDirector(sm);
  md.startSong(TEMPO_SONG); // loopLen 4
  const startedBefore = sm.started.length;

  assert.equal(md.seekTo(0.5), true);
  assert.ok(Math.abs(md.getPhase() - 0.5) < 1e-6, `phase ${md.getPhase()}`); // _startAt = 10 - 0.5*4 = 8
  assert.equal(sm.seeks.length, 2, 'repositions both stems');
  assert.ok(sm.seeks.every(s => s.phase === 0.5));
  assert.equal(sm.started.length, startedBefore, 'no new loops — no restart');
});

test('getPhase reports 0..1 for a tempo song and null when stopped or untimed', () => {
  const sm = new MockSound(); // ctx.currentTime = 10
  const md = new MusicDirector(sm);
  md.startSong(TEMPO_SONG); // startAt = 10.06, loopLen = 4
  const p = md.getPhase();
  assert.ok(p >= 0 && p < 1, `phase ${p}`);
  md.stop();
  assert.equal(md.getPhase(), null, 'null once stopped');

  md.startSong(SONG); // legacy song, no bpm → no loop length
  assert.equal(md.getPhase(), null, 'null when the song has no tempo');
});

test('a song assembled via the music-editor helpers starts cleanly through the director', () => {
  // Exercises the editor's output end-to-end: stems built with musicModel + song-level
  // masterLevel/fadeSeconds must be a valid song the engine can start, with masterLevel
  // scaling the mix.
  const song = { stems: [], intensity: {}, masterLevel: 0.5, fadeSeconds: 2 };
  addStem(song, { name: 'bass', sound: 'sndA', gain: 0.8 });
  addStem(song, { name: 'lead', sound: 'sndB', gain: 0.6 });
  assert.equal(renameStem(song, 'lead', 'melody'), true);
  song.intensity.full = { bass: 0.8, melody: 0.6 };

  const sm = new MockSound();
  const md = new MusicDirector(sm);
  assert.equal(md.startSong(song, { intensity: 'full' }), true);
  assert.equal(sm.started.length, 2);
  const target = name => sm.fades.find(f => f.h === sm.started.find(s => s.sound === name).h).target;
  assert.equal(target('sndA'), 0.8 * 0.5); // headroom-scaled
  assert.equal(target('sndB'), 0.6 * 0.5);
});
