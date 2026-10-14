import type { V2 } from '../geo.js';

export interface RibbonEdges {
  left: V2[];
  right: V2[];
  /** unit direction of travel at each point */
  dirs: V2[];
}

/** Drops consecutive points closer than eps. */
export function dedupe(pts: V2[], eps = 0.01): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > eps) out.push(p);
  }
  return out;
}

/**
 * Offsets a centreline by +-halfWidth with mitred joints (mitre length capped).
 * "Right" is to the right of the direction of travel with +X east and +Z south,
 * so travelling north (-Z) puts right on the east side.
 */
export function ribbonEdges(pts: V2[], halfWidth: number, miterLimit = 2): RibbonEdges {
  const n = pts.length;
  const segDir: V2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz) || 1;
    segDir.push([dx / l, dz / l]);
  }
  const left: V2[] = [];
  const right: V2[] = [];
  const dirs: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = segDir[Math.max(0, i - 1)];
    const b = segDir[Math.min(segDir.length - 1, i)];
    // right-hand normal of direction (dx, dz) is (-dz, dx)
    const na: V2 = [-a[1], a[0]];
    const nb: V2 = [-b[1], b[0]];
    let mx = na[0] + nb[0];
    let mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz);
    let scale = 1;
    if (ml < 1e-6) {
      mx = na[0];
      mz = na[1];
    } else {
      mx /= ml;
      mz /= ml;
      const c = mx * na[0] + mz * na[1];
      scale = Math.min(miterLimit, 1 / Math.max(c, 1e-3));
    }
    const o = halfWidth * scale;
    right.push([pts[i][0] + mx * o, pts[i][1] + mz * o]);
    left.push([pts[i][0] - mx * o, pts[i][1] - mz * o]);
    let dx = a[0] + b[0];
    let dz = a[1] + b[1];
    const dl = Math.hypot(dx, dz) || 1;
    dirs.push([dx / dl, dz / dl]);
  }
  return { left, right, dirs };
}

/**
 * Triangle indices for a strip whose vertices are laid out [L0, R0, L1, R1, ...].
 * Triangles face +Y when the strip runs along the direction used by ribbonEdges.
 */
export function ribbonIndices(sections: number, base = 0, flip = false): number[] {
  const idx: number[] = [];
  for (let i = 0; i + 1 < sections; i++) {
    const l0 = base + 2 * i;
    const r0 = l0 + 1;
    const l1 = l0 + 2;
    const r1 = l0 + 3;
    if (!flip) idx.push(l0, r0, l1, r0, r1, l1);
    else idx.push(l0, l1, r0, r0, l1, r1);
  }
  return idx;
}

/** Walks a polyline and returns the point and direction at distance s. */
export function pointAlong(pts: V2[], s: number): { p: V2; dir: V2 } {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz);
    if (acc + l >= s || i + 2 === pts.length) {
      const t = l > 0 ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
      return { p: [pts[i][0] + dx * t, pts[i][1] + dz * t], dir: l > 0 ? [dx / l, dz / l] : [1, 0] };
    }
    acc += l;
  }
  return { p: pts[0], dir: [1, 0] };
}
