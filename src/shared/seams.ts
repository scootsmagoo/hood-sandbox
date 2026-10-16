/**
 * Seam ports (docs/contracts/city-tiles.md section 4): the lane ends, walk nodes and road ends of a tile that lie on one of its
 * four edges, with keys that are the same from both sides of the seam. The pipeline writes them to `seams.json`; the runtime
 * computes the same list from the tile when there is no file. Pure.
 */
import type { LanesData } from './lanes';
import type { RoadData } from './tile';
import type { PathsData } from './walk';
import type { Rect, SeamSide } from './city';

/** A point within this of a tile edge lies on it, m. */
export const ON_SEAM = 0.05;
/** Ports of two tiles join when they are within these, m (plan, height). */
export const PORT_MATCH = { plan: 0.75, height: 0.25, cosHeading: Math.cos((20 * Math.PI) / 180) } as const;

export interface LanePort {
  key: string;
  /** The lane edge's local index in the tile's `lanes.json`. */
  edge: number;
  /** `out`: the lane ends on the seam (cars leave the tile); `in`: it starts there. */
  end: 'in' | 'out';
  p: [number, number, number];
  /** Unit direction of travel at the seam, (x, z). */
  dir: [number, number];
  road: string;
  ldir: number;
  k: number;
}

export interface WalkPort {
  key: string;
  node: number;
  p: [number, number, number];
  /** A dead end near the seam (not on it): joined to the other side's within `NEAR_SEAM.join` (the bake's walk network is cut short of a tile's edge where a footprint or a resampling ends it). */
  near?: true;
}

/** Walk dead ends within `within` m of a seam are ports too, joined across it within `join` m (and 0.6 m in height). */
export const NEAR_SEAM = { within: 4, join: 6 } as const;

export interface RoadPort {
  key: string;
  /** Index of the road in the tile's `roads.json`. */
  road: number;
  /** 0: the road's first point is on the seam, 1: its last. */
  end: 0 | 1;
  p: [number, number, number];
}

export interface SidePorts {
  axis: 'x' | 'z';
  line: number;
  lanes: LanePort[];
  walk: WalkPort[];
  roads: RoadPort[];
}

export interface SeamsData {
  version: 1;
  tile: string;
  sides: Partial<Record<SeamSide, SidePorts>>;
}

export const SIDES: readonly SeamSide[] = ['n', 'e', 's', 'w'];
export const OPPOSITE: Record<SeamSide, SeamSide> = { n: 's', s: 'n', e: 'w', w: 'e' };

/** The line a side of a cell lies on: east and west are lines of constant x, north (-z) and south of constant z. */
export function sideLine(b: Rect, side: SeamSide): { axis: 'x' | 'z'; line: number } {
  switch (side) {
    case 'e':
      return { axis: 'x', line: b.maxX };
    case 'w':
      return { axis: 'x', line: b.minX };
    case 'n':
      return { axis: 'z', line: b.minZ };
    case 's':
      return { axis: 'z', line: b.maxZ };
  }
}

/** `x1024`, `z-2048`: a seam line's tag in port keys. */
export const lineTag = (axis: 'x' | 'z', line: number): string => `${axis}${Math.round(line * 100) / 100}`;

/** The side of `b` that (x, z) lies on, or null. Corners count for both sides; the first found (n, e, s, w) wins. */
function sidesAt(b: Rect, x: number, z: number, tol: number): SeamSide[] {
  const out: SeamSide[] = [];
  const inX = x >= b.minX - tol && x <= b.maxX + tol;
  const inZ = z >= b.minZ - tol && z <= b.maxZ + tol;
  if (inX && Math.abs(z - b.minZ) <= tol) out.push('n');
  if (inZ && Math.abs(x - b.maxX) <= tol) out.push('e');
  if (inX && Math.abs(z - b.maxZ) <= tol) out.push('s');
  if (inZ && Math.abs(x - b.minX) <= tol) out.push('w');
  return out;
}

const along = (axis: 'x' | 'z', x: number, z: number) => (axis === 'x' ? z : x);

function emptySide(b: Rect, side: SeamSide): SidePorts {
  const { axis, line } = sideLine(b, side);
  return { axis, line, lanes: [], walk: [], roads: [] };
}

/**
 * Every port of a tile. Lanes: the plain lanes (`t: 0`) whose first or last point lies on an edge. Walk: the nodes on an edge.
 * Roads: the `roads.json` centrelines whose first or last point lies on an edge.
 */
export function seamPorts(
  tileId: string,
  bounds: Rect,
  data: { lanes?: LanesData | null; paths?: PathsData | null; roads?: readonly RoadData[] | null },
  tol = ON_SEAM,
): SeamsData {
  const sides: Partial<Record<SeamSide, SidePorts>> = {};
  const get = (s: SeamSide) => (sides[s] ??= emptySide(bounds, s));
  const edges = data.lanes?.edges ?? [];
  // lanes: collect, then give each (seam, road, dir, k) its ordinals along the line
  const raw: { side: SeamSide; port: Omit<LanePort, 'key'>; a: number }[] = [];
  edges.forEach((e, i) => {
    if (e.t !== 0 || e.pts.length < 6) return;
    const n = e.pts.length;
    const ends: ['in' | 'out', number][] = [
      ['in', 0],
      ['out', n - 3],
    ];
    for (const [end, o] of ends) {
      const x = e.pts[o], y = e.pts[o + 1], z = e.pts[o + 2];
      const at = sidesAt(bounds, x, z, tol);
      if (!at.length) continue;
      // direction of travel at that end
      const q = end === 'in' ? 3 : n - 6;
      const dx = end === 'in' ? e.pts[q] - x : x - e.pts[q];
      const dz = end === 'in' ? e.pts[q + 2] - z : z - e.pts[q + 2];
      const l = Math.hypot(dx, dz) || 1;
      for (const side of at) {
        // a lane end on an edge only counts when it runs across the edge (leaving for `out`, entering for `in`)
        const { axis } = sideLine(bounds, side);
        const outward = side === 'e' ? dx : side === 'w' ? -dx : side === 's' ? dz : -dz;
        if ((end === 'out' && outward <= 0) || (end === 'in' && outward >= 0)) continue;
        raw.push({ side, a: along(axis, x, z), port: { edge: i, end, p: [x, y, z], dir: [dx / l, dz / l], road: e.road, ldir: e.dir, k: e.k } });
      }
    }
  });
  const groups = new Map<string, typeof raw>();
  for (const r of raw) {
    const g = `${r.side}|${r.port.road}|${r.port.ldir}|${r.port.k}`;
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  for (const list of groups.values()) {
    list.sort((p, q) => p.a - q.a);
    list.forEach((r, ord) => {
      const { axis, line } = sideLine(bounds, r.side);
      get(r.side).lanes.push({ key: `L|${lineTag(axis, line)}|${r.port.road}|${r.port.ldir}|${r.port.k}|${ord}`, ...r.port });
    });
  }
  // walk nodes: on an edge, or a dead end near one
  const nodes = data.paths?.nodes ?? [];
  const deg = new Int32Array(nodes.length);
  const pe = data.paths?.edges ?? [];
  for (let i = 0; i + 2 < pe.length; i += 3) {
    deg[pe[i]]++;
    deg[pe[i + 1]]++;
  }
  nodes.forEach((p, node) => {
    const on = sidesAt(bounds, p[0], p[2], tol);
    for (const side of on) {
      const { axis, line } = sideLine(bounds, side);
      get(side).walk.push({ key: `W|${lineTag(axis, line)}|${Math.round(along(axis, p[0], p[2]) * 2) / 2}`, node, p: [p[0], p[1], p[2]] });
    }
    if (on.length || deg[node] !== 1) return;
    for (const side of sidesAt(bounds, p[0], p[2], NEAR_SEAM.within)) {
      const { axis, line } = sideLine(bounds, side);
      get(side).walk.push({ key: `W|${lineTag(axis, line)}|near|${Math.round(along(axis, p[0], p[2]) * 2) / 2}`, node, p: [p[0], p[1], p[2]], near: true });
    }
  });
  // road ends
  const roadRaw: { side: SeamSide; a: number; port: Omit<RoadPort, 'key'>; id: string }[] = [];
  (data.roads ?? []).forEach((r, ri) => {
    const ends: [0 | 1, [number, number, number]][] = [
      [0, r.points[0]],
      [1, r.points[r.points.length - 1]],
    ];
    for (const [end, p] of ends) {
      for (const side of sidesAt(bounds, p[0], p[2], tol)) {
        const { axis } = sideLine(bounds, side);
        roadRaw.push({ side, a: along(axis, p[0], p[2]), id: r.id, port: { road: ri, end, p: [p[0], p[1], p[2]] } });
      }
    }
  });
  const rg = new Map<string, typeof roadRaw>();
  for (const r of roadRaw) {
    const g = `${r.side}|${r.id}`;
    const list = rg.get(g);
    if (list) list.push(r);
    else rg.set(g, [r]);
  }
  for (const list of rg.values()) {
    list.sort((p, q) => p.a - q.a);
    list.forEach((r, ord) => {
      const { axis, line } = sideLine(bounds, r.side);
      get(r.side).roads.push({ key: `R|${lineTag(axis, line)}|${r.id}|${ord}`, ...r.port });
    });
  }
  for (const s of Object.values(sides)) {
    s.lanes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    s.walk.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.node - b.node));
    s.roads.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return { version: 1, tile: tileId, sides };
}

/** Reads `seams.json`; null when it is not one. */
export function parseSeams(json: unknown): SeamsData | null {
  const j = json as Partial<SeamsData> | null;
  if (!j || j.version !== 1 || typeof j.sides !== 'object' || !j.sides) return null;
  return j as SeamsData;
}

export interface LaneMatch {
  /** The out port (the lane that ends on the seam) and the in port it continues into. */
  out: LanePort;
  into: LanePort;
}

/**
 * Pairs the out ports of one side with the in ports of the other side of the same seam (and the other way round): by key first,
 * then by the nearest in port of the same road, direction and lane within `PORT_MATCH`. Ports that fit no partner are returned
 * as unmatched.
 */
export function matchLanePorts(a: readonly LanePort[], b: readonly LanePort[]): { pairs: LaneMatch[]; unmatched: LanePort[] } {
  const pairs: LaneMatch[] = [];
  const used = new Set<LanePort>();
  const fits = (o: LanePort, i: LanePort) =>
    Math.hypot(o.p[0] - i.p[0], o.p[2] - i.p[2]) <= PORT_MATCH.plan &&
    Math.abs(o.p[1] - i.p[1]) <= PORT_MATCH.height &&
    o.dir[0] * i.dir[0] + o.dir[1] * i.dir[1] >= PORT_MATCH.cosHeading;
  const unmatched: LanePort[] = [];
  const pass = (outs: readonly LanePort[], ins: readonly LanePort[]) => {
    const byKey = new Map<string, LanePort>();
    for (const i of ins) if (i.end === 'in') byKey.set(i.key, i);
    for (const o of outs) {
      if (o.end !== 'out') continue;
      let best: LanePort | undefined = byKey.get(o.key);
      if (best && (used.has(best) || !fits(o, best))) best = undefined;
      if (!best) {
        let bd = Infinity;
        for (const i of ins) {
          if (i.end !== 'in' || used.has(i) || i.road !== o.road || i.ldir !== o.ldir || i.k !== o.k || !fits(o, i)) continue;
          const d = Math.hypot(o.p[0] - i.p[0], o.p[2] - i.p[2]);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
      if (!best) {
        // any lane in the same place and heading (a road that changed id at the seam)
        let bd = Infinity;
        for (const i of ins) {
          if (i.end !== 'in' || used.has(i) || !fits(o, i)) continue;
          const d = Math.hypot(o.p[0] - i.p[0], o.p[2] - i.p[2]);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
      if (best) {
        used.add(best);
        pairs.push({ out: o, into: best });
      } else unmatched.push(o);
    }
  };
  pass(a, b);
  pass(b, a);
  for (const p of [...a, ...b]) if (p.end === 'in' && !used.has(p)) unmatched.push(p);
  return { pairs, unmatched };
}

/**
 * Pairs walk ports of the two sides of a seam, one to one, nearest pairs first: two on the seam within `PORT_MATCH.plan`, or when
 * either is a dead end near it, within `NEAR_SEAM.join`. Near dead ends that find nobody are not counted as unmatched.
 */
export function matchWalkPorts(a: readonly WalkPort[], b: readonly WalkPort[]): { pairs: [WalkPort, WalkPort][]; unmatched: WalkPort[] } {
  const cands: { p: WalkPort; q: WalkPort; d: number }[] = [];
  for (const p of a) {
    for (const q of b) {
      const d = Math.hypot(p.p[0] - q.p[0], p.p[2] - q.p[2]);
      const lim = p.near || q.near ? NEAR_SEAM.join : PORT_MATCH.plan;
      if (d <= lim && Math.abs(p.p[1] - q.p[1]) <= 0.6) cands.push({ p, q, d });
    }
  }
  cands.sort((x, y) => x.d - y.d || (x.p.key < y.p.key ? -1 : 1));
  const pairs: [WalkPort, WalkPort][] = [];
  const usedA = new Set<number>(), usedB = new Set<number>();
  for (const c of cands) {
    if (usedA.has(c.p.node) || usedB.has(c.q.node)) continue;
    usedA.add(c.p.node);
    usedB.add(c.q.node);
    pairs.push([c.p, c.q]);
  }
  return { pairs, unmatched: [...a.filter((p) => !p.near && !usedA.has(p.node)), ...b.filter((q) => !q.near && !usedB.has(q.node))] };
}
