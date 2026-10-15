/**
 * Routes over the lane graph: A* from a lane to a destination lane, and a random walk for cars that
 * just wander. Only edges of the main strongly connected component are used, so a route can always
 * be extended. Pure.
 */
import type { Rng } from '../../shared/rng';
import type { LaneGraph } from './LaneGraph';

/** Travel time cost of an edge, s. */
function cost(g: LaneGraph, e: number): number {
  const v = Math.max(3, g.speed[e]);
  // a little extra for turns and for stopping at a controlled line
  return g.len[e] / v + (g.isConnector[e] ? (g.turn[e] === 0 ? 0.5 : 2.5) : 0);
}

class Heap {
  private a: number[] = [];
  private k: number[] = [];
  get size() {
    return this.a.length;
  }
  push(item: number, key: number) {
    const a = this.a;
    const k = this.k;
    let i = a.length;
    a.push(item);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const k = this.k;
    const top = a[0];
    const last = a.pop()!;
    const lk = k.pop()!;
    if (a.length) {
      a[0] = last;
      k[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The cheapest chain of edges from `start` (exclusive) to `goal` (inclusive), or null. `maxExpand`
 * bounds the work. `extra`, when given, adds a cost in seconds to entering an edge (the police use it
 * to steer a flanker off the street the target is on).
 */
export function planRoute(g: LaneGraph, start: number, goal: number, maxExpand = 6000, extra?: (edge: number) => number): number[] | null {
  if (start === goal) return [];
  const gs = g.pts[goal];
  const gx = gs[0];
  const gz = gs[2];
  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const open = new Heap();
  const h = (e: number) => Math.hypot(g.pts[e][0] - gx, g.pts[e][2] - gz) / 30;
  open.push(start, h(start));
  const closed = new Set<number>();
  let expanded = 0;
  while (open.size && expanded < maxExpand) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    expanded++;
    if (cur === goal) {
      const out: number[] = [];
      for (let e = goal; e !== start; e = prev.get(e)!) out.push(e);
      return out.reverse();
    }
    const d0 = dist.get(cur)!;
    for (const nx of g.next[cur]) {
      if (!g.main[nx] || closed.has(nx)) continue;
      const d = d0 + cost(g, nx) + (extra ? extra(nx) : 0);
      if (d < (dist.get(nx) ?? Infinity)) {
        dist.set(nx, d);
        prev.set(nx, cur);
        open.push(nx, d + h(nx));
      }
    }
  }
  return null;
}

/**
 * The connector (or lane, after a connector) a wandering car takes next from `edge`: straight is
 * likeliest. `away`, when set, prefers the way that leads from a point (a car fleeing danger).
 */
export function pickNext(g: LaneGraph, edge: number, rng: Rng, away?: { x: number; z: number } | null): number {
  const opts: number[] = [];
  for (const n of g.next[edge]) if (g.main[n]) opts.push(n);
  if (opts.length === 0) return -1;
  if (opts.length === 1) return opts[0];
  let total = 0;
  const w: number[] = [];
  for (const n of opts) {
    let x = g.isConnector[n] ? (g.turn[n] === 0 ? 0.6 : 0.2) : 1;
    if (away) {
      const p = g.pts[n];
      const m = p.length / 3;
      // moving to a point farther from the danger is worth more
      const d0 = Math.hypot(p[0] - away.x, p[2] - away.z);
      const d1 = Math.hypot(p[(m - 1) * 3] - away.x, p[(m - 1) * 3 + 2] - away.z);
      x *= d1 > d0 ? 2.5 : 0.3;
    }
    w.push(x);
    total += x;
  }
  let r = rng.next() * total;
  for (let i = 0; i < opts.length; i++) {
    r -= w[i];
    if (r <= 0) return opts[i];
  }
  return opts[opts.length - 1];
}
