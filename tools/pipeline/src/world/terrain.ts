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
  plaza: srgb(0.58, 0.57, 0.54),
};

// later entries paint over earlier ones
const PAINT_ORDER: AreaKind[] = ['residential', 'commercial', 'industrial', 'rail', 'construction', 'parking', 'plaza', 'cemetery', 'forest', 'park', 'pitch', 'water'];

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

/** Ground class ids (`_LAND.x`); `landClasses` in tile.json lists the names in this order. */
/** The land raster's code of an area kind (what `rasterizeAreas` writes for it). */
export const landCode = (kind: AreaKind): number => PAINT_ORDER.indexOf(kind) + 1;

export const LAND_CLASSES = ['urban', 'grass', 'woodland', 'dirt', 'plaza', 'parking', 'industrial', 'rail', 'water', 'pitch', 'cemetery', 'residential', 'commercial'] as const;

const LAND_ID: Record<AreaKind, number> = {
  park: 1, forest: 2, construction: 3, plaza: 4, parking: 5, industrial: 6, rail: 7, water: 8, pitch: 9, cemetery: 10, residential: 11, commercial: 12,
};

/** Blend weights (grass, dirt, plaza), each 0 to 1, of a ground class. */
const LAND_WEIGHTS: [number, number, number][] = [
  [0, 0, 0], // urban
  [1, 0, 0], // grass
  [1, 0, 0], // woodland
  [0, 1, 0], // dirt
  [0, 0, 1], // plaza
  [0, 0, 0], // parking
  [0, 0.6, 0], // industrial yard
  [0, 0.8, 0], // rail ballast
  [0, 0, 0], // water
  [0.8, 0, 0], // pitch
  [1, 0, 0], // cemetery
  [0.5, 0, 0], // residential yard
  [0, 0, 0.3], // commercial hardscape
];

/** The ground class id of a rasterized land code (0 = urban, otherwise index + 1 into PAINT_ORDER). */
export function landClassOf(code: number): number {
  return code === 0 ? 0 : LAND_ID[PAINT_ORDER[code - 1]];
}

/** `_LAND` for the sample (c, r): class id and the blend weights of a 3x3 smoothing (neighbours `step` samples away). */
export function landAttr(hm: Heightmap, land: Uint8Array, c: number, r: number, step: number, out: Uint8Array, o: number): void {
  const at = (cc: number, rr: number) => landClassOf(land[Math.max(0, Math.min(hm.rows - 1, rr)) * hm.cols + Math.max(0, Math.min(hm.cols - 1, cc))]);
  let g = 0, d = 0, p = 0, wsum = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const w = (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
      const k = at(c + di * step, r + dj * step);
      g += LAND_WEIGHTS[k][0] * w;
      d += LAND_WEIGHTS[k][1] * w;
      p += LAND_WEIGHTS[k][2] * w;
      wsum += w;
    }
  }
  out[o] = at(c, r);
  out[o + 1] = Math.round((g / wsum) * 255);
  out[o + 2] = Math.round((d / wsum) * 255);
  out[o + 3] = Math.round((p / wsum) * 255);
}

export interface GroundMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** `_LAND` per vertex: class id and the lawn, dirt and plaza weights, 0 to 255 */
  land: Uint8Array;
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
  const landA = new Uint8Array(nv * 4);
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
      landAttr(hm, land, c, r, step, landA, (j * cs + i) * 4);
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
      for (let q = 0; q < 4; q++) landA[v * 4 + q] = landA[src * 4 + q];
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
  return { positions, normals, colors, indices: indices.subarray(0, k), land: landA };
}

export type { V2 };

export interface CarveSegment {
  a: V2;
  b: V2;
  /** design (road surface) height at a and b */
  ha: number;
  hb: number;
  halfWidth: number;
}

export interface CarveOptions {
  /** Vertices within halfWidth + this are set to the road height. A 4 m grid needs about 2.5 m for a car to drive on the road height across the whole lane. */
  pin: number;
  /** Beyond the pinned band the ground blends back to the original over this distance. */
  blend: number;
}

export const DEFAULT_CARVE: CarveOptions = { pin: 3, blend: 9 };

/**
 * Cuts and fills the ground to the road surface: heightmap vertices near a segment take the segment's
 * height at the nearest point, with a smooth blend into the original ground at the edge. Where several
 * roads reach a vertex their heights are averaged, each weighted by how close the vertex is to the road's
 * centreline relative to the road's own width (so a side street next to a boulevard keeps its own
 * profile on its own lanes). Returns the largest cut and fill in metres.
 *
 * (Weighting by the distance from each road's paved edge instead, and junction planes fitted to the legs, were tried with the
 * ground audit and the grade check, and did worse on both: see docs/ground-audit.md.)
 */
/** Of a carriageway's half width, the part (from its centreline) inside which the carving weighs a road as at its centre. */
const INNER = 0.75;

export function carveTerrain(hm: Heightmap, segs: CarveSegment[], user: Partial<CarveOptions> = {}): { cut: number; fill: number; vertices: number } {
  const o = { ...DEFAULT_CARVE, ...user };
  const orig = Float32Array.from(hm.data);
  const sumW = new Float32Array(hm.data.length);
  const sumWH = new Float32Array(hm.data.length);
  const fade = new Float32Array(hm.data.length);
  for (const s of segs) {
    const pinR = s.halfWidth + o.pin;
    const reach = pinR + o.blend;
    const minX = Math.min(s.a[0], s.b[0]) - reach, maxX = Math.max(s.a[0], s.b[0]) + reach;
    const minZ = Math.min(s.a[1], s.b[1]) - reach, maxZ = Math.max(s.a[1], s.b[1]) + reach;
    const c0 = Math.max(0, Math.ceil((minX - hm.minX) / hm.cellSize)), c1 = Math.min(hm.cols - 1, Math.floor((maxX - hm.minX) / hm.cellSize));
    const r0 = Math.max(0, Math.ceil((minZ - hm.minZ) / hm.cellSize)), r1 = Math.min(hm.rows - 1, Math.floor((maxZ - hm.minZ) / hm.cellSize));
    const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
    const l2 = dx * dx + dz * dz;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = hm.minX + c * hm.cellSize, z = hm.minZ + r * hm.cellSize;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2));
        const d = Math.hypot(x - (s.a[0] + t * dx), z - (s.a[1] + t * dz));
        const score = d - pinR;
        if (score >= o.blend) continue;
        const i = r * hm.cols + c;
        // (the distance counts from three quarters of the way to the kerb: a vertex well inside one carriageway follows it, not a
        // narrower road whose centreline is nearer, as a wide motorway's outer lane did a ramp beside it, 1.5 m off)
        const rel = Math.max(0, d - INNER * s.halfWidth) / (pinR - INNER * s.halfWidth) + 0.15;
        const w = 1 / (rel * rel * rel);
        sumW[i] += w;
        sumWH[i] += w * (s.ha + (s.hb - s.ha) * t);
        const u = score <= 0 ? 1 : 1 - score / o.blend;
        const f = u * u * (3 - 2 * u);
        if (f > fade[i]) fade[i] = f;
      }
    }
  }
  let cut = 0, fill = 0, vertices = 0;
  for (let i = 0; i < hm.data.length; i++) {
    if (sumW[i] === 0) continue;
    const v = orig[i] + (sumWH[i] / sumW[i] - orig[i]) * fade[i];
    hm.data[i] = v;
    vertices++;
    cut = Math.max(cut, orig[i] - v);
    fill = Math.max(fill, v - orig[i]);
  }
  return { cut, fill, vertices };
}

export interface SmoothOptions {
  /** Vertices within halfWidth + this of a road are smoothed. */
  reach: number;
  /** Rounds of the smoothing; each moves a vertex `rate` of the way to the mean of its eight neighbours. */
  rounds: number;
  rate: number;
  /** The most a vertex may move, m. */
  maxChange: number;
}

const NB8: [(c: number) => number, number][] = [
  [() => -1, 1], [() => 1, 1], [(c) => -c, 1], [(c) => c, 1],
  [(c) => -c - 1, 0.5], [(c) => -c + 1, 0.5], [(c) => c - 1, 0.5], [(c) => c + 1, 0.5],
];

// (a larger cap, 0.25 to 0.4 m, took fewer launches out but made the ground beside some roads steeper than the grade check allows)
export const DEFAULT_SMOOTH: SmoothOptions = { reach: 3, rounds: 16, rate: 0.5, maxChange: 0.1 };

/**
 * Smooths the ground under and beside the roads (a few rounds of a Laplacian over the vertices within `reach` of a road's paved
 * edge): where two roads cross at different grades, or a road meets the ground's own slope, the carved surface has creases
 * across the 4 m cells that throw a car at speed (a crest of 2% over one cell launches it from 35 m/s). Vertices for which
 * `frozen(x, z)` holds keep their height (the ends of decks, which must meet the ground exactly). Returns the largest change, m.
 */
export function smoothCorridor(hm: Heightmap, segs: CarveSegment[], frozen: (x: number, z: number) => boolean, user: Partial<SmoothOptions> = {}): { vertices: number; maxChange: number } {
  const o = { ...DEFAULT_SMOOTH, ...user };
  const n = hm.data.length;
  const mask = new Uint8Array(n);
  for (const s of segs) {
    const reach = s.halfWidth + o.reach;
    const minX = Math.min(s.a[0], s.b[0]) - reach, maxX = Math.max(s.a[0], s.b[0]) + reach;
    const minZ = Math.min(s.a[1], s.b[1]) - reach, maxZ = Math.max(s.a[1], s.b[1]) + reach;
    const c0 = Math.max(1, Math.ceil((minX - hm.minX) / hm.cellSize)), c1 = Math.min(hm.cols - 2, Math.floor((maxX - hm.minX) / hm.cellSize));
    const r0 = Math.max(1, Math.ceil((minZ - hm.minZ) / hm.cellSize)), r1 = Math.min(hm.rows - 2, Math.floor((maxZ - hm.minZ) / hm.cellSize));
    const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
    const l2 = dx * dx + dz * dz;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = hm.minX + c * hm.cellSize, z = hm.minZ + r * hm.cellSize;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2));
        if (Math.hypot(x - (s.a[0] + t * dx), z - (s.a[1] + t * dz)) <= reach) mask[r * hm.cols + c] = 1;
      }
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const c = i % hm.cols, r = Math.floor(i / hm.cols);
    if (frozen(hm.minX + c * hm.cellSize, hm.minZ + r * hm.cellSize)) continue;
    idx.push(i);
  }
  const orig = Float32Array.from(hm.data);
  const next = new Float32Array(idx.length);
  const C = hm.cols;
  for (let round = 0; round < o.rounds; round++) {
    const h = hm.data;
    idx.forEach((i, k) => {
      // the mean of the eight neighbours (the diagonals at half weight) that are in the corridor too: the terrain beside the road
      // (a cut's bank, a fill's slope) does not pull the road's edge towards it
      let sw = 0, sh = 0;
      for (const [o2, w] of NB8) {
        const j = i + o2(C);
        if (!mask[j]) continue;
        sw += w;
        sh += w * h[j];
      }
      next[k] = sw > 0 ? h[i] + (sh / sw - h[i]) * o.rate : h[i];
    });
    idx.forEach((i, k) => (h[i] = next[k]));
  }
  // a crease is smoothed, a bank between two roads at different heights is not: the change is capped
  let maxChange = 0;
  for (const i of idx) {
    const d = Math.max(-o.maxChange, Math.min(o.maxChange, hm.data[i] - orig[i]));
    hm.data[i] = orig[i] + d;
    maxChange = Math.max(maxChange, Math.abs(d));
  }
  return { vertices: idx.length, maxChange };
}

export interface UnderDeckSegment {
  a: V2;
  b: V2;
  /** height of the deck's top surface at a and b */
  ya: number;
  yb: number;
  halfWidth: number;
  /** a or b is the end of the deck (where it lands): the ground within `abutment` m of it along the deck is left alone */
  endA?: boolean;
  endB?: boolean;
}

/**
 * Lowers the ground where it would stand higher than a deck's surface (the bank at a bridge end, a hill a
 * deck is threaded under): such ground within the deck's width and `margin` ends up `depth` below the
 * surface (under the slab), blending out to the original over `blend` metres. Ground at or below the
 * deck, ground that meets the deck at its ends, and ground `keep` says is another road's carriageway (a junction beside where a
 * deck starts: dug down, its pavement was a trough) is left alone. Returns the deepest cut.
 */
export function lowerTerrainUnder(hm: Heightmap, segs: UnderDeckSegment[], depth = 1.3, margin = 2.5, blend = 6, tolerance = 0.15, keep?: (x: number, z: number) => boolean, abutment = 4.5): { cut: number; vertices: number } {
  const orig = Float32Array.from(hm.data);
  const bestLimit = new Float32Array(hm.data.length).fill(Infinity);
  for (const s of segs) {
    const pinR = s.halfWidth + margin;
    const reach = pinR + blend;
    const minX = Math.min(s.a[0], s.b[0]) - reach, maxX = Math.max(s.a[0], s.b[0]) + reach;
    const minZ = Math.min(s.a[1], s.b[1]) - reach, maxZ = Math.max(s.a[1], s.b[1]) + reach;
    const c0 = Math.max(0, Math.ceil((minX - hm.minX) / hm.cellSize)), c1 = Math.min(hm.cols - 1, Math.floor((maxX - hm.minX) / hm.cellSize));
    const r0 = Math.max(0, Math.ceil((minZ - hm.minZ) / hm.cellSize)), r1 = Math.min(hm.rows - 1, Math.floor((maxZ - hm.minZ) / hm.cellSize));
    const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
    const l2 = dx * dx + dz * dz;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = hm.minX + c * hm.cellSize, z = hm.minZ + r * hm.cellSize;
        const tr = l2 === 0 ? 0 : ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2;
        if (tr < 0 || tr > 1) continue; // beside or past an end of the deck is the ground road's business
        // so is the ground the end of the deck sits on: dug out there, the heightmap's cells at the end dipped down into the pit
        // (the deck lands on the ground it reads at its end, which then pulled it into the pit too)
        const len = Math.sqrt(l2);
        if ((s.endA && tr * len < abutment) || (s.endB && (1 - tr) * len < abutment)) continue;
        const t = tr;
        const d = Math.hypot(x - (s.a[0] + t * dx), z - (s.a[1] + t * dz));
        const score = d - pinR;
        if (score >= blend) continue;
        const i = r * hm.cols + c;
        const top = s.ya + (s.yb - s.ya) * t;
        if (orig[i] <= top + tolerance) continue;
        if (keep?.(x, z)) continue;
        const u = score <= 0 ? 1 : 1 - score / blend;
        const w = u * u * (3 - 2 * u);
        const limit = orig[i] + (top - depth - orig[i]) * w;
        if (limit < bestLimit[i]) bestLimit[i] = limit;
      }
    }
  }
  let cut = 0, vertices = 0;
  for (let i = 0; i < hm.data.length; i++) {
    if (bestLimit[i] < hm.data[i]) {
      cut = Math.max(cut, hm.data[i] - bestLimit[i]);
      hm.data[i] = bestLimit[i];
      vertices++;
    }
  }
  return { cut, vertices };
}
