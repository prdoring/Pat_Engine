# Pat_Engine — Agent Guide

> Audience: **AI coding agents** building a game on top of this engine. This is the
> "how to think and what not to break" document. For the terse API cheat-sheet see
> `ENGINE.md`; for run/config see `README.md`. When those disagree with the code, the
> code wins — verify before relying on a signature.

Pat_Engine is a **no-build, vanilla-JS, browser-native 2D engine**. The browser loads ES
modules directly by absolute path; JSON loads via import attributes. There is no bundler,
no transpiler, no framework. It ships with one example game, **Critter Garden**, which
exists to exercise every subsystem and to be read as a worked example. Read the example
before writing new code — it is the canonical reference implementation of every pattern
below.

---

## 0. The one rule that matters most

**The engine must never know what game it is running.** Nothing under `engine/` may
reference a critter, a garden, a submarine, a player, a torpedo, a "happy" state, a sound
named `spawnChirp`, or any other game-specific noun. Game vocabulary lives in `data/`
(content) and `game/` (behavior). The engine only deals in generic primitives: shapes,
effects, sounds, sequences, signals, bodies, cameras.

If you find yourself about to type a game word inside `engine/`, stop — you are about to
leak. The fix is almost always "express it as data" or "pass it in as a parameter."

**The test for every line of engine code:** *would this still make sense, unchanged, in a
completely different game (a platformer, a shmup, a farming sim)?* If no, it does not
belong in `engine/`.

---

## 1. The layering model

```
engine/   GAME-AGNOSTIC runtime. Renderers, audio, fx, physics, core loop, optional net.
          → COPY into new projects, NEVER edit per-game. Knows nothing about any game.
editors/  GAME-AGNOSTIC tooling, driven entirely by data/editor-manifest.json.
data/     PROJECT CONTENT. Art / VFX / SFX / sequence JSON + the manifest. Edited by editors.
game/     THE GAME. Scenes, entities, bootstrap wiring. The only gameplay code you write.
server/   GAME-AGNOSTIC host. Static serving + the editor save API. Generic.
```

### Dependency direction (strict)

```
game/  ──imports──▶  engine/        ✅ always
game/  ──reads────▶  data/ (JSON)   ✅ via static import
engine/data/ ─────▶  data/ (JSON)   ✅ ONLY allowed engine→data coupling (see below)
engine/  ─────────▶  game/          ❌ NEVER
engine/  ─────────▶  data/ ids      ❌ NEVER hardcode a specific id/name/state
editors/ ─────────▶  data/manifest  ✅ everything the editor targets comes from the manifest
editors/ ─────────▶  game/          ❌ NEVER
```

### The single legitimate engine→data binding

`engine/data/*.js` (`art.js`, `vfx.js`, `sounds.js`, `fxSequences.js`) import the
project's JSON **by path** (`/data/vfx.json`, etc.) and deep-clone it into registries.
This is the intentional content-binding seam. It is allowed because these loaders treat
the data as **opaque content** — they never hardcode an id, state name, or category. They
expose whatever the project authored:

```js
// engine/data/sounds.js — derives the id/category maps FROM the data, never hardcodes them
export const SOUND_CONFIG  = sfxData.sounds || {};
export const SoundCategory = /* unique categories found in the data */;
export const SoundId       = /* { id: id } for every key in the data */;
```

If you ever feel the urge to add `if (soundId === 'spawnChirp')` to an engine file, that
is the leak. Put the decision in `game/` or encode it in `data/`.

---

## 2. Leak-prevention rules (the checklist)

When editing or adding code, enforce these. Treat a violation as a bug, not a style nit.

1. **No game nouns in `engine/`.** No entity names, state names, signal names, sound/art/vfx
   ids, colors-by-meaning, or gameplay constants. (Generic tunables like a default voice
   cap are fine; `MAX_CRITTERS` is not.)
2. **Interpreters are extended by data, not branches.** Do **not** add a gameplay `case`
   to `ArtInterpreter`, `VFXInterpreter`, or `FXSequenceRunner`. If the data can't express
   what you need, add a **generic primitive** (e.g. a new shape type or VFX primitive that
   any game could use), never a game-specific one.
3. **Signal names are game vocabulary.** The engine forwards signal strings to your
   `onSignal` callback verbatim; it must never interpret them. `setState`, `removeEntity`,
   etc. are defined by `game/`, not the engine.
4. **Editors are manifest-driven.** Never hardcode a collection list, file name, preview
   entity, or category in `editors/`. Add it to `data/editor-manifest.json` instead.
5. **Server stays generic.** Routes, MIME, and the save allowlist are derived from config +
   manifest. No game-specific endpoints.
6. **Game owns all state.** Each scene owns its entities and state; shared services are
   injected. No cross-scene globals, no state stashed on engine objects.
7. **Runtime art/data is immutable unless cloned.** Raw JSON imports are frozen. Use
   `buildArtRegistry` / the `engine/data/*` loaders (they deep-clone). Never mutate a raw
   import.
8. **No `eval` / no strict-CSP breakers.** The art angle-expression evaluator is a small
   safe arithmetic parser — do not reintroduce `new Function`/`eval`.
9. **When in doubt, parameterize.** Engine code that needs a game value takes it as a
   constructor option or method argument (see `BackgroundRenderer(layers)`,
   `Camera(canvas, {minZoom, maxZoom})`, `SoundManager({reverbCutoff})`).

If a change genuinely needs the engine to do something new and generic, that's legitimate
— add it as a reusable primitive with a game-agnostic name and document it. Improving the
engine is fine; teaching it about your game is not.

---

## 3. Bootstrap & wiring (`game/main.js`)

`game/main.js` is the **only** place that knows about both the engine and the game. It
constructs engine services, builds the art registry, defines the signal handler, assembles
a `shared` services object, creates scenes, and starts the loop. The actual Critter Garden
wiring (read it — it's ~50 lines):

```js
const camera          = new Camera(canvas);
const sound           = new SoundManager();
const loopMgr         = new EntityLoopManager(sound);
const background      = new BackgroundRenderer(camera, canvas, BACKGROUND_LAYERS);
const effects         = new EffectsManager();
const effectsRenderer = new EffectsRenderer(ctx, camera);
const art             = buildArtRegistry({ critters: critterArt, props: propArt });

// The orchestration seam — see §5. Signals from sequences mutate game entities here.
function onSignal(name, data, opts) {
  const e = opts?.entity;
  if (!e) return;
  if (name === 'setState')        e.state = (data && data.state) || 'idle';
  else if (name === 'clearState') { if (e.state !== 'linked') e.state = 'idle'; }
  else if (name === 'removeEntity') e._remove = true;
}
const sequences = new FXSequenceRunner(sound, effects, onSignal);

const game   = new Game({ canvas, sound, background, clearColor: PALETTE.base });
const shared = { canvas, ctx, camera, sound, loopMgr, effects, effectsRenderer,
                 sequences, art, gardenRenderer, VFX_DEFS, game };

const titleScene  = new TitleScene(shared);
const gardenScene = new GardenScene(shared);
shared.scenes = { title: titleScene, garden: gardenScene };

game.start(titleScene);
```

**The `shared` object** is the dependency-injection container. Every scene receives it and
pulls what it needs. Scenes reach other scenes via `shared.scenes` and switch via
`shared.game.setScene(...)`. This keeps scenes decoupled — they never import each other.

### The `Game` shell (`engine/core/Game.js`)

`new Game({ canvas, sound?, background?, clearColor?, autoResize? })` owns:

- **Canvas sizing** (`autoResize` tracks `window.innerWidth/Height`).
- **The RAF loop**: `clear → background.draw → scene.update → scene.render → volume overlay`.
  The whole frame body is wrapped in `try/catch` with `resetCanvasState`, and the
  `requestAnimationFrame` reschedule lives in `finally` — **a throw can never freeze the
  loop.** Don't "fix" this by moving the reschedule out of `finally`.
- **Input routing** to the active scene: `onKeydown/onKeyup` (window), `onMousedown/
  Move/Up` and `onWheel` (canvas, in **screen/offset coords**). Right-click context menu is
  suppressed; wheel `preventDefault`s page scroll.
- **Audio resume** on first interaction (browser autoplay policy).
- **Volume overlay** (auto-added when `sound` is provided; it gets first dibs on clicks).

API: `setScene(scene, data?)`, `start(scene?, data?)`, `stop()`.

### The `Scene` interface (`engine/core/Scene.js`)

Extend `Scene` and override what you need; all methods default to no-ops:

```js
class MyScene extends Scene {
  enter(data) {}          // set up state, start ambience
  exit() {}               // tear down — stop loops/sequences/effects (see §9 lifecycle)
  update(now) {}          // sim + input → state (now = ms timestamp)
  render(now) {}          // draw only; no state mutation
  onKeydown(e) {} onKeyup(e) {}
  onMousedown(x, y) {} onMousemove(x, y) {} onMouseup(x, y) {}
  onWheel(deltaY, x, y) {}   // x,y are screen coords; see Camera for zoom
}
```

**Rules:** scenes own all their state; `update` mutates, `render` only draws; mouse
coordinates arrive in **screen space** — convert with `camera.screenToWorld(x, y)` before
hit-testing world entities.

---

## 4. The headline best practice: fire a sequence, don't one-off

Every reactive moment in the game — a spawn, a hit, a pickup, a death, a level-up — is
almost always **a coordinated burst of sound + visual effect + state change, often spread
over time**. The wrong way is to scatter those across gameplay code:

```js
// ❌ ANTI-PATTERN: imperative one-offs scattered in scene logic
onPet(critter) {
  critter.state = 'happy';
  this.shared.sound.playUI('happyChirp');
  this.shared.sound.playUI('happyChirp');           // "play it twice-ish"
  this.shared.effects.addGenericEffect(SPARKLE, critter.x, critter.y);
  setTimeout(() => { critter.state = 'idle'; }, 900); // timing buried in code
}
```

This is brittle: the timing is hardcoded, the sound/vfx/state are coupled to this call
site, you can't tweak it without editing code, and nothing is reusable or previewable.

**The right way: define the whole reaction as one data-driven sequence and fire it.**

```js
// ✅ PATTERN: one call; the sequence owns sound + vfx + state + timing
onPet(critter) {
  this.shared.sequences.play('critterPet', { x: critter.x, y: critter.y, entity: critter });
}
```

with `critterPet` authored in `data/fx-sequences.json`:

```json
"critterPet": {
  "positional": true,
  "steps": [
    { "type": "signal", "name": "setState", "data": { "state": "happy" }, "delay": 0 },
    { "type": "vfx",    "effect": "jolt", "delay": 0, "offsetRange": { "x": [-6,6], "y": [-10,-4] } },
    { "type": "sfx",    "sound": "happyChirp", "delay": 0, "repeat": [2,3], "repeatDelay": 140 },
    { "type": "signal", "name": "clearState", "delay": 900 }
  ]
}
```

That single sequence drives **state-in → vfx → sfx → (delay) → state-out** as one unit.

**Why this is the standard:**

- **One source of truth.** The reaction lives in one place, as data.
- **Editable without code.** Open the **Sequences editor** (`/editor`), tweak timing /
  swap the sound / change the effect, hit save, reload — no code change. The editor has a
  live preview.
- **Decoupled.** Gameplay code says *what happened* (`critterPet`), not *how it looks/
  sounds*. Artists/designers own the "how."
- **Composable & reusable.** Any call site, any entity, fires the same polished reaction.
- **Correct timing.** Delays/repeats/offsets are declarative, not `setTimeout` spaghetti.

**Mental model:** gameplay code emits *events*; sequences are the *presentation* of those
events. Keep the two apart.

**When a one-off is acceptable:** a single, instantaneous, uncoordinated sound with no
visual or state component — e.g. a UI button click (`sound.playUI('uiClick')`). Even then,
if it ever grows a second element, promote it to a sequence. Per-frame continuous audio
(an engine hum that tracks position every frame) is **not** a sequence — use
`EntityLoopManager` (§6).

---

## 5. Signals & state-transition callbacks

Sequences talk to game state through **signal steps**, which the engine forwards — without
interpreting — to the `onSignal` callback you pass to `FXSequenceRunner`:

```
FXSequenceRunner(sound, effects, onSignal)
        │
   sequence step { type:"signal", name:"setState", data:{state:"happy"} }
        │
        ▼
   onSignal("setState", { state:"happy" }, opts)   // opts.entity = the target you passed to play()
        │
        ▼
   game mutates the entity   →   entity.state flows into drawUnifiedArt(..., state, ...)
```

**How the target entity rides along:** when you call
`sequences.play('critterPet', { entity: critter, x, y })`, the runner passes that whole
`opts` object (including `entity`) to every `onSignal` call. So your handler stays
generic — it mutates "the entity," whatever it is:

```js
function onSignal(name, data, opts) {
  const e = opts?.entity;
  if (!e) return;                                   // ambient sequences carry no entity
  if (name === 'setState')        e.state = data?.state || 'idle';
  else if (name === 'clearState') { if (e.state !== 'linked') e.state = 'idle'; }
  else if (name === 'removeEntity') e._remove = true;   // scene prunes _remove entities
}
```

**The state→render loop closes here:** the entity's `state` string is passed straight into
`drawUnifiedArt(ctx, r, color, artDef, state, now)`. The art's per-shape `states` overrides
+ `visibleStates` make the rendered art change. So a sequence `signal` step **visibly
re-renders the entity** (e.g. `idle → happy` swaps body color and reveals a happy-only
shape). Editing the sequence changes behavior *and* visuals with no code edit.

**Defining new signals** (this is game code, in `onSignal`): pick a verb, handle it, and
emit it from a sequence. The engine needs zero changes. Good signal design:

- Keep signals **imperative and small**: `setState`, `clearState`, `removeEntity`,
  `spawnChild`, `applyDamage`. One verb, optional `data` payload.
- Mutate only the passed `entity` (or scene state reachable via a closure) — never reach
  into the engine.
- Signals should be **idempotent-ish / safe to fire mid-flight** — a delayed `clearState`
  may land after the entity changed; guard like the `linked` check above.

---

## 6. Subsystem reference (game-facing APIs)

Concise, verified signatures. See `ENGINE.md` for the full surface.

### Art — `drawUnifiedArt` + `buildArtRegistry`

```js
const art = buildArtRegistry({ critters: critterArtJson, props: propArtJson });
// → { critters: { blob: {...} }, props: { flower: {...} } }, deep-cloned (safe to mutate)
drawUnifiedArt(ctx, r, color, art.critters.blob, state, now /*, transition?, durationOverride? */);
```

- `r` scales the whole asset; `color` is the default fill/stroke when a shape omits its own.
- `state` selects per-shape `states: { <state>: {…} }` overrides + `visibleStates: [...]`.
- Coordinates: plain number = `val * r`; object `{ r, w, h, <animVar> }` = linear
  combination (each term scaled by `r`); `base` = **unscaled** additive constant; `…Abs`
  keys (e.g. `radiusAbs`) are absolute pixels.
- Animators: a `group` may declare `animators: [{ type:"oscillator", var, rate, amplitude,
  base }]`; `spinner` is its own shape type. Unknown shape types warn once (dev) and skip.
- Always draw under the camera transform (see Critter Garden's `GardenRenderer._drawArtAt`):
  `translate(screen); scale(zoom); drawUnifiedArt(ctx, r, ...)` so absolute radii, line
  widths, and glow scale with zoom too.

### VFX — `VFXInterpreter` via `EffectsManager` + `EffectsRenderer`

You rarely call the interpreter directly. The flow is:

```js
// accumulate (game-aware)
effects.emitTrail(id, x, y, now, { speed }, VFX_DEFS[trailRef]); // per-frame trail point
effects.addGenericEffect(VFX_DEFS.poof, x, y, { scale, id });    // one-shot or persistent
effects.removeGenericEffect(id);                                  // stop a persistent one
effects.update(now);                                             // prune trails, advance debris, cull

// render (camera transforms applied, zoom-aware)
effectsRenderer.drawTrails(effects.getTrails(), now);
effectsRenderer.drawGenericEffects(effects.getGenericEffects(now), now);
effectsRenderer.drawDebris(effects.getDebris(now));
effectsRenderer.drawBeam(x1, y1, x2, y2, VFX_DEFS.tether, now, { entityId, isLocal });
effectsRenderer.drawEffectAt(VFX_DEFS.aura, x, y, null, scale, now); // per-entity persistent
```

- VFX types: `phased` (one-shot or persistent), `bubbleTrail`, `taperedTrail`, `wiggleBeam`.
- Two-variant entity colors use **`{ local, remote }`** / `colorLocal`+`colorRemote` /
  `colorInner`+`colorOuter` (+`colorRemote*`). **Single-player: omit `isLocal` — it
  defaults to the local variant.** Only the optional multiplayer module needs `remote`.
- Persistent effects added via `addGenericEffect` **leak unless removed** — pass `{ id }`
  and call `removeGenericEffect(id)`, or render per-frame via `drawEffectAt` (which doesn't
  enter the manager). The garden uses `drawEffectAt` for live auras.
- `beam`/`trail` entity seeds must be **numeric** — `drawBeam` coerces `entityId`, but
  don't rely on a string carrying meaning into the math.

### Sequences — `FXSequenceRunner`

```js
sequences.play(id, { x, y, angle, entity, volume, scale, blastRadius });
sequences.stopAll();                 // stop timers + loops (call on scene exit)
sequences.getHandle(name) / stopHandle(name, { fadeOut });   // for named loop handles
```

Step schema (in `data/fx-sequences.json`):

| `type`      | fields |
|-------------|--------|
| `sfx`       | `sound`, `delay`, `volume?`, `repeat?` (`n` or `[min,max]`), `repeatDelay?` |
| `vfx`       | `effect`, `delay`, `offset?` `{x,y}`, `offsetRange?` `{x:[..],y:[..]}` |
| `loopStart` | `sound`, `handle`, `delay`, `fadeIn?`, `volume?` |
| `loopStop`  | `handle`, `delay`, `fadeOut?` |
| `signal`    | `name`, `data?`, `delay` |

`positional: true` on a sequence + `opts.x/y` makes `sfx`/`loopStart` positional and
places `vfx` at `(x,y)`. `opts.angle` rotates `vfx` offsets to follow body orientation.
`opts.entity` rides to every `signal`. Unknown step types / missing defs warn once.

### Sound — `SoundManager` + `EntityLoopManager`

```js
sound.playPositional(id, x, y, { volume });   // one-shot, world-positioned
sound.playUI(id, { volume });                 // one-shot, non-positional (range:0 sounds)
const h = sound.startLoop(id, x, y, { fadeIn, volume, playbackRate }); // → handle (or null)
sound.updateLoop(h, x, y, { volume, playbackRate });
sound.stopLoop(h, { fadeOut });
sound.updateListener(x, y, angle);            // call each frame (camera position)
sound.startUILoop(id, { fadeIn }) / stopUILoop(h);
sound.setVolume/getVolume/isMuted/toggleMute;
```

Key behaviors to respect:

- **`loop` in the data is authoritative.** A sound with `"loop": true` started via
  `playPositional`/`playUI` auto-delegates to the loop path; a non-loop sound started via
  `startLoop` warns. Match the method to the intent, but the data decides.
- **Positional loops lazy-start:** `startLoop` returns `null` if the emitter is currently
  out of range, and there's a voice cap that culls the least-audible loop. This is why
  `EntityLoopManager` re-calls `startLoop` each frame — that's the retry that makes lazy-
  start work. Don't assume `startLoop` always returns a handle.
- `range: 0` in the data = UI/non-positional; `range > 0` = positional (distance gain +
  low-pass + pan).

**Per-entity continuous audio** uses `EntityLoopManager` (not sequences):

```js
loopMgr.beginFrame();
for (const e of entities) loopMgr.updateEntity(e.id, 'critterHum', e.x, e.y, { playbackRate });
loopMgr.cleanupStale({ fadeOut: 0.2 });   // stops loops for entities gone this frame
// on removal: loopMgr.stopEntity(e.id, { fadeOut: 0.1 });  on exit: loopMgr.stopAll();
```

### Camera — `engine/core/Camera.js`

```js
const cam = new Camera(canvas, { minZoom: 0.4, maxZoom: 3 });
cam.x = ...; cam.y = ...;                 // pan (world coords at viewport center)
cam.worldToScreen(wx, wy) → { sx, sy };
cam.screenToWorld(sx, sy) → { x, y };
cam.setZoom(z) / getZoom() / zoomAt(factor, screenX, screenY);  // zoomAt anchors the cursor
```

In `onWheel(deltaY, x, y)` do `cam.zoomAt(deltaY < 0 ? STEP : 1/STEP, x, y)`. Art, effects,
debris, trails, beams, and the background all scale with zoom — keep new renderers
consistent (draw under the camera transform or multiply sizes by `getZoom()`).

### Physics — `engine/physics/`

```js
applyShipPhysics(body, input, dt, stats, bounds);
// body  = { x, y, vx, vy, angle }   (mutated in place)
// input = { thrust, rotateLeft, rotateRight }
// stats = { thrustForce, maxSpeed, rotationSpeed, forwardDrag, lateralDrag }
// bounds = { width, height }        (defaults to engine constants if omitted)
resolveElasticCollision(a, radiusA, b, radiusB /*, restitution = COLLISION.RESTITUTION */);
getCircleOverlap(ax, ay, ar, bx, by, br) → { overlap, nx, ny, dist } | null;
```

Drag is **frame-rate independent** (referenced to 60 Hz). Pass `dt` in seconds, clamped
(the scene caps it at ~0.05 to survive tab-switch stalls — do the same).

### Background — `BackgroundRenderer`

`new BackgroundRenderer(camera, canvas, layers)` — `layers` is a config array (see
`game/config.js` `BACKGROUND_LAYERS` for the shape: parallax, tileSize, count, size,
opacity, drift, pulse, color). Neutral default if omitted. Zoom-aware.

---

## 7. Data authoring & the editor pipeline

All content lives in `data/*.json` and is editable in the browser editor at `/editor`
(four tabs: **Art**, **VFX**, **Sequences**, **Soundboard**). The editors are retargeted
purely by `data/editor-manifest.json` — no editor code changes per project.

### Authoring shapes (current schemas)

**Art** (`{ "<collection>": { "<id>": asset } }`): each asset is
`{ name, states:[...], space?, setup?, shapes:[...] }`. Per-shape state overrides use
**`states: { <state>: {…} }`** (not `stateOverrides`). See §6 Art for coords/animators.

**VFX** (`{ "effects"? : ... }` consumed as `VFX_DEFS`): `phased` effects have
`phases[].layers[]` of primitives (`filledCircle`, `gradientCircle`, `strokeRing`,
`dashedRing`, `spikeLines`); trails/beams have type-specific fields. Value forms: static,
`{from,to}`, `{from,to,modulate:{freq,amp}}`, `{base,amplitude,freq}` (persistent),
`{local,remote}` (two-variant color).

**SFX** (`{ categories:[...], sounds:{ id: cfg } }`): each `cfg` is
`{ volume, range, category, loop, synth }`. `synth` is either a shorthand
`{ type, freq, freqEnd?, duration, attack, decay, lfo?, reverb? }` or a layered
`{ layers:[ {type:"sine|triangle|square|sawtooth", freq, freqEnd?, gain, detune?} |
{type:"file", file:"/SFX/x.wav", gain?, playbackRate?} ], duration?, attack?, decay?,
lfo?:{freq,depth}, reverb?:0..1 }`. `range:0` ⇒ UI; `range>0` ⇒ positional. `loop` is
authoritative (§6).

**Sequences** — see §6 step table.

**Manifest** (`data/editor-manifest.json`):

```json
{
  "artCollections": [{ "id","label","file","collectionKey" }],
  "previewEntities": [{ "id","label","artCollection","artId","radius","color","states":[...] }],
  "vfxCategories":  [{ "id","label","match":[ "...substring..." ] }]
}
```

Runtime art loading does **not** use the manifest — the game statically imports its art
JSON and calls `buildArtRegistry`. The manifest exists purely to point the **editors** at
this project's files/entities/categories.

### Save pipeline

`Ctrl+S` in an editor → `POST /api/save-data` → writes the file (allowlist-gated) and a
timestamped backup under `data/.backups/` (kept to the last N, not served over HTTP). The
allowlist is the core creative files + every `artCollections[].file` from the manifest.
Add a new art collection → add it to the manifest → it becomes saveable automatically.

---

## 8. Building a new game — recipe

1. **Copy the whole repo.** `engine/`, `editors/`, `server/` are reused as-is.
2. **Replace `data/*.json`** with your content (or author it in `/editor`). Point
   `data/editor-manifest.json` at your art collections, preview entities, and vfx
   categories.
3. **Write `game/config.js`** — your world size, palette, background layers, entity stats,
   and tunables. All game numbers live here, nowhere in `engine/`.
4. **Write your entities** (`game/*.js`) — plain classes holding state; use
   `applyShipPhysics`/collision if you want movement, or your own.
5. **Write your scenes** (`game/scenes/*.js`) extending `Scene`. Own state in the scene;
   pull services from `shared`. Convert mouse coords with `camera.screenToWorld`.
6. **Author reactions as sequences** (§4), wire `onSignal` (§5) in `game/main.js`.
7. **Write `game/main.js`** — construct services, `buildArtRegistry`, define `onSignal`,
   build `shared`, create scenes, `game.start(firstScene)`.
8. **Add tests** mirroring `tests/` (Node `--test` via the loader remap). Run `npm test`.
9. **Verify** in the browser: game at `/`, editors at `/editor`. No console errors.

---

## 9. Conventions, gotchas & lifecycle

- **Import paths are absolute, server-rooted:** `/engine/...`, `/data/...`, `/game/...`.
  JSON uses `import x from '/data/x.json' with { type: 'json' }`. The server serves `.json`
  as `application/json` (no-cache in dev). Don't use relative `../` engine imports from
  game code; do use them within a folder (`./GardenRenderer.js`).
- **Immutability:** raw JSON imports are frozen. Always go through `buildArtRegistry` /
  `engine/data/*` loaders (they deep-clone). Mutating a frozen import throws.
- **Scene lifecycle / no leaks:** in `exit()` stop everything you started —
  `sequences.stopAll()`, `loopMgr.stopAll()`, `effects.stopAll()`. In `enter()` reset
  transient input state (e.g. held-keys set). The garden scene is the reference.
- **`update` vs `render`:** never mutate state in `render`; never draw in `update`. The
  loop calls `update(now)` then `render(now)`.
- **dt:** compute `dt` from `now`, clamp to ~`0.05` so a tab-switch can't teleport
  physics/particles.
- **Dev warnings:** unknown art shape types, VFX primitives/types, sequence step types, and
  sound ids each `console.warn` once. A silent missing effect usually means a typo'd id —
  check the console.
- **Server config:** binds `127.0.0.1` by default (`HOST=0.0.0.0` to expose), `PORT` env
  (default 6970), optional `EDITOR_PASSWORD` to gate the editor + save API. The request
  handler is fully guarded (malformed URLs / null bytes return 4xx, never crash).
- **Optional `engine/net/`:** a stubbed, unwired multiplayer module (NetworkClient,
  ServerLoop, StateBuffer, protocol). The single-player core has zero dependency on it; the
  `ws` dep is only for net. Wire it per-project; it's a head-start, not battle-tested.

---

## 10. Anti-pattern quick reference

| ❌ Don't | ✅ Do |
|---------|------|
| `if (id === 'blob')` inside `engine/` | branch in `game/`, or encode in `data/` |
| Add a gameplay `case` to an interpreter | add a generic data-driven primitive |
| One-off `sound.play` + `addGenericEffect` + `setTimeout` state change | one `sequences.play(id, { entity })` |
| Hardcode timing with `setTimeout` in scene code | `delay`/`repeat`/`repeatDelay` in a sequence |
| Engine interprets a signal name | engine forwards the string; `onSignal` decides |
| Hardcode collection/file lists in an editor | add to `data/editor-manifest.json` |
| Mutate a raw JSON import | go through `buildArtRegistry` / loaders (deep-cloned) |
| Persistent `addGenericEffect` with no `id` | pass `{ id }` + `removeGenericEffect`, or `drawEffectAt` |
| Per-frame entity audio via sequences | `EntityLoopManager` (beginFrame/updateEntity/cleanupStale) |
| Cross-scene globals / state on engine objects | scene-owned state + injected `shared` |
| Move the RAF reschedule out of `finally` | leave the loop's crash-proof structure intact |
| Reintroduce `new Function`/`eval` | use the existing safe arithmetic parser |

---

## 11. Before you call it done

- `npm test` is green (add tests for new shared functions / systems / renderers).
- No new game noun appears anywhere under `engine/` or `editors/` (grep your diff).
- New reactions are sequences; new signals are handled in `onSignal`; no scattered
  `setTimeout` presentation logic.
- Browser check: game at `/` and all editor tabs at `/editor` load with **no console
  errors**; new effects/sounds actually fire (watch for the dev warnings).
- Scene `exit()` cleans up every loop/sequence/effect it started.
