import type { Projector, V2 } from '../geo.js';
import { pointInRing, ringBounds, ringCentroid, signedArea } from '../geo.js';
import type { OvertureBuilding, OvertureBuildingPart } from '../sources/overture.js';
import type { OsmBuilding } from './osm.js';

export type HeightSource = 'overture' | 'osm-height' | 'floors' | 'default';

/** A building part (Overture `building_part`) in game coordinates. */
export interface PartIn {
  id: string;
  /** polygons, each outer ring first then holes; open rings */
  polygons: V2[][][];
  height: number | null;
  minHeight: number | null;
  numFloors: number | null;
  roofShape: string | null;
  roofHeight: number | null;
  roofDirection: number | null;
  facadeMaterial: string | null;
  facadeColor: string | null;
}

/** What the sources say about a building beyond its footprint and height (all optional: an old extract has none of it). */
export interface BuildingInfo {
  /** Overture id (no suffix for the polygon of a multipolygon or the pieces of a clip), the key of its parts */
  srcId?: string;
  name?: string | null;
  /** tags of the OSM building that contains the footprint's centre */
  tags?: Record<string, string>;
  numFloors?: number | null;
  minHeight?: number | null;
  roofShape?: string | null;
  roofHeight?: number | null;
  /** degrees clockwise from north */
  roofDirection?: number | null;
  roofColor?: string | null;
  facadeMaterial?: string | null;
  facadeColor?: string | null;
  hasParts?: boolean;
  parts?: PartIn[];
}

export interface Building extends BuildingInfo {
  id: string;
  /** outer ring first, then holes; open rings */
  rings: V2[][];
  height: number;
  heightSource: HeightSource;
  use: string;
}

export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const FLOOR_M = 3.4;

const DEFAULT_HEIGHT: Record<string, number> = {
  house: 6, detached: 6, residential: 8, apartments: 16, dormitory: 18, terrace: 8,
  commercial: 11, retail: 7, office: 22, industrial: 9, warehouse: 8, garage: 4, garages: 4, parking: 12,
  hotel: 30, hospital: 28, school: 9, university: 14, college: 14, civic: 12, public: 12, government: 14,
  church: 12, religious: 12, cathedral: 20, stadium: 30, sports_centre: 14, train_station: 10, transportation: 9,
  service: 5, shed: 3, roof: 4, hut: 3, cabin: 4, static_caravan: 3, yes: 10, building: 10, education: 10, medical: 14,
  entertainment: 12, agricultural: 6, outbuilding: 4, kiosk: 3, construction: 8,
};

export interface HeightInputs {
  id: string;
  height?: number | null;
  numFloors?: number | null;
  use?: string | null;
}

export function resolveHeight(b: HeightInputs): { height: number; source: HeightSource } {
  if (b.height != null && b.height > 0.5) return { height: Math.min(b.height, 400), source: 'overture' };
  if (b.numFloors != null && b.numFloors > 0) return { height: Math.min(b.numFloors * FLOOR_M + 1, 400), source: 'floors' };
  const base = DEFAULT_HEIGHT[b.use ?? 'yes'] ?? 10;
  return { height: Math.round(base * (0.85 + 0.3 * hash01(b.id)) * 10) / 10, source: 'default' };
}

function osmHeight(tags: Record<string, string>): number | null {
  const h = parseFloat((tags.height ?? '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return h;
  return null;
}
function osmLevels(tags: Record<string, string>): number | null {
  const l = parseFloat(tags['building:levels'] ?? '');
  return Number.isFinite(l) && l > 0 ? l : null;
}

function openRing(coords: [number, number][], proj: Projector): V2[] {
  const r = coords.map(([lon, lat]) => proj.toGame(lon, lat));
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r;
}

class Grid {
  private cells = new Map<number, number[]>();
  constructor(private cell: number) {}
  private k(ix: number, iz: number) { return ix * 100003 + iz; }
  add(i: number, r: { minX: number; minZ: number; maxX: number; maxZ: number }) {
    for (let x = Math.floor(r.minX / this.cell); x <= Math.floor(r.maxX / this.cell); x++)
      for (let z = Math.floor(r.minZ / this.cell); z <= Math.floor(r.maxZ / this.cell); z++) {
        const k = this.k(x, z);
        const a = this.cells.get(k);
        if (a) a.push(i); else this.cells.set(k, [i]);
      }
  }
  at(x: number, z: number): number[] {
    return this.cells.get(this.k(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? [];
  }
}

export interface BuildingStats {
  overture: number;
  osmOnly: number;
  total: number;
  heightSources: Record<HeightSource, number>;
}

/**
 * Overture is the primary source (it already merges OSM, Microsoft and Esri).
 * Heights it lacks are filled from the OSM building that contains the footprint centre.
 * If Overture is empty, OSM footprints are used on their own.
 */
export function buildBuildings(
  overture: OvertureBuilding[] | null,
  osm: OsmBuilding[],
  proj: Projector,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  parts: OvertureBuildingPart[] = [],
): { buildings: Building[]; stats: BuildingStats } {
  const partsOf = new Map<string, PartIn[]>();
  for (const p of parts) {
    const polygons = p.polygons.map((poly) => poly.map((r) => openRing(r, proj)).filter((r) => r.length >= 3)).filter((poly) => poly.length > 0);
    if (!polygons.length) continue;
    const list = partsOf.get(p.buildingId) ?? [];
    list.push({ id: p.id, polygons, height: p.height, minHeight: p.minHeight, numFloors: p.numFloors, roofShape: p.roofShape, roofHeight: p.roofHeight, roofDirection: p.roofDirection, facadeMaterial: p.facadeMaterial, facadeColor: p.facadeColor });
    partsOf.set(p.buildingId, list);
  }
  const osmBounds = osm.map((b) => ringBounds(b.rings[0]));
  const grid = new Grid(50);
  osm.forEach((b, i) => grid.add(i, osmBounds[i]));
  const osmAt = (p: V2): OsmBuilding | null => {
    for (const i of grid.at(p[0], p[1])) {
      const r = osmBounds[i];
      if (p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minZ && p[1] <= r.maxZ && pointInRing(p[0], p[1], osm[i].rings[0])) return osm[i];
    }
    return null;
  };

  const out: Building[] = [];
  const stats: BuildingStats = { overture: 0, osmOnly: 0, total: 0, heightSources: { overture: 0, 'osm-height': 0, floors: 0, default: 0 } };
  const inside = (rings: V2[][]) => {
    const c = ringCentroid(rings[0]);
    return c[0] >= bounds.minX && c[0] <= bounds.maxX && c[1] >= bounds.minZ && c[1] <= bounds.maxZ;
  };

  const push = (id: string, rings: V2[][], h: number | null, floors: number | null, use: string | null, fromOsm = false, info: BuildingInfo = {}) => {
    const r = resolveHeight({ id, height: h, numFloors: floors, use });
    const source: HeightSource = r.source === 'overture' && fromOsm ? 'osm-height' : r.source;
    out.push({ id, rings, height: r.height, heightSource: source, use: use ?? 'yes', ...info, numFloors: floors });
    stats.heightSources[source]++;
  };

  if (overture && overture.length) {
    for (const b of overture) {
      if (b.isUnderground) continue;
      b.polygons.forEach((poly, pi) => {
        const rings = poly.map((r) => openRing(r, proj)).filter((r) => r.length >= 3);
        if (!rings.length || !inside(rings)) return;
        let h = b.height;
        let floors = b.numFloors;
        let use = b.cls ?? b.subtype;
        const match = osmAt(ringCentroid(rings[0]));
        let fromOsm = false;
        if (match) {
          if (h == null) {
            const oh = osmHeight(match.tags);
            if (oh != null) { h = oh; fromOsm = true; }
          }
          if (floors == null) floors = osmLevels(match.tags);
          if (!use || use === 'yes') use = match.tags.building && match.tags.building !== 'yes' ? match.tags.building : use;
        }
        const id = `overture:${b.id}${b.polygons.length > 1 ? '/' + pi : ''}`;
        push(id, rings, h, floors, use, fromOsm, {
          srcId: b.id,
          name: b.name ?? match?.tags.name ?? null,
          tags: match?.tags,
          minHeight: b.minHeight ?? null,
          roofShape: b.roofShape ?? (match?.tags['roof:shape'] || null),
          roofHeight: b.roofHeight ?? null,
          roofDirection: b.roofDirection ?? null,
          roofColor: b.roofColor ?? null,
          facadeMaterial: b.facadeMaterial ?? (match?.tags['building:material'] || null),
          facadeColor: b.facadeColor ?? (match?.tags['building:colour'] || null),
          hasParts: !!b.hasParts,
          parts: partsOf.get(b.id),
        });
        stats.overture++;
      });
    }
  } else {
    for (const b of osm) {
      if (!inside(b.rings)) continue;
      push(b.id, b.rings, osmHeight(b.tags), osmLevels(b.tags), b.tags.building === 'yes' ? null : b.tags.building, true, {
        name: b.tags.name ?? null,
        tags: b.tags,
        roofShape: b.tags['roof:shape'] || null,
        facadeMaterial: b.tags['building:material'] || null,
        facadeColor: b.tags['building:colour'] || null,
      });
      stats.osmOnly++;
    }
  }
  stats.total = out.length;
  return { buildings: out, stats };
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

type RGB = [number, number, number];
const WALLS_LOW: RGB[] = [[0.62, 0.45, 0.38], [0.70, 0.62, 0.50], [0.58, 0.56, 0.52], [0.74, 0.70, 0.62], [0.50, 0.42, 0.38], [0.66, 0.66, 0.64]];
const WALLS_MID: RGB[] = [[0.60, 0.58, 0.55], [0.68, 0.64, 0.56], [0.55, 0.50, 0.46], [0.72, 0.72, 0.70], [0.48, 0.52, 0.56]];
const WALLS_TALL: RGB[] = [[0.42, 0.52, 0.62], [0.50, 0.60, 0.68], [0.36, 0.44, 0.52], [0.58, 0.62, 0.66], [0.30, 0.38, 0.46]];
const CIVIC: RGB[] = [[0.80, 0.78, 0.72], [0.74, 0.72, 0.66], [0.84, 0.82, 0.78]];
const GARAGE: RGB[] = [[0.46, 0.46, 0.45], [0.52, 0.52, 0.50]];
const INDUSTRIAL: RGB[] = [[0.58, 0.58, 0.55], [0.50, 0.50, 0.48], [0.66, 0.60, 0.52]];

export const GLASS_MIN_HEIGHT = 55;

export interface BuildingStyle {
  wall: RGB; // linear
  roof: RGB; // linear
  glass: boolean;
}

export function styleBuilding(b: { id: string; height: number; use: string }): BuildingStyle {
  const r = hash01(b.id);
  const r2 = hash01(b.id + 'x');
  let pal: RGB[];
  if (b.height >= GLASS_MIN_HEIGHT) pal = WALLS_TALL;
  else if (/parking|garage/.test(b.use)) pal = GARAGE;
  else if (/civic|public|government|church|religious|cathedral|school|university|college|education/.test(b.use)) pal = CIVIC;
  else if (/industrial|warehouse|service|transportation/.test(b.use)) pal = INDUSTRIAL;
  else if (b.height >= 20) pal = WALLS_MID;
  else pal = WALLS_LOW;
  const base = pal[Math.floor(r * pal.length) % pal.length];
  const v = 0.92 + 0.16 * r2;
  const wall = base.map((c) => srgbToLinear(Math.min(1, c * v))) as RGB;
  const roofG = 0.30 + 0.12 * r2;
  const roof: RGB = [srgbToLinear(roofG), srgbToLinear(roofG), srgbToLinear(roofG * 1.02)];
  return { wall, roof, glass: b.height >= GLASS_MIN_HEIGHT };
}

export { signedArea };
