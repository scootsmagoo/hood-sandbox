/**
 * The lane graph of a tile (`lanes.json`; see docs/contracts/m1-tile-format.md, "lanes.json").
 * Parsing and types only: the runtime graph, driving and junction control are in `src/sim/traffic/`.
 *
 * Edges are lanes (`t: 0`) and the connectors across junctions (`t: 1`), in one array; `next` holds
 * edge ids. Points are flat x, y, z triples along the direction of travel.
 */
export type LaneControl = 'signals' | 'stop' | 'none';

export interface LaneEdgeData {
  t: 0;
  road: string;
  cls: string;
  dir: 1 | -1;
  k: number;
  n: number;
  len: number;
  /** speed limit, m/s */
  v: number;
  pts: number[];
  next: number[];
  left: number;
  right: number;
  j?: string;
  leg?: number;
  ctl?: LaneControl;
  bridge?: 1;
}

export interface ConnectorEdgeData {
  t: 1;
  j: string;
  from: number;
  to: number;
  turn: 's' | 'l' | 'r' | 'u';
  len: number;
  v: number;
  pts: number[];
  next: number[];
  leg: number;
  ctl: LaneControl;
  /** connectors that cross or merge with this one; those it must yield to; those it contests by arrival order */
  c: number[];
  y: number[];
  m: number[];
}

export type LaneEdgeAny = LaneEdgeData | ConnectorEdgeData;

export interface LaneJunctionData {
  id: string;
  x: number;
  z: number;
  control: LaneControl;
  implicit?: 1;
  /** signalised junctions only: the legs of the `junctions.json` record, which the signal groups are a function of */
  legs?: { dir: [number, number]; approach: boolean }[];
  /** signal heads on poles: the leg they face approaching cars on, the position and the yaw of the face */
  heads?: { leg: number; x: number; y: number; z: number; yaw: number }[];
}

export interface LanesData {
  format: 'hood-lanes';
  version: 1;
  edges: LaneEdgeAny[];
  junctions: LaneJunctionData[];
  stats?: Record<string, number>;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates `lanes.json`. Null when it is not usable (the tile then has no traffic). */
export function parseLanes(json: unknown): LanesData | null {
  const data = parseLanesRaw(json);
  if (!data) return null;
  // A connector's `next` and control are not stored: it leads to `to` and faces what the lane it leaves faces.
  for (const e of data.edges) {
    if (e.t !== 1) continue;
    e.next = [e.to];
    e.ctl = (data.edges[e.from] as LaneEdgeData).ctl ?? 'none';
  }
  return data;
}

function parseLanesRaw(json: unknown): LanesData | null {
  const j = json as Partial<LanesData> | null;
  if (!j || j.format !== 'hood-lanes' || j.version !== 1 || !Array.isArray(j.edges) || !Array.isArray(j.junctions)) return null;
  const n = j.edges.length;
  for (const e of j.edges) {
    if (!e || (e.t !== 0 && e.t !== 1) || !Array.isArray(e.pts) || e.pts.length < 6 || e.pts.length % 3 !== 0 || !isNum(e.len) || !isNum(e.v)) return null;
    if (e.t === 0) {
      if (!Array.isArray(e.next)) return null;
      for (const x of e.next) if (!(x >= 0 && x < n)) return null;
    }
    if (e.t === 1 && !(e.from >= 0 && e.from < n && e.to >= 0 && e.to < n)) return null;
  }
  return j as LanesData;
}
