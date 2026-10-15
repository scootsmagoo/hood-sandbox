import type { LanesData } from '../src/shared/lanes';
import type { ScenarioPoint } from '../src/shared/walk';
import type { TileData } from '../src/shared/tile';
import { flatTile } from './helpers';

/** A closed box building from (x0, z0) to (x1, z1), `h` m tall: walls and a flat roof, in the order `collision.bin` has them. */
export function boxMesh(boxes: { x0: number; z0: number; x1: number; z1: number; h: number }[]): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const b of boxes) {
    const y0 = -1, y1 = b.h;
    const base = positions.length / 3;
    // corners: 0 sw, 1 se, 2 ne, 3 nw (bottom), 4 to 7 the same on top
    const c: [number, number][] = [[b.x0, b.z1], [b.x1, b.z1], [b.x1, b.z0], [b.x0, b.z0]];
    for (const y of [y0, y1]) for (const [x, z] of c) positions.push(x, y, z);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      indices.push(base + i, base + j, base + 4 + i, base + j, base + 4 + j, base + 4 + i);
    }
    indices.push(base + 4, base + 5, base + 6, base + 4, base + 6, base + 7);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** The flat test tile with box buildings in it (`buildingTriangles` says so, as a baked tile does), and optionally street furniture. */
export function boxTile(boxes: Parameters<typeof boxMesh>[0], extra: { lanes?: LanesData; scenarios?: ScenarioPoint[] } = {}): TileData {
  const { positions, indices } = boxMesh(boxes);
  const t = flatTile();
  return {
    ...t,
    collisionPositions: positions,
    collisionIndices: indices,
    manifest: { ...t.manifest, collision: { file: 'collision.bin', vertexCount: positions.length / 3, indexCount: indices.length, buildingTriangles: indices.length / 3 } },
    lanes: extra.lanes,
    scenarios: extra.scenarios ? { version: 1, points: extra.scenarios } : undefined,
  };
}

/** Lane data with nothing but signal poles at the given places (each facing south, yaw 0). */
export function polesAt(...at: [number, number][]): LanesData {
  return {
    format: 'hood-lanes',
    version: 1,
    edges: [],
    junctions: [{ id: 'j0', x: 0, z: 0, control: 'signals', legs: [{ dir: [0, 1], approach: true }], heads: at.map(([x, z]) => ({ leg: 0, x, y: 0, z, yaw: 0 })) }],
  };
}
