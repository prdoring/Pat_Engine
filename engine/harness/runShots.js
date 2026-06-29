// Generic shot runner. Renders each declared shot through a game-supplied `renderShot`
// and hands the result canvas to a sink. Knows NOTHING about game state: `shot.state`
// is opaque (only the game's renderShot reads it), and the runner touches only `shot.id`
// / `shot.viewport` / `shot.now` / `shot.seed`. `renderShot` is passed in as a parameter
// (never imported), so the engine never depends on `game/` — the same firewall as
// RoomServer's opaque `member.data` and FXSequenceRunner's opaque `onSignal` entity.

import { withSeed, hashSeed } from './seededRandom.js';

/**
 * @param {object} cfg
 * @param {Array<{id:string, viewport?:{w,h}, now?:number, seed?:number, state?:any}>} cfg.shots
 * @param {(ctx:CanvasRenderingContext2D, shot:object, env:{now,width,height,dpr})=>void} cfg.renderShot
 *        The game seam. Draws one shot to `ctx` (pre-scaled to logical px).
 * @param {(w:number,h:number)=>HTMLCanvasElement} cfg.makeCanvas  backend canvas factory
 * @param {(id:string, canvas:HTMLCanvasElement)=>void} [cfg.emit]  per-shot sink
 * @param {{dpr?:number, now?:number, width?:number, height?:number}} [cfg.defaults]
 * @returns {Array<{id:string, canvas:HTMLCanvasElement, width:number, height:number}>}
 */
export function runShots({ shots, renderShot, makeCanvas, emit, defaults = {} }) {
  const dpr = defaults.dpr ?? 2;
  const results = [];
  for (const shot of shots) {
    const width = shot.viewport?.w ?? defaults.width ?? 800;
    const height = shot.viewport?.h ?? defaults.height ?? 600;
    const now = shot.now ?? defaults.now ?? 0;
    // Backing store at device px; draw in logical px (mirrors Game._frame) so a shot is
    // crisp on HiDPI and renderShot can size to the logical viewport.
    const canvas = makeCanvas(Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr)));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const seed = shot.seed != null ? (shot.seed >>> 0) : hashSeed(shot.id);
    withSeed(seed, () => renderShot(ctx, shot, { now, width, height, dpr }));
    if (emit) emit(shot.id, canvas);
    results.push({ id: shot.id, canvas, width, height });
  }
  return results;
}
