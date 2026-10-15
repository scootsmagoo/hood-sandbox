/**
 * The pure parts of on-foot movement: how a stick or key press becomes a target velocity, and how
 * velocity approaches it. The capsule and the collision are in PedController.ts.
 */
import { clamp, lerp } from '../../shared/math';

export const PED = {
  /** Walking, jogging and sprinting speeds, m/s: a normal walk (3.4 mph), an 8-minute-mile jog (7.4 mph) and a fit person's flat-out sprint (12.3 mph). */
  walkSpeed: 1.5,
  runSpeed: 3.3,
  sprintSpeed: 5.5,
  /**
   * GTA IV's character has weight: about a third of a second to get up to a jog, a step or so to stop from a walk, and a
   * short slide (about a metre) when a sprint is let go. `groundDecel` is the stop from a walk; from a sprint it eases to
   * `sprintDecel`.
   */
  groundAccel: 15,
  groundDecel: 30,
  sprintDecel: 13,
  airAccel: 9,
  jumpSpeed: 6.6,
  gravity: 22,
  /** Grace after leaving a ledge, and how early a jump press is remembered, s. */
  coyoteTime: 0.12,
  jumpBuffer: 0.12,
  /** Turn rate toward the movement direction, rad/s (a half turn in about a third of a second). */
  turnRate: 9,
  /** Capsule: radius and half the straight part, m. */
  radius: 0.32,
  halfHeight: 0.55,
  /** Tallest ledge taken in stride, m, and the slope limit, degrees. */
  maxStep: 0.45,
  maxSlopeDeg: 55,
  terminalSpeed: 40,
} as const;

/** Feet are this far below the capsule's centre. */
export const PED_FEET_OFFSET = PED.halfHeight + PED.radius;

export interface WishVelocity {
  x: number;
  z: number;
  /** 0 to 1, how hard the stick is pushed. */
  magnitude: number;
}

/**
 * Camera-relative movement to a world velocity. `moveX` is +1 right and `moveY` +1 forward, and
 * the camera at `camYaw` looks along (-sin, -cos). A half-pushed stick walks, a full one jogs, and
 * sprinting needs a firm push.
 */
export function wishVelocity(moveX: number, moveY: number, camYaw: number, sprint: boolean, out: WishVelocity): WishVelocity {
  let mx = clamp(moveX, -1, 1);
  let my = clamp(moveY, -1, 1);
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }
  const mag = Math.min(1, len);
  const s = Math.sin(camYaw);
  const c = Math.cos(camYaw);
  // forward = (-s, -c), right = (c, -s)
  const dx = -s * my + c * mx;
  const dz = -c * my - s * mx;
  const dl = Math.hypot(dx, dz);
  let speed: number;
  if (mag < 0.05) speed = 0;
  else if (sprint && mag > 0.5) speed = PED.sprintSpeed;
  else if (mag <= 0.5) speed = lerp(0, PED.walkSpeed, mag / 0.5);
  else speed = lerp(PED.walkSpeed, PED.runSpeed, (mag - 0.5) / 0.5);
  out.x = dl > 0 ? (dx / dl) * speed : 0;
  out.z = dl > 0 ? (dz / dl) * speed : 0;
  out.magnitude = mag;
  return out;
}

/** Moves the horizontal velocity toward the wish at the ground or air rate. Writes into `v`. */
export function approachVelocity(v: { x: number; z: number }, wx: number, wz: number, grounded: boolean, dt: number) {
  const dx = wx - v.x;
  const dz = wz - v.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return;
  const wishSpeed = Math.hypot(wx, wz);
  const speed = Math.hypot(v.x, v.z);
  const speeding = wishSpeed < speed;
  // slowing from a run takes longer than from a walk (the body's momentum), and so does turning hard at one
  const decel = PED.groundDecel + (PED.sprintDecel - PED.groundDecel) * Math.min(1, Math.max(0, (speed - PED.walkSpeed) / (PED.sprintSpeed - PED.walkSpeed)));
  const rate = grounded ? (speeding ? decel : PED.groundAccel) : PED.airAccel;
  const step = Math.min(dist, rate * dt);
  v.x += (dx / dist) * step;
  v.z += (dz / dist) * step;
}
