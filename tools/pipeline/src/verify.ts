import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig } from './config.js';
import { readCollision, readHeightmap } from './io/binary.js';
import { decodeGlb } from './io/glb.js';

const cfg = loadTileConfig();
const dir = cfg.outDir;
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
check(tile.format === 'hood-tile' && tile.version === 1, 'tile.json format and version');
for (const f of [tile.heightmap.file, tile.meshes.ground, tile.meshes.roads, tile.meshes.buildings, tile.collision.file, tile.roads]) {
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
  check(root.listMeshes().length <= 5, `${key}.glb draw calls (${root.listMeshes().length}) are few`);
}

const roads = JSON.parse(readFileSync(path.join(dir, tile.roads), 'utf8')).roads as { bridge: boolean; points: number[][]; class: string }[];
const bridges = roads.filter((r) => r.bridge);
const classes: Record<string, number> = {};
for (const r of roads) classes[r.class] = (classes[r.class] ?? 0) + 1;
console.log(`     roads.json: ${roads.length} roads (${bridges.length} on decks)`, classes);
check(roads.length > 300, 'road count is reasonable');
check(bridges.length > 20, 'elevated roads are present');
check(roads.every((r) => r.points.length >= 2 && r.points.every((p) => p.every(Number.isFinite))), 'road points are finite');

const sp = tile.spawns;
check(Math.abs(sp.player.x) < 150 && Math.abs(sp.player.z) < 150, `player spawn is near Five Points (${sp.player.x}, ${sp.player.z})`);
check(Math.hypot(sp.vehicle.x, sp.vehicle.z) < 300, `vehicle spawn is near the origin (${sp.vehicle.x}, ${sp.vehicle.z}, heading ${sp.vehicle.heading})`);
check(tile.attribution.length >= 1, `attribution: ${tile.attribution.join(' | ')}`);

const total = ['tile.json', tile.heightmap.file, tile.meshes.ground, tile.meshes.roads, tile.meshes.buildings, tile.collision.file, tile.roads].reduce((a, f) => a + statSync(path.join(dir, f)).size, 0);
check(total < 15 * 1024 * 1024, `total tile size ${(total / 1048576).toFixed(2)} MB is under 15 MB`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
