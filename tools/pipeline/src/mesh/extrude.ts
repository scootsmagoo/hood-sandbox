import earcut from 'earcut';
import type { V2 } from '../geo.js';
import { signedArea } from '../geo.js';
import { MeshBuilder } from './builder.js';

/**
 * Outer ring counter-clockwise (positive signed area in x,z), holes clockwise.
 * With that orientation the right-hand edge normal (dz, -dx) always points away from the solid.
 */
export function orientRings(rings: V2[][]): V2[][] {
  return rings.map((r, i) => {
    const a = signedArea(r);
    const wantPositive = i === 0;
    return (a > 0) === wantPositive ? r : r.slice().reverse();
  });
}

export interface ExtrudeOptions {
  baseY: number;
  topY: number;
  wall: MeshBuilder;
  roof: MeshBuilder;
  wallColor: [number, number, number];
  roofColor: [number, number, number];
}

/** Adds walls and a flat roof for a footprint. Returns the number of triangles added. */
export function extrudeFootprint(rings: V2[][], o: ExtrudeOptions): number {
  const rs = orientRings(rings);
  const before = o.wall.triangleCount + o.roof.triangleCount;
  const [wr, wg, wb] = o.wallColor;

  for (const ring of rs) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p0 = ring[i];
      const p1 = ring[(i + 1) % n];
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const nx = dz / l;
      const nz = -dx / l;
      const w = o.wall;
      const b0 = w.vertex(p0[0], o.baseY, p0[1], nx, 0, nz, wr, wg, wb);
      const t0 = w.vertex(p0[0], o.topY, p0[1], nx, 0, nz, wr, wg, wb);
      const b1 = w.vertex(p1[0], o.baseY, p1[1], nx, 0, nz, wr, wg, wb);
      const t1 = w.vertex(p1[0], o.topY, p1[1], nx, 0, nz, wr, wg, wb);
      w.tri(b0, t0, b1);
      w.tri(b1, t0, t1);
    }
  }

  const flat: number[] = [];
  const holes: number[] = [];
  rs.forEach((r, i) => {
    if (i > 0) holes.push(flat.length / 2);
    for (const p of r) flat.push(p[0], p[1]);
  });
  const tri = earcut(flat, holes);
  const base = o.roof.vertexCount;
  const [rr, rg, rb] = o.roofColor;
  for (let i = 0; i < flat.length; i += 2) o.roof.vertex(flat[i], o.topY, flat[i + 1], 0, 1, 0, rr, rg, rb);
  for (let i = 0; i + 2 < tri.length; i += 3) {
    // earcut keeps the input winding, which faces -Y in this axis layout, so reverse it
    o.roof.tri(base + tri[i], base + tri[i + 2], base + tri[i + 1]);
  }
  return o.wall.triangleCount + o.roof.triangleCount - before;
}

/** An axis-aligned-to-direction box. dir is the unit direction of the long axis in x,z. */
export function addOrientedBox(
  mb: MeshBuilder,
  cx: number,
  cz: number,
  yBottom: number,
  yTop: number,
  dir: V2,
  halfLen: number,
  halfWid: number,
  color: [number, number, number] = [1, 1, 1],
): void {
  const ux = dir[0], uz = dir[1];
  const vx = -uz, vz = ux;
  const corners: V2[] = [
    [cx - ux * halfLen - vx * halfWid, cz - uz * halfLen - vz * halfWid],
    [cx + ux * halfLen - vx * halfWid, cz + uz * halfLen - vz * halfWid],
    [cx + ux * halfLen + vx * halfWid, cz + uz * halfLen + vz * halfWid],
    [cx - ux * halfLen + vx * halfWid, cz - uz * halfLen + vz * halfWid],
  ];
  // corner order is clockwise or counter-clockwise depending on dir; extrudeFootprint orients it
  const tmp = new MeshBuilder();
  extrudeFootprint([corners], { baseY: yBottom, topY: yTop, wall: mb, roof: tmp, wallColor: color, roofColor: color });
  const base = mb.vertexCount;
  for (let i = 0; i < tmp.vertexCount; i++) {
    mb.vertex(tmp.positions[i * 3], tmp.positions[i * 3 + 1], tmp.positions[i * 3 + 2], 0, 1, 0, color[0], color[1], color[2]);
  }
  for (const i of tmp.indices) mb.indices.push(base + i);
  const ring = orientRings([corners])[0];
  const bb = ring.map((p) => mb.vertex(p[0], yBottom, p[1], 0, -1, 0, color[0], color[1], color[2]));
  mb.tri(bb[0], bb[1], bb[2]);
  mb.tri(bb[0], bb[2], bb[3]);
}
