import type { TileData } from '../src/shared/tile';
import { flatTile } from './helpers';

export interface Box {
  /** Centre x, z; ground y of the bottom; size. */
  x: number;
  z: number;
  y?: number;
  sx: number;
  sy: number;
  sz: number;
  yaw?: number;
}

/** Appends the 12 triangles of a box to a mesh. */
function addBox(pos: number[], idx: number[], b: Box) {
  const base = pos.length / 3;
  const y0 = b.y ?? 0;
  const c = Math.cos(b.yaw ?? 0);
  const s = Math.sin(b.yaw ?? 0);
  for (const dy of [0, 1])
    for (const dz of [-1, 1])
      for (const dx of [-1, 1]) {
        const lx = (dx * b.sx) / 2;
        const lz = (dz * b.sz) / 2;
        pos.push(b.x + lx * c + lz * s, y0 + dy * b.sy, b.z - lx * s + lz * c);
      }
  // corners: index = dy*4 + dz01*2 + dx01
  const q = (a: number, b2: number, c2: number, d: number) => idx.push(base + a, base + b2, base + c2, base + a, base + c2, base + d);
  q(0, 1, 3, 2); // bottom
  q(4, 6, 7, 5); // top
  q(0, 2, 6, 4); // -x
  q(1, 5, 7, 3); // +x
  q(0, 4, 5, 1); // -z
  q(2, 3, 7, 6); // +z
}

/** The empty flat tile with some boxes standing on it (static collision a ray can hit and a character cannot walk through). */
export function boxTile(boxes: Box[]): TileData {
  const t = flatTile();
  const pos: number[] = [];
  const idx: number[] = [];
  for (const b of boxes) addBox(pos, idx, b);
  return {
    ...t,
    collisionPositions: new Float32Array(pos),
    collisionIndices: new Uint32Array(idx),
    manifest: { ...t.manifest, collision: { file: 'collision.bin', vertexCount: pos.length / 3, indexCount: idx.length } },
  };
}
