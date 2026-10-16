/**
 * The airport of a city (`aeroway.json`, written by tools/pipeline/src/world/aerowayGraph.ts next to the city's index.json; the
 * index names it as `aeroway`): the taxi graph the aircraft move on, the runways and their ends, the stands, the runway holding
 * positions, the airfield lights and the map. Parsing and the graph's queries only: pure, no I/O, shared by the sim
 * (src/sim/aircraft) and the client (the lights, the map layer).
 */

export type AeroEdgeKind = 'runway' | 'taxiway' | 'taxilane' | 'leadin';
export type AircraftClass = 'narrowbody' | 'widebody' | 'regional';

export interface AeroEdge {
  a: number;
  b: number;
  kind: AeroEdgeKind;
  ref: string | null;
  width: number;
  len: number;
  /** flat [x, y, z, ...] from node a to node b */
  pts: number[];
}
export interface RunwayEnd {
  ref: string;
  end: [number, number, number];
  threshold: [number, number, number];
  /** unit direction along the runway from this end, (dx, dz) */
  dir: [number, number];
  /** the graph nodes on the centreline, ordered from this end */
  nodes: number[];
}
export interface AeroRunway {
  ref: string;
  width: number;
  length: number;
  ends: [RunwayEnd, RunwayEnd];
}
export interface AeroStand {
  ref: string;
  gate: string | null;
  hero: string | null;
  /** where the nose gear stops */
  node: number;
  /** where the lead-in leaves the taxi network */
  entry: number;
  /** the parked nose: (sin yaw, cos yaw) */
  yaw: number;
  size: AircraftClass;
  cargo: boolean;
}
export interface AerowayData {
  format: 'hood-aeroway';
  version: 1;
  icao: string;
  name: string;
  runways: AeroRunway[];
  nodes: [number, number, number][];
  edges: AeroEdge[];
  stands: AeroStand[];
  holds: { node: number; runway: number; ils: boolean }[];
  /** flat [x, y, z, ...] per kind (`approach`: [x, y, z, d, ...], d the distance before the threshold) */
  lights: Record<string, number[]>;
  map: {
    runways: number[][];
    taxiways: { w: number; pts: number[] }[];
    aprons: number[][];
    buildings: { name: string; ring: number[] }[];
    labels: { name: string; x: number; z: number; kind: string }[];
  };
}

export function parseAeroway(json: unknown): AerowayData {
  const j = json as Partial<AerowayData> | null;
  if (!j || j.format !== 'hood-aeroway' || j.version !== 1) throw new Error('aeroway.json: not a hood-aeroway file');
  if (!Array.isArray(j.nodes) || !Array.isArray(j.edges) || !Array.isArray(j.runways) || !Array.isArray(j.stands)) throw new Error('aeroway.json: incomplete');
  return {
    format: 'hood-aeroway',
    version: 1,
    icao: j.icao ?? '',
    name: j.name ?? '',
    runways: j.runways,
    nodes: j.nodes,
    edges: j.edges,
    stands: j.stands,
    holds: j.holds ?? [],
    lights: j.lights ?? {},
    map: j.map ?? { runways: [], taxiways: [], aprons: [], buildings: [], labels: [] },
  };
}

/** The graph's adjacency and its shortest paths. */
export class AeroGraph {
  /** per node: the edges at it */
  readonly adj: number[][];
  constructor(readonly data: AerowayData) {
    this.adj = data.nodes.map(() => []);
    data.edges.forEach((e, i) => {
      this.adj[e.a].push(i);
      if (e.b !== e.a) this.adj[e.b].push(i);
    });
  }

  other(ei: number, n: number): number {
    const e = this.data.edges[ei];
    return e.a === n ? e.b : e.a;
  }

  /**
   * The shortest path from `from` to `to` (A*, by length; `allow` says which edges may be used, `cost` may weigh them). Returns
   * the edges in order with the node each is entered from, or null.
   */
  route(from: number, to: number, allow: (ei: number) => boolean, cost: (ei: number) => number = (ei) => this.data.edges[ei].len): { edges: number[]; nodes: number[] } | null {
    if (from === to) return { edges: [], nodes: [from] };
    const N = this.data.nodes;
    const n = N.length;
    const g = new Float64Array(n).fill(Infinity);
    const via = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const tx = N[to][0], tz = N[to][2];
    const h = (i: number) => Math.hypot(N[i][0] - tx, N[i][2] - tz);
    // a binary heap of (f, node)
    const heap: number[] = [];
    const fOf: number[] = [];
    const push = (f: number, i: number) => {
      heap.push(i);
      fOf.push(f);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (fOf[p] < fOf[k] || (fOf[p] === fOf[k] && heap[p] <= heap[k])) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        [fOf[p], fOf[k]] = [fOf[k], fOf[p]];
        k = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!, lf = fOf.pop()!;
      if (heap.length) {
        heap[0] = last;
        fOf[0] = lf;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && (fOf[l] < fOf[m] || (fOf[l] === fOf[m] && heap[l] < heap[m]))) m = l;
          if (r < heap.length && (fOf[r] < fOf[m] || (fOf[r] === fOf[m] && heap[r] < heap[m]))) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          [fOf[m], fOf[k]] = [fOf[k], fOf[m]];
          k = m;
        }
      }
      return top;
    };
    g[from] = 0;
    push(h(from), from);
    while (heap.length) {
      const u = pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === to) break;
      for (const ei of this.adj[u]) {
        if (!allow(ei)) continue;
        const v = this.other(ei, u);
        const w = g[u] + cost(ei);
        if (w < g[v]) {
          g[v] = w;
          via[v] = ei;
          push(w + h(v), v);
        }
      }
    }
    if (!done[to]) return null;
    const edges: number[] = [];
    const nodes: number[] = [to];
    for (let v = to; v !== from; ) {
      const ei = via[v];
      edges.push(ei);
      v = this.other(ei, v);
      nodes.push(v);
    }
    edges.reverse();
    nodes.reverse();
    return { edges, nodes };
  }

  /** The polyline [x, y, z][] of a route (its edges' points, oriented from node to node, joints not repeated). */
  polyline(route: { edges: number[]; nodes: number[] }): [number, number, number][] {
    const out: [number, number, number][] = [];
    route.edges.forEach((ei, k) => {
      const e = this.data.edges[ei];
      const pts: [number, number, number][] = [];
      for (let i = 0; i + 2 < e.pts.length; i += 3) pts.push([e.pts[i], e.pts[i + 1], e.pts[i + 2]]);
      if (e.a !== route.nodes[k]) pts.reverse();
      for (let i = out.length ? 1 : 0; i < pts.length; i++) out.push(pts[i]);
    });
    if (!out.length && route.nodes.length) out.push([...this.data.nodes[route.nodes[0]]] as [number, number, number]);
    return out;
  }
}

/**
 * Where an aircraft parked on a stand stands: its origin (the main gear's centre) a wheelbase behind the stand's mark (where the
 * nose gear stops), nose along the stand's yaw.
 */
export function standPose(d: AerowayData, st: AeroStand, wheelbase: number): { x: number; y: number; z: number; yaw: number } {
  const n = d.nodes[st.node];
  return { x: n[0] - Math.sin(st.yaw) * wheelbase, y: n[1], z: n[2] - Math.cos(st.yaw) * wheelbase, yaw: st.yaw };
}

/** Cuts the last `len` metres off a polyline (x, y, z) (keeps at least its first point). */
export function trimEnd<T extends number[]>(pts: T[], len: number): T[] {
  let left = len;
  const out = pts.slice();
  while (out.length > 1 && left > 0) {
    const a = out[out.length - 2], b = out[out.length - 1];
    const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (l <= left) {
      out.pop();
      left -= l;
      continue;
    }
    const t = (l - left) / l;
    out[out.length - 1] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as unknown as T;
    left = 0;
  }
  return out;
}
