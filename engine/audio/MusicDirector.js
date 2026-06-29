import { MUSIC_SONGS } from '/engine/data/music.js';

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
    for (const stem of song.stems) {
      const h = this.sound.startUILoop(stem.sound, { volume: 0, startAt });
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

  /** Stop the song: fade out and tear down every stem loop. */
  stop(opts = {}) {
    const fadeOut = opts.fadeOut ?? 0.6;
    for (const [, h] of this.handles) this.sound.stopLoop(h, { fadeOut });
    this.handles.clear();
    this.song = null;
    this.intensity = null;
  }
}
