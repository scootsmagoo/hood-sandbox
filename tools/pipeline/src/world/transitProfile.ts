/**
 * The transit layer, step 2: the tracks' vertical design. OSM says how a way runs (in a tunnel, on a bridge, in a cutting, its
 * layer) but not how high; the stations' platforms are held at their depths (transitStations.ts) and everything between is
 * designed on the track graph (the union of the routes' ways, densified): a smooth line pulled toward a target height for its
 * structure, kept inside the structure's bounds (a tunnel under enough cover, a viaduct over the roads it crosses) and under a
 * grade limit. Then the structure of each point is read back from the design against the ground: a tunnel where the rail is deep
 * enough for a roofed box, an open trench where it is below the ground but not that deep, the ground, or a viaduct.
 */
import type { V2 } from '../geo.js';
import type { RawRoute, RawTrack } from './transitData.js';

export type DesignKind = 'tunnel' | 'trench' | 'grade' | 'elevated';

export const PROFILE = {
  /** densify to at most this spacing, m */
  step: 6,
  /** the grade limit (rise over run): the real system's steepest is about 3%, 4% is allowed in the design */
  grade: 0.04,
  /** rail below the ground for a tunnel's box (5.2 m inside, a 0.4 m roof slab and about a metre of cover) */
  tunnelCover: 6.6,
  /** default rail depth of a tunnel by |layer| */
  tunnelDepth: [12, 12, 16, 19, 22],
  /** a viaduct's rail over the ground at the least, and over a road it crosses (clearance 5.5 m, girder 0.9 m) */
  elevatedMin: 5.0,
  roadClear: 6.4,
  /** an open trench's rail below the ground */
  trenchDepth: 6,
  /** around a change of structure the bounds give way over this distance (a portal ramp), m */
  portalM: 260,
  iterations: 500,
} as const;

export interface PVertex {
  x: number;
  z: number;
  g: number;
  target: number;
  w: number;
  lo: number;
  hi: number;
  /** a held height (a platform), or NaN */
  hold: number;
  /** what OSM says it is */
  osmKind: DesignKind;
  y: number;
  /** what the design made it */
  kind: DesignKind;
}

export interface TrackGraph {
  verts: PVertex[];
  /** vertex keys -> index */
  index: Map<string, number>;
  /** undirected edges: a, b, length */
  edges: [number, number, number][];
  adj: number[][];
}

export interface DesignInput {
  routes: RawRoute[];
  tracks: Map<number, RawTrack>;
  ground: (x: number, z: number) => number;
  /** the highest road surface over which a viaduct at (x, z) would pass, or -Infinity */
  roadUnder: (x: number, z: number) => number;
  /** a held rail height at (x, z) on a way, or NaN (station platforms) */
  hold: (x: number, z: number, way: number) => number;
  /** keep segments with an end inside this test */
  keep: (x: number, z: number) => boolean;
}

const vkey = (a: number, b: number, k: number) => (a < b ? `${a}:${b}:${k}` : `${b}:${a}:${k}`);

function osmKind(t: RawTrack): DesignKind {
  if (t.tunnel && !t.passage) return 'tunnel';
  if (t.bridge || t.passage || (t.layer >= 1 && !t.tunnel) || t.level >= 1) return 'elevated';
  if (t.cutting || t.level < 0 || t.layer < 0) return 'trench';
  return 'grade';
}

/** Builds the densified graph of every route segment that has an end the `keep` test likes. */
export function buildTrackGraph(inp: DesignInput): TrackGraph {
  const verts: PVertex[] = [];
  const index = new Map<string, number>();
  const edges: [number, number, number][] = [];
  const seen = new Set<string>();
  const vertex = (key: string, p: V2, t: RawTrack): number => {
    let i = index.get(key);
    if (i !== undefined) return i;
    i = verts.length;
    index.set(key, i);
    const g = inp.ground(p[0], p[1]);
    verts.push({ x: p[0], z: p[1], g, target: g, w: 1, lo: -Infinity, hi: Infinity, hold: NaN, osmKind: osmKind(t), y: g, kind: 'grade' });
    const h = inp.hold(p[0], p[1], t.id);
    if (Number.isFinite(h)) verts[i].hold = h;
    return i;
  };
  for (const r of inp.routes) {
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      const pa = r.pts[i], pb = r.pts[i + 1];
      if (!inp.keep(pa[0], pa[1]) && !inp.keep(pb[0], pb[1])) continue;
      const sk = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(sk)) continue;
      seen.add(sk);
      const t = inp.tracks.get(r.way[i])!;
      const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      const n = Math.max(1, Math.ceil(L / PROFILE.step));
      // keys count from the lower id's end, so both directions of travel name the same vertices
      const lowFirst = a < b;
      let prev = vertex(`n${a}`, pa, t);
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        const p: V2 = [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f];
        const cur = k === n ? vertex(`n${b}`, pb, t) : vertex(vkey(a, b, lowFirst ? k : n - k), p, t);
        edges.push([prev, cur, L / n]);
        prev = cur;
      }
    }
  }
  const adj: number[][] = verts.map(() => []);
  edges.forEach(([a, b], e) => {
    adj[a].push(e);
    adj[b].push(e);
  });
  return { verts, index, edges, adj };
}

/** Distance over the graph from every vertex to the nearest vertex where `src` is true (Dijkstra; Infinity when unreachable). */
function graphDistance(g: TrackGraph, src: (v: PVertex) => boolean): Float64Array {
  const d = new Float64Array(g.verts.length).fill(Infinity);
  const q: [number, number][] = [];
  g.verts.forEach((v, i) => {
    if (src(v)) {
      d[i] = 0;
      q.push([0, i]);
    }
  });
  // a binary heap would be faster; the graph is a few thousand vertices
  while (q.length) {
    let bi = 0;
    for (let k = 1; k < q.length; k++) if (q[k][0] < q[bi][0]) bi = k;
    const [du, u] = q[bi];
    q[bi] = q[q.length - 1];
    q.pop();
    if (du > d[u]) continue;
    for (const e of g.adj[u]) {
      const [a, b, L] = g.edges[e];
      const v = a === u ? b : a;
      if (du + L < d[v]) {
        d[v] = du + L;
        q.push([d[v], v]);
      }
    }
  }
  return d;
}

/** Designs the heights. Returns stats; the heights are in `verts[i].y` and the structure in `verts[i].kind`. */
export function designProfile(g: TrackGraph, inp: Pick<DesignInput, 'roadUnder'>): { maxGrade: number; coverShort: number; clearShort: number; held: number; worst: [number, number]; coverAt: [number, number]; clearAt: [number, number] } {
  const V = g.verts;
  // targets and bounds by what OSM says
  for (const v of V) {
    switch (v.osmKind) {
      case 'tunnel':
        v.target = v.g - PROFILE.tunnelDepth[1];
        v.hi = v.g - PROFILE.tunnelCover;
        v.w = 0.15;
        break;
      case 'elevated': {
        const road = inp.roadUnder(v.x, v.z);
        v.lo = Math.max(v.g + PROFILE.elevatedMin, road + PROFILE.roadClear);
        v.target = v.lo + 1.0;
        v.w = 0.3;
        break;
      }
      case 'trench':
        v.target = v.g - PROFILE.trenchDepth;
        v.lo = v.g - 10;
        v.hi = v.g - 2;
        v.w = 0.25;
        break;
      default:
        v.target = v.g;
        v.lo = v.g - 0.4;
        v.hi = v.g + 0.4;
        v.w = 2;
    }
  }
  // portal zones: near a change of what OSM says, the bounds give way so the track can ramp from one to the other
  const kinds: DesignKind[] = ['tunnel', 'trench', 'grade', 'elevated'];
  const dist = kinds.map((k) => graphDistance(g, (v) => v.osmKind === k));
  V.forEach((v, i) => {
    let near = Infinity;
    kinds.forEach((k, ki) => {
      if (k !== v.osmKind) near = Math.min(near, dist[ki][i]);
    });
    if (near < PROFILE.portalM) {
      const f = near / PROFILE.portalM;
      v.lo = Number.isFinite(v.lo) ? v.g - 12 + (v.lo - v.g + 12) * f : v.lo;
      v.hi = Number.isFinite(v.hi) ? v.g + 10 + (v.hi - v.g - 10) * f : v.hi;
      v.w *= f;
    }
  });
  // start from the targets (held where held)
  for (const v of V) v.y = Number.isFinite(v.hold) ? v.hold : Math.min(v.hi, Math.max(v.lo, v.target));
  const G = PROFILE.grade;
  const lam = 1.0;
  for (let it = 0; it < PROFILE.iterations; it++) {
    // Gauss-Seidel: forward, then backward
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < V.length; k++) {
        const i = pass === 0 ? k : V.length - 1 - k;
        const v = V[i];
        if (Number.isFinite(v.hold)) continue;
        let sum = 0, n = 0;
        for (const e of g.adj[i]) {
          const [a, b] = g.edges[e];
          sum += V[a === i ? b : a].y;
          n++;
        }
        let y = n ? (v.w * v.target + lam * sum) / (v.w + lam * n) : v.target;
        y = Math.min(v.hi, Math.max(v.lo, y));
        v.y = y;
      }
    }
    // the grade limit, relaxed edge by edge (held vertices do not move)
    for (let rep = 0; rep < 2; rep++) {
      for (const [a, b, L] of g.edges) {
        const va = V[a], vb = V[b];
        const d = vb.y - va.y, m = G * L;
        if (Math.abs(d) <= m) continue;
        const ex = Math.abs(d) - m;
        const fa = Number.isFinite(va.hold) ? 0 : Number.isFinite(vb.hold) ? 1 : 0.5;
        const fb = 1 - fa;
        if (Number.isFinite(va.hold) && Number.isFinite(vb.hold)) continue;
        const s = Math.sign(d);
        va.y += s * ex * fa;
        vb.y -= s * ex * fb;
      }
    }
  }
  // the grade limit, strictly: every vertex inside the band the held vertices allow (the lowest and highest a line at the grade
  // limit from any held vertex reaches, over the graph), then free neighbours relaxed toward each other within the band
  const env = (sign: 1 | -1): Float64Array => {
    const val = new Float64Array(V.length).fill(sign > 0 ? Infinity : -Infinity);
    const q: [number, number][] = [];
    V.forEach((v, i) => {
      if (Number.isFinite(v.hold)) {
        val[i] = v.hold;
        q.push([v.hold * sign, i]);
      }
    });
    while (q.length) {
      let bi = 0;
      for (let k = 1; k < q.length; k++) if (q[k][0] < q[bi][0]) bi = k;
      const [, u] = q[bi];
      q[bi] = q[q.length - 1];
      q.pop();
      for (const e of g.adj[u]) {
        const [a, c, L] = g.edges[e];
        const w = a === u ? c : a;
        const cand = val[u] + sign * G * L;
        if (sign > 0 ? cand < val[w] - 1e-9 : cand > val[w] + 1e-9) {
          val[w] = cand;
          q.push([cand * sign, w]);
        }
      }
    }
    return val;
  };
  const hiEnv = env(1), loEnv = env(-1);
  const clampEnv = (i: number) => {
    V[i].y = Math.min(hiEnv[i], Math.max(loEnv[i], V[i].y));
  };
  V.forEach((_, i) => clampEnv(i));
  for (let rep = 0; rep < 4000; rep++) {
    let moved = false;
    for (const [a, b, L] of g.edges) {
      const va = V[a], vb = V[b];
      const m = G * L;
      const d = vb.y - va.y;
      if (Math.abs(d) <= m + 1e-6) continue;
      const ex = Math.abs(d) - m;
      const ha = Number.isFinite(va.hold), hb = Number.isFinite(vb.hold);
      if (ha && hb) continue;
      const fa = ha ? 0 : hb ? 1 : 0.5;
      va.y += Math.sign(d) * ex * fa;
      vb.y -= Math.sign(d) * ex * (1 - fa);
      clampEnv(a);
      clampEnv(b);
      moved = true;
    }
    if (!moved) break;
  }
  // structure from the design
  for (const v of V) {
    const d = v.y - v.g;
    v.kind = d <= -PROFILE.tunnelCover + 0.3 ? 'tunnel' : d < -0.6 ? 'trench' : d <= 0.6 ? 'grade' : 'elevated';
  }
  // smooth the structure along the graph: a run shorter than 12 m takes its neighbours' kind
  for (let rep = 0; rep < 3; rep++) {
    for (let i = 0; i < V.length; i++) {
      const nb = g.adj[i].map((e) => (g.edges[e][0] === i ? g.edges[e][1] : g.edges[e][0]));
      if (nb.length === 2 && V[nb[0]].kind === V[nb[1]].kind && V[nb[0]].kind !== V[i].kind) {
        const other = V[nb[0]].kind;
        // a tunnel's roof needs the cover: never call something shallow a tunnel
        if (other === 'tunnel' && V[i].y - V[i].g > -PROFILE.tunnelCover + 1.2) continue;
        V[i].kind = other;
      }
    }
  }
  let maxGrade = 0, coverShort = 0, clearShort = 0, held = 0;
  let worst: [number, number] = [0, 0], coverAt: [number, number] = [0, 0], clearAt: [number, number] = [0, 0];
  for (const [a, b, L] of g.edges) {
    const gr = Math.abs(V[b].y - V[a].y) / L;
    if (gr > maxGrade) {
      maxGrade = gr;
      worst = [V[a].x, V[a].z];
    }
  }
  for (const v of V) {
    if (Number.isFinite(v.hold)) held++;
    const cs = v.y - (v.g - PROFILE.tunnelCover);
    if (v.osmKind === 'tunnel' && v.kind !== 'tunnel' && cs > coverShort) { coverShort = cs; coverAt = [v.x, v.z]; }
    if (v.osmKind === 'elevated' && v.lo - v.y > clearShort) { clearShort = v.lo - v.y; clearAt = [v.x, v.z]; }
  }
  return { maxGrade, coverShort, clearShort, held, worst, coverAt, clearAt };
}

/** The designed height and structure along a route's chain: one entry per graph vertex the chain passes, in order. */
export function routeVertices(g: TrackGraph, r: RawRoute): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < r.nodes.length; i++) {
    const a = r.nodes[i], b = r.nodes[i + 1];
    const ia = g.index.get(`n${a}`);
    const ib = g.index.get(`n${b}`);
    if (ia === undefined || ib === undefined) continue;
    const pa = r.pts[i], pb = r.pts[i + 1];
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const n = Math.max(1, Math.ceil(L / PROFILE.step));
    if (out.length === 0 || out[out.length - 1] !== ia) out.push(ia);
    const lowFirst = a < b;
    for (let k = 1; k < n; k++) {
      const vi = g.index.get(vkey(a, b, lowFirst ? k : n - k));
      if (vi !== undefined) out.push(vi);
    }
    out.push(ib);
  }
  return out;
}
