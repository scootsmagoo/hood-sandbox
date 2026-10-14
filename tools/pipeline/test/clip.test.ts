import { describe, expect, it } from 'vitest';
import { clipBuildingsToRoads, segmentQuad } from '../src/world/clip';
import { polygonArea } from '../src/world/junctions';
import type { Building } from '../src/world/buildings';
import type { RoadWay } from '../src/world/osm';
import type { V2 } from '../src/geo';

const road = (highway: string, pts: V2[], width = 8): RoadWay => ({ id: 1, name: '', highway, kind: 'car', lanes: 2, oneway: false, width, layer: 0, bridge: false, nodeIds: pts.map((_, i) => i + 1), pts });
const building = (id: string, ring: V2[]): Building => ({ id, rings: [ring], height: 20, heightSource: 'default', use: 'yes' });
const area = (b: Building) => Math.abs(polygonArea(b.rings[0].map(([x, z]) => ({ x, z }))));

describe('buildings over streets', () => {
  it('cuts a building that straddles a street into two, leaving the street clear', () => {
    // 60 m x 20 m building lying across an east-west street 8 m wide
    const b = building('b', [[-30, -10], [30, -10], [30, 10], [-30, 10]]);
    const r = clipBuildingsToRoads([b], [road('tertiary', [[-100, 0], [100, 0]], 8)]);
    expect(r.stats.clipped).toBe(1);
    expect(r.buildings.length).toBe(2);
    const total = r.buildings.reduce((s, x) => s + area(x), 0);
    // the street (8 m + 0.6 m margin) times 60 m is gone
    expect(total).toBeCloseTo(60 * 20 - 60 * 8.6, 0);
    for (const x of r.buildings) for (const p of x.rings[0]) expect(Math.abs(p[1])).toBeGreaterThanOrEqual(4.3 - 1e-6);
    expect(r.buildings[0].height).toBe(20);
    expect(new Set(r.buildings.map((x) => x.id)).size).toBe(2);
  });

  it('leaves buildings beside the street, and buildings over service roads, alone', () => {
    const beside = building('a', [[-10, 6], [10, 6], [10, 20], [-10, 20]]);
    const garage = building('g', [[-10, -10], [10, -10], [10, 10], [-10, 10]]);
    const r = clipBuildingsToRoads([beside, garage], [road('tertiary', [[-100, 0], [100, 0]], 8), road('service', [[0, -30], [0, 30]], 4.5)]);
    expect(r.stats.clipped).toBe(1); // the garage is cut by the tertiary street only
    expect(r.buildings.find((x) => x.id === 'a')).toBe(beside);
    const garageOnly = clipBuildingsToRoads([garage], [road('service', [[0, -30], [0, 30]], 4.5)]);
    expect(garageOnly.stats.clipped).toBe(0);
  });

  it('drops slivers', () => {
    const b = building('s', [[-30, 3.9], [30, 3.9], [30, 6], [-30, 6]]);
    const r = clipBuildingsToRoads([b], [road('tertiary', [[-100, 0], [100, 0]], 8)]);
    expect(r.buildings.length).toBe(1);
    expect(area(r.buildings[0])).toBeCloseTo(60 * (6 - 4.3), 0);
    const tiny = building('t', [[-1, 3.9], [1, 3.9], [1, 4.6], [-1, 4.6]]);
    expect(clipBuildingsToRoads([tiny], [road('tertiary', [[-100, 0], [100, 0]], 8)]).buildings.length).toBe(0);
  });

  it('makes a closed rectangle for a road segment', () => {
    const q = segmentQuad([0, 0], [10, 0], 2)!;
    expect(q.length).toBe(5);
    expect(q[0]).toEqual(q[4]);
    expect(segmentQuad([1, 1], [1, 1], 2)).toBeNull();
  });
});
