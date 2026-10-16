/** A car in a lane reaches this far either side of the lane's path (m): its half width and a third of a metre. */
const LANE_HALF = 1.25;
/** A deck this much wider (m, each side) than the lanes on it plus their room is reported as too wide (the barrier stands at its
 * edge: roads.ts `addBarriers`). */
const WIDE_SLACK = 2.5;
/** Lane points within this of a deck piece's ends (m, along it) are not measured: forks, joins and landings. */
const END_SKIP = 12;

export interface DeckWidthReport {
  /** car deck pieces measured, and lane points on them */
  decks: number;
  points: number;
  /** lane points whose lane reaches past the barrier's inner face (the barrier stands in the lane) */
  lanesPastBarrier: number;
  /** deck pieces wider than their lanes and their room by more than WIDE_SLACK m a side */
  decksTooWide: number;
  worst: { id: string; x: number; z: number; what: string; by: number }[];
}

interface Road { id: string; bridge: boolean; width: number; points: number[][] }
interface Lane { t: number; road?: string; pts: number[] }

/**
 * Deck widths against the lanes on them: every lane of a car deck piece (away from its ends) must keep `LANE_HALF` inside the
 * barrier's inner face (the deck's edge), and a deck should not be much wider than its lanes (a barrier
 * that far out leaves a car room to run off the lane and still be on the deck: the owner's "guardrails much wider than the lanes").
 */
export function checkDeckWidths(roads: Road[], lanes: Lane[]): DeckWidthReport {
  const rep: DeckWidthReport = { decks: 0, points: 0, lanesPastBarrier: 0, decksTooWide: 0, worst: [] };
  const byRoad = new Map<string, Lane[]>();
  for (const l of lanes) if (l.t === 0 && l.road) { const a = byRoad.get(l.road); if (a) a.push(l); else byRoad.set(l.road, [l]); }
  for (const r of roads) {
    if (!r.bridge || r.points.length < 2) continue;
    const ls = byRoad.get(r.id);
    if (!ls) continue;
    const P = r.points;
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]));
    const len = cum[cum.length - 1];
    if (len < 2 * END_SKIP + 5) continue;
    const half = r.width / 2;
    let widest = 0, measured = 0, worstOut = 0, wx = 0, wz = 0;
    for (const l of ls) {
      for (let k = 0; k < l.pts.length; k += 3) {
        const x = l.pts[k], z = l.pts[k + 2];
        let bd = Infinity, bs = 0;
        for (let i = 0; i + 1 < P.length; i++) {
          const ax = P[i][0], az = P[i][2], dx = P[i + 1][0] - ax, dz = P[i + 1][2] - az;
          const l2 = dx * dx + dz * dz;
          const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
          const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
          if (d < bd) { bd = d; bs = cum[i] + t * Math.sqrt(l2); }
        }
        if (bd > half + 3 || bs < END_SKIP || bs > len - END_SKIP) continue;
        measured++;
        rep.points++;
        widest = Math.max(widest, bd + LANE_HALF);
        const out = bd + LANE_HALF - half;
        if (out > 0) { rep.lanesPastBarrier++; if (out > worstOut) { worstOut = out; wx = x; wz = z; } }
      }
    }
    if (!measured) continue;
    rep.decks++;
    const mid = P[Math.floor(P.length / 2)];
    if (worstOut > 0) rep.worst.push({ id: r.id, x: wx, z: wz, what: 'lane past the barrier', by: worstOut });
    if (half - widest > WIDE_SLACK) { rep.decksTooWide++; rep.worst.push({ id: r.id, x: mid[0], z: mid[2], what: 'deck wider than its lanes', by: half - widest }); }
  }
  rep.worst.sort((a, b) => b.by - a.by);
  return rep;
}

export interface LaneBarrierReport {
  /** lanes and turns that cross a barrier, and lanes that end within `END_CLEAR` m in front of one */
  crossings: number;
  blockedEnds: number;
  /** lanes on decks that lead to no ground lane of the main network and not off the tile (a deck you can drive onto and not off) */
  deckLanes: number;
  strandedDeckLanes: number;
  worst: { what: string; x: number; z: number; edge: number }[];
}

/** A lane end this close (m) to a barrier ahead of it ends against it. */
const END_CLEAR = 3;

/**
 * The lanes against the decks' barriers (roads.json `barriers`, flat x, y, z along each run's inner face at its foot): no lane or
 * turn may cross one (at its height, within 2 m), no lane may end with one across its way within `END_CLEAR` m, and every lane on a
 * deck must lead (forward over the lane graph) to a ground lane of the largest strongly connected component or off the tile: a deck
 * a car can be driven off (`comp`, `largest` from lanes.ts `connectivity`; `nearEdge` says which ends are at the tile's edge).
 */
export function checkLaneBarriers(lanes: { t: number; pts: number[]; next?: number[]; to?: number; bridge?: number }[], barriers: number[][], comp: ArrayLike<number>, largest: number, nearEdge: (x: number, z: number) => boolean): LaneBarrierReport {
  const rep: LaneBarrierReport = { crossings: 0, blockedEnds: 0, deckLanes: 0, strandedDeckLanes: 0, worst: [] };
  // the lanes from which a car can get off the decks: the ground lanes of the main network, the lanes that run off the tile, and
  // (backwards over the graph) every lane that leads to one of them
  const n = lanes.length;
  const out = (e: (typeof lanes)[number]) => (e.t === 1 ? (e.to !== undefined ? [e.to] : []) : e.next ?? []);
  const prev: number[][] = Array.from({ length: n }, () => []);
  lanes.forEach((e, i) => { for (const j of out(e)) if (j >= 0 && j < n) prev[j].push(i); });
  const good = new Uint8Array(n);
  const queue: number[] = [];
  lanes.forEach((e, i) => {
    const p = e.pts, m = p.length;
    if ((e.t === 0 && !e.bridge && comp[i] === largest) || (out(e).length === 0 && nearEdge(p[m - 3], p[m - 1]))) { good[i] = 1; queue.push(i); }
  });
  while (queue.length) { const j = queue.pop()!; for (const i of prev[j]) if (!good[i]) { good[i] = 1; queue.push(i); } }
  const G = 16;
  const segs: number[][] = [];
  const grid = new Map<string, number[]>();
  for (const b of barriers) {
    for (let k = 0; k + 5 < b.length; k += 3) {
      const s = [b[k], b[k + 1], b[k + 2], b[k + 3], b[k + 4], b[k + 5]];
      const i = segs.length;
      segs.push(s);
      for (let gx = Math.floor(Math.min(s[0], s[3]) / G); gx <= Math.floor(Math.max(s[0], s[3]) / G); gx++) {
        for (let gz = Math.floor(Math.min(s[2], s[5]) / G); gz <= Math.floor(Math.max(s[2], s[5]) / G); gz++) {
          const key = `${gx},${gz}`;
          const l = grid.get(key);
          if (l) l.push(i); else grid.set(key, [i]);
        }
      }
    }
  }
  const near = (x0: number, z0: number, x1: number, z1: number) => {
    const out = new Set<number>();
    for (let gx = Math.floor(Math.min(x0, x1) / G); gx <= Math.floor(Math.max(x0, x1) / G); gx++) {
      for (let gz = Math.floor(Math.min(z0, z1) / G); gz <= Math.floor(Math.max(z0, z1) / G); gz++) for (const i of grid.get(`${gx},${gz}`) ?? []) out.add(i);
    }
    return out;
  };
  // where segment p0-p1 crosses barrier s, the parameter along p0-p1, or -1
  const cross = (ax: number, az: number, bx: number, bz: number, s: number[]): number => {
    const rx = bx - ax, rz = bz - az, qx = s[3] - s[0], qz = s[5] - s[2];
    const den = rx * qz - rz * qx;
    if (Math.abs(den) < 1e-9) return -1;
    const t = ((s[0] - ax) * qz - (s[2] - az) * qx) / den;
    const u = ((s[0] - ax) * rz - (s[2] - az) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
  };
  lanes.forEach((e, ei) => {
    const p = e.pts;
    let hit = false;
    for (let k = 0; k + 5 < p.length && !hit; k += 3) {
      for (const i of near(p[k], p[k + 2], p[k + 3], p[k + 5])) {
        const s = segs[i];
        const t = cross(p[k], p[k + 2], p[k + 3], p[k + 5], s);
        if (t < 0) continue;
        const y = p[k + 1] + (p[k + 4] - p[k + 1]) * t;
        if (Math.abs(y - (s[1] + s[4]) / 2) > 2) continue;
        hit = true;
        rep.crossings++;
        if (rep.worst.length < 40) rep.worst.push({ what: e.t ? 'turn crosses a barrier' : 'lane crosses a barrier', x: p[k], z: p[k + 2], edge: ei });
        break;
      }
    }
    if (e.t === 0) {
      // the lane's end, continued END_CLEAR m straight on: a barrier across it is a wall at the end of the lane
      const n = p.length;
      const ax = p[n - 3], az = p[n - 1], ay = p[n - 2];
      const dx = ax - p[n - 6], dz = az - p[n - 4], l = Math.hypot(dx, dz) || 1;
      const bx = ax + (dx / l) * END_CLEAR, bz = az + (dz / l) * END_CLEAR;
      if ((e.next?.length ?? 0) === 0 || e.bridge) {
        for (const i of near(ax, az, bx, bz)) {
          const s = segs[i];
          if (cross(ax, az, bx, bz, s) < 0 || Math.abs(ay - (s[1] + s[4]) / 2) > 2) continue;
          rep.blockedEnds++;
          if (rep.worst.length < 40) rep.worst.push({ what: 'lane ends against a barrier', x: ax, z: az, edge: ei });
          break;
        }
      }
      if (e.bridge) {
        rep.deckLanes++;
        if (!good[ei]) {
          rep.strandedDeckLanes++;
          if (rep.worst.length < 40) rep.worst.push({ what: 'deck lane off the main lane network', x: p[0], z: p[2], edge: ei });
        }
      }
    }
  });
  return rep;
}
