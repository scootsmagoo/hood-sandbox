/**
 * How far to either side of the middle of a walk edge a person can walk. The network is clear of
 * footprints on its middle line, but people walk a little off it (each has a lane) and a wall, a pole
 * or a bench can stand closer than that. The width is found once per edge, the first time someone walks
 * it, by sweeping a capsule along the edge at a few lateral offsets against the real static world, and
 * remembered.
 */
import type { PhysicsWorld } from '../World';
import type { WalkGraph } from './graph';

/** The widest lane anyone walks, m either side of the middle. */
export const LANE_MAX = 0.55;
const STEP = 0.1375;
const N = Math.round(LANE_MAX / STEP);

export class EdgeClearance {
  private lo: Float32Array;
  private hi: Float32Array;
  /** 0 not yet measured, 1 open, 2 the middle line itself is blocked. */
  private state: Uint8Array;
  /** Edges measured so far (diagnostics). */
  measured = 0;
  blocked = 0;

  constructor(
    private readonly graph: WalkGraph,
    private readonly physics: PhysicsWorld,
  ) {
    this.lo = new Float32Array(graph.edgeCount);
    this.hi = new Float32Array(graph.edgeCount);
    this.state = new Uint8Array(graph.edgeCount);
    // a streamed city fills ranges of edge ids as tiles come and go: what was measured there is forgotten
    graph.onEdges.push((start, n) => this.reset(start, n));
  }

  /** Forgets the edges `start .. start + n - 1` (they are new, or their tile changed), growing the arrays to hold them. */
  reset(start: number, n: number) {
    const need = start + n;
    if (need > this.state.length) {
      const cap = Math.max(need, Math.ceil(this.state.length * 1.5));
      const lo = new Float32Array(cap), hi = new Float32Array(cap), st = new Uint8Array(cap);
      lo.set(this.lo);
      hi.set(this.hi);
      st.set(this.state);
      this.lo = lo;
      this.hi = hi;
      this.state = st;
    }
    this.state.fill(0, start, need);
  }

  private measure(e: number) {
    const g = this.graph;
    const a = g.ea[e], b = g.eb[e];
    const ax = g.x[a], az = g.z[a], bx = g.x[b], bz = g.z[b];
    const len = g.len[e];
    this.measured++;
    // crossings and steps are walked on the middle line
    if (len < 1e-3 || g.kindOf(e) === 'crossing') {
      this.lo[e] = this.hi[e] = 0;
      this.state[e] = 1;
      return;
    }
    // the lateral unit vector: the walker's right on the way a to b, as in AmbientPeds.stepWalk
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    const open = (lane: number) => this.physics.sweepClear(ax + nx * lane, g.y[a], az + nz * lane, bx + nx * lane, g.y[b], bz + nz * lane);
    if (!open(0)) {
      this.lo[e] = this.hi[e] = 0;
      this.state[e] = 2;
      this.blocked++;
      return;
    }
    let hi = 0;
    for (let k = 1; k <= N && open(k * STEP); k++) hi = k * STEP;
    let lo = 0;
    for (let k = 1; k <= N && open(-k * STEP); k++) lo = -k * STEP;
    this.lo[e] = lo;
    this.hi[e] = hi;
    this.state[e] = 1;
  }

  /** Whether the middle of the edge is blocked (a pole or a wall in the way). */
  isBlocked(e: number): boolean {
    if (this.state[e] === 0) this.measure(e);
    return this.state[e] === 2;
  }

  /**
   * The lane (m to the walker's right) to use on edge `e` when walking from `from`, given the lane the walker would like:
   * pulled in to where the edge is clear. Walking from the edge's far end flips the sides.
   */
  lane(e: number, from: number, want: number): number {
    if (this.state[e] === 0) this.measure(e);
    const fwd = this.graph.ea[e] === from;
    const lo = fwd ? this.lo[e] : -this.hi[e];
    const hi = fwd ? this.hi[e] : -this.lo[e];
    return want < lo ? lo : want > hi ? hi : want;
  }
}
