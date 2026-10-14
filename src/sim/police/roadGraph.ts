/**
 * The drivable road network as a graph, for police routing: nodes are the ends of `roads.json`
 * centrelines (the bake splits ways at junctions), edges are the ways, one-way ones directed. Streets
 * a car cannot use are left out: service roads and alleys, bridges the ground mesh does not carry,
 * and ways steeper than a car can climb (a trench draped by the ground mesh).
 *
 * Pure: no physics, no sim. `route` is A* over nodes with the partial first and last edges spliced in.
 */
import type { RoadData } from '../../shared/tile';
import type { Rng } from '../../shared/rng';

export interface PathPoint {
  x: number;
  z: number;
}

interface Node {
  x: number;
  z: number;
  out: number[];
}

interface Edge {
  id: number;
  from: number;
  to: number;
  pts: PathPoint[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
  oneway: boolean;
  cls: string;
}

export interface Snap {
  edge: number;
  /** Distance along the edge from its start, m. */
  s: number;
  x: number;
  z: number;
  dist: number;
}

export interface SamplePoint extends PathPoint {
  edge: number;
  s: number;
  /** Unit direction of the edge there. */
  dx: number;
  dz: number;
}

const SKIP_CLASSES = new Set(['service', 'busway', 'living_street', 'track', 'path', 'footway']);
const MAX_GRADE = 0.18;

export class RoadGraph {
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  private readonly nodeKey = new Map<string, number>();
  private samples: SamplePoint[] | null = null;

  constructor(roads: readonly RoadData[]) {
    for (const r of roads) {
      if (SKIP_CLASSES.has(r.class) || r.bridge || r.points.length < 2) continue;
      let steep = false;
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
        if (run > 2 && Math.abs(b[1] - a[1]) / run > MAX_GRADE) steep = true;
      }
      if (steep) continue;
      const pts = r.points.map((p) => ({ x: p[0], z: p[2] }));
      const a = this.node(pts[0].x, pts[0].z);
      const b = this.node(pts[pts.length - 1].x, pts[pts.length - 1].z);
      if (a === b) continue;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const id = this.edges.length;
      this.edges.push({ id, from: a, to: b, pts, cum, length: cum[cum.length - 1], oneway: r.oneway, cls: r.class });
      this.nodes[a].out.push(id);
      this.nodes[b].out.push(id);
    }
  }

  get empty(): boolean {
    return this.edges.length === 0;
  }

  private node(x: number, z: number): number {
    const k = `${Math.round(x * 2)},${Math.round(z * 2)}`;
    let i = this.nodeKey.get(k);
    if (i === undefined) {
      i = this.nodes.length;
      this.nodes.push({ x, z, out: [] });
      this.nodeKey.set(k, i);
    }
    return i;
  }

  /** Whether an edge may be driven from node `from` in the direction it leaves. */
  private canLeave(e: Edge, fromNode: number): boolean {
    return e.oneway ? e.from === fromNode : true;
  }

  /** The point on an edge at distance `s`. */
  at(edge: number, s: number): PathPoint & { dx: number; dz: number } {
    const e = this.edges[edge];
    const t = Math.max(0, Math.min(e.length, s));
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < t) i++;
    const a = e.pts[i - 1];
    const b = e.pts[i];
    const seg = e.cum[i] - e.cum[i - 1] || 1;
    const u = (t - e.cum[i - 1]) / seg;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: a.x + dx * u, z: a.z + dz * u, dx: dx / l, dz: dz / l };
  }

  /** The nearest point on any edge. */
  nearest(x: number, z: number, accept?: (e: Edge) => boolean): Snap | null {
    let best: Snap | null = null;
    for (const e of this.edges) {
      if (accept && !accept(e)) continue;
      for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1];
        const b = e.pts[i];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const d = Math.hypot(px - x, pz - z);
        if (!best || d < best.dist) best = { edge: e.id, s: e.cum[i - 1] + t * (e.cum[i] - e.cum[i - 1]), x: px, z: pz, dist: d };
      }
    }
    return best;
  }

  /** Points along every edge every `step` metres, in a fixed order (cached). */
  allSamples(step = 15): SamplePoint[] {
    if (this.samples) return this.samples;
    const out: SamplePoint[] = [];
    for (const e of this.edges) {
      for (let s = step / 2; s < e.length; s += step) {
        const p = this.at(e.id, s);
        out.push({ x: p.x, z: p.z, edge: e.id, s, dx: p.dx, dz: p.dz });
      }
    }
    return (this.samples = out);
  }

  /**
   * A road point between `min` and `max` metres from (x, z) that `accept` allows, chosen with the
   * rng from up to `tries` candidates. The same rng state gives the same point.
   */
  pickAround(rng: Rng, x: number, z: number, min: number, max: number, accept: (p: SamplePoint) => boolean, tries = 24): SamplePoint | null {
    const all = this.allSamples();
    const ring: SamplePoint[] = [];
    for (const p of all) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d >= min && d <= max) ring.push(p);
    }
    for (let i = 0; i < tries && ring.length > 0; i++) {
      const k = rng.int(0, ring.length - 1);
      const p = ring[k];
      if (accept(p)) return p;
      ring[k] = ring[ring.length - 1];
      ring.pop();
    }
    return null;
  }

  /**
   * A route from a position and heading to a target position, as a dense polyline (a point every
   * ~2.5 m). The first leg follows the street the start snaps to in the direction of `heading`
   * (bidirectional streets may be taken either way, with a penalty for turning round).
   * Null when the two are not connected.
   */
  route(from: PathPoint, heading: number, to: PathPoint, startSnap?: Snap | null): PathPoint[] | null {
    const s0 = startSnap ?? this.nearest(from.x, from.z);
    const g0 = this.nearest(to.x, to.z);
    if (!s0 || !g0) return null;
    const se = this.edges[s0.edge];
    const ge = this.edges[g0.edge];
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const here = this.at(s0.edge, s0.s);
    const along = here.dx * fx + here.dz * fz; // > 0: the car points the way the edge runs

    // Seeds: leave the start edge through either end.
    const dist = new Map<number, number>();
    const prev = new Map<number, { node: number; edge: number } | null>();
    const open: { n: number; f: number; g: number }[] = [];
    const push = (n: number, g: number, p: { node: number; edge: number } | null) => {
      if (g >= (dist.get(n) ?? Infinity)) return;
      dist.set(n, g);
      prev.set(n, p);
      const node = this.nodes[n];
      open.push({ n, g, f: g + Math.hypot(node.x - to.x, node.z - to.z) });
    };
    const UTURN = 40;
    push(se.to, se.length - s0.s + (!se.oneway && along < 0 ? UTURN : 0), null);
    if (!se.oneway) push(se.from, s0.s + (along > 0 ? UTURN : 0), null);

    // Straight along the same edge, when the goal is ahead (or the street runs both ways).
    let direct: PathPoint[] | null = null;
    if (g0.edge === s0.edge && (g0.s >= s0.s || !se.oneway)) direct = this.slice(s0.edge, s0.s, g0.s);

    const goalNodes = new Map<number, number>(); // node -> extra length to the goal point
    if (!ge.oneway) {
      goalNodes.set(ge.from, g0.s);
      goalNodes.set(ge.to, ge.length - g0.s);
    } else {
      goalNodes.set(ge.from, g0.s); // one-way: enter at the start only
    }

    let bestNode = -1;
    let bestCost = Infinity;
    const closed = new Set<number>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (closed.has(cur.n)) continue;
      closed.add(cur.n);
      const extra = goalNodes.get(cur.n);
      if (extra !== undefined && cur.g + extra < bestCost) {
        bestCost = cur.g + extra;
        bestNode = cur.n;
      }
      if (cur.f >= bestCost) break;
      for (const ei of this.nodes[cur.n].out) {
        const e = this.edges[ei];
        if (!this.canLeave(e, cur.n)) continue;
        const other = e.from === cur.n ? e.to : e.from;
        push(other, cur.g + e.length, { node: cur.n, edge: ei });
      }
    }
    if (bestNode < 0) return direct ? densify([{ x: from.x, z: from.z }, ...direct]) : null;

    // Rebuild: goal edge tail, middle edges, start edge head.
    const mid: { edge: number; fromNode: number }[] = [];
    let n = bestNode;
    for (;;) {
      const p = prev.get(n);
      if (!p) break;
      mid.push({ edge: p.edge, fromNode: p.node });
      n = p.node;
    }
    mid.reverse();
    const startNode = n;
    const out: PathPoint[] = [{ x: from.x, z: from.z }];
    out.push(...this.slice(s0.edge, s0.s, startNode === se.to ? se.length : 0));
    for (const m of mid) {
      const e = this.edges[m.edge];
      out.push(...(m.fromNode === e.from ? e.pts : [...e.pts].reverse()));
    }
    out.push(...this.slice(g0.edge, bestNode === ge.from ? 0 : ge.length, g0.s));
    if (direct && polyLength(direct) <= polyLength(out)) return densify([{ x: from.x, z: from.z }, ...direct]);
    return densify(out);
  }

  /** The points of an edge between two distances along it (either order), starting at `a`. */
  private slice(edge: number, a: number, b: number): PathPoint[] {
    const e = this.edges[edge];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const pts: PathPoint[] = [];
    const p0 = this.at(edge, lo);
    pts.push({ x: p0.x, z: p0.z });
    for (let i = 0; i < e.pts.length; i++) if (e.cum[i] > lo && e.cum[i] < hi) pts.push(e.pts[i]);
    const p1 = this.at(edge, hi);
    pts.push({ x: p1.x, z: p1.z });
    return a <= b ? pts : pts.reverse();
  }
}

export function polyLength(pts: readonly PathPoint[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

/** Resamples a polyline so no gap exceeds `step` metres and drops duplicates. */
export function densify(pts: readonly PathPoint[], step = 2.5): PathPoint[] {
  const out: PathPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const last = out[out.length - 1];
    if (!last) {
      out.push({ x: p.x, z: p.z });
      continue;
    }
    const d = Math.hypot(p.x - last.x, p.z - last.z);
    if (d < 0.05) continue;
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push({ x: last.x + ((p.x - last.x) * k) / n, z: last.z + ((p.z - last.z) * k) / n });
  }
  return out;
}
