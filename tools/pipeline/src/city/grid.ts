/**
 * A city grid (docs/contracts/city-tiles.md sections 1, 2 and 10): the cells of `city.json` `grids[]`, and the per-tile bake
 * config of each cell. A cell is baked by the ordinary M1 bake in a frame of its own, centred on the cell, and then moved into
 * the city frame by a translation (`dx`, `dy`, `dz`): the projection is a transverse Mercator with a fixed central meridian, so
 * the two frames differ by the projected offset of their origins only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, REPO_ROOT, type CityFile, type CityGridSpec, type TileConfig } from '../config.js';
import { createProjector, type Projector, type Rect } from '../geo.js';

export interface GridCell {
  /** `<i>_<j>` */
  id: string;
  i: number;
  j: number;
  region: string;
  /** the cell in the city frame */
  bounds: Rect;
}

export interface Grid {
  city: CityFile;
  spec: CityGridSpec;
  /** the city frame's projector (origin at the grid origin, Five Points) */
  projector: Projector;
  cells: GridCell[];
  /** tools/pipeline/cache/<city>/<grid> */
  cacheRoot: string;
  /** absolute output directory (public/tiles/<city>/<grid>) */
  outDir: string;
}

export const cellId = (i: number, j: number): string => `${i}_${j}`;

export function cellBounds(spec: Pick<CityGridSpec, 'tileSizeM'>, i: number, j: number): Rect {
  const S = spec.tileSizeM;
  return { minX: i * S, minZ: j * S, maxX: (i + 1) * S, maxZ: (j + 1) * S };
}

/** The cells of a grid in region order (rows north to south, then west to east, within a region); a cell listed twice counts once. */
export function gridCells(spec: CityGridSpec): GridCell[] {
  const seen = new Set<string>();
  const out: GridCell[] = [];
  for (const r of spec.regions) {
    const [[i0, j0], [i1, j1]] = r.cells;
    for (let j = Math.min(j0, j1); j <= Math.max(j0, j1); j++) {
      for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
        const id = cellId(i, j);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, i, j, region: r.id, bounds: cellBounds(spec, i, j) });
      }
    }
  }
  return out;
}

export function readCity(cityId = 'atlanta'): CityFile {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'data/cities', cityId, 'city.json'), 'utf8')) as CityFile;
}

export function loadGrid(cityId = 'atlanta', gridId = 'm2', city: CityFile = readCity(cityId)): Grid {
  const spec = city.grids?.find((g) => g.id === gridId);
  if (!spec) throw new Error(`grid ${gridId} is not in data/cities/${cityId}/city.json`);
  const cells = gridCells(spec);
  return {
    city,
    spec,
    projector: createProjector(city.projection, spec.origin),
    cells,
    cacheRoot: path.join(CACHE_DIR, city.id, spec.id),
    outDir: path.resolve(REPO_ROOT, spec.out),
  };
}

/** Selects cells by `--region a,b` and `--only id,id` (both optional). Keeps the grid order. */
export function selectCells(grid: Grid, opts: { regions?: string[]; only?: string[] }): GridCell[] {
  const regions = opts.regions?.length ? new Set(opts.regions) : null;
  const only = opts.only?.length ? new Set(opts.only) : null;
  if (regions) for (const r of regions) if (!grid.spec.regions.some((x) => x.id === r)) throw new Error(`no region ${r} in grid ${grid.spec.id}`);
  if (only) for (const id of only) if (!grid.cells.some((c) => c.id === id)) throw new Error(`no cell ${id} in grid ${grid.spec.id}`);
  return grid.cells.filter((c) => (!regions || regions.has(c.region)) && (!only || only.has(c.id)));
}

/** The centre of a cell in the city frame. */
export function cellCentre(grid: Grid, c: Pick<GridCell, 'i' | 'j'>): { x: number; z: number } {
  const S = grid.spec.tileSizeM;
  return { x: c.i * S + S / 2, z: c.j * S + S / 2 };
}

/**
 * The lon/lat pixel grid every tile's DEM request snaps to, anchored at the grid origin. The pixels are square **in degrees**:
 * the 3DEP ImageServer's exportImage keeps the requested x extent and stretches the y extent (about the centre) until the
 * pixels are square in degrees, so a request with pixels square in metres comes back covering a different latitude range
 * than asked for (checked with f=pjson: a 672 x 672 request for 33.74361..33.75577 came back as 33.74242..33.75695). With
 * square degree pixels the returned extent is the requested one. The step is the city's `pixelSizeM` north-south (about 1.7 m
 * east-west at Atlanta's latitude).
 */
export function demAlignment(grid: Grid): NonNullable<TileConfig['demAlign']> {
  const step = grid.city.sources.elevation.pixelSizeM / 110574;
  return { lonStep: step, latStep: step, lon0: grid.spec.origin.lon, lat0: grid.spec.origin.lat };
}

export interface CellBake {
  cell: GridCell;
  cfg: TileConfig;
  /** local (the cell's own bake frame) to city frame, in plan: city = local + (dx, dz) */
  dx: number;
  dz: number;
  /** how far the exact projected offset is from (dx, dz), m (asserted under 1e-6) */
  residual: number;
}

/** The largest residual of the local-to-city translation allowed, m. */
export const MAX_RESIDUAL = 1e-6;

/** The per-tile bake config of a cell: an M1 tile of half size S/2 centred on the cell, in a frame of its own. */
export function cellBakeConfig(grid: Grid, cell: GridCell): CellBake {
  const { city, spec } = grid;
  const S = spec.tileSizeM;
  const { x: cx, z: cz } = cellCentre(grid, cell);
  const [lon, lat] = grid.projector.toLonLat(cx, cz);
  const origin = { lat, lon };
  const projector = createProjector(city.projection, origin);
  // the translation from the local frame to the city frame is the projected offset of the two origins; it is the cell centre
  const exDx = projector.E0 - grid.projector.E0;
  const exDz = -(projector.N0 - grid.projector.N0);
  const residual = Math.hypot(exDx - cx, exDz - cz);
  if (!(residual < MAX_RESIDUAL)) throw new Error(`cell ${cell.id}: the local frame is ${residual} m off the cell centre`);
  const h = S / 2;
  const m = h + spec.queryMarginM;
  const corners = [projector.toLonLat(-m, -m), projector.toLonLat(m, -m), projector.toLonLat(m, m), projector.toLonLat(-m, m)];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const cols = Math.round(S / spec.heightmapCellSizeM) + 1;
  const cfg: TileConfig = {
    city,
    tileId: cell.id,
    id: `${city.id}/${spec.id}/${cell.id}`,
    projection: city.projection,
    origin,
    projector,
    bounds: { minX: -h, minZ: -h, maxX: h, maxZ: h },
    queryBox: { south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons) },
    cellSize: spec.heightmapCellSizeM,
    groundMeshStep: spec.groundMeshStep ?? 1,
    chunkSize: spec.chunkSizeM ?? 256,
    cols,
    rows: cols,
    outDir: path.join(grid.cacheRoot, 'build', cell.id),
    cacheDir: path.join(grid.cacheRoot, 'tiles', cell.id),
    demAlign: demAlignment(grid),
  };
  return { cell, cfg, dx: cx, dz: cz, residual };
}

/** Parses `--name a,b` style options of the grid scripts. */
export function listArg(argv: string[], name: string): string[] | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
