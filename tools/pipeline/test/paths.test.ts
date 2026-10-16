import { describe, expect, it } from 'vitest';
import type { V2 } from '../src/geo';
import type { OsmData } from '../src/sources/osm';
import type { JunctionsFile } from '../src/world/markings';
import type { RoadWay } from '../src/world/osm';
import { BuildingIndex, buildPaths, type PathsFile } from '../src/world/paths';
import type { RoadJson } from '../src/world/roads';
import { buildScenarios } from '../src/world/scenarios';

const bounds = { minX: -200, minZ: -200, maxX: 200, maxZ: 200 };
const flat = () => 0;

let nid = 100;
const ped = (id: number, sub: string | undefined, pts: V2[], highway = 'footway'): RoadWay => ({
  id, name: '', highway, kind: 'ped', sub, lanes: 1, oneway: false, width: sub === 'crossing' ? 3 : 1.8, layer: 0, bridge: false, nodeIds: pts.map(() => nid++), pts,
});
const car = (id: number, pts: V2[]): RoadWay => ({ id, name: '', highway: 'secondary', kind: 'car', lanes: 2, oneway: false, width: 8, layer: 0, bridge: false, nodeIds: pts.map(() => nid++), pts });
const roadJson = (id: number, pts: V2[]): RoadJson => ({ id: `osm:way/${id}`, class: 'secondary', name: '', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: pts.map((p) => [p[0], 0, p[1]] as [number, number, number]) });
const noJunctions: JunctionsFile = { junctions: [], signals: [], stops: [], crossings: [] };

/** Node-and-edge helpers over the output. */
function components(f: PathsFile) {
  const p = f.nodes.map((_, i) => i);
  const find = (a: number): number => { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; };
  for (let i = 0; i < f.edges.length; i += 3) p[find(f.edges[i])] = find(f.edges[i + 1]);
  return new Set(f.nodes.map((_, i) => find(i))).size;
}
const lengthOf = (f: PathsFile, kind: string) => {
  let l = 0;
  for (let i = 0; i < f.edges.length; i += 3) {
    if (f.attrs[f.edges[i + 2]].kind !== kind) continue;
    const a = f.nodes[f.edges[i]], b = f.nodes[f.edges[i + 1]];
    l += Math.hypot(a[0] - b[0], a[2] - b[2]);
  }
  return l;
};

describe('the walk network', () => {
  // an east-west street at z = 0, a mapped sidewalk on its south side only, a building on the north side
  const street: V2[] = [[-150, 0], [150, 0]];
  const base = () => ({
    ways: [car(1, street), ped(2, 'sidewalk', [[-150, 7], [150, 7]])],
    roads: [roadJson(1, street)],
    junctions: noJunctions,
    crossingSignals: new Map<number, boolean>(),
    footprints: [[[[-30, -30], [30, -30], [30, -5], [-30, -5]] as V2[]]],
    bounds,
    ground: flat,
  });

  it('adds a synthetic sidewalk only where the street has none, clear of buildings', () => {
    const { file } = buildPaths(base());
    expect(lengthOf(file, 'sidewalk')).toBeGreaterThan(290);
    // the north curb is free outside the building and cut across its frontage
    const syn = lengthOf(file, 'synthetic');
    expect(syn).toBeGreaterThan(150);
    expect(syn).toBeLessThan(260);
    for (const n of file.nodes) {
      const inside = n[0] > -30.4 && n[0] < 30.4 && n[2] < -8.4 && n[2] > -30.4;
      expect(inside).toBe(false);
    }
    // nothing synthetic on the south side, which is mapped
    for (let i = 0; i < file.edges.length; i += 3) {
      if (file.attrs[file.edges[i + 2]].kind !== 'synthetic') continue;
      expect(file.nodes[file.edges[i]][2]).toBeLessThan(0);
    }
  });

  it('keeps vertices half a metre off a wall, and drops the ones inside', () => {
    const w = base();
    // a footway that runs along the building wall and then through it
    w.ways.push(ped(3, undefined, [[-60, -9.2], [-20, -9.2], [0, -20], [10, -40]]));
    const { file } = buildPaths(w);
    const idx = new BuildingIndex(w.footprints.map((f) => f[0]));
    for (const n of file.nodes) expect(idx.signedDistance(n[0], n[2], 1)).toBeGreaterThan(0.3);
  });

  it('records which junction leg a crossing crosses and whether it has a walk light', () => {
    const cross: V2[] = [[0, 7], [0, -7]];
    const w = base();
    w.ways.push(ped(5, 'crossing', cross));
    w.ways.push(ped(6, 'sidewalk', [[0, -7], [0, -70]]));
    w.junctions = {
      junctions: [{
        id: 'j1', x: 12, y: 0, z: 0, control: 'signals', nodes: [1], polygon: [[6, -5], [18, -5], [18, 5], [6, 5]],
        legs: [
          { road: 'osm:way/1', node: 1, at: [12, 0], dir: [1, 0], approach: true, departure: true, trim: 6, control: 'signals', stopLine: null, crosswalk: true },
          { road: 'osm:way/1', node: 1, at: [12, 0], dir: [-1, 0], approach: true, departure: true, trim: 6, control: 'signals', stopLine: null, crosswalk: true },
        ],
      }],
      signals: [], stops: [], crossings: [],
    };
    const { file } = buildPaths(w);
    const c = file.attrs.find((a) => a.crossing?.id === 5)!;
    expect(c).toBeTruthy();
    expect(c.crossing!.road).toBe('osm:way/1');
    expect(c.crossing!.junction).toBe('j1');
    // the crossing is at x = 0: it crosses the leg that runs west from the junction
    expect(c.crossing!.leg).toBe(1);
    expect(c.crossing!.signals).toBe(true);
  });

  it('joins a dead end to a sidewalk it nearly touches, and drops tiny islands', () => {
    const w = base();
    w.ways.push(ped(7, undefined, [[40, 7.6], [40, 20]]));
    w.ways.push(ped(8, undefined, [[100, 100], [103, 100]]));
    const { file } = buildPaths(w);
    expect(file.stats.components).toBe(components(file));
    expect(file.nodes.some((n) => n[2] > 19)).toBe(true);
    // the 3 m island is gone
    expect(file.nodes.some((n) => Math.abs(n[0] - 101) < 3 && n[2] > 90)).toBe(false);
  });

});

describe('scenario points', () => {
  const street: V2[] = [[-150, 0], [150, 0]];
  const input = () => {
    const paths = buildPaths({
      ways: [car(1, street), ped(2, 'sidewalk', [[-150, 7], [150, 7]]), ped(3, 'sidewalk', [[-150, -7], [150, -7]])],
      roads: [roadJson(1, street)], junctions: noJunctions, crossingSignals: new Map(),
      footprints: [[[[-100, -30], [100, -30], [100, -9], [-100, -9]] as V2[]]], bounds, ground: flat,
    });
    return { paths: paths.file, roads: [roadJson(1, street)], areas: [], footprints: [[[[-100, -30], [100, -30], [100, -9], [-100, -9]] as V2[]]], bounds, ground: flat };
  };
  const proj = { E0: 0, N0: 0, toGame: (lon: number, lat: number): V2 => [lon, -lat], toLonLat: (x: number, z: number): V2 => [x, -z] };

  it('turns POI nodes into points on the sidewalk facing the shop, and synthesises fronts without POI data', () => {
    const pois: OsmData = { elements: [
      { type: 'node' as const, id: 1, lat: -9, lon: 20, tags: { shop: 'clothes' } },
      { type: 'node' as const, id: 2, lat: 7.2, lon: -40, tags: { amenity: 'bench' } },
      { type: 'node' as const, id: 3, lat: 6, lon: 60, tags: { highway: 'bus_stop', public_transport: 'platform' } },
    ] };
    const f = buildScenarios({ ...input(), pois, projector: proj });
    const types = new Set(f.points.map((p) => p.type));
    expect(types.has('shopfront') && types.has('bench') && types.has('busstop')).toBe(true);
    const shop = f.points.find((p) => p.src === 'osm' && p.type === 'shopfront')!;
    expect(Math.abs(shop.z - 7)).toBeLessThan(1.5);
    // facing the shop, which is south of the sidewalk: forward (sin yaw, cos yaw) points to +z
    expect(Math.cos(shop.yaw)).toBeGreaterThan(0.5);
    const none = buildScenarios({ ...input(), pois: null, projector: proj });
    expect(none.stats.poiData).toBe(false);
    expect(none.points.filter((p) => p.type === 'shopfront').length).toBeGreaterThan(3);
    expect(none.points.every((p) => p.cap >= 1)).toBe(true);
  });
});


describe('the walk network and freeways', () => {
  // an eastbound motorway carriageway 25 m wide along z = 0 in a cutting (its surface at -8), with a street on a bridge over it at x = 0
  // (deck at 0) and a sidewalk of the bridge the bake put at the trench floor's height
  const motorway: V2[] = [[-190, 0], [190, 0]];
  const mw = (): RoadJson => ({ id: 'osm:way/900', class: 'motorway', name: '', lanes: 6, oneway: true, bridge: false, layer: 0, width: 25, points: motorway.map((p) => [p[0], -8, p[1]] as [number, number, number]) });
  const bridgeStreet = (): RoadJson => ({ id: 'osm:way/901', class: 'secondary', name: '', lanes: 2, oneway: false, bridge: true, layer: 1, width: 12, points: [[0, 0, -150], [0, 0, 150]] });
  const ground = (x: number, z: number) => (Math.abs(z) < 14 ? -8 : Math.max(-8, Math.min(0, -8 + (Math.abs(z) - 14) * 0.6)));
  const ways = (): RoadWay[] => [
    { ...car(10, motorway), highway: 'motorway', width: 25 },
    { ...car(11, [[0, -150], [0, 150]]), bridge: true, layer: 1, width: 12 },
    // a footway that runs along the carriageway, a footway across it at its level, and the bridge's sidewalk (tagged as a bridge, at ground height)
    ped(20, undefined, [[-150, 3], [-60, 3]]),
    ped(21, undefined, [[-100, -30], [-100, 30]]),
    { ...ped(22, 'sidewalk', [[7, -100], [7, 100]]), bridge: true },
    ped(23, 'sidewalk', [[-150, 30], [150, 30]]),
  ];
  const input = () => ({
    ways: ways(),
    roads: [mw(), bridgeStreet()],
    junctions: noJunctions,
    crossingSignals: new Map<number, boolean>(),
    footprints: [] as V2[][][],
    bounds,
    ground,
  });

  it('has no walk edge on a motorway carriageway at its level, and keeps the bridge sidewalk on the bridge', () => {
    const { file } = buildPaths(input());
    let onMotorway = 0;
    let onDeck = 0;
    for (let i = 0; i < file.edges.length; i += 3) {
      const a = file.nodes[file.edges[i]], b = file.nodes[file.edges[i + 1]];
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
        if (Math.abs(z) < 12.5 && Math.abs(y + 8) < 3.2) onMotorway++;
        if (Math.abs(x - 7) < 0.5 && Math.abs(z) < 12 && y > -1) onDeck++;
      }
    }
    expect(onMotorway).toBe(0);
    // the bridge's sidewalk crosses the freeway at the deck's height
    expect(onDeck).toBeGreaterThan(3);
    expect(file.stats.droppedByFreewayM).toBeGreaterThan(40);
    expect(file.stats.liftedToDeckM).toBeGreaterThan(10);
    // what runs beside the freeway on the cutting's rim is still there
    expect(lengthOf(file, 'sidewalk')).toBeGreaterThan(250);
  });

  it('puts no ramp or crossing logic in the way of an ordinary street', () => {
    const w = input();
    w.ways = w.ways.filter((x) => x.highway !== 'motorway');
    w.roads = [bridgeStreet()];
    const { file } = buildPaths(w);
    expect(file.stats.droppedByFreewayM).toBe(0);
  });
});
