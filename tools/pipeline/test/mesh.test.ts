import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../src/mesh/builder';
import { addOrientedBox, extrudeFootprint, orientRings } from '../src/mesh/extrude';
import { dedupe, pointAlong, ribbonEdges, ribbonIndices } from '../src/mesh/ribbon';
import type { V2 } from '../src/geo';

function triNormals(mb: MeshBuilder): { n: [number, number, number]; c: [number, number, number]; area: number }[] {
  const out = [];
  const p = mb.positions;
  for (let i = 0; i < mb.indices.length; i += 3) {
    const [a, b, c] = [mb.indices[i], mb.indices[i + 1], mb.indices[i + 2]];
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const e1 = [p[b * 3] - ax, p[b * 3 + 1] - ay, p[b * 3 + 2] - az];
    const e2 = [p[c * 3] - ax, p[c * 3 + 1] - ay, p[c * 3 + 2] - az];
    const n: [number, number, number] = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    out.push({
      n: [n[0] / len, n[1] / len, n[2] / len] as [number, number, number],
      c: [(ax + p[b * 3] + p[c * 3]) / 3, (ay + p[b * 3 + 1] + p[c * 3 + 1]) / 3, (az + p[b * 3 + 2] + p[c * 3 + 2]) / 3] as [number, number, number],
      area: len / 2,
    });
  }
  return out;
}

describe('ribbon', () => {
  it('puts right on the east side when travelling north', () => {
    const e = ribbonEdges([[0, 0], [0, -10]], 2);
    expect(e.right[0][0]).toBeCloseTo(2);
    expect(e.left[0][0]).toBeCloseTo(-2);
  });
  it('widens at a right-angle mitre but respects the limit', () => {
    const e = ribbonEdges([[0, 0], [10, 0], [10, 10]], 2);
    expect(Math.hypot(e.left[1][0] - e.right[1][0], e.left[1][1] - e.right[1][1])).toBeCloseTo(2 * 2 * Math.SQRT2, 5);
    const sharp = ribbonEdges([[0, 0], [10, 0], [0.5, 0.1]], 2, 2);
    expect(Math.hypot(sharp.left[1][0] - sharp.right[1][0], sharp.left[1][1] - sharp.right[1][1])).toBeLessThanOrEqual(2 * 2 * 2 + 1e-6);
  });
  it('builds upward facing triangles', () => {
    const pts: V2[] = [[0, 0], [0, -5], [3, -10], [10, -12]];
    const { left, right } = ribbonEdges(pts, 1.5);
    const mb = new MeshBuilder();
    for (let i = 0; i < pts.length; i++) {
      mb.vertex(left[i][0], 0, left[i][1], 0, 1, 0);
      mb.vertex(right[i][0], 0, right[i][1], 0, 1, 0);
    }
    mb.indices.push(...ribbonIndices(pts.length));
    expect(mb.triangleCount).toBe(6);
    for (const t of triNormals(mb)) expect(t.n[1]).toBeGreaterThan(0.99);
    const flipped = new MeshBuilder();
    flipped.positions = mb.positions;
    flipped.indices = ribbonIndices(pts.length, 0, true);
    for (const t of triNormals(flipped)) expect(t.n[1]).toBeLessThan(-0.99);
  });
  it('dedupes and walks along a line', () => {
    expect(dedupe([[0, 0], [0, 0], [1, 0]]).length).toBe(2);
    const { p, dir } = pointAlong([[0, 0], [10, 0], [10, 10]], 15);
    expect(p).toEqual([10, 5]);
    expect(dir).toEqual([0, 1]);
  });
});

describe('extrusion', () => {
  const sq: V2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole: V2[] = [[3, 3], [7, 3], [7, 7], [3, 7]];

  it('orients outer rings CCW and holes CW', () => {
    const [o, h] = orientRings([sq, hole]);
    const area = (r: V2[]) => r.reduce((a, p, i) => a + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]), 0) / 2;
    expect(area(o)).toBeGreaterThan(0);
    expect(area(h)).toBeLessThan(0);
  });

  it('wall normals point away from the solid and roofs face up', () => {
    for (const ring of [sq, [...sq].reverse()]) {
      const wall = new MeshBuilder();
      const roof = new MeshBuilder();
      extrudeFootprint([ring], { baseY: 0, topY: 12, wall, roof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
      expect(wall.triangleCount).toBe(8);
      expect(roof.triangleCount).toBe(2);
      for (const t of triNormals(wall)) {
        // vector from the footprint centre to the triangle centroid must agree with the geometric normal
        const out = (t.c[0] - 5) * t.n[0] + (t.c[2] - 5) * t.n[2];
        expect(out).toBeGreaterThan(4);
        expect(Math.abs(t.n[1])).toBeLessThan(1e-9);
      }
      for (const t of triNormals(roof)) expect(t.n[1]).toBeGreaterThan(0.99);
      const area = triNormals(roof).reduce((a, t) => a + t.area, 0);
      expect(area).toBeCloseTo(100);
    }
  });

  it('cuts courtyards out of the roof and faces the hole walls inward', () => {
    const wall = new MeshBuilder();
    const roof = new MeshBuilder();
    extrudeFootprint([sq, hole], { baseY: 0, topY: 5, wall, roof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    expect(triNormals(roof).reduce((a, t) => a + t.area, 0)).toBeCloseTo(100 - 16);
    const holeWalls = triNormals(wall).filter((t) => Math.abs(t.c[0] - 5) < 2.5 && Math.abs(t.c[2] - 5) < 2.5);
    expect(holeWalls.length).toBe(8);
    for (const t of holeWalls) expect((t.c[0] - 5) * t.n[0] + (t.c[2] - 5) * t.n[2]).toBeLessThan(0);
  });

  it('builds a closed oriented box', () => {
    const mb = new MeshBuilder();
    addOrientedBox(mb, 0, 0, 0, 4, [0.6, 0.8], 3, 1);
    expect(mb.triangleCount).toBe(12);
    for (const t of triNormals(mb)) {
      const out = t.c[0] * t.n[0] + (t.c[1] - 2) * t.n[1] + t.c[2] * t.n[2];
      expect(out).toBeGreaterThan(0.9);
    }
  });
});
