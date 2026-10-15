import { simplifyRing, signedArea, type V2 } from '../geo.js';

/** Tolerance of the simplification of the footprints the collision mesh is made of, m: a wall may stand this far inside the drawn one. */
export const COLLISION_TOLERANCE = 0.15;

/** The rings of a footprint as the collision mesh has them: outer ring and courtyards, each simplified; a courtyard that collapses is dropped. */
export function collisionRings(rings: V2[][]): V2[][] {
  const out = [simplifyRing(rings[0], COLLISION_TOLERANCE)];
  for (const hole of rings.slice(1)) {
    const h = simplifyRing(hole, COLLISION_TOLERANCE);
    if (h.length >= 3 && Math.abs(signedArea(h)) >= 1) out.push(h);
  }
  return out;
}
