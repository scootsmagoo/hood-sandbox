import { describe, expect, it } from 'vitest';
import type { Building } from '../src/world/buildings';
import { heroDatum, hullBuildings, isReplaced, placeHeroes, suppressReplaced, tileLandmarks, type HeroSidecar } from '../src/world/landmarks';
import type { Projector, V2 } from '../src/geo';

/** A projector whose game coordinates are the lon/lat times 1000: anchor { lon: 5, lat: -7 } stands at (5000, -7000)... scaled down to metres by `k`. */
const proj: Projector = { E0: 0, N0: 0, toGame: (lon, lat) => [lon, -lat], toLonLat: (x, z) => [x, -z] };
const bounds = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };
const square = (cx: number, cz: number, h: number): V2[] => [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]];
const building = (id: string, ring: V2[], extra: Partial<Building> = {}): Building => ({ id, rings: [ring], height: 30, heightSource: 'default', use: 'yes', ...extra });

const side = (over: Partial<HeroSidecar> = {}): HeroSidecar => ({
  id: 'tower',
  anchor: { x: 100, z: 200, lon: 100, lat: -200 },
  yaw: 0,
  height: 80,
  radius: 40,
  model: 'assets/landmarks/tower.glb',
  hash: 'abc',
  lods: [{ tris: 900, from: 0 }, { tris: 200, from: 500 }],
  hull: [{ ring: square(0, 0, 20), height: 70 }],
  cutout: square(0, 0, 25),
  replaces: { overture: ['u-1'], also: ['overture:u-2/1'], overlap: 0.4 },
  ...over,
});

describe('hero landmarks in the bake', () => {
  it('places the model and its hull in the world from the anchor and the yaw', () => {
    const [h] = placeHeroes([side()], proj, bounds);
    expect([h.x, h.z]).toEqual([100, 200]);
    expect(h.hull).toHaveLength(1);
    const xs = h.hull[0].ring.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(80);
    expect(Math.max(...xs)).toBeCloseTo(120);
    const [turned] = placeHeroes([side({ yaw: Math.PI / 2, hull: [{ ring: [[10, 0], [30, 0], [30, 5], [10, 5]], height: 20 }] })], proj, bounds);
    // a quarter turn about +Y: local +x goes to world -z
    expect(turned.hull[0].ring[0][0]).toBeCloseTo(100);
    expect(turned.hull[0].ring[0][1]).toBeCloseTo(190);
  });

  it('clips the hull to the tile: nothing is solid past the heightmap', () => {
    const [h] = placeHeroes([side({ anchor: { x: -1010, z: 0, lon: -1010, lat: 0 }, hull: [{ ring: square(0, 0, 30), height: 40 }] })], proj, bounds);
    expect(h.hull).toHaveLength(1);
    const xs = h.hull[0].ring.map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1000 - 1e-6);
    expect(Math.max(...xs)).toBeCloseTo(-980);
    // wholly outside: not a hero of this tile at all (the next tile's)
    expect(placeHeroes([side({ anchor: { x: -1100, z: 0, lon: -1100, lat: 0 }, hull: [{ ring: square(0, 0, 30), height: 40 }] })], proj, bounds)).toHaveLength(0);
  });

  it('removes the generic buildings a hero replaces: by id, by full id, and by footprint overlap; leaves the rest', () => {
    const heroes = placeHeroes([side()], proj, bounds);
    const list = [
      building('overture:u-1', square(300, 300, 10), { srcId: 'u-1' }), // by Overture id, far from the cut-out
      building('overture:u-2/1', square(400, 300, 10), { srcId: 'u-2' }), // by full id
      building('overture:other', square(100, 200, 12)), // inside the cut-out
      building('overture:edge', [[120, 200], [150, 200], [150, 230], [120, 230]]), // 5 m of 30 inside the cut-out (125): under the share
      building('overture:far', square(-500, -500, 10)),
    ];
    const r = suppressReplaced(list, heroes);
    expect(r.buildings.map((b) => b.id)).toEqual(['overture:edge', 'overture:far']);
    expect(r.replaced.get('tower')).toEqual(['overture:u-1', 'overture:u-2/1', 'overture:other']);
    expect(isReplaced(list[3], heroes[0])).toBe(false);
  });

  it('a tile with no heroes is untouched', () => {
    const list = [building('a', square(0, 0, 10))];
    expect(suppressReplaced(list, []).buildings).toBe(list);
  });

  it('makes undrawn buildings of the hull, at the model datum', () => {
    const [h] = placeHeroes([side()], proj, bounds);
    const datum = heroDatum(h, (x, z) => 3 + x * 0.01 + z * 0.001);
    expect(datum).toBeCloseTo(3 + 0.01 * 75 + 0.001 * 175, 3);
    const bs = hullBuildings(h, datum);
    expect(bs).toHaveLength(1);
    expect(bs[0].hero).toEqual({ id: 'tower', datum });
    expect(bs[0].height).toBe(70);
  });

  it('writes the tile file: the pack landmarks that are in the tile, the hero with its model and footprint', () => {
    const heroes = placeHeroes([side()], proj, bounds);
    const f = tileLandmarks(
      [
        { id: 'tower', name: 'Real Tower', displayName: 'Parody Tower', lat: -200, lon: 100 },
        { id: 'park', name: 'Park', kind: 'park', x: -300, z: 50 },
        { id: 'far-away', name: 'Far', x: 9000, z: 9000 },
        { id: 'no-position', name: 'Nowhere' },
      ],
      [{ place: heroes[0], datum: 4.5, replaced: ['overture:u-1'], hullTris: 24 }],
      proj,
      bounds,
    );
    expect(f.landmarks.map((l) => l.id)).toEqual(['tower', 'park']);
    const tower = f.landmarks[0];
    expect(tower.displayName).toBe('Parody Tower');
    expect(tower.name).toBe('Real Tower');
    expect(tower.hero).toMatchObject({ model: 'assets/landmarks/tower.glb', y: 4.5, replaced: ['overture:u-1'], hullTris: 24 });
    expect(tower.ring).toHaveLength(4);
    expect(f.landmarks[1].radius).toBe(110);
    expect(f.landmarks[1].hero).toBeUndefined();
  });
});
