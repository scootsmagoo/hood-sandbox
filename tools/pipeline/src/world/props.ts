/**
 * Anchors for trees, street lamps and street furniture (props.json): from OSM nodes and ways where they are mapped, and
 * synthetic placements (street trees along sidewalks, park and woodland fill, lamps at realistic spacing) where they are not.
 * Not geometry; the client instances models at these points. The Meta/WRI canopy raster is NOT used (its licence is not settled).
 * See "props.json" in docs/contracts/m1-tile-format.md.
 */
import type { Projector, Rect, V2, V3 } from '../geo.js';
import { pointInRing, ringBounds } from '../geo.js';
import type { OsmData } from '../sources/osm.js';
import type { Area, RoadWay } from './osm.js';
import { RoadMask } from './markings.js';
import { distToRings, hash32, inPolygon, rng } from './shape.js';

export interface PropsRoad {
  class: string;
  width: number;
  oneway: boolean;
  bridge: boolean;
  points: V3[];
}

export interface PropsInput {
  osm: OsmData | null;
  projector: Projector;
  roads: PropsRoad[];
  /** pedestrian streets (`highway=pedestrian` lines) */
  pedestrianWays: RoadWay[];
  areas: Area[];
  /** building footprints, outer ring first */
  footprints: V2[][][];
  /** car roads and junction polygons */
  roadMask: RoadMask;
  /** the walk network's edges, as a mask with zero half width */
  pathMask: RoadMask;
  ground: (x: number, z: number) => number;
  bounds: Rect;
}

export interface PropsFile {
  version: 1;
  trees: number[][];
  lamps: number[][];
  hydrants: number[][];
  bins: number[][];
  bollards: number[][];
  stats: {
    trees: { osm: number; row: number; street: number; park: number; byClass: number[] };
    lamps: { osm: number; synthetic: number; byKind: number[] };
    hydrants: number;
    bins: number;
    bollards: number;
    osm: boolean;
  };
}

/** Tree classes: broadleaf, conifer, small ornamental. */
export const TREE_CLASS = { broadleaf: 0, conifer: 1, ornamental: 2 } as const;
export const MAX_TREES = 6000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** A spatial index over footprints for "is this point in or near a building". */
class Footprints {
  private cells = new Map<string, number[]>();
  private polys: { rings: V2[][]; bb: Rect }[] = [];
  constructor(private readonly cell = 40) {}
  add(rings: V2[][]): void {
    const bb = ringBounds(rings[0]);
    const k = this.polys.length;
    this.polys.push({ rings, bb });
    for (let x = Math.floor(bb.minX / this.cell); x <= Math.floor(bb.maxX / this.cell); x++) {
      for (let z = Math.floor(bb.minZ / this.cell); z <= Math.floor(bb.maxZ / this.cell); z++) {
        const key = `${x},${z}`;
        const a = this.cells.get(key);
        if (a) a.push(k); else this.cells.set(key, [k]);
      }
    }
  }
  /** True when (x, z) is inside a footprint or within `margin` m of one. */
  near(x: number, z: number, margin: number): boolean {
    const x0 = Math.floor((x - margin) / this.cell), x1 = Math.floor((x + margin) / this.cell);
    const z0 = Math.floor((z - margin) / this.cell), z1 = Math.floor((z + margin) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (const k of this.cells.get(`${cx},${cz}`) ?? []) {
          const p = this.polys[k];
          if (x < p.bb.minX - margin || x > p.bb.maxX + margin || z < p.bb.minZ - margin || z > p.bb.maxZ + margin) continue;
          if (inPolygon(x, z, p.rings) || distToRings(x, z, p.rings) < margin) return true;
        }
      }
    }
    return false;
  }
}

/** A spatial hash of points for "is there one within r". */
class PointSet {
  private cells = new Map<string, V2[]>();
  constructor(private readonly cell = 12) {}
  add(x: number, z: number): void {
    const key = `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
    const a = this.cells.get(key);
    if (a) a.push([x, z]); else this.cells.set(key, [[x, z]]);
  }
  within(x: number, z: number, r: number): boolean {
    for (let cx = Math.floor((x - r) / this.cell); cx <= Math.floor((x + r) / this.cell); cx++) {
      for (let cz = Math.floor((z - r) / this.cell); cz <= Math.floor((z + r) / this.cell); cz++) {
        for (const p of this.cells.get(`${cx},${cz}`) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
      }
    }
    return false;
  }
}

/** Walks a polyline at `spacing` m and calls `at(x, y, z, dirX, dirZ, s)` at every stop (the first one at `phase`). */
export function walkLine(pts: V3[], spacing: number, phase: number, at: (x: number, y: number, z: number, dx: number, dz: number, s: number) => void): void {
  let s = phase;
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (l < 1e-6) continue;
    const dx = (b[0] - a[0]) / l, dz = (b[2] - a[2]) / l;
    while (s <= acc + l) {
      const t = (s - acc) / l;
      at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, dx, dz, s);
      s += spacing;
    }
    acc += l;
  }
}

const num = (v: string | undefined): number | null => {
  const n = parseFloat((v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function treeClassOf(tags: Record<string, string>, rand: () => number): number {
  const leaf = tags.leaf_type ?? '';
  const sp = `${tags.species ?? ''} ${tags.genus ?? ''}`;
  if (leaf === 'needleleaved' || /pinus|pine|cedrus|juniperus|picea|abies/i.test(sp)) return TREE_CLASS.conifer;
  if (/lagerstroemia|crape|pyrus|pear|cercis|redbud|prunus|cherry|magnolia|dogwood|cornus/i.test(sp)) return TREE_CLASS.ornamental;
  return rand() < 0.2 ? TREE_CLASS.ornamental : TREE_CLASS.broadleaf;
}

function treeSize(cls: number, rand: () => number, tags: Record<string, string> = {}): { h: number; r: number } {
  let h: number, r: number;
  if (cls === TREE_CLASS.conifer) { h = 12 + 8 * rand(); r = 2.4 + 1.2 * rand(); }
  else if (cls === TREE_CLASS.ornamental) { h = 4.5 + 2.5 * rand(); r = 1.8 + 1.0 * rand(); }
  else { h = 9 + 7 * rand(); r = 3.4 + 2.4 * rand(); }
  const th = num(tags.height);
  if (th && th < 45) h = th;
  const cr = num(tags.diameter_crown);
  if (cr && cr < 30) r = cr / 2;
  return { h, r };
}

export function buildProps(inp: PropsInput): PropsFile {
  const fp = new Footprints();
  for (const f of inp.footprints) fp.add(f);
  const trees: number[][] = [];
  const lamps: number[][] = [];
  const stats: PropsFile['stats'] = {
    trees: { osm: 0, row: 0, street: 0, park: 0, byClass: [0, 0, 0] },
    lamps: { osm: 0, synthetic: 0, byKind: [0, 0, 0] },
    hydrants: 0, bins: 0, bollards: 0, osm: !!inp.osm,
  };
  const inside = (x: number, z: number) => x > inp.bounds.minX + 2 && x < inp.bounds.maxX - 2 && z > inp.bounds.minZ + 2 && z < inp.bounds.maxZ - 2;
  const lampSet = new PointSet();
  const treeSet = new PointSet();
  const hydrants: number[][] = [];
  const bins: number[][] = [];
  const bollards: number[][] = [];

  const addTree = (x: number, z: number, cls: number, h: number, r: number, src: number) => {
    if (trees.length >= MAX_TREES) return;
    trees.push([r2(x), r2(inp.ground(x, z)), r2(z), r1(h), r1(r), cls, src]);
    treeSet.add(x, z);
    stats.trees.byClass[cls]++;
    if (src === 1) stats.trees.osm++;
    else if (src === 2) stats.trees.row++;
    else if (src === 0) stats.trees.street++;
    else stats.trees.park++;
  };
  const addLamp = (x: number, y: number, z: number, yaw: number, h: number, kind: number, src: number) => {
    lamps.push([r2(x), r2(y), r2(z), r2(yaw), r1(h), kind, src]);
    lampSet.add(x, z);
    stats.lamps.byKind[kind]++;
    if (src === 0) stats.lamps.osm++; else stats.lamps.synthetic++;
  };

  // ---- OSM
  for (const el of inp.osm?.elements ?? []) {
    const t = el.tags ?? {};
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      const [x, z] = inp.projector.toGame(el.lon, el.lat);
      if (!inside(x, z)) continue;
      if (t.natural === 'tree') {
        if (fp.near(x, z, 0.5)) continue;
        const rand = rng(hash32(`tree${el.id}`));
        const cls = treeClassOf(t, rand);
        const s = treeSize(cls, rand, t);
        addTree(x, z, cls, s.h, s.r, 1);
      } else if (t.highway === 'street_lamp' || t.man_made === 'street_lamp') {
        const y = inp.ground(x, z) + 0.1;
        // the arm points at the nearest road
        const yaw = nearestRoadYaw(inp.roads, x, z);
        addLamp(x, y, z, yaw, 8.5, 0, 0);
      } else if (t.emergency === 'fire_hydrant') {
        hydrants.push([r2(x), r2(inp.ground(x, z)), r2(z)]);
      } else if (t.amenity === 'waste_basket' || t.amenity === 'waste_disposal') {
        bins.push([r2(x), r2(inp.ground(x, z)), r2(z)]);
      } else if (t.barrier === 'bollard') {
        bollards.push([r2(x), r2(inp.ground(x, z)), r2(z)]);
      }
    } else if (el.type === 'way' && t.natural === 'tree_row' && el.geometry) {
      const pts: V3[] = el.geometry.map((g) => {
        const [x, z] = inp.projector.toGame(g.lon, g.lat);
        return [x, 0, z] as V3;
      });
      const rand = rng(hash32(`row${el.id}`));
      const cls = treeClassOf(t, rand);
      walkLine(pts, 8, 0, (x, _y, z) => {
        if (!inside(x, z) || fp.near(x, z, 0.5)) return;
        const s = treeSize(cls, rand, t);
        addTree(x, z, cls, s.h, s.r, 2);
      });
    }
  }
  stats.hydrants = hydrants.length;
  stats.bins = bins.length;
  stats.bollards = bollards.length;

  // ---- synthetic street lamps
  const MAJOR = /^(primary|secondary|tertiary|unclassified|trunk_link|primary_link|secondary_link|tertiary_link)$/;
  for (const road of inp.roads) {
    const cls = road.class;
    const hw = road.width / 2;
    const motorway = /^(motorway|trunk)$/.test(cls);
    const major = MAJOR.test(cls);
    const minor = /^(residential|living_street)$/.test(cls);
    if (!motorway && !major && !minor) continue;
    if (/_link$/.test(cls) && !road.bridge) continue;
    const spacing = motorway ? 48 : major ? 32 : 40;
    const rand = rng(hash32(`lamps${road.points[0][0]}${road.points[0][2]}`));
    const sides: number[] = motorway ? [1] : [1, -1];
    sides.forEach((side, si) => {
      // the two sides are staggered; a one-way street or a residential street gets lamps on alternating sides
      const stride = minor || (road.oneway && !motorway) ? spacing * 2 : spacing;
      const phase = (si === 0 ? 0 : stride / 2) + rand() * 3;
      walkLine(road.points, stride, phase, (x, y, z, dx, dz) => {
        // right-hand normal of the direction of travel (+x east, +z south): (-dz, dx)
        const nx = -dz * side, nz = dx * side;
        const off = hw + 1.2;
        const lx = x + nx * off, lz = z + nz * off;
        if (!inside(lx, lz)) return;
        if (!road.bridge && (inp.roadMask.contains(lx, lz, -0.9) || fp.near(lx, lz, 0.9))) return;
        if (road.bridge && fp.near(lx, lz, 0.5)) return;
        if (lampSet.within(lx, lz, 10)) return;
        const ly = road.bridge ? y : inp.ground(lx, lz) + 0.1;
        const yaw = Math.atan2(-nx, -nz);
        addLamp(lx, ly, lz, yaw, motorway ? 14 : major ? 9.5 : 8, motorway ? 2 : 0, 1);
      });
    });
  }

  // ---- pedestrian streets and plazas: post-top lamps
  for (const w of inp.pedestrianWays) {
    const pts: V3[] = w.pts.map((p) => [p[0], 0, p[1]] as V3);
    let side = 1;
    walkLine(pts, 20, 6, (x, _y, z, dx, dz) => {
      const off = w.width / 2 + 0.4;
      const lx = x - dz * side * off, lz = z + dx * side * off;
      side = -side;
      if (!inside(lx, lz) || fp.near(lx, lz, 0.7) || inp.roadMask.contains(lx, lz, -0.9) || lampSet.within(lx, lz, 10)) return;
      addLamp(lx, inp.ground(lx, lz) + 0.1, lz, 0, 4.5, 1, 1);
    });
  }
  for (const a of inp.areas) {
    if (a.kind !== 'plaza') continue;
    const ring = a.rings[0];
    const bb = ringBounds(ring);
    if ((bb.maxX - bb.minX) * (bb.maxZ - bb.minZ) < 600) continue;
    for (let x = Math.ceil(bb.minX / 22) * 22; x < bb.maxX; x += 22) {
      for (let z = Math.ceil(bb.minZ / 22) * 22; z < bb.maxZ; z += 22) {
        if (!inside(x, z) || !pointInRing(x, z, ring) || distToRings(x, z, [ring]) < 2 || fp.near(x, z, 1.5) || inp.roadMask.contains(x, z, -1) || lampSet.within(x, z, 14)) continue;
        addLamp(x, inp.ground(x, z) + 0.1, z, 0, 4.5, 1, 1);
      }
    }
  }

  // ---- synthetic street trees along the sidewalks
  const STREET = /^(primary|secondary|tertiary|unclassified|residential|living_street)$/;
  for (const road of inp.roads) {
    if (!STREET.test(road.class) || road.bridge) continue;
    const major = /^(primary|secondary)$/.test(road.class);
    const hw = road.width / 2;
    for (const side of [1, -1]) {
      const rand = rng(hash32(`street${road.points[0][0].toFixed(1)}${road.points[0][2].toFixed(1)}${side}`));
      walkLine(road.points, 13, rand() * 13, (x, _y, z, dx, dz) => {
        if (rand() >= (major ? 0.4 : 0.6)) return;
        const off = hw + 2.7 + rand() * 1.0;
        const jitter = (rand() - 0.5) * 4;
        const tx = x - dz * side * off + dx * jitter, tz = z + dx * side * off + dz * jitter;
        if (!inside(tx, tz) || inp.roadMask.contains(tx, tz, -1.8) || fp.near(tx, tz, 2) || lampSet.within(tx, tz, 3) || treeSet.within(tx, tz, 7) || inp.pathMask.contains(tx, tz, -0.5)) return;
        const p = rand();
        const cls = p < 0.62 ? TREE_CLASS.broadleaf : p < 0.93 ? TREE_CLASS.ornamental : TREE_CLASS.conifer;
        const s = treeSize(cls, rand);
        addTree(tx, tz, cls, s.h, s.r, 0);
      });
    }
  }

  // ---- parks and woodland: a jittered grid
  for (const a of inp.areas) {
    if (a.kind !== 'park' && a.kind !== 'forest' && a.kind !== 'cemetery') continue;
    const ring = a.rings[0];
    const bb = ringBounds(ring);
    const area = (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ);
    if (area < 250) continue;
    const forest = a.kind === 'forest';
    const grid = forest ? 6 : 10;
    const keepP = forest ? 1 : a.kind === 'cemetery' ? 0.35 : area < 1500 ? 0.45 : 0.8;
    const rand = rng(hash32(`park${bb.minX.toFixed(1)}${bb.minZ.toFixed(1)}`));
    for (let x = Math.ceil(bb.minX / grid) * grid; x < bb.maxX; x += grid) {
      for (let z = Math.ceil(bb.minZ / grid) * grid; z < bb.maxZ; z += grid) {
        if (rand() > keepP) continue;
        const jx = x + (rand() - 0.5) * grid * 0.8, jz = z + (rand() - 0.5) * grid * 0.8;
        if (!inside(jx, jz) || !pointInRing(jx, jz, ring)) continue;
        if (a.rings.slice(1).some((h) => pointInRing(jx, jz, h))) continue;
        if (inp.roadMask.contains(jx, jz, -2) || fp.near(jx, jz, 2.5) || inp.pathMask.contains(jx, jz, -2) || treeSet.within(jx, jz, grid * 0.45) || lampSet.within(jx, jz, 2.5)) continue;
        const p = rand();
        const cls = forest ? (p < 0.55 ? TREE_CLASS.broadleaf : TREE_CLASS.conifer) : p < 0.6 ? TREE_CLASS.broadleaf : p < 0.85 ? TREE_CLASS.conifer : TREE_CLASS.ornamental;
        const s = treeSize(cls, rand);
        addTree(jx, jz, cls, s.h, s.r, 3);
      }
    }
  }

  const byPos = (a: number[], b: number[]) => a[0] - b[0] || a[2] - b[2];
  trees.sort(byPos);
  lamps.sort(byPos);
  hydrants.sort(byPos);
  bins.sort(byPos);
  bollards.sort(byPos);
  return { version: 1, trees, lamps, hydrants, bins, bollards, stats };
}

function nearestRoadYaw(roads: PropsRoad[], x: number, z: number): number {
  let best = Infinity;
  let yaw = 0;
  for (const r of roads) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const l2 = dx * dx + dz * dz;
      if (l2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
      const px = a[0] + t * dx, pz = a[2] + t * dz;
      const d = Math.hypot(x - px, z - pz) - r.width / 2;
      if (d < best) { best = d; yaw = Math.atan2(px - x, pz - z); }
    }
  }
  return yaw;
}
