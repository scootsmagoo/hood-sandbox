/**
 * Soft lock-on: which threat near the crosshair the aim leans toward, and by how much. Pure
 * numbers in and out. The cone and the pull come from the device's assist strength (`lockOnFor`):
 * a gamepad or a finger gets a wide cone and a strong pull, a mouse a slight magnetism.
 */
import type { EntityId } from '../../../shared/entities';
import { DEG, type Vec3 } from '../../../shared/math';

export interface LockCandidate {
  id: EntityId;
  /** The point to aim at (the chest). */
  x: number;
  y: number;
  z: number;
  /** 0 to 1: how much of a threat (an officer, someone armed or fighting). It wins ties. */
  threat?: number;
}

export interface LockPick {
  id: EntityId;
  /** Angle between the view ray and the target, degrees. */
  angleDeg: number;
  /** The target's point. */
  x: number;
  y: number;
  z: number;
}

export interface LockOptions {
  coneDeg: number;
  rangeM: number;
  /** The target locked last tick, if any: it stays chosen while it is within `stickyMult` times the cone. */
  current?: EntityId;
  stickyMult?: number;
}

/**
 * The best target in the cone around the view ray `dir` (a unit vector) from `origin`. Closer to the
 * centre wins, then closer in range, with a bonus for threats. Null when nobody is in the cone.
 */
export function pickLockTarget(origin: Vec3, dir: Vec3, cands: Iterable<LockCandidate>, o: LockOptions): LockPick | null {
  let best: LockPick | null = null;
  let bestScore = Infinity;
  const sticky = o.stickyMult ?? 1.4;
  for (const c of cands) {
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;
    const dz = c.z - origin.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > o.rangeM || d < 0.4) continue;
    const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    if (dot <= 0) continue;
    const ang = Math.acos(Math.min(1, dot)) / DEG;
    const cone = o.coneDeg * (c.id === o.current ? sticky : 1);
    if (ang > cone) continue;
    // A target that is already locked is favoured, so the lock does not flicker between two people.
    const score = ang + d * 0.03 - (c.threat ?? 0) * 2.5 - (c.id === o.current ? 1.5 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { id: c.id, angleDeg: ang, x: c.x, y: c.y, z: c.z };
    }
  }
  return best;
}

/**
 * The direction of a shot from `from` once the aim is bent toward a locked target: the player's own
 * aim `dir`, leaning toward the target by `pull` in the middle half of the cone, easing to nothing at its edge.
 */
export function assistDirection(dir: Vec3, from: Vec3, target: LockPick, coneDeg: number, pull: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const tx = target.x - from.x;
  const ty = target.y - from.y;
  const tz = target.z - from.z;
  const tl = Math.hypot(tx, ty, tz) || 1;
  const x = tx / tl;
  const y = ty / tl;
  const z = tz / tl;
  const r = Math.min(1, target.angleDeg / Math.max(1e-6, coneDeg));
  const t = Math.max(0, Math.min(1, (1 - r) / 0.5));
  const w = pull * t * t * (3 - 2 * t);
  const ox = dir.x + (x - dir.x) * w;
  const oy = dir.y + (y - dir.y) * w;
  const oz = dir.z + (z - dir.z) * w;
  const l = Math.hypot(ox, oy, oz) || 1;
  out.x = ox / l;
  out.y = oy / l;
  out.z = oz / l;
  return out;
}
