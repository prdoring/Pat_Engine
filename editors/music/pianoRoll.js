// editors/music/pianoRoll.js
// A self-contained canvas piano-roll for editing one stem's note pattern (beats), generic and
// game-agnostic. Layout top→bottom: a minimap (whole-loop overview with the visible window +
// global playhead), a bar ruler (drag to move the playhead), the pitch×time grid, and a velocity
// lane. Draw notes by dragging empty grid, move/resize by dragging a note, set velocity in the
// lane or by Alt-dragging a note, delete with right-click or Delete, click the piano keys to
// audition a pitch, Ctrl+wheel to zoom (Shift+wheel pans, wheel scrolls pitch), drag the minimap
// to scroll. The static layers are cached to an offscreen canvas so the playhead loop only blits +
// draws lines. Note math goes through editors/music/model/midiModel.js; the host owns the notes array +
// persistence (`onEdit`), auditions via `previewNote`, and seeks playback via `onSeek`.
import {
  addNote, moveNote, resizeNote, deleteNote, setVelocity, loopBeats, repeatGhosts, PITCH_MIN, PITCH_MAX,
} from './model/midiModel.js';
import { isModalOpen } from '/editors/shared/index.js';
import { themeColor, themeColorRgba, onThemeChange } from '/editors/shared/theme.js';

const GUTTER = 44;  // piano-key gutter width (px)
const MINI = 16;    // top minimap height
const RULER = 22;   // bar/beat ruler height (below the minimap)
const TOP = MINI + RULER; // grid top offset
const VEL_H = 56;   // bottom velocity lane height
const ROW_H = 12;   // pitch row height
const EDGE = 6;     // right-edge resize grab zone (px)
const BLACK = new Set([1, 3, 6, 8, 10]); // semitones that are black keys

export function createPianoRoll(container, { onEdit = () => {}, onEditCommit = () => {}, getPhase = () => null, previewNote = () => {}, onSeek = () => {} } = {}) {
  let pattern = [];
  let song = { bpm: 120, bars: 4, beatsPerBar: 4, grid: 0.25 };
  let repeat = false; // selected stem repeats to fill the loop → draw ghost copies
  let zoom = 1, pxPerBeat = 40, scrollX = 0, scrollY = 0;
  let playing = false, selected = null, drag = null, raf = null, staticDirty = true, gestureDirtied = false;

  injectStyle();
  const wrap = el('div', 'pr-wrap');
  const canvas = el('canvas', 'pr-canvas');
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  const ctx = canvas.getContext('2d');
  const buf = document.createElement('canvas'); // offscreen static-layer cache
  const bctx = buf.getContext('2d');

  const dpr = () => window.devicePixelRatio || 1;
  const lb = () => loopBeats(song);
  const cssW = () => parseFloat(canvas.style.width) || 600;
  const cssH = () => parseFloat(canvas.style.height) || 340;
  const mainH = () => cssH() - TOP - VEL_H;
  const totalPitchH = () => (PITCH_MAX - PITCH_MIN + 1) * ROW_H;
  const xAt = (b) => GUTTER + b * pxPerBeat - scrollX;
  const beatAt = (x) => (x - GUTTER + scrollX) / pxPerBeat;
  const yTop = (m) => TOP + (PITCH_MAX - m) * ROW_H - scrollY;
  const midiAt = (y) => PITCH_MAX - Math.floor((y - TOP + scrollY) / ROW_H);
  const miniX = (b) => GUTTER + (b / lb()) * (cssW() - GUTTER);
  const miniBeat = (x) => ((x - GUTTER) / (cssW() - GUTTER)) * lb();
  const playheadX = () => { const ph = getPhase(); return ph == null ? null : xAt(ph * lb()); };
  const opts = () => ({ grid: song.grid, loopBeats: lb() });

  function recomputePx() { pxPerBeat = ((cssW() - GUTTER) / lb()) * zoom; }
  function clampScroll() { scrollY = Math.max(0, Math.min(scrollY, Math.max(0, totalPitchH() - mainH()))); }
  function clampX() { scrollX = Math.max(0, Math.min(scrollX, Math.max(0, lb() * pxPerBeat - (cssW() - GUTTER)))); }

  function resize() {
    const r = wrap.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const w = Math.floor(r.width), h = Math.floor(r.height), d = dpr();
    for (const cv of [canvas, buf]) { cv.width = Math.floor(w * d); cv.height = Math.floor(h * d); }
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    recomputePx(); clampScroll(); clampX();
    draw();
  }

  // ── Static layers → offscreen cache ──
  function renderStatic() {
    const g = bctx, w = cssW(), h = cssH();
    // Repeat ghosts: tiled copies of a short pattern that fill the loop (read-only, drawn dimmed).
    const ghosts = repeat ? repeatGhosts(pattern, lb(), song.beatsPerBar ?? 4) : [];
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = themeColor('--ed-pr-bg'); g.fillRect(0, 0, w, h);

    // minimap (whole-loop overview)
    g.fillStyle = themeColor('--ed-pr-mini-bg'); g.fillRect(0, 0, w, MINI);
    g.fillStyle = themeColor('--ed-pr-label'); g.font = '8px monospace'; g.textBaseline = 'middle'; g.fillText('map', 6, MINI / 2);
    for (const n of ghosts) { g.fillStyle = themeColor('--ed-pr-ghost'); g.fillRect(miniX(n.beat), 3, 1.5, MINI - 6); }   // ghost density
    for (const n of pattern) { g.fillStyle = themeColor('--ed-pr-note-density'); g.fillRect(miniX(n.beat), 3, 1.5, MINI - 6); } // note density
    // visible-window box
    const vx0 = miniX(scrollX / pxPerBeat), vx1 = miniX((scrollX + (w - GUTTER)) / pxPerBeat);
    g.strokeStyle = themeColor('--ed-me-accent'); g.lineWidth = 1; g.strokeRect(vx0 + 0.5, 1.5, Math.max(2, vx1 - vx0) - 1, MINI - 3);
    g.fillStyle = themeColorRgba('--ed-me-accent-rgb', 0.12); g.fillRect(vx0, 1, Math.max(2, vx1 - vx0), MINI - 2);

    // pitch rows
    g.save(); g.beginPath(); g.rect(GUTTER, TOP, w - GUTTER, mainH()); g.clip();
    for (let m = PITCH_MIN; m <= PITCH_MAX; m++) {
      const y = yTop(m);
      if (y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = BLACK.has(((m % 12) + 12) % 12) ? themeColor('--ed-pr-row-black') : themeColor('--ed-pr-row-white');
      g.fillRect(GUTTER, y, w - GUTTER, ROW_H);
      g.strokeStyle = themeColor('--ed-pr-line'); g.lineWidth = 1; g.beginPath(); g.moveTo(GUTTER, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    }
    const gr = song.grid > 0 ? song.grid : 0.25, bpb = song.beatsPerBar ?? 4;
    for (let b = 0; b <= lb() + 1e-6; b += gr) {
      const x = xAt(b); if (x < GUTTER - 1 || x > w) continue;
      g.strokeStyle = Math.abs(b % bpb) < 1e-6 ? themeColor('--ed-pr-label') : Math.abs(b % 1) < 1e-6 ? themeColor('--ed-modal-border2') : themeColor('--ed-pr-line');
      g.lineWidth = 1; g.beginPath(); g.moveTo(Math.floor(x) + 0.5, TOP); g.lineTo(Math.floor(x) + 0.5, TOP + mainH()); g.stroke();
    }
    for (const n of ghosts) { // tiled repeats — dim, no outline, behind the editable notes
      const x = xAt(n.beat), y = yTop(n.midi), nw = Math.max(2, n.len * pxPerBeat);
      if (x + nw < GUTTER || x > w || y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = themeColorRgba('--ed-me-accent-rgb', 0.16);
      g.fillRect(x, y + 1, nw, ROW_H - 2);
    }
    for (const n of pattern) {
      const x = xAt(n.beat), y = yTop(n.midi), nw = Math.max(2, n.len * pxPerBeat);
      if (x + nw < GUTTER || x > w || y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = `hsl(42 75% ${32 + Math.round((n.vel ?? 0.8) * 38)}%)`;
      g.fillRect(x, y + 1, nw, ROW_H - 2);
      g.strokeStyle = n === selected ? themeColor('--ed-pr-note-sel') : themeColor('--ed-pr-note-stroke'); g.lineWidth = n === selected ? 2 : 1;
      g.strokeRect(x + 0.5, y + 1.5, nw - 1, ROW_H - 3);
    }
    g.restore();

    // ruler
    g.save(); g.beginPath(); g.rect(GUTTER, MINI, w - GUTTER, RULER); g.clip();
    g.fillStyle = themeColor('--ed-pr-row-black'); g.fillRect(GUTTER, MINI, w - GUTTER, RULER);
    g.font = '10px monospace'; g.textBaseline = 'middle';
    for (let bar = 0; bar < (song.bars ?? 4); bar++) {
      const x = xAt(bar * bpb);
      g.fillStyle = themeColor('--ed-pr-label'); g.fillRect(Math.floor(x), MINI, 1, RULER);
      g.fillStyle = themeColor('--ed-pr-barnum'); g.fillText(String(bar + 1), x + 4, MINI + RULER / 2);
    }
    g.restore();

    // piano-key gutter
    g.save(); g.beginPath(); g.rect(0, TOP, GUTTER, mainH()); g.clip();
    g.fillStyle = themeColor('--ed-pr-gutter-bg'); g.fillRect(0, TOP, GUTTER, mainH());
    for (let m = PITCH_MIN; m <= PITCH_MAX; m++) {
      const y = yTop(m); if (y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = BLACK.has(((m % 12) + 12) % 12) ? themeColor('--ed-pr-keylabel-bg') : themeColor('--ed-pr-keylabel');
      g.fillRect(0, y, GUTTER - 1, ROW_H - 0.5);
      if (m % 12 === 0) { g.fillStyle = themeColor('--ed-pr-label'); g.font = '9px monospace'; g.fillText('C' + (Math.floor(m / 12) - 1), 3, y + ROW_H / 2); }
    }
    g.restore();

    // velocity lane
    const vy = TOP + mainH();
    g.fillStyle = themeColor('--ed-pr-gutter-bg'); g.fillRect(0, vy, w, VEL_H);
    g.strokeStyle = themeColor('--ed-border-warm2'); g.beginPath(); g.moveTo(0, vy + 0.5); g.lineTo(w, vy + 0.5); g.stroke();
    g.fillStyle = themeColor('--ed-muted'); g.font = '9px monospace'; g.textBaseline = 'top'; g.fillText('velocity — drag here, or Alt-drag a note', GUTTER + 4, vy + 3);
    g.save(); g.beginPath(); g.rect(GUTTER, vy, w - GUTTER, VEL_H); g.clip();
    for (const n of pattern) {
      const x = xAt(n.beat); if (x < GUTTER || x > w) continue;
      const barH = (VEL_H - 12) * (n.vel ?? 0.8);
      g.fillStyle = n === selected ? themeColor('--ed-pr-note-sel') : themeColor('--ed-me-accent');
      g.fillRect(x, vy + (VEL_H - 6) - barH, Math.max(2, Math.min(6, pxPerBeat * 0.4)), barH);
    }
    g.restore();
    staticDirty = false;
  }

  function paint() {
    if (staticDirty) renderStatic();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(buf, 0, 0); ctx.restore();
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    const ph = getPhase();
    // minimap playhead (always shows global position, even when off-screen in the grid)
    if (ph != null) {
      const mx = miniX(ph * lb());
      ctx.strokeStyle = themeColor('--ed-pr-playhead'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, MINI); ctx.stroke();
      // grid playhead (clipped to the visible window)
      const x = xAt(ph * lb());
      if (x >= GUTTER && x <= cssW()) { ctx.strokeStyle = themeColor('--ed-pr-playhead'); ctx.beginPath(); ctx.moveTo(x, MINI); ctx.lineTo(x, TOP + mainH() + VEL_H); ctx.stroke(); }
    }
  }

  function draw() { staticDirty = true; paint(); }

  // ── Hit-testing + interaction ──
  function noteAt(x, y) {
    for (let i = pattern.length - 1; i >= 0; i--) {
      const n = pattern[i], nx = xAt(n.beat), ny = yTop(n.midi), nw = Math.max(2, n.len * pxPerBeat);
      if (x >= nx && x <= nx + nw && y >= ny && y <= ny + ROW_H) return n;
    }
    return null;
  }
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function nearestByX(x) { let best = null, bd = Infinity; for (const n of pattern) { const d = Math.abs(xAt(n.beat) - x); if (d < bd && d < 16) { bd = d; best = n; } } return best; }
  function applyVel(n, y) { const vy = TOP + mainH(); setVelocity(n, (vy + (VEL_H - 6) - y) / (VEL_H - 12)); }
  const arm = () => { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); };

  function scrollToMiniBeat(x) { scrollX = miniBeat(x) * pxPerBeat - (cssW() - GUTTER) / 2; clampX(); draw(); }

  function onDown(e) {
    if (e.button === 2) return;
    const { x, y } = pos(e);
    if (y < MINI) { drag = { mode: 'miniseek', phase: clamp01(miniBeat(x) / lb()) }; scrollToMiniBeat(x); onSeek(drag.phase, false); arm(); return; } // minimap → move playhead + follow
    if (y < TOP) { drag = { mode: 'seek', phase: clamp01(beatAt(x) / lb()) }; onSeek(drag.phase, false); arm(); return; } // ruler → move playhead
    if (x < GUTTER) { if (y <= TOP + mainH()) previewNote(midiAt(y)); return; }             // piano keys → audition
    gestureDirtied = false;
    const vy = TOP + mainH();
    if (y >= vy) { const n = nearestByX(x); if (n) { selected = n; drag = { mode: 'vel', note: n }; applyVel(n, y); gestureDirtied = true; onEdit(pattern); draw(); arm(); } return; }

    const hit = noteAt(x, y);
    const phx = playheadX();
    if (!hit && phx != null && Math.abs(x - phx) <= 3) { drag = { mode: 'seek', phase: clamp01(beatAt(x) / lb()) }; onSeek(drag.phase, false); arm(); return; } // grab the playhead
    if (hit) {
      selected = hit;
      if (e.altKey) { drag = { mode: 'velnote', note: hit, startY: y, startVel: hit.vel ?? 0.8 }; }
      else { const nx = xAt(hit.beat), nw = Math.max(2, hit.len * pxPerBeat); if (x > nx + nw - EDGE) drag = { mode: 'resize', note: hit }; else { drag = { mode: 'move', note: hit, grabBeats: beatAt(x) - hit.beat }; previewNote(hit.midi); } }
    } else {
      const n = addNote(pattern, { beat: beatAt(x), midi: midiAt(y), len: song.grid || 0.25 }, opts());
      selected = n; drag = { mode: 'draw', note: n }; gestureDirtied = true; previewNote(n.midi); onEdit(pattern);
    }
    draw(); arm();
  }

  function onMove(e) {
    if (!drag) return;
    const { x, y } = pos(e); const n = drag.note;
    if (drag.mode === 'miniseek') { drag.phase = clamp01(miniBeat(x) / lb()); scrollToMiniBeat(x); onSeek(drag.phase, false); return; }
    if (drag.mode === 'seek') { drag.phase = clamp01(beatAt(x) / lb()); onSeek(drag.phase, false); return; }
    if (drag.mode === 'move') { const pm = n.midi; moveNote(pattern, n, (beatAt(x) - drag.grabBeats) - n.beat, midiAt(y) - n.midi, opts()); if (n.midi !== pm) previewNote(n.midi); }
    else if (drag.mode === 'resize' || drag.mode === 'draw') { resizeNote(n, beatAt(x) - n.beat - n.len, opts()); }
    else if (drag.mode === 'vel') { applyVel(n, y); }
    else if (drag.mode === 'velnote') { setVelocity(n, drag.startVel + (drag.startY - y) / 120); }
    gestureDirtied = true;
    onEdit(pattern); draw();
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (drag?.mode === 'seek' || drag?.mode === 'miniseek') { onSeek(drag.phase, true); drag = null; return; }
    if (drag) { drag = null; if (gestureDirtied) { onEdit(pattern); onEditCommit(); } draw(); }
  }

  function onContext(e) { e.preventDefault(); const { x, y } = pos(e); const n = noteAt(x, y); if (n) { deleteNote(pattern, n); if (selected === n) selected = null; onEdit(pattern); onEditCommit(); draw(); } }

  function onWheel(e) {
    e.preventDefault();
    const { x } = pos(e);
    if (e.ctrlKey || e.metaKey) { const under = beatAt(x); zoom = Math.max(1, Math.min(16, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); recomputePx(); scrollX = under * pxPerBeat - (x - GUTTER); clampX(); draw(); }
    else if (e.shiftKey) { scrollX += e.deltaY; clampX(); draw(); }
    else { scrollY += e.deltaY; clampScroll(); draw(); }
  }

  function onKey(e) {
    if (!wrap.offsetParent || isModalOpen()) return;
    if (/^(input|textarea|select)$/i.test(e.target?.tagName || '')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteNote(pattern, selected); selected = null; onEdit(pattern); onEditCommit(); draw(); }
  }

  // Hover cursor by region: the minimap/ruler + the playhead are drag-to-seek (↔); a note
  // body moves, its right edge resizes; the keys preview; the velocity lane drags vertically.
  function onHover(e) {
    if (drag) return;
    const { x, y } = pos(e);
    let cur = 'crosshair';
    if (y < TOP) cur = 'ew-resize';
    else if (y <= TOP + mainH()) {
      const phx = playheadX();
      if (phx != null && Math.abs(x - phx) <= 3) cur = 'ew-resize';
      else if (x < GUTTER) cur = 'pointer';
      else { const n = noteAt(x, y); if (n) { const nw = Math.max(2, n.len * pxPerBeat); cur = (x > xAt(n.beat) + nw - EDGE) ? 'ew-resize' : 'move'; } }
    } else cur = 'ns-resize';
    if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onHover);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => resize());
  ro.observe(wrap);

  function centerOnPattern() {
    const mids = pattern.map(n => n.midi);
    const center = mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : 60;
    scrollY = (PITCH_MAX - center) * ROW_H - mainH() / 2; clampScroll();
  }
  function loop() { raf = requestAnimationFrame(loop); if (playing) paint(); }
  requestAnimationFrame(resize);

  const _themeUnsub = onThemeChange(draw);

  return {
    el: wrap,
    setPattern(notes, songObj) { pattern = notes || []; if (songObj) song = songObj; selected = null; recomputePx(); clampX(); centerOnPattern(); draw(); },
    setSong(songObj) { song = songObj; recomputePx(); clampX(); clampScroll(); draw(); },
    setRepeat(on) { const v = !!on; if (v !== repeat) { repeat = v; draw(); } },
    setPlaying(on) { playing = on; if (on && !raf) loop(); if (!on && raf) { cancelAnimationFrame(raf); raf = null; paint(); } else if (!on) paint(); },
    redraw: draw,
    destroy() { if (raf) cancelAnimationFrame(raf); ro.disconnect(); _themeUnsub(); window.removeEventListener('keydown', onKey); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); wrap.remove(); },
  };
}

const clamp01 = (v) => Math.max(0, Math.min(0.9999, v));
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function injectStyle() {
  if (document.getElementById('pr-style')) return;
  const s = document.createElement('style'); s.id = 'pr-style';
  s.textContent = `
  .pr-wrap{position:relative;width:100%;height:100%;min-height:260px;background:var(--ed-pr-bg);border:1px solid var(--ed-border-warm2);border-radius:6px;overflow:hidden}
  .pr-canvas{display:block;cursor:crosshair}
  `;
  document.head.appendChild(s);
}
