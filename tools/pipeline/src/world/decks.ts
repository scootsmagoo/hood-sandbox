import type { V2 } from '../geo.js';
import { segmentIntersection } from '../geo.js';

export interface DeckWay {
  nodeIds: number[];
  pts: V2[];
  layer: number;
}

/** A road or rail that a deck may have to clear. heights is absent for ways on the ground. */
export interface RefWay {
  nodeIds: number[];
  pts: V2[];
  width: number;
  layer: number;
  heights?: number[];
  clearance: number;
}

export interface DeckOptions {
  groundAt: (x: number, z: number) => number;
  /** OSM node ids that belong to ways lying on the ground; deck ends that touch them are pinned to the ground */
  groundNodeIds: Set<number>;
  groundRefs: RefWay[];
  /** deck slab thickness (top surface to underside) */
  thickness: number;
  maxGrade: number;
  /** lift of the deck top over the ground where it meets an at-grade road */
  anchorLift: number;
  /** height per layer for deck groups with nothing to pin them to the ground */
  layerHeight: number;
  /** minimum height of the deck above the ground below it */
  minAboveGround: number;
  /** extra width of the clearance zone on each side of a crossed road */
  crossMargin: number;
}

export const DEFAULT_DECK_OPTIONS = {
  thickness: 1.0,
  maxGrade: 0.08,
  anchorLift: 0.1,
  layerHeight: 6,
  minAboveGround: 0.3,
  crossMargin: 3,
};

let synthetic = 0;

/** Inserts nodes so that no segment is longer than maxLen. Inserted nodes get unique negative ids. */
export function densifyWay<T extends { pts: V2[]; nodeIds: number[] }>(w: T, maxLen: number): { pts: V2[]; nodeIds: number[] } {
  const pts: V2[] = [w.pts[0]];
  const nodeIds: number[] = [w.nodeIds[0]];
  for (let i = 1; i < w.pts.length; i++) {
    const a = w.pts[i - 1];
    const b = w.pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      nodeIds.push(--synthetic);
    }
    pts.push(b);
    nodeIds.push(w.nodeIds[i]);
  }
  return { pts, nodeIds };
}

class UnionFind {
  p: number[] = [];
  add(): number { this.p.push(this.p.length); return this.p.length - 1; }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a: number, b: number) { this.p[this.find(a)] = this.find(b); }
}

/** Returns the height of the deck surface at every point of every deck way. */
export function solveDecks(decks: DeckWay[], user: Partial<DeckOptions> & Pick<DeckOptions, 'groundAt' | 'groundNodeIds' | 'groundRefs'>): number[][] {
  const o: DeckOptions = { ...DEFAULT_DECK_OPTIONS, ...user };
  const index = new Map<number, number>();
  const px: number[] = [];
  const pz: number[] = [];
  const layerOf: number[] = [];
  const ids: number[] = [];
  const uf = new UnionFind();
  const wayNodes: number[][] = decks.map((d) =>
    d.nodeIds.map((id, i) => {
      let k = index.get(id);
      if (k === undefined) {
        k = uf.add();
        index.set(id, k);
        px.push(d.pts[i][0]);
        pz.push(d.pts[i][1]);
        layerOf.push(d.layer);
        ids.push(id);
      } else if (d.layer > layerOf[k]) layerOf[k] = d.layer;
      return k;
    }),
  );
  const n = px.length;
  const nbr: { j: number; len: number }[][] = Array.from({ length: n }, () => []);
  wayNodes.forEach((wn) => {
    for (let i = 0; i + 1 < wn.length; i++) {
      const a = wn[i], b = wn[i + 1];
      if (a === b) continue;
      const len = Math.max(0.01, Math.hypot(px[a] - px[b], pz[a] - pz[b]));
      nbr[a].push({ j: b, len });
      nbr[b].push({ j: a, len });
      uf.union(a, b);
    }
  });
  const g = new Float64Array(n);
  for (let k = 0; k < n; k++) g[k] = o.groundAt(px[k], pz[k]);
  const compAnchored = new Map<number, boolean>();
  const anchor = new Uint8Array(n);
  // only the ends of a deck way can land on the ground; a shared node in the middle is a mapping coincidence
  const isEnd = new Uint8Array(n);
  wayNodes.forEach((wn) => {
    isEnd[wn[0]] = 1;
    isEnd[wn[wn.length - 1]] = 1;
  });
  for (let k = 0; k < n; k++) {
    if (isEnd[k] && ids[k] > 0 && o.groundNodeIds.has(ids[k])) {
      anchor[k] = 1;
      compAnchored.set(uf.find(k), true);
    }
  }
  const baseL = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    baseL[k] = compAnchored.get(uf.find(k)) ? g[k] + o.minAboveGround : g[k] + o.layerHeight * Math.max(1, layerOf[k]);
    if (anchor[k]) baseL[k] = g[k] + o.anchorLift;
  }

  // grade-limited ceiling: the highest a deck can be at each node if it climbs from an anchor at maxGrade
  const ceiling = new Float64Array(n).fill(Infinity);
  {
    const order: number[] = [];
    for (let k = 0; k < n; k++) if (anchor[k]) { ceiling[k] = baseL[k]; order.push(k); }
    const dist = new Float64Array(n).fill(Infinity);
    order.forEach((k) => (dist[k] = 0));
    const hAnchor = new Float64Array(n);
    order.forEach((k) => (hAnchor[k] = baseL[k]));
    while (order.length) {
      let bi = 0;
      for (let i = 1; i < order.length; i++) if (dist[order[i]] < dist[order[bi]]) bi = i;
      const k = order.splice(bi, 1)[0];
      for (const e of nbr[k]) {
        const d = dist[k] + e.len;
        if (d < dist[e.j]) {
          dist[e.j] = d;
          hAnchor[e.j] = hAnchor[k];
          order.push(e.j);
        }
      }
    }
    for (let k = 0; k < n; k++) if (dist[k] < Infinity) ceiling[k] = hAnchor[k] + o.maxGrade * 1.25 * dist[k];
  }

  const h = new Float64Array(n);
  const L = new Float64Array(n);

  for (let pass = 0; pass < 3; pass++) {
    L.set(baseL);
    decks.forEach((a, ai) => {
      const wn = wayNodes[ai];
      const refs: RefWay[] = [...o.groundRefs];
      decks.forEach((b, bi) => {
        if (bi !== ai && b.layer < a.layer) {
          refs.push({ nodeIds: b.nodeIds, pts: b.pts, width: 6, layer: b.layer, heights: wayNodes[bi].map((k) => h[k]), clearance: 5 });
        }
      });
      for (let i = 0; i + 1 < a.pts.length; i++) {
        const a0 = a.pts[i], a1 = a.pts[i + 1];
        const minX = Math.min(a0[0], a1[0]) - 1, maxX = Math.max(a0[0], a1[0]) + 1;
        const minZ = Math.min(a0[1], a1[1]) - 1, maxZ = Math.max(a0[1], a1[1]) + 1;
        for (const r of refs) {
          if (r.layer >= a.layer) continue;
          for (let j = 0; j + 1 < r.pts.length; j++) {
            const b0 = r.pts[j], b1 = r.pts[j + 1];
            if ((b0[0] < minX && b1[0] < minX) || (b0[0] > maxX && b1[0] > maxX) || (b0[1] < minZ && b1[1] < minZ) || (b0[1] > maxZ && b1[1] > maxZ)) continue;
            if (a.nodeIds[i] === r.nodeIds[j] || a.nodeIds[i] === r.nodeIds[j + 1] || a.nodeIds[i + 1] === r.nodeIds[j] || a.nodeIds[i + 1] === r.nodeIds[j + 1]) continue;
            const x = segmentIntersection(a0, a1, b0, b1);
            if (!x) continue;
            const lower = r.heights ? r.heights[j] + (r.heights[j + 1] - r.heights[j]) * x.u : o.groundAt(x.x, x.z) + 0.1;
            const need = lower + r.clearance + o.thickness;
            const reach = r.width / 2 + o.crossMargin;
            for (const dir of [-1, 1]) {
              let m = dir < 0 ? i : i + 1;
              let dist = 0;
              let px0 = x.x, pz0 = x.z;
              while (m >= 0 && m < a.pts.length) {
                dist += Math.hypot(a.pts[m][0] - px0, a.pts[m][1] - pz0);
                if (dist > reach && !(dir < 0 ? m === i : m === i + 1)) break;
                const k = wn[m];
                const capped = Math.min(need, ceiling[k]);
                if (!anchor[k] && capped > L[k]) L[k] = capped;
                px0 = a.pts[m][0];
                pz0 = a.pts[m][1];
                m += dir;
              }
            }
          }
        }
      }
    });
    for (let k = 0; k < n; k++) h[k] = anchor[k] ? baseL[k] : Math.max(L[k], baseL[k]);
    const omega = 1.8;
    for (let sweep = 0; sweep < 6000; sweep++) {
      let delta = 0;
      for (let s = 0; s < n; s++) {
        const k = sweep % 2 === 0 ? s : n - 1 - s;
        if (anchor[k] || nbr[k].length === 0) continue;
        let v = h[k];
        if (compAnchored.get(uf.find(k))) {
          let sw = 0, sh = 0;
          for (const e of nbr[k]) { sw += 1 / e.len; sh += h[e.j] / e.len; }
          v = h[k] + omega * (sh / sw - h[k]);
        }
        if (v < L[k]) v = L[k];
        for (const e of nbr[k]) {
          const lb = h[e.j] - o.maxGrade * e.len;
          if (v < lb) v = lb;
        }
        const d = Math.abs(v - h[k]);
        if (d > delta) delta = d;
        h[k] = v;
      }
      if (delta < 1e-4) break;
    }
    // soften the corners where tents meet plateaus
    for (let s = 0; s < 3; s++) {
      const next = Float64Array.from(h);
      for (let k = 0; k < n; k++) {
        if (anchor[k] || nbr[k].length !== 2) continue;
        next[k] = Math.max(L[k], 0.5 * h[k] + 0.25 * (h[nbr[k][0].j] + h[nbr[k][1].j]));
      }
      h.set(next);
    }
  }
  return wayNodes.map((wn) => wn.map((k) => h[k]));
}
