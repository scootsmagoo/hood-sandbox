/**
 * Walking toward something without walking into a wall: the heading nearest the direct line that
 * has room to run. The counterpart of `flee.ts`, over the same `ClearProbe`.
 */
import { TAU, wrapAngle } from '../../shared/math';
import type { ClearProbe, FleeOptions } from './flee';
import { FLEE_DEFAULTS } from './flee';

export interface SeekChoice {
  heading: number;
  clear: number;
  blocked: boolean;
}

/** Heading (direction (sin h, cos h) in x, z) toward a point. */
export const headingTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

export function chooseSeekHeading(
  x: number,
  z: number,
  tx: number,
  tz: number,
  current: number | null,
  probe: ClearProbe,
  opts: Readonly<FleeOptions> = FLEE_DEFAULTS,
): SeekChoice {
  const direct = headingTo(x, z, tx, tz);
  const dist = Math.hypot(tx - x, tz - z);
  const look = Math.min(opts.look, Math.max(dist, 1));
  // Open ground straight to the target: go.
  const straight = probe(direct, look);
  if (straight >= look - 0.01) return { heading: direct, clear: straight, blocked: false };
  let best: SeekChoice = { heading: direct, clear: straight, blocked: true };
  let bestScore = -Infinity;
  for (let i = 0; i < opts.samples; i++) {
    const h = wrapAngle(direct + (i / opts.samples) * TAU);
    const clear = Math.min(opts.look, Math.max(0, probe(h, opts.look)));
    const open = clear >= opts.minClear;
    const score = Math.cos(wrapAngle(h - direct)) + (1.4 * clear) / opts.look + (current === null ? 0 : 0.35 * Math.cos(wrapAngle(h - current))) - (open ? 0 : 3);
    if (score > bestScore) {
      bestScore = score;
      best = { heading: h, clear, blocked: !open };
    }
  }
  return best;
}
