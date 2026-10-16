/** A small synthetic baked tile (every file the tile bake writes), for the rebase, seam and far tests. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collisionBytes, heightmapBytes } from '../src/io/binary';
import { encodeGlb, type GlbPart } from '../src/io/glb';
import { MeshBuilder } from '../src/mesh/builder';
import { extrudeFootprint } from '../src/mesh/extrude';
import type { V2 } from '../src/geo';

export interface FixtureOptions {
  /** the tile's bounds (square) */
  minX: number;
  minZ: number;
  size: number;
  cell?: number;
  baseElevation?: number;
  height: (x: number, z: number) => number;
  /** a road along z = roadZ across the whole tile, with one lane each way */
  roadZ?: number;
  id?: string;
}

const MAT = { name: 'm', baseColor: [1, 1, 1, 1] as [number, number, number, number] };

/** Collision: one building prism (walls, then the flat roof) and one deck quad, as bake.ts writes them. */
export function fixtureCollision(rings: V2[][], baseY: number, topY: number, deck: number[]): { positions: number[]; indices: number[]; buildingTriangles: number } {
  const collision = new MeshBuilder();
  for (const r of rings) {
    const roof = new MeshBuilder();
    extrudeFootprint([r], { baseY, topY, wall: collision, roof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const base = collision.vertexCount;
    for (let i = 0; i < roof.vertexCount; i++) collision.vertex(roof.positions[i * 3], roof.positions[i * 3 + 1], roof.positions[i * 3 + 2], 0, 1, 0);
    for (const i of roof.indices) collision.indices.push(base + i);
  }
  const buildingTriangles = collision.triangleCount;
  const b = collision.vertexCount;
  for (let k = 0; k < deck.length; k += 3) collision.vertex(deck[k], deck[k + 1], deck[k + 2], 0, 1, 0);
  collision.quad(b, b + 1, b + 2, b + 3);
  return { positions: collision.positions, indices: collision.indices, buildingTriangles };
}

export async function writeFixtureTile(dir: string, o: FixtureOptions): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const cell = o.cell ?? 4;
  const n = Math.round(o.size / cell) + 1;
  const maxX = o.minX + o.size, maxZ = o.minZ + o.size;
  const h = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = o.height(o.minX + c * cell, o.minZ + r * cell);
  const cx = o.minX + o.size / 2, cz = o.minZ + o.size / 2;
  const rz = o.roadZ ?? cz;
  const y = (x: number, z: number) => o.height(x, z);
  // ground mesh: the heightmap at step 8
  const gpos: number[] = [], gnor: number[] = [], gidx: number[] = [];
  const step = 8, m = Math.floor((n - 1) / step) + 1;
  for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
    const x = o.minX + c * step * cell, z = o.minZ + r * step * cell;
    gpos.push(x, y(x, z), z);
    gnor.push(0, 1, 0);
  }
  for (let r = 0; r + 1 < m; r++) for (let c = 0; c + 1 < m; c++) {
    const a = r * m + c;
    gidx.push(a, a + m, a + 1, a + 1, a + m, a + m + 1);
  }
  const ground: GlbPart[] = [{ name: 'ground_0_0_L0', material: { ...MAT, name: 'ground' }, positions: gpos, normals: gnor, colors: gpos.map(() => 1), indices: gidx, extras: { kind: 'ground', chunk: [0, 0], lod: 0 } }];
  // roads: a ribbon along the road and one junction-surface vertex (TEXCOORD_1 half width 0, TEXCOORD_0 the world x, z)
  const rpos = [o.minX, y(o.minX, rz - 4), rz - 4, maxX, y(maxX, rz - 4), rz - 4, maxX, y(maxX, rz + 4), rz + 4, o.minX, y(o.minX, rz + 4), rz + 4, cx, y(cx, rz), rz];
  const uv0 = Float32Array.from([0, 0, 0, o.size, 8, o.size, 8, 0, cx, rz]);
  const uv1 = Float32Array.from([4, 0, 4, 0, 4, 0, 4, 0, 0, 1]);
  const roads: GlbPart[] = [{
    name: 'asphalt_0_0', material: { ...MAT, name: 'road_asphalt' }, positions: rpos, normals: rpos.map((_, i) => (i % 3 === 1 ? 1 : 0)), colors: rpos.map(() => 1), indices: [0, 3, 1, 1, 3, 2, 0, 1, 4],
    attributes: [{ name: 'TEXCOORD_0', array: uv0, width: 2 }, { name: 'TEXCOORD_1', array: uv1, width: 2 }], extras: { kind: 'asphalt', chunk: [0, 0] },
  }];
  // a building near the middle and one by the east edge (2 m in)
  const ring = (x0: number, z0: number, s: number): V2[] => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
  const rings = [ring(cx - 10, cz + 20, 20), ring(maxX - 22, cz + 30, 20)];
  const by = (r: V2[]) => Math.min(...r.map((p) => y(p[0], p[1])));
  const bld = new MeshBuilder();
  const bldRoof = new MeshBuilder();
  for (const r of rings) extrudeFootprint([r], { baseY: by(r) - 0.3, topY: by(r) + 15, wall: bld, roof: bldRoof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
  const bldU8 = new Uint8Array(bldRoof.vertexCount * 4);
  for (let i = 0; i < bldRoof.vertexCount; i++) bldU8.set([3, 2, 4, 0], i * 4);
  const buildings: GlbPart[] = [
    { name: 'walls_0_0', material: { ...MAT, name: 'bld_wall' }, positions: bld.positions, normals: bld.normals, colors: bld.colors, indices: bld.indices, extras: { kind: 'walls', chunk: [0, 0] } },
    { name: 'roofs_0_0', material: { ...MAT, name: 'bld_roof' }, positions: bldRoof.positions, normals: bldRoof.normals, colors: bldRoof.colors, indices: bldRoof.indices, attributes: [{ name: '_BLD', array: bldU8, width: 4 }], extras: { kind: 'roofs', chunk: [0, 0] } },
  ];
  // collision: the two prisms (each its own run: walls then roof) and a deck
  const col = new MeshBuilder();
  for (const r of rings) {
    const roof = new MeshBuilder();
    extrudeFootprint([r], { baseY: by(r) - 0.3, topY: by(r) + 15, wall: col, roof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const base = col.vertexCount;
    for (let i = 0; i < roof.vertexCount; i++) col.vertex(roof.positions[i * 3], roof.positions[i * 3 + 1], roof.positions[i * 3 + 2], 0, 1, 0);
    for (const i of roof.indices) col.indices.push(base + i);
  }
  const buildingTriangles = col.triangleCount;
  const d0 = col.vertexCount;
  for (const [x, z] of [[maxX - 30, cz - 40], [maxX, cz - 40], [maxX, cz - 30], [maxX - 30, cz - 30]]) col.vertex(x, y(x, z) + 5, z, 0, 1, 0);
  col.quad(d0, d0 + 1, d0 + 2, d0 + 3);
  // the graphs: a road and its two lanes across the tile, a walk path along it, props in and out of the cell
  const lane = (x0: number, x1: number, z: number) => [x0, y(x0, z), z, (x0 + x1) / 2, y((x0 + x1) / 2, z), z, x1, y(x1, z), z];
  const lanes = {
    format: 'hood-lanes', version: 1,
    edges: [
      { t: 0, road: 'osm:way/1', cls: 'secondary', dir: 1, k: 0, n: 1, len: o.size, v: 15, pts: lane(o.minX, maxX, rz + 2), next: [], left: -1, right: -1 },
      { t: 0, road: 'osm:way/1', cls: 'secondary', dir: -1, k: 0, n: 1, len: o.size, v: 15, pts: lane(maxX, o.minX, rz - 2), next: [], left: -1, right: -1 },
    ],
    junctions: [{ id: 'j1', x: cx, z: rz, control: 'signals', legs: [{ dir: [1, 0], approach: true }], heads: [{ leg: 0, x: cx + 5, y: y(cx + 5, rz + 8), z: rz + 8, yaw: 1 }, { leg: 0, x: maxX + 1, y: 0, z: rz + 8, yaw: 1 }] }],
    stats: {},
  };
  const roadsJson = { roads: [{ id: 'osm:way/1', class: 'secondary', name: 'Test St', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: [[o.minX, y(o.minX, rz), rz], [maxX, y(maxX, rz), rz]] }] };
  const junctions = {
    junctions: [{ id: 'j1', x: cx, y: y(cx, rz), z: rz, control: 'signals', nodes: [1], polygon: [[cx - 5, rz - 5], [cx + 5, rz - 5], [cx + 5, rz + 5]], legs: [{ road: 'osm:way/1', node: 1, at: [cx + 5, rz], dir: [1, 0], approach: true, departure: true, trim: 5, control: 'signals', stopLine: [cx + 6, y(cx + 6, rz), rz + 2], crosswalk: true }, { road: 'osm:way/1', node: 1, dir: [-1, 0], approach: true, departure: true, trim: 5, control: 'none', stopLine: null, crosswalk: false }] }],
    signals: [{ node: 2, x: cx + 3, y: y(cx + 3, rz), z: rz, junction: 'j1' }],
    stops: [{ node: 3, x: cx - 3, y: y(cx - 3, rz), z: rz, direction: 'both', all: false, junction: null }],
    crossings: [{ id: 4, points: [[cx, y(cx, rz - 6), rz - 6], [cx, y(cx, rz + 6), rz + 6]], signals: true }],
  };
  const walk: number[][] = [];
  for (let x = o.minX; x <= maxX; x += o.size / 4) walk.push([x, y(x, rz + 6) + 0.1, rz + 6]);
  const pedges: number[] = [];
  for (let k = 0; k + 1 < walk.length; k++) pedges.push(k, k + 1, 0);
  const paths = { version: 1, nodes: walk, attrs: [{ kind: 'sidewalk', width: 2 }], edges: pedges, stats: {} };
  const scenarios = { version: 1, points: [{ id: 's1', type: 'bench', x: cx, y: y(cx, rz + 7), z: rz + 7, yaw: 0, cap: 2, src: 'osm' }, { id: 's2', type: 'bench', x: maxX + 2, y: 0, z: rz + 7, yaw: 0, cap: 2, src: 'synth' }], stats: { total: 2, byType: { bench: 2 }, osm: 1, synth: 1 } };
  const props = {
    version: 1,
    trees: [[cx, y(cx, cz), cz, 10, 3, 0, 0], [maxX, 0, cz, 10, 3, 0, 0], [o.minX, 0, cz, 10, 3, 0, 0]],
    lamps: [[cx + 1, y(cx + 1, cz), cz, 0, 8, 0, 1]],
    hydrants: [[cx + 2, y(cx + 2, cz), cz]], bins: [[o.minX - 1, 0, cz]], bollards: [[cx, 0, maxZ]],
    stats: { trees: { osm: 0 }, lamps: {} },
  };
  const landmarks = { version: 1, landmarks: [{ id: 'l1', name: 'L', displayName: 'L', kind: 'tower', x: cx, z: cz, radius: 40, ring: [[cx - 1, cz - 1], [cx + 1, cz - 1], [cx, cz + 1]], hero: { model: 'm', hash: 'h', y: y(cx, cz), yaw: 0, lods: [], replaced: [], hullTris: 0 } }, { id: 'l2', name: 'M', displayName: 'M', kind: 'park', x: maxX + 30, z: cz, radius: 40 }] };
  const tile = {
    format: 'hood-tile', version: 1, id: o.id ?? 'atlanta/fixture',
    projection: '+proj=tmerc', origin: { lat: 0, lon: 0, E: 0, N: 0 }, baseElevation: o.baseElevation ?? 300,
    bounds: { minX: o.minX, minZ: o.minZ, maxX, maxZ },
    heightmap: { file: 'height.bin', cols: n, rows: n, cellSize: cell, minX: o.minX, minZ: o.minZ },
    meshes: { ground: 'ground.glb', roads: 'roads.glb', buildings: 'buildings.glb' },
    chunks: { size: o.size, minX: o.minX, minZ: o.minZ, cols: 1, rows: 1, groundLevels: [{ lod: 0, step: 1 }] },
    collision: { file: 'collision.bin', vertexCount: col.vertexCount, indexCount: col.indices.length, buildingTriangles },
    roads: 'roads.json', junctions: 'junctions.json', lanes: 'lanes.json', paths: 'paths.json', scenarios: 'scenarios.json', props: 'props.json', landmarks: 'landmarks.json',
    spawns: { player: { x: cx, y: y(cx, cz), z: cz }, vehicle: { x: cx + 3, y: y(cx + 3, cz), z: cz, heading: 0.5 } },
    attribution: ['© OpenStreetMap contributors'],
  };
  const put = (f: string, d: string | Uint8Array) => writeFileSync(path.join(dir, f), d);
  put('height.bin', heightmapBytes(h));
  put('collision.bin', collisionBytes(col.positions, col.indices));
  put('ground.glb', await encodeGlb(ground));
  put('roads.glb', await encodeGlb(roads));
  put('buildings.glb', await encodeGlb(buildings));
  put('roads.json', JSON.stringify(roadsJson));
  put('junctions.json', JSON.stringify(junctions));
  put('lanes.json', JSON.stringify(lanes));
  put('paths.json', JSON.stringify(paths));
  put('scenarios.json', JSON.stringify(scenarios));
  put('props.json', JSON.stringify(props));
  put('landmarks.json', JSON.stringify(landmarks));
  put('tile.json', JSON.stringify(tile, null, 2));
}
