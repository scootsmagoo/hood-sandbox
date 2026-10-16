/**
 * Baked map tiles, as described in docs/contracts/m1-tile-format.md. This file reads the files the
 * sim needs (`tile.json`, `height.bin`, `collision.bin`, and `roads.json` when there is one) and
 * nothing else; it never parses glTF.
 * It uses only `fetch` and typed arrays, so it runs in a worker, on the main thread and in Node.
 */
import { generateProceduralTile } from './proceduralTile';
import { parseLanes, type LanesData } from './lanes';
import { parsePaths, parseScenarios, type PathsData, type ScenariosData } from './walk';
import { parseTransit, type TransitData } from './transit';

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
  /** `buildingTriangles`: the first this many triangles of the mesh are buildings (walls and roofs); the rest are decks and piers. */
  collision: { file: string; vertexCount: number; indexCount: number; buildingTriangles?: number };
  roads?: string;
  /** `junctions.json`: junction polygons with their legs, signals, stop signs and crossings (see the contract). */
  junctions?: string;
  /** `lanes.json`: the directed lane graph traffic drives on (see the contract). */
  lanes?: string;
  /** `paths.json`: the walk network pedestrians route over (see the contract). */
  paths?: string;
  /** `scenarios.json`: where people sit, wait, queue and chat. */
  scenarios?: string;
  /** `props.json`: tree, street lamp and street furniture anchors (see the contract). */
  props?: string;
  /** `landmarks.json`: the landmarks of the city pack in the tile and the hero models that stand in it (see the contract). */
  landmarks?: string;
  /** `transit.json`: the rail lines, stations and tunnels of the tile (see the contract, "transit.json"). */
  transit?: string;
  /** 2 when the .glb meshes carry the attributes of "Mesh attributes (meshFormat 2)" in the contract, 3 when the buildings also carry `_LOOK` ("Building appearance (meshFormat 3)"); absent in an older bake. */
  meshFormat?: number;
  /** Names of the building kind ids (`_BLD.x`) and ground class ids (`_LAND.x`), in id order. */
  buildingKinds?: string[];
  /** Names of the facade material ids (`_LOOK.x` on walls), the style ids (`_LOOK.y`) and the roof material ids (`_LOOK.x` on roofs), in id order. meshFormat 3. */
  buildingMaterials?: string[];
  buildingStyles?: string[];
  roofMaterials?: string[];
  landClasses?: string[];
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
  /** posted speed limit, km/h, when OSM has one */
  maxspeed?: number;
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
      /** the OSM node's position (x, z) */
      at?: [number, number];
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

/**
 * Shape of `props.json` (docs/contracts/m1-tile-format.md, "props.json"): anchors, not geometry. Tuples:
 * trees `[x, y, z, height, crownRadius, class, src]`, lamps `[x, y, z, yaw, poleHeight, kind, src]`, furniture `[x, y, z]`.
 */
export interface PropsData {
  version: number;
  trees: [number, number, number, number, number, number, number][];
  lamps: [number, number, number, number, number, number, number][];
  hydrants: [number, number, number][];
  bins: [number, number, number][];
  bollards: [number, number, number][];
}

/** Reads `props.json`: tuples of the wrong length are dropped; null when it is not a props file. */
export function parseProps(json: unknown): PropsData | null {
  const j = json as Partial<PropsData> | null;
  if (!j || j.version !== 1) return null;
  const tuples = <T extends number[]>(a: unknown, n: number): T[] => (Array.isArray(a) ? (a.filter((t) => Array.isArray(t) && t.length >= n && t.slice(0, n).every(isNum)) as T[]) : []);
  return {
    version: 1,
    trees: tuples(j.trees, 7),
    lamps: tuples(j.lamps, 7),
    hydrants: tuples(j.hydrants, 3),
    bins: tuples(j.bins, 3),
    bollards: tuples(j.bollards, 3),
  };
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
  /** The walk network and the scenario points, when the tile has them. Without a network there are no ambient pedestrians. */
  paths?: PathsData;
  scenarios?: ScenariosData;
  /** `props.json`, when the tile has one: tree, street lamp and furniture anchors for the client (named `anchors` because `ProceduralTile.props` is something else). */
  anchors?: PropsData;
  /** `junctions.json`, when the tile has one (pedestrians read the signal groups of the junctions their crossings cross). */
  junctions?: JunctionsData;
  /** The lane graph, when the tile has one. Without it there is no ambient traffic. */
  lanes?: LanesData;
  /** The transit layer and its collision mesh (`transit.json`, `transit.bin`), when the tile has one. */
  transit?: TransitTile;
  source: 'baked' | 'procedural';
  /** Why the baked tile was not used. */
  fallbackReason?: string;
}

export interface TransitTile {
  data: TransitData;
  positions: Float32Array;
  indices: Uint32Array;
}

/** Reads `transit.bin` against the counts `transit.json` gives; an empty mesh when they do not match. */
export function decodeTransitCollision(data: TransitData, bytes: ArrayBuffer | null): TransitTile {
  const c = data.collision;
  if (!c || !bytes || bytes.byteLength !== c.vertexCount * 12 + c.indexCount * 4) return { data, positions: new Float32Array(0), indices: new Uint32Array(0) };
  return { data, positions: new Float32Array(bytes, 0, c.vertexCount * 3), indices: new Uint32Array(bytes, c.vertexCount * 12, c.indexCount) };
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
      ...(isNum(r.maxspeed) ? { maxspeed: r.maxspeed } : {}),
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

/** Reads a named optional JSON file of the tile through `parse`; any problem means none. */
async function loadOptional<T>(base: string, name: string | undefined, parse: (j: unknown) => T | null, fetchFn: Fetch): Promise<T | undefined> {
  if (!name) return undefined;
  try {
    const res = await fetchFn(base + name);
    return res.ok ? parse(await res.json()) ?? undefined : undefined;
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
  const [h, c, roads, paths, scenarios, junctions, lanes, props, transit] = await Promise.all([
    get(manifest.heightmap.file),
    get(manifest.collision.file),
    loadRoads(base, manifest, fetchFn),
    loadOptional(base, manifest.paths, parsePaths, fetchFn),
    loadOptional(base, manifest.scenarios, parseScenarios, fetchFn),
    loadOptional(base, manifest.junctions, (j) => ((j as JunctionsData | null)?.junctions ? (j as JunctionsData) : null), fetchFn),
    loadOptional(base, manifest.lanes, parseLanes, fetchFn),
    loadOptional(base, manifest.props, parseProps, fetchFn),
    loadOptional(base, manifest.transit, parseTransit, fetchFn),
  ]);
  const tile = decodeTile(manifest, await h.arrayBuffer(), await c.arrayBuffer());
  if (roads) tile.roads = roads;
  if (paths) tile.paths = paths;
  if (scenarios) tile.scenarios = scenarios;
  if (junctions) tile.junctions = junctions;
  if (lanes) tile.lanes = lanes;
  if (props) tile.anchors = props;
  if (transit) {
    let bin: ArrayBuffer | null = null;
    if (transit.collision) {
      try {
        const res = await fetchFn(base + transit.collision.file);
        bin = res.ok ? await res.arrayBuffer() : null;
      } catch {
        bin = null;
      }
    }
    tile.transit = decodeTransitCollision(transit, bin);
  }
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

/**
 * Ground height at (x, z), clamped to the tile's edge samples. The ground is triangles, not a bilinear patch: each cell is split
 * by the diagonal from its south-west corner to its north-east one, which is how both the drawn ground mesh and the physics
 * heightfield are cut, so this is the height people and cars stand at (a bilinear patch is up to a metre off on a twisted cell).
 */
export function heightAt(tile: Pick<TileData, 'manifest' | 'heights'>, x: number, z: number): number {
  const { cols, rows, cellSize, minX, minZ } = tile.manifest.heightmap;
  const fx = Math.min(cols - 1, Math.max(0, (x - minX) / cellSize));
  const fz = Math.min(rows - 1, Math.max(0, (z - minZ) / cellSize));
  const c0 = Math.min(cols - 2, Math.floor(fx));
  const r0 = Math.min(rows - 2, Math.floor(fz));
  const tx = fx - c0;
  const tz = fz - r0;
  const h = tile.heights;
  // north-west, north-east, south-west, south-east (south is +z)
  const nw = h[r0 * cols + c0];
  const ne = h[r0 * cols + c0 + 1];
  const sw = h[(r0 + 1) * cols + c0];
  const se = h[(r0 + 1) * cols + c0 + 1];
  if (tx + tz <= 1) return nw + (ne - nw) * tx + (sw - nw) * tz;
  return se + (sw - se) * (1 - tx) + (ne - se) * (1 - tz);
}
