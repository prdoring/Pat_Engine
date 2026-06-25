import rawFxSeqData from '/data/fx-sequences.json' with { type: 'json' };

// Deep clone for mutability (JSON imports are frozen)
const fxSeqData = JSON.parse(JSON.stringify(rawFxSeqData));

// ─── Data from JSON ──────────────────────────────────────────────────

export const FX_SEQUENCES = fxSeqData.sequences;

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a snake_case seq: reference to its camelCase sequence ID.
 * e.g. "engine_start" → "engineStart", "launcher_fire_torpedo" → "launcherFireTorpedo"
 */
export function seqRefToId(snakeRef) {
  return snakeRef.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
