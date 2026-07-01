import { FX_SEQUENCES, seqRefToId } from '/engine/data/fxSequences.js';
import { VFX_DEFS } from '/engine/data/vfx.js';

// Dev-mode validation: warn once per unknown key so a bad sequence is loud but not spammy.
const _warnedKeys = new Set();
function _warnOnce(key, msg) {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  console.warn(msg);
}

/**
 * Orchestrates SFX + VFX + game signals from data-driven FXSequence definitions.
 *
 * Each sequence is a list of timed steps that can play sounds, spawn visual effects,
 * start/stop loops, or emit signals to game code.
 */
export class FXSequenceRunner {
  /**
   * @param {object} soundManager  - SoundManager instance (plays SFX)
   * @param {object} effectsManager - EffectsManager instance (spawns VFX)
   * @param {function} onSignal    - Callback for signal steps: (name, data, opts) => void
   */
  constructor(soundManager, effectsManager, onSignal) {
    this.sound = soundManager;
    this.effects = effectsManager;
    this.onSignal = onSignal || (() => {});

    /** Active named loops: handle → loopId from SoundManager */
    this.activeLoops = new Map();

    /** Active timers for cleanup on stopAll */
    this.activeTimers = new Set();

    /** Listener position — used as fallback for VFX when no x/y provided */
    this.listenerX = 0;
    this.listenerY = 0;
  }

  /**
   * Play an FX sequence by ID.
   *
   * @param {string} sequenceId - camelCase sequence ID (e.g. "torpedoExplosion")
   * @param {object} opts
   * @param {number} [opts.x]           - World X for positional sequences
   * @param {number} [opts.y]           - World Y for positional sequences
   * @param {number} [opts.volume]      - Volume multiplier for all SFX steps
   * @param {number} [opts.blastRadius] - Override blast radius for VFX
   * @param {object} [opts.vars]        - Variable substitutions for parameterized IDs
   */
  play(sequenceId, opts = {}) {
    // Resolve variable substitution in sequence ID
    if (opts.vars) {
      for (const [key, val] of Object.entries(opts.vars)) {
        sequenceId = sequenceId.replace(`\${${key}}`, val);
      }
    }

    const seq = FX_SEQUENCES[sequenceId];
    if (!seq) return;

    const positional = seq.positional && opts.x !== undefined && opts.y !== undefined;

    for (const step of seq.steps) {
      if (step.delay === 0) {
        this._executeStep(step, positional, opts);
      } else {
        const timerId = setTimeout(() => {
          this.activeTimers.delete(timerId);
          this._executeStep(step, positional, opts);
        }, step.delay);
        this.activeTimers.add(timerId);
      }
    }
  }

  /**
   * Play a sequence from a snake_case seq: reference.
   * Converts "engine_start" → "engineStart" before lookup.
   */
  playSeqRef(snakeRef, opts = {}) {
    this.play(seqRefToId(snakeRef), opts);
  }

  /**
   * Execute a single sequence step immediately, ignoring its `delay`. Positional
   * when `opts.x`/`opts.y` are supplied. Lets a host (e.g. an editor's per-step
   * preview) fire one step through the same interpretation as a full `play()` —
   * repeat/offset+angle/volume/loop-by-handle/signal semantics all identical.
   * @param {object} step - a sequence step ({ type, ... })
   * @param {object} [opts] - same shape as play()'s opts (x, y, angle, volume, entity, …)
   */
  playStep(step, opts = {}) {
    if (!step) return;
    const positional = opts.x !== undefined && opts.y !== undefined;
    this._executeStep(step, positional, opts);
  }

  /** Stop all active timers and loops. */
  stopAll() {
    for (const timerId of this.activeTimers) {
      clearTimeout(timerId);
    }
    this.activeTimers.clear();

    for (const [, loopId] of this.activeLoops) {
      if (loopId) this.sound.stopLoop(loopId, { fadeOut: 0.1 });
    }
    this.activeLoops.clear();
  }

  /** Get a loop handle's underlying loopId (for per-frame updates). */
  getHandle(handleName) {
    return this.activeLoops.get(handleName) || null;
  }

  /** Update listener position — used as VFX fallback when no x/y provided. */
  updateListenerPosition(x, y) {
    this.listenerX = x;
    this.listenerY = y;
  }

  /** Stop a specific named loop. */
  stopHandle(handleName, opts = {}) {
    const loopId = this.activeLoops.get(handleName);
    if (loopId) {
      this.sound.stopLoop(loopId, opts);
      this.activeLoops.delete(handleName);
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  _executeStep(step, positional, opts) {
    switch (step.type) {
      case 'sfx':
        this._playSfx(step, positional, opts);
        break;
      case 'vfx':
        this._spawnVfx(step, positional, opts);
        break;
      case 'loopStart':
        this._startLoop(step, positional, opts);
        break;
      case 'loopStop':
        this._stopLoop(step);
        break;
      case 'signal':
        this.onSignal(step.name, step.data, opts);
        break;
      default:
        _warnOnce('stepType:' + step.type, `[FX] unknown sequence step type: ${step.type}`);
        break;
    }
  }

  _playSfx(step, positional, opts) {
    if (!step.sound) {
      _warnOnce('sfxDef:' + step.sound, `[FX] sequence sfx step has no sound id: ${step.sound}`);
      return;
    }
    const playOpts = {};
    if (step.volume !== undefined) playOpts.volume = step.volume;
    if (opts.volume !== undefined) playOpts.volume = (step.volume ?? 1) * opts.volume;

    const count = this._resolveRepeatCount(step.repeat);
    const gap = step.repeatDelay || 0;

    for (let i = 0; i < count; i++) {
      const delay = i * gap;
      const fire = () => {
        if (positional) {
          this.sound.playPositional(step.sound, opts.x, opts.y, playOpts);
        } else {
          this.sound.playUI(step.sound, playOpts);
        }
      };
      if (delay === 0) {
        fire();
      } else {
        const timerId = setTimeout(() => {
          this.activeTimers.delete(timerId);
          fire();
        }, delay);
        this.activeTimers.add(timerId);
      }
    }
  }

  _spawnVfx(step, _positional, opts) {
    if (!this.effects) return;

    const vfxDef = VFX_DEFS[step.effect];
    if (!vfxDef) {
      _warnOnce('vfxDef:' + step.effect, `[FX] sequence references unknown VFX def: ${step.effect}`);
      return;
    }

    let x = opts.x ?? this.listenerX;
    let y = opts.y ?? this.listenerY;

    // Accumulate local offset, then rotate by entity angle
    let ox = 0, oy = 0;
    if (step.offset) {
      ox += step.offset.x || 0;
      oy += step.offset.y || 0;
    }
    if (step.offsetRange) {
      const rx = step.offsetRange.x;
      const ry = step.offsetRange.y;
      if (rx) ox += rx[0] + Math.random() * (rx[1] - rx[0]);
      if (ry) oy += ry[0] + Math.random() * (ry[1] - ry[0]);
    }

    // Rotate offset by entity angle so effects follow body orientation
    if (opts.angle != null && (ox || oy)) {
      const cos = Math.cos(opts.angle);
      const sin = Math.sin(opts.angle);
      x += ox * cos - oy * sin;
      y += ox * sin + oy * cos;
    } else {
      x += ox;
      y += oy;
    }

    this.effects.addGenericEffect(vfxDef, x, y, {
      blastRadius: opts.blastRadius,
      scale: opts.scale,
    });
  }

  _startLoop(step, positional, opts) {
    const loopOpts = {};
    if (step.fadeIn !== undefined) loopOpts.fadeIn = step.fadeIn;
    if (step.volume !== undefined) loopOpts.volume = step.volume;

    let loopId;
    if (positional) {
      loopId = this.sound.startLoop(step.sound, opts.x, opts.y, loopOpts);
    } else {
      loopId = this.sound.startUILoop(step.sound, loopOpts);
    }

    if (loopId && step.handle) {
      this.activeLoops.set(step.handle, loopId);
    }
  }

  _stopLoop(step) {
    const loopId = this.activeLoops.get(step.handle);
    if (loopId) {
      const stopOpts = {};
      if (step.fadeOut !== undefined) stopOpts.fadeOut = step.fadeOut;
      this.sound.stopLoop(loopId, stopOpts);
      this.activeLoops.delete(step.handle);
    }
  }

  _resolveRepeatCount(repeat) {
    if (Array.isArray(repeat)) return repeat[0] + Math.floor(Math.random() * (repeat[1] - repeat[0] + 1));
    if (typeof repeat === 'number') return repeat;
    return 1;
  }
}
