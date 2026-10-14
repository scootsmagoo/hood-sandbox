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
  }[];
  sources: {
    osm: { endpoints: string[]; attribution: string };
    overture: { bucket: string; release: string; attribution: string };
    elevation: { endpoint: string; pixelSizeM: number; attribution: string };
  };
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
  cols: number;
  rows: number;
  outDir: string;
  cacheDir: string;
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
    cols,
    rows: cols,
    outDir: path.join(REPO_ROOT, 'public/tiles', city.id, t.id),
    cacheDir: path.join(CACHE_DIR, city.id, t.id),
  };
}
