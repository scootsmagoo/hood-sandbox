/** The scenario points of a tile with how many people are at each, and a grid to find them by place. */
import type { ScenarioPoint, ScenariosData } from '../../shared/walk';
import { cellKey } from './graph';

const CELL = 32;

export class ScenarioIndex {
  readonly points: readonly ScenarioPoint[];
  readonly used: Int32Array;
  readonly cells = new Map<number, number[]>();

  constructor(data: ScenariosData | undefined) {
    this.points = data?.points ?? [];
    this.used = new Int32Array(this.points.length);
    this.points.forEach((p, i) => {
      const k = cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      const a = this.cells.get(k);
      if (a) a.push(i); else this.cells.set(k, [i]);
    });
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
  const spacing = p.type === 'bench' ? 0.7 : p.type === 'busstop' ? 1.1 : p.type === 'lawn' ? 1.6 : 0.95;
  const off = (slot - (n - 1) / 2) * spacing;
  // The right-hand side of someone facing yaw.
  const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  return { x: p.x + rx * off, z: p.z + rz * off, yaw: p.yaw };
}
