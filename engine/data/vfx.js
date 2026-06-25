import rawVfxData from '/data/vfx.json' with { type: 'json' };

// Deep clone for mutability (JSON imports are frozen)
const vfxData = JSON.parse(JSON.stringify(rawVfxData));

// All VFX definitions keyed by name
export const VFX_DEFS = vfxData.effects;
