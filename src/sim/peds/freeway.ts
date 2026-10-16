/**
 * Where the freeway is: the carriageways of the motorways and trunk roads (and their ramps) from `roads.json`, with their half widths and
 * heights. Nobody walks on an interstate: the walk network is cut where it runs along or across one (the pipeline does it at the bake;
 * this mask does it again at load, for a tile baked before that), nobody is made on it, and anyone who gets onto it (a runner fleeing over
 * open ground) is steered off it or removed when nobody is looking. A walker on a bridge over the freeway, or in a cutting under one, is
 * at another height and not on it.
 */
import type { RoadData } from '../../shared/tile';
import { cellKey } from './graph';

const CELL = 32;
/** A walker this far above or below the carriageway's surface is on a bridge over it or under it, not on it. */
export const FREEWAY_LEVEL = 3.2;

/** 0 not a freeway road, 1 a motorway or trunk carriageway, 2 a ramp (a link road of those). */
export function freewayClass(cls: string): 0 | 1 | 2 {
  if (cls === 'motorway' || cls === 'trunk') return 1;
  if (cls === 'motorway_link' || cls === 'trunk_link') return 2;
  return 0;
}

interface Seg {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  half: number;
  cls: 1 | 2;
}

export interface FreewayHit {
  cls: 1 | 2;
  /** Distance in from the carriageway's edge, m (positive: inside). */
  depth: number;
  /** The way out: a unit vector away from the centre line (across the carriageway). */
  nx: number;
  nz: number;
}

export class FreewayMask {
  private readonly parts = new Map<string, { segs: Seg[]; cells: Map<number, number[]> }>();

  constructor(roads?: readonly RoadData[]) {
    if (roads) this.add('', roads);
  }

  /** The carriageways of a tile's roads (a streamed city adds and drops its tiles). */
  add(key: string, roads: readonly RoadData[] = []) {
    const segs: Seg[] = [];
    const cells = new Map<number, number[]>();
    for (const r of roads) {
      const cls = freewayClass(r.class);
      if (!cls) continue;
      const half = r.width / 2;
      for (let i = 0; i + 1 < r.points.length; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const k = segs.length;
        segs.push({ ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], half, cls });
        for (let x = Math.floor((Math.min(a[0], b[0]) - half) / CELL); x <= Math.floor((Math.max(a[0], b[0]) + half) / CELL); x++) {
          for (let z = Math.floor((Math.min(a[2], b[2]) - half) / CELL); z <= Math.floor((Math.max(a[2], b[2]) + half) / CELL); z++) {
            const key2 = cellKey(x, z);
            const l = cells.get(key2);
            if (l) l.push(k); else cells.set(key2, [k]);
          }
        }
      }
    }
    if (segs.length) this.parts.set(key, { segs, cells });
    else this.parts.delete(key);
  }

  remove(key: string) {
    this.parts.delete(key);
  }

  get empty(): boolean {
    return this.parts.size === 0;
  }

  /**
   * The freeway carriageway under (x, z) at height `y` (any height when `y` is NaN), `margin` metres in from its edge, or null. A ramp
   * counts only `rampMargin` further in (the pavement of a junction where a ramp meets a street is not the ramp).
   */
  hit(x: number, z: number, y: number, margin = 0, rampMargin = 1.2): FreewayHit | null {
    const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    let best: FreewayHit | null = null;
    for (const part of this.parts.values()) {
      for (const k of part.cells.get(key) ?? []) {
        const s = part.segs[k];
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
        const px = s.ax + dx * t, pz = s.az + dz * t;
        const d = Math.hypot(x - px, z - pz);
        const depth = s.half - d;
        if (depth < margin + (s.cls === 2 ? rampMargin : 0)) continue;
        if (!Number.isNaN(y) && Math.abs(y - (s.ay + (s.by - s.ay) * t)) > FREEWAY_LEVEL) continue;
        if (best && best.depth >= depth) continue;
        let nx = d > 1e-3 ? (x - px) / d : 0, nz = d > 1e-3 ? (z - pz) / d : 0;
        if (d <= 1e-3) {
          const l = Math.sqrt(l2) || 1;
          nx = -dz / l;
          nz = dx / l;
        }
        best = { cls: s.cls, depth, nx, nz };
      }
    }
    return best;
  }

  /** Whether (x, z) at height `y` is on a motorway or trunk carriageway. */
  contains(x: number, z: number, y = NaN, margin = 0): boolean {
    return this.hit(x, z, y, margin) !== null;
  }
}
