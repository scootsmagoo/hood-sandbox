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
}

function palette(p: { horizon: number; zenith: number; sun: number; sunIntensity: number; hemiSky: number; hemiGround: number; hemiIntensity: number; ambient: number; exposure: number }): Palette {
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
  };
}

/** Full daylight: the look the game had before the clock. */
const DAY = palette({ horizon: 0xc9d8e2, zenith: 0x4a82c4, sun: 0xfff0d8, sunIntensity: 2.2, hemiSky: 0xd6e4ff, hemiGround: 0x8a8574, hemiIntensity: 2.3, ambient: 0.12, exposure: 1.05 });
/** Night: a dark blue sky, the moon as a dim key light, and enough hemisphere and ambient light to play by. */
const NIGHT = palette({ horizon: 0x1b2a4a, zenith: 0x070d20, sun: 0x9db4ff, sunIntensity: 0.75, hemiSky: 0x4a6a9e, hemiGround: 0x23262f, hemiIntensity: 1.5, ambient: 0.45, exposure: 1.3 });
/** Dusk and dawn: oranges low down, a deep blue overhead. */
const WARM = palette({ horizon: 0xf08a50, zenith: 0x3f5f96, sun: 0xffa060, sunIntensity: 1.9, hemiSky: 0xffc08c, hemiGround: 0x6e4e3a, hemiIntensity: 1.7, ambient: 0.12, exposure: 1.1 });

/** Writes the look for a moment of the day into `out`. Allocates nothing. */
export function skyLook(minutes: number, out: SkyLook): SkyLook {
  const day = 1 - nightFactor(minutes);
  const warm = warmth(minutes);
  const mixColor = (a: THREE.Color, b: THREE.Color, c: THREE.Color, dst: THREE.Color) => {
    dst.lerpColors(a, b, day).lerp(c, warm);
  };
  mixColor(NIGHT.horizon, DAY.horizon, WARM.horizon, out.horizon);
  mixColor(NIGHT.zenith, DAY.zenith, WARM.zenith, out.zenith);
  out.fog.copy(out.horizon);
  mixColor(NIGHT.sun, DAY.sun, WARM.sun, out.sun);
  mixColor(NIGHT.hemiSky, DAY.hemiSky, WARM.hemiSky, out.hemiSky);
  mixColor(NIGHT.hemiGround, DAY.hemiGround, WARM.hemiGround, out.hemiGround);
  out.sunIntensity = lerp3(NIGHT.sunIntensity, DAY.sunIntensity, WARM.sunIntensity, day, warm);
  out.hemiIntensity = lerp3(NIGHT.hemiIntensity, DAY.hemiIntensity, WARM.hemiIntensity, day, warm);
  out.ambient = lerp3(NIGHT.ambient, DAY.ambient, WARM.ambient, day, warm);
  out.exposure = lerp3(NIGHT.exposure, DAY.exposure, WARM.exposure, day, warm);
  return out;
}

/** Day/night blend, then the warm wash on top. */
function lerp3(night: number, dayV: number, warmV: number, day: number, warm: number): number {
  const base = night + (dayV - night) * day;
  return base + (warmV - base) * warm;
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
