import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../src/mesh/builder';
import { buildJunctions, type JunctionWayInput } from '../src/world/junctions';
import { addBar, addLegMarkings, addRunLines, addStrip, addZebra, assignControls, dashSlices, exportJunctions, lineSpecs, MARK_LIFT, offsetPolyline, RoadMask } from '../src/world/markings';
import type { NodeInfo } from '../src/world/nodes';
import type { V2 } from '../src/geo';

const flat = () => 0;
const way = (highway: string, lanes: number, oneway: boolean, width = lanes * 3.3 + 1.5) => ({ highway, lanes, oneway, width });

describe('line specs', () => {
  it('paints a double yellow and white dashes on a four-lane two-way street', () => {
    const s = lineSpecs(way('primary', 4, false));
    expect(s.filter((l) => l.color[0] > l.color[2] * 3).length).toBe(2); // yellow: red well above blue
    const white = s.filter((l) => l.dash);
    expect(white.map((l) => l.offset).sort((a, b) => a - b)).toEqual([-3.3, 3.3]);
    expect(s.filter((l) => !l.dash).every((l) => Math.abs(l.offset) === 0.15)).toBe(true);
  });
  it('bounds a centre turn lane with yellow when the lanes are odd', () => {
    const s = lineSpecs(way('secondary', 3, false));
    expect(s.length).toBe(2);
    expect(s.map((l) => l.offset)).toEqual([-1.65, 1.65]);
  });
  it('paints edge lines and lane dividers on a one-way motorway, and only edges on a ramp', () => {
    const m = lineSpecs(way('motorway', 3, true, 3 * 3.7 + 3));
    m.filter((l) => !l.dash).forEach((l, i) => expect(l.offset).toBeCloseTo(i === 0 ? -5.55 : 5.55));
    m.filter((l) => l.dash).forEach((l, i) => expect(l.offset).toBeCloseTo(i === 0 ? -1.85 : 1.85));
    expect(m.filter((l) => l.dash).length).toBe(2);
    const ramp = lineSpecs(way('motorway_link', 1, true, 6));
    expect(ramp.length).toBe(2);
    expect(ramp.every((l) => !l.dash)).toBe(true);
  });
  it('paints nothing on residential, service and one-lane roads', () => {
    expect(lineSpecs(way('residential', 2, false)).length).toBe(0);
    expect(lineSpecs(way('service', 1, false)).length).toBe(0);
    expect(lineSpecs(way('tertiary', 1, true)).length).toBe(0);
  });
});

describe('dashes and strips', () => {
  const line: V2[] = [[0, 0], [50, 0], [100, 0]];
  it('centres whole dashes between the insets', () => {
    const d = dashSlices(line, null, 2, 6, 5, 5);
    expect(d.length).toBe(12); // (90 + 6) / 8
    expect(d[0].pts[0][0]).toBeGreaterThanOrEqual(5);
    expect(d[d.length - 1].pts[d[d.length - 1].pts.length - 1][0]).toBeLessThanOrEqual(95);
    for (const x of d) expect(x.pts[x.pts.length - 1][0] - x.pts[0][0]).toBeCloseTo(2, 5);
  });
  it('offsets to the right of the direction of travel', () => {
    // travelling east (+x), right is south (+z)
    const o = offsetPolyline([[0, 0], [10, 0]], 2);
    expect(o[0][1]).toBeCloseTo(2);
  });
  it('lays strips 3 cm over the ground, facing up', () => {
    const mb = new MeshBuilder();
    addStrip(mb, [[0, 0], [5, 0], [10, 0]], null, 0.2, [1, 1, 1], (x) => x * 0.1, MARK_LIFT);
    expect(mb.triangleCount).toBe(4);
    for (let i = 0; i < mb.vertexCount; i++) expect(mb.positions[i * 3 + 1] - mb.positions[i * 3] * 0.1).toBeCloseTo(MARK_LIFT, 5);
    for (let t = 0; t < mb.indices.length; t += 3) {
      const [a, b, c] = [mb.indices[t], mb.indices[t + 1], mb.indices[t + 2]];
      const p = mb.positions;
      const ny = (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]);
      expect(ny).toBeGreaterThan(0);
    }
  });
  it('follows deck heights when given', () => {
    const mb = new MeshBuilder();
    addStrip(mb, [[0, 0], [10, 0]], [20, 22], 0.2, [1, 1, 1], flat, MARK_LIFT);
    expect(mb.positions[1]).toBeCloseTo(20.03);
    expect(mb.positions[7]).toBeCloseTo(22.03);
  });
  it('keeps lines out of the ends of a run that meets a junction', () => {
    const mb = new MeshBuilder();
    const n = addRunLines(mb, { way: { ...way('primary', 2, false), id: 1, name: '', kind: 'car', layer: 0, bridge: false, nodeIds: [], pts: [] }, pts: [[0, 0], [60, 0]], deckY: null, startJ: 0, endJ: 0 }, flat, 0.1);
    expect(n).toBe(2); // the double yellow, two solid lines
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < mb.vertexCount; i++) { minX = Math.min(minX, mb.positions[i * 3]); maxX = Math.max(maxX, mb.positions[i * 3]); }
    expect(minX).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(maxX).toBeLessThanOrEqual(55 + 1e-6);
  });
});

describe('zebra crosswalks and bars', () => {
  it('lays bars only where the crossing is on a road', () => {
    const mask = new RoadMask();
    mask.addPolyline([[-50, 0], [50, 0]], 4); // an east-west road 8 m wide
    const mb = new MeshBuilder();
    // a crossing way running north-south from 6 m north of the road to 6 m south of it: 20 m long, 8 m on the road
    const n = addZebra(mb, [[0, -10], [0, 10]], (x, z) => mask.contains(x, z, 0.3), flat, 0.14, (x, z) => mask.directionAt(x, z));
    expect(n).toBeGreaterThanOrEqual(7);
    expect(n).toBeLessThanOrEqual(8);
    // bars run along the road (x), 3 m long and 0.5 m wide
    const xs: number[] = [];
    for (let i = 0; i < mb.vertexCount; i++) xs.push(mb.positions[i * 3]);
    expect(Math.max(...xs)).toBeCloseTo(1.5);
    expect(Math.min(...xs)).toBeCloseTo(-1.5);
    for (let i = 0; i < mb.vertexCount; i++) {
      expect(mb.positions[i * 3 + 1]).toBeCloseTo(0.14);
      expect(Math.abs(mb.positions[i * 3 + 2])).toBeLessThanOrEqual(4);
    }
  });
  it('winds bars to face up', () => {
    const mb = new MeshBuilder();
    addBar(mb, [0, 0], [0, 1], 3, 0.5, [1, 1, 1], flat, 0.1);
    const p = mb.positions;
    const [a, b, c] = [mb.indices[0], mb.indices[1], mb.indices[2]];
    const ny = (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]);
    expect(ny).toBeGreaterThan(0);
  });
});

function crossroads(len = 40): JunctionWayInput[] {
  const mk = (id: number, pts: V2[], nodeIds: number[]): JunctionWayInput => ({
    way: { id, name: '', highway: 'secondary', kind: 'car', lanes: 2, oneway: false, width: 8, layer: 0, bridge: false, nodeIds, pts },
    pts, nodeIds,
  });
  return [mk(1, [[-len, 0], [-20, 0], [0, 0], [20, 0], [len, 0]], [101, 102, 1, 103, 104]), mk(2, [[0, -len], [0, -20], [0, 0], [0, 20], [0, len]], [201, 202, 1, 203, 204])];
}

describe('signals, stop signs and the legs they control', () => {
  it('marks a junction signalised when a signal sits on its node or on an approach, and gives every approach a stop bar', () => {
    const ways = crossroads();
    const jr = buildJunctions(ways);
    const nodes = new Map<number, NodeInfo>([[102, { id: 102, pos: [-20, 0], signals: true }]]);
    const c = assignControls(jr.junctions, jr.junctionAt, ways, nodes);
    expect(c.junctions[0].control).toBe('signals');
    expect(c.signals).toEqual([{ node: 102, pos: [-20, 0], junction: 0 }]);
    expect(c.junctions[0].legs.every((l) => l.control === 'signals')).toBe(true);
  });
  it('applies a stop sign to the leg its direction says', () => {
    const ways = crossroads();
    const jr = buildJunctions(ways);
    // on the east-west way (index 0, nodes ordered west to east), at the node 20 m west of the junction, controlling traffic going east
    const nodes = new Map<number, NodeInfo>([[102, { id: 102, pos: [-20, 0], stop: { direction: 'forward', all: false } }]]);
    const c = assignControls(jr.junctions, jr.junctionAt, ways, nodes);
    expect(c.junctions[0].control).toBe('stop');
    const j = jr.junctions[0];
    const stopped = j.legs.filter((_, i) => c.junctions[0].legs[i].control === 'stop');
    expect(stopped.length).toBe(1);
    expect(stopped[0].d[0]).toBeLessThan(-0.9); // the west leg: traffic arrives from the west
    // a stop=all sign stops every leg
    const all = assignControls(jr.junctions, jr.junctionAt, ways, new Map([[1, { id: 1, pos: [0, 0], stop: { direction: 'both', all: true } }]]));
    expect(all.junctions[0].legs.every((l) => l.control === 'stop')).toBe(true);
  });
  it('leaves signals far from any junction free-standing', () => {
    const ways = crossroads(80);
    const jr = buildJunctions(ways);
    const c = assignControls(jr.junctions, jr.junctionAt, ways, new Map([[104, { id: 104, pos: [80, 0], signals: true }]]));
    expect(c.signals[0].junction).toBeNull();
    expect(c.junctions[0].control).toBe('none');
  });
});

describe('leg markings and the junctions file', () => {
  it('lays a crosswalk and a stop bar on the right half of an approach, past the cut', () => {
    const ways = crossroads();
    const jr = buildJunctions(ways);
    const j = jr.junctions[0];
    const mask = new RoadMask();
    for (const w of ways) mask.addPolyline(w.pts, 4);
    mask.addPolygon(j.polygon.map((p) => [p.x, p.z] as V2));
    const west = j.legs.find((l) => l.d[0] < -0.9)!;
    const mb = new MeshBuilder();
    const r = addLegMarkings(mb, west, { control: 'signals', crosswalk: false }, 0.07, flat, (x, z) => mask.contains(x, z, 0.3), true);
    expect(r.crosswalk).toBe(true);
    expect(r.stopLine).toBeDefined();
    // the stop bar is beyond the crosswalk, away from the junction, on the side traffic coming from the west drives on (travelling east: right is south, +z)
    expect(r.stopLine!.x).toBeLessThan(-west.trim - 3);
    expect(r.stopLine!.z).toBeGreaterThan(0);
    // no stop bar on a leg that cars only leave
    const none = addLegMarkings(new MeshBuilder(), { ...west, approach: false }, { control: 'signals', crosswalk: false }, 0.07, flat, () => true, false);
    expect(none.stopLine).toBeUndefined();
  });
  it('exports junctions, their legs and the signals', () => {
    const ways = crossroads();
    const jr = buildJunctions(ways);
    const nodes = new Map<number, NodeInfo>([[102, { id: 102, pos: [-20, 0], signals: true }]]);
    const c = assignControls(jr.junctions, jr.junctionAt, ways, nodes);
    const out = exportJunctions(jr.junctions, c, (l) => `osm:way/${ways[l.way].way.id}`, () => 0.07, flat, []);
    expect(out.junctions.length).toBe(1);
    expect(out.junctions[0].control).toBe('signals');
    expect(out.junctions[0].legs.length).toBe(4);
    expect(out.junctions[0].legs[0].road).toMatch(/^osm:way\//);
    expect(out.signals[0]).toMatchObject({ node: 102, junction: 'j0' });
    JSON.stringify(out);
  });
});
