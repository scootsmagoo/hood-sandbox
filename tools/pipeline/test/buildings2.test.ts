import { describe, expect, it } from 'vitest';
import type { V2, V3 } from '../src/geo';
import { MeshBuilder } from '../src/mesh/builder';
import { makeChunkGrid, splitMesh } from '../src/mesh/chunks';
import { OcclusionField } from '../src/world/ao';
import type { Building } from '../src/world/buildings';
import { declareRoofChannels, declareWallChannels, writePiece, type PieceInput } from '../src/world/buildingMesh';
import { classifyBuilding, floorsFor, parseYear } from '../src/world/classify';
import { planBuilding } from '../src/world/plan';
import { buildProps, walkLine, type PropsInput } from '../src/world/props';
import { RoadMask } from '../src/world/markings';
import type { OsmData } from '../src/sources/osm';
import { planPitchedRoof, roofHeightAt, SURFACE } from '../src/world/roofs';
import { minAreaObb } from '../src/world/shape';
import { landAttr } from '../src/world/terrain';
import { makeHeightmap } from '../src/world/terrain';

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const bld = (over: Partial<Building> & { id: string }): Building => ({ rings: [rect(0, 0, 20, 20)], height: 20, heightSource: 'overture', use: 'yes', ...over });

function piece(over: Partial<PieceInput> = {}): PieceInput {
  return { rings: [rect(0, 0, 30, 20)], baseH: 0, topH: 24, roof: null, parapet: 0.8, kind: 'office', era: 3, floors: 5, band: 4.5, hash16: 123, flags: 0, wall: [0.5, 0.5, 0.5], roofColor: [0.3, 0.3, 0.3], glass: false, seed: 1, equipment: false, ...over };
}
function env() {
  return { datumY: 10, wall: declareWallChannels(new MeshBuilder()), glass: declareWallChannels(new MeshBuilder()), roof: declareRoofChannels(new MeshBuilder()), ao: () => 1 };
}

describe('building classification', () => {
  it('uses names and classes first', () => {
    expect(classifyBuilding(bld({ id: 'a', use: 'parking' })).kind).toBe('parking');
    expect(classifyBuilding(bld({ id: 'b', use: 'yes', name: 'K Deck' })).kind).toBe('parking');
    expect(classifyBuilding(bld({ id: 'c', use: 'yes', name: 'Big Bethel AME Church' })).kind).toBe('religious');
    expect(classifyBuilding(bld({ id: 'd', use: 'house', height: 6 })).kind).toBe('house');
    expect(classifyBuilding(bld({ id: 'e', use: 'university' })).kind).toBe('civic');
    expect(classifyBuilding(bld({ id: 'f', use: 'stadium', height: 40 })).kind).toBe('venue');
    expect(classifyBuilding(bld({ id: 'g', use: 'shed', height: 3 })).kind).toBe('small');
  });
  it('makes tall offices glass and tall masonry or civic buildings not', () => {
    expect(classifyBuilding(bld({ id: 'h', use: 'office', height: 150 })).kind).toBe('glass');
    expect(classifyBuilding(bld({ id: 'i', use: 'commercial', height: 80 })).kind).toBe('glass');
    expect(classifyBuilding(bld({ id: 'j', use: 'office', height: 80, facadeMaterial: 'brick' })).kind).not.toBe('glass');
    expect(classifyBuilding(bld({ id: 'k', use: 'government', height: 80 })).kind).toBe('civic');
    expect(classifyBuilding(bld({ id: 'l', use: 'apartments', height: 80 })).kind).toBe('residential');
  });
  it('infers a kind from height and plan when nothing says, and flags it', () => {
    const c = classifyBuilding(bld({ id: 'm', use: 'yes', height: 6, rings: [rect(0, 0, 40, 20)] }));
    expect(c.kindFromData).toBe(false);
    expect(['retail', 'house', 'brick', 'industrial', 'small']).toContain(c.kind);
    expect(classifyBuilding(bld({ id: 'n', use: 'yes', height: 4, rings: [rect(0, 0, 6, 6)] })).kind).toBe('small');
  });
  it('reads years and eras', () => {
    expect(parseYear({ start_date: '1925-06' })).toBe(1925);
    expect(parseYear({ 'building:year_built': '1974' })).toBe(1974);
    expect(classifyBuilding(bld({ id: 'o', use: 'commercial', height: 30, tags: { start_date: '1925' } })).era).toBe(1);
    expect(classifyBuilding(bld({ id: 'p', use: 'commercial', height: 30, tags: { start_date: '1995' } })).eraFromData).toBe(true);
  });
  it('keeps floors consistent with the height', () => {
    const f = floorsFor('office', 44, 5.5, 10);
    expect(f.floors).toBe(9);
    expect(f.floorHeight).toBeCloseTo((44 - 5.5) / 9);
    // a floor count that does not fit the height is ignored
    const g = floorsFor('office', 20, 0, 40);
    expect(g.floorHeight).toBeGreaterThan(2.6);
    expect(g.floorHeight).toBeLessThan(5.6);
  });
});

describe('wall texture coordinates', () => {
  it('runs u continuously along the ring and v up from the datum', () => {
    const e = env();
    const ring = rect(0, 0, 30, 20);
    writePiece(e, piece({ rings: [ring] }));
    const mb = e.wall.pad();
    expect(mb.triangleCount).toBe(8);
    const quads: { u0: number; u1: number; vb: number; vt: number }[] = [];
    for (let q = 0; q < mb.vertexCount; q += 4) {
      const [ub, vb] = mb.get('uv', q);
      const [, vt] = mb.get('uv', q + 1);
      const [u1] = mb.get('uv', q + 2);
      const wall = mb.get('wall', q);
      expect(wall[0]).toBeCloseTo(ub);
      expect(wall[1]).toBeCloseTo(u1 - ub);
      expect(wall[2]).toBe(0);
      expect(wall[3]).toBeCloseTo(24);
      quads.push({ u0: ub, u1, vb, vt });
    }
    for (let i = 1; i < quads.length; i++) expect(quads[i].u0).toBeCloseTo(quads[i - 1].u1);
    expect(quads[quads.length - 1].u1).toBeCloseTo(100);
    expect(quads[0].vb).toBeCloseTo(-0.3, 1);
    expect(quads[0].vt).toBeCloseTo(24);
  });
  it('keeps u running across an edge hidden inside a taller part', () => {
    const e = env();
    writePiece(e, piece({ hidden: (a, b) => a[0] === 30 && b[0] === 30 }));
    const mb = e.wall.pad();
    expect(mb.triangleCount).toBe(6);
    // the hidden edge (20 m, on x = 30) still counts: the quads start at u = 0 and the ring's total is 100 m
    const spans: [number, number][] = [];
    for (let q = 0; q < mb.vertexCount; q += 4) spans.push([mb.get('uv', q)[0], mb.get('uv', q + 2)[0]]);
    expect(spans[0][0]).toBe(0);
    expect(spans[2][1]).toBeCloseTo(100);
    expect(spans[1][0]).toBeCloseTo(spans[0][1] + 20, 0); // or 30: whichever edge sat between them
    
  });
  it('writes the ids and the ground band', () => {
    const e = env();
    writePiece(e, piece());
    const bldv = e.wall.pad().get('bld', 0);
    expect(bldv).toEqual([1, 3, 5, 45]);
    expect(e.wall.get('bid', 0)).toEqual([123, 0]);
  });
});

describe('roofs', () => {
  const ring = rect(0, 0, 30, 12);
  const obb = minAreaObb(ring);
  it('finds the oriented box', () => {
    expect(obb.L).toBeCloseTo(15);
    expect(obb.W).toBeCloseTo(6);
    expect(obb.fill).toBeCloseTo(1);
  });
  it('builds a gable whose ridge rises over the middle and whose faces cover the footprint', () => {
    const plan = planPitchedRoof(ring, 'gabled', obb, { slopeDeg: 30, maxRise: 7 })!;
    expect(plan.faces.length).toBe(2);
    expect(plan.rise).toBeCloseTo(6 * Math.tan(Math.PI / 6), 3);
    expect(roofHeightAt(plan, 15, 6)).toBeCloseTo(plan.rise, 3);
    expect(roofHeightAt(plan, 15, 0.1)).toBeLessThan(0.2);
    let plan2d = 0;
    for (const f of plan.faces) for (let i = 1; i + 1 < f.pts.length; i++) {
      const a = f.pts[0], b = f.pts[i], c = f.pts[i + 1];
      plan2d += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
    }
    expect(plan2d).toBeCloseTo(360, 3);
  });
  it('builds a hip with four faces and a shorter ridge', () => {
    const plan = planPitchedRoof(ring, 'hipped', obb, { slopeDeg: 25, maxRise: 7 })!;
    expect(plan.faces.length).toBe(4);
    expect(roofHeightAt(plan, 15, 6)).toBeCloseTo(plan.rise, 3);
    expect(roofHeightAt(plan, 2, 6)).toBeLessThan(plan.rise);
  });
  it('refuses a footprint that is not close to a rectangle', () => {
    const L: V2[] = [[0, 0], [30, 0], [30, 5], [5, 5], [5, 30], [0, 30]];
    expect(planPitchedRoof(L, 'gabled', minAreaObb(L), { slopeDeg: 30, maxRise: 7 })).toBeNull();
  });
  it('writes gable fills and a roof at the building height', () => {
    const e = env();
    const plan = planPitchedRoof(ring, 'gabled', obb, { slopeDeg: 30, maxRise: 7 })!;
    writePiece(e, piece({ rings: [ring], topH: 9, roof: plan, parapet: 0, kind: 'house', floors: 2, band: 0 }));
    const roof = e.roof.pad();
    const surfaces = new Set<number>();
    let top = -Infinity;
    for (let i = 0; i < roof.vertexCount; i++) { surfaces.add(roof.get('srf', i)[0]); top = Math.max(top, roof.positions[i * 3 + 1]); }
    expect(surfaces.has(SURFACE.pitched)).toBe(true);
    expect(surfaces.has(SURFACE.gable)).toBe(true);
    expect(top).toBeCloseTo(10 + 9, 3); // datum + height
    // the walls stop at the eaves
    let wallTop = -Infinity;
    for (let i = 0; i < e.wall.vertexCount; i++) wallTop = Math.max(wallTop, e.wall.positions[i * 3 + 1]);
    expect(wallTop).toBeCloseTo(10 + 9 - plan.rise, 3);
    // the gable fills close the two short ends: their area is a triangle each
    let gableArea = 0;
    for (let t = 0; t < roof.indices.length; t += 3) {
      const [a, b, c] = [roof.indices[t], roof.indices[t + 1], roof.indices[t + 2]];
      if (roof.get('srf', a)[0] !== SURFACE.gable) continue;
      const P = roof.positions;
      const u = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const w = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      gableArea += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
    expect(gableArea).toBeCloseTo(2 * 0.5 * 12 * plan.rise, 2);
  });
  it('lowers a flat roof under its parapet and puts equipment on it', () => {
    const e = env();
    const st = writePiece(e, piece({ rings: [rect(0, 0, 40, 30)], equipment: true, kind: 'brick' }));
    const roof = e.roof.pad();
    const flat: number[] = [];
    for (let i = 0; i < roof.vertexCount; i++) if (roof.get('srf', i)[0] === SURFACE.flat) flat.push(roof.positions[i * 3 + 1]);
    expect(Math.max(...flat)).toBeCloseTo(10 + 24 - 0.8, 3);
    const eq = Object.values(st.equipment).reduce((a, b) => a + b, 0);
    expect(eq).toBeGreaterThan(0);
    // equipment stands on the lowered roof, away from the edge
    for (let i = 0; i < roof.vertexCount; i++) {
      if (roof.get('srf', i)[0] !== SURFACE.equipment) continue;
      const x = roof.positions[i * 3], z = roof.positions[i * 3 + 2];
      expect(x).toBeGreaterThan(0.8);
      expect(x).toBeLessThan(39.2);
      expect(z).toBeGreaterThan(0.8);
      expect(z).toBeLessThan(29.2);
    }
  });
});

describe('building parts', () => {
  it('steps a tower on a podium and hides the walls between them', () => {
    const outline = [rect(0, 0, 60, 40)];
    const tower = rect(20, 10, 40, 30);
    const bd = bld({
      id: 't1', use: 'office', height: 120, rings: outline,
      parts: [{ id: 'p', polygons: [[tower]], height: 120, minHeight: null, numFloors: 30, roofShape: null, roofHeight: null, roofDirection: null, facadeMaterial: null, facadeColor: null }],
    });
    const plan = planBuilding(bd);
    expect(plan.pieces.length).toBe(2);
    const heights = plan.pieces.map((p) => p.topH).sort((a, b) => a - b);
    expect(heights[1]).toBe(120);
    expect(heights[0]).toBeLessThan(30); // the podium is not as tall as the tower
    expect(plan.maxTopH).toBe(120);
    expect(plan.stats.podium).toBe(true);
    const podium = plan.pieces.find((p) => p.topH < 100)!;
    expect(podium.rings.length).toBe(2); // the outline with the tower cut out
    expect(podium.kind).toBe('office');
    // the podium's walls around the tower are inside the building
    const inner = podium.rings[1];
    const hidden = podium.hidden!;
    let n = 0;
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i], b = inner[(i + 1) % inner.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz);
      if (hidden(a, b, [dz / l, -dx / l])) n++;
    }
    expect(n).toBe(4);
  });
  it('keeps a plain building as one piece at its height', () => {
    const plan = planBuilding(bld({ id: 't2', use: 'office', height: 30 }));
    expect(plan.pieces.length).toBe(1);
    expect(plan.maxTopH).toBe(30);
  });
  it('gives small houses a pitched roof that reaches the building height', () => {
    const plan = planBuilding(bld({ id: 't3', use: 'house', height: 7, rings: [rect(0, 0, 12, 9)] }));
    expect(plan.pieces[0].roof).not.toBeNull();
    expect(plan.maxTopH).toBe(7);
    expect(plan.pieces[0].topH - plan.pieces[0].roof!.rise).toBeGreaterThanOrEqual(2.4);
  });
  it('honours an OSM roof shape, and flat means flat', () => {
    expect(planBuilding(bld({ id: 't4', use: 'commercial', height: 9, rings: [rect(0, 0, 14, 10)], roofShape: 'hipped' })).pieces[0].roof?.shape).toMatch(/hipped|pyramidal/);
    expect(planBuilding(bld({ id: 't5', use: 'house', height: 7, rings: [rect(0, 0, 12, 9)], roofShape: 'flat' })).pieces[0].roof).toBeNull();
  });
});

describe('mesh channels', () => {
  it('survive a split into chunks', () => {
    const mb = new MeshBuilder();
    mb.channel('uv', 2);
    mb.channel('ao', 1, [1]);
    const a = mb.vertex(-50, 0, -50, 0, 1, 0), b = mb.vertex(-49, 0, -50, 0, 1, 0), c = mb.vertex(-50, 0, -49, 0, 1, 0);
    mb.tri(a, b, c);
    mb.set('uv', a, 1, 2); mb.set('uv', b, 3, 4); mb.set('uv', c, 5, 6);
    const d = mb.vertex(50, 0, 50, 0, 1, 0), e = mb.vertex(51, 0, 50, 0, 1, 0), f = mb.vertex(50, 0, 51, 0, 1, 0);
    mb.tri(d, e, f);
    mb.set('uv', d, 7, 8); // e and f never set theirs
    mb.set('ao', e, 0.5);
    const parts = splitMesh(mb, makeChunkGrid({ minX: -100, minZ: -100, maxX: 100, maxZ: 100 }, 100));
    expect(parts.size).toBe(2);
    const second = parts.get(3)!;
    expect(second.get('uv', 0)).toEqual([7, 8]);
    expect(second.get('uv', 1)).toEqual([0, 0]);
    expect(second.get('ao', 0)).toEqual([1]);
    expect(second.get('ao', 1)).toEqual([0.5]);
    expect(parts.get(0)!.get('uv', 2)).toEqual([5, 6]);
  });
});

describe('ambient occlusion', () => {
  it('darkens a street between towers and the foot of a wall', () => {
    const f = new OcclusionField({ minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
    f.addBuilding([rect(-60, -60, -8, 60)], 100);
    f.addBuilding([rect(8, -60, 60, 60)], 100);
    const street = f.ao(0, 0, 0);
    const open = f.ao(0, 0, 0 + 0) > 0 && new OcclusionField({ minX: -100, minZ: -100, maxX: 100, maxZ: 100 }).ao(0, 0, 0);
    expect(open).toBeCloseTo(1, 2);
    expect(street).toBeLessThan(0.7);
    // a wall: dark at the base, open at the top, looking out of the street
    const base = f.ao(8, 1, 0, [-1, 0]);
    const top = f.ao(8, 100, 0, [-1, 0]);
    expect(base).toBeLessThan(top);
    expect(top).toBeGreaterThan(0.9);
  });
  it('shades the ground under a deck', () => {
    const f = new OcclusionField({ minX: -50, minZ: -50, maxX: 50, maxZ: 50 });
    f.addDeck([-40, 0], [40, 0], 8, 6);
    expect(f.ao(0, 0, 0)).toBeLessThan(0.6);
    expect(f.ao(0, 7, 0)).toBeGreaterThan(0.95); // the road on the deck
  });
});

describe('ground attributes', () => {
  it('gives a class and blends weights across a boundary', () => {
    const hm = makeHeightmap(9, 9, 4, 0, 0);
    const land = new Uint8Array(81);
    // right half park (code of park in PAINT_ORDER is looked up through rasterizeAreas, so use a known one: 'park' = index 10)
    for (let r = 0; r < 9; r++) for (let c = 5; c < 9; c++) land[r * 9 + c] = 10;
    const out = new Uint8Array(4);
    landAttr(hm, land, 7, 4, 1, out, 0);
    expect(out[0]).toBe(1); // grass class
    expect(out[1]).toBe(255);
    landAttr(hm, land, 4, 4, 1, out, 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeGreaterThan(40);
    expect(out[1]).toBeLessThan(215);
  });
});

describe('props anchors', () => {
  const projector = { E0: 0, N0: 0, toGame: (lon: number, lat: number): V2 => [lon, lat], toLonLat: (x: number, z: number): V2 => [x, z] };
  function input(over: Partial<PropsInput> = {}): PropsInput {
    const mask = new RoadMask();
    const road: V3[] = [[-300, 0, 0], [300, 0, 0]];
    mask.addPolyline([[-300, 0], [300, 0]], 5);
    return {
      osm: null, projector, bounds: { minX: -400, minZ: -400, maxX: 400, maxZ: 400 },
      roads: [{ class: 'secondary', width: 10, oneway: false, bridge: false, points: road }],
      pedestrianWays: [], areas: [{ kind: 'park', rings: [rect(-100, 40, 100, 140)] }],
      footprints: [[rect(-50, -40, 50, -20)]],
      roadMask: mask, pathMask: new RoadMask(), ground: () => 2, ...over,
    };
  }
  it('walks a line at a spacing', () => {
    const at: number[] = [];
    walkLine([[0, 0, 0], [100, 0, 0]], 30, 5, (x) => at.push(x));
    expect(at).toEqual([5, 35, 65, 95]);
  });
  it('places lamps at the spacing, off the road and out of buildings', () => {
    const props = buildProps(input());
    expect(props.lamps.length).toBeGreaterThan(20);
    for (const [x, , z] of props.lamps) {
      expect(Math.abs(z)).toBeGreaterThan(5.9); // outside the 10 m road
      expect(Math.abs(z)).toBeLessThan(7);
      expect(z < -20 && z > -40 && Math.abs(x) < 50).toBe(false);
    }
    // two sides, staggered: along one side the lamps are about 32 m apart
    const north = props.lamps.filter((l) => l[2] < 0).map((l) => l[0]).sort((a, b) => a - b);
    for (let i = 1; i < north.length; i++) expect(north[i] - north[i - 1]).toBeGreaterThanOrEqual(31);
    // the arm points at the road
    for (const l of props.lamps) expect(Math.cos(l[3]) * Math.sign(l[2])).toBeLessThan(-0.9);
  });
  it('plants street trees and park trees that keep clear of buildings, roads and each other', () => {
    const props = buildProps(input());
    expect(props.stats.trees.street).toBeGreaterThan(5);
    expect(props.stats.trees.park).toBeGreaterThan(5);
    for (const t of props.trees) {
      expect(Math.abs(t[2])).toBeGreaterThan(6.5);
      expect(t[0] > -52 && t[0] < 52 && t[2] > -42 && t[2] < -18).toBe(false);
      expect(t[3]).toBeGreaterThan(3);
      expect(t[4]).toBeGreaterThan(1);
    }
    for (const t of props.trees.filter((q) => q[6] === 3)) expect(t[2] > 40 && t[2] < 140 && Math.abs(t[0]) < 100).toBe(true);
  });
  it('is deterministic and reads OSM trees and lamps', () => {
    const osm: OsmData = { elements: [
      { type: 'node', id: 1, lat: 20, lon: 80, tags: { natural: 'tree', height: '14' } },
      { type: 'node', id: 2, lat: 8, lon: 10, tags: { highway: 'street_lamp' } },
      { type: 'node', id: 3, lat: 9, lon: 30, tags: { emergency: 'fire_hydrant' } },
    ] };
    const a = buildProps(input({ osm }));
    const b = buildProps(input({ osm }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.stats.trees.osm).toBe(1);
    expect(a.trees.find((t) => t[6] === 1)![3]).toBe(14);
    expect(a.stats.lamps.osm).toBe(1);
    expect(a.hydrants.length).toBe(1);
    // synthetic lamps keep 10 m from the mapped one
    for (const l of a.lamps.filter((q) => q[6] === 1)) expect(Math.hypot(l[0] - 10, l[2] - 8)).toBeGreaterThan(9.9);
  });
});
