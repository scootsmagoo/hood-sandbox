/** Small 2D shape helpers for buildings: oriented bounding boxes, ring offsets, point tests. Plan coordinates are (x, z). */
import type { V2 } from '../geo.js';
import { pointInRing, signedArea } from '../geo.js';

/** A rectangle that contains a footprint: centre, unit axis along the long side, and half extents (`L` along the axis, `W` across, L >= W). */
export interface Obb {
  cx: number;
  cz: number;
  /** unit vector along the long side */
  ax: number;
  az: number;
  L: number;
  W: number;
  /** footprint area over the rectangle's area (1 for a rectangle) */
  fill: number;
}

function convexHull(pts: V2[]): V2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: V2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The smallest rectangle (with a side along one of the hull's edges) that contains the ring. */
export function minAreaObb(ring: V2[]): Obb {
  const hull = convexHull(ring);
  let best: Obb | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    if (l < 1e-9) continue;
    const ux = dx / l, uz = dz / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of hull) {
      const u = (q[0] - a[0]) * ux + (q[1] - a[1]) * uz;
      const v = -(q[0] - a[0]) * uz + (q[1] - a[1]) * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const cx = a[0] + ux * cu - uz * cv, cz = a[1] + uz * cu + ux * cv;
      const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
      best = hu >= hv ? { cx, cz, ax: ux, az: uz, L: hu, W: hv, fill: 0 } : { cx, cz, ax: -uz, az: ux, L: hv, W: hu, fill: 0 };
    }
  }
  if (!best) return { cx: ring[0][0], cz: ring[0][1], ax: 1, az: 0, L: 0.5, W: 0.5, fill: 1 };
  best.fill = Math.abs(signedArea(ring)) / Math.max(1e-6, 4 * best.L * best.W);
  return best;
}

/**
 * Moves a ring `inward` m towards the solid, with mitred corners (the mitre capped). The ring must be oriented as
 * `orientRings` leaves it (outer ring counter-clockwise, holes clockwise), which puts the solid on the same side of every edge.
 */
export function insetRing(ring: V2[], inward: number, miterLimit = 2.5): V2[] {
  const n = ring.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i + n - 1) % n], p1 = ring[i], p2 = ring[(i + 1) % n];
    const e0x = p1[0] - p0[0], e0z = p1[1] - p0[1];
    const e1x = p2[0] - p1[0], e1z = p2[1] - p1[1];
    const l0 = Math.hypot(e0x, e0z) || 1, l1 = Math.hypot(e1x, e1z) || 1;
    // the outward normal of an oriented ring is (dz, -dx); the solid side is the other one
    const n0: V2 = [-e0z / l0, e0x / l0];
    const n1: V2 = [-e1z / l1, e1x / l1];
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push([p1[0] + n0[0] * inward, p1[1] + n0[1] * inward]); continue; }
    mx /= ml; mz /= ml;
    const c = mx * n0[0] + mz * n0[1];
    const k = Math.min(miterLimit, 1 / Math.max(c, 1e-3));
    out.push([p1[0] + mx * inward * k, p1[1] + mz * inward * k]);
  }
  return out;
}

/** True when (x, z) is inside the polygon made of `rings` (the first is the outer ring, the others holes). */
export function inPolygon(x: number, z: number, rings: V2[][]): boolean {
  if (!pointInRing(x, z, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, z, rings[i])) return false;
  return true;
}

/** Distance from (x, z) to the nearest edge of the rings. */
export function distToRings(x: number, z: number, rings: V2[][]): number {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, n = r.length; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      const d = Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
      if (d < best) best = d;
    }
  }
  return best;
}

/** A tiny seeded generator (mulberry32) for placements that must not change between bakes. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of a string (FNV-1a). */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
