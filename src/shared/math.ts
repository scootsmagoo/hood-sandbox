/**
 * Plain-number math shared by the sim and the client. No three.js and no DOM.
 *
 * Conventions: metres, +X east, +Y up, +Z south (north is -Z). An angle `yaw` is a rotation
 * about +Y, positive counter-clockwise seen from above (three.js `rotation.y`). A model faces
 * +Z in its own space, so its forward vector is (sin yaw, 0, cos yaw). A camera looks down -Z,
 * so its forward vector is (-sin yaw, 0, -cos yaw).
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const G = 9.81;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sign = (v: number) => (v < 0 ? -1 : 1);
export const saturate = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach: the fraction to move this step at `rate` (1/s). */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Moves angle `from` toward `to` by at most `maxStep`, along the shortest arc. */
export function approachAngle(from: number, to: number, maxStep: number): number {
  const d = wrapAngle(to - from);
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
}

/** Eases angle `from` toward `to` along the shortest arc; `k` is a fraction in 0..1 (see `damp`). */
export function lerpAngle(from: number, to: number, k: number): number {
  return from + wrapAngle(to - from) * k;
}

/** Yaw of a model whose forward vector (in the xz plane) is (dx, dz). */
export const yawFromDir = (dx: number, dz: number) => Math.atan2(dx, dz);

/**
 * Model yaw for a tile spawn `heading`. The contract gives the three.js `rotation.y` of an object
 * that faces -Z at 0, so the forward vector is (-sin h, -cos h). A model faces +Z, so its yaw is
 * `h + PI`.
 */
export const yawFromTileHeading = (heading: number) => heading + Math.PI;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotation about +Y. */
export function quatFromYaw(yaw: number, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  out.x = 0;
  out.y = Math.sin(yaw / 2);
  out.z = 0;
  out.w = Math.cos(yaw / 2);
  return out;
}

/** Rotates (x, y, z) by a unit quaternion into `out`. */
export function rotateVec(q: Quat, x: number, y: number, z: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  // v' = v + 2w(q x v) + 2 q x (q x v)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/** Rotates by the inverse of a unit quaternion (world to local). */
export function rotateVecInv(q: Quat, x: number, y: number, z: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  return rotateVec({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z, out);
}

/** Yaw (rotation about +Y) of a model's +Z axis, ignoring pitch and roll. */
export function yawOfQuat(q: Quat): number {
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(fx, fz);
}

/** Normalised lerp between two quaternions along the short arc. */
export function nlerpQuat(a: Quat, b: Quat, t: number, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (a.x * bx + a.y * by + a.z * bz + a.w * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = a.x + (bx - a.x) * t;
  const y = a.y + (by - a.y) * t;
  const z = a.z + (bz - a.z) * t;
  const w = a.w + (bw - a.w) * t;
  const l = Math.hypot(x, y, z, w) || 1;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  out.w = w / l;
  return out;
}
