import { describe, expect, it } from 'vitest';
import {
  appearanceFromTags, parseColour, parseLength, parseLevels, parseMaterial, parseRoofMaterial, parseStyle, parseYearText, plausibleRoofColour, plausibleWallColour, setLook, styleOfYear,
  type DataLook,
} from '../src/world/appearance';
import { factsOfEntity } from '../src/sources/wikidata';
import { parseTallestList } from '../src/facts-import';

describe('colours', () => {
  it('reads hex, short hex, rgb() and the names OSM uses', () => {
    expect(parseColour('#ba9287')).toEqual([0xba / 255, 0x92 / 255, 0x87 / 255]);
    expect(parseColour('#fff')).toEqual([1, 1, 1]);
    expect(parseColour('rgb(255, 0, 128)')).toEqual([1, 0, 128 / 255]);
    expect(parseColour('Light Grey')).toEqual(parseColour('lightgrey'));
    expect(parseColour('dark-brown')).not.toBeNull();
    expect(parseColour('chartreuse-ish')).toBeNull();
    expect(parseColour(null)).toBeNull();
  });
  it('turns a placeholder blue or black into something a wall could be, and keeps a believable colour', () => {
    const blue = plausibleWallColour(parseColour('#0000ff'))!;
    expect(Math.max(...blue) - Math.min(...blue)).toBeLessThan(0.45);
    expect(plausibleWallColour(parseColour('#000000'))).toBeNull();
    const granite = parseColour('#ba9287')!;
    const out = plausibleWallColour(granite)!;
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(granite[i], 1);
    // glass may be bluer than a wall
    const tint = plausibleWallColour([0.2, 0.4, 0.7], true)!;
    expect(tint[2] - tint[0]).toBeGreaterThan(0.3);
  });
  it('lets a white roof be white and not a saturated primary', () => {
    expect(plausibleRoofColour(parseColour('#ffffff'))![0]).toBeGreaterThan(0.95);
    const red = plausibleRoofColour([1, 0, 0])!;
    expect(Math.max(...red) - Math.min(...red)).toBeLessThanOrEqual(0.451);
    expect(plausibleRoofColour([0, 0, 0])).toBeNull();
  });
});

describe('materials, styles and roof materials', () => {
  it('maps what Overture and OSM write to the six facade materials (and wood)', () => {
    expect(parseMaterial('brick')).toBe('brick');
    expect(parseMaterial('cement_block')).toBe('concrete');
    expect(parseMaterial('Curtain_Wall')).toBe('glass');
    expect(parseMaterial('granite')).toBe('stone');
    expect(parseMaterial('sandstone')).toBe('stone');
    expect(parseMaterial('steel')).toBe('metal');
    expect(parseMaterial('plaster')).toBe('stucco');
    expect(parseMaterial('timber_framing')).toBe('wood');
    expect(parseMaterial('brick;concrete')).toBe('brick');
    expect(parseMaterial('unobtainium')).toBeNull();
    expect(parseMaterial('')).toBeNull();
  });
  it('maps style words and years', () => {
    expect(parseStyle('Art Deco')).toBe('artdeco');
    expect(parseStyle('art_deco')).toBe('artdeco');
    expect(parseStyle('Brutalist architecture')).toBe('brutalist');
    expect(parseStyle('International Style')).toBe('modernist');
    expect(parseStyle('postmodern architecture')).toBe('postmodern');
    expect(parseStyle('Beaux-Arts architecture')).toBe('classical');
    expect(parseStyle('Neo-Gothic')).toBe('victorian');
    expect(parseStyle('Romanesque Revival architecture')).toBe('victorian');
    expect(parseStyle('Chicago school')).toBe('modernist');
    expect(parseStyle('nothing like it')).toBeNull();
    expect(styleOfYear(1890)).toBe('victorian');
    expect(styleOfYear(1935)).toBe('artdeco');
    expect(styleOfYear(1972)).toBe('modernist');
    expect(styleOfYear(1995)).toBe('postmodern');
  });
  it('maps roof materials', () => {
    expect(parseRoofMaterial('metal')).toBe('metal');
    expect(parseRoofMaterial('roof_tiles')).toBe('tile');
    expect(parseRoofMaterial('asphalt_shingle')).toBe('shingle');
    expect(parseRoofMaterial('tile')).toBe('tile');
    expect(parseRoofMaterial('copper')).toBe('copper');
    expect(parseRoofMaterial('grass')).toBe('green');
    expect(parseRoofMaterial('tpo membrane')).toBe('white');
    expect(parseRoofMaterial('???')).toBeNull();
  });
});

describe('lengths, levels and years', () => {
  it('reads metres and feet', () => {
    expect(parseLength('82')).toBe(82);
    expect(parseLength('82 m')).toBe(82);
    expect(parseLength('82,5')).toBe(82.5);
    expect(parseLength('722 ft')).toBeCloseTo(220.07, 1);
    expect(parseLength("722'")).toBeCloseTo(220.07, 1);
    expect(parseLength("12'6\"")).toBeCloseTo(3.81, 2);
    expect(parseLength('tall')).toBeNull();
  });
  it('reads levels and dates', () => {
    expect(parseLevels('18')).toBe(18);
    expect(parseLevels('4.5')).toBe(4.5);
    expect(parseLevels('3;4')).toBe(4);
    expect(parseLevels('many')).toBeNull();
    expect(parseYearText('1925-06')).toBe(1925);
    expect(parseYearText('~1930')).toBe(1930);
    expect(parseYearText('C20')).toBeNull();
    expect(parseYearText('9999')).toBeNull();
  });
});

describe('OSM tags', () => {
  it('collects every appearance field', () => {
    const a = appearanceFromTags({
      'building:colour': 'brown', 'roof:colour': '#fff', 'building:material': 'brick', 'roof:material': 'metal', 'building:architecture': 'art_deco',
      start_date: '1925', 'building:levels': '8', 'building:min_level': '2', 'roof:levels': '1', height: '722 ft', min_height: '6', 'roof:shape': 'gabled', architect: 'X', wikidata: 'Q5948694',
    });
    expect(a).toMatchObject({ material: 'brick', roofMaterial: 'metal', style: 'artdeco', year: 1925, levels: 8, minLevel: 2, roofLevels: 1, minHeight: 6, roofShape: 'gabled', hasArchitect: true, wikidata: 'Q5948694' });
    expect(a.height).toBeCloseTo(220.07, 1);
    expect(a.colour).not.toBeNull();
    expect(a.roofColour).toEqual([1, 1, 1]);
    const none = appearanceFromTags({ building: 'yes', wikidata: 'not-a-qid' });
    expect(none.colour).toBeNull();
    expect(none.wikidata).toBeNull();
    expect(appearanceFromTags(undefined).levels).toBeNull();
    // the year in a free-text description, for the ones that say when they were built
    expect(appearanceFromTags({ description: 'Constructed in 1923 and occupied by the university in 1984.' }).year).toBe(1923);
    expect(appearanceFromTags({ description: 'The University Center was built in 1963 and is home to Cinefest.' }).year).toBe(1963);
    expect(appearanceFromTags({ description: 'A great place to study.', start_date: '1990' }).year).toBe(1990);
    expect(appearanceFromTags({ description: 'Nine of GSU\'s 24 Greek organizations live in the new development.' }).year).toBeNull();
  });
});

describe('merging looks', () => {
  it('keeps the first (strongest) feed unless told to override', () => {
    const look: DataLook = {};
    setLook(look, 'material', 'brick', 'osm');
    setLook(look, 'material', 'glass', 'overture');
    expect(look).toMatchObject({ material: 'brick', materialSrc: 'osm' });
    setLook(look, 'material', 'stone', 'facts', true);
    expect(look).toMatchObject({ material: 'stone', materialSrc: 'facts' });
    setLook(look, 'year', null, 'osm');
    expect(look.year).toBeUndefined();
  });
});

describe('Wikidata facts', () => {
  it('reads year, style, floors and a height in feet from the claims', () => {
    const claims = {
      P571: [{ mainsnak: { datavalue: { value: { time: '+1992-00-00T00:00:00Z' } } } }],
      P149: [{ mainsnak: { datavalue: { value: { id: 'Q1' } } } }],
      P186: [{ mainsnak: { datavalue: { value: { id: 'Q2' } } } }],
      P1101: [{ mainsnak: { datavalue: { value: { amount: '+60' } } } }],
      P2048: [{ mainsnak: { datavalue: { value: { amount: '+700', unit: 'http://www.wikidata.org/entity/Q3710' } } } }],
      P84: [{ mainsnak: { datavalue: { value: { id: 'Q3' } } } }],
    };
    const f = factsOfEntity('Q9', claims, (q) => ({ Q1: 'postmodern architecture', Q2: 'granite' }[q] ?? null));
    expect(f).toMatchObject({ id: 'Q9', year: 1992, styles: ['postmodern architecture'], materials: ['granite'], floors: 60, hasArchitect: true });
    expect(f.height).toBeCloseTo(213.36, 1);
    expect(factsOfEntity('Q10', {}, () => null)).toMatchObject({ year: null, floors: null, height: null, styles: [] });
  });
});

describe('the Wikipedia list of tallest buildings', () => {
  it('reads a row with a coordinate, a converted height, floors and a year', () => {
    const text = `{|class="wikitable sortable defaultcenter col9left sticky-header"
|-
! Rank
|- style="background:#ddffdd;"
| 1
| [[Truist Plaza]]
| [[File:A.jpg|frameless]]
| Downtown
{{Coord|33.762696|-84.38655|region:US|display=inline}}
| {{convert|264.3|m|ft|0|abbr=values|order=flip}}
| 60
| 1992
|Office
|Notes
|-
| 2
| [[Another Tower]]
| [[File:B.jpg]]
| Midtown
{{coord|33.787|-84.387|type:landmark}}
| {{convert|249.9|m|ft|0}}
| 50
| 1987
|Office
|Notes
|}`;
    const rows = parseTallestList(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: 'Truist Plaza', lat: 33.762696, lon: -84.38655, height: 264.3, floors: 60, year: 1992 });
    expect(rows[1]).toMatchObject({ label: 'Another Tower', height: 249.9, floors: 50, year: 1987 });
  });
});
