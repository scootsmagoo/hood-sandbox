import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import type { V2 } from '../geo.js';
import type { MeshBuilder } from '../mesh/builder.js';

/**
 * One drivable surface per deck level.
 *
 * The car decks are ribbons, one per way (and caps at their joints). Their tops used to be separate meshes, so where two met or
 * overlapped there was an edge between them that no internal-edge fix could reach (the triangles share no vertices), and the
 * smallest difference of height between two ribbons was a step under a wheel. Here the tops of every level of deck (the ribbons
 * that touch or overlap at about the same height) become one welded mesh: the union of the level's ribbons and caps, cut by a
 * grid of `cell` m squares aligned with the heightmap (a square wholly on the deck is two triangles; one on its edge is the
 * part of the square on the deck, triangulated), every vertex shared with its neighbours, and every vertex at the level's
 * height there: each ribbon's own top (its four collision corners, bilinear), and where ribbons overlap their weighted mean, the
 * one whose middle is nearer counting more. The ribbons keep their sides and undersides.
 */

/** One segment of a car deck's collision top: its four corners (left and right at both ends) and their heights. */
export interface WeldSegment {
  piece: number;
  /** which of two decks overlapping at different heights keeps the overlap: the higher class, then the wider */
  rank: number;
  /** centreline ends */
  a: V2;
  b: V2;
  half: number;
  l0: V2; r0: V2; l1: V2; r1: V2;
  hl0: number; hr0: number; hl1: number; hr1: number;
}

/** A cap at a joint of decks: its outline and the height at each corner. */
export interface WeldPolygon { ring: V2[]; heights: number[] }

export interface WeldStats { levels: number; triangles: number; vertices: number; failedLevels: number; clashes?: number }

const SNAP = 1000;
/** Decks overlapping within this of each other's height are one level (m); further apart they are two. */
const SAME_LEVEL = 0.35;
/** Two levels this close in height where they overlap cannot both be driven (a car does not fit between): one keeps the overlap. */
const CLASH = 2.5;
const snap = (v: number) => Math.round(v * SNAP) / SNAP;

/** The height of segment `s` at (x, z) (bilinear over its quad), the lateral distance outside its edge, and t along it. */
function sample(s: WeldSegment, x: number, z: number): { h: number; out: number; t: number } {
  const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
  const l2 = dx * dx + dz * dz;
  const tr = l2 === 0 ? 0 : ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2;
  const t = Math.max(0, Math.min(1, tr));
  const px = s.a[0] + dx * t, pz = s.a[1] + dz * t;
  const l = Math.sqrt(l2) || 1;
  // signed lateral offset: + toward the right edge
  const nx = -dz / l, nz = dx / l;
  const lat = (x - px) * nx + (z - pz) * nz;
  const u = Math.max(0, Math.min(1, (lat + s.half) / (2 * s.half || 1)));
  // the right edge is +n (ribbonEdges: right = p + n * half)
  const h0 = s.hl0 + (s.hr0 - s.hl0) * u, h1 = s.hl1 + (s.hr1 - s.hl1) * u;
  const along = Math.max(0, -tr * l, (tr - 1) * l);
  return { h: h0 + (h1 - h0) * t, out: Math.max(0, Math.abs(lat) - s.half) + along, t };
}

/** Writes the welded tops of every level into `col` (positions and indices). */
export function weldDeckTops(col: MeshBuilder, segs: WeldSegment[], polys: WeldPolygon[], cell = 4, origin: V2 = [-1000, -1000], ground?: (x: number, z: number) => number): WeldStats {
  const stats: WeldStats = { levels: 0, triangles: 0, vertices: 0, failedLevels: 0 };
  if (!segs.length) return stats;
  // ---- levels: segments of one piece are one level; segments of two pieces that overlap at about the same height are too
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const G = 16;
  const grid = new Map<string, number[]>();
  const bbox = segs.map((s) => {
    const xs = [s.l0[0], s.r0[0], s.l1[0], s.r1[0]], zs = [s.l0[1], s.r0[1], s.l1[1], s.r1[1]];
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  });
  segs.forEach((_, i) => {
    const b = bbox[i];
    for (let gx = Math.floor(b.x0 / G); gx <= Math.floor(b.x1 / G); gx++) for (let gz = Math.floor(b.z0 / G); gz <= Math.floor(b.z1 / G); gz++) {
      const k = `${gx},${gz}`;
      const l = grid.get(k);
      if (l) l.push(i); else grid.set(k, [i]);
    }
  });
  const near = (x0: number, z0: number, x1: number, z1: number): Set<number> => {
    const out = new Set<number>();
    for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) for (const i of grid.get(`${gx},${gz}`) ?? []) out.add(i);
    return out;
  };
  const byPiece = new Map<number, number>();
  segs.forEach((s, i) => { const p = byPiece.get(s.piece); if (p === undefined) byPiece.set(s.piece, i); else join(i, p); });
  segs.forEach((s, i) => {
    const b = bbox[i];
    for (const j of near(b.x0, b.z0, b.x1, b.z1)) {
      if (j <= i || segs[j].piece === s.piece) continue;
      const c = bbox[j];
      if (c.x0 > b.x1 || c.x1 < b.x0 || c.z0 > b.z1 || c.z1 < b.z0) continue;
      // overlap at about one height: a corner or the middle of one inside the other's quad, heights within a metre
      const probes: V2[] = [s.l0, s.r0, s.l1, s.r1, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], s.a, s.b];
      for (const q of probes) {
        const sj = sample(segs[j], q[0], q[1]);
        if (sj.out > 0.3) continue;
        const si = sample(s, q[0], q[1]);
        if (Math.abs(si.h - sj.h) < SAME_LEVEL) { join(i, j); break; }
      }
    }
  });
  const levels = new Map<number, number[]>();
  segs.forEach((_, i) => { const r = find(i); const l = levels.get(r); if (l) l.push(i); else levels.set(r, [i]); });
  // caps go to the level of the segment under their middle at the nearest height
  const capsOf = new Map<number, WeldPolygon[]>();
  for (const p of polys) {
    const cx = p.ring.reduce((a, q) => a + q[0], 0) / p.ring.length, cz = p.ring.reduce((a, q) => a + q[1], 0) / p.ring.length;
    const ch = p.heights.reduce((a, v) => a + v, 0) / p.heights.length;
    let best = -1, bd = Infinity;
    for (const j of near(cx - 20, cz - 20, cx + 20, cz + 20)) {
      const sj = sample(segs[j], cx, cz);
      const d = sj.out + Math.abs(sj.h - ch) * 4;
      if (d < bd) { bd = d; best = j; }
    }
    if (best < 0) continue;
    const r = find(best);
    const l = capsOf.get(r);
    if (l) l.push(p); else capsOf.set(r, [p]);
  }

  // ---- each level: its shapes (quads and caps) by grid cell, and its height function
  interface Level { members: number[]; set: Set<number>; caps: WeldPolygon[]; shapes: polygonClipping.Polygon[]; shapeSeg: number[]; cells: Map<string, number[]>; rank: number; height: (x: number, z: number, only?: Set<number>) => number; cut: Level[] }
  const L: Level[] = [];
  for (const [root, members] of levels) {
    const set = new Set(members);
    const caps = capsOf.get(root) ?? [];
    // the level's height at a point: the weighted mean of its segments there (the nearer the middle, the more), only of those at
    // about the height of the nearest one; a cap with no ribbon near, its nearest corner
    // (`only`: the nearest of these segments sets which height the point is at, where the level's ribbons lie side by side at
    // different heights)
    const height = (x: number, z: number, only?: Set<number>): number => {
      const cand: { h: number; out: number; j: number }[] = [];
      for (const j of near(x - 1, z - 1, x + 1, z + 1)) {
        if (!set.has(j)) continue;
        const sj = sample(segs[j], x, z);
        cand.push({ h: sj.h, out: sj.out, j });
      }
      if (cand.length) {
        cand.sort((p, q) => p.out - q.out);
        const first = only ? cand.find((c) => only.has(c.j)) ?? cand[0] : cand[0];
        const h0 = first.h;
        let sw = 0, sh = 0;
        for (const c of cand) {
          if (c.out > 1.5 || Math.abs(c.h - h0) > SAME_LEVEL * 2) continue;
          const e = c.out + 0.35;
          const w = 1 / (e * e * e);
          sw += w; sh += w * c.h;
        }
        return sw > 0 ? sh / sw : h0;
      }
      let cd = Infinity, ch = 0;
      for (const p of caps) p.ring.forEach((q, k) => { const d = Math.hypot(q[0] - x, q[1] - z); if (d < cd) { cd = d; ch = p.heights[k]; } });
      return ch;
    };
    const shapes: polygonClipping.Polygon[] = [];
    const shapeSeg: number[] = [];
    const cells = new Map<string, number[]>();
    const addShape = (ring: V2[], j: number) => {
      const k = shapes.length;
      shapeSeg.push(j);
      const closed = [...ring.map((q) => [snap(q[0]), snap(q[1])] as [number, number]), [snap(ring[0][0]), snap(ring[0][1])] as [number, number]];
      shapes.push([closed]);
      const xs = ring.map((q) => q[0]), zs = ring.map((q) => q[1]);
      for (let cx = Math.floor((Math.min(...xs) - origin[0]) / cell); cx <= Math.floor((Math.max(...xs) - origin[0]) / cell); cx++) {
        for (let cz = Math.floor((Math.min(...zs) - origin[1]) / cell); cz <= Math.floor((Math.max(...zs) - origin[1]) / cell); cz++) {
          const key = `${cx},${cz}`;
          const l = cells.get(key);
          if (l) l.push(k); else cells.set(key, [k]);
        }
      }
    };
    for (const j of members) {
      const sg = segs[j];
      const ring: V2[] = [sg.l0, sg.l1, sg.r1, sg.r0];
      const area = Math.abs((sg.l1[0] - sg.r0[0]) * (sg.r1[1] - sg.l0[1]) - (sg.r1[0] - sg.l0[0]) * (sg.l1[1] - sg.r0[1])) / 2;
      if (area > 1e-4) addShape(ring, j);
    }
    for (const p of caps) if (p.ring.length >= 3) addShape(p.ring, -1);
    L.push({ members, set, caps, shapes, shapeSeg, cells, rank: Math.max(...members.map((j) => segs[j].rank)), height, cut: [] });
  }
  // ---- clashes: two levels that overlap less than CLASH apart in height (a car does not fit between them). Each keeps the part
  // of the overlap nearer its own centreline (two carriageways drawn wider than the gap between them, a ramp beside the viaduct it
  // has left: their lanes keep to their own halves); where their centrelines meet, the higher-ranked one keeps it.
  const levelOf = new Int32Array(segs.length);
  L.forEach((lv, k) => { for (const j of lv.members) levelOf[j] = k; });
  const pairs = new Set<string>();
  segs.forEach((sg, i) => {
    const b = bbox[i];
    for (const j of near(b.x0, b.z0, b.x1, b.z1)) {
      const li = levelOf[i], lj = levelOf[j];
      if (li === lj || pairs.has(`${Math.min(li, lj)},${Math.max(li, lj)}`)) continue;
      const probes: V2[] = [sg.l0, sg.r0, sg.l1, sg.r1, [(sg.a[0] + sg.b[0]) / 2, (sg.a[1] + sg.b[1]) / 2]];
      for (const q of probes) {
        const sj = sample(segs[j], q[0], q[1]);
        if (sj.out > 0) continue;
        if (Math.abs(sample(sg, q[0], q[1]).h - sj.h) < CLASH) {
          pairs.add(`${Math.min(li, lj)},${Math.max(li, lj)}`);
          break;
        }
      }
    }
  });
  for (const key of pairs) {
    const [a, b] = key.split(',').map(Number);
    L[a].cut.push(L[b]);
    L[b].cut.push(L[a]);
    stats.clashes = (stats.clashes ?? 0) + 1;
  }
  // the member of `set` whose centreline is nearest (x, z), and the nearest point on it
  const nearestOf = (set: Iterable<number>, x: number, z: number): { j: number; p: V2 } | null => {
    let best: { j: number; p: V2 } | null = null, bd = Infinity;
    for (const j of set) {
      const sg = segs[j];
      const dx = sg.b[0] - sg.a[0], dz = sg.b[1] - sg.a[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - sg.a[0]) * dx + (z - sg.a[1]) * dz) / l2));
      const p: V2 = [sg.a[0] + dx * t, sg.a[1] + dz * t];
      const d = Math.hypot(x - p[0], z - p[1]);
      if (d < bd) { bd = d; best = { j, p }; }
    }
    return best;
  };
  // the half-plane nearer centreline B than centreline A about (x, z), as a big polygon; null where they meet there
  const territory = (a: Iterable<number>, b: Iterable<number>, x: number, z: number): polygonClipping.Polygon | null => {
    const na = nearestOf(a, x, z), nb = nearestOf(b, x, z);
    if (!na || !nb) return null;
    const dx = nb.p[0] - na.p[0], dz = nb.p[1] - na.p[1];
    const l = Math.hypot(dx, dz);
    if (l < 0.25) return null;
    const nx = dx / l, nz = dz / l, tx = -nz, tz = nx, B = 60;
    const mx = (na.p[0] + nb.p[0]) / 2, mz = (na.p[1] + nb.p[1]) / 2;
    const ring: [number, number][] = [[mx + tx * B, mz + tz * B], [mx + tx * B + nx * B, mz + tz * B + nz * B], [mx - tx * B + nx * B, mz - tz * B + nz * B], [mx - tx * B, mz - tz * B]];
    // counter-clockwise or not, the clipper takes either
    return [[...ring, ring[0]]];
  };
  const cellMembers = (lv: Level, key: string): number[] => (lv.cells.get(key) ?? []).map((k) => lv.shapeSeg[k]).filter((j) => j >= 0);
  const cellPieces = (lv: Level, key: string, square: polygonClipping.Polygon): polygonClipping.MultiPolygon => {
    const list = lv.cells.get(key);
    if (!list) return [];
    const parts = list.map((k) => polygonClipping.intersection(square, lv.shapes[k])).filter((mp) => mp.length);
    if (!parts.length) return [];
    return parts.length === 1 ? parts[0] : polygonClipping.union(parts[0], ...parts.slice(1));
  };
  /**
   * The level's shapes in a cell, in groups that are one surface there: ribbons that overlap at about one height (and the
   * consecutive segments of a ribbon, and the caps). Two ribbons of a level that run side by side at different heights (a ramp
   * that has left a viaduct, still touching it, a metre lower) are two groups: triangulated together, a triangle spanned the
   * gap between them, a slope under the wheel track by the kerb.
   */
  const cellGroups = (lv: Level, key: string, square: polygonClipping.Polygon): { parts: polygonClipping.MultiPolygon; segs: Set<number> }[] => {
    const list = lv.cells.get(key);
    if (!list) return [];
    const clipped: { k: number; mp: polygonClipping.MultiPolygon }[] = [];
    for (const k of list) { const mp = polygonClipping.intersection(square, lv.shapes[k]); if (mp.length) clipped.push({ k, mp }); }
    if (!clipped.length) return [];
    const par = clipped.map((_, i) => i);
    const f = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    if (clipped.length > 1) {
      for (let a = 0; a < clipped.length; a++) {
        for (let b = a + 1; b < clipped.length; b++) {
          if (f(a) === f(b)) continue;
          const ja = lv.shapeSeg[clipped[a].k], jb = lv.shapeSeg[clipped[b].k];
          // a cap, or the next segment of the same ribbon: one surface
          if (ja < 0 || jb < 0 || (segs[ja].piece === segs[jb].piece && Math.abs(ja - jb) === 1)) { par[f(a)] = f(b); continue; }
          let inter: polygonClipping.MultiPolygon;
          try { inter = polygonClipping.intersection(clipped[a].mp, clipped[b].mp); } catch { inter = []; }
          let probes: V2[] = [];
          for (const poly of inter) for (const q of poly[0]) probes.push([q[0], q[1]]);
          if (!probes.length) {
            // touching along an edge (or not at all): compare the two at the corners of one that lie on the other
            for (const poly of clipped[a].mp) for (const q of poly[0]) if (sample(segs[jb], q[0], q[1]).out < 0.05) probes.push([q[0], q[1]]);
            if (!probes.length) continue;
          }
          let worst = 0;
          for (const q of probes) worst = Math.max(worst, Math.abs(sample(segs[ja], q[0], q[1]).h - sample(segs[jb], q[0], q[1]).h));
          if (worst < SAME_LEVEL) par[f(a)] = f(b);
        }
      }
    }
    const groups = new Map<number, { mps: polygonClipping.MultiPolygon[]; segs: Set<number> }>();
    clipped.forEach((c, i) => {
      const r = f(i);
      let g = groups.get(r);
      if (!g) { g = { mps: [], segs: new Set() }; groups.set(r, g); }
      g.mps.push(c.mp);
      const j = lv.shapeSeg[c.k];
      if (j >= 0) g.segs.add(j);
    });
    return [...groups.values()].map((g) => ({ parts: g.mps.length === 1 ? g.mps[0] : polygonClipping.union(g.mps[0], ...g.mps.slice(1)), segs: g.segs }));
  };

  for (const lv of L) {
    stats.levels++;
    const index = new Map<string, number>();
    const tris: number[] = [];
    // a vertex is shared by every triangle of the level at that point and height (two groups side by side each have their own)
    let only: Set<number> | undefined;
    const vert = (x: number, z: number): number => {
      const sx = snap(x), sz = snap(z);
      const h = lv.height(sx, sz, only);
      const k = `${sx},${sz},${Math.round(h * 50)}`;
      let v = index.get(k);
      if (v === undefined) {
        v = col.vertex(sx, h, sz, 0, 1, 0);
        index.set(k, v);
        stats.vertices++;
      }
      return v;
    };
    let failed = false;
    for (const key of lv.cells.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      const x0 = origin[0] + cx * cell, z0 = origin[1] + cz * cell, x1 = x0 + cell, z1 = z0 + cell;
      const square: polygonClipping.Polygon = [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]];
      let groups: { parts: polygonClipping.MultiPolygon; segs: Set<number> }[];
      try {
        // the clipper is given each shape cut to the square first: small inputs, and the same answer on both sides of a shared edge
        groups = cellGroups(lv, key, square);
        if (!groups.length) continue;
        const cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2;
        // two groups of the level overlapping at different heights: split the overlap between them the same way
        if (groups.length > 1) {
          const orig = groups.map((g) => g.parts);
          for (let a = 0; a < groups.length; a++) {
            for (let b = 0; b < groups.length; b++) {
              if (a === b || !groups[a].parts.length || !orig[b].length || !groups[a].segs.size || !groups[b].segs.size) continue;
              const hp = territory(groups[a].segs, groups[b].segs, cxm, czm);
              const theirs = hp ? polygonClipping.intersection(orig[b], hp) : [];
              if (theirs.length) groups[a].parts = polygonClipping.difference(groups[a].parts, theirs);
            }
          }
        }
        for (const w of lv.cut) {
          const wp = cellPieces(w, key, square);
          if (!wp.length) continue;
          const mine = cellMembers(lv, key), others = cellMembers(w, key);
          const hp = territory(mine, others, cxm, czm);
          // (where the centrelines meet the greater road keeps the overlap)
          const theirs = hp ? polygonClipping.intersection(wp, hp) : w.rank >= lv.rank ? wp : [];
          if (!theirs.length) continue;
          for (const g of groups) if (g.parts.length) g.parts = polygonClipping.difference(g.parts, theirs);
        }
      } catch {
        failed = true;
        break;
      }
      for (const g of groups) {
      only = groups.length > 1 && g.segs.size ? g.segs : undefined;
      for (const poly of g.parts) {
        const outer = poly[0];
        const area = Math.abs(outer.slice(0, -1).reduce((acc, q, k, arr) => { const n = arr[(k + 1) % arr.length]; return acc + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2;
        if (area < 1e-4) continue;
        // a whole square: two triangles, cut south-west to north-east like the ground
        if (poly.length === 1 && outer.length === 5 && Math.abs(area - cell * cell) < 1e-3) {
          const a = vert(x0, z0), b = vert(x0, z1), c = vert(x1, z0), d = vert(x1, z1); // NW, SW, NE, SE (z grows south)
          tris.push(a, b, c, c, b, d);
          continue;
        }
        const flat: number[] = [];
        const holes: number[] = [];
        const ids: number[] = [];
        poly.forEach((ring, r) => {
          if (r > 0) holes.push(flat.length / 2);
          for (let k = 0; k + 1 < ring.length; k++) { flat.push(ring[k][0], ring[k][1]); ids.push(vert(ring[k][0], ring[k][1])); }
        });
        const t = earcut(flat, holes.length ? holes : undefined);
        for (let k = 0; k + 2 < t.length; k += 3) {
          const p = ids[t[k]], q = ids[t[k + 1]], r = ids[t[k + 2]];
          if (p === q || q === r || p === r) continue;
          // wind each triangle to face up (+y), as the ribbons' tops do
          const ax = flat[t[k] * 2], az = flat[t[k] * 2 + 1], bx = flat[t[k + 1] * 2], bz = flat[t[k + 1] * 2 + 1], cxx = flat[t[k + 2] * 2], czz = flat[t[k + 2] * 2 + 1];
          const ny = (bz - az) * (cxx - ax) - (bx - ax) * (czz - az);
          if (Math.abs(ny) < 1e-9) continue;
          if (ny > 0) tris.push(p, q, r); else tris.push(p, r, q);
        }
      }
      }
    }
    if (failed) {
      // the clipper gave up on this level: its ribbons' own tops then (the old way)
      stats.failedLevels++;
      for (const j of lv.members) {
        const sg = segs[j];
        const b = col.vertexCount;
        col.vertex(sg.l0[0], sg.hl0, sg.l0[1], 0, 1, 0); col.vertex(sg.r0[0], sg.hr0, sg.r0[1], 0, 1, 0);
        col.vertex(sg.l1[0], sg.hl1, sg.l1[1], 0, 1, 0); col.vertex(sg.r1[0], sg.hr1, sg.r1[1], 0, 1, 0);
        col.indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
      continue;
    }
    col.indices.push(...tris);
    stats.triangles += tris.length / 3;
  }
  return stats;
}
