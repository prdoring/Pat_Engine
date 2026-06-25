// Art registry helper. Sub Game had no central art loader — each renderer
// destructured its own statically-imported JSON namespace. This introduces one
// reusable seam: the game statically imports its art JSON (which keeps the
// browser's JSON-import-attribute fast path) and passes the namespaces here.
//
// Crucially this DEEP-CLONES: raw JSON module imports are frozen, and the art
// interpreter / game may mutate art at runtime. Cloning here avoids the
// "mutating a frozen import by luck" hazard from Sub Game.

/**
 * Build a flat `{ collection: { id: assetDef } }` registry from imported art
 * namespaces. Each namespace may be wrapped (`{ <collection>: { id: asset } }`,
 * the engine's standard art-file shape) or already the inner `{ id: asset }` map.
 *
 * @param {Object<string, object>} namespaces - collectionKey → imported JSON
 * @returns {Object<string, Object<string, object>>}
 *
 * @example
 *   import critters from '/data/critter-art.json' with { type: 'json' };
 *   import props    from '/data/prop-art.json'    with { type: 'json' };
 *   const art = buildArtRegistry({ critters, props });
 *   drawUnifiedArt(ctx, r, color, art.critters.blob, state, now);
 */
export function buildArtRegistry(namespaces) {
  const registry = {};
  for (const [key, raw] of Object.entries(namespaces)) {
    const cloned = JSON.parse(JSON.stringify(raw));
    registry[key] = (cloned[key] && typeof cloned[key] === 'object') ? cloned[key] : cloned;
  }
  return registry;
}

/** Safe lookup: returns the asset def or null. */
export function getAsset(registry, collection, id) {
  return registry?.[collection]?.[id] || null;
}
