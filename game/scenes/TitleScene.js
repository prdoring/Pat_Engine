import { Scene } from '/engine/core/Scene.js';
import { drawUnifiedArt } from '/engine/render/ArtInterpreter.js';
import { PALETTE } from '../config.js';

export class TitleScene extends Scene {
  constructor(shared) {
    super();
    this.shared = shared;
  }

  render(now) {
    const { ctx, canvas, art } = this.shared;
    // Logical (CSS-px) size: with HiDPI the backing store is device px (dpr-scaled);
    // clientWidth/Height stay logical and match the dpr-scaled draw space.
    const cx = (canvas.clientWidth || canvas.width) / 2;
    const cy = (canvas.clientHeight || canvas.height) / 2;

    // Emblem (vector art) above the title.
    const logo = art.props.logo;
    if (logo) {
      ctx.save();
      ctx.translate(cx, cy - 70);
      drawUnifiedArt(ctx, 80, '#7cc6a0', logo, 'idle', now);
      ctx.restore();
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.hud;
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText('Critter Garden', cx, cy + 70);
    ctx.fillStyle = PALETTE.hudDim;
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('a Pat_Engine example', cx, cy + 100);
    // Gentle pulse on the prompt.
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now * 0.004);
    ctx.fillStyle = PALETTE.hud;
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillText('click to enter the garden', cx, cy + 150);
    ctx.restore();
  }

  onMousedown() {
    const { game, scenes } = this.shared;
    game.setScene(scenes.garden);
  }
}
