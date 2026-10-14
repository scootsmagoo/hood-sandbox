import earcut from 'earcut';
import type { V2 } from '../geo.js';
import { segmentIntersection } from '../geo.js';
import type { MeshBuilder } from '../mesh/builder.js';
import type { RoadWay } from './osm.js';

/**
 * Junction polygons.
 *
 * Wherever three or more roads meet at a node, the ribbons used to overlap into a lump. Now the junction
 * gets its own surface: the legs' side lines are intersected pairwise to find the corners, the corners
 * are rounded with a curb radius, and every leg's ribbon is cut back to where the polygon starts.
 * Nodes that are a few metres apart (staggered T junctions, a dual carriageway meeting a street) form
 * one cluster with one polygon. Roundabouts, motorway merges, and junctions with legs closer than about
 * 17 degrees (Y merges) are left as they were: overlapping ribbons.
 */

export interface JunctionWayInput {
  way: RoadWay;
  pts: V2[];
  nodeIds: number[];
}

export interface Leg {
  /** index into the ways passed in */
  way: number;
  /** node index in that way, and the direction the leg runs along it (+1 towards higher indices) */
  index: number;
  s: 1 | -1;
  /** OSM node and its position */
  node: number;
  p: V2;
  /** unit direction pointing away from the junction */
  d: V2;
  half: number;
  highway: string;
  oneway: boolean;
  lanes: number;
  /** cars arrive from this leg / leave along it */
  approach: boolean;
  departure: boolean;
  /** distance from p along d where the ribbon starts and the junction polygon ends */
  trim: number;
}

export interface PolyPoint { x: number; z: number; lift: number }

export interface Junction {
  nodeIds: number[];
  center: V2;
  legs: Leg[];
  polygon: PolyPoint[];
}

export interface JunctionOptions {
  /** height of the road surface over the ground for a way */
  liftOf: (w: RoadWay) => number;
  /** nodes that cannot be junctions (on a deck, say) */
  skipNode?: (id: number) => boolean;
  /** junction nodes this close along a road (m) form one junction */
  clusterDist: number;
  /** curb radius at the corners (m) by the bigger of the two roads' widths */
  curbRadius: (widthA: number, widthB: number) => number;
}

export const DEFAULT_JUNCTION_OPTIONS: JunctionOptions = {
  liftOf: () => 0.08,
  clusterDist: 14,
  curbRadius: (a, b) => (Math.max(a, b) > 13 ? 6 : Math.max(a, b) > 7 ? 4.5 : 3),
};

export interface JunctionResult {
  junctions: Junction[];
  /** distance each leg's ribbon is cut back, by trimKey(way, index, s) */
  trims: Map<string, number>;
  /** node id -> index into junctions, for the nodes of every junction that got a polygon */
  junctionAt: Map<number, number>;
  stats: { candidates: number; clusters: number; built: number; rejected: Record<string, number> };
}

export const trimKey = (way: number, index: number, s: number) => `${way}:${index}:${s}`;

/** How far a leg's direction is measured along the way (m). */
const DIR_LOOKAHEAD = 7;
const MIN_ANGLE = 0.3;
const MAX_TANGENT = 9;
const MAX_REACH = 45;

const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const norm = (a: V2): V2 => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

function isHighwayClass(h: string): boolean {
  return /^(motorway|trunk)/.test(h);
}

export function buildJunctions(ways: JunctionWayInput[], user: Partial<JunctionOptions> = {}): JunctionResult {
  const o = { ...DEFAULT_JUNCTION_OPTIONS, ...user };
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };

  // legs per OSM node
  const legsAt = new Map<number, { way: number; index: number; s: 1 | -1 }[]>();
  const pos = new Map<number, V2>();
  ways.forEach((w, wi) => {
    const n = w.nodeIds.length;
    for (let i = 0; i < n; i++) {
      const id = w.nodeIds[i];
      if (id <= 0) continue;
      pos.set(id, w.pts[i]);
      let a = legsAt.get(id);
      if (!a) legsAt.set(id, (a = []));
      if (i > 0) a.push({ way: wi, index: i, s: -1 });
      if (i < n - 1) a.push({ way: wi, index: i, s: 1 });
    }
  });

  // candidate nodes
  const candidate = new Set<number>();
  for (const [id, legs] of legsAt) {
    if (legs.length < 3) continue;
    if (o.skipNode?.(id)) continue;
    if (legs.some((l) => ways[l.way].way.roundabout)) continue;
    if (legs.every((l) => isHighwayClass(ways[l.way].way.highway))) continue;
    candidate.add(id);
  }

  // clusters of candidates that are close along a road
  const parent = new Map<number, number>();
  const find = (a: number): number => { let r = a; while (parent.get(r) !== r) r = parent.get(r)!; while (parent.get(a) !== r) { const nx = parent.get(a)!; parent.set(a, r); a = nx; } return r; };
  for (const id of candidate) parent.set(id, id);
  ways.forEach((w) => {
    let last = -1;
    let lastDist = 0;
    let dist = 0;
    for (let i = 0; i < w.nodeIds.length; i++) {
      if (i > 0) dist += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
      const id = w.nodeIds[i];
      if (!candidate.has(id)) continue;
      if (last >= 0 && dist - lastDist <= o.clusterDist && w.nodeIds[last] !== id) parent.set(find(id), find(w.nodeIds[last]));
      last = i;
      lastDist = dist;
    }
  });
  const clusters = new Map<number, number[]>();
  for (const id of candidate) {
    const r = find(id);
    const a = clusters.get(r);
    if (a) a.push(id); else clusters.set(r, [id]);
  }

  const junctions: Junction[] = [];
  const trims = new Map<string, number>();
  const junctionAt = new Map<number, number>();

  for (const nodeIds of clusters.values()) {
    const inCluster = new Set(nodeIds);
    // legs that leave the cluster
    const legs: Leg[] = [];
    for (const id of nodeIds) {
      for (const l of legsAt.get(id)!) {
        const w = ways[l.way];
        // walk along the way: reaching another node of the cluster means this is an inner road
        let acc = 0;
        let j = l.index;
        let inner = false;
        let dirPt: V2 | null = null;
        let guard = 0;
        while (guard++ < 1000) {
          const nj = j + l.s;
          if (nj < 0 || nj >= w.pts.length) break;
          acc += Math.hypot(w.pts[nj][0] - w.pts[j][0], w.pts[nj][1] - w.pts[j][1]);
          j = nj;
          if (inCluster.has(w.nodeIds[j]) && w.nodeIds[j] !== id) { inner = true; break; }
          if (!dirPt && acc >= DIR_LOOKAHEAD) dirPt = w.pts[j];
          if (acc > o.clusterDist + 2 && dirPt) break;
        }
        if (inner) continue;
        const p = w.pts[l.index];
        const far = dirPt ?? w.pts[Math.max(0, Math.min(w.pts.length - 1, j))];
        const d = norm([far[0] - p[0], far[1] - p[1]]);
        if (Math.hypot(far[0] - p[0], far[1] - p[1]) < 0.5) continue;
        legs.push({
          way: l.way, index: l.index, s: l.s, node: id, p, d, half: w.way.width / 2, highway: w.way.highway, oneway: w.way.oneway, lanes: w.way.lanes,
          approach: !w.way.oneway || l.s === -1, departure: !w.way.oneway || l.s === 1, trim: 0,
        });
      }
    }
    if (legs.length < 3) { reject('fewer than three legs'); continue; }
    let cx = 0, cz = 0;
    for (const id of nodeIds) { const p = pos.get(id)!; cx += p[0]; cz += p[1]; }
    const center: V2 = [cx / nodeIds.length, cz / nodeIds.length];
    legs.sort((a, b) => Math.atan2(a.d[1], a.d[0]) - Math.atan2(b.d[1], b.d[0]));
    const poly = junctionPolygon(legs, o, (l) => o.liftOf(ways[l.way].way));
    if ('error' in poly) { reject(poly.error); continue; }
    if (poly.points.some((q) => Math.hypot(q.x - center[0], q.z - center[1]) > MAX_REACH)) { reject('too big'); continue; }
    if (!isSimple(poly.points)) { reject('polygon crosses itself'); continue; }
    const idx = junctions.length;
    legs.forEach((l, i) => { l.trim = poly.trims[i]; trims.set(trimKey(l.way, l.index, l.s), l.trim); });
    junctions.push({ nodeIds, center, legs, polygon: poly.points });
    for (const id of nodeIds) junctionAt.set(id, idx);
  }
  return { junctions, trims, junctionAt, stats: { candidates: candidate.size, clusters: clusters.size, built: junctions.length, rejected } };
}

/** The polygon around the cut-back legs (sorted by angle), or why there is none. */
export function junctionPolygon(
  legs: Leg[],
  o: Pick<JunctionOptions, 'curbRadius'>,
  liftOf: (l: Leg) => number,
): { points: PolyPoint[]; trims: number[] } | { error: string } {
  const m = legs.length;
  const ang = legs.map((l) => Math.atan2(l.d[1], l.d[0]));
  const nPlus = legs.map((l): V2 => [-l.d[1], l.d[0]]);
  interface Corner { x: V2; si: number; sj: number; T: number; delta: number; rho: number }
  const corners: (Corner | null)[] = [];
  const trims = legs.map((l) => Math.max(1.5, l.half));
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    let delta = ang[j] - ang[i];
    if (delta <= 0) delta += 2 * Math.PI;
    if (m === 2) delta = Math.PI;
    if (delta < MIN_ANGLE) return { error: 'legs closer than 17 degrees' };
    if (delta >= Math.PI - 0.05) { corners.push(null); continue; }
    const li = legs[i], lj = legs[j];
    const A: V2 = [li.p[0] + nPlus[i][0] * li.half, li.p[1] + nPlus[i][1] * li.half];
    const B: V2 = [lj.p[0] - nPlus[j][0] * lj.half, lj.p[1] - nPlus[j][1] * lj.half];
    const r: V2 = [B[0] - A[0], B[1] - A[1]];
    const den = cross(li.d, lj.d);
    if (Math.abs(den) < 1e-6) { corners.push(null); continue; }
    const s = cross(r, lj.d) / den;
    const u = cross(r, li.d) / den;
    const X: V2 = [A[0] + li.d[0] * s, A[1] + li.d[1] * s];
    const half = delta / 2;
    const rho0 = o.curbRadius(li.half * 2, lj.half * 2);
    const rho = Math.min(rho0, MAX_TANGENT * Math.tan(half));
    const T = rho / Math.tan(half);
    const si = Math.max(s, 0), sj = Math.max(u, 0);
    corners.push({ x: X, si, sj, T, delta, rho });
    trims[i] = Math.max(trims[i], si + T);
    trims[j] = Math.max(trims[j], sj + T);
  }
  if (trims.some((t) => t > MAX_REACH)) return { error: 'too big' };

  const pts: PolyPoint[] = [];
  const push = (x: number, z: number, lift: number) => {
    const l = pts[pts.length - 1];
    if (l && Math.hypot(l.x - x, l.z - z) < 0.05) return;
    pts.push({ x, z, lift });
  };
  for (let i = 0; i < m; i++) {
    const l = legs[i];
    const lift = liftOf(l);
    const t = trims[i];
    push(l.p[0] + l.d[0] * t - nPlus[i][0] * l.half, l.p[1] + l.d[1] * t - nPlus[i][1] * l.half, lift);
    push(l.p[0] + l.d[0] * t + nPlus[i][0] * l.half, l.p[1] + l.d[1] * t + nPlus[i][1] * l.half, lift);
    const c = corners[i];
    if (!c) continue;
    const j = (i + 1) % m;
    const lj = legs[j];
    const liftJ = liftOf(lj);
    const mid = (lift + liftJ) / 2;
    // tangent points, then the arc between them
    const Ap: V2 = [l.p[0] + nPlus[i][0] * l.half + l.d[0] * (c.si + c.T), l.p[1] + nPlus[i][1] * l.half + l.d[1] * (c.si + c.T)];
    const Bp: V2 = [lj.p[0] - nPlus[j][0] * lj.half + lj.d[0] * (c.sj + c.T), lj.p[1] - nPlus[j][1] * lj.half + lj.d[1] * (c.sj + c.T)];
    const bis = norm([l.d[0] + lj.d[0], l.d[1] + lj.d[1]]);
    const dist = c.rho / Math.sin(c.delta / 2);
    const C: V2 = [c.x[0] + bis[0] * dist, c.x[1] + bis[1] * dist];
    push(Ap[0], Ap[1], lift);
    const a0 = Math.atan2(Ap[1] - C[1], Ap[0] - C[0]);
    let da = Math.atan2(Bp[1] - C[1], Bp[0] - C[0]) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 8)));
    for (let k = 1; k < n; k++) {
      const a = a0 + (da * k) / n;
      push(C[0] + Math.cos(a) * c.rho, C[1] + Math.sin(a) * c.rho, mid);
    }
    push(Bp[0], Bp[1], liftJ);
  }
  if (pts.length < 3) return { error: 'degenerate' };
  return { points: pts, trims };
}

/** True when no two non-adjacent edges of the polygon cross. */
export function isSimple(poly: { x: number; z: number }[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a: V2 = [poly[i].x, poly[i].z];
    const b: V2 = [poly[(i + 1) % n].x, poly[(i + 1) % n].z];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c: V2 = [poly[j].x, poly[j].z];
      const d: V2 = [poly[(j + 1) % n].x, poly[(j + 1) % n].z];
      const x = segmentIntersection(a, b, c, d);
      if (x && x.t > 1e-6 && x.t < 1 - 1e-6 && x.u > 1e-6 && x.u < 1 - 1e-6) return false;
    }
  }
  return true;
}

export function polygonArea(poly: { x: number; z: number }[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/**
 * Adds the junction surface to `target`: a fan from the centre over an inner ring and the outline (the
 * ground is sampled at every vertex, so the surface follows the cut-and-fill ground), or an ear-clipped
 * outline when the polygon is not star-shaped around its centre.
 */
export function addJunctionMesh(
  target: MeshBuilder,
  j: { center: V2; polygon: PolyPoint[] },
  ground: (x: number, z: number) => number,
  color: [number, number, number],
  centerLift: number,
): number {
  const before = target.triangleCount;
  const poly = j.polygon;
  const n = poly.length;
  const sign = polygonArea(poly) >= 0 ? 1 : -1;
  const v = (x: number, z: number, lift: number) => target.vertex(x, ground(x, z) + lift, z, 0, 1, 0, color[0], color[1], color[2]);
  // star-shaped around the centre when every fan triangle has the polygon's orientation
  let star = true;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const area = (a.x - j.center[0]) * (b.z - j.center[1]) - (b.x - j.center[0]) * (a.z - j.center[1]);
    if (area * sign < -1e-6) { star = false; break; }
  }
  const up = (i0: number, i1: number, i2: number) => {
    // wind so the normal points up (+Y)
    const p = target.positions;
    const ux = p[i1 * 3] - p[i0 * 3], uz = p[i1 * 3 + 2] - p[i0 * 3 + 2];
    const wx = p[i2 * 3] - p[i0 * 3], wz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
    // normal.y = uz*wx - ux*wz for (u x w)
    const ny = uz * wx - ux * wz;
    if (Math.abs(ny) < 1e-6) return; // a sliver with no area
    if (ny > 0) target.tri(i0, i1, i2); else target.tri(i0, i2, i1);
  };
  if (star) {
    const c = v(j.center[0], j.center[1], centerLift);
    const outer = poly.map((q) => v(q.x, q.z, q.lift));
    const inner = poly.map((q) => v(j.center[0] + (q.x - j.center[0]) * 0.5, j.center[1] + (q.z - j.center[1]) * 0.5, (q.lift + centerLift) / 2));
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      up(c, inner[i], inner[k]);
      up(inner[i], outer[i], outer[k]);
      up(inner[i], outer[k], inner[k]);
    }
  } else {
    const flat: number[] = [];
    for (const q of poly) flat.push(q.x, q.z);
    const idx = poly.map((q) => v(q.x, q.z, q.lift));
    const tri = earcut(flat);
    for (let i = 0; i < tri.length; i += 3) up(idx[tri[i]], idx[tri[i + 1]], idx[tri[i + 2]]);
  }
  return target.triangleCount - before;
}

/** Cuts `trimStart` m off the start and `trimEnd` m off the end of a polyline (with its point values). Null if nothing is left. */
export function trimPolyline<T extends { pts: V2[]; vals?: number[] }>(line: T, trimStart: number, trimEnd: number): { pts: V2[]; vals?: number[]; start: number; end: number } | null {
  const pts = line.pts;
  const len: number[] = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = len[len.length - 1];
  const s0 = Math.max(0, trimStart), s1 = total - Math.max(0, trimEnd);
  if (s1 - s0 < 0.5) return null;
  const at = (s: number): { p: V2; v: number; seg: number } => {
    let k = 0;
    while (k + 2 < pts.length && len[k + 1] < s) k++;
    const l = len[k + 1] - len[k];
    const t = l > 0 ? Math.max(0, Math.min(1, (s - len[k]) / l)) : 0;
    const a = pts[k], b = pts[k + 1];
    const v = line.vals ? line.vals[k] + (line.vals[k + 1] - line.vals[k]) * t : 0;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], v, seg: k };
  };
  const first = at(s0), last = at(s1);
  const outPts: V2[] = [first.p];
  const outVals: number[] = [first.v];
  for (let i = 0; i < pts.length; i++) {
    if (len[i] > s0 + 1e-6 && len[i] < s1 - 1e-6) {
      outPts.push(pts[i]);
      outVals.push(line.vals ? line.vals[i] : 0);
    }
  }
  outPts.push(last.p);
  outVals.push(last.v);
  return { pts: outPts, vals: line.vals ? outVals : undefined, start: s0, end: s1 };
}
