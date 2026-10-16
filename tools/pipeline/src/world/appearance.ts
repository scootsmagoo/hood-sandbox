/**
 * What the sources say a building looks like, parsed and normalised: colours, materials, styles, years, levels, lengths.
 * Everything here is a pure function of strings (Overture columns, OSM tags, Wikidata labels), so the same code reads all
 * of them and the tests can pin it. See "Building appearance (meshFormat 3)" in docs/contracts/m1-tile-format.md.
 *
 * Names (a building's, a brand's, an architect's) are never read here: they can steer a classification, but they are not
 * an appearance and must not end up in a tile.
 */

export type RGB = [number, number, number];

/** Facade material ids (`_LOOK.x` on walls). */
export const MATERIALS = ['unknown', 'brick', 'glass', 'concrete', 'stone', 'metal', 'stucco', 'wood'] as const;
export type Material = (typeof MATERIALS)[number];
export const MATERIAL_ID = Object.fromEntries(MATERIALS.map((m, i) => [m, i])) as Record<Material, number>;

/** Architectural style ids (`_LOOK.y`). */
export const STYLES = ['unknown', 'classical', 'victorian', 'artdeco', 'modernist', 'brutalist', 'postmodern', 'contemporary', 'vernacular'] as const;
export type Style = (typeof STYLES)[number];
export const STYLE_ID = Object.fromEntries(STYLES.map((s, i) => [s, i])) as Record<Style, number>;

/** Roof material ids (`_LOOK.x` on roofs). */
export const ROOF_MATERIALS = ['membrane', 'metal', 'tile', 'shingle', 'concrete', 'green', 'copper', 'gold', 'white'] as const;
export type RoofMaterial = (typeof ROOF_MATERIALS)[number];
export const ROOF_MATERIAL_ID = Object.fromEntries(ROOF_MATERIALS.map((m, i) => [m, i])) as Record<RoofMaterial, number>;

/** Flags of `_LOOK.w`: where each part of a building's look came from. */
export const LOOK_FLAG = { colour: 1, material: 2, style: 4, floors: 8, height: 16, roofColour: 32, curated: 64, context: 128 } as const;

const NAMED_COLOURS: Record<string, RGB> = {
  white: [0.9, 0.9, 0.88], offwhite: [0.88, 0.86, 0.8], cream: [0.9, 0.86, 0.72], ivory: [0.92, 0.9, 0.8], beige: [0.78, 0.72, 0.6], tan: [0.72, 0.64, 0.5], buff: [0.8, 0.7, 0.5],
  grey: [0.55, 0.55, 0.55], gray: [0.55, 0.55, 0.55], silver: [0.72, 0.73, 0.75], lightgrey: [0.75, 0.75, 0.75], lightgray: [0.75, 0.75, 0.75], darkgrey: [0.3, 0.3, 0.32], darkgray: [0.3, 0.3, 0.32], slategray: [0.44, 0.5, 0.56], slategrey: [0.44, 0.5, 0.56],
  black: [0.2, 0.2, 0.22], brown: [0.45, 0.32, 0.25], darkbrown: [0.3, 0.2, 0.16], sienna: [0.55, 0.32, 0.2], chocolate: [0.5, 0.3, 0.15], maroon: [0.45, 0.15, 0.15],
  red: [0.6, 0.28, 0.24], brick: [0.58, 0.32, 0.26], orange: [0.8, 0.5, 0.25], terracotta: [0.7, 0.4, 0.3], pink: [0.78, 0.6, 0.58], salmon: [0.8, 0.55, 0.5], rose: [0.72, 0.52, 0.5],
  yellow: [0.8, 0.72, 0.45], gold: [0.8, 0.66, 0.3], khaki: [0.76, 0.7, 0.5], sand: [0.76, 0.69, 0.5], wheat: [0.8, 0.74, 0.56],
  green: [0.45, 0.55, 0.45], olive: [0.45, 0.47, 0.3], teal: [0.3, 0.5, 0.52], blue: [0.4, 0.5, 0.65], lightblue: [0.6, 0.7, 0.8], navy: [0.22, 0.28, 0.42], bronze: [0.5, 0.4, 0.3], copper: [0.6, 0.4, 0.3],
};

/** A colour as sRGB 0..1: `#rgb`, `#rrggbb`, `rgb(r, g, b)` or a colour name (also the ones OSM uses); null when it is none of them. */
export function parseColour(s: string | null | undefined): RGB | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  const hex6 = /^#([0-9a-f]{6})$/.exec(t);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (hex3) return [parseInt(hex3[1], 16) / 15, parseInt(hex3[2], 16) / 15, parseInt(hex3[3], 16) / 15];
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(t);
  if (rgb) return [Math.min(255, +rgb[1]) / 255, Math.min(255, +rgb[2]) / 255, Math.min(255, +rgb[3]) / 255];
  // "light grey", "dark-brown" and the like
  const key = t.replace(/[\s_-]+/g, '');
  return NAMED_COLOURS[key] ?? null;
}

const lum = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * A facade colour from the data, made believable: a tagged `#0000ff` or `#ffffff` is a mapper's placeholder far more often than
 * a wall, and a wall is never pure black. Too saturated or too extreme a colour is pulled toward the grey of the same lightness
 * (glass is allowed its blue); a colour that is nothing like a wall at all comes back as null.
 */
export function plausibleWallColour(c: RGB | null, glass = false): RGB | null {
  if (!c) return null;
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  const l = lum(c);
  if (mx < 0.08) return null; // black
  const sat = mx - mn;
  const limit = glass ? 0.5 : 0.42;
  const k = sat > limit ? limit / sat : 1;
  // the same hue and a wall's lightness: the chroma is scaled about the colour's grey, then the grey is moved into 0.16 to 0.88
  const tl = Math.min(0.88, Math.max(0.16, l));
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  return [clamp01(tl + (c[0] - l) * k), clamp01(tl + (c[1] - l) * k), clamp01(tl + (c[2] - l) * k)];
}

/** A roof colour from the data; white is allowed (a cool roof is real), saturated primaries are not. */
export function plausibleRoofColour(c: RGB | null): RGB | null {
  if (!c) return null;
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  if (mx < 0.06) return null;
  const sat = mx - mn;
  if (sat > 0.45) {
    const l = lum(c);
    const k = 0.45 / sat;
    return [l + (c[0] - l) * k, l + (c[1] - l) * k, l + (c[2] - l) * k];
  }
  return c;
}

const MATERIAL_WORDS: [RegExp, Material][] = [
  [/(^|[^a-z])(glass|curtain_?wall|glazed|mirror)/, 'glass'],
  [/(brick|masonry|clay|adobe|terracotta|terra_cotta)/, 'brick'],
  [/(concrete|cement|cinder|precast|reinforced|block)/, 'concrete'],
  [/(stone|granite|limestone|sandstone|marble|travertine|slate|rock|ashlar|tuff|brownstone)/, 'stone'],
  [/(metal|steel|aluminium|aluminum|iron|corten|copper|zinc|tin|panel|sheet)/, 'metal'],
  [/(plaster|stucco|render|eifs|gypsum|cob|clapboard_painted)/, 'stucco'],
  [/(wood|timber|clapboard|siding|shingle|log|plywood|vinyl|bamboo)/, 'wood'],
];

/** An Overture `facade_material` or an OSM `building:material` (possibly a `;` list) as a material, or null. */
export function parseMaterial(s: string | null | undefined): Material | null {
  if (!s) return null;
  const t = s.toLowerCase();
  // the first word of a list wins ("brick;concrete")
  for (const part of t.split(/[;,]/)) {
    for (const [re, m] of MATERIAL_WORDS) if (re.test(part.trim())) return m;
  }
  return null;
}

/** A roof material (Overture `roof_material`, OSM `roof:material`) as a roof material id name, or null. */
export function parseRoofMaterial(s: string | null | undefined): RoofMaterial | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/(copper)/.test(t)) return 'copper';
  if (/(gold)/.test(t)) return 'gold';
  if (/(grass|plants|vegetat|green|sod)/.test(t)) return 'green';
  if (/(metal|steel|zinc|aluminium|aluminum|tin|iron|corrugated)/.test(t)) return 'metal';
  if (/(tile|slate|clay|ceramic|stone)/.test(t)) return 'tile';
  if (/(shingle|asphalt|tar_paper|wood|thatch|roof_tiles)/.test(t)) return 'shingle';
  if (/(concrete|cement)/.test(t)) return 'concrete';
  if (/(membrane|tar|gravel|bitumen|felt|roofing|rubber|pvc|tpo|epdm|glass)/.test(t)) return /white|tpo|pvc/.test(t) ? 'white' : 'membrane';
  return null;
}

const STYLE_WORDS: [RegExp, Style][] = [
  [/(art[\s_-]*deco|streamline|moderne)/, 'artdeco'],
  [/(brutalis)/, 'brutalist'],
  [/(post[\s_-]*modern|neo[\s_-]*(eclectic|historicis))/, 'postmodern'],
  [/(contemporary|high[\s_-]*tech|deconstruct|neofuturis|parametric|blobitecture)/, 'contemporary'],
  [/(victorian|romanesque|italianate|gothic|queen[\s_-]*anne|richardsonian|second[\s_-]*empire|edwardian|folk|craftsman|arts[\s_-]*and[\s_-]*crafts|tudor|mission|eclectic)/, 'victorian'],
  [/(beaux|classical|neoclassic|neo[\s_-]*classic|greek|georgian|colonial|federal|palladian|renaissance|baroque)/, 'classical'],
  [/(international|modernis|mid[\s_-]*century|modern|miesian|bauhaus|functionalis|chicago)/, 'modernist'],
  [/(vernacular|industrial|warehouse|shotgun|bungalow|ranch)/, 'vernacular'],
];

/** An OSM `building:architecture` or `architecture`, a Wikidata `architectural style` label, as a style, or null. */
export function parseStyle(s: string | null | undefined): Style | null {
  if (!s) return null;
  const t = s.toLowerCase();
  for (const [re, st] of STYLE_WORDS) if (re.test(t)) return st;
  return null;
}

/** The style a year in the usual run of things suggests. */
export function styleOfYear(year: number): Style {
  return year < 1900 ? 'victorian' : year < 1930 ? 'classical' : year < 1945 ? 'artdeco' : year < 1975 ? 'modernist' : year < 1990 ? 'modernist' : 'postmodern';
}

/** A length in metres from an OSM value ("82", "82 m", "722 ft", "722'", "12'6\""); null when it is not one. */
export function parseLength(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase().replace(',', '.');
  const ftIn = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/.exec(t);
  if (ftIn) return Math.round((parseFloat(ftIn[1]) + (ftIn[2] ? parseFloat(ftIn[2]) / 12 : 0)) * 0.3048 * 100) / 100;
  const m = /^(\d+(?:\.\d+)?)\s*(m|meter|metre|meters|metres)?$/.exec(t);
  if (m) return parseFloat(m[1]);
  return null;
}

/** A number of levels from an OSM value (an integer or a half; "3;4" takes the larger). */
export function parseLevels(s: string | null | undefined): number | null {
  if (!s) return null;
  let best: number | null = null;
  for (const part of s.split(/[;,]/)) {
    const n = parseFloat(part);
    if (Number.isFinite(n) && n >= 0 && n < 200) best = best === null ? n : Math.max(best, n);
  }
  return best;
}

/** The year in a date tag or label ("1925", "1925-06", "~1930", "C20"), else null. */
export function parseYearText(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(\d{4})/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1780 && y <= 2100 ? y : null;
}

/** What the OSM tags of a building say about its looks. Each field is null (or undefined) when the tag is missing or unreadable. */
export interface TagAppearance {
  colour: RGB | null;
  roofColour: RGB | null;
  material: Material | null;
  roofMaterial: RoofMaterial | null;
  style: Style | null;
  year: number | null;
  levels: number | null;
  minLevel: number | null;
  roofLevels: number | null;
  height: number | null;
  minHeight: number | null;
  roofShape: string | null;
  /** an architect is named (for the audit only; the name itself is not kept) */
  hasArchitect: boolean;
  /** a `wikidata` tag, for the enrichment lookup */
  wikidata: string | null;
}

export function appearanceFromTags(tags: Record<string, string> | undefined): TagAppearance {
  const t = tags ?? {};
  let year: number | null = null;
  for (const k of ['start_date', 'building:year_built', 'construction_date', 'year_built', 'building:start_date']) {
    year = parseYearText(t[k]);
    if (year) break;
  }
  // a free-text description often says it ("Constructed in 1923 and occupied by the university in 1984": the first year after the verb)
  if (year === null && t.description) {
    const m = /\b(?:constructed|built|completed|opened|erected)\b[^.\d]{0,24}?(?:in\s+)?(\d{4})/i.exec(t.description);
    if (m) year = parseYearText(m[1]);
  }
  const wd = t.wikidata && /^Q\d+$/.test(t.wikidata) ? t.wikidata : null;
  return {
    colour: parseColour(t['building:colour'] ?? t['building:color']),
    roofColour: parseColour(t['roof:colour'] ?? t['roof:color']),
    material: parseMaterial(t['building:material'] ?? t['building:facade:material'] ?? t['material']),
    roofMaterial: parseRoofMaterial(t['roof:material']),
    style: parseStyle(t['building:architecture'] ?? t.architecture ?? t['architecture:style'] ?? t['building:style']),
    year,
    levels: parseLevels(t['building:levels']),
    minLevel: parseLevels(t['building:min_level']),
    roofLevels: parseLevels(t['roof:levels']),
    height: parseLength(t.height ?? t['building:height']),
    minHeight: parseLength(t.min_height ?? t['building:min_height']),
    roofShape: t['roof:shape'] || null,
    hasArchitect: !!t.architect,
    wikidata: wd,
  };
}

/** Which feed said it. `facts` is the curated file (building-appearance.json) and the Wikipedia heights (building-heights.json). */
export type LookSource = 'overture' | 'osm' | 'wikidata' | 'facts';

/** What the feeds say a building looks like, merged (the fields are absent where no feed says). */
export interface DataLook {
  colour?: RGB;
  colourSrc?: LookSource;
  roofColour?: RGB;
  roofColourSrc?: LookSource;
  material?: Material;
  materialSrc?: LookSource;
  roofMaterial?: RoofMaterial;
  style?: Style;
  styleSrc?: LookSource;
  year?: number;
  yearSrc?: LookSource;
  /** the number of floors above the ground that a feed states (`building:levels`, `num_floors`, Wikidata, the heights list) */
  floors?: number;
  floorsSrc?: LookSource;
  /** crown height above the last floor, m (no windows) */
  crown?: number;
  /** the height came from a known list (see `facts.ts`) */
  heightKnown?: boolean;
  /** the entry of building-appearance.json applied */
  curated?: boolean;
}

/** Sets `field` of `look` to `value` (and its source) unless a stronger feed already set it; `weaker` feeds never overwrite. */
export function setLook<K extends 'colour' | 'roofColour' | 'material' | 'style' | 'year' | 'floors'>(look: DataLook, field: K, value: NonNullable<DataLook[K]> | null | undefined, src: LookSource, override = false): void {
  if (value == null) return;
  const srcKey = `${field}Src` as keyof DataLook;
  if (look[field] !== undefined && !override) return;
  (look as Record<string, unknown>)[field] = value;
  (look as Record<string, unknown>)[srcKey] = src;
}
