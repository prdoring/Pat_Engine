# Pat_Engine

A no-build, vanilla-JS, browser-native 2D engine (data-driven art / VFX / sequences /
sound + editors). Ships with the **Critter Garden** example game. No bundler, no
framework; the browser loads ES modules by absolute path and JSON via import attributes.

**📖 Read `AGENTS.md` before writing code here; it is the full guide for building on this
engine** (layering, leak-prevention rules, the sequence-first orchestration pattern, signal
callbacks, every subsystem API, and authoring shapes). `ENGINE.md` is the terse API
cheat-sheet; `README.md` covers run/config; `docs/EDITORS.md` is the user-facing editor
guide (its screenshots live in `docs/screenshots/`; re-capture via `/shots` + `/editor`
if the UI changes materially).

## Non-negotiable rules (full detail in AGENTS.md)

1. **The engine must never know what game it runs.** No game noun (entity/state/sound/art
   id, gameplay constant) may appear under `engine/` or `editors/`. Test each line: *would
   it still make sense, unchanged, in a totally different game?* If no, it belongs in
   `game/` or `data/`.
2. **Layering & dependency direction:** `game/ → engine/` ✅, `game/ → data/` ✅,
   `engine/data/*.js → data/*.json` ✅ (the only engine→data binding; treats data as
   opaque). `engine/ → game/` ❌, hardcoded ids in `engine/` ❌, `editors/` not driven by
   `data/editor-manifest.json` ❌.
3. **Extend interpreters with data, not gameplay branches.** Need something new? Add a
   *generic* primitive any game could use, never a game-specific `case`.
4. **Fire a sequence, don't one-off.** A reaction (sound + VFX + state change, often over
   time) is authored once in `data/fx-sequences.json` and triggered with
   `sequences.play(id, { x, y, entity })`. Don't scatter `sound.play` + `addGenericEffect`
   + `setTimeout` state changes across scene code.
5. **Signals drive state via the `onSignal(name, data, opts)` callback** (`game/main.js`).
   The engine forwards signal strings verbatim; the game interprets them and mutates
   `opts.entity`. The entity's `state` flows into `drawUnifiedArt(..., state, ...)`.
6. **Scenes own their state; services are injected via `shared`.** Clean up in `exit()`
   (`sequences.stopAll()` / `loopMgr.stopAll()` / `effects.stopAll()`). Mutate in
   `update`, draw in `render`.
7. **Runtime data is immutable unless cloned** (`buildArtRegistry` / `engine/data/*`
   loaders deep-clone). No `eval`/`new Function`.

## Workflow

- Run: `npm start` → http://localhost:6970/ (editor: `/editor`). Config via `PORT`/`HOST`/
  `EDITOR_PASSWORD` env (binds localhost by default).
- Test: `npm test` (Node `--test` via a loader remap, zero deps). Add tests with changes;
  keep it green.
- Verify in-browser after changes: game at `/` and all four editor tabs at `/editor` load
  with **no console errors**.
