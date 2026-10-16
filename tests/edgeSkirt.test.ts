import { describe, expect, it } from 'vitest';
import { buildEdge, EdgeSampler, farBlocks, skirtGeometry, skirtHeight, SKIRT_REACH, type Bounds } from '../src/world/edgeSkirt';

const B: Bounds = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };

/** A sampler fed a tilted tile: the ground rises toward +x and falls toward +z, so every side has its own heights. */
function sampler(): EdgeSampler {
  const s = new EdgeSampler(B);
  for (let x = -1000; x <= 1000; x += 4) {
    for (const z of [-1000, -999, 999, 1000, 0]) s.add(x, -5 + x * 0.004 - z * 0.002, z, 0.4, 0.42, 0.38);
  }
  for (let z = -1000; z <= 1000; z += 4) {
    for (const x of [-1000, -999, 999, 1000]) s.add(x, -5 + x * 0.004 - z * 0.002, z, 0.4, 0.42, 0.38);
  }
  return s;
}

describe('the edge of a single tile', () => {
  it('carries the edge heights outward, flush at the edge and sinking toward the horizon', () => {
    const p = sampler().profile();
    for (const z of [-900, -123, 0, 640]) {
      const edge = -5 + -1000 * 0.004 - z * 0.002;
      expect(skirtHeight(p, B, -1000, z)).toBeCloseTo(edge, 1);
      expect(skirtHeight(p, B, -1000.5, z)).toBeCloseTo(edge, 0);
      expect(skirtHeight(p, B, -1000 - SKIRT_REACH, z)).toBeLessThan(edge - 20);
      expect(skirtHeight(p, B, -1000 - SKIRT_REACH, z)).toBeGreaterThan(edge - 40);
    }
    // a corner is where the two sides' heights meet
    const corner = skirtHeight(p, B, -1000, -1000);
    expect(corner).toBeCloseTo(-5 - 4 + 2, 1);
  });

  it('covers everything round the tile and nothing inside it', () => {
    const p = sampler().profile();
    const g = skirtGeometry(p, B);
    expect(g.indices.length).toBeGreaterThan(300);
    expect(g.indices.length / 3).toBeLessThan(4000);
    const at = (i: number) => [g.positions[i * 3], g.positions[i * 3 + 2]] as const;
    for (let t = 0; t < g.indices.length; t += 3) {
      const a = at(g.indices[t]), b = at(g.indices[t + 1]), c = at(g.indices[t + 2]);
      const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[1] + b[1] + c[1]) / 3;
      expect(cx > B.minX && cx < B.maxX && cz > B.minZ && cz < B.maxZ).toBe(false);
    }
    // it reaches the far ends
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3) { minX = Math.min(minX, g.positions[i]); maxX = Math.max(maxX, g.positions[i]); }
    expect(minX).toBe(B.minX - SKIRT_REACH);
    expect(maxX).toBe(B.maxX + SKIRT_REACH);
  });

  it('puts the skyline outside the tile, out of the footprints of heroes, the same every time, taller to the north', () => {
    const stadium: [number, number][] = [[-1174, -253], [-873, -253], [-873, 3], [-1174, 3]];
    const a = farBlocks(B, [stadium]);
    const b = farBlocks(B, [stadium]);
    expect(a.length).toBeGreaterThan(300);
    expect(a.length).toBeLessThan(2500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const k of a) {
      expect(k.x > B.minX - 21 && k.x < B.maxX + 21 && k.z > B.minZ - 21 && k.z < B.maxZ + 21 && k.x > B.minX && k.x < B.maxX && k.z > B.minZ && k.z < B.maxZ).toBe(false);
      expect(k.x > -1174 && k.x < -873 && k.z > -253 && k.z < 3).toBe(false);
    }
    const tallest = (f: (k: { x: number; z: number }) => boolean) => Math.max(...a.filter(f).map((k) => k.h));
    expect(tallest((k) => k.z < -1500)).toBeGreaterThan(tallest((k) => k.z > 1500));
    // and none of it is made when the edge could not be read
    expect(buildEdge(new EdgeSampler(B), B, [])).toBeNull();
  });
});
