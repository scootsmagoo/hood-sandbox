/**
 * The pure maths of the raycast car: no physics engine, no allocation in the hot paths. The car
 * (RaycastCar.ts) feeds these functions with what its ray casts and rigid body report and applies
 * the results as impulses. docs/physics.md describes the model and how to tune it.
 *
 * Model (aimed at GTA IV's feel: heavy, soft, catchable): each wheel is a ray. The ray gives a
 * suspension length; a soft spring and a damper (softer in bump than in rebound) turn that into a
 * normal load, and the body rolls, dives and squats on those springs because the tyre forces act
 * low (at the road for driving and braking, at the roll centre for cornering) while the mass sits
 * high. The tyre turns the load and the contact velocity into a force on the ground plane:
 *
 *  - a lateral force from the slip angle along a curve that rises to a peak and falls off to a
 *    sliding value, so a slide past the peak feeds itself unless the driver catches it;
 *  - a friction coefficient that falls as the load grows (load sensitivity), so moving weight from
 *    one axle to the other costs the pair grip: lift off mid-corner and the unloaded rear lets go,
 *    turn in too fast and the front runs out first;
 *  - a longitudinal force from the engine and the brakes, sharing the grip with the lateral one
 *    (friction ellipse); a driven wheel asked for more than it holds spins and keeps little lateral
 *    grip (power oversteer); a wheel locked by the handbrake slides against its own velocity.
 *
 * There is no yaw assist, no drift angle holder and no donut governor. The only help is physical:
 * caster pulls a released wheel toward the direction of travel, as a real steering rack does.
 */
import { DEG, G, clamp, lerp, smoothstep } from '../../shared/math';
import type { HandlingData } from '../../shared/handling';

/** Below this forward speed (m/s) the slip angle is taken against this floor instead, so a nearly stopped tyre does not divide by zero. */
const SLIP_SPEED_FLOOR = 0.8;
/** Share of the force that would stop a wheel's slip velocity within one step: a cap that keeps a stiff tyre stable at low speed. */
const STOP_SHARE = 0.6;

/**
 * The slip curve: lateral force as a share of the peak for a slip of `x` peak angles. It rises as
 * x(2 - x), smooth to the top at x = 1, then falls to `slideRatio` by x = `falloff` and stays there.
 */
export function slipCurve(x: number, slideRatio: number, falloff: number): number {
  const a = Math.abs(x);
  if (a <= 1) return a * (2 - a);
  return lerp(1, slideRatio, smoothstep(1, falloff, a));
}

/** Friction coefficient at a load: `mu` at the nominal load, falling by `sensitivity` per 100% extra (and rising, less, when unloaded). */
export function loadedMu(mu: number, load: number, nominal: number, sensitivity: number): number {
  if (nominal <= 0) return mu;
  return mu * clamp(1 - sensitivity * (load / nominal - 1), 0.55, 1.2);
}

/** Engine acceleration (m/s^2, signed) for a demand and the speed along the car's forward axis: the low-gear push, then constant power, then the limiter. */
export function engineAccel(drive: number, vForward: number, d: HandlingData['drive']): number {
  if (drive >= 0) {
    const v = Math.max(0, vForward);
    const push = Math.min(d.driveForce, d.powerPerKg / Math.max(v, 1));
    return drive * push * (1 - smoothstep(d.maxFlatVel * 0.9, d.maxFlatVel, v));
  }
  const v = Math.max(0, -vForward);
  return drive * d.driveForce * 0.6 * (1 - smoothstep(d.reverseMaxVel * 0.75, d.reverseMaxVel, v));
}

/** Steering lock (radians) at a speed: wide when parked, narrow at speed. */
export function steerLock(speed: number, s: HandlingData['steering']): number {
  return lerp(s.lockDeg, s.lockHighSpeedDeg, smoothstep(0, s.lockRefSpeed, Math.abs(speed))) * DEG;
}

/** The rack's rate as a share of the crawl rate: it slows with speed, so a key press at 100 km/h is not a flick. */
export function steerRateScale(speed: number, s: HandlingData['steering']): number {
  return lerp(1, s.rateHighSpeed, smoothstep(3, s.lockRefSpeed, Math.abs(speed)));
}

/** Moves the steering angle toward its target at the handling's rates (slower at speed). All in radians. */
export function slewSteer(current: number, target: number, dt: number, s: HandlingData['steering'], speed = 0): number {
  const turningAway = Math.abs(target) > Math.abs(current) && Math.sign(target) === Math.sign(current || target);
  const rate = (turningAway ? s.rateDeg : s.returnRateDeg) * DEG * dt * steerRateScale(speed, s);
  return current + clamp(target - current, -rate, rate);
}

/**
 * Caster: the angle (radians, positive left) a released wheel trails toward, the direction the front
 * axle is travelling relative to the nose times `selfAlign`. `vLeft` is the front axle's velocity
 * along the car's left axis and `vFwd` along its nose. Nothing when slow or reversing.
 */
export function selfAlignAngle(vLeft: number, vFwd: number, selfAlign: number, lock: number): number {
  if (selfAlign <= 0 || vFwd < 2) return 0;
  return clamp(Math.atan2(vLeft, vFwd) * selfAlign, -lock, lock) * smoothstep(2, 6, vFwd);
}

/**
 * The lock the driver has (radians): the speed-sensitive lock, except that steering into a slide (the
 * wheels toward where the front axle is going) can always reach that direction and a little past it,
 * up to the full mechanical lock, the way a driver catches a slide with the wheel.
 * `steer` is the command (-1 left to +1 right); `travel` the front axle's direction of travel relative
 * to the nose (radians, positive left).
 */
export function driverLock(steer: number, travel: number, speedLock: number, fullLock: number): number {
  const wheelDir = -Math.sign(steer);
  if (wheelDir === 0 || Math.sign(travel) !== wheelDir) return speedLock;
  return Math.min(fullLock, Math.max(speedLock, Math.abs(travel) + 3 * DEG));
}

export interface DriveRequest {
  /** Signed engine demand: positive pushes forward, negative reverses. */
  drive: number;
  /** Brake demand, 0 to 1. */
  brake: number;
  reversing: boolean;
}

/**
 * Turns the pedals into engine and brake demand. The brake pedal brakes while rolling forward,
 * then reverses once stopped; the throttle brakes while rolling backward.
 */
export function resolvePedals(throttle: number, brake: number, vForward: number, out: DriveRequest): DriveRequest {
  if (vForward > 0.6) {
    out.drive = throttle;
    out.brake = brake;
    out.reversing = false;
  } else if (vForward < -0.6) {
    out.drive = -brake;
    out.brake = throttle;
    out.reversing = true;
  } else if (brake > throttle) {
    out.drive = -brake;
    out.brake = 0;
    out.reversing = true;
  } else {
    out.drive = throttle;
    out.brake = 0;
    out.reversing = false;
  }
  return out;
}

/**
 * Spring and damper force on one wheel as an acceleration of the mass it carries (m/s^2).
 * `len` is the current suspension length and `prevLen` last step's (0 is fully compressed);
 * `rest` is where the spring is relaxed. The damper is softer while the wheel compresses than
 * while it extends. A bump stop adds a stiff, damped spring near full compression. Never pulls.
 */
export function suspensionAccel(len: number, prevLen: number, dt: number, rest: number, omega: number, zetaBump: number, zetaRebound: number, bumpStopAt: number): number {
  const k = omega * omega;
  const v = (prevLen - len) / dt;
  const zeta = v > 0 ? zetaBump : zetaRebound;
  let a = k * (rest - len) + 2 * zeta * omega * v;
  if (len < bumpStopAt) a += k * 10 * (bumpStopAt - len) + Math.max(0, v) * omega * 1.5;
  return clamp(a, 0, 90);
}

export interface TireInput {
  /** Contact point velocity along and across the wheel, m/s. */
  vLong: number;
  vLat: number;
  /** Normal load, N, and the load at rest. */
  load: number;
  nominal: number;
  /** Mass the wheel carries, kg. */
  mass: number;
  dt: number;
  /** Engine force demanded at this wheel, N (signed). */
  driveForce: number;
  /** Brake force this wheel can apply, N (never reverses the wheel). */
  brakeForce: number;
  /** Locked by the handbrake: the tyre slides against its velocity. */
  locked: boolean;
  /** Scales every grip limit (the axle's grip, a flat tyre, the surface). */
  gripMult: number;
  /** Scales only the lateral limit (a burnout). */
  lateralMult: number;
  /** Make the wheel spin whatever the demand (a burnout). */
  forceSpin?: boolean;
}

export interface TireOutput {
  fLong: number;
  fLat: number;
  slipAngle: number;
  /** The driven wheel asked for more than the tyre can hold. */
  spinning: boolean;
  /** 0 to 1: how far into a slide (1 for a spinning or locked wheel). */
  slip: number;
  /** The friction coefficient the tyre had at its load. */
  mu: number;
}

export function newTireOutput(): TireOutput {
  return { fLong: 0, fLat: 0, slipAngle: 0, spinning: false, slip: 0, mu: 0 };
}

export function tireForce(s: TireInput, t: HandlingData['traction'], out: TireOutput): TireOutput {
  out.fLong = out.fLat = out.slipAngle = out.slip = out.mu = 0;
  out.spinning = false;
  if (s.load <= 0) return out;

  const mu = loadedMu(t.mu, s.load, s.nominal, t.loadSensitivity) * s.gripMult;
  out.mu = mu;
  const fMax = mu * s.load;
  const fxMax = fMax * t.longitudinalMult;
  const alpha = Math.atan2(Math.abs(s.vLat), Math.abs(s.vLong) + SLIP_SPEED_FLOOR);
  out.slipAngle = alpha;
  const x = alpha / (t.peakSlipDeg * DEG);

  if (s.locked) {
    // A locked wheel: kinetic friction against the contact's velocity, whatever the steering.
    const v = Math.hypot(s.vLong, s.vLat);
    if (v > 1e-4) {
      const mag = Math.min(fMax * t.handbrakeGrip, (v * s.mass * STOP_SHARE) / s.dt);
      out.fLong = (-s.vLong / v) * mag;
      out.fLat = (-s.vLat / v) * mag;
    }
    out.slip = smoothstep(0.5, 2, v);
    return out;
  }

  // Longitudinal: the engine (which spins the wheel past the limit), then the brakes (which can stop it but not reverse it within a step).
  let fx = s.driveForce;
  const spinning = s.forceSpin === true || Math.abs(fx) > fxMax;
  if (spinning) fx = Math.sign(fx || 1) * fxMax * t.slideRatio;
  if (s.brakeForce > 0 && s.vLong !== 0) {
    const stop = (Math.abs(s.vLong) * s.mass) / s.dt;
    fx -= Math.sign(s.vLong) * Math.min(s.brakeForce, stop);
  }
  fx = clamp(fx, -fxMax, fxMax);

  // Lateral: the slip curve, capped by what would stop the slip within the step (stable at a crawl).
  const curve = fMax * slipCurve(x, t.slideRatio, t.falloff) * s.lateralMult * (spinning ? t.spinLateral : 1);
  const stop = (Math.abs(s.vLat) * s.mass * STOP_SHARE) / s.dt;
  let fy = -Math.sign(s.vLat) * Math.min(curve, stop);

  // Friction ellipse: what driving or braking uses is gone from cornering. An ABS-like floor keeps some steering under full
  // braking; a driven wheel that still grips gives up less (the engine's push is spread over the contact patch's slip).
  const use = Math.min(1, Math.abs(fx) / Math.max(fxMax, 1e-6));
  const braking = s.brakeForce > 0 && Math.sign(fx) === -Math.sign(s.vLong);
  fy *= Math.sqrt(1 - use * use * (braking ? 0.9 : 0.6));

  out.fLong = fx;
  out.fLat = fy;
  out.spinning = spinning;
  out.slip = spinning ? 1 : smoothstep(1, t.falloff, x);
  return out;
}

/**
 * Lateral grip lost by a spinning driven wheel at low speed (burnouts): 1 means untouched, and the
 * multiplier falls to `1 - lowSpeedLossMult` at a standstill.
 */
export function lowSpeedGrip(speed: number, spinning: boolean, t: HandlingData['traction']): number {
  if (!spinning) return 1;
  return 1 - t.lowSpeedLossMult * (1 - smoothstep(0, t.lowSpeedLossSpeed, Math.abs(speed)));
}

/** Whether the pedals ask for a burnout: the throttle with the brake or the handbrake, nearly stopped. */
export function burnoutWanted(throttle: number, brake: number, handbrake: boolean, vForward: number): boolean {
  return throttle > 0.5 && (brake > 0.5 || handbrake) && vForward > -1 && vForward < 4;
}

/**
 * Front-axle brake demand (m/s^2, positive slows the car) for a burnout. The rear tyres spin and
 * smoke; the front brakes hold the car to a slow creep instead of letting it launch.
 */
export function burnoutHold(speedForward: number, x: HandlingData['extras']): number {
  return clamp(x.burnoutHold * (1 + Math.max(0, speedForward - x.burnoutCreep) * 2), 0, 12);
}

/** Static load of a wheel carrying `share` kg, N. */
export const nominalLoad = (share: number) => share * G;

/** The car's static stability factor (half track over the centre of mass height above the road): the lateral g that would tip it on flat ground. */
export function staticStability(h: HandlingData, rideHeight: number): number {
  const track = (h.wheels.trackFront + h.wheels.trackRear) / 2;
  return track / (2 * (rideHeight + h.centreOfMass[1]));
}
