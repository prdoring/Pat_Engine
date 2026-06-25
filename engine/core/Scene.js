// Base Scene — documents the interface the Game router expects. Subclass and
// override what you need; every method has a safe no-op default. Scenes own all
// their own state; shared services are injected (commonly via the constructor).

export class Scene {
  /** Called when the Game switches to this scene. `data` is passed from setScene. */
  enter(_data) {}
  /** Called when the Game switches away from this scene. */
  exit() {}
  /** Per-frame logic (interpolation, input application, effect updates). */
  update(_now) {}
  /** Per-frame drawing. */
  render(_now) {}

  onKeydown(_e) {}
  onKeyup(_e) {}
  onMousedown(_x, _y) {}
  onMousemove(_x, _y) {}
  onMouseup(_x, _y) {}
  /** Scroll wheel. deltaY < 0 = scroll up (zoom in by convention). */
  onWheel(_deltaY, _x, _y) {}
}
