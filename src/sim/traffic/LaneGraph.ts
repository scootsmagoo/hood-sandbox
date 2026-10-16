/**
 * The runtime lane graph: `lanes.json` unpacked into typed arrays, with the lookups traffic needs
 * (a point along an edge, the nearest point of an edge to a position, where cars can be spawned) and
 * the set of edges that lie in the largest strongly connected component, the only ones cars route
 * over or spawn on. Pure: no physics and no sim.
 *
 * A streamed city (docs/contracts/city-tiles.md) adds and drops tiles: each tile's edges take a range of
 * global ids that does not move while the tile is loaded (`addTile`, `removeTile`), the lanes that leave a
 * tile across a seam are joined to the lanes that enter its neighbour (`stitch`), and the main component is
 * recomputed over everything loaded (`mainJob`, resumable so it can be spread over ticks). A dropped tile's
 * edges are dead (`alive` 0, no `next`, out of the main component) until the range is reused.
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

/** First-fit ranges of ids: freed ranges are reused, so the ids of what stays never move. Deterministic for a given sequence. */
export class RangeAlloc {
  private free: { start: number; len: number }[] = [];
  high = 0;

  alloc(n: number): number {
    if (n <= 0) return this.high;
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f.len < n) continue;
      const start = f.start;
      f.start += n;
      f.len -= n;
      if (f.len === 0) this.free.splice(i, 1);
      return start;
    }
    const start = this.high;
    this.high += n;
    return start;
  }

  release(start: number, n: number) {
    if (n <= 0) return;
    this.free.push({ start, len: n });
    this.free.sort((a, b) => a.start - b.start);
    // merge neighbours, and give the tail back to `high`
    const out: { start: number; len: number }[] = [];
    for (const f of this.free) {
      const last = out[out.length - 1];
      if (last && last.start + last.len === f.start) last.len += f.len;
      else out.push({ ...f });
    }
    const tail = out[out.length - 1];
    if (tail && tail.start + tail.len === this.high) {
      this.high = tail.start;
      out.pop();
    }
    this.free = out;
  }
}

/** A tile's place in the graph. */
export interface LaneTileRange {
  key: string;
  base: number;
  n: number;
  jBase: number;
  jn: number;
  /** The namespace of its junction ids (`<ns>/<id>`), empty for a single-tile world. */
  ns: string;
}

const EMPTY = new Int32Array(0);

export class LaneGraph {
  /** High-water mark of edge ids (dead edges included). */
  count = 0;
  isConnector = new Uint8Array(0);
  len = new Float32Array(0);
  speed = new Float32Array(0);
  readonly pts: Float32Array[] = [];
  readonly cum: Float32Array[] = [];
  readonly next: Int32Array[] = [];
  left = new Int32Array(0);
  right = new Int32Array(0);
  from = new Int32Array(0);
  to = new Int32Array(0);
  /** 0 straight, 1 left, 2 right, 3 U-turn (connectors) */
  turn = new Uint8Array(0);
  /** index of the junction a lane ends at / a connector lies in, or -1 */
  junction = new Int32Array(0);
  leg = new Int32Array(0);
  ctl = new Uint8Array(0);
  bridge = new Uint8Array(0);
  /** a connector too tight for a car to drive (a U-turn, a turn of under about 4 m radius): cars follow it as spline followers */
  tight = new Uint8Array(0);
  readonly cls: string[] = [];
  /** a lane of a one-way street (the road has no lanes the other way): its left side is a kerb, not the centre line */
  oneWay = new Uint8Array(0);
  /** in the largest strongly connected component */
  main = new Uint8Array(0);
  /** a live edge (of a loaded tile) */
  alive = new Uint8Array(0);
  readonly conflicts: Int32Array[] = [];
  readonly yields: Int32Array[] = [];
  readonly mutual: Int32Array[] = [];
  readonly junctions: GraphJunction[] = [];
  readonly spots: SpawnSpot[] = [];
  private readonly spotCells = new Map<number, number[]>();
  /** spot ids by edge, so a tile's spots can be taken out */
  private readonly spotsOfEdge = new Map<number, number[]>();
  private readonly freeSpots: number[] = [];
  private readonly cell = 64;
  /** junction id -> index */
  readonly junctionIndex = new Map<string, number>();
  /** The road id of each lane (connectors: ''), for the seams and tests. */
  readonly road: string[] = [];
  /** Lane direction along its road (+1, -1) and lane number, for the seams. */
  ldir = new Int8Array(0);
  lk = new Uint8Array(0);
  private readonly edgeAlloc = new RangeAlloc();
  private readonly junctionAlloc = new RangeAlloc();
  readonly tiles = new Map<string, LaneTileRange>();
  /** Stitched seams: a lane that leaves a tile -> its own `next` before it was joined to the neighbour's lane. */
  private readonly stitched = new Map<number, Int32Array>();
  /** Bumped on every change of topology (add, remove, stitch): a running main-component job restarts when it sees a change. */
  topology = 0;
  /** Bumped when `main` (and the spawn spots) change. */
  mainVersion = 0;

  /**
   * A single-tile graph (the M1 tile, the tests): everything at once, as before. `stream`: an empty graph that tiles are added to
   * (`data` is then only a placeholder).
   */
  constructor(
    readonly data: LanesData,
    stream = false,
  ) {
    if (stream) return;
    this.addTile('', data, '');
    this.markMainComponent();
  }

  /** An empty graph for a streamed city. */
  static streaming(): LaneGraph {
    return new LaneGraph({ format: 'hood-lanes', version: 1, edges: [], junctions: [] }, true);
  }

  private grow(n: number) {
    if (n <= this.isConnector.length) {
      this.count = Math.max(this.count, n);
      return;
    }
    const cap = Math.max(n, Math.ceil(this.isConnector.length * 1.5), 64);
    const g = <T extends Uint8Array | Int8Array | Float32Array | Int32Array>(a: T, fill?: number): T => {
      const b = new (a.constructor as new (n: number) => T)(cap);
      b.set(a);
      if (fill !== undefined) b.fill(fill, a.length);
      return b;
    };
    this.isConnector = g(this.isConnector);
    this.len = g(this.len);
    this.speed = g(this.speed);
    this.left = g(this.left, -1);
    this.right = g(this.right, -1);
    this.from = g(this.from, -1);
    this.to = g(this.to, -1);
    this.turn = g(this.turn);
    this.junction = g(this.junction, -1);
    this.leg = g(this.leg, -1);
    this.ctl = g(this.ctl);
    this.bridge = g(this.bridge);
    this.tight = g(this.tight);
    this.oneWay = g(this.oneWay);
    this.main = g(this.main);
    this.alive = g(this.alive);
    this.ldir = g(this.ldir);
    this.lk = g(this.lk);
    while (this.pts.length < cap) {
      this.pts.push(new Float32Array(6));
      this.cum.push(new Float32Array(2));
      this.next.push(EMPTY);
      this.conflicts.push(EMPTY);
      this.yields.push(EMPTY);
      this.mutual.push(EMPTY);
      this.cls.push('');
      this.road.push('');
    }
    this.count = Math.max(this.count, n);
  }

  /** Adds a tile's lanes; its edges take ids `base .. base + n - 1`, its junction ids are `<ns>/<id>` (or `<id>` with no ns). */
  addTile(key: string, data: LanesData, ns: string): LaneTileRange {
    if (this.tiles.has(key)) throw new Error(`lane graph: tile ${key} is already loaded`);
    const edges = data.edges;
    const n = edges.length;
    const base = this.edgeAlloc.alloc(n);
    const jn = data.junctions.length;
    const jBase = this.junctionAlloc.alloc(jn);
    this.grow(base + n);
    const local = new Map<string, number>();
    data.junctions.forEach((j, i) => {
      const idx = jBase + i;
      const id = ns ? `${ns}/${j.id}` : j.id;
      local.set(j.id, idx);
      this.junctionIndex.set(id, idx);
      this.junctions[idx] = { index: idx, id, control: CTL[j.control], legs: j.legs ?? [] };
    });
    const off = (v: number) => (v >= 0 ? v + base : -1);
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const gi = base + i;
      const p = Float32Array.from(e.pts);
      this.pts[gi] = p;
      const m = p.length / 3;
      const c = new Float32Array(m);
      for (let k = 1; k < m; k++) c[k] = c[k - 1] + Math.hypot(p[k * 3] - p[(k - 1) * 3], p[k * 3 + 2] - p[(k - 1) * 3 + 2]);
      this.cum[gi] = c;
      this.len[gi] = Math.max(0.01, c[m - 1]);
      this.speed[gi] = e.v;
      this.next[gi] = Int32Array.from(e.next, off);
      this.junction[gi] = e.j !== undefined ? (local.get(e.j) ?? -1) : -1;
      this.alive[gi] = 1;
      this.main[gi] = 0;
      this.tight[gi] = 0;
      this.oneWay[gi] = 0;
      if (e.t === 0) {
        this.isConnector[gi] = 0;
        this.left[gi] = off(e.left);
        this.right[gi] = off(e.right);
        this.from[gi] = -1;
        this.to[gi] = -1;
        this.turn[gi] = 0;
        this.leg[gi] = e.leg ?? -1;
        this.ctl[gi] = e.ctl ? CTL[e.ctl] : Ctl.None;
        this.bridge[gi] = e.bridge ? 1 : 0;
        this.cls[gi] = e.cls;
        this.road[gi] = e.road;
        this.ldir[gi] = e.dir;
        this.lk[gi] = e.k;
        this.conflicts[gi] = EMPTY;
        this.yields[gi] = EMPTY;
        this.mutual[gi] = EMPTY;
      } else {
        this.isConnector[gi] = 1;
        this.left[gi] = -1;
        this.right[gi] = -1;
        this.from[gi] = e.from + base;
        this.to[gi] = e.to + base;
        this.turn[gi] = e.turn === 's' ? 0 : e.turn === 'l' ? 1 : e.turn === 'r' ? 2 : 3;
        this.leg[gi] = e.leg;
        this.ctl[gi] = CTL[e.ctl];
        this.bridge[gi] = 0;
        this.cls[gi] = '';
        this.road[gi] = '';
        this.ldir[gi] = 0;
        this.lk[gi] = 0;
        this.conflicts[gi] = Int32Array.from(e.c, off);
        this.yields[gi] = Int32Array.from(e.y, off);
        this.mutual[gi] = Int32Array.from(e.m, off);
      }
    }
    // one-way: no lane of the same road runs the other way (within the tile: a road cut by a seam is in both, both ways)
    const ways = new Set<string>();
    for (const e of edges) if (e.t === 0) ways.add(`${e.road}|${e.dir}`);
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (e.t === 0 && !ways.has(`${e.road}|${-e.dir}`)) this.oneWay[base + i] = 1;
    }
    for (let i = base; i < base + n; i++) {
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
    const range: LaneTileRange = { key, base, n, jBase, jn, ns };
    this.tiles.set(key, range);
    this.topology++;
    return range;
  }

  /** Drops a tile: its edges die (no `next`, out of the main component, no spawn spots), and seams into it are undone. */
  removeTile(key: string): LaneTileRange | null {
    const r = this.tiles.get(key);
    if (!r) return null;
    const inRange = (e: number) => e >= r.base && e < r.base + r.n;
    // seams: lanes elsewhere that lead into the tile go back to what they had; the tile's own stitched lanes are forgotten
    for (const out of [...this.stitched.keys()]) {
      if (inRange(out)) this.stitched.delete(out);
      else if (Array.from(this.next[out]).some(inRange)) this.unstitch(out);
    }
    for (let e = r.base; e < r.base + r.n; e++) {
      this.alive[e] = 0;
      this.main[e] = 0;
      this.next[e] = EMPTY;
      this.conflicts[e] = EMPTY;
      this.yields[e] = EMPTY;
      this.mutual[e] = EMPTY;
      this.left[e] = this.right[e] = this.from[e] = this.to[e] = -1;
      this.junction[e] = -1;
      this.removeSpotsOf(e);
    }
    for (let j = r.jBase; j < r.jBase + r.jn; j++) {
      const jn = this.junctions[j];
      if (jn && this.junctionIndex.get(jn.id) === j) this.junctionIndex.delete(jn.id);
      this.junctions[j] = { index: j, id: '', control: Ctl.None, legs: [] };
    }
    this.edgeAlloc.release(r.base, r.n);
    this.junctionAlloc.release(r.jBase, r.jn);
    this.tiles.delete(key);
    this.topology++;
    this.mainVersion++;
    return r;
  }

  /**
   * Joins a lane that ends on a seam to the lane that starts there in the neighbouring tile: its `next` becomes that lane (its own
   * turnaround, which the bake makes where a two-way road leaves a tile, is set aside until the seam is undone).
   */
  stitch(out: number, into: number) {
    if (!this.alive[out] || !this.alive[into]) return;
    if (!this.stitched.has(out)) this.stitched.set(out, this.next[out]);
    this.next[out] = Int32Array.of(into);
    this.topology++;
  }

  /** Undoes `stitch`: the lane gets its own `next` back. */
  unstitch(out: number) {
    const orig = this.stitched.get(out);
    if (!orig) return;
    this.stitched.delete(out);
    if (this.alive[out]) this.next[out] = orig;
    this.topology++;
  }

  /** The lanes joined across seams (out lane -> the lane it continues into). */
  seamLinks(): [number, number][] {
    return [...this.stitched.keys()].map((e) => [e, this.next[e][0]] as [number, number]);
  }

  /** Tarjan (iterative), at once; marks the edges of the component with the most lane length. */
  markMainComponent() {
    const job = this.mainJob();
    while (!job.step(Infinity));
  }

  /**
   * The main-component computation as a job that runs `budget` edge visits at a time (`step` returns true when it is done and
   * `main` and the spawn spots are updated). A change of topology while it runs makes it start over. Deterministic.
   */
  mainJob(): { step(budget: number): boolean } {
    let n = 0;
    let index!: Int32Array, low!: Int32Array, onStack!: Uint8Array, comp!: Int32Array, it!: Int32Array;
    let stack: number[] = [];
    let call: number[] = [];
    let idx = 0;
    let nc = 0;
    let root = 0;
    let topo = -1;
    let done = false;
    const start = () => {
      n = this.count;
      index = new Int32Array(n).fill(-1);
      low = new Int32Array(n);
      onStack = new Uint8Array(n);
      comp = new Int32Array(n).fill(-1);
      it = new Int32Array(n);
      stack = [];
      call = [];
      idx = 0;
      nc = 0;
      root = 0;
      topo = this.topology;
    };
    return {
      step: (budget: number) => {
        if (done) return true;
        if (topo !== this.topology) start();
        let work = 0;
        while (work < budget) {
          if (call.length === 0) {
            while (root < n && (index[root] >= 0 || !this.alive[root])) root++;
            if (root >= n) {
              this.applyMain(comp, nc, n);
              done = true;
              return true;
            }
            index[root] = low[root] = idx++;
            stack.push(root);
            onStack[root] = 1;
            call.push(root);
          }
          const v = call[call.length - 1];
          const nx = this.next[v];
          work++;
          if (it[v] < nx.length) {
            const w = nx[it[v]++];
            if (w >= n || !this.alive[w]) continue;
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
        return false;
      },
    };
  }

  private applyMain(comp: Int32Array, nc: number, n: number) {
    const size = new Float64Array(Math.max(1, nc));
    for (let i = 0; i < n; i++) if (this.alive[i] && !this.isConnector[i] && comp[i] >= 0) size[comp[i]] += this.len[i];
    let best = 0;
    for (let c = 1; c < nc; c++) if (size[c] > size[best]) best = c;
    for (let i = 0; i < this.count; i++) {
      const m = i < n && this.alive[i] && comp[i] === best && nc > 0 ? 1 : 0;
      if (m !== this.main[i]) {
        this.main[i] = m;
        this.removeSpotsOf(i);
        if (m) this.addSpotsOf(i);
      } else if (m && !this.spotsOfEdge.has(i)) this.addSpotsOf(i);
    }
    this.mainVersion++;
  }

  private addSpotsOf(e: number) {
    if (this.isConnector[e] || !this.main[e] || this.len[e] < 24) return;
    const cls = this.cls[e];
    const weight = ROAD_WEIGHT[cls.replace(/_link$/, '')] ?? 1;
    const w = /^(motorway|trunk)$/.test(cls) ? weight : /_link$/.test(cls) ? weight * 0.6 : weight;
    const out = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    const ids: number[] = [];
    for (let s = 10; s < this.len[e] - 10; s += SPOT_STEP) {
      this.posAt(e, s, out);
      const spot = { x: out.x, z: out.z, edge: e, s, weight: w };
      const id = this.freeSpots.length ? this.freeSpots.pop()! : this.spots.length;
      this.spots[id] = spot;
      ids.push(id);
      const k = this.cellKey(out.x, out.z);
      const a = this.spotCells.get(k);
      if (a) a.push(id);
      else this.spotCells.set(k, [id]);
    }
    if (ids.length) this.spotsOfEdge.set(e, ids);
  }

  private removeSpotsOf(e: number) {
    const ids = this.spotsOfEdge.get(e);
    if (!ids) return;
    this.spotsOfEdge.delete(e);
    for (const id of ids) {
      const sp = this.spots[id];
      const k = this.cellKey(sp.x, sp.z);
      const a = this.spotCells.get(k);
      if (a) {
        const i = a.indexOf(id);
        if (i >= 0) a.splice(i, 1);
        if (a.length === 0) this.spotCells.delete(k);
      }
      this.spots[id] = { x: NaN, z: NaN, edge: -1, s: 0, weight: 0 };
      this.freeSpots.push(id);
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
    return this.spotCells.size > 0;
  }

  /** The tile range an edge belongs to, or null (a dead edge). */
  tileOf(e: number): LaneTileRange | null {
    for (const r of this.tiles.values()) if (e >= r.base && e < r.base + r.n) return r;
    return null;
  }
}
