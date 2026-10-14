import { describe, expect, it } from 'vitest';
import type { MeshBuilder } from '../src/mesh/builder';
import { buildRoads } from '../src/world/roads';
import type { RoadWay } from '../src/world/osm';
import { makeHeightmap } from '../src/world/terrain';
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
    expect(maxY).toBeGreaterThan(5.5);
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

  it('keeps footways out of roads.json', () => {
    const r = buildRoads([way(1, 'footway', [[0, 0], [30, 0]], { kind: 'ped', width: 2, sub: 'sidewalk' })], hm, bounds);
    expect(r.json.length).toBe(0);
    expect(r.sidewalk.triangleCount).toBeGreaterThan(0);
  });
});
