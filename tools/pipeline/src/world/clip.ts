import polygonClipping from 'polygon-clipping';
import type { V2 } from '../geo.js';
import { ringBounds, signedArea } from '../geo.js';
import type { Building } from './buildings.js';
import type { RoadWay } from './osm.js';

type Ring = [number, number][];

const closed = (r: V2[]): Ring => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];
const opened = (r: Ring): V2[] => r.slice(0, -1).map((p) => [p[0], p[1]] as V2);

/** The rectangle a road segment covers (half its width on either side), as a closed ring, or null for a zero-length segment. */
export function segmentQuad(a: V2, b: V2, half: number): Ring | null {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) return null;
  const nx = (-dz / l) * half, nz = (dx / l) * half;
  return [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz], [a[0] + nx, a[1] + nz]];
}

export interface ClipStats {
  clipped: number;
  pieces: number;
  dropped: number;
  removedAreaM2: number;
}

/** Road classes whose surface is cut out of the buildings over it: a service road may well run through a garage. */
export function clipsBuildings(w: RoadWay): boolean {
  return w.kind === 'car' && !w.bridge && w.highway !== 'service' && w.highway !== 'busway';
}

/**
 * Cuts the footprint of every building that stands on a street out of the building: a footprint that
 * straddles a road (a building bridging a street, or a footprint drawn a little too wide) would otherwise
 * be a wall across the road, for the car and the eye. Buildings that split in two become two buildings.
 * Pieces under `minArea` m2 are dropped. Courtyard holes of a building that is cut are filled in.
 */
export function clipBuildingsToRoads(buildings: Building[], ways: RoadWay[], margin = 0.3, minArea = 6): { buildings: Building[]; stats: ClipStats } {
  const quads: { ring: Ring; minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
  for (const w of ways) {
    if (!clipsBuildings(w)) continue;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const q = segmentQuad(w.pts[i], w.pts[i + 1], w.width / 2 + margin);
      if (!q) continue;
      const b = ringBounds(q.slice(0, -1) as V2[]);
      quads.push({ ring: q, ...b });
    }
  }
  const cell = 64;
  const grid = new Map<string, number[]>();
  quads.forEach((q, k) => {
    for (let x = Math.floor(q.minX / cell); x <= Math.floor(q.maxX / cell); x++) {
      for (let z = Math.floor(q.minZ / cell); z <= Math.floor(q.maxZ / cell); z++) {
        const key = `${x},${z}`;
        const a = grid.get(key);
        if (a) a.push(k); else grid.set(key, [k]);
      }
    }
  });

  const stats: ClipStats = { clipped: 0, pieces: 0, dropped: 0, removedAreaM2: 0 };
  const out: Building[] = [];
  for (const b of buildings) {
    const bb = ringBounds(b.rings[0]);
    const near = new Set<number>();
    for (let x = Math.floor(bb.minX / cell); x <= Math.floor(bb.maxX / cell); x++) {
      for (let z = Math.floor(bb.minZ / cell); z <= Math.floor(bb.maxZ / cell); z++) for (const k of grid.get(`${x},${z}`) ?? []) near.add(k);
    }
    const cut = [...near].filter((k) => quads[k].minX <= bb.maxX && quads[k].maxX >= bb.minX && quads[k].minZ <= bb.maxZ && quads[k].maxZ >= bb.minZ).map((k) => quads[k].ring);
    if (!cut.length) { out.push(b); continue; }
    const subject: polygonClipping.Polygon = [closed(b.rings[0])];
    let result: polygonClipping.MultiPolygon;
    try {
      result = polygonClipping.difference(subject, ...cut.map((r) => [r] as polygonClipping.Polygon));
    } catch {
      out.push(b);
      continue;
    }
    const area = (mp: polygonClipping.MultiPolygon) => mp.reduce((s, p) => s + Math.abs(signedArea(opened(p[0]))) - p.slice(1).reduce((h, r) => h + Math.abs(signedArea(opened(r))), 0), 0);
    const before = Math.abs(signedArea(b.rings[0]));
    const after = area(result);
    if (before - after < 0.5) { out.push(b); continue; }
    stats.clipped++;
    stats.removedAreaM2 += before - after;
    let n = 0;
    for (const poly of result) {
      const outer = opened(poly[0]);
      if (outer.length < 3 || Math.abs(signedArea(outer)) < minArea) { stats.dropped++; continue; }
      const rings = [outer, ...poly.slice(1).map(opened).filter((r) => r.length >= 3)];
      out.push({ ...b, id: result.length > 1 ? `${b.id}/c${n}` : b.id, rings });
      n++;
      stats.pieces++;
    }
  }
  return { buildings: out, stats };
}
