// Word-wrap + auto-shrink-to-fit text, with a memoized fit. `ctx.fillText` does not
// wrap, and finding the largest font size whose wrapped lines fit a box costs ~9–14
// measureText passes per paragraph — far too much to redo 60×/s for every paragraph
// on screen. The fit is deterministic for a fixed (text, box, weight, size, family),
// so it is cached exactly (the ctx is irrelevant to the key). Game-agnostic: the
// caller supplies the font family (defaults to a generic sans-serif).

const DEFAULT_FAMILY = 'sans-serif';

export function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const _fitCache = new Map();
const _FIT_CACHE_MAX = 200;

/** Find the largest size in [min,max] whose wrapped lines fit a w×h box. Returns
 *  `{ size, lines, lineHeight, font }`. Memoized; identical args reuse the result. */
export function fitParagraph(ctx, text, { w, h, max = 40, min = 14, weight = 700, family = DEFAULT_FAMILY }) {
  // Round w/h so sub-pixel layout jitter doesn't cause cache misses every frame.
  const key = `${text}|${Math.round(w)}|${Math.round(h)}|${max}|${min}|${weight}|${family}`;
  const hit = _fitCache.get(key);
  if (hit) return hit;
  const fit = _computeFit(ctx, text, w, h, max, min, weight, family);
  // Drop-oldest on overflow (insertion-ordered Map). Eviction only on a miss, so a
  // cache hit is never penalized.
  if (_fitCache.size >= _FIT_CACHE_MAX) _fitCache.delete(_fitCache.keys().next().value);
  _fitCache.set(key, fit);
  return fit;
}

function _computeFit(ctx, text, w, h, max, min, weight, family) {
  for (let size = max; size >= min; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    const lines = wrapLines(ctx, text, w);
    const lineHeight = size * 1.2;
    if (lines.length * lineHeight <= h) return { size, lines, lineHeight, font: ctx.font };
  }
  ctx.font = `${weight} ${min}px ${family}`;
  return { size: min, lines: wrapLines(ctx, text, w), lineHeight: min * 1.2, font: ctx.font };
}

/**
 * Draw `text` centered in a box centered at (x,y) of size w×h, wrapped + shrunk to
 * fit. Returns the rendered height. Colours/glow are plain parameters with neutral
 * defaults, so the engine carries no game styling.
 */
export function drawParagraph(ctx, text, o) {
  const { x, y, w, h, color = '#eaf2ff', glow = color, blur = 8, weight = 700, family = DEFAULT_FAMILY, alpha = 1 } = o;
  const fit = fitParagraph(ctx, text, { w, h, max: o.max || 40, min: o.min || 14, weight, family });
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = fit.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = glow;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  const total = fit.lines.length * fit.lineHeight;
  let cy = y - total / 2 + fit.lineHeight / 2;
  for (const ln of fit.lines) { ctx.fillText(ln, x, cy); cy += fit.lineHeight; }
  ctx.restore();
  return total;
}
