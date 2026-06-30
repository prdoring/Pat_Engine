// Pure, DOM-free asset-collection operations for the art editor.
// Kept separate from the DOM editor so the logic is unit-testable in Node
// (mirrors the editors/musicModel.js + editors/midiModel.js pattern).
//
// An art collection file is `{ <collectionKey>: { <id>: assetDef } }` (or a bare
// `{ <id>: assetDef }` map when the manifest declares no collectionKey). These
// helpers operate on that map in place, preserving key insertion order, so the
// caller can deep-assign / save the whole file unchanged.

/** Resolve the `{ id: assetDef }` map inside a collection's file data. */
export function getAssetsMap(fileData, collectionKey) {
  return (collectionKey && fileData[collectionKey]) || fileData;
}

/** A valid asset id: starts with a letter, then letters/digits/underscore. */
export function isValidAssetId(id) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(id);
}

/**
 * Validate a *new* asset id against an existing map. Returns an error string to
 * show the user, or null when the id is acceptable. `ignore` lets a rename keep
 * its own current id.
 */
export function validateAssetId(fileData, collectionKey, id, { ignore = null } = {}) {
  const trimmed = (id || '').trim();
  if (!trimmed) return 'Enter an id';
  if (!isValidAssetId(trimmed)) return 'Letters, digits, underscore; must start with a letter';
  const map = getAssetsMap(fileData, collectionKey);
  if (trimmed !== ignore && map[trimmed] !== undefined) return `"${trimmed}" already exists`;
  return null;
}

/** A minimal but renderable starter asset so a new asset is never empty JSON. */
export function newAssetTemplate(id) {
  return {
    name: id,
    states: [],
    shapes: [
      { name: 'Body', type: 'circle', cx: 0, cy: 0, radius: 0.8, fill: true },
    ],
  };
}

/** Create a new asset under `id`. Returns the id. */
export function addAsset(fileData, collectionKey, id, asset = newAssetTemplate(id)) {
  getAssetsMap(fileData, collectionKey)[id] = asset;
  return id;
}

/** Deep-clone `srcId` to `newId` (label tracks the new id). Returns newId. */
export function duplicateAsset(fileData, collectionKey, srcId, newId) {
  const map = getAssetsMap(fileData, collectionKey);
  const clone = JSON.parse(JSON.stringify(map[srcId]));
  clone.name = newId;
  map[newId] = clone;
  return newId;
}

/** Remove `id` from the map (no-op if absent). */
export function deleteAsset(fileData, collectionKey, id) {
  delete getAssetsMap(fileData, collectionKey)[id];
}

/**
 * Rename `oldId` → `newId`, preserving key order by rebuilding the map in place.
 * If the asset's display `name` still mirrored its id, it tracks the new id too;
 * a custom name is left untouched. Returns newId.
 */
export function renameAsset(fileData, collectionKey, oldId, newId) {
  const map = getAssetsMap(fileData, collectionKey);
  if (oldId === newId || map[oldId] === undefined) return oldId;
  const asset = map[oldId];
  if (asset && (asset.name === undefined || asset.name === oldId)) asset.name = newId;
  const rebuilt = {};
  for (const k of Object.keys(map)) rebuilt[k === oldId ? newId : k] = map[k];
  for (const k of Object.keys(map)) delete map[k];
  Object.assign(map, rebuilt);
  return newId;
}
