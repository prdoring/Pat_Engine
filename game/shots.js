// Shot render seam — the GAME half of the engine shot harness (engine/harness/runShots).
// The engine calls renderShot(ctx, shot, env) per declared shot; this builds a headless
// copy of the render services (no audio, no Game loop, no RAF), hydrates the requested
// scene from the OPAQUE shot.state, and reuses the scene's real render() so shots never
// drift from gameplay. Scene enter() is deliberately skipped — it has side effects
// (audio.resume, sequences.play, music load, Math.random spawns) that don't belong in a
// static frame; the state is injected directly instead.

import { Camera } from '/engine/core/Camera.js';
import { EffectsManager } from '/engine/fx/EffectsManager.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { buildArtRegistry } from '/engine/data/art.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { setEffectResolver } from '/engine/render/ArtInterpreter.js';

// effectRef shapes resolve to VFX effects by id in the shot harness too.
setEffectResolver((id) => VFX_DEFS[id]);

import critterArt from '/data/critter-art.json' with { type: 'json' };
import propArt from '/data/prop-art.json' with { type: 'json' };

import { GardenRenderer } from './GardenRenderer.js';
import { TitleScene } from './scenes/TitleScene.js';
import { GardenScene } from './scenes/GardenScene.js';
import { Critter } from './Critter.js';
import { WORLD } from './config.js';

const noop = () => {};

// No-op stand-ins for services a static shot doesn't need. They let a scene's
// update()/render() run (for optional warm-up) without making sound or touching the net.
function silentServices() {
  return {
    sound: { resume: noop, updateListener: noop, loadMidi: () => Promise.resolve(null),
             playUI: noop, playPositional: noop, startLoop: () => null, stopLoop: noop },
    loopMgr: { beginFrame: noop, updateEntity: noop, cleanupStale: noop, stopEntity: noop, stopAll: noop },
    music: { isPlaying: () => false, startSong: noop, setIntensity: noop, fadeStem: noop, stop: noop },
    sequences: { play: noop, stopAll: noop },
  };
}

// Headless `shared`, mirroring the render-relevant half of game/main.js. `view` is a
// plain LOGICAL {width,height} object (not the device-px backing canvas) so Camera and
// the scenes read logical dimensions — the ctx is already DPR-scaled by the runner.
function buildShared(ctx, env) {
  const view = { width: env.width, height: env.height };
  const camera = new Camera(view);
  const effects = new EffectsManager();
  const effectsRenderer = new EffectsRenderer(ctx, camera);
  const art = buildArtRegistry({ critters: critterArt, props: propArt });
  const gardenRenderer = new GardenRenderer(ctx, camera, art, VFX_DEFS, effectsRenderer);
  return { canvas: view, ctx, camera, effects, effectsRenderer, art, gardenRenderer, VFX_DEFS, ...silentServices() };
}

/** Engine seam: draw one shot to `ctx`. `env = { now, width, height, dpr }` (logical px). */
export function renderShot(ctx, shot, env) {
  const shared = buildShared(ctx, env);
  const state = shot.state || {};

  // Camera: explicit per-shot, else center on the world.
  const cam = state.camera;
  shared.camera.x = cam?.x ?? WORLD.width / 2;
  shared.camera.y = cam?.y ?? WORLD.height / 2;
  if (cam?.zoom) shared.camera.setZoom(cam.zoom);

  if (shot.scene === 'title') {
    new TitleScene(shared).render(env.now);
    return;
  }
  if (shot.scene === 'garden') {
    const scene = new GardenScene(shared);
    hydrateGarden(scene, state, env);
    scene.render(env.now);
    return;
  }
  throw new Error(`shots: unknown scene "${shot.scene}" for shot "${shot.id}"`);
}

// Populate a GardenScene from an opaque shot.state without running enter(). `critters`
// become real Critter instances (so optional warm-up's c.update works); `pairs` are
// index tuples rebuilt into live linkedTo refs (tethers); `warmupFrames` advances the
// real update() loop a few seeded frames so trails/eased cursor accumulate.
function hydrateGarden(scene, state, env) {
  scene.props = (state.props || []).map(p => ({ ...p }));

  const critters = (state.critters || []).map(spec => {
    const c = new Critter(spec.x, spec.y, spec.species);
    if (spec.state) c.state = spec.state;
    if (spec.color) c.color = spec.color;
    if (spec.radius != null) c.radius = spec.radius;
    if (spec.vx != null) c.vx = spec.vx;
    if (spec.vy != null) c.vy = spec.vy;
    // Pin keyframe clips to a deterministic local time so a play-once clip
    // (happy/scared) renders its intended mid-clip pose instead of t0 / held end.
    if (spec.animTime) c._artTransition = { animTime: { ...spec.animTime } };
    return c;
  });
  scene.critters = critters;

  for (const [i, j] of (state.pairs || [])) {
    const a = critters[i], b = critters[j];
    if (a && b) {
      a.state = b.state = 'linked';
      a.linkedTo = b; b.linkedTo = a;
      a.unlinkAt = b.unlinkAt = Infinity;
    }
  }

  const frames = state.warmupFrames || 0;
  if (frames > 0) {
    const dt = 1000 / 60;
    scene._lastNow = env.now - frames * dt;
    for (let i = 1; i <= frames; i++) scene.update(env.now - (frames - i) * dt);
  }
}
