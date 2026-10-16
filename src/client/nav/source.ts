/**
 * Where the map and the GPS get a tile's data: `roads.json`, `lanes.json`, `paths.json`, `landmarks.json` and the building footprints
 * (the roof triangles at the start of `collision.bin`). One interface over three worlds: a baked single tile, a baked streamed city,
 * and the procedural fixture city (`?tiles=fixture`). Tile data is fetched on demand; roads are cached, the rest is handed over and
 * dropped (the GPS keeps its own compact form).
 */
import type { CityIndex, CityTileEntry, Rect } from '../../shared/city';
import { fixtureOptions } from '../../shared/city';
import type { FixtureTile } from '../../shared/fixture';
import { parseLanes, type LanesData } from '../../shared/lanes';
import { parseLandmarks, type LandmarkEntry } from '../../shared/landmarks';
import { parseRoads, type RoadData, type TileManifest } from '../../shared/tile';
import { parsePaths, type PathsData } from '../../shared/walk';

export interface TileRef {
  id: string;
  bounds: Rect;
}

export interface NavSource {
  readonly tiles: readonly TileRef[];
  roads(id: string): Promise<RoadData[]>;
  lanes(id: string): Promise<LanesData | null>;
  paths(id: string): Promise<PathsData | null>;
  landmarks(id: string): Promise<LandmarkEntry[]>;
  /** Roof triangles as x, z for each of the three corners (6 numbers a triangle), or null when the tile has no footprints. */
  buildings(id: string): Promise<Float32Array | null>;
}

/** The flat triangles among the first `n` of a collision mesh: the roofs, whose outlines are the buildings' footprints. */
export function roofTriangles(positions: Float32Array, indices: Uint32Array, n: number): Float32Array {
  const count = Math.min(n, Math.floor(indices.length / 3));
  const out: number[] = [];
  for (let t = 0; t < count; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ya = positions[a + 1];
    if (Math.abs(ya - positions[b + 1]) > 1e-3 || Math.abs(ya - positions[c + 1]) > 1e-3) continue;
    out.push(positions[a], positions[a + 2], positions[b], positions[b + 2], positions[c], positions[c + 2]);
  }
  return Float32Array.from(out);
}

/** The procedural test city (`?tiles=fixture` or `fixture:N`). */
export function fixtureSource(index: CityIndex, url: string): NavSource {
  const opts = fixtureOptions(url);
  const cache = new Map<string, FixtureTile>();
  // (the fixture generator is loaded on first use: the default build does not carry it)
  const get = async (id: string): Promise<FixtureTile> => {
    let t = cache.get(id);
    if (!t) {
      const { fixtureTile } = await import('../../shared/fixture');
      const e = index.tiles.find((x) => x.id === id)!;
      t = fixtureTile(e.i, e.j, opts);
      cache.set(id, t);
      // (only a few at a time: the fixture makes a tile in a few ms, so the cache is just for repeated asks)
      if (cache.size > 12) cache.delete(cache.keys().next().value!);
    }
    return t;
  };
  return {
    tiles: index.tiles.map((t) => ({ id: t.id, bounds: t.bounds })),
    roads: async (id) => (await get(id)).roads ?? [],
    lanes: async (id) => (await get(id)).lanes ?? null,
    paths: async (id) => (await get(id)).paths ?? null,
    landmarks: async () => [],
    buildings: async (id) => {
      const t = await get(id);
      return roofTriangles(t.collisionPositions, t.collisionIndices, t.manifest.collision.buildingTriangles ?? 0);
    },
  };
}

interface Dir {
  id: string;
  bounds: Rect;
  /** The tile's directory (ends with `/`). */
  url: string;
}

/** Baked tiles: one (the M1 tile) or a city's (each entry's directory next to `index.json`). */
export function bakedSource(dirs: Dir[]): NavSource {
  const byId = new Map(dirs.map((d) => [d.id, d]));
  const manifests = new Map<string, Promise<TileManifest | null>>();
  const roadsCache = new Map<string, Promise<RoadData[]>>();
  const json = (url: string) =>
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const manifest = (id: string) => {
    let p = manifests.get(id);
    if (!p) manifests.set(id, (p = json(new URL('tile.json', byId.get(id)!.url).href)));
    return p;
  };
  const file = async (id: string, key: 'roads' | 'lanes' | 'paths' | 'landmarks', fallback?: string) => {
    const m = await manifest(id);
    const name = (m?.[key] as string | undefined) ?? fallback;
    return name ? json(new URL(name, byId.get(id)!.url).href) : null;
  };
  return {
    tiles: dirs.map((d) => ({ id: d.id, bounds: d.bounds })),
    roads(id) {
      let p = roadsCache.get(id);
      if (!p) {
        p = file(id, 'roads', 'roads.json').then((j) => (j ? parseRoads(j) : []));
        roadsCache.set(id, p);
        // (the parsed roads of a tile are a megabyte or two: a long drive does not keep every tile it passed)
        if (roadsCache.size > 24) roadsCache.delete(roadsCache.keys().next().value!);
      }
      return p;
    },
    async lanes(id) {
      const j = await file(id, 'lanes');
      return j ? parseLanes(j) : null;
    },
    async paths(id) {
      const j = await file(id, 'paths');
      return j ? parsePaths(j) : null;
    },
    async landmarks(id) {
      const j = await file(id, 'landmarks');
      return j ? (parseLandmarks(j)?.landmarks ?? []) : [];
    },
    async buildings(id) {
      const m = await manifest(id);
      if (!m || !m.collision.buildingTriangles) return null;
      const res = await fetch(new URL(m.collision.file, byId.get(id)!.url).href).catch(() => null);
      if (!res || !res.ok) return null;
      const buf = await res.arrayBuffer();
      const { vertexCount, indexCount, buildingTriangles } = m.collision;
      if (buf.byteLength < vertexCount * 12 + indexCount * 4) return null;
      return roofTriangles(new Float32Array(buf, 0, vertexCount * 3), new Uint32Array(buf, vertexCount * 12, indexCount), buildingTriangles);
    },
  };
}

/** A world with no tile files (the procedural test ground): the map opens, with nothing on it. */
export function emptySource(tile: TileRef): NavSource {
  return {
    tiles: [tile],
    roads: async () => [],
    lanes: async () => null,
    paths: async () => null,
    landmarks: async () => [],
    buildings: async () => null,
  };
}

/** A streamed city's tiles as directories: `base` is the directory of `index.json`. */
export function cityDirs(index: CityIndex, base: string): Dir[] {
  return index.tiles.map((t: CityTileEntry) => ({ id: t.id, bounds: t.bounds, url: new URL(t.path, base).href }));
}
