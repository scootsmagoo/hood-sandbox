import { describe, expect, it } from 'vitest';
import type { V2 } from '../src/geo';
import { MeshBuilder } from '../src/mesh/builder';
import { extrudeFootprint } from '../src/mesh/extrude';
import { OcclusionField } from '../src/world/ao';
import { buildBuildings, skybridgeHeights, SKYBRIDGE, type Building } from '../src/world/buildings';
import { clipBuildingsToRoads } from '../src/world/clip';
import { declareRoofChannels, declareWallChannels, writePiece } from '../src/world/buildingMesh';
import { planBuilding } from '../src/world/plan';
import { addRaisedToField, insetForCollision, skybridgeDatum } from '../src/world/skybridge';
import { makeHeightmap } from '../src/world/terrain';
import type { OvertureBuilding } from '../src/sources/overture';
import type { OsmBuilding } from '../src/world/osm';
import type { RoadWay } from '../src/world/osm';

/** A walkway 40 m long and 5 m wide along x, over a street that runs along z. */
const walkway: V2[] = [[-20, -2.5], [20, -2.5], [20, 2.5], [-20, 2.5]];
const bridge = (over: Partial<Building> = {}): Building => ({ id: 'sb', rings: [walkway], height: 11, heightSource: 'known', use: 'bridge', skybridge: true, minHeight: 7, ...over });

describe('skybridge heights', () => {
  it('uses the mapped min_height, else a second-floor clearance, and a tube about 4 m tall', () => {
    expect(skybridgeHeights(null, null)).toEqual({ minHeight: SKYBRIDGE.clearance, height: SKYBRIDGE.clearance + SKYBRIDGE.tube });
    expect(skybridgeHeights(9, null)).toEqual({ minHeight: 9, height: 13 });
    // a mapped height that fits a walkway is kept; a tower's height (79 m) is not
    expect(skybridgeHeights(6.8, 11.2).height).toBe(11.2);
    expect(skybridgeHeights(null, 79.4).height).toBe(SKYBRIDGE.clearance + SKYBRIDGE.tube);
    expect(skybridgeHeights(1, null).minHeight).toBe(SKYBRIDGE.clearance);
  });
});

describe('skybridges in the building merge', () => {
  const ring = (r: V2[]) => [...r, r[0]].map(([x, z]) => [x * 1e-5 - 84.39, z * 1e-5 + 33.76] as [number, number]);
  const proj = { toGame: (lon: number, lat: number): V2 => [(lon + 84.39) * 1e5, (lat - 33.76) * 1e5] } as never;
  const bounds = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
  it('flags a building=bridge footprint and gives it a floating height; a tower tagged bridge stays a building', () => {
    const tower: V2[] = [[100, 100], [140, 100], [140, 140], [100, 140]];
    const ov = (id: string, r: V2[], height: number | null): OvertureBuilding => ({ id, height, numFloors: null, cls: null, subtype: null, isUnderground: false, minHeight: null, roofShape: null, roofMaterial: null, roofColor: null, roofHeight: null, roofDirection: null, facadeMaterial: null, facadeColor: null, hasParts: false, name: null, polygons: [[ring(r)]] }) as OvertureBuilding;
    const osm = (id: string, r: V2[], tags: Record<string, string>): OsmBuilding => ({ id, rings: [r], tags }) as OsmBuilding;
    const { buildings, stats } = buildBuildings(
      [ov('a', walkway, null), ov('b', tower, 79.4)],
      [osm('w1', walkway, { building: 'bridge', layer: '1' }), osm('w2', tower, { building: 'bridge', layer: '1' })],
      proj, bounds,
    );
    const a = buildings.find((x) => x.srcId === 'a')!;
    const b = buildings.find((x) => x.srcId === 'b')!;
    expect(a.skybridge).toBe(true);
    expect(a.minHeight).toBe(SKYBRIDGE.clearance);
    expect(a.height).toBe(SKYBRIDGE.clearance + SKYBRIDGE.tube);
    expect(b.skybridge).toBeFalsy();
    expect(b.height).toBeCloseTo(79.4);
    expect(stats.skybridges).toBe(1);
  });
});

describe('a skybridge is a floating tube', () => {
  it('is one raised glass piece about 4 m tall, solid only from its underside', () => {
    const plan = planBuilding(bridge());
    expect(plan.pieces).toHaveLength(1);
    const pc = plan.pieces[0];
    expect(pc.baseH).toBe(7);
    expect(pc.topH).toBe(11);
    expect(pc.glass).toBe(true);
    expect(pc.roof).toBeNull();
    expect(plan.solidBaseH).toBe(7);
    expect(plan.maxTopH).toBe(11);
  });
  it('a building on the ground (or a stepped one with a ground piece) is solid from the ground', () => {
    expect(planBuilding({ id: 'g', rings: [walkway], height: 20, heightSource: 'overture', use: 'yes' }).solidBaseH).toBe(0);
  });
  it('its walls start at the underside, with a soffit, and none go down to the ground', () => {
    const plan = planBuilding(bridge());
    const wall = declareWallChannels(new MeshBuilder());
    const glass = declareWallChannels(new MeshBuilder());
    const roof = declareRoofChannels(new MeshBuilder());
    writePiece({ datumY: 3, wall, glass, roof, ao: () => 1 }, plan.pieces[0]);
    const ys = [...glass.positions, ...wall.positions].filter((_, i) => i % 3 === 1);
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys, ...roof.positions.filter((_, i) => i % 3 === 1))).toBeCloseTo(3 + 7, 5);
    expect(Math.max(...ys)).toBeLessThanOrEqual(3 + 11 + 1e-6);
  });
  it('the collision prism leaves the way under it open: walls and a roof from the underside to the top, nothing below, no floor', () => {
    const plan = planBuilding(bridge());
    const wallMb = new MeshBuilder(), roofMb = new MeshBuilder();
    extrudeFootprint([walkway], { baseY: 3 + plan.solidBaseH, topY: 3 + plan.maxTopH, wall: wallMb, roof: roofMb, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const ys = [...wallMb.positions, ...roofMb.positions].filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(10);
    expect(Math.max(...ys)).toBeCloseTo(14);
    // every flat triangle is the roof (all three corners at the top): the footprint the sim recovers from the roofs is the tube's alone
    for (let i = 0; i < roofMb.indices.length; i += 3) {
      for (let k = 0; k < 3; k++) expect(roofMb.positions[roofMb.indices[i + k] * 3 + 1]).toBeCloseTo(14);
    }
  });
  it('is recovered as a footprint that does not hold somebody on the street under it', async () => {
    const { FootprintIndex } = await import('../../../src/shared/footprints');
    const plan = planBuilding(bridge());
    const walls = new MeshBuilder(), roof = new MeshBuilder();
    extrudeFootprint([walkway], { baseY: 3 + plan.solidBaseH, topY: 3 + plan.maxTopH, wall: walls, roof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const pos: number[] = [...walls.positions];
    const idx: number[] = [...walls.indices];
    const base = walls.vertexCount;
    pos.push(...roof.positions);
    idx.push(...roof.indices.map((i) => i + base));
    const fp = new FootprintIndex(Float32Array.from(pos), Uint32Array.from(idx), idx.length / 3);
    // a person on the street (y = 3.8, the ground) is under it, not in it; one at the walkway's level is in it
    expect(fp.inside(0, 3.8, 0)).toBe(false);
    expect(fp.inside(0, 11, 0)).toBe(true);
    expect(fp.outlineCount).toBe(4);
  });
  it('is not "inside" at street level where it shares corners with a tower (the footprint index tells walls apart by their tops; the collision ring is also drawn in)', async () => {
    const { FootprintIndex } = await import('../../../src/shared/footprints');
    // a tower whose west wall is the tube's east end: they share the corners (20, -2.5) and (20, 2.5)
    const tower: V2[] = [[20, -2.5], [60, -2.5], [60, 30], [20, 30], [20, 2.5]];
    const build = (rings: V2[][], base: number, top: number, into: { pos: number[]; idx: number[] }) => {
      const walls = new MeshBuilder(), roof = new MeshBuilder();
      extrudeFootprint(rings, { baseY: base, topY: top, wall: walls, roof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
      for (const mb of [walls, roof]) {
        const o = into.pos.length / 3;
        into.pos.push(...mb.positions);
        into.idx.push(...mb.indices.map((i) => i + o));
      }
    };
    const check = (tube: V2[][]) => {
      const m = { pos: [] as number[], idx: [] as number[] };
      build([tower], 3, 90, m);
      build(tube, 10, 14, m);
      const fp = new FootprintIndex(Float32Array.from(m.pos), Uint32Array.from(m.idx), m.idx.length / 3);
      return fp.inside(0, 3.8, 0);
    };
    expect(check([walkway])).toBe(false);
    expect(check(insetForCollision([walkway]))).toBe(false);
  });
  it('is not cut by the street it crosses', () => {
    const street: RoadWay = { id: 's', kind: 'car', highway: 'secondary', pts: [[0, -60], [0, 60]], width: 12, bridge: false } as never;
    const cut = clipBuildingsToRoads([bridge(), { ...bridge(), id: 'plain', skybridge: false, height: 20, minHeight: null }], [street]);
    const sb = cut.buildings.filter((b) => b.id === 'sb');
    expect(sb).toHaveLength(1);
    expect(sb[0].rings[0]).toEqual(walkway);
    // an ordinary building over the same street is cut in two
    expect(cut.buildings.filter((b) => b.id.startsWith('plain'))).toHaveLength(2);
  });
  it('takes its datum from the highest ground under it, and shades the ground like a deck', () => {
    // ground 2 m at the west end rising to 6 m at the east end
    const hm = makeHeightmap(30, 10, 4, -60, -20);
    for (let r = 0; r < hm.rows; r++) for (let c = 0; c < hm.cols; c++) hm.data[r * hm.cols + c] = 2 + (4 * c) / (hm.cols - 1);
    const d = skybridgeDatum(walkway, hm);
    expect(d).toBeGreaterThan(2.5);
    expect(d).toBeLessThanOrEqual(6.01);
    const field = new OcclusionField({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 } as never);
    addRaisedToField(field, [walkway], 10);
    // the ground under the tube is shaded as under a deck, and the tube is no block in the sky-view raster
    const under = field.ao(0, 2, 0);
    const clear = field.ao(0, 2, 30);
    expect(under).toBeLessThan(clear);
    expect(field.top.every((t) => t < -1e8)).toBe(true);
  });
});
