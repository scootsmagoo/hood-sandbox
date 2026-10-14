import { describe, expect, it } from 'vitest';
import { densifyWay, solveDecks } from '../src/world/decks';
import type { V2 } from '../src/geo';

const line = (x0: number, z0: number, x1: number, z1: number, step: number, id0: number): { pts: V2[]; nodeIds: number[] } => {
  const n = Math.round(Math.hypot(x1 - x0, z1 - z0) / step);
  const pts: V2[] = [];
  const nodeIds: number[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
    nodeIds.push(id0 + i);
  }
  return { pts, nodeIds };
};

describe('densify', () => {
  it('keeps original ids and adds unique synthetic ones', () => {
    const d = densifyWay({ pts: [[0, 0], [20, 0]] as V2[], nodeIds: [5, 6] }, 5);
    expect(d.pts.length).toBe(5);
    expect(d.nodeIds[0]).toBe(5);
    expect(d.nodeIds[4]).toBe(6);
    expect(new Set(d.nodeIds).size).toBe(5);
    expect(d.nodeIds.slice(1, 4).every((i) => i < 0)).toBe(true);
  });
});

describe('deck solver', () => {
  const flat = () => 0;
  it('pins ends that meet the ground and stays near the ground between them', () => {
    const w = line(0, 0, 100, 0, 5, 1000);
    const h = solveDecks([{ ...w, layer: 1 }], { groundAt: flat, groundNodeIds: new Set([1000, 1020]), groundRefs: [] })[0];
    expect(h[0]).toBeCloseTo(0.1, 2);
    expect(h[20]).toBeCloseTo(0.1, 2);
    expect(Math.max(...h)).toBeLessThan(0.5);
  });

  it('rises to clear a road underneath with a limited grade', () => {
    const w = line(-100, 0, 100, 0, 5, 1000);
    const under = line(0, -30, 0, 30, 5, 5000);
    const h = solveDecks([{ ...w, layer: 1 }], {
      groundAt: flat,
      groundNodeIds: new Set([1000, 1040]),
      groundRefs: [{ ...under, width: 8, layer: 0, clearance: 5 }],
    })[0];
    const mid = h[20];
    expect(mid).toBeGreaterThanOrEqual(5 + 1 + 0.1 - 1e-6);
    for (let i = 1; i < h.length; i++) expect(Math.abs(h[i] - h[i - 1]) / 5).toBeLessThan(0.11);
    expect(h[0]).toBeCloseTo(0.1, 2);
    expect(h[1]).toBeLessThan(mid);
  });

  it('floats at layer height when nothing ties it to the ground', () => {
    const w = line(0, 0, 50, 0, 5, 1);
    const h = solveDecks([{ ...w, layer: 2 }], { groundAt: (x) => x * 0.05, groundNodeIds: new Set(), groundRefs: [] })[0];
    expect(h[0]).toBeCloseTo(12, 0);
    expect(h[10]).toBeCloseTo(14.5, 0);
  });

  it('clears a lower deck by the clearance', () => {
    const low = line(-60, 0, 60, 0, 5, 100);
    const high = line(0, -60, 0, 60, 5, 500);
    const [hl, hh] = solveDecks(
      [{ ...low, layer: 1 }, { ...high, layer: 2 }],
      { groundAt: flat, groundNodeIds: new Set([100, 124, 500, 524]), groundRefs: [] },
    );
    expect(hh[12]).toBeGreaterThanOrEqual(hl[12] + 5 + 1 - 0.3);
  });
});
