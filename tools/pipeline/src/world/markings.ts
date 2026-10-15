import type { V2 } from '../geo.js';
import { pointInRing } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import { ribbonEdges, ribbonIndices } from '../mesh/ribbon.js';
import { srgbToLinear } from './buildings.js';
import type { Junction, JunctionWayInput, Leg } from './junctions.js';
import { trimPolyline } from './junctions.js';
import type { NodeInfo } from './nodes.js';
import { laneWidth, type RoadWay } from './osm.js';

/**
 * Road markings, as one merged mesh with vertex colours (one material in the tile).
 *
 *  - centre lines: double yellow on two-way roads with an even number of lanes, a pair of solid yellow
 *    lines round the middle lane when there is an odd number (a centre turn lane);
 *  - white dashed lane dividers from `lanes`;
 *  - white solid edge lines on motorways and trunk roads (and their links);
 *  - zebra crosswalks on every OSM crossing way, where it lies on the road, and across every leg of a
 *    signalised junction that has none close by;
 *  - stop bars on the approaches to signalised and stop-controlled junctions.
 *
 * Everything is laid 3 cm above the road surface (the client adds a polygon offset on top).
 */

export const MARK_LIFT = 0.03;
/** zebra crosswalks sit at this height over the ground regardless of the road under them (sidewalks 10 cm, asphalt up to 10 cm). */
export const CROSSWALK_LIFT = 0.14;

const WHITE = (() => { const v = srgbToLinear(0.9); return [v, v, v] as [number, number, number]; })();
const YELLOW = [srgbToLinear(0.93), srgbToLinear(0.72), srgbToLinear(0.1)] as [number, number, number];

const LINE_WIDTH = 0.13;
const EDGE_WIDTH = 0.16;
const CROSSWALK_DEPTH = 3.0;
const ZEBRA_BAR = 0.5;
const ZEBRA_PITCH = 1.0;
const STOP_BAR_DEPTH = 0.5;
/** room kept clear of centre and lane lines at a junction end for a crosswalk and a stop bar */
export const JUNCTION_INSET = 5.0;

export type Control = 'signals' | 'stop' | 'none';

/** Offsets a polyline sideways by `offset` metres (positive to the right of the direction of travel). */
export function offsetPolyline(pts: V2[], offset: number): V2[] {
  if (Math.abs(offset) < 1e-6) return pts;
  const e = ribbonEdges(pts, Math.abs(offset));
  return offset > 0 ? e.right : e.left;
}

/** Splits a polyline (with optional values per point) into dashes: `dash` m on, `gap` m off, from `start` to `end`. */
export function dashSlices(pts: V2[], vals: number[] | null, dash: number, gap: number, start: number, end: number): { pts: V2[]; vals?: number[] }[] {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const out: { pts: V2[]; vals?: number[] }[] = [];
  const stop = total - end;
  const period = dash + gap;
  const n = Math.floor((stop - start + gap) / period);
  // centre the pattern in the available length so both ends look alike
  const used = n > 0 ? n * dash + (n - 1) * gap : 0;
  const s0 = start + (stop - start - used) / 2;
  for (let k = 0; k < n; k++) {
    const a = s0 + k * period;
    const t = trimPolyline({ pts, vals: vals ?? undefined }, a, total - (a + dash));
    if (t) out.push({ pts: t.pts, vals: t.vals });
  }
  return out;
}

/** Adds a strip of `width` along `pts` (heights from `vals` plus lift, or from the ground). */
export function addStrip(
  mesh: MeshBuilder,
  pts: V2[],
  vals: number[] | null | undefined,
  width: number,
  color: [number, number, number],
  ground: (x: number, z: number) => number,
  lift: number,
): void {
  if (pts.length < 2) return;
  const { left, right } = ribbonEdges(pts, width / 2);
  const base = mesh.vertexCount;
  for (let i = 0; i < pts.length; i++) {
    const yl = vals ? vals[i] + lift : ground(left[i][0], left[i][1]) + lift;
    const yr = vals ? vals[i] + lift : ground(right[i][0], right[i][1]) + lift;
    mesh.vertex(left[i][0], yl, left[i][1], 0, 1, 0, ...color);
    mesh.vertex(right[i][0], yr, right[i][1], 0, 1, 0, ...color);
  }
  mesh.indices.push(...ribbonIndices(pts.length, base));
}

/** A rectangle `length` long (along `dir`) and `thickness` wide centred on `c`. */
export function addBar(
  mesh: MeshBuilder,
  c: V2,
  dir: V2,
  length: number,
  thickness: number,
  color: [number, number, number],
  ground: (x: number, z: number) => number,
  lift: number,
): void {
  const ax = dir[0] * length / 2, az = dir[1] * length / 2;
  const bx = -dir[1] * thickness / 2, bz = dir[0] * thickness / 2;
  const corners: V2[] = [[c[0] - ax - bx, c[1] - az - bz], [c[0] + ax - bx, c[1] + az - bz], [c[0] + ax + bx, c[1] + az + bz], [c[0] - ax + bx, c[1] - az + bz]];
  const base = mesh.vertexCount;
  for (const p of corners) mesh.vertex(p[0], ground(p[0], p[1]) + lift, p[1], 0, 1, 0, ...color);
  // wind so the face looks up
  const ux = corners[1][0] - corners[0][0], uz = corners[1][1] - corners[0][1];
  const wx = corners[3][0] - corners[0][0], wz = corners[3][1] - corners[0][1];
  if (uz * wx - ux * wz >= 0) mesh.quad(base, base + 1, base + 2, base + 3);
  else mesh.quad(base, base + 3, base + 2, base + 1);
}

/** Which points lie on a road: segments with half widths, and junction polygons. */
export class RoadMask {
  private cell = 32;
  private grid = new Map<string, number[]>();
  private segs: { a: V2; b: V2; half: number }[] = [];
  private polys: { ring: V2[]; minX: number; minZ: number; maxX: number; maxZ: number }[] = [];

  addPolyline(pts: V2[], half: number): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      const k = this.segs.length;
      this.segs.push({ a: pts[i], b: pts[i + 1], half });
      const r = half + 1;
      for (let x = Math.floor((Math.min(pts[i][0], pts[i + 1][0]) - r) / this.cell); x <= Math.floor((Math.max(pts[i][0], pts[i + 1][0]) + r) / this.cell); x++) {
        for (let z = Math.floor((Math.min(pts[i][1], pts[i + 1][1]) - r) / this.cell); z <= Math.floor((Math.max(pts[i][1], pts[i + 1][1]) + r) / this.cell); z++) {
          const key = `${x},${z}`;
          const a = this.grid.get(key);
          if (a) a.push(k); else this.grid.set(key, [k]);
        }
      }
    }
  }

  addPolygon(ring: V2[]): void {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of ring) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    this.polys.push({ ring, minX, minZ, maxX, maxZ });
  }

  /** Unit direction of the road whose centreline is nearest (x, z), if one is within reach. */
  directionAt(x: number, z: number): V2 | null {
    let best = Infinity;
    let dir: V2 | null = null;
    for (const k of this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? []) {
      const s = this.segs[k];
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const l2 = dx * dx + dz * dz;
      if (l2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2));
      const d = Math.hypot(x - (s.a[0] + t * dx), z - (s.a[1] + t * dz)) - s.half;
      if (d < best) { best = d; const l = Math.sqrt(l2); dir = [dx / l, dz / l]; }
    }
    return dir;
  }

  /** True when (x, z) is on a road surface, `margin` metres inside its edge. */
  contains(x: number, z: number, margin = 0): boolean {
    for (const k of this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? []) {
      const s = this.segs[k];
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2));
      if (Math.hypot(x - (s.a[0] + t * dx), z - (s.a[1] + t * dz)) <= s.half - margin) return true;
    }
    for (const p of this.polys) {
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      if (pointInRing(x, z, p.ring)) return true;
    }
    return false;
  }
}

/** Zebra bars along a crossing's centreline: bars run along the road, spaced along the crossing. Only bars whose centre is on the road are laid. Returns the number of bars. */
export function addZebra(
  mesh: MeshBuilder,
  pts: V2[],
  onRoad: (x: number, z: number) => boolean,
  ground: (x: number, z: number) => number,
  lift = CROSSWALK_LIFT,
  roadDir?: (x: number, z: number) => V2 | null,
): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (total < 2) return 0;
  const n = Math.max(1, Math.floor((total - ZEBRA_BAR) / ZEBRA_PITCH) + 1);
  const used = (n - 1) * ZEBRA_PITCH;
  let count = 0;
  for (let k = 0; k < n; k++) {
    const s = (total - used) / 2 + k * ZEBRA_PITCH;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc + l >= s || i === pts.length - 1) {
        const t = l > 0 ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
        const c: V2 = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
        const across: V2 = l > 0 ? [(pts[i][0] - pts[i - 1][0]) / l, (pts[i][1] - pts[i - 1][1]) / l] : [1, 0];
        if (onRoad(c[0], c[1])) {
          // the bar runs along the road (or, without a road to ask, perpendicular to the way of the crossing)
          const rd = roadDir?.(c[0], c[1]);
          addBar(mesh, c, rd ?? [-across[1], across[0]], CROSSWALK_DEPTH, ZEBRA_BAR, WHITE, ground, lift);
          count++;
        }
        break;
      }
      acc += l;
    }
  }
  return count;
}

export interface MarkingLineSpec {
  /** lateral offset from the centreline (m, positive to the right) */
  offset: number;
  width: number;
  color: [number, number, number];
  /** [dash, gap] in metres, or null for a solid line */
  dash: [number, number] | null;
  /** keep clear of the junction ends of the run */
  clearOfJunctions: boolean;
}

/** The lines painted along a road, from its class and lanes (see the module comment). */
export function lineSpecs(way: Pick<RoadWay, 'highway' | 'lanes' | 'oneway' | 'width'>): MarkingLineSpec[] {
  const base = way.highway.replace(/_link$/, '');
  const freeway = base === 'motorway' || base === 'trunk';
  const lanes = Math.max(1, way.lanes);
  const lw = laneWidth(way.highway);
  const specs: MarkingLineSpec[] = [];
  const dash: [number, number] = freeway ? [3, 9] : [2, 6];
  if (freeway) {
    const e = Math.min(way.width / 2 - 0.2, (lanes * lw) / 2);
    for (const side of [-1, 1]) specs.push({ offset: side * e, width: EDGE_WIDTH, color: WHITE, dash: null, clearOfJunctions: false });
  }
  const urban = base === 'primary' || base === 'secondary' || base === 'tertiary' || base === 'unclassified' || base === 'trunk' || base === 'motorway';
  if (!urban || way.highway === 'service') return specs;
  if (way.oneway) {
    for (let k = 1; k < lanes; k++) specs.push({ offset: (-lanes / 2 + k) * lw, width: LINE_WIDTH, color: WHITE, dash, clearOfJunctions: true });
    return specs;
  }
  if (lanes < 2) return specs;
  if (lanes % 2 === 0) {
    for (const side of [-1, 1]) specs.push({ offset: side * 0.15, width: LINE_WIDTH, color: YELLOW, dash: null, clearOfJunctions: true });
    const per = lanes / 2;
    for (let k = 1; k < per; k++) for (const side of [-1, 1]) specs.push({ offset: side * k * lw, width: LINE_WIDTH, color: WHITE, dash, clearOfJunctions: true });
  } else {
    // odd: the middle lane is a centre turn lane, bounded by yellow
    for (const side of [-1, 1]) specs.push({ offset: side * lw / 2, width: LINE_WIDTH, color: YELLOW, dash: null, clearOfJunctions: true });
    const per = (lanes - 1) / 2;
    for (let k = 1; k < per; k++) for (const side of [-1, 1]) specs.push({ offset: side * (lw / 2 + k * lw), width: LINE_WIDTH, color: WHITE, dash, clearOfJunctions: true });
  }
  return specs;
}

export interface RunInput {
  way: RoadWay;
  pts: V2[];
  deckY: number[] | null;
  startJ?: number;
  endJ?: number;
}

/** Paints the lines of one run of road. Returns the number of lines laid. */
export function addRunLines(
  mesh: MeshBuilder,
  run: RunInput,
  ground: (x: number, z: number) => number,
  lift: number,
): number {
  if (run.pts.length < 2) return 0;
  const specs = lineSpecs(run.way);
  if (!specs.length) return 0;
  let total = 0;
  for (let i = 1; i < run.pts.length; i++) total += Math.hypot(run.pts[i][0] - run.pts[i - 1][0], run.pts[i][1] - run.pts[i - 1][1]);
  if (total < 6) return 0;
  let n = 0;
  for (const spec of specs) {
    const o = offsetPolyline(run.pts, spec.offset);
    const start = spec.clearOfJunctions && run.startJ !== undefined ? JUNCTION_INSET : 0;
    const end = spec.clearOfJunctions && run.endJ !== undefined ? JUNCTION_INSET : 0;
    if (total - start - end < 3) continue;
    if (spec.dash) {
      for (const d of dashSlices(o, run.deckY, spec.dash[0], spec.dash[1], start, end)) { addStrip(mesh, d.pts, d.vals, spec.width, spec.color, ground, lift); n++; }
    } else {
      const t = trimPolyline({ pts: o, vals: run.deckY ?? undefined }, start, end);
      if (t) { addStrip(mesh, t.pts, t.vals, spec.width, spec.color, ground, lift); n++; }
    }
  }
  return n;
}

export interface LegControl {
  control: Control;
  /** stop bar position (x, z) at the middle of the bar, and the bar's lateral extent */
  stopLine?: { x: number; z: number };
  crosswalk: boolean;
}

export interface JunctionControl {
  control: Control;
  legs: LegControl[];
}

export interface SignalPoint { node: number; pos: V2; junction: number | null }
export interface StopPoint { node: number; pos: V2; direction: 'forward' | 'backward' | 'both'; all: boolean; junction: number | null }

export interface Controls {
  junctions: JunctionControl[];
  signals: SignalPoint[];
  stops: StopPoint[];
}

/** How far along a road (m) a sign or signal on an approach may be from the junction it belongs to. */
const CONTROL_REACH = 40;

/**
 * Works out which junctions are signalised or stop-controlled, and which legs have a stop sign, from the
 * OSM nodes: a signal or stop on a junction node, or on the road up to 40 m before it, belongs to that
 * junction (a stop sign applies to the legs its `direction` says).
 */
export function assignControls(junctions: Junction[], junctionAt: Map<number, number>, ways: JunctionWayInput[], nodes: Map<number, NodeInfo>): Controls {
  const occ = new Map<number, { way: number; index: number }[]>();
  ways.forEach((w, wi) => w.nodeIds.forEach((id, i) => {
    if (id <= 0 || !nodes.has(id)) return;
    const a = occ.get(id);
    if (a) a.push({ way: wi, index: i }); else occ.set(id, [{ way: wi, index: i }]);
  }));
  const jc: JunctionControl[] = junctions.map((j) => ({ control: 'none', legs: j.legs.map(() => ({ control: 'none', crosswalk: false })) }));
  const signals: SignalPoint[] = [];
  const stops: StopPoint[] = [];

  /** First junction reached from (way, index) walking in `t` direction, within reach: its index and the node index. */
  const reach = (way: number, index: number, t: 1 | -1): { j: number; at: number } | null => {
    const w = ways[way];
    let acc = 0;
    for (let i = index; i >= 0 && i < w.pts.length; i += t) {
      if (i !== index) acc += Math.hypot(w.pts[i][0] - w.pts[i - t][0], w.pts[i][1] - w.pts[i - t][1]);
      if (acc > CONTROL_REACH) return null;
      const j = junctionAt.get(w.nodeIds[i]);
      if (j !== undefined) return { j, at: i };
    }
    return null;
  };

  for (const [id, info] of nodes) {
    const here = occ.get(id);
    if (!here) continue;
    if (info.signals) {
      let owner: number | null = null;
      for (const o of here) {
        const a = reach(o.way, o.index, 1), b = reach(o.way, o.index, -1);
        const pick = a && b ? (Math.abs(a.at - o.index) <= Math.abs(b.at - o.index) ? a : b) : a ?? b;
        if (pick) { owner = pick.j; break; }
      }
      if (owner !== null) jc[owner].control = 'signals';
      signals.push({ node: id, pos: info.pos, junction: owner });
    }
    if (info.stop) {
      let owner: number | null = null;
      for (const o of here) {
        const dirs: (1 | -1)[] = info.stop.direction === 'forward' ? [1] : info.stop.direction === 'backward' ? [-1] : [1, -1];
        for (const t of dirs) {
          const r = reach(o.way, o.index, t);
          if (!r) continue;
          owner = r.j;
          const legs = junctions[r.j].legs;
          legs.forEach((l, li) => {
            const arrivesHere = l.way === o.way && l.index === r.at && l.s === -t;
            if (info.stop!.all || arrivesHere) { if (jc[r.j].legs[li].control === 'none') jc[r.j].legs[li].control = 'stop'; }
          });
        }
      }
      stops.push({ node: id, pos: info.pos, direction: info.stop.direction, all: info.stop.all, junction: owner });
    }
  }
  junctions.forEach((j, ji) => {
    const c = jc[ji];
    if (c.control === 'signals') c.legs.forEach((l, li) => { if (j.legs[li].approach) l.control = 'signals'; });
    else if (c.legs.some((l) => l.control === 'stop')) c.control = 'stop';
  });
  return { junctions: jc, signals, stops };
}

/** The stop bar and (for signalised junctions) crosswalk of one approach leg. */
export function addLegMarkings(
  mesh: MeshBuilder,
  leg: Leg,
  ctl: LegControl,
  liftOf: number,
  ground: (x: number, z: number) => number,
  onRoad: (x: number, z: number) => boolean,
  addCrosswalk: boolean,
): { stopLine?: { x: number; z: number }; crosswalk: boolean } {
  const d = leg.d;
  const along = (t: number): V2 => [leg.p[0] + d[0] * t, leg.p[1] + d[1] * t];
  let t = leg.trim + 0.6;
  let crosswalk = false;
  if (addCrosswalk && leg.trim > 0) {
    const c = along(leg.trim + 0.4 + CROSSWALK_DEPTH / 2);
    const across: V2 = [-d[1], d[0]];
    const h = leg.half - 0.4;
    const pts: V2[] = [[c[0] - across[0] * h, c[1] - across[1] * h], [c[0] + across[0] * h, c[1] + across[1] * h]];
    crosswalk = addZebra(mesh, pts, onRoad, ground, CROSSWALK_LIFT, () => d) > 0;
    t = leg.trim + 0.4 + CROSSWALK_DEPTH + 0.7;
  }
  if (ctl.control === 'none' || !leg.approach) return { crosswalk };
  // the bar covers the approaching lanes: the right-hand half of the road (right of the heading -d), or all of a one-way road
  const laneHalf = Math.min(leg.half, (Math.max(1, leg.lanes) * laneWidth(leg.highway)) / 2);
  const nR: V2 = [d[1], -d[0]];
  const lo = leg.oneway ? -laneHalf + 0.2 : 0.35;
  const hi = laneHalf - 0.2;
  if (hi - lo < 0.6) return { crosswalk };
  const c = along(t + STOP_BAR_DEPTH / 2);
  const mid = (lo + hi) / 2;
  const centre: V2 = [c[0] + nR[0] * mid, c[1] + nR[1] * mid];
  // the bar's long axis lies across the road
  addBar(mesh, centre, nR, hi - lo, STOP_BAR_DEPTH, WHITE, ground, liftOf + MARK_LIFT);
  return { stopLine: { x: centre[0], z: centre[1] }, crosswalk };
}

export interface JunctionsFile {
  junctions: {
    id: string;
    x: number; y: number; z: number;
    control: Control;
    nodes: number[];
    polygon: [number, number][];
    legs: {
      road: string;
      node: number;
      /** the OSM node's position (x, z), where the leg meets the junction */
      at: [number, number];
      dir: [number, number];
      approach: boolean;
      departure: boolean;
      trim: number;
      control: Control;
      stopLine: [number, number, number] | null;
      crosswalk: boolean;
    }[];
  }[];
  signals: { node: number; x: number; y: number; z: number; junction: string | null }[];
  stops: { node: number; x: number; y: number; z: number; direction: 'forward' | 'backward' | 'both'; all: boolean; junction: string | null }[];
  crossings: { id: number; points: [number, number, number][]; signals: boolean }[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** junctions.json: the junction polygons with their legs, control and stop lines, plus the signal, stop sign and crossing positions. */
export function exportJunctions(
  junctions: Junction[],
  controls: Controls,
  wayId: (l: Leg) => string,
  liftOf: (l: Leg) => number,
  ground: (x: number, z: number) => number,
  crossings: { id: number; points: [number, number, number][]; signals: boolean }[],
): JunctionsFile {
  const id = (i: number | null) => (i === null ? null : `j${i}`);
  return {
    junctions: junctions.map((j, ji) => {
      const jc = controls.junctions[ji];
      return {
        id: `j${ji}`,
        x: r2(j.center[0]),
        y: r2(ground(j.center[0], j.center[1]) + Math.max(...j.legs.map(liftOf))),
        z: r2(j.center[1]),
        control: jc.control,
        nodes: j.nodeIds,
        polygon: j.polygon.map((p) => [r1(p.x), r1(p.z)] as [number, number]),
        legs: j.legs.map((l, li) => {
          const lc = jc.legs[li];
          return {
            road: wayId(l),
            node: l.node,
            at: [r2(l.p[0]), r2(l.p[1])] as [number, number],
            dir: [r2(l.d[0]), r2(l.d[1])] as [number, number],
            approach: l.approach,
            departure: l.departure,
            trim: r1(l.trim),
            control: lc.control,
            stopLine: lc.stopLine ? [r2(lc.stopLine.x), r2(ground(lc.stopLine.x, lc.stopLine.z) + liftOf(l)), r2(lc.stopLine.z)] as [number, number, number] : null,
            crosswalk: lc.crosswalk,
          };
        }),
      };
    }),
    signals: controls.signals.map((s) => ({ node: s.node, x: r2(s.pos[0]), y: r2(ground(s.pos[0], s.pos[1])), z: r2(s.pos[1]), junction: id(s.junction) })),
    stops: controls.stops.map((s) => ({ node: s.node, x: r2(s.pos[0]), y: r2(ground(s.pos[0], s.pos[1])), z: r2(s.pos[1]), direction: s.direction, all: s.all, junction: id(s.junction) })),
    crossings,
  };
}

export { MeshBuilder };
