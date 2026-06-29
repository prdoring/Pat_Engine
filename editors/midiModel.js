// editors/midiModel.js
// Pure, DOM-free helpers for editing a stem's note pattern in the piano roll. A pattern is an
// array of beat-based notes `{ beat, len, midi, vel }` (beat/len in beats, midi 0–127, vel 0–1),
// kept SORTED BY BEAT — the engine's look-ahead scheduler plays notes in array order and breaks
// at the look-ahead horizon, so an out-of-order note would be skipped. Keeping this logic here
// (not in the DOM component) makes it unit-testable in Node, like editors/musicModel.js.
import { importToBeats } from '/engine/audio/midi.js';

export const PITCH_MIN = 21;  // A0
export const PITCH_MAX = 108; // C8

/** Snap a beat position to the grid (in beats); grid<=0 → no snap. */
export function snap(beat, grid) {
  return grid > 0 ? Math.round(beat / grid) * grid : beat;
}

/** A song's loop length in beats (bars × beats-per-bar). */
export function loopBeats(song) {
  return (song.bars ?? 4) * (song.beatsPerBar ?? 4);
}

const clampPitch = (m) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(m)));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sortByBeat = (notes) => { notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi); return notes; };

/** Keep a pattern in the engine's required time order. Returns the same array. */
export function sortNotes(notes) { return sortByBeat(notes); }

/** Add a note (snapped + clamped to the loop). Mutates + re-sorts `notes`; returns the new note. */
export function addNote(notes, { beat, midi, len, vel = 0.8 }, { grid = 0.25, loopBeats: lb = 16 } = {}) {
  const cell = grid > 0 ? grid : 0.25;
  const b = Math.max(0, Math.min(lb - cell, snap(beat, grid)));
  const l = Math.max(cell, len ?? cell);
  const note = { beat: b, len: Math.min(l, lb - b), midi: clampPitch(midi), vel: clamp01(vel) };
  notes.push(note);
  sortByBeat(notes);
  return note;
}

/** Move a note's start (snapped) + pitch, clamped to the loop. Mutates + re-sorts; returns the note. */
export function moveNote(notes, note, dBeat, dPitch, { grid = 0.25, loopBeats: lb = 16 } = {}) {
  note.beat = Math.max(0, Math.min(lb - note.len, snap(note.beat + dBeat, grid)));
  note.midi = clampPitch(note.midi + dPitch);
  sortByBeat(notes);
  return note;
}

/** Resize a note's length (snapped), min one grid cell, clamped to the loop end. Returns the note. */
export function resizeNote(note, dLen, { grid = 0.25, loopBeats: lb = 16 } = {}) {
  const cell = grid > 0 ? grid : 0.25;
  const l = snap(note.len + dLen, grid);
  note.len = Math.max(cell, Math.min(l, lb - note.beat));
  return note;
}

/** Remove a note (by reference). Returns true if it was present. */
export function deleteNote(notes, note) {
  const i = notes.indexOf(note);
  if (i >= 0) notes.splice(i, 1);
  return i >= 0;
}

/** Set a note's velocity (0..1). Returns the note. */
export function setVelocity(note, vel) {
  note.vel = clamp01(vel);
  return note;
}

/** Parsed (seconds) track notes → a sorted beats pattern, snapped to grid. For .mid import. */
export function importMidiTrack(parsedTrackNotes, bpm, grid = 0.25) {
  return sortByBeat(importToBeats(parsedTrackNotes, bpm, grid));
}
