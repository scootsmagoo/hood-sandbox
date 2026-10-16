import type { Projector, V2 } from '../geo.js';
import { pointInRing, ringBounds, ringCentroid, signedArea } from '../geo.js';
import type { OvertureBuilding, OvertureBuildingPart } from '../sources/overture.js';
import type { OsmBuilding, OsmPart } from './osm.js';
import type { WikidataFacts } from '../sources/wikidata.js';
import { appearanceFromTags, parseColour, parseMaterial, parseRoofMaterial, parseStyle, plausibleRoofColour, plausibleWallColour, setLook, type DataLook } from './appearance.js';
import polygonClipping from 'polygon-clipping';
import { applyFacts, towerSquare, type FactsFile, type FactsResult } from './facts.js';

export type HeightSource = 'overture' | 'osm-height' | 'floors' | 'default' | 'known';

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
  /** what the feeds say the building looks like, merged (colour, material, style, year, floors; see appearance.ts) */
  look?: DataLook;
  /** the floors the facade shows when they are not `numFloors` (a part that starts at an upper level shows fewer) */
  facadeFloors?: number | null;
  /** a hero landmark's collision prism (world/landmarks.ts): in the collision mesh and the footprints, never drawn (its model is); `datum` is the model's ground height */
  hero?: { id: string; datum: number };
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
  const h = appearanceFromTags(tags).height;
  return h != null && h > 0 ? h : null;
}
function osmLevels(tags: Record<string, string>): number | null {
  const l = appearanceFromTags(tags).levels;
  return l != null && l > 0 ? l : null;
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

export interface LookStats {
  /** buildings that got the field from each feed (a count per source) */
  colour: Record<string, number>;
  roofColour: Record<string, number>;
  material: Record<string, number>;
  style: Record<string, number>;
  year: Record<string, number>;
  floors: Record<string, number>;
  /** buildings with none of it from a feed (everything inferred) */
  bare: number;
}

export interface BuildingStats {
  overture: number;
  osmOnly: number;
  total: number;
  heightSources: Record<HeightSource, number>;
  look: LookStats;
  /** OSM `building:part` ways added as parts of a building that had none from Overture */
  osmPartsAdded: number;
  /** Overture polygons that sit inside a much bigger OSM building and so did not take its height or levels */
  osmHeightRefused: number;
  /** car parks whose height was far too tall for a car park and was taken from their floors */
  heightsCapped: number;
  /** known towers that stand on a bigger, lower footprint, split from it */
  towersSplit: number;
  facts?: FactsResult;
}

/** What else the merge uses besides the two footprint feeds (all optional: an offline bake without them still works). */
export interface BuildingExtras {
  /** Wikidata facts by item id (from the `wikidata` tag of the OSM building) */
  wikidata?: Map<string, WikidataFacts>;
  /** known heights and curated looks, matched by position */
  facts?: FactsFile;
  /** `building:part` ways that are not buildings */
  osmParts?: OsmPart[];
}

const ringArea = (r: V2[]): number => Math.abs(signedArea(r));
const countBy = (rec: Record<string, number>, k: string | undefined) => {
  if (k) rec[k] = (rec[k] ?? 0) + 1;
};

/** What the OSM tags and Wikidata say of a building's look, for a footprint that sits in (or is) the OSM building `tags`. `trusted`: the footprint is that building (not a piece inside a bigger outline). */
export function lookFromFeeds(
  tags: Record<string, string> | undefined,
  overture: { facadeColor?: string | null; facadeMaterial?: string | null; roofColor?: string | null; roofMaterial?: string | null; numFloors?: number | null } | null,
  wikidata: WikidataFacts | undefined,
  trusted: boolean,
): DataLook {
  const look: DataLook = {};
  const oa = tags ? appearanceFromTags(tags) : null;
  // the strongest feed first: an explicit OSM tag, then Overture, then Wikidata
  const mat = oa?.material ?? parseMaterial(overture?.facadeMaterial);
  const glass = mat === 'glass';
  if (oa) {
    setLook(look, 'colour', plausibleWallColour(oa.colour, glass), 'osm');
    setLook(look, 'roofColour', plausibleRoofColour(oa.roofColour), 'osm');
    setLook(look, 'material', oa.material, 'osm');
    setLook(look, 'style', oa.style, 'osm');
    setLook(look, 'year', oa.year, 'osm');
    if (oa.roofMaterial) look.roofMaterial = oa.roofMaterial;
  }
  if (overture) {
    setLook(look, 'colour', plausibleWallColour(parseColour(overture.facadeColor), glass), 'overture');
    setLook(look, 'roofColour', plausibleRoofColour(parseColour(overture.roofColor)), 'overture');
    setLook(look, 'material', parseMaterial(overture.facadeMaterial), 'overture');
    if (!look.roofMaterial) look.roofMaterial = parseRoofMaterial(overture.roofMaterial) ?? undefined;
    if (overture.numFloors && overture.numFloors > 0) setLook(look, 'floors', overture.numFloors, 'overture');
  }
  if (oa?.levels && oa.levels > 0 && trusted) setLook(look, 'floors', oa.levels, 'osm');
  if (wikidata) {
    setLook(look, 'year', wikidata.year, 'wikidata');
    for (const s of wikidata.styles) {
      const st = parseStyle(s);
      if (st) {
        setLook(look, 'style', st, 'wikidata');
        break;
      }
    }
    for (const m of wikidata.materials) {
      const mm = parseMaterial(m);
      if (mm) {
        setLook(look, 'material', mm, 'wikidata');
        break;
      }
    }
    if (trusted) setLook(look, 'floors', wikidata.floors, 'wikidata');
  }
  return look;
}

/**
 * Overture is the primary source (it already merges OSM, Microsoft and Esri).
 * Heights it lacks are filled from the OSM building that contains the footprint centre (the smallest one that does, and only
 * when the footprint is that building rather than a piece inside a much bigger outline). The looks the feeds state (colours,
 * materials, styles, years, floors) are merged per building into `look`; known heights and curated looks come last.
 * If Overture is empty, OSM footprints are used on their own.
 */
export function buildBuildings(
  overture: OvertureBuilding[] | null,
  osm: OsmBuilding[],
  proj: Projector,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  parts: OvertureBuildingPart[] = [],
  extras: BuildingExtras = {},
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
  // the smallest OSM building that contains the point: a podium inside a tower's outline gets its own way, not the tower's
  const osmAt = (p: V2): OsmBuilding | null => {
    let best: OsmBuilding | null = null;
    let bestArea = Infinity;
    for (const i of grid.at(p[0], p[1])) {
      const r = osmBounds[i];
      if (p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minZ && p[1] <= r.maxZ && pointInRing(p[0], p[1], osm[i].rings[0])) {
        const a = ringArea(osm[i].rings[0]);
        if (a < bestArea) {
          bestArea = a;
          best = osm[i];
        }
      }
    }
    return best;
  };

  const out: Building[] = [];
  const stats: BuildingStats = {
    overture: 0, osmOnly: 0, total: 0, heightSources: { overture: 0, 'osm-height': 0, floors: 0, default: 0, known: 0 },
    look: { colour: {}, roofColour: {}, material: {}, style: {}, year: {}, floors: {}, bare: 0 }, osmPartsAdded: 0, osmHeightRefused: 0, heightsCapped: 0, towersSplit: 0,
  };
  const inside = (rings: V2[][]) => {
    const c = ringCentroid(rings[0]);
    return c[0] >= bounds.minX && c[0] <= bounds.maxX && c[1] >= bounds.minZ && c[1] <= bounds.maxZ;
  };

  // OSM `building:part` ways stand in for parts a building lacks: setbacks, podiums and crowns of towers Overture has as one prism
  if (overture && extras.osmParts?.length) {
    const ob = overture.map((b) => b.polygons.map((poly) => ringBounds(openRing(poly[0], proj))));
    const og = new Grid(60);
    overture.forEach((b, i) => b.polygons.forEach((_, pi) => og.add(i * 64 + pi, ob[i][pi])));
    const added = new Map<string, PartIn[]>();
    for (const p of extras.osmParts) {
      const c = ringCentroid(p.rings[0]);
      let host: { i: number; area: number } | null = null;
      for (const key of og.at(c[0], c[1])) {
        const i = Math.floor(key / 64), pi = key % 64;
        const poly = overture[i].polygons[pi];
        const ring = openRing(poly[0], proj);
        if (!pointInRing(c[0], c[1], ring)) continue;
        const a = ringArea(ring);
        if (!host || a < host.area) host = { i, area: a };
      }
      if (!host) continue;
      const b = overture[host.i];
      if (partsOf.has(b.id)) continue; // Overture's own parts win (they are mostly these same ways)
      const pa = appearanceFromTags(p.tags);
      const levels = pa.levels;
      const height = pa.height ?? (levels ? levels * FLOOR_M + 1 : null);
      if (height == null || height < 3) continue;
      const minH = pa.minHeight ?? (pa.minLevel ? pa.minLevel * FLOOR_M : null);
      const list = added.get(b.id) ?? [];
      list.push({
        id: p.id, polygons: [p.rings], height, minHeight: minH, numFloors: levels, roofShape: pa.roofShape, roofHeight: pa.roofLevels ? pa.roofLevels * 2.6 : null,
        roofDirection: null, facadeMaterial: p.tags['building:material'] ?? null, facadeColor: p.tags['building:colour'] ?? null,
      });
      added.set(b.id, list);
      stats.osmPartsAdded++;
    }
    for (const [id, list] of added) partsOf.set(id, list);
  }

  const push = (id: string, rings: V2[][], h: number | null, floors: number | null, use: string | null, fromOsm = false, info: BuildingInfo = {}) => {
    // a car park is never a tower: a height over 45 m on one is a mis-measured mast or neighbour (a 198 m deck of 8 floors): trust its floors
    if (h != null && h > 45 && (/parking|garage/.test(use ?? '') || info.tags?.parking === 'multi-storey' || /\b(deck|garage|parking)\b/i.test(info.name ?? ''))) {
      h = floors && floors >= 2 ? floors * 3.2 + 1 : 30;
      stats.heightsCapped++;
    }
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
        let trusted = false;
        let minHeight = b.minHeight ?? null;
        let facadeFloors: number | null = null;
        let roofHeight = b.roofHeight ?? null;
        if (match) {
          // the footprint is the OSM building (not a piece inside a much bigger outline): its height and levels are this footprint's
          const ra = ringArea(rings[0]);
          const rb = ringArea(match.rings[0]);
          trusted = Math.min(ra / rb, rb / ra) >= 0.4;
          const ma = appearanceFromTags(match.tags);
          if (trusted) {
            if (h == null && ma.height != null) { h = ma.height; fromOsm = true; }
            if (floors == null && ma.levels != null && ma.levels > 0) floors = ma.levels;
            if (minHeight == null && ma.minLevel) minHeight = ma.minLevel * FLOOR_M;
            if (ma.minLevel && ma.levels && ma.levels > ma.minLevel) facadeFloors = ma.levels - ma.minLevel;
            if (roofHeight == null && ma.roofLevels) roofHeight = ma.roofLevels * 2.6;
          } else if (h == null && (ma.height != null || ma.levels != null)) stats.osmHeightRefused++;
          if (!use || use === 'yes') use = match.tags.building && match.tags.building !== 'yes' ? match.tags.building : use;
        }
        const id = `overture:${b.id}${b.polygons.length > 1 ? '/' + pi : ''}`;
        const look = lookFromFeeds(match?.tags, b, match?.tags.wikidata ? extras.wikidata?.get(match.tags.wikidata) : undefined, trusted);
        push(id, rings, h, floors, use, fromOsm, {
          srcId: b.id,
          name: b.name ?? match?.tags.name ?? null,
          tags: match?.tags,
          minHeight,
          roofShape: b.roofShape ?? (match?.tags['roof:shape'] || null),
          roofHeight,
          roofDirection: b.roofDirection ?? null,
          roofColor: b.roofColor ?? null,
          facadeMaterial: b.facadeMaterial ?? (match?.tags['building:material'] || null),
          facadeColor: b.facadeColor ?? (match?.tags['building:colour'] || null),
          hasParts: !!b.hasParts || (partsOf.get(b.id)?.length ?? 0) > 0,
          parts: partsOf.get(b.id),
          look,
          facadeFloors,
        });
        stats.overture++;
      });
    }
  } else {
    for (const b of osm) {
      if (!inside(b.rings)) continue;
      const a = appearanceFromTags(b.tags);
      push(b.id, b.rings, a.height, a.levels, b.tags.building === 'yes' ? null : b.tags.building, true, {
        name: b.tags.name ?? null,
        tags: b.tags,
        roofShape: b.tags['roof:shape'] || null,
        facadeMaterial: b.tags['building:material'] || null,
        facadeColor: b.tags['building:colour'] || null,
        minHeight: a.minLevel ? a.minLevel * FLOOR_M : a.minHeight,
        look: lookFromFeeds(b.tags, null, b.tags.wikidata ? extras.wikidata?.get(b.tags.wikidata) : undefined, true),
      });
      stats.osmOnly++;
    }
  }

  // known heights and curated looks, last, with the strongest say
  if (extras.facts) {
    stats.facts = applyFacts(out, extras.facts, proj, (t, height) => {
      const bd = t as Building;
      stats.heightSources[bd.heightSource]--;
      bd.height = height;
      bd.heightSource = 'known';
      stats.heightSources.known++;
    });
  }

  // a known tower on a much bigger, lower footprint (a hotel's podium): the footprint is split into the tower and the rest
  for (const tw of stats.facts?.heights.towers ?? []) {
    const bd = tw.target as Building;
    const sq = towerSquare(bd.rings[0], tw.at, tw.fact.floors);
    if (!sq) {
      stats.facts!.heights.mismatched.push({ label: tw.fact.label ?? '', known: tw.fact.height, baked: bd.height, id: bd.id });
      continue;
    }
    const cl = (r: V2[]) => [...r, r[0]].map((p) => [p[0], p[1]] as [number, number]);
    let rest: polygonClipping.MultiPolygon;
    try {
      rest = polygonClipping.difference(bd.rings.map(cl) as polygonClipping.Polygon, [cl(sq)] as polygonClipping.Polygon);
    } catch {
      continue;
    }
    const open = (r: [number, number][]): V2[] => r.slice(0, -1).map((p) => [p[0], p[1]] as V2);
    const idx = out.indexOf(bd);
    if (idx < 0 || !rest.length) continue;
    const tower: Building = { ...bd, id: `${bd.id}/tower`, rings: [sq], height: tw.fact.height, heightSource: 'known', numFloors: tw.fact.floors, parts: undefined, hasParts: false, minHeight: null, facadeFloors: null, roofHeight: null, roofShape: null, look: { ...(bd.look ?? {}), heightKnown: true, floors: tw.fact.floors ?? undefined, floorsSrc: 'facts', year: tw.fact.year ?? bd.look?.year, yearSrc: tw.fact.year ? 'facts' : bd.look?.yearSrc } };
    const pieces = rest.map((poly, n) => ({ ...bd, id: rest.length > 1 ? `${bd.id}/p${n}` : bd.id, rings: poly.map(open) }));
    out.splice(idx, 1, tower, ...pieces);
    stats.heightSources.known++;
    stats.towersSplit++;
  }

  for (const bd of out) {
    const l = bd.look ?? {};
    countBy(stats.look.colour, l.colourSrc);
    countBy(stats.look.roofColour, l.roofColourSrc);
    countBy(stats.look.material, l.materialSrc);
    countBy(stats.look.style, l.styleSrc);
    countBy(stats.look.year, l.yearSrc);
    countBy(stats.look.floors, l.floorsSrc);
    if (!l.colourSrc && !l.materialSrc && !l.styleSrc && !l.yearSrc && !l.floorsSrc) stats.look.bare++;
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
