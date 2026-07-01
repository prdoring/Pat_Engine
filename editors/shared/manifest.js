// Loads data/editor-manifest.json — the seam that retargets the editor suite to
// a project's assets. Declares art collections (id/label/file/collectionKey),
// preview entities (for the sequence editor), and vfx categories.

let _manifest = null;

export async function loadManifest() {
  if (_manifest) return _manifest;
  _manifest = await fetch('/data/editor-manifest.json').then(r => r.json());
  _manifest.artCollections = _manifest.artCollections || [];
  _manifest.previewEntities = _manifest.previewEntities || [];
  _manifest.vfxCategories = _manifest.vfxCategories || [];
  return _manifest;
}

export function getManifest() { return _manifest; }
