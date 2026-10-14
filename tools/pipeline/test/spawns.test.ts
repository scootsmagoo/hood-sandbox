import { describe, expect, it } from 'vitest';
import { headingOf, pickSpawns } from '../src/world/spawns';
import { makeHeightmap } from '../src/world/terrain';
import type { RoadWay } from '../src/world/osm';
import type { RoadJson } from '../src/world/roads';

describe('heading', () => {
  it('0 faces north (-Z) and positive turns toward west, like three.js rotation.y', () => {
    expect(headingOf(0, -1)).toBeCloseTo(0);
    expect(headingOf(-1, 0)).toBeCloseTo(Math.PI / 2);
    expect(headingOf(1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(headingOf(0, 1))).toBeCloseTo(Math.PI);
  });
});

describe('spawns', () => {
  it('parks the car at the right-hand curb, facing along the road, with the player on the sidewalk beside it', () => {
    const hm = makeHeightmap(11, 11, 20, -100, -100);
    const road: RoadWay = { id: 1, name: '', highway: 'secondary', kind: 'car', lanes: 2, oneway: false, width: 8, layer: 0, bridge: false, nodeIds: [1, 2], pts: [[-80, 30], [80, 30]] };
    const walk: RoadWay = { id: 2, name: '', highway: 'footway', kind: 'ped', sub: 'sidewalk', lanes: 1, oneway: false, width: 2, layer: 0, bridge: false, nodeIds: [3, 4], pts: [[-80, 36], [80, 36]] };
    const json: RoadJson = { id: 'osm:way/1', class: 'secondary', name: '', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: [[-80, 0, 30], [80, 0, 30]] };
    const s = pickSpawns({ roads: [json], ways: [road, walk], footprints: [], hm, bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 } });
    expect(s.player.z).toBeCloseTo(36);
    expect(Math.abs(s.player.x)).toBeLessThan(2);
    expect(s.vehicle.z).toBeGreaterThan(30);
    expect(s.vehicle.z).toBeLessThan(34);
    expect(Math.hypot(s.player.x - s.vehicle.x, s.player.z - s.vehicle.z)).toBeLessThan(5);
    expect(Math.abs(Math.abs(s.vehicle.heading) - Math.PI / 2)).toBeLessThan(0.01);
  });
});
