import { SOUND_CONFIG, SoundCategory } from '/engine/data/sounds.js';

const MAX_CONCURRENT = 32;
const MAX_LOOPS = 24;         // cap on simultaneous looping voices (separate from one-shots)
const LOOP_AUDIBLE_EPS = 0.001; // distance-gain below which a positional loop is treated as inaudible
const CULL_FADE_TIME = 0.015; // 15ms micro-fade to prevent pops on culling
const DEDUP_WINDOW = 0.03;   // 30ms — suppress duplicate plays of the same sound

export class SoundManager {
  constructor(opts = {}) {
    this.ctx = null; // AudioContext, created lazily
    this.buffers = new Map(); // soundId → AudioBuffer
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
    if (!this.reverbConvolver || !wet) return null;
    const reverbSend = this.ctx.createGain();
    reverbSend.gain.value = wet;
    sourceNode.connect(reverbSend);
    reverbSend.connect(this.reverbConvolver);
    return reverbSend;
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
    await Promise.all(loadPromises);
    this._loaded = true;
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

  stopLoop(handle, opts = {}) {
    const loop = this.loopHandles.get(handle);
    if (!loop) return;

    const stopTime = opts.fadeOut ? this.ctx.currentTime + opts.fadeOut : undefined;

    if (opts.fadeOut) {
      loop.nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, opts.fadeOut / 3);
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

  /** Resolve a value that may be a number or a [min, max] range array. */
  _resolveValue(v) {
    if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0]);
    return v;
  }

  /** Deep-clone a synth definition, resolving any [min, max] ranges to concrete numbers. */
  _resolveSynth(synthDef) {
    const resolved = {};

    // Top-level numeric params
    for (const key of ['freq', 'freqEnd', 'duration', 'attack', 'decay', 'detune', 'reverb']) {
      if (synthDef[key] !== undefined) resolved[key] = this._resolveValue(synthDef[key]);
    }

    // Pass through non-randomizable params
    if (synthDef.type) resolved.type = synthDef.type;

    // Layers
    if (synthDef.layers) {
      resolved.layers = synthDef.layers.map(layer => {
        const r = {};
        if (layer.type) r.type = layer.type;

        if (layer.type === 'file') {
          // File layer — pass through path, resolve randomizable gain/playbackRate
          r.file = layer.file;
          if (layer.gain !== undefined) r.gain = this._resolveValue(layer.gain);
          if (layer.playbackRate !== undefined) r.playbackRate = this._resolveValue(layer.playbackRate);
        } else {
          // Oscillator layer
          for (const key of ['freq', 'freqEnd', 'gain', 'detune']) {
            if (layer[key] !== undefined) r[key] = this._resolveValue(layer[key]);
          }
        }
        return r;
      });
    }

    // LFO
    if (synthDef.lfo) {
      resolved.lfo = {};
      if (synthDef.lfo.freq !== undefined) resolved.lfo.freq = this._resolveValue(synthDef.lfo.freq);
      if (synthDef.lfo.depth !== undefined) resolved.lfo.depth = this._resolveValue(synthDef.lfo.depth);
    }

    return resolved;
  }

  // ─── Synth: One-Shot Builder ────────────────────────────────────

  _buildSynthOneShot(rawSynthDef, peakVolume, outputNode) {
    const synthDef = this._resolveSynth(rawSynthDef);
    const now = this.ctx.currentTime;

    // Build layer list (backward compat: single-oscillator shorthand)
    const layers = synthDef.layers || [{
      type: synthDef.type || 'sine',
      freq: synthDef.freq || 440,
      freqEnd: synthDef.freqEnd,
      gain: 1.0,
      detune: synthDef.detune || 0,
    }];

    // Determine if envelope shaping is needed:
    // - Oscillator layers always need an envelope (they'd play forever otherwise)
    // - File-only layers with no explicit timing play at constant volume naturally
    const hasOscLayers = layers.some(l => l.type !== 'file');
    const hasExplicitEnvelope = synthDef.duration !== undefined ||
                                synthDef.attack !== undefined ||
                                synthDef.decay !== undefined;
    const useEnvelope = hasOscLayers || hasExplicitEnvelope;

    // Auto-detect duration: explicit > longest file buffer > 0.5s default
    let duration = synthDef.duration;
    if (!duration) {
      const fileDurations = layers
        .filter(l => l.type === 'file')
        .map(l => { const b = this.buffers.get(l.file); return b ? b.duration : 0; });
      duration = fileDurations.length > 0 ? Math.max(...fileDurations) : 0.5;
    }

    const attack = synthDef.attack || 0.005;
    const decay = synthDef.decay || (duration - attack);

    // Envelope gain node — shaped or flat depending on layer composition
    const envelope = this.ctx.createGain();
    if (useEnvelope) {
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(peakVolume, now + attack);
      envelope.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
    } else {
      // Flat gain — file layers play at natural volume, no fade
      envelope.gain.value = peakVolume;
    }
    envelope.connect(outputNode);

    // Build layers — oscillators and file buffer sources share the same envelope
    const oscillators = [];
    const sources = [];
    for (const layer of layers) {
      if (layer.type === 'file') {
        // ── File layer ──
        const buffer = this.buffers.get(layer.file);
        if (!buffer) continue;

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
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
        // Only force-stop files if envelope is shaping the duration
        if (useEnvelope) source.stop(now + duration + 0.05);
        sources.push(source);
      } else {
        // ── Oscillator layer ──
        const osc = this.ctx.createOscillator();
        osc.type = layer.type || 'sine';
        osc.frequency.setValueAtTime(layer.freq || 440, now);
        if (layer.freqEnd) {
          osc.frequency.exponentialRampToValueAtTime(layer.freqEnd, now + duration);
        }
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
        osc.stop(now + duration + 0.05);
        oscillators.push(osc);
      }
    }

    // Optional LFO gain modulation (warble/pulse effect)
    if (synthDef.lfo) {
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = synthDef.lfo.freq || 4;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = peakVolume * (synthDef.lfo.depth || 0.5);
      lfo.connect(lfoGain);
      lfoGain.connect(envelope.gain);
      lfo.start(now);
      // Always stop the LFO — a file-only layer set (useEnvelope false) would
      // otherwise leak the oscillator forever. `duration` is defined on all paths.
      lfo.stop(now + duration + 0.05);
    }

    // Reverb send — split dry/wet so total volume stays constant
    if (synthDef.reverb && this.reverbConvolver) {
      const wet = typeof synthDef.reverb === 'number' ? synthDef.reverb : 0.4;
      const dryScale = 1 - wet * 0.5;
      if (useEnvelope) {
        envelope.gain.cancelScheduledValues(now);
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(peakVolume * dryScale, now + attack);
        envelope.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
      } else {
        envelope.gain.value = peakVolume * dryScale;
      }

      this._applyReverbSend(envelope, wet * peakVolume);
    }

    return { oscillators, sources, gain: envelope, endTime: now + duration };
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
    envelope.connect(nodes.gain);

    // Wet send to shared reverb (previously dropped for loops — ambientMusic/windLoop ran dry).
    if (wet) this._applyReverbSend(envelope, wet * volume);

    // Build layers — oscillators and file buffer sources
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

    const handle = this._nextHandle++;
    const loop = {
      handle,
      source: null,
      sources: loopSources,
      oscillators,
      lfoOsc,
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
    return this._startSynthLoop(fakeConfig, 0, 0, { range: 0 });
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
