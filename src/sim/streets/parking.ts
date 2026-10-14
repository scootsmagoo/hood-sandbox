/**
 * Where to park empty cars: along the right-hand curb of nearby ordinary streets, away from
 * junctions, the player's start and each other. Pure maths over the tile's road centrelines. The
 * simulation still checks each slot against the physical world (buildings, slopes) before placing a car.
 */
import type { Rng } from '../../shared/rng';
import type { RoadData } from '../../shared/tile';

/** Road classes a car is left on. Not motorways, ramps, service lanes or bridges. */
const PARKABLE = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);

export interface ParkingSlot {
  x: number;
  z: number;
  /** Ground height from the road's centreline. */
  y: number;
  /** Model yaw (radians about +Y; the car faces (sin yaw, cos yaw)). */
  yaw: number;
  roadId: string;
}

export interface ParkingOptions {
  /** Where the player starts. Slots are measured from here. */
  around: { x: number; z: number };
  /** Spots to keep clear (the starting car, the player), with a radius each. */
  avoid: { x: number; z: number; r: number }[];
  count: number;
  /** Nearest and farthest slot from `around`, m. */
  minDist?: number;
  maxDist?: number;
  /** Gap kept between neighbouring cars, m, and the most on one road. */
  spacing?: number;
  perRoad?: number;
  /** Clearance kept from the edge of a crossing street, m (on top of that street's half width). */
  junctionMargin?: number;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Candidate slots, chosen with the seeded `rng` so a seed always parks the same cars in the same
 * places. The result is ordered nearest first.
 */
export function planParking(roads: readonly RoadData[], opts: ParkingOptions, rng: Rng): ParkingSlot[] {
  const minDist = opts.minDist ?? 14;
  const maxDist = opts.maxDist ?? 140;
  const spacing = opts.spacing ?? 9;
  const perRoad = opts.perRoad ?? 2;
  const margin = opts.junctionMargin ?? 9;
  const { around } = opts;

  // Roads near enough to matter, for the junction test.
  const near = roads.filter((r) => !r.bridge && r.layer === 0 && r.points.some((p) => Math.hypot(p[0] - around.x, p[2] - around.z) < maxDist + 60));

  const candidates: (ParkingSlot & { d: number })[] = [];
  for (const r of near) {
    if (!PARKABLE.has(r.class) || r.width < 6) continue;
    const pts = r.points;
    let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][2] - pts[i][2]);
    if (total < 36) continue;
    const half = r.width / 2;
    const side = Math.max(0, half - 1.35);
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (l < 1e-6) continue;
      const fx = (b[0] - a[0]) / l;
      const fz = (b[2] - a[2]) / l;
      for (let s = 3; s < l; s += 6) {
        const along = acc + s;
        if (along < 14 || total - along < 14) continue;
        const cx = a[0] + fx * s;
        const cz = a[2] + fz * s;
        // Two-way streets are parked on both sides; the car faces the way traffic goes on its side.
        const right = r.oneway || rng.chance(0.5);
        const sx = right ? -fz : fz;
        const sz = right ? fx : -fx;
        const x = cx + sx * side;
        const z = cz + sz * side;
        const d = Math.hypot(x - around.x, z - around.z);
        if (d < minDist || d > maxDist) continue;
        const dirx = right ? fx : -fx;
        const dirz = right ? fz : -fz;
        // Skip junctions: any other street passing close to the spot.
        let junction = false;
        for (const o of near) {
          if (o === r || o.class === 'service' || (o.bridge && o.layer > 0)) continue;
          const reach = o.width / 2 + margin;
          const q = o.points;
          for (let k = 0; k + 1 < q.length && !junction; k++) {
            if (distToSegment(x, z, q[k][0], q[k][2], q[k + 1][0], q[k + 1][2]) < reach) junction = true;
          }
          if (junction) break;
        }
        if (junction) continue;
        candidates.push({ x, z, y: a[1] + (b[1] - a[1]) * (s / l), yaw: Math.atan2(dirx, dirz), roadId: r.id, d });
      }
      acc += l;
    }
  }

  // Shuffle (seeded), then take greedily so the cars spread out instead of lining up on one block.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const chosen: (ParkingSlot & { d: number })[] = [];
  const perRoadCount = new Map<string, number>();
  for (const c of candidates) {
    if (chosen.length >= opts.count) break;
    if (opts.avoid.some((a) => Math.hypot(c.x - a.x, c.z - a.z) < a.r)) continue;
    if (chosen.some((o) => Math.hypot(c.x - o.x, c.z - o.z) < spacing)) continue;
    if ((perRoadCount.get(c.roadId) ?? 0) >= perRoad) continue;
    chosen.push(c);
    perRoadCount.set(c.roadId, (perRoadCount.get(c.roadId) ?? 0) + 1);
  }
  chosen.sort((a, b) => a.d - b.d);
  return chosen.map(({ d: _d, ...slot }) => slot);
}
