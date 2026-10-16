/**
 * Refreshes data/cities/<city>/building-heights.json from Wikipedia's "List of tallest buildings in Atlanta": the known
 * height, floors, year and position of every Atlanta skyscraper over 300 ft. Run it when the list changes:
 *
 *   npx tsx src/facts-import.ts
 *
 * The bake reads the JSON (never the network). The `label` of an entry is there for a human reading the file; it is not
 * baked into a tile. Heights are structural-with-spire as the list defines them ("includes spires and architectural
 * details but not antenna masts"), which is what Overture and OSM measure too.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.js';

export interface KnownHeight {
  label: string;
  lat: number;
  lon: number;
  height: number;
  floors: number | null;
  year: number | null;
  use: string | null;
}

/** The rows of the wikitext of the list page (exported for the test). */
export function parseTallestList(wikitext: string): KnownHeight[] {
  const start = wikitext.indexOf('{|class="wikitable sortable');
  if (start < 0) return [];
  const out: KnownHeight[] = [];
  for (const row of wikitext.slice(start).split(/\n\|-/).slice(1)) {
    const cells: string[] = [];
    for (const l of row.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (l.startsWith('|')) cells.push(l.replace(/^\|\s*/, ''));
      else if (cells.length) cells[cells.length - 1] += `\n${l}`;
    }
    if (cells.length < 8) continue;
    const coord = /\{\{coord\|(-?[\d.]+)\|(-?[\d.]+)/i.exec(row);
    const hi = cells.findIndex((c) => /convert\|/.test(c));
    const h = hi >= 0 ? /\{\{convert\|([\d.]+)\|m/.exec(cells[hi]) : null;
    if (!coord || !h) continue;
    const link = [...cells[1].matchAll(/\[\[(?!File:|Image:)([^\]|]+)(?:\|([^\]]+))?\]\]/g)][0];
    const label = link ? (link[2] ?? link[1]) : cells[1].replace(/\[\[|\]\]|\{\{[^}]*\}\}/g, '').trim();
    const floors = parseInt(cells[hi + 1], 10);
    const year = parseInt(cells[hi + 2], 10);
    out.push({
      label,
      lat: +coord[1],
      lon: +coord[2],
      height: +h[1],
      floors: Number.isFinite(floors) ? floors : null,
      year: Number.isFinite(year) ? year : null,
      use: cells[hi + 3]?.trim().toLowerCase() || null,
    });
  }
  return out;
}

async function main() {
  const res = await fetch('https://en.wikipedia.org/w/api.php?action=parse&page=List_of_tallest_buildings_in_Atlanta&prop=wikitext&format=json&formatversion=2', {
    headers: { 'User-Agent': 'hood-sandbox-pipeline/0.1 (building facts; ponyfarts@protonmail.com)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { parse: { wikitext: string } };
  const rows = parseTallestList(j.parse.wikitext);
  const file = path.join(REPO_ROOT, 'data/cities/atlanta/building-heights.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        _about: 'Known heights of Atlanta buildings over 300 ft (Wikipedia, List of tallest buildings in Atlanta; heights include spires, not antenna masts). Matched to footprints by position. `label` is for humans: it is never baked into a tile. Refresh with `npx tsx src/facts-import.ts` in tools/pipeline.',
        _fetched: new Date().toISOString().slice(0, 10),
        heights: rows,
      },
      null,
      1,
    ) + '\n',
  );
  console.log(`${rows.length} rows -> ${file}`);
}

if (process.argv[1] && /facts-import/.test(process.argv[1])) void main();
