/**
 * The geometry of the full-screen map: a north-up view (a world point at the middle of the screen and a scale in CSS px per metre),
 * panning and zooming about a point, pinch maths, and the zoom steps the keys and the wheel make. Pure: no DOM.
 *
 * Game axes: +X east, +Z south, so north is up and a world z grows down the screen.
 */
import { clamp } from '../../../shared/math';

export interface MapView {
  /** The world point at the middle of the screen. */
  cx: number;
  cz: number;
  /** CSS px per metre. */
  scale: number;
  /** The screen, CSS px. */
  w: number;
  h: number;
}

/** About 25 m a pixel (a whole city), and 4 px a metre (a driveway). */
export const SCALE_MIN = 0.04;
export const SCALE_MAX = 4;
export const SCALE_START = 0.32;

export const clampScale = (s: number): number => clamp(Number.isFinite(s) ? s : SCALE_START, SCALE_MIN, SCALE_MAX);

export function worldToScreen(v: MapView, x: number, z: number, out: { x: number; y: number }): { x: number; y: number } {
  out.x = v.w / 2 + (x - v.cx) * v.scale;
  out.y = v.h / 2 + (z - v.cz) * v.scale;
  return out;
}

export function screenToWorld(v: MapView, sx: number, sy: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = v.cx + (sx - v.w / 2) / v.scale;
  out.z = v.cz + (sy - v.h / 2) / v.scale;
  return out;
}

/** Drags the map by (dx, dy) screen px: the world follows the finger. */
export function panBy(v: MapView, dx: number, dy: number) {
  v.cx -= dx / v.scale;
  v.cz -= dy / v.scale;
}

/** Zooms by `factor` keeping the world point under screen (sx, sy) where it is. */
export function zoomAbout(v: MapView, factor: number, sx: number, sy: number) {
  const before = screenToWorld(v, sx, sy, { x: 0, z: 0 });
  v.scale = clampScale(v.scale * factor);
  v.cx = before.x - (sx - v.w / 2) / v.scale;
  v.cz = before.z - (sy - v.h / 2) / v.scale;
}

/** A pinch from two fingers' old and new positions: the zoom factor, the pan of the midpoint and the midpoint itself. */
export function pinch(
  a0: { x: number; y: number },
  b0: { x: number; y: number },
  a1: { x: number; y: number },
  b1: { x: number; y: number },
): { factor: number; dx: number; dy: number; mx: number; my: number } {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const m0x = (a0.x + b0.x) / 2, m0y = (a0.y + b0.y) / 2;
  const m1x = (a1.x + b1.x) / 2, m1y = (a1.y + b1.y) / 2;
  return { factor: d0 > 4 && d1 > 4 ? d1 / d0 : 1, dx: m1x - m0x, dy: m1y - m0y, mx: m1x, my: m1y };
}

/** The zoom factor for a wheel event: a notch is about 15%, a trackpad's stream of small deltas adds up smoothly; a pinch (ctrl) is stronger. */
export function wheelFactor(deltaY: number, deltaMode: number, ctrl: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const k = ctrl ? 0.01 : 0.0018;
  return Math.exp(-clamp(px, -240, 240) * k);
}

/** The world rectangle the screen shows. */
export function visibleRect(v: MapView, margin = 0): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const hw = v.w / 2 / v.scale + margin;
  const hh = v.h / 2 / v.scale + margin;
  return { minX: v.cx - hw, maxX: v.cx + hw, minZ: v.cz - hh, maxZ: v.cz + hh };
}

/** A view that just holds a rectangle, with a margin in px. */
export function fitRect(v: MapView, r: { minX: number; minZ: number; maxX: number; maxZ: number }, marginPx = 60) {
  v.cx = (r.minX + r.maxX) / 2;
  v.cz = (r.minZ + r.maxZ) / 2;
  const sx = (v.w - marginPx * 2) / Math.max(1, r.maxX - r.minX);
  const sz = (v.h - marginPx * 2) / Math.max(1, r.maxZ - r.minZ);
  v.scale = clampScale(Math.min(sx, sz));
}

/** Keyboard pan speed, px a second, faster with shift. */
export function keyPanSpeed(fast: boolean): number {
  return fast ? 1100 : 520;
}

/** A "nice" length for the scale bar: 10, 20, 50, 100, ... m that is 70 to 160 px wide at this scale. */
export function scaleBar(scale: number): { metres: number; px: number } {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  for (const m of steps) if (m * scale >= 70) return { metres: m, px: m * scale };
  const m = steps[steps.length - 1];
  return { metres: m, px: m * scale };
}

export function formatScaleBar(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

/** What zoom a road class is drawn from (px per metre), so the map thickens as you zoom in. */
export function roadVisibleFrom(rank: number): number {
  return [0.2, 0.12, 0.07, 0.04, 0.04, 0.04][rank] ?? 0.04;
}

/** When a road class's name is written: the avenues first. */
export function labelVisibleFrom(rank: number): number {
  return [0.7, 0.5, 0.3, 0.17, 0.1, 0.1][rank] ?? 0.7;
}
