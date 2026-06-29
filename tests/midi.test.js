import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi } from '/engine/audio/midi.js';

// A hand-built Standard MIDI File: format 0, 1 track, PPQ=96, tempo 500000us (120 BPM).
// Two quarter notes back to back: C4 (60) then E4 (64), each 96 ticks = 0.5s.
const SMF = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // 'MThd', len 6
  0x00, 0x00, 0x00, 0x01, 0x00, 0x60,             // format 0, 1 track, division 96
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x1b, // 'MTrk', len 27
  0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,       // Δ0  set-tempo 500000us
  0x00, 0x90, 0x3c, 0x64,                         // Δ0  note on  C4 vel 100
  0x60, 0x80, 0x3c, 0x40,                         // Δ96 note off C4
  0x00, 0x90, 0x40, 0x64,                         // Δ0  note on  E4 vel 100
  0x60, 0x80, 0x40, 0x40,                         // Δ96 note off E4
  0x00, 0xff, 0x2f, 0x00,                         // Δ0  end of track
]);

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('parseMidi extracts notes with correct pitch, time, and duration', () => {
  const { notes, duration } = parseMidi(SMF.buffer);
  assert.equal(notes.length, 2);

  assert.equal(notes[0].midi, 60);
  assert.ok(near(notes[0].time, 0), `note0 time ${notes[0].time}`);
  assert.ok(near(notes[0].duration, 0.5), `note0 dur ${notes[0].duration}`);
  assert.ok(near(notes[0].velocity, 100 / 127), `note0 vel ${notes[0].velocity}`);

  assert.equal(notes[1].midi, 64);
  assert.ok(near(notes[1].time, 0.5), `note1 time ${notes[1].time}`);
  assert.ok(near(notes[1].duration, 0.5), `note1 dur ${notes[1].duration}`);

  assert.ok(near(duration, 1.0), `total ${duration}`);
});

test('parseMidi honors a tempo change (240 BPM halves the timing)', () => {
  // Same notes but tempo 250000us (240 BPM) → each 96-tick note = 0.25s.
  const fast = SMF.slice();
  // tempo bytes are at offset 26..28 (07 A1 20). 250000 = 0x03D090.
  fast[26] = 0x03; fast[27] = 0xd0; fast[28] = 0x90;
  const { notes } = parseMidi(fast.buffer);
  assert.ok(near(notes[0].duration, 0.25), `dur ${notes[0].duration}`);
  assert.ok(near(notes[1].time, 0.25), `time ${notes[1].time}`);
});

test('parseMidi rejects a non-MIDI buffer', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4]).buffer), /MThd/);
});

// Format 1, 2 named tracks (PPQ=96, 120 BPM): "Bass" (C3,D3) and "Lead" (C5,E5).
const SMF2 = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd len 6
  0x00, 0x01, 0x00, 0x02, 0x00, 0x60,             // format 1, 2 tracks, division 96
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x23, // Track 0, len 35
  0x00, 0xff, 0x03, 0x04, 0x42, 0x61, 0x73, 0x73, // name "Bass"
  0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,       // tempo 500000
  0x00, 0x90, 0x30, 0x64, 0x60, 0x80, 0x30, 0x40, // C3 quarter
  0x00, 0x90, 0x32, 0x64, 0x60, 0x80, 0x32, 0x40, // D3 quarter
  0x00, 0xff, 0x2f, 0x00,                         // end of track
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x1c, // Track 1, len 28
  0x00, 0xff, 0x03, 0x04, 0x4c, 0x65, 0x61, 0x64, // name "Lead"
  0x00, 0x90, 0x48, 0x64, 0x60, 0x80, 0x48, 0x40, // C5 quarter
  0x00, 0x90, 0x4c, 0x64, 0x60, 0x80, 0x4c, 0x40, // E5 quarter
  0x00, 0xff, 0x2f, 0x00,                         // end of track
]);

test('parseMidi splits named tracks and still merges notes', () => {
  const { notes, tracks } = parseMidi(SMF2.buffer);
  assert.equal(tracks.length, 2);

  assert.equal(tracks[0].name, 'Bass');
  assert.deepEqual(tracks[0].notes.map(n => n.midi), [48, 50]);

  assert.equal(tracks[1].name, 'Lead');
  assert.deepEqual(tracks[1].notes.map(n => n.midi), [72, 76]);

  // Merged list keeps every track (back-compat for one-shot/loop MIDI sounds).
  assert.equal(notes.length, 4);
  assert.deepEqual([...new Set(notes.map(n => n.midi))].sort((a, b) => a - b), [48, 50, 72, 76]);
});
