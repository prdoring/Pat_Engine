// Compose rendered shot canvases into one labeled grid ("contact sheet") image — the
// at-a-glance overview an agent reads. Generic: it only reads each item's `id` (a label
// string) and `canvas`; it never sees shot state. The caller supplies a `makeCanvas`
// factory so this stays backend-agnostic.

/**
 * @param {Array<{id:string, canvas:HTMLCanvasElement}>} items
 * @param {object} cfg
 * @param {(w:number,h:number)=>HTMLCanvasElement} cfg.makeCanvas
 * @param {number} [cfg.cols]    columns (default ~sqrt(n))
 * @param {number} [cfg.cell]    cell box size in px for the thumbnail (default 300)
 * @param {number} [cfg.pad]     outer + inter-cell padding (default 14)
 * @param {number} [cfg.labelH]  label strip height under each thumb (default 22)
 * @param {string} [cfg.bg] [cfg.fg] [cfg.font]
 * @returns {HTMLCanvasElement}
 */
export function composeContactSheet(items, cfg) {
  const { makeCanvas } = cfg;
  const n = items.length;
  const cols = cfg.cols || Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cell = cfg.cell ?? 300;
  const pad = cfg.pad ?? 14;
  const labelH = cfg.labelH ?? 22;
  const bg = cfg.bg ?? '#0b1118';
  const fg = cfg.fg ?? '#9fb3c8';
  const font = cfg.font ?? '13px monospace';

  const cellW = cell + pad;
  const cellH = cell + labelH + pad;
  const sheet = makeCanvas(pad + cols * cellW, pad + rows * cellH);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  items.forEach((item, i) => {
    const cx = pad + (i % cols) * cellW;
    const cy = pad + Math.floor(i / cols) * cellH;
    const src = item.canvas;
    // Letterbox the thumbnail into the cell box, preserving aspect.
    const scale = Math.min(cell / src.width, cell / src.height);
    const w = Math.max(1, src.width * scale);
    const h = Math.max(1, src.height * scale);
    const dx = cx + (cell - w) / 2;
    const dy = cy + (cell - h) / 2;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(cx, cy, cell, cell);
    ctx.drawImage(src, dx, dy, w, h);
    ctx.fillStyle = fg;
    ctx.font = font;
    ctx.fillText(ellipsize(item.id, 34), cx + cell / 2, cy + cell + labelH / 2);
  });
  return sheet;
}

function ellipsize(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
