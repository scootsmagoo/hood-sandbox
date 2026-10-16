/**
 * The city index (`index.json`, docs/contracts/city-tiles.md section 1): a sparse grid of M1-format tiles in one frame,
 * and the ring rules that say which of them a player near (x, z) keeps loaded. Pure: no I/O, so the sim worker, the
 * client, Node tests and the pipeline share it.
 */

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface CityTileEntry {
  /** `<i>_<j>`, the grid cell */
  id: string;
  i: number;
  j: number;
  bounds: Rect;
  /** Directory of the tile's files, relative to index.json (ends with `/`). */
  path: string;
  /** Content hash of the tile's files. */
  version?: string;
  bytes?: number;
  /** The skyline level of detail (`far.bin`), relative to index.json. */
  far?: string;
  region?: string;
  /** Upper bounds the runtime may size pools from. */
  counts?: { lanes?: number; walkNodes?: number; walkEdges?: number; props?: number; collisionTris?: number };
  neighbours?: Partial<Record<SeamSide, string | null>>;
}

export type SeamSide = 'n' | 'e' | 's' | 'w';

export interface CityIndex {
  format: 'hood-city';
  version: 1;
  id: string;
  /** The city pack (`data/cities/<city>/`). */
  city: string;
  projection?: string;
  origin: { lat: number; lon: number; E: number; N: number };
  baseElevation: number;
  tileSize: number;
  heightmapCellSize?: number;
  tiles: CityTileEntry[];
  spawn: {
    tile?: string;
    player: { x: number; y: number; z: number };
    vehicle: { x: number; y: number; z: number; heading: number };
  };
  attribution: string[];
  seams?: { matched: number; unmatched: number; maxStep: number };
  built?: string;
  /** An airport in the city (`aeroway.json`, relative to index.json): the aircraft's taxi graph, its stands, lights and map (src/shared/aeroway.ts). */
  aeroway?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function fail(msg: string): never {
  throw new Error(`index.json: ${msg}`);
}

export const tileIdOf = (i: number, j: number): string => `${i}_${j}`;

/** Validates `index.json`. Throws a readable error. */
export function parseCityIndex(json: unknown): CityIndex {
  const j = json as Partial<CityIndex> | null;
  if (!j || typeof j !== 'object') fail('not an object');
  if (j.format !== 'hood-city') fail(`format is ${JSON.stringify(j.format)}, expected "hood-city"`);
  if (j.version !== 1) fail(`unsupported version ${String(j.version)}`);
  if (!isNum(j.tileSize) || j.tileSize <= 0) fail('tileSize is missing');
  if (!Array.isArray(j.tiles) || j.tiles.length === 0) fail('no tiles');
  const S = j.tileSize;
  const tiles: CityTileEntry[] = [];
  const seen = new Set<string>();
  for (const t of j.tiles) {
    if (!t || !isNum(t.i) || !isNum(t.j) || typeof t.path !== 'string') fail('a tile entry is incomplete');
    const id = typeof t.id === 'string' ? t.id : tileIdOf(t.i, t.j);
    if (seen.has(id)) fail(`tile ${id} is listed twice`);
    seen.add(id);
    const bounds = t.bounds ?? { minX: t.i * S, minZ: t.j * S, maxX: (t.i + 1) * S, maxZ: (t.j + 1) * S };
    tiles.push({ ...t, id, bounds, path: t.path.endsWith('/') ? t.path : `${t.path}/` });
  }
  const sp = j.spawn;
  if (!sp?.player || !sp.vehicle || !isNum(sp.player.x) || !isNum(sp.vehicle.x)) fail('spawn is incomplete');
  return {
    format: 'hood-city',
    version: 1,
    id: typeof j.id === 'string' ? j.id : 'unknown',
    city: typeof j.city === 'string' ? j.city : String(j.id ?? '').split('/')[0],
    projection: j.projection,
    origin: j.origin ?? { lat: 0, lon: 0, E: 0, N: 0 },
    baseElevation: isNum(j.baseElevation) ? j.baseElevation : 0,
    tileSize: S,
    heightmapCellSize: j.heightmapCellSize,
    tiles,
    spawn: sp,
    attribution: Array.isArray(j.attribution) ? j.attribution : [],
    seams: j.seams,
    built: j.built,
    ...(typeof j.aeroway === 'string' ? { aeroway: j.aeroway } : {}),
  };
}

/** The grid cell that holds (x, z). */
export function cellOf(index: Pick<CityIndex, 'tileSize'>, x: number, z: number): { i: number; j: number } {
  return { i: Math.floor(x / index.tileSize), j: Math.floor(z / index.tileSize) };
}

/** Distance in plan from (x, z) to a rectangle (0 inside it). */
export function rectDistance(r: Rect, x: number, z: number): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/** The tiles of the index whose cell is within `r` m of (x, z), nearest first (ties by id, so the order is deterministic). */
export function tilesWithin(index: CityIndex, x: number, z: number, r: number): { tile: CityTileEntry; d: number }[] {
  const out: { tile: CityTileEntry; d: number }[] = [];
  for (const t of index.tiles) {
    const d = rectDistance(t.bounds, x, z);
    if (d <= r) out.push({ tile: t, d });
  }
  out.sort((a, b) => a.d - b.d || (a.tile.id < b.tile.id ? -1 : a.tile.id > b.tile.id ? 1 : 0));
  return out;
}

/** The ring radii of section 8 of the contract, m: near load and drop (sim and client) and far (the skyline, client only). */
export interface Rings {
  near: number;
  drop: number;
  far: number;
}

export const RINGS: Record<'high' | 'medium' | 'low', Rings> = {
  high: { near: 900, drop: 1150, far: 4500 },
  medium: { near: 800, drop: 1050, far: 3000 },
  low: { near: 600, drop: 850, far: 2000 },
};

/** The four neighbours of a cell, by side (north is -z). */
export function neighbourCells(i: number, j: number): Record<SeamSide, { i: number; j: number }> {
  return { n: { i, j: j - 1 }, s: { i, j: j + 1 }, e: { i: i + 1, j }, w: { i: i - 1, j } };
}

/** Fills `neighbours` of every tile from the grid. */
export function linkNeighbours(tiles: CityTileEntry[]): void {
  const by = new Map(tiles.map((t) => [tileIdOf(t.i, t.j), t]));
  for (const t of tiles) {
    const nb = neighbourCells(t.i, t.j);
    t.neighbours = {};
    for (const side of ['n', 'e', 's', 'w'] as SeamSide[]) t.neighbours[side] = by.get(tileIdOf(nb[side].i, nb[side].j))?.id ?? null;
  }
}

/** `fixture` (3 x 3 tiles) or `fixture:N` (cells -N..N on both axes): the options of the procedural test city. */
export function fixtureOptions(url: string): { half: number } {
  const m = /^fixture:(\d+)$/.exec(url);
  return { half: m ? Math.max(1, Math.min(8, Number(m[1]))) : 1 };
}
