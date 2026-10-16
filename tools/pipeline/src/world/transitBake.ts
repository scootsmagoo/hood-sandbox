/**
 * Writes a tile's transit layer: `transit.json`, `transit.glb` and `transit.bin` (docs/contracts/m1-tile-format.md,
 * "transit.json"). Called by the tile bake (bake.ts) with what it has made, and by `npm run transit` with the files of a tile
 * already baked (to re-bake the transit layer alone: the roads, buildings and ground stay as they are).
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Projector, Rect, V2 } from '../geo.js';
import { collisionBytes } from '../io/binary.js';
import { encodeGlb, type GlbPart, type MaterialSpec } from '../io/glb.js';
import { makeChunkGrid, splitMesh } from '../mesh/chunks.js';
import type { MeshBuilder } from '../mesh/builder.js';
import type { OsmData } from '../sources/osm.js';
import { buildTransit, type TransitInput } from './transit.js';
import { fetchTransit, transitBox, transitCacheFile, transitQuery } from './transitFetch.js';
import { parseTransitOsm } from './transitData.js';
import polygonClipping from 'polygon-clipping';
import { REPO_ROOT as REPO_ROOT_GUESS } from '../config.js';
import type { TransitPack } from './transitData.js';

const MAT: Record<'int' | 'ext', MaterialSpec> = {
  int: { name: 'tr_int', baseColor: [1, 1, 1, 1], roughness: 0.85 },
  ext: { name: 'tr_ext', baseColor: [1, 1, 1, 1], roughness: 0.9 },
};

export interface TransitBakeInput {
  repoRoot: string;
  cityId: string;
  endpoints: readonly string[];
  projector: Projector;
  bounds: Rect;
  chunkSize: number;
  outDir: string;
  ground: (x: number, z: number) => number;
  roads: { class: string; width: number; bridge: boolean; points: [number, number, number][] }[];
  inBuilding: (x: number, z: number) => boolean;
  obstacles: V2[];
  log: (m: string) => void;
  /** use this network instead of fetching (tests) */
  osm?: OsmData | null;
}

/** "Inside a building" over footprint rings (outer ring, then courtyards), through a grid of their boxes. */
export function footprintTest(footprints: V2[][][]): (x: number, z: number) => boolean {
  const cell = 32;
  const grid = new Map<string, number[]>();
  footprints.forEach((rings, i) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of rings[0]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gz = Math.floor(z0 / cell); gz <= Math.floor(z1 / cell); gz++) {
      const k = `${gx},${gz}`;
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  });
  const inRing = (x: number, z: number, ring: V2[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  return (x, z) => (grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []).some((i) => inRing(x, z, footprints[i][0]) && !footprints[i].slice(1).some((h) => inRing(x, z, h)));
}

const CAR = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|busway)(_link)?$/;

/** A segment index over the roads for the two questions the layer asks: what road surface is under a point, and is it on a carriageway. */
export function roadQueries(roads: TransitBakeInput['roads']): { roadUnder: TransitInput['roadUnder']; onRoad: TransitInput['onRoad'] } {
  const cell = 32;
  const segs: { ax: number; az: number; ay: number; bx: number; bz: number; by: number; half: number; bridge: boolean }[] = [];
  const grid = new Map<string, number[]>();
  for (const r of roads) {
    if (!CAR.test(r.class)) continue;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const k = segs.length;
      segs.push({ ax: a[0], az: a[2], ay: a[1], bx: b[0], bz: b[2], by: b[1], half: r.width / 2, bridge: r.bridge });
      const R = r.width / 2 + 2;
      for (let x = Math.floor((Math.min(a[0], b[0]) - R) / cell); x <= Math.floor((Math.max(a[0], b[0]) + R) / cell); x++) {
        for (let z = Math.floor((Math.min(a[2], b[2]) - R) / cell); z <= Math.floor((Math.max(a[2], b[2]) + R) / cell); z++) {
          const key = `${x},${z}`;
          const l = grid.get(key);
          if (l) l.push(k);
          else grid.set(key, [k]);
        }
      }
    }
  }
  const near = (x: number, z: number, fn: (s: (typeof segs)[number], d: number, y: number) => void) => {
    for (const k of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const s = segs[k];
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      fn(s, Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)), s.ay + (s.by - s.ay) * t);
    }
  };
  return {
    roadUnder: (x, z) => {
      let y = -Infinity;
      near(x, z, (s, d, sy) => {
        if (d <= s.half + 1.5) y = Math.max(y, sy);
      });
      return y;
    },
    onRoad: (x, z, margin) => {
      let hit = false;
      near(x, z, (s, d) => {
        if (!s.bridge && d <= s.half - margin) hit = true;
      });
      return hit;
    },
  };
}

function railcar(repoRoot: string): { length: number; gap: number } {
  const j = JSON.parse(readFileSync(path.join(repoRoot, 'src', 'shared', 'data', 'railcar.json'), 'utf8')) as { length: number; gap: number };
  return { length: j.length, gap: j.gap };
}

/** Builds and writes the transit layer; returns the tile.json field to add (`transit`), or null when the tile has none. */
export async function bakeTransit(inp: TransitBakeInput): Promise<{ field: string; sizes: Record<string, number>; stats: Record<string, unknown> } | null> {
  const packFile = path.join(inp.repoRoot, 'data', 'cities', inp.cityId, 'transit.json');
  if (!existsSync(packFile)) return null;
  const pack = JSON.parse(readFileSync(packFile, 'utf8')) as TransitPack;
  const brandsFile = path.join(inp.repoRoot, 'data', 'cities', inp.cityId, 'brands.json');
  const brands = existsSync(brandsFile) ? (JSON.parse(readFileSync(brandsFile, 'utf8')) as { brands: { real: string; parody: string }[] }).brands : [];
  const osm = inp.osm !== undefined ? inp.osm : await fetchTransit(inp.cityId, inp.endpoints, transitBox(pack));
  if (!osm) {
    inp.log('transit: no network data (the Overpass query failed and nothing is cached); the tile has no transit');
    return null;
  }
  const rq = roadQueries(inp.roads);
  const res = buildTransit({ osm, projector: inp.projector, bounds: inp.bounds, ground: inp.ground, roadUnder: rq.roadUnder, onRoad: rq.onRoad, inBuilding: inp.inBuilding, obstacles: inp.obstacles, pack, brands, car: railcar(inp.repoRoot) });
  if (!res) {
    inp.log('transit: no line runs through the tile');
    return null;
  }
  const { file, meshes } = res;
  const grid = makeChunkGrid(inp.bounds, inp.chunkSize);
  const parts: GlbPart[] = [];
  const chunked = (kind: 'int' | 'ext', mb: MeshBuilder) => {
    for (const [key, m] of [...splitMesh(mb, grid)].sort((a, b) => a[0] - b[0])) {
      const cx = key % grid.cols, cz = Math.floor(key / grid.cols);
      m.pad();
      const alpha = m.channels.get('light')?.data;
      parts.push({ name: `transit_${kind}_${cx}_${cz}`, material: MAT[kind], positions: m.positions, normals: m.normals, colors: m.colors, alpha, indices: m.indices, extras: { kind: `transit_${kind}`, chunk: [cx, cz] } });
    }
  };
  chunked('int', meshes.int);
  chunked('ext', meshes.ext);
  mkdirSync(inp.outDir, { recursive: true });
  const sizes: Record<string, number> = {};
  const write = (name: string, data: Uint8Array | string) => {
    const f = path.join(inp.outDir, name);
    writeFileSync(f, data);
    sizes[name] = statSync(f).size;
  };
  write('transit.glb', await encodeGlb(parts));
  write('transit.bin', collisionBytes(meshes.col.positions, meshes.col.indices));
  file.mesh = 'transit.glb';
  file.collision = { file: 'transit.bin', vertexCount: meshes.col.vertexCount, indexCount: meshes.col.indices.length };
  write('transit.json', JSON.stringify(file));
  inp.log(`transit: ${JSON.stringify(res.stats)}`);
  return { field: 'transit.json', sizes, stats: res.stats };
}

/**
 * The open structures of the elevated stations, which the map draws as buildings (the station building round the platforms):
 * outlines (each a ring) over which the bake's generic buildings are left out, so the platforms and their stairs are not inside a
 * solid prism. The elevated platforms of the city's network (OSM, layer 1 and up) grown by 6 m. Empty when the network is not
 * cached (no request is made here: the transit step fetches it).
 */
export function transitCutouts(cityId: string, projector: Projector, bounds: Rect): V2[][] {
  return transitOutlines(cityId, projector, bounds).grown;
}

/**
 * The elevated platforms' outlines: `grown` (4 m along, 8 m across: what a station building round them covers) and `deck` (the
 * platform itself as the layer lays it out: at least 152 m long, a metre either side), over which no building may stand at all.
 */
export function transitOutlines(cityId: string, projector: Projector, bounds: Rect): { grown: V2[][]; deck: V2[][] } {
  const deck: V2[][] = [];
  const packFile = path.join(REPO_ROOT_GUESS, 'data', 'cities', cityId, 'transit.json');
  if (!existsSync(packFile)) return { grown: [], deck };
  const pack = JSON.parse(readFileSync(packFile, 'utf8')) as TransitPack;
  const file = transitCacheFile(cityId, transitQuery(transitBox(pack)));
  if (!existsSync(file)) return { grown: [], deck };
  const osm = JSON.parse(readFileSync(file, 'utf8')) as OsmData;
  const raw = parseTransitOsm(osm, projector, pack);
  const out: V2[][] = [];
  for (const p of raw.platforms) {
    if (p.layer < 1 || p.ring.length < 2) continue;
    const [cx, cz] = p.centroid;
    if (cx < bounds.minX - 50 || cx > bounds.maxX + 50 || cz < bounds.minZ - 50 || cz > bounds.maxZ + 50) continue;
    // the ring grown by 6 m (round its centroid, enough for a narrow platform outline)
    const grown = p.ring.map(([x, z]) => {
      const dx = x - cx, dz = z - cz;
      const d = Math.hypot(dx, dz) || 1;
      return [x + (dx / d) * 6, z + (dz / d) * 6] as V2;
    });
    // its box along the nearest track (a short platform outline says little of its own direction)
    let ax = 1, az = 0, bd = Infinity;
    for (const t of raw.tracks.values()) {
      for (let i = 0; i + 1 < t.pts.length; i++) {
        const [x0, z0] = t.pts[i], [x1, z1] = t.pts[i + 1];
        const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz;
        if (l2 === 0) continue;
        const u = Math.max(0, Math.min(1, ((cx - x0) * dx + (cz - z0) * dz) / l2));
        const d = Math.hypot(cx - x0 - dx * u, cz - z0 - dz * u);
        if (d < bd) {
          bd = d;
          const l = Math.sqrt(l2);
          ax = dx / l;
          az = dz / l;
        }
      }
    }
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of p.ring) {
      const a = (x - cx) * ax + (z - cz) * az, bb = -(x - cx) * az + (z - cz) * ax;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, bb); b1 = Math.max(b1, bb);
    }
    const P = (a: number, bb: number): V2 => [cx + a * ax - bb * az, cz + a * az + bb * ax];
    // the deck as laid out: as long as a train at the least
    const half = Math.max((a1 - a0) / 2, pack.defaults.minPlatformM / 2) + 2, mid = (a0 + a1) / 2;
    deck.push([P(mid - half, b0 - 1), P(mid + half, b0 - 1), P(mid + half, b1 + 1), P(mid - half, b1 + 1)]);
    a0 -= 4; a1 += 4; b0 -= 8; b1 += 8;
    out.push([P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1)]);
    void grown;
  }
  return { grown: out, deck };
}

/** The area of a footprint inside any of the outlines, m2. */
export function areaInside(ring: V2[], outlines: V2[][]): number {
  const area = Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  return shareInside(ring, outlines) * area;
}

/** The share of a footprint's area inside any of the outlines. */
export function shareInside(ring: V2[], outlines: V2[][]): number {
  if (outlines.length === 0) return 0;
  const area = Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  if (area <= 0) return 0;
  try {
    const inter = polygonClipping.intersection([ring.map((p) => [p[0], p[1]] as [number, number])], (polygonClipping.union as (...g: [number, number][][][]) => [number, number][][][])(...outlines.map((o) => [o.map((p) => [p[0], p[1]] as [number, number])])));
    let a = 0;
    for (const poly of inter) poly.forEach((r, k) => {
      const ar = Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
      a += k === 0 ? ar : -ar;
    });
    return a / area;
  } catch {
    return 0;
  }
}
