/**
 * The seam pass (contract sections 4 and 10, step 5). Neighbouring tiles both hold the heightmap samples on their shared edge;
 * after both are baked the samples differ a little (each tile's road profiles and cut and fill are its own). The pass makes them
 * identical and fades the change out over `RAMP` metres into each tile, on everything that has a height.
 *
 * The correction field of a tile. Every seam sample (a heightmap sample on the edge of a cell) gets a target: the mean of the
 * heights all baked tiles holding it have there (two tiles along a seam, up to four at a corner), so the corner sample has one
 * target for all the tiles that meet there. delta_T(s) = target(s) - h_T(s) on each of the tile's four sides (on a side with no
 * baked neighbour: 0, except near a corner that is shared through another side, where it fades from the corner's delta to 0
 * over RAMP along the side). With w(d) = max(0, 1 - d / RAMP) and d the distance to a side's line, the field is the Coons patch
 *
 *   c(x, z) = sum over sides of delta_side(along) * w(d_side)  -  sum over corners of delta_corner * w(d_side1) * w(d_side2)
 *
 * which equals delta_side exactly on each side (the corner terms cancel the neighbouring sides' contributions there, so two
 * seams meeting at a corner are not counted twice), and is 0 farther than RAMP from every side. For two tiles along one seam it
 * is the contract's +-(hB - hA) / 2 * w(d). The seam samples are then set to float32(target), so they are bit-identical.
 *
 * Applied to: height.bin; collision.bin (decks and piers per vertex; each building prism moved as one by the field at its roof's
 * centre, so roofs stay flat and the sim's footprints stay intact); every JSON coordinate with a height; and the .glb vertex
 * positions (dequantized, edited, requantized; normals are left as they are: the grade changes by at most |delta| / RAMP).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collisionBytes, heightmapBytes, readHeightmap } from '../io/binary.js';
import type { Rect } from '../geo.js';
import { mapVertices, readGlb, writeGlb } from './glbEdit.js';
import { fineBlocks, GLB_FILES, JSON_FILES, mapJsonPoints, readTileFiles, type Json } from './tileFiles.js';
import { matchLanePorts, matchWalkPorts, OPPOSITE, seamPorts, type SeamsData } from '../../../../src/shared/seams.js';
import type { SeamSide } from '../../../../src/shared/city.js';

/** The fade length of the correction, m. */
export const RAMP = 48;

export interface SeamTile {
  id: string;
  i: number;
  j: number;
  bounds: Rect;
  /** samples a side (the heightmap is n x n, both edges included) */
  n: number;
  cell: number;
  height: Float32Array;
}

const SIDES: SeamSide[] = ['n', 'e', 's', 'w'];
type Corner = 'ne' | 'nw' | 'se' | 'sw';

export interface TileField {
  b: Rect;
  cell: number;
  n: number;
  /** delta per sample along each side: n and s run along x from minX, e and w along z from minZ */
  side: Record<SeamSide, Float64Array>;
  corner: Record<Corner, number>;
  /** the largest |delta| of the tile */
  max: number;
}

/** The heightmap index of sample k along a side. */
export function sideIndex(n: number, side: SeamSide, k: number): number {
  switch (side) {
    case 'n':
      return k;
    case 's':
      return (n - 1) * n + k;
    case 'w':
      return k * n;
    case 'e':
      return k * n + n - 1;
  }
}

const w = (d: number) => (d >= RAMP ? 0 : 1 - Math.max(0, d) / RAMP);

/**
 * The targets of every seam sample of the given tiles, and each tile's field. The tiles must share cell size and sample count
 * and lie on one grid. Samples are keyed by their global lattice position.
 */
export function computeFields(tiles: SeamTile[]): { fields: Map<string, TileField>; targets: Map<string, number>; holders: Map<string, number> } {
  const n = tiles[0]?.n ?? 0;
  const cells = n - 1;
  const sum = new Map<string, number>();
  const cnt = new Map<string, number>();
  const key = (t: SeamTile, k: number, side: SeamSide) => {
    const [c, r] = side === 'n' ? [k, 0] : side === 's' ? [k, cells] : side === 'w' ? [0, k] : [cells, k];
    return `${t.i * cells + c},${t.j * cells + r}`;
  };
  for (const t of tiles) {
    if (t.n !== n) throw new Error(`tile ${t.id}: ${t.n} samples a side, expected ${n}`);
    const seen = new Set<string>();
    for (const side of SIDES) {
      for (let k = 0; k < n; k++) {
        const kk = key(t, k, side);
        if (seen.has(kk)) continue; // a corner is on two sides
        seen.add(kk);
        sum.set(kk, (sum.get(kk) ?? 0) + t.height[sideIndex(n, side, k)]);
        cnt.set(kk, (cnt.get(kk) ?? 0) + 1);
      }
    }
  }
  const targets = new Map<string, number>();
  for (const [k, s] of sum) targets.set(k, s / cnt.get(k)!);
  const byCell = new Set(tiles.map((t) => `${t.i},${t.j}`));
  const fields = new Map<string, TileField>();
  for (const t of tiles) {
    const nb: Record<SeamSide, boolean> = {
      n: byCell.has(`${t.i},${t.j - 1}`),
      s: byCell.has(`${t.i},${t.j + 1}`),
      e: byCell.has(`${t.i + 1},${t.j}`),
      w: byCell.has(`${t.i - 1},${t.j}`),
    };
    const side = {} as Record<SeamSide, Float64Array>;
    let max = 0;
    for (const s of SIDES) {
      const d = new Float64Array(n);
      for (let k = 0; k < n; k++) d[k] = targets.get(key(t, k, s))! - t.height[sideIndex(n, s, k)];
      if (!nb[s]) {
        // no neighbour on this side: only the corners can be shared (through the other sides); fade them out along it
        const d0 = d[0], d1 = d[n - 1];
        for (let k = 0; k < n; k++) d[k] = d0 * w(k * t.cell) + d1 * w((n - 1 - k) * t.cell);
      }
      for (let k = 0; k < n; k++) max = Math.max(max, Math.abs(d[k]));
      side[s] = d;
    }
    const corner: Record<Corner, number> = { nw: side.n[0], ne: side.n[n - 1], sw: side.s[0], se: side.s[n - 1] };
    fields.set(t.id, { b: t.bounds, cell: t.cell, n, side, corner, max });
  }
  return { fields, targets, holders: cnt };
}

function along(d: Float64Array, a: number, cell: number): number {
  const f = Math.max(0, Math.min(d.length - 1, a / cell));
  const k = Math.min(d.length - 2, Math.floor(f));
  const u = f - k;
  return d[k] * (1 - u) + d[k + 1] * u;
}

/** The correction at (x, z) of a tile (see the file comment). 0 beyond RAMP from every side. */
export function fieldAt(f: TileField, x: number, z: number): number {
  if (f.max === 0) return 0;
  const { b } = f;
  const dn = z - b.minZ, ds = b.maxZ - z, dw = x - b.minX, de = b.maxX - x;
  const wn = w(dn), ws = w(ds), ww = w(dw), we = w(de);
  if (wn === 0 && ws === 0 && ww === 0 && we === 0) return 0;
  const ax = x - b.minX, az = z - b.minZ;
  let c = 0;
  if (wn) c += along(f.side.n, ax, f.cell) * wn;
  if (ws) c += along(f.side.s, ax, f.cell) * ws;
  if (ww) c += along(f.side.w, az, f.cell) * ww;
  if (we) c += along(f.side.e, az, f.cell) * we;
  c -= f.corner.nw * wn * ww + f.corner.ne * wn * we + f.corner.sw * ws * ww + f.corner.se * ws * we;
  return c;
}

/** Applies a field to a heightmap and sets the shared seam samples to float32(target). */
export function applyToHeights(t: SeamTile, f: TileField, targets: Map<string, number>, holders: Map<string, number>): void {
  const { n, cell, bounds: b } = t;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const v = fieldAt(f, b.minX + c * cell, b.minZ + r * cell);
    if (v) t.height[r * n + c] += v;
  }
  const cells = n - 1;
  for (const side of SIDES) {
    for (let k = 0; k < n; k++) {
      const [c, r] = side === 'n' ? [k, 0] : side === 's' ? [k, cells] : side === 'w' ? [0, k] : [cells, k];
      const kk = `${t.i * cells + c},${t.j * cells + r}`;
      if ((holders.get(kk) ?? 0) > 1) t.height[r * n + c] = Math.fround(targets.get(kk)!);
    }
  }
}

/** Applies a field to the samples of the optional fine layer (`heightmapFine`), block by block. */
export function applyToFine(tile: Json, fine: Float32Array, f: TileField): void {
  const fb = fineBlocks(tile);
  if (!fb) return;
  const m = fb.block + 1;
  for (let k = 0; k * m * m < fine.length; k++) {
    const [x0, z0] = fb.origin(k);
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
      const v = fieldAt(f, x0 + c * fb.cell, z0 + r * fb.cell);
      if (v) fine[k * m * m + r * m + c] += v;
    }
  }
}

/** The building prisms of collision.bin: runs of wall triangles followed by roof triangles (the bake writes walls, then the roof). */
export function buildingRuns(p: Float32Array, idx: Uint32Array, buildingTriangles: number): { t0: number; roof0: number; t1: number }[] {
  const out: { t0: number; roof0: number; t1: number }[] = [];
  const n = Math.min(buildingTriangles, Math.floor(idx.length / 3));
  let cur: { t0: number; roof0: number; t1: number } | null = null;
  let prevFlat = true;
  for (let t = 0; t < n; t++) {
    const ya = p[idx[t * 3] * 3 + 1], yb = p[idx[t * 3 + 1] * 3 + 1], yc = p[idx[t * 3 + 2] * 3 + 1];
    const flat = Math.abs(ya - yb) <= 1e-3 && Math.abs(yb - yc) <= 1e-3;
    if (!flat && (prevFlat || !cur)) {
      if (cur) out.push(cur);
      cur = { t0: t, roof0: -1, t1: t + 1 };
    } else if (!cur) cur = { t0: t, roof0: t, t1: t + 1 };
    if (flat && cur.roof0 < 0) cur.roof0 = t;
    cur.t1 = t + 1;
    prevFlat = flat;
  }
  if (cur) out.push(cur);
  return out;
}

/** Applies a field to collision.bin positions: per building prism one shift (at its roof's centre), per vertex elsewhere. */
export function applyToCollision(pos: Float32Array, idx: Uint32Array, buildingTriangles: number, f: TileField): void {
  const done = new Uint8Array(pos.length / 3);
  for (const run of buildingRuns(pos, idx, buildingTriangles)) {
    let sx = 0, sz = 0, k = 0;
    const r0 = run.roof0 >= 0 ? run.roof0 : run.t0;
    for (let t = r0; t < run.t1; t++) for (let q = 0; q < 3; q++) {
      const v = idx[t * 3 + q];
      sx += pos[v * 3];
      sz += pos[v * 3 + 2];
      k++;
    }
    const c = fieldAt(f, sx / k, sz / k);
    for (let t = run.t0; t < run.t1; t++) for (let q = 0; q < 3; q++) {
      const v = idx[t * 3 + q];
      if (done[v]) continue;
      done[v] = 1;
      pos[v * 3 + 1] += c;
    }
  }
  for (let v = 0; v < done.length; v++) {
    if (done[v]) continue;
    const c = fieldAt(f, pos[v * 3], pos[v * 3 + 2]);
    if (c) pos[v * 3 + 1] += c;
  }
}

export async function applyToGlb(bytes: Uint8Array, f: TileField): Promise<{ bytes: Uint8Array; nodes: number }> {
  const doc = await readGlb(bytes);
  const nodes = mapVertices(doc, (wp) => {
    let any = false;
    for (let i = 0; i < wp.length; i += 3) {
      const c = fieldAt(f, wp[i], wp[i + 2]);
      if (c) {
        wp[i + 1] += c;
        any = true;
      }
    }
    return any;
  });
  return { bytes: nodes ? await writeGlb(doc) : bytes, nodes };
}

export function applyToJson(t: { tile: Json; json: Json }, f: TileField): void {
  mapJsonPoints(t, (x, y, z) => [x, y + fieldAt(f, x, z), z], (x, z) => [x, z]);
}

export interface SeamReportEntry {
  a: string;
  b: string;
  side: SeamSide;
  /** the largest |hB - hA| / 2 before the pass, m */
  maxDelta: number;
  lanes: { matched: number; unmatched: number; unmatchedKeys: string[] };
  walk: { matched: number; unmatched: number };
  /** the largest height difference of the matched ports after the pass, m (lanes and walk nodes; then each) */
  maxPortStep: number;
  maxLaneStep: number;
  maxWalkStep: number;
}

export interface SeamPassResult {
  seams: SeamReportEntry[];
  totals: { matched: number; unmatched: number; maxStep: number };
  maxDelta: number;
  rewritten: string[];
}

export interface SeamPassTile {
  id: string;
  i: number;
  j: number;
  dir: string;
}

/** Runs the pass over the tiles in `dirs` (all baked tiles of the grid), rewrites the ones it changes, writes every seams.json. */
export async function seamPass(list: SeamPassTile[], log: (m: string) => void = console.log): Promise<SeamPassResult> {
  const tiles: SeamTile[] = list.map((t) => {
    const tile = JSON.parse(readFileSync(path.join(t.dir, 'tile.json'), 'utf8'));
    const hm = tile.heightmap;
    if (hm.cols !== hm.rows) throw new Error(`tile ${t.id}: the heightmap is not square`);
    const height = readHeightmap(readFileSync(path.join(t.dir, hm.file)));
    return { id: t.id, i: t.i, j: t.j, bounds: tile.bounds, n: hm.cols, cell: hm.cellSize, height };
  });
  const before = new Map(tiles.map((t) => [t.id, Float32Array.from(t.height)]));
  const { fields, targets, holders } = computeFields(tiles);
  const rewritten: string[] = [];
  let maxDelta = 0;
  for (const t of tiles) {
    const f = fields.get(t.id)!;
    maxDelta = Math.max(maxDelta, f.max);
    if (f.max === 0) continue;
    const dir = list.find((x) => x.id === t.id)!.dir;
    const files = readTileFiles(dir);
    applyToHeights(t, f, targets, holders);
    writeFileSync(path.join(dir, files.tile.heightmap.file), heightmapBytes(t.height));
    if (files.fine) {
      // the road-corridor layer: no block touches a seam (the contract), but one within RAMP of it follows the coarse ground
      applyToFine(files.tile, files.fine, f);
      writeFileSync(path.join(dir, files.tile.heightmapFine.file), heightmapBytes(files.fine));
    }
    applyToCollision(files.collision.positions, files.collision.indices, files.tile.collision.buildingTriangles ?? 0, f);
    writeFileSync(path.join(dir, files.tile.collision.file), collisionBytes(files.collision.positions, files.collision.indices));
    applyToJson(files, f);
    for (const name of JSON_FILES) if (files.json[name]) writeFileSync(path.join(dir, name), JSON.stringify(files.json[name]));
    writeFileSync(path.join(dir, 'tile.json'), JSON.stringify(files.tile, null, 2));
    let nodes = 0;
    for (const g of GLB_FILES) {
      const r = await applyToGlb(readFileSync(path.join(dir, g)), f);
      nodes += r.nodes;
      if (r.nodes) writeFileSync(path.join(dir, g), r.bytes);
    }
    rewritten.push(t.id);
    log(`seams: ${t.id} corrected by up to ${f.max.toFixed(3)} m (${nodes} mesh nodes requantized)`);
  }
  // check: every shared seam sample is bit-identical now
  const byCell = new Map(tiles.map((t) => [`${t.i},${t.j}`, t]));
  const seams: SeamReportEntry[] = [];
  for (const a of tiles) {
    for (const side of ['e', 's'] as SeamSide[]) {
      const b = byCell.get(side === 'e' ? `${a.i + 1},${a.j}` : `${a.i},${a.j + 1}`);
      if (!b) continue;
      let md = 0;
      for (let k = 0; k < a.n; k++) {
        const ia = sideIndex(a.n, side, k), ib = sideIndex(a.n, OPPOSITE[side], k);
        if (a.height[ia] !== b.height[ib]) throw new Error(`seam ${a.id}|${b.id}: sample ${k} differs after the pass (${a.height[ia]} vs ${b.height[ib]})`);
        md = Math.max(md, Math.abs(before.get(b.id)![ib] - before.get(a.id)![ia]) / 2);
      }
      seams.push({ a: a.id, b: b.id, side, maxDelta: md, lanes: { matched: 0, unmatched: 0, unmatchedKeys: [] }, walk: { matched: 0, unmatched: 0 }, maxPortStep: 0, maxLaneStep: 0, maxWalkStep: 0 });
    }
  }
  // seams.json for every tile, and the match report
  const ports = new Map<string, SeamsData>();
  for (const t of list) {
    const dir = t.dir;
    const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
    const rd = (f: string) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    };
    const s = seamPorts(t.id, tile.bounds, { lanes: rd('lanes.json'), paths: rd('paths.json'), roads: rd('roads.json')?.roads ?? null });
    ports.set(t.id, s);
    writeFileSync(path.join(dir, 'seams.json'), JSON.stringify(s));
  }
  let matched = 0, unmatched = 0, maxStep = 0;
  for (const e of seams) {
    const pa = ports.get(e.a)!.sides[e.side];
    const pb = ports.get(e.b)!.sides[OPPOSITE[e.side]];
    const lm = matchLanePorts(pa?.lanes ?? [], pb?.lanes ?? []);
    const wm = matchWalkPorts(pa?.walk ?? [], pb?.walk ?? []);
    e.lanes = { matched: lm.pairs.length, unmatched: lm.unmatched.length, unmatchedKeys: lm.unmatched.map((p) => `${p.key}@${p.p.map((v) => v.toFixed(1)).join(',')}`) };
    e.walk = { matched: wm.pairs.length, unmatched: wm.unmatched.length };
    for (const p of lm.pairs) e.maxLaneStep = Math.max(e.maxLaneStep, Math.abs(p.out.p[1] - p.into.p[1]));
    for (const [p, q] of wm.pairs) e.maxWalkStep = Math.max(e.maxWalkStep, Math.abs(p.p[1] - q.p[1]));
    e.maxPortStep = Math.max(e.maxLaneStep, e.maxWalkStep);
    matched += lm.pairs.length + wm.pairs.length;
    unmatched += lm.unmatched.length + wm.unmatched.length;
    maxStep = Math.max(maxStep, e.maxPortStep);
    log(`seam ${e.a}|${e.b}: delta up to ${e.maxDelta.toFixed(3)} m; lanes ${e.lanes.matched} matched, ${e.lanes.unmatched} not; walk ${e.walk.matched} matched, ${e.walk.unmatched} not; largest port step ${e.maxLaneStep.toFixed(3)} m (lanes), ${e.maxWalkStep.toFixed(3)} m (walk)`);
  }
  return { seams, totals: { matched, unmatched, maxStep: Math.round(maxStep * 1000) / 1000 }, maxDelta, rewritten };
}
