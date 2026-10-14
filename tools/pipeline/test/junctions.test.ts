import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../src/mesh/builder';
import { addJunctionMesh, buildJunctions, isSimple, polygonArea, trimKey, trimPolyline, type JunctionWayInput } from '../src/world/junctions';
import type { V2 } from '../src/geo';

function way(id: number, pts: V2[], nodeIds: number[], width = 8, highway = 'residential', extra: Partial<JunctionWayInput['way']> = {}): JunctionWayInput {
  return { way: { id, name: '', highway, kind: 'car', lanes: 2, oneway: false, width, layer: 0, bridge: false, nodeIds, pts, ...extra }, pts, nodeIds };
}
const EW = (z = 0, ids = [101, 102, 1, 103, 104], w = 8) => way(1, [[-30, z], [-15, z], [0, z], [15, z], [30, z]], ids, w);
const NS = (x = 0, ids = [201, 202, 1, 203, 204], w = 8) => way(2, [[x, -30], [x, -15], [x, 0], [x, 15], [x, 30]], ids, w);

describe('junction polygons', () => {
  it('builds a rounded square at a crossroads and cuts every leg back to it', () => {
    const r = buildJunctions([EW(), NS()]);
    expect(r.junctions.length).toBe(1);
    const j = r.junctions[0];
    expect(j.legs.length).toBe(4);
    expect(isSimple(j.polygon)).toBe(true);
    // 8 m roads: a plus of arms 8.5 m long (4 m of road to the corner, 4.5 m curb radius), corners filled
    expect(Math.abs(polygonArea(j.polygon))).toBeGreaterThan(215);
    expect(Math.abs(polygonArea(j.polygon))).toBeLessThan(240);
    for (const l of j.legs) expect(l.trim).toBeCloseTo(8.5, 1);
    // the cut is recorded for each leg of each way
    expect(r.trims.get(trimKey(0, 2, -1))).toBeCloseTo(8.5, 1);
    expect(r.trims.get(trimKey(0, 2, 1))).toBeCloseTo(8.5, 1);
    expect(r.trims.get(trimKey(1, 2, 1))).toBeCloseTo(8.5, 1);
    expect(r.junctionAt.get(1)).toBe(0);
  });

  it('handles a T junction and cuts the side street further back for a wide main road', () => {
    const main = way(1, [[-30, 0], [-15, 0], [0, 0], [15, 0], [30, 0]], [101, 102, 1, 103, 104], 16, 'primary');
    const side = way(3, [[0, 0], [0, 15], [0, 30]], [1, 303, 304], 7);
    const r = buildJunctions([main, side]);
    expect(r.junctions.length).toBe(1);
    const j = r.junctions[0];
    expect(j.legs.length).toBe(3);
    const sideLeg = j.legs.find((l) => l.d[1] > 0.9)!;
    expect(sideLeg.trim).toBeGreaterThan(8); // main road half width (8) plus the curb return
    expect(isSimple(j.polygon)).toBe(true);
  });

  it('does not make a polygon where only two roads join, or at a roundabout, or a motorway merge, or a Y', () => {
    expect(buildJunctions([way(1, [[-30, 0], [0, 0]], [101, 1]), way(2, [[0, 0], [30, 0]], [1, 202])]).junctions.length).toBe(0);
    expect(buildJunctions([EW(), NS()].map((w, i) => (i === 0 ? { ...w, way: { ...w.way, roundabout: true } } : w))).junctions.length).toBe(0);
    const mw = (id: number, pts: V2[], ids: number[]) => way(id, pts, ids, 12, 'motorway_link');
    expect(buildJunctions([mw(1, [[-30, 0], [0, 0]], [101, 1]), mw(2, [[0, 0], [30, 0]], [1, 202]), mw(3, [[0, 0], [30, 10]], [1, 303])]).junctions.length).toBe(0);
    // a Y whose arms leave 12 degrees apart
    const a = 12 * Math.PI / 180;
    const y = buildJunctions([way(1, [[-30, 0], [0, 0]], [101, 1]), way(2, [[0, 0], [30, 0]], [1, 202]), way(3, [[0, 0], [30 * Math.cos(a), 30 * Math.sin(a)]], [1, 303])]);
    expect(y.junctions.length).toBe(0);
    expect(y.stats.rejected['legs closer than 17 degrees']).toBe(1);
  });

  it('merges nodes that are a few metres apart (a staggered crossing) into one junction', () => {
    const ew = way(1, [[-40, 0], [-20, 0], [0, 0], [6, 0], [20, 0], [40, 0]], [101, 102, 1, 2, 103, 104]);
    const n = way(2, [[0, -40], [0, -20], [0, 0], [0, 20]], [201, 202, 1, 203]);
    const s = way(3, [[6, 0], [6, 20], [6, 40]], [2, 303, 304]);
    const r = buildJunctions([ew, n, s]);
    expect(r.junctions.length).toBe(1);
    expect(r.junctions[0].nodeIds.sort()).toEqual([1, 2]);
    expect(r.junctions[0].legs.length).toBe(5);
    // the road between the two nodes is inner: both of its nodes belong to the junction
    expect(r.junctionAt.get(1)).toBe(r.junctionAt.get(2));
  });

  it('meshes the polygon with upward faces on the ground', () => {
    const j = buildJunctions([EW(), NS()]).junctions[0];
    const mb = new MeshBuilder();
    const tris = addJunctionMesh(mb, j, (x) => 0.1 * x, [0.2, 0.2, 0.2], 0.08);
    expect(tris).toBeGreaterThan(30);
    for (let t = 0; t < mb.indices.length; t += 3) {
      const [a, b, c] = [mb.indices[t], mb.indices[t + 1], mb.indices[t + 2]];
      const p = mb.positions;
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const wx = p[c * 3] - p[a * 3], wy = p[c * 3 + 1] - p[a * 3 + 1], wz = p[c * 3 + 2] - p[a * 3 + 2];
      const ny = uz * wx - ux * wz;
      expect(ny).toBeGreaterThan(0);
      void uy; void wy;
    }
    for (let i = 0; i < mb.vertexCount; i++) expect(mb.positions[i * 3 + 1] - 0.1 * mb.positions[i * 3]).toBeCloseTo(0.08, 1);
  });
});

describe('trimPolyline', () => {
  it('cuts both ends by arc length and carries values', () => {
    const t = trimPolyline({ pts: [[0, 0], [10, 0], [20, 0]] as V2[], vals: [0, 10, 20] }, 4, 7)!;
    expect(t.pts[0]).toEqual([4, 0]);
    expect(t.pts[t.pts.length - 1][0]).toBeCloseTo(13);
    expect(t.vals![0]).toBeCloseTo(4);
    expect(t.vals![t.vals!.length - 1]).toBeCloseTo(13);
    expect(t.pts.length).toBe(3); // the corner at 10 m survives
  });
  it('returns null when nothing is left', () => {
    expect(trimPolyline({ pts: [[0, 0], [10, 0]] as V2[] }, 6, 6)).toBeNull();
  });
});
