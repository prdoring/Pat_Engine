// Engine-level constants. Game-specific tuning (entity sizes, spawn counts, etc.)
// belongs in the project's own config, not here.

// Fixed simulation tick (used by the optional net/ServerLoop and any
// fixed-timestep game logic).
export const SERVER_TICK_RATE = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;

// Default world bounds. `applyShipPhysics` clamps to these unless a game passes
// its own `bounds`. Named MAP_WIDTH/MAP_HEIGHT for compatibility with the
// physics/geometry modules copied verbatim from Sub Game.
export const MAP_WIDTH = 4000;
export const MAP_HEIGHT = 4000;
