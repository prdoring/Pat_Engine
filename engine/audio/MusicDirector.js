import { MUSIC_SONGS } from '/engine/data/music.js';
import { beatsToSeconds, loopSeconds, tileBeatsToLoop } from '/engine/audio/midi.js';

/**
 * Adaptive (vertical-remixing) background music. Plays a song made of several
 * **synchronized looping stems** and fades them in/out by intensity — bringing layers
 * in to intensify, dropping them to relax — WITHOUT ever restarting the song.
 *
 * Generic and game-agnostic (like FXSequenceRunner / EntityLoopManager): the song content
 * lives in `data/music.json`; each stem is a `loop:true` + `synth.midi` sound in sfx.json
 * (its instrument timbre + which track of the shared multi-track .mid it plays). All stems
 * start on one shared downbeat so they stay sample-accurately in sync.
 */
export class MusicDirector {
  constructor(soundManager) {
    this.sound = soundManager;
    this.song = null;         // active resolved song (or null)
    this.handles = new Map(); // stem name → loop handle
    this.intensity = null;    // current tier name (or null)
    this.master = 1;          // headroom scale on the whole mix (set from song.masterLevel)
    this._startAt = null;     // shared downbeat (audio time) of the running song
    this._loopLen = null;     // song loop length in seconds (tempo songs only) → for getPhase
  }

  /** Loop length (seconds) of a tempo-based song, or null for legacy `.mid`-driven songs. */
  _songLoopLen(song) {
    return song.bpm ? loopSeconds(song.bars ?? 4, song.beatsPerBar ?? 4, song.bpm) : null;
  }

  /** Loop length in beats for a song's bar grid. */
  _loopBeats(song) {
    return (song.bars ?? 4) * (song.beatsPerBar ?? 4);
  }

  /**
   * A stem's effective beats pattern: tiled to fill the song loop when `stem.repeat` is set
   * (a short pattern repeats), else its notes as-authored (it plays once, then waits).
   */
  _stemNotes(stem, song, beatsNotes = stem.notes) {
    if (!stem?.repeat || !beatsNotes?.length) return beatsNotes || [];
    return tileBeatsToLoop(beatsNotes, this._loopBeats(song), song.beatsPerBar ?? 4);
  }

  isPlaying() { return this.song !== null; }
  getIntensity() { return this.intensity; }

  /** Resolve a song id (from MUSIC_SONGS) or accept a song object directly (editor preview). */
  _resolveSong(songOrId) {
    if (songOrId && typeof songOrId === 'object') return songOrId;
    return MUSIC_SONGS[songOrId] || null;
  }

  _stemGain(name) {
    const stem = this.song?.stems.find(s => s.name === name);
    return stem ? (stem.gain ?? 1) : 0;
  }

  /** Fade every active stem to `fn(name)` over `seconds` (scaled by the mix headroom). */
  _applyGains(fn, seconds) {
    for (const [name, h] of this.handles) this.sound.fadeLoop(h, fn(name) * this.master, seconds);
  }

  /**
   * Start a song. Every stem begins as a synchronized looping MIDI voice sharing one
   * downbeat, silent, then the initial mix fades in (a named `opts.intensity` tier, or
   * all stems at full gain). Idempotent — replaces any currently-playing song.
   * @param {string|object} songOrId  song id from music.json, or a song object (editor preview)
   * @param {object} [opts] { intensity?: string, fadeSeconds?: number }
   */
  startSong(songOrId, opts = {}) {
    const song = this._resolveSong(songOrId);
    if (!song || !song.stems?.length) return false;
    if (this.song) this.stop({ fadeOut: 0.05 });

    this.sound.resume();
    if (!this.sound.ctx) return false;

    this.song = song;
    // Mix headroom: many stems sum well past 0 dBFS, so scale the whole bus down (keeps the
    // per-stem gains/faders intuitive 0..1). Tunable per song via `masterLevel`.
    this.master = song.masterLevel ?? 0.35;
    // One shared start time (+lead-in for scheduling headroom) → lock-step stem loops.
    const startAt = this.sound.ctx.currentTime + 0.06;
    this._startAt = startAt;
    this._loopLen = this._songLoopLen(song);
    for (const stem of song.stems) {
      const playOpts = { volume: 0, startAt };
      // Editable JSON pattern: hand the engine the stem's notes (beats→seconds) + the shared
      // loop length, so every stem loops to the same bar grid. A stem with no `notes` falls
      // back to its sound's `synth.midi` (legacy .mid-driven path).
      if (stem.notes && song.bpm) {
        playOpts.notes = beatsToSeconds(this._stemNotes(stem, song), song.bpm);
        if (this._loopLen) playOpts.loopLen = this._loopLen;
      }
      const h = this.sound.startUILoop(stem.sound, playOpts);
      if (h != null) this.handles.set(stem.name, h);
    }

    const fade = opts.fadeSeconds ?? song.fadeSeconds ?? 1.5;
    if (opts.intensity) this.setIntensity(opts.intensity, fade);
    else this._applyGains(name => this._stemGain(name), fade); // all stems in
    return true;
  }

  /**
   * Crossfade stems to an intensity tier. Each tier maps a stem to its **absolute**
   * gain (0..1); stems absent from the tier fade to 0.
   */
  setIntensity(level, seconds) {
    if (!this.song) return;
    const tier = this.song.intensity?.[level];
    if (!tier) return;
    this.intensity = level;
    const secs = seconds ?? this.song.fadeSeconds ?? 1.5;
    this._applyGains(name => tier[name] ?? 0, secs);
  }

  /** Fade a single stem to an absolute gain (for fine-grained control); scaled by headroom. */
  fadeStem(name, gain, seconds) {
    const h = this.handles.get(name);
    if (h != null) this.sound.fadeLoop(h, gain * this.master, seconds ?? this.song?.fadeSeconds ?? 1.5);
  }

  /**
   * Live-update a playing stem's note pattern (beats) WITHOUT restarting — for a piano-roll
   * editor that wants edits heard immediately while the song keeps playing in sync.
   */
  updateStemNotes(name, beatsNotes, song = this.song) {
    const h = this.handles.get(name);
    if (h == null || !song?.bpm) return false;
    const stem = song.stems?.find(s => s.name === name);
    const notes = this._stemNotes(stem || {}, song, beatsNotes);
    return this.sound.updateMidiLoopNotes(h, beatsToSeconds(notes, song.bpm), this._songLoopLen(song));
  }

  /**
   * Swap one stem's instrument (sound) WITHOUT restarting the song. Starts a new loop for the
   * stem phase-aligned to the current loop position (so it stays in sync with the other stems),
   * crossfades it in, and fades the old one out. Tempo songs only (needs a known loop length).
   * @param {number} [targetGain] absolute 0..1 to fade the new voice to (defaults to the stem's base).
   */
  swapStemSound(name, newSoundId, song = this.song, targetGain = null) {
    if (!this.song || !this.sound.ctx || !this._loopLen) return false;
    const stem = this.song.stems.find(s => s.name === name);
    if (!stem) return false;
    stem.sound = newSoundId;

    const now = this.sound.ctx.currentTime;
    // Start of the loop iteration currently playing (in the past) → the new voice joins in phase.
    const startAt = this._startAt + Math.floor((now - this._startAt) / this._loopLen) * this._loopLen;
    const playOpts = { volume: 0, startAt };
    if (stem.notes && song.bpm) {
      playOpts.notes = beatsToSeconds(this._stemNotes(stem, song), song.bpm);
      playOpts.loopLen = this._loopLen;
    }
    const h = this.sound.startUILoop(newSoundId, playOpts);
    const old = this.handles.get(name);
    if (h != null) {
      this.handles.set(name, h);
      const g = (targetGain != null ? targetGain : this._stemGain(name)) * this.master;
      this.sound.fadeLoop(h, g, 0.12);
    }
    if (old != null && old !== h) this.sound.stopLoop(old, { fadeOut: 0.18 });
    return h != null;
  }

  /** Seek the whole song to `phase` (0..1) without restarting — moves every stem's playhead. */
  seekTo(phase) {
    if (!this.song || !this._loopLen || !this.sound.ctx) return false;
    phase = Math.max(0, Math.min(0.9999, phase));
    this._startAt = this.sound.ctx.currentTime - phase * this._loopLen;
    for (const h of this.handles.values()) this.sound.seekMidiLoop(h, phase);
    return true;
  }

  /** Current song loop phase 0..1 (shared across stems) for an editor playhead, or null. */
  getPhase() {
    if (!this.song || this._startAt == null || !this._loopLen || !this.sound.ctx) return null;
    const t = this.sound.ctx.currentTime - this._startAt;
    return (((t % this._loopLen) + this._loopLen) % this._loopLen) / this._loopLen;
  }

  /** Stop the song: fade out and tear down every stem loop. */
  stop(opts = {}) {
    const fadeOut = opts.fadeOut ?? 0.6;
    for (const [, h] of this.handles) this.sound.stopLoop(h, { fadeOut });
    this.handles.clear();
    this.song = null;
    this.intensity = null;
    this._startAt = null;
    this._loopLen = null;
  }
}
