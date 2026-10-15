import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePaths } from '../../shared/walk';
import { WalkGraph } from './graph';
import { GENERIC_POPULATION, parsePopulation, slotOf, zoneAt } from './population';
import { ScenarioIndex, slotPosition } from './scenarios';

/** A 3 x 3 grid of sidewalk nodes 10 m apart, with the middle row joined to the others only by a crossing. */
function grid() {
  const nodes: [number, number, number][] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) nodes.push([c * 10, 0, r * 10]);
  const edges: number[] = [];
  const e = (a: number, b: number, attr = 0) => edges.push(a, b, attr);
  // rows 0 and 2 are sidewalks; row 1 nodes hang off by a crossing at column 0 and a longer detour at column 2
  e(0, 1); e(1, 2); e(6, 7); e(7, 8);
  e(0, 3, 1); // crossing
  e(3, 6, 1); // crossing
  e(2, 5, 0); e(5, 8, 0); // the long way round, on sidewalks
  return parsePaths({
    version: 1,
    nodes,
    attrs: [{ kind: 'sidewalk', width: 2 }, { kind: 'crossing', width: 3, crossing: { id: null, marked: true, signals: false, junction: null, leg: null, road: null } }],
    edges,
  })!;
}

describe('the walk graph', () => {
  it('routes by the shortest way, preferring sidewalks to crossings, and finds no way to a node with no edge', () => {
    const g = new WalkGraph(grid());
    expect(g.nodeCount).toBe(9);
    // 0 to 8: down the crossings is 20 m + penalties, the sidewalk round is 40 m: crossings win only when cheaper
    const r = g.route(0, 8)!;
    expect(r[0]).toBe(0);
    expect(r[r.length - 1]).toBe(8);
    expect(r.every((n, i) => i === 0 || g.edgeBetween(r[i - 1], n) >= 0)).toBe(true);
    // 0 to 2 along the sidewalk
    expect(g.route(0, 2)).toEqual([0, 1, 2]);
    // node 4 has no edges: unreachable
    expect(g.route(0, 4)).toBeNull();
    expect(g.route(5, 5)).toEqual([5]);
  });

  it('finds the nearest node and the nearest point on an edge, and counts sidewalk length by cell', () => {
    const g = new WalkGraph(grid());
    expect(g.nearestNode(11, 1, 20)).toBe(1);
    const hit = g.nearestEdge(15, 2, 5)!;
    expect(hit.edge).toBe(g.edgeBetween(1, 2));
    expect(hit.x).toBeCloseTo(15, 3);
    expect(hit.d).toBeCloseTo(2, 3);
    expect(g.nearestEdge(15, 2, 1)).toBeNull();
    // 4 sidewalk edges in the rows plus 2 in column 2, each 10 m; crossings do not count
    let sidewalk = 0;
    for (const v of g.cellLength.values()) sidewalk += v;
    expect(sidewalk).toBeCloseTo(60, 3);
  });

  it('rejects a malformed network instead of half-loading it', () => {
    expect(parsePaths({ version: 1, nodes: [[0, 0, 0]], attrs: [{ kind: 'sidewalk', width: 2 }], edges: [0, 1, 0] })).toBeNull();
    expect(parsePaths({ version: 2 })).toBeNull();
  });
});

describe('the population table', () => {
  it('parses the generic table and finds the slot for a time of day', () => {
    const z = zoneAt(GENERIC_POPULATION, 0, 0);
    expect(z.isDefault).toBe(true);
    expect(slotOf(z, 6, false).peds).toBeGreaterThan(slotOf(z, 1, false).peds);
  });

  const atlanta = 'data/cities/atlanta/population.json';
  it.skipIf(!existsSync(atlanta))("parses Atlanta's table: busy at lunch, empty at 4 a.m., polygons beat the default", () => {
    const pop = parsePopulation(JSON.parse(readFileSync(atlanta, 'utf8')));
    const core = zoneAt(pop, 0, 0);
    expect(slotOf(core, 6, false).peds).toBeGreaterThan(slotOf(core, 2, false).peds);
    const ids = new Set(pop.zones.map((z) => z.id));
    expect(ids.size).toBe(pop.zones.length);
    // a point in some polygon zone is not in the default zone
    const poly = pop.zones.find((z) => z.polygon)!;
    const mid = poly.polygon!.reduce((a, p) => [a[0] + p[0] / poly.polygon!.length, a[1] + p[1] / poly.polygon!.length], [0, 0]);
    expect(zoneAt(pop, mid[0], mid[1]).id).toBe(poly.id);
    for (const g of Object.values(pop.pedGroups)) expect(g.outfits.every((o) => o >= 1 && o <= 5)).toBe(true);
  });

  it('refuses a table without exactly one default zone', () => {
    const raw = JSON.parse(readFileSync('src/shared/data/defaultPopulation.json', 'utf8'));
    raw.zones.push({ ...raw.zones[0], id: 'other' });
    expect(() => parsePopulation(raw)).toThrow(/default/);
  });
});

describe('scenario points', () => {
  it('counts the people at each point and spreads a group round it', () => {
    const idx = new ScenarioIndex({ version: 1, points: [{ id: 's0', type: 'bench', x: 5, y: 0, z: 5, yaw: 0, cap: 2, src: 'osm' }, { id: 's1', type: 'plaza', x: 40, y: 0, z: 40, yaw: 1, cap: 4, src: 'synth' }] });
    expect(idx.free(0)).toBe(2);
    idx.take(0, 2);
    expect(idx.free(0)).toBe(0);
    idx.release(0);
    expect(idx.free(0)).toBe(1);
    // two on a bench sit side by side, a metre apart or less, both facing the same way
    const a = slotPosition(idx.points[0], 0, 2, false);
    const b = slotPosition(idx.points[0], 1, 2, false);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1);
    expect(a.yaw).toBe(b.yaw);
    // a chatting group faces its middle
    const ring = [0, 1, 2].map((i) => slotPosition(idx.points[1], i, 3, true));
    const cx = ring.reduce((s, p) => s + p.x, 0) / 3, cz = ring.reduce((s, p) => s + p.z, 0) / 3;
    for (const p of ring) {
      const toMid = Math.atan2(cx - p.x, cz - p.z);
      expect(Math.abs(Math.atan2(Math.sin(toMid - p.yaw), Math.cos(toMid - p.yaw)))).toBeLessThan(0.5);
    }
  });
});
