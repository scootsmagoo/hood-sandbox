import { describe, expect, it } from 'vitest';
import { buildLanes, connectivity, speedLimit, type ConnectorEdge, type JunctionsInput, type LaneEdge, type RoadInput } from '../src/world/lanes';

const road = (id: string, pts: [number, number][], over: Partial<RoadInput> = {}): RoadInput => ({
  id, class: 'secondary', lanes: 2, oneway: false, bridge: false, layer: 0, width: 7, points: pts.map(([x, z]) => [x, 0, z]), ...over,
});

const leg = (road: string, dir: [number, number], over: Partial<JunctionsInput['junctions'][number]['legs'][number]> = {}) => ({
  road, node: 1, at: [0, 0] as [number, number], dir, approach: true, departure: true, trim: 8.5, control: 'none' as const, stopLine: null, crosswalk: false, ...over,
});

/** A crossroads at the origin of two two-way streets. */
function crossroads(control: 'signals' | 'stop' | 'none' = 'signals', over: { ew?: Partial<RoadInput>; ns?: Partial<RoadInput> } = {}) {
  const roads = [road('ew', [[-100, 0], [100, 0]], over.ew), road('ns', [[0, -100], [0, 100]], over.ns)];
  const j: JunctionsInput = {
    junctions: [{
      id: 'j0', x: 0, y: 0, z: 0, control,
      legs: [
        leg('ew', [-1, 0], { control }), leg('ew', [1, 0], { control }), leg('ns', [0, -1], { control }), leg('ns', [0, 1], { control }),
      ],
    }],
  };
  return { roads, j, file: buildLanes(roads, j) };
}

const lanes = (f: ReturnType<typeof buildLanes>) => f.edges.filter((e): e is LaneEdge => e.t === 0);
const conns = (f: ReturnType<typeof buildLanes>) => f.edges.filter((e): e is ConnectorEdge => e.t === 1 && e.j === 'j0');
const first = (e: LaneEdge | ConnectorEdge): [number, number] => [e.pts[0], e.pts[2]];
const last = (e: LaneEdge | ConnectorEdge): [number, number] => [e.pts[e.pts.length - 3], e.pts[e.pts.length - 1]];

describe('lanes of a plain road', () => {
  it('drives on the right: an eastbound lane lies south of the centreline (+z), a westbound one north', () => {
    const f = buildLanes([road('r', [[-50, 0], [50, 0]])], { junctions: [] });
    const ls = lanes(f);
    expect(ls.length).toBe(2);
    const east = ls.find((l) => l.dir === 1)!;
    const west = ls.find((l) => l.dir === -1)!;
    expect(Math.abs(east.pts[2] - 1.75)).toBeLessThan(0.1);
    expect(Math.abs(west.pts[2] + 1.75)).toBeLessThan(0.1);
    // each runs in its own direction of travel
    expect(last(east)[0]).toBeGreaterThan(first(east)[0]);
    expect(last(west)[0]).toBeLessThan(first(west)[0]);
  });

  it('puts the lanes per direction from `lanes`, with a middle turn lane left empty when the count is odd', () => {
    const four = lanes(buildLanes([road('r', [[-50, 0], [50, 0]], { lanes: 4, width: 14 })], { junctions: [] }));
    expect(four.filter((l) => l.dir === 1).length).toBe(2);
    const three = lanes(buildLanes([road('r', [[-50, 0], [50, 0]], { lanes: 3, width: 10 })], { junctions: [] }));
    expect(three.filter((l) => l.dir === 1).length).toBe(1);
    expect(three.filter((l) => l.dir === -1).length).toBe(1);
    // the lanes stay clear of the middle: lw = 10 / 3, so the first lane is lw * 1 from the centre
    expect(Math.abs(three.find((l) => l.dir === 1)!.pts[2])).toBeCloseTo((10 / 3) * 1, 1);
  });

  it('a one-way road has its lanes centred and runs only along its points', () => {
    const ls = lanes(buildLanes([road('r', [[-50, 0], [50, 0]], { oneway: true, lanes: 3, width: 10 })], { junctions: [] }));
    expect(ls.length).toBe(3);
    expect(ls.every((l) => l.dir === 1)).toBe(true);
    const zs = ls.map((l) => l.pts[2]).sort((a, b) => a - b);
    expect(zs[1]).toBeCloseTo(0, 1);
    expect(zs[0]).toBeCloseTo(-zs[2], 5);
    // left and right neighbours form a chain
    const byK = [...ls].sort((a, b) => a.k - b.k);
    expect(byK[0].left).toBe(-1);
    expect(byK[2].right).toBe(-1);
    expect(f(byK[0].right)).toBe(f(ls.indexOf(byK[1])));
    function f(v: number) { return v; }
  });

  it('speed limits come from maxspeed, else from the class', () => {
    expect(speedLimit({ class: 'secondary' })).toBeCloseTo(15.6, 1);
    expect(speedLimit({ class: 'motorway' })).toBeGreaterThan(speedLimit({ class: 'residential' }));
    expect(speedLimit({ class: 'residential', maxspeed: 72 })).toBeCloseTo(20, 1);
    expect(speedLimit({ class: 'motorway_link' })).toBeLessThan(speedLimit({ class: 'motorway' }));
    const f2 = buildLanes([road('r', [[-50, 0], [50, 0]], { maxspeed: 36 })], { junctions: [] });
    expect(lanes(f2)[0].v).toBeCloseTo(10, 1);
  });

  it('leaves out service roads and the like', () => {
    expect(buildLanes([road('s', [[0, 0], [50, 0]], { class: 'service' })], { junctions: [] }).edges.length).toBe(0);
  });
});

describe('a crossroads', () => {
  const { file } = crossroads();
  const cs = conns(file);

  it('trims the lanes back to the junction polygon', () => {
    const ew = lanes(file).filter((l) => l.road === 'ew');
    expect(ew.length).toBe(4);
    for (const l of ew) {
      const ends = [Math.abs(first(l)[0]), Math.abs(last(l)[0])].sort((a, b) => a - b);
      expect(ends[0]).toBeCloseTo(8.5, 1); // the inner end stops at the trim
      expect(ends[1]).toBeCloseTo(100, 0);
    }
  });

  it('makes a connector for every straight, left and right movement from each approach, and no U-turns', () => {
    expect(cs.length).toBe(12);
    const arrivals = lanes(file).filter((l) => l.j === 'j0');
    expect(arrivals.length).toBe(4);
    for (const a of arrivals) {
      const from = file.edges.indexOf(a);
      const mine = cs.filter((c) => c.from === from);
      expect(mine.map((c) => c.turn).sort()).toEqual(['l', 'r', 's']);
      // none leaves along the road it arrived on
      for (const c of mine) {
        const to = file.edges[c.to] as LaneEdge;
        expect(to.road === a.road && to.dir === -a.dir).toBe(false);
      }
    }
  });

  it('turns the right way: a right turn from the eastbound lane heads south, a left turn heads north', () => {
    const east = lanes(file).find((l) => l.road === 'ew' && l.dir === 1 && l.j === 'j0')!;
    const from = file.edges.indexOf(east);
    const right = cs.find((c) => c.from === from && c.turn === 'r')!;
    const left = cs.find((c) => c.from === from && c.turn === 'l')!;
    expect(last(right)[1]).toBeGreaterThan(5); // +z is south
    expect(last(left)[1]).toBeLessThan(-5);
    // connectors start where the lane ends and end where the next lane starts
    for (const c of cs) {
      const a = file.edges[c.from] as LaneEdge;
      const b = file.edges[c.to] as LaneEdge;
      expect(Math.hypot(first(c)[0] - last(a)[0], first(c)[1] - last(a)[1])).toBeLessThan(0.2);
      expect(Math.hypot(last(c)[0] - first(b)[0], last(c)[1] - first(b)[1])).toBeLessThan(0.2);
    }
  });

  it('records conflicts: crossing straights, a left turn across the oncoming straight, merges into one lane', () => {
    const east = lanes(file).find((l) => l.road === 'ew' && l.dir === 1 && l.j === 'j0')!;
    const west = lanes(file).find((l) => l.road === 'ew' && l.dir === -1 && l.j === 'j0')!;
    const north = lanes(file).find((l) => l.road === 'ns' && l.dir === -1 && l.j === 'j0')!;
    const idx = (e: LaneEdge) => file.edges.indexOf(e);
    const turn = (e: LaneEdge, t: string) => cs.find((c) => c.from === idx(e) && c.turn === t)!;
    const id = (c: ConnectorEdge) => file.edges.indexOf(c);
    // eastbound straight crosses northbound straight
    expect(turn(east, 's').c).toContain(id(turn(north, 's')));
    // eastbound left (crosses oncoming westbound straight) and it yields: both are the same signal group
    expect(turn(east, 'l').c).toContain(id(turn(west, 's')));
    expect(turn(east, 'l').y).toContain(id(turn(west, 's')));
    expect(turn(west, 's').y).not.toContain(id(turn(east, 'l')));
    // opposing straights never conflict
    expect(turn(east, 's').c).not.toContain(id(turn(west, 's')));
    // symmetric
    for (const c of cs) for (const o of c.c) expect((file.edges[o] as ConnectorEdge).c).toContain(id(c));
    // movements of different signal groups are separated by the signal, not by yielding
    expect(turn(east, 's').y).toEqual([]);
  });

  it('tells a car what it faces: the lane and the connector carry the control and the leg', () => {
    for (const l of lanes(file).filter((l) => l.j === 'j0')) {
      expect(l.ctl).toBe('signals');
      expect(l.leg).toBeGreaterThanOrEqual(0);
    }
    expect(file.junctions.find((j) => j.id === 'j0')!.legs?.length).toBe(4);
  });

  it('lays out a stop sign junction: the leg without a sign has the right of way', () => {
    const roads = [road('ew', [[-100, 0], [100, 0]]), road('ns', [[0, -100], [0, 100]])];
    const j: JunctionsInput = {
      junctions: [{
        id: 'j0', x: 0, y: 0, z: 0, control: 'stop',
        legs: [leg('ew', [-1, 0]), leg('ew', [1, 0]), leg('ns', [0, -1], { control: 'stop' }), leg('ns', [0, 1], { control: 'stop' })],
      }],
    };
    const f2 = buildLanes(roads, j);
    const cs2 = f2.edges.filter((e): e is ConnectorEdge => e.t === 1 && e.j === 'j0');
    const eastS = cs2.find((c) => (f2.edges[c.from] as LaneEdge).road === 'ew' && (f2.edges[c.from] as LaneEdge).dir === 1 && c.turn === 's')!;
    const northS = cs2.find((c) => (f2.edges[c.from] as LaneEdge).road === 'ns' && (f2.edges[c.from] as LaneEdge).dir === -1 && c.turn === 's')!;
    expect(northS.y).toContain(f2.edges.indexOf(eastS));
    expect(eastS.y).not.toContain(f2.edges.indexOf(northS));
  });

  it('is strongly connected (the ends of the two-way streets turn round)', () => {
    expect(file.stats.largestComponent).toBeGreaterThan(0.99);
    expect(connectivity(file).share).toBeGreaterThan(0.99);
  });
});

describe('where roads meet without a junction polygon', () => {
  it('joins two roads end to end, lane to lane', () => {
    const f = buildLanes([road('a', [[-60, 0], [0, 0]]), road('b', [[0, 0], [60, 0]])], { junctions: [] });
    expect(f.stats.implicitJunctions).toBeGreaterThanOrEqual(1);
    const eastA = lanes(f).find((l) => l.road === 'a' && l.dir === 1)!;
    expect(eastA.next.length).toBe(1);
    const c = f.edges[eastA.next[0]] as ConnectorEdge;
    const b = f.edges[c.to] as LaneEdge;
    expect(b.road).toBe('b');
    expect(b.dir).toBe(1);
    expect(c.turn).toBe('s');
  });

  it('joins a side road that ends on the middle of another', () => {
    const f = buildLanes([road('main', [[-60, 0], [60, 0]]), road('side', [[0, 40], [0, 0]])], { junctions: [] });
    const side = lanes(f).find((l) => l.road === 'side' && l.dir === 1)!; // heading to the main road
    const turns = side.next.map((id) => (f.edges[id] as ConnectorEdge).turn).sort();
    expect(turns).toEqual(['l', 'r']);
  });

  it('lets a one-way road run into a cul-de-sac end of a two-way road and out again', () => {
    const f = buildLanes([road('a', [[-60, 0], [0, 0]], { oneway: true, lanes: 1, width: 4 })], { junctions: [] });
    expect(lanes(f).length).toBe(1); // one-way: nothing to turn round into
    const g = buildLanes([road('a', [[-60, 0], [0, 0]])], { junctions: [] });
    // a dead end of a two-way road turns round
    expect(connectivity(g).share).toBeGreaterThan(0.99);
  });
});

describe('connectivity', () => {
  it('reports a one-way street leaving the map as outside the loop', () => {
    const f = buildLanes([road('a', [[0, 0], [100, 0]], { oneway: true, lanes: 1, width: 4 }), road('b', [[0, 50], [100, 50]])], { junctions: [] });
    expect(connectivity(f).share).toBeLessThan(1);
  });
});
