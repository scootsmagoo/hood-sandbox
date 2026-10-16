/**
 * Known facts about particular buildings, matched to footprints by position: the heights Wikipedia lists for Atlanta's
 * skyscrapers (data/cities/<city>/building-heights.json, made by `src/facts-import.ts`) and a short curated list of looks
 * (building-appearance.json). The labels in both files are for people; nothing here puts a name in a tile.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Projector, V2 } from '../geo.js';
import { ringBounds } from '../geo.js';
import { parseColour, plausibleRoofColour, plausibleWallColour, parseMaterial, parseRoofMaterial, parseStyle, setLook, type DataLook } from './appearance.js';

export interface KnownHeight {
  label?: string;
  lat: number;
  lon: number;
  height: number;
  floors: number | null;
  year: number | null;
  use?: string | null;
}

export interface KnownLook {
  label?: string;
  at: [number, number];
  radius: number;
  material?: string;
  colour?: string;
  roofColour?: string;
  roofMaterial?: string;
  style?: string;
  year?: number;
  crown?: number;
}

export interface FactsFile {
  heights: KnownHeight[];
  looks: KnownLook[];
}

export function loadFacts(dataDir: string): FactsFile {
  const read = <T>(f: string, key: string): T[] => {
    const p = path.join(dataDir, f);
    if (!existsSync(p)) return [];
    try {
      return ((JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)[key] as T[]) ?? [];
    } catch (e) {
      console.warn(`${f}: ${(e as Error).message}`);
      return [];
    }
  };
  return { heights: read<KnownHeight>('building-heights.json', 'heights'), looks: read<KnownLook>('building-appearance.json', 'entries') };
}

/** The shape facts need of a building: its footprint, its height and the look it has so far. */
export interface FactTarget {
  id: string;
  rings: V2[][];
  height: number;
  /** false for sheds, garages and the like that cannot be a tower */
  look?: DataLook;
}

function pointInRing(p: V2, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** A footprint bigger than this under a much taller known tower is its podium, not the tower. */
export const TOWER_MAX_AREA = 3000;

function ringAreaOf(r: V2[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** Distance from a point to a ring's outline (0 inside), m. */
export function distToFootprint(p: V2, ring: V2[]): number {
  if (pointInRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz)));
  }
  return best;
}

/** How a known height changes a building's: the height to use, or null to leave it. */
export function knownHeightFor(known: number, baked: number): number | null {
  if (Math.abs(known - baked) / known < 0.012) return null;
  // a little short (a rounded Overture height, a crown the footprint's tag leaves out): take the known one
  if (baked < known && baked >= known * 0.93) return known;
  // too tall (a podium that took the tower's height): cap at the known one
  if (baked > known * 1.02) return known;
  // much shorter: the known height probably counts a mast or spire this footprint does not carry; leave it for the audit
  return null;
}

/** A tower the list knows that stands on a much lower, much bigger footprint (a hotel's podium): the caller splits the footprint. */
export interface TowerSplit {
  target: FactTarget;
  /** where the tower stands, in game metres */
  at: V2;
  fact: KnownHeight;
}

export interface FactsResult {
  heights: { applied: number; mismatched: { label: string; known: number; baked: number; id: string }[]; unmatched: string[]; towers: TowerSplit[] };
  looks: { applied: number; unmatched: string[] };
}

/**
 * Applies the facts to the buildings (in place): known heights, floors and years go into `height` and `look`, curated looks
 * into `look` with the strongest say. Returns what was and was not matched, for the log and the audit.
 */
export function applyFacts(targets: FactTarget[], facts: FactsFile, proj: Projector, setHeight: (t: FactTarget, h: number) => void): FactsResult {
  const res: FactsResult = { heights: { applied: 0, mismatched: [], unmatched: [], towers: [] }, looks: { applied: 0, unmatched: [] } };
  const bounds = targets.map((t) => ringBounds(t.rings[0]));
  const claimed = new Set<number>();
  /** The footprint a fact is about: near the point, of about the known height (or, if the footprint holding the point is much lower, that one), not claimed by a taller fact. */
  const pick = (at: V2, radius: number, wantHeight: number | null): number => {
    let best = -1;
    let bestScore = -Infinity;
    targets.forEach((t, i) => {
      if (claimed.has(i)) return;
      const bb = bounds[i];
      if (at[0] < bb.minX - radius || at[0] > bb.maxX + radius || at[1] < bb.minZ - radius || at[1] > bb.maxZ + radius) return;
      const d = distToFootprint(at, t.rings[0]);
      if (d > radius) return;
      let score = (d === 0 ? 100 : 0) - d * 2;
      if (wantHeight != null) {
        const off = Math.abs(Math.log(Math.max(t.height, 1) / wantHeight));
        if (off <= 0.35) score += 1000 - off * 600;
        else if (d === 0 && t.height < wantHeight * 0.65 && ringAreaOf(t.rings[0]) >= 500) score += 200 + ringAreaOf(t.rings[0]) * 0.01; // the footprint under the point, though it is far too low
        else return;
      } else score += t.height * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0 && wantHeight != null) claimed.add(best);
    return best;
  };

  for (const k of [...facts.heights].sort((a, b) => b.height - a.height)) {
    const at = proj.toGame(k.lon, k.lat);
    const i = pick(at, 45, k.height);
    if (i < 0) {
      res.heights.unmatched.push(k.label ?? `${k.lat},${k.lon}`);
      continue;
    }
    const t = targets[i];
    let to = knownHeightFor(k.height, t.height);
    t.look ??= {};
    if (to === null && t.height < k.height * 0.65) {
      // far too low: a small footprint is the tower itself (its height was wrong); a big one is a podium the tower stands on
      if (ringAreaOf(t.rings[0]) < TOWER_MAX_AREA) to = k.height;
      else {
        res.heights.towers.push({ target: t, at, fact: k });
        continue;
      }
    }
    if (to !== null) {
      setHeight(t, to);
      res.heights.applied++;
    } else if (t.height < k.height * 0.93) {
      res.heights.mismatched.push({ label: k.label ?? '', known: k.height, baked: t.height, id: t.id });
    }
    // floors and the year are facts of the same building when its height is that of the list
    if (Math.abs(t.height - k.height) / k.height < 0.08) {
      t.look.heightKnown = true;
      setLook(t.look, 'floors', k.floors, 'facts', true);
      setLook(t.look, 'year', k.year, 'facts');
    }
  }

  /** A curated look is about the building a known height already matched near its point, if there is one (the tower, not the podium under the point). */
  const pickLook = (at: V2, radius: number): number => {
    let best = -1;
    let bd = Infinity;
    for (const i of claimed) {
      const d = distToFootprint(at, targets[i].rings[0]);
      if (d <= radius && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best >= 0 ? best : pick(at, radius, null);
  };
  for (const k of facts.looks) {
    const at = proj.toGame(k.at[1], k.at[0]);
    const i = pickLook(at, k.radius);
    if (i < 0) {
      res.looks.unmatched.push(k.label ?? `${k.at}`);
      continue;
    }
    const look = (targets[i].look ??= {});
    const mat = parseMaterial(k.material);
    setLook(look, 'material', mat, 'facts', true);
    setLook(look, 'colour', plausibleWallColour(parseColour(k.colour), mat === 'glass'), 'facts', true);
    setLook(look, 'roofColour', plausibleRoofColour(parseColour(k.roofColour)), 'facts', true);
    setLook(look, 'style', parseStyle(k.style), 'facts', true);
    setLook(look, 'year', k.year, 'facts', true);
    const rm = parseRoofMaterial(k.roofMaterial);
    if (rm) look.roofMaterial = rm;
    if (k.crown) look.crown = k.crown;
    look.curated = true;
    res.looks.applied++;
  }
  return res;
}

/**
 * The footprint of a tower that stands somewhere on a bigger, lower footprint: a square about `floors x 40` m2 (700 to 2400),
 * aligned with the footprint's longest side and centred on `at`, moved in if it would stick out. Null when the footprint is too
 * small to hold it.
 */
export function towerSquare(ring: V2[], at: V2, floors: number | null): V2[] | null {
  const area = Math.min(2400, Math.max(700, (floors ?? 25) * 40));
  const side = Math.sqrt(area);
  // the longest edge gives the axis
  let ax = 1, az = 0, best = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) {
      best = l;
      ax = (b[0] - a[0]) / l;
      az = (b[1] - a[1]) / l;
    }
  }
  const bx = -az, bz = ax;
  const make = (cx: number, cz: number): V2[] => {
    const h = side / 2;
    return [[cx - ax * h - bx * h, cz - az * h - bz * h], [cx + ax * h - bx * h, cz + az * h - bz * h], [cx + ax * h + bx * h, cz + az * h + bz * h], [cx - ax * h + bx * h, cz - az * h + bz * h]];
  };
  let c: V2 = [at[0], at[1]];
  const centroid: V2 = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  // pull towards the middle of the footprint until all four corners are inside it
  for (let step = 0; step <= 10; step++) {
    const q = make(c[0], c[1]);
    if (q.every((p) => pointInRing(p, ring))) return q;
    c = [c[0] + (centroid[0] - c[0]) * 0.15, c[1] + (centroid[1] - c[1]) * 0.15];
  }
  return null;
}
