// --- Constants (tunable) ---

export const COLLISION = {
  RESTITUTION: 0.7,        // bounce dampening (1.0 = perfect elastic)
};

// --- Physical Collision ---

/**
 * Check if two circles overlap.
 * Returns { overlap, nx, ny } (normal from a→b) or null if no overlap.
 */
export function getCircleOverlap(ax, ay, ar, bx, by, br) {
  const dx = bx - ax;
  const dy = by - ay;
  const distSq = dx * dx + dy * dy;
  const minDist = ar + br;

  if (distSq >= minDist * minDist) return null;

  const dist = Math.sqrt(distSq);
  const overlap = minDist - dist;

  // Normal from a to b (handle zero-distance edge case)
  const nx = dist > 0 ? dx / dist : 1;
  const ny = dist > 0 ? dy / dist : 0;

  return { overlap, nx, ny, dist };
}

/**
 * Resolve elastic collision between two circular bodies.
 * Mutates shipA and shipB (objects with { x, y, vx, vy }).
 * Returns { impactSpeed } or null if no overlap.
 */
export function resolveElasticCollision(shipA, radiusA, shipB, radiusB, restitution = COLLISION.RESTITUTION) {
  const info = getCircleOverlap(shipA.x, shipA.y, radiusA, shipB.x, shipB.y, radiusB);
  if (!info) return null;

  const { overlap, nx, ny } = info;

  // Separate the two objects (push apart equally, +0.5 to prevent sticking)
  const sep = overlap / 2 + 0.5;
  shipA.x -= nx * sep;
  shipA.y -= ny * sep;
  shipB.x += nx * sep;
  shipB.y += ny * sep;

  // Relative velocity along collision normal
  const dvx = shipA.vx - shipB.vx;
  const dvy = shipA.vy - shipB.vy;
  const relVelNormal = dvx * nx + dvy * ny;

  // Only resolve if objects are approaching
  if (relVelNormal <= 0) return { impactSpeed: 0 };

  // Equal-mass collision with restitution
  const impulse = relVelNormal * (1 + restitution) / 2;
  shipA.vx -= impulse * nx;
  shipA.vy -= impulse * ny;
  shipB.vx += impulse * nx;
  shipB.vy += impulse * ny;

  return { impactSpeed: relVelNormal };
}

/**
 * Resolve collision between a moving body and a static (infinite mass) circle.
 * Only the moving body is affected — pushed out and velocity reflected.
 * Returns { impactSpeed } or null if no overlap.
 */
export function resolveStaticCollision(ship, shipRadius, staticObj, staticRadius, restitution) {
  const info = getCircleOverlap(ship.x, ship.y, shipRadius, staticObj.x, staticObj.y, staticRadius);
  if (!info) return null;

  const { overlap, nx, ny } = info;

  // Push ship entirely out of the static object
  ship.x -= nx * (overlap + 0.5);
  ship.y -= ny * (overlap + 0.5);

  // Velocity component along collision normal
  const velNormal = ship.vx * nx + ship.vy * ny;

  // Only resolve if approaching
  if (velNormal <= 0) return { impactSpeed: 0 };

  // Reflect normal component with restitution, keep tangential
  ship.vx -= (1 + restitution) * velNormal * nx;
  ship.vy -= (1 + restitution) * velNormal * ny;

  return { impactSpeed: velNormal };
}

// --- Circle vs OBB (Oriented Bounding Box) ---

/**
 * Test circle vs. a pre-computed OBB.
 * Returns { overlap, nx, ny } (normal pointing FROM obb surface TOWARD circle)
 * or null if no overlap.
 */
export function circleVsOBB(px, py, pr, obb) {
  const dx = px - obb.cx;
  const dy = py - obb.cy;

  // Project onto OBB local axes
  const projX = dx * obb.axisXx + dy * obb.axisXy;
  const projY = dx * obb.axisYx + dy * obb.axisYy;

  // Clamp to OBB extents → closest point in local space
  const clampX = Math.max(-obb.hw, Math.min(obb.hw, projX));
  const clampY = Math.max(-obb.hh, Math.min(obb.hh, projY));

  // Closest point in world space
  const closestX = obb.cx + clampX * obb.axisXx + clampY * obb.axisYx;
  const closestY = obb.cy + clampX * obb.axisXy + clampY * obb.axisYy;

  const sepX = px - closestX;
  const sepY = py - closestY;
  const distSq = sepX * sepX + sepY * sepY;

  if (distSq >= pr * pr) return null;

  const dist = Math.sqrt(distSq);
  const overlap = pr - dist;

  let nx, ny;
  if (dist > 0.0001) {
    nx = sepX / dist;
    ny = sepY / dist;
  } else {
    // Circle center inside OBB — push along shortest escape axis
    const overlapX = obb.hw - Math.abs(projX);
    const overlapY = obb.hh - Math.abs(projY);
    if (overlapX < overlapY) {
      const sign = projX >= 0 ? 1 : -1;
      nx = sign * obb.axisXx;
      ny = sign * obb.axisXy;
    } else {
      const sign = projY >= 0 ? 1 : -1;
      nx = sign * obb.axisYx;
      ny = sign * obb.axisYy;
    }
  }

  return { overlap, nx, ny };
}

/**
 * Resolve collision between a moving circle and a static OBB.
 * Pushes ship out and reflects velocity. Returns { impactSpeed } or null.
 */
export function resolveStaticOBBCollision(ship, shipRadius, obb, restitution) {
  const info = circleVsOBB(ship.x, ship.y, shipRadius, obb);
  if (!info) return null;

  const { overlap, nx, ny } = info;

  // Push ship out (normal points away from OBB surface)
  ship.x += nx * (overlap + 0.5);
  ship.y += ny * (overlap + 0.5);

  // Velocity along outward normal (negative = approaching)
  const velNormal = ship.vx * nx + ship.vy * ny;
  if (velNormal >= 0) return { impactSpeed: 0 };

  ship.vx -= (1 + restitution) * velNormal * nx;
  ship.vy -= (1 + restitution) * velNormal * ny;

  return { impactSpeed: Math.abs(velNormal) };
}

/**
 * Check if a circle overlaps any OBB in a list. Returns true on first hit.
 */
export function circleOverlapsAnyOBB(px, py, pr, obbs) {
  for (const obb of obbs) {
    if (circleVsOBB(px, py, pr, obb) !== null) return true;
  }
  return false;
}
