import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig } from './config.js';
import { readCollision, readHeightmap } from './io/binary.js';
import { decodeGlb } from './io/glb.js';
import { checkTileGrades } from './check-grades.js';
import { connectivity, type LanesFile } from './world/lanes.js';

const cfg = loadTileConfig();
const dir = cfg.outDir;
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
check(tile.format === 'hood-tile' && tile.version === 1, 'tile.json format and version');
for (const f of [tile.heightmap.file, tile.meshes.ground, tile.meshes.roads, tile.meshes.buildings, tile.collision.file, tile.roads, tile.junctions, tile.lanes]) {
  check(existsSync(path.join(dir, f)), `${f} exists (${(statSync(path.join(dir, f)).size / 1024).toFixed(0)} KB)`);
}

const hmBytes = readFileSync(path.join(dir, tile.heightmap.file));
const hm = readHeightmap(new Uint8Array(hmBytes.buffer, hmBytes.byteOffset, hmBytes.byteLength));
check(hm.length === tile.heightmap.cols * tile.heightmap.rows, `height.bin has cols*rows samples (${hm.length})`);
let mn = Infinity, mx = -Infinity;
for (const v of hm) { if (v < mn) mn = v; if (v > mx) mx = v; }
const flat = tile.sources.elevation === 'flat';
console.log(`     elevation ${(tile.baseElevation + mn).toFixed(1)}..${(tile.baseElevation + mx).toFixed(1)} m ASL (base ${tile.baseElevation})`);
check(flat || (tile.baseElevation + mn > 260 && tile.baseElevation + mx < 345), 'elevation range is plausible for Downtown Atlanta');
check(Math.abs(hm[250 * 501 + 250]) < 0.5, 'ground at the origin is about y = 0');

const colBytes = readFileSync(path.join(dir, tile.collision.file));
const col = readCollision(new Uint8Array(colBytes.buffer, colBytes.byteOffset, colBytes.byteLength), tile.collision.vertexCount, tile.collision.indexCount);
let maxIdx = 0;
for (const i of col.indices) if (i > maxIdx) maxIdx = i;
check(maxIdx < tile.collision.vertexCount, `collision indices in range (${col.indices.length / 3} triangles)`);
check(col.positions.every((v) => Number.isFinite(v)), 'collision positions are finite');

for (const key of ['ground', 'roads', 'buildings'] as const) {
  const bytes = readFileSync(path.join(dir, tile.meshes[key]));
  const doc = await decodeGlb(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const root = doc.getRoot();
  let tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices()!.getCount() / 3;
  const ext = root.listExtensionsUsed().map((e) => e.extensionName);
  console.log(`     ${key}.glb: ${root.listMeshes().length} meshes, ${root.listMaterials().map((m) => m.getName()).join(', ')}, ${tris} triangles, ${ext.join('+')}`);
  check(tris > 0 && ext.includes('EXT_meshopt_compression'), `${key}.glb loads, has geometry, uses meshopt`);
  // Chunked: one mesh per chunk and material (ground: two levels of detail), each with its chunk in the node extras.
  const grid = tile.chunks;
  check(!!grid && grid.cols * grid.rows > 0, 'tile.json describes the chunk grid');
  const nodes = root.listNodes().filter((n) => n.getMesh());
  const extras = nodes.map((n) => n.getExtras() as { chunk?: [number, number]; lod?: number });
  check(extras.every((e) => Array.isArray(e.chunk) && e.chunk[0] >= 0 && e.chunk[0] < grid.cols && e.chunk[1] >= 0 && e.chunk[1] < grid.rows), `${key}.glb nodes all name a chunk inside the grid`);
  const maxCalls = grid.cols * grid.rows * (key === 'ground' ? 2 : key === 'roads' ? 6 : 3);
  check(nodes.length <= maxCalls, `${key}.glb meshes (${nodes.length}) are at most chunks x materials`);
  if (key === 'ground') {
    const lods = new Set(extras.map((e) => e.lod));
    check(lods.has(0) && lods.has(1), 'ground.glb has both levels of detail');
    check(extras.filter((e) => e.lod === 0).length === grid.cols * grid.rows, 'ground.glb has every chunk at level 0');
  }
}

const roads = JSON.parse(readFileSync(path.join(dir, tile.roads), 'utf8')).roads as { bridge: boolean; points: number[][]; class: string }[];
const bridges = roads.filter((r) => r.bridge);
const classes: Record<string, number> = {};
for (const r of roads) classes[r.class] = (classes[r.class] ?? 0) + 1;
console.log(`     roads.json: ${roads.length} roads (${bridges.length} on decks)`, classes);
check(roads.length > 300, 'road count is reasonable');
check(bridges.length > 20, 'elevated roads are present');
check(roads.every((r) => r.points.length >= 2 && r.points.every((p) => p.every(Number.isFinite))), 'road points are finite');

// grades: the heightmap and decks the sim drives on (see check-grades.ts)
const grades = checkTileGrades(dir);
console.log(grades.text.split('\n').map((l) => `     ${l}`).join('\n'));
check(grades.ok, 'drivable grades are within the limits');

// markings and junctions
{
  const bytes = readFileSync(path.join(dir, tile.meshes.roads));
  const doc = await decodeGlb(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const kinds = new Map<string, number>();
  for (const n of doc.getRoot().listNodes()) {
    const k = (n.getExtras() as { kind?: string }).kind;
    if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  check((kinds.get('markings') ?? 0) > 5, `roads.glb has marking meshes (${kinds.get('markings') ?? 0} chunks)`);
  check(!kinds.has('crosswalk'), 'crossings are markings, not ribbons');
  check(doc.getRoot().listMaterials().some((m) => m.getName() === 'road_markings'), 'roads.glb has the road_markings material');
}
const jn = JSON.parse(readFileSync(path.join(dir, tile.junctions), 'utf8')) as {
  junctions: { id: string; control: string; polygon: number[][]; legs: { road: string; trim: number; stopLine: number[] | null }[] }[];
  signals: { junction: string | null }[];
  stops: unknown[];
  crossings: unknown[];
};
const control = (c: string) => jn.junctions.filter((j) => j.control === c).length;
console.log(`     junctions.json: ${jn.junctions.length} junctions (${control('signals')} signalised, ${control('stop')} stop-controlled), ${jn.signals.length} signals, ${jn.stops.length} stop signs, ${jn.crossings.length} crossings`);
check(jn.junctions.length > 400, 'junction polygons are present');
check(control('signals') > 40, 'signalised junctions are present');
check(jn.junctions.every((j) => j.polygon.length >= 3 && j.legs.length >= 3 && j.legs.every((l) => l.trim > 0)), 'every junction has a polygon and cut-back legs');
check(jn.junctions.filter((j) => j.control === 'signals').every((j) => j.legs.some((l) => l.stopLine)), 'signalised junctions have stop lines');
{
  const ids = new Set(roads.map((r) => (r as unknown as { id: string }).id));
  check(jn.junctions.every((j) => j.legs.every((l) => ids.has(l.road))), 'junction legs name roads in roads.json');
}

// the walk network and its scenario points
{
  check(!!tile.paths && existsSync(path.join(dir, tile.paths)), `paths.json exists (${tile.paths ? (statSync(path.join(dir, tile.paths)).size / 1024).toFixed(0) : 0} KB)`);
  const pf = JSON.parse(readFileSync(path.join(dir, tile.paths), 'utf8')) as {
    version: number;
    nodes: number[][];
    attrs: { kind: string; width: number; crossing?: { junction: string | null; leg: number | null; signals: boolean; marked: boolean } }[];
    edges: number[];
  };
  const nn = pf.nodes.length;
  check(pf.version === 1 && pf.edges.length % 3 === 0, 'paths.json version and edge triples');
  let edgesOk = true;
  for (let i = 0; i < pf.edges.length; i += 3) if (!(pf.edges[i] < nn && pf.edges[i + 1] < nn && pf.edges[i + 2] < pf.attrs.length)) edgesOk = false;
  check(edgesOk && pf.nodes.every((n) => n.every(Number.isFinite)), 'path edges name nodes and attributes that exist');
  // connectivity
  const parent = Array.from({ length: nn }, (_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < pf.edges.length; i += 3) parent[find(pf.edges[i])] = find(pf.edges[i + 1]);
  const len = new Map<number, number>();
  const length = (i: number) => Math.hypot(pf.nodes[pf.edges[i]][0] - pf.nodes[pf.edges[i + 1]][0], pf.nodes[pf.edges[i]][2] - pf.nodes[pf.edges[i + 1]][2]);
  let totalLen = 0;
  const byKind: Record<string, number> = {};
  for (let i = 0; i < pf.edges.length; i += 3) {
    const l = length(i);
    totalLen += l;
    len.set(find(pf.edges[i]), (len.get(find(pf.edges[i])) ?? 0) + l);
    const k = pf.attrs[pf.edges[i + 2]].kind;
    byKind[k] = (byKind[k] ?? 0) + l;
  }
  const sorted = [...len.entries()].sort((a, b) => b[1] - a[1]);
  const main = sorted[0]?.[0] ?? -1;
  console.log(`     paths.json: ${nn} nodes, ${pf.edges.length / 3} edges, ${(totalLen / 1000).toFixed(1)} km in ${sorted.length} components; largest ${((sorted[0][1] / totalLen) * 100).toFixed(1)}%, next ${sorted.slice(1, 4).map((c) => Math.round(c[1]) + ' m').join(', ')}`, Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v)])));
  check(totalLen > 60000, 'the walk network is big enough (over 60 km)');
  check(sorted[0][1] / totalLen > 0.9, 'over 90% of the walk network is one connected component');
  const spawn = tile.spawns.player;
  let nearest = Infinity;
  for (let i = 0; i < pf.edges.length; i += 3) {
    if (find(pf.edges[i]) !== main) continue;
    const a = pf.nodes[pf.edges[i]], b = pf.nodes[pf.edges[i + 1]];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const l2 = dx * dx + dz * dz;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((spawn.x - a[0]) * dx + (spawn.z - a[2]) * dz) / l2));
    nearest = Math.min(nearest, Math.hypot(spawn.x - (a[0] + t * dx), spawn.z - (a[2] + t * dz)));
  }
  check(nearest < 12, `the player spawn is ${nearest.toFixed(1)} m from the main walk network`);
  const crossings = pf.attrs.filter((a) => a.crossing);
  const jids = new Map(jn.junctions.map((j) => [j.id, (j as unknown as { legs: unknown[] }).legs.length]));
  const bad = crossings.filter((c) => c.crossing!.junction !== null && !((c.crossing!.leg ?? -1) >= 0 && (c.crossing!.leg ?? 99) < (jids.get(c.crossing!.junction!) ?? 0)));
  console.log(`     crossings: ${crossings.length} (${crossings.filter((c) => c.crossing!.signals).length} with a walk light, ${crossings.filter((c) => c.crossing!.junction).length} at junctions, ${crossings.filter((c) => c.crossing!.marked).length} marked)`);
  check(bad.length === 0, 'crossings name a junction and leg that exist');
  check(crossings.filter((c) => c.crossing!.signals).length > 100, 'walk lights are present');
  check(tile.scenarios && existsSync(path.join(dir, tile.scenarios)), 'scenarios.json exists');
  const sc = JSON.parse(readFileSync(path.join(dir, tile.scenarios), 'utf8')) as { points: { type: string; x: number; z: number; cap: number }[]; stats: { byType: Record<string, number>; osm: number; synth: number } };
  console.log(`     scenarios.json: ${sc.points.length} points (${sc.stats.osm} OSM, ${sc.stats.synth} synthesised)`, sc.stats.byType);
  check(['bench', 'busstop', 'shopfront', 'eatery', 'corner', 'lawn', 'plaza'].every((t) => (sc.stats.byType[t] ?? 0) > 0), 'scenario points of every common type exist');
  check(sc.points.every((p) => Number.isFinite(p.x + p.z) && p.cap >= 1 && Math.abs(p.x) < 1000 && Math.abs(p.z) < 1000), 'scenario points are finite, inside the tile and have a capacity');
}

// lanes: the directed lane graph traffic drives on
{
  const lanes = JSON.parse(readFileSync(path.join(dir, tile.lanes), 'utf8')) as LanesFile;
  const st = lanes.stats;
  const conn = connectivity(lanes);
  console.log(`     lanes.json: ${st.lanes} lanes (${st.laneKm} km), ${st.connectors} connectors, ${st.junctions} junctions + ${st.implicitJunctions} implicit; largest strongly connected component ${(conn.share * 100).toFixed(1)}% of lane length, ${(conn.streetShare * 100).toFixed(1)}% of surface streets (freeways run off the clipped tile and cannot loop back)`);
  check(st.lanes > 1500 && st.connectors > 1500, 'lane graph has lanes and connectors');
  check(conn.streetShare > 0.7, `surface streets are mostly strongly connected (${(conn.streetShare * 100).toFixed(1)}% in the largest component, at least 70%)`);
  const n = lanes.edges.length;
  check(lanes.edges.every((e) => (e.t === 1 ? e.to >= 0 && e.to < n : e.next.every((x) => x >= 0 && x < n)) && e.pts.length >= 6 && e.pts.every(Number.isFinite)), 'lane graph edges are well formed');
  const jids = new Set(lanes.junctions.map((j) => j.id));
  check(lanes.edges.every((e) => (e.t === 0 ? !e.j || jids.has(e.j) : jids.has(e.j))), 'lane graph names junctions it lists');
  const signalised = lanes.junctions.filter((j) => j.control === 'signals');
  check(signalised.length > 40 && signalised.every((j) => (j.heads?.length ?? 0) > 0), `signalised junctions have signal heads (${signalised.length})`);
  check(lanes.edges.filter((e) => e.t === 1).every((c) => c.t === 1 && c.c.every((o) => lanes.edges[o].t === 1)), 'conflicts point at connectors');
}

const sp = tile.spawns;
check(Math.abs(sp.player.x) < 150 && Math.abs(sp.player.z) < 150, `player spawn is near Five Points (${sp.player.x}, ${sp.player.z})`);
check(Math.hypot(sp.vehicle.x, sp.vehicle.z) < 300, `vehicle spawn is near the origin (${sp.vehicle.x}, ${sp.vehicle.z}, heading ${sp.vehicle.heading})`);
check(tile.attribution.length >= 1, `attribution: ${tile.attribution.join(' | ')}`);

const total = ['tile.json', tile.heightmap.file, tile.meshes.ground, tile.meshes.roads, tile.meshes.buildings, tile.collision.file, tile.roads, tile.junctions, tile.lanes, tile.paths, tile.scenarios].reduce((a, f) => a + statSync(path.join(dir, f)).size, 0);
check(total < 15 * 1024 * 1024, `total tile size ${(total / 1048576).toFixed(2)} MB is under 15 MB`);
check(total < 10 * 1024 * 1024, `total tile size ${(total / 1048576).toFixed(2)} MB is under the 10 MB target`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
