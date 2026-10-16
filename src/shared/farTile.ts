/**
 * `far.bin` (docs/contracts/city-tiles.md section 8): a tile's skyline level of detail. Every building as a prism (a simplified
 * footprint, a base and a top height, a kind) and the ground as a coarse grid of heights. Little-endian:
 *
 *   u32 magic 0x52414648 ('HFAR'), u32 version (1), u32 building count, u32 grid samples a side (n)
 *   f32 grid minX, f32 grid minZ, f32 grid size (m, the side of the square the n x n samples span), f32 reserved
 *   f32 x n*n   ground heights, row-major (rows along +z, columns along +x)
 *   per building: u8 vertex count v, u8 kind (the `buildingKinds` id), u16 reserved, f32 baseY, f32 topY, f32 x 2v (x, z)
 *
 * The pipeline writes it (tools/pipeline/src/city/far.ts); the fixture makes its own; the client draws it (src/world/stream/).
 */

export interface FarBuilding {
  kind: number;
  baseY: number;
  topY: number;
  /** Footprint ring, (x, z) pairs. */
  ring: number[];
}

export interface FarTile {
  grid: { n: number; minX: number; minZ: number; size: number; heights: Float32Array };
  buildings: FarBuilding[];
}

const MAGIC = 0x52414648;

export function encodeFarTile(t: FarTile): Uint8Array {
  const n = t.grid.n;
  let bytes = 32 + n * n * 4;
  for (const b of t.buildings) bytes += 12 + Math.min(255, b.ring.length / 2) * 8;
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  let o = 0;
  const u32 = (v: number) => {
    dv.setUint32(o, v, true);
    o += 4;
  };
  const f32 = (v: number) => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  u32(MAGIC);
  u32(1);
  u32(t.buildings.length);
  u32(n);
  f32(t.grid.minX);
  f32(t.grid.minZ);
  f32(t.grid.size);
  f32(0);
  for (let i = 0; i < n * n; i++) f32(t.grid.heights[i]);
  for (const b of t.buildings) {
    const v = Math.min(255, b.ring.length / 2);
    dv.setUint8(o, v);
    dv.setUint8(o + 1, b.kind & 255);
    dv.setUint16(o + 2, 0, true);
    o += 4;
    f32(b.baseY);
    f32(b.topY);
    for (let k = 0; k < v * 2; k++) f32(b.ring[k]);
  }
  return new Uint8Array(buf);
}

export function decodeFarTile(buf: ArrayBuffer): FarTile {
  const dv = new DataView(buf);
  if (buf.byteLength < 32 || dv.getUint32(0, true) !== MAGIC) throw new Error('far.bin: bad magic');
  if (dv.getUint32(4, true) !== 1) throw new Error('far.bin: unsupported version');
  const count = dv.getUint32(8, true);
  const n = dv.getUint32(12, true);
  const minX = dv.getFloat32(16, true);
  const minZ = dv.getFloat32(20, true);
  const size = dv.getFloat32(24, true);
  let o = 32;
  if (o + n * n * 4 > buf.byteLength) throw new Error('far.bin: truncated grid');
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++, o += 4) heights[i] = dv.getFloat32(o, true);
  const buildings: FarBuilding[] = [];
  for (let b = 0; b < count; b++) {
    if (o + 12 > buf.byteLength) throw new Error('far.bin: truncated building');
    const v = dv.getUint8(o);
    const kind = dv.getUint8(o + 1);
    const baseY = dv.getFloat32(o + 4, true);
    const topY = dv.getFloat32(o + 8, true);
    o += 12;
    if (o + v * 8 > buf.byteLength) throw new Error('far.bin: truncated ring');
    const ring = new Array<number>(v * 2);
    for (let k = 0; k < v * 2; k++, o += 4) ring[k] = dv.getFloat32(o, true);
    buildings.push({ kind, baseY, topY, ring });
  }
  return { grid: { n, minX, minZ, size, heights }, buildings };
}
