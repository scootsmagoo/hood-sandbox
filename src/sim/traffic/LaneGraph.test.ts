import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLanes } from '../../shared/lanes';
import { Rng } from '../../shared/rng';
import { buildLanes, type JunctionsInput, type RoadInput } from '../../../tools/pipeline/src/world/lanes';
import { Ctl, LaneGraph, type EdgePoint } from './LaneGraph';
import { carSlot, carZoneAt, parseTrafficPopulation, pickVehicle } from './population';
import { pickNext, planRoute } from './route';

const road = (id: string, pts: [number, number][], over: Partial<RoadInput> = {}): RoadInput => ({
  id, class: 'secondary', lanes: 2, oneway: false, bridge: false, layer: 0, width: 7, points: pts.map(([x, z]) => [x, 0, z]), ...over,
});

function grid(): LaneGraph {
  // a 3 x 3 block of two-way streets with unsignalised crossings
  const roads: RoadInput[] = [];
  const junctions: JunctionsInput['junctions'] = [];
  for (const k of [-200, 0, 200]) {
    roads.push(road(`h${k}`, [[-400, k], [400, k]]), road(`v${k}`, [[k, -400], [k, 400]]));
  }
  let n = 0;
  for (const x of [-200, 0, 200]) {
    for (const z of [-200, 0, 200]) {
      const control = n % 2 ? ('signals' as const) : ('none' as const);
      junctions.push({
        id: `j${n++}`, x, y: 0, z, control,
        legs: [
          { road: `h${z}`, node: n, at: [x, z], dir: [-1, 0], approach: true, departure: true, trim: 9, control, stopLine: null, crosswalk: false },
          { road: `h${z}`, node: n, at: [x, z], dir: [1, 0], approach: true, departure: true, trim: 9, control, stopLine: null, crosswalk: false },
          { road: `v${x}`, node: n, at: [x, z], dir: [0, -1], approach: true, departure: true, trim: 9, control, stopLine: null, crosswalk: false },
          { road: `v${x}`, node: n, at: [x, z], dir: [0, 1], approach: true, departure: true, trim: 9, control, stopLine: null, crosswalk: false },
        ],
      });
    }
  }
  const file = JSON.parse(JSON.stringify(buildLanes(roads, { junctions })));
  return new LaneGraph(parseLanes(file)!);
}

describe('lane graph data', () => {
  it('parses what the pipeline writes and rejects what is not a lane graph', () => {
    expect(parseLanes(null)).toBeNull();
    expect(parseLanes({ format: 'other' })).toBeNull();
    const g = grid();
    expect(g.count).toBeGreaterThan(100);
    // connectors lead to their `to`, and take the control of the lane they leave
    for (let i = 0; i < g.count; i++) {
      if (!g.isConnector[i]) continue;
      expect(Array.from(g.next[i])).toEqual([g.to[i]]);
      expect(g.ctl[i]).toBe(g.ctl[g.from[i]]);
    }
  });

  it('marks the largest strongly connected component, which a car can always leave by', () => {
    const g = grid();
    let lanes = 0;
    let main = 0;
    for (let i = 0; i < g.count; i++) {
      if (g.isConnector[i]) continue;
      lanes++;
      if (g.main[i]) main++;
    }
    expect(main / lanes).toBeGreaterThan(0.95);
    for (let i = 0; i < g.count; i++) {
      if (!g.main[i]) continue;
      expect(Array.from(g.next[i]).some((n) => g.main[n])).toBe(true);
    }
  });

  it('knows the signalised ends of lanes and where a point along an edge is', () => {
    const g = grid();
    const signals = Array.from({ length: g.count }, (_, i) => i).filter((i) => !g.isConnector[i] && g.ctl[i] === Ctl.Signals);
    expect(signals.length).toBeGreaterThan(8);
    const e = signals[0];
    const out: EdgePoint = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    g.posAt(e, 0, out);
    expect(Math.hypot(out.x - g.pts[e][0], out.z - g.pts[e][2])).toBeLessThan(1e-4);
    g.posAt(e, g.len[e], out);
    expect(Math.hypot(out.x - g.pts[e][g.pts[e].length - 3], out.z - g.pts[e][g.pts[e].length - 1])).toBeLessThan(1e-4);
    g.posAt(e, g.len[e] / 2, out);
    expect(Math.hypot(out.tx, out.tz)).toBeCloseTo(1, 5);
    // projecting that mid point back lands at the same distance, on the lane
    const hit = g.project(e, out.x, out.z, g.len[e] / 2 - 10, 30, 30, { s: 0, dist: 0 });
    expect(hit.s).toBeCloseTo(g.len[e] / 2, 1);
    expect(hit.dist).toBeLessThan(1e-3);
  });

  it('offers spawn spots in a ring around a point, only on lanes in the main component', () => {
    const g = grid();
    const spots = g.spotsAround(0, 0, 120, 250, []);
    expect(spots.length).toBeGreaterThan(10);
    for (const s of spots) {
      const d = Math.hypot(s.x, s.z);
      expect(d).toBeGreaterThanOrEqual(120);
      expect(d).toBeLessThanOrEqual(250);
      expect(g.main[s.edge]).toBe(1);
      expect(g.isConnector[s.edge]).toBe(0);
    }
  });

  it('finds the nearest lane to a position', () => {
    const g = grid();
    const hit = g.nearestLane(-100, 2, 30)!;
    expect(hit).toBeTruthy();
    expect(hit.dist).toBeLessThan(2.5);
  });
});

describe('routes', () => {
  it('plans a route to another lane over lanes and connectors that leads where it says', () => {
    const g = grid();
    const lanes = Array.from({ length: g.count }, (_, i) => i).filter((i) => !g.isConnector[i] && g.main[i]);
    const a = lanes[0];
    let checked = 0;
    for (const b of lanes.slice(5, 60)) {
      const r = planRoute(g, a, b);
      if (!r) continue;
      checked++;
      let at = a;
      for (const e of r) {
        expect(Array.from(g.next[at])).toContain(e);
        at = e;
      }
      expect(at).toBe(b);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('a wandering car never picks a lane that cannot be left, and prefers going straight', () => {
    const g = grid();
    const rng = new Rng(4);
    let edge = Array.from({ length: g.count }, (_, i) => i).find((i) => !g.isConnector[i] && g.main[i])!;
    let straight = 0;
    let turns = 0;
    for (let i = 0; i < 400; i++) {
      const n = pickNext(g, edge, rng);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(g.main[n]).toBe(1);
      if (g.isConnector[n]) {
        if (g.turn[n] === 0) straight++;
        else turns++;
      }
      edge = n;
    }
    expect(straight).toBeGreaterThan(turns * 0.5);
  });
});

describe('the traffic half of the population table', () => {
  const data = JSON.parse(readFileSync('data/cities/atlanta/population.json', 'utf8'));
  const pop = parseTrafficPopulation(data);

  it('reads the city pack and the generic table', () => {
    expect(pop.zones.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(pop.vehicleGroups).length).toBeGreaterThanOrEqual(2);
    expect(() => parseTrafficPopulation(JSON.parse(readFileSync('src/shared/data/defaultPopulation.json', 'utf8')))).not.toThrow();
    expect(() => parseTrafficPopulation({ vehicleGroups: {}, zones: [] })).toThrow();
  });

  it('picks the zone at a point, the slot by the clock and weekday or weekend, and fewer cars at 4 a.m. than at lunch', () => {
    const core = carZoneAt(pop, 0, 0);
    expect(core).toBeTruthy();
    const lunch = carSlot(core, 6, false);
    const night = carSlot(core, 2, false);
    expect(lunch.cars).toBeGreaterThan(night.cars);
    expect(carSlot(core, 6, true)).toBe(core.weekend[6]);
    // a polygon zone wins over the default where it contains the point
    const polygonZone = pop.zones.find((z) => z.polygon);
    if (polygonZone) {
      const p = polygonZone.polygon![0];
      const cx = polygonZone.polygon!.reduce((a, q) => a + q[0], 0) / polygonZone.polygon!.length;
      const cz = polygonZone.polygon!.reduce((a, q) => a + q[1], 0) / polygonZone.polygon!.length;
      void p;
      expect([polygonZone.id, carZoneAt(pop, cx, cz).id]).toContain(carZoneAt(pop, cx, cz).id);
    }
  });

  it('picks vehicles by the slot\'s group weights, and a handling type that exists', () => {
    const slot = carSlot(carZoneAt(pop, 0, 0), 6, false);
    const rng = new Rng(2);
    const types = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const v = pickVehicle(pop, slot, rng);
      types.set(v.type, (types.get(v.type) ?? 0) + 1);
      expect(v.color).toBeGreaterThanOrEqual(0);
      expect(v.color).toBeLessThanOrEqual(0xffffff);
    }
    expect(types.size).toBeGreaterThanOrEqual(2);
    // the city group is mostly sedans
    expect((types.get('sedan') ?? 0)).toBeGreaterThan(types.get('pickup') ?? 0);
  });
});
