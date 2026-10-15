import type { Rect, V2 } from '../geo.js';
import { pointInRing, resample, ringBounds, segmentIntersection } from '../geo.js';
import type { MeshBuilder } from '../mesh/builder.js';
import { ribbonEdges, ribbonIndices } from '../mesh/ribbon.js';
import { RoadMask, type JunctionsFile } from './markings.js';
import type { RoadWay } from './osm.js';
import type { RoadJson } from './roads.js';

/**
 * The walk network (`paths.json`): the graph pedestrians route over.
 *
 * It is built from what the pipeline already parses, in this order:
 *   1. every mapped sidewalk, footway, pedestrian street, path, set of steps, crossing and traffic island
 *   2. synthetic sidewalks along both curbs of a street wherever OSM maps none (4 m samples, in runs)
 *   3. a building clearance pass: vertices inside a footprint cut the path there, vertices closer than half a metre to a wall are pushed out
 *   4. zebra and implicit crossings across the legs of junctions that have no mapped crossing, and a link pass that joins dead ends to
 *      the network (so a T where the mapper left the nodes apart still connects)
 *   5. small islands are dropped, straight chains are merged, ids are renumbered.
 * Each crossing carries the junction and the junction leg it crosses, so the sim can ask the signal phases for a walk light.
 */

export type PathKind = 'sidewalk' | 'synthetic' | 'footway' | 'pedestrian' | 'crossing' | 'island' | 'link' | 'steps';

export interface CrossingMeta {
  /** OSM way id, or null for crossings the pipeline made */
  id: number | null;
  /** zebra stripes are painted */
  marked: boolean;
  /** a walk light controls it (the OSM node says so, or the junction is signalised) */
  signals: boolean;
  /** junctions.json id of the junction whose leg it crosses, or null for a mid-block crossing */
  junction: string | null;
  /** index into that junction's `legs`: the leg whose lanes the walker crosses */
  leg: number | null;
  /** roads.json id of the road crossed */
  road: string | null;
}

export interface PathAttr {
  kind: PathKind;
  width: number;
  /** on a bridge deck (the node heights are the deck's) */
  bridge?: true;
  crossing?: CrossingMeta;
}

export interface PathsStats {
  nodes: number;
  edges: number;
  lengthM: number;
  lengthByKind: Record<string, number>;
  components: number;
  /** share of the total length that is in the largest connected component, 0..1 */
  largestShare: number;
  crossings: { total: number; marked: number; signals: number; atJunctions: number; made: number };
  droppedByBuildings: number;
  droppedIslandsM: number;
  syntheticM: number;
}

export interface PathsFile {
  version: 1;
  /** [x, y, z] */
  nodes: [number, number, number][];
  attrs: PathAttr[];
  /** flat triples: node a, node b, attr index */
  edges: number[];
  stats: PathsStats;
}

export interface PathsInput {
  ways: RoadWay[];
  roads: RoadJson[];
  junctions: JunctionsFile;
  /** OSM crossing way id -> whether a node on it says crossing=traffic_signals */
  crossingSignals: Map<number, boolean>;
  /** building outlines (outer ring first) */
  footprints: V2[][][];
  bounds: Rect;
  ground: (x: number, z: number) => number;
  /** deck surface height at OSM nodes of footways on a bridge */
  deckY?: Map<number, number>;
}

const SYN_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
/** Distance from a road's centreline to a synthetic sidewalk is the half width plus this (m). */
export const SYNTHETIC_OFFSET = 2.0;
export const SYNTHETIC_WIDTH = 2.0;
const WALK_LIFT = 0.1;
/** The sim's capsule is 0.32 m wide: keep path vertices this far from a wall. */
const WALL_CLEAR = 0.5;
const MIN_COMPONENT_M = 40;

// ------------------------------------------------------------------------------------------------
// Geometry helpers

export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number; x: number; z: number } {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const x = ax + t * dx, z = az + t * dz;
  return { d: Math.hypot(px - x, pz - z), t, x, z };
}

/** Building outlines in a grid: how far a point is from the nearest wall, and on which side. */
export class BuildingIndex {
  private readonly cell = 32;
  private readonly grid = new Map<number, number[]>();
  private readonly boxes: Rect[];

  constructor(readonly rings: V2[][]) {
    this.boxes = rings.map((r) => ringBounds(r));
    rings.forEach((_, i) => {
      const b = this.boxes[i];
      for (let x = Math.floor(b.minX / this.cell); x <= Math.floor(b.maxX / this.cell); x++) {
        for (let z = Math.floor(b.minZ / this.cell); z <= Math.floor(b.maxZ / this.cell); z++) {
          const k = this.key(x, z);
          const a = this.grid.get(k);
          if (a) a.push(i);
          else this.grid.set(k, [i]);
        }
      }
    });
  }

  private key(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /**
   * The nearest wall within `maxD`: signed distance (negative inside a footprint), the nearest wall point and the
   * outward unit normal there. Null when no wall is within `maxD`.
   */
  nearest(x: number, z: number, maxD = 2): { d: number; px: number; pz: number; nx: number; nz: number } | null {
    const seen = new Set<number>();
    let best: { d: number; px: number; pz: number; inside: boolean } | null = null;
    for (let ix = Math.floor((x - maxD) / this.cell); ix <= Math.floor((x + maxD) / this.cell); ix++) {
      for (let iz = Math.floor((z - maxD) / this.cell); iz <= Math.floor((z + maxD) / this.cell); iz++) {
        for (const i of this.grid.get(this.key(ix, iz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const b = this.boxes[i];
          if (x < b.minX - maxD || x > b.maxX + maxD || z < b.minZ - maxD || z > b.maxZ + maxD) continue;
          const r = this.rings[i];
          let rd = Infinity, rx = 0, rz = 0;
          for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
            const s = distToSegment(x, z, r[j][0], r[j][1], r[k][0], r[k][1]);
            if (s.d < rd) { rd = s.d; rx = s.x; rz = s.z; }
          }
          const inside = pointInRing(x, z, r);
          if (inside || rd <= maxD) {
            if (!best || (inside && !best.inside) || (inside === best.inside && rd < best.d)) best = { d: rd, px: rx, pz: rz, inside };
          }
        }
      }
    }
    if (!best) return null;
    let nx = x - best.px, nz = z - best.pz;
    const l = Math.hypot(nx, nz);
    if (l < 1e-6) { nx = 0; nz = 0; } else { nx /= l; nz /= l; }
    if (best.inside) { nx = -nx; nz = -nz; }
    return { d: best.inside ? -best.d : best.d, px: best.px, pz: best.pz, nx, nz };
  }

  /** Signed distance to the nearest wall; `maxD` when none is nearer (negative inside a building). */
  signedDistance(x: number, z: number, maxD = 2): number {
    const n = this.nearest(x, z, maxD);
    return n ? n.d : maxD;
  }
}

/** A cell grid of segments of the graph; the geometry is read back from the graph, so edges may be split later. */
class SegGrid {
  private readonly cell = 8;
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly geom: (e: number) => [number, number, number, number]) {}

  private key(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  add(e: number, ax: number, az: number, bx: number, bz: number) {
    const x0 = Math.floor(Math.min(ax, bx) / this.cell), x1 = Math.floor(Math.max(ax, bx) / this.cell);
    const z0 = Math.floor(Math.min(az, bz) / this.cell), z1 = Math.floor(Math.max(az, bz) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = this.key(x, z);
        const a = this.cells.get(k);
        if (a) a.push(e);
        else this.cells.set(k, [e]);
      }
    }
  }

  /** Nearest segment within `r` for which `accept(edge)` is true. */
  nearest(x: number, z: number, r: number, accept: (e: number) => boolean = () => true): { e: number; d: number; t: number; x: number; z: number } | null {
    let best: { e: number; d: number; t: number; x: number; z: number } | null = null;
    const seen = new Set<number>();
    for (let ix = Math.floor((x - r) / this.cell); ix <= Math.floor((x + r) / this.cell); ix++) {
      for (let iz = Math.floor((z - r) / this.cell); iz <= Math.floor((z + r) / this.cell); iz++) {
        for (const e of this.cells.get(this.key(ix, iz)) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          if (!accept(e)) continue;
          const [ax, az, bx, bz] = this.geom(e);
          const s = distToSegment(x, z, ax, az, bx, bz);
          if (s.d <= r && (!best || s.d < best.d)) best = { e, d: s.d, t: s.t, x: s.x, z: s.z };
        }
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------------------------------------
// The graph under construction

interface Poly {
  pts: V2[];
  ys: (number | null)[];
  /** OSM node ids, 0 where there is none */
  ids: number[];
  attr: number;
}

class Builder {
  nx: number[] = [];
  ny: number[] = [];
  nz: number[] = [];
  ea: number[] = [];
  eb: number[] = [];
  eattr: number[] = [];
  ealive: boolean[] = [];
  attrs: PathAttr[] = [];
  private attrKey = new Map<string, number>();
  private byId = new Map<number, number>();
  private nodeGrid = new Map<number, number[]>();
  segs = new SegGrid((e) => [this.nx[this.ea[e]], this.nz[this.ea[e]], this.nx[this.eb[e]], this.nz[this.eb[e]]]);

  attr(kind: PathKind, width: number, bridge: boolean, crossing?: CrossingMeta): number {
    const a: PathAttr = { kind, width: Math.round(width * 10) / 10, ...(bridge ? { bridge: true as const } : {}), ...(crossing ? { crossing } : {}) };
    // crossings are unique per way; everything else dedupes
    const key = crossing ? `${kind}:${JSON.stringify(crossing)}:${a.width}` : `${kind}:${a.width}:${bridge}`;
    let i = this.attrKey.get(key);
    if (i === undefined) {
      i = this.attrs.length;
      this.attrs.push(a);
      this.attrKey.set(key, i);
    }
    return i;
  }

  private gk(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  node(x: number, y: number, z: number, id = 0): number {
    if (id > 0) {
      const hit = this.byId.get(id);
      if (hit !== undefined) return hit;
    }
    const cx = Math.floor(x / 2), cz = Math.floor(z / 2);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const n of this.nodeGrid.get(this.gk(ix, iz)) ?? []) {
          if (Math.hypot(this.nx[n] - x, this.nz[n] - z) < 0.5 && Math.abs(this.ny[n] - y) < 2) {
            if (id > 0) this.byId.set(id, n);
            return n;
          }
        }
      }
    }
    return this.newNode(x, y, z, id);
  }

  newNode(x: number, y: number, z: number, id = 0): number {
    const n = this.nx.length;
    this.nx.push(x); this.ny.push(y); this.nz.push(z);
    const k = this.gk(Math.floor(x / 2), Math.floor(z / 2));
    const a = this.nodeGrid.get(k);
    if (a) a.push(n); else this.nodeGrid.set(k, [n]);
    if (id > 0) this.byId.set(id, n);
    return n;
  }

  nearestNode(x: number, z: number, r: number, accept: (n: number) => boolean = () => true): number {
    let best = -1, bd = r;
    for (let ix = Math.floor((x - r) / 2); ix <= Math.floor((x + r) / 2); ix++) {
      for (let iz = Math.floor((z - r) / 2); iz <= Math.floor((z + r) / 2); iz++) {
        for (const n of this.nodeGrid.get(this.gk(ix, iz)) ?? []) {
          const d = Math.hypot(this.nx[n] - x, this.nz[n] - z);
          if (d < bd && accept(n)) { bd = d; best = n; }
        }
      }
    }
    return best;
  }

  edge(a: number, b: number, attr: number): number {
    if (a === b) return -1;
    const e = this.ea.length;
    this.ea.push(a); this.eb.push(b); this.eattr.push(attr); this.ealive.push(true);
    this.segs.add(e, this.nx[a], this.nz[a], this.nx[b], this.nz[b]);
    return e;
  }

  /** Splits an edge at a point (on it), returning the new node. */
  split(e: number, x: number, z: number): number {
    const a = this.ea[e], b = this.eb[e];
    const t = Math.hypot(x - this.nx[a], z - this.nz[a]) / (Math.hypot(this.nx[b] - this.nx[a], this.nz[b] - this.nz[a]) || 1);
    const y = this.ny[a] + (this.ny[b] - this.ny[a]) * Math.max(0, Math.min(1, t));
    const m = this.newNode(x, y, z);
    this.eb[e] = m;
    this.edge(m, b, this.eattr[e]);
    return m;
  }

  len(e: number): number {
    return Math.hypot(this.nx[this.eb[e]] - this.nx[this.ea[e]], this.nz[this.eb[e]] - this.nz[this.ea[e]]);
  }

  addPoly(p: Poly) {
    let prev = -1;
    for (let i = 0; i < p.pts.length; i++) {
      const n = this.node(p.pts[i][0], p.ys[i] ?? 0, p.pts[i][1], p.ids[i]);
      if (prev >= 0 && prev !== n) this.edge(prev, n, p.attr);
      prev = n;
    }
  }

  adjacency(): number[][] {
    const adj: number[][] = this.nx.map(() => []);
    for (let e = 0; e < this.ea.length; e++) if (this.ealive[e]) { adj[this.ea[e]].push(e); adj[this.eb[e]].push(e); }
    return adj;
  }
}

class Dsu {
  p: number[] = [];
  constructor(n: number) { for (let i = 0; i < n; i++) this.p.push(i); }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a: number, b: number) { this.p[this.find(a)] = this.find(b); }
  grow(n: number) { while (this.p.length < n) this.p.push(this.p.length); }
}

// ------------------------------------------------------------------------------------------------

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

function kindOfWay(w: RoadWay): PathKind {
  if (w.sub === 'crossing') return 'crossing';
  if (w.sub === 'traffic_island') return 'island';
  if (w.sub === 'sidewalk') return 'sidewalk';
  if (w.highway === 'steps') return 'steps';
  if (w.highway === 'pedestrian') return 'pedestrian';
  return 'footway';
}

/** Stops of a way's vertices that lie inside the bounds, as runs. */
function inBoundsRuns(w: RoadWay, b: Rect): { from: number; to: number }[] {
  const inside = w.pts.map((p) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minZ && p[1] <= b.maxZ);
  const runs: { from: number; to: number }[] = [];
  let i = 0;
  while (i < inside.length) {
    if (!inside[i]) { i++; continue; }
    let j = i;
    while (j + 1 < inside.length && inside[j + 1]) j++;
    if (j > i) runs.push({ from: i, to: j });
    i = j + 1;
  }
  return runs;
}

function resampleWithIds(pts: V2[], ids: number[], maxLen: number): { pts: V2[]; ids: number[] } {
  const op: V2[] = [pts[0]];
  const oi: number[] = [ids[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      op.push(k === n ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      oi.push(k === n ? ids[i] : 0);
    }
  }
  return { pts: op, ids: oi };
}

export interface PathsResult {
  file: PathsFile;
  /** synthetic sidewalk polylines (x, z), for the ribbon mesh */
  syntheticLines: { pts: V2[]; ys: number[] }[];
}

export function buildPaths(inp: PathsInput): PathsResult {
  const { ways, roads, junctions, bounds, ground } = inp;
  const inBounds = (x: number, z: number) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  const bIdx = new BuildingIndex(inp.footprints.map((f) => f[0]));
  const stats = { droppedByBuildings: 0, droppedIslandsM: 0, syntheticM: 0 };

  // car roads as a mask: where a walker must not link across
  const mask = new RoadMask();
  for (const w of ways) if (w.kind === 'car' && !w.bridge) mask.addPolyline(w.pts, w.width / 2);
  for (const j of junctions.junctions) mask.addPolygon(j.polygon);

  const nodePos = new Map<number, V2>();
  for (const w of ways) w.nodeIds.forEach((id, i) => { if (id > 0) nodePos.set(id, w.pts[i]); });

  // road segments for working out which road a crossing crosses
  const roadSegs: { a: V2; b: V2; road: string }[] = [];
  for (const r of roads) for (let i = 0; i + 1 < r.points.length; i++) roadSegs.push({ a: [r.points[i][0], r.points[i][2]], b: [r.points[i + 1][0], r.points[i + 1][2]], road: r.id });
  const roadCell = new Map<number, number[]>();
  const rk = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  roadSegs.forEach((s, i) => {
    for (let x = Math.floor(Math.min(s.a[0], s.b[0]) / 32); x <= Math.floor(Math.max(s.a[0], s.b[0]) / 32); x++) {
      for (let z = Math.floor(Math.min(s.a[1], s.b[1]) / 32); z <= Math.floor(Math.max(s.a[1], s.b[1]) / 32); z++) {
        const a = roadCell.get(rk(x, z));
        if (a) a.push(i); else roadCell.set(rk(x, z), [i]);
      }
    }
  });
  const roadCrossedBy = (a: V2, b: V2): { road: string; x: number; z: number } | null => {
    const seen = new Set<number>();
    for (let x = Math.floor(Math.min(a[0], b[0]) / 32); x <= Math.floor(Math.max(a[0], b[0]) / 32); x++) {
      for (let z = Math.floor(Math.min(a[1], b[1]) / 32); z <= Math.floor(Math.max(a[1], b[1]) / 32); z++) {
        for (const i of roadCell.get(rk(x, z)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const hit = segmentIntersection(a, b, roadSegs[i].a, roadSegs[i].b);
          if (hit) return { road: roadSegs[i].road, x: hit.x, z: hit.z };
        }
      }
    }
    return null;
  };

  // which junction leg a point on a road belongs to
  const roadWidth = new Map(roads.map((r) => [r.id, r.width]));
  const legAt = (road: string | null, x: number, z: number): { junction: string; leg: number; control: string } | null => {
    const found: { junction: string; leg: number; control: string; d: number }[] = [];
    for (const j of junctions.junctions) {
      const dc = Math.hypot(x - j.x, z - j.z);
      if (dc > 60) continue;
      j.legs.forEach((l, li) => {
        if (road && l.road !== road) return;
        // distance from the point to the leg's axis, starting at the junction centre
        const px = x - j.x, pz = z - j.z;
        const along = px * l.dir[0] + pz * l.dir[1];
        if (along < 0) return;
        const lat = Math.abs(px * -l.dir[1] + pz * l.dir[0]);
        const half = (roadWidth.get(l.road) ?? 8) / 2;
        const d = lat + Math.max(0, along - (l.trim + 14)) * 2;
        if (lat > half + 6) return;
        found.push({ junction: j.id, leg: li, control: j.control, d });
      });
    }
    found.sort((a, b) => a.d - b.d);
    const best = found[0];
    return best ? { junction: best.junction, leg: best.leg, control: best.control } : null;
  };

  const g = new Builder();

  // 1. mapped ways -------------------------------------------------------------------------------
  const polys: Poly[] = [];
  const mappedKinds = new Set<PathKind>(['sidewalk', 'footway', 'pedestrian', 'island', 'steps']);
  const mappedPts: [V2, V2][] = [];
  for (const w of ways) {
    if (w.kind !== 'ped') continue;
    const kind = kindOfWay(w);
    for (const run of inBoundsRuns(w, bounds)) {
      const pts = w.pts.slice(run.from, run.to + 1);
      const ids = w.nodeIds.slice(run.from, run.to + 1);
      const ys = pts.map((p, i) => {
        const deck = w.bridge ? inp.deckY?.get(ids[i]) : undefined;
        return deck !== undefined ? deck : ground(p[0], p[1]) + WALK_LIFT;
      });
      let meta: CrossingMeta | undefined;
      if (kind === 'crossing') {
        // which road, and which junction leg, does it cross?
        let hit: { road: string; x: number; z: number } | null = null;
        for (let i = 0; i + 1 < pts.length && !hit; i++) hit = roadCrossedBy(pts[i], pts[i + 1]);
        const mid = pts[Math.floor(pts.length / 2)];
        const leg = legAt(hit?.road ?? null, hit?.x ?? mid[0], hit?.z ?? mid[1]);
        const tagSignals = inp.crossingSignals.get(w.id) ?? false;
        meta = {
          id: w.id,
          marked: true,
          signals: tagSignals || leg?.control === 'signals',
          junction: leg?.junction ?? null,
          leg: leg?.leg ?? null,
          road: hit?.road ?? null,
        };
      }
      const attr = g.attr(kind, w.width, w.bridge, meta);
      const r = resampleWithIds(pts, ids, 3);
      const ysR = r.pts.map((p) => ground(p[0], p[1]) + WALK_LIFT);
      // keep deck heights on the vertices that have them
      r.pts.forEach((_, i) => {
        if (r.ids[i] !== 0 || i === 0) { const idx = ids.indexOf(r.ids[i]); if (idx >= 0) ysR[i] = ys[idx]; }
      });
      polys.push({ pts: r.pts, ys: ysR, ids: r.ids, attr });
      if (mappedKinds.has(kind) && kind !== 'steps') for (let i = 0; i + 1 < r.pts.length; i++) mappedPts.push([r.pts[i], r.pts[i + 1]]);
    }
  }
  // grid of the mapped sidewalks, for "is this curb covered?"
  const covered = new Map<number, [V2, V2][]>();
  mappedPts.forEach((s) => {
    for (let x = Math.floor((Math.min(s[0][0], s[1][0]) - 4) / 8); x <= Math.floor((Math.max(s[0][0], s[1][0]) + 4) / 8); x++) {
      for (let z = Math.floor((Math.min(s[0][1], s[1][1]) - 4) / 8); z <= Math.floor((Math.max(s[0][1], s[1][1]) + 4) / 8); z++) {
        const a = covered.get(rk(x, z));
        if (a) a.push(s); else covered.set(rk(x, z), [s]);
      }
    }
  });
  const mappedNear = (x: number, z: number, r: number) => {
    for (const s of covered.get(rk(Math.floor(x / 8), Math.floor(z / 8))) ?? []) if (distToSegment(x, z, s[0][0], s[0][1], s[1][0], s[1][1]).d < r) return true;
    return false;
  };

  // 2. synthetic sidewalks -------------------------------------------------------------------------
  const synAttr = g.attr('synthetic', SYNTHETIC_WIDTH, false);
  const syntheticLines: { pts: V2[]; ys: number[] }[] = [];
  for (const road of roads) {
    if (road.bridge || !SYN_CLASSES.has(road.class)) continue;
    const c: V2[] = [];
    for (const p of road.points) {
      const l = c[c.length - 1];
      if (!l || Math.hypot(p[0] - l[0], p[2] - l[1]) > 0.05) c.push([p[0], p[2]]);
    }
    if (c.length < 2) continue;
    const res = resample(c, 4);
    const { left, right } = ribbonEdges(res, road.width / 2 + SYNTHETIC_OFFSET);
    for (const side of [left, right]) {
      const free = side.map((p, i) => {
        if (!inBounds(p[0], p[1])) return false;
        if (mappedNear(p[0], p[1], 3.6)) return false;
        if (mask.contains(p[0], p[1], -0.4)) return false;
        if (bIdx.signedDistance(p[0], p[1], 1) < 0.3) return false;
        // a bend can swing the offset line across the road
        const cc = res[i];
        return Math.hypot(p[0] - cc[0], p[1] - cc[1]) < road.width / 2 + SYNTHETIC_OFFSET + 1.5;
      });
      let i = 0;
      while (i < side.length) {
        if (!free[i]) { i++; continue; }
        let j = i;
        while (j + 1 < side.length && free[j + 1]) j++;
        if (j - i >= 2) {
          const pts = side.slice(i, j + 1);
          const ys = pts.map((p) => ground(p[0], p[1]) + WALK_LIFT);
          polys.push({ pts, ys, ids: pts.map(() => 0), attr: synAttr });
          syntheticLines.push({ pts, ys });
        }
        i = j + 1;
      }
    }
  }

  // 3. building clearance -------------------------------------------------------------------------
  const cleared: Poly[] = [];
  const fixPoint = (x: number, z: number): V2 | null => {
    const n = bIdx.nearest(x, z, 1);
    if (!n) return [x, z];
    if (n.d < 0) return null;
    if (n.d >= WALL_CLEAR) return [x, z];
    const nx = n.px + n.nx * (WALL_CLEAR + 0.05), nz = n.pz + n.nz * (WALL_CLEAR + 0.05);
    const n2 = bIdx.nearest(nx, nz, 1);
    return n2 && n2.d < WALL_CLEAR - 0.05 ? null : [nx, nz];
  };
  for (const p of polys) {
    let run: Poly | null = null;
    const flush = () => { if (run && run.pts.length >= 2) cleared.push(run); run = null; };
    for (let i = 0; i < p.pts.length; i++) {
      const f = fixPoint(p.pts[i][0], p.pts[i][1]);
      let ok = f !== null;
      if (ok && run && run.pts.length > 0) {
        // the stretch to the previous vertex must not cut a corner of a building
        const a = run.pts[run.pts.length - 1], b = f!;
        for (const t of [0.25, 0.5, 0.75]) {
          if (bIdx.signedDistance(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0.3) < 0.15) { ok = false; break; }
        }
      }
      if (!ok) {
        if (f === null) stats.droppedByBuildings++;
        flush();
        if (f !== null) run = { pts: [f], ys: [p.ys[i]], ids: [p.ids[i]], attr: p.attr };
        continue;
      }
      if (!run) run = { pts: [], ys: [], ids: [], attr: p.attr };
      run.pts.push(f!); run.ys.push(p.ys[i]); run.ids.push(p.ids[i]);
    }
    flush();
  }
  // the synthetic lines for the ribbon follow the cleared polys
  syntheticLines.length = 0;
  for (const p of cleared) if (p.attr === synAttr) syntheticLines.push({ pts: p.pts, ys: p.ys.map((y) => y ?? 0) });

  for (const p of cleared) g.addPoly(p);

  // 4a. crossings the pipeline makes across the legs of junctions ----------------------------------
  const oscPts: V2[][] = polys.filter((p) => g.attrs[p.attr].kind === 'crossing').map((p) => p.pts);
  const crossNear = (x: number, z: number, r: number) => oscPts.some((pts) => pts.some((q) => Math.hypot(q[0] - x, q[1] - z) < r));
  const nonCrossing = (e: number) => g.attrs[g.eattr[e]].kind !== 'crossing';
  let madeCrossings = 0;
  const attachPoint = (x: number, z: number): number => {
    // reuse a node, or split an edge, near the point
    const n = g.nearestNode(x, z, 1.2, (k) => true);
    if (n >= 0) return n;
    const s = g.segs.nearest(x, z, 4.5, (e) => nonCrossing(e) && g.ealive[e]);
    if (!s) return -1;
    const a = g.ea[s.e], b = g.eb[s.e];
    const da = Math.hypot(g.nx[a] - s.x, g.nz[a] - s.z), db = Math.hypot(g.nx[b] - s.x, g.nz[b] - s.z);
    if (da < 1.0) return a;
    if (db < 1.0) return b;
    return g.split(s.e, s.x, s.z);
  };
  for (const j of junctions.junctions) {
    j.legs.forEach((l, li) => {
      const cls = roads.find((r) => r.id === l.road);
      if (!cls || /^(motorway|trunk)/.test(cls.class) || /_link$/.test(cls.class)) return;
      const half = (roadWidth.get(l.road) ?? 8) / 2;
      if (half > 12 || l.trim <= 0) return;
      const p = nodePos.get(l.node);
      if (!p) return;
      const off = l.trim + 2.0;
      const q: V2 = [p[0] + l.dir[0] * off, p[1] + l.dir[1] * off];
      if (!inBounds(q[0], q[1]) || crossNear(q[0], q[1], 9)) return;
      const ax: V2 = [-l.dir[1], l.dir[0]];
      const reach = half + 1.4;
      const e1: V2 = [q[0] - ax[0] * reach, q[1] - ax[1] * reach];
      const e2: V2 = [q[0] + ax[0] * reach, q[1] + ax[1] * reach];
      const marked = l.crosswalk;
      const meta: CrossingMeta = { id: null, marked, signals: j.control === 'signals', junction: j.id, leg: li, road: l.road };
      // both ends need a sidewalk
      const n1 = attachPoint(e1[0], e1[1]);
      const n2 = attachPoint(e2[0], e2[1]);
      if (n1 < 0 || n2 < 0 || n1 === n2) return;
      for (const t of [0.2, 0.4, 0.5, 0.6, 0.8]) {
        const x = g.nx[n1] + (g.nx[n2] - g.nx[n1]) * t, z = g.nz[n1] + (g.nz[n2] - g.nz[n1]) * t;
        if (bIdx.signedDistance(x, z, 0.4) < 0.2) return;
      }
      if (Math.hypot(g.nx[n1] - g.nx[n2], g.nz[n1] - g.nz[n2]) > 2 * half + 9) return;
      g.edge(n1, n2, g.attr('crossing', 3, false, meta));
      madeCrossings++;
    });
  }

  // 4b. link pass: dead ends and small islands join the network -------------------------------------
  const dsu = new Dsu(g.nx.length);
  const rebuildDsu = () => {
    dsu.p.length = 0;
    dsu.grow(g.nx.length);
    for (let e = 0; e < g.ea.length; e++) if (g.ealive[e]) dsu.union(g.ea[e], g.eb[e]);
  };
  rebuildDsu();
  const linkAttr = g.attr('link', 1.5, false);
  const degree = () => {
    const d = new Int32Array(g.nx.length);
    for (let e = 0; e < g.ea.length; e++) if (g.ealive[e]) { d[g.ea[e]]++; d[g.eb[e]]++; }
    return d;
  };
  const blocked = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.0));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (bIdx.signedDistance(x, z, 0.4) < 0.2) return true;
      if (mask.contains(x, z, 0.3)) return true;
    }
    return false;
  };
  const tryLink = (n: number, r: number, otherComponent: boolean): boolean => {
    const x = g.nx[n], z = g.nz[n];
    const me = dsu.find(n);
    const s = g.segs.nearest(x, z, r, (e) => g.ealive[e] && g.ea[e] !== n && g.eb[e] !== n && (!otherComponent || dsu.find(g.ea[e]) !== me));
    const nn = g.nearestNode(x, z, r, (k) => k !== n && (!otherComponent || dsu.find(k) !== me));
    let target = -1;
    let td = Infinity;
    if (nn >= 0) { td = Math.hypot(g.nx[nn] - x, g.nz[nn] - z); target = nn; }
    if (s && s.d < td - 0.3) {
      const a = g.ea[s.e], b = g.eb[s.e];
      const da = Math.hypot(g.nx[a] - s.x, g.nz[a] - s.z), db = Math.hypot(g.nx[b] - s.x, g.nz[b] - s.z);
      if (blocked(x, z, s.x, s.z)) { if (target < 0) return false; }
      else {
        target = da < 1.0 ? a : db < 1.0 ? b : g.split(s.e, s.x, s.z);
        dsu.grow(g.nx.length);
        td = 0;
      }
    }
    if (target < 0 || target === n) return false;
    if (td > 0 && blocked(x, z, g.nx[target], g.nz[target])) return false;
    if (Math.abs(g.ny[target] - g.ny[n]) > 2.2) return false;
    g.edge(n, target, linkAttr);
    dsu.union(n, target);
    return true;
  };
  let deg = degree();
  for (let n = 0; n < deg.length; n++) {
    if (deg[n] === 1) {
      // first a near miss of any piece, then the next component within a short walk
      if (!tryLink(n, 1.6, false)) tryLink(n, 9, true);
    }
  }
  // islands that are still apart: any of their nodes may reach a neighbour
  for (let pass = 0; pass < 2; pass++) {
    deg = degree();
    rebuildDsu();
    const size = new Map<number, number>();
    for (let n = 0; n < deg.length; n++) if (deg[n] > 0) size.set(dsu.find(n), (size.get(dsu.find(n)) ?? 0) + 1);
    for (let n = 0; n < deg.length; n++) {
      if (deg[n] === 0) continue;
      if ((size.get(dsu.find(n)) ?? 0) > 400) continue;
      tryLink(n, 7, true);
    }
  }

  // 5. components, merge straight chains, renumber ----------------------------------------------------
  rebuildDsu();
  const compLen = new Map<number, number>();
  for (let e = 0; e < g.ea.length; e++) if (g.ealive[e]) compLen.set(dsu.find(g.ea[e]), (compLen.get(dsu.find(g.ea[e])) ?? 0) + g.len(e));
  for (let e = 0; e < g.ea.length; e++) {
    if (!g.ealive[e]) continue;
    if ((compLen.get(dsu.find(g.ea[e])) ?? 0) < MIN_COMPONENT_M) { g.ealive[e] = false; stats.droppedIslandsM += g.len(e); }
  }
  // merge a node of degree two whose edges share an attribute and run straight on
  const adj = g.adjacency();
  for (let n = 0; n < adj.length; n++) {
    const es = adj[n].filter((e) => g.ealive[e]);
    if (es.length !== 2) continue;
    const [e1, e2] = es;
    if (g.eattr[e1] !== g.eattr[e2]) continue;
    const a = g.ea[e1] === n ? g.eb[e1] : g.ea[e1];
    const b = g.ea[e2] === n ? g.eb[e2] : g.ea[e2];
    if (a === b || a === n || b === n) continue;
    const d1x = g.nx[n] - g.nx[a], d1z = g.nz[n] - g.nz[a], d2x = g.nx[b] - g.nx[n], d2z = g.nz[b] - g.nz[n];
    const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
    if (l1 + l2 > 22 || l1 < 1e-6 || l2 < 1e-6) continue;
    if ((d1x * d2x + d1z * d2z) / (l1 * l2) < 0.995) continue;
    if (Math.abs(g.ny[a] - g.ny[b]) > 0.6) continue;
    // keep a vertex a different attribute hangs on
    g.ealive[e2] = false;
    if (g.ea[e1] === n) g.ea[e1] = b; else g.eb[e1] = b;
    // e1 now joins a and b: later merges read the live arrays
    const k = adj[b].indexOf(e2);
    if (k >= 0) adj[b][k] = e1;
  }

  const used = new Map<number, number>();
  const nodes: [number, number, number][] = [];
  const idx = (n: number) => {
    let i = used.get(n);
    if (i === undefined) {
      i = nodes.length;
      used.set(n, i);
      nodes.push([round1(g.nx[n]), round2(g.ny[n]), round1(g.nz[n])]);
    }
    return i;
  };
  const edges: number[] = [];
  const lengthByKind: Record<string, number> = {};
  let total = 0;
  const finalDsu = new Dsu(g.nx.length);
  for (let e = 0; e < g.ea.length; e++) {
    if (!g.ealive[e]) continue;
    const a = g.ea[e], b = g.eb[e];
    if (a === b) continue;
    edges.push(idx(a), idx(b), g.eattr[e]);
    const l = g.len(e);
    total += l;
    const kd = g.attrs[g.eattr[e]].kind;
    lengthByKind[kd] = (lengthByKind[kd] ?? 0) + l;
    finalDsu.union(a, b);
  }
  const comp = new Map<number, number>();
  for (let e = 0; e < g.ea.length; e++) if (g.ealive[e] && g.ea[e] !== g.eb[e]) comp.set(finalDsu.find(g.ea[e]), (comp.get(finalDsu.find(g.ea[e])) ?? 0) + g.len(e));
  const largest = Math.max(0, ...comp.values());

  // only the attrs in use
  const attrUse = new Map<number, number>();
  const attrs: PathAttr[] = [];
  for (let i = 2; i < edges.length; i += 3) {
    let k = attrUse.get(edges[i]);
    if (k === undefined) { k = attrs.length; attrUse.set(edges[i], k); attrs.push(g.attrs[edges[i]]); }
    edges[i] = k;
  }
  const crossAttrs = attrs.filter((a) => a.crossing);
  const file: PathsFile = {
    version: 1,
    nodes,
    attrs,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length / 3,
      lengthM: Math.round(total),
      lengthByKind: Object.fromEntries(Object.entries(lengthByKind).map(([k, v]) => [k, Math.round(v)])),
      components: comp.size,
      largestShare: total > 0 ? Math.round((largest / total) * 1000) / 1000 : 0,
      crossings: {
        total: crossAttrs.length,
        marked: crossAttrs.filter((a) => a.crossing!.marked).length,
        signals: crossAttrs.filter((a) => a.crossing!.signals).length,
        atJunctions: crossAttrs.filter((a) => a.crossing!.junction !== null).length,
        made: madeCrossings,
      },
      droppedByBuildings: stats.droppedByBuildings,
      droppedIslandsM: Math.round(stats.droppedIslandsM),
      syntheticM: Math.round(lengthByKind.synthetic ?? 0),
    },
  };
  return { file, syntheticLines };
}

/** Ribbons for the synthetic sidewalks, added to the sidewalk mesh so they exist to look at as well as to walk on. */
export function addSyntheticSidewalkMesh(mesh: MeshBuilder, lines: { pts: V2[]; ys: number[] }[], ground: (x: number, z: number) => number): number {
  let tris = 0;
  for (const line of lines) {
    if (line.pts.length < 2) continue;
    const { left, right } = ribbonEdges(line.pts, SYNTHETIC_WIDTH / 2);
    const base = mesh.vertexCount;
    for (let i = 0; i < line.pts.length; i++) {
      mesh.vertex(left[i][0], ground(left[i][0], left[i][1]) + WALK_LIFT, left[i][1], 0, 1, 0);
      mesh.vertex(right[i][0], ground(right[i][0], right[i][1]) + WALK_LIFT, right[i][1], 0, 1, 0);
    }
    mesh.indices.push(...ribbonIndices(line.pts.length, base));
    tris += (line.pts.length - 1) * 2;
  }
  return tris;
}
