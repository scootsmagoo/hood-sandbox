/**
 * `aeroway.json`: the airport of a grid, whole, in the city frame (written next to the grid's index.json by the bake's `aeroway`
 * step, after the seam pass, so its heights are the tiles' own). The sim moves the aircraft on it (src/sim/aircraft), the
 * client draws the airfield lights and the map from it (src/client/render/aircraft, the minimap layer). Format
 * (`src/shared/aeroway.ts` parses it):
 *
 *   runways  ref, width, length, and both ends: designator, the physical end and the threshold ([x, y, z]), the direction
 *            along the runway from that end (unit [dx, dz]), and the graph nodes along its centreline in that order
 *   nodes    [x, y, z] of the taxi graph (runway centrelines, taxiways, taxilanes, the stands' lead-in lines)
 *   edges    { a, b, kind: runway | taxiway | taxilane | leadin, ref, width, len, pts: flat [x, y, z, ...] from a to b }
 *   stands   { ref, gate (the gate's ref, if any), hero (the building), node (where the nose gear stops), entry (where its
 *            lead-in leaves the taxi network), yaw (the parked nose (sin, cos)), size (narrowbody | widebody | regional),
 *            cargo }
 *   holds    { node, runway (index), ils }: the runway holding positions on the graph
 *   lights   flat [x, y, z, ...] lists: runway edge, centreline, threshold (green), runway end (red), touchdown zone, taxiway
 *            centreline (green), taxiway edge (blue), the approach lights (with the distance from the threshold in a 4th
 *            number for the sequenced flashers: `approach` is [x, y, z, d, ...]), and the apron floodlights' heads
 *   map      runways (outline rings), taxiways (centrelines and widths), aprons (rings), buildings (named outlines), labels
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, type CityGridSpec } from '../config.js';
import type { Projector, V2 } from '../geo.js';
import { simplifyLine } from '../geo.js';
import { readHeightmap } from '../io/binary.js';
import type { OsmData } from '../sources/osm.js';
import { parseAirport, type Airport, type AeroLine } from './aeroway.js';
import { CLOSE_R, DECK_MIN } from './aerowaySurface.js';

export interface AerowayFile {
  format: 'hood-aeroway';
  version: 1;
  icao: string;
  name: string;
  runways: { ref: string; width: number; length: number; ends: { ref: string; end: number[]; threshold: number[]; dir: number[]; nodes: number[] }[] }[];
  nodes: number[][];
  edges: { a: number; b: number; kind: string; ref: string | null; width: number; len: number; pts: number[] }[];
  stands: { ref: string; gate: string | null; hero: string | null; node: number; entry: number; yaw: number; size: string; cargo: boolean }[];
  holds: { node: number; runway: number; ils: boolean }[];
  lights: Record<string, number[]>;
  map: { runways: number[][]; taxiways: { w: number; pts: number[] }[]; aprons: number[][]; buildings: { name: string; ring: number[] }[]; labels: { name: string; x: number; z: number; kind: string }[] };
  stats: Record<string, number>;
}

/** The ground of the baked tiles (city frame), and the airfield's surface over a cut (where the heightmap is the cut's floor). */
export class GridGround {
  private readonly tiles = new Map<string, { minX: number; minZ: number; cell: number; cols: number; rows: number; h: Float32Array }>();
  constructor(readonly tileSize: number, dirs: { i: number; j: number; dir: string }[]) {
    for (const d of dirs) {
      const t = JSON.parse(readFileSync(path.join(d.dir, 'tile.json'), 'utf8'));
      const h = readHeightmap(readFileSync(path.join(d.dir, t.heightmap.file)));
      this.tiles.set(`${d.i}_${d.j}`, { minX: t.heightmap.minX, minZ: t.heightmap.minZ, cell: t.heightmap.cellSize, cols: t.heightmap.cols, rows: t.heightmap.rows, h });
    }
  }
  /** The heightmap at (x, z) (bilinear), or NaN off the baked tiles. */
  raw(x: number, z: number): number {
    const t = this.tiles.get(`${Math.floor(x / this.tileSize)}_${Math.floor(z / this.tileSize)}`);
    if (!t) return NaN;
    const fx = Math.max(0, Math.min(t.cols - 1.0001, (x - t.minX) / t.cell)), fz = Math.max(0, Math.min(t.rows - 1.0001, (z - t.minZ) / t.cell));
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r;
    const i = r * t.cols + c;
    return t.h[i] * (1 - u) * (1 - v) + t.h[i + 1] * u * (1 - v) + t.h[i + t.cols] * (1 - u) * v + t.h[i + t.cols + 1] * u * v;
  }
  /** The pavement's height: the heightmap, or over a cut (a narrow dip of more than DECK_MIN) the closing of the ground round it. */
  pavement(x: number, z: number): number {
    const g = this.raw(x, z);
    if (!Number.isFinite(g)) return NaN;
    // the upper envelope over CLOSE_R: the highest ground either side along both axes, the lower of the two sides' maxima
    let best = -Infinity;
    for (const [dx, dz] of [[1, 0], [0, 1], [0.7071, 0.7071], [0.7071, -0.7071]]) {
      let a = -Infinity, b = -Infinity;
      for (let s = 8; s <= CLOSE_R * 1.6; s += 8) {
        const p = this.raw(x + dx * s, z + dz * s), q = this.raw(x - dx * s, z - dz * s);
        if (Number.isFinite(p)) a = Math.max(a, p);
        if (Number.isFinite(q)) b = Math.max(b, q);
      }
      best = Math.max(best, Math.min(a, b));
    }
    return best - g > DECK_MIN ? best : g;
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Builds the grid's aeroway.json from the airport extract (in the city frame of `proj`) and the baked tiles' ground. */
export function buildAerowayFile(grid: CityGridSpec, data: OsmData, proj: Projector, ground: GridGround): AerowayFile {
  const ap = parseAirport(data, proj);
  const y = (x: number, z: number) => {
    const v = ground.pavement(x, z);
    return Number.isFinite(v) ? r2(v) : 0;
  };
  // ---- the taxi graph: every runway, taxiway, taxilane and lead-in way, split at the nodes ways share
  const lines: AeroLine[] = ap.lines.filter((l) => l.kind === 'runway' || l.kind === 'taxiway' || l.kind === 'taxilane' || l.kind === 'parking_position');
  const uses = new Map<number, number>();
  for (const l of lines) l.nodes.forEach((id, i) => uses.set(id, (uses.get(id) ?? 0) + (i === 0 || i === l.nodes.length - 1 ? 1 : 2)));
  const holdIds = new Set(ap.holding.map((h) => h.id));
  const nodeIndex = new Map<number, number>();
  const nodes: number[][] = [];
  const nodeAt = (id: number, p: V2) => {
    let i = nodeIndex.get(id);
    if (i == null) {
      i = nodes.length;
      nodes.push([r2(p[0]), y(p[0], p[1]), r2(p[1])]);
      nodeIndex.set(id, i);
    }
    return i;
  };
  const edges: AerowayFile['edges'] = [];
  const kindOf = (l: AeroLine) => (l.kind === 'parking_position' ? 'leadin' : l.kind);
  for (const l of lines) {
    let start = 0;
    for (let k = 1; k < l.nodes.length; k++) {
      const id = l.nodes[k];
      const split = k === l.nodes.length - 1 || (uses.get(id) ?? 0) > 2 || holdIds.has(id);
      if (!split) continue;
      const seg = l.pts.slice(start, k + 1);
      const a = nodeAt(l.nodes[start], l.pts[start]), b = nodeAt(id, l.pts[k]);
      if (a !== b) {
        const pts = simplifyLine(seg, 0.15);
        const flat: number[] = [];
        let len = 0;
        pts.forEach((p, i) => {
          flat.push(r2(p[0]), y(p[0], p[1]), r2(p[1]));
          if (i) len += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
        });
        edges.push({ a, b, kind: kindOf(l), ref: l.ref, width: l.width, len: r2(len), pts: flat });
      }
      start = k;
    }
  }
  // ---- lead-in lines that end short of the network: joined to the nearest taxiway or taxilane within 40 m (that edge split there)
  const degree = () => {
    const d = new Array(nodes.length).fill(0);
    for (const e of edges) { d[e.a]++; d[e.b]++; }
    return d;
  };
  const splitEdgeAt = (ei: number, p: V2): number => {
    const e = edges[ei];
    // the nearest point on the polyline and the piece it lies on
    let best = { d: Infinity, k: 0, t: 0, q: [0, 0] as V2 };
    for (let k = 0; k + 3 < e.pts.length; k += 3) {
      const ax = e.pts[k], az = e.pts[k + 2], bx = e.pts[k + 3], bz = e.pts[k + 5];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
      const q: V2 = [ax + dx * t, az + dz * t];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.d) best = { d, k, t, q };
    }
    const ni = nodes.length;
    nodes.push([r2(best.q[0]), y(best.q[0], best.q[1]), r2(best.q[1])]);
    const head = e.pts.slice(0, best.k + 3).concat(nodes[ni]);
    const tail = nodes[ni].concat(e.pts.slice(best.k + 3));
    const plen = (pts: number[]) => { let l = 0; for (let k = 3; k < pts.length; k += 3) l += Math.hypot(pts[k] - pts[k - 3], pts[k + 2] - pts[k - 1]); return r2(l); };
    edges[ei] = { ...e, b: ni, pts: head, len: plen(head) };
    edges.push({ ...e, a: ni, b: e.b, pts: tail, len: plen(tail) });
    return ni;
  };
  {
    const deg = degree();
    /** The nearest taxiway or taxilane edge to p: its index and the distance. */
    const toNetwork = (p: V2): { ei: number; d: number } => {
      let ei = -1, d = Infinity;
      edges.forEach((e, k) => {
        if (e.kind === 'leadin' || e.kind === 'runway') return;
        for (let q = 0; q + 3 < e.pts.length; q += 3) {
          const ax = e.pts[q], az = e.pts[q + 2], bx = e.pts[q + 3], bz = e.pts[q + 5];
          const dx = bx - ax, dz = bz - az;
          const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
          const dd = Math.hypot(ax + dx * t - p[0], az + dz * t - p[1]);
          if (dd < d) { d = dd; ei = k; }
        }
      });
      return { ei, d };
    };
    for (const l of lines) {
      if (l.kind !== 'parking_position' || l.nodes.length < 2) continue;
      const n0 = nodeIndex.get(l.nodes[0]), n1 = nodeIndex.get(l.nodes[l.nodes.length - 1]);
      if (n0 == null || n1 == null || deg[n0] !== 1 || deg[n1] !== 1) continue;
      // neither end is on the network: join the end nearer it (the other is the stand)
      const p0 = l.pts[0], p1 = l.pts[l.pts.length - 1];
      const a = toNetwork(p0), b = toNetwork(p1);
      const [ni, p, hit] = a.d <= b.d ? [n0, p0, a] : [n1, p1, b];
      if (hit.ei < 0 || hit.d > 90) continue;
      const j = splitEdgeAt(hit.ei, p);
      const q = nodes[j];
      edges.push({ a: ni, b: j, kind: 'leadin', ref: l.ref, width: 0, len: r2(Math.hypot(q[0] - p[0], q[2] - p[1])), pts: [...nodes[ni], ...q] });
      deg[ni]++;
      deg.push(2);
    }
  }
  // ---- stands: airport.json's gates (their size class and building), then every other lead-in that ends at a stand node
  const airportJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools', 'blender', 'airport', 'airport.json'), 'utf8')) as { heroes: Record<string, { anchor: { x: number; z: number }; rings: V2[][]; name: string; kind: string }>; gates: { ref: string; hero: string; stand: V2; yaw: number; size: string; leadIn: V2[] }[] };
  const stands: AerowayFile['stands'] = [];
  const deg = degree();
  const nearestNode = (p: V2, pred: (i: number) => boolean, max = 6) => {
    let best = -1, bd = max;
    nodes.forEach((n, i) => {
      if (!pred(i)) return;
      const d = Math.hypot(n[0] - p[0], n[2] - p[1]);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  // the network node a lead-in leaves from: walk from the stand along lead-in edges to the first node that is not on one
  const adj = new Map<number, number[]>();
  edges.forEach((e, ei) => { adj.set(e.a, [...(adj.get(e.a) ?? []), ei]); adj.set(e.b, [...(adj.get(e.b) ?? []), ei]); });
  const entryOf = (stand: number): number => {
    let cur = stand, prev = -1;
    for (let k = 0; k < 20; k++) {
      const out = (adj.get(cur) ?? []).filter((ei) => ei !== prev);
      const lead = out.find((ei) => edges[ei].kind === 'leadin');
      if (!lead && out.length) return cur;
      if (lead == null) return -1;
      const e = edges[lead];
      prev = lead;
      cur = e.a === cur ? e.b : e.a;
      if ((adj.get(cur) ?? []).some((ei) => edges[ei].kind !== 'leadin')) return cur;
    }
    return -1;
  };
  const taken = new Set<number>();
  for (const g of airportJson.gates) {
    const node = nearestNode(g.stand, (i) => deg[i] === 1 && !taken.has(i), 25);
    if (node < 0 || taken.has(node)) continue;
    const entry = entryOf(node);
    if (entry < 0) continue;
    taken.add(node);
    stands.push({ ref: g.ref, gate: g.ref, hero: g.hero, node, entry, yaw: g.yaw, size: g.size, cargo: false });
  }
  // the cargo and remote stands: lead-in ends that are not gates
  for (const s of ap.stands) {
    const node = nearestNode([s.x, s.z], (i) => deg[i] === 1 && !taken.has(i), 25);
    if (node < 0 || taken.has(node)) continue;
    const entry = entryOf(node);
    if (entry < 0) continue;
    // the nose points along the last stretch of its lead-in
    const lead = (adj.get(node) ?? []).map((ei) => edges[ei]).find((e) => e.kind === 'leadin');
    if (!lead) continue;
    const pts = lead.pts;
    const fromA = lead.b === node;
    const k = fromA ? pts.length - 6 : 3;
    const px = pts[k], pz = pts[k + 2];
    const n = nodes[node];
    const yaw = Math.atan2(n[0] - px, n[2] - pz);
    taken.add(node);
    stands.push({ ref: s.ref ?? `#${s.id}`, gate: null, hero: null, node, entry, yaw: Math.round(yaw * 1e4) / 1e4, size: 'narrowbody', cargo: !/^[A-FT]\d/.test(s.ref ?? '') });
  }
  // remote stands' size: widebody where the next stand is 60 m off or more
  for (const s of stands) {
    if (s.gate) continue;
    const p = nodes[s.node];
    let near = Infinity;
    for (const o of stands) if (o !== s) near = Math.min(near, Math.hypot(nodes[o.node][0] - p[0], nodes[o.node][2] - p[2]));
    s.size = near >= 60 ? 'widebody' : near < 38 ? 'regional' : 'narrowbody';
    if (s.cargo && s.size === 'regional') s.size = 'narrowbody';
  }
  // ---- runways: ends, their nodes in order along the centreline
  const runways: AerowayFile['runways'] = ap.runways.map((rw) => {
    const ids = rw.nodes.map((id) => nodeIndex.get(id)).filter((i): i is number => i != null);
    const P = (p: V2) => [r2(p[0]), y(p[0], p[1]), r2(p[1])];
    const ends = rw.ends.map((e, k) => {
      const ordered = [...new Set(ids)].sort((a, b) => ((nodes[a][0] - e.end[0]) * e.dir[0] + (nodes[a][2] - e.end[1]) * e.dir[1]) - ((nodes[b][0] - e.end[0]) * e.dir[0] + (nodes[b][2] - e.end[1]) * e.dir[1]));
      void k;
      return { ref: e.ref, end: P(e.end), threshold: P(e.threshold), dir: [Math.round(e.dir[0] * 1e5) / 1e5, Math.round(e.dir[1] * 1e5) / 1e5], nodes: ordered };
    });
    return { ref: rw.ref, width: rw.width, length: r2(rw.length), ends };
  });
  // ---- holding positions on the graph
  const holds: AerowayFile['holds'] = [];
  for (const h of ap.holding) {
    const ni = nodeIndex.get(h.id);
    if (ni == null) continue;
    let rwi = -1, bd = 400;
    ap.runways.forEach((rw, i) => {
      const a = rw.ends[0].end, d = rw.ends[0].dir;
      const along = Math.max(0, Math.min(rw.length, (h.x - a[0]) * d[0] + (h.z - a[1]) * d[1]));
      const dd = Math.hypot(a[0] + d[0] * along - h.x, a[1] + d[1] * along - h.z);
      if (dd < bd) { bd = dd; rwi = i; }
    });
    holds.push({ node: ni, runway: rwi, ils: /ils/i.test(h.tags['holding_position:type'] ?? '') });
  }
  // ---- lights
  const lights = airfieldLights(ap, y);
  // ---- the map
  const ring = (r: V2[]) => r.flatMap((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  const rect = (a: V2, b: V2, hw: number): V2[] => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * hw, nz = (dx / l) * hw;
    return [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
  };
  const buildings: AerowayFile['map']['buildings'] = [];
  const labels: AerowayFile['map']['labels'] = [];
  for (const [id, h] of Object.entries(airportJson.heroes)) {
    for (const r of h.rings) buildings.push({ name: h.name, ring: ring(r.map((p) => [p[0] + h.anchor.x, p[1] + h.anchor.z] as V2)) });
    if (h.kind !== 'parking' || id === 'atl-rental-car-center') labels.push({ name: h.name, x: h.anchor.x, z: h.anchor.z, kind: h.kind });
  }
  for (const rw of ap.runways) {
    const c: V2 = [(rw.ends[0].end[0] + rw.ends[1].end[0]) / 2, (rw.ends[0].end[1] + rw.ends[1].end[1]) / 2];
    labels.push({ name: `Runway ${rw.ends.map((e) => e.ref.replace(/^0/, '')).join('/')}`, x: Math.round(c[0]), z: Math.round(c[1]), kind: 'runway' });
  }
  const map: AerowayFile['map'] = {
    runways: ap.runways.map((rw) => ring(rect(rw.ends[0].end, rw.ends[1].end, rw.width / 2))),
    taxiways: ap.lines.filter((l) => l.kind === 'taxiway' || l.kind === 'taxilane').map((l) => ({ w: l.width, pts: ring(simplifyLine(l.pts, 1)) })),
    aprons: ap.areas.filter((a) => a.kind === 'apron').map((a) => ring(a.rings[0])),
    buildings,
    labels,
  };
  return {
    format: 'hood-aeroway',
    version: 1,
    icao: grid.aeroway!.icao,
    name: 'Hartsfield-Jackson Atlanta International Airport',
    runways,
    nodes,
    edges,
    stands,
    holds,
    lights,
    map,
    stats: { nodes: nodes.length, edges: edges.length, stands: stands.length, holds: holds.length, ...Object.fromEntries(Object.entries(lights).map(([k, v]) => [`lights.${k}`, v.length / (k === 'approach' ? 4 : 3)])) },
  };
}

/** The airfield's lights from the geometry (FAA spacing, simplified). */
export function airfieldLights(ap: Airport, y: (x: number, z: number) => number): Record<string, number[]> {
  const L: Record<string, number[]> = { edge: [], centre: [], threshold: [], end: [], tdz: [], taxiCentre: [], taxiEdge: [], approach: [], apron: [] };
  const put = (k: string, x: number, z: number, lift = 0.25, extra?: number) => {
    L[k].push(r2(x), r2(y(x, z) + lift), r2(z));
    if (extra != null) L[k].push(Math.round(extra));
  };
  for (const rw of ap.runways) {
    const a = rw.ends[0].end, d = rw.ends[0].dir;
    const rgt: V2 = [-d[1], d[0]];
    const hw = rw.width / 2 + 1;
    // edge lights every 60 m, both sides
    for (let s = 0; s <= rw.length + 0.1; s += 60) for (const side of [-1, 1]) put('edge', a[0] + d[0] * s + rgt[0] * hw * side, a[1] + d[1] * s + rgt[1] * hw * side);
    // centreline lights every 30 m
    for (let s = 15; s < rw.length; s += 30) put('centre', a[0] + d[0] * s, a[1] + d[1] * s, 0.08);
    for (const e of rw.ends) {
      const u = e.dir, r: V2 = [-u[1], u[0]];
      // a row of green threshold lights and red end lights across the pavement, every 3 m
      for (let o = -rw.width / 2; o <= rw.width / 2 + 0.01; o += 3) {
        put('threshold', e.threshold[0] + r[0] * o - u[0] * 1, e.threshold[1] + r[1] * o - u[1] * 1, 0.3);
        put('end', e.end[0] + r[0] * o - u[0] * 0.5, e.end[1] + r[1] * o - u[1] * 0.5, 0.3);
      }
      // touchdown zone: two rows of bars to 900 m
      for (let s = 30; s <= 900; s += 30) for (const side of [-1, 1]) for (const k of [0, 1.5, 3]) put('tdz', e.threshold[0] + u[0] * s + r[0] * side * (11 + k), e.threshold[1] + u[1] * s + r[1] * side * (11 + k), 0.08);
      // the approach lights: a row of bars every 30 m out to 900 m, a crossbar at 300 m
      for (let s = 30; s <= 900; s += 30) {
        for (const o of [-1.5, -0.75, 0, 0.75, 1.5]) put('approach', e.threshold[0] - u[0] * s + r[0] * o, e.threshold[1] - u[1] * s + r[1] * o, 1.2, s);
        if (s === 300) for (let o = -15; o <= 15; o += 1.5) if (Math.abs(o) > 2) put('approach', e.threshold[0] - u[0] * s + r[0] * o, e.threshold[1] - u[1] * s + r[1] * o, 1.2, s);
      }
    }
  }
  const onRunway = (x: number, z: number) => ap.runways.some((rw) => {
    const a = rw.ends[0].end, d = rw.ends[0].dir;
    const along = (x - a[0]) * d[0] + (z - a[1]) * d[1];
    return along > -10 && along < rw.length + 10 && Math.abs((x - a[0]) * -d[1] + (z - a[1]) * d[0]) < rw.width / 2 + 2;
  });
  for (const l of ap.lines) {
    if (l.kind !== 'taxiway' && l.kind !== 'taxilane') continue;
    const pts = simplifyLine(l.pts, 0.3);
    let carry = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-6) continue;
      const ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
      let s = carry;
      for (; s < len; s += 30) {
        const x = p[0] + ux * s, z = p[1] + uz * s;
        if (onRunway(x, z)) continue;
        put('taxiCentre', x, z, 0.06);
        if (l.kind === 'taxiway' && Math.round(s / 30) % 2 === 0) for (const side of [-1, 1]) put('taxiEdge', x - uz * side * (l.width / 2 + 0.8), z + ux * side * (l.width / 2 + 0.8), 0.3);
      }
      carry = s - len;
    }
  }
  return L;
}
