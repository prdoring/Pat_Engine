/**
 * Optional VFX-effect resolver, injected by the host (game / editor / shots) so
 * the pure interpreter never imports project data. `effectRef` shapes name a VFX
 * effect by id; the host resolves id → definition. Left null → effectRef is a no-op.
 *
 * This is a leaf module (no imports) shared by the ArtInterpreter entry (which
 * re-exports `setEffectResolver`) and the shape renderer (`./shapes.js`, which
 * reads it via `getEffectResolver()`). Housing the mutable binding here — rather
 * than in the entry — breaks the entry↔shapes import cycle. Consumers MUST call
 * `getEffectResolver()` at draw time (a value import would snapshot `null`).
 */

let _effectResolver = null;

export function setEffectResolver(fn) { _effectResolver = fn; }

export function getEffectResolver() { return _effectResolver; }
