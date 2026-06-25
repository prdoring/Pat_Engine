# Pat_Engine — Architecture & API

A no-build, browser-native 2D engine. The game statically imports engine modules by absolute path
(served by `server/main.js`); JSON assets load via import attributes (`with { type: 'json' }`).

## Layers

```
engine/core    Game (loop + scene router), Scene, Camera, canvasUtils, VolumeControl
engine/render  ArtInterpreter, VFXInterpreter, EffectsRenderer, BackgroundRenderer
engine/fx      EffectsManager (effects/trails/debris), FXSequenceRunner (orchestration)
engine/audio   SoundManager (Web Audio), EntityLoopManager (per-entity positional loops)
engine/physics shipPhysics, collision, constants
engine/data    art / vfx / sounds / fxSequences loaders (deep-clone JSON)
engine/net     OPTIONAL multiplayer module (unwired by the example — see net/README.md)
```

## Hard runtime requirements

- Browser support for **JSON import attributes** (`import x from '/data/x.json' with { type: 'json' }`).
- The host serves `.json` as `application/json` (Pat_Engine's server does, with `no-cache`).
- `ArtInterpreter` evaluates angle expressions with a built-in safe arithmetic parser (no `Function`/`eval`), so a strict CSP is fine.
- Runtime art is immutable (frozen JSON imports) unless deep-cloned via `engine/data/art.js`.

## Core API

### `Game` (`engine/core/Game.js`)
```js
const game = new Game({ canvas, sound, background, clearColor });
game.setScene(scene, data);   // exit old, enter new
game.start(scene);            // begin RAF loop
```
Owns: canvas sizing, the frame loop (clear → background → `scene.update` → `scene.render` → volume
overlay, with error recovery), global input routing to the active scene, audio-resume on first input.

### `Scene` (`engine/core/Scene.js`)
Subclass and override: `enter(data)`, `exit()`, `update(now)`, `render(now)`,
`onKeydown/onKeyup(e)`, `onMousedown/onMousemove/onMouseup(x, y)`, `onWheel(deltaY, x, y)`. All default to no-ops.

### `Camera` (`engine/core/Camera.js`)
`worldToScreen(wx,wy)→{sx,sy}`, `screenToWorld(sx,sy)→{x,y}`, `follow(target)`, `getVisibleBounds()`.
Pan by setting `camera.x/y`. Zoom via `setZoom(z)` / `getZoom()` / `zoomAt(factor, sx, sy)`
(clamped to `minZoom`/`maxZoom`, both configurable: `new Camera(canvas, { minZoom, maxZoom })`).
Wheel input routes to the active scene's `onWheel`. Art, effects, debris, trails, beams, and the
parallax background all scale with zoom.

## Rendering

### `drawUnifiedArt(ctx, r, color, artDef, state, now, transition?, durationOverride?)`
Game-agnostic vector-art interpreter. `r` scales the art; `color` is the default fill/stroke when a
shape omits its own. `state` selects per-shape `states` overrides + `visibleStates`. See
**Art format** below.

### `EffectsManager` (`engine/fx/EffectsManager.js`) + `EffectsRenderer` (`engine/render/EffectsRenderer.js`)
```js
fx.addGenericEffect(vfxDef, x, y, { scale, id }); // one-shot or persistent phased effect (+debris)
fx.removeGenericEffect(id);                       // stop a persistent effect spawned with { id }
fx.emitTrail(id, x, y, now, { speed }, trailDef); // accumulate a trail point
fx.update(now);                                  // prune trails, advance debris, cull effects
// render (camera transforms applied):
er.drawTrails(fx.getTrails(), now);
er.drawGenericEffects(fx.getGenericEffects(now), now);
er.drawDebris(fx.getDebris(now));
er.drawBeam(x1, y1, x2, y2, beamDef, now);       // continuous beam between world points
er.drawEffectAt(effectDef, x, y, progress, scale, now); // per-entity persistent effect
```

### `BackgroundRenderer(camera, canvas, layers?)`
Parallax particle background. Pass a `layers` config (see `game/config.js` for the shape).

## Audio

### `SoundManager` (`engine/audio/SoundManager.js`)
`init()`, `resume()`, `playUI(id, opts)`, `playPositional(id, x, y, opts)`,
`startLoop/updateLoop/stopLoop`, `startUILoop/stopUILoop`, `updateListener(x, y, angle)`,
`setVolume/getVolume/isMuted/toggleMute`. Reads `SOUND_CONFIG` (sfx.json).

### `EntityLoopManager(sound)` (`engine/audio/EntityLoopManager.js`)
Per-entity positional loops with frame lifecycle: `beginFrame()`, `updateEntity(id, soundId, x, y, opts)`,
`cleanupStale(opts)` (auto-stops loops for entities not seen this frame), `stopEntity`, `stopAll`.

### `FXSequenceRunner(sound, effects, onSignal)` (`engine/fx/FXSequenceRunner.js`)
The orchestration layer. `play(sequenceId, { x, y, angle, entity, volume, scale })` runs a JSON
sequence's timed steps: `sfx` / `vfx` / `loopStart` / `loopStop` / `signal`. `signal` steps invoke
`onSignal(name, data, opts)` — the seam where a sequence drives game state (the example maps
`setState`/`clearState`/`removeEntity` onto `opts.entity`).

## Physics (`engine/physics/`)
- `applyShipPhysics(body, input, dt, stats, bounds)` — thrust/rotate/drag/clamp on `{x,y,vx,vy,angle}`.
- `collision.js` — `getCircleOverlap`, `resolveElasticCollision` (restitution defaults to
  `COLLISION.RESTITUTION`), `resolveStaticCollision`, circle-vs-OBB helpers. (Sub-Game sonar/damage
  math was removed.)

## Data loaders (`engine/data/`)
- `vfx.js` → `VFX_DEFS`, `sounds.js` → `SOUND_CONFIG`/`SoundCategory`/`SoundId`,
  `fxSequences.js` → `FX_SEQUENCES`/`seqRefToId` — each deep-clones its JSON.
- `art.js` → `buildArtRegistry(namespaces)` flattens statically-imported art JSON into
  `{ collection: { id: assetDef } }` (deep-cloned, mutation-safe); `getAsset(reg, col, id)`.

## Asset formats (authoring)

**Art** (`{ "<collection>": { "<id>": asset } }`): each asset is
`{ name, states:[...], setup, shapes:[...] }`. Shapes: `circle`, `path`, `lines`, `arc`, `rect`,
`group` (with `animators:[{type:"oscillator",var,rate,amplitude,base}]`), `spinner`, etc. Coordinates:
plain numbers are `val * r`; objects `{ base, <animVar> }` are linear combinations; `…Abs` keys are
absolute. Per-shape state overrides use **`states: { <state>: {…} }`** (not `stateOverrides`);
`visibleStates:[...]` for conditional visibility.

**VFX** (`{ "effects": { ... } }`): `phased` (one-shot or `lifecycle:"persistent"`) with
time-windowed `phases[].layers[]` of primitives (`filledCircle`, `gradientCircle`, `strokeRing`,
`dashedRing`, `spikeLines`); `bubbleTrail`/`taperedTrail`; `wiggleBeam`. Value forms: static,
`{from,to}`, `{from,to,modulate:{freq,amp}}`, `{base,amplitude,freq}`.

**SFX** (`{ categories, sounds }`): each sound is `{ volume, range, category, loop, synth }`; `synth`
is oscillator/file layers + envelope/LFO/reverb. `range:0` = UI (non-positional).

**Sequences** (`{ "sequences": { id: { positional?, steps:[...] } } }`): steps are
`sfx`/`vfx`/`loopStart`/`loopStop`/`signal` with `delay` + type fields.

**Manifest** (`data/editor-manifest.json`): retargets the editor suite — `artCollections`
(`{id,label,file,collectionKey}`), `previewEntities` (`{id,label,artCollection,artId,radius,color,states}`),
`vfxCategories` (`{id,label,match:[...]}`).

## Editors (`/editor`)
Tab host (`editor.html`) lazy-loads `art`, `vfx`, `sequences`, `soundboard` editors. All save through
`POST /api/save-data` (allowlist + `.backups/` rotation). Art/VFX/Sequence editors are driven by the
manifest, so a new project repoints the manifest instead of editing editor source.
