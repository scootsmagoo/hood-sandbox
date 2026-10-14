import { describe, expect, it } from 'vitest';
import { buildGroundMesh, makeHeightmap, rasterizeAreas, surfaceHeight } from '../src/world/terrain';

function slopeMap() {
  const hm = makeHeightmap(5, 5, 4, -8, -8);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) hm.data[r * 5 + c] = c * 0.5 + r * 1; // plane: dy/dx = 0.125, dy/dz = 0.25
  return hm;
}

describe('heightmap', () => {
  it('samples a plane exactly anywhere', () => {
    const hm = slopeMap();
    for (const [x, z] of [[-8, -8], [0, 0], [3.3, -2.7], [7.9, 7.9]]) {
      expect(surfaceHeight(hm, x, z)).toBeCloseTo((x + 8) * 0.125 + (z + 8) * 0.25, 5);
    }
  });
  it('builds a ground mesh with upward normals and matching heights', () => {
    const hm = slopeMap();
    const land = new Uint8Array(25);
    const g = buildGroundMesh(hm, land, 1);
    expect(g.positions.length / 3).toBe(25);
    expect(g.indices.length).toBe(4 * 4 * 6);
    for (let i = 0; i < g.indices.length; i += 3) {
      const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
      const p = (n: number) => [g.positions[n * 3], g.positions[n * 3 + 1], g.positions[n * 3 + 2]];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      expect(ny).toBeGreaterThan(0);
    }
    const mid = (2 * 5 + 2) * 3;
    expect(g.normals[mid + 1]).toBeGreaterThan(0.9);
    expect(g.normals[mid]).toBeLessThan(0);
  });
  it('rasterizes polygons with holes', () => {
    const hm = makeHeightmap(11, 11, 2, -10, -10);
    const outer: [number, number][] = [[-8, -8], [8, -8], [8, 8], [-8, 8]];
    const hole: [number, number][] = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
    const land = rasterizeAreas([{ kind: 'park', rings: [outer, hole] }], hm);
    const at = (x: number, z: number) => land[((z + 10) / 2) * 11 + (x + 10) / 2];
    expect(at(-6, -6)).toBeGreaterThan(0);
    expect(at(0, 0)).toBe(0);
    expect(at(-10, -10)).toBe(0);
  });
});
