/**
 * Graphics tiers. Auto picks one from the device, `?graphics=low|medium|high` forces one, and the
 * governor steps down when the frame rate cannot hold. Level-of-detail distances divide the
 * distance they measure by `lodScale` (High 1, Medium 0.75, Low 0.55), so new LOD code should too.
 */

export type TierName = 'low' | 'medium' | 'high';

/**
 * What the look (src/client/render/look/) spends on this tier. 0 is off, and the levels above it
 * are cheaper and fuller versions of the same effect:
 *
 *   facade    procedural windows, floors, grime and lit rooms on the baked walls (1 drops the stain and slab-line noise)
 *   surfaces  asphalt, sidewalk, lawn and roof detail from world position (1 drops the finer octaves)
 *   post      the half-float scene target and composite: 1 is a single grade pass, 2 adds bloom
 *   bloom     bloom levels when post is 2 (1 = quarter size, 2 = quarter and sixteenth)
 *   haze      exponential humid-air fog instead of three's linear fog
 *   lamps     sodium street lamps: glow heads, light pools on the road, poles (1 = fewer and nearer)
 */
export interface TierFx {
  facade: 0 | 1 | 2;
  surfaces: 0 | 1 | 2;
  post: 0 | 1 | 2;
  bloom: 0 | 1 | 2;
  haze: boolean;
  lamps: 0 | 1 | 2;
}

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
  /** Most ambient pedestrians the sim keeps round the player. */
  pedBudget: number;
  /** Ambient traffic density factor: the share of the High tier's cars (40) on this tier. */
  trafficDensity: number;
  fx: TierFx;
}

export const TIERS: Record<TierName, Tier> = {
  low: { name: 'low', pixelRatio: 1, shadowMap: 0, shadowRadius: 0, lodScale: 0.55, far: 700, pedBudget: 24, trafficDensity: 0.5, fx: { facade: 1, surfaces: 1, post: 1, bloom: 0, haze: true, lamps: 1 } },
  medium: { name: 'medium', pixelRatio: 1.5, shadowMap: 1024, shadowRadius: 50, lodScale: 0.75, far: 1400, pedBudget: 40, trafficDensity: 0.75, fx: { facade: 2, surfaces: 2, post: 2, bloom: 2, haze: true, lamps: 2 } },
  high: { name: 'high', pixelRatio: 2, shadowMap: 2048, shadowRadius: 80, lodScale: 1, far: 2600, pedBudget: 60, trafficDensity: 1, fx: { facade: 2, surfaces: 2, post: 2, bloom: 2, haze: true, lamps: 2 } },
};

/** The look: `?gfx=classic` (or `basic`) is the old flat renderer, anything else the GTA IV look of src/client/render/look/. */
export type LookMode = 'gta4' | 'classic';
export function lookMode(params: URLSearchParams): LookMode {
  const g = params.get('gfx');
  return g === 'classic' || g === 'basic' ? 'classic' : 'gta4';
}

/** The names `?gfxoff=` takes (for A/B tests), each switching one `fx` field off. `surface` is accepted for `surfaces`. */
const OFF_KEYS: Record<string, keyof TierFx> = { facade: 'facade', surface: 'surfaces', surfaces: 'surfaces', post: 'post', bloom: 'bloom', haze: 'haze', lamps: 'lamps' };

/** A tier's fx with the parts named in `?gfxoff=a,b,c` turned off. */
export function resolveFx(tier: Tier, params: URLSearchParams): TierFx {
  const fx = { ...tier.fx };
  for (const name of (params.get('gfxoff') ?? '').split(',')) {
    const k = OFF_KEYS[name.trim()];
    if (!k) continue;
    if (k === 'haze') fx.haze = false;
    else fx[k] = 0;
  }
  if (fx.post < 2) fx.bloom = 0;
  return fx;
}

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
