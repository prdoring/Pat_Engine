import { MAP_WIDTH, MAP_HEIGHT } from './constants.js';

/**
 * Apply one tick of physics to a ship entity, mutating it in place.
 * @param {object} ship - { x, y, vx, vy, angle }
 * @param {object} input - { thrust, rotateLeft, rotateRight }
 * @param {number} dt - delta time in seconds
 * @param {object} stats - { thrustForce, maxSpeed, rotationSpeed, forwardDrag, lateralDrag } from propulsion module
 * @param {object} [bounds] - { width, height } map bounds (defaults to MAP_WIDTH/MAP_HEIGHT)
 */
export function applyShipPhysics(ship, input, dt, stats, bounds) {
  // Rotation
  if (input.rotateLeft) ship.angle -= stats.rotationSpeed * dt;
  if (input.rotateRight) ship.angle += stats.rotationSpeed * dt;

  // Normalize angle to [0, 2*PI)
  ship.angle = ((ship.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  // Thrust
  if (input.thrust) {
    ship.vx += Math.cos(ship.angle) * stats.thrustForce * dt;
    ship.vy += Math.sin(ship.angle) * stats.thrustForce * dt;
  }

  // Speed cap
  const speed = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
  if (speed > stats.maxSpeed) {
    const scale = stats.maxSpeed / speed;
    ship.vx *= scale;
    ship.vy *= scale;
  }

  // Anisotropic drag — decompose velocity into forward/lateral components
  const cosA = Math.cos(ship.angle);
  const sinA = Math.sin(ship.angle);

  // Project velocity onto ship's forward axis
  const forwardSpeed = ship.vx * cosA + ship.vy * sinA;
  // Project velocity onto ship's lateral axis (perpendicular)
  const lateralSpeed = -ship.vx * sinA + ship.vy * cosA;

  // Apply different drag rates (high lateral drag = sub steers into heading).
  // Drag is exponential per-second referenced to 60 Hz so behavior is
  // frame-rate independent (identical at 60 fps, stable at 144 fps).
  const fDrag = Math.pow(stats.forwardDrag, dt * 60);
  const lDrag = Math.pow(stats.lateralDrag, dt * 60);
  const draggedForward = forwardSpeed * fDrag;
  const draggedLateral = lateralSpeed * lDrag;

  // Recombine into world-space velocity
  ship.vx = draggedForward * cosA - draggedLateral * sinA;
  ship.vy = draggedForward * sinA + draggedLateral * cosA;

  // Position update
  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;

  // Clamp to map boundaries
  const mw = bounds ? bounds.width : MAP_WIDTH;
  const mh = bounds ? bounds.height : MAP_HEIGHT;
  if (ship.x < 0) { ship.x = 0; ship.vx = 0; }
  if (ship.x >= mw) { ship.x = mw; ship.vx = 0; }
  if (ship.y < 0) { ship.y = 0; ship.vy = 0; }
  if (ship.y >= mh) { ship.y = mh; ship.vy = 0; }
}
