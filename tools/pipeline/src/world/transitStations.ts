/**
 * The transit layer, step 3: the stations. A station is its OSM station node and the subway platforms round it, grouped into
 * levels by their layer (Five Points: the East-West platform under the concourse, the North-South one below it). Before the
 * tracks are designed (`planLevels`): each level's frame (the tracks' direction), its platform length and its height from the
 * city pack's depths, which the profile then holds the tracks to. After (`layoutStation`): the platforms between and beside
 * the designed tracks, the hall round them, the concourse with its paid area and fare gates, the shafts of stairs and
 * escalators down to each level, the entrances' stairs from the street and the corridors to the concourse, the spaces under the
 * ground, the furniture, and the little walk network the station's people use. Everything is a box, a slab or a ramp in a
 * level's frame; transitMesh.ts draws it and makes it solid.
 */
import type { Rect, V2 } from '../geo.js';
import type { RawPlatform, RawRoute, RawStation, RawPoint, TransitPack } from './transitData.js';

/** Along `a` (unit, x z) and across `n` = (a.z, -a.x): the local +Z and +X of a box whose yaw is atan2(a.x, a.z). */
export interface Frame {
  o: V2;
  a: V2;
  n: V2;
}

export const frameOf = (o: V2, a: V2): Frame => {
  const l = Math.hypot(a[0], a[1]) || 1;
  const ax: V2 = [a[0] / l, a[1] / l];
  return { o, a: ax, n: [ax[1], -ax[0]] };
};
export const toWorld = (f: Frame, u: number, v: number): V2 => [f.o[0] + u * f.n[0] + v * f.a[0], f.o[1] + u * f.n[1] + v * f.a[1]];
export const toLocal = (f: Frame, x: number, z: number): V2 => {
  const dx = x - f.o[0], dz = z - f.o[1];
  return [dx * f.n[0] + dz * f.n[1], dx * f.a[0] + dz * f.a[1]];
};
export const yawOfFrame = (f: Frame) => Math.atan2(f.a[0], f.a[1]);

export const STATION = {
  /** a car's body side from the track centre plus the gap to the platform edge */
  edgeOffset: 1.68,
  /** the hall's wall beyond a track's centre */
  wallBeyondTrack: 2.4,
  /** a hall runs this far past the platform's ends */
  hallPastPlatform: 6,
  /** the tracks are held level this far past the hall's ends */
  holdPast: 18,
  slab: 0.5,
  concourseHeight: 3.8,
  /** the concourse's ceiling stays this far under the ground */
  cover: 0.6,
  corridorWidth: 4.2,
  corridorHeight: 3.2,
  stairWidth: 3.2,
  /** stairs and escalators: 30 degrees */
  stairSlope: Math.tan((30 * Math.PI) / 180),
  landing: 2.5,
  shaftHeight: 3.4,
  /** the paid area's free margin inside the concourse */
  freeMargin: 4.5,
  gateGap: 0.86,
  gateCabinet: 0.26,
  gatesPerBank: 4,
  sidePlatformWidth: 4.5,
  islandMin: 3.2,
  islandMax: 14,
} as const;

export interface LevelPlan {
  station: number;
  layer: number;
  frame: Frame;
  halfLen: number;
  elevated: boolean;
  platformTop: number;
  rail: number;
  ceiling: number;
  /** raw route indices that stop here */
  routes: number[];
  /** OSM ways of those routes inside the hold box */
  ways: Set<number>;
  osm: RawPlatform[];
  /** after the profile: the tracks' offsets across (one per physical track), the platforms, the hall's walls */
  tracks: { u: number; routes: number[] }[];
  platforms: { kind: 'island' | 'side'; u0: number; u1: number; routes: number[] }[];
  hallU0: number;
  hallU1: number;
}

export interface StationPlan {
  raw: RawStation;
  name: string;
  displayName: string;
  street: number;
  underground: boolean;
  levels: LevelPlan[];
  entrances: RawPoint[];
  concourse: { frame: Frame; hl: number; hw: number; floor: number } | null;
  transfer: boolean;
}

export interface PlanInput {
  stations: RawStation[];
  platforms: RawPlatform[];
  entrances: RawPoint[];
  routes: RawRoute[];
  pack: TransitPack;
  bounds: Rect;
  ground: (x: number, z: number) => number;
  roadUnder: (x: number, z: number) => number;
  displayName: (name: string) => string;
}

/** The nearest point of a polyline to (x, z): its segment, the distance and the unit direction there. */
export function nearestOnChain(pts: V2[], x: number, z: number): { i: number; t: number; d: number; dir: V2; p: V2 } {
  let best = { i: 0, t: 0, d: Infinity, dir: [0, 1] as V2, p: [0, 0] as V2 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const px = a[0] + dx * t, pz = a[1] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const l = Math.sqrt(l2);
      best = { i, t, d, dir: [dx / l, dz / l], p: [px, pz] };
    }
  }
  return best;
}

/** Stations in the tile with their levels, heights and concourses: what the profile holds the tracks to. */
export function planLevels(inp: PlanInput): StationPlan[] {
  const { pack, bounds: b } = inp;
  const D = pack.defaults;
  const plans: StationPlan[] = [];
  const inside = (x: number, z: number, m = 0) => x >= b.minX + m && x <= b.maxX - m && z >= b.minZ + m && z <= b.maxZ - m;
  // one station node per name (a station is often mapped twice)
  const byName = new Map<string, RawStation>();
  for (const s of inp.stations) if (s.name && inside(s.x, s.z, 40) && !byName.has(s.name)) byName.set(s.name, s);
  const stations = [...byName.values()].sort((p, q) => p.osm - q.osm);
  // entrances belong to the nearest station within 320 m
  const entrancesOf = new Map<number, RawPoint[]>();
  for (const e of inp.entrances) {
    let best: RawStation | null = null, bd = 320;
    for (const s of stations) {
      const d = Math.hypot(e.x - s.x, e.z - s.z);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && inside(e.x, e.z, 8)) {
      const l = entrancesOf.get(best.osm) ?? [];
      l.push(e);
      entrancesOf.set(best.osm, l);
    }
  }
  stations.forEach((s, si) => {
    const spec = pack.stations[s.name] ?? {};
    // the platforms of the station, by level
    const mine = inp.platforms.filter((p) => Math.hypot(p.centroid[0] - s.x, p.centroid[1] - s.z) < 190);
    if (mine.length === 0) return;
    const layers = [...new Set(mine.map((p) => p.layer))].sort((p, q) => q - p);
    const ents = (entrancesOf.get(s.osm) ?? []).sort((p, q) => p.osm - q.osm);
    let street = inp.ground(s.x, s.z);
    for (const e of ents) street = Math.max(street, inp.ground(e.x, e.z));
    const levels: LevelPlan[] = [];
    for (const layer of layers) {
      const ps = mine.filter((p) => p.layer === layer);
      const c: V2 = [ps.reduce((a, p) => a + p.centroid[0], 0) / ps.length, ps.reduce((a, p) => a + p.centroid[1], 0) / ps.length];
      // the platforms' long axis (the principal axis of their outlines), then the routes that run along it past them
      let sxx = 0, szz = 0, sxz = 0, nPts = 0;
      for (const p of ps) for (const q of p.ring) {
        const dx = q[0] - c[0], dz = q[1] - c[1];
        sxx += dx * dx; szz += dz * dz; sxz += dx * dz; nPts++;
      }
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const pAxis: V2 = [Math.cos(ang), Math.sin(ang)];
      const routes: number[] = [];
      let dir: V2 | null = null;
      let nearest = Infinity;
      inp.routes.forEach((r, ri) => {
        const q = nearestOnChain(r.pts, c[0], c[1]);
        if (q.d > 16) return;
        if (nPts >= 4 && Math.abs(q.dir[0] * pAxis[0] + q.dir[1] * pAxis[1]) < 0.8) return;
        routes.push(ri);
        if (q.d < nearest) {
          nearest = q.d;
          dir = q.dir;
        }
      });
      if (!dir || routes.length === 0) continue;
      let f = frameOf(c, dir);
      // the platform's extent along, from the OSM outlines
      let v0 = Infinity, v1 = -Infinity;
      for (const p of ps) for (const q of p.ring) {
        const [, v] = toLocal(f, q[0], q[1]);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      const mid = (v0 + v1) / 2;
      f = frameOf(toWorld(f, 0, mid), f.a);
      const halfLen = Math.max((v1 - v0) / 2, D.minPlatformM / 2);
      const elevated = layer > 0;
      const depthKey = String(layer);
      const depth = spec.depth?.[depthKey] ?? (elevated ? D.depthElevated : D.depthUnderground);
      let platformTop: number;
      if (elevated) {
        // over the middle of the ground under it (the ground under a viaduct can fall away steeply), and over every road under it
        const gs: number[] = [];
        let road = -Infinity;
        for (let v = -halfLen; v <= halfLen; v += 8) for (const u of [-8, 0, 8]) {
          const [x, z] = toWorld(f, u, v);
          gs.push(inp.ground(x, z));
          road = Math.max(road, inp.roadUnder(x, z));
        }
        gs.sort((p, q) => p - q);
        const g = gs[Math.floor(gs.length / 2)];
        platformTop = Math.max(g - depth, road + 6.4 + D.platformHeight);
      } else platformTop = street - depth;
      levels.push({ station: si, layer, frame: f, halfLen, elevated, platformTop, rail: platformTop - D.platformHeight, ceiling: platformTop + D.hallHeight, routes, ways: new Set(), osm: ps, tracks: [], platforms: [], hallU0: 0, hallU1: 0 });
    }
    if (levels.length === 0) return;
    const underground = levels.some((l) => !l.elevated);
    let concourse: StationPlan['concourse'] = null;
    if (underground) {
      const top = levels.filter((l) => !l.elevated).sort((p, q) => q.platformTop - p.platformTop)[0];
      const [cl, cw] = spec.concourse ?? D.concourse;
      const cf = top.frame;
      // the concourse and the corridors to the entrances stay under the ground: the floor from the lowest ground over them
      let gmin = Infinity;
      for (let v = -cl / 2; v <= cl / 2; v += 4) for (let u = -cw / 2; u <= cw / 2; u += 4) {
        const [x, z] = toWorld(cf, u, v);
        gmin = Math.min(gmin, inp.ground(x, z));
      }
      for (const e of ents) {
        const L = Math.hypot(e.x - cf.o[0], e.z - cf.o[1]);
        for (let k = 0; k <= L; k += 4) {
          const t = k / Math.max(1, L);
          gmin = Math.min(gmin, inp.ground(cf.o[0] + (e.x - cf.o[0]) * t, cf.o[1] + (e.z - cf.o[1]) * t));
        }
      }
      const floor = gmin - STATION.cover - Math.max(STATION.concourseHeight, STATION.corridorHeight) - STATION.slab;
      concourse = { frame: cf, hl: cl / 2, hw: cw / 2, floor };
      // the levels under it: each hall's ceiling a slab under what is over it
      let over = floor - STATION.slab;
      for (const l of levels.filter((q) => !q.elevated).sort((p, q) => q.platformTop - p.platformTop)) {
        l.platformTop = Math.min(l.platformTop, over - D.hallHeight);
        l.rail = l.platformTop - D.platformHeight;
        l.ceiling = l.platformTop + D.hallHeight;
        over = l.rail - 0.3 - STATION.slab;
      }
    }
    plans.push({ raw: s, name: s.name, displayName: inp.displayName(s.name), street, underground, levels, entrances: ents, concourse, transfer: !!spec.transfer });
  });
  // the ways each level holds
  for (const st of plans) for (const l of st.levels) {
    for (const ri of l.routes) {
      const r = inp.routes[ri];
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [u, v] = toLocal(l.frame, r.pts[i][0], r.pts[i][1]);
        const [u2, v2] = toLocal(l.frame, r.pts[i + 1][0], r.pts[i + 1][1]);
        if (Math.min(Math.abs(u), Math.abs(u2)) < 20 && Math.min(v, v2) < l.halfLen + STATION.hallPastPlatform + STATION.holdPast && Math.max(v, v2) > -(l.halfLen + STATION.hallPastPlatform + STATION.holdPast)) l.ways.add(r.way[i]);
      }
    }
  }
  return plans;
}

/** The held rail height at (x, z) on a way: inside a level's hold box (its hall and a little past), on a way of its routes. */
export function holdAt(plans: StationPlan[], x: number, z: number, way: number): number {
  for (const st of plans) for (const l of st.levels) {
    if (!l.ways.has(way)) continue;
    const [u, v] = toLocal(l.frame, x, z);
    if (Math.abs(u) < 20 && Math.abs(v) <= l.halfLen + STATION.hallPastPlatform + STATION.holdPast) return l.rail;
  }
  return NaN;
}

/**
 * After the profile: where the designed tracks run across each level (one offset per physical track, routes on the same
 * track merged), and the platforms between and beside them.
 */
export function placePlatforms(plans: StationPlan[], routePts: V2[][], routeWays: number[][]): void {
  for (const st of plans) for (const l of st.levels) {
    const tracks: { u: number; routes: number[] }[] = [];
    for (const ri of l.routes) {
      const q = nearestOnChain(routePts[ri], l.frame.o[0], l.frame.o[1]);
      const [u] = toLocal(l.frame, q.p[0], q.p[1]);
      const t = tracks.find((k) => Math.abs(k.u - u) < 1.0);
      if (t) t.routes.push(ri);
      else tracks.push({ u, routes: [ri] });
    }
    void routeWays;
    tracks.sort((p, q) => p.u - q.u);
    l.tracks = tracks;
    const E = STATION.edgeOffset;
    // what OSM says: the platforms' offsets across
    const pu = l.osm.map((p) => toLocal(l.frame, p.centroid[0], p.centroid[1])[0]).sort((p, q) => p - q);
    const platforms: LevelPlan['platforms'] = [];
    if (tracks.length >= 2) {
      // an island between two tracks when an OSM platform lies between them; side platforms outside
      for (let k = 0; k + 1 < tracks.length; k++) {
        const a = tracks[k], bb = tracks[k + 1];
        if (pu.some((u) => u > a.u + 0.5 && u < bb.u - 0.5) && bb.u - a.u > 2 * E + STATION.islandMin - 0.5) {
          platforms.push({ kind: 'island', u0: a.u + E, u1: bb.u - E, routes: [...a.routes, ...bb.routes] });
        }
      }
      if (platforms.length === 0) {
        const first = tracks[0], last = tracks[tracks.length - 1];
        platforms.push({ kind: 'side', u0: first.u - E - STATION.sidePlatformWidth, u1: first.u - E, routes: [...first.routes] });
        platforms.push({ kind: 'side', u0: last.u + E, u1: last.u + E + STATION.sidePlatformWidth, routes: [...last.routes] });
      }
    } else if (tracks.length === 1) {
      const t = tracks[0];
      const side = (pu[0] ?? t.u + 1) > t.u ? 1 : -1;
      platforms.push(side > 0 ? { kind: 'side', u0: t.u + E, u1: t.u + E + STATION.sidePlatformWidth, routes: [...t.routes] } : { kind: 'side', u0: t.u - E - STATION.sidePlatformWidth, u1: t.u - E, routes: [...t.routes] });
    }
    l.platforms = platforms;
    let u0 = Infinity, u1 = -Infinity;
    for (const t of tracks) {
      u0 = Math.min(u0, t.u - STATION.wallBeyondTrack);
      u1 = Math.max(u1, t.u + STATION.wallBeyondTrack);
    }
    for (const p of platforms) {
      u0 = Math.min(u0, p.u0);
      u1 = Math.max(u1, p.u1);
    }
    l.hallU0 = u0;
    l.hallU1 = u1;
  }
}

/** An oriented box in a frame: u across, v along, y up (all ranges). */
export interface LocalBox {
  frame: Frame;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  y0: number;
  y1: number;
}

/** A ramp (stairs or an escalator) in a frame: from (v0, y0) to (v1, y1) along, u0..u1 across. */
export interface Ramp {
  frame: Frame;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  y0: number;
  y1: number;
  kind: 'stairs' | 'escalator' | 'mixed';
}

export interface StationLayout {
  plan: StationPlan;
  halls: LocalBox[];
  concourse: LocalBox | null;
  /** holes in the concourse floor and in the halls' ceilings where shafts pass: boxes in the same frame as what they cut */
  floorHoles: LocalBox[];
  ceilingHoles: { hall: number; box: LocalBox }[];
  paid: LocalBox | null;
  gates: { frame: Frame; u: number; v: number; inward: V2; y: number }[];
  /** railings: segments [x0, z0, x1, z1, y] */
  railings: [number, number, number, number, number][];
  shafts: { ramp: Ramp; box: LocalBox; level: number }[];
  corridors: LocalBox[];
  stairs: { ramp: Ramp; entrance: RawPoint; top: [number, number, number]; foot: [number, number, number]; yaw: number }[];
  /** elevated levels: the platform decks and the stair down to the street at each */
  decks: LocalBox[];
  /** the landings at the top of an elevated side platform's stair, beside the platform (drawn and solid, an opening in its railing) */
  landings: LocalBox[];
}

export interface LayoutInput {
  /** inside a building's footprint */
  inBuilding: (x: number, z: number) => boolean;
  onRoad: (x: number, z: number, margin: number) => boolean;
  /** other things a stairwell must keep clear of (lamps, trees, bins, bus stops): points */
  obstacles: V2[];
  ground: (x: number, z: number) => number;
  bounds: Rect;
  hallHeight: number;
}

const boxOverlap2d = (a: LocalBox, b: LocalBox, pad = 0): boolean => {
  // separating axis test of two oriented rectangles
  const corners = (q: LocalBox): V2[] => [toWorld(q.frame, q.u0, q.v0), toWorld(q.frame, q.u1, q.v0), toWorld(q.frame, q.u1, q.v1), toWorld(q.frame, q.u0, q.v1)];
  const ca = corners(a), cb = corners(b);
  for (const [box, other] of [[a, cb], [b, ca]] as [LocalBox, V2[]][]) {
    const loc = other.map((p) => toLocal(box.frame, p[0], p[1]));
    if (Math.max(...loc.map((p) => p[0])) < box.u0 - pad || Math.min(...loc.map((p) => p[0])) > box.u1 + pad) return false;
    if (Math.max(...loc.map((p) => p[1])) < box.v0 - pad || Math.min(...loc.map((p) => p[1])) > box.v1 + pad) return false;
  }
  return true;
};

/** Lays a station out: halls, concourse, shafts, entrances, gates, railings. */
export function layoutStation(st: StationPlan, inp: LayoutInput): StationLayout {
  const out: StationLayout = { plan: st, halls: [], concourse: null, floorHoles: [], ceilingHoles: [], paid: null, gates: [], railings: [], shafts: [], corridors: [], stairs: [], decks: [], landings: [] };
  const H = inp.hallHeight;
  for (const l of st.levels) {
    const v0 = -l.halfLen - STATION.hallPastPlatform, v1 = l.halfLen + STATION.hallPastPlatform;
    if (l.elevated) {
      for (const p of l.platforms) out.decks.push({ frame: l.frame, u0: p.u0, u1: p.u1, v0: -l.halfLen, v1: l.halfLen, y0: l.platformTop - 0.9, y1: l.platformTop });
      out.halls.push({ frame: l.frame, u0: l.hallU0, u1: l.hallU1, v0, v1, y0: l.rail - 0.4, y1: l.ceiling });
    } else out.halls.push({ frame: l.frame, u0: l.hallU0, u1: l.hallU1, v0, v1, y0: l.rail - 0.4, y1: l.platformTop + H });
  }
  const S = STATION.stairSlope;
  if (st.underground && st.concourse) {
    const c = st.concourse;
    const cf = c.frame;
    let cu0 = -c.hw, cu1 = c.hw, cv0 = -c.hl, cv1 = c.hl;
    // a shaft per underground level, down from the concourse floor onto the platform, clear of the other halls
    const tops: { u: number; v: number }[] = [];
    st.levels.forEach((l, li) => {
      if (l.elevated || l.platforms.length === 0) return;
      const p = [...l.platforms].sort((a, b) => b.u1 - b.u0 - (a.u1 - a.u0))[0];
      // a stair down the middle of the island, with a 2.2 m walk past it either side
      const width = Math.max(2.4, Math.min(5.0, p.u1 - p.u0 - 4.4));
      const uc = (p.u0 + p.u1) / 2;
      const rise = c.floor - l.platformTop;
      const run = rise / S;
      const len = run + 2 * STATION.landing;
      let chosen: { ramp: Ramp; box: LocalBox } | null = null;
      // try along-positions from the middle outward, both ways down
      for (let k = 0; k < 40 && !chosen; k++) {
        const off = (k % 2 === 0 ? 1 : -1) * Math.floor((k + 1) / 2) * 3;
        for (const down of [1, -1]) {
          const vTop = off - (down * len) / 2;
          const vBot = off + (down * len) / 2;
          if (Math.max(vTop, vBot) > l.halfLen - 3 || Math.min(vTop, vBot) < -l.halfLen + 3) continue;
          const box: LocalBox = { frame: l.frame, u0: uc - width / 2, u1: uc + width / 2, v0: Math.min(vTop, vBot), v1: Math.max(vTop, vBot), y0: l.platformTop, y1: c.floor + STATION.concourseHeight };
          // clear of the other levels' halls in plan (except where it lands)
          const clash = out.halls.some((h, hi) => hi !== li && !st.levels[hi].elevated && h.y1 > l.platformTop && h.y0 < c.floor && boxOverlap2d(h, box, 1.0));
          if (clash) continue;
          const ramp: Ramp = { frame: l.frame, u0: box.u0, u1: box.u1, v0: vTop + down * STATION.landing, v1: vBot - down * STATION.landing, y0: c.floor, y1: l.platformTop, kind: 'mixed' };
          chosen = { ramp, box };
          break;
        }
      }
      if (!chosen) return;
      out.shafts.push({ ...chosen, level: li });
      const topV = chosen.ramp.v0 - Math.sign(chosen.ramp.v1 - chosen.ramp.v0) * STATION.landing * 0.5;
      const [tx, tz] = toWorld(l.frame, uc, topV);
      const [tu, tv] = toLocal(cf, tx, tz);
      tops.push({ u: tu, v: tv });
      // the concourse grows to hold the shaft's top landing and its opening in the floor, with the paid area's margin and the
      // free ring round it (a railing of the paid area must never cross the opening)
      const m = STATION.freeMargin + 3;
      const r = chosen.ramp;
      const dir = Math.sign(r.v1 - r.v0);
      const vHole = r.v0 + dir * ((STATION.shaftHeight + STATION.slab) / S);
      const corners: V2[] = [[r.u0, topV], [r.u1, topV], [r.u0, vHole], [r.u1, vHole]];
      for (const [u, v] of corners) {
        const [x, z] = toWorld(l.frame, u, v);
        const [cu, cv] = toLocal(cf, x, z);
        cu0 = Math.min(cu0, cu - m);
        cu1 = Math.max(cu1, cu + m);
        cv0 = Math.min(cv0, cv - m);
        cv1 = Math.max(cv1, cv + m);
      }
    });
    out.concourse = { frame: cf, u0: cu0, u1: cu1, v0: cv0, v1: cv1, y0: c.floor, y1: c.floor + STATION.concourseHeight };
    // holes: in the concourse floor over each shaft, and in the hall's ceiling where the shaft comes down into it
    for (const sh of out.shafts) {
      const r = sh.ramp;
      const dir = Math.sign(r.v1 - r.v0);
      // the hole runs from the top step to where the shaft's ceiling has gone under the concourse floor
      const vHole = r.v0 + dir * ((STATION.shaftHeight + STATION.slab) / S);
      out.floorHoles.push({ frame: r.frame, u0: r.u0, u1: r.u1, v0: Math.min(r.v0, vHole), v1: Math.max(r.v0, vHole), y0: c.floor - 1, y1: c.floor + 1 });
      const l = st.levels[sh.level];
      // where the stair's headroom (3.4 m) rises above the hall's ceiling
      const vCut = r.v1 - dir * ((l.ceiling - l.platformTop - 0.2 + STATION.shaftHeight) / S);
      out.ceilingHoles.push({ hall: sh.level, box: { frame: r.frame, u0: r.u0, u1: r.u1, v0: Math.min(vCut, r.v1 + dir * STATION.landing), v1: Math.max(vCut, r.v1 + dir * STATION.landing), y0: l.ceiling - 1, y1: l.ceiling + 1 } });
    }
    // the paid area: round the shaft tops and their holes, inside the concourse with a free margin
    let pu0 = Infinity, pu1 = -Infinity, pv0 = Infinity, pv1 = -Infinity;
    const hold = (x: number, z: number) => {
      const [u, v] = toLocal(cf, x, z);
      pu0 = Math.min(pu0, u); pu1 = Math.max(pu1, u); pv0 = Math.min(pv0, v); pv1 = Math.max(pv1, v);
    };
    for (const h of out.floorHoles) {
      for (const [u, v] of [[h.u0, h.v0], [h.u1, h.v0], [h.u1, h.v1], [h.u0, h.v1]] as V2[]) {
        const [x, z] = toWorld(h.frame, u, v);
        // only the part inside the concourse
        const [cu, cv] = toLocal(cf, x, z);
        if (cu >= cu0 && cu <= cu1 && cv >= cv0 && cv <= cv1) hold(x, z);
      }
    }
    for (const t of tops) {
      const [x, z] = toWorld(cf, t.u, t.v);
      hold(x, z);
    }
    if (Number.isFinite(pu0)) {
      const m = 2.5;
      const P: LocalBox = {
        frame: cf,
        u0: Math.max(cu0 + STATION.freeMargin, pu0 - m),
        u1: Math.min(cu1 - STATION.freeMargin, pu1 + m),
        v0: Math.max(cv0 + STATION.freeMargin, pv0 - m),
        v1: Math.min(cv1 - STATION.freeMargin, pv1 + m),
        y0: c.floor,
        y1: c.floor + 1.0,
      };
      out.paid = P;
      // gate banks in the middle of the two long sides of the paid area; railings along the rest of its edge
      const bank = STATION.gatesPerBank * STATION.gateGap + (STATION.gatesPerBank + 1) * STATION.gateCabinet;
      const longAlongV = P.v1 - P.v0 >= P.u1 - P.u0;
      const sides: { a: V2; b: V2; inward: V2 }[] = [
        { a: [P.u0, P.v0], b: [P.u0, P.v1], inward: [1, 0] },
        { a: [P.u1, P.v0], b: [P.u1, P.v1], inward: [-1, 0] },
        { a: [P.u0, P.v0], b: [P.u1, P.v0], inward: [0, 1] },
        { a: [P.u0, P.v1], b: [P.u1, P.v1], inward: [0, -1] },
      ];
      sides.forEach((sd, k) => {
        const isLong = longAlongV ? k < 2 : k >= 2;
        const len = Math.hypot(sd.b[0] - sd.a[0], sd.b[1] - sd.a[1]);
        const d: V2 = [(sd.b[0] - sd.a[0]) / len, (sd.b[1] - sd.a[1]) / len];
        const seg = (t0: number, t1: number) => {
          if (t1 - t0 < 0.05) return;
          const [x0, z0] = toWorld(cf, sd.a[0] + d[0] * t0, sd.a[1] + d[1] * t0);
          const [x1, z1] = toWorld(cf, sd.a[0] + d[0] * t1, sd.a[1] + d[1] * t1);
          out.railings.push([x0, z0, x1, z1, c.floor]);
        };
        if (isLong && len > bank + 1) {
          const t0 = (len - bank) / 2;
          seg(0, t0);
          seg(t0 + bank, len);
          for (let g = 0; g < STATION.gatesPerBank; g++) {
            const t = t0 + STATION.gateCabinet + g * (STATION.gateGap + STATION.gateCabinet) + STATION.gateGap / 2;
            const lu = sd.a[0] + d[0] * t, lv = sd.a[1] + d[1] * t;
            const inw: V2 = [cf.n[0] * sd.inward[0] + cf.a[0] * sd.inward[1], cf.n[1] * sd.inward[0] + cf.a[1] * sd.inward[1]];
            out.gates.push({ frame: cf, u: lu, v: lv, inward: inw, y: c.floor });
          }
        } else seg(0, len);
      });
    }
    // railings round the floor holes (but not at the top of the stairs)
    for (const sh of out.shafts) {
      const r = sh.ramp;
      const dir = Math.sign(r.v1 - r.v0);
      const vTop = r.v0, vFar = r.v0 + dir * ((STATION.shaftHeight + STATION.slab) / S);
      const edges: [number, number, number, number][] = [
        [r.u0, vTop, r.u0, vFar],
        [r.u1, vTop, r.u1, vFar],
        [r.u0, vFar, r.u1, vFar],
      ];
      for (const [u0, v0, u1, v1] of edges) {
        // inside the concourse only
        const steps = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 1));
        let run: [number, number] | null = null;
        const flush = () => {
          if (!run) return;
          const [a, b] = run;
          const [x0, z0] = toWorld(r.frame, u0 + ((u1 - u0) * a) / steps, v0 + ((v1 - v0) * a) / steps);
          const [x1, z1] = toWorld(r.frame, u0 + ((u1 - u0) * b) / steps, v0 + ((v1 - v0) * b) / steps);
          if (b > a) out.railings.push([x0, z0, x1, z1, c.floor]);
          run = null;
        };
        for (let k = 0; k <= steps; k++) {
          const [x, z] = toWorld(r.frame, u0 + ((u1 - u0) * k) / steps, v0 + ((v1 - v0) * k) / steps);
          const [cu, cv] = toLocal(cf, x, z);
          const inC = cu >= cu0 - 0.01 && cu <= cu1 + 0.01 && cv >= cv0 - 0.01 && cv <= cv1 + 0.01;
          if (inC) run = run ? [run[0], k] : [k, k];
          else flush();
        }
        flush();
      }
    }
    // no railing may cross an opening in the floor (the stair goes down under it): cut those out
    out.railings = out.railings.filter(([x0, z0, x1, z1]) => {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      return !out.floorHoles.some((h) => {
        const [u, v] = toLocal(h.frame, mx, mz);
        return u > h.u0 + 0.2 && u < h.u1 - 0.2 && v > h.v0 + 0.2 && v < h.v1 - 0.2;
      });
    });
    // entrances: a stair down from the street, then a corridor to the concourse
    const C = out.concourse;
    st.entrances.forEach((e) => {
      const placed = placeEntrance(e, C, inp, out);
      if (placed) out.stairs.push(placed.stair), out.corridors.push(...placed.corridors);
    });
  }
  // elevated platforms: a stair from each platform down to the street, with the fare gates across its foot
  st.levels.forEach((l) => {
    if (!l.elevated) return;
    for (const p of l.platforms) {
      const placed = placeElevatedStair(l, p, inp, out);
      if (!placed) continue;
      out.stairs.push(placed.stair);
      for (const g of placed.gates) out.gates.push(g);
      out.railings.push(...placed.railings);
      if (placed.landing) out.landings.push(placed.landing);
    }
  });
  return out;
}

/**
 * The stair of an elevated platform: inside an island (through a hole in the deck, down to the ground under the viaduct) or
 * outboard of a side platform, running along it; the first way that lands on clear ground. Its foot is the station's entrance.
 */
function placeElevatedStair(l: LevelPlan, p: LevelPlan['platforms'][number], inp: LayoutInput, out: StationLayout): { stair: StationLayout['stairs'][number]; gates: StationLayout['gates']; railings: StationLayout['railings']; landing: LocalBox | null } | null {
  const S = STATION.stairSlope;
  const W = STATION.stairWidth;
  const f = l.frame;
  // (a side platform's stair stands a metre off its edge, so a climber does not brush the deck's side; the landing bridges the gap)
  const uOptions: [number, number][] = p.kind === 'island' ? [[(p.u0 + p.u1) / 2 - W / 2, (p.u0 + p.u1) / 2 + W / 2]] : p.u0 < 0 ? [[p.u0 - W - 1.0, p.u0 - 1.0]] : [[p.u1 + 1.0, p.u1 + 1.0 + W]];
  for (const [u0, u1] of uOptions) {
    for (const start of [10, -10, 30, -30, 50, -50]) {
      for (const dir of [1, -1]) {
        const gFoot0 = inp.ground(...toWorld(f, (u0 + u1) / 2, start));
        const rise = l.platformTop - gFoot0;
        if (rise < 1.5) continue;
        const run = rise / S;
        const vTop = start, vFoot = start + dir * run;
        if (p.kind === 'island' && (Math.abs(vFoot) > l.halfLen - 2 || Math.abs(vTop) > l.halfLen - 2)) continue;
        const gFoot = inp.ground(...toWorld(f, (u0 + u1) / 2, vFoot));
        const rise2 = l.platformTop - gFoot;
        if (Math.abs(rise2 - rise) > 1.5) continue;
        // the foot and a landing past it on clear ground
        let ok = true;
        for (let v = Math.min(vFoot, vFoot + dir * 4); v <= Math.max(vFoot, vFoot + dir * 4) && ok; v += 1) for (let u = u0; u <= u1 + 1e-6 && ok; u += 0.8) {
          const [x, z] = toWorld(f, u, v);
          if (inp.inBuilding(x, z) || inp.onRoad(x, z, -0.3)) ok = false;
          if (x < inp.bounds.minX + 6 || x > inp.bounds.maxX - 6 || z < inp.bounds.minZ + 6 || z > inp.bounds.maxZ - 6) ok = false;
        }
        // the whole stair clear of buildings, and its low part (under a car's clearance) off the carriageways
        for (let v = Math.min(vTop, vFoot); v <= Math.max(vTop, vFoot) && ok; v += 1) for (let u = u0; u <= u1 + 1e-6 && ok; u += 0.8) {
          const [x, z] = toWorld(f, u, v);
          const y = l.platformTop + ((gFoot - l.platformTop) * (v - vTop)) / (vFoot - vTop);
          if (inp.inBuilding(x, z) || (y - inp.ground(x, z) < 4.8 && inp.onRoad(x, z, -0.3))) ok = false;
          // the ground must stay under the stair (rising ground would leave a walker under it)
          if (inp.ground(x, z) > y + 0.05 && Math.abs(v - vFoot) > 0.8) ok = false;
        }
        if (!ok) continue;
        const ramp: Ramp = { frame: f, u0, u1, v0: vTop, v1: vFoot, y0: l.platformTop, y1: gFoot, kind: 'stairs' };
        const top = toWorld(f, (u0 + u1) / 2, vTop);
        const foot = toWorld(f, (u0 + u1) / 2, vFoot);
        // three gates across the landing at the foot, a little past it; the paid side is the stair's
        const gates: StationLayout['gates'] = [];
        const vg = vFoot + dir * 2.2;
        const n = 3;
        const span = n * STATION.gateGap + (n + 1) * STATION.gateCabinet;
        const uc = (u0 + u1) / 2;
        for (let g = 0; g < n; g++) {
          const u = uc - span / 2 + STATION.gateCabinet + g * (STATION.gateGap + STATION.gateCabinet) + STATION.gateGap / 2;
          gates.push({ frame: f, u, v: vg, inward: [-f.a[0] * dir, -f.a[1] * dir], y: gFoot });
        }
        const railings: StationLayout['railings'] = [];
        // the landing's sides, from the stair's foot to the gate line
        for (const uu of [u0, u1]) {
          const [x0, z0] = toWorld(f, uu, vFoot);
          const [x1, z1] = toWorld(f, uu, vg);
          railings.push([x0, z0, x1, z1, gFoot]);
        }
        // the gate line's ends beyond the bank
        for (const [ua, ub] of [[u0, uc - span / 2], [uc + span / 2, u1]] as V2[]) {
          if (ub - ua < 0.05) continue;
          const [x0, z0] = toWorld(f, ua, vg);
          const [x1, z1] = toWorld(f, ub, vg);
          railings.push([x0, z0, x1, z1, gFoot]);
        }
        const yaw = Math.atan2(f.a[0] * dir, f.a[1] * dir);
        const ent: RawPoint = { osm: 0, x: foot[0], z: foot[1], name: '' };
        // a ped walks from the street up: the "top" of this entrance is the street end
        // a side platform's stair starts from a landing beside the platform
        const landing: LocalBox | null = p.kind === 'side' ? { frame: f, u0: Math.min(u0, p.u0 < 0 ? u1 : p.u1) - (p.u0 < 0 ? 0 : 0.3), u1: Math.max(u1, p.u0 < 0 ? p.u0 : u0) + (p.u0 < 0 ? 0.3 : 0), v0: Math.min(vTop, vTop - dir * 2.6), v1: Math.max(vTop, vTop - dir * 2.6), y0: l.platformTop - 0.5, y1: l.platformTop } : null;
        return { stair: { ramp, entrance: ent, top: [foot[0], gFoot, foot[1]], foot: [top[0], l.platformTop, top[1]], yaw: yaw + Math.PI }, gates, railings, landing };
      }
    }
  }
  void out;
  return null;
}

/** The stair of an entrance: a clear spot for its well near the OSM node, the stair along the most natural way down. */
function placeEntrance(e: RawPoint, C: LocalBox, inp: LayoutInput, out: StationLayout): { stair: StationLayout['stairs'][number]; corridors: LocalBox[] } | null {
  const S = STATION.stairSlope;
  const W = STATION.stairWidth;
  const cf = C.frame;
  const [cu, cv] = toLocal(cf, e.x, e.z);
  // toward the concourse
  const nu = Math.max(C.u0, Math.min(C.u1, cu)), nv = Math.max(C.v0, Math.min(C.v1, cv));
  const [px, pz] = toWorld(cf, nu, nv);
  const toward = Math.atan2(px - e.x, pz - e.z);
  const cands: { x: number; z: number; yaw: number; score: number }[] = [];
  for (const dyaw of [0, 0.5, -0.5, 1.05, -1.05, 1.57, -1.57, 2.1, -2.1, Math.PI]) {
    for (const r of [0, 2, 4, 6, 9]) {
      for (let k = 0; k < (r === 0 ? 1 : 8); k++) {
        const a = (k / 8) * Math.PI * 2;
        cands.push({ x: e.x + Math.cos(a) * r, z: e.z + Math.sin(a) * r, yaw: toward + dyaw, score: r + Math.abs(dyaw) * 4 });
      }
    }
  }
  cands.sort((p, q) => p.score - q.score);
  for (const cand of cands) {
    const gTop = inp.ground(cand.x, cand.z);
    const rise = gTop - C.y0;
    if (rise < 1) return null;
    const run = rise / S;
    const f = frameOf([cand.x, cand.z], [Math.sin(cand.yaw), Math.cos(cand.yaw)]);
    const well: LocalBox = { frame: f, u0: -W / 2 - 0.25, u1: W / 2 + 0.25, v0: -0.6, v1: run + 0.4, y0: C.y0, y1: gTop + 3 };
    // the well (and its canopy) must be clear of buildings, carriageways, poles and trees, other wells, and the tile's edge
    let ok = true;
    for (let v = well.v0; v <= well.v1 && ok; v += 1) for (let u = well.u0; u <= well.u1 + 1e-6 && ok; u += 0.9) {
      const [x, z] = toWorld(f, u, v);
      if (inp.inBuilding(x, z) || inp.onRoad(x, z, -0.4)) ok = false;
      if (x < inp.bounds.minX + 6 || x > inp.bounds.maxX - 6 || z < inp.bounds.minZ + 6 || z > inp.bounds.maxZ - 6) ok = false;
    }
    if (!ok) continue;
    if (inp.obstacles.some((o) => {
      const [u, v] = toLocal(f, o[0], o[1]);
      return u > well.u0 - 0.4 && u < well.u1 + 0.4 && v > well.v0 - 0.4 && v < well.v1 + 0.4;
    })) continue;
    if (out.stairs.some((s) => boxOverlap2d({ frame: s.ramp.frame, u0: s.ramp.u0 - 1, u1: s.ramp.u1 + 1, v0: s.ramp.v0 - 1, v1: s.ramp.v1 + 1, y0: 0, y1: 0 }, well, 1))) continue;
    // the ground along the well must not stand much higher than the top (a stair that starts in a bank)
    let gmax = -Infinity;
    for (let v = 0; v <= run; v += 2) gmax = Math.max(gmax, inp.ground(...toWorld(f, 0, v)));
    if (gmax > gTop + 0.6) continue;
    const footV = run;
    const [fx, fz] = toWorld(f, 0, footV);
    // the foot must be outside the concourse, or the stair would come down through its ceiling
    const [fu, fv] = toLocal(cf, fx, fz);
    const insideC = fu > C.u0 - 1 && fu < C.u1 + 1 && fv > C.v0 - 1 && fv < C.v1 + 1;
    if (insideC) continue;
    // the corridor: on along the stair's direction for a landing, then straight to the nearest point of the concourse
    const ramp: Ramp = { frame: f, u0: -W / 2, u1: W / 2, v0: 0, v1: run, y0: gTop, y1: C.y0, kind: 'stairs' };
    const land: V2 = toWorld(f, 0, run + STATION.landing);
    const corridors: LocalBox[] = [];
    const [lu, lv] = toLocal(cf, land[0], land[1]);
    const tu = Math.max(C.u0 + 2.5, Math.min(C.u1 - 2.5, lu)), tv = Math.max(C.v0 + 2.5, Math.min(C.v1 - 2.5, lv));
    const target = toWorld(cf, tu, tv);
    const legs: [V2, V2][] = [[[fx, fz], land], [land, target]];
    for (const [a, b] of legs) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.5) continue;
      const lf = frameOf(a, [b[0] - a[0], b[1] - a[1]]);
      corridors.push({ frame: lf, u0: -STATION.corridorWidth / 2, u1: STATION.corridorWidth / 2, v0: -STATION.corridorWidth / 2, v1: L + STATION.corridorWidth / 2, y0: C.y0, y1: C.y0 + STATION.corridorHeight });
    }
    // the second leg must not run back under the stair
    const back = corridors[1];
    if (back && boxOverlap2d(back, { frame: f, u0: -W / 2, u1: W / 2, v0: 0, v1: run - STATION.corridorHeight / S - 0.5, y0: 0, y1: 0 }, 0)) continue;
    return { stair: { ramp, entrance: e, top: [cand.x, gTop, cand.z], foot: [fx, C.y0, fz], yaw: cand.yaw }, corridors };
  }
  return null;
}
