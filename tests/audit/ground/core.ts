/**
 * The ground audit: is the drivable world solid and smooth, and does any road run into a building?
 *
 * Three parts, all headless on a baked tile:
 *
 *   1. `driveLanes`: a physics car (the real `RaycastCar` in the real `PhysicsWorld`) driven by the traffic AI's pure pursuit
 *      and speed governor along every edge of `lanes.json`, at a target speed (15, 25, 35 m/s; less where the lane's curves
 *      do not allow it). Every tick it looks for a vertical launch (all four wheels off the road, an upward velocity spike, a
 *      pitch or roll kick), a hard vertical jolt, and any touch of the car's hull on static collision, and says why.
 *   2. `scanSurfaces`: the surface the wheels see, sampled along every lane (centre and both wheel tracks): steps, crests
 *      sharp enough to throw a car at speed, and places where the drawn road and the physics disagree.
 *   3. `scanBuildings`: every lane, connector and road centreline tested against the building footprints.
 *
 * Pure: no files and no vitest in here (`run.ts` writes the report and the heat map, `tests/ground.test.ts` runs a sample).
 * docs/ground-audit.md has the thresholds and the categories.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { FootprintIndex } from '../../../src/shared/footprints';
import { HANDLING } from '../../../src/shared/handling';
import type { LaneEdgeAny } from '../../../src/shared/lanes';
import { rotateVec } from '../../../src/shared/math';
import { SIM_DT } from '../../../src/shared/protocol';
import { worldSolids } from '../../../src/shared/props';
import { heightAt, type TileData } from '../../../src/shared/tile';
import { GROUPS, type Rapier } from '../../../src/sim/physics/rapier';
import { PathFollower, governSpeed, pedalsFor, pursuitAngle, steerCommand, type GovernorOptions } from '../../../src/sim/police/pursuit';
import { steerLock } from '../../../src/sim/vehicles/dynamics';
import { RaycastCar } from '../../../src/sim/vehicles/RaycastCar';
import { PhysicsWorld } from '../../../src/sim/World';

/** What the thresholds are (see the doc). */
export const THRESHOLDS = {
  /** Ticks with all four wheels off the road before it counts as a launch. */
  airTicks: 4,
  /** Upward speed above what the road's grade explains, m/s. */
  launchVy: 1.0,
  /** Vertical acceleration of the body in one tick (beyond gravity), m/s^2: a jolt. */
  joltAccel: 18,
  /** Change of the pitch or roll rate in one tick, rad/s. */
  kick: 0.6,
  /** A step in the surface between two samples 0.25 m apart beyond the grade, m. */
  step: 0.04,
  /** The drawn road and the physics surface disagree by more than this, m. */
  mismatch: 0.2,
  /** Seconds after a spawn in which nothing is recorded (the suspension settles). */
  settle: 0.6,
} as const;

export type EventKind = 'air' | 'launch' | 'jolt' | 'kick' | 'contact' | 'abort' | 'step' | 'crest' | 'mismatch' | 'building' | 'prop';

export interface GroundEvent {
  kind: EventKind;
  /** The categorised cause (see `diagnose`). */
  cause: string;
  x: number;
  y: number;
  z: number;
  /** Target speed of the run (0 for the static scans), and the car's speed at the event. */
  speed: number;
  v: number;
  /** The lane graph edge, its road, and its class. */
  edge: number;
  road: string;
  cls: string;
  /** How bad: ticks in the air, m/s, m/s^2, rad/s, m (by kind). */
  value: number;
  detail?: string;
  /** For a launch or an airborne episode with `trace` on: the ticks before it (see `TickTrace`). */
  trace?: TickTrace[];
  /** For a launch or an airborne episode: what made it and what the ground was like (see `classifyLaunch`). */
  origin?: string;
  ground?: LaunchClass['ground'];
}

/** One wheel in one tick, for the launch traces. */
export interface WheelTrace {
  /** grounded; what it hit (kind, Rapier feature type and id); ray hit distance, m; the hit normal's y; suspension length, m */
  g: 0 | 1;
  kind: SurfaceKind;
  fty: number;
  fid: number;
  hit: number;
  ny: number;
  nx: number;
  nz: number;
  /** the height of the ray's contact, m */
  cy: number;
  len: number;
  /** compression rate, m/s; spring and damper accel before the anti-roll bars and after, m/s^2; the tyre's vertical impulse as dv, m/s */
  rate: number;
  spring: number;
  acc: number;
  tireDv: number;
}

/** One tick of a car, for the launch traces: where it was, its vertical velocity budget, and what the solver did to the hull. */
export interface TickTrace {
  tick: number;
  x: number;
  y: number;
  z: number;
  vH: number;
  vy: number;
  /** the road's vertical speed from the lane's grade, m/s */
  vyRoad: number;
  /** the tick's vertical dv, and the shares of it: the springs, the tyres, gravity and the rest (the solver: the hull) */
  dv: number;
  dvSpring: number;
  dvTire: number;
  dvSolver: number;
  pitchRate: number;
  rollRate: number;
  /** the car's crash guard was on for the step (soft CCD and the crash restitution) */
  guarded: boolean;
  wheels: WheelTrace[];
  /** What the static world pushed the hull with in the step (Rapier's contact force events): the kind and the impulse as dv, m/s. */
  pushes: { k: SurfaceKind; dv: number[] }[];
  /** The hull's true distance before the step to the ground and to the decks (plain copies, exact query; 9 when over 0.5 m). */
  clearGround: number;
  clearDeck: number;
  /** The hull's nearest static contacts after the step (what the next step's solver works with): kind, collision triangle, distance, normal (pushing the hull), point. */
  contacts: { k: SurfaceKind; tri: number; d: number; n: number[]; p: number[] }[];
}

export interface DriveStats {
  speed: number;
  edges: number;
  covered: number;
  routes: number;
  aborted: number;
  metres: number;
  ticks: number;
  /** Highest speed reached, and the mean over the measured ticks. */
  vMax: number;
  vMean: number;
  ms: number;
}

/** Collider kinds as the audit names them. */
export type SurfaceKind = 'none' | 'ground' | 'deck' | 'pier' | 'building' | 'prop' | 'vehicle';

/** The world a tile makes, plus what the audit needs to name what it touches. */
export class GroundWorld {
  readonly physics: PhysicsWorld;
  readonly world: RAPIER.World;
  readonly trimesh: RAPIER.Collider | null;
  readonly footprints: FootprintIndex;
  readonly buildingTris: number;
  /** Per collision triangle: 0 building, 1 deck top, 2 deck side or edge, 3 deck underside, 4 pier. */
  readonly triKind: Uint8Array;
  private readonly ray: RAPIER.Ray;
  /** Each trimesh collider's first triangle in `collisionIndices`, by handle. */
  private readonly meshFirst = new Map<number, number>();
  /** The collision triangles by 4 m cell (a ray hit on the trimesh does not say which triangle it hit). */
  private readonly triCells = new Map<number, number[]>();

  constructor(
    readonly R: Rapier,
    readonly tile: TileData,
    opts: { fixInternalEdges?: boolean } = {},
  ) {
    this.physics = new PhysicsWorld(R, tile, opts);
    this.world = this.physics.world;
    // the plain decks (what the rays and the wheels see), and every trimesh collider by handle with its first triangle
    this.trimesh = this.physics.staticMeshes.find((m) => m.firstTriangle > 0 || this.physics.staticMeshes.length === 1)?.collider ?? null;
    for (const m of this.physics.staticMeshes) this.meshFirst.set(m.collider.handle, m.firstTriangle);
    this.buildingTris = tile.manifest.collision.buildingTriangles ?? 0;
    this.footprints = this.physics.footprints;
    const P = tile.collisionPositions;
    const I = tile.collisionIndices;
    const n = I.length / 3;
    this.triKind = new Uint8Array(n);
    for (let t = this.buildingTris; t < n; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      const up = ny / l;
      const span = Math.max(P[a + 1], P[b + 1], P[c + 1]) - Math.min(P[a + 1], P[b + 1], P[c + 1]);
      this.triKind[t] = up > 0.6 ? 1 : up < -0.6 ? 3 : span > 1.2 ? 4 : 2;
    }
    for (let t = 0; t < n; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const x0 = Math.floor(Math.min(P[a], P[b], P[c]) / 4), x1 = Math.floor(Math.max(P[a], P[b], P[c]) / 4);
      const z0 = Math.floor(Math.min(P[a + 2], P[b + 2], P[c + 2]) / 4), z1 = Math.floor(Math.max(P[a + 2], P[b + 2], P[c + 2]) / 4);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) continue;
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = cx * 100003 + cz;
        const l = this.triCells.get(k);
        if (l) l.push(t); else this.triCells.set(k, [t]);
      }
    }
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  /** A trimesh collider's own triangle as a triangle of the whole collision mesh (-1 for anything else). */
  globalTri(c: RAPIER.Collider, sub: number): number {
    const first = this.meshFirst.get(c.handle);
    return first === undefined || sub < 0 ? -1 : sub + first;
  }

  /** What a collider is; `sub` is the triangle of a trimesh collider's own (from a contact manifold), or -1. */
  kindOf(c: RAPIER.Collider, sub = -1): SurfaceKind {
    if (c.shape.type === this.R.ShapeType.HeightField) return 'ground';
    const first = this.meshFirst.get(c.handle);
    if (first !== undefined) {
      if (sub < 0) return first < this.buildingTris ? 'building' : 'deck';
      const t = sub + first;
      if (t < this.buildingTris) return 'building';
      return this.triKind[t] === 4 ? 'pier' : 'deck';
    }
    const b = c.parent();
    if (b && b.isDynamic()) return 'vehicle';
    return 'prop';
  }

  /**
   * The top surface under (x, z), cast down from `fromY` with the filter the wheels use (`groups`), and what it is.
   * `sub` is the collision triangle (for the trimesh) or -1.
   */
  surface(x: number, fromY: number, z: number, maxDrop = 6, groups: number = GROUPS.actorQuery, exclude?: RAPIER.RigidBody): { y: number; kind: SurfaceKind; sub: number; ny: number; n: { x: number; y: number; z: number } } {
    const r = this.ray;
    r.origin.x = x; r.origin.y = fromY; r.origin.z = z;
    r.dir.x = 0; r.dir.y = -1; r.dir.z = 0;
    const hit = this.world.castRayAndGetNormal(r, maxDrop, true, undefined, groups, undefined, exclude);
    if (!hit) return { y: NaN, kind: 'none', sub: -1, ny: 1, n: { x: 0, y: 1, z: 0 } };
    const c = hit.collider;
    const y = fromY - hit.timeOfImpact;
    let sub = -1;
    const first = this.meshFirst.get(c.handle);
    if (first !== undefined) sub = this.triangleAt(x, y, z);
    // (`sub` is a triangle of the whole collision mesh here; kindOf wants the collider's own)
    return { y, kind: sub >= 0 ? this.kindOf(c, sub - (first ?? 0)) : this.kindOf(c), sub, ny: hit.normal.y, n: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } };
  }

  /** The top of the trimesh (a deck) under (x, z), cast down from `fromY` over `maxDrop`, or NaN. */
  deckTop(x: number, fromY: number, z: number, maxDrop: number): number {
    if (!this.trimesh) return NaN;
    const r = this.ray;
    r.origin.x = x; r.origin.y = fromY; r.origin.z = z;
    r.dir.x = 0; r.dir.y = -1; r.dir.z = 0;
    const toi = this.trimesh.castRay(r, maxDrop, true);
    return toi < 0 ? NaN : fromY - toi;
  }

  /** The collision triangle whose surface passes through (x, y, z) (within 5 cm), or -1: the one with the highest top. */
  triangleAt(x: number, y: number, z: number): number {
    const list = this.triCells.get(Math.floor(x / 4) * 100003 + Math.floor(z / 4));
    if (!list) return -1;
    const P = this.tile.collisionPositions, I = this.tile.collisionIndices;
    let best = -1, bd = 0.05;
    for (const t of list) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const d = (P[b] - P[a]) * (P[c + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[c] - P[a]);
      if (Math.abs(d) < 1e-9) continue;
      const w1 = ((x - P[a]) * (P[c + 2] - P[a + 2]) - (z - P[a + 2]) * (P[c] - P[a])) / d;
      const w2 = ((P[b] - P[a]) * (z - P[a + 2]) - (P[b + 2] - P[a + 2]) * (x - P[a])) / d;
      if (w1 < -1e-4 || w2 < -1e-4 || w1 + w2 > 1 + 1e-4) continue;
      const ty = P[a + 1] + (P[b + 1] - P[a + 1]) * w1 + (P[c + 1] - P[a + 1]) * w2;
      const e = Math.abs(ty - y);
      if (e < bd) { bd = e; best = t; }
    }
    return best;
  }
}

/** The lane graph as the audit walks it. */
export class Graph {
  readonly edges: LaneEdgeAny[];
  readonly prev: number[][];
  readonly mid: { x: number; z: number }[];

  constructor(readonly tile: TileData) {
    const e = tile.lanes?.edges ?? [];
    this.edges = e;
    this.prev = e.map(() => []);
    e.forEach((ed, i) => { for (const n of ed.next) if (n >= 0 && n < e.length) this.prev[n].push(i); });
    this.mid = e.map((ed) => {
      const k = Math.floor(ed.pts.length / 6) * 3;
      return { x: ed.pts[k], z: ed.pts[k + 2] };
    });
  }

  roadOf(i: number): string {
    const e = this.edges[i];
    if (e.t === 0) return e.road;
    return (this.edges[e.from] as { road?: string }).road ?? '';
  }

  clsOf(i: number): string {
    const e = this.edges[i];
    if (e.t === 0) return e.cls;
    return `connector-${e.turn}`;
  }

  /** The start and end heading of an edge (radians, the car's convention: facing (sin, cos)). */
  heading(i: number, end: boolean): number {
    const p = this.edges[i].pts;
    const n = p.length / 3;
    const a = end ? Math.max(0, n - 2) : 0;
    const b = end ? n - 1 : Math.min(1, n - 1);
    return Math.atan2(p[b * 3] - p[a * 3], p[b * 3 + 2] - p[a * 3 + 2]);
  }
}

const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

interface RoutePoint { x: number; y: number; z: number; edge: number; measure: boolean }

/**
 * Plans a route that covers `targets`: from an unvisited target with a run-up before it (the straightest way in), on through
 * the graph preferring unvisited targets, and through other edges (driven, not measured) to the nearest one left within 500 m.
 */
function planRoute(g: Graph, start: number, targets: Set<number>, visited: Set<number>, runUp: number, maxLen = 2500): RoutePoint[] {
  const E = g.edges;
  // run-up: back along the straightest predecessors
  const before: number[] = [];
  let len = 0;
  let cur = start;
  while (len < runUp) {
    const ps = g.prev[cur];
    if (!ps.length) break;
    const h = g.heading(cur, false);
    let best = -1, bd = Infinity;
    for (const p of ps) {
      if (before.includes(p) || p === start) continue;
      const d = angDiff(g.heading(p, true), h);
      if (d < bd) { bd = d; best = p; }
    }
    if (best < 0) break;
    before.unshift(best);
    len += E[best].len;
    cur = best;
  }
  const seq: { edge: number; measure: boolean }[] = before.map((edge) => ({ edge, measure: false }));
  let total = 0;
  cur = start;
  const used = new Set<number>(before);
  for (;;) {
    const m = targets.has(cur) && !visited.has(cur);
    seq.push({ edge: cur, measure: m });
    used.add(cur);
    if (m) visited.add(cur);
    total += E[cur].len;
    if (total > maxLen) break;
    const nx = E[cur].next.filter((n) => n >= 0 && n < E.length);
    if (!nx.length) break;
    const h = g.heading(cur, true);
    const fresh = nx.filter((n) => targets.has(n) && !visited.has(n));
    if (fresh.length) {
      // the straightest unvisited way on
      fresh.sort((a, b) => angDiff(g.heading(a, false), h) - angDiff(g.heading(b, false), h));
      cur = fresh[0];
      continue;
    }
    // breadth-first to the nearest unvisited target within 500 m
    const from = new Map<number, number>();
    const dist = new Map<number, number>();
    const q: number[] = [];
    for (const n of nx) if (!from.has(n)) { from.set(n, -1); dist.set(n, E[n].len); q.push(n); }
    let found = -1;
    for (let qi = 0; qi < q.length && found < 0; qi++) {
      const k = q[qi];
      if (targets.has(k) && !visited.has(k)) { found = k; break; }
      const dk = dist.get(k)!;
      if (dk > 500) continue;
      for (const n of E[k].next) {
        if (n < 0 || n >= E.length || from.has(n)) continue;
        from.set(n, k);
        dist.set(n, dk + E[n].len);
        q.push(n);
      }
    }
    if (found < 0) break;
    const chain: number[] = [];
    for (let k = found; k !== -1; k = from.get(k)!) chain.unshift(k);
    // drive the chain up to (not including) the target, then loop round to measure it
    for (const k of chain.slice(0, -1)) {
      seq.push({ edge: k, measure: false });
      total += E[k].len;
    }
    cur = found;
  }
  const out: RoutePoint[] = [];
  for (const s of seq) {
    const p = E[s.edge].pts;
    for (let i = 0; i < p.length; i += 3) {
      const l = out[out.length - 1];
      if (l && Math.hypot(l.x - p[i], l.z - p[i + 2]) < 0.05) { l.edge = s.edge; l.measure = s.measure; continue; }
      out.push({ x: p[i], y: p[i + 1], z: p[i + 2], edge: s.edge, measure: s.measure });
    }
  }
  return out;
}

/** Resamples a route to about 1 m (the governor and the follower want even points). */
function resample(pts: RoutePoint[], step = 1): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      // a point between two edges belongs to the one it leads into
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, edge: b.edge, measure: b.measure });
    }
  }
  if (pts.length) out.push({ ...pts[pts.length - 1] });
  return out;
}

export interface DriveOptions {
  speed: number;
  /** The edges to measure (default every edge). */
  targets?: Iterable<number>;
  vehicle?: string;
  /** Lateral acceleration the governor plans corners for, m/s^2 (the traffic AI's is 4.2). */
  lateral?: number;
  log?: (m: string) => void;
  /** Stop after this many routes (for a quick sample). */
  maxRoutes?: number;
  /** Attach the last ticks' `TickTrace` to every launch and airborne episode (`--trace`). */
  trace?: boolean;
  /** A hook before and after each world step (for probing one spot by hand). */
  onTick?: (phase: 'pre' | 'post', tick: number, car: RaycastCar, hulls: RAPIER.Collider[]) => void;
  /** Keep every car's crash guard on (`--no-guard`: the physics before round four). */
  noGuard?: boolean;
  /** Steps the world instead of `world.step()` (for probing). */
  step?: () => void;
}

/** Ticks of trace kept before a launch. */
const TRACE_TICKS = 45;

/** The hull's nearest contacts with static colliders after a step, with their normals (pushing the hull) and points. */
function hullContacts(gw: GroundWorld, hulls: RAPIER.Collider[], body: RAPIER.RigidBody, max = 4): TickTrace['contacts'] {
  const out: TickTrace['contacts'] = [];
  const world = gw.world;
  const c = body.translation();
  for (const hc of hulls) {
    world.contactPairsWith(hc, (other) => {
      const ob = other.parent();
      if (ob && ob.isDynamic()) return;
      world.contactPair(hc, other, (m, flipped) => {
        if (!m.numContacts()) return;
        let bi = 0;
        for (let i = 1; i < m.numContacts(); i++) if (m.contactDist(i) < m.contactDist(bi)) bi = i;
        const lp = flipped ? m.localContactPoint1(bi) : m.localContactPoint2(bi);
        if (!lp) return;
        const ot = other.translation(), oq = other.rotation();
        const wp = rotateVec(oq, lp.x, lp.y, lp.z);
        const p = [wp.x + ot.x, wp.y + ot.y, wp.z + ot.z];
        const nw = m.normal();
        // the push on the hull points from the static surface toward the body
        const sgn = (c.x - p[0]) * nw.x + (c.y - p[1]) * nw.y + (c.z - p[2]) * nw.z >= 0 ? 1 : -1;
        const local = flipped ? m.subshape1() : m.subshape2();
        out.push({ k: gw.kindOf(other, local), tri: gw.globalTri(other, local), d: r3(m.contactDist(bi)), n: [r3(nw.x * sgn), r3(nw.y * sgn), r3(nw.z * sgn)], p: p.map(r3) });
      });
    });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, max);
}


/** What a wheel stood on in a tick: the kind, the height, and at a change of kind the step between the two surfaces there. */
interface WheelLog { kind: SurfaceKind; y: number; step?: number }

/**
 * Vertical speed (m/s) the body gained in a tick beyond what its wheels and gravity explain, above which something else pushed
 * it: the hull on static collision.
 */
const PUSH_DV = 0.3;

/** What pushed the hull in a tick, and whether the push was real (the hull was down at what it hit) or a ghost. */
interface HullPush { kind: SurfaceKind; tri: number; ghost: boolean; clearance: number; dv: number }

/** The hull's static contacts this tick (the narrow phase's manifolds, speculative ones too), nearest first, as kind and triangle. */
function hullTouches(gw: GroundWorld, hulls: RAPIER.Collider[]): { kind: SurfaceKind; tri: number; ny: number; dist: number }[] {
  const out: { kind: SurfaceKind; tri: number; ny: number; dist: number }[] = [];
  const world = gw.world;
  for (const hc of hulls) {
    world.contactPairsWith(hc, (other) => {
      const ob = other.parent();
      if (ob && ob.isDynamic()) return;
      world.contactPair(hc, other, (m, flipped) => {
        let d = Infinity;
        for (let i = 0; i < m.numContacts(); i++) d = Math.min(d, m.contactDist(i));
        if (d === Infinity) return;
        const local = flipped ? m.subshape1() : m.subshape2();
        out.push({ kind: gw.kindOf(other, local), tri: gw.globalTri(other, local), ny: Math.abs(m.normal().y), dist: d });
      });
    });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/**
 * The lowest the hull is over the surface under it, m (the real clearance of the belly and bumpers): every vertex, and a grid over
 * the floor (the vertices within 6 cm of the lowest), so a crest under the middle of the floor is seen.
 */
function hullClearance(gw: GroundWorld, hulls: RAPIER.Collider[], body: RAPIER.RigidBody): number {
  let best = Infinity;
  const at = (x: number, y: number, z: number) => {
    const s = gw.surface(x, y + 0.6, z, 2.5, GROUPS.cameraQuery, body);
    if (!Number.isNaN(s.y)) best = Math.min(best, y - s.y);
  };
  for (const hc of hulls) {
    const v = (hc.shape as unknown as { vertices?: Float32Array }).vertices;
    if (!v) continue;
    const q = hc.rotation();
    const t = hc.translation();
    let minY = Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i + 2 < v.length; i += 3) minY = Math.min(minY, v[i + 1]);
    for (let i = 0; i + 2 < v.length; i += 3) {
      const p = rotateVec(q, v[i], v[i + 1], v[i + 2]);
      at(t.x + p.x, t.y + p.y, t.z + p.z);
      if (v[i + 1] < minY + 0.06) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]); }
    }
    if (x0 > x1) continue;
    for (let a = 0; a <= 4; a++) {
      for (let b = 0; b <= 8; b++) {
        const p = rotateVec(q, x0 + ((x1 - x0) * a) / 4, minY, z0 + ((z1 - z0) * b) / 8);
        at(t.x + p.x, t.y + p.y, t.z + p.z);
      }
    }
  }
  return best;
}

/**
 * Drives the edges in `targets` at a target speed and returns what happened. One car at a time, in the tile's world.
 */
export function driveLanes(gw: GroundWorld, g: Graph, o: DriveOptions): { events: GroundEvent[]; stats: DriveStats } {
  const t0 = performance.now();
  const R = gw.R;
  const world = gw.world;
  const h = HANDLING[o.vehicle ?? 'sedan'];
  const wheelbase = h.wheels.frontZ - h.wheels.rearZ;
  const rest = RaycastCar.restHeight(h);
  const targets = new Set(o.targets ?? g.edges.map((_, i) => i));
  const visited = new Set<number>();
  const events: GroundEvent[] = [];
  const gov: GovernorOptions = { cruise: o.speed, lateral: o.lateral ?? 5, brake: 5.5, minCorner: 3.5, stopAtEnd: true, horizon: 140 };
  const stats: DriveStats = { speed: o.speed, edges: targets.size, covered: 0, routes: 0, aborted: 0, metres: 0, ticks: 0, vMax: 0, vMean: 0, ms: 0 };
  let vSum = 0, vTicks = 0;
  const order = [...targets].sort((a, b) => a - b);
  let oi = 0;
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const ped = { throttle: 0, brake: 0 };
  const coveredEdges = new Set<number>();
  const dbg = globalThis as { __DBG?: boolean; __DBGN?: number };
  const traceQueue = new R.EventQueue(true);
  const bounds = gw.tile.manifest.bounds;

  // an edge a route meant to measure but never reached (the car gave up before it) is tried again, twice at most
  const tries = new Map<number, number>();
  const retry: number[] = [];
  for (;;) {
    if (o.maxRoutes !== undefined && stats.routes >= o.maxRoutes) break;
    while (oi < order.length && visited.has(order[oi])) oi++;
    while (oi >= order.length && retry.length && visited.has(retry[0])) retry.shift();
    const start = oi < order.length ? order[oi] : retry.shift();
    if (start === undefined) break;
    const before = new Set(visited);
    const route = resample(planRoute(g, start, targets, visited, Math.max(30, o.speed * 2.2)));
    const planned = [...visited].filter((e) => !before.has(e));
    if (route.length < 3) { visited.add(start); continue; }
    stats.routes++;
    const f = new PathFollower(route);
    // spawn on the surface at the route's start, facing along it, already at the speed the governor allows there
    const p0 = route[0], p1 = route[Math.min(3, route.length - 1)];
    const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    // (the surface just under the lane's own height: not a deck or a roof that passes over the lane's start)
    const s0 = gw.surface(p0.x, p0.y + 0.6, p0.z, 3, GROUPS.cameraQuery);
    const gy = Number.isNaN(s0.y) ? heightAt(gw.tile, p0.x, p0.z) : s0.y;
    const car = new RaycastCar(R, world, h, { x: p0.x, y: gy + rest + 0.02, z: p0.z, yaw });
    const v0 = Math.min(o.speed, governSpeed(f, gov));
    car.body.setLinvel({ x: Math.sin(yaw) * v0, y: 0, z: Math.cos(yaw) * v0 }, true);
    car.adopt();
    const hulls: RAPIER.Collider[] = [];
    for (let i = 0; i < car.body.numColliders(); i++) hulls.push(car.body.collider(i));
    // the physics before the crash guard (`--no-guard`): soft CCD and the crash restitution always on, as the car is made
    if (o.noGuard) car.guardPinned = true;
    const wheelLog: WheelLog[][] = [[], [], [], []];
    const pushLog: (HullPush | null)[] = [];
    const traceLog: TickTrace[] = [];
    const tickPushes: TickTrace['pushes'] = [];
    let clearG = 9, clearD = 9;
    for (const hc of hulls) { hc.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS); hc.setContactForceEventThreshold(0); }
    let air = 0;
    let prevVy = 0, prevPitch = 0, prevRoll = 0;
    // one open episode per kind: the same kind again within half a second is the same event
    const open = new Map<EventKind, { e: GroundEvent; tick: number }>();
    let stuck = 0;
    let lastS = 0;
    let settledTicks = 0;
    const seen = new Set<number>();
    const maxTicks = Math.ceil((f.length / Math.max(3, Math.min(o.speed, 12)) + 30) * 60);
    let aborted = '';
    for (let tick = 0; tick < maxTicks; tick++) {
      const pose = car.pose();
      f.advance(pose.x, pose.z);
      if (f.i >= route.length - 2 || f.remaining < 2) break;
      const speed = car.speedForward;
      const look = Math.max(4.5, Math.min(16, 3.5 + Math.abs(speed) * 0.45));
      const aim = f.lookahead(look);
      const lock = steerLock(Math.abs(speed), h.steering);
      input.steer = steerCommand(pursuitAngle({ x: pose.x, z: pose.z, yaw: car.yaw, speed }, aim, wheelbase), lock);
      pedalsFor(governSpeed(f, gov), speed, ped);
      input.throttle = ped.throttle;
      input.brake = ped.brake;
      car.step(SIM_DT, input);
      // the vertical push the wheels gave this tick (the loads act along the body's up axis)
      const upB = rotateVec(car.body.rotation(), 0, 1, 0);
      let wheelDv = 0, tireDv = 0;
      for (const w of car.wheels) { wheelDv += (w.load * upB.y * SIM_DT) / h.mass; tireDv += w.tireJy / h.mass; }
      o.onTick?.('pre', tick, car, hulls);
      const guardedNow = car.guarded;
      {
        clearG = clearD = 9;
        // (every tick: the contacts the step will solve are not in the narrow phase's lists before it)
        for (const hc of hulls) {
          if (gw.physics.terrain) { const c = hc.contactCollider(gw.physics.terrain, 0.5); if (c) clearG = Math.min(clearG, c.distance); }
          for (const m of gw.physics.staticMeshes) {
            if (m.forCars || m.firstTriangle === 0) continue;
            const c = hc.contactCollider(m.collider, 0.5);
            if (c) clearD = Math.min(clearD, c.distance);
          }
        }
        tickPushes.length = 0;
        if (o.step) o.step(); else world.step(traceQueue);
        traceQueue.drainContactForceEvents((ev) => {
          const c1 = world.getCollider(ev.collider1()), c2 = world.getCollider(ev.collider2());
          const st = c1.parent()?.isDynamic() ? c2 : c1;
          if (st.parent()?.isDynamic()) return;
          const f = ev.totalForce();
          const sgn = c1.parent()?.isDynamic() ? -1 : 1;
          tickPushes.push({ k: gw.kindOf(st), dv: [f.x, f.y, f.z].map((v) => r3((sgn * v * SIM_DT) / h.mass)) });
        });
      }
      o.onTick?.('post', tick, car, hulls);
      stats.ticks++;

      // ---- what happened this tick
      const t = car.body.translation();
      const q = car.body.rotation();
      const lv = car.body.linvel();
      const av = car.body.angvel();
      const fwd = rotateVec(q, 0, 0, 1);
      const left = rotateVec(q, 1, 0, 0);
      const up = rotateVec(q, 0, 1, 0);
      const vH = Math.hypot(lv.x, lv.z);
      const rp = route[f.i];
      // settled: past the settling time, all four wheels down for a fifth of a second since the spawn, and on the tile (a lane can
      // run past the heightmap's edge, where there is nothing to drive on)
      if (car.wheels.every((w) => w.grounded)) settledTicks++;
      const onTile = rp.x > bounds.minX + 6 && rp.x < bounds.maxX - 6 && rp.z > bounds.minZ + 6 && rp.z < bounds.maxZ - 6;
      const measuring = rp.measure && tick > THRESHOLDS.settle * 60 && settledTicks >= 12 && onTile;
      if (rp.measure) seen.add(rp.edge);
      for (let w = 0; w < 4; w++) {
        const wh = car.wheels[w];
        let k: SurfaceKind = 'none';
        let y = NaN;
        if (wh.grounded) {
          // name what the wheel's ray hit (it was cast along -up from the hardpoint: near enough straight down)
          const s = gw.surface(wh.ox, wh.oy, wh.oz, h.suspension.travel + h.wheels.radius + 0.05, GROUPS.wheelQuery, car.body);
          k = s.kind;
          y = s.y;
        }
        const wl = wheelLog[w];
        const prev = wl[wl.length - 1];
        let step: number | undefined;
        if (prev && prev.kind !== k && (k === 'ground' || k === 'deck') && (prev.kind === 'ground' || prev.kind === 'deck')) {
          // the two surfaces at the point where the wheel crossed from one to the other: the ground under it and the deck top
          const gy = heightAt(gw.tile, wh.ox, wh.oz);
          const dk = gw.deckTop(wh.ox, wh.oy, wh.oz, h.suspension.travel + h.wheels.radius + 0.4);
          if (!Number.isNaN(dk)) step = Math.abs(dk - gy);
        }
        wl.push({ kind: k, y, step });
        if (wl.length > 40) wl.shift();
      }
      const dvy = lv.y - prevVy;
      // what neither the wheels nor gravity explain: the hull was pushed (aerodynamic and tyre terms are small beside it)
      const residual = tick > 0 ? dvy - (wheelDv - 9.81 * SIM_DT) : 0;
      let push: HullPush | null = null;
      if (Math.abs(residual) > PUSH_DV) {
        const touches = hullTouches(gw, hulls);
        const clearance = hullClearance(gw, hulls, car.body);
        // the nearest contact, but a deck, a wall or a prop within 5 cm of it before the ground
        const tch = touches.find((c) => c.kind !== 'ground' && c.dist < (touches[0]?.dist ?? 0) + 0.05) ?? touches[0];
        const kind = tch?.kind ?? 'none';
        // a push while the belly and bumpers are clear of the road is an internal edge of the road's own surface (a ghost)
        push = { kind, tri: tch?.tri ?? -1, ghost: clearance > 0.06 && (kind === 'ground' || (kind === 'deck' && gw.triKind[tch!.tri] === 1)), clearance, dv: residual };
      }
      pushLog.push(push);
      if (pushLog.length > 40) pushLog.shift();
      {
        const a0 = route[Math.max(0, f.i - 4)], b0 = route[Math.min(route.length - 1, f.i + 4)];
        const run0 = Math.hypot(b0.x - a0.x, b0.z - a0.z);
        traceLog.push({
          tick, x: r3(t.x), y: r3(t.y), z: r3(t.z), vH: r3(Math.hypot(lv.x, lv.z)), vy: r3(lv.y), vyRoad: r3(run0 > 0.5 ? (Math.hypot(lv.x, lv.z) * (b0.y - a0.y)) / run0 : 0),
          dv: r3(dvy), dvSpring: r3(wheelDv), dvTire: r3(tireDv), dvSolver: r3(tick > 0 ? dvy - wheelDv - tireDv + 9.81 * SIM_DT : 0),
          pitchRate: r3(av.x * left.x + av.y * left.y + av.z * left.z), rollRate: r3(av.x * fwd.x + av.y * fwd.y + av.z * fwd.z),
          guarded: guardedNow, pushes: tickPushes.slice(), clearGround: r3(clearG), clearDeck: r3(clearD),
          contacts: o.trace ? hullContacts(gw, hulls, car.body) : [],
          wheels: car.wheels.map((w, k) => ({
            g: w.grounded ? 1 : 0, kind: wheelLog[k][wheelLog[k].length - 1]?.kind ?? 'none', fty: w.fty, fid: w.fid, hit: r3(w.hitDist), ny: r3(w.ny), nx: r3(w.nx), nz: r3(w.nz),
            cy: r3(w.oy - upB.y * w.hitDist), len: r3(w.length), rate: r3(w.rate), spring: r3(w.spring), acc: r3(w.accel), tireDv: r3(w.tireJy / h.mass),
          })),
        });
        if (traceLog.length > TRACE_TICKS) traceLog.shift();
      }
      if (dbg.__DBG && tick % (dbg.__DBGN ?? 30) === 0) {
        console.log(`t ${(tick / 60).toFixed(2)} edge ${rp.edge} i ${f.i}/${route.length} pos ${t.x.toFixed(1)},${t.y.toFixed(2)},${t.z.toFixed(1)} path ${rp.x.toFixed(1)},${rp.y.toFixed(2)},${rp.z.toFixed(1)} v ${speed.toFixed(1)} thr ${input.throttle.toFixed(2)} br ${input.brake.toFixed(2)} st ${input.steer.toFixed(2)} wheels ${car.wheels.map((w) => (w.grounded ? 1 : 0)).join('')} vy ${lv.y.toFixed(2)} resid ${residual.toFixed(2)}${push ? ` PUSH ${JSON.stringify(push)}` : ''}`);
      }
      const pitchRate = av.x * left.x + av.y * left.y + av.z * left.z;
      const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
      const grounded = car.wheels.filter((w) => w.grounded).length;
      // the road's grade at the car, from the route (about 4 m either side)
      const a = route[Math.max(0, f.i - 4)], b = route[Math.min(route.length - 1, f.i + 4)];
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      const grade = run > 0.5 ? (b.y - a.y) / run : 0;
      const vyRoad = vH * grade;
      const accel = dvy / SIM_DT + 9.81;
      const dPitch = Math.abs(pitchRate - prevPitch);
      const dRoll = Math.abs(rollRate - prevRoll);
      prevVy = lv.y; prevPitch = pitchRate; prevRoll = rollRate;
      if (grounded === 0) air++; else air = 0;
      if (measuring) {
        vSum += vH;
        vTicks++;
        stats.vMax = Math.max(stats.vMax, vH);
        const lateral = Math.hypot(t.x - rp.x, t.z - rp.z);
        const record = (kind: EventKind, value: number, detail?: string) => {
          const ep = open.get(kind);
          if (ep && tick - ep.tick < 30) {
            if (value > ep.e.value) { ep.e.value = value; ep.e.v = vH; }
            ep.tick = tick;
            return;
          }
          const cause = diagnose(gw, wheelLog, pushLog, route, f.i, vH, kind, car.body);
          const e: GroundEvent = { kind, cause, x: t.x, y: t.y, z: t.z, speed: o.speed, v: vH, edge: rp.edge, road: g.roadOf(rp.edge), cls: g.clsOf(rp.edge), value, detail: detail ?? `lateral ${lateral.toFixed(1)} m` };
          if (kind === 'air' || kind === 'launch') {
            const lc = classifyLaunch(traceLog, cause, designCrest(route, f.i, vH));
            e.origin = lc.origin;
            e.ground = lc.ground;
            if (o.trace) e.trace = traceLog.slice();
          }
          open.set(kind, { e, tick });
          events.push(e);
        };
        if (air >= THRESHOLDS.airTicks && lateral < 4) record('air', air);
        if (lv.y - vyRoad > THRESHOLDS.launchVy && grounded < 4) record('launch', lv.y - vyRoad);
        if (Math.abs(accel) > THRESHOLDS.joltAccel && grounded > 0) record('jolt', Math.abs(accel));
        if (dPitch > THRESHOLDS.kick || dRoll > THRESHOLDS.kick) record('kick', Math.max(dPitch, dRoll), dPitch > dRoll ? 'pitch' : 'roll');
        if (push && push.kind !== 'building') {
          // the hull pushed by static collision that is not a wall (a wall the lane runs into is the building scan's business)
          const what = push.kind === 'deck' ? `deck-${['building', 'top', 'edge', 'underside', 'pier'][gw.triKind[push.tri] ?? 2]}` : push.kind;
          record('contact', Math.abs(push.dv), `${what}${push.ghost ? ' (ghost)' : ''} clearance ${push.clearance.toFixed(2)} m`);
        }
      }
      // give up on a car that is lost, stuck or upside down
      const sNow = f.distAt(f.i);
      if (sNow > lastS + 0.5) { lastS = sNow; stuck = 0; } else stuck++;
      const lateralNow = Math.hypot(t.x - rp.x, t.z - rp.z);
      if (up.y < 0.3) aborted = 'flipped';
      else if (lateralNow > 6) aborted = 'off-path';
      else if (stuck > 240) aborted = 'stuck';
      if (aborted) {
        if (rp.measure && onTile && settledTicks >= 12) {
          const cause = diagnose(gw, wheelLog, pushLog, route, f.i, vH, 'abort', car.body);
          events.push({ kind: 'abort', cause, x: t.x, y: t.y, z: t.z, speed: o.speed, v: vH, edge: rp.edge, road: g.roadOf(rp.edge), cls: g.clsOf(rp.edge), value: 1, detail: aborted });
        }
        break;
      }
    }
    if (aborted) stats.aborted++;
    stats.metres += f.distAt(f.i);
    for (const e of seen) coveredEdges.add(e);
    for (const e of planned) {
      if (seen.has(e)) continue;
      const n = (tries.get(e) ?? 0) + 1;
      tries.set(e, n);
      if (n <= 2) { visited.delete(e); retry.push(e); }
    }
    car.dispose();
    world.step();
    if (o.log && stats.routes % 50 === 0) o.log(`  ${o.speed} m/s: ${stats.routes} routes, ${coveredEdges.size}/${targets.size} edges, ${events.length} events`);
  }
  stats.covered = coveredEdges.size;
  stats.vMean = vTicks ? vSum / vTicks : 0;
  stats.ms = performance.now() - t0;
  return { events, stats };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The launch classification's thresholds (docs/ground-audit.md, round four). */
export const ORIGIN = {
  /** Ticks before a launch looked at for its kick. */
  window: 30,
  /** An upward dv in one tick beyond the car's weight (m/s; 15 m/s^2, 1.5 g) that counts as a kick. */
  kick: 0.25,
  /** The hull's exact distance to what pushed it above which the push was a ghost (m). */
  ghostClear: 0.03,
  /** A step in a wheel's contact height between two ticks beyond the road's grade (m). */
  step: 0.04,
  /** A wheel this short (m) is on its bump stop. */
  bottomed: 0.05,
  /** The designed road's crest (over a 3 m chord) lifts a car when v^2 k exceeds this share of g. */
  crest: 0.8,
} as const;

/** What made a launch and what the ground was like where it happened (see `classifyLaunch`). */
export interface LaunchClass {
  /**
   * The kick: `hull-ghost:<kind>` (the hull pushed while clear of what pushed it), `hull-protrusion:<kind>` (the hull on a surface
   * that stands up between wheels at their ride height), `hull-bottomed:<kind>` (the hull on the road with a wheel on its bump stop),
   * `crash:<kind>` (a prop, a wall, a car), `wheel-step` (a spring kick where a wheel's contact jumped), `wheel-rebound` (a spring
   * kick on a continuous surface: a compression let go), `wheel-tyre`, `airtime` (no kick: the road fell away from the car).
   */
  origin: string;
  /**
   * The ground: `smooth` (continuous under every wheel, the hull clear of it, no crest or step in the diagnosis: a launch here is a
   * physics bug), `crest-real` (a crest the designed road itself has at that speed: a real car goes light there too), `crest-bake`
   * (a crest in the physics surface the design does not have), `seam` (a step, a protrusion or a sag the suspension cannot take:
   * the map), `crash` (not the ground).
   */
  ground: 'smooth' | 'crest-real' | 'crest-bake' | 'seam' | 'crash';
}

/**
 * What made a launch, from the ticks before it. Each tick's vertical dv is split exactly into the springs, the tyres, gravity and
 * the solver (the hull: Rapier's contact force events say what pushed it); the largest kick in the window names the origin.
 * `designCrest` is v^2 k / g of the designed road (the lane's profile) over the same window.
 */
export function classifyLaunch(trace: TickTrace[], cause: string, designCrest: number): LaunchClass {
  const W = trace.slice(-ORIGIN.window);
  const G1 = 9.81 * SIM_DT;
  let best = 0, at = -1, src = '';
  for (let i = 1; i < W.length; i++) {
    const t = W[i];
    let ground = 0, other = 0, otherKind = '';
    for (const p of t.pushes) {
      if (p.k === 'ground' || p.k === 'deck') ground += p.dv[1];
      else if (p.dv[1] > other || Math.hypot(p.dv[0], p.dv[2]) > ORIGIN.kick) { other = Math.max(other, p.dv[1], Math.hypot(p.dv[0], p.dv[2])); otherKind = p.k; }
    }
    const cand: [number, string][] = [[ground, 'hull'], [other, `crash:${otherKind}`], [t.dvSpring - G1, 'spring'], [t.dvTire, 'tyre']];
    for (const [v, k] of cand) if (v > best) { best = v; at = i; src = k; }
  }
  // a wheel whose contact jumped between two grounded ticks beyond the road's grade
  const stepped = (from: number, to: number) => {
    for (let i = Math.max(1, from); i <= to && i < W.length; i++) {
      for (let w = 0; w < 4; w++) {
        const a = W[i - 1].wheels[w], b = W[i].wheels[w];
        if (!a.g || !b.g) continue;
        if (Math.abs(b.cy - a.cy - W[i].vyRoad * SIM_DT) > ORIGIN.step) return true;
      }
    }
    return false;
  };
  const bottomedNear = (i: number) => W.slice(Math.max(0, i - 3), i + 1).some((t) => t.wheels.some((w) => w.g && w.len <= ORIGIN.bottomed));
  let origin: string;
  if (best < ORIGIN.kick) origin = 'airtime';
  else if (src.startsWith('crash')) origin = src;
  else if (src === 'hull') {
    const t = W[at];
    const top = t.pushes.filter((p) => p.k === 'ground' || p.k === 'deck').sort((a, b) => b.dv[1] - a.dv[1])[0];
    const kind = top?.k ?? 'ground';
    const clear = kind === 'deck' ? t.clearDeck : t.clearGround;
    origin = clear > ORIGIN.ghostClear ? `hull-ghost:${kind}` : bottomedNear(at) ? `hull-bottomed:${kind}` : `hull-protrusion:${kind}`;
  } else if (src === 'spring') origin = stepped(at - 6, at) ? 'wheel-step' : 'wheel-rebound';
  else origin = 'wheel-tyre';

  let ground: LaunchClass['ground'];
  const crestCause = /^(crest|sag)/.test(cause);
  const seamCause = /^(surface-step|wheel-on-|hull-on-slab-edge|hull-on-pier|hull-on-wall)/.test(cause);
  if (origin.startsWith('crash')) ground = 'crash';
  else if (crestCause && designCrest > ORIGIN.crest) ground = 'crest-real';
  else if (origin.startsWith('hull-protrusion') || origin.startsWith('hull-bottomed') || origin === 'wheel-step' || seamCause || stepped(1, W.length - 1)) ground = 'seam';
  else if (crestCause) ground = 'crest-bake';
  else ground = 'smooth';
  return { origin, ground };
}

/** v^2 k / g of the route's own profile (the designed road) over 3 m chords from `back` m behind point i to `ahead` m in front. */
function designCrest(route: { x: number; y: number; z: number }[], i: number, v: number, back = 14, ahead = 2): number {
  let s = 0, a = i, b = i;
  while (a > 0 && s < back) { s += Math.hypot(route[a].x - route[a - 1].x, route[a].z - route[a - 1].z); a--; }
  s = 0;
  while (b < route.length - 1 && s < ahead) { s += Math.hypot(route[b + 1].x - route[b].x, route[b + 1].z - route[b].z); b++; }
  let k = 0;
  for (let m = a; m <= b; m++) {
    // the points 1.5 m either side along the route
    let p = m, q = m, sp = 0, sq = 0;
    while (p > 0 && sp < 1.5) { sp += Math.hypot(route[p].x - route[p - 1].x, route[p].z - route[p - 1].z); p--; }
    while (q < route.length - 1 && sq < 1.5) { sq += Math.hypot(route[q + 1].x - route[q].x, route[q + 1].z - route[q].z); q++; }
    if (sp < 1.2 || sq < 1.2) continue;
    // curvature of the profile through the three points (y against distance along the route)
    const slope1 = (route[m].y - route[p].y) / sp, slope2 = (route[q].y - route[m].y) / sq;
    k = Math.max(k, (slope1 - slope2) / ((sp + sq) / 2));
  }
  return (v * v * k) / 9.81;
}

/**
 * Why did it happen? In order: a wheel on something that is not a road; the hull pushed by an internal edge (a "ghost": the
 * solver pushed while the hull was clear of the surface); a step under a wheel between two surfaces; the hull on a slab's edge,
 * a pier, a wall or a prop; a crest or a sag too sharp for the speed; the drawn road and the physics apart; the hull on the road.
 */
function diagnose(gw: GroundWorld, wheelLog: WheelLog[][], pushLog: (HullPush | null)[], route: RoutePoint[], i: number, v: number, kind: EventKind, body: RAPIER.RigidBody): string {
  for (const wl of wheelLog) {
    for (const s of wl.slice(-30)) {
      if (s.kind === 'prop') return 'wheel-on-prop';
      if (s.kind === 'vehicle') return 'wheel-on-vehicle';
      if (s.kind === 'building') return 'wheel-on-building';
      if (s.kind === 'pier') return 'wheel-on-pier';
    }
  }
  let hullHit = '';
  for (const p of pushLog.slice(-30)) {
    if (!p) continue;
    if (p.ghost && (p.kind === 'deck' || p.kind === 'ground')) return p.kind === 'deck' ? 'ghost-edge-deck' : 'ghost-edge-ground';
    const name = p.kind === 'building' ? 'hull-on-wall' : p.kind === 'deck' ? (gw.triKind[p.tri] === 1 ? 'hull-on-deck-top' : 'hull-on-slab-edge') : p.kind === 'pier' ? 'hull-on-pier' : p.kind === 'ground' ? 'hull-on-ground' : p.kind === 'prop' ? 'hull-on-prop' : '';
    if (name && (!hullHit || name !== 'hull-on-ground')) hullHit = name;
  }
  // a wheel crossing from the ground to a deck or back with a step between them where it crossed
  let worstStep = 0, stepKinds = '';
  for (const wl of wheelLog) {
    const recent = wl.slice(-30);
    for (let k = 1; k < recent.length; k++) {
      const a = recent[k - 1], b = recent[k];
      if (b.step === undefined) continue;
      if (b.step > worstStep) { worstStep = b.step; stepKinds = `${a.kind}>${b.kind}`; }
    }
  }
  const prof = trackProfile(gw, route, i, 14, 2, body);
  const g = 9.81;
  if (worstStep > THRESHOLDS.step) return `surface-step:${stepKinds}`;
  if (prof.step > THRESHOLDS.step) return `surface-step:${prof.stepKinds}`;
  if (hullHit && hullHit !== 'hull-on-ground' && hullHit !== 'hull-on-deck-top') return hullHit;
  if (v * v * prof.crest > 0.8 * g) return prof.crestKind === 'ground' ? 'crest' : `crest-${prof.crestKind}`;
  if (v * v * prof.sag > 1.2 * g) return prof.sagKind === 'ground' ? 'sag' : `sag-${prof.sagKind}`;
  if (prof.mismatch > THRESHOLDS.mismatch) return 'visual-mismatch';
  if (hullHit) return hullHit;
  if (kind === 'abort') return 'ai';
  return prof.onDeck ? 'unexplained-deck' : 'unexplained';
}

/** The surface under the route (centre and wheel tracks) from `back` m behind point i to `ahead` m in front. */
export function trackProfile(gw: GroundWorld, route: { x: number; y: number; z: number }[], i: number, back: number, ahead: number, exclude?: RAPIER.RigidBody) {
  // walk back and forward along the route to the window ends
  const pts: { x: number; y: number; z: number }[] = [];
  let s = 0, k = i;
  while (k > 0 && s < back) { s += Math.hypot(route[k].x - route[k - 1].x, route[k].z - route[k - 1].z); k--; }
  const a = k;
  s = 0; k = i;
  while (k < route.length - 1 && s < ahead) { s += Math.hypot(route[k + 1].x - route[k].x, route[k + 1].z - route[k].z); k++; }
  for (let j = a; j <= k; j++) pts.push(route[j]);
  return profileOf(gw, pts, exclude);
}

export interface Profile {
  /** Largest step between samples 0.25 m apart beyond the grade, m, and between which surfaces. */
  step: number;
  stepKinds: string;
  stepAt: { x: number; z: number } | null;
  /** Largest crest and sag curvature over a 3 m chord, 1/m, and on what. */
  crest: number;
  crestKind: string;
  crestAt: { x: number; z: number } | null;
  sag: number;
  sagKind: string;
  sagAt: { x: number; z: number } | null;
  /** Largest gap between the drawn road (the polyline's y) and the physics surface, m. */
  mismatch: number;
  mismatchAt: { x: number; z: number } | null;
  onDeck: boolean;
}

/** Samples the physics surface along a polyline (centre and two wheel tracks 0.8 m either side) every 0.25 m. */
export function profileOf(gw: GroundWorld, pts: { x: number; y: number; z: number }[], exclude?: RAPIER.RigidBody): Profile {
  const out: Profile = { step: 0, stepKinds: '', stepAt: null, crest: 0, crestKind: '', crestAt: null, sag: 0, sagKind: '', sagAt: null, mismatch: 0, mismatchAt: null, onDeck: false };
  if (pts.length < 2) return out;
  const DS = 0.25;
  const CH = 12; // 3 m chord in samples
  // the normal at each vertex is the mean of its two segments' (a mitre), interpolated along each segment, so an offset track
  // is continuous round a bend instead of jumping across the corner (a jump on a cross-slope read as a step)
  const vn: { x: number; z: number }[] = pts.map((_, j) => {
    let nx = 0, nz = 0;
    for (const [a, b] of [[j - 1, j], [j, j + 1]]) {
      if (a < 0 || b >= pts.length) continue;
      const l = Math.hypot(pts[b].x - pts[a].x, pts[b].z - pts[a].z);
      if (l < 1e-6) continue;
      nx += -(pts[b].z - pts[a].z) / l;
      nz += (pts[b].x - pts[a].x) / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    return { x: nx / l, z: nz / l };
  });
  for (const off of [0, -0.8, 0.8]) {
    const ys: number[] = [];
    const ks: SurfaceKind[] = [];
    const xs: number[] = [];
    const zs: number[] = [];
    const vis: number[] = [];
    for (let j = 0; j + 1 < pts.length; j++) {
      const p = pts[j], q = pts[j + 1];
      const l = Math.hypot(q.x - p.x, q.z - p.z);
      if (l < 1e-6) continue;
      const n = Math.max(1, Math.round(l / DS));
      for (let m = 0; m < n; m++) {
        const t = m / n;
        const nx = vn[j].x + (vn[j + 1].x - vn[j].x) * t, nz = vn[j].z + (vn[j + 1].z - vn[j].z) * t;
        const x = p.x + (q.x - p.x) * t + nx * off, z = p.z + (q.z - p.z) * t + nz * off;
        const yv = p.y + (q.y - p.y) * t;
        const s = gw.surface(x, yv + 1.2, z, 3, GROUPS.cameraQuery, exclude);
        ys.push(s.y); ks.push(s.kind); xs.push(x); zs.push(z); vis.push(yv);
        if (s.kind === 'deck') out.onDeck = true;
      }
    }
    for (let m = 1; m < ys.length; m++) {
      if (Number.isNaN(ys[m]) || Number.isNaN(ys[m - 1])) continue;
      // the step beyond what the local grade (over 2 m) explains
      const a = Math.max(0, m - 8), b = Math.min(ys.length - 1, m + 7);
      let grade = 0;
      if (b > a && !Number.isNaN(ys[a]) && !Number.isNaN(ys[b])) grade = (ys[b] - ys[a]) / ((b - a) * DS);
      const st = Math.abs(ys[m] - ys[m - 1] - grade * DS);
      if (st > out.step) { out.step = st; out.stepKinds = `${ks[m - 1]}>${ks[m]}`; out.stepAt = { x: xs[m], z: zs[m] }; }
      if (off === 0) {
        const mm = Math.abs(vis[m] - ys[m]);
        if (mm > out.mismatch) { out.mismatch = mm; out.mismatchAt = { x: xs[m], z: zs[m] }; }
      }
    }
    for (let m = CH; m + CH < ys.length; m++) {
      const y0 = ys[m - CH], y1 = ys[m], y2 = ys[m + CH];
      if (Number.isNaN(y0) || Number.isNaN(y1) || Number.isNaN(y2)) continue;
      const L = CH * DS;
      const k = (2 * y1 - y0 - y2) / (L * L);
      const kind = ks[m] === 'ground' ? 'ground' : ks[m];
      if (k > out.crest) { out.crest = k; out.crestKind = kind; out.crestAt = { x: xs[m], z: zs[m] }; }
      if (-k > out.sag) { out.sag = -k; out.sagKind = kind; out.sagAt = { x: xs[m], z: zs[m] }; }
    }
  }
  return out;
}

/** The surface along every edge: steps, crests that throw a car at each speed, drawn-versus-physics gaps. */
export function scanSurfaces(gw: GroundWorld, g: Graph, speeds: number[], edges?: Iterable<number>): GroundEvent[] {
  const out: GroundEvent[] = [];
  for (const i of edges ?? g.edges.map((_, k) => k)) {
    const e = g.edges[i];
    const pts: { x: number; y: number; z: number }[] = [];
    for (let k = 0; k < e.pts.length; k += 3) pts.push({ x: e.pts[k], y: e.pts[k + 1], z: e.pts[k + 2] });
    if (pts.length < 2) continue;
    const p = profileOf(gw, pts);
    const base = { edge: i, road: g.roadOf(i), cls: g.clsOf(i), speed: 0, v: 0 };
    const yAt = (q: { x: number; z: number }) => heightAt(gw.tile, q.x, q.z);
    const b = gw.tile.manifest.bounds;
    const edgeOfTile = (q: { x: number; z: number } | null) => !q || q.x < b.minX + 6 || q.x > b.maxX - 6 || q.z < b.minZ + 6 || q.z > b.maxZ - 6;
    if (edgeOfTile(p.stepAt)) p.step = 0;
    if (edgeOfTile(p.mismatchAt)) p.mismatch = 0;
    if (edgeOfTile(p.crestAt)) p.crest = 0;
    if (p.step > THRESHOLDS.step && p.stepAt) out.push({ kind: 'step', cause: `surface-step:${p.stepKinds}`, ...p.stepAt, y: yAt(p.stepAt), value: p.step, ...base });
    if (p.mismatch > THRESHOLDS.mismatch && p.mismatchAt) out.push({ kind: 'mismatch', cause: 'visual-mismatch', ...p.mismatchAt, y: yAt(p.mismatchAt), value: p.mismatch, ...base });
    // the lowest speed of the run that a crest would throw a car at: v^2 k > g
    if (p.crestAt && p.crest > 0) {
      const vLift = Math.sqrt(9.81 / p.crest);
      const lim = Math.min(e.v * 1.6 + 6, Math.max(...speeds));
      if (vLift < lim) out.push({ kind: 'crest', cause: p.crestKind === 'ground' ? 'crest' : `crest-${p.crestKind}`, ...p.crestAt, y: yAt(p.crestAt), value: vLift, ...base, detail: `airborne from ${vLift.toFixed(1)} m/s (k ${p.crest.toFixed(4)}/m)` });
    }
  }
  return out;
}

/**
 * Street furniture standing where a car on a lane goes: a solid box (a pole, a trunk, a bench) within a car's half width (0.95 m)
 * of a lane's or a connector's centreline, below 1.5 m over the road. (The props' places are the props' business; the audit
 * reports them because a car that meets one stops dead or climbs it.)
 */
export function scanProps(gw: GroundWorld, g: Graph): GroundEvent[] {
  const out: GroundEvent[] = [];
  const cells = new Map<string, ReturnType<typeof worldSolids>>();
  const kinds = new Map<ReturnType<typeof worldSolids>[number], string>();
  for (const prop of gw.physics.props) {
    for (const bx of worldSolids(prop)) {
      kinds.set(bx, prop.kind);
      const k = `${Math.floor(bx.cx / 8)},${Math.floor(bx.cz / 8)}`;
      const l = cells.get(k);
      if (l) l.push(bx); else cells.set(k, [bx]);
    }
  }
  g.edges.forEach((e, i) => {
    const p = e.pts;
    const hit = new Set<ReturnType<typeof worldSolids>[number]>();
    for (let k = 0; k + 3 < p.length; k += 3) {
      const l = Math.hypot(p[k + 3] - p[k], p[k + 5] - p[k + 2]);
      const n = Math.max(1, Math.ceil(l / 0.5));
      for (let m = 0; m <= n; m++) {
        const t = m / n;
        const x = p[k] + (p[k + 3] - p[k]) * t, y = p[k + 1] + (p[k + 4] - p[k + 1]) * t, z = p[k + 2] + (p[k + 5] - p[k + 2]) * t;
        for (let gx = Math.floor((x - 3) / 8); gx <= Math.floor((x + 3) / 8); gx++) {
          for (let gz = Math.floor((z - 3) / 8); gz <= Math.floor((z + 3) / 8); gz++) {
            for (const bx of cells.get(`${gx},${gz}`) ?? []) {
              if (hit.has(bx) || bx.cy - bx.hy > y + 1.5 || bx.cy + bx.hy < y - 0.5) continue;
              const dx = x - bx.cx, dz = z - bx.cz;
              const sn = Math.sin(bx.yaw), cs = Math.cos(bx.yaw);
              const lx = Math.abs(dx * cs - dz * sn) - bx.hx, lz = Math.abs(dx * sn + dz * cs) - bx.hz;
              const d = Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
              if (d > 0.95) continue;
              hit.add(bx);
              out.push({ kind: 'prop', cause: `prop-in-lane:${kinds.get(bx)}`, x: bx.cx, y, z: bx.cz, speed: 0, v: 0, edge: i, road: g.roadOf(i), cls: g.clsOf(i), value: d, detail: `${kinds.get(bx)} ${d.toFixed(2)} m from the lane's centre` });
            }
          }
        }
      }
    }
  });
  return out;
}

const MAIN_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'living_street']);
export const isMainRoad = (cls: string) => MAIN_CLASSES.has(cls);

/**
 * Lanes, connectors and road centrelines that run into or through a building footprint. A car's body is tested, not only
 * its centre: the lane's centre and 0.9 m either side.
 */
export function scanBuildings(gw: GroundWorld, g: Graph): GroundEvent[] {
  const fp = gw.footprints;
  const out: GroundEvent[] = [];
  const runsOf = (pts: number[], half: number) => {
    // samples every 0.5 m: inside a footprint (at the road's height) at the centre or either side
    const ins: boolean[] = [];
    const xyz: [number, number, number][] = [];
    for (let k = 0; k + 3 < pts.length; k += 3) {
      const ax = pts[k], ay = pts[k + 1], az = pts[k + 2], bx = pts[k + 3], by = pts[k + 4], bz = pts[k + 5];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 1e-6) continue;
      const nx = -(bz - az) / l, nz = (bx - ax) / l;
      const n = Math.max(1, Math.ceil(l / 0.5));
      for (let m = 0; m < n; m++) {
        const t = m / n;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
        let inside = fp.inside(x, y, z);
        if (!inside && half > 0) inside = fp.inside(x + nx * half, y, z + nz * half) || fp.inside(x - nx * half, y, z - nz * half);
        ins.push(inside);
        xyz.push([x, y, z]);
      }
    }
    const n = pts.length / 3;
    ins.push(fp.inside(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]));
    xyz.push([pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]]);
    const runs: { a: number; b: number }[] = [];
    for (let m = 0; m < ins.length; m++) {
      if (!ins[m]) continue;
      let e = m;
      while (e + 1 < ins.length && ins[e + 1]) e++;
      runs.push({ a: m, b: e });
      m = e;
    }
    return { runs, xyz, count: ins.length };
  };
  g.edges.forEach((e, i) => {
    const { runs, xyz, count } = runsOf(e.pts, 0.9);
    for (const r of runs) {
      const len = (r.b - r.a + 1) * 0.5;
      if (len < 0.75) continue;
      const atStart = r.a === 0, atEnd = r.b === count - 1;
      const cause = e.t === 1 ? 'connector-into-building' : atEnd ? 'lane-ends-in-building' : atStart ? 'lane-starts-in-building' : 'lane-through-building';
      const p = xyz[atEnd ? r.a : r.a];
      out.push({ kind: 'building', cause, x: p[0], y: p[1], z: p[2], speed: 0, v: 0, edge: i, road: g.roadOf(i), cls: g.clsOf(i), value: len });
    }
  });
  // dead ends that face a building: a lane whose only way on is a turnaround (or nothing), a road end that meets no other road
  const b = gw.tile.manifest.bounds;
  const inside = (x: number, z: number, m: number) => x > b.minX + m && x < b.maxX - m && z > b.minZ + m && z < b.maxZ - m;
  const facing = (x: number, y: number, z: number, dx: number, dz: number, reach: number): number => {
    const l = Math.hypot(dx, dz) || 1;
    for (let s = 0; s <= reach; s += 0.5) if (fp.inside(x + (dx / l) * s, y, z + (dz / l) * s)) return s;
    return -1;
  };
  g.edges.forEach((e, i) => {
    if (e.t !== 0) return;
    const nx = e.next.filter((n) => n >= 0 && n < g.edges.length);
    if (nx.length && !nx.every((n) => (g.edges[n] as { turn?: string }).turn === 'u')) return;
    const p = e.pts, n = p.length / 3;
    if (n < 2 || !inside(p[(n - 1) * 3], p[(n - 1) * 3 + 2], 15)) return;
    const d = facing(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2], p[(n - 1) * 3] - p[(n - 2) * 3], p[(n - 1) * 3 + 2] - p[(n - 2) * 3 + 2], 12);
    if (d >= 0) out.push({ kind: 'building', cause: 'lane-dead-ends-at-building', x: p[(n - 1) * 3], y: p[(n - 1) * 3 + 1], z: p[(n - 1) * 3 + 2], speed: 0, v: 0, edge: i, road: g.roadOf(i), cls: g.clsOf(i), value: d, detail: `wall ${d.toFixed(1)} m ahead` });
  });
  for (const road of gw.tile.roads ?? []) {
    const P = road.points;
    if (P.length < 2) continue;
    for (const [a, c] of [[P.length - 1, P.length - 2], [0, 1]] as const) {
      const q = P[a];
      if (!inside(q[0], q[2], 15)) continue;
      // another road's point within a metre: a joint, not a dead end
      let shared = false;
      for (const other of gw.tile.roads ?? []) {
        if (other === road) continue;
        for (const o of other.points) if (Math.hypot(o[0] - q[0], o[2] - q[2]) < 1.5) { shared = true; break; }
        if (shared) break;
      }
      if (shared) continue;
      const d = facing(q[0], q[1], q[2], q[0] - P[c][0], q[2] - P[c][2], 12);
      if (d < 0) continue;
      // a carriageway that runs on into the wall (within 4 m of its end) leads a car into a building; one that stops short of it,
      // with ground before the wall, is a dead end in front of a building (a cul-de-sac), reported but not a fault
      const into = d <= 4;
      out.push({ kind: 'building', cause: isMainRoad(road.class) ? (into ? 'main-road-dead-ends-at-building' : 'main-road-dead-end-near-building') : 'service-road-dead-ends-at-building', x: q[0], y: q[1], z: q[2], speed: 0, v: 0, edge: -1, road: road.id, cls: road.class, value: d, detail: `${road.name}: wall ${d.toFixed(1)} m ahead` });
    }
  }
  for (const road of gw.tile.roads ?? []) {
    const pts: number[] = [];
    for (const p of road.points) pts.push(p[0], p[1], p[2]);
    if (pts.length < 6) continue;
    const { runs, xyz } = runsOf(pts, 0);
    for (const r of runs) {
      const len = (r.b - r.a + 1) * 0.5;
      if (len < 1) continue;
      const p = xyz[r.a];
      const main = isMainRoad(road.class);
      out.push({ kind: 'building', cause: main ? (road.bridge ? 'deck-road-in-building' : 'main-road-in-building') : 'service-road-in-building', x: p[0], y: p[1], z: p[2], speed: 0, v: 0, edge: -1, road: road.id, cls: road.class, value: len, detail: road.name });
    }
  }
  return out;
}

/** Events within `r` metres of each other grouped into spots, worst first. */
export function clusterSpots(events: GroundEvent[], r = 12): { x: number; z: number; n: number; kinds: Record<string, number>; causes: Record<string, number>; speeds: number[]; roads: string[]; worst: GroundEvent }[] {
  const spots: { x: number; z: number; n: number; kinds: Record<string, number>; causes: Record<string, number>; speeds: Set<number>; roads: Set<string>; worst: GroundEvent; score: number }[] = [];
  const weight = (e: GroundEvent) => (e.kind === 'air' || e.kind === 'launch' ? 5 : e.kind === 'abort' ? 4 : e.kind === 'building' ? 3 : e.kind === 'jolt' || e.kind === 'kick' ? 2 : 1);
  for (const e of events) {
    let s = spots.find((q) => Math.hypot(q.x - e.x, q.z - e.z) < r);
    if (!s) {
      s = { x: e.x, z: e.z, n: 0, kinds: {}, causes: {}, speeds: new Set(), roads: new Set(), worst: e, score: 0 };
      spots.push(s);
    }
    s.n++;
    s.kinds[e.kind] = (s.kinds[e.kind] ?? 0) + 1;
    s.causes[e.cause] = (s.causes[e.cause] ?? 0) + 1;
    if (e.speed) s.speeds.add(e.speed);
    s.roads.add(e.road);
    s.score += weight(e);
    if (weight(e) > weight(s.worst)) s.worst = e;
  }
  spots.sort((a, b) => b.score - a.score);
  return spots.map((s) => ({ x: Math.round(s.x * 10) / 10, z: Math.round(s.z * 10) / 10, n: s.n, kinds: s.kinds, causes: s.causes, speeds: [...s.speeds].sort((a, b) => a - b), roads: [...s.roads].slice(0, 4), worst: s.worst }));
}

/** Counts by kind and by cause (and by kind and speed for the drive). */
export function countEvents(events: GroundEvent[]) {
  const byKind: Record<string, number> = {};
  const byCause: Record<string, number> = {};
  const byKindCause: Record<string, Record<string, number>> = {};
  const bySpeed: Record<string, Record<string, number>> = {};
  const launchGround: Record<string, number> = {};
  const launchOrigin: Record<string, number> = {};
  for (const e of events) {
    if (e.ground) launchGround[e.ground] = (launchGround[e.ground] ?? 0) + 1;
    if (e.origin) launchOrigin[e.origin] = (launchOrigin[e.origin] ?? 0) + 1;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    byCause[e.cause] = (byCause[e.cause] ?? 0) + 1;
    (byKindCause[e.kind] ??= {})[e.cause] = (byKindCause[e.kind][e.cause] ?? 0) + 1;
    if (e.speed) (bySpeed[e.speed] ??= {})[e.kind] = (bySpeed[e.speed][e.kind] ?? 0) + 1;
  }
  return { byKind, byCause, byKindCause, bySpeed, launchGround, launchOrigin };
}

/** Edges split into `n` groups by region (stripes along x of about equal edge counts), so a shard's routes stay near each other. */
export function shardEdges(g: Graph, n: number): number[][] {
  const ids = g.edges.map((_, i) => i).sort((a, b) => g.mid[a].x - g.mid[b].x || a - b);
  const out: number[][] = Array.from({ length: n }, () => []);
  ids.forEach((id, k) => out[Math.min(n - 1, Math.floor((k * n) / ids.length))].push(id));
  return out;
}
