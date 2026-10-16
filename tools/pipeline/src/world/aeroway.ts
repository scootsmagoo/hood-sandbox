/**
 * The airport model (the `aeroway` layer of OSM, world/aerowayFetch.ts) in a bake's frame: runways with their thresholds,
 * taxiways and taxilanes as centrelines with their node ids (so the graph joins them where OSM does), aprons, stopways and
 * helipads as areas, holding positions, gates, stands with their lead-in lines, jet bridges, the approach lights, the aerodrome
 * outline. Pure: it reads the parsed extract and a projector.
 *
 * Widths: a runway's `width` tag (45.72 m at Hartsfield-Jackson) with 7.5 m paved shoulders either side; taxiways 23 m
 * (ICAO code E, what the widebodies use), taxilanes (the lanes through an apron to the stands) 16 m; a `width` tag wins.
 */
import type { Projector, V2 } from '../geo.js';
import { signedArea } from '../geo.js';
import type { OsmData, OsmElement } from '../sources/osm.js';

export const RUNWAY_SHOULDER = 7.5;
export const TAXIWAY_WIDTH = 23;
export const TAXILANE_WIDTH = 16;

export interface RunwayEnd {
  /** the designator painted at this end: '09L' (the direction one lands or takes off from it is `heading`) */
  ref: string;
  /** the physical end of the pavement */
  end: V2;
  /** the landing threshold (a displaced threshold where a threshold node says so; else the end) */
  threshold: V2;
  /** the direction along the runway from this end (unit) */
  dir: V2;
}
export interface AeroRunway {
  id: number;
  ref: string;
  width: number;
  /** both ends, in the order of the way */
  ends: [RunwayEnd, RunwayEnd];
  length: number;
  /** OSM node ids along the way and their points (taxiways join the runway at shared nodes) */
  nodes: number[];
  pts: V2[];
  surface: string;
}
export interface AeroLine {
  id: number;
  kind: 'taxiway' | 'taxilane' | 'runway' | 'parking_position' | 'stopway';
  ref: string | null;
  width: number;
  nodes: number[];
  pts: V2[];
  /** a way at layer 1 or more (a taxiway bridge) */
  layer: number;
}
export interface AeroArea {
  id: number;
  kind: 'apron' | 'helipad' | 'stopway' | 'runway';
  ref: string | null;
  rings: V2[][];
}
export interface AeroPoint {
  id: number;
  x: number;
  z: number;
  ref: string | null;
  tags: Record<string, string>;
}
export interface Airport {
  runways: AeroRunway[];
  lines: AeroLine[];
  areas: AeroArea[];
  holding: AeroPoint[];
  holdingLines: AeroLine[];
  gates: AeroPoint[];
  stands: AeroPoint[];
  jetBridges: AeroLine[];
  als: AeroPoint[];
  aerodrome: V2[][];
  /** every node position of the aeroway ways, by OSM id (the graph's nodes) */
  nodePos: Map<number, V2>;
}

const num = (v: string | undefined, def: number) => {
  if (!v) return def;
  const m = /^\s*([\d.]+)\s*(ft|m)?/.exec(v);
  if (!m) return def;
  const x = parseFloat(m[1]);
  return m[2] === 'ft' ? x * 0.3048 : x;
};
const layerOf = (t: Record<string, string>) => {
  const l = parseInt(t.layer ?? '0', 10);
  return Number.isFinite(l) ? l : 0;
};

/** '09L/27R' -> ['09L', '27R']; '10' -> ['10', '28'] (the reciprocal). */
export function runwayDesignators(ref: string): [string, string] {
  const parts = ref.split('/').map((s) => s.trim()).filter(Boolean);
  const pad = (s: string) => (/^\d[LCR]?$/.test(s) ? `0${s}` : s);
  if (parts.length >= 2) return [pad(parts[0]), pad(parts[1])];
  const m = /^(\d{1,2})([LCR]?)$/.exec(parts[0] ?? '');
  if (!m) return [parts[0] ?? '?', '?'];
  const n = ((Number(m[1]) + 17) % 36) + 1;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return [pad(parts[0]), pad(`${n}${side}`)];
}

const ringOf = (g: { lat: number; lon: number }[], proj: Projector): V2[] => {
  const r = g.map((p) => proj.toGame(p.lon, p.lat));
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return signedArea(r) < 0 ? r.reverse() : r;
};

/** Parses the aeroway extract into the bake frame of `proj`. */
export function parseAirport(data: OsmData, proj: Projector): Airport {
  const ap: Airport = { runways: [], lines: [], areas: [], holding: [], holdingLines: [], gates: [], stands: [], jetBridges: [], als: [], aerodrome: [], nodePos: new Map() };
  const thresholds: AeroPoint[] = [];
  const point = (e: OsmElement): AeroPoint => {
    const [x, z] = proj.toGame(e.lon!, e.lat!);
    return { id: e.id, x, z, ref: e.tags?.ref ?? null, tags: e.tags ?? {} };
  };
  for (const e of data.elements) {
    const t = e.tags ?? {};
    const a = t.aeroway;
    if (!a) continue;
    if (e.type === 'node' && e.lat != null && e.lon != null) {
      if (a === 'holding_position') ap.holding.push(point(e));
      else if (a === 'gate') ap.gates.push(point(e));
      else if (a === 'parking_position') ap.stands.push(point(e));
      else if (a === 'threshold') thresholds.push(point(e));
      else if (a === 'navigationaid' && /^(als|papi|vasi)$/.test(t.navigationaid ?? '')) ap.als.push(point(e));
      continue;
    }
    if (e.type === 'way' && e.geometry && e.nodes) {
      const pts: V2[] = e.geometry.map((g) => proj.toGame(g.lon, g.lat));
      const closed = e.nodes.length > 3 && e.nodes[0] === e.nodes[e.nodes.length - 1];
      if (a === 'aerodrome' && closed) {
        ap.aerodrome.push(ringOf(e.geometry, proj));
        continue;
      }
      if (a === 'apron' || a === 'helipad' || (closed && t.area === 'yes' && (a === 'runway' || a === 'taxiway'))) {
        if (!closed) continue;
        ap.areas.push({ id: e.id, kind: a === 'helipad' ? 'helipad' : a === 'apron' ? 'apron' : 'runway', ref: t.ref ?? null, rings: [ringOf(e.geometry, proj)] });
        continue;
      }
      if (a === 'runway' || a === 'taxiway' || a === 'taxilane' || a === 'parking_position' || a === 'stopway' || a === 'holding_position' || a === 'jet_bridge') {
        e.nodes.forEach((id, i) => ap.nodePos.set(id, pts[i]));
        const width = num(t.width, a === 'runway' ? 45 : a === 'taxiway' ? TAXIWAY_WIDTH : a === 'taxilane' ? TAXILANE_WIDTH : a === 'stopway' ? 45 : 0);
        const line: AeroLine = { id: e.id, kind: a === 'holding_position' || a === 'jet_bridge' ? 'taxiway' : (a as AeroLine['kind']), ref: t.ref ?? null, width, nodes: e.nodes, pts, layer: layerOf(t) };
        if (a === 'holding_position') ap.holdingLines.push(line);
        else if (a === 'jet_bridge') ap.jetBridges.push(line);
        else ap.lines.push(line);
      }
    } else if (e.type === 'relation' && e.members && (a === 'apron' || a === 'aerodrome')) {
      for (const m of e.members) if (m.type === 'way' && m.role !== 'inner' && m.geometry && m.geometry.length > 3) {
        const r = ringOf(m.geometry, proj);
        if (a === 'aerodrome') ap.aerodrome.push(r);
        else ap.areas.push({ id: e.id, kind: 'apron', ref: t.ref ?? null, rings: [r] });
      }
    }
  }
  // runways: the runway ways of one designator joined end to end (Hartsfield-Jackson maps 9L/27R in two pieces)
  const byRef = new Map<string, AeroLine[]>();
  for (const l of ap.lines) if (l.kind === 'runway') byRef.set(l.ref ?? `#${l.id}`, [...(byRef.get(l.ref ?? `#${l.id}`) ?? []), l]);
  for (const [ref, pieces] of [...byRef].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    let nodes = [...pieces[0].nodes];
    let pts = [...pieces[0].pts];
    const rest = pieces.slice(1);
    while (rest.length) {
      const i = rest.findIndex((p) => p.nodes[0] === nodes[nodes.length - 1] || p.nodes[p.nodes.length - 1] === nodes[nodes.length - 1] || p.nodes[0] === nodes[0] || p.nodes[p.nodes.length - 1] === nodes[0]);
      if (i < 0) break;
      const p = rest.splice(i, 1)[0];
      let pn = [...p.nodes], pp = [...p.pts];
      if (pn[pn.length - 1] === nodes[nodes.length - 1] || pn[0] === nodes[0]) { pn.reverse(); pp.reverse(); }
      if (pn[0] === nodes[nodes.length - 1]) { nodes = [...nodes, ...pn.slice(1)]; pts = [...pts, ...pp.slice(1)]; }
      else { nodes = [...pn.slice(0, -1), ...nodes]; pts = [...pp.slice(0, -1), ...pts]; }
    }
    const a = pts[0], b = pts[pts.length - 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 300) continue;
    const d: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const [ra, rb] = runwayDesignators(ref);
    // which designator belongs to which end: a runway numbered 09 points east, so its "09" end is the west one (one lands on it
    // heading 090): the end from which the direction along the runway matches the number's bearing
    const bearing = (dir: V2) => ((Math.atan2(dir[0], -dir[1]) * 180) / Math.PI + 360) % 360;
    const num0 = parseInt(ra, 10) * 10;
    const diff = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);
    const aIsFirst = diff(bearing(d), num0) <= diff(bearing([-d[0], -d[1]]), num0);
    const endA: RunwayEnd = { ref: aIsFirst ? ra : rb, end: a, threshold: a, dir: d };
    const endB: RunwayEnd = { ref: aIsFirst ? rb : ra, end: b, threshold: b, dir: [-d[0], -d[1]] };
    // a displaced threshold: a threshold node on the runway, more than 30 m in from its end
    for (const end of [endA, endB]) {
      const want = end.ref.replace(/^0/, '');
      for (const th of thresholds) {
        const tr = (th.ref ?? '').replace(/^0/, '');
        if (tr !== want) continue;
        const along = (th.x - end.end[0]) * end.dir[0] + (th.z - end.end[1]) * end.dir[1];
        const off = Math.abs((th.x - end.end[0]) * -end.dir[1] + (th.z - end.end[1]) * end.dir[0]);
        if (along > 30 && along < len / 2 && off < 30) end.threshold = [end.end[0] + end.dir[0] * along, end.end[1] + end.dir[1] * along];
      }
    }
    ap.runways.push({ id: pieces[0].id, ref, width: pieces[0].width || 45, ends: [endA, endB], length: len, nodes, pts, surface: 'concrete' });
  }
  return ap;
}

/** The aerodrome outline contains (x, z)? (an airport with no outline: everywhere) */
export function inAerodrome(ap: Airport, x: number, z: number): boolean {
  if (!ap.aerodrome.length) return true;
  for (const r of ap.aerodrome) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    if (c) return true;
  }
  return false;
}
