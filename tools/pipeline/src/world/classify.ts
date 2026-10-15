/**
 * What kind of building a footprint is, from what the sources say (Overture `class` and `subtype`, the OSM building tags,
 * the name) and, where they say nothing, from its height and plan. The kind decides the facade (window pattern, ground band,
 * materials) and the roof; see "Mesh attributes (meshFormat 2)" in docs/contracts/m1-tile-format.md.
 */
import { hash01 } from './buildings.js';
import type { Building } from './buildings.js';
import { signedArea } from '../geo.js';

export const BUILDING_KINDS = ['generic', 'office', 'glass', 'brick', 'parking', 'retail', 'civic', 'religious', 'industrial', 'residential', 'house', 'small', 'venue'] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
export const KIND_ID = Object.fromEntries(BUILDING_KINDS.map((k, i) => [k, i])) as Record<BuildingKind, number>;

/** Towers at least this tall are curtain-wall glass unless the data says they are stone, brick or something else. */
export const GLASS_MIN_HEIGHT = 55;

export interface Classification {
  kind: BuildingKind;
  /** the kind comes from a class, a tag or a name (else it was inferred from the height and plan) */
  kindFromData: boolean;
  /** 0 unknown, 1 before 1930, 2 1930 to 1959, 3 1960 to 1989, 4 1990 and later */
  era: number;
  eraFromData: boolean;
  /** upper floors (above the ground band) */
  floors: number;
  /** metres, the height of the ground floor band (0 for none) */
  band: number;
  /** the height of an upper floor, m */
  floorHeight: number;
}

const NAME_PARKING = /\b(deck|garage|parking)\b/i;
const NAME_RELIGIOUS = /\b(church|cathedral|basilica|chapel|temple|synagogue|mosque|ministries|methodist|baptist|presbyterian|a\.?m\.?e\.?|congregational|shrine)\b/i;
const NAME_VENUE = /\b(stadium|arena|aquarium|congress center|coliseum|auditorium|dome)\b/i;
const NAME_CIVIC = /\b(court|courthouse|capitol|city hall|federal|government|library|museum|university|college|school|hospital|police|fire (rescue )?(department|station)|justice|legislative|commission|center for)\b/i;
const NAME_HOUSING = /\b(apartments?|lofts?|condos?|condominiums?|residences?|dorm|housing|towers? (apartments|condos)|villas?)\b/i;
const NAME_HOTEL = /\b(hotel|inn|suites|motel|marriott|hilton|hyatt|westin|ritz|omni|embassy|aloft|hampton|courtyard|wyndham|moxy|sylvan|barclay|glenn)\b/i;
const NAME_OLD = /\b(building|lofts?|hall|exchange|depot|market|factory|mill|freight|warehouse|bottle works|steam plant|pencil factory|swift|bank)\b/i;

const MASONRY = /^(brick|stone|masonry|granite|sandstone|limestone|marble|terracotta|concrete_block|block)$/i;

/** The year in an OSM date tag ("1925", "1925-06", "~1930"), else null. */
export function parseYear(tags: Record<string, string> | undefined): number | null {
  if (!tags) return null;
  for (const k of ['start_date', 'building:year_built', 'construction_date', 'year_built']) {
    const m = /(\d{4})/.exec(tags[k] ?? '');
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1800 && y <= 2100) return y;
    }
  }
  return null;
}

export function eraOfYear(year: number): number {
  return year < 1930 ? 1 : year < 1960 ? 2 : year < 1990 ? 3 : 4;
}

export function ringsArea(rings: Building['rings']): number {
  let a = Math.abs(signedArea(rings[0]));
  for (let i = 1; i < rings.length; i++) a -= Math.abs(signedArea(rings[i]));
  return Math.max(0, a);
}

const FLOOR_H: Record<BuildingKind, number> = {
  generic: 3.6, office: 4.0, glass: 4.1, brick: 3.8, parking: 3.0, retail: 4.5, civic: 4.2, religious: 5.0, industrial: 5.0, residential: 3.1, house: 2.9, small: 3.0, venue: 5.0,
};

/** Ground floor band (storefront, lobby, podium floor), m, for a building of this kind and height. */
export function bandFor(kind: BuildingKind, height: number): number {
  let b = 0;
  switch (kind) {
    case 'office': case 'glass': b = height >= 24 ? 5.5 : height >= 12 ? 4.5 : 0; break;
    case 'civic': b = height >= 10 ? 5.5 : 0; break;
    case 'retail': b = Math.min(4.5, height * 0.7); break;
    case 'brick': b = height >= 8 ? 4.2 : 0; break;
    case 'residential': b = height >= 14 ? 4.5 : 0; break;
    case 'generic': b = height >= 16 ? 4.5 : 0; break;
    default: b = 0;
  }
  return Math.round(Math.min(b, height * 0.4) * 10) / 10;
}

/** Floors above the band for a wall of `wallHeight` m (the data's count when it is believable). */
export function floorsFor(kind: BuildingKind, wallHeight: number, band: number, dataFloors: number | null | undefined): { floors: number; floorHeight: number } {
  const usable = wallHeight - band;
  if (dataFloors && dataFloors > 0) {
    // the data counts every floor; the band is one of them when there is one
    const upper = Math.max(1, Math.round(dataFloors - (band > 0 ? 1 : 0)));
    const fh = usable / upper;
    if (fh >= 2.6 && fh <= 5.6) return { floors: Math.min(255, upper), floorHeight: fh };
  }
  const fh0 = FLOOR_H[kind];
  const n = Math.max(1, Math.min(255, Math.round(usable / fh0)));
  return { floors: n, floorHeight: usable / n };
}

/** Tall, modern, glassy: curtain wall rather than masonry or concrete. */
function isGlassTower(use: string, height: number, masonry: boolean, name: string, hash: number): boolean {
  if (height < GLASS_MIN_HEIGHT || masonry) return false;
  if (/parking|garage|church|religious|cathedral|industrial|warehouse|civic|public|government|school|university|college|stadium|hospital/.test(use)) return false;
  if (NAME_CIVIC.test(name) || NAME_RELIGIOUS.test(name) || NAME_PARKING.test(name)) return false;
  void hash;
  return true;
}

export function classifyBuilding(b: Building): Classification {
  const use = (b.use || 'yes').toLowerCase();
  const name = b.name ?? '';
  const tags = b.tags ?? {};
  const h = b.height;
  const area = ringsArea(b.rings);
  const hash = hash01(b.id + 'k');
  const facade = (b.facadeMaterial ?? '').toLowerCase();
  const masonryTag = MASONRY.test(facade);
  const year = parseYear(tags);
  const shopLike = !!(tags.shop || /^(restaurant|cafe|fast_food|bar|pub|bank|pharmacy|marketplace|ice_cream)$/.test(tags.amenity ?? ''));

  let kind: BuildingKind | null = null;
  let fromData = true;
  const isUse = (re: RegExp) => re.test(use);

  // 1. things a name or a tag settles
  if (NAME_PARKING.test(name) || isUse(/^(parking|garages?|carport)$/) || tags.amenity === 'parking' || tags.parking === 'multi-storey' || tags.building === 'parking') kind = isUse(/^(garage|garages|carport)$/) && area < 140 ? 'small' : 'parking';
  else if (NAME_RELIGIOUS.test(name) || isUse(/^(church|chapel|religious|cathedral|synagogue|mosque|temple|basilica|shrine)$/) || tags.amenity === 'place_of_worship') kind = 'religious';
  else if (NAME_VENUE.test(name) || isUse(/^(stadium|sports_centre|grandstand|sports_hall|arena)$/) || tags.leisure === 'stadium') kind = 'venue';
  else if (isUse(/^(shed|hut|roof|kiosk|guardhouse|pavilion|gazebo|shelter|outbuilding|static_caravan|cage|cabin|barn|greenhouse|toilets|ruins)$/)) kind = 'small';
  else if (isUse(/^(house|detached|semidetached_house|terrace|bungalow|farm|duplex)$/) || (isUse(/^residential$/) && h <= 12 && area < 700)) kind = 'house';
  else if (isUse(/^(industrial|warehouse|factory|manufacture|hangar|depot|transportation|service|storage_tank|utility|power)$/) || tags.man_made || tags.power) kind = h >= 25 && isUse(/^(transportation|service)$/) ? null : 'industrial';
  else if (isUse(/^(school|university|college|library|public|government|civic|courthouse|fire_station|police|museum|education|medical|hospital|townhall|kindergarten|train_station|clinic|dentist)$/) || NAME_CIVIC.test(name) || tags.amenity === 'school' || tags.amenity === 'hospital') kind = 'civic';
  else if (isUse(/^(apartments|dormitory|hotel|residential|dorm|lodging)$/) || NAME_HOUSING.test(name) || NAME_HOTEL.test(name)) kind = 'residential';
  else if (isUse(/^(retail|shop|supermarket|kiosk)$/) || shopLike) kind = h <= 16 ? 'retail' : null;

  // 2. a tall office, commercial or hotel building is a curtain-wall tower unless the data says masonry
  const hotel = isUse(/^hotel$/) || NAME_HOTEL.test(name);
  if (h >= GLASS_MIN_HEIGHT && !masonryTag && (kind === null || (kind === 'residential' && hotel)) && isGlassTower(use, h, masonryTag, name, hash)) {
    fromData = kind !== null || isUse(/^(office|commercial|hotel)$/) || !!tags.office;
    kind = 'glass';
  }

  // 3. what is left: by what the plan and the height say
  if (kind === null) {
    fromData = false;
    if (masonryTag || (year !== null && year < 1930)) { kind = 'brick'; fromData = true; }
    else if (h <= 4.5 && area < 160) kind = 'small';
    else if (isUse(/^office$/) || tags.office) { kind = 'office'; fromData = true; }
    else if (h <= 9 && area >= 2500) kind = 'industrial';
    else if (h <= 9 && area < 220) kind = hash < 0.5 ? 'house' : 'retail';
    else if (h <= 14) kind = area >= 1800 ? 'industrial' : hash < 0.75 ? 'retail' : 'brick';
    else if (NAME_OLD.test(name) && h <= 90) { kind = 'brick'; fromData = true; }
    else if (h < 24) kind = hash < 0.6 ? 'brick' : 'generic';
    else if (isUse(/^commercial$/)) kind = hash < 0.35 ? 'brick' : 'office';
    else kind = hash < 0.7 ? 'office' : 'residential';
  }

  // era
  let era = 0;
  let eraFromData = false;
  if (year !== null) { era = eraOfYear(year); eraFromData = true; }
  else {
    switch (kind) {
      case 'brick': era = hash < 0.7 ? 1 : 2; break;
      case 'glass': era = h >= 150 ? 3 : hash < 0.5 ? 3 : 4; break;
      case 'office': era = hash < 0.5 ? 3 : hash < 0.8 ? 4 : 2; break;
      case 'parking': era = hash < 0.6 ? 3 : 4; break;
      case 'civic': era = hash < 0.5 ? 1 : hash < 0.75 ? 3 : 4; break;
      case 'religious': era = hash < 0.7 ? 1 : 2; break;
      case 'residential': era = hash < 0.4 ? 4 : hash < 0.7 ? 3 : 1; break;
      case 'house': era = hash < 0.5 ? 2 : 1; break;
      case 'industrial': era = hash < 0.5 ? 2 : 3; break;
      case 'retail': era = hash < 0.5 ? 3 : hash < 0.8 ? 2 : 4; break;
      default: era = 0;
    }
  }

  const band = bandFor(kind, h);
  const { floors, floorHeight } = floorsFor(kind, h, band, b.numFloors);
  return { kind, kindFromData: fromData, era, eraFromData, floors, band, floorHeight };
}

// ---- colours ----

type RGB = [number, number, number];
export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Wall palettes (sRGB), a GTA IV downtown: soot, brick, weathered concrete, cold glass. */
const PALETTE: Record<BuildingKind, RGB[]> = {
  generic: [[0.60, 0.58, 0.55], [0.68, 0.64, 0.56], [0.55, 0.50, 0.46], [0.72, 0.72, 0.70]],
  office: [[0.60, 0.60, 0.58], [0.68, 0.66, 0.62], [0.52, 0.55, 0.58], [0.74, 0.72, 0.68], [0.48, 0.50, 0.52]],
  glass: [[0.42, 0.52, 0.62], [0.50, 0.60, 0.68], [0.36, 0.44, 0.52], [0.58, 0.62, 0.66], [0.30, 0.38, 0.46]],
  brick: [[0.58, 0.34, 0.27], [0.52, 0.30, 0.24], [0.64, 0.42, 0.32], [0.46, 0.30, 0.26], [0.60, 0.50, 0.40]],
  parking: [[0.46, 0.46, 0.45], [0.52, 0.52, 0.50], [0.56, 0.55, 0.52]],
  retail: [[0.70, 0.62, 0.50], [0.62, 0.45, 0.38], [0.74, 0.70, 0.62], [0.58, 0.56, 0.52], [0.66, 0.66, 0.64]],
  civic: [[0.80, 0.78, 0.72], [0.74, 0.72, 0.66], [0.84, 0.82, 0.78]],
  religious: [[0.76, 0.72, 0.64], [0.62, 0.40, 0.32], [0.70, 0.68, 0.64]],
  industrial: [[0.58, 0.58, 0.55], [0.50, 0.50, 0.48], [0.66, 0.60, 0.52], [0.42, 0.44, 0.46]],
  residential: [[0.66, 0.60, 0.52], [0.60, 0.40, 0.33], [0.72, 0.70, 0.64], [0.56, 0.54, 0.52], [0.78, 0.74, 0.66]],
  house: [[0.78, 0.74, 0.64], [0.66, 0.56, 0.46], [0.70, 0.72, 0.68], [0.62, 0.42, 0.34], [0.82, 0.80, 0.76]],
  small: [[0.62, 0.60, 0.56], [0.70, 0.66, 0.58], [0.56, 0.56, 0.54]],
  venue: [[0.66, 0.66, 0.64], [0.58, 0.60, 0.62]],
};

/** "#rrggbb" or a few colour names to sRGB, else null. */
export function parseColour(s: string | null | undefined): RGB | null {
  if (!s) return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(s.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const named: Record<string, RGB> = { white: [0.9, 0.9, 0.88], grey: [0.55, 0.55, 0.55], gray: [0.55, 0.55, 0.55], red: [0.6, 0.28, 0.24], brown: [0.45, 0.32, 0.25], beige: [0.78, 0.72, 0.6], yellow: [0.8, 0.72, 0.45], blue: [0.4, 0.5, 0.65], black: [0.2, 0.2, 0.22], tan: [0.72, 0.64, 0.5], green: [0.45, 0.55, 0.45] };
  return named[s.trim().toLowerCase()] ?? null;
}

export interface Style {
  wall: RGB; // linear
  roof: RGB; // linear
  glass: boolean;
}

export function styleFor(b: Pick<Building, 'id' | 'facadeColor' | 'facadeMaterial'>, kind: BuildingKind): Style {
  const r = hash01(b.id);
  const r2 = hash01(b.id + 'x');
  const pal = PALETTE[kind];
  let base = pal[Math.floor(r * pal.length) % pal.length];
  const fc = parseColour(b.facadeColor);
  if (fc && kind !== 'glass') base = [base[0] * 0.35 + fc[0] * 0.65, base[1] * 0.35 + fc[1] * 0.65, base[2] * 0.35 + fc[2] * 0.65];
  const v = 0.92 + 0.16 * r2;
  const wall = base.map((c) => srgbToLinear(Math.min(1, c * v))) as RGB;
  const roofG = kind === 'house' || kind === 'religious' ? 0.34 + 0.1 * r2 : 0.30 + 0.12 * r2;
  const roof: RGB = kind === 'house' ? [srgbToLinear(roofG * 1.15), srgbToLinear(roofG * 0.95), srgbToLinear(roofG * 0.85)] : [srgbToLinear(roofG), srgbToLinear(roofG), srgbToLinear(roofG * 1.02)];
  return { wall, roof, glass: kind === 'glass' };
}
