// Content integrity for the Critter Garden example song: every stem in
// data/music.json resolves to a loop:true `music` sound in data/sfx.json, each of
// those points at a real named track in assets/MIDI/critter-garden.mid, and every
// intensity tier references only declared stems. Guards the example from drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseMidi } from '/engine/audio/midi.js';
import music from '/data/music.json' with { type: 'json' };
import sfx from '/data/sfx.json' with { type: 'json' };

const ROOT = path.resolve(import.meta.dirname, '..');
const song = music.songs.critterGarden;
const sounds = sfx.sounds;

function midiTracks(file) {
  const abs = path.join(ROOT, file.replace(/^\//, '').replace('MIDI/', 'assets/MIDI/'));
  const buf = fs.readFileSync(abs);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parseMidi(ab).tracks.map(t => t.name);
}

test('critterGarden song exists with stems + intensity tiers', () => {
  assert.ok(song, 'data/music.json defines the critterGarden song');
  assert.ok(song.stems.length >= 2, 'has multiple stems');
  assert.ok(Object.keys(song.intensity).length >= 2, 'has multiple intensity tiers');
});

test('every stem resolves to a loop:true music sound that selects a real MIDI track', () => {
  const trackCache = {};
  for (const stem of song.stems) {
    const def = sounds[stem.sound];
    assert.ok(def, `stem "${stem.name}" → sound "${stem.sound}" exists in sfx.json`);
    assert.equal(def.loop, true, `${stem.sound} is loop:true`);
    assert.equal(def.category, 'music', `${stem.sound} is in the music category`);
    const midi = def.synth?.midi;
    assert.ok(midi && midi.file, `${stem.sound} has a synth.midi.file`);
    const tracks = trackCache[midi.file] ||= midiTracks(midi.file);
    assert.ok(tracks.includes(midi.track), `${stem.sound} track "${midi.track}" exists in ${midi.file} (have: ${tracks.join(', ')})`);
  }
});

test('the music category is declared in sfx.json categories', () => {
  assert.ok(sfx.categories.includes('music'), 'categories list includes "music"');
});

test('every intensity tier references only declared stem names', () => {
  const names = new Set(song.stems.map(s => s.name));
  for (const [tier, gains] of Object.entries(song.intensity)) {
    for (const stem of Object.keys(gains)) {
      assert.ok(names.has(stem), `tier "${tier}" references declared stem "${stem}"`);
      assert.ok(gains[stem] >= 0 && gains[stem] <= 1, `tier "${tier}".${stem} gain in 0..1`);
    }
  }
});
