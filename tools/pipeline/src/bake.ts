import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig, type TileConfig } from './config.js';
import { simplifyRing, signedArea, type V2 } from './geo.js';
import { collisionBytes, heightmapBytes } from './io/binary.js';
import { encodeGlb, type GlbPart, type MaterialSpec } from './io/glb.js';
import { MeshBuilder } from './mesh/builder.js';
import { makeChunkGrid, splitMesh, type ChunkGrid } from './mesh/chunks.js';
import { extrudeFootprint } from './mesh/extrude.js';
import { fetchDem, type Dem } from './sources/dem.js';
import { fetchOsm } from './sources/osm.js';
import { fetchOvertureBuildings, type OvertureBuilding } from './sources/overture.js';
import { buildBuildings, styleBuilding } from './world/buildings.js';
import { parseOsm } from './world/osm.js';
import { buildRoads } from './world/roads.js';
import { pickSpawns } from './world/spawns.js';
import { buildGroundMesh, heightmapFromDem, minMax, rasterizeAreas, surfaceHeight } from './world/terrain.js';

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const gray = (v: number): [number, number, number, number] => [linear(v), linear(v), linear(v), 1];

const MAT: Record<string, MaterialSpec> = {
  ground: { name: 'ground', baseColor: [1, 1, 1, 1], roughness: 1 },
  asphalt: { name: 'road_asphalt', baseColor: [1, 1, 1, 1], roughness: 0.95 },
  sidewalk: { name: 'road_sidewalk', baseColor: gray(0.62), roughness: 0.95 },
  crosswalk: { name: 'road_crosswalk', baseColor: gray(0.88), roughness: 0.9 },
  rail: { name: 'road_rail', baseColor: [linear(0.30), linear(0.26), linear(0.22), 1], roughness: 1 },
  concrete: { name: 'road_concrete', baseColor: [1, 1, 1, 1], roughness: 0.9 },
  wall: { name: 'bld_wall', baseColor: [1, 1, 1, 1], roughness: 0.9 },
  roof: { name: 'bld_roof', baseColor: [1, 1, 1, 1], roughness: 0.95 },
  glass: { name: 'bld_glass', baseColor: [1, 1, 1, 1], metallic: 0.35, roughness: 0.25 },
};

/** Ground level of detail 1: every Nth heightmap sample, lowered and skirted (see the contract). */
export const GROUND_LOD1 = { step: 4, lower: 0.5, skirt: 3 };

/** One glTF node per chunk and material. The chunk is in the node's extras, and the name too. */
function chunked(kind: string, mat: MaterialSpec, mb: MeshBuilder, grid: ChunkGrid): GlbPart[] {
  const parts: GlbPart[] = [];
  for (const [key, m] of [...splitMesh(mb, grid)].sort((a, b) => a[0] - b[0])) {
    const cx = key % grid.cols;
    const cz = Math.floor(key / grid.cols);
    parts.push({ name: `${kind}_${cx}_${cz}`, material: mat, positions: m.positions, normals: m.normals, colors: m.colors, indices: m.indices, extras: { kind, chunk: [cx, cz] } });
  }
  return parts;
}

function write(file: string, data: Uint8Array | string): number {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return statSync(file).size;
}

export interface BakeReport {
  outDir: string;
  sizes: Record<string, number>;
  totalBytes: number;
  [k: string]: unknown;
}

export async function bake(cfg: TileConfig = loadTileConfig()): Promise<BakeReport> {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const used = { osm: false, overture: false, dem: false };

  log(`bake ${cfg.id}`);
  const osm = await fetchOsm(cfg);
  used.osm = true;
  log(`osm: ${osm.elements.length} elements`);

  let dem: Dem | null = null;
  try {
    dem = await fetchDem(cfg);
    used.dem = true;
    log(`dem: ${dem.width}x${dem.height}`);
  } catch (e) {
    console.warn(`dem unavailable, writing a flat heightmap: ${(e as Error).message}`);
  }

  let overture: OvertureBuilding[] | null = null;
  let overtureRelease = '';
  try {
    const o = await fetchOvertureBuildings(cfg);
    overture = o.buildings;
    overtureRelease = o.release;
    used.overture = overture.length > 0;
    log(`overture ${o.release}: ${overture.length} buildings`);
  } catch (e) {
    console.warn(`overture unavailable, falling back to OSM buildings: ${(e as Error).message}`);
  }

  const world = parseOsm(osm, cfg.projector);
  log(`parsed: ${world.roads.length} ways, ${world.areas.length} areas, ${world.buildings.length} osm buildings`);

  const b = cfg.bounds;
  const { hm, baseElevation, flat } = heightmapFromDem(dem, cfg.projector, cfg.origin, cfg.cols, cfg.rows, cfg.cellSize, b.minX, b.minZ);
  const mm = minMax(hm);
  log(`heightmap ${hm.cols}x${hm.rows}, base ${baseElevation} m, relief ${mm.min.toFixed(1)}..${mm.max.toFixed(1)} m`);

  const land = rasterizeAreas(world.areas, hm);
  const grid = makeChunkGrid(b, cfg.chunkSize);
  const cellsPerChunk = cfg.chunkSize / hm.cellSize;
  const l1Step = GROUND_LOD1.step * cfg.groundMeshStep;
  if (!Number.isInteger(cellsPerChunk) || cellsPerChunk % l1Step !== 0) throw new Error(`chunk size ${cfg.chunkSize} m must be a multiple of ${l1Step} heightmap cells`);
  const groundParts: GlbPart[] = [];
  const groundTris = [0, 0];
  for (let cz = 0; cz < grid.rows; cz++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const range = { c0: cx * cellsPerChunk, c1: (cx + 1) * cellsPerChunk, r0: cz * cellsPerChunk, r1: (cz + 1) * cellsPerChunk };
      const levels = [
        buildGroundMesh(hm, land, cfg.groundMeshStep, range),
        buildGroundMesh(hm, land, l1Step, range, { lower: GROUND_LOD1.lower, skirt: GROUND_LOD1.skirt }),
      ];
      levels.forEach((g, lod) => {
        groundTris[lod] += g.indices.length / 3;
        groundParts.push({ name: `ground_${cx}_${cz}_L${lod}`, material: MAT.ground, positions: g.positions, normals: g.normals, colors: g.colors, indices: g.indices, extras: { kind: 'ground', chunk: [cx, cz], lod } });
      });
    }
  }
  log(`ground: ${grid.cols}x${grid.rows} chunks, ${groundTris[0]} triangles at full resolution, ${groundTris[1]} at level 1`);

  const roads = buildRoads(world.roads, hm, b);
  log(`roads: ${roads.stats.ways} pieces, ${roads.stats.drivableWays} drivable, ${roads.stats.deckWays} decks (${Math.round(roads.stats.deckMetres)} m), ${roads.stats.piers} piers`);

  const { buildings, stats: bstats } = buildBuildings(overture, world.buildings, cfg.projector, b);
  const wall = new MeshBuilder();
  const roof = new MeshBuilder();
  const glassWall = new MeshBuilder();
  const collision = new MeshBuilder();
  let skipped = 0;
  const kept: V2[][][] = [];
  for (const bd of buildings) {
    const outer = bd.rings[0];
    if (Math.abs(signedArea(outer)) < 6) { skipped++; continue; }
    let minY = Infinity;
    for (const p of outer) minY = Math.min(minY, surfaceHeight(hm, p[0], p[1]));
    const cx = outer.reduce((a, p) => a + p[0], 0) / outer.length;
    const cz = outer.reduce((a, p) => a + p[1], 0) / outer.length;
    minY = Math.min(minY, surfaceHeight(hm, cx, cz));
    const topY = minY + bd.height;
    const style = styleBuilding(bd);
    extrudeFootprint(bd.rings, {
      baseY: minY - 0.3,
      topY,
      wall: style.glass ? glassWall : wall,
      roof,
      wallColor: style.wall,
      roofColor: style.roof,
    });
    kept.push(bd.rings);
    const simple = simplifyRing(outer, 0.4);
    const scratchRoof = new MeshBuilder();
    extrudeFootprint([simple], { baseY: minY - 0.3, topY, wall: collision, roof: scratchRoof, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const base = collision.vertexCount;
    for (let i = 0; i < scratchRoof.vertexCount; i++) collision.vertex(scratchRoof.positions[i * 3], scratchRoof.positions[i * 3 + 1], scratchRoof.positions[i * 3 + 2], 0, 1, 0);
    for (const i of scratchRoof.indices) collision.indices.push(base + i);
  }
  const buildingCollisionTris = collision.triangleCount;
  log(`buildings: ${kept.length} (${skipped} tiny skipped), heights ${JSON.stringify(bstats.heightSources)}`);

  // collision: buildings then elevated deck slabs and piers
  const cbase = collision.vertexCount;
  for (let i = 0; i < roads.collision.vertexCount; i++) {
    collision.vertex(roads.collision.positions[i * 3], roads.collision.positions[i * 3 + 1], roads.collision.positions[i * 3 + 2], 0, 1, 0);
  }
  for (const i of roads.collision.indices) collision.indices.push(cbase + i);

  const spawns = pickSpawns({ roads: roads.json, ways: world.roads, footprints: kept, hm, bounds: b });
  log(`spawns: player ${JSON.stringify(spawns.player)}, vehicle ${JSON.stringify(spawns.vehicle)}`);

  // write
  const out = cfg.outDir;
  const sizes: Record<string, number> = {};
  sizes['height.bin'] = write(path.join(out, 'height.bin'), heightmapBytes(hm.data));
  sizes['ground.glb'] = write(path.join(out, 'ground.glb'), await encodeGlb(groundParts));
  sizes['roads.glb'] = write(
    path.join(out, 'roads.glb'),
    await encodeGlb([
      ...chunked('asphalt', MAT.asphalt, roads.asphalt, grid),
      ...chunked('sidewalk', MAT.sidewalk, roads.sidewalk, grid),
      ...chunked('crosswalk', MAT.crosswalk, roads.crosswalk, grid),
      ...chunked('rail', MAT.rail, roads.rail, grid),
      ...chunked('concrete', MAT.concrete, roads.concrete, grid),
    ]),
  );
  sizes['buildings.glb'] = write(
    path.join(out, 'buildings.glb'),
    await encodeGlb([
      ...chunked('walls', MAT.wall, wall, grid),
      ...chunked('roofs', MAT.roof, roof, grid),
      ...chunked('glass_walls', MAT.glass, glassWall, grid),
    ]),
  );
  sizes['collision.bin'] = write(path.join(out, 'collision.bin'), collisionBytes(collision.positions, collision.indices));
  sizes['roads.json'] = write(path.join(out, 'roads.json'), JSON.stringify({ roads: roads.json }));

  const attribution = [cfg.city.sources.osm.attribution];
  if (used.overture) attribution.push(cfg.city.sources.overture.attribution);
  if (used.dem) attribution.push(cfg.city.sources.elevation.attribution);

  const tile = {
    format: 'hood-tile',
    version: 1,
    id: cfg.id,
    projection: cfg.projection,
    origin: { lat: cfg.origin.lat, lon: cfg.origin.lon, E: round(cfg.projector.E0, 3), N: round(cfg.projector.N0, 3) },
    baseElevation,
    bounds: { ...b },
    heightmap: { file: 'height.bin', cols: hm.cols, rows: hm.rows, cellSize: hm.cellSize, minX: hm.minX, minZ: hm.minZ },
    meshes: { ground: 'ground.glb', roads: 'roads.glb', buildings: 'buildings.glb' },
    chunks: {
      size: grid.size,
      minX: grid.minX,
      minZ: grid.minZ,
      cols: grid.cols,
      rows: grid.rows,
      groundLevels: [{ lod: 0, step: cfg.groundMeshStep }, { lod: 1, step: l1Step, lower: GROUND_LOD1.lower, skirt: GROUND_LOD1.skirt }],
    },
    collision: { file: 'collision.bin', vertexCount: collision.vertexCount, indexCount: collision.indices.length },
    roads: 'roads.json',
    spawns,
    attribution,
    sources: {
      osm: used.osm,
      overtureBuildings: used.overture ? overtureRelease : false,
      elevation: used.dem ? 'usgs-3dep' : 'flat',
    },
  };
  sizes['tile.json'] = write(path.join(out, 'tile.json'), JSON.stringify(tile, null, 2));

  const totalBytes = Object.values(sizes).reduce((a, v) => a + v, 0);
  const report: BakeReport = {
    outDir: out,
    sizes,
    totalBytes,
    baseElevation,
    flatHeightmap: flat,
    heightRange: mm,
    ground: { chunks: grid.cols * grid.rows, trianglesLod0: groundTris[0], trianglesLod1: groundTris[1] },
    roads: { ...roads.stats, triangles: roads.asphalt.triangleCount + roads.sidewalk.triangleCount + roads.crosswalk.triangleCount + roads.rail.triangleCount + roads.concrete.triangleCount },
    buildings: { count: kept.length, skipped, sources: bstats, triangles: wall.triangleCount + roof.triangleCount + glassWall.triangleCount },
    collision: { vertices: collision.vertexCount, triangles: collision.triangleCount, buildingTriangles: buildingCollisionTris },
    spawns,
    seconds: (Date.now() - t0) / 1000,
  };
  log('done');
  console.log(JSON.stringify(report, null, 2));
  if (totalBytes > 15 * 1024 * 1024) console.warn(`WARNING: tile is ${(totalBytes / 1048576).toFixed(1)} MB, over the 15 MB budget`);
  return report;
}

function round(v: number, d: number): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bake().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
