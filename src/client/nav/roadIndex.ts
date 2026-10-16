/**
 * "The nearest road to here": the waypoint snaps to a road centreline from `roads.json`, and a street name for a point comes from the
 * same index. Tiles are added and dropped as the map loads them. Pure: no DOM, no three.js.
 */
import type { RoadData } from '../../shared/tile';
import { cellKey, gridSegment } from './geom';

const CELL = 64;

export interface RoadHit {
  x: number;
  y: number;
  z: number;
  dist: number;
  road: RoadData;
}

/** Roads a click should not snap to (service lots and the like are fine to drive to, but a click near a street means the street). */
const LOW_PRIORITY = new Set(['service', 'track', 'busway', 'path']);

export class RoadIndex {
  private readonly tiles = new Map<string, { roads: RoadData[]; keys: number[]; owners: Set<string> }>();
  private readonly grid = new Map<number, RoadData[]>();

  has(id: string): boolean {
    return this.tiles.has(id);
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /**
   * Adds a tile's roads for `owner` (the GPS and the map each load tiles and drop them on their own schedule): the roads stay
   * until every owner has dropped the tile. Setting a tile again for the same owner changes nothing.
   */
  setTile(id: string, roads: RoadData[], owner = '') {
    const have = this.tiles.get(id);
    if (have) {
      have.owners.add(owner);
      return;
    }
    const keys: number[] = [];
    for (const r of roads) {
      const p = r.points;
      for (let i = 0; i < p.length - 1; i++) {
        gridSegment(CELL, p[i][0], p[i][2], p[i + 1][0], p[i + 1][2], (k) => {
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          if (l[l.length - 1] !== r) {
            l.push(r);
            keys.push(k);
          }
        });
      }
    }
    this.tiles.set(id, { roads, keys, owners: new Set([owner]) });
  }

  /** `owner` no longer needs the tile; it goes when nobody does. */
  dropTile(id: string, owner = '') {
    const t = this.tiles.get(id);
    if (!t) return;
    t.owners.delete(owner);
    if (t.owners.size > 0) return;
    const gone = new Set(t.roads);
    for (const k of new Set(t.keys)) {
      const l = this.grid.get(k);
      if (!l) continue;
      const rest = l.filter((r) => !gone.has(r));
      if (rest.length) this.grid.set(k, rest);
      else this.grid.delete(k);
    }
    this.tiles.delete(id);
  }

  /**
   * The nearest road centreline point within `maxD` of (x, z). A street beats a service road unless the service road is clearly
   * closer (more than 6 m nearer), so a click between a lane and an avenue picks the avenue.
   */
  nearest(x: number, z: number, maxD: number): RoadHit | null {
    const c0x = Math.floor((x - maxD) / CELL), c1x = Math.floor((x + maxD) / CELL);
    const c0z = Math.floor((z - maxD) / CELL), c1z = Math.floor((z + maxD) / CELL);
    let best: RoadHit | null = null;
    let bestScore = Infinity;
    const seen = new Set<RoadData>();
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const l = this.grid.get(cellKey(cx, cz));
        if (!l) continue;
        for (const r of l) {
          if (seen.has(r)) continue;
          seen.add(r);
          const p = r.points;
          for (let i = 0; i < p.length - 1; i++) {
            const ax = p[i][0], az = p[i][2];
            const dx = p[i + 1][0] - ax, dz = p[i + 1][2] - az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t, pz = az + dz * t;
            const d = Math.hypot(px - x, pz - z);
            if (d > maxD) continue;
            const score = d + (LOW_PRIORITY.has(r.class) ? 6 : 0) + (r.bridge ? 0.5 : 0);
            if (score < bestScore) {
              bestScore = score;
              best = { x: px, y: p[i][1] + (p[i + 1][1] - p[i][1]) * t, z: pz, dist: d, road: r };
            }
          }
        }
      }
    }
    return best;
  }

  /** The name of the nearest named road within `maxD` ('' when none). */
  nameAt(x: number, z: number, maxD = 30): string {
    const h = this.nearest(x, z, maxD);
    return h?.road.name ?? '';
  }
}
