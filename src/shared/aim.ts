/**
 * The over-the-shoulder aim camera, in numbers shared by the client (which draws it) and the sim
 * (which reconstructs the crosshair ray from the camera angles the client sends every command, so
 * the bullet goes where the crosshair is). Angles follow shared/math.ts: a camera at `yaw` looks
 * along (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch); pitch below 0 looks down.
 */
import type { Vec3 } from './math';

export const AIM = {
  /** Vertical field of view while aiming (it is 62 on foot), degrees. */
  fov: 48,
  /** Camera arm behind the pivot, on foot and from a car, m. From a car the camera sits at the driver's eye inside the cabin, which is see-through from within, so the window is clear. */
  arm: 3.3,
  armCar: 0.45,
  /** The camera sits this far to the right of the pivot. */
  shoulder: 0.85,
  shoulderCar: 0.1,
  /** Pivot height above the feet (on foot) or above the seat's root (in a car: eye level of the seated figure), m. */
  pivotFoot: 1.62,
  pivotCar: 1.35,
  /** Mouse sensitivity while aiming, as a share of the normal. */
  lookScale: 0.62,
  /** Walking pace while aiming, as a share of the normal. */
  moveScale: 0.55,
  /** Pitch limits while aiming, radians. */
  pitchMin: -1.15,
  pitchMax: 1.0,
} as const;

/** Unit vector from the camera forward along its view for `yaw` and `pitch`. */
export function viewDirection(yaw: number, pitch: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** The camera's right-hand unit vector (horizontal) for a yaw. */
export function viewRight(yaw: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

/** Where the aim camera sits for a pivot, view angles, arm length and shoulder offset. */
export function aimCameraPosition(pivot: Vec3, yaw: number, pitch: number, arm: number, shoulder: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const v = viewDirection(yaw, pitch);
  const r = viewRight(yaw);
  out.x = pivot.x - v.x * arm + r.x * shoulder;
  out.y = pivot.y - v.y * arm;
  out.z = pivot.z - v.z * arm + r.z * shoulder;
  return out;
}
