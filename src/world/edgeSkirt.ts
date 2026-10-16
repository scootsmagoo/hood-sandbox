/**
 * The edge of a single baked tile. The tile's ground stops at its bounds; past them there is nothing, and from a street near the edge
 * (Mangum St SW is 60 m from the west one) the world looks cut off, with the stadium hero standing half out over the void. This adds
 * what the M2 multi-tile bake will make real:
 *
 *  - a ground skirt: the tile's own edge heights carried outward and let down a little with distance, in the colour of the ground at
 *    that edge, out to where the haze takes it (the fog colour is the sky's, so the horizon is seamless);
 *  - a far skyline: a few hundred plain blocks in the muted greys of distant buildings, thinner and lower beyond the edges where the
 *    city is low, with towers to the north where Midtown stands, none in the footprint of a hero landmark.
 *
 * Only for a tile on its own (`createWorldView`); a streamed city has its far tiles. The sim never sees any of it: there is no
 * collision, and nobody can walk out there (the edge of the tile is the edge of the heightmap).
 */
import * as THREE from 'three';

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type Side = 'w' | 'e' | 'n' | 's';

/** The ground along the four edges of the tile: heights by distance along the edge, and the mean ground colour next to it. */
export interface EdgeProfile {
  /** `w` and `e` run along z; `n` (z = minZ) and `s` along x. Sorted by `t`. */
  sides: Record<Side, { t: number[]; y: number[] }>;
  color: Record<Side, [number, number, number]>;
}

/** How far the skirt reaches past the tile, m. */
export const SKIRT_REACH = 2400;
/** The skirt sinks this far by its outer edge, m: the horizon curves away a little. */
const SKIRT_DROP = 28;
/** Distances (m) of the lines of the skirt's grid from the tile edge. */
const RINGS = [0, 10, 32, 80, 160, 300, 520, 820, 1250, 1800, SKIRT_REACH];

const BAND = 40;
const STEP = 12;

/** Collects the edge profile from ground meshes' vertex positions and colours (a tile's `ground.glb` chunks). */
export class EdgeSampler {
  private readonly cell = { w: new Map<number, [number, number]>(), e: new Map<number, [number, number]>(), n: new Map<number, [number, number]>(), s: new Map<number, [number, number]>() };
  private readonly sum: Record<Side, [number, number, number, number]> = { w: [0, 0, 0, 0], e: [0, 0, 0, 0], n: [0, 0, 0, 0], s: [0, 0, 0, 0] };

  constructor(private readonly b: Bounds) {}

  /** One vertex: where it is and its colour (r, g, b as the mesh has them). */
  add(x: number, y: number, z: number, r: number, g: number, bl: number) {
    const b = this.b;
    const sides: [Side, number, number][] = [['w', x - b.minX, z], ['e', b.maxX - x, z], ['n', z - b.minZ, x], ['s', b.maxZ - z, x]];
    for (const [side, d, t] of sides) {
      if (d > BAND || d < -0.5) continue;
      const s = this.sum[side];
      s[0] += r; s[1] += g; s[2] += bl; s[3]++;
      if (d > 1) continue;
      const k = Math.round(t / STEP);
      const c = this.cell[side].get(k);
      if (c) { c[0] += y; c[1]++; } else this.cell[side].set(k, [y, 1]);
    }
  }

  profile(): EdgeProfile {
    const sides = {} as EdgeProfile['sides'];
    const color = {} as EdgeProfile['color'];
    for (const side of ['w', 'e', 'n', 's'] as Side[]) {
      const keys = [...this.cell[side].keys()].sort((p, q) => p - q);
      sides[side] = { t: keys.map((k) => k * STEP), y: keys.map((k) => this.cell[side].get(k)![0] / this.cell[side].get(k)![1]) };
      const s = this.sum[side];
      color[side] = s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [0.4, 0.4, 0.38];
    }
    return { sides, color };
  }
}

function interp(t: number[], y: number[], at: number): number {
  const n = t.length;
  if (n === 0) return 0;
  if (at <= t[0]) return y[0];
  if (at >= t[n - 1]) return y[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= at) lo = mid; else hi = mid;
  }
  const u = (at - t[lo]) / (t[hi] - t[lo] || 1);
  return y[lo] + (y[hi] - y[lo]) * u;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How far (m) a point is outside the tile, by its worst axis, and the heights the skirt has there. */
export function skirtHeight(p: EdgeProfile, b: Bounds, x: number, z: number): number {
  const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
  const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
  const cx = Math.max(b.minX, Math.min(b.maxX, x));
  const cz = Math.max(b.minZ, Math.min(b.maxZ, z));
  // the edge height at the nearest point of the tile's boundary: along the edge, or at a corner the mean of the two
  const w = interp(p.sides.w.t, p.sides.w.y, cz), e = interp(p.sides.e.t, p.sides.e.y, cz);
  const n = interp(p.sides.n.t, p.sides.n.y, cx), s = interp(p.sides.s.t, p.sides.s.y, cx);
  const west = x <= b.minX, east = x >= b.maxX, north = z <= b.minZ, south = z >= b.maxZ;
  const ew = west ? w : e;
  const ns = north ? n : s;
  const hasX = west || east, hasZ = north || south;
  const y = hasX && hasZ ? (ew + ns) / 2 : hasX ? ew : hasZ ? ns : (w + e + n + s) / 4;
  const d = Math.hypot(dx, dz);
  return y - SKIRT_DROP * Math.pow(smooth(0, SKIRT_REACH, d), 1.4);
}

/** The colour of the ground at a point outside the tile: the edges' colours, blended at a corner. */
function skirtColor(p: EdgeProfile, b: Bounds, x: number, z: number): [number, number, number] {
  const sx: Side | null = x <= b.minX ? 'w' : x >= b.maxX ? 'e' : null;
  const sz: Side | null = z <= b.minZ ? 'n' : z >= b.maxZ ? 's' : null;
  const a = p.color[sx ?? sz ?? 'w'];
  const c = p.color[sz ?? sx ?? 'w'];
  return [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
}

/** The skirt as positions, colours and indices (a ring of quads round the tile on a grid that gets coarser outward). */
export function skirtGeometry(p: EdgeProfile, b: Bounds): { positions: Float32Array; colors: Float32Array; indices: Uint32Array } {
  const xs = [...RINGS].reverse().map((d) => b.minX - d).concat([b.maxX], RINGS.slice(1).map((d) => b.maxX + d));
  // (xs now runs from the far west edge to the far east edge, with the tile's own minX and maxX in it)
  const zs = [...RINGS].reverse().map((d) => b.minZ - d).concat([b.maxZ], RINGS.slice(1).map((d) => b.maxZ + d));
  // a line along the tile's own edge, every 32 m, so the skirt follows the ground's profile
  const refine = (lines: number[], lo: number, hi: number) => {
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (lines[i] === lo) for (let v = lo + 64; v < hi - 32; v += 64) out.push(v);
    }
    return out;
  };
  const gx = refine(xs, b.minX, b.maxX);
  const gz = refine(zs, b.minZ, b.maxZ);
  const nx = gx.length, nz = gz.length;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      const x = gx[i], z = gz[j];
      positions[k] = x;
      positions[k + 1] = skirtHeight(p, b, x, z);
      positions[k + 2] = z;
      const c = skirtColor(p, b, x, z);
      colors[k] = c[0]; colors[k + 1] = c[1]; colors[k + 2] = c[2];
    }
  }
  const idx: number[] = [];
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const cx = (gx[i] + gx[i + 1]) / 2, cz = (gz[j] + gz[j + 1]) / 2;
      if (cx > b.minX && cx < b.maxX && cz > b.minZ && cz < b.maxZ) continue;
      const a = j * nx + i, c = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, c, c, d, e);
    }
  }
  return { positions, colors, indices: Uint32Array.from(idx) };
}

/** A far block: where, how big and how tall, and its grey. */
export interface FarBlock {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  grey: number;
  yaw: number;
}

function hash(i: number, k: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * The skyline beyond the tile: blocks on a jittered grid outside it, a little taller toward the north (Midtown) and nearer the tile.
 * `avoid` are rings (hero footprints) the blocks keep out of. Deterministic.
 */
export function farBlocks(b: Bounds, avoid: [number, number][][]): FarBlock[] {
  const out: FarBlock[] = [];
  const inRing = (x: number, z: number, ring: [number, number][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const near = (x: number, z: number, ring: [number, number][]) => {
    for (const q of ring) if (Math.hypot(q[0] - x, q[1] - z) < 60) return true;
    return inRing(x, z, ring);
  };
  const cell = 110;
  const reach = 1800;
  let n = 0;
  for (let gz = Math.floor((b.minZ - reach) / cell); gz <= Math.floor((b.maxZ + reach) / cell); gz++) {
    for (let gx = Math.floor((b.minX - reach) / cell); gx <= Math.floor((b.maxX + reach) / cell); gx++) {
      const x = (gx + 0.15 + 0.7 * hash(gx, gz)) * cell;
      const z = (gz + 0.15 + 0.7 * hash(gz, gx + 7)) * cell;
      const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
      const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
      const d = Math.hypot(dx, dz);
      if (d < 22 || d > reach) continue;
      // streets and lots: leave a third empty, more the farther out
      if (hash(gx * 31 + 5, gz) < 0.34 + 0.4 * (d / reach)) continue;
      if (avoid.some((r) => near(x, z, r))) continue;
      const north = z < b.minZ ? smooth(0, 1400, b.minZ - z) : 0;
      const tall = hash(gx, gz * 17 + 3);
      let h = 7 + 18 * hash(gx + 3, gz + 11) * hash(gx + 5, gz + 2) * 2.4;
      if (tall > 0.93 - 0.05 * north) h += 20 + 110 * north * hash(gx + 9, gz + 4) + 30 * hash(gx + 1, gz + 1);
      h *= 1 - 0.35 * (d / reach);
      // the nearest ones are houses and shops (a street's worth of them is small); the big blocks stand farther out
      const size = 0.5 + 0.5 * smooth(40, 700, d);
      h *= 0.55 + 0.45 * smooth(40, 500, d);
      const w = (18 + 40 * hash(gx + 13, gz + 19)) * size;
      out.push({ x, z, w, d: (18 + 38 * hash(gx + 23, gz + 29)) * size, h, grey: 0.46 + 0.26 * hash(gx + 31, gz + 37), yaw: (hash(gx, gz + 41) - 0.5) * 0.5 });
      n++;
    }
  }
  return out;
}

/** The skirt and the skyline as one group (null when the tile's edge could not be read). */
export function buildEdge(sampler: EdgeSampler, b: Bounds, avoid: [number, number][][]): THREE.Group | null {
  // (a nicety: whatever goes wrong here, the world is drawn without it)
  try {
    return buildEdgeUnsafe(sampler, b, avoid);
  } catch (e) {
    console.warn('[world] edge skirt skipped:', (e as Error).message);
    return null;
  }
}

function buildEdgeUnsafe(sampler: EdgeSampler, b: Bounds, avoid: [number, number][][]): THREE.Group | null {
  const profile = sampler.profile();
  if (!(['w', 'e', 'n', 's'] as Side[]).every((s) => profile.sides[s].t.length > 2)) return null;
  const group = new THREE.Group();
  group.name = 'edge';
  const sk = skirtGeometry(profile, b);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(sk.positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(sk.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(sk.indices, 1));
  geo.computeVertexNormals();
  const skirt = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: 'ground_skirt', vertexColors: true, roughness: 0.95, metalness: 0 }));
  skirt.name = 'skirt';
  skirt.receiveShadow = false;
  skirt.castShadow = false;
  skirt.frustumCulled = false;
  group.add(skirt);

  const blocks = farBlocks(b, avoid);
  if (blocks.length) {
    // one mesh per quarter of the compass round the tile, so the ones behind the camera are not drawn
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const quarter = (k: FarBlock) => (Math.abs(k.x - cx) / (b.maxX - b.minX) > Math.abs(k.z - cz) / (b.maxZ - b.minZ) ? (k.x < cx ? 0 : 1) : k.z < cz ? 2 : 3);
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ name: 'far_block', roughness: 0.92, metalness: 0 });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    for (let part = 0; part < 4; part++) {
      const list = blocks.filter((k) => quarter(k) === part);
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(box, mat, list.length);
      list.forEach((k, i) => {
        const y = skirtHeight(profile, b, k.x, k.z) - 1;
        q.setFromAxisAngle(up, k.yaw);
        m.compose(new THREE.Vector3(k.x, y, k.z), q, new THREE.Vector3(k.w, k.h + 1, k.d));
        mesh.setMatrixAt(i, m);
        c.setRGB(k.grey, k.grey * 0.99, k.grey * 0.96);
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = `far-blocks-${part}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
  }
  return group;
}
