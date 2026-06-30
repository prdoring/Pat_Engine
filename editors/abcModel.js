// editors/abcModel.js
// Pure, DOM-free ABC-notation ⇄ beats converter, the ABC sibling of editors/midiModel.js.
// A stem pattern is an array of beat-based notes `{ beat, len, midi, vel }` (beat/len in
// beats where 1 beat = a quarter note, midi 0–127, vel 0–1), kept SORTED BY BEAT. ABC is
// beat-native, so we parse straight to that shape and reuse midiModel's snap/sort/clamp.
//
// Supported ABC subset (practical monophonic + chords): header fields L:/M:/K: (and inline
// [L:..]/[M:..]/[K:..]), pitches A–G/a–g with octave marks ' and , , accidentals ^ _ = ,
// note lengths (`2`, `/2`, `/`, `3/2`), rests z/x and whole-bar Z/X, chords [CEG], ties for
// same-pitch notes, and bar lines. Unsupported tokens (tuplets (3, broken rhythm > < , grace
// {..}, decorations, slurs) are skipped and reported in `warnings` — the parser never throws.
import { snap, sortNotes, PITCH_MIN, PITCH_MAX } from './midiModel.js';

const LETTER_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const TONIC_SHARPS = { C: 0, D: 2, E: 4, F: -1, G: 1, A: 3, B: 5 };
const MODE_OFFSET = { ion: 0, maj: 0, dor: -2, phr: -4, lyd: 1, mix: -1, aeo: -3, min: -3, m: -3, loc: -5 };
const MAX_NOTES = 8000; // runaway guard

const clampPitch = (m) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(m)));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Parse a fraction-ish string ("1/8", "3/4", "C", "C|") into a number of whole notes. */
function parseFraction(str) {
  str = (str || '').trim();
  if (str === 'C') return 1;       // common time 4/4
  if (str === 'C|') return 1;      // cut time 2/2
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(str);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/** Key signature → per-letter accidental map {C:.., D:.., ...} of -1/0/+1. */
export function keyAccidentals(keyStr) {
  const map = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const m = /^([A-Ga-g])([#b]?)\s*([A-Za-z]*)/.exec((keyStr || 'C').trim());
  if (!m) return map; // K:none / K:Hp / unknown → no accidentals
  const tonic = m[1].toUpperCase();
  const sign = m[2];
  const mode = (m[3] || '').toLowerCase().slice(0, 3);
  let sharps = TONIC_SHARPS[tonic] + (sign === '#' ? 7 : sign === 'b' ? -7 : 0);
  const off = mode in MODE_OFFSET ? MODE_OFFSET[mode] : 0;
  sharps += off;
  if (sharps > 0) for (let k = 0; k < sharps && k < 7; k++) map[SHARP_ORDER[k]] = 1;
  else if (sharps < 0) for (let k = 0; k < -sharps && k < 7; k++) map[FLAT_ORDER[k]] = -1;
  return map;
}

/**
 * Parse ABC text into a sorted, grid-snapped beats pattern.
 * @returns {{ notes: Array<{beat,len,midi,vel}>, warnings: string[] }}
 */
export function importAbc(text, { grid = 0.25, beatsPerBar = 4 } = {}) {
  const warnings = [];
  const warnOnce = new Set();
  const warn = (msg) => { if (!warnOnce.has(msg)) { warnOnce.add(msg); warnings.push(msg); } };
  const notes = [];

  let defaultLen = null;        // whole-note fraction from L:, lazily defaulted from meter
  let meterVal = 1;             // M: as whole notes (4/4 = 1)
  let keyAcc = keyAccidentals('C');
  let barAcc = {};              // explicit accidentals active for the rest of the current bar
  let cursor = 0;               // running position in beats
  let lastNote = null;          // for same-pitch ties
  let tiePending = false;

  const getDefaultLen = () => defaultLen ?? (meterVal < 0.75 ? 1 / 16 : 1 / 8);
  const lenToBeats = (frac) => getDefaultLen() * frac * 4; // whole note = 4 quarter-note beats

  function applyField(letter, val) {
    switch (letter.toUpperCase()) {
      case 'L': { const f = parseFraction(val); if (f) defaultLen = f; break; }
      case 'M': { const f = parseFraction(val); if (f) meterVal = f; break; }
      case 'K': keyAcc = keyAccidentals(val); barAcc = {}; break;
      default: break; // X, T, Q, V, … ignored
    }
  }

  function parseMusic(s) {
    let i = 0;
    const peek = () => s[i];
    const isDigit = (c) => c >= '0' && c <= '9';

    function readLength() {
      let num = '';
      while (isDigit(peek())) { num += s[i++]; }
      let n = num ? parseInt(num, 10) : 1;
      let den = 1;
      if (peek() === '/') {
        let slashes = 0;
        while (peek() === '/') { slashes++; i++; }
        let d = '';
        while (isDigit(peek())) { d += s[i++]; }
        den = d ? parseInt(d, 10) : Math.pow(2, slashes);
      }
      return den > 0 ? n / den : n; // multiplier of the default note length
    }

    function readNote() {
      // Accidentals
      let acc = null;
      if (peek() === '=') { acc = 0; i++; }
      else {
        let sharp = 0, flat = 0;
        while (peek() === '^') { sharp++; i++; }
        while (peek() === '_') { flat++; i++; }
        if (sharp || flat) acc = sharp - flat;
      }
      const ch = peek();
      if (!ch || !/[A-Ga-g]/.test(ch)) return null;
      i++;
      let midi = /[A-G]/.test(ch) ? 60 + LETTER_SEMI[ch] : 72 + LETTER_SEMI[ch.toUpperCase()];
      while (peek() === "'") { midi += 12; i++; }
      while (peek() === ',') { midi -= 12; i++; }
      const letterKey = ch.toUpperCase();
      let adj;
      if (acc != null) { adj = acc; barAcc[letterKey] = acc; }
      else if (letterKey in barAcc) adj = barAcc[letterKey];
      else adj = keyAcc[letterKey] || 0;
      midi += adj;
      const hasLen = isDigit(peek()) || peek() === '/';
      const lenFrac = readLength();
      return { midi, lenFrac, hasLen };
    }

    function emit(midi, beats) {
      if (notes.length >= MAX_NOTES) return;
      if (tiePending && lastNote && lastNote.midi === midi) {
        lastNote.len += beats; cursor += beats; tiePending = false; return;
      }
      const nn = { beat: cursor, len: beats, midi, vel: 0.8 };
      notes.push(nn); cursor += beats; lastNote = nn; tiePending = false;
    }

    while (i < s.length) {
      const c = peek();
      // whitespace / continuations
      if (c === ' ' || c === '\t' || c === '\\') { i++; continue; }
      // bar lines & repeats reset bar-scoped accidentals
      if (c === '|' || c === ':') { barAcc = {}; i++; continue; }
      if (c === ']') { i++; continue; } // stray
      // quoted chord symbol / annotation
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') i++; i++; continue; }
      // decoration !...!
      if (c === '!') { i++; while (i < s.length && s[i] !== '!') i++; i++; continue; }
      // grace notes {...}
      if (c === '{') { warn('Grace notes ({…}) ignored.'); i++; while (i < s.length && s[i] !== '}') i++; i++; continue; }
      // tuplets / slurs
      if (c === '(') {
        if (isDigit(s[i + 1])) { warn('Tuplets ((3…) imported at plain note lengths.'); i++; while (isDigit(peek()) || peek() === ':') i++; }
        else i++; // slur start
        continue;
      }
      if (c === ')') { i++; continue; } // slur end
      // broken rhythm
      if (c === '>' || c === '<') { warn('Broken rhythm (> <) imported without dotting.'); i++; continue; }
      // tie
      if (c === '-') { if (lastNote) tiePending = true; i++; continue; }
      // rests
      if (c === 'z' || c === 'x') { i++; cursor += lenToBeats(readLength()); lastNote = null; tiePending = false; continue; }
      if (c === 'Z' || c === 'X') {
        i++; let num = ''; while (isDigit(peek())) num += s[i++];
        cursor += beatsPerBar * (num ? parseInt(num, 10) : 1); lastNote = null; tiePending = false; continue;
      }
      // inline field or chord
      if (c === '[') {
        if (/^[A-Za-z]:/.test(s.slice(i + 1, i + 3))) {
          const end = s.indexOf(']', i);
          if (end < 0) { i++; continue; }
          const fm = /^([A-Za-z]):(.*)$/.exec(s.slice(i + 1, end));
          if (fm) applyField(fm[1], fm[2].trim());
          i = end + 1; continue;
        }
        // chord
        i++;
        const chord = [];
        while (i < s.length && peek() !== ']') {
          if (peek() === ' ') { i++; continue; }
          const n = readNote();
          if (n) chord.push(n); else i++; // skip stray to avoid stalling
        }
        i++; // past ']'
        const hasPost = isDigit(peek()) || peek() === '/';
        const postFrac = readLength();
        let maxBeats = 0;
        for (const cn of chord) {
          const beats = lenToBeats(hasPost ? postFrac : cn.lenFrac);
          maxBeats = Math.max(maxBeats, beats);
          if (notes.length < MAX_NOTES) notes.push({ beat: cursor, len: beats, midi: cn.midi, vel: 0.8 });
        }
        cursor += maxBeats; lastNote = null; tiePending = false; continue;
      }
      // a note
      if (/[A-Ga-g^_=]/.test(c)) {
        const before = i;
        const n = readNote();
        if (n) { emit(n.midi, lenToBeats(n.lenFrac)); continue; }
        if (i === before) i++; // guard against stall
        continue;
      }
      // unknown char
      i++;
    }
  }

  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    let line = raw;
    const ci = line.indexOf('%'); if (ci >= 0) line = line.slice(0, ci);
    if (!line.trim()) continue;
    const fm = /^([A-Za-z]):(.*)$/.exec(line.trim());
    if (fm) { applyField(fm[1], fm[2].trim()); continue; }
    parseMusic(line);
  }

  if (notes.length >= MAX_NOTES) warn(`Stopped at ${MAX_NOTES} notes.`);

  const cell = grid > 0 ? grid : 0.25;
  for (const n of notes) {
    n.beat = Math.max(0, snap(n.beat, grid));
    n.len = Math.max(cell, snap(n.len, grid));
    n.midi = clampPitch(n.midi);
    n.vel = clamp01(n.vel);
  }
  return { notes: sortNotes(notes), warnings };
}

// ─── Export: beats pattern → ABC text (for round-trip / "Copy as ABC") ──────────
const PITCH_CLASS = ['C', '^C', 'D', '^D', 'E', 'F', '^F', 'G', '^G', 'A', '^A', 'B'];

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }

/** A length in beats → an ABC length suffix relative to L:1/8 (0.5 beats per unit). */
function lenSuffix(beats) {
  let units = beats / 0.5;
  if (Math.abs(units - 1) < 1e-6) return '';
  let den = 1, num = units;
  while (Math.abs(num - Math.round(num)) > 1e-6 && den < 64) { den *= 2; num = units * den; }
  num = Math.round(num); if (num < 1) num = 1;
  const g = gcd(num, den); num /= g; den /= g;
  if (den === 1) return String(num);
  if (num === 1) return '/' + den;
  return num + '/' + den;
}

/** MIDI pitch → ABC pitch token (sharps; ' for high octaves, , for low). */
export function pitchToAbc(midi) {
  midi = Math.round(midi);
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1; // 60 → 4
  let base = PITCH_CLASS[pc];
  let marks = '';
  if (octave >= 5) { base = base.toLowerCase(); marks = "'".repeat(octave - 5); }
  else { marks = ','.repeat(Math.max(0, 4 - octave)); }
  return base + marks;
}

/** Beats pattern → ABC text (header L:1/8, K:C). Monophonic with [..] chords + z rests. */
export function stemToAbc(notes, { beatsPerBar = 4 } = {}) {
  const arr = (notes || []).slice().sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const out = [`X:1`, `L:1/8`, `M:${beatsPerBar}/4`, `K:C`];
  const byBeat = new Map();
  for (const n of arr) { const k = n.beat; if (!byBeat.has(k)) byBeat.set(k, []); byBeat.get(k).push(n); }
  const beats = [...byBeat.keys()].sort((a, b) => a - b);

  const tokens = [];
  let cursor = 0, nextBar = beatsPerBar;
  const barCheck = () => { while (cursor >= nextBar - 1e-6 && cursor > 0) { tokens.push('|'); nextBar += beatsPerBar; } };

  for (const b of beats) {
    if (b > cursor + 1e-6) { tokens.push('z' + lenSuffix(b - cursor)); cursor = b; barCheck(); }
    const group = byBeat.get(b);
    const gLen = Math.max(...group.map(n => n.len));
    if (group.length === 1) tokens.push(pitchToAbc(group[0].midi) + lenSuffix(group[0].len));
    else tokens.push('[' + group.map(n => pitchToAbc(n.midi)).join('') + ']' + lenSuffix(gLen));
    cursor = b + gLen; barCheck();
  }
  out.push((tokens.join(' ') + ' |').trim());
  return out.join('\n') + '\n';
}
