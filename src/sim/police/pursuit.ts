/**
 * Driving a car along a path, headless: a pure-pursuit steering controller and a speed governor.
 * No physics and no sim in here, so it tests against a kinematic bicycle model.
 *
 * Conventions are the car's: it faces (sin yaw, cos yaw), its left is (cos yaw, -sin yaw), and the
 * steering command is -1 (left) to +1 (right) as the player's is.
 */
import { clamp } from '../../shared/math';
import type { PathPoint } from './roadGraph';

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  /** Signed speed along the nose, m/s. */
  speed: number;
}

/** A path and how far along it a car has got. */
export class PathFollower {
  i = 0;
  private cum: number[] = [];

  constructor(readonly pts: readonly PathPoint[]) {
    let s = 0;
    for (let k = 0; k < pts.length; k++) {
      if (k) s += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      this.cum.push(s);
    }
  }

  get length(): number {
    return this.cum.length ? this.cum[this.cum.length - 1] : 0;
  }

  /** Metres of path left from the current progress. */
  get remaining(): number {
    return this.length - (this.cum[this.i] ?? 0);
  }

  /** Moves the progress to the nearest point within a window ahead (never backwards). */
  advance(x: number, z: number) {
    let best = this.i;
    let bd = Infinity;
    const end = Math.min(this.pts.length, this.i + 40);
    for (let k = this.i; k < end; k++) {
      const d = (this.pts[k].x - x) ** 2 + (this.pts[k].z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    this.i = best;
  }

  /** The point `dist` metres further along than the progress. */
  lookahead(dist: number): PathPoint {
    const target = (this.cum[this.i] ?? 0) + dist;
    let k = this.i;
    while (k < this.pts.length - 1 && this.cum[k] < target) k++;
    return this.pts[k];
  }

  /** Cumulative distance at point k. */
  distAt(k: number): number {
    return this.cum[k] ?? this.length;
  }
}

/** How far ahead to aim, m: short when slow so it holds the lane, long when fast so it does not weave. */
export function lookaheadDistance(speed: number): number {
  return clamp(3.5 + Math.abs(speed) * 0.45, 4.5, 16);
}

/**
 * Pure pursuit: the steering that arcs the car through a target point. Returns the front wheel angle
 * (radians, positive turns left) the arc needs, from the bicycle model's tan(delta) = wheelbase * curvature.
 */
export function pursuitAngle(pose: Pose, target: PathPoint, wheelbase: number): number {
  const dx = target.x - pose.x;
  const dz = target.z - pose.z;
  const lat = dx * Math.cos(pose.yaw) - dz * Math.sin(pose.yaw); // left positive
  const lon = dx * Math.sin(pose.yaw) + dz * Math.cos(pose.yaw);
  const l2 = dx * dx + dz * dz;
  if (l2 < 0.01) return 0;
  // A target behind the car turns the wheel hard toward its side.
  if (lon < 0) return lat >= 0 ? 1 : -1;
  return Math.atan(wheelbase * ((2 * lat) / l2));
}

/** The steering command (-1 left, +1 right) for a wanted wheel angle at the lock available at this speed. */
export function steerCommand(angle: number, lock: number): number {
  return clamp(-angle / Math.max(lock, 0.01), -1, 1);
}

export interface GovernorOptions {
  /** Top speed on a straight, m/s. */
  cruise: number;
  /** Comfortable lateral acceleration in a corner, m/s^2. */
  lateral: number;
  /** Braking deceleration to plan for, m/s^2. */
  brake: number;
  /** Floor under the cornering speed, m/s. */
  minCorner: number;
  /** Plan to be stopped at the end of the path. */
  stopAtEnd: boolean;
  /** How far ahead to look, m. */
  horizon: number;
}

/**
 * Planning numbers for heavy cars on GTA IV-style tyres (about 0.85 g of grip, 0.9 g of brakes, a rack that slows at speed):
 * corners at about half the grip and brakes at two thirds of the brakes, so a car that is late on the wheel still makes the turn.
 */
export const GOVERNOR: Readonly<GovernorOptions> = { cruise: 16, lateral: 4.2, brake: 5.5, minCorner: 3.5, stopAtEnd: false, horizon: 80 };

/** Turn per metre (1/m) at path point k, over a span of about `span` metres either side. */
function curvatureAt(f: PathFollower, k: number, span = 4): number {
  const pts = f.pts;
  const s0 = f.distAt(k);
  let a = k;
  while (a > 0 && s0 - f.distAt(a) < span) a--;
  let b = k;
  while (b < pts.length - 1 && f.distAt(b) - s0 < span) b++;
  if (a === k || b === k) return 0;
  const h1 = Math.atan2(pts[k].x - pts[a].x, pts[k].z - pts[a].z);
  const h2 = Math.atan2(pts[b].x - pts[k].x, pts[b].z - pts[k].z);
  let d = h2 - h1;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d) / Math.max(0.5, f.distAt(b) - f.distAt(a));
}

/**
 * The speed to hold now: the cruise speed, cut so the car can slow in time for every corner within
 * the horizon (and for the end of the path when it must stop there).
 */
export function governSpeed(f: PathFollower, opts: Readonly<GovernorOptions> = GOVERNOR): number {
  let allowed = opts.cruise;
  const s0 = f.distAt(f.i);
  for (let k = f.i; k < f.pts.length; k++) {
    const d = f.distAt(k) - s0;
    if (d > opts.horizon) break;
    const kappa = curvatureAt(f, k);
    const corner = kappa > 1e-4 ? clamp(Math.sqrt(opts.lateral / kappa), opts.minCorner, opts.cruise) : opts.cruise;
    allowed = Math.min(allowed, Math.sqrt(corner * corner + 2 * opts.brake * d));
  }
  if (opts.stopAtEnd) {
    const left = f.remaining;
    allowed = Math.min(allowed, Math.sqrt(2 * opts.brake * Math.max(0, left - 1.5)));
  }
  return allowed;
}

/** Throttle and brake (0 to 1 each) that bring the speed to `target`. */
export function pedalsFor(target: number, speed: number, out: { throttle: number; brake: number }) {
  const err = target - speed;
  out.throttle = err > 0 ? clamp(err * 0.45, 0, 1) : 0;
  out.brake = err < -0.5 ? clamp((-err - 0.5) * 0.8, 0, 1) : 0;
  if (target < 0.3 && speed < 0.5) out.brake = 1;
}
