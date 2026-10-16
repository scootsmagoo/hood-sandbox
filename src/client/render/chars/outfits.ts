/**
 * What each outfit index (`PedDef.outfit`) looks like: which body (an archetype of the Blender
 * character set) and which colours for its regions. Skin, hair and a little tint come from the
 * person's id, so a street of one outfit is not a street of twins.
 *
 * Outfits are grouped by the pedestrian groups of data/cities/atlanta/population.json: business
 * 1 2 18 19, students 3 4 8, tourists 5 6, locals 7 8 9 20, nightlife 10 11 12, workers 13 14,
 * unhoused 15 16 17. 0 is the protagonist, Keon "Kudzu" Mabry. Officers use the officer bodies in the
 * agency's colour (`officerOutfit`).
 */
import type { PedLook } from '../models';

/** The material regions of a character mesh, in the order of tools/blender/characters/skeleton.py's slots. */
export const REGIONS = ['skin', 'lip', 'eye', 'sclera', 'hair', 'top', 'top2', 'bottom', 'shoe', 'sole', 'belt', 'hat', 'gear', 'trim', 'stubble', 'face'] as const;
export type Region = (typeof REGIONS)[number];
export const REGION_COUNT = REGIONS.length;
export const R = Object.fromEntries(REGIONS.map((r, i) => [r, i])) as Record<Region, number>;

export type Archetype =
  | 'kudzu' | 'suit_m' | 'office_f' | 'casual_m' | 'casual_m_cap' | 'casual_f' | 'hoodie_m' | 'hoodie_m_beanie' | 'dress_f' | 'worker_m' | 'tourist_m' | 'layers_m' | 'layers_f' | 'student_f' | 'officer_m' | 'officer_f';

/** In the order tools/blender/characters/outfits.py registers them. */
export const ARCHETYPES: readonly Archetype[] = ['kudzu', 'suit_m', 'office_f', 'casual_m', 'casual_m_cap', 'casual_f', 'hoodie_m', 'hoodie_m_beanie', 'dress_f', 'worker_m', 'tourist_m', 'layers_m', 'layers_f', 'student_f', 'officer_m', 'officer_f'];

export interface CharOutfit {
  arch: Archetype;
  top: number;
  top2: number;
  bottom: number;
  shoe: number;
  sole?: number;
  hat?: number;
  gear?: number;
  trim?: number;
  /** A fixed skin tone and hair colour (the protagonist). */
  skin?: number;
  hair?: number;
}

const o = (arch: Archetype, top: number, top2: number, bottom: number, shoe: number, rest: Partial<CharOutfit> = {}): CharOutfit => ({ arch, top, top2, bottom, shoe, ...rest });

export const CHAR_OUTFITS: readonly CharOutfit[] = [
  /* 0  Kudzu */ o('kudzu', 0x7a5f3c, 0x3b2e22, 0x2a3446, 0x5a3d22, { skin: 0x6a4430, hair: 0x120d0a, sole: 0x2a2520 }),
  /* 1  business */ o('suit_m', 0x1f2a3d, 0xdfe3e8, 0x1f2a3d, 0x16120f, { trim: 0x7a1e2c }),
  /* 2  business */ o('office_f', 0x3a3d45, 0xe8e2d8, 0x3a3d45, 0x241a16),
  /* 3  students */ o('hoodie_m_beanie', 0x555b66, 0x3c4048, 0x2c3140, 0xe8e6e0, { hat: 0x2b3a55 }),
  /* 4  students */ o('student_f', 0x8a3b4d, 0xe6d9cc, 0x2d3646, 0xf0eee8, { gear: 0x2f5d6a }),
  /* 5  tourists */ o('tourist_m', 0x4a86a8, 0xe9e4d6, 0xb8a98a, 0xe4e2dc, { hat: 0xd9d4c4, gear: 0x30343a }),
  /* 6  tourists */ o('casual_f', 0xd9c26a, 0xf0ece0, 0x4d6178, 0xe8e4dc, { hat: 0x2d3a4a }),
  /* 7  locals */ o('casual_m', 0x9c3b30, 0xe9e5dc, 0x38414f, 0xd8d4cc),
  /* 8  locals, students */ o('casual_f', 0x4f7d6a, 0xe4ddd0, 0x2c3644, 0x2a2724),
  /* 9  locals */ o('hoodie_m', 0x1e2126, 0x15171a, 0x2a2f3a, 0x8a1f1f, { hat: 0x1e2126 }),
  /* 10 nightlife */ o('dress_f', 0x7b1f3c, 0xd9c5a8, 0x7b1f3c, 0x17120f),
  /* 11 nightlife */ o('casual_m_cap', 0x232a3a, 0xe8e4da, 0x15171b, 0x191512),
  /* 12 nightlife */ o('hoodie_m_beanie', 0x3a2f55, 0x2b2342, 0x1a1d24, 0xd8d6d0),
  /* 13 workers */ o('worker_m', 0x3d4a38, 0xc9ccd0, 0x4a4235, 0x4c3a24, { trim: 0xd6e04a, hat: 0xe8e4dc }),
  /* 14 workers */ o('casual_m', 0x4a6c8c, 0xe0dccf, 0x3a3f46, 0x4a3a28),
  /* 15 unhoused */ o('layers_m', 0x4c5a47, 0x6a6258, 0x4a4a42, 0x3a3630, { hat: 0x2a2f38, gear: 0x35402e }),
  /* 16 unhoused */ o('layers_f', 0x6a5a4a, 0x8a7d70, 0x2f333a, 0x3a342e, { hat: 0x5a4a6a, gear: 0x6a4a3a }),
  /* 17 unhoused */ o('hoodie_m', 0x6b4a3a, 0x4a3a30, 0x3c4048, 0x4a4540, { hat: 0x3a3f46 }),
  /* 18 business */ o('suit_m', 0x4a4d52, 0xc8d6e6, 0x4a4d52, 0x251c16, { trim: 0x27406a }),
  /* 19 business */ o('office_f', 0x1d3350, 0xd8d2c8, 0x1d3350, 0x201815),
  /* 20 locals */ o('casual_f', 0xc9573d, 0xe6dcd0, 0x2f3a4c, 0xe0ddd5),
];

export const CHAR_OUTFIT_COUNT = CHAR_OUTFITS.length;

/** Skin tones (sRGB) with weights. */
const SKIN: [number, number][] = [
  [0x5a3b2a, 0.1], [0x6d4631, 0.14], [0x7f5239, 0.12], [0x926243, 0.12], [0xa87450, 0.07],
  [0xbf8a60, 0.08], [0xd0a07a, 0.1], [0xe0b490, 0.12], [0xeec7a6, 0.1], [0xf5d5ba, 0.05],
];
const HAIR: [number, number][] = [[0x15110e, 0.52], [0x2a1c12, 0.23], [0x4a3020, 0.11], [0x5c2e1a, 0.02], [0xa07a42, 0.06], [0x8a8a88, 0.04], [0xc8c8c4, 0.02]];

/** A cheap hash of an id to 0..1, per salt. */
export function unit(id: number, salt: number): number {
  let h = (Math.imul(id + 1, 2654435761) ^ Math.imul(salt + 7, 40503)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function pick(table: [number, number][], u: number): number {
  let acc = 0;
  for (const [c, w] of table) {
    acc += w;
    if (u < acc) return c;
  }
  return table[table.length - 1][0];
}

/** Body height of a person, 0.93 to 1.07 of the standard figure, and a width that goes with it. */
export const heightOf = (id: number) => 0.93 + unit(id, 12) * 0.14;
export const widthOf = (id: number) => 0.95 + unit(id, 13) * 0.1;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** 0xRRGGBB (sRGB) to linear [r, g, b]. */
export function lin(hex: number, out: number[] = [0, 0, 0]): number[] {
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
  return out;
}

const mixHex = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const shadeHex = (c: number, k: number) => mixHex(c, k < 1 ? 0x000000 : 0xffffff, Math.abs(1 - k));
/** A colour with its lightness and hue nudged by amounts from -1 to 1 (small). */
function tintHex(c: number, hue: number, lum: number): number {
  let r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  h = (h + hue + 1) % 1;
  const l2 = Math.min(0.95, Math.max(0.03, l + lum));
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
  const p = 2 * l2 - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  if (s === 0) { r = g = b = l2; } else { r = f(h + 1 / 3); g = f(h); b = f(h - 1 / 3); }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/** What one person wears: the archetype, a palette (linear rgb per region), and their size. */
export interface Appearance {
  arch: Archetype;
  /** REGION_COUNT x 3 linear colours. */
  palette: Float32Array;
  height: number;
  width: number;
  /** The look for the box figures (`?peds=box`) and the box ragdoll. */
  look: PedLook;
}

const UNIFORM_ARCH: Archetype[] = ['officer_m', 'officer_f'];

/** The outfit an officer wears: agency colours (the sim's `uniform`), a cap, a duty belt. */
export function officerOutfit(uniform: number, id: number): CharOutfit {
  return { arch: UNIFORM_ARCH[unit(id, 21) < 0.22 ? 1 : 0], top: uniform, top2: shadeHex(uniform, 0.75), bottom: shadeHex(uniform, 0.55), shoe: 0x14120f, hat: shadeHex(uniform, 0.7), gear: 0x111214, trim: 0xb9b27a };
}

export function appearanceOf(outfit: CharOutfit, id: number, police = false): Appearance {
  const fixedSkin = outfit.skin;
  const skin = fixedSkin ?? pick(SKIN, unit(id, 7));
  const hair = outfit.hair ?? pick(HAIR, unit(id, 8));
  const t = (hex: number, k: number, hueAmp: number, lumAmp: number) => (police ? hex : tintHex(hex, (unit(id, k) - 0.5) * hueAmp, (unit(id, k + 20) - 0.5) * lumAmp));
  const top = t(outfit.top, 1, 0.08, 0.1);
  const top2 = t(outfit.top2, 3, 0.04, 0.08);
  const bottom = t(outfit.bottom, 4, 0.06, 0.1);
  const shoe = t(outfit.shoe, 5, 0.04, 0.1);
  const hat = outfit.hat !== undefined ? t(outfit.hat, 6, 0.3, 0.1) : top;
  const cols: Record<Region, number> = {
    skin,
    lip: shadeHex(mixHex(skin, 0x8a3b3b, 0.35), 0.85),
    eye: 0x120d0b,
    sclera: 0xcfc8bd,
    hair,
    top,
    top2,
    bottom,
    shoe,
    sole: outfit.sole ?? (outfit.arch === 'kudzu' ? 0x2a2520 : mixHex(shoe, 0xd8d4cc, 0.65)),
    belt: 0x14120f,
    hat,
    gear: outfit.gear ?? 0x24272c,
    trim: outfit.trim ?? 0xb8b8b0,
    stubble: mixHex(skin, hair, 0.5),
    face: skin,
  };
  const palette = new Float32Array(REGION_COUNT * 3);
  const tmp = [0, 0, 0];
  REGIONS.forEach((r, i) => {
    lin(cols[r], tmp);
    palette.set(tmp, i * 3);
  });
  return { arch: outfit.arch, palette, height: heightOf(id), width: widthOf(id), look: { jacket: top, jeans: bottom, skin, cap: outfit.hat !== undefined || police ? hat : null } };
}

/** The outfit table as the stand-in figures' looks (`?peds=box`, and the box ragdoll). */
export function lookOf(outfit: number): PedLook {
  const c = CHAR_OUTFITS[outfit % CHAR_OUTFIT_COUNT];
  return { jacket: c.top, jeans: c.bottom, skin: c.skin ?? 0x9a6b4b, cap: c.hat ?? null };
}
