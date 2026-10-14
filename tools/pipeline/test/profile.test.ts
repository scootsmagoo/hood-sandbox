import { describe, expect, it } from 'vitest';
import { carveTerrain, makeHeightmap, surfaceHeight } from '../src/world/terrain';
import { solveProfiles } from '../src/world/profile';
import type { V2 } from '../src/geo';

/** A straight road along x from -half to half, a node every 5 m. */
function road(half: number, id0: number, z = 0, grade = 0.1): { nodeIds: number[]; pts: V2[]; maxGrade: number } {
  const pts: V2[] = [];
  const nodeIds: number[] = [];
  for (let x = -half, i = 0; x <= half; x += 5, i++) { pts.push([x, z]); nodeIds.push(id0 + i); }
  return { nodeIds, pts, maxGrade: grade };
}

const maxGradeOf = (pts: V2[], h: number[]) => {
  let g = 0;
  for (let i = 1; i < pts.length; i++) g = Math.max(g, Math.abs(h[i] - h[i - 1]) / Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return g;
};

describe('road profiles', () => {
  it('follows gentle terrain and bridges nothing', () => {
    const w = road(150, 1);
    const r = solveProfiles([w], { terrain: (x) => 0.04 * x + 0.3 * Math.sin(x / 40) });
    expect(r.decks.length).toBe(0);
    for (let i = 0; i < w.pts.length; i++) expect(Math.abs(r.h[0][i] - r.t[0][i])).toBeLessThan(0.35);
    expect(r.stats.maxGradeExcess).toBeLessThan(1e-3);
  });

  it('bridges a narrow cut instead of draping the road into it', () => {
    // a freeway cut: 3.5 m deep and 16 m wide across the road, like Auburn Avenue
    const terrain = (x: number) => (Math.abs(x) < 8 ? -3.5 : 0);
    const w = road(150, 1);
    const r = solveProfiles([w], { terrain, deckFill: 2 });
    const i0 = w.pts.findIndex((p) => p[0] === 0);
    // the road crosses at about the height of the rims, not at the bottom of the cut
    expect(r.h[0][i0]).toBeGreaterThan(-0.8);
    expect(r.decks.length).toBe(1);
    const d = r.decks[0];
    expect(w.pts[d.from][0]).toBeLessThan(-5);
    expect(w.pts[d.to][0]).toBeGreaterThan(5);
    expect(maxGradeOf(w.pts, r.h[0])).toBeLessThanOrEqual(0.1 + 1e-3);
  });

  it('leaves a shallow dip as an embankment, not a bridge', () => {
    const terrain = (x: number) => (Math.abs(x) < 8 ? -1.5 : 0);
    const r = solveProfiles([road(150, 1)], { terrain });
    expect(r.decks.length).toBe(0);
  });

  it('limits the grade where the terrain has a cliff', () => {
    const w = road(200, 1, 0, 0.08);
    const r = solveProfiles([w], { terrain: (x) => (x < 0 ? 0 : 9) });
    expect(maxGradeOf(w.pts, r.h[0])).toBeLessThanOrEqual(0.08 + 1e-3);
    // it still ends up near the terrain on both far sides
    expect(Math.abs(r.h[0][0])).toBeLessThan(1);
    expect(Math.abs(r.h[0][w.pts.length - 1] - 9)).toBeLessThan(1);
  });

  it('gives roads that meet at a node the same height there', () => {
    const a = road(100, 1);
    const b = { nodeIds: [1000, 1001, a.nodeIds[20], 1003, 1004], pts: [[0, -40], [0, -20], a.pts[20], [0, 20], [0, 40]] as V2[], maxGrade: 0.1 };
    const r = solveProfiles([a, b], { terrain: (x, z) => 0.05 * z + 0.02 * x });
    expect(r.h[0][20]).toBe(r.h[1][2]);
  });

  it('uses the strictest grade of the roads that share a graph', () => {
    const w = road(120, 1, 0, 0.05);
    const r = solveProfiles([w], { terrain: (x) => 0.2 * x });
    expect(maxGradeOf(w.pts, r.h[0])).toBeLessThanOrEqual(0.05 + 1e-3);
  });
});

describe('cut and fill', () => {
  it('sets the ground to the road height across the road and blends out', () => {
    const hm = makeHeightmap(101, 101, 4, -200, -200);
    for (let r = 0; r < hm.rows; r++) for (let c = 0; c < hm.cols; c++) hm.data[r * hm.cols + c] = 0.2 * (c * 4 - 200) * 0.05 + 1.5 * Math.sin(r / 5);
    const before = Float32Array.from(hm.data);
    const stats = carveTerrain(hm, [{ a: [-150, 0], b: [150, 0], ha: 2, hb: 5, halfWidth: 4 }]);
    expect(stats.vertices).toBeGreaterThan(100);
    for (const x of [-100, 0, 100]) {
      for (const z of [-4, 0, 4]) expect(surfaceHeight(hm, x, z)).toBeCloseTo(2 + ((x + 150) / 300) * 3, 0);
    }
    // far from the road nothing moved
    const far = (100 + 40) * hm.cols + 50;
    expect(hm.data[far]).toBe(before[far]);
  });

  it('weights a road by how close the vertex is to its own centreline', () => {
    const hm = makeHeightmap(61, 61, 4, -120, -120);
    carveTerrain(hm, [
      { a: [-100, -1], b: [100, -1], ha: 0, hb: 0, halfWidth: 8 },
      { a: [0, 2], b: [0, 100], ha: 3, hb: 3, halfWidth: 1.5 },
    ]);
    // on the side street's own centreline the side street wins
    expect(surfaceHeight(hm, 0, 40)).toBeGreaterThan(2.5);
    // on the boulevard far from the side street it is the boulevard's
    expect(surfaceHeight(hm, 60, -1)).toBeCloseTo(0, 1);
  });
});
