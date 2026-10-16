/**
 * The transit layer, step 4: geometry. What transitStations.ts laid out and the designed tracks, as meshes for `transit.glb`
 * and triangles for `transit.bin` (the sim's collision): tunnels (a roofed box round a track, or one box round two side by
 * side), open trenches, viaducts with parapets and piers, rails and the third rail, station halls with their platforms, edge
 * strips and coffered ceilings, concourses, corridors, stairs and escalators. Two materials: `tr_int` (under the ground: the
 * alpha of COLOR_0 is the light baked from the station's lamps, the outdoor light never reaches it) and `tr_ext` (in the open:
 * the alpha is the ambient occlusion, as the tile's meshes have it). Collision is the same surfaces; a stair is a smooth ramp.
 */
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import type { V2 } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import { STATION, toLocal, toWorld, type Frame, type LocalBox, type Ramp, type StationLayout } from './transitStations.js';

export type RGB = [number, number, number];
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const rgb = (hex: number): RGB => [lin(((hex >> 16) & 255) / 255), lin(((hex >> 8) & 255) / 255), lin((hex & 255) / 255)];

/** The palette: 1970s-80s concrete, brown and orange tile, terrazzo, the yellow edge strip. */
export const COL = {
  concrete: rgb(0x8f8a82),
  darkConcrete: rgb(0x5d5a55),
  tunnel: rgb(0x6c6a66),
  trackBed: rgb(0x3e3b38),
  rail: rgb(0x2b2a29),
  railHead: rgb(0x8a8784),
  thirdRail: rgb(0x55524c),
  cover: rgb(0xb59a5a),
  platform: rgb(0xb3aa9b),
  terrazzo: rgb(0xc2b8a6),
  edge: rgb(0xe8c42a),
  edgeWhite: rgb(0xd9d6cf),
  tileBrown: rgb(0x8a5a3c),
  tileOrange: rgb(0xb8743a),
  tileCream: rgb(0xd2c4a6),
  ceiling: rgb(0x9a958c),
  steps: rgb(0x8c867c),
  escalator: rgb(0x3d3f42),
  balustrade: rgb(0x6e7276),
  viaduct: rgb(0x9b968c),
  parapet: rgb(0xa8a399),
};

export interface TransitMeshes {
  int: MeshBuilder;
  ext: MeshBuilder;
  col: MeshBuilder;
}

export const newMeshes = (): TransitMeshes => ({ int: new MeshBuilder(), ext: new MeshBuilder(), col: new MeshBuilder() });

type P3 = [number, number, number];

/** A planar quad a b c d (counter-clockwise seen from the side it faces), drawn and, when `solid`, in the collision. */
export function quad(mb: MeshBuilder | null, col: MeshBuilder | null, a: P3, b: P3, c: P3, d: P3, color: RGB): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  if (mb) {
    const i = mb.vertex(a[0], a[1], a[2], nx, ny, nz, ...color);
    mb.vertex(b[0], b[1], b[2], nx, ny, nz, ...color);
    mb.vertex(c[0], c[1], c[2], nx, ny, nz, ...color);
    mb.vertex(d[0], d[1], d[2], nx, ny, nz, ...color);
    mb.tri(i, i + 1, i + 2);
    mb.tri(i, i + 2, i + 3);
  }
  if (col) {
    const j = col.vertex(a[0], a[1], a[2], 0, 1, 0);
    col.vertex(b[0], b[1], b[2], 0, 1, 0);
    col.vertex(c[0], c[1], c[2], 0, 1, 0);
    col.vertex(d[0], d[1], d[2], 0, 1, 0);
    col.tri(j, j + 1, j + 2);
    col.tri(j, j + 2, j + 3);
  }
}

/** A vertical wall from a to b (plan), from y0 to y1, facing the side `face` points to (the normal is chosen to face it). */
export function wall(mb: MeshBuilder | null, col: MeshBuilder | null, a: V2, b: V2, y0a: number, y1a: number, y0b: number, y1b: number, face: V2, color: RGB): void {
  if (y1a - y0a < 0.01 && y1b - y0b < 0.01) return;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  // the quad (a, b, b-top, a-top) faces (-dz, 0, dx); flip the order so it faces `face`
  const n: V2 = [-dz, dx];
  const flip = n[0] * face[0] + n[1] * face[1] < 0;
  const A: P3 = [a[0], y0a, a[1]], B: P3 = [b[0], y0b, b[1]], C: P3 = [b[0], y1b, b[1]], D: P3 = [a[0], y1a, a[1]];
  if (flip) quad(mb, col, B, A, D, C, color);
  else quad(mb, col, A, B, C, D, color);
}

/** A horizontal slab face over a polygon (with holes), facing up or down. */
export function slab(mb: MeshBuilder | null, col: MeshBuilder | null, rings: V2[][], y: number, up: boolean, color: RGB): void {
  if (rings.length === 0 || rings[0].length < 3) return;
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((r, k) => {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of r) flat.push(p[0], p[1]);
  });
  const tri = earcut(flat, holes);
  const emit = (target: MeshBuilder, solid: boolean) => {
    const base = target.vertexCount;
    for (let i = 0; i < flat.length; i += 2) {
      if (solid) target.vertex(flat[i], y, flat[i + 1], 0, 1, 0);
      else target.vertex(flat[i], y, flat[i + 1], 0, up ? 1 : -1, 0, ...color);
    }
    for (let i = 0; i + 2 < tri.length; i += 3) {
      // the triangle's winding seen from above decides; make it face up (or down)
      const ax = flat[tri[i] * 2], az = flat[tri[i] * 2 + 1];
      const bx = flat[tri[i + 1] * 2], bz = flat[tri[i + 1] * 2 + 1];
      const cx = flat[tri[i + 2] * 2], cz = flat[tri[i + 2] * 2 + 1];
      // ((b - a) x (c - a)).y > 0: the triangle a b c faces up
      const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const facesUp = crossY > 0;
      if (facesUp === up) target.tri(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
      else target.tri(base + tri[i], base + tri[i + 2], base + tri[i + 1]);
    }
  };
  if (mb) emit(mb, false);
  if (col) emit(col, true);
}

/** An axis box in a frame (u across, v along, y up): all six faces facing out. */
export function box(mb: MeshBuilder | null, col: MeshBuilder | null, f: Frame, u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, color: RGB, faces = 0b111111): void {
  const p = (u: number, v: number, y: number): P3 => {
    const [x, z] = toWorld(f, u, v);
    return [x, y, z];
  };
  const out = (u: number, v: number): V2 => [f.n[0] * u + f.a[0] * v, f.n[1] * u + f.a[1] * v];
  if (faces & 1) slab(mb, col, [[toWorld(f, u0, v0), toWorld(f, u1, v0), toWorld(f, u1, v1), toWorld(f, u0, v1)]], y1, true, color);
  if (faces & 2) slab(mb, col, [[toWorld(f, u0, v0), toWorld(f, u1, v0), toWorld(f, u1, v1), toWorld(f, u0, v1)]], y0, false, color);
  if (faces & 4) wall(mb, col, toWorld(f, u0, v0), toWorld(f, u0, v1), y0, y1, y0, y1, out(-1, 0), color);
  if (faces & 8) wall(mb, col, toWorld(f, u1, v0), toWorld(f, u1, v1), y0, y1, y0, y1, out(1, 0), color);
  if (faces & 16) wall(mb, col, toWorld(f, u0, v0), toWorld(f, u1, v0), y0, y1, y0, y1, out(0, -1), color);
  if (faces & 32) wall(mb, col, toWorld(f, u0, v1), toWorld(f, u1, v1), y0, y1, y0, y1, out(0, 1), color);
  void p;
}

/** The rectangle of a local box as a world ring. */
export const ringOf = (b: Pick<LocalBox, 'frame' | 'u0' | 'u1' | 'v0' | 'v1'>): V2[] => [toWorld(b.frame, b.u0, b.v0), toWorld(b.frame, b.u1, b.v0), toWorld(b.frame, b.u1, b.v1), toWorld(b.frame, b.u0, b.v1)];

/** A slab over a rectangle less some others (holes, rooms that overlap it): polygon difference, then each piece triangulated. */
export function slabMinus(mb: MeshBuilder | null, col: MeshBuilder | null, outer: V2[], minus: V2[][], y: number, up: boolean, color: RGB): void {
  let polys: V2[][][] = [[outer]];
  if (minus.length) {
    try {
      const res = polygonClipping.difference([outer.map((p) => [p[0], p[1]] as [number, number])], ...minus.map((m) => [m.map((p) => [p[0], p[1]] as [number, number])]));
      polys = res.map((poly) => poly.map((ring) => ring.slice(0, -1).map((p) => [p[0], p[1]] as V2)));
    } catch {
      // keep the whole slab when the clipper gives up
    }
  }
  for (const rings of polys) slab(mb, col, rings, y, up, color);
}

/**
 * The parts of the segment a -> b that lie outside every one of the rooms (oriented rectangles), as [t0, t1] intervals of the
 * segment: a wall leaves an opening where another room joins it.
 */
export function outsideIntervals(a: V2, b: V2, rooms: { frame: Frame; u0: number; u1: number; v0: number; v1: number }[], shrink = 0.05): [number, number][] {
  let free: [number, number][] = [[0, 1]];
  for (const r of rooms) {
    const [au, av] = toLocal(r.frame, a[0], a[1]);
    const [bu, bv] = toLocal(r.frame, b[0], b[1]);
    // Liang-Barsky against the room's rectangle (shrunk a little so a wall on the room's own edge counts as inside)
    const du = bu - au, dv = bv - av;
    let t0 = 0, t1 = 1;
    const p = [-du, du, -dv, dv];
    const q = [au - (r.u0 - shrink), r.u1 + shrink - au, av - (r.v0 - shrink), r.v1 + shrink - av];
    let hit = true;
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) {
        if (q[i] < 0) { hit = false; break; }
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) { hit = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { hit = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!hit || t1 - t0 < 1e-6) continue;
    const next: [number, number][] = [];
    for (const [s0, s1] of free) {
      if (t1 <= s0 || t0 >= s1) next.push([s0, s1]);
      else {
        if (t0 > s0) next.push([s0, t0]);
        if (t1 < s1) next.push([t1, s1]);
      }
    }
    free = next;
  }
  return free.filter(([s0, s1]) => s1 - s0 > 1e-4);
}

/** A room: its floor and ceiling (less the given holes and the rooms that came before it) and its walls (open where other rooms join). */
export function room(m: TransitMeshes, b: LocalBox, opts: { others: LocalBox[]; floorMinus?: V2[][]; ceilMinus?: V2[][]; floor: RGB; wall: RGB; ceil: RGB; endWalls?: [boolean, boolean]; sideWalls?: [boolean, boolean] }): void {
  const ring = ringOf(b);
  slabMinus(m.int, m.col, ring, opts.floorMinus ?? [], b.y0, true, opts.floor);
  slabMinus(m.int, m.col, ring, opts.ceilMinus ?? [], b.y1, false, opts.ceil);
  const f = b.frame;
  const edges: { a: V2; b: V2; inward: V2; on: boolean }[] = [
    { a: toWorld(f, b.u0, b.v0), b: toWorld(f, b.u0, b.v1), inward: [f.n[0], f.n[1]], on: opts.sideWalls?.[0] ?? true },
    { a: toWorld(f, b.u1, b.v0), b: toWorld(f, b.u1, b.v1), inward: [-f.n[0], -f.n[1]], on: opts.sideWalls?.[1] ?? true },
    { a: toWorld(f, b.u0, b.v0), b: toWorld(f, b.u1, b.v0), inward: [f.a[0], f.a[1]], on: opts.endWalls?.[0] ?? true },
    { a: toWorld(f, b.u0, b.v1), b: toWorld(f, b.u1, b.v1), inward: [-f.a[0], -f.a[1]], on: opts.endWalls?.[1] ?? true },
  ];
  for (const e of edges) {
    if (!e.on) continue;
    for (const [t0, t1] of outsideIntervals(e.a, e.b, opts.others)) {
      const pa: V2 = [e.a[0] + (e.b[0] - e.a[0]) * t0, e.a[1] + (e.b[1] - e.a[1]) * t0];
      const pb: V2 = [e.a[0] + (e.b[0] - e.a[0]) * t1, e.a[1] + (e.b[1] - e.a[1]) * t1];
      wall(m.int, m.col, pa, pb, b.y0, b.y1, b.y0, b.y1, e.inward, opts.wall);
      // a darker tile band at the foot of the wall
      const off = (q: V2): V2 => [q[0] + e.inward[0] * 0.015, q[1] + e.inward[1] * 0.015];
      wall(m.int, null, off(pa), off(pb), b.y0, b.y0 + 0.25, b.y0, b.y0 + 0.25, e.inward, COL.tileBrown);
    }
  }
}

/** The surface height of a ramp at an along-position. */
export const rampY = (r: Ramp, v: number): number => {
  const t = (v - r.v0) / (r.v1 - r.v0);
  return r.y0 + (r.y1 - r.y0) * Math.max(0, Math.min(1, t));
};

/**
 * Stairs (or escalators) down a ramp: treads and risers drawn, a smooth ramp in the collision; the side walls from the steps up
 * to `wallTop(v)` (null: none there), the ceiling at `ceil(v)` (null: open).
 */
export function stairs(m: TransitMeshes, r: Ramp, target: MeshBuilder, opts: { wallTop: (v: number, y: number) => number | null; ceil: (v: number, y: number) => number | null; lanes?: { u0: number; u1: number; kind: 'stairs' | 'escalator' }[] }): void {
  const f = r.frame;
  const dir = Math.sign(r.v1 - r.v0) || 1;
  const L = Math.abs(r.v1 - r.v0);
  const rise = Math.abs(r.y0 - r.y1);
  const n = Math.max(2, Math.round(rise / 0.17));
  const run = L / n;
  const P = (u: number, v: number, y: number): P3 => {
    const [x, z] = toWorld(f, u, v);
    return [x, y, z];
  };
  const lanes = opts.lanes ?? [{ u0: r.u0, u1: r.u1, kind: r.kind === 'escalator' ? 'escalator' : 'stairs' }];
  const down = r.y1 < r.y0 ? 1 : -1;
  for (const lane of lanes) {
    const tread = lane.kind === 'escalator' ? COL.escalator : COL.steps;
    for (let i = 0; i < n; i++) {
      const va = r.v0 + dir * run * i, vb = r.v0 + dir * run * (i + 1);
      const ya = r.y0 - down * (rise / n) * i;
      const yb = r.y0 - down * (rise / n) * (i + 1);
      // going down the ramp's direction: the tread at the lower height, the riser at the step's edge
      const yt = down > 0 ? yb : ya;
      const vEdge = down > 0 ? va : vb;
      // (facing up: with v increasing, (u0 -> u1) x (v0 -> v1) faces down, so the order turns with the direction)
      if (dir > 0) quad(target, null, P(lane.u1, va, yt), P(lane.u0, va, yt), P(lane.u0, vb, yt), P(lane.u1, vb, yt), tread);
      else quad(target, null, P(lane.u0, va, yt), P(lane.u1, va, yt), P(lane.u1, vb, yt), P(lane.u0, vb, yt), tread);
      // the riser faces the lower tread
      const ry0 = Math.min(ya, yb), ry1 = Math.max(ya, yb);
      const face: V2 = [f.a[0] * dir * (down > 0 ? 1 : -1), f.a[1] * dir * (down > 0 ? 1 : -1)];
      wall(target, null, toWorld(f, lane.u0, vEdge), toWorld(f, lane.u1, vEdge), ry0, ry1, ry0, ry1, face, tread);
    }
    if (lane.kind === 'escalator') {
      // the balustrades and the handrails either side of the escalator
      for (const u of [lane.u0, lane.u1]) {
        const a = P(u, r.v0, r.y0), b = P(u, r.v1, r.y1);
        quad(target, null, [a[0], a[1], a[2]], [b[0], b[1], b[2]], [b[0], b[1] + 0.95, b[2]], [a[0], a[1] + 0.95, a[2]], COL.balustrade);
        quad(target, null, [b[0], b[1], b[2]], [a[0], a[1], a[2]], [a[0], a[1] + 0.95, a[2]], [b[0], b[1] + 0.95, b[2]], COL.balustrade);
      }
    }
  }
  // the collision ramp through the step nosings
  quad(null, m.col, P(r.u0, r.v0, r.y0), P(r.u1, r.v0, r.y0), P(r.u1, r.v1, r.y1), P(r.u0, r.v1, r.y1), COL.steps);
  quad(null, m.col, P(r.u1, r.v0, r.y0), P(r.u0, r.v0, r.y0), P(r.u0, r.v1, r.y1), P(r.u1, r.v1, r.y1), COL.steps);
  // side walls and ceiling, step by step along (1 m)
  const steps = Math.max(1, Math.ceil(L / 1));
  for (let k = 0; k < steps; k++) {
    const va = r.v0 + (dir * L * k) / steps, vb = r.v0 + (dir * L * (k + 1)) / steps;
    const ya = rampY(r, va), yb = rampY(r, vb);
    for (const [u, inward] of [[r.u0, 1], [r.u1, -1]] as [number, number][]) {
      const ta = opts.wallTop(va, ya), tb = opts.wallTop(vb, yb);
      if (ta === null || tb === null) continue;
      wall(target, m.col, toWorld(f, u, va), toWorld(f, u, vb), ya - 0.3, ta, yb - 0.3, tb, [f.n[0] * inward, f.n[1] * inward], COL.tileCream);
    }
    const ca = opts.ceil(va, ya), cb = opts.ceil(vb, yb);
    if (ca !== null && cb !== null) {
      const A = P(r.u0, va, ca), B = P(r.u1, va, ca), C = P(r.u1, vb, cb), D = P(r.u0, vb, cb);
      // facing down
      if (dir > 0) quad(target, m.col, A, B, C, D, COL.ceiling);
      else quad(target, m.col, B, A, D, C, COL.ceiling);
    }
  }
}

/** A thin railing (collision box, drawn by the client from the kit) along a segment. */
export function railingSolid(col: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const L = Math.hypot(x1 - x0, z1 - z0);
  if (L < 0.05) return;
  const f: Frame = { o: [(x0 + x1) / 2, (z0 + z1) / 2], a: [(x1 - x0) / L, (z1 - z0) / L], n: [(z1 - z0) / L, -(x1 - x0) / L] };
  box(null, col, f, -0.04, 0.04, -L / 2, L / 2, y, y + 1.0, COL.balustrade);
}

/** The light baked into the interior's vertices: a little ambient and the lamps (inverse square, soft, with the normal). */
export function bakeLight(mb: MeshBuilder, lamps: { x: number; y: number; z: number; k: number }[], ambient = 0.07): void {
  const cell = 12;
  const grid = new Map<string, number[]>();
  lamps.forEach((l, i) => {
    const k = `${Math.floor(l.x / cell)},${Math.floor(l.z / cell)}`;
    const a = grid.get(k);
    if (a) a.push(i);
    else grid.set(k, [i]);
  });
  const ch = mb.channel('light', 1, [1]);
  ch.data = new Array(mb.vertexCount);
  for (let i = 0; i < mb.vertexCount; i++) {
    const x = mb.positions[i * 3], y = mb.positions[i * 3 + 1], z = mb.positions[i * 3 + 2];
    const nx = mb.normals[i * 3], ny = mb.normals[i * 3 + 1], nz = mb.normals[i * 3 + 2];
    let L = ambient;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let gx = cx - 2; gx <= cx + 2; gx++) for (let gz = cz - 2; gz <= cz + 2; gz++) {
      for (const li of grid.get(`${gx},${gz}`) ?? []) {
        const l = lamps[li];
        const dx = l.x - x, dy = l.y - y, dz = l.z - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 24 * 24) continue;
        const d = Math.sqrt(d2) || 1;
        const lam = Math.max(0, (dx * nx + dy * ny + dz * nz) / d);
        L += l.k * (0.25 + 0.75 * lam) / (1 + d2 / 9);
      }
    }
    ch.data[i] = Math.min(1, L);
  }
}

export { STATION, type StationLayout };
