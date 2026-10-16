/**
 * The airfield's ground and pavement in a tile bake (world/aeroway.ts is the model):
 *
 * 1. **The ground under it** (`AirfieldField`). A runway, a taxiway or an apron is graded smooth, and the bare-earth DEM is
 *    smooth there too, except where something passes UNDER the pavement (I-285 in its cut under runway 10/28 and its
 *    taxiways): bare earth has no bridge. The airfield surface is the DEM's morphological closing (a dilation then an
 *    erosion over `CLOSE_R` m: dips narrower than about twice that are bridged, broad terrain is kept), blurred. Inside the
 *    pavement (and `MASK_GROW` m round it) the heightmap is set to it, blending back to the terrain over `BLEND` m; where it
 *    stands more than `DECK_MIN` m over the DEM the heightmap keeps the DEM (the cut stays open) and the pavement there is a
 *    deck: a slab with an underside, skirts and collision.
 * 2. **The pavement** (`buildAirfieldMeshes`): runways (concrete, rubber in the touchdown zones), taxiways and taxilanes (a
 *    ribbon of their width with round joins, which makes the fillets), aprons, and the runways' asphalt shoulders, as one
 *    non-overlapping set of polygons per tile (each class cut by the ones above it, so nothing is coplanar with anything:
 *    no depth fighting at any distance), clipped exactly to the tile, triangulated, subdivided and draped on the ground.
 * 3. **The paint** (`buildAirfieldMarkings`): runway threshold bars, designators, centreline dashes, aiming points, touchdown
 *    zone bars and side stripes; taxiway centrelines (stopping at the runway edge), runway holding position markings (two solid
 *    and two dashed lines; ILS holds as a ladder), the stands' lead-in lines and stop bars, stopway chevrons. White and yellow
 *    vertex colours, one material, clipped to the tile.
 */
import earcut from 'earcut';
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import type { Rect, V2 } from '../geo.js';
import { simplifyLine } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import type { Airport, AeroLine, AeroRunway } from './aeroway.js';
import { RUNWAY_SHOULDER } from './aeroway.js';
import { srgbToLinear } from './buildings.js';
import type { Heightmap } from './terrain.js';

/** Closing radius of the DEM over the airfield, m. */
export const CLOSE_R = 48;
/** The blur after the closing (box radius, m; two passes). */
const BLUR_R = 12;
/** The pavement's mask grows this far, m. */
const MASK_GROW = 6;
/** Outside the mask the ground blends back to the terrain over this distance, m. */
const BLEND = 24;
/** Where the airfield surface stands this far over the DEM, the pavement is a deck over a cut, m. */
export const DECK_MIN = 2.5;
/** How far the pavement is drawn over the ground, m (as the roads: the sim drives on the heightmap). */
export const PAVE_LIFT = 0.06;
/** The paint over the pavement, m. */
export const PAINT_LIFT = 0.035;
const DECK_THICK = 1.6;

const lin = (v: number) => srgbToLinear(v);
const rgb = (r: number, g: number, b: number): [number, number, number] => [lin(r), lin(g), lin(b)];
export const COLORS = {
  runway: rgb(0.6, 0.6, 0.58),
  taxiway: rgb(0.56, 0.56, 0.54),
  apron: rgb(0.64, 0.635, 0.61),
  shoulder: rgb(0.27, 0.27, 0.27),
  rubber: rgb(0.17, 0.17, 0.17),
  white: rgb(0.9, 0.9, 0.88),
  yellow: rgb(0.93, 0.74, 0.12),
};

// ---------------------------------------------------------------------------------------------- the ground
export class AirfieldField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  /** the airfield surface (relative heights, as the heightmap's) */
  readonly S: Float32Array;
  /** the DEM before any change */
  readonly dem0: Float32Array;
  /** 1 inside the pavement mask */
  readonly M: Uint8Array;
  stats = { maskCells: 0, deckCells: 0, levelled: 0, maxCut: 0, maxFill: 0 };

  constructor(hm: Heightmap, ap: Airport) {
    this.cols = hm.cols;
    this.rows = hm.rows;
    this.cell = hm.cellSize;
    this.minX = hm.minX;
    this.minZ = hm.minZ;
    this.dem0 = Float32Array.from(hm.data);
    this.M = new Uint8Array(hm.cols * hm.rows);
    for (const poly of pavementPieces(ap)) this.paint(poly);
    this.grow(Math.round(MASK_GROW / this.cell));
    const r = Math.max(1, Math.round(CLOSE_R / this.cell));
    const closed = filter(filter(this.dem0, this.cols, this.rows, r, Math.max), this.cols, this.rows, r, Math.min);
    const b = Math.max(1, Math.round(BLUR_R / this.cell));
    this.S = boxBlur(boxBlur(closed, this.cols, this.rows, b), this.cols, this.rows, b);
  }

  private paint(ring: V2[]) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of ring) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    const c0 = Math.max(0, Math.floor((x0 - this.minX) / this.cell)), c1 = Math.min(this.cols - 1, Math.ceil((x1 - this.minX) / this.cell));
    const r0 = Math.max(0, Math.floor((z0 - this.minZ) / this.cell)), r1 = Math.min(this.rows - 1, Math.ceil((z1 - this.minZ) / this.cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (this.M[r * this.cols + c]) continue;
      if (inRing(this.minX + c * this.cell, this.minZ + r * this.cell, ring)) this.M[r * this.cols + c] = 1;
    }
  }

  private grow(n: number) {
    for (let k = 0; k < n; k++) {
      const src = Uint8Array.from(this.M);
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (src[r * this.cols + c]) continue;
        if ((c > 0 && src[r * this.cols + c - 1]) || (c + 1 < this.cols && src[r * this.cols + c + 1]) || (r > 0 && src[(r - 1) * this.cols + c]) || (r + 1 < this.rows && src[(r + 1) * this.cols + c])) this.M[r * this.cols + c] = 1;
      }
    }
  }

  private bil(a: Float32Array, x: number, z: number): number {
    const fx = Math.max(0, Math.min(this.cols - 1.0001, (x - this.minX) / this.cell));
    const fz = Math.max(0, Math.min(this.rows - 1.0001, (z - this.minZ) / this.cell));
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r;
    const i = r * this.cols + c;
    return a[i] * (1 - u) * (1 - v) + a[i + 1] * u * (1 - v) + a[i + this.cols] * (1 - u) * v + a[i + this.cols + 1] * u * v;
  }

  /** The airfield surface at (x, z). */
  surface(x: number, z: number): number {
    return this.bil(this.S, x, z);
  }

  /** Is the pavement at (x, z) a deck over a cut? */
  deck(x: number, z: number): boolean {
    return this.bil(this.S, x, z) - this.bil(this.dem0, x, z) > DECK_MIN;
  }

  /** Levels the heightmap (the same grid as the one the field was made on) to the airfield surface. */
  apply(hm: Heightmap) {
    const { cols, rows } = this;
    const n = cols * rows;
    // distance (in cells, chamfer 3-4 / 3) from the mask, out to the blend
    const far = Math.ceil(BLEND / this.cell) + 1;
    const d = new Float32Array(n).fill(far);
    for (let i = 0; i < n; i++) if (this.M[i]) d[i] = 0;
    const relax = (i: number, j: number, w: number) => { if (d[j] + w < d[i]) d[i] = d[j] + w; };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) relax(i, i - 1, 1);
      if (r > 0) { relax(i, i - cols, 1); if (c > 0) relax(i, i - cols - 1, 1.414); if (c + 1 < cols) relax(i, i - cols + 1, 1.414); }
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c + 1 < cols) relax(i, i + 1, 1);
      if (r + 1 < rows) { relax(i, i + cols, 1); if (c + 1 < cols) relax(i, i + cols + 1, 1.414); if (c > 0) relax(i, i + cols - 1, 1.414); }
    }
    const bl = BLEND / this.cell;
    for (let i = 0; i < n; i++) {
      if (d[i] >= bl) continue;
      const s = this.S[i], g = this.dem0[i];
      if (this.M[i]) this.stats.maskCells++;
      if (s - g > DECK_MIN) {
        if (this.M[i]) this.stats.deckCells++;
        continue;
      }
      const t = this.M[i] ? 0 : d[i] / bl;
      const w = t * t * (3 - 2 * t);
      const v = s + (g - s) * w;
      this.stats.maxFill = Math.max(this.stats.maxFill, v - hm.data[i]);
      this.stats.maxCut = Math.max(this.stats.maxCut, hm.data[i] - v);
      hm.data[i] = v;
      this.stats.levelled++;
    }
  }
}

/** A separable max or min filter over a square of radius r (cells). */
function filter(a: Float32Array, cols: number, rows: number, r: number, f: (x: number, y: number) => number): Float32Array {
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let v = a[y * cols + x];
    for (let k = Math.max(0, x - r); k <= Math.min(cols - 1, x + r); k++) v = f(v, a[y * cols + k]);
    tmp[y * cols + x] = v;
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let v = tmp[y * cols + x];
    for (let k = Math.max(0, y - r); k <= Math.min(rows - 1, y + r); k++) v = f(v, tmp[k * cols + x]);
    out[y * cols + x] = v;
  }
  return out;
}

function boxBlur(a: Float32Array, cols: number, rows: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(cols - 1, x + r); k++) { s += a[y * cols + k]; n++; }
    tmp[y * cols + x] = s / n;
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(rows - 1, y + r); k++) { s += tmp[k * cols + x]; n++; }
    out[y * cols + x] = s / n;
  }
  return out;
}

export function inRing(x: number, z: number, r: V2[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}

// ---------------------------------------------------------------------------------------------- the pavement's outlines
/** A rectangle from a to b, `hw` either side (counter-clockwise in x, z is not assumed). */
export function segRect(a: V2, b: V2, hw: number, extend = 0): V2[] {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  const nx = -uz * hw, nz = ux * hw;
  const ax = a[0] - ux * extend, az = a[1] - uz * extend, bx = b[0] + ux * extend, bz = b[1] + uz * extend;
  return [[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]];
}

export function disc(c: V2, r: number, n = 14): V2[] {
  const out: V2[] = [];
  for (let k = 0; k < n; k++) out.push([c[0] + r * Math.cos((2 * Math.PI * k) / n), c[1] + r * Math.sin((2 * Math.PI * k) / n)]);
  return out;
}

/** The convex pieces of a taxiway's ribbon: a rectangle per segment and a disc at every joint. */
export function linePieces(l: Pick<AeroLine, 'pts' | 'width'>, simplify = 0.5): V2[][] {
  const pts = simplifyLine(l.pts, simplify);
  const hw = l.width / 2;
  const out: V2[][] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push(segRect(pts[i], pts[i + 1], hw));
  for (let i = 1; i + 1 < pts.length; i++) out.push(disc(pts[i], hw));
  return out;
}

export function runwayRect(rw: AeroRunway, hw: number): V2[] {
  return segRect(rw.ends[0].end, rw.ends[1].end, hw);
}

/** Every pavement outline of the airport (for the ground mask): runways with their shoulders, taxiway pieces, aprons. */
export function pavementPieces(ap: Airport): V2[][] {
  const out: V2[][] = [];
  for (const rw of ap.runways) out.push(runwayRect(rw, rw.width / 2 + RUNWAY_SHOULDER));
  for (const l of ap.lines) if (l.kind === 'taxiway' || l.kind === 'taxilane' || l.kind === 'stopway') out.push(...linePieces(l));
  for (const a of ap.areas) out.push(a.rings[0]);
  return out;
}

const bboxOf = (r: V2[]) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of r) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  return { x0, z0, x1, z1 };
};
const touchesRect = (r: V2[], b: Rect, m: number) => {
  const bb = bboxOf(r);
  return bb.x1 >= b.minX - m && bb.x0 <= b.maxX + m && bb.z1 >= b.minZ - m && bb.z0 <= b.maxZ + m;
};
const pcRing = (r: V2[]): [number, number][] => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];
const rectPoly = (b: Rect): Polygon => [[[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ], [b.minX, b.minZ]]];

/** Union of many polygons, robust: in batches, then the batches. */
function unionAll(polys: V2[][]): MultiPolygon {
  if (!polys.length) return [];
  const geoms: Polygon[] = polys.filter((p) => p.length >= 3).map((p) => [pcRing(p)]);
  const batch = (gs: (Polygon | MultiPolygon)[]): MultiPolygon => {
    if (gs.length === 1) return (gs[0].length && typeof gs[0][0][0][0] === 'number' ? [gs[0] as Polygon] : (gs[0] as MultiPolygon));
    try {
      return polygonClipping.union(gs[0] as Polygon, ...(gs.slice(1) as Polygon[]));
    } catch {
      // one bad piece: union them one by one, skipping what fails
      let acc: MultiPolygon = [];
      for (const g of gs) {
        try {
          acc = acc.length ? polygonClipping.union(acc, g as Polygon) : (typeof g[0][0][0] === 'number' ? [g as Polygon] : (g as MultiPolygon));
        } catch {
          /* skipped */
        }
      }
      return acc;
    }
  };
  let level: (Polygon | MultiPolygon)[] = geoms;
  while (level.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < level.length; i += 64) next.push(batch(level.slice(i, i + 64)));
    level = next;
  }
  return level.length ? (typeof level[0][0][0][0] === 'number' ? [level[0] as Polygon] : (level[0] as MultiPolygon)) : [];
}

const safe = (f: () => MultiPolygon): MultiPolygon => {
  try {
    return f();
  } catch {
    return [];
  }
};

export interface AirfieldClasses {
  runway: MultiPolygon;
  taxiway: MultiPolygon;
  apron: MultiPolygon;
  shoulder: MultiPolygon;
}

/** The tile's pavement, by class, each cut by the classes above it and clipped to `b`. */
export function airfieldClasses(ap: Airport, b: Rect): AirfieldClasses {
  const rect = rectPoly(b);
  const M = 40;
  const rw = ap.runways.map((r) => runwayRect(r, r.width / 2)).filter((r) => touchesRect(r, b, M));
  const sh = [
    ...ap.runways.map((r) => runwayRect(r, r.width / 2 + RUNWAY_SHOULDER)),
    ...ap.lines.filter((l) => l.kind === 'stopway').flatMap((l) => linePieces(l)),
  ].filter((r) => touchesRect(r, b, M));
  const tw = ap.lines.filter((l) => l.kind === 'taxiway' || l.kind === 'taxilane').flatMap((l) => linePieces(l)).filter((r) => touchesRect(r, b, M));
  const apr = ap.areas.map((a) => a.rings[0]).filter((r) => touchesRect(r, b, M));
  const R = safe(() => polygonClipping.intersection(unionAll(rw), rect));
  const Tu = safe(() => polygonClipping.intersection(unionAll(tw), rect));
  const T = R.length ? safe(() => polygonClipping.difference(Tu, R)) : Tu;
  const Au = safe(() => polygonClipping.intersection(unionAll(apr), rect));
  const above = safe(() => (R.length || T.length ? polygonClipping.union(R.length ? R : T, T.length ? T : R) : []));
  const A = above.length ? safe(() => polygonClipping.difference(Au, above)) : Au;
  const Su = safe(() => polygonClipping.intersection(unionAll(sh), rect));
  const above2 = A.length ? safe(() => (above.length ? polygonClipping.union(above, A) : A)) : above;
  const S = above2.length ? safe(() => polygonClipping.difference(Su, above2)) : Su;
  return { runway: R, taxiway: T, apron: A, shoulder: S };
}

// ---------------------------------------------------------------------------------------------- meshes
export interface Drape {
  /** the surface height the pavement stands on (without its lift) */
  top(x: number, z: number): number;
  /** a deck over a cut there? */
  deck(x: number, z: number): boolean;
}

/** Emits a triangle (x, z) with heights from `drape`, wound to face up, into `mb`. */
function upTri(mb: MeshBuilder, a: V2, b: V2, c: V2, ya: number, yb: number, yc: number, col: (p: V2) => [number, number, number], down = false) {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area) < 1e-6) return;
  // a negative signed area in (x, z) faces +Y (`down`: the other way, for an underside)
  const [p, q, r, yp, yq, yr] = area < 0 !== down ? [a, b, c, ya, yb, yc] : [a, c, b, ya, yc, yb];
  const ny = down ? -1 : 1;
  const i0 = mb.vertex(p[0], yp, p[1], 0, ny, 0, ...col(p));
  const i1 = mb.vertex(q[0], yq, q[1], 0, ny, 0, ...col(q));
  const i2 = mb.vertex(r[0], yr, r[1], 0, ny, 0, ...col(r));
  mb.tri(i0, i1, i2);
}

/**
 * Triangulates a multipolygon on a grid of `cell` m squares (aligned to the world's origin): a square wholly inside is a regular
 * grid of `step` m quads, one on the outline is the polygon's part of it, triangulated and subdivided. So no triangle is a long
 * sliver (earcut's triangles of a whole apron are), and the pavement follows the ground everywhere. Calls `emit` per triangle.
 */
export function tessellate(mp: MultiPolygon, step: number, emit: (a: V2, b: V2, c: V2) => void, cell = 32) {
  const sq = (x0: number, z0: number, w: number): Polygon => [[[x0, z0], [x0 + w, z0], [x0 + w, z0 + w], [x0, z0 + w], [x0, z0]]];
  const areaOf = (p: Polygon) => {
    let t = 0;
    p.forEach((r, k) => {
      let q = 0;
      for (let i = 0; i + 1 < r.length; i++) q += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
      t += (k === 0 ? 1 : -1) * Math.abs(q / 2);
    });
    return t;
  };
  const BLOCK = cell * 4;
  for (const poly of mp) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of poly[0]) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    for (let bz = Math.floor(z0 / BLOCK) * BLOCK; bz < z1; bz += BLOCK) for (let bx = Math.floor(x0 / BLOCK) * BLOCK; bx < x1; bx += BLOCK) {
      const block = safe(() => polygonClipping.intersection([poly], sq(bx, bz, BLOCK)));
      if (!block.length) continue;
      for (let cz = bz; cz < bz + BLOCK; cz += cell) for (let cx = bx; cx < bx + BLOCK; cx += cell) {
        const pieces = safe(() => polygonClipping.intersection(block, sq(cx, cz, cell)));
        for (const pc of pieces) {
          if (pc.length === 1 && Math.abs(areaOf(pc) - cell * cell) < 1e-3) {
            // the whole square: a regular grid
            const n = Math.max(1, Math.round(cell / step));
            const d = cell / n;
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
              const a: V2 = [cx + i * d, cz + j * d], b2: V2 = [cx + (i + 1) * d, cz + j * d], c: V2 = [cx + (i + 1) * d, cz + (j + 1) * d], e: V2 = [cx + i * d, cz + (j + 1) * d];
              // the diagonal as the ground's (south-west to north-east)
              emit(a, e, b2);
              emit(b2, e, c);
            }
          } else tessellatePolygons([pc], step, emit);
        }
      }
    }
  }
}

/** Earcut and subdivide (edges of at most `step` m) a multipolygon whose triangles are small already. */
function tessellatePolygons(mp: MultiPolygon, step: number, emit: (a: V2, b: V2, c: V2) => void) {
  for (const poly of mp) {
    const flat: number[] = [];
    const holes: number[] = [];
    poly.forEach((ring, k) => {
      if (k > 0) holes.push(flat.length / 2);
      for (let i = 0; i + 1 < ring.length; i++) flat.push(ring[i][0], ring[i][1]);
    });
    const idx = earcut(flat, holes.length ? holes : undefined, 2);
    for (let t = 0; t < idx.length; t += 3) {
      const A: V2 = [flat[idx[t] * 2], flat[idx[t] * 2 + 1]];
      const B: V2 = [flat[idx[t + 1] * 2], flat[idx[t + 1] * 2 + 1]];
      const C: V2 = [flat[idx[t + 2] * 2], flat[idx[t + 2] * 2 + 1]];
      const e = Math.max(Math.hypot(B[0] - A[0], B[1] - A[1]), Math.hypot(C[0] - B[0], C[1] - B[1]), Math.hypot(A[0] - C[0], A[1] - C[1]));
      const n = Math.max(1, Math.min(64, Math.ceil(e / step)));
      const P = (i: number, j: number): V2 => {
        const u = i / n, v = j / n;
        return [A[0] + (B[0] - A[0]) * u + (C[0] - A[0]) * v, A[1] + (B[1] - A[1]) * u + (C[1] - A[1]) * v];
      };
      for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
        emit(P(i, j), P(i + 1, j), P(i, j + 1));
        if (i + j + 1 < n) emit(P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
      }
    }
  }
}

export interface AirfieldMeshes {
  stats: { tris: number; deckTris: number; runwayM2: number; taxiwayM2: number; apronM2: number; shoulderM2: number };
}

/**
 * Draws the tile's pavement into `surface` (the `road_airfield` material), the decks' undersides and skirts into `concrete`, and
 * the decks' slabs into `collision`.
 */
export function buildAirfieldMeshes(ap: Airport, classes: AirfieldClasses, drape: Drape, out: { surface: MeshBuilder; concrete: MeshBuilder; collision: MeshBuilder }): AirfieldMeshes {
  const stats = { tris: 0, deckTris: 0, runwayM2: 0, taxiwayM2: 0, apronM2: 0, shoulderM2: 0 };
  const rubberOf = (p: V2): number => {
    // the touchdown zones: dark tyre rubber either side of the centreline, 150 to 900 m in from each threshold
    let k = 0;
    for (const rw of ap.runways) {
      for (const end of rw.ends) {
        const dx = p[0] - end.threshold[0], dz = p[1] - end.threshold[1];
        const along = dx * end.dir[0] + dz * end.dir[1];
        const across = Math.abs(dx * -end.dir[1] + dz * end.dir[0]);
        if (along < 60 || along > 1100 || across > rw.width / 2) continue;
        const a = Math.min(1, (along - 60) / 120) * Math.min(1, (1100 - along) / 400);
        const c = Math.max(0, 1 - Math.abs(across - 4.5) / 6.5);
        const n = 0.75 + 0.25 * Math.sin(along * 0.37 + across * 1.7) * Math.sin(along * 0.051);
        k = Math.max(k, a * c * n);
      }
    }
    return k;
  };
  const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const deckEdges = new Map<string, { a: V2; b: V2; n: number }>();
  const key = (p: V2) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const addEdge = (a: V2, b: V2) => {
    const k = key(a) < key(b) ? `${key(a)}|${key(b)}` : `${key(b)}|${key(a)}`;
    const e = deckEdges.get(k);
    if (e) e.n++;
    else deckEdges.set(k, { a, b, n: 1 });
  };
  const draw = (mp: MultiPolygon, step: number, colour: (p: V2) => [number, number, number], area: 'runwayM2' | 'taxiwayM2' | 'apronM2' | 'shoulderM2') => {
    tessellate(mp, step, (a, b, c) => {
      const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[1] + b[1] + c[1]) / 3;
      const onDeck = drape.deck(cx, cz);
      const y = (p: V2) => drape.top(p[0], p[1]) + PAVE_LIFT;
      upTri(out.surface, a, b, c, y(a), y(b), y(c), colour);
      stats.tris++;
      stats[area] += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      if (onDeck) {
        stats.deckTris++;
        // the slab: its top is the collision surface, its underside is drawn (dark concrete), as the road decks'
        const ys = (p: V2) => drape.top(p[0], p[1]);
        upTri(out.collision, a, b, c, ys(a), ys(b), ys(c), () => [1, 1, 1]);
        const g = lin(0.45);
        // the underside faces down
        upTri(out.concrete, a, b, c, ys(a) - DECK_THICK, ys(b) - DECK_THICK, ys(c) - DECK_THICK, () => [g, g, g * 1.02], true);
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
      }
    });
  };
  const concrete = (base: [number, number, number]) => (p: V2) => {
    // panels: a faint per-slab variation (7.5 m slabs) keeps a big apron from reading as one flat sheet
    const sx = Math.floor(p[0] / 7.5), sz = Math.floor(p[1] / 7.5);
    const h = Math.sin(sx * 12.9898 + sz * 78.233) * 43758.5453;
    const f = 0.96 + 0.08 * (h - Math.floor(h));
    return [base[0] * f, base[1] * f, base[2] * f] as [number, number, number];
  };
  draw(classes.runway, 6, (p) => mix(concrete(COLORS.runway)(p), COLORS.rubber, 0.62 * rubberOf(p)), 'runwayM2');
  draw(classes.taxiway, 9, concrete(COLORS.taxiway), 'taxiwayM2');
  draw(classes.apron, 10, concrete(COLORS.apron), 'apronM2');
  draw(classes.shoulder, 9, () => COLORS.shoulder, 'shoulderM2');
  // the decks' skirts: every edge of a deck triangle that no other deck triangle shares, from the top down to the underside
  const g = lin(0.5);
  for (const e of deckEdges.values()) {
    if (e.n !== 1) continue;
    const ya = drape.top(e.a[0], e.a[1]), yb = drape.top(e.b[0], e.b[1]);
    const nx = -(e.b[1] - e.a[1]), nz = e.b[0] - e.a[0];
    const l = Math.hypot(nx, nz) || 1;
    for (const mb of [out.concrete, out.collision]) {
      const v0 = mb.vertex(e.a[0], ya + PAVE_LIFT, e.a[1], nx / l, 0, nz / l, g, g, g);
      const v1 = mb.vertex(e.b[0], yb + PAVE_LIFT, e.b[1], nx / l, 0, nz / l, g, g, g);
      const v2 = mb.vertex(e.b[0], yb - DECK_THICK, e.b[1], nx / l, 0, nz / l, g, g, g);
      const v3 = mb.vertex(e.a[0], ya - DECK_THICK, e.a[1], nx / l, 0, nz / l, g, g, g);
      // both windings: a skirt is seen from either side (the cut's floor, the deck's other side)
      mb.quad(v0, v1, v2, v3);
      if (mb === out.concrete) mb.quad(v0, v3, v2, v1);
    }
  }
  return { stats };
}

// ---------------------------------------------------------------------------------------------- paint
type Col = [number, number, number];

/** 7-segment strokes (and a few more) of a runway designator glyph in a 1 x 1.6 box: x right, y up, each [x0, y0, x1, y1]. */
const SEG: Record<string, [number, number, number, number]> = {
  a: [0, 1.6, 1, 1.6], b: [1, 1.6, 1, 0.8], c: [1, 0.8, 1, 0], d: [0, 0, 1, 0], e: [0, 0.8, 0, 0], f: [0, 1.6, 0, 0.8], g: [0, 0.8, 1, 0.8],
  k: [0.35, 0.8, 1, 0], // R's leg
};
const GLYPHS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd',
  L: 'fed', R: 'efabgk', C: 'afed',
};

export interface MarkingSink {
  /** a quad on the pavement: four (x, z) corners in order, a colour */
  quad(p: [V2, V2, V2, V2], col: Col): void;
}

/** A strip of width `w` along a polyline (x, z), as quads. */
function strip(sink: MarkingSink, pts: V2[], w: number, col: Col) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const r = segRect(pts[i], pts[i + 1], w / 2);
    sink.quad([r[0], r[1], r[2], r[3]], col);
  }
}

/** A bar: centre along a direction `u` (unit), `len` long along it, `w` across. */
function bar(sink: MarkingSink, c: V2, u: V2, len: number, w: number, col: Col) {
  const a: V2 = [c[0] - (u[0] * len) / 2, c[1] - (u[1] * len) / 2];
  const b: V2 = [c[0] + (u[0] * len) / 2, c[1] + (u[1] * len) / 2];
  const r = segRect(a, b, w / 2);
  sink.quad([r[0], r[1], r[2], r[3]], col);
}

/** The pieces of a polyline (x, z) at [s0, s1] of its length. */
function slice(pts: V2[], s0: number, s1: number): V2[] {
  const out: V2[] = [];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t0 = Math.max(0, (s0 - s) / l), t1 = Math.min(1, (s1 - s) / l);
    if (t1 > t0 && l > 0) {
      const p0: V2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1: V2 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (!out.length) out.push(p0);
      out.push(p1);
    }
    s += l;
  }
  return out;
}

const lengthOf = (pts: V2[]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** Point and direction at arc length s of a polyline. */
function at(pts: V2[], s: number): { p: V2; d: V2 } {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + l >= s || i + 2 === pts.length) {
      const t = l > 0 ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: l > 0 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0] };
    }
    acc += l;
  }
  return { p: pts[0], d: [1, 0] };
}

/** A designator ('09', 'L') read by a pilot landing along `u` (the glyph's up), its baseline centre at `c`, `h` tall. */
function glyphs(sink: MarkingSink, text: string, c: V2, u: V2, h: number, col: Col) {
  // right of a pilot facing u: (-uz, ux) in x-east z-south
  const rgt: V2 = [-u[1], u[0]];
  const gw = h / 1.6 * 0.62;
  const gap = gw * 0.45;
  const stroke = h * 0.09;
  const total = text.length * gw + (text.length - 1) * gap;
  for (let k = 0; k < text.length; k++) {
    const segs = GLYPHS[text[k]];
    if (!segs) continue;
    const x0 = -total / 2 + k * (gw + gap);
    for (const s of segs) {
      const [ax, ay, bx, by] = SEG[s];
      const P = (gx: number, gy: number): V2 => [c[0] + rgt[0] * (x0 + gx * gw) + u[0] * gy * (h / 1.6), c[1] + rgt[1] * (x0 + gx * gw) + u[1] * gy * (h / 1.6)];
      const a = P(ax, ay), b = P(bx, by);
      // a little past the corners so strokes meet
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const ext = stroke / 2;
      const a2: V2 = [a[0] - (dx / l) * ext, a[1] - (dz / l) * ext], b2: V2 = [b[0] + (dx / l) * ext, b[1] + (dz / l) * ext];
      const r = segRect(a2, b2, stroke / 2);
      sink.quad([r[0], r[1], r[2], r[3]], col);
    }
  }
}

export interface MarkingStats { runways: number; taxiwayM: number; holds: number; leadIns: number; quads: number }

/** Paints the airport into `sink` (every runway and line: the sink clips to its tile). */
export function buildAirfieldMarkings(ap: Airport, sink: MarkingSink, onRunway: (x: number, z: number) => boolean): MarkingStats {
  const stats: MarkingStats = { runways: 0, taxiwayM: 0, holds: 0, leadIns: 0, quads: 0 };
  const W = COLORS.white, Y = COLORS.yellow;
  const counted: MarkingSink = { quad: (p, c) => { stats.quads++; sink.quad(p, c); } };
  for (const rw of ap.runways) {
    stats.runways++;
    const hw = rw.width / 2;
    const L = rw.length;
    const line: V2[] = [rw.ends[0].end, rw.ends[1].end];
    // side stripes, the whole length
    for (const side of [-1, 1]) {
      const o = side * (hw - 0.6);
      const d = rw.ends[0].dir;
      const off: V2 = [-d[1] * o, d[0] * o];
      strip(counted, [[line[0][0] + off[0], line[0][1] + off[1]], [line[1][0] + off[0], line[1][1] + off[1]]], 0.9, W);
    }
    let designEnd = 0;
    for (const end of rw.ends) {
      const u = end.dir;
      const rgt: V2 = [-u[1], u[0]];
      const th = end.threshold;
      const P = (along: number, across: number): V2 => [th[0] + u[0] * along + rgt[0] * across, th[1] + u[1] * along + rgt[1] * across];
      // a displaced threshold: the bar across, and arrows on the displaced pavement
      const disp = Math.hypot(th[0] - end.end[0], th[1] - end.end[1]);
      if (disp > 30) {
        bar(counted, P(-1.5, 0), rgt, rw.width - 2, 3, W);
        for (let s = 20; s < disp - 20; s += 60) {
          strip(counted, [P(-s - 15, 0), P(-s, 0)], 0.9, W);
          strip(counted, [P(-s - 4, -3), P(-s, 0)], 0.9, W);
          strip(counted, [P(-s - 4, 3), P(-s, 0)], 0.9, W);
        }
      }
      // threshold bars: twelve 1.75 m stripes, 45 m long, from 6 m in
      for (let k = 0; k < 6; k++) for (const side of [-1, 1]) bar(counted, P(6 + 22.5, side * (3.0 + (k + 0.5) * 3.45)), u, 45, 1.75, W);
      // the designator: the letter nearer the threshold, the number beyond it
      const m = /^(\d{2})([LCR]?)$/.exec(end.ref);
      const numStr = m ? m[1] : end.ref.replace(/[^0-9]/g, '').padStart(2, '0');
      const letter = m?.[2] ?? '';
      const H = 18;
      let s = 63;
      if (letter) {
        glyphs(counted, letter, P(s, 0), u, H, W);
        s += H + 6;
      }
      glyphs(counted, numStr, P(s, 0), u, H, W);
      designEnd = Math.max(designEnd, s + H + 18);
      // aiming point: two 45 x 9 m bars, 311 m in
      for (const side of [-1, 1]) bar(counted, P(311 + 22.5, side * (11 + 4.5)), u, 45, 9, W);
      // touchdown zone bars: 3, 2, 2, 1, 1 bars a side at 152, 457, 610, 762, 914 m
      for (const [s0, n] of [[152, 3], [457, 2], [610, 2], [762, 1], [914, 1]] as [number, number][]) {
        if (s0 + 23 > L / 2) continue;
        for (let k = 0; k < n; k++) for (const side of [-1, 1]) bar(counted, P(s0 + 11.5, side * (11 + 0.9 + k * 3.3)), u, 23, 1.8, W);
      }
    }
    // the centreline: 36 m dashes, 24 m gaps, 0.9 m wide, between the designators
    const ctr = [rw.ends[0].threshold, rw.ends[1].threshold];
    const cl = Math.hypot(ctr[1][0] - ctr[0][0], ctr[1][1] - ctr[0][1]);
    for (let s = designEnd; s + 36 < cl - designEnd; s += 60) strip(counted, slice(ctr, s, s + 36), 0.9, W);
  }
  // stopways (and the blast pads they mark): yellow chevrons pointing at the runway
  for (const l of ap.lines) {
    if (l.kind !== 'stopway') continue;
    const len = lengthOf(l.pts);
    const rwEnd = nearestRunwayEnd(ap, l.pts);
    for (let s = 15; s < len - 5; s += 30) {
      const { p, d } = at(l.pts, s);
      let u = d;
      if (rwEnd) {
        const toRw: V2 = [rwEnd[0] - p[0], rwEnd[1] - p[1]];
        if (toRw[0] * u[0] + toRw[1] * u[1] < 0) u = [-u[0], -u[1]];
      }
      const rgt: V2 = [-u[1], u[0]];
      const hw = l.width / 2 - 1;
      for (const side of [-1, 1]) {
        const a: V2 = [p[0] + rgt[0] * side * hw - u[0] * 12, p[1] + rgt[1] * side * hw - u[1] * 12];
        strip(counted, [a, p], 0.9, Y);
      }
    }
  }
  // taxiway centrelines (yellow, 0.3 m), stopping at the runways' edges
  for (const l of ap.lines) {
    if (l.kind !== 'taxiway' && l.kind !== 'taxilane') continue;
    const pts = simplifyLine(l.pts, 0.2);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k < n; k++) {
        const p0: V2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        const p1: V2 = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
        if (onRunway((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)) continue;
        strip(counted, [p0, p1], 0.3, Y);
        stats.taxiwayM += len / n;
      }
    }
  }
  // runway holding positions on the taxiways (nodes on a taxiway: across it), and the mapped holding lines
  const lineAt = new Map<number, AeroLine>();
  for (const l of ap.lines) if (l.kind === 'taxiway' || l.kind === 'taxilane') for (const id of l.nodes) if (!lineAt.has(id)) lineAt.set(id, l);
  const hold = (p: V2, along: V2, half: number, ils: boolean) => {
    // the dashed lines face the runway: the side of the runway nearest to the point
    const near = nearestRunwayPoint(ap, p);
    let u = along;
    if (near && (near[0] - p[0]) * u[0] + (near[1] - p[1]) * u[1] < 0) u = [-u[0], -u[1]];
    const rgt: V2 = [-u[1], u[0]];
    const across = (o: number): [V2, V2] => [[p[0] + u[0] * o - rgt[0] * half, p[1] + u[1] * o - rgt[1] * half], [p[0] + u[0] * o + rgt[0] * half, p[1] + u[1] * o + rgt[1] * half]];
    if (ils) {
      // the ILS critical area hold: two solid lines with rungs between them (a ladder)
      for (const o of [-0.9, 0.9]) strip(counted, across(o), 0.3, Y);
      for (let k = -half + 0.8; k <= half - 0.8; k += 3.2) strip(counted, [[p[0] - rgt[0] * -k - u[0] * 0.9, p[1] - rgt[1] * -k - u[1] * 0.9], [p[0] - rgt[0] * -k + u[0] * 0.9, p[1] - rgt[1] * -k + u[1] * 0.9]], 0.3, Y);
      return;
    }
    // two solid lines on the hold side, two dashed (0.9 m on, 0.9 m off) on the runway side
    for (const o of [-0.9, -0.3]) strip(counted, across(o), 0.3, Y);
    for (const o of [0.3, 0.9]) {
      const [a, b] = across(o);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s + 0.9 <= len; s += 1.8) strip(counted, slice([a, b], s, s + 0.9), 0.3, Y);
    }
  };
  for (const h of ap.holding) {
    const l = lineAt.get(h.id);
    if (!l) continue;
    const i = l.nodes.indexOf(h.id);
    const a = l.pts[Math.max(0, i - 1)], b = l.pts[Math.min(l.pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    hold([h.x, h.z], [(b[0] - a[0]) / len, (b[1] - a[1]) / len], l.width / 2 - 0.5, /ils/i.test(h.tags['holding_position:type'] ?? ''));
    stats.holds++;
  }
  for (const hl of ap.holdingLines) {
    const a = hl.pts[0], b = hl.pts[hl.pts.length - 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 3) continue;
    const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // the line runs across the taxiway: the taxiway runs along its normal
    hold(mid, [-(b[1] - a[1]) / len, (b[0] - a[0]) / len], len / 2, false);
    stats.holds++;
  }
  // stands: the lead-in line to the stand, a stop bar at its end
  for (const l of ap.lines) {
    if (l.kind !== 'parking_position' || l.pts.length < 2) continue;
    strip(counted, simplifyLine(l.pts, 0.2), 0.3, Y);
    const n = l.pts.length;
    const p = l.pts[n - 1], q = l.pts[n - 2];
    const len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    const u: V2 = [(p[0] - q[0]) / len, (p[1] - q[1]) / len];
    bar(counted, p, [-u[1], u[0]], 5, 0.45, Y);
    stats.leadIns++;
  }
  return stats;
}

function nearestRunwayPoint(ap: Airport, p: V2): V2 | null {
  let best: V2 | null = null, bd = Infinity;
  for (const rw of ap.runways) {
    const a = rw.ends[0].end, b = rw.ends[1].end;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz)));
    const q: V2 = [a[0] + dx * t, a[1] + dz * t];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function nearestRunwayEnd(ap: Airport, pts: V2[]): V2 | null {
  let best: V2 | null = null, bd = 400;
  for (const rw of ap.runways) for (const e of rw.ends) for (const p of [pts[0], pts[pts.length - 1]]) {
    const d = Math.hypot(e.end[0] - p[0], e.end[1] - p[1]);
    if (d < bd) { bd = d; best = e.end; }
  }
  return best;
}

/** Is (x, z) on a runway's pavement (within its width)? */
export function runwayTest(ap: Airport, grow = 0): (x: number, z: number) => boolean {
  const rects = ap.runways.map((rw) => ({ a: rw.ends[0].end, d: rw.ends[0].dir, len: rw.length, hw: rw.width / 2 + grow }));
  return (x, z) => {
    for (const r of rects) {
      const dx = x - r.a[0], dz = z - r.a[1];
      const along = dx * r.d[0] + dz * r.d[1];
      if (along < -grow || along > r.len + grow) continue;
      if (Math.abs(dx * -r.d[1] + dz * r.d[0]) <= r.hw) return true;
    }
    return false;
  };
}

/** A sink that clips each marking quad to the tile and drapes it on the pavement into `mb`. */
export function markingSink(mb: MeshBuilder, b: Rect, top: (x: number, z: number) => number): MarkingSink {
  return {
    quad(p, col) {
      // a coarse reject, then Sutherland-Hodgman against the four sides
      let poly: V2[] = [...p];
      const clip = (inside: (q: V2) => boolean, cross: (q: V2, r: V2) => V2) => {
        const out: V2[] = [];
        for (let i = 0; i < poly.length; i++) {
          const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
          const ci = inside(cur), pi = inside(prev);
          if (ci) {
            if (!pi) out.push(cross(prev, cur));
            out.push(cur);
          } else if (pi) out.push(cross(prev, cur));
        }
        poly = out;
      };
      const lerpX = (x: number) => (q: V2, r: V2): V2 => { const t = (x - q[0]) / (r[0] - q[0]); return [x, q[1] + (r[1] - q[1]) * t]; };
      const lerpZ = (z: number) => (q: V2, r: V2): V2 => { const t = (z - q[1]) / (r[1] - q[1]); return [q[0] + (r[0] - q[0]) * t, z]; };
      clip((q) => q[0] >= b.minX, lerpX(b.minX));
      if (poly.length) clip((q) => q[0] <= b.maxX, lerpX(b.maxX));
      if (poly.length) clip((q) => q[1] >= b.minZ, lerpZ(b.minZ));
      if (poly.length) clip((q) => q[1] <= b.maxZ, lerpZ(b.maxZ));
      if (poly.length < 3) return;
      // long strips (a 45 m bar): split into pieces no longer than 8 m so they follow the ground
      const y = (q: V2) => top(q[0], q[1]) + PAVE_LIFT + PAINT_LIFT;
      const tris: [V2, V2, V2][] = [];
      for (let i = 1; i + 1 < poly.length; i++) tris.push([poly[0], poly[i], poly[i + 1]]);
      for (const [a, bb, c] of tris) {
        const e = Math.max(Math.hypot(bb[0] - a[0], bb[1] - a[1]), Math.hypot(c[0] - bb[0], c[1] - bb[1]), Math.hypot(a[0] - c[0], a[1] - c[1]));
        const n = Math.max(1, Math.min(16, Math.ceil(e / 8)));
        const P = (i: number, j: number): V2 => [a[0] + ((bb[0] - a[0]) * i) / n + ((c[0] - a[0]) * j) / n, a[1] + ((bb[1] - a[1]) * i) / n + ((c[1] - a[1]) * j) / n];
        for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
          const q0 = P(i, j), q1 = P(i + 1, j), q2 = P(i, j + 1);
          upTri(mb, q0, q1, q2, y(q0), y(q1), y(q2), () => col);
          if (i + j + 1 < n) {
            const r0 = P(i + 1, j), r1 = P(i + 1, j + 1), r2 = P(i, j + 1);
            upTri(mb, r0, r1, r2, y(r0), y(r1), y(r2), () => col);
          }
        }
      }
    },
  };
}
