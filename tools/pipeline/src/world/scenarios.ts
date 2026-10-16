import type { Projector, Rect, V2 } from '../geo.js';
import { pointInRing, ringBounds } from '../geo.js';
import type { OsmData, OsmElement } from '../sources/osm.js';
import type { Area } from './osm.js';
import { BuildingIndex, distToSegment, type PathsFile } from './paths.js';
import type { RoadJson } from './roads.js';

/**
 * Scenario points (`scenarios.json`): places where a pedestrian stands about doing something, so the
 * sim can spawn people already sitting on a bench, waiting at a stop, at the ATM, queueing at a
 * counter or chatting on a corner. They come from OSM points and ways where the map has them
 * (benches, bus stops, ATMs, restaurants and shops, squares, artwork and fountains) and from
 * synthesised fill along the sidewalks (window-shoppers at building fronts, corners at signalised
 * crossings, park lawns), so the city never depends on how well a neighbourhood is mapped.
 */

export type ScenarioType = 'bench' | 'busstop' | 'atm' | 'shopfront' | 'eatery' | 'lawn' | 'plaza' | 'corner' | 'seat';

export interface ScenarioPoint {
  id: string;
  type: ScenarioType;
  x: number;
  y: number;
  z: number;
  /** the way people there face, as a ped's yaw: forward is (sin yaw, cos yaw) in (x, z) */
  yaw: number;
  /** how many people use it at once */
  cap: number;
  src: 'osm' | 'synth';
}

export interface ScenariosFile {
  version: 1;
  points: ScenarioPoint[];
  stats: { total: number; byType: Record<string, number>; osm: number; synth: number; poiData: boolean };
}

export interface ScenarioInput {
  /** the Overpass answer for the POI query, or null when it could not be fetched (everything is synthesised) */
  pois: OsmData | null;
  projector: Projector;
  paths: PathsFile;
  roads: RoadJson[];
  areas: Area[];
  footprints: V2[][][];
  bounds: Rect;
  ground: (x: number, z: number) => number;
  seed?: number;
}

const CAPACITY: Record<ScenarioType, number> = { bench: 2, busstop: 4, atm: 1, shopfront: 2, eatery: 3, lawn: 4, plaza: 5, corner: 3, seat: 2 };
const WALKABLE = new Set(['sidewalk', 'synthetic', 'pedestrian', 'footway']);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

/** A point (and optional centre of a way) of an Overpass element, in game coordinates. */
function positionOf(el: OsmElement, proj: Projector): V2 | null {
  if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) return proj.toGame(el.lon, el.lat);
  if (el.geometry && el.geometry.length) {
    let x = 0, z = 0;
    for (const g of el.geometry) { const p = proj.toGame(g.lon, g.lat); x += p[0]; z += p[1]; }
    return [x / el.geometry.length, z / el.geometry.length];
  }
  return null;
}

function classify(t: Record<string, string>): ScenarioType | null {
  const a = t.amenity;
  if (a === 'bench' || (t.bench === 'yes' && t.public_transport !== 'platform') || t.leisure === 'picnic_table') return 'bench';
  if (t.highway === 'bus_stop' || t.public_transport === 'platform') return 'busstop';
  if (a === 'atm' || t.atm === 'yes') return 'atm';
  if (a && /^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court)$/.test(a)) return 'eatery';
  if (a === 'fountain' || t.place === 'square' || (t.tourism && /^(artwork|information|attraction|viewpoint)$/.test(t.tourism))) return 'plaza';
  if (t.shop && t.shop !== 'vacant' && t.shop !== 'storage_rental') return 'shopfront';
  if (a && /^(pharmacy|bank|marketplace|vending_machine)$/.test(a)) return 'shopfront';
  if (t.tourism && /^(museum|gallery)$/.test(t.tourism)) return 'shopfront';
  return null;
}

export function buildScenarios(inp: ScenarioInput): ScenariosFile {
  const rnd = rng(inp.seed ?? 20261014);
  const b = inp.bounds;
  const inBounds = (x: number, z: number) => x > b.minX + 4 && x < b.maxX - 4 && z > b.minZ + 4 && z < b.maxZ - 4;
  const bIdx = new BuildingIndex(inp.footprints.map((f) => f[0]));

  // walkable segments of the network, for snapping
  const P = inp.paths;
  const segs: { ax: number; az: number; bx: number; bz: number; kind: string }[] = [];
  for (let i = 0; i < P.edges.length; i += 3) {
    const a = P.nodes[P.edges[i]], c = P.nodes[P.edges[i + 1]];
    segs.push({ ax: a[0], az: a[2], bx: c[0], bz: c[2], kind: P.attrs[P.edges[i + 2]].kind });
  }
  const cell = 16;
  const grid = new Map<number, number[]>();
  const gk = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  segs.forEach((s, i) => {
    for (let x = Math.floor(Math.min(s.ax, s.bx) / cell); x <= Math.floor(Math.max(s.ax, s.bx) / cell); x++) {
      for (let z = Math.floor(Math.min(s.az, s.bz) / cell); z <= Math.floor(Math.max(s.az, s.bz) / cell); z++) {
        const a = grid.get(gk(x, z));
        if (a) a.push(i); else grid.set(gk(x, z), [i]);
      }
    }
  });
  const nearestPath = (x: number, z: number, r: number, kinds: Set<string> | null = WALKABLE) => {
    let best: { d: number; x: number; z: number; dx: number; dz: number } | null = null;
    const seen = new Set<number>();
    for (let ix = Math.floor((x - r) / cell); ix <= Math.floor((x + r) / cell); ix++) {
      for (let iz = Math.floor((z - r) / cell); iz <= Math.floor((z + r) / cell); iz++) {
        for (const i of grid.get(gk(ix, iz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const s = segs[i];
          if (kinds && !kinds.has(s.kind)) continue;
          const q = distToSegment(x, z, s.ax, s.az, s.bx, s.bz);
          if (q.d <= r && (!best || q.d < best.d)) {
            const l = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1;
            best = { d: q.d, x: q.x, z: q.z, dx: (s.bx - s.ax) / l, dz: (s.bz - s.az) / l };
          }
        }
      }
    }
    return best;
  };
  const nearestRoadDir = (x: number, z: number): V2 | null => {
    let best = Infinity;
    let dir: V2 | null = null;
    for (const r of inp.roads) {
      if (r.bridge) continue;
      for (let i = 0; i + 1 < r.points.length; i++) {
        const q = distToSegment(x, z, r.points[i][0], r.points[i][2], r.points[i + 1][0], r.points[i + 1][2]);
        if (q.d < best && q.d < 30) { best = q.d; dir = [q.x - x, q.z - z]; }
      }
    }
    if (!dir) return null;
    const l = Math.hypot(dir[0], dir[1]);
    return l < 0.05 ? null : [dir[0] / l, dir[1] / l];
  };

  const points: ScenarioPoint[] = [];
  const near = (type: ScenarioType, x: number, z: number, r: number) => points.some((p) => p.type === type && Math.hypot(p.x - x, p.z - z) < r);
  const add = (type: ScenarioType, x: number, z: number, yaw: number, src: 'osm' | 'synth', cap = CAPACITY[type]) => {
    if (!inBounds(x, z)) return false;
    if (bIdx.signedDistance(x, z, 1) < 0.4) return false;
    points.push({ id: '', type, x: Math.round(x * 10) / 10, y: Math.round((inp.ground(x, z) + 0.05) * 100) / 100, z: Math.round(z * 10) / 10, yaw: Math.round(yaw * 100) / 100, cap, src });
    return true;
  };

  // OSM points and ways
  for (const el of inp.pois?.elements ?? []) {
    const t = el.tags ?? {};
    const type = classify(t);
    const pos = positionOf(el, inp.projector);
    if (!type || !pos || !inBounds(pos[0], pos[1])) continue;
    const [x, z] = pos;
    if (type === 'bench') {
      if (near('bench', x, z, 1.2)) continue;
      const p = nearestPath(x, z, 8, null);
      if (!p) continue;
      let yaw: number;
      const dir = parseFloat(t.direction ?? '');
      if (Number.isFinite(dir)) yaw = yawOf(Math.sin((dir * Math.PI) / 180), -Math.cos((dir * Math.PI) / 180));
      else if (p.d > 0.4) yaw = yawOf(p.x - x, p.z - z);
      else {
        const w = bIdx.nearest(x, z, 6);
        yaw = w ? yawOf(w.nx, w.nz) : rnd() * Math.PI * 2;
      }
      add('bench', x, z, yaw, 'osm', t.seats && Number(t.seats) >= 3 ? 3 : 2);
    } else if (type === 'busstop') {
      const p = nearestPath(x, z, 14);
      if (!p || near('busstop', p.x, p.z, 10)) continue;
      const road = nearestRoadDir(p.x, p.z);
      const yaw = p.d > 1 ? yawOf(x - p.x, z - p.z) : road ? yawOf(road[0], road[1]) : rnd() * Math.PI * 2;
      add('busstop', p.x, p.z, yaw, 'osm');
    } else if (type === 'atm') {
      const p = nearestPath(x, z, 16);
      if (!p || near('atm', p.x, p.z, 6)) continue;
      add('atm', p.x, p.z, yawOf(x - p.x, z - p.z), 'osm');
    } else if (type === 'eatery' || type === 'shopfront') {
      const p = nearestPath(x, z, 22);
      if (!p || near(type, p.x, p.z, type === 'eatery' ? 4 : 5)) continue;
      const dx = x - p.x, dz = z - p.z, l = Math.hypot(dx, dz) || 1;
      const k = Math.min(0.3, l * 0.5);
      add(type, p.x + (dx / l) * k, p.z + (dz / l) * k, yawOf(dx, dz), 'osm');
    } else if (type === 'plaza') {
      if (near('plaza', x, z, 8)) continue;
      const p = nearestPath(x, z, 8);
      add('plaza', p ? p.x : x, p ? p.z : z, rnd() * Math.PI * 2, 'osm');
    }
  }
  // squares: samples along pedestrian streets
  let acc = 0;
  for (const s of segs) {
    if (s.kind !== 'pedestrian') continue;
    const l = Math.hypot(s.bx - s.ax, s.bz - s.az);
    acc += l;
    if (acc >= 40) {
      acc = 0;
      const x = (s.ax + s.bx) / 2, z = (s.az + s.bz) / 2;
      if (!near('plaza', x, z, 20)) add('plaza', x, z, rnd() * Math.PI * 2, 'synth');
    }
  }

  // corners: where people stand waiting to cross a signalised street
  const ends = new Map<number, { x: number; z: number; dx: number; dz: number }>();
  for (let i = 0; i < P.edges.length; i += 3) {
    const at = P.attrs[P.edges[i + 2]];
    if (at.kind !== 'crossing' || !at.crossing?.signals) continue;
    const a = P.nodes[P.edges[i]], c = P.nodes[P.edges[i + 1]];
    const l = Math.hypot(c[0] - a[0], c[2] - a[2]) || 1;
    ends.set(P.edges[i], { x: a[0], z: a[2], dx: (c[0] - a[0]) / l, dz: (c[2] - a[2]) / l });
    ends.set(P.edges[i + 1], { x: c[0], z: c[2], dx: -(c[0] - a[0]) / l, dz: -(c[2] - a[2]) / l });
  }
  for (const e of ends.values()) {
    // the end of the crossing is at the curb: stand a little back, facing the road
    const x = e.x - e.dx * 1.0, z = e.z - e.dz * 1.0;
    if (near('corner', x, z, 5)) continue;
    add('corner', x, z, yawOf(e.dx, e.dz), 'synth');
  }

  // building fronts: window-shoppers and people waiting by a door
  let along = 0;
  const frontLimit = 700;
  let fronts = 0;
  for (const s of segs) {
    if (s.kind !== 'sidewalk' && s.kind !== 'synthetic' && s.kind !== 'pedestrian') continue;
    const l = Math.hypot(s.bx - s.ax, s.bz - s.az);
    const n = Math.max(1, Math.floor(l / 6));
    for (let k = 0; k < n; k++) {
      along += l / n;
      if (along < 16) continue;
      const t = (k + 0.5) / n;
      const x = s.ax + (s.bx - s.ax) * t, z = s.az + (s.bz - s.az) * t;
      const w = bIdx.nearest(x, z, 3.2);
      if (!w || w.d < 0.4) continue;
      along = 0;
      if (rnd() > 0.5 || fronts >= frontLimit) continue;
      if (near('shopfront', x, z, 7) || near('eatery', x, z, 5) || near('atm', x, z, 4)) continue;
      if (add('shopfront', x, z, yawOf(-w.nx, -w.nz), 'synth')) fronts++;
    }
  }

  // park lawns
  let lawns = 0;
  for (const a of inp.areas) {
    if (a.kind !== 'park') continue;
    const ring = a.rings[0];
    const bb = ringBounds(ring);
    if ((bb.maxX - bb.minX) * (bb.maxZ - bb.minZ) < 1500) continue;
    for (let x = Math.ceil(bb.minX / 17) * 17; x < bb.maxX; x += 17) {
      for (let z = Math.ceil(bb.minZ / 17) * 17; z < bb.maxZ; z += 17) {
        const jx = x + (rnd() - 0.5) * 8, jz = z + (rnd() - 0.5) * 8;
        if (lawns >= 260 || !pointInRing(jx, jz, ring)) continue;
        if (a.rings.slice(1).some((h) => pointInRing(jx, jz, h))) continue;
        const p = nearestPath(jx, jz, 3.5, null);
        if (p) continue;
        if (bIdx.signedDistance(jx, jz, 2) < 1.5) continue;
        // within reach of a walkway, or no one could have got there
        if (!nearestPath(jx, jz, 45)) continue;
        if (add('lawn', jx, jz, rnd() * Math.PI * 2, 'synth')) lawns++;
      }
    }
  }

  points.sort((p, q) => p.type.localeCompare(q.type) || p.x - q.x || p.z - q.z);
  points.forEach((p, i) => { p.id = `s${i}`; });
  const byType: Record<string, number> = {};
  for (const p of points) byType[p.type] = (byType[p.type] ?? 0) + 1;
  return {
    version: 1,
    points,
    stats: { total: points.length, byType, osm: points.filter((p) => p.src === 'osm').length, synth: points.filter((p) => p.src === 'synth').length, poiData: inp.pois !== null },
  };
}
