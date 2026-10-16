/** A bot that walks the player along the station walk network (a shortest path between two nodes), the way a player would. */
import type { Simulation } from '../../src/sim/Simulation';
import { cmd, Button } from '../helpers';
import { playerOf } from './transitHelpers';

export function walkPath(sim: Simulation, from: number, to: number): number[] | null {
  const w = sim.transit!.data.walk;
  const adj: { to: number; len: number }[][] = w.nodes.map(() => []);
  for (let i = 0; i + 2 < w.edges.length; i += 3) {
    const a = w.edges[i], b = w.edges[i + 1];
    const len = Math.hypot(w.nodes[a][0] - w.nodes[b][0], w.nodes[a][1] - w.nodes[b][1], w.nodes[a][2] - w.nodes[b][2]);
    adj[a].push({ to: b, len });
    adj[b].push({ to: a, len });
  }
  const dist = new Array(w.nodes.length).fill(Infinity);
  const prev = new Array(w.nodes.length).fill(-1);
  dist[from] = 0;
  const open = new Set([from]);
  while (open.size) {
    let u = -1;
    for (const k of open) if (u < 0 || dist[k] < dist[u]) u = k;
    open.delete(u);
    if (u === to) break;
    for (const e of adj[u]) if (dist[u] + e.len < dist[e.to]) { dist[e.to] = dist[u] + e.len; prev[e.to] = u; open.add(e.to); }
  }
  if (!Number.isFinite(dist[to])) return null;
  const path: number[] = [];
  for (let v = to; v >= 0; v = prev[v]) path.push(v);
  return path.reverse();
}

export function nearestWalkNode(sim: Simulation, x: number, y: number, z: number): number {
  const w = sim.transit!.data.walk;
  let best = -1, bd = Infinity;
  w.nodes.forEach((n, i) => {
    const d = Math.hypot(n[0] - x, (n[1] - y) * 3, n[2] - z);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Steers the player along the nodes (walking, or jogging); returns the index of the node reached last and the ticks taken. */
export function followPath(sim: Simulation, path: number[], opts: { maxTicks?: number; jog?: boolean; onTick?: () => void; buttons?: (i: number) => number } = {}): { reached: number; ticks: number; stuckAt: number } {
  const w = sim.transit!.data.walk;
  const p = playerOf(sim);
  let i = 0, ticks = 0, lastProgress = 0, best = Infinity;
  const max = opts.maxTicks ?? 60 * 300;
  while (i < path.length && ticks < max) {
    const n = w.nodes[path[i]];
    const c = p.controller;
    const dx = n[0] - c.x, dz = n[2] - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.7) {
      i++;
      best = Infinity;
      lastProgress = ticks;
      continue;
    }
    if (d < best - 0.05) { best = d; lastProgress = ticks; }
    if (ticks - lastProgress > 60 * 8) return { reached: i - 1, ticks, stuckAt: path[i] };
    // the camera looks along (-sin yaw, -cos yaw): to walk toward d, the camera's yaw is atan2(-dx, -dz)
    sim.pushInput(1, cmd({ buttons: opts.buttons?.(i) ?? 0, axes: { MoveY: opts.jog ? 1 : 0.5, Yaw: Math.atan2(-dx, -dz) } }));
    sim.step();
    opts.onTick?.();
    ticks++;
  }
  return { reached: i - 1, ticks, stuckAt: i < path.length ? path[i] : -1 };
}
export { Button };
