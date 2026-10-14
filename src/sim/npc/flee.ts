/**
 * Fleeing across open ground: pick the heading that gets farthest from a threat without running
 * into something. Pure maths over a `probe` that says how far a heading is clear, so it tests
 * without a physics world.
 *
 * Headings are angles `h` with direction (sin h, cos h) in (x, z), the same as a model's yaw.
 */
import { TAU, wrapAngle } from '../../shared/math';

/** How far a straight run along `heading` is clear, up to `maxDist` (m). */
export type ClearProbe = (heading: number, maxDist: number) => number;

export interface FleeOptions {
  /** How far ahead to look, m. */
  look: number;
  /** Headings tried, evenly spread round the circle. */
  samples: number;
  /** A heading with less room than this is blocked, m. */
  minClear: number;
}

export const FLEE_DEFAULTS: Readonly<FleeOptions> = { look: 7, samples: 16, minClear: 1.8 };

export interface FleeChoice {
  heading: number;
  /** Room along it, m. */
  clear: number;
  /** Every heading is blocked. */
  cornered: boolean;
}

/** Heading that points straight away from a threat. */
export function awayHeading(x: number, z: number, threatX: number, threatZ: number): number {
  const dx = x - threatX;
  const dz = z - threatZ;
  return dx === 0 && dz === 0 ? 0 : Math.atan2(dx, dz);
}

/**
 * Scores each heading by how directly it leads away, how much room it has, and (so a runner does
 * not dither between two equal choices) how close it is to the heading already taken.
 */
export function chooseFleeHeading(
  x: number,
  z: number,
  threatX: number,
  threatZ: number,
  current: number | null,
  probe: ClearProbe,
  opts: Readonly<FleeOptions> = FLEE_DEFAULTS,
): FleeChoice {
  const away = awayHeading(x, z, threatX, threatZ);
  let best: FleeChoice = { heading: away, clear: 0, cornered: true };
  let bestScore = -Infinity;
  let anyOpen = false;
  for (let i = 0; i < opts.samples; i++) {
    const h = wrapAngle(away + (i / opts.samples) * TAU);
    const clear = Math.min(opts.look, Math.max(0, probe(h, opts.look)));
    const open = clear >= opts.minClear;
    if (open) anyOpen = true;
    const score = 1.0 * Math.cos(wrapAngle(h - away)) + (1.6 * clear) / opts.look + (current === null ? 0 : 0.35 * Math.cos(wrapAngle(h - current))) - (open ? 0 : 3);
    if (score > bestScore) {
      bestScore = score;
      best = { heading: h, clear, cornered: false };
    }
  }
  best.cornered = !anyOpen;
  return best;
}
