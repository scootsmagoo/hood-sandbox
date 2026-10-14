import type { V2, V3 } from '../geo.js';
import { pointInRing, ringBounds, type Rect } from '../geo.js';
import type { RoadJson } from './roads.js';
import type { RoadWay } from './osm.js';
import type { Heightmap } from './terrain.js';
import { surfaceHeight } from './terrain.js';

export interface Spawns {
  player: { x: number; y: number; z: number };
  vehicle: { x: number; y: number; z: number; heading: number };
}

/** three.js rotation.y of an object that faces -Z at heading 0. */
export function headingOf(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

const SPAWN_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);

function distToSegment(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

export interface SpawnInput {
  roads: RoadJson[];
  ways: RoadWay[];
  footprints: V2[][][];
  hm: Heightmap;
  bounds: Rect;
}

export function pickSpawns(inp: SpawnInput): Spawns {
  const { roads, ways, footprints, hm } = inp;
  const boxes = footprints.map((f) => ringBounds(f[0]));
  const inBuilding = (x: number, z: number, margin = 0) => {
    for (let i = 0; i < footprints.length; i++) {
      const b = boxes[i];
      if (x < b.minX - margin || x > b.maxX + margin || z < b.minZ - margin || z > b.maxZ + margin) continue;
      if (pointInRing(x, z, footprints[i][0])) return true;
    }
    return false;
  };

  const carSegs: { a: V2; b: V2; half: number }[] = [];
  for (const w of ways) {
    if (w.kind !== 'car' || w.bridge) continue;
    for (let i = 0; i + 1 < w.pts.length; i++) carSegs.push({ a: w.pts[i], b: w.pts[i + 1], half: w.width / 2 });
  }
  const roadClearance = (x: number, z: number) => {
    let m = Infinity;
    for (const s of carSegs) {
      const d = distToSegment([x, z], s.a, s.b) - s.half;
      if (d < m) m = d;
    }
    return m;
  };

  // vehicle: parked at the right-hand curb of the drivable surface street nearest the origin, clear of junctions
  let vbest: { x: number; y: number; z: number; fx: number; fz: number; half: number; d: number } | null = null;
  for (const r of roads) {
    if (r.bridge || !SPAWN_CLASSES.has(r.class)) continue;
    const pts = r.points;
    let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][2] - pts[i][2]);
    if (total < 30) continue;
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const l = Math.hypot(dx, dz);
      if (l === 0) continue;
      const n = Math.max(1, Math.ceil(l / 2));
      for (let k = 0; k <= n; k++) {
        const s = acc + (l * k) / n;
        if (s < 15 || total - s < 15) continue;
        const t = k / n;
        const x = a[0] + dx * t;
        const z = a[2] + dz * t;
        const d = Math.hypot(x, z);
        if (d > 250 || (vbest && d >= vbest.d)) continue;
        vbest = { x, y: a[1] + (b[1] - a[1]) * t, z, fx: dx / l, fz: dz / l, half: r.width / 2, d };
      }
      acc += l;
    }
  }
  let vehicle: Spawns['vehicle'];
  let curb: { x: number; z: number; rx: number; rz: number } | null = null;
  if (vbest) {
    const rx = -vbest.fz, rz = vbest.fx;
    const side = Math.max(0, vbest.half - 1.3);
    const vx = vbest.x + rx * side;
    const vz = vbest.z + rz * side;
    vehicle = { x: round(vx), y: round(vbest.y), z: round(vz), heading: Math.round(headingOf(vbest.fx, vbest.fz) * 1000) / 1000 };
    curb = { x: vbest.x + rx * (vbest.half + 1.5), z: vbest.z + rz * (vbest.half + 1.5), rx, rz };
  } else {
    vehicle = { x: 10, y: round(surfaceHeight(hm, 10, 0)), z: 0, heading: 0 };
  }

  // player: on foot, on the sidewalk-like point nearest the parked car, off the road and outside every building
  let best: { x: number; z: number; d: number } | null = null;
  for (const w of ways) {
    if (w.kind !== 'ped' || w.bridge || w.sub === 'crossing' || w.highway === 'steps') continue;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(l / 1));
      for (let k = 0; k <= n; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / n;
        const z = a[1] + ((b[1] - a[1]) * k) / n;
        const d = Math.hypot(x - vehicle.x, z - vehicle.z);
        if (d > 25 || (best && d >= best.d)) continue;
        if (inBuilding(x, z, 1) || roadClearance(x, z) < 0.5) continue;
        best = { x, z, d };
      }
    }
  }
  // no mapped sidewalk nearby: stand just past the curb beside the car
  if (!best && curb && !inBuilding(curb.x, curb.z, 0.5)) best = { x: curb.x, z: curb.z, d: 0 };
  const px = best ? best.x : vehicle.x + 4;
  const pz = best ? best.z : vehicle.z;
  const player = { x: round(px), y: round(surfaceHeight(hm, px, pz) + 0.1), z: round(pz) };
  return { player, vehicle };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export type { V3 };
