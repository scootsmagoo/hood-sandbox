/**
 * The walk network as a graph: nodes, edges (with their length and attributes), adjacency, a grid
 * for "what is near here", and A* routing. Pure data and numbers, no physics, so it tests alone.
 */
import type { PathAttr, PathKind, PathsData } from '../../shared/walk';

const CELL = 32;
/** Edge kinds that count as sidewalk for the density of people and where they spawn. */
const SPAWN_KINDS = new Set<PathKind>(['sidewalk', 'synthetic', 'footway', 'pedestrian']);
/** Kinds a car standing on them means a car on the pavement. */
export const PAVEMENT_KINDS = new Set<PathKind>(['sidewalk', 'pedestrian', 'footway']);

export interface EdgeHit {
  edge: number;
  /** Position along the edge, 0 to 1, and the point there. */
  t: number;
  x: number;
  z: number;
  d: number;
}

export const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

export class WalkGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly ea: Int32Array;
  readonly eb: Int32Array;
  readonly len: Float32Array;
  readonly eattr: Int32Array;
  readonly attrs: readonly PathAttr[];
  /** CSR adjacency: the edges at node n are `adjEdges[adjStart[n] .. adjStart[n + 1]]`. */
  readonly adjStart: Int32Array;
  readonly adjEdges: Int32Array;
  /** Edges by the grid cell (32 m) of their midpoint, and the length of spawnable (sidewalk) edge in each cell. */
  readonly cells = new Map<number, number[]>();
  readonly cellLength = new Map<number, number>();
  /** All edges by every cell they touch, for nearest-edge queries. */
  private readonly touch = new Map<number, number[]>();
  readonly totalLength: number;

  constructor(data: PathsData) {
    this.nodeCount = data.nodes.length;
    this.edgeCount = data.edges.length / 3;
    this.attrs = data.attrs;
    this.x = new Float32Array(this.nodeCount);
    this.y = new Float32Array(this.nodeCount);
    this.z = new Float32Array(this.nodeCount);
    data.nodes.forEach((n, i) => {
      this.x[i] = n[0];
      this.y[i] = n[1];
      this.z[i] = n[2];
    });
    const m = this.edgeCount;
    this.ea = new Int32Array(m);
    this.eb = new Int32Array(m);
    this.len = new Float32Array(m);
    this.eattr = new Int32Array(m);
    const deg = new Int32Array(this.nodeCount + 1);
    let total = 0;
    for (let e = 0; e < m; e++) {
      const a = data.edges[e * 3], b = data.edges[e * 3 + 1];
      this.ea[e] = a;
      this.eb[e] = b;
      this.eattr[e] = data.edges[e * 3 + 2];
      this.len[e] = Math.hypot(this.x[b] - this.x[a], this.z[b] - this.z[a]);
      deg[a]++;
      deg[b]++;
      total += this.len[e];
      const mx = (this.x[a] + this.x[b]) / 2, mz = (this.z[a] + this.z[b]) / 2;
      const k = cellKey(Math.floor(mx / CELL), Math.floor(mz / CELL));
      const list = this.cells.get(k);
      if (list) list.push(e); else this.cells.set(k, [e]);
      if (SPAWN_KINDS.has(this.attrs[this.eattr[e]].kind)) this.cellLength.set(k, (this.cellLength.get(k) ?? 0) + this.len[e]);
      const x0 = Math.floor(Math.min(this.x[a], this.x[b]) / CELL), x1 = Math.floor(Math.max(this.x[a], this.x[b]) / CELL);
      const z0 = Math.floor(Math.min(this.z[a], this.z[b]) / CELL), z1 = Math.floor(Math.max(this.z[a], this.z[b]) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const kk = cellKey(cx, cz);
          const l = this.touch.get(kk);
          if (l) l.push(e); else this.touch.set(kk, [e]);
        }
      }
    }
    this.totalLength = total;
    this.adjStart = new Int32Array(this.nodeCount + 1);
    for (let n = 0; n < this.nodeCount; n++) this.adjStart[n + 1] = this.adjStart[n] + deg[n];
    this.adjEdges = new Int32Array(this.adjStart[this.nodeCount]);
    const fill = this.adjStart.slice(0, this.nodeCount);
    for (let e = 0; e < m; e++) {
      this.adjEdges[fill[this.ea[e]]++] = e;
      this.adjEdges[fill[this.eb[e]]++] = e;
    }
  }

  kindOf(edge: number): PathKind {
    return this.attrs[this.eattr[edge]].kind;
  }

  crossingOf(edge: number) {
    return this.attrs[this.eattr[edge]].crossing;
  }

  other(edge: number, node: number): number {
    return this.ea[edge] === node ? this.eb[edge] : this.ea[edge];
  }

  degree(node: number): number {
    return this.adjStart[node + 1] - this.adjStart[node];
  }

  isSpawnEdge(edge: number): boolean {
    return SPAWN_KINDS.has(this.attrs[this.eattr[edge]].kind);
  }

  /** The nearest node within `maxR` metres (or -1). */
  nearestNode(x: number, z: number, maxR = 60): number {
    let best = -1;
    let bd = maxR * maxR;
    const r = Math.ceil(maxR / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        for (const e of this.touch.get(cellKey(ix, iz)) ?? []) {
          for (const n of [this.ea[e], this.eb[e]]) {
            const d = (this.x[n] - x) ** 2 + (this.z[n] - z) ** 2;
            if (d < bd) { bd = d; best = n; }
          }
        }
      }
    }
    return best;
  }

  /** The nearest point on any edge (optionally of certain kinds) within `r` metres. */
  nearestEdge(x: number, z: number, r: number, kinds?: ReadonlySet<PathKind>): EdgeHit | null {
    let best: EdgeHit | null = null;
    const n = Math.ceil(r / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let ix = cx - n; ix <= cx + n; ix++) {
      for (let iz = cz - n; iz <= cz + n; iz++) {
        for (const e of this.touch.get(cellKey(ix, iz)) ?? []) {
          if (kinds && !kinds.has(this.kindOf(e))) continue;
          const ax = this.x[this.ea[e]], az = this.z[this.ea[e]];
          const dx = this.x[this.eb[e]] - ax, dz = this.z[this.eb[e]] - az;
          const l2 = dx * dx + dz * dz;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d <= r && (!best || d < best.d)) best = { edge: e, t, x: px, z: pz, d };
        }
      }
    }
    return best;
  }

  /** Height of an edge at a fraction along it. */
  yAt(edge: number, t: number): number {
    return this.y[this.ea[edge]] + (this.y[this.eb[edge]] - this.y[this.ea[edge]]) * t;
  }

  /**
   * A* over the network. Crossings cost extra (a walker would rather stay on the sidewalk) and steps
   * a little. Returns the nodes from `from` to `to`, or null when `to` cannot be reached within
   * `maxExpand` expansions.
   */
  route(from: number, to: number, maxExpand = 6000): number[] | null {
    if (from === to) return [from];
    const g = new Map<number, number>([[from, 0]]);
    const came = new Map<number, number>();
    const closed = new Set<number>();
    const h = (n: number) => Math.hypot(this.x[n] - this.x[to], this.z[n] - this.z[to]);
    // A binary heap of [f, node].
    const heap: [number, number][] = [[h(from), from]];
    const push = (f: number, n: number) => {
      heap.push([f, n]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    let expanded = 0;
    while (heap.length && expanded < maxExpand) {
      const [, n] = pop();
      if (closed.has(n)) continue;
      if (n === to) {
        const path = [n];
        let c = n;
        while (came.has(c)) { c = came.get(c)!; path.push(c); }
        return path.reverse();
      }
      closed.add(n);
      expanded++;
      const gn = g.get(n)!;
      for (let k = this.adjStart[n]; k < this.adjStart[n + 1]; k++) {
        const e = this.adjEdges[k];
        const m = this.other(e, n);
        if (closed.has(m)) continue;
        const kind = this.kindOf(e);
        const cost = this.len[e] * (kind === 'crossing' ? 1.8 : kind === 'steps' ? 1.2 : 1) + (kind === 'crossing' ? 6 : 0);
        const ng = gn + cost;
        if (ng < (g.get(m) ?? Infinity)) {
          g.set(m, ng);
          came.set(m, n);
          push(ng + h(m), m);
        }
      }
    }
    return null;
  }

  /** The edge joining two nodes, or -1. */
  edgeBetween(a: number, b: number): number {
    for (let k = this.adjStart[a]; k < this.adjStart[a + 1]; k++) {
      const e = this.adjEdges[k];
      if (this.other(e, a) === b) return e;
    }
    return -1;
  }
}
