/**
 * Where the player is on the route, and the rules that say when to find a new one: strayed (about 25 m off the line for 2 s),
 * going back along it, and arrived (within about 15 m of the waypoint). Pure: the numbers are in one table.
 */
import { Route, type Located } from './route';

export const TRACK = {
  /** Farther than this from the route counts as off it, m. */
  offDistM: 25,
  /** ...for this long, s. */
  offTimeS: 2,
  /** Having come back this far along the route from the farthest point reached is going the wrong way, m. */
  regressM: 40,
  /** ...for this long, s. */
  regressTimeS: 1.5,
  /** A new route is not asked for sooner than this after the last, s. */
  minIntervalS: 1.5,
  /** The waypoint is reached within this, m. */
  arriveM: 15,
} as const;

/** True when (x, z) is within `r` m of the waypoint. */
export function arrived(x: number, z: number, wx: number, wz: number, r: number = TRACK.arriveM): boolean {
  return Math.hypot(x - wx, z - wz) <= r;
}

export type RerouteReason = 'off-route' | 'regress';

export interface Track {
  /** Progress along the solid part of the route, m. */
  s: number;
  /** Distance from the route (the straight tail counts), m. */
  off: number;
  /** Metres left to the end of the route (tail included). */
  remaining: number;
  /** Set when the rules ask for a new route now. */
  reroute: RerouteReason | null;
}

export class RouteTracker {
  private seg = 0;
  private maxS = 0;
  private offFor = 0;
  private backFor = 0;
  private age = 0;
  private readonly loc: Located = { s: 0, off: 0, seg: 0 };
  readonly track: Track = { s: 0, off: 0, remaining: 0, reroute: null };

  /** A new route was set: progress starts again. */
  reset() {
    this.seg = 0;
    this.maxS = 0;
    this.offFor = 0;
    this.backFor = 0;
    this.age = 0;
  }

  update(route: Route, x: number, z: number, dt: number): Track {
    const t = this.track;
    this.age += dt;
    route.locate(x, z, this.seg, this.loc);
    this.seg = this.loc.seg;
    let off = this.loc.off;
    const s = this.loc.s;
    // past the end of a route whose road gave out: the straight tail is part of it
    if (route.tail && route.count > 0 && s > route.length - 8) off = Math.min(off, distToSegment(x, z, route.xs[route.count - 1], route.zs[route.count - 1], route.tail.x, route.tail.z));
    t.s = s;
    t.off = off;
    t.remaining = route.remaining(s);
    t.reroute = null;
    if (off > TRACK.offDistM) this.offFor += dt;
    else this.offFor = 0;
    if (off <= TRACK.offDistM && this.maxS - s > TRACK.regressM) this.backFor += dt;
    else this.backFor = 0;
    if (s > this.maxS) this.maxS = s;
    if (this.age >= TRACK.minIntervalS) {
      if (this.offFor >= TRACK.offTimeS) t.reroute = 'off-route';
      else if (this.backFor >= TRACK.regressTimeS) t.reroute = 'regress';
    }
    return t;
  }
}

export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
