import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure piano-roll note-pattern helpers. The invariant that matters: a pattern stays sorted by
// beat (the engine scheduler plays in array order), and edits snap + clamp to the loop/pitch range.

const {
  snap, loopBeats, addNote, moveNote, resizeNote, deleteNote, setVelocity, sortNotes, importMidiTrack,
  PITCH_MIN, PITCH_MAX,
} = await import('/editors/midiModel.js');

const OPTS = { grid: 0.25, loopBeats: 16 }; // 4 bars × 4 beats, 1/16 grid

test('snap rounds to the grid', () => {
  assert.equal(snap(0.26, 0.25), 0.25);
  assert.equal(snap(0.4, 0.25), 0.5);
  assert.equal(snap(1.3, 0), 1.3); // no grid → no snap
});

test('loopBeats = bars × beatsPerBar (with defaults)', () => {
  assert.equal(loopBeats({ bars: 4, beatsPerBar: 4 }), 16);
  assert.equal(loopBeats({ bars: 2, beatsPerBar: 3 }), 6);
  assert.equal(loopBeats({}), 16);
});

test('addNote snaps, clamps, defaults, and keeps the array sorted by beat', () => {
  const notes = [{ beat: 4, len: 1, midi: 60, vel: 0.8 }];
  const n = addNote(notes, { beat: 0.4, midi: 64 }, OPTS);
  assert.equal(n.beat, 0.5);        // snapped
  assert.equal(n.len, 0.25);        // default = one grid cell
  assert.equal(n.vel, 0.8);         // default velocity
  assert.deepEqual(notes.map(x => x.beat), [0.5, 4]); // re-sorted, new note first
});

test('addNote clamps a too-high pitch and an out-of-loop start', () => {
  const notes = [];
  const hi = addNote(notes, { beat: 100, midi: 200, len: 8 }, OPTS);
  assert.equal(hi.midi, PITCH_MAX);
  assert.ok(hi.beat <= 16 - 0.25, `beat ${hi.beat}`);
  assert.ok(hi.beat + hi.len <= 16, `note stays in the loop`);
});

test('moveNote shifts start + pitch (snapped/clamped) and re-sorts', () => {
  const a = { beat: 0, len: 1, midi: 60, vel: 0.8 };
  const b = { beat: 2, len: 1, midi: 62, vel: 0.8 };
  const notes = [a, b];
  moveNote(notes, a, 3, 2, OPTS); // a → beat 3, midi 62
  assert.equal(a.beat, 3);
  assert.equal(a.midi, 62);
  assert.deepEqual(notes.map(x => x.beat), [2, 3]); // b now first
  moveNote(notes, a, -100, -100, OPTS); // clamps to floor
  assert.equal(a.beat, 0);
  assert.equal(a.midi, PITCH_MIN);
});

test('resizeNote snaps length, enforces a min cell, and clamps to loop end', () => {
  const n = { beat: 15.5, len: 0.5, midi: 60, vel: 0.8 };
  resizeNote(n, 4, OPTS);              // would overflow the 16-beat loop
  assert.equal(n.len, 0.5);           // clamped to 16 - 15.5
  resizeNote(n, -10, OPTS);            // shrink past zero
  assert.equal(n.len, 0.25);          // min one cell
});

test('deleteNote removes by reference; setVelocity clamps', () => {
  const a = { beat: 0, len: 1, midi: 60, vel: 0.8 };
  const notes = [a];
  setVelocity(a, 2);
  assert.equal(a.vel, 1);
  setVelocity(a, -1);
  assert.equal(a.vel, 0);
  assert.equal(deleteNote(notes, a), true);
  assert.equal(notes.length, 0);
  assert.equal(deleteNote(notes, a), false);
});

test('sortNotes / importMidiTrack produce a beat-sorted pattern', () => {
  const unsorted = [{ beat: 3, len: 1, midi: 60, vel: 0.8 }, { beat: 1, len: 1, midi: 62, vel: 0.8 }];
  assert.deepEqual(sortNotes(unsorted).map(n => n.beat), [1, 3]);

  // parsed seconds notes (out of order) → sorted beats at 120 BPM, 1/16 grid
  const beats = importMidiTrack([{ time: 1.0, duration: 0.5, midi: 67, velocity: 0.6 }, { time: 0, duration: 0.5, midi: 60, velocity: 0.9 }], 120, 0.25);
  assert.deepEqual(beats.map(n => n.midi), [60, 67]);
  assert.equal(beats[0].beat, 0);
  assert.equal(beats[1].beat, 2); // 1.0s at 120 BPM = 2 beats
});
