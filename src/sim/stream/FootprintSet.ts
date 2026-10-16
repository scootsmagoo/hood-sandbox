/**
 * The building footprints of a streamed city: one `FootprintIndex` per slice of a tile's buildings, queried together. It is a
 * `FootprintIndex` itself (an empty one with the queries overridden), so everything that takes the world's footprints takes it.
 */
import { FootprintIndex } from '../../shared/footprints';

interface Part {
  key: string;
  index: FootprintIndex;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export class FootprintSet extends FootprintIndex {
  private parts: Part[] = [];

  constructor() {
    super(new Float32Array(0), new Uint32Array(0), 0);
  }

  /** Adds the footprints of one slice of a tile's building triangles. */
  add(key: string, positions: Float32Array, indices: Uint32Array, triangles: number) {
    const index = new FootprintIndex(positions, indices, triangles);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let t = 0; t < triangles * 3; t++) {
      const v = indices[t] * 3;
      const x = positions[v], z = positions[v + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!index.empty) this.parts.push({ key, index, minX, minZ, maxX, maxZ });
  }

  /** Drops a tile's footprints. */
  remove(key: string) {
    this.parts = this.parts.filter((p) => p.key !== key);
  }

  get partCount(): number {
    return this.parts.length;
  }

  override get empty(): boolean {
    return this.parts.length === 0;
  }

  override roofAbove(x: number, z: number, y = NaN): number {
    for (const p of this.parts) {
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      const r = p.index.roofAbove(x, z, y);
      if (!Number.isNaN(r)) return r;
    }
    return NaN;
  }

  override nearestWall(x: number, z: number, max: number, out: { nx: number; nz: number } = { nx: 0, nz: 0 }, y = NaN): number {
    let best = Infinity;
    const tmp = { nx: 0, nz: 0 };
    for (const p of this.parts) {
      if (x < p.minX - max || x > p.maxX + max || z < p.minZ - max || z > p.maxZ + max) continue;
      const d = p.index.nearestWall(x, z, max, tmp, y);
      if (d < best) {
        best = d;
        out.nx = tmp.nx;
        out.nz = tmp.nz;
      }
    }
    return best;
  }
}
