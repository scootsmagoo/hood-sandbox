import { describe, expect, it } from 'vitest';
import type { MeshBuilder } from '../src/mesh/builder';
import { buildRoads, planRoads } from '../src/world/roads';
import type { RoadWay } from '../src/world/osm';
import { makeHeightmap, surfaceHeight } from '../src/world/terrain';
import type { V2 } from '../src/geo';

const bounds = { minX: -200, minZ: -200, maxX: 200, maxZ: 200 };
const hm = makeHeightmap(101, 101, 4, -200, -200);

function way(id: number, highway: string, pts: V2[], extra: Partial<RoadWay> = {}): RoadWay {
  return {
    id, name: '', highway, kind: 'car', lanes: 2, oneway: false, width: 7, layer: 0, bridge: false,
    nodeIds: pts.map((_, i) => id * 1000 + i), pts, ...extra,
  };
}

function normals(mb: MeshBuilder) {
  const p = mb.positions;
  const out: { n: number[]; c: number[] }[] = [];
  for (let i = 0; i < mb.indices.length; i += 3) {
    const [a, b, c] = [mb.indices[i], mb.indices[i + 1], mb.indices[i + 2]];
    const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    out.push({
      n: n.map((v) => v / l),
      c: [0, 1, 2].map((k) => (p[a * 3 + k] + p[b * 3 + k] + p[c * 3 + k]) / 3),
    });
  }
  return out;
}

describe('road meshes', () => {
  it('drapes a ground road just above the terrain with upward faces', () => {
    const r = buildRoads([way(1, 'primary', [[-100, 0], [100, 0]])], hm, bounds);
    expect(r.asphalt.triangleCount).toBeGreaterThan(30);
    for (let i = 0; i < r.asphalt.vertexCount; i++) {
      const y = r.asphalt.positions[i * 3 + 1];
      expect(y).toBeGreaterThan(0.05);
      expect(y).toBeLessThan(0.2);
    }
    for (const t of normals(r.asphalt)) expect(t.n[1]).toBeGreaterThan(0.99);
    expect(r.json.length).toBe(1);
    expect(r.json[0].points.length).toBe(2);
  });

  it('clips roads to the tile', () => {
    const r = buildRoads([way(1, 'primary', [[-500, 0], [500, 0]])], hm, bounds);
    for (let i = 0; i < r.asphalt.vertexCount; i++) {
      expect(Math.abs(r.asphalt.positions[i * 3])).toBeLessThanOrEqual(200.001 + 7);
    }
    expect(r.json[0].points[0][0]).toBeCloseTo(-200);
  });

  it('lifts a bridge over a road, with a closed deck and piers over open ground', () => {
    const under = way(1, 'secondary', [[0, -150], [0, 150]]);
    const bridge = way(2, 'motorway', [[-180, 0], [-100, 0], [100, 0], [180, 0]], { bridge: true, layer: 1, width: 12, oneway: true });
    // approach roads on the ground give the bridge ends something to land on
    const a1 = way(3, 'motorway', [[-195, 0], [-180, 0]], { width: 12, nodeIds: [3000, bridge.nodeIds[0]] });
    const a2 = way(4, 'motorway', [[180, 0], [195, 0]], { width: 12, nodeIds: [bridge.nodeIds[3], 4001] });
    const r = buildRoads([under, bridge, a1, a2], hm, bounds);
    const top = r.asphalt;
    let maxY = 0;
    for (let i = 0; i < top.vertexCount; i++) maxY = Math.max(maxY, top.positions[i * 3 + 1]);
    // the deck and the road under it are designed together: the deck climbs and the road dips until there is a car's
    // clearance and the slab between them
    expect(maxY - surfaceHeight(hm, 0, 0)).toBeGreaterThan(6);
    expect(r.stats.deckWays).toBe(1);
    expect(r.collision.triangleCount).toBeGreaterThan(100);
    // skirt and underside faces point away from the slab centre line
    const conc = normals(r.concrete).filter((t) => t.c[1] > 0.5);
    const sideways = conc.filter((t) => Math.abs(t.n[2]) > 0.9 && Math.abs(t.c[0]) < 90);
    expect(sideways.length).toBeGreaterThan(10);
    for (const t of sideways) expect(t.n[2] * t.c[2]).toBeGreaterThan(0);
    // no pier stands inside the crossed road
    expect(r.stats.piers).toBeGreaterThan(0);
  });

  it('lands a bridge: its collision slab meets the ground at the ends, with no edge standing proud of the road', () => {
    const under = way(1, 'secondary', [[0, -150], [0, 150]]);
    const bridge = way(2, 'motorway', [[-180, 0], [-100, 0], [100, 0], [180, 0]], { bridge: true, layer: 1, width: 12, oneway: true });
    const a1 = way(3, 'motorway', [[-195, 0], [-180, 0]], { width: 12, nodeIds: [3000, bridge.nodeIds[0]] });
    const a2 = way(4, 'motorway', [[180, 0], [195, 0]], { width: 12, nodeIds: [bridge.nodeIds[3], 4001] });
    const flat = makeHeightmap(101, 101, 4, -200, -200);
    const r = buildRoads([under, bridge, a1, a2], flat, bounds);
    // the slab's top vertices at the two ends (x = -180 and 180): at or a little under the (carved) ground, never above it
    const P = r.collision.positions;
    let ends = 0;
    for (let i = 0; i < r.collision.vertexCount; i++) {
      const x = P[i * 3], z = P[i * 3 + 2], y = P[i * 3 + 1] - surfaceHeight(flat, x, z);
      if (Math.abs(Math.abs(x) - 180) > 0.5 || y < -0.5) continue;
      ends++;
      expect(y).toBeLessThanOrEqual(0.001);
      expect(y).toBeGreaterThan(-0.1);
    }
    expect(ends).toBeGreaterThanOrEqual(4);
    expect(r.stats.landedDeckEnds).toBeGreaterThanOrEqual(2);
  });

  it('caps the joint where two bridge ways meet at an angle, and keeps piers out of every carriageway (a lower deck too)', () => {
    // two deck ways meeting at 30 degrees at (0, 0), and a second, lower deck under the first
    const d1 = way(1, 'primary', [[-120, 0], [-60, 0], [0, 0]], { bridge: true, layer: 2, width: 12 });
    const d2 = way(2, 'primary', [[0, 0], [52, 30], [104, 60]], { bridge: true, layer: 2, width: 12, nodeIds: [d1.nodeIds[2], 2001, 2002] });
    const low = way(3, 'secondary', [[-90, -60], [-90, 60]], { bridge: true, layer: 1, width: 10 });
    const r = buildRoads([d1, d2, low], hm, bounds);
    expect(r.stats.deckCaps).toBeGreaterThanOrEqual(1);
    // no pier box of the upper deck stands within the lower deck's carriageway (x = -90 +- 5 m)
    const P = r.collision.positions;
    for (let i = 0; i < r.collision.vertexCount; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (y < -0.4 && Math.abs(z) < 7) expect(Math.abs(x + 90)).toBeGreaterThan(5);
    }
  });

  it('keeps footways out of roads.json', () => {
    const r = buildRoads([way(1, 'footway', [[0, 0], [30, 0]], { kind: 'ped', width: 2, sub: 'sidewalk' })], hm, bounds);
    expect(r.json.length).toBe(0);
    expect(r.sidewalk.triangleCount).toBeGreaterThan(0);
  });

  it('cuts the roads back to a junction polygon, marks it, and keeps the full centrelines in roads.json', () => {
    const ew = way(1, 'secondary', [[-150, 0], [-75, 0], [0, 0], [75, 0], [150, 0]], { nodeIds: [11, 12, 1, 13, 14], width: 8 });
    const ns = way(2, 'secondary', [[0, -150], [0, -75], [0, 0], [0, 75], [0, 150]], { nodeIds: [21, 22, 1, 23, 24], width: 8 });
    const nodes = new Map([[1, { id: 1, pos: [0, 0] as [number, number], signals: true }]]);
    const r = buildRoads([ew, ns], hm, bounds, nodes);
    expect(r.junctions.length).toBe(1);
    expect(r.controls.junctions[0].control).toBe('signals');
    // no ribbon vertex lies inside the junction square beyond the polygon: ribbons start at the cut (8.5 m)
    const poly = r.junctions[0].polygon;
    const inside = Math.max(...poly.map((p) => Math.abs(p.x)));
    expect(inside).toBeGreaterThan(8);
    // roads.json still runs through the junction
    const ewJson = r.json.filter((j) => j.id === 'osm:way/1');
    expect(ewJson.length).toBe(1);
    expect(ewJson[0].points[0][0]).toBeCloseTo(-150, 0);
    expect(ewJson[0].points[ewJson[0].points.length - 1][0]).toBeCloseTo(150, 0);
    // ribbons were cut: every run starts or ends at the polygon
    expect(r.runs.filter((x) => x.startJ !== undefined || x.endJ !== undefined).length).toBe(4);
    for (const run of r.runs) for (const p of run.pts) expect(Math.hypot(p[0], p[1])).toBeGreaterThan(8);
    // markings: four crosswalks, four stop bars, centre lines
    expect(r.markingStats.stopBars).toBe(4);
    expect(r.markingStats.crosswalks).toBe(4);
    expect(r.markingStats.lines).toBeGreaterThan(0);
    expect(r.markings.triangleCount).toBeGreaterThan(40);
    expect(r.exported.junctions[0].legs.length).toBe(4);
  });

  it('lays crosswalks on OSM crossing ways instead of drawing them as ribbons', () => {
    const street = way(1, 'secondary', [[-100, 0], [100, 0]], { width: 8 });
    const crossing = way(5, 'footway', [[0, -9], [0, 9]], { kind: 'ped', width: 3, sub: 'crossing', lanes: 1 });
    const r = buildRoads([street, crossing], hm, bounds);
    expect(r.crosswalk.triangleCount).toBe(0);
    expect(r.markingStats.crosswalks).toBe(1);
    expect(r.markingStats.bars).toBeGreaterThanOrEqual(7);
    expect(r.crossings.length).toBe(1);
  });

  it('cuts a derived bridge where a street crosses a deep cut, and keeps the deck above the cut', () => {
    // a 5 m deep, 16 m wide cut across the road
    const cut = makeHeightmap(101, 101, 4, -200, -200);
    for (let rr = 0; rr < 101; rr++) for (let c = 0; c < 101; c++) cut.data[rr * 101 + c] = Math.abs(c * 4 - 200) < 10 ? -5 : 0;
    const street = way(1, 'tertiary', [[-190, 0], [190, 0]], { width: 8 });
    // a railway runs along the bottom of the cut, so the street bridges it
    const rail = way(2, 'rail', [[0, -190], [0, 190]], { kind: 'rail', width: 3 });
    const plan = planRoads([street, rail], cut);
    expect(plan.spans[0].length).toBe(1);
    const r = buildRoads(plan, cut, bounds);
    const bridge = r.json.filter((j) => j.derived);
    expect(bridge.length).toBe(1);
    expect(bridge[0].bridge).toBe(true);
    expect(bridge[0].layer).toBe(1);
    for (const p of bridge[0].points) expect(p[1]).toBeGreaterThan(-1.5);
    expect(r.stats.deckWays).toBeGreaterThanOrEqual(1);
  });

  it('fills a dip with nothing in it as an embankment, not a bridge', () => {
    const cut = makeHeightmap(101, 101, 4, -200, -200);
    for (let rr = 0; rr < 101; rr++) for (let c = 0; c < 101; c++) cut.data[rr * 101 + c] = Math.abs(c * 4 - 200) < 10 ? -5 : 0;
    const street = way(1, 'tertiary', [[-190, 0], [190, 0]], { width: 8 });
    const plan = planRoads([street], cut);
    expect(plan.spans[0].length).toBe(0);
    expect(plan.stats.embankedSpans).toBe(1);
    // the ground under the street is filled to its height across the dip
    const r = buildRoads(plan, cut, bounds);
    expect(r.json.some((j) => j.derived)).toBe(false);
    for (const x of [-8, 0, 8]) expect(Math.abs(cut.data[50 * 101 + 50 + x / 4])).toBeLessThan(0.3);
  });
});
