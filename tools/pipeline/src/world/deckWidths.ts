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
