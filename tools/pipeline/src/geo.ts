import proj4 from 'proj4';

export type V2 = [number, number];
export type V3 = [number, number, number];
export interface Rect { minX: number; minZ: number; maxX: number; maxZ: number }

export interface Projector {
  E0: number;
  N0: number;
  /** lon/lat to game x/z (metres, +X east, +Z south) */
  toGame(lon: number, lat: number): V2;
  /** game x/z to lon/lat */
  toLonLat(x: number, z: number): V2;
}

export function createProjector(projDef: string, origin: { lat: number; lon: number }): Projector {
  const fwd = proj4(projDef);
  const [E0, N0] = fwd.forward([origin.lon, origin.lat]);
  return {
    E0,
    N0,
    toGame(lon, lat) {
      const [e, n] = fwd.forward([lon, lat]);
      return [e - E0, -(n - N0)];
    },
    toLonLat(x, z) {
      const [lon, lat] = fwd.inverse([x + E0, -z + N0]);
      return [lon, lat];
    },
  };
}

export function rectContains(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

/** Liang-Barsky. Returns the clipped segment or null. */
export function clipSegment(a: V2, b: V2, r: Rect): [V2, V2] | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minZ, r.maxZ - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dz],
    [a[0] + t1 * dx, a[1] + t1 * dz],
  ];
}

/** Clips a polyline to a rectangle; may return several pieces. */
export function clipPolyline(pts: V2[], r: Rect): V2[][] {
  const out: V2[][] = [];
  let cur: V2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const c = clipSegment(pts[i], pts[i + 1], r);
    if (!c) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const [s, e] = c;
    if (cur.length === 0) cur.push(s);
    else if (Math.hypot(cur[cur.length - 1][0] - s[0], cur[cur.length - 1][1] - s[1]) > 1e-6) {
      if (cur.length > 1) out.push(cur);
      cur = [s];
    }
    cur.push(e);
    if (e[0] !== pts[i + 1][0] || e[1] !== pts[i + 1][1]) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Signed area; positive when the ring runs counter-clockwise in (x, z) plotted with x right, z up. */
export function signedArea(ring: V2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

export function ringCentroid(ring: V2[]): V2 {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}

export function pointInRing(x: number, z: number, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBounds(ring: V2[]): Rect {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

function perpDist(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** Douglas-Peucker on an open polyline. */
export function simplifyLine(pts: V2[], tol: number): V2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let md = 0;
    let mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (mi >= 0 && md > tol) {
      keep[mi] = 1;
      stack.push([s, mi], [mi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplifies a ring given without the closing duplicate point. Keeps at least 3 points. */
export function simplifyRing(ring: V2[], tol: number): V2[] {
  if (ring.length <= 4) return ring.slice();
  // split at the two points farthest apart so the closing seam is not special
  let bi = 0;
  let bd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > bd) {
      bd = d;
      bi = i;
    }
  }
  const a = simplifyLine(ring.slice(0, bi + 1), tol);
  const b = simplifyLine([...ring.slice(bi), ring[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring.slice();
}

/** Inserts points so that no segment is longer than maxLen. */
export function resample(pts: V2[], maxLen: number): V2[] {
  const out: V2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(l / maxLen));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function polylineLength(pts: V2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** Intersection of segments ab and cd, or null. Returns the parameter along ab and cd. */
export function segmentIntersection(a: V2, b: V2, c: V2, d: V2): { x: number; z: number; t: number; u: number } | null {
  const r0 = b[0] - a[0], r1 = b[1] - a[1];
  const s0 = d[0] - c[0], s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const qp0 = c[0] - a[0], qp1 = c[1] - a[1];
  const t = (qp0 * s1 - qp1 * s0) / den;
  const u = (qp0 * r1 - qp1 * r0) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a[0] + t * r0, z: a[1] + t * r1, t, u };
}

function perpDist3(p: V3, a: V3, b: V3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy), p[2] - (a[2] + t * dz));
}

/** Douglas-Peucker in 3D. */
export function simplifyLine3(pts: V3[], tol: number): V3[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let md = 0;
    let mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist3(pts[i], pts[s], pts[e]);
      if (d > md) { md = d; mi = i; }
    }
    if (mi >= 0 && md > tol) {
      keep[mi] = 1;
      stack.push([s, mi], [mi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Clips a polyline that carries one value per point; values are interpolated at the cuts. */
export function clipPolylineWithValues(pts: V2[], vals: number[], r: Rect): { pts: V2[]; vals: number[] }[] {
  const out: { pts: V2[]; vals: number[] }[] = [];
  let cur: { pts: V2[]; vals: number[] } | null = null;
  const flush = () => {
    if (cur && cur.pts.length > 1) out.push(cur);
    cur = null;
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const c = clipSegment(a, b, r);
    if (!c) { flush(); continue; }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t0 = Math.hypot(c[0][0] - a[0], c[0][1] - a[1]) / len;
    const t1 = Math.hypot(c[1][0] - a[0], c[1][1] - a[1]) / len;
    const v0 = vals[i] + (vals[i + 1] - vals[i]) * t0;
    const v1 = vals[i] + (vals[i + 1] - vals[i]) * t1;
    if (cur && t0 > 1e-9) flush();
    if (!cur) cur = { pts: [c[0]], vals: [v0] };
    cur.pts.push(c[1]);
    cur.vals.push(v1);
    if (t1 < 1 - 1e-9) flush();
  }
  flush();
  return out;
}
