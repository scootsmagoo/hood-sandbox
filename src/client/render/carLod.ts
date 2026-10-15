/**
 * Which vehicle asset a car draws and at which level of detail. Pure, so it tests without three.js.
 *
 * Levels (tools/blender/README.md): LOD0 about 8k triangles, the full model with a separate door,
 * bonnet and bumpers; LOD1 about 2k; LOD2 about 500. Distances are divided by the tier's
 * `lodScale` (graphics.ts), so the Low tier drops detail sooner.
 */
import manifest from './carAssets.manifest.json';

export const CAR_LOD = {
  /** Up to here (m, at lodScale 1) a car is drawn at LOD0. */
  near: 20,
  /** Up to here at LOD1, beyond it LOD2. */
  far: 55,
  /** A car keeps its level until it is this much (m) past the boundary, so it does not flicker. */
  hysteresis: 2,
} as const;

/** The level of detail for a car `dist` metres from the camera. `current` (if any) is held near its boundaries. */
export function pickLod(dist: number, lodScale: number, current = -1): 0 | 1 | 2 {
  const d = dist / Math.max(0.1, lodScale);
  const h = CAR_LOD.hysteresis;
  const near = CAR_LOD.near + (current === 0 ? h : current > 0 ? -h : 0);
  const far = CAR_LOD.far + (current >= 0 && current <= 1 ? h : current === 2 ? -h : 0);
  if (d < near) return 0;
  if (d < far) return 1;
  return 2;
}

type Entry = { file: string; type: string; police: boolean; hash: string; bytes: number; tris: number[] };
export const CAR_ASSETS = manifest.vehicles as Record<string, Entry>;

/** The asset a vehicle type draws: its police model when it is a police car and one exists, else its own, else the sedan. */
export function assetFor(typeId: string, police: boolean): string {
  if (police && CAR_ASSETS[`${typeId}-police`]) return `${typeId}-police`;
  if (CAR_ASSETS[typeId]) return typeId;
  return 'sedan';
}
