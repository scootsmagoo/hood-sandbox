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
  /** half the carriageway's width (m); roads whose carriageways overlap side by side are held to one height there */
  halfWidth?: number;
  /** which of two roads that meet is the greater (class, then width): a lesser road is level with a greater one across its carriageway */
  rank?: number;
  /** design speed, km/h: the vertical curves are at least as long as it needs (see `curveLimits`) */
  speed?: number;
  /**
   * A mapped bridge or viaduct: its nodes (those it shares with no road on the ground) are fitted to `target` (the height the
   * deck would like, clear of what passes under it) with `targetWeight` instead of to the terrain, take no part in the dip
   * closing and never make deck spans of their own. Designed with the ground roads in one solve, a deck meets the roads it
   * lands on and forks from at their height, with the same grade and vertical-curve limits as they have.
   */
  deck?: { target: number[]; targetWeight?: number; weights?: number[] };
}

/** The deck node must stand at least `gap` above the lower node (or above a fixed height): a road, a railway or a path under a deck. */
export interface Clearance { upper: [way: number, node: number]; lower: [way: number, node: number] | number; gap: number }

/** Crest K (m of curve per % of grade change) for stopping sight distance, by design speed in km/h (AASHTO, metric). */
const CREST_K: [number, number][] = [[20, 1], [30, 2], [40, 4], [50, 7], [60, 11], [70, 17], [80, 26], [90, 39], [100, 52], [110, 74], [120, 95]];

/**
 * The sharpest vertical curvature (1/m) a road may have at a crest and at a sag, for a design speed (km/h). Crests use the
 * stopping-sight-distance K values of highway design (a curve of radius 100 K m); sags the comfort rule K = V^2 / 395. Neither is
 * ever sharper than a radius of 180 m, which a car takes at 35 m/s with its wheels down (v^2 / R under 0.7 g).
 */
export function curveLimits(speed: number): { crest: number; sag: number } {
  let k = CREST_K[CREST_K.length - 1][1];
  for (let i = 0; i + 1 < CREST_K.length; i++) {
    const [v0, k0] = CREST_K[i], [v1, k1] = CREST_K[i + 1];
    if (speed <= v0) { k = k0; break; }
    if (speed <= v1) { k = k0 + ((k1 - k0) * (speed - v0)) / (v1 - v0); break; }
  }
  const crestR = Math.max(180, 100 * k);
  const sagR = Math.max(180, (100 * speed * speed) / 395);
  return { crest: 1 / crestR, sag: 1 / sagR };
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
  /** Clearances under the decks among `ways` (way and node indices into them). */
  clearances?: Clearance[];
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
    /** pairs of side-by-side nodes of overlapping carriageways held to one height */
    ties: number;
    /** clearance constraints under decks, and the most any of them is short at the end (m) */
    clearances: number;
    clearanceShort: number;
    /** side-by-side ties left to the fit alone near a grade or clearance that could not be kept */
    softTies: number;
    /** vertical curves that gave way to a grade or a clearance (see `PHYSICAL_CURVE`) */
    relaxedCurves: number;
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
  // the ground network alone (the decks take no part in the dip closing), and the nodes only decks have
  const adjG: Edge[][] = Array.from({ length: n }, () => []);
  const deckOnly = new Uint8Array(n).fill(1);
  ways.forEach((w, wi) => {
    if (w.deck) return;
    const wn = wayNodes[wi];
    for (const k of wn) deckOnly[k] = 0;
    for (let i = 0; i + 1 < wn.length; i++) {
      const a = wn[i], b = wn[i + 1];
      if (a === b) continue;
      const len = Math.max(0.5, Math.hypot(px[a] - px[b], pz[a] - pz[b]));
      adjG[a].push({ j: b, len });
      adjG[b].push({ j: a, len });
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
  const adjX: Edge[][] = adjG.map((a) => a.slice());
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
  for (let k = 0; k < n; k++) if (adjG[k].length === 1) addVirtual(k, adjG[k][0].j);
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
  for (let k = 0; k < n; k++) if (!deckOnly[k] && closing[k] - t[k] > o.dipDepth) dip[k] = 1;
  // grow the dip by one node, so the shoulders of a cut follow the closing too
  const grown = Uint8Array.from(dip);
  for (let k = 0; k < n; k++) if (dip[k]) for (const e of adjG[k]) if (closing[e.j] - t[e.j] > 0.3) grown[e.j] = 1;
  let dipNodes = 0;
  for (let k = 0; k < n; k++) {
    if (grown[k]) { target[k] = closing[k]; dipNodes++; }
  }

  // 2. fit and project
  const weight = new Float64Array(n).fill(1);
  ways.forEach((w, wi) => {
    if (!w.deck) return;
    wayNodes[wi].forEach((k, i) => {
      if (!deckOnly[k]) return;
      target[k] = w.deck!.target[i];
      weight[k] = w.deck!.weights?.[i] ?? w.deck!.targetWeight ?? DECK_TARGET_WEIGHT;
    });
  });
  if (o.wanted) {
    for (const [id, w] of o.wanted) {
      const k = index.get(id);
      if (k === undefined) continue;
      target[k] = w.y;
      weight[k] = w.weight;
    }
  }
  // a deck and a way it passes over are one over the other, never side by side (a shallow crossing reads as both)
  const crossing = new Set<string>();
  for (const c of o.clearances ?? []) if (typeof c.lower !== 'number') crossing.add(`${Math.min(c.upper[0], c.lower[0])},${Math.max(c.upper[0], c.lower[0])}`);
  const ties = overlapTies(ways, wayNodes, px, pz, adj, target, deckOnly, crossing);
  ties.push(...junctionTies(ways, wayNodes, px, pz));
  const above: { u: number; l: number; y: number; gap: number }[] = [];
  for (const c of o.clearances ?? []) {
    const u = wayNodes[c.upper[0]][c.upper[1]];
    if (typeof c.lower === 'number') above.push({ u, l: -1, y: c.lower, gap: c.gap });
    else { const l = wayNodes[c.lower[0]][c.lower[1]]; if (l !== u) above.push({ u, l, y: 0, gap: c.gap }); }
  }
  const curves: Curve[] = [];
  ways.forEach((w, wi) => {
    if (!w.speed) return;
    const lim = curveLimits(w.speed);
    const wn = wayNodes[wi];
    for (let i = 1; i + 1 < wn.length; i++) {
      const a = wn[i - 1], b = wn[i], c = wn[i + 1];
      if (a === b || b === c || a === c) continue;
      const l1 = Math.max(0.5, Math.hypot(px[b] - px[a], pz[b] - pz[a])), l2 = Math.max(0.5, Math.hypot(px[c] - px[b], pz[c] - pz[b]));
      curves.push({ a, b, c, l1, l2, crest: lim.crest, sag: lim.sag });
    }
  });
  curves.push(...joinCurves(ways, wayNodes, px, pz));
  let h = fitProfile(wayNodes, px, pz, edges, target, o.smoothness, o.rounds, weight, ties, curves, above);
  // Where the sight-distance curves leave no room for a grade limit or a clearance (a motorway that must climb over a street
  // twenty metres past the end of its bridge), they give way, near there, to the curvature a car keeps its wheels down on.
  let relaxedCurves = 0, softTies = 0;
  for (let it = 0; it < RELAX_ROUNDS; it++) {
    const bad = new Map<string, number[]>();
    const mark = (k: number) => {
      const key = `${Math.floor(px[k] / RELAX_R)},${Math.floor(pz[k] / RELAX_R)}`;
      const l = bad.get(key);
      if (l) l.push(k); else bad.set(key, [k]);
    };
    for (const e of edges) if (Math.abs(h[e.a] - h[e.b]) - e.g * e.len > 0.01) { mark(e.a); mark(e.b); }
    for (const c of above) {
      if ((c.l < 0 ? c.y : h[c.l]) + c.gap - h[c.u] <= 0.05) continue;
      mark(c.u);
      if (c.l >= 0) mark(c.l);
    }
    if (!bad.size) break;
    const nearBad = (k: number) => {
      const gx = Math.floor(px[k] / RELAX_R), gz = Math.floor(pz[k] / RELAX_R);
      for (let i = gx - 1; i <= gx + 1; i++) for (let j = gz - 1; j <= gz + 1; j++) {
        for (const q of bad.get(`${i},${j}`) ?? []) if (Math.hypot(px[q] - px[k], pz[q] - pz[k]) < RELAX_R) return true;
      }
      return false;
    };
    let changed = 0;
    // and the side-by-side ties there are only wishes (a ramp held to a road that has to climb onto a bridge over it)
    for (const t of ties) if (!t.soft && (nearBad(t.a) || nearBad(t.b))) { t.soft = true; changed++; softTies++; }
    for (const cv of curves) {
      if (cv.crest >= PHYSICAL_CURVE && cv.sag >= PHYSICAL_CURVE) continue;
      if (!nearBad(cv.b)) continue;
      cv.crest = Math.max(cv.crest, PHYSICAL_CURVE);
      cv.sag = Math.max(cv.sag, PHYSICAL_CURVE);
      changed++;
    }
    if (!changed) break;
    relaxedCurves += changed;
    h = fitProfile(wayNodes, px, pz, edges, target, o.smoothness, o.rounds, weight, ties, curves, above);
  }

  // 3. deck spans
  const decks: DeckSpan[] = [];
  let deckMetres = 0;
  ways.forEach((w, wi) => {
    if (w.deck) return;
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
  for (let k = 0; k < n; k++) if (!deckOnly[k]) dev.push(Math.abs(h[k] - t[k]));
  let short = 0;
  for (const c of above) short = Math.max(short, c.y + c.gap - h[c.u] + (c.l >= 0 ? h[c.l] - c.y : 0));
  dev.sort((a, b) => a - b);
  const pct = (p: number) => (dev.length ? dev[Math.min(dev.length - 1, Math.floor(dev.length * p))] : 0);

  return {
    h: wayNodes.map((wn) => wn.map((k) => h[k])),
    t: wayNodes.map((wn) => wn.map((k) => t[k])),
    decks,
    stats: {
      nodes: n, edges: edges.length, dipNodes, deckSpans: decks.length, deckMetres, maxGradeExcess: excess, ties: ties.length, relaxedCurves, softTies, clearances: above.length, clearanceShort: Math.max(0, short),
      deviationP50: pct(0.5), deviationP95: pct(0.95), deviationMax: dev.length ? dev[dev.length - 1] : 0,
    },
  };
}

/** Two nodes of overlapping carriageways held to one height with weight `w`; a soft one only in the fit, not the projection. */
export interface Tie { a: number; b: number; w: number; soft?: boolean }

/** Three consecutive nodes of a way and the sharpest crest and sag curvature allowed through them (1/m). */
export interface Curve { a: number; b: number; c: number; l1: number; l2: number; crest: number; sag: number }

/** How strongly two overlapping carriageways are held to one height, against the terrain fit (1 per node). */
export const TIE_WEIGHT = 1000;
/** Two overlapping carriageways may differ by this where they overlap most, and by `TIE_SPREAD` more where they barely do (m). */
const TIE_SLACK = 0.05;
const TIE_SPREAD = 0.6;
/** Roads running within this of each other's direction (degrees) are side by side; across it they cross. */
const TIE_ANGLE = 45;
/** A deck node and another whose wished heights are further apart than this (m) are one over the other, not side by side. */
const TIE_DECK_APART = 2.5;
/** Weight of a deck's wished height against the fit (the terrain's is 1): the ground roads it joins have the stronger say. */
const DECK_TARGET_WEIGHT = 0.3;
/** Two roads joined end to end (or a road through a junction) within this angle (degrees) are one road for the vertical curves. */
const JOIN_ANGLE = 35;
/** The sharpest vertical curve any road keeps where the sight-distance ones cannot be had (1/m): 35 m/s over it is 0.7 g. */
const PHYSICAL_CURVE = 1 / 180;
/** Curves within this of a grade or clearance the design could not keep (m) give way, for up to this many rounds. */
const RELAX_R = 40;
const RELAX_ROUNDS = 4;

/** How far into a greater road's carriageway (times its half width, along the lesser road) the lesser one is held level with it. */
const JUNCTION_REACH = 1.1;

/**
 * Where a lesser road meets a greater one (a side street or a service road at a boulevard, a ramp's foot), the lesser road's nodes
 * over the greater road's carriageway are held to the greater road's height there (its nearest node): the lesser road starts its
 * climb at the kerb, as a real one does. Designed apart, a service road joining a deck at 10% stood 0.7 m off it 7 m in, and the
 * deck's end had to take it up in one node (a 17 to 28% ramp); on the ground, the carving averaged the two inside the junction.
 */
export function junctionTies(ways: ProfileWay[], wayNodes: number[][], px: number[], pz: number[]): Tie[] {
  const at = new Map<number, { wi: number; i: number }[]>();
  wayNodes.forEach((wn, wi) => wn.forEach((k, i) => { const l = at.get(k); if (l) l.push({ wi, i }); else at.set(k, [{ wi, i }]); }));
  const out: Tie[] = [];
  const seen = new Set<string>();
  for (const [k, list] of at) {
    if (list.length < 2) continue;
    let g = list[0];
    for (const e of list) if ((ways[e.wi].rank ?? 0) > (ways[g.wi].rank ?? 0)) g = e;
    const gr = ways[g.wi].rank ?? 0, ghw = ways[g.wi].halfWidth ?? 0;
    if (!ghw) continue;
    const gn = wayNodes[g.wi];
    for (const e of list) {
      if (e.wi === g.wi || (ways[e.wi].rank ?? 0) >= gr) continue;
      const wn = wayNodes[e.wi];
      for (const dir of [-1, 1]) {
        let dist = 0;
        for (let i = e.i + dir; i >= 0 && i < wn.length; i += dir) {
          dist += Math.hypot(px[wn[i]] - px[wn[i - dir]], pz[wn[i]] - pz[wn[i - dir]]);
          if (dist > ghw * JUNCTION_REACH) break;
          // the greater road's nearest node to it
          let best = k, bd = Math.hypot(px[k] - px[wn[i]], pz[k] - pz[wn[i]]);
          for (const q of gn) { const d = Math.hypot(px[q] - px[wn[i]], pz[q] - pz[wn[i]]); if (d < bd) { bd = d; best = q; } }
          if (best === wn[i]) continue;
          const key = best < wn[i] ? `${best},${wn[i]}` : `${wn[i]},${best}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ a: wn[i], b: best, w: TIE_WEIGHT });
        }
      }
    }
  }
  return out;
}

/**
 * Vertical curves through the nodes where one way ends and another carries on (OSM splits a road at a bridge's ends, at a change
 * of lanes, at a junction): the curves of each way only see its own nodes, so without these a ramp's foot or a bridge's end could
 * have any kink. Pairs of edges meeting at a node from different ways (or the ends of one) within `JOIN_ANGLE` of straight on.
 */
export function joinCurves(ways: ProfileWay[], wayNodes: number[][], px: number[], pz: number[]): Curve[] {
  const n = px.length;
  const legs: { j: number; speed: number }[][] = Array.from({ length: n }, () => []);
  const inner = new Set<string>();
  ways.forEach((w, wi) => {
    const wn = wayNodes[wi];
    const sp = w.speed ?? 0;
    for (let i = 0; i < wn.length; i++) {
      if (i > 0 && wn[i - 1] !== wn[i]) legs[wn[i]].push({ j: wn[i - 1], speed: sp });
      if (i + 1 < wn.length && wn[i + 1] !== wn[i]) legs[wn[i]].push({ j: wn[i + 1], speed: sp });
      if (i > 0 && i + 1 < wn.length) inner.add(`${wn[i - 1]},${wn[i]},${wn[i + 1]}`).add(`${wn[i + 1]},${wn[i]},${wn[i - 1]}`);
    }
  });
  const out: Curve[] = [];
  const cos = Math.cos((JOIN_ANGLE * Math.PI) / 180);
  for (let b = 0; b < n; b++) {
    const L = legs[b];
    if (L.length < 2) continue;
    for (let p = 0; p < L.length; p++) {
      for (let q = p + 1; q < L.length; q++) {
        const a = L[p].j, c = L[q].j;
        if (a === c || inner.has(`${a},${b},${c}`)) continue;
        const speed = Math.min(L[p].speed || Infinity, L[q].speed || Infinity);
        if (!isFinite(speed)) continue;
        const l1 = Math.max(0.5, Math.hypot(px[b] - px[a], pz[b] - pz[a])), l2 = Math.max(0.5, Math.hypot(px[c] - px[b], pz[c] - pz[b]));
        // straight on: the direction in (a to b) and out (b to c) agree
        const dot = ((px[b] - px[a]) * (px[c] - px[b]) + (pz[b] - pz[a]) * (pz[c] - pz[b])) / (l1 * l2);
        if (dot < cos) continue;
        inner.add(`${a},${b},${c}`).add(`${c},${b},${a}`);
        const lim = curveLimits(speed);
        out.push({ a, b, c, l1, l2, crest: lim.crest, sag: lim.sag });
      }
    }
  }
  return out;
}

/**
 * Nodes of two roads whose carriageways overlap side by side (closer than their half widths together, running within 45 degrees
 * of each other, not joined by an edge): a ramp leaving a motorway or a fork (held together until their carriageways part), two carriageways drawn wider than the gap between them.
 * Designed apart they stood at different heights over the same ground (a link ramp a metre over the main line it diverges from,
 * both drawn and driven there), which the 4 m heightmap made a hump or a cliff in both; held together they meet, and part only
 * where their carriageways do. Roads that cross at an angle (an overpass the dip-filling made) are not tied.
 */
export function overlapTies(ways: ProfileWay[], wayNodes: number[][], px: number[], pz: number[], adj: Edge[][], target?: ArrayLike<number>, deckOnly?: Uint8Array, crossing?: Set<string>): Tie[] {
  const G = 24;
  const grid = new Map<string, { k: number; wi: number; dx: number; dz: number }[]>();
  const info: { k: number; wi: number; dx: number; dz: number }[] = [];
  ways.forEach((w, wi) => {
    const wn = wayNodes[wi];
    for (let i = 0; i < wn.length; i++) {
      const a = wn[Math.max(0, i - 1)], b = wn[Math.min(wn.length - 1, i + 1)];
      const dx = px[b] - px[a], dz = pz[b] - pz[a];
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      const e = { k: wn[i], wi, dx: dx / l, dz: dz / l };
      info.push(e);
      const key = `${Math.floor(px[wn[i]] / G)},${Math.floor(pz[wn[i]] / G)}`;
      const list = grid.get(key);
      if (list) list.push(e); else grid.set(key, [e]);
    }
  });
  const out: Tie[] = [];
  const seen = new Set<string>();
  for (const e of info) {
    const hw = ways[e.wi].halfWidth ?? 0;
    if (!hw) continue;
    const x = px[e.k], z = pz[e.k];
    for (let gx = Math.floor((x - 30) / G); gx <= Math.floor((x + 30) / G); gx++) {
      for (let gz = Math.floor((z - 30) / G); gz <= Math.floor((z + 30) / G); gz++) {
        for (const f of grid.get(`${gx},${gz}`) ?? []) {
          if (f.wi === e.wi || f.k === e.k) continue;
          if (crossing?.has(`${Math.min(e.wi, f.wi)},${Math.max(e.wi, f.wi)}`)) continue;
          const reach = (hw + (ways[f.wi].halfWidth ?? 0)) * 0.9;
          const d = Math.hypot(px[f.k] - x, pz[f.k] - z);
          if (d > reach || Math.abs(e.dx * f.dx + e.dz * f.dz) < Math.cos((TIE_ANGLE * Math.PI) / 180)) continue;
          const key = e.k < f.k ? `${e.k},${f.k}` : `${f.k},${e.k}`;
          if (seen.has(key) || adj[e.k].some((x) => x.j === f.k)) continue;
          // a deck over a road running the same way (a viaduct above a street) is not side by side with it
          if (target && deckOnly && (deckOnly[e.k] || deckOnly[f.k]) && Math.abs(target[e.k] - target[f.k]) > TIE_DECK_APART) continue;
          seen.add(key);
          // the closer side by side, the harder they are held
          out.push({ a: e.k, b: f.k, w: TIE_WEIGHT * (1 - d / reach) });
        }
      }
    }
  }
  return out;
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
  ties: Tie[] = [],
  curves: Curve[] = [],
  above: { u: number; l: number; y: number; gap: number }[] = [],
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
    for (const t of ties) {
      const d = t.w * (x[t.a] - x[t.b]);
      y[t.a] += d;
      y[t.b] -= d;
    }
    for (let q = 0; q < T; q++) {
      const s = ca[q] * x[ta[q]] + cb[q] * x[tb[q]] + cc[q] * x[tc[q]];
      const w = tw[q] * s;
      y[ta[q]] += w * ca[q];
      y[tb[q]] += w * cb[q];
      y[tc[q]] += w * cc[q];
    }
  };
  const diag = Float64Array.from(wd);
  for (const t of ties) { diag[t.a] += t.w; diag[t.b] += t.w; }
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
      // clearances under decks first, so the grade limits have the last word: the deck climbs and the road under it dips,
      // each by its share (the one with the weaker wish to stay moves more)
      for (const c of above) {
        if (c.l < 0) {
          const ex = c.y + c.gap - h[c.u];
          if (ex > 0) { h[c.u] += ex; if (ex > worst) worst = ex; }
          continue;
        }
        const ex = h[c.l] + c.gap - h[c.u];
        if (ex <= 0) continue;
        const iu = 1 / wd[c.u], il = 1 / wd[c.l];
        h[c.u] += ex * (iu / (iu + il));
        h[c.l] -= ex * (il / (iu + il));
        if (ex > worst) worst = ex;
      }
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
      // side-by-side ties: where two carriageways overlap they may differ by no more than a step a wheel rides over (a kerb's
      // height), more the less they overlap
      for (const t of ties) {
        if (t.soft) continue;
        const lim = TIE_SLACK + (1 - t.w / TIE_WEIGHT) * TIE_SPREAD;
        const d = h[t.b] - h[t.a];
        const ex = Math.abs(d) - lim;
        if (ex <= 0) continue;
        const ia = 1 / wd[t.a], ib = 1 / wd[t.b];
        const sgn = Math.sign(d) * ex;
        h[t.a] += sgn * (ia / (ia + ib));
        h[t.b] -= sgn * (ib / (ia + ib));
        if (ex > worst) worst = ex;
      }
      // vertical curves: the change of grade through b over the mean of the two lengths stays within the crest and sag limits
      // (a projection of the second difference, the nodes that wish more strongly to stay moving less)
      for (const cv of curves) {
        const ga = 1 / cv.l1, gc = 1 / cv.l2, gb = -(ga + gc);
        const D = h[cv.a] * ga + h[cv.b] * gb + h[cv.c] * gc;
        const m = (cv.l1 + cv.l2) / 2;
        const lo = -cv.crest * m, hi = cv.sag * m;
        const over = D < lo ? D - lo : D > hi ? D - hi : 0;
        if (over === 0) continue;
        const ma = 1 / wd[cv.a], mb = 1 / wd[cv.b], mc = 1 / wd[cv.c];
        const lam = over / (ma * ga * ga + mb * gb * gb + mc * gc * gc);
        h[cv.a] -= ma * ga * lam;
        h[cv.b] -= mb * gb * lam;
        h[cv.c] -= mc * gc * lam;
        const ex = Math.abs(over) * m;
        if (ex > worst) worst = ex;
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
