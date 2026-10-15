/**
 * Pure parts of the street-name indicator (streetName.ts): the road index and the nearest-named-road
 * query, the neighbourhood lookup (point in polygon, first match wins, default zone otherwise), the
 * street abbreviations, and the debounce that keeps the shown name from flickering at junctions.
 * No DOM, no three.js. The index is built once; queries allocate nothing.
 *
 * Game axes: +X east, +Z south. Heights (y) are only used to ignore roads far above or below the
 * player (a walker under the freeway is not on it).
 */
import type { RoadData } from '../../shared/tile';

/** Only named roads within this distance (m) of the player count. */
export const STREET_RANGE_M = 25;
/** Grid cell size (m) of the segment index. */
export const STREET_CELL_M = 40;
/** Candidates within this distance (m) of the nearest one tie; the tie goes to the road you travel along. */
export const STREET_TIE_M = 2.5;
/** Roads whose height differs from the player's by more than this (m) are not the road under them. */
export const STREET_MAX_DY_M = 4;
/** A new name must hold this long (ms) before the label switches to it. */
export const STREET_HOLD_MS = 800;

/** Speed (m/s) above which the travel direction is the velocity, below it the facing. */
export const TRAVEL_MIN_MPS = 2;

/** Segments of every named road, bucketed into a grid of cells (CSR layout: `cellStart` / `cellSegs`). */
export interface StreetIndex {
  /** Name id to display name. */
  readonly names: readonly string[];
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  readonly cellStart: Int32Array;
  readonly cellSegs: Int32Array;
  readonly ax: Float64Array;
  readonly az: Float64Array;
  readonly ay: Float64Array;
  readonly bx: Float64Array;
  readonly bz: Float64Array;
  readonly by: Float64Array;
  /** Segment to name id. */
  readonly name: Int32Array;
}

/** Builds the index over the named roads (unnamed roads are never candidates). Run once per tile. */
export function buildStreetIndex(roads: readonly RoadData[]): StreetIndex {
  const nameIds = new Map<string, number>();
  const names: string[] = [];
  let total = 0;
  for (const r of roads) {
    if (!r.name?.trim()) continue;
    total += Math.max(0, r.points.length - 1);
  }
  const ax = new Float64Array(total);
  const az = new Float64Array(total);
  const ay = new Float64Array(total);
  const bx = new Float64Array(total);
  const bz = new Float64Array(total);
  const by = new Float64Array(total);
  const name = new Int32Array(total);
  let n = 0;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const r of roads) {
    const label = r.name?.trim();
    if (!label) continue;
    let id = nameIds.get(label);
    if (id === undefined) {
      id = names.length;
      names.push(label);
      nameIds.set(label, id);
    }
    const p = r.points;
    for (let i = 0; i + 1 < p.length; i++) {
      const dx = p[i + 1][0] - p[i][0];
      const dz = p[i + 1][2] - p[i][2];
      if (dx * dx + dz * dz < 1e-6) continue; // a repeated point is no segment
      ax[n] = p[i][0];
      ay[n] = p[i][1];
      az[n] = p[i][2];
      bx[n] = p[i + 1][0];
      by[n] = p[i + 1][1];
      bz[n] = p[i + 1][2];
      name[n] = id;
      minX = Math.min(minX, ax[n], bx[n]);
      maxX = Math.max(maxX, ax[n], bx[n]);
      minZ = Math.min(minZ, az[n], bz[n]);
      maxZ = Math.max(maxZ, az[n], bz[n]);
      n++;
    }
  }
  if (n === 0) {
    minX = minZ = 0;
    maxX = maxZ = 0;
  }
  const cols = Math.max(1, Math.floor((maxX - minX) / STREET_CELL_M) + 1);
  const rows = Math.max(1, Math.floor((maxZ - minZ) / STREET_CELL_M) + 1);
  const cellStart = new Int32Array(cols * rows + 1);
  // Each segment goes into every cell its bounding box touches: count, prefix-sum, then fill.
  const cellRange = (s: number) => {
    const c0 = Math.floor((Math.min(ax[s], bx[s]) - minX) / STREET_CELL_M);
    const c1 = Math.floor((Math.max(ax[s], bx[s]) - minX) / STREET_CELL_M);
    const r0 = Math.floor((Math.min(az[s], bz[s]) - minZ) / STREET_CELL_M);
    const r1 = Math.floor((Math.max(az[s], bz[s]) - minZ) / STREET_CELL_M);
    return [c0, c1, r0, r1] as const;
  };
  for (let s = 0; s < n; s++) {
    const [c0, c1, r0, r1] = cellRange(s);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellStart[r * cols + c + 1]++;
  }
  for (let i = 0; i < cols * rows; i++) cellStart[i + 1] += cellStart[i];
  const cellSegs = new Int32Array(cellStart[cols * rows]);
  const cursor = cellStart.slice(0, cols * rows);
  for (let s = 0; s < n; s++) {
    const [c0, c1, r0, r1] = cellRange(s);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellSegs[cursor[r * cols + c]++] = s;
  }
  return { names, minX, minZ, cols, rows, count: n, cellStart, cellSegs, ax, az, ay, bx, bz, by, name };
}

/**
 * Squared 2D distance from (x, z) to segment s, or Infinity when the segment is not the road at
 * height y. The height is read where the closest point lies.
 */
function segmentDist2(idx: StreetIndex, s: number, x: number, y: number, z: number): number {
  const dx = idx.bx[s] - idx.ax[s];
  const dz = idx.bz[s] - idx.az[s];
  const len2 = dx * dx + dz * dz;
  let t = ((x - idx.ax[s]) * dx + (z - idx.az[s]) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const py = idx.ay[s] + (idx.by[s] - idx.ay[s]) * t;
  if (Math.abs(py - y) > STREET_MAX_DY_M) return Infinity;
  const ex = idx.ax[s] + dx * t - x;
  const ez = idx.az[s] + dz * t - z;
  return ex * ex + ez * ez;
}

/**
 * The name id (into `idx.names`) of the nearest named road within STREET_RANGE_M of (x, y, z), or -1.
 * (tx, tz) is the direction the player travels (or faces): among the roads within STREET_TIE_M of the
 * nearest, the one most nearly along that direction wins. With no direction the nearest one wins.
 */
export function nearestNamedRoad(idx: StreetIndex, x: number, y: number, z: number, tx: number, tz: number): number {
  if (idx.count === 0) return -1;
  const R = STREET_RANGE_M;
  const R2 = R * R;
  const cs = STREET_CELL_M;
  const c0 = clampInt(Math.floor((x - R - idx.minX) / cs), idx.cols - 1);
  const c1 = clampInt(Math.floor((x + R - idx.minX) / cs), idx.cols - 1);
  const r0 = clampInt(Math.floor((z - R - idx.minZ) / cs), idx.rows - 1);
  const r1 = clampInt(Math.floor((z + R - idx.minZ) / cs), idx.rows - 1);
  // Pass 1: the nearest distance.
  let best2 = Infinity;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * idx.cols + c;
      for (let k = idx.cellStart[cell], end = idx.cellStart[cell + 1]; k < end; k++) {
        const d2 = segmentDist2(idx, idx.cellSegs[k], x, y, z);
        if (d2 < best2) best2 = d2;
      }
    }
  }
  if (best2 > R2) return -1;
  // Pass 2: among the roads within the tie band, the one most nearly along the travel direction.
  const band = Math.sqrt(best2) + STREET_TIE_M;
  const band2 = band * band;
  const tlen = Math.hypot(tx, tz);
  const hasTravel = tlen > 1e-6;
  const ux = hasTravel ? tx / tlen : 0;
  const uz = hasTravel ? tz / tlen : 0;
  let pick = -1;
  let pickAlign = -1;
  let pickD2 = Infinity;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * idx.cols + c;
      for (let k = idx.cellStart[cell], end = idx.cellStart[cell + 1]; k < end; k++) {
        const s = idx.cellSegs[k];
        const d2 = segmentDist2(idx, s, x, y, z);
        if (d2 > band2) continue;
        const sdx = idx.bx[s] - idx.ax[s];
        const sdz = idx.bz[s] - idx.az[s];
        const slen = Math.hypot(sdx, sdz);
        const align = hasTravel ? Math.abs((sdx * ux + sdz * uz) / slen) : 0;
        if (align > pickAlign + 1e-9 || (Math.abs(align - pickAlign) <= 1e-9 && d2 < pickD2)) {
          pick = idx.name[s];
          pickAlign = align;
          pickD2 = d2;
        }
      }
    }
  }
  return pick;
}

function clampInt(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/** A neighbourhood zone as in population.json: a polygon of [x, z] points in game metres, or the default. */
export interface ZoneShape {
  name: string;
  default?: boolean;
  polygon?: readonly (readonly [number, number])[];
}

/** Even-odd rule: is (x, z) inside the polygon of [x, z] points? */
export function pointInPolygon(x: number, z: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The index of the zone for (x, z): the first non-default zone (in file order) whose polygon holds
 * the point, else the default zone, else -1.
 */
export function zoneIndexAt(zones: readonly ZoneShape[], x: number, z: number): number {
  let fallback = -1;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (zone.default) {
      if (fallback < 0) fallback = i;
      continue;
    }
    if (zone.polygon && pointInPolygon(x, z, zone.polygon)) return i;
  }
  return fallback;
}

const DIRECTIONS: Record<string, string> = {
  Northeast: 'NE',
  Northwest: 'NW',
  Southeast: 'SE',
  Southwest: 'SW',
  North: 'N',
  South: 'S',
  East: 'E',
  West: 'W',
};
const SUFFIXES: Record<string, string> = {
  Street: 'St',
  Avenue: 'Ave',
  Boulevard: 'Blvd',
  Drive: 'Dr',
  Road: 'Rd',
  Place: 'Pl',
  Parkway: 'Pkwy',
  Circle: 'Cir',
  Court: 'Ct',
  Lane: 'Ln',
  Terrace: 'Ter',
  Highway: 'Hwy',
};

/** "Peachtree Street Northeast" to "Peachtree St NE". Words it does not know pass through. */
export function abbreviateStreet(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => SUFFIXES[w] ?? DIRECTIONS[w] ?? w)
    .join(' ');
}

/**
 * A value that switches only after a new candidate has held for `holdMs`. The first value is taken
 * at once. A null candidate (nothing there) breaks the hold but does not switch.
 */
export class Debounced<T> {
  private shown: T | undefined;
  private pending: T | undefined;
  private since = 0;
  private holding = false;

  constructor(readonly holdMs = STREET_HOLD_MS) {}

  get value(): T | undefined {
    return this.shown;
  }

  /** Offers this frame's candidate at time `now` (ms). Returns true when the shown value changed. */
  offer(candidate: T | null | undefined, now: number): boolean {
    if (candidate === null || candidate === undefined) {
      this.holding = false;
      this.pending = undefined;
      return false;
    }
    if (this.shown === undefined) {
      this.shown = candidate;
      this.holding = false;
      return true;
    }
    if (candidate === this.shown) {
      this.holding = false;
      this.pending = undefined;
      return false;
    }
    if (!this.holding || candidate !== this.pending) {
      this.pending = candidate;
      this.since = now;
      this.holding = true;
      return false;
    }
    if (now - this.since >= this.holdMs) {
      this.shown = candidate;
      this.holding = false;
      this.pending = undefined;
      return true;
    }
    return false;
  }
}
