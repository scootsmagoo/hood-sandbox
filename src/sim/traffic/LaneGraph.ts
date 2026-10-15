/**
 * The runtime lane graph: `lanes.json` unpacked into typed arrays, with the lookups traffic needs
 * (a point along an edge, the nearest point of an edge to a position, where cars can be spawned) and
 * the set of edges that lie in the largest strongly connected component, the only ones cars route
 * over or spawn on. Pure: no physics and no sim.
 */
import type { LaneControl, LanesData } from '../../shared/lanes';
import type { SignalJunction } from '../../shared/signals';

export interface EdgePoint {
  x: number;
  y: number;
  z: number;
  /** unit tangent in xz */
  tx: number;
  tz: number;
}

export const Ctl = { None: 0, Stop: 1, Signals: 2 } as const;
export type Ctl = (typeof Ctl)[keyof typeof Ctl];

const CTL: Record<LaneControl, Ctl> = { none: Ctl.None, stop: Ctl.Stop, signals: Ctl.Signals };

export interface GraphJunction extends SignalJunction {
  index: number;
  control: Ctl;
}

/** Candidate spawn spots, a point every ~20 m along the lanes that cars may use. */
export interface SpawnSpot {
  x: number;
  z: number;
  edge: number;
  s: number;
  /** how much this kind of road counts toward a zone's cars per km */
  weight: number;
}

const SPOT_STEP = 20;
/** How much of a zone's cars per km a kind of road gets: the avenues are busier than the side streets and the freeway is thinner. */
const ROAD_WEIGHT: Record<string, number> = { motorway: 0.3, trunk: 0.5, primary: 1.7, secondary: 1.5, tertiary: 1, unclassified: 0.7, residential: 0.55, road: 0.55 };

export class LaneGraph {
  readonly count: number;
  readonly isConnector: Uint8Array;
  readonly len: Float32Array;
  readonly speed: Float32Array;
  readonly pts: Float32Array[] = [];
  readonly cum: Float32Array[] = [];
  readonly next: Int32Array[] = [];
  readonly left: Int32Array;
  readonly right: Int32Array;
  readonly from: Int32Array;
  readonly to: Int32Array;
  /** 0 straight, 1 left, 2 right, 3 U-turn (connectors) */
  readonly turn: Uint8Array;
  /** index of the junction a lane ends at / a connector lies in, or -1 */
  readonly junction: Int32Array;
  readonly leg: Int32Array;
  readonly ctl: Uint8Array;
  readonly bridge: Uint8Array;
  /** a connector too tight for a car to drive (a U-turn, a turn of under about 4 m radius): cars follow it as spline followers */
  readonly tight: Uint8Array;
  readonly cls: string[];
  /** a lane of a one-way street (the road has no lanes the other way): its left side is a kerb, not the centre line */
  readonly oneWay: Uint8Array;
  /** in the largest strongly connected component */
  readonly main: Uint8Array;
  readonly conflicts: Int32Array[] = [];
  readonly yields: Int32Array[] = [];
  readonly mutual: Int32Array[] = [];
  readonly junctions: GraphJunction[] = [];
  readonly spots: SpawnSpot[] = [];
  private readonly spotCells = new Map<number, number[]>();
  private readonly cell = 64;
  /** edge id -> the junction id string, for events and tests */
  readonly junctionIndex = new Map<string, number>();

  constructor(readonly data: LanesData) {
    const edges = data.edges;
    const n = (this.count = edges.length);
    this.isConnector = new Uint8Array(n);
    this.len = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.left = new Int32Array(n).fill(-1);
    this.right = new Int32Array(n).fill(-1);
    this.from = new Int32Array(n).fill(-1);
    this.to = new Int32Array(n).fill(-1);
    this.turn = new Uint8Array(n);
    this.junction = new Int32Array(n).fill(-1);
    this.leg = new Int32Array(n).fill(-1);
    this.ctl = new Uint8Array(n);
    this.bridge = new Uint8Array(n);
    this.tight = new Uint8Array(n);
    this.cls = new Array<string>(n).fill('');
    this.oneWay = new Uint8Array(n);
    data.junctions.forEach((j, i) => {
      this.junctionIndex.set(j.id, i);
      this.junctions.push({ index: i, id: j.id, control: CTL[j.control], legs: j.legs ?? [] });
    });
    const empty = new Int32Array(0);
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const p = Float32Array.from(e.pts);
      this.pts.push(p);
      const m = p.length / 3;
      const c = new Float32Array(m);
      for (let k = 1; k < m; k++) c[k] = c[k - 1] + Math.hypot(p[k * 3] - p[(k - 1) * 3], p[k * 3 + 2] - p[(k - 1) * 3 + 2]);
      this.cum.push(c);
      this.len[i] = Math.max(0.01, c[m - 1]);
      this.speed[i] = e.v;
      this.next.push(Int32Array.from(e.next));
      this.junction[i] = e.j !== undefined ? (this.junctionIndex.get(e.j) ?? -1) : -1;
      if (e.t === 0) {
        this.left[i] = e.left;
        this.right[i] = e.right;
        this.leg[i] = e.leg ?? -1;
        this.ctl[i] = e.ctl ? CTL[e.ctl] : Ctl.None;
        this.bridge[i] = e.bridge ? 1 : 0;
        this.cls[i] = e.cls;
        this.conflicts.push(empty);
        this.yields.push(empty);
        this.mutual.push(empty);
      } else {
        this.isConnector[i] = 1;
        this.from[i] = e.from;
        this.to[i] = e.to;
        this.turn[i] = e.turn === 's' ? 0 : e.turn === 'l' ? 1 : e.turn === 'r' ? 2 : 3;
        this.leg[i] = e.leg;
        this.ctl[i] = CTL[e.ctl];
        this.conflicts.push(Int32Array.from(e.c));
        this.yields.push(Int32Array.from(e.y));
        this.mutual.push(Int32Array.from(e.m));
      }
    }
    // one-way: no lane of the same road runs the other way
    const ways = new Set<string>();
    for (const e of edges) if (e.t === 0) ways.add(`${e.road}|${e.dir}`);
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (e.t === 0 && !ways.has(`${e.road}|${-e.dir}`)) this.oneWay[i] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (!this.isConnector[i] || this.turn[i] === 0) continue;
      if (this.turn[i] === 3) {
        this.tight[i] = 1;
        continue;
      }
      // radius of the turn: its length over the angle it turns through (from the lanes it joins)
      const a = this.pts[this.from[i]];
      const b = this.pts[this.to[i]];
      const m = a.length;
      const t1x = a[m - 3] - a[m - 6];
      const t1z = a[m - 1] - a[m - 4];
      const t2x = b[3] - b[0];
      const t2z = b[5] - b[2];
      const ang = Math.abs(Math.atan2(t1x * t2z - t1z * t2x, t1x * t2x + t1z * t2z));
      if (ang > 0.7 && this.len[i] / ang < 4.2) this.tight[i] = 1;
    }
    this.main = new Uint8Array(n);
    this.markMainComponent();
    this.buildSpots();
  }

  /** Tarjan (iterative); marks the edges of the component with the most lane length. */
  private markMainComponent() {
    const n = this.count;
    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const comp = new Int32Array(n).fill(-1);
    const it = new Int32Array(n);
    const stack: number[] = [];
    let idx = 0;
    let nc = 0;
    for (let root = 0; root < n; root++) {
      if (index[root] >= 0) continue;
      const call = [root];
      index[root] = low[root] = idx++;
      stack.push(root);
      onStack[root] = 1;
      while (call.length) {
        const v = call[call.length - 1];
        const nx = this.next[v];
        if (it[v] < nx.length) {
          const w = nx[it[v]++];
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
    const size = new Float64Array(nc);
    for (let i = 0; i < n; i++) if (!this.isConnector[i]) size[comp[i]] += this.len[i];
    let best = 0;
    for (let c = 1; c < nc; c++) if (size[c] > size[best]) best = c;
    for (let i = 0; i < n; i++) this.main[i] = comp[i] === best ? 1 : 0;
  }

  private buildSpots() {
    for (let e = 0; e < this.count; e++) {
      if (this.isConnector[e] || !this.main[e] || this.len[e] < 24) continue;
      const cls = this.cls[e];
      const weight = ROAD_WEIGHT[cls.replace(/_link$/, '')] ?? 1;
      const w = /^(motorway|trunk)$/.test(cls) ? weight : /_link$/.test(cls) ? weight * 0.6 : weight;
      const out = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
      for (let s = 10; s < this.len[e] - 10; s += SPOT_STEP) {
        this.posAt(e, s, out);
        const id = this.spots.length;
        this.spots.push({ x: out.x, z: out.z, edge: e, s, weight: w });
        const k = this.cellKey(out.x, out.z);
        const a = this.spotCells.get(k);
        if (a) a.push(id);
        else this.spotCells.set(k, [id]);
      }
    }
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / this.cell) + 512) * 1024 + (Math.floor(z / this.cell) + 512);
  }

  /** Spawn spots whose distance to (x, z) lies in [min, max]. */
  spotsAround(x: number, z: number, min: number, max: number, out: SpawnSpot[]): SpawnSpot[] {
    out.length = 0;
    const r = Math.ceil(max / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const lo = min * min;
    const hi = max * max;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const a = this.spotCells.get((cx + i + 512) * 1024 + (cz + j + 512));
        if (!a) continue;
        for (const id of a) {
          const sp = this.spots[id];
          const d = (sp.x - x) ** 2 + (sp.z - z) ** 2;
          if (d >= lo && d <= hi) out.push(sp);
        }
      }
    }
    return out;
  }

  /** The point at distance `s` along an edge. */
  posAt(edge: number, s: number, out: EdgePoint): EdgePoint {
    const p = this.pts[edge];
    const c = this.cum[edge];
    const m = c.length;
    const t = s < 0 ? 0 : s > c[m - 1] ? c[m - 1] : s;
    let lo = 1;
    let hi = m - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const a = (i - 1) * 3;
    const b = i * 3;
    const seg = c[i] - c[i - 1] || 1;
    const u = (t - c[i - 1]) / seg;
    const dx = p[b] - p[a];
    const dz = p[b + 2] - p[a + 2];
    const l = Math.hypot(dx, dz) || 1;
    out.x = p[a] + dx * u;
    out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * u;
    out.z = p[a + 2] + dz * u;
    out.tx = dx / l;
    out.tz = dz / l;
    return out;
  }

  /**
   * Where along an edge (x, z) is nearest, searching only from `hint - back` to `hint + ahead` metres.
   * Returns the distance along, and the distance from the edge.
   */
  project(edge: number, x: number, z: number, hint: number, back: number, ahead: number, out: { s: number; dist: number }): { s: number; dist: number } {
    const p = this.pts[edge];
    const c = this.cum[edge];
    const m = c.length;
    const lo = hint - back;
    const hi = hint + ahead;
    let bestD = Infinity;
    let bestS = hint;
    for (let i = 1; i < m; i++) {
      if (c[i] < lo) continue;
      if (c[i - 1] > hi) break;
      const ax = p[(i - 1) * 3];
      const az = p[(i - 1) * 3 + 2];
      const dx = p[i * 3] - ax;
      const dz = p[i * 3 + 2] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < bestD) {
        bestD = d;
        bestS = c[i - 1] + t * (c[i] - c[i - 1]);
      }
    }
    out.s = bestS;
    out.dist = bestD;
    return out;
  }

  /** The nearest lane edge (in the main component) to a position, for putting a car back on the graph. */
  nearestLane(x: number, z: number, maxDist: number): { edge: number; s: number; dist: number } | null {
    let best: { edge: number; s: number; dist: number } | null = null;
    const tmp = { s: 0, dist: 0 };
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const seen = new Set<number>();
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const a = this.spotCells.get((cx + i + 512) * 1024 + (cz + j + 512));
        if (!a) continue;
        for (const id of a) {
          const e = this.spots[id].edge;
          if (seen.has(e)) continue;
          seen.add(e);
          this.project(e, x, z, this.spots[id].s, 40, 40, tmp);
          if (tmp.dist < (best?.dist ?? maxDist)) best = { edge: e, s: tmp.s, dist: tmp.dist };
        }
      }
    }
    return best;
  }

  /** Whether any edge of the graph is usable (a tile with a lane graph but no component is not). */
  get usable(): boolean {
    return this.spots.length > 0;
  }
}
