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

/** A binary min-heap of [key, node] pairs, for the searches over the network. */
class MinHeap {
  private readonly a: [number, number][] = [];

  get size(): number {
    return this.a.length;
  }

  push(f: number, n: number) {
    const heap = this.a;
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }

  pop(): [number, number] {
    const heap = this.a;
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
  }
}

/** A tile's place in the walk graph. */
export interface WalkTileRange {
  key: string;
  nodeBase: number;
  nodes: number;
  edgeBase: number;
  edges: number;
  attrBase: number;
  attrs: number;
}

const NO_EDGES = new Int32Array(0);

/** First-fit id ranges (the same as the lane graph's): what stays keeps its ids. */
class Ranges {
  private free: { start: number; len: number }[] = [];
  high = 0;
  alloc(n: number): number {
    if (n <= 0) return this.high;
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f.len < n) continue;
      const st = f.start;
      f.start += n;
      f.len -= n;
      if (f.len === 0) this.free.splice(i, 1);
      return st;
    }
    const st = this.high;
    this.high += n;
    return st;
  }
  release(start: number, n: number) {
    if (n <= 0) return;
    this.free.push({ start, len: n });
    this.free.sort((a, b) => a.start - b.start);
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

/**
 * The walk network as a graph. A single tile (`new WalkGraph(paths)`) is the whole network; a streamed city
 * (docs/contracts/city-tiles.md) starts empty (`WalkGraph.streaming()`) and adds and drops tiles, each in a range of node, edge
 * and attribute ids that does not move while it is loaded, with zero-length `link` edges across the seams (`stitch`).
 */
export class WalkGraph {
  /** High-water marks of node and edge ids (dead ones included). */
  nodeCount = 0;
  edgeCount = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  z = new Float32Array(0);
  ea = new Int32Array(0);
  eb = new Int32Array(0);
  len = new Float32Array(0);
  eattr = new Int32Array(0);
  /** a live edge (of a loaded tile, or a seam link) */
  alive = new Uint8Array(0);
  readonly attrs: PathAttr[] = [];
  /** The edges at each node. */
  readonly adj: Int32Array[] = [];
  /** Edges by the grid cell (32 m) of their midpoint, and the length of spawnable (sidewalk) edge in each cell. */
  readonly cells = new Map<number, number[]>();
  readonly cellLength = new Map<number, number>();
  /** All edges by every cell they touch, for nearest-edge queries. */
  private readonly touch = new Map<number, number[]>();
  totalLength = 0;
  /**
   * An edge a person can really walk (the walkers' planner sets it from what the physics world says is in the way: a low
   * deck, a pole, a cliff). Routing and escape routes leave the others out. Null: every edge is open.
   */
  passable: ((edge: number) => boolean) | null = null;
  /** Called with a range of edge ids that has just been (re)filled, so per-edge caches (the clearance) forget what they knew. */
  readonly onEdges: ((start: number, n: number) => void)[] = [];
  readonly tiles = new Map<string, WalkTileRange>();
  private readonly nodeIds = new Ranges();
  private readonly edgeIds = new Ranges();
  private readonly attrIds = new Ranges();
  /** Seam links by the pair of nodes they join (`a,b` with a < b). */
  private readonly links = new Map<string, number>();
  private linkAttr = -1;

  constructor(data: PathsData | null) {
    if (data) this.addTile('', data);
  }

  /** An empty graph for a streamed city. */
  static streaming(): WalkGraph {
    return new WalkGraph(null);
  }

  private growNodes(n: number) {
    if (n > this.x.length) {
      const cap = Math.max(n, Math.ceil(this.x.length * 1.5), 64);
      const g = (a: Float32Array) => {
        const b = new Float32Array(cap);
        b.set(a);
        return b;
      };
      this.x = g(this.x);
      this.y = g(this.y);
      this.z = g(this.z);
    }
    while (this.adj.length < n) this.adj.push(NO_EDGES);
    this.nodeCount = Math.max(this.nodeCount, n);
  }

  private growEdges(n: number) {
    if (n > this.ea.length) {
      const cap = Math.max(n, Math.ceil(this.ea.length * 1.5), 64);
      const gi = (a: Int32Array) => {
        const b = new Int32Array(cap);
        b.set(a);
        return b;
      };
      this.ea = gi(this.ea);
      this.eb = gi(this.eb);
      this.eattr = gi(this.eattr);
      const lf = new Float32Array(cap);
      lf.set(this.len);
      this.len = lf;
      const al = new Uint8Array(cap);
      al.set(this.alive);
      this.alive = al;
    }
    this.edgeCount = Math.max(this.edgeCount, n);
  }

  private indexEdge(e: number, add: boolean) {
    const a = this.ea[e], b = this.eb[e];
    const mx = (this.x[a] + this.x[b]) / 2, mz = (this.z[a] + this.z[b]) / 2;
    const k = cellKey(Math.floor(mx / CELL), Math.floor(mz / CELL));
    const spawn = SPAWN_KINDS.has(this.attrs[this.eattr[e]].kind);
    const list = (m: Map<number, number[]>, key: number) => {
      if (add) {
        const l = m.get(key);
        if (l) l.push(e);
        else m.set(key, [e]);
      } else {
        const l = m.get(key);
        if (!l) return;
        const i = l.indexOf(e);
        if (i >= 0) l.splice(i, 1);
        if (l.length === 0) m.delete(key);
      }
    };
    list(this.cells, k);
    if (spawn) {
      const v = (this.cellLength.get(k) ?? 0) + (add ? this.len[e] : -this.len[e]);
      if (add || v > 1e-6) this.cellLength.set(k, v);
      else this.cellLength.delete(k);
    }
    this.totalLength += add ? this.len[e] : -this.len[e];
    const x0 = Math.floor(Math.min(this.x[a], this.x[b]) / CELL), x1 = Math.floor(Math.max(this.x[a], this.x[b]) / CELL);
    const z0 = Math.floor(Math.min(this.z[a], this.z[b]) / CELL), z1 = Math.floor(Math.max(this.z[a], this.z[b]) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) list(this.touch, cellKey(cx, cz));
  }

  /** Adds a tile's walk network. A single-tile world is the tile `''` at ids 0.. (as the old graph). */
  addTile(key: string, data: PathsData): WalkTileRange {
    if (this.tiles.has(key)) throw new Error(`walk graph: tile ${key} is already loaded`);
    const nn = data.nodes.length;
    const m = data.edges.length / 3;
    const na = data.attrs.length;
    const nodeBase = this.nodeIds.alloc(nn);
    const edgeBase = this.edgeIds.alloc(m);
    const attrBase = this.attrIds.alloc(na);
    this.growNodes(nodeBase + nn);
    this.growEdges(edgeBase + m);
    for (let i = 0; i < na; i++) this.attrs[attrBase + i] = data.attrs[i];
    data.nodes.forEach((n, i) => {
      this.x[nodeBase + i] = n[0];
      this.y[nodeBase + i] = n[1];
      this.z[nodeBase + i] = n[2];
    });
    const deg = new Int32Array(nn);
    for (let e = 0; e < m; e++) {
      deg[data.edges[e * 3]]++;
      deg[data.edges[e * 3 + 1]]++;
    }
    const lists = Array.from(deg, (d) => new Int32Array(d));
    const fill = new Int32Array(nn);
    for (let e = 0; e < m; e++) {
      const a = data.edges[e * 3], b = data.edges[e * 3 + 1];
      const ge = edgeBase + e;
      this.ea[ge] = nodeBase + a;
      this.eb[ge] = nodeBase + b;
      this.eattr[ge] = attrBase + data.edges[e * 3 + 2];
      this.len[ge] = Math.hypot(this.x[nodeBase + b] - this.x[nodeBase + a], this.z[nodeBase + b] - this.z[nodeBase + a]);
      this.alive[ge] = 1;
      lists[a][fill[a]++] = ge;
      lists[b][fill[b]++] = ge;
      this.indexEdge(ge, true);
    }
    for (let i = 0; i < nn; i++) this.adj[nodeBase + i] = lists[i];
    const r: WalkTileRange = { key, nodeBase, nodes: nn, edgeBase, edges: m, attrBase, attrs: na };
    this.tiles.set(key, r);
    for (const f of this.onEdges) f(edgeBase, m);
    return r;
  }

  /** Drops a tile: its nodes lose their edges, its edges die, and the seam links to it go. */
  removeTile(key: string): WalkTileRange | null {
    const r = this.tiles.get(key);
    if (!r) return null;
    const inTile = (n: number) => n >= r.nodeBase && n < r.nodeBase + r.nodes;
    for (const [k, e] of [...this.links]) if (inTile(this.ea[e]) || inTile(this.eb[e])) this.unlink(k);
    for (let e = r.edgeBase; e < r.edgeBase + r.edges; e++) {
      if (!this.alive[e]) continue;
      this.indexEdge(e, false);
      this.alive[e] = 0;
    }
    for (let n = r.nodeBase; n < r.nodeBase + r.nodes; n++) this.adj[n] = NO_EDGES;
    this.nodeIds.release(r.nodeBase, r.nodes);
    this.edgeIds.release(r.edgeBase, r.edges);
    this.attrIds.release(r.attrBase, r.attrs);
    this.tiles.delete(key);
    return r;
  }

  /** Joins two nodes of neighbouring tiles (seam ports in the same place) by a `link` edge. Returns the edge. */
  stitch(a: number, b: number): number {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    const had = this.links.get(k);
    if (had !== undefined) return had;
    if (this.linkAttr < 0) {
      this.linkAttr = this.attrIds.alloc(1);
      this.attrs[this.linkAttr] = { kind: 'link', width: 2 };
    }
    const e = this.edgeIds.alloc(1);
    this.growEdges(e + 1);
    this.ea[e] = a;
    this.eb[e] = b;
    this.eattr[e] = this.linkAttr;
    this.len[e] = Math.hypot(this.x[b] - this.x[a], this.z[b] - this.z[a]);
    this.alive[e] = 1;
    this.adj[a] = Int32Array.from([...this.adj[a], e]);
    this.adj[b] = Int32Array.from([...this.adj[b], e]);
    this.indexEdge(e, true);
    this.links.set(k, e);
    for (const f of this.onEdges) f(e, 1);
    return e;
  }

  private unlink(k: string) {
    const e = this.links.get(k);
    if (e === undefined) return;
    this.links.delete(k);
    this.indexEdge(e, false);
    this.alive[e] = 0;
    for (const n of [this.ea[e], this.eb[e]]) this.adj[n] = this.adj[n].filter((x) => x !== e);
    this.edgeIds.release(e, 1);
  }

  /** The seam links (diagnostics and tests). */
  get linkCount(): number {
    return this.links.size;
  }

  /** The edges at a node. */
  edgesAt(n: number): Int32Array {
    return this.adj[n] ?? NO_EDGES;
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
    return this.adj[node]?.length ?? 0;
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
    const heap = new MinHeap();
    heap.push(h(from), from);
    let expanded = 0;
    while (heap.size && expanded < maxExpand) {
      const [, n] = heap.pop();
      if (closed.has(n)) continue;
      if (n === to) return this.pathTo(came, n);
      closed.add(n);
      expanded++;
      const gn = g.get(n)!;
      for (const e of this.adj[n]) {
        const m = this.other(e, n);
        if (closed.has(m)) continue;
        if (this.passable && !this.passable(e)) continue;
        const kind = this.kindOf(e);
        const cost = this.len[e] * (kind === 'crossing' ? 1.8 : kind === 'steps' ? 1.2 : 1) + (kind === 'crossing' ? 6 : 0);
        const ng = gn + cost;
        if (ng < (g.get(m) ?? Infinity)) {
          g.set(m, ng);
          came.set(m, n);
          heap.push(ng + h(m), m);
        }
      }
    }
    return null;
  }

  /**
   * A short run away from a threat at (tx, tz), for someone standing at (x, z): Dijkstra out from both
   * ends of the walk edge they are on (the walk to either end is what it costs), for up to `maxExpand`
   * nodes and `maxCost` metres, to the node that ends farthest from the threat less what it costs to
   * get there. Crossings cost four times their length, so a runner keeps to the pavement. Returns the
   * nodes to walk through, the first of them an end of the edge, or null when nothing is clearly
   * farther off than (x, z) (cornered, or off the network).
   */
  escapeRoute(x: number, z: number, tx: number, tz: number, maxExpand = 260, maxCost = 90): number[] | null {
    const hit = this.nearestEdge(x, z, 8);
    if (!hit) return null;
    const dThreat = (n: number) => Math.hypot(this.x[n] - tx, this.z[n] - tz);
    const start = Math.hypot(x - tx, z - tz);
    const g = new Map<number, number>();
    const came = new Map<number, number>();
    const closed = new Set<number>();
    const heap = new MinHeap();
    for (const n of [this.ea[hit.edge], this.eb[hit.edge]]) {
      const c = Math.hypot(this.x[n] - x, this.z[n] - z);
      if (c < (g.get(n) ?? Infinity)) {
        g.set(n, c);
        heap.push(c, n);
      }
    }
    let best = -1;
    let bestScore = start;
    let expanded = 0;
    while (heap.size && expanded < maxExpand) {
      const [gn, n] = heap.pop();
      if (closed.has(n) || gn > g.get(n)!) continue;
      closed.add(n);
      expanded++;
      const score = dThreat(n) - 0.3 * gn;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
      // never run past the threat itself
      if (dThreat(n) < 5) continue;
      for (const e of this.adj[n]) {
        const m = this.other(e, n);
        if (closed.has(m)) continue;
        if (this.passable && !this.passable(e)) continue;
        const kind = this.kindOf(e);
        const ng = gn + this.len[e] * (kind === 'crossing' ? 4 : kind === 'steps' ? 1.2 : 1) + (kind === 'crossing' ? 10 : 0);
        if (ng > maxCost) continue;
        if (ng < (g.get(m) ?? Infinity)) {
          g.set(m, ng);
          came.set(m, n);
          heap.push(ng, m);
        }
      }
    }
    if (best < 0 || dThreat(best) < start + 4) return null;
    return this.pathTo(came, best);
  }

  private pathTo(came: Map<number, number>, to: number): number[] {
    const path = [to];
    let c = to;
    while (came.has(c)) {
      c = came.get(c)!;
      path.push(c);
    }
    return path.reverse();
  }

  /**
   * Whether `need` metres of walkable edge can be walked from edge `e` (breadth first over the passable edges). A person put on a
   * pocket of the network that is cut off by an impassable bit would pace up and down it for ever.
   */
  hasRoom(e: number, need = 60): boolean {
    const seen = new Set<number>([e]);
    const queue = [e];
    let total = 0;
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      total += this.len[cur];
      if (total >= need) return true;
      for (const n of [this.ea[cur], this.eb[cur]]) {
        for (const f of this.adj[n]) {
          if (seen.has(f) || (this.passable && !this.passable(f))) continue;
          seen.add(f);
          queue.push(f);
        }
      }
    }
    return false;
  }

  /** The edge joining two nodes, or -1. */
  edgeBetween(a: number, b: number): number {
    for (const e of this.adj[a]) if (this.other(e, a) === b) return e;
    return -1;
  }
}
