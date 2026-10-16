/**
 * The big map's road data, shaped for drawing: roads grouped by class and width into one polyline set each (a few Path2D a tile),
 * and a label place for each named road. Pure: it makes numbers and arrays, the map turns them into paths.
 */
import type { RoadData } from '../../../shared/tile';
import { abbreviateStreet } from '../streetNameMath';

/** Draw order and colours by class (higher rank on top): the radar's palette, with a dark casing round each road. */
export const MAP_ROAD: Record<string, { rank: number; color: string; minPx: number }> = {
  motorway: { rank: 5, color: '#e8b64c', minPx: 3.2 },
  trunk: { rank: 4, color: '#dba34a', minPx: 2.8 },
  primary: { rank: 3, color: '#c3cad2', minPx: 2.4 },
  secondary: { rank: 2, color: '#98a2ad', minPx: 2 },
  tertiary: { rank: 1, color: '#7b8691', minPx: 1.6 },
};
export const MAP_ROAD_DEFAULT = { rank: 0, color: '#505963', minPx: 1.1 };

export function mapRoadStyle(cls: string) {
  const base = cls.endsWith('_link') ? cls.slice(0, -5) : cls;
  return MAP_ROAD[base] ?? MAP_ROAD_DEFAULT;
}

export interface RoadGroup {
  rank: number;
  /** Metres (rounded to 2 m steps so that a tile has a handful of groups, not hundreds). */
  width: number;
  /** Polylines as flat x, z arrays. */
  lines: number[][];
}

export interface RoadLabel {
  name: string;
  x: number;
  z: number;
  /** Radians, kept upright (-90 to 90 degrees). */
  angle: number;
  /** Length of the road, m. */
  length: number;
  rank: number;
}

export function groupRoads(roads: readonly RoadData[]): RoadGroup[] {
  const groups = new Map<number, RoadGroup>();
  for (const r of roads) {
    if (r.points.length < 2) continue;
    const st = mapRoadStyle(r.class);
    const w = Math.max(2, Math.round(r.width / 2) * 2);
    const key = st.rank * 1000 + w;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { rank: st.rank, width: w, lines: [] }));
    const flat = new Array<number>(r.points.length * 2);
    for (let i = 0; i < r.points.length; i++) {
      flat[i * 2] = r.points[i][0];
      flat[i * 2 + 1] = r.points[i][2];
    }
    g.lines.push(flat);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.width - b.width);
}

/** One label place per named road: the middle of its longest straight stretch, turned along it. */
export function roadLabels(roads: readonly RoadData[], minLength = 50): RoadLabel[] {
  const out: RoadLabel[] = [];
  for (const r of roads) {
    if (!r.name || r.points.length < 2 || r.class === 'service') continue;
    let total = 0;
    let best = 0;
    let bestLen = 0;
    for (let i = 0; i < r.points.length - 1; i++) {
      const l = Math.hypot(r.points[i + 1][0] - r.points[i][0], r.points[i + 1][2] - r.points[i][2]);
      total += l;
      if (l > bestLen) {
        bestLen = l;
        best = i;
      }
    }
    if (total < minLength) continue;
    const a = r.points[best];
    const b = r.points[best + 1];
    let angle = Math.atan2(b[2] - a[2], b[0] - a[0]);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;
    out.push({ name: r.name, x: (a[0] + b[0]) / 2, z: (a[2] + b[2]) / 2, angle, length: total, rank: mapRoadStyle(r.class).rank });
  }
  return out;
}

/** Street names as written on the map: "Peachtree Street Northeast" is "Peachtree St NE". */
export function labelText(name: string): string {
  return abbreviateStreet(name);
}
