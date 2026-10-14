import type { V2 } from '../geo.js';

/**
 * Vertical profiles of the roads that lie on the ground.
 *
 * The 3DEP ground is a bare-earth model, so a street that crosses a freeway cut or a ravine drops into
 * it and climbs out again, which no car can drive. This module gives every node of the at-grade road
 * network one design height:
 *
 *   1. A dip in the terrain narrower than the closing radius (a cut, a ravine, an underpass the street
 *      really bridges) is filled in along the roads, by a morphological closing over the road graph.
 *   2. The heights are then fitted to the terrain with a vertical curvature penalty (smooth vertical
 *      curves), and projected onto a grade limit per road class. Nodes are shared between roads, so
 *      two roads that meet always meet at the same height.
 *   3. Where the design height ends up well above the terrain (more than `deckFill`) the road is on a
 *      bridge: those runs are reported as deck spans, and the terrain below them is left alone.
 *      Everywhere else the terrain is cut and filled to the design height (`carveTerrain`).
 */

export interface ProfileWay {
  nodeIds: number[];
  pts: V2[];
  /** largest allowed grade (rise over run), by road class */
  maxGrade: number;
}

export interface ProfileOptions {
  terrain: (x: number, z: number) => number;
  /** Heights some nodes (by OSM node id) have to be near, with their weight against the terrain fit (1 per node): where a bridge needs the road to arrive at a certain height. */
  wanted?: Map<number, { y: number; weight: number }>;
  /** Dips narrower than about twice this (m, along the roads) are bridged. */
  closingRadius: number;
  /** A closing at least this far above the terrain marks a dip. */
  dipDepth: number;
  /** Weight of the vertical curvature term against the terrain fit (see `fitProfile`). */
  smoothness: number;
  /** Design height this far above the terrain (m) or more: a deck, not an embankment. */
  deckFill: number;
  /** Decks longer than this (m) are not made: a long fill is an embankment, not a bridge. */
  maxDeckLength: number;
  /** Outer rounds of fit and grade projection. */
  rounds: number;
}

export const DEFAULT_PROFILE_OPTIONS = {
  closingRadius: 40,
  dipDepth: 1.2,
  smoothness: 600,
  deckFill: 3.0,
  maxDeckLength: 160,
  rounds: 6,
};

export interface DeckSpan {
  /** index into the ways passed in */
  way: number;
  /** node index range inside that way, inclusive; the end nodes are the anchors on the ground */
  from: number;
  to: number;
}

export interface ProfileResult {
  /** design height per way and node */
  h: number[][];
  /** terrain height per way and node */
  t: number[][];
  decks: DeckSpan[];
  stats: {
    nodes: number;
    edges: number;
    dipNodes: number;
    deckSpans: number;
    deckMetres: number;
    maxGradeExcess: number;
    /** percentiles of |design - terrain| over the nodes */
    deviationP50: number;
    deviationP95: number;
    deviationMax: number;
  };
}

interface Edge { j: number; len: number }

/** Ids of nodes that were made up by densifying (negative) are unique per call site, so they never join two ways. */
export function solveProfiles(ways: ProfileWay[], user: Partial<ProfileOptions> & Pick<ProfileOptions, 'terrain'>): ProfileResult {
  const o = { ...DEFAULT_PROFILE_OPTIONS, ...user };
  const index = new Map<number, number>();
  const px: number[] = [];
  const pz: number[] = [];
  const wayNodes: number[][] = ways.map((w) =>
    w.nodeIds.map((id, i) => {
      let k = index.get(id);
      if (k === undefined) {
        k = px.length;
        index.set(id, k);
        px.push(w.pts[i][0]);
        pz.push(w.pts[i][1]);
      }
      return k;
    }),
  );
  const n = px.length;
  const adj: Edge[][] = Array.from({ length: n }, () => []);
  interface E { a: number; b: number; len: number; g: number }
  const edges: E[] = [];
  ways.forEach((w, wi) => {
    const wn = wayNodes[wi];
    for (let i = 0; i + 1 < wn.length; i++) {
      const a = wn[i], b = wn[i + 1];
      if (a === b) continue;
      const len = Math.max(0.5, Math.hypot(px[a] - px[b], pz[a] - pz[b]));
      adj[a].push({ j: b, len });
      adj[b].push({ j: a, len });
      edges.push({ a, b, len, g: w.maxGrade });
    }
  });
  // a node shared by roads of different classes takes the strictest grade
  const t = new Float64Array(n);
  for (let k = 0; k < n; k++) t[k] = o.terrain(px[k], pz[k]);

  // 1. closing over the graph. A road that ends would have a truncated window there, and on a slope a truncated closing
  // reads as a dip, so every dead end is continued straight on for the length of the window, with the terrain sampled
  // beyond it (these virtual nodes are only used here).
  const SEG = 5;
  const extra = { x: [] as number[], z: [] as number[], t: [] as number[], from: [] as number[] };
  const adjX: Edge[][] = adj.map((a) => a.slice());
  const addVirtual = (end: number, nb: number) => {
    const dx = px[end] - px[nb], dz = pz[end] - pz[nb];
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return;
    let prev = end;
    for (let m = 1; m * SEG <= o.closingRadius + SEG; m++) {
      const id = n + extra.x.length;
      const x = px[end] + (dx / l) * SEG * m, z = pz[end] + (dz / l) * SEG * m;
      extra.x.push(x); extra.z.push(z); extra.t.push(o.terrain(x, z)); extra.from.push(prev);
      adjX[id] = [{ j: prev, len: SEG }];
      adjX[prev].push({ j: id, len: SEG });
      prev = id;
    }
  };
  for (let k = 0; k < n; k++) if (adj[k].length === 1) addVirtual(k, adj[k][0].j);
  const total = n + extra.x.length;
  const tAll = new Float64Array(total);
  tAll.set(t);
  for (let i = 0; i < extra.t.length; i++) tAll[n + i] = extra.t[i];
  const ballMax = (src: Float64Array, radius: number, op: 'max' | 'min'): Float64Array => {
    const out = new Float64Array(total);
    const dist = new Map<number, number>();
    for (let s = 0; s < total; s++) {
      dist.clear();
      dist.set(s, 0);
      const stack = [s];
      let best = src[s];
      while (stack.length) {
        const k = stack.pop()!;
        const dk = dist.get(k)!;
        for (const e of adjX[k]) {
          const d = dk + e.len;
          if (d > radius) continue;
          const old = dist.get(e.j);
          if (old === undefined || d < old) {
            dist.set(e.j, d);
            stack.push(e.j);
          }
        }
      }
      for (const j of dist.keys()) best = op === 'max' ? Math.max(best, src[j]) : Math.min(best, src[j]);
      out[s] = best;
    }
    return out;
  };
  const dil = ballMax(tAll, o.closingRadius, 'max');
  const closing = ballMax(dil, o.closingRadius, 'min');
  const target = Float64Array.from(t);
  const dip = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (closing[k] - t[k] > o.dipDepth) dip[k] = 1;
  // grow the dip by one node, so the shoulders of a cut follow the closing too
  const grown = Uint8Array.from(dip);
  for (let k = 0; k < n; k++) if (dip[k]) for (const e of adj[k]) if (closing[e.j] - t[e.j] > 0.3) grown[e.j] = 1;
  let dipNodes = 0;
  for (let k = 0; k < n; k++) {
    if (grown[k]) { target[k] = closing[k]; dipNodes++; }
  }

  // 2. fit and project
  const weight = new Float64Array(n).fill(1);
  if (o.wanted) {
    for (const [id, w] of o.wanted) {
      const k = index.get(id);
      if (k === undefined) continue;
      target[k] = w.y;
      weight[k] = w.weight;
    }
  }
  const h = fitProfile(wayNodes, px, pz, edges, target, o.smoothness, o.rounds, weight);

  // 3. deck spans
  const decks: DeckSpan[] = [];
  let deckMetres = 0;
  ways.forEach((w, wi) => {
    const wn = wayNodes[wi];
    const m = wn.length;
    let i = 0;
    while (i < m) {
      if (h[wn[i]] - t[wn[i]] <= o.deckFill) { i++; continue; }
      let j = i;
      while (j + 1 < m && h[wn[j + 1]] - t[wn[j + 1]] > o.deckFill) j++;
      const from = Math.max(0, i - 1);
      const to = Math.min(m - 1, j + 1);
      let len = 0;
      for (let q = from; q < to; q++) len += Math.hypot(w.pts[q + 1][0] - w.pts[q][0], w.pts[q + 1][1] - w.pts[q][1]);
      if (len <= o.maxDeckLength) {
        decks.push({ way: wi, from, to });
        deckMetres += len;
      }
      i = j + 1;
    }
  });

  let excess = 0;
  for (const e of edges) excess = Math.max(excess, Math.abs(h[e.a] - h[e.b]) / e.len - e.g);
  const dev: number[] = [];
  for (let k = 0; k < n; k++) dev.push(Math.abs(h[k] - t[k]));
  dev.sort((a, b) => a - b);
  const pct = (p: number) => (dev.length ? dev[Math.min(dev.length - 1, Math.floor(dev.length * p))] : 0);

  return {
    h: wayNodes.map((wn) => wn.map((k) => h[k])),
    t: wayNodes.map((wn) => wn.map((k) => t[k])),
    decks,
    stats: {
      nodes: n, edges: edges.length, dipNodes, deckSpans: decks.length, deckMetres, maxGradeExcess: excess,
      deviationP50: pct(0.5), deviationP95: pct(0.95), deviationMax: dev.length ? dev[dev.length - 1] : 0,
    },
  };
}

/**
 * Least-squares fit of heights to `target` with a vertical curvature penalty, alternated with a
 * projection onto the grade limits of every edge. Ends with the projection, so the grade limits hold.
 */
export function fitProfile(
  wayNodes: number[][],
  px: number[],
  pz: number[],
  edges: { a: number; b: number; len: number; g: number }[],
  target: Float64Array,
  smoothness: number,
  rounds: number,
  weight?: Float64Array,
): Float64Array {
  const n = target.length;
  const wd = weight ?? new Float64Array(n).fill(1);
  // curvature triples: coefficients of (h_a, h_b, h_c) for the second difference, weighted by sqrt(smoothness * m)
  const ta: number[] = [], tb: number[] = [], tc: number[] = [];
  const ca: number[] = [], cb: number[] = [], cc: number[] = [], tw: number[] = [];
  for (const wn of wayNodes) {
    for (let i = 1; i + 1 < wn.length; i++) {
      const a = wn[i - 1], b = wn[i], c = wn[i + 1];
      if (a === b || b === c || a === c) continue;
      const l1 = Math.max(0.5, Math.hypot(px[b] - px[a], pz[b] - pz[a]));
      const l2 = Math.max(0.5, Math.hypot(px[c] - px[b], pz[c] - pz[b]));
      const m = (l1 + l2) / 2;
      ta.push(a); tb.push(b); tc.push(c);
      ca.push(1 / (l1 * m)); cc.push(1 / (l2 * m)); cb.push(-(1 / l1 + 1 / l2) / m);
      tw.push(smoothness * m);
    }
  }
  const T = ta.length;
  const apply = (x: Float64Array, y: Float64Array) => {
    for (let k = 0; k < n; k++) y[k] = wd[k] * x[k];
    for (let q = 0; q < T; q++) {
      const s = ca[q] * x[ta[q]] + cb[q] * x[tb[q]] + cc[q] * x[tc[q]];
      const w = tw[q] * s;
      y[ta[q]] += w * ca[q];
      y[tb[q]] += w * cb[q];
      y[tc[q]] += w * cc[q];
    }
  };
  const diag = Float64Array.from(wd);
  for (let q = 0; q < T; q++) {
    diag[ta[q]] += tw[q] * ca[q] * ca[q];
    diag[tb[q]] += tw[q] * cb[q] * cb[q];
    diag[tc[q]] += tw[q] * cc[q] * cc[q];
  }
  const fit = (rhs: Float64Array, x: Float64Array) => {
    // preconditioned conjugate gradients on (I + A' W A) x = rhs
    const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), ap = new Float64Array(n);
    apply(x, ap);
    for (let k = 0; k < n; k++) { r[k] = rhs[k] - ap[k]; z[k] = r[k] / diag[k]; p[k] = z[k]; }
    let rz = 0;
    for (let k = 0; k < n; k++) rz += r[k] * z[k];
    for (let it = 0; it < 400 && rz > 1e-14; it++) {
      apply(p, ap);
      let pap = 0;
      for (let k = 0; k < n; k++) pap += p[k] * ap[k];
      if (pap <= 0) break;
      const alpha = rz / pap;
      let rz2 = 0;
      for (let k = 0; k < n; k++) { x[k] += alpha * p[k]; r[k] -= alpha * ap[k]; z[k] = r[k] / diag[k]; rz2 += r[k] * z[k]; }
      const beta = rz2 / rz;
      rz = rz2;
      for (let k = 0; k < n; k++) p[k] = z[k] + beta * p[k];
    }
  };
  const project = (h: Float64Array, sweeps: number) => {
    for (let s = 0; s < sweeps; s++) {
      let worst = 0;
      for (let q = 0; q < edges.length; q++) {
        const e = edges[s % 2 === 0 ? q : edges.length - 1 - q];
        const lim = e.g * e.len;
        const d = h[e.b] - h[e.a];
        const ex = Math.abs(d) - lim;
        if (ex > 0) {
          // the node with the stronger wish to stay (a bridge end) moves less
          const ia = 1 / wd[e.a], ib = 1 / wd[e.b];
          const sgn = Math.sign(d) * 1.02 * ex;
          h[e.a] += sgn * (ia / (ia + ib));
          h[e.b] -= sgn * (ib / (ia + ib));
          if (ex > worst) worst = ex;
        }
      }
      if (worst < 1e-4) break;
    }
  };

  const rhs = new Float64Array(n);
  for (let k = 0; k < n; k++) rhs[k] = wd[k] * target[k];
  const h = Float64Array.from(target);
  fit(rhs, h);
  project(h, 400);
  for (let r = 1; r < rounds; r++) {
    // pull back towards the terrain where the grade limit is not active, then project again
    fit(rhs, h);
    project(h, 400);
  }
  project(h, 3000);
  return h;
}

/** Percentile helper for reports. */
export function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}
