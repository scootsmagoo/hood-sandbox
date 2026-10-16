/** Plan geometry for the route code: distance to a polyline of x, y, z triples. Pure. */

export interface PolyHit {
  /** Distance along the polyline to the nearest point (m, in plan). */
  s: number;
  /** Plan distance from the query to that point. */
  dist: number;
  x: number;
  y: number;
  z: number;
  /** Unit direction of the polyline there (plan). */
  tx: number;
  tz: number;
  /** Index of the segment (its first point). */
  seg: number;
}

export const newHit = (): PolyHit => ({ s: 0, dist: Infinity, x: 0, y: 0, z: 0, tx: 0, tz: 1, seg: 0 });

/** The nearest point to (x, z) on points `first .. first + count - 1` of a packed xyz array. Writes `out`. */
export function projectPolyline(pts: ArrayLike<number>, first: number, count: number, x: number, z: number, out: PolyHit): PolyHit {
  let best = Infinity;
  let acc = 0;
  out.dist = Infinity;
  for (let i = 0; i < count - 1; i++) {
    const o = (first + i) * 3;
    const ax = pts[o], az = pts[o + 2];
    const bx = pts[o + 3], bz = pts[o + 5];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const l = Math.sqrt(l2);
    let t = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, pz = az + dz * t;
    const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d2 < best) {
      best = d2;
      out.s = acc + l * t;
      out.x = px;
      out.z = pz;
      out.y = pts[o + 1] + (pts[o + 4] - pts[o + 1]) * t;
      out.tx = l > 1e-9 ? dx / l : 0;
      out.tz = l > 1e-9 ? dz / l : 1;
      out.seg = i;
    }
    acc += l;
  }
  out.dist = Math.sqrt(best);
  return out;
}

/** Plan length of points `first .. first + count - 1`. */
export function polylineLength(pts: ArrayLike<number>, first: number, count: number): number {
  let s = 0;
  for (let i = 0; i < count - 1; i++) {
    const o = (first + i) * 3;
    s += Math.hypot(pts[o + 3] - pts[o], pts[o + 5] - pts[o + 2]);
  }
  return s;
}

/** The point `s` metres along points `first .. first + count - 1` (clamped to the ends). Writes `out`. */
export function pointAlong(pts: ArrayLike<number>, first: number, count: number, s: number, out: PolyHit): PolyHit {
  let acc = 0;
  for (let i = 0; i < count - 1; i++) {
    const o = (first + i) * 3;
    const dx = pts[o + 3] - pts[o], dz = pts[o + 5] - pts[o + 2];
    const l = Math.hypot(dx, dz);
    if (acc + l >= s || i === count - 2) {
      const t = l > 1e-9 ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
      out.x = pts[o] + dx * t;
      out.z = pts[o + 2] + dz * t;
      out.y = pts[o + 1] + (pts[o + 4] - pts[o + 1]) * t;
      out.tx = l > 1e-9 ? dx / l : 0;
      out.tz = l > 1e-9 ? dz / l : 1;
      out.s = Math.min(s, acc + l);
      out.seg = i;
      out.dist = 0;
      return out;
    }
    acc += l;
  }
  return out;
}

/** Cells of a hash grid: the key for a cell index pair. */
export const cellKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

/** Writes into a hash grid every cell that the segment a-b touches (stepping at half a cell). */
export function gridSegment(cell: number, ax: number, az: number, bx: number, bz: number, visit: (key: number) => void) {
  const l = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(l / (cell * 0.5)));
  let last = NaN;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const k = cellKey(Math.floor((ax + (bx - ax) * t) / cell), Math.floor((az + (bz - az) * t) / cell));
    if (k !== last) visit(k);
    last = k;
  }
}
