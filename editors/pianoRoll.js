// editors/pianoRoll.js
// A self-contained canvas piano-roll for editing one stem's note pattern (beats), generic and
// game-agnostic. Layout top→bottom: a minimap (whole-loop overview with the visible window +
// global playhead), a bar ruler (drag to move the playhead), the pitch×time grid, and a velocity
// lane. Draw notes by dragging empty grid, move/resize by dragging a note, set velocity in the
// lane or by Alt-dragging a note, delete with right-click or Delete, click the piano keys to
// audition a pitch, Ctrl+wheel to zoom (Shift+wheel pans, wheel scrolls pitch), drag the minimap
// to scroll. The static layers are cached to an offscreen canvas so the playhead loop only blits +
// draws lines. Note math goes through editors/midiModel.js; the host owns the notes array +
// persistence (`onEdit`), auditions via `previewNote`, and seeks playback via `onSeek`.
import {
  addNote, moveNote, resizeNote, deleteNote, setVelocity, loopBeats, PITCH_MIN, PITCH_MAX,
} from './midiModel.js';
import { isModalOpen } from './editorShared.js';

const GUTTER = 44;  // piano-key gutter width (px)
const MINI = 16;    // top minimap height
const RULER = 22;   // bar/beat ruler height (below the minimap)
const TOP = MINI + RULER; // grid top offset
const VEL_H = 56;   // bottom velocity lane height
const ROW_H = 12;   // pitch row height
const EDGE = 6;     // right-edge resize grab zone (px)
const BLACK = new Set([1, 3, 6, 8, 10]); // semitones that are black keys

export function createPianoRoll(container, { onEdit = () => {}, getPhase = () => null, previewNote = () => {}, onSeek = () => {} } = {}) {
  let pattern = [];
  let song = { bpm: 120, bars: 4, beatsPerBar: 4, grid: 0.25 };
  let zoom = 1, pxPerBeat = 40, scrollX = 0, scrollY = 0;
  let playing = false, selected = null, drag = null, raf = null, staticDirty = true, scrubPhase = null;

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
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0e0a05'; g.fillRect(0, 0, w, h);

    // minimap (whole-loop overview)
    g.fillStyle = '#080502'; g.fillRect(0, 0, w, MINI);
    g.fillStyle = '#5a4a30'; g.font = '8px monospace'; g.textBaseline = 'middle'; g.fillText('map', 6, MINI / 2);
    for (const n of pattern) { g.fillStyle = '#6b5a36'; g.fillRect(miniX(n.beat), 3, 1.5, MINI - 6); } // note density
    // visible-window box
    const vx0 = miniX(scrollX / pxPerBeat), vx1 = miniX((scrollX + (w - GUTTER)) / pxPerBeat);
    g.strokeStyle = '#c9a227'; g.lineWidth = 1; g.strokeRect(vx0 + 0.5, 1.5, Math.max(2, vx1 - vx0) - 1, MINI - 3);
    g.fillStyle = 'rgba(201,162,39,0.12)'; g.fillRect(vx0, 1, Math.max(2, vx1 - vx0), MINI - 2);

    // pitch rows
    g.save(); g.beginPath(); g.rect(GUTTER, TOP, w - GUTTER, mainH()); g.clip();
    for (let m = PITCH_MIN; m <= PITCH_MAX; m++) {
      const y = yTop(m);
      if (y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = BLACK.has(((m % 12) + 12) % 12) ? '#120d07' : '#17110a';
      g.fillRect(GUTTER, y, w - GUTTER, ROW_H);
      g.strokeStyle = '#241a0e'; g.lineWidth = 1; g.beginPath(); g.moveTo(GUTTER, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    }
    const gr = song.grid > 0 ? song.grid : 0.25, bpb = song.beatsPerBar ?? 4;
    for (let b = 0; b <= lb() + 1e-6; b += gr) {
      const x = xAt(b); if (x < GUTTER - 1 || x > w) continue;
      g.strokeStyle = Math.abs(b % bpb) < 1e-6 ? '#5a4a30' : Math.abs(b % 1) < 1e-6 ? '#3a2f1c' : '#241a0e';
      g.lineWidth = 1; g.beginPath(); g.moveTo(Math.floor(x) + 0.5, TOP); g.lineTo(Math.floor(x) + 0.5, TOP + mainH()); g.stroke();
    }
    for (const n of pattern) {
      const x = xAt(n.beat), y = yTop(n.midi), nw = Math.max(2, n.len * pxPerBeat);
      if (x + nw < GUTTER || x > w || y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = `hsl(42 75% ${32 + Math.round((n.vel ?? 0.8) * 38)}%)`;
      g.fillRect(x, y + 1, nw, ROW_H - 2);
      g.strokeStyle = n === selected ? '#f4e2a0' : '#1a1206'; g.lineWidth = n === selected ? 2 : 1;
      g.strokeRect(x + 0.5, y + 1.5, nw - 1, ROW_H - 3);
    }
    g.restore();

    // ruler
    g.save(); g.beginPath(); g.rect(GUTTER, MINI, w - GUTTER, RULER); g.clip();
    g.fillStyle = '#120d07'; g.fillRect(GUTTER, MINI, w - GUTTER, RULER);
    g.font = '10px monospace'; g.textBaseline = 'middle';
    for (let bar = 0; bar < (song.bars ?? 4); bar++) {
      const x = xAt(bar * bpb);
      g.fillStyle = '#5a4a30'; g.fillRect(Math.floor(x), MINI, 1, RULER);
      g.fillStyle = '#b59a64'; g.fillText(String(bar + 1), x + 4, MINI + RULER / 2);
    }
    g.restore();

    // piano-key gutter
    g.save(); g.beginPath(); g.rect(0, TOP, GUTTER, mainH()); g.clip();
    g.fillStyle = '#0a0703'; g.fillRect(0, TOP, GUTTER, mainH());
    for (let m = PITCH_MIN; m <= PITCH_MAX; m++) {
      const y = yTop(m); if (y > TOP + mainH() || y + ROW_H < TOP) continue;
      g.fillStyle = BLACK.has(((m % 12) + 12) % 12) ? '#1a130a' : '#cdbb8e';
      g.fillRect(0, y, GUTTER - 1, ROW_H - 0.5);
      if (m % 12 === 0) { g.fillStyle = '#5a4a30'; g.font = '9px monospace'; g.fillText('C' + (Math.floor(m / 12) - 1), 3, y + ROW_H / 2); }
    }
    g.restore();

    // velocity lane
    const vy = TOP + mainH();
    g.fillStyle = '#0a0703'; g.fillRect(0, vy, w, VEL_H);
    g.strokeStyle = '#4a3c24'; g.beginPath(); g.moveTo(0, vy + 0.5); g.lineTo(w, vy + 0.5); g.stroke();
    g.fillStyle = '#7a6a4a'; g.font = '9px monospace'; g.textBaseline = 'top'; g.fillText('velocity — drag here, or Alt-drag a note', GUTTER + 4, vy + 3);
    g.save(); g.beginPath(); g.rect(GUTTER, vy, w - GUTTER, VEL_H); g.clip();
    for (const n of pattern) {
      const x = xAt(n.beat); if (x < GUTTER || x > w) continue;
      const barH = (VEL_H - 12) * (n.vel ?? 0.8);
      g.fillStyle = n === selected ? '#f4e2a0' : '#c9a227';
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
      ctx.strokeStyle = '#e07b3a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, MINI); ctx.stroke();
      // grid playhead (clipped to the visible window)
      const x = xAt(ph * lb());
      if (x >= GUTTER && x <= cssW()) { ctx.strokeStyle = '#e07b3a'; ctx.beginPath(); ctx.moveTo(x, MINI); ctx.lineTo(x, TOP + mainH() + VEL_H); ctx.stroke(); }
    }
    // scrub marker while dragging the ruler
    if (scrubPhase != null) {
      const sx = xAt(scrubPhase * lb());
      if (sx >= GUTTER && sx <= cssW()) { ctx.strokeStyle = '#f4e2a0'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, MINI); ctx.lineTo(sx, TOP + mainH()); ctx.stroke(); ctx.setLineDash([]); }
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
    if (y < MINI) { drag = { mode: 'mini' }; scrollToMiniBeat(x); arm(); return; }         // minimap → scroll view
    if (y < TOP) { drag = { mode: 'seek' }; scrubPhase = clamp01(beatAt(x) / lb()); onSeek(scrubPhase); draw(); arm(); return; } // ruler → seek
    if (x < GUTTER) { if (y <= TOP + mainH()) previewNote(midiAt(y)); return; }             // piano keys → audition
    const vy = TOP + mainH();
    if (y >= vy) { const n = nearestByX(x); if (n) { selected = n; drag = { mode: 'vel', note: n }; applyVel(n, y); onEdit(pattern); draw(); arm(); } return; }

    const hit = noteAt(x, y);
    if (hit) {
      selected = hit;
      if (e.altKey) { drag = { mode: 'velnote', note: hit, startY: y, startVel: hit.vel ?? 0.8 }; }
      else { const nx = xAt(hit.beat), nw = Math.max(2, hit.len * pxPerBeat); if (x > nx + nw - EDGE) drag = { mode: 'resize', note: hit }; else { drag = { mode: 'move', note: hit, grabBeats: beatAt(x) - hit.beat }; previewNote(hit.midi); } }
    } else {
      const n = addNote(pattern, { beat: beatAt(x), midi: midiAt(y), len: song.grid || 0.25 }, opts());
      selected = n; drag = { mode: 'draw', note: n }; previewNote(n.midi); onEdit(pattern);
    }
    draw(); arm();
  }

  function onMove(e) {
    if (!drag) return;
    const { x, y } = pos(e); const n = drag.note;
    if (drag.mode === 'mini') { scrollToMiniBeat(x); return; }
    if (drag.mode === 'seek') { scrubPhase = clamp01(beatAt(x) / lb()); draw(); return; }
    if (drag.mode === 'move') { const pm = n.midi; moveNote(pattern, n, (beatAt(x) - drag.grabBeats) - n.beat, midiAt(y) - n.midi, opts()); if (n.midi !== pm) previewNote(n.midi); }
    else if (drag.mode === 'resize' || drag.mode === 'draw') { resizeNote(n, beatAt(x) - n.beat - n.len, opts()); }
    else if (drag.mode === 'vel') { applyVel(n, y); }
    else if (drag.mode === 'velnote') { setVelocity(n, drag.startVel + (drag.startY - y) / 120); }
    onEdit(pattern); draw();
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (drag?.mode === 'seek' && scrubPhase != null) { onSeek(scrubPhase); scrubPhase = null; drag = null; draw(); return; }
    if (drag?.mode === 'mini') { drag = null; return; }
    if (drag) { drag = null; onEdit(pattern); draw(); }
  }

  function onContext(e) { e.preventDefault(); const { x, y } = pos(e); const n = noteAt(x, y); if (n) { deleteNote(pattern, n); if (selected === n) selected = null; onEdit(pattern); draw(); } }

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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteNote(pattern, selected); selected = null; onEdit(pattern); draw(); }
  }

  canvas.addEventListener('mousedown', onDown);
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

  return {
    el: wrap,
    setPattern(notes, songObj) { pattern = notes || []; if (songObj) song = songObj; selected = null; recomputePx(); clampX(); centerOnPattern(); draw(); },
    setSong(songObj) { song = songObj; recomputePx(); clampX(); clampScroll(); draw(); },
    setPlaying(on) { playing = on; if (on && !raf) loop(); if (!on && raf) { cancelAnimationFrame(raf); raf = null; paint(); } else if (!on) paint(); },
    redraw: draw,
    destroy() { if (raf) cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('keydown', onKey); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); wrap.remove(); },
  };
}

const clamp01 = (v) => Math.max(0, Math.min(0.9999, v));
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function injectStyle() {
  if (document.getElementById('pr-style')) return;
  const s = document.createElement('style'); s.id = 'pr-style';
  s.textContent = `
  .pr-wrap{position:relative;width:100%;height:100%;min-height:260px;background:#0e0a05;border:1px solid #4a3c24;border-radius:6px;overflow:hidden}
  .pr-canvas{display:block;cursor:crosshair}
  `;
  document.head.appendChild(s);
}
