import { describe, expect, it } from 'vitest';
import { carveTerrain, lowerTerrainUnder, makeHeightmap, surfaceHeight } from '../src/world/terrain';
import { curveLimits, joinCurves, solveProfiles } from '../src/world/profile';
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

describe('decks in the profile', () => {
  it('designs a bridge with the roads it lands on: the deck climbs and the road under it dips to keep the clearance', () => {
    // a street along z at the terrain (0), a motorway along x whose middle (x -40..40) is a mapped bridge over it
    const street = { ...road(100, 1), pts: road(100, 1).pts.map((p) => [p[1], p[0]] as V2), maxGrade: 0.09 };
    const left = road(100, 100, 0, 0.06);
    const ids = left.nodeIds;
    const west = { nodeIds: ids.slice(0, 13), pts: left.pts.slice(0, 13), maxGrade: 0.06 };
    const deck = { nodeIds: ids.slice(12, 29), pts: left.pts.slice(12, 29), maxGrade: 0.06, deck: { target: left.pts.slice(12, 29).map(() => 0.3) } };
    const east = { nodeIds: ids.slice(28), pts: left.pts.slice(28), maxGrade: 0.06 };
    // every deck node over the street (x -10..10) against the street's nodes under the deck (z -10..10)
    const clearances = [];
    for (let i = 0; i < deck.pts.length; i++) {
      if (Math.abs(deck.pts[i][0]) > 10) continue;
      for (let k = 0; k < street.pts.length; k++) if (Math.abs(street.pts[k][1]) <= 10) clearances.push({ upper: [2, i] as [number, number], lower: [0, k] as [number, number], gap: 6.1 });
    }
    const r = solveProfiles([street, west, deck, east], { terrain: () => 0, clearances });
    const mid = deck.pts.findIndex((p) => p[0] === 0);
    const under = street.pts.findIndex((p) => p[1] === 0);
    expect(r.h[2][mid] - r.h[0][under]).toBeGreaterThan(6.0);
    // the street gave some of it (it dips), and the bridge's ends meet the approaches (shared nodes) within the grade
    expect(r.h[0][under]).toBeLessThan(-0.1);
    expect(r.h[2][0]).toBe(r.h[1][12]);
    for (const [w, h] of [[west, r.h[1]], [deck, r.h[2]], [east, r.h[3]]] as const) expect(maxGradeOf(w.pts, h)).toBeLessThanOrEqual(0.06 + 2e-3);
    expect(r.stats.clearanceShort).toBeLessThan(0.05);
  });

  it('holds a lesser road level with a greater one across the greater one\'s carriageway', () => {
    // a boulevard along x at the terrain (0); a service road from its middle node north up a 10% slope
    const blvd = { ...road(100, 1, 0, 0.08), halfWidth: 9, rank: 300 };
    const mid = blvd.pts.findIndex((p) => p[0] === 0);
    const svc = { nodeIds: [blvd.nodeIds[mid], 501, 502, 503, 504, 505, 506], pts: [[0, 0], [0, 5], [0, 10], [0, 15], [0, 20], [0, 25], [0, 30]] as V2[], maxGrade: 0.12, halfWidth: 2.5, rank: 0 };
    const r = solveProfiles([blvd, svc], { terrain: (_x, z) => Math.max(0, 0.1 * z) });
    // the service road's first node over the boulevard (5 m out, inside its 9 m half width) is level with it
    expect(Math.abs(r.h[1][1] - r.h[0][mid])).toBeLessThan(0.06);
    expect(r.h[1][4]).toBeGreaterThan(r.h[1][1] + 0.5);
  });

  it('keeps vertical curves across the node where one way ends and the next carries on', () => {
    const a = road(50, 1);
    const b = { nodeIds: [a.nodeIds[a.nodeIds.length - 1], 501, 502], pts: [a.pts[a.pts.length - 1], [55, 0], [60, 0]] as V2[], maxGrade: 0.1 };
    const curves = joinCurves([{ ...a, speed: 50 }, { ...b, speed: 50 }], [a.nodeIds.map((_, i) => i), [a.nodeIds.length - 1, a.nodeIds.length, a.nodeIds.length + 1]], [...a.pts.map((p) => p[0]), 55, 60], [...a.pts.map(() => 0), 0, 0]);
    expect(curves.length).toBe(1);
    expect(curves[0].b).toBe(a.nodeIds.length - 1);
    expect(curves[0].crest).toBeCloseTo(curveLimits(50).crest);
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

  it('follows the carriageway a vertex lies well inside, not a narrower road whose centreline is nearer', () => {
    const hm = makeHeightmap(61, 61, 4, -120, -120);
    // a 24 m motorway at 0 and a ramp at 1.5 m whose centreline is 14 m off the motorway's: a vertex 10 m out on the motorway
    carveTerrain(hm, [
      { a: [-100, 0], b: [100, 0], ha: 0, hb: 0, halfWidth: 12 },
      { a: [-100, 14], b: [100, 14], ha: 1.5, hb: 1.5, halfWidth: 2 },
    ]);
    expect(surfaceHeight(hm, 0, 8)).toBeLessThan(0.3);
  });

  it('digs out the ground over a deck but not a carriageway beside it, nor the abutment a deck lands on', () => {
    const hm = makeHeightmap(61, 61, 4, -120, -120);
    hm.data.fill(2);
    const keep = (x: number, z: number) => z > 9 && z < 16;
    lowerTerrainUnder(hm, [{ a: [-60, 0], b: [60, 0], ya: 0, yb: 0, halfWidth: 6, endA: true }], 1.3, 1.5, 3, 0.15, keep);
    expect(surfaceHeight(hm, 0, 0)).toBeLessThan(-1);
    expect(surfaceHeight(hm, 0, 12)).toBe(2);
    // within 4.5 m of the landing end the ground is the abutment
    expect(surfaceHeight(hm, -58, 0)).toBe(2);
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
