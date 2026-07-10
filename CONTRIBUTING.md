# Contributing

PRs are welcome. This is a solo-maintained project, so small and focused beats big and
sweeping: a bug fix, a new generic primitive, an editor improvement, better docs.

## Setup

See [Getting started](README.md#getting-started). Short version: Node 20.11+, then
`npm install` and `npm start`.

## Before you open a PR

1. `npm test` passes (Node's built-in test runner, no extra tooling).
2. `npm run smoke` passes: it boots the game, every editor tab, and the shot harness in
   a headless Chrome and fails on any console error.
3. New behavior comes with a test alongside the existing ones in `tests/`.

CI runs both on every PR.

## The one rule that gets PRs rejected

**The engine must never know what game it runs.** No game noun (an entity, state, sound,
or art id, or a gameplay constant) may appear under `engine/` or `editors/`. If a data
format can't express what you need, add a generic primitive any game could use, never a
game-specific branch. [AGENTS.md](AGENTS.md) is the full guide; §2 is the checklist a
reviewer will apply to your diff.

Two more conventions worth knowing:

- **No build step, no new dependencies.** The engine's entire dependency list is `ws`.
  A PR that adds a bundler, framework, or npm package needs an exceptional reason.
- **Reactions are sequences.** Sound + VFX + state changes are authored in
  `data/fx-sequences.json` and fired with `sequences.play(...)`, not scattered through
  scene code.

## Content PRs

Art, VFX, sounds, music, and sequences are all JSON under `data/`, editable at
`/editor`. Improvements to the Critter Garden example are fair game; author them in the
editors and commit the resulting JSON.
