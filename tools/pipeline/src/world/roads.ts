import type { Rect, V2, V3 } from '../geo.js';
import { clipPolyline, clipPolylineWithValues, polylineLength, segmentIntersection, simplifyLine3 } from '../geo.js';
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
import { carveTerrain, lowerTerrainUnder, smoothCorridor, surfaceHeight } from './terrain.js';
import { solveProfiles, type Clearance, type DeckSpan, type ProfileOptions, type ProfileResult } from './profile.js';
import { srgbToLinear } from './buildings.js';
import { weldDeckTops, type WeldPolygon, type WeldSegment } from './deckWeld.js';

export interface RoadJson {
  id: string;
  class: string;
  name: string;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  layer: number;
  width: number;
  /** posted speed limit, km/h, when OSM has one */
  maxspeed?: number;
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
  /** where the car roads and junctions are (also used for the markings): the sidewalks' kerb side comes from it */
  mask: RoadMask;
  markingStats: { lines: number; crosswalks: number; bars: number; stopBars: number };
  controls: Controls;
  /** junctions.json */
  exported: JunctionsFile;
  /** the car decks' barriers: each run's inner face along its foot (flat x, y, z), for roads.json */
  barriers: number[][];
  /** OSM crossing ways: centreline with height, and what the nodes say about them */
  crossings: { id: number; points: V3[]; signals: boolean }[];
  stats: { ways: number; drivableWays: number; deckWays: number; deckMetres: number; piers: number; maxDeckHeightAboveGround: number; deckCaps?: number; landedDeckEnds?: number; pedSlabSegmentsDropped?: number; deckJunctions?: number; deckLevels?: number; weldedTriangles?: number; weldFailedLevels?: number; deckClashes?: number; barrierMetres?: number; closedDeckEnds?: number; rampQuadsDropped?: number };
}

const RANK: Record<string, number> = {
  motorway: 5, trunk: 4, primary: 3, secondary: 2, tertiary: 1, unclassified: 1, residential: 0, living_street: 0, service: 0, road: 0, busway: 1,
};
const ASPHALT_GRAY: Record<string, number> = {
  motorway: 0.17, trunk: 0.18, primary: 0.2, secondary: 0.21, tertiary: 0.23, residential: 0.25, service: 0.28,
};

const CLEARANCE = { car: 5.0, rail: 6.0, ped: 3.0 };
const SEG = 5;
/** A bridge the pipeline made has landed when the carved ground at its end is within this of its height (m). */
const LAND_TOL = 0.05;
/** A mapped bridge's end more than this over the carved ground (m) is carried on along the road it lands on (see planRoads). */
const MAPPED_LAND_TOL = 0.3;
/** Weights of a car deck's wished heights in the design: its nodes (as profile.ts has it), and an end where no road goes on. */
const DECK_WISH_WEIGHT = 0.3;
const DEAD_END_WEIGHT = 50;
/** A mapped car bridge whose design stays within this of the terrain (m) and clears nothing is built as a road on the ground. */
const AT_GRADE = 2.0;
/** A bridge the pipeline made grows to at most this many nodes (5 m apart) looking for ground to land on. */
const MAX_DECK_NODES = 60;
/** Ground within this of where a deck lands is left out of the corridor smoothing (m): the deck's end must meet it exactly. */
const FREEZE_R = 7;
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
/** A road's design speed, km/h: its posted limit, else the class's (as lanes.ts has them), at least 30. */
export function designSpeed(w: RoadWay): number {
  if (w.maxspeed) return Math.max(30, w.maxspeed);
  const base: Record<string, number> = { motorway: 105, trunk: 89, primary: 64, secondary: 56, tertiary: 48, unclassified: 48, residential: 40 };
  const v = base[w.highway.replace(/_link$/, '')] ?? 30;
  return Math.max(30, w.highway.endsWith('_link') ? v * 0.7 : v);
}

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
  stats: ProfileResult['stats'] & { carvedVertices: number; maxCut: number; maxFill: number; underDeckCut: number; smoothedVertices: number; smoothMaxChange: number; deckNodesExtended: number; deckEndsUnlanded: number; embankedSpans: number; atGradeBridges: number; mappedEndsExtended: number; deadDeckEnds: number };
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
  // the car bridges are designed with the ground roads, in one solve (below); what each would like, clear of what passes
  // under it, is its target there. The other bridges (rail, footbridges) only ask the ground roads to meet them.
  let deckWays: number[] = [];
  dense.forEach((d, di) => { if (d.w.bridge) deckWays.push(di); });
  const isCarDeck = (di: number) => dense[di].w.kind === 'car' && dense[di].w.sub !== 'crossing';
  const wish = solveDecks(bridges, { groundAt: ground, groundNodeIds, groundRefs: refsAt(), demand });
  const otherEnds = new Set<number>();
  deckWays.forEach((di) => { if (!isCarDeck(di)) { const ids = dense[di].nodeIds; otherEnds.add(ids[0]).add(ids[ids.length - 1]); } });
  for (const id of [...demand.keys()]) if (!otherEnds.has(id)) demand.delete(id);
  let carDecks = deckWays.map((di, k) => ({ di, k })).filter(({ di }) => isCarDeck(di));
  const wanted = new Map<number, { y: number; weight: number }>();
  // (outside the heightmap the ground is just its edge value, so what a bridge wants there means nothing)
  const nodeAt = new Map<number, V2>();
  for (const d of dense) d.nodeIds.forEach((id, i) => { if (id > 0) nodeAt.set(id, d.pts[i]); });
  const x1 = hm.minX + (hm.cols - 1) * hm.cellSize, z1 = hm.minZ + (hm.rows - 1) * hm.cellSize;
  for (const [id, y] of demand) {
    const p = nodeAt.get(id);
    if (p && p[0] > hm.minX + 6 && p[0] < x1 - 6 && p[1] > hm.minZ + 6 && p[1] < z1 - 6) wanted.set(id, { y, weight: ANCHOR_WEIGHT });
  }

  // A car deck that ends where no road goes on (a ramp mapped to stop short, a service road into a garage the data does not have)
  // is designed to come down to the ground there, with a strong wish: before, it climbed to its clearance and stopped in the air.
  const useCount = new Map<number, number>();
  for (const d of dense) if (d.w.kind === 'car') for (const id of d.nodeIds) if (id > 0) useCount.set(id, (useCount.get(id) ?? 0) + 1);
  let deadDeckEnds = 0;
  const deckWish = (d: Dense, target: number[]) => {
    const n = d.pts.length;
    const t = target.slice();
    const weights = new Array<number>(n).fill(DECK_WISH_WEIGHT);
    for (const end of [0, n - 1]) {
      const id = d.nodeIds[end];
      if ((useCount.get(id) ?? 0) > 1 || groundNodeIds.has(id)) continue;
      const p = d.pts[end];
      // (not where the edge of the data is: the road goes on beyond the heightmap)
      if (p[0] < hm.minX + 8 || p[1] < hm.minZ + 8 || p[0] > hm.minX + (hm.cols - 1) * hm.cellSize - 8 || p[1] > hm.minZ + (hm.rows - 1) * hm.cellSize - 8) continue;
      t[end] = ground(p[0], p[1]) + 0.1;
      weights[end] = DEAD_END_WEIGHT;
      deadDeckEnds++;
    }
    return { target: t, weights };
  };
  const solveWays = [...profiled, ...carDecks.map((c) => c.di)];
  const clearances = deckClearances(dense, solveWays, profiled.length, deckWays, wish, ground);
  const res = solveProfiles(
    solveWays.map((i, si) => ({
      nodeIds: dense[i].nodeIds, pts: dense[i].pts, maxGrade: gradeLimit(dense[i].w.highway), halfWidth: dense[i].w.width / 2, speed: designSpeed(dense[i].w), rank: deckRank(dense[i].w),
      deck: si < profiled.length ? undefined : deckWish(dense[i], wish[carDecks[si - profiled.length].k]),
    })),
    { terrain: ground, wanted, clearances, ...profile },
  );
  // A mapped car bridge the design keeps within AT_GRADE of the terrain all along, with nothing to clear under it (a bridge over a
  // culvert, a creek the bare-earth model has filled in, something not in the data): a road on the ground, carved like one. As a
  // deck it was only seams with the ground, at its ends and wherever a lane crossed its kerbs.
  let atGrade = 0;
  {
    const P0 = profiled.length;
    const clearOf = new Set<number>();
    for (const c of clearances) clearOf.add(c.upper[0]);
    const keep: typeof carDecks = [];
    const conv: number[] = [];
    carDecks.forEach((cd, j) => {
      const d = dense[cd.di];
      let mx = -Infinity;
      d.pts.forEach((p, i) => { mx = Math.max(mx, res.h[P0 + j][i] - ground(p[0], p[1])); });
      if (mx < AT_GRADE && !clearOf.has(P0 + j)) conv.push(j); else keep.push(cd);
    });
    if (conv.length) {
      const rows = res.h;
      const newH = rows.slice(0, P0);
      const gone = new Set<number>();
      for (const j of conv) {
        const cd = carDecks[j];
        newH.push(rows[P0 + j]);
        profIndex.set(cd.di, profiled.length);
        profiled.push(cd.di);
        gone.add(cd.di);
        const d = dense[cd.di];
        d.w = { ...d.w, bridge: false, layer: 0 };
        for (const id of d.nodeIds) if (id > 0) groundNodeIds.add(id);
      }
      for (const cd of keep) newH.push(rows[P0 + carDecks.indexOf(cd)]);
      res.h = newH;
      carDecks = keep;
      deckWays = deckWays.filter((di) => !gone.has(di));
      atGrade = conv.length;
    }
  }
  const nodeY = new Map<number, number>();
  const spans: DeckSpan[][] = profiled.map(() => []);
  // A span the design lifts over a dip is a bridge only where something passes under it (a road, a railway, a path at least
  // 2.5 m lower): over a dip with nothing in it (most often the bare-earth model's hollow where an overpass was taken out) it is an
  // embankment, carved like any other road. A deck there was only ever a seam with the ground at both ends.
  const passesUnder = underpassTest(dense, profiled, res.h, ground);
  let embanked = 0;
  for (const d of res.decks) {
    if (passesUnder(d.way, d.from, d.to)) spans[d.way].push(d);
    else embanked++;
  }
  profiled.forEach((di, pi) => {
    const d = dense[di];
    for (let i = 0; i < d.pts.length; i++) if (d.nodeIds[i] > 0) nodeY.set(d.nodeIds[i], res.h[pi][i]);
  });
  const osmDeckEnds: V2[] = [];
  for (const di of deckWays) {
    const d = dense[di];
    for (const k of [0, d.pts.length - 1]) if (groundNodeIds.has(d.nodeIds[k])) osmDeckEnds.push(d.pts[k]);
  }

  const orig = Float32Array.from(hm.data);
  let segs: CarveSegment[] = [];
  let carved = { cut: 0, fill: 0, vertices: 0 };
  let smoothed = { vertices: 0, maxChange: 0 };
  let extendedNodes = 0;
  let unlanded = 0;
  // Cut and fill to the design, then smooth the creases of the carved corridor (crossings at different grades, the edges of cuts),
  // but not where a deck lands: its end must meet the ground exactly. A bridge the pipeline made must start where the carved
  // ground is at its height; where another road pulls the ground lower there (a road under the bridge, close to its abutment, has
  // its own height), the bridge starts a node earlier and the ground is carved again, until its ends land.
  // the profiled ground ways at each OSM node (for the mapped bridges' ends, below)
  const groundAt = new Map<number, { pi: number; i: number }[]>();
  profiled.forEach((di, pi) => dense[di].nodeIds.forEach((id, i) => { if (id > 0) { const l = groundAt.get(id); if (l) l.push({ pi, i }); else groundAt.set(id, [{ pi, i }]); } }));
  let mappedExtended = 0;
  for (let round = 0; round < 6; round++) {
    hm.data.set(orig);
    segs = [];
    profiled.forEach((di, pi) => {
      const d = dense[di];
      const onDeck = new Uint8Array(d.pts.length);
      for (const sp of spans[pi]) for (let i = sp.from; i < sp.to; i++) onDeck[i] = 1;
      for (let i = 0; i + 1 < d.pts.length; i++) {
        if (onDeck[i]) continue;
        segs.push({ a: d.pts[i], b: d.pts[i + 1], ha: res.h[pi][i], hb: res.h[pi][i + 1], halfWidth: d.w.width / 2 });
      }
    });
    carved = carveTerrain(hm, segs);
    const deckEnds: V2[] = [...osmDeckEnds];
    profiled.forEach((di, pi) => { for (const sp of spans[pi]) for (const k of [sp.from, sp.to]) deckEnds.push(dense[di].pts[k]); });
    const endGrid = new Map<string, V2[]>();
    for (const p of deckEnds) {
      const k = `${Math.floor(p[0] / 16)},${Math.floor(p[1] / 16)}`;
      const l = endGrid.get(k);
      if (l) l.push(p); else endGrid.set(k, [p]);
    }
    const nearDeckEnd = (x: number, z: number) => {
      for (let gx = Math.floor((x - FREEZE_R) / 16); gx <= Math.floor((x + FREEZE_R) / 16); gx++) {
        for (let gz = Math.floor((z - FREEZE_R) / 16); gz <= Math.floor((z + FREEZE_R) / 16); gz++) {
          for (const p of endGrid.get(`${gx},${gz}`) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < FREEZE_R) return true;
        }
      }
      return false;
    };
    smoothed = smoothCorridor(hm, segs, nearDeckEnd);
    // the ends of the bridges the pipeline made: does the ground meet them?
    let grew = 0;
    unlanded = 0;
    profiled.forEach((di, pi) => {
      const d = dense[di];
      const h = res.h[pi];
      for (const sp of spans[pi]) {
        const low = (k: number) => ground(d.pts[k][0], d.pts[k][1]) < h[k] - LAND_TOL;
        if (low(sp.from)) { if (sp.from > 0 && sp.to - sp.from < MAX_DECK_NODES) { sp.from--; grew++; } else unlanded++; }
        if (low(sp.to)) { if (sp.to < d.pts.length - 1 && sp.to - sp.from < MAX_DECK_NODES) { sp.to++; grew++; } else unlanded++; }
      }
      // spans that have grown into each other are one
      spans[pi].sort((x, y) => x.from - y.from);
      const merged: DeckSpan[] = [];
      for (const sp of spans[pi]) {
        const last = merged[merged.length - 1];
        if (last && sp.from <= last.to) last.to = Math.max(last.to, sp.to);
        else merged.push(sp);
      }
      spans[pi] = merged;
    });
    // A mapped bridge whose end the ground does not meet (the carving of a road beside it, a freeway's corridor, pulled the ground
    // there 0.7 m under it: a step down off the deck, a wall to drive up) carries on as a bridge the pipeline made along the road it
    // lands on, growing like one until the ground meets it.
    for (const { di, k: _k } of carDecks) {
      const d = dense[di];
      for (const end of [0, d.pts.length - 1]) {
        const id = d.nodeIds[end];
        for (const at of groundAt.get(id) ?? []) {
          const g = dense[profiled[at.pi]];
          const n = g.pts.length;
          if (at.i !== 0 && at.i !== n - 1) continue;
          const hh = res.h[at.pi][at.i];
          if (ground(g.pts[at.i][0], g.pts[at.i][1]) > hh - MAPPED_LAND_TOL) continue;
          const from = at.i === 0 ? 0 : n - 2, to = at.i === 0 ? 1 : n - 1;
          if (n < 2 || spans[at.pi].some((sp) => sp.from <= from && sp.to >= to)) continue;
          spans[at.pi].push({ way: at.pi, from, to });
          spans[at.pi].sort((x, y) => x.from - y.from);
          grew++;
          mappedExtended++;
        }
      }
    }
    extendedNodes += grew;
    if (!grew) break;
  }
  // OSM bridges: deck heights over the designed ground, then the ground is cut away where it would stand above a deck. A deck lands
  // at the design height of the road it starts from. (Landing it at the carved ground's height instead was tried: where the
  // ground there is pulled off the design, the deck then climbed steeply away from it. The deck's end is brought onto the
  // ground in `emitPiece` instead, gently.)
  // the car decks were designed with the ground roads; the others clear them and the roads under them
  const others = deckWays.filter((di) => !isCarDeck(di));
  const carRefs: RefWay[] = carDecks.map(({ di }, j) => ({ nodeIds: dense[di].nodeIds, pts: dense[di].pts, width: dense[di].w.width, layer: dense[di].w.layer, clearance: CLEARANCE.car, heights: res.h[profiled.length + j].map((y) => y + 0.1) }));
  const otherY = solveDecks(
    others.map((di) => ({ nodeIds: dense[di].nodeIds, pts: dense[di].pts, layer: dense[di].w.layer })),
    { groundAt: ground, groundNodeIds, groundRefs: [...refsAt(res.h), ...carRefs], groundNodeY: nodeY, thickness: DEFAULT_DECK_OPTIONS.thickness },
  );
  const deckY: number[][] = [];
  { let o = 0, c = 0; for (const di of deckWays) deckY.push(isCarDeck(di) ? res.h[profiled.length + c++] : otherY[o++]); }
  const groundH = res.h.slice(0, profiled.length);
  const under: UnderDeckSegment[] = [];
  deckWays.forEach((di, k) => {
    const d = dense[di];
    const m = d.pts.length;
    for (let i = 0; i + 1 < m; i++) under.push({ a: d.pts[i], b: d.pts[i + 1], ya: deckY[k][i], yb: deckY[k][i + 1], halfWidth: d.w.width / 2, endA: i === 0 && groundNodeIds.has(d.nodeIds[0]), endB: i + 2 === m && groundNodeIds.has(d.nodeIds[m - 1]) });
  });
  // and under the bridges the pipeline made (at their heights once landed, as buildRoads will have them): the round end of the
  // corridor carved to the road a bridge starts from reaches in under the deck, which goes down from there (0.3 m over the
  // ground 4 m in, where the wheels fell to the deck)
  profiled.forEach((di, pi) => {
    const d = dense[di];
    for (const sp of spans[pi]) {
      const pts = d.pts.slice(sp.from, sp.to + 1);
      const ys = landDeckEnds(pts, res.h[pi].slice(sp.from, sp.to + 1), ground, 20, true, true);
      for (let i = 0; i + 1 < pts.length; i++) under.push({ a: pts[i], b: pts[i + 1], ya: ys[i], yb: ys[i + 1], halfWidth: d.w.width / 2, endA: i === 0, endB: i + 2 === pts.length });
    }
  });
  // the carriageways on the ground (within their strips, not the round ends of the corridors) keep their carved height
  // (and around a junction of three or more of them, its corners)
  const strips = new DeckFootprints();
  for (const sg of segs) strips.addStrip(sg.a, sg.b, sg.halfWidth + 0.5);
  const legs = new Map<string, { n: number; p: V2; r: number }>();
  for (const sg of segs) for (const p of [sg.a, sg.b]) {
    const k = endKey(p);
    const l = legs.get(k);
    if (l) { l.n++; l.r = Math.max(l.r, sg.halfWidth + 2.5); } else legs.set(k, { n: 1, p, r: sg.halfWidth + 2.5 });
  }
  // (a deck that starts there is a leg too)
  const deckLeg = (p: V2, half: number) => { const l = legs.get(endKey(p)); if (l) { l.n++; l.r = Math.max(l.r, half + 2.5); } };
  for (const { di } of carDecks) { const d = dense[di]; deckLeg(d.pts[0], d.w.width / 2); deckLeg(d.pts[d.pts.length - 1], d.w.width / 2); }
  profiled.forEach((di, pi) => { for (const sp of spans[pi]) { const d = dense[di]; deckLeg(d.pts[sp.from], d.w.width / 2); deckLeg(d.pts[sp.to], d.w.width / 2); } });
  for (const l of legs.values()) if (l.n >= 3) strips.addStrip(l.p, l.p, l.r);
  // (within 1.5 m of the deck and blending out over 3 m: a wider bank dug into the junctions and kerbs beside a deck)
  const lowered = lowerTerrainUnder(hm, under, undefined, 1.5, 3, undefined, (x, z) => strips.containsStrip(x, z));
  return {
    dense, profiled, heights: groundH, spans, nodeY, deckWays, deckY,
    stats: { ...res.stats, deckSpans: res.stats.deckSpans - embanked, embankedSpans: embanked, carvedVertices: carved.vertices, maxCut: carved.cut, maxFill: carved.fill, underDeckCut: lowered.cut, smoothedVertices: smoothed.vertices, smoothMaxChange: smoothed.maxChange, deckNodesExtended: extendedNodes, deckEndsUnlanded: unlanded, atGradeBridges: atGrade, mappedEndsExtended: mappedExtended, deadDeckEnds },
  };
}

/** Extra length on each side of a crossed way that a deck keeps its clearance over it (m), as solveDecks has it. */
const CROSS_MARGIN = 3;

/**
 * Where a car deck (one of `solveWays` from index `firstDeck` on) crosses a way under it: a road of the ground network (also
 * designed in the solve: the deck and the road keep the clearance between them, the road dipping as much as the deck climbs, by
 * their weights), a lower car deck (likewise), or anything else (a railway, a path, a footbridge: a fixed height to clear). Every
 * deck node over the crossed way's width (and a margin) against every node of that way under the deck's width.
 */
export function deckClearances(dense: Dense[], solveWays: number[], firstDeck: number, deckWays: number[], wish: number[][], ground: (x: number, z: number) => number): Clearance[] {
  const solveOf = new Map<number, number>();
  solveWays.forEach((di, si) => solveOf.set(di, si));
  const wishOf = new Map<number, number[]>();
  deckWays.forEach((di, k) => wishOf.set(di, wish[k]));
  const G = 32;
  const grid = new Map<string, [number, number][]>();
  dense.forEach((d, di) => {
    if (d.w.sub === 'crossing') return;
    for (let j = 0; j + 1 < d.pts.length; j++) {
      const a = d.pts[j], b = d.pts[j + 1];
      for (let gx = Math.floor(Math.min(a[0], b[0]) / G); gx <= Math.floor(Math.max(a[0], b[0]) / G); gx++) {
        for (let gz = Math.floor(Math.min(a[1], b[1]) / G); gz <= Math.floor(Math.max(a[1], b[1]) / G); gz++) {
          const key = `${gx},${gz}`;
          const l = grid.get(key);
          if (l) l.push([di, j]); else grid.set(key, [[di, j]]);
        }
      }
    }
  });
  const out: Clearance[] = [];
  const seen = new Set<string>();
  // nodes of a way within `reach` (m, along it) of a point on segment i at parameter t
  const near = (pts: V2[], i: number, t: number, reach: number): number[] => {
    const at: V2 = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    const list = [i, i + 1];
    for (const dir of [-1, 1]) {
      let m = dir < 0 ? i : i + 1, dist = Math.hypot(pts[m][0] - at[0], pts[m][1] - at[1]);
      for (;;) {
        const nx = m + dir;
        if (nx < 0 || nx >= pts.length) break;
        dist += Math.hypot(pts[nx][0] - pts[m][0], pts[nx][1] - pts[m][1]);
        if (dist > reach) break;
        list.push(nx);
        m = nx;
      }
    }
    return list;
  };
  for (let si = firstDeck; si < solveWays.length; si++) {
    const d = dense[solveWays[si]];
    for (let i = 0; i + 1 < d.pts.length; i++) {
      const a0 = d.pts[i], a1 = d.pts[i + 1];
      const cand = new Set<string>();
      for (let gx = Math.floor(Math.min(a0[0], a1[0]) / G); gx <= Math.floor(Math.max(a0[0], a1[0]) / G); gx++) {
        for (let gz = Math.floor(Math.min(a0[1], a1[1]) / G); gz <= Math.floor(Math.max(a0[1], a1[1]) / G); gz++) {
          for (const [ri, j] of grid.get(`${gx},${gz}`) ?? []) cand.add(`${ri},${j}`);
        }
      }
      for (const c of cand) {
        const [ri, j] = c.split(',').map(Number);
        if (ri === solveWays[si]) continue;
        const r = dense[ri];
        if (r.w.layer >= d.w.layer) continue;
        const b0 = r.pts[j], b1 = r.pts[j + 1];
        if (d.nodeIds[i] === r.nodeIds[j] || d.nodeIds[i] === r.nodeIds[j + 1] || d.nodeIds[i + 1] === r.nodeIds[j] || d.nodeIds[i + 1] === r.nodeIds[j + 1]) continue;
        const x = segmentIntersection(a0, a1, b0, b1);
        if (!x) continue;
        const la = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]), lb = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
        if (la < 1e-6 || lb < 1e-6) continue;
        const sin = Math.max(0.3, Math.abs(((a1[0] - a0[0]) * (b1[1] - b0[1]) - (a1[1] - a0[1]) * (b1[0] - b0[0])) / (la * lb)));
        const gap = CLEARANCE[r.w.kind] + DEFAULT_DECK_OPTIONS.thickness + 0.1;
        const up = near(d.pts, i, x.t, (r.w.width / 2 + CROSS_MARGIN) / sin);
        const rs = solveOf.get(ri);
        if (rs !== undefined) {
          for (const k of near(r.pts, j, x.u, (d.w.width / 2 + CROSS_MARGIN) / sin)) {
            for (const m of up) {
              const key = `${si},${m},${rs},${k}`;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push({ upper: [si, m], lower: [rs, k], gap });
            }
          }
        } else {
          const w = wishOf.get(ri);
          const lower = w ? w[j] + (w[j + 1] - w[j]) * x.u : ground(x.x, x.z) + 0.1;
          for (const m of up) out.push({ upper: [si, m], lower, gap });
        }
      }
    }
  }
  return out;
}

/**
 * Whether anything passes under the span `from..to` of profiled way `pi`: a segment of another way on the ground (a road, a
 * railway, a path; not one sharing a node with the span) that crosses it in plan at least `clearance` m below the design.
 */
export function underpassTest(dense: Dense[], profiled: number[], h: number[][], ground: (x: number, z: number) => number, clearance = 2.5): (pi: number, from: number, to: number) => boolean {
  const prof = new Map<number, number>();
  profiled.forEach((di, pi) => prof.set(di, pi));
  const cell = 32;
  const grid = new Map<string, { di: number; i: number }[]>();
  dense.forEach((d, di) => {
    if (d.w.bridge) return;
    for (let i = 0; i + 1 < d.pts.length; i++) {
      const a = d.pts[i], b = d.pts[i + 1];
      for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++) {
        for (let gz = Math.floor(Math.min(a[1], b[1]) / cell); gz <= Math.floor(Math.max(a[1], b[1]) / cell); gz++) {
          const k = `${gx},${gz}`;
          const l = grid.get(k);
          if (l) l.push({ di, i }); else grid.set(k, [{ di, i }]);
        }
      }
    }
  });
  return (pi, from, to) => {
    const di0 = profiled[pi];
    const d0 = dense[di0];
    const ids = new Set(d0.nodeIds.slice(from, to + 1));
    for (let i = from; i < to; i++) {
      const a = d0.pts[i], b = d0.pts[i + 1];
      const seen = new Set<string>();
      for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++) {
        for (let gz = Math.floor(Math.min(a[1], b[1]) / cell); gz <= Math.floor(Math.max(a[1], b[1]) / cell); gz++) {
          for (const { di, i: j } of grid.get(`${gx},${gz}`) ?? []) {
            if (di === di0) continue;
            const key = `${di}:${j}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const o = dense[di];
            if (ids.has(o.nodeIds[j]) || ids.has(o.nodeIds[j + 1])) continue;
            const x = segmentIntersection(a, b, o.pts[j], o.pts[j + 1]);
            if (!x) continue;
            const top = h[pi][i] + (h[pi][i + 1] - h[pi][i]) * x.t;
            const op = prof.get(di);
            const below = op !== undefined ? h[op][j] + (h[op][j + 1] - h[op][j]) * x.u : ground(x.x, x.z);
            if (top - below >= clearance) return true;
          }
        }
      }
    }
    // A fill would also bury, or pull down, a road that runs close beside the span at another height (a ramp, a carriageway in
    // the dip next to it): the carving cannot give both their heights in the space between them, so the span stays a bridge.
    for (let i = from; i <= to; i++) {
      const p = d0.pts[i];
      const hw = d0.w.width / 2;
      for (const { di, i: j } of grid.get(`${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`) ?? []) {
        if (di === di0) continue;
        const o = dense[di];
        if (o.w.kind === 'ped' || ids.has(o.nodeIds[j]) || ids.has(o.nodeIds[j + 1])) continue;
        const a = o.pts[j], b = o.pts[j + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const l2 = dx * dx + dz * dz;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
        const dist = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
        if (dist > hw + o.w.width / 2 + 3) continue;
        const op = prof.get(di);
        const oy = op !== undefined ? h[op][j] + (h[op][j + 1] - h[op][j]) * t : ground(a[0] + t * dx, a[1] + t * dz);
        if (Math.abs(h[pi][i] - oy) > 1) return true;
      }
    }
    return false;
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

export function buildRoads(input: RoadPlan | RoadWay[], hm: Heightmap, bounds: Rect, nodes: Map<number, NodeInfo> = new Map(), opts: { seamClear?: number } = {}): RoadMeshes {
  const plan = Array.isArray(input) ? planRoads(input, hm) : input;
  const res: RoadMeshes = {
    asphalt: new MeshBuilder(), sidewalk: new MeshBuilder(), crosswalk: new MeshBuilder(), rail: new MeshBuilder(),
    concrete: new MeshBuilder(), collision: new MeshBuilder(), json: [], junctions: [], junctionStats: { candidates: 0, clusters: 0, built: 0, rejected: {} }, runs: [], markings: new MeshBuilder(), mask: new RoadMask(), markingStats: { lines: 0, crosswalks: 0, bars: 0, stopBars: 0 }, controls: { junctions: [], signals: [], stops: [] }, crossings: [], barriers: [], exported: { junctions: [], signals: [], stops: [], crossings: [] },
    stats: { ways: 0, drivableWays: 0, deckWays: 0, deckMetres: 0, piers: 0, maxDeckHeightAboveGround: 0 },
  };
  const ground = (x: number, z: number) => surfaceHeight(hm, x, z);
  const thickness = DEFAULT_DECK_OPTIONS.thickness;
  // texture coordinates on the carriageways and sidewalks, ambient occlusion on every mesh (see "Mesh attributes (meshFormat 2)")
  for (const mb of [res.asphalt, res.sidewalk]) { mb.channel('uv', 2); mb.channel('uv1', 2); }
  for (const mb of [res.asphalt, res.sidewalk, res.crosswalk, res.rail, res.concrete, res.markings]) mb.channel('ao', 1, [1]);

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
  // A tile of a grid builds no junction polygon within `seamClear` of its edges (a seam: the polygon would straddle it, and the legs
  // would not end at the seam where the neighbour's lanes do); the roads meet there as a junction without a polygon, their lanes
  // running on to the seam.
  const seamClear = opts.seamClear ?? 0;
  const nodeXZ = new Map<number, V2>();
  if (seamClear > 0) for (const d of dense) d.nodeIds.forEach((id, i) => { if (id > 0) nodeXZ.set(id, d.pts[i]); });
  const nearSeam = (id: number) => {
    const p = nodeXZ.get(id);
    return !!p && (p[0] - bounds.minX < seamClear || bounds.maxX - p[0] < seamClear || p[1] - bounds.minZ < seamClear || bounds.maxZ - p[1] < seamClear);
  };
  const jr = buildJunctions(jways, { liftOf: roadLift, skipNode: (id) => deckNodeIds.has(id) || (seamClear > 0 && nearSeam(id)) });
  res.junctions = jr.junctions;
  res.junctionStats = jr.stats;
  const mask = res.mask;
  for (const g of dense) if (g.w.kind === 'car' && !g.w.bridge) mask.addPolyline(g.pts, g.w.width / 2);
  for (const j of res.junctions) mask.addPolygon(j.polygon.map((q) => [q.x, q.z] as V2));
  const carPos = new Map<number, number>();
  carIdx.forEach((di, k) => carPos.set(di, k));
  for (const j of jr.junctions) {
    let top = j.legs[0];
    for (const l of j.legs) if (rankOf(l.highway) > rankOf(top.highway)) top = l;
    const g = srgbToLinear(grayOf(top.highway));
    addJunctionMesh(res.asphalt, j, ground, [g, g, g * 1.02], Math.max(...j.legs.map((l) => roadLift(dense[carIdx[l.way]].w))), { cell: hm.cellSize, origin: [hm.minX, hm.minZ] });
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
  // The deck heights of the bridges the pipeline made: the design profile, except near the ends, which take the carved ground's
  // height there and blend back into the design over up to 20 m. The carving puts the ground at the design height, but not
  // always exactly: a parallel carriageway, a ramp or a road below that overlaps the end pulls it (the Downtown Connector's
  // carriageways overlap, and a deck end stood 0.47 m off the ground). The deck's top then equals the heightmap at its ends.
  // (only an end that is on its own: where it meets another deck, a mapped bridge or another of these, it is a joint in the air)
  const deckWaysAt = new Map<number, Set<number>>();
  const mark = (id: number, di: number) => { const st = deckWaysAt.get(id); if (st) st.add(di); else deckWaysAt.set(id, new Set([di])); };
  plan.profiled.forEach((di, pi) => { for (const sp of plan.spans[pi]) for (let i = sp.from; i <= sp.to; i++) mark(dense[di].nodeIds[i], di); });
  for (const di of plan.deckWays) for (const id of dense[di].nodeIds) mark(id, di);
  const deckHeights = new Map<string, number[]>();
  plan.profiled.forEach((di, pi) => {
    const d = dense[di];
    for (const sp of plan.spans[pi]) {
      const hs = plan.heights[pi].slice(sp.from, sp.to + 1);
      const pts = d.pts.slice(sp.from, sp.to + 1);
      // (a joint with another deck lands too where it is on the ground: every deck there is brought down alike)
      const alone = (k: number) => (deckWaysAt.get(d.nodeIds[k])?.size ?? 0) <= 1 || Math.abs(ground(d.pts[k][0], d.pts[k][1]) - plan.heights[pi][k]) <= JOINT_LAND;
      deckHeights.set(`${pi}:${sp.from}`, landDeckEnds(pts, hs, ground, 20, alone(sp.from), alone(sp.to)));
    }
  });
  const deckH = (pi: number, from: number, i: number) => deckHeights.get(`${pi}:${from}`)?.[i - from] ?? plan.heights[pi][i];
  // sidewalks and paths that run beside a bridge the pipeline made go over the same gap
  const bridgeSegs: { a: V2; b: V2; ha: number; hb: number; reach: number }[] = [];
  plan.profiled.forEach((di, pi) => {
    const d = dense[di];
    for (const sp of plan.spans[pi]) for (let i = sp.from; i < sp.to; i++) bridgeSegs.push({ a: d.pts[i], b: d.pts[i + 1], ha: deckH(pi, sp.from, i), hb: deckH(pi, sp.from, i + 1), reach: d.w.width / 2 + 5 });
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
        const ys = plan.heights[pi!].slice(run.from, run.to + 1).map((_, k) => deckH(pi!, run.from, run.from + k) + lift);
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

  // every car and rail way, on the ground or on a deck: a pier never stands in a carriageway, whichever level it is on
  const below = dense.filter((g) => g.w.kind !== 'ped');

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
  // where car decks overlap, their ribbons share one surface (DeckBlend)
  const blend = new DeckBlend(meshPieces.map(clean).filter((c): c is Piece => !!c && !!c.deckY && c.way.kind === 'car').map((c) => ({ way: c.way, pts: c.pts, y: c.deckY!.map((y) => y - (c.derived ? roadLift(c.way) : 0)) })));
  res.stats.deckJunctions = blend.count;
  // the ends of car deck pieces that meet another deck (an end or a vertex of another deck way): joints, not landings
  const joints = new Set<string>();
  {
    const carDeckPieces = meshPieces.map(clean).filter((c): c is Piece => !!c && !!c.deckY && c.way.kind === 'car');
    const at = new Map<string, Set<number>>();
    for (const c of carDeckPieces) for (const p of c.pts) { const k = endKey(p); const st = at.get(k); if (st) st.add(c.way.id); else at.set(k, new Set([c.way.id])); }
    const endCount = new Map<string, number>();
    for (const c of carDeckPieces) for (const p of [c.pts[0], c.pts[c.pts.length - 1]]) endCount.set(endKey(p), (endCount.get(endKey(p)) ?? 0) + 1);
    for (const c of carDeckPieces) {
      for (const p of [c.pts[0], c.pts[c.pts.length - 1]]) {
        const k = endKey(p);
        if ((at.get(k)?.size ?? 0) > 1 || (endCount.get(k) ?? 0) > 1) joints.add(k);
      }
    }
  }
  for (const piece of pieces) {
    const c = clean(piece);
    if (c) emitPiece(res, c.way, c.pts, c.deckY, ground, thickness, below, !!c.derived, { mesh: false, blend, joints });
  }
  const roadIndex = new RoadCrossIndex(res.json, bounds);
  // the car decks' footprints: a sidewalk's slab is not solid where it overlaps one (it would be a step in the carriageway)
  const carDecks = new DeckFootprints();
  const cleaned = trimDeckJoins(meshPieces.map(clean));
  cleaned.forEach((c) => { if (c && c.deckY && c.way.kind === 'car') carDecks.add(c.pts, c.way.width / 2); });
  // ... and the carriageways on the ground: a footbridge or a rail deck that crosses one too low for a car to pass under is not
  // solid there (the profile could not lift it clear: its slab stood in the lane, a metre over the road)
  const carRoads = new DeckFootprints();
  cleaned.forEach((c) => { if (c && !c.deckY && c.way.kind === 'car') carRoads.add(c.pts, c.way.width / 2); });
  // the walks that come off a bridge's sidewalk (a sidewalk on a bridge deck: a mapped ramp or the extension of one, sharing its end
  // node): their surface is not drawn over a car carriageway below them (see emitPiece)
  const bridgeWalkNodes = new Set<number>();
  for (const g of dense) if (g.w.bridge && g.w.kind === 'ped') for (const id of g.nodeIds) if (id > 0) bridgeWalkNodes.add(id);
  const rampWays = new Set<number>();
  const bridgeWalkEnds: V2[] = [];
  for (const g of dense) {
    if (g.w.kind !== 'ped' || g.w.sub === 'crossing' || g.w.highway === 'steps') continue;
    if (g.w.bridge) { rampWays.add(g.w.id); bridgeWalkEnds.push(g.pts[0], g.pts[g.pts.length - 1]); } else if (bridgeWalkNodes.has(g.nodeIds[0]) || bridgeWalkNodes.has(g.nodeIds[g.nodeIds.length - 1])) rampWays.add(g.w.id);
  }
  const nearBridgeWalk = (x: number, z: number) => bridgeWalkEnds.some((p) => Math.hypot(p[0] - x, p[1] - z) <= RAMP_REACH);
  const deckEnds: DeckEnd[] = [];
  const weld = { segs: [] as WeldSegment[], polys: [] as WeldPolygon[], piece: 0 };
  for (const c of cleaned) {
    if (!c) continue;
    if (c.way.sub === 'crossing') continue; // crossings are zebra markings now (below)
    weld.piece++;
    emitPiece(res, c.way, c.pts, c.deckY, ground, thickness, below, !!c.derived, { json: false, roadIndex, carDecks, carRoads, rampRoads: rampWays.has(c.way.id) ? { roads: carRoads, near: nearBridgeWalk } : undefined, ends: deckEnds, blend, joints, weld });
    if (c.way.kind === 'car') res.runs.push({ way: c.way, pts: c.pts, deckY: c.deckY, startJ: c.startJ, endJ: c.endJ });
  }
  res.stats.deckCaps = addDeckCaps(res, deckEnds, thickness, weld.polys);
  const welded = weldDeckTops(res.collision, weld.segs, weld.polys, 4, [bounds.minX, bounds.minZ], ground);
  res.stats.deckLevels = welded.levels;
  res.stats.weldedTriangles = welded.triangles;
  res.stats.weldFailedLevels = welded.failedLevels;
  res.stats.deckClashes = welded.clashes ?? 0;

  // markings
  const mk = res.markings;
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
  what: { roadIndex?: RoadCrossIndex; json?: boolean; mesh?: boolean; carDecks?: DeckFootprints; carRoads?: DeckFootprints; rampRoads?: { roads: DeckFootprints; near: (x: number, z: number) => boolean }; ends?: DeckEnd[]; blend?: DeckBlend; joints?: Set<string>; weld?: { segs: WeldSegment[]; polys: WeldPolygon[]; piece: number } } = {},
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
  // a deck the pipeline made is drawn `lift` over the surface it is solid at (see the collision slab below)
  const drop = deckY && derived ? lift : 0;
  for (let i = 0; i < n; i++) {
    if (deckY) {
      // where decks overlap every ribbon takes the blended height, corner by corner, so overlapping ribbons coincide
      const col = deckY[i] - drop;
      const pl = what.blend;
      const rk = way.kind === 'car' ? deckRank(way) : Infinity;
      topY.push((pl ? pl.adjust(pts[i][0], pts[i][1], col, rk) : col) + drop);
      lY.push((pl ? pl.adjust(left[i][0], left[i][1], col, rk) : col) + drop);
      rY.push((pl ? pl.adjust(right[i][0], right[i][1], col, rk) : col) + drop);
    } else {
      const c = ground(pts[i][0], pts[i][1]);
      const l = ground(left[i][0], left[i][1]);
      const r = ground(right[i][0], right[i][1]);
      topY.push(c + lift);
      lY.push(Math.max(c - 0.5, Math.min(c + 0.5, l)) + lift);
      rY.push(Math.max(c - 0.5, Math.min(c + 0.5, r)) + lift);
    }
  }

  if (deckY && n >= 2) {
    // An end that lands (on its own, not a joint with another deck, and within 1.5 m of the ground) is brought to the ground's
    // height there, the move fading out over up to 20 m: whatever the blending above or the carving below did, the deck's top
    // equals the heightmap where the car crosses from one to the other.
    const s: number[] = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = s[n - 1];
    const L = Math.max(1, Math.min(20, len / 2));
    const fade = (d: number) => { const u = Math.max(0, Math.min(1, d / L)); return 1 - u * u * (3 - 2 * u); };
    for (const [i, from] of [[0, (k: number) => s[k]], [n - 1, (k: number) => len - s[k]]] as const) {
      const e = ground(pts[i][0], pts[i][1]) - (topY[i] - drop);
      // a joint with another deck is in the air, unless it is on the ground (the decks of a fork that starts at a junction)
      if (what.joints?.has(endKey(pts[i])) && Math.abs(e) > JOINT_LAND) continue;
      // (no more than 6% of extra grade: a short piece far off the ground is not brought down in a metre)
      if (Math.abs(e) > Math.min(1.5, 0.06 * L) || Math.abs(e) < 1e-4) continue;
      for (let k = 0; k < n; k++) {
        const f = e * fade(from(k));
        topY[k] += f; lY[k] += f; rY[k] += f;
      }
    }
  }

  // A bridge's sidewalk, or a walk that comes down off one within RAMP_REACH of its end, is not drawn over a car carriageway below it: a
  // quad with a corner on the carriageway and within RAMP_OVER of the ground beneath it (or below it) is left out of the surface and of
  // its underside and skirts. The walk still meets the ground on either side of it.
  const dropQuad: boolean[] = [];
  if (what.rampRoads && way.kind === 'ped') {
    const rr = what.rampRoads;
    // a walk off a bridge is a ramp only where it comes down from the deck: within RAMP_REACH of a quad its height changes by RAMP_RISE
    const s: number[] = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const top = (i: number) => Math.max(lY[i], rY[i]), bottom = (i: number) => Math.min(lY[i], rY[i]);
    for (let i = 0; i + 1 < n; i++) {
      const corners: V2[] = [left[i], right[i], left[i + 1], right[i + 1]];
      const over = corners.some((q) => rr.roads.contains(q[0], q[1], 0));
      const cx = (pts[i][0] + pts[i + 1][0]) / 2, cz = (pts[i][1] + pts[i + 1][1]) / 2;
      const low = Math.min(lY[i], rY[i], lY[i + 1], rY[i + 1]) <= ground(cx, cz) + RAMP_OVER;
      let hi = -Infinity, lo = Infinity;
      for (let j = 0; j < n; j++) if (Math.abs(s[j] - s[i]) <= RAMP_REACH) { hi = Math.max(hi, top(j)); lo = Math.min(lo, bottom(j)); }
      dropQuad.push(over && low && (way.bridge || (rr.near(cx, cz) && hi - lo >= RAMP_RISE)));
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
      ...(way.maxspeed ? { maxspeed: way.maxspeed } : {}),
      ...(derived ? { derived: true } : {}),
      points: simp,
    });
    res.stats.drivableWays++;
  }

  if (!wantMesh) return;

  const base = target.vertexCount;
  const hasUv = target.channels.has('uv');
  let along = 0;
  for (let i = 0; i < n; i++) {
    const li = target.vertex(left[i][0], lY[i], left[i][1], 0, 1, 0, color[0], color[1], color[2]);
    const ri = target.vertex(right[i][0], rY[i], right[i][1], 0, 1, 0, color[0], color[1], color[2]);
    if (!hasUv) continue;
    if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const w = Math.hypot(right[i][0] - left[i][0], right[i][1] - left[i][1]);
    // which edge of a sidewalk has the carriageway beside it: probe 2 m past each edge (+1: the right one, -1: the left one, 0: neither or both)
    let kerb = 0;
    if (target === res.sidewalk && w > 0.1) {
      const nx = (right[i][0] - left[i][0]) / w, nz = (right[i][1] - left[i][1]) / w;
      const rr = res.mask.contains(right[i][0] + nx * 2, right[i][1] + nz * 2);
      const ll = res.mask.contains(left[i][0] - nx * 2, left[i][1] - nz * 2);
      kerb = rr && !ll ? 1 : ll && !rr ? -1 : 0;
    }
    target.set('uv', li, 0, along);
    target.set('uv', ri, w, along);
    target.set('uv1', li, w / 2, kerb);
    target.set('uv1', ri, w / 2, kerb);
  }
  if (dropQuad.some((d) => d)) {
    const idx = ribbonIndices(n, base);
    for (let i = 0; i + 1 < n; i++) if (!dropQuad[i]) target.indices.push(...idx.slice(6 * i, 6 * i + 6));
    res.stats.rampQuadsDropped = (res.stats.rampQuadsDropped ?? 0) + dropQuad.filter((d) => d).length;
  } else target.indices.push(...ribbonIndices(n, base));
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
  const under = ribbonIndices(n, ub, true);
  for (let i = 0; i + 1 < n; i++) if (!dropQuad[i]) c.indices.push(...under.slice(6 * i, 6 * i + 6));
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
      if (dropQuad[i]) continue; // (no wall under a walk that is left out there)
      const a = sb + 2 * i; // top i
      const b = a + 1; // bottom i
      const a2 = a + 2;
      const b2 = a + 3;
      if (side === 0) c.indices.push(a, a2, b, b, a2, b2);
      else c.indices.push(a, b, a2, a2, b, b2);
    }
  }

  // The collision slab. Its top is the road surface without the drawn lift where the deck is one the pipeline made (a derived
  // bridge, or a sidewalk beside one): the ground road it continues is the heightmap itself, so a lifted deck was a 6 to 10 cm
  // step at both ends. An end that lands on the ground goes a little under it at each corner, so the wheel rays pass from the
  // heightmap to the deck where the two cross, with no step and no edge standing proud of the road.
  const colL: number[] = [];
  const colR: number[] = [];
  for (let i = 0; i < n; i++) { colL.push(lY[i] - drop); colR.push(rY[i] - drop); }
  for (const i of [0, n - 1]) {
    const gc = ground(pts[i][0], pts[i][1]);
    const top = (colL[i] + colR[i]) / 2;
    if (Math.abs(top - gc) > LANDED) continue;
    // (a corner over ground that falls away, the side of an embankment the end stands on, stays at the deck's height: brought
    // down to that ground it tilted the deck's end a metre sideways under the lanes)
    const gl = ground(left[i][0], left[i][1]) - BURY, gr = ground(right[i][0], right[i][1]) - BURY;
    if (gl > colL[i] - MAX_BURY) colL[i] = Math.min(colL[i], gl);
    if (gr > colR[i] - MAX_BURY) colR[i] = Math.min(colR[i], gr);
    res.stats.landedDeckEnds = (res.stats.landedDeckEnds ?? 0) + 1;
  }
  // a sidewalk's slab where it overlaps a car deck is left out: the car deck is the floor there
  const solid: boolean[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const corners = [left[i], right[i], left[i + 1], right[i + 1]];
    const lowOver = way.kind !== 'car' && !!what.carRoads && corners.some((q) => what.carRoads!.contains(q[0], q[1], -0.5) && Math.min(colL[i], colR[i], colL[i + 1], colR[i + 1]) - thickness < ground(q[0], q[1]) + LOW_DECK);
    const over = lowOver || (way.kind === 'ped' && !!what.carDecks && corners.some((q) => what.carDecks!.contains(q[0], q[1])));
    solid.push(!over);
    if (over) res.stats.pedSlabSegmentsDropped = (res.stats.pedSlabSegmentsDropped ?? 0) + 1;
  }
  const col = res.collision;
  const cb = col.vertexCount;
  for (let i = 0; i < n; i++) {
    col.vertex(left[i][0], colL[i], left[i][1], 0, 1, 0);
    col.vertex(right[i][0], colR[i], right[i][1], 0, 1, 0);
  }
  for (let i = 0; i < n; i++) {
    col.vertex(left[i][0], colL[i] - thickness, left[i][1], 0, 1, 0);
    col.vertex(right[i][0], colR[i] - thickness, right[i][1], 0, 1, 0);
  }
  const topL = (i: number) => cb + 2 * i;
  const topR = (i: number) => cb + 2 * i + 1;
  const botL = (i: number) => cb + 2 * n + 2 * i;
  const botR = (i: number) => cb + 2 * n + 2 * i + 1;
  for (let i = 0; i + 1 < n; i++) {
    if (!solid[i]) continue;
    // top (up), underside (down), and the two sides; a car deck's top is welded into its level's one surface instead (deckWeld.ts)
    if (what.weld && way.kind === 'car') {
      what.weld.segs.push({ piece: what.weld.piece, rank: deckRank(way), a: pts[i], b: pts[i + 1], half, l0: left[i], r0: right[i], l1: left[i + 1], r1: right[i + 1], hl0: colL[i], hr0: colR[i], hl1: colL[i + 1], hr1: colR[i + 1] });
    } else col.indices.push(topL(i), topR(i), topL(i + 1), topL(i + 1), topR(i), topR(i + 1));
    col.indices.push(botL(i), botL(i + 1), botR(i), botL(i + 1), botR(i + 1), botR(i));
    col.indices.push(topL(i), topL(i + 1), botL(i), botL(i), topL(i + 1), botL(i + 1));
    col.indices.push(topR(i), botR(i), topR(i + 1), topR(i + 1), botR(i), botR(i + 1));
  }
  if (way.kind === 'car' && what.weld) res.stats.barrierMetres = (res.stats.barrierMetres ?? 0) + addBarriers(res, pts, left, right, lY, rY, colL, colR, ground, what.blend, what.roadIndex, `osm:way/${way.id}`);
  if (what.ends && way.kind === 'car') {
    for (const i of [0, n - 1]) what.ends.push({ x: pts[i][0], z: pts[i][1], l: left[i], r: right[i], y: (lY[i] + rY[i]) / 2, cy: (colL[i] + colR[i]) / 2, gray: color[0], way, drop, blend: what.blend });
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
    const halfW = way.kind === 'ped' ? 0.4 : Math.max(0.7, Math.min(4, way.width * 0.3));
    const halfL = way.kind === 'ped' ? 0.4 : 0.9;
    // (the whole pier, not only its centre: a wide one reached 4 m into the road beside it)
    if (overRoad(p, below.filter((b) => b.w !== way), Math.max(halfW, halfL))) continue;
    addOrientedBox(c, p[0], p[1], g - 0.5, bottom, dir, halfL, halfW, colC);
    addOrientedBox(col, p[0], p[1], g - 0.5, bottom, dir, halfL, halfW);
    res.stats.piers++;
  }
}

/**
 * A deck's heights (`hs` at `pts`) with each end (`start`, `end`: those that land) moved to the ground's height there and the move faded out (smoothstep) over the
 * first and last `blend` metres (at most half the deck each), so the deck meets the ground exactly and keeps a smooth profile.
 */
export function landDeckEnds(pts: V2[], hs: number[], ground: (x: number, z: number) => number, blend = 20, start = true, end = true): number[] {
  const n = pts.length;
  if (n < 2) return hs.slice();
  const s: number[] = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const len = s[n - 1];
  const L = Math.max(1, Math.min(blend, len / 2));
  // (an end more than 1.5 m off the ground is not landing: it is left as it is)
  const off = (e: number) => (Math.abs(e) <= Math.min(1.5, 0.06 * L) ? e : 0);
  const e0 = start ? off(ground(pts[0][0], pts[0][1]) - hs[0]) : 0;
  const e1 = end ? off(ground(pts[n - 1][0], pts[n - 1][1]) - hs[n - 1]) : 0;
  const fade = (d: number) => { const u = Math.max(0, Math.min(1, d / L)); return 1 - u * u * (3 - 2 * u); };
  return hs.map((h, i) => h + e0 * fade(s[i]) + e1 * fade(len - s[i]));
}

/** A deck piece's end, by position (0.5 m). */
const endKey = (p: V2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;

/** A deck end this close (m) to the ground at its centre has landed: its collision slab goes under the ground there. */
const LANDED = 0.3;
/** A joint of decks this close (m) to the ground lands like an end on its own: every deck at it is brought to the ground alike. */
const JOINT_LAND = 0.6;
/** A footbridge's or a rail deck's underside less than this over a carriageway below it leaves the slab out there, m. */
const LOW_DECK = 4;
/** A walk ramp off a bridge's sidewalk is not drawn over a car carriageway whose ground is within this (m) of it or below it. */
const RAMP_OVER = 1;
/** How far (m) from the end of a bridge's sidewalk a walk that comes off it still counts as its ramp (the extension is about 17 m). */
const RAMP_REACH = 25;
/** A walk that comes off a bridge's sidewalk and rises or falls this much (m) along its length is a ramp, not a walk at grade. */
const RAMP_RISE = 2;
/** How far under the ground a landed deck end's slab goes at each corner, m. */
const BURY = 0.03;
/** A landed end's corner is never taken further down than this (m) to meet the ground. */
const MAX_BURY = 0.6;

/** The car decks' footprints (each segment's centreline and half width), on a 16 m grid. */
export class DeckFootprints {
  private readonly segs: { ax: number; az: number; bx: number; bz: number; half: number }[] = [];
  private readonly cells = new Map<string, number[]>();

  /** One segment, for `containsStrip`. */
  addStrip(a: V2, b: V2, half: number) {
    this.add([a, b], half);
  }

  /** Inside one of the segments' strips: beside it within its half width, between its ends (not past them). */
  containsStrip(x: number, z: number): boolean {
    for (const k of this.cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const s = this.segs[k];
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      if (l2 === 0) { if (Math.hypot(x - s.ax, z - s.az) <= s.half) return true; continue; }
      const t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      if (t < 0 || t > 1) continue;
      if (Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) <= s.half) return true;
    }
    return false;
  }

  add(pts: V2[], half: number) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const k = this.segs.length;
      const a = pts[i], b = pts[i + 1];
      this.segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], half });
      for (let gx = Math.floor((Math.min(a[0], b[0]) - half) / 16); gx <= Math.floor((Math.max(a[0], b[0]) + half) / 16); gx++) {
        for (let gz = Math.floor((Math.min(a[1], b[1]) - half) / 16); gz <= Math.floor((Math.max(a[1], b[1]) + half) / 16); gz++) {
          const key = `${gx},${gz}`;
          const l = this.cells.get(key);
          if (l) l.push(k); else this.cells.set(key, [k]);
        }
      }
    }
  }

  /** Whether (x, z) is on a car deck (a little inside its edge). */
  contains(x: number, z: number, inset = 0.1): boolean {
    for (const k of this.cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const s = this.segs[k];
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if (Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) < s.half - inset) return true;
    }
    return false;
  }
}

/**
 * Where car decks overlap (a crossing or a fork on a bridge, two ways meeting at an angle, a ramp leaving a viaduct), each ribbon is
 * flat across its width at its own centreline's height, so where two cross at different grades their overlapping parts differ by
 * the grade times the distance from the node: a step in the carriageway (0.35 m 7 m out at 5%). This blends them the way the
 * carving blends the ground: a deck vertex takes the mean of the heights of every deck at its own level (within 1.5 m) whose
 * carriageway is near it, each weighted by the distance from that carriageway's edge (inside it: full weight), so where ribbons
 * overlap they have one surface, and a ribbon on its own keeps its height.
 */
export class DeckBlend {
  private readonly segs: { ax: number; az: number; bx: number; bz: number; ha: number; hb: number; half: number; rank: number }[] = [];
  private readonly cells = new Map<string, number[]>();
  /** How many deck vertices are shared by two or more ways (junctions on decks). */
  readonly count: number;

  constructor(pieces: { way: RoadWay; pts: V2[]; y: number[] }[]) {
    const at = new Map<string, Set<number>>();
    for (const pc of pieces) {
      for (let i = 0; i < pc.pts.length; i++) {
        const k = `${Math.round(pc.pts[i][0] * 2)},${Math.round(pc.pts[i][1] * 2)}`;
        const set = at.get(k);
        if (set) set.add(pc.way.id); else at.set(k, new Set([pc.way.id]));
        if (i + 1 >= pc.pts.length) continue;
        const a = pc.pts[i], b = pc.pts[i + 1], half = pc.way.width / 2;
        const j = this.segs.length;
        this.segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], ha: pc.y[i], hb: pc.y[i + 1], half, rank: deckRank(pc.way) });
        const r = half + REACH;
        for (let gx = Math.floor((Math.min(a[0], b[0]) - r) / 16); gx <= Math.floor((Math.max(a[0], b[0]) + r) / 16); gx++) {
          for (let gz = Math.floor((Math.min(a[1], b[1]) - r) / 16); gz <= Math.floor((Math.max(a[1], b[1]) + r) / 16); gz++) {
            const key = `${gx},${gz}`;
            const l = this.cells.get(key);
            if (l) l.push(j); else this.cells.set(key, [j]);
          }
        }
      }
    }
    let n = 0;
    for (const set of at.values()) if (set.size > 1) n++;
    this.count = n;
  }

  /** Whether a car deck's carriageway at about height `y` (within `tol`) covers (x, z). */
  covers(x: number, z: number, y: number, tol: number, strict = false): boolean {
    for (const j of this.cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const s = this.segs[j];
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const tr = l2 === 0 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      if (strict && (tr < -0.001 || tr > 1.001)) continue;
      const t = Math.max(0, Math.min(1, tr));
      if (Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) > s.half) continue;
      if (Math.abs(s.ha + (s.hb - s.ha) * t - y) < tol) return true;
    }
    return false;
  }

  /**
   * The height a deck vertex at (x, z) whose own height is `y` takes where decks overlap. A vertex of a lesser road (`rank`) that
   * lies on a greater one's carriageway takes that carriageway's height (a ramp or a side street joining a viaduct meets its
   * cross-section, as a minor road meets a major one, instead of standing on it at its own grade: half a metre proud 7 m in).
   */
  adjust(x: number, z: number, y: number, rank = Infinity): number {
    let sw = 0, sy = 0;
    let top = -Infinity, topH = 0;
    for (const j of this.cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const s = this.segs[j];
      if (s.rank <= rank || s.rank <= top) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      if (t < 0 || t > 1) continue;
      if (Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) > s.half) continue;
      const hy = s.ha + (s.hb - s.ha) * t;
      if (Math.abs(hy - y) > DOMINATE) continue;
      top = s.rank;
      topH = hy;
    }
    if (top > -Infinity) return topH;
    // (a lesser road beside does not bend a greater one: its vertices blend only with roads at least as great)
    for (const j of this.cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const s = this.segs[j];
      if (s.rank < rank && rank !== Infinity) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      const d = Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
      if (d > s.half + REACH) continue;
      const hy = s.ha + (s.hb - s.ha) * t;
      // a deck far above or below is another level (one passing over or under), not one to blend with
      if (Math.abs(hy - y) > 0.6) continue;
      const edge = Math.max(0, d - s.half) + 0.35;
      const w = 1 / (edge * edge * edge);
      sw += w;
      sy += w * hy;
    }
    return sw > 0 ? sy / sw : y;
  }
}

/**
 * A lesser car deck that joins a greater one (a ramp or a side street meeting a viaduct at a node in its middle, or at its end) is
 * drawn and made solid only up to `TRIM_IN` inside the greater one's kerb: its ribbon, flat across at its own grade, stood up to
 * half a metre proud of the greater carriageway where it lay over it (a step under the wheels of the traffic on the greater road).
 * The greater deck's surface is the junction there; the lesser one's end takes its height at the kerb (see `DeckBlend.adjust`).
 */
function trimDeckJoins(pieces: (Piece | null)[]): (Piece | null)[] {
  const segs: { ax: number; az: number; bx: number; bz: number; half: number; rank: number; ha: number; hb: number; k: number }[] = [];
  const cells = new Map<string, number[]>();
  pieces.forEach((c, k) => {
    if (!c || !c.deckY || c.way.kind !== 'car') return;
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const a = c.pts[i], b = c.pts[i + 1], half = c.way.width / 2;
      const j = segs.length;
      segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], half, rank: deckRank(c.way), ha: c.deckY[i], hb: c.deckY[i + 1], k });
      for (let gx = Math.floor((Math.min(a[0], b[0]) - half) / 16); gx <= Math.floor((Math.max(a[0], b[0]) + half) / 16); gx++) {
        for (let gz = Math.floor((Math.min(a[1], b[1]) - half) / 16); gz <= Math.floor((Math.max(a[1], b[1]) + half) / 16); gz++) {
          const key = `${gx},${gz}`;
          const l = cells.get(key);
          if (l) l.push(j); else cells.set(key, [j]);
        }
      }
    }
  });
  // inside a greater deck's carriageway (more than `inset` in from its kerb), at about its height
  const under = (x: number, z: number, y: number, rank: number, k: number, inset = TRIM_IN): boolean => {
    for (const j of cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const s = segs[j];
      if (s.k === k || s.rank <= rank) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      if (t < -0.02 || t > 1.02) continue;
      const tc = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (s.ax + tc * dx), z - (s.az + tc * dz)) > s.half - inset) continue;
      if (Math.abs(s.ha + (s.hb - s.ha) * tc - y) > DOMINATE) continue;
      return true;
    }
    return false;
  };
  return pieces.map((c, k) => {
    if (!c || !c.deckY || c.way.kind !== 'car' || c.pts.length < 2) return c;
    const rank = deckRank(c.way);
    const hw = c.way.width / 2;
    let pts = c.pts, ys = c.deckY;
    // the whole cross-section of the lesser deck there is on the greater one (its kerbs too, give or take): a T, not a fork,
    // where the lesser one's outer side is off the greater deck and must stay
    const covered = (x: number, z: number, y: number, ux: number, uz: number): boolean =>
      under(x, z, y, rank, k) && under(x - uz * hw, z + ux * hw, y, rank, k, -0.3) && under(x + uz * hw, z - ux * hw, y, rank, k, -0.3);
    for (const fromEnd of [false, true]) {
      if (fromEnd) { pts = [...pts].reverse(); ys = [...ys].reverse(); }
      {
        const l0 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) || 1;
        if (!covered(pts[0][0], pts[0][1], ys[0], (pts[1][0] - pts[0][0]) / l0, (pts[1][1] - pts[0][1]) / l0)) { if (fromEnd) { pts = [...pts].reverse(); ys = [...ys].reverse(); } continue; }
      }
      const total = polylineLength(pts);
      // walk in from the end in 0.25 m steps until out from under the greater deck
      let s = 0, i = 0, cut: { i: number; t: number } | null = null;
      while (i + 1 < pts.length && s < total * 0.6) {
        const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        let found = false;
        for (let d = 0; d < l; d += 0.25) {
          const t = l > 0 ? d / l : 0;
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          if (!covered(x, z, ys[i] + (ys[i + 1] - ys[i]) * t, (pts[i + 1][0] - pts[i][0]) / l, (pts[i + 1][1] - pts[i][1]) / l)) { cut = { i, t }; found = true; break; }
        }
        if (found) break;
        s += l;
        i++;
      }
      if (cut) {
        const a = pts[cut.i], b = pts[cut.i + 1];
        const p: V2 = [a[0] + (b[0] - a[0]) * cut.t, a[1] + (b[1] - a[1]) * cut.t];
        const y = ys[cut.i] + (ys[cut.i + 1] - ys[cut.i]) * cut.t;
        const rest = pts.slice(cut.i + 1), restY = ys.slice(cut.i + 1);
        if (Math.hypot(p[0] - rest[0][0], p[1] - rest[0][1]) > 0.01) { pts = [p, ...rest]; ys = [y, ...restY]; } else { pts = rest; ys = restY; }
      }
      if (fromEnd) { pts = [...pts].reverse(); ys = [...ys].reverse(); }
      if (pts.length < 2) return c;
    }
    return pts === c.pts ? c : { ...c, pts, deckY: ys, startJ: undefined, endJ: undefined };
  });
}
/** How far inside a greater deck's kerb a lesser deck that joins it stops (m): enough overlap for one welded surface. */
const TRIM_IN = 0.5;

/**
 * Every car road's centreline (roads.json, decks and ground alike, with the drawn surface's height), for the barriers: where a road
 * leaves a deck through its side, or a deck's end meets one, the barrier stays open.
 */
export class RoadCrossIndex {
  private readonly segs: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; half: number; id: string }[] = [];
  private readonly cells = new Map<string, number[]>();
  constructor(roads: RoadJson[], readonly bounds?: Rect) {
    for (const r of roads) {
      const P = r.points;
      for (let k = 0; k + 1 < P.length; k++) {
        const s = { ax: P[k][0], ay: P[k][1], az: P[k][2], bx: P[k + 1][0], by: P[k + 1][1], bz: P[k + 1][2], half: r.width / 2, id: r.id };
        const j = this.segs.length;
        this.segs.push(s);
        for (let gx = Math.floor((Math.min(s.ax, s.bx) - s.half) / 16); gx <= Math.floor((Math.max(s.ax, s.bx) + s.half) / 16); gx++) {
          for (let gz = Math.floor((Math.min(s.az, s.bz) - s.half) / 16); gz <= Math.floor((Math.max(s.az, s.bz) + s.half) / 16); gz++) {
            const key = `${gx},${gz}`;
            const l = this.cells.get(key);
            if (l) l.push(j); else this.cells.set(key, [j]);
          }
        }
      }
    }
  }
  private near(x0: number, z0: number, x1: number, z1: number): Set<number> {
    const out = new Set<number>();
    for (let gx = Math.floor(Math.min(x0, x1) / 16); gx <= Math.floor(Math.max(x0, x1) / 16); gx++) {
      for (let gz = Math.floor(Math.min(z0, z1) / 16); gz <= Math.floor(Math.max(z0, z1) / 16); gz++) for (const j of this.cells.get(`${gx},${gz}`) ?? []) out.add(j);
    }
    return out;
  }
  /** Whether another road's centreline crosses the segment a-b at about height `y` (within `tol`). */
  crosses(ax: number, az: number, bx: number, bz: number, y: number, tol: number, self: string): boolean {
    for (const j of this.near(ax, az, bx, bz)) {
      const s = this.segs[j];
      if (s.id === self) continue;
      const rx = bx - ax, rz = bz - az, qx = s.bx - s.ax, qz = s.bz - s.az;
      const den = rx * qz - rz * qx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s.ax - ax) * qz - (s.az - az) * qx) / den, u = ((s.ax - ax) * rz - (s.az - az) * rx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      if (Math.abs(s.ay + (s.by - s.ay) * u - y) < tol) return true;
    }
    return false;
  }
  /** Whether another road's carriageway (within `margin` beyond its kerbs) at about height `y` covers (x, z). */
  covers(x: number, z: number, y: number, tol: number, self: string, margin = 0, strict = false): boolean {
    for (const j of this.near(x, z, x, z)) {
      const s = this.segs[j];
      if (s.id === self) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const tr = l2 === 0 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      // (strict: beside the segment, not past its ends)
      if (strict && (tr < -0.001 || tr > 1.001)) continue;
      const t = Math.max(0, Math.min(1, tr));
      if (Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz)) > s.half + margin) continue;
      if (Math.abs(s.ay + (s.by - s.ay) * t - y) < tol) return true;
    }
    return false;
  }
}

/** A car deck's barrier: its height over the deck (m), its thickness (outside the carriageway's edge), how far out beside the edge
 * another deck or the ground has to be (and within how much of the deck's height) for the barrier to stop there. */
export const BARRIER = { height: 0.95, thickness: 0.3, probe: 0.6, farProbe: 1.8, sameLevel: 0.6, roadLevel: 1.0, atGrade: 0.6 } as const;

/**
 * Barriers along a car deck's two edges: a solid wall `BARRIER.height` tall and `BARRIER.thickness` thick, its inner face vertical at
 * the carriageway's edge (the deck is the carriageway and its shoulders: the barrier stands where the drivable surface ends),
 * drawn in concrete exactly as it is solid. Not where the deck carries on sideways into another car deck at its level (a fork, a
 * merge, a road joining it: `blend` knows the decks), nor where the ground beside the edge is within `BARRIER.atGrade` of the deck
 * (the ends where it lands, a deck at grade), so a car leaving the deck where it may goes on, and nowhere else does. A vertical
 * inner face with no slope at its foot: a car that hits it is stopped or turned along it, never lifted. Returns the metres built.
 */
function addBarriers(res: RoadMeshes, pts: V2[], left: V2[], right: V2[], lY: number[], rY: number[], colL: number[], colR: number[], ground: (x: number, z: number) => number, blend: DeckBlend | undefined, roads: RoadCrossIndex | undefined, self: string): number {
  const n = pts.length;
  let metres = 0;
  const cg = srgbToLinear(0.62);
  // where another road runs off the deck (its centreline through the edge, or its carriageway beside it at about the deck's level)
  const leaves = (ax: number, az: number, bx: number, bz: number, y: number) => !!roads && roads.crosses(ax, az, bx, bz, y, BARRIER.roadLevel, self);
  const beside = (x: number, z: number, y: number) => !!roads && roads.covers(x, z, y, BARRIER.roadLevel, self);
  for (const side of [0, 1] as const) {
    const edge = side === 0 ? left : right;
    const ys = side === 0 ? lY : rY;
    const cys = side === 0 ? colL : colR;
    // inward unit vector at each node (from the edge toward the centreline), and the probe beside the edge
    const inward: V2[] = edge.map((q, i) => { const dx = pts[i][0] - q[0], dz = pts[i][1] - q[1]; const l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; });
    const open = (i: number): boolean => {
      const q = edge[i], w = inward[i];
      const px = q[0] - w[0] * BARRIER.probe, pz = q[1] - w[1] * BARRIER.probe;
      if (ground(px, pz) > cys[i] - BARRIER.atGrade) return true;
      if (!!blend && blend.covers(px, pz, cys[i], BARRIER.sameLevel)) return true;
      // (and a little further out: a narrow road joining at an angle starts beyond the first probe)
      const fx = q[0] - w[0] * BARRIER.farProbe, fz = q[1] - w[1] * BARRIER.farProbe;
      return beside(px, pz, cys[i]) || beside(fx, fz, cys[i]);
    };
    const segOpen: boolean[] = [];
    for (let i = 0; i + 1 < n; i++) {
      const mx = (edge[i][0] + edge[i + 1][0]) / 2, mz = (edge[i][1] + edge[i + 1][1]) / 2;
      const w = inward[i];
      const midOpen = ground(mx - w[0] * BARRIER.probe, mz - w[1] * BARRIER.probe) > (cys[i] + cys[i + 1]) / 2 - BARRIER.atGrade || (!!blend && blend.covers(mx - w[0] * BARRIER.probe, mz - w[1] * BARRIER.probe, (cys[i] + cys[i + 1]) / 2, BARRIER.sameLevel));
      // a road's centreline through this stretch of edge, or through the strip the barrier stands on
      const through = leaves(edge[i][0], edge[i][1], edge[i + 1][0], edge[i + 1][1], (cys[i] + cys[i + 1]) / 2)
        || leaves(edge[i][0] - inward[i][0] * BARRIER.farProbe, edge[i][1] - inward[i][1] * BARRIER.farProbe, edge[i + 1][0] - inward[i + 1][0] * BARRIER.farProbe, edge[i + 1][1] - inward[i + 1][1] * BARRIER.farProbe, (cys[i] + cys[i + 1]) / 2);
      segOpen.push(open(i) || open(i + 1) || midOpen || through);
    }
    let i = 0;
    while (i < n - 1) {
      if (segOpen[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n - 1 && !segOpen[j + 1]) j++;
      // a run of barrier over nodes i..j+1, without the nodes it does not need (straight and level within 2 cm between the ones kept)
      const all: number[] = [];
      for (let k = i; k <= j + 1; k++) all.push(k);
      const ks: number[] = [all[0]];
      for (let a = 1; a < all.length - 1; a++) {
        const k0 = ks[ks.length - 1], k2 = all[a + 1];
        let fits = true;
        for (let b = all.indexOf(k0) + 1; b <= a && fits; b++) {
          const k = all[b];
          const dx = edge[k2][0] - edge[k0][0], dz = edge[k2][1] - edge[k0][1];
          const l2 = dx * dx + dz * dz || 1;
          const t = ((edge[k][0] - edge[k0][0]) * dx + (edge[k][1] - edge[k0][1]) * dz) / l2;
          const off = Math.hypot(edge[k][0] - edge[k0][0] - t * dx, edge[k][1] - edge[k0][1] - t * dz);
          const dy = Math.max(Math.abs(cys[k] - (cys[k0] + (cys[k2] - cys[k0]) * t)), Math.abs(ys[k] - (ys[k0] + (ys[k2] - ys[k0]) * t)));
          if (off > 0.02 || dy > 0.02) fits = false;
        }
        if (!fits) ks.push(all[a]);
      }
      ks.push(all[all.length - 1]);
      const inner = ks.map((k) => edge[k]);
      const outer = ks.map((k) => [edge[k][0] - inward[k][0] * BARRIER.thickness, edge[k][1] - inward[k][1] * BARRIER.thickness] as V2);
      for (let a = 0; a + 1 < ks.length; a++) metres += Math.hypot(outer[a + 1][0] - outer[a][0], outer[a + 1][1] - outer[a][1]);
      // drawn (per face, flat-shaded) and solid (one closed strip): the same corners
      wallStrip(res.concrete, inner, outer, ks.map((k) => ys[k]), BARRIER.height, [cg, cg, cg]);
      wallStrip(res.collision, inner, outer, ks.map((k) => cys[k]), BARRIER.height, null);
      res.barriers.push(ks.flatMap((k, a) => [Math.round(inner[a][0] * 100) / 100, Math.round(cys[k] * 100) / 100, Math.round(inner[a][1] * 100) / 100]));
      i = j + 1;
    }
  }
  // An end that leads nowhere (no road goes on from it at its height, and it is not on the ground: a ramp mapped to stop short, a
  // service road that runs into a garage the data does not have) is closed across: a wall, not a drop.
  for (const i of [0, n - 1]) {
    const y = (colL[i] + colR[i]) / 2;
    if (Math.abs(ground(pts[i][0], pts[i][1]) - y) < BARRIER.atGrade) continue;
    // (an end on the tile's edge goes on in the next tile)
    const bb = roads?.bounds;
    if (bb && (pts[i][0] - bb.minX < 0.5 || bb.maxX - pts[i][0] < 0.5 || pts[i][1] - bb.minZ < 0.5 || bb.maxZ - pts[i][1] < 0.5)) continue;
    const kk = i === 0 ? 1 : n - 2;
    const dx = pts[i][0] - pts[kk][0], dz = pts[i][1] - pts[kk][1], l = Math.hypot(dx, dz) || 1;
    const ox = pts[i][0] + (dx / l) * 1.0, oz = pts[i][1] + (dz / l) * 1.0;
    // (any road, this way's own on the ground beyond a deck the pipeline made too, beside the point a metre past the end)
    if ((roads && roads.covers(ox, oz, y, BARRIER.roadLevel, '', 0, true)) || (blend && blend.covers(ox, oz, y, BARRIER.sameLevel, true))) continue;
    const inner: V2[] = [left[i], right[i]];
    const outer: V2[] = [[left[i][0] + (dx / l) * BARRIER.thickness, left[i][1] + (dz / l) * BARRIER.thickness], [right[i][0] + (dx / l) * BARRIER.thickness, right[i][1] + (dz / l) * BARRIER.thickness]];
    wallStrip(res.concrete, inner, outer, [lY[i], rY[i]], BARRIER.height, [cg, cg, cg]);
    wallStrip(res.collision, inner, outer, [colL[i], colR[i]], BARRIER.height, null);
    res.barriers.push([inner[0][0], colL[i], inner[0][1], inner[1][0], colR[i], inner[1][1]].map((v) => Math.round(v * 100) / 100));
    res.stats.closedDeckEnds = (res.stats.closedDeckEnds ?? 0) + 1;
    metres += Math.hypot(right[i][0] - left[i][0], right[i][1] - left[i][1]);
  }
  return metres;
}

/**
 * A wall along a path: inner face, top and outer face over the polyline pairs `inner`/`outer`, standing on `base` and `h` tall,
 * with end faces, every face wound to face out of the wall; drawn with `colour` and its normals, or solid (no colour).
 */
function wallStrip(mb: MeshBuilder, inner: V2[], outer: V2[], base: number[], h: number, colour: [number, number, number] | null) {
  const m = inner.length;
  const quad = (a: V3, b: V3, c: V3, d: V3, out: V3) => {
    // a b c d around the quad; wind so the normal points along `out`
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    const nn: V3 = [out[0] / l, out[1] / l, out[2] / l];
    const vs = [a, b, c, d].map((p) => (colour ? mb.vertex(p[0], p[1], p[2], nn[0], nn[1], nn[2], colour[0], colour[1], colour[2]) : mb.vertex(p[0], p[1], p[2], 0, 1, 0)));
    if (flip) mb.indices.push(vs[0], vs[2], vs[1], vs[0], vs[3], vs[2]);
    else mb.indices.push(vs[0], vs[1], vs[2], vs[0], vs[2], vs[3]);
  };
  for (let k = 0; k + 1 < m; k++) {
    const iB0: V3 = [inner[k][0], base[k], inner[k][1]], iB1: V3 = [inner[k + 1][0], base[k + 1], inner[k + 1][1]];
    const iT0: V3 = [inner[k][0], base[k] + h, inner[k][1]], iT1: V3 = [inner[k + 1][0], base[k + 1] + h, inner[k + 1][1]];
    const oT0: V3 = [outer[k][0], base[k] + h, outer[k][1]], oT1: V3 = [outer[k + 1][0], base[k + 1] + h, outer[k + 1][1]];
    const oB0: V3 = [outer[k][0], base[k] - 0.3, outer[k][1]], oB1: V3 = [outer[k + 1][0], base[k + 1] - 0.3, outer[k + 1][1]];
    const inw: V3 = [inner[k][0] - outer[k][0], 0, inner[k][1] - outer[k][1]];
    quad(iB0, iB1, iT1, iT0, inw);
    quad(iT0, iT1, oT1, oT0, [0, 1, 0]);
    quad(oT0, oT1, oB1, oB0, [-inw[0], 0, -inw[2]]);
  }
  // the two ends
  for (const k of [0, m - 1]) {
    const kk = k === 0 ? 1 : m - 2;
    const iB: V3 = [inner[k][0], base[k], inner[k][1]], iT: V3 = [inner[k][0], base[k] + h, inner[k][1]];
    const oT: V3 = [outer[k][0], base[k] + h, outer[k][1]], oB: V3 = [outer[k][0], base[k] - 0.3, outer[k][1]];
    quad(iB, iT, oT, oB, [inner[k][0] - inner[kk][0], 0, inner[k][1] - inner[kk][1]]);
  }
}

/** Decks within this of a deck vertex (m beyond their carriageway's edge) blend into its height. */
const REACH = 2;
/** A lesser deck's vertex on a greater deck's carriageway and within this of its height (m) takes that height (see `adjust`). */
const DOMINATE = 1.5;
/** Which of two decks is the greater road: the higher class, then the wider. */
function deckRank(w: RoadWay): number {
  return rankOf(w.highway) * 100 + w.width;
}

/** The end of a car deck piece: its centre, its two corners, the drawn top and the collision top there. */
export interface DeckEnd { x: number; z: number; l: V2; r: V2; y: number; cy: number; gray: number; way: RoadWay; drop: number; blend?: DeckBlend }

/**
 * Where two car deck pieces meet (the ends of two bridge ways at a shared node, a bridge the pipeline made against a mapped one),
 * their ribbons end square to their own directions, so at an angle there is a wedge-shaped gap on the outside of the bend (a
 * 7-lane motorway bending 10 degrees leaves a 2 m hole under its outer lane). Each such joint gets a cap: the convex hull of the
 * ends' corners, at their height, drawn (asphalt over a concrete underside) and solid (a slab like the decks'). Returns how many.
 */
export function addDeckCaps(res: RoadMeshes, ends: DeckEnd[], thickness: number, weld?: WeldPolygon[]): number {
  const used = new Uint8Array(ends.length);
  let caps = 0;
  for (let i = 0; i < ends.length; i++) {
    if (used[i]) continue;
    const group = [i];
    for (let j = i + 1; j < ends.length; j++) if (!used[j] && Math.hypot(ends[j].x - ends[i].x, ends[j].z - ends[i].z) < 0.6) group.push(j);
    if (group.length < 2) continue;
    for (const k of group) used[k] = 1;
    const pts: V2[] = [];
    for (const k of group) pts.push(ends[k].l, ends[k].r, [ends[k].x, ends[k].z]);
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    const cys = group.map((k) => ends[k].cy);
    const cy = cys.reduce((a, b) => a + b, 0) / cys.length;
    const drop = Math.min(...group.map((k) => ends[k].drop));
    const pl = ends[group[0]].blend;
    // each corner at the blended deck height there (as the ribbons are), else at the ends' mean height
    const at = (q: V2) => (pl ? pl.adjust(q[0], q[1], cy) : cy);
    const g = ends[group[0]].gray;
    // drawn: the top over the asphalt (a hair under the ribbons, so they win where they overlap), the underside in concrete
    const top = res.asphalt.vertexCount;
    for (const q of hull) res.asphalt.vertex(q[0], at(q) + drop - 0.005, q[1], 0, 1, 0, g, g, g * 1.02);
    for (let k = 1; k + 1 < hull.length; k++) res.asphalt.indices.push(top, top + k + 1, top + k);
    const cg = srgbToLinear(0.55);
    const und = res.concrete.vertexCount;
    for (const q of hull) res.concrete.vertex(q[0], at(q) + drop - thickness, q[1], 0, -1, 0, cg, cg, cg);
    for (let k = 1; k + 1 < hull.length; k++) res.concrete.indices.push(und, und + k, und + k + 1);
    // solid: welded into the level's surface (deckWeld.ts), or a slab at the collision top
    if (weld) { weld.push({ ring: hull, heights: hull.map(at) }); caps++; continue; }
    const cb = res.collision.vertexCount;
    for (const q of hull) res.collision.vertex(q[0], at(q), q[1], 0, 1, 0);
    for (const q of hull) res.collision.vertex(q[0], at(q) - thickness, q[1], 0, 1, 0);
    const m = hull.length;
    for (let k = 1; k + 1 < m; k++) {
      res.collision.indices.push(cb, cb + k + 1, cb + k);
      res.collision.indices.push(cb + m, cb + m + k, cb + m + k + 1);
    }
    caps++;
  }
  return caps;
}

/** Convex hull of points in (x, z), counter-clockwise seen from above (+y), without collinear points. */
function convexHull(pts: V2[]): V2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop(); lower.push(q); }
  const upper: V2[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function overRoad(p: V2, below: { w: RoadWay; pts: V2[] }[], extent = 0): boolean {
  for (const b of below) {
    const reach = b.w.width / 2 + 1.5 + extent;
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
