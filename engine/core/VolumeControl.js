// Volume widget overlay (speaker button + slider, top-right). Extracted from
// Sub Game's main.js. Game-agnostic: drives any object exposing isMuted/getVolume/
// setVolume/toggleMute (e.g. engine SoundManager). The Game loop draws it each
// frame and routes mouse events to it before the active scene.

export class VolumeControl {
  constructor(sound, canvas) {
    this.sound = sound;
    this.canvas = canvas;
    this.BTN_SIZE = 22;
    this.SLIDER_W = 80;
    this.SLIDER_H = 6;
    this.PAD = 8;
    this.TOP = 8;
    this.RIGHT_MARGIN = 10;
    this.dragging = false;
    this.hovered = false;
  }

  _getBtnRect() {
    const x = this.canvas.width - this.RIGHT_MARGIN - this.BTN_SIZE;
    return { x, y: this.TOP, w: this.BTN_SIZE, h: this.BTN_SIZE };
  }

  _getSliderRect() {
    const btn = this._getBtnRect();
    const x = btn.x - this.PAD - this.SLIDER_W;
    const y = this.TOP + (this.BTN_SIZE - this.SLIDER_H) / 2;
    return { x, y, w: this.SLIDER_W, h: this.SLIDER_H };
  }

  _hit(mx, my, r) {
    return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
  }

  _setVolumeFromX(mx) {
    const sl = this._getSliderRect();
    const t = Math.max(0, Math.min(1, (mx - sl.x) / sl.w));
    this.sound.setVolume(t);
    if (t > 0 && this.sound.isMuted()) this.sound.toggleMute();
    if (t === 0 && !this.sound.isMuted()) this.sound.toggleMute();
  }

  /** @returns {boolean} true if the event was consumed. */
  onMousedown(mx, my) {
    const btn = this._getBtnRect();
    const sl = this._getSliderRect();
    const sliderHit = { x: sl.x - 4, y: sl.y - 8, w: sl.w + 8, h: sl.h + 16 };
    if (this._hit(mx, my, btn)) { this.sound.toggleMute(); return true; }
    if (this._hit(mx, my, sliderHit)) { this.dragging = true; this._setVolumeFromX(mx); return true; }
    return false;
  }

  onMousemove(mx, my) {
    if (this.dragging) { this._setVolumeFromX(mx); return; }
    const btn = this._getBtnRect();
    const sl = this._getSliderRect();
    const sliderHit = { x: sl.x - 4, y: sl.y - 8, w: sl.w + 8, h: sl.h + 16 };
    this.hovered = this._hit(mx, my, btn) || this._hit(mx, my, sliderHit);
  }

  onMouseup() { this.dragging = false; }

  draw(ctx) {
    const muted = this.sound.isMuted();
    const vol = this.sound.getVolume();
    const btn = this._getBtnRect();
    const sl = this._getSliderRect();

    ctx.save();

    // Slider track + fill + thumb
    ctx.fillStyle = '#1a1a22';
    ctx.beginPath(); ctx.roundRect(sl.x, sl.y, sl.w, sl.h, 3); ctx.fill();
    const fillW = muted ? 0 : vol * sl.w;
    if (fillW > 0) {
      ctx.fillStyle = '#7cc6a0';
      ctx.beginPath(); ctx.roundRect(sl.x, sl.y, fillW, sl.h, 3); ctx.fill();
    }
    ctx.fillStyle = muted ? '#444' : '#7cc6a0';
    ctx.beginPath(); ctx.arc(sl.x + fillW, sl.y + sl.h / 2, 5, 0, Math.PI * 2); ctx.fill();

    // Speaker icon
    const cx = btn.x + btn.w / 2;
    const cy = btn.y + btn.h / 2;
    const s = btn.w * 0.35;
    ctx.strokeStyle = muted ? '#c0584a' : (this.hovered ? '#cfe6d8' : '#7a8a82');
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.3, cy - s * 0.35); ctx.lineTo(cx - s * 0.3, cy + s * 0.35);
    ctx.lineTo(cx - s * 0.8, cy + s * 0.35); ctx.lineTo(cx - s * 0.8, cy - s * 0.35);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.3, cy - s * 0.35); ctx.lineTo(cx + s * 0.3, cy - s * 0.8);
    ctx.lineTo(cx + s * 0.3, cy + s * 0.8); ctx.lineTo(cx - s * 0.3, cy + s * 0.35);
    ctx.closePath(); ctx.fill();

    if (muted) {
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.5, cy - s * 0.5); ctx.lineTo(cx + s * 1.0, cy + s * 0.5);
      ctx.moveTo(cx + s * 1.0, cy - s * 0.5); ctx.lineTo(cx + s * 0.5, cy + s * 0.5);
      ctx.stroke();
    } else {
      ctx.lineWidth = 1.2;
      if (vol > 0.01) { ctx.beginPath(); ctx.arc(cx + s * 0.4, cy, s * 0.5, -Math.PI * 0.35, Math.PI * 0.35); ctx.stroke(); }
      if (vol > 0.5)  { ctx.beginPath(); ctx.arc(cx + s * 0.4, cy, s * 0.85, -Math.PI * 0.35, Math.PI * 0.35); ctx.stroke(); }
    }

    ctx.restore();
  }
}
