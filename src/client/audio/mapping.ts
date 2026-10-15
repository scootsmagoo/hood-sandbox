/**
 * Audio maths with no browser in it: gears, engine pitch, tyre squeal, impact and distance
 * curves. Everything is SI (m/s, metres) like the rest of the sim.
 */

/** Top speed of each fake gear, m/s. Gear 5 runs from the last threshold to the cap. */
export const GEAR_TOP_SPEED = [9, 18, 27, 36] as const;
export const GEAR_COUNT = GEAR_TOP_SPEED.length + 1;

/** Engine fundamental at idle and at redline, Hz. The sawtooth is the body, the square sits an octave under. */
export const IDLE_HZ = 38;
export const REDLINE_HZ = 150;

/** Sound speed used for the doppler shift. Real air would make a car's shift inaudible; this is tuned for the game. */
export const GAME_SOUND_SPEED = 120;

/** The sim reports a crash when speed drops by more than this, m/s. */
export const IMPACT_THRESHOLD = 4;

/** 1 for a stationary car, 5 at the top gear. */
export function gearFor(speed: number): number {
  const s = Math.abs(speed);
  let gear = 1;
  for (const top of GEAR_TOP_SPEED) if (s >= top) gear++;
  return gear;
}

/**
 * Engine pitch for the car's speed and throttle (0 to 1). Within a gear the revs climb from 50%
 * to 95% of redline; the shift drops them back to 50%, so pitch falls each time the speed
 * crosses a gear threshold. Stopped and idle sits at IDLE_HZ, and throttle revs it up even at rest.
 */
export function enginePitch(speed: number, throttle: number): { gear: number; hz: number; rpm: number } {
  const s = Math.abs(speed);
  const t = clamp01(Math.abs(throttle));
  const gear = gearFor(s);
  const lo = gear === 1 ? 0 : GEAR_TOP_SPEED[gear - 2];
  const hi = gear <= GEAR_TOP_SPEED.length ? GEAR_TOP_SPEED[gear - 1] : lo + 15;
  const inGear = clamp01((s - lo) / (hi - lo));
  let rpm = s < 0.5 ? 0 : 0.5 + 0.45 * inGear;
  rpm = Math.max(rpm, t * 0.3);
  rpm = clamp01(rpm + t * 0.05);
  return { gear, hz: IDLE_HZ + (REDLINE_HZ - IDLE_HZ) * rpm, rpm };
}

/** Tyre squeal level, 0 to 1, from the four wheel slip values and the skid flag. Silent below walking pace. */
export function squealLevel(slips: ArrayLike<number>, skidding: boolean, speed: number): number {
  if (Math.abs(speed) < 3) return 0;
  let worst = skidding ? 0.6 : 0;
  for (let i = 0; i < slips.length; i++) worst = Math.max(worst, clamp01(slips[i]));
  return clamp01(worst);
}

/** Loudness of a crash from the speed it lost, 0 to 1. */
export function impactGain(speedLoss: number): number {
  return clamp01((speedLoss - IMPACT_THRESHOLD) / 16);
}

/** Simple inverse-distance falloff: full volume within a few metres. */
export function distanceGain(distance: number): number {
  return 1 / (1 + Math.max(0, distance) / 10);
}

/** Level of a gunshot at a distance, 0 to 1: gunfire carries, so it falls off slower than a thud and is gone past about 400 m. */
export function gunshotGain(distance: number): number {
  const d = Math.max(0, distance);
  if (d > 420) return 0;
  return Math.pow(1 / (1 + d / 28), 1.15);
}

/** Low-pass cutoff of a gunshot at a distance, Hz: far shots lose their crack and go dull. */
export function gunshotFilterHz(distance: number): number {
  return Math.min(16000, Math.max(650, 16000 / (1 + Math.max(0, distance) / 18)));
}

/**
 * Doppler pitch factor for a source moving at `radialSpeed` (m/s, positive when it is closing on
 * the listener). Clamped, so a sim glitch cannot send the pitch to infinity.
 */
export function dopplerFactor(radialSpeed: number, soundSpeed = GAME_SOUND_SPEED): number {
  const vr = Math.min(radialSpeed, soundSpeed * 0.8);
  return Math.min(2, Math.max(0.5, soundSpeed / (soundSpeed - Math.max(vr, -soundSpeed * 0.8))));
}

/** Metres walked between footsteps. */
export function strideLength(sprinting: boolean): number {
  return sprinting ? 1.0 : 0.7;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
