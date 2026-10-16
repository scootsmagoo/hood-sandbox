import { checkDeckWidths } from './world/deckWidths.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig, REPO_ROOT } from './config.js';
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
{
  // the buildings come first in the mesh (the sim recovers the footprints from their roofs); every one of those triangles is a wall or a roof, so none is under the floor of a deck
  const bt = tile.collision.buildingTriangles;
  check(Number.isInteger(bt) && bt > 0 && bt * 3 <= col.indices.length, `collision says how many of its triangles are buildings (${bt})`);
  let horizontalRoofs = 0;
  for (let t = 0; t < bt; t++) {
    const y = [0, 1, 2].map((k) => col.positions[col.indices[t * 3 + k] * 3 + 1]);
    if (Math.abs(y[0] - y[1]) < 1e-3 && Math.abs(y[1] - y[2]) < 1e-3) horizontalRoofs++;
  }
  check(horizontalRoofs > bt * 0.15 && horizontalRoofs < bt * 0.6, `the building triangles are walls and flat roofs (${horizontalRoofs} roof triangles)`);
}

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
  // decks against their lanes: the barriers stand at the drivable edge, clear of every lane, and no deck is far wider than its lanes
  const dw = checkDeckWidths(roads as unknown as Parameters<typeof checkDeckWidths>[0], lanes.edges as unknown as Parameters<typeof checkDeckWidths>[1]);
  console.log(`     decks: ${dw.decks} deck pieces, ${dw.points} lane points on them; ${dw.lanesPastBarrier} past a barrier, ${dw.decksTooWide} decks more than 2.5 m a side wider than their lanes (a motorway shoulder is 1.5 to 2 m)${dw.worst.length ? `; worst ${dw.worst.slice(0, 5).map((w) => `${w.id} (${w.x.toFixed(0)}, ${w.z.toFixed(0)}) ${w.what} by ${w.by.toFixed(2)} m`).join(', ')}` : ''}`);
  check(dw.lanesPastBarrier === 0 && dw.decksTooWide === 0, 'every lane on a deck is clear of its barriers, and no deck is far wider than its lanes');
}

// mesh attributes (meshFormat 2 and 3) and the anchors file
if (tile.meshFormat >= 2) {
  const load = async (f: string) => { const b = readFileSync(path.join(dir, f)); return decodeGlb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); };
  const have = (doc: Awaited<ReturnType<typeof load>>, kind: string, sems: string[]) => {
    const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh() && (n.getExtras() as { kind?: string }).kind === kind);
    return nodes.length > 0 && nodes.every((n) => n.getMesh()!.listPrimitives().every((p) => sems.every((s) => !!p.getAttribute(s))));
  };
  const bdoc = await load(tile.meshes.buildings);
  check(have(bdoc, 'walls', ['TEXCOORD_0', '_WALL', '_BLD', '_BID']), 'wall meshes carry TEXCOORD_0, _WALL, _BLD and _BID');
  check(have(bdoc, 'glass_walls', ['TEXCOORD_0', '_WALL', '_BLD', '_BID']), 'glass wall meshes carry the wall attributes');
  check(have(bdoc, 'roofs', ['TEXCOORD_0', '_BLD', '_BID', '_SRF']), 'roof meshes carry TEXCOORD_0, _BLD, _BID and _SRF');
  if (tile.meshFormat >= 3) {
    check(have(bdoc, 'walls', ['_LOOK']) && have(bdoc, 'glass_walls', ['_LOOK']) && have(bdoc, 'roofs', ['_LOOK']), 'building meshes carry _LOOK (meshFormat 3)');
    check(Array.isArray(tile.buildingMaterials) && Array.isArray(tile.buildingStyles) && Array.isArray(tile.roofMaterials), 'tile.json names the building materials, styles and roof materials');
  }
  const kinds: string[] = tile.buildingKinds;
  const counts = new Array(kinds.length).fill(0);
  let badUv = 0, badQuad = 0, quads = 0, okKind = true, aoLo = 1, aoHi = 0, badLook = 0;
  const materials: Record<number, number> = {};
  const surfaces = new Set<number>();
  for (const n of bdoc.getRoot().listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    const kind = (n.getExtras() as { kind?: string }).kind;
    for (const p of m.listPrimitives()) {
      const uv = p.getAttribute('TEXCOORD_0')!, bl = p.getAttribute('_BLD')!, col = p.getAttribute('COLOR_0')!, wl = p.getAttribute('_WALL');
      const srf = p.getAttribute('_SRF');
      const lk = p.getAttribute('_LOOK');
      const tmp = [0, 0, 0, 0];
      for (let i = 0; i < uv.getCount(); i++) {
        const u = uv.getElement(i, [0, 0]);
        if (!Number.isFinite(u[0]) || !Number.isFinite(u[1])) badUv++;
        const k = bl.getElement(i, tmp)[0];
        if (k >= kinds.length) okKind = false;
        if (kind === 'walls') counts[k]++;
        const c = col.getElement(i, [0, 0, 0, 0])[3];
        aoLo = Math.min(aoLo, c); aoHi = Math.max(aoHi, c);
        if (srf) surfaces.add(srf.getElement(i, [0, 0, 0, 0])[0]);
        if (lk) {
          const l = lk.getElement(i, [0, 0, 0, 0]);
          if (kind === 'roofs' ? l[0] >= (tile.roofMaterials?.length ?? 99) : l[0] >= (tile.buildingMaterials?.length ?? 99)) badLook++;
          if (l[1] >= (tile.buildingStyles?.length ?? 99) || (l[2] & 7) >= (tile.buildingMaterials?.length ?? 99)) badLook++;
          if (kind !== 'roofs') materials[l[0]] = (materials[l[0]] ?? 0) + 1;
        }
        // a wall vertex lies inside its quad's span: u between the start and the end, v between the bottom (less the skirt) and the top
        if (wl) {
          const w = wl.getElement(i, [0, 0, 0, 0]);
          quads++;
          if (u[0] < w[0] - 0.1 || u[0] > w[0] + w[1] + 0.1 || u[1] < w[2] - 0.4 || u[1] > w[3] + 0.1) badQuad++;
        }
      }
    }
  }
  check(badUv === 0 && okKind, 'building texture coordinates are finite and kind ids are in range');
  if (tile.meshFormat >= 3) {
    check(badLook === 0, `_LOOK ids are in range of the material, style and roof material lists (${badLook} out)`);
    console.log('     wall vertices by material:', Object.fromEntries(Object.entries(materials).map(([k, v]) => [tile.buildingMaterials[+k], v])));
  }
  check(quads > 10000 && badQuad === 0, `wall vertices lie inside the span their _WALL gives (${quads} vertices, ${badQuad} outside)`);
  check(aoLo < 0.5 && aoHi > 0.95, `building ambient occlusion spans ${aoLo.toFixed(2)} to ${aoHi.toFixed(2)}`);
  check([0, 1, 2, 5].every((s) => surfaces.has(s)), `roofs have flat, pitched, parapet and equipment surfaces (${[...surfaces].join(',')})`);
  console.log('     wall vertices by building kind:', Object.fromEntries(kinds.map((k, i) => [k, counts[i]])));
  const rdoc = await load(tile.meshes.roads);
  check(have(rdoc, 'asphalt', ['TEXCOORD_0', 'TEXCOORD_1']) && have(rdoc, 'sidewalk', ['TEXCOORD_0', 'TEXCOORD_1']), 'asphalt and sidewalk meshes carry road texture coordinates');
  const gdoc = await load(tile.meshes.ground);
  check(have(gdoc, 'ground', ['_LAND']), 'ground meshes carry _LAND');
  let aoSeen = 0;
  for (const n of rdoc.getRoot().listNodes()) {
    const p = n.getMesh()?.listPrimitives()[0];
    if (!p || (n.getExtras() as { kind?: string }).kind !== 'concrete') continue;
    const col = p.getAttribute('COLOR_0')!;
    for (let i = 0; i < col.getCount(); i++) if (col.getElement(i, [0, 0, 0, 0])[3] < 0.5) aoSeen++;
  }
  check(aoSeen > 0, `deck undersides are dark (${aoSeen} vertices under 0.5)`);
}
if (tile.props) {
  const pr = JSON.parse(readFileSync(path.join(dir, tile.props), 'utf8')) as { version: number; trees: number[][]; lamps: number[][]; hydrants: number[][]; stats: unknown };
  console.log(`     props.json: ${pr.trees.length} trees, ${pr.lamps.length} lamps, ${pr.hydrants.length} hydrants`, JSON.stringify(pr.stats));
  check(pr.version === 1 && pr.trees.length > 500 && pr.lamps.length > 500, 'props.json has trees and lamps');
  check(pr.trees.every((t) => t.length === 7 && t.every(Number.isFinite) && Math.abs(t[0]) < 1000 && Math.abs(t[2]) < 1000 && t[3] > 1 && t[4] > 0.5 && [0, 1, 2].includes(t[5])), 'tree anchors are finite, inside the tile and well formed');
  check(pr.lamps.every((l) => l.length === 7 && l.every(Number.isFinite) && Math.abs(l[0]) < 1000 && Math.abs(l[2]) < 1000 && [0, 1, 2].includes(l[5])), 'lamp anchors are finite, inside the tile and well formed');
}

if (tile.landmarks) {
  // hero landmarks (world/landmarks.ts): the tile's landmarks.json, the models it names, and their hulls in the collision mesh
  check(existsSync(path.join(dir, tile.landmarks)), `landmarks.json exists (${(statSync(path.join(dir, tile.landmarks)).size / 1024).toFixed(0)} KB)`);
  const lf = JSON.parse(readFileSync(path.join(dir, tile.landmarks), 'utf8')) as { version: number; landmarks: { id: string; name: string; displayName: string; x: number; z: number; radius: number; ring?: number[][]; hero?: { model: string; hash: string; y: number; replaced: string[]; hullTris?: number; lods: { tris: number; from: number }[] } }[] };
  const b = tile.bounds;
  check(lf.version === 1 && lf.landmarks.length > 0 && lf.landmarks.every((l) => l.id && l.name && l.displayName && Number.isFinite(l.x + l.z) && l.radius > 0), `landmarks.json lists landmarks with names and positions (${lf.landmarks.length})`);
  const heroes = lf.landmarks.filter((l) => l.hero);
  console.log(`     ${heroes.length} hero landmarks: ${heroes.map((h) => `${h.id} (${h.hero!.replaced.length} replaced, ${h.hero!.hullTris ?? 0} hull triangles)`).join(', ')}`);
  check(heroes.every((h) => existsSync(path.join(REPO_ROOT, 'public', h.hero!.model)) && existsSync(path.join(REPO_ROOT, 'public', h.hero!.model.replace(/\.glb$/, '.json')))), 'every hero names a model and a sidecar that exist');
  check(heroes.every((h) => h.ring && h.ring.length >= 3 && h.hero!.lods.length >= 1 && Number.isFinite(h.hero!.y) && h.x > b.minX - 400 && h.x < b.maxX + 400 && h.z > b.minZ - 400 && h.z < b.maxZ + 400), 'heroes have a footprint, levels of detail and a place at or near the tile');
  const hullTris = heroes.reduce((a, h) => a + (h.hero!.hullTris ?? 0), 0);
  check(hullTris <= tile.collision.buildingTriangles, `the heroes' hulls (${hullTris} triangles) are among the collision's building triangles`);
}

const sp = tile.spawns;
check(Math.abs(sp.player.x) < 150 && Math.abs(sp.player.z) < 150, `player spawn is near Five Points (${sp.player.x}, ${sp.player.z})`);
check(Math.hypot(sp.vehicle.x, sp.vehicle.z) < 300, `vehicle spawn is near the origin (${sp.vehicle.x}, ${sp.vehicle.z}, heading ${sp.vehicle.heading})`);
check(tile.attribution.length >= 1, `attribution: ${tile.attribution.join(' | ')}`);

const total = ['tile.json', tile.heightmap.file, tile.meshes.ground, tile.meshes.roads, tile.meshes.buildings, tile.collision.file, tile.roads, tile.junctions, tile.lanes, tile.paths, tile.scenarios, tile.props].filter(Boolean).reduce((a, f) => a + statSync(path.join(dir, f)).size, 0);
check(total < 15 * 1024 * 1024, `total tile size ${(total / 1048576).toFixed(2)} MB is under 15 MB`);
check(total < 14 * 1024 * 1024, `total tile size ${(total / 1048576).toFixed(2)} MB is under the 14 MB target`);

// The ground audit (scripts/ground-audit.mjs, docs/ground-audit.md): every lane driven by a physics car at 15, 25 and 35 m/s, the
// surfaces under every lane, the lanes and roads against the buildings. HOOD_GROUND_AUDIT=quick runs every 12th edge at 25 m/s;
// HOOD_GROUND_AUDIT=off skips it (a machine without the root's node_modules).
{
  const mode = process.env.HOOD_GROUND_AUDIT ?? 'full';
  if (mode === 'off') console.log('     ground audit skipped (HOOD_GROUND_AUDIT=off)');
  else {
    const script = path.join(REPO_ROOT, 'scripts/ground-audit.mjs');
    const args = [script, '--tile', dir, '--out', path.join(REPO_ROOT, '.shots/ground'), '--gate', ...(mode === 'quick' ? ['--quick'] : [])];
    const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const lines = out.split('\n').filter((l) => /drive |by kind|gate |GATE|wrote/.test(l));
    for (const l of lines) console.log(`     ${l.replace(/^\[ground [0-9.]+s\] /, '')}`);
    check(r.status === 0, `ground audit${mode === 'quick' ? ' (quick)' : ''}: no lane or main road into a building; launches, steps, jolts, contacts and give-ups within the gate (a ratchet: docs/ground-audit.md)${r.status === 0 ? '' : ` (exit ${r.status}${r.error ? `: ${r.error.message}` : ''})`}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
