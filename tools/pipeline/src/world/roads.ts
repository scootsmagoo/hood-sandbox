import type { Rect, V2, V3 } from '../geo.js';
import { clipPolyline, clipPolylineWithValues, simplifyLine3 } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import { addOrientedBox } from '../mesh/extrude.js';
import { dedupe, pointAlong, ribbonEdges, ribbonIndices } from '../mesh/ribbon.js';
import { DEFAULT_DECK_OPTIONS, densifyWay, solveDecks, type RefWay } from './decks.js';
import type { RoadWay } from './osm.js';
import type { Heightmap } from './terrain.js';
import { surfaceHeight } from './terrain.js';
import { srgbToLinear } from './buildings.js';

export interface RoadJson {
  id: string;
  class: string;
  name: string;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  layer: number;
  width: number;
  points: V3[];
}

export interface RoadMeshes {
  asphalt: MeshBuilder;
  sidewalk: MeshBuilder;
  crosswalk: MeshBuilder;
  rail: MeshBuilder;
  concrete: MeshBuilder;
  /** deck slabs and piers, positions and indices only */
  collision: MeshBuilder;
  json: RoadJson[];
  stats: { ways: number; drivableWays: number; deckWays: number; deckMetres: number; piers: number; maxDeckHeightAboveGround: number };
}

const RANK: Record<string, number> = {
  motorway: 5, trunk: 4, primary: 3, secondary: 2, tertiary: 1, unclassified: 1, residential: 0, living_street: 0, service: 0, road: 0, busway: 1,
};
const ASPHALT_GRAY: Record<string, number> = {
  motorway: 0.17, trunk: 0.18, primary: 0.2, secondary: 0.21, tertiary: 0.23, residential: 0.25, service: 0.28,
};

const CLEARANCE = { car: 5.0, rail: 6.0, ped: 3.0 };
const SEG = 5;

function rankOf(highway: string): number {
  return RANK[highway.replace(/_link$/, '')] ?? 0;
}
function grayOf(highway: string): number {
  return ASPHALT_GRAY[highway.replace(/_link$/, '')] ?? 0.25;
}

interface Piece {
  way: RoadWay;
  pts: V2[];
  /** deck surface heights, or null for ways on the ground */
  deckY: number[] | null;
}

export function buildRoads(ways: RoadWay[], hm: Heightmap, bounds: Rect): RoadMeshes {
  const res: RoadMeshes = {
    asphalt: new MeshBuilder(), sidewalk: new MeshBuilder(), crosswalk: new MeshBuilder(), rail: new MeshBuilder(),
    concrete: new MeshBuilder(), collision: new MeshBuilder(), json: [],
    stats: { ways: 0, drivableWays: 0, deckWays: 0, deckMetres: 0, piers: 0, maxDeckHeightAboveGround: 0 },
  };
  const ground = (x: number, z: number) => surfaceHeight(hm, x, z);
  const thickness = DEFAULT_DECK_OPTIONS.thickness;

  const dense = ways.map((w) => ({ w, ...densifyWay(w, SEG) }));
  const groundWays = dense.filter((d) => !d.w.bridge);
  const deckWays = dense.filter((d) => d.w.bridge);

  const groundNodeIds = new Set<number>();
  for (const g of groundWays) for (const id of g.nodeIds) if (id > 0) groundNodeIds.add(id);
  const groundRefs: RefWay[] = groundWays
    .filter((g) => g.w.sub !== 'crossing')
    .map((g) => ({ nodeIds: g.nodeIds, pts: g.pts, width: g.w.width, layer: 0, clearance: CLEARANCE[g.w.kind] }));

  const deckY = solveDecks(
    deckWays.map((d) => ({ nodeIds: d.nodeIds, pts: d.pts, layer: d.w.layer })),
    { groundAt: ground, groundNodeIds, groundRefs, thickness },
  );

  const pieces: Piece[] = [];
  for (const g of groundWays) {
    for (const p of clipPolyline(g.pts, bounds)) pieces.push({ way: g.w, pts: dedupe(p), deckY: null });
  }
  deckWays.forEach((d, i) => {
    for (const c of clipPolylineWithValues(d.pts, deckY[i], bounds)) {
      pieces.push({ way: d.w, pts: c.pts, deckY: c.vals });
    }
  });

  // reference segments of car and rail ways on the ground, for keeping piers out of the road below
  const below = groundWays.filter((g) => g.w.kind !== 'ped');

  for (const piece of pieces) {
    if (piece.pts.length < 2) continue;
    // dedupe may have dropped points; rebuild heights if needed
    let pts = piece.pts;
    let ys = piece.deckY;
    if (ys) {
      const keepP: V2[] = [];
      const keepY: number[] = [];
      pts.forEach((p, i) => {
        const l = keepP[keepP.length - 1];
        if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.01) { keepP.push(p); keepY.push(ys![i]); }
      });
      pts = keepP;
      ys = keepY;
    }
    if (pts.length < 2) continue;
    emitPiece(res, piece.way, pts, ys, ground, thickness, below);
  }
  return res;
}

function emitPiece(
  res: RoadMeshes,
  way: RoadWay,
  pts: V2[],
  deckY: number[] | null,
  ground: (x: number, z: number) => number,
  thickness: number,
  below: { w: RoadWay; pts: V2[] }[],
): void {
  const half = way.width / 2;
  const { left, right, dirs } = ribbonEdges(pts, half);
  const n = pts.length;
  const isCrossing = way.sub === 'crossing';
  let target: MeshBuilder;
  let color: [number, number, number] = [1, 1, 1];
  let lift: number;
  if (way.kind === 'car') {
    target = res.asphalt;
    const g = srgbToLinear(grayOf(way.highway));
    color = [g, g, g * 1.02];
    lift = 0.06 + 0.008 * rankOf(way.highway);
  } else if (way.kind === 'rail') {
    target = res.rail;
    lift = 0.04;
  } else if (isCrossing) {
    target = res.crosswalk;
    lift = 0.14;
  } else {
    target = res.sidewalk;
    lift = 0.1;
  }

  const topY: number[] = [];
  const lY: number[] = [];
  const rY: number[] = [];
  for (let i = 0; i < n; i++) {
    if (deckY) {
      topY.push(deckY[i]);
      lY.push(deckY[i]);
      rY.push(deckY[i]);
    } else {
      const c = ground(pts[i][0], pts[i][1]);
      const l = ground(left[i][0], left[i][1]);
      const r = ground(right[i][0], right[i][1]);
      topY.push(c + lift);
      lY.push(Math.max(c - 0.5, Math.min(c + 0.5, l)) + lift);
      rY.push(Math.max(c - 0.5, Math.min(c + 0.5, r)) + lift);
    }
  }

  const base = target.vertexCount;
  for (let i = 0; i < n; i++) {
    target.vertex(left[i][0], lY[i], left[i][1], 0, 1, 0, color[0], color[1], color[2]);
    target.vertex(right[i][0], rY[i], right[i][1], 0, 1, 0, color[0], color[1], color[2]);
  }
  target.indices.push(...ribbonIndices(n, base));
  res.stats.ways++;

  if (way.kind === 'car') {
    const pts3: V3[] = pts.map((p, i) => [p[0], topY[i], p[1]]);
    const simp = simplifyLine3(pts3, 0.25).map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100] as V3);
    res.json.push({
      id: `osm:way/${way.id}`,
      class: way.highway,
      name: way.name,
      lanes: way.lanes,
      oneway: way.oneway,
      bridge: way.bridge,
      layer: way.layer,
      width: way.width,
      points: simp,
    });
    res.stats.drivableWays++;
  }

  if (!deckY) return;

  // deck: underside, skirts, collision slab, piers
  res.stats.deckWays++;
  const c = res.concrete;
  const cg = srgbToLinear(0.55);
  const colC: [number, number, number] = [cg, cg, cg];
  const ub = c.vertexCount;
  for (let i = 0; i < n; i++) {
    c.vertex(left[i][0], lY[i] - thickness, left[i][1], 0, -1, 0, ...colC);
    c.vertex(right[i][0], rY[i] - thickness, right[i][1], 0, -1, 0, ...colC);
  }
  c.indices.push(...ribbonIndices(n, ub, true));
  for (const side of [0, 1] as const) {
    const edge = side === 0 ? left : right;
    const ys = side === 0 ? lY : rY;
    const sb = c.vertexCount;
    for (let i = 0; i < n; i++) {
      // outward normal: left side points to the left of travel, right side to the right
      const nx = side === 0 ? dirs[i][1] : -dirs[i][1];
      const nz = side === 0 ? -dirs[i][0] : dirs[i][0];
      c.vertex(edge[i][0], ys[i], edge[i][1], nx, 0, nz, ...colC);
      c.vertex(edge[i][0], ys[i] - thickness, edge[i][1], nx, 0, nz, ...colC);
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = sb + 2 * i; // top i
      const b = a + 1; // bottom i
      const a2 = a + 2;
      const b2 = a + 3;
      if (side === 0) c.indices.push(a, a2, b, b, a2, b2);
      else c.indices.push(a, b, a2, a2, b, b2);
    }
  }

  const col = res.collision;
  const cb = col.vertexCount;
  for (let i = 0; i < n; i++) {
    col.vertex(left[i][0], lY[i], left[i][1], 0, 1, 0);
    col.vertex(right[i][0], rY[i], right[i][1], 0, 1, 0);
  }
  for (let i = 0; i < n; i++) {
    col.vertex(left[i][0], lY[i] - thickness, left[i][1], 0, 1, 0);
    col.vertex(right[i][0], rY[i] - thickness, right[i][1], 0, 1, 0);
  }
  col.indices.push(...ribbonIndices(n, cb));
  col.indices.push(...ribbonIndices(n, cb + 2 * n, true));
  const topL = (i: number) => cb + 2 * i;
  const topR = (i: number) => cb + 2 * i + 1;
  const botL = (i: number) => cb + 2 * n + 2 * i;
  const botR = (i: number) => cb + 2 * n + 2 * i + 1;
  for (let i = 0; i + 1 < n; i++) {
    col.indices.push(topL(i), topL(i + 1), botL(i), botL(i), topL(i + 1), botL(i + 1));
    col.indices.push(topR(i), botR(i), topR(i + 1), topR(i + 1), botR(i), botR(i + 1));
  }

  // piers every ~30 m where the deck is well above the ground
  let len = 0;
  for (let i = 0; i + 1 < n; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  res.stats.deckMetres += len;
  const spacing = way.kind === 'ped' ? 25 : 30;
  const nPiers = Math.floor(len / spacing);
  for (let k = 0; k < nPiers; k++) {
    const s = (k + 0.5) * (len / nPiers);
    const { p, dir } = pointAlong(pts, s);
    const g = ground(p[0], p[1]);
    // interpolate deck height at s
    let acc = 0;
    let y = deckY[0];
    for (let i = 0; i + 1 < n; i++) {
      const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (acc + l >= s) { y = deckY[i] + (deckY[i + 1] - deckY[i]) * (l > 0 ? (s - acc) / l : 0); break; }
      acc += l;
    }
    res.stats.maxDeckHeightAboveGround = Math.max(res.stats.maxDeckHeightAboveGround, y - g);
    const bottom = y - thickness;
    if (bottom - g < 2.5) continue;
    if (overRoad(p, below)) continue;
    const halfW = way.kind === 'ped' ? 0.4 : Math.max(0.7, Math.min(4, way.width * 0.3));
    const halfL = way.kind === 'ped' ? 0.4 : 0.9;
    addOrientedBox(c, p[0], p[1], g - 0.5, bottom, dir, halfL, halfW, colC);
    addOrientedBox(col, p[0], p[1], g - 0.5, bottom, dir, halfL, halfW);
    res.stats.piers++;
  }
}

function overRoad(p: V2, below: { w: RoadWay; pts: V2[] }[]): boolean {
  for (const b of below) {
    const reach = b.w.width / 2 + 1.5;
    for (let i = 0; i + 1 < b.pts.length; i++) {
      const a = b.pts[i], c = b.pts[i + 1];
      if (p[0] < Math.min(a[0], c[0]) - reach || p[0] > Math.max(a[0], c[0]) + reach || p[1] < Math.min(a[1], c[1]) - reach || p[1] > Math.max(a[1], c[1]) + reach) continue;
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
      if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz)) < reach) return true;
    }
  }
  return false;
}
