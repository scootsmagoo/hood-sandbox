/**
 * Pitched, hipped, pyramidal, skillion and domed roofs. Pure geometry: a roof is a list of faces whose points are
 * (x, height above the eave line, z); the mesh writer (buildingMesh.ts) turns them into triangles and walls under the gables.
 *
 * A pitched roof is laid out in the footprint's oriented bounding box (axes: p along the long side, q across it): the box is cut
 * into a few convex cells, each with a plane (a gable has two halves, a hip has two slopes and two hipped ends), and the
 * footprint is intersected with every cell. So any footprint close to a rectangle gets a roof that meets its eaves exactly.
 */
import polygonClipping from 'polygon-clipping';
import type { V2 } from '../geo.js';
import type { Obb } from './shape.js';

export const ROOF_SHAPES = ['flat', 'gabled', 'hipped', 'pyramidal', 'dome', 'skillion'] as const;
export type RoofShape = (typeof ROOF_SHAPES)[number];
export const ROOF_SHAPE_ID = Object.fromEntries(ROOF_SHAPES.map((s, i) => [s, i])) as Record<RoofShape, number>;

/** Roof surface ids (`_SRF.x`). */
export const SURFACE = { flat: 0, pitched: 1, parapetInner: 2, parapetCap: 3, gable: 4, equipment: 5, soffit: 6, dome: 7 } as const;
/** Rooftop equipment ids (`_SRF.z`). */
export const EQUIPMENT = { none: 0, hvac: 1, tank: 2, bulkhead: 3, penthouse: 4 } as const;

/** An OSM `roof:shape` or an Overture `roof_shape` as one of ours; null when absent or unknown. */
export function normaliseRoofShape(s: string | null | undefined): RoofShape | null {
  if (!s) return null;
  switch (s.toLowerCase().replace(/[-_ ]/g, '')) {
    case 'flat': return 'flat';
    case 'gabled': case 'gable': return 'gabled';
    case 'hipped': case 'hip': case 'halfhipped': case 'mansard': case 'gambrel': case 'saltbox': return 'hipped';
    case 'pyramidal': case 'pyramid': return 'pyramidal';
    case 'dome': case 'round': case 'onion': case 'cone': return 'dome';
    case 'skillion': case 'shed': case 'mono': case 'lean': case 'leanto': return 'skillion';
    default: return null;
  }
}

export interface RoofFace {
  /** x, height above the eave line, z */
  pts: [number, number, number][];
  normal: [number, number, number];
  /** unit horizontal direction of steepest ascent (for texture coordinates) */
  gradient: V2;
  slopeDeg: number;
}

export interface RoofPlan {
  shape: RoofShape;
  /** height of the ridge (or the apex) above the eaves, m */
  rise: number;
  faces: RoofFace[];
}

const closeRing = (r: V2[]): [number, number][] => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];

function dedupeRing(r: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of r) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

interface Cell {
  /** corners in (p, q) */
  pq: V2[];
  /** h = a p + b q + c */
  a: number;
  b: number;
  c: number;
}

export interface PitchedOptions {
  /** pitch of the main slopes, degrees */
  slopeDeg: number;
  /** the most the ridge may rise above the eaves, m */
  maxRise: number;
}

/**
 * The faces of a gabled, hipped, pyramidal or skillion roof over `outer` (a ring without holes) inside its bounding box.
 * Returns null when the footprint is not close enough to the box to roof this way.
 */
export function planPitchedRoof(outer: V2[], shape: Exclude<RoofShape, 'flat' | 'dome'>, obb: Obb, o: PitchedOptions): RoofPlan | null {
  const { L, W } = obb;
  if (W < 2.2 || obb.fill < 0.78) return null;
  const bx = -obb.az, bz = obb.ax;
  let s = Math.tan((o.slopeDeg * Math.PI) / 180);
  let kind = shape;
  if (kind === 'pyramidal' && L - W > 0.2 * L) kind = 'hipped';
  if (kind === 'hipped' && L - W < 0.15 * L) kind = 'pyramidal';
  const span = kind === 'skillion' ? 2 * W : W;
  if (s * span > o.maxRise) s = o.maxRise / span;
  if (s * span < 0.6) return null;
  const rise = s * span;

  const cells: Cell[] = [];
  if (kind === 'gabled') {
    cells.push({ pq: [[-L, -W], [L, -W], [L, 0], [-L, 0]], a: 0, b: s, c: s * W });
    cells.push({ pq: [[-L, 0], [L, 0], [L, W], [-L, W]], a: 0, b: -s, c: s * W });
  } else if (kind === 'skillion') {
    // one plane: h = s (q + W), from 0 at q = -W to 2 s W at q = W
    cells.push({ pq: [[-L, -W], [L, -W], [L, W], [-L, W]], a: 0, b: s, c: s * W });
  } else {
    const m = L - W;
    cells.push({ pq: [[-L, -W], [L, -W], [m, 0], [-m, 0]], a: 0, b: s, c: s * W });
    cells.push({ pq: [[-m, 0], [m, 0], [L, W], [-L, W]], a: 0, b: -s, c: s * W });
    cells.push({ pq: [[L, -W], [L, W], [m, 0]], a: -s, b: 0, c: s * L });
    cells.push({ pq: [[-L, W], [-L, -W], [-m, 0]], a: s, b: 0, c: s * L });
  }

  const faces: RoofFace[] = [];
  const subject: polygonClipping.Polygon = [closeRing(outer)];
  for (const cell of cells) {
    const ring = dedupeRing(cell.pq.map(([p, q]) => [obb.cx + p * obb.ax + q * bx, obb.cz + p * obb.az + q * bz] as V2));
    if (ring.length < 3) continue;
    let res: polygonClipping.MultiPolygon;
    try {
      res = polygonClipping.intersection(subject, [closeRing(ring)]);
    } catch {
      return null;
    }
    // the plane in world axes: h = a p + b q + c, p = (x - cx) ax + (z - cz) az, q = (x - cx) bx + (z - cz) bz
    const dhdx = cell.a * obb.ax + cell.b * bx;
    const dhdz = cell.a * obb.az + cell.b * bz;
    const g = Math.hypot(dhdx, dhdz);
    const nl = Math.hypot(dhdx, 1, dhdz);
    const normal: [number, number, number] = [-dhdx / nl, 1 / nl, -dhdz / nl];
    const gradient: V2 = g > 1e-9 ? [dhdx / g, dhdz / g] : [1, 0];
    for (const poly of res) {
      const r = dedupeRing(poly[0].slice(0, -1).map((p) => [p[0], p[1]] as V2));
      if (r.length < 3) continue;
      const pts = r.map(([x, z]) => {
        const p = (x - obb.cx) * obb.ax + (z - obb.cz) * obb.az;
        const q = (x - obb.cx) * bx + (z - obb.cz) * bz;
        return [x, Math.max(0, cell.a * p + cell.b * q + cell.c), z] as [number, number, number];
      });
      faces.push({ pts, normal, gradient, slopeDeg: (Math.atan(g) * 180) / Math.PI });
    }
  }
  if (!faces.length) return null;
  return { shape: kind, rise, faces };
}

/** A low dome over a footprint that is star-shaped about its centroid: rings that shrink and rise, then an apex. */
export function planDome(outer: V2[], obb: Obb): RoofPlan | null {
  if (outer.length < 4) return null;
  const R = Math.max(1.5, Math.min(obb.W * 0.7, 14));
  const cx = outer.reduce((a, p) => a + p[0], 0) / outer.length;
  const cz = outer.reduce((a, p) => a + p[1], 0) / outer.length;
  const steps = [[1, 0], [0.93, 0.37], [0.74, 0.7], [0.4, 0.93], [0, 1]] as const;
  const ringAt = (k: number): [number, number, number][] => outer.map((p) => [cx + (p[0] - cx) * steps[k][0], R * steps[k][1], cz + (p[1] - cz) * steps[k][0]]);
  const faces: RoofFace[] = [];
  for (let k = 0; k + 1 < steps.length; k++) {
    const a = ringAt(k);
    const b = ringAt(k + 1);
    const n = outer.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const pts: [number, number, number][] = k + 2 === steps.length ? [a[i], a[j], b[i]] : [a[i], a[j], b[j], b[i]];
      // normal from the first three points (the face is nearly planar)
      const u = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
      const v = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
      let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const gl = Math.hypot(nx, nz) || 1;
      faces.push({ pts, normal: [nx, ny, nz], gradient: [nx / gl, nz / gl], slopeDeg: (Math.acos(Math.min(1, ny)) * 180) / Math.PI });
    }
  }
  return { shape: 'dome', rise: R, faces };
}

/** The height of a roof plan above the eaves at (x, z): the highest face that contains it, or 0. For tests and for placing things on a roof. */
export function roofHeightAt(plan: RoofPlan, x: number, z: number): number {
  let best = 0;
  for (const f of plan.faces) {
    // barycentric over a fan from the first point
    for (let i = 1; i + 1 < f.pts.length; i++) {
      const a = f.pts[0], b = f.pts[i], c = f.pts[i + 1];
      const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
      const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) best = Math.max(best, l1 * a[1] + l2 * b[1] + l3 * c[1]);
    }
  }
  return best;
}
