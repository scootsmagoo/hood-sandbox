/**
 * The tile's `landmarks.json` (docs/contracts/m1-tile-format.md, "landmarks.json"): the landmarks of the city pack that are in
 * the tile, the heroes among them with the model that stands there. The client draws the models (src/client/render/Landmarks.ts)
 * and the street-name label shows the name of the landmark you are at (src/client/ui/streetName.ts). Pure: no DOM, no three.js.
 */
export interface LandmarkLod {
  tris: number;
  /** from this distance (m, before the tier's lod scale) the level is drawn */
  from: number;
}

export interface LandmarkEntry {
  id: string;
  /** the real name */
  name: string;
  /** the name the game shows (a parody for trademarked brands, else the real one) */
  displayName: string;
  kind?: string;
  x: number;
  z: number;
  /** "at" the landmark: within this many metres of (x, z) */
  radius: number;
  /** a hero's footprint (world x, z): "at" is inside it, or within `RING_MARGIN_M` of it */
  ring?: [number, number][];
  hero?: {
    model: string;
    hash: string;
    /** ground height under the model, m: the model's y = 0 */
    y: number;
    yaw: number;
    lods: LandmarkLod[];
    replaced: string[];
    hullTris?: number;
  };
}

export interface LandmarksData {
  version: 1;
  landmarks: LandmarkEntry[];
}

/** A hero's footprint counts a few metres past its edge as "at" (the pavement in front of the door). */
export const RING_MARGIN_M = 14;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads `landmarks.json`: entries without a position or a name are dropped; null when it is not the file. */
export function parseLandmarks(json: unknown): LandmarksData | null {
  const j = json as { version?: number; landmarks?: unknown } | null;
  if (!j || j.version !== 1 || !Array.isArray(j.landmarks)) return null;
  const out: LandmarkEntry[] = [];
  for (const e of j.landmarks as Partial<LandmarkEntry>[]) {
    if (!e || typeof e.id !== 'string' || !isNum(e.x) || !isNum(e.z)) continue;
    const name = typeof e.name === 'string' ? e.name : e.id;
    const displayName = typeof e.displayName === 'string' && e.displayName ? e.displayName : name;
    const ring = Array.isArray(e.ring) ? (e.ring.filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])) as [number, number][]) : undefined;
    out.push({ ...e, id: e.id, name, displayName, x: e.x, z: e.z, radius: isNum(e.radius) ? e.radius : 45, ring: ring && ring.length >= 3 ? ring : undefined });
  }
  return { version: 1, landmarks: out };
}

function distToSegment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const ex = ax + t * dx - px;
  const ez = az + t * dz - pz;
  return ex * ex + ez * ez;
}

/** The distance (m) from a point to a ring: 0 inside it. */
export function distToRing(x: number, z: number, ring: [number, number][]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    best = Math.min(best, distToSegment2(x, z, xi, zi, xj, zj));
  }
  return inside ? 0 : Math.sqrt(best);
}

/**
 * The landmark a point is at, or null: the closest of those it is inside the footprint of (or within `RING_MARGIN_M` of),
 * or within the radius of; a hero (it has a footprint) beats a point landmark that is as close.
 */
export function landmarkAt(list: readonly LandmarkEntry[], x: number, z: number): LandmarkEntry | null {
  let best: LandmarkEntry | null = null;
  let bestScore = Infinity;
  for (const e of list) {
    let d: number;
    let reach: number;
    if (e.ring) {
      d = distToRing(x, z, e.ring);
      reach = RING_MARGIN_M;
    } else {
      d = Math.hypot(x - e.x, z - e.z);
      reach = e.radius;
    }
    if (d > reach) continue;
    // inside the footprint is 0; otherwise how far into the reach it is, so the nearer of two overlapping landmarks wins
    const score = d / reach - (e.ring ? 0.25 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}
