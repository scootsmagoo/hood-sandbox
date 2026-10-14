import type { Rect, V2, V3 } from '../geo.js';
import { clipPolyline, clipPolylineWithValues, polylineLength, simplifyLine3 } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import { addOrientedBox } from '../mesh/extrude.js';
import { dedupe, pointAlong, ribbonEdges, ribbonIndices } from '../mesh/ribbon.js';
import { exportJunctions, type JunctionsFile } from './markings.js';
import { addLegMarkings, addRunLines, addZebra, assignControls, MARK_LIFT, RoadMask, type Controls } from './markings.js';
import type { NodeInfo } from './nodes.js';
import { addJunctionMesh, buildJunctions, DEFAULT_JUNCTION_OPTIONS, trimKey, trimPolyline, type Junction, type JunctionResult } from './junctions.js';
import { DEFAULT_DECK_OPTIONS, densifyWay, solveDecks, type RefWay } from './decks.js';
import type { RoadWay } from './osm.js';
import type { CarveSegment, Heightmap, UnderDeckSegment } from './terrain.js';
import { carveTerrain, lowerTerrainUnder, surfaceHeight } from './terrain.js';
import { solveProfiles, type DeckSpan, type ProfileOptions, type ProfileResult } from './profile.js';
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
  /** true for a bridge the pipeline made where the ground road dips (a cut, a ravine) and OSM has no bridge */
  derived?: boolean;
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
  junctions: Junction[];
  junctionStats: JunctionResult['stats'];
  runs: CarRun[];
  /** lane lines, crosswalks and stop bars, one mesh with vertex colours */
  markings: MeshBuilder;
  markingStats: { lines: number; crosswalks: number; bars: number; stopBars: number };
  controls: Controls;
  /** junctions.json */
  exported: JunctionsFile;
  /** OSM crossing ways: centreline with height, and what the nodes say about them */
  crossings: { id: number; points: V3[]; signals: boolean }[];
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
/** How strongly a bridge's wish for the height of the road it starts from counts against the terrain (1 per node). */
const ANCHOR_WEIGHT = 400;

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
  /** a deck made from a ground way's profile, not from OSM */
  derived?: boolean;
  /** junctions (indices into RoadMeshes.junctions) this piece's ends were cut back to */
  startJ?: number;
  endJ?: number;
}

/** A stretch of drivable road as meshed (cut back to its junctions): what the markings are laid on. */
export interface CarRun {
  way: RoadWay;
  pts: V2[];
  deckY: number[] | null;
  startJ?: number;
  endJ?: number;
}

type Dense = { w: RoadWay; pts: V2[]; nodeIds: number[] };

/** Largest grade the profile solver allows by road class (the checker's limit is 12% over 6 m). */
export const GRADE_LIMIT: Record<string, number> = {
  motorway: 0.06, motorway_link: 0.08, trunk: 0.07, trunk_link: 0.08, primary: 0.08, secondary: 0.08, service: 0.1,
};
export function gradeLimit(highway: string): number {
  return GRADE_LIMIT[highway] ?? 0.09;
}

/** The roads on the ground, with their designed vertical profile and the bridges it needs (see profile.ts). */
export interface RoadPlan {
  dense: Dense[];
  /** indices into `dense` of the car ways that were given a profile */
  profiled: number[];
  /** per profiled way (same order): design height at each node */
  heights: number[][];
  /** per profiled way: deck spans, node index ranges */
  spans: DeckSpan[][];
  /** design height at OSM nodes of the ground network */
  nodeY: Map<number, number>;
  /** the ways on decks (OSM bridges), as indices into `dense`, and the deck surface height at each of their nodes */
  deckWays: number[];
  deckY: number[][];
  stats: ProfileResult['stats'] & { carvedVertices: number; maxCut: number; maxFill: number; underDeckCut: number };
}

/**
 * Designs the profile of every at-grade car road and cuts and fills the heightmap to it (the heightmap
 * is changed in place, so call this before anything is built on the ground: the ground mesh, the
 * buildings, the roads).
 */
export function planRoads(ways: RoadWay[], hm: Heightmap, profile: Partial<ProfileOptions> = {}): RoadPlan {
  // Only what is near the heightmap matters: outside it the ground is just the edge value, and the roads out there would fit themselves to that.
  const rect: Rect = { minX: hm.minX, minZ: hm.minZ, maxX: hm.minX + (hm.cols - 1) * hm.cellSize, maxZ: hm.minZ + (hm.rows - 1) * hm.cellSize };
  const dense: Dense[] = ways.flatMap((w) => keepNear({ w, ...densifyWay(w, SEG) }, rect));
  const profiled: number[] = [];
  dense.forEach((d, i) => { if (d.w.kind === 'car' && !d.w.bridge) profiled.push(i); });
  // What the bridges need of the ground where they land: ask once, with their ends free, and let the profile solver bring the ground roads there
  const bridges = dense.filter((d) => d.w.bridge).map((d) => ({ nodeIds: d.nodeIds, pts: d.pts, layer: d.w.layer }));
  const groundNodeIds = new Set<number>();
  for (const d of dense) if (!d.w.bridge) for (const id of d.nodeIds) if (id > 0) groundNodeIds.add(id);
  const profIndex = new Map<number, number>();
  profiled.forEach((di, pi) => profIndex.set(di, pi));
  const refsAt = (heights?: number[][]): RefWay[] => {
    const refs: RefWay[] = [];
    dense.forEach((g, di) => {
      if (g.w.bridge || g.w.sub === 'crossing') return;
      const pi = profIndex.get(di);
      refs.push({ nodeIds: g.nodeIds, pts: g.pts, width: g.w.width, layer: 0, clearance: CLEARANCE[g.w.kind], heights: pi === undefined || !heights ? undefined : heights[pi].map((y) => y + 0.1) });
    });
    return refs;
  };
  const ground = (x: number, z: number) => surfaceHeight(hm, x, z);
  const demand = new Map<number, number>();
  solveDecks(bridges, { groundAt: ground, groundNodeIds, groundRefs: refsAt(), demand });
  const wanted = new Map<number, { y: number; weight: number }>();
  // (outside the heightmap the ground is just its edge value, so what a bridge wants there means nothing)
  const nodeAt = new Map<number, V2>();
  for (const d of dense) d.nodeIds.forEach((id, i) => { if (id > 0) nodeAt.set(id, d.pts[i]); });
  const x1 = hm.minX + (hm.cols - 1) * hm.cellSize, z1 = hm.minZ + (hm.rows - 1) * hm.cellSize;
  for (const [id, y] of demand) {
    const p = nodeAt.get(id);
    if (p && p[0] > hm.minX + 6 && p[0] < x1 - 6 && p[1] > hm.minZ + 6 && p[1] < z1 - 6) wanted.set(id, { y, weight: ANCHOR_WEIGHT });
  }

  const res = solveProfiles(
    profiled.map((i) => ({ nodeIds: dense[i].nodeIds, pts: dense[i].pts, maxGrade: gradeLimit(dense[i].w.highway) })),
    { terrain: ground, wanted, ...profile },
  );
  const nodeY = new Map<number, number>();
  const segs: CarveSegment[] = [];
  const spans: DeckSpan[][] = profiled.map(() => []);
  for (const d of res.decks) spans[d.way].push(d);
  profiled.forEach((di, pi) => {
    const d = dense[di];
    const onDeck = new Uint8Array(d.pts.length);
    for (const sp of spans[pi]) for (let i = sp.from; i < sp.to; i++) onDeck[i] = 1;
    for (let i = 0; i < d.pts.length; i++) if (d.nodeIds[i] > 0) nodeY.set(d.nodeIds[i], res.h[pi][i]);
    for (let i = 0; i + 1 < d.pts.length; i++) {
      if (onDeck[i]) continue;
      segs.push({ a: d.pts[i], b: d.pts[i + 1], ha: res.h[pi][i], hb: res.h[pi][i + 1], halfWidth: d.w.width / 2 });
    }
  });
  const carved = carveTerrain(hm, segs);

  // OSM bridges: deck heights over the designed ground, then the ground is cut away where it would stand above a deck
  const deckWays: number[] = [];
  dense.forEach((d, di) => { if (d.w.bridge) deckWays.push(di); });
  const deckY = solveDecks(
    deckWays.map((di) => ({ nodeIds: dense[di].nodeIds, pts: dense[di].pts, layer: dense[di].w.layer })),
    { groundAt: ground, groundNodeIds, groundRefs: refsAt(res.h), groundNodeY: nodeY, thickness: DEFAULT_DECK_OPTIONS.thickness },
  );
  const under: UnderDeckSegment[] = [];
  deckWays.forEach((di, k) => {
    const d = dense[di];
    for (let i = 0; i + 1 < d.pts.length; i++) under.push({ a: d.pts[i], b: d.pts[i + 1], ya: deckY[k][i], yb: deckY[k][i + 1], halfWidth: d.w.width / 2 });
  });
  const lowered = lowerTerrainUnder(hm, under);
  return {
    dense, profiled, heights: res.h, spans, nodeY, deckWays, deckY,
    stats: { ...res.stats, carvedVertices: carved.vertices, maxCut: carved.cut, maxFill: carved.fill, underDeckCut: lowered.cut },
  };
}

/** The parts of a densified way within `rect`, each with one node more at either end (so the segment that crosses the edge is kept). */
export function keepNear(d: Dense, rect: Rect): Dense[] {
  const inside = d.pts.map((p) => p[0] >= rect.minX && p[0] <= rect.maxX && p[1] >= rect.minZ && p[1] <= rect.maxZ);
  if (inside.every(Boolean)) return [d];
  const out: Dense[] = [];
  let i = 0;
  while (i < d.pts.length) {
    if (!inside[i]) { i++; continue; }
    let j = i;
    while (j + 1 < d.pts.length && inside[j + 1]) j++;
    const a = Math.max(0, i - 1), b = Math.min(d.pts.length - 1, j + 1);
    if (b > a) out.push({ w: d.w, pts: d.pts.slice(a, b + 1), nodeIds: d.nodeIds.slice(a, b + 1) });
    i = j + 1;
  }
  return out;
}

/** Splits 0..n-1 at the deck spans: runs share their end index. */
export function splitRuns(n: number, spans: DeckSpan[]): { from: number; to: number; deck: boolean }[] {
  const runs: { from: number; to: number; deck: boolean }[] = [];
  let at = 0;
  for (const sp of [...spans].sort((a, b) => a.from - b.from)) {
    if (sp.from > at) runs.push({ from: at, to: sp.from, deck: false });
    runs.push({ from: sp.from, to: sp.to, deck: true });
    at = sp.to;
  }
  if (at < n - 1) runs.push({ from: at, to: n - 1, deck: false });
  return runs;
}

export function buildRoads(input: RoadPlan | RoadWay[], hm: Heightmap, bounds: Rect, nodes: Map<number, NodeInfo> = new Map()): RoadMeshes {
  const plan = Array.isArray(input) ? planRoads(input, hm) : input;
  const res: RoadMeshes = {
    asphalt: new MeshBuilder(), sidewalk: new MeshBuilder(), crosswalk: new MeshBuilder(), rail: new MeshBuilder(),
    concrete: new MeshBuilder(), collision: new MeshBuilder(), json: [], junctions: [], junctionStats: { candidates: 0, clusters: 0, built: 0, rejected: {} }, runs: [], markings: new MeshBuilder(), markingStats: { lines: 0, crosswalks: 0, bars: 0, stopBars: 0 }, controls: { junctions: [], signals: [], stops: [] }, crossings: [], exported: { junctions: [], signals: [], stops: [], crossings: [] },
    stats: { ways: 0, drivableWays: 0, deckWays: 0, deckMetres: 0, piers: 0, maxDeckHeightAboveGround: 0 },
  };
  const ground = (x: number, z: number) => surfaceHeight(hm, x, z);
  const thickness = DEFAULT_DECK_OPTIONS.thickness;

  const dense = plan.dense;
  const profIndex = new Map<number, number>();
  plan.profiled.forEach((di, pi) => profIndex.set(di, pi));
  const groundWays = dense.filter((d) => !d.w.bridge);

  // junctions of the at-grade car roads: polygons, and how far each leg's ribbon is cut back
  const carIdx: number[] = [];
  dense.forEach((d, di) => { if (d.w.kind === 'car' && !d.w.bridge) carIdx.push(di); });
  const deckNodeIds = new Set<number>();
  plan.profiled.forEach((di, pi) => { for (const sp of plan.spans[pi]) for (let i = sp.from; i <= sp.to; i++) deckNodeIds.add(dense[di].nodeIds[i]); });
  const jways = carIdx.map((di) => ({ way: dense[di].w, pts: dense[di].pts, nodeIds: dense[di].nodeIds }));
  const jr = buildJunctions(jways, { liftOf: roadLift, skipNode: (id) => deckNodeIds.has(id) });
  res.junctions = jr.junctions;
  res.junctionStats = jr.stats;
  const carPos = new Map<number, number>();
  carIdx.forEach((di, k) => carPos.set(di, k));
  for (const j of jr.junctions) {
    let top = j.legs[0];
    for (const l of j.legs) if (rankOf(l.highway) > rankOf(top.highway)) top = l;
    const g = srgbToLinear(grayOf(top.highway));
    addJunctionMesh(res.asphalt, j, ground, [g, g, g * 1.02], Math.max(...j.legs.map((l) => roadLift(dense[carIdx[l.way]].w))));
  }

  const pieces: Piece[] = [];
  // Pieces for roads.json keep the full centreline through junctions; pieces for meshes are cut back to the junction polygons.
  const meshPieces: Piece[] = [];
  const clipTo = (w: RoadWay, pts: V2[], vals: number[] | null, derived: boolean, startJ?: number, endJ?: number) => {
    if (vals) {
      for (const c of clipPolylineWithValues(pts, vals, bounds)) {
        meshPieces.push({ way: w, pts: c.pts, deckY: c.vals, derived, startJ: sameEnd(c.pts[0], pts[0]) ? startJ : undefined, endJ: sameEnd(c.pts[c.pts.length - 1], pts[pts.length - 1]) ? endJ : undefined });
      }
    } else {
      for (const p of clipPolyline(pts, bounds)) {
        const dd = dedupe(p);
        meshPieces.push({ way: w, pts: dd, deckY: null, derived, startJ: sameEnd(dd[0], pts[0]) ? startJ : undefined, endJ: sameEnd(dd[dd.length - 1], pts[pts.length - 1]) ? endJ : undefined });
      }
    }
  };
  // sidewalks and paths that run beside a bridge the pipeline made go over the same gap
  const bridgeSegs: { a: V2; b: V2; ha: number; hb: number; reach: number }[] = [];
  plan.profiled.forEach((di, pi) => {
    const d = dense[di];
    for (const sp of plan.spans[pi]) for (let i = sp.from; i < sp.to; i++) bridgeSegs.push({ a: d.pts[i], b: d.pts[i + 1], ha: plan.heights[pi][i], hb: plan.heights[pi][i + 1], reach: d.w.width / 2 + 5 });
  });
  const pedDeckRuns = (g: Dense): { from: number; to: number; y: number[] }[] => {
    if (!bridgeSegs.length || g.w.kind !== 'ped' || g.w.sub === 'crossing' || g.w.highway === 'steps') return [];
    const n = g.pts.length;
    const target: (number | null)[] = g.pts.map((p) => {
      let best = Infinity;
      let y = 0;
      for (const s of bridgeSegs) {
        const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
        const l2 = dx * dx + dz * dz;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dz) / l2));
        const d = Math.hypot(p[0] - (s.a[0] + t * dx), p[1] - (s.a[1] + t * dz));
        if (d < s.reach && d < best) { best = d; y = s.ha + (s.hb - s.ha) * t + roadLift(g.w); }
      }
      return best < Infinity && y - ground(p[0], p[1]) > 1.0 ? y : null;
    });
    const runs: { from: number; to: number; y: number[] }[] = [];
    let i = 0;
    while (i < n) {
      if (target[i] === null) { i++; continue; }
      let j = i;
      while (j + 1 < n && target[j + 1] !== null) j++;
      const from = Math.max(0, i - 1), to = Math.min(n - 1, j + 1);
      const y: number[] = [];
      for (let q = from; q <= to; q++) y.push(target[q] ?? ground(g.pts[q][0], g.pts[q][1]) + roadLift(g.w));
      runs.push({ from, to, y });
      i = j + 1;
    }
    return runs;
  };

  dense.forEach((g, di) => {
    if (g.w.bridge) return;
    const pi = profIndex.get(di);
    const spans = pi === undefined ? [] : plan.spans[pi];
    const ci = carPos.get(di);
    const pedRuns = pedDeckRuns(g);
    if (pedRuns.length) {
      let at = 0;
      for (const r of pedRuns) {
        if (r.from > at) clipTo(g.w, g.pts.slice(at, r.from + 1), null, false);
        clipTo(g.w, g.pts.slice(r.from, r.to + 1), r.y, true);
        at = r.to;
      }
      if (at < g.pts.length - 1) clipTo(g.w, g.pts.slice(at), null, false);
      return;
    }
    const lift = roadLift(g.w);
    const runs = spans.length ? splitRuns(g.pts.length, spans) : [{ from: 0, to: g.pts.length - 1, deck: false }];
    for (const run of runs) {
      if (run.deck) {
        const ys = plan.heights[pi!].slice(run.from, run.to + 1).map((y) => y + lift);
        const pts = g.pts.slice(run.from, run.to + 1);
        for (const c of clipPolylineWithValues(pts, ys, bounds)) pieces.push({ way: g.w, pts: c.pts, deckY: c.vals, derived: true });
        clipTo(g.w, pts, ys, true);
        continue;
      }
      for (const p of clipPolyline(g.pts.slice(run.from, run.to + 1), bounds)) pieces.push({ way: g.w, pts: dedupe(p), deckY: null });
      // split the run at junction nodes of this way
      const cuts: number[] = [run.from];
      if (ci !== undefined) for (let i = run.from + 1; i < run.to; i++) if (jr.junctionAt.has(g.nodeIds[i])) cuts.push(i);
      cuts.push(run.to);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const a = cuts[k], b = cuts[k + 1];
        const ja = ci !== undefined ? jr.junctionAt.get(g.nodeIds[a]) : undefined;
        const jb = ci !== undefined ? jr.junctionAt.get(g.nodeIds[b]) : undefined;
        const pts = g.pts.slice(a, b + 1);
        if (ja === undefined && jb === undefined) { clipTo(g.w, pts, null, false); continue; }
        // two ends of one junction closer than the cluster distance: the road between is inside the polygon
        if (ja !== undefined && ja === jb && polylineLength(pts) <= DEFAULT_JUNCTION_OPTIONS.clusterDist + 2) continue;
        const t0 = ja !== undefined ? jr.trims.get(trimKey(ci!, a, 1)) ?? 0 : 0;
        const t1 = jb !== undefined ? jr.trims.get(trimKey(ci!, b, -1)) ?? 0 : 0;
        const tr = trimPolyline({ pts }, t0, t1);
        if (tr) clipTo(g.w, tr.pts, null, false, t0 > 0 ? ja : undefined, t1 > 0 ? jb : undefined);
      }
    }
  });
  plan.deckWays.forEach((di, i) => {
    for (const c of clipPolylineWithValues(dense[di].pts, plan.deckY[i], bounds)) {
      pieces.push({ way: dense[di].w, pts: c.pts, deckY: c.vals });
      meshPieces.push({ way: dense[di].w, pts: c.pts, deckY: c.vals });
    }
  });

  // reference segments of car and rail ways on the ground, for keeping piers out of the road below
  const below = groundWays.filter((g) => g.w.kind !== 'ped');

  const clean = (piece: Piece): Piece | null => {
    if (piece.pts.length < 2) return null;
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
    return pts.length < 2 ? null : { ...piece, pts, deckY: ys };
  };
  for (const piece of pieces) {
    const c = clean(piece);
    if (c) emitPiece(res, c.way, c.pts, c.deckY, ground, thickness, below, !!c.derived, { mesh: false });
  }
  for (const piece of meshPieces) {
    const c = clean(piece);
    if (!c) continue;
    if (c.way.sub === 'crossing') continue; // crossings are zebra markings now (below)
    emitPiece(res, c.way, c.pts, c.deckY, ground, thickness, below, !!c.derived, { json: false });
    if (c.way.kind === 'car') res.runs.push({ way: c.way, pts: c.pts, deckY: c.deckY, startJ: c.startJ, endJ: c.endJ });
  }

  // markings
  const mk = res.markings;
  const mask = new RoadMask();
  for (const g of dense) if (g.w.kind === 'car' && !g.w.bridge) mask.addPolyline(g.pts, g.w.width / 2);
  for (const j of res.junctions) mask.addPolygon(j.polygon.map((q) => [q.x, q.z] as V2));
  const onRoad = (x: number, z: number) => mask.contains(x, z, 0.3);
  const inBounds = (p: V2) => p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minZ && p[1] <= bounds.maxZ;
  const crossingPts: V2[][] = [];
  for (const g of dense) {
    if (g.w.sub !== 'crossing' || g.w.bridge || g.w.kind !== 'ped') continue;
    if (!inBounds(g.pts[Math.floor(g.pts.length / 2)])) continue;
    res.markingStats.crosswalks++;
    res.markingStats.bars += addZebra(mk, g.pts, onRoad, ground, undefined, (x, z) => mask.directionAt(x, z));
    crossingPts.push(g.pts);
    res.crossings.push({
      id: g.w.id,
      points: simplifyLine3(g.pts.map((p) => [p[0], ground(p[0], p[1]) + 0.14, p[1]] as V3), 0.3).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 100) / 100, Math.round(p[2] * 10) / 10] as V3),
      signals: g.nodeIds.some((id) => nodes.get(id)?.crossingSignals),
    });
  }
  for (const run of res.runs) {
    const lift = run.deckY ? MARK_LIFT : roadLift(run.way) + MARK_LIFT;
    res.markingStats.lines += addRunLines(mk, run, ground, lift);
  }
  res.controls = assignControls(res.junctions, jr.junctionAt, jways, nodes);
  const hasCrossingNear = (x: number, z: number) => crossingPts.some((pts) => pts.some((p) => Math.hypot(p[0] - x, p[1] - z) < 9));
  res.junctions.forEach((j, ji) => {
    const jc = res.controls.junctions[ji];
    j.legs.forEach((leg, li) => {
      const lc = jc.legs[li];
      const q: V2 = [leg.p[0] + leg.d[0] * (leg.trim + 2.5), leg.p[1] + leg.d[1] * (leg.trim + 2.5)];
      const wantCrosswalk = jc.control === 'signals' && !hasCrossingNear(q[0], q[1]);
      const r = addLegMarkings(mk, leg, lc, roadLift(dense[carIdx[leg.way]].w), ground, onRoad, wantCrosswalk);
      if (r.stopLine) { lc.stopLine = r.stopLine; res.markingStats.stopBars++; }
      if (r.crosswalk) { lc.crosswalk = true; res.markingStats.crosswalks++; }
    });
  });
  res.exported = exportJunctions(res.junctions, res.controls, (l) => `osm:way/${dense[carIdx[l.way]].w.id}`, (l) => roadLift(dense[carIdx[l.way]].w), ground, res.crossings);
  return res;
}

const sameEnd = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

/** Height of the road surface over the ground (m): higher classes sit a little higher, so where two roads overlap the bigger one wins. */
function roadLift(way: RoadWay): number {
  if (way.kind === 'car') return 0.06 + 0.008 * rankOf(way.highway);
  if (way.kind === 'rail') return 0.04;
  return way.sub === 'crossing' ? 0.14 : 0.1;
}

function emitPiece(
  res: RoadMeshes,
  way: RoadWay,
  pts: V2[],
  deckY: number[] | null,
  ground: (x: number, z: number) => number,
  thickness: number,
  below: { w: RoadWay; pts: V2[] }[],
  derived = false,
  what: { json?: boolean; mesh?: boolean } = {},
): void {
  const wantJson = what.json ?? true;
  const wantMesh = what.mesh ?? true;
  const half = way.width / 2;
  const { left, right, dirs } = ribbonEdges(pts, half);
  const n = pts.length;
  const isCrossing = way.sub === 'crossing';
  let target: MeshBuilder;
  let color: [number, number, number] = [1, 1, 1];
  const lift = roadLift(way);
  if (way.kind === 'car') {
    target = res.asphalt;
    const g = srgbToLinear(grayOf(way.highway));
    color = [g, g, g * 1.02];
  } else if (way.kind === 'rail') {
    target = res.rail;
  } else if (isCrossing) {
    target = res.crosswalk;
  } else {
    target = res.sidewalk;
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

  if (way.kind === 'car' && wantJson) {
    const pts3: V3[] = pts.map((p, i) => [p[0], topY[i], p[1]]);
    const simp = simplifyLine3(pts3, 0.25).map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100] as V3);
    res.json.push({
      id: `osm:way/${way.id}`,
      class: way.highway,
      name: way.name,
      lanes: way.lanes,
      oneway: way.oneway,
      bridge: !!deckY,
      layer: deckY ? Math.max(way.layer, 1) : way.layer,
      width: way.width,
      ...(derived ? { derived: true } : {}),
      points: simp,
    });
    res.stats.drivableWays++;
  }

  if (!wantMesh) return;

  const base = target.vertexCount;
  for (let i = 0; i < n; i++) {
    target.vertex(left[i][0], lY[i], left[i][1], 0, 1, 0, color[0], color[1], color[2]);
    target.vertex(right[i][0], rY[i], right[i][1], 0, 1, 0, color[0], color[1], color[2]);
  }
  target.indices.push(...ribbonIndices(n, base));
  res.stats.ways++;

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
    if (overRoad(p, below.filter((b) => b.w !== way))) continue;
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
