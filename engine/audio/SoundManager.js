import { SOUND_CONFIG, SoundCategory } from '/engine/data/sounds.js';
import { parseMidi } from '/engine/audio/midi.js';
import { resolveValue, resolveSynth, resolveFilter } from '/engine/audio/synth/randomize.js';
import { transposeSynth, midiNotesFor, midiVoiceSetup, notesDuration } from '/engine/audio/synth/midiVoice.js';
import {
  createNoiseBuffer, makeDistortionCurve, buildSynthFilter, buildDistortion,
  buildVibrato, applyReverbSend,
} from '/engine/audio/synth/dsp.js';
import { buildSynthOneShot, renderMidiNote, renderMidiNotes } from '/engine/audio/synth/voices.js';

const MAX_CONCURRENT = 32;
const MAX_LOOPS = 24;         // cap on simultaneous looping voices (separate from one-shots)
const LOOP_AUDIBLE_EPS = 0.001; // distance-gain below which a positional loop is treated as inaudible
const CULL_FADE_TIME = 0.015; // 15ms micro-fade to prevent pops on culling
const DEDUP_WINDOW = 0.03;   // 30ms — suppress duplicate plays of the same sound

export class SoundManager {
  constructor(opts = {}) {
    this.ctx = null; // AudioContext, created lazily
    this.buffers = new Map(); // soundId → AudioBuffer
    this.midiData = new Map(); // midi file path → parsed { notes, duration } (for `synth.midi` tunes)
    this._noiseBuffer = null; // cached white-noise AudioBuffer (lazy, for `type:"noise"` layers)
    this._distortionCurves = new Map(); // amount(×100) → WaveShaper curve (cached, for `synth.distortion`)
    this.instances = []; // active sound instances for culling
    this.loopHandles = new Map(); // handle → loop instance
    this._nextHandle = 1;
    this._lastPlayTime = new Map(); // soundId → ctx.currentTime of last play (dedup)

    // Reverb character (game-agnostic, neutral default; override per project).
    this.reverbCutoff = opts.reverbCutoff ?? 6000;

    // One-time dev warnings (deduped per soundId)
    this._warnedUnknown = new Set();
    this._warnedNonLoop = new Set();
    this._warnedLoopCap = false;

    // Listener state (updated each frame)
    this.listenerX = 0;
    this.listenerY = 0;
    this.listenerAngle = 0;

    // Category gain nodes
    this.categoryGains = {};
    this.masterGain = null;
    this.muted = false;
    this.volume = 1.0;

    this._loaded = false;
  }

  // ─── Initialization ───────────────────────────────────────────

  _ensureContext() {
    if (this.ctx) return;
    this.ctx = new AudioContext();

    // Limiter — prevents clipping when sounds stack up
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;   // only kicks in near 0dBFS
    this.limiter.knee.value = 3;         // gentle transition
    this.limiter.ratio.value = 20;       // hard limit
    this.limiter.attack.value = 0.002;   // fast catch
    this.limiter.release.value = 0.05;   // quick recovery
    this.limiter.connect(this.ctx.destination);

    // Master gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.volume;
    this.masterGain.connect(this.limiter);

    // Analyser node for waveform visualization (tapped off master gain)
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.masterGain.connect(this.analyser);

    // Category gains
    for (const cat of Object.values(SoundCategory)) {
      const gain = this.ctx.createGain();
      gain.gain.value = 1.0;
      gain.connect(this.masterGain);
      this.categoryGains[cat] = gain;
    }

    // Shared reverb (convolver with procedural impulse response)
    this._initReverb();
  }

  _initReverb() {
    const duration = 2.5;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const impulse = this.ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Exponential decay — smooth tail
        const amp = Math.pow(1 - t, 2.5);
        data[i] = (Math.random() * 2 - 1) * amp;
      }
    }

    this.reverbConvolver = this.ctx.createConvolver();
    this.reverbConvolver.buffer = impulse;

    // Low-pass on reverb output — neutral cutoff (configurable via reverbCutoff)
    this.reverbFilter = this.ctx.createBiquadFilter();
    this.reverbFilter.type = 'lowpass';
    this.reverbFilter.frequency.value = this.reverbCutoff;

    this.reverbConvolver.connect(this.reverbFilter);
    this.reverbFilter.connect(this.masterGain);
  }

  /**
   * Wire a reverb send: sourceNode → gain(wet) → shared reverb convolver.
   * Shared by the one-shot builder and the synth loop builder so loops get
   * reverb too. No-op when there's no reverb graph or `wet` is falsy.
   */
  _applyReverbSend(sourceNode, wet) {
    return applyReverbSend(this.ctx, this.reverbConvolver, sourceNode, wet);
  }

  /**
   * Bundle the AudioContext + loaded buffers + reverb graph + the stateful
   * node-builder methods so the extracted voice constructors (synth/voices.js)
   * can build voices without reaching into instance state directly.
   */
  _kit() {
    return {
      ctx: this.ctx,
      buffers: this.buffers,
      reverbConvolver: this.reverbConvolver,
      buildVoiceTail: (d, e) => this._buildVoiceTail(d, e),
      buildNoiseLayer: (l, e) => this._buildNoiseLayer(l, e),
      buildVibrato: (v, o, n) => this._buildVibrato(v, o, n),
      applyReverbSend: (s, w) => this._applyReverbSend(s, w),
    };
  }

  async init() {
    this._ensureContext();

    // Collect all unique file paths — top-level file sounds AND file layers inside synths
    const filePaths = new Set();
    for (const config of Object.values(SOUND_CONFIG)) {
      if (config.file) filePaths.add(config.file);
      if (config.synth?.layers) {
        for (const layer of config.synth.layers) {
          if (layer.type === 'file' && layer.file) filePaths.add(layer.file);
        }
      }
    }

    const loadPromises = [...filePaths].map(async (filePath) => {
      try {
        const resp = await fetch(filePath);
        if (!resp.ok) {
          console.warn(`Sound load failed: ${filePath} (${resp.status})`);
          return;
        }
        const arrayBuf = await resp.arrayBuffer();
        const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
        this.buffers.set(filePath, audioBuf);
      } catch (err) {
        console.warn(`Sound decode failed: ${filePath}`, err);
      }
    });

    // MIDI tunes (`synth.midi`) are parsed, not decoded as audio — they're a score
    // the synth renders note-by-note.
    const midiPaths = new Set();
    for (const config of Object.values(SOUND_CONFIG)) {
      const path = this._midiPath(config.synth);
      if (path) midiPaths.add(path);
    }
    loadPromises.push(...[...midiPaths].map(p => this.loadMidi(p)));

    await Promise.all(loadPromises);
    this._loaded = true;
  }

  /** Normalize `synth.midi` (string | {file}) to a path, or null. */
  _midiPath(synth) {
    const m = synth?.midi;
    if (!m) return null;
    return typeof m === 'string' ? m : (m.file || null);
  }

  /** Fetch + parse a .mid file and cache it (path → {notes, duration}). Idempotent. */
  async loadMidi(path) {
    if (!path || this.midiData.has(path)) return this.midiData.get(path) || null;
    try {
      const resp = await fetch(path);
      if (!resp.ok) { console.warn(`MIDI load failed: ${path} (${resp.status})`); return null; }
      const parsed = parseMidi(await resp.arrayBuffer());
      this.midiData.set(path, parsed);
      return parsed;
    } catch (err) {
      console.warn(`MIDI parse failed: ${path}`, err);
      return null;
    }
  }

  resume() {
    this._ensureContext();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    if (!this._loaded && !this._loading) {
      this._loading = true;
      this.init();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  setVolume(level) {
    this.volume = Math.max(0, Math.min(1, level));
    if (this.masterGain && !this.muted) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  isMuted() { return this.muted; }
  getVolume() { return this.volume; }

  // ─── Listener ─────────────────────────────────────────────────

  updateListener(x, y, angle) {
    this.listenerX = x;
    this.listenerY = y;
    this.listenerAngle = angle;

    // Update all active positional loops
    for (const [handle, loop] of this.loopHandles) {
      if (loop.positional) {
        this._updatePositionalNodes(loop, loop.worldX, loop.worldY, loop.range);
      }
    }
  }

  // ─── One-Shot Positional ──────────────────────────────────────

  playPositional(soundId, worldX, worldY, opts = {}) {
    const config = SOUND_CONFIG[soundId];
    if (!config) { this._warnUnknown(soundId); return null; }
    // `loop` is authoritative — loop sounds delegate to the loop path.
    if (config.loop === true) return this.startLoop(soundId, worldX, worldY, opts);
    if (this._isDuplicate(soundId)) return null;

    // Synth path (may contain oscillator + file layers)
    if (config.synth) {
      if (!this.ctx) return null;

      const range = opts.range || config.range;
      if (range <= 0) return this._playUI(soundId, config, opts);

      const dist = this._distance(this.listenerX, this.listenerY, worldX, worldY);
      if (dist >= range) return null;

      this._cullOldest();

      const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;
      const nodes = this._buildPositionalChain(worldX, worldY, range, volume, config.category);

      // MIDI tune: render the score note-by-note (volume baked into the positional chain).
      const midiPath = this._midiPath(config.synth);
      if (midiPath) {
        const data = this.midiData.get(midiPath);
        if (data) return this._playSynthMidi(config.synth, data, 1.0, nodes.gain);
        this.loadMidi(midiPath);
        return null;
      }

      const { oscillators, sources } = this._buildSynthOneShot(config.synth, 1.0, nodes.gain);

      const instance = { oscillators, sources, nodes, startTime: this.ctx.currentTime, soundId };
      this.instances.push(instance);
      const endSource = oscillators[0] || sources[0];
      if (endSource) {
        endSource.onended = () => {
          const idx = this.instances.indexOf(instance);
          if (idx !== -1) this.instances.splice(idx, 1);
        };
      }
      return instance;
    }

    // Simple buffer path (top-level "file" with no synth block)
    if (!this._loaded) return null;
    const buffer = this.buffers.get(config.file);
    if (!buffer) return null;

    const range = opts.range || config.range;
    if (range <= 0) return this._playUI(soundId, config, opts);

    // Skip if out of range
    const dist = this._distance(this.listenerX, this.listenerY, worldX, worldY);
    if (dist >= range) return null;

    this._cullOldest();

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = opts.playbackRate || config.playbackRate || 1;

    const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;

    // Build audio chain: source → gain → filter → panner → category
    const nodes = this._buildPositionalChain(worldX, worldY, range, volume, config.category);
    source.connect(nodes.gain);
    source.start();

    const instance = { source, nodes, startTime: this.ctx.currentTime, soundId };
    this.instances.push(instance);
    source.onended = () => {
      const idx = this.instances.indexOf(instance);
      if (idx !== -1) this.instances.splice(idx, 1);
    };

    return instance;
  }

  // ─── One-Shot UI (non-positional) ─────────────────────────────

  playUI(soundId, opts = {}) {
    const config = SOUND_CONFIG[soundId];
    if (!config) { this._warnUnknown(soundId); return null; }
    // `loop` is authoritative — loop sounds delegate to the (non-positional) loop path.
    if (config.loop === true) return this.startUILoop(soundId, opts);
    if (this._isDuplicate(soundId)) return null;
    return this._playUI(soundId, config, opts);
  }

  /** Internal UI play — skips dedup (used by positional fallthrough). */
  _playUI(soundId, config, opts = {}) {
    // Synth path (may contain oscillator + file layers)
    if (config.synth) {
      if (!this.ctx) return null;

      this._cullOldest();

      const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;
      const catGain = this.categoryGains[config.category] || this.masterGain;

      // MIDI tune: render the score note-by-note through this synth voice.
      const midiPath = this._midiPath(config.synth);
      if (midiPath) {
        const data = this.midiData.get(midiPath);
        if (data) return this._playSynthMidi(config.synth, data, volume, catGain);
        this.loadMidi(midiPath); // not ready yet — load for next trigger
        return null;
      }

      const { oscillators, sources, gain } = this._buildSynthOneShot(config.synth, volume, catGain);

      const instance = { oscillators, sources, nodes: { gain }, startTime: this.ctx.currentTime, soundId };
      this.instances.push(instance);
      const endSource = oscillators[0] || sources[0];
      if (endSource) {
        endSource.onended = () => {
          const idx = this.instances.indexOf(instance);
          if (idx !== -1) this.instances.splice(idx, 1);
        };
      }
      return instance;
    }

    // Simple buffer path (top-level "file" with no synth block)
    if (!this._loaded) return null;
    const buffer = this.buffers.get(config.file);
    if (!buffer) return null;

    this._cullOldest();

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = opts.playbackRate || config.playbackRate || 1;

    const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;

    const catGain = this.categoryGains[config.category] || this.masterGain;
    source.connect(gain);
    gain.connect(catGain);
    source.start();

    const instance = { source, nodes: { gain }, startTime: this.ctx.currentTime, soundId };
    this.instances.push(instance);
    source.onended = () => {
      const idx = this.instances.indexOf(instance);
      if (idx !== -1) this.instances.splice(idx, 1);
    };

    return instance;
  }

  // ─── Looping Positional ───────────────────────────────────────

  startLoop(soundId, worldX, worldY, opts = {}) {
    const config = SOUND_CONFIG[soundId];
    if (!config) { this._warnUnknown(soundId); return null; }
    if (!config.loop) this._warnNonLoop(soundId);

    // Lazy-start: skip allocating voices for a positional loop that is currently
    // inaudible (out of range). EntityLoopManager re-calls startLoop each frame, so
    // the loop begins for real once the emitter comes into earshot and far emitters
    // cost nothing. (A one-shot caller that fires a positional loop out of range
    // simply gets no loop — by design.)
    const effRange = opts.range !== undefined ? opts.range : config.range;
    if (effRange > 0) {
      const dist = this._distance(this.listenerX, this.listenerY, worldX, worldY);
      if (this._calcDistanceGain(dist, effRange) <= LOOP_AUDIBLE_EPS) return null;
    }
    // Voice cap: keep the loop count bounded by culling the least-audible loop.
    if (this.loopHandles.size >= MAX_LOOPS && !this._cullQuietestLoop()) {
      this._warnLoopCap();
      return null;
    }

    // Synth loop path
    if (config.synth) {
      if (!this.ctx) return null;
      // A synth carrying a MIDI tune — or handed an inline `opts.notes` pattern (editable JSON
      // path) — loops the tune through the note scheduler, not a sustained voice.
      if (opts.notes || this._midiPath(config.synth)) return this._startMidiLoop(config, worldX, worldY, opts);
      return this._startSynthLoop(config, worldX, worldY, opts);
    }

    // Buffer loop path
    if (!this._loaded) return null;
    const buffer = this.buffers.get(config.file);
    if (!buffer) return null;

    const range = opts.range || config.range;
    const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;
    const positional = range > 0;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    if (opts.playbackRate) source.playbackRate.value = opts.playbackRate;

    let nodes;
    if (positional) {
      nodes = this._buildPositionalChain(worldX, worldY, range, volume, config.category);
    } else {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      const catGain = this.categoryGains[config.category] || this.masterGain;
      gain.connect(catGain);
      nodes = { gain };
    }

    source.connect(nodes.gain);

    // Fade in
    if (opts.fadeIn) {
      nodes.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      nodes.gain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + opts.fadeIn);
    }

    source.start();

    const handle = this._nextHandle++;
    const loop = {
      handle,
      source,
      nodes,
      soundId,
      worldX,
      worldY,
      range,
      baseVolume: volume,
      positional,
      configVolume: config.volume,
      category: config.category,
    };
    this.loopHandles.set(handle, loop);
    return handle;
  }

  updateLoop(handle, worldX, worldY, opts = {}) {
    const loop = this.loopHandles.get(handle);
    if (!loop) return;

    loop.worldX = worldX;
    loop.worldY = worldY;

    if (opts.range !== undefined) loop.range = opts.range;

    // Playback rate: buffer sources only
    if (opts.playbackRate !== undefined && loop.source) {
      loop.source.playbackRate.value = opts.playbackRate;
    }

    const volumeMultiplier = opts.volume !== undefined ? opts.volume : 1;
    loop.baseVolume = volumeMultiplier * loop.configVolume;

    if (loop.positional) {
      this._updatePositionalNodes(loop, worldX, worldY, loop.range);
    } else {
      loop.nodes.gain.gain.setTargetAtTime(loop.baseVolume, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Fade a running loop's volume to `targetVolume` over `seconds` — a musical crossfade
   * (unlike updateLoop's fixed ~50ms ramp or stopLoop which only fades to silence).
   * The building block for adaptive-music stem layering.
   */
  fadeLoop(handle, targetVolume, seconds = 1.0) {
    const loop = this.loopHandles.get(handle);
    if (!loop || !loop.nodes?.gain) return;
    const now = this.ctx.currentTime;
    const g = loop.nodes.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (seconds > 0) g.linearRampToValueAtTime(targetVolume, now + seconds);
    else g.setValueAtTime(targetVolume, now);
    loop.baseVolume = targetVolume;
  }

  stopLoop(handle, opts = {}) {
    const loop = this.loopHandles.get(handle);
    if (!loop) return;

    const stopTime = opts.fadeOut ? this.ctx.currentTime + opts.fadeOut : undefined;

    if (opts.fadeOut) {
      loop.nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, opts.fadeOut / 3);
    }

    // Stop a MIDI-tune loop: cancel its scheduler and stop all outstanding note voices.
    if (loop._timer) { clearInterval(loop._timer); loop._timer = null; }
    if (loop._voices) {
      for (const v of loop._voices) {
        for (const osc of v.oscillators) { try { stopTime ? osc.stop(stopTime) : osc.stop(); } catch (e) { /* already stopped */ } }
        for (const src of v.sources) { try { stopTime ? src.stop(stopTime) : src.stop(); } catch (e) { /* already stopped */ } }
      }
    }

    // Stop buffer source (simple file loops)
    if (loop.source) {
      try {
        if (stopTime) loop.source.stop(stopTime);
        else loop.source.stop();
      } catch (e) { /* already stopped */ }
    }

    // Stop file layer sources (synth loops with file layers)
    if (loop.sources) {
      for (const src of loop.sources) {
        try {
          if (stopTime) src.stop(stopTime);
          else src.stop();
        } catch (e) { /* already stopped */ }
      }
    }

    // Stop synth oscillators
    if (loop.oscillators) {
      for (const osc of loop.oscillators) {
        try {
          if (stopTime) osc.stop(stopTime);
          else osc.stop();
        } catch (e) { /* already stopped */ }
      }
    }
    if (loop.lfoOsc) {
      try {
        if (stopTime) loop.lfoOsc.stop(stopTime);
        else loop.lfoOsc.stop();
      } catch (e) { /* already stopped */ }
    }
    if (loop.vibratoOsc) {
      try {
        if (stopTime) loop.vibratoOsc.stop(stopTime);
        else loop.vibratoOsc.stop();
      } catch (e) { /* already stopped */ }
    }

    this.loopHandles.delete(handle);
  }

  // ─── UI Loop (non-positional) ─────────────────────────────────

  startUILoop(soundId, opts = {}) {
    return this.startLoop(soundId, 0, 0, { ...opts, range: 0 });
  }

  stopUILoop(handle, opts = {}) {
    this.stopLoop(handle, opts);
  }

  // ─── Synth: Randomization ──────────────────────────────────────

  // Randomization ([min,max] → concrete) lives in synth/randomize.js; these thin
  // methods preserve the instance surface (soundboard editor / tests call them).
  _resolveValue(v) { return resolveValue(v); }
  _resolveSynth(synthDef) { return resolveSynth(synthDef); }
  _resolveFilter(filterDef) { return resolveFilter(filterDef); }

  // ─── Synth: Shared Builders (noise / filter) ───────────────────

  // The DSP node builders live in synth/dsp.js (stateless, take `ctx`). These thin
  // methods keep the per-instance memo caches (`_noiseBuffer`, `_distortionCurves`)
  // and the reverb graph in the class while delegating construction.

  /** Lazily build & cache a 2s mono white-noise buffer for `type:"noise"` layers. */
  _getNoiseBuffer() {
    return (this._noiseBuffer ??= createNoiseBuffer(this.ctx));
  }

  _buildSynthFilter(filterDef, inputNode) {
    return buildSynthFilter(this.ctx, filterDef, inputNode);
  }

  /** Cached WaveShaper curve for a distortion `amount` (0..1). Classic soft-clip shape. */
  _distortionCurve(amount) {
    const key = Math.round(amount * 100);
    let curve = this._distortionCurves.get(key);
    if (curve) return curve;
    curve = makeDistortionCurve(amount);
    this._distortionCurves.set(key, curve);
    return curve;
  }

  /** Build a WaveShaper distortion (amount 0..1) and wire `inputNode → shaper`, or null. */
  _buildDistortion(amount, inputNode) {
    if (!amount) return null;
    return buildDistortion(this.ctx, this._distortionCurve(amount), inputNode);
  }

  /**
   * Post-envelope voice chain: `envelope → [distortion] → [filter]` → returns the tail node
   * (distortion first so the tone filter shapes the distorted signal, like a guitar amp+cab).
   * Both the dry connection and the reverb send tap the returned tail.
   */
  _buildVoiceTail(synthDef, envelope) {
    let node = envelope;
    const dist = this._buildDistortion(synthDef.distortion, node);
    if (dist) node = dist;
    const filt = this._buildSynthFilter(synthDef.filter, node);
    if (filt) node = filt;
    return node;
  }

  /**
   * Build a looping white-noise BufferSource for a noise layer, wiring it
   * (through an optional per-layer filter and gain) into `envelope`.
   * Returns the source so the caller can start/stop it.
   */
  _buildNoiseLayer(layer, envelope) {
    const source = this.ctx.createBufferSource();
    source.buffer = this._getNoiseBuffer();
    source.loop = true;
    const filtered = this._buildSynthFilter(layer.filter, source) || source;
    if (layer.gain !== undefined && layer.gain !== 1.0) {
      const layerGain = this.ctx.createGain();
      layerGain.gain.value = layer.gain;
      filtered.connect(layerGain);
      layerGain.connect(envelope);
    } else {
      filtered.connect(envelope);
    }
    return source;
  }

  /**
   * Build a vibrato (pitch LFO) oscillator modulating every oscillator's `detune`
   * (in cents) and start it. Returns the LFO oscillator (caller stops it) or null.
   */
  _buildVibrato(vibratoDef, oscillators, now) {
    return buildVibrato(this.ctx, vibratoDef, oscillators, now);
  }

  // ─── Synth: One-Shot Builder ────────────────────────────────────

  // Voice construction lives in synth/voices.js; this wrapper injects the audio kit
  // (ctx + buffers + reverb graph + stateful node builders). Behaviour unchanged.
  _buildSynthOneShot(rawSynthDef, peakVolume, outputNode, startAt) {
    return buildSynthOneShot(this._kit(), rawSynthDef, peakVolume, outputNode, startAt);
  }

  // ─── Synth: Loop Builder ────────────────────────────────────────

  _startSynthLoop(config, worldX, worldY, opts = {}) {
    const synthDef = this._resolveSynth(config.synth);
    const range = opts.range || config.range;
    const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;
    const positional = range > 0;

    const now = this.ctx.currentTime;

    let nodes;
    if (positional) {
      nodes = this._buildPositionalChain(worldX, worldY, range, volume, config.category);
    } else {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      const catGain = this.categoryGains[config.category] || this.masterGain;
      gain.connect(catGain);
      nodes = { gain };
    }

    // Reverb: resolve wet amount (mirror one-shot — number → that value, else 0.4).
    const wet = (synthDef.reverb && this.reverbConvolver)
      ? (typeof synthDef.reverb === 'number' ? synthDef.reverb : 0.4)
      : 0;
    const dryScale = wet ? 1 - wet * 0.5 : 1;

    // Envelope for fade-in (loops sustain, no decay). Dry scaled to balance the wet send.
    const envelope = this.ctx.createGain();
    if (opts.fadeIn) {
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(dryScale, now + opts.fadeIn);
    } else {
      envelope.gain.value = dryScale;
    }
    // Post-envelope chain: distortion → tone filter (mirrors the one-shot path).
    const tail = this._buildVoiceTail(synthDef, envelope);
    tail.connect(nodes.gain);

    // Wet send to shared reverb (previously dropped for loops — ambientMusic/windLoop ran dry).
    if (wet) this._applyReverbSend(tail, wet * volume);

    // Build layers — oscillators, noise, and file buffer sources
    const layers = synthDef.layers || [{
      type: synthDef.type || 'sine',
      freq: synthDef.freq || 440,
      gain: 1.0,
      detune: synthDef.detune || 0,
    }];

    const oscillators = [];
    const loopSources = [];
    for (const layer of layers) {
      if (layer.type === 'file') {
        // File layer (looping)
        const buffer = this.buffers.get(layer.file);
        if (!buffer) continue;

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.playbackRate.value = layer.playbackRate || 1;

        if (layer.gain !== undefined && layer.gain !== 1.0) {
          const layerGain = this.ctx.createGain();
          layerGain.gain.value = layer.gain;
          source.connect(layerGain);
          layerGain.connect(envelope);
        } else {
          source.connect(envelope);
        }

        source.start(now);
        loopSources.push(source);
      } else if (layer.type === 'noise') {
        // Noise layer (looping) — buffer already loops; rides the loop envelope
        const source = this._buildNoiseLayer(layer, envelope);
        source.start(now);
        loopSources.push(source);
      } else {
        // Oscillator layer
        const osc = this.ctx.createOscillator();
        osc.type = layer.type || 'sine';
        osc.frequency.value = layer.freq || 440;
        if (layer.detune) osc.detune.value = layer.detune;

        if (layer.gain !== undefined && layer.gain !== 1.0) {
          const layerGain = this.ctx.createGain();
          layerGain.gain.value = layer.gain;
          osc.connect(layerGain);
          layerGain.connect(envelope);
        } else {
          osc.connect(envelope);
        }

        osc.start(now);
        oscillators.push(osc);
      }
    }

    // Optional LFO for pulsing/warbling
    let lfoOsc = null;
    if (synthDef.lfo) {
      lfoOsc = this.ctx.createOscillator();
      lfoOsc.type = 'sine';
      lfoOsc.frequency.value = synthDef.lfo.freq || 4;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = synthDef.lfo.depth || 0.5;
      lfoOsc.connect(lfoGain);
      lfoGain.connect(envelope.gain);
      lfoOsc.start(now);
    }

    // Optional vibrato (pitch LFO) — sustains with the loop, stopped in stopLoop().
    const vibratoOsc = this._buildVibrato(synthDef.vibrato, oscillators, now);

    const handle = this._nextHandle++;
    const loop = {
      handle,
      source: null,
      sources: loopSources,
      oscillators,
      lfoOsc,
      vibratoOsc,
      envelope,
      nodes,
      soundId: 'synth',
      worldX,
      worldY,
      range,
      baseVolume: volume,
      positional,
      configVolume: config.volume,
      category: config.category,
    };
    this.loopHandles.set(handle, loop);
    return handle;
  }

  // ─── Raw Synth (for editor preview without SOUND_CONFIG lookup) ──

  playRawSynth(synthDef, volume = 1.0) {
    this._ensureContext();
    this._cullOldest();
    const catGain = this.masterGain;

    // MIDI tune preview: render the score through this synth voice (editor calls
    // loadMidi() first, so the data is cached by the time we get here).
    const midiPath = this._midiPath(synthDef);
    if (midiPath) {
      const data = this.midiData.get(midiPath);
      if (data) return this._playSynthMidi(synthDef, data, volume, catGain);
      this.loadMidi(midiPath);
      return null;
    }

    const { oscillators, sources, gain } = this._buildSynthOneShot(synthDef, volume, catGain);
    const instance = { oscillators, sources, nodes: { gain }, startTime: this.ctx.currentTime, soundId: '_raw' };
    this.instances.push(instance);
    const endSource = oscillators[0] || sources[0];
    if (endSource) {
      endSource.onended = () => {
        const idx = this.instances.indexOf(instance);
        if (idx !== -1) this.instances.splice(idx, 1);
      };
    }
    return instance;
  }

  startRawSynthLoop(synthDef, volume = 1.0) {
    this._ensureContext();
    const fakeConfig = { synth: synthDef, volume, range: 0, category: 'ui' };
    if (this._midiPath(synthDef)) return this._startMidiLoop(fakeConfig, 0, 0, { range: 0 });
    return this._startSynthLoop(fakeConfig, 0, 0, { range: 0 });
  }

  // ─── Synth: MIDI Tune Rendering ─────────────────────────────────

  // Pure MIDI helpers live in synth/midiVoice.js; the two note renderers live in
  // synth/voices.js. These thin methods preserve the instance surface and inject
  // the audio kit for the renderers.
  _transposeSynth(instrument, ratio) { return transposeSynth(instrument, ratio); }
  _midiNotesFor(synthDef, midiData) { return midiNotesFor(synthDef, midiData); }
  _midiVoiceSetup(synthDef) { return midiVoiceSetup(synthDef); }

  _renderMidiNote(setup, note, peakVolume, outputNode, when, suppressReverb) {
    return renderMidiNote(this._kit(), setup, note, peakVolume, outputNode, when, suppressReverb);
  }

  _renderMidiNotes(synthDef, midiData, peakVolume, outputNode, startTime, suppressReverb = false) {
    return renderMidiNotes(this._kit(), synthDef, midiData, peakVolume, outputNode, startTime, suppressReverb);
  }

  /**
   * One-shot MIDI tune: render once and track as ONE aggregate instance so the
   * 32-voice cull treats the tune as a unit (no per-instance gain — outputNode is
   * shared, so culling must not fade it).
   */
  _playSynthMidi(synthDef, midiData, peakVolume, outputNode, baseTime) {
    if (!midiData?.notes?.length) return null;
    const start = baseTime ?? this.ctx.currentTime;
    const { oscillators, sources, lastEndNode } = this._renderMidiNotes(synthDef, midiData, peakVolume, outputNode, start);

    const instance = { oscillators, sources, nodes: {}, startTime: this.ctx.currentTime, soundId: '_midi' };
    this.instances.push(instance);
    if (lastEndNode) {
      lastEndNode.onended = () => {
        const idx = this.instances.indexOf(instance);
        if (idx !== -1) this.instances.splice(idx, 1);
      };
    }
    return instance;
  }

  /**
   * Audition a single synth voice at a MIDI pitch — for an editor previewing notes. Renders
   * one note through `synth`'s timbre (its layers/filter/etc.); generic, no game knowledge.
   */
  playSynthNote(synth, midi, { volume = 0.8, duration = 0.45, category } = {}) {
    this.resume();
    if (!synth || !this.ctx) return;
    const setup = this._midiVoiceSetup(synth);
    const out = this.ctx.createGain();
    out.gain.value = volume;
    out.connect((this.categoryGains && this.categoryGains[category]) || this.masterGain);
    this._renderMidiNote(setup, { midi, duration, velocity: 0.9 }, 1.0, out, this.ctx.currentTime, false);
  }

  /**
   * Looping MIDI tune (`loop:true` + `synth.midi`): a setInterval look-ahead scheduler
   * keeps the next tune iteration scheduled ~LOOKAHEAD ahead on the audio clock, pruning
   * finished iterations. Registered in `loopHandles` like any loop; `stopLoop` clears the
   * timer and stops outstanding voices. Volume/fade live on a single gain (or positional
   * chain) so updateLoop/fadeOut behave like other loops.
   */
  _startMidiLoop(config, worldX, worldY, opts = {}) {
    // Notes come from either an inline `opts.notes` pattern (editable JSON path) or a parsed
    // `.mid` file the sound points at. `notes`/`tuneDuration` are `let` so the scheduler can
    // live-swap them (see updateMidiLoopNotes) without restarting the loop.
    let notes, tuneDuration;
    if (opts.notes) {
      notes = opts.notes;
      tuneDuration = Math.max(0.1, opts.loopLen ?? this._notesDuration(notes));
    } else {
      const midiData = this.midiData.get(this._midiPath(config.synth));
      if (!midiData?.notes?.length) { this.loadMidi(this._midiPath(config.synth)); return null; }
      tuneDuration = Math.max(0.1, midiData.duration);
      notes = this._midiNotesFor(config.synth, midiData);
    }

    const range = opts.range || config.range;
    const volume = (opts.volume !== undefined ? opts.volume : 1) * config.volume;
    const positional = range > 0;
    const now = this.ctx.currentTime;
    // Shared downbeat: the MusicDirector hands every stem the same startAt so they loop in
    // lock-step (sample-accurate). Default = immediate.
    const startAt = opts.startAt ?? now;

    let nodes;
    if (positional) {
      nodes = this._buildPositionalChain(worldX, worldY, range, volume, config.category);
    } else {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      (this.categoryGains[config.category] || this.masterGain) && gain.connect(this.categoryGains[config.category] || this.masterGain);
      nodes = { gain };
    }
    if (opts.fadeIn) {
      nodes.gain.gain.setValueAtTime(0, now);
      nodes.gain.gain.linearRampToValueAtTime(volume, now + opts.fadeIn);
    }

    // One reverb send for the whole stem, tapped off the loop's output gain — so muting/
    // fading the loop kills the wet too. (Per-note reverb is suppressed below; otherwise the
    // scheduler keeps feeding the shared reverb and a "muted" stem still washes through it.)
    const rv = config.synth.reverb;
    const wet = rv === true ? 0.4 : (typeof rv === 'number' ? rv : 0);
    if (wet) this._applyReverbSend(nodes.gain, wet);

    // Incremental note-by-note look-ahead scheduler. Critical for dense songs: rather than
    // building a whole 30s+ iteration's nodes in one synchronous burst (thousands of Web Audio
    // nodes → frame hitches + glitches), we only build the few notes that start within the next
    // LOOKAHEAD, on a frequent timer. Far fewer live nodes; smooth.
    const setup = this._midiVoiceSetup(config.synth);

    const handle = this._nextHandle++;
    const loop = {
      handle, source: null, nodes, soundId: 'midiLoop',
      worldX, worldY, range, baseVolume: volume, positional,
      configVolume: config.volume, category: config.category,
      _voices: [], _iterStart: startAt, _idx: 0, _tuneDuration: tuneDuration, _timer: null,
      _pendingNotes: null, _pendingLoopLen: null, _notes: notes, _timeScale: setup.timeScale,
    };

    // Joining a song mid-loop (a phase-aligned stem swap passes a startAt in the past): fast-
    // forward the scheduler past notes that already played this iteration so we don't burst
    // them all at the join — the new voice picks up in phase with the still-playing stems.
    if (startAt < now && notes.length) {
      let guard = notes.length * 4;
      while (guard-- > 0) {
        if (loop._idx >= notes.length) { loop._iterStart += tuneDuration; loop._idx = 0; }
        if (loop._iterStart + notes[loop._idx].time * setup.timeScale >= now) break;
        loop._idx++;
      }
    }

    const LOOKAHEAD = 0.5; // seconds of notes scheduled ahead of the clock
    const MAX_PER_TICK = 64; // bound work per tick (catch-up safety, prevents bursts)
    const schedule = () => {
      // Live edit: swap in a pending notes/length update at the top of the tick. Keeping
      // _iterStart/_idx means playback continues in phase (multi-stem songs stay in sync).
      if (loop._pendingNotes) {
        notes = loop._pendingNotes;
        loop._notes = notes;
        loop._pendingNotes = null;
        if (loop._pendingLoopLen != null) { tuneDuration = loop._pendingLoopLen; loop._tuneDuration = tuneDuration; loop._pendingLoopLen = null; }
        if (loop._idx > notes.length) loop._idx = 0; // clamp if the new pattern is shorter
      }
      if (!notes.length) return;
      const ctxNow = this.ctx.currentTime;
      const horizon = ctxNow + LOOKAHEAD;
      loop._voices = loop._voices.filter(v => v.endTime > ctxNow); // drop finished notes
      for (let i = 0; i < MAX_PER_TICK; i++) {
        if (loop._idx >= notes.length) { loop._iterStart += tuneDuration; loop._idx = 0; } // wrap to next loop
        const note = notes[loop._idx];
        const when = loop._iterStart + note.time * setup.timeScale;
        if (when >= horizon) break; // nothing due yet
        loop._voices.push(this._renderMidiNote(setup, note, 1.0, nodes.gain, Math.max(when, ctxNow), true));
        loop._idx++;
      }
    };
    schedule();
    loop._timer = setInterval(schedule, 60); // frequent, tiny bursts

    this.loopHandles.set(handle, loop);
    return handle;
  }

  /** Total length (seconds) spanned by a seconds-based note list. */
  _notesDuration(notes) { return notesDuration(notes); }

  /**
   * Live-swap a running MIDI loop's notes (and optionally loop length) WITHOUT restarting —
   * the scheduler picks them up on its next tick, preserving phase so multi-stem songs stay
   * in sync. `notes` is a seconds-based list like the parser emits. Returns false if `handle`
   * isn't a running MIDI loop.
   */
  updateMidiLoopNotes(handle, notes, loopLen) {
    const loop = this.loopHandles.get(handle);
    if (!loop || !loop._timer) return false; // not a (running) MIDI loop
    loop._pendingNotes = Array.isArray(notes) ? notes : [];
    loop._pendingLoopLen = (typeof loopLen === 'number' && loopLen > 0)
      ? loopLen
      : Math.max(0.1, this._notesDuration(loop._pendingNotes));
    return true;
  }

  /**
   * Seek a running MIDI loop to `phase` (0..1) — repositions the scheduler IN PLACE (no
   * restart, so the loop's gain/fade is preserved): stops the notes already scheduled ahead
   * and re-aligns `_iterStart`/`_idx` so playback continues from the new position.
   */
  seekMidiLoop(handle, phase) {
    const loop = this.loopHandles.get(handle);
    if (!loop || !loop._timer || !loop._notes) return false;
    const now = this.ctx.currentTime;
    for (const v of loop._voices) {
      (v.oscillators || []).forEach(o => { try { o.stop(); } catch {} });
      (v.sources || []).forEach(s => { try { s.stop(); } catch {} });
    }
    loop._voices = [];
    loop._iterStart = now - Math.max(0, Math.min(1, phase)) * loop._tuneDuration;
    loop._idx = 0;
    const notes = loop._notes, ts = loop._timeScale || 1;
    let guard = notes.length * 4;
    while (guard-- > 0 && notes.length) {
      if (loop._idx >= notes.length) { loop._iterStart += loop._tuneDuration; loop._idx = 0; }
      if (loop._iterStart + notes[loop._idx].time * ts >= now) break;
      loop._idx++;
    }
    return true;
  }

  // ─── Internal: Positional Audio Chain ─────────────────────────

  _buildPositionalChain(worldX, worldY, range, volume, category) {
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const panner = this.ctx.createStereoPanner();

    const dist = this._distance(this.listenerX, this.listenerY, worldX, worldY);
    // Guard against NaN world positions: a non-finite AudioParam value throws.
    const g = volume * this._calcDistanceGain(dist, range);
    gain.gain.value = Number.isFinite(g) ? g : 0;
    const cutoff = this._calcFilterCutoff(dist, range);
    filter.frequency.value = Number.isFinite(cutoff) ? cutoff : 20000;
    const pan = this._calcPan(worldX, worldY);
    panner.pan.value = Number.isFinite(pan) ? pan : 0;

    const catGain = this.categoryGains[category] || this.masterGain;
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(catGain);

    return { gain, filter, panner };
  }

  _updatePositionalNodes(loop, worldX, worldY, range) {
    const dist = this._distance(this.listenerX, this.listenerY, worldX, worldY);
    const distGain = this._calcDistanceGain(dist, range);
    // Guard each AudioParam: a NaN world position would otherwise throw mid-frame.
    let targetVol = loop.baseVolume * distGain;
    if (!Number.isFinite(targetVol)) targetVol = 0;

    const now = this.ctx.currentTime;
    loop.nodes.gain.gain.setTargetAtTime(targetVol, now, 0.03);

    if (loop.nodes.filter) {
      let cutoff = this._calcFilterCutoff(dist, range);
      if (!Number.isFinite(cutoff)) cutoff = 20000;
      loop.nodes.filter.frequency.setTargetAtTime(cutoff, now, 0.03);
    }
    if (loop.nodes.panner) {
      let pan = this._calcPan(worldX, worldY);
      if (!Number.isFinite(pan)) pan = 0;
      loop.nodes.panner.pan.setTargetAtTime(pan, now, 0.03);
    }
  }

  // ─── Distance Model ───────────────────────────────────────────

  _distance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _calcDistanceGain(dist, range) {
    if (range <= 0) return 1;
    if (!Number.isFinite(dist)) return 0; // NaN position → silent, never NaN
    if (dist >= range) return 0;
    return Math.max(0, 1 - Math.pow(dist / range, 1.5));
  }

  _calcPan(worldX, worldY) {
    const dx = worldX - this.listenerX;
    const dy = worldY - this.listenerY;
    const soundAngle = Math.atan2(dy, dx);
    const relative = soundAngle - this.listenerAngle;
    const pan = Math.max(-1, Math.min(1, Math.sin(relative)));
    return Number.isFinite(pan) ? pan : 0; // NaN position → centered
  }

  _calcFilterCutoff(dist, range) {
    if (range <= 0) return 20000;
    if (!Number.isFinite(dist)) return 20000; // NaN position → open filter, never NaN
    const t = Math.min(1, dist / range);
    return 20000 * Math.pow(1 - t, 2) + 800;
  }

  // ─── Dev Warnings (deduped, one per soundId) ──────────────────

  /** Warn once when a play/loop is requested for an id with no config. */
  _warnUnknown(soundId) {
    if (this._warnedUnknown.has(soundId)) return;
    this._warnedUnknown.add(soundId);
    console.warn(`[SoundManager] unknown sound id: "${soundId}"`);
  }

  /** Warn once when startLoop is used on a sound whose config.loop isn't true. */
  _warnNonLoop(soundId) {
    if (this._warnedNonLoop.has(soundId)) return;
    this._warnedNonLoop.add(soundId);
    console.warn(`[SoundManager] startLoop called on non-loop sound "${soundId}" (config.loop is not true)`);
  }

  /** Warn once when the loop voice cap is hit and nothing could be culled. */
  _warnLoopCap() {
    if (this._warnedLoopCap) return;
    this._warnedLoopCap = true;
    console.warn(`[SoundManager] loop voice cap (${MAX_LOOPS}) reached`);
  }

  /** Stop the least-audible positional loop to free a voice. Returns true if one was culled. */
  _cullQuietestLoop() {
    let quietest = null, lowest = Infinity;
    for (const loop of this.loopHandles.values()) {
      if (!loop.positional) continue; // never cull non-positional (UI/ambient) loops
      const dist = this._distance(this.listenerX, this.listenerY, loop.worldX, loop.worldY);
      const g = loop.baseVolume * this._calcDistanceGain(dist, loop.range);
      if (g < lowest) { lowest = g; quietest = loop; }
    }
    if (!quietest) return false;
    this.stopLoop(quietest.handle, { fadeOut: CULL_FADE_TIME });
    return true;
  }

  // ─── Deduplication ───────────────────────────────────────────

  /** Returns true if this soundId was already played within the dedup window. */
  _isDuplicate(soundId) {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    const last = this._lastPlayTime.get(soundId);
    if (last !== undefined && now - last < DEDUP_WINDOW) return true;
    this._lastPlayTime.set(soundId, now);
    return false;
  }

  // ─── Culling ──────────────────────────────────────────────────

  _cullOldest() {
    while (this.instances.length >= MAX_CONCURRENT) {
      const oldest = this.instances.shift();
      if (!oldest) continue;

      // Micro-fade to prevent pops from abrupt cutoff
      const now = this.ctx.currentTime;
      if (oldest.nodes?.gain) {
        const g = oldest.nodes.gain.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + CULL_FADE_TIME);
      }

      const stopTime = now + CULL_FADE_TIME + 0.01;
      if (oldest.source) {
        try { oldest.source.stop(stopTime); } catch (e) { /* already stopped */ }
      }
      if (oldest.sources) {
        for (const src of oldest.sources) {
          try { src.stop(stopTime); } catch (e) { /* already stopped */ }
        }
      }
      if (oldest.oscillators) {
        for (const osc of oldest.oscillators) {
          try { osc.stop(stopTime); } catch (e) { /* already stopped */ }
        }
      }
    }
  }
}
