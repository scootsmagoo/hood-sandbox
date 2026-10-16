/** Which tiles of a streamed city share a side, for stitching their graphs. Pure. */
import type { Rect, SeamSide } from '../../shared/city';

/** The sides on which tile `a` and tile `b` meet (a's, then b's), or null when they do not touch along an edge. */
export function adjacentSides(a: Rect, b: Rect, eps = 0.5): [SeamSide, SeamSide] | null {
  const zOverlap = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > eps;
  const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > eps;
  if (zOverlap && Math.abs(a.maxX - b.minX) < eps) return ['e', 'w'];
  if (zOverlap && Math.abs(a.minX - b.maxX) < eps) return ['w', 'e'];
  if (xOverlap && Math.abs(a.maxZ - b.minZ) < eps) return ['s', 'n'];
  if (xOverlap && Math.abs(a.minZ - b.maxZ) < eps) return ['n', 's'];
  return null;
}

export function inRect(r: Rect, x: number, z: number, margin = 0): boolean {
  return x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin;
}
