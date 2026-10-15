/**
 * Where police cars can drive and where the player is going. Two networks, one interface:
 *
 *  - the **lane graph** (`lanes.json`, the one traffic drives on) where the car and its goal are on it:
 *    routes follow real lanes, so a unit is in the lane it was planned for rather than on the middle
 *    line of the street, and can be steered off the street the target is on (a flanker);
 *  - the **road graph** (`roads.json` centrelines) everywhere else: the freeways run off the clipped
 *    tile, so the lane graph's connected part leaves them out, and a tile with no `lanes.json` has only this.
 *
 * Pure: no physics and no sim. The prediction (`predict`) follows the player's lane, going straight on
 * unless their yaw rate says they are turning; it feeds the intercept and the roadblocks.
 */
import { planRoute } from '../traffic/route';
import type { LaneGraph } from '../traffic/LaneGraph';
import { densify, polyLength, RoadGraph, type PathPoint, type Snap } from './roadGraph';

export interface LaneSnap {
  edge: number;
  s: number;
  dist: number;
}

/** A path with its running lengths, for asking "the point s metres along". */
export interface Polyline {
  pts: PathPoint[];
  cum: number[];
  length: number;
}

export function polyline(pts: readonly PathPoint[]): Polyline {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts: pts as PathPoint[], cum, length: cum.length ? cum[cum.length - 1] : 0 };
}

/** The point `s` metres along a polyline and the direction it runs there (clamped to its ends). */
export function pointAlong(pl: Polyline, s: number): PathPoint & { dx: number; dz: number } {
  const n = pl.pts.length;
  if (n === 0) return { x: 0, z: 0, dx: 0, dz: 1 };
  if (n === 1) return { x: pl.pts[0].x, z: pl.pts[0].z, dx: 0, dz: 1 };
  const t = Math.max(0, Math.min(pl.length, s));
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pl.cum[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const a = pl.pts[lo - 1];
  const b = pl.pts[lo];
  const seg = pl.cum[lo] - pl.cum[lo - 1] || 1;
  const u = (t - pl.cum[lo - 1]) / seg;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * u, z: a.z + dz * u, dx: dx / l, dz: dz / l };
}

/** The distance along a polyline of the point nearest (x, z), and how far off it is. */
export function project(pl: Polyline, x: number, z: number): { s: number; dist: number } {
  let bestD = Infinity;
  let bestS = 0;
  for (let i = 1; i < pl.pts.length; i++) {
    const a = pl.pts[i - 1];
    const b = pl.pts[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (d < bestD) {
      bestD = d;
      bestS = pl.cum[i - 1] + t * (pl.cum[i] - pl.cum[i - 1]);
    }
  }
  return { s: bestS, dist: bestD };
}

export class PoliceNav {
  private laneGraph: LaneGraph | null | undefined;

  constructor(
    readonly roads: RoadGraph,
    private readonly findLanes: () => LaneGraph | null,
  ) {}

  /** The lane graph, when the tile has a usable one. */
  get lanes(): LaneGraph | null {
    if (this.laneGraph === undefined) this.laneGraph = this.findLanes();
    return this.laneGraph;
  }

  get empty(): boolean {
    return this.roads.empty && !this.lanes;
  }

  // ---------------------------------------------------------------------------------------------
  // Lanes

  /**
   * The lane (of the part of the graph cars route over) nearest to a position, heading the way `heading`
   * points when it is given (a lane against it is skipped). Null when none is within `maxDist`.
   */
  snapLane(x: number, z: number, heading: number | null, maxDist = 16): LaneSnap | null {
    return this.snapLanes(x, z, heading, maxDist, 1)[0] ?? null;
  }

  /** The `count` best lanes near a position (see `snapLane`), best first. */
  snapLanes(x: number, z: number, heading: number | null, maxDist: number, count: number): LaneSnap[] {
    const g = this.lanes;
    if (!g) return [];
    const fx = heading === null ? 0 : Math.sin(heading);
    const fz = heading === null ? 0 : Math.cos(heading);
    const spots = g.spotsAround(x, z, 0, maxDist + 24, this.spotBuf);
    const seen = new Set<number>();
    const found: { snap: LaneSnap; score: number }[] = [];
    const tmp = { s: 0, dist: 0 };
    const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    for (const sp of spots) {
      if (seen.has(sp.edge)) continue;
      seen.add(sp.edge);
      g.project(sp.edge, x, z, sp.s, 60, 60, tmp);
      if (tmp.dist > maxDist) continue;
      g.posAt(sp.edge, tmp.s, pt);
      const align = heading === null ? 1 : pt.tx * fx + pt.tz * fz;
      if (heading !== null && align < 0.3) continue;
      found.push({ snap: { edge: sp.edge, s: tmp.s, dist: tmp.dist }, score: tmp.dist + (1 - align) * 6 });
    }
    found.sort((p, q) => p.score - q.score);
    return found.slice(0, count).map((f) => f.snap);
  }

  private readonly spotBuf: import('../traffic/LaneGraph').SpawnSpot[] = [];

  /** The points of a lane edge from distance `a` to `b` along it (a <= b), the ends interpolated. */
  private laneSlice(edge: number, a: number, b: number, out: PathPoint[]) {
    const g = this.lanes!;
    const p = g.pts[edge];
    const c = g.cum[edge];
    const m = c.length;
    const lo = Math.max(0, Math.min(a, g.len[edge]));
    const hi = Math.max(lo, Math.min(b, g.len[edge]));
    const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    g.posAt(edge, lo, pt);
    out.push({ x: pt.x, z: pt.z });
    for (let i = 1; i < m - 1; i++) if (c[i] > lo && c[i] < hi) out.push({ x: p[i * 3], z: p[i * 3 + 2] });
    g.posAt(edge, hi, pt);
    out.push({ x: pt.x, z: pt.z });
  }

  /**
   * A route over the lane graph from a position to a goal: `heading` is the way the car points, `goalHeading`
   * (when the goal is a moving car) the way the goal is travelling, so the route ends in the lane they are in.
   * `avoid` (a path) makes lanes within 14 m of it expensive: a flanker keeps off the street the target is on.
   * Null when the car or the goal is not on the graph, or no route exists.
   */
  laneRoute(from: PathPoint, heading: number, to: PathPoint, goalHeading: number | null = null, avoid?: Polyline | null): PathPoint[] | null {
    const g = this.lanes;
    if (!g) return null;
    const a = this.snapLane(from.x, from.z, heading, 14);
    if (!a) return null;
    // The goal may be off the road (a player on the pavement) and the lane nearest it may run the wrong way: try the few nearest and keep the shortest.
    const goals = this.snapLanes(to.x, to.z, goalHeading, 24, goalHeading === null ? 4 : 2);
    if (goals.length === 0) return null;
    let extra: ((e: number) => number) | undefined;
    if (avoid && avoid.length > 5) {
      const near = new Set<number>();
      for (let s = 0; s <= avoid.length; s += 12) {
        const p = pointAlong(avoid, s);
        for (const sp of g.spotsAround(p.x, p.z, 0, 14, this.spotBuf)) near.add(sp.edge);
      }
      for (const b of goals) near.delete(b.edge);
      extra = (e) => (near.has(e) ? 18 : 0);
    }
    let best: PathPoint[] | null = null;
    let bestLen = Infinity;
    for (const b of goals) {
      const pts = this.laneRouteTo(a, b, from, extra);
      if (!pts) continue;
      const len = polyLength(pts);
      if (len < bestLen) {
        bestLen = len;
        best = pts;
      }
    }
    return best;
  }

  private laneRouteTo(a: LaneSnap, b: LaneSnap, from: PathPoint, extra?: (e: number) => number): PathPoint[] | null {
    const g = this.lanes!;
    const out: PathPoint[] = [{ x: from.x, z: from.z }];
    if (a.edge === b.edge && b.s >= a.s - 0.5) {
      this.laneSlice(a.edge, a.s, b.s, out);
      return densify(out);
    }
    let chain = planRoute(g, a.edge, b.edge, 3500, extra);
    if (!chain && a.edge === b.edge) {
      // The goal is behind us on this lane: round the block, by whichever way on is shortest.
      let bestLen = Infinity;
      for (const nx of g.next[a.edge]) {
        if (!g.main[nx]) continue;
        const rest = planRoute(g, nx, b.edge, 3500, extra);
        if (!rest) continue;
        let len = g.len[nx];
        for (const e of rest) len += g.len[e];
        if (len < bestLen) {
          bestLen = len;
          chain = [nx, ...rest];
        }
      }
    }
    if (!chain) return null;
    this.laneSlice(a.edge, a.s, g.len[a.edge], out);
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i];
      if (i === chain.length - 1 && e === b.edge) this.laneSlice(e, 0, b.s, out);
      else this.laneSlice(e, 0, g.len[e], out);
    }
    return densify(out);
  }

  /**
   * The best route from a position to a goal: over the lanes when both are on them, else over the
   * road centrelines. Null when the two are not connected.
   */
  route(from: PathPoint, heading: number, to: PathPoint, opts: { goalHeading?: number | null; avoid?: Polyline | null; roadSnap?: Snap | null } = {}): PathPoint[] | null {
    const lane = this.laneRoute(from, heading, to, opts.goalHeading ?? null, opts.avoid);
    const straight = Math.hypot(to.x - from.x, to.z - from.z);
    if (lane && lane.length > 1) {
      // A lane route far longer than the way there looks (a one-way loop): the centrelines may do better.
      if (polyLength(lane) <= straight * 1.7 + 140) return lane;
      const alt = this.roads.route(from, heading, to, opts.roadSnap, opts.goalHeading ?? null);
      return alt && polyLength(alt) < polyLength(lane) * 0.8 ? alt : lane;
    }
    return this.roads.route(from, heading, to, opts.roadSnap, opts.goalHeading ?? null);
  }

  // ---------------------------------------------------------------------------------------------
  // Where is the target going

  /**
   * The path a car at (x, z) heading `heading` is likely to take for the next `length` metres: along
   * its lane, straight on through junctions unless `yawRate` (rad/s, positive turns left) says it is
   * turning (then the connector that turns that way). On the freeways and on a tile with no lanes it
   * follows the road centreline, straight on at each node. The first point is the position itself.
   */
  predict(x: number, z: number, heading: number, yawRate: number, length: number): PathPoint[] {
    const g = this.lanes;
    const snap = g ? this.snapLane(x, z, heading, 12) : null;
    if (g && snap) {
      const out: PathPoint[] = [{ x, z }];
      let edge = snap.edge;
      let s = snap.s;
      let left = length;
      for (let guard = 0; guard < 60 && left > 0; guard++) {
        const take = Math.min(left, g.len[edge] - s);
        this.laneSlice(edge, s, s + take, out);
        left -= take;
        if (left <= 0.5) break;
        const next = this.pickOnward(g, edge, yawRate);
        if (next < 0) break;
        edge = next;
        s = 0;
      }
      const dense = densify(out);
      if (polyLength(dense) > 5) return dense;
    }
    return this.roads.follow(x, z, heading, length);
  }

  /** The edge after `edge` for a car that is going straight (or turning, by `yawRate`). */
  private pickOnward(g: LaneGraph, edge: number, yawRate: number): number {
    let best = -1;
    let bestScore = -Infinity;
    for (const n of g.next[edge]) {
      if (!g.main[n]) continue;
      let score = 0;
      if (g.isConnector[n]) {
        const t = g.turn[n];
        const wantLeft = yawRate > 0.12;
        const wantRight = yawRate < -0.12;
        score = t === 0 ? 1 : 0;
        if (wantLeft && t === 1) score = 2;
        else if (wantRight && t === 2) score = 2;
        else if (t === 3) score = -5;
        else if (t !== 0 && !wantLeft && !wantRight) score = 0.2;
      } else score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    // A connector leads on to exactly one lane.
    return best;
  }

  // ---------------------------------------------------------------------------------------------
  // The road under a point

  private junctions: { x: number; z: number }[] | null = null;

  /** Whether a point is within `r` metres of a junction (a node where three or more road ends meet). */
  nearJunction(x: number, z: number, r: number): boolean {
    if (!this.junctions) this.junctions = this.roads.nodes.filter((n) => n.out.length >= 3).map((n) => ({ x: n.x, z: n.z }));
    for (const j of this.junctions) if (Math.abs(j.x - x) < r && Math.abs(j.z - z) < r && Math.hypot(j.x - x, j.z - z) < r) return true;
    return false;
  }

  /** The road centreline nearest (x, z): its width and the direction it runs there, for laying a roadblock across it. Null when none within `maxDist`. */
  roadAt(x: number, z: number, maxDist = 20): { width: number; dx: number; dz: number; x: number; z: number; dist: number; oneway: boolean } | null {
    const snap = this.roads.nearest(x, z);
    if (!snap || snap.dist > maxDist) return null;
    const e = this.roads.edges[snap.edge];
    const at = this.roads.at(snap.edge, snap.s);
    return { width: this.roads.widthOf(snap.edge), dx: at.dx, dz: at.dz, x: snap.x, z: snap.z, dist: snap.dist, oneway: e.oneway };
  }
}
