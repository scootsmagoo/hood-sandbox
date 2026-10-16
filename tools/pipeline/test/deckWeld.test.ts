import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../src/mesh/builder';
import { weldDeckTops, type WeldSegment } from '../src/world/deckWeld';
import type { V2 } from '../src/geo';

/** A straight deck segment along x from x0 to x1 at z, half width `half`, its top rising from h0 to h1. */
function seg(piece: number, rank: number, x0: number, x1: number, z: number, half: number, h0: number, h1: number): WeldSegment {
  const a: V2 = [x0, z], b: V2 = [x1, z];
  // ribbonEdges: right = p + n * half with n = (-dz, dx) / l, so for +x the right edge is +z
  return { piece, rank, a, b, half, l0: [x0, z - half], r0: [x0, z + half], l1: [x1, z - half], r1: [x1, z + half], hl0: h0, hr0: h0, hl1: h1, hr1: h1 };
}

function triangles(col: MeshBuilder) {
  const P = col.positions, I = col.indices;
  const out: { ys: number[]; x: number; z: number }[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const ys = [I[t], I[t + 1], I[t + 2]].map((v) => P[v * 3 + 1]);
    out.push({ ys, x: (P[I[t] * 3] + P[I[t + 1] * 3] + P[I[t + 2] * 3]) / 3, z: (P[I[t] * 3 + 2] + P[I[t + 1] * 3 + 2] + P[I[t + 2] * 3 + 2]) / 3 });
  }
  return out;
}

describe('deck weld', () => {
  it('welds two decks that meet at one height into one surface', () => {
    const col = new MeshBuilder();
    const st = weldDeckTops(col, [seg(1, 100, -20, 0, 0, 5, 1, 1), seg(2, 100, 0, 20, 0, 5, 1, 1)], [], 4, [-100, -100]);
    expect(st.levels).toBe(1);
    expect(st.triangles).toBeGreaterThan(20);
    for (const t of triangles(col)) for (const y of t.ys) expect(y).toBeCloseTo(1, 5);
  });

  it('keeps a ramp that runs on beside a viaduct a metre lower apart from it: no triangle spans the two', () => {
    // the viaduct (z 0, half 6) level at 2; the ramp starts on it at 2 (one level with it there) and runs on beside it,
    // touching it, dropping to 1 m lower
    const viaduct = [seg(1, 500, -40, 0, 0, 6, 2, 2), seg(1, 500, 0, 40, 0, 6, 2, 2)];
    const ramp = [seg(2, 300, -40, -20, 4, 4, 2, 2), seg(2, 300, -20, 0, 10, 4, 2, 1.5), seg(2, 300, 0, 40, 10, 4, 1.5, 1)];
    const col = new MeshBuilder();
    weldDeckTops(col, [...viaduct, ...ramp], [], 4, [-100, -100]);
    for (const t of triangles(col)) expect(Math.max(...t.ys) - Math.min(...t.ys)).toBeLessThan(0.45);
    // and both are still there where they run side by side
    const at = (x: number, z: number) => triangles(col).filter((t) => Math.abs(t.x - x) < 2.5 && Math.abs(t.z - z) < 2.5);
    expect(at(30, 0).length).toBeGreaterThan(0);
    expect(at(30, 10).length).toBeGreaterThan(0);
  });

  it('splits two carriageways that overlap at different heights between them, each keeping its own side', () => {
    // two parallel decks drawn 2 m too wide: they overlap between z 4 and 6, 1 m apart in height
    const col = new MeshBuilder();
    const st = weldDeckTops(col, [seg(1, 500, -30, 30, 0, 6, 3, 3), seg(2, 200, -30, 30, 10, 6, 2, 2)], [], 4, [-100, -100]);
    expect(st.clashes).toBe(1);
    for (const t of triangles(col)) {
      const y = t.ys[0];
      // the higher one never reaches past the middle of the overlap (z 5) nor the lower one short of it
      if (Math.abs(y - 3) < 0.01) expect(t.z).toBeLessThan(5.01);
      if (Math.abs(y - 2) < 0.01) expect(t.z).toBeGreaterThan(4.99);
    }
  });
});
