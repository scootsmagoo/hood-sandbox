/**
 * Car following and lane changing, as pure functions of numbers: the Intelligent Driver Model (IDM)
 * and MOBIL, its companion rule for changing lanes. Units are metres, seconds and m/s^2.
 *
 * IDM:  a = a_max * (1 - (v / v0)^4 - (s* / gap)^2),  s* = s0 + v T + v dv / (2 sqrt(a_max b))
 * where `gap` is the bumper-to-bumper distance to the leader and `dv` the closing speed.
 */
export interface IdmParams {
  /** Desired speed, m/s. */
  v0: number;
  /** Desired time headway, s. */
  T: number;
  /** Maximum acceleration, m/s^2. */
  a: number;
  /** Comfortable deceleration, m/s^2. */
  b: number;
  /** Standstill gap, m. */
  s0: number;
}

/** The hardest a car brakes in an emergency, m/s^2. */
export const MAX_BRAKE = 9;

export const DEFAULT_IDM: Readonly<IdmParams> = { v0: 14, T: 1.4, a: 1.7, b: 2.2, s0: 2.2 };

/** Acceleration on an empty road. */
export function freeAccel(p: IdmParams, v: number): number {
  const r = v / Math.max(0.1, p.v0);
  return p.a * (1 - r * r * r * r);
}

/** Acceleration behind a leader `gap` metres ahead (bumper to bumper) moving at `vLead`. */
export function idmAccel(p: IdmParams, v: number, gap: number, vLead: number): number {
  const dv = v - vLead;
  const star = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(0.05, gap);
  const r = v / Math.max(0.1, p.v0);
  const a = p.a * (1 - r * r * r * r - (star / g) * (star / g));
  return a < -MAX_BRAKE ? -MAX_BRAKE : a;
}

/** The distance a car needs to stop from speed `v` braking at `b`. */
export const stoppingDistance = (v: number, b: number) => (v * v) / (2 * b);

/**
 * MOBIL: whether to change lanes. All accelerations are IDM's, worked out for the situation before
 * and after the change.
 *
 *  - `meOld`, `meNew`: my acceleration in my lane and in the target lane.
 *  - `newFollowerBefore`, `newFollowerAfter`: the target lane's follower, without me and with me in front of it.
 *  - `oldFollowerBefore`, `oldFollowerAfter`: my lane's follower, with me ahead of it and with my leader ahead of it.
 *  - `politeness` p (0 selfish to 1): how much the others' loss weighs.
 *  - `threshold`: the gain needed to bother; `bias`: a positive number favours the target lane (keep right).
 *  - `safe`: the hardest braking the new follower may be forced into.
 */
export interface MobilInput {
  meOld: number;
  meNew: number;
  newFollowerBefore: number;
  newFollowerAfter: number;
  oldFollowerBefore: number;
  oldFollowerAfter: number;
  politeness: number;
  threshold: number;
  bias: number;
  safe: number;
}

export function mobilChange(m: MobilInput): boolean {
  if (m.newFollowerAfter < -m.safe) return false;
  const others = m.newFollowerAfter - m.newFollowerBefore + (m.oldFollowerAfter - m.oldFollowerBefore);
  return m.meNew - m.meOld + m.politeness * others + m.bias > m.threshold;
}
