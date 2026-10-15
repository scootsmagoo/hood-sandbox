/**
 * Where a crash hit a car, for the client's dents (`vehicle:damage`'s `at`): the deepest contact of
 * the car's hull this step, in the car's own frame, and the direction the hit pushed the body (the
 * step's velocity change, which points away from what was hit). Without a contact (the car has
 * already bounced clear) the point is where a ray from the hull's centre against that direction
 * leaves the hull's box. Read-only: it changes nothing in the world, so the sim stays deterministic.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { rotateVecInv } from '../../shared/math';
import type { RaycastCar } from './RaycastCar';

/** [x, y, z, dx, dy, dz]: the point (m, rounded to cm) and the unit push (rounded to 0.01), car frame. */
export type ImpactAt = [number, number, number, number, number, number];

const r2 = (v: number) => Math.round(v * 100) / 100;

export function crashPoint(world: RAPIER.World, car: RaycastCar): ImpactAt | undefined {
  const q = car.body.rotation();
  const dv = rotateVecInv(q, car.impactDv.x, car.impactDv.y, car.impactDv.z);
  const len = Math.hypot(dv.x, dv.y, dv.z);
  if (len < 1e-6) return undefined;
  const dx = dv.x / len;
  const dy = dv.y / len;
  const dz = dv.z / len;
  let best: { x: number; y: number; z: number } | null = null;
  let bestDist = Infinity;
  const n = car.body.numColliders();
  for (let i = 0; i < n; i++) {
    const c = car.body.collider(i);
    world.contactPairsWith(c, (other) => {
      world.contactPair(c, other, (m, flipped) => {
        for (let k = 0; k < m.numContacts(); k++) {
          const d = m.contactDist(k);
          if (d >= bestDist) continue;
          const p = flipped ? m.localContactPoint2(k) : m.localContactPoint1(k);
          if (!p) continue;
          bestDist = d;
          best = { x: p.x, y: p.y, z: p.z };
        }
      });
    });
  }
  let p = best as { x: number; y: number; z: number } | null;
  if (!p) {
    // against the push, out to the hull's box
    const c = car.h.chassis;
    const [hx, hy, hz] = c.halfExtents;
    const t = Math.min(dx ? hx / Math.abs(dx) : Infinity, dy ? hy / Math.abs(dy) : Infinity, dz ? hz / Math.abs(dz) : Infinity);
    p = { x: c.offset[0] - dx * t, y: c.offset[1] - dy * t, z: c.offset[2] - dz * t };
  }
  return [r2(p.x), r2(p.y), r2(p.z), r2(dx), r2(dy), r2(dz)];
}
