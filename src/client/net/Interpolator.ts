/**
 * Snapshot interpolation. Snapshots arrive when they arrive; the renderer draws the world as it was
 * a fraction of a tick or two ago, between the two snapshots that surround that moment, so motion
 * stays smooth whatever the frame rate and the delivery jitter.
 *
 * The clock: each snapshot says which sim tick it is and when it arrived. Arrivals are only ever
 * late, never early, so the smallest `arrival - tickTime` seen is the best estimate of the offset
 * between the two clocks. It follows a new minimum at once and drifts up slowly, which also
 * absorbs a change of latency.
 */
import type { EntityId } from '../../shared/entities';
import { nlerpQuat, wrapAngle, type Quat } from '../../shared/math';
import { SIM_DT } from '../../shared/protocol';
import { E, WHEEL_COUNT, WHEEL_FLOATS, type SnapshotView } from '../../shared/snapshot';

export interface Sample {
  a: SnapshotView;
  b: SnapshotView;
  /** 0 at `a`, 1 at `b`. Above 1 means extrapolating past the newest snapshot. */
  alpha: number;
}

export interface EntityState {
  id: EntityId;
  kind: number;
  x: number;
  y: number;
  z: number;
  q: Quat;
  vx: number;
  vy: number;
  vz: number;
  flags: number;
  speed: number;
  /** Ped yaw, or a vehicle's front wheel steer angle. */
  aux0: number;
  aux1: number;
  /** Per wheel: steer, roll, suspension length, slip. */
  wheels: Float32Array;
}

export function newEntityState(): EntityState {
  return {
    id: 0, kind: 0, x: 0, y: 0, z: 0, q: { x: 0, y: 0, z: 0, w: 1 }, vx: 0, vy: 0, vz: 0, flags: 0, speed: 0, aux0: 0, aux1: 0,
    wheels: new Float32Array(WHEEL_COUNT * WHEEL_FLOATS),
  };
}

/** A jump this large between two snapshots is a teleport, and is not smoothed. */
const TELEPORT_DISTANCE = 5;
/** How far past the newest snapshot the renderer may extrapolate, s. */
const MAX_EXTRAPOLATION = 0.1;

const qa: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qb: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class SnapshotInterpolator {
  private history: SnapshotView[] = [];
  private offset: number | null = null;

  constructor(
    /** How far behind the newest data the renderer draws, in sim ticks. */
    public delayTicks = 2,
    private readonly maxHistory = 24,
  ) {}

  /** The clock offset estimate, ms (diagnostics). */
  get clockOffset() {
    return this.offset ?? 0;
  }

  get newest(): SnapshotView | null {
    return this.history.length ? this.history[this.history.length - 1] : null;
  }

  get size() {
    return this.history.length;
  }

  push(snap: SnapshotView, nowMs: number) {
    const last = this.newest;
    if (last && snap.tick <= last.tick) return;
    const o = nowMs - snap.tick * SIM_DT * 1000;
    if (this.offset === null || o < this.offset) this.offset = o;
    else this.offset += (o - this.offset) * 0.005;
    this.history.push(snap);
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /** The sim time to draw at, in ticks (fractional). */
  renderTick(nowMs: number): number {
    return (nowMs - (this.offset ?? 0)) / (SIM_DT * 1000) - this.delayTicks;
  }

  sample(nowMs: number, out: Sample = {} as Sample): Sample | null {
    const h = this.history;
    if (h.length === 0) return null;
    if (h.length === 1) {
      out.a = out.b = h[0];
      out.alpha = 1;
      return out;
    }
    const t = this.renderTick(nowMs);
    if (t <= h[0].tick) {
      out.a = h[0];
      out.b = h[1];
      out.alpha = 0;
      return out;
    }
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].tick <= t) {
        const a = h[i - 1];
        const b = h[i];
        out.a = a;
        out.b = b;
        const span = b.tick - a.tick;
        const raw = (t - a.tick) / span;
        // Past the newest snapshot: extrapolate a little, then hold.
        const maxAlpha = i === h.length - 1 ? 1 + MAX_EXTRAPOLATION / (SIM_DT * span) : 1;
        out.alpha = Math.min(raw, maxAlpha);
        return out;
      }
    }
    return null;
  }
}

/**
 * Blends one entity between the two snapshots of a sample into `out`. Returns false when the
 * newer snapshot does not have it. An entity new in `b` is shown where it is.
 */
export function blendEntity(s: Sample, id: EntityId, out: EntityState): boolean {
  const ib = s.b.indexOf(id);
  if (ib < 0) return false;
  const ob = s.b.at(ib);
  const fb = s.b.f32;
  const ub = s.b.u32;
  const ia = s.a === s.b ? ib : s.a.indexOf(id);
  const hasA = ia >= 0;
  const oa = hasA ? s.a.at(ia) : ob;
  const fa = hasA ? s.a.f32 : fb;

  out.id = id;
  out.kind = ub[ob + E.Kind];
  out.flags = ub[ob + E.Flags];
  out.speed = fb[ob + E.Speed];
  out.aux1 = fb[ob + E.Aux1];
  out.vx = fb[ob + E.Vx];
  out.vy = fb[ob + E.Vy];
  out.vz = fb[ob + E.Vz];

  let alpha = s.alpha;
  const jump = Math.hypot(fb[ob + E.Px] - fa[oa + E.Px], fb[ob + E.Py] - fa[oa + E.Py], fb[ob + E.Pz] - fa[oa + E.Pz]);
  if (!hasA || jump > TELEPORT_DISTANCE) alpha = 1;

  if (alpha <= 1) {
    out.x = fa[oa + E.Px] + (fb[ob + E.Px] - fa[oa + E.Px]) * alpha;
    out.y = fa[oa + E.Py] + (fb[ob + E.Py] - fa[oa + E.Py]) * alpha;
    out.z = fa[oa + E.Pz] + (fb[ob + E.Pz] - fa[oa + E.Pz]) * alpha;
    qa.x = fa[oa + E.Qx]; qa.y = fa[oa + E.Qy]; qa.z = fa[oa + E.Qz]; qa.w = fa[oa + E.Qw];
    qb.x = fb[ob + E.Qx]; qb.y = fb[ob + E.Qy]; qb.z = fb[ob + E.Qz]; qb.w = fb[ob + E.Qw];
    nlerpQuat(qa, qb, alpha, out.q);
  } else {
    // Extrapolate along the newest velocity.
    const extra = (alpha - 1) * (s.b.tick - s.a.tick) * SIM_DT;
    out.x = fb[ob + E.Px] + fb[ob + E.Vx] * extra;
    out.y = fb[ob + E.Py] + fb[ob + E.Vy] * extra;
    out.z = fb[ob + E.Pz] + fb[ob + E.Vz] * extra;
    out.q.x = fb[ob + E.Qx];
    out.q.y = fb[ob + E.Qy];
    out.q.z = fb[ob + E.Qz];
    out.q.w = fb[ob + E.Qw];
  }
  const k = Math.min(alpha, 1);
  const isPed = out.kind === 1;
  const a0 = fa[oa + E.Aux0];
  const b0 = fb[ob + E.Aux0];
  out.aux0 = isPed ? a0 + wrapAngle(b0 - a0) * k : a0 + (b0 - a0) * k;
  if (!isPed) {
    for (let w = 0; w < WHEEL_COUNT; w++) {
      const j = E.Wheels + w * WHEEL_FLOATS;
      const o = w * WHEEL_FLOATS;
      out.wheels[o] = fa[oa + j] + (fb[ob + j] - fa[oa + j]) * k;
      out.wheels[o + 1] = fa[oa + j + 1] + wrapAngle(fb[ob + j + 1] - fa[oa + j + 1]) * k;
      out.wheels[o + 2] = fa[oa + j + 2] + (fb[ob + j + 2] - fa[oa + j + 2]) * k;
      out.wheels[o + 3] = fa[oa + j + 3] + (fb[ob + j + 3] - fa[oa + j + 3]) * k;
    }
  }
  return true;
}
