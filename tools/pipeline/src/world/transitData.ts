/**
 * The transit layer, step 1: what OpenStreetMap says (transitFetch.ts), in game coordinates. Tracks (every subway way, tunnels and
 * bridges included), the route relations as ordered chains of nodes, stations, platforms, stop positions and entrances.
 * Nothing here is designed yet; transitProfile.ts gives the tracks their heights and transitStations.ts lays out the stations.
 */
import type { Projector, Rect, V2 } from '../geo.js';
import type { OsmData, OsmElement } from '../sources/osm.js';

export interface TransitPack {
  brand: string;
  brandShort: string;
  agency: string;
  box: [number, number, number, number];
  lines: { id: string; ref: string; name: string; colour: string }[];
  routes: { line: string; osm: number }[];
  stations: Record<string, { name?: string; depth?: Record<string, number>; concourse?: [number, number]; transfer?: boolean }>;
  defaults: { depthUnderground: number; depthElevated: number; concourse: [number, number]; minPlatformM: number; platformHeight: number; hallHeight: number };
  timetable: {
    secondsPerMinute: number;
    headways: { from: string; to: string; minutes: number }[];
    dwellS: number;
    transferDwellS: number;
    cars: number;
    accel: number;
    brake: number;
    maxSpeed: number;
  };
}

export interface RawTrack {
  id: number;
  nodes: number[];
  pts: V2[];
  tunnel: boolean;
  /** tunnel=building_passage: through a building, at the level of its neighbours */
  passage: boolean;
  bridge: boolean;
  cutting: boolean;
  layer: number;
  level: number;
  /** m/s, when tagged */
  maxspeed?: number;
  name: string;
}

export interface RawRoute {
  osm: number;
  line: string;
  name: string;
  from: string;
  to: string;
  /** the chain of OSM nodes the route runs over, in order, with their positions; `way[i]` is the way of the segment i -> i + 1 */
  nodes: number[];
  pts: V2[];
  way: number[];
  /** stop_position nodes, in route order */
  stops: number[];
}

export interface RawStation {
  osm: number;
  name: string;
  x: number;
  z: number;
}

export interface RawPlatform {
  osm: number;
  ring: V2[];
  layer: number;
  centroid: V2;
}

export interface RawPoint {
  osm: number;
  x: number;
  z: number;
  name: string;
}

export interface RawTransit {
  tracks: Map<number, RawTrack>;
  /** node id -> position */
  nodePos: Map<number, V2>;
  routes: RawRoute[];
  stations: RawStation[];
  platforms: RawPlatform[];
  stopPositions: Map<number, RawPoint>;
  entrances: RawPoint[];
}

const int = (v: string | undefined, d = 0) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

function mps(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h)?/i.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return (m[2]?.toLowerCase() === 'mph' ? n * 0.44704 : n / 3.6) || undefined;
}

/** The OSM elements of the network, in game coordinates. `routeTypes` are the relation `route` values kept (subway). */
export function parseTransitOsm(osm: OsmData, projector: Projector, pack: Pick<TransitPack, 'routes' | 'lines'>): RawTransit {
  const tracks = new Map<number, RawTrack>();
  const nodePos = new Map<number, V2>();
  const stations: RawStation[] = [];
  const platforms: RawPlatform[] = [];
  const stopPositions = new Map<number, RawPoint>();
  const entrances: RawPoint[] = [];
  const relations = new Map<number, OsmElement>();
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    if (e.type === 'relation') {
      relations.set(e.id, e);
      continue;
    }
    if (e.type === 'node') {
      if (e.lat === undefined || e.lon === undefined) continue;
      const [x, z] = projector.toGame(e.lon, e.lat);
      if (t.railway === 'subway_entrance' || t.railway === 'train_station_entrance') entrances.push({ osm: e.id, x, z, name: t.name ?? '' });
      else if (t.railway === 'station' && (t.station === 'subway' || t.subway === 'yes')) stations.push({ osm: e.id, name: t.name ?? '', x, z });
      else if (t.public_transport === 'stop_position' || t.railway === 'stop') stopPositions.set(e.id, { osm: e.id, x, z, name: t.name ?? '' });
      continue;
    }
    if (e.type !== 'way' || !e.geometry || !e.nodes) continue;
    const pts = e.geometry.map((g) => projector.toGame(g.lon, g.lat));
    if (t.railway === 'subway') {
      e.nodes.forEach((id, i) => nodePos.set(id, pts[i]));
      tracks.set(e.id, {
        id: e.id,
        nodes: e.nodes,
        pts,
        tunnel: !!t.tunnel && t.tunnel !== 'no',
        passage: t.tunnel === 'building_passage',
        bridge: !!t.bridge && t.bridge !== 'no',
        cutting: t.cutting === 'yes',
        layer: int(t.layer),
        level: int(t.level),
        maxspeed: mps(t.maxspeed),
        name: t.name ?? '',
      });
    } else if ((t.railway === 'platform' || t.public_transport === 'platform') && t.subway === 'yes') {
      const ring = pts.length > 1 && e.nodes[0] === e.nodes[e.nodes.length - 1] ? pts.slice(0, -1) : pts;
      const c: V2 = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
      platforms.push({ osm: e.id, ring, layer: int(t.layer), centroid: c });
    }
  }
  const routes: RawRoute[] = [];
  for (const spec of pack.routes) {
    const rel = relations.get(spec.osm);
    if (!rel) continue;
    const r = chainRoute(rel, tracks, spec.line);
    if (r) routes.push(r);
  }
  return { tracks, nodePos, routes, stations, platforms, stopPositions, entrances };
}

/** Orders a PTv2 route relation's ways into one chain of nodes (each way turned to run on from the last); the longest piece if it breaks. */
export function chainRoute(rel: OsmElement, tracks: Map<number, RawTrack>, line: string): RawRoute | null {
  const t = rel.tags ?? {};
  const ways = (rel.members ?? []).filter((m) => m.type === 'way' && (m.role === '' || m.role === 'forward' || m.role === 'backward')).map((m) => tracks.get(m.ref)).filter((w): w is RawTrack => !!w);
  const stops = (rel.members ?? []).filter((m) => m.type === 'node' && /^stop/.test(m.role)).map((m) => m.ref);
  if (ways.length === 0) return null;
  type Piece = { nodes: number[]; pts: V2[]; way: number[] };
  const pieces: Piece[] = [];
  let cur: Piece | null = null;
  for (let i = 0; i < ways.length; i++) {
    const w = ways[i];
    let nodes = w.nodes, pts = w.pts;
    if (!cur) {
      // orient the first way toward the second
      const nx = ways[i + 1];
      if (nx && (w.nodes[0] === nx.nodes[0] || w.nodes[0] === nx.nodes[nx.nodes.length - 1])) {
        nodes = [...nodes].reverse();
        pts = [...pts].reverse();
      }
      cur = { nodes: [...nodes], pts: [...pts], way: new Array(nodes.length - 1).fill(w.id) };
      pieces.push(cur);
      continue;
    }
    const end = cur.nodes[cur.nodes.length - 1];
    if (nodes[0] === end) {
      // runs on
    } else if (nodes[nodes.length - 1] === end) {
      nodes = [...nodes].reverse();
      pts = [...pts].reverse();
    } else {
      // a gap in the relation: a new piece
      cur = { nodes: [...nodes], pts: [...pts], way: new Array(nodes.length - 1).fill(w.id) };
      pieces.push(cur);
      continue;
    }
    for (let k = 1; k < nodes.length; k++) {
      cur.nodes.push(nodes[k]);
      cur.pts.push(pts[k]);
      cur.way.push(w.id);
    }
  }
  pieces.sort((a, b) => b.nodes.length - a.nodes.length);
  const p = pieces[0];
  return { osm: rel.id, line, name: t.name ?? '', from: t.from ?? '', to: t.to ?? '', nodes: p.nodes, pts: p.pts, way: p.way, stops };
}

/** The part of a polyline inside a rectangle that is longest, as [first segment index, t0] .. [last segment index, t1], or null. */
export function longestRunInside(pts: V2[], r: Rect): { i0: number; t0: number; i1: number; t1: number } | null {
  let best: { i0: number; t0: number; i1: number; t1: number; len: number } | null = null;
  let run: { i0: number; t0: number; len: number } | null = null;
  const inside = (p: V2) => p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minZ && p[1] <= r.maxZ;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = clipT(a, b, r);
    if (!seg) {
      if (run) run = null;
      continue;
    }
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) * (seg[1] - seg[0]);
    if (!run || seg[0] > 1e-9) run = { i0: i, t0: seg[0], len: 0 };
    run.len += L;
    if (!best || run.len > best.len) best = { i0: run.i0, t0: run.t0, i1: i, t1: seg[1], len: run.len };
    if (seg[1] < 1 - 1e-9 || !inside(b)) run = null;
  }
  return best ? { i0: best.i0, t0: best.t0, i1: best.i1, t1: best.t1 } : null;
}

/** Liang-Barsky parameters of a segment inside a rectangle. */
export function clipT(a: V2, b: V2, r: Rect): [number, number] | null {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minZ, r.maxZ - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

/** Which side of a rectangle a point on (or just past) its edge is: 'n' (min z), 's', 'e' (max x), 'w', or null when well inside. */
export function edgeSide(x: number, z: number, r: Rect, tol = 0.5): string | null {
  if (z <= r.minZ + tol) return 'n';
  if (z >= r.maxZ - tol) return 's';
  if (x >= r.maxX - tol) return 'e';
  if (x <= r.minX + tol) return 'w';
  return null;
}

/** Applies the city's parody names: a brand inside a station name is replaced (data/cities/<city>/brands.json). */
export function displayName(name: string, pack: TransitPack, brands: { real: string; parody: string }[]): string {
  const s = pack.stations[name];
  if (s?.name) return s.name;
  let out = name;
  for (const b of brands) {
    const real = b.real.replace(/\s*\(word\)\s*$/, '');
    if (real.length > 2 && out.includes(real)) out = out.split(real).join(b.parody);
  }
  return out;
}
