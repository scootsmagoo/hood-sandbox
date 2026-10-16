/**
 * `npm run bake:m2 [-- --region downtown,midtown --only 0_-3,1_-3 --skip-existing --no-seams --steps bake,rebase,seams,far,index]`
 * (run it under `flock /tmp/hood-bake.lock`). Bakes a grid of city.json tile by tile (contract section 10):
 *
 *   bake    the ordinary per-tile bake (bake.ts, unchanged) of each cell, in a frame centred on the cell, into
 *           cache/<city>/<grid>/build/<id>/ (prefetch first: `npm run prefetch:m2`, so it runs offline)
 *   rebase  into the city frame, keeping only what stands in the cell: public/tiles/<city>/<grid>/tiles/<id>/
 *   seams   the seam pass over every pair of baked neighbours, and seams.json for every tile
 *   far     far.bin for every tile the run touched
 *   index   index.json over every baked tile of the grid
 *
 * Each step can run on its own (`--steps seams,far,index` redoes the seams without baking).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bake } from '../bake.js';
import { linkNeighbours, parseCityIndex, type CityIndex, type CityTileEntry } from '../../../../src/shared/city.js';
import { cellBakeConfig, listArg, loadGrid, selectCells, type Grid, type GridCell } from './grid.js';
import { datumShift, rebaseTile } from './rebase.js';
import { seamPass, type SeamPassResult } from './seamPass.js';
import { writeFar } from './far.js';
import { listFiles, PROP_KINDS } from './tileFiles.js';

export type Step = 'bake' | 'rebase' | 'seams' | 'far' | 'index';
export const ALL_STEPS: Step[] = ['bake', 'rebase', 'seams', 'far', 'index'];

export interface BakeGridOptions {
  regions?: string[];
  only?: string[];
  skipExisting?: boolean;
  steps?: Step[];
}

const tileDir = (grid: Grid, id: string) => path.join(grid.outDir, 'tiles', id);
const buildDir = (grid: Grid, id: string) => path.join(grid.cacheRoot, 'build', id);
const has = (dir: string) => existsSync(path.join(dir, 'tile.json'));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** The city frame's origin record (E, N of the grid origin, as the M1 tile.json has them). */
export const cityOrigin = (grid: Grid) => ({ lat: grid.spec.origin.lat, lon: grid.spec.origin.lon, E: round(grid.projector.E0, 3), N: round(grid.projector.N0, 3) });

/** The baked tiles of the grid in its output (the cells, in grid order, that have a tile.json). */
export const bakedCells = (grid: Grid): GridCell[] => grid.cells.filter((c) => has(tileDir(grid, c.id)));

/** A content hash of a tile's files (names and bytes), 8 hex. */
export function tileVersion(dir: string): { version: string; bytes: number } {
  const h = createHash('sha1');
  let bytes = 0;
  for (const f of listFiles(dir)) {
    const b = readFileSync(path.join(dir, f));
    h.update(f).update('\0').update(b);
    bytes += b.byteLength;
  }
  return { version: h.digest('hex').slice(0, 8), bytes };
}

export function buildIndex(grid: Grid, seams: SeamPassResult['totals'] | null): CityIndex {
  const cells = bakedCells(grid);
  if (!cells.length) throw new Error(`no baked tiles in ${grid.outDir}`);
  const attribution = new Set<string>();
  const tiles: CityTileEntry[] = cells.map((c) => {
    const dir = tileDir(grid, c.id);
    const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
    for (const a of tile.attribution ?? []) attribution.add(a);
    const rd = (f: string) => (existsSync(path.join(dir, f)) ? JSON.parse(readFileSync(path.join(dir, f), 'utf8')) : null);
    const lanes = rd('lanes.json');
    const paths = rd('paths.json');
    const props = rd('props.json');
    const { version, bytes } = tileVersion(dir);
    return {
      id: c.id,
      i: c.i,
      j: c.j,
      bounds: { ...c.bounds },
      path: `tiles/${c.id}/`,
      version,
      bytes,
      ...(existsSync(path.join(dir, 'far.bin')) ? { far: `tiles/${c.id}/far.bin` } : {}),
      region: c.region,
      counts: {
        lanes: lanes?.edges?.length ?? 0,
        walkNodes: paths?.nodes?.length ?? 0,
        walkEdges: Math.floor((paths?.edges?.length ?? 0) / 3),
        props: props ? PROP_KINDS.reduce((a, k) => a + (props[k]?.length ?? 0), 0) : 0,
        collisionTris: Math.floor((tile.collision?.indexCount ?? 0) / 3),
      },
    };
  });
  linkNeighbours(tiles);
  // the spawn: the tile that holds the M1 spawn (Five Points), with its own spawns
  const S = grid.spec.tileSizeM;
  const m1 = { x: 3.09, z: 8.68 };
  const spawnCell = tiles.find((t) => t.i === Math.floor(m1.x / S) && t.j === Math.floor(m1.z / S)) ?? tiles[0];
  const st = JSON.parse(readFileSync(path.join(tileDir(grid, spawnCell.id), 'tile.json'), 'utf8'));
  const index: CityIndex = {
    format: 'hood-city',
    version: 1,
    id: `${grid.city.id}/${grid.spec.id}`,
    city: grid.city.id,
    projection: grid.city.projection,
    origin: cityOrigin(grid),
    baseElevation: grid.spec.baseElevation,
    tileSize: S,
    heightmapCellSize: grid.spec.heightmapCellSizeM,
    tiles,
    spawn: { tile: spawnCell.id, player: st.spawns.player, vehicle: st.spawns.vehicle },
    attribution: [...attribution],
    ...(seams ? { seams } : {}),
    built: new Date().toISOString(),
  };
  parseCityIndex(JSON.parse(JSON.stringify(index)));
  return index;
}

export async function bakeGrid(opts: BakeGridOptions = {}): Promise<void> {
  const grid = loadGrid();
  const steps = new Set(opts.steps ?? ALL_STEPS);
  const cells = selectCells(grid, opts);
  const t0 = Date.now();
  const log = (m: string) => console.log(`[grid ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  log(`${grid.city.id}/${grid.spec.id}: ${cells.length} tiles, steps ${[...steps].join(', ')} -> ${grid.outDir}`);
  const reportFile = path.join(grid.cacheRoot, 'bake-report.json');
  const report: Record<string, unknown> = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
  const tilesReport = (report.tiles ??= {}) as Record<string, Record<string, unknown>>;
  const saveReport = () => {
    mkdirSync(path.dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
  };
  const touched = new Set<string>();
  const failed: string[] = [];
  for (const cell of cells) {
    const out = tileDir(grid, cell.id);
    if (opts.skipExisting && has(out)) {
      log(`${cell.id}: already baked, skipped`);
      continue;
    }
    const cb = cellBakeConfig(grid, cell);
    const rec = (tilesReport[cell.id] ??= {});
    try {
      if (steps.has('bake')) {
        log(`${cell.id} (${cell.region}): baking in its own frame (origin ${cb.cfg.origin.lat.toFixed(6)}, ${cb.cfg.origin.lon.toFixed(6)})`);
        const tb = Date.now();
        const r = await bake(cb.cfg);
        rec.bakeSeconds = Math.round((Date.now() - tb) / 100) / 10;
        rec.rawBytes = r.totalBytes;
        log(`${cell.id}: baked in ${rec.bakeSeconds} s, ${(r.totalBytes / 1048576).toFixed(1)} MB`);
      }
      if (steps.has('rebase')) {
        const src = buildDir(grid, cell.id);
        if (!has(src)) throw new Error(`${cell.id}: no bake in ${src} (run the bake step)`);
        const raw = JSON.parse(readFileSync(path.join(src, 'tile.json'), 'utf8'));
        const dy = datumShift(raw.baseElevation, grid.spec.baseElevation);
        const { dropped, sizes } = await rebaseTile(src, out, {
          dx: cb.dx,
          dy,
          dz: cb.dz,
          origin: cityOrigin(grid),
          baseElevation: grid.spec.baseElevation,
          bounds: cell.bounds,
          id: `${grid.city.id}/${grid.spec.id}/${cell.id}`,
        });
        rec.offset = { dx: cb.dx, dy, dz: cb.dz, residual: cb.residual };
        rec.dropped = dropped;
        rec.sizes = sizes;
        log(`${cell.id}: in the city frame (+${cb.dx}, ${dy >= 0 ? '+' : ''}${dy}, +${cb.dz}); dropped outside the cell ${JSON.stringify(dropped)}`);
      }
    } catch (e) {
      // one tile failing (most often an Overpass extract the prefetch has not got yet) does not stop the others
      failed.push(cell.id);
      rec.error = (e as Error).message;
      log(`${cell.id}: FAILED (${(e as Error).message}); the other tiles go on`);
      saveReport();
      continue;
    }
    delete rec.error;
    touched.add(cell.id);
    saveReport();
  }
  let seams: SeamPassResult | null = null;
  const seamFile = path.join(grid.outDir, 'seams-report.json');
  if (steps.has('seams')) {
    const baked = bakedCells(grid);
    seams = await seamPass(baked.map((c) => ({ id: c.id, i: c.i, j: c.j, dir: tileDir(grid, c.id) })), log);
    for (const id of seams.rewritten) touched.add(id);
    mkdirSync(grid.outDir, { recursive: true });
    writeFileSync(seamFile, JSON.stringify(seams, null, 2));
    report.seams = { totals: seams.totals, maxDelta: seams.maxDelta, seams: seams.seams.length };
    log(`seams: ${seams.seams.length} seams, ${seams.totals.matched} ports matched, ${seams.totals.unmatched} not, largest step ${seams.totals.maxStep} m; ${seams.rewritten.length} tiles corrected (up to ${seams.maxDelta.toFixed(3)} m)`);
  }
  if (steps.has('far')) {
    const ids = steps.has('rebase') || steps.has('seams') ? [...touched] : cells.map((c) => c.id);
    let total = 0, n = 0;
    for (const id of ids) {
      const dir = tileDir(grid, id);
      if (!has(dir)) continue;
      const r = await writeFar(dir);
      ((tilesReport[id] ??= {}) as Record<string, unknown>).far = r;
      total += r.bytes;
      n++;
    }
    if (n) log(`far: ${n} tiles, ${(total / n / 1024).toFixed(1)} KB on average`);
  }
  if (steps.has('index')) {
    const prev = !seams && existsSync(seamFile) ? (JSON.parse(readFileSync(seamFile, 'utf8')) as SeamPassResult) : seams;
    const index = buildIndex(grid, prev?.totals ?? null);
    writeFileSync(path.join(grid.outDir, 'index.json'), JSON.stringify(index, null, 2));
    log(`index: ${index.tiles.length} tiles, ${(index.tiles.reduce((a, t) => a + (t.bytes ?? 0), 0) / 1048576).toFixed(1)} MB, spawn in ${index.spawn.tile}`);
  }
  report.lastRun = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), tiles: cells.map((c) => c.id), steps: [...steps], failed };
  saveReport();
  if (failed.length) throw new Error(`${failed.length} tiles failed: ${failed.join(', ')} (see ${reportFile})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let steps = (listArg(argv, 'steps') as Step[] | undefined) ?? [...ALL_STEPS];
  for (const s of steps) if (!ALL_STEPS.includes(s)) throw new Error(`unknown step ${s} (${ALL_STEPS.join(', ')})`);
  if (argv.includes('--no-seams')) steps = steps.filter((s) => s !== 'seams');
  bakeGrid({ regions: listArg(argv, 'region'), only: listArg(argv, 'only'), skipExisting: argv.includes('--skip-existing'), steps }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

