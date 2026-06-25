// Critter Garden — bootstrap. Wires engine services to the game scenes.
import { Game } from '/engine/core/Game.js';
import { Camera } from '/engine/core/Camera.js';
import { SoundManager } from '/engine/audio/SoundManager.js';
import { EntityLoopManager } from '/engine/audio/EntityLoopManager.js';
import { BackgroundRenderer } from '/engine/render/BackgroundRenderer.js';
import { EffectsManager } from '/engine/fx/EffectsManager.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { FXSequenceRunner } from '/engine/fx/FXSequenceRunner.js';
import { buildArtRegistry } from '/engine/data/art.js';
import { VFX_DEFS } from '/engine/data/vfx.js';

import critterArt from '/data/critter-art.json' with { type: 'json' };
import propArt from '/data/prop-art.json' with { type: 'json' };

import { GardenRenderer } from './GardenRenderer.js';
import { TitleScene } from './scenes/TitleScene.js';
import { GardenScene } from './scenes/GardenScene.js';
import { PALETTE, BACKGROUND_LAYERS } from './config.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const camera = new Camera(canvas);
const sound = new SoundManager();
const loopMgr = new EntityLoopManager(sound);
const background = new BackgroundRenderer(camera, canvas, BACKGROUND_LAYERS);
const effects = new EffectsManager();
const effectsRenderer = new EffectsRenderer(ctx, camera);
const art = buildArtRegistry({ critters: critterArt, props: propArt });

// Sequence signals → game state. The target entity rides in opts.entity, so the
// handler stays decoupled from any specific scene. This is the orchestration
// seam: a sequence's `signal` steps drive the critter's art state + lifecycle.
function onSignal(name, data, opts) {
  const e = opts?.entity;
  if (!e) return;
  if (name === 'setState') e.state = (data && data.state) || 'idle';
  else if (name === 'clearState') { if (e.state !== 'linked') e.state = 'idle'; }
  else if (name === 'removeEntity') e._remove = true;
}
const sequences = new FXSequenceRunner(sound, effects, onSignal);

const gardenRenderer = new GardenRenderer(ctx, camera, art, VFX_DEFS, effectsRenderer);

const game = new Game({ canvas, sound, background, clearColor: PALETTE.base });

const shared = {
  canvas, ctx, camera, sound, loopMgr, effects, effectsRenderer,
  sequences, art, gardenRenderer, VFX_DEFS, game,
};

const titleScene = new TitleScene(shared);
const gardenScene = new GardenScene(shared);
shared.scenes = { title: titleScene, garden: gardenScene };

game.start(titleScene);
