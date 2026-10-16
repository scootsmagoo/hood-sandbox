import { describe, expect, it } from 'vitest';
import { createProjector, type V2 } from '../src/geo';
import { MeshBuilder } from '../src/mesh/builder';
import { buildBuildings, lookFromFeeds, type Building } from '../src/world/buildings';
import { bandFor, classifyBuilding, floorsFor, inferMaterial, paletteColour, styleOf } from '../src/world/classify';
import { buildContexts } from '../src/world/context';
import { applyFacts, knownHeightFor, towerSquare, type FactTarget } from '../src/world/facts';
import { declareRoofChannels, declareWallChannels, writePiece, type PieceInput } from '../src/world/buildingMesh';
import { planBuilding } from '../src/world/plan';
import { LOOK_FLAG, MATERIAL_ID, STYLE_ID } from '../src/world/appearance';
import type { OvertureBuilding } from '../src/sources/overture';
import type { OsmBuilding, OsmPart } from '../src/world/osm';

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const bld = (over: Partial<Building> & { id: string }): Building => ({ rings: [rect(0, 0, 30, 30)], height: 20, heightSource: 'overture', use: 'yes', ...over });

describe('classification uses what the feeds say, first', () => {
  it('takes the material, style and year from the data and says so', () => {
    const c = classifyBuilding(bld({ id: 'a', use: 'commercial', height: 30, look: { material: 'stone', materialSrc: 'osm', style: 'classical', styleSrc: 'facts', year: 1913, yearSrc: 'facts' } }));
    expect(c.material).toBe('stone');
    expect(c.materialFromData).toBe(true);
    expect(c.style).toBe('classical');
    expect(c.styleFromData).toBe(true);
    expect(c.era).toBe(1);
    expect(c.eraFromData).toBe(true);
  });
  it('uses the data colour, and a palette colour of the material when there is none', () => {
    const data = classifyBuilding(bld({ id: 'b', use: 'commercial', height: 30, look: { material: 'stone', materialSrc: 'osm', colour: [0.73, 0.57, 0.53], colourSrc: 'osm' } }));
    expect(data.colour).toEqual([0.73, 0.57, 0.53]);
    expect(data.colourFromData).toBe(true);
    const inferred = classifyBuilding(bld({ id: 'b2', use: 'commercial', height: 12, look: { material: 'brick', materialSrc: 'osm' } }));
    expect(inferred.colourFromData).toBe(false);
    // a brick palette is red-brown: red above blue
    expect(inferred.colour[0]).toBeGreaterThan(inferred.colour[2]);
  });
  it('does not make a tower of the 1920s, or a listed or old-style one, a glass curtain wall', () => {
    expect(classifyBuilding(bld({ id: 'c', use: 'office', height: 80 })).kind).toBe('glass');
    expect(classifyBuilding(bld({ id: 'c2', use: 'office', height: 80, look: { year: 1906, yearSrc: 'facts' } })).kind).not.toBe('glass');
    expect(classifyBuilding(bld({ id: 'c3', use: 'office', height: 80, look: { style: 'artdeco', styleSrc: 'facts' } })).kind).not.toBe('glass');
    expect(classifyBuilding(bld({ id: 'c4', use: 'office', height: 80, tags: { heritage: '2' } })).kind).not.toBe('glass');
    expect(classifyBuilding(bld({ id: 'c5', use: 'commercial', height: 70, name: 'Hurt Building' })).kind).not.toBe('glass');
    expect(classifyBuilding(bld({ id: 'c6', use: 'commercial', height: 70, name: 'Peachtree Tower' })).kind).toBe('glass');
  });
  it('makes a tall stone or masonry building an office tower and a low one a brick block', () => {
    expect(classifyBuilding(bld({ id: 'd', use: 'commercial', height: 200, look: { material: 'stone', materialSrc: 'facts', year: 1982, yearSrc: 'facts' } })).kind).toBe('office');
    expect(classifyBuilding(bld({ id: 'd2', use: 'yes', height: 15, look: { material: 'brick', materialSrc: 'osm' } })).kind).toBe('brick');
  });
  it('knows a smokestack is not a building with windows', () => {
    expect(classifyBuilding(bld({ id: 'e', use: 'yes', height: 91, rings: [rect(0, 0, 6, 6)], tags: { man_made: 'chimney' } })).kind).toBe('small');
  });
  it('gives a university downtown the concrete campus look when nothing says otherwise', () => {
    const kinds = new Set<string>();
    const mats = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const c = classifyBuilding(bld({ id: `u${i}`, use: 'university', height: 30 }));
      kinds.add(c.kind);
      mats.add(c.material);
    }
    expect([...kinds]).toEqual(['civic']);
    expect(mats.has('concrete')).toBe(true);
  });
});

describe('material and style inference', () => {
  it('draws materials that suit the style', () => {
    const draw = (kind: Parameters<typeof inferMaterial>[0], style: Parameters<typeof inferMaterial>[1], era: number) => {
      const m: Record<string, number> = {};
      for (let i = 0; i < 200; i++) m[inferMaterial(kind, style, era, i / 200, 30)] = (m[inferMaterial(kind, style, era, i / 200, 30)] ?? 0) + 1;
      return m;
    };
    expect(draw('brick', 'victorian', 1).brick).toBeGreaterThan(140);
    expect(draw('civic', 'brutalist', 3)).toEqual({ concrete: 200 });
    expect(draw('civic', 'classical', 1).stone).toBeGreaterThan(150);
    expect(inferMaterial('glass', 'contemporary', 4, 0.5, 100)).toBe('glass');
    expect(inferMaterial('parking', 'modernist', 3, 0.5, 20)).toBe('concrete');
  });
  it('dresses an unmapped neighbour of two mapped brick buildings in brick, most of the time', () => {
    const near = [bld({ id: 'n1', look: { material: 'brick', materialSrc: 'osm' }, rings: [rect(40, 0, 60, 20)] }), bld({ id: 'n2', look: { material: 'brick', materialSrc: 'osm' }, rings: [rect(0, 40, 20, 60)] })];
    const me = bld({ id: 'me', use: 'commercial', height: 14, rings: [rect(0, 0, 20, 20)] });
    const ctx = buildContexts([me, ...near]).get('me')!;
    expect(ctx.materials.brick).toBe(2);
    let brick = 0;
    for (let i = 0; i < 60; i++) if (classifyBuilding({ ...me, id: `me${i}` }, ctx).material === 'brick') brick++;
    const without = (() => {
      let n = 0;
      for (let i = 0; i < 60; i++) if (classifyBuilding({ ...me, id: `me${i}` }).material === 'brick') n++;
      return n;
    })();
    expect(brick).toBeGreaterThan(without);
  });
  it('sees a narrow low-rise that shares its walls as an attached row and an isolated one as not', () => {
    const row = [bld({ id: 'r1', rings: [rect(0, 0, 8, 25)] }), bld({ id: 'r2', rings: [rect(8, 0, 16, 25)] }), bld({ id: 'r3', rings: [rect(100, 0, 140, 40)] })];
    const ctx = buildContexts(row);
    expect(ctx.get('r1')!.attached).toBe(true);
    expect(ctx.get('r2')!.attached).toBe(true);
    expect(ctx.get('r3')!.attached).toBe(false);
    expect(ctx.get('r1')!.frontage).toBeCloseTo(8, 0);
  });
  it('turns era data from the neighbours into an era for an undated building, and says it did', () => {
    const dated = [1, 2, 3].map((i) => bld({ id: `d${i}`, rings: [rect(i * 25, 0, i * 25 + 20, 20)], look: { year: 1965, yearSrc: 'osm' } }));
    const me = bld({ id: 'x', use: 'commercial', height: 70, rings: [rect(0, 40, 20, 60)] });
    const ctx = buildContexts([me, ...dated]).get('x')!;
    expect(ctx.eras[3]).toBe(3);
    let used = 0;
    for (let i = 0; i < 80; i++) if (classifyBuilding({ ...me, id: `x${i}` }, ctx).fromContext) used++;
    expect(used).toBeGreaterThan(10);
  });
});

describe('floors, bands and crowns', () => {
  it('takes taller lobbies for taller towers', () => {
    expect(bandFor('glass', 220)).toBeGreaterThan(bandFor('glass', 70));
    expect(bandFor('office', 30)).toBe(5.5);
    expect(bandFor('house', 6)).toBe(0);
  });
  it('lets a known tower have floors outside the usual range, and a doubtful count fall back to the height', () => {
    // 60 floors in 260 m is 4.3 m a floor; a floor count of 8 in 80 m (10 m a floor) is not believed
    expect(floorsFor('glass', 260, 7.5, 60).fromData).toBe(true);
    expect(floorsFor('office', 80, 5.5, 8).fromData).toBe(false);
    expect(floorsFor('office', 80, 5.5, 8).floorHeight).toBeLessThan(5.6);
    expect(floorsFor('office', 36, 0, 8, 3, 7).floors).toBe(8); // 4.5 m a floor, within a known tower's allowance of 7
    expect(floorsFor('office', 60, 0, 6, 3, 7).fromData).toBe(false);
  });
  it('subtracts the crown, so the windows fit the real floors', () => {
    const b = bld({ id: 'k', use: 'office', height: 265, rings: [rect(0, 0, 50, 50)], look: { floors: 60, floorsSrc: 'facts', heightKnown: true, crown: 24, style: 'postmodern', styleSrc: 'facts', year: 1992, yearSrc: 'facts' } });
    const c = classifyBuilding(b);
    expect(c.crown).toBe(24);
    expect(c.floors).toBe(59); // 60 floors, one of which is the lobby band
    expect(c.floorHeight).toBeGreaterThan(3.6);
    expect(c.floorHeight).toBeLessThan(4.4);
    expect(c.floorsFromData).toBe(true);
  });
  it('gives an unknown postmodern tower a crown and a low one none', () => {
    expect(classifyBuilding(bld({ id: 'k2', use: 'office', height: 190, look: { style: 'postmodern', styleSrc: 'osm' } })).crown).toBeGreaterThan(5);
    expect(classifyBuilding(bld({ id: 'k3', use: 'office', height: 30, look: { style: 'postmodern', styleSrc: 'osm' } })).crown).toBe(0);
  });
});

describe('the palette and the colours of a piece', () => {
  it('has a palette for every material and bounds the lightness', () => {
    for (const m of ['brick', 'stone', 'concrete', 'glass', 'metal', 'stucco', 'wood'] as const) {
      for (let h = 0; h < 1; h += 0.1) {
        const c = paletteColour(m, 'office', h);
        for (const v of c) {
          expect(v).toBeGreaterThan(0.2);
          expect(v).toBeLessThan(0.9);
        }
      }
    }
  });
  it('bakes linear colours', () => {
    const c = classifyBuilding(bld({ id: 'p', use: 'commercial', height: 14 }));
    const st = styleOf(c, 'p', { kind: c.kind });
    for (const v of st.wall) expect(v).toBeLessThan(0.8);
    expect(st.wall[0]).toBeLessThan(c.colour[0]); // linear is darker than sRGB
  });
});

describe('merging the feeds', () => {
  const proj = createProjector('+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m', { lat: 33.7543, lon: -84.3898 });
  const lonlat = (ring: V2[]) => [...ring, ring[0]].map(([x, z]) => proj.toLonLat(x, z) as [number, number]);
  const ov = (id: string, ring: V2[], over: Partial<OvertureBuilding> = {}): OvertureBuilding => ({ id, height: null, numFloors: null, cls: null, subtype: null, isUnderground: false, polygons: [[lonlat(ring)]], ...over });
  const osmB = (id: string, ring: V2[], tags: Record<string, string>): OsmBuilding => ({ id, tags, rings: [ring] });
  const bounds = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };

  it('takes the height and levels of the smallest OSM building that holds the footprint, and refuses a bigger outline', () => {
    const big = osmB('osm:way/1', rect(-100, -100, 100, 100), { building: 'office', height: '265', 'building:levels': '60', start_date: '1992' });
    const small = osmB('osm:way/2', rect(0, 0, 20, 20), { building: 'roof', 'building:levels': '3', 'building:min_level': '2' });
    const { buildings, stats } = buildBuildings([ov('a', rect(0, 0, 20, 20)), ov('b', rect(40, 40, 60, 60))], [big, small], proj, bounds);
    const a = buildings.find((x) => x.srcId === 'a')!;
    const b = buildings.find((x) => x.srcId === 'b')!;
    // a sits in the small way: its levels are its own, and the min level makes it float
    expect(a.numFloors).toBe(3);
    expect(a.minHeight).toBeCloseTo(6.8);
    expect(a.facadeFloors).toBe(1);
    // b sits only in the big outline, which is 100 times its area: it does not become a 265 m tower
    expect(b.height).toBeLessThan(40);
    expect(stats.osmHeightRefused).toBe(1);
    // but it can still take the year of the complex it is in
    expect(b.look?.year).toBe(1992);
  });
  it('keeps colour, material and the source of each field, and the counts say so', () => {
    const o = ov('c', rect(0, 0, 30, 30), { height: 40, facadeMaterial: 'brick', roofColor: '#FFFFFF' });
    const w = osmB('osm:way/3', rect(-5, -5, 35, 35), { building: 'commercial', 'building:colour': '#ba9287', 'building:architecture': 'art_deco', wikidata: 'Q1' });
    const wd = new Map([['Q1', { id: 'Q1', year: 1930, styles: ['modernist'], materials: [], floors: 12, height: null, hasArchitect: true }]]);
    const { buildings, stats } = buildBuildings([o], [w], proj, bounds, [], { wikidata: wd });
    const l = buildings[0].look!;
    expect(l).toMatchObject({ colourSrc: 'osm', materialSrc: 'overture', material: 'brick', styleSrc: 'osm', style: 'artdeco', yearSrc: 'wikidata', year: 1930, roofColourSrc: 'overture' });
    expect(l.floorsSrc).toBe('wikidata');
    expect(stats.look.colour).toEqual({ osm: 1 });
    expect(stats.look.style).toEqual({ osm: 1 });
    expect(stats.look.bare).toBe(0);
  });
  it('lets an OSM tag outrank Overture, and Overture outrank Wikidata', () => {
    const l = lookFromFeeds({ building: 'yes', 'building:material': 'stone' }, { facadeMaterial: 'brick', facadeColor: '#775533' }, { id: 'Q', year: null, styles: [], materials: ['glass'], floors: null, height: null, hasArchitect: false }, true);
    expect(l.material).toBe('stone');
    expect(l.materialSrc).toBe('osm');
    expect(l.colourSrc).toBe('overture');
  });
  it('turns the pure OSM building parts of a tower into its parts', () => {
    const o = ov('t', rect(0, 0, 40, 40), { height: 80 });
    const parts: OsmPart[] = [
      { id: 'osm:way/p1', tags: { 'building:part': 'yes', 'building:levels': '6', 'roof:shape': 'flat' }, rings: [rect(0, 0, 40, 40)] },
      { id: 'osm:way/p2', tags: { 'building:part': 'yes', 'building:levels': '20', height: '75' }, rings: [rect(10, 10, 30, 30)] },
    ];
    const { buildings, stats } = buildBuildings([o], [], proj, bounds, [], { osmParts: parts });
    expect(stats.osmPartsAdded).toBe(2);
    expect(buildings[0].parts).toHaveLength(2);
    expect(buildings[0].hasParts).toBe(true);
    const tall = buildings[0].parts!.find((p) => p.id === 'osm:way/p2')!;
    expect(tall.height).toBe(75);
    expect(buildings[0].parts!.find((p) => p.id === 'osm:way/p1')!.height).toBeCloseTo(6 * 3.4 + 1);
  });
  it('takes a parking deck that is 198 m tall for what its floors say', () => {
    const o = ov('g', rect(0, 0, 60, 40), { height: 198, numFloors: 8, cls: 'parking' });
    const { buildings, stats } = buildBuildings([o], [], proj, bounds);
    expect(buildings[0].height).toBeCloseTo(8 * 3.2 + 1);
    expect(stats.heightsCapped).toBe(1);
  });
});

describe('known heights and curated looks', () => {
  const proj = createProjector('+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m', { lat: 33.7543, lon: -84.3898 });
  const at = (x: number, z: number): [number, number] => {
    const [lon, lat] = proj.toLonLat(x, z);
    return [lat, lon];
  };
  const target = (id: string, ring: V2[], height: number): FactTarget & { height: number } => ({ id, rings: [ring], height });

  it('decides when a known height replaces a baked one', () => {
    expect(knownHeightFor(212.5, 207)).toBe(212.5); // a little short
    expect(knownHeightFor(140, 164)).toBe(140); // too tall (a mis-measured one)
    expect(knownHeightFor(100, 100.5)).toBeNull(); // close enough
    expect(knownHeightFor(116, 78)).toBeNull(); // far shorter: a mast the footprint does not carry; left for the audit
  });
  it('matches by position and height: the tower, not the lower footprint under the point', () => {
    const base = target('base', rect(-20, -20, 20, 20), 50);
    const tower = target('tower', rect(25, -10, 45, 10), 207);
    const [lat, lon] = at(0, 0);
    const set: string[] = [];
    const res = applyFacts([base, tower], { heights: [{ lat, lon, height: 212.5, floors: 51, year: 1981 }], looks: [] }, proj, (t, h) => {
      t.height = h;
      set.push(t.id);
    });
    expect(set).toEqual(['tower']);
    expect(tower.height).toBe(212.5);
    expect(tower.look).toMatchObject({ floors: 51, floorsSrc: 'facts', year: 1981, heightKnown: true });
    expect(base.height).toBe(50);
    expect(res.heights.applied).toBe(1);
  });
  it('does not let one known height claim two footprints', () => {
    const a = target('a', rect(0, 0, 20, 20), 100);
    const b = target('b', rect(22, 0, 42, 20), 100);
    const [lat, lon] = at(10, 10);
    const [lat2, lon2] = at(30, 10);
    const res = applyFacts([a, b], { heights: [{ lat, lon, height: 100, floors: 20, year: 1970 }, { lat: lat2, lon: lon2, height: 100, floors: 22, year: 1971 }], looks: [] }, proj, () => {});
    expect(a.look?.floors).toBe(20);
    expect(b.look?.floors).toBe(22);
    expect(res.heights.unmatched).toEqual([]);
  });
  it('takes a small footprint under the point that is far too low for the tower itself', () => {
    const lowHotel = target('hotel', rect(-20, -20, 20, 20), 8);
    const [lat, lon] = at(0, 0);
    const res = applyFacts([lowHotel], { heights: [{ lat, lon, height: 104, floors: 24, year: 1967 }], looks: [] }, proj, (t, h) => (t.height = h));
    expect(lowHotel.height).toBe(104);
    expect(res.heights.applied).toBe(1);
    expect(res.heights.towers).toEqual([]);
  });
  it('leaves a big low footprint under a known tower alone and asks for it to be split', () => {
    const podium = target('podium', rect(-60, -50, 60, 50), 21);
    const [lat, lon] = at(5, 5);
    const res = applyFacts([podium], { heights: [{ lat, lon, height: 169, floors: 47, year: 1985 }], looks: [] }, proj, (t, h) => (t.height = h));
    expect(podium.height).toBe(21);
    expect(res.heights.towers).toHaveLength(1);
    expect(res.heights.towers[0].fact.height).toBe(169);
  });
  it('makes the tower a square of about 40 m2 a floor, inside the footprint, round the point', () => {
    const ring = rect(-60, -50, 60, 50);
    const sq = towerSquare(ring, [5, 5], 47)!;
    expect(sq).toHaveLength(4);
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = sq[i], q = sq[(i + 1) % 4]; a += p[0] * q[1] - q[0] * p[1]; }
    expect(Math.abs(a / 2)).toBeCloseTo(1880, -1);
    const cx = sq.reduce((s, p) => s + p[0], 0) / 4;
    const cz = sq.reduce((s, p) => s + p[1], 0) / 4;
    expect(Math.hypot(cx - 5, cz - 5)).toBeLessThan(1);
    // a point near the edge pulls the square in
    const edge = towerSquare(ring, [58, 0], 47)!;
    expect(Math.max(...edge.map((p) => p[0]))).toBeLessThanOrEqual(60);
    // a footprint too small for it has none
    expect(towerSquare(rect(0, 0, 20, 20), [10, 10], 40)).toBeNull();
  });
  it('splits a hotel podium into the known tower and the podium when the buildings are made', () => {
    const o = (id: string, ring: V2[], height: number): OvertureBuilding => ({ id, height, numFloors: null, cls: null, subtype: null, isUnderground: false, polygons: [[[...ring, ring[0]].map(([x, z]) => proj.toLonLat(x, z) as [number, number])]] });
    const [lat, lon] = at(10, 10);
    const { buildings, stats } = buildBuildings([o('h', rect(-60, -50, 60, 50), 21)], [], proj, { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 }, [], { facts: { heights: [{ lat, lon, height: 169, floors: 47, year: 1985 }], looks: [] } });
    expect(stats.towersSplit).toBe(1);
    const tower = buildings.find((b) => b.id.endsWith('/tower'))!;
    const rest = buildings.filter((b) => !b.id.endsWith('/tower'));
    expect(tower.height).toBe(169);
    expect(tower.look).toMatchObject({ floors: 47, heightKnown: true });
    expect(rest.length).toBeGreaterThan(0);
    expect(rest[0].height).toBe(21);
    expect(rest[0].rings.length).toBeGreaterThanOrEqual(1);
  });
  it('applies a curated look to the building a known height matched nearby', () => {
    const base = target('base', rect(-20, -20, 20, 20), 50);
    const tower = target('tower', rect(25, -10, 45, 10), 207);
    const [lat, lon] = at(0, 0);
    applyFacts([base, tower], { heights: [{ lat, lon, height: 212.5, floors: 51, year: 1981 }], looks: [{ at: [lat, lon], radius: 45, material: 'stone', colour: '#ba9287', style: 'modernist', crown: 10 }] }, proj, (t, h) => (t.height = h));
    expect(tower.look).toMatchObject({ material: 'stone', materialSrc: 'facts', style: 'modernist', curated: true, crown: 10 });
    expect(tower.look!.colour![0]).toBeCloseTo(0xba / 255, 1);
    expect(base.look?.material).toBeUndefined();
  });
});

describe('the mesh carries the look', () => {
  const piece = (look: PieceInput['look']): PieceInput => ({
    rings: [rect(0, 0, 30, 20)], baseH: 0, topH: 24, roof: null, parapet: 0.8, kind: 'office', era: 3, floors: 5, band: 4.5, hash16: 123, flags: 0,
    wall: [0.5, 0.5, 0.5], roofColor: [0.3, 0.3, 0.3], glass: false, seed: 1, equipment: false, look,
  });
  it('writes (material, style, band material and crown, provenance) on walls and (roof material, style, wall material, provenance) on roofs', () => {
    const wall = declareWallChannels(new MeshBuilder());
    const roof = declareRoofChannels(new MeshBuilder());
    writePiece({ datumY: 0, wall, glass: declareWallChannels(new MeshBuilder()), roof, ao: () => 1 }, piece({ material: MATERIAL_ID.stone, style: STYLE_ID.classical, bandMaterial: MATERIAL_ID.concrete, crown: 20, roofMaterial: 3, flags: LOOK_FLAG.material | LOOK_FLAG.curated }));
    expect(wall.pad().get('look', 0)).toEqual([MATERIAL_ID.stone, STYLE_ID.classical, MATERIAL_ID.concrete | (10 << 3), LOOK_FLAG.material | LOOK_FLAG.curated]);
    expect(roof.pad().get('look', 0)).toEqual([3, STYLE_ID.classical, MATERIAL_ID.stone, LOOK_FLAG.material | LOOK_FLAG.curated]);
  });
  it('writes zeros for a piece with no look (an old caller)', () => {
    const wall = declareWallChannels(new MeshBuilder());
    writePiece({ datumY: 0, wall, glass: declareWallChannels(new MeshBuilder()), roof: declareRoofChannels(new MeshBuilder()), ao: () => 1 }, piece(undefined));
    expect(wall.pad().get('look', 0)).toEqual([0, 0, 0, 0]);
  });
  it('plans a glass tower with a stone or concrete podium and its look flags', () => {
    const tower = bld({
      id: 'gt', use: 'office', height: 120, rings: [rect(0, 0, 40, 40)], look: { year: 1985, yearSrc: 'osm', style: 'modernist', styleSrc: 'osm', material: 'glass', materialSrc: 'osm' },
      parts: [{ id: 'p', polygons: [[rect(0, 0, 40, 40)]], height: 120, minHeight: null, numFloors: null, roofShape: null, roofHeight: null, roofDirection: null, facadeMaterial: null, facadeColor: null }],
    });
    const plan = planBuilding(tower);
    expect(plan.cls.kind).toBe('glass');
    const p = plan.pieces[0];
    expect(p.look!.material).toBe(MATERIAL_ID.glass);
    expect(p.look!.flags & LOOK_FLAG.material).toBeTruthy();
    expect([MATERIAL_ID.stone, MATERIAL_ID.concrete, MATERIAL_ID.metal]).toContain(p.look!.bandMaterial);
  });
});
