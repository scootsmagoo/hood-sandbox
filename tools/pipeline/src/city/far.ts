/**
 * `far.bin` (contract section 8): a tile's skyline. Every building prism of collision.bin (the first `buildingTriangles`
 * triangles: walls, then a flat roof) as a footprint of at most 12 vertices, its base (the lowest wall vertex) and top (the roof),
 * and its kind (the `_BLD` kind of the drawn roof or wall vertices at its outline, else 0); and the ground as a 33 x 33 grid
 * sampled from height.bin over the cell. Encoded with src/shared/farTile.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simplifyRing, signedArea, type Rect, type V2 } from '../geo.js';
import { readCollision, readHeightmap } from '../io/binary.js';
import { encodeFarTile, type FarBuilding } from '../../../../src/shared/farTile.js';
import { meshNodes, readGlb, worldPositions } from './glbEdit.js';
import { buildingRuns } from './seamPass.js';

export const FAR_GRID = 33;
export const FAR_MAX_VERTS = 12;

const pkey = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;

/** The outer outline of a set of flat roof triangles: the loop of edges used once with the largest area. */
export function roofOutline(pos: Float32Array, idx: Uint32Array, t0: number, t1: number): V2[] | null {
  const edges = new Map<string, { a: V2; b: V2; ka: string; kb: string; n: number }>();
  for (let t = t0; t < t1; t++) {
    for (let q = 0; q < 3; q++) {
      const u = idx[t * 3 + q], v = idx[t * 3 + ((q + 1) % 3)];
      const a: V2 = [pos[u * 3], pos[u * 3 + 2]], b: V2 = [pos[v * 3], pos[v * 3 + 2]];
      const ka = pkey(a[0], a[1]), kb = pkey(b[0], b[1]);
      if (ka === kb) continue;
      const und = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(und);
      if (e) e.n++;
      else edges.set(und, { a, b, ka, kb, n: 1 });
    }
  }
  // boundary edges, directed as their triangle has them (a consistent winding), chained into loops
  const next = new Map<string, { b: V2; kb: string }[]>();
  const start = new Map<string, V2>();
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    const l = next.get(e.ka);
    if (l) l.push({ b: e.b, kb: e.kb });
    else next.set(e.ka, [{ b: e.b, kb: e.kb }]);
    start.set(e.ka, e.a);
  }
  let best: V2[] | null = null;
  let bestA = 0;
  for (const k0 of [...next.keys()]) {
    if (!next.get(k0)?.length) continue;
    const ring: V2[] = [start.get(k0)!];
    let k = k0;
    for (let guard = 0; guard < 100000; guard++) {
      const l = next.get(k);
      if (!l?.length) break;
      const { b, kb } = l.pop()!;
      if (kb === k0) break;
      ring.push(b);
      k = kb;
    }
    if (ring.length < 3) continue;
    const a = Math.abs(signedArea(ring));
    if (a > bestA) {
      bestA = a;
      best = ring;
    }
  }
  return best;
}

/** Simplifies a ring to at most `max` vertices (Douglas-Peucker with a growing tolerance). */
export function capRing(ring: V2[], max = FAR_MAX_VERTS): V2[] {
  let r = ring;
  for (let tol = 0.25; r.length > max && tol < 1e5; tol *= 1.6) r = simplifyRing(ring, tol);
  if (r.length > max) {
    // a last resort: every k-th vertex
    const k = Math.ceil(r.length / max);
    r = r.filter((_, i) => i % k === 0).slice(0, max);
  }
  return r;
}

/** Building kinds by place, from the `_BLD` attribute of the drawn buildings (2 m cells). */
export async function kindLookup(buildingsGlb: Uint8Array | null): Promise<(x: number, z: number) => number> {
  if (!buildingsGlb) return () => 0;
  const doc = await readGlb(buildingsGlb);
  const cells = new Map<string, number>();
  for (const { node, prims } of meshNodes(doc)) {
    for (const prim of prims) {
      const bld = prim.getAttribute('_BLD');
      const pos = prim.getAttribute('POSITION');
      if (!bld || !pos) continue;
      const wp = worldPositions(node, pos);
      const a = bld.getArray()!;
      const w = bld.getElementSize();
      for (let i = 0; i < pos.getCount(); i++) {
        const k = `${Math.floor(wp[i * 3] / 2)},${Math.floor(wp[i * 3 + 2] / 2)}`;
        if (!cells.has(k)) cells.set(k, a[i * w]);
      }
    }
  }
  return (x, z) => {
    const cx = Math.floor(x / 2), cz = Math.floor(z / 2);
    for (let r = 0; r <= 1; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const v = cells.get(`${cx + dx},${cz + dz}`);
      if (v !== undefined) return v;
    }
    return -1;
  };
}

/** The far buildings of a collision mesh. */
export function farBuildings(pos: Float32Array, idx: Uint32Array, buildingTriangles: number, kindAt: (x: number, z: number) => number = () => -1): FarBuilding[] {
  const out: FarBuilding[] = [];
  for (const run of buildingRuns(pos, idx, buildingTriangles)) {
    if (run.roof0 < 0) continue;
    const outline = roofOutline(pos, idx, run.roof0, run.t1);
    if (!outline) continue;
    let base = Infinity;
    for (let t = run.t0; t < run.roof0; t++) for (let q = 0; q < 3; q++) base = Math.min(base, pos[idx[t * 3 + q] * 3 + 1]);
    const top = pos[idx[run.roof0 * 3] * 3 + 1];
    if (!Number.isFinite(base)) base = top - 3;
    const ring = capRing(outline);
    // the kind most of the outline's vertices see
    const votes = new Map<number, number>();
    for (const [x, z] of outline) {
      const k = kindAt(x, z);
      if (k >= 0) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    let kind = 0, bv = 0;
    for (const [k, v] of votes) if (v > bv) { bv = v; kind = k; }
    out.push({ kind, baseY: base, topY: top, ring: ring.flatMap((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]) });
  }
  return out;
}

/** The ground grid: FAR_GRID x FAR_GRID samples of the heightmap over the cell. */
export function farGround(height: Float32Array, cols: number, rows: number, cell: number, hmMinX: number, hmMinZ: number, b: Rect): { n: number; minX: number; minZ: number; size: number; heights: Float32Array } {
  const n = FAR_GRID;
  const size = b.maxX - b.minX;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const x = b.minX + (c * size) / (n - 1), z = b.minZ + (r * size) / (n - 1);
    const fc = Math.max(0, Math.min(cols - 1, Math.round((x - hmMinX) / cell)));
    const fr = Math.max(0, Math.min(rows - 1, Math.round((z - hmMinZ) / cell)));
    heights[r * n + c] = height[fr * cols + fc];
  }
  return { n, minX: b.minX, minZ: b.minZ, size, heights };
}

/** Writes far.bin of a city-frame tile directory. Returns its size and building count. */
export async function writeFar(dir: string): Promise<{ bytes: number; buildings: number; kinds: number }> {
  const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
  const c = tile.collision;
  const col = readCollision(readFileSync(path.join(dir, c.file)), c.vertexCount, c.indexCount);
  const hm = tile.heightmap;
  const height = readHeightmap(readFileSync(path.join(dir, hm.file)));
  let glb: Uint8Array | null = null;
  try {
    glb = readFileSync(path.join(dir, tile.meshes.buildings));
  } catch {
    glb = null;
  }
  const kindAt = await kindLookup(glb);
  const buildings = farBuildings(col.positions, col.indices, c.buildingTriangles ?? 0, kindAt);
  const bytes = encodeFarTile({ grid: farGround(height, hm.cols, hm.rows, hm.cellSize, hm.minX, hm.minZ, tile.bounds), buildings });
  writeFileSync(path.join(dir, 'far.bin'), bytes);
  return { bytes: bytes.byteLength, buildings: buildings.length, kinds: buildings.filter((b) => b.kind > 0).length };
}
