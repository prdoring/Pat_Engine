import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure ABC ⇄ beats converter for the music editor. Headless, no DOM. Notes are
// `{ beat, len, midi, vel }` (beats; 1 beat = a quarter note), kept sorted by beat.

const { importAbc, stemToAbc, keyAccidentals, pitchToAbc } = await import('/editors/music/model/abcModel.js');

// Compact view for assertions.
const triples = (notes) => notes.map(n => [n.beat, n.len, n.midi]);

test('diatonic scale maps letters to MIDI with quarter-note beats', () => {
  const { notes } = importAbc('L:1/4\nCDEFGABc');
  assert.deepEqual(triples(notes), [
    [0, 1, 60], [1, 1, 62], [2, 1, 64], [3, 1, 65],
    [4, 1, 67], [5, 1, 69], [6, 1, 71], [7, 1, 72],
  ]);
});

test('octave marks shift by ±12', () => {
  const { notes } = importAbc("L:1/4\nC, C c c'");
  assert.deepEqual(notes.map(n => n.midi), [48, 60, 72, 84]);
});

test('explicit accidentals override; natural cancels', () => {
  const { notes } = importAbc('L:1/4\n^C _E =F');
  assert.deepEqual(notes.map(n => n.midi), [61, 63, 65]);
});

test('key signature applies the right accidental to bare letters', () => {
  const g = importAbc('K:G\nL:1/4\nFGAB'); // G major → F#
  assert.deepEqual(g.notes.map(n => n.midi), [66, 67, 69, 71]);
  const f = importAbc('K:F\nL:1/4\nB'); // F major → Bb
  assert.equal(f.notes[0].midi, 70);
});

test('bar-scoped accidental persists then resets at the bar line', () => {
  const { notes } = importAbc('K:C\nL:1/4\n^F F | F');
  assert.deepEqual(notes.map(n => n.midi), [66, 66, 65]); // sharp holds within bar, clears after |
});

test('length syntax: multiples, /n, bare slash', () => {
  const { notes } = importAbc('L:1/8\nA2 A A/2 A/');
  assert.deepEqual(triples(notes), [
    [0, 1, 69], [1, 0.5, 69], [1.5, 0.25, 69], [1.75, 0.25, 69],
  ]);
});

test('rests advance the cursor without emitting notes', () => {
  const { notes } = importAbc('L:1/4\nA z A');
  assert.deepEqual(triples(notes), [[0, 1, 69], [2, 1, 69]]);
});

test('chords share a beat and advance by their length once', () => {
  const { notes } = importAbc('L:1/4\n[CEG] G');
  assert.deepEqual(triples(notes), [[0, 1, 60], [0, 1, 64], [0, 1, 67], [1, 1, 67]]);
});

test('ties merge adjacent same-pitch notes', () => {
  const { notes } = importAbc('L:1/4\nA-A B');
  assert.deepEqual(triples(notes), [[0, 2, 69], [2, 1, 71]]);
});

test('default note length falls back from the meter when L: is absent', () => {
  assert.equal(importAbc('M:4/4\nA').notes[0].len, 0.5);  // 1/8 default
  assert.equal(importAbc('M:2/4\nA').notes[0].len, 0.25); // <0.75 → 1/16 default
});

test('unsupported tokens warn but never throw, and surrounding notes still import', () => {
  const { notes, warnings } = importAbc('L:1/4\n(3CEG {d}>A "Cm"!trill!B');
  assert.ok(warnings.length > 0);
  // C E G (tuplet at plain length), A, B all parsed
  assert.deepEqual(notes.map(n => n.midi).sort((a, b) => a - b), [60, 64, 67, 69, 71]);
});

test('malformed input returns an empty pattern rather than throwing', () => {
  assert.doesNotThrow(() => importAbc(']]|::%%\n^^^'));
  assert.deepEqual(importAbc('').notes, []);
});

test('keyAccidentals: sharps, flats, minor mode', () => {
  assert.deepEqual(keyAccidentals('C'), { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 });
  assert.equal(keyAccidentals('D').F, 1); // D major: F#, C#
  assert.equal(keyAccidentals('D').C, 1);
  assert.equal(keyAccidentals('F').B, -1); // F major: Bb
  assert.equal(keyAccidentals('Am').F, 0); // A minor = C major, no accidentals
  assert.equal(keyAccidentals('Em').F, 1); // E minor = G major, F#
});

test('pitchToAbc round-trips through importAbc pitch parsing', () => {
  for (const midi of [48, 60, 61, 67, 72, 84]) {
    const tok = pitchToAbc(midi);
    const { notes } = importAbc('L:1/4\n' + tok);
    assert.equal(notes[0].midi, midi, `midi ${midi} ↔ "${tok}"`);
  }
});

test('stemToAbc → importAbc round-trips beat/len/midi', () => {
  const pattern = [
    { beat: 0, len: 1, midi: 60, vel: 0.8 },
    { beat: 1, len: 0.5, midi: 64, vel: 0.8 },
    { beat: 2, len: 2, midi: 67, vel: 0.8 },
    { beat: 4, len: 1, midi: 72, vel: 0.8 }, // chord with the next
    { beat: 4, len: 1, midi: 76, vel: 0.8 },
  ];
  const abc = stemToAbc(pattern, { beatsPerBar: 4 });
  const { notes } = importAbc(abc, { grid: 0.25, beatsPerBar: 4 });
  assert.deepEqual(triples(notes), triples(pattern));
});
