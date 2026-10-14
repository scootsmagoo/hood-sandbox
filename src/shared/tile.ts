/**
 * Baked map tiles, as described in docs/contracts/m1-tile-format.md. This file reads the files the
 * sim needs (`tile.json`, `height.bin`, `collision.bin`, and `roads.json` when there is one) and
 * nothing else; it never parses glTF.
 * It uses only `fetch` and typed arrays, so it runs in a worker, on the main thread and in Node.
 */
import { generateProceduralTile } from './proceduralTile';

export interface TileManifest {
  format: 'hood-tile';
  version: number;
  id: string;
  origin: { lat: number; lon: number; E: number; N: number };
  baseElevation: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  heightmap: { file: string; cols: number; rows: number; cellSize: number; minX: number; minZ: number };
  meshes: { ground?: string; roads?: string; buildings?: string };
  /** The square chunks the .glb meshes are split into (see "Chunks" in the contract). Absent in older bakes. */
  chunks?: { size: number; minX: number; minZ: number; cols: number; rows: number };
  collision: { file: string; vertexCount: number; indexCount: number };
  roads?: string;
  /** `junctions.json`: junction polygons with their legs, signals, stop signs and crossings (see the contract). Not loaded by the sim yet. */
  junctions?: string;
  spawns: {
    player: { x: number; y: number; z: number };
    /** `heading` is the three.js `rotation.y` of an object that faces -Z at 0: forward is (-sin h, -cos h). */
    vehicle: { x: number; y: number; z: number; heading: number };
  };
  attribution: string[];
}

/** One drivable road from `roads.json`: a centreline of [x, y, z] points. */
export interface RoadData {
  id: string;
  class: string;
  name?: string;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  layer: number;
  width: number;
  /** true for a bridge the pipeline made over a cut or ravine where OSM has none (then `bridge` is true too) */
  derived?: boolean;
  points: [number, number, number][];
}

/** Shape of `junctions.json` (docs/contracts/m1-tile-format.md, "junctions.json"). Ids of roads are `roads.json` ids. */
export interface JunctionsData {
  junctions: {
    id: string;
    x: number;
    y: number;
    z: number;
    control: 'signals' | 'stop' | 'none';
    nodes: number[];
    polygon: [number, number][];
    legs: {
      road: string;
      node: number;
      /** unit vector (x, z) pointing away from the junction */
      dir: [number, number];
      approach: boolean;
      departure: boolean;
      /** metres from the node to where the road starts and the junction polygon ends */
      trim: number;
      control: 'signals' | 'stop' | 'none';
      stopLine: [number, number, number] | null;
      crosswalk: boolean;
    }[];
  }[];
  signals: { node: number; x: number; y: number; z: number; junction: string | null }[];
  stops: { node: number; x: number; y: number; z: number; direction: 'forward' | 'backward' | 'both'; all: boolean; junction: string | null }[];
  crossings: { id: number; points: [number, number, number][]; signals: boolean }[];
}

export interface TileData {
  manifest: TileManifest;
  /** Row-major, `cols` per row; column index runs along +X and row index along +Z. */
  heights: Float32Array;
  /** xyz triplets. */
  collisionPositions: Float32Array;
  collisionIndices: Uint32Array;
  /** Road centrelines, when the tile has them. The sim uses them to park cars at the curb. */
  roads?: RoadData[];
  source: 'baked' | 'procedural';
  /** Why the baked tile was not used. */
  fallbackReason?: string;
}

function fail(msg: string): never {
  throw new Error(`tile.json: ${msg}`);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates the parts of tile.json the sim and client depend on. Throws a readable error. */
export function parseTileManifest(json: unknown): TileManifest {
  const m = json as Partial<TileManifest> | null;
  if (!m || typeof m !== 'object') fail('not an object');
  if (m.format !== 'hood-tile') fail(`format is ${JSON.stringify(m.format)}, expected "hood-tile"`);
  if (m.version !== 1) fail(`unsupported version ${String(m.version)}`);
  const hm = m.heightmap;
  if (!hm || !isNum(hm.cols) || !isNum(hm.rows) || !isNum(hm.cellSize) || !isNum(hm.minX) || !isNum(hm.minZ) || typeof hm.file !== 'string') {
    fail('heightmap is incomplete');
  }
  if (hm.cols < 2 || hm.rows < 2 || hm.cellSize <= 0) fail('heightmap needs at least 2x2 samples and a positive cellSize');
  const c = m.collision;
  if (!c || typeof c.file !== 'string' || !isNum(c.vertexCount) || !isNum(c.indexCount)) fail('collision is incomplete');
  if (c.indexCount % 3 !== 0) fail('collision.indexCount is not a multiple of 3');
  const b = m.bounds;
  if (!b || !isNum(b.minX) || !isNum(b.minZ) || !isNum(b.maxX) || !isNum(b.maxZ)) fail('bounds are incomplete');
  const sp = m.spawns;
  if (!sp?.player || !sp.vehicle || !isNum(sp.player.x) || !isNum(sp.vehicle.x) || !isNum(sp.vehicle.heading)) fail('spawns are incomplete');
  return {
    ...(m as TileManifest),
    meshes: m.meshes ?? {},
    attribution: Array.isArray(m.attribution) ? m.attribution : [],
    id: typeof m.id === 'string' ? m.id : 'unknown',
    baseElevation: isNum(m.baseElevation) ? m.baseElevation : 0,
  };
}

/** Builds TileData from the three files' contents, checking that their sizes match the manifest. */
export function decodeTile(manifest: TileManifest, heightBytes: ArrayBuffer, collisionBytes: ArrayBuffer): TileData {
  const { cols, rows } = manifest.heightmap;
  if (heightBytes.byteLength !== cols * rows * 4) {
    throw new Error(`height.bin is ${heightBytes.byteLength} bytes, expected ${cols * rows * 4} for ${cols}x${rows}`);
  }
  const { vertexCount, indexCount } = manifest.collision;
  const want = vertexCount * 12 + indexCount * 4;
  if (collisionBytes.byteLength !== want) {
    throw new Error(`collision.bin is ${collisionBytes.byteLength} bytes, expected ${want} for ${vertexCount} vertices and ${indexCount} indices`);
  }
  const heights = new Float32Array(heightBytes);
  const collisionPositions = new Float32Array(collisionBytes, 0, vertexCount * 3);
  const collisionIndices = new Uint32Array(collisionBytes, vertexCount * 12, indexCount);
  for (let i = 0; i < indexCount; i++) {
    if (collisionIndices[i] >= vertexCount) throw new Error(`collision.bin index ${i} points past the last vertex`);
  }
  for (let i = 0; i < heights.length; i++) {
    if (!Number.isFinite(heights[i])) throw new Error('height.bin holds a non-finite sample');
  }
  return { manifest, heights, collisionPositions, collisionIndices, source: 'baked' };
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

const isPoint = (p: unknown) => Array.isArray(p) && p.length >= 3 && p.every(isNum);

/** Reads `roads.json` when the manifest names one. Roads are optional: any problem means no roads, not no tile. */
export function parseRoads(json: unknown): RoadData[] {
  const list = (json as { roads?: unknown } | null)?.roads;
  if (!Array.isArray(list)) return [];
  const out: RoadData[] = [];
  for (const r of list as Partial<RoadData>[]) {
    if (!r || typeof r.class !== 'string' || !isNum(r.width) || !Array.isArray(r.points) || r.points.length < 2 || !r.points.every(isPoint)) continue;
    out.push({
      id: String(r.id ?? ''),
      class: r.class,
      name: r.name,
      lanes: isNum(r.lanes) ? r.lanes : 2,
      oneway: !!r.oneway,
      bridge: !!r.bridge,
      layer: isNum(r.layer) ? r.layer : 0,
      width: r.width,
      ...(r.derived ? { derived: true } : {}),
      points: r.points,
    });
  }
  return out;
}

async function loadRoads(base: string, manifest: TileManifest, fetchFn: Fetch): Promise<RoadData[] | undefined> {
  if (!manifest.roads) return undefined;
  try {
    const res = await fetchFn(base + manifest.roads);
    return res.ok ? parseRoads(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}

/** Loads a baked tile. Throws when any file is missing or malformed. */
export async function loadBakedTile(baseUrl: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<TileData> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const get = async (name: string) => {
    const res = await fetchFn(base + name);
    if (!res.ok) throw new Error(`${base + name}: HTTP ${res.status}`);
    return res;
  };
  let manifest: TileManifest;
  try {
    manifest = parseTileManifest(await (await get('tile.json')).json());
  } catch (e) {
    // A dev server answers unknown paths with index.html, which fails here as a JSON error.
    throw new Error(`no usable tile at ${base} (${(e as Error).message})`);
  }
  const [h, c, roads] = await Promise.all([get(manifest.heightmap.file), get(manifest.collision.file), loadRoads(base, manifest, fetchFn)]);
  const tile = decodeTile(manifest, await h.arrayBuffer(), await c.arrayBuffer());
  if (roads) tile.roads = roads;
  return tile;
}

/** The baked tile when it loads, otherwise the procedural test ground (with the reason). */
export async function loadTileOrFallback(baseUrl: string | null, seed: number, fetchFn?: Fetch): Promise<TileData> {
  if (baseUrl) {
    try {
      return await loadBakedTile(baseUrl, fetchFn);
    } catch (e) {
      const t = generateProceduralTile(seed);
      t.fallbackReason = (e as Error).message;
      return t;
    }
  }
  return generateProceduralTile(seed);
}

/** Bilinear ground height at (x, z); clamps to the tile's edge samples. */
export function heightAt(tile: Pick<TileData, 'manifest' | 'heights'>, x: number, z: number): number {
  const { cols, rows, cellSize, minX, minZ } = tile.manifest.heightmap;
  const fx = Math.min(cols - 1, Math.max(0, (x - minX) / cellSize));
  const fz = Math.min(rows - 1, Math.max(0, (z - minZ) / cellSize));
  const c0 = Math.min(cols - 2, Math.floor(fx));
  const r0 = Math.min(rows - 2, Math.floor(fz));
  const tx = fx - c0;
  const tz = fz - r0;
  const h = tile.heights;
  const a = h[r0 * cols + c0];
  const b = h[r0 * cols + c0 + 1];
  const c = h[(r0 + 1) * cols + c0];
  const d = h[(r0 + 1) * cols + c0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
