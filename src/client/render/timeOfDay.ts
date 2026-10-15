/**
 * Time of day as the look of the world: the sun's arc for Atlanta, the sky, fog, light colours and
 * exposure for each moment, and the URL options that set the clock. Everything here is pure, so it
 * can be tested without a GPU; `Atmosphere` applies the result to the scene.
 *
 * Game axes: +X east, +Y up, -Z north (as in the HUD's compass).
 */
import * as THREE from 'three';

import { DECLINATION_DEG, LATITUDE_DEG, SOLAR_NOON_H, isNight, nightFactor, smoothstep, solar, sunElevation } from '../../shared/daylight';

// The sun's arc and the night factor are pure and the sim uses them too (the helicopter's searchlight): see shared/daylight.ts.
export { DECLINATION_DEG, LATITUDE_DEG, SOLAR_NOON_H, isNight, nightFactor, sunElevation };

const MINUTES_PER_DAY = 1440;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Unit vector pointing at the sun, in game axes. Written into `out`. */
export function sunDirection(minutes: number, out: THREE.Vector3): THREE.Vector3 {
  const s = solar(minutes);
  return out.set(s.east, s.up, -s.north);
}

/** The sky's warm wash at dusk and dawn: strongest at the horizon, gone by about 14 degrees either side. */
export function warmth(minutes: number): number {
  return 0.85 * (1 - smoothstep(0, 14, Math.abs(sunElevation(minutes))));
}

/** The moon sits opposite the sun, held above the horizon so the night still has a light to cast shadows. */
export function moonDirection(minutes: number, out: THREE.Vector3): THREE.Vector3 {
  const s = solar(minutes);
  const y = Math.max(0.35, -s.up);
  return out.set(-s.east, y, s.north).normalize();
}

/** The colours, light levels and exposure the scene is drawn with at one moment. */
export interface SkyLook {
  horizon: THREE.Color;
  zenith: THREE.Color;
  /** Fog takes the horizon colour, so distant streets melt into the sky. */
  fog: THREE.Color;
  sun: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  ambient: number;
  exposure: number;
  /** Distance, m, at which the haze has swallowed nearly everything (the exponential fog's range). */
  visibility: number;
  /** How dark a shadow is, 0 to 1 (an overcast sun leaves pale shadows), and how soft its edge is (PCF radius, texels). */
  shadowIntensity: number;
  shadowSoftness: number;
}

export function newSkyLook(): SkyLook {
  return {
    horizon: new THREE.Color(),
    zenith: new THREE.Color(),
    fog: new THREE.Color(),
    sun: new THREE.Color(),
    sunIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    ambient: 0,
    exposure: 1,
    visibility: 1300,
    shadowIntensity: 1,
    shadowSoftness: 1,
  };
}

interface Palette {
  horizon: THREE.Color;
  zenith: THREE.Color;
  sun: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  ambient: number;
  exposure: number;
  visibility: number;
  shadowIntensity: number;
  shadowSoftness: number;
}

type PaletteSpec = { horizon: number; zenith: number; sun: number; sunIntensity: number; hemiSky: number; hemiGround: number; hemiIntensity: number; ambient: number; exposure: number; visibility?: number; shadowIntensity?: number; shadowSoftness?: number };

function palette(p: PaletteSpec): Palette {
  return {
    horizon: new THREE.Color(p.horizon),
    zenith: new THREE.Color(p.zenith),
    sun: new THREE.Color(p.sun),
    sunIntensity: p.sunIntensity,
    hemiSky: new THREE.Color(p.hemiSky),
    hemiGround: new THREE.Color(p.hemiGround),
    hemiIntensity: p.hemiIntensity,
    ambient: p.ambient,
    exposure: p.exposure,
    visibility: p.visibility ?? 1300,
    shadowIntensity: p.shadowIntensity ?? 1,
    shadowSoftness: p.shadowSoftness ?? 1,
  };
}

/** The three anchor moments a look is made of; `skyLook` blends them by the clock. */
export interface SkyPalette {
  day: Palette;
  night: Palette;
  warm: Palette;
  /** Pull the sky light (the hemisphere light's sky colour) halfway to the colour of the sky itself, so it tracks the sky through the day. */
  trackSky?: boolean;
}

/** `?gfx=classic`: the look the game had before the graphics overhaul. Full daylight, a blue-white sky, a dark blue night, orange dusk. */
export const CLASSIC: SkyPalette = {
  day: palette({ horizon: 0xc9d8e2, zenith: 0x4a82c4, sun: 0xfff0d8, sunIntensity: 2.2, hemiSky: 0xd6e4ff, hemiGround: 0x8a8574, hemiIntensity: 2.3, ambient: 0.12, exposure: 1.05 }),
  night: palette({ horizon: 0x1b2a4a, zenith: 0x070d20, sun: 0x9db4ff, sunIntensity: 0.75, hemiSky: 0x4a6a9e, hemiGround: 0x23262f, hemiIntensity: 1.5, ambient: 0.45, exposure: 1.3 }),
  warm: palette({ horizon: 0xf08a50, zenith: 0x3f5f96, sun: 0xffa060, sunIntensity: 1.9, hemiSky: 0xffc08c, hemiGround: 0x6e4e3a, hemiIntensity: 1.7, ambient: 0.12, exposure: 1.1 }),
};

/**
 * The GTA IV look. Day: humid, hazy and overcast-leaning, a milky yellow-grey horizon under a pale
 * grey-blue sky, a diffuse sun that leaves pale soft shadows and lots of sky light, a brown-green
 * ground bounce. Dusk and dawn: a warm, smoggy glow (dull orange and mauve, not gold). Night: a dark
 * blue-grey sky with a brown-orange light-pollution glow at the horizon, a cold dim moon, and a warm
 * sodium bounce from the ground (the street lamps themselves are in look/lamps.ts). The sky light
 * (`hemiSky`, `hemiGround`) is derived from these sky colours, see `skyLook`.
 */
export const GTA4: SkyPalette = {
  trackSky: true,
  day: palette({ horizon: 0xcac9be, zenith: 0x8a9fb2, sun: 0xffecc8, sunIntensity: 1.55, hemiSky: 0xc9cfd2, hemiGround: 0x80745e, hemiIntensity: 2.45, ambient: 0.12, exposure: 1.0, visibility: 1700, shadowIntensity: 0.72, shadowSoftness: 3 }),
  night: palette({ horizon: 0x4c3626, zenith: 0x0b1222, sun: 0x93a8d8, sunIntensity: 0.5, hemiSky: 0x34405a, hemiGround: 0x4a2e18, hemiIntensity: 2.3, ambient: 0.46, exposure: 1.35, visibility: 900, shadowIntensity: 1, shadowSoftness: 1.5 }),
  warm: palette({ horizon: 0xdf9660, zenith: 0x68718c, sun: 0xffa566, sunIntensity: 1.4, hemiSky: 0xd5a98a, hemiGround: 0x6a4c38, hemiIntensity: 1.8, ambient: 0.12, exposure: 1.08, visibility: 1300, shadowIntensity: 0.88, shadowSoftness: 2 }),
};

const SKY_MIX = new THREE.Color();

/** Writes the look for a moment of the day into `out`. Allocates nothing. */
export function skyLook(minutes: number, out: SkyLook, pal: SkyPalette = GTA4): SkyLook {
  const day = 1 - nightFactor(minutes);
  const warm = warmth(minutes);
  const { day: DAY, night: NIGHT, warm: WARM } = pal;
  const mixColor = (a: THREE.Color, b: THREE.Color, c: THREE.Color, dst: THREE.Color) => {
    dst.lerpColors(a, b, day).lerp(c, warm);
  };
  mixColor(NIGHT.horizon, DAY.horizon, WARM.horizon, out.horizon);
  mixColor(NIGHT.zenith, DAY.zenith, WARM.zenith, out.zenith);
  out.fog.copy(out.horizon);
  mixColor(NIGHT.sun, DAY.sun, WARM.sun, out.sun);
  mixColor(NIGHT.hemiSky, DAY.hemiSky, WARM.hemiSky, out.hemiSky);
  mixColor(NIGHT.hemiGround, DAY.hemiGround, WARM.hemiGround, out.hemiGround);
  if (pal.trackSky) {
    // the sky as seen from the ground: mostly the hazy horizon, some of the zenith
    SKY_MIX.lerpColors(out.zenith, out.horizon, 0.6).multiplyScalar(1.15);
    out.hemiSky.lerp(SKY_MIX, 0.5);
  }
  out.sunIntensity = lerp3(NIGHT.sunIntensity, DAY.sunIntensity, WARM.sunIntensity, day, warm);
  out.hemiIntensity = lerp3(NIGHT.hemiIntensity, DAY.hemiIntensity, WARM.hemiIntensity, day, warm);
  out.ambient = lerp3(NIGHT.ambient, DAY.ambient, WARM.ambient, day, warm);
  out.exposure = lerp3(NIGHT.exposure, DAY.exposure, WARM.exposure, day, warm);
  out.visibility = lerp3(NIGHT.visibility, DAY.visibility, WARM.visibility, day, warm);
  out.shadowIntensity = lerp3(NIGHT.shadowIntensity, DAY.shadowIntensity, WARM.shadowIntensity, day, warm);
  out.shadowSoftness = lerp3(NIGHT.shadowSoftness, DAY.shadowSoftness, WARM.shadowSoftness, day, warm);
  return out;
}

/** Day/night blend, then the warm wash on top. */
function lerp3(night: number, dayV: number, warmV: number, day: number, warm: number): number {
  const base = night + (dayV - night) * day;
  return base + (warmV - base) * warm;
}

/**
 * The colour grade of the post pass for a moment of the day (look/post.ts applies it after tone
 * mapping). Analytic rather than a LUT: a handful of numbers blended by the clock cost nothing and
 * need no texture. GTA IV by day is desaturated and low in contrast with lifted blacks and a
 * yellow-green cast in the mid-tones; at dusk the cast turns warm and brown; at night the image is
 * warmer and keeps its saturation (the sodium light carries it) with a deeper S-curve and more bloom.
 */
export interface GradeLook {
  saturation: number;
  contrast: number;
  /** Raises the blacks: output = lift + colour * (1 - lift). */
  lift: number;
  /** Multiplied in the shadows and in the highlights, with a cast on the mid-tones in between. */
  shadowTint: THREE.Color;
  midTint: THREE.Color;
  highlightTint: THREE.Color;
  vignette: number;
  bloom: number;
  /** Scene brightness above which a pixel blooms. */
  bloomThreshold: number;
}

export function newGradeLook(): GradeLook {
  return { saturation: 1, contrast: 0, lift: 0, shadowTint: new THREE.Color(1, 1, 1), midTint: new THREE.Color(1, 1, 1), highlightTint: new THREE.Color(1, 1, 1), vignette: 0, bloom: 0, bloomThreshold: 1 };
}

interface GradeAnchor { sat: number; contrast: number; lift: number; shadow: [number, number, number]; mid: [number, number, number]; high: [number, number, number]; vignette: number; bloom: number; threshold: number }
const GRADE_DAY: GradeAnchor = { sat: 0.8, contrast: 0.16, lift: 0.03, shadow: [0.98, 1.0, 0.98], mid: [1.02, 1.02, 0.95], high: [1.02, 1.01, 0.96], vignette: 0.24, bloom: 0.3, threshold: 0.85 };
const GRADE_WARM: GradeAnchor = { sat: 0.86, contrast: 0.2, lift: 0.025, shadow: [1.0, 0.95, 0.9], mid: [1.06, 1.0, 0.86], high: [1.1, 1.0, 0.86], vignette: 0.28, bloom: 0.42, threshold: 0.75 };
const GRADE_NIGHT: GradeAnchor = { sat: 0.95, contrast: 0.3, lift: 0.012, shadow: [0.96, 0.99, 1.06], mid: [1.04, 1.0, 0.94], high: [1.08, 1.0, 0.88], vignette: 0.32, bloom: 0.62, threshold: 0.7 };

export function gradeLook(minutes: number, out: GradeLook): GradeLook {
  const day = 1 - nightFactor(minutes);
  const warm = warmth(minutes);
  const f = (a: number, b: number, c: number) => {
    const base = a + (b - a) * day;
    return base + (c - base) * warm;
  };
  const tint = (dst: THREE.Color, key: 'shadow' | 'mid' | 'high') => {
    dst.setRGB(f(GRADE_NIGHT[key][0], GRADE_DAY[key][0], GRADE_WARM[key][0]), f(GRADE_NIGHT[key][1], GRADE_DAY[key][1], GRADE_WARM[key][1]), f(GRADE_NIGHT[key][2], GRADE_DAY[key][2], GRADE_WARM[key][2]));
  };
  out.saturation = f(GRADE_NIGHT.sat, GRADE_DAY.sat, GRADE_WARM.sat);
  out.contrast = f(GRADE_NIGHT.contrast, GRADE_DAY.contrast, GRADE_WARM.contrast);
  out.lift = f(GRADE_NIGHT.lift, GRADE_DAY.lift, GRADE_WARM.lift);
  tint(out.shadowTint, 'shadow');
  tint(out.midTint, 'mid');
  tint(out.highlightTint, 'high');
  out.vignette = f(GRADE_NIGHT.vignette, GRADE_DAY.vignette, GRADE_WARM.vignette);
  out.bloom = f(GRADE_NIGHT.bloom, GRADE_DAY.bloom, GRADE_WARM.bloom);
  out.bloomThreshold = f(GRADE_NIGHT.threshold, GRADE_DAY.threshold, GRADE_WARM.threshold);
  return out;
}

/** Parses "HH:MM" to minutes since midnight, or null. */
export function parseTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The clock options from `?time=HH:MM`, `?day=0-6` and `?timescale=N`. Undefined when none is set, so the defaults stand. */
export function clockFromParams(params: URLSearchParams): { minutes?: number; day?: number; scale?: number } | undefined {
  const clock: { minutes?: number; day?: number; scale?: number } = {};
  const t = params.get('time');
  if (t !== null) {
    const m = parseTime(t);
    if (m !== null) clock.minutes = m;
  }
  const d = params.get('day');
  if (d !== null && /^[0-6]$/.test(d.trim())) clock.day = Number(d);
  const s = params.get('timescale');
  if (s !== null) {
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0 && n <= 600) clock.scale = n;
  }
  return Object.keys(clock).length ? clock : undefined;
}

/** "Wed 14:00" for the HUD. */
export function formatClock(minutes: number, day: number): string {
  const m = Math.floor(((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${DAY_NAMES[((day % 7) + 7) % 7]} ${hh}:${mm}`;
}
