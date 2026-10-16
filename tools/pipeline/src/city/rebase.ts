/**
 * Moves a tile baked in its own frame (centred on its cell, heights above the DEM at its centre) into the city frame (contract
 * section 10, steps 3 and 4): adds (dx, dy, dz) to every coordinate of every file, sets origin, baseElevation, bounds and id,
 * and keeps only the props, scenario points, signal heads and landmarks that stand in the tile's own cell.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collisionBytes, heightmapBytes } from '../io/binary.js';
import { readGlb, translateGlbJson, translateRoots, writeGlb } from './glbEdit.js';
import { GLB_FILES, JSON_FILES, keepOwn, listFiles, mapJsonPoints, readTileFiles, type Json, type TileFiles } from './tileFiles.js';
import type { Rect } from '../geo.js';

export interface RebaseSpec {
  dx: number;
  dy: number;
  dz: number;
  /** the city frame */
  origin: { lat: number; lon: number; E: number; N: number };
  baseElevation: number;
  /** the cell, in the city frame */
  bounds: Rect;
  /** `<city>/<grid>/<cell>` */
  id: string;
}

/** dy of a tile: its heights are above its own base elevation, the city's above the city's. */
export const datumShift = (tileBase: number, cityBase: number): number => Math.round((tileBase - cityBase) * 1e6) / 1e6;

/** Translates the JSON files and tile.json in memory (and sets the city-frame fields). */
export function rebaseJson(t: Pick<TileFiles, 'tile' | 'json'>, s: RebaseSpec): Record<string, number> {
  const { dx, dy, dz } = s;
  mapJsonPoints(t, (x, y, z) => [x + dx, y + dy, z + dz], (x, z) => [x + dx, z + dz]);
  const tile: Json = t.tile;
  tile.id = s.id;
  tile.origin = { ...s.origin };
  tile.baseElevation = s.baseElevation;
  tile.bounds = { ...s.bounds };
  tile.heightmap = { ...tile.heightmap, minX: round6(tile.heightmap.minX + dx), minZ: round6(tile.heightmap.minZ + dz) };
  if (tile.heightmapFine && typeof tile.heightmapFine.minX === 'number') tile.heightmapFine = { ...tile.heightmapFine, minX: round6(tile.heightmapFine.minX + dx), minZ: round6(tile.heightmapFine.minZ + dz) };
  if (tile.chunks) tile.chunks = { ...tile.chunks, minX: round6(tile.chunks.minX + dx), minZ: round6(tile.chunks.minZ + dz) };
  tile.frame = { baked: { dx, dy, dz }, note: 'baked in a frame centred on the cell and translated by (dx, dy, dz) into the city frame' };
  return keepOwn(t, s.bounds);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Translates a heightmap (y only) in place, in float32. */
export function rebaseHeights(h: Float32Array, dy: number): void {
  for (let i = 0; i < h.length; i++) h[i] = h[i] + dy;
}

export function rebaseCollision(p: Float32Array, d: [number, number, number]): void {
  for (let i = 0; i < p.length; i += 3) {
    p[i] += d[0];
    p[i + 1] += d[1];
    p[i + 2] += d[2];
  }
}

/**
 * Translates a .glb by moving its top-level nodes. Junction surfaces in roads.glb carry the world (x, z) in TEXCOORD_0 (they are
 * the vertices whose TEXCOORD_1 half width is 0); that is shifted too, so it stays the world position.
 */
export async function rebaseGlb(bytes: Uint8Array, d: [number, number, number], file = ''): Promise<Uint8Array> {
  // ground and buildings: only the node translations change, so the JSON chunk is edited and the buffers kept as they are
  if (file !== 'roads.glb') return translateGlbJson(bytes, d);
  const doc = await readGlb(bytes);
  translateRoots(doc, d);
  if (file === 'roads.glb') shiftJunctionUvs(doc, d[0], d[2]);
  return writeGlb(doc);
}

function shiftJunctionUvs(doc: Awaited<ReturnType<typeof readGlb>>, dx: number, dz: number): void {
  const done = new Set<unknown>();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv0 = prim.getAttribute('TEXCOORD_0');
      const uv1 = prim.getAttribute('TEXCOORD_1');
      if (!uv0 || !uv1 || done.has(uv0)) continue;
      done.add(uv0);
      const a = uv0.getArray();
      const b = uv1.getArray();
      if (!(a instanceof Float32Array) || !b) continue;
      for (let i = 0; i < uv0.getCount(); i++) {
        if (b[i * 2] !== 0) continue;
        a[i * 2] += dx;
        a[i * 2 + 1] += dz;
      }
      uv0.setArray(a);
    }
  }
}

/** Rebases a whole tile directory `src` (a raw local-frame bake) into `dst`. Returns what keepOwn dropped and the file sizes. */
export async function rebaseTile(src: string, dst: string, s: RebaseSpec): Promise<{ dropped: Record<string, number>; sizes: Record<string, number> }> {
  const t = readTileFiles(src);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const dropped = rebaseJson(t, s);
  rebaseHeights(t.height, s.dy);
  if (t.fine) rebaseHeights(t.fine, s.dy);
  rebaseCollision(t.collision.positions, [s.dx, s.dy, s.dz]);
  const sizes: Record<string, number> = {};
  const put = (f: string, data: Uint8Array | string) => {
    writeFileSync(path.join(dst, f), data);
    sizes[f] = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  };
  put(t.tile.heightmap.file, heightmapBytes(t.height));
  if (t.fine) put(t.tile.heightmapFine.file, heightmapBytes(t.fine));
  put(t.tile.collision.file, collisionBytes(t.collision.positions, t.collision.indices));
  for (const f of JSON_FILES) if (t.json[f]) put(f, JSON.stringify(t.json[f]));
  for (const f of GLB_FILES) put(f, await rebaseGlb(readFileSync(path.join(src, f)), [s.dx, s.dy, s.dz], f));
  put('tile.json', JSON.stringify(t.tile, null, 2));
  // anything else the bake wrote (none today) is copied as it is, and reported
  const known = new Set<string>([...JSON_FILES, ...GLB_FILES, 'tile.json', t.tile.heightmap.file, t.tile.collision.file, ...(t.fine ? [t.tile.heightmapFine.file] : [])]);
  for (const f of listFiles(src)) {
    if (known.has(f)) continue;
    console.warn(`rebase: ${f} is not a file the rebase knows; copied unchanged`);
    copyFileSync(path.join(src, f), path.join(dst, f));
  }
  return { dropped, sizes };
}
