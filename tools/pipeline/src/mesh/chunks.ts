import type { Rect } from '../geo.js';
import { MeshBuilder } from './builder.js';

/** A square grid laid over the tile bounds. Chunk (cx, cz) covers x from minX + cx * size, z from minZ + cz * size. */
export interface ChunkGrid {
  size: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
}

export function makeChunkGrid(bounds: Rect, size: number): ChunkGrid {
  return {
    size,
    minX: bounds.minX,
    minZ: bounds.minZ,
    cols: Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / size - 1e-9)),
    rows: Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / size - 1e-9)),
  };
}

export function chunkOf(grid: ChunkGrid, x: number, z: number): [number, number] {
  const cx = Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.minX) / grid.size)));
  const cz = Math.max(0, Math.min(grid.rows - 1, Math.floor((z - grid.minZ) / grid.size)));
  return [cx, cz];
}

/**
 * Splits a mesh into one mesh per chunk, giving each triangle to the chunk that holds its centroid.
 * A triangle that straddles a border stays whole, so a chunk's geometry may reach a little past its
 * square; the renderer's bounding volumes come from the geometry, so culling stays correct.
 * Chunks without triangles are left out. Keys are `cz * grid.cols + cx`.
 */
export function splitMesh(mb: MeshBuilder, grid: ChunkGrid): Map<number, MeshBuilder> {
  const out = new Map<number, MeshBuilder>();
  const remap = new Map<number, Map<number, number>>();
  const P = mb.positions;
  for (let t = 0; t < mb.indices.length; t += 3) {
    const a = mb.indices[t], b = mb.indices[t + 1], c = mb.indices[t + 2];
    const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
    const z = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
    const [cx, cz] = chunkOf(grid, x, z);
    const key = cz * grid.cols + cx;
    let dst = out.get(key);
    let map = remap.get(key);
    if (!dst || !map) {
      dst = new MeshBuilder();
      map = new Map();
      out.set(key, dst);
      remap.set(key, map);
    }
    for (const src of [a, b, c]) {
      let n = map.get(src);
      if (n === undefined) {
        n = dst.vertex(P[src * 3], P[src * 3 + 1], P[src * 3 + 2], mb.normals[src * 3], mb.normals[src * 3 + 1], mb.normals[src * 3 + 2], mb.colors[src * 3], mb.colors[src * 3 + 1], mb.colors[src * 3 + 2]);
        map.set(src, n);
      }
      dst.indices.push(n);
    }
  }
  return out;
}
