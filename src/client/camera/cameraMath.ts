/**
 * The pure parts of the camera: where the arm points, where the chase camera wants to look, how
 * far back it sits. Angles follow shared/math.ts: a camera at `yaw` looks along (-sin, -cos) and
 * sits on the opposite side of its pivot.
 */
import { lerpAngle, smoothstep, wrapAngle, clamp } from '../../shared/math';

/** Unit vector from the pivot to the camera for a camera looking with `yaw` and `pitch` (pitch below 0 looks down). */
export function armDirection(yaw: number, pitch: number, out = { x: 0, y: 0, z: 0 }) {
  const cp = Math.cos(pitch);
  out.x = Math.sin(yaw) * cp;
  out.y = -Math.sin(pitch);
  out.z = Math.cos(yaw) * cp;
  return out;
}

/** Camera yaw that looks along a model's forward direction `modelYaw`. */
export const cameraYawBehind = (modelYaw: number) => modelYaw - Math.PI;

/**
 * Where a chase camera wants to point: along the car's nose at low speed, and increasingly along
 * the direction of travel as speed rises, so a drifting car shows its side. Reversing keeps the
 * nose. Returns a camera yaw.
 */
export function chaseYaw(carYaw: number, vx: number, vz: number, forwardSpeed: number): number {
  const speed = Math.hypot(vx, vz);
  let heading = carYaw;
  if (forwardSpeed > 2 && speed > 2) {
    const travel = Math.atan2(vx, vz);
    heading = lerpAngle(carYaw, travel, 0.65 * smoothstep(3, 14, speed));
  }
  return cameraYawBehind(heading);
}

/** How far behind the pivot the chase camera sits, m. `preset` is 0 near, 1 mid, 2 far. */
export function chaseDistance(speed: number, preset: number): number {
  const base = [5.2, 6.6, 8.4][clamp(Math.round(preset), 0, 2)];
  return base + clamp(speed, 0, 50) * 0.05;
}

/** Vertical field of view for a driving speed, degrees. */
export function chaseFov(speed: number): number {
  return 64 + 16 * smoothstep(8, 48, speed);
}

/** Eases `current` toward `target` along the short arc at `rate` per second. */
export function followAngle(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * Pulls the camera in when the sim reports a wall in the way, and eases it back out slowly: snapping
 * in avoids seeing through walls, easing out avoids a bounce at every post.
 */
export function armLength(current: number, wanted: number, clear: number, dt: number): number {
  const limit = Math.max(0.35, Math.min(wanted, clear - 0.08));
  return limit < current ? limit : current + (limit - current) * (1 - Math.exp(-3 * dt));
}
