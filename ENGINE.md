# Pat_Engine — Architecture & API

A no-build, browser-native 2D engine. The game statically imports engine modules by absolute path
(served by `server/main.js`); JSON assets load via import attributes (`with { type: 'json' }`).

## Layers

```
engine/core    Game (loop + scene router), Scene, Camera, canvasUtils, VolumeControl
engine/render  ArtInterpreter, VFXInterpreter, EffectsRenderer, BackgroundRenderer, SpriteCache
engine/ui      TextCache (word-wrap + fit-to-box memoizer)
engine/harness runShots, contactSheet, seededRandom (render predefined game states → images)
engine/fx      EffectsManager (effects/trails/debris), FXSequenceRunner (orchestration)
engine/audio   SoundManager (Web Audio + synth + MIDI), MusicDirector (adaptive music),
               midi (SMF parser), EntityLoopManager (per-entity positional loops)
engine/physics shipPhysics, collision, constants
engine/data    art / vfx / sounds / fxSequences / music loaders (deep-clone JSON)
engine/net     OPTIONAL multiplayer module — NetworkClient/ServerLoop/StateBuffer +
               RoomServer (room/lobby host). Unwired by the example — see net/README.md
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
**Art format** below. An `effectRef` shape embeds a persistent VFX effect by id — call
`setEffectResolver(id => VFX_DEFS[id])` once at wiring time so the interpreter stays data-agnostic.

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

### `SpriteCache` (`engine/render/SpriteCache.js`)
Generic offscreen-canvas LRU memoizer — rasterize expensive, frame-stable drawing once and blit it.
```js
const cache = new SpriteCache({ max: 64, dprCap: 3 });
const tile = cache.get(key, w, h, (cctx, w, h) => { /* paint in logical px on a miss */ });
if (tile) ctx.drawImage(tile.canvas, x, y, tile.w, tile.h); else drawDirect(ctx); // null when no canvas (Node)
```
The **caller** owns `key` (encode everything that changes the pixels — id/palette/state/size — and
exclude per-frame transforms like position/rotation/bob; apply those at blit). DPR is folded into the
backing store + the key. `clear()` drops all tiles; `size` reports the count.

## UI

### `TextCache` (`engine/ui/TextCache.js`)
Word-wrap + auto-shrink-to-fit text with a memoized fit (the search costs ~9–14 `measureText` passes;
the result is cached, LRU 200). `font` family/weight are parameters (default sans-serif) — no game styling.
```js
const fit = fitParagraph(ctx, text, { w, h, max: 40, min: 14, weight: 700, family });
// → { size, lines, lineHeight, font }
drawParagraph(ctx, text, { x, y, w, h, color, weight, family });  // wrap+shrink, centered; returns height
wrapLines(ctx, text, maxWidth);                                    // → string[]
```

## Audio

### `SoundManager` (`engine/audio/SoundManager.js`)
`init()`, `resume()`, `playUI(id, opts)`, `playPositional(id, x, y, opts)`,
`startLoop/updateLoop/stopLoop`, `startUILoop/stopUILoop`, `fadeLoop(handle, targetVol, secs)`,
`loadMidi(path)`, `updateListener(x, y, angle)`, `setVolume/getVolume/isMuted/toggleMute`. Reads
`SOUND_CONFIG` (sfx.json). Synth voices support layers (`sine`/`square`/`sawtooth`/`triangle`/`file`/
`noise`), envelope, LFO, reverb, **vibrato** (pitch LFO), a **tone filter** (biquad), **distortion**
(waveshaper), and **MIDI tunes** (`synth.midi` renders a `.mid` score through the voice).

### `MusicDirector(soundManager)` (`engine/audio/MusicDirector.js`)
Adaptive (vertical-remixing) background music from `data/music.json`. Plays several synchronized
looping stems and crossfades them by intensity — no restart.
```js
const music = new MusicDirector(sound);
music.startSong('songId', { intensity: 'calm', fadeSeconds: 1.5 });
music.setIntensity('triumph', 1.0);   // crossfade to a tier (absolute per-stem gains)
music.fadeStem('lead', 0.6, 2);       // nudge one stem
music.stop({ fadeOut: 0.6 });
```
Each stem is a `loop:true` + `synth.midi` sound (its timbre + which `track` of the shared multi-track
`.mid` it plays). `engine/audio/midi.js` `parseMidi(arrayBuffer)` → `{ notes, duration, tracks }`.

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
`{ name, states:[...], setup, animations?, shapes:[...] }`. Shapes: `circle`, `path`, `lines`, `arc`,
`rect`, `group`, `radialRepeat`, `repeat`, `forEach`, `conditional`, `effectRef`, etc. Coordinates:
plain numbers are `val * r`; objects `{ base, r, w, h }` are linear combinations; `…Abs` keys are
absolute. Per-shape state overrides use **`states: { <state>: {…} }`** (not `stateOverrides`);
`visibleStates:[...]` for conditional visibility. **Animation is keyframe tracks:** asset-level clip
metadata `animations: { "*"|<state>: { duration, loop } }` (the `"*"` clip is composited under every
state) plus per-shape tracks `anim: { <clipKey>: { <propPath>: [ { t, v, ease? } ] } }` — any property
path (`cx`, `radiusAbs`, `rotation`, `setup.alpha`, `points.2`…) tweens between keys. Looping clips run
on absolute time; `loop:false` clips play once from state-entry and hold. (The old oscillator/spinner
`animators` system was removed.)

**VFX** (`{ "effects": { ... } }`): `phased` (one-shot or `lifecycle:"persistent"`) with
time-windowed `phases[].layers[]` of primitives (`filledCircle`, `gradientCircle`, `strokeRing`,
`dashedRing`, `spikeLines`, and randomized-cloud `scatterDots`/`scatterLines`/`scatterStrips`);
`bubbleTrail`/`taperedTrail`; `wiggleBeam`. Value forms: static, `{from,to}`,
`{from,to,modulate:{freq,amp}}`, `{base,amplitude,freq}`. Particle clouds live here now (a
`scatter*` layer in a persistent effect), embedded in art via `effectRef`; art `particles` is deprecated.

**SFX** (`{ categories, sounds }`): each sound is `{ volume, range, category, loop, synth }`; `synth`
is layers (`sine`/`square`/`sawtooth`/`triangle`/`file`/`noise`) + envelope/LFO/reverb, plus optional
`vibrato:{freq,depth}`, `filter:{type,freq,q}`, `distortion:0..1`, and `midi:{file,track,transpose,tempo}`
(render a `.mid` score through the voice). Scalar synth fields accept `[min,max]` for per-trigger
randomization. `range:0` = UI (non-positional).

**Music** (`data/music.json` → `{ songs: { id: song } }`): a `song` is `{ bpm, beatsPerBar, bars, grid,
stems:[{name,sound,gain,repeat?,notes:[{beat,len,midi,vel}]}], intensity:{ <tier>: { <stemName>: 0..1 } },
masterLevel?, fadeSeconds? }`. Each stem's `sound` is a `loop:true` synth (its timbre); its `notes` are the
editable pattern in beats (played via the engine's inline-notes loop path — `beatsToSeconds` + the shared
bar loop length). `repeat:true` tiles a short pattern to fill the loop on a whole-bar period
(`tileBeatsToLoop`); otherwise the stem plays once and waits. A stem with no `notes` falls back to its
sound's `synth.midi.{file,track}` (.mid). Tiers
map stem → absolute gain (absent = silent). Engine: `SoundManager.updateMidiLoopNotes(handle, notes, loopLen)`
live-swaps a playing loop's notes (no restart) and `playSynthNote(synth, midi)` auditions a pitch;
`MusicDirector.updateStemNotes`/`swapStemSound` (swap a stem's instrument in phase, no restart)/`seekTo(phase)` (move the whole song's playhead, no restart)/`getPhase` drive the editor.

**Sequences** (`{ "sequences": { id: { positional?, steps:[...] } } }`): steps are
`sfx`/`vfx`/`loopStart`/`loopStop`/`signal` with `delay` + type fields.

**Manifest** (`data/editor-manifest.json`): retargets the editor suite — `artCollections`
(`{id,label,file,collectionKey}`), `previewEntities` (`{id,label,artCollection,artId,radius,color,states}`),
`vfxCategories` (`{id,label,match:[...]}`).

## Shot harness (`/shots`) — predefined game states → images

A game-agnostic path to render named game states to images, for agentic dev (edit art/scene code →
get PNGs → inspect → iterate). **Browser is the image backend** (real canvas: glow/blur/fonts/DPR); a
Node smoke test (`tests/shots.test.js`) guards CI but produces no pixels.

- **`data/shots.json`** — `{ "render": "/game/shots.js", "shots": [ { id, scene, viewport:{w,h}, now?,
  seed?, camera?, state } ] }`. `state` is **opaque** game state; the engine never reads it.
- **Game seam** — `renderShot(ctx, shot, env)` (env = `{ now, width, height, dpr }`) draws one shot.
  Contract: hydrate `shot.state` directly and **skip the scene's `enter()`** (it has audio/RNG side
  effects), then reuse the scene's real `render()` so shots never drift from gameplay.
- **`engine/harness/runShots.js`** — `runShots({ shots, renderShot, makeCanvas, emit, defaults })`:
  per shot sizes a canvas (`w*dpr`), pre-scales the ctx to logical px, seeds `Math.random`, calls
  `renderShot`. Takes `renderShot` as a **parameter** and is reached via `data/shots.json`'s `render`
  path (data-declared dynamic `import()`), so `engine/` never imports `game/` (rule #1). `makeCanvas`/
  `emit` keep it backend-agnostic (a Node rasterizer could drop in later).
- **`engine/harness/contactSheet.js`** — `composeContactSheet(items, { makeCanvas, ... })`: labeled grid.
- **`engine/harness/seededRandom.js`** — `seededRandom`/`hashSeed`/`withSeed` for reproducible frames.
- **View it:** open `/shots` (contact sheet of all states) or `/shots?shot=<id>&scale=N` (one full-res).
  Drive headlessly with any browser tool (gstack `browse`, Playwright): `goto /shots` → screenshot.
  `window.__shots = { ids, render(id) }` is exposed for programmatic capture.

## Editors (`/editor`)
Tab host (`editor.html`) lazy-loads `art`, `vfx`, `sequences`, `soundboard` editors (Soundboard hosts two
sub-tabs: **Sounds** + **Music**). All save through `POST /api/save-data` (allowlist + `.backups/` rotation).
Art/VFX/Sequence editors are driven by the manifest, so a new project repoints the manifest instead of
editing editor source. The soundboard edits sfx.json (incl. vibrato/filter/distortion/noise/MIDI, `[R]`
range toggles for `[min,max]`); the Music sub-tab is a mixing console + **piano-roll MIDI editor** for
`data/music.json` — song picker + new/clone/rename/delete song, tempo grid (`bpm`/`bars`/`beatsPerBar`/`grid`),
`masterLevel`/`fadeSeconds`, stem add/remove/reorder/rename/clone + instrument assignment + mute/solo/repeat
per strip, vibe scenes (rename/clone/delete/docs + per-stem faders), and a click-a-stem piano roll
(`editors/music/pianoRoll.js`, note ops in `editors/music/model/midiModel.js`) to draw/move/resize/delete notes, transpose,
quantize — auditioned live through `MusicDirector` (note edits swap in with no restart, in sync). Import
notes by pasting or uploading **ABC** (`editors/music/model/abcModel.js`) or **MIDI**, or drag-drop a `.mid`/`.abc`
file; a longer import auto-extends the song's `bars`.
