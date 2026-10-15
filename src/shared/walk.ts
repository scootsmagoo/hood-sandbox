/**
 * The walk network and scenario points of a tile (`paths.json`, `scenarios.json`; see
 * docs/contracts/m1-tile-format.md). Parsing only: the graph, the routing and the behaviour are in
 * `src/sim/peds/`.
 */

export type PathKind = 'sidewalk' | 'synthetic' | 'footway' | 'pedestrian' | 'crossing' | 'island' | 'link' | 'steps';

export interface CrossingMeta {
  /** OSM way id, or null for a crossing the pipeline made. */
  id: number | null;
  marked: boolean;
  /** A walk light controls it. */
  signals: boolean;
  /** `junctions.json` id of the junction whose leg it crosses, or null for a mid-block crossing. */
  junction: string | null;
  /** Index into that junction's `legs`: the leg whose lanes the walker crosses. */
  leg: number | null;
  /** `roads.json` id of the road crossed. */
  road: string | null;
}

export interface PathAttr {
  kind: PathKind;
  width: number;
  bridge?: true;
  crossing?: CrossingMeta;
}

export interface PathsData {
  version: 1;
  /** [x, y, z] */
  nodes: [number, number, number][];
  attrs: PathAttr[];
  /** Flat triples: node a, node b, attribute index. */
  edges: number[];
}

export type ScenarioType = 'bench' | 'busstop' | 'atm' | 'shopfront' | 'eatery' | 'lawn' | 'plaza' | 'corner';

export interface ScenarioPoint {
  id: string;
  type: ScenarioType;
  x: number;
  y: number;
  z: number;
  /** Ped yaw: forward is (sin yaw, cos yaw) in (x, z). */
  yaw: number;
  cap: number;
  src: 'osm' | 'synth';
}

export interface ScenariosData {
  version: 1;
  points: ScenarioPoint[];
}

const KINDS = new Set<string>(['sidewalk', 'synthetic', 'footway', 'pedestrian', 'crossing', 'island', 'link', 'steps']);
const TYPES = new Set<string>(['bench', 'busstop', 'atm', 'shopfront', 'eatery', 'lawn', 'plaza', 'corner']);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads `paths.json`. Anything malformed means no network (the sim then has no ambient walkers), not no tile. */
export function parsePaths(json: unknown): PathsData | null {
  const j = json as Partial<PathsData> | null;
  if (!j || j.version !== 1 || !Array.isArray(j.nodes) || !Array.isArray(j.attrs) || !Array.isArray(j.edges)) return null;
  if (j.edges.length % 3 !== 0) return null;
  const n = j.nodes.length;
  for (const p of j.nodes) if (!Array.isArray(p) || p.length < 3 || !p.every(isNum)) return null;
  for (const a of j.attrs) if (!a || !KINDS.has(a.kind) || !isNum(a.width)) return null;
  for (let i = 0; i < j.edges.length; i += 3) {
    const a = j.edges[i], b = j.edges[i + 1], t = j.edges[i + 2];
    if (!(a >= 0 && a < n && b >= 0 && b < n && t >= 0 && t < j.attrs.length)) return null;
  }
  return j as PathsData;
}

export function parseScenarios(json: unknown): ScenariosData | null {
  const j = json as Partial<ScenariosData> | null;
  if (!j || j.version !== 1 || !Array.isArray(j.points)) return null;
  const points = j.points.filter((p) => p && TYPES.has(p.type) && isNum(p.x) && isNum(p.y) && isNum(p.z) && isNum(p.yaw) && isNum(p.cap) && p.cap >= 1);
  return { version: 1, points };
}
