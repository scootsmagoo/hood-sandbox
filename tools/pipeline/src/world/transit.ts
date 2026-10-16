/**
 * The transit layer of a tile (docs/contracts/m1-tile-format.md, "transit.json"): the city's rail network from OpenStreetMap
 * (transitFetch.ts), its tracks designed in 3D (transitProfile.ts) and its stations laid out (transitStations.ts), cut to the
 * tile, as `transit.json` (lines, routes, stations, spaces under the ground, kit anchors, the stations' walk network),
 * `transit.glb` (transitMesh.ts) and `transit.bin` (collision). Roads are untouched: the subway was never in them.
 */
import type { Rect, V2 } from '../geo.js';
import type { OsmData } from '../sources/osm.js';
import type { Projector } from '../geo.js';
import type { MeshBuilder } from '../mesh/builder.js';
import { displayName, edgeSide, longestRunInside, parseTransitOsm, type RawRoute, type TransitPack } from './transitData.js';
import { buildTrackGraph, designProfile, PROFILE, type DesignKind, type TrackGraph } from './transitProfile.js';
import { holdAt, layoutStation, placePlatforms, planLevels, STATION, toLocal, toWorld, yawOfFrame, frameOf, type Frame, type LocalBox, type Ramp, type StationLayout, type StationPlan } from './transitStations.js';
import { bakeLight, box, COL, newMeshes, quad, railingSolid, rampY, room, ringOf, slabMinus, stairs, wall, type TransitMeshes } from './transitMesh.js';

/** Railcar numbers the layout needs (src/shared/data/railcar.json). */
export interface CarDims {
  length: number;
  gap: number;
}

export interface TransitInput {
  osm: OsmData;
  projector: Projector;
  bounds: Rect;
  ground: (x: number, z: number) => number;
  /** the road surface under (x, z) if a carriageway (on the ground or a deck) is there, else -Infinity */
  roadUnder: (x: number, z: number) => number;
  /** a carriageway on the ground at (x, z), `margin` m inside its edge (negative: that far outside) */
  onRoad: (x: number, z: number, margin: number) => boolean;
  inBuilding: (x: number, z: number) => boolean;
  obstacles: V2[];
  pack: TransitPack;
  brands: { real: string; parody: string }[];
  car: CarDims;
}

type Out = import('../../../../src/shared/transit.js').TransitData;
type OutRoute = Out['routes'][number];
type OutStation = Out['stations'][number];
type OutAnchor = Out['anchors'][number];
type OutVolume = Out['volumes'][number];

export interface TransitResult {
  file: Out;
  meshes: TransitMeshes;
  stats: Record<string, unknown>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Trims a route's chain to the segments that pass through a box (its longest run inside). */
function trimRoute(r: RawRoute, box: Rect): RawRoute | null {
  const run = longestRunInside(r.pts, box);
  if (!run) return null;
  const i0 = run.i0, i1 = run.i1 + 1;
  return { ...r, nodes: r.nodes.slice(i0, i1 + 1), pts: r.pts.slice(i0, i1 + 1), way: r.way.slice(i0, i1), stops: r.stops };
}

/** The designed 3D chain of a route, point by point (graph vertices in order), with the OSM way of each point's segment. */
function designedChain(g: TrackGraph, r: RawRoute): { pts: [number, number, number][]; way: number[] } {
  const pts: [number, number, number][] = [];
  const way: number[] = [];
  const step = PROFILE.step;
  for (let i = 0; i + 1 < r.nodes.length; i++) {
    const a = r.nodes[i], b = r.nodes[i + 1];
    const ia = g.index.get(`n${a}`), ib = g.index.get(`n${b}`);
    if (ia === undefined || ib === undefined) continue;
    const pa = r.pts[i], pb = r.pts[i + 1];
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const n = Math.max(1, Math.ceil(L / step));
    const ids = [ia];
    for (let k = 1; k < n; k++) {
      const key = a < b ? `${a}:${b}:${k}` : `${b}:${a}:${n - k}`;
      const vi = g.index.get(key);
      if (vi !== undefined) ids.push(vi);
    }
    ids.push(ib);
    for (const vi of ids) {
      const v = g.verts[vi];
      const last = pts[pts.length - 1];
      if (last && Math.abs(last[0] - v.x) < 1e-6 && Math.abs(last[2] - v.z) < 1e-6) continue;
      pts.push([v.x, v.y, v.z]);
      way.push(r.way[i]);
    }
  }
  return { pts, way };
}

/** Cuts a 3D polyline to a rectangle (its longest run inside), interpolating the ends; keeps a per-point value. */
function clip3(pts: [number, number, number][], vals: number[], b: Rect): { pts: [number, number, number][]; vals: number[]; cutStart: boolean; cutEnd: boolean } | null {
  const run = longestRunInside(pts.map((p) => [p[0], p[2]] as V2), b);
  if (!run) return null;
  const lerp = (i: number, t: number): [number, number, number] => {
    const a = pts[i], c = pts[i + 1];
    return [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
  };
  const out: [number, number, number][] = [lerp(run.i0, run.t0)];
  const ov: number[] = [vals[run.i0]];
  for (let i = run.i0 + 1; i <= run.i1; i++) {
    out.push(pts[i]);
    ov.push(vals[i]);
  }
  out.push(lerp(run.i1, run.t1));
  ov.push(vals[run.i1]);
  return { pts: out, vals: ov, cutStart: run.i0 > 0 || run.t0 > 1e-6, cutEnd: run.i1 < pts.length - 2 || run.t1 < 1 - 1e-6 };
}

/** Subdivides a 3D polyline so no segment is longer than `max`. */
function densify(pts: [number, number, number][], vals: number[], max: number): { pts: [number, number, number][]; vals: number[] } {
  const out: [number, number, number][] = [];
  const ov: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(L / max));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      ov.push(vals[i]);
    }
  }
  out.push(pts[pts.length - 1]);
  ov.push(vals[vals.length - 1]);
  return { pts: out, vals: ov };
}

/** Distance along a polyline of the point nearest (x, z), with the point's index and its side test helpers. */
function project(pts: [number, number, number][], cum: number[], x: number, z: number): { s: number; i: number; d: number; dir: V2 } {
  let best = { s: 0, i: 0, d: Infinity, dir: [0, 1] as V2 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const l2 = dx * dx + dz * dz;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
    const d = Math.hypot(x - (a[0] + dx * t), z - (a[2] + dz * t));
    if (d < best.d) {
      const l = Math.sqrt(l2);
      best = { s: cum[i] + l * t, i, d, dir: [dx / l, dz / l] };
    }
  }
  return best;
}

interface Strand {
  pts: [number, number, number][];
  kind: (DesignKind | 'station' | 'elevated-station')[];
  ground: number[];
}

/** The physical tracks: chains of the designed graph between switches and ends, cut to the tile. */
function strands(g: TrackGraph, halls: { box: LocalBox; elevated: boolean; rail: number }[], b: Rect): Strand[] {
  const deg = g.adj.map((a) => a.length);
  const usedE = new Set<number>();
  const out: Strand[] = [];
  const startAt = (v0: number) => {
    for (const e0 of g.adj[v0]) {
      if (usedE.has(e0)) continue;
      const chain = [v0];
      let e = e0, v = v0;
      for (;;) {
        usedE.add(e);
        const [a, c] = g.edges[e];
        const w = a === v ? c : a;
        chain.push(w);
        v = w;
        if (deg[v] !== 2) break;
        const next = g.adj[v].find((x) => !usedE.has(x));
        if (next === undefined) break;
        e = next;
      }
      const P = chain.map((i) => [g.verts[i].x, g.verts[i].y, g.verts[i].z] as [number, number, number]);
      const kinds = chain.map((i) => {
        const vx = g.verts[i];
        for (const h of halls) {
          const [u, vv] = toLocal(h.box.frame, vx.x, vx.z);
          if (u >= h.box.u0 - 0.5 && u <= h.box.u1 + 0.5 && vv >= h.box.v0 - 0.5 && vv <= h.box.v1 + 0.5 && Math.abs(vx.y - h.rail) < 1.2) return h.elevated ? 2000 : 1000;
        }
        return ['tunnel', 'trench', 'grade', 'elevated'].indexOf(vx.kind);
      });
      const c = clip3(P, kinds, b);
      if (!c || c.pts.length < 2) continue;
      const dn = densify(c.pts, c.vals, 6);
      const names = ['tunnel', 'trench', 'grade', 'elevated'] as const;
      out.push({ pts: dn.pts, kind: dn.vals.map((k) => (k === 1000 ? 'station' : k === 2000 ? 'elevated-station' : names[k])), ground: [] });
    }
  };
  // chains from the ends and switches first, then any loop left
  g.verts.forEach((_, i) => {
    if (deg[i] !== 2) startAt(i);
  });
  g.verts.forEach((_, i) => startAt(i));
  return out;
}

/** For each strand point: the nearest parallel track at about the same height beside it, left (+) and right (-), m across. */
function twins(st: Strand[]): { left: number[]; right: number[] }[] {
  const cell = 10;
  const grid = new Map<string, [number, number][]>();
  st.forEach((s, si) => s.pts.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[2] / cell)}`;
    const a = grid.get(k);
    if (a) a.push([si, i]);
    else grid.set(k, [[si, i]]);
  }));
  const dirOf = (s: Strand, i: number): V2 => {
    const a = s.pts[Math.max(0, i - 1)], b = s.pts[Math.min(s.pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    return [(b[0] - a[0]) / l, (b[2] - a[2]) / l];
  };
  return st.map((s, si) => {
    const left: number[] = [], right: number[] = [];
    s.pts.forEach((p, i) => {
      const d = dirOf(s, i);
      const lv: V2 = [d[1], -d[0]];
      let bl = Infinity, br = -Infinity;
      const cx = Math.floor(p[0] / cell), cz = Math.floor(p[2] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        for (const [sj, j] of grid.get(`${gx},${gz}`) ?? []) {
          if (sj === si) continue;
          const q = st[sj].pts[j];
          if (Math.abs(q[1] - p[1]) > 1.8) continue;
          const dq = dirOf(st[sj], j);
          if (Math.abs(dq[0] * d[0] + dq[1] * d[1]) < 0.9) continue;
          const dx = q[0] - p[0], dz = q[2] - p[2];
          const along = dx * d[0] + dz * d[1];
          if (Math.abs(along) > 4) continue;
          const across = dx * lv[0] + dz * lv[1];
          if (across > 0.5 && across < 9 && across < bl) bl = across;
          if (across < -0.5 && across > -9 && across > br) br = across;
        }
      }
      left.push(bl);
      right.push(br);
    });
    return { left, right };
  });
}

/** The narrowest island platform the layout keeps, m: a busy island is 8 to 10 m in the real system. */
const ISLAND_MIN = 9.0;

/**
 * Parts the two tracks of a narrow island: every vertex of a track that runs along the level, within the hall and a 90 m ramp past
 * it, moves out across by half the shortfall (eased to nothing over the ramp). Returns how many vertices moved.
 */
function widenIslands(plans: StationPlan[], g: TrackGraph, minW: number): number {
  let moved = 0;
  const dirOf = (i: number): V2 => {
    const nb = g.adj[i].map((e) => (g.edges[e][0] === i ? g.edges[e][1] : g.edges[e][0]));
    if (nb.length === 0) return [0, 0];
    const a = g.verts[nb[0]], c = g.verts[nb[nb.length - 1]];
    const l = Math.hypot(c.x - a.x, c.z - a.z) || 1;
    return [(c.x - a.x) / l, (c.z - a.z) / l];
  };
  for (const st of plans) for (const l of st.levels) for (const p of l.platforms) {
    if (p.kind !== 'island' || p.u1 - p.u0 >= minW) continue;
    const delta = (minW - (p.u1 - p.u0)) / 2;
    const uMid = (p.u0 + p.u1) / 2;
    const hallHalf = l.halfLen + STATION.hallPastPlatform;
    const ramp = 90;
    const shift: [number, number, number][] = [];
    g.verts.forEach((v, i) => {
      const [u, vv] = toLocal(l.frame, v.x, v.z);
      if (Math.abs(u - uMid) > 9) return;
      const av = Math.abs(vv);
      if (av > hallHalf + ramp || Math.abs(v.y - l.rail) > 5) return;
      const d = dirOf(i);
      if (Math.abs(d[0] * l.frame.a[0] + d[1] * l.frame.a[1]) < 0.9) return;
      const w = av <= hallHalf ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (av - hallHalf)) / ramp);
      const side = u < uMid ? -1 : 1;
      shift.push([i, l.frame.n[0] * side * delta * w, l.frame.n[1] * side * delta * w]);
    });
    for (const [i, dx, dz] of shift) {
      g.verts[i].x += dx;
      g.verts[i].z += dz;
      moved++;
    }
  }
  return moved;
}

/** Builds the tile's transit layer. */
export function buildTransit(inp: TransitInput): TransitResult | null {
  const { pack, bounds: b } = inp;
  const raw = parseTransitOsm(inp.osm, inp.projector, pack);
  const M = 420;
  const design: Rect = { minX: b.minX - M, minZ: b.minZ - M, maxX: b.maxX + M, maxZ: b.maxZ + M };
  const routes = raw.routes.map((r) => trimRoute(r, design)).filter((r): r is RawRoute => !!r && longestRunInside(r.pts, b) !== null);
  if (routes.length === 0) return null;
  const nameOf = (n: string) => displayName(n, pack, inp.brands);
  const plans = planLevels({ stations: raw.stations, platforms: raw.platforms, entrances: raw.entrances, routes, pack, bounds: b, ground: inp.ground, roadUnder: inp.roadUnder, displayName: nameOf });
  const inDesign = (x: number, z: number) => x >= design.minX && x <= design.maxX && z >= design.minZ && z <= design.maxZ;
  const g = buildTrackGraph({ routes, tracks: raw.tracks, ground: inp.ground, roadUnder: inp.roadUnder, hold: (x, z, w) => holdAt(plans, x, z, w), keep: inDesign });
  const prof = designProfile(g, { roadUnder: inp.roadUnder });
  let chains = routes.map((r) => designedChain(g, r));
  placePlatforms(plans, chains.map((c) => c.pts.map((p) => [p[0], p[2]] as V2)), chains.map((c) => c.way));
  // an island the map draws too narrow for people (the tracks drawn close together) is widened: the two tracks part through the station
  if (widenIslands(plans, g, ISLAND_MIN) > 0) {
    chains = routes.map((r) => designedChain(g, r));
    placePlatforms(plans, chains.map((c) => c.pts.map((p) => [p[0], p[2]] as V2)), chains.map((c) => c.way));
  }
  const layoutIn = { inBuilding: inp.inBuilding, onRoad: inp.onRoad, obstacles: inp.obstacles, ground: inp.ground, bounds: b, hallHeight: pack.defaults.hallHeight };
  const layouts: StationLayout[] = [];
  for (const st of plans) {
    const lay = layoutStation(st, layoutIn);
    layouts.push(lay);
    // a layout's later entrances must keep clear of its earlier ones' wells (layoutStation does), and of other stations'
    for (const s of lay.stairs) layoutIn.obstacles.push([s.top[0], s.top[2]]);
  }

  // ---- routes, cut to the tile ----
  const trainLen = pack.timetable.cars * inp.car.length + (pack.timetable.cars - 1) * inp.car.gap;
  const lineIdx = new Map(pack.lines.map((l, i) => [l.id, i]));
  const outRoutes: OutRoute[] = [];
  const routeMap = new Map<number, number>();
  routes.forEach((r, ri) => {
    const ch = chains[ri];
    const wayIdx = ch.way.map((w) => w);
    const c = clip3(ch.pts, wayIdx, b);
    if (!c) return;
    const dn = densify(c.pts, c.vals, 3);
    const pts = dn.pts;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    const len = cum[cum.length - 1];
    if (len < 50) return;
    // speed: the posted limit of the way, and what 0.9 m/s2 sideways allows on a curve
    const speedPts: number[] = pts.map((p, i) => {
      const t = raw.tracks.get(dn.vals[i]);
      let v = Math.min(pack.timetable.maxSpeed, t?.maxspeed ?? pack.timetable.maxSpeed);
      const a = pts[Math.max(0, i - 4)], cc = pts[Math.min(pts.length - 1, i + 4)];
      const ax = p[0] - a[0], az = p[2] - a[2], bx = cc[0] - p[0], bz = cc[2] - p[2];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la > 1 && lb > 1) {
        const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
        const R = turn > 1e-4 ? (la + lb) / 2 / turn : Infinity;
        v = Math.min(v, Math.sqrt(0.9 * R));
      }
      return Math.max(8, v);
    });
    const speed: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const v = Math.round(speedPts[i] * 2) / 2;
      if (!speed.length || Math.abs(speed[speed.length - 1][1] - v) >= 1) speed.push([r2(cum[i]), v]);
    }
    routeMap.set(ri, outRoutes.length);
    outRoutes.push({
      id: `${r.line}-${outRoutes.filter((q) => q.line === lineIdx.get(r.line)).length}`,
      line: lineIdx.get(r.line) ?? 0,
      osm: r.osm,
      towards: nameOf(r.to),
      pts: pts.flatMap((p) => [r2(p[0]), r2(p[1]), r2(p[2])]),
      cum: cum.map(r2),
      len: r2(len),
      stops: [],
      enter: c.cutStart ? edgeSide(pts[0][0], pts[0][2], b, 1) : null,
      exit: c.cutEnd ? edgeSide(pts[pts.length - 1][0], pts[pts.length - 1][2], b, 1) : null,
      speed,
      reverse: -1,
    });
  });
  // the other direction of the same line
  outRoutes.forEach((r, i) => {
    r.reverse = outRoutes.findIndex((q, j) => j !== i && q.line === r.line);
  });

  // ---- stations ----
  const meshes = newMeshes();
  const anchors: OutAnchor[] = [];
  const volumes: OutVolume[] = [];
  const holes: [number, number, number, number, number][] = [];
  const walkNodes: [number, number, number][] = [];
  const walkEdges: number[] = [];
  const lamps: { x: number; y: number; z: number; k: number }[] = [];
  const outStations: OutStation[] = [];
  const node = (x: number, y: number, z: number) => {
    walkNodes.push([r2(x), r2(y), r2(z)]);
    return walkNodes.length - 1;
  };
  const edge = (a: number, c: number, kind: number) => walkEdges.push(a, c, kind);
  const obb = (bx: LocalBox, kind: 'interior' | 'open', station: number): OutVolume => {
    const [cx, cz] = toWorld(bx.frame, (bx.u0 + bx.u1) / 2, (bx.v0 + bx.v1) / 2);
    return { c: [r2(cx), r2((bx.y0 + bx.y1) / 2), r2(cz)], h: [r2((bx.u1 - bx.u0) / 2), r2((bx.y1 - bx.y0) / 2), r2((bx.v1 - bx.v0) / 2)], yaw: r3(yawOfFrame(bx.frame)), kind, station };
  };
  const rampVolumes = (r: Ramp, head: number, station: number, topExtra = 0) => {
    const dir = Math.sign(r.v1 - r.v0);
    const L = Math.abs(r.v1 - r.v0);
    const n = Math.max(1, Math.ceil(L / 3));
    for (let k = 0; k < n; k++) {
      const va = r.v0 + (dir * L * k) / n, vb = r.v0 + (dir * L * (k + 1)) / n;
      const ya = rampY(r, va), yb = rampY(r, vb);
      volumes.push(obb({ frame: r.frame, u0: r.u0 - 0.3, u1: r.u1 + 0.3, v0: Math.min(va, vb), v1: Math.max(va, vb), y0: Math.min(ya, yb) - 0.6, y1: Math.max(ya, yb) + head + (k === 0 ? topExtra : 0) }, 'interior', station));
    }
  };
  const anchor = (kind: string, x: number, y: number, z: number, yaw: number, station: number, platform = -1) => anchors.push({ kind, x: r2(x), y: r2(y), z: r2(z), yaw: r3(yaw), station, platform });
  const H = pack.defaults.hallHeight;

  layouts.forEach((lay, si) => {
    const st = lay.plan;
    const platforms: OutStation['platforms'] = [];
    const levelPlatformBase: number[] = [];
    const routeIdx = new Set<number>();
    st.levels.forEach((l) => {
      levelPlatformBase.push(platforms.length);
      for (const p of l.platforms) {
        const c = toWorld(l.frame, (p.u0 + p.u1) / 2, 0);
        const rs = p.routes.map((ri) => routeMap.get(ri)).filter((x): x is number => x !== undefined);
        rs.forEach((x) => routeIdx.add(x));
        platforms.push({ kind: p.kind, y: r2(l.platformTop), c: [r2(c[0]), r2(c[1])], axis: [r3(l.frame.a[0]), r3(l.frame.a[1])], halfLen: r2(l.halfLen), halfWidth: r2((p.u1 - p.u0) / 2), layer: l.layer, routes: rs, waits: [] });
      }
    });
    const lines = [...new Set([...routeIdx].map((ri) => outRoutes[ri].line))].sort((p, q) => p - q);
    const conc = lay.concourse;
    const center = (bx: LocalBox) => {
      const [x, z] = toWorld(bx.frame, (bx.u0 + bx.u1) / 2, (bx.v0 + bx.v1) / 2);
      return { c: [r2(x), r2(bx.y0), r2(z)] as [number, number, number], axis: [r3(bx.frame.a[0]), r3(bx.frame.a[1])] as [number, number], halfLen: r2((bx.v1 - bx.v0) / 2), halfWidth: r2((bx.u1 - bx.u0) / 2) };
    };
    const station: OutStation = {
      id: st.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: st.name,
      displayName: st.displayName,
      osm: st.raw.osm,
      x: r2(st.raw.x),
      y: r2(st.street),
      z: r2(st.raw.z),
      underground: st.underground,
      lines,
      platforms,
      concourse: conc ? center(conc) : null,
      paid: lay.paid ? center(lay.paid) : null,
      entrances: lay.stairs.map((s) => ({ x: r2(s.top[0]), y: r2(s.top[1]), z: r2(s.top[2]), yaw: r3(s.yaw), foot: [r2(s.foot[0]), r2(s.foot[1]), r2(s.foot[2])], osm: s.entrance.osm })),
      gates: lay.gates.map((gt) => {
        const [x, z] = toWorld(gt.frame, gt.u, gt.v);
        return [r2(x), r2(z), r3(gt.inward[0]), r3(gt.inward[1])];
      }),
    };
    outStations.push(station);
    buildStationGeometry(lay, si, meshes, { anchor, volumes, obb, rampVolumes, holes, lamps, H, ground: inp.ground, node, edge, platforms, levelPlatformBase, nodes: walkNodes });
  });

  // ---- stops ----
  outRoutes.forEach((r, ri) => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < r.pts.length; i += 3) pts.push([r.pts[i], r.pts[i + 1], r.pts[i + 2]]);
    outStations.forEach((st, si) => {
      st.platforms.forEach((p, pi) => {
        if (!p.routes.includes(ri)) return;
        const q = project(pts, r.cum, p.c[0], p.c[1]);
        if (q.d > 14) return;
        const head = q.s + trainLen / 2;
        if (head > r.len - 1 || q.s - trainLen / 2 < 0) {
          // the platform is cut by the tile's edge: a train cannot stand at it whole; still stop if the head fits
          if (head > r.len - 1) return;
        }
        // which side: the platform's centre against the track (left = (dz, -dx))
        const lx = q.dir[1], lz = -q.dir[0];
        const side: 1 | -1 = (p.c[0] - pts[q.i][0]) * lx + (p.c[1] - pts[q.i][2]) * lz > 0 ? 1 : -1;
        r.stops.push({ station: si, platform: pi, s: r2(head), side });
      });
    });
    r.stops.sort((p, q) => p.s - q.s);
  });

  // ---- tracks: tunnels, trenches, viaducts, rails ----
  const hallBoxes: { box: LocalBox; elevated: boolean; rail: number }[] = [];
  layouts.forEach((lay) => lay.plan.levels.forEach((l, li) => hallBoxes.push({ box: lay.halls[li], elevated: l.elevated, rail: l.rail })));
  const strandList = strands(g, hallBoxes, b);
  const tw = twins(strandList);
  const trackStats = { tunnelM: 0, trenchM: 0, gradeM: 0, elevatedM: 0, stationM: 0, piers: 0 };
  strandList.forEach((s, si) => {
    s.ground = s.pts.map((p) => inp.ground(p[0], p[2]));
    buildStrand(s, tw[si], meshes, { anchor, volumes, lamps, onRoad: inp.onRoad, inBuilding: inp.inBuilding, stats: trackStats, strandIndex: si });
  });

  bakeLight(meshes.int, lamps);
  const file: Out = {
    format: 'hood-transit',
    version: 1,
    brand: pack.brand,
    brandShort: pack.brandShort,
    agency: pack.agency,
    lines: pack.lines.map((l) => ({ id: l.id, ref: l.ref, name: l.name, colour: l.colour })),
    tracks: strandList.map((s, i) => {
      const runs: [number, Out['tracks'][number]['runs'][number][1]][] = [];
      s.kind.forEach((k, j) => {
        const kk = k === 'elevated-station' ? 'station' : k;
        if (!runs.length || runs[runs.length - 1][1] !== kk) runs.push([j, kk]);
      });
      return { id: i, osm: 0, pts: s.pts.flatMap((p) => [r2(p[0]), r2(p[1]), r2(p[2])]), runs };
    }),
    routes: outRoutes,
    stations: outStations,
    volumes,
    holes,
    anchors,
    walk: { nodes: walkNodes, edges: walkEdges },
    timetable: pack.timetable,
    collision: null,
    mesh: null,
    stats: {},
  };
  const stats = {
    routes: outRoutes.length,
    stations: outStations.map((s, i) => `${s.displayName} (${s.platforms.map((p) => `${p.kind} ${(2 * p.halfWidth).toFixed(1)} m wide at ${p.y.toFixed(1)}`).join(', ')}; tracks ${layouts[i].plan.levels.map((l) => l.tracks.map((t) => t.u.toFixed(1)).join('/')).join(' | ')}; street ${s.y.toFixed(1)}; concourse ${s.concourse ? s.concourse.c[1].toFixed(1) : '-'}; ${s.entrances.length} of ${layouts[i].plan.entrances.length} entrances, ${layouts[i].shafts.length} shafts, ${s.gates.length} gates)`),
    profile: { maxGrade: r3(prof.maxGrade), coverShortM: r2(prof.coverShort), clearShortM: r2(prof.clearShort), held: prof.held, worstAt: prof.worst.map(r2), coverAt: prof.coverAt.map(r2), clearAt: prof.clearAt.map(r2) },
    tracks: Object.fromEntries(Object.entries(trackStats).map(([k, v]) => [k, Math.round(v)])),
    volumes: volumes.length,
    anchors: anchors.length,
    walk: { nodes: walkNodes.length, edges: walkEdges.length / 3 },
    triangles: { int: meshes.int.triangleCount, ext: meshes.ext.triangleCount, collision: meshes.col.triangleCount },
  };
  file.stats = stats;
  return { file, meshes, stats };
}

interface Ctx {
  anchor: (kind: string, x: number, y: number, z: number, yaw: number, station: number, platform?: number) => void;
  volumes: OutVolume[];
  obb: (bx: LocalBox, kind: 'interior' | 'open', station: number) => OutVolume;
  rampVolumes: (r: Ramp, head: number, station: number, topExtra?: number) => void;
  holes: [number, number, number, number, number][];
  lamps: { x: number; y: number; z: number; k: number }[];
  H: number;
  ground: (x: number, z: number) => number;
  node: (x: number, y: number, z: number) => number;
  edge: (a: number, b: number, kind: number) => void;
  platforms: OutStation['platforms'];
  levelPlatformBase: number[];
  nodes: [number, number, number][];
}

/** Halls, platforms, the concourse, the shafts, the entrances: drawn, solid, the spaces, the furniture and the walk network. */
function buildStationGeometry(lay: StationLayout, si: number, m: TransitMeshes, ctx: Ctx): void {
  const st = lay.plan;
  const H = ctx.H;
  const hallWalk: number[][] = [];
  st.levels.forEach((l, li) => {
    const hall = lay.halls[li];
    const f = l.frame;
    const bed = l.rail - 0.25;
    const target = l.elevated ? m.ext : m.int;
    const pBase = ctx.levelPlatformBase[li];
    const holesHere = lay.ceilingHoles.filter((h) => h.hall === li).map((h) => ringOf(h.box));
    // the shafts that land on this level (their footprint on the platform keeps the furniture away)
    // (an elevated island's stair comes up through its deck the same way a shaft comes down onto an underground one)
    const landing: { ramp: Ramp }[] = [...lay.shafts.filter((s) => s.level === li), ...lay.stairs.filter((s) => s.ramp.frame === f && l.platforms.some((p) => s.ramp.u0 >= p.u0 - 0.01 && s.ramp.u1 <= p.u1 + 0.01))];
    const nearShaft = (u: number, v: number, pad: number) => landing.some((s) => {
      const r = s.ramp;
      const [x, z] = toWorld(f, u, v);
      const [su, sv] = toLocal(r.frame, x, z);
      return su > r.u0 - pad && su < r.u1 + pad && sv > Math.min(r.v0, r.v1) - pad - 3 && sv < Math.max(r.v0, r.v1) + pad + 3;
    });
    if (!l.elevated) {
      // the track bed, the platforms, the walls, the coffered ceiling
      const floorRing = ringOf(hall);
      slabMinus(m.int, m.col, floorRing, l.platforms.map((p) => ringOf({ frame: f, u0: p.u0, u1: p.u1, v0: -l.halfLen, v1: l.halfLen })), bed, true, COL.trackBed);
      // walls: long sides tiled, end walls with the tunnel mouths
      const tile = st.name === 'Five Points' ? COL.tileOrange : COL.tileBrown;
      for (const [u, inward] of [[hall.u0, 1], [hall.u1, -1]] as [number, number][]) {
        wall(m.int, m.col, toWorld(f, u, hall.v0), toWorld(f, u, hall.v1), bed, l.ceiling, bed, l.ceiling, [f.n[0] * inward, f.n[1] * inward], COL.tileCream);
        // (the band stands 2 cm proud of the wall, or the two would fight for the same pixels)
        wall(m.int, null, toWorld(f, u + inward * 0.02, hall.v0), toWorld(f, u + inward * 0.02, hall.v1), l.platformTop + 0.9, l.platformTop + 2.6, l.platformTop + 0.9, l.platformTop + 2.6, [f.n[0] * inward, f.n[1] * inward], tile);
      }
      for (const [v, inward] of [[hall.v0, 1], [hall.v1, -1]] as [number, number][]) {
        // openings round the tracks (merged where two run close), 5 m tall
        const gaps = l.tracks.map((t) => [t.u - 2.3, t.u + 2.3] as [number, number]).sort((p, q) => p[0] - q[0]);
        const merged: [number, number][] = [];
        for (const gp of gaps) {
          const last = merged[merged.length - 1];
          if (last && gp[0] <= last[1] + 0.3) last[1] = Math.max(last[1], gp[1]);
          else merged.push([...gp]);
        }
        let u = hall.u0;
        const face: V2 = [f.a[0] * inward, f.a[1] * inward];
        for (const [g0, g1] of merged) {
          const a = Math.max(hall.u0, g0), c = Math.min(hall.u1, g1);
          if (a > u) wall(m.int, m.col, toWorld(f, u, v), toWorld(f, a, v), bed, l.ceiling, bed, l.ceiling, face, COL.tileCream);
          wall(m.int, m.col, toWorld(f, a, v), toWorld(f, c, v), l.rail + 5.0, l.ceiling, l.rail + 5.0, l.ceiling, face, COL.concrete);
          u = c;
        }
        if (u < hall.u1) wall(m.int, m.col, toWorld(f, u, v), toWorld(f, hall.u1, v), bed, l.ceiling, bed, l.ceiling, face, COL.tileCream);
      }
      slabMinus(m.int, m.col, ringOf(hall), holesHere, l.ceiling, false, COL.ceiling);
      // coffers: a beam across every 4.5 m (Five Points' waffle ceiling is the model)
      for (let v = hall.v0 + 2.25; v < hall.v1; v += 4.5) {
        if (lay.ceilingHoles.some((h) => h.hall === li && (() => {
          const [x, z] = toWorld(f, 0, v);
          const [, hv] = toLocal(h.box.frame, x, z);
          return hv > h.box.v0 - 0.5 && hv < h.box.v1 + 0.5;
        })())) continue;
        box(m.int, null, f, hall.u0, hall.u1, v - 0.25, v + 0.25, l.ceiling - 0.6, l.ceiling, COL.concrete, 0b000010 | 0b110000);
      }
      ctx.volumes.push(ctx.obb({ ...hall, y0: bed - 0.6, y1: l.ceiling + 0.4 }, 'interior', si));
    } else {
      // an elevated station: the viaduct carries the tracks (buildStrand); here the platform decks, their canopies and railings
      ctx.volumes.length;
    }
    // the platforms: a solid box from the bed to the top, the edge strips by the tracks
    l.platforms.forEach((p, pk) => {
      const pi = pBase + pk;
      const y0 = l.elevated ? l.platformTop - 0.9 : bed;
      const deckHoles = lay.stairs.filter((s) => s.ramp.frame === f && s.ramp.u0 >= p.u0 - 0.01 && s.ramp.u1 <= p.u1 + 0.01).map((s) => ringOf({ frame: f, u0: s.ramp.u0, u1: s.ramp.u1, v0: Math.min(s.ramp.v0, s.ramp.v1), v1: Math.max(s.ramp.v0, s.ramp.v1) }));
      const shaftHoles = landing.map((s) => ringOf({ frame: s.ramp.frame, u0: s.ramp.u0, u1: s.ramp.u1, v0: Math.min(s.ramp.v0, s.ramp.v1), v1: Math.max(s.ramp.v0, s.ramp.v1) }));
      const ringP = ringOf({ frame: f, u0: p.u0, u1: p.u1, v0: -l.halfLen, v1: l.halfLen });
      slabMinus(target, m.col, ringP, [...deckHoles, ...shaftHoles.filter(() => false)], l.platformTop, true, l.elevated ? COL.concrete : COL.terrazzo);
      if (l.elevated) slabMinus(target, m.col, ringP, deckHoles, y0, false, COL.viaduct);
      // edges: a face down to the bed where a track runs beside it, the yellow strip on top
      const trackAt = (u: number) => l.tracks.some((t) => Math.abs(t.u - u) < 2.2);
      for (const [u, out, strip0] of [[p.u0, -1, p.u0], [p.u1, 1, p.u1 - 0.6]] as [number, number, number][]) {
        wall(target, m.col, toWorld(f, u, -l.halfLen), toWorld(f, u, l.halfLen), y0, l.platformTop, y0, l.platformTop, [f.n[0] * out, f.n[1] * out], COL.darkConcrete);
        if (trackAt(u + out * STATION.edgeOffset)) {
          const a = toWorld(f, strip0, -l.halfLen), c = toWorld(f, strip0 + 0.6, -l.halfLen), d = toWorld(f, strip0 + 0.6, l.halfLen), e = toWorld(f, strip0, l.halfLen);
          const yy = l.platformTop + 0.006;
          // (u, v) is a right-handed pair in (x, z), so this order faces down: flip it
          quad(target, null, [a[0], yy, a[1]], [e[0], yy, e[1]], [d[0], yy, d[1]], [c[0], yy, c[1]], COL.edge);
        } else if (l.elevated) {
          // the back of a side platform: a railing (the client draws it), solid, open where a stair's landing joins it
          const gaps = lay.landings.filter((ld) => ld.frame === f && (out > 0 ? ld.u0 >= u - 0.4 : ld.u1 <= u + 0.4)).map((ld) => [ld.v0, ld.v1] as [number, number]);
          const runs: [number, number][] = [[-l.halfLen, l.halfLen]];
          for (const [g0, g1] of gaps) {
            const r0 = runs.pop()!;
            if (g0 > r0[0]) runs.push([r0[0], g0]);
            if (g1 < r0[1]) runs.push([g1, r0[1]]);
          }
          for (const [ra, rb] of runs) {
            const a = toWorld(f, u, ra), c = toWorld(f, u, rb);
            railingSolid(m.col, a[0], a[1], c[0], c[1], l.platformTop);
            for (let v = ra + 0.5; v < rb; v += 1) {
              const q = toWorld(f, u - out * 0.05, v);
              ctx.anchor('railing', q[0], l.platformTop, q[1], yawOfFrame(f) + Math.PI / 2, si, pi);
            }
          }
        }
      }
      for (const end of [-l.halfLen, l.halfLen]) {
        wall(target, m.col, toWorld(f, p.u0, end), toWorld(f, p.u1, end), y0, l.platformTop, y0, l.platformTop, [f.a[0] * Math.sign(end), f.a[1] * Math.sign(end)], COL.darkConcrete);
      }
      // furniture: columns in one or two rows, benches, name signs, screens, lamps; waiting spots by the edges
      const w = p.u1 - p.u0;
      // two rows on a wide platform (the middle stays the walk), one down the middle of a narrow one
      const colRows = w >= 8.5 ? [p.u0 + 2.0, p.u1 - 2.0] : [p.u0 + w / 2];
      for (let v = -l.halfLen + 4.5; v <= l.halfLen - 4.5; v += 9) {
        for (const u of colRows) {
          if (nearShaft(u, v, 1.2)) continue;
          const [x, z] = toWorld(f, u, v);
          ctx.anchor('column', x, l.platformTop, z, yawOfFrame(f), si, pi);
          box(null, m.col, frameOf([x, z], f.a), -0.36, 0.36, -0.36, 0.36, l.platformTop, l.platformTop + 4.5, COL.concrete);
        }
      }
      let k = 0;
      for (let v = -l.halfLen + 9; v <= l.halfLen - 9; v += 9, k++) {
        if (k % 3 !== 1) continue;
        // on the column rows (the middle of a wide platform is its walk), each facing the track on its side
        const seats: [number, number][] = colRows.length === 2 ? [[colRows[0], -1], [colRows[1], 1]] : p.kind === 'island' ? [[colRows[0] - 0.45, -1], [colRows[0] + 0.45, 1]] : [[colRows[0], trackAt(p.u0 - STATION.edgeOffset) ? -1 : 1]];
        for (const [u, face] of seats) {
          if (nearShaft(u, v, 1.0)) continue;
          const [x, z] = toWorld(f, u, v);
          // a bench faces +Z in its own frame: turn it to face the track on its side
          const yaw = Math.atan2(f.n[0] * face, f.n[1] * face);
          ctx.anchor('bench', x, l.platformTop, z, yaw, si, pi);
          const bf = frameOf([x, z], [Math.sin(yaw), Math.cos(yaw)]);
          box(null, m.col, bf, -1.0, 1.0, -0.28, 0.28, l.platformTop, l.platformTop + 0.48, COL.concrete);
        }
      }
      for (let v = -l.halfLen + 14; v <= l.halfLen - 14; v += 28) {
        const u = (p.u0 + p.u1) / 2;
        if (nearShaft(u, v, 0.5)) continue;
        const [x, z] = toWorld(f, u, v);
        ctx.anchor('sign_name', x, l.platformTop + 3.15, z, Math.atan2(f.n[0], f.n[1]), si, pi);
      }
      for (const v of [-l.halfLen * 0.55, 0, l.halfLen * 0.55]) {
        const u = (p.u0 + p.u1) / 2;
        if (nearShaft(u, v, 0.3)) continue;
        const [x, z] = toWorld(f, u, v);
        ctx.anchor('screen', x, l.platformTop + 3.0, z, Math.atan2(f.a[0], f.a[1]), si, pi);
      }
      const lampY = l.elevated ? l.platformTop + 3.9 : l.ceiling - 0.62;
      for (let v = -l.halfLen + 3; v <= l.halfLen - 3; v += 6) {
        const us = w > 7 ? [p.u0 + w * 0.25, p.u1 - w * 0.25] : [(p.u0 + p.u1) / 2];
        for (const u of us) {
          const [x, z] = toWorld(f, u, v);
          ctx.anchor('lamp_tube', x, lampY, z, yawOfFrame(f), si, pi);
          ctx.lamps.push({ x, y: lampY - 0.1, z, k: 0.85 });
        }
      }
      if (!l.elevated) {
        // the track side of the hall gets light too
        for (const t of l.tracks) for (let v = -l.halfLen; v <= l.halfLen; v += 8) {
          const [x, z] = toWorld(f, t.u, v);
          ctx.lamps.push({ x, y: l.ceiling - 0.8, z, k: 0.35 });
        }
      } else {
        // the canopy over an elevated platform: a roof slab on the columns
        const roof = ringOf({ frame: f, u0: p.u0 - 0.3, u1: p.u1 + 0.3, v0: -l.halfLen + 6, v1: l.halfLen - 6 });
        slabMinus(m.ext, null, roof, [], l.platformTop + 4.35, false, COL.ceiling);
        slabMinus(m.ext, null, roof, [], l.platformTop + 4.5, true, COL.darkConcrete);
      }
      // waiting spots and the platform's walk line
      const waits = ctx.platforms[pi].waits;
      const spine: number[] = [];
      for (let v = -l.halfLen + 6; v <= l.halfLen - 6; v += 10) {
        const uc = (p.u0 + p.u1) / 2;
        const free = !nearShaft(uc, v, 0.6);
        // beside a stair: in the middle of the walk past it
        const sh = landing.find((q) => q.ramp.frame === f);
        const [x, z] = toWorld(f, free || !sh ? uc : (p.u0 + sh.ramp.u0) / 2, v);
        spine.push(ctx.node(x, l.platformTop, z));
        for (const [u, face] of [[p.u0 + 1.4, -1], [p.u1 - 1.4, 1]] as [number, number][]) {
          if (!trackAt(u + face * (1.4 + STATION.edgeOffset))) continue;
          if (nearShaft(u, v, 0.5)) continue;
          const [wx, wz] = toWorld(f, u, v + 2);
          waits.push([Math.round(wx * 100) / 100, Math.round(l.platformTop * 100) / 100, Math.round(wz * 100) / 100, Math.round(Math.atan2(f.n[0] * face, f.n[1] * face) * 1000) / 1000]);
        }
      }
      for (let k2 = 0; k2 + 1 < spine.length; k2++) {
        const a = walkPos(ctx, spine[k2]), c = walkPos(ctx, spine[k2 + 1]);
        const over = landing.some((s) => {
          for (let q = 1; q < 10; q++) {
            const [u, v] = toLocal(s.ramp.frame, a[0] + ((c[0] - a[0]) * q) / 10, a[2] + ((c[2] - a[2]) * q) / 10);
            if (u > s.ramp.u0 - 0.35 && u < s.ramp.u1 + 0.35 && v > Math.min(s.ramp.v0, s.ramp.v1) && v < Math.max(s.ramp.v0, s.ramp.v1)) return true;
          }
          return false;
        });
        if (!over) ctx.edge(spine[k2], spine[k2 + 1], 0);
      }
      hallWalk[pi] = spine;
    });
  });

  // the landings of the elevated side platforms' stairs
  for (const ld of lay.landings) box(m.ext, m.col, ld.frame, ld.u0, ld.u1, ld.v0, ld.v1, ld.y0, ld.y1, COL.concrete);

  // the concourse, its paid area and gates, the shafts, the entrances
  const conc = lay.concourse;
  const rooms: LocalBox[] = [];
  if (conc) rooms.push(conc);
  for (const c of lay.corridors) rooms.push(c);
  const shaftHead = STATION.shaftHeight;
  if (conc) {
    room(m, conc, { others: lay.corridors, floorMinus: lay.floorHoles.map(ringOf), floor: COL.terrazzo, wall: COL.tileCream, ceil: COL.ceiling });
    ctx.volumes.push(ctx.obb({ ...conc, y0: conc.y0 - 0.6, y1: conc.y1 + 0.3 }, 'interior', si));
    for (let v = conc.v0 + 3; v <= conc.v1 - 3; v += 6) for (let u = conc.u0 + 3; u <= conc.u1 - 3; u += 6) {
      const [x, z] = toWorld(conc.frame, u, v);
      ctx.anchor('lamp_tube', x, conc.y1 - 0.05, z, yawOfFrame(conc.frame), si);
      ctx.lamps.push({ x, y: conc.y1 - 0.2, z, k: 0.8 });
    }
    // a map board and bins on the walls, by the gates
    const mb = toWorld(conc.frame, conc.u0 + 0.06, (conc.v0 + conc.v1) / 2);
    ctx.anchor('map_board', mb[0], conc.y0 + 1.2, mb[1], Math.atan2(conc.frame.n[0], conc.frame.n[1]), si);
    const bn = toWorld(conc.frame, conc.u1 - 0.6, conc.v0 + 2);
    ctx.anchor('bin', bn[0], conc.y0, bn[1], 0, si);
    box(null, m.col, frameOf(bn, conc.frame.a), -0.28, 0.28, -0.28, 0.28, conc.y0, conc.y0 + 0.9, COL.concrete);
  }
  lay.corridors.forEach((c, k) => {
    const before = [conc, ...lay.corridors.slice(0, k)].filter((x): x is LocalBox => !!x).map(ringOf);
    const others = [conc, ...lay.corridors.filter((_, j) => j !== k)].filter((x): x is LocalBox => !!x);
    // the first leg of an entrance starts at the stair's foot: its near end is the stair
    const firstLeg = lay.stairs.some((s) => Math.hypot(s.foot[0] - c.frame.o[0], s.foot[2] - c.frame.o[1]) < 0.2);
    room(m, firstLeg ? { ...c, v0: 0 } : c, { others, floorMinus: before, ceilMinus: before, floor: COL.terrazzo, wall: COL.tileCream, ceil: COL.ceiling, endWalls: [!firstLeg, true] });
    ctx.volumes.push(ctx.obb({ ...c, y0: c.y0 - 0.6, y1: c.y1 + 0.3 }, 'interior', si));
    for (let v = (firstLeg ? 0 : c.v0) + 2; v <= c.v1 - 1; v += 6) {
      const [x, z] = toWorld(c.frame, 0, v);
      ctx.anchor('lamp_tube', x, c.y1 - 0.05, z, yawOfFrame(c.frame), si);
      ctx.lamps.push({ x, y: c.y1 - 0.2, z, k: 0.8 });
    }
  });
  // fare gates: a cabinet either side of each gap, solid; the gap is open (walk through and it charges, jump it and it is evasion)
  for (const gt of lay.gates) {
    const [x, z] = toWorld(gt.frame, gt.u, gt.v);
    const yaw = Math.atan2(gt.inward[0], gt.inward[1]);
    const gf = frameOf([x, z], gt.inward);
    for (const side of [-1, 1]) {
      const off = side * (STATION.gateGap / 2 + STATION.gateCabinet / 2);
      const [cx, cz] = toWorld(gf, off, 0);
      ctx.anchor('fare_gate', cx, gt.y, cz, yaw, si);
      box(null, m.col, frameOf([cx, cz], gt.inward), -STATION.gateCabinet / 2, STATION.gateCabinet / 2, -0.8, 0.8, gt.y, gt.y + 0.85, COL.balustrade);
    }
  }
  for (const [x0, z0, x1, z1, y] of lay.railings) {
    railingSolid(m.col, x0, z0, x1, z1, y);
    const L = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(z1 - z0, -(x1 - x0)) ;
    // a kit railing runs along its local X: (cos yaw, -sin yaw) = the segment's direction
    const yawX = Math.atan2(-(z1 - z0), x1 - x0);
    void yaw;
    for (let t = 0.5; t < L; t += 1) ctx.anchor('railing', x0 + ((x1 - x0) * t) / L, y, z0 + ((z1 - z0) * t) / L, yawX, si);
  }
  // shafts: stairs and escalators from the concourse down to the platform
  for (const sh of lay.shafts) {
    const r = sh.ramp;
    const l = st.levels[sh.level];
    const cFloor = conc ? conc.y0 : r.y0;
    const wTop = (_v: number, y: number) => {
      const top = Math.min(y + shaftHead, cFloor);
      const bottom = Math.max(y - 0.3, l.ceiling);
      // inside the hall: a balustrade only
      if (y + 1.0 < l.ceiling && top <= l.ceiling + 0.01) return y + 1.0;
      return top > bottom ? top : y + 1.0;
    };
    const ceil = (_v: number, y: number) => (y + shaftHead > l.ceiling + 0.05 && y + shaftHead < cFloor - 0.05 ? y + shaftHead : null);
    const W = r.u1 - r.u0;
    const lanes: { u0: number; u1: number; kind: 'stairs' | 'escalator' }[] = W > 4.4 ? [{ u0: r.u0, u1: r.u0 + W - 2.6, kind: 'stairs' }, { u0: r.u1 - 2.6, u1: r.u1 - 1.3, kind: 'escalator' }, { u0: r.u1 - 1.3, u1: r.u1, kind: 'escalator' }] : [{ u0: r.u0, u1: r.u1, kind: 'stairs' }];
    stairs(m, r, m.int, { wallTop: wTop, ceil, lanes });
    ctx.rampVolumes(r, shaftHead + 0.3, si);
    const dir = Math.sign(r.v1 - r.v0);
    for (let v = r.v0 + dir * 3; Math.abs(v - r.v0) < Math.abs(r.v1 - r.v0); v += dir * 6) {
      const [x, z] = toWorld(r.frame, (r.u0 + r.u1) / 2, v);
      const y = rampY(r, v) + shaftHead - 0.1;
      if (y < l.ceiling || y > cFloor) continue;
      ctx.anchor('lamp_tube', x, y, z, yawOfFrame(r.frame), si);
      ctx.lamps.push({ x, y: y - 0.2, z, k: 0.7 });
    }
  }
  // entrances: the stairs from the street (open under the canopy, then roofed), the canopy and its pylon
  for (const s of lay.stairs) {
    const r = s.ramp;
    const elevated = s.foot[1] > s.top[1];
    const dir = Math.sign(r.v1 - r.v0);
    if (!elevated) {
      // the well is open where the stair's roof would stand out of the ground
      let vOpen = r.v0;
      for (let v = r.v0; Math.abs(v - r.v0) <= Math.abs(r.v1 - r.v0); v += dir * 0.5) {
        const [x, z] = toWorld(r.frame, 0, v);
        if (rampY(r, v) + STATION.corridorHeight + 0.4 >= ctx.ground(x, z)) vOpen = v;
      }
      const gAt = (v: number) => ctx.ground(...toWorld(r.frame, 0, v));
      stairs(m, r, m.int, {
        wallTop: (v, y) => ((v - vOpen) * dir <= 0 ? gAt(v) + 0.05 : y + STATION.corridorHeight),
        ceil: (v, y) => ((v - vOpen) * dir > 0 ? y + STATION.corridorHeight : null),
      });
      // the open well: the ground and the street are not drawn over it
      const [hx, hz] = toWorld(r.frame, 0, (r.v0 - 0.5 * dir + vOpen) / 2);
      ctx.holes.push([Math.round(hx * 100) / 100, Math.round(hz * 100) / 100, Math.round((r.u1 - r.u0) * 50 + 15) / 100, Math.round(Math.abs(vOpen - r.v0 + 0.5 * dir) * 50) / 100, Math.round(yawOfFrame(r.frame) * 1000) / 1000]);
      ctx.rampVolumes(r, STATION.corridorHeight + 0.4, si, 2.4);
      ctx.anchor('canopy', s.top[0], s.top[1], s.top[2], s.yaw, si);
      const py = toWorld(r.frame, r.u1 + 1.1, r.v0 - 0.8);
      ctx.anchor('pylon', py[0], ctx.ground(py[0], py[1]), py[1], s.yaw, si);
      box(null, m.col, frameOf(py, r.frame.a), -0.3, 0.3, -0.3, 0.3, ctx.ground(py[0], py[1]), ctx.ground(py[0], py[1]) + 4.2, COL.concrete);
      // the well's sides and back are walled at the street (the canopy's waist walls), so nobody falls in sideways
      for (const u of [r.u0 - 0.15, r.u1 + 0.15]) {
        const a = toWorld(r.frame, u, r.v0), c = toWorld(r.frame, u, vOpen);
        railingSolid(m.col, a[0], a[1], c[0], c[1], ctx.ground(a[0], a[1]));
      }
      for (let v = r.v0 + dir * 2; Math.abs(v - r.v0) < Math.abs(r.v1 - r.v0); v += dir * 5) {
        if ((v - vOpen) * dir <= 0) continue;
        const [x, z] = toWorld(r.frame, 0, v);
        const y = rampY(r, v) + STATION.corridorHeight - 0.05;
        ctx.anchor('lamp_tube', x, y, z, yawOfFrame(r.frame), si);
        ctx.lamps.push({ x, y: y - 0.2, z, k: 0.7 });
      }
    } else {
      // an elevated station's stair: in the open, balustrades either side
      stairs(m, r, m.ext, { wallTop: (_v, y) => y + 1.05, ceil: () => null });
      const py = toWorld(r.frame, r.u1 + 1.0, r.v1 + dir * 3.2);
      ctx.anchor('pylon', py[0], ctx.ground(py[0], py[1]), py[1], s.yaw, si);
      box(null, m.col, frameOf(py, r.frame.a), -0.3, 0.3, -0.3, 0.3, ctx.ground(py[0], py[1]), ctx.ground(py[0], py[1]) + 4.2, COL.concrete);
    }
  }
  void quad;

  // ---- the walk network: street -> stairs -> corridor -> concourse -> gate -> paid area -> shaft -> platform ----
  const paid = lay.paid;
  const inPaid = (x: number, z: number) => {
    if (!paid) return false;
    const [u, v] = toLocal(paid.frame, x, z);
    return u > paid.u0 && u < paid.u1 && v > paid.v0 && v < paid.v1;
  };
  const crossesPaid = (a: V2, c: V2) => {
    if (!paid) return false;
    for (let t = 0.05; t < 1; t += 0.05) if (inPaid(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t)) return true;
    return false;
  };
  const holesHit = (a: V2, c: V2) => lay.floorHoles.some((h) => {
    for (let t = 0; t <= 1; t += 0.05) {
      const [u, v] = toLocal(h.frame, a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t);
      if (u > h.u0 - 0.6 && u < h.u1 + 0.6 && v > h.v0 - 0.6 && v < h.v1 + 0.6) return true;
    }
    return false;
  });
  if (conc && paid) {
    const y = conc.y0;
    // the free ring's corners and the paid area's corners as waypoints
    const free: number[] = [];
    const freePts: V2[] = [];
    for (const [u, v] of [[conc.u0 + 1.6, conc.v0 + 1.6], [conc.u1 - 1.6, conc.v0 + 1.6], [conc.u1 - 1.6, conc.v1 - 1.6], [conc.u0 + 1.6, conc.v1 - 1.6]] as V2[]) {
      const p = toWorld(conc.frame, u, v);
      freePts.push(p);
      free.push(ctx.node(p[0], y, p[1]));
    }
    const paidPts: V2[] = [];
    const paidN: number[] = [];
    for (const [u, v] of [[paid.u0 + 0.9, paid.v0 + 0.9], [paid.u1 - 0.9, paid.v0 + 0.9], [paid.u1 - 0.9, paid.v1 - 0.9], [paid.u0 + 0.9, paid.v1 - 0.9]] as V2[]) {
      const p = toWorld(paid.frame, u, v);
      paidPts.push(p);
      paidN.push(ctx.node(p[0], y, p[1]));
    }
    const link = (aN: number[], aP: V2[], bN: number[], bP: V2[], blocked: (a: V2, c: V2) => boolean, kind = 0) => {
      aN.forEach((an, i) => bN.forEach((bn, j) => {
        if (an === bn) return;
        if (!blocked(aP[i], bP[j])) ctx.edge(an, bn, kind);
      }));
    };
    link(free, freePts, free, freePts, crossesPaid);
    link(paidN, paidPts, paidN, paidPts, holesHit);
    // the gates
    for (const gt of lay.gates) {
      const [x, z] = toWorld(gt.frame, gt.u, gt.v);
      const o: V2 = [x - gt.inward[0] * 1.3, z - gt.inward[1] * 1.3];
      const i: V2 = [x + gt.inward[0] * 1.3, z + gt.inward[1] * 1.3];
      const on = ctx.node(o[0], y, o[1]), inn = ctx.node(i[0], y, i[1]);
      ctx.edge(on, inn, 2);
      link([on], [o], free, freePts, crossesPaid);
      link([inn], [i], paidN, paidPts, holesHit);
      free.push(on);
      freePts.push(o);
      paidN.push(inn);
      paidPts.push(i);
    }
    // shafts: the top landing joins the paid area, the bottom the platform's walk line
    for (const sh of lay.shafts) {
      const r = sh.ramp;
      const dir = Math.sign(r.v1 - r.v0);
      const top = toWorld(r.frame, (r.u0 + r.u1) / 2, r.v0 - dir * 1.2);
      const bot = toWorld(r.frame, (r.u0 + r.u1) / 2, r.v1 + dir * 1.4);
      const tn = ctx.node(top[0], r.y0, top[1]);
      const bn = ctx.node(bot[0], r.y1, bot[1]);
      ctx.edge(tn, bn, 1);
      link([tn], [top], paidN, paidPts, holesHit);
      const lv = st.levels[sh.level];
      const plat = lv.platforms.find((q) => r.u0 >= q.u0 - 0.1 && r.u1 <= q.u1 + 0.1) ?? lv.platforms[0];
      const pi = ctx.levelPlatformBase[sh.level] + Math.max(0, lv.platforms.indexOf(plat));
      const spine = hallWalk[pi] ?? [];
      // a segment that crosses the stair's footprint (it would lead a walker back up the stairs) is no edge
      const crossesStair = (a: V2, b2: V2) => {
        for (let k = 1; k < 20; k++) {
          const [u, v] = toLocal(r.frame, a[0] + ((b2[0] - a[0]) * k) / 20, a[1] + ((b2[1] - a[1]) * k) / 20);
          if (u > r.u0 - 0.35 && u < r.u1 + 0.35 && v > Math.min(r.v0, r.v1) - 0.2 && v < Math.max(r.v0, r.v1) + 0.2) return true;
        }
        return false;
      };
      // waypoints on the walks either side of the stair's foot
      const ends: { n: number; p: V2 }[] = [{ n: bn, p: bot }];
      for (const u of [(plat.u0 + r.u0) / 2, (r.u1 + plat.u1) / 2]) {
        if (Math.abs(u - (r.u0 + r.u1) / 2) < 1.5) continue;
        const q = toWorld(r.frame, u, r.v1 + dir * 1.4);
        const qn = ctx.node(q[0], r.y1, q[1]);
        ctx.edge(bn, qn, 0);
        ends.push({ n: qn, p: q });
      }
      for (const e of ends) {
        const byD = spine
          .filter((sn) => !crossesStair(e.p, [walkPos(ctx, sn)[0], walkPos(ctx, sn)[2]]))
          .sort((p, q) => Math.hypot(walkPos(ctx, p)[0] - e.p[0], walkPos(ctx, p)[2] - e.p[1]) - Math.hypot(walkPos(ctx, q)[0] - e.p[0], walkPos(ctx, q)[2] - e.p[1]));
        for (const n of byD.slice(0, 2)) ctx.edge(e.n, n, 0);
      }
    }
    // entrances: the street, the stair's foot, the corridor's legs, then the free ring
    for (const s of lay.stairs) {
      const r = s.ramp;
      const dir = Math.sign(r.v1 - r.v0);
      const street = toWorld(r.frame, 0, r.v0 - dir * 1.5);
      const sn = ctx.node(street[0], s.top[1], street[1]);
      const fn = ctx.node(s.foot[0], s.foot[1], s.foot[2]);
      ctx.edge(sn, fn, 1);
      let prev = fn;
      const legs = lay.corridors.filter((c) => true && c.y0 === conc.y0);
      // follow the corridor legs from the foot
      let at: V2 = [s.foot[0], s.foot[2]];
      for (let guard = 0; guard < 4; guard++) {
        const leg = legs.find((c) => Math.hypot(c.frame.o[0] - at[0], c.frame.o[1] - at[1]) < 0.3);
        if (!leg) break;
        const end = toWorld(leg.frame, 0, leg.v1 - STATION.corridorWidth / 2);
        const en = ctx.node(end[0], conc.y0, end[1]);
        ctx.edge(prev, en, 0);
        prev = en;
        at = end;
      }
      link([prev], [at], free, freePts, crossesPaid);
    }
  } else {
    // an elevated station: street -> gate -> stair -> platform
    for (const s of lay.stairs) {
      const r = s.ramp;
      const dir = Math.sign(r.v1 - r.v0);
      const gates = lay.gates.filter((gt) => gt.frame === r.frame);
      const foot = toWorld(r.frame, (r.u0 + r.u1) / 2, r.v1 + dir * 1.0);
      const fn = ctx.node(foot[0], r.y1, foot[1]);
      const top = toWorld(r.frame, (r.u0 + r.u1) / 2, r.v0 - dir * 1.0);
      const tn = ctx.node(top[0], r.y0, top[1]);
      ctx.edge(fn, tn, 1);
      for (const gt of gates.slice(1, 2)) {
        const [x, z] = toWorld(gt.frame, gt.u, gt.v);
        const out = ctx.node(x - gt.inward[0] * 1.5, gt.y, z - gt.inward[1] * 1.5);
        const inn = ctx.node(x + gt.inward[0] * 0.8, gt.y, z + gt.inward[1] * 0.8);
        ctx.edge(out, inn, 2);
        ctx.edge(inn, fn, 0);
        const street = ctx.node(x - gt.inward[0] * 4, gt.y, z - gt.inward[1] * 4);
        ctx.edge(street, out, 4);
      }
      // the platform it lands on
      st.levels.forEach((l, li) => {
        if (r.frame !== l.frame) return;
        l.platforms.forEach((p, pk) => {
          const [u] = toLocal(l.frame, top[0], top[1]);
          if (u < p.u0 - 4 || u > p.u1 + 4) return;
          const spine = hallWalk[ctx.levelPlatformBase[li] + pk] ?? [];
          const crosses = (a: V2, b2: V2) => {
            for (let k = 1; k < 20; k++) {
              const [uu, vv] = toLocal(r.frame, a[0] + ((b2[0] - a[0]) * k) / 20, a[1] + ((b2[1] - a[1]) * k) / 20);
              if (uu > r.u0 - 0.35 && uu < r.u1 + 0.35 && vv > Math.min(r.v0, r.v1) - 0.2 && vv < Math.max(r.v0, r.v1) + 0.2) return true;
            }
            return false;
          };
          const ends: { n: number; p: V2 }[] = [{ n: tn, p: top }];
          if (p.kind === 'side') {
            // from the landing straight across onto the platform first (a line to the walk further along would leave the landing)
            const q = toWorld(r.frame, (p.u0 + p.u1) / 2, r.v0 - dir * 1.3);
            const qn = ctx.node(q[0], r.y0, q[1]);
            ctx.edge(tn, qn, 0);
            ends[0] = { n: qn, p: q };
          }
          if (p.kind === 'island') for (const uu of [(p.u0 + r.u0) / 2, (r.u1 + p.u1) / 2]) {
            const q = toWorld(r.frame, uu, r.v0 - dir * 1.0);
            const qn = ctx.node(q[0], r.y0, q[1]);
            ctx.edge(tn, qn, 0);
            ends.push({ n: qn, p: q });
          }
          for (const e of ends) {
            const byD = spine.filter((sn) => !crosses(e.p, [walkPos(ctx, sn)[0], walkPos(ctx, sn)[2]])).sort((p1, q1) => Math.hypot(walkPos(ctx, p1)[0] - e.p[0], walkPos(ctx, p1)[2] - e.p[1]) - Math.hypot(walkPos(ctx, q1)[0] - e.p[0], walkPos(ctx, q1)[2] - e.p[1]));
            for (const n of byD.slice(0, 2)) ctx.edge(e.n, n, 0);
          }
        });
      });
    }
  }
}

/** The position of a walk node. */
const walkPos = (ctx: Ctx, n: number): [number, number, number] => ctx.nodes[n];

interface StrandCtx {
  anchor: Ctx['anchor'];
  volumes: OutVolume[];
  lamps: Ctx['lamps'];
  onRoad: (x: number, z: number, m: number) => boolean;
  inBuilding: (x: number, z: number) => boolean;
  stats: { tunnelM: number; trenchM: number; gradeM: number; elevatedM: number; stationM: number; piers: number };
  strandIndex: number;
}

/** One physical track: its rails everywhere, and its tunnel, trench or viaduct (shared with a twin beside it). */
function buildStrand(s: Strand, tw: { left: number[]; right: number[] }, m: TransitMeshes, ctx: StrandCtx): void {
  const P = s.pts;
  const n = P.length;
  const dirAt = (i: number): V2 => {
    const a = P[Math.max(0, i - 1)], c = P[Math.min(n - 1, i + 1)];
    const l = Math.hypot(c[0] - a[0], c[2] - a[2]) || 1;
    return [(c[0] - a[0]) / l, (c[2] - a[2]) / l];
  };
  const left = (i: number): V2 => {
    const d = dirAt(i);
    return [d[1], -d[0]];
  };
  const at = (i: number, u: number, y: number): [number, number, number] => {
    const l = left(i);
    return [P[i][0] + l[0] * u, y, P[i][2] + l[1] * u];
  };
  const kindOf = (i: number) => s.kind[i];
  const W = 2.6;
  let sinceBay = 0, sincePier = 0;
  for (let i = 0; i + 1 < n; i++) {
    const k = kindOf(i);
    const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][2] - P[i][2]);
    const ya = P[i][1], yb = P[i + 1][1];
    const uL = (j: number) => (Number.isFinite(tw.left[j]) ? tw.left[j] / 2 : W);
    const uR = (j: number) => (Number.isFinite(tw.right[j]) ? tw.right[j] / 2 : -W);
    const hasL = (j: number) => !Number.isFinite(tw.left[j]);
    const hasR = (j: number) => !Number.isFinite(tw.right[j]);
    // rails: two running rails and the third rail, everywhere
    const target = k === 'tunnel' || k === 'station' || k === 'trench' ? m.int : m.ext;
    for (const u of [-0.7175, 0.7175]) {
      quad(target, null, at(i, u + 0.036, ya), at(i, u - 0.036, ya), at(i + 1, u - 0.036, yb), at(i + 1, u + 0.036, yb), [0.3, 0.29, 0.28]);
      wall(target, null, [at(i, u + 0.036, 0)[0], at(i, u + 0.036, 0)[2]], [at(i + 1, u + 0.036, 0)[0], at(i + 1, u + 0.036, 0)[2]], ya - 0.15, ya, yb - 0.15, yb, left(i), [0.05, 0.045, 0.04]);
      wall(target, null, [at(i, u - 0.036, 0)[0], at(i, u - 0.036, 0)[2]], [at(i + 1, u - 0.036, 0)[0], at(i + 1, u - 0.036, 0)[2]], ya - 0.15, ya, yb - 0.15, yb, [-left(i)[0], -left(i)[1]], [0.05, 0.045, 0.04]);
    }
    // the plinths under the rails, and the third rail with its cover board on the left
    quad(target, null, at(i, 1.0, ya - 0.15), at(i, -1.0, ya - 0.15), at(i + 1, -1.0, yb - 0.15), at(i + 1, 1.0, yb - 0.15), COL.darkConcrete);
    quad(target, null, at(i, 1.32, ya + 0.12), at(i, 1.12, ya + 0.12), at(i + 1, 1.12, yb + 0.12), at(i + 1, 1.32, yb + 0.12), COL.cover);
    if (k === 'tunnel') {
      ctx.stats.tunnelM += L;
      const yf = (y: number) => y - 0.25, yc = (y: number) => y + 5.0;
      // floor and ceiling between the walls (to the midline where a twin runs beside)
      quad(m.int, m.col, at(i, uL(i), yf(ya)), at(i, uR(i), yf(ya)), at(i + 1, uR(i + 1), yf(yb)), at(i + 1, uL(i + 1), yf(yb)), COL.trackBed);
      quad(m.int, m.col, at(i, uR(i), yc(ya)), at(i, uL(i), yc(ya)), at(i + 1, uL(i + 1), yc(yb)), at(i + 1, uR(i + 1), yc(yb)), COL.tunnel);
      if (hasL(i) && hasL(i + 1)) {
        const a = at(i, uL(i), 0), c = at(i + 1, uL(i + 1), 0);
        wall(m.int, m.col, [a[0], a[2]], [c[0], c[2]], yf(ya), yc(ya), yf(yb), yc(yb), [-left(i)[0], -left(i)[1]], COL.tunnel);
      }
      if (hasR(i) && hasR(i + 1)) {
        const a = at(i, uR(i), 0), c = at(i + 1, uR(i + 1), 0);
        wall(m.int, m.col, [a[0], a[2]], [c[0], c[2]], yf(ya), yc(ya), yf(yb), yc(yb), left(i), COL.tunnel);
      }
      // lamps and the wall details on the outer wall every 12 m
      sinceBay += L;
      if (sinceBay >= 12) {
        sinceBay = 0;
        const outer = hasL(i) ? 1 : hasR(i) ? -1 : 0;
        if (outer !== 0) {
          const u = outer > 0 ? uL(i) : uR(i);
          const p = at(i, u, ya - 0.25);
          const l = left(i);
          const inward: V2 = [-l[0] * outer, -l[1] * outer];
          ctx.anchor('tunnel_bay', p[0], p[1], p[2], Math.atan2(-inward[1], inward[0]), -1);
          ctx.lamps.push({ x: p[0] + inward[0] * 0.4, y: ya + 2.6, z: p[2] + inward[1] * 0.4, k: 0.55 });
        }
      }
      const c = [(P[i][0] + P[i + 1][0]) / 2, (P[i][2] + P[i + 1][2]) / 2];
      const um = (uL(i) + uR(i)) / 2;
      const l = left(i);
      ctx.volumes.push({ c: [Math.round((c[0] + l[0] * um) * 100) / 100, Math.round(((ya + yb) / 2 + 2.3) * 100) / 100, Math.round((c[1] + l[1] * um) * 100) / 100], h: [Math.round(((uL(i) - uR(i)) / 2 + 0.2) * 100) / 100, 3.3, Math.round((L / 2 + 0.3) * 100) / 100], yaw: Math.round(Math.atan2(dirAt(i)[0], dirAt(i)[1]) * 1000) / 1000, kind: 'interior', station: -1 });
    } else if (k === 'trench') {
      ctx.stats.trenchM += L;
      const yf = (y: number) => y - 0.25;
      const ga = s.ground[i], gb = s.ground[i + 1];
      quad(m.int, m.col, at(i, uL(i), yf(ya)), at(i, uR(i), yf(ya)), at(i + 1, uR(i + 1), yf(yb)), at(i + 1, uL(i + 1), yf(yb)), COL.trackBed);
      if (hasL(i) && hasL(i + 1)) {
        const a = at(i, uL(i), 0), c = at(i + 1, uL(i + 1), 0);
        wall(m.int, m.col, [a[0], a[2]], [c[0], c[2]], yf(ya), ga, yf(yb), gb, [-left(i)[0], -left(i)[1]], COL.concrete);
      }
      if (hasR(i) && hasR(i + 1)) {
        const a = at(i, uR(i), 0), c = at(i + 1, uR(i + 1), 0);
        wall(m.int, m.col, [a[0], a[2]], [c[0], c[2]], yf(ya), ga, yf(yb), gb, left(i), COL.concrete);
      }
      const c = [(P[i][0] + P[i + 1][0]) / 2, (P[i][2] + P[i + 1][2]) / 2];
      const um = (uL(i) + uR(i)) / 2;
      const l = left(i);
      const top = Math.min(ga, gb) - 0.2;
      const bot = Math.min(ya, yb) - 1;
      if (top > bot + 2) ctx.volumes.push({ c: [Math.round((c[0] + l[0] * um) * 100) / 100, Math.round(((top + bot) / 2) * 100) / 100, Math.round((c[1] + l[1] * um) * 100) / 100], h: [Math.round(((uL(i) - uR(i)) / 2 + 0.2) * 100) / 100, Math.round(((top - bot) / 2) * 100) / 100, Math.round((L / 2 + 0.3) * 100) / 100], yaw: Math.round(Math.atan2(dirAt(i)[0], dirAt(i)[1]) * 1000) / 1000, kind: 'open', station: -1 });
    } else if (k === 'elevated' || k === 'elevated-station') {
      ctx.stats.elevatedM += L;
      const top = (y: number) => y - 0.25, bot = (y: number) => y - 1.35;
      const eL = (j: number) => (Number.isFinite(tw.left[j]) ? tw.left[j] / 2 : 2.3);
      const eR = (j: number) => (Number.isFinite(tw.right[j]) ? tw.right[j] / 2 : -2.3);
      quad(m.ext, m.col, at(i, eL(i), top(ya)), at(i, eR(i), top(ya)), at(i + 1, eR(i + 1), top(yb)), at(i + 1, eL(i + 1), top(yb)), COL.trackBed);
      quad(m.ext, m.col, at(i, eR(i), bot(ya)), at(i, eL(i), bot(ya)), at(i + 1, eL(i + 1), bot(yb)), at(i + 1, eR(i + 1), bot(yb)), COL.viaduct);
      for (const [has, e, sgn] of [[hasL, eL, 1], [hasR, eR, -1]] as [(j: number) => boolean, (j: number) => number, number][]) {
        if (!has(i) || !has(i + 1)) continue;
        const a = at(i, e(i), 0), c = at(i + 1, e(i + 1), 0);
        const l = left(i);
        const outN: V2 = [l[0] * sgn, l[1] * sgn];
        // the girder's side, the parapet's outer and inner faces and its top (an elevated station has its platform here instead)
        wall(m.ext, m.col, [a[0], a[2]], [c[0], c[2]], bot(ya), top(ya) + (k === 'elevated' ? 1.0 : 0), bot(yb), top(yb) + (k === 'elevated' ? 1.0 : 0), outN, COL.viaduct);
        if (k === 'elevated') {
          const a2 = at(i, e(i) - sgn * 0.3, 0), c2 = at(i + 1, e(i + 1) - sgn * 0.3, 0);
          wall(m.ext, m.col, [a2[0], a2[2]], [c2[0], c2[2]], top(ya), top(ya) + 1.0, top(yb), top(yb) + 1.0, [-outN[0], -outN[1]], COL.parapet);
          quad(m.ext, null, at(i, e(i), top(ya) + 1.0), at(i, e(i) - sgn * 0.3, top(ya) + 1.0), at(i + 1, e(i + 1) - sgn * 0.3, top(yb) + 1.0), at(i + 1, e(i + 1), top(yb) + 1.0), COL.parapet);
          quad(m.ext, null, at(i, e(i) - sgn * 0.3, top(ya) + 1.0), at(i, e(i), top(ya) + 1.0), at(i + 1, e(i + 1), top(yb) + 1.0), at(i + 1, e(i + 1) - sgn * 0.3, top(yb) + 1.0), COL.parapet);
        }
      }
      // piers, one for a pair of tracks
      sincePier += L;
      if (sincePier >= 25 && hasL(i)) {
        const u = Number.isFinite(tw.right[i]) ? tw.right[i] / 2 : 0;
        const p = at(i, u, 0);
        const gnd = s.ground[i];
        const clear = !ctx.onRoad(p[0], p[2], -1.4) && !ctx.inBuilding(p[0], p[2]);
        if (clear && bot(ya) - gnd > 2.5) {
          sincePier = 0;
          ctx.stats.piers++;
          const f = frameOf([p[0], p[2]], dirAt(i));
          box(m.ext, m.col, f, -1.1, 1.1, -0.7, 0.7, gnd - 0.5, bot(ya), COL.viaduct, 0b111100);
        }
      }
    } else if (k === 'station') {
      ctx.stats.stationM += L;
    } else {
      ctx.stats.gradeM += L;
      // ballast either side of the plinths
      quad(m.ext, null, at(i, 2.0, ya - 0.5), at(i, -2.0, ya - 0.5), at(i + 1, -2.0, yb - 0.5), at(i + 1, 2.0, yb - 0.5), COL.trackBed);
    }
  }
}

function pointInRingLocal(x: number, z: number, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export type { Frame, StationPlan, DesignKind };
