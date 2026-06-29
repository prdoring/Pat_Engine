import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure song-model helpers used by the music editor. The contract that matters most:
// a stem's `name` is the key used across every intensity tier, so renames/removes must
// rewrite those maps in lockstep. These run headless (no DOM) like the rest of the suite.

const {
  newSong, uniqueStemName, addStem, removeStem, renameStem,
  reorderStem, renameVibe, deleteVibe, setVibeDoc,
} = await import('/editors/musicModel.js');

// A small song fixture, fresh per test (helpers mutate in place).
const make = () => ({
  stems: [
    { name: 'bass', sound: 'cgBass', gain: 0.6 },
    { name: 'lead', sound: 'cgLead', gain: 0.55 },
  ],
  intensity: {
    calm: { bass: 0.7 },
    full: { bass: 0.6, lead: 0.6 },
  },
  vibeDocs: { calm: 'quiet', full: 'big' },
  masterLevel: 0.35,
  fadeSeconds: 1.5,
});

test('newSong has engine defaults and empty collections', () => {
  const s = newSong();
  assert.deepEqual(s.stems, []);
  assert.deepEqual(s.intensity, {});
  assert.equal(s.masterLevel, 0.35);
  assert.equal(s.fadeSeconds, 1.5);
});

test('addStem appends and auto-uniques names', () => {
  const s = make();
  const a = addStem(s, { name: 'bass', sound: 'cgBass2' }); // collides with existing "bass"
  assert.equal(a.name, 'bass2');
  assert.equal(s.stems.length, 3);
  const b = addStem(s); // no name → default base
  assert.equal(b.name, 'stem');
});

test('removeStem drops the stem from stems AND every intensity tier', () => {
  const s = make();
  assert.equal(removeStem(s, 'bass'), true);
  assert.equal(s.stems.find(st => st.name === 'bass'), undefined);
  assert.equal(s.intensity.calm.bass, undefined);
  assert.equal(s.intensity.full.bass, undefined);
  assert.equal(s.intensity.full.lead, 0.6); // untouched
  assert.equal(removeStem(s, 'nope'), false);
});

test('renameStem rewrites the key in every tier and rejects collisions', () => {
  const s = make();
  assert.equal(renameStem(s, 'bass', 'sub'), true);
  assert.equal(s.stems[0].name, 'sub');
  assert.equal(s.intensity.calm.sub, 0.7);
  assert.equal(s.intensity.calm.bass, undefined);
  assert.equal(s.intensity.full.sub, 0.6);

  assert.equal(renameStem(s, 'sub', 'lead'), false, 'name already taken');
  assert.equal(renameStem(s, 'sub', '  '), false, 'blank rejected');
  assert.equal(renameStem(s, 'ghost', 'x'), false, 'missing stem rejected');
});

test('reorderStem swaps neighbours and is bounds-checked', () => {
  const s = make();
  assert.equal(reorderStem(s, 0, 1), true);
  assert.deepEqual(s.stems.map(st => st.name), ['lead', 'bass']);
  assert.equal(reorderStem(s, 0, -1), false, 'cannot move past the top');
  assert.equal(reorderStem(s, 1, 1), false, 'cannot move past the bottom');
});

test('renameVibe carries the doc and rejects collisions', () => {
  const s = make();
  assert.equal(renameVibe(s, 'full', 'triumph'), true);
  assert.equal(s.intensity.triumph.lead, 0.6);
  assert.equal(s.intensity.full, undefined);
  assert.equal(s.vibeDocs.triumph, 'big');
  assert.equal(s.vibeDocs.full, undefined);
  assert.equal(renameVibe(s, 'calm', 'triumph'), false, 'target exists');
});

test('deleteVibe removes the tier and its doc', () => {
  const s = make();
  assert.equal(deleteVibe(s, 'calm'), true);
  assert.equal(s.intensity.calm, undefined);
  assert.equal(s.vibeDocs.calm, undefined);
  assert.equal(deleteVibe(s, 'calm'), false);
});

test('setVibeDoc sets and clears', () => {
  const s = make();
  setVibeDoc(s, 'calm', '  serene  ');
  assert.equal(s.vibeDocs.calm, 'serene');
  setVibeDoc(s, 'calm', '');
  assert.equal(s.vibeDocs.calm, undefined);
});
