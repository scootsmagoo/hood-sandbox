/**
 * Where the lanes cross the walk network's unsignalled crossings, and whether people are on one (or
 * stepping onto it) so that cars approaching it must give way. Signalled crossings are the lights' job
 * and are not indexed. Pure: no physics and no sim.
 */
import type { LaneGraph } from './LaneGraph';
import type { WalkGraph } from '../peds/graph';

export interface LaneCrossing {
  /** The walk edge of the crossing. */
  walk: number;
  /** Arc length along the lane edge to the point where the lane crosses it, m. */
  s: number;
  /** The crossing's line: its start, its unit direction and its length. */
  ax: number;
  az: number;
  tx: number;
  tz: number;
  len: number;
}

export interface Walker {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** How cars give way to people on an unsignalled crossing. */
export const YIELD = {
  /** Where the front bumper stops before the crossing, m. */
  gap: 3,
  /** Seconds a car waits for a crossing to clear before it drives on (someone standing on it for good must not stop the street). */
  patience: 15,
  /** The crossing must be at least this far along its lane, m, so that the stop is on the same lane and not in a junction. */
  minS: 3.5,
};

/** Lane edges (lanes only, not connectors) with the unsignalled crossings they cross, in order along the lane. */
export function indexCrossings(lanes: LaneGraph, walk: WalkGraph): LaneCrossing[][] {
  const kinds = new Set(['crossing'] as const);
  const out: LaneCrossing[][] = [];
  for (let e = 0; e < lanes.count; e++) {
    const list: LaneCrossing[] = [];
    out.push(list);
    if (lanes.isConnector[e]) continue;
    const p = lanes.pts[e], cum = lanes.cum[e];
    const seen = new Set<number>();
    for (let k = 0; k + 1 < p.length / 3; k++) {
      const x0 = p[k * 3], z0 = p[k * 3 + 2], x1 = p[k * 3 + 3], z1 = p[k * 3 + 5];
      const seg = cum[k + 1] - cum[k];
      const n = Math.max(1, Math.ceil(seg));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const hit = walk.nearestEdge(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, 1, kinds);
        if (!hit || seen.has(hit.edge) || walk.crossingOf(hit.edge)?.signals !== false) continue;
        seen.add(hit.edge);
        const a = walk.ea[hit.edge], b = walk.eb[hit.edge];
        const dx = walk.x[b] - walk.x[a], dz = walk.z[b] - walk.z[a];
        const len = Math.hypot(dx, dz) || 1;
        list.push({ walk: hit.edge, s: cum[k] + seg * t, ax: walk.x[a], az: walk.z[a], tx: dx / len, tz: dz / len, len });
      }
    }
    list.sort((q, r) => q.s - r.s);
  }
  return out;
}

/**
 * Someone is on the crossing, or about to step onto it from the kerb: within its line and across it,
 * or coming along the pavement at either end towards it. People walking along the road beside it do not count.
 */
export function crossingBusy(x: LaneCrossing, walkers: readonly Walker[]): boolean {
  for (const w of walkers) {
    const px = w.x - x.ax, pz = w.z - x.az;
    const along = px * x.tx + pz * x.tz;
    const across = -px * x.tz + pz * x.tx;
    if (Math.abs(across) > 2.5) continue;
    const vt = w.vx * x.tx + w.vz * x.tz;
    if (along >= -0.5 && along <= x.len + 0.5 && Math.abs(across) < 1.2) return true;
    if (along < 0 && along > -3 && vt > 0.4) return true;
    if (along > x.len && along < x.len + 3 && vt < -0.4) return true;
  }
  return false;
}
