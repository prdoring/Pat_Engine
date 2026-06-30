import { Scene } from '/engine/core/Scene.js';
import { resolveElasticCollision } from '/engine/physics/collision.js';
import { Critter } from '../Critter.js';
import {
  WORLD, PALETTE, SPECIES, CAMERA_PAN_SPEED, ZOOM_STEP, CURSOR_EASE, CURSOR_TRAIL,
  PAIR_RANGE, PAIR_CHANCE, PAIR_DURATION, MAX_CRITTERS,
} from '../config.js';

const PAN_KEYS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1],
};

export class GardenScene extends Scene {
  constructor(shared) {
    super();
    this.shared = shared;
    this.critters = [];
    this.props = [];
    this.keys = new Set();
    this._lastNow = 0;
    this._spawnToggle = 0;
    this.cursorScreen = null; // {sx, sy} latest pointer position
    this.cursor = null;       // {x, y} world-space follower (eases toward cursor)
    this._musicTier = null;   // active adaptive-music intensity ('calm'|'lively'|'playful')
    this._musicHoldUntil = 0; // while > now, hold a 'triumph' burst before re-evaluating
  }

  enter() {
    const { sound, sequences, camera } = this.shared;

    // Clear any keys left held during the scene switch so they can't stick.
    this.keys.clear();

    // Ensure the audio context is live (the click that entered this scene also
    // triggers the engine's audio-resume), then start the ambient loop bed.
    sound.resume();
    sequences.play('gardenAmbience');

    // Adaptive music: resume() kicks off async asset loading, so wait for the song's
    // MIDI score to parse, then start it. setIntensity() (driven by _updateMusic) then
    // fades layers in/out as the garden gets busier — no restart. loadMidi is idempotent.
    this._musicTier = 'calm';
    this._musicHoldUntil = 0;
    sound.loadMidi('/MIDI/critter-garden.mid').then(() => {
      this.shared.music.startSong('critterGarden', { intensity: 'calm' });
    });

    camera.x = WORLD.width / 2;
    camera.y = WORLD.height / 2;

    this.props = [
      { artId: 'flower', x: 360, y: 420, r: 26, color: '#e88ab0' },
      { artId: 'flower', x: 1850, y: 1300, r: 22, color: '#f2d14a' },
      { artId: 'rock', x: 1300, y: 520, r: 40, color: '#6a7079' },
      { artId: 'rock', x: 640, y: 1280, r: 32, color: '#6a7079' },
      { artId: 'sign', x: 1180, y: 1050, r: 40, color: '#b98a4a' },
    ];

    // A few critters to start.
    this.critters = [];
    for (let i = 0; i < 5; i++) {
      this._spawn(
        300 + Math.random() * (WORLD.width - 600),
        300 + Math.random() * (WORLD.height - 600),
        false
      );
    }
    this._lastNow = 0;
  }

  exit() {
    const { sequences, loopMgr, effects, music } = this.shared;
    sequences.play('gardenAmbienceStop');
    sequences.stopAll();
    loopMgr.stopAll();
    music.stop();
    // Clear trails/effects/debris so they don't leak across scene re-entry.
    effects.stopAll();
  }

  // ─── Spawning / interaction ──────────────────────────────────────
  _spawn(x, y, withFx = true) {
    if (this.critters.length >= MAX_CRITTERS) return null;
    const pool = ['blob', 'sprout', 'beetle'];
    const species = pool[this._spawnToggle++ % pool.length];
    const c = new Critter(x, y, species);
    this.critters.push(c);
    if (withFx) this.shared.sequences.play('critterSpawn', { x, y, entity: c });
    return c;
  }

  _critterAt(wx, wy) {
    // topmost (last drawn) first
    for (let i = this.critters.length - 1; i >= 0; i--) {
      const c = this.critters[i];
      if (Math.hypot(wx - c.x, wy - c.y) <= c.radius + 6) return c;
    }
    return null;
  }

  onMousedown(sx, sy) {
    const { camera, sequences } = this.shared;
    const { x, y } = camera.screenToWorld(sx, sy);
    const hit = this._critterAt(x, y);
    if (hit) {
      sequences.play('critterPet', { x: hit.x, y: hit.y, entity: hit });
    } else {
      this._spawn(x, y, true);
    }
  }

  onMousemove(sx, sy) {
    this.cursorScreen = { sx, sy };
  }

  onWheel(deltaY, sx, sy) {
    const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.shared.camera.zoomAt(factor, sx, sy);
  }

  onKeydown(e) {
    const k = e.key;
    if (PAN_KEYS[k]) { this.keys.add(k); return; }
    if (k === ' ') {
      const candidates = this.critters.filter(c => c.state !== 'linked');
      if (candidates.length) {
        const c = candidates[Math.floor(Math.random() * candidates.length)];
        this.shared.sequences.play('critterScare', { x: c.x, y: c.y, entity: c });
      }
    } else if (k === 'x' || k === 'Backspace') {
      const c = this.critters[this.critters.length - 1];
      if (c) this.shared.sequences.play('critterDespawn', { x: c.x, y: c.y, entity: c });
    }
  }

  onKeyup(e) { this.keys.delete(e.key); }

  // ─── Update ──────────────────────────────────────────────────────
  update(now) {
    const dt = this._lastNow ? Math.min(0.05, (now - this._lastNow) / 1000) : 0.016;
    this._lastNow = now;
    const { camera, effects, loopMgr, sound } = this.shared;

    this._panCamera(dt);
    this._updateCursor(dt, now);

    // Move + emit trails.
    for (const c of this.critters) {
      c.update(dt, now);
      if (c.speed > 4) {
        effects.emitTrail(c.id, c.x, c.y, now, { speed: c.speed }, this.shared.VFX_DEFS[c.trailRef]);
      }
    }

    this._resolveBumps();
    this._updatePairs(now);
    this._prune();
    this._updateMusic(now);

    // Per-critter positional hum (demonstrates EntityLoopManager lifecycle).
    loopMgr.beginFrame();
    for (const c of this.critters) {
      loopMgr.updateEntity(c.id, 'critterHum', c.x, c.y, { playbackRate: 0.85 + Math.min(0.5, c.speed / 120) });
    }
    loopMgr.cleanupStale({ fadeOut: 0.2 });

    sound.updateListener(camera.x, camera.y, 0);
    effects.update(now);
  }

  _updateCursor(dt, now) {
    if (!this.cursorScreen) return;
    const target = this.shared.camera.screenToWorld(this.cursorScreen.sx, this.cursorScreen.sy);
    if (!this.cursor) { this.cursor = { x: target.x, y: target.y, vx: 0, vy: 0 }; return; }
    const k = Math.min(1, dt * CURSOR_EASE);
    const nx = this.cursor.x + (target.x - this.cursor.x) * k;
    const ny = this.cursor.y + (target.y - this.cursor.y) * k;
    const speed = Math.hypot(nx - this.cursor.x, ny - this.cursor.y) / Math.max(dt, 0.001);
    this.cursor.x = nx; this.cursor.y = ny;
    // Trail it (drawn by gardenRenderer.drawTrails via the shared EffectsManager).
    this.shared.effects.emitTrail('cursor', nx, ny, now, { speed }, this.shared.VFX_DEFS[CURSOR_TRAIL]);
  }

  _panCamera(dt) {
    let dx = 0, dy = 0;
    for (const k of this.keys) { const v = PAN_KEYS[k]; if (v) { dx += v[0]; dy += v[1]; } }
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      this.shared.camera.x += (dx / len) * CAMERA_PAN_SPEED * dt;
      this.shared.camera.y += (dy / len) * CAMERA_PAN_SPEED * dt;
    }
    // Keep the view roughly over the garden.
    const cam = this.shared.camera;
    cam.x = Math.max(-200, Math.min(WORLD.width + 200, cam.x));
    cam.y = Math.max(-200, Math.min(WORLD.height + 200, cam.y));
  }

  _resolveBumps() {
    const cs = this.critters;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        resolveElasticCollision(cs[i], cs[i].radius, cs[j], cs[j].radius, 0.6);
      }
    }
  }

  _updatePairs(now) {
    const cs = this.critters;
    // Form new pairs from nearby idle critters.
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      if (a.state !== 'idle') continue;
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j];
        if (b.state !== 'idle') continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < PAIR_RANGE && Math.random() < PAIR_CHANCE) {
          a.state = b.state = 'linked';
          a.linkedTo = b; b.linkedTo = a;
          a.unlinkAt = b.unlinkAt = now + PAIR_DURATION;
          this.shared.sequences.play('critterPair', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, entity: a });
          // A pairing is a little celebration — punch the music to its biggest vibe for
          // a few seconds (_updateMusic holds it, then settles back to the population tier).
          if (this.shared.music.isPlaying()) {
            this.shared.music.setIntensity('triumph');
            this._musicTier = 'triumph';
            this._musicHoldUntil = now + 3500;
          }
          break;
        }
      }
    }
    // Expire pairs.
    for (const c of cs) {
      if (c.state === 'linked' && now > c.unlinkAt) {
        if (c.linkedTo) { c.linkedTo.state = 'idle'; c.linkedTo.linkedTo = null; }
        c.state = 'idle'; c.linkedTo = null;
      }
    }
  }

  _prune() {
    const removed = this.critters.filter(c => c._remove);
    if (!removed.length) return;
    for (const c of removed) {
      this.shared.effects.clearTrail(c.id);
      this.shared.loopMgr.stopEntity(c.id, { fadeOut: 0.1 });
      if (c.linkedTo) { c.linkedTo.state = 'idle'; c.linkedTo.linkedTo = null; }
    }
    this.critters = this.critters.filter(c => !c._remove);
  }

  // Drive the adaptive music from how busy the garden is: a sparse garden stays 'calm',
  // a livelier one fades in melody + percussion. A recent pairing holds 'triumph' (see
  // _updatePairs) until its timer expires, then we settle back to the population tier.
  _updateMusic(now) {
    const { music } = this.shared;
    if (!music.isPlaying() || now < this._musicHoldUntil) return;
    const n = this.critters.length;
    const tier = n >= 8 ? 'playful' : n >= 4 ? 'lively' : 'calm';
    if (tier !== this._musicTier) {
      this._musicTier = tier;
      music.setIntensity(tier);
    }
  }

  _livePairs() {
    const seen = new Set();
    const pairs = [];
    for (const c of this.critters) {
      if (c.state === 'linked' && c.linkedTo && !seen.has(c.id)) {
        seen.add(c.id); seen.add(c.linkedTo.id);
        pairs.push([c, c.linkedTo]);
      }
    }
    return pairs;
  }

  // ─── Render ──────────────────────────────────────────────────────
  render(now) {
    const { gardenRenderer, effects } = this.shared;
    gardenRenderer.drawProps(this.props, now);
    gardenRenderer.drawTrails(effects.getTrails(), now);
    gardenRenderer.drawTethers(this._livePairs(), now);
    gardenRenderer.drawAuras(this.critters, now);
    gardenRenderer.drawCritters(this.critters, now);
    gardenRenderer.drawEffects(effects, now);
    if (this.cursor) gardenRenderer.drawCursorFollower(this.cursor.x, this.cursor.y, now);
    this._drawHud();
  }

  _drawHud() {
    const { ctx, canvas } = this.shared;
    // Logical height (HiDPI-safe): the backing store is device px, clientHeight stays logical.
    const vh = canvas.clientHeight || canvas.height;
    ctx.save();
    ctx.fillStyle = PALETTE.hud;
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Critters: ${this.critters.length}`, 14, 26);
    ctx.fillStyle = PALETTE.hudDim;
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('click ground: spawn  •  click critter: pet  •  space: scare  •  x: despawn  •  WASD/arrows: pan  •  scroll: zoom', 14, vh - 16);
    ctx.restore();
  }
}
