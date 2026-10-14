import type { Projector, V2 } from '../geo.js';
import { pointInRing, ringBounds } from '../geo.js';
import type { Dem } from '../sources/dem.js';
import { sampleDem } from '../sources/dem.js';
import { srgbToLinear } from './buildings.js';
import type { Area, AreaKind } from './osm.js';

export interface Heightmap {
  cols: number;
  rows: number;
  cellSize: number;
  minX: number;
  minZ: number;
  /** metres relative to baseElevation, row-major, columns along +X */
  data: Float32Array;
}

export function makeHeightmap(cols: number, rows: number, cellSize: number, minX: number, minZ: number, data?: Float32Array): Heightmap {
  return { cols, rows, cellSize, minX, minZ, data: data ?? new Float32Array(cols * rows) };
}

export function heightmapFromDem(
  dem: Dem | null,
  proj: Projector,
  origin: { lat: number; lon: number },
  cols: number,
  rows: number,
  cellSize: number,
  minX: number,
  minZ: number,
): { hm: Heightmap; baseElevation: number; flat: boolean } {
  const hm = makeHeightmap(cols, rows, cellSize, minX, minZ);
  if (!dem) return { hm, baseElevation: 0, flat: true };
  let base = sampleDem(dem, origin.lon, origin.lat);
  if (!Number.isFinite(base)) base = 300;
  base = Math.round(base * 100) / 100;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [lon, lat] = proj.toLonLat(minX + c * cellSize, minZ + r * cellSize);
      const e = sampleDem(dem, lon, lat);
      hm.data[r * cols + c] = Number.isFinite(e) ? e - base : 0;
    }
  }
  return { hm, baseElevation: base, flat: false };
}

/** Height of the ground triangle mesh (the same triangulation as the ground mesh at step 1). */
export function surfaceHeight(hm: Heightmap, x: number, z: number): number {
  const fx = (x - hm.minX) / hm.cellSize;
  const fz = (z - hm.minZ) / hm.cellSize;
  const c = Math.max(0, Math.min(hm.cols - 2, Math.floor(fx)));
  const r = Math.max(0, Math.min(hm.rows - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - c));
  const v = Math.max(0, Math.min(1, fz - r));
  const h = (cc: number, rr: number) => hm.data[rr * hm.cols + cc];
  const hA = h(c, r); // north-west
  const hB = h(c, r + 1); // south-west
  const hC = h(c + 1, r); // north-east
  const hD = h(c + 1, r + 1);
  // diagonal runs from B to C; triangle ABC where u + v <= 1, else CBD
  if (u + v <= 1) return hA + (hC - hA) * u + (hB - hA) * v;
  return hD + (hB - hD) * (1 - u) + (hC - hD) * (1 - v);
}

export function minMax(hm: Heightmap): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of hm.data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

type RGB = [number, number, number];
const srgb = (r: number, g: number, b: number): RGB => [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];

export const GROUND_COLORS: Record<AreaKind | 'urban', RGB> = {
  urban: srgb(0.50, 0.50, 0.48),
  park: srgb(0.35, 0.52, 0.27),
  forest: srgb(0.24, 0.40, 0.21),
  water: srgb(0.20, 0.40, 0.60),
  residential: srgb(0.48, 0.52, 0.42),
  commercial: srgb(0.54, 0.53, 0.50),
  industrial: srgb(0.48, 0.46, 0.44),
  parking: srgb(0.38, 0.38, 0.38),
  cemetery: srgb(0.40, 0.50, 0.34),
  pitch: srgb(0.38, 0.60, 0.34),
  rail: srgb(0.44, 0.41, 0.39),
  construction: srgb(0.60, 0.54, 0.44),
};

// later entries paint over earlier ones
const PAINT_ORDER: AreaKind[] = ['residential', 'commercial', 'industrial', 'rail', 'construction', 'parking', 'cemetery', 'forest', 'park', 'pitch', 'water'];

/** Land class for each heightmap vertex: 0 = urban, otherwise index+1 into PAINT_ORDER. */
export function rasterizeAreas(areas: Area[], hm: Heightmap): Uint8Array {
  const out = new Uint8Array(hm.cols * hm.rows);
  for (const kind of PAINT_ORDER) {
    const code = PAINT_ORDER.indexOf(kind) + 1;
    for (const a of areas) {
      if (a.kind !== kind) continue;
      const b = ringBounds(a.rings[0]);
      const c0 = Math.max(0, Math.floor((b.minX - hm.minX) / hm.cellSize));
      const c1 = Math.min(hm.cols - 1, Math.ceil((b.maxX - hm.minX) / hm.cellSize));
      const r0 = Math.max(0, Math.floor((b.minZ - hm.minZ) / hm.cellSize));
      const r1 = Math.min(hm.rows - 1, Math.ceil((b.maxZ - hm.minZ) / hm.cellSize));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = hm.minX + c * hm.cellSize;
          const z = hm.minZ + r * hm.cellSize;
          if (!pointInRing(x, z, a.rings[0])) continue;
          let inHole = false;
          for (let h = 1; h < a.rings.length; h++) if (pointInRing(x, z, a.rings[h])) { inHole = true; break; }
          if (!inHole) out[r * hm.cols + c] = code;
        }
      }
    }
  }
  return out;
}

export function landColor(code: number): RGB {
  return code === 0 ? GROUND_COLORS.urban : GROUND_COLORS[PAINT_ORDER[code - 1]];
}

export interface GroundMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface GroundRange {
  /** inclusive heightmap sample range (columns along +X, rows along +Z) */
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

export interface GroundOptions {
  /** Lower the interior (not the border) by this many metres, so a coarse ground never pokes through the roads on it. */
  lower?: number;
  /** Add a skirt of this depth around the border, to hide cracks against a neighbour of another level of detail. */
  skirt?: number;
}

/**
 * The ground over a range of heightmap samples at every `step`th sample. The range is clipped to
 * the heightmap and its size should be a multiple of `step`. Normals come from the whole
 * heightmap, so neighbouring chunks share their edge normals.
 */
export function buildGroundMesh(hm: Heightmap, land: Uint8Array, step = 1, range?: GroundRange, opts: GroundOptions = {}): GroundMesh {
  const c0 = range?.c0 ?? 0;
  const r0 = range?.r0 ?? 0;
  const c1 = Math.min(hm.cols - 1, range?.c1 ?? hm.cols - 1);
  const r1 = Math.min(hm.rows - 1, range?.r1 ?? hm.rows - 1);
  const cs = Math.floor((c1 - c0) / step) + 1;
  const rs = Math.floor((r1 - r0) / step) + 1;
  const skirt = opts.skirt ?? 0;
  const lower = opts.lower ?? 0;
  const loopLen = skirt > 0 ? 2 * (cs + rs) - 4 : 0;
  const nv = cs * rs + loopLen;
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const colors = new Float32Array(nv * 3);
  const h = (c: number, r: number) => hm.data[Math.max(0, Math.min(hm.rows - 1, r)) * hm.cols + Math.max(0, Math.min(hm.cols - 1, c))];
  for (let j = 0; j < rs; j++) {
    for (let i = 0; i < cs; i++) {
      const c = c0 + i * step;
      const r = r0 + j * step;
      const o = (j * cs + i) * 3;
      const border = i === 0 || j === 0 || i === cs - 1 || j === rs - 1;
      positions[o] = hm.minX + c * hm.cellSize;
      positions[o + 1] = h(c, r) - (border ? 0 : lower);
      positions[o + 2] = hm.minZ + r * hm.cellSize;
      const dx = (h(c + step, r) - h(c - step, r)) / (2 * step * hm.cellSize);
      const dz = (h(c, r + step) - h(c, r - step)) / (2 * step * hm.cellSize);
      const l = Math.hypot(dx, 1, dz);
      normals[o] = -dx / l;
      normals[o + 1] = 1 / l;
      normals[o + 2] = -dz / l;
      const col = landColor(land[r * hm.cols + c]);
      colors[o] = col[0];
      colors[o + 1] = col[1];
      colors[o + 2] = col[2];
    }
  }
  const indices = new Uint32Array((cs - 1) * (rs - 1) * 6 + loopLen * 12);
  let k = 0;
  for (let j = 0; j < rs - 1; j++) {
    for (let i = 0; i < cs - 1; i++) {
      const a = j * cs + i; // north-west
      const b = (j + 1) * cs + i; // south-west
      const c = j * cs + i + 1; // north-east
      const d = (j + 1) * cs + i + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = c; indices[k++] = b; indices[k++] = d;
    }
  }
  if (skirt > 0) {
    // The border vertices in a loop, each copied `skirt` metres lower. Both windings, so it shows from either side.
    const loop: number[] = [];
    for (let i = 0; i < cs; i++) loop.push(i);
    for (let j = 1; j < rs; j++) loop.push(j * cs + cs - 1);
    for (let i = cs - 2; i >= 0; i--) loop.push((rs - 1) * cs + i);
    for (let j = rs - 2; j >= 1; j--) loop.push(j * cs);
    const low: number[] = [];
    let v = cs * rs;
    for (const src of loop) {
      for (let q = 0; q < 3; q++) {
        positions[v * 3 + q] = positions[src * 3 + q];
        normals[v * 3 + q] = normals[src * 3 + q];
        colors[v * 3 + q] = colors[src * 3 + q];
      }
      positions[v * 3 + 1] -= skirt;
      low.push(v++);
    }
    for (let n = 0; n < loop.length; n++) {
      const m = (n + 1) % loop.length;
      indices[k++] = loop[n]; indices[k++] = low[n]; indices[k++] = loop[m];
      indices[k++] = loop[m]; indices[k++] = low[n]; indices[k++] = low[m];
      indices[k++] = loop[n]; indices[k++] = loop[m]; indices[k++] = low[n];
      indices[k++] = loop[m]; indices[k++] = low[m]; indices[k++] = low[n];
    }
  }
  return { positions, normals, colors, indices: indices.subarray(0, k) };
}

export type { V2 };
