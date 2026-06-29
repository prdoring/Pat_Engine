# Pat_Engine

A reusable, **no-build** 2D game engine for the browser — extracted from Sub Game. It bundles the
hard-won, data-driven creative pipeline:

- **Vector art** — a declarative Canvas2D art interpreter + editor (shapes, states, animators).
- **VFX** — a data-driven effects interpreter + editor (phased effects, trails, beams).
- **Sequences** — an FX-sequence runner + timeline editor that orchestrate **sound + VFX + state
  changes together** from JSON.
- **Sound** — a Web-Audio synth/sample engine (incl. MIDI tunes + adaptive music) + soundboard/music editors.
- **Editors** — a unified editor suite with a file-based save/backup pipeline.
- **Shot harness** — render predefined game states (`data/shots.json`) to images for agentic dev/review.

It ships with the **Critter Garden** example game, a tiny single-player toy that exercises every
subsystem and validates the extraction.

## Run

```
npm install
npm start
```

- Game: <http://localhost:6970/>
- Editor suite: <http://localhost:6970/editor>
- Shots: <http://localhost:6970/shots> — render predefined game states (`data/shots.json`) to images
  for visual review; `?shot=<id>` for one full-res. Built for agentic dev (edit → reload → look).

## Test

```
npm test
```

## Configuration (env vars)

- `PORT` — HTTP port (default `6970`).
- `HOST` — bind address (default `127.0.0.1`, loopback only). Set `HOST=0.0.0.0` to expose on the LAN.
- `EDITOR_PASSWORD` — when set, the `/editor` suite and the save API require login (a random
  session token is issued on success). Unset by default (open) — safe because the server binds
  localhost only unless you change `HOST`.

The save API accepts only allowlisted data files (the core creative JSON + the manifest's art
collections) and writes timestamped backups under `data/.backups/` (kept to the last N), which are
not served over HTTP.

## Layout

```
engine/   game-agnostic runtime (render, audio, fx, physics, core loop, optional net). Copy, never edit.
editors/  game-agnostic editor suite, driven by data/editor-manifest.json.
data/     project content: art/vfx/sfx/sequence JSON + the manifest. Edited by the editors.
game/     the game: scenes, entities, bootstrap. The only place you write gameplay code.
server/   the host: static serving + editor save API.
assets/   binary assets (SFX).
```

## Starting a new project from Pat_Engine

Use the scaffold script — it copies the baseline (excluding `.git`, `node_modules`,
`data/.backups`), renames the package, runs `git init` + an initial commit, and
`npm install`:

```sh
./new-game.sh MyGame              # creates ../MyGame next to the engine
./new-game.sh /path/to/MyGame     # or an explicit path
# flags: --no-install  --no-git  --force
```
```powershell
.\new-game.ps1 MyGame             # creates ..\MyGame next to the engine
.\new-game.ps1 C:\Games\MyGame    # or an explicit path
# flags: -NoInstall  -NoGit  -Force
```

Then make it yours:

1. (Scaffold already copied the engine baseline + the Critter Garden example as a starting point.)
2. Replace `data/*.json` with your own assets (or edit them in `/editor`).
3. Point `data/editor-manifest.json` at your art collections + preview entities.
4. Replace `game/` with your scenes and entities, wiring engine services in `game/main.js`.

See `ENGINE.md` for the engine API cheat-sheet, and **`AGENTS.md`** for the full guide to
building a game on this engine (layering rules, the sequence-first orchestration pattern,
signal callbacks, and every subsystem's authoring shape) — written for AI coding agents but
useful to anyone extending the engine.
