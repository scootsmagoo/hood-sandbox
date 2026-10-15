import type { Projector, V2 } from '../geo.js';
import { ringCentroid, signedArea } from '../geo.js';
import type { OsmData, OsmElement } from '../sources/osm.js';

export type RoadKind = 'car' | 'ped' | 'rail';

export interface RoadWay {
  id: number;
  name: string;
  highway: string;
  kind: RoadKind;
  /** footway=sidewalk | crossing | undefined */
  sub?: string;
  lanes: number;
  oneway: boolean;
  width: number;
  layer: number;
  bridge: boolean;
  /** junction=roundabout */
  roundabout?: boolean;
  /** posted speed limit in km/h (`maxspeed`, "35 mph" converted), when OSM has one */
  maxspeed?: number;
  nodeIds: number[];
  pts: V2[];
}

export type AreaKind = 'park' | 'forest' | 'water' | 'residential' | 'commercial' | 'industrial' | 'parking' | 'cemetery' | 'pitch' | 'rail' | 'construction';

export interface Area {
  kind: AreaKind;
  /** outer ring first, then holes; rings are open (no closing duplicate) */
  rings: V2[][];
}

export interface OsmBuilding {
  id: string;
  tags: Record<string, string>;
  rings: V2[][];
}

const CAR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road', 'busway']);
const PED = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway', 'track']);

const DEFAULT_LANES_ONEWAY: Record<string, number> = { motorway: 3, trunk: 2, primary: 2, secondary: 2, tertiary: 1, motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1 };
const DEFAULT_LANES_TWOWAY: Record<string, number> = { motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, unclassified: 2, residential: 2, living_street: 2, service: 1, road: 2, busway: 2 };

export function laneWidth(highway: string): number {
  if (highway.startsWith('motorway')) return 3.7;
  if (highway === 'service') return 3.0;
  if (highway === 'residential' || highway === 'living_street') return 3.0;
  return 3.3;
}

export function roadWidth(highway: string, lanes: number, oneway: boolean): number {
  const base = highway.replace(/_link$/, '');
  let w = lanes * laneWidth(highway);
  if (base === 'motorway') w += oneway ? 3 : 4;
  else if (base === 'trunk') w += 1.5;
  else if (base === 'residential' || base === 'living_street') w += 2;
  else if ((base === 'primary' || base === 'secondary') && !highway.endsWith('_link')) w += 1.5;
  if (highway === 'service') w = Math.max(w, 4.5);
  return Math.round(w * 10) / 10;
}

function footWidth(highway: string, sub?: string): number {
  if (sub === 'crossing') return 3;
  if (sub === 'sidewalk') return 1.8;
  if (highway === 'pedestrian') return 5;
  if (highway === 'steps') return 2;
  if (highway === 'cycleway') return 2.2;
  return 2;
}

function parseLayer(t: Record<string, string>): number {
  const n = parseInt(t.layer ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/** OSM `maxspeed` as km/h: "50", "35 mph", "walk" and the like; undefined when absent or not a number. */
export function parseMaxspeed(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?\s*$/i.exec(v.split(';')[0]);
  if (!m) return undefined;
  const n = parseFloat(m[1]) * (m[2]?.toLowerCase() === 'mph' ? 1.609344 : 1);
  return n >= 5 && n <= 200 ? Math.round(n) : undefined;
}

export function classifyWay(el: OsmElement): Omit<RoadWay, 'pts' | 'nodeIds' | 'id'> | null {
  const t = el.tags ?? {};
  if (t.area === 'yes') return null;
  let kind: RoadKind;
  let highway: string;
  if (t.highway) {
    highway = t.highway;
    if (CAR.has(highway)) kind = 'car';
    else if (PED.has(highway)) kind = 'ped';
    else return null;
    if (t.indoor === 'yes') return null;
    if (t.tunnel && t.tunnel !== 'no') return null;
  } else if (t.railway && /^(rail|light_rail|subway|tram|narrow_gauge)$/.test(t.railway)) {
    kind = 'rail';
    highway = t.railway;
    if (t.tunnel && t.tunnel !== 'no') return null;
    if (t.railway === 'subway') return null;
  } else return null;

  let layer = parseLayer(t);
  const bridge = !!t.bridge && t.bridge !== 'no';
  if (layer < 0) return null;
  if (bridge && layer <= 0) layer = 1;
  const isDeck = bridge || layer >= 1;

  const roundabout = t.junction === 'roundabout';
  const oneway = kind === 'car' && (t.oneway === 'yes' || t.oneway === '-1' || t.oneway === '1' || roundabout || highway === 'motorway' || highway === 'motorway_link');
  let lanes = parseInt(t.lanes ?? '', 10);
  if (!Number.isFinite(lanes) || lanes < 1) {
    lanes = kind === 'car' ? (oneway ? DEFAULT_LANES_ONEWAY[highway] : DEFAULT_LANES_TWOWAY[highway]) ?? 1 : 1;
  }
  let width: number;
  if (kind === 'car') width = roadWidth(highway, lanes, oneway);
  else if (kind === 'ped') width = footWidth(highway, t.footway);
  else width = 3.2;
  if (kind === 'ped' && t.width) {
    const w = parseFloat(t.width);
    if (w > 0 && w < 12) width = w;
  }
  return {
    name: t.name ?? '',
    highway,
    kind,
    sub: kind === 'ped' ? t.footway : undefined,
    lanes,
    oneway,
    width,
    layer: isDeck ? Math.max(layer, 1) : 0,
    bridge: isDeck,
    roundabout,
    ...(kind === 'car' && parseMaxspeed(t.maxspeed) ? { maxspeed: parseMaxspeed(t.maxspeed) } : {}),
  };
}

const AREA_RULES: [string, RegExp, AreaKind][] = [
  ['natural', /^water$/, 'water'],
  ['leisure', /^(park|garden|nature_reserve|recreation_ground|golf_course)$/, 'park'],
  ['leisure', /^(pitch|playground)$/, 'pitch'],
  ['landuse', /^(grass|village_green|meadow|recreation_ground|flowerbed|greenfield)$/, 'park'],
  ['landuse', /^(forest)$/, 'forest'],
  ['landuse', /^(residential)$/, 'residential'],
  ['landuse', /^(commercial|retail|institutional)$/, 'commercial'],
  ['landuse', /^(industrial|railway|garages|depot)$/, 'industrial'],
  ['landuse', /^(cemetery)$/, 'cemetery'],
  ['landuse', /^(construction|brownfield)$/, 'construction'],
  ['amenity', /^parking$/, 'parking'],
];

export function areaKindOf(tags: Record<string, string>): AreaKind | null {
  for (const [k, re, kind] of AREA_RULES) if (tags[k] && re.test(tags[k])) return kind;
  return null;
}

type LL = { lat: number; lon: number };

function toRing(geom: LL[], proj: Projector): V2[] {
  const ring = geom.map((g) => proj.toGame(g.lon, g.lat));
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) ring.pop();
  }
  return ring;
}

const key = (p: LL) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

/** Joins way pieces end to end into closed rings. */
export function assembleRings(pieces: LL[][]): LL[][] {
  const rings: LL[][] = [];
  const open = pieces.filter((p) => p.length > 1).map((p) => p.slice());
  while (open.length) {
    let cur = open.pop()!;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 10000) {
      const end = key(cur[cur.length - 1]);
      let found = -1;
      let rev = false;
      for (let i = 0; i < open.length; i++) {
        if (key(open[i][0]) === end) { found = i; break; }
        if (key(open[i][open[i].length - 1]) === end) { found = i; rev = true; break; }
      }
      if (found < 0) break;
      const nxt = open.splice(found, 1)[0];
      if (rev) nxt.reverse();
      cur = cur.concat(nxt.slice(1));
    }
    if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

/** Groups rings into polygons: each outer ring takes the inner rings it contains. */
export function groupRings(outers: V2[][], inners: V2[][]): V2[][][] {
  const polys: V2[][][] = outers.map((o) => [o]);
  for (const inn of inners) {
    const c = ringCentroid(inn);
    const host = polys.find((p) => pointIn(c, p[0]));
    if (host) host.push(inn);
  }
  return polys;
}

function pointIn(p: V2, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export interface OsmWorld {
  roads: RoadWay[];
  areas: Area[];
  buildings: OsmBuilding[];
}

export function parseOsm(data: OsmData, proj: Projector): OsmWorld {
  const roads: RoadWay[] = [];
  const areas: Area[] = [];
  const buildings: OsmBuilding[] = [];

  for (const el of data.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'way' && el.geometry && el.nodes) {
      const cls = classifyWay(el);
      if (cls) {
        const pts: V2[] = [];
        const nodeIds: number[] = [];
        el.geometry.forEach((g, i) => {
          const p = proj.toGame(g.lon, g.lat);
          const last = pts[pts.length - 1];
          if (last && last[0] === p[0] && last[1] === p[1]) return;
          pts.push(p);
          nodeIds.push(el.nodes![i]);
        });
        if (tags.oneway === '-1' && cls.kind === 'car') {
          pts.reverse();
          nodeIds.reverse();
        }
        if (pts.length >= 2) roads.push({ id: el.id, ...cls, nodeIds, pts });
        continue;
      }
      const closed = el.nodes.length > 3 && el.nodes[0] === el.nodes[el.nodes.length - 1];
      if (!closed) continue;
      const ring = toRing(el.geometry, proj);
      if (ring.length < 3) continue;
      if (tags.building) {
        buildings.push({ id: `osm:way/${el.id}`, tags, rings: [ring] });
      } else {
        const kind = areaKindOf(tags);
        if (kind) areas.push({ kind, rings: [ring] });
      }
    } else if (el.type === 'relation' && el.members) {
      const outerPieces: LL[][] = [];
      const innerPieces: LL[][] = [];
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry) continue;
        (m.role === 'inner' ? innerPieces : outerPieces).push(m.geometry);
      }
      const outers = assembleRings(outerPieces).map((r) => toRing(r, proj));
      const inners = assembleRings(innerPieces).map((r) => toRing(r, proj));
      if (!outers.length) continue;
      const polys = groupRings(outers, inners);
      if (tags.building) {
        polys.forEach((p, i) => buildings.push({ id: `osm:rel/${el.id}/${i}`, tags, rings: p }));
      } else {
        const kind = areaKindOf(tags);
        if (kind) for (const p of polys) areas.push({ kind, rings: p });
      }
    }
  }
  return { roads, areas, buildings };
}

export { signedArea };
