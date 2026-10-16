/**
 * Writes one building piece (a whole building, or one part of a stepped one) into the wall, glass and roof meshes with the
 * attributes of "Mesh attributes (meshFormat 2)": wall UVs that are continuous along the ring, per-quad spans, ids and flags,
 * flat roofs with a parapet and rooftop equipment, pitched roofs with gable fills, domes, and soffits under raised parts.
 *
 * The wall quads keep their old shape (four own vertices per footprint edge), so the renderer's load-time derivation of the
 * wall spans still works on this output. Everything that is not a facade (parapets, gables, equipment) is in the roof mesh.
 */
import earcut from 'earcut';
import type { V2 } from '../geo.js';
import { MeshBuilder } from '../mesh/builder.js';
import { orientRings } from '../mesh/extrude.js';
import { EQUIPMENT, ROOF_SHAPE_ID, SURFACE, type RoofPlan } from './roofs.js';
import { distToRings, inPolygon, insetRing, minAreaObb, rng, type Obb } from './shape.js';
import { KIND_ID, type BuildingKind } from './classify.js';

type RGB = [number, number, number];

/** Declares the channels of a wall mesh (walls and glass walls). */
export function declareWallChannels(mb: MeshBuilder): MeshBuilder {
  mb.channel('uv', 2);
  mb.channel('wall', 4);
  mb.channel('bld', 4);
  mb.channel('bid', 2);
  mb.channel('look', 4);
  mb.channel('ao', 1, [1]);
  return mb;
}

/** Declares the channels of a roof mesh. */
export function declareRoofChannels(mb: MeshBuilder): MeshBuilder {
  mb.channel('uv', 2);
  mb.channel('bld', 4);
  mb.channel('bid', 2);
  mb.channel('look', 4);
  mb.channel('srf', 4);
  mb.channel('ao', 1, [1]);
  return mb;
}

/** Flag bits of `_BID.y`. */
export const FLAG = { pitched: 1, parapet: 2, part: 4, named: 8, eraKnown: 16, courtyard: 32, floating: 64, kindKnown: 128 } as const;

export interface PieceInput {
  rings: V2[][];
  /** m above the datum where the piece starts (0 on the ground) and where its highest point is (a pitched roof's ridge) */
  baseH: number;
  topH: number;
  /** null: a flat roof */
  roof: RoofPlan | null;
  /** parapet height on a flat roof, m (0 for none) */
  parapet: number;
  kind: BuildingKind;
  era: number;
  /** upper floors of this piece and the ground band in m */
  floors: number;
  band: number;
  hash16: number;
  flags: number;
  wall: RGB;
  roofColor: RGB;
  glass: boolean;
  /** seed for the rooftop equipment */
  seed: number;
  /** an edge hidden inside a taller neighbour piece (no wall and no parapet there); `outward` is the edge's outward normal */
  hidden?: (a: V2, b: V2, outward: V2) => boolean;
  /** whether this piece may carry rooftop equipment */
  equipment?: boolean;
  /** the dressing of the piece, for `_LOOK` (meshFormat 3): material and style ids, the material of the ground band, the crown in m, the roof material id and the provenance flags */
  look?: { material: number; style: number; bandMaterial: number; crown: number; roofMaterial: number; flags: number };
}

export interface WriteEnv {
  /** absolute y of the building's ground datum */
  datumY: number;
  wall: MeshBuilder;
  glass: MeshBuilder;
  roof: MeshBuilder;
  /** ambient occlusion at a point (n: outward wall normal in plan) */
  ao: (x: number, y: number, z: number, n?: V2) => number;
}

export interface PieceStats {
  wallTris: number;
  roofTris: number;
  equipment: Record<string, number>;
  pitched: boolean;
}

const q32 = (v: number) => Math.round(v * 32) / 32;
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** Triangle (a, b, c) with its normal up in the x/z plane; sliver triangles are dropped. */
function triUp(mb: MeshBuilder, a: number, b: number, c: number): void {
  const p = mb.positions;
  const ux = p[b * 3] - p[a * 3], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const wx = p[c * 3] - p[a * 3], wz = p[c * 3 + 2] - p[a * 3 + 2];
  const ny = uz * wx - ux * wz;
  if (Math.abs(ny) < 1e-7) return;
  if (ny > 0) mb.tri(a, b, c); else mb.tri(a, c, b);
}

export function writePiece(env: WriteEnv, pc: PieceInput): PieceStats {
  const stats: PieceStats = { wallTris: 0, roofTris: 0, equipment: {}, pitched: !!pc.roof };
  const rings = orientRings(pc.rings);
  const outer = rings[0];
  const obb = minAreaObb(outer);
  const bx = -obb.az, bz = obb.ax;
  const wallMb = pc.glass ? env.glass : env.wall;
  const roofMb = env.roof;
  const datum = env.datumY;
  const floating = pc.baseH > 2;
  const baseY = floating ? datum + pc.baseH : datum - 0.3;
  const vBottom = floating ? pc.baseH : -0.3;
  const rise = pc.roof ? pc.roof.rise : 0;
  const wallTopH = pc.topH - rise;
  const wallTopY = datum + wallTopH;
  const bld = [KIND_ID[pc.kind], pc.era, Math.min(255, pc.floors), Math.min(255, Math.round(pc.band * 10))];
  const bid = [pc.hash16, pc.flags];
  const lk = pc.look ?? { material: 0, style: 0, bandMaterial: 0, crown: 0, roofMaterial: 0, flags: 0 };
  // walls: (material, style, band material | crown in 2 m steps << 3, provenance); roofs: (roof material, style, wall material, provenance)
  const lookWall = [lk.material, lk.style, (lk.bandMaterial & 7) | (Math.min(15, Math.round(lk.crown / 2)) << 3), lk.flags];
  const lookRoof = [lk.roofMaterial, lk.style, lk.material, lk.flags];

  // ---- walls
  const edgeInfo: { a: V2; b: V2; n: V2; u0: number; len: number }[] = [];
  for (const ring of rings) {
    let u = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % n];
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const nx = dz / l, nz = -dx / l;
      const u0 = u;
      u += l;
      edgeInfo.push({ a: p0, b: p1, n: [nx, nz], u0, len: l });
      if (pc.hidden?.(p0, p1, [nx, nz])) continue;
      const wspan = [q32(u0), q32(l), q32(floating ? pc.baseH : 0), q32(wallTopH)];
      const aoB0 = env.ao(p0[0], floating ? baseY : datum + 0.5, p0[1], [nx, nz]);
      const aoB1 = env.ao(p1[0], floating ? baseY : datum + 0.5, p1[1], [nx, nz]);
      const aoT0 = env.ao(p0[0], wallTopY, p0[1], [nx, nz]);
      const aoT1 = env.ao(p1[0], wallTopY, p1[1], [nx, nz]);
      const vtx = (x: number, y: number, z: number, uu: number, vv: number, ao: number) => {
        const i0 = wallMb.vertex(x, y, z, nx, 0, nz, pc.wall[0], pc.wall[1], pc.wall[2]);
        wallMb.set('uv', i0, q32(uu), q32(vv));
        wallMb.set('wall', i0, ...wspan);
        wallMb.set('bld', i0, ...bld);
        wallMb.set('bid', i0, ...bid);
        wallMb.set('look', i0, ...lookWall);
        wallMb.set('ao', i0, ao);
        return i0;
      };
      const b0 = vtx(p0[0], baseY, p0[1], u0, vBottom, aoB0);
      const t0 = vtx(p0[0], wallTopY, p0[1], u0, wallTopH, aoT0);
      const b1 = vtx(p1[0], baseY, p1[1], u0 + l, vBottom, aoB1);
      const t1 = vtx(p1[0], wallTopY, p1[1], u0 + l, wallTopH, aoT1);
      wallMb.tri(b0, t0, b1);
      wallMb.tri(b1, t0, t1);
      stats.wallTris += 2;
    }
  }

  // ---- roof vertex helper
  const rv = (x: number, y: number, z: number, nx: number, ny: number, nz: number, col: RGB, u: number, v: number, surface: number, ao: number, equip = 0, slope = 0) => {
    const i = roofMb.vertex(x, y, z, nx, ny, nz, col[0], col[1], col[2]);
    roofMb.set('uv', i, q32(u), q32(v));
    roofMb.set('bld', i, ...bld);
    roofMb.set('bid', i, ...bid);
    roofMb.set('look', i, ...lookRoof);
    roofMb.set('srf', i, surface, ROOF_SHAPE_ID[pc.roof?.shape ?? 'flat'], equip, Math.round(slope));
    roofMb.set('ao', i, ao);
    return i;
  };
  const obbUv = (x: number, z: number): V2 => [(x - obb.cx) * obb.ax + (z - obb.cz) * obb.az + obb.L, (x - obb.cx) * bx + (z - obb.cz) * bz + obb.W];
  const countTris = (before: number) => { stats.roofTris += roofMb.triangleCount - before; };

  // ---- soffit under a raised piece
  if (floating) {
    const before = roofMb.triangleCount;
    const flat: number[] = [];
    const holes: number[] = [];
    rings.forEach((r, i) => { if (i > 0) holes.push(flat.length / 2); for (const p of r) flat.push(p[0], p[1]); });
    const tri = earcut(flat, holes);
    const base = roofMb.vertexCount;
    for (let i = 0; i < flat.length; i += 2) {
      const [u, v] = obbUv(flat[i], flat[i + 1]);
      rv(flat[i], baseY, flat[i + 1], 0, -1, 0, scale(pc.wall, 0.7), u, v, SURFACE.soffit, 0.45);
    }
    for (let i = 0; i + 2 < tri.length; i += 3) {
      // facing down: the opposite winding of triUp
      const a = base + tri[i], b = base + tri[i + 1], c = base + tri[i + 2];
      const p = roofMb.positions;
      const ny = (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]);
      if (Math.abs(ny) < 1e-7) continue;
      if (ny < 0) roofMb.tri(a, b, c); else roofMb.tri(a, c, b);
    }
    countTris(before);
  }

  // ---- roof
  if (pc.roof) writePitched(env, pc, rings, edgeInfo, obb, rv, roofMb, stats, bld);
  else writeFlat(env, pc, rings, obb, rv, roofMb, stats, obbUv);
  return stats;
}

type RV = (x: number, y: number, z: number, nx: number, ny: number, nz: number, col: RGB, u: number, v: number, surface: number, ao: number, equip?: number, slope?: number) => number;

function writeFlat(env: WriteEnv, pc: PieceInput, rings: V2[][], obb: Obb, rv: RV, roofMb: MeshBuilder, stats: PieceStats, obbUv: (x: number, z: number) => V2): void {
  const datum = env.datumY;
  const pH = pc.parapet;
  const roofY = datum + pc.topH - pH;
  const topY = datum + pc.topH;
  let before = roofMb.triangleCount;

  // the roof membrane
  {
    const flat: number[] = [];
    const holes: number[] = [];
    rings.forEach((r, i) => { if (i > 0) holes.push(flat.length / 2); for (const p of r) flat.push(p[0], p[1]); });
    const tri = earcut(flat, holes);
    const base = roofMb.vertexCount;
    for (let i = 0; i < flat.length; i += 2) {
      const [u, v] = obbUv(flat[i], flat[i + 1]);
      rv(flat[i], roofY, flat[i + 1], 0, 1, 0, pc.roofColor, u, v, SURFACE.flat, 1);
    }
    for (let i = 0; i + 2 < tri.length; i += 3) triUp(roofMb, base + tri[i], base + tri[i + 1], base + tri[i + 2]);
  }

  // the parapet: a cap on top of the wall and an inner face down to the roof
  if (pH > 0.05) {
    const capCol = scale(pc.wall, 1.12);
    const innerCol = scale(pc.wall, 0.82);
    const withCap = pc.topH - pc.baseH < 12;
    for (const ring of rings) {
      const n = ring.length;
      const inner = withCap ? insetRing(ring, 0.25) : ring;
      let u = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p0 = ring[i], p1 = ring[j];
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
        const l = Math.hypot(dx, dz);
        const u0 = u;
        u += l;
        if (l < 0.8) continue;
        const nx = dz / l, nz = -dx / l;
        if (pc.hidden?.(p0, p1, [nx, nz])) continue;
        const q0 = inner[i], q1 = inner[j];
        if (withCap && l >= 4) {
          // cap (faces up)
          const c0 = rv(p0[0], topY, p0[1], 0, 1, 0, capCol, u0, 0, SURFACE.parapetCap, 0.95);
          const c1 = rv(p1[0], topY, p1[1], 0, 1, 0, capCol, u0 + l, 0, SURFACE.parapetCap, 0.95);
          const c2 = rv(q1[0], topY, q1[1], 0, 1, 0, capCol, u0 + l, 0.25, SURFACE.parapetCap, 0.95);
          const c3 = rv(q0[0], topY, q0[1], 0, 1, 0, capCol, u0, 0.25, SURFACE.parapetCap, 0.95);
          triUp(roofMb, c0, c1, c2);
          triUp(roofMb, c0, c2, c3);
        }
        // inner face (faces into the roof: the opposite of the outward normal)
        const a0 = rv(q0[0], topY, q0[1], -nx, 0, -nz, innerCol, u0, pH, SURFACE.parapetInner, 0.9);
        const a1 = rv(q1[0], topY, q1[1], -nx, 0, -nz, innerCol, u0 + l, pH, SURFACE.parapetInner, 0.9);
        const b0 = rv(q0[0], roofY, q0[1], -nx, 0, -nz, innerCol, u0, 0, SURFACE.parapetInner, 0.55);
        const b1 = rv(q1[0], roofY, q1[1], -nx, 0, -nz, innerCol, u0 + l, 0, SURFACE.parapetInner, 0.55);
        triOut(roofMb, b0, a0, b1, -nx, -nz);
        triOut(roofMb, b1, a0, a1, -nx, -nz);
      }
    }
  }
  stats.roofTris += roofMb.triangleCount - before;

  // ---- rooftop equipment
  if (pc.equipment === false) return;
  before = roofMb.triangleCount;
  placeEquipment(env, pc, rings, obb, rv, roofMb, stats, roofY, pH);
  stats.roofTris += roofMb.triangleCount - before;
}

const EQUIPMENT_NAMES = ['none', 'hvac', 'tank', 'bulkhead', 'penthouse'];

interface Placed { x: number; z: number; r: number }

function placeEquipment(env: WriteEnv, pc: PieceInput, rings: V2[][], obb: Obb, rv: RV, roofMb: MeshBuilder, stats: PieceStats, roofY: number, pH: number): void {
  const area = 4 * obb.L * obb.W * obb.fill;
  const height = pc.topH - pc.baseH;
  if (area < 300 || obb.W < 6 || height < 6) return;
  const rand = rng(pc.seed);
  const items: { type: number; hx: number; hz: number; h: number }[] = [];
  const tower = height >= 60 && (pc.kind === 'glass' || pc.kind === 'office');
  if (tower) {
    const hx = Math.min(obb.L, obb.W * 1.4) * (0.3 + 0.12 * rand());
    const hz = obb.W * (0.3 + 0.12 * rand());
    items.push({ type: EQUIPMENT.penthouse, hx, hz, h: Math.min(14, 4 + height * 0.04) });
  } else if (area > 600 && height >= 12 && rand() < 0.6) {
    items.push({ type: EQUIPMENT.bulkhead, hx: 1.5 + 0.6 * rand(), hz: 1.5 + 0.5 * rand(), h: 2.6 + 0.4 * rand() });
  }
  const nSmall = Math.min(3, Math.floor(area / 1100) + (area > 450 ? 1 : 0)) + (tower ? 1 : 0);
  for (let i = 0; i < nSmall; i++) {
    const tankLikely = !tower && (pc.kind === 'brick' || pc.kind === 'residential' || pc.kind === 'industrial' || pc.kind === 'civic') && rand() < 0.12;
    if (tankLikely) items.push({ type: EQUIPMENT.tank, hx: 1.5, hz: 1.5, h: 2.8 + rand() });
    else items.push({ type: EQUIPMENT.hvac, hx: 0.9 + 0.7 * rand(), hz: 0.7 + 0.5 * rand(), h: 1.0 + 0.6 * rand() });
  }
  const placed: Placed[] = [];
  const b = [-obb.az, obb.ax];
  for (const it of items) {
    const rad = Math.hypot(it.hx, it.hz);
    for (let attempt = 0; attempt < 24; attempt++) {
      const p = (rand() * 2 - 1) * (obb.L - rad - 0.6);
      const q = (rand() * 2 - 1) * (obb.W - rad - 0.6);
      const x = obb.cx + p * obb.ax + q * b[0];
      const z = obb.cz + p * obb.az + q * b[1];
      if (!inPolygon(x, z, rings)) continue;
      if (distToRings(x, z, rings) < rad + 0.9 + (pH > 0 ? 0.3 : 0)) continue;
      if (placed.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + rad + 0.8)) continue;
      placed.push({ x, z, r: rad });
      writeEquipment(env, pc, rv, roofMb, x, z, roofY, it, obb);
      const name = EQUIPMENT_NAMES[it.type];
      stats.equipment[name] = (stats.equipment[name] ?? 0) + 1;
      break;
    }
  }
}

function writeEquipment(env: WriteEnv, pc: PieceInput, rv: RV, roofMb: MeshBuilder, x: number, z: number, y0: number, it: { type: number; hx: number; hz: number; h: number }, obb: Obb): void {
  const datum = env.datumY;
  const col: RGB = it.type === EQUIPMENT.hvac ? [0.2, 0.21, 0.22] : it.type === EQUIPMENT.tank ? [0.09, 0.055, 0.04] : scale(pc.wall, 0.9);
  const topCol = scale(col, 1.15);
  const y1 = y0 + it.h;
  const vOf = (y: number) => y - datum;
  if (it.type === EQUIPMENT.tank) {
    const N = 6;
    const r = it.hx;
    const ring: V2[] = Array.from({ length: N }, (_, k) => [x + r * Math.cos((k / N) * Math.PI * 2), z + r * Math.sin((k / N) * Math.PI * 2)] as V2);
    for (let k = 0; k < N; k++) {
      const a = ring[k], b = ring[(k + 1) % N];
      const mx = (a[0] + b[0]) / 2 - x, mz = (a[1] + b[1]) / 2 - z;
      const ml = Math.hypot(mx, mz) || 1;
      const nx = mx / ml, nz = mz / ml;
      const u0 = k * (r * 0.78), u1 = (k + 1) * (r * 0.78);
      const b0 = rv(a[0], y0, a[1], nx, 0, nz, col, u0, vOf(y0), SURFACE.equipment, 0.6, it.type);
      const t0 = rv(a[0], y1, a[1], nx, 0, nz, col, u0, vOf(y1), SURFACE.equipment, 1, it.type);
      const b1 = rv(b[0], y0, b[1], nx, 0, nz, col, u1, vOf(y0), SURFACE.equipment, 0.6, it.type);
      const t1 = rv(b[0], y1, b[1], nx, 0, nz, col, u1, vOf(y1), SURFACE.equipment, 1, it.type);
      // outward winding: the ring runs counter-clockwise in the x/z plane, so (b0, b1, t0) faces out
      triOut(roofMb, b0, t0, b1, nx, nz);
      triOut(roofMb, b1, t0, t1, nx, nz);
    }
    const c = rv(x, y1 + 0.35, z, 0, 1, 0, topCol, 0, 0, SURFACE.equipment, 1, it.type);
    const top = ring.map((p, k) => rv(p[0], y1, p[1], 0, 1, 0, topCol, k, 0, SURFACE.equipment, 1, it.type));
    for (let k = 0; k < N; k++) triUp(roofMb, c, top[k], top[(k + 1) % N]);
    return;
  }
  // a box aligned with the footprint's long axis
  const ax = obb.ax, az = obb.az, bx = -obb.az, bz = obb.ax;
  const corner = (sx: number, sz: number): V2 => [x + ax * it.hx * sx + bx * it.hz * sz, z + az * it.hx * sx + bz * it.hz * sz];
  const cs: V2[] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const faceN: V2[] = [[-bx, -bz], [ax, az], [bx, bz], [-ax, -az]];
  let u = 0;
  for (let k = 0; k < 4; k++) {
    const a = cs[k], b = cs[(k + 1) % 4];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const [nx, nz] = faceN[k];
    const b0 = rv(a[0], y0, a[1], nx, 0, nz, col, u, vOf(y0), SURFACE.equipment, 0.6, it.type);
    const t0 = rv(a[0], y1, a[1], nx, 0, nz, col, u, vOf(y1), SURFACE.equipment, 1, it.type);
    const b1 = rv(b[0], y0, b[1], nx, 0, nz, col, u + l, vOf(y0), SURFACE.equipment, 0.6, it.type);
    const t1 = rv(b[0], y1, b[1], nx, 0, nz, col, u + l, vOf(y1), SURFACE.equipment, 1, it.type);
    triOut(roofMb, b0, t0, b1, nx, nz);
    triOut(roofMb, b1, t0, t1, nx, nz);
    u += l;
  }
  const top = cs.map((p) => rv(p[0], y1, p[1], 0, 1, 0, topCol, p[0] - obb.cx + obb.L, p[1] - obb.cz + obb.W, SURFACE.equipment, 1, it.type));
  triUp(roofMb, top[0], top[1], top[2]);
  triUp(roofMb, top[0], top[2], top[3]);
}

/** A vertical triangle whose normal faces (nx, nz). */
function triOut(mb: MeshBuilder, a: number, b: number, c: number, nx: number, nz: number): void {
  const p = mb.positions;
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const wx = p[c * 3] - p[a * 3], wy = p[c * 3 + 1] - p[a * 3 + 1], wz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * wz - uz * wy, cz = ux * wy - uy * wx;
  const cy = uz * wx - ux * wz;
  if (Math.hypot(cx, cy, cz) < 1e-9) return;
  if (cx * nx + cz * nz >= 0) mb.tri(a, b, c); else mb.tri(a, c, b);
}

function writePitched(
  env: WriteEnv, pc: PieceInput, rings: V2[][], edges: { a: V2; b: V2; n: V2; u0: number; len: number }[], obb: Obb,
  rv: RV, roofMb: MeshBuilder, stats: PieceStats, bld: number[],
): void {
  void bld;
  const plan = pc.roof!;
  const datum = env.datumY;
  const eaveY = datum + pc.topH - plan.rise;
  const before = roofMb.triangleCount;
  const cosA = (slope: number) => Math.cos((slope * Math.PI) / 180) || 1;
  for (const f of plan.faces) {
    const surface = plan.shape === 'dome' ? SURFACE.dome : SURFACE.pitched;
    const idx = f.pts.map((p) => {
      const along = (p[0] - obb.cx) * -f.gradient[1] + (p[2] - obb.cz) * f.gradient[0] + obb.L + obb.W;
      const up = ((p[0] - obb.cx) * f.gradient[0] + (p[2] - obb.cz) * f.gradient[1] + obb.L + obb.W) / cosA(f.slopeDeg);
      const y = eaveY + p[1];
      return rv(p[0], y, p[2], f.normal[0], f.normal[1], f.normal[2], pc.roofColor, along, up, surface, 1, 0, f.slopeDeg);
    });
    const flat: number[] = [];
    for (const p of f.pts) flat.push(p[0], p[2]);
    const tri = earcut(flat);
    for (let i = 0; i + 2 < tri.length; i += 3) triUp(roofMb, idx[tri[i]], idx[tri[i + 1]], idx[tri[i + 2]]);
  }

  // gable fills: where a face edge runs along a footprint edge and rises above the eaves, close the wall up to the roof
  if (plan.shape !== 'dome') {
    const outerEdges = edges.filter((e) => e.len > 0);
    const tol = 0.03;
    const distSeg = (p: [number, number, number], e: { a: V2; b: V2 }) => {
      const dx = e.b[0] - e.a[0], dz = e.b[1] - e.a[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[2] - e.a[1]) * dz) / l2));
      return Math.hypot(p[0] - (e.a[0] + t * dx), p[2] - (e.a[1] + t * dz));
    };
    const wallCol = pc.wall;
    for (const f of plan.faces) {
      const n = f.pts.length;
      for (let i = 0; i < n; i++) {
        const P = f.pts[i], Q = f.pts[(i + 1) % n];
        if (P[1] < 0.03 && Q[1] < 0.03) continue;
        const e = outerEdges.find((c) => distSeg(P, c) < tol && distSeg(Q, c) < tol);
        if (!e) continue;
        if (pc.hidden?.(e.a, e.b, e.n)) continue;
        const dx = e.b[0] - e.a[0], dz = e.b[1] - e.a[1];
        const fwd = (Q[0] - P[0]) * dx + (Q[2] - P[2]) * dz >= 0;
        const p0 = fwd ? P : Q, p1 = fwd ? Q : P;
        const u = (p: [number, number, number]) => e.u0 + Math.hypot(p[0] - e.a[0], p[2] - e.a[1]);
        const vv = (y: number) => y - datum;
        const yb = eaveY;
        const b0 = rv(p0[0], yb, p0[2], e.n[0], 0, e.n[1], wallCol, u(p0), vv(yb), SURFACE.gable, env.ao(p0[0], yb, p0[2], e.n));
        const t0 = rv(p0[0], yb + p0[1], p0[2], e.n[0], 0, e.n[1], wallCol, u(p0), vv(yb + p0[1]), SURFACE.gable, env.ao(p0[0], yb + p0[1], p0[2], e.n));
        const b1 = rv(p1[0], yb, p1[2], e.n[0], 0, e.n[1], wallCol, u(p1), vv(yb), SURFACE.gable, env.ao(p1[0], yb, p1[2], e.n));
        const t1 = rv(p1[0], yb + p1[1], p1[2], e.n[0], 0, e.n[1], wallCol, u(p1), vv(yb + p1[1]), SURFACE.gable, env.ao(p1[0], yb + p1[1], p1[2], e.n));
        triOut(roofMb, b0, t0, b1, e.n[0], e.n[1]);
        triOut(roofMb, b1, t0, t1, e.n[0], e.n[1]);
      }
    }
  }
  void rings;
  stats.roofTris += roofMb.triangleCount - before;
}
