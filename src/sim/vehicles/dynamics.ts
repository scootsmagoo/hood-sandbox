/**
 * The pure maths of the raycast car: no physics engine, no allocation in the hot paths. The car
 * (RaycastCar.ts) feeds these functions with what its ray casts and rigid body report and applies
 * the results as impulses.
 *
 * Model: each wheel is a ray. The ray gives a suspension length, a spring and damper turn that into
 * a normal load, and the tyre turns the load and the contact velocity into a force on the ground
 * plane: a lateral force that pulls the slip velocity to zero up to a grip limit, a longitudinal
 * force from the engine and the brakes, and a friction circle that makes them share the limit. The
 * grip limit depends on the slip angle (GTA's traction curve): full at the peak, falling to a lower
 * sliding value, which is what makes a slide possible.
 */
import { DEG, clamp, lerp, smoothstep } from '../../shared/math';
import type { HandlingData } from '../../shared/handling';

/** Slip angle that treats a nearly stopped tyre as gripping instead of dividing by zero (m/s). */
const SLIP_SPEED_FLOOR = 1.0;

/** Friction coefficient available at a slip angle: `curveMax` up to the peak angle, easing down to `curveMin`. */
export function tractionCoefficient(slipAngle: number, t: HandlingData['traction']): number {
  const peak = t.curveLateralDeg * DEG;
  return lerp(t.curveMax, t.curveMin, smoothstep(peak, peak * 2.5, Math.abs(slipAngle)));
}

/** 1 at a standstill, falling to 0 at the engine's flat velocity. */
export function torqueCurve(speed: number, maxVel: number): number {
  const r = speed / maxVel;
  return r >= 1 ? 0 : 1 - r * r;
}

/** Steering lock (radians) at a speed: wide when parked, narrow at speed. */
export function steerLock(speed: number, s: HandlingData['steering']): number {
  return lerp(s.lockDeg, s.lockHighSpeedDeg, smoothstep(0, s.lockRefSpeed, Math.abs(speed))) * DEG;
}

/** Moves the steering angle toward its target at the handling's rates. All in radians. */
export function slewSteer(current: number, target: number, dt: number, s: HandlingData['steering']): number {
  const turningAway = Math.abs(target) > Math.abs(current) && Math.sign(target) === Math.sign(current || target);
  const rate = (turningAway ? s.rateDeg : s.returnRateDeg) * DEG * dt;
  return current + clamp(target - current, -rate, rate);
}

/**
 * Extra front-wheel angle that points the wheels where the car is going when it slides. Positive
 * turns left. `vLeft` and `vFwd` are the body's velocity along its own left and forward axes.
 * Quiet in ordinary cornering (the angle must pass 8 degrees) and off when reversing.
 */
export function counterSteer(vLeft: number, vFwd: number, assist: number, lock: number): number {
  if (assist <= 0 || vFwd < 1.5) return 0;
  const theta = Math.atan2(vLeft, vFwd);
  const w = smoothstep(8 * DEG, 25 * DEG, Math.abs(theta));
  return clamp(theta, -lock, lock) * assist * w;
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

/** Engine acceleration (m/s^2, signed) for a demand and the speed along the car's forward axis. */
export function engineAccel(drive: number, vForward: number, d: HandlingData['drive']): number {
  if (drive >= 0) return drive * d.driveForce * torqueCurve(Math.max(0, vForward), d.maxFlatVel);
  return drive * d.driveForce * 0.6 * torqueCurve(Math.max(0, -vForward), d.reverseMaxVel);
}

/**
 * Spring and damper force on one wheel as an acceleration of the mass it carries (m/s^2).
 * `len` is the current suspension length and `prevLen` last step's; `rest` is where the spring is
 * relaxed. A bump stop adds a stiff spring near full compression. Never pulls the body down.
 */
export function suspensionAccel(len: number, prevLen: number, dt: number, rest: number, omega: number, zeta: number, bumpStopAt: number): number {
  const k = omega * omega;
  const c = 2 * zeta * omega;
  let a = k * (rest - len) + (c * (prevLen - len)) / dt;
  if (len < bumpStopAt) a += k * 6 * (bumpStopAt - len);
  return clamp(a, 0, 60);
}

export interface TireInput {
  /** Contact point velocity along and across the wheel, m/s. */
  vLong: number;
  vLat: number;
  /** Normal load, N. */
  load: number;
  /** Mass the wheel carries, kg. */
  mass: number;
  dt: number;
  /** Engine force demanded at this wheel, N (signed). */
  driveForce: number;
  /** Brake force this wheel can apply, N. */
  brakeForce: number;
  /** Scales every grip limit (surface, handbrake lock). */
  gripMult: number;
  /** Scales only the lateral limit (a spinning wheel, a locked rear). */
  lateralMult: number;
}

export interface TireOutput {
  fLong: number;
  fLat: number;
  slipAngle: number;
  /** The driven wheel asked for more than the tyre can hold. */
  spinning: boolean;
  /** 0 to 1: how far into a slide. */
  slip: number;
}

export function newTireOutput(): TireOutput {
  return { fLong: 0, fLat: 0, slipAngle: 0, spinning: false, slip: 0 };
}

export function tireForce(s: TireInput, t: HandlingData['traction'], out: TireOutput): TireOutput {
  out.fLong = out.fLat = out.slipAngle = out.slip = 0;
  out.spinning = false;
  if (s.load <= 0) return out;

  const alpha = Math.atan2(Math.abs(s.vLat), Math.abs(s.vLong) + SLIP_SPEED_FLOOR);
  out.slipAngle = alpha;
  const muLat = tractionCoefficient(alpha, t) * s.gripMult * s.lateralMult;
  const muLong = t.curveMax * t.longitudinalMult * s.gripMult;
  const maxLong = muLong * s.load;

  // Longitudinal: engine, then brakes (which can stop the wheel but not reverse it within a step).
  let fLong = s.driveForce;
  const spinning = Math.abs(fLong) > maxLong * 0.92;
  if (spinning) fLong = Math.sign(fLong) * (t.curveMin / t.curveMax) * maxLong;
  if (s.brakeForce > 0 && s.vLong !== 0) {
    const stopForce = (Math.abs(s.vLong) * s.mass) / s.dt;
    fLong -= Math.sign(s.vLong) * Math.min(s.brakeForce, stopForce);
  }
  fLong = clamp(fLong, -maxLong, maxLong);

  // Lateral: pull the slip velocity to zero, up to the limit the traction curve allows.
  const maxLat = muLat * s.load;
  let fLat = ((-s.vLat * s.mass) / s.dt) * t.lateralStiffness;
  fLat = clamp(fLat, -maxLat, maxLat);

  // Friction circle: hard braking or driving leaves less for cornering (never less than half).
  const use = maxLong > 0 ? Math.abs(fLong) / maxLong : 0;
  fLat *= Math.sqrt(1 - Math.min(1, use * 0.85) ** 2);

  const peak = t.curveLateralDeg * DEG;
  out.fLong = fLong;
  out.fLat = fLat;
  out.spinning = spinning;
  out.slip = spinning ? 1 : smoothstep(peak, peak * 2.5, alpha);
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

/**
 * Drift assist: an angular acceleration about the vertical axis (rad/s^2, positive turns left)
 * that holds the slide angle where the driver's steering asks for it. Active while the handbrake is
 * held or the car is already sliding past about 8 degrees, and off in ordinary driving.
 *
 * `slideAngle` is the direction of travel relative to the nose (positive when the car travels to the
 * left of where it points), `velTurnRate` how fast the direction of travel is turning. For the
 * slide angle to stay put the nose must turn at that same rate, so the target yaw rate is the
 * travel's turn rate plus a correction toward the angle the steering asks for (right steering
 * asks for the car to travel left of its nose, up to `maxSlideDeg`).
 */
export function driftAssistAccel(
  steer: number,
  yawRate: number,
  velTurnRate: number,
  slideAngle: number,
  speed: number,
  handbrake: boolean,
  a: HandlingData['assists'],
): number {
  if (a.yawAssist <= 0) return 0;
  const active = Math.max(smoothstep(8 * DEG, 20 * DEG, Math.abs(slideAngle)), handbrake ? 1 : 0) * smoothstep(3, 8, speed);
  if (active <= 0) return 0;
  const wanted = clamp(steer, -1, 1) * a.maxSlideDeg * DEG;
  const target = clamp(velTurnRate + 2.5 * (slideAngle - wanted), -a.yawRateMax, a.yawRateMax);
  return clamp((target - yawRate) * 10, -16, 16) * a.yawAssist * active;
}
