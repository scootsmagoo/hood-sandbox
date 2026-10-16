/**
 * The transit layer of a baked tile (docs/contracts/m1-tile-format.md, "transit.json"): the rail lines, the designed 3D tracks,
 * the routes trains run on (one per line and direction, cut at the tile's edge), the stations with their platforms, concourses,
 * entrances and fare lines, the spaces under the ground (where the ground is not solid and is not drawn), and the kit anchors
 * the client instances. Plain data and pure functions: the sim and the client both read it.
 */

export type TrackKind = 'tunnel' | 'trench' | 'grade' | 'elevated' | 'station';

export interface TransitLine {
  id: string;
  ref: string;
  name: string;
  /** '#rrggbb' */
  colour: string;
}

export interface TransitTrack {
  id: number;
  /** the OSM way it was made from */
  osm: number;
  /** rail-top centreline, flat x, y, z */
  pts: number[];
  /** structure runs: [first point index, kind] pairs, in order; a run lasts to the next one's first point */
  runs: [number, TrackKind][];
}

export interface TransitStop {
  /** index into `stations` */
  station: number;
  /** index into the station's `platforms` */
  platform: number;
  /** distance along the route where the head of the train stops, m */
  s: number;
  /** +1: the platform is on the train's left (looking along the route), -1 on its right */
  side: 1 | -1;
}

export interface TransitRoute {
  id: string;
  /** index into `lines` */
  line: number;
  /** the OSM route relation */
  osm: number;
  /** the terminus the route runs to (the whole line's, which may be far past the tile) */
  towards: string;
  /** rail-top centreline the head of a train follows, flat x, y, z; points about 4 m apart or closer */
  pts: number[];
  /** cumulative distance at each point, m */
  cum: number[];
  len: number;
  stops: TransitStop[];
  /** where the route comes in and goes out: the side of the tile it crosses ('n' | 'e' | 's' | 'w'), or null where it starts or ends inside the tile */
  enter: string | null;
  exit: string | null;
  /** speed limit, m/s: [s, v] breakpoints, the limit holds from s to the next breakpoint */
  speed: [number, number][];
  /** the route of the other direction of the same line (index into `routes`), or -1 */
  reverse: number;
}

/** An oriented box: centre, half sizes along its own axes, and the yaw of its local +Z axis (forward (sin yaw, cos yaw) in x, z). */
export interface Obb {
  c: [number, number, number];
  h: [number, number, number];
  yaw: number;
}

export interface TransitPlatform {
  kind: 'island' | 'side';
  /** the platform's walking surface */
  y: number;
  /** centre (x, z), unit axis along the tracks (x, z), half length along, half width across */
  c: [number, number];
  axis: [number, number];
  halfLen: number;
  halfWidth: number;
  /** OSM layer of the platform level */
  layer: number;
  /** routes that stop here (indices into `routes`) */
  routes: number[];
  /** where people wait: [x, y, z, yaw] */
  waits: [number, number, number, number][];
}

export interface TransitEntrance {
  /** the top of the stairs at street level, and the way down (yaw of the walking direction) */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** the foot of the stairs */
  foot: [number, number, number];
  osm: number;
}

export interface TransitStation {
  id: string;
  /** the real name (place names are fine) */
  name: string;
  /** what the game shows */
  displayName: string;
  osm: number;
  x: number;
  /** street level */
  y: number;
  z: number;
  underground: boolean;
  /** indices into `lines` */
  lines: number[];
  platforms: TransitPlatform[];
  /** the fare hall: centre (x, y floor, z), axis, half sizes; null for none */
  concourse: { c: [number, number, number]; axis: [number, number]; halfLen: number; halfWidth: number } | null;
  /** the paid area inside the concourse (the fare line is its edge): same shape */
  paid: { c: [number, number, number]; axis: [number, number]; halfLen: number; halfWidth: number } | null;
  entrances: TransitEntrance[];
  /** the gate gaps of the fare line: [x, z] of each gap's middle and the inward unit normal [nx, nz] */
  gates: [number, number, number, number][];
}

export interface TransitVolume extends Obb {
  /** 'interior': under the ground and roofed (the outdoor light does not reach it); 'open': under the ground level but open to the sky (a trench) */
  kind: 'interior' | 'open';
  /** the station it belongs to, or -1 (a tunnel) */
  station: number;
}

/** A kit part the client instances (tools/blender/transit station-kit.glb), and the sim makes solid where it says so. */
export interface TransitAnchor {
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** the station (index), or -1 */
  station: number;
  /** a platform index for screens and signs (which platform's trains they show), or -1 */
  platform: number;
}

export interface TransitTimetable {
  secondsPerMinute: number;
  headways: { from: string; to: string; minutes: number }[];
  dwellS: number;
  transferDwellS: number;
  cars: number;
  accel: number;
  brake: number;
  maxSpeed: number;
}

export interface TransitWalk {
  /** [x, y, z] */
  nodes: [number, number, number][];
  /** flat triples: a, b, kind (0 floor, 1 stairs, 2 fare gate, 3 platform edge to a door, 4 street link) */
  edges: number[];
}

export interface TransitData {
  format: 'hood-transit';
  version: 1;
  brand: string;
  brandShort: string;
  agency: string;
  lines: TransitLine[];
  tracks: TransitTrack[];
  routes: TransitRoute[];
  stations: TransitStation[];
  volumes: TransitVolume[];
  /** where the ground and the street meshes are not drawn (the stairwells of entrances): rectangles, [x, z, hx, hz, yaw] */
  holes: [number, number, number, number, number][];
  anchors: TransitAnchor[];
  walk: TransitWalk;
  timetable: TransitTimetable;
  /** the collision mesh (little-endian float32 positions, then uint32 indices) and the drawn mesh */
  collision: { file: string; vertexCount: number; indexCount: number } | null;
  mesh: string | null;
  stats: Record<string, unknown>;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads `transit.json`; null when it is not one (the tile then has no transit). */
export function parseTransit(json: unknown): TransitData | null {
  const j = json as Partial<TransitData> | null;
  if (!j || j.format !== 'hood-transit' || j.version !== 1) return null;
  if (!Array.isArray(j.routes) || !Array.isArray(j.stations) || !Array.isArray(j.lines)) return null;
  for (const r of j.routes) {
    if (!Array.isArray(r.pts) || r.pts.length < 6 || !r.pts.every(isNum)) return null;
    if (!Array.isArray(r.cum) || r.cum.length * 3 !== r.pts.length) return null;
  }
  return {
    format: 'hood-transit',
    version: 1,
    brand: j.brand ?? 'Transit',
    brandShort: j.brandShort ?? '',
    agency: j.agency ?? 'tap',
    lines: j.lines,
    tracks: j.tracks ?? [],
    routes: j.routes,
    stations: j.stations,
    volumes: j.volumes ?? [],
    holes: j.holes ?? [],
    anchors: j.anchors ?? [],
    walk: j.walk ?? { nodes: [], edges: [] },
    timetable: j.timetable ?? DEFAULT_TIMETABLE,
    collision: j.collision ?? null,
    mesh: j.mesh ?? null,
    stats: j.stats ?? {},
  };
}

export const DEFAULT_TIMETABLE: TransitTimetable = {
  secondsPerMinute: 20,
  headways: [{ from: '00:00', to: '24:00', minutes: 10 }],
  dwellS: 22,
  transferDwellS: 30,
  cars: 6,
  accel: 1,
  brake: 1.1,
  maxSpeed: 31.3,
};

/** Point, unit tangent and height along a route at distance s (clamped to the route). Writes into `out`; no allocation. */
export function routePoint(r: Pick<TransitRoute, 'pts' | 'cum' | 'len'>, s: number, out: RoutePoint): RoutePoint {
  const cum = r.cum;
  const n = cum.length;
  if (s <= 0) return seg(r, 0, 0, out);
  if (s >= r.len) return seg(r, n - 2, 1, out);
  // binary search for the segment
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const L = cum[lo + 1] - cum[lo];
  return seg(r, lo, L > 0 ? (s - cum[lo]) / L : 0, out);
}

export interface RoutePoint {
  x: number;
  y: number;
  z: number;
  /** unit direction in plan (x, z), and the grade (dy per metre along) */
  dx: number;
  dz: number;
  grade: number;
}

export const newRoutePoint = (): RoutePoint => ({ x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0 });

function seg(r: Pick<TransitRoute, 'pts' | 'cum'>, i: number, t: number, out: RoutePoint): RoutePoint {
  const p = r.pts;
  const a = i * 3, b = a + 3;
  const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
  out.x = p[a] + ex * t;
  out.y = p[a + 1] + ey * t;
  out.z = p[a + 2] + ez * t;
  const h = Math.hypot(ex, ez) || 1;
  out.dx = ex / h;
  out.dz = ez / h;
  out.grade = ey / h;
  return out;
}

/** The yaw of a direction in the (sin yaw, cos yaw) convention of peds and of `Obb.yaw`. */
export const yawOf = (dx: number, dz: number): number => Math.atan2(dx, dz);

/** Whether (x, y, z) is inside an oriented box. */
export function inObb(b: Obb, x: number, y: number, z: number, pad = 0): boolean {
  const dy = y - b.c[1];
  if (dy < -b.h[1] - pad || dy > b.h[1] + pad) return false;
  const dx = x - b.c[0], dz = z - b.c[2];
  const s = Math.sin(b.yaw), c = Math.cos(b.yaw);
  // local axes: +Z along (s, c), +X along (c, -s)
  const lz = dx * s + dz * c;
  const lx = dx * c - dz * s;
  return Math.abs(lx) <= b.h[0] + pad && Math.abs(lz) <= b.h[2] + pad;
}

/** A grid over the volumes of a tile for fast "am I inside the transit spaces" questions. */
export class VolumeIndex {
  private readonly cells = new Map<number, number[]>();
  private static readonly CELL = 32;

  constructor(readonly volumes: TransitVolume[]) {
    volumes.forEach((v, i) => {
      const r = Math.hypot(v.h[0], v.h[2]);
      const C = VolumeIndex.CELL;
      for (let cx = Math.floor((v.c[0] - r) / C); cx <= Math.floor((v.c[0] + r) / C); cx++) {
        for (let cz = Math.floor((v.c[2] - r) / C); cz <= Math.floor((v.c[2] + r) / C); cz++) {
          const k = key(cx, cz);
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(i);
        }
      }
    });
  }

  /** The first volume holding the point, or -1. */
  at(x: number, y: number, z: number, pad = 0): number {
    const C = VolumeIndex.CELL;
    const l = this.cells.get(key(Math.floor(x / C), Math.floor(z / C)));
    if (!l) return -1;
    for (const i of l) if (inObb(this.volumes[i], x, y, z, pad)) return i;
    return -1;
  }
}

const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

/** Parses 'HH:MM' into minutes since midnight. */
export const hhmm = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** The headway (timetable minutes) at a time of day (game minutes since midnight). */
export function headwayAt(tt: TransitTimetable, minutes: number): number {
  const m = ((minutes % 1440) + 1440) % 1440;
  for (const h of tt.headways) if (m >= hhmm(h.from) && m < hhmm(h.to)) return h.minutes;
  return tt.headways[0]?.minutes ?? 10;
}

/** '#rrggbb' as a number. */
export const colourNum = (c: string): number => parseInt(c.replace('#', ''), 16) || 0xffffff;

/** A point along a route at s, extrapolated past its ends along the end segments (cars still beyond the edge of the area). */
export function routePointExt(r: Pick<TransitRoute, 'pts' | 'cum' | 'len'>, s: number, out: RoutePoint): RoutePoint {
  routePoint(r, s, out);
  const e = s < 0 ? s : s > r.len ? s - r.len : 0;
  if (e !== 0) {
    out.x += out.dx * e;
    out.z += out.dz * e;
    out.y += out.grade * e;
  }
  return out;
}

/** Where a car stands: the rail under its middle, its direction along the route (from its two bogies) and its grade. */
export interface CarPose {
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  grade: number;
}

const cpA = newRoutePoint();
const cpB = newRoutePoint();

/** The pose of a car whose middle is at `mid` along the route, its bogies `bogie` m either side (the sim and the client both use this). */
export function carPoseAt(r: Pick<TransitRoute, 'pts' | 'cum' | 'len'>, mid: number, bogie: number, out: CarPose): CarPose {
  const a = routePointExt(r, mid + bogie, cpA);
  const b = routePointExt(r, mid - bogie, cpB);
  const dx = a.x - b.x, dz = a.z - b.z;
  const h = Math.hypot(dx, dz) || 1;
  out.x = (a.x + b.x) / 2;
  out.y = (a.y + b.y) / 2;
  out.z = (a.z + b.z) / 2;
  out.fx = dx / h;
  out.fz = dz / h;
  out.grade = (a.y - b.y) / h;
  return out;
}

/** The distance along the route of car k's middle, for a train whose head is at s. */
export const carMidAt = (s: number, k: number, length: number, gap: number) => s - length / 2 - k * (length + gap);
