/**
 * `npm run transit [-- --tile <dir>]`: re-bakes the transit layer of a tile that is already baked (default the served M1 tile),
 * from its own files (the carved heightmap, the roads, the buildings' footprints, the props): writes transit.json, transit.glb and
 * transit.bin and adds `transit` to its tile.json. The full bake (`npm run bake`) does the same as one of its steps. Run it under
 * `flock /tmp/hood-bake.lock` like the bake (other agents bake too).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig, REPO_ROOT } from './config.js';
import { FootprintIndex } from '../../../src/shared/footprints.js';
import { bakeTransit } from './world/transitBake.js';
import { makeHeightmap, surfaceHeight } from './world/terrain.js';
import type { V2 } from './geo.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const cfg = loadTileConfig();
  const dir = path.resolve(arg('tile') ?? cfg.outDir);
  const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
  const hmj = tile.heightmap;
  const hb = readFileSync(path.join(dir, hmj.file));
  const hm = makeHeightmap(hmj.cols, hmj.rows, hmj.cellSize, hmj.minX, hmj.minZ, new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length)));
  const ground = (x: number, z: number) => surfaceHeight(hm, x, z);
  const roads = JSON.parse(readFileSync(path.join(dir, 'roads.json'), 'utf8')).roads;
  const cb = readFileSync(path.join(dir, tile.collision.file));
  const buf = cb.buffer.slice(cb.byteOffset, cb.byteOffset + cb.length);
  const pos = new Float32Array(buf, 0, tile.collision.vertexCount * 3);
  const idx = new Uint32Array(buf, tile.collision.vertexCount * 12, tile.collision.indexCount);
  const fp = new FootprintIndex(pos, idx, tile.collision.buildingTriangles ?? 0);
  const inBuilding = (x: number, z: number) => fp.inside(x, ground(x, z) + 1, z);
  const obstacles: V2[] = [];
  try {
    const props = JSON.parse(readFileSync(path.join(dir, 'props.json'), 'utf8'));
    for (const k of ['trees', 'lamps', 'hydrants', 'bins', 'bollards']) for (const t of props[k] ?? []) obstacles.push([t[0], t[2]]);
  } catch {
    /* no props */
  }
  try {
    const sc = JSON.parse(readFileSync(path.join(dir, 'scenarios.json'), 'utf8'));
    for (const p of sc.points ?? []) if (p.type === 'busstop' || p.type === 'bench') obstacles.push([p.x, p.z]);
  } catch {
    /* no scenarios */
  }
  const res = await bakeTransit({
    repoRoot: REPO_ROOT,
    cityId: cfg.city.id,
    endpoints: cfg.city.sources.osm.endpoints,
    projector: cfg.projector,
    bounds: tile.bounds,
    chunkSize: tile.chunks?.size ?? 256,
    outDir: dir,
    ground,
    roads,
    inBuilding,
    obstacles,
    log: (m) => console.log(m),
  });
  if (res) {
    tile.transit = res.field;
    writeFileSync(path.join(dir, 'tile.json'), JSON.stringify(tile, null, 2));
    console.log(`transit: wrote ${Object.entries(res.sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)} KB`).join(', ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
