/**
 * The sun over Atlanta as pure functions of the game clock (minutes since midnight): its elevation
 * and how night it is. The sim needs them (a helicopter's searchlight), the client needs them (the
 * sky), so they live here; `src/client/render/timeOfDay.ts` re-exports them next to the parts that
 * need three.js.
 *
 * Game axes: +X east, +Y up, -Z north (as in the HUD's compass).
 */

/** Atlanta's latitude, degrees north. */
export const LATITUDE_DEG = 33.75;
/** The sun's declination on mid-October, degrees. */
export const DECLINATION_DEG = -8;
/** Solar noon in mid-October (Eastern daylight time), hours after midnight. */
export const SOLAR_NOON_H = 13.38;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Sine of the sun's elevation, and its east and north components, from the solar arc. */
export function solar(minutes: number): { east: number; north: number; up: number } {
  const H = (minutes / 60 - SOLAR_NOON_H) * 15 * D2R;
  const phi = LATITUDE_DEG * D2R;
  const del = DECLINATION_DEG * D2R;
  const cosH = Math.cos(H);
  const cosDel = Math.cos(del);
  return {
    east: -cosDel * Math.sin(H),
    north: Math.sin(del) * Math.cos(phi) - cosDel * Math.sin(phi) * cosH,
    up: Math.sin(del) * Math.sin(phi) + cosDel * Math.cos(phi) * cosH,
  };
}

/** The sun's elevation above the horizon, degrees (negative at night). */
export function sunElevation(minutes: number): number {
  return Math.asin(Math.max(-1, Math.min(1, solar(minutes).up))) * R2D;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0 in full daylight, 1 once the sun is well below the horizon. Dusk and dawn sit between. */
export function nightFactor(minutes: number): number {
  return 1 - smoothstep(-6, 4, sunElevation(minutes));
}

/** True when the night lights should be on (the sun is more than about 2 degrees below the horizon). */
export function isNight(minutes: number): boolean {
  return nightFactor(minutes) >= 0.5;
}
