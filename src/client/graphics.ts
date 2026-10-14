/**
 * Graphics tiers. Auto picks one from the device, `?graphics=low|medium|high` forces one, and the
 * governor steps down when the frame rate cannot hold. Level-of-detail distances divide the
 * distance they measure by `lodScale` (High 1, Medium 0.75, Low 0.55), so new LOD code should too.
 */

export type TierName = 'low' | 'medium' | 'high';

export interface Tier {
  name: TierName;
  /** Cap on the device pixel ratio. */
  pixelRatio: number;
  /** Shadow map size, or 0 for no shadows. */
  shadowMap: number;
  /** Half-width of the area around the player that gets shadows, m. */
  shadowRadius: number;
  lodScale: number;
  /** Camera far plane, m. */
  far: number;
}

export const TIERS: Record<TierName, Tier> = {
  low: { name: 'low', pixelRatio: 1, shadowMap: 0, shadowRadius: 0, lodScale: 0.55, far: 700 },
  medium: { name: 'medium', pixelRatio: 1.5, shadowMap: 1024, shadowRadius: 50, lodScale: 0.75, far: 1400 },
  high: { name: 'high', pixelRatio: 2, shadowMap: 2048, shadowRadius: 80, lodScale: 1, far: 2600 },
};

const ORDER: TierName[] = ['low', 'medium', 'high'];

/** A first guess before any frames have been timed. */
export function pickTier(params: URLSearchParams, coarsePointer: boolean, gpuName = ''): Tier {
  const forced = params.get('graphics');
  if (forced === 'low' || forced === 'medium' || forced === 'high') return TIERS[forced];
  if (coarsePointer) return TIERS.medium;
  // Software rasterisers and very old integrated parts.
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpuName)) return TIERS.low;
  return TIERS.high;
}

export function tierBelow(t: TierName): TierName | null {
  const i = ORDER.indexOf(t);
  return i > 0 ? ORDER[i - 1] : null;
}

/**
 * Watches frame times and says when to step down. It averages over a window, waits out a
 * cool-down after each step so the new tier can settle, and never steps back up on its own.
 */
export class GraphicsGovernor {
  /** Frames slower than this (ms) on average, over the window, trigger a step down. */
  budgetMs = 24;
  windowS = 3;
  cooldownS = 6;
  private acc = 0;
  private time = 0;
  private cooldown = 4; // let the page settle after loading
  enabled = true;

  /** Returns true when the tier should drop. */
  update(frameMs: number, dt: number): boolean {
    if (!this.enabled) return false;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return false;
    }
    this.acc += frameMs * dt;
    this.time += dt;
    if (this.time < this.windowS) return false;
    const mean = this.acc / this.time;
    this.acc = this.time = 0;
    if (mean > this.budgetMs) {
      this.cooldown = this.cooldownS;
      return true;
    }
    return false;
  }
}
