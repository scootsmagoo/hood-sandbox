/** The scenario points of a tile with how many people are at each, and a grid to find them by place. */
import type { ScenarioPoint, ScenariosData } from '../../shared/walk';
import { cellKey } from './graph';

const CELL = 32;

/** A point of a dropped tile: nobody can use it (its cap is 0). */
const DEAD: ScenarioPoint = { id: '', type: 'plaza', x: NaN, y: 0, z: NaN, yaw: 0, cap: 0, src: 'synth' };

export class ScenarioIndex {
  readonly points: ScenarioPoint[] = [];
  used = new Int32Array(0);
  readonly cells = new Map<number, number[]>();
  /** A streamed city's tiles: the range of point ids each holds (docs/contracts/city-tiles.md). */
  private readonly tiles = new Map<string, { base: number; n: number }>();
  private readonly freeRanges: { base: number; n: number }[] = [];

  constructor(data: ScenariosData | undefined) {
    if (data) this.addTile('', data);
  }

  /** Adds a tile's points at ids that do not move while it is loaded. */
  addTile(key: string, data: ScenariosData) {
    const n = data.points.length;
    let base = this.points.length;
    const fi = this.freeRanges.findIndex((f) => f.n >= n);
    if (fi >= 0) {
      base = this.freeRanges[fi].base;
      this.freeRanges[fi].base += n;
      this.freeRanges[fi].n -= n;
      if (this.freeRanges[fi].n === 0) this.freeRanges.splice(fi, 1);
    }
    if (base + n > this.used.length) {
      const u = new Int32Array(Math.max(base + n, Math.ceil(this.used.length * 1.5)));
      u.set(this.used);
      this.used = u;
    }
    data.points.forEach((p, k) => {
      const i = base + k;
      this.points[i] = p;
      this.used[i] = 0;
      const key2 = cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      const a = this.cells.get(key2);
      if (a) a.push(i); else this.cells.set(key2, [i]);
    });
    this.tiles.set(key, { base, n });
  }

  /** Drops a tile's points (they stay in the arrays as unusable until reused). */
  removeTile(key: string) {
    const r = this.tiles.get(key);
    if (!r) return;
    this.tiles.delete(key);
    for (let i = r.base; i < r.base + r.n; i++) {
      const p = this.points[i];
      const k = cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      const a = this.cells.get(k);
      if (a) {
        const j = a.indexOf(i);
        if (j >= 0) a.splice(j, 1);
        if (a.length === 0) this.cells.delete(k);
      }
      this.points[i] = DEAD;
      this.used[i] = 0;
    }
    if (r.n > 0) this.freeRanges.push({ base: r.base, n: r.n });
  }

  free(i: number): number {
    return this.points[i].cap - this.used[i];
  }

  take(i: number, n: number) {
    this.used[i] += n;
  }

  release(i: number, n = 1) {
    this.used[i] = Math.max(0, this.used[i] - n);
  }

  /** Total people at scenario points (diagnostics). */
  get occupied(): number {
    let n = 0;
    for (const u of this.used) n += u;
    return n;
  }
}

/** Where person `slot` of `n` stands at a point, and which way they face. */
export function slotPosition(p: ScenarioPoint, slot: number, n: number, chat: boolean): { x: number; z: number; yaw: number } {
  if (chat && n > 1) {
    // A ring facing in, a little ahead of the point.
    const cx = p.x + Math.sin(p.yaw) * 0.7, cz = p.z + Math.cos(p.yaw) * 0.7;
    const a = p.yaw + Math.PI + (slot * Math.PI * 2) / n;
    const r = 0.5 + 0.18 * n;
    return { x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r, yaw: a + Math.PI };
  }
  const spacing = p.type === 'bench' ? 0.7 : p.type === 'seat' ? 0.62 : p.type === 'busstop' ? 1.1 : p.type === 'lawn' ? 1.6 : 0.95;
  const off = (slot - (n - 1) / 2) * spacing;
  // The right-hand side of someone facing yaw.
  const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  return { x: p.x + rx * off, z: p.z + rz * off, yaw: p.yaw };
}
