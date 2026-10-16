/**
 * Building footprints, recovered from `collision.bin`. A closed trimesh has no inside that a physics
 * query can report, so "is this person in a building" needs the footprint itself. The pipeline writes
 * the buildings first in `collision.bin` (`collision.buildingTriangles` in `tile.json`), each as walls
 * plus a flat roof triangulated over the footprint (holes left out), so the roof triangles *are* the
 * footprint and the roof edges that belong to one triangle only are its outline.
 *
 * Pure numbers: used by the sim (spawn checks, the unstick safety net), the tests and the audit.
 */

const CELL = 16;
/** A building counts as around somebody whose feet are no more than this far under where its walls start. */
const SLACK = 1.0;

export class FootprintIndex {
  /** Roof triangles: x0 z0 x1 z1 x2 z2, the roof height of each, and the height its walls start at. */
  private readonly tri: Float32Array;
  private readonly roofY: Float32Array;
  private readonly baseY: Float32Array;
  /** Outline segments: x0 z0 x1 z1, and the height their wall starts at. */
  private readonly seg: Float32Array;
  private readonly segBase: Float32Array;
  private readonly triCells = new Map<number, number[]>();
  private readonly segCells = new Map<number, number[]>();
  readonly triangleCount: number;
  readonly outlineCount: number;

  constructor(positions: Float32Array, indices: Uint32Array, buildingTriangles: number) {
    const n = Math.min(buildingTriangles, Math.floor(indices.length / 3));
    // the lowest the walls go at each corner *of each roof height* (a roof's corners are the walls' corners): where a building stands on the
    // ground, or hangs over a cut, or floats (a skybridge drawn on the very corners of the tower it joins keeps its own base: the tower's
    // walls have another top). A wall triangle has two heights: its top is the roof's, its bottom the base.
    const low = new Map<string, number>();
    for (let t = 0; t < n * 3; t += 3) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const y = positions[indices[t + k] * 3 + 1];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      if (hi - lo < 1e-3) continue; // a roof triangle
      for (let k = 0; k < 3; k++) {
        const v = indices[t + k];
        if (positions[v * 3 + 1] - lo > 1e-3) continue;
        const key = cornerKey(positions, v, hi);
        const prev = low.get(key);
        if (prev === undefined || lo < prev) low.set(key, lo);
      }
    }
    // (a roof corner with no wall under it, which a bake does not write, is its own height)
    const lowAt = (v: number, top: number) => low.get(cornerKey(positions, v, top)) ?? top;
    const tris: number[] = [];
    const ys: number[] = [];
    const bases: number[] = [];
    const edges = new Map<string, { a: number; b: number; count: number }>();
    for (let t = 0; t < n; t++) {
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      const ya = positions[a * 3 + 1], yb = positions[b * 3 + 1], yc = positions[c * 3 + 1];
      if (Math.abs(ya - yb) > 1e-3 || Math.abs(yb - yc) > 1e-3) continue;
      const ax = positions[a * 3], az = positions[a * 3 + 2];
      const bx = positions[b * 3], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cz = positions[c * 3 + 2];
      if (Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) < 1e-6) continue;
      tris.push(ax, az, bx, bz, cx, cz);
      ys.push(ya);
      bases.push(Math.min(lowAt(a, ya), lowAt(b, ya), lowAt(c, ya)));
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        // an edge is identified by where its ends are: the vertices of a roof are copies, not shared with the walls
        const k = positionKey(positions, p, q);
        const e = edges.get(k);
        if (e) e.count++;
        else edges.set(k, { a: p, b: q, count: 1 });
      }
    }
    this.tri = Float32Array.from(tris);
    this.roofY = Float32Array.from(ys);
    this.baseY = Float32Array.from(bases);
    this.triangleCount = ys.length;
    const segs: number[] = [];
    const segBases: number[] = [];
    for (const e of edges.values()) {
      if (e.count !== 1) continue;
      segs.push(positions[e.a * 3], positions[e.a * 3 + 2], positions[e.b * 3], positions[e.b * 3 + 2]);
      segBases.push(Math.min(lowAt(e.a, positions[e.a * 3 + 1]), lowAt(e.b, positions[e.b * 3 + 1])));
    }
    this.seg = Float32Array.from(segs);
    this.segBase = Float32Array.from(segBases);
    this.outlineCount = segs.length / 4;
    for (let i = 0; i < this.triangleCount; i++) {
      const o = i * 6;
      this.addToCells(this.triCells, i, Math.min(this.tri[o], this.tri[o + 2], this.tri[o + 4]), Math.min(this.tri[o + 1], this.tri[o + 3], this.tri[o + 5]), Math.max(this.tri[o], this.tri[o + 2], this.tri[o + 4]), Math.max(this.tri[o + 1], this.tri[o + 3], this.tri[o + 5]));
    }
    for (let i = 0; i < this.outlineCount; i++) {
      const o = i * 4;
      this.addToCells(this.segCells, i, Math.min(this.seg[o], this.seg[o + 2]), Math.min(this.seg[o + 1], this.seg[o + 3]), Math.max(this.seg[o], this.seg[o + 2]), Math.max(this.seg[o + 1], this.seg[o + 3]));
    }
  }

  private addToCells(map: Map<number, number[]>, i: number, x0: number, z0: number, x1: number, z1: number) {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cellKey(cx, cz);
        const a = map.get(k);
        if (a) a.push(i);
        else map.set(k, [i]);
      }
    }
  }

  get empty(): boolean {
    return this.triangleCount === 0;
  }

  /**
   * The roof height of a building whose footprint holds (x, z), whose roof is above `y` and whose walls reach down to within
   * `SLACK` of `y` (`y` is a body's height; people on a roof, which nothing allows, are not inside, and neither is somebody walking
   * in a cut far below a building that spans it). NaN when there is none.
   */
  roofAbove(x: number, z: number, y = NaN): number {
    const list = this.triCells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return NaN;
    const t = this.tri;
    for (const i of list) {
      // (no height given, NaN: every building counts)
      if (this.roofY[i] <= y + 0.5 || this.baseY[i] > y + SLACK) continue;
      const o = i * 6;
      if (inTriangle(x, z, t[o], t[o + 1], t[o + 2], t[o + 3], t[o + 4], t[o + 5])) return this.roofY[i];
    }
    return NaN;
  }

  /** Whether the point (x, y, z) is inside a building: under the roof of a footprint that holds (x, z). */
  inside(x: number, y: number, z: number): boolean {
    return !Number.isNaN(this.roofAbove(x, z, y));
  }

  /**
   * Distance from (x, z) to the nearest wall (footprint outline) within `max`, m, and the unit vector
   * from the nearest point of that wall toward (x, z) (Infinity when there is none). For a point inside a
   * footprint that vector points into the building: the way out is the other way.
   */
  nearestWall(x: number, z: number, max: number, out: { nx: number; nz: number } = { nx: 0, nz: 0 }, y = NaN): number {
    let best = Infinity;
    const s = this.seg;
    for (let cx = Math.floor((x - max) / CELL); cx <= Math.floor((x + max) / CELL); cx++) {
      for (let cz = Math.floor((z - max) / CELL); cz <= Math.floor((z + max) / CELL); cz++) {
        const list = this.segCells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (this.segBase[i] > y + SLACK) continue;
          const o = i * 4;
          const ax = s[o], az = s[o + 1], dx = s[o + 2] - ax, dz = s[o + 3] - az;
          const l2 = dx * dx + dz * dz;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < best) {
            best = d;
            out.nx = d > 1e-6 ? (x - px) / d : 0;
            out.nz = d > 1e-6 ? (z - pz) / d : 0;
          }
        }
      }
    }
    return best <= max ? best : Infinity;
  }

  /**
   * Where a point inside a building leaves it: just outside the nearest wall (`margin` m beyond it), or null when no wall is within
   * `max` m. (The point may be inside another building from there: ask again.)
   */
  exitPoint(x: number, z: number, y = -Infinity, max = 40, margin = 0.7): { x: number; z: number } | null {
    const n = { nx: 0, nz: 0 };
    const d = this.nearestWall(x, z, max, n, y);
    if (d === Infinity) return null;
    // a point inside has the wall's inward side toward it; a point outside is already out
    return { x: x - n.nx * (d + margin), z: z - n.nz * (d + margin) };
  }

  /**
   * Whether a disc of radius `r` at (x, z) is clear of every building: not inside a footprint and no wall within `r`.
   * `y` is the body's height (see `roofAbove`).
   */
  clear(x: number, y: number, z: number, r: number): boolean {
    if (this.inside(x, y, z)) return false;
    return this.nearestWall(x, z, r, undefined, y) === Infinity;
  }
}

/** A building corner by where it is on the ground plan (0.5 cm). */
function cornerKey(p: Float32Array, v: number, top: number): string {
  return `${Math.round(p[v * 3] * 200)},${Math.round(p[v * 3 + 2] * 200)},${Math.round(top * 20)}`;
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

/** Identifies an edge by where its ends are (0.5 cm), because the vertices of a roof are copies. */
function positionKey(p: Float32Array, a: number, b: number): string {
  const ka = `${Math.round(p[a * 3] * 200)},${Math.round(p[a * 3 + 2] * 200)}`;
  const kb = `${Math.round(p[b * 3] * 200)},${Math.round(p[b * 3 + 2] * 200)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function inTriangle(px: number, pz: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
