/**
 * The walk graph the GPS uses on foot, built on the client from each loaded tile's `paths.json` (the sim's `WalkGraph` is in the
 * worker). Nodes and undirected edges (sidewalks, crossings, footways, steps), the tiles of a streamed city joined across their seams
 * by the same port matching the sim uses, a hash grid for "the nearest path to here", and a resumable A* like the car one.
 * Pure: no DOM, no three.js.
 */
import type { Rect, SeamSide } from '../../shared/city';
import { matchWalkPorts, seamPorts, SIDES, type WalkPort } from '../../shared/seams';
import type { PathKind, PathsData } from '../../shared/walk';
import { cellKey, gridSegment } from './geom';
import { MinHeap } from './heap';
import { adjacentSides } from './tiles';

/** What walking an edge costs per metre by kind: the GPS prefers pavement to steps, and crossings to nothing. */
const KIND_COST: Record<PathKind, number> = {
  sidewalk: 1,
  synthetic: 1.05,
  footway: 1,
  pedestrian: 1,
  crossing: 1.2,
  island: 1.1,
  link: 1.1,
  steps: 1.8,
};
/** Extra metres for waiting at a walk light. */
const SIGNAL_WAIT_M = 12;
const CELL = 32;

export interface WalkTile {
  id: string;
  bounds: Rect;
  nodeCount: number;
  edgeCount: number;
  nodes: Float32Array;
  ea: Int32Array;
  eb: Int32Array;
  /** Metres. */
  elen: Float32Array;
  /** What it costs to walk (metres, weighted). */
  ecost: Float32Array;
  ports: Partial<Record<SeamSide, WalkPort[]>>;
}

export function buildWalkTile(id: string, bounds: Rect, paths: PathsData): WalkTile {
  const nodeCount = paths.nodes.length;
  const edgeCount = paths.edges.length / 3;
  const t: WalkTile = {
    id,
    bounds,
    nodeCount,
    edgeCount,
    nodes: new Float32Array(nodeCount * 3),
    ea: new Int32Array(edgeCount),
    eb: new Int32Array(edgeCount),
    elen: new Float32Array(edgeCount),
    ecost: new Float32Array(edgeCount),
    ports: {},
  };
  for (let i = 0; i < nodeCount; i++) {
    const p = paths.nodes[i];
    t.nodes[i * 3] = p[0];
    t.nodes[i * 3 + 1] = p[1];
    t.nodes[i * 3 + 2] = p[2];
  }
  for (let i = 0; i < edgeCount; i++) {
    const a = paths.edges[i * 3];
    const b = paths.edges[i * 3 + 1];
    const attr = paths.attrs[paths.edges[i * 3 + 2]];
    const len = Math.hypot(t.nodes[b * 3] - t.nodes[a * 3], t.nodes[b * 3 + 2] - t.nodes[a * 3 + 2]);
    t.ea[i] = a;
    t.eb[i] = b;
    t.elen[i] = len;
    t.ecost[i] = len * (KIND_COST[attr.kind] ?? 1) + (attr.crossing?.signals ? SIGNAL_WAIT_M : 0);
  }
  const ports = seamPorts(id, bounds, { paths });
  for (const side of SIDES) {
    const p = ports.sides[side];
    if (p && p.walk.length) t.ports[side] = p.walk;
  }
  return t;
}

export interface WalkHit {
  edge: number;
  /** 0 at the edge's first node, 1 at its second. */
  t: number;
  x: number;
  y: number;
  z: number;
  dist: number;
}

export class WalkNet {
  nodeCount = 0;
  edgeCount = 0;
  nodes = new Float32Array(0);
  ea = new Int32Array(0);
  eb = new Int32Array(0);
  elen = new Float32Array(0);
  ecost = new Float32Array(0);
  adjOff = new Int32Array(1);
  adjEdge = new Int32Array(0);
  tileIds: string[] = [];
  tileBounds: Rect[] = [];
  stitched = 0;
  readonly g: Float32Array;
  readonly parent: Int32Array;
  readonly seen: Uint32Array;
  readonly closed: Uint32Array;
  stamp = 0;
  private grid = new Map<number, Int32Array>();
  private readonly markE: Uint32Array;
  private markStamp = 0;

  private constructor(nodes: number, edges: number) {
    this.g = new Float32Array(nodes);
    this.parent = new Int32Array(nodes);
    this.seen = new Uint32Array(nodes);
    this.closed = new Uint32Array(nodes);
    this.markE = new Uint32Array(edges);
  }

  static empty(): WalkNet {
    return new WalkNet(0, 0);
  }

  static assemble(tiles: readonly WalkTile[]): WalkNet {
    let nodes = 0;
    let edges = 0;
    for (const t of tiles) {
      nodes += t.nodeCount;
      edges += t.edgeCount;
    }
    // seam links first: they add edges
    const bases: number[] = [];
    let nb = 0;
    for (const t of tiles) {
      bases.push(nb);
      nb += t.nodeCount;
    }
    const links: [number, number][] = [];
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const sides = adjacentSides(tiles[i].bounds, tiles[j].bounds);
        if (!sides) continue;
        const { pairs } = matchWalkPorts(tiles[i].ports[sides[0]] ?? [], tiles[j].ports[sides[1]] ?? []);
        // (matchWalkPorts keeps its pairs in the order of its arguments)
        for (const [p, q] of pairs) links.push([bases[i] + p.node, bases[j] + q.node]);
      }
    }
    const net = new WalkNet(nodes, edges + links.length);
    net.tileIds = tiles.map((t) => t.id);
    net.tileBounds = tiles.map((t) => t.bounds);
    net.nodeCount = nodes;
    net.edgeCount = edges + links.length;
    net.nodes = new Float32Array(nodes * 3);
    net.ea = new Int32Array(net.edgeCount);
    net.eb = new Int32Array(net.edgeCount);
    net.elen = new Float32Array(net.edgeCount);
    net.ecost = new Float32Array(net.edgeCount);
    let eb = 0;
    tiles.forEach((t, ti) => {
      net.nodes.set(t.nodes, bases[ti] * 3);
      for (let i = 0; i < t.edgeCount; i++) {
        net.ea[eb + i] = bases[ti] + t.ea[i];
        net.eb[eb + i] = bases[ti] + t.eb[i];
      }
      net.elen.set(t.elen, eb);
      net.ecost.set(t.ecost, eb);
      eb += t.edgeCount;
    });
    for (const [a, b] of links) {
      net.ea[eb] = a;
      net.eb[eb] = b;
      const d = Math.hypot(net.nodes[a * 3] - net.nodes[b * 3], net.nodes[a * 3 + 2] - net.nodes[b * 3 + 2]);
      net.elen[eb] = d;
      net.ecost[eb] = d;
      eb++;
    }
    net.stitched = links.length;
    // adjacency (undirected)
    const deg = new Int32Array(nodes + 1);
    for (let e = 0; e < net.edgeCount; e++) {
      deg[net.ea[e]]++;
      deg[net.eb[e]]++;
    }
    net.adjOff = new Int32Array(nodes + 1);
    for (let n = 0; n < nodes; n++) net.adjOff[n + 1] = net.adjOff[n] + deg[n];
    net.adjEdge = new Int32Array(net.adjOff[nodes]);
    const fill = net.adjOff.slice(0, nodes);
    for (let e = 0; e < net.edgeCount; e++) {
      net.adjEdge[fill[net.ea[e]]++] = e;
      net.adjEdge[fill[net.eb[e]]++] = e;
    }
    net.buildGrid();
    return net;
  }

  private buildGrid() {
    const lists = new Map<number, number[]>();
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.ea[e] * 3;
      const b = this.eb[e] * 3;
      gridSegment(CELL, this.nodes[a], this.nodes[a + 2], this.nodes[b], this.nodes[b + 2], (k) => {
        let l = lists.get(k);
        if (!l) lists.set(k, (l = []));
        if (l[l.length - 1] !== e) l.push(e);
      });
    }
    for (const [k, l] of lists) this.grid.set(k, Int32Array.from(l));
  }

  /** The nearest point on any path to (x, z) within `maxD`, or null. */
  nearest(x: number, z: number, maxD: number): WalkHit | null {
    if (this.edgeCount === 0) return null;
    const stamp = ++this.markStamp;
    const c0x = Math.floor((x - maxD) / CELL), c1x = Math.floor((x + maxD) / CELL);
    const c0z = Math.floor((z - maxD) / CELL), c1z = Math.floor((z + maxD) / CELL);
    let best: WalkHit | null = null;
    let bestD = maxD;
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const l = this.grid.get(cellKey(cx, cz));
        if (!l) continue;
        for (let k = 0; k < l.length; k++) {
          const e = l[k];
          if (this.markE[e] === stamp) continue;
          this.markE[e] = stamp;
          const a = this.ea[e] * 3, b = this.eb[e] * 3;
          const ax = this.nodes[a], az = this.nodes[a + 2];
          const dx = this.nodes[b] - ax, dz = this.nodes[b + 2] - az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(px - x, pz - z);
          if (d < bestD) {
            bestD = d;
            best = { edge: e, t, x: px, y: this.nodes[a + 1] + (this.nodes[b + 1] - this.nodes[a + 1]) * t, z: pz, dist: d };
          }
        }
      }
    }
    return best;
  }
}

export interface WalkResult {
  /** Node ids, first to last. */
  nodes: number[];
  cost: number;
}

/** A resumable A* over the walk graph from a snapped start to a snapped goal (both are points on an edge). */
export class WalkSearch {
  outcome: 'running' | 'found' | 'none' = 'running';
  result: WalkResult | null = null;
  expanded = 0;
  private readonly heap = new MinHeap();
  private readonly stamp: number;
  private readonly goalTail = new Map<number, number>();
  private bestTotal = Infinity;
  private bestGoal = -1;

  constructor(
    private readonly net: WalkNet,
    start: { edge: number; t: number },
    goal: { edge: number; t: number },
    private readonly gx: number,
    private readonly gz: number,
  ) {
    this.stamp = ++net.stamp;
    const addSources = (edge: number, t: number) => {
      const w = net.ecost[edge];
      const pairs: [number, number][] = [
        [net.ea[edge], t * w],
        [net.eb[edge], (1 - t) * w],
      ];
      return pairs;
    };
    for (const [n, c] of addSources(goal.edge, goal.t)) this.goalTail.set(n, Math.min(c, this.goalTail.get(n) ?? Infinity));
    for (const [n, c] of addSources(start.edge, start.t)) {
      if (net.seen[n] === this.stamp && net.g[n] <= c) continue;
      net.seen[n] = this.stamp;
      net.g[n] = c;
      net.parent[n] = -1;
      this.heap.push(c + this.h(n), n);
    }
    if (this.heap.size === 0) this.outcome = 'none';
  }

  private h(n: number): number {
    return Math.hypot(this.net.nodes[n * 3] - this.gx, this.net.nodes[n * 3 + 2] - this.gz);
  }

  step(budgetMs: number): 'running' | 'found' | 'none' {
    if (this.outcome !== 'running') return this.outcome;
    const net = this.net;
    if (net.stamp !== this.stamp) {
      this.outcome = 'none';
      return this.outcome;
    }
    const heap = this.heap;
    const t0 = performance.now();
    let n = 0;
    while (heap.size > 0) {
      if ((++n & 63) === 0 && performance.now() - t0 > budgetMs) return 'running';
      const item = heap.pop();
      const key = heap.popped;
      if (item < 0) {
        this.finish(-item - 1, key);
        return this.outcome;
      }
      if (net.closed[item] === this.stamp) continue;
      net.closed[item] = this.stamp;
      this.expanded++;
      const g0 = net.g[item];
      const tail = this.goalTail.get(item);
      if (tail !== undefined && g0 + tail < this.bestTotal) {
        this.bestTotal = g0 + tail;
        this.bestGoal = item;
        heap.push(this.bestTotal, -(item + 1));
      }
      for (let k = net.adjOff[item]; k < net.adjOff[item + 1]; k++) {
        const e = net.adjEdge[k];
        const o = net.ea[e] === item ? net.eb[e] : net.ea[e];
        if (net.closed[o] === this.stamp) continue;
        const g2 = g0 + net.ecost[e];
        if (net.seen[o] === this.stamp && net.g[o] <= g2) continue;
        net.seen[o] = this.stamp;
        net.g[o] = g2;
        net.parent[o] = item;
        heap.push(g2 + this.h(o), o);
      }
    }
    if (this.bestGoal >= 0) this.finish(this.bestGoal, this.bestTotal);
    else this.outcome = 'none';
    return this.outcome;
  }

  private finish(goalNode: number, cost: number) {
    const nodes: number[] = [];
    for (let n = goalNode; n >= 0; n = this.net.parent[n]) {
      nodes.push(n);
      if (nodes.length > this.net.nodeCount) break;
    }
    nodes.reverse();
    this.result = { nodes, cost };
    this.outcome = 'found';
  }
}
