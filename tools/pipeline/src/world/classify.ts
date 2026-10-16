/**
 * What a building is and what it looks like, from what the sources say (Overture `class` and `subtype`, the OSM tags,
 * Wikidata, the curated facts, the name) and, where they say nothing, from its height, its plan and the neighbourhood.
 *
 * The kind decides the facade layout (window pattern, ground band) and the roof; the material, style, era and colour decide
 * how it is dressed (brick coursing, curtain wall, precast panels, ashlar; tall narrow windows, ribbon windows, full glass).
 * See "Mesh attributes (meshFormat 2)" and "Building appearance (meshFormat 3)" in docs/contracts/m1-tile-format.md.
 *
 * Names are used here to steer a kind, never to appear anywhere: nothing in this file puts a name in a tile.
 */
import { hash01 } from './buildings.js';
import type { Building } from './buildings.js';
import { signedArea } from '../geo.js';
import { parseMaterial, parseRoofMaterial, parseStyle, plausibleRoofColour, plausibleWallColour, parseColour, styleOfYear, type Material, type RGB, type RoofMaterial, type Style } from './appearance.js';
import type { BuildingContext } from './context.js';

export const BUILDING_KINDS = ['generic', 'office', 'glass', 'brick', 'parking', 'retail', 'civic', 'religious', 'industrial', 'residential', 'house', 'small', 'venue'] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
export const KIND_ID = Object.fromEntries(BUILDING_KINDS.map((k, i) => [k, i])) as Record<BuildingKind, number>;

/** Towers at least this tall are curtain-wall glass unless the data says they are stone, brick or something else. */
export const GLASS_MIN_HEIGHT = 55;

/** A tower dated (by the data) before this year is masonry or precast, not a glass curtain wall. */
const GLASS_MIN_YEAR = 1968;

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
  /** the facade material (never 'unknown') and whether a feed said it */
  material: Material;
  materialFromData: boolean;
  /** what the ground floor band is made of (a stone base under a curtain wall) */
  bandMaterial: Material;
  style: Style;
  styleFromData: boolean;
  /** the wall colour (sRGB) and whether a feed said it */
  colour: RGB;
  colourFromData: boolean;
  roofColour: RGB;
  roofColourFromData: boolean;
  roofMaterial: RoofMaterial;
  /** m of crown above the last floor (no windows) */
  crown: number;
  /** the floor count came from the data and fitted the height */
  floorsFromData: boolean;
  /** the neighbours decided the era or the material (no feed said it for this building) */
  fromContext: boolean;
}

const NAME_PARKING = /\b(deck|garage|parking)\b/i;
const NAME_RELIGIOUS = /\b(church|cathedral|basilica|chapel|temple|synagogue|mosque|ministries|methodist|baptist|presbyterian|a\.?m\.?e\.?|congregational|shrine)\b/i;
const NAME_VENUE = /\b(stadium|arena|aquarium|congress center|coliseum|auditorium|dome)\b/i;
const NAME_CIVIC = /\b(court|courthouse|capitol|city hall|federal|government|library|museum|university|college|school|hospital|police|fire (rescue )?(department|station)|justice|legislative|commission|center for)\b/i;
const NAME_HOUSING = /\b(apartments?|lofts?|condos?|condominiums?|residences?|dorm|housing|towers? (apartments|condos)|villas?)\b/i;
const NAME_HOTEL = /\b(hotel|inn|suites|motel|marriott|hilton|hyatt|westin|ritz|omni|embassy|aloft|hampton|courtyard|wyndham|moxy|sylvan|barclay|glenn)\b/i;
const NAME_OLD = /\b(building|lofts?|hall|exchange|depot|market|factory|mill|freight|warehouse|bottle works|steam plant|pencil factory|swift|bank)\b/i;

/** Names of old commercial buildings ("Hurt Building", "Exchange Bank"), as against towers, plazas and centres. */
const NAME_OLD_BUILDING = /\b(building|hall|exchange|bank)\b/i;
const NAME_NEW_TOWER = /\b(tower|plaza|center|centre|place|park|square|one|two)\b/i;

const MASONRY: Material[] = ['brick', 'stone'];

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

/** A typical upper floor height of a kind in an era, m: older masonry has taller floors, 1960s concrete frames lower ones, towers a little more. */
export function floorHeightOf(kind: BuildingKind, era: number, height: number): number {
  let h = FLOOR_H[kind];
  if (era === 1 && (kind === 'brick' || kind === 'office' || kind === 'generic' || kind === 'civic' || kind === 'retail')) h += 0.25;
  if (era === 3 && (kind === 'office' || kind === 'residential')) h -= 0.1;
  if (kind === 'residential' && height > 60) h = 3.0;
  if (kind === 'glass' && height > 150) h = 4.3;
  return h;
}

/** Ground floor band (storefront, lobby, podium floor), m, for a building of this kind and height. */
export function bandFor(kind: BuildingKind, height: number, era = 0): number {
  let b = 0;
  switch (kind) {
    case 'office': case 'glass': b = height >= 100 ? 7.5 : height >= 60 ? 6.5 : height >= 24 ? 5.5 : height >= 12 ? 4.5 : 0; break;
    case 'civic': b = height >= 24 ? 7 : height >= 10 ? 5.5 : 0; break;
    case 'retail': b = Math.min(4.5, height * 0.7); break;
    case 'brick': b = height >= 8 ? (era === 1 && height >= 20 ? 5.0 : 4.2) : 0; break;
    case 'residential': b = height >= 14 ? 4.5 : 0; break;
    case 'generic': b = height >= 16 ? 4.5 : 0; break;
    default: b = 0;
  }
  return Math.round(Math.min(b, height * 0.4) * 10) / 10;
}

/**
 * Floors above the band for a wall of `wallHeight` m (the data's count when it is believable). `floorHeightMax` is the tallest
 * floor the data's count may imply (a known tower with a few tall lobby or mechanical floors may go past the usual 5.6 m).
 */
export function floorsFor(kind: BuildingKind, wallHeight: number, band: number, dataFloors: number | null | undefined, era = 0, floorHeightMax = 5.6): { floors: number; floorHeight: number; fromData: boolean } {
  const usable = wallHeight - band;
  if (dataFloors && dataFloors > 0) {
    // the data counts every floor; the band is one of them when there is one
    const upper = Math.max(1, Math.round(dataFloors - (band > 0 ? 1 : 0)));
    const fh = usable / upper;
    if (fh >= 2.6 && fh <= floorHeightMax) return { floors: Math.min(255, upper), floorHeight: fh, fromData: true };
  }
  const fh0 = floorHeightOf(kind, era, wallHeight);
  const n = Math.max(1, Math.min(255, Math.round(usable / fh0)));
  return { floors: n, floorHeight: usable / n, fromData: false };
}

/** Tall, modern, glassy: curtain wall rather than masonry or concrete. */
function isGlassTower(use: string, height: number, masonry: boolean, name: string, hash: number): boolean {
  if (height < GLASS_MIN_HEIGHT || masonry) return false;
  if (/parking|garage|church|religious|cathedral|industrial|warehouse|civic|public|government|school|university|college|stadium|hospital/.test(use)) return false;
  if (NAME_CIVIC.test(name) || NAME_RELIGIOUS.test(name) || NAME_PARKING.test(name)) return false;
  void hash;
  return true;
}

const pickBy = <T>(r: number, table: [number, T][]): T => {
  let acc = 0;
  for (const [w, v] of table) {
    acc += w;
    if (r < acc) return v;
  }
  return table[table.length - 1][1];
};

/** The material a building of this kind, style and era is most likely clad in, by a weighted draw seeded by its hash. */
export function inferMaterial(kind: BuildingKind, style: Style, era: number, hash: number, height: number): Material {
  if (kind === 'glass') return 'glass';
  if (kind === 'parking') return era <= 2 && hash < 0.1 ? 'brick' : 'concrete';
  if (kind === 'small') return pickBy(hash, [[0.4, 'metal'], [0.25, 'concrete'], [0.2, 'wood'], [0.15, 'brick']]);
  if (kind === 'house') return pickBy(hash, [[0.42, 'wood'], [0.28, 'brick'], [0.2, 'stucco'], [0.1, 'stone']]);
  if (kind === 'industrial') return pickBy(hash, [[0.4, 'concrete'], [0.35, 'brick'], [0.25, 'metal']]);
  if (kind === 'religious') return pickBy(hash, [[0.5, 'brick'], [0.5, 'stone']]);
  if (kind === 'venue') return pickBy(hash, [[0.45, 'concrete'], [0.3, 'metal'], [0.25, 'glass']]);
  switch (style) {
    case 'victorian': return pickBy(hash, [[0.84, 'brick'], [0.1, 'stone'], [0.06, 'stucco']]);
    case 'classical': return kind === 'civic' ? pickBy(hash, [[0.85, 'stone'], [0.15, 'brick']]) : pickBy(hash, [[0.55, 'stone'], [0.45, 'brick']]);
    case 'artdeco': return pickBy(hash, [[0.55, 'stone'], [0.45, 'brick']]);
    case 'brutalist': return 'concrete';
    case 'modernist':
      if (kind === 'civic') return pickBy(hash, [[0.6, 'concrete'], [0.25, 'stone'], [0.15, 'brick']]);
      if (kind === 'residential') return height >= 40 ? pickBy(hash, [[0.65, 'concrete'], [0.35, 'brick']]) : pickBy(hash, [[0.4, 'brick'], [0.4, 'concrete'], [0.2, 'stucco']]);
      return pickBy(hash, [[0.45, 'concrete'], [0.22, 'stone'], [0.2, 'brick'], [0.13, 'metal']]);
    case 'postmodern': return height >= 60 ? pickBy(hash, [[0.55, 'stone'], [0.3, 'concrete'], [0.15, 'brick']]) : pickBy(hash, [[0.4, 'brick'], [0.3, 'stone'], [0.3, 'stucco']]);
    case 'contemporary': return pickBy(hash, [[0.3, 'metal'], [0.28, 'concrete'], [0.22, 'stucco'], [0.2, 'brick']]);
    case 'vernacular': return pickBy(hash, [[0.4, 'brick'], [0.3, 'concrete'], [0.3, 'metal']]);
    default:
      return era <= 1 ? 'brick' : kind === 'residential' ? pickBy(hash, [[0.45, 'brick'], [0.35, 'stucco'], [0.2, 'concrete']]) : pickBy(hash, [[0.4, 'concrete'], [0.3, 'brick'], [0.3, 'stucco']]);
  }
}

/** The style a building of this kind and era most likely has. */
export function inferStyle(kind: BuildingKind, era: number, hash: number): Style {
  if (kind === 'house' || kind === 'small') return 'vernacular';
  if (kind === 'industrial') return era <= 1 ? 'victorian' : 'vernacular';
  if (kind === 'parking') return 'modernist';
  switch (era) {
    case 1: return kind === 'civic' || kind === 'office' ? (hash < 0.55 ? 'classical' : 'victorian') : kind === 'religious' ? 'victorian' : 'victorian';
    case 2: return kind === 'civic' || kind === 'office' || kind === 'retail' ? (hash < 0.5 ? 'artdeco' : 'modernist') : 'modernist';
    case 3: return kind === 'civic' || kind === 'venue' ? (hash < 0.55 ? 'brutalist' : 'modernist') : 'modernist';
    case 4: return kind === 'glass' ? 'contemporary' : hash < 0.45 ? 'postmodern' : 'contemporary';
    default: return 'modernist';
  }
}

/** Wall colours (sRGB) by material: the colour of the stuff as it weathers in a humid city, before the game's grade. */
const MATERIAL_PALETTE: Record<Material, RGB[]> = {
  unknown: [[0.60, 0.58, 0.55]],
  brick: [[0.58, 0.34, 0.27], [0.52, 0.30, 0.24], [0.64, 0.42, 0.32], [0.46, 0.30, 0.26], [0.70, 0.55, 0.40], [0.45, 0.26, 0.22]],
  stone: [[0.78, 0.74, 0.64], [0.56, 0.55, 0.53], [0.68, 0.54, 0.50], [0.72, 0.62, 0.50], [0.40, 0.40, 0.42], [0.84, 0.82, 0.76]],
  concrete: [[0.60, 0.60, 0.58], [0.68, 0.66, 0.62], [0.52, 0.52, 0.50], [0.74, 0.72, 0.68], [0.46, 0.47, 0.48]],
  glass: [[0.42, 0.52, 0.62], [0.50, 0.60, 0.68], [0.36, 0.44, 0.52], [0.58, 0.62, 0.66], [0.30, 0.38, 0.46], [0.46, 0.40, 0.34], [0.34, 0.46, 0.42]],
  metal: [[0.56, 0.58, 0.60], [0.50, 0.46, 0.42], [0.62, 0.60, 0.54], [0.40, 0.44, 0.48]],
  stucco: [[0.80, 0.76, 0.66], [0.74, 0.68, 0.56], [0.82, 0.80, 0.74], [0.70, 0.60, 0.52], [0.60, 0.64, 0.62]],
  wood: [[0.82, 0.80, 0.74], [0.64, 0.58, 0.48], [0.52, 0.42, 0.34], [0.55, 0.62, 0.58]],
};

/** A wall colour for a material, seeded by a hash; a civic building is paler, an industrial one greyer. */
export function paletteColour(material: Material, kind: BuildingKind, hash: number): RGB {
  const pal = MATERIAL_PALETTE[material];
  let c = pal[Math.floor(hash * pal.length) % pal.length];
  if (kind === 'civic' && (material === 'stone' || material === 'concrete')) c = [Math.min(1, c[0] * 1.08), Math.min(1, c[1] * 1.08), Math.min(1, c[2] * 1.08)];
  if (kind === 'industrial') {
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    c = [c[0] * 0.6 + l * 0.4, c[1] * 0.6 + l * 0.4, c[2] * 0.6 + l * 0.4];
  }
  return c;
}

export function classifyBuilding(b: Building, ctx?: BuildingContext): Classification {
  const use = (b.use || 'yes').toLowerCase();
  const name = b.name ?? '';
  const tags = b.tags ?? {};
  const look = b.look ?? {};
  const h = b.height;
  const area = ringsArea(b.rings);
  const hash = hash01(b.id + 'k');
  const hashM = hash01(b.id + 'm');
  const hashS = hash01(b.id + 's');
  const hashC = hash01(b.id + 'c');
  const dataMaterial: Material | null = look.materialSrc ? (look.material ?? null) : parseMaterial(b.facadeMaterial);
  const masonryTag = dataMaterial !== null && MASONRY.includes(dataMaterial);
  const year = look.year ?? parseYear(tags);
  const dataStyle: Style | null = look.styleSrc ? (look.style ?? null) : parseStyle(tags['building:architecture'] ?? tags.architecture);
  const shopLike = !!(tags.shop || /^(restaurant|cafe|fast_food|bar|pub|bank|pharmacy|marketplace|ice_cream)$/.test(tags.amenity ?? ''));
  // a listed or historic building is old whatever else the data says
  const heritage = !!(tags.heritage || tags.historic || tags['ref:nrhp'] || tags['heritage:operator']);
  // a university's buildings downtown are the 1960s to 80s concrete campus
  const campus = /^(university|college)$/.test(use) || tags['building:part'] === 'university' || tags.amenity === 'university' || tags.amenity === 'college';
  // dated before the curtain-wall era, or in a traditional style: not a glass tower
  const oldName = NAME_OLD_BUILDING.test(name) && !NAME_NEW_TOWER.test(name) && h <= 100;
  const oldByData = (year !== null && year < GLASS_MIN_YEAR) || dataStyle === 'classical' || dataStyle === 'victorian' || dataStyle === 'artdeco' || dataStyle === 'brutalist' || (heritage && year === null) || (oldName && year === null && !dataMaterial);

  let kind: BuildingKind | null = null;
  let fromData = true;
  const isUse = (re: RegExp) => re.test(use);

  // 1. things a name or a tag settles
  if (NAME_PARKING.test(name) || isUse(/^(parking|garages?|carport)$/) || tags.amenity === 'parking' || tags.parking === 'multi-storey' || tags.building === 'parking') kind = isUse(/^(garage|garages|carport)$/) && area < 140 ? 'small' : 'parking';
  else if (NAME_RELIGIOUS.test(name) || isUse(/^(church|chapel|religious|cathedral|synagogue|mosque|temple|basilica|shrine)$/) || tags.amenity === 'place_of_worship') kind = 'religious';
  else if (NAME_VENUE.test(name) || isUse(/^(stadium|sports_centre|grandstand|sports_hall|arena)$/) || tags.leisure === 'stadium') kind = 'venue';
  else if (isUse(/^(shed|hut|roof|kiosk|guardhouse|pavilion|gazebo|shelter|outbuilding|static_caravan|cage|cabin|barn|greenhouse|toilets|ruins)$/)) kind = 'small';
  else if (isUse(/^(house|detached|semidetached_house|terrace|bungalow|farm|duplex)$/) || (isUse(/^residential$/) && h <= 12 && area < 700)) kind = 'house';
  else if (/^(chimney|silo|storage_tank|water_tower|tower|mast|communications_tower|stack)$/.test(tags.man_made ?? '')) kind = 'small'; // a smokestack or a tank: no windows, a flat top
  else if (isUse(/^(industrial|warehouse|factory|manufacture|hangar|depot|transportation|service|storage_tank|utility|power)$/) || tags.man_made || tags.power) kind = h >= 25 && isUse(/^(transportation|service)$/) ? null : 'industrial';
  else if (isUse(/^(school|university|college|library|public|government|civic|courthouse|fire_station|police|museum|education|medical|hospital|townhall|kindergarten|train_station|clinic|dentist)$/) || NAME_CIVIC.test(name) || tags.amenity === 'school' || tags.amenity === 'hospital') kind = 'civic';
  else if (isUse(/^(apartments|dormitory|hotel|residential|dorm|lodging)$/) || NAME_HOUSING.test(name) || NAME_HOTEL.test(name)) kind = 'residential';
  else if (isUse(/^(retail|shop|supermarket|kiosk)$/) || shopLike) kind = h <= 16 ? 'retail' : null;

  // 2. a tall office, commercial or hotel building is a curtain-wall tower unless the data says masonry or an older date
  const hotel = isUse(/^hotel$/) || NAME_HOTEL.test(name);
  const dataGlass = dataMaterial === 'glass' && h >= 30 && kind !== 'parking' && kind !== 'religious' && kind !== 'small' && kind !== 'house';
  // a data material that is not glass or metal (concrete, stone, brick, stucco, wood) makes it a solid-walled building, not a curtain wall
  const solidTag = dataMaterial !== null && dataMaterial !== 'glass' && dataMaterial !== 'metal';
  if ((h >= GLASS_MIN_HEIGHT && !solidTag && !oldByData && (kind === null || (kind === 'residential' && hotel)) && isGlassTower(use, h, masonryTag, name, hash)) || (dataGlass && (kind === null || kind === 'residential' || kind === 'civic' || kind === 'venue'))) {
    fromData = kind !== null || isUse(/^(office|commercial|hotel)$/) || !!tags.office || dataGlass;
    kind = 'glass';
    // a tower dated to the concrete years (1968 to 1989) with no material is, two times in five, a frame clad in precast or stone
    if (!dataGlass && year !== null && year >= GLASS_MIN_YEAR && year < 1990 && hash < 0.4 && !hotel) kind = 'office';
  }

  // 3. what is left: by what the plan, the height and the neighbours say
  if (kind === null) {
    fromData = false;
    const row = !!ctx && ctx.attached && ctx.frontage <= 16 && h <= 30;
    // masonry says brick for a block of the old kind; a masonry or stone-clad tower is an office
    if (masonryTag || (year !== null && year < 1930) || (heritage && year === null && h <= 45)) { kind = h >= 100 || (h >= 45 && (year ?? 0) >= 1930) ? 'office' : 'brick'; fromData = true; }
    else if (dataStyle === 'classical' || dataStyle === 'victorian' || dataStyle === 'artdeco') { kind = h >= 20 || dataStyle !== 'victorian' ? 'office' : 'brick'; fromData = true; }
    else if (h <= 4.5 && area < 160) kind = 'small';
    else if (isUse(/^office$/) || tags.office) { kind = 'office'; fromData = true; }
    else if (row && h > 6) kind = h <= 11 && hash < 0.5 ? 'retail' : 'brick';
    else if (h <= 9 && area >= 2500) kind = 'industrial';
    else if (h <= 9 && area < 220) kind = hash < 0.5 ? 'house' : 'retail';
    else if (h <= 14) kind = area >= 1800 ? 'industrial' : hash < 0.75 ? 'retail' : 'brick';
    else if (NAME_OLD.test(name) && h <= 90) { kind = 'brick'; fromData = true; }
    else if (h < 24) kind = hash < 0.6 ? 'brick' : 'generic';
    else if (isUse(/^commercial$/)) kind = hash < 0.35 ? 'brick' : 'office';
    else kind = hash < 0.7 ? 'office' : 'residential';
  }

  // era: the year, else the style, else the neighbours' dated buildings, else a guess from the kind
  let era = 0;
  let eraFromData = false;
  let fromContext = false;
  if (year !== null) { era = eraOfYear(year); eraFromData = true; }
  else if (dataStyle) {
    eraFromData = true;
    era = dataStyle === 'classical' || dataStyle === 'victorian' ? 1 : dataStyle === 'artdeco' ? 2 : dataStyle === 'modernist' || dataStyle === 'brutalist' ? 3 : 4;
  } else {
    const dated = ctx ? ctx.eras[1] + ctx.eras[2] + ctx.eras[3] + ctx.eras[4] : 0;
    let guess = 0;
    switch (kind) {
      case 'brick': guess = hash < 0.7 ? 1 : 2; break;
      case 'glass': guess = h >= 150 ? 3 : hash < 0.5 ? 3 : 4; break;
      case 'office': guess = hash < 0.5 ? 3 : hash < 0.8 ? 4 : 2; break;
      case 'parking': guess = hash < 0.6 ? 3 : 4; break;
      case 'civic': guess = hash < 0.5 ? 1 : hash < 0.75 ? 3 : 4; break;
      case 'religious': guess = hash < 0.7 ? 1 : 2; break;
      case 'residential': guess = hash < 0.4 ? 4 : hash < 0.7 ? 3 : 1; break;
      case 'house': guess = hash < 0.5 ? 2 : 1; break;
      case 'industrial': guess = hash < 0.5 ? 2 : 3; break;
      case 'retail': guess = hash < 0.5 ? 3 : hash < 0.8 ? 2 : 4; break;
      default: guess = 0;
    }
    if (heritage) guess = h <= 45 ? 1 : 2;
    else if (campus && kind === 'civic') guess = hash < 0.8 ? 3 : 4;
    // a block of dated neighbours says what the district was built in: a draw from their eras, for the kinds that follow a district
    if (dated >= 2 && guess !== 0 && !heritage && !campus && kind !== 'house' && kind !== 'religious' && hashM < 0.55) {
      let r = hashS * dated;
      for (let e = 1; e <= 4; e++) {
        r -= ctx!.eras[e];
        if (r < 0) {
          // a tall slab is not older than its neighbours' 1930s
          guess = (kind === 'office' || kind === 'glass') && h >= 60 && e < 3 ? 3 : e;
          fromContext = true;
          break;
        }
      }
    }
    // an attached narrow low-rise is a pre-war commercial row
    if (ctx && ctx.attached && ctx.frontage <= 16 && h <= 30 && (kind === 'brick' || kind === 'retail' || kind === 'generic') && hashM < 0.7) { guess = 1; fromContext = true; }
    era = guess;
  }

  // style
  let style: Style;
  let styleFromData = false;
  if (dataStyle) { style = dataStyle; styleFromData = true; }
  else if (year !== null && kind !== 'house' && kind !== 'small' && kind !== 'industrial') {
    style = kind === 'civic' && year >= 1955 && year < 1985 ? (hashS < 0.55 ? 'brutalist' : 'modernist') : styleOfYear(year);
    if (kind === 'glass' && year >= 1990) style = 'contemporary';
    styleFromData = true;
  } else if (campus && kind === 'civic' && era >= 3) { style = hashS < 0.5 ? 'brutalist' : 'modernist'; styleFromData = false; }
  else style = inferStyle(kind, era, hashS);

  // material: a feed's word, else the neighbours', else a weighted draw by kind, style and era
  let material: Material;
  let materialFromData = false;
  if (dataMaterial && !(kind === 'glass' && dataMaterial !== 'glass')) { material = dataMaterial; materialFromData = true; }
  else if (kind === 'glass') material = 'glass';
  else {
    material = campus && kind === 'civic' && era >= 3 ? pickBy(hashM, [[0.62, 'concrete'], [0.2, 'brick'], [0.18, 'stone']]) : inferMaterial(kind, style, era, hashM, h);
    // a street of mapped masonry makes masonry likelier: an unmapped neighbour of two or more brick buildings is brick two times in three
    const mats = ctx?.materials;
    if (mats && kind !== 'house' && kind !== 'small' && kind !== 'parking' && kind !== 'venue' && hashS < 0.66) {
      const best = (Object.entries(mats) as [Material, number][]).sort((a, c) => c[1] - a[1])[0];
      if (best && best[1] >= 2 && best[0] !== 'glass' && !(best[0] === 'wood') && !(kind === 'industrial' && best[0] === 'stucco')) {
        if (material !== best[0]) fromContext = true;
        material = best[0];
      }
    }
  }
  // a concrete frame or glass tower of the glass age keeps its material off the masonry era
  if (!materialFromData && era >= 3 && material === 'brick' && style === 'brutalist') material = 'concrete';

  // the band under a tower: stone or dark concrete under a curtain wall, the facade itself otherwise
  let bandMaterial: Material = material;
  if (kind === 'glass' || ((kind === 'office' || kind === 'civic') && h >= 60 && era >= 3)) bandMaterial = hashC < 0.55 ? 'stone' : hashC < 0.85 ? 'concrete' : 'metal';
  else if (kind === 'retail') bandMaterial = hashC < 0.5 ? 'metal' : material === 'wood' ? 'brick' : material;

  // colour: a feed's, else the material's palette
  const dataColour = look.colourSrc ? plausibleWallColour(look.colour ?? null, material === 'glass') : plausibleWallColour(parseColour(b.facadeColor), material === 'glass');
  const colour: RGB = dataColour ?? paletteColour(material, kind, hashC);
  // roof
  let roofMaterial: RoofMaterial = look.roofMaterial ?? parseRoofMaterial(tags['roof:material']) ?? 'membrane';
  const dataRoofColour = look.roofColourSrc ? plausibleRoofColour(look.roofColour ?? null) : plausibleRoofColour(parseColour(b.roofColor));
  const roofKnown = !!(look.roofMaterial || tags['roof:material']);
  if (!roofKnown) {
    if (kind === 'house' || kind === 'small') roofMaterial = kind === 'small' && hashC < 0.5 ? 'metal' : 'shingle';
    else if (kind === 'industrial') roofMaterial = hashC < 0.5 ? 'metal' : hashC < 0.75 ? 'white' : 'membrane';
    else if (kind === 'religious' && era <= 2) roofMaterial = hashC < 0.5 ? 'shingle' : 'tile';
    else if ((era >= 3 || kind === 'parking' || kind === 'retail') && area > 900 && hashC < 0.3) roofMaterial = 'white';
    else if (kind === 'parking') roofMaterial = 'concrete';
    else roofMaterial = 'membrane';
  }
  const roofColour: RGB = dataRoofColour ?? roofColourOf(roofMaterial, kind, hashC);

  // crown: the top of a tall postmodern or Art Deco tower has no windows
  let crown = look.crown ?? 0;
  if (!look.crown && h >= 110 && (kind === 'glass' || kind === 'office') && (style === 'postmodern' || style === 'artdeco')) crown = Math.round(Math.min(24, Math.max(6, h * 0.07)));

  const band = bandFor(kind, h, era);
  const dataFloors = b.facadeFloors ?? look.floors ?? b.numFloors;
  const { floors, floorHeight, fromData: floorsFromData } = floorsFor(kind, h - crown, band, dataFloors, era, look.heightKnown ? 7 : 5.6);
  return {
    kind, kindFromData: fromData, era, eraFromData, floors, band, floorHeight,
    material, materialFromData, bandMaterial, style, styleFromData,
    colour, colourFromData: dataColour !== null, roofColour, roofColourFromData: dataRoofColour !== null, roofMaterial,
    crown, floorsFromData, fromContext,
  };
}

/** The colour (sRGB) of a roof of this material. */
export function roofColourOf(material: RoofMaterial, kind: BuildingKind, hash: number): RGB {
  const g = 0.30 + 0.12 * hash;
  switch (material) {
    case 'white': return [0.78, 0.78, 0.75];
    case 'metal': return hash < 0.5 ? [0.55, 0.56, 0.58] : [0.50, 0.34, 0.28];
    case 'tile': return [0.62, 0.36, 0.26];
    case 'shingle': return kind === 'house' || kind === 'small' ? [g * 1.15, g * 0.95, g * 0.85] : [0.28, 0.27, 0.27];
    case 'concrete': return [0.50, 0.50, 0.48];
    case 'green': return [0.35, 0.45, 0.30];
    case 'copper': return [0.35, 0.58, 0.50];
    case 'gold': return [0.85, 0.68, 0.25];
    default: return kind === 'house' || kind === 'religious' ? [g * 1.1, g, g * 0.93] : [g, g, g * 1.02];
  }
}

// ---- colours ----

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export interface Style3 {
  wall: RGB; // linear
  roof: RGB; // linear
  glass: boolean;
}

/** The linear wall and roof colours of a classified building, with a little per-building variation in lightness. */
export function styleOf(cls: Classification, id: string, piece: { kind?: BuildingKind; wall?: RGB }): Style3 {
  const r2 = hash01(id + 'x');
  const v = 0.94 + 0.12 * r2;
  const wallSrgb = piece.wall ?? cls.colour;
  const wall = wallSrgb.map((c) => srgbToLinear(Math.min(1, c * v))) as RGB;
  const roof = cls.roofColour.map((c) => srgbToLinear(Math.min(1, c * (0.94 + 0.12 * hash01(id + 'rv'))))) as RGB;
  return { wall, roof, glass: (piece.kind ?? cls.kind) === 'glass' };
}

/**
 * The older entry point (kept for callers that do not classify): a wall and roof colour from the kind and the feed colour,
 * by the kind's own palette. New code uses `classifyBuilding` and `styleOf`.
 */
export function styleFor(b: Pick<Building, 'id' | 'facadeColor' | 'facadeMaterial'>, kind: BuildingKind): Style3 {
  const r = hash01(b.id);
  const mat = parseMaterial(b.facadeMaterial) ?? (kind === 'glass' ? 'glass' : kind === 'brick' ? 'brick' : kind === 'parking' ? 'concrete' : 'unknown');
  let base = mat === 'unknown' ? MATERIAL_PALETTE.unknown[0] : paletteColour(mat, kind, r);
  const fc = plausibleWallColour(parseColour(b.facadeColor), kind === 'glass');
  if (fc) base = fc;
  const r2 = hash01(b.id + 'x');
  const v = 0.92 + 0.16 * r2;
  const wall = base.map((c) => srgbToLinear(Math.min(1, c * v))) as RGB;
  const roof = roofColourOf('membrane', kind, r2).map(srgbToLinear) as RGB;
  return { wall, roof, glass: kind === 'glass' };
}
