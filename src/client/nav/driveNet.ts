/**
 * The road graph the GPS drives over, built on the client from each loaded tile's `lanes.json` (the sim's own `LaneGraph` lives in the
 * worker and is not touched). Edges are lanes and the connectors across junctions, directed, so a route obeys one-ways and only takes
 * the turns that have a connector. The tiles of a streamed city are joined across their seams with the same port matching the sim uses
 * (`src/shared/seams.ts`), and the lanes that leave the loaded area are its `frontier`: a route to somewhere not loaded ends there.
 *
 * `buildDriveTile` makes the compact per-tile form (once per tile load); `DriveNet.assemble` joins the loaded tiles' (a few ms, on a
 * change of the loaded set); `DriveSearch` is a resumable A* that runs a time budget a frame. Pure: no DOM, no three.js.
 */
import type { Rect, SeamSide } from '../../shared/city';
import type { LaneEdgeData, LanesData } from '../../shared/lanes';
import { matchLanePorts, seamPorts, SIDES, type LanePort } from '../../shared/seams';
import type { RoadData } from '../../shared/tile';
import { cellKey, gridSegment, newHit, pointAlong, polylineLength, projectPolyline, type PolyHit } from './geom';
import { MinHeap } from './heap';
import { adjacentSides } from './tiles';

export const Turn = { Straight: 0, Left: 1, Right: 2, UTurn: 3 } as const;
const TURN: Record<string, number> = { s: 0, l: 1, r: 2, u: 3 };
const CTL: Record<string, number> = { none: 0, stop: 1, signals: 2 };

export interface DriveTile {
  id: string;
  bounds: Rect;
  n: number;
  conn: Uint8Array;
  turn: Uint8Array;
  ctl: Uint8Array;
  link: Uint8Array;
  len: Float32Array;
  v: Float32Array;
  /** Index into `names` (the street a lane is on; a connector has the street it leads onto) and into `roadKeys`. */
  nameId: Int32Array;
  roadId: Int32Array;
  names: string[];
  roadKeys: string[];
  from: Int32Array;
  to: Int32Array;
  ptOff: Int32Array;
  pts: Float32Array;
  nextOff: Int32Array;
  next: Int32Array;
  ports: Partial<Record<SeamSide, LanePort[]>>;
}

/** Packs a tile's `lanes.json` for the GPS. `roads` supplies the street names (a lane knows its road by id). */
export function buildDriveTile(id: string, bounds: Rect, lanes: LanesData, roads?: readonly RoadData[]): DriveTile {
  const E = lanes.edges;
  const n = E.length;
  const roadName = new Map<string, string>();
  for (const r of roads ?? []) if (r.name) roadName.set(r.id, r.name);
  const names: string[] = [''];
  const nameIdx = new Map<string, number>([['', 0]]);
  const roadKeys: string[] = [''];
  const roadIdx = new Map<string, number>([['', 0]]);
  const intern = (s: string, list: string[], map: Map<string, number>) => {
    let i = map.get(s);
    if (i === undefined) {
      i = list.length;
      list.push(s);
      map.set(s, i);
    }
    return i;
  };
  let total = 0;
  let totalNext = 0;
  for (const e of E) {
    total += e.pts.length / 3;
    totalNext += e.t === 0 ? e.next.length : 1;
  }
  const t: DriveTile = {
    id,
    bounds,
    n,
    conn: new Uint8Array(n),
    turn: new Uint8Array(n),
    ctl: new Uint8Array(n),
    link: new Uint8Array(n),
    len: new Float32Array(n),
    v: new Float32Array(n),
    nameId: new Int32Array(n),
    roadId: new Int32Array(n),
    names,
    roadKeys,
    from: new Int32Array(n).fill(-1),
    to: new Int32Array(n).fill(-1),
    ptOff: new Int32Array(n + 1),
    pts: new Float32Array(total * 3),
    nextOff: new Int32Array(n + 1),
    next: new Int32Array(totalNext),
    ports: {},
  };
  let po = 0;
  let no = 0;
  for (let i = 0; i < n; i++) {
    const e = E[i];
    t.ptOff[i] = po;
    const m = e.pts.length / 3;
    for (let k = 0; k < e.pts.length; k++) t.pts[po * 3 + k] = e.pts[k];
    po += m;
    t.len[i] = polylineLength(t.pts, t.ptOff[i], m);
    t.v[i] = e.v;
    t.nextOff[i] = no;
    if (e.t === 0) {
      t.ctl[i] = CTL[e.ctl ?? 'none'] ?? 0;
      t.link[i] = e.cls.endsWith('_link') ? 1 : 0;
      t.nameId[i] = intern(roadName.get(e.road) ?? '', names, nameIdx);
      t.roadId[i] = intern(e.road, roadKeys, roadIdx);
      for (const x of e.next) t.next[no++] = x;
    } else {
      t.conn[i] = 1;
      t.turn[i] = TURN[e.turn] ?? 0;
      t.ctl[i] = CTL[e.ctl ?? 'none'] ?? 0;
      t.from[i] = e.from;
      t.to[i] = e.to;
      t.next[no++] = e.to;
    }
  }
  t.ptOff[n] = po;
  t.nextOff[n] = no;
  // a connector is named for the road it turns onto
  for (let i = 0; i < n; i++) {
    if (!t.conn[i]) continue;
    t.nameId[i] = t.nameId[t.to[i]];
    t.roadId[i] = t.roadId[t.to[i]];
  }
  const ports = seamPorts(id, bounds, { lanes });
  for (const side of SIDES) {
    const p = ports.sides[side];
    if (p && p.lanes.length) t.ports[side] = p.lanes;
  }
  return t;
}

/** A lane near a point: where along it the point projects, how far away it is, and how well it lines up with a heading. */
export interface LaneHit {
  edge: number;
  s: number;
  dist: number;
  /** cos of the angle between the lane's direction there and the heading asked about (1 when none was). */
  align: number;
}

const CELL = 48;

/** Seconds added for entering an edge: turns, stop lines and signals (a left across traffic costs most). U-turns are a last resort. */
function enterPenalty(net: DriveNet, e: number): number {
  let p = 0;
  if (net.conn[e]) {
    switch (net.turn[e]) {
      case Turn.Left:
        p += 3;
        break;
      case Turn.Right:
        p += 1;
        break;
      case Turn.UTurn:
        p += 45;
        break;
      default:
        p += 0.4;
    }
    if (net.ctl[e] === 2) p += 6;
    else if (net.ctl[e] === 1) p += 3;
  }
  return p;
}

export class DriveNet {
  count = 0;
  tileIds: string[] = [];
  tileBase = new Int32Array(0);
  tileBounds: Rect[] = [];
  conn = new Uint8Array(0);
  turn = new Uint8Array(0);
  ctl = new Uint8Array(0);
  link = new Uint8Array(0);
  len = new Float32Array(0);
  v = new Float32Array(0);
  nameId = new Int32Array(0);
  roadId = new Int32Array(0);
  from = new Int32Array(0);
  to = new Int32Array(0);
  ptOff = new Int32Array(1);
  pts = new Float32Array(0);
  nextOff = new Int32Array(1);
  nextIdx = new Int32Array(0);
  names: string[] = [''];
  roadKeys: string[] = [''];
  /** Lanes that end where the loaded area ends (cars drive off the map there). */
  frontier = new Int32Array(0);
  vmax = 10;
  /** 1 for the lanes a car can be driven to from the largest strongly connected part of the net (a goal elsewhere may be a parking lot nobody can reach). */
  reach = new Uint8Array(0);
  /** 1 for the lanes from which a car can be driven into the largest strongly connected part: a start the route can go on from. A
   * freeway under a deck stub that only runs off the map is not one. */
  leads = new Uint8Array(0);
  /** Edges in the largest strongly connected component. */
  mainSize = 0;
  /** Seams joined, and out-ports with no partner although the neighbour is loaded. */
  stitched = 0;
  unmatched = 0;
  /** Search scratch, shared by the searches over this net (a new search invalidates the last). */
  readonly g: Float32Array;
  readonly parent: Int32Array;
  readonly seen: Uint32Array;
  readonly closed: Uint32Array;
  readonly mark: Uint32Array;
  stamp = 0;
  private grid = new Map<number, Int32Array>();
  private readonly hit = newHit();

  private constructor(count: number) {
    this.count = count;
    this.g = new Float32Array(count);
    this.parent = new Int32Array(count);
    this.seen = new Uint32Array(count);
    this.closed = new Uint32Array(count);
    this.mark = new Uint32Array(count);
  }

  static empty(): DriveNet {
    return new DriveNet(0);
  }

  /** Joins the loaded tiles into one graph (the order of `tiles` does not matter). */
  static assemble(tiles: readonly DriveTile[]): DriveNet {
    let count = 0;
    let nPts = 0;
    let nNext = 0;
    for (const t of tiles) {
      count += t.n;
      nPts += t.pts.length / 3;
      nNext += t.next.length;
    }
    const net = new DriveNet(count);
    net.tileIds = tiles.map((t) => t.id);
    net.tileBounds = tiles.map((t) => t.bounds);
    net.tileBase = new Int32Array(tiles.length + 1);
    net.conn = new Uint8Array(count);
    net.turn = new Uint8Array(count);
    net.ctl = new Uint8Array(count);
    net.link = new Uint8Array(count);
    net.len = new Float32Array(count);
    net.v = new Float32Array(count);
    net.nameId = new Int32Array(count);
    net.roadId = new Int32Array(count);
    net.from = new Int32Array(count).fill(-1);
    net.to = new Int32Array(count).fill(-1);
    net.ptOff = new Int32Array(count + 1);
    net.pts = new Float32Array(nPts * 3);
    const nameIdx = new Map<string, number>([['', 0]]);
    const roadIdx = new Map<string, number>([['', 0]]);
    const intern = (s: string, list: string[], map: Map<string, number>) => {
      let i = map.get(s);
      if (i === undefined) {
        i = list.length;
        list.push(s);
        map.set(s, i);
      }
      return i;
    };
    // pass 1: arrays, and the next lists by edge (seam links are added after)
    const nextLists: (number[] | Int32Array)[] = new Array(count);
    let base = 0;
    let pbase = 0;
    let vmax = 3;
    tiles.forEach((t, ti) => {
      net.tileBase[ti] = base;
      net.conn.set(t.conn, base);
      net.turn.set(t.turn, base);
      net.ctl.set(t.ctl, base);
      net.link.set(t.link, base);
      net.len.set(t.len, base);
      net.v.set(t.v, base);
      net.pts.set(t.pts, pbase * 3);
      const nm = t.names.map((s) => intern(s, net.names, nameIdx));
      const rk = t.roadKeys.map((s) => intern(s, net.roadKeys, roadIdx));
      for (let i = 0; i < t.n; i++) {
        const e = base + i;
        net.nameId[e] = nm[t.nameId[i]];
        net.roadId[e] = rk[t.roadId[i]];
        net.ptOff[e] = pbase + t.ptOff[i];
        if (t.conn[i]) {
          net.from[e] = base + t.from[i];
          net.to[e] = base + t.to[i];
        }
        const a = t.nextOff[i];
        const b = t.nextOff[i + 1];
        const list = new Array<number>(b - a);
        for (let k = a; k < b; k++) list[k - a] = base + t.next[k];
        nextLists[e] = list;
        vmax = Math.max(vmax, t.v[i]);
      }
      base += t.n;
      pbase += t.pts.length / 3;
    });
    net.tileBase[tiles.length] = base;
    net.ptOff[count] = pbase;
    net.vmax = vmax;

    // seams: join each matched out-port to the lane that continues it, and take the turnaround connector out of the joined lane
    const neighbourLoaded = tiles.map(() => new Set<SeamSide>());
    const matchedOut = new Set<number>();
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const sides = adjacentSides(tiles[i].bounds, tiles[j].bounds);
        if (!sides) continue;
        neighbourLoaded[i].add(sides[0]);
        neighbourLoaded[j].add(sides[1]);
        const pa = tiles[i].ports[sides[0]] ?? [];
        const pb = tiles[j].ports[sides[1]] ?? [];
        const { pairs, unmatched } = matchLanePorts(pa, pb);
        net.unmatched += unmatched.filter((u) => u.end === 'out').length;
        const inA = new Set<LanePort>(pa);
        for (const { out, into } of pairs) {
          const outTile = inA.has(out) ? i : j;
          const inTile = inA.has(out) ? j : i;
          const oe = net.tileBase[outTile] + out.edge;
          const ie = net.tileBase[inTile] + into.edge;
          // (the bake's turnaround at a tile's edge is replaced by the neighbour's lane)
          const list = (nextLists[oe] as number[]).filter((x) => !(net.conn[x] && net.turn[x] === Turn.UTurn));
          list.push(ie);
          nextLists[oe] = list;
          matchedOut.add(oe);
          net.stitched++;
        }
      }
    }
    // CSR
    let total = 0;
    for (let e = 0; e < count; e++) total += nextLists[e].length;
    net.nextIdx = new Int32Array(total);
    net.nextOff = new Int32Array(count + 1);
    let o = 0;
    for (let e = 0; e < count; e++) {
      net.nextOff[e] = o;
      for (const x of nextLists[e]) net.nextIdx[o++] = x;
    }
    net.nextOff[count] = o;
    void nNext;
    // frontier: out-ports on a side with no loaded neighbour
    const fr: number[] = [];
    tiles.forEach((t, ti) => {
      for (const side of SIDES) {
        if (neighbourLoaded[ti].has(side)) continue;
        for (const p of t.ports[side] ?? []) if (p.end === 'out') fr.push(net.tileBase[ti] + p.edge);
      }
    });
    net.frontier = Int32Array.from(fr);
    net.buildGrid();
    net.computeReach();
    return net;
  }

  /** Tarjan's strongly connected components (iterative), then a forward flood from the largest. */
  private computeReach() {
    const n = this.count;
    this.reach = new Uint8Array(n);
    if (n === 0) return;
    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const comp = new Int32Array(n).fill(-1);
    const onStack = new Uint8Array(n);
    const stack = new Int32Array(n);
    const callE = new Int32Array(n);
    const callK = new Int32Array(n);
    let sp = 0;
    let idx = 0;
    let ncomp = 0;
    const sizes: number[] = [];
    for (let root = 0; root < n; root++) {
      if (index[root] >= 0) continue;
      let cp = 0;
      callE[0] = root;
      callK[0] = this.nextOff[root];
      index[root] = low[root] = idx++;
      stack[sp++] = root;
      onStack[root] = 1;
      while (cp >= 0) {
        const e = callE[cp];
        if (callK[cp] < this.nextOff[e + 1]) {
          const w = this.nextIdx[callK[cp]++];
          if (index[w] < 0) {
            index[w] = low[w] = idx++;
            stack[sp++] = w;
            onStack[w] = 1;
            cp++;
            callE[cp] = w;
            callK[cp] = this.nextOff[w];
          } else if (onStack[w]) {
            if (index[w] < low[e]) low[e] = index[w];
          }
        } else {
          if (low[e] === index[e]) {
            let size = 0;
            for (;;) {
              const w = stack[--sp];
              onStack[w] = 0;
              comp[w] = ncomp;
              size++;
              if (w === e) break;
            }
            sizes.push(size);
            ncomp++;
          }
          cp--;
          if (cp >= 0) {
            const parent = callE[cp];
            if (low[e] < low[parent]) low[parent] = low[e];
          }
        }
      }
    }
    let big = 0;
    for (let c = 1; c < ncomp; c++) if (sizes[c] > sizes[big]) big = c;
    this.mainSize = sizes[big] ?? 0;
    // everything a car can get to from the big component
    const queue = new Int32Array(n);
    let qh = 0;
    let qt = 0;
    for (let e = 0; e < n; e++) {
      if (comp[e] === big) {
        this.reach[e] = 1;
        queue[qt++] = e;
      }
    }
    while (qh < qt) {
      const e = queue[qh++];
      for (let k = this.nextOff[e]; k < this.nextOff[e + 1]; k++) {
        const w = this.nextIdx[k];
        if (!this.reach[w]) {
          this.reach[w] = 1;
          queue[qt++] = w;
        }
      }
    }
    // and everything that leads into it: a backward flood
    this.leads = new Uint8Array(n);
    const prevOff = new Int32Array(n + 1);
    for (let k = 0; k < this.nextIdx.length; k++) prevOff[this.nextIdx[k] + 1]++;
    for (let e = 0; e < n; e++) prevOff[e + 1] += prevOff[e];
    const prevIdx = new Int32Array(this.nextIdx.length);
    const fill = prevOff.slice(0, n);
    for (let e = 0; e < n; e++) for (let k = this.nextOff[e]; k < this.nextOff[e + 1]; k++) prevIdx[fill[this.nextIdx[k]]++] = e;
    qh = 0;
    qt = 0;
    for (let e = 0; e < n; e++) if (comp[e] === big) { this.leads[e] = 1; queue[qt++] = e; }
    while (qh < qt) {
      const e = queue[qh++];
      for (let k = prevOff[e]; k < prevOff[e + 1]; k++) {
        const w = prevIdx[k];
        if (!this.leads[w]) { this.leads[w] = 1; queue[qt++] = w; }
      }
    }
  }

  private buildGrid() {
    const lists = new Map<number, number[]>();
    for (let e = 0; e < this.count; e++) {
      const a = this.ptOff[e];
      const m = this.ptOff[e + 1] - a;
      for (let i = 0; i < m - 1; i++) {
        const o = (a + i) * 3;
        gridSegment(CELL, this.pts[o], this.pts[o + 2], this.pts[o + 3], this.pts[o + 5], (k) => {
          let l = lists.get(k);
          if (!l) lists.set(k, (l = []));
          if (l[l.length - 1] !== e) l.push(e);
        });
      }
    }
    for (const [k, l] of lists) this.grid.set(k, Int32Array.from(l));
  }

  tileIndexOf(e: number): number {
    let lo = 0;
    let hi = this.tileIds.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.tileBase[m] <= e) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  pointCount(e: number): number {
    return this.ptOff[e + 1] - this.ptOff[e];
  }

  /** Writes the point `s` metres along edge `e`. */
  pointAt(e: number, s: number, out: PolyHit = this.hit): PolyHit {
    return pointAlong(this.pts, this.ptOff[e], this.pointCount(e), s, out);
  }

  streetName(e: number): string {
    return this.names[this.nameId[e]] ?? '';
  }

  /** Lanes within `maxD` of a point, nearest first. `heading` (a unit vector) filters and ranks by direction when given. */
  near(x: number, z: number, maxD: number, heading: { x: number; z: number } | null = null, minAlign = -2): LaneHit[] {
    const out: LaneHit[] = [];
    if (this.count === 0) return out;
    const stamp = ++this.stamp;
    const c0x = Math.floor((x - maxD) / CELL), c1x = Math.floor((x + maxD) / CELL);
    const c0z = Math.floor((z - maxD) / CELL), c1z = Math.floor((z + maxD) / CELL);
    const hit = newHit();
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const l = this.grid.get(cellKey(cx, cz));
        if (!l) continue;
        for (let k = 0; k < l.length; k++) {
          const e = l[k];
          if (this.mark[e] === stamp) continue;
          this.mark[e] = stamp;
          projectPolyline(this.pts, this.ptOff[e], this.pointCount(e), x, z, hit);
          if (hit.dist > maxD) continue;
          const align = heading ? hit.tx * heading.x + hit.tz * heading.z : 1;
          if (align < minAlign) continue;
          out.push({ edge: e, s: hit.s, dist: hit.dist, align });
        }
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }
}

export interface DriveSource {
  edge: number;
  /** Metres along the edge where the vehicle is. */
  s: number;
  /** Seconds of penalty for being off the lane or pointing the wrong way. */
  cost: number;
}

export interface DriveGoal {
  edge: number;
  /** Metres along the edge to the waypoint's nearest point. */
  s: number;
}

export interface DriveResult {
  /** The edges to drive, first to last (the first is the one the vehicle starts on). */
  edges: number[];
  startS: number;
  endS: number;
  /** The route ends at the frontier, not at the goal. */
  partial: boolean;
  /** Estimated drive time, s. */
  cost: number;
}

/**
 * A resumable A* over the lane graph. `goals` null means the goal is not in the loaded area: the search then ends at the frontier
 * lane that leaves the most promising way (its cost plus the straight distance from there to the goal point).
 *
 * The vehicle's own lane is not a node of the search: the edges that follow it are its first nodes, entered at the cost of the rest
 * of the lane. So a route may come round and use the same lane again (a goal behind the car), and `parent` of a first node is
 * `-(source edge + 2)`.
 */
export class DriveSearch {
  outcome: 'running' | 'found' | 'none' = 'running';
  result: DriveResult | null = null;
  expanded = 0;
  private readonly heap = new MinHeap();
  private readonly stamp: number;
  private readonly goalMap = new Map<number, number>();
  private readonly srcS = new Map<number, number>();
  private bestTotal = Infinity;

  constructor(
    private readonly net: DriveNet,
    sources: readonly DriveSource[],
    goals: readonly DriveGoal[] | null,
    private readonly gx: number,
    private readonly gz: number,
  ) {
    this.stamp = ++net.stamp;
    if (goals) for (const g of goals) this.goalMap.set(g.edge, g.s);
    else for (const e of net.frontier) this.goalMap.set(e, -1);
    for (const src of sources) {
      const e = src.edge;
      const v = Math.max(3, net.v[e]);
      this.srcS.set(e, src.s);
      // the goal is further along the car's own lane
      const gs = this.goalMap.get(e);
      if (gs !== undefined && (gs < 0 || gs >= src.s - 1)) {
        const total = gs >= 0 ? src.cost + Math.max(0, gs - src.s) / v : src.cost + (net.len[e] - src.s) / v + this.frontierTail(e);
        this.push(total, -(net.count + e + 1));
      }
      const gEnd = src.cost + Math.max(0, net.len[e] - src.s) / v;
      for (let k = net.nextOff[e]; k < net.nextOff[e + 1]; k++) {
        const nx = net.nextIdx[k];
        const g2 = gEnd + enterPenalty(net, nx);
        if (net.seen[nx] === this.stamp && net.g[nx] <= g2) continue;
        net.seen[nx] = this.stamp;
        net.g[nx] = g2;
        net.parent[nx] = -(e + 2);
        this.heap.push(g2 + this.h(nx), nx);
      }
    }
    if (this.heap.size === 0) this.outcome = 'none';
  }

  private push(total: number, item: number) {
    if (total < this.bestTotal) this.bestTotal = total;
    this.heap.push(total, item);
  }

  private h(e: number): number {
    const o = this.net.ptOff[e] * 3;
    return Math.hypot(this.net.pts[o] - this.gx, this.net.pts[o + 2] - this.gz) / this.net.vmax;
  }

  /** Seconds from the end of a frontier lane to the goal point, straight at the fastest speed there is. */
  private frontierTail(e: number): number {
    const o = (this.net.ptOff[e + 1] - 1) * 3;
    return Math.hypot(this.net.pts[o] - this.gx, this.net.pts[o + 2] - this.gz) / this.net.vmax;
  }

  /** Runs for at most `budgetMs`; returns the outcome so far. */
  step(budgetMs: number): 'running' | 'found' | 'none' {
    if (this.outcome !== 'running') return this.outcome;
    const net = this.net;
    if (net.stamp !== this.stamp) {
      // another search took the scratch: this one is stale
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
        // a goal marker: nothing in the open list can beat it (the heuristic never overestimates)
        this.finish(-item - 1, key);
        return this.outcome;
      }
      const e = item;
      if (net.closed[e] === this.stamp) continue;
      net.closed[e] = this.stamp;
      this.expanded++;
      const v = Math.max(3, net.v[e]);
      const gEnter = net.g[e];
      const gs = this.goalMap.get(e);
      if (gs !== undefined) {
        const total = gs >= 0 ? gEnter + gs / v : gEnter + net.len[e] / v + this.frontierTail(e);
        if (total < this.bestTotal + 1e-3) this.push(total, -(e + 1));
      }
      const gEnd = gEnter + net.len[e] / v;
      for (let k = net.nextOff[e]; k < net.nextOff[e + 1]; k++) {
        const nx = net.nextIdx[k];
        if (net.closed[nx] === this.stamp) continue;
        const g2 = gEnd + enterPenalty(net, nx);
        if (net.seen[nx] === this.stamp && net.g[nx] <= g2) continue;
        net.seen[nx] = this.stamp;
        net.g[nx] = g2;
        net.parent[nx] = e;
        heap.push(g2 + this.h(nx), nx);
      }
    }
    this.outcome = 'none';
    return this.outcome;
  }

  private finish(marker: number, cost: number) {
    const net = this.net;
    const direct = marker >= net.count;
    const goalEdge = direct ? marker - net.count : marker;
    const edges: number[] = [];
    let startS = 0;
    if (direct) {
      edges.push(goalEdge);
      startS = this.srcS.get(goalEdge) ?? 0;
    } else {
      let e = goalEdge;
      for (;;) {
        edges.push(e);
        const p = net.parent[e];
        if (p <= -2) {
          const src = -p - 2;
          edges.push(src);
          startS = this.srcS.get(src) ?? 0;
          break;
        }
        if (p < 0 || edges.length > net.count) break;
        e = p;
      }
      edges.reverse();
    }
    const gs = this.goalMap.get(goalEdge) ?? -1;
    this.result = { edges, startS, endS: gs >= 0 ? gs : net.len[goalEdge], partial: gs < 0, cost };
    this.outcome = 'found';
  }
}
