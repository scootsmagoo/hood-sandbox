/**
 * Hero landmarks (docs/contracts/m1-tile-format.md, "landmarks.json"): a hand-built model that stands where a real
 * building's generic extrusion would be.
 *
 *   data/cities/<city>/landmarks.json        the city pack: id, name, displayName, lat/lon (x, z), kind ...
 *   public/assets/landmarks/<id>.json        the sidecar `npm run assets` writes next to the model: where its origin is
 *                                            (anchor), the footprint it clears (`cutout`), the buildings it replaces,
 *                                            its collision `hull` and levels of detail
 *
 * A landmark with a sidecar is a *hero*. In the bake it
 *   1. suppresses the generic buildings it replaces (by id, or by the share of their footprint inside its cut-out),
 *      so they are not in buildings.glb nor in collision.bin;
 *   2. contributes its hull, a few prisms, as buildings of the collision mesh (and the occlusion, the walk network and the
 *      spawn checks, which read the footprints), clipped to the tile so nothing is solid past the heightmap;
 *   3. is written to the tile's `landmarks.json` for the client, with every other landmark of the pack that is in the tile
 *      (their names are what the street-name label shows).
 * A city or a tile with no sidecars (or no pack) bakes exactly as before. Pure functions, no I/O except `loadHeroes`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import type { Projector, Rect, V2 } from '../geo.js';
import { pointInRing, ringBounds, signedArea } from '../geo.js';
import type { Building } from './buildings.js';

/** The sidecar `tools/blender/build.mjs` writes (see tools/blender/landmarks/common.py `report`). */
export interface HeroSidecar {
  id: string;
  anchor: { x: number; z: number; lat: number; lon: number };
  /** radians about +Y; 0 for models drawn in the world's axes */
  yaw: number;
  height: number;
  radius: number;
  model: string;
  hash: string;
  lods: { tris: number; from: number }[];
  /** collision prisms, in the model's frame (metres from the anchor) */
  hull: { ring: V2[]; height: number }[];
  /** footprint the model stands on (model frame): generic buildings over it are replaced */
  cutout: V2[];
  /** which ground height under the footprint is the model's y = 0: the lowest (the default: a building stands on its low side), or the highest (a flat model such as a plaza, built on a terrace) */
  datum?: 'min' | 'max';
  /**
   * The model's y = 0 as an elevation above sea level (the airport's walk-in buildings): the datum then is this, the same in every
   * tile the model touches, and the bake levels the ground under its `flatten` rings to it (world/aerowayBake.ts).
   */
  elevation?: number;
  /** model-frame rings that no tree or lamp may stand in (a plaza with no walls: the fountain); the cut-out's own ring is always clear */
  clear?: V2[][];
  replaces: {
    /** Overture building ids (the bare uuid) */
    overture?: string[];
    /** OSM ids (`osm:way/123`) */
    osm?: string[];
    /** full building ids as the bake names them (`overture:<uuid>/1`) */
    also?: string[];
    /** a building goes when this share of its footprint is inside the cut-out (0 to 1) */
    overlap?: number;
  };
}

/** One entry of the city pack's landmarks.json (only what the bake reads). */
export interface PackLandmark {
  id: string;
  name: string;
  displayName?: string;
  kind?: string;
  lat?: number;
  lon?: number;
  x?: number | null;
  z?: number | null;
  /** metres: how near counts as "at" the landmark (default by kind) */
  radius?: number;
  priority?: string;
}

/** A landmark as the tile file has it. */
export interface TileLandmark {
  id: string;
  name: string;
  displayName: string;
  kind?: string;
  x: number;
  z: number;
  /** metres: the street-name label shows the landmark within this distance of (x, z), or inside `ring` grown by a few metres */
  radius: number;
  /** the footprint, for heroes (world coordinates) */
  ring?: V2[];
  hero?: {
    model: string;
    hash: string;
    /** ground height under the model, m (the model's y = 0) */
    y: number;
    yaw: number;
    lods: { tris: number; from: number }[];
    /** ids of the generic buildings it replaced */
    replaced: string[];
    /** collision triangles of the hull inside the tile */
    hullTris?: number;
  };
  /** a walk-in hero's indoor areas (world x, z rings; `ceiling` above the model's y): the client dims the sky light there */
  zones?: { ring: V2[]; ceiling: number }[];
}

export interface HeroPlacement {
  side: HeroSidecar;
  x: number;
  z: number;
  /** the cut-out in world coordinates */
  cutout: V2[];
  /** rings the trees and lamps keep out of (the cut-out and the sidecar's `clear` rings) */
  clearRings: V2[][];
  /** hull prisms in world coordinates, already clipped to the tile */
  hull: { ring: V2[]; height: number }[];
}

const DEFAULT_RADIUS: Record<string, number> = { park: 110, plaza: 60, district: 140, neighborhood: 200, station: 40, stadium: 120, building: 45, tower: 40 };

export function loadPack(cityDir: string): PackLandmark[] {
  const f = path.join(cityDir, 'landmarks.json');
  if (!existsSync(f)) return [];
  const j = JSON.parse(readFileSync(f, 'utf8')) as { landmarks?: PackLandmark[] } | PackLandmark[];
  return Array.isArray(j) ? j : (j.landmarks ?? []);
}

/** Every `<id>.json` sidecar in the folder the models are built into (none: no heroes). */
export function loadHeroSidecars(dir: string): HeroSidecar[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as HeroSidecar)
    .filter((s) => s && s.id && s.anchor && Array.isArray(s.hull));
}

const toWorld = (p: V2, ox: number, oz: number, yaw: number): V2 => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // yaw about +Y: x' = x cos + z sin, z' = -x sin + z cos
  return [ox + p[0] * c + p[1] * s, oz - p[0] * s + p[1] * c];
};

const closed = (r: V2[]): [number, number][] => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];
const opened = (r: [number, number][]): V2[] => r.slice(0, -1).map((p) => [p[0], p[1]] as V2);

/** Places the heroes: world positions of the model, its cut-out and its hull (clipped to `bounds`). */
export function placeHeroes(sidecars: HeroSidecar[], proj: Projector, bounds: Rect): HeroPlacement[] {
  const out: HeroPlacement[] = [];
  for (const side of sidecars) {
    const [x, z] = proj.toGame(side.anchor.lon, side.anchor.lat);
    const at = (p: V2) => toWorld(p, x, z, side.yaw);
    // a model wholly past the tile's edge is the next tile's: it would hang in the void here
    const cut = ringBounds(side.cutout.map(at));
    if (cut.maxX < bounds.minX || cut.minX > bounds.maxX || cut.maxZ < bounds.minZ || cut.minZ > bounds.maxZ) continue;
    const hull: HeroPlacement['hull'] = [];
    for (const h of side.hull) {
      const ring = h.ring.map(at);
      // not solid past the heightmap: cut the prism to the tile
      let parts: V2[][] = [ring];
      const outside = ring.some((p) => p[0] < bounds.minX || p[0] > bounds.maxX || p[1] < bounds.minZ || p[1] > bounds.maxZ);
      if (outside) {
        try {
          const rect: [number, number][] = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ], [bounds.minX, bounds.minZ]];
          const res = polygonClipping.intersection([closed(ring)], [rect]);
          parts = res.map((poly) => opened(poly[0]));
        } catch {
          parts = [];
        }
      }
      // (a walk-in hero's hull is thin walls, counters and posts: keep its small prisms, which are what the player bumps into)
      const minArea = (side as { interior?: unknown }).interior ? 0.2 : 6;
      for (const p of parts) if (Math.abs(signedArea(p)) >= minArea) hull.push({ ring: p, height: h.height });
    }
    out.push({ side, x, z, cutout: side.cutout.map(at), clearRings: [side.cutout.map(at), ...(side.clear ?? []).map((r) => r.map(at))].filter((r) => r.length >= 3), hull });
  }
  return out;
}

/** Share of the building's footprint (outer ring) that lies inside `cut`. */
function overlapShare(ring: V2[], cut: V2[]): number {
  const bb = ringBounds(ring);
  const cb = ringBounds(cut);
  if (bb.maxX < cb.minX || bb.minX > cb.maxX || bb.maxZ < cb.minZ || bb.minZ > cb.maxZ) return 0;
  const a = Math.abs(signedArea(ring));
  if (a < 1e-6) return 0;
  try {
    const inter = polygonClipping.intersection([closed(ring)], [closed(cut)]);
    let s = 0;
    for (const poly of inter) {
      let t = 0;
      poly.forEach((r, i) => {
        let q = 0;
        for (let k = 0; k + 1 < r.length; k++) q += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
        t += (i === 0 ? 1 : -1) * Math.abs(q / 2);
      });
      s += t;
    }
    return s / a;
  } catch {
    return 0;
  }
}

/** Does this building belong to the hero's replaced set? */
export function isReplaced(b: Building, h: HeroPlacement): boolean {
  const r = h.side.replaces;
  const bare = b.srcId ?? b.id.replace(/^overture:/, '').replace(/\/\d+$/, '');
  if (r.overture?.includes(bare) || r.osm?.includes(b.id) || r.also?.includes(b.id)) return true;
  // a walk-in hero (the airport's halls) takes every building that reaches into it: nothing generic may stand in its rooms
  const thr = (h.side as { interior?: unknown }).interior ? Math.min(r.overlap ?? 0.4, 0.03) : (r.overlap ?? 0.4);
  return thr > 0 && h.cutout.length >= 3 && overlapShare(b.rings[0], h.cutout) >= thr;
}

/** Removes the generic buildings the heroes replace. Returns what stays and, per hero, the ids that went. */
export function suppressReplaced(buildings: Building[], heroes: HeroPlacement[]): { buildings: Building[]; replaced: Map<string, string[]> } {
  const replaced = new Map<string, string[]>(heroes.map((h) => [h.side.id, []]));
  if (!heroes.length) return { buildings, replaced };
  const kept: Building[] = [];
  for (const b of buildings) {
    const hit = heroes.find((h) => isReplaced(b, h));
    if (hit) replaced.get(hit.side.id)!.push(b.id);
    else kept.push(b);
  }
  return { buildings: kept, replaced };
}

/** A building of the bake for each hull prism: it is in the collision mesh, the occlusion field and the footprints, but never drawn (`hero`). */
export function hullBuildings(h: HeroPlacement, datum: number): Building[] {
  return h.hull.map((p, k) => ({
    id: `hero:${h.side.id}/${k}`,
    rings: [p.ring],
    height: p.height,
    heightSource: 'default' as const,
    use: 'hero',
    name: null,
    hero: { id: h.side.id, datum },
  }));
}

/** The lowest ground under a hero: the model's y = 0. `ground(x, z)` is the surface height. A sidecar with an `elevation` (and the
 * bake's `baseElevation`) says it outright. */
export function heroDatum(h: HeroPlacement, ground: (x: number, z: number) => number, baseElevation?: number): number {
  if (typeof h.side.elevation === 'number' && typeof baseElevation === 'number') return h.side.elevation - baseElevation;
  const pick = h.side.datum === 'max' ? Math.max : Math.min;
  let y = ground(h.x, h.z);
  for (const p of h.cutout) y = pick(y, ground(p[0], p[1]));
  for (const hull of h.hull) for (const p of hull.ring) y = pick(y, ground(p[0], p[1]));
  return y;
}

/** The tile's landmarks.json: every landmark of the pack that is in the tile or whose model reaches into it, heroes with their model. */
export function tileLandmarks(
  pack: PackLandmark[],
  heroes: { place: HeroPlacement; datum: number; replaced: string[]; hullTris: number }[],
  proj: Projector,
  bounds: Rect,
): { version: 1; landmarks: TileLandmark[] } {
  const out: TileLandmark[] = [];
  const heroById = new Map(heroes.map((h) => [h.place.side.id, h]));
  const seen = new Set<string>();
  for (const p of pack) {
    let x = p.x ?? null;
    let z = p.z ?? null;
    if (p.lat != null && p.lon != null) [x, z] = proj.toGame(p.lon, p.lat);
    const hero = heroById.get(p.id);
    if (hero) {
      x = hero.place.x;
      z = hero.place.z;
    }
    if (x == null || z == null) continue;
    const radius = p.radius ?? (hero ? Math.max(30, Math.min(hero.place.side.radius, 140)) : (DEFAULT_RADIUS[p.kind ?? ''] ?? 45));
    const margin = hero ? hero.place.side.radius : radius;
    if (x < bounds.minX - margin || x > bounds.maxX + margin || z < bounds.minZ - margin || z > bounds.maxZ + margin) continue;
    const e: TileLandmark = { id: p.id, name: p.name, displayName: p.displayName ?? p.name, kind: p.kind, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, radius: Math.round(radius) };
    if (hero) {
      e.ring = hero.place.cutout.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10] as V2);
      e.hero = { model: hero.place.side.model, hash: hero.place.side.hash, y: Math.round(hero.datum * 100) / 100, yaw: hero.place.side.yaw, lods: hero.place.side.lods, replaced: hero.replaced, hullTris: hero.hullTris };
    }
    out.push(e);
    seen.add(p.id);
  }
  // a hero that the pack does not list still stands there, under the name of its sidecar
  for (const h of heroes) {
    if (seen.has(h.place.side.id)) continue;
    out.push({
      id: h.place.side.id, name: h.place.side.id, displayName: h.place.side.id, x: Math.round(h.place.x * 10) / 10, z: Math.round(h.place.z * 10) / 10, radius: 60,
      ring: h.place.cutout,
      hero: { model: h.place.side.model, hash: h.place.side.hash, y: Math.round(h.datum * 100) / 100, yaw: h.place.side.yaw, lods: h.place.side.lods, replaced: h.replaced, hullTris: h.hullTris },
    });
  }
  return { version: 1, landmarks: out };
}

export { pointInRing };
