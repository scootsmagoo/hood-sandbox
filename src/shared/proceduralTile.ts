/**
 * The fallback world: a tile with the same shape as a baked one (manifest, flat heightmap,
 * collision triangles) so the sim and client take one code path. Boxes stand in for buildings, a
 * ramp tests the suspension, and a few kerbs and stairs test the character's step-up. It is a
 * pure function of the seed, so the client can rebuild the visuals from `props` without help.
 */
import { Rng } from './rng';
import type { TileData, TileManifest } from './tile';

export interface PropSpec {
  kind: 'box' | 'wedge';
  /** Centre of the base. */
  x: number;
  y: number;
  z: number;
  /** Width (x), height (y) and depth (z). A wedge rises toward its local +Z. */
  sx: number;
  sy: number;
  sz: number;
  /** Rotation about +Y (counter-clockwise from above). */
  yaw: number;
  color: [number, number, number];
}

export interface ProceduralTile extends TileData {
  props: PropSpec[];
}

export interface MeshData {
  positions: number[];
  indices: number[];
}

/** Appends a convex polyhedron; every face is wound counter-clockwise seen from outside. */
function addConvex(mesh: MeshData, verts: [number, number, number][], faces: number[][]) {
  const base = mesh.positions.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of verts) {
    mesh.positions.push(v[0], v[1], v[2]);
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  cx /= verts.length;
  cy /= verts.length;
  cz /= verts.length;
  for (const f of faces) {
    for (let i = 1; i < f.length - 1; i++) {
      let a = f[0];
      let b = f[i];
      let c = f[i + 1];
      const va = verts[a];
      const vb = verts[b];
      const vc = verts[c];
      const ux = vb[0] - va[0];
      const uy = vb[1] - va[1];
      const uz = vb[2] - va[2];
      const wx = vc[0] - va[0];
      const wy = vc[1] - va[1];
      const wz = vc[2] - va[2];
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const out = nx * (va[0] - cx) + ny * (va[1] - cy) + nz * (va[2] - cz);
      if (out < 0) [b, c] = [c, b];
      mesh.indices.push(base + a, base + b, base + c);
    }
  }
}

function rotY(x: number, z: number, yaw: number): [number, number] {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** Triangles for one prop, in world space. */
export function appendProp(mesh: MeshData, p: PropSpec) {
  const hx = p.sx / 2;
  const hz = p.sz / 2;
  const place = (lx: number, ly: number, lz: number): [number, number, number] => {
    const [rx, rz] = rotY(lx, lz, p.yaw);
    return [p.x + rx, p.y + ly, p.z + rz];
  };
  if (p.kind === 'box') {
    const v: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) v.push(place(i & 1 ? hx : -hx, i & 2 ? p.sy : 0, i & 4 ? hz : -hz));
    addConvex(mesh, v, [
      [0, 1, 3, 2], [4, 5, 7, 6], // -z, +z (by index bits z=0 / z=1)
      [0, 1, 5, 4], [2, 3, 7, 6], // bottom, top
      [0, 2, 6, 4], [1, 3, 7, 5], // -x, +x
    ]);
  } else {
    const v = [
      place(-hx, 0, -hz), place(hx, 0, -hz), place(hx, 0, hz), place(-hx, 0, hz),
      place(-hx, p.sy, hz), place(hx, p.sy, hz),
    ];
    addConvex(mesh, v, [[0, 1, 2, 3], [3, 2, 5, 4], [0, 3, 4], [1, 2, 5], [0, 1, 5, 4]]);
  }
}

export function propsToMesh(props: readonly PropSpec[]): MeshData {
  const mesh: MeshData = { positions: [], indices: [] };
  for (const p of props) appendProp(mesh, p);
  return mesh;
}

const CELL = 4;
const HALF = 1000;

export function generateProceduralTile(seed = 1): ProceduralTile {
  const rng = new Rng(seed).fork('procedural-tile');
  const props: PropSpec[] = [];
  const grey = (): [number, number, number] => {
    const g = rng.range(0.38, 0.62);
    return [g, g * rng.range(0.95, 1.05), g * rng.range(0.9, 1.1)];
  };

  // City blocks around an open plaza. Streets 20 m wide between 50 m blocks.
  const pitch = 70;
  for (let gx = -6; gx <= 6; gx++) {
    for (let gz = -6; gz <= 6; gz++) {
      const cx = gx * pitch;
      const cz = gz * pitch;
      if (Math.abs(cx) < 120 && Math.abs(cz) < 120) continue;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const sx = rng.range(14, 26);
        const sz = rng.range(14, 26);
        props.push({
          kind: 'box',
          x: cx + rng.range(-12, 12),
          y: 0,
          z: cz + rng.range(-12, 12),
          sx,
          sy: rng.range(9, 70),
          sz,
          yaw: 0,
          color: grey(),
        });
      }
    }
  }

  // Ramp 60 m ahead of the vehicle spawn, rising toward north (-Z), and a smaller kicker beside it.
  props.push({ kind: 'wedge', x: 0, y: 0, z: -70, sx: 9, sy: 3.2, sz: 20, yaw: Math.PI, color: [0.8, 0.55, 0.2] });
  props.push({ kind: 'wedge', x: 30, y: 0, z: -70, sx: 7, sy: 1.6, sz: 12, yaw: Math.PI, color: [0.8, 0.55, 0.2] });

  // Kerbs, stairs and a wall for the character: 0.15 m and 0.3 m steps, a three-step stair, a 1 m wall.
  props.push({ kind: 'box', x: -14, y: 0, z: -4, sx: 6, sy: 0.15, sz: 3, yaw: 0, color: [0.7, 0.7, 0.72] });
  props.push({ kind: 'box', x: -14, y: 0, z: 2, sx: 6, sy: 0.3, sz: 3, yaw: 0, color: [0.65, 0.65, 0.68] });
  for (let i = 0; i < 3; i++) {
    const width = 5 - 0.6 * i; // every step ends at x = -25, each starts 0.6 m further back
    props.push({ kind: 'box', x: -20 - 0.6 * i - width / 2, y: 0, z: 0, sx: width, sy: 0.18 * (i + 1), sz: 3, yaw: 0, color: [0.6, 0.6, 0.64] });
  }
  props.push({ kind: 'box', x: -14, y: 0, z: 10, sx: 6, sy: 1.0, sz: 0.6, yaw: 0, color: [0.5, 0.35, 0.3] });

  // A wall around the tile, so the vehicle cannot leave it.
  const t = 4;
  const h = 12;
  const wallColor: [number, number, number] = [0.25, 0.25, 0.3];
  props.push({ kind: 'box', x: 0, y: 0, z: -HALF - t / 2, sx: 2 * HALF + 2 * t, sy: h, sz: t, yaw: 0, color: wallColor });
  props.push({ kind: 'box', x: 0, y: 0, z: HALF + t / 2, sx: 2 * HALF + 2 * t, sy: h, sz: t, yaw: 0, color: wallColor });
  props.push({ kind: 'box', x: -HALF - t / 2, y: 0, z: 0, sx: t, sy: h, sz: 2 * HALF, yaw: 0, color: wallColor });
  props.push({ kind: 'box', x: HALF + t / 2, y: 0, z: 0, sx: t, sy: h, sz: 2 * HALF, yaw: 0, color: wallColor });

  const mesh = propsToMesh(props);
  const cols = (2 * HALF) / CELL + 1;
  const manifest: TileManifest = {
    format: 'hood-tile',
    version: 1,
    id: 'procedural/test-ground',
    origin: { lat: 33.7539, lon: -84.3916, E: 0, N: 0 },
    baseElevation: 0,
    bounds: { minX: -HALF, minZ: -HALF, maxX: HALF, maxZ: HALF },
    heightmap: { file: 'height.bin', cols, rows: cols, cellSize: CELL, minX: -HALF, minZ: -HALF },
    meshes: {},
    collision: { file: 'collision.bin', vertexCount: mesh.positions.length / 3, indexCount: mesh.indices.length },
    spawns: {
      player: { x: -3, y: 0, z: 12 },
      vehicle: { x: 3, y: 0, z: 12, heading: 0 },
    },
    attribution: [],
  };
  return {
    manifest,
    heights: new Float32Array(cols * cols),
    collisionPositions: new Float32Array(mesh.positions),
    collisionIndices: new Uint32Array(mesh.indices),
    source: 'procedural',
    props,
  };
}
