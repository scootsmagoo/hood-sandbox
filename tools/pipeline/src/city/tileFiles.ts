/**
 * A baked tile's files in memory, and one visitor over every coordinate they hold, so the rebase (a translation) and the seam
 * pass (a height field) change exactly the same fields. The fields with coordinates are the ones the writers of bake.ts make:
 *
 *   tile.json       spawns.player, spawns.vehicle (x, y, z); bounds, heightmap.minX/minZ, chunks.minX/minZ (set by the rebase)
 *   height.bin      every sample (y; x and z follow from the grid)
 *   heightmapFine   (optional) every sample of its file (y), and its minX/minZ when it has them
 *   collision.bin   every position
 *   roads.json      roads[].points, barriers[] (flat x, y, z triples)
 *   junctions.json  junctions[] x/y/z, polygon [x, z], legs[].at [x, z], legs[].stopLine [x, y, z]; signals[], stops[] x/y/z;
 *                   crossings[].points
 *   lanes.json      edges[].pts (flat x, y, z); junctions[] x/z; junctions[].heads[] x/y/z
 *   paths.json      nodes
 *   scenarios.json  points[] x/y/z
 *   props.json      the first three numbers of every tuple of trees, lamps, hydrants, bins, bollards
 *   landmarks.json  landmarks[] x/z, ring [x, z], zones[].ring [x, z], hero.y (the model's datum, at the landmark's x/z)
 *   *.glb           every vertex position (the rebase moves the nodes instead); TEXCOORD_0 of junction surfaces in roads.glb
 *                   (the world x/z there; see rebase.ts)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readCollision, readHeightmap } from '../io/binary.js';

export type P3 = (x: number, y: number, z: number) => [number, number, number];
export type P2 = (x: number, z: number) => [number, number];

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export const JSON_FILES = ['roads.json', 'junctions.json', 'lanes.json', 'paths.json', 'scenarios.json', 'props.json', 'landmarks.json'] as const;
export const GLB_FILES = ['ground.glb', 'roads.glb', 'buildings.glb'] as const;
export const PROP_KINDS = ['trees', 'lamps', 'hydrants', 'bins', 'bollards'] as const;

export interface TileFiles {
  dir: string;
  tile: Json;
  json: Partial<Record<(typeof JSON_FILES)[number], Json>>;
  height: Float32Array;
  /** the optional road-corridor layer (`tile.json.heightmapFine`, contract section 4): (block + 1)^2 samples per block */
  fine?: Float32Array;
  collision: { positions: Float32Array; indices: Uint32Array };
}

/** The fine layer's blocks: where sample (r, c) of block k stands. Blocks are aligned to the coarse grid's origin. */
export function fineBlocks(tile: Json): { block: number; cell: number; origin: (k: number) => [number, number] } | null {
  const f = tile.heightmapFine;
  if (!f || !Array.isArray(f.blocks)) return null;
  const cell = f.cellSize, block = f.block;
  const minX = typeof f.minX === 'number' ? f.minX : tile.heightmap.minX;
  const minZ = typeof f.minZ === 'number' ? f.minZ : tile.heightmap.minZ;
  return { block, cell, origin: (k) => [minX + f.blocks[k][0] * block * cell, minZ + f.blocks[k][1] * block * cell] };
}

export function readTileFiles(dir: string): TileFiles {
  const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
  const json: TileFiles['json'] = {};
  for (const f of JSON_FILES) {
    const p = path.join(dir, f);
    if (existsSync(p)) json[f] = JSON.parse(readFileSync(p, 'utf8'));
  }
  const height = readHeightmap(readFileSync(path.join(dir, tile.heightmap.file)));
  const fine = tile.heightmapFine?.file && existsSync(path.join(dir, tile.heightmapFine.file)) ? readHeightmap(readFileSync(path.join(dir, tile.heightmapFine.file))) : undefined;
  const c = tile.collision;
  const collision = readCollision(readFileSync(path.join(dir, c.file)), c.vertexCount, c.indexCount);
  return { dir, tile, json, height, fine, collision };
}

export const listFiles = (dir: string): string[] => readdirSync(dir).filter((f) => !f.includes('.part-')).sort();

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Calls `p3` on every (x, y, z) and `p2` on every plan-only (x, z) of the JSON files and the tile.json spawns, in place. The
 * results are rounded to 1 mm (the files hold 1 to 10 cm), which strips the float noise of the sums.
 */
export function mapJsonPoints(t: Pick<TileFiles, 'tile' | 'json'>, p3: P3, p2: P2): void {
  const set3 = (o: Json, kx = 'x', ky = 'y', kz = 'z') => {
    const [x, y, z] = p3(o[kx], o[ky], o[kz]);
    o[kx] = r3(x);
    o[ky] = r3(y);
    o[kz] = r3(z);
  };
  const arr3 = (a: number[], off = 0) => {
    const [x, y, z] = p3(a[off], a[off + 1], a[off + 2]);
    a[off] = r3(x);
    a[off + 1] = r3(y);
    a[off + 2] = r3(z);
  };
  const arr2 = (a: number[]) => {
    const [x, z] = p2(a[0], a[1]);
    a[0] = r3(x);
    a[1] = r3(z);
  };
  const sp = t.tile.spawns;
  if (sp?.player) set3(sp.player);
  if (sp?.vehicle) set3(sp.vehicle);
  const { json } = t;
  for (const r of json['roads.json']?.roads ?? []) for (const p of r.points) arr3(p);
  for (const b of json['roads.json']?.barriers ?? []) for (let k = 0; k + 2 < b.length; k += 3) arr3(b, k);
  const jn = json['junctions.json'];
  if (jn) {
    for (const j of jn.junctions ?? []) {
      set3(j);
      for (const p of j.polygon ?? []) arr2(p);
      for (const l of j.legs ?? []) {
        if (Array.isArray(l.at)) arr2(l.at);
        if (Array.isArray(l.stopLine)) arr3(l.stopLine);
      }
    }
    for (const s of jn.signals ?? []) set3(s);
    for (const s of jn.stops ?? []) set3(s);
    for (const c of jn.crossings ?? []) for (const p of c.points ?? []) arr3(p);
  }
  const ln = json['lanes.json'];
  if (ln) {
    for (const e of ln.edges ?? []) for (let k = 0; k + 2 < e.pts.length; k += 3) arr3(e.pts, k);
    for (const j of ln.junctions ?? []) {
      const [x, z] = p2(j.x, j.z);
      j.x = r3(x);
      j.z = r3(z);
      for (const h of j.heads ?? []) set3(h);
    }
  }
  for (const p of json['paths.json']?.nodes ?? []) arr3(p);
  for (const p of json['scenarios.json']?.points ?? []) set3(p);
  const pr = json['props.json'];
  if (pr) for (const k of PROP_KINDS) for (const a of pr[k] ?? []) arr3(a);
  for (const l of json['landmarks.json']?.landmarks ?? []) {
    if (l.hero && typeof l.hero.y === 'number') {
      const [x, y, z] = p3(l.x, l.hero.y, l.z);
      l.x = r3(x);
      l.hero.y = r3(y);
      l.z = r3(z);
    } else {
      const [x, z] = p2(l.x, l.z);
      l.x = r3(x);
      l.z = r3(z);
    }
    for (const p of l.ring ?? []) arr2(p);
    // a walk-in hero's indoor zones (the airport's terminal and concourse: world/aerowayBake.ts)
    for (const zn of l.zones ?? []) for (const p of zn.ring ?? []) arr2(p);
  }
}

/** Half-open cell test (contract section 6): minX <= x < maxX, minZ <= z < maxZ. */
export const inCell = (b: { minX: number; minZ: number; maxX: number; maxZ: number }, x: number, z: number): boolean => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;

/**
 * Keeps only what stands in the tile's own cell (contract section 6): props, scenario points, lane-junction signal heads and
 * landmarks outside the half-open cell are dropped. Returns how many of each went.
 */
export function keepOwn(t: Pick<TileFiles, 'json'>, b: { minX: number; minZ: number; maxX: number; maxZ: number }): Record<string, number> {
  const dropped: Record<string, number> = {};
  const count = (k: string, before: number, after: number) => {
    if (before !== after) dropped[k] = (dropped[k] ?? 0) + before - after;
  };
  const pr = t.json['props.json'];
  if (pr) {
    for (const k of PROP_KINDS) {
      if (!Array.isArray(pr[k])) continue;
      const n = pr[k].length;
      pr[k] = pr[k].filter((a: number[]) => inCell(b, a[0], a[2]));
      count(k, n, pr[k].length);
    }
    // the per-source tallies describe the bake's whole tile; say what is kept
    pr.stats = { ...pr.stats, kept: Object.fromEntries(PROP_KINDS.map((k) => [k, pr[k]?.length ?? 0])) };
  }
  const sc = t.json['scenarios.json'];
  if (sc?.points) {
    const n = sc.points.length;
    sc.points = sc.points.filter((p: Json) => inCell(b, p.x, p.z));
    count('scenarios', n, sc.points.length);
    if (sc.stats) {
      const byType: Record<string, number> = {};
      for (const q of sc.points) byType[q.type] = (byType[q.type] ?? 0) + 1;
      sc.stats = { ...sc.stats, total: sc.points.length, byType, osm: sc.points.filter((q: Json) => q.src === 'osm').length, synth: sc.points.filter((q: Json) => q.src === 'synth').length };
    }
  }
  for (const j of t.json['lanes.json']?.junctions ?? []) {
    if (!Array.isArray(j.heads)) continue;
    const n = j.heads.length;
    j.heads = j.heads.filter((h: Json) => inCell(b, h.x, h.z));
    count('signalHeads', n, j.heads.length);
  }
  const lm = t.json['landmarks.json'];
  if (lm?.landmarks) {
    const n = lm.landmarks.length;
    lm.landmarks = lm.landmarks.filter((l: Json) => inCell(b, l.x, l.z));
    count('landmarks', n, lm.landmarks.length);
  }
  return dropped;
}
