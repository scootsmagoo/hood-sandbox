import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../src/mesh/builder';
import { chunkOf, makeChunkGrid, splitMesh } from '../src/mesh/chunks';
import { buildGroundMesh, makeHeightmap } from '../src/world/terrain';

const bounds = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };

function triAt(mb: MeshBuilder, x: number, z: number) {
  const a = mb.vertex(x, 0, z, 0, 1, 0);
  const b = mb.vertex(x + 1, 0, z, 0, 1, 0);
  const c = mb.vertex(x, 0, z + 1, 0, 1, 0);
  mb.tri(a, b, c);
}

describe('chunk grid', () => {
  it('covers the bounds with whole squares and clamps strays', () => {
    const g = makeChunkGrid(bounds, 64);
    expect(g.cols).toBe(4); // 200 / 64 rounds up
    expect(chunkOf(g, -100, -100)).toEqual([0, 0]);
    expect(chunkOf(g, 100, 100)).toEqual([3, 3]);
    expect(chunkOf(g, 500, -500)).toEqual([3, 0]);
  });
  it('splits a mesh by triangle centroid and keeps every triangle', () => {
    const g = makeChunkGrid(bounds, 100);
    const mb = new MeshBuilder();
    triAt(mb, -50, -50);
    triAt(mb, 50, -50);
    triAt(mb, 50, 50);
    triAt(mb, 60, 60);
    const parts = splitMesh(mb, g);
    expect([...parts.keys()].sort()).toEqual([0, 1, 3]);
    expect(parts.get(3)!.triangleCount).toBe(2);
    let total = 0;
    for (const m of parts.values()) {
      total += m.triangleCount;
      for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
      expect(m.normals.length).toBe(m.positions.length);
      expect(m.colors.length).toBe(m.positions.length);
    }
    expect(total).toBe(4);
  });
});

describe('ground chunks', () => {
  const hm = makeHeightmap(17, 17, 4, -32, -32);
  for (let i = 0; i < hm.data.length; i++) hm.data[i] = Math.sin(i * 0.3);
  const land = new Uint8Array(17 * 17);
  it('builds a sub-range whose vertices line up with the whole mesh', () => {
    const whole = buildGroundMesh(hm, land, 1);
    const part = buildGroundMesh(hm, land, 1, { c0: 8, c1: 16, r0: 0, r1: 8 });
    expect(part.positions.length / 3).toBe(9 * 9);
    // vertex (row 3, col 10) of the whole mesh is vertex (3, 2) of the part
    const w = (3 * 17 + 10) * 3;
    const p = (3 * 9 + 2) * 3;
    for (let k = 0; k < 3; k++) {
      expect(part.positions[p + k]).toBeCloseTo(whole.positions[w + k], 6);
      expect(part.normals[p + k]).toBeCloseTo(whole.normals[w + k], 6);
    }
  });
  it('lowers the interior of a coarse level, adds a skirt and leaves the border on the terrain', () => {
    const flat = buildGroundMesh(hm, land, 4, undefined, {});
    const coarse = buildGroundMesh(hm, land, 4, undefined, { lower: 0.5, skirt: 3 });
    expect(flat.positions.length / 3).toBe(25);
    expect(coarse.positions.length / 3).toBe(25 + 2 * (5 + 5) - 4);
    expect(coarse.positions[(0 * 5 + 0) * 3 + 1]).toBeCloseTo(flat.positions[1], 6); // corner: on the terrain
    expect(coarse.positions[(2 * 5 + 2) * 3 + 1]).toBeCloseTo(flat.positions[(2 * 5 + 2) * 3 + 1] - 0.5, 6);
    // skirt vertices hang 3 m under the border
    const sk = 25 * 3 + 1;
    expect(coarse.positions[sk]).toBeCloseTo(flat.positions[1] - 3, 6);
    for (const i of coarse.indices) expect(i).toBeLessThan(coarse.positions.length / 3);
  });
});
