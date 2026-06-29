// Deterministic RNG for the shot harness, so a shot that uses incidental Math.random
// (VFX dot/line emitters, entity spawn jitter) renders identically every run. Generic:
// it patches Math.random only for the duration of one render, then restores it.

/** mulberry32 — tiny, fast, decent-quality seeded PRNG. Returns () => float in [0,1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → uint32, so a shot id alone is a stable seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Run `fn` with Math.random replaced by a seeded generator, then always restore it. */
export function withSeed(seed, fn) {
  const orig = Math.random;
  Math.random = seededRandom(seed >>> 0);
  try { return fn(); } finally { Math.random = orig; }
}
