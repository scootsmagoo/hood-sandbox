import { groupOfLeg } from '../../../../src/shared/signals.js';

/**
 * The lane graph (`lanes.json`): what traffic drives on. It is generated from `roads.json` and
 * `junctions.json` after the rest of the bake, so it sees exactly what the sim and the client see.
 *
 * Edges are of two kinds:
 *  - a lane: one lane of one direction of a stretch of road between two junction cuts, a polyline
 *    offset from the centreline and trimmed back to the junction polygon;
 *  - a connector: the curve across a junction from the end of one lane to the start of another, one
 *    per legal movement (straight, left or right; never a U-turn), with its conflicts.
 *
 * Junctions with a polygon in `junctions.json` are explicit. Places where roads meet without one (a
 * road that changes way id, a roundabout, a motorway merge) are found by matching ends and are
 * implicit junctions with no trim and no control. See docs/contracts/m1-tile-format.md ("lanes.json").
 */

export type V3 = [number, number, number];

export interface RoadInput {
  id: string;
  class: string;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  layer: number;
  width: number;
  maxspeed?: number;
  points: V3[];
}

export interface JunctionsInput {
  junctions: {
    id: string;
    x: number;
    y: number;
    z: number;
    control: 'signals' | 'stop' | 'none';
    polygon?: [number, number][];
    legs: {
      road: string;
      node: number;
      at?: [number, number];
      dir: [number, number];
      approach: boolean;
      departure: boolean;
      trim: number;
      control: 'signals' | 'stop' | 'none';
      stopLine: [number, number, number] | null;
      crosswalk: boolean;
    }[];
  }[];
}

export type Turn = 's' | 'l' | 'r' | 'u';
export type Control = 'signals' | 'stop' | 'none';

export interface LaneEdge {
  t: 0;
  road: string;
  cls: string;
  /** +1 along the road's points, -1 against them */
  dir: 1 | -1;
  /** lane index within its direction, 0 the leftmost, and how many lanes that direction has */
  k: number;
  n: number;
  len: number;
  /** speed limit, m/s */
  v: number;
  pts: number[];
  next: number[];
  left: number;
  right: number;
  /** the junction this lane ends at, which of its legs it arrives on, and what a car there faces */
  j?: string;
  leg?: number;
  ctl?: Control;
  bridge?: 1;
}

export interface ConnectorEdge {
  t: 1;
  j: string;
  from: number;
  to: number;
  turn: Turn;
  len: number;
  /** speed through the junction, m/s */
  v: number;
  pts: number[];
  /** the leg it enters from (index into the junction's `legs`); a connector's `next` is `[to]` and its control that of the lane it leaves */
  leg: number;
  /** connectors that cross or merge with this one; must yield to; contest by arrival order */
  c: number[];
  y: number[];
  m: number[];
}

export type Edge = LaneEdge | ConnectorEdge;

export interface LanesJunction {
  id: string;
  x: number;
  z: number;
  control: Control;
  /** explicit junctions: false for places found by matching road ends */
  implicit?: 1;
  /** legs as listed in junctions.json (signalised junctions only: the signal group is a function of them) */
  legs?: { dir: [number, number]; approach: boolean }[];
  /** signal heads: where, and the yaw of the face (it looks at the approaching cars) */
  heads?: { leg: number; x: number; y: number; z: number; yaw: number }[];
}

export interface LanesFile {
  format: 'hood-lanes';
  version: 1;
  edges: Edge[];
  junctions: LanesJunction[];
  stats: LaneStats;
}

export interface LaneStats {
  lanes: number;
  connectors: number;
  laneKm: number;
  junctions: number;
  implicitJunctions: number;
  conflicts: number;
  skippedLegs: number;
  /** share of lane length in the largest strongly connected component, 0 to 1, over all lanes and over surface streets (no freeways) */
  largestComponent: number;
  largestComponentStreets: number;
}

// ---------------------------------------------------------------------------------------------
// Tunables

/** Classes that carry traffic here. Service roads are parking aisles and alleys. */
const SKIP = new Set(['service', 'busway', 'living_street', 'track', 'path', 'footway']);
/** Posted limits by class when OSM has none, m/s (US city streets: 25 to 45 mph). */
const CLASS_SPEED: Record<string, number> = {
  motorway: 29, trunk: 24.6, primary: 17.9, secondary: 15.6, tertiary: 13.4, unclassified: 13.4, residential: 11.2, road: 11.2,
};
const RANK: Record<string, number> = { motorway: 5, trunk: 4, primary: 3, secondary: 2, tertiary: 1, unclassified: 1, residential: 0, road: 0 };
const baseClass = (c: string) => c.replace(/_link$/, '');
const isLink = (c: string) => c.endsWith('_link');
/** Lateral acceleration allowed in a turn, m/s^2. */
const LAT_ACC = 3.2;
const MIN_TURN_SPEED = 3.5;
const SNAP = 0.75;
const MIN_STRETCH = 2;
/** How far the lanes stop short of a place where roads turn onto each other without a junction polygon, m. */
const IMPLICIT_TRIM = 5.5;
/** The same where they only join (a way that changes id, lanes that start or end): enough for the lanes to blend. */
const IMPLICIT_LINK_TRIM = 4;

export function speedLimit(r: Pick<RoadInput, 'class' | 'maxspeed'>): number {
  if (r.maxspeed) return Math.round((r.maxspeed / 3.6) * 10) / 10;
  const base = CLASS_SPEED[baseClass(r.class)] ?? 11.2;
  return isLink(r.class) ? Math.round(base * 0.7 * 10) / 10 : base;
}

const rankOf = (cls: string) => RANK[baseClass(cls)] ?? 0;

// ---------------------------------------------------------------------------------------------
// Polyline helpers (xz plane, y carried along)

interface Poly {
  p: V3[];
  /** cumulative arc length (xz) */
  s: number[];
  len: number;
}

function mkPoly(p: V3[]): Poly {
  const s = [0];
  for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]));
  return { p, s, len: s[s.length - 1] };
}

function atS(poly: Poly, s: number): { x: number; y: number; z: number; tx: number; tz: number; i: number } {
  const t = Math.max(0, Math.min(poly.len, s));
  let i = 1;
  while (i < poly.p.length - 1 && poly.s[i] < t) i++;
  const a = poly.p[i - 1];
  const b = poly.p[i];
  const seg = poly.s[i] - poly.s[i - 1] || 1;
  const u = (t - poly.s[i - 1]) / seg;
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const l = Math.hypot(dx, dz) || 1;
  return { x: a[0] + dx * u, y: a[1] + (b[1] - a[1]) * u, z: a[2] + dz * u, tx: dx / l, tz: dz / l, i: i - 1 };
}

/** Nearest point of a polyline to (x, z): arc length and distance. */
function project(poly: Poly, x: number, z: number): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity };
  for (let i = 1; i < poly.p.length; i++) {
    const a = poly.p[i - 1];
    const b = poly.p[i];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
    const d = Math.hypot(x - (a[0] + dx * t), z - (a[2] + dz * t));
    if (d < best.dist) best = { s: poly.s[i - 1] + t * (poly.s[i] - poly.s[i - 1]), dist: d };
  }
  return best;
}

/** Points of the polyline between arc lengths s0 and s1 (ends included). */
function slice(poly: Poly, s0: number, s1: number): V3[] {
  const a = atS(poly, s0);
  const b = atS(poly, s1);
  const out: V3[] = [[a.x, a.y, a.z]];
  for (let i = 0; i < poly.p.length; i++) if (poly.s[i] > s0 + 0.05 && poly.s[i] < s1 - 0.05) out.push(poly.p[i]);
  out.push([b.x, b.y, b.z]);
  return out;
}

/** Offsets a polyline to the right of its direction of travel by `o` metres (negative: left), mitring corners. */
function offsetRight(pts: V3[], o: number): V3[] {
  const n = pts.length;
  const out: V3[] = [];
  const nx: number[] = [];
  const nz: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][2] - pts[i][2];
    const l = Math.hypot(dx, dz) || 1;
    // right of travel: (-dz, dx)
    nx.push(-dz / l);
    nz.push(dx / l);
  }
  for (let i = 0; i < n; i++) {
    let ax: number, az: number;
    if (i === 0) { ax = nx[0]; az = nz[0]; }
    else if (i === n - 1) { ax = nx[n - 2]; az = nz[n - 2]; }
    else {
      ax = nx[i - 1] + nx[i];
      az = nz[i - 1] + nz[i];
      const l = Math.hypot(ax, az);
      if (l < 1e-6) { ax = nx[i]; az = nz[i]; } else {
        ax /= l; az /= l;
        // miter: 1 / cos(half angle), limited
        const c = ax * nx[i] + az * nz[i];
        const k = Math.min(1.6, 1 / Math.max(0.5, c));
        ax *= k; az *= k;
      }
    }
    out.push([pts[i][0] + ax * o, pts[i][1], pts[i][2] + az * o]);
  }
  return out;
}

const round = (v: number, d: number) => {
  const m = 10 ** d;
  return Math.round(v * m) / m;
};

function flat(pts: V3[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(round(p[0], 1), round(p[1], 1), round(p[2], 1));
  return out;
}

function lenOf(pts: V3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
  return l;
}

/** Highest curvature (1/m) along a polyline, measured over spans of about 2.5 m. */
function maxCurvature(pts: V3[]): number {
  if (pts.length < 3) return 0;
  const m = mkPoly(pts);
  let k = 0;
  const span = 2.5;
  for (let s = span; s < m.len - span + 1e-6; s += span / 2) {
    const a = atS(m, s - span);
    const b = atS(m, s);
    const c = atS(m, s + span);
    const h1 = Math.atan2(b.x - a.x, b.z - a.z);
    const h2 = Math.atan2(c.x - b.x, c.z - b.z);
    let d = h2 - h1;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    k = Math.max(k, Math.abs(d) / (2 * span));
  }
  return k;
}

function curveSpeed(pts: V3[], limit: number): number {
  const k = maxCurvature(pts);
  if (k < 1e-4) return limit;
  return Math.max(Math.min(limit, MIN_TURN_SPEED), Math.min(limit, Math.sqrt(LAT_ACC / k)));
}

// ---------------------------------------------------------------------------------------------
// Roads, cuts and stretches

interface Road {
  r: RoadInput;
  poly: Poly;
  cuts: Cut[];
  speed: number;
  fwdLanes: number;
  bwdLanes: number;
  lw: number;
  oddMiddle: boolean;
}

interface JNode {
  id: string;
  implicit: boolean;
  x: number;
  z: number;
  y: number;
  control: Control;
  /** the source junction record, for explicit ones */
  src?: JunctionsInput['junctions'][number];
  legs: JLeg[];
}

interface JLeg {
  node: JNode;
  road: Road;
  cut: Cut;
  side: 'back' | 'fwd';
  /** unit direction away from the node */
  dir: [number, number];
  trim: number;
  control: Control;
  /** index in the source junction's legs (explicit) or in `node.legs` */
  srcIndex: number;
  /** lane edge ids arriving here / leaving here */
  arrive: number[];
  depart: number[];
}

interface Cut {
  s: number;
  node: JNode;
  back?: JLeg;
  fwd?: JLeg;
}

interface Stretch {
  road: Road;
  a: Cut | null;
  b: Cut | null;
  sa: number;
  sb: number;
  fwd: number[];
  bwd: number[];
}

/** Unit direction of the road at arc length `s`, looking `away` (+1 forward along the points, -1 backward) for a few metres. */
function tangentAway(road: Road, s: number, away: 1 | -1): [number, number] {
  const a = atS(road.poly, s);
  const b = atS(road.poly, Math.max(0, Math.min(road.poly.len, s + away * 6)));
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

function laneLayout(r: RoadInput): { fwd: number; bwd: number; lw: number; odd: boolean } {
  const n = Math.max(1, r.lanes | 0);
  if (r.oneway) return { fwd: n, bwd: 0, lw: Math.max(2.6, Math.min(4, r.width / n)), odd: false };
  const per = n <= 1 ? 1 : n % 2 === 1 ? (n - 1) / 2 : n / 2;
  const odd = n > 1 && n % 2 === 1;
  const shown = per * 2 + (odd ? 1 : 0);
  return { fwd: per, bwd: per, lw: Math.max(2.6, Math.min(4, r.width / shown)), odd };
}

export interface LaneOptions {
  /** metres: a free road end this close to another end or road joins it */
  snap?: number;
}

/** A signal pole stands at least this far from every lane's and turn's centreline (m), moving out up to `HEAD_MAX_MOVE` to get there. */
const HEAD_CLEAR = 1.8;
const HEAD_MAX_MOVE = 3;

export function buildLanes(roadsIn: RoadInput[], jIn: JunctionsInput, opts: LaneOptions = {}): LanesFile {
  const snap = opts.snap ?? SNAP;
  const roads: Road[] = [];
  const byId = new Map<string, Road>();
  for (const r of roadsIn) {
    if (SKIP.has(r.class) || r.points.length < 2) continue;
    const poly = mkPoly(r.points);
    if (poly.len < 2) continue;
    const lay = laneLayout(r);
    const road: Road = { r, poly, cuts: [], speed: speedLimit(r), fwdLanes: lay.fwd, bwdLanes: lay.bwd, lw: lay.lw, oddMiddle: lay.odd };
    roads.push(road);
    // A way can be listed in pieces under one id (cut by the tile, or by a deck); the first piece wins the id lookup.
    if (!byId.has(r.id)) byId.set(r.id, road);
  }

  const nodes: JNode[] = [];
  let skippedLegs = 0;

  const addCut = (road: Road, s: number, node: JNode): Cut => {
    let c = road.cuts.find((k) => k.node === node && Math.abs(k.s - s) < 1.5);
    if (!c) {
      c = { s, node };
      road.cuts.push(c);
    }
    return c;
  };

  // ---- explicit junctions
  jIn.junctions.forEach((j) => {
    const node: JNode = { id: j.id, implicit: false, x: j.x, z: j.z, y: j.y, control: j.control, src: j, legs: [] };
    j.legs.forEach((l, li) => {
      const cands = roads.filter((r) => r.r.id === l.road);
      if (cands.length === 0) return; // an excluded class: the leg has no lanes
      // The piece of the way that passes the node.
      const ref = l.at ?? [j.x, j.z];
      let best: { road: Road; s: number; dist: number } | null = null;
      for (const road of cands) {
        const pr = project(road.poly, ref[0], ref[1]);
        if (!best || pr.dist < best.dist) best = { road, s: pr.s, dist: pr.dist };
      }
      if (!best || best.dist > (l.at ? 4 : 30)) { skippedLegs++; return; }
      const { road, s } = best;
      const here = atS(road.poly, s);
      let side: 'back' | 'fwd' = here.tx * l.dir[0] + here.tz * l.dir[1] >= 0 ? 'fwd' : 'back';
      if (s < 1) side = 'fwd';
      else if (s > road.poly.len - 1) side = 'back';
      const cut = addCut(road, s, node);
      if (cut[side]) { skippedLegs++; return; }
      const leg: JLeg = { node, road, cut, side, dir: l.dir, trim: l.trim, control: l.control, srcIndex: li, arrive: [], depart: [] };
      cut[side] = leg;
      node.legs.push(leg);
    });
    nodes.push(node);
  });

  // ---- a road that ends inside a junction polygon (the other node of a merged cluster): its end is part of the junction
  {
    const polys = nodes.filter((n) => n.src?.polygon && n.src.polygon.length >= 3);
    const inPoly = (n: JNode, x: number, z: number) => {
      const poly = n.src!.polygon!;
      let inside = false;
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const [xi, zi] = poly[i];
        const [xk, zk] = poly[k];
        if (zi > z !== zk > z && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
      }
      return inside;
    };
    for (const road of roads) {
      for (const at of [0, 1] as const) {
        const sEnd = at === 0 ? 0 : road.poly.len;
        if (road.cuts.some((c) => Math.abs(c.s - sEnd) < 1.5)) continue;
        const p = road.poly.p[at === 0 ? 0 : road.poly.p.length - 1];
        for (const n of polys) {
          if (Math.hypot(p[0] - n.x, p[2] - n.z) > 60 || Math.abs(p[1] - n.y) > 3) continue;
          if (!inPoly(n, p[0], p[2])) continue;
          if (road.cuts.some((c) => c.node === n)) {
            // a road that already enters this junction: its end is inside it
            addCut(road, sEnd, n);
          } else {
            // the road runs into the junction without a leg of its own (its neighbour's node is mid-junction): a leg of its own
            const cut = addCut(road, sEnd, n);
            const side: 'back' | 'fwd' = at === 0 ? 'fwd' : 'back';
            const dir = tangentAway(road, sEnd, side === 'fwd' ? 1 : -1);
            let src = -1;
            let bestDot = 0.8;
            n.src!.legs.forEach((l, i) => {
              const d = l.dir[0] * dir[0] + l.dir[1] * dir[1];
              if (d > bestDot) { bestDot = d; src = i; }
            });
            const leg: JLeg = { node: n, road, cut, side, dir, trim: 0, control: src >= 0 ? n.src!.legs[src].control : 'none', srcIndex: src, arrive: [], depart: [] };
            cut[side] = leg;
            n.legs.push(leg);
          }
          break;
        }
      }
    }
  }

  // ---- implicit junctions: road ends that meet without a junction polygon
  interface End { road: Road; at: 0 | 1; x: number; y: number; z: number }
  const ends: End[] = [];
  for (const road of roads) {
    for (const at of [0, 1] as const) {
      const s = at === 0 ? 0 : road.poly.len;
      if (road.cuts.some((c) => Math.abs(c.s - s) < 1.5)) continue;
      const p = road.poly.p[at === 0 ? 0 : road.poly.p.length - 1];
      ends.push({ road, at, x: p[0], y: p[1], z: p[2] });
    }
  }
  const cell = 4;
  const grid = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  ends.forEach((e, i) => {
    const k = key(e.x, e.z);
    const a = grid.get(k);
    if (a) a.push(i); else grid.set(k, [i]);
  });
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  ends.forEach((e, i) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const o of grid.get(`${Math.floor(e.x / cell) + dx},${Math.floor(e.z / cell) + dz}`) ?? []) {
        if (o <= i) continue;
        const f = ends[o];
        if (f.road === e.road) continue;
        if (Math.hypot(f.x - e.x, f.z - e.z) <= snap && Math.abs(f.y - e.y) < 2.5) parent[find(o)] = find(i);
      }
    }
  });
  const groups = new Map<number, number[]>();
  ends.forEach((_, i) => {
    const r = find(i);
    const a = groups.get(r);
    if (a) a.push(i); else groups.set(r, [i]);
  });

  // A grid of road segments, for roads whose interior a free end touches.
  const segGrid = new Map<string, { road: Road; i: number }[]>();
  for (const road of roads) {
    for (let i = 1; i < road.poly.p.length; i++) {
      const a = road.poly.p[i - 1];
      const b = road.poly.p[i];
      const x0 = Math.floor((Math.min(a[0], b[0]) - snap) / cell), x1 = Math.floor((Math.max(a[0], b[0]) + snap) / cell);
      const z0 = Math.floor((Math.min(a[2], b[2]) - snap) / cell), z1 = Math.floor((Math.max(a[2], b[2]) + snap) / cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        const arr = segGrid.get(k);
        if (arr) arr.push({ road, i }); else segGrid.set(k, [{ road, i }]);
      }
    }
  }

  let implicitCount = 0;
  const nearestLegDir = tangentAway;
  for (const g of groups.values()) {
    const members = g.map((i) => ends[i]);
    const px = members.reduce((a, e) => a + e.x, 0) / members.length;
    const pz = members.reduce((a, e) => a + e.z, 0) / members.length;
    const py = members.reduce((a, e) => a + e.y, 0) / members.length;
    // Interior touches: another road passes through this point.
    const touched: { road: Road; s: number }[] = [];
    const seen = new Set<Road>(members.map((e) => e.road));
    for (const hit of segGrid.get(key(px, pz)) ?? []) {
      if (seen.has(hit.road)) continue;
      const pr = project(hit.road.poly, px, pz);
      if (pr.dist > snap) continue;
      const at = atS(hit.road.poly, pr.s);
      if (Math.abs(at.y - py) > 2.5) continue;
      if (pr.s < 1.5 || pr.s > hit.road.poly.len - 1.5) continue;
      // Not where a junction already cut the road.
      if (hit.road.cuts.some((c) => Math.abs(c.s - pr.s) < 14)) continue;
      seen.add(hit.road);
      touched.push({ road: hit.road, s: pr.s });
    }
    if (members.length < 2 && touched.length === 0) continue; // a dead end, or the edge of the tile
    const node: JNode = { id: `n${implicitCount++}`, implicit: true, x: px, z: pz, y: py, control: 'none', legs: [] };
    const mk = (road: Road, cut: Cut, side: 'back' | 'fwd') => {
      const leg: JLeg = { node, road, cut, side, dir: nearestLegDir(road, cut.s, side === 'fwd' ? 1 : -1), trim: 0, control: 'none', srcIndex: node.legs.length, arrive: [], depart: [] };
      cut[side] = leg;
      node.legs.push(leg);
    };
    for (const e of members) {
      const cut = addCut(e.road, e.at === 0 ? 0 : e.road.poly.len, node);
      mk(e.road, cut, e.at === 0 ? 'fwd' : 'back');
    }
    for (const t of touched) {
      const cut = addCut(t.road, t.s, node);
      mk(t.road, cut, 'back');
      mk(t.road, cut, 'fwd');
    }
    nodes.push(node);
  }

  // ---- implicit junctions get a cut back too, so a turn or a change of lanes has room to be a curve
  // (a lane offset from a bent or widening road does not meet the next one end to end)
  for (const node of nodes) {
    if (!node.implicit) continue;
    let turns = false;
    for (const a of node.legs) {
      for (const b of node.legs) {
        if (a === b) continue;
        const dot = -a.dir[0] * b.dir[0] - a.dir[1] * b.dir[1];
        const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
        if (deg > 35 && deg < 150) turns = true;
      }
    }
    for (const leg of node.legs) leg.trim = turns ? IMPLICIT_TRIM : IMPLICIT_LINK_TRIM;
  }

  // ---- stretches and lanes
  const edges: Edge[] = [];
  const stretches: Stretch[] = [];
  const startsAt = new Map<Cut, Stretch>();
  const endsAt = new Map<Cut, Stretch>();
  for (const road of roads) {
    road.cuts.sort((a, b) => a.s - b.s);
    const marks: (Cut | null)[] = [null, ...road.cuts, null];
    for (let m = 0; m + 1 < marks.length; m++) {
      const a = marks[m];
      const b = marks[m + 1];
      if (a && b && a.node === b.node) continue; // the stretch lies inside the junction
      let sa = a ? a.s : 0;
      let sb = b ? b.s : road.poly.len;
      let ta = a?.fwd?.trim ?? 0;
      let tb = b?.back?.trim ?? 0;
      const room = sb - sa - MIN_STRETCH;
      if (room < ta + tb) {
        const f = room > 0 ? room / (ta + tb) : 0;
        ta *= f;
        tb *= f;
      }
      sa += ta;
      sb -= tb;
      if (sb - sa < 0.5) continue;
      const st: Stretch = { road, a, b, sa, sb, fwd: [], bwd: [] };
      stretches.push(st);
      if (a) startsAt.set(a, st);
      if (b) endsAt.set(b, st);
      const centre = slice(road.poly, sa, sb);
      const lw = road.lw;
      const mid = road.oddMiddle ? lw / 2 : 0;
      const bridge = road.r.bridge ? (1 as const) : undefined;
      const mkLane = (dir: 1 | -1, k: number, n: number): number => {
        const travel = dir === 1 ? centre : [...centre].reverse();
        let o: number;
        if (road.r.oneway) o = (k - (n - 1) / 2) * lw;
        else o = mid + (k + 0.5) * lw;
        const pts = offsetRight(travel, o);
        const id = edges.length;
        const limit = road.speed;
        edges.push({
          t: 0, road: road.r.id, cls: road.r.class, dir, k, n, len: round(lenOf(pts), 2), v: round(curveSpeed(pts, limit), 1),
          pts: flat(pts), next: [], left: -1, right: -1, ...(bridge ? { bridge } : {}),
        });
        return id;
      };
      for (let k = 0; k < road.fwdLanes; k++) st.fwd.push(mkLane(1, k, road.fwdLanes));
      for (let k = 0; k < road.bwdLanes; k++) st.bwd.push(mkLane(-1, k, road.bwdLanes));
      for (const arr of [st.fwd, st.bwd]) {
        arr.forEach((id, k) => {
          (edges[id] as LaneEdge).left = k > 0 ? arr[k - 1] : -1;
          (edges[id] as LaneEdge).right = k + 1 < arr.length ? arr[k + 1] : -1;
        });
      }
    }
  }

  // lanes arriving at and leaving each leg
  for (const node of nodes) {
    for (const leg of node.legs) {
      const into = leg.side === 'back' ? endsAt.get(leg.cut) : startsAt.get(leg.cut);
      if (!into) continue;
      if (leg.side === 'back') { leg.arrive = into.fwd; leg.depart = into.bwd; } else { leg.arrive = into.bwd; leg.depart = into.fwd; }
    }
  }
  // Which junction and leg each arriving lane ends at.
  for (const node of nodes) {
    for (const leg of node.legs) {
      for (const id of leg.arrive) {
        const e = edges[id] as LaneEdge;
        e.j = node.id;
        e.leg = leg.srcIndex;
        e.ctl = leg.control;
      }
    }
  }

  // ---- connectors
  const connByNode = new Map<JNode, ConnectorEdge[]>();
  const connIds = new Map<ConnectorEdge, number>();
  const legByConn = new Map<ConnectorEdge, JLeg>();
  for (const node of nodes) {
    const list: ConnectorEdge[] = [];
    connByNode.set(node, list);
    const twoLegs = node.legs.length === 2;
    interface Move { li: JLeg; lo: JLeg; a: number; b: number; turn: Turn }
    const moves: Move[] = [];
    for (const li of node.legs) {
      if (li.arrive.length === 0) continue;
      for (const lo of node.legs) {
        if (lo === li || lo.depart.length === 0) continue;
        // travel in = -dir(li), travel out = dir(lo)
        const ix = -li.dir[0], iz = -li.dir[1];
        const ox = lo.dir[0], oz = lo.dir[1];
        const cross = ix * oz - iz * ox;
        const dot = ix * ox + iz * oz;
        const ang = Math.atan2(cross, dot); // positive: right
        const deg = Math.abs(ang) * 180 / Math.PI;
        if (deg > 150 && !(twoLegs && deg < 172)) continue; // a U-turn
        const turn: Turn = deg < 35 ? 's' : deg > 150 ? 'u' : ang > 0 ? 'r' : 'l';
        const n = li.arrive.length;
        const m = lo.depart.length;
        if (turn === 's') for (let k = 0; k < n; k++) moves.push({ li, lo, a: k, b: Math.min(k, m - 1), turn });
        else if (turn === 'r') moves.push({ li, lo, a: n - 1, b: m - 1, turn });
        else moves.push({ li, lo, a: 0, b: 0, turn });
      }
    }
    // A leg nothing else leads to or from (the rest of the road is gone, or excluded): turn round at the junction.
    for (const li of node.legs) {
      if (li.arrive.length === 0 || li.depart.length === 0) continue;
      const out = moves.some((v) => v.li === li);
      const inn = moves.some((v) => v.lo === li);
      if (!out || !inn) moves.push({ li, lo: li, a: 0, b: 0, turn: 'u' });
    }
    // Every lane should lead somewhere and be reached from somewhere: lanes that straight, left and right
    // rules leave out (the middle lane of a T's stem, a lane that appears beyond the junction) borrow a neighbour's.
    for (const li of node.legs) {
      const mine = moves.filter((v) => v.li === li);
      if (mine.length === 0) continue;
      for (let a = 0; a < li.arrive.length; a++) {
        if (mine.some((v) => v.a === a)) continue;
        let best = mine[0];
        for (const v of mine) if (Math.abs(v.a - a) < Math.abs(best.a - a)) best = v;
        moves.push({ li, lo: best.lo, a, b: best.b, turn: best.turn });
      }
    }
    for (const lo of node.legs) {
      const into = moves.filter((v) => v.lo === lo);
      if (into.length === 0) continue;
      for (let b = 0; b < lo.depart.length; b++) {
        if (into.some((v) => v.b === b)) continue;
        let best = into[0];
        for (const v of into) if (Math.abs(v.b - b) < Math.abs(best.b - b)) best = v;
        moves.push({ li: best.li, lo, a: best.a, b, turn: best.turn });
      }
    }
    for (const mv of moves) {
      const from = mv.li.arrive[mv.a];
      const to = mv.lo.depart[mv.b];
      const pts = connectorPoints(edges[from] as LaneEdge, edges[to] as LaneEdge);
      const limit = Math.min((edges[from] as LaneEdge).v, (edges[to] as LaneEdge).v);
      const c: ConnectorEdge = {
        t: 1, j: node.id, from, to, turn: mv.turn, len: round(lenOf(pts), 2), v: round(mv.turn === 's' ? curveSpeed(pts, limit) : Math.min(curveSpeed(pts, limit), mv.turn === 'r' ? 6.5 : mv.turn === 'u' ? 4 : 7.5), 1),
        pts: flat(pts), leg: mv.li.srcIndex, c: [], y: [], m: [],
      };
      const id = edges.length;
      edges.push(c);
      connIds.set(c, id);
      legByConn.set(c, mv.li);
      list.push(c);
      (edges[from] as LaneEdge).next.push(id);
    }
  }

  // ---- turnarounds at the free ends of two-way roads (a cul-de-sac, the edge of the tile)
  const turnarounds: LanesJunction[] = [];
  for (const st of stretches) {
    for (const atEnd of [false, true]) {
      if (atEnd ? st.b : st.a) continue;
      const arrive = atEnd ? st.fwd : st.bwd;
      const depart = atEnd ? st.bwd : st.fwd;
      if (arrive.length === 0 || depart.length === 0) continue;
      const from = arrive[0];
      const to = depart[0];
      const pts = connectorPoints(edges[from] as LaneEdge, edges[to] as LaneEdge);
      const id = `u${turnarounds.length}`;
      const c: ConnectorEdge = { t: 1, j: id, from, to, turn: 'u', len: round(lenOf(pts), 2), v: 4, pts: flat(pts), leg: 0, c: [], y: [], m: [] };
      (edges[from] as LaneEdge).next.push(edges.length);
      (edges[from] as LaneEdge).j = id;
      (edges[from] as LaneEdge).leg = 0;
      (edges[from] as LaneEdge).ctl = 'none';
      edges.push(c);
      turnarounds.push({ id, x: round(pts[0][0], 1), z: round(pts[0][2], 1), control: 'none', implicit: 1 });
    }
  }

  // ---- conflicts
  let conflictPairs = 0;
  for (const node of nodes) {
    const list = connByNode.get(node)!;
    const legOf = (c: ConnectorEdge) => legByConn.get(c)!;
    const grp = (l: JLeg) => {
      const src = node.src!;
      return l.srcIndex >= 0
        ? groupOfLeg(src, l.srcIndex)
        : groupOfLeg({ id: src.id, legs: [...src.legs, { dir: l.dir, approach: true }] }, src.legs.length);
    };
    const polys = list.map((c) => {
      const out: [number, number][] = [];
      for (let i = 0; i < c.pts.length; i += 3) out.push([c.pts[i], c.pts[i + 2]]);
      return out;
    });
    const prio = (t: Turn) => (t === 's' ? 2 : t === 'r' ? 1 : 0);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        if (A.from === B.from) continue;
        const merge = A.to === B.to;
        if (!merge && !polylinesCross(polys[a], polys[b])) continue;
        conflictPairs++;
        const ia = connIds.get(A)!;
        const ib = connIds.get(B)!;
        A.c.push(ib);
        B.c.push(ia);
        const la = legOf(A), lb = legOf(B);
        // who gives way
        let rel: 'a' | 'b' | 'mutual' | 'none' = 'mutual';
        if (node.control === 'signals') {
          const ga = grp(la);
          const gb = grp(lb);
          if (ga !== gb) rel = 'none';
          else rel = prio(A.turn) === prio(B.turn) ? 'mutual' : prio(A.turn) < prio(B.turn) ? 'a' : 'b';
        } else if (node.control === 'stop' && la.control !== lb.control) {
          // The leg without a stop sign has the right of way.
          rel = la.control === 'stop' ? 'a' : 'b';
        } else if (node.control === 'stop') {
          rel = 'mutual';
        } else {
          const ra = rankOf(la.road.r.class);
          const rb = rankOf(lb.road.r.class);
          if (ra !== rb) rel = ra < rb ? 'a' : 'b';
          else if (prio(A.turn) !== prio(B.turn)) rel = prio(A.turn) < prio(B.turn) ? 'a' : 'b';
          else rel = 'mutual';
        }
        if (rel === 'a') A.y.push(ib);
        else if (rel === 'b') B.y.push(ia);
        else if (rel === 'mutual') { A.m.push(ib); B.m.push(ia); }
      }
    }
  }

  // ---- junction records, signal heads
  // A head's pole stands on the kerb to the right of its approach, unless a lane or a turn passes that close (a right turn from
  // the outer lane sweeps round the corner just past the stop bar): then it moves further out, so no car's path meets the pole.
  const headGrid = new Map<string, number[]>();
  const headSegs: number[] = [];
  for (const e of edges) {
    const p = e.pts;
    for (let k = 0; k + 5 < p.length; k += 3) {
      const id = headSegs.length / 4;
      headSegs.push(p[k], p[k + 2], p[k + 3], p[k + 5]);
      for (let gx = Math.floor(Math.min(p[k], p[k + 3]) / 16); gx <= Math.floor(Math.max(p[k], p[k + 3]) / 16); gx++) {
        for (let gz = Math.floor(Math.min(p[k + 2], p[k + 5]) / 16); gz <= Math.floor(Math.max(p[k + 2], p[k + 5]) / 16); gz++) {
          const key = `${gx},${gz}`;
          const l = headGrid.get(key);
          if (l) l.push(id); else headGrid.set(key, [id]);
        }
      }
    }
  }
  const pathDist = (x: number, z: number): number => {
    let best = Infinity;
    for (let gx = Math.floor((x - 4) / 16); gx <= Math.floor((x + 4) / 16); gx++) {
      for (let gz = Math.floor((z - 4) / 16); gz <= Math.floor((z + 4) / 16); gz++) {
        for (const id of headGrid.get(`${gx},${gz}`) ?? []) {
          const ax = headSegs[id * 4], az = headSegs[id * 4 + 1], dx = headSegs[id * 4 + 2] - ax, dz = headSegs[id * 4 + 3] - az;
          const l2 = dx * dx + dz * dz;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
        }
      }
    }
    return best;
  };
  const records: LanesJunction[] = [];
  for (const node of nodes) {
    if (!connByNode.get(node)!.length && !node.legs.some((l) => l.arrive.length)) continue;
    const rec: LanesJunction = { id: node.id, x: round(node.x, 1), z: round(node.z, 1), control: node.control, ...(node.implicit ? { implicit: 1 as const } : {}) };
    if (node.control === 'signals' && node.src) {
      rec.legs = node.src.legs.map((l) => ({ dir: l.dir, approach: l.approach }));
      rec.heads = [];
      node.legs.forEach((leg) => {
        const l = leg.srcIndex >= 0 ? node.src!.legs[leg.srcIndex] : undefined;
        if (!l || !leg.arrive.length || !l.stopLine) return;
        // On the kerb to the right of the approach lanes, just past the stop bar.
        const tx = -l.dir[0], tz = -l.dir[1]; // direction of travel
        const rx = -tz, rz = tx; // right of travel
        const lanes = leg.arrive.map((id) => edges[id] as LaneEdge);
        const offs = lanes.map((e) => laneOffset(leg.road, e));
        const outer = Math.max(...offs);
        // the stop line is laid across the middle of the approach lanes
        let off = outer + leg.road.lw / 2 + 0.9 - offs.reduce((a, v) => a + v, 0) / offs.length;
        const at = (o: number): [number, number] => [l.stopLine![0] + rx * o + tx * 1.5, l.stopLine![2] + rz * o + tz * 1.5];
        for (let moved = 0; moved < HEAD_MAX_MOVE && pathDist(...at(off)) < HEAD_CLEAR; moved += 0.25) off += 0.25;
        const [hx, hz] = at(off);
        rec.heads!.push({
          leg: leg.srcIndex,
          x: round(hx, 2),
          y: round(l.stopLine[1], 2),
          z: round(hz, 2),
          yaw: round(Math.atan2(l.dir[0], l.dir[1]), 3),
        });
      });
    }
    records.push(rec);
  }
  records.push(...turnarounds);

  const lanesN = edges.filter((e) => e.t === 0).length;
  const stats: LaneStats = {
    lanes: lanesN,
    connectors: edges.length - lanesN,
    laneKm: round(edges.reduce((a, e) => a + (e.t === 0 ? e.len : 0), 0) / 1000, 2),
    junctions: records.filter((r) => !r.implicit).length,
    implicitJunctions: records.filter((r) => r.implicit).length,
    conflicts: conflictPairs,
    skippedLegs,
    largestComponent: 0,
    largestComponentStreets: 0,
  };
  const file: LanesFile = { format: 'hood-lanes', version: 1, edges, junctions: records, stats };
  const conn = connectivity(file);
  stats.largestComponent = round(conn.share, 4);
  stats.largestComponentStreets = round(conn.streetShare, 4);
  return file;
}

/** Lateral offset (to the right of travel) of a lane in its road. */
function laneOffset(road: Road, e: LaneEdge): number {
  if (road.r.oneway) return (e.k - (e.n - 1) / 2) * road.lw;
  return (road.oddMiddle ? road.lw / 2 : 0) + (e.k + 0.5) * road.lw;
}

/** The curve from the end of one lane to the start of another: a cubic that leaves and arrives along the lanes. */
function connectorPoints(from: LaneEdge, to: LaneEdge): V3[] {
  const fp = from.pts;
  const tp = to.pts;
  const n1 = fp.length / 3;
  const a: V3 = [fp[fp.length - 3], fp[fp.length - 2], fp[fp.length - 1]];
  const b: V3 = [tp[0], tp[1], tp[2]];
  // headings from the last / first segment
  let ax = a[0] - fp[(n1 - 2) * 3], az = a[2] - fp[(n1 - 2) * 3 + 2];
  let bx = tp[3] - b[0], bz = tp[5] - b[2];
  let l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
  l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l;
  const chord = Math.hypot(b[0] - a[0], b[2] - a[2]);
  if (chord < 0.3) return [a, b];
  const straight = ax * bx + az * bz > 0.9995 && Math.abs((b[0] - a[0]) * -az + (b[2] - a[2]) * ax) < 0.15;
  if (straight) return [a, b];
  const k = chord * 0.38;
  const p1: V3 = [a[0] + ax * k, 0, a[2] + az * k];
  const p2: V3 = [b[0] - bx * k, 0, b[2] - bz * k];
  const steps = Math.max(3, Math.min(6, Math.ceil(chord / 4)));
  const out: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push([w0 * a[0] + w1 * p1[0] + w2 * p2[0] + w3 * b[0], a[1] + (b[1] - a[1]) * t, w0 * a[2] + w1 * p1[2] + w2 * p2[2] + w3 * b[2]]);
  }
  return out;
}

function polylinesCross(a: [number, number][], b: [number, number][]): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
    }
  }
  return false;
}

function segCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const r0 = b[0] - a[0], r1 = b[1] - a[1];
  const s0 = d[0] - c[0], s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-9) return false;
  const q0 = c[0] - a[0], q1 = c[1] - a[1];
  const t = (q0 * s1 - q1 * s0) / den;
  const u = (q0 * r1 - q1 * r0) / den;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

// ---------------------------------------------------------------------------------------------
// Connectivity

/** Strongly connected components over the edges (Tarjan, iterative). `share` is the largest one's part of the lane length. */
export function connectivity(file: Pick<LanesFile, 'edges'>): { comp: Int32Array; largest: number; share: number; streetShare: number; sizes: number[] } {
  const edges = file.edges;
  const n = edges.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let idx = 0;
  let nc = 0;
  const it = new Int32Array(n);
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue;
    const call: number[] = [root];
    index[root] = low[root] = idx++;
    stack.push(root);
    onStack[root] = 1;
    while (call.length) {
      const v = call[call.length - 1];
      const ev = edges[v];
      const nx = ev.t === 1 ? null : ev.next;
      const count = nx ? nx.length : 1;
      if (it[v] < count) {
        const w = nx ? nx[it[v]++] : (it[v]++, (ev as ConnectorEdge).to);
        if (index[w] < 0) {
          index[w] = low[w] = idx++;
          stack.push(w);
          onStack[w] = 1;
          call.push(w);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        if (low[v] === index[v]) {
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = nc;
          } while (w !== v);
          nc++;
        }
        call.pop();
        if (call.length) {
          const u = call[call.length - 1];
          low[u] = Math.min(low[u], low[v]);
        }
      }
    }
  }
  const sizes = new Array<number>(nc).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (e.t !== 0) continue;
    sizes[comp[i]] += e.len;
    total += e.len;
  }
  let largest = 0;
  for (let c = 1; c < nc; c++) if (sizes[c] > sizes[largest]) largest = c;
  // Surface streets alone: freeways run off the clipped tile and cannot loop back, so they are judged apart.
  let streets = 0;
  let streetsIn = 0;
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (e.t !== 0 || /^(motorway|trunk)/.test(e.cls)) continue;
    streets += e.len;
    if (comp[i] === largest) streetsIn += e.len;
  }
  return { comp, largest, share: total > 0 ? (sizes[largest] ?? 0) / total : 0, streetShare: streets > 0 ? streetsIn / streets : 0, sizes };
}
