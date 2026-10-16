import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjector, type Projector, type Rect } from './geo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PIPELINE_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(PIPELINE_DIR, '../..');
export const CACHE_DIR = path.join(PIPELINE_DIR, 'cache');

export interface CityFile {
  id: string;
  name: string;
  projection: string;
  tiles: {
    id: string;
    name: string;
    origin: { lat: number; lon: number };
    halfSizeM: number;
    scale: number;
    queryMarginM: number;
    heightmapCellSizeM: number;
    /** ground mesh uses every Nth heightmap sample (1 = full resolution) */
    groundMeshStep?: number;
    /** side of the square chunks the meshes are split into, m (default 256) */
    chunkSizeM?: number;
  }[];
  /** Multi-tile grids (docs/contracts/city-tiles.md section 1); baked by `npm run bake:m2` (src/city/). */
  grids?: CityGridSpec[];
  sources: {
    osm: { endpoints: string[]; attribution: string };
    overture: { bucket: string; release: string; attribution: string };
    elevation: { endpoint: string; pixelSizeM: number; attribution: string };
  };
}

/** A grid of square cells in the city frame (x = E - E0, z = -(N - N0) about `origin`), baked tile by tile. */
export interface CityGridSpec {
  id: string;
  name: string;
  origin: { lat: number; lon: number };
  /** the datum of the city frame: y = elevation - baseElevation in every tile */
  baseElevation: number;
  tileSizeM: number;
  heightmapCellSizeM: number;
  groundMeshStep?: number;
  chunkSizeM?: number;
  queryMarginM: number;
  /** output directory, relative to the repo root */
  out: string;
  /** inclusive cell rects [[iMin, jMin], [iMax, jMax]], in bake order; a cell in two regions belongs to the first */
  regions: { id: string; name: string; cells: [[number, number], [number, number]] }[];
}

export interface TileConfig {
  city: CityFile;
  tileId: string;
  id: string;
  projection: string;
  origin: { lat: number; lon: number };
  projector: Projector;
  bounds: Rect;
  /** lon/lat box covering the tile plus the query margin */
  queryBox: { south: number; west: number; north: number; east: number };
  cellSize: number;
  groundMeshStep: number;
  chunkSize: number;
  cols: number;
  rows: number;
  outDir: string;
  cacheDir: string;
  /**
   * Optional (set only by the grid configs of src/city/grid.ts): snap the DEM request outward to a lon/lat pixel grid with
   * these steps, anchored at (lon0, lat0), so neighbouring tiles sample the same pixels at their seam.
   */
  demAlign?: { lonStep: number; latStep: number; lon0: number; lat0: number };
}

export function loadTileConfig(cityId = 'atlanta', tileId = 'm1-five-points'): TileConfig {
  const file = path.join(REPO_ROOT, 'data/cities', cityId, 'city.json');
  const city = JSON.parse(readFileSync(file, 'utf8')) as CityFile;
  const t = city.tiles.find((x) => x.id === tileId);
  if (!t) throw new Error(`tile ${tileId} not in ${file}`);
  if (t.scale !== 1) throw new Error('only scale 1 is supported in M1');
  const projector = createProjector(city.projection, t.origin);
  const h = t.halfSizeM;
  const bounds: Rect = { minX: -h, minZ: -h, maxX: h, maxZ: h };
  const m = h + t.queryMarginM;
  const corners = [
    projector.toLonLat(-m, -m),
    projector.toLonLat(m, -m),
    projector.toLonLat(m, m),
    projector.toLonLat(-m, m),
  ];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const cols = Math.round((2 * h) / t.heightmapCellSizeM) + 1;
  return {
    city,
    tileId,
    id: `${city.id}/${t.id}`,
    projection: city.projection,
    origin: t.origin,
    projector,
    bounds,
    queryBox: { south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons) },
    cellSize: t.heightmapCellSizeM,
    groundMeshStep: t.groundMeshStep ?? 1,
    chunkSize: t.chunkSizeM ?? 256,
    cols,
    rows: cols,
    // HOOD_TILE_OUT writes the bake somewhere else (an experiment that must not disturb the tile the dev server serves)
    outDir: process.env.HOOD_TILE_OUT ? path.resolve(process.env.HOOD_TILE_OUT) : path.join(REPO_ROOT, 'public/tiles', city.id, t.id),
    cacheDir: path.join(CACHE_DIR, city.id, t.id),
  };
}
