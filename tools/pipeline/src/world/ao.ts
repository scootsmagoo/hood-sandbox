/**
 * Baked ambient occlusion: a sky-view estimate from a raster of the buildings.
 *
 * The buildings are stamped into a height raster (absolute y of the tallest roof over each cell). The occlusion at a point is
 * found by looking along 16 horizontal directions to 120 m and taking the highest roof edge seen in each (its elevation angle);
 * the sky that is left is 1 - mean(sin^2 elevation) over the directions that face away from the surface (a wall only looks out).
 * Close to a wall the term gets darker still. The result is meant to multiply the indirect light, so it lives in the alpha of
 * COLOR_0 (see "Ambient occlusion" in docs/contracts/m1-tile-format.md).
 */
import type { Rect, V2 } from '../geo.js';
import { ringBounds } from '../geo.js';
import { inPolygon } from './shape.js';

const NONE = -1e9;
const DIRS = 16;
const MAX_D = 120;
const COS = Array.from({ length: DIRS }, (_, k) => Math.cos(((k + 0.5) * 2 * Math.PI) / DIRS));
const SIN = Array.from({ length: DIRS }, (_, k) => Math.sin(((k + 0.5) * 2 * Math.PI) / DIRS));

export class OcclusionField {
  readonly cols: number;
  readonly rows: number;
  /** absolute y of the highest roof over each cell, NONE where there is no building */
  readonly top: Float32Array;
  /** absolute y of the underside of a deck over each cell, NONE where there is none */
  readonly deck: Float32Array;

  constructor(readonly bounds: Rect, readonly cell = 1.5) {
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1;
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1;
    this.top = new Float32Array(this.cols * this.rows).fill(NONE);
    this.deck = new Float32Array(this.cols * this.rows).fill(NONE);
  }

  private idx(x: number, z: number): number {
    const c = Math.round((x - this.bounds.minX) / this.cell);
    const r = Math.round((z - this.bounds.minZ) / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  /** Stamps a footprint (outer ring first, then courtyards) whose roof is at absolute height `topY`. */
  addBuilding(rings: V2[][], topY: number): void {
    const b = ringBounds(rings[0]);
    const c0 = Math.max(0, Math.floor((b.minX - this.bounds.minX) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.ceil((b.maxX - this.bounds.minX) / this.cell));
    const r0 = Math.max(0, Math.floor((b.minZ - this.bounds.minZ) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.ceil((b.maxZ - this.bounds.minZ) / this.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = this.bounds.minX + c * this.cell;
        const z = this.bounds.minZ + r * this.cell;
        if (!inPolygon(x, z, rings)) continue;
        const i = r * this.cols + c;
        if (topY > this.top[i]) this.top[i] = topY;
      }
    }
  }

  /** Marks the ground under a stretch of deck (a strip `halfWidth` m either side of a segment) whose underside is at `bottomY`. */
  addDeck(a: V2, b: V2, halfWidth: number, bottomY: number): void {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const minX = Math.min(a[0], b[0]) - halfWidth, maxX = Math.max(a[0], b[0]) + halfWidth;
    const minZ = Math.min(a[1], b[1]) - halfWidth, maxZ = Math.max(a[1], b[1]) + halfWidth;
    const c0 = Math.max(0, Math.floor((minX - this.bounds.minX) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.ceil((maxX - this.bounds.minX) / this.cell));
    const r0 = Math.max(0, Math.floor((minZ - this.bounds.minZ) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.ceil((maxZ - this.bounds.minZ) / this.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = this.bounds.minX + c * this.cell;
        const z = this.bounds.minZ + r * this.cell;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
        if (Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz)) > halfWidth) continue;
        const i = r * this.cols + c;
        if (this.deck[i] === NONE || bottomY < this.deck[i]) this.deck[i] = bottomY;
      }
    }
  }

  /** Fraction of the sky seen from (x, y, z), 0..1, and the distance to the nearest roof edge that rises above the point. `n` is the outward normal of a wall, in plan. */
  sky(x: number, y: number, z: number, n?: V2): { visible: number; nearest: number } {
    let acc = 0;
    let count = 0;
    let nearest = Infinity;
    for (let k = 0; k < DIRS; k++) {
      const dx = COS[k], dz = SIN[k];
      if (n && dx * n[0] + dz * n[1] < -0.2) continue;
      count++;
      let maxTan = 0;
      let d = 1;
      while (d < MAX_D) {
        const i = this.idx(x + dx * d, z + dz * d);
        if (i < 0) break;
        const t = this.top[i];
        if (t > y + 0.3) {
          const tan = (t - y) / d;
          if (tan > maxTan) maxTan = tan;
          if (d < nearest) nearest = d;
          if (maxTan > 6) break;
        }
        d += Math.max(this.cell, d * 0.18);
      }
      acc += (maxTan * maxTan) / (1 + maxTan * maxTan);
    }
    return { visible: count ? 1 - acc / count : 1, nearest };
  }

  /** The ambient occlusion factor at a point (about 0.2 to 1). */
  ao(x: number, y: number, z: number, n?: V2): number {
    let px = x, pz = z;
    if (n) { px += n[0] * 0.4; pz += n[1] * 0.4; }
    const s = this.sky(px, y, pz, n);
    let ao = 0.18 + 0.82 * Math.pow(s.visible, 1.6);
    if (s.nearest < 12) ao *= 1 - 0.3 * Math.exp(-s.nearest / 2.2);
    const i = this.idx(x, z);
    if (i >= 0 && this.deck[i] > NONE && this.deck[i] > y + 1.2) ao *= 0.5;
    return Math.max(0.15, Math.min(1, ao));
  }
}
