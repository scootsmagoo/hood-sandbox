/**
 * The building fidelity audit: what the feeds actually carry, which buildings got what from which feed, and how the baked
 * heights of the tallest buildings stand against what is known of them. Reads the caches (no network unless one is missing).
 *
 *   npm run audit:buildings            the tallest 50 against the known heights, and the coverage of every appearance field
 *   npm run audit:buildings -- --top 80
 *
 * Names (a building's, a brand's) are printed here for the person reading the audit; they are never written to a tile.
 */
import path from 'node:path';
import { loadTileConfig, REPO_ROOT } from './config.js';
import { fetchOsm, fetchOsmBuildingParts } from './sources/osm.js';
import { fetchOvertureBuildings, fetchOvertureParts } from './sources/overture.js';
import { fetchWikidataFacts } from './sources/wikidata.js';
import { buildBuildings } from './world/buildings.js';
import { loadFacts } from './world/facts.js';
import { parseOsm } from './world/osm.js';
import { appearanceFromTags } from './world/appearance.js';
import { buildContexts } from './world/context.js';
import { planBuilding } from './world/plan.js';

const topN = (() => {
  const i = process.argv.indexOf('--top');
  return i >= 0 ? Math.max(5, parseInt(process.argv[i + 1], 10) || 50) : 50;
})();

const cfg = loadTileConfig();
const osm = await fetchOsm(cfg);
const ov = await fetchOvertureBuildings(cfg);
const parts = await fetchOvertureParts(cfg);
const world = parseOsm(osm, cfg.projector);
const op = await fetchOsmBuildingParts(cfg);
const osmParts = op ? parseOsm(op, cfg.projector).parts ?? [] : [];
const wikidata = await fetchWikidataFacts(cfg, world.buildings.map((b) => b.tags.wikidata).filter((q): q is string => !!q && /^Q\d+$/.test(q)));
const facts = loadFacts(path.join(REPO_ROOT, 'data/cities', cfg.city.id));
const { buildings, stats } = buildBuildings(ov.buildings, world.buildings, cfg.projector, cfg.bounds, parts, { wikidata, facts, osmParts });
const ctxs = buildContexts(buildings);

const pct = (n: number, d: number) => `${n} (${((100 * n) / d).toFixed(1)}%)`;

// ---- what the extracts carry
const ovN = ov.buildings.length;
const has = (k: keyof (typeof ov.buildings)[number]) => ov.buildings.filter((b) => b[k] != null && b[k] !== false).length;
console.log(`\n== Overture ${ov.release}: ${ovN} buildings, ${parts.length} parts`);
console.log(['height', 'numFloors', 'minHeight', 'cls', 'subtype', 'name', 'facadeColor', 'facadeMaterial', 'roofColor', 'roofMaterial', 'roofShape', 'roofHeight', 'roofDirection', 'hasParts'].map((k) => `${k} ${pct(has(k as never), ovN)}`).join(', '));
const tagged = world.buildings.map((b) => appearanceFromTags(b.tags));
const tn = world.buildings.length;
console.log(`\n== OSM: ${tn} building ways and relations, ${osmParts.length} pure building:part ways`);
console.log(
  [
    ['building:levels', tagged.filter((a) => a.levels != null).length],
    ['height', tagged.filter((a) => a.height != null).length],
    ['building:min_level / min_height', tagged.filter((a) => a.minLevel != null || a.minHeight != null).length],
    ['roof:levels', tagged.filter((a) => a.roofLevels != null).length],
    ['roof:shape', tagged.filter((a) => a.roofShape).length],
    ['building:colour', tagged.filter((a) => a.colour).length],
    ['roof:colour', tagged.filter((a) => a.roofColour).length],
    ['building:material', tagged.filter((a) => a.material).length],
    ['roof:material', tagged.filter((a) => a.roofMaterial).length],
    ['year (start_date, year_built)', tagged.filter((a) => a.year).length],
    ['building:architecture', tagged.filter((a) => a.style).length],
    ['architect', tagged.filter((a) => a.hasArchitect).length],
    ['wikidata', tagged.filter((a) => a.wikidata).length],
  ]
    .map(([k, n]) => `${k} ${pct(n as number, tn)}`)
    .join(', '),
);
console.log(`\n== Wikidata: ${wikidata.size} items of the OSM buildings; year ${[...wikidata.values()].filter((f) => f.year).length}, style ${[...wikidata.values()].filter((f) => f.styles.length).length}, floors ${[...wikidata.values()].filter((f) => f.floors).length}, height ${[...wikidata.values()].filter((f) => f.height).length}, material ${[...wikidata.values()].filter((f) => f.materials.length).length}`);
console.log(`== Known heights (Wikipedia list): ${facts.heights.length} entries; curated looks: ${facts.looks.length}`);

// ---- what the baked buildings got, by feed
console.log(`\n== ${stats.total} buildings in the tile (${stats.heightSources.overture} Overture height, ${stats.heightSources['osm-height']} OSM height, ${stats.heightSources.floors} from floors, ${stats.heightSources.default} default, ${stats.heightSources.known} known; ${stats.heightsCapped} car parks capped)`);
for (const f of ['colour', 'roofColour', 'material', 'style', 'year', 'floors'] as const) console.log(`  ${f.padEnd(10)} from data: ${JSON.stringify(stats.look[f])}`);
console.log(`  none of it from a feed: ${pct(stats.look.bare, stats.total)}; OSM parts added ${stats.osmPartsAdded}; OSM heights refused for a piece inside a bigger outline ${stats.osmHeightRefused}`);

const classes = buildings.map((b) => ({ b, plan: planBuilding(b, ctxs.get(b.id)) }));
const count = (f: (c: (typeof classes)[number]) => string) => {
  const m: Record<string, number> = {};
  for (const c of classes) m[f(c)] = (m[f(c)] ?? 0) + 1;
  return JSON.stringify(m);
};
console.log(`\n== After classification (data first, then inference):`);
console.log(`  kind      ${count((c) => c.plan.cls.kind)}`);
console.log(`  material  ${count((c) => `${c.plan.cls.material}${c.plan.cls.materialFromData ? '*' : ''}`)}   (* from a feed)`);
console.log(`  style     ${count((c) => `${c.plan.cls.style}${c.plan.cls.styleFromData ? '*' : ''}`)}`);
console.log(`  era       ${count((c) => String(c.plan.cls.era) + (c.plan.cls.eraFromData ? '*' : ''))}`);
console.log(`  floors from data: ${pct(classes.filter((c) => c.plan.cls.floorsFromData).length, classes.length)}; decided by neighbours: ${classes.filter((c) => c.plan.cls.fromContext).length}`);

// ---- the tallest, against what is known
const P = cfg.projector;
const known = facts.heights.map((k) => ({ ...k, xz: P.toGame(k.lon, k.lat) }));
const rows = [...classes].sort((a, b) => b.b.height - a.b.height).slice(0, topN);
console.log(`\n== The ${topN} tallest baked buildings (m = baked height; known = the list's height at that spot)`);
console.log('  rank  m     floors  src        kind/material/style/era     parts known          note');
rows.forEach(({ b, plan }, i) => {
  const c = ringCentre(b.rings[0]);
  const k = known.filter((q) => Math.hypot(q.xz[0] - c[0], q.xz[1] - c[1]) < 60 && Math.abs(Math.log(q.height / b.height)) < 0.5).sort((a, c2) => Math.abs(Math.log(a.height / b.height)) - Math.abs(Math.log(c2.height / b.height)))[0];
  const kn = k ? `${k.height.toFixed(0)} m ${k.floors ?? '?'} fl` : '-';
  let note = '';
  if (k && Math.abs(k.height - b.height) / k.height > 0.05) note = b.height > k.height ? `taller than known by ${(b.height - k.height).toFixed(0)} m` : `shorter than known by ${(k.height - b.height).toFixed(0)} m`;
  if (!k && b.height > 100) note = 'no known height (not in the list)';
  const fl = b.look?.floors ?? b.numFloors ?? '';
  const pieces = plan.pieces.length > 1 ? `${plan.pieces.length}pc` : '1pc';
  console.log(`  ${String(i + 1).padStart(3)}   ${b.height.toFixed(0).padStart(3)}   ${String(fl).padStart(4)}    ${b.heightSource.padEnd(9)}  ${`${plan.cls.kind}/${plan.cls.material}/${plan.cls.style}/${plan.cls.era}`.padEnd(26)}  ${pieces.padEnd(5)} ${kn.padEnd(13)}  ${note}  ${b.name ? `[${b.name.slice(0, 28)}]` : ''}`);
});
if (stats.facts) {
  console.log(`\n== Known heights fixed: ${stats.facts.heights.applied}; matched but still below the known height:`);
  for (const m of stats.facts.heights.mismatched) console.log(`   ${m.label}: known ${m.known} m, baked ${m.baked.toFixed(1)} m`);
  const inTile = stats.facts.heights.unmatched.length;
  console.log(`   (${inTile} list entries have no building near them in this tile, most of them outside it)`);
}

function ringCentre(r: [number, number][]): [number, number] {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
