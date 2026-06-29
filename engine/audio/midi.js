// Minimal Standard MIDI File (SMF) parser — game-agnostic, zero-dep.
// Turns a .mid file into a flat, time-sorted note list the synth can render as a tune.
// Handles the common case: format 0/1, PPQ or SMPTE division, variable-length delta
// times, running status, note on/off (note-on velocity 0 = off), and set-tempo meta.
// Other meta/sysex/channel messages are skipped safely. Not a full sequencer — no
// per-channel instruments, pitch bend, or controllers; just notes + timing.

const DEFAULT_TEMPO_US = 500000; // 120 BPM until a set-tempo event says otherwise
const MAX_NOTES = 2000;          // pathological-file guard

/** Read a 4-byte ASCII chunk id at byte offset `i`. */
function chunkId(view, i) {
  return String.fromCharCode(view.getUint8(i), view.getUint8(i + 1), view.getUint8(i + 2), view.getUint8(i + 3));
}

/** Read a MIDI variable-length quantity, advancing `pos.i`. */
function readVLQ(view, pos) {
  let value = 0, byte;
  do {
    byte = view.getUint8(pos.i++);
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return value;
}

/**
 * Build a tick→seconds converter from the (possibly empty) tempo map and division.
 * For PPQ division, walks tempo segments so multi-tempo files convert correctly.
 * For SMPTE division, time is tempo-independent (ticks per real second is fixed).
 */
function makeTickToSeconds(tempoEvents, division) {
  if (division & 0x8000) {
    // SMPTE: high byte = -framesPerSecond (two's complement), low byte = ticks/frame.
    const framesPerSec = 256 - ((division >> 8) & 0xff);
    const ticksPerFrame = division & 0xff;
    const ticksPerSec = (framesPerSec * ticksPerFrame) || 1;
    return (tick) => tick / ticksPerSec;
  }
  const ppq = (division & 0x7fff) || 96;
  const segs = [{ tick: 0, us: DEFAULT_TEMPO_US }];
  for (const e of [...tempoEvents].sort((a, b) => a.tick - b.tick)) {
    if (e.tick === 0) segs[0].us = e.us;
    else segs.push({ tick: e.tick, us: e.us });
  }
  const cum = [0]; // cumulative seconds at each segment's start tick
  for (let i = 1; i < segs.length; i++) {
    const dTick = segs[i].tick - segs[i - 1].tick;
    cum[i] = cum[i - 1] + (dTick * segs[i - 1].us) / ppq / 1e6;
  }
  return (tick) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].tick > tick) i--;
    return cum[i] + ((tick - segs[i].tick) * segs[i].us) / ppq / 1e6;
  };
}

/** Pair note-on/off events (per channel+pitch) into {startTick,endTick,note,vel}. */
function pairNotes(events, maxTick) {
  // Offs sort before ons at the same tick so a re-struck pitch pairs with the right on.
  const sorted = [...events].sort((a, b) => a.tick - b.tick || (a.type === 'off' ? 0 : 1) - (b.type === 'off' ? 0 : 1));
  const pending = new Map(); // `${ch}:${note}` → [{tick, vel}]
  const raw = [];
  for (const e of sorted) {
    const key = e.ch + ':' + e.note;
    if (e.type === 'on') {
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push({ tick: e.tick, vel: e.vel });
    } else {
      const arr = pending.get(key);
      if (arr && arr.length) {
        const on = arr.shift();
        raw.push({ startTick: on.tick, endTick: e.tick, note: e.note, vel: on.vel });
      }
    }
  }
  // Close any still-held notes at the end of the song.
  for (const [key, arr] of pending) {
    const note = Number(key.split(':')[1]);
    for (const on of arr) raw.push({ startTick: on.tick, endTick: maxTick, note, vel: on.vel });
  }
  return raw;
}

/** Convert paired raw notes to seconds, sorted by time, capped at MAX_NOTES. */
function rawToNotes(raw, t2s) {
  return raw
    .map(n => {
      const time = t2s(n.startTick);
      const duration = Math.max(0.02, t2s(n.endTick) - time);
      return { time, duration, midi: n.note, velocity: Math.max(0, Math.min(1, n.vel / 127)) };
    })
    .sort((a, b) => a.time - b.time)
    .slice(0, MAX_NOTES);
}

/**
 * Parse a Standard MIDI File.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ notes: Array<{time,duration,midi,velocity}>, duration:number,
 *             tracks: Array<{name:string, notes:Array}> }}
 *   `notes` is every track merged (back-compat); `tracks` keeps each MTrk separately (for
 *   multi-instrument songs). Times in seconds, `midi` 0–127, `velocity` 0–1, sorted by time.
 */
export function parseMidi(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 14 || chunkId(view, 0) !== 'MThd') {
    throw new Error('Not a Standard MIDI File (missing MThd header)');
  }
  const headerLen = view.getUint32(4);
  const ntracks = view.getUint16(10);
  const division = view.getUint16(12);

  const tempoEvents = [];
  const trackData = []; // [{ name, events:[{tick,type,ch,note,vel}] }] — one per MTrk
  let maxTick = 0;

  let p = 8 + headerLen; // first track follows the header chunk
  for (let t = 0; t < ntracks && p + 8 <= view.byteLength; t++) {
    const id = chunkId(view, p);
    const len = view.getUint32(p + 4);
    const end = Math.min(p + 8 + len, view.byteLength);
    p += 8;
    if (id !== 'MTrk') { p = end; continue; }

    const events = [];
    let name = '';
    let tick = 0;
    let runningStatus = 0;
    const pos = { i: p };
    while (pos.i < end) {
      tick += readVLQ(view, pos);
      if (tick > maxTick) maxTick = tick;

      let status = view.getUint8(pos.i);
      if (status & 0x80) { pos.i++; if (status < 0xf0) runningStatus = status; } // status byte (system msgs cancel running status)
      else status = runningStatus;                                              // running status: reuse, don't advance

      const hi = status & 0xf0;
      const ch = status & 0x0f;
      if (hi === 0x90) {                  // note on
        const note = view.getUint8(pos.i++);
        const vel = view.getUint8(pos.i++);
        events.push(vel > 0 ? { tick, type: 'on', ch, note, vel } : { tick, type: 'off', ch, note });
      } else if (hi === 0x80) {           // note off
        const note = view.getUint8(pos.i++);
        pos.i++;                          // off velocity (ignored)
        events.push({ tick, type: 'off', ch, note });
      } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        pos.i += 2;                       // aftertouch / control change / pitch bend
      } else if (hi === 0xc0 || hi === 0xd0) {
        pos.i += 1;                       // program change / channel pressure
      } else if (status === 0xff) {       // meta
        const metaType = view.getUint8(pos.i++);
        const mlen = readVLQ(view, pos);
        if (metaType === 0x51 && mlen === 3) {
          const us = (view.getUint8(pos.i) << 16) | (view.getUint8(pos.i + 1) << 8) | view.getUint8(pos.i + 2);
          tempoEvents.push({ tick, us });
        } else if (metaType === 0x03) {   // track name
          let s = '';
          for (let k = 0; k < mlen; k++) s += String.fromCharCode(view.getUint8(pos.i + k));
          name = s;
        }
        pos.i += mlen;
      } else if (status === 0xf0 || status === 0xf7) { // sysex
        pos.i += readVLQ(view, pos);
      } else {
        break; // unknown/garbage status — bail this track rather than desync
      }
    }
    p = end;
    trackData.push({ name: name || ('track ' + trackData.length), events });
  }

  // Tempo is global; pair notes per track (independent), and merge for back-compat.
  const t2s = makeTickToSeconds(tempoEvents, division);
  const allRaw = [];
  const tracks = trackData.map(td => {
    const raw = pairNotes(td.events, maxTick);
    allRaw.push(...raw);
    return { name: td.name, notes: rawToNotes(raw, t2s) };
  });
  const notes = rawToNotes(allRaw, t2s);
  const duration = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
  return { notes, duration, tracks };
}

// ─── Beat ⇄ seconds conversions (for editable, tempo-based note patterns) ───
// A song authored in the editor stores notes in BEATS (`{beat,len,midi,vel}`) against a
// song tempo + grid; the synth engine always plays in SECONDS (`{time,duration,midi,velocity}`).
// These pure converters are the only seam between the two, shared by the player + editor.

/** Beats `{beat,len,midi,vel}` → engine seconds `{time,duration,midi,velocity}` at `bpm`. */
export function beatsToSeconds(notes, bpm) {
  const k = 60 / (bpm || 120);
  return (notes || []).map(n => ({
    time: (n.beat || 0) * k,
    duration: Math.max(0.02, (n.len ?? n.duration ?? 0) * k),
    midi: n.midi,
    velocity: n.vel ?? n.velocity ?? 0.8,
  }));
}

/** Engine seconds `{time,duration,midi,velocity}` → beats `{beat,len,midi,vel}` at `bpm`. */
export function secondsToBeats(notes, bpm) {
  const k = (bpm || 120) / 60;
  return (notes || []).map(n => ({
    beat: (n.time || 0) * k,
    len: Math.max(0.001, (n.duration || 0) * k),
    midi: n.midi,
    vel: n.velocity ?? n.vel ?? 0.8,
  }));
}

/** Loop length in seconds for a song's bar grid. */
export function loopSeconds(bars = 4, beatsPerBar = 4, bpm = 120) {
  return (bars * beatsPerBar) * (60 / (bpm || 120));
}

/** Parsed (seconds) track notes → beats, snapped to `grid` (in beats). For .mid import. */
export function importToBeats(parsedNotes, bpm, grid = 0.25) {
  const k = (bpm || 120) / 60;
  const snap = (b) => (grid > 0 ? Math.round(b / grid) * grid : b);
  const minLen = grid > 0 ? grid : 0.25;
  return (parsedNotes || []).map(n => ({
    beat: Math.max(0, snap((n.time || 0) * k)),
    len: Math.max(minLen, snap((n.duration || 0) * k)),
    midi: n.midi,
    vel: n.velocity ?? 0.8,
  }));
}
