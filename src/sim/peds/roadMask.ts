/**
 * Where the road is: the centrelines of `roads.json` with their half widths, and the junction
 * polygons. Pedestrians use it to tell a car on the street from a car on the pavement.
 */
import type { JunctionsData, RoadData } from '../../shared/tile';
import { cellKey } from './graph';

const CELL = 32;

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
}

export class RoadMask {
  private readonly segs: Seg[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly polys: { ring: [number, number][]; minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
  private readonly polyCells = new Map<number, number[]>();

  constructor(roads: readonly RoadData[] = [], junctions?: JunctionsData) {
    for (const r of roads) {
      for (let i = 0; i + 1 < r.points.length; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const k = this.segs.length;
        this.segs.push({ ax: a[0], az: a[2], bx: b[0], bz: b[2], half: r.width / 2 });
        this.register(this.cells, k, Math.min(a[0], b[0]) - r.width / 2, Math.min(a[2], b[2]) - r.width / 2, Math.max(a[0], b[0]) + r.width / 2, Math.max(a[2], b[2]) + r.width / 2);
      }
    }
    for (const j of junctions?.junctions ?? []) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const p of j.polygon) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
      }
      const k = this.polys.length;
      this.polys.push({ ring: j.polygon, minX, minZ, maxX, maxZ });
      this.register(this.polyCells, k, minX, minZ, maxX, maxZ);
    }
  }

  private register(into: Map<number, number[]>, k: number, x0: number, z0: number, x1: number, z1: number) {
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
      for (let z = Math.floor(z0 / CELL); z <= Math.floor(z1 / CELL); z++) {
        const key = cellKey(x, z);
        const a = into.get(key);
        if (a) a.push(k); else into.set(key, [k]);
      }
    }
  }

  /** True when (x, z) is on a road surface, `margin` metres in from its edge (negative: that far beyond it). */
  contains(x: number, z: number, margin = 0): boolean {
    const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    for (const k of this.cells.get(key) ?? []) {
      const s = this.segs[k];
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if (Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) <= s.half - margin) return true;
    }
    for (const k of this.polyCells.get(key) ?? []) {
      const p = this.polys[k];
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      let inside = false;
      for (let i = 0, j = p.ring.length - 1; i < p.ring.length; j = i++) {
        const [xi, zi] = p.ring[i];
        const [xj, zj] = p.ring[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }
}

/** The road masks of a streamed city's tiles, asked together (each tile adds and drops its own). */
export class RoadMaskSet {
  private readonly parts = new Map<string, RoadMask>();

  add(key: string, roads: readonly RoadData[] = [], junctions?: JunctionsData) {
    this.parts.set(key, new RoadMask(roads, junctions));
  }

  remove(key: string) {
    this.parts.delete(key);
  }

  contains(x: number, z: number, margin = 0): boolean {
    for (const m of this.parts.values()) if (m.contains(x, z, margin)) return true;
    return false;
  }
}
