/**
 * Pure geometry for the radar (minimap.ts): world to radar, the radar's zoom, and the affine
 * transform that blits a window of the pre-rendered road atlas. No DOM, no three.js, no state.
 *
 * Game axes: +X east, +Z south, north is -Z. A yaw turns about +Y the way `quatFromYaw` does, so
 * an object facing `yaw` looks along (-sin yaw, -cos yaw) in (x, z).
 */
import { clamp } from '../../shared/math';

/** Radar zoom: half the width shown, in metres, at rest and at full speed. */
export const SPAN_REST_M = 110;
export const SPAN_FAST_M = 260;
/** Speed (m/s) at which the radar is fully zoomed out (about 67 mph). */
export const SPAN_FULL_SPEED_MPS = 30;

/** Half-angle of a police vision cone, rad (60 degrees across). */
export const CONE_HALF_ANGLE = (30 * Math.PI) / 180;
/** Reach of a police vision cone, m. */
export const CONE_RANGE_M = 40;
/**
 * Radius of the wanted search circle around the last known position, m. The sim does not publish
 * a search radius (only `lastKnown`), so this is a client-side stand-in.
 */
export const SEARCH_RADIUS_M = 60;

/** Radar zoom for a speed: smoothstep from the resting span to the fast span. */
export function zoomForSpeed(speedMps: number): number {
  const s = clamp(Number.isFinite(speedMps) ? speedMps / SPAN_FULL_SPEED_MPS : 0, 0, 1);
  const t = s * s * (3 - 2 * s);
  return SPAN_REST_M + (SPAN_FAST_M - SPAN_REST_M) * t;
}

/**
 * Forward direction (x, z) of a yaw, written to `out` (index 0 is x, 1 is z). The radar's "up" is
 * the camera's forward direction, so this is used for the camera and for every heading.
 */
export function headingVector(yaw: number, out: Float64Array = new Float64Array(2)): Float64Array {
  out[0] = -Math.sin(yaw);
  out[1] = -Math.cos(yaw);
  return out;
}

/**
 * A world offset (dx, dz) from the radar centre, in radar pixels, with the camera's forward
 * direction (fx, fz) pointing up. Right of the forward direction is `(-fz, fx)`.
 * Returns the x and y through `out`: y grows downwards, as canvas does.
 */
export function worldToRadar(dx: number, dz: number, fx: number, fz: number, pxPerM: number, out: { x: number; y: number }): { x: number; y: number } {
  const rx = -fz;
  const rz = fx;
  out.x = (dx * rx + dz * rz) * pxPerM;
  out.y = -(dx * fx + dz * fz) * pxPerM;
  return out;
}

/**
 * The canvas transform (a, b, c, d, e, f) that maps the road atlas's pixels onto the radar, with the
 * atlas point (px, py) at the radar centre (cx, cy). `k` is radar pixels per atlas pixel, and `dpr`
 * the device scale. Written into `out` (6 numbers).
 */
export function radarTransform(
  fx: number,
  fz: number,
  atlasPx: number,
  atlasPy: number,
  cx: number,
  cy: number,
  k: number,
  out: Float64Array,
): Float64Array {
  const rx = -fz;
  const rz = fx;
  out[0] = k * rx;
  out[1] = -k * fx;
  out[2] = k * rz;
  out[3] = -k * fz;
  out[4] = cx - k * (rx * atlasPx + rz * atlasPy);
  out[5] = cy + k * (fx * atlasPx + fz * atlasPy);
  return out;
}

/** True when a world offset lies within `range` metres of the centre. */
export function withinRange(dx: number, dz: number, range: number): boolean {
  return dx * dx + dz * dz <= range * range;
}

/** 0 or 1, alternating every `periodMs / 2`: the lightbar's red and blue. */
export function flashPhase(nowMs: number, periodMs = 500): number {
  return Math.floor(nowMs / (periodMs / 2)) & 1;
}
